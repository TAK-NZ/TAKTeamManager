import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { formatCallsignLevels, formatCallsignNameFormatExample, computeTeamDepth, getInitialMemberEditForm, isValidMemberCallsignSuffix, isValidSubTeamCallsignPrefix, extractCallsignSuffixServerError, isValidNewUserEmail, isPseudonymousOrganisation, resolveInitialTab } from './TeamDetail.jsx';

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

// Bugfix (Orgs & Teams overview -> tab deep link): Teams.jsx's Members/Team
// Devices/Team Admins/Sub-teams counts each link here as `?tab=<id>`; this
// page should open directly on that tab rather than always defaulting to
// Members.
describe('resolveInitialTab (bugfix: Orgs & Teams overview count links to a tab)', () => {
  it.each(['members', 'devices', 'admins', 'channels', 'subteams'])(
    'accepts %s as a valid tab id',
    (tabId) => {
      expect(resolveInitialTab(tabId)).toBe(tabId)
    }
  )

  it('defaults to members when the param is missing (null)', () => {
    expect(resolveInitialTab(null)).toBe('members')
  })

  it('defaults to members for an unrecognised value', () => {
    expect(resolveInitialTab('not-a-real-tab')).toBe('members')
  })

  it('defaults to members for an empty string', () => {
    expect(resolveInitialTab('')).toBe('members')
  })
})

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
// (`subTeamFormData.callsignPrefix`) gains the same stricter pattern
// validation as Teams.jsx's `callsignPrefix` input (task 32.6), per
// design.md's "Sub-team creation dialog: `callsignPrefix` gains the same
// stricter pattern validation as Teams.jsx." `isValidSubTeamCallsignPrefix`
// mirrors server/utils/callsignValidation.js's `isValidCallsignPrefix`
// character class. Foreign-partner-prefix extension: this now allows one
// or more `-`-separated alphanumeric segments, rather than a single
// hyphen-free run.

describe('isValidSubTeamCallsignPrefix (Req 3.10)', () => {
  it('accepts an empty value', () => {
    expect(isValidSubTeamCallsignPrefix('')).toBe(true)
    expect(isValidSubTeamCallsignPrefix(undefined)).toBe(true)
  })

  it('accepts letters and digits only', () => {
    expect(isValidSubTeamCallsignPrefix('STL')).toBe(true)
    expect(isValidSubTeamCallsignPrefix('STL123')).toBe(true)
  })

  // Foreign-partner-prefix extension: a single internal hyphen (one or
  // more `-`-separated alphanumeric segments) is now accepted by this
  // CLIENT-SIDE check, mirroring server/utils/callsignValidation.js's
  // widened CALLSIGN_PREFIX_PATTERN. The Managed_Identifier
  // marker+body-shape rejection is server-side only and is not
  // duplicated here.
  it('accepts a value containing a single internal hyphen (a two-segment prefix)', () => {
    expect(isValidSubTeamCallsignPrefix('NZ-POL')).toBe(true)
  })

  it('rejects a value with a leading, trailing, or doubled hyphen', () => {
    expect(isValidSubTeamCallsignPrefix('-NZ')).toBe(false)
    expect(isValidSubTeamCallsignPrefix('NZ-')).toBe(false)
    expect(isValidSubTeamCallsignPrefix('NZ--POL')).toBe(false)
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

  // Bugfix (mobile card fallback for Members/Team Admins): the transfer
  // action, along with Edit/Resend welcome/View devices/Delete, is now
  // defined ONCE inside the shared `MemberActions` component rather than
  // inline in each tab's `<td>` -- the same drift-avoidance extraction
  // `TeamDeviceList.jsx`'s own `DeviceActions` already does. `onTransfer`
  // is passed through as a prop (`setTransferringMember`) rather than the
  // button calling `setTransferringMember(member)`/`setTransferringMember(admin)`
  // directly, so these checks now target `MemberActions`'s own definition
  // (the single source of truth) plus each of its 2 call sites (Members
  // card, Members table).
  //
  // Bugfix (Team Admins tab action-set mismatch): the Team Admins tab's
  // 2 call sites no longer render `MemberActions` at all -- Transfer,
  // along with Edit/Resend welcome/View devices/Delete, is a MEMBER
  // action and this tab is scoped to managing admin STATUS only. See the
  // `AdminActions.jsx` describe block below.
  //
  // Users-page-action-parity: `MemberActions` itself moved out of
  // `TeamDetail.jsx` into the shared `components/MemberActions.jsx` (also
  // used by `Users.jsx`), so the button-definition assertion reads THAT
  // file; the call-site assertions below stay against `TeamDetail.jsx`'s
  // own source, since the 2 usages are still there.
  const memberActionsSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'MemberActions.jsx'),
    'utf8'
  )

  it('defines the transfer action exactly once, inside MemberActions, as the ArrowRightCircleIcon button calling onTransfer(member)', () => {
    const occurrences = memberActionsSource.split('onClick={() => hasTeam && onTransfer(member)}').length - 1
    expect(occurrences).toBe(1)

    const index = memberActionsSource.indexOf('onClick={() => hasTeam && onTransfer(member)}')
    const button = memberActionsSource.slice(
      memberActionsSource.lastIndexOf('<button', index),
      memberActionsSource.indexOf('</button>', index)
    )
    expect(button).toContain('ArrowRightCircleIcon')
    expect(button).toContain("aria-label={hasTeam ? 'Transfer member to another team' : noTeamTitle}")
  })

  it('passes onTransfer={setTransferringMember} from both MemberActions call sites (Members card+table only -- Team Admins no longer has a transfer action)', () => {
    const occurrences = source.split('onTransfer={setTransferringMember}').length - 1
    expect(occurrences).toBe(2)
  })

  it('renders MemberActions exactly 2 times (Members card, Members table), each gated on canManageTeam alone', () => {
    const usages = [...source.matchAll(/\{canManageTeam && \(\s*<MemberActions/g)]
    expect(usages.length).toBe(2)
  })

  it('passes roleLabel="member" from the Members tab\'s 2 call sites (AdminActions, used by Team Admins, has no roleLabel prop)', () => {
    expect(source.split('roleLabel="member"').length - 1).toBe(2)
    expect(source.split('roleLabel="admin"').length - 1).toBe(0)
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
// The decision that check drives now lives in the pure state machine of
// `client/src/utils/callsignSuffixPreview.js` (`newUserFormReducer`,
// `applyPreviewResponse`, and the `shouldSendCallsignSuffix`/selector
// helpers), unit- and property-tested in
// `client/src/utils/callsignSuffixPreview.test.js` -- the cases that used to
// live in a `decideCallsignSuffixPreview` describe block here are re-expressed
// against `applyPreviewResponse` there, and are deliberately not duplicated in
// this file. `extractCallsignSuffixServerError` remains TeamDetail.jsx's own
// submit-time 400 mapping and is still exercised here.
//
// The source-contract tests below pin the wiring the pure module cannot see:
// that the preview runs on blur via a `previewRequested` dispatch rather than
// per keystroke, that the Recompute_Control is a `type="button"` gated on
// `isRecomputeDisabled`, that neither the Suffix_Field nor the submit button
// is disabled while a preview is in flight, that the busy indicator is gated
// on `selectSuffixBusy`, that the inline error is a `role="alert"`, that the
// suffix reaches `usersAPI.createAndAdd` through the shared body builder, and
// that both dialog-open handlers reset the reducer.

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

// Validates: Requirements 2.1, 2.2, 3.7, 7.1, 7.2
//
// The Callsign_Suffix field is now driven by the `newUserFormReducer` state
// machine and its selectors (`isRecomputeDisabled`, `selectSuffixBusy`,
// `buildCreateAndAddSuffixArgument`). These source-contract assertions pin the
// DOM-to-reducer wiring the pure module's own tests cannot see, reading
// TeamDetail.jsx's source and asserting on the strings it must contain. Each
// assertion below preserves the intent of the one it replaces: the blur wiring
// exists (now a `previewRequested` dispatch), the change handler does not
// preview, the error is a `role="alert"`, the suffix reaches the API call (now
// via `buildCreateAndAddSuffixArgument`), and the character-class check sets an
// inline reducer error rather than a toast. New assertions cover the two traps
// and the new surface: the Recompute_Control is a `type="button"` gated on
// `isRecomputeDisabled`; neither the Suffix_Field nor the submit button is
// disabled while a preview is in flight; the busy indicator is gated on
// `selectSuffixBusy`; both dialog-open handlers dispatch `{type:'reset'}`.
describe('Callsign Suffix field wiring in the Create New User tab', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  function inputFor(id) {
    const index = source.indexOf(`id="${id}"`)
    expect(index).toBeGreaterThan(-1)
    const start = source.lastIndexOf('<input', index)
    return source.slice(start, source.indexOf('/>', index))
  }

  // The name inputs blur-issue a preview via a `names`-trigger dispatch; the
  // Suffix_Field blur-issues a `suffix`-trigger dispatch. The change handler
  // must NOT dispatch a preview (Req 1.5 -- on blur, not per keystroke).
  it.each([
    { id: 'new-user-first-name', trigger: 'names' },
    { id: 'new-user-last-name', trigger: 'names' },
    { id: 'new-user-callsign-suffix', trigger: 'suffix' }
  ])(
    'runs the preview on blur of $id via a $trigger-trigger dispatch, not on every keystroke',
    ({ id, trigger }) => {
      const input = inputFor(id)
      expect(input).toContain(`onBlur={() => dispatchNewUserForm({ type: 'previewRequested', trigger: '${trigger}', teamId: team?.id })}`)
      // The onChange handler must not issue a preview -- it only dispatches a
      // field/suffix edit.
      const changeToBlur = input.slice(input.indexOf('onChange='), input.indexOf('onBlur='))
      expect(changeToBlur).not.toContain('previewRequested')
    }
  )

  // takserver-enrollment Requirement 9.7 (task 5.5): the field is ALSO
  // required, unconditionally, when the target Organisation is
  // pseudonymous (`pseudonymousTarget`) -- Callsign_Default_Suppression
  // means the server never computes a name-derived default there, so
  // this is required regardless of what the reducer's own
  // `callsign_name_format`-driven `required` reports.
  it('associates the Callsign Suffix input with its label, applies the shared character-class pattern, and marks required from the reducer or the pseudonymous target', () => {
    const input = inputFor('new-user-callsign-suffix')
    expect(source).toContain('htmlFor="new-user-callsign-suffix"')
    expect(input).toContain('pattern={CALLSIGN_SUFFIX_PATTERN}')
    expect(input).toContain('required={newUserFormState.required || pseudonymousTarget}')
  })

  it('announces the inline Callsign Suffix error as a role="alert" from the reducer field', () => {
    const index = source.indexOf('{newUserFormState.error && (')
    expect(index).toBeGreaterThan(-1)
    const block = source.slice(index, source.indexOf('</p>', index))
    expect(block).toContain('role="alert"')
    expect(block).toContain('{newUserFormState.error}')
  })

  it('sends the suffix through to usersAPI.createAndAdd via the shared body builder', () => {
    const index = source.indexOf('usersAPI.createAndAdd(')
    expect(index).toBeGreaterThan(-1)
    // The suffix argument fed to createAndAdd is the shared body builder, so
    // the preview body and the submit body cannot drift. Assert it appears
    // within the call's argument list.
    const argIndex = source.indexOf('buildCreateAndAddSuffixArgument(newUserFormState)', index)
    expect(argIndex).toBeGreaterThan(-1)
    const call = source.slice(index, argIndex + 'buildCreateAndAddSuffixArgument(newUserFormState)'.length)
    expect(call).toContain('buildCreateAndAddSuffixArgument(newUserFormState)')
  })

  it('validates the suffix character class before submitting, inline via a submitRejected dispatch rather than a toast', () => {
    expect(source).toContain('if (!isValidMemberCallsignSuffix(newUserFormState.suffix)) {')
    const index = source.indexOf('if (!isValidMemberCallsignSuffix(newUserFormState.suffix)) {')
    const block = source.slice(index, source.indexOf('return', index))
    expect(block).toContain("dispatchNewUserForm({ type: 'submitRejected'")
    expect(block).not.toContain('toast.')
  })

  // The Recompute_Control (Req 2.1, 2.2) -- forces a `recompute`-trigger
  // preview, must be `type="button"` so it does not submit the form, carries an
  // accessible name naming what it does, and is disabled exactly on
  // `isRecomputeDisabled`.
  it('renders the Recompute_Control as a type="button" with an accessible name, gated on isRecomputeDisabled', () => {
    const index = source.indexOf("dispatchNewUserForm({ type: 'previewRequested', trigger: 'recompute', teamId: team?.id })")
    expect(index).toBeGreaterThan(-1)
    const start = source.lastIndexOf('<button', index)
    const button = source.slice(start, source.indexOf('</button>', index))
    expect(button).toContain('type="button"')
    expect(button).toContain('aria-label="Recompute callsign suffix from the entered names"')
    expect(button).toContain('disabled={isRecomputeDisabled(newUserFormState)}')
  })

  // Req 7.2: an in-flight preview must not disable the Suffix_Field or the
  // submit control -- `selectSuffixBusy` gates only the busy indicator (Req 7.1).
  it('does not gate the Suffix_Field on selectSuffixBusy while a preview is in flight', () => {
    const input = inputFor('new-user-callsign-suffix')
    expect(input).not.toContain('selectSuffixBusy')
  })

  it('does not gate the submit button on selectSuffixBusy while a preview is in flight', () => {
    const index = source.indexOf("{addingMember ? 'Creating...' : 'Create & Add User'}")
    expect(index).toBeGreaterThan(-1)
    const start = source.lastIndexOf('<button', index)
    const button = source.slice(start, index)
    expect(button).toContain('type="submit"')
    const disabledStart = button.indexOf('disabled={')
    expect(disabledStart).toBeGreaterThan(-1)
    const disabledExpr = button.slice(disabledStart, button.indexOf('}', disabledStart))
    expect(disabledExpr).not.toContain('selectSuffixBusy')
  })

  it('gates the busy indicator on selectSuffixBusy(newUserFormState)', () => {
    const index = source.indexOf('selectSuffixBusy(newUserFormState) && (')
    expect(index).toBeGreaterThan(-1)
    const block = source.slice(index, source.indexOf('</span>', index))
    expect(block).toContain('role="status"')
    expect(block).toContain('aria-live="polite"')
  })

  // Req 3.7: opening the dialog from either the "Add Member" or the "Add Admin"
  // action resets the reducer, so a cancelled half-filled form cannot reappear
  // with a stale suffix.
  it('dispatches {type:reset} from both the Add Member and Add Admin open handlers', () => {
    expect(source).toContain("dispatchNewUserForm({ type: 'reset' }); setNewUserEmailError(null); setAddMemberRole('member'); setAddMemberTab('new'); setShowAddMemberDialog(true)")
    expect(source).toContain("dispatchNewUserForm({ type: 'reset' }); setNewUserEmailError(null); setAddMemberRole('admin'); setAddMemberTab('existing'); setShowAddMemberDialog(true)")
  })
})

// Defect 2: the Create New User form's Email Address input gains an inline
// validation alert backed by the pure `isValidNewUserEmail` helper, kept
// separate from the reducer's Callsign-Suffix-only `error` field.
describe('isValidNewUserEmail (Defect 2)', () => {
  it('accepts a well-formed address', () => {
    expect(isValidNewUserEmail('a@b.co')).toBe(true)
  })

  it('rejects an empty value (the field is required)', () => {
    expect(isValidNewUserEmail('')).toBe(false)
    expect(isValidNewUserEmail('   ')).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isValidNewUserEmail(undefined)).toBe(false)
    expect(isValidNewUserEmail(null)).toBe(false)
  })

  it('rejects malformed addresses', () => {
    expect(isValidNewUserEmail('foo')).toBe(false)
    expect(isValidNewUserEmail('foo@bar')).toBe(false)
    expect(isValidNewUserEmail('foo@ bar.com')).toBe(false)
    expect(isValidNewUserEmail('@b.co')).toBe(false)
  })
})

// Defect 2 (source contract): the email input clears any stale alert on
// edit, validates on blur, exposes aria-invalid, and renders a role="alert"
// message; and handleCreateNewUser rejects an invalid email before the
// suffix check.
describe('Email inline validation wiring in the Create New User tab (Defect 2)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('validates the email inline before the suffix check in handleCreateNewUser', () => {
    // Scoped to handleCreateNewUser's own body: the "Add Existing User"
    // tab's onboarding-review submit path (handleAddExistingUser, defined
    // earlier in the file) now ALSO calls isValidMemberCallsignSuffix, so
    // an unscoped source.indexOf would find that earlier, unrelated call
    // site instead of handleCreateNewUser's -- scoping to the function
    // body keeps this assertion pinned to the one function it actually
    // describes. Bounded at the end by the next top-level function
    // declaration (`// The single request-issuing effect...` precedes it
    // today), matched loosely via the next `React.useEffect(` after the
    // function's own preview-issuing effect reference, to stay robust to
    // reordering elsewhere in the file.
    const fnStart = source.indexOf('const handleCreateNewUser = async (e) => {')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = source.indexOf('\n  // Fetch available users when dialog opens', fnStart)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const fnBody = source.slice(fnStart, fnEnd)

    const emailIdx = fnBody.indexOf('if (!isValidNewUserEmail(newUserFormState.email)) {')
    const suffixIdx = fnBody.indexOf('if (!isValidMemberCallsignSuffix(newUserFormState.suffix)) {')
    expect(emailIdx).toBeGreaterThan(-1)
    expect(suffixIdx).toBeGreaterThan(-1)
    expect(emailIdx).toBeLessThan(suffixIdx)
    const block = fnBody.slice(emailIdx, fnBody.indexOf('return', emailIdx))
    expect(block).toContain("setNewUserEmailError('Please enter a valid email address.')")
  })

  it('clears the email error on edit and validates on blur, with aria-invalid and an alert', () => {
    const emailInputIdx = source.indexOf("field: 'email'")
    expect(emailInputIdx).toBeGreaterThan(-1)
    const start = source.lastIndexOf('<input', emailInputIdx)
    const region = source.slice(start, source.indexOf('/>', emailInputIdx) + 200)
    expect(region).toContain('setNewUserEmailError(null)')
    expect(region).toContain('onBlur={() => { if (newUserFormState.email && !isValidNewUserEmail(newUserFormState.email))')
    expect(region).toContain("aria-invalid={newUserEmailError ? 'true' : undefined}")
    expect(region).toContain('{newUserEmailError && (')
    expect(region).toContain('role="alert"')
  })
})

// Defect 4 (source contract): the Add Member dialog opens on Create New User
// by default and renders that tab button first.
describe('Add Member dialog tab order and default (Defect 4)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it("defaults the addMemberTab state to 'new'", () => {
    expect(source).toContain("const [addMemberTab, setAddMemberTab] = useState('new')")
  })

  it('renders the Create New User tab button before the Add Existing User tab button', () => {
    const navIdx = source.indexOf('<nav className="-mb-px flex">')
    expect(navIdx).toBeGreaterThan(-1)
    const nav = source.slice(navIdx, source.indexOf('</nav>', navIdx))
    const createIdx = nav.indexOf('Create New User')
    const existingIdx = nav.indexOf('Add Existing User')
    expect(createIdx).toBeGreaterThan(-1)
    expect(existingIdx).toBeGreaterThan(-1)
    expect(createIdx).toBeLessThan(existingIdx)
  })

  it("resets the tab to 'new' on dialog close", () => {
    expect(source).toContain("setAddMemberTab('new')")
  })
})

