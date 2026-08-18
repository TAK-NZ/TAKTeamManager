/**
 * Requirement 2.4/2.5 (org-team-hierarchy): the Team_Management_API's team
 * response does not (yet) include a computed `team_depth` field, so this
 * walks the `parent_team_id` chain against an already-fetched list of teams
 * to derive it client-side.
 *
 * Extracted into a shared util (rather than living only in one page) so
 * both Teams.jsx (the Parent-Team dropdown's disable state, task 32.2) and
 * TeamDetail.jsx (the "Add Sub-team" disable state, task 33.1) reuse the
 * exact same depth-computation rule without duplicating it -- the same
 * reasoning that led to `labelFor`/`labelForNew` being extracted to
 * `teamLabels.js` rather than duplicated per-page.
 *
 * @param {{ parent_team_id?: number|string|null }|null|undefined} team
 * @param {Array<{ id: number|string, parent_team_id?: number|string|null }>} allTeams
 * @returns {number} the team's Team_Depth (0 for an Organisation/root team).
 *   Terminates defensively if a parent can't be found in `allTeams` (e.g.
 *   a private ancestor not returned to this user), rather than looping
 *   forever.
 */
export function computeTeamDepth(team, allTeams) {
  if (!team) {
    return 0
  }
  const teamsById = new Map(allTeams.map((t) => [t.id, t]))
  let depth = 0
  let currentParentId = team.parent_team_id
  while (currentParentId) {
    depth += 1
    const parent = teamsById.get(currentParentId)
    if (!parent) {
      break
    }
    currentParentId = parent.parent_team_id
  }
  return depth
}
