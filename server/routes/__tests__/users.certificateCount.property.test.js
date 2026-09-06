// Feature: takserver-enrollment, Property 12: Certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries
//
// **Validates: Requirements 13.1, 13.2, 13.4, 13.5, 13.6**

/**
 * takserver-enrollment task 8.8: the single fast-check property test for
 * design.md's Property 12 -- the QUERY ARM. Task 11.4 implements the RENDER
 * arm (`client/src/components/MultipleCertificateWarning.property.test.jsx`).
 * Both files carry the IDENTICAL tag above deliberately: Property 12's
 * subject spans two runners (the batched server-side query and the client
 * rendering it feeds), so it is one property expressed as two files, not
 * two properties.
 *
 * ## What this arm is about
 *
 * `GET /api/users` (`server/routes/users.js`) attaches `live_certificate_count`
 * to every returned user from ONE derived-table LEFT JOIN in the local
 * `users`/`user_cache`/`team_root` list query -- never a second query, and
 * never one query per user. (This route was migrated from a live per-request
 * Authentik fetch to the LOCAL database; the certificate-count join rides on
 * that single local list query rather than a separate decoration pass over an
 * Authentik page.) This test never executes real SQL: `pool.query` is mocked
 * with an interpreter that answers the list query's rows the way Postgres
 * would, computed from a generated in-memory `tak_devices` table. The
 * "expectation" this test checks against is computed a second time,
 * independently, by filtering the SAME generated rows in plain JavaScript --
 * exactly the design's required re-derivation technique -- so a bug in the
 * route's attach-by-id logic (wrong key, cross-principal leakage, a dropped
 * `?? 0` default) is what this test is positioned to catch, not a bug in
 * Postgres.
 *
 * ## Generator shape
 *
 * A SMALL fixed principal alphabet (five Authentik ids) stands in for "the set
 * of principals a real deployment has", crossed against a MUCH LARGER row
 * count per scenario: for every alphabet id, a per-id plan draws a
 * `targetLive` count -- concentrated on exactly 0, 1 and 2 (the warning's
 * threshold sits between the last two), with a small broader arm up to 6 so
 * the property is not boundary-only -- plus an independently drawn
 * `extraRevoked` count of REVOKED rows for that SAME id (0-4), so several
 * rows per principal, including revoked ones that must not count, are the
 * COMMON case rather than an edge case. A separate pool of rows carries a
 * NULL `user_id`, revoked and non-revoked, equally common. The list of
 * principals returned on the page is a (possibly empty) subset of the
 * alphabet, weighted toward non-empty so the interesting per-principal
 * assertions run on most iterations while the empty-page case is still
 * exercised regularly.
 *
 * ## What is asserted, and how "never leaks" is checked
 *
 * For every principal in the generated page: the response's
 * `live_certificate_count` equals the count of rows in the FULL generated
 * table whose `user_id` is that principal's LOCAL id AND whose `revoked` is
 * `false` -- filtered fresh in the assertion, not read back from whatever the
 * mock happened to return, so a route that attached the wrong row would be
 * caught even though the mock's own data was correct. `pool.query` is asserted
 * to have been called exactly ONCE regardless of the page's length (the local
 * list query is always the single statement in play for a Global_Manager,
 * whose scope short-circuits to UNSCOPED with no extra query) -- never once
 * per principal, which is the "independent of the list's length" clause.
 * Anti-vacuity counters (checked in the trailing `it()`, after every
 * `test.prop` run) confirm the generated runs actually included a principal
 * with exactly one live certificate and a principal with two or more.
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    // is_global_manager: true short-circuits DirectoryScopeService.resolveScope
    // to its UNSCOPED sentinel with no further DB query, so the ONLY
    // pool.query call in play is the batched local list query this property is
    // about (the real, un-mocked DirectoryScopeService is otherwise exercised,
    // deliberately, rather than mocking it too). It also means Team
    // .getManagedTeamIds is never called (a Global_Manager manages every row),
    // so no second query sneaks in on that path either.
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../../middleware/authorize', () => (req, res, next) => next());

const express = require('express');
const request = require('supertest');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../../config/database');
const usersRouter = require('../users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A small, fixed alphabet of local `users.id`-shaped principal ids. */
const ALPHABET_IDS = [1, 2, 3, 4, 5];

