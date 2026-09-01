/**
 * Certificate expiry notification configuration (server-side only).
 *
 * cert-expiry-notifications Requirement 9: every threshold this feature
 * introduces is read through this helper, following the exact
 * boolean-env / positive-integer-with-fallback conventions
 * `server/config/deviceMgmt.js` already establishes.
 */

/**
 * `isCertExpiryNotificationsEnabled` derives the enablement boolean from
 * the `CERT_EXPIRY_NOTIFICATIONS_ENABLED` environment variable. True ONLY
 * when the value is exactly the string `'true'`; an unset, empty, or
 * any-other value (including `'TRUE'`, `' true '`, `'1'`) yields false.
 *
 * This is an INDEPENDENT variable with its own default of false -- it is
 * NOT derived from or defaulted to `DEVICE_MGMT_ENABLED`. Both flags must
 * be `'true'` before the scheduled job actually runs (Requirement 5.2,
 * 5.3); this predicate covers only this feature's own half of that gate.
 *
 * Read on the SERVER ONLY. Deliberately NOT surfaced through
 * `GET /api/config/public` (Requirement 9.4).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {boolean} true iff `env.CERT_EXPIRY_NOTIFICATIONS_ENABLED === 'true'`.
 */
function isCertExpiryNotificationsEnabled(env = process.env) {
  return env.CERT_EXPIRY_NOTIFICATIONS_ENABLED === 'true';
}

/**
 * Documented defaults for the four Cert_Expiry_Tier day-count thresholds
 * (Requirement 9.1).
 */
const DEFAULT_TIER_DAYS = {
  tier1: 30,
  tier2: 15,
  tier3: 8,
  tier4: 1,
};

/**
 * Documented default for the single Cert_Expiry_Activity_Window
 * (Requirement 9.2).
 */
const DEFAULT_ACTIVITY_WINDOW_DAYS = 90;

/**
 * Parses a day-count environment variable to a positive integer, falling
 * back to `defaultValue` when the value is unset, empty, non-numeric,
 * zero, or negative -- the same `Math.max(1, parseInt(...) || default)`
 * discipline `getRevokeMaxCerts` (`server/config/deviceMgmt.js`) already
 * establishes for this codebase's day/count environment variables.
 *
 * @param {string|undefined} rawValue
 * @param {number} defaultValue
 * @returns {number}
 */
function parsePositiveDayCount(rawValue, defaultValue) {
  return Math.max(1, parseInt(rawValue, 10) || defaultValue);
}

/**
 * Reads the four independently configurable Cert_Expiry_Tier day-count
 * thresholds -- `CERT_EXPIRY_TIER1_DAYS` (default 30),
 * `CERT_EXPIRY_TIER2_DAYS` (default 15), `CERT_EXPIRY_TIER3_DAYS`
 * (default 8), `CERT_EXPIRY_TIER4_DAYS` (default 1) -- each falling back
 * to its documented default when unset, empty, non-numeric, zero, or
 * negative (Requirement 9.1).
 *
 * Read on the SERVER ONLY. Deliberately NOT surfaced through
 * `GET /api/config/public` (Requirement 9.4).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {{tier1: number, tier2: number, tier3: number, tier4: number}}
 */
function getCertExpiryTierDays(env = process.env) {
  return {
    tier1: parsePositiveDayCount(env.CERT_EXPIRY_TIER1_DAYS, DEFAULT_TIER_DAYS.tier1),
    tier2: parsePositiveDayCount(env.CERT_EXPIRY_TIER2_DAYS, DEFAULT_TIER_DAYS.tier2),
    tier3: parsePositiveDayCount(env.CERT_EXPIRY_TIER3_DAYS, DEFAULT_TIER_DAYS.tier3),
    tier4: parsePositiveDayCount(env.CERT_EXPIRY_TIER4_DAYS, DEFAULT_TIER_DAYS.tier4),
  };
}

/**
 * Reads the single Cert_Expiry_Activity_Window day count,
 * `CERT_EXPIRY_ACTIVITY_WINDOW_DAYS` (default 90), applied uniformly
 * across all four tiers (Requirement 9.2), with the same fallback
 * discipline as `getCertExpiryTierDays`.
 *
 * Read on the SERVER ONLY. Deliberately NOT surfaced through
 * `GET /api/config/public` (Requirement 9.4).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {number}
 */
function getCertExpiryActivityWindowDays(env = process.env) {
  return parsePositiveDayCount(env.CERT_EXPIRY_ACTIVITY_WINDOW_DAYS, DEFAULT_ACTIVITY_WINDOW_DAYS);
}

module.exports = {
  isCertExpiryNotificationsEnabled,
  getCertExpiryTierDays,
  getCertExpiryActivityWindowDays,
};
