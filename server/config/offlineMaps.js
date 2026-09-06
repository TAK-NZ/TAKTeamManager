/**
 * Offline map downloads configuration (server-side only).
 *
 * The offline-maps feature offers large `.mbtiles` files (topographic,
 * marine, vector basemaps) for download to a phone, served via short-lived
 * S3 presigned GetObject URLs from a dedicated, non-public bucket. This
 * module holds the small set of environment-derived values that feature
 * needs: an enablement flag, the bucket name, its region, and the presign
 * lifetime.
 *
 * Every value here is read on the SERVER ONLY. In particular
 * `OFFLINE_MAPS_ENABLED` is a capability flag and is deliberately NOT
 * surfaced through the Public_Config_Endpoint (`GET /api/config/public`):
 * the client discovers the feature by probing `GET /api/offline-maps`
 * (a 200 list vs a 404), never by reading the flag.
 */

/**
 * Offline-maps enablement flag.
 *
 * True ONLY when `OFFLINE_MAPS_ENABLED` is exactly the string `'true'`; an
 * unset, empty, or any-other value (including `'TRUE'`, `' true '`, `'1'`)
 * yields false. Matches the boolean-env convention used by
 * `isDeviceMgmtEnabled`/`isCloudTakEnabled`.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {boolean} true iff `env.OFFLINE_MAPS_ENABLED === 'true'`.
 */
function isOfflineMapsEnabled(env = process.env) {
  return env.OFFLINE_MAPS_ENABLED === 'true';
}

/**
 * The S3 bucket holding the offline map files.
 *
 * Read from `OFFLINE_MAPS_S3_BUCKET`. There is no safe hardcoded default (the
 * bucket name is environment-specific), so an unset/empty value returns
 * `null` and the feature reports itself misconfigured (503) rather than
 * guessing a bucket. In a CDK deployment this value is injected from the
 * base-infra CloudFormation export `TAK-<Stack>-BaseInfra-MapDownloadsBucket`.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {string|null} the configured bucket name, or `null` when unset/empty.
 */
function getOfflineMapsBucket(env = process.env) {
  const bucket = (env.OFFLINE_MAPS_S3_BUCKET || '').trim();
  return bucket.length > 0 ? bucket : null;
}

/**
 * The region the offline-maps bucket lives in.
 *
 * Prefers `OFFLINE_MAPS_S3_REGION` (in case the bucket is not co-located
 * with the rest of the deployment), then the standard `AWS_REGION`, then a
 * final `us-west-2` fallback matching where the bucket is created today.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {string} a non-empty region string.
 */
function getOfflineMapsRegion(env = process.env) {
  return (env.OFFLINE_MAPS_S3_REGION || '').trim()
    || (env.AWS_REGION || '').trim()
    || 'us-west-2';
}

/**
 * Default presign lifetime, in seconds. Five minutes is long enough to
 * START a download and short enough that a leaked URL is stale quickly.
 * Note this bounds only the time to BEGIN the transfer: once S3 has started
 * streaming a response, the expiry no longer applies to that in-flight
 * download, so a multi-hundred-MB file that takes many minutes still
 * completes on a 5-minute presign.
 */
const DEFAULT_URL_TTL_SECONDS = 300;

/**
 * Presigned-URL lifetime in seconds.
 *
 * Reads `OFFLINE_MAPS_URL_TTL_SECONDS` with the codebase's
 * `parseInt(...) || DEFAULT` positive-integer discipline (see
 * `getRevokeMaxCerts`): unset, empty, non-numeric, zero, and negative all
 * fall back to 300 rather than a zero/negative TTL that would produce
 * immediately-expired URLs.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {number} a positive integer number of seconds; 300 when unset/unparseable.
 */
function getOfflineMapsUrlTtlSeconds(env = process.env) {
  return Math.max(1, parseInt(env.OFFLINE_MAPS_URL_TTL_SECONDS, 10) || DEFAULT_URL_TTL_SECONDS);
}

module.exports = {
  isOfflineMapsEnabled,
  getOfflineMapsBucket,
  getOfflineMapsRegion,
  getOfflineMapsUrlTtlSeconds,
  DEFAULT_URL_TTL_SECONDS
};
