import { useId, useState } from 'react'
import {
  formatDate,
  formatDateTime,
  getDisplayTimezone,
  hasRenderableDate,
  zonedDayNumber,
} from '../utils/dateFormat'
import { NO_PHRASE, relativeTime } from '../utils/relativeTime'

/**
 * Formatted_Date (Requirements 2, 3, 4): the ONE component through which
 * every Date_Render_Position renders its value, and therefore the ONE place
 * the Date_Tooltip is implemented (Criterion 2.1).
 *
 * It WRAPS the Date_Format_Helpers rather than replacing them: `formatDate`
 * and `formatDateTime` keep producing the visible string, character for
 * character, and this component adds a disclosure around it carrying the two
 * facts a bare `yyyy-mm-dd` cannot (Criteria 2.3, 2.8) -- the Relative_Time
 * phrase, then the Resolved_Display_Timezone.
 *
 * ## The application acquires a third tooltip, not a second tooltip LOOK
 *
 * `DeviceTypeIcon.jsx` and `DeviceListRow.jsx` already carry tooltips, and
 * this one is deliberately identical to them in every visible respect --
 * same palette, same padding, same radius, same caret, same
 * Sideways_Tooltip_Placement, same 200 ms opacity transition class
 * (Criterion 3.6). It diverges from them in exactly one respect, the
 * MECHANISM: those two are pure CSS (`opacity-0 group-hover:opacity-100`),
 * whose content is fixed when the row renders. That is fine for their
 * static labels and forbidden here, because a Relative_Time phrase computed
 * at render time is wrong by the age of the render (Criteria 2.5, 3.6). So
 * the disclosure is state-driven.
 *
 * The Tooltip_Clipping_Defect that produced Sideways_Tooltip_Placement is
 * recorded in full in `DeviceTypeIcon.jsx`'s markup comment -- both device
 * tables carry `overflow-x-auto`, and a box with one overflow axis `auto`
 * and the other `visible` clips on BOTH axes. That comment is why Criterion
 * 3.4 exists; it is cited here rather than repeated, and the placement it
 * arrived at is NOT to be "tidied" back to a vertically-opening tooltip.
 *
 * ## No timer, no interval, no subscription (Criterion 2.6)
 *
 * The clock is read inside the handlers that OPEN the tooltip, and only
 * there, so every entry transition -- pointer and keyboard alike -- gets a
 * phrase computed at that moment (Criterion 2.5). A tooltip held open for
 * ten minutes does go stale for those ten minutes; that is what Criterion
 * 2.5's "recompute on each subsequent disclosure" accepts, and the
 * alternative is the ticking timer Criterion 2.6 forbids. It also means
 * unmounting while disclosed needs no cleanup, because there is nothing to
 * clean up.
 *
 * ## What is NOT here, and why
 *
 * - **No `role`, on either node** (Criterion 3.10). A focusable `<span>`
 *   with no role announces as text carrying a description, which is what it
 *   is; `role="tooltip"` on the popover adds nothing `aria-describedby` has
 *   not already established, and any control role would make a date cell
 *   announce as a button.
 * - **No `title`** standing in for the description (Criterion 3.3): screen
 *   reader support for it is inconsistent and it never appears on keyboard
 *   focus, which is the whole of Criterion 3.1.
 * - **No `group` class.** Nothing consumes it now that the disclosure is
 *   state-driven, and leaving it would imply a CSS-driven disclosure this
 *   component does not have.
 * - **No ISO-8601 instant in the tooltip** (Criterion 2.11): a second,
 *   differently-zoned rendering of the same moment beside the first is the
 *   confusion the Display_Timezone work exists to remove.
 * - **No colour-carried information** (Criterion 3.9). The tooltip's
 *   content is text.
 */

/**
 * Which Date_Format_Helper a caller's value is rendered through, and
 * therefore which anchoring rule its Relative_Time follows (Criteria 4.1,
 * 4.5).
 *
 * Frozen and exported so callers and tests share values instead of
 * retyping literals, following `CLIENT_TYPES` in `DeviceTypeIcon.jsx` and
 * `EXPIRY_STATES` in `expiryWarning.js`.
 *
 * @type {{ DATE: 'date', DATE_TIME: 'datetime' }}
 */
export const DATE_PRECISION = Object.freeze({
  DATE: 'date',
  DATE_TIME: 'datetime',
})

