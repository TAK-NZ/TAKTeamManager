import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Validates: Requirements 1.1, 1.4, 4.8, 5.3, 7.5, 9.2, 9.3, 9.5, 10.1, 10.2
//
// Admin.jsx surfaces the Email Template Editor and the Settings Export /
// Import controls in the Global_Manager /admin page. The behavior these
// tests pin down is structural: which advisory notices are present, how the
// import-rejection branch renders, and that no template request is issued
// for a non-Global_Manager. Admin.jsx is a large page component with many
// stateful hooks and no exported pure helpers for this UI, so -- following
// the dominant `readFileSync` source-contract convention already used by
// src/pages/TeamDetail.test.jsx and src/services/api.test.js -- these tests
// assert against the component source rather than mounting the page. The
// assertions target stable phrases and code shapes, not brittle full copy.

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const adminSource = readFileSync(join(__dirname, 'Admin.jsx'), 'utf8')

// Collapse runs of whitespace (including the newlines JSX wraps notice copy
// across) so a phrase split over several source lines still matches.
const normalized = adminSource.replace(/\s+/g, ' ')

// The database-backed Colour Mappings / Role
// Descriptions tabs (and the settingsAPI.getTakMappings/updateTakMappings
// wrappers they used) have been removed entirely. These deployments
// source TAK_COLOR_*/TAK_ROLE_* from a deploy-time env file, so an
// in-app-editable database override was a second, competing source of
// truth. Dashboard.jsx/Teams.jsx/TeamDetail.jsx already read the
// env-backed GET /api/config/color-mappings directly and are unaffected.
describe('Admin.jsx no longer has a database-backed color/role mapping surface', () => {
  it('does not call the removed settingsAPI tak-mappings wrappers', () => {
    expect(adminSource).not.toContain('settingsAPI.getTakMappings')
    expect(adminSource).not.toContain('settingsAPI.updateTakMappings')
  })

  it('does not render a Colour Mappings or Role Descriptions tab', () => {
    expect(adminSource).not.toContain('Colour Mappings')
    expect(adminSource).not.toContain('Role Descriptions')
  })
})

describe('Admin.jsx template editor structure (task 7.4)', () => {
  // Req 4.8: a saved template takes effect immediately because the server
  // reads template content from the database at send time.
  it('renders the immediate-effect advisory notice for saved templates (Req 4.8)', () => {
    expect(normalized).toContain('takes effect immediately')
    expect(normalized).toContain('server reads template content from the database at')
  })

  // Req 5.3: the variable-hints block is labeled advisory / not enforced and
  // is driven by getVariableHints.
  it('labels the variable hints as advisory and not enforced, tied to getVariableHints (Req 5.3)', () => {
    expect(normalized).toContain('advisory only')
    expect(normalized).toContain('not enforced')
    // The advisory block renders from the getVariableHints helper.
    expect(adminSource).toContain('getVariableHints(selectedTemplateKey)')
  })
})

