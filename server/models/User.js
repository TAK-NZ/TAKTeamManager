const pool = require('../config/database');

class User {
  static async create(userData) {
    const { authentik_user_id, username, email, first_name, last_name } = userData;
    const result = await pool.query(
      'INSERT INTO users (authentik_user_id, username, email, first_name, last_name) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [authentik_user_id, username, email, first_name, last_name]
    );
    return result.rows[0];
  }

  static async findByUsername(username) {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return result.rows[0];
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async getTeamMemberships(userId) {
    const result = await pool.query(`
      SELECT t.*, tm.role 
      FROM teams t 
      JOIN team_memberships tm ON t.id = tm.team_id 
      WHERE tm.user_id = $1
    `, [userId]);
    return result.rows;
  }

  static async getChannelMemberships(userId) {
    const result = await pool.query(`
      SELECT c.* 
      FROM channels c 
      JOIN channel_memberships cm ON c.id = cm.channel_id 
      WHERE cm.user_id = $1
    `, [userId]);
    return result.rows;
  }
}

module.exports = User;