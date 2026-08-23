const {
  buildDirectoryScope,
  escapeLikePattern,
  buildEmailDomainLikePatterns,
  extractEmailDomain: extractEmailDomainFn,
} = require('./directoryScope');

describe('extractEmailDomain', () => {
  it('returns the substring after the final @, lowercased (Requirement 8.3)', () => {
    expect(extractEmailDomainFn('alice@Example.COM')).toBe('example.com');
  });

  it('returns null for an address with no @ (Requirement 8.3, total predicate)', () => {
    expect(extractEmailDomainFn('not-an-email')).toBeNull();
  });

  it('uses the domain after the FINAL @ when the address holds multiple @ (Requirement 8.3)', () => {
    // final-@ semantics: everything up to and including the last @ is the
    // local part, so `a@b@evil.com` resolves to `evil.com`, not `b@evil.com`.
    expect(extractEmailDomainFn('a@b@evil.com')).toBe('evil.com');
  });

  it('returns null for a null email (Requirement 8.7, empty/absent excluded)', () => {
    expect(extractEmailDomainFn(null)).toBeNull();
  });

  it("returns null for an empty-string email (Requirement 8.7)", () => {
    expect(extractEmailDomainFn('')).toBeNull();
  });

  it('returns null when nothing follows the final @', () => {
    expect(extractEmailDomainFn('alice@')).toBeNull();
  });
});

describe('escapeLikePattern', () => {
  it('escapes backslash', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('escapes percent', () => {
    expect(escapeLikePattern('a%b')).toBe('a\\%b');
  });

  it('escapes underscore', () => {
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  it('escapes backslash first so inserted escapes are not re-escaped', () => {
    // A raw backslash followed by a percent: the backslash is doubled, the
    // percent gains one escape — the metacharacters keep their literal meaning.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
  });

  it('leaves a value with no metacharacters unchanged', () => {
    expect(escapeLikePattern('example.com')).toBe('example.com');
  });
});

describe('buildEmailDomainLikePatterns', () => {
  it('emits one %@domain pattern per usable Allowed_Domain', () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 1, name: 'Org' }],
      allowedDomains: ['example.com'],
    });
    expect(buildEmailDomainLikePatterns(scope)).toEqual(['%@example.com']);
  });

  it('escapes LIKE metacharacters in the domain so they cannot widen the match', () => {
    const scope = buildDirectoryScope({
      organisations: [{ id: 1, name: 'Org' }],
      allowedDomains: ['ex_ample.com', 'a%b.com'],
    });
    const patterns = buildEmailDomainLikePatterns(scope);
    expect(patterns).toContain('%@ex\\_ample.com');
    expect(patterns).toContain('%@a\\%b.com');
  });

  it('returns [] for an empty scope', () => {
    const scope = buildDirectoryScope({ organisations: [], allowedDomains: [] });
    expect(buildEmailDomainLikePatterns(scope)).toEqual([]);
  });

  it('returns [] for a null or malformed scope without throwing', () => {
    expect(buildEmailDomainLikePatterns(null)).toEqual([]);
    expect(buildEmailDomainLikePatterns(undefined)).toEqual([]);
    expect(buildEmailDomainLikePatterns({})).toEqual([]);
  });
});

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const {
  isCandidateVisible,
  partitionCandidates,
  extractEmailDomain,
} = require('./directoryScope');
const {
  hierarchyArb,
  adminPlacementArb,
  domainArb,
  emailArb,
  allowedDomainRowsArb,
  excludedDomainsArb,
  candidateArb,
} = require('../services/__fixtures__/directoryScopeArbitraries');

