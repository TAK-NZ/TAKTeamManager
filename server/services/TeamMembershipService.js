const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const { checkCallsignSuffixUniqueness } = require('./CallsignSuffixUniquenessService');
const { isCloudTakEnabled } = require('../config/cloudtak');

class TeamMembershipService {
  /**
   * Requirement 17.5 / Requirement 18.2 (task 38.2): accepts an optional,
   * already-connected, already-`BEGIN`-ed `externalClient`. WHEN provided
   * (e.g. by `RequestApprovalService.approveRequest`'s `team_change`
   * branch), every write in this method runs on that SAME client/
   * transaction instead of acquiring a new one, so the membership change
   * commits or rolls back atomically with the caller's other writes (e.g.
   * the access request's status update to `'approved'`). WHEN omitted
   * (the default), this method preserves its original behavior of
   * acquiring its own client and managing its own `BEGIN`/`COMMIT`/
   * `ROLLBACK`, for backward compatibility with existing callers
   * (`server/routes/users.js`, `server/workers/syncWorker.js`'s
   * `bulkAddUserToTeam`) that have no open transaction of their own.
   *
   * @param {number} userId
   * @param {number} teamId
   * @param {string} [role]
   * @param {number|null} [createdBy]
   * @param {import('pg').PoolClient|null} [externalClient] - an
   *   already-connected, already-`BEGIN`-ed client to reuse instead of
   *   acquiring a new one. When provided, this method does NOT issue its
   *   own `BEGIN`/`COMMIT`/`ROLLBACK`/`release()` -- the caller owns the
   *   transaction lifecycle.
   */
  static async addUserToTeam(userId, teamId, role = 'member', createdBy = null, externalClient = null) {
    const ownsTransaction = !externalClient;
    const client = externalClient || await pool.connect();

    try {
      if (ownsTransaction) {
        await client.query('BEGIN');
      }

      // Requirement 11.18 (task 25.1): before writing anything, reject a
      // membership change that would create a same-Team `callsign_suffix`
      // collision in the DESTINATION team. This reads the user's OWN
      // current `callsign_suffix` (this method never sets/changes it --
      // Requirement 11.8) on the SAME `client` as every other read/write
      // in this method, so it participates in the same transaction. Any
      // existing row this user already holds in `teamId` (an edge case)
      // is excluded via `excludeUserId` so it never spuriously conflicts
      // with itself. `checkCallsignSuffixUniqueness` already no-ops for a
      // null/empty `callsign_suffix`, so no extra guard is needed here.
      // Placed AFTER `BEGIN` (when this method owns the transaction) so a
      // thrown `CallsignSuffixConflictError` is routed through this
      // method's existing catch block's `ROLLBACK`/`release` cleanup like
      // any other failure in this method, uniformly -- even though, since
      // this check runs before any write, there is nothing yet to roll
      // back for this specific failure.
      const userResult = await client.query('SELECT callsign_suffix FROM users WHERE id = $1', [userId]);
      const ownCallsignSuffix = userResult.rows[0]?.callsign_suffix;
      await checkCallsignSuffixUniqueness(teamId, ownCallsignSuffix, userId);

      // Remove user from current team if any
      await client.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
      
      // Add to new team
      await client.query(
        'INSERT INTO team_memberships (user_id, team_id, role) VALUES ($1, $2, $3)',
        [userId, teamId, role]
      );

      // Create inherited membership rows for all ancestor teams so the user
      // appears in each parent/org's member list (matching
      // UserProvisioningService.createAndAddUser's established behavior).
      const parentTeamsResult = await client.query(`
        WITH RECURSIVE parent_teams AS (
          SELECT parent_team_id FROM teams WHERE id = $1 AND parent_team_id IS NOT NULL
          UNION ALL
          SELECT t.parent_team_id
          FROM teams t
          JOIN parent_teams pt ON t.id = pt.parent_team_id
          WHERE t.parent_team_id IS NOT NULL
        )
        SELECT parent_team_id as team_id FROM parent_teams
      `, [teamId]);

      for (const parentTeam of parentTeamsResult.rows) {
        await client.query(
          'INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, team_id) DO NOTHING',
          [parentTeam.team_id, userId, 'inherited', teamId]
        );
      }

      // Get team hierarchy and their primary channels. Selects every
      // ancestor's primary channel regardless of whether it has an
      // Authentik group id yet (unlike the old query, which filtered on
      // `authentik_group_id IS NOT NULL` and so skipped a channel whose
      // Authentik group creation hadn't completed) -- the local
      // channel_memberships row below should still be created either way;
      // only the Authentik sync enqueue needs a non-null group id.
      const teamChannels = await client.query(`
        WITH RECURSIVE team_hierarchy AS (
          SELECT id, parent_team_id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.parent_team_id 
          FROM teams t 
          JOIN team_hierarchy th ON t.id = th.parent_team_id
        )
        SELECT c.id, c.authentik_group_id 
        FROM team_hierarchy th
        JOIN channels c ON th.id = c.team_id AND c.is_primary = true
      `, [teamId]);
      
      // Requirement (matching UserProvisioningService.createAndAddUser's
      // established pattern): a local channel_memberships row must be
      // created for each of these channels, not just the Authentik-side
      // sync operation queued below -- the team detail page's displayed
      // channel member count (GET /channels/team/:teamId) is computed
      // strictly from channel_memberships, so without this insert a user
      // added via this method would show up in team_memberships but the
      // team's channel would still show 0 members.
      let groupsQueued = 0;
      for (const channel of teamChannels.rows) {
        await client.query(
          'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [channel.id, userId, 'read_write']
        );

        if (channel.authentik_group_id) {
          await EventPublisher.publishOperation('add_user_to_group', {
            target_user_id: userId,
            target_group_id: channel.authentik_group_id
          }, createdBy, client);
          groupsQueued++;
        }
      }
      
      // Also ensure user is assigned to all global channels
      await EventPublisher.publishOperation('assign_user_to_global_channels', {
        target_user_id: userId
      }, createdBy, client);
      
      if (ownsTransaction) {
        await client.query('COMMIT');
      }
      return { success: true, groupsQueued };
      
    } catch (error) {
      if (ownsTransaction) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      if (ownsTransaction) {
        client.release();
      }
    }
  }

