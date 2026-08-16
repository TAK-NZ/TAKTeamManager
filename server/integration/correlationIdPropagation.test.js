/**
 * End-to-end correlation-id propagation test (Requirements 13.3, 13.4,
 * 13.5, task 33.5).
 *
 * The redaction half of task 33.5 is already covered by
 * `server/config/logger.test.js`. This file covers the other half:
 * proving the FULL chain actually wires together in the real code, not
 * just that each half is individually correct in isolation (which
 * `server/services/EventPublisher.test.js` and
 * `server/workers/syncWorker.test.js` already do separately):
 *
 *   1. An incoming HTTP request establishes a correlation id via
 *      `server/middleware/requestContext.js`'s real `AsyncLocalStorage`
 *      wiring (mounted on a minimal Express app -- this middleware is
 *      NOT mocked here, unlike `EventPublisher.test.js`, which mocks
 *      `getCorrelationId()` directly since it only needs to unit test
 *      `publishOperation` in isolation).
 *   2. A route handler running inside that request's context calls the
 *      REAL `EventPublisher.publishOperation(...)` (only the underlying
 *      `pool.query` call -- `server/config/database.js` -- is mocked, to
 *      capture the INSERT statement's parameters instead of hitting a
 *      real database).
 *   3. The captured `correlation_id` INSERT parameter is fed into a
 *      `sync_operations`-row-shaped object, simulating the Sync_Worker
 *      picking up that exact row.
 *   4. The REAL `SyncWorker.executeOperationSafely` (from
 *      `server/workers/syncWorker.js`) processes that row (with its own
 *      `pg.Pool` mocked, per the existing convention in
 *      `syncWorker.test.js`, and its structured logger mocked so log
 *      calls can be captured), and at least one captured log line for
 *      that operation carries the SAME correlation id all the way
 *      through.
 *
 * At no point does this test manually thread the correlation id itself --
 * it only supplies the initial request header (or lets one be generated)
 * and asserts on what the real `requestContext` -> `EventPublisher` ->
 * `SyncWorker` wiring produces, which is the entire point: confirming the
 * existing production wiring does this automatically.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

// SyncWorker constructs its own dedicated `pg.Pool` (distinct from the
// shared `../config/database` pool mocked above), so `pg` itself is
// mocked the same way `server/workers/syncWorker.test.js` already does,
// to avoid attempting a real database connection when `new SyncWorker()`
// runs below.
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    on: jest.fn(),
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn()
  }))
}));

const mockLoggerInstance = {
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const express = require('express');
const request = require('supertest');

const pool = require('../config/database');
const requestContext = require('../middleware/requestContext');
const EventPublisher = require('../services/EventPublisher');
const SyncWorker = require('../workers/syncWorker');

/**
 * Collects every logger call (across info/debug/error/warn) whose first
 * argument is a metadata object referencing the given operation id,
 * mirroring the field-audit helper already used in
 * `syncWorker.test.js`'s "SyncWorker log line field audit" describe
 * block.
 */
function findLogCallsForOperation(operationId) {
  const allCalls = [
    ...mockLoggerInstance.info.mock.calls,
    ...mockLoggerInstance.debug.mock.calls,
    ...mockLoggerInstance.error.mock.calls,
    ...mockLoggerInstance.warn.mock.calls
  ];
  return allCalls.filter((call) => call[0] && call[0].operationId === operationId);
}