/**
 * Property-based test (design.md's Property 6: "No cross-organisation
 * disclosure", task 6.4), implemented with `fast-check` via
 * `@fast-check/jest`'s `test.prop` integration, matching the convention
 * established in `../services/TeamVisibilityService.test.js`'s Property 9.
 *
 * This is the second of the two assertions whose absence let these defects
 * ship. It is the direct unit-level statement of Requirement 8 Criteria 1
 * and 2: every candidate a Directory_Route returns to a non-Global_Manager
 * satisfies at least one condition of the disjunction for an Organisation in
 * that caller's Scoped_Organisations, and every candidate satisfying none is
 * absent.
 *
 * The expected visible set is computed by walking the generated hierarchy,
 * admin placement, and domain rows DIRECTLY -- never by calling back into
 * `buildDirectoryScope` or `isCandidateVisible`, or the test would be a
 * tautology (the discipline `TeamVisibilityService.test.js` Property 9
 * established). The scope's Organisation-id set is derived from the direct
 * admin rows' Ancestor_Chain roots; the allowed-domain set is the union of
 * the scoped Organisations' Allowed_Domains with Excluded_Domains subtracted;
 * and the three-condition disjunction is re-applied by hand.
 *
 * The independent generation of `email`, `originOrgId` and
 * `directMembershipOrgId` (see `candidateArb`) is what distinguishes the
 * additive disjunction of Requirement 13.8 from a chain of `else if`s on
 * provenance presence: a candidate whose `originOrgId` names an Organisation
 * OUTSIDE the caller's scope but whose Email_Domain matches an in-scope
 * Allowed_Domain must still be visible (Requirement 13.7's fall-through).
 */

// Feature: member-visibility-and-callsign-recompute, Property 6: No cross-organisation disclosure
describe('Property 6: No cross-organisation disclosure', () => {
  /**
   * Requirement 8.5/8.6: the caller's Scoped_Organisations are the
   * Organisations at the root of the Ancestor_Chain of each Team for which
   * the caller holds a DIRECT (`inherited_from_team_id IS NULL`)
   * `role = 'admin'` row. Derived here by walking the generated placement
   * and the hierarchy's own parent pointers, never through the resolver.
   */
  function referenceScopedOrgIds(hierarchy, placement, userId) {
    const direct = placement.directMembershipOf(userId);
    if (!direct || direct.role !== 'admin') {
      return new Set();
    }
    // The root of the administered Team's Ancestor_Chain is its Organisation.
    return new Set([hierarchy.rootOf(direct.teamId)]);
  }

  /**
   * Requirement 8.3/8.4/8.6: the usable Allowed_Domains are the union of the
   * `org_allowed_domains.domain` values of every scoped Organisation,
   * lowercased, with the Excluded_Domains (lowercased) subtracted. Computed
   * directly from the generated rows.
   */
  function referenceAllowedDomains(scopedOrgIds, allowedRows, excludedDomains) {
    const excluded = new Set(
      excludedDomains
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value !== '')
    );
    const allowed = new Set();
    for (const row of allowedRows) {
      if (!scopedOrgIds.has(row.org_id)) {
        continue;
      }
      const domain = row.domain.trim().toLowerCase();
      if (domain !== '' && !excluded.has(domain)) {
        allowed.add(domain);
      }
    }
    return allowed;
  }

  /**
   * Requirement 8.1's disjunction, re-derived by hand: a candidate is
   * visible when its `originOrgId` is in scope (Req 13.6), OR its
   * `directMembershipOrgId` is in scope (Req 8.1 second condition), OR its
   * Email_Domain resolves and is an allowed domain (Req 8.1 first condition,
   * 13.7). Additive, not a chain of `else if`s.
   */
  function referenceIsVisible(candidate, scopedOrgIds, allowedDomains) {
    if (
      candidate.originOrgId !== null &&
      candidate.originOrgId !== undefined &&
      scopedOrgIds.has(candidate.originOrgId)
    ) {
      return true;
    }
    if (
      candidate.directMembershipOrgId !== null &&
      candidate.directMembershipOrgId !== undefined &&
      scopedOrgIds.has(candidate.directMembershipOrgId)
    ) {
      return true;
    }
    const domain = extractEmailDomain(candidate.email);
    return domain !== null && allowedDomains.has(domain);
  }

  // Chain the placement, domains, rows, exclusions, and candidates off the
  // hierarchy so fast-check shrinking stays coherent and every derived set is
  // drawn from the SAME generated hierarchy. `minOrganisations: 1,
  // maxOrganisations: 3` reaches Requirement 8.6's multi-Organisation caller
  // and Requirement 12.4's shared-domain case.
  const scenarioArb = hierarchyArb({ minOrganisations: 1, maxOrganisations: 3 }).chain(
    (hierarchy) =>
      domainArb().chain((domains) =>
        fc.record({
          hierarchy: fc.constant(hierarchy),
          placement: adminPlacementArb(hierarchy),
          allowedRows: allowedDomainRowsArb(hierarchy, domains),
          excludedDomains: excludedDomainsArb(domains),
          candidates: fc.array(candidateArb(hierarchy, domains), { maxLength: 12 }),
        })
      )
  );

  test.prop([scenarioArb], { numRuns: 100 })(
    'every candidate a Directory_Route admits satisfies the scope disjunction, and every candidate satisfying none is excluded, for each candidate caller',
    ({ hierarchy, placement, allowedRows, excludedDomains, candidates }) => {
      for (const userId of placement.userIds) {
        const scopedOrgIds = referenceScopedOrgIds(hierarchy, placement, userId);
        const allowedDomains = referenceAllowedDomains(
          scopedOrgIds,
          allowedRows,
          excludedDomains
        );

        // The DirectoryScope the route would build for this caller, assembled
        // from the same raw rows the resolver hands to `buildDirectoryScope`,
        // but here we construct the arguments to `isCandidateVisible`
        // directly from the reference-computed sets so the assertion tests the
        // predicate rather than a second copy of the derivation.
        const scope = {
          organisationIds: [...scopedOrgIds],
          allowedDomains,
        };

        for (const candidate of candidates) {
          const expected = referenceIsVisible(candidate, scopedOrgIds, allowedDomains);
          const actual = isCandidateVisible(scope, candidate);
          expect(actual).toBe(expected);
        }

        // partitionCandidates is the route's actual entry point: its `visible`
        // set must be exactly the candidates the reference admits, and its
        // `excludedCount` the rest. This is Requirement 8.2's "exclude every
        // candidate satisfying no condition" stated over the whole set.
        const { visible, excludedCount } = partitionCandidates(
          scope,
          candidates,
          (candidate) => candidate
        );
        const expectedVisible = candidates.filter((candidate) =>
          referenceIsVisible(candidate, scopedOrgIds, allowedDomains)
        );
        expect(visible).toEqual(expectedVisible);
        expect(excludedCount).toBe(candidates.length - expectedVisible.length);

        // No candidate the route admits may lie outside the scope disjunction
        // (Requirement 8.1/8.2/15.2: no cross-organisation disclosure).
        for (const candidate of visible) {
          expect(referenceIsVisible(candidate, scopedOrgIds, allowedDomains)).toBe(true);
        }
      }
    }
  );
});