// Defect 1 (source contract): the Members list includes admins (an admin is
// also a member), while the Team Admins list stays admin-only.
describe('Members list includes admins (Defect 1)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('includes admin rows in every setMembers filter', () => {
    const matches = source.match(/setMembers\(allMembers\.filter\([^)]*\)\)/g) || []
    expect(matches.length).toBe(6)
    for (const m of matches) {
      expect(m).toContain("m.role === 'admin'")
      expect(m).toContain("m.role === 'member'")
      expect(m).toContain("m.role === 'inherited'")
    }
  })

  it('keeps the Team Admins list admin-only', () => {
    const matches = source.match(/setAdmins\(allMembers\.filter\([^)]*\)\)/g) || []
    expect(matches.length).toBe(6)
    for (const m of matches) {
      expect(m).toBe("setAdmins(allMembers.filter(m => m.role === 'admin'))")
    }
  })
})

// Bugfix (Team Admins tab action-set mismatch): "Remove as admin" is the
// ONE action on the Team Admins tab -- it demotes a direct admin row
// back to 'member' via the same upsert `teamsAPI.addMember` already
// uses to promote (see `handleAddExistingUser`), leaving the account,
// team membership and channel access untouched. Kept entirely separate
// from `handleRemoveUser`'s "Permanently Delete User" flow
// (removeUserId/removeUserRole), which is unrelated and far more
// severe. Source-contract tests only, per this file's established
// convention (no @testing-library/react in this project).
describe('Remove as Admin flow (bugfix: Team Admins tab action-set mismatch)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('imports AdminActions from the shared component, distinct from MemberActions', () => {
    expect(source).toContain("import AdminActions from '../components/AdminActions'")
  })

  it('opens the confirmation with the clicked admin row via handleRemoveAdminClick, kept separate from handleRemoveUser', () => {
    expect(source).toContain('const handleRemoveAdminClick = (admin) => {')
    const index = source.indexOf('const handleRemoveAdminClick = (admin) => {')
    const block = source.slice(index, source.indexOf('}', index) + 1)
    expect(block).toContain('setRemovingAdmin(admin)')
  })

  it('both AdminActions call sites (Team Admins card+table) pass onRemoveAdmin={handleRemoveAdminClick}', () => {
    const occurrences = source.split('onRemoveAdmin={handleRemoveAdminClick}').length - 1
    expect(occurrences).toBe(2)
  })

  it('demotes via teamsAPI.addMember(team.id, { userId, role: "member" }) -- the same upsert used to promote, not a new/different endpoint', () => {
    expect(source).toContain('const confirmRemoveAdmin = async () => {')
    const index = source.indexOf('const confirmRemoveAdmin = async () => {')
    const block = source.slice(index, source.indexOf('\n  }', index))
    expect(block).toContain("await teamsAPI.addMember(team.id, { userId: removingAdmin.id, role: 'member' })")
  })

  it('refreshes members/admins from teamsAPI.getById after demoting, matching the refresh pattern used by every other mutation on this page', () => {
    const index = source.indexOf('const confirmRemoveAdmin = async () => {')
    const block = source.slice(index, source.indexOf('\n  }', index))
    expect(block).toContain('const teamResponse = await teamsAPI.getById(team.id)')
    expect(block).toContain("setMembers(allMembers.filter(m => m.role === 'member' || m.role === 'inherited' || m.role === 'admin'))")
    expect(block).toContain("setAdmins(allMembers.filter(m => m.role === 'admin'))")
  })

  it('never calls usersAPI.removeFromTeam (the destructive account-deletion path) from confirmRemoveAdmin', () => {
    const index = source.indexOf('const confirmRemoveAdmin = async () => {')
    const block = source.slice(index, source.indexOf('\n  }', index))
    expect(block).not.toContain('usersAPI.removeFromTeam')
  })

  it('renders a plain Cancel/Confirm "Remove as Admin" dialog (no type-to-confirm input), gated on removingAdmin', () => {
    expect(source).toContain('{removingAdmin && (')
    const index = source.indexOf('{removingAdmin && (')
    const dialogEnd = source.indexOf('\n      )}', index)
    const block = source.slice(index, dialogEnd)
    expect(block).toContain('Remove as Admin')
    expect(block).toContain('onClick={() => setRemovingAdmin(null)}')
    expect(block).toContain('onClick={confirmRemoveAdmin}')
    expect(block).toContain('disabled={removingAdminInFlight}')
    // No type-to-confirm text input, unlike the "Permanently Delete User" dialog.
    expect(block).not.toContain('removeConfirmInput')
  })
})

