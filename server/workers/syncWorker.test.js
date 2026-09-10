/**
 * Requirement 9.1: `handleOperationError` computes the next retry delay
 * via the capped `computeBackoffDelay` function (see `./backoff.js`)
 * rather than the old unbounded `Math.pow(2, retryCount) * 60000`
 * expression, so that `next_retry_at` is always a valid, non-overflowing
 * timestamp for any `retry_count` value.
 *
 * `SyncWorker`'s constructor opens a real `pg.Pool`, so `pg` is mocked
 * here the same way `server/config/database.test.js` mocks it, to avoid
 * attempting a real database connection during the test.
 */

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    on: jest.fn(),
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn()
  }))
}));

// Requirement 9.5/13.6: `executeOperation` and its dispatched handlers use
// the structured logger instead of `console.log`/`console.error`. Mock it
// the same way `authentikSync.test.js`/`GlobalChannelService.test.js` do.
const mockLoggerInstance = {
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

// region-channel-tiers: assignUserToGlobalChannels/resyncOrgChannelTierAccess
// require `../models/Team` and `../services/EventPublisher` at module
// scope, calling `Team.getAncestorChain`/`Team.getOrganisationTeams` and
// `EventPublisher.publishOperation`/`publishBulkOperation` respectively --
// mocked here (rather than left to hit the real modules, which would
// route through the mocked `pg.Pool` above and never resolve) so the
// dedicated describe blocks below can control their return values
// directly.
jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
  getOrganisationTeams: jest.fn()
}));
jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn(),
  publishOperationsBatch: jest.fn(),
  publishBulkOperation: jest.fn()
}));

const http = require('http');
const { computeBackoffDelay } = require('./backoff');
const SyncWorker = require('./syncWorker');
const Team = require('../models/Team');
const EventPublisher = require('../services/EventPublisher');
// Property 3 (below): generates payloads against the real
// operationSchemas.js map rather than a hand-picked subset of operation
// types.
const operationSchemas = require('./operationSchemas');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

describe('SyncWorker.handleOperationError', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    // Replace the (mocked) pool's query with a fresh spy per test so each
    // test can assert on the exact call it cares about.
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
  });

  it('schedules a retry with next_retry_at computed via computeBackoffDelay, not the old unbounded formula', async () => {
    const retryCountBefore = 4; // handleOperationError uses operation.retry_count + 1
    const operation = {
      id: 'op-1',
      retry_count: retryCountBefore,
      max_retries: 48
    };
    const error = new Error('Authentik unreachable');

    const beforeCall = Date.now();
    await worker.handleOperationError(operation, error);
    const afterCall = Date.now();

    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).toContain('next_retry_at');
    expect(params[0]).toBe('pending');

    const expectedRetryCount = retryCountBefore + 1;
    const nextRetryParam = params[3]; // status, error_message, retry_count, next_retry_at, id
    expect(params[2]).toBe(expectedRetryCount);

    const expectedDelay = computeBackoffDelay(expectedRetryCount);
    const actualDelay = nextRetryParam.getTime() - beforeCall;

    // Allow a small tolerance for the time elapsed between computing
    // `beforeCall`/`afterCall` and the delay being computed inside the
    // method under test.
    expect(actualDelay).toBeGreaterThanOrEqual(expectedDelay - (afterCall - beforeCall));
    expect(actualDelay).toBeLessThanOrEqual(expectedDelay + (afterCall - beforeCall) + 5);
    expect(nextRetryParam.getTime()).toBeLessThanOrEqual(beforeCall + 3_600_000 + (afterCall - beforeCall));
  });

  it('caps next_retry_at at the 1-hour delay for a large retry_count instead of an unbounded/overflowing value', async () => {
    // retry_count large enough that the old unbounded 2^n minutes formula
    // would produce an astronomically large (or overflowing/invalid) delay.
    const operation = {
      id: 'op-2',
      retry_count: 39, // retryCount = 40, well past the point the uncapped formula exceeds 1 hour
      max_retries: 48
    };
    const error = new Error('Authentik unreachable');

    const beforeCall = Date.now();
    await worker.handleOperationError(operation, error);

    const [, params] = worker.pool.query.mock.calls[0];
    const nextRetryParam = params[3];

    expect(Number.isNaN(nextRetryParam.getTime())).toBe(false);
    expect(nextRetryParam.getTime() - beforeCall).toBeLessThanOrEqual(3_600_000 + 1000);
    expect(nextRetryParam.getTime() - beforeCall).toBeGreaterThan(0);
  });

  it('marks the operation as failed (not pending/retry) once retry_count reaches max_retries, without computing a backoff delay', async () => {
    const operation = {
      id: 'op-3',
      retry_count: 47,
      max_retries: 48
    };
    const error = new Error('Authentik unreachable');

    await worker.handleOperationError(operation, error);

    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).not.toContain('next_retry_at');
    expect(params).toEqual(['failed', error.message, 48, 'op-3']);
  });

  /**
   * Requirement 9.2: `handleOperationError` enforces 48 as the effective
   * cap on `max_retries`, regardless of the value actually stored on the
   * row. A stale/unmigrated row (or one inserted by a buggy/custom
   * enqueue path) with `max_retries` set above 48 must still stop
   * retrying at 48 attempts.
   */
  it('marks the operation as failed at 48 retries even when the stored max_retries is above 48 (stale/unmigrated row)', async () => {
    const operation = {
      id: 'op-stale',
      retry_count: 47, // retryCount becomes 48
      max_retries: 100 // pre-migration default, never backfilled
    };
    const error = new Error('Authentik unreachable');

    await worker.handleOperationError(operation, error);

    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).not.toContain('next_retry_at');
    expect(params).toEqual(['failed', error.message, 48, 'op-stale']);
  });

  it('still schedules a retry (does not prematurely fail) at retry 48 out of a stored max_retries of 100, since the effective cap is not yet reached until retry_count + 1 >= 48', async () => {
    // Sanity check for the boundary just below the cap: with a stored
    // max_retries of 100, an uncapped implementation would still be
    // retrying here, but so would a correctly-capped one, since
    // retryCount (47) has not yet reached the 48 cap. This guards against
    // an off-by-one in the cap logic in either direction.
    const operation = {
      id: 'op-stale-2',
      retry_count: 46, // retryCount becomes 47, still < 48
      max_retries: 100
    };
    const error = new Error('Authentik unreachable');

    await worker.handleOperationError(operation, error);

    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).toContain('next_retry_at');
    expect(params[0]).toBe('pending');
    expect(params[2]).toBe(47);
  });

  it('does not raise a lower configured max_retries: still fails at the row-configured value (10) rather than waiting until 48', async () => {
    const operation = {
      id: 'op-custom-low',
      retry_count: 9, // retryCount becomes 10
      max_retries: 10 // custom, lower-than-cap value set at enqueue time
    };
    const error = new Error('Authentik unreachable');

    await worker.handleOperationError(operation, error);

    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).not.toContain('next_retry_at');
    expect(params).toEqual(['failed', error.message, 10, 'op-custom-low']);
  });

  it('preserves existing behavior when max_retries is exactly 48 (post-migration default)', async () => {
    const operation = {
      id: 'op-exact-48',
      retry_count: 47, // retryCount becomes 48
      max_retries: 48
    };
    const error = new Error('Authentik unreachable');

    await worker.handleOperationError(operation, error);

    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).not.toContain('next_retry_at');
    expect(params).toEqual(['failed', error.message, 48, 'op-exact-48']);
  });
});

/**
 * Requirement 9.5/13.5/13.6: `executeOperation`'s payload-parsing block no
 * longer prints the raw payload via `console.log`/`console.error`. Instead
 * it emits a `debug`-level line carrying the full payload and an
 * `info`-level line carrying only `{operationId, operationType,
 * correlationId}` (no payload body).
 */
describe('SyncWorker.executeOperation payload logging', () => {
  let worker;
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    // Stub every dispatched handler so executeOperation's switch statement
    // doesn't attempt a real Authentik call for the valid-payload case.
    worker.addUserToGroup = jest.fn().mockResolvedValue();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('logs the full payload at debug level and only identifiers at info level, with no payload body at info', async () => {
    const operation = {
      id: 'op-42',
      operation_type: 'add_user_to_group',
      correlation_id: 'corr-123',
      // Requirement 9.3: target_user_id must be a number per
      // operationSchemas.js so this payload passes schema validation and
      // reaches the logging/dispatch code this test actually exercises.
      payload: { target_user_id: 1, target_group_id: 'group-1' }
    };

    await worker.executeOperation(operation);

    expect(mockLoggerInstance.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'op-42',
        operationType: 'add_user_to_group',
        correlationId: 'corr-123',
        payload: operation.payload
      }),
      expect.any(String)
    );

    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'op-42',
        operationType: 'add_user_to_group',
        correlationId: 'corr-123'
      }),
      expect.any(String)
    );

    // The info-level call must NOT include the payload body.
    const infoCallArgs = mockLoggerInstance.info.mock.calls.find(
      (call) => call[0].operationId === 'op-42'
    );
    expect(infoCallArgs[0]).not.toHaveProperty('payload');

    expect(worker.addUserToGroup).toHaveBeenCalledWith(operation.payload);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('routes a payload-parse failure through logger.error instead of console.error, without re-logging the raw payload a second time', async () => {
    const operation = {
      id: 'op-43',
      operation_type: 'add_user_to_group',
      correlation_id: 'corr-456',
      payload: '{not valid json'
    };

    await expect(worker.executeOperation(operation)).rejects.toThrow('Invalid payload');

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'op-43',
        operationType: 'add_user_to_group',
        err: expect.any(Error)
      }),
      expect.stringContaining('Failed to parse operation payload')
    );

    const errorCallArgs = mockLoggerInstance.error.mock.calls.find(
      (call) => call[0].operationId === 'op-43'
    );
    expect(errorCallArgs[0]).not.toHaveProperty('payload');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

/**
 * Requirement 10.1: `processNextOperation`'s fetch query uses a
 * configurable `LIMIT $1` (backed by `this.batchSize`, itself derived
 * from `SYNC_WORKER_BATCH_SIZE`, clamped to 10-500 and defaulting to 50)
 * instead of the old single-row `LIMIT 1`, still using
 * `FOR UPDATE SKIP LOCKED`. All rows in the fetched batch are marked
 * `'processing'` in one `UPDATE ... WHERE id = ANY(...)` call, and
 * `executeOperationSafely` is subsequently called once per returned
 * operation (processed serially for now; concurrent worker-pool
 * processing of the batch is implemented in a later task).
 */
describe('SyncWorker batch size configuration', () => {
  const originalEnv = process.env.SYNC_WORKER_BATCH_SIZE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SYNC_WORKER_BATCH_SIZE;
    } else {
      process.env.SYNC_WORKER_BATCH_SIZE = originalEnv;
    }
  });

  it('defaults to 50 when SYNC_WORKER_BATCH_SIZE is unset', () => {
    delete process.env.SYNC_WORKER_BATCH_SIZE;
    const worker = new SyncWorker();
    expect(worker.batchSize).toBe(50);
  });

  it('defaults to 50 when SYNC_WORKER_BATCH_SIZE is non-numeric', () => {
    process.env.SYNC_WORKER_BATCH_SIZE = 'not-a-number';
    const worker = new SyncWorker();
    expect(worker.batchSize).toBe(50);
  });

  it('clamps a value below 10 up to 10', () => {
    process.env.SYNC_WORKER_BATCH_SIZE = '1';
    const worker = new SyncWorker();
    expect(worker.batchSize).toBe(10);
  });

  it('clamps a value above 500 down to 500', () => {
    process.env.SYNC_WORKER_BATCH_SIZE = '10000';
    const worker = new SyncWorker();
    expect(worker.batchSize).toBe(500);
  });

  it('respects a valid in-range value', () => {
    process.env.SYNC_WORKER_BATCH_SIZE = '120';
    const worker = new SyncWorker();
    expect(worker.batchSize).toBe(120);
  });
});

/**
 * Requirement 9.3/9.4: `executeOperation` validates the parsed payload
 * against `operationSchemas.js` before dispatching to a handler. A
 * failing payload calls `markPermanentlyFailed` (status='failed',
 * failure_category='validation') WITHOUT ever touching `retry_count` or
 * `next_retry_at`, and `executeOperationSafely` must not subsequently
 * call `handleOperationError` for that same failure (which would
 * otherwise increment `retry_count`/set `next_retry_at`).
 */
describe('SyncWorker payload schema validation before dispatch', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    worker.addUserToGroup = jest.fn().mockResolvedValue();
  });

  it('marks the operation permanently failed with failure_category=validation when a required field is missing, without touching retry_count/next_retry_at', async () => {
    const operation = {
      id: 'op-missing-field',
      operation_type: 'add_user_to_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-1',
      // Missing required `target_group_id`
      payload: { target_user_id: 42 }
    };

    await expect(worker.executeOperationSafely(operation)).resolves.toBeUndefined();

    // Only one terminal UPDATE should have been issued (by
    // markPermanentlyFailed), and it must never mention next_retry_at.
    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).toContain('failure_category');
    expect(sql).not.toContain('next_retry_at');
    expect(sql).not.toContain('retry_count');
    expect(params).toEqual(['failed', 'validation', expect.stringContaining('payload_validation'), 'op-missing-field']);

    // The handler must never have been dispatched.
    expect(worker.addUserToGroup).not.toHaveBeenCalled();

    // Confirm no call anywhere set/incremented retry_count or next_retry_at.
    const anyRetryCountOrNextRetryCall = worker.pool.query.mock.calls.some(
      ([callSql]) => typeof callSql === 'string' && (callSql.includes('next_retry_at') || callSql.includes('retry_count'))
    );
    expect(anyRetryCountOrNextRetryCall).toBe(false);
  });

  it('marks the operation permanently failed when a required field has the wrong type', async () => {
    const operation = {
      id: 'op-wrong-type',
      operation_type: 'add_user_to_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-2',
      // target_user_id should be a number per operationSchemas.js
      payload: { target_user_id: '42', target_group_id: 'group-1' }
    };

    await worker.executeOperationSafely(operation);

    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).toContain('failure_category');
    expect(sql).not.toContain('next_retry_at');
    expect(params[0]).toBe('failed');
    expect(params[1]).toBe('validation');
    expect(worker.addUserToGroup).not.toHaveBeenCalled();
  });

  it('proceeds to dispatch normally when the payload is valid for a known operation_type', async () => {
    const operation = {
      id: 'op-valid',
      operation_type: 'add_user_to_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-3',
      payload: { target_user_id: 42, target_group_id: 'group-1' }
    };

    await worker.executeOperationSafely(operation);

    expect(worker.addUserToGroup).toHaveBeenCalledWith(operation.payload);
    // Success path: markOperationCompleted's UPDATE, not a validation failure.
    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).toContain('completed');
    expect(params[0]).toBe('completed');
  });

  it('does not treat an operation_type absent from operationSchemas as a payload-validation failure, leaving the pre-existing "Unknown operation type" path reachable', async () => {
    const operation = {
      id: 'op-unknown-type',
      operation_type: 'some_totally_unregistered_operation',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-4',
      payload: { anything: 'goes' }
    };

    await worker.executeOperationSafely(operation);

    // handleOperationError's retryable path should have run (an UPDATE
    // containing next_retry_at, since retry_count=0 is well below
    // max_retries), NOT markPermanentlyFailed's validation path.
    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).toContain('next_retry_at');
    expect(params[0]).toBe('pending');
    expect(params[1]).toContain('Unknown operation type');
  });
});

/**
 * Property-based test (design.md's Property 3), implemented with
 * `fast-check` via `@fast-check/jest`'s `test.prop`, matching the
 * convention already established in `server/config/configValidator.test.js`/
 * `server/config/permissions.registry.test.js`. Runs 100 iterations
 * (`numRuns: 100`), generating across every real `operation_type` entry
 * registered in `./operationSchemas` (rather than a hand-picked subset),
 * combined with a random required field on that entry being either
 * deleted or set to a mismatched type.
 *
 * This exercises `executeOperationSafely` end-to-end (not just
 * `validatePayloadSchema` in isolation), so the property actually proves
 * the requirement's outcome -- "the resulting `sync_operations` row has
 * an unchanged `retry_count` and a null `next_retry_at`" -- rather than
 * merely that the pure validator function returns `{valid: false}`.
 */
// Feature: production-hardening, Property 3: Payload validation failures never schedule a retry
describe('Property 3: Payload validation failures never schedule a retry', () => {
  const operationTypes = Object.keys(operationSchemas);

  // Mirrors executeOperation's switch statement in ./syncWorker.js:
  // operation_type -> the handler method actually dispatched to.
  const HANDLER_METHOD_BY_OPERATION_TYPE = {
    add_user_to_group: 'addUserToGroup',
    remove_user_from_group: 'removeUserFromGroup',
    create_group: 'createGroup',
    bulk_add_user_to_team: 'bulkAddUserToTeam',
    create_bch_channel_groups: 'createBchChannelGroups',
    // Bugfix (a BCH/UTL channel imported via "Sync Existing Channels" has
    // no service account): enqueued by
    // GlobalChannelService.provisionServiceAccount.
    provision_bch_service_account: 'provisionBchServiceAccount',
    // Bugfix (BCH credentials modal: cycle password / delete service
    // account): enqueued by GlobalChannelService.rotateServiceAccountPassword
    // / .deleteServiceAccount respectively.
    rotate_bch_service_account_password: 'rotateBchServiceAccountPassword',
    delete_bch_service_account: 'deleteBchServiceAccount',
    create_region_channel_group: 'createRegionChannelGroup',
    update_bch_channel_group: 'updateBchChannelGroup',
    update_region_channel_group: 'updateRegionChannelGroup',
    delete_global_channel: 'deleteGlobalChannelGroup',
    assign_user_to_global_channels: 'assignUserToGlobalChannels',
    deactivate_global_channel: 'deactivateGlobalChannel',
    sync_existing_global_channels: 'syncExistingGlobalChannels',
    // region-channel-tiers: enqueued by PUT /api/teams/:teamId/channel-access.
    resync_org_channel_tier_access: 'resyncOrgChannelTierAccess',
    cleanup_orphaned_authentik_user: 'cleanupOrphanedAuthentikUser',
    remove_team_channel_group: 'removeTeamChannelGroup',
    // Bugfix (orphaned Authentik team groups): enqueued by
    // Team.createTeamChannel's fallback when the synchronous group-create
    // fails; reconciled (create-or-reuse-by-name + write pk back) by the
    // Sync_Worker.
    reconcile_team_channel_group: 'reconcileTeamChannelGroup',
    // Bugfix (a renamed team's Authentik group kept its stale name):
    // enqueued by Team.update when a rename changes a team's derived
    // Team_Channel group name; PATCHes the group's `name` in Authentik.
    rename_team_channel_group: 'renameTeamChannelGroup',
    // Bugfix (Channels tab has no edit action, and no way to add/edit a
    // custom channel's Authentik/LDAP description): enqueued by
    // Channel.updateCustomChannel.
    update_channel_group: 'updateChannelGroup',
    revoke_tak_certificates: 'revokeTakCertificates',
    // Feature cloudtak-agency-groups (tasks 4.1/4.2): create/update share
    // `ensureCloudTakGroup`; delete's handler `deleteCloudTakGroup` is
    // added in task 4.2. Property 3 stubs the handler by name and never
    // reaches the switch (validation fails first), so listing all three
    // keeps this map in lockstep with operationSchemas.
    create_cloudtak_group: 'createCloudTakGroup',
    update_cloudtak_group: 'updateCloudTakGroup',
    delete_cloudtak_group: 'deleteCloudTakGroup',
    // Authentik scaling (Phase 2): the group-authoritative reconcile.
    reconcile_owned_group: 'reconcileOwnedGroup'
  };

  // Sanity check that the mapping above and operationSchemas.js haven't
  // drifted apart (e.g. a new operation_type added to one but not the
  // other), so a gap doesn't silently narrow what the property below
  // actually covers.
  it('has a dispatch-handler mapping entry for every operation_type in operationSchemas', () => {
    expect(Object.keys(HANDLER_METHOD_BY_OPERATION_TYPE).sort()).toEqual([...operationTypes].sort());
  });

  function validValueForType(expectedType) {
    switch (expectedType) {
      case 'string':
        return 'valid-value';
      case 'number':
        return 1;
      case 'boolean':
        return true;
      case 'object':
        return {};
      default:
        return 'valid-value';
    }
  }

  // A value whose typeof deliberately does NOT match expectedType.
  function mismatchedValueForType(expectedType) {
    switch (expectedType) {
      case 'string':
        return 12345;
      case 'number':
        return 'not-a-number';
      case 'boolean':
        return 'not-a-boolean';
      case 'object':
        return 'not-an-object';
      default:
        return undefined;
    }
  }

  // Feature device-management (task 19.2): a schema entry may declare
  // `exactlyOneOf` -- mutually exclusive discriminators of which a valid
  // payload carries exactly one. The FIRST declared discriminator is the
  // one a valid baseline payload carries here (adding all of them, or none,
  // would make the baseline itself invalid), and it is corruptible in the
  // same missing/wrongType sense as a required field: deleting it leaves
  // zero discriminators present, and mistyping it fails the type check.
  function discriminatorFieldFor(operationType) {
    const schema = operationSchemas[operationType];
    if (!schema.exactlyOneOf) {
      return null;
    }
    return Object.keys(schema.exactlyOneOf)[0];
  }

  function expectedTypeForCorruptibleField(operationType, field) {
    const schema = operationSchemas[operationType];
    if (schema.requiredFields && schema.requiredFields[field] !== undefined) {
      return schema.requiredFields[field];
    }
    return schema.exactlyOneOf[field];
  }

  function buildValidPayload(operationType) {
    const schema = operationSchemas[operationType];
    const payload = {};
    for (const [field, type] of Object.entries(schema.requiredFields || {})) {
      payload[field] = validValueForType(type);
    }
    const discriminatorField = discriminatorFieldFor(operationType);
    if (discriminatorField !== null) {
      payload[discriminatorField] = validValueForType(schema.exactlyOneOf[discriminatorField]);
    }
    for (const [field, type] of Object.entries(schema.optionalFields || {})) {
      payload[field] = validValueForType(type);
    }
    return payload;
  }

  // For any operation_type, build a valid baseline payload, then corrupt
  // exactly one required field by either deleting it entirely or
  // replacing its value with one of a mismatched type.
  const invalidPayloadCaseArb = fc
    .tuple(fc.constantFrom(...operationTypes), fc.nat(), fc.constantFrom('missing', 'wrongType'))
    .map(([operationType, fieldIndexSeed, corruption]) => {
      const schema = operationSchemas[operationType];
      const discriminatorField = discriminatorFieldFor(operationType);
      const corruptibleFieldNames = [
        ...Object.keys(schema.requiredFields || {}),
        ...(discriminatorField !== null ? [discriminatorField] : [])
      ];
      const targetField = corruptibleFieldNames[fieldIndexSeed % corruptibleFieldNames.length];
      const expectedType = expectedTypeForCorruptibleField(operationType, targetField);

      const payload = buildValidPayload(operationType);
      if (corruption === 'missing') {
        delete payload[targetField];
      } else {
        payload[targetField] = mismatchedValueForType(expectedType);
      }

      return { operationType, payload, targetField, corruption };
    });

  test.prop([invalidPayloadCaseArb], { numRuns: 100 })(
    'for any operation_type and a payload missing/mistyped one required field, executeOperationSafely marks the row failed/validation without ever issuing an UPDATE touching retry_count or next_retry_at, and never dispatches the handler',
    async ({ operationType, payload, targetField, corruption }) => {
      const worker = new SyncWorker();
      worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });

      // Stub the handler this operation_type would dispatch to, so that
      // if a validation-logic bug ever let an invalid payload through to
      // the switch statement, the `not.toHaveBeenCalled()` assertion
      // below would catch it -- rather than the test making a real
      // network call via an unstubbed handler.
      const handlerMethodName = HANDLER_METHOD_BY_OPERATION_TYPE[operationType];
      const handlerSpy = jest.fn().mockResolvedValue();
      worker[handlerMethodName] = handlerSpy;

      const operation = {
        id: `op-prop3-${operationType}-${targetField}-${corruption}`,
        operation_type: operationType,
        retry_count: 0,
        max_retries: 48,
        correlation_id: 'corr-prop3',
        payload
      };

      await worker.executeOperationSafely(operation);

      expect(handlerSpy).not.toHaveBeenCalled();

      // Exactly one terminal UPDATE was issued -- markPermanentlyFailed's
      // -- and handleOperationError's retry-scheduling path never ran.
      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('failure_category');
      expect(sql).not.toContain('next_retry_at');
      expect(sql).not.toContain('retry_count');
      expect(params[0]).toBe('failed');
      expect(params[1]).toBe('validation');
      expect(params[2]).toContain('payload_validation');

      // Belt-and-suspenders: confirm no call anywhere (not just the one
      // call counted above) ever mentioned retry_count/next_retry_at.
      const anyRetrySchedulingCall = worker.pool.query.mock.calls.some(
        ([callSql]) =>
          typeof callSql === 'string' && (callSql.includes('next_retry_at') || callSql.includes('retry_count'))
      );
      expect(anyRetrySchedulingCall).toBe(false);
    }
  );
});

