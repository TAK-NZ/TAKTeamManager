import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isValidCallsignPrefixInput } from '../components/TeamFormDialog.jsx';
import { getParentBreadcrumb } from './Teams.jsx';

// Validates: Requirement 3.10
//
// The shared Create/Edit Team dialog (`TeamFormDialog`, used by both
// Teams.jsx and TeamDetail.jsx as of the "unify the two drifted Edit
// Team dialogs" bugfix) applies HTML `pattern` validation plus an inline
// error message to its own "Prefix" input (`formData.callsignPrefix`),
// mirroring server/utils/callsignValidation.js's `isValidCallsignPrefix`
// character class (foreign-partner-prefix extension: one or more
// `-`-separated alphanumeric segments, rather than a single hyphen-free
// run) and the same convention already established by TeamDetail.jsx's
// `isValidSubTeamCallsignPrefix` for its Create Sub-Team Dialog's own
// "Prefix" input (task 33.3). No component-render test harness (e.g.
// @testing-library/react) is set up in this project -- see
// src/services/api.test.js, src/utils/channelTree.test.js, and
// src/pages/TeamDetail.test.jsx, which all test extracted pure logic
// rather than rendering a component -- so this file follows that same
// convention and tests the pure helper directly. This test file stays at
// its original path (`src/pages/Teams.test.jsx`) even though the helper
// it tests moved, to avoid unnecessary churn.

describe('isValidCallsignPrefixInput (Req 3.10)', () => {
  it('accepts an empty value', () => {
    expect(isValidCallsignPrefixInput('')).toBe(true)
    expect(isValidCallsignPrefixInput(undefined)).toBe(true)
  })

  it('accepts letters and digits only', () => {
    expect(isValidCallsignPrefixInput('FENZ')).toBe(true)
    expect(isValidCallsignPrefixInput('FENZ123')).toBe(true)
  })

  // Foreign-partner-prefix extension: a single internal hyphen (one or
  // more `-`-separated alphanumeric segments, e.g. "AUS-FIRE") is now
  // accepted, mirroring server/utils/callsignValidation.js's widened
  // CALLSIGN_PREFIX_PATTERN.
  it('accepts a value containing a single internal hyphen (a two-segment prefix)', () => {
    expect(isValidCallsignPrefixInput('NZ-POL')).toBe(true)
  })

  it('rejects a value with a leading, trailing, or doubled hyphen', () => {
    expect(isValidCallsignPrefixInput('-NZ')).toBe(false)
    expect(isValidCallsignPrefixInput('NZ-')).toBe(false)
    expect(isValidCallsignPrefixInput('NZ--POL')).toBe(false)
  })

  it('rejects a value containing any other disallowed character', () => {
    expect(isValidCallsignPrefixInput('FE.NZ')).toBe(false)
    expect(isValidCallsignPrefixInput('FE NZ')).toBe(false)
  })
})

// /teams overview table: show Team Devices and Team Admins counts between
// Members and Sub-teams, matching the server's new admin_count/device_count
// columns (Team.getAllTeams/Team.getOrganisationTeams). Source-contract
// check, matching this file's own established convention (no
// @testing-library/react in this project).
describe('Teams.jsx overview table: Team Devices / Team Admins columns between Members and Sub-teams', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Teams.jsx'), 'utf8')

  it('renders a "Team Devices" column header sorting on device_count, positioned after Members and before Sub-teams', () => {
    const membersIndex = source.indexOf('<span>Members</span>')
    const devicesIndex = source.indexOf("handleSort('device_count')")
    const adminsIndex = source.indexOf("handleSort('admin_count')")
    const subTeamsIndex = source.indexOf("handleSort('sub_teams_count')")
    expect(membersIndex).toBeGreaterThan(-1)
    expect(devicesIndex).toBeGreaterThan(membersIndex)
    expect(adminsIndex).toBeGreaterThan(devicesIndex)
    expect(subTeamsIndex).toBeGreaterThan(adminsIndex)
    expect(source).toContain('<span>Team Devices</span>')
    expect(source).toContain('<span>Team Admins</span>')
  })

  it('renders the device_count/admin_count data cells, defaulting to 0', () => {
    expect(source).toContain('{team.device_count || 0}')
    expect(source).toContain('{team.admin_count || 0}')
  })
})