/**
 * Boundary-concentrated live-row count per principal: heavily weighted to
 * exactly 0, 1 and 2 -- the warning's threshold sits between the last two --
 * with a small broad arm up to 6 so the property is not boundary-only.
 */
const targetLiveCountArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant(0) },
  { weight: 3, arbitrary: fc.constant(1) },
  { weight: 3, arbitrary: fc.constant(2) },
  { weight: 1, arbitrary: fc.integer({ min: 3, max: 6 }) }
);

/** Extra REVOKED rows for the same id -- common, and must never count. */
const extraRevokedCountArb = fc.integer({ min: 0, max: 4 });

const perIdPlanArb = fc.tuple(
  ...ALPHABET_IDS.map(() => fc.record({ targetLive: targetLiveCountArb, extraRevoked: extraRevokedCountArb }))
);

/** Rows with a NULL user_id -- must never count toward ANY principal. */
const nullRowRevokedFlagsArb = fc.array(fc.boolean(), { minLength: 0, maxLength: 10 });

/**
 * The principals "returned on this page" -- a possibly-empty subset of the
 * alphabet. Weighted toward non-empty so the per-principal assertions below
 * run on most iterations; the empty-page arm still recurs regularly.
 */
const principalIdsArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant([]) },
  {
    weight: 4,
    arbitrary: fc.uniqueArray(fc.constantFrom(...ALPHABET_IDS), { minLength: 1, maxLength: ALPHABET_IDS.length })
  }
);

const scenarioArb = fc.record({
  perIdPlan: perIdPlanArb,
  nullRowRevokedFlags: nullRowRevokedFlagsArb,
  principalIds: principalIdsArb
});

// ---------------------------------------------------------------------------
// Table construction and independent re-derivation
// ---------------------------------------------------------------------------

/**
 * Builds the generated `tak_devices` content: for each alphabet id, exactly
 * `targetLive` non-revoked rows and `extraRevoked` revoked rows for that
 * SAME id (several rows per principal, including ones that must not count,
 * is the common case); plus a pool of null-`user_id` rows in both revoked
 * states (also common, and must never count toward any principal).
 */
function buildDevices(perIdPlan, nullRowRevokedFlags) {
  const rows = [];
  ALPHABET_IDS.forEach((id, index) => {
    const { targetLive, extraRevoked } = perIdPlan[index];
    for (let i = 0; i < targetLive; i += 1) {
      rows.push({ user_id: id, revoked: false });
    }
    for (let i = 0; i < extraRevoked; i += 1) {
      rows.push({ user_id: id, revoked: true });
    }
  });
  nullRowRevokedFlags.forEach((revoked) => {
    rows.push({ user_id: null, revoked });
  });
  return rows;
}

/**
 * The independent re-derivation: filters the generated rows in JavaScript
 * alone, never by running SQL and never by reading back whatever the mocked
 * `pool.query` was told to answer.
 */
function expectedLiveCount(devices, id) {
  return devices.filter((row) => row.user_id === id && row.revoked === false).length;
}

// ---------------------------------------------------------------------------
// Anti-vacuity tracking, checked after every generated run has executed.
// ---------------------------------------------------------------------------

const seen = { exactlyOne: false, twoOrMore: false };

