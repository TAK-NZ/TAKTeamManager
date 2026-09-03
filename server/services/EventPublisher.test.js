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

/**
 * Performance-hardening: `EventPublisher.publishOperationsBatch` enqueues
 * many sync_operations rows of the same operation_type in one or more
 * multi-row INSERT statements, replacing a per-row loop of individual
 * `publishOperation` calls at bulk-enqueue call sites
 * (GlobalChannelService.assignAllUsersToGlobalChannels,
 * TeamMembershipService.bulkAddUsersToTeam,
 * SyncWorker.resyncOrgChannelTierAccess).
 */
describe('EventPublisher.publishOperationsBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCorrelationId.mockReturnValue(undefined);
  });

  it('returns an empty array and issues no query for an empty payloads array', async () => {
    const result = await EventPublisher.publishOperationsBatch('assign_user_to_global_channels', []);

    expect(result).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('issues a single multi-row INSERT for a small batch, using the shared pool by default', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });

    const ids = await EventPublisher.publishOperationsBatch(
      'assign_user_to_global_channels',
      [{ target_user_id: 10 }, { target_user_id: 11 }, { target_user_id: 12 }],
      null
    );

    expect(ids).toEqual([1, 2, 3]);
    expect(pool.query).toHaveBeenCalledTimes(1);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO sync_operations');
    expect(sql.match(/\(\$/g)).toHaveLength(3); // three value-tuples
    expect(params).toEqual([
      'assign_user_to_global_channels', 10, null, JSON.stringify({ target_user_id: 10 }), null, null,
      'assign_user_to_global_channels', 11, null, JSON.stringify({ target_user_id: 11 }), null, null,
      'assign_user_to_global_channels', 12, null, JSON.stringify({ target_user_id: 12 }), null, null
    ]);
  });

  it('uses the provided client instead of the pool when one is given', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 55 }] }) };

    const ids = await EventPublisher.publishOperationsBatch(
      'bulk_add_user_to_team',
      [{ target_user_id: 1, team_id: 5, role: 'member' }],
      9,
      client
    );

    expect(ids).toEqual([55]);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('binds target_user_id/target_group_id per-row from each payload, and createdBy/correlationId shared across every row', async () => {
    mockGetCorrelationId.mockReturnValue('corr-batch-1');
    pool.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });

    await EventPublisher.publishOperationsBatch(
      'add_user_to_group',
      [
        { target_user_id: 1, target_group_id: 'grp-a' },
        { target_user_id: 2, target_group_id: 'grp-b' }
      ],
      42
    );

    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual([
      'add_user_to_group', 1, 'grp-a', JSON.stringify({ target_user_id: 1, target_group_id: 'grp-a' }), 42, 'corr-batch-1',
      'add_user_to_group', 2, 'grp-b', JSON.stringify({ target_user_id: 2, target_group_id: 'grp-b' }), 42, 'corr-batch-1'
    ]);
  });

  it('splits a batch larger than the chunk size into multiple sequential INSERT statements', async () => {
    const totalRows = 1500; // > BATCH_INSERT_CHUNK_SIZE (1000)
    const payloads = Array.from({ length: totalRows }, (_, i) => ({ target_user_id: i }));

    let callCount = 0;
    pool.query.mockImplementation((sql, params) => {
      callCount += 1;
      const rowsInThisCall = params.length / 6;
      const idsForCall = Array.from({ length: rowsInThisCall }, (_, i) => ({ id: (callCount - 1) * 1000 + i }));
      return Promise.resolve({ rows: idsForCall });
    });

    const ids = await EventPublisher.publishOperationsBatch('assign_user_to_global_channels', payloads);

    expect(pool.query).toHaveBeenCalledTimes(2); // 1000 + 500
    expect(ids).toHaveLength(totalRows);

    const [firstSql] = pool.query.mock.calls[0];
    const [secondSql] = pool.query.mock.calls[1];
    expect(firstSql.match(/\(\$/g)).toHaveLength(1000);
    expect(secondSql.match(/\(\$/g)).toHaveLength(500);
  });

  it('propagates a failure from the provided client without falling back to the pool', async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error('batch insert failed')) };

    await expect(
      EventPublisher.publishOperationsBatch('assign_user_to_global_channels', [{ target_user_id: 1 }], null, client)
    ).rejects.toThrow('batch insert failed');

    expect(pool.query).not.toHaveBeenCalled();
  });
});
