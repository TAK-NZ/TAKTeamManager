/**
 * Integration tests for `GET /api/users` (Requirement 11.3: batched
 * team-name lookup).
 *
 * These exercise the actual mounted route via `supertest`, mocking
 * `pool.query` and `authentikService.getUsers()`, to verify the N+1
 * recursive-CTE-per-user query pattern has been replaced by a single
 * batched query:
 *
 *  - For a batch of multiple Authentik users, `pool.query` is called
 *    exactly once for the team-name lookup (not once per user).
 *  - The returned `team_name` values match the expected format for both
 *    a top-level team and a sub-team scenario.
 *  - A user with no direct team membership (absent from the query's
 *    result rows) gets `team_name: null`.
 *  - The existing sub-team display-name format (`prefix - subteam name`)
 *    is preserved exactly.
 *
 * `authenticateToken`/`authorize` are mocked to bypass real JWT/DB-backed
 * authorization, since this test is scoped to the `GET /` handler's
 * team-name-lookup query, not the authorization middleware chain (already
 * covered elsewhere).
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../services/authentik', () => ({
  getUsers: jest.fn()
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const authentikService = require('../services/authentik');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

describe('GET /api/users batched team-name lookup (Requirement 11.3)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('issues exactly one pool.query call for team-name lookup regardless of user count', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' },
        { pk: 2, username: 'bob' },
        { pk: 3, username: 'carol' }
      ],
      count: 3
    });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    // Exactly one call to pool.query for the whole batch, not once per user.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('attaches the correct team_name for a top-level team and a sub-team, using the single query result', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' }, // top-level team member
        { pk: 2, username: 'bob' } // sub-team member
      ],
      count: 2
    });

    pool.query.mockResolvedValue({
      rows: [
        { authentik_user_id: 1, team_name: 'Alpha Team' },
        { authentik_user_id: 2, team_name: 'HQ - Bravo Squad' }
      ]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);

    const alice = res.body.users.find((u) => u.pk === 1);
    const bob = res.body.users.find((u) => u.pk === 2);

    expect(alice.team_name).toBe('Alpha Team');
    // Preserves the exact existing sub-team display-name format:
    // `prefix - subteam name`.
    expect(bob.team_name).toBe('HQ - Bravo Squad');
  });

  it('passes the full array of Authentik user ids as a single ANY($1) parameter', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 10, username: 'a' },
        { pk: 20, username: 'b' },
        { pk: 30, username: 'c' }
      ],
      count: 3
    });
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users');

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual([[10, 20, 30]]);
  });

  it('defaults team_name to null for a user absent from the query result rows', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' },
        { pk: 2, username: 'no-team-user' }
      ],
      count: 2
    });

    // Only alice has a direct team membership row returned by the query;
    // pk 2 has no direct membership and is simply absent from the result.
    pool.query.mockResolvedValue({
      rows: [{ authentik_user_id: 1, team_name: 'Alpha Team' }]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const noTeamUser = res.body.users.find((u) => u.pk === 2);
    expect(noTeamUser.team_name).toBeNull();
  });

  it('does not query the database at all when there are no Authentik users', async () => {
    authentikService.getUsers.mockResolvedValue({ results: [], count: 0 });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 500 without throwing when the batched query itself fails', async () => {
    authentikService.getUsers.mockResolvedValue({ results: [{ pk: 1, username: 'alice' }], count: 1 });
    pool.query.mockRejectedValue(new Error('db unavailable'));

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(500);
  });
});

/**
 * Requirement 27.9 (task 49.5): `GET /api/users` excludes every
 * Team_Owned_Device (`users.is_team_device = true`) from its response,
 * even though Authentik itself returns that device's user unchanged
 * (a Team_Owned_Device's Authentik user is created with
 * `type: 'internal'`, identical to a human user, so
 * `authentikService.getUsers({page, pageSize})` -- which filters on
 * `?type=internal` -- includes it). The exclusion must therefore happen
 * locally, by cross-referencing `users.is_team_device` via the same
 * batched query already used for team-name resolution.
 */
describe('GET /api/users excludes Team_Owned_Device rows (Requirement 27.9)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('excludes a user whose local users row has is_team_device = true, even though Authentik returns it', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' },
        { pk: 2, username: 'device-abc123' }
      ],
      count: 2
    });

    pool.query.mockResolvedValue({
      rows: [
        { authentik_user_id: 1, team_name: 'Alpha Team', is_team_device: false },
        { authentik_user_id: 2, team_name: 'Alpha Team', is_team_device: true }
      ]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].pk).toBe(1);
    expect(res.body.users.find((u) => u.pk === 2)).toBeUndefined();
  });

  it('does not exclude a user with is_team_device = false or absent from the local table', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' },
        { pk: 2, username: 'bob' }
      ],
      count: 2
    });

    // pk 1 has an explicit is_team_device: false row; pk 2 has no
    // corresponding local users row at all (absent from the result set).
    pool.query.mockResolvedValue({
      rows: [{ authentik_user_id: 1, team_name: null, is_team_device: false }]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
  });
});

