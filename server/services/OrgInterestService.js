const pool = require('../config/database');

/**
 * OrgInterestService
 *
 * Handles org interest request creation and management.
 * Org interest requests are informational leads for global admins when
 * no teams are available for a verified user's email domain.
 */
class OrgInterestService {
  /**
   * Submit an org interest request.
   * Validates the verification token, checks excluded domains, enforces
   * at most one pending request per email, and consumes the token on success.
   *
   * @param {Object} data - {token, firstName, lastName, orgName}
   * @returns {Promise<{id: number}>}
   */
  async submitRequest({ token, firstName, lastName, orgName }) {
    // Validate the verification token
    const tokenResult = await pool.query(
      `SELECT id, requester_email
       FROM access_requests
       WHERE email_verification_token = $1
         AND email_verification_expires_at > NOW()
         AND email_verified = false`,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      throw new Error('Invalid or expired verification token');
    }

    const { id: accessRequestId, requester_email: email } = tokenResult.rows[0];

    // Check if excluded domain blocks this request
    const excluded = await this.isExcludedDomain(email);
    if (excluded) {
      throw new Error('Please use an organisational email address to request a new organisation');
    }

    // Check for existing pending org interest request for this email
    const pendingResult = await pool.query(
      `SELECT id FROM org_interest_requests
       WHERE email = $1 AND status = 'pending'`,
      [email]
    );

    if (pendingResult.rows.length > 0) {
      throw new Error('A request is already pending for this email');
    }

    // Insert the org interest request
    const insertResult = await pool.query(
      `INSERT INTO org_interest_requests (email, first_name, last_name, org_name, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [email, firstName, lastName, orgName]
    );

    const id = insertResult.rows[0].id;

    // Consume the verification token by deleting the access_request row
    await pool.query(
      'DELETE FROM access_requests WHERE id = $1',
      [accessRequestId]
    );

    return { id };
  }

  /**
   * Get all org interest requests (for admin panel).
   * Supports optional status filter. Ordered by created_at descending.
   *
   * @param {Object} filters - {status?: string}
   * @returns {Promise<Array>}
   */
  async listRequests(filters = {}) {
    let query = 'SELECT * FROM org_interest_requests';
    const params = [];

    if (filters.status) {
      query += ' WHERE status = $1';
      params.push(filters.status);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Update request status (pending → actioned | dismissed).
   * Throws if the request is not found or the status is invalid.
   *
   * @param {number} requestId
   * @param {string} newStatus - 'actioned' or 'dismissed'
   * @returns {Promise<void>}
   */
  async updateStatus(requestId, newStatus) {
    const validStatuses = ['actioned', 'dismissed'];
    if (!validStatuses.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}. Must be one of: ${validStatuses.join(', ')}`);
    }

    const result = await pool.query(
      'UPDATE org_interest_requests SET status = $1 WHERE id = $2 RETURNING id',
      [newStatus, requestId]
    );

    if (result.rows.length === 0) {
      throw new Error('Org interest request not found');
    }
  }

  /**
   * Check if an email domain is in the excluded list.
   * Extracts the domain from the email (everything after @) and checks
   * against the excluded_email_domains entry in system_config.
   *
   * @param {string} email
   * @returns {Promise<boolean>}
   */
  async isExcludedDomain(email) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) return false;

    const result = await pool.query(
      "SELECT config_value FROM system_config WHERE config_key = $1",
      ['excluded_email_domains']
    );

    if (result.rows.length === 0) return false;

    try {
      const excludedDomains = JSON.parse(result.rows[0].config_value);
      if (!Array.isArray(excludedDomains)) return false;
      return excludedDomains.map(d => d.toLowerCase()).includes(domain);
    } catch {
      return false;
    }
  }
}

module.exports = OrgInterestService;
