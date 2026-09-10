const pool = require('../config/database');
const logger = require('../config/logger').createLogger('Channel');
const EventPublisher = require('../services/EventPublisher');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { resolveChannelFolderSeparator } = require('../utils/channelFolderSeparator');

/**
 * Requirement 16.6 (task 35.6): thrown by `Channel.createCustomChannel`
 * when the team already has 3 channels at the moment the count is
 * re-validated inside the SERIALIZABLE transaction, immediately before the
 * `channels` INSERT -- including when that outcome is only discovered via
 * a Postgres `serialization_failure` (SQLSTATE 40001) detected at commit
 * time. Callers (e.g. `POST /api/channels/custom`) can check
 * `error instanceof Channel.ChannelLimitError` to respond with a specific
 * "limit reached" error rather than a generic 500.
 */
class ChannelLimitError extends Error {
  constructor(message = 'Maximum of 3 channels allowed per team') {
    super(message);
    this.name = 'ChannelLimitError';
  }
}

class Channel {
  static async create(channelData) {
    const { name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, authentik_write_group_id, is_primary, channel_type, custom_suffix } = channelData;
    const result = await pool.query(
      'INSERT INTO channels (name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, authentik_write_group_id, is_primary, channel_type, custom_suffix) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, authentik_write_group_id, is_primary, channel_type, custom_suffix]
    );
    return result.rows[0];
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM channels WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async getByTeam(teamId) {
    const result = await pool.query('SELECT * FROM channels WHERE team_id = $1 ORDER BY is_primary DESC, name', [teamId]);
    return result.rows;
  }

  // `client` is an optional already-connected/already-transactional `pg`
  // client (mirroring `EventPublisher.publishOperation`'s `client`
  // parameter pattern); when omitted, this falls back to the shared pool
  // for backward compatibility with existing callers that have no open
  // transaction.
  static async addMember(channelId, userId, permission = 'read_write', client = null) {
    const executor = client || pool;
    const result = await executor.query(
      'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT (user_id, channel_id) DO UPDATE SET permission = $3 RETURNING *',
      [channelId, userId, permission]
    );
    return result.rows[0];
  }

  /**
   * Bugfix (silent Authentik sync gap): resolves which of a custom
   * channel's THREE Authentik groups a given `channel_memberships.permission`
   * value corresponds to, matching how `prepareCustomChannelCreation`
   * creates them -- `rwGroup` (the "main"/Read-Write group, stored as
   * `channels.authentik_group_id`) for `'read_write'`, `readGroup`
   * (`authentik_read_group_id`) for `'read'`, `writeGroup`
   * (`authentik_write_group_id`) for `'write'`. Returns `null` for an
   * unrecognized permission value or a channel with no group of that
   * kind, so a caller can skip enqueueing rather than sending a
   * `null`/invalid `target_group_id` (which would fail
   * `operationSchemas.js`'s required-field validation permanently, for
   * no benefit).
   *
   * @param {{authentik_group_id?: string|null, authentik_read_group_id?: string|null, authentik_write_group_id?: string|null}} channel
   * @param {string} permission - `'read'`, `'write'`, or `'read_write'`.
   * @returns {string|null}
   */
  static resolveGroupIdForPermission(channel, permission) {
    switch (permission) {
      case 'read_write':
        return channel.authentik_group_id || null;
      case 'read':
        return channel.authentik_read_group_id || null;
      case 'write':
        return channel.authentik_write_group_id || null;
      default:
        return null;
    }
  }

  static async getMembers(channelId) {
    const result = await pool.query(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name, cm.permission
      FROM users u
      JOIN channel_memberships cm ON u.id = cm.user_id
      WHERE cm.channel_id = $1
      ORDER BY u.first_name, u.last_name
    `, [channelId]);
    return result.rows;
  }

  /**
   * Bugfix (Channels tab has no remove-member action): removes one
   * user's `channel_memberships` row for `channelId` and, when a
   * matching Authentik group id can be resolved for their CURRENT
   * permission, enqueues `remove_user_from_group` on the same
   * transactional client -- the removal counterpart to
   * `insertCustomChannelAndMembers`'s `add_user_to_group` enqueue above.
   * The permission is read from the existing row (not passed in by the
   * caller) so the correct group is targeted even if the caller doesn't
   * separately track it.
   *
   * `client` is optional, mirroring `addMember`'s own pattern, for
   * backward compatibility with any caller that has no open transaction.
   *
   * @param {number|string} channelId
   * @param {number|string} userId
   * @param {import('pg').PoolClient|null} [client]
   * @returns {Promise<boolean>} true if a membership row was removed.
   */
  static async removeMember(channelId, userId, client = null) {
    const executor = client || pool;

    const channelResult = await executor.query(
      'SELECT authentik_group_id, authentik_read_group_id, authentik_write_group_id FROM channels WHERE id = $1',
      [channelId]
    );
    const channel = channelResult.rows[0];

    const membershipResult = await executor.query(
      'DELETE FROM channel_memberships WHERE channel_id = $1 AND user_id = $2 RETURNING permission',
      [channelId, userId]
    );

    if (membershipResult.rows.length === 0) {
      return false;
    }

    if (channel) {
      const permission = membershipResult.rows[0].permission;
      const targetGroupId = this.resolveGroupIdForPermission(channel, permission);
      if (targetGroupId) {
        await EventPublisher.publishOperation(
          'remove_user_from_group',
          {
            target_user_id: userId,
            target_group_id: targetGroupId
          },
          null,
          client
        );
      }
    }

    return true;
  }

  /**
   * Bugfix (Channels tab has no delete-channel action): deletes a
   * CUSTOM channel (`is_primary = false` only -- a primary/team channel
   * is auto-managed by `Team.createTeamChannel`/`Team.delete` and has no
   * standalone delete path of its own) and its `channel_memberships`
   * rows, inside one transaction on one acquired client, mirroring
   * `Team.delete`'s own channel-cleanup shape: FK-dependency order
   * (memberships before the channel row, since neither foreign key
   * declares `ON DELETE CASCADE`), then one `remove_team_channel_group`
   * Sync_Operation enqueued on that SAME client so it commits/rolls back
   * atomically with the deletion. Group-id fields that are null on the
   * channel row are omitted from the payload entirely (never passed
   * through as `null`), matching `Team.delete`'s own reasoning: a
   * payload field is only skipped by `operationSchemas.js`'s optional-
   * field check when `undefined`, not merely falsy.
   *
   * @param {number|string} channelId
   * @param {number|null} [deletedBy] - local user id of the actor
   *   performing the deletion, recorded on the queued Sync_Operation.
   * @returns {Promise<object|null>} the deleted `channels` row, or
   *   `null` if no CUSTOM channel with this id exists (already deleted,
   *   never existed, or is a primary channel).
   */
  static async deleteCustomChannel(channelId, deletedBy = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const channelResult = await client.query(
        'SELECT * FROM channels WHERE id = $1 AND is_primary = false FOR UPDATE',
        [channelId]
      );
      const channel = channelResult.rows[0];

      if (!channel) {
        await client.query('ROLLBACK');
        return null;
      }

      await client.query('DELETE FROM channel_memberships WHERE channel_id = $1', [channelId]);
      await client.query('DELETE FROM channels WHERE id = $1', [channelId]);

      const payload = { channel_id: channel.id };
      if (channel.authentik_group_id != null) {
        payload.authentik_group_id = channel.authentik_group_id;
      }
      if (channel.authentik_read_group_id != null) {
        payload.authentik_read_group_id = channel.authentik_read_group_id;
      }
      if (channel.authentik_write_group_id != null) {
        payload.authentik_write_group_id = channel.authentik_write_group_id;
      }
      await EventPublisher.publishOperation('remove_team_channel_group', payload, deletedBy, client);

      await client.query('COMMIT');
      return channel;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ err: error, channelId }, 'Error deleting custom channel');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * Bugfix (Channels tab has no edit action, and no way to add/edit a
   * custom channel's Authentik/LDAP description): updates a CUSTOM
   * channel's `description` (`is_primary = false` only -- mirrors
   * `deleteCustomChannel`'s own refusal of a primary/team channel,
   * which has no standalone edit path of its own either). Scoped to
   * `description` only -- no rename support: a custom channel's name
   * is derived from its team's callsign/hierarchy plus its
   * `custom_suffix` at creation time, and renaming it would mean
   * renaming all THREE of its Authentik groups (rw/read/write), which
   * is a materially larger change than what was asked for here.
   *
   * Mirrors `deleteCustomChannel`'s transaction shape exactly: one
   * acquired client, `SELECT ... FOR UPDATE` to lock the row and refuse
   * a primary channel, the local `UPDATE`, then one
   * `update_channel_group` Sync_Operation enqueued on that SAME client
   * so it commits/rolls back atomically with the local write. Every
   * group-id field present on the row is included in the payload (a
   * freshly created custom channel always has all three, but a null
   * field is omitted entirely rather than sent as `null`, matching
   * `deleteCustomChannel`'s own reasoning about `operationSchemas.js`'s
   * optional-field handling).
   *
   * @param {number|string} channelId
   * @param {{description: string|null}} updateData
   * @param {number|null} [updatedBy] - local user id of the actor
   *   performing the update, recorded on the queued Sync_Operation.
   * @returns {Promise<object|null>} the updated `channels` row, or
   *   `null` if no CUSTOM channel with this id exists (never existed,
   *   already deleted, or is a primary channel).
   */
  static async updateCustomChannel(channelId, { description }, updatedBy = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const channelResult = await client.query(
        'SELECT * FROM channels WHERE id = $1 AND is_primary = false FOR UPDATE',
        [channelId]
      );
      const existing = channelResult.rows[0];

      if (!existing) {
        await client.query('ROLLBACK');
        return null;
      }

      // Normalized to '' (never null) before either the local UPDATE or
      // the enqueued payload: operationSchemas.js's analogous
      // update_bch_channel_group/update_region_channel_group entries both
      // require `description: 'string'` (never nullable), so a cleared
      // field must round-trip as an empty string, not null, or the
      // enqueued operation would fail payload validation permanently.
      const normalizedDescription = description || '';

      const updateResult = await client.query(
        'UPDATE channels SET description = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [normalizedDescription, channelId]
      );
      const channel = updateResult.rows[0];

      const payload = {
        channel_id: channel.id,
        description: normalizedDescription
      };
      if (channel.authentik_group_id != null) {
        payload.authentik_group_id = channel.authentik_group_id;
      }
      if (channel.authentik_read_group_id != null) {
        payload.authentik_read_group_id = channel.authentik_read_group_id;
      }
      if (channel.authentik_write_group_id != null) {
        payload.authentik_write_group_id = channel.authentik_write_group_id;
      }
      await EventPublisher.publishOperation('update_channel_group', payload, updatedBy, client);

      await client.query('COMMIT');
      return channel;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ err: error, channelId }, 'Error updating custom channel');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getChannelCount(teamId) {
    const result = await pool.query('SELECT COUNT(*) as count FROM channels WHERE team_id = $1', [teamId]);
    return parseInt(result.rows[0].count);
  }
  
  /**
   * Requirement 16.6 (task 35.6): the 3-channel-per-team limit must be
   * enforced by re-validating the channel count immediately before the
   * `channels` INSERT, inside a `SERIALIZABLE` transaction, and this same
   * mechanism must be used for EVERY call -- not only as a fallback when a
   * race is detected -- so enforcement is uniform whether or not a real
   * race occurs.
   *
   * This is split into two phases, matching the pattern already
   * established by `UserProvisioningService`/`POST /api/users/create-and-add`
   * (task 36.1): external HTTP calls (Authentik group creation) must never
   * be issued from inside an open DB transaction, so they happen first.
   *
   *   Phase 1 (no open transaction): look up the team and generate the
   *     channel name, then create the 3 Authentik groups.
   *   Phase 2 (single SERIALIZABLE transaction, one acquired client):
   *     re-check `COUNT(*) FROM channels WHERE team_id = $1` against the
   *     limit, INSERT the `channels` row, and add every member, all on
   *     that same client. On any failure -- including a limit still being
   *     reached, or a Postgres `serialization_failure` (SQLSTATE 40001)
   *     surfaced only at COMMIT time -- the transaction is rolled back and
   *     a `ChannelLimitError` (or the original error) is thrown.
   *
   * Note: if Phase 2 fails, the 3 Authentik groups created in Phase 1 are
   * NOT compensated (no synchronous delete or cleanup Sync_Operation is
   * enqueued here). Unlike `POST /api/users/create-and-add` (Requirement
   * 17.2), this task's scope is limited to the concurrency-safe count
   * re-check itself; a compensating-action follow-up for orphaned
   * Authentik groups on this path was not specified by this task and was
   * intentionally left out to avoid over-engineering beyond what was
   * asked. This is flagged for visibility -- see task report.
   */
  static async createCustomChannel(teamId, customSuffix, memberPermissions, description = null) {
    const prepared = await Channel.prepareCustomChannelCreation(teamId, customSuffix, description);

    // --- Phase 2: single SERIALIZABLE transaction re-validating the count
    // immediately before INSERT, on one acquired client. ---
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const channel = await Channel.insertCustomChannelAndMembers(teamId, customSuffix, memberPermissions, prepared, client);
      await client.query('COMMIT');
      return channel;
    } catch (error) {
      await client.query('ROLLBACK');

      // A real conflict can also surface only at COMMIT time as a
      // Postgres serialization_failure (SQLSTATE 40001), after the row
      // was already inserted on this client but before it became
      // visible/durable. Treat that the same as a limit-reached error
      // rather than a generic 500, per this task's note that the caller
      // should treat a 40001 as "limit reached / try again" if it
      // surfaces. This implementation does not retry automatically
      // (single-attempt, per this task's scope) -- see task report.
      if (error.code === '40001' && !(error instanceof ChannelLimitError)) {
        logger.error({ err: error, teamId }, 'Serialization failure re-validating channel count; treating as limit reached');
        throw new ChannelLimitError();
      }

      logger.error({ err: error, teamId }, 'Error creating custom channel (Phase 2: transactional count re-check / insert)');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Phase 1 of `createCustomChannel`, extracted as its own reusable
   * static method (task 45.2) so `ChannelRequestService.approveChannelRequest`
   * can also run this phase -- team lookup + Authentik group creation, no
   * open DB transaction -- BEFORE it opens its own `SERIALIZABLE`
   * transaction that wraps a `channel_requests` status flip together
   * with Phase 2 (see `insertCustomChannelAndMembers` below). This keeps
   * the "external HTTP calls never happen inside an open transaction"
   * convention intact for that caller too, exactly as it already is for
   * `createCustomChannel` itself.
   *
   * @param {string|null} [customDescription] - Bugfix (Create Custom
   *   Channel dialog had no way to set a description at creation time --
   *   only via the later "Edit channel" action): when supplied
   *   (a non-empty, trimmed string), this becomes the description
   *   written to the local `channels` row AND to all three Authentik
   *   groups' `attributes.description`, in place of the generated
   *   `Custom channel: ${fullChannelName}` default. `null`/omitted
   *   preserves the exact previous behaviour.
   * @returns {Promise<{fullChannelName: string, description: string, channelDbName: string, rwGroup: object, readGroup: object, writeGroup: object}>}
   */
  static async prepareCustomChannelCreation(teamId, customSuffix, customDescription = null) {
    let fullChannelName, description, channelDbName, authentikGroupName;
    let rwGroup, readGroup, writeGroup;
    try {
      // Get team with root team info for naming
      const teamResult = await pool.query(`
        WITH RECURSIVE root_team AS (
          SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = $1
          UNION ALL
          SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id 
          FROM teams p JOIN root_team r ON p.id = r.parent_team_id
        )
        SELECT t.id, t.name, t.parent_team_id,
               rt.callsign_prefix as root_prefix
        FROM teams t
        LEFT JOIN (SELECT name, callsign_prefix FROM root_team WHERE parent_team_id IS NULL) rt ON true
        WHERE t.id = $1
      `, [teamId]);

      if (!teamResult.rows[0]) throw new Error('Team not found');

      const team = teamResult.rows[0];

      // Generate channel name
      const separator = resolveChannelFolderSeparator();
      let baseChannelName;
      if (team.parent_team_id) {
        baseChannelName = `Teams${separator}${team.root_prefix}${separator}${team.name}`;
      } else {
        baseChannelName = `Teams${separator}${team.root_prefix || team.name}`;
      }

      fullChannelName = `${baseChannelName} - ${customSuffix}`;
      description = customDescription || `Custom channel: ${fullChannelName}`;
      channelDbName = fullChannelName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      // Create Authentik groups
      authentikGroupName = `tak_${fullChannelName}`;

      const groupPromises = [
        // Read/Write group (main group)
        fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: authentikGroupName,
            attributes: {
              description: description
            }
          })
        }),
        // Read-only group
        fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: `${authentikGroupName}_READ`,
            attributes: {
              description: `${description} - Read Only`
            }
          })
        }),
        // Write-only group
        fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: `${authentikGroupName}_WRITE`,
            attributes: {
              description: `${description} - Write Only`
            }
          })
        })
      ];

      const [rwGroupResponse, readGroupResponse, writeGroupResponse] = await Promise.all(groupPromises);
      [rwGroup, readGroup, writeGroup] = await Promise.all([
        rwGroupResponse.json(),
        readGroupResponse.json(),
        writeGroupResponse.json()
      ]);
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error creating custom channel (Phase 1: team lookup / Authentik groups)');
      throw error;
    }

    return { fullChannelName, description, channelDbName, rwGroup, readGroup, writeGroup };
  }

  /**
   * Phase 2 of `createCustomChannel`, extracted as its own reusable
   * static method (task 45.2): re-validates the channel count against
   * the limit and INSERTs the `channels` row + members, all on the
   * caller-supplied `client` -- which MUST already have an open
   * transaction (`createCustomChannel` uses `BEGIN ISOLATION LEVEL
   * SERIALIZABLE`; `ChannelRequestService.approveChannelRequest` reuses
   * this same method on its own `SERIALIZABLE` transaction so the
   * `channel_requests` status flip and this INSERT commit/roll back
   * together as one atomic unit). This method does NOT itself call
   * `BEGIN`/`COMMIT`/`ROLLBACK`/`release()` -- unlike
   * `addMember`/`publishOperation`'s optional-client pattern, the caller
   * always owns the transaction here, since both existing callers already
   * have one open before this runs.
   *
   * Throws `ChannelLimitError` if the limit is still reached (the caller
   * is responsible for issuing `ROLLBACK` on any thrown error, exactly as
   * `createCustomChannel` already does below).
   *
   * @param {number|string} teamId
   * @param {string} customSuffix
   * @param {Array<{userId: number, permission: string}>} memberPermissions
   * @param {{fullChannelName: string, description: string, channelDbName: string, rwGroup: object, readGroup: object, writeGroup: object}} prepared
   *   - the result of `prepareCustomChannelCreation`.
   * @param {import('pg').PoolClient} client - an already-`BEGIN`-ed client.
   * @returns {Promise<object>} the inserted `channels` row.
   */
  static async insertCustomChannelAndMembers(teamId, customSuffix, memberPermissions, prepared, client) {
    const { fullChannelName, description, channelDbName, rwGroup, readGroup, writeGroup } = prepared;

    // Authoritative re-check: this SELECT and the INSERT below both run
    // on the same client/transaction, so under SERIALIZABLE isolation a
    // concurrent transaction attempting the same re-check + INSERT for
    // this team is guaranteed to either see this row (if it commits
    // first) or force this transaction to fail with a
    // serialization_failure at COMMIT time (if it commits second) --
    // either way, at most one of them succeeds in inserting a 4th+
    // channel for this team.
    const countResult = await client.query(
      'SELECT COUNT(*) as count FROM channels WHERE team_id = $1',
      [teamId]
    );
    const channelCount = parseInt(countResult.rows[0].count);

    if (channelCount >= 3) {
      throw new ChannelLimitError();
    }

    // Create channel in database
    const channelResult = await client.query(
      'INSERT INTO channels (name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, authentik_write_group_id, is_primary, channel_type, custom_suffix) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9) RETURNING *',
      [channelDbName, fullChannelName, description, teamId, rwGroup.pk, readGroup.pk, writeGroup.pk, 'custom', customSuffix]
    );

    const channel = channelResult.rows[0];

    // Add members with permissions, on the same client/transaction.
    //
    // Bugfix (silent Authentik sync gap): every other membership-writing
    // path in this codebase (TeamMembershipService.addUserToTeam,
    // DeploymentChannelService.subscribe, VendorChannelService) pairs its
    // local INSERT with an enqueued 'add_user_to_group' Sync_Operation --
    // this loop used to be the one exception, silently upserting
    // channel_memberships with NO corresponding Authentik write at all,
    // so a member added here would never actually appear in the
    // channel's Authentik group. The enqueue below fixes that, on this
    // SAME transactional client (Requirement 17.5's established
    // pattern) so it commits/rolls back atomically with the member INSERT.
    // `resolveGroupIdForPermission` maps the member's permission to
    // whichever of the channel's three groups it corresponds to; an
    // unrecognized permission or a channel missing that particular group
    // (should not happen for a freshly-created custom channel, which
    // always has all three) skips the enqueue rather than sending an
    // invalid target_group_id.
    for (const memberPerm of memberPermissions) {
      await this.addMember(channel.id, memberPerm.userId, memberPerm.permission, client);

      const targetGroupId = this.resolveGroupIdForPermission(channel, memberPerm.permission);
      if (targetGroupId) {
        await EventPublisher.publishOperation(
          'add_user_to_group',
          {
            target_user_id: memberPerm.userId,
            target_group_id: targetGroupId
          },
          null,
          client
        );
      } else {
        logger.warn(
          { channelId: channel.id, userId: memberPerm.userId, permission: memberPerm.permission },
          'Skipped add_user_to_group enqueue: no matching Authentik group id for this permission'
        );
      }
    }

    return channel;
  }
}

Channel.ChannelLimitError = ChannelLimitError;

module.exports = Channel;