/**
 * takserver-enrollment Requirement 13.2/13.6: `GET /api/users` projects
 * `live_certificate_count`, derived from a `certs` derived-table LEFT JOIN
 * added to the SAME batched team-name query -- never a second query --
 * so the Multiple_Certificate_Warning can be rendered without a per-row
 * round trip. Row presence in `tak_devices` (with `revoked = false`) is
 * what "live certificate" means; a revoked row or a row with a null
 * `user_id` must never be counted.
 */
describe('GET /api/users live certificate count (Requirement 13.2, 13.6)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('attaches live_certificate_count: 0 for a user with no certificate rows', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });
    pool.query.mockResolvedValue({
      rows: [{ authentik_user_id: 1, team_name: null, is_team_device: false, live_certificate_count: 0 }]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const alice = res.body.users.find((u) => u.pk === 1);
    expect(alice.live_certificate_count).toBe(0);
  });

  it('attaches live_certificate_count: 1 for a user with exactly one live certificate', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });
    pool.query.mockResolvedValue({
      rows: [{ authentik_user_id: 1, team_name: null, is_team_device: false, live_certificate_count: 1 }]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const alice = res.body.users.find((u) => u.pk === 1);
    expect(alice.live_certificate_count).toBe(1);
  });

  it('attaches the correct count for a user with 2 or more live certificates', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });
    pool.query.mockResolvedValue({
      rows: [{ authentik_user_id: 1, team_name: null, is_team_device: false, live_certificate_count: 3 }]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const alice = res.body.users.find((u) => u.pk === 1);
    expect(alice.live_certificate_count).toBe(3);
  });

  it('defaults live_certificate_count to 0 (not null/undefined) for a user absent from the query result rows', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });
    // No corresponding row at all -- the LEFT JOIN chain still produces a
    // row per user in the real query, but this exercises the JS-side
    // fallback for a user missing from the map.
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const alice = res.body.users.find((u) => u.pk === 1);
    expect(alice.live_certificate_count).toBe(0);
    expect(alice.live_certificate_count).not.toBeNull();
    expect(alice.live_certificate_count).not.toBeUndefined();
  });

  it('issues the SAME number of pool.query calls as before this change (no new round trip)', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' },
        { pk: 2, username: 'bob' },
        { pk: 3, username: 'carol' }
      ],
      count: 3
    });
    pool.query.mockResolvedValue({
      rows: [
        { authentik_user_id: 1, team_name: 'Alpha Team', is_team_device: false, live_certificate_count: 2 },
        { authentik_user_id: 2, team_name: 'Alpha Team', is_team_device: false, live_certificate_count: 0 },
        { authentik_user_id: 3, team_name: 'Alpha Team', is_team_device: false, live_certificate_count: 1 }
      ]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    // Exactly one call for the whole batch -- same as the pre-existing
    // team-name lookup's call count, independent of the number of users
    // returned (Criterion 13.6).
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('the SQL text includes the certs derived-table join, scoped to non-revoked rows with a non-null user_id', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users');

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/FROM tak_devices/);
    expect(sql).toMatch(/user_id IS NOT NULL AND revoked = false/);
    expect(sql).toMatch(/COALESCE\(certs\.live_certificate_count, 0\) AS live_certificate_count/);
  });
});

describe('GET /api/users pagination (Requirement 11.4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns 400 for an out-of-range pageSize before calling Authentik or the database', async () => {
    const res = await request(app).get('/api/users').query({ pageSize: 500 });

    expect(res.status).toBe(400);
    expect(authentikService.getUsers).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-numeric page before calling Authentik or the database', async () => {
    const res = await request(app).get('/api/users').query({ page: 'abc' });

    expect(res.status).toBe(400);
    expect(authentikService.getUsers).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('passes the resolved page/pageSize through to authentikService.getUsers and echoes them in the response', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 42
    });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users').query({ page: 2, pageSize: 5 });

    expect(res.status).toBe(200);
    expect(authentikService.getUsers).toHaveBeenCalledWith({ page: 2, pageSize: 5 });
    expect(res.body.pagination).toEqual({ page: 2, pageSize: 5, total: 42 });
  });

  it('defaults to page 1 / pageSize 50 when no query params are supplied', async () => {
    authentikService.getUsers.mockResolvedValue({ results: [], count: 0 });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(authentikService.getUsers).toHaveBeenCalledWith({ page: 1, pageSize: 50 });
  });
});