describe('SyncWorker.processNextOperation batch fetch', () => {
  let worker;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SYNC_WORKER_BATCH_SIZE;
    delete process.env.SYNC_WORKER_CONCURRENCY;
    worker = new SyncWorker();
    worker.executeOperationSafely = jest.fn().mockResolvedValue();

    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    worker.pool.connect = jest.fn().mockResolvedValue(mockClient);
  });

  it('fetches with LIMIT $1 passing the configured batch size, marks all rows processing via id = ANY(...), and processes each row exactly once', async () => {
    const fetchedRows = [
      { id: 'op-1', operation_type: 'add_user_to_group', payload: {} },
      { id: 'op-2', operation_type: 'add_user_to_group', payload: {} },
      { id: 'op-3', operation_type: 'add_user_to_group', payload: {} }
    ];

    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
        return Promise.resolve();
      }
      if (sql.includes('SELECT * FROM sync_operations')) {
        return Promise.resolve({ rows: fetchedRows });
      }
      if (sql.includes('UPDATE sync_operations') && sql.includes('id = ANY')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await worker.processNextOperation();

    const selectCall = mockClient.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('SELECT * FROM sync_operations')
    );
    expect(selectCall[0]).toContain('LIMIT $1');
    expect(selectCall[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(selectCall[1]).toEqual([worker.batchSize]);

    const updateCalls = mockClient.query.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('UPDATE sync_operations') && call[0].includes('status')
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toContain('id = ANY');
    expect(updateCalls[0][1]).toEqual(['processing', ['op-1', 'op-2', 'op-3']]);

    // Requirement 10.2/10.3: with lane-based dispatch through a p-limit
    // worker pool, each of these three operations lacks a
    // target_user_id/target_group_id pair, so each gets its own
    // single-operation lane and all three lanes run concurrently. The
    // GLOBAL call order across different lanes is therefore no longer
    // guaranteed deterministic (unlike the old strictly-serial for loop),
    // so this test only asserts that executeOperationSafely was called
    // exactly once per fetched row, with each row's own object, rather
    // than asserting a specific nth-call order across lanes.
    expect(worker.executeOperationSafely).toHaveBeenCalledTimes(3);
    expect(worker.executeOperationSafely).toHaveBeenCalledWith(fetchedRows[0]);
    expect(worker.executeOperationSafely).toHaveBeenCalledWith(fetchedRows[1]);
    expect(worker.executeOperationSafely).toHaveBeenCalledWith(fetchedRows[2]);
  });

  it('rolls back and returns without processing anything when no pending operations are found', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM sync_operations')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve();
    });

    await worker.processNextOperation();

    const rollbackCall = mockClient.query.mock.calls.find((call) => call[0] === 'ROLLBACK');
    expect(rollbackCall).toBeDefined();
    expect(worker.executeOperationSafely).not.toHaveBeenCalled();
  });

  /**
   * Performance-hardening: the poll loop (SyncWorker.start) uses this
   * return value to decide whether a full batch likely means more work
   * is waiting, skipping its fixed inter-cycle sleep when so.
   */
  it('resolves with 0 when no pending operations are found', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM sync_operations')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve();
    });

    await expect(worker.processNextOperation()).resolves.toBe(0);
  });

  it('resolves with the exact number of rows fetched (a partial batch)', async () => {
    const fetchedRows = [
      { id: 'op-1', operation_type: 'add_user_to_group', payload: {} },
      { id: 'op-2', operation_type: 'add_user_to_group', payload: {} }
    ];
    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM sync_operations')) {
        return Promise.resolve({ rows: fetchedRows });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(worker.processNextOperation()).resolves.toBe(2);
  });

  it('resolves with a count equal to this.batchSize when the fetch returns a full batch', async () => {
    worker.batchSize = 3;
    const fetchedRows = [
      { id: 'op-1', operation_type: 'add_user_to_group', payload: {} },
      { id: 'op-2', operation_type: 'add_user_to_group', payload: {} },
      { id: 'op-3', operation_type: 'add_user_to_group', payload: {} }
    ];
    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM sync_operations')) {
        return Promise.resolve({ rows: fetchedRows });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(worker.processNextOperation()).resolves.toBe(worker.batchSize);
  });

  /**
   * Requirement 10.5: two operations sharing the same
   * target_user_id:target_group_id key must still both be processed
   * (executeOperationSafely called for both), and -- specifically WITHIN
   * their shared lane -- in their original relative fetch order. This is
   * verified via a manually-tracked call-order sequence array rather than
   * asserting a specific *global* nth-call position, since with
   * concurrent lanes the global call order across DIFFERENT lanes is not
   * deterministic; only the within-lane order is guaranteed.
   */
  it('processes two same-entity-key operations in their original relative order within their shared lane', async () => {
    const sameKeyOpA = {
      id: 'op-same-a',
      operation_type: 'add_user_to_group',
      payload: { target_user_id: 1, target_group_id: 'group-x' }
    };
    const sameKeyOpB = {
      id: 'op-same-b',
      operation_type: 'add_user_to_group',
      payload: { target_user_id: 1, target_group_id: 'group-x' }
    };
    const unrelatedOp = {
      id: 'op-unrelated',
      operation_type: 'add_user_to_group',
      payload: { target_user_id: 2, target_group_id: 'group-y' }
    };
    const fetchedRows = [sameKeyOpA, unrelatedOp, sameKeyOpB];

    const callOrder = [];
    worker.executeOperationSafely = jest.fn().mockImplementation(async (operation) => {
      callOrder.push(operation.id);
    });

    mockClient.query.mockImplementation((sql) => {
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) {
        return Promise.resolve();
      }
      if (sql.includes('SELECT * FROM sync_operations')) {
        return Promise.resolve({ rows: fetchedRows });
      }
      return Promise.resolve({ rows: [] });
    });

    await worker.processNextOperation();

    expect(worker.executeOperationSafely).toHaveBeenCalledTimes(3);
    expect(callOrder).toContain('op-same-a');
    expect(callOrder).toContain('op-same-b');
    expect(callOrder).toContain('op-unrelated');

    // Within the shared lane, op-same-a must be processed strictly before
    // op-same-b (their original relative fetch order), regardless of
    // where the unrelated, differently-keyed operation lands in the
    // overall call order.
    expect(callOrder.indexOf('op-same-a')).toBeLessThan(callOrder.indexOf('op-same-b'));
  });
});

/**
 * Requirement 10.3 (task 30.2): `this.concurrency` is derived from
 * `SYNC_WORKER_CONCURRENCY`, clamped to the 1-100 range and defaulting to
 * 10, mirroring `this.batchSize`'s clamp behavior/tests above.
 */
describe('SyncWorker concurrency configuration', () => {
  const originalEnv = process.env.SYNC_WORKER_CONCURRENCY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SYNC_WORKER_CONCURRENCY;
    } else {
      process.env.SYNC_WORKER_CONCURRENCY = originalEnv;
    }
  });

  it('defaults to 10 when SYNC_WORKER_CONCURRENCY is unset', () => {
    delete process.env.SYNC_WORKER_CONCURRENCY;
    const worker = new SyncWorker();
    expect(worker.concurrency).toBe(10);
  });

  it('defaults to 10 when SYNC_WORKER_CONCURRENCY is non-numeric', () => {
    process.env.SYNC_WORKER_CONCURRENCY = 'not-a-number';
    const worker = new SyncWorker();
    expect(worker.concurrency).toBe(10);
  });

  it('clamps a negative value up to 1', () => {
    process.env.SYNC_WORKER_CONCURRENCY = '-5';
    const worker = new SyncWorker();
    expect(worker.concurrency).toBe(1);
  });

  it('clamps a value above 100 down to 100', () => {
    process.env.SYNC_WORKER_CONCURRENCY = '500';
    const worker = new SyncWorker();
    expect(worker.concurrency).toBe(100);
  });

  it('respects a valid in-range value', () => {
    process.env.SYNC_WORKER_CONCURRENCY = '25';
    const worker = new SyncWorker();
    expect(worker.concurrency).toBe(25);
  });
});

/**
 * Requirement 9.6/task 28.2: each Authentik-calling handler now throws an
 * `AuthentikApiError` (carrying a `classification` of `'retryable'` or
 * `'permanent'`, per `classifyFailure`) instead of a plain `Error` on a
 * non-2xx response or a caught network/timeout error.
 * `executeOperationSafely`'s catch-handling block inspects that
 * classification: a `'permanent'` classification calls
 * `markPermanentlyFailed` directly (one terminal UPDATE,
 * `failure_category='permanent'`, no `next_retry_at`/`retry_count`
 * touched) instead of `handleOperationError`; a `'retryable'`
 * classification (or any other, unclassified error) continues through
 * the existing `handleOperationError` retry-scheduling path unchanged.
 */
