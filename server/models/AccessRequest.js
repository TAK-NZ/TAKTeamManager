const pool = require('../config/database');

class AccessRequest {
  static async create(requestData) {
    const { email, first_name, last_name, team_name, reason } = requestData;
    const result = await pool.query(
      'INSERT INTO access_requests (email, first_name, last_name, team_name, reason) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [email, first_name, last_name, team_name, reason]
    );
    return result.rows[0];
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM access_requests WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async getPendingRequests() {
    const result = await pool.query(
      'SELECT * FROM access_requests WHERE status = $1 ORDER BY created_at DESC',
      ['pending']
    );
    return result.rows;
  }

  static async updateStatus(id, status, reviewedBy, reviewReason = null) {
    const result = await pool.query(
      'UPDATE access_requests SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, review_reason = $3 WHERE id = $4 RETURNING *',
      [status, reviewedBy, reviewReason, id]
    );
    return result.rows[0];
  }

  static async getRequestsByTeam(teamName) {
    const result = await pool.query(
      'SELECT * FROM access_requests WHERE team_name = $1 ORDER BY created_at DESC',
      [teamName]
    );
    return result.rows;
  }
}

module.exports = AccessRequest;