/**
 * Sign-up eligibility: the ONE definition of which teams a person may be
 * offered (and may submit a request for) during sign-up.
 *
 * `SignupFlowService.getAvailableTeams` (what the selector lists) and
 * `SignupFlowService.submitTeamAccess` (the server-side re-check on submit)
 * both build their SQL from this module, so the two cannot drift apart. They
 * previously carried two hand-copied versions of this predicate; a rule that
 * decides who may see a team must not exist in more than one place.
 *
 * A team (alias `t`, joined to its root Organisation as `org`) is eligible for
 * a requester presenting sign-up code `$code` with email domain `$domain`
 * when ALL of the following hold:
 *
 *   1. It is joinable (`can_join`) and `public`, and no ancestor is `private`
 *      (a private ancestor hides the whole branch).
 *   2. Gate -- ANY of:
 *        a. the team's own sign-up code equals `$code`;
 *        b. the team has no code of its own AND is not covered by a gated
 *           Organisation (it is open to everyone, as before);
 *        c. it is a Sub_Team of an Organisation with
 *           `signup_code_covers_sub_teams` AND `$code` is that Organisation's
 *           code (the Organisation's code unlocks its Sub_Teams, including
 *           ones that also have their own code).
 *   3. The Organisation has no allowed-domain restriction, or `$domain` is on
 *      it. This is ANDed after the gate: a code NEVER bypasses the domain
 *      restriction.
 *
 * Fail closed: when an Organisation has the flag set but currently has no code
 * (revoked, or joining turned off), its Sub_Teams satisfy neither (b) nor (c)
 * and are hidden from everyone until a new code exists. Revoking the code
 * therefore never opens the Sub_Teams up.
 *
 * `signup_code_covers_sub_teams` is NULL on a Sub_Team and may be NULL on an
 * un-migrated row; every read goes through COALESCE(..., false).
 */

// Joins each team `t` to its root Organisation as `org`. Exposes the
// Organisation's id, name, callsign_prefix and signup_code_covers_sub_teams.
const ORGANISATION_JOIN = `JOIN LATERAL (
           WITH RECURSIVE ancestors AS (
               SELECT id, name, callsign_prefix, signup_code_covers_sub_teams, parent_team_id
               FROM teams WHERE id = t.id
               UNION ALL
               SELECT p.id, p.name, p.callsign_prefix, p.signup_code_covers_sub_teams, p.parent_team_id
               FROM teams p JOIN ancestors a ON p.id = a.parent_team_id
           )
           SELECT id, name, callsign_prefix, signup_code_covers_sub_teams
           FROM ancestors WHERE parent_team_id IS NULL
       ) org ON true`;

/**
 * Builds the eligibility conditions (no leading WHERE/AND) for a query that
 * selects `FROM teams t` and includes `ORGANISATION_JOIN`.
 *
 * @param {{ codeParam: number, domainParam: number }} params 1-based positions
 *   of the bind parameters holding the sign-up code (normalised, no dash,
 *   upper-case, or '' for none) and the requester's email domain.
 * @returns {string}
 */
function buildEligibilityConditions({ codeParam, domainParam }) {
  if (!Number.isInteger(codeParam) || !Number.isInteger(domainParam)) {
    throw new TypeError('buildEligibilityConditions requires integer codeParam and domainParam positions');
  }
  const code = `$${codeParam}`;
  const domain = `$${domainParam}`;
  return `t.can_join = true
         AND t.visibility = 'public'
         AND NOT EXISTS (
           WITH RECURSIVE visibility_ancestors AS (
             SELECT parent_team_id FROM teams WHERE id = t.id
             UNION ALL
             SELECT p.parent_team_id FROM teams p
             JOIN visibility_ancestors a ON p.id = a.parent_team_id
           )
           SELECT 1 FROM teams anc
           JOIN visibility_ancestors a ON anc.id = a.parent_team_id
           WHERE anc.visibility = 'private'
         )
         AND (
             EXISTS (SELECT 1 FROM signup_codes sc WHERE sc.team_id = t.id AND sc.code = ${code})
             OR (
                 NOT EXISTS (SELECT 1 FROM signup_codes sc WHERE sc.team_id = t.id)
                 AND NOT (t.parent_team_id IS NOT NULL AND COALESCE(org.signup_code_covers_sub_teams, false))
             )
             OR (
                 t.parent_team_id IS NOT NULL
                 AND COALESCE(org.signup_code_covers_sub_teams, false)
                 AND EXISTS (SELECT 1 FROM signup_codes sc WHERE sc.team_id = org.id AND sc.code = ${code})
             )
         )
         AND (
             NOT EXISTS (SELECT 1 FROM org_allowed_domains oad WHERE oad.org_id = org.id)
             OR EXISTS (SELECT 1 FROM org_allowed_domains oad WHERE oad.org_id = org.id AND oad.domain = ${domain})
         )`;
}

module.exports = { ORGANISATION_JOIN, buildEligibilityConditions };