/**
 * Which edge of its host the Date_Tooltip opens from (Criteria 3.4, 3.5).
 *
 * `RIGHT` is the default because the two failure modes are not symmetric:
 * a tooltip pushed past a scroll container's right edge is clipped but
 * reachable by scrolling, while one pushed past the left edge is clipped
 * AND unreachable -- the reasoning `DeviceListRow.jsx` already records.
 * Positions in the trailing half of a horizontally scrolling table pass
 * `LEFT`.
 *
 * @type {{ RIGHT: 'right', LEFT: 'left' }}
 */
export const TOOLTIP_SIDES = Object.freeze({
  RIGHT: 'right',
  LEFT: 'left',
})

/**
 * The explicit separator between the Date_Tooltip's two facts (Criterion
 * 2.10).
 *
 * A comma, and it is inside the string rather than in the layout on
 * purpose -- the same reasoning `DeviceListRow.jsx` records for the space
 * beside its Connected_Label. Assistive technology reading the tooltip as
 * one string would otherwise run the phrase into the zone name. A middot
 * was rejected because it is announced inconsistently (sometimes "dot",
 * sometimes silently, depending on the reader and its punctuation level),
 * and prose (`shown in`) reads as a third element in a tooltip Criterion
 * 2.8 fixes at two facts.
 *
 * Exported so tests do not retype it.
 *
 * @type {string}
 */
export const TOOLTIP_SEPARATOR = ', '

/**
 * Scales a day ordinal from `zonedDayNumber` into milliseconds so the
 * classifier can be fed two Midnight_Anchors instead of two instants.
 * Never used to add or subtract a "day" from a real instant, which is
 * where DST lives.
 */
const MS_PER_DAY = 86_400_000

/**
 * An arbitrary but always-usable reference instant, used ONLY to ask the
 * classifier "is this value an instant you accept?" at render time, never
 * to produce a phrase anybody sees.
 *
 * Outcome 2 below has to be decided when the row renders -- whether to
 * render a disclosure host at all (Criterion 2.7) -- while the phrase
 * itself must not be computed until disclosure (Criterion 2.5). The two
 * questions are separable because the classifier's acceptance is by TYPE
 * and independent of `now`: `relativeTime` answers No_Phrase for a value
 * it cannot place regardless of the reference instant, and a finite value
 * against a finite reference always yields a phrase. So probing with a
 * fixed reference tells us whether a phrase will exist without telling us
 * what it says, and no clock is read.
 *
 * `hasRenderableDate` is NOT sufficient for this: `formatDate` accepts
 * anything `new Date(value)` parses, which includes shapes the classifier
 * rejects by type on purpose (a boolean, an array like `[2024]`). Those
 * are exactly outcome 2 -- a rendered string with nothing to say about it.
 */
const PHRASE_PROBE_NOW = 0

/**
 * Everything after the placement, byte for byte what both existing
 * tooltips carry (Criterion 3.6) -- with `opacity-100` where they hold
 * `opacity-0 group-hover:opacity-100`, because this one is only in the DOM
 * when it is meant to be seen. `transition-opacity duration-200` is kept
 * even though there is nothing to transition from, so the SHOWN state is
 * indistinguishable from the other two.
 */
const TOOLTIP_BODY_CLASSES =
  'px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10'

/**
 * Sideways_Tooltip_Placement (Criteria 3.4, 3.5): the anchor edge and the
 * gap for each side. `left-full`/`ml-2` opens rightward, `right-full`/
 * `mr-2` is the mirror `DeviceListRow.jsx` already uses for its trailing
 * column. Nothing here opens upward or downward -- no `top-full`, no
 * `bottom-full` -- and `top-1/2 -translate-y-1/2` keeps the tooltip's
 * height inside its own row's band.
 */
const TOOLTIP_PLACEMENT = Object.freeze({
  [TOOLTIP_SIDES.RIGHT]: { anchor: 'left-full', gap: 'ml-2' },
  [TOOLTIP_SIDES.LEFT]: { anchor: 'right-full', gap: 'mr-2' },
})

/** The caret, pointing back at the host from the tooltip's near edge. */
const CARET_FOR_RIGHT_TOOLTIP =
  'absolute right-full top-1/2 transform -translate-y-1/2 border-4 border-transparent border-r-gray-900'

/** Its mirror. */
const CARET_FOR_LEFT_TOOLTIP =
  'absolute left-full top-1/2 transform -translate-y-1/2 border-4 border-transparent border-l-gray-900'