// Bugfix: each of the four counts on the Orgs & Teams overview (Members,
// Team Devices, Team Admins, Sub-teams) links to that team's corresponding
// TeamDetail.jsx tab (`?tab=<id>`, read there via `useSearchParams` and
// TeamDetail.jsx's own `VALID_TAB_IDS` allow-list) rather than being plain
// unlinked text -- checked once for the mobile card block and once for the
// desktop table block, since the two are separate markup blocks that could
// drift from each other. Source-contract check, matching this file's own
// established convention.
describe('Teams.jsx overview counts link to the corresponding TeamDetail.jsx tab (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Teams.jsx'), 'utf8')
  const cardBlockStart = source.indexOf('sm:hidden divide-y')
  const tableBlockStart = source.indexOf('hidden sm:block overflow-x-auto')
  const cardBlock = source.slice(cardBlockStart, tableBlockStart)
  const tableBlock = source.slice(tableBlockStart)

  it.each([
    ['Members', 'members', '{team.member_count || 0}'],
    ['Team Devices', 'devices', '{team.device_count || 0}'],
    ['Team Admins', 'admins', '{team.admin_count || 0}'],
    ['Sub-teams', 'subteams', '{team.sub_teams_count || 0}']
  ])('%s count is wrapped in a Link to ?tab=%s, in both the card and the table block', (_label, tabId, countExpr) => {
    const linkPrefix = `<Link to={\`/teams/${'$'}{team.id}?tab=${tabId}\`}`

    for (const [blockName, block] of [['card', cardBlock], ['table', tableBlock]]) {
      expect(block, `${blockName} block should contain a ?tab=${tabId} Link`).toContain(linkPrefix)
      const linkIndex = block.indexOf(linkPrefix)
      const countIndex = block.indexOf(countExpr, linkIndex)
      expect(countIndex, `${blockName} block: ${countExpr} should appear inside the ?tab=${tabId} Link`).toBeGreaterThan(linkIndex)
      // Anti-vacuity: the count expression must appear BEFORE the link's
      // own closing tag, not merely somewhere later in the block.
      const closingLinkIndex = block.indexOf('</Link>', linkIndex)
      expect(closingLinkIndex).toBeGreaterThan(-1)
      expect(countIndex).toBeLessThan(closingLinkIndex)
    }
  })
})

// Bugfix: the /teams table required constant horizontal swiping on a
// phone. Source-contract check, matching this file's own established
// convention (no @testing-library/react in this project) -- see
// TeamDeviceList.jsx's own dual-render pairing for the pattern being
// mirrored here.
describe('Teams.jsx mobile card fallback (sm:hidden cards + hidden sm:block table)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Teams.jsx'), 'utf8')

  it('renders a sm:hidden card list ahead of a hidden sm:block table, never a bare <table> outside that wrapper', () => {
    const cardBlockIndex = source.indexOf('sm:hidden divide-y')
    const tableBlockIndex = source.indexOf('hidden sm:block overflow-x-auto')
    expect(cardBlockIndex).toBeGreaterThan(-1)
    expect(tableBlockIndex).toBeGreaterThan(cardBlockIndex)
  })

  it('shares the status-icon and action-icon groups between the card and the table via extracted components, rather than duplicating the JSX', () => {
    expect(source).toContain('function TeamStatusIcons(')
    expect(source).toContain('function TeamRowActions(')
    // Each shared component must actually be USED by both surfaces, not
    // just defined -- two usages each (card + table).
    const statusUsages = source.split('<TeamStatusIcons').length - 1
    const actionUsages = source.split('<TeamRowActions').length - 1
    expect(statusUsages).toBe(2)
    expect(actionUsages).toBe(2)
  })

  // Bugfix (mobile tap targets too small): the mobile card's TeamRowActions
  // usage passes variant="card" for a real ~36px tap target (p-2/
  // rounded-lg/h-5 w-5 button box); the desktop table's usage keeps the
  // default compact 'table' variant (bare h-4 w-4 icon, no box) since a
  // mouse-driven table row has no tap-target problem.
  it('passes variant="card" from the card TeamRowActions usage only, not from the table usage', () => {
    const usageIndices = [...source.matchAll(/<TeamRowActions/g)].map((m) => m.index)
    expect(usageIndices.length).toBe(2)
    const withCardVariant = usageIndices.filter((index) => {
      const usageBlock = source.slice(index, source.indexOf('/>', index))
      return usageBlock.includes('variant="card"')
    })
    expect(withCardVariant.length).toBe(1)
  })

  it('caps the table row indentation at MAX_TABLE_INDENT_LEVELS instead of an unbounded team.level', () => {
    expect(source).toContain('const MAX_TABLE_INDENT_LEVELS = 3')
    expect(source).toContain('Math.min(team.level, MAX_TABLE_INDENT_LEVELS) * 20')
    // The old unbounded form must be gone, not just superseded.
    expect(source).not.toContain('team.level * 20')
  })

  it('shows the description as inline card text rather than a hover-only tooltip on the card surface', () => {
    const cardBlockStart = source.indexOf('sm:hidden divide-y')
    const tableBlockStart = source.indexOf('hidden sm:block overflow-x-auto')
    const cardBlock = source.slice(cardBlockStart, tableBlockStart)
    expect(cardBlock).toContain('{team.description}')
    // No group-hover tooltip trickery inside the card block.
    expect(cardBlock).not.toContain('group-hover:opacity-100')
  })

  it('renders every stat the table hides below md: (Prefix, Team Devices, Team Admins, Sub-teams) inside the card, unhidden', () => {
    const cardBlockStart = source.indexOf('sm:hidden divide-y')
    const tableBlockStart = source.indexOf('hidden sm:block overflow-x-auto')
    const cardBlock = source.slice(cardBlockStart, tableBlockStart)
    expect(cardBlock).toContain('{team.device_count || 0}')
    expect(cardBlock).toContain('{team.admin_count || 0}')
    expect(cardBlock).toContain('{team.sub_teams_count || 0}')
    expect(cardBlock).toContain('{team.callsign_prefix}')
  })

  it('shows each stat as "Label: value" on a single line, not a label stacked above the value on two lines', () => {
    const cardBlockStart = source.indexOf('sm:hidden divide-y')
    const tableBlockStart = source.indexOf('hidden sm:block overflow-x-auto')
    const cardBlock = source.slice(cardBlockStart, tableBlockStart)
    // The label carries a trailing colon and sits in the SAME flex
    // container as its value span, rather than a label <span> followed
    // by a value <p> as separate block-level siblings.
    expect(cardBlock).toContain('Members:')
    expect(cardBlock).toContain('Team Devices:')
    expect(cardBlock).toContain('flex items-baseline gap-1')
    // The old two-line-per-stat wrapper (label span, then a block <p>
    // for the value) must be gone from the card block.
    expect(cardBlock).not.toContain('<p className="text-gray-900 dark:text-gray-100">{team.member_count || 0}</p>')
  })
})

