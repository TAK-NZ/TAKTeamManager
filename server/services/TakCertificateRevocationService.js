const pool = require('../config/database');
const Team = require('../models/Team');
const EventPublisher = require('./EventPublisher');
const logger = require('../config/logger').createLogger('TakCertificateRevocationService');

/**
 * Thrown by `revokeUserTakCertificates` when the acting user is neither a
 * Global_Manager nor an admin (per `Team.isAdmin`) of the target user's
 * team (Requirement 26.6's "Global_Manager or a team admin"). A
 * 400/403-equivalent client error, not a 500 -- a future route handler
 * (task 48.4's "Do NOT create the HTTP route" scope note explicitly defers
 * that route to a later task) should map this to an HTTP 403 response.
 */
class TakCertificateRevocationAuthorizationError extends Error {
  constructor(message = 'Insufficient authorization to revoke this user\'s TAK Server certificates') {
    super(message);
    this.name = 'TakCertificateRevocationAuthorizationError';
  }
}

/**
 * Thrown by `revokeUserTakCertificates` when `targetUserId` does not
 * reference an existing `users` row, or that row has no `username` (and
 * therefore no resolvable TAK username to revoke certificates for).
 */
class TakCertificateRevocationTargetUserNotFoundError extends Error {
  constructor(targetUserId) {
    super(`User ${targetUserId} was not found or has no username`);
    this.name = 'TakCertificateRevocationTargetUserNotFoundError';
  }
}

/**
 * TakCertificateRevocationService (Requirement 26.6, `design.md` Section
 * 21, task 48.4): implements the "explicit revoke action" enqueue call
 * site -- a Global_Manager or a team admin explicitly revoking a specific
 * user's TAK Server certificates.
 *
 * This service ONLY enqueues the `revoke_tak_certificates` Sync_Operation;
 * it does not call `TakServerService` directly (that happens
 * asynchronously in the Sync_Worker handler implemented separately, task
 * 48.5), and it deliberately does not expose an HTTP route (per this
 * task's explicit scope note: the route would need its own
 * Permission_Registry entry and is left to a future task). The two other
 * Requirement 26.6/26.7 enqueue call sites --
 * `TeamMembershipService.removeUserFromTeam`'s "no teams left" branch and
 * `Team.delete`'s single bulk per-team enqueue -- are implemented directly
 * in those modules rather than here, since each already owns the
 * transactional client and membership data it needs.
 */
class TakCertificateRevocationService {
  /**
   * Requirement 26.6: enqueues a single `revoke_tak_certificates`
   * Sync_Operation for one user's TAK username, after verifying the
   * acting user is authorized to revoke that specific user's
   * certificates.
   *
   * Authorization (per the task's explicit instruction): `Team.isAdmin`
   * of the target user's (direct, non-inherited) team, OR
   * `actingUser.is_global_manager`. Global_Manager is checked first (a
   * plain flag check, no database round trip) before falling back to the
   * `Team.isAdmin` lookup, mirroring the check ordering already used by
   * `DeviceEnrollmentService.assertAuthorized` and `authorize.js`'s
   * row-scoped resolvers.
   *
   * A target user with no current team membership can still be revoked
   * by a Global_Manager (there is no team to check `Team.isAdmin`
   * against), but a non-Global_Manager acting user is rejected in that
   * case, since there is no team admin relationship for them to hold.
   *
   * @param {number|string} targetUserId - the local `users.id` whose TAK
   *   certificates should be revoked.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser
   * @returns {Promise<{queued: true, takUsername: string}>}
   * @throws {TakCertificateRevocationTargetUserNotFoundError}
   * @throws {TakCertificateRevocationAuthorizationError}
   */
  static async revokeUserTakCertificates(targetUserId, actingUser) {
    const userResult = await pool.query('SELECT id, username FROM users WHERE id = $1', [targetUserId]);
    const targetUser = userResult.rows[0];
    if (!targetUser || !targetUser.username) {
      throw new TakCertificateRevocationTargetUserNotFoundError(targetUserId);
    }

    const isGlobalManager = Boolean(actingUser && actingUser.is_global_manager);
    if (!isGlobalManager) {
      const membershipResult = await pool.query(
        'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
        [targetUserId]
      );
      const targetTeamId = membershipResult.rows[0]?.team_id;

      const isTeamAdmin = targetTeamId !== undefined
        && (await Team.isAdmin(targetTeamId, actingUser && actingUser.userId));

      if (!isTeamAdmin) {
        throw new TakCertificateRevocationAuthorizationError();
      }
    }

    await EventPublisher.publishOperation('revoke_tak_certificates', {
      target_user_id: targetUser.id,
      tak_usernames: [targetUser.username]
    }, actingUser && actingUser.userId);

    logger.info(
      { targetUserId: targetUser.id, actingUserId: actingUser && actingUser.userId },
      'Enqueued explicit revoke_tak_certificates operation for user'
    );

    return { queued: true, takUsername: targetUser.username };
  }
}

module.exports = TakCertificateRevocationService;
module.exports.TakCertificateRevocationAuthorizationError = TakCertificateRevocationAuthorizationError;
module.exports.TakCertificateRevocationTargetUserNotFoundError = TakCertificateRevocationTargetUserNotFoundError;
