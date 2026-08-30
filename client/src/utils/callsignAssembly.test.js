import { describe, it, expect } from 'vitest'
import { assembleCallsignPreview, resolveAncestorChain, resolveCallsignSegments } from './callsignAssembly.js'

describe('assembleCallsignPreview (client-side mirror of CallsignService.assembleCallsign)', () => {
  it('joins all three segments with a single dash when all are present', () => {
    expect(assembleCallsignPreview({
      organisationPrefix: 'FENZ',
      teamSegmentPrefixes: ['CB', 'ST40'],
      nameSegment: 'John Smith'
    })).toBe('FENZ-CBST40-John Smith')
  })

  it('omits the Organisation segment when empty', () => {
    expect(assembleCallsignPreview({ organisationPrefix: '', teamSegmentPrefixes: ['CB'], nameSegment: 'Tanker1' })).toBe('CB-Tanker1')
  })

  it('omits the Team segment when empty', () => {
    expect(assembleCallsignPreview({ organisationPrefix: 'FENZ', teamSegmentPrefixes: [], nameSegment: 'Tanker1' })).toBe('FENZ-Tanker1')
  })

  it('omits the Name segment when empty', () => {
    expect(assembleCallsignPreview({ organisationPrefix: 'FENZ', teamSegmentPrefixes: ['CB'], nameSegment: '' })).toBe('FENZ-CB')
  })

  it('returns an empty string when every segment is empty/null/undefined', () => {
    expect(assembleCallsignPreview({ organisationPrefix: null, teamSegmentPrefixes: undefined, nameSegment: '' })).toBe('')
  })

  it('joins multiple team-level prefixes with no separator', () => {
    expect(assembleCallsignPreview({ organisationPrefix: '', teamSegmentPrefixes: ['CB', 'ST40'], nameSegment: '' })).toBe('CBST40')
  })
})

describe('resolveAncestorChain', () => {
  const ORG = { id: 1, parent_team_id: null }
  const SUB = { id: 2, parent_team_id: 1 }
  const SUBSUB = { id: 3, parent_team_id: 2 }
  const ALL_TEAMS = [ORG, SUB, SUBSUB]

  it('returns just the team for an Organisation (no parent)', () => {
    expect(resolveAncestorChain(ORG, ALL_TEAMS)).toEqual([ORG])
  })

  it('returns [Organisation, team] for a direct Sub_Team', () => {
    expect(resolveAncestorChain(SUB, ALL_TEAMS)).toEqual([ORG, SUB])
  })

  it('returns the full root-first chain for a deeper Sub_Team', () => {
    expect(resolveAncestorChain(SUBSUB, ALL_TEAMS)).toEqual([ORG, SUB, SUBSUB])
  })

  it('returns an empty array for a null/undefined team', () => {
    expect(resolveAncestorChain(null, ALL_TEAMS)).toEqual([])
    expect(resolveAncestorChain(undefined, ALL_TEAMS)).toEqual([])
  })

  it('terminates without looping forever when an ancestor is missing from allTeams', () => {
    const orphan = { id: 5, parent_team_id: 999 }
    expect(() => resolveAncestorChain(orphan, [orphan])).not.toThrow()
    expect(resolveAncestorChain(orphan, [orphan])).toEqual([orphan])
  })
})

describe('resolveCallsignSegments', () => {
  const ORG = { id: 1, parent_team_id: null, callsign_prefix: 'FENZ', callsign_level_selection: [1] }
  const SUB = { id: 2, parent_team_id: 1, callsign_prefix: 'STL' }
  const SUBSUB = { id: 3, parent_team_id: 2, callsign_prefix: 'CB' }
  const ALL_TEAMS = [ORG, SUB, SUBSUB]

  it('resolves the Organisation prefix and an empty team-segment list for the Organisation itself', () => {
    expect(resolveCallsignSegments(ORG, ALL_TEAMS)).toEqual({ organisationPrefix: 'FENZ', teamSegmentPrefixes: [] })
  })

  it('includes a Sub_Team depth-1 prefix when the Organisation selects depth 1', () => {
    expect(resolveCallsignSegments(SUB, ALL_TEAMS)).toEqual({ organisationPrefix: 'FENZ', teamSegmentPrefixes: ['STL'] })
  })

  it('excludes a depth-2 prefix when the Organisation only selects depth 1', () => {
    expect(resolveCallsignSegments(SUBSUB, ALL_TEAMS)).toEqual({ organisationPrefix: 'FENZ', teamSegmentPrefixes: ['STL'] })
  })

  it('defaults to including every depth when callsign_level_selection is null/undefined', () => {
    const orgNoSelection = { id: 1, parent_team_id: null, callsign_prefix: 'FENZ', callsign_level_selection: null }
    const allTeams = [orgNoSelection, { id: 2, parent_team_id: 1, callsign_prefix: 'STL' }, { id: 3, parent_team_id: 2, callsign_prefix: 'CB' }]
    const sub2 = allTeams[2]
    expect(resolveCallsignSegments(sub2, allTeams)).toEqual({ organisationPrefix: 'FENZ', teamSegmentPrefixes: ['STL', 'CB'] })
  })

  it('returns null organisationPrefix and an empty team-segment list for a null/undefined team', () => {
    expect(resolveCallsignSegments(null, ALL_TEAMS)).toEqual({ organisationPrefix: null, teamSegmentPrefixes: [] })
  })

  it('excludes a Sub_Team with no own callsign_prefix from the team segment', () => {
    const subNoPrefix = { id: 2, parent_team_id: 1, callsign_prefix: null }
    const allTeams = [ORG, subNoPrefix]
    expect(resolveCallsignSegments(subNoPrefix, allTeams)).toEqual({ organisationPrefix: 'FENZ', teamSegmentPrefixes: [] })
  })
})
