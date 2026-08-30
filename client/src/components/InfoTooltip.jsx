import { useId, useState } from 'react'
import { InformationCircleIcon } from '@heroicons/react/24/outline'

/**
 * The one small "(i)" info-icon disclosure used beside a form field's
 * label to explain what the field does, complementing (never replacing)
 * `FieldLockIndicator`'s padlock -- the padlock states whether a field
 * can still change, this states what the field IS for. Built for the
 * Edit Organisation modal's restructure (TeamFormDialog.jsx), where
 * explanatory depth used to be wildly inconsistent: some fields carried
 * three paragraphs of caveats, others carried nothing at all. Every
 * field now gets exactly one of these instead, so the modal doesn't
 * visually lurch between terse and verbose fields.
 *
 * Follows this codebase's established tooltip convention exactly
 * (`DeviceTypeIcon.jsx`, `FormattedDate.jsx`):
 *   - Discloses on pointer hover AND keyboard focus, from a focusable
 *     host (`tabIndex={0}` on the icon itself) -- hover-only is invisible
 *     to a keyboard user.
 *   - Opens SIDEWAYS ONLY (`left-full`/`ml-2` by default, `right-full`/
 *     `mr-2` when `side="left"`), plus `top-1/2 -translate-y-1/2`. Never
 *     `top-full`/`bottom-full` -- a box with one overflow axis `auto` and
 *     the other `visible` clips a vertically-opening tooltip on BOTH
 *     axes (the Tooltip_Clipping_Defect), and this dialog's own
 *     `overflow-y-auto` panel is exactly such a box.
 *   - No native `title` attribute -- that is never disclosed on focus.
 *   - `pointer-events-none` on the tooltip body, so it cannot swallow a
 *     click meant for something beneath it.
 *   - Content computed once (static text), so this uses the CSS
 *     `relative group` + `group-hover:opacity-100`
 *     `group-focus-within:opacity-100` pattern rather than mounting/
 *     unmounting a state-driven popover.
 *   - `aria-describedby` naming a MOUNTED element via `useId()` (React
 *     18, collision-safe across repeated instances of this component on
 *     one page) -- the tooltip text exists nowhere else on the page, so
 *     it is announced via `aria-describedby` rather than `aria-hidden`.
 *
 * @param {object} props
 * @param {string|React.ReactNode} props.text the explanation shown on
 *   disclosure. Usually a plain string; may be a short JSX fragment when
 *   part of the explanation needs emphasis (e.g. `<strong>`).
 * @param {'right'|'left'} [props.side] which side the tooltip opens
 *   toward. Defaults to `'right'` -- the same asymmetry `FormattedDate`
 *   rests on: a tooltip clipped past a container's right edge is at
 *   least reachable by scrolling, one clipped past the left edge is not.
 * @param {string} [props.label] the icon's accessible name. Defaults to
 *   a generic "More information", which is adequate here since the
 *   surrounding field label already names the topic for a screen reader
 *   moving field to field.
 */
export default function InfoTooltip({ text, side = 'right', label = 'More information' }) {
  const tooltipId = useId()
  // Purely cosmetic on top of the CSS-driven `group-hover`/
  // `group-focus-within` disclosure -- not required for the tooltip to
  // show or hide, only used so `aria-describedby` can point at an
  // element that is only ever "live" while actually disclosed to a
  // keyboard user, matching FormattedDate's own disclosure-state
  // convention.
  const [focused, setFocused] = useState(false)

  const openLeft = side === 'left'
  const anchorClass = openLeft ? 'right-full mr-2' : 'left-full ml-2'
  const caretClass = openLeft
    ? 'absolute left-full top-1/2 transform -translate-y-1/2 border-4 border-transparent border-l-gray-900'
    : 'absolute right-full top-1/2 transform -translate-y-1/2 border-4 border-transparent border-r-gray-900'

  return (
    // Bugfix (mobile tap target too small): the icon itself used to be
    // the bare `tabIndex={0}` hover/focus host at a plain h-4 w-4 (16px)
    // -- no padding anywhere, so its actual hit/focus box was 16px
    // square. The `tabIndex`/`aria-*`/`onFocus`/`onBlur` handlers that
    // make this element the disclosure host move to this OUTER span
    // (via `-m-2 p-2`, a negative margin cancelling the padding's own
    // footprint so the surrounding inline text layout is unaffected),
    // rather than to the icon itself, so the hit/focus box grows to
    // ~32px without shifting where the icon visually sits or how the
    // tooltip is anchored (still relative to THIS span, unchanged).
    // `rounded-full` gives the enlarged hit area a visible hover
    // affordance instead of an invisible dead zone around a small icon.
    <span
      className="relative group inline-flex align-text-top ml-1.5 -m-2 p-2 rounded-full cursor-help hover:bg-gray-100 dark:hover:bg-gray-700"
      tabIndex={0}
      role="img"
      aria-label={label}
      aria-describedby={focused ? tooltipId : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <InformationCircleIcon
        className="h-4 w-4 text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300"
        aria-hidden="true"
      />
      <span
        id={tooltipId}
        className={`absolute top-1/2 transform -translate-y-1/2 ${anchorClass} px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-normal w-64 z-10`}
      >
        {text}
        <span className={caretClass}></span>
      </span>
    </span>
  )
}