describe('SyncWorker Authentik failure classification wiring', () => {
  let worker;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('addUserToGroup', () => {
    const baseOperation = {
      id: 'op-classify-1',
      operation_type: 'add_user_to_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-classify-1',
      payload: { target_user_id: 42, target_group_id: 'group-1' }
    };

    beforeEach(() => {
      worker.getUser = jest.fn().mockResolvedValue({ id: 42, authentik_user_id: 'ak-42' });
    });

    it('results in exactly one markPermanentlyFailed-style UPDATE (failed/permanent, no next_retry_at/retry_count) on a 4xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('failure_category');
      expect(sql).not.toContain('next_retry_at');
      expect(sql).not.toContain('retry_count');
      expect(params[0]).toBe('failed');
      expect(params[1]).toBe('permanent');
    });

    it('results in the existing handleOperationError retryable path (an UPDATE containing next_retry_at) on a 5xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });

    it('treats a rejected fetch (network error, no .status) as retryable via the same handleOperationError path', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });
  });

  /**
   * Requirement 17.2 (task 36.2): `cleanupOrphanedAuthentikUser` is the
   * deferred/asynchronous half of the "delete an orphaned Authentik user"
   * compensating action -- enqueued by `POST /api/users/create-and-add`'s
   * Phase 2 catch block only when its own synchronous delete attempt
   * already failed. It follows the same fetch/`AuthentikApiError`/
   * `classifyFailure` pattern as every other Authentik-calling handler
   * above.
   */
  describe('cleanupOrphanedAuthentikUser', () => {
    const baseOperation = {
      id: 'op-cleanup-1',
      operation_type: 'cleanup_orphaned_authentik_user',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-cleanup-1',
      payload: { authentik_user_id: 4242 }
    };

    it('completes successfully (one markOperationCompleted UPDATE) when the DELETE call succeeds', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/users/4242/'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('completed');
      expect(params[0]).toBe('completed');
    });

    it('treats a 404 response as an already-satisfied cleanup (success, not a failure)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('completed');
      expect(params[0]).toBe('completed');
    });

    it('results in a markPermanentlyFailed-style UPDATE (failed/permanent, no next_retry_at/retry_count) on a 4xx response other than 404', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('failure_category');
      expect(sql).not.toContain('next_retry_at');
      expect(sql).not.toContain('retry_count');
      expect(params[0]).toBe('failed');
      expect(params[1]).toBe('permanent');
    });

    it('results in the existing handleOperationError retryable path on a 5xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });

    it('treats a rejected fetch (network error) as retryable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });
  });

  /**
   * Requirement 17.3/17.4 (task 36.3): `removeTeamChannelGroup` deletes
   * each non-null Authentik group id carried on the payload
   * (`authentik_group_id`/`authentik_read_group_id`/
   * `authentik_write_group_id`), following the same
   * fetch/`AuthentikApiError`/`classifyFailure` pattern as
   * `cleanupOrphanedAuthentikUser` above, including 404-is-a-no-op
   * handling per group id.
   */
  describe('removeTeamChannelGroup', () => {
    const baseOperation = {
      id: 'op-remove-team-channel-1',
      operation_type: 'remove_team_channel_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-remove-team-channel-1',
      // Authentik group pks are UUID strings, never numbers -- see the
      // fix note on operationSchemas.js's remove_team_channel_group entry.
      payload: { channel_id: 10, authentik_group_id: 'group-pk-555' }
    };

    it('completes successfully (one markOperationCompleted UPDATE) when the single group DELETE succeeds', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/group-pk-555/'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('completed');
      expect(params[0]).toBe('completed');
    });

    it('deletes each non-null group id (read + write pair) when present, and completes successfully', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
      const operation = {
        ...baseOperation,
        payload: { channel_id: 11, authentik_read_group_id: 'group-pk-201', authentik_write_group_id: 'group-pk-202' }
      };

      await worker.executeOperationSafely(operation);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/group-pk-201/'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/group-pk-202/'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      expect(worker.pool.query.mock.calls[0][1][0]).toBe('completed');
    });

    it('treats a 404 response for a group id as an already-satisfied cleanup (success, not a failure)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('completed');
      expect(params[0]).toBe('completed');
    });

    it('results in a markPermanentlyFailed-style UPDATE (failed/permanent, no next_retry_at/retry_count) on a 4xx response other than 404', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('failure_category');
      expect(sql).not.toContain('next_retry_at');
      expect(sql).not.toContain('retry_count');
      expect(params[0]).toBe('failed');
      expect(params[1]).toBe('permanent');
    });

    it('results in the existing handleOperationError retryable path on a 5xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });

    it('treats a rejected fetch (network error) as retryable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });
  });

  /**
   * Bugfix (orphaned Authentik team groups): `reconcileTeamChannelGroup`
   * is the retryable repair for a primary team channel whose
   * `authentik_group_id` could not be populated synchronously at
   * team-creation time. It create-or-reuses the group by name (mirroring
   * `ensureCloudTakGroup`) and writes the pk back onto the channel row,
   * and is idempotent: a channel that is gone, or that already has a
   * group id, is a no-op success (no fetch).
   */
  describe('reconcileTeamChannelGroup', () => {
    const baseOperation = {
      id: 'op-reconcile-team-channel-1',
      operation_type: 'reconcile_team_channel_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-reconcile-team-channel-1',
      payload: { channel_id: 10, authentik_group_name: 'tak_Teams - LSAR', description: 'desc' }
    };

    // Route the handler's own SELECT/UPDATE queries to sensible defaults
    // while letting the terminal markOperationCompleted/markPermanentlyFailed
    // UPDATE (which contains 'status = ' / 'failure_category') fall through
    // to a captured result. `channelRow` is what the channel SELECT returns.
    function mockChannelQueries(channelRow) {
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id FROM channels')) {
          return Promise.resolve({ rows: channelRow ? [channelRow] : [] });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    it('creates a fresh group and writes its pk back onto the channel, then completes', async () => {
      mockChannelQueries({ id: 10, authentik_group_id: null });
      global.fetch = jest.fn().mockImplementation((url, options) => {
        if (options?.method === 'POST') {
          return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ pk: 'fresh-pk-1' }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      // POSTed a create for the intended group name.
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/'),
        expect.objectContaining({ method: 'POST' })
      );
      // Wrote the pk back onto the channel row (guarded on IS NULL).
      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE channels SET authentik_group_id')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[1]).toEqual(['fresh-pk-1', 10]);
      // Terminal completed.
      const completedCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('status') && sql.includes('completed')
      );
      expect(completedCall).toBeDefined();
    });

    it('reuses an existing group (looked up by name) when the create POST conflicts, and writes that pk back', async () => {
      mockChannelQueries({ id: 10, authentik_group_id: null });
      global.fetch = jest.fn().mockImplementation((url, options) => {
        if (options?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request' });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: [{ pk: 'existing-pk-9', name: 'tak_Teams - LSAR' }] })
        });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE channels SET authentik_group_id')
      );
      expect(updateCall[1]).toEqual(['existing-pk-9', 10]);
    });

    it('is a no-op success (no fetch, no update) when the channel already has a group id', async () => {
      mockChannelQueries({ id: 10, authentik_group_id: 'already-set-pk' });
      global.fetch = jest.fn();

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).not.toHaveBeenCalled();
      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE channels SET authentik_group_id')
      );
      expect(updateCall).toBeUndefined();
    });

    it('is a no-op success (no fetch) when the channel no longer exists', async () => {
      mockChannelQueries(null);
      global.fetch = jest.fn();

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('classifies a 5xx create failure (with no existing group to reuse) as retryable', async () => {
      mockChannelQueries({ id: 10, authentik_group_id: null });
      global.fetch = jest.fn().mockImplementation((url, options) => {
        if (options?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const retryCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(retryCall).toBeDefined();
      expect(retryCall[1][0]).toBe('pending');
    });
  });

  /**
   * Bugfix (a renamed team's Authentik group kept its stale name):
   * `renameTeamChannelGroup` loads the channel by id and PATCHes its
   * Authentik group's `name` (and `description` when supplied). Idempotent:
   * a channel that is gone, or has no group id yet, or whose group 404s, is
   * a no-op success; a 5xx is retryable.
   */
  describe('renameTeamChannelGroup', () => {
    const baseOperation = {
      id: 'op-rename-team-channel-1',
      operation_type: 'rename_team_channel_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-rename-team-channel-1',
      payload: { channel_id: 10, authentik_group_name: 'tak_Teams - NZDF - HADR', description: 'desc' }
    };

    function mockChannelQueries(channelRow) {
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id FROM channels')) {
          return Promise.resolve({ rows: channelRow ? [channelRow] : [] });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    it('PATCHes the group name (and description) then completes', async () => {
      mockChannelQueries({ id: 10, authentik_group_id: 'group-pk-1' });
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/group-pk-1/'),
        expect.objectContaining({ method: 'PATCH' })
      );
      const [, options] = global.fetch.mock.calls[0];
      expect(JSON.parse(options.body)).toEqual({
        name: 'tak_Teams - NZDF - HADR',
        attributes: { description: 'desc' }
      });
      const completedCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('status') && sql.includes('completed')
      );
      expect(completedCall).toBeDefined();
    });

    it('is a no-op success (no fetch) when the channel no longer exists', async () => {
      mockChannelQueries(null);
      global.fetch = jest.fn();

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('is a no-op success (no fetch) when the channel has no Authentik group id yet', async () => {
      mockChannelQueries({ id: 10, authentik_group_id: null });
      global.fetch = jest.fn();

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('treats a 404 from the group PATCH as an already-absent group (no-op success)', async () => {
      mockChannelQueries({ id: 10, authentik_group_id: 'group-pk-1' });
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await worker.executeOperationSafely({ ...baseOperation });

      const completedCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('status') && sql.includes('completed')
      );
      expect(completedCall).toBeDefined();
    });

    it('classifies a 5xx PATCH failure as retryable', async () => {
      mockChannelQueries({ id: 10, authentik_group_id: 'group-pk-1' });
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

      await worker.executeOperationSafely({ ...baseOperation });

      const retryCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(retryCall).toBeDefined();
      expect(retryCall[1][0]).toBe('pending');
    });
  });

  /**
   * Bugfix (Channels tab has no edit action, and no way to add/edit a
   * custom channel's Authentik/LDAP description): `updateChannelGroup`
   * PATCHes each non-null Authentik group id carried on the payload
   * with the new description, following the exact same
   * fetch/`AuthentikApiError`/`classifyFailure` pattern -- including
   * 404-is-a-no-op handling per group id -- as `removeTeamChannelGroup`
   * immediately above, since it iterates the same three group-id fields.
   */
  describe('updateChannelGroup', () => {
    const baseOperation = {
      id: 'op-update-channel-1',
      operation_type: 'update_channel_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-update-channel-1',
      payload: { channel_id: 10, description: 'New description', authentik_group_id: 'group-pk-555' }
    };

    it('completes successfully (one markOperationCompleted UPDATE) when the single group PATCH succeeds', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/group-pk-555/'),
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ attributes: { description: 'New description' } })
        })
      );
      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('completed');
      expect(params[0]).toBe('completed');
    });

    it('patches each non-null group id (rw + read + write) when present, and completes successfully', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      const operation = {
        ...baseOperation,
        payload: {
          channel_id: 11,
          description: 'Updated',
          authentik_group_id: 'group-pk-200',
          authentik_read_group_id: 'group-pk-201',
          authentik_write_group_id: 'group-pk-202'
        }
      };

      await worker.executeOperationSafely(operation);

      expect(global.fetch).toHaveBeenCalledTimes(3);
      for (const groupId of ['group-pk-200', 'group-pk-201', 'group-pk-202']) {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining(`/core/groups/${groupId}/`),
          expect.objectContaining({ method: 'PATCH' })
        );
      }
      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      expect(worker.pool.query.mock.calls[0][1][0]).toBe('completed');
    });

    it('treats a 404 response for a group id as an already-absent group (success, not a failure)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('completed');
      expect(params[0]).toBe('completed');
    });

    it('results in a markPermanentlyFailed-style UPDATE (failed/permanent, no next_retry_at/retry_count) on a 4xx response other than 404', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'Bad Request' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('failure_category');
      expect(sql).not.toContain('next_retry_at');
      expect(sql).not.toContain('retry_count');
      expect(params[0]).toBe('failed');
      expect(params[1]).toBe('permanent');
    });

    it('results in the existing handleOperationError retryable path on a 5xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'Service Unavailable' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });

    it('treats a rejected fetch (network error) as retryable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });
  });

  describe('createBchChannelGroups', () => {
    const baseOperation = {
      id: 'op-classify-2',
      operation_type: 'create_bch_channel_groups',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-classify-2',
      payload: {
        channel_name: 'Test Channel',
        category: 'BCH',
        service_account_username: 'svc-test',
        service_account_password: 'secret',
        bch_channel_id: 7
      }
    };

    it('results in exactly one markPermanentlyFailed-style UPDATE on a 4xx response from the group-creation call', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('failure_category');
      expect(sql).not.toContain('next_retry_at');
      expect(params[0]).toBe('failed');
      expect(params[1]).toBe('permanent');
    });

    it('results in the existing handleOperationError retryable path on a 5xx response from the group-creation call', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });

    it('treats a rejected fetch (network error) as retryable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });
  });

  /**
   * bch-channel-category: `createBchChannelGroups`'s group-naming and
   * category-validation behavior, mirroring `createRegionChannelGroup`'s
   * own tier-naming tests below in shape.
   */
  describe('createBchChannelGroups category naming', () => {
    const baseOperation = {
      id: 'op-bch-category-1',
      operation_type: 'create_bch_channel_groups',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-bch-category-1',
      payload: {
        channel_name: 'Data Packages',
        category: 'UTL',
        service_account_username: 'etl-data-packages',
        service_account_password: 'secret',
        bch_channel_id: 11
      }
    };

    beforeEach(() => {
      worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    });

    it("names the read/write groups with the category's prefix (tak_XtraTools for category 'UTL')", async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        if (call <= 2) {
          // The two group-creation POSTs (read, then write).
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve({ pk: `grp-${call}` })
          });
        }
        // Service-account create, set_password, add_user.
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ pk: 'svc-pk' })
        });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const readCallBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      const writeCallBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(readCallBody.name).toBe('tak_XtraTools - Data Packages_READ');
      expect(writeCallBody.name).toBe('tak_XtraTools - Data Packages');
      expect(readCallBody.attributes.category).toBe('UTL');
      expect(writeCallBody.attributes.category).toBe('UTL');
    });

    it("names the read/write groups with the BCH category prefix for category 'BCH'", async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ pk: `grp-${call}` })
        });
      });

      await worker.executeOperationSafely({
        ...baseOperation,
        payload: { ...baseOperation.payload, channel_name: 'Test Channel', category: 'BCH' }
      });

      const readCallBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(readCallBody.name).toBe('tak_BCH - Test Channel_READ');
    });

    // Special-character bugfix (Māori macrons): TAK cannot handle non-ASCII
    // in an LDAP group name, so a macron channel name is ASCII-normalized
    // into both group names.
    it('ASCII-normalizes a macron channel name into both group names', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ pk: `grp-${call}` }) });
      });

      await worker.executeOperationSafely({
        ...baseOperation,
        payload: { ...baseOperation.payload, channel_name: 'Ngā Region', category: 'BCH' }
      });

      const readCallBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      const writeCallBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(readCallBody.name).toBe('tak_BCH - Nga Region_READ');
      expect(writeCallBody.name).toBe('tak_BCH - Nga Region');
      expect([...readCallBody.name].every((ch) => ch.codePointAt(0) <= 0x7f)).toBe(true);
      expect([...writeCallBody.name].every((ch) => ch.codePointAt(0) <= 0x7f)).toBe(true);
    });

    // bch-channel-category: an invalid/missing category is a permanent
    // failure (a caller bug -- GlobalChannelService always supplies a
    // validated category), never a silent fall-back.
    it('permanently fails on an invalid category, without calling Authentik at all', async () => {
      global.fetch = jest.fn();

      await worker.executeOperationSafely({
        ...baseOperation,
        payload: { ...baseOperation.payload, category: 'bogus' }
      });

      expect(global.fetch).not.toHaveBeenCalled();

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][0]).toBe('failed');
      expect(failCall[1][1]).toBe('permanent');
    });

    // Bugfix: `description` was previously never set on the two POST
    // bodies at all (the field didn't exist on the payload), so a
    // freshly created channel's Authentik groups carried no
    // `attributes.description` until the next edit via
    // updateBchChannelGroup.
    it('includes the supplied description in both groups\' attributes', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ pk: `grp-${call}` })
        });
      });

      await worker.executeOperationSafely({
        ...baseOperation,
        payload: { ...baseOperation.payload, description: 'Data package delivery channel' }
      });

      const readCallBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      const writeCallBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(readCallBody.attributes.description).toBe('Data package delivery channel');
      expect(writeCallBody.attributes.description).toBe('Data package delivery channel');
    });

    it('falls back to the channel name when no description was supplied (an optional field)', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ pk: `grp-${call}` })
        });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const readCallBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(readCallBody.attributes.description).toBe('Data Packages');
    });
  });

  /**
   * Bugfix (a BCH/UTL channel imported via "Sync Existing Channels" has
   * no service account): `provisionBchServiceAccount`. Enqueued by
   * `GlobalChannelService.provisionServiceAccount`, which has already
   * written the new username/password onto the channel's row before
   * this handler runs.
   */
  describe('provisionBchServiceAccount', () => {
    const baseOperation = {
      id: 'op-provision-1',
      operation_type: 'provision_bch_service_account',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-provision-1',
      payload: {
        bch_channel_id: 11,
        service_account_username: 'etl-data-packages',
        service_account_password: 'secret',
        read_group_id: 'grp-read',
        write_group_id: 'grp-write'
      }
    };

    beforeEach(() => {
      worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    });

    it('creates the service account, sets its password, and adds it to BOTH the read AND write groups', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation((url, options) => {
        call++;
        if (call === 1) {
          // POST /core/users/ (create)
          expect(options.method).toBe('POST');
          const body = JSON.parse(options.body);
          expect(body.username).toBe('etl-data-packages');
          expect(body.type).toBe('service_account');
          // Bugfix (collision/takeover risk): every created service
          // account is tagged with its owning channel id, so a later
          // Create_Or_Reuse lookup can tell "mine" from "not mine".
          expect(body.attributes.bch_channel_id).toBe(11);
          return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ pk: 'svc-pk' }) });
        }
        if (call === 2) {
          // POST /core/users/{pk}/set_password/
          expect(url).toContain('/set_password/');
          const body = JSON.parse(options.body);
          expect(body.password).toBe('secret');
          return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}) });
        }
        // The two add_user calls, one per group.
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({}) });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(4);
      const addUserUrls = [global.fetch.mock.calls[2][0], global.fetch.mock.calls[3][0]];
      expect(addUserUrls.some((u) => u.includes('grp-read'))).toBe(true);
      expect(addUserUrls.some((u) => u.includes('grp-write'))).toBe(true);
      for (const call of [global.fetch.mock.calls[2], global.fetch.mock.calls[3]]) {
        const body = JSON.parse(call[1].body);
        expect(body.pk).toBe('svc-pk');
      }
    });

    it('writes service_account_id onto the row, without touching read_group_id/write_group_id', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ pk: 'svc-pk' })
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE bch_channels')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[0]).not.toContain('read_group_id');
      expect(updateCall[0]).not.toContain('write_group_id');
      expect(updateCall[1]).toEqual(['svc-pk', 11]);
    });

    it('skips the write-group add when write_group_id is absent (omitted, per the real payload shape a null group id produces)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ pk: 'svc-pk' })
      });

      // write_group_id OMITTED entirely, not set to `null` -- mirroring
      // GlobalChannelService.provisionServiceAccount's own payload
      // shape, which never passes a null group id through as the
      // literal `null` (operationSchemas.js's optional-field check would
      // reject it: typeof null !== 'string').
      const payloadWithoutWriteGroup = { ...baseOperation.payload };
      delete payloadWithoutWriteGroup.write_group_id;

      await worker.executeOperationSafely({ ...baseOperation, payload: payloadWithoutWriteGroup });

      // create, set_password, ONE add_user call (read only) -- not two.
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(global.fetch.mock.calls[2][0]).toContain('grp-read');
    });

    // Bugfix (collision/takeover risk): Create_Or_Reuse now only reuses a
    // found account when it is TAGGED as belonging to this exact channel
    // (attributes.bch_channel_id matches) -- proving this app's own prior
    // attempt, not some unrelated account that merely shares the name.
    it('reuses an existing service account by username (Create_Or_Reuse) when it is tagged as belonging to THIS channel', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          // Create POST conflicts.
          return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request' });
        }
        if (call === 2) {
          // Lookup by username finds the existing account, tagged with
          // the SAME bch_channel_id this operation carries (11) --
          // proving it is this app's own prior attempt at provisioning
          // for this exact channel.
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              results: [{
                pk: 'existing-svc-pk',
                username: 'etl-data-packages',
                attributes: { bch_channel_id: 11 }
              }]
            })
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE bch_channels')
      );
      expect(updateCall[1]).toEqual(['existing-svc-pk', 11]);
    });

    // Bugfix (collision/takeover risk): the core of the fix. A found
    // account with NO bch_channel_id tag at all (never created by this
    // app -- e.g. a human's own login, or a pre-existing unrelated
    // Authentik user) must never be reused, reset, or added to this
    // channel's groups.
    it('permanently fails, and never resets/reuses the account, when the found account has NO bch_channel_id tag at all', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request' });
        }
        if (call === 2) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              results: [{ pk: 'unrelated-pk', username: 'etl-data-packages' }] // no attributes at all
            })
          });
        }
        throw new Error('Should not reach set_password or add_user for an unrelated account');
      });

      await worker.executeOperationSafely({ ...baseOperation });

      // Only the create attempt and the lookup -- no set_password, no
      // add_user, no database write.
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE bch_channels')
      );
      expect(updateCall).toBeUndefined();

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][1]).toBe('permanent');
    });

    // Bugfix (collision/takeover risk): a found account tagged with a
    // DIFFERENT channel's id (this app's own prior work, but for a
    // different channel) is just as much a collision as an untagged
    // account, and must be rejected the same way.
    it('permanently fails when the found account is tagged with a DIFFERENT bch_channel_id', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request' });
        }
        if (call === 2) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              results: [{
                pk: 'other-channel-pk',
                username: 'etl-data-packages',
                attributes: { bch_channel_id: 999 } // a different channel
              }]
            })
          });
        }
        throw new Error('Should not reach set_password or add_user for a different channel\'s account');
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][1]).toBe('permanent');
    });

    // Bugfix (collision/takeover risk): a string/number type mismatch on
    // bch_channel_id (the attribute round-trips through Authentik's own
    // JSON storage, and the payload value may already be a string from
    // its own JSON round-trip through sync_operations) must not cause a
    // false-negative rejection of a genuinely-matching account.
    it('reuses the found account when bch_channel_id matches as a STRING against a numeric payload value, or vice versa', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request' });
        }
        if (call === 2) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              results: [{
                pk: 'existing-svc-pk',
                username: 'etl-data-packages',
                attributes: { bch_channel_id: '11' } // string, payload carries 11 (number)
              }]
            })
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE bch_channels')
      );
      expect(updateCall[1]).toEqual(['existing-svc-pk', 11]);
    });

    it('results in the retryable path when the create POST fails with a 5xx and no existing account is found by lookup', async () => {
      global.fetch = jest.fn().mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('?username=')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results: [] }) });
        }
        return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][0]).toBe('pending');
    });

    it('results in the permanent-failure path when set_password fails with a 4xx', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ pk: 'svc-pk' }) });
        }
        // set_password
        return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request' });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][1]).toBe('permanent');
    });
  });

  /**
   * Bugfix (BCH credentials modal: "cycle the password"):
   * `rotateBchServiceAccountPassword`. Enqueued by
   * `GlobalChannelService.rotateServiceAccountPassword`, which has
   * already written the freshly generated encrypted password onto the
   * channel's row before this handler runs.
   */
  describe('rotateBchServiceAccountPassword', () => {
    const baseOperation = {
      id: 'op-rotate-1',
      operation_type: 'rotate_bch_service_account_password',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-rotate-1',
      payload: {
        bch_channel_id: 11,
        service_account_username: 'etl-data-packages',
        service_account_password: 'new-secret'
      }
    };

    beforeEach(() => {
      worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    });

    it('looks up the existing service account by username and sets its new password', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation((url, options) => {
        call++;
        if (call === 1) {
          expect(url).toContain('?username=etl-data-packages');
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ results: [{ pk: 'svc-pk', username: 'etl-data-packages' }] })
          });
        }
        expect(url).toContain('/set_password/');
        const body = JSON.parse(options.body);
        expect(body.password).toBe('new-secret');
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}) });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('permanently fails when the service account is not found in Authentik (never retries against a target that will always 404)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ results: [] })
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][0]).toBe('failed');
      expect(failCall[1][1]).toBe('permanent');
    });

    it('results in the retryable path when the username lookup itself fails with a 5xx', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

      await worker.executeOperationSafely({ ...baseOperation });

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][0]).toBe('pending');
    });

    it('results in the permanent-failure path when set_password itself fails with a 4xx', async () => {
      let call = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ results: [{ pk: 'svc-pk', username: 'etl-data-packages' }] })
          });
        }
        return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request' });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][1]).toBe('permanent');
    });
  });

  /**
   * Bugfix (BCH credentials modal: "delete the service account"):
   * `deleteBchServiceAccount`. Enqueued by
   * `GlobalChannelService.deleteServiceAccount`, which has already
   * cleared the local service_account_id/username/password columns
   * before this handler runs.
   */
  describe('deleteBchServiceAccount', () => {
    const baseOperation = {
      id: 'op-delete-svc-1',
      operation_type: 'delete_bch_service_account',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-delete-svc-1',
      payload: {
        bch_channel_id: 11,
        service_account_username: 'etl-data-packages',
        service_account_id: 'svc-pk-known'
      }
    };

    beforeEach(() => {
      worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    });

    it('deletes by the known service_account_id directly, without any username lookup', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch.mock.calls[0][0]).toContain('svc-pk-known');
      expect(global.fetch.mock.calls[0][1].method).toBe('DELETE');
    });

    it('falls back to a username lookup, then deletes by the resolved id, when service_account_id is absent', async () => {
      const payloadWithoutId = { ...baseOperation.payload };
      delete payloadWithoutId.service_account_id;

      let call = 0;
      global.fetch = jest.fn().mockImplementation((url) => {
        call++;
        if (call === 1) {
          expect(url).toContain('?username=etl-data-packages');
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ results: [{ pk: 'resolved-pk', username: 'etl-data-packages' }] })
          });
        }
        expect(url).toContain('resolved-pk');
        return Promise.resolve({ ok: true, status: 204 });
      });

      await worker.executeOperationSafely({ ...baseOperation, payload: payloadWithoutId });

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('is a no-op (no error, no retry) when the username lookup finds no matching account', async () => {
      const payloadWithoutId = { ...baseOperation.payload };
      delete payloadWithoutId.service_account_id;

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ results: [] })
      });

      await worker.executeOperationSafely({ ...baseOperation, payload: payloadWithoutId });

      // No failure/retry UPDATE at all -- markOperationCompleted's own
      // UPDATE is the only one issued, distinguishable from a failure by
      // NOT containing failure_category or next_retry_at.
      const failureOrRetryCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && (sql.includes('failure_category') || sql.includes('next_retry_at'))
      );
      expect(failureOrRetryCall).toBeUndefined();
    });

    it('is a no-op (no error, no retry) when the DELETE itself 404s (already deleted)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await worker.executeOperationSafely({ ...baseOperation });

      const failureOrRetryCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && (sql.includes('failure_category') || sql.includes('next_retry_at'))
      );
      expect(failureOrRetryCall).toBeUndefined();
    });

    it('results in the retryable path when the DELETE fails with a 5xx', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

      await worker.executeOperationSafely({ ...baseOperation });

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][0]).toBe('pending');
    });

    it('results in the retryable path when the username lookup itself fails with a 5xx', async () => {
      const payloadWithoutId = { ...baseOperation.payload };
      delete payloadWithoutId.service_account_id;

      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

      await worker.executeOperationSafely({ ...baseOperation, payload: payloadWithoutId });

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][0]).toBe('pending');
    });
  });

  /**
   * bch-channel-category: `updateBchChannelGroup`'s category-aware
   * rename-PATCH naming, mirroring `updateRegionChannelGroup`'s own
   * tier-naming tests below in shape.
   */
  describe('updateBchChannelGroup category naming', () => {
    const baseOperation = {
      id: 'op-bch-category-update-1',
      operation_type: 'update_bch_channel_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-bch-category-update-1',
      payload: {
        bch_channel_id: 11,
        channel_name: 'Data Packages',
        category: 'UTL',
        description: 'Data package delivery channel'
      }
    };

    beforeEach(() => {
      worker.pool.query = jest.fn().mockResolvedValue({
        rows: [{ read_group_id: 'read-pk', write_group_id: 'write-pk' }]
      });
    });

    it("PATCHes both groups with the category's prefix (tak_XtraTools for category 'UTL')", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const readBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      const writeBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(readBody.name).toBe('tak_XtraTools - Data Packages_READ');
      expect(writeBody.name).toBe('tak_XtraTools - Data Packages');
      expect(readBody.attributes.category).toBe('UTL');
    });

    it("PATCHes both groups with the BCH category prefix for category 'BCH'", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      await worker.executeOperationSafely({
        ...baseOperation,
        payload: { ...baseOperation.payload, channel_name: 'Test Channel', category: 'BCH' }
      });

      const readBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(readBody.name).toBe('tak_BCH - Test Channel_READ');
    });

    it('permanently fails on an invalid category, without calling Authentik at all', async () => {
      global.fetch = jest.fn();

      await worker.executeOperationSafely({
        ...baseOperation,
        payload: { ...baseOperation.payload, category: 'bogus' }
      });

      expect(global.fetch).not.toHaveBeenCalled();

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][0]).toBe('failed');
      expect(failCall[1][1]).toBe('permanent');
    });
  });

  /**
   * Regression test: `createRegionChannelGroup` previously tried to create
   * a read/write GROUP PAIR for a region channel (mirroring BCH channels)
   * and then UPDATE region_channels.read_group_id/group_id -- but
   * region_channels only ever had a single `group_id` column (confirmed
   * against the baseline schema and live Authentik data: none of the real
   * `tak_Regions - *` groups have a `_READ` counterpart). That UPDATE
   * crashed every single invocation with "column read_group_id does not
   * exist". This verifies the fix creates exactly ONE group and updates
   * only `group_id`.
   */
  describe('createRegionChannelGroup', () => {
    const baseOperation = {
      id: 'op-region-group-1',
      operation_type: 'create_region_channel_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-region-group-1',
      payload: {
        channel_name: 'Auckland',
        region_channel_id: 9,
        // region-channel-tiers: required since GlobalChannelService.
        // createRegionChannel always supplies it.
        tier: 'response'
      }
    };

    beforeEach(() => {
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT description FROM region_channels')) {
          return Promise.resolve({ rows: [{ description: 'Activities in Auckland' }] });
        }
        return Promise.resolve({ rows: [] });
      });
    });

    it('creates exactly one Authentik group (no read/write pair) and updates only region_channels.group_id', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ pk: 'grp-auckland' })
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/'),
        expect.objectContaining({ method: 'POST' })
      );

      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE region_channels')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[0]).not.toContain('read_group_id');
      expect(updateCall[0]).toContain('group_id');
      expect(updateCall[1]).toEqual(['grp-auckland', 9]);
    });

    // region-channel-tiers: the group name's prefix must reflect the
    // payload's tier -- 'tak_Response - <name>' for tier 'response',
    // never the former single untiered 'tak_Regions - <name>' prefix.
    it("names the created group with the tier's prefix (tak_Response for tier 'response')", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ pk: 'grp-auckland' })
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const [, options] = global.fetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.name).toBe('tak_Response - Auckland');
    });

    // Special-character bugfix (Māori macrons): a macron region name is
    // ASCII-normalized into the group name TAK consumes.
    it('ASCII-normalizes a macron region name in the group name', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ pk: 'grp-macron' })
      });

      await worker.executeOperationSafely({
        ...baseOperation,
        payload: { ...baseOperation.payload, channel_name: 'Whakatāne' }
      });

      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.name).toBe('tak_Response - Whakatane');
      expect([...body.name].every((ch) => ch.codePointAt(0) <= 0x7f)).toBe(true);
    });

    it("names the created group with the tier's prefix (tak_Support for tier 'support')", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ pk: 'grp-auckland' })
      });

      await worker.executeOperationSafely({
        ...baseOperation,
        payload: { ...baseOperation.payload, tier: 'support' }
      });

      const [, options] = global.fetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.name).toBe('tak_Support - Auckland');
    });

    // region-channel-tiers: an invalid/missing tier is a permanent
    // failure (a caller bug -- GlobalChannelService always supplies a
    // validated tier), never a silent fall-back to the old untiered name.
    it('permanently fails on an invalid tier, without calling Authentik at all', async () => {
      global.fetch = jest.fn();

      await worker.executeOperationSafely({
        ...baseOperation,
        payload: { ...baseOperation.payload, tier: 'bogus' }
      });

      expect(global.fetch).not.toHaveBeenCalled();

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][0]).toBe('failed');
      expect(failCall[1][1]).toBe('permanent');
    });

    it('results in a markPermanentlyFailed-style UPDATE on a 4xx response from the group-creation call', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('Bad Request')
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const failCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(failCall).toBeDefined();
      expect(failCall[1][0]).toBe('failed');
      expect(failCall[1][1]).toBe('permanent');
    });

    it('results in the existing handleOperationError retryable path on a 5xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: () => Promise.resolve('Service Unavailable')
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const retryCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(retryCall).toBeDefined();
      expect(retryCall[1][0]).toBe('pending');
    });
  });

  /**
   * Regression test: `syncExistingGlobalChannels` previously fetched only
   * a single page (`?page_size=1000`) of Authentik groups, so any
   * BCH/Region group landing on page 2+ of a larger Authentik group list
   * was silently never imported. This verifies the fix follows
   * `pagination.next` (mirroring `authentikSync.js`'s `fetchGroupMap`)
   * across multiple pages before scanning for BCH/Region groups.
   */
  describe('syncExistingGlobalChannels pagination', () => {
    const separator = ' - ';
    const originalSeparator = process.env.CHANNEL_FOLDER_SEPARATOR;

    beforeEach(() => {
      process.env.CHANNEL_FOLDER_SEPARATOR = separator;
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT id FROM bch_channels')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('SELECT id FROM region_channels')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')) {
          return Promise.resolve({ rows: [{ id: 1 }] });
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO region_channels')) {
          return Promise.resolve({ rows: [{ id: 2 }] });
        }
        return Promise.resolve({ rows: [] });
      });
    });

    afterEach(() => {
      process.env.CHANNEL_FOLDER_SEPARATOR = originalSeparator;
    });

    it('follows pagination.next across multiple pages and imports a BCH group found only on page 2', async () => {
      // Region channels are a SINGLE Authentik group per channel (no
      // "_READ" pair like BCH channels have -- see the region-matching
      // fix in syncExistingGlobalChannels). region-channel-tiers: the
      // prefix is now tier-specific (tak_Response/tak_Support), not the
      // former single untiered tak_Regions.
      const page1Groups = [
        { pk: 'g1', name: `tak_Response${separator}North`, attributes: {} }
      ];
      const page2Groups = [
        { pk: 'g3', name: `tak_BCH${separator}Alpha_READ`, attributes: {} },
        { pk: 'g4', name: `tak_BCH${separator}Alpha`, attributes: {} }
      ];

      global.fetch = jest.fn().mockImplementation((url) => {
        if (url.includes('page=2')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ results: page2Groups, pagination: { next: null } })
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ results: page1Groups, pagination: { next: 2 } })
        });
      });

      await worker.syncExistingGlobalChannels({ synced_by: 1 });

      // Fetched exactly two pages.
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('page=1'), expect.anything());
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('page=2'), expect.anything());

      // The BCH group from page 2 was imported despite being absent from page 1.
      const insertCalls = worker.pool.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')
      );
      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0][1]).toEqual(expect.arrayContaining(['Alpha']));

      // The Region group from page 1 was also imported.
      const regionInsertCalls = worker.pool.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO region_channels')
      );
      expect(regionInsertCalls).toHaveLength(1);
      expect(regionInsertCalls[0][1]).toEqual(expect.arrayContaining(['North']));
    });

    it('stops paginating once pagination.next is absent (single-page case still works)', async () => {
      const groups = [
        { pk: 'g1', name: `tak_BCH${separator}Solo_READ`, attributes: {} },
        { pk: 'g2', name: `tak_BCH${separator}Solo`, attributes: {} }
      ];

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: groups, pagination: {} })
      });

      await worker.syncExistingGlobalChannels({ synced_by: 1 });

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * bch-channel-category: `syncExistingGlobalChannels` recognizes BOTH
   * 'tak_BCH...' and 'tak_XtraTools...' prefixed groups (looping
   * BCH_CHANNEL_CATEGORY_PREFIX, mirroring how the region-channel loop
   * iterates REGION_CHANNEL_TIER_PREFIX), and scopes its existence
   * check/import by (name, category) so a same-named BCH and UTL channel
   * are never conflated. 'XtraTools' is the display prefix for the DB
   * category value 'UTL' (renamed from the former display prefix 'UTL'
   * itself -- the CATEGORY VALUE stored on the row is unchanged).
   */
  describe('syncExistingGlobalChannels BCH/UTL category recognition', () => {
    const separator = ' - ';
    const originalSeparator = process.env.CHANNEL_FOLDER_SEPARATOR;

    beforeEach(() => {
      process.env.CHANNEL_FOLDER_SEPARATOR = separator;
    });

    afterEach(() => {
      process.env.CHANNEL_FOLDER_SEPARATOR = originalSeparator;
    });

    it('imports a tak_XtraTools group as a new bch_channels row with category=\'UTL\'', async () => {
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT id FROM bch_channels')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')) {
          return Promise.resolve({ rows: [{ id: 1 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const groups = [
        { pk: 'g1', name: `tak_XtraTools${separator}Data Packages_READ`, attributes: {} },
        { pk: 'g2', name: `tak_XtraTools${separator}Data Packages`, attributes: {} }
      ];
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: groups, pagination: {} })
      });

      await worker.syncExistingGlobalChannels({ synced_by: 1 });

      const insertCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')
      );
      expect(insertCall).toBeDefined();
      // name, display_name, description, read_group_id, write_group_id, category, created_by
      expect(insertCall[1]).toEqual(['Data Packages', 'Data Packages', 'XtraTools Channel - Data Packages', 'g1', 'g2', 'UTL', 1]);
    });

    it('checks existence scoped by (name, category) -- a "Data Packages" BCH row does not satisfy a UTL import', async () => {
      let existingCheckCalls = [];
      worker.pool.query = jest.fn().mockImplementation((sql, params) => {
        if (typeof sql === 'string' && sql.includes('SELECT id FROM bch_channels')) {
          existingCheckCalls.push(params);
          // Simulate: a BCH row with this name exists, but no UTL row does.
          return Promise.resolve(
            params[1] === 'BCH' ? { rows: [{ id: 42 }] } : { rows: [] }
          );
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')) {
          return Promise.resolve({ rows: [{ id: 2 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const groups = [
        { pk: 'g1', name: `tak_XtraTools${separator}Data Packages_READ`, attributes: {} },
        { pk: 'g2', name: `tak_XtraTools${separator}Data Packages`, attributes: {} }
      ];
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: groups, pagination: {} })
      });

      await worker.syncExistingGlobalChannels({ synced_by: 1 });

      // The existence check for the UTL group was scoped to category
      // 'UTL' (found none), and a UTL row was still created despite a
      // same-named BCH row existing.
      expect(existingCheckCalls).toEqual(expect.arrayContaining([['Data Packages', 'UTL']]));
      const insertCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][5]).toBe('UTL');
    });

    it('updates an existing UTL row (by name AND category) rather than duplicating it', async () => {
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT id FROM bch_channels')) {
          return Promise.resolve({ rows: [{ id: 5 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const groups = [
        { pk: 'g1', name: `tak_XtraTools${separator}Data Packages_READ`, attributes: {} },
        { pk: 'g2', name: `tak_XtraTools${separator}Data Packages`, attributes: {} }
      ];
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: groups, pagination: {} })
      });

      await worker.syncExistingGlobalChannels({ synced_by: 1 });

      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE bch_channels')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[0]).toContain('category = $5');
      expect(updateCall[1]).toEqual(expect.arrayContaining(['g1', 'g2', 'Data Packages', 'UTL']));

      const insertCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')
      );
      expect(insertCall).toBeUndefined();
    });
  });
});