/**
 * Property-based test (design.md's Property 8: "A Global_Manager's view is a
 * superset", task 6.5), implemented with `fast-check` via `@fast-check/jest`'s
 * `test.prop` integration, matching the convention of Property 6 above and of
 * `../services/TeamVisibilityService.test.js`'s Property 9.
 *
 * Requirements 9.8, 10.1, 10.2, 10.3, 12.2. A Global_Manager has no
 * Organisation scoping applied to any Directory_Route: the response holds
 * every candidate the route's base filters admit, including candidates whose
 * Email_Domain matches no Allowed_Domain of any Organisation (Req 10.2) and
 * candidates matching no Organisation at all (Req 12.2). A caller who is NOT a
 * Global_Manager sees, for the same request, only the subset that the scope
 * disjunction of Requirement 8 Criterion 1 admits. The Global_Manager's set
 * therefore CONTAINS the scoped caller's set for every scope and every
 * candidate set (Req 10.1).
 *
 * The pure module models a Global_Manager as the UNSCOPED sentinel that
 * `DirectoryScopeService` resolves at the service layer and that the routes
 * short-circuit BEFORE calling `isCandidateVisible` -- `isCandidateVisible` is
 * only ever asked about a scoped caller. The superset property is therefore
 * expressed at the level this pure module supports: the Global_Manager's view
 * is the candidate set with NO scope filter applied (every candidate the base
 * filters produced), and the property asserts that every candidate a scoped
 * caller can see is also in that unscoped set -- i.e. `partitionCandidates`'s
 * `visible` set for any scope is a subset of the full candidate set.
 *
 * Both sides are computed by walking the generated data directly. The
 * Global_Manager side is the generated candidate array itself (no filter); the
 * scoped side is derived by re-applying the three-condition disjunction by
 * hand from the reference-computed Scoped_Organisation and Allowed_Domain
 * sets, exactly as Property 6 does -- never by calling `isCandidateVisible` to
 * produce the expectation. `partitionCandidates` is then exercised to confirm
 * the implementation's scoped set is that same subset.
 */

