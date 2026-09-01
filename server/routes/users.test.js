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

// Users-page-action-parity: `mockAuthUser` is a mutable box the mock factory
// below reads on every request, so a describe block that needs a
// non-Global_Manager caller (to exercise the new `can_manage` field's
// `Team.getManagedTeamIds` branch) can reassign it in its own `beforeEach`
// without needing a second, differently-mocked `buildApp`. Every
// PRE-EXISTING describe block never reassigns it, so it keeps running as
// the same Global_Manager (`is_global_manager: true`) it always has.
const mockAuthUser = { id: 1, userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { ...mockAuthUser };
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
 * even though Authentik itself can return that device's user unchanged.
 * A Team_Owned_Device created BEFORE the device-management follow-up
 * (`DeviceEnrollmentService.createDevice` now creates a device's
 * Authentik user with `type: 'service_account'`) is still `type:
 * 'internal'` in Authentik, identical to a human user, so
 * `authentikService.getUsers({page, pageSize})` -- which filters on
 * `?type=internal` -- still includes it. This test mocks `getUsers` to
 * return exactly that pre-existing-device shape, and the exclusion must
 * therefore happen locally, by cross-referencing `users.is_team_device`
 * via the same batched query already used for team-name resolution.
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
 * Bugfix: `GET /api/users` now ALSO filters out any Authentik user whose
 * `username` matches `AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES` (the SAME
 * predicate `authentikSync.js` already uses to decide which accounts
 * never get materialized into the local `users` table -- ETL/service
 * accounts, and administrative accounts like `akadmin`/`ckadmin`). This
 * route fetches directly from Authentik's `/core/users/?type=internal`
 * and, unlike the `is_team_device` exclusion above, has no local-table
 * cross-reference to lean on -- the filter runs on `user.username` alone,
 * entirely independent of the batched query's rows.
 */
describe('GET /api/users excludes AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES matches (bugfix)', () => {
  let app;
  const originalEnv = process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    } else {
      process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = originalEnv;
    }
  });

  it('excludes a user whose username exactly matches a configured entry (akadmin/ckadmin), even with no local users row at all', async () => {
    process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'akadmin,ckadmin';
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' },
        { pk: 2, username: 'akadmin' },
        { pk: 3, username: 'ckadmin' }
      ],
      count: 3
    });
    // No local users rows for any of these -- the filter must not depend
    // on the batched query's result at all.
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].pk).toBe(1);
  });

  it('excludes a genuine prefix match (etl-) exactly like the sync-skip predicate does', async () => {
    process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'etl-';
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'etl-earthquakes' },
        { pk: 2, username: 'alice' }
      ],
      count: 2
    });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].pk).toBe(2);
  });

  it('excludes nothing when the variable is unset (preserves existing behavior)', async () => {
    delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' },
        { pk: 2, username: 'akadmin' }
      ],
      count: 2
    });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
  });

  it('composes with the is_team_device exclusion -- both filters can remove rows from the same response', async () => {
    process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'akadmin';
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' },
        { pk: 2, username: 'akadmin' },
        { pk: 3, username: 'device-abc123' }
      ],
      count: 3
    });
    pool.query.mockResolvedValue({
      rows: [
        { authentik_user_id: 1, team_name: 'Alpha Team', is_team_device: false },
        { authentik_user_id: 3, team_name: 'Alpha Team', is_team_device: true }
      ]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].pk).toBe(1);
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

/**
 * Users-page-action-parity: `GET /api/users` additionally projects
 * `team_id` -- the user's direct-membership team's raw id, alongside the
 * pre-existing `team_name` display string. The Users view's row actions
 * (Edit via `PATCH /api/teams/:teamId/members/:userId`, and the Transfer
 * dialog's source-team context) need the actual id, not only the rendered
 * name, and it comes from the SAME batched query -- no new round trip.
 */
describe('GET /api/users projects team_id alongside team_name (Users-page-action-parity)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('attaches team_id for a user with a direct team membership', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });
    pool.query.mockResolvedValue({
      rows: [{ authentik_user_id: 1, team_name: 'Alpha Team', team_id: 42 }]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const alice = res.body.users.find((u) => u.pk === 1);
    expect(alice.team_id).toBe(42);
  });

  it('defaults team_id to null for a user absent from the query result rows', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'no-team-user' }],
      count: 1
    });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const user = res.body.users.find((u) => u.pk === 1);
    expect(user.team_id).toBeNull();
  });

  it('defaults team_id to null when the query returns the row but with no team_id (no direct membership)', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'no-team-user' }],
      count: 1
    });
    pool.query.mockResolvedValue({
      rows: [{ authentik_user_id: 1, team_name: null, team_id: null }]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const user = res.body.users.find((u) => u.pk === 1);
    expect(user.team_id).toBeNull();
  });

  it('the SQL text projects t.id as team_id', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users');

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/t\.id AS team_id/);
  });
});