/**
 * region-channel-tiers (task 8): assignUserToGlobalChannels resolves a
 * user's Organisation via their Direct_Membership, reads
 * response_channel_access/support_channel_access off it, diffs the
 * user's REAL current Authentik group membership (scoped to only the
 * groups this reconcile owns) against the target set, and both adds AND
 * removes as needed. Rewritten in task 8 to remove the old
 * isPrivateTeamUser branch entirely.
 */
describe('SyncWorker.assignUserToGlobalChannels', () => {
  let worker;
  let originalFetch;

  // Builds a pool.query router keyed on distinguishing substrings in the
  // SQL text, mirroring the `routePool` helper used elsewhere in this
  // file for CloudTAK handler tests.
  function routePool({
    directMembershipRows = [],
    bchReadGroupIds = [],
    regionRows = []
  }) {
    return jest.fn((sql) => {
      if (typeof sql === 'string' && /FROM users WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, authentik_user_id: 'ak-user-1' }] });
      }
      if (typeof sql === 'string' && /FROM team_memberships/.test(sql) && /inherited_from_team_id IS NULL/.test(sql)) {
        return Promise.resolve({ rows: directMembershipRows });
      }
      if (typeof sql === 'string' && /FROM bch_channels/.test(sql)) {
        return Promise.resolve({ rows: bchReadGroupIds.map((id) => ({ read_group_id: id })) });
      }
      if (typeof sql === 'string' && /FROM region_channels/.test(sql)) {
        return Promise.resolve({ rows: regionRows });
      }
      // bulk_operations progress UPDATE, etc.
      return Promise.resolve({ rows: [] });
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.addUserToGroup = jest.fn().mockResolvedValue();
    worker.removeUserFromGroup = jest.fn().mockResolvedValue();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('adds the user to the response group when their Organisation has response_channel_access=true and they are not currently a member', async () => {
    worker.pool.query = routePool({
      directMembershipRows: [{ team_id: 5 }],
      bchReadGroupIds: [901],
      regionRows: [{ group_id: 701, tier: 'response' }, { group_id: 702, tier: 'support' }]
    });
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, parent_team_id: null, response_channel_access: true, support_channel_access: false }
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [901] }) // currently only has the BCH read group
    });

    await worker.assignUserToGlobalChannels({ target_user_id: 1 });

    expect(worker.addUserToGroup).toHaveBeenCalledWith({ target_user_id: 1, target_group_id: 701 });
    expect(worker.removeUserFromGroup).not.toHaveBeenCalled();
  });

  it('removes the user from the support group when their Organisation has support_channel_access=false but they are currently a member', async () => {
    worker.pool.query = routePool({
      directMembershipRows: [{ team_id: 5 }],
      bchReadGroupIds: [901],
      regionRows: [{ group_id: 701, tier: 'response' }, { group_id: 702, tier: 'support' }]
    });
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, parent_team_id: null, response_channel_access: false, support_channel_access: false }
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [901, 702] }) // currently has BCH + support, but the flag is now off
    });

    await worker.assignUserToGlobalChannels({ target_user_id: 1 });

    expect(worker.removeUserFromGroup).toHaveBeenCalledWith({ target_user_id: 1, target_group_id: 702 });
    expect(worker.addUserToGroup).not.toHaveBeenCalled();
  });

  it('never touches a group outside managedGroupIds (e.g. an unrelated Team/Sub_Team group) even though the user is currently a member of it', async () => {
    worker.pool.query = routePool({
      directMembershipRows: [{ team_id: 5 }],
      bchReadGroupIds: [901],
      regionRows: [{ group_id: 701, tier: 'response' }, { group_id: 702, tier: 'support' }]
    });
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, parent_team_id: null, response_channel_access: false, support_channel_access: false }
    ]);
    const UNRELATED_TEAM_GROUP_ID = 12345;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [901, UNRELATED_TEAM_GROUP_ID] })
    });

    await worker.assignUserToGlobalChannels({ target_user_id: 1 });

    // Neither add nor remove is ever called with the unrelated group id.
    expect(worker.addUserToGroup).not.toHaveBeenCalledWith(
      expect.objectContaining({ target_group_id: UNRELATED_TEAM_GROUP_ID })
    );
    expect(worker.removeUserFromGroup).not.toHaveBeenCalledWith(
      expect.objectContaining({ target_group_id: UNRELATED_TEAM_GROUP_ID })
    );
    // Nothing else needed reconciling either (bch read + both region
    // groups already absent/target-absent consistently).
    expect(worker.addUserToGroup).not.toHaveBeenCalled();
    expect(worker.removeUserFromGroup).not.toHaveBeenCalled();
  });

  it('treats a teamless user (no Direct_Membership row) as having both flags false, removing any region group they currently hold', async () => {
    worker.pool.query = routePool({
      directMembershipRows: [], // no Direct_Membership row at all
      bchReadGroupIds: [901],
      regionRows: [{ group_id: 701, tier: 'response' }, { group_id: 702, tier: 'support' }]
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [901, 701] })
    });

    await worker.assignUserToGlobalChannels({ target_user_id: 1 });

    expect(Team.getAncestorChain).not.toHaveBeenCalled();
    expect(worker.removeUserFromGroup).toHaveBeenCalledWith({ target_user_id: 1, target_group_id: 701 });
    expect(worker.addUserToGroup).not.toHaveBeenCalled();
  });

  it('never removes the BCH read group, regardless of the Organisation flags', async () => {
    worker.pool.query = routePool({
      directMembershipRows: [{ team_id: 5 }],
      bchReadGroupIds: [901],
      regionRows: []
    });
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, parent_team_id: null, response_channel_access: false, support_channel_access: false }
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [901] })
    });

    await worker.assignUserToGlobalChannels({ target_user_id: 1 });

    expect(worker.removeUserFromGroup).not.toHaveBeenCalledWith(
      expect.objectContaining({ target_group_id: 901 })
    );
  });

  it('adds the user to the BCH read group when they are not yet a member, even with no Organisation at all', async () => {
    worker.pool.query = routePool({
      directMembershipRows: [],
      bchReadGroupIds: [901],
      regionRows: []
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [] })
    });

    await worker.assignUserToGlobalChannels({ target_user_id: 1 });

    expect(worker.addUserToGroup).toHaveBeenCalledWith({ target_user_id: 1, target_group_id: 901 });
  });

  it('skips the Authentik group-membership fetch entirely (treats current membership as empty) when the user has no authentik_user_id', async () => {
    worker.pool.query = jest.fn((sql) => {
      if (typeof sql === 'string' && /FROM users WHERE id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, authentik_user_id: null }] });
      }
      if (typeof sql === 'string' && /FROM team_memberships/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && /FROM bch_channels/.test(sql)) {
        return Promise.resolve({ rows: [{ read_group_id: 901 }] });
      }
      if (typeof sql === 'string' && /FROM region_channels/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    global.fetch = jest.fn();

    await worker.assignUserToGlobalChannels({ target_user_id: 1 });

    expect(global.fetch).not.toHaveBeenCalled();
    // Nothing currently held (fetch skipped) means BCH read is the only add.
    expect(worker.addUserToGroup).toHaveBeenCalledWith({ target_user_id: 1, target_group_id: 901 });
  });

  it('continues reconciling remaining groups when one add fails, logging the error rather than throwing', async () => {
    worker.pool.query = routePool({
      directMembershipRows: [{ team_id: 5 }],
      bchReadGroupIds: [901],
      regionRows: [{ group_id: 701, tier: 'response' }, { group_id: 702, tier: 'support' }]
    });
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, parent_team_id: null, response_channel_access: true, support_channel_access: true }
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [] })
    });
    worker.addUserToGroup = jest
      .fn()
      .mockRejectedValueOnce(new Error('Authentik unreachable'))
      .mockResolvedValue();

    await expect(worker.assignUserToGlobalChannels({ target_user_id: 1 })).resolves.toBeUndefined();

    // All three target groups (bch + response + support) were attempted
    // despite the first one failing.
    expect(worker.addUserToGroup).toHaveBeenCalledTimes(3);
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });

  it('throws an AuthentikApiError when fetching the user\'s current Authentik group membership fails', async () => {
    worker.pool.query = routePool({
      directMembershipRows: [{ team_id: 5 }],
      bchReadGroupIds: [901],
      regionRows: []
    });
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, parent_team_id: null, response_channel_access: false, support_channel_access: false }
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

    await expect(worker.assignUserToGlobalChannels({ target_user_id: 1 })).rejects.toThrow(
      /Failed to fetch current Authentik group membership/
    );
  });
});

/**
 * region-channel-tiers (task 9): resyncOrgChannelTierAccess resolves
 * every Direct_Membership user under an Organisation's whole Team tree
 * (via Team.getOrganisationTeams) and fans out one
 * assign_user_to_global_channels operation per user, wrapped in a
 * bulk_operations progress record.
 */
describe('SyncWorker.resyncOrgChannelTierAccess', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
  });

  it('resolves the Organisation tree via Team.getOrganisationTeams and enqueues one operation per Direct_Membership user under it', async () => {
    Team.getOrganisationTeams.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    worker.pool.query = jest.fn().mockResolvedValue({
      rows: [{ user_id: 10 }, { user_id: 11 }]
    });
    EventPublisher.publishBulkOperation.mockResolvedValue('bulk-op-1');

    await worker.resyncOrgChannelTierAccess({ organisation_id: 1, tier: 'response' });

    expect(Team.getOrganisationTeams).toHaveBeenCalledWith(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).toContain('team_memberships');
    expect(sql).toContain('inherited_from_team_id IS NULL');
    expect(params[0]).toEqual([1, 2, 3]);

    expect(EventPublisher.publishBulkOperation).toHaveBeenCalledWith(
      expect.stringContaining('response'),
      2,
      null
    );
    // Performance-hardening: one batched multi-row enqueue, not one
    // publishOperation call per user.
    expect(EventPublisher.publishOperationsBatch).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperationsBatch).toHaveBeenCalledWith(
      'assign_user_to_global_channels',
      [
        { target_user_id: 10, bulk_operation_id: 'bulk-op-1' },
        { target_user_id: 11, bulk_operation_id: 'bulk-op-1' }
      ]
    );
  });

  it('does nothing (no bulk op, no enqueue) when the Organisation has no teams at all', async () => {
    Team.getOrganisationTeams.mockResolvedValue([]);
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });

    await worker.resyncOrgChannelTierAccess({ organisation_id: 999, tier: 'support' });

    expect(EventPublisher.publishBulkOperation).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperationsBatch).not.toHaveBeenCalled();
  });

  it('does nothing (no bulk op, no enqueue) when the Organisation tree has teams but no Direct_Membership users', async () => {
    Team.getOrganisationTeams.mockResolvedValue([{ id: 1 }]);
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });

    await worker.resyncOrgChannelTierAccess({ organisation_id: 1, tier: 'support' });

    expect(EventPublisher.publishBulkOperation).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperationsBatch).not.toHaveBeenCalled();
  });

  it('deduplicates via DISTINCT user_id in the query, never enqueuing the same user twice for one Organisation reconcile', async () => {
    Team.getOrganisationTeams.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [{ user_id: 10 }] });
    EventPublisher.publishBulkOperation.mockResolvedValue('bulk-op-2');

    await worker.resyncOrgChannelTierAccess({ organisation_id: 1, tier: 'response' });

    const [sql] = worker.pool.query.mock.calls[0];
    expect(sql).toContain('DISTINCT user_id');
    expect(EventPublisher.publishOperationsBatch).toHaveBeenCalledTimes(1);
    const [, payloads] = EventPublisher.publishOperationsBatch.mock.calls[0];
    expect(payloads).toHaveLength(1);
  });
});

/**
 * Requirement 13.5 (task 33.2): every Sync_Worker log line that has an
 * `operation` object in scope (i.e. `operation.id`, `operation.operation_type`,
 * `operation.correlation_id` are all available) must include
 * `operationId`, `operationType`, and `correlationId` on that log line,
 * so an operator can trace any Sync_Worker log line for an operation back
 * to the request that enqueued it (via `EventPublisher.publishOperation`'s
 * persisted `correlation_id`, asserted separately in
 * `EventPublisher.test.js`).
 */
describe('SyncWorker log line field audit (operationId/operationType/correlationId)', () => {
  let worker;

  const operationBase = {
    id: 'op-audit-1',
    operation_type: 'add_user_to_group',
    retry_count: 0,
    max_retries: 48,
    correlation_id: 'corr-audit-1'
  };

  function expectAllOperationLogCallsHaveTheThreeFields(mockFn, operation) {
    for (const [meta] of mockFn.mock.calls) {
      // Every logger call in this file passes a metadata object first;
      // any call whose metadata references this operation's id must also
      // carry operationType/correlationId.
      if (meta && meta.operationId === operation.id) {
        expect(meta).toHaveProperty('operationType', operation.operation_type);
        expect(meta).toHaveProperty('correlationId', operation.correlation_id);
      }
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
  });

  it('includes operationId/operationType/correlationId on every log line for a successful operation (executeOperation + executeOperationSafely + markOperationCompleted)', async () => {
    worker.addUserToGroup = jest.fn().mockResolvedValue();
    const operation = {
      ...operationBase,
      payload: { target_user_id: 42, target_group_id: 'group-1' }
    };

    await worker.executeOperationSafely(operation);

    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.debug, operation);
    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.info, operation);
    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.error, operation);

    // Sanity check that the success-path info log actually fired with all
    // three fields (not just vacuously true because no calls matched).
    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: operation.id,
        operationType: operation.operation_type,
        correlationId: operation.correlation_id
      }),
      'Operation completed successfully'
    );
  });

  it('includes operationId/operationType/correlationId on every log line for a payload-validation failure (executeOperation + markPermanentlyFailed + skip-handleOperationError debug line)', async () => {
    const operation = {
      ...operationBase,
      id: 'op-audit-2',
      correlation_id: 'corr-audit-2',
      // Missing required target_group_id -> schema validation failure.
      payload: { target_user_id: 42 }
    };

    await worker.executeOperationSafely(operation);

    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.debug, operation);
    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.info, operation);
    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.error, operation);

    expect(mockLoggerInstance.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: operation.id,
        operationType: operation.operation_type,
        correlationId: operation.correlation_id
      }),
      'Skipping handleOperationError: operation already marked permanently failed'
    );
    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: operation.id,
        operationType: operation.operation_type,
        correlationId: operation.correlation_id
      }),
      'Sync operation marked permanently failed'
    );
  });

  it('includes operationId/operationType/correlationId on every log line for an operation-level failure (executeOperationSafely + handleOperationError)', async () => {
    const operation = {
      ...operationBase,
      id: 'op-audit-3',
      correlation_id: 'corr-audit-3',
      operation_type: 'some_totally_unregistered_operation',
      payload: { anything: 'goes' }
    };

    await worker.executeOperationSafely(operation);

    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.debug, operation);
    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.info, operation);
    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.error, operation);

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: operation.id,
        operationType: operation.operation_type,
        correlationId: operation.correlation_id
      }),
      'Operation failed'
    );
  });

  it('includes operationId/operationType/correlationId on the permanent-failure log line for a classified 4xx Authentik failure', async () => {
    worker.getUser = jest.fn().mockResolvedValue({ id: 42, authentik_user_id: 'ak-42' });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

    const operation = {
      ...operationBase,
      id: 'op-audit-4',
      correlation_id: 'corr-audit-4',
      payload: { target_user_id: 42, target_group_id: 'group-1' }
    };

    await worker.executeOperationSafely(operation);

    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.error, operation);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: operation.id,
        operationType: operation.operation_type,
        correlationId: operation.correlation_id
      }),
      'Authentik API call failed permanently; not scheduling a retry'
    );
  });

  it('includes operationId/operationType/correlationId on the "Failed to update status for operation" line when the post-execution status update itself throws', async () => {
    worker.addUserToGroup = jest.fn().mockResolvedValue();
    // Force markOperationCompleted to exhaust retries and log the
    // "Giving up" error, exercising the outer catch's log line too.
    worker.pool.query = jest.fn().mockRejectedValue(new Error('db down'));
    worker.retryDelay = 0;

    const operation = {
      ...operationBase,
      id: 'op-audit-5',
      correlation_id: 'corr-audit-5',
      payload: { target_user_id: 42, target_group_id: 'group-1' }
    };

    await worker.executeOperationSafely(operation);

    expectAllOperationLogCallsHaveTheThreeFields(mockLoggerInstance.error, operation);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: operation.id,
        operationType: operation.operation_type,
        correlationId: operation.correlation_id
      }),
      'Giving up on marking operation as completed'
    );
  });
});

/**
 * Requirement 14.6/task 34.4: `updateHeartbeat()` upserts the single
 * `sync_worker_heartbeat` row (id fixed at 1) via
 * `INSERT ... ON CONFLICT (id) DO UPDATE`, and `start()`'s poll loop
 * calls it exactly once per completed cycle -- after
 * `processNextOperation()` resolves, regardless of whether that cycle
 * found any pending operations.
 */
describe('SyncWorker heartbeat upsert', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    // Requirement 25 (task 47.1): avoid starting a real
    // RetentionCleanupJob (with a live setInterval) when exercising the
    // real start() loop in this describe block's tests below.
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
  });

  it('upserts the sync_worker_heartbeat row with id=1 via ON CONFLICT DO UPDATE', async () => {
    await worker.updateHeartbeat();

    expect(worker.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = worker.pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO sync_worker_heartbeat');
    expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
    expect(sql).toContain('last_heartbeat_at');
    expect(params).toEqual([String(process.pid)]);
  });

  it('logs and swallows an error instead of throwing, so a heartbeat write failure can never crash the poll loop', async () => {
    worker.pool.query = jest.fn().mockRejectedValue(new Error('db unavailable'));

    await expect(worker.updateHeartbeat()).resolves.toBeUndefined();
  });

  it('calls updateHeartbeat exactly once per poll cycle, after processNextOperation completes', async () => {
    const callOrder = [];
    worker.processNextOperation = jest.fn().mockImplementation(async () => {
      callOrder.push('processNextOperation');
    });
    worker.updateHeartbeat = jest.fn().mockImplementation(async () => {
      callOrder.push('updateHeartbeat');
    });
    worker.startHealthServer = jest.fn();
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
    worker.sleep = jest.fn().mockImplementation(() => {
      // Stop the loop after the first full cycle so start() resolves.
      worker.isRunning = false;
      return Promise.resolve();
    });

    await worker.start();

    expect(worker.processNextOperation).toHaveBeenCalledTimes(1);
    expect(worker.updateHeartbeat).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['processNextOperation', 'updateHeartbeat']);
  });

  it('does not call updateHeartbeat when processNextOperation throws (heartbeat only follows a completed cycle)', async () => {
    worker.processNextOperation = jest.fn().mockRejectedValue(new Error('boom'));
    worker.updateHeartbeat = jest.fn();
    worker.startHealthServer = jest.fn();
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
    let iterations = 0;
    worker.sleep = jest.fn().mockImplementation(() => {
      iterations += 1;
      if (iterations >= 1) worker.isRunning = false;
      return Promise.resolve();
    });

    await worker.start();

    expect(worker.updateHeartbeat).not.toHaveBeenCalled();
  });

  /**
   * Performance-hardening: a FULL batch (processNextOperation resolving
   * with exactly `this.batchSize`) is a strong signal the queue likely
   * still has more pending work, so the poll loop skips its fixed
   * `pollInterval` sleep entirely and loops straight back into another
   * fetch. A partial/empty/unknown-shaped batch still sleeps, to avoid a
   * tight busy-loop against a drained queue.
   */
  describe('poll loop skips the fixed sleep only when the last batch was confirmed full', () => {
    it('skips sleep(pollInterval) when processNextOperation resolves with exactly this.batchSize', async () => {
      worker.batchSize = 50;
      worker.processNextOperation = jest.fn().mockImplementation(async () => {
        worker.isRunning = false; // stop after one cycle
        return 50;
      });
      worker.updateHeartbeat = jest.fn().mockResolvedValue();
      worker.startHealthServer = jest.fn();
      worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
      worker.sleep = jest.fn().mockResolvedValue();

      await worker.start();

      expect(worker.sleep).not.toHaveBeenCalled();
    });

    it('sleeps normally when processNextOperation resolves with a partial batch (queue drained)', async () => {
      worker.batchSize = 50;
      worker.processNextOperation = jest.fn().mockResolvedValue(3);
      worker.updateHeartbeat = jest.fn().mockResolvedValue();
      worker.startHealthServer = jest.fn();
      worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
      worker.sleep = jest.fn().mockImplementation(() => {
        worker.isRunning = false;
        return Promise.resolve();
      });

      await worker.start();

      expect(worker.sleep).toHaveBeenCalledWith(worker.pollInterval);
    });

    it('sleeps normally when processNextOperation resolves with 0 (empty queue)', async () => {
      worker.batchSize = 50;
      worker.processNextOperation = jest.fn().mockResolvedValue(0);
      worker.updateHeartbeat = jest.fn().mockResolvedValue();
      worker.startHealthServer = jest.fn();
      worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
      worker.sleep = jest.fn().mockImplementation(() => {
        worker.isRunning = false;
        return Promise.resolve();
      });

      await worker.start();

      expect(worker.sleep).toHaveBeenCalledWith(worker.pollInterval);
    });

    it('sleeps normally (falls through safely) when processNextOperation resolves undefined, as a stubbed mock commonly does', async () => {
      worker.batchSize = 50;
      worker.processNextOperation = jest.fn().mockResolvedValue(undefined);
      worker.updateHeartbeat = jest.fn().mockResolvedValue();
      worker.startHealthServer = jest.fn();
      worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
      worker.sleep = jest.fn().mockImplementation(() => {
        worker.isRunning = false;
        return Promise.resolve();
      });

      await worker.start();

      expect(worker.sleep).toHaveBeenCalledWith(worker.pollInterval);
    });

    it('runs multiple back-to-back full-batch cycles with zero sleeps in between, then sleeps once the queue empties', async () => {
      worker.batchSize = 50;
      let call = 0;
      worker.processNextOperation = jest.fn().mockImplementation(async () => {
        call += 1;
        return call <= 3 ? 50 : 0; // 3 full cycles, then an empty one
      });
      worker.updateHeartbeat = jest.fn().mockResolvedValue();
      worker.startHealthServer = jest.fn();
      worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
      worker.sleep = jest.fn().mockImplementation(() => {
        worker.isRunning = false; // stop on the first actual sleep
        return Promise.resolve();
      });

      await worker.start();

      expect(worker.processNextOperation).toHaveBeenCalledTimes(4);
      expect(worker.sleep).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Requirement 14.6/task 34.4: `start()`/`stop()` start and stop the
 * lightweight `http.createServer` health server. `checkSyncWorkerHeartbeatHealth`
 * (the pure function backing the server's request handler) returns a
 * 200-equivalent result when the heartbeat is fresh and a
 * 503-equivalent result when it is stale, missing, or the underlying
 * query fails -- mirroring `server/routes/health.js`'s
 * `checkDatabaseConnectivity` test-friendly extraction pattern.
 */
describe('SyncWorker lightweight health server', () => {
  const { checkSyncWorkerHeartbeatHealth, HEARTBEAT_STALE_THRESHOLD_MS } = SyncWorker;
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
  });

  afterEach(async () => {
    await worker.stopHealthServer();
  });

  it('checkSyncWorkerHeartbeatHealth returns healthy when the heartbeat is recent', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ last_heartbeat_at: new Date(Date.now() - 1000) }]
      })
    };

    const result = await checkSyncWorkerHeartbeatHealth(pool);

    expect(result.healthy).toBe(true);
    expect(result.body.status).toBe('healthy');
  });

  it('checkSyncWorkerHeartbeatHealth returns unhealthy when the heartbeat is older than 90 seconds', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ last_heartbeat_at: new Date(Date.now() - (HEARTBEAT_STALE_THRESHOLD_MS + 5000)) }]
      })
    };

    const result = await checkSyncWorkerHeartbeatHealth(pool);

    expect(result.healthy).toBe(false);
    expect(result.body.status).toBe('unhealthy');
  });

  it('checkSyncWorkerHeartbeatHealth returns unhealthy when no heartbeat row exists yet', async () => {
    const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };

    const result = await checkSyncWorkerHeartbeatHealth(pool);

    expect(result.healthy).toBe(false);
    expect(result.body.status).toBe('unhealthy');
  });

  it('checkSyncWorkerHeartbeatHealth returns unhealthy (without leaking the raw DB error) when the query itself fails', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('connection terminated unexpectedly')) };

    const result = await checkSyncWorkerHeartbeatHealth(pool);

    expect(result.healthy).toBe(false);
    expect(result.body.status).toBe('unhealthy');
    expect(JSON.stringify(result.body)).not.toContain('connection terminated unexpectedly');
  });

  it('starts and stops a real http server on the configured SYNC_WORKER_HEALTH_PORT, responding 200 when the heartbeat is fresh', async () => {
    const originalPort = process.env.SYNC_WORKER_HEALTH_PORT;
    process.env.SYNC_WORKER_HEALTH_PORT = '0'; // ephemeral port
    const testWorker = new SyncWorker();
    testWorker.pool.query = jest.fn().mockResolvedValue({
      rows: [{ last_heartbeat_at: new Date() }]
    });

    testWorker.startHealthServer();
    await new Promise((resolve) => testWorker.healthServer.once('listening', resolve));
    const { port } = testWorker.healthServer.address();

    const response = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(data) }));
      }).on('error', reject);
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('healthy');

    await testWorker.stopHealthServer();
    if (originalPort === undefined) {
      delete process.env.SYNC_WORKER_HEALTH_PORT;
    } else {
      process.env.SYNC_WORKER_HEALTH_PORT = originalPort;
    }
  });

  it('responds 503 over a real http request when the heartbeat is stale', async () => {
    const originalPort = process.env.SYNC_WORKER_HEALTH_PORT;
    process.env.SYNC_WORKER_HEALTH_PORT = '0';
    const testWorker = new SyncWorker();
    testWorker.pool.query = jest.fn().mockResolvedValue({
      rows: [{ last_heartbeat_at: new Date(Date.now() - (HEARTBEAT_STALE_THRESHOLD_MS + 5000)) }]
    });

    testWorker.startHealthServer();
    await new Promise((resolve) => testWorker.healthServer.once('listening', resolve));
    const { port } = testWorker.healthServer.address();

    const response = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(data) }));
      }).on('error', reject);
    });

    expect(response.statusCode).toBe(503);
    expect(response.body.status).toBe('unhealthy');

    await testWorker.stopHealthServer();
    if (originalPort === undefined) {
      delete process.env.SYNC_WORKER_HEALTH_PORT;
    } else {
      process.env.SYNC_WORKER_HEALTH_PORT = originalPort;
    }
  });

  it('start() calls startHealthServer and stop() calls stopHealthServer', async () => {
    worker.processNextOperation = jest.fn().mockResolvedValue();
    worker.updateHeartbeat = jest.fn().mockResolvedValue();
    worker.startHealthServer = jest.fn();
    worker.stopHealthServer = jest.fn().mockResolvedValue();
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
    worker.sleep = jest.fn().mockImplementation(() => {
      worker.isRunning = false;
      return Promise.resolve();
    });

    await worker.start();
    expect(worker.startHealthServer).toHaveBeenCalledTimes(1);

    await worker.stop();
    expect(worker.stopHealthServer).toHaveBeenCalledTimes(1);
  });
});