describe('Admin.jsx export/import structure (task 8.3)', () => {
  // Req 7.5: notice adjacent to the export control -- secrets excluded and it
  // is a settings export, not a backup of domain data.
  it('renders the export secrets-excluded / not-a-DB-backup notice (Req 7.5)', () => {
    expect(normalized).toContain('excludes secrets')
    expect(normalized).toContain('settings export, not a backup of domain data')
  })

  // Req 9.5: notice adjacent to the import control -- the excluded secret is
  // not restored and must be re-entered separately.
  it('renders the import secret-must-be-re-entered notice (Req 9.5)', () => {
    // The notice wraps "not" in inline markup, so match the stable phrases
    // on either side rather than the full sentence.
    expect(normalized).toContain('restore the excluded')
    expect(normalized).toContain('must be re-entered separately')
  })

  // Req 10.1 / 10.2: durability notice -- UI-edited templates/settings live
  // only in the application database, not in a config file, and recovery
  // depends on a DB backup or a previously produced export.
  it('renders the durability notice (Req 10.1, 10.2)', () => {
    expect(normalized).toContain('stored only in the')
    expect(normalized).toContain('application database')
    expect(normalized).toContain('not written to any configuration file')
    expect(normalized).toContain('separate database backup')
  })

  // Req 9.2 / 9.3: an import rejected with HTTP 400 renders each problem from
  // the returned `problems` array and states that nothing was changed.
  it('renders a problems list and a no-change statement on a 400 rejection (Req 9.2, 9.3)', () => {
    // Req 9.2: each Import_Problem is rendered from the problems array.
    expect(adminSource).toContain('importProblems.map')
    // Req 9.3: an explicit no-change statement accompanies the rejection.
    expect(normalized).toContain('No settings were changed')
  })

  // Req 9.2 / 9.3: the import handler treats HTTP 400 with a `problems` array
  // as a first-class rejection outcome, distinct from a generic error.
  it('branches handleImportSettings on a 400 response reading problems (Req 9.2, 9.3)', () => {
    expect(adminSource).toContain('const handleImportSettings')
    expect(normalized).toContain('error.response?.data?.problems')
    expect(normalized).toContain('error.response?.status === 400')
    expect(adminSource).toContain('setImportProblems(problems)')
  })
})

