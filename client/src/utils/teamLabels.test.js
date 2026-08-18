import { describe, it, expect } from 'vitest'
import { labelFor, labelForNew } from './teamLabels.js'

// Requirement 1 (org-team-hierarchy): a root team (`parent_team_id`
// null/absent, or `is_organisation: true`) is labelled "Organisation";
// every other team is labelled "Team".
describe('labelFor', () => {
  it('labels a team with is_organisation: true as "Organisation"', () => {
    expect(labelFor({ is_organisation: true, parent_team_id: null })).toBe('Organisation')
  })

  it('labels a team with is_organisation: false as "Team"', () => {
    expect(labelFor({ is_organisation: false, parent_team_id: 1 })).toBe('Team')
  })

  it('falls back to parent_team_id when is_organisation is absent: null parent -> "Organisation"', () => {
    expect(labelFor({ parent_team_id: null })).toBe('Organisation')
  })

  it('falls back to parent_team_id when is_organisation is absent: set parent -> "Team"', () => {
    expect(labelFor({ parent_team_id: 42 })).toBe('Team')
  })

  it('treats a missing team as "Team"', () => {
    expect(labelFor(null)).toBe('Team')
    expect(labelFor(undefined)).toBe('Team')
  })
})

// Requirement 1.4/1.5: the create-dialog label is based on the SELECTED
// parentTeamId in the form, not any existing team object.
describe('labelForNew', () => {
  it('labels a new team with no selected parent as "Organisation"', () => {
    expect(labelForNew(null)).toBe('Organisation')
    expect(labelForNew(undefined)).toBe('Organisation')
  })

  it('labels a new team with a selected parent as "Team"', () => {
    expect(labelForNew(7)).toBe('Team')
    expect(labelForNew('7')).toBe('Team')
  })
})
