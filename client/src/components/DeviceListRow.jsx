import { TrashIcon } from '@heroicons/react/24/outline'
import DeviceTypeIcon from './DeviceTypeIcon'
import FormattedDate, { DATE_PRECISION, TOOLTIP_SIDES } from './FormattedDate'
import { hasRenderableDate } from '../utils/dateFormat'
import { EXPIRY_STATES, classifyExpiry, getExpiryWarningDays } from '../utils/expiryWarning'

/**
 * Requirement 16.6: the ONE definition of a device-list row.
 *
 * The Dashboard "My Devices" card (`pages/Dashboard.jsx`) and the
 * user-details modal (`components/UserDevicesModal.jsx`) render the same list
 * of the same Devices, so every cell of that row -- the Device_Type_Icon, the
 * UID with its "Revoked" badge, the dates, the "never seen" fallback, the
 * "Connected" label (Requirement 20.9), the two expiry markers (Requirements
 * 21.3, 21.5, 21.8), and the icon-only Revoke action -- is drawn here and
 * nowhere else. Two copies of
 * this JSX that happen to match today is exactly what Requirement 16.6
 * forbids: the next change to one surface would silently not reach the other.
 *
 * The header row lives here too (`DeviceListHeader`). It has to: adding or
 * reordering a column in the body without matching the `<thead>` produces a
 * table whose captions no longer describe its cells, and the only way to make
 * that impossible is to keep both halves in one file.
 *
 * The two surfaces differ in ONE respect, cell padding -- the Dashboard card
 * is full-width and roomy, the modal table sits inside a dialog -- which is a
 * `compact` boolean rather than a class-name prop so both spacings are
 * literal strings in this file and Tailwind can see them.
 *
 * Its three dates -- Issued, Expires and Last Seen, the last reached from two
 * branches -- render through the shared `FormattedDate` component
 * (date-tooltips-and-folder-contrast Criterion 2.1), so each carries the
 * Date_Tooltip on hover and on keyboard focus. The rendered STRINGS are
 * unchanged character for character (Criterion 2.3): this row no longer calls
 * `formatDate`/`formatDateTime` itself, and `hasRenderableDate` is imported in
 * their place purely as the Last Seen cell's layout predicate.
 */

/**
 * Requirement 5.3 / 6.5: what a null `lastSeenAt` renders as. Last_Seen is
 * TAK Server's OWN reported `ClientEndpoint.lastEventTime` (Requirement
 * 13.1), not something our polling accumulates, so null means TAK Server
 * retains no entry for this Device at all -- not "no poll has happened yet"
 * and not "no data" (Requirements 3.5, 3.7). It replaces the Last_Seen value
 * ONLY: the UID, issued, and expires cells still show their real values.
 */
export const NEVER_SEEN_LABEL = 'never seen'

/**
 * Requirements 20.1, 20.9: what a currently-connected Device's Last Seen cell
 * says.
 *
 * TEXT, not a colour. The state has to reach a screen reader, and a green dot
 * does not, so the dot beside this label is `aria-hidden` decoration and this
 * string is what carries the state -- the convention Requirement 16.5 already
 * established with the "Revoked" badge. Requirement 20.9 also keeps the
 * Last_Seen timestamp beside the label WHERE one is known, so adopting the
 * label costs no information.
 */
export const CONNECTED_LABEL = 'Connected'

/**
 * Requirements 21.2, 21.3: the text marker on an Imminent_Expiry.
 *
 * Bold and red is the styling Requirement 21.2 asks for, and neither weight
 * nor colour is perceivable to assistive technology, so this marker is what
 * actually conveys the state (Requirement 21.3, following Requirement 16.5).
 */
export const EXPIRES_SOON_LABEL = 'Expires soon'

/**
 * Requirement 21.5: the text marker on an Expired_Certificate_State.
 *
 * DISTINCT from `EXPIRES_SOON_LABEL` rather than sharing it: "expires soon"
 * is a false statement about a date that has already passed, and the two
 * states call for different action -- re-enroll before the deadline versus
 * re-enroll now, the device is already refusing connections. The two share
 * the bold-red styling and nothing else.
 */
