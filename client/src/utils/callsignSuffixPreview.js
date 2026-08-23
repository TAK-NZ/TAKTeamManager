/**
 * Pure, framework-free state machine and request-body builders for the Add
 * Member Dialog's Callsign Suffix field (member-visibility-and-callsign-recompute,
 * task 1.1). No React import, no API import -- following the convention of
 * `callsignLevels.js` and `channelTree.js` so the decision logic is directly
 * unit- and property-testable independent of rendering.
 *
 * This module supersedes `decideCallsignSuffixPreview`'s two-valued
 * `manuallyEdited` flag with a three-state origin machine. The origin of the
 * Suffix_Field's value -- not merely "may I overwrite it" -- is what decides
 * what a Suffix_Preview or a create-and-add request body carries. That is the
 * whole fix for Defect 1: an Auto_Filled value is never echoed back as
 * `callsignSuffix`, so the server recomputes instead of preferring the stale
 * value the Client itself wrote (Requirement 3.1, 3.2).
 */

/**
 * Requirement 3's three send-behaviours, expressed as the provenance of the
 * Suffix_Field's current value.
 *
 * - `NONE`  : dialog just opened, or the admin cleared the field. Omit `callsignSuffix`.
 * - `AUTO`  : the Client wrote it from a Suffix_Preview response. Omit `callsignSuffix`.
 * - `TYPED` : the admin typed or pasted it. Send `callsignSuffix`.
 */
export const SUFFIX_ORIGIN = { NONE: 'none', AUTO: 'auto', TYPED: 'typed' }

/**
 * Inline message shown against the Suffix_Field when a Suffix_Preview reports a
 * conflict whose response carries no `message` of its own (Requirement 4.3).
 */
export const CONFLICT_FALLBACK_MESSAGE = 'That callsign suffix is already in use in this team'

/**
 * Statement shown while the most recent Suffix_Preview response held `required`
 * of `true`, i.e. the target Organisation's Callsign_Name_Format is
 * `user_defined` (Requirement 6.2).
 */
export const USER_DEFINED_HELP_TEXT = 'This Organisation requires a manually chosen callsign suffix.'

/**
 * @typedef {object} NewUserFormState
 * @property {string} email
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} suffix
 * @property {'none'|'auto'|'typed'} origin   Requirement 3's three states
 * @property {boolean} required               latest response's `required` (Req 6.2, 6.3)
 * @property {string|null} error              inline message (Req 4.3, 7.7)
 * @property {number} inFlight                unsettled request count (Req 7.1, 2.7)
 * @property {number} nextSeq                 monotonic, NEVER reset (Req 7.6)
 * @property {number|null} latestSeq          seq whose response may be applied (Req 7.5)
 * @property {boolean} latestForce            whether that request was a Recompute (Req 2.4)
 * @property {{seq: number, body: object}|null} pendingRequest   the effect's trigger
 */

/**
 * Requirement 3.7: the state a freshly opened Add_Member_Dialog starts in --
 * empty email/names/suffix, an origin of NONE, not required, no error, nothing
 * in flight, `latestSeq` null so no outstanding response can be applied, and no
 * pending request.
 *
 * `nextSeq` starts at 1 here; the reducer preserves it across a `reset` so a
 * stale response from a previous dialog session can never carry a seq matching
 * a fresh request (that preservation is task 1.3's concern -- this function only
 * defines the opening state).
 *
 * @returns {NewUserFormState}
 */
export function initialNewUserFormState() {
  return {
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
  }
}

/**
 * THE fix for Defect 1, and the single answer both request bodies read so they
 * cannot drift (Requirement 5.3).
 *
 * Returns `true` only for a non-empty Admin_Typed_Suffix on a non-forced
 * request:
 * - origin must be `TYPED` (Req 3.1 omits for AUTO, Req 3.2 omits for NONE)
 * - the trimmed value must be non-empty
 * - `force` must be false -- the Recompute_Control always omits the suffix
 *   regardless of the field's value (Req 2.3, 3.3's exception)
 *
 * @param {NewUserFormState} state
 * @param {{force?: boolean}} [options]
 * @returns {boolean}
 */
export function shouldSendCallsignSuffix(state, { force = false } = {}) {
  if (force) {
    return false
  }
  if (!state || state.origin !== SUFFIX_ORIGIN.TYPED) {
    return false
  }
  return typeof state.suffix === 'string' && state.suffix.trim() !== ''
}