// Bugfix (silent welcome-email failures): `POST /create-and-add`'s
// welcome-email send was previously wrapped in a try/catch that only
// logged on failure -- the account was created either way, but the
// admin (who may have fat-fingered the address) had no way to know the
// invite never went out. The route now rides `welcomeEmailSent` on the
// same 201 response, and this Create New User submit handler reads it
// to show a single combined toast.error (not toast.success) rather than
// layering a second toast on top of the normal success one.
// Source-contract tests only, per this file's established convention.
describe('Create New User: welcomeEmailSent toast (bugfix: silent welcome-email failures)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('branches on response?.data?.welcomeEmailSent === false, naming the target email in the error toast, rather than always calling toast.success', () => {
    expect(source).toContain("if (response?.data?.welcomeEmailSent === false) {")
    const index = source.indexOf('if (response?.data?.welcomeEmailSent === false) {')
    const block = source.slice(index, source.indexOf('\n      }', index) + '\n      }'.length)
    expect(block).toContain('toast.error(`User created, but the welcome email to ${newUserFormState.email} could not be sent. You may need to resend it manually.`)')
    // A single combined toast: this branch must not ALSO call
    // toast.success for the same outcome.
    expect(block).not.toContain('toast.success')
  })

  it('keeps the existing toast.success (with the assigned callsign suffix) in the else branch, unchanged from before this bugfix', () => {
    const index = source.indexOf('if (response?.data?.welcomeEmailSent === false) {')
    const elseIndex = source.indexOf('} else {', index)
    const block = source.slice(elseIndex, source.indexOf('\n      }', elseIndex))
    expect(block).toContain('toast.success(')
    expect(block).toContain('User created with callsign suffix ${assignedSuffix}')
    expect(block).toContain("'User created and added to this team'")
  })
})

// Bugfix (Resend welcome email was the only action with no
// confirmation): every other action on the Members/Team Admins tabs
// (Delete Sub-Team, Remove as Admin, Permanently Delete User) already
// confirms before acting; Resend welcome email fired the request
// immediately on click. It now opens a plain Cancel/Confirm dialog
// first, matching "Delete Sub-Team"'s non-destructive framing
// (btn-primary Confirm, not btn-danger) since resending an email is not
// destructive. Source-contract tests only, per this file's established
// convention.
describe('Resend Welcome Email confirmation (bugfix: only action with no confirmation)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('opens the confirmation with the clicked row via handleResendWelcomeClick, kept separate from handleRemoveAdminClick/handleRemoveUser', () => {
    expect(source).toContain('const handleResendWelcomeClick = (member) => {')
    const index = source.indexOf('const handleResendWelcomeClick = (member) => {')
    const block = source.slice(index, source.indexOf('}', index) + 1)
    expect(block).toContain('setResendingWelcomeTo(member)')
  })

  it('both MemberActions call sites (Members card+table) pass onResendWelcome={handleResendWelcomeClick}, not the API-calling function directly', () => {
    const occurrences = source.split('onResendWelcome={handleResendWelcomeClick}').length - 1
    expect(occurrences).toBe(2)
    expect(source).not.toContain('onResendWelcome={handleResendWelcome}')
  })

  it('sends the email via usersAPI.resendWelcome(resendingWelcomeTo.id, team.id) only from confirmResendWelcome', () => {
    expect(source).toContain('const confirmResendWelcome = async () => {')
    const index = source.indexOf('const confirmResendWelcome = async () => {')
    const block = source.slice(index, source.indexOf('\n  }', index))
    expect(block).toContain('await usersAPI.resendWelcome(resendingWelcomeTo.id, team.id)')
  })

  it('renders a plain Cancel/Confirm "Resend Welcome Email" dialog (no type-to-confirm input), using btn-primary rather than btn-danger since this is not destructive', () => {
    expect(source).toContain('{resendingWelcomeTo && (')
    const index = source.indexOf('{resendingWelcomeTo && (')
    const dialogEnd = source.indexOf('\n      )}', index)
    const block = source.slice(index, dialogEnd)
    expect(block).toContain('Resend Welcome Email')
    expect(block).toContain('onClick={() => setResendingWelcomeTo(null)}')
    expect(block).toContain('onClick={confirmResendWelcome}')
    expect(block).toContain('disabled={resendingWelcomeInFlight}')
    expect(block).toContain('btn-primary')
    expect(block).not.toContain('btn-danger')
    expect(block).not.toContain('removeConfirmInput')
  })
})

// takserver-enrollment Requirement 6.7/9.7 (task 5.5): whether the
// CURRENT team's own Organisation (via its Ancestor_Chain root, walked
// through the already-fetched `allTeams` list -- never a positional
// read from the tail) has the Pseudonymous_Username_Policy enabled.
describe('isPseudonymousOrganisation (takserver-enrollment Req 6.7/9.7)', () => {
  it('returns the Organisation row\'s own value directly', () => {
    const org = { id: 1, parent_team_id: null, pseudonymous_usernames: true }
    expect(isPseudonymousOrganisation(org, [org])).toBe(true)
    const orgOff = { id: 2, parent_team_id: null, pseudonymous_usernames: false }
    expect(isPseudonymousOrganisation(orgOff, [orgOff])).toBe(false)
  })

  it('normalises a null/undefined Organisation value to false', () => {
    const org = { id: 1, parent_team_id: null, pseudonymous_usernames: null }
    expect(isPseudonymousOrganisation(org, [org])).toBe(false)
  })

  it('walks up to the Organisation root for a Sub_Team, never reading the Sub_Team\'s own (always-null) value', () => {
    const org = { id: 1, parent_team_id: null, pseudonymous_usernames: true }
    const subTeam = { id: 2, parent_team_id: 1, pseudonymous_usernames: null }
    expect(isPseudonymousOrganisation(subTeam, [org, subTeam])).toBe(true)
  })

  it('walks multiple levels to reach the root, deliberately disagreeing at each level to prove it does not read the tail or a middle row', () => {
    const org = { id: 1, parent_team_id: null, pseudonymous_usernames: true }
    const mid = { id: 2, parent_team_id: 1, pseudonymous_usernames: null }
    const leaf = { id: 3, parent_team_id: 2, pseudonymous_usernames: null }
    expect(isPseudonymousOrganisation(leaf, [org, mid, leaf])).toBe(true)
  })

  it('returns false when a team is null/undefined', () => {
    expect(isPseudonymousOrganisation(null, [])).toBe(false)
    expect(isPseudonymousOrganisation(undefined, [])).toBe(false)
  })

  it('terminates without looping forever when an ancestor is missing from allTeams (e.g. a hidden private ancestor)', () => {
    const subTeam = { id: 10, parent_team_id: 999, pseudonymous_usernames: null }
    expect(isPseudonymousOrganisation(subTeam, [subTeam])).toBe(false)
  })
})

