import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isValidCallsignPrefixInput } from '../components/TeamFormDialog.jsx';
import { getParentBreadcrumb, rootOrgLabel } from './Teams.jsx';

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

  // The four count columns' ORDER (Members, Team Devices, Team Admins,
  // Sub-teams) is anchored on the durable `handleSort('<field>')` sort
  // call sites -- which survived the "text label -> icon header" change
  // -- rather than on the header's rendered text, which is now an icon
  // (see the icon-header test just below). This is the "tighten the
  // query, don't loosen the assertion" convention: the column set and
  // ordering are still asserted, just via a signal the icon change
  // didn't remove.
  it('renders the four count column headers sorting on member/device/admin/sub_teams count, in that left-to-right order', () => {
    const membersIndex = source.indexOf("handleSort('member_count')")
    const devicesIndex = source.indexOf("handleSort('device_count')")
    const adminsIndex = source.indexOf("handleSort('admin_count')")
    const subTeamsIndex = source.indexOf("handleSort('sub_teams_count')")
    expect(membersIndex).toBeGreaterThan(-1)
    expect(devicesIndex).toBeGreaterThan(membersIndex)
    expect(adminsIndex).toBeGreaterThan(devicesIndex)
    expect(subTeamsIndex).toBeGreaterThan(adminsIndex)
  })

  it('renders the device_count/admin_count data cells, defaulting to 0', () => {
    expect(source).toContain('{team.device_count || 0}')
    expect(source).toContain('{team.admin_count || 0}')
  })
})

