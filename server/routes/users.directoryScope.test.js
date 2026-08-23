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
//   - GET /api/users (scoped caller): `pagination.total` still equals the
//     Authentik `count` (unadjusted by scoping) — Requirement 11.4; the
//     Team_Owned_Device exclusion (`is_team_device`) is retained, so a device
//     row is dropped from the response — Requirement 11.5; a candidate with NO
//     local `users` row (absent from the batched facts map) is scoped by email
//     domain alone, since it carries null org fields — Requirement 13.7.
//   - GET /api/users/search (scoped caller): the `{ users }` shape carries no
//     `scope` object — Requirement 10.3; the scoped SQL is issued (a
//     `candidates` CTE carrying the `in_scope` expression) and the returned
//     rows are stripped of the internal `excluded_count` /
//     `direct_membership_org_id` projections.
//
// `authentikService.getUsers` is the mocked module already declared at the top
// of this file; `pool.query` is mocked so the batched local query and the
// scoped SQL can be driven and inspected. `resolveScope` stays mocked (per the
// file header) so the scoped branch is entered deterministically, and
// `buildDirectoryScope` builds the real scope object flowing into the handler.
// ════════════════════════════════════════════════════════════════════════════
const authentikService = require('../services/authentik');

describe('GET /api/users scoped-caller examples (task 10.4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // Validates: Requirement 11.4 — `pagination.total` continues to derive from
  // the Authentik `count` and is NOT adjusted downward by the scoping, even
  // when the scoping excludes users from the returned page.
  it('keeps pagination.total equal to the Authentik count for a scoped caller', async () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 7, name: 'FENZ' }],
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    // The Authentik page holds three users but reports a much larger total
    // `count` (the whole directory). One user is in scope by domain; the other
    // two are out of scope, so the scoping excludes two of the three on this
    // page — yet `pagination.total` must still reflect Authentik's own count.
    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 'ak-1', email: 'in.scope@fireandemergency.nz', first_name: 'In', last_name: 'Scope' },
        { pk: 'ak-2', email: 'out@elsewhere.example', first_name: 'Out', last_name: 'One' },
        { pk: 'ak-3', email: 'out2@another.example', first_name: 'Out', last_name: 'Two' },
      ],
      count: 4217,
    });

    // No local `users` row for any of these three, so the batched query returns
    // no rows and every candidate carries null org fields (domain-only scoping).
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    // Requirement 11.4: total is the Authentik count, untouched by scoping.
    expect(res.body.pagination.total).toBe(4217);
    // Only the in-scope user survives the predicate.
    expect(res.body.users.map((u) => u.email)).toEqual(['in.scope@fireandemergency.nz']);
    // No `scope` object on this route (Requirement 10.3 — scope is /available only).
    expect(Object.prototype.hasOwnProperty.call(res.body, 'scope')).toBe(false);
  });

  // Validates: Requirement 11.5 — a user whose local `users` row holds
  // `is_team_device = true` is dropped BEFORE the scoping predicate, so a
  // device row never appears even when its email domain is in scope.
  it('retains the Team_Owned_Device exclusion: a device row is dropped even at an in-scope domain', async () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 7, name: 'FENZ' }],
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 'ak-human', email: 'human@fireandemergency.nz', first_name: 'Human', last_name: 'Person' },
        { pk: 'ak-device', email: 'device@fireandemergency.nz', first_name: 'Team', last_name: 'Device' },
      ],
      count: 2,
    });

    // The batched local query flags `ak-device` as a Team_Owned_Device. Both
    // rows sit at the in-scope domain, so only the device filter distinguishes
    // them — proving the device exclusion is retained under scoping.
    pool.query.mockResolvedValue({
      rows: [
        { authentik_user_id: 'ak-human', is_team_device: false, direct_membership_org_id: null, team_name: null },
        { authentik_user_id: 'ak-device', is_team_device: true, direct_membership_org_id: null, team_name: null },
      ],
    });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const returnedIds = res.body.users.map((u) => u.pk);
    // The device row is excluded (Requirement 11.5); the human at the same
    // in-scope domain is included.
    expect(returnedIds).toContain('ak-human');
    expect(returnedIds).not.toContain('ak-device');
  });

  // Validates: Requirement 13.7 — a candidate with NO local `users` row is
  // absent from the batched facts map, so it carries null `originOrgId` and
  // null `directMembershipOrgId`; only the Email_Domain condition can admit or
  // exclude it. Here two such candidates differ only by domain: the in-scope
  // one is included, the out-of-scope one is excluded, on domain alone.
  it('scopes a candidate with no local users row by email domain alone', async () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 7, name: 'FENZ' }],
      allowedDomains: ['fireandemergency.nz'],
      excludedDomains: [],
    });
    DirectoryScopeService.resolveScope.mockResolvedValue(scope);

    authentikService.getUsers.mockResolvedValue({
      results: [
        { pk: 'ak-nolocal-in', email: 'ghost@fireandemergency.nz', first_name: 'Ghost', last_name: 'InScope' },
        { pk: 'ak-nolocal-out', email: 'ghost@elsewhere.example', first_name: 'Ghost', last_name: 'OutScope' },
      ],
      count: 2,
    });

    // The batched query returns NO rows — neither candidate has a local `users`
    // row — so both are absent from the facts map and scored on domain alone.
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/users');

    expect(res.status).toBe(200);
    const returnedIds = res.body.users.map((u) => u.pk);
    expect(returnedIds).toContain('ak-nolocal-in');
    expect(returnedIds).not.toContain('ak-nolocal-out');
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
