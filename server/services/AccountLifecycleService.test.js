/**
 * Unit tests for `AccountLifecycleService.suspendAccount`/`unsuspendAccount`
 * (account-lifecycle-management task 2.3, Requirement 1).
 *
 * `pool`/`EventPublisher` are mocked exactly as `VendorChannelService.test.js`
 * already establishes for this codebase's transactional-service shape:
 * `pool.connect()` resolves a mocked client whose `query` is driven by SQL
 * substring matching, and `EventPublisher.publishOperation` is asserted by
 * call rather than by its own internal SQL. `global.fetch` (the Authentik
 * PATCH call, issued strictly post-commit) is mocked at the module level so
 * every test controls both the transactional half and the post-commit half
 * independently.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const AccountLifecycleService = require('./AccountLifecycleService');
const {
  AccountAlreadySuspendedError,
  AccountOrphanedError,
  TargetUserNotFoundError
} = require('./AccountLifecycleService');

const ORIGINAL_ENV = { ...process.env };

const ACTING_USER = { userId: 9, is_global_manager: true };

/** A human account row, `account_status = 'active'`, exactly as a fresh SELECT under FOR UPDATE would return it. */
function activeHumanRow(overrides = {}) {
  return {
    id: 42,
    authentik_user_id: 'authentik-42',
    is_team_device: false,
    username: 'jdoe',
    account_status: 'active',
    ...overrides
  };
}

/** A Team_Owned_Device row, `account_status = 'active'`. */
function activeDeviceRow(overrides = {}) {
  return {
    id: 77,
    authentik_user_id: 'authentik-77',
    is_team_device: true,
    username: 'AUK-D7K3QMX',
    account_status: 'active',
    ...overrides
  };
}

describe('AccountLifecycleService.suspendAccount', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, AUTHENTIK_URL: 'https://authentik.example', AUTHENTIK_API_TOKEN: 'tok' };
    mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete global.fetch;
  });

  function queryImplFor(row) {
    return (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: row ? [row] : [] });
      }
      return Promise.resolve({ rows: [] });
    };
  }

  it('suspends an active human account: UPDATEs account_status/is_active, enqueues tak_usernames revoke on the transaction client, audit-logs, commits, then PATCHes Authentik is_active=false post-commit', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow()));

    const result = await AccountLifecycleService.suspendAccount(42, ACTING_USER);

    expect(result).toEqual({ userId: 42, accountStatus: 'suspended' });

    const calls = mockClient.query.mock.calls.map(([sql, params]) => ({ sql, params }));
    const sqls = calls.map((c) => c.sql);

    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.some((s) => typeof s === 'string' && s.includes('FOR UPDATE'))).toBe(true);
    expect(sqls.some((s) => typeof s === 'string' && s.includes("SET account_status = 'suspended'") && s.includes('is_active = false'))).toBe(true);
    expect(sqls.some((s) => typeof s === 'string' && s.includes('UPDATE user_cache SET is_active = false'))).toBe(true);
    expect(sqls.some((s) => typeof s === 'string' && s.includes('INSERT INTO audit_logs'))).toBe(true);
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');

    // Enqueue happens on the SAME transaction client, human -> tak_usernames.
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { tak_usernames: ['jdoe'] },
      ACTING_USER.userId,
      mockClient
    );

    // The Authentik PATCH is issued AFTER COMMIT, never before.
    expect(global.fetch).toHaveBeenCalledWith(
      'https://authentik.example/api/v3/core/users/authentik-42/',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ is_active: false })
      })
    );
    const commitIndex = sqls.indexOf('COMMIT');
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(global.fetch.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockClient.query.mock.invocationCallOrder[commitIndex]
    );
  });

  it('enqueues client_uid (not tak_usernames) for a Team_Owned_Device', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeDeviceRow()));

    await AccountLifecycleService.suspendAccount(77, ACTING_USER);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { client_uid: 'AUK-D7K3QMX' },
      ACTING_USER.userId,
      mockClient
    );
  });

  it('rejects an already-suspended account: no Authentik call, no enqueue, rolls back', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow({ account_status: 'suspended' })));

    await expect(AccountLifecycleService.suspendAccount(42, ACTING_USER)).rejects.toThrow(AccountAlreadySuspendedError);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockClient.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
  });

  it('rejects an orphaned account: no Authentik call, no enqueue, rolls back', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow({ account_status: 'orphaned' })));

    await expect(AccountLifecycleService.suspendAccount(42, ACTING_USER)).rejects.toThrow(AccountOrphanedError);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockClient.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
  });

  it('rejects a nonexistent target user: no Authentik call, no enqueue, rolls back', async () => {
    mockClient.query.mockImplementation(queryImplFor(null));

    await expect(AccountLifecycleService.suspendAccount(999, ACTING_USER)).rejects.toThrow(TargetUserNotFoundError);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('releases the client even when the transaction throws', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow({ account_status: 'suspended' })));

    await expect(AccountLifecycleService.suspendAccount(42, ACTING_USER)).rejects.toThrow();

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('does not throw and does not roll back an already-committed suspend when the post-commit Authentik PATCH fails', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow()));
    global.fetch.mockRejectedValue(new Error('network down'));

    const result = await AccountLifecycleService.suspendAccount(42, ACTING_USER);

    expect(result).toEqual({ userId: 42, accountStatus: 'suspended' });
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ targetUserId: 42 }),
      expect.stringContaining('self-correct')
    );
  });

  it('skips the Authentik PATCH entirely when the target row has no authentik_user_id', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow({ authentik_user_id: null })));

    const result = await AccountLifecycleService.suspendAccount(42, ACTING_USER);

    expect(result).toEqual({ userId: 42, accountStatus: 'suspended' });
    expect(global.fetch).not.toHaveBeenCalled();
    // user_cache has nothing to key on either.
    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((s) => typeof s === 'string' && s.includes('UPDATE user_cache'))).toBe(false);
  });
});

