/**
 * Unit + property tests for `DirectoryScopeService`
 * (spec `member-visibility-and-callsign-recompute`).
 *
 * `DirectoryScopeService.resolveScope` is the only Database reader in the
 * Organisation-scoping half of this feature. It reads through the pool
 * (`require('../config/database')`), so the pool is mocked here with the same
 * `jest.mock('../config/database', ...)` idiom the other server service unit
 * tests use (`OrgInterestService.test.js`, `TeamVisibilityService.test.js`):
 * `pool.query` is a `jest.fn()` whose per-call responses each test queues with
 * `mockResolvedValueOnce({ rows: [...] })`.
 *
 * `resolveScope` issues up to three queries in a fixed order and
 * short-circuits: Q1 resolves the Scoped_Organisations via a recursive CTE, and
 * an empty Q1 result returns an empty scope without issuing Q2 or Q3. The CTE
 * itself is exercised end-to-end at integration level (tasks 9.5/13.5); at unit
 * level the pool is mocked, so each test below makes the mocked Q1 response
 * equal what that CTE WOULD return for the generated hierarchy and admin
 * placement -- computed by walking the generated data directly, never by
 * calling back into the service -- and then asserts the service maps those Q1
 * rows into the resolved scope faithfully.
 *
 * This file is the first test targeting `DirectoryScopeService`. Tasks 7.4
 * (Property 17) and 7.5 (resolver examples) ADD to it, so it is structured with
 * clear top-level describe blocks.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

// `logScopedResponse` emits through `getLogger().info(...)` from
// `server/middleware/requestContext`, exactly as every other log call in these
// routes does. The resolver-examples block below asserts on the object passed
// to that `info(...)` call, so the logger is mocked with a single shared
// `mockLoggerInfo` spy that every `getLogger()` returns — the same idiom
// `RequestApprovalService.test.js` and `users.create-and-add.test.js` use for
// `getLogger().error(...)`. Declared with the `mock` prefix so Jest permits it
// inside the hoisted factory.
const mockLoggerInfo = jest.fn();
jest.mock('../middleware/requestContext', () => ({
  getLogger: () => ({ info: mockLoggerInfo, warn: jest.fn(), error: jest.fn() })
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const pool = require('../config/database');
const DirectoryScopeService = require('./DirectoryScopeService');
const {
  hierarchyArb,
  adminPlacementArb,
  domainArb,
  allowedDomainRowsArb,
  excludedDomainsArb
} = require('./__fixtures__/directoryScopeArbitraries');

/**
 * The reference Scoped_Organisations, computed by walking the generated
 * membership rows and hierarchy directly.
 *
 * Property 15's statement: Scoped_Organisations are the roots of the
 * administered chains. Only a DIRECT (`inherited_from_team_id IS NULL`)
 * membership row with `role = 'admin'` contributes -- an inherited row, or a
 * `member` row, or a direct admin row at any depth, each contributes the ROOT
 * of its Team's Ancestor_Chain and nothing else. The set is deduplicated
 * because two administered Teams can share one Organisation, and because the
 * `UNION` in Q1's CTE deduplicates overlapping ancestor paths.
 *
 * This mirrors the `admin_teams -> chain -> WHERE parent_team_id IS NULL`
 * shape of Q1's CTE without executing SQL: `admin_teams` is the filter on the
 * membership rows below, and `hierarchy.rootOf` walks each administered Team up
 * to the `parent_team_id IS NULL` row.
 *
 * @param {import('../services/__fixtures__/transferArbitraries').Hierarchy} hierarchy
 * @param {import('../services/__fixtures__/transferArbitraries').AdminPlacement} placement
 * @returns {number[]} the reference Organisation ids, ascending
 */
function referenceScopedOrganisationIds(hierarchy, placement) {
  const orgIds = new Set();
  for (const row of placement.membershipRows) {
    if (row.role === 'admin' && row.inherited_from_team_id === null) {
      const rootId = hierarchy.rootOf(row.team_id);
      if (rootId !== undefined) {
        orgIds.add(rootId);
      }
    }
  }
  return Array.from(orgIds).sort((a, b) => a - b);
}