/**
 * Requirements 1.4, 1.6, 5.3. Builds the Suffix_Preview request body for the
 * current form state.
 *
 * Returns `null` when either name's trimmed value is empty -- the App cannot
 * compute a Computed_Suffix without both names, so the caller sends nothing at
 * all rather than a body the App cannot resolve (Req 1.4).
 *
 * Otherwise the body carries the CURRENT `firstName`/`lastName`/`teamId` (Req
 * 1.6, so a preview issued after a name edit reflects the edited name), and
 * includes `callsignSuffix` only per `shouldSendCallsignSuffix` (Req 5.3, so the
 * preview body's presence-or-absence of `callsignSuffix` matches the
 * create-and-add body).
 *
 * @param {NewUserFormState} state
 * @param {{teamId?: (number|string), force?: boolean}} [options]
 * @returns {(object|null)}
 */
export function buildSuffixPreviewBody(state, { teamId, force = false } = {}) {
  if (!state) {
    return null
  }
  const firstName = typeof state.firstName === 'string' ? state.firstName : ''
  const lastName = typeof state.lastName === 'string' ? state.lastName : ''
  if (firstName.trim() === '' || lastName.trim() === '') {
    return null
  }
  const body = { firstName, lastName, teamId }
  if (shouldSendCallsignSuffix(state, { force })) {
    body.callsignSuffix = state.suffix
  }
  return body
}

/**
 * Requirement 5.3's other half: the `callsignSuffix` argument for
 * `usersAPI.createAndAdd`. Returns the trimmed typed value exactly when
 * `buildSuffixPreviewBody` would include the property, and `undefined`
 * otherwise -- `undefined` is dropped from the wire body by JSON serialisation,
 * so the two bodies cannot drift, because both delegate to
 * `shouldSendCallsignSuffix`.
 *
 * @param {NewUserFormState} state
 * @returns {(string|undefined)}
 */
export function buildCreateAndAddSuffixArgument(state) {
  if (!shouldSendCallsignSuffix(state)) {
    return undefined
  }
  return state.suffix.trim()
}

/**
 * Requirements 2.6, 2.7, 6.3, 6.6. The Recompute_Control is disabled when:
 * - either name's trimmed value is empty (Req 2.6), OR
 * - a Suffix_Preview is awaiting a response (Req 2.7), OR
 * - the most recent Suffix_Preview response held `required` of `true` (Req 6.3).
 *
 * When no response has yet arrived, `required` is `false`, so the control stays
 * enabled whenever both names are present -- the target Organisation's
 * Callsign_Name_Format is not yet known to the Client (Req 6.6).
 *
 * @param {NewUserFormState} state
 * @returns {boolean}
 */
export function isRecomputeDisabled(state) {
  if (!state) {
    return true
  }
  const firstName = typeof state.firstName === 'string' ? state.firstName : ''
  const lastName = typeof state.lastName === 'string' ? state.lastName : ''
  if (firstName.trim() === '' || lastName.trim() === '') {
    return true
  }
  if (state.inFlight > 0) {
    return true
  }
  return state.required === true
}

/**
 * Requirement 7.1. Whether a busy indication should be shown on or adjacent to
 * the Suffix_Field: true while any Suffix_Preview is awaiting a response.
 *
 * @param {NewUserFormState} state
 * @returns {boolean}
 */
export function selectSuffixBusy(state) {
  return Boolean(state) && state.inFlight > 0
}

/**
 * Requirement 7.5/7.6. Whether a settling Suffix_Preview's response may be
 * applied: only the most recently issued preview's seq is applied, and once the
 * dialog has been reset (`latestSeq` is `null`) every outstanding response is
 * discarded.
 *
 * @param {NewUserFormState} state
 * @param {number} seq
 * @returns {boolean}
 */
export function shouldApplyPreviewResponse(state, seq) {
  if (!state || state.latestSeq === null || state.latestSeq === undefined) {
    return false
  }
  return seq === state.latestSeq
}

