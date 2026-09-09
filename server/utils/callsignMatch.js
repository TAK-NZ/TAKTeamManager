/**
 * Callsign-mismatch classification (design: docs/ARCHITECTURE.md ("Callsign Mismatch Detection" section)).
 *
 * Pure, total decision logic with an interesting boundary, so it lives here in
 * `server/utils/` (no framework import, no DB access) where a property test can
 * reach it directly — the same placement rule `clientType.js` and
 * `callsignValidation.js` follow.
 *
 * THE RULE
 *
 * A user is ASSIGNED a callsign by TAK Team Manager
 * (`computeCallsignAttributes` → `user_cache.tak_callsign`), of the shape
 * `<Organisation>[-<Team>]-<Name>` (e.g. `FENZ-STL-J.Doe`). The user may
 * APPEND anything to the end of that assigned callsign in their TAK client
 * (e.g. `FENZ-STL-J.Doe (Tablet)`, `FENZ-STL-J.Doe-Drone`), but may not alter
 * the assigned part itself. So, given the callsign a client is OBSERVED
 * connected under:
 *
 *   - observed === assigned                      -> 'ok'
 *   - observed starts with assigned, and the
 *     next character is a NON-ALPHANUMERIC
 *     boundary (space, '-', '(', '.', etc.)      -> 'appended'
 *   - anything else                              -> 'mismatch'
 *
 * The boundary-character requirement is what distinguishes a genuine append
 * (`FENZ-STL-J.Doe (Tablet)`) from a different name that merely shares a
 * string prefix (`FENZ-STL-J.Doews` — a DIFFERENT person `J.Doews`, which a
 * naive `startsWith` would wrongly accept). An append that continues with an
 * alphanumeric character is treated as a mismatch precisely because it is
 * indistinguishable from a longer assigned name.
 *
 * The content of the appended part is NOT inspected — any addition or
 * separator is acceptable (no bad-word filtering; that is a separate concern
 * with a much higher false-positive rate, deliberately out of scope).
 *
 * COMPARISON SEMANTICS
 *
 * Exact and case-sensitive, with NO trimming: the assigned value has
 * deterministic casing (assembled by `CallsignService.assembleCallsign`), and
 * `' FENZ-...'` / `'fenz-...'` are genuinely different callsigns a TAK client
 * would ingest as-is, not sloppy spellings of the assigned one. A casing or
 * whitespace difference inside/around the assigned portion is a mismatch —
 * the honest answer.
 *
 * TOTAL and NEVER THROWING. Any input yields one of the three verdicts. In
 * particular:
 *   - a null/empty ASSIGNED callsign (a teamless user, whose callsign is
 *     ABSENT — never 'None'/'') has nothing to compare against, so there is no
 *     violation to report: returns 'ok'. Callers should generally skip such
 *     users before calling, but returning 'ok' keeps the function total and
 *     never manufactures a violation from an absent assignment.
 *   - a null/empty OBSERVED callsign cannot equal or extend a non-empty
 *     assigned one, so it is a 'mismatch' (when assigned is present).
 */

const RESULTS = Object.freeze({
  OK: 'ok',
  APPENDED: 'appended',
  MISMATCH: 'mismatch'
});

/**
 * True when `ch` is an ASCII alphanumeric. A valid append must NOT continue
 * with one of these — that would be indistinguishable from a longer assigned
 * name (Requirement: the boundary character).
 *
 * @param {string} ch a single character
 * @returns {boolean}
 */
function isAlphanumeric(ch) {
  return /[A-Za-z0-9]/.test(ch);
}

/**
 * Classifies an observed callsign against the assigned one.
 *
 * @param {unknown} observed the callsign the client is connected under
 *   (`SubscriptionInfo.callsign`). Non-string / empty is treated as absent.
 * @param {unknown} assigned the callsign TAK Team Manager assigned
 *   (`user_cache.tak_callsign`). Non-string / empty is treated as absent
 *   (teamless user), which yields 'ok'.
 * @returns {'ok'|'appended'|'mismatch'}
 */
function classifyObservedCallsign(observed, assigned) {
  // Absent assignment: nothing to violate. Keep total; never invent a
  // violation from an absent assigned callsign.
  if (typeof assigned !== 'string' || assigned === '') {
    return RESULTS.OK;
  }

  // Assignment present but nothing observed (or a non-string): cannot equal or
  // extend the assigned callsign.
  if (typeof observed !== 'string' || observed === '') {
    return RESULTS.MISMATCH;
  }

  if (observed === assigned) {
    return RESULTS.OK;
  }

  // A prefix match is only an append if the assigned callsign is followed by a
  // non-alphanumeric boundary character. `startsWith` alone would accept a
  // longer name sharing the prefix.
  if (observed.startsWith(assigned)) {
    const boundary = observed.charAt(assigned.length);
    if (!isAlphanumeric(boundary)) {
      return RESULTS.APPENDED;
    }
  }

  return RESULTS.MISMATCH;
}

/**
 * Convenience predicate: whether an observed callsign is ACCEPTABLE (equals the
 * assigned callsign or is a valid append). The inverse is a reportable
 * violation. Kept beside the classifier so callers do not re-derive the
 * "'ok' or 'appended'" set and drift from it.
 *
 * @param {unknown} observed
 * @param {unknown} assigned
 * @returns {boolean}
 */
function isCallsignAcceptable(observed, assigned) {
  const verdict = classifyObservedCallsign(observed, assigned);
  return verdict === RESULTS.OK || verdict === RESULTS.APPENDED;
}

module.exports = {
  CALLSIGN_MATCH_RESULTS: RESULTS,
  classifyObservedCallsign,
  isCallsignAcceptable
};
