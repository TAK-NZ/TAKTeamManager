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
