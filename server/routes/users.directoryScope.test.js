/**
 * Route-level tests for the Organisation scoping of the Directory_Routes
 * (Requirement 8: Organisation Scoping of the Available Users List;
 * Requirement 12.5: scoping is read-only).
 *
 * This file is structured with clear `describe` blocks because later tasks
 * (9.5, 10.4) add to it. It exercises the actual mounted `server/routes/users.js`
 * router via `supertest`, mocking `pool.query` so every SQL statement the
 * handler issues can be inspected, and mocking
 * `DirectoryScopeService.resolveScope` so the test can drive the scoped and the
 * unscoped (Global_Manager) branch deterministically regardless of the
 * generated caller. The scope object itself is built with the REAL
 * `buildDirectoryScope`, so the value flowing into the route's SQL parameters
 * and its predicate pass is the same shape production produces.
 *
 * `resolveScope` is mocked rather than exercised end to end because Property 9
 * on this route is specifically the "no INSERT/UPDATE/DELETE statement issued
 * while handling the request" half; the row-snapshot half is added against a
 * live database in `users.directoryScope.integration.test.js` (task 10.3).
 * Isolating the assertion to the route handler's own statements keeps it a
 * pure unit-level property over the handler's SQL, independent of how the
 * resolver happens to query.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

// `server/routes/users.js` requires the Authentik service at load time (for
// createUser/setUserPassword on the write routes). None of the GET routes this
// file exercises call it — the list route was migrated to a local-only query
// and no longer fetches from Authentik — but the module is stubbed so the real
// HTTP-client module never loads during these route-level unit tests.
jest.mock('../services/authentik', () => ({
  getUsers: jest.fn(),
}));

// Global_Manager status is decided by the mocked `resolveScope`, so the caller
// injected here only needs a stable `userId`/`id`; the generated `force`
// dimension (Global_Manager vs scoped) is applied to `resolveScope`'s mock, not
// to `req.user`.
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: false };
    next();
  },
  requireTeamAdmin: (req, res, next) => next(),
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

// The scoping half's DB reader. `resolveScope` is spied so each generated run
// can force the scoped or the unscoped branch; `buildScopeResponse` and
// `logScopedResponse` stay real (the former is a pure projection, the latter
// only logs), so the route composes the same response it does in production.
jest.mock('../services/DirectoryScopeService', () => {
  const actual = jest.requireActual('../services/DirectoryScopeService');
  const spied = jest.fn();
  // Preserve every static member (UNSCOPED sentinel, buildScopeResponse,
  // logScopedResponse, TEAM_ROOT_CTE) and override only resolveScope.
  actual.resolveScope = spied;
  return actual;
});

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const DirectoryScopeService = require('../services/DirectoryScopeService');
const { buildDirectoryScope } = require('../utils/directoryScope');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

/**
 * A SQL string is a data-mutating statement iff it contains INSERT, UPDATE, or
 * DELETE as a whole word (case-insensitive). `\b` word boundaries keep this
 * from matching substrings inside identifiers such as `deleted_at` or
 * `updated_by`; the scoping queries touch none of those columns, but the guard
 * is written to be a genuine keyword match rather than a naive substring scan.
 */
const MUTATING_STATEMENT = /\b(INSERT|UPDATE|DELETE)\b/i;

/**
 * Collect the SQL text argument of every `pool.query` call recorded during a
 * request. `pool.query(text, params)` and `pool.query(text)` are both used, so
 * the first argument is always the SQL string.
 */
function issuedStatements() {
  return pool.query.mock.calls.map((call) => call[0]).filter((sql) => typeof sql === 'string');
}

