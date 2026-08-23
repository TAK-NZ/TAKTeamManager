const pool = require('../config/database');
const { buildDirectoryScope } = require('../utils/directoryScope');
const { getLogger } = require('../middleware/requestContext');

/**
 * DirectoryScopeService
 *
 * The only Database reader in the Organisation-scoping half of this feature,
 * and the only producer of a `DirectoryScope` (Requirement 8: Organisation
 * Scoping of the Available Users List; Requirement 9: Fail-Closed Behaviour;
 * Requirement 10: Global Manager Visibility Is Unchanged).
 *
 * `resolveScope` answers "what may this caller see" once per request; the pure
 * predicate `isCandidateVisible` in `server/utils/directoryScope.js` then
 * answers "may this caller see this candidate" once per candidate. This class
 * gathers the raw rows and hands them to `buildDirectoryScope`; it constructs
 * no domain list, pattern, or org id list of its own — that flattening and the
 * Excluded_Domains subtraction live in the pure module so there is one
 * definition of a scope.
 *
 * A database failure while resolving a scope propagates as a throw and becomes
 * a 500 at the route's existing handler. There is deliberately NO catch here
 * and NO fallback to `UNSCOPED`: resolving who the caller may see must never
 * degrade to "everyone", which is Defect 2 with an error log attached.
 */
class DirectoryScopeService {
  /**
   * Sentinel returned for a Global_Manager. Frozen so a caller cannot mutate
   * it into a scope (Requirement 10.1: a Global_Manager's response is not
   * scoped at all).
   */
  static UNSCOPED = Object.freeze({ unscoped: true });

