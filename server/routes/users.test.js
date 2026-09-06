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

// GET /me additionally calls User.getChannelMemberships(req.user.userId).
// No other describe block in this file calls into the User model, so this
// mock is safe to add file-wide.
jest.mock('../models/User', () => ({
  getChannelMemberships: jest.fn()
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
const User = require('../models/User');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}


/**
 * Authentik-scaling follow-up: `GET /api/users` now sources its rows from
 * the LOCAL database (`users` LEFT JOIN `user_cache` + team_root CTE +
 * tak_devices cert count), NOT a live per-request Authentik fetch. These
 * tests exercise the mounted route via supertest with `pool.query` mocked to
 * return the joined rows the new single query produces (shape: pk,
 * local_user_id, username, email, first_name, last_name, is_active, tak_role,
 * callsign_suffix, account_status, origin_org_id, tak_callsign, tak_color,
 * team_id, direct_membership_org_id, team_name, live_certificate_count,
 * total_count). Device/orphaned/ignored-prefix exclusion and search/scope
 * narrowing now happen IN SQL, so those are asserted at the SQL level
 * (predicate presence + bound params) plus faithful row->response mapping.
 *
 * `authenticateToken`/`authorize` are mocked to bypass real auth; the list
 * route no longer calls `authentikService` at all.
 */

// A joined row as the new local query returns it. Only `pk` and `username`
// are required here; every other column defaults to a sensible value so a
// test names just the fields it cares about.
function makeRow(overrides = {}) {
  return {
    pk: 1,
    local_user_id: 100,
    username: 'alice',
    email: 'alice@example.com',
    first_name: 'Alice',
    last_name: 'Anders',
    is_active: true,
    tak_role: 'Team Member',
    callsign_suffix: null,
    account_status: 'active',
    origin_org_id: null,
    tak_callsign: null,
    tak_color: null,
    last_login: null,
    team_id: null,
    direct_membership_org_id: null,
    team_name: null,
    live_certificate_count: 0,
    total_count: 1,
    ...overrides
  };
}

describe('GET /api/users (local-sourced list)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthUser.id = 1;
    mockAuthUser.userId = 1;
    mockAuthUser.is_global_manager = true; // default: Global_Manager (unscoped)
    app = buildApp();
  });

  it('does NOT call authentikService for the list (sources from local DB only)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(authentikService.getUsers).not.toHaveBeenCalled();
  });

  it('runs a single local query against users (not user_cache as the row source) and returns the mapped rows', async () => {
    pool.query.mockResolvedValue({
      rows: [
        makeRow({ pk: 1, username: 'alice', team_name: 'Alpha Team', total_count: 2 }),
        makeRow({ pk: 2, local_user_id: 101, username: 'bob', first_name: 'Bob', last_name: 'Brown', team_name: 'HQ - Bravo Squad', total_count: 2 })
      ]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    // One query for the list (GM path issues no Team.getManagedTeamIds).
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM users u');
    expect(sql).toContain('LEFT JOIN user_cache uc');

    const alice = res.body.users.find((u) => u.pk === 1);
    const bob = res.body.users.find((u) => u.pk === 2);
    expect(alice.team_name).toBe('Alpha Team');
    expect(bob.team_name).toBe('HQ - Bravo Squad');
    // name is composed from local first/last name.
    expect(alice.name).toBe('Alice Anders');
    expect(bob.name).toBe('Bob Brown');
  });

  it('derives an EXACT pagination.total from the query rows total_count', async () => {
    pool.query.mockResolvedValue({
      rows: [makeRow({ pk: 1, total_count: 4237 })]
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(4237);
  });

  it('returns total 0 and an empty list when no rows match', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('excludes Team_Owned_Devices, orphaned rows, and ignored-prefix usernames IN SQL (predicate presence)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users');

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('u.is_team_device = false');
    expect(sql).toContain("u.account_status <> 'orphaned'");
    expect(sql).toContain('u.username LIKE ANY($2::text[])');
  });

  it('forwards a search term as an ILIKE %term% bound parameter over username/email/name', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users?search=reynolds');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('u.username ILIKE $1');
    expect(sql).toContain('u.email ILIKE $1');
    expect(params[0]).toBe('%reynolds%');
  });

  it('passes a null search parameter when no search term is supplied', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users');

    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toBeNull();
  });

  it('applies pagination via LIMIT/OFFSET bound params', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users?page=3&pageSize=20');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('LIMIT $6 OFFSET $7');
    // pageSize (index 5) and offset (index 6) = (3-1)*20 = 40.
    expect(params[5]).toBe(20);
    expect(params[6]).toBe(40);
  });

  // Large-directory filters: teamId ($8) and lastNameInitial ($9), both applied
  // in SQL before the COUNT/LIMIT so the exact total + pagination stay correct.
  it('passes a null teamId and null lastNameInitial when neither filter is supplied', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users');

    const [sql, params] = pool.query.mock.calls[0];
    // The predicates are present but inert (the $8/$9 IS NULL disable branch).
    expect(sql).toContain('$8::int IS NULL');
    expect(sql).toContain('$9::text IS NULL');
    expect(params[7]).toBeNull(); // teamId
    expect(params[8]).toBeNull(); // lastNameInitial
  });

  it('binds a numeric teamId to $8 and narrows to that direct-membership team', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users?teamId=55');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('t.id = $8::int');
    expect(params[7]).toBe(55);
  });

  it('treats a non-numeric teamId as no filter (null $8)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users?teamId=abc');

    const [, params] = pool.query.mock.calls[0];
    expect(params[7]).toBeNull();
  });

  it('binds an uppercased single-letter lastNameInitial to $9', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users?lastNameInitial=b');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("u.last_name ILIKE $9 || '%'");
    expect(params[8]).toBe('B');
  });

  it("binds the '#' non-alphabetic bucket for lastNameInitial='#'", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users?lastNameInitial=%23'); // %23 = '#'

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("u.last_name !~ '^[A-Za-z]'");
    expect(params[8]).toBe('#');
  });

  it('ignores a multi-character or invalid lastNameInitial (null $9)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users?lastNameInitial=abc');

    const [, params] = pool.query.mock.calls[0];
    expect(params[8]).toBeNull();
  });

  it('composes teamId + lastNameInitial + search together in one query', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users?teamId=7&lastNameInitial=S&search=smith');

    const [sql, params] = pool.query.mock.calls[0];
    // All three narrowings present in the same statement.
    expect(sql).toContain('t.id = $8::int');
    expect(sql).toContain("u.last_name ILIKE $9 || '%'");
    expect(params[0]).toBe('%smith%');
    expect(params[7]).toBe(7);
    expect(params[8]).toBe('S');
  });

  it('maps every client-consumed field faithfully from the local row', async () => {
    pool.query.mockResolvedValue({
      rows: [makeRow({
        pk: 7,
        local_user_id: 700,
        username: 'carol',
        email: 'carol@example.com',
        first_name: 'Carol',
        last_name: 'Chen',
        is_active: false,
        tak_role: 'Team Lead',
        callsign_suffix: 'C1',
        account_status: 'suspended',
        tak_callsign: 'CAROL',
        tak_color: 'Cyan',
        last_login: '2026-09-01T08:30:00.000Z',
        team_id: 55,
        team_name: 'Alpha Team',
        live_certificate_count: 2,
        total_count: 1
      })]
    });

    const res = await request(app).get('/api/users');
    const carol = res.body.users[0];

    expect(carol).toMatchObject({
      pk: 7,
      local_user_id: 700,
      username: 'carol',
      email: 'carol@example.com',
      name: 'Carol Chen',
      is_active: false,
      first_name: 'Carol',
      last_name: 'Chen',
      tak_role: 'Team Lead',
      callsign_suffix: 'C1',
      tak_callsign: 'CAROL',
      tak_color: 'Cyan',
      last_login: '2026-09-01T08:30:00.000Z',
      account_status: 'suspended',
      team_name: 'Alpha Team',
      team_id: 55,
      live_certificate_count: 2
    });
    // Global_Manager manages every row.
    expect(carol.can_manage).toBe(true);
  });

  it('returns 500 without throwing when the query fails', async () => {
    pool.query.mockRejectedValue(new Error('db unavailable'));

    const res = await request(app).get('/api/users');
    expect(res.status).toBe(500);
  });

  describe('scoped (non-Global_Manager) caller', () => {
    beforeEach(() => {
      mockAuthUser.is_global_manager = false;
    });

    it('passes isUnscoped=false and the caller scope org ids / domain patterns into the query', async () => {
      // DirectoryScopeService.resolveScope issues its own queries; make the
      // first calls (scope resolution) return an admin org, then the list
      // query, then Team.getManagedTeamIds. Simplest: resolve scope to one
      // org id via the recursive-CTE query result, no allowed domains.
      pool.query.mockImplementation((sql) => {
        if (sql.includes('WITH RECURSIVE admin_teams')) {
          return Promise.resolve({ rows: [{ id: 42, name: 'Org42' }] });
        }
        if (sql.includes('FROM org_allowed_domains')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('FROM system_config')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('FROM users u')) {
          return Promise.resolve({ rows: [] }); // list query
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app).get('/api/users');

      expect(res.status).toBe(200);
      const listCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM users u'));
      expect(listCall).toBeDefined();
      const params = listCall[1];
      // isUnscoped=false, org ids = [42].
      expect(params[2]).toBe(false);
      expect(params[3]).toEqual([42]);
    });

    it('runs the belt-and-braces predicate pass so a row outside scope is dropped from the response', async () => {
      pool.query.mockImplementation((sql) => {
        if (sql.includes('WITH RECURSIVE admin_teams')) {
          return Promise.resolve({ rows: [{ id: 42, name: 'Org42' }] });
        }
        if (sql.includes('FROM org_allowed_domains')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('FROM system_config')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('FROM users u')) {
          // Two rows: one whose direct-membership org is in scope (42),
          // one whose org is 99 (out of scope) and no matching domain.
          return Promise.resolve({
            rows: [
              makeRow({ pk: 1, username: 'inscope', direct_membership_org_id: 42, origin_org_id: 42, total_count: 2 }),
              makeRow({ pk: 2, username: 'outscope', direct_membership_org_id: 99, origin_org_id: 99, email: 'x@notallowed.example', total_count: 2 })
            ]
          });
        }
        if (sql.includes('team_memberships') && sql.includes('role')) {
          return Promise.resolve({ rows: [] }); // getManagedTeamIds
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app).get('/api/users');

      expect(res.status).toBe(200);
      // The out-of-scope row is removed by the predicate pass even though
      // the SQL mock returned it.
      expect(res.body.users.map((u) => u.pk)).toEqual([1]);
    });
  });
});

/**
 * Bugfix: `GET /api/users/count` -- a dedicated, exact, unpaginated count
 * backing the Admin page's "Total Users" stat, replacing the previous read
 * of `GET /api/users`' own `pagination.total` (Authentik's raw
 * `type=internal` count, which over-counted by several classes this
 * route excludes: `is_team_device = false` excludes Team_Owned_Devices,
 * `account_status <> 'orphaned'` excludes a row the Reconciliation_Sweep
 * has already determined no longer has a matching Authentik identity, and
 * the same `isIgnoredAuthentikUsername` predicate `GET /` already applies
 * to its own list excludes a local row for a since-ignored-prefix username
 * that predates the prefix being configured -- so this stat agrees with
 * what `/users` itself lists).
 *
 * This route never calls Authentik at all -- confirmed below -- so it is
 * immune to the over-count `GET /`'s own doc comment documents and
 * deliberately tolerates for ITS OWN purposes.
 */
describe('GET /api/users/count (bugfix: exact Total Users stat)', () => {
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

  it("queries local usernames WHERE is_team_device = false AND account_status <> 'orphaned', then filters ignored-prefix usernames in JS, returning { count }", async () => {
    process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'akadmin,ckadmin';
    pool.query.mockResolvedValue({
      rows: [{ username: 'alice' }, { username: 'bob' }, { username: 'akadmin' }]
    });

    const res = await request(app).get('/api/users/count');

    expect(res.status).toBe(200);
    // akadmin matches the configured ignore-prefix list and is excluded,
    // leaving 2 -- exercising the SAME retroactive-cleanup gap a local row
    // predating the prefix being configured leaves behind (this is the
    // bugfix: a plain SQL COUNT(*) cannot apply this predicate at all).
    expect(res.body).toEqual({ count: 2 });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM users');
    expect(sql).toContain('is_team_device = false');
    expect(sql).toContain("account_status <> 'orphaned'");
  });

  it('counts every row when no ignored-prefix variable is configured', async () => {
    delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    pool.query.mockResolvedValue({
      rows: [{ username: 'alice' }, { username: 'bob' }, { username: 'akadmin' }]
    });

    const res = await request(app).get('/api/users/count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
  });

  it('never calls Authentik -- local-only, so it is immune to GET /\'s own documented over-count', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/users/count');

    expect(authentikService.getUsers).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking the underlying error when the query fails', async () => {
    pool.query.mockRejectedValue(new Error('connection reset'));

    const res = await request(app).get('/api/users/count');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to get user count' });
  });
});

/**
 * Foreign_Partner Organisation country prefix feature: `GET /api/users/me`
 * must surface the caller's Organisation `country_code` (aliased
 * `organisation_country_code`) alongside the pre-existing
 * `organisation_name` -- the Dashboard's "My Country" cell reads it off
 * this response's `teams[0]`. Verified for both an org-member (whose own
 * team IS the Organisation) and a sub-team-member (whose team's ROOT is
 * the Organisation), and confirmed absent (null) for a domestic
 * Organisation.
 */
describe('GET /api/users/me organisation_country_code exposure (Foreign_Partner Organisation country prefix feature)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    User.getChannelMemberships.mockResolvedValue([]);
  });

  it('surfaces organisation_country_code for a member of a Foreign_Partner Organisation', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 5,
        name: 'Central Division',
        parent_team_id: 1,
        visibility: 'public',
        organisation_name: 'Fiji Fire',
        organisation_country_code: 'FJI',
        display_name: 'FIRE - Central Division'
      }]
    });

    const res = await request(app).get('/api/users/me');

    expect(res.status).toBe(200);
    expect(res.body.teams).toHaveLength(1);
    expect(res.body.teams[0].organisation_country_code).toBe('FJI');
    expect(res.body.teams[0].organisation_name).toBe('Fiji Fire');

    // The query selects the aliased column, not the raw one -- proves the
    // SQL change is actually present rather than the test accidentally
    // passing on a stale mock.
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('rt.country_code AS organisation_country_code');
  });

  it('reports organisation_country_code: null for a member of a domestic (New Zealand) Organisation', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 1,
        name: 'FENZ',
        parent_team_id: null,
        visibility: 'public',
        organisation_name: 'FENZ',
        organisation_country_code: null,
        display_name: 'FENZ'
      }]
    });

    const res = await request(app).get('/api/users/me');

    expect(res.status).toBe(200);
    expect(res.body.teams[0].organisation_country_code).toBeNull();
  });

  it('reports an empty teams array (no organisation_country_code to read) for a teamless user', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/users/me');

    expect(res.status).toBe(200);
    expect(res.body.teams).toEqual([]);
  });
});
