import { useEffect, useRef, useState } from 'react'
import { COUNTDOWN_EXPIRED, formatCountdown } from '../utils/tokenCountdown'

/**
 * Enrollment_Countdown (takserver-enrollment Requirement 10.2, design.md
 * "The Token_Countdown is a display, not a data source").
 *
 * Ticks the live `MM : SS` countdown to an Enrollment_Token's expiry every
 * second, then the terminal `COUNTDOWN_EXPIRED` state, matching the
 * Enrollment_Lambda's `generateCountdownScript` -- which drives the SAME
 * two behaviours from one `setInterval`: update the displayed value every
 * second, and clear the interval the moment the count-down passes zero.
 *
 * ## What this component owns, and what it does not
 *
 * This is the ONLY timer takserver-enrollment adds (design.md, Components
 * and Interfaces). It owns exactly one thing: turning an expiry INSTANT
 * into a ticking DURATION display. It does NOT own:
 *
 * - **Re-fetching a token.** Design decision 14: minting a token mints a
 *   live 30-minute Authentik credential, and a component that re-minted on
 *   its own one-second timer would mint an unbounded number of them for an
 *   idle open tab. This component therefore issues no request of any kind,
 *   ever. The only way a fresh token reaches it is a NEW `expiresAt` prop
 *   from a parent that fetched one because a human clicked something. Where
 *   a caller wants a "Generate a new code" affordance at the terminal
 *   state, it supplies `onRegenerate`; this component never calls it except
 *   in response to that button's own click.
 * - **The ATAK deep link's text.** The Enrollment_Lambda's script also
 *   swaps `enroll_link`'s text to "Enrollment link EXPIRED" on the same
 *   tick that blanks the two timer elements -- one `setInterval`, three
 *   DOM writes. This component has no reference to that link (it lives in
 *   `EnrollmentView`, subject to Android_Only_Suppression) and does not
 *   reach into another element's text to imitate that. Instead it exposes
 *   the SAME transition through `onExpired`, fired exactly once per
 *   `expiresAt` value, so whatever renders the deep link can update its
 *   own text off the one state change rather than this component reading
 *   or writing DOM it does not own.
 * - **Ticking a date.** This renders a DURATION -- time remaining until an
 *   instant -- not the instant itself. It shares no module with
 *   `FormattedDate.jsx`, which forbids exactly this shape of `useEffect`
 *   interval for the opposite reason: a ticking timer is a second refresh
 *   mechanism per date, and `FormattedDate` already has one (its
 *   disclosure handlers read the clock at hover/focus time). The
 *   Re_Enrollment_Date rendered beside this countdown is a STATIC value,
 *   computed once server-side and rendered once through
 *   `<FormattedDate precision="date">`; it never passes through here.
 *
 * ## The interval: created once per `expiresAt`, cleared twice over
 *
 * `msRemaining` is never accepted as a prop -- only `expiresAt`, an
 * ISO-8601 instant (or anything `new Date(...)` parses), matching
 * `DeviceEnrollmentService`'s `expiresAt` field on the wire. Every tick
 * recomputes `expiresAt - Date.now()` itself, so the displayed value is
 * always derived from the same instant the server issued, never from a
 * client-held duration that would drift if the tab were suspended and
 * resumed.
 *
 * The interval is cleared in the two places the task requires:
 *
 * 1. **On unmount** -- the `useEffect` cleanup function, standard React.
 * 2. **On reaching the terminal state** -- inside the tick itself, the
 *    moment `remaining <= 0`, rather than waiting for a future unmount.
 *    An idle open tab must stop ticking the instant the token expires, not
 *    merely stop being watched.
 *
 * A THIRD case costs nothing extra: if `expiresAt` is already in the past
 * at mount or at prop-change time (a stale response, meaningful clock
 * skew), no interval is created at all -- there is nothing to count down,
 * so "cleared on reaching the terminal state" is trivially satisfied by
 * never starting one.
 *
 * ## The terminal state is carried in text, never colour alone
 *
 * `formatCountdown` returns the literal string `COUNTDOWN_EXPIRED`
 * (`'EXPIRED'`), rendered as ordinary text alongside the ticking `MM : SS`
 * value -- the same text/colour split `DeviceListRow.jsx` already uses for
 * "Revoked" and "Expires soon". The rapidly-changing `MM : SS` value is
 * deliberately NOT wrapped in an `aria-live` region: a region announcing
 * every second would be unusable noise for a screen-reader user. Instead a
 * separate, visually-hidden `aria-live="polite"` region announces ONCE, on
 * the transition into the terminal state, mirroring how `onExpired` fires
 * once rather than on every tick after expiry.
 *
 * @param {object} props
 * @param {string|number|Date} props.expiresAt The Enrollment_Token's expiry
 *   instant -- an ISO-8601 string on the wire, matching
 *   `DeviceEnrollmentService`'s `expiresAt` field. NOT a countdown string:
 *   this component computes `msRemaining` itself, every tick, from this
 *   value and the clock.
 * @param {() => void} [props.onExpired] Called exactly once per distinct
 *   `expiresAt` value, at the moment the countdown first reaches the
 *   terminal state (including immediately, on mount, if `expiresAt` is
 *   already in the past). Never called again for the same `expiresAt`,
 *   and never called automatically for any reason OTHER than that
 *   transition -- in particular, never as a request to fetch anything.
 * @param {() => void} [props.onRegenerate] When supplied, a "Generate a new
 *   code" button is rendered once the countdown reaches `EXPIRED`, and
 *   clicking it calls this and nothing else. This component never invokes
 *   it itself; regeneration is bounded by the number of times a human
 *   clicks, per design decision 14. Omit to render the terminal state with
 *   no affordance -- some callers (for example `EnrollmentView`, task 9.5)
 *   may prefer to render their own regenerate control elsewhere on the
 *   page instead of delegating it to this component.
 * @param {string} [props.regenerateLabel] Overrides the regenerate
 *   button's text. Defaults to `'Generate a new code'`.
 */