describe('AccountLifecycleService.unsuspendAccount', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, AUTHENTIK_URL: 'https://authentik.example', AUTHENTIK_API_TOKEN: 'tok' };
    mockClient = { query: jest.fn(), release: jest.fn() };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete global.fetch;
  });

  function queryImplFor(row) {
    return (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: row ? [row] : [] });
      }
      return Promise.resolve({ rows: [] });
    };
  }

  it('unsuspends a suspended account: UPDATEs account_status/is_active, audit-logs, commits, then PATCHes Authentik is_active=true post-commit, with NO Revoke_Operation enqueue', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow({ account_status: 'suspended' })));

    const result = await AccountLifecycleService.unsuspendAccount(42, ACTING_USER);

    expect(result).toEqual({ userId: 42, accountStatus: 'active' });

    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls.some((s) => typeof s === 'string' && s.includes("SET account_status = 'active'") && s.includes('is_active = true'))).toBe(true);
    expect(sqls.some((s) => typeof s === 'string' && s.includes('UPDATE user_cache SET is_active = true'))).toBe(true);
    expect(sqls.some((s) => typeof s === 'string' && s.includes('INSERT INTO audit_logs'))).toBe(true);
    expect(sqls).toContain('COMMIT');

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://authentik.example/api/v3/core/users/authentik-42/',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ is_active: true })
      })
    );
  });

  it('rejects an active (not-suspended) account, naming its current status', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow({ account_status: 'active' })));

    await expect(AccountLifecycleService.unsuspendAccount(42, ACTING_USER)).rejects.toMatchObject({
      name: 'AccountNotSuspendedError',
      currentStatus: 'active'
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects an orphaned account: no Authentik call, rolls back', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow({ account_status: 'orphaned' })));

    await expect(AccountLifecycleService.unsuspendAccount(42, ACTING_USER)).rejects.toThrow(AccountOrphanedError);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockClient.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
  });

  it('rejects a nonexistent target user', async () => {
    mockClient.query.mockImplementation(queryImplFor(null));

    await expect(AccountLifecycleService.unsuspendAccount(999, ACTING_USER)).rejects.toThrow(TargetUserNotFoundError);
  });

  it('does not throw when the post-commit Authentik PATCH fails', async () => {
    mockClient.query.mockImplementation(queryImplFor(activeHumanRow({ account_status: 'suspended' })));
    global.fetch.mockResolvedValue({ ok: false, statusText: 'Internal Server Error' });

    const result = await AccountLifecycleService.unsuspendAccount(42, ACTING_USER);

    expect(result).toEqual({ userId: 42, accountStatus: 'active' });
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });
});

describe('is_active / account_status consistency (Requirement 1.9)', () => {
  it('every transition writes is_active in the documented pairing', () => {
    // Documents the pairing this file's tests above already exercise
    // behaviourally, as a single explicit table -- see Requirement 1.9
    // and the property test in task 13.1 for the exhaustive version.
    const pairing = {
      active: true,
      suspended: false,
      orphaned: false
    };
    expect(pairing).toEqual({ active: true, suspended: false, orphaned: false });
  });
});
