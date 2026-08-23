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

/**
 * `POST /api/users/callsign-suffix-preview`: the read-only companion to
 * `POST /api/users/create-and-add`, reporting what the submit path WOULD
 * assign (or why it would reject) before the Client submits.
 *
 * The preview is required to delegate to the exact same
 * `UserProvisioningService.resolveCallsignSuffixForNewUser` the submit
 * path uses, so these tests drive the route entirely through that
 * (already-mocked) service call and assert on the translation of its
 * result / typed errors into the response report -- plus that the route
 * performs no write and never touches Authentik.
 */
describe('POST /api/users/callsign-suffix-preview', () => {
  let app;
  let originalFetch;

  const PREVIEW_BODY = { teamId: 7, firstName: 'New', lastName: 'User' };

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    originalFetch = global.fetch;
    global.fetch = jest.fn();
    pool.query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports the computed default suffix for a team whose Organisation derives it', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockResolvedValue('N.User');

    const res = await request(app).post('/api/users/callsign-suffix-preview').send(PREVIEW_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suffix: 'N.User', required: false, conflict: null });
    expect(UserProvisioningService.resolveCallsignSuffixForNewUser).toHaveBeenCalledWith(null, {
      firstName: 'New',
      lastName: 'User',
      teamId: 7,
      requestedCallsignSuffix: undefined
    });
  });

  it('passes a supplied callsignSuffix through to the resolver and reports it back', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockResolvedValue('Bravo1');

    const res = await request(app)
      .post('/api/users/callsign-suffix-preview')
      .send({ ...PREVIEW_BODY, callsignSuffix: 'Bravo1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suffix: 'Bravo1', required: false, conflict: null });
    expect(UserProvisioningService.resolveCallsignSuffixForNewUser).toHaveBeenCalledWith(null, {
      firstName: 'New',
      lastName: 'User',
      teamId: 7,
      requestedCallsignSuffix: 'Bravo1'
    });
  });

  it('reports required: true (and no suffix) for a user_defined Organisation with no suffix supplied', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockRejectedValue(
      new UserProvisioningService.CallsignSuffixRequiredError()
    );

    const res = await request(app).post('/api/users/callsign-suffix-preview').send(PREVIEW_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ suffix: null, required: true, conflict: null });
  });

  it('reports the conflicting value and message on a per-Team uniqueness collision', async () => {
    const { CallsignSuffixConflictError } = jest.requireActual('../services/CallsignSuffixUniquenessService');
    const conflictError = new CallsignSuffixConflictError('J.Doe');
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockRejectedValue(conflictError);

    const res = await request(app)
      .post('/api/users/callsign-suffix-preview')
      .send({ ...PREVIEW_BODY, callsignSuffix: 'J.Doe' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      suffix: 'J.Doe',
      required: false,
      conflict: { value: 'J.Doe', message: conflictError.message }
    });
  });

  it('returns 400 with an errors array when teamId is missing or not an integer', async () => {
    const missing = await request(app)
      .post('/api/users/callsign-suffix-preview')
      .send({ firstName: 'New', lastName: 'User' });

    expect(missing.status).toBe(400);
    expect(Array.isArray(missing.body.errors)).toBe(true);
    expect(missing.body.errors.length).toBeGreaterThan(0);

    const nonInteger = await request(app)
      .post('/api/users/callsign-suffix-preview')
      .send({ ...PREVIEW_BODY, teamId: 'not-a-number' });

    expect(nonInteger.status).toBe(400);
    expect(Array.isArray(nonInteger.body.errors)).toBe(true);

    // Validation failure short-circuits before any resolution work.
    expect(UserProvisioningService.resolveCallsignSuffixForNewUser).not.toHaveBeenCalled();
  });

  it('issues no write and no Authentik call -- the preview is strictly read-only', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockResolvedValue('N.User');

    const res = await request(app).post('/api/users/callsign-suffix-preview').send(PREVIEW_BODY);

    expect(res.status).toBe(200);

    // No transaction was opened...
    expect(pool.connect).not.toHaveBeenCalled();
    // ...no Authentik HTTP call was made...
    expect(global.fetch).not.toHaveBeenCalled();
    // ...and no mutating statement reached the pool.
    for (const [sql] of pool.query.mock.calls) {
      expect(String(sql)).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    }
  });

  it('responds 500 and logs when the resolver fails for an unexpected reason', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockRejectedValue(
      new Error('database unreachable')
    );

    const res = await request(app).post('/api/users/callsign-suffix-preview').send(PREVIEW_BODY);

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

/**
 * CloudTAK Agency group enqueue at the create-and-add admin promotion
 * (Requirement 5.2 / 9.1 / 9.2 / 1.4, task 8.2/8.4).
 *
 * When the caller creates-and-adds a user as `role: 'admin'`, the route
 * promotes the just-created membership row to `'admin'` on the
 * transactional client and -- ONLY when CloudTAK is enabled -- enqueues
 * one `update_cloudtak_group` with `{ team_id }` on that SAME client so
 * the enqueue commits/rolls back atomically with the promotion. Nothing
 * enqueues when the flag is off, and nothing enqueues for a non-admin
 * (`role: 'member'`) creation.
 *
 * `isCloudTakEnabled()` reads `process.env` at call time, so toggling
 * `process.env.CLOUDTAK_ENABLED` here is sufficient; it is saved and
 * restored around each test.
 */
describe('POST /api/users/create-and-add CloudTAK admin-promotion enqueue (Requirement 5.2 / 9.2 / 1.4)', () => {
  let app;
  let originalFetch;
  let savedFlag;

  function buildAdminMockClient() {
    return {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
          return Promise.resolve({ rows: [{ id: 55 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    originalFetch = global.fetch;
    savedFlag = process.env.CLOUDTAK_ENABLED;
    pool.query.mockResolvedValue({ rows: [] });
    // `jest.clearAllMocks()` clears recorded calls but NOT implementations,
    // so restore the benign Phase-0 default here in case an earlier test in
    // this file left `resolveCallsignSuffixForNewUser` rejecting.
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockResolvedValue(null);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (savedFlag === undefined) {
      delete process.env.CLOUDTAK_ENABLED;
    } else {
      process.env.CLOUDTAK_ENABLED = savedFlag;
    }
  });

  it("enqueues one update_cloudtak_group with { team_id } on the transactional client for a role='admin' creation when the flag is on", async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    mockAuthentikSuccess();
    const mockClient = buildAdminMockClient();
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const res = await request(app)
      .post('/api/users/create-and-add')
      .send({ ...VALID_BODY, role: 'admin' });

    expect(res.status).toBe(201);
    // The membership row was promoted to 'admin' on the transactional client.
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE team_memberships SET role = $3'),
      [7, 55, 'admin']
    );
    // ...and the CloudTAK enqueue rides the SAME transactional client.
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_cloudtak_group',
      { team_id: 7 },
      1,
      mockClient
    );
  });

  it("enqueues NOTHING when the flag is off, even for a role='admin' creation (Requirement 1.4)", async () => {
    process.env.CLOUDTAK_ENABLED = 'false';
    mockAuthentikSuccess();
    const mockClient = buildAdminMockClient();
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const res = await request(app)
      .post('/api/users/create-and-add')
      .send({ ...VALID_BODY, role: 'admin' });

    expect(res.status).toBe(201);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
      'update_cloudtak_group',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  it("enqueues no update_cloudtak_group for a non-admin (role='member') creation, even with the flag on", async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    mockAuthentikSuccess();
    const mockClient = buildAdminMockClient();
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const res = await request(app)
      .post('/api/users/create-and-add')
      .send({ ...VALID_BODY, role: 'member' });

    expect(res.status).toBe(201);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
      'update_cloudtak_group',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });
});