// takserver-enrollment Requirement 9.7 (task 5.9): additional edge-case
// coverage on the create-user form's Pseudonymous_Organisation behaviour,
// beyond what task 5.5's own "associates the Callsign Suffix input..."
// test above already covers (which pins the `required={...}` attribute
// wiring). These pin: the explanation is rendered as VISIBLE TEXT (not
// merely a validation error discovered on submit), and the form does NOT
// render any username input at all when the target is pseudonymous --
// read from source, matching this file's existing no-@testing-library
// convention of testing pure helpers / source contracts.
describe('Create-user form under a Pseudonymous_Organisation target (takserver-enrollment Req 9.7, task 5.9)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('renders the pseudonymous-required explanation as visible <p> text tied to the field via aria-describedby, not only as a validation error', () => {
    // Scoped to the "Create New User" tab's own <form> block: the "Add
    // Existing User" tab's onboarding-review section now renders the
    // IDENTICAL help text (by design -- it reuses the same
    // newUserFormState reducer/preview machinery) against its own
    // "existing-user-callsign-suffix-help" id, so an unscoped
    // source.indexOf would match that earlier block instead of this
    // tab's. Matches the same scoping convention the sibling
    // "renders no username <input>..." test below already uses.
    const formStart = source.indexOf("{addMemberTab === 'new' && (")
    expect(formStart).toBeGreaterThan(-1)
    const formEnd = source.indexOf('</form>', formStart)
    expect(formEnd).toBeGreaterThan(formStart)
    const createUserFormBlock = source.slice(formStart, formEnd)

    // The help text is rendered unconditionally whenever pseudonymousTarget
    // is true and there is no error yet -- i.e. before any submit attempt,
    // as visible text rather than something surfaced only on rejection.
    const helpIndex = createUserFormBlock.indexOf('Required because this Organisation uses pseudonymous usernames')
    expect(helpIndex).toBeGreaterThan(-1)
    const helpBlockStart = createUserFormBlock.lastIndexOf('<p ', helpIndex)
    const helpBlock = createUserFormBlock.slice(helpBlockStart, createUserFormBlock.indexOf('</p>', helpIndex))
    expect(helpBlock).toContain('id="new-user-callsign-suffix-help"')

    // The Suffix_Field points aria-describedby at this same id whenever
    // pseudonymousTarget is true (and there's no error), so the text is
    // actually wired to the field rather than being orphaned prose.
    const suffixInputIndex = createUserFormBlock.indexOf('id="new-user-callsign-suffix"')
    const suffixInputBlock = createUserFormBlock.slice(suffixInputIndex, createUserFormBlock.indexOf('/>', suffixInputIndex))
    expect(suffixInputBlock).toContain("aria-describedby={newUserFormState.error ? 'new-user-callsign-suffix-error' : ((newUserFormState.required || pseudonymousTarget) ? 'new-user-callsign-suffix-help' : undefined)}")
  })

  it('renders the "generated automatically" statement as visible <p> text, gated on pseudonymousTarget, unconditionally (not behind any error/submit state)', () => {
    const statementIndex = source.indexOf("This Organisation uses pseudonymous usernames: the new member's TAK username will be generated automatically")
    expect(statementIndex).toBeGreaterThan(-1)
    // Gated directly on `{pseudonymousTarget && (` with no additional
    // condition (e.g. no `&& !newUserFormState.error` clause) between the
    // gate and the paragraph -- i.e. always visible for a pseudonymous
    // target, never conditional on a validation error having occurred.
    const gateMarker = '{pseudonymousTarget && ('
    const gateIndex = source.lastIndexOf(gateMarker, statementIndex)
    expect(gateIndex).toBeGreaterThan(-1)
    const gateToStatement = source.slice(gateIndex + gateMarker.length, statementIndex)
    expect(gateToStatement).not.toContain('newUserFormState.error')
    expect(gateToStatement).not.toContain('&&')
  })

  it('renders no username <input> anywhere in the Create New User tab\'s form, for either policy state', () => {
    // Scope to the "Create New User" tab's own <form ...> block, not the
    // whole file (the "Add Existing User" tab's search input carries a
    // "username" placeholder string but is not a username INPUT field for
    // the user being created).
    const formStart = source.indexOf("{addMemberTab === 'new' && (")
    expect(formStart).toBeGreaterThan(-1)
    const formEnd = source.indexOf("{addMemberTab === 'existing'", 0) > -1 && source.indexOf("{addMemberTab === 'existing'") < formStart
      ? source.indexOf('</form>', formStart)
      : source.indexOf('</form>', formStart)
    expect(formEnd).toBeGreaterThan(formStart)
    const createUserFormBlock = source.slice(formStart, formEnd)

    // No <input> in this block has an id/name suggesting it collects a
    // username value from the admin.
    expect(createUserFormBlock).not.toMatch(/id="new-user-username"/)
    expect(createUserFormBlock).not.toMatch(/name="username"/)
    expect(createUserFormBlock).not.toContain('newUserFormState.username')

    // The only place "username" appears in this block is inside the
    // explanatory prose stating the username is generated -- never as an
    // <input>'s id/value/onChange binding.
    const usernameMentions = [...createUserFormBlock.matchAll(/username/gi)]
    expect(usernameMentions.length).toBeGreaterThan(0)
    for (const mention of usernameMentions) {
      const context = createUserFormBlock.slice(Math.max(0, mention.index - 80), mention.index + 80)
      expect(context).not.toMatch(/<input[^>]*$/)
    }
  })

  it('states plainly that no admin-supplied username is ever discarded, because none is ever offered on this form', () => {
    const commentIndex = source.indexOf('this tab has no Username input to begin with')
    expect(commentIndex).toBeGreaterThan(-1)
    const nearby = source.slice(commentIndex, commentIndex + 900)
    expect(nearby).toContain('no admin-supplied value is')
    expect(nearby).toContain('ever silently discarded server-side')
  })
})

// takserver-enrollment Criterion 14.6 (task 11.5, since superseded by a
// later UX decision -- Team Devices is now its own TAB, between Members
// and Team Admins, rather than a separate card beneath the tabbed
// interface): the Devices section is purely additive regardless of WHERE
// it renders. It must not reintroduce a Team_Owned_Device into the human
// Member_List or the human member count -- both pre-date this feature and
// are computed entirely from `setMembers`/`setAdmins`, never from
// `TeamDeviceList` or its `GET /api/devices/team/:teamId` fetch.
// Source-contract checks, per this file's existing no-@testing-library
// convention: `TeamDeviceList` is rendered ONLY inside its own
// `activeTab === 'devices'` gate (never inside the Members tab's table,
// and never unconditionally alongside it), and every
// `setMembers`/`setAdmins` filter predicate is built exclusively from the
// three human `role` values, with no reference to a device concept
// anywhere in either filter.
describe('The Devices section does not affect the human member list or count (takserver-enrollment Criterion 14.6)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('renders <TeamDeviceList> only inside its own activeTab === \'devices\' gate, never inside the Members tab\'s table', () => {
    const tdlIndex = source.indexOf('<TeamDeviceList')
    expect(tdlIndex).toBeGreaterThan(-1)

    // The nearest preceding `activeTab === '...'` gate must be the
    // devices tab's own, not 'members' (or any other tab) -- i.e.
    // <TeamDeviceList> is not nested inside the Members tab's rendering
    // block.
    const precedingGates = [...source.slice(0, tdlIndex).matchAll(/activeTab === '(\w+)'/g)]
    expect(precedingGates.length).toBeGreaterThan(0)
    const nearestGate = precedingGates[precedingGates.length - 1][1]
    expect(nearestGate).toBe('devices')
    expect(nearestGate).not.toBe('members')

    // The 'devices' tab definition itself must exist in the tabs array,
    // between 'members' and 'admins' (Requirement: Team Devices sits
    // between Members and Team Admins).
    const membersTabIndex = source.indexOf("{ id: 'members', label: 'Members'")
    const devicesTabIndex = source.indexOf("id: 'devices', label: 'Team Devices'")
    const adminsTabIndex = source.indexOf("{ id: 'admins', label: 'Team Admins'")
    expect(membersTabIndex).toBeGreaterThan(-1)
    expect(devicesTabIndex).toBeGreaterThan(membersTabIndex)
    expect(adminsTabIndex).toBeGreaterThan(devicesTabIndex)
  })

  it('never reads a device-related field in the setMembers/setAdmins filters that compute the human Member_List and its count', () => {
    const memberFilters = source.match(/setMembers\(allMembers\.filter\([^)]*\)\)/g) || []
    const adminFilters = source.match(/setAdmins\(allMembers\.filter\([^)]*\)\)/g) || []
    expect(memberFilters.length).toBeGreaterThan(0)
    expect(adminFilters.length).toBeGreaterThan(0)

    for (const filter of [...memberFilters, ...adminFilters]) {
      expect(filter.toLowerCase()).not.toContain('device')
      expect(filter).not.toContain('is_team_device')
    }
  })

  it('computes the Members tab\'s displayed count (`members.length`) from the same setMembers state, with no device-count addition', () => {
    const tabDefIndex = source.indexOf("{ id: 'members', label: 'Members', icon: UsersIcon, count: members.length }")
    expect(tabDefIndex).toBeGreaterThan(-1)
    // `members.length` alone -- not `members.length + devices.length` or
    // any other device-derived addend.
    expect(source.slice(tabDefIndex, tabDefIndex + 100)).not.toContain('device')
  })
})

// Header toolbar restructuring: only Add Member and Add Team Device stay
// directly visible; Edit/Add Admin/Add Sub-team/Create Channel move
// behind a MoreOptionsMenu, each still carrying its own icon so the items
// stay visually distinguishable from one another. Source-contract checks,
// per this file's existing no-@testing-library convention.
describe('header toolbar restructuring (Add Member + Add Team Device visible, rest behind More Options)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('imports and renders MoreOptionsMenu', () => {
    expect(source).toContain("import MoreOptionsMenu from '../components/MoreOptionsMenu'")
    expect(source).toContain('<MoreOptionsMenu')
  })

  it('imports and renders AddTeamDeviceDialog, gated on showAddDeviceDialog', () => {
    expect(source).toContain("import AddTeamDeviceDialog from '../components/AddTeamDeviceDialog'")
    expect(source).toContain('{showAddDeviceDialog && (')
    expect(source).toContain('<AddTeamDeviceDialog')
  })

  it('renders exactly one visible "Add Member" button and one visible "Add Team Device" button in the header, both btn-primary and icon-only', () => {
    const headerStart = source.indexOf('{canManageTeam && (')
    const menuIndex = source.indexOf('<MoreOptionsMenu')
    expect(headerStart).toBeGreaterThan(-1)
    expect(menuIndex).toBeGreaterThan(headerStart)
    const headerBlock = source.slice(headerStart, menuIndex)

    // Bugfix (mobile toolbar): both buttons are icon-only now -- their
    // name is carried by aria-label/title, not by visible button text --
    // so this checks for the aria-label rather than visible text.
    expect(headerBlock).toContain('aria-label="Add Member"')
    expect(headerBlock).toContain('aria-label="Add Team Device"')
    // Both visible actions use btn-primary now (promoted from
    // btn-secondary), distinguishing them from the menu-hidden actions.
    // Skip past the leading JSX comment (which itself mentions both
    // labels in prose) before locating each button's own markup.
    const commentEndIndex = headerBlock.lastIndexOf('*/}')
    const afterComment = headerBlock.slice(commentEndIndex)

    const addMemberIndex = afterComment.indexOf('aria-label="Add Member"')
    const addMemberButtonStart = afterComment.lastIndexOf('<button', addMemberIndex)
    expect(addMemberButtonStart).toBeGreaterThan(-1)
    expect(afterComment.slice(addMemberButtonStart, addMemberIndex)).toContain('btn-primary')

    const addDeviceIndex = afterComment.indexOf('aria-label="Add Team Device"')
    const addDeviceButtonStart = afterComment.lastIndexOf('<button', addDeviceIndex)
    expect(addDeviceButtonStart).toBeGreaterThan(-1)
    expect(afterComment.slice(addDeviceButtonStart, addDeviceIndex)).toContain('btn-primary')
  })

  // Bugfix: all three header actions (Add Member, Add Team Device, More
  // options) are icon-only ONLY below `sm:`, so they fit on one row on
  // a narrow phone instead of wrapping -- at `sm:` and up the visible
  // label text returns (a prior version of this fix wrongly went
  // icon-only on EVERY viewport, including desktop; that regression is
  // what this test now guards against).
  it('shows Add Member/Add Team Device label text at sm: and up (hidden sm:inline), and only icon-only below sm:; MoreOptionsMenu gets the matching "below-sm" mode', () => {
    const headerStart = source.indexOf('{canManageTeam && (')
    const menuIndex = source.indexOf('<MoreOptionsMenu')
    const headerBlock = source.slice(headerStart, menuIndex + 60)

    expect(headerBlock).toContain('<MoreOptionsMenu')
    expect(headerBlock).toContain('iconOnly="below-sm"')
    // The label text is present, but only VISIBLE at sm:+ (hidden sm:inline)
    // -- never unconditionally hidden, and never unconditionally shown
    // without the responsive class (which would defeat the mobile fix).
    expect(headerBlock).toContain('<span className="hidden sm:inline">Add Member</span>')
    expect(headerBlock).toContain('<span className="hidden sm:inline">Add Team Device</span>')
  })

  it('moves Edit/Add Admin/Add Sub-team/Create Channel into the MoreOptionsMenu items array, each with an icon', () => {
    const menuIndex = source.indexOf('<MoreOptionsMenu')
    expect(menuIndex).toBeGreaterThan(-1)
    const menuBlock = source.slice(menuIndex, menuIndex + 2000)

    for (const [key, label, icon] of [
      ['edit', 'Edit ${teamLabel}', 'PencilIcon'],
      ['add-admin', 'Add Admin', 'ShieldCheckIcon'],
      ['add-sub-team', 'Add Sub-team', 'FolderPlusIcon'],
      ['create-channel', 'Create Channel', 'SignalIcon']
    ]) {
      expect(menuBlock).toContain(`key: '${key}'`)
      expect(menuBlock).toContain(icon)
    }
  })

  it('the Add Team Device button is gated on devicesEnabled, matching the Team Devices tab\'s own gating', () => {
    const headerStart = source.indexOf('{canManageTeam && (')
    const menuIndex = source.indexOf('<MoreOptionsMenu')
    const headerBlock = source.slice(headerStart, menuIndex)
    const commentEndIndex = headerBlock.lastIndexOf('*/}')
    const afterComment = headerBlock.slice(commentEndIndex)
    const buttonIndex = afterComment.indexOf('aria-label="Add Team Device"')
    expect(buttonIndex).toBeGreaterThan(-1)
    const precedingBlock = afterComment.slice(Math.max(0, buttonIndex - 400), buttonIndex)
    expect(precedingBlock).toContain('devicesEnabled')
  })

  // Bugfix: on a phone, this toolbar is left-aligned (only becoming
  // right-aligned AT `lg:`, via `lg:items-end` on its containing
  // column), so MoreOptionsMenu's own default panel anchor (right-0,
  // opening leftward) pushed the "More options" panel off the LEFT edge
  // of the screen -- unrecoverable clipping, per this codebase's own
  // tooltip convention, unlike right-edge clipping which is at least
  // reachable by scrolling. `panelClassName` overrides the anchor to
  // open rightward below `lg:` (onto the screen, matching where the
  // trigger itself sits there) and leftward only at/above `lg:`.
  it('passes panelClassName to MoreOptionsMenu, opening the panel rightward below lg: and leftward only at/above lg:, matching the toolbar\'s own lg:items-end breakpoint', () => {
    const menuIndex = source.indexOf('<MoreOptionsMenu')
    expect(menuIndex).toBeGreaterThan(-1)
    const menuBlock = source.slice(menuIndex, menuIndex + 1200)
    expect(menuBlock).toContain('panelClassName="left-0 lg:left-auto lg:right-0"')

    // The toolbar's own right-alignment breakpoint is lg: (this is the
    // fact panelClassName must match, not an independently chosen value).
    const toolbarColumnIndex = source.lastIndexOf('flex flex-col gap-2 lg:items-end', menuIndex)
    expect(toolbarColumnIndex).toBeGreaterThan(-1)
    expect(toolbarColumnIndex).toBeLessThan(menuIndex)
  })
})

