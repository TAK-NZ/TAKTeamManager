import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  SUFFIX_ORIGIN,
  CONFLICT_FALLBACK_MESSAGE,
  USER_DEFINED_HELP_TEXT,
  initialNewUserFormState,
  shouldSendCallsignSuffix,
  buildSuffixPreviewBody,
  buildCreateAndAddSuffixArgument,
  isRecomputeDisabled,
  selectSuffixBusy,
  shouldApplyPreviewResponse,
  applyPreviewResponse,
  newUserFormReducer
} from './callsignSuffixPreview.js'

// Feature: member-visibility-and-callsign-recompute, task 1.4.
//
// This file holds the reducer-sequence and example tests for the Add_Member_Dialog's
// Callsign_Suffix state machine. The property tests (Properties 1-4, 11-14, 16) are
// added by tasks 1.5-1.13 in their own describe blocks below these; the blocks here are
// self-contained so those can be appended without conflict.
//
// Every expected value is computed by walking the action sequence directly -- never by
// calling back into the code under test where a property would. Because this is the
// Client, the App's Computed_Suffix is not available here; a Suffix_Preview response
// carries its `suffix` as data, so a sequence models the server's reply as an explicit
// value derived from the currently entered names (e.g. `${firstName}.${lastName}`), which
// is exactly the information the reducer consumes.

const TEAM_ID = 42

// A tiny stand-in for the App's Computed_Suffix, used only to build the `suffix` a modelled
// Suffix_Preview response would carry for a given name pair. The reducer never computes
// this; it only ever receives it in a response body.
function modelComputedSuffix(firstName, lastName) {
  return `${firstName.trim()}.${lastName.trim()}`
}

// Drive the reducer through an ordered list of actions, returning the final state. This is
// the direct data walk: the test constructs the sequence, this folds it.
function runSequence(actions, start = initialNewUserFormState()) {
  return actions.reduce((state, action) => newUserFormReducer(state, action), start)
}

describe('callsignSuffixPreview reducer sequences (Requirements 15.3-15.8)', () => {
  // Requirement 15.3: editing First Name after an auto-fill, then blurring, yields a field
  // value derived from the NEW First Name -- the whole point of Defect 1's fix.
  it('an auto-fill then a First Name edit then a names blur yields a value derived from the new First Name (Req 15.3)', () => {
    // 1. Enter Chris / Elsen and blur First Name -> a preview is issued.
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
    ])
    const firstSeq = state.latestSeq
    // The first body carries the current names and omits callsignSuffix (nothing typed).
    expect(state.pendingRequest.body).toEqual({ firstName: 'Chris', lastName: 'Elsen', teamId: TEAM_ID })
    expect(state.pendingRequest.body).not.toHaveProperty('callsignSuffix')

    // 2. The server replies with the Computed_Suffix; the field auto-fills.
    state = newUserFormReducer(state, {
      type: 'previewSettled',
      seq: firstSeq,
      response: { suffix: modelComputedSuffix('Chris', 'Elsen'), required: false, conflict: null }
    })
    expect(state.suffix).toBe('Chris.Elsen')
    expect(state.origin).toBe(SUFFIX_ORIGIN.AUTO)

    // 3. Edit First Name to Bob and blur -> a fresh preview issues with the NEW name.
    state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Bob' },
      { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
    ], state)
    const secondSeq = state.latestSeq
    expect(secondSeq).not.toBe(firstSeq)
    // The AUTO field is not echoed, so the recompute is a real recompute.
    expect(state.pendingRequest.body).toEqual({ firstName: 'Bob', lastName: 'Elsen', teamId: TEAM_ID })
    expect(state.pendingRequest.body).not.toHaveProperty('callsignSuffix')

    // 4. The server replies for Bob; the field follows the new name.
    state = newUserFormReducer(state, {
      type: 'previewSettled',
      seq: secondSeq,
      response: { suffix: modelComputedSuffix('Bob', 'Elsen'), required: false, conflict: null }
    })
    expect(state.suffix).toBe('Bob.Elsen')
    expect(state.origin).toBe(SUFFIX_ORIGIN.AUTO)
  })

  // Requirement 15.4: a typed value is sent as callsignSuffix and survives its response.
  it('a typed value is sent as callsignSuffix and survives its response unchanged (Req 15.4)', () => {
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'suffixEdited', value: 'MyOwn' },
      { type: 'previewRequested', trigger: 'suffix', teamId: TEAM_ID }
    ])
    const seq = state.latestSeq
    // The typed value rides along as callsignSuffix (Req 3.3).
    expect(state.origin).toBe(SUFFIX_ORIGIN.TYPED)
    expect(state.pendingRequest.body.callsignSuffix).toBe('MyOwn')

    // A clean response returns; the typed value is left alone (Req 4.1).
    state = newUserFormReducer(state, {
      type: 'previewSettled',
      seq,
      response: { suffix: modelComputedSuffix('Chris', 'Elsen'), required: false, conflict: null }
    })
    expect(state.suffix).toBe('MyOwn')
    expect(state.origin).toBe(SUFFIX_ORIGIN.TYPED)
  })

  // Requirement 15.5: the Recompute_Control's request omits callsignSuffix and its response
  // replaces the field's value, discarding the Admin_Typed_Suffix.
  it("the Recompute_Control's request omits callsignSuffix and its response replaces a typed value (Req 15.5)", () => {
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'suffixEdited', value: 'MyOwn' },
      { type: 'previewRequested', trigger: 'recompute', teamId: TEAM_ID }
    ])
    const seq = state.latestSeq
    // Even though the field holds a typed value, the forced request omits it (Req 2.3, 3.3).
    expect(state.suffix).toBe('MyOwn')
    expect(state.latestForce).toBe(true)
    expect(state.pendingRequest.body).not.toHaveProperty('callsignSuffix')

    // The response replaces the typed value and the field becomes AUTO (Req 2.4, 2.5).
    state = newUserFormReducer(state, {
      type: 'previewSettled',
      seq,
      response: { suffix: modelComputedSuffix('Chris', 'Elsen'), required: false, conflict: null }
    })
    expect(state.suffix).toBe('Chris.Elsen')
    expect(state.origin).toBe(SUFFIX_ORIGIN.AUTO)
  })

  // Requirement 15.6: a `required` response disables the control and leaves a typed value alone.
  it('a required response disables the Recompute_Control and leaves an Admin_Typed_Suffix alone (Req 15.6)', () => {
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'suffixEdited', value: 'MyOwn' },
      { type: 'previewRequested', trigger: 'suffix', teamId: TEAM_ID }
    ])
    const seq = state.latestSeq

    state = newUserFormReducer(state, {
      type: 'previewSettled',
      seq,
      response: { suffix: null, required: true, conflict: null }
    })
    // The typed value survives (Req 6.4) and the control is disabled (Req 6.3).
    expect(state.suffix).toBe('MyOwn')
    expect(state.origin).toBe(SUFFIX_ORIGIN.TYPED)
    expect(state.required).toBe(true)
    expect(isRecomputeDisabled(state)).toBe(true)
  })

  // Requirement 15.7: an out-of-order response is discarded and does not overwrite the value
  // written by the most recently issued preview.
  it('an out-of-order (superseded) response is discarded (Req 15.7)', () => {
    // Two blurred previews issued back to back; the second is the latest.
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
    ])
    const firstSeq = state.latestSeq
    state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Bob' },
      { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
    ], state)
    const secondSeq = state.latestSeq
    expect(state.inFlight).toBe(2)

    // The fast (second) response arrives first and is applied.
    state = newUserFormReducer(state, {
      type: 'previewSettled',
      seq: secondSeq,
      response: { suffix: 'Bob.Elsen', required: false, conflict: null }
    })
    expect(state.suffix).toBe('Bob.Elsen')
    expect(state.inFlight).toBe(1)

    // The slow (first) response arrives later; its payload is discarded, only inFlight moves.
    state = newUserFormReducer(state, {
      type: 'previewSettled',
      seq: firstSeq,
      response: { suffix: 'Chris.Elsen', required: false, conflict: null }
    })
    expect(state.suffix).toBe('Bob.Elsen')
    expect(state.inFlight).toBe(0)
  })

  // Requirement 15.8: a failure changes nothing and leaves submission permitted.
  it('a failed preview changes nothing and leaves the field and submission untouched (Req 15.8)', () => {
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'suffixEdited', value: 'MyOwn' },
      { type: 'previewRequested', trigger: 'suffix', teamId: TEAM_ID }
    ])
    const seq = state.latestSeq
    const before = { ...state }

    state = newUserFormReducer(state, { type: 'previewFailed', seq })

    // Only the busy count is released; value, origin, required and error are unchanged.
    expect(state.suffix).toBe(before.suffix)
    expect(state.origin).toBe(before.origin)
    expect(state.required).toBe(before.required)
    expect(state.error).toBe(before.error)
    expect(state.inFlight).toBe(0)
    // No blocking error was set, so submission remains permitted.
    expect(state.error).toBeNull()
  })
})