describe('GET /api/users/available Property 9: scoping is read-only', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // Feature: member-visibility-and-callsign-recompute, Property 9: Scoping is read-only
  //
  // For any query parameters and any caller (Global_Manager and
  // non-Global_Manager, with and without a `search` term), NONE of the SQL
  // statements `pool.query` receives while handling a `GET /api/users/available`
  // request is an INSERT, UPDATE, or DELETE. The scoping path is read-only end
  // to end (Requirement 12.5). The row-snapshot half of Property 9 is asserted
  // against a live database in the integration file (task 10.3).
  test.prop(
    [
      // caller kind: true = Global_Manager (UNSCOPED branch), false = scoped.
      fc.boolean(),
      // search query parameter: absent, empty, a plain term, or one carrying
      // characters a naive builder might mishandle.
      fc.option(
        fc.oneof(
          fc.string(),
          fc.constantFrom('', 'smith', "o'brien", 'a%b', 'a_b', '  ', 'josé'),
        ),
        { nil: undefined },
      ),
      // The generated scope's Organisations and their Allowed_Domains, so both
      // the "domains configured" and the fail-closed empty-scope shapes occur.
      fc.array(
        fc.record({
          id: fc.integer({ min: 1, max: 500 }),
          name: fc.string(),
        }),
        { maxLength: 4 },
      ),
      fc.array(fc.domain(), { maxLength: 5 }),
      fc.array(fc.domain(), { maxLength: 3 }),
    ],
    { numRuns: 100 },
  )(
    'issues no INSERT/UPDATE/DELETE for any query parameters and any caller',
    async (isGlobalManager, search, organisations, allowedDomains, excludedDomains) => {
      if (isGlobalManager) {
        DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
      } else {
        DirectoryScopeService.resolveScope.mockResolvedValue(
          buildDirectoryScope({ organisations, allowedDomains, excludedDomains }),
        );
      }

      // Every `pool.query` the handler issues resolves to a benign,
      // non-empty result set so both the main query and the belt-and-braces
      // predicate pass run over real-looking rows; the `excluded_count`
      // projection is present so the non-empty-result branch reads it. The
      // rows are only ever READ by the handler -- the point of the test is
      // that the handler never issues a statement that would WRITE them.
      pool.query.mockResolvedValue({
        rows: [
          {
            id: 'authentik-9',
            email: 'person@example.org',
            first_name: 'Person',
            last_name: 'Example',
            excluded_count: 0,
          },
        ],
      });

      const req = request(app).get('/api/users/available');
      const res = search === undefined ? await req : await req.query({ search });

      // The handler must complete normally: a 500 would mean an exception
      // interrupted statement issuance and the read-only assertion would be
      // vacuously true.
      expect(res.status).toBe(200);

      const statements = issuedStatements();
      for (const sql of statements) {
        expect(sql).not.toMatch(MUTATING_STATEMENT);
      }
    },
  );

  // Feature: member-visibility-and-callsign-recompute, Property 9: Scoping is read-only
  //
  // The empty-result path issues one additional `SELECT COUNT(*)` to recover a
  // genuine excluded count for the log line (design's `/available` query,
  // Requirement 14.3). That extra statement must also be read-only, so the
  // property is re-asserted over a scoped caller whose main query returns no
  // rows -- exercising the branch the non-empty run above cannot reach.
  test.prop(
    [
      fc.option(fc.string(), { nil: undefined }),
      fc.array(
        fc.record({ id: fc.integer({ min: 1, max: 500 }), name: fc.string() }),
        { maxLength: 4 },
      ),
      fc.array(fc.domain(), { maxLength: 5 }),
    ],
    { numRuns: 100 },
  )(
    'issues no INSERT/UPDATE/DELETE on the empty-result count path either',
    async (search, organisations, allowedDomains) => {
      DirectoryScopeService.resolveScope.mockResolvedValue(
        buildDirectoryScope({ organisations, allowedDomains, excludedDomains: [] }),
      );

      // Main query: no rows. Count query: a real count. Both READ-only.
      pool.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ excluded_count: 3 }] });

      const req = request(app).get('/api/users/available');
      const res = search === undefined ? await req : await req.query({ search });

      expect(res.status).toBe(200);

      const statements = issuedStatements();
      // The empty path issues the main query and the count query -- assert both
      // are present so a future refactor that skipped the count still trips the
      // read-only check on whatever it issues instead.
      expect(statements.length).toBeGreaterThanOrEqual(2);
      for (const sql of statements) {
        expect(sql).not.toMatch(MUTATING_STATEMENT);
      }
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Task 9.5 — the `/available` response and log examples
//
// These are example (not property) assertions on the SHAPE of what
// `GET /api/users/available` returns and logs:
//
//   - a non-Global_Manager caller's body carries a `scope` object mirroring the
//     resolved DirectoryScope (`domainsConfigured` + `organisations`, each with
//     `id`/`name`) — Requirements 9.3, 9.4;
//   - a Global_Manager caller's body carries NO `scope` key at all — Requirement
//     9.8;
//   - the logged object carries ids and counts only — its key set is exactly
//     {route, actorId, scopedOrganisationIds, excludedCount, returnedCount,
//     domainsConfigured}, and its serialised form holds no candidate email or
//     name even when the returned rows carry both — Requirement 14.2.
//
// `resolveScope` stays mocked (per the file header); `buildScopeResponse` stays
// real, so the `scope` object asserted here is the one production composes.
// `logScopedResponse` is spied in the log block so the object the route hands it
// can be inspected directly (ids/counts only), independently of the pino sink.
// ────────────────────────────────────────────────────────────────────────────
describe('GET /api/users/available response and log examples (task 9.5)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // Validates: Requirements 9.3, 9.4 — the scope object's shape for a
  // non-Global_Manager caller mirrors the resolved DirectoryScope.
  it('attaches a scope object mirroring the resolved scope for a non-Global_Manager', async () => {
    const organisations = [
      { id: 11, name: 'FENZ' },
      { id: 22, name: 'FENZ - Southland District' },
    ];
    const scope = buildDirectoryScope({
      organisations,
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    // One in-scope row so the non-empty branch reads `excluded_count` from it.
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'authentik-9',
          email: 'person@fireandemergency.nz',
          first_name: 'Person',
          last_name: 'Example',
          excluded_count: 0,
        },
      ],
    });

    const res = await request(app).get('/api/users/available');

    expect(res.status).toBe(200);
    // `domainsConfigured` reflects the surviving allowed set (one domain), and
    // `organisations` carries each Scoped_Organisation's id AND name verbatim.
    expect(res.body.scope).toEqual({
      domainsConfigured: true,
      organisations: [
        { id: 11, name: 'FENZ' },
        { id: 22, name: 'FENZ - Southland District' },
      ],
    });
    // The returned user is the in-scope row, stripped of the internal
    // `excluded_count` projection.
    expect(res.body.users).toEqual([
      {
        id: 'authentik-9',
        email: 'person@fireandemergency.nz',
        first_name: 'Person',
        last_name: 'Example',
      },
    ]);
    expect(res.body.users[0]).not.toHaveProperty('excluded_count');
  });

  // Validates: Requirements 9.3, 9.4 — an unconfigured Organisation's scope
  // object still appears, with `domainsConfigured` of `false`.
  it('attaches a scope object with domainsConfigured:false for an Organisation with no allowed domains', async () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 42, name: 'Southland District' }],
      allowedDomains: [],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    // Empty main query -> the route runs the extra count query for the log line.
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ excluded_count: 7 }] });

    const res = await request(app).get('/api/users/available');

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
    expect(res.body.scope).toEqual({
      domainsConfigured: false,
      organisations: [{ id: 42, name: 'Southland District' }],
    });
  });

  // Validates: Requirement 9.8 — a Global_Manager's body carries NO scope key.
  it('includes no scope key at all for a Global_Manager (UNSCOPED)', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);

    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'authentik-1',
          email: 'anyone@anywhere.example',
          first_name: 'Any',
          last_name: 'One',
        },
      ],
    });

    const res = await request(app).get('/api/users/available');

    expect(res.status).toBe(200);
    // Requirement 9.8: no `scope` key whatsoever, not merely a null/empty one.
    expect(Object.prototype.hasOwnProperty.call(res.body, 'scope')).toBe(false);
    expect(res.body.users).toHaveLength(1);
  });

  // Validates: Requirement 14.2 (with 14.1) — the logged object is ids and
  // counts only, and its serialised form holds no candidate email or name even
  // when the returned rows carry both.
  it('logs an ids-and-counts-only object with no candidate email or name in its serialised form', async () => {
    const scope = buildDirectoryScope({
      organisations: [
        { id: 11, name: 'FENZ' },
        { id: 22, name: 'FENZ - Southland District' },
      ],
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    // The returned rows deliberately carry a real-looking email, first name,
    // and last name, so a log line that leaked any of them would be caught by
    // the serialisation assertion below.
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 'authentik-9',
          email: 'chris.smith@fireandemergency.nz',
          first_name: 'Chris',
          last_name: 'Smith',
          excluded_count: 4,
        },
      ],
    });

    // Spy on the real `logScopedResponse` (kept real by the module mock) so the
    // object the route hands it can be inspected directly, independent of the
    // pino sink.
    const logSpy = jest.spyOn(DirectoryScopeService, 'logScopedResponse');

    const res = await request(app).get('/api/users/available');
    expect(res.status).toBe(200);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [route, info] = logSpy.mock.calls[0];
    expect(route).toBe('GET /api/users/available');

    // The route hands `logScopedResponse` the actor id, the scope, and the two
    // counts. The scope object itself carries names, which the function reduces
    // to ids — so this is the pre-reduction argument set.
    expect(Object.keys(info).sort()).toEqual(
      ['excludedCount', 'returnedCount', 'scope', 'userId'].sort(),
    );
    expect(info.userId).toBe(1);
    expect(info.excludedCount).toBe(4);
    expect(info.returnedCount).toBe(1);

    // The emitted log line itself (what `getLogger().info` received via the
    // real `logScopedResponse`) is ids and counts only: assert its key set and
    // that its serialised form holds no candidate email or name. `getLogger()`
    // returns the shared pino instance outside a request context; spy on its
    // `info` through a fresh call to keep this independent of the sink used
    // above. Re-run `logScopedResponse` with the same arguments and capture the
    // payload directly, since the real function is deterministic.
    logSpy.mockRestore();
    const requestContext = require('../middleware/requestContext');
    const infoSpy = jest.spyOn(requestContext.getLogger(), 'info').mockImplementation(() => {});
    DirectoryScopeService.logScopedResponse(route, info);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [payload] = infoSpy.mock.calls[0];
    expect(Object.keys(payload).sort()).toEqual(
      [
        'actorId',
        'domainsConfigured',
        'excludedCount',
        'returnedCount',
        'route',
        'scopedOrganisationIds',
      ].sort(),
    );

    const serialised = JSON.stringify(payload);
    // No candidate email or name, even though the returned row carried both.
    expect(serialised).not.toContain('chris.smith@fireandemergency.nz');
    expect(serialised).not.toContain('Chris');
    expect(serialised).not.toContain('Smith');
    expect(serialised).not.toContain('@');
    // The organisation names carried on the scope are reduced to ids too.
    expect(serialised).not.toContain('FENZ');
    expect(serialised).not.toContain('Southland');
    // Ids and counts survive.
    expect(payload.scopedOrganisationIds).toEqual([11, 22]);
    expect(payload.actorId).toBe(1);

    infoSpy.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Task 10.4 — the `/search` and `/users` examples