/**
 * Successor to `decideCallsignSuffixPreview`, generalising its two-valued
 * `manuallyEdited` argument into the three-state origin. Given the current
 * `NewUserFormState`, a Suffix_Preview response body (`{ suffix, required,
 * conflict }`), and whether the issuing request was a Recompute (`force`),
 * returns the state the form should move to -- or the same state object,
 * unchanged, when the response says nothing that should be applied.
 *
 * The single governing rule is the design's: the origin becomes `AUTO` exactly
 * when this function writes a value into the field, PLUS the force-and-already-
 * equal case, so that a Recompute over an Admin_Typed_Suffix that happens to
 * match the Computed_Suffix still resumes tracking later name edits (Req 2.5).
 *
 * Branches, in the design's order:
 *
 * 1. A missing or non-object response returns the state unchanged. A malformed
 *    or absent body is advisory noise, never an error surfaced to the admin
 *    (Req 7.3).
 * 2. `required === true`: set `{ required: true, error: null }`; leave `suffix`
 *    and `origin` untouched. The Callsign_Name_Format is `user_defined`, so no
 *    Computed_Suffix exists and any Admin_Typed_Suffix stands (Req 4.4, 6.4).
 * 3. A non-null `conflict`: set the inline error to `conflict.message` or the
 *    fallback, and write `conflict.value` into the field ONLY where it is a
 *    non-empty string differing from the current value -- becoming `AUTO` when
 *    that write happens (Req 4.3, 3.4). Writing the same value the admin typed
 *    would be a no-op, so `origin` stays `TYPED` in that case.
 * 4. Otherwise (a clean response, `required === false` and `conflict === null`):
 *    set `{ required: false, error: null }`, and write `response.suffix` when
 *    `force` is true or the origin is not `TYPED` (Req 1.7, 2.4, 4.1, 4.2). The
 *    origin becomes `AUTO` when the value is written, and ALSO when `force` is
 *    true and the value already matched (Req 2.5).
 *
 * @param {NewUserFormState} state
 * @param {(object|null|undefined)} response   the Suffix_Preview response body
 * @param {{force?: boolean}} [options]        whether the issuing request was a Recompute
 * @returns {NewUserFormState}
 */
export function applyPreviewResponse(state, response, { force = false } = {}) {
  // Branch 1: a missing or non-object response changes nothing (Req 7.3).
  if (!response || typeof response !== 'object') {
    return state
  }

  // Branch 2: `required === true` -- suffix and origin untouched (Req 4.4, 6.4).
  if (response.required === true) {
    return { ...state, required: true, error: null }
  }

  const currentSuffix = typeof state.suffix === 'string' ? state.suffix : ''

  // Branch 3: a non-null `conflict` -- surface the message, and write
  // `conflict.value` only where it is a non-empty string differing from the
  // current value (Req 4.3, 3.4).
  const conflict = response.conflict || null
  if (conflict) {
    const error = (typeof conflict.message === 'string' && conflict.message)
      ? conflict.message
      : CONFLICT_FALLBACK_MESSAGE
    const conflictValue = conflict.value
    if (typeof conflictValue === 'string' && conflictValue !== '' && conflictValue !== currentSuffix) {
      // The write happens, so the field is now Auto_Filled.
      return { ...state, required: false, error, suffix: conflictValue, origin: SUFFIX_ORIGIN.AUTO }
    }
    // No write -- the colliding value equals what the admin typed, or the
    // response omitted it. Leave suffix and origin as they are.
    return { ...state, required: false, error }
  }

  // Branch 4: a clean response. Write `response.suffix` when forced or when the
  // field is not an Admin_Typed_Suffix (Req 1.7, 2.4, 4.1, 4.2).
  const nextSuffix = typeof response.suffix === 'string' ? response.suffix : ''
  const shouldWrite = force || state.origin !== SUFFIX_ORIGIN.TYPED
  if (shouldWrite) {
    return { ...state, required: false, error: null, suffix: nextSuffix, origin: SUFFIX_ORIGIN.AUTO }
  }

  // Not written because the field holds an Admin_Typed_Suffix and this was not a
  // Recompute. The force-and-already-equal case cannot occur here (force is
  // false), so origin stays TYPED (Req 4.1).
  return { ...state, required: false, error: null }
}

