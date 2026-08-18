/**
 * Requirement 5.7-5.11 (org-team-hierarchy, task 32.4): formats a single
 * Callsign_Level_Selection toggle's label for a given Team_Depth
 * position, given the distinct `callsign_prefix` values already observed
 * among the Organisation's existing Sub_Teams at that position.
 *
 * Always begins with "Level N" (Requirement 5.9). When no Sub_Team
 * occupies this position yet (an empty `prefixes` list -- always true for
 * a brand-new Organisation, which has no Sub_Teams at all yet, per
 * Requirement 5.11), no parenthetical is appended. Otherwise, appends a
 * parenthetical listing up to 3 distinct example prefixes, comma
 * separated (matching requirements.md's own "Level 1 (e.g. CB, AUK,
 * WGN)" example), with a trailing ellipsis when more than 3 distinct
 * prefixes exist (Requirement 5.10, "Level 1 (e.g. CB, AUK, WGN, ...)").
 *
 * `prefixes` is expected to already be deduplicated and sorted by the
 * caller (Teams.jsx groups the flat
 * `GET /api/teams/:teamId/callsign-level-options` response by
 * `team_depth` via `groupCallsignLevelOptionsByDepth` below before
 * calling this), but this function does not itself re-validate that -- a
 * pure function, it simply takes the first 3 entries it is given.
 *
 * @param {number} depth
 * @param {Array<string>} [prefixes]
 * @returns {string}
 */
export function formatLevelLabel(depth, prefixes = []) {
  const label = `Level ${depth}`
  if (!prefixes || prefixes.length === 0) {
    return label
  }
  const shown = prefixes.slice(0, 3)
  const examples = prefixes.length > 3 ? [...shown, '...'] : shown
  return `${label} (e.g. ${examples.join(', ')})`
}

/**
 * Groups the flat `{ team_depth, callsign_prefix }` rows returned by
 * `GET /api/teams/:teamId/callsign-level-options`
 * (`teamsAPI.getCallsignLevelOptions`) into a
 * depth -> deduplicated, sorted `callsign_prefix` array map, for
 * `formatLevelLabel` to consume per toggle (Requirement 5.8's "multiple
 * differently-prefixed Sub_Teams may occupy the same Team_Depth position"
 * is exactly why de-duplication happens here rather than assuming at
 * most one row per depth).
 *
 * @param {Array<{team_depth: number, callsign_prefix: string}>} [options]
 * @returns {Map<number, Array<string>>}
 */
export function groupCallsignLevelOptionsByDepth(options = []) {
  const byDepth = new Map()
  for (const option of options || []) {
    if (!option || !option.callsign_prefix) {
      continue
    }
    const { team_depth: depth, callsign_prefix: prefix } = option
    if (!byDepth.has(depth)) {
      byDepth.set(depth, new Set())
    }
    byDepth.get(depth).add(prefix)
  }
  const result = new Map()
  for (const [depth, prefixSet] of byDepth.entries()) {
    result.set(depth, Array.from(prefixSet).sort())
  }
  return result
}
