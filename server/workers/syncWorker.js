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
const pLimit = require('p-limit');
const authentikService = require('../services/authentik');
const TeamMembershipService = require('../services/TeamMembershipService');
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
const TakServerService = require('../services/TakServerService');
const { matchesCreatorDn } = TakServerService;
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
        await this.revokeTakCertificates(payload);
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
   * - Every key in `optionalFields` (if the schema entry declares any)
   *   that IS present on `payload` must also match its declared type;
   *   an absent optional field is not an error.
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
    const { channel_name, service_account_username, service_account_password, bch_channel_id } = payload;
    
    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
    // Create read and write groups using tak_BCH format
    const readGroupName = `tak_BCH${separator}${channel_name}_READ`;
    const writeGroupName = `tak_BCH${separator}${channel_name}`;
    
    const readGroupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: readGroupName,
        attributes: { channel_type: 'bch', permission: 'read' }
      })
    });
    
    const writeGroupResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: writeGroupName,
        attributes: { channel_type: 'bch', permission: 'write' }
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: service_account_password })
    });
    
    // Add service account to write group
    await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${writeGroup.pk}/add_user/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
  // Authentik's actual `tak_Regions - *` groups, none of which have a
  // `_READ` sibling.
  async createRegionChannelGroup(payload) {
    const { channel_name, region_channel_id } = payload;
    
    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
    const groupName = `tak_Regions${separator}${channel_name}`;
    
    logger.debug({ region_channel_id, groupName }, 'Creating region channel group');
    
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
    const { bch_channel_id, channel_name, description } = payload;
    
    logger.debug({ bch_channel_id, channel_name }, 'Updating BCH channel group');
    
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
        name: `tak_BCH${separator}${channel_name}_READ`,
        attributes: { channel_type: 'bch', permission: 'read', description }
      };
      
      logger.debug({ bch_channel_id, groupType: 'read' }, 'Updating BCH read group');
      
      const readResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${read_group_id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        name: `tak_BCH${separator}${channel_name}`,
        attributes: { channel_type: 'bch', permission: 'write', description }
      };
      
      logger.debug({ bch_channel_id, groupType: 'write' }, 'Updating BCH write group');
      
      const writeResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${write_group_id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
    
    // Get current group ID
    const channelResult = await this.pool.query(
      'SELECT group_id FROM region_channels WHERE id = $1',
      [region_channel_id]
    );
    
    if (channelResult.rows.length === 0) {
      logger.debug({ region_channel_id }, 'No region channel found with this ID');
      return;
    }
    
    const { group_id } = channelResult.rows[0];
    
    if (!group_id) {
      logger.debug({ region_channel_id }, 'No group_id set for region channel');
      return;
    }
    
    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';
    const authentikDescription = `${description} (Bi-directional location sharing)`;
    const requestBody = {
      name: `tak_Regions${separator}${channel_name}`,
      attributes: { 
        channel_type: 'region',
        description: authentikDescription
      }
    };
    
    try {
      const updateResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${group_id}/`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
          });
        }
        
        if (write_group_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/${write_group_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
          });
        }
        
        if (service_account_id) {
          await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${service_account_id}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
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
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
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
      headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
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
        headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
        { headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` } }
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
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
      { headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` } }
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
        headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
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
   * Requirement 26.8 (task 48.5): revokes every TAK Server certificate
   * belonging to each username in `payload.tak_usernames`.
   *
   * Per task 48.4's payload design ("single bulk batch fetching the
   * certificate catalog once"), this calls
   * `this.takServerService.listCertificates()` exactly ONCE regardless of
   * how many usernames the payload carries, then filters that single
   * result against every username using the same `matchesCreatorDn`
   * predicate `TakServerService.findCertificatesForUser` uses internally
   * -- rather than calling `findCertificatesForUser` once per username,
   * which would re-fetch the full certificate list from TAK Server on
   * every iteration.
   *
   * - No certificates matching any of the given usernames is treated as
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
   *   `revokeCertificates` themselves (TAK Server unreachable, timed out,
   *   or returned a non-2xx status) IS the "TAK Server unreachable/error
   *   responses" case Requirement 26.8 explicitly calls out: it is
   *   classified via the existing `classifyFailure` mechanism (5xx/
   *   network/timeout -> retryable, 4xx -> permanent) and re-thrown as a
   *   `TakServerApiError` carrying that classification, mirroring every
   *   other Authentik-calling handler's `AuthentikApiError` pattern.
   */
  async revokeTakCertificates(payload) {
    const { tak_usernames: takUsernames } = payload;

    let certificates;
    try {
      certificates = await this.takServerService.listCertificates();
    } catch (error) {
      throw this.classifyTakServerError(error, 'Failed to list TAK Server certificates');
    }

    const matchedCertIds = new Set();
    for (const takUsername of takUsernames) {
      for (const cert of certificates) {
        if (matchesCreatorDn(cert.creatorDn, takUsername)) {
          matchedCertIds.add(cert.id);
        }
      }
    }

    if (matchedCertIds.size === 0) {
      logger.debug(
        { takUsernames },
        'No TAK Server certificates matched any of the given usernames; nothing to revoke'
      );
      return;
    }

    let result;
    try {
      result = await this.takServerService.revokeCertificates(Array.from(matchedCertIds));
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
      throw new Error(
        `TAK Server certificate revocation not confirmed for id(s): ${result.unverified.join(', ')}`
      );
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

  async assignUserToGlobalChannels(payload) {
    const user = await this.getUser(payload.target_user_id);
    if (!user) throw new Error(`User ${payload.target_user_id} not found`);
    
    // Check if user belongs to a private team
    const teamResult = await this.pool.query(`
      SELECT t.visibility 
      FROM team_memberships tm
      JOIN teams t ON tm.team_id = t.id
      WHERE tm.user_id = $1
      LIMIT 1
    `, [payload.target_user_id]);
    
    const isPrivateTeamUser = teamResult.rows.length > 0 && teamResult.rows[0].visibility === 'private';
    
    // Get all global channel group IDs
    const bchResult = await this.pool.query(`
      SELECT read_group_id, write_group_id 
      FROM bch_channels 
      WHERE read_group_id IS NOT NULL
    `);
    
    const regionResult = await this.pool.query(`
      SELECT group_id, read_group_id 
      FROM region_channels 
      WHERE (group_id IS NOT NULL OR read_group_id IS NOT NULL)
    `);
    
    const groupIds = [];
    
    // Add BCH read groups (all users get read access)
    for (const bch of bchResult.rows) {
      if (bch.read_group_id) {
        groupIds.push(bch.read_group_id);
      }
    }
    
    // Add region groups based on team privacy
    for (const region of regionResult.rows) {
      if (isPrivateTeamUser && region.read_group_id) {
        // Private team users get read-only access
        groupIds.push(region.read_group_id);
      } else if (!isPrivateTeamUser && region.group_id) {
        // Regular users get read-write access
        groupIds.push(region.group_id);
      }
    }
    
    // Add user to each group
    for (const groupId of groupIds) {
      try {
        await this.addUserToGroup({
          target_user_id: payload.target_user_id,
          target_group_id: groupId
        });
      } catch (error) {
        logger.error({ target_user_id: payload.target_user_id, groupId, err: error }, 'Failed to add user to global channel group');
        // Continue with other groups even if one fails
      }
    }
    
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
            'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
      
      // Process BCH channels (groups starting with 'tak_BCH')
      const bchPrefix = `tak_BCH${separator}`;
      for (const group of groups) {
        if (group.name.startsWith(bchPrefix) && group.name.endsWith('_READ')) {
          // Extract channel name from read group
          const channelName = group.name.replace(bchPrefix, '').replace('_READ', '');
          
          // Find corresponding write group (without _READ suffix)
          const writeGroupName = `tak_BCH${separator}${channelName}`;
          const writeGroup = groups.find(g => g.name === writeGroupName);
          
          // Use write group's description if available, otherwise fall back to read group
          const description = writeGroup?.attributes?.description || group.attributes?.description || `BCH Channel - ${channelName}`;
          
          // Check if this channel already exists in database
          const existingResult = await this.pool.query(
            'SELECT id FROM bch_channels WHERE name ILIKE $1',
            [channelName]
          );
          
          if (existingResult.rows.length === 0) {
            logger.debug({ channelName }, 'Importing BCH channel');
            
            // Create channel in database. display_name is NOT NULL with no
            // default (see baseline schema) -- mirrors channelName, same as
            // every other channel-like table's name/display_name pair.
            const insertResult = await this.pool.query(`
              INSERT INTO bch_channels (
                name, display_name, description, read_group_id, write_group_id, created_by
              ) VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING id
            `, [
              channelName,
              channelName,
              description,
              group.pk,
              writeGroup?.pk || null,
              payload.synced_by
            ]);
            
            bchCount++;
            logger.debug({ channelName, bchChannelId: insertResult.rows[0].id }, 'Created BCH channel');
          } else {
            // Update existing channel with correct description and group IDs
            logger.debug({ channelName }, 'Updating existing BCH channel');
            
            await this.pool.query(`
              UPDATE bch_channels 
              SET description = $1, read_group_id = $2, write_group_id = $3
              WHERE name ILIKE $4
            `, [
              description,
              group.pk,
              writeGroup?.pk || null,
              channelName
            ]);
            
            logger.debug({ channelName }, 'Updated BCH channel with correct description');
          }
        }
      }
      
      // Process Region channels (groups starting with 'tak_Regions'). Unlike
      // BCH channels, region channels are a SINGLE Authentik group per
      // channel -- region_channels has only a `group_id` column, no
      // `read_group_id`/write-pair (confirmed against the baseline schema
      // and live DB; there is no "_READ" counterpart group for regions in
      // Authentik). Every group matching the prefix is its own channel.
      const regionPrefix = `tak_Regions${separator}`;
      
      for (const group of groups) {
        if (group.name.startsWith(regionPrefix)) {
          const channelName = group.name.replace(regionPrefix, '');
          
          let description = channelName;
          if (group.attributes?.description) {
            // Remove the "(Bi-directional location sharing)" suffix if present
            description = group.attributes.description.replace(' (Bi-directional location sharing)', '');
          }
          
          // Check if this channel already exists in database
          const existingResult = await this.pool.query(
            'SELECT id FROM region_channels WHERE name ILIKE $1',
            [channelName]
          );
          
          if (existingResult.rows.length === 0) {
            logger.debug({ channelName }, 'Importing Region channel');
            
            // Create channel in database. display_name is NOT NULL with no
            // default (see baseline schema) -- mirrors channelName, same as
            // every other channel-like table's name/display_name pair.
            const insertResult = await this.pool.query(`
              INSERT INTO region_channels (
                name, display_name, description, group_id, created_by
              ) VALUES ($1, $2, $3, $4, $5)
              RETURNING id
            `, [
              channelName,
              channelName,
              description,
              group.pk,
              payload.synced_by
            ]);
            
            regionCount++;
            logger.debug({ channelName, regionChannelId: insertResult.rows[0].id }, 'Created Region channel');
          } else {
            // Update existing channel with correct description and group id
            logger.debug({ channelName }, 'Updating existing Region channel');
            
            await this.pool.query(`
              UPDATE region_channels 
              SET description = $1, group_id = $2
              WHERE name ILIKE $3
            `, [
              description,
              group.pk,
              channelName
            ]);
            
            logger.debug({ channelName }, 'Updated Region channel with correct description and group id');
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