describe('End-to-end correlation id propagation: request -> enqueued sync_operations row -> Sync_Worker log line', () => {
  let app;
  let capturedInsertParams;

  beforeEach(() => {
    jest.clearAllMocks();
    capturedInsertParams = null;

    pool.query.mockImplementation((sql, params) => {
      capturedInsertParams = params;
      return Promise.resolve({ rows: [{ id: 999 }] });
    });

    // Minimal Express app: just the real requestContext middleware plus a
    // route handler that enqueues a sync operation via the real
    // EventPublisher, exactly as a real route handler in server/routes
    // would while running inside `requestContext`'s AsyncLocalStorage
    // context.
    app = express();
    app.use(requestContext);
    app.post('/enqueue', async (req, res) => {
      const operationId = await EventPublisher.publishOperation(
        'add_user_to_group',
        { target_user_id: 1, target_group_id: 'grp-1' },
        7
      );
      res.json({ operationId });
    });
  });

  it('propagates a caller-supplied x-correlation-id header through the enqueued row and onto the Sync_Worker log line for that operation', async () => {
    const suppliedCorrelationId = 'req-corr-e2e-caller-supplied-001';

    const response = await request(app)
      .post('/enqueue')
      .set('x-correlation-id', suppliedCorrelationId)
      .send({});

    expect(response.status).toBe(200);
    // requestContext echoes the correlation id back on the response,
    // confirming the request's AsyncLocalStorage context was actually
    // populated with the caller-supplied value.
    expect(response.headers['x-correlation-id']).toBe(suppliedCorrelationId);

    // Step (b): assert the INSERT's captured correlation_id parameter
    // (the 6th positional param in EventPublisher's INSERT, per
    // EventPublisher.js/EventPublisher.test.js) matches the value
    // established by the request, via the REAL getCorrelationId() call
    // chain -- not a mock.
    expect(capturedInsertParams).not.toBeNull();
    const persistedCorrelationId = capturedInsertParams[5];
    expect(persistedCorrelationId).toBe(suppliedCorrelationId);

    // Step (c): simulate the Sync_Worker picking up a sync_operations row
    // shaped exactly like what was captured above (i.e. carrying that
    // same correlation_id value).
    const worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    worker.addUserToGroup = jest.fn().mockResolvedValue();

    const pickedUpRow = {
      id: 'picked-up-op-1',
      operation_type: 'add_user_to_group',
      correlation_id: persistedCorrelationId,
      payload: { target_user_id: 1, target_group_id: 'grp-1' }
    };

    await worker.executeOperationSafely(pickedUpRow);

    // Step (d): confirm at least one log line emitted while processing
    // this operation carries the SAME correlation id, all the way
    // through -- without this test ever computing/threading that value
    // itself.
    const operationLogCalls = findLogCallsForOperation(pickedUpRow.id);
    expect(operationLogCalls.length).toBeGreaterThan(0);
    expect(operationLogCalls.every((call) => call[0].correlationId === suppliedCorrelationId)).toBe(true);

    // Sanity check that the chain is genuinely operation-specific: a log
    // call for an unrelated operation id should not appear here.
    expect(findLogCallsForOperation('some-other-operation-id')).toHaveLength(0);
  });

  it('propagates a freshly generated correlation id (no caller-supplied header) through the same chain', async () => {
    const response = await request(app).post('/enqueue').send({});

    expect(response.status).toBe(200);

    const generatedCorrelationId = response.headers['x-correlation-id'];
    expect(typeof generatedCorrelationId).toBe('string');
    expect(generatedCorrelationId.length).toBeGreaterThan(0);

    const persistedCorrelationId = capturedInsertParams[5];
    expect(persistedCorrelationId).toBe(generatedCorrelationId);

    const worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    worker.addUserToGroup = jest.fn().mockResolvedValue();

    const pickedUpRow = {
      id: 'picked-up-op-2',
      operation_type: 'add_user_to_group',
      correlation_id: persistedCorrelationId,
      payload: { target_user_id: 1, target_group_id: 'grp-1' }
    };

    await worker.executeOperationSafely(pickedUpRow);

    const operationLogCalls = findLogCallsForOperation(pickedUpRow.id);
    expect(operationLogCalls.length).toBeGreaterThan(0);
    expect(operationLogCalls.every((call) => call[0].correlationId === generatedCorrelationId)).toBe(true);
  });

  it('two separate requests produce two distinct correlation ids that each propagate independently through to their own Sync_Worker log lines', async () => {
    const firstResponse = await request(app)
      .post('/enqueue')
      .set('x-correlation-id', 'req-corr-independent-A')
      .send({});
    const firstPersistedCorrelationId = capturedInsertParams[5];

    const secondResponse = await request(app)
      .post('/enqueue')
      .set('x-correlation-id', 'req-corr-independent-B')
      .send({});
    const secondPersistedCorrelationId = capturedInsertParams[5];

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstPersistedCorrelationId).toBe('req-corr-independent-A');
    expect(secondPersistedCorrelationId).toBe('req-corr-independent-B');
    expect(firstPersistedCorrelationId).not.toBe(secondPersistedCorrelationId);

    const worker = new SyncWorker();
    worker.pool.query = jest.fn().mockResolvedValue({ rows: [] });
    worker.addUserToGroup = jest.fn().mockResolvedValue();

    await worker.executeOperationSafely({
      id: 'picked-up-op-A',
      operation_type: 'add_user_to_group',
      correlation_id: firstPersistedCorrelationId,
      payload: { target_user_id: 1, target_group_id: 'grp-1' }
    });
    await worker.executeOperationSafely({
      id: 'picked-up-op-B',
      operation_type: 'add_user_to_group',
      correlation_id: secondPersistedCorrelationId,
      payload: { target_user_id: 1, target_group_id: 'grp-1' }
    });

    const opALogCalls = findLogCallsForOperation('picked-up-op-A');
    const opBLogCalls = findLogCallsForOperation('picked-up-op-B');

    expect(opALogCalls.length).toBeGreaterThan(0);
    expect(opBLogCalls.length).toBeGreaterThan(0);
    expect(opALogCalls.every((call) => call[0].correlationId === 'req-corr-independent-A')).toBe(true);
    expect(opBLogCalls.every((call) => call[0].correlationId === 'req-corr-independent-B')).toBe(true);
  });
});