// Feature: member-visibility-and-callsign-recompute, Property 8: A Global_Manager's view is a superset
describe('Property 8: A Global_Manager\'s view is a superset', () => {
  /**
   * Requirement 8.5/8.6: the caller's Scoped_Organisations are the
   * Organisations at the root of the Ancestor_Chain of each Team for which the
   * caller holds a DIRECT (`inherited_from_team_id IS NULL`) `role = 'admin'`
   * row. Walked from the generated placement and hierarchy, not the resolver.
   */
  function referenceScopedOrgIds(hierarchy, placement, userId) {
    const direct = placement.directMembershipOf(userId);
    if (!direct || direct.role !== 'admin') {
      return new Set();
    }
    return new Set([hierarchy.rootOf(direct.teamId)]);
  }

  /**
   * Requirement 8.3/8.4/8.6: the usable Allowed_Domains are the union of the
   * scoped Organisations' `org_allowed_domains.domain` values, lowercased,
   * with the Excluded_Domains subtracted case-insensitively. Computed directly
   * from the generated rows.
   */
  function referenceAllowedDomains(scopedOrgIds, allowedRows, excludedDomains) {
    const excluded = new Set(
      excludedDomains
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value !== '')
    );
    const allowed = new Set();
    for (const row of allowedRows) {
      if (!scopedOrgIds.has(row.org_id)) {
        continue;
      }
      const domain = row.domain.trim().toLowerCase();
      if (domain !== '' && !excluded.has(domain)) {
        allowed.add(domain);
      }
    }
    return allowed;
  }

  /**
   * Requirement 8.1's disjunction, re-derived by hand (additive, not a chain
   * of `else if`s): visible when `originOrgId` is in scope (Req 13.6), OR
   * `directMembershipOrgId` is in scope (Req 8.1 second condition), OR the
   * Email_Domain resolves and is an allowed domain (Req 8.1 first condition,
   * 13.7).
   */
  function referenceScopedVisible(candidate, scopedOrgIds, allowedDomains) {
    if (
      candidate.originOrgId !== null &&
      candidate.originOrgId !== undefined &&
      scopedOrgIds.has(candidate.originOrgId)
    ) {
      return true;
    }
    if (
      candidate.directMembershipOrgId !== null &&
      candidate.directMembershipOrgId !== undefined &&
      scopedOrgIds.has(candidate.directMembershipOrgId)
    ) {
      return true;
    }
    const domain = extractEmailDomain(candidate.email);
    return domain !== null && allowedDomains.has(domain);
  }

  // Same scenario shape as Property 6: every derived set is drawn from the
  // SAME generated hierarchy so shrinking stays coherent, and
  // `minOrganisations: 1, maxOrganisations: 3` reaches the multi-Organisation
  // caller (Req 8.6) and the shared-domain case (Req 12.4).
  const scenarioArb = hierarchyArb({ minOrganisations: 1, maxOrganisations: 3 }).chain(
    (hierarchy) =>
      domainArb().chain((domains) =>
        fc.record({
          hierarchy: fc.constant(hierarchy),
          placement: adminPlacementArb(hierarchy),
          allowedRows: allowedDomainRowsArb(hierarchy, domains),
          excludedDomains: excludedDomainsArb(domains),
          candidates: fc.array(candidateArb(hierarchy, domains), { maxLength: 12 }),
        })
      )
  );

  test.prop([scenarioArb], { numRuns: 100 })(
    'the set visible to a scoped caller is a subset of the candidate set an unscoped Global_Manager sees, for every scope and every candidate caller',
    ({ hierarchy, placement, allowedRows, excludedDomains, candidates }) => {
      // A Global_Manager applies NO scope filter (Req 10.1): the route
      // short-circuits before the predicate, so the Global_Manager's view is
      // every candidate the base filters produced -- here, the generated
      // candidate array itself.
      const globalManagerView = candidates;

      for (const userId of placement.userIds) {
        const scopedOrgIds = referenceScopedOrgIds(hierarchy, placement, userId);
        const allowedDomains = referenceAllowedDomains(
          scopedOrgIds,
          allowedRows,
          excludedDomains
        );

        // The scoped caller's visible set, derived by hand from the reference
        // sets -- never by calling the implementation to produce it.
        const scopedVisibleExpected = candidates.filter((candidate) =>
          referenceScopedVisible(candidate, scopedOrgIds, allowedDomains)
        );

        // Requirement 10.1/10.2/12.2: every candidate a scoped caller can see
        // is also in the Global_Manager's unscoped view. The superset holds
        // regardless of whether the candidate matches any Organisation, so a
        // Global_Manager never loses a candidate a scoped caller retained.
        for (const candidate of scopedVisibleExpected) {
          expect(globalManagerView).toContain(candidate);
        }

        // The implementation's scoped set (via partitionCandidates, the route
        // entry point) must equal the reference subset -- so the subset the
        // superset relation is asserted over is the one the code actually
        // produces, closing the gap between the reference and the predicate.
        const scope = {
          organisationIds: [...scopedOrgIds],
          allowedDomains,
        };
        const { visible: scopedVisibleActual } = partitionCandidates(
          scope,
          candidates,
          (candidate) => candidate
        );
        expect(scopedVisibleActual).toEqual(scopedVisibleExpected);

        // And the same subset relation over the implementation's own output:
        // the Global_Manager (unscoped) set contains the scoped set (Req 10.1).
        for (const candidate of scopedVisibleActual) {
          expect(globalManagerView).toContain(candidate);
        }
        expect(scopedVisibleActual.length).toBeLessThanOrEqual(globalManagerView.length);
      }
    }
  );
});