/**
 * Requirement 25 (task 47.1): `SyncWorker.start()`/`stop()` start and
 * stop the shared `RetentionCleanupJob` alongside the health server,
 * mirroring how `startHealthServer()`/`stopHealthServer()` are already
 * called there.
 */
describe('SyncWorker RetentionCleanupJob wiring', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
  });

  it('constructs a RetentionCleanupJob instance', () => {
    expect(worker.retentionCleanupJob).toBeDefined();
    expect(typeof worker.retentionCleanupJob.start).toBe('function');
    expect(typeof worker.retentionCleanupJob.stop).toBe('function');
  });

  it('start() calls retentionCleanupJob.start()', async () => {
    worker.processNextOperation = jest.fn().mockResolvedValue();
    worker.updateHeartbeat = jest.fn().mockResolvedValue();
    worker.startHealthServer = jest.fn();
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
    worker.sleep = jest.fn().mockImplementation(() => {
      worker.isRunning = false;
      return Promise.resolve();
    });

    await worker.start();

    expect(worker.retentionCleanupJob.start).toHaveBeenCalledTimes(1);
  });

  it('stop() calls retentionCleanupJob.stop()', async () => {
    worker.stopHealthServer = jest.fn().mockResolvedValue();
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };

    await worker.stop();

    expect(worker.retentionCleanupJob.stop).toHaveBeenCalledTimes(1);
  });
});

/**
 * cert-expiry-notifications Requirement 5 (task 6.4): `SyncWorker.start()`/
 * `stop()` start and stop the shared `CertExpiryNotificationJob`
 * alongside the health server and `RetentionCleanupJob`, mirroring how
 * the RetentionCleanupJob wiring tests above already cover the
 * identical shape.
 */
describe('SyncWorker CertExpiryNotificationJob wiring', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
  });

  it('constructs a CertExpiryNotificationJob instance', () => {
    expect(worker.certExpiryNotificationJob).toBeDefined();
    expect(typeof worker.certExpiryNotificationJob.start).toBe('function');
    expect(typeof worker.certExpiryNotificationJob.stop).toBe('function');
  });

  it('start() calls certExpiryNotificationJob.start()', async () => {
    worker.processNextOperation = jest.fn().mockResolvedValue();
    worker.updateHeartbeat = jest.fn().mockResolvedValue();
    worker.startHealthServer = jest.fn();
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
    worker.certExpiryNotificationJob = { start: jest.fn(), stop: jest.fn() };
    worker.sleep = jest.fn().mockImplementation(() => {
      worker.isRunning = false;
      return Promise.resolve();
    });

    await worker.start();

    expect(worker.certExpiryNotificationJob.start).toHaveBeenCalledTimes(1);
  });

  it('stop() calls certExpiryNotificationJob.stop()', async () => {
    worker.stopHealthServer = jest.fn().mockResolvedValue();
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
    worker.certExpiryNotificationJob = { start: jest.fn(), stop: jest.fn() };

    await worker.stop();

    expect(worker.certExpiryNotificationJob.stop).toHaveBeenCalledTimes(1);
  });
});

/**
 * Requirement 26.8 (task 48.5): `revokeTakCertificates` fetches
 * `TakServerService.listCertificates()` exactly once per operation,
 * matches every `tak_usernames` entry against that single result via the
 * same `matchesCreatorDn` predicate `TakServerService` uses internally,
 * and revokes the union of matched certificate ids. Follows the same
 * classification-wiring pattern as the Authentik-calling handlers above
 * (`describe('SyncWorker Authentik failure classification wiring')`),
 * but via a dedicated `TakServerApiError` class rather than
 * `AuthentikApiError`, since `executeOperationSafely`'s classification
 * branch checks for either class.
 */
describe('SyncWorker.revokeTakCertificates', () => {
  let worker;
  // Feature device-management, Requirement 12.11 (task 24.3): a `DELETE` is now
  // issued ONLY while Revoke_Enabled is armed -- disarmed, every one of these
  // operations would complete as a successful Revoke_Dry_Run with no `DELETE`
  // at all. That gate applies to the user-scoped shape these Requirement 26.8
  // tests use as much as to the device-scoped one (Requirement 12.15), so the
  // flag is armed for the whole block; the rails' own behaviour is covered by
  // task 24.4's dedicated block.
  const originalRevokeFlag = process.env.DEVICE_MGMT_REVOKE_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    // Requirement 26.3/26.4/26.5: replace the real TakServerService
    // instance constructed in the SyncWorker constructor with a mock, so
    // these tests exercise revokeTakCertificates' own logic (matching/
    // aggregating/classification) without making any real axios/HTTPS
    // calls.
    worker.takServerService = {
      listCertificates: jest.fn(),
      // Requirement 12.16 (task 24.3): the audit record's pre/post
      // Revoked_Certificate_View counts. A never-throwing advisory read, so a
      // mock that omitted it would record `null` rather than fail -- it is
      // stubbed here so the counts in the audit record are real values.
      listRevokedCertificates: jest.fn().mockResolvedValue([]),
      revokeCertificates: jest.fn()
    };
  });

  afterEach(() => {
    if (originalRevokeFlag === undefined) {
      delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
    } else {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = originalRevokeFlag;
    }
  });

  const baseOperation = {
    id: 'op-revoke-tak-1',
    operation_type: 'revoke_tak_certificates',
    retry_count: 0,
    max_retries: 48,
    correlation_id: 'corr-revoke-tak-1',
    payload: { tak_usernames: ['alice'] }
  };

  function makeCert(overrides = {}) {
    return {
      id: 1,
      creatorDn: 'CN=alice,OU=TAK-NZ',
      revocationDate: null,
      ...overrides
    };
  }

  it('revokes every matched certificate id and completes successfully when TakServerService confirms revocation', async () => {
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, creatorDn: 'CN=alice,OU=TAK-NZ' }),
      makeCert({ id: 2, creatorDn: 'CN=bob,OU=TAK-NZ' })
    ]);
    worker.takServerService.revokeCertificates.mockResolvedValue({ success: true });

    await worker.executeOperationSafely({ ...baseOperation });

    expect(worker.takServerService.listCertificates).toHaveBeenCalledTimes(1);
    expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1]);

    const terminalCall = worker.pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('completed')
    );
    expect(terminalCall).toBeDefined();
    expect(terminalCall[1][0]).toBe('completed');
  });

  it('unions matched certificate ids across multiple tak_usernames and fetches the certificate list only once', async () => {
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, creatorDn: 'CN=alice,OU=TAK-NZ' }),
      makeCert({ id: 2, creatorDn: 'CN=bob,OU=TAK-NZ' }),
      makeCert({ id: 3, creatorDn: 'CN=carol,OU=TAK-NZ' })
    ]);
    worker.takServerService.revokeCertificates.mockResolvedValue({ success: true });

    const operation = {
      ...baseOperation,
      payload: { tak_usernames: ['alice', 'bob'] }
    };

    await worker.executeOperationSafely(operation);

    expect(worker.takServerService.listCertificates).toHaveBeenCalledTimes(1);
    expect(worker.takServerService.revokeCertificates).toHaveBeenCalledTimes(1);
    const [revokedIds] = worker.takServerService.revokeCertificates.mock.calls[0];
    expect(new Set(revokedIds)).toEqual(new Set([1, 2]));
  });

  it('is a successful no-op (no revokeCertificates call) when no certificate matches any given username', async () => {
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, creatorDn: 'CN=dave,OU=TAK-NZ' })
    ]);

    await worker.executeOperationSafely({ ...baseOperation });

    expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
    const terminalCall = worker.pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('completed')
    );
    expect(terminalCall).toBeDefined();
    expect(terminalCall[1][0]).toBe('completed');
  });

  it('treats a network/timeout error from listCertificates as retryable (handleOperationError path)', async () => {
    worker.takServerService.listCertificates.mockRejectedValue(new Error('ECONNREFUSED'));

    await worker.executeOperationSafely({ ...baseOperation });

    expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
    const terminalCall = worker.pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
    );
    expect(terminalCall).toBeDefined();
    expect(terminalCall[1][0]).toBe('pending');
  });

  it('treats a 4xx response (axios error.response.status) from revokeCertificates as permanent (markPermanentlyFailed path)', async () => {
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, creatorDn: 'CN=alice,OU=TAK-NZ' })
    ]);
    const axiosError = new Error('Bad Request');
    axiosError.response = { status: 400 };
    worker.takServerService.revokeCertificates.mockRejectedValue(axiosError);

    await worker.executeOperationSafely({ ...baseOperation });

    const terminalCall = worker.pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
    );
    expect(terminalCall).toBeDefined();
    expect(terminalCall[0]).not.toContain('next_retry_at');
    expect(terminalCall[0]).not.toContain('retry_count');
    expect(terminalCall[1][0]).toBe('failed');
    expect(terminalCall[1][1]).toBe('permanent');
  });

  it('treats a 5xx response (axios error.response.status) from revokeCertificates as retryable (handleOperationError path)', async () => {
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, creatorDn: 'CN=alice,OU=TAK-NZ' })
    ]);
    const axiosError = new Error('Service Unavailable');
    axiosError.response = { status: 503 };
    worker.takServerService.revokeCertificates.mockRejectedValue(axiosError);

    await worker.executeOperationSafely({ ...baseOperation });

    const terminalCall = worker.pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
    );
    expect(terminalCall).toBeDefined();
    expect(terminalCall[1][0]).toBe('pending');
  });

  /**
   * Requirement 26.5/26.8: a verified-failed revocation
   * (`{success: false, unverified: [...]}`) is a failure that must be
   * retried (not confirmed revoked), but it is NOT a "TAK Server
   * unreachable/error response" -- it is not wrapped in
   * `TakServerApiError`, so it always flows through the default
   * (retryable) `handleOperationError` path regardless of what a 4xx/5xx
   * classification would have said.
   */
  it('treats an unverified (success: false) revocation result as retryable, not permanently failed', async () => {
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, creatorDn: 'CN=alice,OU=TAK-NZ' })
    ]);
    worker.takServerService.revokeCertificates.mockResolvedValue({ success: false, unverified: [1] });

    await worker.executeOperationSafely({ ...baseOperation });

    const terminalCall = worker.pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && (sql.includes('next_retry_at') || sql.includes('failure_category'))
    );
    expect(terminalCall).toBeDefined();
    // Must be the retryable (next_retry_at) path, never the permanent
    // (failure_category) path.
    expect(terminalCall[0]).toContain('next_retry_at');
    expect(terminalCall[1][0]).toBe('pending');
  });
});

/**
 * Feature cloudtak-agency-groups (task 4.3): unit tests for the
 * `create_cloudtak_group`/`update_cloudtak_group` Sync_Worker handlers
 * (`createCloudTakGroup`/`updateCloudTakGroup`, both delegating to
 * `ensureCloudTakGroup`). `global.fetch` is mocked to stand in for the
 * Authentik API and `worker.pool.query` is routed by SQL text so the
 * team-load `SELECT` and the Direct_Admin_Set query
 * (`getDirectAdmins(teamId, this.pool)`) can return distinct rows.
 *
 * The fetch router below recognises each call `ensureCloudTakGroup`
 * makes by (method, url) and returns a caller-configured response, so a
 * test can assert on the exact request shapes (Requirements 2.3, 2.4,
 * 2.5, 3.4, 4.5, 5.5, 9.3, 10.1, 10.2, 10.3).
 */