describe('callsignSuffixPreview examples (Requirements 2.8, 3.7, 6.2, 7.1, 7.7)', () => {
  // Requirement 3.7: an opened dialog starts with a cleared field and no origin.
  it('initialNewUserFormState is the freshly opened dialog state (Req 3.7)', () => {
    expect(initialNewUserFormState()).toEqual({
      email: '',
      firstName: '',
      lastName: '',
      suffix: '',
      origin: SUFFIX_ORIGIN.NONE,
      required: false,
      error: null,
      inFlight: 0,
      nextSeq: 1,
      latestSeq: null,
      latestForce: false,
      pendingRequest: null
    })
  })

  // Requirement 3.7: a reset returns to the opening state but preserves the monotonic
  // nextSeq so a stale response can never match a fresh request.
  it('reset restores the opening state while preserving nextSeq (Req 3.7, 7.6)', () => {
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID },
      { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
    ])
    const advancedSeq = state.nextSeq
    expect(advancedSeq).toBeGreaterThan(1)

    state = newUserFormReducer(state, { type: 'reset' })
    expect(state.firstName).toBe('')
    expect(state.suffix).toBe('')
    expect(state.origin).toBe(SUFFIX_ORIGIN.NONE)
    expect(state.latestSeq).toBeNull()
    expect(state.inFlight).toBe(0)
    // nextSeq climbs on rather than restarting at 1.
    expect(state.nextSeq).toBe(advancedSeq)
  })

  // Requirement 2.8: activating the Recompute_Control clears any inline message before the
  // resulting response is applied.
  it('a forced (recompute) request clears any prior inline error (Req 2.8)', () => {
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'submitRejected', message: 'Callsign suffix is already in use' }
    ])
    expect(state.error).toBe('Callsign suffix is already in use')

    state = newUserFormReducer(state, { type: 'previewRequested', trigger: 'recompute', teamId: TEAM_ID })
    expect(state.error).toBeNull()
  })

  // Requirement 6.2: the required marking is carried on the state so the Client can show the
  // user_defined statement.
  it('a required response records the required marking; USER_DEFINED_HELP_TEXT is available (Req 6.2)', () => {
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
    ])
    const seq = state.latestSeq
    state = newUserFormReducer(state, {
      type: 'previewSettled',
      seq,
      response: { suffix: null, required: true, conflict: null }
    })
    expect(state.required).toBe(true)
    expect(USER_DEFINED_HELP_TEXT).toBe('This Organisation requires a manually chosen callsign suffix.')
  })

  // Requirement 7.1: selectSuffixBusy is true while a preview is awaiting a response and
  // false once it settles.
  it('selectSuffixBusy reflects an outstanding preview (Req 7.1)', () => {
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
    ])
    expect(selectSuffixBusy(state)).toBe(true)

    state = newUserFormReducer(state, {
      type: 'previewSettled',
      seq: state.latestSeq,
      response: { suffix: 'Chris.Elsen', required: false, conflict: null }
    })
    expect(selectSuffixBusy(state)).toBe(false)
  })

  // Requirement 7.7: a shaped 400 from create-and-add sets an inline error while keeping the
  // entered data (the dialog stays open, so its fields are untouched).
  it('submitRejected sets an inline error and keeps the entered data (Req 7.7)', () => {
    let state = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'suffixEdited', value: 'MyOwn' }
    ])
    state = newUserFormReducer(state, { type: 'submitRejected', message: 'Callsign suffix is required for this Organisation' })
    expect(state.error).toBe('Callsign suffix is required for this Organisation')
    // The entered data survives the rejection.
    expect(state.firstName).toBe('Chris')
    expect(state.lastName).toBe('Elsen')
    expect(state.suffix).toBe('MyOwn')
    expect(state.origin).toBe(SUFFIX_ORIGIN.TYPED)
  })
})

// The applyPreviewResponse cases inherited from the `decideCallsignSuffixPreview` describe
// block being removed from `client/src/pages/TeamDetail.test.jsx` in task 3.5. Each case is
// re-expressed against `applyPreviewResponse`, whose two-valued `manuallyEdited` argument
// becomes the three-valued origin: `manuallyEdited: true` -> origin TYPED, `false` -> NONE
// (or AUTO for an already-auto-filled field). The old helper returned a
// `{ callsignSuffix, required, error }` decision or `null`; the successor returns the next
// state (or the same state unchanged), so these assert on `suffix`/`origin`/`required`/`error`.
describe('applyPreviewResponse (inherited from decideCallsignSuffixPreview)', () => {
  function stateWith(overrides) {
    return { ...initialNewUserFormState(), ...overrides }
  }

  it('pre-fills the field with the resolved suffix when there is no conflict and none is required', () => {
    const state = stateWith({ suffix: '', origin: SUFFIX_ORIGIN.NONE })
    const next = applyPreviewResponse(state, { suffix: 'J.Bloggs', required: false, conflict: null })
    expect(next.suffix).toBe('J.Bloggs')
    expect(next.origin).toBe(SUFFIX_ORIGIN.AUTO)
    expect(next.required).toBe(false)
    expect(next.error).toBeNull()
  })

  it('does not clobber a value the admin typed themselves', () => {
    const state = stateWith({ suffix: 'Joe.B2', origin: SUFFIX_ORIGIN.TYPED })
    const next = applyPreviewResponse(state, { suffix: 'Joe.B', required: false, conflict: null })
    expect(next.suffix).toBe('Joe.B2')
    expect(next.origin).toBe(SUFFIX_ORIGIN.TYPED)
    expect(next.error).toBeNull()
  })

  it('marks the field required and leaves an empty field empty for a user_defined Organisation', () => {
    const state = stateWith({ suffix: '', origin: SUFFIX_ORIGIN.NONE })
    const next = applyPreviewResponse(state, { suffix: null, required: true, conflict: null })
    expect(next.suffix).toBe('')
    expect(next.origin).toBe(SUFFIX_ORIGIN.NONE)
    expect(next.required).toBe(true)
    expect(next.error).toBeNull()
  })

  it('surfaces the conflict message inline and pre-fills the colliding value so it can be edited', () => {
    const state = stateWith({ suffix: '', origin: SUFFIX_ORIGIN.NONE })
    const next = applyPreviewResponse(state, {
      suffix: 'J.Bloggs',
      required: false,
      conflict: { value: 'J.Bloggs', message: 'Callsign suffix J.Bloggs is already used in this team' }
    })
    expect(next.suffix).toBe('J.Bloggs')
    expect(next.origin).toBe(SUFFIX_ORIGIN.AUTO)
    expect(next.required).toBe(false)
    expect(next.error).toBe('Callsign suffix J.Bloggs is already used in this team')
  })

  it('keeps the current value, and still reports the error, when a conflict omits its value', () => {
    const missingValue = applyPreviewResponse(
      stateWith({ suffix: 'Joe.B', origin: SUFFIX_ORIGIN.NONE }),
      { suffix: null, required: false, conflict: { message: 'Already taken' } }
    )
    expect(missingValue.suffix).toBe('Joe.B')
    expect(missingValue.required).toBe(false)
    expect(missingValue.error).toBe('Already taken')

    const emptyValue = applyPreviewResponse(
      stateWith({ suffix: 'Joe.B', origin: SUFFIX_ORIGIN.NONE }),
      { suffix: null, required: false, conflict: { value: '', message: 'Already taken' } }
    )
    expect(emptyValue.suffix).toBe('Joe.B')
    expect(emptyValue.required).toBe(false)
    expect(emptyValue.error).toBe('Already taken')
  })

  it('never pre-fills anything on the required path, which has no colliding value to offer', () => {
    const state = stateWith({ suffix: 'Joe.B', origin: SUFFIX_ORIGIN.TYPED })
    const next = applyPreviewResponse(state, { suffix: null, required: true, conflict: null })
    expect(next.suffix).toBe('Joe.B')
    expect(next.origin).toBe(SUFFIX_ORIGIN.TYPED)
    expect(next.required).toBe(true)
    expect(next.error).toBeNull()
  })

  it('surfaces a conflict against a manually typed value while keeping that value', () => {
    const state = stateWith({ suffix: 'Joe.B', origin: SUFFIX_ORIGIN.TYPED })
    const next = applyPreviewResponse(state, {
      suffix: 'Joe.B',
      required: false,
      conflict: { value: 'Joe.B', message: 'Already taken' }
    })
    // conflict.value equals what the admin typed, so no write happens and origin stays TYPED.
    expect(next.suffix).toBe('Joe.B')
    expect(next.origin).toBe(SUFFIX_ORIGIN.TYPED)
    expect(next.required).toBe(false)
    expect(next.error).toBe('Already taken')
  })

  it('falls back to a generic message when a conflict carries no message', () => {
    const state = stateWith({ suffix: '', origin: SUFFIX_ORIGIN.NONE })
    const next = applyPreviewResponse(state, {
      suffix: 'J.Bloggs',
      required: false,
      conflict: { value: 'J.Bloggs' }
    })
    expect(next.error).toBe(CONFLICT_FALLBACK_MESSAGE)
  })

  it('changes nothing when the preview call failed (no body), so submission is never blocked', () => {
    const typed = stateWith({ suffix: 'Joe.B', origin: SUFFIX_ORIGIN.TYPED })
    expect(applyPreviewResponse(typed, undefined)).toBe(typed)
    const empty = stateWith({ suffix: '', origin: SUFFIX_ORIGIN.NONE })
    expect(applyPreviewResponse(empty, null)).toBe(empty)
    expect(applyPreviewResponse(empty, 'Internal Server Error')).toBe(empty)
  })

  it('empties a stale auto-filled value when the server resolves no suffix at all', () => {
    const state = stateWith({ suffix: 'J.Bloggs', origin: SUFFIX_ORIGIN.AUTO })
    const next = applyPreviewResponse(state, { suffix: null, required: false, conflict: null })
    expect(next.suffix).toBe('')
    expect(next.origin).toBe(SUFFIX_ORIGIN.AUTO)
  })
})