// Team Devices tab: sits between Members and Team Admins, renders
// TeamDeviceList only inside its own gate, and a device creation flow
// (AddTeamDeviceDialog) exists distinctly from the tab's own "Enroll"
// action on an existing device.
describe('Team Devices tab (between Members and Team Admins)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  // Bugfix: this tab's count now MATCHES every other tab's -- it used
  // to hardcode `count: null` (icon alone, no badge), the one
  // inconsistency among the 5 tabs. It now reads `deviceCount` state,
  // kept in sync via TeamDeviceList's own `onCountChange` callback.
  it('defines the devices tab with DevicePhoneMobileIcon and a count sourced from deviceCount state, not a hardcoded null', () => {
    const devicesTabIndex = source.indexOf("id: 'devices', label: 'Team Devices'")
    expect(devicesTabIndex).toBeGreaterThan(-1)
    const tabDef = source.slice(devicesTabIndex, devicesTabIndex + 120)
    expect(tabDef).toContain('DevicePhoneMobileIcon')
    expect(tabDef).toContain('count: deviceCount')
    expect(tabDef).not.toContain('count: null')
  })

  it('declares deviceCount state, defaulting to null (icon alone, no badge, until the first fetch resolves)', () => {
    expect(source).toContain('const [deviceCount, setDeviceCount] = useState(null)')
  })

  it('passes onCountChange={setDeviceCount} to TeamDeviceList, keeping the tab badge in sync with the list\'s own fetched count', () => {
    const tdlIndex = source.indexOf('<TeamDeviceList')
    expect(tdlIndex).toBeGreaterThan(-1)
    const tdlLine = source.slice(tdlIndex, source.indexOf('/>', tdlIndex))
    expect(tdlLine).toContain('onCountChange={setDeviceCount}')
  })

  it('renders no numeric suffix for a tab whose count is null (label alone, not "label (null)")', () => {
    const renderIndex = source.indexOf('tab.count === null ? tab.label')
    expect(renderIndex).toBeGreaterThan(-1)
  })

  it('bumps deviceListVersion in AddTeamDeviceDialog\'s onCreated, and passes it as TeamDeviceList\'s key so the tab remounts/refetches after a device is created', () => {
    expect(source).toContain('const [deviceListVersion, setDeviceListVersion] = useState(0)')
    expect(source).toContain('onCreated={() => setDeviceListVersion((version) => version + 1)}')
    expect(source).toContain('<TeamDeviceList key={deviceListVersion}')
  })

  it('guards processedData/currentData against the devices tab id, which is not one of the four filterAndSort-backed arrays', () => {
    expect(source).toContain('const currentData = processedData[activeTab] || []')
  })

  it('suppresses the generic empty-state and pagination blocks while the devices tab is active, since TeamDeviceList renders its own', () => {
    expect(source).toContain("activeTab !== 'devices' && paginatedData.length === 0")
    expect(source).toContain("activeTab !== 'devices' && totalPages > 1")
  })
})

// Bugfix: the tab bar (Members/Team Devices/Team Admins/Channels/
// Sub-teams) had NEITHER `flex-wrap` NOR a horizontal-scroll fallback,
// unlike every other row on this page -- at 5 tabs of icon+text it
// silently overflowed a narrow phone's card with no way to reach the
// hidden tabs. A first pass fixed this by going icon-only on EVERY
// viewport, which was itself a regression: it dropped the text label on
// desktop too, and (icon-only being narrower than expected) left a
// stray `overflow-x-auto` scrollbar with nothing left to scroll. The
// corrected fix is icon+count-only BELOW `sm:` (fits a narrow phone
// without needing overflow-x-auto at all) and the ORIGINAL full
// "Label (count)" text restored at `sm:` and up.
describe('Tab bar: icon+count below sm:, full "Label (count)" text at sm: and up (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('does not wrap the tab bar in overflow-x-auto -- the icon-only width below sm: fits without it', () => {
    const navIndex = source.indexOf('<nav className="-mb-px flex')
    expect(navIndex).toBeGreaterThan(-1)
    const wrapperOpenIndex = source.lastIndexOf('<div', navIndex)
    const wrapperLine = source.slice(wrapperOpenIndex, source.indexOf('>', wrapperOpenIndex))
    expect(wrapperLine).not.toContain('overflow-x-auto')
  })

  it('renders the full "Label (count)" text in a `hidden sm:inline` span, visible only at sm: and up', () => {
    const navIndex = source.indexOf('<nav className="-mb-px flex')
    const navEndIndex = source.indexOf('</nav>')
    expect(navIndex).toBeGreaterThan(-1)
    expect(navEndIndex).toBeGreaterThan(navIndex)
    const navBlock = source.slice(navIndex, navEndIndex)
    expect(navBlock).toContain('<span className="hidden sm:inline">')
    expect(navBlock).toContain('{tab.count === null ? tab.label : `${tab.label} (${tab.count})`}')
  })

  it('renders the standalone numeric count badge only below sm: (sm:hidden), since the full text already carries the count at sm:+', () => {
    const navIndex = source.indexOf('<nav className="-mb-px flex')
    const navEndIndex = source.indexOf('</nav>')
    const navBlock = source.slice(navIndex, navEndIndex)
    expect(navBlock).toContain('{tab.count !== null && (')
    expect(navBlock).toContain('<span className="ml-1.5 sm:hidden">{tab.count}</span>')
  })

  it('carries the full accessible name (label + count) via aria-label and title on the tab button at every width', () => {
    const navIndex = source.indexOf('<nav className="-mb-px flex')
    const navEndIndex = source.indexOf('</nav>')
    const navBlock = source.slice(navIndex, navEndIndex)
    expect(navBlock).toContain('const accessibleName = tab.count === null ? tab.label')
    expect(navBlock).toContain('aria-label={accessibleName}')
    expect(navBlock).toContain('title={accessibleName}')
  })
})

// Bugfix: the Team Devices tab's count badge never appeared at all,
// because the only thing that knows the count (`TeamDeviceList`'s own
// `onCountChange`) does not MOUNT until the devices tab is actually
// selected (`activeTab` defaults to 'members'), while every other tab's
// count is read off state already fetched on page load regardless of
// which tab is showing. A dedicated effect now fetches the device count
// independently on page load (and again when `deviceListVersion` bumps,
// i.e. after AddTeamDeviceDialog creates one), so the badge is present
// from first render onward, not only after the tab has been opened once.
describe('Team Devices tab count: fetched independently of TeamDeviceList mounting (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('fetches the device count in its own effect, gated on devicesEnabled and teamId, and re-run on deviceListVersion', () => {
    const effectIndex = source.indexOf('devicesAPI.getTeamDevices(teamId)')
    expect(effectIndex).toBeGreaterThan(-1)
    const effectBlockStart = source.lastIndexOf('useEffect(() => {', effectIndex)
    const effectBlockEnd = source.indexOf('}, [devicesEnabled, teamId, deviceListVersion])', effectIndex)
    expect(effectBlockStart).toBeGreaterThan(-1)
    expect(effectBlockEnd).toBeGreaterThan(effectBlockStart)
    const effectBlock = source.slice(effectBlockStart, effectBlockEnd)
    expect(effectBlock).toContain('if (!devicesEnabled || !teamId)')
    expect(effectBlock).toContain('setDeviceCount(response.data?.devices?.length ?? 0)')
  })

  it('this independent effect is a DIFFERENT fetch from TeamDeviceList\'s own onCountChange wiring, not a replacement for it', () => {
    // Both must coexist: the effect covers "count on first load, before
    // the tab is ever opened"; onCountChange covers "count stays live
    // while the tab IS open and an edit/delete/transfer happens inside
    // TeamDeviceList itself, which the effect has no visibility into.
    expect(source).toContain('onCountChange={setDeviceCount}')
    expect(source.split('setDeviceCount').length - 1).toBeGreaterThanOrEqual(2)
  })
})

