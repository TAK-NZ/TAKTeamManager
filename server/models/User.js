const pool = require('../config/database');

class User {
  static async create(userData) {
    const { authentik_user_id, username, email, first_name, last_name, callsign_suffix = null } = userData;
    const result = await pool.query(
      'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, callsign_suffix) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [authentik_user_id, username, email, first_name, last_name, callsign_suffix]
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

  /**
   * Requirement 13.2, 13.9 (task 28.1): a targeted, dynamic-SET-clause
   * update of a `users` row, used by the Member_List edit route
   * (`PATCH /api/teams/:teamId/members/:userId`) to write `first_name`/
   * `last_name`/`tak_role`/`callsign_suffix` directly, without the
   * self-service name-change request/approval flow (Requirement 13.9).
   *
   * `fields` is a plain object keyed by the ACTUAL `users` column name
   * (e.g. `{ first_name: 'Jane', tak_role: 'Team Lead' }`) -- callers are
   * responsible for mapping request-body field names (`firstName`) to
   * column names before calling this. Only keys present on `fields` are
   * included in the generated SET clause, so a caller can update any
   * subset of columns without affecting the others (Requirement 13.2's
   * "edit ... directly" applies per-field, not as an all-or-nothing
   * write). An `email` key is deliberately never accepted anywhere this
   * method is called from (Requirement 13.3) -- this method itself does
   * not special-case `email`, since every call site already omits it.
   *
   * Returns the updated row (`RETURNING *`), or `undefined` if no row
   * matched `id`. If `fields` is empty, this is a no-op that returns the
   * current row via `findById` instead of issuing a no-column UPDATE.
   *
   * @param {number|string} id
   * @param {Object<string, *>} fields
   * @returns {Promise<Object|undefined>}
   */
  static async update(id, fields) {
    const columns = Object.keys(fields);
    if (columns.length === 0) {
      return this.findById(id);
    }

    const setClause = columns.map((column, index) => `${column} = $${index + 1}`).join(', ');
    const values = columns.map((column) => fields[column]);

    const result = await pool.query(
      `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $${columns.length + 1} RETURNING *`,
      [...values, id]
    );
    return result.rows[0];
  }

  static async getTeamMemberships(userId) {
    const result = await pool.query(`
      SELECT t.*, tm.role 
      FROM teams t 
      JOIN team_memberships tm ON t.id = tm.team_id 
      WHERE tm.user_id = $1 AND tm.inherited_from_team_id IS NULL
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