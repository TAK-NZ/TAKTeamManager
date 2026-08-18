/**
 * Integration tests for `POST /api/users/create-and-add` (Requirement
 * 17.1: transactional refactor into `UserProvisioningService`).
 *
 * These exercise the actual mounted route via `supertest`, mocking
 * `global.fetch` (Authentik HTTP calls), `pool.connect`/`pool.query`, and
 * `UserAttributesService`, to verify:
 *
 *  - The Authentik user-creation call happens before any `pool.connect()`
 *    call (i.e. before any transaction is opened).
 *  - On success, exactly one client is acquired and `BEGIN`/`COMMIT` are
 *    issued on that same client, which is released afterward.
 *  - On a failure in the local database write sequence (after the
 *    Authentik user was already created), the transaction is rolled back
 *    (`ROLLBACK` issued on the same client, which is still released) and
 *    the route responds with an error, without committing any partial
 *    local write.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

jest.mock('../services/authentik', () => ({
  getUsers: jest.fn()
}));

jest.mock('../services/userAttributes', () => ({
  generateCallsign: jest.fn().mockResolvedValue(null),
  updateUserAttributes: jest.fn().mockResolvedValue(true)
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

// Requirement 17.2 (task 36.2): the compensating-action tests below need
// to assert on the exact `{authentikUserId, failedStep,
// compensationOutcome}` object passed to `getLogger().error(...)`, so
// (unlike the plain `jest.fn()` stub used by the pre-existing tests
// above) this mock exposes a single shared `mockLoggerError` spy that
// every call to `getLogger()` returns, regardless of how many times
// `getLogger()` itself is called within a request.
const mockLoggerError = jest.fn();
jest.mock('../middleware/requestContext', () => ({
  getLogger: () => ({ error: mockLoggerError, info: jest.fn(), warn: jest.fn() })
}));

jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn()
}));

// Requirement 11.6, 11.7, 11.14, 11.15 (task 22.2): `createAndAddUser`
// is left as the REAL implementation (the pre-existing tests above rely
// on it issuing specific `client.query` calls), but
// `resolveCallsignSuffixForNewUser` is mocked so the pre-existing tests
// (which don't care about callsign_suffix resolution) resolve to a
// benign default, while the dedicated tests below override this mock
// per-case. Note: `actual` is a CLASS, whose static methods are
// non-enumerable, so `{...actual}` would silently drop
// `createAndAddUser` -- assigning the mocked method directly onto
// `actual` instead preserves every other static method unchanged.
jest.mock('../services/UserProvisioningService', () => {
  const actual = jest.requireActual('../services/UserProvisioningService');
  actual.resolveCallsignSuffixForNewUser = jest.fn().mockResolvedValue(null);
  return actual;
});

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const EventPublisher = require('../services/EventPublisher');
const UserProvisioningService = require('../services/UserProvisioningService');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

const VALID_BODY = {
  email: 'newuser@example.com',
  firstName: 'New',
  lastName: 'User',
  teamId: 7
};

function mockAuthentikSuccess() {
  global.fetch = jest.fn()
    // 1. existing-user-by-email lookup -> no results
    .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
    // 2. create user
    .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 4242 }) });
}

describe('POST /api/users/create-and-add (Requirement 17.1)', () => {
  let app;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('creates the Authentik user before acquiring any database client', async () => {
    mockAuthentikSuccess();

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
          return Promise.resolve({ rows: [{ id: 55 }] });
        }
        if (sql.includes('WITH RECURSIVE parent_teams')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('SELECT id, authentik_group_id FROM channels')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockImplementation(() => {
      // At the moment pool.connect() is invoked, both Authentik fetch
      // calls (lookup + create) must have already resolved.
      expect(global.fetch).toHaveBeenCalledTimes(2);
      return Promise.resolve(mockClient);
    });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back the transaction and releases the client when a local write fails after Authentik user creation', async () => {
    mockAuthentikSuccess();

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }
        if (sql.includes('INSERT INTO users')) {
          return Promise.reject(new Error('duplicate key value violates unique constraint'));
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);

    // No user_cache write should occur after a rolled-back local
    // transaction (pool.query IS legitimately called earlier, during the
    // Phase 0 callsign_suffix resolution step -- task 22.2 -- via
    // Team.getAncestorChain/getFullMemberList, which run on the shared
    // pool rather than the transactional client).
    expect(pool.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_cache'),
      expect.anything()
    );
  });

  it('does not acquire a database client at all when the Authentik user-creation call fails', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ detail: 'bad request' }) });

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects with 400 without calling Authentik when the requesting email already exists', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ pk: 1 }] })
    });

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

/**
 * Requirement 17.2 (task 36.2): compensating-action logic in Phase 2's
 * catch block. Both scenarios below start from the same rolled-back local
 * transaction as the pre-existing "rolls back the transaction..." test
 * above, but additionally exercise the DELETE call made against the
 * Authentik user created in Phase 1 (newUser.pk = 4242, per
 * `mockAuthentikSuccess()`).
 */
