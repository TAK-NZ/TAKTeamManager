/**
 * Shared `fast-check` generators for the directory-scoping property tests
 * (spec `member-visibility-and-callsign-recompute`, task 6.3).
 *
 * Properties 6, 7, 8, 10, 15, 17 and 19 all need the same raw material --
 * a Team hierarchy, where the admins sit, the Allowed_Domains hanging off
 * each Organisation, the Excluded_Domains subtracted from them, and the
 * candidate users whose `email`, `origin_org_id` and Direct_Membership
 * Organisation the predicate in `server/utils/directoryScope.js` decides
 * against -- so the email/domain half of that material lives here once
 * rather than being rebuilt in each test file.
 *
 * This is a SEPARATE module from `transferArbitraries.js` rather than an
 * addition to it. That file is documented as the team-member-transfer
 * fixture set and is consumed by six of its test files; a shared-fixture
 * module that accumulates every feature's arbitraries becomes a file every
 * suite must load to run any property. What this module does NOT rebuild
 * is the hierarchy and admin placement: `hierarchyArb` and
 * `adminPlacementArb` are REQUIRED from `transferArbitraries.js` and
 * re-exported, never duplicated. They already generate an Organisation
 * root plus Sub_Teams to `MAX_TEAM_DEPTH` and place direct admin rows at
 * arbitrary depth, which is exactly what Property 6 needs for its
 * Direct_Membership and provenance conditions; `hierarchyArb`'s
 * `minOrganisations` option is what makes Requirement 8.6's
 * multi-Organisation caller and Requirement 12.4's shared-domain case
 * reachable.
 *
 * Everything generated here is plain data. Nothing in this module calls
 * into the code under test (`buildDirectoryScope`, `isCandidateVisible`),
 * so a property consuming these arbitraries must compute its expected
 * visible set by walking the generated hierarchy and domain rows directly,
 * never by a second call into the implementation, or the test is a
 * tautology.
 *
 * Usage sketch:
 *
 *   const {
 *     hierarchyArb, adminPlacementArb,
 *     domainArb, emailArb, allowedDomainRowsArb,
 *     excludedDomainsArb, candidateArb
 *   } = require('./__fixtures__/directoryScopeArbitraries');
 *
 *   const scenarioArb = hierarchyArb({ minOrganisations: 1, maxOrganisations: 3 })
 *     .chain((hierarchy) =>
 *       domainArb().chain((domains) =>
 *         fc.record({
 *           hierarchy: fc.constant(hierarchy),
 *           domains: fc.constant(domains),
 *           allowedRows: allowedDomainRowsArb(hierarchy, domains),
 *           excluded: excludedDomainsArb(domains),
 *           candidates: fc.array(candidateArb(hierarchy, domains))
 *         })
 *       )
 *     );
 */

const fc = require('fast-check');
const {
  hierarchyArb,
  adminPlacementArb
} = require('./transferArbitraries');

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/**
 * The `%` and `_` LIKE metacharacters and the suffix-overlap pair are
 * fixed rather than generated so a counterexample naming one is instantly
 * recognisable as the trap it exercises. `org_allowed_domains.domain` is
 * admin-supplied text: a domain containing `_` would match any single
 * character in that position under a naive LIKE pattern and one containing
 * `%` would match arbitrarily, both widening visibility beyond the literal
 * domain (the trap `escapeLikePattern` in `directoryScope.js` closes). The
 * `example.com` / `evil-example.com` pair is the suffix-match trap: a
 * substring or `endsWith` comparison would wrongly treat the second as
 * matching the first.
 */
const METACHARACTER_DOMAINS = ['ex_ample.com', 'ex%ample.com'];
const SUFFIX_OVERLAP_DOMAINS = ['example.com', 'evil-example.com'];

/**
 * A plain lowercase label-dot-tld domain, the ordinary case the scoping is
 * mostly about.
 */
const plainDomainArb = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/),
    fc.constantFrom('com', 'org', 'net', 'govt.nz', 'mil.nz')
  )
  .map(([label, tld]) => `${label}.${tld}`);

/**
 * Produce a mixed-case variant of a domain: the SAME domain differing only
 * in the case of its letters. Requirement 8.3 compares case-insensitively,
 * so a property needs the same domain to appear both lowercase (as stored)
 * and mixed-case (as it might arrive in an email) to mean anything.
 *
 * @param {string} domain a lowercase domain
 * @returns {fc.Arbitrary<string>}
 */
function mixedCaseVariantArb(domain) {
  return fc
    .array(fc.boolean(), { minLength: domain.length, maxLength: domain.length })
    .map((flips) =>
      Array.from(domain)
        .map((character, index) => (flips[index] ? character.toUpperCase() : character))
        .join('')
    );
}