/**
 * Property-based test (design.md's Property 7: "Fail closed on an
 * unconfigured organisation", task 8.2), implemented with `fast-check` via
 * `@fast-check/jest`'s `test.prop` integration, matching the convention of
 * Properties 6 and 8 above and of `../services/TeamVisibilityService.test.js`'s
 * Property 9.
 *
 * Requirements 9.1, 9.2. A caller who is not a Global_Manager and whose
 * Scoped_Organisations either (a) is empty, or (b) holds no Organisation with
 * an Allowed_Domain surviving the Excluded_Domains subtraction, sees an empty
 * available-users list. For such a scope, `domainsConfigured` is `false`,
 * `buildEmailDomainLikePatterns` returns `[]` (so the SQL `x LIKE ANY('{}')`
 * pre-narrowing is `false` for every row — Requirement 9.2), and, given
 * candidates none of which carries a provenance or Direct_Membership
 * Organisation inside the (possibly empty) scope, `isCandidateVisible` returns
 * `false` for every candidate and `partitionCandidates` yields an empty
 * `visible` set with `excludedCount === candidates.length`. That is the
 * fail-closed result: everything is hidden.
 *
 * The two branches of the antecedent are generated as one `oneof`: branch (a)
 * builds the scope from an EMPTY organisations set; branch (b) builds it from
 * a NON-EMPTY organisations set whose every Allowed_Domain row is also an
 * Excluded_Domain, so the surviving allowed set is empty. Both must produce
 * the identical fail-closed behaviour.
 *
 * The expected result is computed DIRECTLY — every candidate is hidden, so the
 * expectation is a constant (`false` per candidate, an empty `visible` set,
 * `excludedCount` equal to the candidate count) — never by calling
 * `isCandidateVisible` to derive it. Candidates are generated with
 * `originOrgId` and `directMembershipOrgId` drawn from an Organisation-id pool
 * DISJOINT from the scope's `organisationIds` (or `null`), so no candidate
 * carries matching provenance; their emails range over any domain, listed or
 * not, since with an empty allowed set no domain can match regardless.
 */

