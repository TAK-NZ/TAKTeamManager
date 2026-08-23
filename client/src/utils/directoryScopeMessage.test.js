import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  describeEmptyAvailableUsers,
  SEARCH_NO_MATCH_MESSAGE,
  UNSCOPED_MESSAGE
} from './directoryScopeMessage.js'

// Validates: Requirements 9.5, 9.6, 9.7, 15.12
//
// Property 18 (design.md): "For any combination of a present-or-absent
// `scope` object, either value of `domainsConfigured`, and a present-or-
// absent search term, exactly one empty-available-users statement is
// selected; the statement naming Organisations and pointing at domain
// configuration is selected exactly when a `scope` object is present with
// `domainsConfigured` of `false` and no search term, and it names every
// Organisation in `scope.organisations`; and the 'all users are already in
// teams' statement is selected only where no `scope` object is present."

// A scope object with a mix of organisation counts and varied names.
const organisationArbitrary = fc.record({
  id: fc.integer({ min: 1, max: 10000 }),
  name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== '')
})

const scopeArbitrary = fc.oneof(
  fc.constant(null),
  fc.record({
    domainsConfigured: fc.boolean(),
    organisations: fc.array(organisationArbitrary, { minLength: 0, maxLength: 5 })
  })
)

// "Absent" search: undefined, empty string, or whitespace-only. "Present"
// search: any string that is non-empty once trimmed.
const absentSearchArbitrary = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.constantFrom(' ', '   ', '\t', '\n', ' \t \n ')
)

const presentSearchArbitrary = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => s.trim() !== '')

const searchArbitrary = fc.oneof(absentSearchArbitrary, presentSearchArbitrary)

// Compute the expected kind directly from the inputs, never by calling the
// function under test.
function expectedKind(scope, search) {
  const searchPresent = typeof search === 'string' && search.trim() !== ''
  if (searchPresent) {
    return 'search'
  }
  if (scope && scope.domainsConfigured === false) {
    return 'domains'
  }
  if (scope && scope.domainsConfigured === true) {
    return 'no-match'
  }
  return 'unscoped'
}

const ALL_KINDS = ['search', 'domains', 'no-match', 'unscoped']

describe('describeEmptyAvailableUsers', () => {
  describe('Property 18: The empty-list explanation is exhaustive and mutually exclusive', () => {
    // Feature: member-visibility-and-callsign-recompute, Property 18: The empty-list explanation is exhaustive and mutually exclusive
    it('selects exactly one of the four kinds by scope/domainsConfigured/search, and the domains kind names every organisation in scope', () => {
      fc.assert(
        fc.property(scopeArbitrary, searchArbitrary, (scope, search) => {
          const result = describeEmptyAvailableUsers({ scope, search })

          // Exhaustive and mutually exclusive: exactly one of the four kinds.
          expect(ALL_KINDS).toContain(result.kind)
          expect(typeof result.message).toBe('string')
          expect(result.message.length).toBeGreaterThan(0)

          // The selection matches the rule derived directly from the inputs.
          expect(result.kind).toBe(expectedKind(scope, search))

          // For the domains case, the message names every organisation with a
          // usable name in scope.organisations (Req 9.5).
          if (result.kind === 'domains') {
            const names = scope.organisations
              .map((o) => o && o.name)
              .filter((name) => typeof name === 'string' && name.trim() !== '')
            for (const name of names) {
              expect(result.message).toContain(name)
            }
          }
        }),
        { numRuns: 100 }
      )
    })
  })
})