// A small set of direct unit examples for the pure body/selector helpers, so the reducer
// sequences above rest on independently verified building blocks.
describe('callsignSuffixPreview body and selector helpers', () => {
  function stateWith(overrides) {
    return { ...initialNewUserFormState(), ...overrides }
  }

  it('shouldSendCallsignSuffix is true only for a non-empty TYPED value on a non-forced request', () => {
    expect(shouldSendCallsignSuffix(stateWith({ suffix: 'X', origin: SUFFIX_ORIGIN.TYPED }))).toBe(true)
    expect(shouldSendCallsignSuffix(stateWith({ suffix: 'X', origin: SUFFIX_ORIGIN.TYPED }), { force: true })).toBe(false)
    expect(shouldSendCallsignSuffix(stateWith({ suffix: '  ', origin: SUFFIX_ORIGIN.TYPED }))).toBe(false)
    expect(shouldSendCallsignSuffix(stateWith({ suffix: 'X', origin: SUFFIX_ORIGIN.AUTO }))).toBe(false)
    expect(shouldSendCallsignSuffix(stateWith({ suffix: '', origin: SUFFIX_ORIGIN.NONE }))).toBe(false)
  })

  it('buildSuffixPreviewBody returns null when either name is blank', () => {
    expect(buildSuffixPreviewBody(stateWith({ firstName: 'A', lastName: '' }), { teamId: TEAM_ID })).toBeNull()
    expect(buildSuffixPreviewBody(stateWith({ firstName: '  ', lastName: 'B' }), { teamId: TEAM_ID })).toBeNull()
  })

  it('buildSuffixPreviewBody and buildCreateAndAddSuffixArgument agree on presence', () => {
    const typed = stateWith({ firstName: 'A', lastName: 'B', suffix: 'MyOwn', origin: SUFFIX_ORIGIN.TYPED })
    expect(buildSuffixPreviewBody(typed, { teamId: TEAM_ID }).callsignSuffix).toBe('MyOwn')
    expect(buildCreateAndAddSuffixArgument(typed)).toBe('MyOwn')

    const auto = stateWith({ firstName: 'A', lastName: 'B', suffix: 'A.B', origin: SUFFIX_ORIGIN.AUTO })
    expect(buildSuffixPreviewBody(auto, { teamId: TEAM_ID })).not.toHaveProperty('callsignSuffix')
    expect(buildCreateAndAddSuffixArgument(auto)).toBeUndefined()
  })

  it('isRecomputeDisabled is true when a name is blank, a preview is in flight, or required is set', () => {
    expect(isRecomputeDisabled(stateWith({ firstName: 'A', lastName: 'B' }))).toBe(false)
    expect(isRecomputeDisabled(stateWith({ firstName: 'A', lastName: '' }))).toBe(true)
    expect(isRecomputeDisabled(stateWith({ firstName: 'A', lastName: 'B', inFlight: 1 }))).toBe(true)
    expect(isRecomputeDisabled(stateWith({ firstName: 'A', lastName: 'B', required: true }))).toBe(true)
  })

  it('shouldApplyPreviewResponse matches only the latest seq and never once latestSeq is null', () => {
    expect(shouldApplyPreviewResponse(stateWith({ latestSeq: 5 }), 5)).toBe(true)
    expect(shouldApplyPreviewResponse(stateWith({ latestSeq: 5 }), 4)).toBe(false)
    expect(shouldApplyPreviewResponse(stateWith({ latestSeq: null }), 5)).toBe(false)
  })
})

// Feature: member-visibility-and-callsign-recompute, task 1.5.
//
// Property 1 (design.md): "For any two name pairs (f1, l1) and (f2, l2) whose
// Computed_Suffix values differ, and any Callsign_Name_Format other than
// user_defined: entering (f1, l1), allowing the Suffix_Field to auto-fill from
// the resulting Suffix_Preview, then entering (f2, l2) and triggering a
// [names-blur] Suffix_Preview produces a request body that omits callsignSuffix,
// carries firstName of f2 and lastName of l2, and leaves the Suffix_Field holding
// computeDefaultCallsignSuffix(f2, l2, format)."
//
// This is the assertion whose absence let Defect 1 ship: it fails on code that
// echoes the Auto_Filled value back as callsignSuffix instead of letting the
// server recompute from the new names.
//
// The Client has no access to the App's CallsignService, and a Suffix_Preview
// response carries its `suffix` as data. So the expected Computed_Suffix is
// derived by a MODEL function (`modelComputeDefaultCallsignSuffix`) that walks the
// generated names directly -- never by calling the reducer's own logic -- and that
// same modelled value is fed back as the response the reducer consumes.

// A faithful model of the App's `CallsignService.computeDefaultCallsignSuffix`
// for every Callsign_Name_Format other than `user_defined`. It is the test's
// independent oracle: the reducer never computes this, it only ever receives it
// inside a modelled response body.
function modelComputeDefaultCallsignSuffix(firstName, lastName, format) {
  const trimmedFirst = (firstName || '').trim()
  const trimmedLast = (lastName || '').trim()
  let rawSuffix
  switch (format) {
    case 'first_initial_last':
      rawSuffix = trimmedLast ? `${trimmedFirst.charAt(0)} ${trimmedLast}` : trimmedFirst
      break
    case 'first_last_initial':
      rawSuffix = trimmedLast ? `${trimmedFirst} ${trimmedLast.charAt(0)}` : trimmedFirst
      break
    case 'first_initial_dot_last':
      rawSuffix = trimmedLast ? `${trimmedFirst.charAt(0)}.${trimmedLast}` : trimmedFirst
      break
    case 'full_name':
    default:
      rawSuffix = `${trimmedFirst} ${trimmedLast}`.trim()
      break
  }
  return rawSuffix.replace(/[^A-Za-z0-9.-]/g, '-')
}