describe('Admin.jsx Global_Manager gating (task 9.1)', () => {
  // Req 1.1 / 1.2: the whole tabbed admin UI (which contains both new
  // sections) is unreachable behind the Access-Denied early return for a
  // non-Global_Manager.
  it('early-returns the Access Denied view when the user is not an admin (Req 1.1, 1.2)', () => {
    expect(adminSource).toContain('if (!user?.isAdmin)')
    expect(normalized).toContain('Access Denied')
  })

  // Req 1.4: because React hooks cannot be conditional, the mount effect runs
  // before the early return -- so the new template-list fetch is guarded to
  // not issue a communications template request for a non-admin.
  it('guards the template-list fetch so it does not fire for a non-admin (Req 1.4)', () => {
    // The fetch that calls listTemplates must return early for a non-admin.
    const fetchStart = adminSource.indexOf('const fetchTemplateList')
    expect(fetchStart).toBeGreaterThan(-1)
    const listCallIndex = adminSource.indexOf('communicationsAPI.listTemplates()', fetchStart)
    expect(listCallIndex).toBeGreaterThan(-1)
    const guardIndex = adminSource.indexOf('if (!user?.isAdmin)', fetchStart)
    // The guard sits inside fetchTemplateList and before the network call.
    expect(guardIndex).toBeGreaterThan(fetchStart)
    expect(guardIndex).toBeLessThan(listCallIndex)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// date-tooltips-and-folder-contrast task 6.7 -- Criteria 2.1, 2.3, 3.8.
//
// Date_Render_Positions 9 and 10 are the last-sync and template-last-updated
// values, and they are TWO of the FOUR non-table positions: `<p>` elements
// inside cards rather than cells inside an `overflow-x-auto` wrapper.
// (requirements.md Criterion 3.4 counts eight table cells and names only
// these two as non-table; measured, it is six and four, the other two being
// Requests' "Submitted" values -- design.md correction 1.)
//
// These assertions are SOURCE-LEVEL, following this file's own documented
// convention rather than diverging from it: Admin.jsx is a ~1100-line page
// whose two date branches sit behind `syncStatus?.last_sync && !syncing` and
// `templateLoaded && !templateLoadError && templateUpdatedAt`, so reaching
// them means standing up the whole page's API surface for a claim that is
// about which component renders the value. Criterion 3.8's real content --
// that a `<p>`-hosted position carries the SAME placement classes a table
// cell does -- is measured where it can be measured, mounted, in
// `src/pages/Requests.test.jsx`, against the other two non-table positions.
// What is checked here is that these two reach the same shared component the
// same way, which is what makes the placement identical by construction.
// ══════════════════════════════════════════════════════════════════════════
describe('Admin.jsx non-table Date_Render_Positions (task 6.7)', () => {
  const occurrences = (needle) => normalized.split(needle).length - 1

  it('renders both values through the ONE shared Formatted_Date (Criterion 2.1)', () => {
    expect(adminSource).toMatch(
      /import\s+FormattedDate[^\n]*from\s+'\.\.\/components\/FormattedDate'/
    )
    expect(occurrences('<FormattedDate')).toBe(2)
    // The two positions this page owns, named by the value each renders.
    expect(normalized).toContain('<FormattedDate value={syncStatus.last_sync}')
    expect(normalized).toContain('<FormattedDate value={templateUpdatedAt}')
  })

  it('leaves no direct Date_Format_Helper call behind (Criteria 2.1, 2.12)', () => {
    // The drift guard in `src/utils/dateFormatConsumers.test.js` makes this
    // mechanical across the whole client; asserted here too because this page
    // is where the two calls used to be.
    expect(adminSource).not.toMatch(/from\s+'\.\.\/utils\/dateFormat'/)
    expect(adminSource).not.toMatch(/[^`]formatDateTime\(/)
    expect(adminSource).not.toMatch(/[^`]formatDate\(/)
  })

  it('gives both the same Sideways_Tooltip_Placement as the table positions (Criterion 3.8)', () => {
    // Both are leading-half positions, so both open rightward. One tooltip
    // behaviour for the application, not one per surrounding element type.
    expect(occurrences('side={TOOLTIP_SIDES.RIGHT}')).toBe(2)
    expect(normalized).not.toContain('TOOLTIP_SIDES.LEFT')
    // Both render a timestamp, so both anchor their phrase on the value's own
    // instant rather than on a Midnight_Anchor (Criterion 4.5).
    expect(occurrences('precision={DATE_PRECISION.DATE_TIME}')).toBe(2)
    // Matched WITH the closing brace: `DATE_PRECISION.DATE` is a prefix of
    // `DATE_PRECISION.DATE_TIME`, so the bare token matches both.
    expect(normalized).not.toContain('precision={DATE_PRECISION.DATE}')
  })

  it('keeps the "Last updated:" label outside the component (Criterion 2.3)', () => {
    // Only the VALUE acquires the disclosure, so the rendered string -- the
    // separating space included -- is unchanged character for character.
    expect(normalized).toContain("Last updated:{' '} <FormattedDate")
  })
})

// The /admin dashboard's stat cards. In addition to the pre-existing Total
// Teams / Total Users, the page now shows Total Team Devices and Total
// Channels (team + global), backed by GET /api/admin/stats via
// adminAPI.getStats(). Source-contract assertions, matching this file's
// established convention (Admin.jsx is a large stateful page with no
// exported pure helpers for this UI).
describe('Admin.jsx stat cards (Total Team Devices, Total Channels)', () => {
  it('fetches the aggregate counts via adminAPI.getStats() alongside the existing users/teams calls', () => {
    expect(adminSource).toContain("import { configAPI, usersAPI, teamsAPI, syncAPI, bulkImportAPI, communicationsAPI, settingsAPI, adminAPI } from '../services/api'")
    expect(adminSource).toContain('adminAPI.getStats()')
  })

  it('seeds the stats state with the two new keys and populates them from the response', () => {
    expect(adminSource).toContain('totalDevices: 0, totalChannels: 0')
    expect(normalized).toContain('totalDevices: adminStatsResponse.data.totalDevices ?? 0')
    expect(normalized).toContain('totalChannels: adminStatsResponse.data.totalChannels ?? 0')
  })

  it('renders a Total Team Devices card bound to stats.totalDevices', () => {
    expect(normalized).toContain('Total Team Devices')
    expect(normalized).toContain('{stats.totalDevices}')
  })

  it('renders a Total Channels card bound to stats.totalChannels', () => {
    expect(normalized).toContain('Total Channels')
    expect(normalized).toContain('{stats.totalChannels}')
  })
})
