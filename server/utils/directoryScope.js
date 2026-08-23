/**
 * Directory scoping: the pure predicate and per-request scope construction
 * (Requirement 8: Organisation Scoping of the Available Users List;
 * Requirement 9: Fail-Closed Behaviour; Requirement 11: The Same Scoping on
 * the Other Directory Routes; Requirement 12: Users Matching No Organisation;
 * Requirement 13: Organisation Provenance Recorded at User Creation).
 *
 * This module is PURE. It requires no `pool`, no logger, and contains no
 * `async` function. That is deliberate: `isCandidateVisible`,
 * `buildDirectoryScope` and `partitionCandidates` are the single decision
 * point for who may see whom, and keeping them free of I/O is what makes
 * Properties 6, 7 and 8 direct unit-level assertions costing microseconds per
 * iteration rather than end-to-end ones.
 *
 * SQL never decides visibility; SQL only supplies facts and, on the two
 * routes whose source is SQL, pre-narrows so a `LIMIT` still returns a useful
 * page. Every Directory_Route runs `isCandidateVisible` over every row it is
 * about to return, including rows the SQL already admitted, which bounds the
 * blast radius of any SQL/predicate drift to *hiding* a visible user rather
 * than *disclosing* a hidden one.
 *
 * Task 6.2 adds `escapeLikePattern` and `buildEmailDomainLikePatterns` to this
 * same file as the single producer of the SQL LIKE patterns; the module is
 * structured with a grouped `module.exports` at the foot to accommodate that
 * addition without disturbing what is exported here.
 */

/**
 * @typedef {object} ScopedOrganisation
 * @property {number} id
 * @property {string} name
 *
 * @typedef {object} DirectoryScope
 * @property {ScopedOrganisation[]} organisations   Requirement 9.3's `scope.organisations`
 * @property {number[]} organisationIds             Requirement 8.5's Scoped_Organisations
 * @property {Set<string>} allowedDomains           usable Allowed_Domains, lowercased,
 *                                                  Excluded_Domains already subtracted (Req 8.4),
 *                                                  flattened across every Organisation (Req 8.6)
 * @property {boolean} domainsConfigured            Requirement 9.4
 *
 * @typedef {object} CandidateFacts
 * @property {string|null|undefined} email
 * @property {number|null|undefined} originOrgId              users.origin_org_id (Req 13.6/13.7)
 * @property {number|null|undefined} directMembershipOrgId    root of the Direct_Membership Team's
 *                                                            Ancestor_Chain (Req 8.1)
 */

/**
 * Requirement 8.3: the Email_Domain is the substring following the FINAL `@`
 * of an email address, compared case-insensitively.
 *
 * `split_part(email, '@', 2)` is NOT this — it takes the substring after the
 * FIRST `@`. `lastIndexOf('@')` gives the final-`@` semantics the requirement
 * names. Total: any non-string, empty, or `@`-less value yields `null`, and
 * an `@` with nothing after it also yields `null`.
 *
 * @param {string|null|undefined} email
 * @returns {string|null} the lowercased domain, or `null` when absent.
 */
function extractEmailDomain(email) {
  if (typeof email !== 'string') {
    return null;
  }
  const at = email.lastIndexOf('@');
  if (at === -1) {
    return null;
  }
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain === '' ? null : domain;
}

/**
 * Trim and lowercase a raw domain string, or return `null` for a non-string
 * or empty value. Used to normalise both `org_allowed_domains.domain` values
 * and Excluded_Domains entries so no caller has to remember to.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function normaliseDomain(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalised = value.trim().toLowerCase();
  return normalised === '' ? null : normalised;
}

/**
 * Requirements 8.3, 8.4, 8.6, 9.4. Builds the per-request DirectoryScope from
 * raw rows.
 *
 * Every usable Allowed_Domain of every Organisation is flattened into one
 * lowercased `Set` (Requirement 8.6 makes the rule a union across the caller's
 * Organisations, so per-Organisation attribution would be computed and then
 * immediately discarded), and Excluded_Domains is subtracted from that set
 * case-insensitively (Requirement 8.4). `domainsConfigured` is `true` exactly
 * when the surviving set is non-empty (Requirement 9.4).
 *
 * `allowedDomains` and `excludedDomains` are arrays of raw strings as read
 * from `org_allowed_domains.domain` and the `excluded_email_domains` JSON
 * array; both are normalised here. Every parameter tolerates `undefined` and
 * a non-array value, yielding an empty scope rather than throwing.
 *
 * @param {object} input
 * @param {ScopedOrganisation[]} [input.organisations]
 * @param {string[]} [input.allowedDomains]
 * @param {string[]} [input.excludedDomains]
 * @returns {DirectoryScope}
 */
function buildDirectoryScope({ organisations, allowedDomains, excludedDomains } = {}) {
  const orgs = Array.isArray(organisations) ? organisations : [];
  const rawAllowed = Array.isArray(allowedDomains) ? allowedDomains : [];
  const rawExcluded = Array.isArray(excludedDomains) ? excludedDomains : [];

  const excluded = new Set();
  for (const value of rawExcluded) {
    const domain = normaliseDomain(value);
    if (domain !== null) {
      excluded.add(domain);
    }
  }

  const allowed = new Set();
  for (const value of rawAllowed) {
    const domain = normaliseDomain(value);
    if (domain !== null && !excluded.has(domain)) {
      allowed.add(domain);
    }
  }

  return {
    organisations: orgs,
    organisationIds: orgs.map((org) => org.id),
    allowedDomains: allowed,
    domainsConfigured: allowed.size > 0,
  };
}

