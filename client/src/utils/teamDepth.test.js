import { describe, it, expect } from 'vitest'
import { computeTeamDepth } from './teamDepth.js'

// Requirement 2.4/2.5 (org-team-hierarchy): `computeTeamDepth` walks a
// team's `parent_team_id` chain against an already-fetched team list to
// derive its Team_Depth client-side, since the Team_Management_API's team
// response has no computed `team_depth` field. Shared by Teams.jsx's
// Parent-Team dropdown (task 32.2) and TeamDetail.jsx's "Add Sub-team"
// disable state (task 33.1).
describe('computeTeamDepth (Req 2.4/2.5 disable-state boundary at depth-4-vs-5)', () => {
  // A 5-level chain: Org(1) -> Team(2) -> Team(3) -> Team(4) -> Team(5),
  // i.e. team 5 sits at Team_Depth 4 (one level below the default
  // Max_Team_Depth of 5) and a team created under it would sit at depth 5.
  const allTeams = [
    { id: 1, parent_team_id: null },
    { id: 2, parent_team_id: 1 },
    { id: 3, parent_team_id: 2 },
    { id: 4, parent_team_id: 3 },
    { id: 5, parent_team_id: 4 }
  ]

  it('returns 0 for an Organisation (no parent_team_id)', () => {
    expect(computeTeamDepth({ id: 1, parent_team_id: null }, allTeams)).toBe(0)
  })

  it('returns 4 for a team at depth 4 (one level below the 5-max default), which stays selectable as a parent', () => {
    const team = allTeams.find(t => t.id === 5)
    const depth = computeTeamDepth(team, allTeams)
    expect(depth).toBe(4)
    const maxTeamDepth = 5
    expect(depth >= maxTeamDepth).toBe(false)
  })

  it('returns 5 for a team at depth 5 (at the max), which must be disabled as a parent option', () => {
    const deeperTeams = [...allTeams, { id: 6, parent_team_id: 5 }]
    const team = deeperTeams.find(t => t.id === 6)
    const depth = computeTeamDepth(team, deeperTeams)
    expect(depth).toBe(5)
    const maxTeamDepth = 5
    expect(depth >= maxTeamDepth).toBe(true)
  })

  it('returns 0 when team is null/undefined', () => {
    expect(computeTeamDepth(null, allTeams)).toBe(0)
    expect(computeTeamDepth(undefined, allTeams)).toBe(0)
  })

  it('terminates without looping forever when a parent is missing from allTeams (e.g. a hidden private ancestor)', () => {
    const team = { id: 10, parent_team_id: 999 }
    expect(computeTeamDepth(team, allTeams)).toBe(1)
  })
})