/**
 * Users-page-action-parity: `GET /api/users` additionally projects the
 * LOCAL `users` columns the Member_List edit form (`MemberEditRow`) needs
 * to pre-fill itself -- `first_name`, `last_name`, `tak_role`,
 * `callsign_suffix` -- from the SAME batched query, never from
 * Authentik's own payload.
 */
describe('GET /api/users projects local member-edit fields (Users-page-action-parity)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('attaches first_name, last_name, tak_role, callsign_suffix from the local users row', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice', name: 'Alice Authentik' }],
      count: 1
    });
    pool.query.mockResolvedValue({
      rows: [{
        authentik_user_id: 1,
        local_first_name: 'Alice',
        local_last_name: 'Local',
        local_tak_role: 'Team Lead',
        local_callsign_suffix: 'A.Local'
      }]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const alice = res.body.users.find((u) => u.pk === 1);
    expect(alice.first_name).toBe('Alice');
    expect(alice.last_name).toBe('Local');
    expect(alice.tak_role).toBe('Team Lead');
    expect(alice.callsign_suffix).toBe('A.Local');
  });

  it('defaults all four fields to null for a user absent from the query result rows', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'no-local-row' }],
      count: 1
    });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const user = res.body.users.find((u) => u.pk === 1);
    expect(user.first_name).toBeNull();
    expect(user.last_name).toBeNull();
    expect(user.tak_role).toBeNull();
    expect(user.callsign_suffix).toBeNull();
  });

  it('the SQL text projects the four local columns under their local_ aliases', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users');

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/u\.first_name AS local_first_name/);
    expect(sql).toMatch(/u\.last_name AS local_last_name/);
    expect(sql).toMatch(/u\.tak_role AS local_tak_role/);
    expect(sql).toMatch(/u\.callsign_suffix AS local_callsign_suffix/);
  });
});

/**
 * account-lifecycle-management: `GET /api/users` additionally projects
 * `account_status` and `username` from the LOCAL `users` row, needed by
 * the Users page's Suspend/Unsuspend action -- `account_status` drives
 * the action's icon/label/mode, and `username` is the value
 * `SuspendAccountDialog`'s type-to-confirm input requires for
 * `mode="suspend"`. Sourced from the SAME batched query as the other
 * local-column fields above, never from Authentik's own payload.
 */
describe('GET /api/users projects account_status and username (account-lifecycle-management)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('attaches account_status and username from the local users row', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice-authentik' }],
      count: 1
    });
    pool.query.mockResolvedValue({
      rows: [{
        authentik_user_id: 1,
        local_account_status: 'suspended',
        local_username: 'alice-local'
      }]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const alice = res.body.users.find((u) => u.pk === 1);
    expect(alice.account_status).toBe('suspended');
    expect(alice.username).toBe('alice-local');
  });

  it('defaults both fields to null for a user absent from the query result rows', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'no-local-row' }],
      count: 1
    });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const user = res.body.users.find((u) => u.pk === 1);
    expect(user.account_status).toBeNull();
    expect(user.username).toBeNull();
  });

  it('the SQL text projects both local columns under their local_ aliases', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users');

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/u\.account_status AS local_account_status/);
    expect(sql).toMatch(/u\.username AS local_username/);
  });
});

/**
 * Users-page-action-parity: `GET /api/users` additionally projects
 * `can_manage`, answering "may THIS caller act on THIS row's own team"
 * (Edit/Transfer/Delete), independent of `DirectoryScopeService`'s
 * VISIBILITY scoping. A Global_Manager can manage every row with no
 * extra query; a non-Global_Manager gets exactly one extra query
 * (`Team.getManagedTeamIds`) and `can_manage` becomes a Set-membership
 * test against the row's own `team_id`.
 */