// The four count columns (Members, Team Devices, Team Admins, Sub-teams)
// use an ICON header rather than a text label, to make the columns
// narrower and avoid the table overflow-scrolling on a typical desktop.
// Accessibility requires the meaning NOT be carried by the icon alone,
// so each header must keep an `aria-label`/`title` naming the column and
// mark the icon `aria-hidden`. Icons match TeamDetail.jsx's own tab
// iconography for these concepts. Source-contract check, matching this
// file's own established convention.
describe('Teams.jsx overview table: count columns use accessible icon headers (bugfix: narrower columns)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Teams.jsx'), 'utf8')
  // Scope to the desktop table block so the mobile card's own text
  // labels ("Members:", etc.) are not what these assertions match.
  const tableBlock = source.slice(source.indexOf('hidden sm:block overflow-x-auto'))

  it.each([
    ['member_count', 'Members', 'UsersIcon'],
    ['device_count', 'Team Devices', 'DevicePhoneMobileIcon'],
    ['admin_count', 'Team Admins', 'ShieldCheckIcon'],
    ['sub_teams_count', 'Sub-teams', 'BuildingOfficeIcon']
  ])('the %s header renders %s as an aria-hidden icon (%s) with an aria-label and title carrying the name', (field, label, iconName) => {
    // Locate this specific header by its sort field, then inspect the
    // <th> element around it.
    const sortIdx = tableBlock.indexOf(`handleSort('${field}')`)
    expect(sortIdx, `header for ${field} should exist`).toBeGreaterThan(-1)
    const thStart = tableBlock.lastIndexOf('<th', sortIdx)
    const thEnd = tableBlock.indexOf('</th>', sortIdx)
    const th = tableBlock.slice(thStart, thEnd)

    expect(th).toContain(`aria-label="${label}"`)
    expect(th).toContain(`title="${label}"`)
    expect(th).toContain(`<${iconName} `)
    expect(th).toContain('aria-hidden="true"')
    // The meaning must NOT be a bare visible text label anymore -- the
    // old `<span>Members</span>`-style header is gone.
    expect(th).not.toContain(`<span>${label}</span>`)
  })

  it('imports the four heroicons it uses for the count-column headers', () => {
    expect(source).toContain('UsersIcon')
    expect(source).toContain('DevicePhoneMobileIcon')
    expect(source).toContain('ShieldCheckIcon')
    expect(source).toContain('BuildingOfficeIcon')
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

// Bugfix (/teams showed the IMMEDIATE parent's prefix, not the root
// Organisation's): a deeply-nested team like LandSAR > Specialist Teams
// > Cave Search and Rescue > Auckland rendered as "CAVE - Auckland"
// (the immediate parent Cave's prefix) instead of the correct "LSAR -
// Auckland" (the root Organisation's prefix), which is what
// /request-access already shows. `getParentBreadcrumb` now resolves the
// ROOT org via `rootOrgLabel`, matching the server's canonical rule
// (root = the ancestor with `parent_team_id IS NULL`).
describe('getParentBreadcrumb / rootOrgLabel (root Organisation, not immediate parent)', () => {
  const teams = [
    { id: 1, name: 'Org One', callsign_prefix: 'FENZ' },
    { id: 2, name: 'Sub Team', callsign_prefix: 'SUB', parent_team_id: 1 },
    { id: 3, name: 'No Prefix Org', callsign_prefix: null },
    { id: 4, name: 'Child of No Prefix', callsign_prefix: null, parent_team_id: 3 },
    // A three-deep chain mirroring the real LandSAR case:
    // LSAR (10) > Specialist Teams (11) > Cave (12) > Auckland (13).
    { id: 10, name: 'Land Search and Rescue New Zealand', callsign_prefix: 'LSAR' },
    { id: 11, name: 'Specialist Teams', callsign_prefix: 'SPEC', parent_team_id: 10 },
    { id: 12, name: 'Cave Search and Rescue', callsign_prefix: 'CAVE', parent_team_id: 11 },
    { id: 13, name: 'Auckland', callsign_prefix: 'AUCK', parent_team_id: 12 },
  ]

  it('returns null for a root team (level 0)', () => {
    expect(getParentBreadcrumb({ level: 0, parent_team_id: null }, teams)).toBeNull()
  })

  it('returns null for a falsy/missing team', () => {
    expect(getParentBreadcrumb(null, teams)).toBeNull()
    expect(getParentBreadcrumb(undefined, teams)).toBeNull()
  })

  it("returns the root Organisation's callsign_prefix for a direct child", () => {
    expect(getParentBreadcrumb({ level: 1, id: 2, parent_team_id: 1 }, teams)).toBe('FENZ')
  })

  it("falls back to the root Organisation's name when the root has no callsign_prefix", () => {
    expect(getParentBreadcrumb({ level: 1, id: 4, parent_team_id: 3 }, teams)).toBe('No Prefix Org')
  })

  it("resolves the ROOT org's prefix for a deeply-nested team, NOT the immediate parent's (the CAVE-vs-LSAR bug)", () => {
    // Auckland's immediate parent is Cave (CAVE); its root org is LSAR.
    expect(getParentBreadcrumb({ level: 3, id: 13, parent_team_id: 12 }, teams)).toBe('LSAR')
    // And directly via rootOrgLabel, for the intermediate levels too.
    expect(rootOrgLabel({ id: 12, parent_team_id: 11 }, teams)).toBe('LSAR')
    expect(rootOrgLabel({ id: 11, parent_team_id: 10 }, teams)).toBe('LSAR')
  })

  it('returns null when the parent chain is not present in `teams` (e.g. a regular user who only sees their own team)', () => {
    expect(getParentBreadcrumb({ level: 1, id: 900, parent_team_id: 999 }, teams)).toBeNull()
  })

  it('does not loop forever on a cyclic parent_team_id chain (defensive)', () => {
    const cyclic = [
      { id: 20, name: 'A', callsign_prefix: 'A', parent_team_id: 21 },
      { id: 21, name: 'B', callsign_prefix: 'B', parent_team_id: 20 },
    ]
    // Should terminate and return one of the two labels, never hang.
    const result = getParentBreadcrumb({ level: 1, id: 20, parent_team_id: 21 }, cyclic)
    expect(['A', 'B']).toContain(result)
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

// Bugfix (hierarchy rendered incorrectly for a database with more than
// 50 teams -- specifically, a large CSV import of a multi-level Team
// hierarchy): GET /teams/my-teams' admin "all teams" branch is
// paginated, defaulting to pageSize: 50 (server/middleware/
// pagination.js) whenever no pageSize is supplied at all.
// `buildTeamHierarchy` needs EVERY team in one fetch to resolve
// parent_team_id correctly -- a team whose parent sorted past the
// default 50-row cutoff was silently missing from the fetched list,
// and any of ITS OWN children then rendered as if they were separate
// top-level Organisations, since `buildTeamHierarchy` treats a team
// whose parent isn't in the fetched set as an orphan root. Fixed by
// requesting the server's own MAX_PAGE_SIZE (200) explicitly.
describe('Teams.jsx: fetches the full (non-default-paginated) team list for hierarchy building (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Teams.jsx'), 'utf8')

  it('calls teamsAPI.getMyTeams with an explicit pageSize of 200, not the bare no-args call', () => {
    expect(source).toContain('teamsAPI.getMyTeams({ pageSize: 200 })')
    // Guards against a future edit reverting to the old bare call
    // anywhere in this file's fetch effect.
    expect(source).not.toMatch(/teamsAPI\.getMyTeams\(\)/)
  })
})

// Bugfix (table overflowed into horizontal scroll on long nested names):
// the desktop table's Team Name cell shows ONLY the team's own name --
// the parent org/team prefix is deliberately NOT prepended (the
// hierarchy is already conveyed by the row's indentation and the expand
// tree, so "LANDSAR - Local Groups" would be redundant). The full parent
// context stays reachable via the Link's `title` ("Parent > Name"), and
// the name `truncate`s (rather than the table horizontal-scrolling) when
// a single name is genuinely too long. Source-contract check, matching
// this file's own established convention.
describe('Teams.jsx overview table: Team Name shows the bare name (no parent prefix), truncating instead of horizontal scroll', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Teams.jsx'), 'utf8')
  const tableBlock = source.slice(source.indexOf('hidden sm:block overflow-x-auto'))

  it('renders the bare team name in the Link, never a prefixed "PARENT - Name" as the displayed text', () => {
    const linkIdx = tableBlock.indexOf('to={`/teams/${team.id}`}')
    expect(linkIdx, 'the name Link should exist').toBeGreaterThan(-1)
    const linkBlock = tableBlock.slice(linkIdx, tableBlock.indexOf('</Link>', linkIdx))
    // Displayed text is the bare name.
    expect(linkBlock).toContain('{team.name}')
    // The old inline prefixed forms (rendered as the Link's TEXT, with a
    // " - " separator) must be gone from the displayed name. The `title`
    // attribute legitimately still references the parent, but it now uses
    // a " > " breadcrumb separator, so a stray " - ${team.name}" rendered
    // child would be a regression this catches.
    expect(linkBlock).not.toContain('- ${team.name}`')
    expect(linkBlock).not.toContain("|| 'Root'} - ")
  })

  it('gives the name cell a bounded width and min-w-0 flex so a long name truncates rather than the table scrolling', () => {
    // The Name <td> is the flexible one (max-w-0 w-full) and its inner
    // flex row carries min-w-0 so `truncate` on the name Link can take
    // effect.
    expect(tableBlock).toContain('max-w-0 w-full')
    expect(tableBlock).toMatch(/relative group flex items-center min-w-0/)
    const linkIdx = tableBlock.indexOf('to={`/teams/${team.id}`}')
    const linkOpen = tableBlock.slice(linkIdx, tableBlock.indexOf('>', linkIdx))
    expect(linkOpen).toContain('truncate min-w-0')
  })

  it('keeps the full ROOT-org context reachable via the name Link\'s title attribute (breadcrumb form)', () => {
    // The title carries "<RootOrgPrefix> > Name" for a non-root row so
    // the hierarchy is still discoverable on hover/focus even though the
    // displayed name is bare -- and it uses the ROOT organisation's
    // prefix (via rootOrgLabel), not the immediate parent's, matching
    // what /request-access shows.
    expect(tableBlock).toMatch(/title=\{team\.level > 0 \? `\$\{rootOrgLabel\(team, teams\)/)
    expect(tableBlock).toContain('} > ${team.name}`')
  })
})

// Cascade-delete feature: a Global_Manager may now delete a team that
// HAS sub-teams (the whole subtree is removed, gated server-side on the
// subtree being empty of members/devices). The delete action-icon is no
// longer disabled for a team-with-sub-teams, and PERMANENT deletion now
// uses this app's type-to-confirm tier (type the team's name exactly).
// Source-contract checks, matching this file's own established
// convention.
describe('Teams.jsx: cascade delete (enabled for teams-with-sub-teams) + type-to-confirm dialog', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Teams.jsx'), 'utf8')

  it('TeamRowActions no longer renders a disabled delete button for a team with sub-teams', () => {
    // The old dedicated "disabled + Cannot delete team with sub-teams"
    // branch is gone; a single enabled delete button covers both cases.
    expect(source).not.toContain('Cannot delete team with sub-teams')
    expect(source).not.toContain('dangerDisabledClass')
  })

  it('the single delete button is gated only on isGlobalAdmin (not on hasSubTeams) and titles the cascade', () => {
    const fnIdx = source.indexOf('function TeamRowActions(')
    const fnBlock = source.slice(fnIdx, source.indexOf('export default function Teams', fnIdx))
    // Exactly one delete <button> (onDelete) remains.
    const deleteButtons = fnBlock.split('onClick={() => onDelete(team.id)}').length - 1
    expect(deleteButtons).toBe(1)
    // Its title reflects the cascade when the team has sub-teams.
    expect(fnBlock).toContain("hasSubTeams ? 'Delete team and all its sub-teams' : 'Delete team'")
  })

  it('the delete dialog is type-to-confirm: Confirm is gated on the typed name matching the target exactly', () => {
    expect(source).toContain('const confirmDisabled = deleting || deleteConfirmInput !== targetName')
    // The type-to-confirm input exists and is labelled with the target name.
    expect(source).toContain('id="delete-team-confirm"')
    expect(source).toMatch(/Type "<span[^>]*>\{targetName\}<\/span>" to confirm:/)
  })

  it('the dialog warns about deleting the whole subtree when the target has sub-teams', () => {
    expect(source).toMatch(/also permanently delete all \{subTeamsCount\} sub-team/)
    expect(source).toContain('no team in this branch has any members or team devices')
  })

  it('surfaces the server refusal inline via deleteError rather than only a toast, and keeps the dialog open', () => {
    // handleDeleteTeam sets deleteError from the server response and does
    // NOT close the dialog on error.
    expect(source).toContain('setDeleteError(error.response?.data?.error')
    expect(source).toMatch(/\{deleteError && \(/)
    expect(source).toContain('role="alert"')
  })

  it('a successful delete removes the WHOLE subtree from local state, not just the one row', () => {
    expect(source).toContain('const subtreeTeamIds =')
    expect(source).toContain('const removed = subtreeTeamIds(deleteTeamId)')
    expect(source).toContain('setTeams(teams.filter(team => !removed.has(team.id)))')
  })

  it('Cancel clears the typed name and the error so a re-open never starts pre-filled', () => {
    const fnIdx = source.indexOf('const closeDeleteDialog =')
    const fnBlock = source.slice(fnIdx, source.indexOf('}', source.indexOf('{', fnIdx)) + 1)
    expect(fnBlock).toContain('setDeleteConfirmInput(\'\')')
    expect(fnBlock).toContain('setDeleteError(null)')
  })
})