  /**
   * Resolve the per-request DirectoryScope for a caller
   * (Requirements 8.4, 8.5, 8.6, 9.4, 10.1, 10.4).
   *
   * Global_Manager status is read from the request user's cached
   * `is_global_manager` attribute, exactly as the `user:read:team_admin`
   * resolver in `server/middleware/authorize.js` does (Requirement 10.4) —
   * not re-queried, so the authorization layer and the scoping layer cannot
   * disagree about who is one. A Global_Manager short-circuits to `UNSCOPED`
   * with no query issued.
   *
   * Otherwise up to three queries run and short-circuit:
   *
   *   Q1 — Scoped_Organisations. Direct admin rows only
   *        (`role = 'admin' AND inherited_from_team_id IS NULL` is the
   *        glossary's Team_Admin condition), walked up to the root of each
   *        administered Team's Ancestor_Chain. `UNION` (not `UNION ALL`) so a
   *        caller administering several Teams in one hierarchy deduplicates
   *        overlapping ancestor paths. The Organisation is the
   *        `parent_team_id IS NULL` row selected in SQL — NEVER a positional
   *        read from the tail of `Team.getAncestorChain`, which returns rows
   *        root-first (see the design's research findings). Returning `[]`
   *        here short-circuits Q2 and Q3 entirely.
   *
   *   Q2 — the Allowed_Domains of those Organisations.
   *
   *   Q3 — the global Excluded_Domains, parsed defensively so a missing row,
   *        malformed JSON, or a non-array value all mean "no exclusions",
   *        mirroring `OrgInterestService.isExcludedDomain`.
   *
   * `buildDirectoryScope` then flattens Q2, subtracts Q3, and sets
   * `domainsConfigured`.
   *
   * @param {{ userId: number, is_global_manager?: boolean }} user  req.user
   * @returns {Promise<typeof DirectoryScopeService.UNSCOPED | import('../utils/directoryScope').DirectoryScope>}
   */
  static async resolveScope(user) {
    // Requirement 10.4: cached attribute, no re-query. Matches the
    // `user:read:team_admin` resolver so the two layers cannot disagree.
    if (user && user.is_global_manager) {
      return DirectoryScopeService.UNSCOPED;
    }

    const userId = user && user.userId;

    // Q1 — Scoped_Organisations (Requirement 8.5). The recursive CTE walks
    // from each directly administered Team up to its Organisation root.
    const orgResult = await pool.query(
      `WITH RECURSIVE admin_teams AS (
         SELECT team_id
           FROM team_memberships
          WHERE user_id = $1 AND role = 'admin' AND inherited_from_team_id IS NULL
       ), chain AS (
         SELECT t.id, t.parent_team_id
           FROM teams t
           JOIN admin_teams a ON t.id = a.team_id
         UNION
         SELECT p.id, p.parent_team_id
           FROM teams p
           JOIN chain c ON p.id = c.parent_team_id
       )
       SELECT id, (SELECT name FROM teams WHERE id = chain.id) AS name
         FROM chain
        WHERE parent_team_id IS NULL`,
      [userId]
    );

    const organisations = orgResult.rows.map((row) => ({ id: row.id, name: row.name }));

    // Returning [] from Q1 short-circuits Q2 and Q3 (Requirement 9.2 costs
    // one query, not three). buildDirectoryScope over no rows yields an empty
    // scope whose domainsConfigured is false.
    if (organisations.length === 0) {
      return buildDirectoryScope({ organisations: [], allowedDomains: [], excludedDomains: [] });
    }

    const organisationIds = organisations.map((org) => org.id);

    // Q2 — Allowed_Domains for those Organisations.
    const domainResult = await pool.query(
      `SELECT domain FROM org_allowed_domains WHERE org_id = ANY($1::int[])`,
      [organisationIds]
    );
    const allowedDomains = domainResult.rows.map((row) => row.domain);

    // Q3 — global Excluded_Domains, parsed defensively.
    const excludedDomains = await DirectoryScopeService.readExcludedDomains();

    // Fail-closed (Requirements 9.1, 9.2). This is the SINGLE point at which a
    // non-Global_Manager's scope is returned, INCLUDING the case where every
    // surviving Allowed_Domain was subtracted by Excluded_Domains and so
    // `buildDirectoryScope` sets `domainsConfigured` to `false`. That empty
    // scope is returned as-is, never widened to UNSCOPED: with an empty
    // `allowedDomains`/`organisationIds`, `x = ANY('{}')` and `x LIKE ANY('{}')`
    // are both `false`, so the route yields an empty `users` array — the
    // deliberate fail-closed result, not an error.
    //
    // Reversing this feature to fail OPEN is the one-line edit at this named
    // location: `return DirectoryScopeService.UNSCOPED`. There is deliberately
    // no FAIL_CLOSED flag and no `else` branch — the fail-closed direction is
    // the absence of that reversal, nothing more.
    return buildDirectoryScope({ organisations, allowedDomains, excludedDomains });
  }