describe('SyncWorker CloudTAK create/update handlers', () => {
  let worker;
  let originalFetch;

  // Route worker.pool.query by SQL: the team-load SELECT vs the
  // Direct_Admin_Set query used by getDirectAdmins. Any other query
  // (terminal status UPDATEs) resolves to empty rows.
  function routePool({ teamRow, directAdmins = [] }) {
    return jest.fn((sql) => {
      if (typeof sql === 'string' && /FROM teams WHERE id/.test(sql)) {
        return Promise.resolve({ rows: teamRow ? [teamRow] : [] });
      }
      if (typeof sql === 'string' && /FROM team_memberships/.test(sql)) {
        return Promise.resolve({ rows: directAdmins });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  // A small helper building a fetch mock that recognises each Authentik
  // call the handler makes. `handlers` maps a semantic key to a function
  // returning the mocked Response. Unhandled calls throw so a test fails
  // loudly rather than silently.
  function routeFetch(handlers) {
    return jest.fn((url, options = {}) => {
      const method = options.method || 'GET';
      if (method === 'POST' && /\/core\/groups\/$/.test(url)) {
        return Promise.resolve(handlers.createGroup(url, options));
      }
      if (method === 'GET' && /\/core\/groups\/\?name=/.test(url)) {
        return Promise.resolve(handlers.lookupByName(url, options));
      }
      if (method === 'PATCH' && /\/core\/groups\/[^/]+\/$/.test(url)) {
        return Promise.resolve(handlers.patch(url, options));
      }
      if (method === 'POST' && /\/add_user\/$/.test(url)) {
        return Promise.resolve(handlers.addUser(url, options));
      }
      if (method === 'POST' && /\/remove_user\/$/.test(url)) {
        return Promise.resolve(handlers.removeUser(url, options));
      }
      if (method === 'GET' && /\/core\/groups\/[^/?]+\/$/.test(url)) {
        return Promise.resolve(handlers.getGroup(url, options));
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
  }

  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const created = (body) => ({ ok: true, status: 201, json: async () => body });
  const conflict = () => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'exists' });
  const noContent = () => ({ ok: true, status: 204 });

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('POST body carries the group name and the three Agency_Attributes (2.3, 3.4)', async () => {
    worker.pool.query = routePool({
      teamRow: { id: 7, name: 'Southland', description: 'South Island unit' },
      directAdmins: []
    });
    global.fetch = routeFetch({
      createGroup: () => created({ pk: 'grp-7' }),
      getGroup: () => ok({ pk: 'grp-7', users: [] })
    });

    await worker.createCloudTakGroup({ team_id: 7 });

    const createCall = global.fetch.mock.calls.find(
      ([url, opts]) => (opts?.method === 'POST') && /\/core\/groups\/$/.test(url)
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse(createCall[1].body);
    expect(body.name).toBe('CloudTAKAgency7');
    expect(body.attributes).toEqual({
      agencyId: 7,
      agencyName: 'Southland',
      description: 'South Island unit'
    });
  });

  it('Create_Or_Reuse: on a 400 name-conflict it looks up by name, reuses the group, and still sets the attributes via PATCH (2.4, 2.5, 10.1)', async () => {
    worker.pool.query = routePool({
      teamRow: { id: 9, name: 'Otago', description: null },
      directAdmins: []
    });
    global.fetch = routeFetch({
      createGroup: () => conflict(),
      lookupByName: () => ok({ results: [{ pk: 'grp-9', name: 'CloudTAKAgency9' }] }),
      patch: () => ok({ pk: 'grp-9' }),
      getGroup: () => ok({ pk: 'grp-9', users: [] })
    });

    await worker.updateCloudTakGroup({ team_id: 9 });

    // Looked up by exact name.
    const lookupCall = global.fetch.mock.calls.find(([url]) => /\/core\/groups\/\?name=/.test(url));
    expect(lookupCall[0]).toContain(encodeURIComponent('CloudTAKAgency9'));

    // Attributes still set authoritatively on the reused group via PATCH.
    const patchCall = global.fetch.mock.calls.find(([, opts]) => opts?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody.attributes).toEqual({
      agencyId: 9,
      agencyName: 'Otago',
      description: null
    });
  });

  it('reconciles membership using authentik_user_id: adds missing admins and removes extra members (4.5, 5.5)', async () => {
    worker.pool.query = routePool({
      teamRow: { id: 3, name: 'Team 3', description: 'd' },
      directAdmins: [
        { user_id: 1, authentik_user_id: 'ak-1' },
        { user_id: 2, authentik_user_id: 'ak-2' }
      ]
    });
    global.fetch = routeFetch({
      createGroup: () => created({ pk: 'grp-3' }),
      // Current membership: ak-2 (keep) and ak-9 (extra -> remove); ak-1 missing -> add.
      getGroup: () => ok({ pk: 'grp-3', users: ['ak-2', 'ak-9'] }),
      addUser: () => noContent(),
      removeUser: () => noContent()
    });

    await worker.createCloudTakGroup({ team_id: 3 });

    const addCalls = global.fetch.mock.calls.filter(([url]) => /\/add_user\/$/.test(url));
    const removeCalls = global.fetch.mock.calls.filter(([url]) => /\/remove_user\/$/.test(url));

    expect(addCalls).toHaveLength(1);
    expect(JSON.parse(addCalls[0][1].body)).toEqual({ pk: 'ak-1' });
    expect(removeCalls).toHaveLength(1);
    expect(JSON.parse(removeCalls[0][1].body)).toEqual({ pk: 'ak-9' });
    // add_user/remove_user target the resolved group pk.
    expect(addCalls[0][0]).toContain('/core/groups/grp-3/add_user/');
    expect(removeCalls[0][0]).toContain('/core/groups/grp-3/remove_user/');
  });

  it('is a no-op success when the team row no longer exists (deleted between enqueue and processing)', async () => {
    worker.pool.query = routePool({ teamRow: null });
    global.fetch = jest.fn();

    await expect(worker.createCloudTakGroup({ team_id: 404 })).resolves.toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('classifies a 5xx from the create call as a retryable AuthentikApiError (9.3, 10.2)', async () => {
    worker.pool.query = routePool({ teamRow: { id: 5, name: 'T5', description: 'd' } });
    global.fetch = routeFetch({
      createGroup: () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }),
      // lookup also fails (5xx), so no group is found and the create
      // failure's classification governs.
      lookupByName: () => ({ ok: false, status: 503, statusText: 'Service Unavailable' })
    });

    await expect(worker.createCloudTakGroup({ team_id: 5 })).rejects.toMatchObject({
      name: 'AuthentikApiError',
      classification: 'retryable'
    });
  });

  it('classifies a non-conflict 4xx (e.g. 403) with no reusable group as a permanent AuthentikApiError (10.3)', async () => {
    worker.pool.query = routePool({ teamRow: { id: 6, name: 'T6', description: 'd' } });
    global.fetch = routeFetch({
      createGroup: () => ({ ok: false, status: 403, statusText: 'Forbidden' }),
      lookupByName: () => ok({ results: [] })
    });

    await expect(worker.createCloudTakGroup({ team_id: 6 })).rejects.toMatchObject({
      name: 'AuthentikApiError',
      classification: 'permanent'
    });
  });
});

/**
 * Feature cloudtak-agency-groups (task 4.6): unit tests for the
 * `delete_cloudtak_group` Sync_Worker handler (`deleteCloudTakGroup`).
 * `global.fetch` is mocked to stand in for the Authentik API. By delete
 * time the `teams` row is already gone, so the handler derives the group
 * name purely from `payload.team_id` (`CloudTAKAgency<team_id>`), resolves
 * the group by exact name, and DELETEs the resolved pk -- treating an
 * absent group or a 404 as an already-satisfied no-op (Requirements 7.2,
 * 7.3), and classifying other failures via `classifyFailure` (5xx
 * retryable, non-404 4xx permanent).
 */
describe('SyncWorker CloudTAK delete handler', () => {
  let worker;
  let originalFetch;

  // Recognises the two calls deleteCloudTakGroup makes: the lookup-by-name
  // GET and the DELETE of the resolved pk. Unhandled calls throw so a test
  // fails loudly rather than silently.
  function routeFetch(handlers) {
    return jest.fn((url, options = {}) => {
      const method = options.method || 'GET';
      if (method === 'GET' && /\/core\/groups\/\?name=/.test(url)) {
        return Promise.resolve(handlers.lookupByName(url, options));
      }
      if (method === 'DELETE' && /\/core\/groups\/[^/?]+\/$/.test(url)) {
        return Promise.resolve(handlers.deleteGroup(url, options));
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
  }

  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const noContent = () => ({ ok: true, status: 204 });
  const notFound = () => ({ ok: false, status: 404, statusText: 'Not Found' });

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('resolves the group by name then DELETEs the resolved pk on the happy path (7.2)', async () => {
    global.fetch = routeFetch({
      lookupByName: () => ok({ results: [{ pk: 'grp-10', name: 'CloudTAKAgency10' }] }),
      deleteGroup: () => noContent()
    });

    await worker.deleteCloudTakGroup({ team_id: 10 });

    // Looked up by exact name.
    const lookupCall = global.fetch.mock.calls.find(([url]) => /\/core\/groups\/\?name=/.test(url));
    expect(lookupCall).toBeDefined();
    expect(lookupCall[0]).toContain(encodeURIComponent('CloudTAKAgency10'));

    // Deleted the resolved pk.
    const deleteCall = global.fetch.mock.calls.find(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain('/core/groups/grp-10/');
  });

  it('is a no-op success when the lookup returns no matching group (absent group, 7.3)', async () => {
    global.fetch = routeFetch({
      lookupByName: () => ok({ results: [] }),
      // deleteGroup intentionally not provided -- must never be called.
      deleteGroup: () => { throw new Error('DELETE should not be issued for an absent group'); }
    });

    await expect(worker.deleteCloudTakGroup({ team_id: 11 })).resolves.toBeUndefined();

    const deleteCall = global.fetch.mock.calls.find(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCall).toBeUndefined();
  });

  it('treats a 404 from the DELETE as an already-satisfied deletion (7.3)', async () => {
    global.fetch = routeFetch({
      lookupByName: () => ok({ results: [{ pk: 'grp-12', name: 'CloudTAKAgency12' }] }),
      deleteGroup: () => notFound()
    });

    await expect(worker.deleteCloudTakGroup({ team_id: 12 })).resolves.toBeUndefined();

    // The DELETE was attempted (then 404'd into a no-op).
    const deleteCall = global.fetch.mock.calls.find(([, opts]) => opts?.method === 'DELETE');
    expect(deleteCall).toBeDefined();
  });

  it('classifies a 5xx from the lookup as a retryable AuthentikApiError', async () => {
    global.fetch = routeFetch({
      lookupByName: () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }),
      deleteGroup: () => noContent()
    });

    await expect(worker.deleteCloudTakGroup({ team_id: 13 })).rejects.toMatchObject({
      name: 'AuthentikApiError',
      classification: 'retryable'
    });
  });

  it('classifies a 5xx from the DELETE as a retryable AuthentikApiError', async () => {
    global.fetch = routeFetch({
      lookupByName: () => ok({ results: [{ pk: 'grp-14', name: 'CloudTAKAgency14' }] }),
      deleteGroup: () => ({ ok: false, status: 502, statusText: 'Bad Gateway' })
    });

    await expect(worker.deleteCloudTakGroup({ team_id: 14 })).rejects.toMatchObject({
      name: 'AuthentikApiError',
      classification: 'retryable'
    });
  });

  it('classifies a non-404 4xx (e.g. 403) from the lookup as a permanent AuthentikApiError', async () => {
    global.fetch = routeFetch({
      lookupByName: () => ({ ok: false, status: 403, statusText: 'Forbidden' }),
      deleteGroup: () => noContent()
    });

    await expect(worker.deleteCloudTakGroup({ team_id: 15 })).rejects.toMatchObject({
      name: 'AuthentikApiError',
      classification: 'permanent'
    });
  });

  it('classifies a non-404 4xx (e.g. 403) from the DELETE as a permanent AuthentikApiError', async () => {
    global.fetch = routeFetch({
      lookupByName: () => ok({ results: [{ pk: 'grp-16', name: 'CloudTAKAgency16' }] }),
      deleteGroup: () => ({ ok: false, status: 403, statusText: 'Forbidden' })
    });

    await expect(worker.deleteCloudTakGroup({ team_id: 16 })).rejects.toMatchObject({
      name: 'AuthentikApiError',
      classification: 'permanent'
    });
  });
});

/**
 * Feature cloudtak-agency-groups (task 4.4): Property 6 -- membership
 * reconciliation yields the direct-admin set. Property-tested against the
 * pure `computeMembershipDiff` helper extracted into
 * `CloudTakAgencyGroup.js`, which the Sync_Worker reconcile drives.
 */
// Feature: cloudtak-agency-groups, Property 6: Membership reconciliation yields the direct-admin set
describe('Property 6: Membership reconciliation yields the direct-admin set', () => {
  const { computeMembershipDiff } = require('../services/CloudTakAgencyGroup');

  // Applies a diff to a current set the way the Sync_Worker does: add the
  // toAdd ids, remove the toRemove ids.
  function applyDiff(current, { toAdd, toRemove }) {
    const set = new Set(current);
    for (const id of toRemove) set.delete(id);
    for (const id of toAdd) set.add(id);
    return set;
  }

  // Ids are Authentik user pks (same id space on both sides). Use small
  // integers so overlaps between current and target are frequent.
  const idArb = fc.integer({ min: 1, max: 30 });
  const setArb = fc.uniqueArray(idArb, { maxLength: 15 });

  test.prop([setArb, setArb], { numRuns: 200 })(
    'after reconcile the membership equals the target set, and a second reconcile with an unchanged target is a no-op',
    (current, target) => {
      const diff = computeMembershipDiff(current, target);
      const afterFirst = applyDiff(current, diff);

      // Converges exactly to the target set.
      expect([...afterFirst].sort((a, b) => a - b)).toEqual([...new Set(target)].sort((a, b) => a - b));

      // Second reconcile against the same target: no further changes.
      const diff2 = computeMembershipDiff([...afterFirst], target);
      expect(diff2.toAdd).toEqual([]);
      expect(diff2.toRemove).toEqual([]);
    }
  );
});

/**
 * Feature cloudtak-agency-groups (task 4.5): Property 7 -- create/update
 * attribute idempotence. Processing the handler twice against a stateful
 * mocked Authentik yields identical group name and Agency_Attributes.
 */
// Feature: cloudtak-agency-groups, Property 7: Create/update attribute idempotence
describe('Property 7: Create/update attribute idempotence', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  // A stateful in-memory Authentik double: the first create for a name
  // stores the group; a subsequent create for the same name returns a
  // 400 conflict (so the handler exercises Create_Or_Reuse + PATCH), and
  // PATCH overwrites the stored attributes.
  function makeAuthentikDouble() {
    const groupsByName = new Map();
    const groupsByPk = new Map();
    let nextPk = 1;

    global.fetch = jest.fn((url, options = {}) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : undefined;

      if (method === 'POST' && /\/core\/groups\/$/.test(url)) {
        if (groupsByName.has(body.name)) {
          return Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'exists' });
        }
        const pk = `pk-${nextPk++}`;
        const group = { pk, name: body.name, attributes: body.attributes, users: [] };
        groupsByName.set(body.name, group);
        groupsByPk.set(pk, group);
        return Promise.resolve({ ok: true, status: 201, json: async () => group });
      }
      if (method === 'GET' && /\/core\/groups\/\?name=/.test(url)) {
        const name = decodeURIComponent(url.split('name=')[1]);
        const group = groupsByName.get(name);
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ results: group ? [group] : [] }) });
      }
      if (method === 'PATCH' && /\/core\/groups\/([^/]+)\/$/.test(url)) {
        const pk = url.match(/\/core\/groups\/([^/]+)\/$/)[1];
        const group = groupsByPk.get(pk);
        if (group) group.attributes = body.attributes;
        return Promise.resolve({ ok: true, status: 200, json: async () => group });
      }
      if (method === 'GET' && /\/core\/groups\/([^/?]+)\/$/.test(url)) {
        const pk = url.match(/\/core\/groups\/([^/?]+)\/$/)[1];
        const group = groupsByPk.get(pk);
        return Promise.resolve({ ok: true, status: 200, json: async () => group });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    return { groupsByName };
  }

  const teamArb = fc.record({
    id: fc.integer({ min: 1, max: 100000 }),
    name: fc.string({ minLength: 1, maxLength: 40 }),
    description: fc.option(fc.string({ maxLength: 60 }), { nil: null })
  });

  test.prop([teamArb], { numRuns: 100 })(
    'processing create/update twice leaves the group name and Agency_Attributes identical',
    async (team) => {
      const double = makeAuthentikDouble();
      const worker = new SyncWorker();
      // No direct admins for this property: it isolates name + attributes.
      worker.pool.query = jest.fn((sql) => {
        if (typeof sql === 'string' && /FROM teams WHERE id/.test(sql)) {
          return Promise.resolve({ rows: [team] });
        }
        return Promise.resolve({ rows: [] });
      });

      await worker.createCloudTakGroup({ team_id: team.id });
      const name = `CloudTAKAgency${team.id}`;
      const afterFirst = double.groupsByName.get(name);
      const firstSnapshot = JSON.stringify({ name: afterFirst.name, attributes: afterFirst.attributes });

      // Second processing (idempotent re-run).
      await worker.updateCloudTakGroup({ team_id: team.id });
      const afterSecond = double.groupsByName.get(name);
      const secondSnapshot = JSON.stringify({ name: afterSecond.name, attributes: afterSecond.attributes });

      expect(secondSnapshot).toBe(firstSnapshot);
      expect(afterSecond.name).toBe(name);
      expect(afterSecond.attributes).toEqual({
        agencyId: team.id,
        agencyName: team.name,
        description: team.description
      });
    }
  );
});

/**
 * Feature device-management (task 8.3): `SyncWorker`'s wiring of the
 * Admin_Credential_Loader and the three scheduled device-management jobs.
 *
 * Two things are asserted here:
 *
 * 1. Requirements 1.5/1.6/1.7/9.5: `start()` starts
 *    `adminCredentialRefreshJob`/`subscriptionPoller`/`deviceSync` ONLY when
 *    `isDeviceMgmtEnabled()` is true, and `stop()` stops all three
 *    unconditionally. The flag is driven through the real
 *    `DEVICE_MGMT_ENABLED` env var (rather than by mocking
 *    `../config/deviceMgmt`) because `isDeviceMgmtEnabled(env = process.env)`
 *    reads the environment on every call, so the production predicate itself
 *    stays in the loop. Requirement 9.5's all-or-nothing rule is asserted as a
 *    property of each case: either all three jobs started, or none did --
 *    never a partial mix.
 * 2. Requirement 2.8: the `revoke_tak_certificates` handler and the three jobs
 *    share ONE `TakServerService` instance, with ONE
 *    `AdminCredentialLoader` attached to it, so a rotated Admin_Credential
 *    applies to revocation and device management alike without a restart.
 *
 * The `start()`-driving stubs mirror the existing `RetentionCleanupJob`
 * wiring tests above: the poll loop is a `while (this.isRunning)` loop, so
 * `sleep` is stubbed to clear `isRunning` and let `start()` resolve after
 * exactly one cycle.
 */
describe('SyncWorker device-management job wiring', () => {
  let worker;
  const originalFlag = process.env.DEVICE_MGMT_ENABLED;
  const originalRevokeFlag = process.env.DEVICE_MGMT_REVOKE_ENABLED;

  // Stubs every non-device-management collaborator `start()` touches, and
  // makes the poll loop run exactly one cycle.
  function stubStartLoop(w) {
    w.processNextOperation = jest.fn().mockResolvedValue();
    w.updateHeartbeat = jest.fn().mockResolvedValue();
    w.startHealthServer = jest.fn();
    w.stopHealthServer = jest.fn().mockResolvedValue();
    w.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
    w.sleep = jest.fn().mockImplementation(() => {
      w.isRunning = false;
      return Promise.resolve();
    });
  }

  // Replaces the three real jobs with start/stop spies, so no real timer,
  // secret read, or Marti call can occur in these tests.
  function stubDeviceJobs(w) {
    w.adminCredentialRefreshJob = { start: jest.fn(), stop: jest.fn() };
    w.subscriptionPoller = { start: jest.fn(), stop: jest.fn() };
    w.deviceSync = { start: jest.fn(), stop: jest.fn() };
  }

  function deviceJobStartCounts(w) {
    return [
      w.adminCredentialRefreshJob.start.mock.calls.length,
      w.subscriptionPoller.start.mock.calls.length,
      w.deviceSync.start.mock.calls.length
    ];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.DEVICE_MGMT_ENABLED;
    } else {
      process.env.DEVICE_MGMT_ENABLED = originalFlag;
    }
    if (originalRevokeFlag === undefined) {
      delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
    } else {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = originalRevokeFlag;
    }
  });

  it('constructs the Admin_Credential_Loader and the three jobs with start/stop (2.8)', () => {
    expect(worker.adminCredentialLoader).toBeDefined();
    for (const job of [worker.adminCredentialRefreshJob, worker.subscriptionPoller, worker.deviceSync]) {
      expect(job).toBeDefined();
      expect(typeof job.start).toBe('function');
      expect(typeof job.stop).toBe('function');
    }
  });

  it('gives the loader and all three jobs the SAME shared TakServerService/loader instance (2.8)', () => {
    // One service, shared by the Loader, the poller, and the sync.
    expect(worker.adminCredentialLoader.takServerService).toBe(worker.takServerService);
    expect(worker.subscriptionPoller.takServerService).toBe(worker.takServerService);
    expect(worker.deviceSync.takServerService).toBe(worker.takServerService);

    // One Loader, registered on that service (so `refreshAgent()` pulls the
    // rotated credential from it) and driven by the refresh job.
    expect(worker.takServerService.credentialLoader).toBe(worker.adminCredentialLoader);
    expect(worker.adminCredentialRefreshJob.loader).toBe(worker.adminCredentialLoader);
  });

  it('routes the revoke_tak_certificates handler through that same shared TakServerService instance (2.8)', async () => {
    // Stub the Marti calls via the POLLER's reference to the service. If the
    // revoke handler used its own separate instance, these spies would never
    // be called.
    const sharedService = worker.subscriptionPoller.takServerService;
    sharedService.listCertificates = jest.fn().mockResolvedValue([
      { id: 1, creatorDn: 'CN=alice,OU=TAK-NZ', clientUid: 'uid-1' }
    ]);
    sharedService.listRevokedCertificates = jest.fn().mockResolvedValue([]);
    sharedService.revokeCertificates = jest.fn().mockResolvedValue({ success: true });

    // Feature device-management, Requirement 12.11 (task 24.3): armed, or the
    // handler would complete as a dry-run and never reach `revokeCertificates`
    // on any service instance, shared or not.
    process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';

    await worker.revokeTakCertificates({ tak_usernames: ['alice'] });

    expect(sharedService.listCertificates).toHaveBeenCalledTimes(1);
    expect(sharedService.revokeCertificates).toHaveBeenCalledWith([1]);
  });

  it('start() starts all three device-management jobs when DEVICE_MGMT_ENABLED is true (1.5, 1.6, 1.7)', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    stubStartLoop(worker);
    stubDeviceJobs(worker);

    await worker.start();

    expect(deviceJobStartCounts(worker)).toEqual([1, 1, 1]);
  });

  it('start() starts the credential refresh job BEFORE the poller and the sync, so the credential is loaded before their first tick', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    stubStartLoop(worker);
    stubDeviceJobs(worker);

    await worker.start();

    const [refreshOrder] = worker.adminCredentialRefreshJob.start.mock.invocationCallOrder;
    const [pollerOrder] = worker.subscriptionPoller.start.mock.invocationCallOrder;
    const [syncOrder] = worker.deviceSync.start.mock.invocationCallOrder;

    expect(refreshOrder).toBeLessThan(pollerOrder);
    expect(refreshOrder).toBeLessThan(syncOrder);
  });

  it.each([
    ['false', 'false'],
    ['unset', undefined],
    ['a non-exact truthy-looking value (TRUE)', 'TRUE'],
    ['1', '1']
  ])(
    'start() starts NONE of the three device-management jobs when DEVICE_MGMT_ENABLED is %s (1.5, 1.6, 1.7, 9.5)',
    async (_label, flagValue) => {
      if (flagValue === undefined) {
        delete process.env.DEVICE_MGMT_ENABLED;
      } else {
        process.env.DEVICE_MGMT_ENABLED = flagValue;
      }
      stubStartLoop(worker);
      stubDeviceJobs(worker);

      await worker.start();

      // All-or-nothing (9.5): none started, never a partial mix.
      expect(deviceJobStartCounts(worker)).toEqual([0, 0, 0]);
      // The retention cleanup job is unaffected by DEVICE_MGMT_ENABLED --
      // it has its own, always-on schedule.
      expect(worker.retentionCleanupJob.start).toHaveBeenCalledTimes(1);
    }
  );

  it('stop() stops all three device-management jobs when the flag is true', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    stubStartLoop(worker);
    stubDeviceJobs(worker);

    await worker.stop();

    expect(worker.adminCredentialRefreshJob.stop).toHaveBeenCalledTimes(1);
    expect(worker.subscriptionPoller.stop).toHaveBeenCalledTimes(1);
    expect(worker.deviceSync.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() stops all three device-management jobs UNCONDITIONALLY, even when the flag is off and they were never started', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'false';
    stubStartLoop(worker);
    stubDeviceJobs(worker);

    await worker.stop();

    expect(worker.adminCredentialRefreshJob.stop).toHaveBeenCalledTimes(1);
    expect(worker.subscriptionPoller.stop).toHaveBeenCalledTimes(1);
    expect(worker.deviceSync.stop).toHaveBeenCalledTimes(1);
  });

  it('leaves no live device-management timer behind after a flag-on start()/stop() cycle, using the REAL jobs', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    stubStartLoop(worker);
    // Deliberately NOT stubbing the jobs here: this exercises the real
    // start()/stop() timer lifecycle. Their immediate-first-run work is
    // neutralised so no secret read or Marti call is attempted.
    worker.adminCredentialLoader.refresh = jest.fn().mockResolvedValue(undefined);
    worker.subscriptionPoller.run = jest.fn().mockResolvedValue(undefined);
    worker.deviceSync.run = jest.fn().mockResolvedValue(undefined);

    await worker.start();

    expect(worker.adminCredentialRefreshJob.timer).not.toBeNull();
    expect(worker.subscriptionPoller.timer).not.toBeNull();
    expect(worker.deviceSync.timer).not.toBeNull();

    await worker.stop();

    expect(worker.adminCredentialRefreshJob.timer).toBeNull();
    expect(worker.subscriptionPoller.timer).toBeNull();
    expect(worker.deviceSync.timer).toBeNull();
  });
});

/**
 * Feature device-management (task 9.2): the Device_Table `revoked` flag flip
 * that `revokeTakCertificates` performs via `markDevicesRevoked`.
 *
 * Requirements 7.6/8.7: the flag is flipped for the matched certificates'
 * `client_uid`s ONLY once TAK Server has CONFIRMED the revocation -- i.e. only
 * past `revokeCertificates`' verify-before-success check. Every path that does
 * not reach a confirmed success (no matching certificate, an unverified
 * `{success: false}` result, a thrown Marti error) must leave the Device_Table
 * untouched.
 *
 * Requirement 9.5: WHILE `isDeviceMgmtEnabled()` is false nothing is flipped at
 * all -- the handler behaves exactly as it did before this feature, issuing no
 * `tak_devices` write even on a confirmed-success revoke.
 *
 * As in the wiring block above, the flag is driven through the real
 * `DEVICE_MGMT_ENABLED` env var (restored in `afterEach`) so the production
 * `isDeviceMgmtEnabled()` predicate stays in the loop, and `worker.pool.query`
 * is a spy that these tests scan for the `UPDATE tak_devices` statement.
 */
describe('SyncWorker.revokeTakCertificates Device_Table revoked flag (7.6, 8.7, 9.5)', () => {
  let worker;
  const originalFlag = process.env.DEVICE_MGMT_ENABLED;
  const originalRevokeFlag = process.env.DEVICE_MGMT_REVOKE_ENABLED;

  // The `UPDATE tak_devices SET revoked = true` call, if it was issued at all.
  function findRevokeUpdateCall(w) {
    return w.pool.query.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' && sql.includes('tak_devices') && sql.includes('revoked = true')
    );
  }

  function makeCert(overrides = {}) {
    return {
      id: 1,
      creatorDn: 'CN=alice,OU=TAK-NZ',
      clientUid: 'uid-alice-1',
      revocationDate: null,
      ...overrides
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Feature device-management, Requirements 12.9/12.11 (task 24.3): armed for
    // the whole block, INDEPENDENTLY of `DEVICE_MGMT_ENABLED` -- which is what
    // lets the `it.each` below still assert that a confirmed revoke happens
    // while `DEVICE_MGMT_ENABLED` is off and only the `tak_devices` flip is
    // suppressed. Disarmed, no `DELETE` would be issued at all.
    process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    worker.takServerService = {
      listCertificates: jest.fn(),
      listRevokedCertificates: jest.fn().mockResolvedValue([]),
      revokeCertificates: jest.fn()
    };
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.DEVICE_MGMT_ENABLED;
    } else {
      process.env.DEVICE_MGMT_ENABLED = originalFlag;
    }
    if (originalRevokeFlag === undefined) {
      delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
    } else {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = originalRevokeFlag;
    }
  });

  it('sets revoked = true for exactly the matched devices after a confirmed-success revoke (7.6, 8.7)', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, creatorDn: 'CN=alice,OU=TAK-NZ', clientUid: 'uid-alice-1' }),
      makeCert({ id: 2, creatorDn: 'CN=alice,OU=TAK-NZ', clientUid: 'uid-alice-2' }),
      // Not in the payload: neither revoked nor flipped.
      makeCert({ id: 3, creatorDn: 'CN=bob,OU=TAK-NZ', clientUid: 'uid-bob-1' })
    ]);
    worker.takServerService.revokeCertificates.mockResolvedValue({ success: true });

    await worker.revokeTakCertificates({ tak_usernames: ['alice'] });

    const updateCall = findRevokeUpdateCall(worker);
    expect(updateCall).toBeDefined();
    const [, params] = updateCall;
    // Matched uids only -- bob's device is untouched.
    expect(new Set(params[0])).toEqual(new Set(['uid-alice-1', 'uid-alice-2']));
    expect(params[0]).not.toContain('uid-bob-1');
  });

  it('flips only the devices of the usernames in the payload across multiple usernames (7.6, 8.7)', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, creatorDn: 'CN=alice,OU=TAK-NZ', clientUid: 'uid-alice-1' }),
      makeCert({ id: 2, creatorDn: 'CN=bob,OU=TAK-NZ', clientUid: 'uid-bob-1' }),
      makeCert({ id: 3, creatorDn: 'CN=carol,OU=TAK-NZ', clientUid: 'uid-carol-1' })
    ]);
    worker.takServerService.revokeCertificates.mockResolvedValue({ success: true });

    await worker.revokeTakCertificates({ tak_usernames: ['alice', 'carol'] });

    const [, params] = findRevokeUpdateCall(worker);
    expect(new Set(params[0])).toEqual(new Set(['uid-alice-1', 'uid-carol-1']));
  });

  it('issues NO tak_devices write when the revocation is not confirmed (success: false) (7.6, 8.7)', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    worker.takServerService.listCertificates.mockResolvedValue([makeCert({ id: 1 })]);
    worker.takServerService.revokeCertificates.mockResolvedValue({ success: false, unverified: [1] });

    await expect(worker.revokeTakCertificates({ tak_usernames: ['alice'] })).rejects.toThrow(
      /not confirmed/i
    );

    expect(findRevokeUpdateCall(worker)).toBeUndefined();
  });

  it('issues NO tak_devices write when revokeCertificates itself throws (7.6, 8.7)', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    worker.takServerService.listCertificates.mockResolvedValue([makeCert({ id: 1 })]);
    worker.takServerService.revokeCertificates.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(worker.revokeTakCertificates({ tak_usernames: ['alice'] })).rejects.toThrow();

    expect(findRevokeUpdateCall(worker)).toBeUndefined();
  });

  it('issues NO tak_devices write on the no-match no-op path (7.6, 8.7)', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, creatorDn: 'CN=dave,OU=TAK-NZ', clientUid: 'uid-dave-1' })
    ]);

    await worker.revokeTakCertificates({ tak_usernames: ['alice'] });

    expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
    expect(findRevokeUpdateCall(worker)).toBeUndefined();
  });

  it('still revokes but issues NO tak_devices write when no matched certificate carries a clientUid (7.6, 8.7)', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, clientUid: undefined }),
      makeCert({ id: 2, clientUid: '' })
    ]);
    worker.takServerService.revokeCertificates.mockResolvedValue({ success: true });

    await worker.revokeTakCertificates({ tak_usernames: ['alice'] });

    // The certificates are still revoked on TAK Server -- they simply have no
    // Device_Table row to flip.
    expect(new Set(worker.takServerService.revokeCertificates.mock.calls[0][0])).toEqual(
      new Set([1, 2])
    );
    expect(findRevokeUpdateCall(worker)).toBeUndefined();
  });

  it.each([
    ['false', 'false'],
    ['unset', undefined],
    ['a non-exact truthy-looking value (TRUE)', 'TRUE'],
    ['1', '1']
  ])(
    'flips nothing when DEVICE_MGMT_ENABLED is %s, even on a confirmed-success revoke (9.5)',
    async (_label, flagValue) => {
      if (flagValue === undefined) {
        delete process.env.DEVICE_MGMT_ENABLED;
      } else {
        process.env.DEVICE_MGMT_ENABLED = flagValue;
      }
      worker.takServerService.listCertificates.mockResolvedValue([
        makeCert({ id: 1, clientUid: 'uid-alice-1' })
      ]);
      worker.takServerService.revokeCertificates.mockResolvedValue({ success: true });

      await worker.revokeTakCertificates({ tak_usernames: ['alice'] });

      // The certificate revocation itself is unaffected by the flag...
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1]);
      // ...but no Device_Table write is issued at all.
      expect(findRevokeUpdateCall(worker)).toBeUndefined();
    }
  );

  it('returns 0 from markDevicesRevoked without querying when the feature is off (9.5)', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'false';

    await expect(worker.markDevicesRevoked(['uid-alice-1'])).resolves.toBe(0);
    expect(worker.pool.query).not.toHaveBeenCalled();
  });

  it('returns 0 from markDevicesRevoked without querying for an empty uid set', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';

    await expect(worker.markDevicesRevoked(new Set())).resolves.toBe(0);
    expect(worker.pool.query).not.toHaveBeenCalled();
  });

  it('logs and swallows an update failure so a confirmed revocation is never reported as failed', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    worker.takServerService.listCertificates.mockResolvedValue([
      makeCert({ id: 1, clientUid: 'uid-alice-1' })
    ]);
    worker.takServerService.revokeCertificates.mockResolvedValue({ success: true });
    worker.pool.query = jest.fn().mockRejectedValue(new Error('relation "tak_devices" does not exist'));

    await expect(worker.revokeTakCertificates({ tak_usernames: ['alice'] })).resolves.toBeUndefined();

    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });

  it('returns the number of rows updated on a successful flip', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 2 });

    await expect(worker.markDevicesRevoked(['uid-alice-1', 'uid-alice-2'])).resolves.toBe(2);
  });

  it('clears connected alongside setting revoked, so a revoked device stops showing Currently Connected', async () => {
    // Revoked-guard regression (enrollment-vs-dashboard discrepancy): a revoked
    // Device is not a live participant, so the revoke both flags it revoked AND
    // clears its connection status immediately (the Subscription_Poller also
    // refuses to re-mark a revoked row connected, keeping it cleared).
    process.env.DEVICE_MGMT_ENABLED = 'true';
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });

    await worker.markDevicesRevoked(['uid-alice-1']);

    const [sql] = worker.pool.query.mock.calls[0];
    expect(sql).toMatch(/revoked = true/);
    expect(sql).toMatch(/connected = false/);
  });
});

