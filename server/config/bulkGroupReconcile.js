/**
 * Group-authoritative membership reconciler flags (server-side only).
 *
 * Phase 2 of the Authentik scaling work (see
 * `.kiro/steering/authentik-scaling.md`). The reconciler computes the
 * COMPLETE desired member set of an owned Authentik group from the local
 * database and writes it with a single full-replace group PATCH, replacing
 * the per-user add/remove fan-out. It ships DARK behind these flags.
 *
 * Both are read on the SERVER (and Sync_Worker) ONLY and are never
 * surfaced through the Public_Config_Endpoint. Both follow the codebase's
 * boolean-env convention: true ONLY for the exact string `'true'`
 * (matching `isDeviceMgmtEnabled`/`isCloudTakEnabled`).
 */

/**
 * Master enablement flag for the group-authoritative reconciler.
 *
 * True ONLY when `BULK_GROUP_RECONCILE_ENABLED` is exactly `'true'`. When
 * false (the default), the `reconcile_owned_group` worker handler is an
 * immediate no-op success -- it neither reads the database nor calls
 * Authentik -- so the feature can be shipped and deployed inert, and the
 * enqueue sites can be flipped over (Phase 3) without any effect until
 * this flag is turned on.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
function isBulkGroupReconcileEnabled(env = process.env) {
  return env.BULK_GROUP_RECONCILE_ENABLED === 'true';
}

/**
 * Dry-run gate for the reconciler.
 *
 * DEFAULTS TO TRUE (dry-run ON) and is disabled ONLY by the explicit
 * string `'false'`. This is the deliberate inverse of every other flag in
 * the codebase: the SAFE state here is "compute and log the desired member
 * set, but issue NO Authentik write", so the first time an operator turns
 * `BULK_GROUP_RECONCILE_ENABLED` on, the reconciler observes-only until
 * they have validated the logged diffs against real Authentik state and
 * then explicitly set `BULK_GROUP_RECONCILE_DRY_RUN=false`. This mirrors
 * the certificate-revoke dry-run rail: grant write authority only after
 * the read side has been proven.
 *
 * Any value other than the exact string `'false'` (unset, empty, `'true'`,
 * `'0'`, `'no'`, etc.) leaves dry-run ON. Only `'false'` arms real writes.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean} true iff writes should be SUPPRESSED (dry-run).
 */
function isBulkGroupReconcileDryRun(env = process.env) {
  return env.BULK_GROUP_RECONCILE_DRY_RUN !== 'false';
}

/**
 * Anti-drift sweep enablement flag.
 *
 * True ONLY when `OWNED_GROUP_SWEEP_ENABLED` is exactly `'true'`. The sweep
 * is a periodic worker job that enqueues a `reconcile_owned_group` op for
 * EVERY owned group, so any drift a missed event left behind is corrected.
 * It is separate from `BULK_GROUP_RECONCILE_ENABLED` because it is a
 * different cost profile (a full walk of every owned group), but it is
 * pointless without the reconciler: the worker's `reconcile_owned_group`
 * handler is a no-op while `BULK_GROUP_RECONCILE_ENABLED` is off, so the
 * sweep's caller gates on BOTH.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
function isOwnedGroupSweepEnabled(env = process.env) {
  return env.OWNED_GROUP_SWEEP_ENABLED === 'true';
}

// Default sweep interval and its floor, mirroring the "clamp scheduled-job
// intervals to a 1-minute floor" convention used by ExpiryScheduler/
// SubscriptionPoller/authentikSync. A misconfigured 0/negative would
// otherwise fire the sweep on effectively every tick.
const DEFAULT_SWEEP_INTERVAL_MINUTES = 60;
const MIN_SWEEP_INTERVAL_MINUTES = 1;

/**
 * Minutes between anti-drift sweeps. Read from `OWNED_GROUP_SWEEP_INTERVAL_MINUTES`,
 * floor-clamped to 1, defaulting to 60. A full sweep only ENQUEUES ops
 * (cheap); the rate-limited worker drains them at the configured Authentik
 * write ceiling, so the sweep interval governs how often drift is checked,
 * not how fast Authentik is written.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {number}
 */
function getOwnedGroupSweepIntervalMinutes(env = process.env) {
  return Math.max(
    MIN_SWEEP_INTERVAL_MINUTES,
    parseInt(env.OWNED_GROUP_SWEEP_INTERVAL_MINUTES, 10) || DEFAULT_SWEEP_INTERVAL_MINUTES
  );
}

module.exports = {
  isBulkGroupReconcileEnabled,
  isBulkGroupReconcileDryRun,
  isOwnedGroupSweepEnabled,
  getOwnedGroupSweepIntervalMinutes,
  DEFAULT_SWEEP_INTERVAL_MINUTES
};