//
// Example (not property) assertions on the shape of what
// `GET /api/users` and `GET /api/users/search` return under scoping. These
// complement the live-Postgres Requirement 15.10 assertions in
// users.directoryScope.integration.test.js: here the mocked pool/authentik let
// each behaviour be exercised deterministically without a database.
//
//   - GET /api/users (scoped caller): `pagination.total` is the EXACT LOCAL
//     post-filter/post-scope count carried on each row as `total_count`, NOT
//     an Authentik `count` (this route was migrated off the live Authentik
//     fetch to the local `users`/`user_cache` query) — Requirement 11.4; the
//     Team_Owned_Device exclusion (`is_team_device = false`) is now a SQL
//     predicate in the list query rather than a JS filter over an Authentik
//     page — Requirement 11.5; the scope disjunction (isUnscoped/orgIds/
//     domain-LIKE patterns) is passed as query parameters so scoping,
//     pagination and the exact total all run in SQL — Requirements 13.x.
//   - GET /api/users/search (scoped caller): the `{ users }` shape carries no
//     `scope` object — Requirement 10.3; the scoped SQL is issued (a
//     `candidates` CTE carrying the `in_scope` expression) and the returned
//     rows are stripped of the internal `excluded_count` /
//     `direct_membership_org_id` projections.
//
// `pool.query` is mocked so the local list query and the `/search` scoped SQL
// can be driven and inspected. `resolveScope` stays mocked (per the file
// header) so the scoped branch is entered deterministically, and
// `buildDirectoryScope` builds the real scope object flowing into the handler.
// The list route no longer calls `authentikService.getUsers` at all — the
// row source is the single local list query alone.
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/users scoped-caller examples (task 10.4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // Builds one `base`-shaped list-query row. The handler reads `total_count`
  // off the first row for `pagination.total`, echoes `pk` (the Authentik id),
  // and needs `origin_org_id`/`direct_membership_org_id`/`email` for the
  // belt-and-braces predicate pass over a scoped caller's page.
  function makeRow(overrides = {}) {
    return {
      pk: 'authentik-1',
      local_user_id: 1,
      username: 'user1',
      email: 'user1@fireandemergency.nz',
      first_name: 'User',
      last_name: 'One',
      is_active: true,
      tak_role: null,
      callsign_suffix: null,
      account_status: 'active',
      origin_org_id: 7,
      tak_callsign: null,
      tak_color: null,
      team_id: null,
      direct_membership_org_id: 7,
      team_name: null,
      live_certificate_count: 0,
      total_count: 1,
      ...overrides,
    };
  }

  // Validates: Requirement 11.4 — `pagination.total` is the EXACT local
  // post-filter/post-scope count the list query computes (`total_count`), not
  // an Authentik directory `count`. The migration to a local row source made
  // the total exact (the old Authentik `count` over-counted ignored-prefix and
  // device rows the list then dropped), which is what this now asserts.
  it('reports pagination.total from the exact local total_count for a scoped caller', async () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 7, name: 'FENZ' }],
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    // The list query returns this page's rows, each carrying the SAME exact
    // total the `counted` CTE computed over the whole filtered/scoped set —
    // here 137, larger than the two rows on this page.
    pool.query.mockResolvedValue({
      rows: [
        makeRow({ pk: 'ak-1', local_user_id: 1, email: 'a@fireandemergency.nz', total_count: 137 }),
        makeRow({ pk: 'ak-2', local_user_id: 2, email: 'b@fireandemergency.nz', total_count: 137 }),
      ],
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    // Requirement 11.4: the exact local total, read off the row's total_count.
    expect(res.body.pagination.total).toBe(137);
    expect(res.body.users.map((u) => u.pk)).toEqual(['ak-1', 'ak-2']);
    // No `scope` object on this route (Requirement 10.3 — scope is /available only).
    expect(Object.prototype.hasOwnProperty.call(res.body, 'scope')).toBe(false);
  });

  // Validates: Requirement 11.5 — the Team_Owned_Device exclusion is a SQL
  // predicate (`u.is_team_device = false`) in the list query, applied BEFORE
  // the page and the total are derived, so a device row can never reach the
  // response. Asserting the predicate is present in the issued SQL proves the
  // exclusion moved into the query (rather than a JS filter over an Authentik
  // page, which is what the pre-migration implementation did).
  it('retains the Team_Owned_Device exclusion as a SQL predicate on the list query', async () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 7, name: 'FENZ' }],
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    pool.query.mockResolvedValue({ rows: [makeRow()] });

    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);

    const listSql = pool.query.mock.calls.map((c) => c[0]).find((sql) => /FROM users u/i.test(sql));
    expect(listSql).toBeDefined();
    // The device exclusion and the orphaned exclusion are both SQL predicates.
    expect(listSql).toMatch(/u\.is_team_device\s*=\s*false/i);
    expect(listSql).toMatch(/u\.account_status\s*<>\s*'orphaned'/i);
  });

  // Validates: Requirements 13.x — for a scoped caller the scope disjunction
  // is pushed into the list query as parameters: `isUnscoped=false`, the
  // Scoped_Organisation id array, and the Allowed_Domain LIKE patterns, so
  // scoping (and therefore the exact total and pagination) run in SQL. This
  // replaces the pre-migration "candidate with no local users row is scoped by
  // email domain alone" example: post-migration EVERY listed row IS a local
  // `users` row, so that no-local-row case cannot occur — the meaningful
  // assertion is that the scope predicate reaches the SQL.
  it('passes the scope disjunction (isUnscoped/orgIds/domain patterns) to the list query for a scoped caller', async () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 7, name: 'FENZ' }],
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    pool.query.mockResolvedValue({ rows: [makeRow()] });

    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);

    const listCall = pool.query.mock.calls.find(([sql]) => /FROM users u/i.test(sql));
    expect(listCall).toBeDefined();
    const params = listCall[1];
    // Param order: $1 searchPattern, $2 ignoredPrefixPatterns, $3 isUnscoped,
    // $4 scopeOrgIds int[], $5 scopeDomainPatterns text[], $6 pageSize, $7 offset.
    expect(params[2]).toBe(false); // scoped caller -> isUnscoped false
    expect(params[3]).toEqual([7]); // the Scoped_Organisation ids
    // The Allowed_Domain LIKE patterns are non-empty and match on the domain
    // after the final `@` (built by buildEmailDomainLikePatterns).
    expect(Array.isArray(params[4])).toBe(true);
    expect(params[4].length).toBeGreaterThan(0);
    expect(params[4].some((p) => /fireandemergency\.nz/i.test(p))).toBe(true);
  });
});

