import { GlobeAltIcon, QuestionMarkCircleIcon } from '@heroicons/react/24/outline'

/**
 * Requirements 15.6, 15.7: the ONE component that turns a Device's
 * `clientType` into a glyph, an accessible name, and a tooltip naming the
 * platform. The Dashboard "My Devices" card and the user-details modal both
 * render this, so the two surfaces cannot drift apart (Requirement 16.6).
 *
 * This component does NO classification. `clientType` arrives already derived
 * server-side by `server/utils/clientType.js` as a pure function of the
 * Client_Uid (Requirement 15.1), and re-deriving it here from the UID would
 * create exactly the second definition Requirement 15.2 exists to prevent.
 * All this file knows is how to draw each of the five values.
 *
 * Glyphs are committed inline SVG in this one file, with no new client
 * dependency (Requirement 15.7). `@heroicons/react` is already a dependency,
 * so CloudTAK borrows its `GlobeAltIcon` (a browser session, not a device)
 * and Unknown its `QuestionMarkCircleIcon`; Android, iOS and Windows get
 * hand-committed glyphs below, drawn in the same 24x24 / 1.5-stroke style so
 * they sit beside the heroicons without looking imported from elsewhere.
 */

/**
 * The Client_Type value set, mirroring `CLIENT_TYPES` in
 * `server/utils/clientType.js`. Duplicated as string values only -- the
 * classifier itself is server-side and is not reimplemented here -- so that
 * callers and tests can reference the names rather than retyping literals.
 *
 * @type {{ CLOUDTAK: 'cloudtak', ANDROID: 'android', IOS: 'ios', WINDOWS: 'windows', UNKNOWN: 'unknown' }}
 */
export const CLIENT_TYPES = Object.freeze({
  CLOUDTAK: 'cloudtak',
  ANDROID: 'android',
  IOS: 'ios',
  WINDOWS: 'windows',
  UNKNOWN: 'unknown',
})

/**
 * Requirement 15.6: the platform label for each Client_Type. This is both the
 * accessible name and the tooltip text, so a screen-reader user and a mouse
 * user are told the same thing in the same words.
 *
 * `unknown` gets its own honest wording rather than an empty string or a
 * guessed platform, matching Requirement 15.5's treatment of Unknown as a
 * first-class outcome.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const DEVICE_TYPE_LABELS = Object.freeze({
  [CLIENT_TYPES.CLOUDTAK]: 'CloudTAK',
  [CLIENT_TYPES.ANDROID]: 'Android / ATAK',
  [CLIENT_TYPES.IOS]: 'iOS / iTAK',
  [CLIENT_TYPES.WINDOWS]: 'Windows / WinTAK',
  [CLIENT_TYPES.UNKNOWN]: 'Unknown client type',
})

/**
 * Narrows any input to one of the five Client_Types.
 *
 * Total, like the server classifier it mirrors: an unrecognised value, a
 * missing field, `null`, or a non-string all resolve to `unknown` and render
 * the Unknown glyph. A device list must not lose a row -- or throw -- because
 * one Client_Uid was odd, and an older cached response with no `clientType`
 * at all still renders something truthful.
 *
 * `hasOwnProperty` rather than a plain lookup so inherited keys (`'toString'`,
 * `'constructor'`) cannot be mistaken for labels.
 *
 * Exported for direct unit testing, matching this project's convention of
 * testing extracted pure logic alongside rendering (see
 * `RevokeDeviceDialog.jsx`).
 *
 * @param {string|null|undefined|*} clientType the wire value.
 * @returns {'cloudtak'|'android'|'ios'|'windows'|'unknown'}
 */
export function resolveClientType(clientType) {
  if (typeof clientType === 'string' && Object.prototype.hasOwnProperty.call(DEVICE_TYPE_LABELS, clientType)) {
    return clientType
  }
  return CLIENT_TYPES.UNKNOWN
}

/**
 * The platform label for a Client_Type, falling back to the Unknown label.
 *
 * @param {string|null|undefined|*} clientType the wire value.
 * @returns {string} a non-empty label, always.
 */
export function labelForClientType(clientType) {
  return DEVICE_TYPE_LABELS[resolveClientType(clientType)]
}

/**
 * Android / ATAK: a robot head. Deliberately not another phone outline -- iOS
 * is the phone here, and two phone silhouettes would be told apart by nothing
 * but a caption.
 */
