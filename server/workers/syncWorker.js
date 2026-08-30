// Requirement 15.2/6.4: validate required configuration before doing
// anything else, so a misconfigured environment -- or, when
// NODE_ENV=production, an unreachable secrets manager -- fails fast
// (before the poll loop starts) instead of failing obscurely partway
// through processing an operation. `validateConfig` is async (the
// production secrets-manager gate makes an external call); see the
// `require.main === module` block at the bottom of this file for where it
// is awaited before `worker.start()` is called.
const { validateConfig } = require('../config/configValidator');

const { Pool } = require('pg');
const http = require('http');
// Feature device-management, Requirement 12.14 (task 24.3): `createHash` backs
// the Revoke_Audit_Record's `targetCertIdsDigest` -- a stable digest of the
// sorted target certificate id list, so two runs can be compared (and a
// truncated log line detected) without the full list.
const crypto = require('crypto');
const pLimit = require('p-limit');
const authentikService = require('../services/authentik');
const TeamMembershipService = require('../services/TeamMembershipService');
// region-channel-tiers: resolves a user's Organisation (Ancestor_Chain
// index 0) to read response_channel_access/support_channel_access, in
// assignUserToGlobalChannels and the resync_org_channel_tier_access handler.
const Team = require('../models/Team');
// region-channel-tiers: resync_org_channel_tier_access fans out one
// assign_user_to_global_channels operation per affected user, mirroring
// GlobalChannelService.assignAllUsersToGlobalChannels's own enqueue shape
// (bulk_operations progress record + one EventPublisher.publishOperation
// call per user).
const EventPublisher = require('../services/EventPublisher');
const { computeBackoffDelay } = require('./backoff');
// Requirement 10.2/10.5 (task 30.2): partitions a fetched batch into
// same-entity "lanes" (keyed by `target_user_id:target_group_id`, falling
// back to the operation's own id) so that same-entity operations are
// routed onto the same p-limit-bounded concurrency slot and execute
// strictly sequentially and in original fetch order relative to each
// other, while distinct-key lanes run concurrently through the worker
// pool. See `processNextOperation`'s tail, below.
const { groupByEntityKey } = require('./entityGrouping');
// Requirement 9.3: per-`operation_type` required/optional field-and-type
// map, checked by `validatePayloadSchema` before `executeOperation`
// dispatches to a handler.
const operationSchemas = require('./operationSchemas');
// region-channel-tiers: maps a region_channels.tier value ('response'/
// 'support') to its Authentik group-name prefix (tak_Response.../
// tak_Support...). Single source of truth shared with
// GlobalChannelService.js -- see that constant's own doc comment in
// server/config/constants.js.
const { REGION_CHANNEL_TIER_PREFIX, BCH_CHANNEL_CATEGORY_PREFIX } = require('../config/constants');
// Requirement 9.6/task 28.2: classifies a non-2xx Authentik API response
// (or a caught network/timeout error) as 'retryable' or 'permanent', so
// each Authentik-calling handler below can decide whether to let the
// failure flow through the normal retry-scheduling path or bypass it
// entirely via `markPermanentlyFailed`.
const { classifyFailure } = require('./failureClassification');
// Requirement 9.5/13.6: structured, level-gated logging for
// `executeOperation` and its dispatched handlers, replacing the raw
// `console.log`/`console.error` calls that previously printed full
// operation payloads and Authentik request/response bodies. See the
// `createLogger` import pattern already established in
// `GlobalChannelService.js`/`authentikSync.js`.
const logger = require('../config/logger').createLogger('syncWorker');
// Requirement 21.6/22.8 (task 43.1): the shared periodic sweep invoking
// `VendorChannelService.expireGrants()` and
// `DeploymentChannelService.deactivateExpired()`, started/stopped
// alongside the poll loop and health server below (see `start()`/
// `stop()`), per design.md's closing note on Section 17.
const ExpiryScheduler = require('../services/ExpiryScheduler');
// Requirement 25 (task 47.1): the Retention_Cleanup_Job, running on its
// own scheduled interval (default 24h) inside the Sync_Worker process,
// started/stopped alongside the poll loop, health server, and expiry
// scheduler below (see `start()`/`stop()`), per design.md's Section 20.
const RetentionCleanupJob = require('../services/RetentionCleanupJob');
// Requirement 26.3/26.4/26.5/26.8 (task 48.5): the TAK Server Marti
// `certadmin` API client used by `revokeTakCertificates` below, and its
// exported `matchesCreatorDn` predicate -- reused here (rather than
// calling `findCertificatesForUser` once per username) so this handler
// can fetch `listCertificates()` exactly once per operation and filter
// that single result against every `tak_usernames` entry, per task 48.4's
// "single bulk batch fetching the certificate catalog once" design intent.
// Feature device-management, Requirement 12.1 (task 19.3): `matchesCreatorDn`
// is for the USER-scoped payload shape only. The device-scoped shape resolves by
// `clientUid` against `listLiveCertificates()` instead, because distinct Devices
// share a `creatorDn` and matching on it revoked every certificate the user held
// across all their Devices.
const TakServerService = require('../services/TakServerService');
const { matchesCreatorDn } = TakServerService;
// Feature device-management (task 8.1): the Admin_Credential_Loader and the
// three scheduled device-management jobs, all constructed in the `SyncWorker`
// constructor below around the SINGLE shared `this.takServerService` instance
// so the `revoke_tak_certificates` handler and the device-management jobs use
// one credential mechanism and both pick up a rotated Admin_Credential without
// a process restart (Requirement 2.8). Constructed unconditionally (like
// `this.expiryScheduler`/`this.retentionCleanupJob`) -- constructing them opens
// no timer, reads no secret, and makes no network call; the
// `isDeviceMgmtEnabled()` gate lives on the `start()` calls (task 8.2).
// Feature device-management, Requirements 12.11/12.13 (task 24.3):
// `isDeviceMgmtRevokeEnabled` is the INDEPENDENT arming flag consulted by
// `revokeTakCertificates` before any `DELETE` (a disarmed revoke completes as a
// Revoke_Dry_Run), and `getRevokeMaxCerts` is the Revoke_Blast_Radius_Cap
// checked against the resolved target count. Both are read per call, so the
// production predicates stay in the loop rather than being snapshotted at
// require time.
const {
  isDeviceMgmtEnabled,
  isDeviceMgmtRevokeEnabled,
  getRevokeMaxCerts
} = require('../config/deviceMgmt');
const AdminCredentialLoader = require('../services/AdminCredentialLoader');
const AdminCredentialRefreshJob = require('../services/AdminCredentialRefreshJob');
const SubscriptionPoller = require('../services/SubscriptionPoller');
const DeviceSync = require('../services/DeviceSync');
// Feature cloudtak-agency-groups (tasks 4.1/4.2): the pure CloudTAK
// helpers -- `groupName(teamId)` (`CloudTAKAgency<id>`),
// `agencyAttributes(team)` (the three Agency_Attributes), and
// `getDirectAdmins(teamId, client?)` (the Direct_Admin_Set resolver) --
// used by the `createCloudTakGroup`/`updateCloudTakGroup`/
// `deleteCloudTakGroup` handlers below. `computeMembershipDiff` is the
// pure add/remove diff extracted for the membership reconcile (also
// property-tested).
const {
  groupName,
  agencyAttributes,
  getDirectAdmins,
  computeMembershipDiff
} = require('../services/CloudTakAgencyGroup');

/**
 * Requirement 9.4: thrown by `executeOperation` when a payload fails
 * schema validation, after `markPermanentlyFailed` has already written
 * the operation's terminal `failed`/`failure_category='validation'`
 * state to the database. `executeOperationSafely`'s `catch` block checks
 * `error.alreadyHandled` and, when true, skips calling
 * `handleOperationError` entirely -- since that method's job is to
 * increment `retry_count` and schedule (or exhaust) a retry, and this
 * path must never do either, "under any circumstance" (Requirement 9.4).
 */
class PayloadValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PayloadValidationError';
    this.alreadyHandled = true;
  }
}

/**
 * Requirement 9.6/task 28.2: thrown by an Authentik-calling handler
 * (`addUserToGroup`, `createBchChannelGroups`, etc.) in place of a plain
 * `Error` whenever it receives a non-2xx response or catches a
 * network/timeout error from `fetch()`. `classification` is the result of
 * `classifyFailure(statusOrError)` -- either `'retryable'` or
 * `'permanent'` -- and is inspected centrally by
 * `executeOperationSafely`'s catch-handling block: a `'permanent'`
 * classification calls `markPermanentlyFailed` directly (bypassing
 * `handleOperationError`, mirroring the `PayloadValidationError`/
 * `alreadyHandled` pattern above but triggered from a handler's classified
 * error rather than from `executeOperation`'s own validation step); a
 * `'retryable'` classification is left to fall through to the existing,
 * unchanged `handleOperationError` retry-scheduling path, exactly like any
 * other unclassified error today.
 */
class AuthentikApiError extends Error {
  constructor(message, classification) {
    super(message);
    this.name = 'AuthentikApiError';
    this.classification = classification;
  }
}

/**
 * Requirement 26.8 (task 48.5): the TAK Server analogue of
 * `AuthentikApiError`, thrown by `revokeTakCertificates` whenever
 * `TakServerService`'s underlying axios call throws -- either a
 * non-2xx HTTP status from TAK Server's Marti `certadmin` API (classified
 * via `classifyFailure(error.response.status)`) or a network/timeout
 * error with no response at all (classified via
 * `classifyFailure(error)`, which treats any `Error` instance as
 * retryable). A dedicated class (rather than reusing `AuthentikApiError`)
 * keeps the error's `name`/log output honest about which upstream system
 * actually failed, while `executeOperationSafely`'s classification check
 * below inspects both classes identically via their shared
 * `classification` field.
 */
class TakServerApiError extends Error {
  constructor(message, classification) {
    super(message);
    this.name = 'TakServerApiError';
    this.classification = classification;
  }
}

/**
 * Feature device-management, Requirements 12.12/12.13 (task 24.3): thrown by
 * `revokeTakCertificates` when one of the revocation rails refuses the
 * operation BEFORE any `DELETE` is issued -- a resolved target set spanning
 * more than one `client_uid`, or a resolved count over the
 * Revoke_Blast_Radius_Cap.
 *
 * Both are defects of the RESOLUTION rather than transient upstream failures,
 * so neither can be fixed by re-running the identical operation: the rail is a
 * refusal, and a retried refusal is just the same refusal 48 more times against
 * a shared TAK Server. This therefore reuses the existing `alreadyHandled`
 * contract rather than inventing a second signalling mechanism -- exactly like
 * `PayloadValidationError` above, `revokeTakCertificates` calls
 * `markPermanentlyFailed` itself (writing the terminal
 * `failed`/`failure_category='permanent'` row) and then throws this, whose
 * `alreadyHandled` tells `executeOperationSafely` to skip
 * `handleOperationError` so `retry_count`/`next_retry_at` are never touched on
 * top of that terminal state.
 *
 * `alreadyHandled` is false in the one case where no terminal state COULD be
 * written: a direct `worker.revokeTakCertificates(payload)` call with no
 * `operation` row behind it (unit tests, and any future non-queued caller).
 * Then this is just a rejected promise the caller sees, and the refusal is
 * still visible in the `revoke_abort` log line either way.
 */
class RevokeRailAbortError extends Error {
  constructor(message, { alreadyHandled = true } = {}) {
    super(message);
    this.name = 'RevokeRailAbortError';
    this.alreadyHandled = alreadyHandled;
  }
}

/**
 * Feature device-management, Requirement 12.14 (task 24.3): the canonical order
 * of a resolved target certificate id set -- ascending numeric, with a string
 * tiebreak so a non-numeric id can never make the order (and therefore the
 * digest) depend on iteration order.
 *
 * The same array is what gets logged in `targetCertIds`, what the digest is
 * computed over, and what is handed to `revokeCertificates`, so all three agree
 * and a shortened id list is detectable by comparing them.
 *
 * @param {Set<number>|Array<number>} certIds
 * @returns {Array<number>} a new, sorted array.
 */
function sortCertIds(certIds) {
  return Array.from(certIds).sort(
    (a, b) => (Number(a) - Number(b)) || String(a).localeCompare(String(b))
  );
}

/**
 * Feature device-management, Requirement 12.14 (task 24.3): a stable digest of
 * the sorted target certificate id list, logged alongside the count so two runs
 * can be compared -- and a truncated or reordered list spotted -- without the
 * full list in hand.
 *
 * Stable means: the same SET of ids always digests to the same value regardless
 * of the order they were resolved in (hence `sortCertIds` first), and the value
 * is reproducible by anyone hashing the sorted, comma-joined ids. SHA-256 is
 * used as a content fingerprint only -- there is no secret here and nothing
 * about this is a security boundary.
 *
 * @param {Array<number>} sortedCertIds ids already in `sortCertIds` order.
 * @returns {string} a hex SHA-256 digest.
 */
function revokeTargetDigest(sortedCertIds) {
  return crypto.createHash('sha256').update(sortedCertIds.join(',')).digest('hex');
}

/**
 * Feature device-management, Requirements 12.2/12.3 (task 19.3): reads the
 * `revoke_tak_certificates` payload discriminator, in ONE place.
 *
 * Two collaborators need the shape and MUST agree on it: the fetch
 * (`fetchRevokeResolutionInputs`, which reads a DIFFERENT certificate view per
 * shape) and the resolution (`resolveRevokeTargets`, which matches a different
 * field per shape). Deciding it twice is how they would come to disagree, and a
 * disagreement here means resolving a device-scoped target set out of the
 * user-scoped catalog -- i.e. re-targeting already-revoked ids.
 *
 * `validatePayloadSchema`'s `exactlyOneOf` has already rejected a payload
 * carrying both discriminators or neither (task 19.2), so the presence of
 * `client_uid` is unambiguous by the time either caller runs.
 *
 * @param {object} payload the parsed `revoke_tak_certificates` payload.
 * @returns {'client_uid'|'tak_usernames'} the payload shape.
 */
function revokePayloadShape(payload) {
  return payload.client_uid !== undefined ? 'client_uid' : 'tak_usernames';
}

// Requirement 14.6: the heartbeat is considered stale (and the health
// endpoint returns 503) once it is 90 seconds old or older.
const HEARTBEAT_STALE_THRESHOLD_MS = 90000;

/**
 * Requirement 14.6/task 34.4: queries the single `sync_worker_heartbeat`
 * row's `last_heartbeat_at` and determines liveness by comparing it
 * against `HEARTBEAT_STALE_THRESHOLD_MS` (90 seconds). Extracted as a
 * standalone function (rather than an inline handler body) so it can be
 * unit-tested directly against a mocked `pool.query`, mirroring
 * `server/routes/health.js`'s exported `checkDatabaseConnectivity`/
 * `checkAuthentikReachability` helpers.
 *
 * @param {import('pg').Pool} pool - the pool to query against.
 * @returns {Promise<{healthy: boolean, body: object}>}
 */
async function checkSyncWorkerHeartbeatHealth(pool) {
  let result;
  try {
    result = await pool.query('SELECT last_heartbeat_at FROM sync_worker_heartbeat WHERE id = 1');
  } catch (error) {
    logger.error({ err: error }, 'Sync worker heartbeat query failed');
    return {
      healthy: false,
      body: { status: 'unhealthy', reason: 'Heartbeat query failed' }
    };
  }

  const row = result.rows[0];
  if (!row || !row.last_heartbeat_at) {
    return {
      healthy: false,
      body: { status: 'unhealthy', reason: 'No heartbeat recorded yet' }
    };
  }

  const lastHeartbeatAt = new Date(row.last_heartbeat_at);
  const ageMs = Date.now() - lastHeartbeatAt.getTime();

  if (Number.isNaN(ageMs) || ageMs >= HEARTBEAT_STALE_THRESHOLD_MS) {
    return {
      healthy: false,
      body: { status: 'unhealthy', reason: 'Heartbeat is stale', lastHeartbeatAt: row.last_heartbeat_at }
    };
  }

  return {
    healthy: true,
    body: { status: 'healthy', lastHeartbeatAt: row.last_heartbeat_at }
  };
}