/**
 * Feature device-management, Requirements 12.11-12.16 (task 24.4): the four
 * revocation rails `revokeTakCertificates` runs, in order, ALL before any
 * `DELETE /Marti/api/certadmin/cert/revoke/{ids}` -- the audit record, the
 * single-`client_uid` abort, the blast-radius cap, and the dry-run.
 *
 * The handler is RESOLVE-THEN-GATE, so every assertion below is about what
 * happens to an ALREADY-RESOLVED target set: that is the only point at which
 * the true blast radius is known, and it is the number these rails exist to
 * bound. This matters because this path previously over-revoked 20 real
 * certificates on a shared live TAK Server.
 *
 * Two conventions carry through the block:
 *
 *  - **The cap is set small** (`DEVICE_MGMT_REVOKE_MAX_CERTS = 3`) rather than
 *    building 250-element fixtures, and the boundary is exercised at cap-1,
 *    cap and cap+1. The production `getRevokeMaxCerts()` predicate stays in the
 *    loop because the value is driven through the real env var.
 *  - **"No `DELETE`" is asserted as "`revokeCertificates` received no call at
 *    all"**, never merely as "the operation failed". A rail that truncated the
 *    target set to the cap and proceeded would still fail some weaker
 *    assertion while having revoked a partial set -- which reports a Device as
 *    disabled while leaving it usable (Requirement 12.13).
 */
const crypto = require('crypto');

describe('SyncWorker.revokeTakCertificates revocation rails (12.11-12.16)', () => {
  let worker;
  const originalFlag = process.env.DEVICE_MGMT_ENABLED;
  const originalRevokeFlag = process.env.DEVICE_MGMT_REVOKE_ENABLED;
  const originalCap = process.env.DEVICE_MGMT_REVOKE_MAX_CERTS;

  /** The small cap every test in this block is measured against. */
  const CAP = 3;

  const TARGET_UID = 'uid-target-1';

  const operationRow = (overrides = {}) => ({
    id: 'op-rails-1',
    operation_type: 'revoke_tak_certificates',
    retry_count: 0,
    max_retries: 48,
    correlation_id: 'corr-rails-1',
    created_by: 42,
    payload: { client_uid: TARGET_UID, target_user_id: 7 },
    ...overrides
  });

  function makeCert(overrides = {}) {
    return {
      id: 1,
      creatorDn: 'CN=alice,OU=TAK-NZ',
      clientUid: TARGET_UID,
      revocationDate: null,
      ...overrides
    };
  }

  /** `count` live certificates for `clientUid`, ids 1..count. */
  function liveCertsFor(clientUid, count) {
    return Array.from({ length: count }, (_unused, index) =>
      makeCert({ id: index + 1, clientUid })
    );
  }

  /** `count` certificates all matching `CN=alice`, ids 1..count. */
  function userCertsFor(count) {
    return Array.from({ length: count }, (_unused, index) =>
      makeCert({ id: index + 1, creatorDn: 'CN=alice,OU=TAK-NZ', clientUid: `uid-alice-${index + 1}` })
    );
  }

  /** The single `revoke_audit` record rail 1 logged, if any. */
  function auditRecord() {
    const call = mockLoggerInstance.info.mock.calls.find(([, msg]) => msg === 'revoke_audit');
    return call ? call[0] : undefined;
  }

  /** The post-action `revoke_audit_result` record, from either level. */
  function auditResult() {
    const call = [...mockLoggerInstance.info.mock.calls, ...mockLoggerInstance.warn.mock.calls].find(
      ([, msg]) => msg === 'revoke_audit_result'
    );
    return call ? call[0] : undefined;
  }

  /** The `revoke_abort` record, if a rail refused the operation. */
  function abortRecord() {
    const call = mockLoggerInstance.error.mock.calls.find(
      ([, msg]) => typeof msg === 'string' && msg.startsWith('revoke_abort')
    );
    return call ? call[0] : undefined;
  }

  /** The `revoke_dry_run` record, if rail 4 refused the `DELETE`. */
  function dryRunRecord() {
    const call = mockLoggerInstance.warn.mock.calls.find(
      ([, msg]) => typeof msg === 'string' && msg.startsWith('revoke_dry_run')
    );
    return call ? call[0] : undefined;
  }

  /** The terminal `sync_operations` UPDATE, whichever path wrote it. */
  function terminalCall() {
    return worker.pool.query.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' &&
        sql.includes('sync_operations') &&
        (sql.includes('failure_category') || sql.includes('completed') || sql.includes('next_retry_at'))
    );
  }

  function revokeUpdateCall() {
    return worker.pool.query.mock.calls.find(
      ([sql]) =>
        typeof sql === 'string' && sql.includes('tak_devices') && sql.includes('revoked = true')
    );
  }

  /**
   * The digest the audit record must carry: sha256 of the sorted id list,
   * joined by commas. Recomputed here from the ids the test itself expects, so
   * a handler that logged a digest of a TRUNCATED list (while logging the full
   * one) would not match.
   */
  function expectedDigest(sortedIds) {
    return crypto.createHash('sha256').update(sortedIds.join(',')).digest('hex');
  }

  /** Invocation order of the `revoke_audit` log line. */
  function auditCallOrder() {
    const index = mockLoggerInstance.info.mock.calls.findIndex(([, msg]) => msg === 'revoke_audit');
    return mockLoggerInstance.info.mock.invocationCallOrder[index];
  }

  function arm() {
    process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
  }

  function disarm() {
    delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Device management itself is on for the whole block, so the Device_Table
    // flip is reachable and "no flag was flipped" is a real observation rather
    // than a consequence of `markDevicesRevoked`'s own feature gate.
    process.env.DEVICE_MGMT_ENABLED = 'true';
    process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = String(CAP);
    // Each test arms or disarms explicitly; nothing here should be able to make
    // a `DELETE` reachable by default.
    disarm();

    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    worker.takServerService = {
      listCertificates: jest.fn().mockResolvedValue([]),
      listLiveCertificates: jest.fn().mockResolvedValue([]),
      listRevokedCertificates: jest.fn().mockResolvedValue([]),
      revokeCertificates: jest.fn().mockResolvedValue({ success: true })
    };
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.DEVICE_MGMT_ENABLED;
    } else {
      process.env.DEVICE_MGMT_ENABLED = originalFlag;
    }
    if (originalRevokeFlag === undefined) {
      delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
    } else {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = originalRevokeFlag;
    }
    if (originalCap === undefined) {
      delete process.env.DEVICE_MGMT_REVOKE_MAX_CERTS;
    } else {
      process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = originalCap;
    }
  });

  // --- Rail 4: the dry-run (Requirement 12.11) ------------------------------
  describe('rail 4: the dry-run while Revoke_Enabled is false (12.11)', () => {
    it('logs the full audit record, issues no DELETE, flips no revoked flag, and resolves successfully', async () => {
      disarm();
      worker.takServerService.listLiveCertificates.mockResolvedValue([
        ...liveCertsFor(TARGET_UID, 2),
        makeCert({ id: 99, clientUid: 'uid-someone-else' })
      ]);

      // A dry-run is a SUCCESS, not a failure: a disarmed revoke that failed
      // would be retried until its retries ran out, and one left pending would
      // fire the instant the flag flipped.
      await expect(worker.revokeTakCertificates(operationRow().payload, operationRow()))
        .resolves.toBeUndefined();

      const record = auditRecord();
      expect(record).toBeDefined();
      expect(record.dryRun).toBe(true);
      expect(record.payloadShape).toBe('client_uid');
      expect(record.clientUid).toBe(TARGET_UID);
      // The FULL list, never truncated, and only this Device's certificates.
      expect(record.targetCertIds).toEqual([1, 2]);
      expect(record.targetCertCount).toBe(2);
      expect(record.operationId).toBe('op-rails-1');
      expect(record.actingUserId).toBe(42);

      // No DELETE at all -- not a shortened one, not an empty one.
      expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
      // No Device_Table `revoked` flip.
      expect(revokeUpdateCall()).toBeUndefined();

      const dryRun = dryRunRecord();
      expect(dryRun).toBeDefined();
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.revokedFlagFlipped).toBe(false);
      expect(dryRun.capability).toBe('DEVICE_MGMT_REVOKE_ENABLED');
      // Not an abort: the rails refused nothing, the capability is simply off.
      expect(abortRecord()).toBeUndefined();
    });

    it('completes the queued operation as completed, not failed or pending, while disarmed', async () => {
      disarm();
      worker.takServerService.listLiveCertificates.mockResolvedValue(liveCertsFor(TARGET_UID, 2));

      await worker.executeOperationSafely(operationRow());

      const terminal = terminalCall();
      expect(terminal).toBeDefined();
      expect(terminal[1][0]).toBe('completed');
      expect(terminal[0]).not.toContain('failure_category');
      expect(terminal[0]).not.toContain('next_retry_at');
      expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
    });

    it.each([['false'], ['TRUE'], ['1'], ['']])(
      'is still a dry-run for the non-exact flag value %p',
      async (value) => {
        process.env.DEVICE_MGMT_REVOKE_ENABLED = value;
        worker.takServerService.listLiveCertificates.mockResolvedValue(liveCertsFor(TARGET_UID, 1));

        await expect(worker.revokeTakCertificates(operationRow().payload, operationRow()))
          .resolves.toBeUndefined();

        expect(auditRecord().dryRun).toBe(true);
        expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
        expect(revokeUpdateCall()).toBeUndefined();
      }
    );

    // Requirement 12.15: the dry-run is shape-agnostic. The user-scoped shape
    // is the one with the LARGER blast radius, so it must not be the shape that
    // slips past the arming flag.
    it('is a dry-run for the user-scoped shape too', async () => {
      disarm();
      worker.takServerService.listCertificates.mockResolvedValue(userCertsFor(2));

      await expect(worker.revokeTakCertificates({ tak_usernames: ['alice'] })).resolves.toBeUndefined();

      expect(auditRecord().payloadShape).toBe('tak_usernames');
      expect(auditRecord().dryRun).toBe(true);
      expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
      expect(revokeUpdateCall()).toBeUndefined();
    });
  });

  // --- Rail 2: exactly one `client_uid` (Requirement 12.12) -----------------
  //
  // This rail is a DEFENSIVE INVARIANT, not a reachable resolution: as of task
  // 19.3 the device-scoped resolution selects certificates by `clientUid`
  // EQUALITY, so `resolveRevokeTargets` cannot itself produce a multi-uid set
  // for a device-scoped payload. The tests below therefore drive the gate
  // directly, by stubbing the resolution on the instance, and assert that IF the
  // resolution ever regressed into spanning Devices (the exact defect
  // Requirements 7.4/8.4/12.1 exist to correct) the gate would refuse before
  // any `DELETE`. Asserting the invariant is the point; a test that could only
  // reach it through a reachable resolution would have nothing to assert.
  describe('rail 2: a resolved set spanning two client_uids (12.12)', () => {
    function stubMultiUidResolution() {
      jest.spyOn(worker, 'resolveRevokeTargets').mockReturnValue({
        payloadShape: 'client_uid',
        clientUid: TARGET_UID,
        targetCertIds: [1, 2],
        clientUids: new Set([TARGET_UID, 'uid-a-different-device']),
        unresolvedReason: null
      });
    }

    it('aborts with no DELETE and is marked permanently failed', async () => {
      arm();
      stubMultiUidResolution();

      await expect(
        worker.revokeTakCertificates(operationRow().payload, operationRow())
      ).rejects.toThrow(/revoke_multiple_client_uids/);

      // Refused BEFORE the DELETE: no call whatsoever, so no subset of the
      // two Devices' certificates was revoked either.
      expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
      expect(revokeUpdateCall()).toBeUndefined();

      // Permanently failed, not retried: the identical operation re-run
      // resolves the identical spanning set, so retrying cannot fix it.
      const terminal = terminalCall();
      expect(terminal).toBeDefined();
      expect(terminal[0]).toContain('failure_category');
      expect(terminal[0]).not.toContain('next_retry_at');
      expect(terminal[1][0]).toBe('failed');
      expect(terminal[1][1]).toBe('permanent');
      expect(terminal[1][2]).toMatch(/revoke_multiple_client_uids/);

      // The audit record is still on the record for the refused operation.
      expect(auditRecord()).toBeDefined();
      expect(auditRecord().targetCertIds).toEqual([1, 2]);
      const abort = abortRecord();
      expect(abort).toBeDefined();
      expect(abort.reason).toBe('revoke_multiple_client_uids');
      expect(abort.resolvedClientUids).toEqual(
        expect.arrayContaining([TARGET_UID, 'uid-a-different-device'])
      );
    });

    it('marks the operation permanently failed rather than letting the retry path see it', async () => {
      arm();
      stubMultiUidResolution();

      // Through the dispatcher: `RevokeRailAbortError.alreadyHandled` must keep
      // `handleOperationError` from writing a retry row on top of the terminal
      // permanently-failed one.
      await worker.executeOperationSafely(operationRow());

      const retryCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(retryCall).toBeUndefined();
      expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
    });

    // Requirement 12.15: the single-`client_uid` constraint is device-scoped
    // ONLY. The user-scoped shape legitimately spans a user's Devices
    // (Requirement 12.3), so the same multi-uid set must NOT abort there.
    it('does not apply to the user-scoped shape, which legitimately spans Devices', async () => {
      arm();
      worker.takServerService.listCertificates.mockResolvedValue([
        makeCert({ id: 1, creatorDn: 'CN=alice,OU=TAK-NZ', clientUid: 'uid-alice-1' }),
        makeCert({ id: 2, creatorDn: 'CN=alice,OU=TAK-NZ', clientUid: 'uid-alice-2' })
      ]);

      await expect(worker.revokeTakCertificates({ tak_usernames: ['alice'] })).resolves.toBeUndefined();

      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1, 2]);
      expect(abortRecord()).toBeUndefined();
    });
  });

  // --- Rail 3: the blast-radius cap (Requirements 12.13, 12.15) -------------
  describe('rail 3: the blast-radius cap (12.13)', () => {
    it.each([
      ['one under the cap', CAP - 1],
      ['exactly at the cap', CAP]
    ])('proceeds with the FULL sorted id list when the resolved set is %s', async (_label, count) => {
      arm();
      worker.takServerService.listLiveCertificates.mockResolvedValue(
        liveCertsFor(TARGET_UID, count)
      );

      await worker.revokeTakCertificates(operationRow().payload, operationRow());

      const expectedIds = Array.from({ length: count }, (_unused, i) => i + 1);
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledTimes(1);
      // The full set, in the same sorted order the audit record recorded.
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith(expectedIds);
      expect(auditRecord().targetCertIds).toEqual(expectedIds);
      expect(auditRecord().capLimit).toBe(CAP);
      expect(abortRecord()).toBeUndefined();
    });

    it('aborts with NO DELETE at all when the resolved set is one over the cap, and does not truncate it', async () => {
      arm();
      worker.takServerService.listLiveCertificates.mockResolvedValue(
        liveCertsFor(TARGET_UID, CAP + 1)
      );

      await expect(
        worker.revokeTakCertificates(operationRow().payload, operationRow())
      ).rejects.toThrow(/revoke_cap_exceeded/);

      // The load-bearing assertion of this whole task: `revokeCertificates`
      // received NO call, so it cannot have received a shortened id list. A
      // truncate-and-proceed implementation would show a call here carrying
      // CAP of the CAP+1 ids -- reporting the Device as disabled while leaving
      // it usable, which Requirement 12.13 rules out explicitly.
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledTimes(0);
      expect(worker.takServerService.revokeCertificates.mock.calls).toEqual([]);
      expect(revokeUpdateCall()).toBeUndefined();

      const terminal = terminalCall();
      expect(terminal[1][0]).toBe('failed');
      expect(terminal[1][1]).toBe('permanent');

      // The refused set is fully on the record, un-truncated, so an operator can
      // see exactly what was refused and decide whether to raise the cap.
      const record = auditRecord();
      expect(record.targetCertCount).toBe(CAP + 1);
      expect(record.targetCertIds).toHaveLength(CAP + 1);
      expect(record.capLimit).toBe(CAP);
      expect(abortRecord().reason).toBe('revoke_cap_exceeded');
    });

    // Requirement 12.15: the cap applies to the user-scoped shape as well --
    // the shape with the larger blast radius, and the one the pre-existing call
    // sites use.
    it('applies to a user-scoped payload as well, aborting with no DELETE over the cap', async () => {
      arm();
      worker.takServerService.listCertificates.mockResolvedValue(userCertsFor(CAP + 1));

      await expect(worker.revokeTakCertificates({ tak_usernames: ['alice'] })).rejects.toThrow(
        /revoke_cap_exceeded/
      );

      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledTimes(0);
      expect(revokeUpdateCall()).toBeUndefined();
      expect(auditRecord().payloadShape).toBe('tak_usernames');
      expect(auditRecord().targetCertCount).toBe(CAP + 1);
      expect(auditRecord().capLimit).toBe(CAP);
    });

    it('honours a raised DEVICE_MGMT_REVOKE_MAX_CERTS, revoking the whole set the smaller cap refused', async () => {
      arm();
      process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = String(CAP + 1);
      worker.takServerService.listLiveCertificates.mockResolvedValue(
        liveCertsFor(TARGET_UID, CAP + 1)
      );

      await worker.revokeTakCertificates(operationRow().payload, operationRow());

      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1, 2, 3, 4]);
      expect(auditRecord().capLimit).toBe(CAP + 1);
    });
  });

  // --- Rail 1: the audit record (Requirements 12.14, 12.15, 12.16) ----------
  describe('rail 1: the audit record and its post-action counterpart (12.14, 12.16)', () => {
    it('carries every targeted id plus the count and digest, and is emitted BEFORE the DELETE', async () => {
      arm();
      worker.takServerService.listLiveCertificates.mockResolvedValue([
        // Deliberately out of id order: the recorded list, the digest and the
        // list handed to the DELETE must all be the same sorted sequence.
        makeCert({ id: 3, clientUid: TARGET_UID }),
        makeCert({ id: 1, clientUid: TARGET_UID }),
        makeCert({ id: 2, clientUid: TARGET_UID })
      ]);

      await worker.revokeTakCertificates(operationRow().payload, operationRow());

      const record = auditRecord();
      expect(record.targetCertIds).toEqual([1, 2, 3]);
      expect(record.targetCertCount).toBe(3);
      expect(record.targetCertIdsDigest).toBe(expectedDigest([1, 2, 3]));
      expect(record.operationId).toBe('op-rails-1');
      expect(record.actingUserId).toBe(42);
      expect(record.clientUid).toBe(TARGET_UID);

      // A real ordering assertion, via jest's global invocation counter: the
      // audit line was emitted before `revokeCertificates` was entered, not
      // merely at some point during the operation.
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1, 2, 3]);
      expect(auditCallOrder()).toBeLessThan(
        worker.takServerService.revokeCertificates.mock.invocationCallOrder[0]
      );
    });

    // Requirement 12.16: what a revoke changed on TAK Server must be answerable
    // by differencing two RECORDED counts rather than inferred from an absence
    // of evidence.
    it('records the pre-flight and post-flight Revoked_Certificate_View counts and the verification outcome', async () => {
      arm();
      worker.takServerService.listLiveCertificates.mockResolvedValue(liveCertsFor(TARGET_UID, 2));
      worker.takServerService.listRevokedCertificates
        .mockResolvedValueOnce(new Array(5).fill({}))  // pre-flight
        .mockResolvedValueOnce(new Array(7).fill({})); // post-flight

      await worker.revokeTakCertificates(operationRow().payload, operationRow());

      expect(auditRecord().revokedViewCountBefore).toBe(5);

      const result = auditResult();
      expect(result).toBeDefined();
      expect(result.verified).toBe(true);
      expect(result.unverified).toEqual([]);
      expect(result.revokedViewCountAfter).toBe(7);
      expect(result.targetCertCount).toBe(2);
      expect(result.revokedFlagFlipped).toBe(true);
    });

    it('records the verification outcome for an UNVERIFIED revocation too, with no revoked flag flipped', async () => {
      arm();
      worker.takServerService.listLiveCertificates.mockResolvedValue(liveCertsFor(TARGET_UID, 2));
      worker.takServerService.listRevokedCertificates
        .mockResolvedValueOnce(new Array(5).fill({}))
        .mockResolvedValueOnce(new Array(5).fill({}));
      worker.takServerService.revokeCertificates.mockResolvedValue({
        success: false,
        unverified: [2]
      });

      await expect(
        worker.revokeTakCertificates(operationRow().payload, operationRow())
      ).rejects.toThrow(/not confirmed/i);

      // "We issued the DELETE and it did not verify" is precisely the outcome
      // that has to be on the record.
      const result = auditResult();
      expect(result.verified).toBe(false);
      expect(result.unverified).toEqual([2]);
      expect(result.revokedViewCountAfter).toBe(5);
      expect(result.revokedFlagFlipped).toBe(false);
      expect(revokeUpdateCall()).toBeUndefined();
    });

    // Requirement 12.15: the audit record applies to BOTH payload shapes.
    it('logs the same record shape for a user-scoped payload, before its DELETE', async () => {
      arm();
      worker.takServerService.listCertificates.mockResolvedValue(userCertsFor(2));

      await worker.revokeTakCertificates({ tak_usernames: ['alice'] }, operationRow({
        payload: { tak_usernames: ['alice'] }
      }));

      const record = auditRecord();
      expect(record.payloadShape).toBe('tak_usernames');
      expect(record.clientUid).toBeNull();
      expect(record.targetCertIds).toEqual([1, 2]);
      expect(record.targetCertCount).toBe(2);
      expect(record.targetCertIdsDigest).toBe(expectedDigest([1, 2]));
      expect(record.capLimit).toBe(CAP);
      expect(record.actingUserId).toBe(42);
      expect(auditCallOrder()).toBeLessThan(
        worker.takServerService.revokeCertificates.mock.invocationCallOrder[0]
      );
    });

    // Requirement 12.16: a `/revoked` outage records `null` -- explicitly "we
    // could not ask" -- never `0`, which would read as "nothing was revoked".
    it('records null, not 0, when the Revoked_Certificate_View size cannot be read', async () => {
      arm();
      worker.takServerService.listLiveCertificates.mockResolvedValue(liveCertsFor(TARGET_UID, 1));
      worker.takServerService.listRevokedCertificates.mockRejectedValue(new Error('ECONNREFUSED'));

      await worker.revokeTakCertificates(operationRow().payload, operationRow());

      expect(auditRecord().revokedViewCountBefore).toBeNull();
      expect(auditResult().revokedViewCountAfter).toBeNull();
      // The advisory read must not fail an operation that did not previously
      // depend on that view.
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1]);
    });
  });

  // --- Requirements 2.11, 9.2: nothing credential-bearing is ever logged ----
  //
  // The certificate fixtures below deliberately carry the credential-shaped
  // fields a real TAK Server enrollment response can hold. The audit record is
  // built from IDENTIFIERS only, so scanning every captured log payload (keys
  // AND values, recursively) for those field names and for the fixture secret
  // strings is what makes "identifiers only" an enforced property rather than a
  // comment.
  describe('log hygiene: no credential material or passphrase in any record (2.11, 9.2)', () => {
    const FIXTURE_SECRETS = [
      'fixture-p12-bytes-should-never-be-logged',
      'fixture-passphrase-should-never-be-logged',
      'fixture-private-key-should-never-be-logged',
      'fixture-pem-body-should-never-be-logged'
    ];

    const CREDENTIAL_KEYS = ['pfx', 'p12', 'passphrase', 'password', 'cert', 'key', 'privatekey', 'secret', 'token'];

    function credentialBearingCerts(count, clientUid) {
      return Array.from({ length: count }, (_unused, index) => ({
        ...makeCert({ id: index + 1, clientUid }),
        pfx: FIXTURE_SECRETS[0],
        passphrase: FIXTURE_SECRETS[1],
        key: FIXTURE_SECRETS[2],
        cert: FIXTURE_SECRETS[3]
      }));
    }

    /** Every payload and message this suite's logger captured, flattened. */
    function capturedLogCalls() {
      return [
        ...mockLoggerInstance.info.mock.calls,
        ...mockLoggerInstance.warn.mock.calls,
        ...mockLoggerInstance.error.mock.calls,
        ...mockLoggerInstance.debug.mock.calls
      ];
    }

    /** All object keys appearing anywhere in a captured payload. */
    function collectKeys(value, seen = new Set(), keys = []) {
      if (!value || typeof value !== 'object' || seen.has(value)) return keys;
      seen.add(value);
      for (const [key, nested] of Object.entries(value)) {
        keys.push(key);
        collectKeys(nested, seen, keys);
      }
      return keys;
    }

    function assertNoCredentialMaterialLogged() {
      const calls = capturedLogCalls();
      expect(calls.length).toBeGreaterThan(0);

      for (const [payload, message] of calls) {
        const serialized = JSON.stringify(payload ?? null) + String(message ?? '');
        for (const secret of FIXTURE_SECRETS) {
          expect(serialized).not.toContain(secret);
        }
        for (const key of collectKeys(payload)) {
          expect(CREDENTIAL_KEYS).not.toContain(key.toLowerCase());
        }
      }
    }

    it('logs no credential material on the armed, successful device-scoped path', async () => {
      arm();
      worker.takServerService.listLiveCertificates.mockResolvedValue(
        credentialBearingCerts(2, TARGET_UID)
      );

      await worker.revokeTakCertificates(operationRow().payload, operationRow());

      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1, 2]);
      assertNoCredentialMaterialLogged();
    });

    it('logs no credential material on the dry-run path', async () => {
      disarm();
      worker.takServerService.listLiveCertificates.mockResolvedValue(
        credentialBearingCerts(2, TARGET_UID)
      );

      await worker.revokeTakCertificates(operationRow().payload, operationRow());

      expect(dryRunRecord()).toBeDefined();
      assertNoCredentialMaterialLogged();
    });

    it('logs no credential material on a cap abort, whose record carries the whole refused set', async () => {
      arm();
      worker.takServerService.listLiveCertificates.mockResolvedValue(
        credentialBearingCerts(CAP + 1, TARGET_UID)
      );

      await expect(
        worker.revokeTakCertificates(operationRow().payload, operationRow())
      ).rejects.toThrow(/revoke_cap_exceeded/);

      expect(auditRecord().targetCertCount).toBe(CAP + 1);
      assertNoCredentialMaterialLogged();
    });

    it('logs no credential material on the user-scoped path', async () => {
      arm();
      worker.takServerService.listCertificates.mockResolvedValue(
        credentialBearingCerts(2, 'uid-alice-1')
      );

      await worker.revokeTakCertificates({ tak_usernames: ['alice'] });

      assertNoCredentialMaterialLogged();
    });
  });

  /**
   * Feature device-management, Requirements 12.1/12.8 (task 19.7): WHICH
   * certificates the two payload shapes resolve, and which Device rows the
   * confirmed revoke flips.
   *
   * Nested inside the rails block to reuse its armed worker, its mocked
   * `TakServerService` and its `makeCert`/`revokeUpdateCall` helpers -- but it
   * asserts a different thing: the rails bound an already-resolved set, these
   * cases pin the SET ITSELF, which is the part the defect lived in.
   *
   * **The fixture is the whole point.** Two Devices (`uid-alice-phone`,
   * `uid-alice-tablet`) SHARE one `creatorDn`, because a `creatorDn` identifies
   * the enrolling USER, not the device. The old handler matched `creatorDn` for
   * every payload shape, so a per-Device revoke resolved every certificate that
   * user held across all their Devices -- how 20 certificates were over-revoked
   * on a shared live TAK Server. A fixture giving each Device its own
   * `creatorDn` would pass against that broken handler and would prove nothing;
   * this one is the only shape where the old and new behaviour differ.
   *
   * The cap is raised for this block (the rails' deliberately tiny `CAP = 3`
   * would refuse the 4-certificate user-scoped resolution before it could be
   * observed) and revocation is armed throughout, so every "revokes exactly
   * these" assertion below is a POSITIVE observation of a real
   * `revokeCertificates` call rather than a vacuous pass on the dry-run rail.
   */
  describe('device-scoped target selection across Devices sharing a creatorDn (12.1, 12.8)', () => {
    /** One enrolling user, therefore ONE `creatorDn`, across two Devices. */
    const SHARED_CREATOR_DN = 'CN=alice,OU=TAK-NZ';
    const PHONE = 'uid-alice-phone';
    const TABLET = 'uid-alice-tablet';

    /**
     * Four Live_Certificates: two per Device, interleaved by id so a handler
     * that sliced by position rather than matching by `clientUid` could not
     * accidentally agree with the expected sets.
     */
    function sharedCreatorDnCerts() {
      return [
        makeCert({ id: 1, creatorDn: SHARED_CREATOR_DN, clientUid: PHONE }),
        makeCert({ id: 2, creatorDn: SHARED_CREATOR_DN, clientUid: TABLET }),
        makeCert({ id: 3, creatorDn: SHARED_CREATOR_DN, clientUid: PHONE }),
        makeCert({ id: 4, creatorDn: SHARED_CREATOR_DN, clientUid: TABLET })
      ];
    }

    beforeEach(() => {
      arm();
      // Above every resolved set below, so the cap rail never pre-empts the
      // selection these cases are about.
      process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = '50';
      worker.takServerService.listLiveCertificates.mockResolvedValue(sharedCreatorDnCerts());
      worker.takServerService.listCertificates.mockResolvedValue(sharedCreatorDnCerts());
    });

    it.each([
      ['the phone', PHONE, [1, 3], [2, 4]],
      ['the tablet', TABLET, [2, 4], [1, 3]]
    ])(
      'revokes only %s\'s live certificates, never the other Device\'s, though both share a creatorDn',
      async (_label, targetUid, ownIds, otherDeviceIds) => {
        await worker.revokeTakCertificates(
          { client_uid: targetUid, target_user_id: 7 },
          operationRow({ payload: { client_uid: targetUid, target_user_id: 7 } })
        );

        // Positive: the DELETE happened, with exactly this Device's ids.
        expect(worker.takServerService.revokeCertificates).toHaveBeenCalledTimes(1);
        expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith(ownIds);

        // Negative: not one certificate of the sibling Device. The old
        // `creatorDn` match would have handed all four ids to this call.
        const [revokedIds] = worker.takServerService.revokeCertificates.mock.calls[0];
        for (const otherId of otherDeviceIds) {
          expect(revokedIds).not.toContain(otherId);
        }
        expect(auditRecord().targetCertIds).toEqual(ownIds);
        expect(auditRecord().resolvedClientUids).toEqual([targetUid]);
      }
    );

    // Requirement 12.8: the Device_Table flip is scoped to the ONE target
    // `client_uid`. `markDevicesRevoked` keeps its real implementation here, so
    // both the argument it received and the SQL parameter it built are observed.
    it('calls markDevicesRevoked with exactly one client_uid and flips only that Device row (12.8)', async () => {
      const markSpy = jest.spyOn(worker, 'markDevicesRevoked');

      await worker.revokeTakCertificates(
        { client_uid: PHONE, target_user_id: 7 },
        operationRow({ payload: { client_uid: PHONE, target_user_id: 7 } })
      );

      expect(markSpy).toHaveBeenCalledTimes(1);
      const [uids] = markSpy.mock.calls[0];
      // Exactly one, not "at least the right one": the sibling Device of the
      // same user must not have its flag flipped (12.8).
      expect(Array.from(uids)).toEqual([PHONE]);

      const [, params] = revokeUpdateCall();
      expect(params[0]).toEqual([PHONE]);
      expect(params[0]).not.toContain(TABLET);
      expect(auditResult().revokedFlagFlipped).toBe(true);
    });

    // Requirement 12.1: the device-scoped resolution runs against the
    // Live_Certificates (`/active` MINUS `/revoked`), never the raw
    // Active_Certificate view -- 90 of that view's 95 live entries also appeared
    // in `/revoked`, so resolving from it would re-target already-revoked ids.
    it('resolves from listLiveCertificates and never from listCertificates', async () => {
      await worker.revokeTakCertificates(
        { client_uid: PHONE, target_user_id: 7 },
        operationRow({ payload: { client_uid: PHONE, target_user_id: 7 } })
      );

      expect(worker.takServerService.listLiveCertificates).toHaveBeenCalledTimes(1);
      expect(worker.takServerService.listCertificates).not.toHaveBeenCalled();
    });

    // The corrective detail of task 19.3, stated as a test: for the
    // device-scoped shape `creatorDn` is not consulted AT ALL. Selection is
    // `clientUid` equality, so a certificate carrying the target Client_Uid
    // under some other `creatorDn` is still that Device's certificate, and one
    // carrying the shared `creatorDn` under another Client_Uid is not.
    it('selects purely on clientUid equality, ignoring creatorDn entirely', async () => {
      worker.takServerService.listLiveCertificates.mockResolvedValue([
        makeCert({ id: 1, creatorDn: SHARED_CREATOR_DN, clientUid: PHONE }),
        makeCert({ id: 2, creatorDn: 'CN=some-other-dn,OU=TAK-NZ', clientUid: PHONE }),
        makeCert({ id: 3, creatorDn: SHARED_CREATOR_DN, clientUid: TABLET })
      ]);

      await worker.revokeTakCertificates(
        { client_uid: PHONE, target_user_id: 7 },
        operationRow({ payload: { client_uid: PHONE, target_user_id: 7 } })
      );

      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1, 2]);
      expect(auditRecord().resolvedClientUids).toEqual([PHONE]);
    });

    // Requirement 12.3: the user-scoped shape is UNCHANGED by all of the above.
    // Against the very same fixture it still spans both of the user's Devices --
    // that breadth is its documented, legitimate scope, and the three
    // pre-existing call sites depend on it.
    it('leaves the user-scoped shape unchanged: it still spans every Device of that user (12.3)', async () => {
      const markSpy = jest.spyOn(worker, 'markDevicesRevoked');

      await worker.revokeTakCertificates(
        { tak_usernames: ['alice'] },
        operationRow({ payload: { tak_usernames: ['alice'] } })
      );

      expect(worker.takServerService.listCertificates).toHaveBeenCalledTimes(1);
      expect(worker.takServerService.listLiveCertificates).not.toHaveBeenCalled();
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1, 2, 3, 4]);

      const record = auditRecord();
      expect(record.payloadShape).toBe('tak_usernames');
      expect(record.clientUid).toBeNull();
      expect(new Set(record.resolvedClientUids)).toEqual(new Set([PHONE, TABLET]));

      // Both Devices' rows are flipped here -- the one case where more than one
      // `client_uid` reaches `markDevicesRevoked` legitimately.
      const [uids] = markSpy.mock.calls[0];
      expect(new Set(Array.from(uids))).toEqual(new Set([PHONE, TABLET]));
    });
  });

  /**
   * cert-expiry-notifications Requirement 8.2 (task 9.3): the `cert_ids`
   * discriminator, resolved directly against the supplied certificate id
   * array with no catalog matching -- unlike `client_uid`/`tak_usernames`,
   * which must MATCH against the fetched catalog to arrive at a target
   * set, this shape already IS the target set.
   */
  describe('cert_ids-scoped target selection (Superseding_Revoke, cert-expiry-notifications 8.2)', () => {
    const SUPERSEDED_ID = 100;
    const OTHER_LIVE_ID = 200;
    const OWNER_DN = 'CN=alice,OU=TAK-NZ';
    const OWNER_UID = 'uid-alice-phone';

    function cert_idsCatalog() {
      return [
        makeCert({ id: SUPERSEDED_ID, creatorDn: OWNER_DN, clientUid: OWNER_UID }),
        makeCert({ id: OTHER_LIVE_ID, creatorDn: OWNER_DN, clientUid: OWNER_UID })
      ];
    }

    beforeEach(() => {
      arm();
      process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = '50';
      worker.takServerService.listCertificates.mockResolvedValue(cert_idsCatalog());
      worker.takServerService.listLiveCertificates.mockResolvedValue(cert_idsCatalog());
    });

    it('revokes exactly the supplied cert_ids and no other certificate on the same client_uid/catalog', async () => {
      await worker.revokeTakCertificates(
        { cert_ids: [SUPERSEDED_ID] },
        operationRow({ payload: { cert_ids: [SUPERSEDED_ID] } })
      );

      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledTimes(1);
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([SUPERSEDED_ID]);

      const [revokedIds] = worker.takServerService.revokeCertificates.mock.calls[0];
      expect(revokedIds).not.toContain(OTHER_LIVE_ID);
    });

    it('resolves from listCertificates (the full catalog), never listLiveCertificates -- matching the user-scoped shape\'s fetch, not the device-scoped one', async () => {
      await worker.revokeTakCertificates(
        { cert_ids: [SUPERSEDED_ID] },
        operationRow({ payload: { cert_ids: [SUPERSEDED_ID] } })
      );

      expect(worker.takServerService.listCertificates).toHaveBeenCalledTimes(1);
      expect(worker.takServerService.listLiveCertificates).not.toHaveBeenCalled();
    });

    it('bypasses catalog matching for target resolution: the target set is exactly the supplied array regardless of what the catalog contains', async () => {
      // A catalog that does not even contain the superseded id -- the target
      // set must still be exactly what was supplied, not narrowed to what the
      // catalog happens to list.
      worker.takServerService.listCertificates.mockResolvedValue([
        makeCert({ id: OTHER_LIVE_ID, creatorDn: OWNER_DN, clientUid: OWNER_UID })
      ]);

      await worker.revokeTakCertificates(
        { cert_ids: [SUPERSEDED_ID] },
        operationRow({ payload: { cert_ids: [SUPERSEDED_ID] } })
      );

      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([SUPERSEDED_ID]);
    });

    it('still applies sortCertIds ordering to a multi-id cert_ids payload', async () => {
      await worker.revokeTakCertificates(
        { cert_ids: [OTHER_LIVE_ID, SUPERSEDED_ID] },
        operationRow({ payload: { cert_ids: [OTHER_LIVE_ID, SUPERSEDED_ID] } })
      );

      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith(
        [SUPERSEDED_ID, OTHER_LIVE_ID].sort((a, b) => a - b)
      );
    });

    it('resolves clientUids for the audit record purely for logging context, from the fetched catalog', async () => {
      await worker.revokeTakCertificates(
        { cert_ids: [SUPERSEDED_ID] },
        operationRow({ payload: { cert_ids: [SUPERSEDED_ID] } })
      );

      const record = auditRecord();
      expect(record.payloadShape).toBe('cert_ids');
      expect(record.clientUid).toBeNull();
      expect(record.resolvedClientUids).toEqual([OWNER_UID]);
    });

    it('flips the Device_Table revoked flag for the resolved clientUid after a confirmed revoke', async () => {
      await worker.revokeTakCertificates(
        { cert_ids: [SUPERSEDED_ID] },
        operationRow({ payload: { cert_ids: [SUPERSEDED_ID] } })
      );

      const [, params] = revokeUpdateCall();
      expect(params[0]).toEqual([OWNER_UID]);
      expect(auditResult().revokedFlagFlipped).toBe(true);
    });

    it('the existing two shapes\' tests remain unaffected by this addition (user-scoped still spans every Device)', async () => {
      worker.takServerService.listCertificates.mockResolvedValue([
        makeCert({ id: 1, creatorDn: OWNER_DN, clientUid: 'uid-alice-phone' }),
        makeCert({ id: 2, creatorDn: OWNER_DN, clientUid: 'uid-alice-tablet' })
      ]);

      await worker.revokeTakCertificates(
        { tak_usernames: ['alice'] },
        operationRow({ payload: { tak_usernames: ['alice'] } })
      );

      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledWith([1, 2]);
      expect(auditRecord().payloadShape).toBe('tak_usernames');
    });
  });
});