export const EXPIRED_LABEL = 'Expired'

/**
 * The text marker each expiry state renders, or nothing for `none`.
 *
 * A lookup rather than a conditional chain so a fourth state could not
 * silently pick up one of these two markers: an unmapped state yields
 * `undefined`, which renders as the untouched cell `none` renders
 * (Requirement 21.4).
 */
const EXPIRY_MARKERS = Object.freeze({
  [EXPIRY_STATES.IMMINENT]: EXPIRES_SOON_LABEL,
  [EXPIRY_STATES.EXPIRED]: EXPIRED_LABEL,
})

/**
 * The column captions, in order, shared by both surfaces. Exported so a test
 * can assert the two tables agree without hard-coding the list twice.
 *
 * "Type" leads, matching the reading order in the design (Device_Type_Icon,
 * UID, issued, expires, Last_Seen, actions): the glyph is a compact
 * at-a-glance qualifier for the row, and putting it in its own cell keeps the
 * UID cell's text exactly the UID.
 *
 * @type {readonly string[]}
 */
export const DEVICE_LIST_COLUMNS = Object.freeze([
  'Type',
  'Device UID',
  'Issued',
  'Expires',
  'Last Seen',
  'Actions',
])

/**
 * Requirement 16.2: the accessible name of a row's Revoke control.
 *
 * The control is icon-only, so without this it would be an unlabelled button.
 * The name includes the Client_Uid because a screen-reader user pulling the
 * button out of context (a forms/buttons list) otherwise hears "Revoke" once
 * per row with nothing to tell the rows apart.
 *
 * Exported for direct unit testing, matching this project's convention of
 * testing extracted pure logic (see `RevokeDeviceDialog.jsx`'s helpers).
 *
 * @param {string} clientUid the Device's stable UID.
 * @returns {string} the `aria-label` for that Device's Revoke control.
 */
export function revokeActionLabel(clientUid) {
  return `Revoke device ${clientUid}`
}

/**
 * The `<thead>` row for a device table (see the file header for why it lives
 * beside the body row).
 *
 * @param {object} props
 * @param {boolean} [props.compact] tighter horizontal padding, for the modal.
 */
