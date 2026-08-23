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

const http = require('http');
const { computeBackoffDelay } = require('./backoff');
const SyncWorker = require('./syncWorker');
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
    create_region_channel_group: 'createRegionChannelGroup',
    update_bch_channel_group: 'updateBchChannelGroup',
    update_region_channel_group: 'updateRegionChannelGroup',
    delete_global_channel: 'deleteGlobalChannelGroup',
    assign_user_to_global_channels: 'assignUserToGlobalChannels',
    deactivate_global_channel: 'deactivateGlobalChannel',
    sync_existing_global_channels: 'syncExistingGlobalChannels',
    cleanup_orphaned_authentik_user: 'cleanupOrphanedAuthentikUser',
    remove_team_channel_group: 'removeTeamChannelGroup',
    create_vendor_channel_group: 'createVendorChannelGroup',
    create_deployment_channel_group: 'createDeploymentChannelGroup',
    remove_all_members_from_group: 'removeAllMembersFromGroup',
    revoke_tak_certificates: 'revokeTakCertificates',
    // Feature cloudtak-agency-groups (tasks 4.1/4.2): create/update share
    // `ensureCloudTakGroup`; delete's handler `deleteCloudTakGroup` is
    // added in task 4.2. Property 3 stubs the handler by name and never
    // reaches the switch (validation fails first), so listing all three
    // keeps this map in lockstep with operationSchemas.
    create_cloudtak_group: 'createCloudTakGroup',
    update_cloudtak_group: 'updateCloudTakGroup',
    delete_cloudtak_group: 'deleteCloudTakGroup'
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

  function buildValidPayload(operationType) {
    const schema = operationSchemas[operationType];
    const payload = {};
    for (const [field, type] of Object.entries(schema.requiredFields || {})) {
      payload[field] = validValueForType(type);
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
      const requiredFieldNames = Object.keys(schema.requiredFields);
      const targetField = requiredFieldNames[fieldIndexSeed % requiredFieldNames.length];
      const expectedType = schema.requiredFields[targetField];

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
      payload: { channel_id: 10, authentik_group_id: 555 }
    };

    it('completes successfully (one markOperationCompleted UPDATE) when the single group DELETE succeeds', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/555/'),
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
        payload: { channel_id: 11, authentik_read_group_id: 201, authentik_write_group_id: 202 }
      };

      await worker.executeOperationSafely(operation);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/201/'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/202/'),
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

  describe('createBchChannelGroups', () => {
    const baseOperation = {
      id: 'op-classify-2',
      operation_type: 'create_bch_channel_groups',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-classify-2',
      payload: {
        channel_name: 'Test Channel',
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
        region_channel_id: 9
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
      // fix in syncExistingGlobalChannels).
      const page1Groups = [
        { pk: 'g1', name: `tak_Regions${separator}North`, attributes: {} }
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
   * Requirement 21.10 (task 40.1): `createVendorChannelGroup` creates a
   * single Authentik `VND` group for the `vendor_channels` row
   * identified by `payload.vendor_channel_id` (unlike BCH/region
   * channels, which create a read/write group pair), and on success
   * UPDATEs `vendor_channels.authentik_group_id` with the created
   * group's Authentik pk. Follows the same
   * fetch/`AuthentikApiError`/`classifyFailure` pattern as every other
   * Authentik-calling handler above.
   */
  describe('createVendorChannelGroup', () => {
    const baseOperation = {
      id: 'op-vendor-channel-1',
      operation_type: 'create_vendor_channel_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-vendor-channel-1',
      payload: { vendor_channel_id: 55 }
    };

    beforeEach(() => {
      // First query in the handler looks up name/description; subsequent
      // queries (the UPDATE, or the terminal-status UPDATE from
      // executeOperationSafely) return an empty row set, which is fine
      // since those UPDATEs don't inspect the result.
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT name, description FROM vendor_channels')) {
          return Promise.resolve({ rows: [{ name: 'VND', description: null }] });
        }
        return Promise.resolve({ rows: [] });
      });
    });

    it('creates exactly one group and updates vendor_channels.authentik_group_id on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ pk: 999 })
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/'),
        expect.objectContaining({ method: 'POST' })
      );

      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE vendor_channels SET authentik_group_id')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[1]).toEqual([999, 55]);

      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('completed')
      );
      expect(terminalCall).toBeDefined();
      expect(terminalCall[1][0]).toBe('completed');
    });

    it('results in a markPermanentlyFailed-style UPDATE (failed/permanent, no next_retry_at/retry_count) on a 4xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'group name already exists'
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(terminalCall).toBeDefined();
      expect(terminalCall[0]).not.toContain('next_retry_at');
      expect(terminalCall[0]).not.toContain('retry_count');
      expect(terminalCall[1][0]).toBe('failed');
      expect(terminalCall[1][1]).toBe('permanent');

      // No UPDATE to authentik_group_id should have occurred.
      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE vendor_channels SET authentik_group_id')
      );
      expect(updateCall).toBeUndefined();
    });

    it('results in the existing handleOperationError retryable path on a 5xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'upstream error'
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(terminalCall).toBeDefined();
      expect(terminalCall[1][0]).toBe('pending');
    });

    it('treats a rejected fetch (network error) as retryable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await worker.executeOperationSafely({ ...baseOperation });

      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(terminalCall).toBeDefined();
      expect(terminalCall[1][0]).toBe('pending');
    });

    it('is a no-op (no fetch call, no failure) when the vendor_channels row no longer exists', async () => {
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT name, description FROM vendor_channels')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });
      global.fetch = jest.fn();

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).not.toHaveBeenCalled();
      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('completed')
      );
      expect(terminalCall).toBeDefined();
    });
  });

  /**
   * Requirement 22.4/22.11 (task 42.1): `createDeploymentChannelGroup`
   * creates a single Authentik group for the `deployment_channels` row
   * identified by `payload.deployment_channel_id` (mirroring
   * `createVendorChannelGroup`'s single-group shape rather than the
   * BCH/region read/write pair), and on success UPDATEs
   * `deployment_channels.authentik_group_id` with the created group's
   * Authentik pk. Follows the same
   * fetch/`AuthentikApiError`/`classifyFailure` pattern as every other
   * Authentik-calling handler above.
   */
  describe('createDeploymentChannelGroup', () => {
    const baseOperation = {
      id: 'op-deployment-channel-1',
      operation_type: 'create_deployment_channel_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-deployment-channel-1',
      payload: { deployment_channel_id: 77, channel_name: 'Overseas - Tonga' }
    };

    beforeEach(() => {
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT name, description FROM deployment_channels')) {
          return Promise.resolve({ rows: [{ name: 'Overseas - Tonga', description: 'Tonga deployment' }] });
        }
        return Promise.resolve({ rows: [] });
      });
    });

    it('creates exactly one group and updates deployment_channels.authentik_group_id on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ pk: 888 })
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/'),
        expect.objectContaining({ method: 'POST' })
      );

      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE deployment_channels SET authentik_group_id')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall[1]).toEqual([888, 77]);

      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('completed')
      );
      expect(terminalCall).toBeDefined();
      expect(terminalCall[1][0]).toBe('completed');
    });

    it('results in a markPermanentlyFailed-style UPDATE (failed/permanent, no next_retry_at/retry_count) on a 4xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'group name already exists'
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('failure_category')
      );
      expect(terminalCall).toBeDefined();
      expect(terminalCall[0]).not.toContain('next_retry_at');
      expect(terminalCall[0]).not.toContain('retry_count');
      expect(terminalCall[1][0]).toBe('failed');
      expect(terminalCall[1][1]).toBe('permanent');

      const updateCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE deployment_channels SET authentik_group_id')
      );
      expect(updateCall).toBeUndefined();
    });

    it('results in the existing handleOperationError retryable path on a 5xx response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'upstream error'
      });

      await worker.executeOperationSafely({ ...baseOperation });

      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(terminalCall).toBeDefined();
      expect(terminalCall[1][0]).toBe('pending');
    });

    it('treats a rejected fetch (network error) as retryable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await worker.executeOperationSafely({ ...baseOperation });

      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('next_retry_at')
      );
      expect(terminalCall).toBeDefined();
      expect(terminalCall[1][0]).toBe('pending');
    });

    it('is a no-op (no fetch call, no failure) when the deployment_channels row no longer exists', async () => {
      worker.pool.query = jest.fn().mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT name, description FROM deployment_channels')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });
      global.fetch = jest.fn();

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).not.toHaveBeenCalled();
      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('completed')
      );
      expect(terminalCall).toBeDefined();
    });
  });

  /**
   * Requirement 22.8/22.9 (task 42.3): `removeAllMembersFromGroup` bulk-
   * removes every member from the Authentik group identified by
   * `payload.target_group_id`, enqueued by
   * `DeploymentChannelService.deactivateExpired()`. Authentik's group API
   * has no single "remove all members" endpoint, so the handler fetches
   * the group (whose `users` field carries the member pk list) and then
   * calls `POST .../remove_user/` once per member, following the same
   * fetch/`AuthentikApiError`/`classifyFailure` pattern as every other
   * Authentik-calling handler above.
   */
  describe('removeAllMembersFromGroup', () => {
    const baseOperation = {
      id: 'op-remove-all-members-1',
      operation_type: 'remove_all_members_from_group',
      retry_count: 0,
      max_retries: 48,
      correlation_id: 'corr-remove-all-members-1',
      payload: { channel_id: 42, target_group_id: 'grp-deploy-42' }
    };

    it('fetches the group members and removes each one, then completes successfully', async () => {
      global.fetch = jest.fn().mockImplementation((url, options) => {
        if (!options || options.method === undefined) {
          // GET group detail (no explicit method set)
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ pk: 'grp-deploy-42', users: [10, 11, 12] })
          });
        }
        return Promise.resolve({ ok: true, status: 204 });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/core/groups/grp-deploy-42/'),
        expect.not.objectContaining({ method: expect.anything() })
      );
      expect(global.fetch).toHaveBeenCalledTimes(4); // 1 GET + 3 remove_user POSTs

      for (const memberPk of [10, 11, 12]) {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/core/groups/grp-deploy-42/remove_user/'),
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ pk: memberPk })
          })
        );
      }

      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('completed')
      );
      expect(terminalCall).toBeDefined();
      expect(terminalCall[1][0]).toBe('completed');
    });

    it('completes successfully with no remove_user calls when the group has no members', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ pk: 'grp-deploy-42', users: [] })
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('completed')
      );
      expect(terminalCall).toBeDefined();
    });

    it('is a no-op (success, no remove_user calls) when the group itself is already absent (404)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('completed')
      );
      expect(terminalCall).toBeDefined();
    });

    it('treats a 404 on an individual remove_user call as a no-op and continues to the next member', async () => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation((url, options) => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ pk: 'grp-deploy-42', users: [10, 11] })
          });
        }
        if (callCount === 2) {
          return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
        }
        return Promise.resolve({ ok: true, status: 204 });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(global.fetch).toHaveBeenCalledTimes(3); // 1 GET + 2 remove_user attempts
      const terminalCall = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('completed')
      );
      expect(terminalCall).toBeDefined();
    });

    it('results in a markPermanentlyFailed-style UPDATE (failed/permanent, no next_retry_at/retry_count) on a 4xx response from the group fetch', async () => {
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

    it('results in a markPermanentlyFailed-style UPDATE on a 4xx response from an individual remove_user call', async () => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ pk: 'grp-deploy-42', users: [10] })
          });
        }
        return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' });
      });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('failure_category');
      expect(params[0]).toBe('failed');
      expect(params[1]).toBe('permanent');
    });

    it('results in the existing handleOperationError retryable path on a 5xx response from the group fetch', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

      await worker.executeOperationSafely({ ...baseOperation });

      expect(worker.pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = worker.pool.query.mock.calls[0];
      expect(sql).toContain('next_retry_at');
      expect(params[0]).toBe('pending');
    });

    it('results in the existing handleOperationError retryable path on a 5xx response from an individual remove_user call', async () => {
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ pk: 'grp-deploy-42', users: [10] })
          });
        }
        return Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' });
      });

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
    // Requirement 21.6/22.8: avoid starting a real ExpiryScheduler
    // (with a live setInterval) when exercising the real start() loop
    // in this describe block's tests below.
    worker.expiryScheduler = { start: jest.fn(), stop: jest.fn() };
    // Requirement 25 (task 47.1): likewise avoid starting a real
    // RetentionCleanupJob (with a live setInterval) here.
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
    worker.expiryScheduler = { start: jest.fn(), stop: jest.fn() };
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
 * Requirement 21.6/22.8 (task 43.1): `SyncWorker.start()`/`stop()` start
 * and stop the shared `ExpiryScheduler` alongside the health server,
 * mirroring how `startHealthServer()`/`stopHealthServer()` are already
 * called there.
 */