describe('GET /api/users/search scoped-caller examples (task 10.4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // Validates: Requirement 10.3 — the `/search` response is the existing
  // `{ users }` shape with NO `scope` object, and its rows are stripped of the
  // internal `excluded_count` / `direct_membership_org_id` projections. Also
  // asserts the scoped SQL is issued (a `candidates` CTE carrying `in_scope`).
  it('returns { users } with no scope object and strips internal projections', async () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 7, name: 'FENZ' }],
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    // The scoped query returns rows carrying the internal projections the
    // handler must strip before responding.
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 501,
          username: 'chris',
          email: 'chris@fireandemergency.nz',
          first_name: 'Chris',
          last_name: 'Smith',
          direct_membership_org_id: 7,
          excluded_count: 2,
        },
      ],
    });

    const res = await request(app).get('/api/users/search').query({ q: 'chris' });

    expect(res.status).toBe(200);
    // No `scope` key on /search (Requirement 10.3 — scope is /available only).
    expect(Object.prototype.hasOwnProperty.call(res.body, 'scope')).toBe(false);
    // The returned row is stripped of the internal projections.
    expect(res.body.users).toEqual([
      {
        id: 501,
        username: 'chris',
        email: 'chris@fireandemergency.nz',
        first_name: 'Chris',
        last_name: 'Smith',
      },
    ]);
    expect(res.body.users[0]).not.toHaveProperty('excluded_count');
    expect(res.body.users[0]).not.toHaveProperty('direct_membership_org_id');

    // The scoped SQL was issued: a `candidates` CTE carrying the `in_scope`
    // expression (proving the pre-narrowing runs, not the unscoped branch).
    const scopedSql = pool.query.mock.calls.map((c) => c[0]).find((sql) => /candidates AS/i.test(sql));
    expect(scopedSql).toBeDefined();
    expect(scopedSql).toMatch(/in_scope/);
  });

  // Validates: Requirement 10.3 with partitionCandidates — the belt-and-braces
  // predicate pass is applied over the SQL-admitted rows, so a row the SQL
  // returned that the predicate rejects (an out-of-scope domain, no membership)
  // never reaches the response even if the SQL and predicate drift.
  it('applies the predicate over the SQL-admitted rows', async () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 7, name: 'FENZ' }],
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    // The SQL (hypothetically) admitted an out-of-scope row alongside an
    // in-scope one; the predicate pass must drop the out-of-scope row.
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 1,
          username: 'in',
          email: 'in@fireandemergency.nz',
          first_name: 'In',
          last_name: 'Scope',
          direct_membership_org_id: null,
          excluded_count: 0,
        },
        {
          id: 2,
          username: 'out',
          email: 'out@elsewhere.example',
          first_name: 'Out',
          last_name: 'Scope',
          direct_membership_org_id: null,
          excluded_count: 0,
        },
      ],
    });

    const res = await request(app).get('/api/users/search').query({ q: 'scope' });

    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.email)).toEqual(['in@fireandemergency.nz']);
  });
});
