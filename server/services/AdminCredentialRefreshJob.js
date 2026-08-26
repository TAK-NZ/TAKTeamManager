const logger = require('../config/logger').createLogger('AdminCredentialRefreshJob');

/**
 * Admin_Credential_Refresh_Job (device-management Requirements 2.6, 2.7,
 * 2.10 / task 7.1).
 *
 * Requirement 2.6: WHILE Device_Mgmt_Enabled is true, the cached
 * Admin_Credential is refreshed every 24 hours as a scheduled job inside the
 * Sync_Worker process, alongside the existing `ExpiryScheduler` and
 * `RetentionCleanupJob`. This class is that schedule; the actual reload/agent
 * swap lives in `AdminCredentialLoader.refresh()` (Requirement 2.7), which
 * rebuilds the shared `TakServerService` agent so both the
 * `revoke_tak_certificates` handler and the device-management jobs pick up a
 * rotated credential without a process restart (Requirement 2.8).
 *
 * Shape is deliberately identical to `server/services/ExpiryScheduler.js` and
 * `server/services/RetentionCleanupJob.js` (design.md: "each follow the exact
 * `ExpiryScheduler` / `RetentionCleanupJob` shape"): a constructor that clamps
 * an interval from an env var, a `start()` that runs one pass immediately then
 * schedules a recurring `setInterval`, a `stop()` that clears it, both
 * idempotent, and a `run()` that never throws.
 *
 * `start()`'s immediate first pass is not just restart hygiene here (as it is
 * for the other two jobs) -- it is load-bearing: it is what loads the
 * Admin_Credential before the first `SubscriptionPoller`/`DeviceSync` tick,
 * per design.md's "The `AdminCredentialRefreshJob.start()`'s
 * immediate-first-run loads the credential before the first poll/sync tick."
 * `AdminCredentialLoader.refresh()` covers both cases: with nothing cached yet
 * it performs the initial load, and afterwards it reloads and swaps only on
 * change.
 *
 * Secret hygiene (Requirement 2.11): like the Loader, this job never logs
 * credential material or the P12_Passphrase. Its log lines carry only the
 * interval and, on failure, the error the Loader surfaced (which by
 * construction excludes secret values).
 */
class AdminCredentialRefreshJob {
  /**
   * @param {Object} options
   * @param {import('./AdminCredentialLoader')} options.loader the single
   *   shared Admin_Credential_Loader instance (the same one the
   *   `revoke_tak_certificates` handler's `TakServerService` is attached to,
   *   per Requirement 2.8). Required -- unlike `ExpiryScheduler`'s
   *   collaborators there is no safe default, because constructing a second
   *   Loader here would refresh a credential nothing else reads.
   */
  constructor({ loader } = {}) {
    if (!loader) {
      throw new TypeError('AdminCredentialRefreshJob requires a loader');
    }

    this.loader = loader;

    // Requirement 2.6: "every 24 hours" is the stated schedule, so 24 hours
    // is the default. As with `RetentionCleanupJob` (and unlike
    // `ExpiryScheduler`'s hard 15-minute vendor-grant SLA cap), no upper bound
    // is imposed -- requirements.md/design.md state no maximum for this job --
    // while a lower bound guards against a misconfigured near-zero interval
    // turning credential refresh into a tight loop against Secrets Manager
    // (or the filesystem). Clamped in seconds and converted to milliseconds
    // once at the end -- the field stays `intervalMs` because `setInterval`
    // takes milliseconds.
    const MIN_INTERVAL_SECONDS = 60; // 1 minute
    const DEFAULT_INTERVAL_SECONDS = 24 * 60 * 60; // 24 hours

    const intervalSeconds = Math.max(
      MIN_INTERVAL_SECONDS,
      parseInt(process.env.TAK_ADMIN_CERT_REFRESH_INTERVAL_SECONDS, 10) || DEFAULT_INTERVAL_SECONDS
    );
    this.intervalMs = intervalSeconds * 1000;

    this.timer = null;
  }

  /**
   * Starts the job: runs one refresh pass immediately -- which is what loads
   * the Admin_Credential before the first poll/sync tick -- then schedules a
   * recurring pass every `this.intervalMs`. A no-op if already running
   * (mirrors `ExpiryScheduler.start()`/`RetentionCleanupJob.start()`'s
   * idempotency against a double start).
   */
  start() {
    if (this.timer) return;

    logger.info({ intervalMs: this.intervalMs }, 'Admin credential refresh job started');

    // Immediate first pass: loads the credential before the first
    // SubscriptionPoller/DeviceSync tick, and means a freshly-deployed or
    // restarted worker doesn't wait a full 24 hours for its first refresh.
    this.run();

    this.timer = setInterval(() => {
      this.run();
    }, this.intervalMs);
  }

  /**
   * Stops the job, clearing the recurring interval. A no-op if not currently
   * running, so stopping a never-started job (e.g. when Device_Mgmt_Enabled is
   * false and `SyncWorker.stop()` stops it unconditionally) is safe.
   */
  stop() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
    logger.info('Admin credential refresh job stopped');
  }

  /**
   * Runs one refresh pass via `AdminCredentialLoader.refresh()`, which reloads
   * from the configured Credential_Source and, on change, swaps the cached
   * credential and rebuilds the shared mutual-TLS agent (Requirement 2.7).
   *
   * Requirement 2.10: any thrown error is caught and logged via the
   * Structured_Logger rather than propagated, so a failed refresh can never
   * crash or exit the Sync_Worker process; the Loader retains its previously
   * cached credential and the next scheduled tick simply retries. The Loader's
   * own `refresh()` is written not to throw, but this catch is kept
   * unconditionally: `run()` is invoked from a `setInterval` callback, where an
   * unhandled rejection has no caller to observe it.
   *
   * @returns {Promise<void>}
   */
  async run() {
    try {
      await this.loader.refresh();
    } catch (error) {
      logger.error({ err: error }, 'Admin credential refresh run failed');
    }
  }
}

module.exports = AdminCredentialRefreshJob;
