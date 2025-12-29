const pool = require('../config/database');

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
      console.error('Error creating team:', error);
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
      console.error('Error adding team member:', error);
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
      console.error('Error fetching team members with users table:', error);
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
        console.error('Error in fallback team members query:', fallbackError);
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
      console.error('Error checking admin status:', error);
      return false;
    }
  }

  static async getUserTeams(userId) {
    try {
      const result = await pool.query(`
        SELECT t.*, tm.role, 
          (SELECT COUNT(*) FROM team_memberships tm2 WHERE tm2.team_id = t.id) as member_count
        FROM teams t
        LEFT JOIN team_memberships tm ON t.id = tm.team_id AND tm.user_id = $1
        WHERE tm.user_id IS NOT NULL AND tm.inherited_from_team_id IS NULL
        ORDER BY t.name
      `, [userId]);
      return result.rows;
    } catch (error) {
      console.error('Error fetching user teams:', error);
      return [];
    }
  }

  static async getAllTeams() {
    try {
      const result = await pool.query(`
        SELECT t.*, 'admin' as role,
          (SELECT COUNT(*) FROM team_memberships tm WHERE tm.team_id = t.id) as member_count,
          (SELECT COUNT(*) FROM teams t2 WHERE t2.parent_team_id = t.id) as sub_teams_count
        FROM teams t
        ORDER BY t.name
      `);
      return result.rows;
    } catch (error) {
      console.error('Error fetching all teams:', error);
      return [];
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
      console.error('Error updating team:', error);
      throw error;
    }
  }

  static async delete(teamId) {
    try {
      // Delete team memberships first
      await pool.query('DELETE FROM team_memberships WHERE team_id = $1', [teamId]);
      
      // Delete the team
      const result = await pool.query('DELETE FROM teams WHERE id = $1 RETURNING *', [teamId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error deleting team:', error);
      throw error;
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
      console.error('Error fetching joinable teams:', error);
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
              CN: channelName,
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
        console.error('Error creating Authentik groups:', authentikError);
        
        // Fallback: create channel without Authentik groups
        const channelResult = await pool.query(
          'INSERT INTO channels (name, display_name, description, team_id, is_primary) VALUES ($1, $2, $3, $4, true) RETURNING *',
          [channelDbName, channelName, description, teamId]
        );
        
        return channelResult.rows[0];
      }
    } catch (error) {
      console.error('Error creating team channel:', error);
      return null;
    }
  }
}

module.exports = Team;