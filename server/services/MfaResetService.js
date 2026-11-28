'use strict';
const pool = require('../config/database');
const logger = require('../config/logger').createLogger('MfaResetService');
const authentikService = require('./authentik');
const EmailService = require('./EmailService');
/**
 * Reset of a user's MFA by an administrator.
 *
 * For a person who has lost every authenticator they have, or whose device is lost or stolen. The caller (the route)
 * has already checked that the acting administrator may act on this user, and that the administrator confirmed who the
 * person is (a call, or in person: the email on file alone proves nothing, since the person may have lost access to it
 * as well, and the reset only helps if it is the real owner who gets the new link).
 *
 * In this order:
 *   1. The password is replaced with one nobody knows. Without this, the old password would let whoever holds it sign
 *      in on an account with no authenticator and enrol their own.
 *   2. Every passkey, authenticator app and set of recovery codes is deleted.
 *   3. Every session is ended, so a session that was open before the reset does not survive it.
 *   4. A new one-time activation link is made (it opens a new activation window) and emailed to the address on file.
 * The user then sets a password and enrols authenticators again, exactly as on a first sign-in.
 *
 * Every step is repeatable, so a failed run is simply run again. The audit row is written whatever happens after the
 * first change, with the outcome in `details.status`.
 *
 * Refused: the administrator's own account (a second administrator is needed, so that one person cannot clear their own
 * MFA), a team device, an account that is not active, and (unless the administrator is a Global Manager) an Authentik
 * administrator.
 */
class MfaResetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MfaResetError';
    this.status = status;
  }
}
class MfaResetService {
  /**
   * @param {number|string} targetUserId local `users.id`
   * @param {{userId: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<{userId: number, email: string, devicesRemoved: number, sessionsEnded: number}>}
   * @throws {MfaResetError} for a refusal (status 400/403/404) or a step that failed (status 502)
   */
  static async resetMfa(targetUserId, actingUser) {
    const result = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.authentik_user_id, u.is_team_device, u.account_status,
              COALESCE(uc.is_admin, false) AS is_authentik_admin
         FROM users u
         LEFT JOIN user_cache uc ON uc.authentik_id = u.authentik_user_id::text
        WHERE u.id = $1`,
      [targetUserId]
    );
    const target = result.rows[0];
    if (!target) {
      throw new MfaResetError('User not found', 404);
    }
    const actingUserId = actingUser && actingUser.userId;
    if (Number(target.id) === Number(actingUserId)) {
      throw new MfaResetError('You cannot reset your own MFA; ask another administrator', 400);
    }
    if (target.is_team_device) {
      throw new MfaResetError('A team device has no MFA to reset', 400);
    }
    if (target.account_status !== 'active') {
      throw new MfaResetError('Only an active account can have its MFA reset', 400);
    }
    if (!target.authentik_user_id || !target.email) {
      throw new MfaResetError('This account is not linked to a sign-in account with an email address', 400);
    }
    if (target.is_authentik_admin && !(actingUser && actingUser.is_global_manager)) {
      throw new MfaResetError('Only a Global Manager can reset the MFA of an administrator', 403);
    }
    const authentikUserId = target.authentik_user_id;
    const outcome = { status: 'completed', devicesRemoved: 0, devicesFailed: 0, sessionsEnded: 0 };
    let failure = null;
    try {
      await authentikService.invalidateUserPassword(authentikUserId);
      const devices = await authentikService.removeUserAuthenticators(authentikUserId);
      outcome.devicesRemoved = devices.removed.length;
      outcome.devicesFailed = devices.failed.length;
      if (devices.failed.length > 0) {
        throw new Error(`${devices.failed.length} authenticator(s) could not be removed`);
      }
      outcome.sessionsEnded = await authentikService.endUserSessions(authentikUserId);
      await new EmailService().sendMfaResetEmail(
        target.email,
        { firstName: target.first_name, activationUserId: authentikUserId },
        { actorUserId: actingUserId ?? null, targetUserId: target.id }
      );
    } catch (error) {
      failure = error;
      outcome.status = 'incomplete';
      outcome.error = error && error.message ? error.message : String(error);
      logger.error({ err: error, targetUserId: target.id }, 'MFA reset did not complete');
    }
    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [actingUserId ?? null, 'user.mfa_reset', 'user', target.id, JSON.stringify({ email: target.email, ...outcome })]
      );
    } catch (auditError) {
      logger.error({ err: auditError, targetUserId: target.id }, 'Failed to write the MFA reset audit row');
    }
    if (failure) {
      throw new MfaResetError('The MFA reset did not complete; run it again', 502);
    }
    return { userId: target.id, email: target.email, devicesRemoved: outcome.devicesRemoved, sessionsEnded: outcome.sessionsEnded };
  }
}
module.exports = MfaResetService;
module.exports.MfaResetError = MfaResetError;