class SyncWorker {
  constructor() {
    this.isRunning = false;
    this.pollInterval = 5000; // 5 seconds
    this.maxRetries = 3;
    this.retryDelay = 1000; // 1 second
    // Requirement 10.1: configurable per-cycle batch size for the
    // pending-operation fetch query (replacing the old single-row
    // `LIMIT 1`), clamped to the 10-500 range and defaulting to 50,
    // following the same `parseInt(...) || <default>` pattern already
    // used for DB_POOL_MAX in server/config/database.js, with an
    // explicit Math.min/Math.max clamp since this variable also has an
    // upper bound.
    this.batchSize = Math.min(500, Math.max(10, parseInt(process.env.SYNC_WORKER_BATCH_SIZE, 10) || 50));
    // Requirement 10.3: configurable bounded concurrency for routing a
    // fetched batch's same-entity lanes (see `groupByEntityKey`) through a
    // `p-limit` worker pool. Clamped to the 1-100 range and defaulting to
    // 10, following the same `Math.min(<max>, Math.max(<min>, parseInt(...)
    // || <default>))` clamp pattern already used for `this.batchSize`
    // above and for `getAuthentikSyncConcurrency()` in
    // `server/services/authentikSync.js`. This is independent of
    // `this.batchSize`: concurrency MAY be set lower than the batch size,
    // in which case excess same-cycle lanes queue behind the `p-limit`
    // semaphore and are drained within the same cycle rather than
    // deferred to the next poll.
    this.concurrency = Math.min(100, Math.max(1, parseInt(process.env.SYNC_WORKER_CONCURRENCY, 10) || 10));
    
    // Create dedicated connection pool for worker
    this.pool = new Pool({
      host: process.env.DB_HOST || 'postgres',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'tak_team_manager',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      max: 5, // Maximum pool size
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    
    // Handle pool errors
    this.pool.on('error', (err) => {
      logger.error({ err }, 'Database pool error');
    });

    // Requirement 14.6/task 34.4: the lightweight `http.createServer`
    // health server is created lazily in `start()` (not here in the
    // constructor) so that constructing a `SyncWorker` instance in a test
    // never binds a real port; see `start()`/`stop()` below.
    this.healthServer = null;
    // Requirement 14.6: default to port 3001 if unset/non-numeric. Uses an
    // explicit NaN check (rather than `parseInt(...) || 3001`) so that an
    // explicitly configured port 0 (used by tests to bind an OS-assigned
    // ephemeral port) is respected instead of being treated as falsy and
    // silently overridden by the default.
    const parsedHealthPort = parseInt(process.env.SYNC_WORKER_HEALTH_PORT, 10);
    this.healthPort = Number.isNaN(parsedHealthPort) ? 3001 : parsedHealthPort;

    // Requirement 21.6/22.8 (task 43.1): the shared vendor-grant/
    // deployment-channel expiry scheduler, started/stopped alongside the
    // poll loop and health server (see `start()`/`stop()` below).
    this.expiryScheduler = new ExpiryScheduler();

    // Requirement 25 (task 47.1): the sync_operations/audit_logs
    // Retention_Cleanup_Job, started/stopped alongside the poll loop,
    // health server, and expiry scheduler (see `start()`/`stop()` below).
    this.retentionCleanupJob = new RetentionCleanupJob();

    // Requirement 26.3/26.4/26.5 (task 48.5): constructed once here
    // (mirroring `this.expiryScheduler`/`this.retentionCleanupJob` above)
    // rather than per-operation, since `TakServerService`'s constructor
    // reads `TAK_SERVER_URL`/mTLS credential env vars and builds an
    // `https.Agent` once at construction time -- there is no benefit to
    // re-reading those files/env vars on every `revoke_tak_certificates`
    // operation, and constructing it here keeps this handler's shape
    // consistent with the worker's other long-lived collaborators. Safe
    // to construct unconditionally even when `TAK_SERVER_URL` is unset:
    // `buildMutualTlsAgentOptions` only reads credential files when their
    // corresponding env vars are actually present, and no network call is
    // made until a `revoke_tak_certificates` operation is actually
    // dispatched to `revokeTakCertificates` below.
    this.takServerService = new TakServerService();

    // Feature device-management, Requirement 2.8 (task 8.1): ONE
    // Admin_Credential_Loader, built around the same `this.takServerService`
    // instance the `revoke_tak_certificates` handler uses, so revocation and
    // device-management share one credential mechanism.
    this.adminCredentialLoader = new AdminCredentialLoader({
      takServerService: this.takServerService
    });

    // Requirement 2.7/2.8: register the Loader on the shared service so
    // `refreshAgent()` pulls the current Admin_Credential from it (rather than
    // re-deriving file/environment values). This is done after construction --
    // not via `new TakServerService(env, { credentialLoader })` -- because the
    // Loader itself takes the service as a constructor argument, so passing it
    // to the constructor would be a construction-order cycle; see
    // `TakServerService.setCredentialLoader`'s own note.
    this.takServerService.setCredentialLoader(this.adminCredentialLoader);

    // Requirement 2.6/3.1/4.8 (task 8.1): the three device-management jobs,
    // each following the same `ExpiryScheduler`/`RetentionCleanupJob` shape as
    // the schedulers above. The refresh job drives the shared Loader; the
    // poller and the sync take the shared `TakServerService`, so a refreshed
    // credential applies to their Marti calls too. They are started (guarded by
    // `isDeviceMgmtEnabled()`) and stopped in `start()`/`stop()`.
    this.adminCredentialRefreshJob = new AdminCredentialRefreshJob({
      loader: this.adminCredentialLoader
    });
    this.subscriptionPoller = new SubscriptionPoller({
      takServerService: this.takServerService
    });
    this.deviceSync = new DeviceSync({
      takServerService: this.takServerService
    });
  }

  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    logger.info('Sync worker started');

    // Requirement 14.6/task 34.4: start the lightweight heartbeat health
    // server alongside the poll loop, so an external health check (e.g.
    // an ECS/Docker health check probe) can observe whether this worker
    // process's poll loop is still alive.
    this.startHealthServer();

    // Requirement 21.6/22.8 (task 43.1): start the shared expiry
    // scheduler alongside the poll loop and health server, so vendor
    // channel grant expiry and deployment channel deactivation are swept
    // on their own <=15-minute cadence independent of the poll loop.
    this.expiryScheduler.start();

    // Requirement 25 (task 47.1): start the retention cleanup job
    // alongside the poll loop, health server, and expiry scheduler, so
    // sync_operations/audit_logs retention cleanup runs on its own
    // (default 24h) cadence independent of the poll loop.
    this.retentionCleanupJob.start();

    // Feature device-management, Requirements 1.5/1.6/1.7/9.5 (task 8.2):
    // the three device-management jobs are started ONLY when
    // Device_Mgmt_Enabled is true. This single gate is what makes the whole
    // background half of the feature inert when the flag is off: no
    // Admin_Credential is loaded or refreshed (1.5), the Subscriptions_API is
    // never called (1.6), and Active_Certificates are never fetched nor the
    // Device_Table written (1.7) -- all four background concerns disabled
    // together, never some-on/some-off (9.5).
    //
    // Order matters: `AdminCredentialRefreshJob.start()` runs its first
    // refresh immediately, so the Admin_Credential is loaded before the
    // poller's and the sync's first tick.
    if (isDeviceMgmtEnabled()) {
      this.adminCredentialRefreshJob.start();
      this.subscriptionPoller.start();
      this.deviceSync.start();
    }

    while (this.isRunning) {
      try {
        await this.processNextOperation();
        // Requirement 14.6: update the heartbeat at the END of every poll
        // cycle -- after `processNextOperation()` completes, whether it
        // found work or not -- so the heartbeat reflects "the worker is
        // alive and looping" rather than "the worker's last operation
        // succeeded". A failure writing the heartbeat is logged but never
        // allowed to crash the poll loop, mirroring the existing
        // catch-and-continue pattern already used elsewhere in this loop.
        await this.updateHeartbeat();
        await this.sleep(this.pollInterval);
      } catch (error) {
        logger.error({ err: error }, 'Worker loop error');
        
        // If it's a database connection error, wait longer before retrying
        if (error.message.includes('connection') || error.message.includes('database')) {
          logger.info('Database connection issue detected, waiting 30 seconds before retry');
          await this.sleep(30000); // 30 seconds
        } else {
          await this.sleep(this.pollInterval);
        }
      }
    }
  }

  async stop() {
    this.isRunning = false;
    logger.info('Sync worker stopping...');

    await this.stopHealthServer();

    // Requirement 21.6/22.8 (task 43.1): stop the shared expiry scheduler
    // alongside the health server.
    this.expiryScheduler.stop();

    // Requirement 25 (task 47.1): stop the retention cleanup job
    // alongside the expiry scheduler and health server.
    this.retentionCleanupJob.stop();

    // Feature device-management (task 8.2): stopped UNCONDITIONALLY -- i.e.
    // without re-checking `isDeviceMgmtEnabled()`. Each job's `stop()` is
    // idempotent (a no-op when no timer is running), so stopping jobs that
    // were never started is safe, and this also guarantees a clean shutdown if
    // the flag were somehow read differently at stop time than at start time.
    this.adminCredentialRefreshJob.stop();
    this.subscriptionPoller.stop();
    this.deviceSync.stop();

    try {
      await this.pool.end();
      logger.info('Database pool closed');
    } catch (error) {
      logger.error({ err: error }, 'Error closing database pool');
    }
  }

  /**
   * Requirement 14.6/task 34.4: upserts the single `sync_worker_heartbeat`
   * row (id fixed at 1) with `last_heartbeat_at = NOW()`, using
   * `INSERT ... ON CONFLICT (id) DO UPDATE` so the very first call creates
   * the row and every subsequent call updates it in place -- the
   * "single-row upsert table" pattern the migration's CHECK constraint
   * enforces. Uses `this.pool` directly (not a transactional client),
   * since this write has no relationship to the batch-fetch transaction
   * in `processNextOperation` and must succeed independently of whether
   * that cycle found any pending operations.
   *
   * A failure here is logged and swallowed rather than re-thrown, so a
   * transient DB error updating the heartbeat can never crash the poll
   * loop or be mistaken for a "Worker loop error" that triggers the
   * longer 30-second backoff sleep.
   */
  async updateHeartbeat() {
    try {
      await this.pool.query(
        `INSERT INTO sync_worker_heartbeat (id, last_heartbeat_at, worker_id)
         VALUES (1, NOW(), $1)
         ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = NOW(), worker_id = $1`,
        [String(process.pid)]
      );
    } catch (error) {
      logger.error({ err: error }, 'Failed to update sync worker heartbeat');
    }
  }

  /**
   * Requirement 14.6/task 34.4: starts a lightweight `http.createServer`
   * (plain Node `http` module -- no Express/framework dependency) on
   * `SYNC_WORKER_HEALTH_PORT` (default 3001, see the constructor). Any
   * GET request to this server queries the single `sync_worker_heartbeat`
   * row's `last_heartbeat_at` and responds:
   * - 200 `{status: 'healthy', lastHeartbeatAt}` when
   *   `NOW() - last_heartbeat_at < 90 seconds`;
   * - 503 `{status: 'unhealthy', reason}` when the heartbeat is stale
   *   (>= 90 seconds old) or no heartbeat row exists yet, or when the
   *   underlying DB query itself fails -- mirroring `server/routes/health.js`'s
   *   convention of never leaking a raw DB error message into the
   *   response body.
   *
   * A no-op if the health server is already running (idempotent, so
   * calling `start()` twice in a row -- which itself already returns
   * early via `this.isRunning` -- never double-binds the port).
   */
  startHealthServer() {
    if (this.healthServer) return;

    this.healthServer = http.createServer(async (req, res) => {
      try {
        const result = await checkSyncWorkerHeartbeatHealth(this.pool);
        res.writeHead(result.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (error) {
        logger.error({ err: error }, 'Sync worker health check request failed');
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'unhealthy', reason: 'Health check failed unexpectedly' }));
      }
    });

    this.healthServer.on('error', (err) => {
      logger.error({ err }, 'Sync worker health server error');
    });

    this.healthServer.listen(this.healthPort, () => {
      logger.info({ port: this.healthPort }, 'Sync worker health server listening');
    });
  }

  /**
   * Requirement 14.6/task 34.4: stops the lightweight health server
   * started by `startHealthServer()`, mirroring the way `stop()` already
   * closes `this.pool`. A no-op if no health server is currently running.
   */
  stopHealthServer() {
    if (!this.healthServer) return Promise.resolve();

    return new Promise((resolve) => {
      this.healthServer.close(() => {
        logger.info('Sync worker health server closed');
        this.healthServer = null;
        resolve();
      });
    });
  }

