import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { formatLevelLabel, groupCallsignLevelOptionsByDepth } from './callsignLevels.js'

// Validates: Requirements 5.9, 5.10, 5.11
//
// Property 7 (design.md): "For any list of distinct callsign_prefix
// values observed at a given Team_Depth position, the formatted toggle
// label always begins with 'Level N', includes no parenthetical when the
// list is empty, otherwise includes up to 3 comma-separated example
// values, and includes a trailing ellipsis if and only if more than 3
// distinct values exist."

describe('formatLevelLabel (Req 5.9, 5.10, 5.11)', () => {
  describe('example round trips', () => {
    it('renders only "Level N" with no parenthetical when no Sub_Team occupies this position (Req 5.11)', () => {
      expect(formatLevelLabel(1, [])).toBe('Level 1')
      expect(formatLevelLabel(3)).toBe('Level 3')
    })

    it('renders up to 3 distinct examples, comma-separated, with no ellipsis (Req 5.9, 5.10)', () => {
      expect(formatLevelLabel(1, ['CB'])).toBe('Level 1 (e.g. CB)')
      expect(formatLevelLabel(1, ['CB', 'AUK'])).toBe('Level 1 (e.g. CB, AUK)')
      expect(formatLevelLabel(1, ['CB', 'AUK', 'WGN'])).toBe('Level 1 (e.g. CB, AUK, WGN)')
    })

    it('truncates to the first 3 examples and appends an ellipsis when more than 3 distinct values exist (Req 5.10)', () => {
      expect(formatLevelLabel(1, ['CB', 'AUK', 'WGN', 'CHC'])).toBe('Level 1 (e.g. CB, AUK, WGN, ...)')
      expect(formatLevelLabel(1, ['CB', 'AUK', 'WGN', 'CHC', 'STL'])).toBe('Level 1 (e.g. CB, AUK, WGN, ...)')
    })

    it('always begins with "Level N" for any depth', () => {
      expect(formatLevelLabel(5, [])).toMatch(/^Level 5/)
      expect(formatLevelLabel(2, ['X'])).toMatch(/^Level 2/)
    })
  })

  describe('Property 7: Level-toggle label formatting', () => {
    it('for all lists of distinct prefixes, the label always starts with "Level N", omits the parenthetical iff the list is empty, otherwise shows up to 3 comma-joined values with a trailing ellipsis iff more than 3 distinct values exist', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9]{1,6}$/), { minLength: 0, maxLength: 10 }),
          (depth, prefixes) => {
            const label = formatLevelLabel(depth, prefixes)

            // Always begins with "Level N".
            expect(label.startsWith(`Level ${depth}`)).toBe(true)

            if (prefixes.length === 0) {
              // No parenthetical at all when the list is empty (Req 5.11).
              expect(label).toBe(`Level ${depth}`)
              return
            }

            // A parenthetical is present.
            expect(label).toMatch(/\(e\.g\. .+\)$/)

            const shown = prefixes.slice(0, 3)
            const expectedEllipsis = prefixes.length > 3

            const match = label.match(/\(e\.g\. (.*)\)$/)
            const inner = match[1]
            const parts = inner.split(', ')

            if (expectedEllipsis) {
              expect(parts).toEqual([...shown, '...'])
            } else {
              expect(parts).toEqual(shown)
            }
          }
        ),
        { numRuns: 100 }
      )
    })
  })
})

describe('groupCallsignLevelOptionsByDepth', () => {
  it('groups the flat { team_depth, callsign_prefix } rows by depth, deduplicating and sorting prefixes per depth', () => {
    const options = [
      { team_depth: 1, callsign_prefix: 'CB' },
      { team_depth: 1, callsign_prefix: 'AUK' },
      { team_depth: 1, callsign_prefix: 'CB' }, // duplicate
      { team_depth: 2, callsign_prefix: 'ST40' }
    ]
    const grouped = groupCallsignLevelOptionsByDepth(options)
    expect(grouped.get(1)).toEqual(['AUK', 'CB'])
    expect(grouped.get(2)).toEqual(['ST40'])
    expect(grouped.get(3)).toBeUndefined()
  })

  it('returns an empty Map for an empty or missing options list (e.g. a brand-new Organisation with no Sub_Teams)', () => {
    expect(groupCallsignLevelOptionsByDepth([]).size).toBe(0)
    expect(groupCallsignLevelOptionsByDepth().size).toBe(0)
  })

  it('ignores rows with an empty callsign_prefix', () => {
    const grouped = groupCallsignLevelOptionsByDepth([
      { team_depth: 1, callsign_prefix: '' },
      { team_depth: 1, callsign_prefix: null }
    ])
    expect(grouped.size).toBe(0)
  })
})