describe('SyncWorker ExpiryScheduler wiring', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
  });

  it('constructs an ExpiryScheduler instance', () => {
    expect(worker.expiryScheduler).toBeDefined();
    expect(typeof worker.expiryScheduler.start).toBe('function');
    expect(typeof worker.expiryScheduler.stop).toBe('function');
  });

  it('start() calls expiryScheduler.start()', async () => {
    worker.processNextOperation = jest.fn().mockResolvedValue();
    worker.updateHeartbeat = jest.fn().mockResolvedValue();
    worker.startHealthServer = jest.fn();
    worker.expiryScheduler = { start: jest.fn(), stop: jest.fn() };
    worker.sleep = jest.fn().mockImplementation(() => {
      worker.isRunning = false;
      return Promise.resolve();
    });

    await worker.start();

    expect(worker.expiryScheduler.start).toHaveBeenCalledTimes(1);
  });

  it('stop() calls expiryScheduler.stop()', async () => {
    worker.stopHealthServer = jest.fn().mockResolvedValue();
    worker.expiryScheduler = { start: jest.fn(), stop: jest.fn() };

    await worker.stop();

    expect(worker.expiryScheduler.stop).toHaveBeenCalledTimes(1);
  });
});

/**
 * Requirement 25 (task 47.1): `SyncWorker.start()`/`stop()` start and
 * stop the shared `RetentionCleanupJob` alongside the health server and
 * `ExpiryScheduler`, mirroring how `startHealthServer()`/
 * `stopHealthServer()`/`expiryScheduler.start()`/`expiryScheduler.stop()`
 * are already called there.
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
    worker.expiryScheduler = { start: jest.fn(), stop: jest.fn() };
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
    worker.expiryScheduler = { start: jest.fn(), stop: jest.fn() };
    worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };

    await worker.stop();

    expect(worker.retentionCleanupJob.stop).toHaveBeenCalledTimes(1);
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

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    // Requirement 26.3/26.4/26.5: replace the real TakServerService
    // instance constructed in the SyncWorker constructor with a mock, so
    // these tests exercise revokeTakCertificates' own logic (matching/
    // aggregating/classification) without making any real axios/HTTPS
    // calls.
    worker.takServerService = {
      listCertificates: jest.fn(),
      revokeCertificates: jest.fn()
    };
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