/**
 * The whole "Create New User" tab as one transition function
 * (member-visibility-and-callsign-recompute, task 1.3). Pure -- no React, no
 * API. Collapses the four `useState` hooks (`newUserForm`,
 * `newUserCallsignRequired`, `newUserCallsignError`, `newUserCallsignEdited`)
 * into a single reducer so there is one answer to "what is in the field and may
 * I overwrite it", which is the shape of bug this spec exists to fix.
 *
 * Actions (from the design's table):
 *
 * - `{type:'reset'}`
 *     Returns `initialNewUserFormState()` BUT preserves the incoming state's
 *     `nextSeq` (Req 7.6). `latestSeq` becomes `null`, so every outstanding
 *     Suffix_Preview response is discarded on settle, and `inFlight` becomes 0.
 *     `nextSeq` is NEVER reset: were the counter to restart, a stale response
 *     from a previous dialog session could carry a seq matching a fresh
 *     request's and be wrongly applied.
 *
 * - `{type:'fieldChanged', field, value}`
 *     Sets `email`/`firstName`/`lastName`; issues no Suffix_Preview (Req 1.5 --
 *     a preview is issued on blur, not on every keystroke).
 *
 * - `{type:'suffixEdited', value}`
 *     `suffix = value`; `origin = TYPED` for a non-empty trimmed value else
 *     `NONE`; clears `error` (Req 3.5, 3.6).
 *
 * - `{type:'previewRequested', trigger, teamId}`
 *     `trigger` is `names`, `suffix`, or `recompute`; `force = trigger ===
 *     'recompute'`. Clears `error` when forced. Builds the body via
 *     `buildSuffixPreviewBody`; when the body is `null` (a name is blank) it
 *     does nothing -- no seq is consumed. When the body is non-null: `seq =
 *     nextSeq`, `nextSeq` bumps, `latestSeq = seq`, `latestForce = force`,
 *     `inFlight` increments, and `pendingRequest` becomes a fresh
 *     `{ seq, body, force }` object whose identity change is what re-runs the
 *     issuing effect (Req 1.1-1.4, 2.3, 2.8).
 *
 * - `{type:'previewSettled', seq, response}`
 *     Decrements `inFlight` clamped at 0. Clears `pendingRequest` only on the
 *     matching seq. Applies the payload via `applyPreviewResponse` only when
 *     `shouldApplyPreviewResponse` -- using `latestForce` from state, not from
 *     the action, so a caller cannot echo the wrong force back (Req 7.5, 7.6).
 *
 * - `{type:'previewFailed', seq}`
 *     Decrements `inFlight` clamped at 0; changes nothing else. A failed
 *     Suffix_Preview is a no-op beyond releasing the busy indication (Req 7.3,
 *     7.4).
 *
 * - `{type:'submitRejected', message}`
 *     Sets `error = message`, keeping the dialog's entered data (Req 7.7).
 *
 * Any unrecognised action returns the state unchanged.
 *
 * @param {NewUserFormState} state
 * @param {object} action
 * @returns {NewUserFormState}
 */
export function newUserFormReducer(state, action) {
  switch (action && action.type) {
    case 'reset': {
      // Fresh state, but the monotonic counter climbs on (Req 7.6). latestSeq
      // null discards every outstanding response; inFlight 0 clears busy.
      return { ...initialNewUserFormState(), nextSeq: state.nextSeq }
    }

    case 'fieldChanged': {
      // Only the three editable text fields; issues no preview (Req 1.5).
      if (action.field !== 'email' && action.field !== 'firstName' && action.field !== 'lastName') {
        return state
      }
      return { ...state, [action.field]: action.value }
    }

    case 'suffixEdited': {
      const value = typeof action.value === 'string' ? action.value : ''
      const origin = value.trim() !== '' ? SUFFIX_ORIGIN.TYPED : SUFFIX_ORIGIN.NONE
      return { ...state, suffix: value, origin, error: null }
    }

    case 'previewRequested': {
      const force = action.trigger === 'recompute'
      // A forced request clears any inline error before it flies (Req 2.8).
      const base = force ? { ...state, error: null } : state
      const body = buildSuffixPreviewBody(base, { teamId: action.teamId, force })
      if (body === null) {
        // A name is blank -- send nothing, consume no seq (Req 1.4).
        return base
      }
      const seq = base.nextSeq
      return {
        ...base,
        nextSeq: base.nextSeq + 1,
        latestSeq: seq,
        latestForce: force,
        inFlight: base.inFlight + 1,
        pendingRequest: { seq, body, force }
      }
    }

    case 'previewSettled': {
      const inFlight = Math.max(0, state.inFlight - 1)
      // Clear the pending trigger only on the matching seq -- a superseded
      // request must not clear the current one's pendingRequest.
      const pendingRequest = (state.pendingRequest && state.pendingRequest.seq === action.seq)
        ? null
        : state.pendingRequest
      const settled = { ...state, inFlight, pendingRequest }
      // Apply the payload only for the most recently issued preview (Req 7.5),
      // reading latestForce from state (Req 2.4).
      if (shouldApplyPreviewResponse(state, action.seq)) {
        return applyPreviewResponse(settled, action.response, { force: state.latestForce })
      }
      return settled
    }

    case 'previewFailed': {
      // Release the busy indication; nothing else changes (Req 7.3, 7.4). The
      // pendingRequest is left as-is: the effect's guard absorbs the settled
      // request, and a superseded failure must not touch the current trigger.
      return { ...state, inFlight: Math.max(0, state.inFlight - 1) }
    }

    case 'submitRejected': {
      return { ...state, error: action.message }
    }

    default:
      return state
  }
}
