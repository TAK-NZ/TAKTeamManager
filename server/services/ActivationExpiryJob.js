'use strict';
const pool = require('../config/database');
const logger = require('../config/logger').createLogger('ActivationExpiryJob');
const { withJobLock, JOB_LOCK_KEYS } = require('../utils/jobLock');
const AccountLifecycleService = require('./AccountLifecycleService');
/**
 * Suspends accounts that were invited but never activated.
 *
 * Team Manager gives every new account a one-time activation link and opens an activation window (7 days) on the
 * Authentik user; the end of that window is mirrored into `users.activation_expires_at` when the link is made (see
 * `EmailService.recordActivationWindow`). An account counts as activated once it has signed in to Authentik, which sync
 * mirrors into `user_cache.last_login`. An account whose window has passed with no sign-in is not activated: Authentik's
 * recovery flow already refuses it, and this job suspends it so that it does not stay active, unused, and without MFA.
 *
 * Deliberately narrow, so that it can never suspend somebody by accident:
 *   - `activation_expires_at IS NOT NULL`: an account with no recorded window (created before the column existed, or
 *     never given a link by Team Manager) is left alone.
 *   - `last_login IS NULL`: any sign-in at all means the person got in.
 *   - `account_status = 'active'`, not a team device.
 *
 * An administrator who unsuspends such an account must also resend the welcome email: that opens a new window and
 * moves `activation_expires_at`, otherwise the next run suspends the account again.
 *
 * Follows the `DailyStatsSnapshotJob` lifecycle: constructed without side effects, `start()` runs once and then on an
 * interval, a single-runner advisory lock covers desiredCount > 1, and nothing is allowed to crash the worker.
 */
class ActivationExpiryJob {
  constructor({ pool: dbPool = pool } = {}) {
    this.pool = dbPool;
    const MIN_INTERVAL_SECONDS = 60;
    const DEFAULT_INTERVAL_SECONDS = 60 * 60;
    const intervalSeconds = Math.max(
      MIN_INTERVAL_SECONDS,
      parseInt(process.env.ACTIVATION_EXPIRY_INTERVAL_SECONDS, 10) || DEFAULT_INTERVAL_SECONDS
    );
    this.intervalMs = intervalSeconds * 1000;
    this.timer = null;
  }
  start() {
    if (this.timer) return;
    logger.info({ intervalMs: this.intervalMs }, 'Activation expiry job started');
    this.runOnce();
    this.timer = setInterval(() => {
      this.runOnce();
    }, this.intervalMs);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('Activation expiry job stopped');
  }
  async runOnce() {
    try {
      await withJobLock(this.pool, JOB_LOCK_KEYS.ACTIVATION_EXPIRY, async () => {
        const result = await this.suspendExpired();
        if (result.found > 0) {
          logger.info(result, 'Activation expiry run completed');
        }
      });
    } catch (error) {
      logger.error({ err: error }, 'Activation expiry run failed');
    }
  }
  /**
   * @returns {Promise<{found: number, suspended: number, failed: number}>}
   */
  async suspendExpired() {
    const candidates = await this.pool.query(
      `SELECT u.id, u.activation_expires_at
         FROM users u
         LEFT JOIN user_cache uc ON uc.authentik_id = u.authentik_user_id::text
        WHERE u.account_status = 'active'
          AND u.is_team_device = false
          AND u.activation_expires_at IS NOT NULL
          AND u.activation_expires_at < now()
          AND u.authentik_user_id IS NOT NULL
          AND uc.authentik_id IS NOT NULL
          AND uc.last_login IS NULL
        ORDER BY u.id`
    );
    let suspended = 0;
    let failed = 0;
    for (const row of candidates.rows) {
      try {
        // No acting user: the audit rows below carry a null user_id, which is how a system action is recorded.
        await AccountLifecycleService.suspendAccount(row.id, { userId: null });
        suspended += 1;
        await this.recordReason(row);
      } catch (error) {
        failed += 1;
        logger.error({ err: error, userId: row.id }, 'Could not suspend an account whose activation window has passed');
      }
    }
    return { found: candidates.rows.length, suspended, failed };
  }
  async recordReason(row) {
    try {
      await this.pool.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
         VALUES (NULL, 'user.activation_expired', 'user', $1, $2)`,
        [row.id, JSON.stringify({ activationExpiresAt: row.activation_expires_at })]
      );
    } catch (error) {
      logger.error({ err: error, userId: row.id }, 'Failed to write the audit row for an expired activation');
    }
  }
}
module.exports = ActivationExpiryJob;