describe('getParentBreadcrumb', () => {
  const teams = [
    { id: 1, name: 'Org One', callsign_prefix: 'FENZ' },
    { id: 2, name: 'Sub Team', callsign_prefix: null, parent_team_id: 1 },
    { id: 3, name: 'No Prefix Parent', callsign_prefix: null },
    { id: 4, name: 'Child of No Prefix', callsign_prefix: null, parent_team_id: 3 },
  ]

  it('returns null for a root team (level 0)', () => {
    expect(getParentBreadcrumb({ level: 0, parent_team_id: null }, teams)).toBeNull()
  })

  it('returns null for a falsy/missing team', () => {
    expect(getParentBreadcrumb(null, teams)).toBeNull()
    expect(getParentBreadcrumb(undefined, teams)).toBeNull()
  })

  it("returns the parent's callsign_prefix when present", () => {
    expect(getParentBreadcrumb({ level: 1, parent_team_id: 1 }, teams)).toBe('FENZ')
  })

  it("falls back to the parent's name when it has no callsign_prefix", () => {
    expect(getParentBreadcrumb({ level: 1, parent_team_id: 3 }, teams)).toBe('No Prefix Parent')
  })

  it('returns null when the parent is not present in `teams` (e.g. a regular user who only sees their own team)', () => {
    expect(getParentBreadcrumb({ level: 1, parent_team_id: 999 }, teams)).toBeNull()
  })
})

// Bugfix (mobile UI/UX pass): "Create Team" is icon-only on every
// viewport now (was icon + visible text), so it doesn't force a wider
// header row than necessary on a narrow phone. Name carried via
// aria-label/title since there is no visible text left to announce it.
describe('Teams.jsx: "Create Team" button is icon-only (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Teams.jsx'), 'utf8')

  it('renders no visible "Create Team" text node, only the PlusIcon plus an aria-label/title', () => {
    const buttonIndex = source.indexOf('aria-label="Create Team"')
    expect(buttonIndex).toBeGreaterThan(-1)
    const buttonStart = source.lastIndexOf('<button', buttonIndex)
    const buttonEnd = source.indexOf('</button>', buttonIndex)
    const button = source.slice(buttonStart, buttonEnd)
    expect(button).toContain('title="Create Team"')
    expect(button).toContain('<PlusIcon')
    expect(button).not.toContain('>Create Team<')
  })
})

// Bugfix (mobile UI/UX pass): the pagination row's "Showing X to Y of Z
// teams" summary competing against the Previous/Page-N-of-M/Next button
// cluster on one line was tight on a narrow phone with no wrap
// fallback -- `flex-wrap gap-2` lets the button cluster drop to its own
// line instead.
describe('Teams.jsx: pagination row wraps on a narrow viewport (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Teams.jsx'), 'utf8')

  it('adds flex-wrap and a gap to the pagination summary+controls row', () => {
    const index = source.indexOf('Showing {startIndex + 1} to')
    expect(index).toBeGreaterThan(-1)
    const rowOpenIndex = source.lastIndexOf('<div className="flex', index)
    const rowLine = source.slice(rowOpenIndex, source.indexOf('>', rowOpenIndex))
    expect(rowLine).toContain('flex-wrap')
    expect(rowLine).toContain('justify-between')
    expect(rowLine).toContain('gap-2')
  })
})
