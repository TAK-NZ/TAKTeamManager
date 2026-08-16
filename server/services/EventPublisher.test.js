/**
 * Unit tests for `EventPublisher.publishOperation`'s optional `client`
 * parameter (Requirement 17.5) and its correlation-id persistence
 * (Requirement 13.4, task 33.2).
 *
 * When a caller passes an already-open transactional `client`, the
 * sync_operations INSERT must run against that same client (so it
 * commits/rolls back atomically with the caller's other writes) rather
 * than against the shared pool. When no `client` is provided, the existing
 * default behavior (write directly via the shared pool) is preserved for
 * backward compatibility.
 *
 * `getCorrelationId()` (from `server/middleware/requestContext.js`) is
 * mocked so each test can control whether an active request context is
 * simulated (a non-empty string) or not (`undefined`, mirroring a call
 * made outside of any HTTP request, e.g. from the Sync_Worker itself).
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

const mockGetCorrelationId = jest.fn();
jest.mock('../middleware/requestContext', () => ({
  getCorrelationId: mockGetCorrelationId
}));

const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');

describe('EventPublisher.publishOperation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no active request context, matching a call made from a
    // background/worker context with no correlation ID available.
    mockGetCorrelationId.mockReturnValue(undefined);
  });

  it('uses the shared pool when no client is provided (default/backward-compatible behavior)', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 123 }] });

    const opId = await EventPublisher.publishOperation(
      'add_user_to_group',
      { target_user_id: 1, target_group_id: 'grp-1' },
      7
    );

    expect(opId).toBe(123);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO sync_operations');
    expect(sql).toContain('correlation_id');
    expect(params).toEqual([
      'add_user_to_group',
      1,
      'grp-1',
      JSON.stringify({ target_user_id: 1, target_group_id: 'grp-1' }),
      7,
      null
    ]);
  });

  it('uses the provided client instead of the pool when one is given', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 456 }] }) };

    const opId = await EventPublisher.publishOperation(
      'remove_user_from_group',
      { target_user_id: 2, target_group_id: 'grp-2' },
      8,
      client
    );

    expect(opId).toBe(456);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();

    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO sync_operations');
    expect(params).toEqual([
      'remove_user_from_group',
      2,
      'grp-2',
      JSON.stringify({ target_user_id: 2, target_group_id: 'grp-2' }),
      8,
      null
    ]);
  });

  it('propagates a failure from the provided client without falling back to the pool', async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error('insert failed')) };

    await expect(
      EventPublisher.publishOperation('add_user_to_group', { target_user_id: 3 }, null, client)
    ).rejects.toThrow('insert failed');

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('treats an explicit null client the same as an omitted one (falls back to the pool)', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 789 }] });

    const opId = await EventPublisher.publishOperation(
      'assign_user_to_global_channels',
      { target_user_id: 4 },
      null,
      null
    );

    expect(opId).toBe(789);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('persists the active request correlation ID onto the enqueued row when one is present', async () => {
    mockGetCorrelationId.mockReturnValue('corr-abc-123');
    pool.query.mockResolvedValue({ rows: [{ id: 321 }] });

    await EventPublisher.publishOperation(
      'add_user_to_group',
      { target_user_id: 1, target_group_id: 'grp-1' },
      7
    );

    const [, params] = pool.query.mock.calls[0];
    expect(params[5]).toBe('corr-abc-123');
  });

  it('inserts NULL for correlation_id when called outside of an active request context', async () => {
    mockGetCorrelationId.mockReturnValue(undefined);
    pool.query.mockResolvedValue({ rows: [{ id: 654 }] });

    await EventPublisher.publishOperation(
      'add_user_to_group',
      { target_user_id: 1, target_group_id: 'grp-1' },
      7
    );

    const [, params] = pool.query.mock.calls[0];
    expect(params[5]).toBeNull();
  });

  it('persists the active correlation ID even when an explicit transactional client is used', async () => {
    mockGetCorrelationId.mockReturnValue('corr-with-client');
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 999 }] }) };

    await EventPublisher.publishOperation(
      'remove_user_from_group',
      { target_user_id: 2, target_group_id: 'grp-2' },
      8,
      client
    );

    const [, params] = client.query.mock.calls[0];
    expect(params[5]).toBe('corr-with-client');
  });
});
