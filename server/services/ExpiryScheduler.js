const VendorChannelService = require('./VendorChannelService');
const DeploymentChannelService = require('./DeploymentChannelService');
const logger = require('../config/logger').createLogger('ExpiryScheduler');

/**
 * Requirement 21.6/22.8 (task 43.1): design.md's closing note on Section
 * 17 calls for `VendorChannelService.expireGrants()` and
 * `DeploymentChannelService.deactivateExpired()` to be "invoked by one
 * shared scheduler (`server/services/ExpiryScheduler.js`) running inside
 * the Sync_Worker process on a `setInterval` no longer than 15 minutes
 * (satisfying both the vendor grant's 15-minute SLA and, run at the same
 * cadence, comfortably inside the deployment channel's 24-hour SLA)."
 *
 * Default interval: exactly 15 minutes (900000ms) -- the tightest SLA
 * this scheduler serves (Requirement 21.6's 15-minute vendor-grant expiry
 * bound). Configurable via `EXPIRY_SCHEDULER_INTERVAL_MS`, clamped to
 * 60000ms (1 minute) - 900000ms (15 minutes) inclusive, following the
 * same `parseInt(...) || <default>` + `Math.min(<max>, Math.max(<min>,
 * ...))` clamp pattern already used for `SYNC_WORKER_BATCH_SIZE`/
 * `SYNC_WORKER_CONCURRENCY` in `server/workers/syncWorker.js`. The upper
 * bound is fixed at 900000ms (rather than left uncapped) because
 * design.md's "no longer than 15 minutes" is a hard requirement on this
 * scheduler's cadence, not merely a default; a lower bound of 60000ms
 * guards against a misconfigured near-zero interval turning this into a
 * tight busy-loop against the database.
 *
 * Lifecycle mirrors `SyncWorker`'s own `start()`/`stop()` shape (a plain
 * `setInterval`/`clearInterval` wrapper, idempotent against a double
 * `start()`), so it can be started/stopped alongside the poll loop and
 * health server in `SyncWorker.start()`/`stop()`.
 *
 * Design decision (not explicitly specified by design.md/requirements.md):
 * `start()` runs one sweep immediately, in addition to scheduling the
 * recurring interval, so a freshly-deployed worker doesn't wait up to 15
 * minutes for its first expiry sweep after a restart/deploy. Every
 * subsequent sweep is then driven purely by the `setInterval` timer.
 */
class ExpiryScheduler {
  constructor({
    vendorChannelService = new VendorChannelService(),
    deploymentChannelService = new DeploymentChannelService()
  } = {}) {
    this.vendorChannelService = vendorChannelService;
    this.deploymentChannelService = deploymentChannelService;

    const MIN_INTERVAL_MS = 60000; // 1 minute
    const MAX_INTERVAL_MS = 900000; // 15 minutes -- design.md's hard SLA cap
    const DEFAULT_INTERVAL_MS = 900000; // 15 minutes

    this.intervalMs = Math.min(
      MAX_INTERVAL_MS,
      Math.max(MIN_INTERVAL_MS, parseInt(process.env.EXPIRY_SCHEDULER_INTERVAL_MS, 10) || DEFAULT_INTERVAL_MS)
    );

    this.timer = null;
  }

  /**
   * Starts the scheduler: runs one sweep immediately, then schedules a
   * recurring sweep every `this.intervalMs`. A no-op if already running
   * (mirrors `SyncWorker.start()`'s/`startHealthServer()`'s idempotency
   * against a double start).
   */
  start() {
    if (this.timer) return;

    logger.info({ intervalMs: this.intervalMs }, 'Expiry scheduler started');

    // Run once immediately so a freshly-deployed/restarted worker doesn't
    // wait up to 15 minutes for its first expiry sweep.
    this.runSweep();

    this.timer = setInterval(() => {
      this.runSweep();
    }, this.intervalMs);
  }

  /**
   * Stops the scheduler, clearing the recurring interval. A no-op if not
   * currently running (mirrors `SyncWorker.stopHealthServer()`'s
   * no-op-when-absent behavior).
   */
  stop() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
    logger.info('Expiry scheduler stopped');
  }

  /**
   * Runs one expiry sweep: invokes `VendorChannelService.expireGrants()`
   * and `DeploymentChannelService.deactivateExpired()` concurrently, via
   * `Promise.allSettled` specifically (rather than `Promise.all`) so a
   * failure in one call never prevents the other from running in this
   * same sweep, or from running again on the next scheduled tick. Any
   * rejection is logged via the structured logger rather than thrown, so
   * a failure here can never crash the Sync_Worker process.
   *
   * @returns {Promise<void>}
   */
  async runSweep() {
    const [vendorResult, deploymentResult] = await Promise.allSettled([
      this.vendorChannelService.expireGrants(),
      this.deploymentChannelService.deactivateExpired()
    ]);

    if (vendorResult.status === 'rejected') {
      logger.error({ err: vendorResult.reason }, 'VendorChannelService.expireGrants() failed during expiry sweep');
    } else {
      logger.debug({ result: vendorResult.value }, 'VendorChannelService.expireGrants() completed');
    }

    if (deploymentResult.status === 'rejected') {
      logger.error(
        { err: deploymentResult.reason },
        'DeploymentChannelService.deactivateExpired() failed during expiry sweep'
      );
    } else {
      logger.debug({ result: deploymentResult.value }, 'DeploymentChannelService.deactivateExpired() completed');
    }
  }
}

module.exports = ExpiryScheduler;