  /**
   * Read the `excluded_email_domains` system_config row and parse it into an
   * array of domain strings. A missing row, malformed JSON, or a non-array
   * value all yield `[]` — mirroring `OrgInterestService.isExcludedDomain`'s
   * handling of the same column, so a broken config never widens visibility.
   *
   * @returns {Promise<string[]>}
   */
  static async readExcludedDomains() {
    const result = await pool.query(
      `SELECT config_value FROM system_config WHERE config_key = $1`,
      ['excluded_email_domains']
    );

    if (result.rows.length === 0) {
      return [];
    }

    try {
      const parsed = JSON.parse(result.rows[0].config_value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Build the `scope` fragment attached to a `GET /api/users/available`
   * response for a non-Global_Manager caller (Requirements 9.3, 9.4).
   *
   * Never called for a Global_Manager: `UNSCOPED` carries no `organisations`
   * or `domainsConfigured`, and Requirement 9.8 forbids any `scope` key on
   * that path, so the route omits the call entirely rather than this function
   * guarding against it.
   *
   * @param {import('../utils/directoryScope').DirectoryScope} scope
   * @returns {{ domainsConfigured: boolean, organisations: import('../utils/directoryScope').ScopedOrganisation[] }}
   */
  static buildScopeResponse(scope) {
    return {
      domainsConfigured: scope.domainsConfigured,
      organisations: scope.organisations,
    };
  }

  /**
   * Emit the structured scoping log line for a Directory_Route response
   * (Requirements 14.1, 14.2, 14.3).
   *
   * IDS AND COUNTS ONLY. The `organisations` array on `scope` carries names,
   * so it is reduced to ids INSIDE this function — a caller cannot pass names
   * in by accident, because the shape of the line is this function's business,
   * not the route's. No email address, no first or last name, and no domain
   * list ever reaches the log: Requirement 14.2 forbids the first two, and a
   * domain list is one join away from being an email address's other half.
   *
   * `domainsConfigured` is included so the empty-response path (Requirement
   * 14.3) records why the response was empty, distinguishing an unconfigured
   * Organisation from one whose users simply did not match.
   *
   * Emitted through `getLogger()` from `server/middleware/requestContext`,
   * matching every other log call in these routes, so the line inherits the
   * request's correlation id with no field of its own.
   *
   * @param {string} route  e.g. 'GET /api/users/available'
   * @param {object} info
   * @param {number} info.userId       users.id of the requester
   * @param {import('../utils/directoryScope').DirectoryScope} info.scope
   * @param {number} info.excludedCount  users the scoping predicate removed
   * @param {number} info.returnedCount  users returned after scoping
   */
  static logScopedResponse(route, { userId, scope, excludedCount, returnedCount }) {
    const scopedOrganisationIds = Array.isArray(scope.organisations)
      ? scope.organisations.map((org) => org.id)
      : [];

    getLogger().info(
      {
        route,
        actorId: userId,
        scopedOrganisationIds,
        excludedCount,
        returnedCount,
        domainsConfigured: scope.domainsConfigured,
      },
      'Applied organisation scoping to a directory response'
    );
  }
}

/**
 * The recursive CTE body mapping every `teams.id` to its Organisation's id —
 * the root of that Team's Ancestor_Chain (Requirements 8.1, 8.5).
 *
 * This is the SQL text that goes INSIDE a `WITH RECURSIVE team_root AS ( ... )`
 * clause, exactly as the design's `/search` query shows:
 *
 *   WITH RECURSIVE team_root AS ( <DirectoryScopeService.TEAM_ROOT_CTE> ),
 *   candidates AS ( ... LEFT JOIN team_root root
 *                         ON root.team_id = t.id AND root.parent_team_id IS NULL ... )
 *
 * It is a self-referential recursive query named `team_root`, structurally
 * IDENTICAL to the CTE `GET /api/users`' existing batched query already runs —
 * so "the root of the Ancestor_Chain" has ONE definition on the server, shared
 * VERBATIM by `/search` and by that existing CTE rather than reimplemented per
 * route.
 *
 * Each row carries `(team_id, root_id, root_name, root_callsign_prefix,
 * parent_team_id)`. A Postgres recursive CTE cannot filter its own output to
 * the root row inside the CTE, so the CTE emits every ancestor row and the
 * caller selects the root with `root.parent_team_id IS NULL` in its join
 * predicate — the same idiom the existing `GET /api/users` join already uses
 * (`LEFT JOIN team_root root ON root.team_id = t.id AND root.parent_team_id
 * IS NULL`). `root_id` is the Organisation id `/search` reads; `root_name` and
 * `root_callsign_prefix` are the extra projections `GET /api/users` needs for
 * its `team_name` composition, carried here so the one shared CTE serves both.
 */
DirectoryScopeService.TEAM_ROOT_CTE = `SELECT id AS team_id, id AS root_id, name AS root_name,
             callsign_prefix AS root_callsign_prefix, parent_team_id
      FROM teams
      UNION ALL
      SELECT tr.team_id, p.id AS root_id, p.name AS root_name,
             p.callsign_prefix AS root_callsign_prefix, p.parent_team_id
      FROM team_root tr
      JOIN teams p ON p.id = tr.parent_team_id
      WHERE tr.parent_team_id IS NOT NULL`;

module.exports = DirectoryScopeService;
