import { useEffect, useState } from 'react'
import { ChevronDownIcon, EllipsisHorizontalIcon } from '@heroicons/react/24/outline'

/**
 * A "More options" dropdown button, used by `TeamDetail.jsx`'s header
 * toolbar to move its less-frequently-used actions (Edit, Add Admin, Add
 * Sub-team, Create Channel) behind one button, keeping only the two most
 * common actions (Add Member, Add Team Device) directly visible.
 *
 * Follows the SAME toggle + click-outside-overlay + absolutely-positioned
 * panel pattern `Layout.jsx`'s own user menu already uses
 * (`userMenuOpen` state, a `fixed inset-0` overlay closing the menu on an
 * outside click, an `absolute` panel anchored to the trigger) rather than
 * introducing a second dropdown mechanism into the app. Unlike that menu,
 * this one is a real `role="menu"`/`role="menuitem"` widget with roving
 * `Escape`-to-close and click-outside-to-close, since it is this app's
 * first true action menu (the user menu is simpler: two static actions,
 * no icons).
 *
 * Each item carries its own icon (`FieldLockIndicator`/tab-icon
 * convention already used elsewhere in this app: an icon-led action is
 * always paired with visible text, never icon-only) so the items stay
 * visually distinguishable from one another once they are no longer
 * spread across separate labelled buttons.
 *
 * @param {object} props
 * @param {Array<{
 *   key: string,
 *   label: string,
 *   icon: React.ComponentType<{className?: string}>,
 *   onClick: () => void,
 *   disabled?: boolean,
 *   title?: string
 * }>} props.items
 * @param {string} [props.buttonLabel] defaults to "More options". Always
 *   used as the trigger's accessible name (`aria-label`); only rendered
 *   as VISIBLE text when `iconOnly` is false.
 * @param {string} [props.className] extra classes for the trigger button,
 *   so a caller can match its own visible-button sizing exactly.
 * @param {string} [props.panelClassName] bugfix (mobile "More options"
 *   panel opening off-screen): overrides the panel's anchor classes,
 *   default `'right-0'`. The panel is `w-56` (224px); anchoring its
 *   RIGHT edge to the trigger's right edge (opening leftward) only stays
 *   on-screen when the trigger itself sits near the right edge of its
 *   own container. `TeamDetail.jsx`'s toolbar is left-aligned below
 *   `lg:` and only becomes right-aligned AT `lg:` (`lg:items-end` on its
 *   containing column) -- with the default `right-0`, a trigger sitting
 *   near the LEFT edge of a narrow phone pushed the panel off the left
 *   edge of the screen entirely (left-edge clipping is the one this
 *   codebase's own tooltip convention calls unrecoverable, unlike
 *   right-edge clipping, which is at least reachable by scrolling).
 *   `TeamDetail.jsx` passes `'left-0 lg:left-auto lg:right-0'` -- opening
 *   RIGHTWARD (onto the screen) below `lg:`, matching its own trigger's
 *   left-aligned position there, and only switching to leftward exactly
 *   where its own toolbar does.
 * @param {boolean|'below-sm'} [props.iconOnly] bugfix (mobile header
 *   toolbar): `true` renders `EllipsisHorizontalIcon` in place of the
 *   visible `buttonLabel` text and the trailing `ChevronDownIcon` (a
 *   chevron next to a lone icon reads as decorative clutter, not as an
 *   affordance) on EVERY viewport, including desktop.
 *   `'below-sm'` (bugfix: `true` was a regression -- the mobile fix
 *   should never have dropped the text label at `sm:` and up) instead
 *   renders the icon-only look ONLY below the `sm:` breakpoint, via
 *   Tailwind responsive classes (`hidden sm:inline`/`sm:ml-2`), and
 *   restores the ORIGINAL icon + visible label + chevron layout at `sm:`
 *   and up -- desktop is completely unaffected. `buttonLabel` is always
 *   the button's `aria-label` regardless of which mode is active, so the
 *   accessible name never depends on which text is currently visible;
 *   `title` is only set for the `true` (always-icon-only) case, since
 *   `'below-sm'`'s own visible label at `sm:`+ already serves that
 *   purpose there and a native `title` would needlessly duplicate it.
 *   Lets `TeamDetail.jsx`'s header toolbar fit "Add Member", "Add Team
 *   Device" and this menu on one row on a narrow phone while keeping
 *   full text on desktop, matching the same `'below-sm'`-shaped fix
 *   those two buttons also got.
 */
export default function MoreOptionsMenu({ items, buttonLabel = 'More options', className = '', panelClassName = 'right-0', iconOnly = false }) {
  const [open, setOpen] = useState(false)

  // Escape closes the menu regardless of which element inside it has
  // focus, matching every other dialog/menu in this app's Escape
  // convention (e.g. `UserDevicesModal.jsx`).
  useEffect(() => {
    if (!open) {
      return
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={buttonLabel}
        title={iconOnly === true ? buttonLabel : undefined}
        className={`btn-secondary flex items-center ${
          iconOnly === true
            ? 'justify-center p-2'
            : iconOnly === 'below-sm'
              ? 'justify-center sm:justify-start p-2 sm:px-4 sm:py-2'
              : ''
        } ${className}`}
      >
        {iconOnly === true ? (
          <EllipsisHorizontalIcon className="h-5 w-5" aria-hidden="true" />
        ) : iconOnly === 'below-sm' ? (
          <>
            <EllipsisHorizontalIcon className="h-5 w-5 sm:hidden" aria-hidden="true" />
            <span className="hidden sm:inline">{buttonLabel}</span>
            <ChevronDownIcon className="hidden sm:inline h-4 w-4 sm:ml-2" aria-hidden="true" />
          </>
        ) : (
          <>
            {buttonLabel}
            <ChevronDownIcon className="h-4 w-4 ml-2" aria-hidden="true" />
          </>
        )}
      </button>
      {open && (
        <>
          {/* Click-outside overlay, same convention as Layout.jsx's user
              menu -- a full-viewport, invisible layer beneath the panel
              that closes the menu on any click outside it. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={buttonLabel}
            className={`absolute ${panelClassName} top-full mt-2 w-56 rounded-md bg-white dark:bg-gray-800 shadow-lg ring-1 ring-black ring-opacity-5 z-50 py-1`}
          >
            {items.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => {
                    setOpen(false)
                    item.onClick()
                  }}
                  className={`flex w-full items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 ${
                    item.disabled ? 'opacity-50 cursor-not-allowed' : ''
                  }`}
                >
                  {Icon && <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />}
                  {item.label}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
