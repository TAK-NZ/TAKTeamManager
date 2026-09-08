'use strict';

/**
 * Periodic anti-drift sweep for owned Authentik group membership
 * (Authentik scaling, Phase 3).
 *
 * On its interval, this job enqueues a `reconcile_owned_group` op for EVERY
 * owned group (all primary team channels, all active BCH read/write groups,
 * all active region groups, and — when CloudTAK is enabled — every team's
 * CloudTAKAgency group). The worker then drains those under the shared rate
 * limiter, recomputing each group's full desired membership and writing it
 * with a single PATCH. This corrects any drift a missed or failed event
 * left behind: the sweep is the source of truth, event-driven reconciles
 * are the latency optimisation (they converge because both compute the same
 * full set).
 *
 * The sweep ONLY enqueues (cheap queue writes); it makes no Authentik call
 * itself, so its interval governs how often drift is checked, not how fast
 * Authentik is written (the rate limiter governs that).
 *
 * Follows the `RetentionCleanupJob` lifecycle shape: constructed
 * unconditionally (no timer, no I/O at construction), with `start()`/
 * `stop()` managing a single `setInterval`. `start()` gates on BOTH
 * `OWNED_GROUP_SWEEP_ENABLED` and `BULK_GROUP_RECONCILE_ENABLED` — a sweep
 * is pointless while the reconcile handler is a no-op, and running one would
 * fill the queue with ops that do nothing. The interval is floor-clamped
 * (see `getOwnedGroupSweepIntervalMinutes`), matching the other scheduled
 * jobs' guard against a misconfigured 0/negative firing every tick.
 */

const logger = require('../config/logger').createLogger('OwnedGroupSweepJob');
const { isCloudTakEnabled } = require('../config/cloudtak');
const {
  isOwnedGroupSweepEnabled,
  isBulkGroupReconcileEnabled,
  getOwnedGroupSweepIntervalMinutes
} = require('../config/bulkGroupReconcile');
const { sweepAllOwnedGroups } = require('./OwnedGroupReconcileEnqueuer');
const pool = require('../config/database');
const { withJobLock, JOB_LOCK_KEYS } = require('../utils/jobLock');

class OwnedGroupSweepJob {
  constructor() {
    this.timer = null;
    this.isSweeping = false;
  }

  /**
   * Run one sweep pass. Guarded by `isSweeping` so an overlapping tick
   * (a previous sweep still enqueueing) collapses to a no-op rather than
   * double-enqueueing. Never throws: a failure is logged and the next
   * interval tick retries, matching the fire-and-forget scheduled-job
   * convention.
   */
  async runOnce() {
    if (this.isSweeping) {
      logger.debug('Owned-group sweep already in progress; skipping this tick');
      return;
    }
    this.isSweeping = true;
    try {
      // `isSweeping` above is the in-PROCESS guard (an overlapping tick within
      // this worker). The advisory lock here is the CROSS-process guard for
      // desiredCount > 1: only the worker that wins the lock enqueues the
      // sweep's reconcile ops this tick. Without it, two workers would each
      // enqueue a full set of `reconcile_owned_group` ops every sweep --
      // double the queue writes, and the drain would then process each group's
      // reconcile twice (idempotent, but pure waste). A worker that does not
      // win the lock skips this tick and retries next interval.
      await withJobLock(pool, JOB_LOCK_KEYS.OWNED_GROUP_SWEEP, async () => {
        const counts = await sweepAllOwnedGroups({ includeCloudTak: isCloudTakEnabled() });
        logger.info({ ...counts }, 'Owned-group anti-drift sweep enqueued reconciles for all owned groups');
      });
    } catch (error) {
      logger.error({ err: error }, 'Owned-group anti-drift sweep failed');
    } finally {
      this.isSweeping = false;
    }
  }

  /**
   * Start the periodic sweep, if enabled. No-op (with a log line) when
   * either flag is off, so a caller can start it unconditionally alongside
   * the other worker jobs.
   */
  start() {
    if (!isOwnedGroupSweepEnabled() || !isBulkGroupReconcileEnabled()) {
      logger.info(
        {
          sweepEnabled: isOwnedGroupSweepEnabled(),
          reconcileEnabled: isBulkGroupReconcileEnabled()
        },
        'Owned-group sweep not started (requires OWNED_GROUP_SWEEP_ENABLED and BULK_GROUP_RECONCILE_ENABLED)'
      );
      return;
    }

    const intervalMinutes = getOwnedGroupSweepIntervalMinutes();
    logger.info({ intervalMinutes }, 'Starting owned-group anti-drift sweep');

    // Fire-and-forget, matching authentikSync's own scheduled-sweep shape:
    // setInterval discards the returned promise, so an explicit .catch()
    // backstop routes any error (outside runOnce's own try/catch) through
    // the structured logger rather than becoming an unhandled rejection.
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => logger.error({ err }, 'Owned-group sweep tick failed'));
    }, intervalMinutes * 60 * 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = OwnedGroupSweepJob;