  async processNextOperation() {
    let client;
    let operations = [];
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        client = await this.pool.connect();
        await client.query('BEGIN');
        
        // Get next batch of pending operations with row lock.
        // Requirement 10.1: fetch a configurable batch (this.batchSize,
        // 10-500, default 50) instead of a single row, still using
        // FOR UPDATE SKIP LOCKED so concurrent worker instances never
        // claim the same row.
        const result = await client.query(`
          SELECT * FROM sync_operations 
          WHERE status = 'pending' AND next_retry_at <= NOW()
          ORDER BY created_at ASC 
          LIMIT $1 
          FOR UPDATE SKIP LOCKED
        `, [this.batchSize]);
        
        operations = result.rows;
        
        if (operations.length === 0) {
          await client.query('ROLLBACK');
          return;
        }
        
        // Mark every fetched row as processing, in one statement, within
        // the same transaction as the fetch.
        await client.query(
          "UPDATE sync_operations SET status = $1, started_at = NOW() WHERE id = ANY($2)",
          ['processing', operations.map((op) => op.id)]
        );
        
        await client.query('COMMIT');
        break; // Success, exit retry loop
        
      } catch (error) {
        logger.error({ err: error, attempt, maxRetries: this.maxRetries }, 'Database error');
        
        if (client) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            logger.error({ err: rollbackError }, 'Rollback error');
          }
          client.release();
          client = null;
        }
        
        if (attempt === this.maxRetries) {
          throw new Error(`Failed to get operation after ${this.maxRetries} attempts`);
        }
        
        await this.sleep(this.retryDelay * attempt); // Exponential backoff
      } finally {
        if (client) {
          client.release();
          client = null;
        }
      }
    }
    
    // Requirement 10.2/10.3/10.5: partition the fetched batch into
    // same-entity lanes, then run each lane through a `p-limit`-bounded
    // worker pool. Operations WITHIN a lane are processed sequentially
    // and in original fetch order (satisfying 10.5); DIFFERENT lanes run
    // concurrently up to `this.concurrency` (satisfying 10.2/10.3). A
    // single-operation lane (the common case for operation types lacking
    // `target_user_id`/`target_group_id`) is trivially "sequential" since
    // it only has one item.
    const lanes = groupByEntityKey(operations);
    const limit = pLimit(this.concurrency);

    await Promise.all(
      [...lanes.values()].map((laneOperations) =>
        limit(async () => {
          for (const operation of laneOperations) {
            await this.executeOperationSafely(operation);
          }
        })
      )
    );
  }

  async executeOperationSafely(operation) {
    let operationSuccess = false;
    let operationError = null;
    
    try {
      await this.executeOperation(operation);
      operationSuccess = true;
      logger.info(
        {
          operationId: operation.id,
          operationType: operation.operation_type,
          correlationId: operation.correlation_id
        },
        'Operation completed successfully'
      );
      
    } catch (error) {
      operationError = error;
      logger.error(
        {
          operationId: operation.id,
          operationType: operation.operation_type,
          correlationId: operation.correlation_id,
          err: error
        },
        'Operation failed'
      );
    }
    
    // Always try to update operation status, even if the operation failed
    try {
      if (operationSuccess) {
        await this.markOperationCompleted(operation);
      } else if (operationError && operationError.alreadyHandled) {
        // Requirement 9.4: a payload-validation failure (or any other
        // future failure mode that writes its own terminal state) has
        // already had its terminal `sync_operations` row written by
        // `markPermanentlyFailed` inside `executeOperation`. Calling
        // `handleOperationError` here would incorrectly increment
        // `retry_count`/set `next_retry_at` on top of that terminal
        // state, so it is deliberately skipped.
        logger.debug(
          {
            operationId: operation.id,
            operationType: operation.operation_type,
            correlationId: operation.correlation_id
          },
          'Skipping handleOperationError: operation already marked permanently failed'
        );
      } else if (
        (operationError instanceof AuthentikApiError || operationError instanceof TakServerApiError)
        && operationError.classification === 'permanent'
      ) {
        // Requirement 9.6/task 28.2 (and, per task 48.5, the equivalent
        // TAK Server case under Requirement 26.8): a 4xx response from an
        // Authentik- or TAK-Server-calling handler is a permanent
        // failure -- it will not be resolved by retrying the exact same
        // request. Bypass `handleOperationError` entirely (mirroring the
        // payload-validation branch above) and write the terminal
        // `failed`/`failure_category='permanent'` state directly.
        const reason =
          operationError instanceof TakServerApiError ? 'tak_server_client_error' : 'authentik_client_error';
        logger.error(
          {
            operationId: operation.id,
            operationType: operation.operation_type,
            correlationId: operation.correlation_id,
            err: operationError
          },
          'Authentik API call failed permanently; not scheduling a retry'
        );
        await this.markPermanentlyFailed(operation, {
          reason,
          details: operationError.message,
          failureCategory: 'permanent'
        });
      } else {
        // Retryable failures -- including a retryable AuthentikApiError
        // (5xx/network/timeout) as well as every other, unclassified
        // error (unknown operation type, user-not-found, DB errors,
        // etc.) -- continue through the existing retry-scheduling path,
        // unchanged.
        await this.handleOperationError(operation, operationError);
      }
    } catch (statusError) {
      logger.error(
        {
          operationId: operation.id,
          operationType: operation.operation_type,
          correlationId: operation.correlation_id,
          err: statusError
        },
        'Failed to update status for operation'
      );
      // Don't throw - we don't want to crash the worker over status update failures
    }
  }

  async executeOperation(operation) {
    // Requirement 9.5/13.5/13.6: one `debug`-level line carrying the full
    // raw payload (for deep troubleshooting when `LOG_LEVEL=debug` is
    // explicitly set -- disabled by default in production), and one
    // `info`-level line carrying only the operation identifiers, with no
    // payload body, replacing the old `console.log('Raw payload:', ...)`/
    // `console.log('Payload value:', ...)` calls.
    logger.debug(
      {
        operationId: operation.id,
        operationType: operation.operation_type,
        correlationId: operation.correlation_id,
        payload: operation.payload
      },
      'Processing sync operation (full payload)'
    );
    logger.info(
      {
        operationId: operation.id,
        operationType: operation.operation_type,
        correlationId: operation.correlation_id
      },
      'Processing sync operation'
    );

    let payload;
    try {
      // Handle case where payload might already be an object
      if (typeof operation.payload === 'object' && operation.payload !== null) {
        payload = operation.payload;
      } else if (typeof operation.payload === 'string') {
        payload = JSON.parse(operation.payload);
      } else {
        throw new Error(`Unexpected payload type: ${typeof operation.payload}`);
      }
    } catch (parseError) {
      logger.error(
        {
          operationId: operation.id,
          operationType: operation.operation_type,
          correlationId: operation.correlation_id,
          err: parseError
        },
        'Failed to parse operation payload'
      );
      throw new Error(`Invalid payload: ${parseError.message}`);
    }

    // Requirement 9.3/9.4: validate the parsed payload against the
    // expected field set and types for this operation's `operation_type`
    // BEFORE dispatching to a handler. A failing payload is marked
    // permanently failed (failure_category='validation', retry_count and
    // next_retry_at left untouched) and never reaches the switch below.
    // Operation types absent from `operationSchemas` are NOT validated
    // here -- they fall through to the switch's own `default:` branch,
    // which throws the pre-existing "Unknown operation type" error via
    // the normal (retryable) handleOperationError path.
    const validationResult = this.validatePayloadSchema(operation.operation_type, payload);
    if (!validationResult.valid) {
      logger.error(
        {
          operationId: operation.id,
          operationType: operation.operation_type,
          correlationId: operation.correlation_id,
          reason: validationResult.reason
        },
        'Sync operation payload failed schema validation'
      );
      await this.markPermanentlyFailed(operation, {
        reason: 'payload_validation',
        details: validationResult.reason,
        failureCategory: 'validation'
      });
      throw new PayloadValidationError(`Payload validation failed: ${validationResult.reason}`);
    }
    
    switch (operation.operation_type) {
      case 'add_user_to_group':
        await this.addUserToGroup(payload);
        break;
        
      case 'remove_user_from_group':
        await this.removeUserFromGroup(payload);
        break;
        
      case 'create_group':
        await this.createGroup(payload);
        break;
        
      case 'bulk_add_user_to_team':
        await this.bulkAddUserToTeam(payload);
        break;
        
      case 'create_bch_channel_groups':
        await this.createBchChannelGroups(payload);
        break;
        
      case 'create_region_channel_group':
        await this.createRegionChannelGroup(payload);
        break;
        
      case 'update_bch_channel_group':
        await this.updateBchChannelGroup(payload);
        break;
        
      case 'update_region_channel_group':
        await this.updateRegionChannelGroup(payload);
        break;
        
      case 'delete_global_channel':
        await this.deleteGlobalChannelGroup(payload);
        break;
        
      case 'assign_user_to_global_channels':
        await this.assignUserToGlobalChannels(payload);
        break;
        
      case 'deactivate_global_channel':
        await this.deactivateGlobalChannel(payload);
        break;
        
      case 'sync_existing_global_channels':
        await this.syncExistingGlobalChannels(payload);
        break;

      case 'resync_org_channel_tier_access':
        await this.resyncOrgChannelTierAccess(payload);
        break;

      case 'cleanup_orphaned_authentik_user':
        await this.cleanupOrphanedAuthentikUser(payload);
        break;

      case 'remove_team_channel_group':
        await this.removeTeamChannelGroup(payload);
        break;

      case 'create_vendor_channel_group':
        await this.createVendorChannelGroup(payload);
        break;

      case 'create_deployment_channel_group':
        await this.createDeploymentChannelGroup(payload);
        break;

      case 'remove_all_members_from_group':
        await this.removeAllMembersFromGroup(payload);
        break;

      case 'revoke_tak_certificates':
        // Feature device-management, Requirements 12.12/12.14 (task 24.3): the
        // ONLY handler handed the whole `operation` row rather than just the
        // parsed payload. It needs two things the payload cannot carry: the
        // queue row's `id` and `created_by` for the Revoke_Audit_Record's
        // `operationId`/`actingUserId`, and the row itself so a rail abort can
        // write its own terminal permanently-failed state via
        // `markPermanentlyFailed`.
        await this.revokeTakCertificates(payload, operation);
        break;

      case 'create_cloudtak_group':
        await this.createCloudTakGroup(payload);
        break;

      case 'update_cloudtak_group':
        await this.updateCloudTakGroup(payload);
        break;

      case 'delete_cloudtak_group':
        await this.deleteCloudTakGroup(payload);
        break;

      default:
        throw new Error(`Unknown operation type: ${operation.operation_type}`);
    }
  }

  /**
   * Requirement 9.3: validates a parsed payload object against the
   * required/optional field-and-type map registered for `operationType`
   * in `operationSchemas.js`.
   *
   * - If `operationType` has no entry in `operationSchemas` at all, this
   *   is NOT a payload-validation failure -- it's the pre-existing
   *   "unknown operation type" case, handled separately by
   *   `executeOperation`'s `switch` `default:` branch. Returning
   *   `{ valid: true }` here lets that unrelated failure mode continue
   *   to flow through its own (retryable) path undisturbed.
   * - Every key in `requiredFields` must be present on `payload` (i.e.
   *   not `undefined`) and `typeof payload[key]` must equal the
   *   declared type.
   * - Every key in `exactlyOneOf` (if the schema entry declares any --
   *   feature device-management, Requirement 12.2/12.3, task 19.2):
   *   EXACTLY ONE of those mutually exclusive discriminator fields must be
   *   present on `payload`, and the present one's `typeof` must match its
   *   declared type. Zero present (nothing to act on) and two-or-more
   *   present (ambiguous about what to act on) are both validation
   *   failures, caught here rather than silently resolved by a handler's
   *   branch order. An entry may declare `exactlyOneOf` with no
   *   `requiredFields` at all, when no single field is required across
   *   every accepted shape.
   * - Every key in `optionalFields` (if the schema entry declares any)
   *   that IS present on `payload` must also match its declared type;
   *   an absent optional field is not an error.
   *
   * Schema entries that do not declare `exactlyOneOf` -- i.e. every
   * operation type other than `revoke_tak_certificates` -- are validated
   * exactly as they were before that block was added.
   *
   * @param {string} operationType
   * @param {object} payload
   * @returns {{valid: true} | {valid: false, reason: string}}
   */
  validatePayloadSchema(operationType, payload) {
    const schema = operationSchemas[operationType];
    if (!schema) {
      // Unknown operation type: not this function's concern.
      return { valid: true };
    }

    const requiredFields = schema.requiredFields || {};
    for (const [field, expectedType] of Object.entries(requiredFields)) {
      if (payload[field] === undefined) {
        return {
          valid: false,
          reason: `missing required field "${field}" (expected type: ${expectedType})`
        };
      }
      if (typeof payload[field] !== expectedType) {
        return {
          valid: false,
          reason: `field "${field}" has type "${typeof payload[field]}", expected "${expectedType}"`
        };
      }
    }

    // Requirement 12.2/12.3: mutually exclusive discriminator fields, of
    // which a valid payload carries exactly one. Skipped entirely (and so
    // behaviourally inert) for schema entries that declare none.
    if (schema.exactlyOneOf) {
      const discriminators = Object.keys(schema.exactlyOneOf);
      const present = discriminators.filter((field) => payload[field] !== undefined);

      if (present.length === 0) {
        return {
          valid: false,
          reason: `payload must carry exactly one of the fields ${discriminators.join(', ')}, but carries none`
        };
      }
      if (present.length > 1) {
        return {
          valid: false,
          reason: `payload must carry exactly one of the fields ${discriminators.join(', ')}, but carries ${present.join(', ')}`
        };
      }

      const [field] = present;
      const expectedType = schema.exactlyOneOf[field];
      if (typeof payload[field] !== expectedType) {
        return {
          valid: false,
          reason: `field "${field}" has type "${typeof payload[field]}", expected "${expectedType}"`
        };
      }
    }

    const optionalFields = schema.optionalFields || {};
    for (const [field, expectedType] of Object.entries(optionalFields)) {
      if (payload[field] !== undefined && typeof payload[field] !== expectedType) {
        return {
          valid: false,
          reason: `optional field "${field}" has type "${typeof payload[field]}", expected "${expectedType}"`
        };
      }
    }

    return { valid: true };
  }

  /**
   * Requirement 9.4 (this call site: `reason: 'payload_validation'`,
   * `failureCategory: 'validation'`); also reused, per task 28.2, by the
   * Authentik-4xx-classification path with `failureCategory: 'permanent'`.
   * Sets the row's terminal `failed` state directly, WITHOUT touching
   * `retry_count` or `next_retry_at` at all -- this method is the one
   * place that bypasses `handleOperationError`'s retry-scheduling logic
   * entirely, per the "SHALL NOT schedule a retry... under any
   * circumstance" requirement.
   *
   * Follows the same retry-the-UPDATE-itself pattern already used by
   * `markOperationCompleted`/`handleOperationError` for consistency.
   *
   * @param {object} operation
   * @param {{reason: string, details?: string, failureCategory: string}} options
   */
  async markPermanentlyFailed(operation, { reason, details, failureCategory }) {
    const errorMessage = details ? `${reason}: ${details}` : reason;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.pool.query(
          'UPDATE sync_operations SET status = $1, failure_category = $2, error_message = $3, completed_at = NOW() WHERE id = $4',
          ['failed', failureCategory, errorMessage, operation.id]
        );
        logger.info(
          {
            operationId: operation.id,
            operationType: operation.operation_type,
            correlationId: operation.correlation_id,
            failureCategory,
            reason
          },
          'Sync operation marked permanently failed'
        );
        return; // Success
      } catch (dbError) {
        logger.error(
          {
            operationId: operation.id,
            operationType: operation.operation_type,
            correlationId: operation.correlation_id,
            attempt,
            err: dbError
          },
          'Failed to mark operation as permanently failed'
        );
        if (attempt === this.maxRetries) {
          logger.error(
            {
              operationId: operation.id,
              operationType: operation.operation_type,
              correlationId: operation.correlation_id
            },
            'Giving up on marking operation as permanently failed'
          );
        } else {
          await this.sleep(this.retryDelay * attempt);
        }
      }
    }
  }

  async markOperationCompleted(operation) {
    const operationId = operation.id;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.pool.query(
          'UPDATE sync_operations SET status = $1, completed_at = NOW() WHERE id = $2',
          ['completed', operationId]
        );
        return; // Success
      } catch (error) {
        logger.error(
          {
            operationId,
            operationType: operation.operation_type,
            correlationId: operation.correlation_id,
            attempt,
            err: error
          },
          'Failed to mark operation as completed'
        );
        if (attempt === this.maxRetries) {
          logger.error(
            {
              operationId,
              operationType: operation.operation_type,
              correlationId: operation.correlation_id
            },
            'Giving up on marking operation as completed'
          );
        } else {
          await this.sleep(this.retryDelay * attempt);
        }
      }
    }
  }

  async handleOperationError(operation, error) {
    const retryCount = operation.retry_count + 1;
    // Requirement 9.2: the Sync_Worker itself enforces a 48-retry cap as
    // a code-level invariant, regardless of what value is actually
    // stored on `operation.max_retries`. The migration behind task 25.1
    // changed the column default from 100 to 48 and backfilled most
    // still-in-flight rows, but a row that had already exceeded 48
    // retries at backfill time, or a row inserted by a code path that
    // explicitly sets `max_retries` above 48, would otherwise still be
    // trusted unconditionally here. Taking the lesser of the stored
    // value and this cap ensures the 48-retry/48-hour retry window
    // (Requirement 9.2, in combination with the 1-hour backoff cap in
    // `computeBackoffDelay`) always holds, while never *raising* a
    // stricter, lower configured value (e.g. a custom max_retries of 10).
    const EFFECTIVE_MAX_RETRIES_CAP = 48;
    const maxRetries = Math.min(operation.max_retries, EFFECTIVE_MAX_RETRIES_CAP);
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        if (retryCount >= maxRetries) {
          // Mark as failed
          await this.pool.query(
            'UPDATE sync_operations SET status = $1, error_message = $2, retry_count = $3 WHERE id = $4',
            ['failed', error.message, retryCount, operation.id]
          );
        } else {
          // Schedule retry with exponential backoff, capped at 1 hour
          // per retry (Requirement 9.1) so an unbounded 2^n minutes never
          // overflows into an invalid next_retry_at timestamp.
          const nextRetry = new Date(Date.now() + computeBackoffDelay(retryCount));
          
          await this.pool.query(
            'UPDATE sync_operations SET status = $1, error_message = $2, retry_count = $3, next_retry_at = $4 WHERE id = $5',
            ['pending', error.message, retryCount, nextRetry, operation.id]
          );
        }
        return; // Success
      } catch (dbError) {
        logger.error(
          {
            operationId: operation.id,
            operationType: operation.operation_type,
            correlationId: operation.correlation_id,
            attempt,
            err: dbError
          },
          'Failed to update operation error status'
        );
        if (attempt === this.maxRetries) {
          logger.error(
            {
              operationId: operation.id,
              operationType: operation.operation_type,
              correlationId: operation.correlation_id
            },
            'Giving up on updating operation error status'
          );
        } else {
          await this.sleep(this.retryDelay * attempt);
        }
      }
    }
  }

  async addUserToGroup(payload) {
    const user = await this.getUser(payload.target_user_id);
    if (!user) throw new Error(`User ${payload.target_user_id} not found`);
    
    // Add user to Authentik group using existing service
    const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${payload.target_group_id}/add_user/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pk: user.authentik_user_id })
    });
    
    if (!response.ok) {
      const classification = classifyFailure(response.status);
      throw new AuthentikApiError(`Failed to add user to group: ${response.statusText}`, classification);
    }
  }

  async removeUserFromGroup(payload) {
    const user = await this.getUser(payload.target_user_id);
    if (!user) throw new Error(`User ${payload.target_user_id} not found`);
    
    // Remove user from Authentik group
    const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${payload.target_group_id}/remove_user/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pk: user.authentik_user_id })
    });
    
    if (!response.ok) {
      const classification = classifyFailure(response.status);
      throw new AuthentikApiError(`Failed to remove user from group: ${response.statusText}`, classification);
    }
  }

  async createGroup(payload) {
    const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: payload.group_name,
        attributes: payload.group_attributes || {}
      })
    });
    
    if (!response.ok) {
      const classification = classifyFailure(response.status);
      throw new AuthentikApiError(`Failed to create group: ${response.statusText}`, classification);
    }
  }

  async bulkAddUserToTeam(payload) {
    await TeamMembershipService.addUserToTeam(
      payload.target_user_id,
      payload.team_id,
      payload.role
    );
    
    // Update bulk operation progress
    if (payload.bulk_operation_id) {
      await this.pool.query(`
        UPDATE bulk_operations 
        SET processed_items = processed_items + 1,
            progress_percentage = (processed_items::decimal / total_items) * 100
        WHERE id = $1
      `, [payload.bulk_operation_id]);
    }
  }

  async createBchChannelGroups(payload) {
    const { channel_name, category, description, service_account_username, service_account_password, bch_channel_id } = payload;

    const categoryPrefix = BCH_CHANNEL_CATEGORY_PREFIX[category];
    if (!categoryPrefix) {
      throw new AuthentikApiError(
        `create_bch_channel_groups payload carries an invalid category: ${category}`,
        'permanent'
      );
    }

    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
    // Create read and write groups using tak_<category> format
    // (tak_BCH.../tak_UTL...).
    const readGroupName = `tak_${categoryPrefix}${separator}${channel_name}_READ`;
    const writeGroupName = `tak_${categoryPrefix}${separator}${channel_name}`;

    // Bugfix: `description` was previously never set on creation (the
    // enqueue payload never carried it) -- a freshly created channel's
    // Authentik groups had no `attributes.description` at all until the
    // next edit via updateBchChannelGroup, which always did pass it
    // through. Falls back to `channel_name` when no description was
    // supplied (an optional field), matching createRegionChannelGroup's
    // own fallback shape.
    const authentikDescription = description || channel_name;
    
    const readGroupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: readGroupName,
        attributes: { channel_type: 'bch', category, permission: 'read', description: authentikDescription }
      })
    });
    
    const writeGroupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: writeGroupName,
        attributes: { channel_type: 'bch', category, permission: 'write', description: authentikDescription }
      })
    });
    
    if (!readGroupResponse.ok || !writeGroupResponse.ok) {
      const failedStatus = !readGroupResponse.ok ? readGroupResponse.status : writeGroupResponse.status;
      const classification = classifyFailure(failedStatus);
      throw new AuthentikApiError('Failed to create BCH channel groups', classification);
    }
    
    const readGroup = await readGroupResponse.json();
    const writeGroup = await writeGroupResponse.json();
    
    // Create service account
    const userResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: service_account_username,
        name: `ETL Service Account - ${channel_name}`,
        is_active: true,
        type: 'service_account',
        attributes: { service_type: 'etl', channel_name }
      })
    });
    
    if (!userResponse.ok) {
      const classification = classifyFailure(userResponse.status);
      throw new AuthentikApiError('Failed to create service account', classification);
    }
    
    const serviceAccount = await userResponse.json();
    
    // Set service account password
    await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${serviceAccount.pk}/set_password/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: service_account_password })
    });
    
    // Add service account to write group
    await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${writeGroup.pk}/add_user/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ pk: serviceAccount.pk })
    });
    
    // Update database with group IDs
    await this.pool.query(`
      UPDATE bch_channels 
      SET service_account_id = $1, read_group_id = $2, write_group_id = $3
      WHERE id = $4
    `, [serviceAccount.pk, readGroup.pk, writeGroup.pk, bch_channel_id]);
  }

  // Region channels are a SINGLE Authentik group per channel (see the
  // `region_channels` table -- only a `group_id` column, no read/write
  // pair like BCH channels have). There is no "_READ" counterpart group
  // for regions in Authentik; confirmed against the live schema and
  // Authentik's actual `tak_Response - */tak_Support - *` groups, none of
  // which have a `_READ` sibling.
  //
  // region-channel-tiers: `payload.tier` ('response'/'support') selects
  // the group-name prefix via REGION_CHANNEL_TIER_PREFIX --
  // GlobalChannelService.createRegionChannel always supplies it (it
  // validates the same set before ever enqueueing this operation), so an
  // absent/unrecognized tier here indicates a caller bug rather than a
  // legitimate "no tier" case, and is treated as a permanent failure
  // rather than silently falling back to the old untiered `tak_Regions`
  // name.
  async createRegionChannelGroup(payload) {
    const { channel_name, region_channel_id, tier } = payload;

    const tierPrefix = REGION_CHANNEL_TIER_PREFIX[tier];
    if (!tierPrefix) {
      throw new AuthentikApiError(
        `create_region_channel_group payload carries an invalid tier: ${tier}`,
        'permanent'
      );
    }

    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
    const groupName = `tak_${tierPrefix}${separator}${channel_name}`;
    
    logger.debug({ region_channel_id, groupName, tier }, 'Creating region channel group');
    
    // Get channel description from database
    const channelResult = await this.pool.query(
      'SELECT description FROM region_channels WHERE id = $1',
      [region_channel_id]
    );
    
    const description = channelResult.rows[0]?.description || channel_name;
    const authentikDescription = `${description} (Bi-directional location sharing)`;
    
    const groupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: groupName,
        attributes: { 
          channel_type: 'region',
          description: authentikDescription
        }
      })
    });
    
    if (!groupResponse.ok) {
      const errorText = await groupResponse.text();
      logger.error(
        { region_channel_id, status: groupResponse.status, err: errorText },
        'Failed to create region channel group'
      );
      const classification = classifyFailure(groupResponse.status);
      throw new AuthentikApiError('Failed to create region channel group', classification);
    }
    
    const group = await groupResponse.json();
    
    logger.debug({ region_channel_id, groupId: group.pk }, 'Created region channel group');
    
    // Update database with the group ID
    await this.pool.query(`
      UPDATE region_channels 
      SET group_id = $1
      WHERE id = $2
    `, [group.pk, region_channel_id]);
  }

  async updateBchChannelGroup(payload) {
    const { bch_channel_id, channel_name, category, description } = payload;

    const categoryPrefix = BCH_CHANNEL_CATEGORY_PREFIX[category];
    if (!categoryPrefix) {
      throw new AuthentikApiError(
        `update_bch_channel_group payload carries an invalid category: ${category}`,
        'permanent'
      );
    }

    logger.debug({ bch_channel_id, channel_name, category }, 'Updating BCH channel group');
    
    // Get current group IDs
    const channelResult = await this.pool.query(
      'SELECT read_group_id, write_group_id FROM bch_channels WHERE id = $1',
      [bch_channel_id]
    );
    
    if (channelResult.rows.length === 0) {
      logger.debug({ bch_channel_id }, 'No BCH channel found with this ID');
      return;
    }
    
    const { read_group_id, write_group_id } = channelResult.rows[0];
    
    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
    
    // Update read group
    if (read_group_id) {
      const readRequestBody = {
        name: `tak_${categoryPrefix}${separator}${channel_name}_READ`,
        attributes: { channel_type: 'bch', category, permission: 'read', description }
      };
      
      logger.debug({ bch_channel_id, groupType: 'read' }, 'Updating BCH read group');
      
      const readResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${read_group_id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(readRequestBody)
      });
      
      if (!readResponse.ok) {
        const errorText = await readResponse.text();
        logger.error({ bch_channel_id, status: readResponse.status, err: errorText }, 'Failed to update BCH read group');
        const classification = classifyFailure(readResponse.status);
        throw new AuthentikApiError(`Failed to update BCH read group: ${readResponse.status} ${errorText}`, classification);
      }
    }
    
    // Update write group
    if (write_group_id) {
      const writeRequestBody = {
        name: `tak_${categoryPrefix}${separator}${channel_name}`,
        attributes: { channel_type: 'bch', category, permission: 'write', description }
      };
      
      logger.debug({ bch_channel_id, groupType: 'write' }, 'Updating BCH write group');
      
      const writeResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${write_group_id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(writeRequestBody)
      });
      
      if (!writeResponse.ok) {
        const errorText = await writeResponse.text();
        logger.error({ bch_channel_id, status: writeResponse.status, err: errorText }, 'Failed to update BCH write group');
        const classification = classifyFailure(writeResponse.status);
        throw new AuthentikApiError(`Failed to update BCH write group: ${writeResponse.status} ${errorText}`, classification);
      }
    }
  }

  async updateRegionChannelGroup(payload) {
    const { region_channel_id, channel_name, description } = payload;
    
    logger.debug({ region_channel_id, channel_name }, 'Updating region channel group');
    
    // Get current group ID AND tier -- tier is read from the database
    // rather than the payload (unlike createRegionChannelGroup): the
    // channel's tier is fixed at creation and never changes, and this
    // handler already looks up the row for its stored group_id, so
    // selecting `tier` alongside it costs nothing extra and avoids
    // requiring update_region_channel_group's payload to carry a field
    // that would always just repeat what's already stored.
    const channelResult = await this.pool.query(
      'SELECT group_id, tier FROM region_channels WHERE id = $1',
      [region_channel_id]
    );
    
    if (channelResult.rows.length === 0) {
      logger.debug({ region_channel_id }, 'No region channel found with this ID');
      return;
    }
    
    const { group_id, tier } = channelResult.rows[0];
    
    if (!group_id) {
      logger.debug({ region_channel_id }, 'No group_id set for region channel');
      return;
    }

    const tierPrefix = REGION_CHANNEL_TIER_PREFIX[tier];
    if (!tierPrefix) {
      throw new AuthentikApiError(
        `region_channels row ${region_channel_id} carries an invalid tier: ${tier}`,
        'permanent'
      );
    }
    
    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
    const authentikDescription = `${description} (Bi-directional location sharing)`;
    const requestBody = {
      name: `tak_${tierPrefix}${separator}${channel_name}`,
      attributes: { 
        channel_type: 'region',
        description: authentikDescription
      }
    };
    
    try {
      const updateResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${group_id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!updateResponse.ok) {
        let errorText;
        try {
          errorText = await updateResponse.text();
        } catch (textError) {
          errorText = `Failed to read error response: ${textError.message}`;
        }
        logger.error({ region_channel_id, status: updateResponse.status, err: errorText }, 'Failed to update region channel group');
        const classification = classifyFailure(updateResponse.status);
        throw new AuthentikApiError(`Failed to update region group: ${updateResponse.status} ${errorText}`, classification);
      }
      
      logger.debug({ region_channel_id }, 'Region channel group updated successfully');
      
    } catch (fetchError) {
      logger.error({ region_channel_id, err: fetchError }, 'Failed to update region channel group');
      // If this is already a classified AuthentikApiError (thrown by the
      // !updateResponse.ok branch above), rethrow it as-is so its
      // classification survives. Otherwise this is a caught
      // network/timeout error from `fetch()` itself (the request never
      // reached Authentik), which `classifyFailure` always treats as
      // retryable.
      if (fetchError instanceof AuthentikApiError) {
        throw fetchError;
      }
      const classification = classifyFailure(fetchError);
      throw new AuthentikApiError(fetchError.message, classification);
    }
  }

  async deleteGlobalChannelGroup(payload) {
    const { channel_id, channel_type } = payload;
    
    if (channel_type === 'bch') {
      // Get BCH channel group IDs
      const channelResult = await this.pool.query(
        'SELECT read_group_id, write_group_id, service_account_id FROM bch_channels WHERE id = $1',
        [channel_id]
      );
      
      if (channelResult.rows.length > 0) {
        const { read_group_id, write_group_id, service_account_id } = channelResult.rows[0];
        
        // Delete groups and service account
        if (read_group_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${read_group_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
          });
        }
        
        if (write_group_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${write_group_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
          });
        }
        
        if (service_account_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${service_account_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
          });
        }
      }
    } else if (channel_type === 'region') {
      // Get region channel group ID
      const channelResult = await this.pool.query(
        'SELECT group_id FROM region_channels WHERE id = $1',
        [channel_id]
      );
      
      if (channelResult.rows.length > 0) {
        const { group_id } = channelResult.rows[0];
        
        if (group_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${group_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
          });
        }
      }
    }
  }

  /**
   * Requirement 17.2 (task 36.2): the deferred/asynchronous half of the
   * "delete an orphaned Authentik user" compensating action. This handler
   * is only reached when `POST /api/users/create-and-add`'s Phase 2 catch
   * block already attempted a SYNCHRONOUS delete of the same Authentik
   * user and that attempt itself failed (non-2xx response or a
   * network/timeout error) -- at which point the route enqueues this
   * operation instead, so the Sync_Worker can retry the delete later.
   *
   * Follows the same fetch/`AuthentikApiError`/`classifyFailure` pattern
   * already used by every other Authentik-calling handler in this file
   * (see `removeUserFromGroup`, immediately above). A 404 response (the
   * user no longer exists in Authentik -- e.g. a previous attempt at this
   * same cleanup already succeeded) is treated as an already-satisfied
   * cleanup rather than a failure, since retrying a delete of an
   * already-deleted resource has nothing further to reconcile.
   */
  async cleanupOrphanedAuthentikUser(payload) {
    const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${payload.authentik_user_id}/`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
    });

    if (response.status === 404) {
      logger.debug(
        { authentikUserId: payload.authentik_user_id },
        'Orphaned Authentik user already absent; cleanup operation is a no-op'
      );
      return;
    }

    if (!response.ok) {
      const classification = classifyFailure(response.status);
      throw new AuthentikApiError(
        `Failed to delete orphaned Authentik user ${payload.authentik_user_id}: ${response.statusText}`,
        classification
      );
    }
  }

  /**
   * Requirement 17.3/17.4 (task 36.3): the Sync_Worker-side cleanup for a
   * team channel whose local `channels` row (and `channel_memberships`
   * rows) have already been deleted by `Team.delete`'s transaction. This
   * handler deletes the corresponding Authentik group(s) -- mirroring
   * `deleteGlobalChannelGroup`'s "DELETE each non-null group id" shape
   * for BCH channels above, since a team channel may carry a single
   * `authentik_group_id` (the common case: `Team.createTeamChannel`'s
   * primary channel) and/or a separate read/write pair (a custom channel
   * created via `Channel.createCustomChannel`).
   *
   * Each present group id is deleted independently. A 404 response for
   * any one of them is treated the same way `cleanupOrphanedAuthentikUser`
   * treats a 404 -- the group is already absent (e.g. a previous attempt
   * at this same cleanup already succeeded, or the group was never
   * actually created in Authentik), so there is nothing further to
   * reconcile for that id, and processing continues with the next one. A
   * non-404 non-2xx response classifies the failure via
   * `classifyFailure`/`AuthentikApiError`, exactly like every other
   * Authentik-calling handler in this file, and stops processing any
   * remaining group ids for this operation (the operation as a whole will
   * be retried or marked permanently failed by the normal
   * `executeOperationSafely` catch-handling path, which will re-attempt
   * every group id -- including any already successfully deleted above,
   * which will then simply 404 and no-op).
   */
  async removeTeamChannelGroup(payload) {
    const groupIds = [
      payload.authentik_group_id,
      payload.authentik_read_group_id,
      payload.authentik_write_group_id
    ].filter((groupId) => groupId != null);

    for (const groupId of groupIds) {
      const response = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${groupId}/`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
      });

      if (response.status === 404) {
        logger.debug(
          { channelId: payload.channel_id, groupId },
          'Team channel Authentik group already absent; cleanup for this group id is a no-op'
        );
        continue;
      }

      if (!response.ok) {
        const classification = classifyFailure(response.status);
        throw new AuthentikApiError(
          `Failed to delete team channel Authentik group ${groupId}: ${response.statusText}`,
          classification
        );
      }
    }
  }

  /**
   * Requirement 21.10 (task 40.1): creates a single Authentik `VND` group
   * for the singleton `vendor_channels` row identified by
   * `payload.vendor_channel_id`. Unlike BCH/region channels (which each
   * create a read/write group pair via `createBchChannelGroups`/
   * `createRegionChannelGroup`), the Vendor_Channel is a single group --
   * design.md's Section 17 and requirements.md Requirement 21 Criterion
   * 10 both describe enqueueing a Sync_Operation "to create the
   * corresponding Authentik `VND` group" (singular), so this handler
   * creates exactly one group, mirroring the shape of
   * `updateRegionChannelGroup`'s single-group-id handling rather than
   * `createRegionChannelGroup`'s read/write pair.
   *
   * On success, UPDATEs `vendor_channels.authentik_group_id` with the
   * created group's Authentik pk, mirroring how `createBchChannelGroups`/
   * `createRegionChannelGroup` update their respective tables' group-id
   * columns after creating the group in Authentik.
   */
  async createVendorChannelGroup(payload) {
    const { vendor_channel_id } = payload;

    const channelResult = await this.pool.query(
      'SELECT name, description FROM vendor_channels WHERE id = $1',
      [vendor_channel_id]
    );

    if (channelResult.rows.length === 0) {
      logger.debug({ vendor_channel_id }, 'No vendor channel found with this ID');
      return;
    }

    const { name, description } = channelResult.rows[0];

    logger.debug({ vendor_channel_id, name }, 'Creating vendor channel group');

    const groupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        attributes: { channel_type: 'vendor', description }
      })
    });

    if (!groupResponse.ok) {
      const errorText = await groupResponse.text();
      logger.error(
        { vendor_channel_id, status: groupResponse.status, err: errorText },
        'Failed to create vendor channel group'
      );
      const classification = classifyFailure(groupResponse.status);
      throw new AuthentikApiError(
        `Failed to create vendor channel group: ${groupResponse.status} ${errorText}`,
        classification
      );
    }

    const group = await groupResponse.json();

    logger.debug({ vendor_channel_id, groupId: group.pk }, 'Created vendor channel group');

    await this.pool.query(
      'UPDATE vendor_channels SET authentik_group_id = $1 WHERE id = $2',
      [group.pk, vendor_channel_id]
    );
  }

  /**
   * Requirement 22.4/22.11 (task 42.1): creates a single Authentik group
   * for the `deployment_channels` row identified by
   * `payload.deployment_channel_id`. Mirrors `createVendorChannelGroup`'s
   * single-group shape (not the BCH/region read/write pair) since neither
   * Requirement 22 nor design.md's Section 18 calls for a read/write
   * split for deployment channels -- this applies identically to an
   * `Overseas - ` prefixed channel and a Domestic_Mission_Channel, since
   * `createDeploymentChannel` inserts both through the same
   * `deployment_channels` table/row shape and enqueues this exact same
   * operation type regardless of which naming pattern matched.
   *
   * On success, UPDATEs `deployment_channels.authentik_group_id` with the
   * created group's Authentik pk, mirroring
   * `createVendorChannelGroup`/`createBchChannelGroups`/
   * `createRegionChannelGroup`'s post-create UPDATE.
   */
  async createDeploymentChannelGroup(payload) {
    const { deployment_channel_id, channel_name } = payload;

    const channelResult = await this.pool.query(
      'SELECT name, description FROM deployment_channels WHERE id = $1',
      [deployment_channel_id]
    );

    if (channelResult.rows.length === 0) {
      logger.debug({ deployment_channel_id }, 'No deployment channel found with this ID');
      return;
    }

    const { description } = channelResult.rows[0];
    const groupName = channel_name || channelResult.rows[0].name;

    logger.debug({ deployment_channel_id, groupName }, 'Creating deployment channel group');

    const groupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: groupName,
        attributes: { channel_type: 'deployment', description }
      })
    });

    if (!groupResponse.ok) {
      const errorText = await groupResponse.text();
      logger.error(
        { deployment_channel_id, status: groupResponse.status, err: errorText },
        'Failed to create deployment channel group'
      );
      const classification = classifyFailure(groupResponse.status);
      throw new AuthentikApiError(
        `Failed to create deployment channel group: ${groupResponse.status} ${errorText}`,
        classification
      );
    }

    const group = await groupResponse.json();

    logger.debug({ deployment_channel_id, groupId: group.pk }, 'Created deployment channel group');

    await this.pool.query(
      'UPDATE deployment_channels SET authentik_group_id = $1 WHERE id = $2',
      [group.pk, deployment_channel_id]
    );
  }

  /**
   * Requirement 22.8/22.9 (task 42.3): bulk-removes every member from the
   * Authentik group identified by `payload.target_group_id`, enqueued by
   * `DeploymentChannelService.deactivateExpired()` after that channel's
   * `is_active` has already been set to `false` and its
   * `channel_memberships` rows have already been deleted locally.
   *
   * Authentik's group API (`GroupViewSet` in
   * `authentik/core/api/groups.py`) exposes `POST
   * /core/groups/{id}/add_user/` and `POST /core/groups/{id}/remove_user/`
   * -- each operating on exactly one user per call, mirroring this
   * codebase's own `addUserToGroup`/`removeUserFromGroup` handlers above
   * -- but no single "remove all members" action. This handler therefore:
   *   1. `GET`s the group, whose serialized `users` field (a
   *      `BulkPrimaryKeyRelatedField`, included by default -- Authentik's
   *      `include_users` query param defaults to `true`) is the group's
   *      current member pk list.
   *   2. Calls `POST .../remove_user/` once per member pk, using the
   *      exact same request shape as `removeUserFromGroup` above.
   *
   * Following `removeTeamChannelGroup`'s established per-item convention:
   * a 404 for the group itself (already deleted in Authentik) is treated
   * as an already-satisfied cleanup and returns early; a 404 for an
   * individual member removal (removed by some other path between the
   * `GET` and this call) is likewise a no-op continue rather than a
   * failure. Any other non-2xx response classifies via `classifyFailure`
   * and throws `AuthentikApiError`, aborting the remaining removals for
   * this invocation -- a retry re-fetches the (now shorter) member list
   * and resumes, so this is safely idempotent across retries.
   */
  async removeAllMembersFromGroup(payload) {
    const { target_group_id: targetGroupId } = payload;

    logger.debug(
      { channelId: payload.channel_id, targetGroupId },
      'Removing all members from Authentik group'
    );

    const groupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${targetGroupId}/`, {
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (groupResponse.status === 404) {
      logger.debug(
        { channelId: payload.channel_id, targetGroupId },
        'Authentik group already absent; removing all members is a no-op'
      );
      return;
    }

    if (!groupResponse.ok) {
      const classification = classifyFailure(groupResponse.status);
      throw new AuthentikApiError(
        `Failed to fetch group members for group ${targetGroupId}: ${groupResponse.statusText}`,
        classification
      );
    }

    const group = await groupResponse.json();
    const memberPks = Array.isArray(group.users) ? group.users : [];

    for (const memberPk of memberPks) {
      const removeResponse = await fetch(
        `${process.env.AUTHENTIK_URL}/api/v3/core/groups/${targetGroupId}/remove_user/`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ pk: memberPk })
        }
      );

      if (removeResponse.status === 404) {
        logger.debug(
          { channelId: payload.channel_id, targetGroupId, memberPk },
          'Group member already absent; removal for this member is a no-op'
        );
        continue;
      }

      if (!removeResponse.ok) {
        const classification = classifyFailure(removeResponse.status);
        throw new AuthentikApiError(
          `Failed to remove user ${memberPk} from group ${targetGroupId}: ${removeResponse.statusText}`,
          classification
        );
      }
    }

    logger.debug(
      { channelId: payload.channel_id, targetGroupId, memberCount: memberPks.length },
      'Removed all members from Authentik group'
    );
  }

  /**
   * Feature cloudtak-agency-groups (task 4.1): the `create_cloudtak_group`
   * handler. Both create and update do the SAME idempotent work
   * (create-or-reuse the group, set the Agency_Attributes authoritatively,
   * reconcile membership to the Team's current Direct_Admin_Set), so both
   * delegate to `ensureCloudTakGroup`. `create_cloudtak_group` is enqueued
   * by `Team.create` and the Backfill; because `ensureCloudTakGroup`
   * performs Create_Or_Reuse, running it against an already-existing group
   * is safe (Requirements 2.4, 8.3, 10.1).
   *
   * @param {{ team_id: number }} payload
   */
  async createCloudTakGroup(payload) {
    await this.ensureCloudTakGroup(payload.team_id);
  }

  /**
   * Feature cloudtak-agency-groups (task 4.1): the `update_cloudtak_group`
   * handler, enqueued on a Team rename/re-description and on every
   * direct-admin membership change (add/promote/demote/remove). It shares
   * `ensureCloudTakGroup` with `create_cloudtak_group`: it too performs
   * Create_Or_Reuse, so it can safely run even if the create operation has
   * not yet been processed (Requirements 5.5, 6.3, 10.4, 10.5).
   *
   * @param {{ team_id: number }} payload
   */
  async updateCloudTakGroup(payload) {
    await this.ensureCloudTakGroup(payload.team_id);
  }

  /**
   * Feature cloudtak-agency-groups (task 4.1): the shared, idempotent
   * reconcile driving both `createCloudTakGroup` and `updateCloudTakGroup`.
   *
   * Steps:
   *   1. Load the Team's current `name`/`description` from the database.
   *      If the Team row is gone (deleted between enqueue and processing),
   *      treat this as an already-satisfied no-op and return -- a later
   *      `delete_cloudtak_group`, or the group's mere absence, is fine.
   *   2. Compute the group name (`CloudTAKAgency<id>`) and the
   *      Agency_Attributes from the Team's current values.
   *   3. Create-or-reuse the group (POST `/core/groups/`; on a non-2xx
   *      name-conflict, GET `?name=` and reuse the exact-name match),
   *      mirroring `Team.createTeamChannel` (Requirements 2.3, 2.4, 10.1).
   *   4. Set the Agency_Attributes authoritatively via PATCH, so a
   *      pre-existing group that lacked them gets them (Requirement 2.5).
   *      Skipped only when the fresh POST already carried them.
   *   5. Reconcile membership to the Direct_Admin_Set (Requirements 4.5,
   *      5.5, 10.5).
   *
   * @param {number} teamId
   */
  async ensureCloudTakGroup(teamId) {
    // Step 1: load the Team's current stored values.
    const teamResult = await this.pool.query(
      'SELECT id, name, description FROM teams WHERE id = $1',
      [teamId]
    );
    const team = teamResult.rows[0];
    if (!team) {
      // The Team was deleted between enqueue and processing. There is
      // nothing to mirror; a later delete op (or the group's absence) is
      // the correct end state, so this is a no-op success.
      logger.info(
        { teamId },
        'Team no longer exists; CloudTAK group ensure is a no-op'
      );
      return;
    }

    const name = groupName(team.id);
    const attributes = agencyAttributes(team);

    // Step 3: create-or-reuse the group by name (mirrors
    // Team.createTeamChannel).
    let group;
    let createdFresh = false;
    const createResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, attributes })
    });

    if (createResponse.ok) {
      group = await createResponse.json();
      createdFresh = true;
    } else {
      // Create_Or_Reuse: a name-conflict (or any non-2xx) triggers a
      // lookup by exact name. This is NOT treated as a permanent failure
      // (Requirement 10.1).
      const lookupResponse = await fetch(
        `${process.env.AUTHENTIK_URL}/api/v3/core/groups/?name=${encodeURIComponent(name)}`,
        { headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` } }
      );
      const lookupData = lookupResponse.ok ? await lookupResponse.json() : null;
      group = lookupData?.results?.find((g) => g.name === name);

      if (!group) {
        // Neither create nor lookup produced a group: classify off the
        // original create failure so a 5xx retries and a non-conflict 4xx
        // is permanent (Requirements 9.3, 10.2, 10.3).
        const classification = classifyFailure(createResponse.status);
        throw new AuthentikApiError(
          `Failed to create or find CloudTAK group "${name}": ${createResponse.status} ${createResponse.statusText}`,
          classification
        );
      }
      logger.info(
        { teamId, name, groupId: group.pk },
        'Reused existing CloudTAK group instead of creating a duplicate'
      );
    }

    const groupPk = group.pk;

    // Step 4: set the Agency_Attributes authoritatively on reuse (so a
    // pre-existing group without attributes gets them -- Requirement 2.5).
    // Skipped on the fresh-create path, where the POST already set them.
    if (!createdFresh) {
      const patchResponse = await fetch(
        `${process.env.AUTHENTIK_URL}/api/v3/core/groups/${groupPk}/`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ attributes })
        }
      );

      if (!patchResponse.ok) {
        const classification = classifyFailure(patchResponse.status);
        throw new AuthentikApiError(
          `Failed to set attributes on CloudTAK group "${name}": ${patchResponse.status} ${patchResponse.statusText}`,
          classification
        );
      }
    }

    // Step 5: reconcile membership to the Direct_Admin_Set.
    await this.reconcileCloudTakMembers(teamId, groupPk, name);

    logger.info(
      { teamId, name, groupId: groupPk },
      'Ensured CloudTAK group (attributes set, membership reconciled)'
    );
  }

  /**
   * Feature cloudtak-agency-groups (task 4.1): reconciles a
   * CloudTAK_Group's membership to the Team's current Direct_Admin_Set
   * (Requirements 5.5, 10.5).
   *
   * Reads the group's current member pks (`GET /core/groups/{pk}/` ->
   * `group.users`), resolves the target set as the Team's Direct_Admin_Set
   * `authentik_user_id` values, and issues `add_user`/`remove_user` for the
   * diff (via the pure `computeMembershipDiff`). Both id spaces are
   * Authentik user pks, so they compare directly. An individual add/remove
   * returning 404 (membership changed mid-flight) is a no-op `continue`;
   * any other non-2xx aborts via `AuthentikApiError` so the whole op
   * retries and re-reconciles.
   *
   * @param {number} teamId
   * @param {number|string} groupPk
   * @param {string} name
   */
  async reconcileCloudTakMembers(teamId, groupPk, name) {
    // Target: the Team's current Direct_Admin_Set (authentik_user_id).
    const directAdmins = await getDirectAdmins(teamId, this.pool);
    const target = directAdmins
      .map((admin) => admin.authentik_user_id)
      .filter((id) => id !== null && id !== undefined);

    // Current: the group's member pks.
    const groupResponse = await fetch(
      `${process.env.AUTHENTIK_URL}/api/v3/core/groups/${groupPk}/`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!groupResponse.ok) {
      const classification = classifyFailure(groupResponse.status);
      throw new AuthentikApiError(
        `Failed to fetch CloudTAK group members for "${name}": ${groupResponse.statusText}`,
        classification
      );
    }

    const group = await groupResponse.json();
    const current = Array.isArray(group.users) ? group.users : [];

    const { toAdd, toRemove } = computeMembershipDiff(current, target);

    for (const memberPk of toAdd) {
      await this.reconcileMembership(groupPk, memberPk, 'add_user', name);
    }
    for (const memberPk of toRemove) {
      await this.reconcileMembership(groupPk, memberPk, 'remove_user', name);
    }

    logger.debug(
      { teamId, name, groupId: groupPk, added: toAdd.length, removed: toRemove.length },
      'Reconciled CloudTAK group membership to the Direct_Admin_Set'
    );
  }

  /**
   * Feature cloudtak-agency-groups (task 4.1): issues a single
   * `add_user`/`remove_user` call for the membership reconcile. A 404
   * (membership changed between the GET and this call) is a no-op; any
   * other non-2xx throws `AuthentikApiError(classifyFailure(status))`.
   *
   * @param {number|string} groupPk
   * @param {number|string} memberPk
   * @param {'add_user'|'remove_user'} action
   * @param {string} name
   */
  async reconcileMembership(groupPk, memberPk, action, name) {
    const response = await fetch(
      `${process.env.AUTHENTIK_URL}/api/v3/core/groups/${groupPk}/${action}/`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ pk: memberPk })
      }
    );

    if (response.status === 404) {
      logger.debug(
        { name, groupId: groupPk, memberPk, action },
        'CloudTAK group membership changed mid-reconcile; individual member op is a no-op'
      );
      return;
    }

    if (!response.ok) {
      const classification = classifyFailure(response.status);
      throw new AuthentikApiError(
        `Failed to ${action} user ${memberPk} for CloudTAK group "${name}": ${response.statusText}`,
        classification
      );
    }
  }

  /**
   * Feature cloudtak-agency-groups (task 4.2): the `delete_cloudtak_group`
   * handler, enqueued by `Team.delete` inside the deletion transaction
   * (Requirement 7.1). By the time this runs the `teams` row is already
   * gone, so the group name is derived purely from `payload.team_id`
   * (`CloudTAKAgency<team_id>`), never from a DB lookup.
   *
   * Steps (Requirement 7.2, 7.3):
   *   1. Resolve the CloudTAK_Group by exact name via
   *      `GET /core/groups/?name=<encoded>`.
   *   2. If the lookup finds the exact-name group, `DELETE /core/groups/{pk}/`.
   *   3. If the lookup returns no matching group, OR the DELETE returns a
   *      404, treat the deletion as already satisfied and complete
   *      successfully -- mirroring `removeTeamChannelGroup`/
   *      `cleanupOrphanedAuthentikUser`'s 404 handling.
   *   4. A non-404 non-2xx on the lookup or the DELETE throws
   *      `AuthentikApiError(classifyFailure(status))`, so a 5xx retries and
   *      a non-404 4xx is permanent (Requirements 9.3, 10.2, 10.3).
   *
   * @param {{ team_id: number }} payload
   */
  async deleteCloudTakGroup(payload) {
    const name = groupName(payload.team_id);

    // Step 1: resolve the group by exact name.
    const lookupResponse = await fetch(
      `${process.env.AUTHENTIK_URL}/api/v3/core/groups/?name=${encodeURIComponent(name)}`,
      { headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` } }
    );

    if (lookupResponse.status === 404) {
      logger.debug(
        { teamId: payload.team_id, name },
        'CloudTAK group lookup returned 404; deletion already satisfied (no-op)'
      );
      return;
    }

    if (!lookupResponse.ok) {
      const classification = classifyFailure(lookupResponse.status);
      throw new AuthentikApiError(
        `Failed to look up CloudTAK group "${name}" for deletion: ${lookupResponse.statusText}`,
        classification
      );
    }

    const lookupData = await lookupResponse.json();
    const group = lookupData?.results?.find((g) => g.name === name);

    if (!group) {
      // Absent group = already-satisfied deletion (Requirement 7.3).
      logger.debug(
        { teamId: payload.team_id, name },
        'CloudTAK group already absent; deletion is a no-op'
      );
      return;
    }

    // Step 2: delete the resolved group.
    const deleteResponse = await fetch(
      `${process.env.AUTHENTIK_URL}/api/v3/core/groups/${group.pk}/`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
      }
    );

    if (deleteResponse.status === 404) {
      // Group vanished between lookup and delete; already satisfied.
      logger.debug(
        { teamId: payload.team_id, name, groupId: group.pk },
        'CloudTAK group already absent on delete; deletion is a no-op'
      );
      return;
    }

    if (!deleteResponse.ok) {
      const classification = classifyFailure(deleteResponse.status);
      throw new AuthentikApiError(
        `Failed to delete CloudTAK group "${name}": ${deleteResponse.statusText}`,
        classification
      );
    }

    logger.info(
      { teamId: payload.team_id, name, groupId: group.pk },
      'Deleted CloudTAK group'
    );
  }

  /**
   * Requirement 26.8 (task 48.5): revokes TAK Server certificates. The payload
   * carries one of two mutually exclusive shapes (feature device-management,
   * Requirements 12.2/12.3, tasks 19.2/19.3), and the shape decides both the
   * certificate view fetched and the field matched:
   *
   * - `tak_usernames` (user-scoped, the three pre-existing call sites): every
   *   certificate in `listCertificates()` whose `creatorDn` matches any of the
   *   given usernames -- unchanged behaviour, deliberately spanning every Device
   *   that user holds.
   * - `client_uid` (device-scoped, this feature's per-Device Revoke): exactly the
   *   Live_Certificates (`listLiveCertificates()`: in `/active`, NOT in
   *   `/revoked`) carrying that one `clientUid`, and no certificate carrying
   *   another -- including certificates issued to the same local user for a
   *   different Device (Requirements 7.4, 8.4, 12.1).
   *
   * Per task 48.4's payload design ("single bulk batch fetching the
   * certificate catalog once"), the chosen view is fetched exactly ONCE per
   * operation regardless of how many targets the payload resolves to (see
   * `fetchRevokeResolutionInputs`), and the single result is then filtered in
   * memory -- the user-scoped shape using the same `matchesCreatorDn` predicate
   * `TakServerService.findCertificatesForUser` uses internally, rather than
   * calling `findCertificatesForUser` once per username, which would re-fetch
   * the full certificate list from TAK Server on every iteration.
   *
   * - No certificate matching the payload -- no username match, or a
   *   `client_uid` with no live certificate left -- is treated as
   *   a successful no-op (Requirement 26.8's "nothing to revoke" case --
   *   e.g. the user never had a TAK certificate).
   * - `TakServerService.revokeCertificates`'s verified-failed-revocation
   *   result (`{success: false, unverified: [...]}`, per Requirement
   *   26.5) is NOT a TAK-Server-unreachable/error case, so it is NOT
   *   wrapped in `TakServerApiError` -- it's a plain `Error`, which flows
   *   through the default (retryable) `handleOperationError` path so a
   *   future retry can re-attempt verification, matching Requirement
   *   26.8's "not confirmed revoked" being treated as a failure requiring
   *   retry.
   * - Any error thrown BY the axios calls inside `listCertificates`/
   *   `listLiveCertificates`/`revokeCertificates` themselves (TAK Server
   *   unreachable, timed out,
   *   or returned a non-2xx status) IS the "TAK Server unreachable/error
   *   responses" case Requirement 26.8 explicitly calls out: it is
   *   classified via the existing `classifyFailure` mechanism (5xx/
   *   network/timeout -> retryable, 4xx -> permanent) and re-thrown as a
   *   `TakServerApiError` carrying that classification, mirroring every
   *   other Authentik-calling handler's `AuthentikApiError` pattern.
   * - Feature device-management, Requirement 7.6/8.7 (task 9.1): once (and
   *   only once) the revocation is confirmed, the matched certificates'
   *   Device_Table rows are marked revoked via `markDevicesRevoked`, guarded
   *   by `isDeviceMgmtEnabled()`.
   *
   * ## The revocation rails (Requirements 12.10-12.16, task 24.3)
   *
   * This handler is RESOLVE-THEN-GATE: it first resolves the target
   * certificate ids into a `{ payloadShape, clientUid, targetCertIds,
   * clientUids }` shape (`resolveRevokeTargets`), and only then runs four rails,
   * in this order and ALL before any `DELETE` -- the resolved set is the only
   * point at which the true blast radius is known:
   *
   *   1. **Audit record** -- one `revoke_audit` line carrying the full,
   *      never-truncated target id list plus its count and a stable digest
   *      (Requirements 12.14, 12.16). Emitted BEFORE the decision point in
   *      every case, including every abort and the dry-run, because the whole
   *      point of the record is that "did we target these?" stays answerable
   *      for an operation that did NOT proceed as much as for one that did.
   *   2. **Single-`client_uid`** (device-scoped shape only) -- a resolved set
   *      spanning more than one `clientUid` is a resolution defect, so the
   *      operation aborts permanently (Requirement 12.12). NOT applied to the
   *      user-scoped shape, which legitimately spans a user's Devices
   *      (Requirements 12.3, 12.15).
   *   3. **Blast-radius cap** -- `targetCertCount > getRevokeMaxCerts()` aborts.
   *      The set is NEVER truncated to the cap and never proceeds partially: a
   *      partial revoke reports a Device disabled while leaving it usable, which
   *      is worse than a refused one (Requirement 12.13).
   *   4. **Dry-run** -- WHILE Revoke_Enabled is false, no `DELETE` is issued, no
   *      `revoked` flag is flipped, and the operation completes SUCCESSFULLY as
   *      a dry-run (`dryRun: true` on the audit record) rather than failing, so
   *      it is neither retried forever nor left queued to fire the moment the
   *      flag flips (Requirement 12.11).
   *
   * Rails 1 and 3 apply to BOTH payload shapes including the pre-existing
   * user-scoped one, which has the LARGER blast radius -- exempting it would
   * leave the widest revoke the least observable and the least bounded one
   * (Requirement 12.15). That means the three pre-existing user-scoped call
   * sites now also need `DEVICE_MGMT_REVOKE_ENABLED=true` before they revoke
   * anything; that is exactly Requirement 12.11's intent, and disarmed they
   * complete as dry-runs rather than failing.
   *
   * Everything else is unchanged: no-match is still a successful no-op, success
   * is still gated on `revokeCertificates`' verification, and thrown Marti
   * errors still flow through `classifyTakServerError`'s retryable/permanent
   * split.
   *
   * @param {object} payload the parsed operation payload.
   * @param {object|null} [operation] the `sync_operations` row, when this was
   *   dispatched from the queue. Supplies `operationId`/`actingUserId` for the
   *   audit record and is what a rail abort writes its terminal
   *   permanently-failed state onto. A direct call without it still runs every
   *   rail; only the terminal-state write is unavailable (see
   *   `RevokeRailAbortError`).
   */
  async revokeTakCertificates(payload, operation = null) {
    const operationId = operation ? operation.id : null;
    // `sync_operations.created_by` is the acting user -- the admin or user who
    // requested the revoke, or null for a system call site (`Team.delete`'s
    // bulk enqueue). NOT `payload.target_user_id`, which is the SUBJECT of the
    // revoke, not its author.
    const actingUserId = operation && operation.created_by !== undefined ? operation.created_by : null;
    const capLimit = getRevokeMaxCerts();
    const dryRun = !isDeviceMgmtRevokeEnabled();

    // --- Resolution (before any gate; no DELETE anywhere below this line
    // --- until rail 4 has passed) ---------------------------------------
    const { certificates, revokedViewCountBefore } = await this.fetchRevokeResolutionInputs(payload);
    const resolved = this.resolveRevokeTargets(payload, certificates);
    const { payloadShape, clientUid, targetCertIds, clientUids, unresolvedReason } = resolved;
    const targetCertCount = targetCertIds.length;

    // --- Rail 1: the Revoke_Audit_Record (Requirements 12.14, 12.15, 12.16) --
    // Identifiers only. No credential material and no passphrase reaches this
    // record, or any other line in this handler (Requirements 2.11, 9.2).
    const auditRecord = {
      operationId,
      actingUserId,
      payloadShape,
      clientUid,
      // The FULL list, never truncated (Requirement 12.14). Sorted so the
      // logged list, the digest, and the id list handed to the `DELETE` are all
      // the same sequence and a shortened one is detectable by comparison.
      targetCertIds,
      targetCertCount,
      targetCertIdsDigest: revokeTargetDigest(targetCertIds),
      // Not part of the specified shape, but the resolved uids are what makes
      // the user-scoped shape's blast radius (and a multi-uid abort) legible.
      resolvedClientUids: Array.from(clientUids),
      capLimit,
      dryRun,
      revokedViewCountBefore
    };
    logger.info(auditRecord, 'revoke_audit');

    // A payload this handler cannot resolve to a target set must never fall
    // through to a `DELETE` with an empty or wrongly-derived one, and must not be
    // retried 48 times against a payload no retry will teach it to resolve. Both
    // SHAPES resolve as of task 19.3; what reaches this gate now is a
    // device-scoped payload whose `client_uid` is present but blank -- schema-
    // valid, and identifying no Device (see `resolveRevokeTargets`).
    if (unresolvedReason) {
      throw await this.abortRevoke(operation, auditRecord, {
        reason: 'revoke_unsupported_payload_shape',
        details: unresolvedReason
      });
    }

    // --- Rail 2: exactly one `client_uid`, device-scoped shape only (12.12) --
    if (payloadShape === 'client_uid' && clientUids.size > 1) {
      throw await this.abortRevoke(operation, auditRecord, {
        reason: 'revoke_multiple_client_uids',
        details:
          `a device-scoped revoke of "${clientUid}" resolved ${targetCertCount} certificate(s) ` +
          `spanning ${clientUids.size} distinct client_uid(s): ${Array.from(clientUids).join(', ')}`
      });
    }

    // --- Rail 3: the Revoke_Blast_Radius_Cap (12.13, 12.15) -----------------
    // Fails closed on the WHOLE operation. Deliberately no truncation: see
    // this method's doc comment and Requirement 12.13.
    if (targetCertCount > capLimit) {
      throw await this.abortRevoke(operation, auditRecord, {
        reason: 'revoke_cap_exceeded',
        details:
          `resolved ${targetCertCount} target certificate(s), over the ` +
          `DEVICE_MGMT_REVOKE_MAX_CERTS cap of ${capLimit}; refusing the whole operation ` +
          'rather than truncating it to the cap'
      });
    }

    // The pre-existing no-match no-op, unchanged in outcome (a successful
    // operation, no `DELETE`, no `tak_devices` write) -- it just now sits after
    // the audit record, so a revoke that targeted nothing is as answerable as
    // one that targeted everything.
    if (targetCertCount === 0) {
      logger.debug(
        { operationId, payloadShape, clientUid, takUsernames: payload.tak_usernames },
        'No TAK Server certificates matched this revoke payload; nothing to revoke'
      );
      return;
    }

    // --- Rail 4: the dry-run (12.11) ---------------------------------------
    // Last gate before the DELETE, and a SUCCESS rather than a failure: a
    // disarmed revoke that failed would be retried until its retries were
    // exhausted, and one left pending would fire the instant the flag flipped.
    if (dryRun) {
      logger.warn(
        {
          operationId,
          payloadShape,
          clientUid,
          targetCertCount,
          targetCertIdsDigest: auditRecord.targetCertIdsDigest,
          dryRun: true,
          revokedFlagFlipped: false,
          capability: 'DEVICE_MGMT_REVOKE_ENABLED'
        },
        'revoke_dry_run: revocation is disarmed; no DELETE issued and no revoked flag flipped'
      );
      return;
    }

    let result;
    try {
      result = await this.takServerService.revokeCertificates(targetCertIds);
    } catch (error) {
      throw this.classifyTakServerError(error, 'Failed to revoke TAK Server certificates');
    }

    if (!result.success) {
      // Requirement 26.5/26.8: a verified-failed revocation (not every
      // targeted id confirmed revoked on re-query) is a failure that
      // should be retried, but it is not an "unreachable/error response"
      // -- it's a plain Error, so it flows through the default
      // (retryable) handleOperationError path rather than being
      // classified via TakServerApiError.
      //
      // Requirement 12.14: the outcome record is emitted for the UNVERIFIED
      // case too, before the throw -- "we issued the DELETE and it did not
      // verify" is precisely the outcome that has to be on the record.
      const revokedViewCountAfterUnverified = await this.countRevokedCertificates();
      logger.warn(
        {
          operationId,
          clientUid,
          targetCertCount,
          verified: false,
          unverified: result.unverified,
          revokedViewCountAfter: revokedViewCountAfterUnverified,
          revokedFlagFlipped: false
        },
        'revoke_audit_result'
      );
      throw new Error(
        `TAK Server certificate revocation not confirmed for id(s): ${result.unverified.join(', ')}`
      );
    }

    // Feature device-management, Requirement 7.6/8.7 (task 9.1): the
    // revocation is now CONFIRMED (`revokeCertificates` re-queried TAK Server
    // and verified every targeted id), so the Device_Table rows for those
    // certificates are marked revoked. Reached only past the verify-before-
    // success check above, and never on the no-match no-op path (which returns
    // earlier), so `revoked` is only ever flipped for devices whose
    // certificate revocation TAK Server actually confirmed.
    //
    // Requirement 12.8 (task 19.3): for the device-scoped shape these resolved
    // uids are exactly the ONE target `client_uid` -- every id revoked above was
    // selected by its `clientUid` equalling it -- so no other Device of the same
    // user has its flag flipped. The user-scoped shape still spans that user's
    // Devices, which is its documented, legitimate scope (Requirement 12.3).
    const revokedViewCountAfter = await this.countRevokedCertificates();
    const flippedRows = await this.markDevicesRevoked(clientUids);

    logger.info(
      {
        operationId,
        clientUid,
        targetCertCount,
        verified: true,
        unverified: [],
        revokedViewCountAfter,
        revokedFlagFlipped: flippedRows > 0
      },
      'revoke_audit_result'
    );
  }

  /**
   * Feature device-management, Requirements 12.14/12.16 (task 24.3): fetches
   * everything the resolution and the audit record need from TAK Server, in one
   * concurrent round.
   *
   * The certificate view fetched depends on the payload shape
   * (`revokePayloadShape`), because the two shapes resolve against different
   * sets -- but EITHER way the catalog is fetched exactly ONCE per operation,
   * never once per target (task 48.4's "single bulk batch fetching the
   * certificate catalog once"):
   *
   * - `tak_usernames` (user-scoped): `listCertificates()`, keeping its
   *   pre-existing contract exactly -- called once regardless of how many
   *   usernames the payload carries, with any failure propagating as a
   *   classified `TakServerApiError` under the same message as before, so the
   *   retryable/permanent semantics of a TAK Server outage are untouched.
   * - `client_uid` (device-scoped, task 19.3): `listLiveCertificates()`, the
   *   Live_Certificates -- in `/active` AND NOT in `/revoked`. `/active` is NOT
   *   the live set and must never be used as one here (Requirement 11.2): 90 of
   *   its 95 certificates also appeared in `/revoked` live, so resolving a
   *   device-scoped revoke out of it would re-target certificates TAK Server
   *   already lists as revoked. The set difference is `listLiveCertificates()`'s
   *   own job (Requirements 4.3/11.2) rather than something recomputed here, so
   *   the Device_Sync and the Revoke_Operation agree on what "live" means.
   *   Failures of EITHER underlying view propagate through it and are classified
   *   here identically -- a `/revoked` outage fails this shape's resolution
   *   rather than silently promoting revoked certificates back to live
   *   (Requirements 14.1, 14.2).
   *
   * The Revoked_Certificate_View size is fetched ALONGSIDE it (not after), so
   * `revokedViewCountBefore` costs no added latency, and via a
   * never-throwing read: today this count feeds the audit record only, and a
   * `/revoked` outage must not newly break a revoke path that did not depend on
   * that view before this task. It records `null` -- explicitly "we could not
   * ask" -- rather than `0`, which would read as "nothing was revoked" and is
   * the confusion Requirements 14.1/14.2 exist to prevent. The device-scoped
   * shape's CORRECTNESS dependency on `/revoked` is a separate matter and
   * propagates through `listLiveCertificates()` above; this count stays advisory
   * for both shapes, which is why it is read independently even where that reads
   * the same view twice in one round -- a failing advisory count must not fail an
   * operation, and a failing resolution must not be masked by a count that
   * happened to succeed.
   *
   * @param {object} payload the parsed operation payload; its shape selects
   *   which certificate view the resolution runs against.
   * @returns {Promise<{certificates: Array<object>, revokedViewCountBefore: number|null}>}
   */
  async fetchRevokeResolutionInputs(payload) {
    const deviceScoped = revokePayloadShape(payload) === 'client_uid';
    const certificatesPromise = deviceScoped
      ? this.takServerService.listLiveCertificates()
      : this.takServerService.listCertificates();

    const [certificatesResult, revokedViewCountBefore] = await Promise.all([
      certificatesPromise.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error })
      ),
      this.countRevokedCertificates()
    ]);

    if (!certificatesResult.ok) {
      throw this.classifyTakServerError(
        certificatesResult.error,
        deviceScoped
          ? 'Failed to list TAK Server live certificates'
          : 'Failed to list TAK Server certificates'
      );
    }

    return { certificates: certificatesResult.value, revokedViewCountBefore };
  }

  /**
   * Feature device-management, Requirement 12.16 (task 24.3): the size of the
   * Revoked_Certificate_View, for the audit record's `revokedViewCountBefore`/
   * `revokedViewCountAfter` -- the two numbers whose difference is what a revoke
   * actually changed on TAK Server.
   *
   * NEVER throws. This is an observability read on both sides of a destructive
   * action: on the pre-flight side it must not fail an operation that did not
   * previously depend on `/revoked`, and on the post-flight side the
   * certificates are already revoked and verified, so failing the operation
   * there would mark a completed revocation as failed and send the retry back
   * at a catalog that no longer lists them. A failure records `null`, never
   * `0`.
   *
   * @returns {Promise<number|null>} the view size, or null when it could not be read.
   */
  async countRevokedCertificates() {
    try {
      const revoked = await this.takServerService.listRevokedCertificates();
      return Array.isArray(revoked) ? revoked.length : null;
    } catch (error) {
      logger.warn(
        { err: error },
        'revoke_audit: could not read the Revoked_Certificate_View size; recording null'
      );
      return null;
    }
  }

  /**
   * Feature device-management, Requirements 12.1/12.15 (tasks 24.3, 19.3):
   * resolves a
   * `revoke_tak_certificates` payload to the shape every rail operates on --
   * `{ payloadShape, clientUid, targetCertIds, clientUids }` -- so the gates are
   * written against the RESOLVED set and are shape-agnostic apart from the one
   * rail (single-`client_uid`) that is deliberately shape-specific.
   *
   * Pure and synchronous: it takes the already-fetched catalog, so it makes no
   * TAK Server call of its own and adding a payload branch here cannot add a
   * round trip.
   *
   * - `tak_usernames` (user-scoped, the three pre-existing call sites): matches
   *   every certificate whose `creatorDn` matches any payload username via the
   *   same `matchesCreatorDn` predicate `TakServerService.findCertificatesForUser`
   *   uses internally -- unchanged behaviour, including that this legitimately
   *   spans a user's Devices.
   * - `client_uid` (device-scoped, this feature's per-Device Revoke, task 19.3):
   *   matches every certificate whose `clientUid` EQUALS the payload's, and
   *   nothing else. For this shape `certificates` is the Live_Certificate view
   *   (in `/active`, NOT in `/revoked`), which `fetchRevokeResolutionInputs`
   *   fetched via `TakServerService.listLiveCertificates()` -- so the target set
   *   is that Device's live certificates and an already-revoked id is never
   *   re-targeted (Requirement 12.1).
   *
   *   `creatorDn` is deliberately NOT consulted for this shape: distinct Devices
   *   SHARE a `creatorDn` (one per enrolling user), so `matchesCreatorDn`
   *   resolved every certificate the user held across all their Devices -- the
   *   over-revocation Requirements 7.4/8.4/12.1 exist to correct. `clientUid`
   *   reuse across certificates is the normal case (95 certificates carried 10
   *   distinct `clientUid`s live, one of them holding 60), so a Device's target
   *   set is routinely many ids; that breadth is what the blast-radius cap
   *   bounds, not something to de-duplicate here. `revocationDate` is likewise
   *   never read (Requirement 12.5): all 95 of those live certificates carried a
   *   non-null one, so any such check is vacuous.
   *
   * `clientUids` collects the resolved certificates' `clientUid`s in the SAME
   * pass as their ids, since the Device_Table is keyed on `client_uid` while the
   * Marti revoke API takes cert ids -- so the device rows flipped after a
   * confirmed revoke correspond exactly to the ids that were revoked, and the
   * single-`client_uid` rail sees exactly the uids the `DELETE` would touch.
   * Certificates carrying no usable `clientUid` (an older enrollment, or a
   * catalog shape without the field) are still revoked; they simply have no
   * Device_Table row to flip.
   *
   * @param {object} payload
   * @param {Array<object>} certificates the once-fetched TAK Server catalog --
   *   `listCertificates()` for the user-scoped shape, the Live_Certificates for
   *   the device-scoped one, per `fetchRevokeResolutionInputs`.
   * @returns {{payloadShape: string, clientUid: string|null, targetCertIds: Array<number>,
   *   clientUids: Set<string>, unresolvedReason: string|null}} `unresolvedReason`
   *   is non-null only for a payload this cannot resolve to a target set at all
   *   (today: a blank device-scoped `client_uid`), which the caller records and
   *   refuses permanently rather than resolving into an arbitrary set.
   */
  resolveRevokeTargets(payload, certificates) {
    const clientUids = new Set();
    const certIds = new Set();

    // The two shapes are mutually exclusive and `validatePayloadSchema`'s
    // `exactlyOneOf` has already rejected a payload carrying both or neither,
    // so the discriminator is unambiguous by the time it gets here.
    if (revokePayloadShape(payload) === 'client_uid') {
      const targetClientUid = payload.client_uid;

      // A blank `client_uid` is schema-valid (`typeof '' === 'string'`) but
      // identifies no Device, and matching it against the catalog would select
      // exactly the certificates carrying NO usable `clientUid` -- certificates
      // that belong to no Device row at all. Refused as unresolvable rather
      // than resolved into a target set nobody asked for.
      if (typeof targetClientUid !== 'string' || targetClientUid.length === 0) {
        return {
          payloadShape: 'client_uid',
          clientUid: targetClientUid,
          targetCertIds: [],
          clientUids,
          unresolvedReason:
            'the device-scoped payload carries an empty client_uid, which identifies no Device; ' +
            'refusing rather than issuing a DELETE against an unresolved target set'
        };
      }

      for (const cert of certificates) {
        if (cert.clientUid === targetClientUid) {
          certIds.add(cert.id);
          clientUids.add(cert.clientUid);
        }
      }

      return {
        payloadShape: 'client_uid',
        clientUid: targetClientUid,
        targetCertIds: sortCertIds(certIds),
        // Exactly `{ targetClientUid }` when anything matched, empty otherwise:
        // every id above was selected BY its `clientUid` equalling this one, so
        // the Device_Table flip after a confirmed revoke can only ever touch the
        // target Device and no other Device of the same user (Requirement 12.8).
        clientUids,
        unresolvedReason: null
      };
    }

    for (const takUsername of payload.tak_usernames) {
      for (const cert of certificates) {
        if (matchesCreatorDn(cert.creatorDn, takUsername)) {
          certIds.add(cert.id);
          if (typeof cert.clientUid === 'string' && cert.clientUid.length > 0) {
            clientUids.add(cert.clientUid);
          }
        }
      }
    }

    return {
      payloadShape: 'tak_usernames',
      clientUid: null,
      targetCertIds: sortCertIds(certIds),
      clientUids,
      unresolvedReason: null
    };
  }

  /**
   * Feature device-management, Requirements 12.12/12.13 (task 24.3): the shared
   * tail of every rail abort. Records the refusal against the same audit record
   * the rails were evaluated on, writes the operation's terminal
   * permanently-failed state, and RETURNS the error for the caller to throw (so
   * the abort reads as `throw await this.abortRevoke(...)` at the rail, keeping
   * the control flow visible at the gate rather than buried in a helper).
   *
   * Permanently failed, not retryable, for both rails: a target set spanning
   * two Devices and a target set over the cap are properties of the resolution,
   * so the identical operation re-run resolves the identical refused set. The
   * fix is a corrected resolution or a deliberately raised cap plus a fresh
   * enqueue -- not 48 retries, each of which would re-fetch the whole TAK
   * Server catalog to arrive at the same refusal.
   *
   * @param {object|null} operation
   * @param {object} auditRecord the record already logged by rail 1.
   * @param {{reason: string, details: string}} refusal
   * @returns {Promise<RevokeRailAbortError>} the error to throw.
   */
  async abortRevoke(operation, auditRecord, { reason, details }) {
    logger.error(
      {
        operationId: auditRecord.operationId,
        payloadShape: auditRecord.payloadShape,
        clientUid: auditRecord.clientUid,
        resolvedClientUids: auditRecord.resolvedClientUids,
        targetCertCount: auditRecord.targetCertCount,
        targetCertIdsDigest: auditRecord.targetCertIdsDigest,
        capLimit: auditRecord.capLimit,
        reason,
        details,
        revokedFlagFlipped: false
      },
      'revoke_abort: refused before issuing any DELETE'
    );

    if (!operation) {
      return new RevokeRailAbortError(`${reason}: ${details}`, { alreadyHandled: false });
    }

    await this.markPermanentlyFailed(operation, {
      reason,
      details,
      failureCategory: 'permanent'
    });

    return new RevokeRailAbortError(`${reason}: ${details}`);
  }

  /**
   * Feature device-management, Requirement 7.6/8.7 (task 9.1): flips the
   * Device_Table `revoked` flag for the given `client_uid`s after a confirmed
   * certificate revocation.
   *
   * Gated on `isDeviceMgmtEnabled()` (Requirement 9.5): WHILE the feature is
   * off there is no Device_Table data to maintain, so no write is issued and
   * the revoke handler behaves exactly as it did before this feature.
   *
   * A failure of this update NEVER fails the operation. The success semantics
   * of `revoke_tak_certificates` stay driven entirely by
   * `revokeCertificates`' verification: the certificates ARE revoked on TAK
   * Server at this point, and throwing here would both mark a successful
   * revocation as failed and cause the retry to re-run the whole handler
   * against certificates that no longer appear in the (already-revoked)
   * catalog. The stale `revoked = false` flag is a display-only inaccuracy
   * that the Device_Sync self-heals, and it is genuinely transient: the next
   * completed sync finds no Live_Certificate for that `clientUid` -- every
   * certificate carrying it is now in the Revoked_Certificate_View -- so the
   * uid is absent from that run's Live_Device_Set and the row is DELETED
   * (Requirements 17.1, 17.7). So the error is logged and swallowed.
   *
   * That swallow used to be justified by a different, WRONG claim, corrected
   * here in place: "a revoked certificate drops out of the Active_Certificate
   * view, so the row stops being refreshed". Both halves were false. A revoked
   * certificate does NOT drop out of `/active` -- verified live, 90 of the 95
   * certificates that view returned also appeared in `/revoked`, which is why
   * the live set must be computed as the difference between the two views
   * (Requirement 11.2) -- and nothing ever consumed the resulting staleness:
   * `last_polled_at` is sync bookkeeping, not a visibility input, and
   * `DeviceManagementService.listOwnDevices` has no freshness or `revoked`
   * predicate (Requirement 17.8). Deletion by the sync, not a row going stale,
   * is what makes the flag's inaccuracy short-lived.
   *
   * @param {Set<string>|Array<string>} clientUids the `clientUid`s of the
   *   confirmed-revoked certificates.
   * @returns {Promise<number>} the number of Device_Table rows updated (0 when
   *   the feature is disabled, when no matched certificate carried a
   *   `clientUid`, when no matching row exists, or when the update failed).
   */
  async markDevicesRevoked(clientUids) {
    if (!isDeviceMgmtEnabled()) return 0;

    const uids = Array.from(clientUids);
    if (uids.length === 0) return 0;

    try {
      const result = await this.pool.query(
        `UPDATE tak_devices
            SET revoked = true
          WHERE client_uid = ANY($1::text[])`,
        [uids]
      );

      const updated = result.rowCount || 0;
      logger.debug(
        { clientUids: uids, updated },
        'Marked device(s) revoked after confirmed certificate revocation'
      );

      return updated;
    } catch (error) {
      // Deliberately non-fatal: see this method's doc comment.
      logger.error(
        { err: error, clientUids: uids },
        'Failed to mark device(s) revoked after confirmed certificate revocation; ' +
          'the certificate revocation itself succeeded'
      );
      return 0;
    }
  }

  /**
   * Requirement 26.8: classifies an error caught from a
   * `TakServerService` call (an axios error) as 'retryable' or
   * 'permanent' via the existing `classifyFailure` mechanism, and wraps
   * it in a `TakServerApiError` carrying that classification.
   *
   * An axios error response's HTTP status lives at `error.response.status`
   * (unlike the `fetch()`-based handlers elsewhere in this file, which
   * inspect `response.status` directly) -- when no `response` is present
   * at all (network/timeout failure, the request never reached TAK
   * Server), `classifyFailure` is instead given the caught `Error`
   * itself, which it always treats as retryable.
   *
   * @param {Error} error
   * @param {string} messagePrefix
   * @returns {TakServerApiError}
   */
  classifyTakServerError(error, messagePrefix) {
    const status = error.response && error.response.status;
    const classification = classifyFailure(status !== undefined ? status : error);
    return new TakServerApiError(`${messagePrefix}: ${error.message}`, classification);
  }

  /**
   * region-channel-tiers (task 8): rewritten to remove the former
   * private-team branch entirely (per explicit product decision: a
   * private team's members are treated IDENTICALLY to any other team's
   * for global-channel purposes -- private Team_Visibility is about
   * directory/listing scope, not about operational channel access) and
   * to make Response/Support region-channel membership a genuine
   * RECONCILE (add AND remove) driven by the user's Organisation's two
   * flags, rather than the former one-directional "always add" logic.
   *
   * This ALSO fixes a pre-existing dead-code bug: the former
   * `isPrivateTeamUser` branch read `region_channels.read_group_id`, a
   * column that has never existed on that table (only `bch_channels` has
   * a read/write pair) -- every private-team user therefore received
   * ZERO region-channel access in practice, silently. There is no
   * equivalent column to carry forward; region channels are still a
   * single group per channel.
   *
   * BCH channels are UNCHANGED in spirit: every active user still gets
   * unconditional read-group membership, never removed. Region channels
   * (both tiers) are now genuinely reconciled: an Organisation's flag
   * being `true` ensures membership (adding if missing) and `false`
   * ensures NON-membership (removing if present) -- not merely "add if
   * true, do nothing if false" as before.
   *
   * The "current" side of the reconcile is scoped ONLY to the group ids
   * this function itself manages (every BCH read_group_id and every
   * region group_id) -- computed as the INTERSECTION of the user's
   * actual current Authentik group memberships (fetched fresh via
   * `GET /core/users/{authentik_user_id}/`, whose `.groups` field is the
   * same list-of-pks shape `authentikSync.js`'s user-list sync already
   * relies on) with that managed set. This is deliberate and load-bearing:
   * a user's Team/Sub_Team channel groups, and any other group membership
   * entirely unrelated to global channels, must never be touched by this
   * reconcile -- only intersecting first guarantees `toRemove` can never
   * contain a group this function doesn't own.
   *
   * The user's Organisation is resolved from their Direct_Membership
   * (`team_memberships` row with `inherited_from_team_id IS NULL` --
   * there is at most one, per the partial unique index) via
   * `Team.getAncestorChain(directTeamId)[0]`. A teamless user (no
   * Direct_Membership row) has no Organisation and therefore no
   * Response/Support flags to satisfy -- they are reconciled toward
   * zero region-channel membership (any prior region-channel membership
   * is removed), while still keeping their unconditional BCH read access.
   */
  async assignUserToGlobalChannels(payload) {
    const user = await this.getUser(payload.target_user_id);
    if (!user) throw new Error(`User ${payload.target_user_id} not found`);

    // Resolve the user's Organisation via their Direct_Membership (at
    // most one row, per the product vocabulary's partial unique index).
    // A teamless user has no Direct_Membership row and therefore no
    // Organisation -- both flags are treated as `false` in that case,
    // which reconciles them toward zero region-channel membership.
    const directMembershipResult = await this.pool.query(`
      SELECT team_id
      FROM team_memberships
      WHERE user_id = $1 AND inherited_from_team_id IS NULL
      LIMIT 1
    `, [payload.target_user_id]);

    let responseChannelAccess = false;
    let supportChannelAccess = false;
    if (directMembershipResult.rows.length > 0) {
      const ancestorChain = await Team.getAncestorChain(directMembershipResult.rows[0].team_id);
      const organisation = ancestorChain[0];
      if (organisation) {
        responseChannelAccess = Boolean(organisation.response_channel_access);
        supportChannelAccess = Boolean(organisation.support_channel_access);
      }
    }

    // Every BCH channel's read group -- unconditional target for every
    // active user, exactly as before. Never removed: BCH read access has
    // no org-flag gate.
    const bchResult = await this.pool.query(`
      SELECT read_group_id
      FROM bch_channels
      WHERE read_group_id IS NOT NULL
    `);
    const bchReadGroupIds = bchResult.rows.map((row) => row.read_group_id);

    // Every region channel's single group, grouped by tier.
    const regionResult = await this.pool.query(`
      SELECT group_id, tier
      FROM region_channels
      WHERE group_id IS NOT NULL
    `);
    const responseGroupIds = regionResult.rows
      .filter((row) => row.tier === 'response')
      .map((row) => row.group_id);
    const supportGroupIds = regionResult.rows
      .filter((row) => row.tier === 'support')
      .map((row) => row.group_id);

    // The full set of group ids this function is responsible for --
    // BCH read groups plus every region group of either tier -- used
    // below to scope "current membership" to ONLY the groups this
    // reconcile owns, so a user's Team/Sub_Team groups (or anything
    // else) can never appear in `toRemove`.
    const managedGroupIds = new Set([...bchReadGroupIds, ...responseGroupIds, ...supportGroupIds]);

    // Target: BCH always, plus each tier's region groups only if the
    // Organisation's corresponding flag is true.
    const targetGroupIds = [
      ...bchReadGroupIds,
      ...(responseChannelAccess ? responseGroupIds : []),
      ...(supportChannelAccess ? supportGroupIds : [])
    ];

    // Current: the user's actual Authentik group memberships, fetched
    // fresh (not from any local cache), intersected with managedGroupIds.
    let currentManagedGroupIds = [];
    if (user.authentik_user_id) {
      const userResponse = await fetch(
        `${process.env.AUTHENTIK_URL}/api/v3/core/users/${user.authentik_user_id}/`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!userResponse.ok) {
        const classification = classifyFailure(userResponse.status);
        throw new AuthentikApiError(
          `Failed to fetch current Authentik group membership for user ${payload.target_user_id}: ${userResponse.statusText}`,
          classification
        );
      }

      const authentikUser = await userResponse.json();
      const currentGroupIds = Array.isArray(authentikUser.groups) ? authentikUser.groups : [];
      currentManagedGroupIds = currentGroupIds.filter((groupId) => managedGroupIds.has(groupId));
    }

    const { toAdd, toRemove } = computeMembershipDiff(currentManagedGroupIds, targetGroupIds);

    for (const groupId of toAdd) {
      try {
        await this.addUserToGroup({
          target_user_id: payload.target_user_id,
          target_group_id: groupId
        });
      } catch (error) {
        logger.error({ target_user_id: payload.target_user_id, groupId, err: error }, 'Failed to add user to global channel group');
        // Continue with other groups even if one fails.
      }
    }

    for (const groupId of toRemove) {
      try {
        await this.removeUserFromGroup({
          target_user_id: payload.target_user_id,
          target_group_id: groupId
        });
      } catch (error) {
        logger.error({ target_user_id: payload.target_user_id, groupId, err: error }, 'Failed to remove user from global channel group');
        // Continue with other groups even if one fails.
      }
    }

    logger.debug(
      {
        target_user_id: payload.target_user_id,
        responseChannelAccess,
        supportChannelAccess,
        added: toAdd.length,
        removed: toRemove.length
      },
      'Reconciled global channel membership for user'
    );

    // Update bulk operation progress
    if (payload.bulk_operation_id) {
      await this.pool.query(`
        UPDATE bulk_operations 
        SET processed_items = processed_items + 1,
            progress_percentage = (processed_items::decimal / total_items) * 100
        WHERE id = $1
      `, [payload.bulk_operation_id]);
    }
  }

  /**
   * region-channel-tiers (task 9): reconciles a single Organisation's
   * Response/Support region-channel membership after
   * `PUT /api/teams/:teamId/channel-access` changes one of
   * `response_channel_access`/`support_channel_access` (`server/routes/
   * teams.js` enqueues this operation ONLY for the tier that actually
   * changed value, with payload `{ organisation_id, tier }`).
   *
   * Deliberately does NOT reimplement the add/remove reconcile itself --
   * `assignUserToGlobalChannels` (task 8) is already a full, idempotent,
   * per-user reconcile driven by the SAME two Organisation flags this
   * handler is reacting to. So the simplest and most correct
   * implementation is exactly what `GlobalChannelService.
   * assignAllUsersToGlobalChannels` already does for the "reconcile
   * everyone" case, scoped down to "reconcile everyone under this one
   * Organisation": resolve every user with a Direct_Membership
   * (`inherited_from_team_id IS NULL`) row on the Organisation or any of
   * its Sub_Teams (via `Team.getOrganisationTeams`, the existing
   * whole-tree-of-Teams primitive), then enqueue one
   * `assign_user_to_global_channels` operation per user, wrapped in a
   * `bulk_operations` progress record for visibility -- the exact same
   * enqueue shape `assignAllUsersToGlobalChannels` uses, just scoped to
   * one Organisation's membership instead of every active user.
   *
   * `payload.tier` is read for logging only (which flag triggered this)
   * -- the fan-out itself is tier-agnostic, since
   * `assignUserToGlobalChannels` always reconciles BOTH tiers together
   * for a user in one pass; there is no narrower "reconcile only the
   * Response side" primitive to call, and building one would duplicate
   * logic that already exists and is already correct.
   */
  async resyncOrgChannelTierAccess(payload) {
    const { organisation_id, tier } = payload;

    const orgTeams = await Team.getOrganisationTeams(organisation_id);
    if (orgTeams.length === 0) {
      logger.debug({ organisation_id, tier }, 'No teams found for Organisation; nothing to reconcile');
      return;
    }

    const teamIds = orgTeams.map((team) => team.id);
    const userIdsResult = await this.pool.query(`
      SELECT DISTINCT user_id
      FROM team_memberships
      WHERE team_id = ANY($1::int[]) AND inherited_from_team_id IS NULL
    `, [teamIds]);
    const userIds = userIdsResult.rows.map((row) => row.user_id);

    if (userIds.length === 0) {
      logger.debug({ organisation_id, tier }, 'No Direct_Membership users found under Organisation; nothing to reconcile');
      return;
    }

    const bulkOpId = await EventPublisher.publishBulkOperation(
      `Reconcile ${tier} channel access for ${userIds.length} user(s) in Organisation ${organisation_id}`,
      userIds.length,
      null // System operation, triggered by an Organisation flag change.
    );

    for (const userId of userIds) {
      await EventPublisher.publishOperation('assign_user_to_global_channels', {
        target_user_id: userId,
        bulk_operation_id: bulkOpId
      });
    }

    logger.info(
      { organisation_id, tier, usersQueued: userIds.length, bulkOperationId: bulkOpId },
      'Queued global channel reconciliation for Organisation after channel-access flag change'
    );
  }

  async syncExistingGlobalChannels(payload) {
    logger.debug('Syncing existing global channels from Authentik');
    
    let bchCount = 0;
    let regionCount = 0;
    
    try {
      // Get all groups from Authentik, following pagination -- a single
      // page (even at page_size=1000) is not guaranteed to cover every
      // group once teams, BCH, and Region groups are all counted
      // together, and any BCH/Region group landing past the first page
      // would otherwise be silently skipped. Mirrors the pagination loop
      // in server/services/authentikSync.js's fetchGroupMap().
      let groups = [];
      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const groupsResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/?page_size=1000&page=${currentPage}`, {
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });

        if (!groupsResponse.ok) {
          const classification = classifyFailure(groupsResponse.status);
          throw new AuthentikApiError(`Failed to fetch groups from Authentik: ${groupsResponse.statusText}`, classification);
        }

        const groupsData = await groupsResponse.json();
        groups = groups.concat(groupsData.results);

        if (groupsData.pagination && groupsData.pagination.next) {
          currentPage = groupsData.pagination.next;
        } else {
          hasMorePages = false;
        }
      }
      
      logger.debug({ groupCount: groups.length }, 'Found groups in Authentik');
      
      // Define separator at the top
      const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
      
      // Process BCH/UTL channels (groups starting with 'tak_BCH'/'tak_UTL'
      // -- the two BCH_CHANNEL_CATEGORY_PREFIX values), mirroring exactly
      // how the region-channel loop below iterates
      // REGION_CHANNEL_TIER_PREFIX instead of matching one hardcoded
      // prefix. Unlike region channels, a BCH/UTL channel is a read/write
      // GROUP PAIR per channel (`bch_channels` has both `read_group_id`
      // and `write_group_id`, no single-group shape), so recognition
      // keys off the `_READ` suffix and looks up its sibling write group
      // by exact name equality, same as before category existed.
      for (const [category, categoryPrefixValue] of Object.entries(BCH_CHANNEL_CATEGORY_PREFIX)) {
        const bchPrefix = `tak_${categoryPrefixValue}${separator}`;

        for (const group of groups) {
          if (!(group.name.startsWith(bchPrefix) && group.name.endsWith('_READ'))) continue;

          // Extract channel name from read group
          const channelName = group.name.replace(bchPrefix, '').replace('_READ', '');
          
          // Find corresponding write group (without _READ suffix)
          const writeGroupName = `tak_${categoryPrefixValue}${separator}${channelName}`;
          const writeGroup = groups.find(g => g.name === writeGroupName);
          
          // Use write group's description if available, otherwise fall back to read group
          const description = writeGroup?.attributes?.description || group.attributes?.description || `${categoryPrefixValue} Channel - ${channelName}`;
          
          // Check if this channel already exists in database. Scoped to
          // this group's OWN category, not just by name -- a "Data
          // Packages" BCH channel and a "Data Packages" UTL channel are
          // two distinct rows sharing a display name, exactly like the
          // region loop's per-tier scoping below.
          const existingResult = await this.pool.query(
            'SELECT id FROM bch_channels WHERE name ILIKE $1 AND category = $2',
            [channelName, category]
          );
          
          if (existingResult.rows.length === 0) {
            logger.debug({ channelName, category }, 'Importing BCH/UTL channel');
            
            // Create channel in database. display_name is NOT NULL with no
            // default (see baseline schema) -- mirrors channelName, same as
            // every other channel-like table's name/display_name pair.
            const insertResult = await this.pool.query(`
              INSERT INTO bch_channels (
                name, display_name, description, read_group_id, write_group_id, category, created_by
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)
              RETURNING id
            `, [
              channelName,
              channelName,
              description,
              group.pk,
              writeGroup?.pk || null,
              category,
              payload.synced_by
            ]);
            
            bchCount++;
            logger.debug({ channelName, category, bchChannelId: insertResult.rows[0].id }, 'Created BCH/UTL channel');
          } else {
            // Update existing channel with correct description and group IDs
            logger.debug({ channelName, category }, 'Updating existing BCH/UTL channel');
            
            await this.pool.query(`
              UPDATE bch_channels 
              SET description = $1, read_group_id = $2, write_group_id = $3
              WHERE name ILIKE $4 AND category = $5
            `, [
              description,
              group.pk,
              writeGroup?.pk || null,
              channelName,
              category
            ]);
            
            logger.debug({ channelName, category }, 'Updated BCH/UTL channel with correct description');
          }
        }
      }
      
      // Process Region channels (groups starting with 'tak_Response' or
      // 'tak_Support' -- the two REGION_CHANNEL_TIER_PREFIX values).
      // Unlike BCH channels, region channels are a SINGLE Authentik group
      // per channel -- region_channels has only a `group_id` column, no
      // `read_group_id`/write-pair (confirmed against the baseline schema
      // and live DB; there is no "_READ" counterpart group for regions in
      // Authentik). Every group matching either prefix is its own
      // channel, tagged with the tier its prefix identifies. No handling
      // for the FORMER single, untiered `tak_Regions` prefix is needed
      // here -- every region channel in this deployment was deleted and
      // will be recreated under a tiered prefix via seedRegionChannels/
      // createRegionChannel, so a group still named `tak_Regions - X`
      // would simply not match either prefix and stay unimported (a
      // future admin who wants it imported can rename it in Authentik
      // first, exactly as any other pre-existing-but-misnamed group
      // would need to be).
      for (const [tier, tierPrefixValue] of Object.entries(REGION_CHANNEL_TIER_PREFIX)) {
        const regionPrefix = `tak_${tierPrefixValue}${separator}`;

        for (const group of groups) {
          if (!group.name.startsWith(regionPrefix)) continue;

          const channelName = group.name.replace(regionPrefix, '');

          let description = channelName;
          if (group.attributes?.description) {
            // Remove the "(Bi-directional location sharing)" suffix if present
            description = group.attributes.description.replace(' (Bi-directional location sharing)', '');
          }

          // Check if this channel already exists in database. Scoped to
          // this group's OWN tier, not just by name: a "Waikato" Response
          // channel and a "Waikato" Support channel are two distinct rows
          // sharing a display name, so matching by name alone would
          // conflate them (and Authentik's own prefix already guarantees
          // this loop iteration is only ever looking at one tier's groups).
          const existingResult = await this.pool.query(
            'SELECT id FROM region_channels WHERE name ILIKE $1 AND tier = $2',
            [channelName, tier]
          );

          if (existingResult.rows.length === 0) {
            logger.debug({ channelName, tier }, 'Importing Region channel');

            // Create channel in database. display_name is NOT NULL with no
            // default (see baseline schema) -- mirrors channelName, same as
            // every other channel-like table's name/display_name pair.
            const insertResult = await this.pool.query(`
              INSERT INTO region_channels (
                name, display_name, description, group_id, tier, created_by
              ) VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING id
            `, [
              channelName,
              channelName,
              description,
              group.pk,
              tier,
              payload.synced_by
            ]);

            regionCount++;
            logger.debug({ channelName, tier, regionChannelId: insertResult.rows[0].id }, 'Created Region channel');
          } else {
            // Update existing channel with correct description and group id
            logger.debug({ channelName, tier }, 'Updating existing Region channel');

            await this.pool.query(`
              UPDATE region_channels 
              SET description = $1, group_id = $2
              WHERE name ILIKE $3 AND tier = $4
            `, [
              description,
              group.pk,
              channelName,
              tier
            ]);

            logger.debug({ channelName, tier }, 'Updated Region channel with correct description and group id');
          }
        }
      }
      
      logger.info({ bchCount, regionCount }, 'Sync of existing global channels completed');
      
    } catch (error) {
      logger.error({ err: error }, 'Failed to sync existing channels');
      throw error;
    }
  }

  async deactivateGlobalChannel(payload) {
    // This would remove all users from the channel groups
    // Implementation depends on specific requirements
    logger.debug({ channel_id: payload.channel_id }, 'Deactivating global channel');
  }

  async getUser(userId) {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.pool.query('SELECT * FROM users WHERE id = $1', [userId]);
        return result.rows[0];
      } catch (error) {
        logger.error({ userId, attempt, err: error }, 'Failed to get user');
        if (attempt === this.maxRetries) {
          throw error;
        }
        await this.sleep(this.retryDelay * attempt);
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Start worker if run directly
if (require.main === module) {
  // Requirement 15.2/6.4: await the (now-async) config validation before
  // constructing the worker or starting the poll loop, so a missing
  // required variable or an unreachable production secrets manager exits
  // non-zero before any DB pool is opened or any operation is polled.
  validateConfig().then(() => {
    const worker = new SyncWorker();

    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await worker.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await worker.stop();
      process.exit(0);
    });

    worker.start().catch((err) => logger.error({ err }, 'Sync worker crashed'));
  });
}

module.exports = SyncWorker;
module.exports.checkSyncWorkerHeartbeatHealth = checkSyncWorkerHeartbeatHealth;
module.exports.HEARTBEAT_STALE_THRESHOLD_MS = HEARTBEAT_STALE_THRESHOLD_MS;