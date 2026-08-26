/**
 * Pure countdown formatter for the Enrollment_Token's Token_Countdown
 * (takserver-enrollment Requirement 10.2).
 *
 * `formatCountdown` renders the live `MM : SS` countdown to Enrollment_Token
 * expiry that `EnrollmentCountdown.jsx` (task 9.3) ticks every second, and
 * the terminal `EXPIRED` state once the token has lapsed.
 *
 * TOTAL and NEVER THROWING, following the same discipline
 * `client/src/utils/expiryWarning.js` uses for `classifyExpiry`: every input
 * whatsoever yields a defined output. This one has a single caller
 * (`EnrollmentCountdown`, driven by a `setInterval` tick) rather than one
 * per row of a rendered list, but a live countdown that throws on an odd
 * value is just as visible a failure as a blank table cell would be, so
 * the same totality discipline applies.
 *
 * Placed in `client/src/utils/` beside `dateFormat.js`, `channelTree.js` and
 * `expiryWarning.js`, per the repository's placement rule for pure decision
 * logic with interesting boundaries: no React import at all, so a property
 * test (task 9.7) can reach it directly.
 */

/**
 * The terminal countdown state (takserver-enrollment Requirement 10.2).
 *
 * Exported as a named constant, matching `expiryWarning.js`'s
 * `EXPIRY_STATES` convention, so a consumer compares against
 * `COUNTDOWN_EXPIRED` rather than re-typing the string literal `'EXPIRED'`.
 *
 * @type {'EXPIRED'}
 */
export const COUNTDOWN_EXPIRED = 'EXPIRED'

/**
 * Formats a remaining-milliseconds value as a live countdown display.
 *
 * Pure, TOTAL, and NEVER THROWS. `msRemaining <= 0` and every non-positive
 * or unusable value -- `null`, `undefined`, `NaN`, `Infinity`, `-Infinity`,
 * and any non-number type -- all yield `COUNTDOWN_EXPIRED`. Only a finite
 * number strictly greater than zero produces an `MM : SS` string.
 *
 * ROUNDING DIRECTION -- deliberately `Math.ceil`, not `Math.floor`. This is
 * a countdown display showing time REMAINING, not time elapsed: at 1500ms
 * remaining, a viewer who has not yet reached the boundary should still see
 * a non-zero value, so the total-seconds figure is rounded UP
 * (`Math.ceil(1500 / 1000) === 2`) rather than down to a misleadingly early
 * `0`. `Math.floor` would make the display touch `00 : 00` a full second
 * before the token has actually expired. The minutes/seconds split is then
 * taken from that same ceil'd total-seconds figure, so the two components
 * always agree with each other.
 *
 * MINUTES ARE NOT WRAPPED AT 60 AND NOT TRUNCATED AT 99. This is an
 * `MM : SS` duration display, not an `HH:MM:SS` clock, so the minutes
 * component is never reduced with `% 60` -- that would be the construction
 * for an hours-and-minutes display, which this is not -- and it is never
 * clamped to two digits. A 30-minute Enrollment_Token_Lifetime never
 * actually produces more than two digits of minutes in normal operation,
 * but a value that DOES exceed two digits -- from a future change to the
 * lifetime constant, or a bug elsewhere feeding this function a bad
 * `msRemaining` -- must render as `150 : 00` (three or more digits) rather
 * than wrap to `50 : 00` or get truncated to `99 : 00`. Wrapping or
 * truncating a larger value would render a SMALLER number than the truth,
 * the one failure direction that actively MISLEADS the viewer into
 * thinking less time remains than actually does. An ugly three-digit
 * display is a strictly better failure mode than a believable, wrong one.
 *
 * @param {*} msRemaining Milliseconds remaining until Enrollment_Token
 *   expiry. Anything that is not a finite number greater than zero is
 *   treated as already expired.
 * @returns {string} `'MM : SS'`, both components zero-padded to at least
 *   two digits, or `COUNTDOWN_EXPIRED`.
 */
export function formatCountdown(msRemaining) {
  if (typeof msRemaining !== 'number' || !Number.isFinite(msRemaining) || msRemaining <= 0) {
    return COUNTDOWN_EXPIRED
  }

  // Round UP so a viewer never sees a premature `00 : 00` before expiry
  // actually occurs -- see the rounding-direction note above.
  const totalSeconds = Math.ceil(msRemaining / 1000)

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  // Zero-padded to a MINIMUM of two digits. `padStart` does not truncate a
  // longer string, which is exactly what preserves a 3+ digit minutes value
  // -- see the no-wrap/no-truncate note above.
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')

  return `${mm} : ${ss}`
}
