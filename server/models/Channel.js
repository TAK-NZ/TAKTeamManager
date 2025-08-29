const pool = require('../config/database');

class Channel {
  static async create(channelData) {
    const { name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, is_primary } = channelData;
    const result = await pool.query(
      'INSERT INTO channels (name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, is_primary) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [name, display_name, description, team_id, authentik_group_id, authentik_read_group_id, is_primary]
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

  static async addMember(channelId, userId) {
    const result = await pool.query(
      'INSERT INTO channel_memberships (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *',
      [channelId, userId]
    );
    return result.rows[0];
  }

  static async getMembers(channelId) {
    const result = await pool.query(`
      SELECT u.id, u.username, u.email, u.first_name, u.last_name
      FROM users u
      JOIN channel_memberships cm ON u.id = cm.user_id
      WHERE cm.channel_id = $1
      ORDER BY u.first_name, u.last_name
    `, [channelId]);
    return result.rows;
  }
}

module.exports = Channel;