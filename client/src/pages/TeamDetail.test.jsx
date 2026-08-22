import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatCallsignLevels, formatCallsignNameFormatExample, computeTeamDepth, getInitialMemberEditForm, isValidMemberCallsignSuffix, isValidSubTeamCallsignPrefix, decideCallsignSuffixPreview, extractCallsignSuffixServerError } from './TeamDetail.jsx';

// Validates: Requirements 1.1, 1.2, 2.4, 2.5
//
// TeamDetail.jsx applies `labelFor` to the header/breadcrumbs/dialog
// titles (Req 1), disables "Add Sub-team" at Max_Team_Depth (Req 2.4/2.5),
// and replaces the root-only Depth/format badge pair with a "Levels: ..."
// summary plus a format badge with example strings for the two new
// `callsign_name_format` values (design.md's "Callsign summary badges").
// No component-render test harness (e.g. @testing-library/react) is set
// up in this project -- see src/services/api.test.js,
// src/utils/channelTree.test.js, and src/pages/Requests.test.jsx, which
// all test extracted pure logic rather than rendering a component -- so
// this file follows that same convention and tests the pure helpers
// TeamDetail.jsx uses to compute its depth-disable state and badge text.

describe('formatCallsignLevels', () => {
  it('renders a sorted, comma-separated "Levels: ..." summary', () => {
    expect(formatCallsignLevels([4, 1, 2])).toBe('1, 2, 4')
  })

  it('renders "All" for an empty selection', () => {
    expect(formatCallsignLevels([])).toBe('All')
  })

  it('renders "All" when the selection is null/undefined (no Organisation value yet)', () => {
    expect(formatCallsignLevels(null)).toBe('All')
    expect(formatCallsignLevels(undefined)).toBe('All')
  })

  it('renders a single-level selection without a trailing separator', () => {
    expect(formatCallsignLevels([3])).toBe('3')
  })
})

describe('formatCallsignNameFormatExample', () => {
  it('returns "John Doe" for full_name', () => {
    expect(formatCallsignNameFormatExample('full_name')).toBe('John Doe')
  })

  it('returns "J Doe" for first_initial_last', () => {
    expect(formatCallsignNameFormatExample('first_initial_last')).toBe('J Doe')
  })

  it('returns "John D" for first_last_initial', () => {
    expect(formatCallsignNameFormatExample('first_last_initial')).toBe('John D')
  })

  it('returns "J.Doe" for the new first_initial_dot_last format (Req 8.6)', () => {
    expect(formatCallsignNameFormatExample('first_initial_dot_last')).toBe('J.Doe')
  })

  it('returns "Custom" for the new user_defined format (Req 11.5)', () => {
    expect(formatCallsignNameFormatExample('user_defined')).toBe('Custom')
  })

  it('falls back to the full_name example for an unrecognized/missing value', () => {
    expect(formatCallsignNameFormatExample(undefined)).toBe('John Doe')
    expect(formatCallsignNameFormatExample('something_else')).toBe('John Doe')
  })
})