/**
 * Resiliency-hardening: `stop()` now waits (bounded by
 * `SHUTDOWN_DRAIN_TIMEOUT_MS`) for a currently in-flight
 * `processNextOperation()` cycle to finish before proceeding to close
 * the pool, rather than tearing down concurrently with an operation
 * still mid-flight. Mirrors `server/utils/gracefulShutdown.js`'s
 * force-proceed-on-timeout shape.
 */
describe('SyncWorker shutdown drain wait (resiliency-hardening)', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    worker.pool.end = jest.fn().mockResolvedValue();
    worker.stopHealthServer = jest.fn().mockResolvedValue();
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
    worker.certExpiryNotificationJob = { start: jest.fn(), stop: jest.fn() };
    worker.adminCredentialRefreshJob = { start: jest.fn(), stop: jest.fn() };
    worker.subscriptionPoller = { start: jest.fn(), stop: jest.fn() };
    worker.deviceSync = { start: jest.fn(), stop: jest.fn() };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('waitForActiveOperationToDrain resolves immediately when no operation is in flight', async () => {
    worker.activeOperationPromise = null;

    await expect(worker.waitForActiveOperationToDrain()).resolves.toBeUndefined();
  });

  it('waitForActiveOperationToDrain waits for the in-flight operation to settle before returning, on the fast path', async () => {
    let resolveOperation;
    worker.activeOperationPromise = new Promise((resolve) => {
      resolveOperation = resolve;
    });

    const drainPromise = worker.waitForActiveOperationToDrain();
    resolveOperation();

    await expect(drainPromise).resolves.toBeUndefined();
  });

  it('waitForActiveOperationToDrain force-proceeds once SHUTDOWN_DRAIN_TIMEOUT_MS elapses without the operation settling', async () => {
    // An operation promise that never settles on its own.
    worker.activeOperationPromise = new Promise(() => {});

    const drainPromise = worker.waitForActiveOperationToDrain();
    await jest.advanceTimersByTimeAsync(30000 + 1);

    await expect(drainPromise).resolves.toBeUndefined();
  });

  it('stop() calls waitForActiveOperationToDrain before closing the pool', async () => {
    const callOrder = [];
    worker.waitForActiveOperationToDrain = jest.fn().mockImplementation(async () => {
      callOrder.push('drain');
    });
    worker.pool.end = jest.fn().mockImplementation(async () => {
      callOrder.push('pool.end');
    });

    await worker.stop();

    expect(callOrder).toEqual(['drain', 'pool.end']);
  });

  it('the poll loop tracks activeOperationPromise for the duration of processNextOperation only, clearing it afterward', async () => {
    let capturedDuringCycle;
    worker.processNextOperation = jest.fn().mockImplementation(async () => {
      // A real `await` here (unlike a synchronous-bodied mock) is what
      // lets control return to `start()`'s caller long enough for
      // `this.activeOperationPromise = cyclePromise` to have already run
      // by the time this line reads it -- without it, this mock's body
      // would run to completion (there being no await before the read)
      // BEFORE that assignment even happens, since `processNextOperation()`
      // is called and assigned in that order.
      await Promise.resolve();
      capturedDuringCycle = worker.activeOperationPromise;
    });
    worker.updateHeartbeat = jest.fn().mockResolvedValue();
    worker.startHealthServer = jest.fn();
    worker.sleep = jest.fn().mockImplementation(() => {
      worker.isRunning = false;
      return Promise.resolve();
    });

    await worker.start();

    expect(capturedDuringCycle).not.toBeNull();
    expect(worker.activeOperationPromise).toBeNull();
  });

  it('clears activeOperationPromise even when processNextOperation throws', async () => {
    worker.processNextOperation = jest.fn().mockRejectedValue(new Error('boom'));
    worker.updateHeartbeat = jest.fn();
    worker.startHealthServer = jest.fn();
    worker.sleep = jest.fn().mockImplementation(() => {
      worker.isRunning = false;
      return Promise.resolve();
    });

    await worker.start();

    expect(worker.activeOperationPromise).toBeNull();
  });
});

/**
 * Resiliency-hardening: previously this file registered no
 * `unhandledRejection`/`uncaughtException` handlers at all -- an
 * unhandled rejection or uncaught exception anywhere outside `start()`'s
 * own top-level `.catch()` fell through to Node's default (ungraceful,
 * ON `uncaughtException`: immediate process exit with no controlled
 * shutdown) behavior. These handlers are registered inside the
 * `require.main === module` block, so they cannot be exercised by
 * `require()`-ing this module directly in a test the way the exported
 * `SyncWorker` class itself can be -- this describe block instead proves
 * the underlying, extracted behavior each handler delegates to
 * (`worker.stop()` + a controlled exit) is correct, mirroring how
 * `server/utils/gracefulShutdown.test.js` tests the extracted shutdown
 * sequence rather than the top-level `process.on(...)` registration
 * itself.
 */
describe('SyncWorker uncaughtException controlled-shutdown behavior (resiliency-hardening)', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
  });

  it('an uncaughtException handler modeled on this file\'s registration calls worker.stop() before exiting non-zero', async () => {
    worker.stop = jest.fn().mockResolvedValue();
    const exitSpy = jest.fn();
    const loggerErrorSpy = jest.fn();

    // Reproduces the exact handler body registered in this file's
    // `require.main === module` block, to prove its control flow
    // (stop() awaited, any rejection from stop() itself caught and
    // logged, then a non-zero exit via .finally()) without needing to
    // simulate a real process-level uncaughtException event.
    const handler = () => {
      worker.stop().catch((stopErr) => {
        loggerErrorSpy(stopErr);
      }).finally(() => exitSpy(1));
    };

    handler(new Error('simulated uncaught exception'));
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerErrorSpy).not.toHaveBeenCalled();
  });

  it('the controlled-shutdown handler still exits non-zero, with no unhandled rejection, even when worker.stop() itself rejects', async () => {
    worker.stop = jest.fn().mockRejectedValue(new Error('stop failed'));
    const exitSpy = jest.fn();
    const loggerErrorSpy = jest.fn();

    const handler = () => {
      worker.stop().catch((stopErr) => {
        loggerErrorSpy(stopErr);
      }).finally(() => exitSpy(1));
    };

    handler(new Error('simulated uncaught exception'));
    await Promise.resolve();
    await Promise.resolve();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'stop failed' }));
  });
});