describe('GET /api/users projects can_manage (Users-page-action-parity)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  afterEach(() => {
    // Restore the shared mock user to the Global_Manager every other
    // describe block in this file relies on.
    mockAuthUser.id = 1;
    mockAuthUser.userId = 1;
    mockAuthUser.is_global_manager = true;
  });

  it('sets can_manage: true for every row for a Global_Manager, with no extra query', async () => {
    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }, { pk: 2, username: 'bob' }],
      count: 2
    });
    pool.query.mockResolvedValue({
      rows: [
        { authentik_user_id: 1, team_name: 'Alpha Team', team_id: 4 },
        { authentik_user_id: 2, team_name: null, team_id: null }
      ]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    // The team-name batched query is the ONLY pool.query call -- no
    // Team.getManagedTeamIds query for a Global_Manager.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(res.body.users.find((u) => u.pk === 1).can_manage).toBe(true);
    expect(res.body.users.find((u) => u.pk === 2).can_manage).toBe(true);
  });

  it('sets can_manage: true only for rows whose team_id is in Team.getManagedTeamIds\'s result, for a non-Global_Manager', async () => {
    mockAuthUser.id = 9;
    mockAuthUser.userId = 9;
    mockAuthUser.is_global_manager = false;

    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 1, username: 'alice' }, // managed team
        { pk: 2, username: 'bob' },   // unmanaged team
        { pk: 3, username: 'carol' }  // no team at all
      ],
      count: 3
    });

    pool.query.mockImplementation(async (sql) => {
      // `managed_teams` is the CTE name UNIQUE to Team.getManagedTeamIds --
      // DirectoryScopeService.resolveScope's Q1 also names its first CTE
      // `admin_teams`, so matching on that alone would also intercept
      // (and mis-shape the response for) the VISIBILITY-scoping query this
      // non-Global_Manager path additionally issues.
      if (typeof sql === 'string' && sql.includes('managed_teams')) {
        // Team.getManagedTeamIds(9) -- caller administers team 4 (and its
        // descendants, already flattened by the real recursive query;
        // this mock just returns the flattened set directly).
        return { rows: [{ team_id: 4 }] };
      }
      // DirectoryScopeService.resolveScope's Q1 (Scoped_Organisations):
      // this test is about `can_manage`, a SEPARATE question from
      // visibility, so it admits every candidate via provenance
      // (`origin_org_id: 100` on every row below, matched against this
      // resolved Organisation) rather than actually exercising the
      // domain-matching path -- Q2/Q3 below are answered empty since
      // provenance alone is enough to admit them.
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE admin_teams')) {
        return { rows: [{ id: 100, name: 'Org' }] };
      }
      if (typeof sql === 'string' && sql.includes('org_allowed_domains')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('excluded_email_domains')) {
        return { rows: [] };
      }
      // The team-name batched query.
      return {
        rows: [
          { authentik_user_id: 1, team_name: 'Alpha Team', team_id: 4, origin_org_id: 100 },
          { authentik_user_id: 2, team_name: 'Beta Team', team_id: 7, origin_org_id: 100 },
          { authentik_user_id: 3, team_name: null, team_id: null, origin_org_id: 100 }
        ]
      };
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users.find((u) => u.pk === 1).can_manage).toBe(true);
    expect(res.body.users.find((u) => u.pk === 2).can_manage).toBe(false);
    expect(res.body.users.find((u) => u.pk === 3).can_manage).toBe(false);
  });

  it('calls Team.getManagedTeamIds with req.user.userId (the LOCAL id), not req.user.id (the Authentik id)', async () => {
    mockAuthUser.id = 999; // Authentik id -- must NOT be what's queried
    mockAuthUser.userId = 9; // local users.id -- must be what's queried
    mockAuthUser.is_global_manager = false;

    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });

    let capturedParams = null;
    pool.query.mockImplementation(async (sql, params) => {
      // `managed_teams` disambiguates Team.getManagedTeamIds's query from
      // DirectoryScopeService.resolveScope's own, differently-shaped
      // `admin_teams`-named CTE -- both happen to take the same [userId]
      // parameter shape here, so matching the wrong one would still pass
      // this specific assertion while testing nothing real.
      if (typeof sql === 'string' && sql.includes('managed_teams')) {
        capturedParams = params;
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE admin_teams')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && (sql.includes('org_allowed_domains') || sql.includes('excluded_email_domains'))) {
        return { rows: [] };
      }
      return { rows: [{ authentik_user_id: 1, team_name: null, team_id: null }] };
    });

    await request(app).get('/api/users');

    expect(capturedParams).toEqual([9]);
  });

  it('sets can_manage: false for every row when Team.getManagedTeamIds resolves an empty Set (no administered team anywhere)', async () => {
    mockAuthUser.id = 9;
    mockAuthUser.userId = 9;
    mockAuthUser.is_global_manager = false;

    authentikService.getUsers.mockResolvedValue({
      results: [{ pk: 1, username: 'alice' }],
      count: 1
    });

    pool.query.mockImplementation(async (sql) => {
      // See the disambiguation note in the test above: `managed_teams` is
      // unique to Team.getManagedTeamIds, distinct from
      // DirectoryScopeService.resolveScope's own `admin_teams`-named CTE.
      if (typeof sql === 'string' && sql.includes('managed_teams')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE admin_teams')) {
        return { rows: [{ id: 100, name: 'Org' }] };
      }
      if (typeof sql === 'string' && sql.includes('org_allowed_domains')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('excluded_email_domains')) {
        return { rows: [] };
      }
      return { rows: [{ authentik_user_id: 1, team_name: 'Alpha Team', team_id: 4, origin_org_id: 100 }] };
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users.find((u) => u.pk === 1).can_manage).toBe(false);
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