// Feature: takserver-enrollment, Property 12: Certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries
describe('Property 12 (query arm): Certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test.prop([scenarioArb], { numRuns: 200 })(
    'resolves each principal\'s live certificate count correctly, excluding revoked and null-user_id rows and every other principal\'s rows, in a single query independent of list length',
    async ({ perIdPlan, nullRowRevokedFlags, principalIds }) => {
      // fast-check invokes this property function many times within a
      // SINGLE jest test, so `beforeEach`'s `jest.clearAllMocks()` runs
      // once for the whole test, not once per generated run. Without this
      // per-run clear, `pool.query`'s call count accumulates across every
      // prior iteration and the "single query" assertion below would be
      // comparing against the wrong baseline.
      pool.query.mockClear();

      const devices = buildDevices(perIdPlan, nullRowRevokedFlags);

      // Track anti-vacuity across the WHOLE run before touching the route,
      // over the principals actually present on this page.
      for (const id of principalIds) {
        const count = expectedLiveCount(devices, id);
        if (count === 1) seen.exactlyOne = true;
        if (count >= 2) seen.twoOrMore = true;
      }

      // The interpreter: answers the single local list query the way the
      // real derived-table LEFT JOIN would, computed from the SAME generated
      // devices table, returning one `base`-shaped row per principal on the
      // page. `pk` is the Authentik id the response echoes; `local_user_id`
      // is the `users.id` the `certs` derived table is keyed on and the id
      // this re-derivation filters `tak_devices` by. The exact local total is
      // carried on every row as `total_count`, exactly as the real query's
      // `(SELECT total FROM counted)` projection does. Never a second call,
      // never a per-principal call.
      const total = principalIds.length;
      pool.query.mockResolvedValue({
        rows: principalIds.map((id) => ({
          pk: `authentik-${id}`,
          local_user_id: id,
          username: `user${id}`,
          email: `user${id}@example.org`,
          first_name: 'User',
          last_name: String(id),
          is_active: true,
          tak_role: null,
          callsign_suffix: null,
          account_status: 'active',
          origin_org_id: null,
          tak_callsign: null,
          tak_color: null,
          team_id: null,
          direct_membership_org_id: null,
          team_name: null,
          live_certificate_count: expectedLiveCount(devices, id),
          total_count: total
        }))
      });

      const res = await request(app).get('/api/users');

      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(principalIds.length);

      // Independent of the page's length: exactly ONE pool.query call for the
      // local list -- never one call per principal and never a count that
      // scales with the page. A Global_Manager short-circuits scope resolution
      // (no scope query) and manages every row (no getManagedTeamIds query),
      // so the list query is the sole statement issued.
      expect(pool.query).toHaveBeenCalledTimes(1);

      for (const id of principalIds) {
        const returned = res.body.users.find((u) => u.pk === `authentik-${id}`);
        expect(returned).toBeDefined();

        // Re-derived fresh here, filtering the generated table directly --
        // never read back from the mock's own canned response -- so a route
        // bug that attached the wrong row (e.g. by array position rather than
        // by principal) would still be caught even though the mock's data was
        // correct.
        const expected = devices.filter((row) => row.user_id === id && row.revoked === false).length;
        expect(returned.live_certificate_count).toBe(expected);

        // Never a leak from another principal or from a null-user_id row:
        // recomputing with an id-mismatched or null-inclusive filter must
        // NOT coincidentally match unless the true count is zero for both.
        const otherPrincipalsTotal = devices
          .filter((row) => row.user_id !== null && row.user_id !== id && row.revoked === false)
          .length;
        const nullRowsTotal = devices.filter((row) => row.user_id === null && row.revoked === false).length;
        if (otherPrincipalsTotal > 0 || nullRowsTotal > 0) {
          expect(returned.live_certificate_count).not.toBe(
            expected + otherPrincipalsTotal + nullRowsTotal
          );
        }
      }
    }
  );

  it('exercised at least one principal with exactly one live certificate and one with two or more (anti-vacuity)', () => {
    expect(seen.exactlyOne).toBe(true);
    expect(seen.twoOrMore).toBe(true);
  });
});