describe('POST /api/users/create-and-add compensating action (Requirement 17.2)', () => {
  let app;
  let originalFetch;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    originalFetch = global.fetch;

    mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') {
          return Promise.resolve();
        }
        if (sql.includes('INSERT INTO users')) {
          return Promise.reject(new Error('duplicate key value violates unique constraint'));
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('deletes the orphaned Authentik user synchronously and logs compensationOutcome: deleted_synchronously', async () => {
    global.fetch = jest.fn()
      // 1. existing-user-by-email lookup -> no results
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      // 2. create user
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 4242 }) })
      // 3. compensating DELETE of the just-created Authentik user
      .mockResolvedValueOnce({ ok: true, status: 204 });

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(500);

    // The third fetch call must be the compensating DELETE against the
    // exact Authentik user id created in Phase 1.
    expect(global.fetch).toHaveBeenCalledTimes(3);
    const [deleteUrl, deleteOptions] = global.fetch.mock.calls[2];
    expect(deleteUrl).toContain('/core/users/4242/');
    expect(deleteOptions.method).toBe('DELETE');

    // No fallback enqueue should have happened, since the synchronous
    // delete succeeded.
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();

    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        authentikUserId: 4242,
        failedStep: 'local_transaction',
        compensationOutcome: 'deleted_synchronously'
      },
      expect.any(String)
    );
  });

  it('falls back to enqueueing a cleanup_orphaned_authentik_user Sync_Operation when the synchronous delete fails, and logs compensationOutcome: cleanup_operation_queued', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 4242 }) })
      // 3. compensating DELETE fails (e.g. Authentik 5xx)
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });

    EventPublisher.publishOperation.mockResolvedValue(99);

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(global.fetch).toHaveBeenCalledTimes(3);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'cleanup_orphaned_authentik_user',
      { authentik_user_id: 4242 },
      1
    );

    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        authentikUserId: 4242,
        failedStep: 'local_transaction',
        compensationOutcome: 'cleanup_operation_queued'
      },
      expect.any(String)
    );
  });

  it('logs compensationOutcome: compensation_failed when both the synchronous delete and the fallback enqueue fail', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 4242 }) })
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });

    EventPublisher.publishOperation.mockRejectedValue(new Error('database unreachable'));

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(500);

    expect(mockLoggerError).toHaveBeenCalledWith(
      {
        authentikUserId: 4242,
        failedStep: 'local_transaction',
        compensationOutcome: 'compensation_failed'
      },
      expect.any(String)
    );
  });
});

/**
 * Requirements 11.6, 11.7, 11.14, 11.15 (task 22.2): callsign_suffix
 * resolution runs EARLY, before Phase 1's Authentik user-creation call,
 * so a `CallsignSuffixRequiredError`/`CallsignSuffixConflictError` is
 * returned as a 400 WITHOUT ever calling Authentik (avoiding the
 * orphaned-Authentik-user compensating-action path for what is
 * fundamentally a request-validation failure).
 */
describe('POST /api/users/create-and-add callsign_suffix resolution (task 22.2)', () => {
  let app;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('resolves callsign_suffix and passes it through to createAndAddUser on a successful creation', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockResolvedValue('J.Doe');
    mockAuthentikSuccess();

    const mockClient = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
          return Promise.resolve({ rows: [{ id: 55 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(UserProvisioningService.resolveCallsignSuffixForNewUser).toHaveBeenCalledWith(null, {
      firstName: 'New',
      lastName: 'User',
      teamId: 7,
      requestedCallsignSuffix: undefined
    });
    // callsign_suffix INSERT param made it into the users upsert call.
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      expect.arrayContaining(['J.Doe'])
    );
    // ...and the user_cache upsert too.
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_cache'),
      expect.arrayContaining(['J.Doe'])
    );
  });

  it('returns 400 naming the missing value for a user_defined Organisation with no callsignSuffix supplied, never calling Authentik', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockRejectedValue(
      new UserProvisioningService.CallsignSuffixRequiredError()
    );
    global.fetch = jest.fn();

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/callsign suffix is required/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('returns 400 naming the conflicting value on a uniqueness collision, never calling Authentik', async () => {
    const { CallsignSuffixConflictError } = jest.requireActual('../services/CallsignSuffixUniquenessService');
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockRejectedValue(
      new CallsignSuffixConflictError('J.Doe')
    );
    global.fetch = jest.fn();

    const res = await request(app).post('/api/users/create-and-add').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/J\.Doe/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