/**
 * The one decision point: may this caller see this candidate?
 *
 * A DISJUNCTION over the three conditions in the design's flowchart, in this
 * exact order (Requirement 13.8 makes provenance additive rather than a
 * replacement, so a non-null `originOrgId` naming an Organisation OUTSIDE the
 * caller's scope must fall through to the domain check rather than
 * short-circuit to hidden):
 *
 *   1. `originOrgId` is non-null AND in `scope.organisationIds` (Req 13.6)
 *   2. `directMembershipOrgId` is non-null AND in `scope.organisationIds`
 *      (Req 8.1's second condition)
 *   3. the candidate's Email_Domain is resolvable AND `scope.allowedDomains`
 *      contains it (Req 8.1's first condition, 13.7)
 *
 * TOTAL: it never throws for any input shape. A `null`, `''`, or `@`-less
 * email, an `undefined` origin, an empty `organisationIds`, and a missing or
 * malformed `scope` each yield `false`. A throwing predicate inside a
 * `.filter()` would surface as a 500 and tempt a `catch` that falls back to
 * unfiltered — the exact fail-OPEN direction Defect 2 is about.
 *
 * @param {DirectoryScope|null|undefined} scope
 * @param {CandidateFacts|null|undefined} facts
 * @returns {boolean}
 */
function isCandidateVisible(scope, facts) {
  if (!scope || !facts) {
    return false;
  }

  const organisationIds = Array.isArray(scope.organisationIds) ? scope.organisationIds : [];

  const { originOrgId, directMembershipOrgId } = facts;

  // Condition 1: provenance (Requirement 13.6).
  if (originOrgId !== null && originOrgId !== undefined && organisationIds.includes(originOrgId)) {
    return true;
  }

  // Condition 2: Direct_Membership Organisation (Requirement 8.1 second condition).
  if (
    directMembershipOrgId !== null &&
    directMembershipOrgId !== undefined &&
    organisationIds.includes(directMembershipOrgId)
  ) {
    return true;
  }

  // Condition 3: Email_Domain match (Requirement 8.1 first condition, 13.7).
  const domain = extractEmailDomain(facts.email);
  if (domain !== null && scope.allowedDomains instanceof Set && scope.allowedDomains.has(domain)) {
    return true;
  }

  return false;
}

/**
 * Requirement 14.1's excluded count and a route's filtering in one pass.
 *
 * `toFacts` maps a route-shaped row to CandidateFacts, so each Directory_Route
 * keeps its own row shape and this function stays shape-agnostic. Returns the
 * kept rows in their original shape plus the count of rows the predicate
 * rejected.
 *
 * @template T
 * @param {DirectoryScope} scope
 * @param {T[]} rows
 * @param {(row: T) => CandidateFacts} toFacts
 * @returns {{ visible: T[], excludedCount: number }}
 */
function partitionCandidates(scope, rows, toFacts) {
  const source = Array.isArray(rows) ? rows : [];
  const visible = [];
  let excludedCount = 0;

  for (const row of source) {
    if (isCandidateVisible(scope, toFacts(row))) {
      visible.push(row);
    } else {
      excludedCount += 1;
    }
  }

  return { visible, excludedCount };
}

/**
 * Escape the LIKE metacharacters in a single value so it matches literally.
 *
 * `\`, `%` and `_` are the three characters LIKE treats specially: `%` matches
 * any run of characters, `_` matches any single character, and `\` is
 * Postgres's default escape character. Backslash MUST be escaped first — were
 * `%` or `_` escaped before it, the `\` this function inserts would itself be
 * escaped again on the backslash pass, doubling every escape and corrupting
 * the pattern.
 *
 * `org_allowed_domains.domain` is admin-supplied text; a domain containing `_`
 * would otherwise match any single character in that position and one
 * containing `%` would match arbitrarily, both widening visibility beyond the
 * literal domain. Escaping here is what keeps a LIKE pattern a literal-domain
 * match.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeLikePattern(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Requirement 8.3 expressed for SQL pre-narrowing (Requirement 9.2): one
 * `%@domain` LIKE pattern per usable Allowed_Domain, with `\`, `%` and `_`
 * escaped through `escapeLikePattern` so a domain containing a LIKE
 * metacharacter cannot widen the match. Postgres's default LIKE escape
 * character is `\`, so no `ESCAPE` clause is needed at the call site.
 *
 * This is the ONLY producer of these patterns. No route may build a `%@domain`
 * pattern by string concatenation at the call site — doing so would bypass the
 * escaping and reopen the widening described on `escapeLikePattern`.
 *
 * Returns `[]` for an empty scope. `x LIKE ANY('{}')` is `false`, which is the
 * fail-closed value with no special case at the call site.
 *
 * @param {DirectoryScope|null|undefined} scope
 * @returns {string[]}
 */
function buildEmailDomainLikePatterns(scope) {
  if (!scope || !(scope.allowedDomains instanceof Set)) {
    return [];
  }
  const patterns = [];
  for (const domain of scope.allowedDomains) {
    patterns.push(`%@${escapeLikePattern(domain)}`);
  }
  return patterns;
}

module.exports = {
  extractEmailDomain,
  normaliseDomain,
  buildDirectoryScope,
  isCandidateVisible,
  partitionCandidates,
  escapeLikePattern,
  buildEmailDomainLikePatterns,
};
