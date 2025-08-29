const pool = require('../config/database');

class Team {
  static async create(teamData) {
    const { name, description, parent_team_id, created_by } = teamData;
    const result = await pool.query(
      'INSERT INTO teams (name, description, parent_team_id, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description, parent_team_id, created_by]
    );
    return result.rows[0];
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
    const result = await pool.query(
      'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3) RETURNING *',
      [teamId, userId, role]
    );
    return result.rows[0];
  }

  static async getMembers(teamId) {
    const result = await pool.query(`
      SELECT u.*, tm.role 
      FROM users u 
      JOIN team_memberships tm ON u.id = tm.user_id 
      WHERE tm.team_id = $1
    `, [teamId]);
    return result.rows;
  }

  static async isAdmin(teamId, userId) {
    const result = await pool.query(
      'SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2',
      [teamId, userId]
    );
    return result.rows[0]?.role === 'admin';
  }
}

module.exports = Team;