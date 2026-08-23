/**
 * Real-Postgres integration tests for the Organisation scoping of
 * `GET /api/users/available` (task 9.5; Requirement 8: Organisation Scoping of
 * the Available Users List; Requirement 9: Fail-Closed Behaviour; Requirement
 * 15.9 and 15.11; and the row-snapshot half of Property 9, Requirement 12.5).
 *
 * `server/routes/users.directoryScope.test.js` already exists but mocks `pool`
 * and `DirectoryScopeService.resolveScope` entirely — every assertion there is
 * about SQL text/params handed to a mocked pool, never about a real, persisted
 * `user_cache`/`users`/`org_allowed_domains` row flowing through the REAL
 * recursive-CTE resolver, the REAL `LIKE ANY(...)` scope predicate, and the
 * REAL Excluded_Domains subtraction. This file closes that gap by exercising
 * the mounted `server/routes/users.js` router (whose `/available` handler
 * delegates to the real `DirectoryScopeService`) against a real Postgres
 * database via `supertest`, following the exact connection convention already
 * established by `server/routes/requests.approval.integration.test.js`.
 *
 * Mocking `pool` here would mock away the entire subject: the whole point is to
 * prove that `resolveScope`'s recursive CTE finds the caller's Organisation
 * root, that `org_allowed_domains` rows drive the `LIKE ANY` scope predicate,
 * that the global `excluded_email_domains` config subtracts a domain even when
 * it is also an Allowed_Domain, and that the handler writes nothing.
 *
 * `authenticateToken` is mocked (bypassing real JWT/cookie handling, per the
 * same convention as the other integration suites); `authorize` is mocked to a
 * pass-through, because this specification narrows response CONTENTS, not
 * callers — the Permission_Registry entry for these routes is unchanged and is
 * asserted elsewhere (`server/config/permissions.registry.test.js`). The mocked
 * actor is a real, persisted `users` row that holds a real Team_Admin
 * `team_memberships` row on the seeded Organisation root, so the real
 * `resolveScope` Q1 CTE resolves a genuine Scoped_Organisation.
 *
 * `system_config.excluded_email_domains` is a SHARED, seeded global row. The
 * Requirement 15.11 case rewrites its `config_value` and restores the original
 * in a `finally`, so the suite leaves the shared config exactly as it found it.
 *
 * Connection convention: `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`
 * are read from the environment if already set, otherwise defaulted to the
 * local Docker-based test container (`tak_migration_test_501`, Postgres 15,
 * host port 15433, database `tak_team_manager`, user `postgres`, password
 * `postgres123`). These are set on `process.env` BEFORE `../config/database`
 * (required transitively by `./users`) is first required, and are restored in
 * `afterAll`.
 */

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_NAME = process.env.DB_NAME || 'tak_team_manager';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';

// The mocked actor. `resolveScope` reads `userId` (for its Q1 CTE) and
// `is_global_manager` (for the UNSCOPED short-circuit) off this object, exactly
// as production reads `req.user`. It is reassigned per test in `beforeEach`.
let mockUser = { id: 1, userId: 1, is_global_manager: false };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  },
  requireTeamAdmin: (req, res, next) => next(),
}));

// authorize is a pass-through: this spec narrows response contents, not
// callers. The three Directory_Routes keep `user:read:team_admin` unchanged.
jest.mock('../middleware/authorize', () => (req, res, next) => next());