/**
 * The Date_Tooltip's text: the Relative_Time phrase, then the
 * Resolved_Display_Timezone, in that order (Criterion 2.8). The phrase
 * leads because it is what the hover was for; the zone qualifies it.
 *
 * WHERE the resolved zone is the empty string -- `getDisplayTimezone()`'s
 * documented outcome when not even `UTC` constructs -- the phrase is
 * rendered ALONE, with no separator and no empty second fact. Criterion
 * 2.8's "exactly two facts" is read as two facts when there are two: a
 * tooltip reading `3 minutes ago, ` would be a rendering defect standing
 * in for a missing one, and the phrase is the half that survives.
 *
 * Pure, and exported for the tests rather than for the call sites.
 *
 * @param {string} phrase A Relative_Time phrase.
 * @param {string} zone The Resolved_Display_Timezone, possibly empty.
 * @returns {string} The tooltip text.
 */
export function buildTooltipText(phrase, zone) {
  if (typeof phrase !== 'string' || phrase === '') {
    return ''
  }
  if (typeof zone !== 'string' || zone.trim() === '') {
    return phrase
  }
  return `${phrase}${TOOLTIP_SEPARATOR}${zone}`
}

/**
 * Whether `precision` selects the date-only helper. Anything absent or
 * unrecognised is DATE_TIME, deliberately: that is the strictly more
 * informative rendering, so a caller who meant date-only gets a stray
 * ` HH:MM` on screen and finds out, where the opposite default would
 * silently drop a time nobody noticed was gone.
 *
 * @param {*} precision
 * @returns {boolean}
 */
function isDateOnly(precision) {
  return precision === DATE_PRECISION.DATE
}

/**
 * The Relative_Time phrase for a date-only value, computed from the
 * Midnight_Anchor at BOTH ends (Criteria 4.1, 4.2, 4.3).
 *
 * `formatDate` renders a calendar day and discards the time of day, so a
 * phrase computed from the underlying instant would describe information
 * the cell does not show -- two cells showing the same day would carry
 * different phrases. Both ends are therefore reduced to a day ordinal in
 * the Resolved_Display_Timezone (never the browser's -- Criterion 4.6,
 * which `zonedDayNumber` owns) and the classifier is fed the two ordinals
 * scaled to milliseconds rather than the raw instants. The distance is
 * then an exact multiple of a day and the sign is unchanged.
 *
 * Criterion 4.4 falls out with nothing written for it: the same day means
 * distance zero, distance zero is the first rung, and the first rung is
 * `just now`.
 *
 * The two explicit null checks are load-bearing -- `null * MS_PER_DAY` is
 * `0`, so letting a missing ordinal through would silently claim today.
 *
 * @param {*} value
 * @param {number} nowMs The clock read at disclosure.
 * @returns {string|null} A phrase, or `NO_PHRASE`.
 */
function dateOnlyPhrase(value, nowMs) {
  const valueDay = zonedDayNumber(value)
  if (valueDay === null) {
    return NO_PHRASE
  }
  const nowDay = zonedDayNumber(nowMs)
  if (nowDay === null) {
    return NO_PHRASE
  }
  return relativeTime(valueDay * MS_PER_DAY, nowDay * MS_PER_DAY)
}

/**
 * The Relative_Time phrase for a date-and-time value: the value's own
 * instant against an UNANCHORED `now` (Criterion 4.5). The time of day is
 * visible in the cell, so the finer rungs of the ladder are meaningful for
 * it and anchoring would throw away what the cell shows.
 *
 * @param {*} value
 * @param {number} nowMs The clock read at disclosure.
 * @returns {string|null} A phrase, or `NO_PHRASE`.
 */
function dateTimePhrase(value, nowMs) {
  return relativeTime(value, nowMs)
}

/**
 * Whether a phrase will exist for this value, decided WITHOUT reading the
 * clock, so the render can choose between outcome 2 and outcome 3 while
 * the phrase itself waits for disclosure. See `PHRASE_PROBE_NOW`.
 *
 * @param {*} value
 * @param {*} precision
 * @returns {boolean}
 */
function hasPhrase(value, precision) {
  if (isDateOnly(precision)) {
    // The only route by which a renderable value has no phrase: an instant
    // whose zoned components do not read back as a calendar day.
    return zonedDayNumber(value) !== null
  }
  return relativeTime(value, PHRASE_PROBE_NOW) !== NO_PHRASE
}