describe('callsignSuffixPreview Property 1: A recompute reflects the current names (Requirements 1.6, 1.7, 3.1, 15.1)', () => {
  // Every Callsign_Name_Format the App recognises save `user_defined`, whose
  // Computed_Suffix is null and so is out of this property's scope.
  const FORMATS = ['full_name', 'first_initial_last', 'first_last_initial', 'first_initial_dot_last']

  // Names constrained to letters/digits so the model's sanitisation is a no-op
  // and the two pairs' distinctness is easy to reason about.
  const namePart = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,7}$/)

  // Feature: member-visibility-and-callsign-recompute, Property 1: A recompute reflects the current names
  it('an auto-fill for pair 1 followed by a names-blur preview for pair 2 recomputes to pair 2 and never echoes pair 1', () => {
    fc.assert(
      fc.property(
        namePart, namePart, namePart, namePart,
        fc.constantFrom(...FORMATS),
        (f1, l1, f2, l2, format) => {
          const suffix1 = modelComputeDefaultCallsignSuffix(f1, l1, format)
          const suffix2 = modelComputeDefaultCallsignSuffix(f2, l2, format)
          // The property is stated over pairs with DISTINCT Computed_Suffix
          // values; discard generated cases that collide.
          fc.pre(suffix1 !== suffix2)

          // 1. Enter name pair 1 and blur a name -> a preview issues carrying the
          //    current names and omitting callsignSuffix (nothing typed).
          let state = runSequence([
            { type: 'fieldChanged', field: 'firstName', value: f1 },
            { type: 'fieldChanged', field: 'lastName', value: l1 },
            { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
          ])
          const firstSeq = state.latestSeq
          expect(state.pendingRequest.body).toEqual({ firstName: f1, lastName: l1, teamId: TEAM_ID })
          expect(state.pendingRequest.body).not.toHaveProperty('callsignSuffix')

          // 2. The modelled response carries pair 1's Computed_Suffix; the field
          //    auto-fills and its origin becomes AUTO.
          state = newUserFormReducer(state, {
            type: 'previewSettled',
            seq: firstSeq,
            response: { suffix: suffix1, required: false, conflict: null }
          })
          expect(state.suffix).toBe(suffix1)
          expect(state.origin).toBe(SUFFIX_ORIGIN.AUTO)

          // 3. Edit to name pair 2 and blur -> a fresh preview issues. Its body
          //    must carry the pair-2 names and must OMIT callsignSuffix: the
          //    Auto_Filled pair-1 value is never echoed back (Req 1.6, 3.1).
          state = runSequence([
            { type: 'fieldChanged', field: 'firstName', value: f2 },
            { type: 'fieldChanged', field: 'lastName', value: l2 },
            { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
          ], state)
          const secondSeq = state.latestSeq
          expect(secondSeq).not.toBe(firstSeq)
          expect(state.pendingRequest.body).toEqual({ firstName: f2, lastName: l2, teamId: TEAM_ID })
          expect(state.pendingRequest.body).not.toHaveProperty('callsignSuffix')

          // 4. Applying the modelled pair-2 response yields pair 2's
          //    Computed_Suffix in the field, so the recompute reflects the
          //    current names (Req 1.7, 15.1).
          state = newUserFormReducer(state, {
            type: 'previewSettled',
            seq: secondSeq,
            response: { suffix: suffix2, required: false, conflict: null }
          })
          expect(state.suffix).toBe(suffix2)
          expect(state.origin).toBe(SUFFIX_ORIGIN.AUTO)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// Feature: member-visibility-and-callsign-recompute, task 1.6.
//
// Property 2 (design.md): "For any Suffix_Field value, any origin, and any
// `force` flag, a Suffix_Preview request body includes a `callsignSuffix`
// property if and only if the origin is Admin_Typed, the value's trimmed form
// is non-empty, and `force` is false -- and for any state, buildSuffixPreviewBody
// and buildCreateAndAddSuffixArgument agree on that presence, so no sequence of
// blur events with no intervening edit of the Suffix_Field can produce a body
// carrying a value the Client itself wrote."
//
// This walks the full cube of {suffix field value (empty, non-empty, whitespace),
// origin (NONE/AUTO/TYPED), force (true/false)} and computes the expected
// presence DIRECTLY from the generated state fields -- never by calling
// shouldSendCallsignSuffix, whose behaviour is the thing under test.
describe('callsignSuffixPreview Property 2: No auto-filled value is ever echoed, and both bodies agree (Requirements 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 5.3)', () => {
  // Suffix values spanning the three trimmed classes: empty, whitespace-only
  // (also empty when trimmed), and genuinely non-empty.
  const suffixArb = fc.oneof(
    fc.constant(''),
    fc.constant('   '),
    fc.constant('\t'),
    fc.stringMatching(/^[A-Za-z0-9. -]{1,10}$/),
    // A value with surrounding whitespace, to confirm trimming decides presence
    // and the sent argument is trimmed.
    fc.stringMatching(/^[A-Za-z0-9.-]{1,6}$/).map((s) => `  ${s}  `)
  )
  const originArb = fc.constantFrom(SUFFIX_ORIGIN.NONE, SUFFIX_ORIGIN.AUTO, SUFFIX_ORIGIN.TYPED)
  // Valid non-empty names so buildSuffixPreviewBody never short-circuits to null;
  // presence of callsignSuffix is then the only thing under test.
  const nameArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,7}$/)

  // Feature: member-visibility-and-callsign-recompute, Property 2: No auto-filled value is ever echoed, and both bodies agree
  it('the preview body carries callsignSuffix iff (origin TYPED and non-empty trimmed value and not forced); force always omits it; AUTO is never echoed; and both bodies agree', () => {
    fc.assert(
      fc.property(
        suffixArb, originArb, fc.boolean(), nameArb, nameArb,
        (suffix, origin, force, firstName, lastName) => {
          const state = {
            ...initialNewUserFormState(),
            firstName,
            lastName,
            suffix,
            origin
          }

          // Expectation computed directly from the state fields, not from
          // shouldSendCallsignSuffix.
          const trimmedNonEmpty = suffix.trim() !== ''
          const isTyped = origin === SUFFIX_ORIGIN.TYPED
          const isAuto = origin === SUFFIX_ORIGIN.AUTO

          const previewBody = buildSuffixPreviewBody(state, { teamId: TEAM_ID, force })
          // Names are valid, so the body is always produced.
          expect(previewBody).not.toBeNull()
          const previewHasSuffix = Object.prototype.hasOwnProperty.call(previewBody, 'callsignSuffix')

          if (force) {
            // Req 2.3: the Recompute_Control's request omits callsignSuffix
            // regardless of the field's value or origin.
            expect(previewHasSuffix).toBe(false)
          } else {
            // Req 3.1/3.2/3.3: included iff TYPED and non-empty trimmed.
            expect(previewHasSuffix).toBe(isTyped && trimmedNonEmpty)
          }

          // Req 3.1: an AUTO value is NEVER echoed, forced or not.
          if (isAuto) {
            expect(previewHasSuffix).toBe(false)
          }

          // Req 3.2: an empty (trimmed) value is never sent, forced or not.
          if (!trimmedNonEmpty) {
            expect(previewHasSuffix).toBe(false)
          }

          // Req 5.3: the two bodies agree on presence. buildCreateAndAddSuffixArgument
          // is the non-forced (submit) path, so compare against the non-forced
          // preview body.
          const submitPreviewBody = buildSuffixPreviewBody(state, { teamId: TEAM_ID, force: false })
          const submitPreviewHasSuffix = Object.prototype.hasOwnProperty.call(submitPreviewBody, 'callsignSuffix')
          const createArg = buildCreateAndAddSuffixArgument(state)
          const createHasSuffix = createArg !== undefined
          expect(createHasSuffix).toBe(submitPreviewHasSuffix)
          // And both equal the directly-computed expectation for a non-forced body.
          expect(createHasSuffix).toBe(isTyped && trimmedNonEmpty)

          // When a value is sent, the create argument is the trimmed suffix and
          // matches the preview body's raw value.
          if (createHasSuffix) {
            expect(createArg).toBe(suffix.trim())
            expect(submitPreviewBody.callsignSuffix).toBe(suffix)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})

// Feature: member-visibility-and-callsign-recompute, task 1.7.
//
// Property 3 (design.md): "For any name pair, two consecutive Recomputes with no
// intervening edit of any field yield the same Suffix_Field value, the same
// origin, and the same required marking."
//
// Idempotence of a Recompute. Starting from any valid state with both names
// present, applying one Recompute (a forced `previewRequested` followed by the
// modelled `previewSettled` for the current names) settles the field to some
// value with origin AUTO. Applying the SAME Recompute again -- same names, so the
// same modelled response -- must leave the value, origin and required marking
// identical: recompute twice == recompute once.
//
// The modelled Computed_Suffix is derived by `modelComputeDefaultCallsignSuffix`
// (the independent oracle defined for Property 1 above), which walks the generated
// names directly and is never the reducer's own logic. That same value is fed back
// as the response the reducer consumes on each Recompute.
describe('callsignSuffixPreview Property 3: A recompute is idempotent (Requirements 1.6, 2.5)', () => {
  // Every Callsign_Name_Format save `user_defined`, whose Computed_Suffix is null.
  const FORMATS = ['full_name', 'first_initial_last', 'first_last_initial', 'first_initial_dot_last']

  const namePart = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,7}$/)

  // An arbitrary starting origin for the Suffix_Field before the first Recompute:
  // NONE (freshly opened / cleared), AUTO (already auto-filled), or TYPED (the
  // admin typed a value the Recompute is about to discard). Idempotence must hold
  // regardless of where the field started, because after the first Recompute the
  // field is always AUTO.
  const startOriginArb = fc.constantFrom(SUFFIX_ORIGIN.NONE, SUFFIX_ORIGIN.AUTO, SUFFIX_ORIGIN.TYPED)
  const typedValueArb = fc.stringMatching(/^[A-Za-z0-9. -]{1,10}$/)

  // Apply one Recompute to a state: force a preview for the current names, then
  // settle it with the modelled Computed_Suffix for those names.
  function applyRecompute(state, format) {
    const requested = newUserFormReducer(state, { type: 'previewRequested', trigger: 'recompute', teamId: TEAM_ID })
    // Both names are present by construction, so a body was built and a seq issued.
    const seq = requested.latestSeq
    const suffix = modelComputeDefaultCallsignSuffix(requested.firstName, requested.lastName, format)
    return newUserFormReducer(requested, {
      type: 'previewSettled',
      seq,
      response: { suffix, required: false, conflict: null }
    })
  }

  // Feature: member-visibility-and-callsign-recompute, Property 3: A recompute is idempotent
  it('two consecutive Recomputes with no intervening edit yield the identical value, origin and required marking', () => {
    fc.assert(
      fc.property(
        namePart, namePart,
        fc.constantFrom(...FORMATS),
        startOriginArb, typedValueArb,
        (firstName, lastName, format, startOrigin, typedValue) => {
          // A valid starting state with both names present. The suffix value is
          // only meaningful when the field started TYPED; for NONE/AUTO the
          // Recompute writes the modelled value regardless.
          const startSuffix = startOrigin === SUFFIX_ORIGIN.NONE ? '' : typedValue
          const start = {
            ...initialNewUserFormState(),
            firstName,
            lastName,
            suffix: startSuffix,
            origin: startOrigin
          }

          // First Recompute.
          const once = applyRecompute(start, format)
          // A Recompute always writes the Computed_Suffix and marks the field AUTO
          // (Req 2.4, 2.5), so later name edits keep tracking.
          expect(once.origin).toBe(SUFFIX_ORIGIN.AUTO)
          expect(once.required).toBe(false)

          // Second Recompute, with no intervening edit of any field.
          const twice = applyRecompute(once, format)

          // Idempotence: the second Recompute leaves the value, origin and required
          // marking exactly as the first left them.
          expect(twice.suffix).toBe(once.suffix)
          expect(twice.origin).toBe(once.origin)
          expect(twice.required).toBe(once.required)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// Feature: member-visibility-and-callsign-recompute, task 1.8.
//
// Property 4 (design.md): "For any non-empty Admin_Typed_Suffix and any
// subsequent sequence of name edits, name-field blurs, Suffix_Field blurs, and
// arriving Suffix_Preview responses -- including responses holding `required` of
// `true` -- the Suffix_Field's value remains that Admin_Typed_Suffix, unless the
// sequence contains an activation of the Recompute_Control, a reported conflict
// whose `conflict.value` differs from it, or a reset of the Add_Member_Dialog."
//
// The state machine holds that a TYPED origin survives everything but the
// Recompute_Control (a forced `previewRequested`), a `conflict.value` write, or a
// reset. This property generates a sequence drawn ONLY from the non-discarding
// actions -- name edits (fieldChanged firstName/lastName), names/suffix blurs
// (previewRequested with trigger 'names' or 'suffix'), arriving clean responses
// (previewSettled with a computed suffix), and arriving required=true responses --
// and asserts the typed value and TYPED origin are invariant across the whole
// sequence.
//
// The expected value is computed by tracking the typed value directly (it never
// changes), not by calling back into the reducer's logic.
describe('callsignSuffixPreview Property 4: A typed suffix is preserved until it is deliberately discarded (Requirements 4.1, 4.2, 4.4, 4.5, 6.4)', () => {
  // A non-empty Admin_Typed_Suffix. Constrained to a value whose trimmed form is
  // non-empty so `suffixEdited` records it as TYPED.
  const typedSuffixArb = fc.stringMatching(/^[A-Za-z0-9. -]{1,10}$/).filter((s) => s.trim() !== '')

  const namePart = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,7}$/)

  // The non-discarding actions. Deliberately EXCLUDES:
  //   - previewRequested with trigger 'recompute' (the Recompute_Control),
  //   - previewSettled carrying a conflict whose value differs,
  //   - reset.
  // A clean or required response is modelled with a `suffix` derived from the
  // currently entered names, which is the information a real Suffix_Preview
  // response carries; the reducer must NOT write it over a TYPED field (Req 4.1).
  const actionArb = fc.oneof(
    // A name edit (no preview issued).
    namePart.map((value) => ({ type: 'fieldChanged', field: 'firstName', value })),
    namePart.map((value) => ({ type: 'fieldChanged', field: 'lastName', value })),
    // A First/Last name blur -> a non-forced names preview.
    fc.constant({ type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }),
    // A Suffix_Field blur -> a non-forced suffix preview.
    fc.constant({ type: 'previewRequested', trigger: 'suffix', teamId: TEAM_ID }),
    // A clean response arriving for whatever preview is outstanding.
    fc.constant({ kind: 'settle-clean' }),
    // A required=true response arriving (user_defined Organisation).
    fc.constant({ kind: 'settle-required' })
  )

  // Feature: member-visibility-and-callsign-recompute, Property 4: A typed suffix is preserved until it is deliberately discarded
  it('a typed suffix and its TYPED origin survive any sequence of name edits, blurs, and clean/required responses', () => {
    fc.assert(
      fc.property(
        typedSuffixArb, namePart, namePart,
        fc.array(actionArb, { minLength: 0, maxLength: 20 }),
        (typedSuffix, firstName, lastName, actions) => {
          // The admin enters both names then types a suffix -> origin TYPED.
          let state = runSequence([
            { type: 'fieldChanged', field: 'firstName', value: firstName },
            { type: 'fieldChanged', field: 'lastName', value: lastName },
            { type: 'suffixEdited', value: typedSuffix }
          ])
          expect(state.origin).toBe(SUFFIX_ORIGIN.TYPED)
          expect(state.suffix).toBe(typedSuffix)

          // Drive the generated sequence. `settle-*` actions are turned into a
          // previewSettled for the CURRENTLY outstanding preview, so a settle
          // with no preview in flight is simply skipped (nothing to settle).
          for (const action of actions) {
            if (action.kind === 'settle-clean') {
              if (state.latestSeq !== null) {
                // A clean response carrying the Computed_Suffix for the current
                // names. The reducer must leave a TYPED field alone (Req 4.1).
                state = newUserFormReducer(state, {
                  type: 'previewSettled',
                  seq: state.latestSeq,
                  response: {
                    suffix: `${state.firstName}.${state.lastName}`,
                    required: false,
                    conflict: null
                  }
                })
              }
            } else if (action.kind === 'settle-required') {
              if (state.latestSeq !== null) {
                // A required=true response leaves suffix and origin untouched
                // (Req 4.4, 6.4).
                state = newUserFormReducer(state, {
                  type: 'previewSettled',
                  seq: state.latestSeq,
                  response: { suffix: null, required: true, conflict: null }
                })
              }
            } else {
              state = newUserFormReducer(state, action)
            }

            // The invariant, checked after every step: the typed value and its
            // TYPED origin are unchanged. None of the generated actions is a
            // Recompute, a differing conflict, or a reset.
            expect(state.suffix).toBe(typedSuffix)
            expect(state.origin).toBe(SUFFIX_ORIGIN.TYPED)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  // The complement: the three deliberate-discard actions DO change the typed
  // value or its origin, so the property's "unless" clause is meaningful rather
  // than vacuously true.
  it('the deliberate-discard actions each change the typed suffix or its origin', () => {
    const base = runSequence([
      { type: 'fieldChanged', field: 'firstName', value: 'Chris' },
      { type: 'fieldChanged', field: 'lastName', value: 'Elsen' },
      { type: 'suffixEdited', value: 'MyOwn' }
    ])

    // 1. The Recompute_Control replaces the typed value with the response's suffix.
    let recomputed = newUserFormReducer(base, { type: 'previewRequested', trigger: 'recompute', teamId: TEAM_ID })
    recomputed = newUserFormReducer(recomputed, {
      type: 'previewSettled',
      seq: recomputed.latestSeq,
      response: { suffix: 'Chris.Elsen', required: false, conflict: null }
    })
    expect(recomputed.suffix).toBe('Chris.Elsen')
    expect(recomputed.origin).toBe(SUFFIX_ORIGIN.AUTO)

    // 2. A conflict whose value differs writes that value and flips origin to
    //    AUTO. A suffix blur issues a preview first to obtain a seq to settle.
    let withPreview = newUserFormReducer(base, { type: 'previewRequested', trigger: 'suffix', teamId: TEAM_ID })
    withPreview = newUserFormReducer(withPreview, {
      type: 'previewSettled',
      seq: withPreview.latestSeq,
      response: { suffix: null, required: false, conflict: { value: 'Different', message: 'Taken' } }
    })
    expect(withPreview.suffix).toBe('Different')
    expect(withPreview.origin).toBe(SUFFIX_ORIGIN.AUTO)

    // 3. A reset clears the field back to NONE.
    const reset = newUserFormReducer(base, { type: 'reset' })
    expect(reset.suffix).toBe('')
    expect(reset.origin).toBe(SUFFIX_ORIGIN.NONE)
  })
})

// Feature: member-visibility-and-callsign-recompute, task 1.9.
//
// Property 11 (design.md): "For any state and any preview trigger -- a First
// Name blur, a Last Name blur, a Suffix_Field blur, or a Recompute_Control
// activation -- a Suffix_Preview request is produced if and only if both the
// First Name and the Last Name hold non-empty trimmed values, and no keystroke
// action on any of the three inputs ever produces one."
//
// A preview is "produced" when the previewRequested action consumes a seq: the
// reducer sets `pendingRequest` non-null (its identity change is what drives the
// issuing effect), bumps `nextSeq`, sets `latestSeq`, and increments `inFlight`.
// When a name is blank the reducer builds a null body and does none of these, so
// no preview is produced.
//
// The expected "issued?" is computed DIRECTLY from whether both trimmed names are
// non-empty -- never by calling buildSuffixPreviewBody -- so the property is an
// independent statement about that condition rather than a restatement of the
// code under test.
describe('callsignSuffixPreview Property 11: A preview is issued exactly when both names are present (Requirements 1.1, 1.2, 1.3, 1.4, 1.5)', () => {
  // Names spanning the three trimmed classes: empty, whitespace-only (also empty
  // when trimmed), and genuinely non-empty. This is what makes the "both non-empty
  // trimmed" condition exercised across all four presence combinations.
  const nameArb = fc.oneof(
    fc.constant(''),
    fc.constant('   '),
    fc.constant('\t'),
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,7}$/),
    // Surrounding whitespace, to confirm trimming decides issuance.
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,5}$/).map((s) => `  ${s}  `)
  )

  // Every previewRequested trigger: the two name blurs and the Suffix_Field blur
  // are non-forced; the Recompute_Control activation is forced.
  const triggerArb = fc.constantFrom('names', 'suffix', 'recompute')

  // An arbitrary starting origin/suffix, so issuance is shown to depend on the
  // names alone and not on what the field currently holds.
  const originArb = fc.constantFrom(SUFFIX_ORIGIN.NONE, SUFFIX_ORIGIN.AUTO, SUFFIX_ORIGIN.TYPED)
  const suffixArb = fc.oneof(fc.constant(''), fc.stringMatching(/^[A-Za-z0-9. -]{1,8}$/))

  // Feature: member-visibility-and-callsign-recompute, Property 11: A preview is issued exactly when both names are present
  it('every trigger issues a preview iff both trimmed names are non-empty, and no keystroke ever issues one', () => {
    fc.assert(
      fc.property(
        nameArb, nameArb, triggerArb, originArb, suffixArb,
        (firstName, lastName, trigger, origin, suffix) => {
          const start = {
            ...initialNewUserFormState(),
            firstName,
            lastName,
            suffix,
            origin
          }

          // The expected outcome, computed directly from the names: a preview is
          // issued exactly when BOTH trimmed names are non-empty (Req 1.1-1.4).
          const bothNamesPresent = firstName.trim() !== '' && lastName.trim() !== ''

          // --- The trigger path (Req 1.1, 1.2, 1.3, and the Recompute_Control). ---
          const afterTrigger = newUserFormReducer(start, { type: 'previewRequested', trigger, teamId: TEAM_ID })

          if (bothNamesPresent) {
            // A preview was issued: pendingRequest is non-null, a seq was consumed,
            // latestSeq was set to it, and inFlight incremented.
            expect(afterTrigger.pendingRequest).not.toBeNull()
            expect(afterTrigger.pendingRequest.seq).toBe(start.nextSeq)
            expect(afterTrigger.nextSeq).toBe(start.nextSeq + 1)
            expect(afterTrigger.latestSeq).toBe(start.nextSeq)
            expect(afterTrigger.inFlight).toBe(start.inFlight + 1)
            // The body carries the current names (Req 1.6) whatever the trigger.
            expect(afterTrigger.pendingRequest.body.firstName).toBe(firstName)
            expect(afterTrigger.pendingRequest.body.lastName).toBe(lastName)
          } else {
            // No preview: nothing was consumed. A forced trigger may still clear
            // the error (Req 2.8), but it must not issue a request when a name is
            // blank (Req 1.4).
            expect(afterTrigger.pendingRequest).toBe(start.pendingRequest)
            expect(afterTrigger.nextSeq).toBe(start.nextSeq)
            expect(afterTrigger.latestSeq).toBe(start.latestSeq)
            expect(afterTrigger.inFlight).toBe(start.inFlight)
          }

          // --- The keystroke path (Req 1.5): a fieldChanged on any input never
          //     issues a preview, regardless of the names. ---
          for (const field of ['firstName', 'lastName', 'email']) {
            const afterKeystroke = newUserFormReducer(start, { type: 'fieldChanged', field, value: 'anything' })
            expect(afterKeystroke.pendingRequest).toBe(start.pendingRequest)
            expect(afterKeystroke.nextSeq).toBe(start.nextSeq)
            expect(afterKeystroke.latestSeq).toBe(start.latestSeq)
            expect(afterKeystroke.inFlight).toBe(start.inFlight)
          }
          // A suffixEdited (keystroke into the Suffix_Field) also never issues one.
          const afterSuffixEdit = newUserFormReducer(start, { type: 'suffixEdited', value: 'X' })
          expect(afterSuffixEdit.pendingRequest).toBe(start.pendingRequest)
          expect(afterSuffixEdit.nextSeq).toBe(start.nextSeq)
          expect(afterSuffixEdit.latestSeq).toBe(start.latestSeq)
          expect(afterSuffixEdit.inFlight).toBe(start.inFlight)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// Feature: member-visibility-and-callsign-recompute, task 1.10.
//
// Property 12 (design.md): "For any combination of First Name, Last Name,
// in-flight preview count, and latest-response `required` flag, the
// Recompute_Control is disabled if and only if either name's trimmed value is
// empty, or a Suffix_Preview is awaiting a response, or the latest response held
// `required` of `true` -- so a state in which no response has yet arrived leaves
// it enabled whenever both names are present."
//
// The property walks the cube of {firstName, lastName each empty / whitespace-only
// / non-empty} x {inFlight 0 or >0} x {required true / false} and computes the
// expected disabled value DIRECTLY from those generated fields -- never by calling
// isRecomputeDisabled, which is the function under test. The no-response-yet state
// (required false, both names present, inFlight 0) is included and must leave the
// control ENABLED (Req 6.6), because the Client does not yet know the target
// Organisation's Callsign_Name_Format.
describe('callsignSuffixPreview Property 12: The Recompute_Control is disabled exactly on its three conditions (Requirements 2.6, 2.7, 6.3, 6.6)', () => {
  // A name spanning the three trimmed classes: genuinely empty, whitespace-only
  // (empty when trimmed, so it must count as "empty" for Req 2.6), and non-empty.
  const nameArb = fc.oneof(
    fc.constant(''),
    fc.constant('   '),
    fc.constant('\t'),
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,7}$/),
    // Surrounding whitespace, to confirm trimming decides the empty condition.
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,5}$/).map((s) => `  ${s}  `)
  )
  // inFlight of 0 (nothing awaiting) or a positive count (a preview in flight).
  const inFlightArb = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 5 }))
  const requiredArb = fc.boolean()

  // Feature: member-visibility-and-callsign-recompute, Property 12: The Recompute_Control is disabled exactly on its three conditions
  it('isRecomputeDisabled is true iff a name is blank, a preview is in flight, or the latest response was required -- and the no-response-yet state is enabled', () => {
    fc.assert(
      fc.property(
        nameArb, nameArb, inFlightArb, requiredArb,
        (firstName, lastName, inFlight, required) => {
          const state = {
            ...initialNewUserFormState(),
            firstName,
            lastName,
            inFlight,
            required
          }

          // The expectation computed directly from the generated fields, not from
          // isRecomputeDisabled.
          const eitherNameEmpty = firstName.trim() === '' || lastName.trim() === ''
          const previewInFlight = inFlight > 0
          const expectedDisabled = eitherNameEmpty || previewInFlight || required === true

          expect(isRecomputeDisabled(state)).toBe(expectedDisabled)

          // The no-response-yet case (Req 6.6): both names present, nothing in
          // flight, and required still false -- the control is enabled.
          if (!eitherNameEmpty && !previewInFlight && required === false) {
            expect(isRecomputeDisabled(state)).toBe(false)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})

// Feature: member-visibility-and-callsign-recompute, task 1.11.
//
// Property 13 (design.md): "For any sequence of issued Suffix_Previews, any
// permutation of the order in which their responses arrive, and any reset
// injected at any point in that sequence, the Suffix_Field's resulting value,
// required marking, and inline message are those derived from the response to
// the most recently issued preview still outstanding at the time it settles --
// and no response issued before a reset is applied at all."
//
// This is the ordering guarantee behind Requirement 7.5 (a superseded response
// is discarded) and Requirement 7.6 (a response issued before a reset is
// discarded, because reset nulls latestSeq while the monotonic nextSeq climbs
// on so a post-reset seq can never collide with a pre-reset one).
//
// The expected final field is computed DIRECTLY, by tracking which seq is the
// reducer's latestSeq after all issue/reset events -- never by calling
// shouldApplyPreviewResponse. Only the response whose seq equals that final
// latestSeq is ever applied: previewSettled leaves latestSeq untouched, so a
// response matching it applies on delivery regardless of arrival order, while
// every earlier/superseded seq (and every pre-reset seq once reset has nulled
// latestSeq) fails the seq match and is discarded.
describe('callsignSuffixPreview Property 13: Only the most recently issued preview\'s response is applied (Requirements 7.5, 7.6)', () => {
  // Each issued preview carries a distinct name pair (so its modelled response's
  // suffix is distinguishable) and blurs a name, which issues a names-blur
  // preview whose body omits callsignSuffix. Names are letters/digits so the
  // modelled suffix needs no sanitising.
  const namePart = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,5}$/)
  const previewArb = fc.record({ firstName: namePart, lastName: namePart })

  // Feature: member-visibility-and-callsign-recompute, Property 13: Only the most recently issued preview's response is applied
  it('after any permutation of arrivals with a reset at any point, the field reflects only the latest still-outstanding preview and discards every pre-reset one', () => {
    fc.assert(
      fc.property(
        // At least one preview, so there is always something to issue.
        fc.array(previewArb, { minLength: 1, maxLength: 6 }),
        // Where to inject a reset among the issue events: 0..N means "after the
        // k-th issued preview"; a value equal to previews.length + 1 means "no
        // reset at all", so both the reset and the no-reset worlds are covered.
        fc.nat(),
        // A permutation of arrival order, expressed as sort keys over the
        // deliveries; equal keys keep their relative order, which is fine.
        fc.array(fc.integer(), { minLength: 6, maxLength: 6 }),
        (previews, resetPoint, arrivalKeys) => {
          const n = previews.length
          // resetAfter in 0..n means a reset lands right after issuing that many
          // previews; resetAfter === n + 1 (or beyond, folded here) means no reset.
          const noReset = resetPoint % (n + 2) === n + 1
          const resetAfter = noReset ? null : resetPoint % (n + 1)

          // Build the issue/reset event stream and drive the reducer, recording
          // for each issued preview its seq and the modelled response it will
          // later receive. The modelled response's suffix is derived directly
          // from the generated names -- the reducer never computes it.
          let state = initialNewUserFormState()
          const issued = [] // { seq, response }
          for (let i = 0; i < n; i++) {
            if (resetAfter === i) {
              state = newUserFormReducer(state, { type: 'reset' })
            }
            const { firstName, lastName } = previews[i]
            state = runSequence([
              { type: 'fieldChanged', field: 'firstName', value: firstName },
              { type: 'fieldChanged', field: 'lastName', value: lastName },
              { type: 'previewRequested', trigger: 'names', teamId: TEAM_ID }
            ], state)
            const response = { suffix: modelComputedSuffix(firstName, lastName), required: false, conflict: null }
            issued.push({ seq: state.latestSeq, response })
          }
          // A reset injected after the last preview (or anywhere at index n).
          if (resetAfter === n) {
            state = newUserFormReducer(state, { type: 'reset' })
          }

          // The reducer's latestSeq after all issue/reset events. This is the
          // ONLY seq whose response the reducer will ever apply: it is the most
          // recently issued preview still outstanding -- null if a reset was the
          // last event (Req 7.6), otherwise the seq of the last issued preview
          // (Req 7.5). previewSettled never changes latestSeq, so arrival order
          // cannot move it.
          const finalLatestSeq = state.latestSeq

          // The state expected once every response has been delivered, computed
          // directly by applying only the finalLatestSeq response (if any) to a
          // clean base -- never via shouldApplyPreviewResponse.
          const winner = issued.find((entry) => entry.seq === finalLatestSeq) || null
          // The field/origin/required/error the winning response would leave.
          const expected = winner
            ? applyPreviewResponse(
                { suffix: '', origin: SUFFIX_ORIGIN.NONE, required: false, error: null },
                winner.response,
                { force: false }
              )
            : { suffix: '', origin: SUFFIX_ORIGIN.NONE, required: false, error: null }

          // Deliver every issued response in an arbitrary permutation. Superseded
          // and pre-reset responses fail the seq match and only move inFlight.
          const order = issued
            .map((entry, index) => ({ entry, key: arrivalKeys[index % arrivalKeys.length], index }))
            .sort((a, b) => (a.key - b.key) || (a.index - b.index))
          for (const { entry } of order) {
            state = newUserFormReducer(state, {
              type: 'previewSettled',
              seq: entry.seq,
              response: entry.response
            })
          }

          // Only the most recently issued still-outstanding preview's response is
          // reflected; every earlier and every pre-reset response was discarded.
          expect(state.suffix).toBe(expected.suffix)
          expect(state.origin).toBe(expected.origin)
          expect(state.required).toBe(expected.required)
          expect(state.error).toBe(expected.error)
          // Every delivery decremented the busy count back to zero.
          expect(state.inFlight).toBe(0)
          // latestSeq is untouched by settling, so it still holds the winner (or
          // null after a trailing reset).
          expect(state.latestSeq).toBe(finalLatestSeq)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// Feature: member-visibility-and-callsign-recompute, task 1.12.
//
// Property 14 (design.md): "For any state and any Suffix_Preview failure, the
// Suffix_Field's value, its origin, its required marking, and its inline message
// are unchanged, and the state's submit-blocking fields are unchanged, so
// submission remains permitted."
//
// A failed Suffix_Preview (`previewFailed`) is a no-op beyond releasing the busy
// indication: it decrements `inFlight` by exactly one (clamped at 0) and touches
// nothing else -- not `suffix`, `origin`, `required`, `error`, `latestSeq`,
// `nextSeq`, or `pendingRequest` (Req 7.3). Because no blocking `error` is set,
// submission stays permitted (Req 7.4).
//
// Arbitrary starting states (names, suffix, origin, required, error) are generated,
// then a real preview is issued so a preview is in flight (`inFlight` > 0,
// `latestSeq` set), then `previewFailed` is dispatched for that preview's seq (or
// an arbitrary seq). The expected `inFlight` is computed DIRECTLY as
// `max(0, before.inFlight - 1)` -- never by calling the reducer's own clamp -- and
// every other field is asserted equal to its pre-failure value. The already-idle
// case (`inFlight` 0) is also covered: it stays 0.
describe('callsignSuffixPreview Property 14: A failed preview is a no-op (Requirements 7.3, 7.4)', () => {
  // Names spanning empty, whitespace-only, and non-empty, so the state feeding the
  // failure is drawn from the whole space rather than only the both-present case.
  const nameArb = fc.oneof(
    fc.constant(''),
    fc.constant('   '),
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,7}$/)
  )
  const suffixArb = fc.oneof(fc.constant(''), fc.stringMatching(/^[A-Za-z0-9. -]{1,10}$/))
  const originArb = fc.constantFrom(SUFFIX_ORIGIN.NONE, SUFFIX_ORIGIN.AUTO, SUFFIX_ORIGIN.TYPED)
  const requiredArb = fc.boolean()
  const errorArb = fc.oneof(fc.constant(null), fc.stringMatching(/^[A-Za-z0-9 .]{1,20}$/))

  // The seq to fail: the preview's own seq (the realistic case) or an arbitrary
  // one (a stale/superseded failure), since previewFailed treats them identically.
  const failSeqArb = fc.oneof(fc.constant('own'), fc.integer({ min: -3, max: 50 }))

  // Feature: member-visibility-and-callsign-recompute, Property 14: A failed preview is a no-op
  it('previewFailed decrements inFlight by exactly one (clamped at 0) and changes nothing else, so submission stays permitted', () => {
    fc.assert(
      fc.property(
        nameArb, nameArb, suffixArb, originArb, requiredArb, errorArb, failSeqArb,
        (firstName, lastName, suffix, origin, required, error, failSeq) => {
          // An arbitrary starting state.
          const start = {
            ...initialNewUserFormState(),
            firstName,
            lastName,
            suffix,
            origin,
            required,
            error
          }

          // Issue a preview so one is genuinely in flight. The body is null when a
          // name is blank, so a preview is only issued when both names are present;
          // to guarantee inFlight > 0 for the main case, force both names present
          // by issuing against a names-complete copy, then splice the resulting
          // in-flight bookkeeping back over the arbitrary state. Simpler: run the
          // preview on a state that always has both names, but that would lose the
          // arbitrary firstName/lastName under test. Instead, drive the preview and
          // handle both outcomes.
          const withPreview = newUserFormReducer(start, {
            type: 'previewRequested',
            trigger: 'names',
            teamId: TEAM_ID
          })
          const inFlightBefore = withPreview.inFlight
          const seq = failSeq === 'own' ? (withPreview.latestSeq ?? 1) : failSeq

          // The state just before the failure -- its every field is what the
          // failure must preserve save inFlight.
          const before = { ...withPreview }

          const after = newUserFormReducer(withPreview, { type: 'previewFailed', seq })

          // inFlight drops by exactly one, clamped at 0 -- computed directly here.
          const expectedInFlight = Math.max(0, inFlightBefore - 1)
          expect(after.inFlight).toBe(expectedInFlight)

          // Everything else is untouched (Req 7.3).
          expect(after.suffix).toBe(before.suffix)
          expect(after.origin).toBe(before.origin)
          expect(after.required).toBe(before.required)
          expect(after.error).toBe(before.error)
          expect(after.latestSeq).toBe(before.latestSeq)
          expect(after.nextSeq).toBe(before.nextSeq)
          expect(after.latestForce).toBe(before.latestForce)
          expect(after.pendingRequest).toBe(before.pendingRequest)
          expect(after.email).toBe(before.email)
          expect(after.firstName).toBe(before.firstName)
          expect(after.lastName).toBe(before.lastName)

          // No blocking error was introduced, so submission remains permitted: the
          // failure never sets an error, so error is exactly whatever it was
          // before the failure (Req 7.4).
          expect(after.error).toBe(before.error)
        }
      ),
      { numRuns: 100 }
    )
  })

  // The already-idle case: previewFailed on a state with inFlight 0 leaves it at 0
  // (the clamp), and still changes nothing else.
  it('previewFailed on an idle state (inFlight 0) keeps inFlight at 0 and changes nothing else', () => {
    fc.assert(
      fc.property(
        suffixArb, originArb, requiredArb, errorArb, fc.integer({ min: -3, max: 50 }),
        (suffix, origin, required, error, seq) => {
          const start = {
            ...initialNewUserFormState(),
            suffix,
            origin,
            required,
            error,
            inFlight: 0
          }
          const before = { ...start }

          const after = newUserFormReducer(start, { type: 'previewFailed', seq })

          // Clamped at 0 -- never goes negative.
          expect(after.inFlight).toBe(0)
          expect(after.suffix).toBe(before.suffix)
          expect(after.origin).toBe(before.origin)
          expect(after.required).toBe(before.required)
          expect(after.error).toBe(before.error)
          expect(after.latestSeq).toBe(before.latestSeq)
          expect(after.nextSeq).toBe(before.nextSeq)
          expect(after.pendingRequest).toBe(before.pendingRequest)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// Feature: member-visibility-and-callsign-recompute, task 1.13.
//
// Property 16 (design.md): "For any reported conflict, the inline message
// displayed is `conflict.message` where present and the fallback message
// otherwise, and the Suffix_Field's value is replaced by `conflict.value` if
// and only if `conflict.value` is a non-empty string differing from the field's
// current value -- in which case, and only in which case, the field's origin
// becomes Auto_Filled."
//
// This walks the cube of {current suffix, current origin, conflict.value (equal
// to current / different / empty / absent), conflict.message (present / absent)}
// and computes the expected error, suffix and origin DIRECTLY from the generated
// fields -- never by calling applyPreviewResponse, whose conflict branch is the
// thing under test. When the write happens the suffix becomes conflict.value and
// the origin becomes AUTO; when it does not (value equal / empty / absent) the
// suffix and origin are left exactly as they were (Req 3.4, 4.3, 5.5).
describe('callsignSuffixPreview Property 16: A conflict writes only a value that differs (Requirements 3.4, 4.3, 5.5)', () => {
  // A current Suffix_Field value spanning empty and non-empty forms, so the
  // "differs from the current value" condition is exercised from both sides.
  const currentSuffixArb = fc.oneof(
    fc.constant(''),
    fc.stringMatching(/^[A-Za-z0-9. -]{1,10}$/)
  )
  const originArb = fc.constantFrom(SUFFIX_ORIGIN.NONE, SUFFIX_ORIGIN.AUTO, SUFFIX_ORIGIN.TYPED)
  // A conflict.value spanning: absent (undefined), empty string, and a genuine
  // non-empty string. The non-empty case is later split into "equals current"
  // and "differs from current" by construction, so all four value-classes named
  // in the property are covered.
  const conflictValueArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(''),
    fc.stringMatching(/^[A-Za-z0-9. -]{1,10}$/)
  )
  // A conflict.message that is present (non-empty) or absent (undefined), so the
  // fallback path is exercised.
  const conflictMessageArb = fc.oneof(
    fc.constant(undefined),
    fc.stringMatching(/^[A-Za-z0-9 .]{1,30}$/)
  )
  // Whether the non-empty conflict.value should be forced to equal the current
  // suffix, so the "equal to current" class is reached deterministically rather
  // than relying on a random collision.
  const forceEqualArb = fc.boolean()

  // Feature: member-visibility-and-callsign-recompute, Property 16: A conflict writes only a value that differs
  it('a conflict sets the message (or fallback) and writes conflict.value into the field, becoming AUTO, only when it is a non-empty string differing from the current value', () => {
    fc.assert(
      fc.property(
        currentSuffixArb, originArb, conflictValueArb, conflictMessageArb, forceEqualArb,
        (currentSuffix, origin, conflictValueRaw, conflictMessage, forceEqual) => {
          // When the generated conflict.value is a non-empty string and the case
          // asks for it to equal the current suffix, substitute the current
          // suffix so the "equal to current" class is genuinely reached.
          let conflictValue = conflictValueRaw
          if (forceEqual && typeof conflictValueRaw === 'string' && conflictValueRaw !== '') {
            conflictValue = currentSuffix
          }

          // Build the conflict object, including `value`/`message` only when the
          // generated case says they are present, so their true absence is tested.
          const conflict = {}
          if (conflictValue !== undefined) {
            conflict.value = conflictValue
          }
          if (conflictMessage !== undefined) {
            conflict.message = conflictMessage
          }

          const state = {
            ...initialNewUserFormState(),
            suffix: currentSuffix,
            origin
          }

          // The expectations, computed directly from the generated fields.
          // The message: conflict.message where it is a non-empty string, else
          // the fallback (Req 4.3).
          const expectedError = (typeof conflictMessage === 'string' && conflictMessage !== '')
            ? conflictMessage
            : CONFLICT_FALLBACK_MESSAGE
          // The write happens iff conflict.value is a non-empty string differing
          // from the current value (Req 3.4, 5.5).
          const shouldWrite =
            typeof conflictValue === 'string' && conflictValue !== '' && conflictValue !== currentSuffix
          const expectedSuffix = shouldWrite ? conflictValue : currentSuffix
          const expectedOrigin = shouldWrite ? SUFFIX_ORIGIN.AUTO : origin

          const next = applyPreviewResponse(state, {
            suffix: null,
            required: false,
            conflict
          })

          // A conflict always surfaces a message and clears the required marking.
          expect(next.error).toBe(expectedError)
          expect(next.required).toBe(false)
          // The value is written only when it differs and is non-empty; the
          // origin flips to AUTO exactly when that write happens.
          expect(next.suffix).toBe(expectedSuffix)
          expect(next.origin).toBe(expectedOrigin)
        }
      ),
      { numRuns: 100 }
    )
  })
})