// "Join Limited" summary badge, Organisation-only, reading the
// team.allowed_domains field the server attaches to GET /api/teams/:teamId.
// Renamed from "Join limited by Email Domain: Yes/No" to a "Join Limited"
// field stating "None"/"By Email Domain" literally, and consolidated into
// the single-row summary alongside Visibility/Callsign Structure/Join
// Requests, separated from "Parent Organisation" by a divider (bug #14).
describe('"Join Limited" header badge (Organisation-only)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('is gated on both !team.parent_team_id and Array.isArray(team.allowed_domains)', () => {
    const badgeIndex = source.indexOf('<span>Join Limited: </span>')
    expect(badgeIndex).toBeGreaterThan(-1)
    const precedingBlock = source.slice(Math.max(0, badgeIndex - 400), badgeIndex)
    expect(precedingBlock).toContain('!team.parent_team_id')
    expect(precedingBlock).toContain('Array.isArray(team.allowed_domains)')
  })

  it('states "None"/"By Email Domain" as text, never colour alone, and discloses the domain list only on hover/focus (never a native title attribute)', () => {
    const badgeIndex = source.indexOf('<span>Join Limited: </span>')
    const badgeBlock = source.slice(badgeIndex, badgeIndex + 1200)
    expect(badgeBlock).toMatch(/>\s*By Email Domain\s*</)
    expect(badgeBlock).toMatch(/>\s*None\s*</)
    expect(badgeBlock).toContain('group-hover:opacity-100')
    expect(badgeBlock).toContain('group-focus-within:opacity-100')
    // No native title attribute anywhere in this badge's own markup --
    // client convention forbids `title` as the disclosure mechanism.
    expect(badgeBlock).not.toMatch(/title="/)
  })

  it('no longer renders OrgDomainManager as its own standalone card on this page', () => {
    expect(source).not.toContain("import OrgDomainManager from '../components/OrgDomainManager'")
    expect(source).not.toContain('<OrgDomainManager')
  })
})

// Team header summary row: a divider after "Parent Organisation", and a
// single consolidated colour for every badge in the row (bug #14).
describe('Team header summary row (divider + consolidated colour)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('renders a divider between the Parent Organisation line and the summary row', () => {
    const parentIndex = source.indexOf('Parent {parentTeam')
    const hrIndex = source.indexOf('<hr ', parentIndex)
    const summaryRowIndex = source.indexOf('Visibility: ', parentIndex)
    expect(parentIndex).toBeGreaterThan(-1)
    expect(hrIndex).toBeGreaterThan(parentIndex)
    expect(summaryRowIndex).toBeGreaterThan(hrIndex)
  })

  it('shares one badge class (TEAM_SUMMARY_BADGE_CLASS) across Visibility/Callsign Structure/Join Requests/Join Limited', () => {
    expect(source).toContain('const TEAM_SUMMARY_BADGE_CLASS =')
    // Every summary badge in the row must reference the shared class
    // rather than an inline, per-field colour class.
    const rowStart = source.indexOf('<span>Visibility: </span>')
    const rowEnd = source.indexOf('Join Limited', rowStart) + 1200
    const rowBlock = source.slice(rowStart, rowEnd)
    expect(rowBlock).toContain('TEAM_SUMMARY_BADGE_CLASS')
    // No leftover per-badge colour utility classes from the old palette.
    expect(rowBlock).not.toContain('bg-green-100')
    expect(rowBlock).not.toContain('bg-purple-100')
    expect(rowBlock).not.toContain('bg-indigo-100')
  })

  it('renames the "Callsign:" label to "Callsign Structure:" and combines Levels + name format into one badge', () => {
    expect(source).toContain('Callsign Structure: ')
    expect(source).not.toContain('<span>Callsign: </span>')
  })

  it('places the divider and summary row as a sibling of the 2-column grid, not inside its left column, so they span the full card width', () => {
    const gridIndex = source.indexOf("<div className=\"grid grid-cols-1 lg:grid-cols-2 gap-6\">")
    const gridCloseIndex = source.indexOf('</div>\n\n        {/* Divider')
    const hrIndex = source.indexOf('<hr ', gridIndex)
    expect(gridIndex).toBeGreaterThan(-1)
    expect(gridCloseIndex).toBeGreaterThan(gridIndex)
    expect(hrIndex).toBeGreaterThan(gridCloseIndex)
  })

  it('colours Visibility green for Public and red for Private, alongside its own text', () => {
    expect(source).toContain("const TEAM_SUMMARY_BADGE_POSITIVE_CLASS =")
    expect(source).toContain("const TEAM_SUMMARY_BADGE_NEGATIVE_CLASS =")
    const visibilityIndex = source.indexOf("<span>Visibility: </span>")
    const visibilityBlock = source.slice(visibilityIndex, visibilityIndex + 250)
    expect(visibilityBlock).toContain("team.visibility === 'public' ? TEAM_SUMMARY_BADGE_POSITIVE_CLASS : TEAM_SUMMARY_BADGE_NEGATIVE_CLASS")
  })

  it('colours Join Requests green for Allowed and neutral gray for Disabled', () => {
    const joinRequestsIndex = source.indexOf("<span>Join Requests: </span>")
    const joinRequestsBlock = source.slice(joinRequestsIndex, joinRequestsIndex + 250)
    expect(joinRequestsBlock).toContain("team.can_join ? TEAM_SUMMARY_BADGE_POSITIVE_CLASS : TEAM_SUMMARY_BADGE_CLASS")
  })

  it('colours "By Email Domain" green and "None" neutral gray for Join Limited', () => {
    const joinLimitedIndex = source.indexOf("<span>Join Limited: </span>")
    const joinLimitedBlock = source.slice(joinLimitedIndex, joinLimitedIndex + 800)
    expect(joinLimitedBlock).toContain('TEAM_SUMMARY_BADGE_POSITIVE_CLASS')
    expect(joinLimitedBlock).toContain('TEAM_SUMMARY_BADGE_CLASS')
  })

  it('only shows Join Limited while Join Requests is Allowed (team.can_join)', () => {
    const gateIndex = source.indexOf('!team.parent_team_id && team.can_join && Array.isArray(team.allowed_domains)')
    expect(gateIndex).toBeGreaterThan(-1)
  })
})

// Channels tab icon: SignalIcon (matching Dashboard.jsx's own channel
// stat-tile icon), no longer HashtagIcon.
describe('Channels tab icon (SignalIcon, matching Dashboard.jsx)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('uses SignalIcon for the Channels tab definition', () => {
    const channelsTabIndex = source.indexOf("id: 'channels', label: 'Channels'")
    expect(channelsTabIndex).toBeGreaterThan(-1)
    expect(source.slice(channelsTabIndex, channelsTabIndex + 80)).toContain('SignalIcon')
  })

  it('imports SignalIcon from heroicons', () => {
    expect(source).toContain('SignalIcon')
    const importLineIndex = source.indexOf("from '@heroicons/react/24/outline'")
    const importLine = source.slice(Math.max(0, importLineIndex - 600), importLineIndex)
    expect(importLine).toContain('SignalIcon')
  })
})

// TeamFormDialog is passed isAdmin={canManageTeam} so its nested
// OrgDomainManager (Allowed Email Domains) gates identically to every
// other admin-only affordance on this page.
describe('TeamFormDialog isAdmin wiring (Allowed Email Domains, now nested in the Edit dialog)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('passes isAdmin={canManageTeam} to the Edit Team TeamFormDialog', () => {
    const dialogIndex = source.indexOf('<TeamFormDialog')
    expect(dialogIndex).toBeGreaterThan(-1)
    const dialogBlock = source.slice(dialogIndex, dialogIndex + 400)
    expect(dialogBlock).toContain('isAdmin={canManageTeam}')
  })
})

// Bugfix (mobile UI/UX pass): the team header title row (`h1` + colour
// swatch + joinable icon) had no wrap/break behaviour at all, and the
// title text can be a concatenated "{parentPrefix} - {teamName}" string
// with no length cap.
describe('TeamDetail.jsx: header title row wraps/breaks on a narrow viewport (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('adds flex-wrap to the title row and break-words to the h1', () => {
    const h1Index = source.indexOf('text-2xl font-bold text-gray-900 dark:text-gray-100 break-words')
    expect(h1Index).toBeGreaterThan(-1)
    const rowOpenIndex = source.lastIndexOf('<div className="flex items-center', h1Index)
    const rowLine = source.slice(rowOpenIndex, source.indexOf('>', rowOpenIndex))
    expect(rowLine).toContain('flex-wrap')
  })

  it('marks the colour swatch and joinable icon flex-shrink-0 so they never get squeezed by a wrapping long title', () => {
    const swatchIndex = source.indexOf('backgroundColor: getTakColorHex(team.color)')
    expect(swatchIndex).toBeGreaterThan(-1)
    const swatchDivStart = source.lastIndexOf('<div', swatchIndex)
    expect(source.slice(swatchDivStart, source.indexOf('>', swatchDivStart))).toContain('flex-shrink-0')

    const joinableIndex = source.indexOf('title="Joinable team"')
    expect(joinableIndex).toBeGreaterThan(-1)
    const joinableStart = source.lastIndexOf('<ArrowLeftOnRectangleIcon', joinableIndex)
    expect(source.slice(joinableStart, joinableIndex)).toContain('flex-shrink-0')
  })
})

// Bugfix (mobile UI/UX pass): same pagination flex-wrap fix as Teams.jsx.
describe('TeamDetail.jsx: pagination row wraps on a narrow viewport (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('adds flex-wrap and a gap to the pagination summary+controls row', () => {
    const index = source.indexOf('Showing {startIndex + 1} to')
    expect(index).toBeGreaterThan(-1)
    const rowOpenIndex = source.lastIndexOf('<div className="mt-6', index)
    const rowLine = source.slice(rowOpenIndex, source.indexOf('>', rowOpenIndex))
    expect(rowLine).toContain('flex-wrap')
    expect(rowLine).toContain('justify-between')
    expect(rowLine).toContain('gap-2')
  })
})

