const pool = require('../config/database');
const logger = require('../config/logger').createLogger('Team');
const EventPublisher = require('../services/EventPublisher');

class Team {
  static async create(teamData) {
    const { name, description, callsign_prefix, color, visibility, can_join, parent_team_id, created_by, callsign_subteam_depth, callsign_name_format } = teamData;
    try {
      const result = await pool.query(
        'INSERT INTO teams (name, description, callsign_prefix, color, visibility, can_join, parent_team_id, created_by, callsign_subteam_depth, callsign_name_format) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
        [name, description, callsign_prefix, color, visibility, can_join, parent_team_id, created_by, callsign_subteam_depth, callsign_name_format]
      );
      
      const team = result.rows[0];
      
      // Auto-create team channel
      await this.createTeamChannel(team.id);
      
      return team;
    } catch (error) {
      logger.error({ err: error }, 'Error creating team');
      // Fallback to basic creation if new columns don't exist
      const result = await pool.query(
        'INSERT INTO teams (name, description, parent_team_id, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, description, parent_team_id, created_by]
      );
      return result.rows[0];
    }
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM teams WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async getSubTeams(parentId) {
    const result = await pool.query('SELECT * FROM teams WHERE parent_team_id = $1', [parentId]);
    return result.rows;
  }

  static async getTeamHierarchy(teamId) {
    const result = await pool.query(`
      WITH RECURSIVE team_hierarchy AS (
        SELECT id, name, parent_team_id, 0 as level
        FROM teams WHERE id = $1
        UNION ALL
        SELECT t.id, t.name, t.parent_team_id, th.level + 1
        FROM teams t
        JOIN team_hierarchy th ON t.parent_team_id = th.id
      )
      SELECT * FROM team_hierarchy ORDER BY level
    `, [teamId]);
    return result.rows;
  }

  static async addMember(teamId, userId, role = 'member') {
    try {
      const result = await pool.query(
        'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3) RETURNING *',
        [teamId, userId, role]
      );
      return result.rows[0];
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error adding team member');
      // Fallback to basic membership without role if column doesn't exist
      const result = await pool.query(
        'INSERT INTO team_memberships (team_id, user_id) VALUES ($1, $2) RETURNING *',
        [teamId, userId]
      );
      return result.rows[0];
    }
  }

  static async getMembers(teamId) {
    try {
      // Get members including inherited memberships
      const result = await pool.query(`
        SELECT u.*, tm.role, tm.inherited_from_team_id,
               CASE 
                 WHEN tm.inherited_from_team_id IS NOT NULL THEN t.name
                 ELSE NULL
               END as inherited_from_team_name
        FROM users u 
        JOIN team_memberships tm ON u.id = tm.user_id 
        LEFT JOIN teams t ON tm.inherited_from_team_id = t.id
        WHERE tm.team_id = $1
        ORDER BY tm.role DESC, u.first_name, u.last_name
      `, [teamId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error fetching team members with users table');
      try {
        // Fallback to just team memberships
        const result = await pool.query(`
          SELECT tm.user_id as id, tm.role, tm.inherited_from_team_id,
                 tm.user_id::text as first_name, 
                 '' as last_name, 
                 tm.user_id::text || '@example.com' as email,
                 NULL as inherited_from_team_name
          FROM team_memberships tm 
          WHERE tm.team_id = $1
        `, [teamId]);
        return result.rows;
      } catch (fallbackError) {
        logger.error({ err: fallbackError, teamId }, 'Error in fallback team members query');
        return [];
      }
    }
  }

  static async isAdmin(teamId, userId) {
    try {
      const result = await pool.query(
        'SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2',
        [teamId, userId]
      );
      return result.rows[0]?.role === 'admin';
    } catch (error) {
      logger.error({ err: error, teamId, userId }, 'Error checking admin status');
      return false;
    }
  }

  // Requirement 27.9 (task 49.5): `member_count` here is a dashboard-style
  // member count displayed on the Teams/TeamDetail pages, so it must
  // exclude Team_Owned_Device rows (`users.is_team_device = true`) the
  // same way `GET /api/users` does -- a device should never inflate a
  // displayed member count. The subquery joins `team_memberships` ->
  // `users` (on `user_id`) to reach `is_team_device`, using `IS NOT TRUE`
  // (rather than `= false`) so a NULL `is_team_device` value -- which
  // should never occur given the column's `NOT NULL DEFAULT false`
  // migration, but also matches how boolean flags are treated elsewhere
  // in this codebase, e.g. `Channel.getChannelCount`/`is_active` checks
  // that never need to special-case NULL -- is still counted as "not a
  // device" rather than excluded by a stricter `= false` comparison that
  // would silently drop an unexpected NULL row.
  static async getUserTeams(userId) {
    try {
      const result = await pool.query(`
        SELECT t.*, tm.role, 
          (SELECT COUNT(*) FROM team_memberships tm2
           JOIN users u2 ON u2.id = tm2.user_id
           WHERE tm2.team_id = t.id AND u2.is_team_device IS NOT TRUE) as member_count
        FROM teams t
        LEFT JOIN team_memberships tm ON t.id = tm.team_id AND tm.user_id = $1
        WHERE tm.user_id IS NOT NULL AND tm.inherited_from_team_id IS NULL
        ORDER BY t.name
      `, [userId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, userId }, 'Error fetching user teams');
      return [];
    }
  }

  // Requirement 11.4: pagination for the admin "all teams" case of
  // `GET /api/teams/my-teams`. `limit`/`offset` are optional so that any
  // other caller of `getAllTeams()` (there are none elsewhere in the
  // codebase today, per a repo-wide grep) keeps the original unbounded
  // behavior by simply omitting them.
  //
  // Requirement 27.9 (task 49.5): `member_count` here is the same
  // dashboard-style column as `getUserTeams` above and gets the identical
  // `is_team_device IS NOT TRUE` exclusion, for the same reason.
  // `sub_teams_count` counts `teams` rows, not users, and is intentionally
  // left unchanged.
  static async getAllTeams(limit, offset) {
    try {
      const hasPagination = Number.isInteger(limit) && Number.isInteger(offset);
      const query = `
        SELECT t.*, 'admin' as role,
          (SELECT COUNT(*) FROM team_memberships tm
           JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = t.id AND u.is_team_device IS NOT TRUE) as member_count,
          (SELECT COUNT(*) FROM teams t2 WHERE t2.parent_team_id = t.id) as sub_teams_count
        FROM teams t
        ORDER BY t.name
        ${hasPagination ? 'LIMIT $1 OFFSET $2' : ''}
      `;
      const result = hasPagination
        ? await pool.query(query, [limit, offset])
        : await pool.query(query);
      return result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching all teams');
      return [];
    }
  }

  // Requirement 11.4: total team count, used alongside the paginated
  // `getAllTeams()` result to report pagination metadata.
  static async getTeamCount() {
    try {
      const result = await pool.query('SELECT COUNT(*) as count FROM teams');
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ err: error }, 'Error counting teams');
      return 0;
    }
  }

  static async update(teamId, updateData) {
    const { name, description, visibility, can_join, parent_team_id, callsign_subteam_depth, callsign_name_format } = updateData;
    try {
      const result = await pool.query(
        'UPDATE teams SET name = COALESCE($1, name), description = COALESCE($2, description), visibility = COALESCE($3, visibility), can_join = COALESCE($4, can_join), parent_team_id = $5, callsign_subteam_depth = COALESCE($6, callsign_subteam_depth), callsign_name_format = COALESCE($7, callsign_name_format), updated_at = CURRENT_TIMESTAMP WHERE id = $8 RETURNING *',
        [name, description, visibility, can_join, parent_team_id, callsign_subteam_depth, callsign_name_format, teamId]
      );
      return result.rows[0];
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error updating team');
      throw error;
    }
  }

  /**
   * Requirement 17.3/17.4 (task 36.3): deletes a team, and everything that
   * references it, inside a single transaction on one acquired client, in
   * FK-dependency order (deepest first): `channel_memberships` for every
   * channel belonging to this team, then the `channels` rows themselves,
   * then `team_memberships`, then the `teams` row. The baseline schema's
   * `channels.team_id`/`channel_memberships.channel_id` foreign keys do
   * NOT declare `ON DELETE CASCADE` (only `teams.parent_team_id` and
   * `team_memberships.team_id`/`.user_id` do), so those two deletes must
   * be performed explicitly here rather than relying on the database to
   * cascade them.
   *
   * On successful commit, one `remove_team_channel_group` Sync_Operation
   * is enqueued per deleted channel (each carrying that channel's
   * `authentik_group_id`/`authentik_read_group_id`/
   * `authentik_write_group_id`, whichever are non-null) so the
   * Sync_Worker can asynchronously delete the corresponding Authentik
   * group(s). Per Requirement 17.5's established pattern
   * (`TeamMembershipService`, `UserProvisioningService`), the enqueue
   * itself happens INSIDE the same transaction, passing the open `client`
   * through to `EventPublisher.publishOperation`, so the `sync_operations`
   * rows commit/roll back atomically with the deletion.
   *
   * Requirement 26.7 (task 48.4): additionally enqueues a SINGLE bulk
   * `revoke_tak_certificates` Sync_Operation covering every user who is a
   * direct or inherited member of this team OR any of its sub-teams
   * (resolved via the same descendants-of-`teamId` recursive query
   * `getTeamHierarchy` already uses), carrying the full list of affected
   * users' TAK usernames (`users.username`) in one payload so
   * `TakServerService.listCertificates()` only needs to be called once
   * for the whole batch when the Sync_Worker processes it (task 48.5),
   * rather than once per user -- the same N+1-avoidance principle already
   * established in Requirement 11. That membership list is resolved
   * BEFORE the `team_memberships` rows are deleted below (step 3), since
   * the membership rows are the only way to know which users are
   * affected. Nothing is enqueued when no affected user has a resolvable
   * username (e.g. an empty team).
   *
   * IF any step fails, the entire transaction is rolled back, leaving the
   * team and its associated records unchanged, and the error is
   * propagated to the caller.
   *
   * @param {number|string} teamId
   * @param {number|null} [deletedBy] - local user id of the actor
   *   performing the deletion, recorded on queued Sync_Operations.
   * @returns {Promise<object>} the deleted team row.
   */
  static async delete(teamId, deletedBy = null) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Fetch the channels belonging to this team BEFORE deleting them,
      // so their Authentik group ids are available for the post-delete
      // Sync_Operation enqueue below.
      const channelsResult = await client.query(
        'SELECT id, authentik_group_id, authentik_read_group_id, authentik_write_group_id FROM channels WHERE team_id = $1',
        [teamId]
      );
      const deletedChannels = channelsResult.rows;
      const channelIds = deletedChannels.map((channel) => channel.id);

      // Requirement 26.7: resolve every affected user's TAK username
      // (this team's members plus every sub-team's members, direct or
      // inherited) BEFORE any team_memberships row is deleted. The
      // recursive CTE mirrors getTeamHierarchy's descendants-of-teamId
      // traversal (its recursive step joins t.parent_team_id = th.id,
      // i.e. "find children of the accumulated set"), scoped here to just
      // the id column since only team_memberships.team_id membership is
      // needed.
      const affectedUsersResult = await client.query(
        `WITH RECURSIVE team_and_subteams AS (
          SELECT id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id FROM teams t JOIN team_and_subteams ts ON t.parent_team_id = ts.id
        )
        SELECT DISTINCT u.username
        FROM team_memberships tm
        JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id IN (SELECT id FROM team_and_subteams) AND u.username IS NOT NULL`,
        [teamId]
      );
      const affectedTakUsernames = affectedUsersResult.rows.map((row) => row.username);

      // 1. channel_memberships for every channel belonging to this team.
      if (channelIds.length > 0) {
        await client.query('DELETE FROM channel_memberships WHERE channel_id = ANY($1)', [channelIds]);
      }

      // 2. channels rows for this team.
      await client.query('DELETE FROM channels WHERE team_id = $1', [teamId]);

      // 3. team_memberships for this team.
      await client.query('DELETE FROM team_memberships WHERE team_id = $1', [teamId]);

      // 4. the teams row itself.
      const result = await client.query('DELETE FROM teams WHERE id = $1 RETURNING *', [teamId]);

      // Requirement 17.4: enqueue one remove_team_channel_group
      // Sync_Operation per deleted channel, inside this same transaction
      // (Requirement 17.5's client-threading pattern), so the enqueue
      // commits/rolls back atomically with the deletion above. Group-id
      // fields that are null on the channel row are omitted entirely
      // (rather than passed through as `null`) so that
      // `operationSchemas.js`'s optional-field type check -- which only
      // skips a field when it is `undefined`, not merely falsy -- doesn't
      // reject an otherwise-valid payload for a channel that never had a
      // read/write group pair (e.g. a primary team channel).
      for (const channel of deletedChannels) {
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
      }

      // Requirement 26.7: a single bulk revoke_tak_certificates
      // Sync_Operation for the whole team + sub-team batch, rather than
      // one operation per affected user.
      if (affectedTakUsernames.length > 0) {
        await EventPublisher.publishOperation(
          'revoke_tak_certificates',
          { tak_usernames: affectedTakUsernames },
          deletedBy,
          client
        );
      }

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ err: error, teamId }, 'Error deleting team');
      throw error;
    } finally {
      client.release();
    }
  }

  static async getJoinableTeams() {
    try {
      const result = await pool.query(`
        SELECT t.id, t.name, t.description, t.visibility,
               CASE 
                 WHEN t.parent_team_id IS NOT NULL THEN 
                   COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
                 ELSE t.name
               END as display_name
        FROM teams t
        LEFT JOIN teams rt ON rt.id = (
          WITH RECURSIVE root_team AS (
            SELECT id, name, parent_team_id FROM teams WHERE id = t.id
            UNION ALL
            SELECT p.id, p.name, p.parent_team_id 
            FROM teams p JOIN root_team r ON p.id = r.parent_team_id
          )
          SELECT id FROM root_team WHERE parent_team_id IS NULL
        )
        WHERE t.can_join = true AND t.visibility = 'public'
        ORDER BY display_name
      `);
      return result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching joinable teams');
      return [];
    }
  }

  static async createTeamChannel(teamId) {
    try {
      // Get team with root team info
      const teamResult = await pool.query(`
        WITH RECURSIVE root_team AS (
          SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = $1
          UNION ALL
          SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id 
          FROM teams p JOIN root_team r ON p.id = r.parent_team_id
        )
        SELECT t.id, t.name, t.parent_team_id,
               rt.callsign_prefix as root_prefix,
               CASE 
                 WHEN t.parent_team_id IS NOT NULL THEN 
                   COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
                 ELSE t.name
               END as display_name
        FROM teams t
        LEFT JOIN (SELECT name, callsign_prefix FROM root_team WHERE parent_team_id IS NULL) rt ON true
        WHERE t.id = $1
      `, [teamId]);
      
      if (!teamResult.rows[0]) return null;
      
      const team = teamResult.rows[0];
      
      // Generate channel name
      const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
      let channelName;
      if (team.parent_team_id) {
        // Sub-team: "Teams - FENZ - Southland District"
        channelName = `Teams${separator}${team.root_prefix}${separator}${team.name}`;
      } else {
        // Root team: "Teams - FENZ"
        channelName = `Teams${separator}${team.root_prefix || team.name}`;
      }
      
      const description = `Users from ${team.display_name} (Location sharing enabled)`;
      
      // Create groups in Authentik with tak_ prefix
      const authentikGroupName = `tak_${channelName}`;
      const channelDbName = channelName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
      
      try {
        // Create read/write group
        const groupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
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
        });
        
        const group = await groupResponse.json();
        
        // Create channel with Authentik group ID
        const channelResult = await pool.query(
          'INSERT INTO channels (name, display_name, description, team_id, authentik_group_id, is_primary) VALUES ($1, $2, $3, $4, $5, true) RETURNING *',
          [channelDbName, channelName, description, teamId, group.pk]
        );
        
        return channelResult.rows[0];
      } catch (authentikError) {
        logger.error({ err: authentikError, teamId }, 'Error creating Authentik groups');
        
        // Fallback: create channel without Authentik groups
        const channelResult = await pool.query(
          'INSERT INTO channels (name, display_name, description, team_id, is_primary) VALUES ($1, $2, $3, $4, true) RETURNING *',
          [channelDbName, channelName, description, teamId]
        );
        
        return channelResult.rows[0];
      }
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error creating team channel');
      return null;
    }
  }
}

module.exports = Team;