// Feature: member-visibility-and-callsign-recompute, Property 7: Fail closed on an unconfigured organisation
describe('Property 7: Fail closed on an unconfigured organisation', () => {
  // An Organisation id that never appears in any generated hierarchy: the
  // hierarchy ids start at 1 and stay well below this, so candidates carrying
  // this value have provenance/Direct_Membership OUTSIDE any scope's
  // organisationIds — the "no matching provenance" precondition of the property.
  const OUT_OF_SCOPE_ORG_IDS = [900001, 900002, 900003];

  // A candidate whose email is drawn from any domain in play and whose
  // originOrgId / directMembershipOrgId are either null or an out-of-scope
  // Organisation id — never one of the scope's own Organisations.
  function unmatchedCandidateArb(domains) {
    const orgIdOrNull = fc.oneof(
      { arbitrary: fc.constant(null), weight: 1 },
      { arbitrary: fc.constantFrom(...OUT_OF_SCOPE_ORG_IDS), weight: 2 }
    );
    return fc.record({
      email: emailArb(domains),
      originOrgId: orgIdOrNull,
      directMembershipOrgId: orgIdOrNull,
    });
  }

  // Branch (a): an EMPTY Scoped_Organisations set. No organisations, no allowed
  // domains — an unconfigured caller.
  const emptyOrgScopeArb = domainArb().chain((domains) =>
    fc.record({
      scope: fc.constant(buildDirectoryScope({ organisations: [], allowedDomains: [] })),
      candidates: fc.array(unmatchedCandidateArb(domains), { maxLength: 12 }),
    })
  );

  // Branch (b): a NON-EMPTY Scoped_Organisations set whose every Allowed_Domain
  // is subtracted by Excluded_Domains, so the surviving allowedDomains set is
  // empty. The scope's organisationIds are the generated hierarchy's, and every
  // candidate's provenance is drawn from OUT_OF_SCOPE_ORG_IDS (disjoint), so no
  // candidate matches on provenance either.
  const subtractedDomainScopeArb = hierarchyArb({
    minOrganisations: 1,
    maxOrganisations: 3,
  }).chain((hierarchy) =>
    domainArb().chain((domains) => {
      const orgs = hierarchy.organisationIds.map((id) => ({ id, name: `Org ${id}` }));
      return allowedDomainRowsArb(hierarchy, domains).chain((allowedRows) => {
        const allowedDomains = allowedRows.map((row) => row.domain);
        return fc.record({
          // Exclude EVERY domain that could possibly be allowed — both the
          // generated allowed-row domains and the full domain pool — so the
          // subtraction leaves the surviving set empty regardless of which
          // rows were drawn.
          scope: fc.constant(
            buildDirectoryScope({
              organisations: orgs,
              allowedDomains,
              excludedDomains: [...allowedDomains, ...domains],
            })
          ),
          candidates: fc.array(unmatchedCandidateArb(domains), { maxLength: 12 }),
        });
      });
    })
  );

  const scenarioArb = fc.oneof(emptyOrgScopeArb, subtractedDomainScopeArb);

  test.prop([scenarioArb], { numRuns: 100 })(
    'an empty or fully-subtracted scope reports domainsConfigured false, emits no LIKE patterns, and hides every candidate lacking matching provenance',
    ({ scope, candidates }) => {
      // The scope is unconfigured: no Allowed_Domain survived (Requirement 9.4).
      expect(scope.domainsConfigured).toBe(false);
      expect(scope.allowedDomains.size).toBe(0);

      // The SQL pre-narrowing degenerates to `x LIKE ANY('{}')`, which is
      // `false` for every row — the fail-closed value with no special case
      // (Requirement 9.2).
      expect(buildEmailDomainLikePatterns(scope)).toEqual([]);

      // Every candidate is hidden: none carries provenance or a
      // Direct_Membership Organisation inside the (possibly empty) scope, and
      // no domain can match an empty allowed set. Expectation computed
      // directly (everything hidden), never by calling isCandidateVisible.
      for (const candidate of candidates) {
        expect(isCandidateVisible(scope, candidate)).toBe(false);
      }

      // partitionCandidates — the route's entry point — yields an empty
      // visible set and counts every candidate as excluded (Requirement 9.1).
      const { visible, excludedCount } = partitionCandidates(
        scope,
        candidates,
        (candidate) => candidate
      );
      expect(visible).toEqual([]);
      expect(excludedCount).toBe(candidates.length);
    }
  );
});
