/**
 * Device management enablement flag (server-side only).
 *
 * `isDeviceMgmtEnabled` derives the Device_Mgmt_Enabled boolean from the
 * `DEVICE_MGMT_ENABLED` environment variable. It is true ONLY when the
 * value is exactly the string `'true'`; an unset, empty, or any-other
 * value (including `'TRUE'`, `' true '`, `'1'`, etc.) yields false. This
 * matches the existing boolean-env convention in this codebase (e.g.
 * `CLOUDTAK_ENABLED === 'true'` in server/config/cloudtak.js).
 *
 * This flag is read on the SERVER ONLY. It is deliberately NOT surfaced
 * through the Public_Config_Endpoint (`GET /api/config/public`) and must
 * never be exposed to the client (Requirement 1.4).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {boolean} true iff `env.DEVICE_MGMT_ENABLED === 'true'`.
 */
function isDeviceMgmtEnabled(env = process.env) {
  return env.DEVICE_MGMT_ENABLED === 'true';
}

/**
 * Device revocation arming flag (server-side only).
 *
 * `isDeviceMgmtRevokeEnabled` derives the Revoke_Enabled boolean from the
 * `DEVICE_MGMT_REVOKE_ENABLED` environment variable, following the same
 * boolean-env convention as `isDeviceMgmtEnabled` above: true ONLY when
 * the value is exactly the string `'true'`; unset, empty, or any other
 * value (including `'TRUE'`, `' true '`, `'1'`) yields false.
 *
 * This is an INDEPENDENT variable with its own default of false. It is
 * NOT derived from, nested under, or defaulted to `DEVICE_MGMT_ENABLED`:
 * turning on device management to LOOK at a device list must not also arm
 * certificate revocation. Both flags must be `'true'` before a revoke is
 * issued; reading Devices (the self-view, the admin view, the
 * Subscription_Poller, the Device_Sync, route reachability) requires only
 * `DEVICE_MGMT_ENABLED` and keeps consulting `isDeviceMgmtEnabled()`
 * alone (Requirement 12.9).
 *
 * This flag is read on the SERVER ONLY. Like `DEVICE_MGMT_ENABLED` it is
 * deliberately NOT surfaced through the Public_Config_Endpoint
 * (`GET /api/config/public`) and must never be exposed to the client.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {boolean} true iff `env.DEVICE_MGMT_REVOKE_ENABLED === 'true'`.
 */
function isDeviceMgmtRevokeEnabled(env = process.env) {
  return env.DEVICE_MGMT_REVOKE_ENABLED === 'true';
}

/**
 * Default Revoke_Blast_Radius_Cap: the maximum number of certificates one
 * Revoke_Operation may target. Chosen to exceed the largest real
 * per-Device certificate count observed on the live TAK Server (60
 * certificates on `ckadmin (ETL)`) so a re-enrollment-heavy Device is not
 * blocked by the rail that exists to catch runaway resolutions
 * (Requirement 12.13).
 */
const DEFAULT_REVOKE_MAX_CERTS = 250;

/**
 * Revoke_Blast_Radius_Cap (server-side only).
 *
 * Reads `DEVICE_MGMT_REVOKE_MAX_CERTS` with a documented default of 250,
 * clamped to a positive integer using the codebase's existing
 * `Math.max(1, parseInt(...) || DEFAULT)` env convention (see
 * `server/services/SubscriptionPoller.js`). An unset, empty,
 * non-numeric, zero, or negative value falls back to a usable positive
 * cap rather than a cap of 0 or a negative one, which would abort every
 * revoke.
 *
 * The cap is checked AFTER the target certificate ids are resolved and
 * BEFORE any `DELETE` is issued; exceeding it aborts the operation. The
 * target set is never truncated to the cap. Server-only, and never
 * surfaced through the Public_Config_Endpoint.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {number} A positive integer cap; 250 when unset or unparseable.
 */
function getRevokeMaxCerts(env = process.env) {
  return Math.max(1, parseInt(env.DEVICE_MGMT_REVOKE_MAX_CERTS, 10) || DEFAULT_REVOKE_MAX_CERTS);
}

/**
 * Default Callsign_Mismatch_Stale_Days: how recently a device must have been
 * seen (`tak_devices.last_seen_at`) for an open, unresolved callsign-mismatch
 * episode to still count as an actionable task on the in-app `/tasks` surface.
 *
 * The `/tasks` callsign-mismatch flag is a STANDING to-do list, so it keeps
 * flagging a mismatch after the device disconnects (the episode latch
 * `callsign_violation_first_seen_at` remains set until the CallsignPoller
 * observes a correction). This window is the counterweight: a device untouched
 * for longer than it is weak evidence that the mismatch is still live -- the
 * user may have corrected it and simply not reconnected -- so it ages out of
 * the task list rather than nagging indefinitely. 7 days lines up with a normal
 * weekly usage cycle: a device used at all in the last week is almost certainly
 * still configured the same way.
 */
const DEFAULT_CALLSIGN_MISMATCH_STALE_DAYS = 7;

/**
 * Callsign_Mismatch_Stale_Days (server-side only).
 *
 * Reads `CALLSIGN_MISMATCH_STALE_DAYS` with a documented default of 7,
 * following the same `parseInt(...) > 0 ? parsed : DEFAULT` convention as
 * `DEVICE_MGMT_EXPIRY_WARNING_DAYS` (see `server/models/SiteConfig.js`): an
 * unset, empty, non-numeric, zero, or negative value falls back to the
 * positive default rather than a window of 0 (which would suppress every task)
 * or a negative one.
 *
 * UNLIKE `DEVICE_MGMT_EXPIRY_WARNING_DAYS`, this value FILTERS a query rather
 * than only affecting how a date is drawn, so it is SERVER-ONLY and must never
 * be surfaced through the Public_Config_Endpoint (`GET /api/config/public`).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {number} A positive integer day count; 7 when unset or unparseable.
 */
function getCallsignMismatchStaleDays(env = process.env) {
  const parsed = parseInt(env.CALLSIGN_MISMATCH_STALE_DAYS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CALLSIGN_MISMATCH_STALE_DAYS;
}

module.exports = {
  isDeviceMgmtEnabled,
  isDeviceMgmtRevokeEnabled,
  getRevokeMaxCerts,
  getCallsignMismatchStaleDays
};