/**
 * The Date_Tooltip text for this value, computed from a clock read NOW
 * (Disclosure_Time_Computation, Criterion 2.5). Called from the handlers
 * that open the disclosure and from nowhere else.
 *
 * @param {*} value
 * @param {*} precision
 * @returns {string} The tooltip text, or `''` when there is nothing to say.
 */
function computeTooltipText(value, precision) {
  const nowMs = Date.now()
  const phrase = isDateOnly(precision)
    ? dateOnlyPhrase(value, nowMs)
    : dateTimePhrase(value, nowMs)
  if (phrase === NO_PHRASE) {
    return ''
  }
  // The zone comes from `getDisplayTimezone()` -- the zone dates are
  // REALLY rendered in -- and never from the configured value, so a
  // mistyped `DISPLAY_TIMEZONE` names the zone in force rather than the
  // one that was asked for (Criterion 2.9).
  return buildTooltipText(phrase, getDisplayTimezone())
}

/**
 * Renders one date or timestamp, and the Date_Tooltip that gives it
 * context on hover AND on keyboard focus.
 *
 * There are three outcomes, and the distinction between the second and the
 * third IS Criterion 2.7:
 *
 * 1. The value is not renderable → the caller's `fallback` as plain text.
 *    No host, no `tabIndex`, no `aria-describedby`, no tooltip. A value the
 *    Date_Format_Helpers could not render is a value the tooltip has
 *    nothing to say about, and the resting DOM stays exactly what that
 *    position renders today -- including `AuditLogs`' raw-value fallback,
 *    passed straight through, preserving today's behaviour and today's
 *    failure mode for a non-renderable React child.
 * 2. Renderable, but there is no phrase → the formatted string as plain
 *    text, again with no host and no tooltip.
 * 3. Renderable with a phrase → the disclosure.
 *
 * Outcomes 1 and 2 render bare text with no wrapper element, which is the
 * strongest reading of Criterion 2.3: the DOM is character for character
 * and element for element what the position rendered before this component
 * existed. `className` therefore positions the disclosure wrapper only;
 * there is no element to hang it on when there is nothing to disclose, and
 * no adopting call site passes one.
 *
 * @param {object} props
 * @param {string|number|Date|null|undefined|*} props.value Anything the
 *   Date_Format_Helpers accept. Anything they cannot render takes outcome 1.
 * @param {*} [props.fallback] What to render instead of a date, preserved
 *   from the adopting caller unchanged (Criterion 2.4): `'-'`, `'Never'`,
 *   `'Unknown'`, `'never seen'`, or `AuditLogs`' raw value. Defaults to the
 *   helpers' own empty string (Criterion 2.13).
 * @param {'date'|'datetime'} props.precision REQUIRED, with no default. See
 *   `isDateOnly` for why an unrecognised value is treated as `datetime`.
 * @param {'right'|'left'} [props.side] Which edge the tooltip opens from.
 * @param {string} [props.className] Extra classes for the disclosure
 *   wrapper.
 */
