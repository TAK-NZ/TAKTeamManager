import { TrashIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import DeviceTypeIcon from './DeviceTypeIcon'
import FormattedDate, { DATE_PRECISION, TOOLTIP_SIDES } from './FormattedDate'
import { EXPIRY_STATES, classifyExpiry, getExpiryWarningDays } from '../utils/expiryWarning'

/**
 * Requirement 16.6: the ONE definition of a device-list row.
 *
 * The Dashboard "My Devices" card (`pages/Dashboard.jsx`) and the
 * user-details modal (`components/UserDevicesModal.jsx`) render the same list
 * of the same Devices, so every cell of that row -- the Device_Type_Icon, the
 * UID with its "Revoked" badge, the dates, the "never seen" fallback, the
 * "Currently Connected" label (Requirement 20.9), the two expiry markers
 * (Requirements 21.3, 21.5, 21.8), and the icon-only Revoke action -- is
 * drawn here and nowhere else. Two copies of
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
 * `formatDate`/`formatDateTime` itself.
 *
 * Issued and Expires share ONE "Certificate" column, stacked on two lines
 * rather than two `whitespace-nowrap` columns side by side. Once
 * `formatDateTime` started appending a short timezone abbreviation
 * (date-tooltips-and-folder-contrast follow-up), each date's rendered width
 * grew from `yyyy-mm-dd` to `yyyy-mm-dd HH:MM ZZZ`, and six columns each
 * demanding that width overflowed both the Dashboard card and, worse, the
 * `UserDevicesModal` dialog's `max-w-3xl`. Stacking recovers a whole column
 * of width for free -- Issued and Expires were never meant to be scanned
 * side by side in the first place -- and keeps each date's own
 * `FormattedDate` tooltip unchanged.
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
 * established with the "Revoked" badge.
 *
 * Bugfix: a connected Device's Last_Seen timestamp is dropped entirely once
 * connected -- a live connection makes "last seen" a stale, misleading
 * question to be answering (the device is not merely "last seen" at some
 * past instant, it is seen RIGHT NOW), and the label is worded
 * "Currently Connected" rather than the bare "Connected" to make that
 * immediate. This applies identically on desktop (`DeviceListRow`) and
 * mobile (`DeviceListCard`) -- there is no case where the timestamp is
 * shown on one and hidden on the other.
 */
export const CONNECTED_LABEL = 'Currently Connected'

/**
 * Requirements 21.2, 21.3: the accessible-name text for an Imminent_Expiry.
 *
 * No longer rendered as VISIBLE text beside the date (that inline marker was
 * the second-widest thing in the row, and it is gone now that the Certificate
 * column is already tight). The date's own bold-red colour is the visible
 * cue, paired with the warning glyph below; this string instead lives in a
 * visually-hidden `sr-only` span beside that glyph -- real text in the
 * accessibility tree, exactly the way `StoreBadges.jsx`'s
 * `RecommendedOptionMarker` states "Recommended option" -- so the state
 * still reaches a screen reader without a colour-only or icon-only signal
 * (client conventions: "carry state in TEXT, never colour alone"). The
 * warning glyph's `title`-free hover/focus tooltip repeats the same words for
 * a sighted mouse or keyboard user, matching every other icon tooltip in this
 * file and in `DeviceTypeIcon.jsx`.
 */
export const EXPIRES_SOON_LABEL = 'Expires soon'

/**
 * Requirement 21.5: the accessible-name text for an Expired_Certificate_State.
 *
 * DISTINCT from `EXPIRES_SOON_LABEL` rather than sharing it: "expires soon"
 * is a false statement about a date that has already passed, and the two
 * states call for different action -- re-enroll before the deadline versus
 * re-enroll now, the device is already refusing connections. The two share
 * the bold-red date colour and the warning glyph, and nothing else.
 */
export const EXPIRED_LABEL = 'Expired'

/**
 * Callsign-mismatch detection (docs/ARCHITECTURE.md ("Callsign Mismatch Detection" section)): the
 * accessible-name text for a device currently connected under a callsign that
 * does not preserve the user's assigned callsign.
 *
 * Carried by TEXT, never colour alone (client conventions), the same way the
 * two expiry markers above are: an AMBER warning glyph with an `sr-only` label
 * and a hover/focus tooltip, plus the observed callsign shown as visible text.
 * AMBER, not the expiry markers' red -- a wrong callsign is a "please correct
 * this" nudge, not a certificate-validity failure, and giving it the same red
 * as "Expired" would conflate two unrelated states. The `callsignMismatch`
 * flag itself is computed server-side (`DeviceManagementService.mapDevice`) via
 * the same rule the poller uses, so this component only renders it.
 */
export const CALLSIGN_MISMATCH_LABEL = 'Callsign needs correcting'

/**
 * The accessible-name text each expiry state carries, or nothing for `none`.
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
 * UID, Certificate, Last_Seen, actions): the glyph is a compact at-a-glance
 * qualifier for the row, and putting it in its own cell keeps the UID cell's
 * text exactly the UID.
 *
 * "Certificate" replaces the former separate "Issued"/"Expires" columns
 * (device-management-cert-table-layout follow-up): each date's rendered
 * width grew once `formatDateTime` started appending a short timezone
 * abbreviation, and six side-by-side `whitespace-nowrap` columns overflowed
 * both the Dashboard card and the narrower `UserDevicesModal` dialog. Issued
 * and Expires now stack as two lines inside ONE column instead.
 *
 * @type {readonly string[]}
 */
export const DEVICE_LIST_COLUMNS = Object.freeze([
  'Type',
  'Device UID',
  'Certificate',
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
 * The per-device classification shared by BOTH renderings of a device --
 * the table row (`DeviceListRow`, `sm:` and up) and the mobile card
 * (`DeviceListCard`, below `sm`). Kept as one pure function rather than
 * computed twice so the two surfaces can never classify the same device
 * differently: `isRevoked`/`tooltip`/`isConnected`/`expiryMarker` are
 * exactly the values `DeviceListRow` computed inline before this
 * extraction, unchanged.
 *
 * @param {object} device
 * @returns {{isRevoked: boolean, tooltip: string, isConnected: boolean,
 *   expiryMarker: string|undefined}}
 */
function computeDeviceRowState(device) {
  const isRevoked = Boolean(device.revoked)
  const tooltip = isRevoked ? 'Device already revoked' : 'Revoke device'
  // A revoked Device is never presented as "Currently Connected": a revoked
  // certificate cannot be a live participant. This is defense in depth on top
  // of the server (the revoke handler clears `connected`, and the poller refuses
  // to re-mark a revoked row connected) -- so even a momentarily-stale
  // `connected = true` on a revoked row never reaches the UI as a connection.
  // Without this, a revoked-but-still-flagged row showed as connected on the
  // Dashboard while being excluded from the Enrollment page's active count.
  const isConnected = Boolean(device.connected) && !isRevoked
  const expiryMarker = EXPIRY_MARKERS[
    classifyExpiry(device.expiresAt, getExpiryWarningDays(), Date.now())
  ]
  // Callsign-mismatch detection: the flag is computed server-side
  // (DeviceManagementService.mapDevice, via the shared isCallsignAcceptable
  // rule, scoped to connected non-CloudTAK devices), so this row only reads it.
  // `observedCallsign` is the callsign the client is connected under, shown as
  // visible text beside the marker.
  const callsignMismatch = Boolean(device.callsignMismatch)
  const observedCallsign = device.observedCallsign ?? null

  return { isRevoked, tooltip, isConnected, expiryMarker, callsignMismatch, observedCallsign }
}

/**
 * Bugfix (Devices.jsx / TeamDeviceList.jsx had no certificate-expiry
 * highlighting at all): a standalone "Expires: <date>" line reusing the
 * SAME classification (`classifyExpiry`/`getExpiryWarningDays`) and the
 * SAME bold-red-text-plus-warning-glyph-plus-`sr-only`-text convention
 * `DeviceListRow`'s own Expires line already establishes -- so a device
 * surfaced through the org-wide `/devices` page or a single team's Devices
 * tab is classified identically to the same device shown on the Dashboard
 * "My Devices" card or in `UserDevicesModal`. Neither of those two callers
 * has an "Issued" line or a shared Certificate column to slot into (they
 * have no per-device Issued date to show at all), so this is a lighter,
 * standalone rendering rather than a reuse of the Certificate column's
 * exact JSX -- the CLASSIFICATION is shared, not the layout.
 *
 * Renders NOTHING when `expiresAt` is absent, mirroring
 * `MultipleCertificateWarning`'s own "additive, nothing to say" contract:
 * a device that has never held a live certificate (a brand-new,
 * unenrolled Team_Owned_Device) has nothing to show here, and forcing an
 * "Expires: Unknown" line onto every such row would be noise on exactly
 * the rows least likely to need this warning at all.
 *
 * @param {object} props
 * @param {string|null|undefined} props.expiresAt the device's soonest
 *   live-certificate expiry (`DeviceEnrollmentService.listTeamDevices`/
 *   `listAllDevices`' own `expiresAt` field), or absent for a device with
 *   no live certificate.
 */
export function DeviceExpiryLine({ expiresAt }) {
  if (!expiresAt) {
    return null
  }

  const expiryMarker = EXPIRY_MARKERS[classifyExpiry(expiresAt, getExpiryWarningDays(), Date.now())]

  return (
    <div
      className={`flex items-center gap-1.5 text-xs ${
        expiryMarker ? 'font-bold text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'
      }`}
    >
      <span>Expires</span>{' '}
      <FormattedDate
        value={expiresAt}
        fallback="Unknown"
        precision={DATE_PRECISION.DATE_TIME}
        side={TOOLTIP_SIDES.RIGHT}
      />
      {expiryMarker && (
        <span className="relative group inline-flex" tabIndex={0}>
          <ExclamationTriangleIcon
            className="h-4 w-4 text-red-600 dark:text-red-400 cursor-help"
            aria-hidden="true"
          />
          <span className="sr-only">{expiryMarker}</span>
          <span
            aria-hidden="true"
            className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10"
          >
            {expiryMarker}
          </span>
        </span>
      )}
    </div>
  )
}

/**
 * Callsign-mismatch detection (docs/ARCHITECTURE.md ("Callsign Mismatch Detection" section)): the inline
 * marker shown beside a device's UID when it is connected under a callsign that
 * does not preserve its assigned one. Rendered by BOTH `DeviceListRow` and
 * `DeviceListCard` from this one definition so the two surfaces cannot drift.
 *
 * Follows the exact convention the expiry markers use, in AMBER: the observed
 * callsign as visible text, an `aria-hidden` warning glyph, an `sr-only` label
 * (`CALLSIGN_MISMATCH_LABEL`) that states the fact unconditionally in the
 * accessibility tree, and a hover/focus tooltip repeating it for a sighted
 * mouse/keyboard user. Renders nothing when the device is not flagged
 * ("additive, nothing to say", mirroring `DeviceExpiryLine`).
 *
 * @param {object} props
 * @param {boolean} props.callsignMismatch whether this device is flagged.
 * @param {string|null} props.observedCallsign the callsign the client is
 *   connected under, shown beside the marker.
 */
export function CallsignMismatchMarker({ callsignMismatch, observedCallsign }) {
  if (!callsignMismatch) {
    return null
  }

  return (
    <span className="ml-2 inline-flex items-center gap-1 align-middle text-xs font-bold text-amber-600 dark:text-amber-400">
      <span className="relative group inline-flex" tabIndex={0}>
        <ExclamationTriangleIcon
          className="h-4 w-4 text-amber-600 dark:text-amber-400 cursor-help"
          aria-hidden="true"
        />
        <span className="sr-only">{CALLSIGN_MISMATCH_LABEL}</span>
        <span
          aria-hidden="true"
          className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10"
        >
          {CALLSIGN_MISMATCH_LABEL}
          {observedCallsign ? `: ${observedCallsign}` : ''}
        </span>
      </span>
      {observedCallsign && <span className="break-all font-normal">{observedCallsign}</span>}
    </span>
  )
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
 * The inline "Issued"/"Expires" line label inside the merged Certificate
 * cell. Plain, always-visible text -- NOT decorative and NOT `aria-hidden`:
 * with Issued and Expires sharing one column and no column header of their
 * own, this label is what tells a screen-reader user (and a sighted one)
 * which of the two dates on the line they are looking at.
 */
function DateLineLabel({ children }) {
  // `w-16` (rather than the original `w-12`) accommodates `DeviceListCard`'s
  // "Last seen" label -- one character wider than "Issued"/"Expires" -- with
  // the same component, so all three lines share one label-column width
  // instead of "Last seen" overflowing a narrower box.
  return (
    <span className="text-xs text-gray-400 dark:text-gray-500 w-16 flex-shrink-0">
      {children}
    </span>
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
  // Requirements 20.1, 20.9, 21.2-21.5: see `computeDeviceRowState`'s own
  // doc comment -- this is the exact classification this row always
  // computed inline, now shared verbatim with `DeviceListCard` below.
  const { isRevoked, tooltip, isConnected, expiryMarker, callsignMismatch, observedCallsign } =
    computeDeviceRowState(device)

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
        <CallsignMismatchMarker
          callsignMismatch={callsignMismatch}
          observedCallsign={observedCallsign}
        />
      </td>
      {/* The merged Certificate column: Issued on the first line, Expires on
          the second, each labelled so the shared "Certificate" header does
          not lose the distinction a dedicated column caption used to carry.
          Requirements 21.2-21.5: an Imminent_Expiry and an already-lapsed one
          are both bold and red on the Expires line ONLY, and each carries
          its own accessible-name text via the warning glyph below rather
          than inline visible text -- the inline "Expires soon"/"Expired"
          marker was the second-widest thing in the row and does not fit
          beside an already-lengthened, zone-suffixed date. An `expires_at`
          that is null, unparseable, or further out than the threshold takes
          the `none` branch, which is this line exactly as it rendered
          before -- same classes, same 'Unknown' fallback, no glyph
          (Requirement 21.4). */}
      <td className={`${padding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400`}>
        {/* The literal `{' '}` between the label and the date is a real text
            node, not layout: `gap-1.5` alone separates them visually, but
            anything READING the cell's text -- assistive technology, and the
            tests -- would otherwise run the label into the date as
            "Issued2026-08-28...", the same reasoning the Connected_Label and
            the expiry marker below already follow in this file. */}
        <div className="flex items-center gap-1.5">
          <DateLineLabel>Issued</DateLineLabel>{' '}
          <FormattedDate
            value={device.issuedAt}
            fallback="Unknown"
            precision={DATE_PRECISION.DATE_TIME}
            side={TOOLTIP_SIDES.RIGHT}
          />
        </div>
        <div
          className={`flex items-center gap-1.5 ${
            expiryMarker ? 'font-bold text-red-600 dark:text-red-400' : ''
          }`}
        >
          <DateLineLabel>Expires</DateLineLabel>{' '}
          <FormattedDate
            value={device.expiresAt}
            fallback="Unknown"
            precision={DATE_PRECISION.DATE_TIME}
            side={TOOLTIP_SIDES.RIGHT}
          />
          {/* Requirement 21.3/21.5's state, carried by TEXT rather than by
              the date's colour alone (client conventions): the warning
              glyph is `aria-hidden`, and a visually-hidden `sr-only` span
              beside it -- unconditionally in the accessibility tree, not
              only while hovered -- states the same word a sighted user gets
              from a hover/focus tooltip. Mirrors
              `StoreBadges.jsx`'s `RecommendedOptionMarker`, this codebase's
              other icon-plus-`sr-only`-text pairing. */}
          {expiryMarker && (
            <span className="relative group inline-flex" tabIndex={0}>
              <ExclamationTriangleIcon
                className="h-4 w-4 text-red-600 dark:text-red-400 cursor-help"
                aria-hidden="true"
              />
              <span className="sr-only">{expiryMarker}</span>
              <span
                aria-hidden="true"
                className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10"
              >
                {expiryMarker}
              </span>
            </span>
          )}
        </div>
      </td>
      {/* Requirements 20.1, 20.9: a connected Device says so in TEXT ONLY --
          "Currently Connected", no timestamp beside it, on the theory that a
          live connection is not a "last seen at" fact at all. The dot is
          `aria-hidden` decoration -- the state is never carried by colour
          alone.

          Requirements 5.3, 6.5: otherwise, unchanged -- a null Last_Seen
          renders "never seen" in place of that value ONLY, the UID, issued and
          expires cells above still showing their real values. */}
      <td className={`${padding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400`}>
        {isConnected ? (
          <span className="inline-flex items-center font-medium text-green-700 dark:text-green-400">
            <span aria-hidden="true" className="mr-1.5 h-2 w-2 rounded-full bg-green-500" />
            {CONNECTED_LABEL}
          </span>
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
        {/* Bugfix (mobile tap target too small): p-2 rounded-lg box
            around the icon (was a bare h-5 w-5 icon with no padding),
            matching the red-tinted button-box treatment
            MemberActions.jsx/TeamDeviceList.jsx's DeviceActions/
            Teams.jsx's TeamRowActions already use for their own
            destructive actions. Shared between this desktop row and
            the mobile DeviceListCard below, so both surfaces get the
            larger target. */}
        <span className="relative group inline-flex">
          <button
            type="button"
            onClick={() => onRevoke(device)}
            disabled={isRevoked}
            aria-label={revokeActionLabel(device.clientUid)}
            className="p-2 rounded-lg text-red-600 hover:text-red-800 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-red-600 disabled:hover:bg-transparent focus:outline-none focus:ring-2 focus:ring-red-500"
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

/**
 * The mobile (below `sm`) rendering of one Device -- a stacked card instead
 * of a table row. Introduced because the shared table (`DeviceListRow`
 * above) has five columns and no column-hiding fallback: on a phone-width
 * viewport inside `overflow-x-auto`, every column just makes the table
 * scroll horizontally, which is exactly the "table wider than the phone"
 * clutter this exists to fix.
 *
 * Deliberately NOT a second implementation of the row's logic: every piece
 * of per-device state (`isRevoked`, the Connected label, the "never seen"
 * fallback, the expiry marker) comes from the same `computeDeviceRowState`
 * helper `DeviceListRow` uses, and every date renders through the same
 * `FormattedDate`/`DateLineLabel` used there -- so the two renderings can
 * never classify or format the same Device differently. Only the
 * PRESENTATION (stacked label/value pairs instead of table cells) differs.
 *
 * Callers render this ALONGSIDE `DeviceListRow`/`DeviceListHeader` (hidden
 * at the opposite breakpoint, `sm:hidden` here vs `hidden sm:table`/`sm:block`
 * on the table), never as a replacement -- see `Dashboard.jsx` and
 * `UserDevicesModal.jsx`.
 *
 * @param {object} props
 * @param {object} props.device same shape as `DeviceListRow`'s `device` prop.
 * @param {(device: object) => void} props.onRevoke same contract as
 *   `DeviceListRow`'s `onRevoke`.
 */
export function DeviceListCard({ device, onRevoke }) {
  const { isRevoked, tooltip, isConnected, expiryMarker, callsignMismatch, observedCallsign } =
    computeDeviceRowState(device)

  return (
    <div className="p-4 space-y-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <DeviceTypeIcon clientType={device.clientType} />
          <span className="font-medium text-gray-900 dark:text-gray-100 break-all">
            {device.clientUid}
          </span>
        </div>
        {/* Bugfix (mobile tap target too small): same p-2 rounded-lg
            button-box as the desktop row's revoke button above --
            this is the MOBILE surface, so the fix matters most here. */}
        <span className="relative group inline-flex flex-shrink-0">
          <button
            type="button"
            onClick={() => onRevoke(device)}
            disabled={isRevoked}
            aria-label={revokeActionLabel(device.clientUid)}
            className="p-2 rounded-lg text-red-600 hover:text-red-800 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-950/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-red-600 disabled:hover:bg-transparent focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <TrashIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <span
            aria-hidden="true"
            className="absolute right-full top-1/2 transform -translate-y-1/2 mr-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10"
          >
            {tooltip}
          </span>
        </span>
      </div>

      {isRevoked && (
        <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800">
          Revoked
        </span>
      )}

      {/* Callsign-mismatch detection: same marker as the desktop row, from the
          one shared definition, on its own line here so it reads clearly in the
          stacked card. */}
      {callsignMismatch && (
        <div>
          <CallsignMismatchMarker
            callsignMismatch={callsignMismatch}
            observedCallsign={observedCallsign}
          />
        </div>
      )}

      <div className="space-y-1 text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-1.5">
          <DateLineLabel>Issued</DateLineLabel>{' '}
          <FormattedDate
            value={device.issuedAt}
            fallback="Unknown"
            precision={DATE_PRECISION.DATE_TIME}
            side={TOOLTIP_SIDES.RIGHT}
          />
        </div>
        <div
          className={`flex items-center gap-1.5 ${
            expiryMarker ? 'font-bold text-red-600 dark:text-red-400' : ''
          }`}
        >
          <DateLineLabel>Expires</DateLineLabel>{' '}
          <FormattedDate
            value={device.expiresAt}
            fallback="Unknown"
            precision={DATE_PRECISION.DATE_TIME}
            side={TOOLTIP_SIDES.RIGHT}
          />
          {expiryMarker && (
            <span className="relative group inline-flex" tabIndex={0}>
              <ExclamationTriangleIcon
                className="h-4 w-4 text-red-600 dark:text-red-400 cursor-help"
                aria-hidden="true"
              />
              <span className="sr-only">{expiryMarker}</span>
              <span
                aria-hidden="true"
                className="absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10"
              >
                {expiryMarker}
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <DateLineLabel>Last seen</DateLineLabel>{' '}
          {isConnected ? (
            <span className="inline-flex items-center font-medium text-green-700 dark:text-green-400">
              <span aria-hidden="true" className="mr-1.5 h-2 w-2 rounded-full bg-green-500" />
              {CONNECTED_LABEL}
            </span>
          ) : (
            <FormattedDate
              value={device.lastSeenAt}
              fallback={NEVER_SEEN_LABEL}
              precision={DATE_PRECISION.DATE_TIME}
              side={TOOLTIP_SIDES.LEFT}
            />
          )}
        </div>
      </div>
    </div>
  )
}
