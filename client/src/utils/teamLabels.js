/**
 * Requirement 1 (org-team-hierarchy): the root of a team hierarchy
 * (`parent_team_id IS NULL`) is labelled "Organisation" in the Client;
 * every other row stays labelled "Team". This is a purely client-side/
 * display-only distinction -- no API/DB shape change (Requirement 1.3).
 *
 * `is_organisation` is not currently returned by any Team API response
 * (`teamsAPI.getMyTeams()` and friends only return `parent_team_id`), so
 * both helpers fall back to deriving the same answer from
 * `parent_team_id` directly. If a future change starts returning
 * `is_organisation` on team rows, `labelFor` prefers it when present.
 *
 * Extracted into a shared util (rather than living only in Teams.jsx) so
 * TeamDetail.jsx's header/breadcrumbs/dialog titles can reuse the exact
 * same labelling rule without duplicating it.
 */

/**
 * @param {{ is_organisation?: boolean, parent_team_id?: number|string|null }|null|undefined} team
 * @returns {'Organisation'|'Team'} "Organisation" for a root team, "Team" otherwise.
 */
export function labelFor(team) {
  if (!team) {
    return 'Team'
  }
  const isOrganisation = team.is_organisation ?? !team.parent_team_id
  return isOrganisation ? 'Organisation' : 'Team'
}

/**
 * Requirement 1.4/1.5: labels the entity about to be CREATED, before it
 * exists, based solely on whether a parent Team has been selected in the
 * creation form.
 *
 * @param {number|string|null|undefined} parentTeamId
 * @returns {'Organisation'|'Team'} "Team" when a parent is selected
 *   (creating a Sub_Team), "Organisation" when no parent is selected
 *   (creating a root Team).
 */
export function labelForNew(parentTeamId) {
  return parentTeamId ? 'Team' : 'Organisation'
}