// Bugfix (mobile UI/UX pass): Members, Team Admins, Channels and
// Sub-teams tabs each now render a `sm:hidden` stacked card list PLUS
// the existing `hidden sm:block overflow-x-auto` table, matching the
// pairing TeamDeviceList.jsx/Teams.jsx already established, so a phone
// gets cards instead of a horizontally-scrolling table.
describe('TeamDetail.jsx: Members/Team Admins/Channels/Sub-teams tabs render sm:hidden cards + hidden sm:block table (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('renders a sm:hidden card block ahead of a hidden sm:block table block for each of the 4 tabs', () => {
    const tabGates = [
      "activeTab === 'members' && (",
      "activeTab === 'admins' && (",
      "activeTab === 'channels' && (",
      "activeTab === 'subteams' && ("
    ]
    for (const gate of tabGates) {
      const gateIndex = source.indexOf(gate)
      expect(gateIndex).toBeGreaterThan(-1)
      const nextGateIndex = tabGates
        .map((g) => source.indexOf(g, gateIndex + gate.length))
        .filter((i) => i > -1)
        .sort((a, b) => a - b)[0] ?? source.length
      const tabBlock = source.slice(gateIndex, nextGateIndex)
      const cardIndex = tabBlock.indexOf('sm:hidden divide-y')
      const tableIndex = tabBlock.indexOf('hidden sm:block overflow-x-auto')
      expect(cardIndex).toBeGreaterThan(-1)
      expect(tableIndex).toBeGreaterThan(cardIndex)
    }
  })

  it('shares MemberActions between the Members card and table (2 usages); the Team Admins tab uses AdminActions instead (2 usages)', () => {
    const memberActionsUsages = source.split('<MemberActions').length - 1
    expect(memberActionsUsages).toBe(2)
    const adminActionsUsages = source.split('<AdminActions').length - 1
    expect(adminActionsUsages).toBe(2)
  })

  // Bugfix (mobile tap targets too small): the CARD usage (Members
  // card) passes variant="card" for a real ~36px tap target; the TABLE
  // usage defaults to variant="table" (unchanged) since a desktop table
  // row has no tap-target problem. Same convention applies to
  // AdminActions' card vs. table usage on the Team Admins tab.
  it('passes variant="card" from exactly the mobile-card MemberActions usage, and no card variant from the table usage', () => {
    // Locate each <MemberActions usage and confirm exactly 1 of the 2
    // carries variant="card" -- the sm:hidden card one, not the table
    // one. Scoped to each usage's own JSX block (not a whole-file
    // string count) so a doc comment elsewhere mentioning
    // `variant="card"` in prose can't skew the count.
    const usageIndices = [...source.matchAll(/<MemberActions/g)].map((m) => m.index)
    expect(usageIndices.length).toBe(2)
    const withCardVariant = usageIndices.filter((index) => {
      const usageBlock = source.slice(index, source.indexOf('/>', index))
      return usageBlock.includes('variant="card"')
    })
    expect(withCardVariant.length).toBe(1)
  })

  it('passes variant="card" from exactly the mobile-card AdminActions usage, and no card variant from the table usage', () => {
    const usageIndices = [...source.matchAll(/<AdminActions/g)].map((m) => m.index)
    expect(usageIndices.length).toBe(2)
    const withCardVariant = usageIndices.filter((index) => {
      const usageBlock = source.slice(index, source.indexOf('/>', index))
      return usageBlock.includes('variant="card"')
    })
    expect(withCardVariant.length).toBe(1)
  })

  // Bugfix: the Sub-teams tab's inline view/delete actions were never
  // extracted into a shared component (only 2 icons), so the same
  // button-box treatment is applied literally rather than via a prop.
  it('applies the same p-2/rounded-lg/h-5 w-5 button-box treatment inline to the Sub-teams card\'s View/Delete actions', () => {
    const subteamsCardIndex = source.indexOf("activeTab === 'subteams'")
    const subteamsTableIndex = source.indexOf('hidden sm:block overflow-x-auto', subteamsCardIndex)
    expect(subteamsCardIndex).toBeGreaterThan(-1)
    expect(subteamsTableIndex).toBeGreaterThan(subteamsCardIndex)
    const cardBlock = source.slice(subteamsCardIndex, subteamsTableIndex)

    expect(cardBlock).toContain('title="View team details"')
    expect(cardBlock).toContain('p-2 rounded-lg bg-gray-100')
    expect(cardBlock).toContain('h-5 w-5')
    expect(cardBlock).toContain('title="Delete sub-team"')
    expect(cardBlock).toContain('bg-red-50')
  })

  it('renders the Sub-teams card with inline "Label: value" stats (Members:/Sub-teams:), matching Teams.jsx\'s own card convention', () => {
    const subteamsGateIndex = source.indexOf("activeTab === 'subteams' && (")
    const cardIndex = source.indexOf('sm:hidden divide-y', subteamsGateIndex)
    const tableIndex = source.indexOf('hidden sm:block overflow-x-auto', subteamsGateIndex)
    const cardBlock = source.slice(cardIndex, tableIndex)
    expect(cardBlock).toContain('Members:')
    expect(cardBlock).toContain('Sub-teams:')
    expect(cardBlock).toContain('flex items-baseline gap-1')
  })

  // Bugfix (Sub-teams tab consistency with the /teams overview): Team
  // Devices/Team Admins/Channels join Members/Sub-teams, and every one
  // of the five stats -- in BOTH the card and the desktop table -- links
  // to that sub-team's own corresponding tab, exactly like Teams.jsx's
  // own overview stats do.
  describe('Sub-teams tab: Team Devices/Team Admins/Channels columns, all five stats clickable (bugfix)', () => {
    const subteamsGateIndex = source.indexOf("activeTab === 'subteams' && (")
    const cardIndex = source.indexOf('sm:hidden divide-y', subteamsGateIndex)
    const tableIndex = source.indexOf('hidden sm:block overflow-x-auto', subteamsGateIndex)
    const nextTabGateIndex = source.indexOf("activeTab !== 'devices' && paginatedData.length === 0", tableIndex)
    const cardBlock = source.slice(cardIndex, tableIndex)
    const tableBlock = source.slice(tableIndex, nextTabGateIndex > -1 ? nextTabGateIndex : source.length)

    it('adds Team Devices, Team Admins and Channels column headers, positioned between Members and Sub-teams', () => {
      const membersIndex = tableBlock.indexOf("handleSort('member_count')")
      const devicesIndex = tableBlock.indexOf("handleSort('device_count')")
      const adminsIndex = tableBlock.indexOf("handleSort('admin_count')")
      const channelsIndex = tableBlock.indexOf("handleSort('channel_count')")
      const subTeamsIndex = tableBlock.indexOf("handleSort('sub_teams_count')")
      expect(membersIndex).toBeGreaterThan(-1)
      expect(devicesIndex).toBeGreaterThan(membersIndex)
      expect(adminsIndex).toBeGreaterThan(devicesIndex)
      expect(channelsIndex).toBeGreaterThan(adminsIndex)
      expect(subTeamsIndex).toBeGreaterThan(channelsIndex)
      expect(tableBlock).toContain('<span>Team Devices</span>')
      expect(tableBlock).toContain('<span>Team Admins</span>')
      expect(tableBlock).toContain('<span>Channels</span>')
    })

    it.each([
      ['Members', 'members', '{subTeam.member_count || 0}'],
      ['Team Devices', 'devices', '{subTeam.device_count || 0}'],
      ['Team Admins', 'admins', '{subTeam.admin_count || 0}'],
      ['Channels', 'channels', '{subTeam.channel_count || 0}'],
      ['Sub-teams', 'subteams', '{subTeam.sub_teams_count || 0}']
    ])('%s stat is a Link to ?tab=%s, in both the card and the table', (_label, tabId, countExpr) => {
      const linkPrefix = `<Link to={\`/teams/${'$'}{subTeam.id}?tab=${tabId}\`}`

      for (const [blockName, block] of [['card', cardBlock], ['table', tableBlock]]) {
        expect(block, `${blockName} block should contain a ?tab=${tabId} Link`).toContain(linkPrefix)
        const linkIndex = block.indexOf(linkPrefix)
        const countIndex = block.indexOf(countExpr, linkIndex)
        expect(countIndex, `${blockName} block: ${countExpr} should appear inside the ?tab=${tabId} Link`).toBeGreaterThan(linkIndex)
        const closingLinkIndex = block.indexOf('</Link>', linkIndex)
        expect(closingLinkIndex).toBeGreaterThan(-1)
        expect(countIndex).toBeLessThan(closingLinkIndex)
      }
    })
  })

  it('renders the Channels card with the channel_type badge and member count, and no action icons (read-only tab)', () => {
    const channelsGateIndex = source.indexOf("activeTab === 'channels' && (")
    const cardIndex = source.indexOf('sm:hidden divide-y', channelsGateIndex)
    const tableIndex = source.indexOf('hidden sm:block overflow-x-auto', channelsGateIndex)
    const cardBlock = source.slice(cardIndex, tableIndex)
    expect(cardBlock).toContain('{channel.channel_type === \'primary\' ? \'Primary\' : \'Custom\'}')
    expect(cardBlock).toContain('{channel.member_count || 0} members')
    expect(cardBlock).not.toContain('<button')
  })
})

// Bugfix (list-width reduction): Members and Team Admins tabs show
// Username instead of Email (matching Users.jsx's own username-shown
// convention, and making more sense for an Organisation using
// pseudonymous usernames), the username stacked underneath the name
// (matching Users.jsx), and a combined "TAK Callsign & Role" column
// where the TAK_Role renders small and without color underneath the
// callsign -- replacing the old wide five/six-column
// Name/Email/Role/TAK Role/Callsign/Actions layout.
describe('TeamDetail.jsx: Members/Team Admins tabs show Username (not Email) and "TAK Callsign & Role" (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')
  const tabGates = ["activeTab === 'members' && (", "activeTab === 'admins' && ("]

  function tabBlock(gate) {
    const gateIndex = source.indexOf(gate)
    expect(gateIndex).toBeGreaterThan(-1)
    const otherGateIndex = tabGates
      .filter((g) => g !== gate)
      .map((g) => source.indexOf(g, gateIndex + gate.length))
      .filter((i) => i > -1)
      .sort((a, b) => a - b)[0] ?? source.length
    return source.slice(gateIndex, otherGateIndex)
  }

  it.each(tabGates)('%s: the desktop table header reads "Username" and "TAK Callsign & Role", never "Email"/"TAK Role"/"Callsign" as separate headers', (gate) => {
    const block = tabBlock(gate)
    expect(block).toContain('<span>Username</span>')
    expect(block).toContain('TAK Callsign & Role')
    expect(block).not.toContain('<span>Email</span>')
    // The OLD separate "TAK Role" and "Callsign" <th> labels are gone --
    // only the combined header remains. (Role and TAK Callsign & Role
    // literally are what remain; TAK Role/Callsign alone must not.)
    expect(block).not.toMatch(/<th[^>]*>\s*TAK Role\s*<\/th>/)
    expect(block).not.toMatch(/<th[^>]*>\s*Callsign\s*<\/th>/)
  })

  it.each(tabGates)('%s: the table row renders member.username (not member.email) and the combined callsign+role stack', (gate) => {
    const block = tabBlock(gate)
    const rowVar = gate.includes('members') ? 'member' : 'admin'
    expect(block).toContain(`{${rowVar}.username}`)
    expect(block).not.toContain(`{${rowVar}.email}`)
    expect(block).toContain(`{${rowVar}.tak_callsign || '-'}`)
    expect(block).toContain(`{${rowVar}.tak_role || 'Team Member'}`)
  })

  it.each(tabGates)('%s: the mobile card shows the username under the name, and the callsign+role stack with the role small and uncolored', (gate) => {
    const block = tabBlock(gate)
    const cardIndex = block.indexOf('sm:hidden divide-y')
    const tableIndex = block.indexOf('hidden sm:block overflow-x-auto')
    expect(cardIndex).toBeGreaterThan(-1)
    expect(tableIndex).toBeGreaterThan(cardIndex)
    const cardBlock = block.slice(cardIndex, tableIndex)

    const rowVar = gate.includes('members') ? 'member' : 'admin'
    expect(cardBlock).toContain(`{${rowVar}.username}`)
    expect(cardBlock).not.toContain(`{${rowVar}.email}`)
    expect(cardBlock).toContain(`{${rowVar}.tak_callsign || '-'}`)
    // The role text sits in its own <p className="text-xs ...">, not a
    // colored pill (bg-teal-100 etc.) the way it used to.
    const roleLineIndex = cardBlock.indexOf(`{${rowVar}.tak_role || 'Team Member'}`)
    expect(roleLineIndex).toBeGreaterThan(-1)
    const roleLineStart = cardBlock.lastIndexOf('<p ', roleLineIndex)
    const roleLine = cardBlock.slice(roleLineStart, roleLineIndex)
    expect(roleLine).toContain('text-xs')
    expect(roleLine).not.toContain('bg-teal-100')
    expect(roleLine).not.toContain('rounded-full')
  })

  it('MemberEditRow colSpan is 5 in both tabs\' tables (one fewer column now that Email/TAK Role/Callsign collapsed to Username/TAK Callsign & Role)', () => {
    const matches = [...source.matchAll(/<MemberEditRow[\s\S]*?colSpan=\{(\d+)\}/g)]
    // 4 desktop-table MemberEditRow usages total across this file
    // (Members table, Team Admins table) -- the two mobile-card usages
    // pass colSpan={1} unrelated to this column count and are excluded
    // by requiring colSpan 5 or 6 specifically wouldn't be safe, so
    // instead assert every desktop usage (colSpan > 1) is exactly 5.
    const desktopColSpans = matches.map((m) => Number(m[1])).filter((n) => n > 1)
    expect(desktopColSpans.length).toBeGreaterThan(0)
    expect(desktopColSpans.every((n) => n === 5)).toBe(true)
  })
})