// Validates: Requirements 15.12
//
// Requirement 15.12: an empty available-users list caused by
// `scope.domainsConfigured` of `false` displays the Organisation name and the
// domain-configuration statement, and NOT the "all users are already in
// teams" statement. These are plain example assertions on the exact text the
// module produces for each of the four kinds.
describe('describeEmptyAvailableUsers exact wording (Requirement 15.12)', () => {
  it("returns the SEARCH_NO_MATCH_MESSAGE for the 'search' kind", () => {
    const result = describeEmptyAvailableUsers({
      scope: { domainsConfigured: false, organisations: [{ id: 1, name: 'FENZ' }] },
      search: 'ann'
    })
    expect(result.kind).toBe('search')
    expect(result.message).toBe(SEARCH_NO_MATCH_MESSAGE)
    expect(result.message).toBe('No users found matching your search.')
  })

  it("returns the UNSCOPED_MESSAGE for the 'unscoped' kind, which contains 'all users are already in teams'", () => {
    const result = describeEmptyAvailableUsers({ scope: null, search: '' })
    expect(result.kind).toBe('unscoped')
    expect(result.message).toBe(UNSCOPED_MESSAGE)
    expect(result.message).toBe('No available users (all users are already in teams).')
    expect(result.message).toContain('all users are already in teams')
  })

  it("returns the 'No unassigned users ... match.' wording for the 'no-match' kind", () => {
    const result = describeEmptyAvailableUsers({
      scope: { domainsConfigured: true, organisations: [{ id: 1, name: 'FENZ' }] },
      search: ''
    })
    expect(result.kind).toBe('no-match')
    expect(result.message).toBe('No unassigned users in FENZ match.')
  })

  it("uses the bare 'No unassigned users match.' wording for the 'no-match' kind when no organisation is named", () => {
    const result = describeEmptyAvailableUsers({
      scope: { domainsConfigured: true, organisations: [] },
      search: ''
    })
    expect(result.kind).toBe('no-match')
    expect(result.message).toBe('No unassigned users match.')
  })

  it("displays the Organisation name and the domain-configuration statement, and not the 'all users are already in teams' statement, for domainsConfigured false", () => {
    const result = describeEmptyAvailableUsers({
      scope: { domainsConfigured: false, organisations: [{ id: 7, name: 'FENZ' }] },
      search: ''
    })
    expect(result.kind).toBe('domains')
    // The Organisation name appears.
    expect(result.message).toContain('FENZ')
    // The domain-configuration statement: no allowed email domains configured,
    // and a Global Manager can configure them.
    expect(result.message).toContain('No allowed email domains are configured for FENZ')
    expect(result.message).toContain('A Global Manager can configure allowed email domains for the Organisation')
    // The exact single-organisation wording.
    expect(result.message).toBe(
      'No allowed email domains are configured for FENZ, so no users can be added from it. ' +
        'A Global Manager can configure allowed email domains for the Organisation.'
    )
    // It does NOT report an absence of unassigned users.
    expect(result.message).not.toContain('all users are already in teams')
  })

  it("names two organisations joined with 'and' and uses the plural wording for the 'domains' kind", () => {
    const result = describeEmptyAvailableUsers({
      scope: {
        domainsConfigured: false,
        organisations: [
          { id: 1, name: 'FENZ' },
          { id: 2, name: 'NZDF' }
        ]
      },
      search: ''
    })
    expect(result.kind).toBe('domains')
    expect(result.message).toContain('FENZ and NZDF')
    expect(result.message).toBe(
      'No allowed email domains are configured for FENZ and NZDF, so no users can be added from them. ' +
        'A Global Manager can configure allowed email domains for the Organisations.'
    )
    expect(result.message).not.toContain('all users are already in teams')
  })

  it("joins three organisations as 'A, B and C' for the 'domains' kind", () => {
    const result = describeEmptyAvailableUsers({
      scope: {
        domainsConfigured: false,
        organisations: [
          { id: 1, name: 'FENZ' },
          { id: 2, name: 'NZDF' },
          { id: 3, name: 'NZP' }
        ]
      },
      search: ''
    })
    expect(result.kind).toBe('domains')
    expect(result.message).toContain('FENZ, NZDF and NZP')
    expect(result.message).not.toContain('all users are already in teams')
  })
})