/**
 * Generates a small set of domains covering, together in one draw:
 * lowercase domains, a mixed-case variant of one of them (the same domain,
 * different case), domains containing `_` and `%`, and a suffix-overlapping
 * pair (`example.com` / `evil-example.com`).
 *
 * The returned array holds the domains as strings, in no particular order
 * and possibly with duplicates once the mixed-case variant coincides with
 * its lowercase source (a single-letter or digit-only label). A consumer
 * that needs unique lowercased domains should normalise, exactly as
 * `buildDirectoryScope` does.
 *
 * @param {Object} [options]
 * @param {number} [options.minPlain=1] plain lowercase domains to draw
 * @param {number} [options.maxPlain=3]
 * @returns {fc.Arbitrary<string[]>}
 */
function domainArb(options = {}) {
  const { minPlain = 1, maxPlain = 3 } = options;

  return fc
    .uniqueArray(plainDomainArb, { minLength: minPlain, maxLength: maxPlain })
    .chain((plain) =>
      // A mixed-case variant of the first plain domain, so the same domain
      // is present in two cases within a single generated set.
      mixedCaseVariantArb(plain[0]).map((mixed) => [
        ...plain,
        mixed,
        ...METACHARACTER_DOMAINS,
        ...SUFFIX_OVERLAP_DOMAINS
      ])
    );
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

/**
 * A local-part for an email address. Kept simple and ASCII: the scoping
 * decision is entirely about the domain (the substring after the final
 * `@`), so the local-part only needs to be present, and sometimes to
 * itself contain an `@` so the final-`@` rule of Requirement 8.3 is
 * exercised.
 */
const localPartArb = fc.stringMatching(/^[a-z][a-z0-9.]{0,9}$/);

/**
 * Generates an email address drawn from the whole input space the scoping
 * predicate must survive, given the domains in play:
 *
 *   - an address at one of the LISTED `domains` (mixed-case included, so
 *     the case-insensitive match of Requirement 8.3 is exercised)
 *   - an address at an UNLISTED domain (matches no Organisation)
 *   - an address with MULTIPLE `@`, so the final-`@` rule is exercised
 *   - an address with NO `@` at all
 *   - the empty string `''`
 *   - `null`
 *
 * The last three are Requirement 8.7's empty/absent email, each of which
 * `extractEmailDomain` must map to `null` and the predicate must reject.
 *
 * @param {string[]} domains the LISTED domains (as from `domainArb`)
 * @returns {fc.Arbitrary<string|null>}
 */
function emailArb(domains) {
  const listedDomains = Array.isArray(domains) && domains.length > 0 ? domains : ['listed.example'];

  const atListedDomain = fc
    .tuple(localPartArb, fc.constantFrom(...listedDomains))
    .map(([local, domain]) => `${local}@${domain}`);

  const atUnlistedDomain = fc
    .tuple(localPartArb, plainDomainArb)
    .map(([local, domain]) => `${local}@unlisted-${domain}`);

  // A leading `foo@` before a listed domain: two `@`, and the FINAL-`@`
  // domain is still a listed one, so the final-`@` rule and the
  // first-`@` bug (`split_part(email, '@', 2)`) disagree here.
  const multipleAt = fc
    .tuple(localPartArb, localPartArb, fc.constantFrom(...listedDomains))
    .map(([a, b, domain]) => `${a}@${b}@${domain}`);

  const noAt = localPartArb;

  return fc.oneof(
    { arbitrary: atListedDomain, weight: 4 },
    { arbitrary: atUnlistedDomain, weight: 3 },
    { arbitrary: multipleAt, weight: 2 },
    { arbitrary: noAt, weight: 1 },
    { arbitrary: fc.constant(''), weight: 1 },
    { arbitrary: fc.constant(null), weight: 1 }
  );
}

// ---------------------------------------------------------------------------
// Allowed-domain rows
// ---------------------------------------------------------------------------

/**
 * Generates the `org_allowed_domains` rows over an already-generated
 * hierarchy: `{ org_id, domain }` pairs drawn from the generated
 * Organisation ids and the generated `domains`.
 *
 * The draw deliberately reaches two cases the properties depend on:
 *
 *   - the SAME domain listed under TWO Organisations. The unique
 *     constraint on `org_allowed_domains` is `(org_id, domain)`, not
 *     `domain` alone, so a shared domain is a legitimate configuration
 *     that makes a teamless user visible to the Team_Admins of both
 *     Organisations (Requirement 12.4).
 *   - an Organisation with NO rows at all, which under Requirement 9.1
 *     yields an empty available-users list for its Team_Admin.
 *
 * Each Organisation independently draws a (possibly empty) subset of
 * `domains`, so both extremes and everything between occur across runs. No
 * `(org_id, domain)` pair is emitted twice for the same Organisation,
 * matching the unique constraint; the same domain under two DIFFERENT
 * Organisations is allowed and is the point.
 *
 * @param {import('./transferArbitraries').Hierarchy} hierarchy
 * @param {string[]} domains the domains in play (as from `domainArb`)
 * @returns {fc.Arbitrary<Array<{ org_id: number, domain: string }>>}
 */
function allowedDomainRowsArb(hierarchy, domains) {
  const orgIds = hierarchy.organisationIds;
  const pool = Array.isArray(domains) && domains.length > 0 ? domains : [];

  return fc
    .tuple(
      ...orgIds.map(() =>
        pool.length > 0
          ? fc.uniqueArray(fc.constantFrom(...pool), { minLength: 0, maxLength: pool.length })
          : fc.constant([])
      )
    )
    .map((perOrgDomains) => {
      const rows = [];
      orgIds.forEach((orgId, index) => {
        for (const domain of perOrgDomains[index]) {
          rows.push({ org_id: orgId, domain });
        }
      });
      return rows;
    });
}

// ---------------------------------------------------------------------------
// Excluded domains
// ---------------------------------------------------------------------------

/**
 * Generates the Excluded_Domains list: a subset of the generated
 * `domains`, sometimes empty and sometimes overlapping every Allowed_Domain.
 *
 * Requirement 8.4 subtracts Excluded_Domains from the Allowed_Domains of
 * every Organisation before matching, so a property asserting it needs the
 * excluded set to range from empty (subtracts nothing) through a proper
 * subset (subtracts some) to the whole set of domains (subtracts every
 * possible Allowed_Domain, the fail-closed case of Requirement 9.1).
 *
 * @param {string[]} domains the domains in play (as from `domainArb`)
 * @returns {fc.Arbitrary<string[]>}
 */
function excludedDomainsArb(domains) {
  const pool = Array.isArray(domains) ? domains : [];
  if (pool.length === 0) {
    return fc.constant([]);
  }
  return fc.oneof(
    { arbitrary: fc.constant([]), weight: 2 },
    {
      arbitrary: fc.uniqueArray(fc.constantFrom(...pool), {
        minLength: 1,
        maxLength: pool.length
      }),
      weight: 3
    },
    // The whole set: every Allowed_Domain is excluded, so no domain match
    // can ever succeed (Requirement 9.1's fail-closed case).
    { arbitrary: fc.constant([...pool]), weight: 1 }
  );
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * Generates a candidate user's facts as the predicate sees them:
 * `{ email, originOrgId, directMembershipOrgId }`.
 *
 * The three fields are varied INDEPENDENTLY. `email` is drawn from
 * `emailArb` (present-at-a-listed-domain, present-at-an-unlisted-domain,
 * or absent); `originOrgId` is a generated Organisation id or `null`; and
 * `directMembershipOrgId` is a generated Organisation id or `null` --
 * each chosen without reference to the others. Because each of the three
 * is independently either "present/matching" or "absent/non-matching",
 * all eight presence combinations occur across a run.
 *
 * That independence is the whole point of this arbitrary. A generator that
 * only ever set `originOrgId` on candidates whose email already matched
 * would never distinguish Requirement 13.8's additive disjunction from a
 * chain of `else if`s on provenance presence, which is the specific
 * mistake Property 6 exists to catch. `originOrgId` is drawn from the SAME
 * Organisation-id pool as the caller's scope so that a non-null value both
 * inside and outside the caller's Scoped_Organisations is reachable
 * (Requirement 13.6 versus the 13.7 fall-through).
 *
 * `directMembershipOrgId` names the root Organisation of a candidate's
 * Direct_Membership Team, already resolved (the route resolves it to the
 * Ancestor_Chain root before calling the predicate), so it is drawn
 * directly from the Organisation ids rather than from arbitrary Team ids.
 *
 * @param {import('./transferArbitraries').Hierarchy} hierarchy
 * @param {string[]} domains the domains in play (as from `domainArb`)
 * @returns {fc.Arbitrary<{ email: string|null, originOrgId: number|null, directMembershipOrgId: number|null }>}
 */
function candidateArb(hierarchy, domains) {
  const orgIds = hierarchy.organisationIds;

  // `null` = no provenance / no Direct_Membership; a value = an
  // Organisation id, which may or may not be in the caller's scope.
  const orgIdOrNull = fc.oneof(
    { arbitrary: fc.constant(null), weight: 1 },
    { arbitrary: fc.constantFrom(...orgIds), weight: 2 }
  );

  return fc.record({
    email: emailArb(domains),
    originOrgId: orgIdOrNull,
    directMembershipOrgId: orgIdOrNull
  });
}

module.exports = {
  // Reused, NOT duplicated (see module header): the hierarchy and admin
  // placement come from the team-member-transfer fixture set.
  hierarchyArb,
  adminPlacementArb,

  // Fixed domain sets, exported so a test can assert a specific trap is
  // present in a generated set without re-deriving the constants.
  METACHARACTER_DOMAINS,
  SUFFIX_OVERLAP_DOMAINS,

  // Arbitrary factories new to directory scoping.
  domainArb,
  emailArb,
  allowedDomainRowsArb,
  excludedDomainsArb,
  candidateArb
};