export default function EnrollmentCountdown({
  expiresAt,
  onExpired,
  onRegenerate,
  regenerateLabel = 'Generate a new code',
}) {
  const [msRemaining, setMsRemaining] = useState(() => computeMsRemaining(expiresAt))

  // Tracks which `expiresAt` value `onExpired` has already fired for, so a
  // re-render while still expired never re-invokes it, while a genuinely
  // NEW `expiresAt` (a freshly minted token, after a "Generate a new code"
  // click) is free to fire it again once THAT one lapses in turn.
  const expiredNotifiedForRef = useRef(null)

  useEffect(() => {
    const initialRemaining = computeMsRemaining(expiresAt)
    setMsRemaining(initialRemaining)

    if (initialRemaining <= 0) {
      // Already expired -- nothing to count down, so no interval is ever
      // created. See the class doc's "third case" above.
      return undefined
    }

    const intervalId = setInterval(() => {
      const remaining = computeMsRemaining(expiresAt)
      setMsRemaining(remaining)
      if (remaining <= 0) {
        // Reaching the terminal state clears the interval ITSELF, rather
        // than waiting for a later unmount.
        clearInterval(intervalId)
      }
    }, 1000)

    return () => clearInterval(intervalId)
  }, [expiresAt])

  const display = formatCountdown(msRemaining)
  const isExpired = display === COUNTDOWN_EXPIRED

  useEffect(() => {
    if (isExpired && onExpired && expiredNotifiedForRef.current !== expiresAt) {
      expiredNotifiedForRef.current = expiresAt
      onExpired()
    }
  }, [isExpired, onExpired, expiresAt])

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <span
        className={`font-mono text-lg tabular-nums ${
          isExpired ? 'font-bold text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'
        }`}
      >
        {display}
      </span>
      {/* Announced ONCE, on the transition into the terminal state -- a live
          region wrapping the ticking value above would re-announce every
          second, which is unusable noise for a screen-reader user. The
          colour on the span above is a supplement, never the carrier: the
          text 'EXPIRED' is what states the state, matching the "Revoked" /
          "Expires soon" precedent in `DeviceListRow.jsx`. */}
      <span role="status" aria-live="polite" className="sr-only">
        {isExpired ? 'Enrollment code expired.' : ''}
      </span>
      {/* Bugfix (mobile tap target too small): py-2 (was py-1.5) --
          text-sm's ~20px line-height plus the old 12px vertical padding
          gave a ~32px-tall button; py-2 (16px) brings it to a real ~36px
          tap target. */}
      {isExpired && onRegenerate && (
        <button type="button" onClick={onRegenerate} className="btn-secondary px-3 py-2 text-sm">
          {regenerateLabel}
        </button>
      )}
    </div>
  )
}

/**
 * Milliseconds remaining until `expiresAt`, computed fresh from the clock.
 *
 * Never returns a value that could be mistaken for "still counting" when it
 * is not: an unparseable or absent `expiresAt` produces `NaN - Date.now()`,
 * which is `NaN`, and `formatCountdown` already treats a non-finite input
 * as `COUNTDOWN_EXPIRED` -- so no extra guard is needed here for this
 * function to feed it safely.
 *
 * @param {*} expiresAt Anything `new Date(...)` accepts.
 * @returns {number} Milliseconds remaining, possibly negative or `NaN`.
 */
function computeMsRemaining(expiresAt) {
  return new Date(expiresAt).getTime() - Date.now()
}