// Bugfix (mobile UI/UX pass): TeamFormDialog, Add Member, Create
// Sub-Team, Create Channel, and Enroll Device dialogs are all full-bleed
// (h-full w-full, no rounding, sm:p-4 on the overlay) below `sm:`,
// rather than a small floating card -- each has content that never fits
// a phone viewport regardless of container size, so a full-screen sheet
// uses the available space better. The smaller dialogs (Transfer
// Member, Revoke Device, Add Team Device, User Devices) get the SAME
// treatment for consistency, even though they'd likely fit unscrolled.
describe('TeamDetail.jsx: large dialogs are full-bleed on mobile (bugfix)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  const dialogs = [
    { name: 'Create Sub-Team', labelledby: 'create-sub-team-title' },
    { name: 'Add Member', labelledby: 'add-member-title' },
    { name: 'Create Channel', labelledby: 'create-channel-title' },
    { name: 'Enroll Device', labelledby: 'enroll-device-title' }
  ]

  it.each(dialogs)('$name dialog: box is w-full h-full below sm:, with sm:rounded-lg and sm:h-auto at sm: and up', ({ labelledby }) => {
    const labelledbyIndex = source.indexOf(`aria-labelledby="${labelledby}"`)
    expect(labelledbyIndex).toBeGreaterThan(-1)
    const classNameIndex = source.indexOf('className="bg-white', labelledbyIndex)
    const classNameEnd = source.indexOf('"', classNameIndex + 'className="'.length)
    const classes = source.slice(classNameIndex, classNameEnd)
    expect(classes).toContain('w-full h-full')
    expect(classes).toContain('sm:rounded-lg')
    expect(classes).toContain('sm:h-auto')
    expect(classes).not.toMatch(/(?<!sm:)rounded-lg/)
  })

  it.each(dialogs)('$name dialog: its overlay drops padding below sm: (sm:p-4, not an unconditional p-4)', ({ labelledby }) => {
    const labelledbyIndex = source.indexOf(`aria-labelledby="${labelledby}"`)
    const overlayIndex = source.lastIndexOf('<div className="fixed inset-0', labelledbyIndex)
    const overlayLine = source.slice(overlayIndex, source.indexOf('>', overlayIndex))
    expect(overlayLine).toContain('sm:p-4')
    expect(overlayLine).not.toMatch(/(?<!sm:)p-4/)
  })
})

// Feature (Add Existing User onboarding review): selecting a candidate in
// the member-role "Add Existing User" tab pre-fills, and lets an admin
// review/correct, that user's First Name/Last Name/Callsign Suffix before
// they're added -- this is the ONLY step that turns a user who exists in
// Authentik but has never been touched by TAK Team Manager into a
// TAK Team Manager-managed one, so a correction made here PERSISTS to the
// user's account (server: POST /api/users/add-to-team). Reuses the SAME
// newUserFormState reducer/preview machinery the Create New User tab
// already uses, so both tabs cannot drift on how a Callsign Suffix is
// computed, previewed, or collision-checked.
describe('Add Existing User tab: name/callsign-suffix onboarding review (member role only)', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamDetail.jsx'), 'utf8')

  it('selectExistingUserCandidate resets the form, seeds firstName/lastName from the candidate, and only runs for the member-role picker', () => {
    const fnStart = source.indexOf('const selectExistingUserCandidate = (user) => {')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = source.indexOf('\n  }', fnStart)
    const fnBody = source.slice(fnStart, fnEnd)

    expect(fnBody).toContain("if (addMemberRole !== 'member') return")
    expect(fnBody).toContain("dispatchNewUserForm({ type: 'reset' })")
    expect(fnBody).toContain("dispatchNewUserForm({ type: 'fieldChanged', field: 'firstName', value: user.first_name || '' })")
    expect(fnBody).toContain("dispatchNewUserForm({ type: 'fieldChanged', field: 'lastName', value: user.last_name || '' })")
    // A stored suffix is loaded via suffixEdited (TYPED origin, no extra
    // preview round trip needed); a candidate with none gets a 'names'
    // preview request instead, matching what blurring the name fields on
    // the Create New User tab would trigger.
    expect(fnBody).toContain("dispatchNewUserForm({ type: 'suffixEdited', value: user.callsign_suffix })")
    expect(fnBody).toContain("dispatchNewUserForm({ type: 'previewRequested', trigger: 'names', teamId: team?.id })")
  })

  it('the radio input calls selectExistingUserCandidate(user), not a bare setSelectedUserId', () => {
    const radioIndex = source.indexOf('name="selectedUser"')
    expect(radioIndex).toBeGreaterThan(-1)
    const onChangeIndex = source.indexOf('onChange=', radioIndex)
    const onChangeEnd = source.indexOf('\n', onChangeIndex)
    expect(source.slice(onChangeIndex, onChangeEnd)).toContain('selectExistingUserCandidate(user)')
  })

  it('renders the review fields only for the member-role picker, gated on selectedUserId, inside the existing tab', () => {
    const tabStart = source.indexOf("{addMemberTab === 'existing' && (")
    expect(tabStart).toBeGreaterThan(-1)
    const gateIndex = source.indexOf("{addMemberRole === 'member' && selectedUserId && (", tabStart)
    expect(gateIndex).toBeGreaterThan(tabStart)
  })

  it('the review block\'s First Name/Last Name inputs dispatch fieldChanged and re-run the names preview on blur, exactly like the Create New User tab', () => {
    const fieldStart = source.indexOf('id="existing-user-first-name"')
    expect(fieldStart).toBeGreaterThan(-1)
    const fieldBlock = source.slice(fieldStart, source.indexOf('/>', fieldStart))
    expect(fieldBlock).toContain("onChange={(e) => dispatchNewUserForm({ type: 'fieldChanged', field: 'firstName', value: e.target.value })}")
    expect(fieldBlock).toContain("onBlur={() => dispatchNewUserForm({ type: 'previewRequested', trigger: 'names', teamId: team?.id })}")

    const lastFieldStart = source.indexOf('id="existing-user-last-name"')
    expect(lastFieldStart).toBeGreaterThan(-1)
    const lastFieldBlock = source.slice(lastFieldStart, source.indexOf('/>', lastFieldStart))
    expect(lastFieldBlock).toContain("onChange={(e) => dispatchNewUserForm({ type: 'fieldChanged', field: 'lastName', value: e.target.value })}")
  })

  it('the review block\'s Callsign Suffix field uses the shared pattern, recompute control, and required/error wiring', () => {
    const fieldStart = source.indexOf('id="existing-user-callsign-suffix"')
    expect(fieldStart).toBeGreaterThan(-1)
    const fieldBlock = source.slice(fieldStart, source.indexOf('/>', fieldStart))
    expect(fieldBlock).toContain('pattern={CALLSIGN_SUFFIX_PATTERN}')
    expect(fieldBlock).toContain('required={newUserFormState.required || pseudonymousTarget}')
    expect(fieldBlock).toContain("onChange={(e) => dispatchNewUserForm({ type: 'suffixEdited', value: e.target.value })}")

    const recomputeIndex = source.indexOf("trigger: 'recompute'", fieldStart)
    expect(recomputeIndex).toBeGreaterThan(fieldStart)
    const recomputeBlockStart = source.lastIndexOf('<button', recomputeIndex)
    const recomputeBlock = source.slice(recomputeBlockStart, source.indexOf('</button>', recomputeIndex))
    expect(recomputeBlock).toContain('disabled={isRecomputeDisabled(newUserFormState)}')
  })

  it('handleAddExistingUser rejects (client-side, no toast-only path) a blank first/last name for the member-role picker before calling the API', () => {
    const fnStart = source.indexOf('const handleAddExistingUser = async () => {')
    expect(fnStart).toBeGreaterThan(-1)
    const fnEnd = source.indexOf('\n  const ', fnStart + 10)
    const fnBody = source.slice(fnStart, fnEnd)

    expect(fnBody).toContain("if (!newUserFormState.firstName.trim() || !newUserFormState.lastName.trim()) {")
    expect(fnBody).toContain("if (!isValidMemberCallsignSuffix(newUserFormState.suffix)) {")
    expect(fnBody).toContain('if (pseudonymousTarget && !newUserFormState.suffix.trim()) {')
    // These guards are scoped to the member-role path only -- the
    // admin-role promotion path has none of these fields.
    expect(fnBody).toContain("if (addMemberRole === 'member') {")
  })

  it('handleAddExistingUser passes the reviewed firstName/lastName/callsignSuffix to usersAPI.addToTeam for the member-role path, and calls teamsAPI.addMember unchanged for the admin-role path', () => {
    const fnStart = source.indexOf('const handleAddExistingUser = async () => {')
    const fnEnd = source.indexOf('\n  const ', fnStart + 10)
    const fnBody = source.slice(fnStart, fnEnd)

    expect(fnBody).toContain("await teamsAPI.addMember(team.id, { userId: selectedUserId, role: 'admin' })")
    expect(fnBody).toContain('await usersAPI.addToTeam(selectedUserId, team.id, {')
    expect(fnBody).toContain('firstName: newUserFormState.firstName.trim(),')
    expect(fnBody).toContain('lastName: newUserFormState.lastName.trim(),')
    expect(fnBody).toContain("callsignSuffix: newUserFormState.suffix.trim() || undefined")
  })

  it('handleAddExistingUser surfaces a callsign_suffix server error inline against the reducer, only for the member-role path, and resets the form on success', () => {
    const fnStart = source.indexOf('const handleAddExistingUser = async () => {')
    const fnEnd = source.indexOf('\n  const ', fnStart + 10)
    const fnBody = source.slice(fnStart, fnEnd)

    expect(fnBody).toContain("const inlineError = addMemberRole === 'member' ? extractCallsignSuffixServerError(error) : null")
    expect(fnBody).toContain("dispatchNewUserForm({ type: 'submitRejected', message: inlineError })")
    // Success path resets the shared reducer alongside the existing
    // dialog/search-state resets, so a stale reviewed value from this
    // add never leaks into the next dialog open.
    const successIndex = fnBody.indexOf("setAddMemberRole('member')")
    expect(successIndex).toBeGreaterThan(-1)
    const successBlock = fnBody.slice(fnBody.lastIndexOf('setShowAddMemberDialog(false)', successIndex), successIndex + 200)
    expect(successBlock).toContain("dispatchNewUserForm({ type: 'reset' })")
  })
})