// Authentik is only touched by `GET /api/users`; `/available` reads user_cache
// directly, so the module is stubbed to keep the router import side-effect-free.
jest.mock('../services/authentik', () => ({
  getUsers: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

const pool = require('../config/database');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

describe('GET /api/users/available Organisation scoping against a real Postgres database (task 9.5)', () => {
  let app;
  let adminActor;
  let orgTeam;
  const createdUserIds = [];
  const createdUserCacheIds = [];
  const createdTeamIds = [];
  const createdDomainOrgIds = [];

  // A domain unique to this run, so the seeded candidates never collide with
  // anything else in the shared test database and the Allowed_Domain match is
  // unambiguous. Kept short and lowercase because the predicate lowercases.
  const runTag = crypto.randomUUID().slice(0, 8);
  const allowedDomain = `scope-${runTag}.example`;
  const otherDomain = `other-${runTag}.example`;

  beforeAll(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This integration test (task 9.5) requires a ` +
          `real, running, already-migrated Postgres instance — it deliberately does not ` +
          `mock "../config/database", since the whole point is to prove real Organisation ` +
          `scoping of GET /api/users/available against real, persisted user_cache / users / ` +
          `org_allowed_domains rows. Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    // The Organisation (root team) the caller administers.
    const orgResult = await pool.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING *`,
      [`Scope Org ${crypto.randomUUID()}`, null]
    );
    orgTeam = orgResult.rows[0];
    createdTeamIds.push(orgTeam.id);

    // The Team_Admin caller: a real users row holding a real direct admin
    // membership on the Organisation root, so the real `resolveScope` Q1 CTE
    // resolves this Organisation as the caller's single Scoped_Organisation.
    const adminUsername = `scope-admin-${crypto.randomUUID()}`;
    const adminResult = await pool.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING *`,
      [adminUsername, `${adminUsername}@${allowedDomain}`]
    );
    adminActor = adminResult.rows[0];
    createdUserIds.push(adminActor.id);

    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id)
         VALUES ($1, $2, 'admin', NULL)`,
      [orgTeam.id, adminActor.id]
    );
  });

  beforeEach(() => {
    app = buildApp();
    mockUser = { id: adminActor.id, userId: adminActor.id, is_global_manager: false };
  });

  /**
   * Seed one teamless, active `user_cache` candidate at a given domain, with
   * NO corresponding local `users` row — the exact shape the reported defect
   * leaked (`WHERE tm.user_id IS NULL` is satisfied because there is no `users`
   * row at all). Returns the created cache id.
   */
  async function seedCandidate({ domain, firstName = 'Cand', lastName = 'Idate', isActive = true }) {
    const authentikId = `scope-cache-${crypto.randomUUID()}`;
    const username = `scope-cand-${crypto.randomUUID()}`;
    const result = await pool.query(
      `INSERT INTO user_cache (authentik_id, username, email, first_name, last_name, is_active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [authentikId, username, `${username}@${domain}`, firstName, lastName, isActive]
    );
    createdUserCacheIds.push(result.rows[0].id);
    return { id: result.rows[0].id, email: `${username}@${domain}` };
  }

  async function addAllowedDomain(orgId, domain) {
    await pool.query(
      `INSERT INTO org_allowed_domains (org_id, domain) VALUES ($1, $2)
         ON CONFLICT (org_id, domain) DO NOTHING`,
      [orgId, domain]
    );
    if (!createdDomainOrgIds.includes(orgId)) {
      createdDomainOrgIds.push(orgId);
    }
  }

  /**
   * Suite teardown, FK-safe. `team_memberships` and `org_allowed_domains`
   * cascade off `teams`, but the candidate `user_cache` rows and the admin
   * `users` row are removed explicitly. The Organisation root team is deleted
   * last.
   */
  afterAll(async () => {
    if (createdUserCacheIds.length > 0) {
      await pool.query('DELETE FROM user_cache WHERE id = ANY($1)', [createdUserCacheIds]);
    }
    if (createdDomainOrgIds.length > 0) {
      await pool.query('DELETE FROM org_allowed_domains WHERE org_id = ANY($1)', [createdDomainOrgIds]);
    }
    if (createdUserIds.length > 0) {
      await pool.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [createdUserIds]);
      await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
    }
    if (createdTeamIds.length > 0) {
      for (const teamId of [...createdTeamIds].reverse()) {
        await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    }

    await pool.end();

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Requirement 15.9 — the two-assertion before/after over org_allowed_domains
  // ──────────────────────────────────────────────────────────────────────────
  it('Req 15.9: returns empty users and scope.domainsConfigured=false with no allowed-domain row, then the matching users and true once a row exists', async () => {
    // Seed one candidate at the domain that WILL become allowed, plus one at an
    // unrelated domain that must never appear.
    const cand = await seedCandidate({ domain: allowedDomain });
    await seedCandidate({ domain: otherDomain });

    // BEFORE: the Organisation holds no org_allowed_domains row, so the scope
    // is empty and fails closed.
    const before = await request(app).get('/api/users/available');
    expect(before.status).toBe(200);
    expect(before.body.users).toEqual([]);
    expect(before.body.scope).toBeDefined();
    expect(before.body.scope.domainsConfigured).toBe(false);
    expect(before.body.scope.organisations).toEqual([{ id: orgTeam.id, name: orgTeam.name }]);

    // AFTER: insert a matching allowed-domain row. Now the candidate at that
    // domain appears and domainsConfigured flips to true.
    await addAllowedDomain(orgTeam.id, allowedDomain);

    const after = await request(app).get('/api/users/available');
    expect(after.status).toBe(200);
    expect(after.body.scope.domainsConfigured).toBe(true);

    const returnedEmails = after.body.users.map((u) => u.email);
    expect(returnedEmails).toContain(cand.email);
    // The candidate at the unrelated domain is still excluded.
    expect(returnedEmails.every((email) => email.endsWith(`@${allowedDomain}`))).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Requirement 15.11 — an Allowed_Domain that is also Excluded grants nothing
  // ──────────────────────────────────────────────────────────────────────────
  it('Req 15.11: a domain that is both an Allowed_Domain and in excluded_email_domains still excludes its users', async () => {
    // The candidate lives at a domain we will list BOTH as an Allowed_Domain
    // for the caller's Organisation AND in the global excluded_email_domains.
    const excludedButAllowed = `dual-${runTag}.example`;
    const cand = await seedCandidate({ domain: excludedButAllowed });
    await addAllowedDomain(orgTeam.id, excludedButAllowed);

    // Read and preserve the shared global config row so it is restored exactly.
    const existing = await pool.query(
      `SELECT config_value FROM system_config WHERE config_key = 'excluded_email_domains'`
    );
    const originalValue = existing.rows.length > 0 ? existing.rows[0].config_value : null;

    try {
      const excludedList = (() => {
        try {
          const parsed = JSON.parse(originalValue);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
      excludedList.push(excludedButAllowed);

      await pool.query(
        `INSERT INTO system_config (config_key, config_value)
           VALUES ('excluded_email_domains', $1)
         ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value`,
        [JSON.stringify(excludedList)]
      );

      const res = await request(app).get('/api/users/available');
      expect(res.status).toBe(200);

      // The Excluded_Domain subtracts the Allowed_Domain, so no user at that
      // domain — including the seeded candidate — is visible.
      const returnedEmails = res.body.users.map((u) => u.email);
      expect(returnedEmails).not.toContain(cand.email);
    } finally {
      // Restore the shared global config exactly as it was found.
      if (originalValue === null) {
        await pool.query(
          `DELETE FROM system_config WHERE config_key = 'excluded_email_domains'`
        );
      } else {
        await pool.query(
          `UPDATE system_config SET config_value = $1 WHERE config_key = 'excluded_email_domains'`,
          [originalValue]
        );
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Retained existing filters — only teamless, active, non-empty email/first
  // name candidates appear (in addition to the scoping).
  // ──────────────────────────────────────────────────────────────────────────
  it('retains the existing filters: an inactive candidate at an allowed domain is excluded', async () => {
    await addAllowedDomain(orgTeam.id, allowedDomain);

    const active = await seedCandidate({ domain: allowedDomain, firstName: 'Active' });
    const inactive = await seedCandidate({ domain: allowedDomain, firstName: 'Inactive', isActive: false });

    const res = await request(app).get('/api/users/available');
    expect(res.status).toBe(200);

    const returnedEmails = res.body.users.map((u) => u.email);
    // The active in-scope candidate appears; the inactive one is filtered by
    // the retained `uc.is_active = true` clause even though its domain matches.
    expect(returnedEmails).toContain(active.email);
    expect(returnedEmails).not.toContain(inactive.email);
    // Every returned row carries a non-empty email and first name (the retained
    // `email != ''` / `first_name != ''` clauses).
    for (const user of res.body.users) {
      expect(typeof user.email).toBe('string');
      expect(user.email.length).toBeGreaterThan(0);
      expect(typeof user.first_name).toBe('string');
      expect(user.first_name.length).toBeGreaterThan(0);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Requirement 8.9 — the search filter applies IN ADDITION to the scoping.
  // ──────────────────────────────────────────────────────────────────────────
  it('Req 8.9: the search term composes with the scoping rather than replacing it', async () => {
    await addAllowedDomain(orgTeam.id, allowedDomain);

    const uniqueFirst = `Zeta${runTag}`;
    const matching = await seedCandidate({ domain: allowedDomain, firstName: uniqueFirst });
    // A second in-scope candidate whose name does NOT match the search term.
    const nonMatching = await seedCandidate({ domain: allowedDomain, firstName: 'Alpha' });

    const res = await request(app).get('/api/users/available').query({ search: uniqueFirst });
    expect(res.status).toBe(200);

    const returnedEmails = res.body.users.map((u) => u.email);
    // The search narrows to the matching name...
    expect(returnedEmails).toContain(matching.email);
    expect(returnedEmails).not.toContain(nonMatching.email);
    // ...and every returned row is still in scope (allowed domain), proving the
    // search was applied on top of the scoping, not instead of it.
    expect(returnedEmails.every((email) => email.endsWith(`@${allowedDomain}`))).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Property 9 (row-snapshot half) — scoping is read-only (Requirement 12.5).
  // The route-level "no INSERT/UPDATE/DELETE statement" half is asserted in
  // users.directoryScope.test.js; this half snapshots the three tables the
  // scoping reads and proves the GET leaves every row unchanged.
  // ──────────────────────────────────────────────────────────────────────────
  // Feature: member-visibility-and-callsign-recompute, Property 9: Scoping is read-only
  it('Property 9 (row-snapshot half): a GET leaves users, user_cache and org_allowed_domains unchanged', async () => {
    await addAllowedDomain(orgTeam.id, allowedDomain);
    await seedCandidate({ domain: allowedDomain });
    await seedCandidate({ domain: otherDomain });

    const snapshot = async () => {
      const users = await pool.query(
        'SELECT id, authentik_user_id, username, email, first_name, last_name, is_global_manager, is_active FROM users ORDER BY id'
      );
      const userCache = await pool.query(
        'SELECT id, authentik_id, username, email, first_name, last_name, is_active FROM user_cache ORDER BY id'
      );
      const domains = await pool.query(
        'SELECT id, org_id, domain FROM org_allowed_domains ORDER BY id'
      );
      return { users: users.rows, userCache: userCache.rows, domains: domains.rows };
    };

    const before = await snapshot();

    // A scoped request AND an unscoped (Global_Manager) request, so both
    // branches of the handler are proven read-only against real rows.
    const scopedRes = await request(app).get('/api/users/available');
    expect(scopedRes.status).toBe(200);

    mockUser = { id: adminActor.id, userId: adminActor.id, is_global_manager: true };
    const unscopedRes = await request(app).get('/api/users/available');
    expect(unscopedRes.status).toBe(200);

    const after = await snapshot();

    expect(after.users).toEqual(before.users);
    expect(after.userCache).toEqual(before.userCache);
    expect(after.domains).toEqual(before.domains);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Property 10 — the SQL pre-narrowing and the JavaScript predicate admit the
// same candidates (task 10.3; design "Property 10: The SQL pre-narrowing and
// the predicate admit the same candidates"; Requirement 11.3).
//
// APPENDED as a wholly NEW describe block per task 10.3; the existing
// task-9.5 block above is left untouched. Property 10 is a live-Postgres
// property test because it compares SQL semantics — `LIKE ANY(...)` over the
// escaped `%@domain` patterns `buildEmailDomainLikePatterns` produces, `= ANY`
// over an int array, Postgres three-valued logic wrapped in `COALESCE(...,
// false)`, and a window-function count — against the JavaScript predicate
// `isCandidateVisible`. Mocking `pool` would mock away the entire subject: the
// point is that the SQL clause and the predicate never diverge over REAL rows.
//
// The task's brief names "the three routes", but `GET /api/users` has no SQL
// narrowing — its page comes from Authentik and the predicate does all the
// filtering (design section 5) — so its "SQL pre-narrowing" is trivially the
// whole page and there is no `in_scope` SQL expression to compare. Property 10
// therefore exercises the two routes that DO carry an `in_scope` SQL clause:
// `GET /api/users/available` (email-domain LIKE term only; candidates are
// teamless `user_cache` rows) and `GET /api/users/search` (email-domain LIKE
// term OR the Direct_Membership `root.root_id = ANY(...)` term; candidates are
// active `users` rows).
//
// STRATEGY, per run:
//   1. Seed a two-Organisation hierarchy (each an Organisation root team, and
//      orgA additionally holds a nested Sub_Team so `/search`'s Direct_
//      Membership condition traverses a real Ancestor_Chain to its root), a
//      Team_Admin caller holding a direct admin membership on orgA's root
//      (so the REAL `resolveScope` Q1 recursive CTE resolves {orgA}), a
//      generated set of `org_allowed_domains` rows on orgA, and a generated
//      slice of the global `excluded_email_domains` config.
//   2. Seed a generated set of candidates that all PASS each route's base
//      filters (active; non-empty email/first name; teamless for `/available`;
//      for `/search`, a `users` row optionally holding a direct membership on
//      orgA's nested team, orgB, or nowhere), at domains drawn from the allowed
//      set, the excluded set, a shared/overlapping domain, and unrelated
//      domains — so both the LIKE match and the miss are exercised. Each
//      candidate also carries a generated `users.origin_org_id` provenance
//      (orgA / orgB / none), varied independently of its domain and membership,
//      so the additive `origin_org_id` disjunct (Requirements 13.6, 13.8) is
//      exercised end-to-end against live Postgres alongside the domain and
//      membership conditions. The count
//      is kept well under each route's LIMIT (50 / 20) so the LIMIT never
//      truncates the in-scope set and the returned set is exactly the
//      SQL-admitted set.
//   3. Resolve the REAL scope via `DirectoryScopeService.resolveScope(caller)`,
//      and compute the predicate-admitted set in JS by running the pure
//      `isCandidateVisible(scope, facts)` over every seeded candidate's facts.
//   4. Run the route. Because the belt-and-braces predicate pass in the handler
//      makes the response a subset of the predicate, and the SQL `in_scope`
//      makes it a subset of the SQL set, the returned set equals SQL ∩
//      predicate. Assert the returned candidate set EQUALS the JS-predicate set
//      (restricted to the base-filter-passing candidates seeded), which — the
//      two being equal — is the SQL-admitted set too. Divergence surfaces as a
//      failing test rather than a silent disclosure hole.
//
// numRuns is modest (30): each run seeds and tears down real rows across five
// tables and issues real route requests, so a pure-property count of 100 is
// impractical here. `OrgInterestService.test.js`'s live-DB property tests use
// numRuns 20-30 for the same reason; 30 matches that precedent while still
// covering the domain/provenance/membership combinations broadly. Every run
// cleans up all rows it seeded (FK-safe order) so runs never interfere.
// ════════════════════════════════════════════════════════════════════════════

const fc = require('fast-check');
const { test: fcTest } = require('@fast-check/jest');

describe('Property 10: the SQL pre-narrowing and the predicate admit the same candidates (task 10.3, live Postgres)', () => {
  // A fully ISOLATED module graph for this block: its own `pool` instance and
  // its own `users` router bound to that pool, plus the real (un-mocked)
  // `DirectoryScopeService` and pure predicate. The task-9.5 block above calls
  // `pool.end()` in its own `afterAll`, which closes ITS shared-`pool`
  // instance; a fresh instance here means this block's route requests are
  // unaffected by that teardown. The `jest.mock(...)` calls at the top of the
  // file (auth, authorize, authentik) are hoisted and apply to these isolated
  // requires too, so the caller injection and pass-through authorization hold.
  let poolP10;
  let routerP10;
  let DirectoryScopeService;
  let isCandidateVisible;
  let appP10;

  jest.isolateModules(() => {
    poolP10 = require('../config/database');
    routerP10 = require('./users');
    DirectoryScopeService = require('../services/DirectoryScopeService');
    ({ isCandidateVisible } = require('../utils/directoryScope'));
  });

  const runTagP10 = crypto.randomUUID().slice(0, 8);

  // Tracked ids for FK-safe per-run cleanup.
  let created;

  function freshCreated() {
    return { userCacheIds: [], userIds: [], teamIds: [] };
  }

  beforeAll(async () => {
    try {
      await poolP10.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). Property 10 (task 10.3) requires a real, ` +
          `running, already-migrated Postgres instance — it deliberately does not mock ` +
          `"../config/database", because it compares REAL SQL scope semantics against the ` +
          `JavaScript predicate. Underlying error: ${error.message}`,
        { cause: error }
      );
    }
    appP10 = express();
    appP10.use(express.json());
    appP10.use('/api/users', routerP10);
  });

  afterAll(async () => {
    await poolP10.end();
  });

  // ── generated data ──────────────────────────────────────────────────────
  // A single lowercase DNS-style label, kept short. fast-check's fc.domain()
  // can emit uppercase and metacharacter-free strings; here we hand-roll so a
  // handful of labels also carry a LIKE metacharacter (`_`), proving the
  // escaping in buildEmailDomainLikePatterns keeps `a_b.example` a literal
  // match rather than a single-character wildcard.
  const labelArb = fc
    .stringMatching(/^[a-z0-9]{2,8}$/)
    .filter((s) => s.length >= 2 && s.length <= 8);

  // A domain unique to this run (so it never collides with shared rows) built
  // from a generated label plus the run tag. Some domains carry an underscore
  // to exercise LIKE-metacharacter escaping.
  const domainArb = fc.oneof(
    labelArb.map((l) => `${l}-${runTagP10}.example`),
    labelArb.map((l) => `a_${l}-${runTagP10}.example`)
  );

  // A small pool of distinct domains for one scenario.
  const domainPoolArb = fc
    .uniqueArray(domainArb, { minLength: 2, maxLength: 5 })
    .map((domains) => domains.map((d) => d.toLowerCase()));

  // A candidate spec: which domain (by index into the pool), and — for the
  // /search route — where its Direct_Membership sits: 'orgA' (in scope, via
  // orgA's nested Sub_Team so a real Ancestor_Chain is walked), 'orgB' (out of
  // scope), or 'none' (teamless). For /available candidates the membership is
  // always 'none' (the route's `tm.user_id IS NULL` filter). Emails carry
  // mixed case in the local part to prove the domain compare is
  // case-insensitive on both the SQL and the predicate side.
  function scenarioArb() {
    return domainPoolArb.chain((domains) =>
      fc.record({
        domains: fc.constant(domains),
        // orgA's allowed domains: a subset of the pool (possibly empty →
        // fail-closed) plus, sometimes, a domain that is ALSO excluded.
        allowedIdx: fc.uniqueArray(fc.nat({ max: domains.length - 1 }), {
          minLength: 0,
          maxLength: domains.length,
        }),
        // Which domains are globally excluded (a subset of the pool). An
        // allowed domain that is also excluded must grant nothing.
        excludedIdx: fc.uniqueArray(fc.nat({ max: domains.length - 1 }), {
          minLength: 0,
          maxLength: domains.length,
        }),
        candidates: fc.array(
          fc.record({
            domainIdx: fc.nat({ max: domains.length - 1 }),
            mixedCaseLocal: fc.boolean(),
            membership: fc.constantFrom('orgA', 'orgB', 'none'),
            // The candidate's `users.origin_org_id` provenance (Requirement
            // 13.6): 'orgA' (in scope), 'orgB' (out of scope), or 'none'
            // (NULL → falls back to the Email_Domain/membership conditions).
            // Varied INDEPENDENTLY of domain and membership so the additive
            // disjunct (Requirement 13.8) is exercised in every combination —
            // in particular a candidate whose domain and membership both miss
            // but whose provenance is in scope, and vice versa.
            originOrg: fc.constantFrom('orgA', 'orgB', 'none'),
          }),
          { minLength: 1, maxLength: 8 }
        ),
      })
    );
  }

  async function seedScenario(scenario) {
    created = freshCreated();

    // orgA root, orgA nested Sub_Team, orgB root.
    const orgAResult = await poolP10.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      [`P10 OrgA ${crypto.randomUUID()}`, null]
    );
    const orgAId = orgAResult.rows[0].id;
    created.teamIds.push(orgAId);

    const subTeamResult = await poolP10.query(
      `INSERT INTO teams (name, callsign_prefix, parent_team_id) VALUES ($1, $2, $3) RETURNING id`,
      [`P10 OrgA Sub ${crypto.randomUUID()}`, null, orgAId]
    );
    const subTeamId = subTeamResult.rows[0].id;
    created.teamIds.push(subTeamId);

    const orgBResult = await poolP10.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING id`,
      [`P10 OrgB ${crypto.randomUUID()}`, null]
    );
    const orgBId = orgBResult.rows[0].id;
    created.teamIds.push(orgBId);

    // The Team_Admin caller: a real users row with a direct admin membership on
    // orgA's ROOT, so resolveScope's Q1 CTE resolves {orgA} as the single
    // Scoped_Organisation.
    const adminUsername = `p10-admin-${crypto.randomUUID()}`;
    const adminResult = await poolP10.query(
      `INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id`,
      [adminUsername, `${adminUsername}@admin-${runTagP10}.example`]
    );
    const adminId = adminResult.rows[0].id;
    created.userIds.push(adminId);
    await poolP10.query(
      `INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id)
         VALUES ($1, $2, 'admin', NULL)`,
      [orgAId, adminId]
    );

    // orgA's allowed domains.
    const allowedDomains = [...new Set(scenario.allowedIdx.map((i) => scenario.domains[i]))];
    for (const domain of allowedDomains) {
      await poolP10.query(
        `INSERT INTO org_allowed_domains (org_id, domain) VALUES ($1, $2)
           ON CONFLICT (org_id, domain) DO NOTHING`,
        [orgAId, domain]
      );
    }

    // Global Excluded_Domains: read + preserve, then splice in the scenario's
    // excluded slice. Restored in cleanup.
    const excludedDomains = [...new Set(scenario.excludedIdx.map((i) => scenario.domains[i]))];
    const existing = await poolP10.query(
      `SELECT config_value FROM system_config WHERE config_key = 'excluded_email_domains'`
    );
    const originalExcludedConfig = existing.rows.length > 0 ? existing.rows[0].config_value : null;
    const baseExcluded = (() => {
      try {
        const parsed = JSON.parse(originalExcludedConfig);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    await poolP10.query(
      `INSERT INTO system_config (config_key, config_value)
         VALUES ('excluded_email_domains', $1)
       ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value`,
      [JSON.stringify([...baseExcluded, ...excludedDomains])]
    );

    // The candidates. `candidateFacts` mirrors, per candidate and per route,
    // the exact CandidateFacts the route's `toFacts` builds, so the JS
    // predicate can be run over the same facts the route runs it over. Now that
    // `users.origin_org_id` exists (Requirement 13.6), each candidate carries a
    // generated provenance surfaced as `originOrgId`:
    //  - /available: teamless user_cache rows; facts = { email, originOrgId:
    //    <provenance or null>, directMembershipOrgId:null }. A non-null
    //    provenance is backed by a MATCHING teamless local `users` row so the
    //    route's `LEFT JOIN users u` and its `origin_org_id` disjunct see it.
    //  - /search: active users rows; facts = { email, originOrgId: <provenance
    //    or null>, directMembershipOrgId: <root of the membership Team's chain
    //    or null> }.
    const availableCandidates = [];
    const searchCandidates = [];

    // Map a candidate's generated `originOrg` choice to a real Organisation id
    // (or null). 'orgA' is in the caller's scope, 'orgB' is not, 'none' leaves
    // the provenance NULL so the row falls back to the domain/membership
    // conditions (Requirement 13.7).
    const originOrgIdFor = (choice) => {
      if (choice === 'orgA') return orgAId;
      if (choice === 'orgB') return orgBId;
      return null;
    };

    for (const cand of scenario.candidates) {
      const domain = scenario.domains[cand.domainIdx];
      const localSeed = crypto.randomUUID().slice(0, 12);
      const local = cand.mixedCaseLocal ? localSeed.toUpperCase() : localSeed;
      const email = `${local}@${domain}`;
      const candOriginOrgId = originOrgIdFor(cand.originOrg);
      // `user_cache.authentik_id` is text and `users.authentik_user_id` is an
      // integer joined via `::text`. When this candidate carries a provenance
      // (so a matching local `users` row is created below), the id MUST be the
      // text form of a unique integer so the join matches; otherwise a plain
      // unique string is fine (no `users` row references it).
      const authentikIntId = 800000000 + Math.floor(Math.random() * 100000000);
      const authentikId = candOriginOrgId !== null
        ? String(authentikIntId)
        : `p10-cache-${crypto.randomUUID()}`;

      // /available candidate: a teamless user_cache row. When the candidate
      // carries a non-null `origin_org_id` provenance, a MATCHING local `users`
      // row (same authentik id, still teamless so `tm.user_id IS NULL` holds)
      // is created so the route's `LEFT JOIN users u` surfaces the provenance
      // and its `origin_org_id` disjunct (Requirement 13.6) is exercised. When
      // provenance is 'none' the candidate has NO local `users` row — the exact
      // shape the reported defect leaked — so only the Email_Domain condition
      // can admit it. directMembershipOrgId is always null on this route.
      const cacheResult = await poolP10.query(
        `INSERT INTO user_cache (authentik_id, username, email, first_name, last_name, is_active)
           VALUES ($1, $2, $3, 'Cand', 'Idate', true) RETURNING id`,
        [authentikId, `p10-uc-${crypto.randomUUID()}`, email]
      );
      created.userCacheIds.push(cacheResult.rows[0].id);
      if (candOriginOrgId !== null) {
        const provUserResult = await poolP10.query(
          `INSERT INTO users (username, email, first_name, last_name, is_active, authentik_user_id, origin_org_id)
             VALUES ($1, $2, 'Cand', 'Idate', true, $3, $4) RETURNING id`,
          [`p10-avail-${crypto.randomUUID()}`, `avail-${email}`, authentikIntId, candOriginOrgId]
        );
        created.userIds.push(provUserResult.rows[0].id);
      }
      availableCandidates.push({
        id: authentikId,
        email,
        facts: { email, originOrgId: candOriginOrgId, directMembershipOrgId: null },
      });

      // /search candidate: an active users row, optionally holding a direct
      // membership, and carrying the generated `origin_org_id` provenance. When
      // it sits on orgA's nested Sub_Team, the route's TEAM_ROOT_CTE walks the
      // Ancestor_Chain to orgA's root; when on orgB it roots at orgB (out of
      // scope); 'none' leaves it teamless.
      const searchUsername = `p10-su-${crypto.randomUUID()}`;
      const userResult = await poolP10.query(
        `INSERT INTO users (username, email, first_name, last_name, is_active, origin_org_id)
           VALUES ($1, $2, 'Cand', 'Idate', true, $3) RETURNING id`,
        [searchUsername, email, candOriginOrgId]
      );
      const userId = userResult.rows[0].id;
      created.userIds.push(userId);

      let directMembershipOrgId = null;
      if (cand.membership === 'orgA') {
        await poolP10.query(
          `INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id)
             VALUES ($1, $2, 'member', NULL)`,
          [subTeamId, userId]
        );
        directMembershipOrgId = orgAId;
      } else if (cand.membership === 'orgB') {
        await poolP10.query(
          `INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id)
             VALUES ($1, $2, 'member', NULL)`,
          [orgBId, userId]
        );
        directMembershipOrgId = orgBId;
      }

      searchCandidates.push({
        id: userId,
        email,
        searchTermSafe: searchUsername,
        facts: { email, originOrgId: candOriginOrgId, directMembershipOrgId },
      });
    }

    return {
      adminId,
      orgAId,
      orgBId,
      availableCandidates,
      searchCandidates,
      originalExcludedConfig,
    };
  }

  async function cleanupScenario(originalExcludedConfig) {
    if (created.userCacheIds.length > 0) {
      await poolP10.query('DELETE FROM user_cache WHERE id = ANY($1)', [created.userCacheIds]);
    }
    if (created.userIds.length > 0) {
      await poolP10.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [created.userIds]);
      await poolP10.query('DELETE FROM users WHERE id = ANY($1)', [created.userIds]);
    }
    if (created.teamIds.length > 0) {
      // org_allowed_domains and team_memberships cascade off teams; delete
      // children (the nested Sub_Team) before parents by reversing insert order.
      for (const teamId of [...created.teamIds].reverse()) {
        await poolP10.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    }
    // Restore the shared global excluded_email_domains config exactly.
    if (originalExcludedConfig === null) {
      await poolP10.query(`DELETE FROM system_config WHERE config_key = 'excluded_email_domains'`);
    } else {
      await poolP10.query(
        `UPDATE system_config SET config_value = $1 WHERE config_key = 'excluded_email_domains'`,
        [originalExcludedConfig]
      );
    }
  }

  // Feature: member-visibility-and-callsign-recompute, Property 10: The SQL pre-narrowing and the predicate admit the same candidates
  fcTest.prop([scenarioArb()], { numRuns: 30 })(
    'for /available and /search, the set the route returns (SQL in_scope ∩ predicate) equals the set isCandidateVisible admits over the same seeded candidates',
    async (scenario) => {
      const seeded = await seedScenario(scenario);
      try {
        // The REAL resolved scope for the caller — the single input to both the
        // SQL parameters and the JS predicate, exactly as the route uses it.
        mockUser = { id: seeded.adminId, userId: seeded.adminId, is_global_manager: false };
        const scope = await DirectoryScopeService.resolveScope(mockUser);

        // ── /available ──────────────────────────────────────────────────────
        // Predicate-admitted set over the teamless user_cache candidates. On
        // this route directMembershipOrgId is null and originOrgId is null, so
        // only the email-domain condition can admit.
        const availablePredicateEmails = new Set(
          seeded.availableCandidates
            .filter((c) => isCandidateVisible(scope, c.facts))
            .map((c) => c.email.toLowerCase())
        );

        const availableRes = await request(appP10).get('/api/users/available');
        expect(availableRes.status).toBe(200);
        // Restrict the returned set to the candidates THIS run seeded — the
        // shared DB may hold unrelated teamless rows — by intersecting with
        // this run's seeded emails. The comparison is then wholly within this
        // run's data on both sides.
        const seededAvailableEmails = new Set(
          seeded.availableCandidates.map((c) => c.email.toLowerCase())
        );
        const availableReturnedSeeded = new Set(
          availableRes.body.users
            .map((u) => u.email.toLowerCase())
            .filter((e) => seededAvailableEmails.has(e))
        );
        expect(availableReturnedSeeded).toEqual(availablePredicateEmails);

        // ── /search ─────────────────────────────────────────────────────────
        // The /search route requires a 2+ char query and returns up to 20 rows.
        // A run-tagged fragment scopes the ILIKE to THIS run's candidates so
        // the shared users table's other rows never enter the comparison, and
        // keeps the result under the LIMIT. `runTagP10` (8 chars) is present in
        // every seeded users row's username, so searching it returns exactly
        // this run's seeded users (subject to scoping), and the predicate is
        // computed over the same set.
        const searchPredicateEmails = new Set(
          seeded.searchCandidates
            .filter((c) => isCandidateVisible(scope, c.facts))
            .map((c) => c.email.toLowerCase())
        );

        const searchRes = await request(appP10)
          .get('/api/users/search')
          .query({ q: runTagP10 });
        expect(searchRes.status).toBe(200);

        const seededSearchEmails = new Set(
          seeded.searchCandidates.map((c) => c.email.toLowerCase())
        );
        const searchReturnedSeeded = new Set(
          searchRes.body.users
            .map((u) => u.email.toLowerCase())
            .filter((e) => seededSearchEmails.has(e))
        );
        expect(searchReturnedSeeded).toEqual(searchPredicateEmails);
      } finally {
        await cleanupScenario(seeded.originalExcludedConfig);
      }
    }
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Requirement 15.10 — `GET /api/users/search` and `GET /api/users` exclude a
// user outside the caller's Scoped_Organisations and include that user for a
// Global_Manager (task 10.4; live Postgres).
//
// APPENDED as a wholly NEW describe block. Like the Property 10 block above, it
// uses an ISOLATED module graph (`jest.isolateModules`) so it holds its OWN
// `pool` instance and its OWN `users` router bound to that pool: the task-9.5
// block's `afterAll` calls `pool.end()` on the shared instance, and Property
// 10's `afterAll` ends its own — a third, isolated instance here is unaffected
// by either teardown and ends its own in `afterAll`. The `jest.mock(...)` calls
// hoisted at the top of the file (auth, authorize, authentik) apply to these
// isolated requires too, so the caller injection, the pass-through
// authorization, and the mocked `authentikService.getUsers` all hold.
//
// The candidate is a REAL `users` row whose Direct_Membership Organisation is
// OUTSIDE the caller's Scoped_Organisations AND whose email domain is not an
// Allowed_Domain of the caller's Organisation. So neither the Direct_Membership
// condition nor the Email_Domain condition of Requirement 8 Criterion 1 admits
// it for the scoped Team_Admin caller — it must be EXCLUDED from both routes.
// For a Global_Manager caller, `resolveScope` short-circuits to UNSCOPED and
// the candidate is INCLUDED (subject to the routes' existing filters).
//
// `GET /api/users` pulls its page from Authentik, not SQL, so the mocked
// `authentikService.getUsers` returns a page CONTAINING the candidate (by its
// `authentik_user_id`) plus the admin actor — the local scoping predicate over
// the batched local facts is then what decides inclusion, exactly as in
// production. `GET /api/users/search` pulls from the local `users` table
// directly, so no Authentik mock is needed for it.
// ════════════════════════════════════════════════════════════════════════════

describe('Req 15.10: /search and /users exclude an out-of-scope user for a Team_Admin and include it for a Global_Manager (task 10.4, live Postgres)', () => {
  let poolR1510;
  let routerR1510;
  let appR1510;
  const authentikServiceR1510 = require('../services/authentik');

  jest.isolateModules(() => {
    poolR1510 = require('../config/database');
    routerR1510 = require('./users');
  });

  const runTag1510 = crypto.randomUUID().slice(0, 8);
  const callerDomain = `caller-${runTag1510}.example`;
  const outsideDomain = `outside-${runTag1510}.example`;

  // `users.authentik_user_id` is an INTEGER column and Authentik `pk` values
  // are integers, so both the seeded ids and the mocked Authentik page's `pk`
  // must be integers. Use large random integers, kept unique to this run, so
  // they never collide with existing rows in the shared test database.
  const adminAuthentikId = 900000000 + Math.floor(Math.random() * 40000000);
  const candidateAuthentikId = 940000001 + Math.floor(Math.random() * 40000000);

  let callerActor;
  let callerOrg;
  let outsideOrg;
  let candidateUser; // real users row, out of scope for the caller
  const created = { userCacheIds: [], userIds: [], teamIds: [] };

  beforeAll(async () => {
    try {
      await poolR1510.query('SELECT 1');
    } catch (error) {
      throw new Error(
        `Real Postgres test database is not reachable at ` +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). Requirement 15.10 (task 10.4) requires a real, ` +
          `running, already-migrated Postgres instance — it deliberately does not mock ` +
          `"../config/database". Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    appR1510 = express();
    appR1510.use(express.json());
    appR1510.use('/api/users', routerR1510);

    // The caller's Organisation (root team) and a SEPARATE Organisation the
    // candidate belongs to (out of the caller's scope).
    const callerOrgResult = await poolR1510.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING *`,
      [`R1510 Caller Org ${crypto.randomUUID()}`, null]
    );
    callerOrg = callerOrgResult.rows[0];
    created.teamIds.push(callerOrg.id);

    const outsideOrgResult = await poolR1510.query(
      `INSERT INTO teams (name, callsign_prefix) VALUES ($1, $2) RETURNING *`,
      [`R1510 Outside Org ${crypto.randomUUID()}`, null]
    );
    outsideOrg = outsideOrgResult.rows[0];
    created.teamIds.push(outsideOrg.id);

    // The caller's Organisation has ONE allowed domain (callerDomain), so its
    // scope is configured; the outside Organisation's domain is deliberately
    // NOT allowed for the caller.
    await poolR1510.query(
      `INSERT INTO org_allowed_domains (org_id, domain) VALUES ($1, $2)
         ON CONFLICT (org_id, domain) DO NOTHING`,
      [callerOrg.id, callerDomain]
    );

    // The Team_Admin caller: a real users row holding a direct admin membership
    // on the caller's Organisation root, so resolveScope's Q1 CTE resolves
    // {callerOrg} as the single Scoped_Organisation.
    const adminUsername = `r1510-admin-${crypto.randomUUID()}`;
    const adminResult = await poolR1510.query(
      `INSERT INTO users (username, email, authentik_user_id, is_active) VALUES ($1, $2, $3, true) RETURNING *`,
      [adminUsername, `${adminUsername}@${callerDomain}`, adminAuthentikId]
    );
    callerActor = adminResult.rows[0];
    created.userIds.push(callerActor.id);
    await poolR1510.query(
      `INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id)
         VALUES ($1, $2, 'admin', NULL)`,
      [callerOrg.id, callerActor.id]
    );

    // The candidate: a real, active users row whose Direct_Membership is on the
    // OUTSIDE Organisation AND whose email domain is the outside domain — so it
    // satisfies NEITHER condition of Requirement 8 Criterion 1 for the caller.
    // It carries a stable authentik_user_id so the mocked Authentik page for
    // GET /api/users can reference it.
    const candidateUsername = `r1510-cand-${runTag1510}`;
    const candidateResult = await poolR1510.query(
      `INSERT INTO users (username, email, first_name, last_name, authentik_user_id, is_active)
         VALUES ($1, $2, 'Cand', 'Outside', $3, true) RETURNING *`,
      [candidateUsername, `${candidateUsername}@${outsideDomain}`, candidateAuthentikId]
    );
    candidateUser = candidateResult.rows[0];
    created.userIds.push(candidateUser.id);
    await poolR1510.query(
      `INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id)
         VALUES ($1, $2, 'member', NULL)`,
      [outsideOrg.id, candidateUser.id]
    );
  });

  afterAll(async () => {
    if (created.userIds.length > 0) {
      await poolR1510.query('DELETE FROM team_memberships WHERE user_id = ANY($1)', [created.userIds]);
      await poolR1510.query('DELETE FROM users WHERE id = ANY($1)', [created.userIds]);
    }
    if (created.teamIds.length > 0) {
      for (const teamId of [...created.teamIds].reverse()) {
        await poolR1510.query('DELETE FROM teams WHERE id = $1', [teamId]);
      }
    }
    await poolR1510.end();
  });

  // Feature: member-visibility-and-callsign-recompute, Requirement 15.10
  it('GET /api/users/search excludes the out-of-scope candidate for the Team_Admin and includes it for the Global_Manager', async () => {
    // Scoped Team_Admin caller: the candidate is out of scope on both
    // conditions, so it must not appear.
    mockUser = { id: callerActor.id, userId: callerActor.id, is_global_manager: false };
    const scoped = await request(appR1510).get('/api/users/search').query({ q: runTag1510 });
    expect(scoped.status).toBe(200);
    const scopedEmails = scoped.body.users.map((u) => u.email);
    expect(scopedEmails).not.toContain(candidateUser.email);

    // Global_Manager caller: resolveScope short-circuits to UNSCOPED, so the
    // candidate is included (it matches the ILIKE on the run tag and is active).
    mockUser = { id: callerActor.id, userId: callerActor.id, is_global_manager: true };
    const unscoped = await request(appR1510).get('/api/users/search').query({ q: runTag1510 });
    expect(unscoped.status).toBe(200);
    const unscopedEmails = unscoped.body.users.map((u) => u.email);
    expect(unscopedEmails).toContain(candidateUser.email);
  });

  // Feature: member-visibility-and-callsign-recompute, Requirement 15.10
  it('GET /api/users excludes the out-of-scope candidate for the Team_Admin and includes it for the Global_Manager', async () => {
    // The Authentik page contains the candidate and the admin actor; the local
    // scoping predicate over the batched local facts decides inclusion.
    const authentikPage = {
      results: [
        {
          pk: candidateUser.authentik_user_id,
          email: candidateUser.email,
          first_name: 'Cand',
          last_name: 'Outside',
        },
        {
          pk: callerActor.authentik_user_id,
          email: callerActor.email,
          first_name: 'Admin',
          last_name: 'Caller',
        },
      ],
      count: 2,
    };

    // Scoped Team_Admin caller: the candidate's Direct_Membership roots at the
    // outside Organisation and its domain is not allowed, so it is excluded.
    authentikServiceR1510.getUsers.mockResolvedValue(authentikPage);
    mockUser = { id: callerActor.id, userId: callerActor.id, is_global_manager: false };
    const scoped = await request(appR1510).get('/api/users');
    expect(scoped.status).toBe(200);
    const scopedEmails = scoped.body.users.map((u) => u.email);
    expect(scopedEmails).not.toContain(candidateUser.email);

    // Global_Manager caller: UNSCOPED, so the candidate is included (subject to
    // the route's existing filters, which it passes — active, not a device).
    authentikServiceR1510.getUsers.mockResolvedValue(authentikPage);
    mockUser = { id: callerActor.id, userId: callerActor.id, is_global_manager: true };
    const unscoped = await request(appR1510).get('/api/users');
    expect(unscoped.status).toBe(200);
    const unscopedEmails = unscoped.body.users.map((u) => u.email);
    expect(unscopedEmails).toContain(candidateUser.email);
  });
});
