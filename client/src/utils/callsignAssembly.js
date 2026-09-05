/**
 * Pure, client-side mirror of `server/services/CallsignService
 * .assembleCallsign` (bug #6: AddTeamDeviceDialog needs to show the FULL
 * resulting callsign live, as the admin types, without a round trip for
 * every keystroke). Deliberately re-implements the SAME three-segment
 * join rule -- Organisation segment, Team segment (Team-Depth prefixes
 * concatenated with NO separator), Name segment -- rather than importing
 * anything server-side (this is a client bundle; there is nothing to
 * import from).
 *
 * This is a PREVIEW only: the server's own `computeCallsignAttributes`/
 * `CallsignService.assembleCallsign` remains the sole authority for the
 * callsign actually stored and pushed to Authentik. A mismatch here would
 * be a display bug, never a data-integrity one.
 *
 * @param {object} params
 * @param {string|null|undefined} params.organisationPrefix
 * @param {Array<string>|null|undefined} params.teamSegmentPrefixes
 * @param {string|null|undefined} params.nameSegment
 * @param {string} [params.teamSegmentSeparator=''] - Callsign
 *   Team-segment separator toggle mirror: `''` (default) reproduces the
 *   original no-separator concatenation; `'-'` hyphenates each PRESENT
 *   level, mirroring `CallsignService.assembleCallsign`'s own param.
 * @returns {string}
 */
export function assembleCallsignPreview({ organisationPrefix, teamSegmentPrefixes, nameSegment, teamSegmentSeparator = '' }) {
  const organisationSegment = organisationPrefix || ''
  const teamSegment = Array.isArray(teamSegmentPrefixes) ? teamSegmentPrefixes.join(teamSegmentSeparator) : ''
  const nameSegmentValue = nameSegment || ''

  return [organisationSegment, teamSegment, nameSegmentValue]
    .filter((segment) => segment !== '')
    .join('-')
}

/**
 * Resolves a Team's Ancestor_Chain (root-first, including the Team
 * itself) from an already-fetched flat `allTeams` list, mirroring
 * `computeTeamDepth`/`isPseudonymousOrganisation`'s own "walk
 * `parent_team_id` through an already-fetched list" convention exactly
 * -- including the same defensive termination when an ancestor is
 * missing from the list (e.g. a private ancestor not returned to this
 * admin), rather than looping forever.
 *
 * @param {{id: number|string, parent_team_id?: number|string|null}|null|undefined} team
 * @param {Array<object>} allTeams
 * @returns {Array<object>} root-first, including `team` itself as the last entry.
 */
export function resolveAncestorChain(team, allTeams) {
  if (!team) {
    return []
  }
  const teamsById = new Map((allTeams || []).map((t) => [t.id, t]))
  const chain = [team]
  const seen = new Set([team.id])
  let current = teamsById.get(team.parent_team_id)
  while (current) {
    chain.unshift(current)
    if (seen.has(current.id)) {
      break
    }
    seen.add(current.id)
    current = teamsById.get(current.parent_team_id)
  }
  return chain
}

/**
 * Resolves the inputs `assembleCallsignPreview` needs for a device being
 * created under `team`: the Organisation's own `callsign_prefix`, and the
 * ordered list of Team-Depth `callsign_prefix` values at every depth >= 1
 * included in the Organisation's `callsign_level_selection` -- the SAME
 * filter `server/services/userAttributes.js`'s `computeCallsignAttributes`
 * applies server-side.
 *
 * A `null`/`undefined` `callsign_level_selection` defaults to "every
 * depth" (mirroring the server's own `Array.from({length:
 * MAX_TEAM_DEPTH}, ...)` fallback), since the Client does not always know
 * `MAX_TEAM_DEPTH` at the call site -- this uses `Infinity`-equivalent
 * inclusion (every depth present in the chain) instead, which agrees with
 * the server's fallback for any chain shallower than MAX_TEAM_DEPTH (the
 * only case a Team's own Ancestor_Chain can ever present).
 *
 * Also resolves the Callsign Team-segment separator toggle
 * (`callsign_team_hyphenated`) off the same Organisation row, so a
 * caller can pass it straight through to `assembleCallsignPreview`
 * without a second lookup.
 *
 * @param {{id: number|string, parent_team_id?: number|string|null}|null|undefined} team
 * @param {Array<object>} allTeams
 * @returns {{organisationPrefix: string|null, teamSegmentPrefixes: Array<string>, teamSegmentSeparator: string}}
 */
export function resolveCallsignSegments(team, allTeams) {
  const chain = resolveAncestorChain(team, allTeams)
  if (chain.length === 0) {
    return { organisationPrefix: null, teamSegmentPrefixes: [], teamSegmentSeparator: '' }
  }
  const organisation = chain[0]
  const callsignLevelSelection = Array.isArray(organisation.callsign_level_selection)
    ? organisation.callsign_level_selection
    : null

  const teamSegmentPrefixes = chain
    .slice(1)
    .filter((t, index) => {
      const depth = index + 1
      const includedByLevelSelection = callsignLevelSelection === null || callsignLevelSelection.includes(depth)
      return includedByLevelSelection && !!t.callsign_prefix
    })
    .map((t) => t.callsign_prefix)

  return {
    organisationPrefix: organisation.callsign_prefix || null,
    teamSegmentPrefixes,
    teamSegmentSeparator: organisation.callsign_team_hyphenated ? '-' : ''
  }
}