function AndroidGlyph({ className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden="true"
    >
      <path strokeLinecap="round" d="M8 4.5 9.75 7.5M16 4.5 14.25 7.5" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5 12a7 7 0 0 1 14 0v5.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.5V12Z"
      />
      <circle cx="9.5" cy="11.5" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="11.5" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** iOS / iTAK: a phone body with an earpiece slot and a home indicator. */
function IosGlyph({ className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.25 3h7.5a1.5 1.5 0 0 1 1.5 1.5v15a1.5 1.5 0 0 1-1.5 1.5h-7.5a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 8.25 3Z"
      />
      <path strokeLinecap="round" d="M10.5 5.25h3M10.5 18.75h3" />
    </svg>
  )
}

/** Windows / WinTAK: a four-pane window. */
function WindowsGlyph({ className }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5.25 4.5h13.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H5.25a.75.75 0 0 1-.75-.75V5.25a.75.75 0 0 1 .75-.75Z"
      />
      <path strokeLinecap="round" d="M12 4.5v15M4.5 12h15" />
    </svg>
  )
}

/**
 * Client_Type to glyph. Every key of `DEVICE_TYPE_LABELS` has an entry here,
 * which is what makes `resolveClientType` enough to guarantee a glyph.
 */
const GLYPHS = Object.freeze({
  [CLIENT_TYPES.CLOUDTAK]: GlobeAltIcon,
  [CLIENT_TYPES.ANDROID]: AndroidGlyph,
  [CLIENT_TYPES.IOS]: IosGlyph,
  [CLIENT_TYPES.WINDOWS]: WindowsGlyph,
  [CLIENT_TYPES.UNKNOWN]: QuestionMarkCircleIcon,
})

/**
 * Requirements 15.6, 15.7, 16.3, 16.4: the Device_Type_Icon.
 *
 * Accessibility, which is the substance of this component rather than a
 * finish on it:
 *
 * - The wrapper carries `role="img"` and `aria-label={label}`, so a screen
 *   reader announces the platform instead of skipping past an unlabelled
 *   graphic (Requirement 15.6). `role="img"` also hides the tooltip's own
 *   text from assistive tech, so the platform is announced once, not twice.
 * - The tooltip reuses the `relative group` + `opacity-0
 *   group-hover:opacity-100` pattern already in `Dashboard.jsx` rather than
 *   introducing a tooltip mechanism (Requirement 16.4), extended with
 *   `group-focus-within:opacity-100` and `tabIndex={0}` so a keyboard user
 *   sees the same disclosure a mouse user does (Requirement 16.3). A native
 *   `title` would be simpler and is deliberately not used: it never appears
 *   on keyboard focus, which is the whole of Requirement 16.3.
 * - The tooltip opens sideways rather than upward-centred so that a scrolling
 *   ancestor cannot clip it; see the comment at the markup below.
 * - The glyph is a neutral gray in both themes and the platform is carried by
 *   shape plus text, never by color alone.
 *
 * @param {object} props
 * @param {string|null|undefined} props.clientType the Device's `clientType`
 *   as returned by the device endpoints. Anything unrecognised or missing
 *   renders the Unknown glyph.
 * @param {string} [props.className] sizing/color classes for the glyph
 *   itself, so a denser table can shrink it without wrapping it in a div.
 */
export default function DeviceTypeIcon({ clientType, className = 'h-5 w-5' }) {
  const resolved = resolveClientType(clientType)
  const label = DEVICE_TYPE_LABELS[resolved]
  const Glyph = GLYPHS[resolved]

  return (
    <span
      className="relative group inline-flex"
      role="img"
      aria-label={label}
      tabIndex={0}
      data-client-type={resolved}
    >
      <Glyph className={`${className} text-gray-500 dark:text-gray-400 cursor-help`} />
      {/* Anchored to the icon's RIGHT edge and centred on its row, not centred
          above it. Both device tables scroll horizontally
          (`overflow-x-auto`), and per CSS a box with one axis `auto` and the
          other `visible` clips on BOTH axes -- so anything the tooltip pushes
          past the table's edge is clipped, and anything past its LEFT edge is
          also unreachable by scrolling. Type is the first column
          (`DEVICE_LIST_COLUMNS`), so the old `left-1/2 -translate-x-1/2`
          centring put half a ~130px tooltip outside the table on the left:
          the reported "cut off, behind a frame".

          Opening rightward from `left-full` keeps the tooltip inside the
          table's content box horizontally, and `top-1/2 -translate-y-1/2`
          keeps its ~32px height inside the row's own ~52px band vertically.
          Staying within the table box by construction is what makes this
          robust: it does not depend on which ancestor happens to scroll, so
          the dialog panel's `overflow-y-auto` in `UserDevicesModal.jsx`
          cannot clip it either, and horizontal scrolling on a narrow
          viewport is left working. */}
      <span className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
        {label}
        <span className="absolute right-full top-1/2 transform -translate-y-1/2 border-4 border-transparent border-r-gray-900"></span>
      </span>
    </span>
  )
}
