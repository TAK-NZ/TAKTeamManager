const crypto = require('crypto');
const pool = require('../config/database');
const EmailService = require('./EmailService');
const SignupCodeService = require('./SignupCodeService');

const emailService = new EmailService();

class SignupFlowService {
  /**
   * Determine the current state of an email in the system.
   * Priority chain (first match wins):
   * 1. Active account → 'active'
   * 2. Pending approval → 'pending_approval'
   * 3. Pending verification (valid token) → 'pending_verification_valid'
   * 4. Pending verification (expired token) → 'pending_verification_expired'
   * 5. None → 'new'
   */
  async determineEmailState(email) {
    // Check for active account
    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    if (userResult.rows.length > 0) return 'active';

    // Check access_requests for this email
    const requestResult = await pool.query(
      `SELECT email_verified, email_verification_expires_at, status
       FROM access_requests
       WHERE requester_email = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );

    if (requestResult.rows.length > 0) {
      const req = requestResult.rows[0];
      if (req.email_verified && req.status === 'pending') return 'pending_approval';
      if (!req.email_verified) {
        const expiresAt = new Date(req.email_verification_expires_at);
        if (expiresAt > new Date()) return 'pending_verification_valid';
        return 'pending_verification_expired';
      }
    }

    return 'new';
  }

  /**
   * Step 1: Process an email submission. Determines email state and sends
   * the appropriate email. Always returns the same response shape.
   * @param {string} email - normalized email
   * @param {string|null} code - optional sign-up code (raw, no dash)
   * @returns {Promise<{message: string}>}
   */
  async initiateSignup(email, code) {
    const state = await this.determineEmailState(email);

    switch (state) {
      case 'new': {
        const token = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // NOW + 24h

        const insertValues = [
          email,
          token,
          expiresAt,
          false,
          'pending',
          'new_account'
        ];

        let query = `INSERT INTO access_requests
          (requester_email, email_verification_token, email_verification_expires_at, email_verified, status, request_type`;
        let valuePlaceholders = '$1, $2, $3, $4, $5, $6';

        // If code is provided and valid format, store it
        if (code && SignupCodeService.isValidCodeFormat(code)) {
          const normalized = code.replace(/-/g, '').toUpperCase();
          query += ', signup_code_used';
          valuePlaceholders += ', $7';
          insertValues.push(normalized);
        }

        query += `) VALUES (${valuePlaceholders})`;

        await pool.query(query, insertValues);
        await emailService.sendVerificationEmail(email, token, '');
        break;
      }

      case 'pending_verification_valid': {
        // Re-send the same token
        const result = await pool.query(
          `SELECT email_verification_token FROM access_requests
           WHERE requester_email = $1 AND email_verified = false
             AND email_verification_expires_at > NOW()
           ORDER BY created_at DESC LIMIT 1`,
          [email]
        );
        const existingToken = result.rows[0].email_verification_token;
        await emailService.sendVerificationEmail(email, existingToken, '');
        break;
      }

      case 'pending_verification_expired': {
        // Invalidate old token, generate new one
        const newToken = crypto.randomUUID();
        const newExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await pool.query(
          `UPDATE access_requests
           SET email_verification_token = $1, email_verification_expires_at = $2
           WHERE requester_email = $3 AND email_verified = false
             AND email_verification_expires_at <= NOW()`,
          [newToken, newExpiresAt, email]
        );
        await emailService.sendVerificationEmail(email, newToken, '');
        break;
      }

      case 'pending_approval': {
        // Send "still being reviewed" informational email
        try {
          await emailService.sendEmail(email, 'signup_pending_review', {});
        } catch (err) {
          // Template may not exist yet — log and continue gracefully
        }
        break;
      }

      case 'active': {
        // Send "you already have an account" email with password reset link
        try {
          await emailService.sendEmail(email, 'signup_already_active', {
            password_reset_url: process.env.PASSWORD_RESET_URL || ''
          });
        } catch (err) {
          // Template may not exist yet — log and continue gracefully
        }
        break;
      }
    }

    return { message: 'Check your email to continue' };
  }

  /**
   * Get available teams for a verified email.
   * Applies: can_join + code visibility + org domain restrictions.
   * @param {string} token - verification token
   * @param {string|null} code - optional sign-up code from session
   * @returns {Promise<{teams: Array, email: string, codeTeamMessage?: string}>}
   */
  async getAvailableTeams(token, code) {
    // 1. Validate the verification token
    const tokenResult = await pool.query(
      `SELECT id, requester_email, signup_code_used FROM access_requests
       WHERE email_verification_token = $1
         AND email_verification_expires_at > NOW()
         AND email_verified = false
       LIMIT 1`,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      throw new Error('Invalid or expired verification link');
    }

    const row = tokenResult.rows[0];
    const email = row.requester_email;

    // 2. Extract the email domain
    const domain = email.split('@')[1];

    // 3. Determine the effective code to use
    // Use provided code, or fall back to stored code from initiation
    const effectiveCode = code
      ? code.replace(/-/g, '').toUpperCase()
      : (row.signup_code_used || '');

    // 4. Run the team filtering query
    const teamsResult = await pool.query(
      `SELECT t.id, t.name, t.description,
              CASE
                WHEN t.parent_team_id IS NOT NULL THEN
                  COALESCE(org.callsign_prefix, org.name, '') || ' - ' || t.name
                ELSE t.name
              END as display_name
       FROM teams t
       JOIN LATERAL (
           WITH RECURSIVE ancestors AS (
               SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = t.id
               UNION ALL
               SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id
               FROM teams p JOIN ancestors a ON p.id = a.parent_team_id
           )
           SELECT id, name, callsign_prefix FROM ancestors WHERE parent_team_id IS NULL
       ) org ON true
       WHERE t.can_join = true
         AND (
             NOT EXISTS (SELECT 1 FROM signup_codes sc WHERE sc.team_id = t.id)
             OR EXISTS (SELECT 1 FROM signup_codes sc WHERE sc.team_id = t.id AND sc.code = $1)
         )
         AND (
             NOT EXISTS (SELECT 1 FROM org_allowed_domains oad WHERE oad.org_id = org.id)
             OR EXISTS (SELECT 1 FROM org_allowed_domains oad WHERE oad.org_id = org.id AND oad.domain = $2)
         )
       ORDER BY display_name`,
      [effectiveCode, domain]
    );

    const teams = teamsResult.rows;

    // 5. Check if code was provided but team is excluded due to domain restrictions
    let codeTeamMessage;
    if (effectiveCode) {
      // Check if the code resolves to a team
      const codeTeamResult = await pool.query(
        'SELECT team_id FROM signup_codes WHERE code = $1',
        [effectiveCode]
      );

      if (codeTeamResult.rows.length > 0) {
        const codeTeamId = codeTeamResult.rows[0].team_id;
        // Check if the coded team is NOT in the returned list
        const codeTeamInList = teams.some(t => t.id === codeTeamId);
        if (!codeTeamInList) {
          codeTeamMessage = 'The team associated with this code requires an email address from that organisation';
        }
      }
    }

    const result = { teams, email };
    if (codeTeamMessage) {
      result.codeTeamMessage = codeTeamMessage;
    }
    return result;
  }

  /**
   * Step 2: Create an access request for a verified user.
   * Consumes the verification token.
   * @param {Object} data - {token, firstName, lastName, teamId}
   * @returns {Promise<{requestId: number}>}
   */
  async submitTeamAccess({ token, firstName, lastName, teamId }) {
    // 1. Validate the verification token
    const tokenResult = await pool.query(
      `SELECT id, requester_email, signup_code_used FROM access_requests
       WHERE email_verification_token = $1
         AND email_verification_expires_at > NOW()
         AND email_verified = false
       LIMIT 1`,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      throw new Error('Invalid or expired verification link');
    }

    const row = tokenResult.rows[0];
    const email = row.requester_email;
    const accessRequestId = row.id;
    const storedCode = row.signup_code_used || '';

    // 2. Verify the team is eligible (can_join + code/domain checks)
    const domain = email.split('@')[1];
    const eligibilityResult = await pool.query(
      `SELECT t.id
       FROM teams t
       JOIN LATERAL (
           WITH RECURSIVE ancestors AS (
               SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = t.id
               UNION ALL
               SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id
               FROM teams p JOIN ancestors a ON p.id = a.parent_team_id
           )
           SELECT id, name, callsign_prefix FROM ancestors WHERE parent_team_id IS NULL
       ) org ON true
       WHERE t.id = $1
         AND t.can_join = true
         AND (
             NOT EXISTS (SELECT 1 FROM signup_codes sc WHERE sc.team_id = t.id)
             OR EXISTS (SELECT 1 FROM signup_codes sc WHERE sc.team_id = t.id AND sc.code = $2)
         )
         AND (
             NOT EXISTS (SELECT 1 FROM org_allowed_domains oad WHERE oad.org_id = org.id)
             OR EXISTS (SELECT 1 FROM org_allowed_domains oad WHERE oad.org_id = org.id AND oad.domain = $3)
         )`,
      [teamId, storedCode, domain]
    );

    if (eligibilityResult.rows.length === 0) {
      throw new Error('Selected team is not available');
    }

    // 3. Update the access_request row: set name, team, mark email verified (consuming the token)
    await pool.query(
      `UPDATE access_requests
       SET requester_first_name = $1,
           requester_last_name = $2,
           target_team_id = $3,
           email_verified = true
       WHERE id = $4`,
      [firstName, lastName, teamId, accessRequestId]
    );

    return { requestId: accessRequestId };
  }
}

module.exports = SignupFlowService;