  /**
   * Requirement 17.5 / Requirement 18.2 (task 38.2): accepts an optional,
   * already-connected, already-`BEGIN`-ed `externalClient`, mirroring
   * `addUserToTeam`'s pattern. WHEN provided, every write in this method
   * runs on that SAME client/transaction instead of acquiring a new one,
   * so the membership removal commits or rolls back atomically with the
   * caller's other writes. WHEN omitted (the default), this method
   * preserves its original behavior of acquiring its own client and
   * managing its own `BEGIN`/`COMMIT`/`ROLLBACK`, for backward
   * compatibility with existing callers (`server/routes/users.js`) that
   * have no open transaction of their own.
   *
   * @param {number} userId
   * @param {number|null} [createdBy]
   * @param {import('pg').PoolClient|null} [externalClient] - an
   *   already-connected, already-`BEGIN`-ed client to reuse instead of
   *   acquiring a new one. When provided, this method does NOT issue its
   *   own `BEGIN`/`COMMIT`/`ROLLBACK`/`release()` -- the caller owns the
   *   transaction lifecycle.
   */
  static async removeUserFromTeam(userId, createdBy = null, externalClient = null) {
    const ownsTransaction = !externalClient;
    const client = externalClient || await pool.connect();
    
    try {
      if (ownsTransaction) {
        await client.query('BEGIN');
      }
      
      // Get current team channels before removal
      const currentChannels = await client.query(`
        SELECT c.authentik_group_id 
        FROM team_memberships tm
        JOIN channels c ON tm.team_id = c.team_id AND c.is_primary = true
        WHERE tm.user_id = $1 AND c.authentik_group_id IS NOT NULL
      `, [userId]);
      
      // Requirement 5.4 (task 8.3): removing this user's team_memberships
      // rows changes the Direct_Admin_Set of every Team where the user
      // held a DIRECT admin row (`role = 'admin' AND
      // inherited_from_team_id IS NULL`). Capture those Team ids BEFORE
      // the delete so the CloudTAK_Group for each can be re-reconciled
      // afterward. Only run this capture query when CloudTAK is enabled,
      // to avoid an extra query when the feature is off (Requirement 1.4).
      let directAdminTeamIds = [];
      if (isCloudTakEnabled()) {
        const directAdminResult = await client.query(
          `SELECT team_id FROM team_memberships WHERE user_id = $1 AND role = 'admin' AND inherited_from_team_id IS NULL`,
          [userId]
        );
        directAdminTeamIds = directAdminResult.rows.map(row => row.team_id);
      }

      // Remove from team and channel memberships
      await client.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);
      
      // Check if user has any remaining team memberships
      const remainingTeams = await client.query(
        'SELECT COUNT(*) as count FROM team_memberships WHERE user_id = $1',
        [userId]
      );
      
      // Queue removal operations for team channels
      for (const channel of currentChannels.rows) {
        await EventPublisher.publishOperation('remove_user_from_group', {
          target_user_id: userId,
          target_group_id: channel.authentik_group_id
        }, createdBy, client);
      }
      
      // If user has no teams left, remove from all global channels too.
      // BCH channels have a read/write group pair (read_group_id/
      // write_group_id); region channels are a SINGLE Authentik group per
      // channel (only a group_id column -- no read/write pair, confirmed
      // against the baseline schema and live Authentik groups).
      if (remainingTeams.rows[0].count === 0) {
        // Get all global channel group IDs
        const globalChannels = await client.query(`
          SELECT read_group_id, write_group_id FROM bch_channels WHERE is_active = true AND read_group_id IS NOT NULL
          UNION ALL
          SELECT NULL as read_group_id, group_id as write_group_id FROM region_channels WHERE is_active = true AND group_id IS NOT NULL
        `);
        
        // Queue removal from global channels
        for (const channel of globalChannels.rows) {
          if (channel.read_group_id) {
            await EventPublisher.publishOperation('remove_user_from_group', {
              target_user_id: userId,
              target_group_id: channel.read_group_id
            }, createdBy, client);
          }
          if (channel.write_group_id) {
            await EventPublisher.publishOperation('remove_user_from_group', {
              target_user_id: userId,
              target_group_id: channel.write_group_id
            }, createdBy, client);
          }
        }

        // Requirement 26.6 (task 48.4): a user with no teams left is
        // exactly the "user is removed from all teams" trigger named in
        // that criterion, alongside the existing "explicit revoke
        // action" and "team disable/delete" enqueue sites implemented in
        // `TakCertificateRevocationService`/`Team.delete`. `users.username`
        // is the TAK username `TakServerService.findCertificatesForUser`
        // matches against each certificate's `creatorDn` (the same field
        // `DeviceEnrollmentService.generateEnrollmentQrCode` already
        // treats as the TAK username for enrollment). Uses this SAME
        // transactional client, per Requirement 17.5's pattern, so the
        // enqueue commits/rolls back atomically with the membership
        // removal above.
        const userResult = await client.query('SELECT username FROM users WHERE id = $1', [userId]);
        const takUsername = userResult.rows[0]?.username;
        if (takUsername) {
          await EventPublisher.publishOperation('revoke_tak_certificates', {
            target_user_id: userId,
            tak_usernames: [takUsername]
          }, createdBy, client);
        }
      }

      // Requirement 5.4 / 9.1 / 9.2 (task 8.3): re-reconcile the
      // CloudTAK_Group for each Team where this user held a Direct_Admin
      // row, since removing them changed those Teams' Direct_Admin_Sets.
      // Enqueued on this SAME transactional `client` so each enqueue
      // commits or rolls back atomically with the membership delete above
      // (Requirement 9.2). Guarded by `isCloudTakEnabled()` so nothing is
      // enqueued when the feature is off (Requirement 1.4);
      // `directAdminTeamIds` is only ever populated when the flag is on.
      if (isCloudTakEnabled()) {
        for (const teamId of directAdminTeamIds) {
          await EventPublisher.publishOperation('update_cloudtak_group', { team_id: teamId }, createdBy, client);
        }
      }
      
      if (ownsTransaction) {
        await client.query('COMMIT');
      }
      return { success: true, groupsQueued: currentChannels.rows.length };
      
    } catch (error) {
      if (ownsTransaction) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      if (ownsTransaction) {
        client.release();
      }
    }
  }

  static async bulkAddUsersToTeam(userIds, teamId, role = 'member', createdBy = null) {
    const bulkOpId = await EventPublisher.publishBulkOperation(
      `Add ${userIds.length} users to team ${teamId}`,
      userIds.length,
      createdBy
    );

    // Performance-hardening: one multi-row INSERT (chunked internally by
    // EventPublisher.publishOperationsBatch) instead of one INSERT per
    // user in a sequential loop.
    await EventPublisher.publishOperationsBatch(
      'bulk_add_user_to_team',
      userIds.map((userId) => ({
        target_user_id: userId,
        team_id: teamId,
        role: role,
        bulk_operation_id: bulkOpId
      })),
      createdBy
    );

    return { bulkOperationId: bulkOpId, usersQueued: userIds.length };
  }
}

module.exports = TeamMembershipService;