describe('computeTeamDepth (Req 2.4/2.5 disable-state rendering at depth-4-vs-5)', () => {
  // A 5-level chain: Org(1) -> Team(2) -> Team(3) -> Team(4) -> Team(5),
  // i.e. team 5 sits at Team_Depth 4 and team-to-be-created-under-it would
  // sit at depth 5 (== MAX_TEAM_DEPTH in this codebase).
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

  it('returns 4 for a team at depth 4 (one level below the 5-max default), rendering "Add Sub-team" enabled', () => {
    const team = allTeams.find(t => t.id === 5)
    const depth = computeTeamDepth(team, allTeams)
    expect(depth).toBe(4)
    const maxTeamDepth = 5
    expect(depth >= maxTeamDepth).toBe(false)
  })

  it('returns 5 for a hypothetical team one level deeper, rendering "Add Sub-team" disabled', () => {
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

// Validates: Requirements 11.13, 13.1, 13.2, 13.3, 13.5
//
// TeamDetail.jsx's Members/Team Admins tabs gain a per-row inline edit
// form (first name, last name, TAK_Role select, callsign_suffix input).
// `getInitialMemberEditForm` seeds that form from a Member_List row when
// its "Edit" pencil icon is clicked; `isValidMemberCallsignSuffix` mirrors
// server/utils/callsignValidation.js's character-class check at the point
// of entry. Both are pure helpers, tested directly per this project's
// no-component-render-harness convention (see the file header comment
// above).

describe('getInitialMemberEditForm', () => {
  it('seeds the form from a member row\'s current values', () => {
    const member = { id: 1, first_name: 'Jane', last_name: 'Doe', tak_role: 'Team Lead', callsign_suffix: 'J.Doe', email: 'jane@example.com' }
    expect(getInitialMemberEditForm(member)).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      takRole: 'Team Lead',
      callsignSuffix: 'J.Doe'
    })
  })

  it('does not include an email field anywhere in the seeded form (Req 13.3)', () => {
    const member = { id: 1, first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' }
    expect(getInitialMemberEditForm(member)).not.toHaveProperty('email')
  })

  it('defaults tak_role to "Team Member" and callsign_suffix to "" when absent', () => {
    const member = { id: 1, first_name: 'Jane', last_name: 'Doe' }
    expect(getInitialMemberEditForm(member)).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      takRole: 'Team Member',
      callsignSuffix: ''
    })
  })

  it('handles a null/undefined member without throwing', () => {
    expect(getInitialMemberEditForm(null)).toEqual({
      firstName: '', lastName: '', takRole: 'Team Member', callsignSuffix: ''
    })
    expect(getInitialMemberEditForm(undefined)).toEqual({
      firstName: '', lastName: '', takRole: 'Team Member', callsignSuffix: ''
    })
  })
})

describe('isValidMemberCallsignSuffix (Req 11.3)', () => {
  it('accepts an empty value', () => {
    expect(isValidMemberCallsignSuffix('')).toBe(true)
    expect(isValidMemberCallsignSuffix(undefined)).toBe(true)
  })

  it('accepts letters, digits, "-", and "."', () => {
    expect(isValidMemberCallsignSuffix('J.Doe')).toBe(true)
    expect(isValidMemberCallsignSuffix('J-Doe123')).toBe(true)
  })

  it('rejects a value containing a disallowed character', () => {
    expect(isValidMemberCallsignSuffix('J Doe')).toBe(false)
    expect(isValidMemberCallsignSuffix('J_Doe')).toBe(false)
    expect(isValidMemberCallsignSuffix('J@Doe')).toBe(false)
  })
})

// Validates: Requirement 3.10
//
// The Create Sub-Team Dialog's own "Prefix" input
// (`subTeamFormData.callsignPrefix`) gains the same stricter
// letters+digits-only pattern validation as Teams.jsx's `callsignPrefix`
// input (task 32.6), per design.md's "Sub-team creation dialog:
// `callsignPrefix` gains the same stricter pattern validation as
// Teams.jsx." `isValidSubTeamCallsignPrefix` mirrors
// server/utils/callsignValidation.js's `isValidCallsignPrefix` character
// class (letters and digits only, no `-`).

describe('isValidSubTeamCallsignPrefix (Req 3.10)', () => {
  it('accepts an empty value', () => {
    expect(isValidSubTeamCallsignPrefix('')).toBe(true)
    expect(isValidSubTeamCallsignPrefix(undefined)).toBe(true)
  })

  it('accepts letters and digits only', () => {
    expect(isValidSubTeamCallsignPrefix('STL')).toBe(true)
    expect(isValidSubTeamCallsignPrefix('STL123')).toBe(true)
  })

  it('rejects a value containing a "-" (stricter than callsign_suffix)', () => {
    expect(isValidSubTeamCallsignPrefix('NZ-POL')).toBe(false)
  })

  it('rejects a value containing any other disallowed character', () => {
    expect(isValidSubTeamCallsignPrefix('ST.L')).toBe(false)
    expect(isValidSubTeamCallsignPrefix('ST L')).toBe(false)
  })
})
// Validates: Requirement 15.1
//
// Task 13.3 added a `transferringMember` state plus an
// `ArrowRightCircleIcon` transfer button inside the existing
// `canManageTeam &&` action cell of BOTH the Members table and the Team
// Admins table, so the action is offered on rows whose `role` is `member`
// and on rows whose `role` is `admin`.
//
// `canManageTeam` is computed inside the component body
// (`isGlobalAdmin || isTeamAdmin`) and is not exported, and this project
// has no component-render harness (`@testing-library/react` is not a
// dependency -- see the file header comment above). So Requirement 15.1's
// gate is covered in two halves that together pin the behaviour without
// rendering:
//
//   1. `computeCanManageTeam` below mirrors TeamDetail.jsx's gate
//      expression and is exercised over every combination of
//      Global_Manager status and Team_Admin membership, following the
//      source-contract convention already used in
//      src/components/TeamFormDialog.test.jsx.
//   2. The structural tests read TeamDetail.jsx's own source and assert
//      the transfer button in each of the two tables actually sits inside
//      a `canManageTeam &&`-gated action cell, and is gated by nothing
//      else. That is what makes half 1 more than a restatement: if the
//      button were ever moved outside the gate, or given an extra
//      condition, these fail.

// Mirrors TeamDetail.jsx:
//   const isGlobalAdmin = user?.isAdmin
//   const isTeamAdmin = admins.some(a => String(a.id) === String(user?.userId))
//   const canManageTeam = isGlobalAdmin || isTeamAdmin
function computeCanManageTeam(user, admins) {
  const isGlobalAdmin = user?.isAdmin
  const isTeamAdmin = admins.some(a => String(a.id) === String(user?.userId))
  return isGlobalAdmin || isTeamAdmin
}

describe('canManageTeam gate for the transfer action (Req 15.1)', () => {
  const admins = [{ id: 7 }, { id: 9 }]

  it('offers the transfer action to a Global_Manager who is not a Team_Admin of the displayed team', () => {
    expect(computeCanManageTeam({ userId: 42, isAdmin: true }, admins)).toBe(true)
  })

  it('offers the transfer action to a Team_Admin of the displayed team who is not a Global_Manager', () => {
    expect(computeCanManageTeam({ userId: 9, isAdmin: false }, admins)).toBe(true)
  })

  it('offers the transfer action when the user is both a Global_Manager and a Team_Admin', () => {
    expect(computeCanManageTeam({ userId: 7, isAdmin: true }, admins)).toBe(true)
  })

  it('withholds the transfer action when the user is neither a Global_Manager nor a Team_Admin', () => {
    expect(computeCanManageTeam({ userId: 42, isAdmin: false }, admins)).toBe(false)
  })

  it('matches a Team_Admin across the number/string id boundary (String() coercion on both sides)', () => {
    // The admins list comes from the API as numeric ids; `user.userId` may
    // arrive as a string from the JWT payload.
    expect(computeCanManageTeam({ userId: '9', isAdmin: false }, admins)).toBe(true)
    expect(computeCanManageTeam({ userId: 9, isAdmin: false }, [{ id: '9' }])).toBe(true)
  })

  it('withholds the transfer action while the admins list is still empty (not yet loaded)', () => {
    expect(computeCanManageTeam({ userId: 9, isAdmin: false }, [])).toBe(false)
  })

  it('withholds the transfer action for a null/undefined user without throwing', () => {
    expect(computeCanManageTeam(null, admins)).toBeFalsy()
    expect(computeCanManageTeam(undefined, admins)).toBeFalsy()
  })

  it('withholds the transfer action for a user with no userId against real admin rows', () => {
    // Documents the one caveat in the `String(a.id) === String(user?.userId)`
    // comparison: it is only id-absence-safe because every admins row the
    // API returns carries an id. Two absent ids would coerce to the same
    // 'undefined' string and match -- unreachable here, but the reason this
    // case is asserted against real rows rather than a synthetic idless one.
    expect(computeCanManageTeam({ isAdmin: false }, admins)).toBe(false)
  })
})

describe('transfer action placement in TeamDetail.jsx (Req 15.1)', () => {
  // `fileURLToPath` on the string form: the jsdom test environment replaces
  // the global `URL` with whatwg-url, whose instances node:fs rejects.
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  // Returns the `<td>...</td>` cell that encloses `index`.
  function enclosingTableCell(index) {
    const start = source.lastIndexOf('<td', index)
    const end = source.indexOf('</td>', index)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  // `role` of `member` -> the Members table row; `role` of `admin` -> the
  // Team Admins table row. Each table's row variable is what the button's
  // onClick passes to `setTransferringMember`.
  const rows = [
    { role: 'member', rowVar: 'member' },
    { role: 'admin', rowVar: 'admin' }
  ]

  it.each(rows)('renders exactly one transfer action on a $role row', ({ rowVar }) => {
    const occurrences = source.split(`setTransferringMember(${rowVar})`).length - 1
    expect(occurrences).toBe(1)
  })

  it.each(rows)('places the $role row transfer action inside a canManageTeam-gated action cell', ({ rowVar }) => {
    const index = source.indexOf(`setTransferringMember(${rowVar})`)
    expect(index).toBeGreaterThan(-1)

    const cell = enclosingTableCell(index)
    expect(cell).toContain('{canManageTeam && (')
  })

  it.each(rows)('gates the $role row transfer action on canManageTeam alone, with no additional condition', ({ rowVar }) => {
    const index = source.indexOf(`setTransferringMember(${rowVar})`)
    const cell = enclosingTableCell(index)
    const gateStart = cell.indexOf('{canManageTeam && (')
    const between = cell.slice(gateStart + '{canManageTeam && ('.length, cell.indexOf(`setTransferringMember(${rowVar})`))

    // No nested conditional render opens between the gate and the button,
    // so `canManageTeam` is the whole condition on the transfer action.
    expect(between).not.toContain('&& (')
    expect(between).not.toContain('? (')
  })

  it.each(rows)('renders the transfer action on a $role row as the ArrowRightCircleIcon button', ({ rowVar }) => {
    const index = source.indexOf(`setTransferringMember(${rowVar})`)
    const button = source.slice(index, source.indexOf('</button>', index))
    expect(button).toContain('ArrowRightCircleIcon')
    expect(button).toContain('aria-label="Transfer member to another team"')
  })

  it('renders the transfer dialog only while a member has been selected for transfer', () => {
    expect(source).toContain('{transferringMember && (')
    const index = source.indexOf('{transferringMember && (')
    const block = source.slice(index, source.indexOf('/>', index))
    expect(block).toContain('<TransferMemberDialog')
    expect(block).toContain('member={transferringMember}')
    expect(block).toContain('onCompleted={handleTransferCompleted}')
  })
})

// The Add Member Dialog's "Create New User" tab gains a Callsign Suffix
// field fed by the advisory `POST /api/users/callsign-suffix-preview` check.
// `decideCallsignSuffixPreview` is the whole decision that check drives
// (pre-fill / required / inline conflict / leave-alone), extracted as a pure
// helper and tested directly per this file's no-render convention;
// `extractCallsignSuffixServerError` is the submit-time 400 mapping. The
// structural tests below pin the wiring the helpers cannot see: that the
// preview runs on blur rather than per keystroke, and that the suffix is
// actually sent to `usersAPI.createAndAdd`.

describe('decideCallsignSuffixPreview', () => {
  it('pre-fills the field with the resolved suffix when there is no conflict and none is required', () => {
    const decision = decideCallsignSuffixPreview(
      { suffix: 'J.Bloggs', required: false, conflict: null },
      { currentValue: '', manuallyEdited: false }
    )
    expect(decision).toEqual({ callsignSuffix: 'J.Bloggs', required: false, error: null })
  })

  it('does not clobber a value the admin typed themselves', () => {
    const decision = decideCallsignSuffixPreview(
      { suffix: 'Joe.B', required: false, conflict: null },
      { currentValue: 'Joe.B2', manuallyEdited: true }
    )
    expect(decision.callsignSuffix).toBe('Joe.B2')
    expect(decision.error).toBeNull()
  })

  it('marks the field required and leaves it empty for a user_defined Organisation', () => {
    const decision = decideCallsignSuffixPreview(
      { suffix: null, required: true, conflict: null },
      { currentValue: '', manuallyEdited: false }
    )
    expect(decision).toEqual({ callsignSuffix: '', required: true, error: null })
  })

  it('surfaces the conflict message inline without pre-filling the field', () => {
    const decision = decideCallsignSuffixPreview(
      { suffix: 'J.Bloggs', required: false, conflict: { value: 'J.Bloggs', message: 'Callsign suffix J.Bloggs is already used in this team' } },
      { currentValue: '', manuallyEdited: false }
    )
    expect(decision.error).toBe('Callsign suffix J.Bloggs is already used in this team')
    expect(decision.callsignSuffix).toBe('')
  })

  it('surfaces a conflict against a manually typed value while keeping that value', () => {
    const decision = decideCallsignSuffixPreview(
      { suffix: 'Joe.B', required: false, conflict: { value: 'Joe.B', message: 'Already taken' } },
      { currentValue: 'Joe.B', manuallyEdited: true }
    )
    expect(decision).toEqual({ callsignSuffix: 'Joe.B', required: false, error: 'Already taken' })
  })

  it('falls back to a generic message when a conflict carries no message', () => {
    const decision = decideCallsignSuffixPreview(
      { suffix: 'J.Bloggs', required: false, conflict: { value: 'J.Bloggs' } },
      { currentValue: '', manuallyEdited: false }
    )
    expect(decision.error).toBe('That callsign suffix is already in use in this team')
  })

  it('changes nothing when the preview call failed (no body), so submission is never blocked', () => {
    expect(decideCallsignSuffixPreview(undefined, { currentValue: 'Joe.B', manuallyEdited: true })).toBeNull()
    expect(decideCallsignSuffixPreview(null, { currentValue: '', manuallyEdited: false })).toBeNull()
    expect(decideCallsignSuffixPreview('Internal Server Error', { currentValue: '' })).toBeNull()
  })

  it('empties a stale pre-filled value when the server resolves no suffix at all', () => {
    const decision = decideCallsignSuffixPreview(
      { suffix: null, required: false, conflict: null },
      { currentValue: 'J.Bloggs', manuallyEdited: false }
    )
    expect(decision.callsignSuffix).toBe('')
  })
})

describe('extractCallsignSuffixServerError', () => {
  it('returns the server message for a 400 (suffix required, or per-team collision)', () => {
    const error = { response: { status: 400, data: { error: 'Callsign suffix is required for this Organisation' } } }
    expect(extractCallsignSuffixServerError(error)).toBe('Callsign suffix is required for this Organisation')
  })

  it('returns null for any non-400 failure, leaving the generic toast in place', () => {
    expect(extractCallsignSuffixServerError({ response: { status: 500, data: { error: 'boom' } } })).toBeNull()
    expect(extractCallsignSuffixServerError({ response: { status: 403, data: { error: 'nope' } } })).toBeNull()
  })

  it('returns null for a 400 with no string error body, and for a network failure', () => {
    expect(extractCallsignSuffixServerError({ response: { status: 400, data: {} } })).toBeNull()
    expect(extractCallsignSuffixServerError({ message: 'Network Error' })).toBeNull()
    expect(extractCallsignSuffixServerError(undefined)).toBeNull()
  })
})

describe('Callsign Suffix field wiring in the Create New User tab', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  function inputFor(id) {
    const index = source.indexOf(`id="${id}"`)
    expect(index).toBeGreaterThan(-1)
    const start = source.lastIndexOf('<input', index)
    return source.slice(start, source.indexOf('/>', index))
  }

  it.each(['new-user-first-name', 'new-user-last-name', 'new-user-callsign-suffix'])(
    'runs the preview on blur of %s, not on every keystroke',
    (id) => {
      const input = inputFor(id)
      expect(input).toContain('onBlur={() => runCallsignSuffixPreview(newUserForm)}')
      expect(input.slice(input.indexOf('onChange='), input.indexOf('onBlur='))).not.toContain('runCallsignSuffixPreview')
    }
  )

  it('associates the Callsign Suffix input with its label and applies the shared character-class pattern', () => {
    const input = inputFor('new-user-callsign-suffix')
    expect(source).toContain('htmlFor="new-user-callsign-suffix"')
    expect(input).toContain('pattern={CALLSIGN_SUFFIX_PATTERN}')
    expect(input).toContain('required={newUserCallsignRequired}')
  })

  it('announces the inline Callsign Suffix error', () => {
    const index = source.indexOf('{newUserCallsignError && (')
    expect(index).toBeGreaterThan(-1)
    const block = source.slice(index, source.indexOf('</p>', index))
    expect(block).toContain('role="alert"')
    expect(block).toContain('{newUserCallsignError}')
  })

  it('sends the suffix through to usersAPI.createAndAdd', () => {
    const index = source.indexOf('usersAPI.createAndAdd(')
    expect(index).toBeGreaterThan(-1)
    const call = source.slice(index, source.indexOf(')', source.indexOf('newUserForm.callsignSuffix', index)))
    expect(call).toContain('newUserForm.callsignSuffix || undefined')
  })

  it('validates the suffix character class before submitting, inline rather than as a toast', () => {
    expect(source).toContain('if (!isValidMemberCallsignSuffix(newUserForm.callsignSuffix)) {')
    const index = source.indexOf('if (!isValidMemberCallsignSuffix(newUserForm.callsignSuffix)) {')
    const block = source.slice(index, source.indexOf('}', index))
    expect(block).toContain('setNewUserCallsignError(')
    expect(block).not.toContain('toast.')
  })
})