describe('DirectoryScopeService.resolveScope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Property 15: Scoped_Organisations are the roots of the administered chains
  // ────────────────────────────────────────────────────────────────────────
  describe('Property 15: Scoped_Organisations are the roots of the administered chains', () => {
    // Feature: member-visibility-and-callsign-recompute, Property 15: Scoped_Organisations are the roots of the administered chains
    // Validates: Requirements 8.5, 8.6
    test.prop(
      [
        hierarchyArb({ minOrganisations: 1, maxOrganisations: 3 }).chain((hierarchy) =>
          fc.record({
            hierarchy: fc.constant(hierarchy),
            placement: adminPlacementArb(hierarchy)
          })
        )
      ],
      { numRuns: 100 }
    )(
      'resolveScope returns exactly the roots of the directly-administered chains',
      async ({ hierarchy, placement }) => {
        // fast-check re-runs this body many times within one Jest test, so the
        // per-call queue and the call count must be reset each run rather than
        // only in `beforeEach`.
        pool.query.mockReset();

        const expectedOrgIds = referenceScopedOrganisationIds(hierarchy, placement);

        // Q1 returns exactly what the recursive CTE would return for this
        // generated hierarchy + placement: one row per Scoped_Organisation,
        // carrying its id and name. The CTE selects the `parent_team_id IS NULL`
        // row, so these are the Organisation rows and nothing else.
        const q1Rows = expectedOrgIds.map((id) => ({
          id,
          name: hierarchy.teams.get(id).name
        }));
        pool.query.mockResolvedValueOnce({ rows: q1Rows });

        if (expectedOrgIds.length > 0) {
          // Non-empty Q1 -> the service goes on to Q2 (Allowed_Domains) and Q3
          // (Excluded_Domains). Neither affects the Organisation set Property 15
          // is about, so both are empty here.
          pool.query.mockResolvedValueOnce({ rows: [] }); // Q2
          pool.query.mockResolvedValueOnce({ rows: [] }); // Q3
        }

        const user = { userId: placement.userIds[0], is_global_manager: false };
        const scope = await DirectoryScopeService.resolveScope(user);

        // The resolved scope's organisation ids are exactly the reference roots.
        const resolvedIds = [...scope.organisationIds].sort((a, b) => a - b);
        expect(resolvedIds).toEqual(expectedOrgIds);

        // And the `organisations` array carries the same ids with their names.
        const resolvedOrgs = [...scope.organisations].sort((a, b) => a.id - b.id);
        expect(resolvedOrgs).toEqual(
          expectedOrgIds.map((id) => ({ id, name: hierarchy.teams.get(id).name }))
        );

        // An empty administered set short-circuits after Q1 (one query, not
        // three) and yields no configured domains; a non-empty set issues all
        // three queries.
        expect(pool.query).toHaveBeenCalledTimes(expectedOrgIds.length === 0 ? 1 : 3);
        if (expectedOrgIds.length === 0) {
          expect(scope.domainsConfigured).toBe(false);
        }
      }
    );
  });
});

/**
 * The reference surviving Allowed_Domain set, computed by walking the
 * generated `allowedDomains` rows and `excluded` set directly — never by
 * calling `buildDirectoryScope`, which would make the assertion a tautology.
 *
 * Requirement 8.6 makes the rule a UNION across the caller's Scoped_
 * Organisations, so every row whose `org_id` is one of the reference scoped
 * ids contributes its domain, lowercased. Requirement 8.4 subtracts the
 * Excluded_Domains from that union case-insensitively. What survives is what
 * `scope.domainsConfigured` (Requirement 9.4) and the SQL LIKE patterns are
 * built from.
 *
 * @param {number[]} scopedOrgIds  the reference Scoped_Organisation ids
 * @param {Array<{ org_id: number, domain: string }>} allowedRows
 * @param {string[]} excluded
 * @returns {Set<string>} the surviving domains, lowercased
 */
function referenceSurvivingDomains(scopedOrgIds, allowedRows, excluded) {
  const scoped = new Set(scopedOrgIds);
  const excludedSet = new Set(
    excluded
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.trim().toLowerCase())
  );

  const surviving = new Set();
  for (const row of allowedRows) {
    if (!scoped.has(row.org_id)) {
      continue;
    }
    const domain = typeof row.domain === 'string' ? row.domain.trim().toLowerCase() : '';
    if (domain !== '' && !excludedSet.has(domain)) {
      surviving.add(domain);
    }
  }
  return surviving;
}

