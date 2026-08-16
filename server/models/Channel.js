const pool = require('../config/database');
const logger = require('../config/logger').createLogger('Channel');

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
  static async createCustomChannel(teamId, customSuffix, memberPermissions) {
    const prepared = await Channel.prepareCustomChannelCreation(teamId, customSuffix);

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
   * @returns {Promise<{fullChannelName: string, description: string, channelDbName: string, rwGroup: object, readGroup: object, writeGroup: object}>}
   */
  static async prepareCustomChannelCreation(teamId, customSuffix) {
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
      const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
      let baseChannelName;
      if (team.parent_team_id) {
        baseChannelName = `Teams${separator}${team.root_prefix}${separator}${team.name}`;
      } else {
        baseChannelName = `Teams${separator}${team.root_prefix || team.name}`;
      }

      fullChannelName = `${baseChannelName} - ${customSuffix}`;
      description = `Custom channel: ${fullChannelName}`;
      channelDbName = fullChannelName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      // Create Authentik groups
      authentikGroupName = `tak_${fullChannelName}`;

      const groupPromises = [
        // Read/Write group (main group)
        fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
    for (const memberPerm of memberPermissions) {
      await this.addMember(channel.id, memberPerm.userId, memberPerm.permission, client);
    }

    return channel;
  }
}

Channel.ChannelLimitError = ChannelLimitError;

module.exports = Channel;