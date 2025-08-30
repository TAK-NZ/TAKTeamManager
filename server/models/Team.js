const pool = require('../config/database');

class Team {
  static async create(teamData) {
    const { name, description, slug, color, visibility, can_join, parent_team_id, created_by } = teamData;
    try {
      const result = await pool.query(
        'INSERT INTO teams (name, description, slug, color, visibility, can_join, parent_team_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
        [name, description, slug, color, visibility, can_join, parent_team_id, created_by]
      );
      return result.rows[0];
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
      // First try with users table
      const result = await pool.query(`
        SELECT u.*, tm.role 
        FROM users u 
        JOIN team_memberships tm ON u.id = tm.user_id 
        WHERE tm.team_id = $1
      `, [teamId]);
      return result.rows;
    } catch (error) {
      console.error('Error fetching team members with users table:', error);
      try {
        // Fallback to just team memberships
        const result = await pool.query(`
          SELECT tm.user_id as id, tm.role, 
                 tm.user_id::text as first_name, 
                 '' as last_name, 
                 tm.user_id::text || '@example.com' as email
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
        WHERE tm.user_id IS NOT NULL
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
    const { name, description, slug, visibility, can_join } = updateData;
    try {
      const result = await pool.query(
        'UPDATE teams SET name = COALESCE($1, name), description = COALESCE($2, description), slug = COALESCE($3, slug), visibility = COALESCE($4, visibility), can_join = COALESCE($5, can_join), updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
        [name, description, slug, visibility, can_join, teamId]
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
        SELECT id, name, description, visibility
        FROM teams 
        WHERE can_join = true AND visibility = 'public'
        ORDER BY name
      `);
      return result.rows;
    } catch (error) {
      console.error('Error fetching joinable teams:', error);
      return [];
    }
  }
}

module.exports = Team;