export default function FormattedDate({
  value,
  fallback = '',
  precision,
  side = TOOLTIP_SIDES.RIGHT,
  className = '',
}) {
  // Called unconditionally, before any early return, because it is a hook.
  // React 18's `useId` rather than a module counter, so two dates in one
  // row cannot collide.
  const tooltipId = useId()

  // The disclosure state machine: two booleans and a string. `disclosed`
  // is `hovered || focused`, so moving the pointer away from a FOCUSED
  // date does not dismiss a tooltip the keyboard is still asking for.
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [tooltipText, setTooltipText] = useState('')

  // Outcome 1 (Criteria 2.4, 2.7).
  if (!hasRenderableDate(value)) {
    return fallback
  }

  const formattedText = isDateOnly(precision)
    ? formatDate(value, fallback)
    : formatDateTime(value, fallback)

  // Outcome 2 (Criterion 2.7): the string, and nothing around it.
  if (!hasPhrase(value, precision)) {
    return formattedText
  }

  // Outcome 3. `tooltipText` is checked as well as the two booleans so an
  // `aria-describedby` can never point at an element that is not in the
  // document (Criterion 3.7) -- belt and braces, since `hasPhrase` has
  // already established there is something to say.
  const disclosed = (hovered || focused) && tooltipText !== ''

  // An unrecognised `side` opens rightward, the same asymmetry the default
  // rests on: clipped-but-scrollable beats clipped-and-unreachable.
  const openLeft = side === TOOLTIP_SIDES.LEFT
  const placement = openLeft
    ? TOOLTIP_PLACEMENT[TOOLTIP_SIDES.LEFT]
    : TOOLTIP_PLACEMENT[TOOLTIP_SIDES.RIGHT]

  const discloseNow = () => {
    // The clock read. Every ENTRY transition passes through here --
    // pointer and keyboard alike -- so the phrase is recomputed on each
    // disclosure and never carried over from the render (Criterion 2.5).
    setTooltipText(computeTooltipText(value, precision))
  }

  const handleKeyDown = (event) => {
    // Escape dismisses. An ADDITION BEYOND THE REQUIREMENTS, flagged for
    // review: it costs one handler and no pixels, and moves this
    // disclosure closer to WCAG 2.1 SC 1.4.13's dismissable clause than
    // the two tooltips it otherwise copies. The related shortfall it does
    // NOT fix is 1.4.13's hoverable clause, which `pointer-events-none`
    // forecloses -- see the tooltip markup below.
    if (event.key === 'Escape') {
      setHovered(false)
      setFocused(false)
    }
  }

  return (
    <span className={['relative inline-flex', className].filter(Boolean).join(' ')}>
      {/* The focusable node is the DATE TEXT, not the outer wrapper. A
          focusable span takes its accessible name from its contents, so a
          wrapper enclosing both the date and the tooltip would name itself
          with both and then describe itself with one of them again -- the
          double announcement `DeviceTypeIcon` and `DeviceListRow` each
          avoid by a different trick. Keeping the tooltip a SIBLING of the
          described element means the name is the date and the description
          is the context, once each.

          `tabIndex={0}` is what makes the context available to a keyboard
          user at all (Criterion 3.1), and it is not free: a full audit-log
          page gains 50 tab stops. That price is argued in design.md
          Decision 5, with one mitigation that comes free from Criterion
          2.7 -- a value with nothing to say has no host and therefore no
          tab stop, so absent and unparseable dates cost nothing. */}
      <span
        tabIndex={0}
        className="cursor-help"
        aria-describedby={disclosed ? tooltipId : undefined}
        onPointerEnter={() => {
          discloseNow()
          setHovered(true)
        }}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => {
          discloseNow()
          setFocused(true)
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
      >
        {formattedText}
      </span>
      {/* MOUNTED ONLY WHILE DISCLOSED, and deliberately not the
          always-mounted-with-toggled-opacity shape both existing tooltips
          use. Two things go wrong if this tooltip is in the resting DOM.
          `Dashboard.test.jsx` and `UserDevicesModal.test.jsx` assert
          device-cell text with `toBe` through a helper that strips only
          `[aria-hidden="true"]` subtrees -- and this tooltip must NOT be
          `aria-hidden`, because Criterion 3.2 requires it announced -- so
          an always-mounted tooltip breaks those exact-text assertions. It
          would also let a screen reader reach a phrase computed at render
          time, which is what Criterion 2.5 forbids. Mounting on disclosure
          makes the resting DOM identical to today's character for
          character and makes a stale phrase structurally impossible. The
          cost is the 200 ms fade-in, which is a real loss and is accepted;
          the `transition-opacity duration-200` classes stay so the SHOWN
          state is indistinguishable from the other two tooltips.

          Placement is Sideways_Tooltip_Placement and is NOT to be tidied
          into a vertically-opening tooltip: see `DeviceTypeIcon.jsx`'s
          markup comment for the Tooltip_Clipping_Defect that produced it
          (both device tables carry `overflow-x-auto`, and one axis `auto`
          with the other `visible` clips on BOTH axes).

          `pointer-events-none` is retained, and not only for visual
          parity: folder rows are `cursor-pointer` with an `onClick` and six
          of the ten positions sit in table rows, so a tooltip accepting
          pointer events would swallow a click on the row underneath, and
          with `pointerleave`-driven state it would flicker -- pointer
          enters tooltip, leaves host, tooltip unmounts, pointer returns to
          host. The cost is SC 1.4.13's hoverable clause, a shortfall this
          codebase already ships on both existing tooltips and one that
          cannot be fixed here without changing all three together. */}
      {disclosed && (
        <span
          id={tooltipId}
          className={`absolute ${placement.anchor} top-1/2 transform -translate-y-1/2 ${placement.gap} ${TOOLTIP_BODY_CLASSES}`}
        >
          {tooltipText}
          <span
            aria-hidden="true"
            className={openLeft ? CARET_FOR_LEFT_TOOLTIP : CARET_FOR_RIGHT_TOOLTIP}
          />
        </span>
      )}
    </span>
  )
}
