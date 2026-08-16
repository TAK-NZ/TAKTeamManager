/**
 * UserProvisioningService
 *
 * Requirement 17.1: `POST /api/users/create-and-add` must wrap every LOCAL
 * database write for the "create a user and add them to a team" operation
 * inside a single transaction, using one already-acquired `pg` client --
 * while the Authentik user-creation call itself happens strictly BEFORE
 * that transaction opens, since an external HTTP call must never be issued
 * from inside an open DB transaction.
 *
 * This service therefore takes an ALREADY-CREATED Authentik user id
 * (`authentikUserId`) and an ALREADY-BEGUN transactional `client` as
 * inputs; it performs no Authentik API calls itself. Callers are
 * responsible for:
 *   1. Creating the Authentik user (or resolving an existing one) BEFORE
 *      acquiring a client / calling `BEGIN`.
 *   2. Acquiring one `client = await pool.connect()`, calling
 *      `await client.query('BEGIN')`, then calling `createAndAddUser`.
 *   3. Committing on success / rolling back on any thrown error, and
 *      releasing the client in a `finally` block.
 *
 * Any Authentik-side write that would otherwise happen mid-sequence (e.g.
 * adding the new user to a team/parent-team channel's Authentik group) is
 * instead queued as a `sync_operations` row via `EventPublisher`, matching
 * the existing `TeamMembershipService` pattern. This keeps every write
 * performed by this function a plain local database write, so none of them
 * require an Authentik API call while `client`'s transaction is open.
 *
 * The recursive parent-team inheritance logic below is carried over
 * unchanged from the pre-refactor `POST /api/users/create-and-add` handler
 * in `server/routes/users.js`.
 */
const EventPublisher = require('./EventPublisher');

class UserProvisioningService {
  /**
   * Upserts the local `users` row for an already-created Authentik user,
   * assigns them to `teamId` (removing any stale inherited membership row
   * for that same team first), walks the team's parent hierarchy to create
   * the corresponding inherited `team_memberships` rows, and assigns the
   * user to the primary channel of every team in that chain (queuing an
   * `add_user_to_group` Sync_Operation for each channel that has an
   * Authentik group).
   *
   * @param {import('pg').PoolClient} client - an already-connected client
   *   with an already-open transaction (`BEGIN` already issued by the
   *   caller).
   * @param {object} params
   * @param {number|string} params.authentikUserId - the `pk` of the
   *   already-created Authentik user.
   * @param {string} params.username
   * @param {string} params.email
   * @param {string} params.firstName
   * @param {string} params.lastName
   * @param {number} params.teamId
   * @param {number|null} [params.createdBy] - local user id of the actor
   *   performing this operation, recorded on queued Sync_Operations.
   * @returns {Promise<{localUserId: number, queuedGroups: number}>}
   */
  static async createAndAddUser(client, { authentikUserId, username, email, firstName, lastName, teamId, createdBy = null }) {
    // Upsert local user record.
    await client.query(
      'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active) VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true',
      [authentikUserId, username, email, firstName, lastName]
    );

    const localUserResult = await client.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [authentikUserId]
    );
    const localUserId = localUserResult.rows[0].id;

    // Remove any existing inherited membership for this user from this team
    // (mirrors the pre-refactor behavior exactly).
    await client.query(
      'DELETE FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id = $2',
      [localUserId, teamId]
    );

    // Add to the target team directly.
    await client.query(
      'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)',
      [teamId, localUserId, 'member']
    );

    let queuedGroups = 0;

    // Walk the target team's parent chain (root-ward) and add one inherited
    // membership row + primary-channel membership per ancestor, exactly as
    // the pre-refactor recursive-CTE logic did.
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
        'INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id) VALUES ($1, $2, $3, $4)',
        [parentTeam.team_id, localUserId, 'inherited', teamId]
      );

      const parentChannelResult = await client.query(
        'SELECT id, authentik_group_id FROM channels WHERE team_id = $1 AND is_primary = true',
        [parentTeam.team_id]
      );

      if (parentChannelResult.rows.length > 0) {
        const parentChannel = parentChannelResult.rows[0];

        await client.query(
          'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [parentChannel.id, localUserId, 'read_write']
        );

        if (parentChannel.authentik_group_id) {
          // Requirement 17.5's client-threading pattern extends here too:
          // this function already runs inside the caller's open
          // transaction, so pass that same `client` through so the
          // sync_operations INSERT commits/rolls back atomically with the
          // rest of this function's local writes.
          await EventPublisher.publishOperation('add_user_to_group', {
            target_user_id: localUserId,
            target_group_id: parentChannel.authentik_group_id
          }, createdBy, client);
          queuedGroups++;
        }
      }
    }

    // Assign the user to the target team's own primary channel.
    const channelResult = await client.query(
      'SELECT id, authentik_group_id FROM channels WHERE team_id = $1 AND is_primary = true',
      [teamId]
    );

    if (channelResult.rows.length > 0) {
      const channel = channelResult.rows[0];

      await client.query(
        'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [channel.id, localUserId, 'read_write']
      );

      if (channel.authentik_group_id) {
        await EventPublisher.publishOperation('add_user_to_group', {
          target_user_id: localUserId,
          target_group_id: channel.authentik_group_id
        }, createdBy, client);
        queuedGroups++;
      }
    }

    return { localUserId, queuedGroups };
  }
}

module.exports = UserProvisioningService;
