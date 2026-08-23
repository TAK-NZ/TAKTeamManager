/**
 * Requirements 9.5, 9.6, 9.7, 9.8. Which statement an empty available-users
 * list should carry, kept in one place rather than as nested ternaries in the
 * Add_Member_Dialog JSX.
 *
 * The four cases are mutually exclusive and evaluated IN ORDER:
 *   1. a non-empty (trimmed) `search`                        -> kind 'search'
 *   2. a `scope` present with `domainsConfigured === false`  -> kind 'domains'
 *   3. a `scope` present with `domainsConfigured === true`   -> kind 'no-match'
 *   4. no `scope` (a Global_Manager response)                -> kind 'unscoped'
 *
 * A non-empty search wins regardless of scope (Requirement 9.6 retains a
 * distinct statement for the search-no-match case). The legacy "all users are
 * already in teams" text is reserved for the unscoped case alone, so a
 * domain-scoping restriction is never reported as an absence of unassigned
 * users (Requirement 9.7).
 *
 * @param {{scope: {domainsConfigured: boolean, organisations: Array<{id:number,name:string}>}|null|undefined,
 *          search: string|null|undefined}} input
 * @returns {{kind: 'search'|'domains'|'no-match'|'unscoped', message: string}}
 */
export function describeEmptyAvailableUsers({ scope, search } = {}) {
  if (search && String(search).trim() !== '') {
    return { kind: 'search', message: SEARCH_NO_MATCH_MESSAGE }
  }

  if (scope && scope.domainsConfigured === false) {
    const names = organisationNames(scope)
    const orgList = formatOrganisationList(names)
    const noun = names.length > 1 ? 'Organisations' : 'Organisation'
    const message =
      `No allowed email domains are configured for ${orgList}, ` +
      `so no users can be added from ${names.length > 1 ? 'them' : 'it'}. ` +
      `A Global Manager can configure allowed email domains for the ${noun}.`
    return { kind: 'domains', message }
  }

  if (scope && scope.domainsConfigured === true) {
    const orgList = formatOrganisationList(organisationNames(scope))
    const message = orgList
      ? `No unassigned users in ${orgList} match.`
      : 'No unassigned users match.'
    return { kind: 'no-match', message }
  }

  return { kind: 'unscoped', message: UNSCOPED_MESSAGE }
}

/**
 * The distinct statement retained for the search-no-match case (Requirement
 * 9.6), unchanged from the existing Add_Member_Dialog copy.
 */
export const SEARCH_NO_MATCH_MESSAGE = 'No users found matching your search.'

/**
 * The legacy statement, reserved for the unscoped (Global_Manager) case alone
 * (Requirements 9.7, 9.8).
 */
export const UNSCOPED_MESSAGE = 'No available users (all users are already in teams).'

/**
 * The `name` of every Organisation in a scope, in the order the server
 * supplied them, dropping any entry without a usable name so the composed
 * prose never reads a stray comma or an empty slot.
 *
 * @param {{organisations?: Array<{id:number,name:string}>}} scope
 * @returns {Array<string>}
 */
function organisationNames(scope) {
  const organisations = (scope && scope.organisations) || []
  return organisations
    .map((organisation) => organisation && organisation.name)
    .filter((name) => typeof name === 'string' && name.trim() !== '')
}

/**
 * Joins Organisation names into readable prose: "A", "A and B", or
 * "A, B and C". Returns an empty string for no names.
 *
 * @param {Array<string>} names
 * @returns {string}
 */
function formatOrganisationList(names) {
  if (names.length === 0) {
    return ''
  }
  if (names.length === 1) {
    return names[0]
  }
  const head = names.slice(0, -1).join(', ')
  const tail = names[names.length - 1]
  return `${head} and ${tail}`
}