describe('DirectoryScopeService.buildScopeResponse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Property 17: The scope object reports the domain configuration it was
  //              built from
  // ────────────────────────────────────────────────────────────────────────
  describe('Property 17: The scope object reports the domain configuration it was built from', () => {
    // Feature: member-visibility-and-callsign-recompute, Property 17: The scope object reports the domain configuration it was built from
    // Validates: Requirements 9.3, 9.4
    test.prop(
      [
        hierarchyArb({ minOrganisations: 1, maxOrganisations: 3 }).chain((hierarchy) =>
          domainArb().chain((domains) =>
            fc.record({
              hierarchy: fc.constant(hierarchy),
              placement: adminPlacementArb(hierarchy),
              allowedRows: allowedDomainRowsArb(hierarchy, domains),
              excluded: excludedDomainsArb(domains)
            })
          )
        )
      ],
      { numRuns: 100 }
    )(
      'buildScopeResponse(scope) reports domainsConfigured iff the surviving set is non-empty, and the scoped organisations',
      async ({ hierarchy, placement, allowedRows, excluded }) => {
        // fast-check re-runs this body many times within one Jest test, so the
        // per-call queue and the call count must be reset each run.
        pool.query.mockReset();

        const expectedOrgIds = referenceScopedOrganisationIds(hierarchy, placement);

        // Q1 — the recursive CTE's output for this hierarchy + placement: one
        // row per Scoped_Organisation carrying its id and name.
        const q1Rows = expectedOrgIds.map((id) => ({
          id,
          name: hierarchy.teams.get(id).name
        }));
        pool.query.mockResolvedValueOnce({ rows: q1Rows });

        if (expectedOrgIds.length > 0) {
          // Q2 — the Allowed_Domains of the Scoped_Organisations. The service's
          // `WHERE org_id = ANY($1::int[])` returns exactly the generated rows
          // whose `org_id` is one of the scoped ids, projected to `{ domain }`.
          const scopedSet = new Set(expectedOrgIds);
          const q2Rows = allowedRows
            .filter((row) => scopedSet.has(row.org_id))
            .map((row) => ({ domain: row.domain }));
          pool.query.mockResolvedValueOnce({ rows: q2Rows });

          // Q3 — the Excluded_Domains system_config row, stored as a JSON array
          // string, exactly as `readExcludedDomains` parses it.
          pool.query.mockResolvedValueOnce({
            rows: [{ config_value: JSON.stringify(excluded) }]
          });
        }

        const user = { userId: placement.userIds[0], is_global_manager: false };
        const scope = await DirectoryScopeService.resolveScope(user);
        const response = DirectoryScopeService.buildScopeResponse(scope);

        // Requirement 9.4: domainsConfigured is true exactly when the surviving
        // Allowed_Domain set (union across the scoped Organisations, minus the
        // Excluded_Domains) is non-empty. Computed by walking the generated
        // rows directly.
        const surviving = referenceSurvivingDomains(expectedOrgIds, allowedRows, excluded);
        expect(response.domainsConfigured).toBe(surviving.size > 0);

        // The scope object reports its domainsConfigured verbatim from the
        // scope it was built from — they can never disagree.
        expect(response.domainsConfigured).toBe(scope.domainsConfigured);

        // Requirement 9.3: the organisations array holds each Scoped_
        // Organisation's id and name.
        const responseOrgs = [...response.organisations].sort((a, b) => a.id - b.id);
        expect(responseOrgs).toEqual(
          expectedOrgIds.map((id) => ({ id, name: hierarchy.teams.get(id).name }))
        );
      }
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Resolver examples (task 7.5)
//
// Plain example tests for the four narrow behaviours the property tests above
// do not pin down on their own: the exact query cost of the two short-circuit
// paths, that a Global_Manager reads only the cached attribute, that the log
// line carries ids and counts and never a candidate's identifying data, and
// that a database failure propagates rather than degrading to UNSCOPED.
// ══════════════════════════════════════════════════════════════════════════
describe('DirectoryScopeService resolver examples', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Requirement 9.2: an empty Q1 short-circuits — one query, not three
  // ────────────────────────────────────────────────────────────────────────
  describe('an empty Q1 (no Scoped_Organisations)', () => {
    // Validates: Requirements 9.2
    it('issues exactly one query and returns an empty, unconfigured scope', async () => {
      // Q1 returns no rows: the caller administers no Team, so the recursive
      // CTE selects no `parent_team_id IS NULL` root.
      pool.query.mockResolvedValueOnce({ rows: [] });

      const user = { userId: 42, is_global_manager: false };
      const scope = await DirectoryScopeService.resolveScope(user);

      // Requirement 9.2: an empty Scoped_Organisations set costs ONE query.
      // Q2 (Allowed_Domains) and Q3 (Excluded_Domains) are never issued.
      expect(pool.query).toHaveBeenCalledTimes(1);

      // The resolved scope is empty and fail-closed: no organisations, no
      // usable domains, and domainsConfigured false so Requirement 9.5's
      // explanatory copy — not the "all users are already in teams" text — is
      // what the client shows.
      expect(scope.organisations).toEqual([]);
      expect(scope.organisationIds).toEqual([]);
      expect(scope.allowedDomains).toEqual(new Set());
      expect(scope.domainsConfigured).toBe(false);

      // It is not the UNSCOPED sentinel — an empty scope hides everyone, the
      // opposite of what UNSCOPED means.
      expect(scope).not.toBe(DirectoryScopeService.UNSCOPED);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Requirement 10.4: a Global_Manager reads only the cached attribute
  // ────────────────────────────────────────────────────────────────────────
  describe('a Global_Manager', () => {
    // Validates: Requirements 10.4
    it('returns UNSCOPED and issues no query, reading only the cached attribute', async () => {
      const user = { userId: 7, is_global_manager: true };
      const scope = await DirectoryScopeService.resolveScope(user);

      // Requirement 10.1/10.4: a Global_Manager's response is not scoped at
      // all, decided from the cached `is_global_manager` attribute exactly as
      // the `user:read:team_admin` resolver does — never re-queried.
      expect(scope).toBe(DirectoryScopeService.UNSCOPED);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Requirement 14: the scoping log line is ids and counts only
  // ────────────────────────────────────────────────────────────────────────
  describe('logScopedResponse', () => {
    // The scope carries organisation NAMES (Requirement 9.3 needs them for the
    // response body), so a scope built here holds names to prove the log line
    // reduces them to ids rather than passing the object through verbatim. It
    // also carries usable Allowed_Domains to prove no domain list leaks.
    const scopeWithIdentifyingData = {
      organisations: [
        { id: 11, name: 'FENZ' },
        { id: 22, name: 'FENZ - Southland District' },
      ],
      organisationIds: [11, 22],
      allowedDomains: new Set(['fireandemergency.nz', 'fenz.govt.nz']),
      domainsConfigured: true,
    };

    // Validates: Requirements 14.1, 14.3
    it('logs a key set of route, actorId, scopedOrganisationIds, excludedCount, returnedCount, domainsConfigured', () => {
      DirectoryScopeService.logScopedResponse('GET /api/users/available', {
        userId: 99,
        scope: scopeWithIdentifyingData,
        excludedCount: 3,
        returnedCount: 5,
      });

      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      const [payload] = mockLoggerInfo.mock.calls[0];

      // Requirement 14: the requesting user's id, the Scoped_Organisation ids
      // applied, and the excluded count — plus the returned count and
      // domainsConfigured (Requirement 14.3) that distinguish an unconfigured
      // Organisation from one whose users simply did not match.
      expect(Object.keys(payload).sort()).toEqual(
        [
          'actorId',
          'domainsConfigured',
          'excludedCount',
          'returnedCount',
          'route',
          'scopedOrganisationIds',
        ].sort()
      );

      // Ids and counts only: the organisation NAMES on the scope are reduced
      // to their ids inside the function.
      expect(payload.route).toBe('GET /api/users/available');
      expect(payload.actorId).toBe(99);
      expect(payload.scopedOrganisationIds).toEqual([11, 22]);
      expect(payload.excludedCount).toBe(3);
      expect(payload.returnedCount).toBe(5);
      expect(payload.domainsConfigured).toBe(true);
    });

    // Validates: Requirements 14.2
    it('serialises to a payload holding no candidate email, name, or domain list', () => {
      DirectoryScopeService.logScopedResponse('GET /api/users/available', {
        userId: 99,
        scope: scopeWithIdentifyingData,
        excludedCount: 3,
        returnedCount: 5,
      });

      const [payload] = mockLoggerInfo.mock.calls[0];
      const serialised = JSON.stringify(payload);

      // Requirement 14.2: no user email address and no user name in the log
      // line. The scope was deliberately built to carry organisation names and
      // a domain list; none of them reaches the serialised payload, and one
      // join away, a domain list is an email address's other half.
      expect(serialised).not.toContain('FENZ');
      expect(serialised).not.toContain('Southland');
      expect(serialised).not.toContain('fireandemergency.nz');
      expect(serialised).not.toContain('fenz.govt.nz');
      expect(serialised).not.toContain('@');

      // What survives is ids and counts, so the ids the operator needs are
      // still present.
      expect(serialised).toContain('11');
      expect(serialised).toContain('22');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // No fallback: a database failure propagates, never degrades to UNSCOPED
  // ────────────────────────────────────────────────────────────────────────
  describe('a rejecting pool', () => {
    // Validates: Requirements 10.4
    it('propagates the rejection and never resolves to UNSCOPED', async () => {
      const dbError = new Error('connection reset');
      // Q1 rejects. There is deliberately no catch and no fallback in
      // resolveScope: degrading "who may this caller see" to "everyone" on a
      // database failure is Defect 2 with an error log attached.
      pool.query.mockRejectedValueOnce(dbError);

      const user = { userId: 42, is_global_manager: false };

      await expect(DirectoryScopeService.resolveScope(user)).rejects.toBe(dbError);
    });
  });
});
