const pool = require('../config/database');
const logger = require('../config/logger').createLogger('CertExpiryNotificationJob');
const { isCertExpiryNotificationsEnabled } = require('../config/certExpiryNotifications');
const { isDeviceMgmtEnabled } = require('../config/deviceMgmt');
const CertExpiryNotificationService = require('./CertExpiryNotificationService');
const { withJobLock, JOB_LOCK_KEYS } = require('../utils/jobLock');

/**
 * cert-expiry-notifications Requirement 5: runs
 * `CertExpiryNotificationService.run()` once a day, at the local time
 * defined by the EXISTING `DIGEST_HOUR`/`DIGEST_MINUTE`/`DIGEST_TIMEZONE`
 * environment variables `EscalationService.startDailySchedule()` already
 * reads for its own admin-notification digest (default 9:00
 * `Pacific/Auckland`) -- this feature introduces no separate schedule or
 * timezone configuration (Requirement 5.1).
 *
 * Structurally mirrors `RetentionCleanupJob` (`start()`/`stop()`, a plain
 * `setInterval`/`clearInterval` wrapper, idempotent against a double
 * start/stop, every run's error caught and logged, never thrown), but
 * scheduled via `EscalationService`'s once-a-minute
 * hour/minute/timezone-match mechanism rather than a fixed interval --
 * reusing that exact scheduling shape rather than introducing a second
 * implementation of it.
 *
 * `start()` is a no-op (logs and returns) unless BOTH
 * `isCertExpiryNotificationsEnabled()` and `isDeviceMgmtEnabled()` are
 * true (Requirement 5.2, 5.3, 5.4) -- this feature reads `tak_devices`,
 * which only carries meaningful data while device management is enabled,
 * and `CERT_EXPIRY_NOTIFICATIONS_ENABLED='true'` with `DEVICE_MGMT_ENABLED`
 * unset/false is treated as inert: no timer started, no query issued, no
 * email sent.
 *
 * `lastRunDateKey` is a deliberate, documented hardening added on this
 * NEW copy of the digest-scheduling pattern, not applied retroactively to
 * `EscalationService.sendDailyDigests()` itself: `CertExpiryNotificationService
 * .run()`'s per-tier writes are idempotent-but-not-free (an accidental
 * second run inside the same matching minute would needlessly re-batch-
 * query and re-attempt every candidate's send), so this job additionally
 * tracks the `'YYYY-MM-DD'` date key (in the configured timezone) it last
 * ran for, and refuses to run again for that same date key even if the
 * once-a-minute check matches more than once within the same minute
 * window.
 */
class CertExpiryNotificationJob {
  constructor() {
    this.timer = null;
    this.lastRunDateKey = null;
  }

  /**
   * Starts the once-a-minute schedule check. A no-op if already running,
   * and a no-op (logged, not thrown) if either required flag is
   * disabled -- matching this file's own documented gate (Requirement
   * 5.2, 5.3, 5.4).
   */
  start() {
    if (this.timer) return;

    if (!isCertExpiryNotificationsEnabled() || !isDeviceMgmtEnabled()) {
      logger.info(
        'Cert expiry notification job not started (CERT_EXPIRY_NOTIFICATIONS_ENABLED and/or DEVICE_MGMT_ENABLED is not "true")'
      );
      return;
    }

    this.timer = setInterval(() => this.maybeRun(), 60 * 1000);
    logger.info('Cert expiry notification job scheduled');
  }

  /**
   * Stops the once-a-minute schedule check, clearing the interval. A
   * no-op if not currently running.
   */
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info('Cert expiry notification job stopped');
  }

  /**
   * Checked once a minute while running: compares `now`, resolved in the
   * configured `DIGEST_TIMEZONE`, against `DIGEST_HOUR`/`DIGEST_MINUTE`
   * (same defaults as `EscalationService`, read fresh on every tick so a
   * changed `.env` value takes effect without a restart). Runs
   * `CertExpiryNotificationService.run()` on a match, guarded by
   * `lastRunDateKey` so a run cannot fire twice for the same date even if
   * the matching minute is somehow observed more than once.
   */
  maybeRun() {
    const digestHour = parseInt(process.env.DIGEST_HOUR, 10) || 9;
    const digestMinute = parseInt(process.env.DIGEST_MINUTE, 10) || 0;
    const digestTimezone = process.env.DIGEST_TIMEZONE || 'Pacific/Auckland';

    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: digestTimezone }));
    const dateKey = nowInTz.toISOString().slice(0, 10);

    if (
      nowInTz.getHours() === digestHour &&
      nowInTz.getMinutes() === digestMinute &&
      this.lastRunDateKey !== dateKey
    ) {
      // Set the per-process date-key guard BEFORE the async run, unchanged
      // from before: it collapses repeated matching-minute ticks WITHIN this
      // one process. The advisory lock below is the CROSS-process guard added
      // for desiredCount > 1: only the worker that wins the lock actually
      // sends, so two workers observing the same matching minute cannot both
      // send the digest (which would duplicate every recipient's email --
      // CertExpiryNotificationService's dedup row is written only AFTER a
      // successful send, so it cannot prevent a concurrent duplicate send on
      // its own). A worker that does not win the lock skips this tick; the
      // date-key guard means it will not retry until the next day anyway.
      this.lastRunDateKey = dateKey;
      withJobLock(pool, JOB_LOCK_KEYS.CERT_EXPIRY_NOTIFICATION, () =>
        CertExpiryNotificationService.run()
      ).catch((err) => logger.error({ err }, 'Cert expiry notification run failed'));
    }
  }
}

module.exports = CertExpiryNotificationJob;