export function DeviceListHeader({ compact = false }) {
  const padding = compact ? 'px-4 py-3' : 'px-6 py-3'

  return (
    <tr>
      {DEVICE_LIST_COLUMNS.map((column) => (
        <th
          key={column}
          scope="col"
          className={`${padding} ${
            column === 'Actions' ? 'text-right' : 'text-left'
          } text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}
        >
          {column}
        </th>
      ))}
    </tr>
  )
}

/**
 * Requirements 15.6, 16.1-16.6: one Device as a table row.
 *
 * Accessibility of the icon-only Revoke control, which is the substance of
 * this component rather than a finish on it:
 *
 * - It carries `aria-label={`Revoke device ${clientUid}`}`, so dropping the
 *   word "Revoke" from the page does not drop the accessible name, and the
 *   name identifies which device is about to be revoked (Requirement 16.2).
 * - Its tooltip reuses the `relative group` + `opacity-0
 *   group-hover:opacity-100` pattern already in `Dashboard.jsx` rather than
 *   introducing a tooltip mechanism (Requirement 16.4), extended with
 *   `group-focus-within:opacity-100` so tabbing to the button discloses the
 *   same text hovering it does (Requirement 16.3).
 * - For an already-revoked Device the control stays rendered but `disabled`,
 *   so assistive tech announces it as unavailable, and the existing "Revoked"
 *   text badge stays beside the UID -- the state is carried by text and by
 *   the disabled property, never by the dimmed color alone (Requirement
 *   16.5). A disabled button is not focusable, so its tooltip is
 *   hover-reachable only; that is why the badge, not the tooltip, is what
 *   states the state.
 * - The glyph itself is `aria-hidden`, and so is the tooltip text, so the
 *   button is announced once, by its label, instead of three times.
 *
 * A row can carry up to THREE state markers at once -- "Revoked" beside the
 * UID, "Connected" in Last Seen, and "Expires soon"/"Expired" in Expires --
 * so they are deliberately kept in three different cells and given three
 * different visual weights rather than stacked as three pills: only the
 * pre-existing "Revoked" is a filled badge, while the two added by
 * Requirements 20.9 and 21.3 are plain weighted text (green with a small
 * decorative dot, and red bold) that reads as a qualifier of the value in its
 * own cell. All three are text, so all three announce.
 *
 * The clock: `classifyExpiry` takes `now` as a parameter so its boundaries are
 * testable by arithmetic, and this row reads `Date.now()` once per render
 * rather than holding a ticking timer per row. Nothing goes stale in practice
 * -- the Dashboard card re-fetches and re-renders every 60 s (Requirement
 * 19.1) and the modal is a short-lived dialog that fetches on open
 * (Requirement 19.8) -- and the threshold is measured in DAYS, so the worst a
 * long-open page can do is render one refresh behind for a Device sitting
 * exactly on a day boundary.
 *
 * @param {object} props
 * @param {{clientUid: string, clientType?: string|null, issuedAt?: string|null,
 *   expiresAt?: string|null, lastSeenAt?: string|null, revoked?: boolean,
 *   connected?: boolean}} props.device
 *   one Device from a device endpoint's response.
 * @param {(device: object) => void} props.onRevoke called with the Device when
 *   the Revoke control is activated; the caller opens `RevokeDeviceDialog`,
 *   which owns the REVOKE type-in confirmation.
 * @param {boolean} [props.compact] tighter horizontal padding, for the modal.
 */
export default function DeviceListRow({ device, onRevoke, compact = false }) {
  const padding = compact ? 'px-4 py-4' : 'px-6 py-4'
  const isRevoked = Boolean(device.revoked)
  const tooltip = isRevoked ? 'Device already revoked' : 'Revoke device'

  // Requirements 20.1, 20.9. A connected Device with no reported timestamp
  // renders the label ALONE -- "Connected never seen" would be a
  // contradiction -- so this cell has to know whether there is a timestamp
  // before it decides whether to render the `ml-2` wrapper and the deliberate
  // in-string leading space beside the label.
  //
  // A PREDICATE rather than a rendered string (date-tooltips-and-folder-
  // contrast Decision 7): the date itself now renders through
  // `FormattedDate`, which does not own this cell and therefore cannot make
  // the layout decision for it. `formatDateTime(device.lastSeenAt, '')` would
  // still answer the question, and would keep a Date_Format_Helper import
  // alive in a module the drift guard exists to clear (Criterion 2.12).
  const isConnected = Boolean(device.connected)
  const hasLastSeen = hasRenderableDate(device.lastSeenAt)

  // Requirements 21.2-21.5. The threshold is the installed one (see
  // `setExpiryWarningDays`), so both surfaces classify against the same value.
  const expiryMarker = EXPIRY_MARKERS[
    classifyExpiry(device.expiresAt, getExpiryWarningDays(), Date.now())
  ]

  return (
    <tr>
      <td className={`${padding} whitespace-nowrap text-sm`}>
        <DeviceTypeIcon clientType={device.clientType} />
      </td>
      <td className={`${padding} text-sm font-medium text-gray-900 dark:text-gray-100 break-all`}>
        {device.clientUid}
        {isRevoked && (
          <span className="ml-2 inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800">
            Revoked
          </span>
        )}
      </td>
      <td className={`${padding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400`}>
        <FormattedDate
          value={device.issuedAt}
          fallback="Unknown"
          precision={DATE_PRECISION.DATE}
          side={TOOLTIP_SIDES.RIGHT}
        />
      </td>
      {/* Requirements 21.2-21.5: an Imminent_Expiry and an already-lapsed one
          are both bold and red, and each carries its OWN text marker so the
          state reaches a screen reader, which neither the colour nor the
          weight does. An `expires_at` that is null, unparseable, or further
          out than the threshold takes the `none` branch, which is this cell
          exactly as it rendered before -- same classes, same 'Unknown'
          fallback, no marker (Requirement 21.4). */}
      <td
        className={`${padding} whitespace-nowrap text-sm ${
          expiryMarker
            ? 'font-bold text-red-600 dark:text-red-400'
            : 'text-gray-500 dark:text-gray-400'
        }`}
      >
        <FormattedDate
          value={device.expiresAt}
          fallback="Unknown"
          precision={DATE_PRECISION.DATE}
          side={TOOLTIP_SIDES.RIGHT}
        />
        {/* The leading space is inside the string on purpose, the same way the
            Last Seen cell below carries one beside the Connected_Label: the
            `ml-2` separates the two visually, but anything reading the cell's
            text -- assistive technology, and the tests -- would otherwise run
            the date straight into the marker as "2026-08-30Expires soon". */}
        {expiryMarker && (
          <span className="ml-2 text-xs font-semibold">{` ${expiryMarker}`}</span>
        )}
      </td>
      {/* Requirements 20.1, 20.9: a connected Device says so in TEXT, with its
          Last_Seen timestamp retained beside the label where one is known. The
          dot is `aria-hidden` decoration -- the state is never carried by
          colour alone.

          Requirements 5.3, 6.5: otherwise, unchanged -- a null Last_Seen
          renders "never seen" in place of that value ONLY, the UID, issued and
          expires cells above still showing their real values. */}
      <td className={`${padding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400`}>
        {isConnected ? (
          <>
            <span className="inline-flex items-center font-medium text-green-700 dark:text-green-400">
              <span aria-hidden="true" className="mr-1.5 h-2 w-2 rounded-full bg-green-500" />
              {CONNECTED_LABEL}
            </span>
            {/* The separating space is a deliberate text node, not layout: the
                margin separates the two visually, but anything reading the
                cell's text -- assistive technology, and the tests -- would
                otherwise run the label into the timestamp. It stays HERE
                rather than moving inside `FormattedDate`, which renders the
                timestamp and nothing else so its rendered string is the
                helper's character for character (Criterion 2.3). */}
            {hasLastSeen && (
              <span className="ml-2">
                {' '}
                <FormattedDate
                  value={device.lastSeenAt}
                  fallback=""
                  precision={DATE_PRECISION.DATE_TIME}
                  side={TOOLTIP_SIDES.LEFT}
                />
              </span>
            )}
          </>
        ) : (
          <FormattedDate
            value={device.lastSeenAt}
            fallback={NEVER_SEEN_LABEL}
            precision={DATE_PRECISION.DATE_TIME}
            side={TOOLTIP_SIDES.LEFT}
          />
        )}
      </td>
      <td className={`${padding} whitespace-nowrap text-right text-sm font-medium`}>
        <span className="relative group inline-flex">
          <button
            type="button"
            onClick={() => onRevoke(device)}
            disabled={isRevoked}
            aria-label={revokeActionLabel(device.clientUid)}
            className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-red-600 rounded focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <TrashIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          {/* The mirror of the Device_Type_Icon's tooltip, for the same
              reason: Actions is the LAST column, so this one is exposed to the
              table's RIGHT edge. It opens leftward from `right-full` and sits
              centred on its row, keeping it inside the table's content box on
              every side so the `overflow-x-auto` wrapper on both surfaces --
              which clips vertically too, one axis being `auto` -- has nothing
              to cut off. `bottom-full` previously put it above the row, which
              the wrapper's top edge clips on the first row. */}
          <span
            aria-hidden="true"
            className="absolute right-full top-1/2 transform -translate-y-1/2 mr-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10"
          >
            {tooltip}
          </span>
        </span>
      </td>
    </tr>
  )
}
