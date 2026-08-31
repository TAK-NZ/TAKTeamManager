import { useState, useEffect, useCallback } from 'react'
import { DeviceTabletIcon, MagnifyingGlassIcon, PencilIcon, ArrowRightCircleIcon, QrCodeIcon, TrashIcon, XMarkIcon, LockClosedIcon, LockOpenIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { devicesAPI } from '../services/api'
import FormattedDate, { DATE_PRECISION } from './FormattedDate'
import MultipleCertificateWarning from './MultipleCertificateWarning'
import TransferMemberDialog from './TransferMemberDialog'
import SuspendAccountDialog from './SuspendAccountDialog'
import { describeAccountStatusBadge } from '../utils/accountStatusBadge'

/**
 * takserver-enrollment Requirements 5.9, 5.10, 14.7 (task 11.2), extended by
 * the consistency bugfix batch (bugs #4, #6, #7, #8, #9 of that batch):
 *
 * the team-device surface that keeps a Team_Owned_Device reachable despite
 * Criterion 5.8's email-search exclusion.
 *
 * A Team_Owned_Device carries NO email (Requirement 5), so it is absent
 * from every email-keyed search and every domain-scoped directory --
 * `email ILIKE $1` and the `%@domain` patterns both evaluate to NULL for a
 * NULL email, and a NULL predicate excludes the row (Criterion 5.8). This
 * component is the surface Criterion 5.9 requires to close that gap: a
 * device stays reachable HERE by its Device_Display_Name and its
 * Managed_Identifier, drawn from `GET /api/devices/team/:teamId`
 * (`DeviceEnrollmentService.listTeamDevices`).
 *
 * ## Consistency with the Members/Team Admins tabs (bug #4)
 *
 * Bugfix (list-width reduction pass): the desktop table's column set is
 * now Device (name + username, stacked) / TAK Callsign & Role (computed
 * `callsign` + `takRole`, stacked, the role small and uncolored) / Added
 * / Actions -- collapsing the old separate Device/Username two-column
 * header, mirroring EXACTLY how the same pass collapsed the Members/Team
 * Admins tables' Name/Email/Role/TAK Role/Callsign/Actions header down to
 * Name/Username/Role/"TAK Callsign & Role"/Actions. `callsign`/`takRole`
 * are new fields on the `listTeamDevices`/`updateDevice` response shapes
 * (`DeviceEnrollmentService.js`), computed the same way a human member's
 * `tak_callsign` is (`CallsignService.assembleCallsign`), since a device
 * has no `user_cache` row to read a stored one off.
 *
 * This surface now renders as a table (desktop, `sm:` and up) plus a
 * divided card list (mobile, below `sm:`) -- the same table+card pairing
 * `DeviceListRow.jsx`/`DeviceListCard` established and `UserDevicesModal.jsx`
 * already uses -- with a search input matching the Members/Team Admins
 * tabs' own `input` (bug #8), and the SAME action-icon set/styling those two
 * tabs use where the actions genuinely correspond: `PencilIcon` (gray,
 * "Edit device") for label/callsign-suffix edits, `ArrowRightCircleIcon`
 * (gray, "Transfer device to another team") reusing the SAME
 * `TransferMemberDialog` those tabs use (a device is, mechanically, just
 * another `users.id` to that dialog and its server route -- see
 * `TeamTransferService.executeTransfer`, which reads `is_team_device` only
 * to skip a notification email, never to reject the transfer), and
 * `TrashIcon` (red, "Delete device") for the new
 * `DELETE /api/devices/:deviceUserId` route (bug #7). `QrCodeIcon` (gray,
 * "Enroll device") is device-specific -- there is no Members/Team Admins
 * equivalent of minting enrollment credentials -- so it keeps its own icon
 * rather than borrowing one that would misdescribe it.
 *
 * ## No email column, no placeholder address (Criterion 5.10)
 *
 * `devicesAPI.getTeamDevices` never returns an `email` field for a device
 * -- there is none to return. WHERE this list would otherwise show an
 * email (every other user-list surface in this application has one), it
 * shows the Device_Display_Name (`deviceLabel || username`, following the
 * SAME fallback `DeviceEnrollmentService.createDevice` already applies
 * when it names the device to Authentik) and the Managed_Identifier
 * (`username`) as two separate labelled fields instead. Neither is ever
 * substituted for the other's absence with a made-up address; there is no
 * code path in this file that constructs an `@`-shaped string at all.
 *
 * ## Listing only -- this component does not render the Enrollment_View
 *
 * "An action that opens the device's Enrollment_View" (task 11.2) is
 * implemented as a callback, `onEnroll(device)`, not as an embedded
 * `<EnrollmentView>`. This component's own responsibility stops at
 * LISTING devices; the caller (task 11.3, `TeamDetail.jsx`) decides how to
 * open the Enrollment_View -- typically a modal rendering
 * `<EnrollmentView fetchEnrollment={...}>` with a `fetchEnrollment` that
 * calls `POST /api/devices/:deviceUserId/qr-code` instead of the
 * self-service route. Keeping that decision out of this file is what lets
 * it stay a plain list with no modal state, no enrollment-payload state,
 * and no knowledge of the secret-material handling `EnrollmentView.jsx`
 * already owns. Edit/Transfer/Delete, by contrast, are fully self-
 * contained here (their own inline form / their own dialogs), since none
 * of them touch secret material the way enrollment does.
 *
 * ## Layout: `overflow-x-auto` is confined to the table; tooltips still open sideways
 *
 * The table half of this surface now DOES sit inside `overflow-x-auto`
 * (matching the Members/Team Admins tables), so any tooltip inside it must
 * still open sideways only (`left-full`/`ml-2` or `right-full`/`mr-2`, plus
 * `top-1/2 -translate-y-1/2`) per the client convention -- there is none in
 * this file today, but a future one must follow that rule. The dates
 * rendered here go through `<FormattedDate>`, whose own Date_Tooltip
 * already does.
 *
 * ## Purely additive; the human member list is untouched (Criterion 14.6)
 *
 * This component fetches from a route (`GET /api/devices/team/:teamId`)
 * that is entirely separate from the human member list `TeamDetail.jsx`
 * already renders, and from the human member-count query. Rendering this
 * section beneath the member list does not reintroduce a Team_Owned_Device
 * into either (`production-hardening` Criterion 27.9, preserved by
 * takserver-enrollment Criterion 14.6).
 *
 * @param {object} props
 * @param {number|string} props.teamId the Team whose Team_Owned_Devices to
 *   list. A falsy value fetches nothing and renders nothing.
 * @param {(device: {deviceUserId: number, username: string, deviceLabel: string|null, teamId: number|string, createdAt: string, liveCertificateCount: number}) => void} props.onEnroll
 *   called with the device when its enrollment action is activated. The
 *   caller decides how to open the Enrollment_View.
 * @param {{isAdmin?: boolean}} [props.user] the operating user, passed
 *   straight through to `TransferMemberDialog`'s own `user` prop for its
 *   Global_Manager all-teams destination fallback (Requirement 15.9 there).
 */

/**
 * Turns a failed `GET /api/devices/team/:teamId` fetch into the message
 * shown inline.
 *
 * The statuses mirror what `DeviceEnrollmentService.listTeamDevices` can
 * answer via its shared `assertAuthorized`/`handleServiceError` path: `403`
 * the caller is neither a Team_Admin of this Team's Ancestor_Chain nor a
 * Global_Manager (a normal outcome to state plainly, not an internal
 * error), `400` a malformed `teamId`. Anything else (5xx, a network
 * failure) falls through to a generic message rather than rendering an
 * empty list, which would read as "no devices" (the same distinction
 * `UserDevicesModal.jsx`'s `interpretDeviceListError` draws).
 *
 * Exported for direct unit testing, matching this project's convention of
 * testing extracted pure logic (see `RevokeDeviceDialog.jsx`'s helpers).
 *
 * @param {{response?: {status?: number, data?: object}}} error an axios error.
 * @returns {string} a user-facing message.
 */
export function interpretTeamDeviceListError(error) {
  const status = error?.response?.status
  const serverMessage = error?.response?.data?.error

  if (status === 403) {
    return serverMessage || 'You can only view devices for a team you administer.'
  }
  if (status === 400) {
    return serverMessage || 'Unable to load this team\'s devices.'
  }
  return 'Failed to load this team\'s devices. Please try again.'
}

/**
 * Requirement 5.10: the Device_Display_Name -- the value shown wherever an
 * email would otherwise appear. `deviceLabel` is the admin-supplied name
 * (may be `null`: `production-hardening` Requirement 27 makes the label an
 * OPTIONAL argument at device creation); `username` (the Managed_Identifier)
 * is always present and always unique, so it is a safe fallback with no
 * `@` in it either way.
 *
 * Exported for direct unit testing.
 *
 * @param {{username: string, deviceLabel?: string|null}} device
 * @returns {string}
 */
export function deviceDisplayName(device) {
  return device?.deviceLabel || device?.username || ''
}

/**
 * Bug #8: the client-side search filter for this tab, matching the
 * `filterAndSort`-driven search the Members/Team Admins/Channels/Sub-teams
 * tabs already have (`TeamDetail.jsx`) -- case-insensitive substring
 * matching against the device's own display fields (label, username), the
 * only fields a device has to search by (Criterion 5.8's whole reason this
 * component exists: a device has no email to match against).
 *
 * Exported for direct unit testing.
 *
 * @param {Array<object>} devices
 * @param {string} searchTerm
 * @returns {Array<object>}
 */
export function filterTeamDevices(devices, searchTerm) {
  const term = (searchTerm || '').trim().toLowerCase()
  if (!term) {
    return devices
  }
  return devices.filter((device) => {
    const haystack = [deviceDisplayName(device), device?.username].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(term)
  })
}

/**
 * Bugfix (#7): mirrors `TeamDetail.jsx`'s own `isValidMemberCallsignSuffix`/
 * `AddTeamDeviceDialog.jsx`'s `isValidDeviceCallsignSuffix` convention
 * exactly -- an empty value is valid (the field is optional).
 */
const CALLSIGN_SUFFIX_PATTERN = '[A-Za-z0-9.-]*'
const CALLSIGN_SUFFIX_REGEX = /^[A-Za-z0-9.-]*$/

export function isValidTeamDeviceCallsignSuffix(value) {
  if (!value) {
    return true
  }
  return CALLSIGN_SUFFIX_REGEX.test(value)
}

/**
 * Bugfix (#7): the inline edit form's `PATCH /api/devices/:deviceUserId`
 * error interpreter, mirroring `TeamDetail.jsx`'s
 * `extractCallsignSuffixServerError` convention -- a 400 carrying the
 * server's own message (a per-team collision) belongs against the Callsign
 * Suffix field, not a generic toast.
 *
 * @param {{response?: {status?: number, data?: {error?: string}}}} error
 * @returns {string|null}
 */
export function extractDeviceEditServerError(error) {
  const status = error?.response?.status
  const serverError = error?.response?.data?.error
  if (status === 400 && typeof serverError === 'string') {
    return serverError
  }
  return null
}

/**
 * The per-row inline edit form, matching `TeamDetail.jsx`'s own
 * `MemberEditRow` shape/behaviour (a single wide table row replacing the
 * device's normal row) -- so editing a device feels like editing a member,
 * not like a different feature.
 */
function DeviceEditRow({ colSpan, form, setForm, saving, error, onSave, onCancel }) {
  return (
    <tr className="bg-gray-50 dark:bg-gray-800">
      <td colSpan={colSpan} className="px-6 py-4">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Device Label</label>
            <input
              type="text"
              value={form.deviceLabel}
              onChange={(e) => setForm({ ...form, deviceLabel: e.target.value })}
              className="input"
              maxLength={255}
              placeholder="Engine 4 Tablet"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Callsign Suffix</label>
            <input
              type="text"
              value={form.callsignSuffix}
              onChange={(e) => setForm({ ...form, callsignSuffix: e.target.value })}
              className="input"
              pattern={CALLSIGN_SUFFIX_PATTERN}
              title="Only letters, digits, - and . are allowed"
              placeholder="Tanker1"
            />
          </div>
          <div className="flex items-end space-x-2 pb-0.5">
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="btn-primary px-4 py-2 text-sm"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="btn-secondary px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-red-600 dark:text-red-400 text-sm mt-2">{error}</p>
        )}
      </td>
    </tr>
  )
}

/**
 * The action-icon group shared by the desktop row and the mobile card, so
 * neither surface can drift out of sync with the other's action set --
 * mirroring `DeviceListRow.jsx`/`DeviceListCard`'s own shared-classification
 * convention.
 *
 * Bugfix (mobile tap targets too small): `variant="card"` (passed only
 * from the `sm:hidden` mobile card block below; the desktop table keeps
 * the default `'table'`) wraps each icon in a `p-2 rounded-lg` button
 * box sized to match the header toolbar's own icon-only buttons, giving
 * a real ~36px tap target instead of a bare ~16px icon. See
 * `MemberActions.jsx`'s identical `variant` prop for the fuller
 * rationale -- both components were fixed together for consistency.
 */
function DeviceActions({ device, onEdit, onTransfer, onEnroll, onDelete, onSuspend, accountStatus = 'active', variant = 'table' }) {
  const isCard = variant === 'card'
  const iconSizeClass = isCard ? 'h-5 w-5' : 'h-4 w-4'
  const boxClass = isCard ? 'p-2 rounded-lg' : ''
  const neutralClass = isCard
    ? 'bg-gray-100 hover:bg-gray-200 text-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300'
    : 'text-gray-600 hover:text-gray-500 dark:text-gray-400 dark:hover:text-gray-300'
  const dangerClass = isCard
    ? 'bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-950/40 dark:hover:bg-red-900/60 dark:text-red-400'
    : 'text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300'

  return (
    <div className="flex items-center justify-end space-x-3">
      <button
        type="button"
        onClick={() => onEdit(device)}
        className={`${boxClass} ${neutralClass}`}
        title="Edit device"
        aria-label={`Edit device ${deviceDisplayName(device)}`}
      >
        <PencilIcon className={iconSizeClass} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onTransfer(device)}
        className={`${boxClass} ${neutralClass}`}
        title="Transfer device to another team"
        aria-label={`Transfer device ${deviceDisplayName(device)} to another team`}
      >
        <ArrowRightCircleIcon className={iconSizeClass} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onEnroll?.(device)}
        className={`${boxClass} ${neutralClass}`}
        title="Enroll device"
        aria-label={`Enroll device ${deviceDisplayName(device)}`}
      >
        <QrCodeIcon className={iconSizeClass} aria-hidden="true" />
      </button>
      {/* account-lifecycle-management Requirement 1.11: a closed-lock
          "Suspend" action for an active device account, an open-lock
          "Unsuspend" for a suspended one -- never rendered at all for an
          orphaned device account (Requirement 4.1), which the caller
          expresses by simply not passing `onSuspend`. Mirrors
          `MemberActions.jsx`'s identical `onSuspend`/`accountStatus`
          convention exactly. */}
      {onSuspend && (
        <button
          type="button"
          onClick={() => onSuspend(device)}
          className={`${boxClass} ${neutralClass}`}
          title={accountStatus === 'suspended' ? 'Unsuspend device account' : 'Suspend device account'}
          aria-label={accountStatus === 'suspended' ? `Unsuspend device account ${deviceDisplayName(device)}` : `Suspend device account ${deviceDisplayName(device)}`}
        >
          {accountStatus === 'suspended' ? (
            <LockOpenIcon className={iconSizeClass} aria-hidden="true" />
          ) : (
            <LockClosedIcon className={iconSizeClass} aria-hidden="true" />
          )}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDelete(device)}
        className={`${boxClass} ${dangerClass}`}
        title="Delete device"
        aria-label={`Delete device ${deviceDisplayName(device)}`}
      >
        <TrashIcon className={iconSizeClass} aria-hidden="true" />
      </button>
    </div>
  )
}

export default function TeamDeviceList({ teamId, onEnroll, user, onCountChange }) {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [editingDeviceId, setEditingDeviceId] = useState(null)
  const [editForm, setEditForm] = useState({ deviceLabel: '', callsignSuffix: '' })
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState(null)
  const [transferringDevice, setTransferringDevice] = useState(null)
  const [deletingDevice, setDeletingDevice] = useState(null)
  const [deleting, setDeleting] = useState(false)
  // account-lifecycle-management Requirement 1.11: the Team Devices row
  // whose Suspend/Unsuspend confirmation is open, or null when closed.
  // `{ device, mode }` mirrors `TeamDetail.jsx`'s own `suspendingMember`
  // shape exactly -- same reasoning: one shared dialog serves both
  // directions, and the row's current `accountStatus` decides which one
  // this action opens.
  const [suspendingDevice, setSuspendingDevice] = useState(null)

  const fetchDevices = useCallback(async () => {
    if (!teamId) {
      setDevices([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const response = await devicesAPI.getTeamDevices(teamId)
      setDevices(response.data?.devices ?? [])
      setError(null)
    } catch (err) {
      setDevices([])
      setError(interpretTeamDeviceListError(err))
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    fetchDevices()
  }, [fetchDevices])

  // Bugfix: the Team Devices tab showed no item count while every other
  // tab (Members/Team Admins/Channels/Sub-teams) did, an inconsistency
  // this list's own owner (`TeamDetail.jsx`) can't fix on its own -- it
  // never fetches this list itself, `TeamDeviceList` does. Reports the
  // TOTAL fetched count (`devices.length`, unfiltered by the search box)
  // whenever it changes, matching every other tab's own count -- which
  // is likewise the tab's full list length, not its filtered/paginated
  // subset. A single effect keyed on the actual state, rather than a
  // call at every `setDevices` call site, so the reported count can
  // never drift from what this component itself considers "the list".
  useEffect(() => {
    onCountChange?.(devices.length)
  }, [devices, onCountChange])

  if (!teamId) {
    return null
  }

  const filteredDevices = filterTeamDevices(devices, searchTerm)

  const handleStartEdit = (device) => {
    setEditingDeviceId(device.deviceUserId)
    setEditForm({ deviceLabel: device.deviceLabel || '', callsignSuffix: device.callsignSuffix || '' })
    setEditError(null)
  }

  const handleCancelEdit = () => {
    setEditingDeviceId(null)
    setEditError(null)
  }

  const handleSaveEdit = async (deviceUserId) => {
    if (!isValidTeamDeviceCallsignSuffix(editForm.callsignSuffix)) {
      setEditError('Callsign suffix may only contain letters, digits, "-", and "."')
      return
    }

    setSavingEdit(true)
    setEditError(null)
    try {
      const response = await devicesAPI.update(deviceUserId, {
        deviceLabel: editForm.deviceLabel,
        callsignSuffix: editForm.callsignSuffix
      })
      const updated = response.data.device
      setDevices((prev) => prev.map((d) => (d.deviceUserId === deviceUserId ? { ...d, ...updated } : d)))
      setEditingDeviceId(null)
    } catch (err) {
      setEditError(
        extractDeviceEditServerError(err) || err.response?.data?.error || 'Failed to update device'
      )
    } finally {
      setSavingEdit(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (!deletingDevice) return
    setDeleting(true)
    try {
      await devicesAPI.delete(deletingDevice.deviceUserId)
      setDevices((prev) => prev.filter((d) => d.deviceUserId !== deletingDevice.deviceUserId))
      toast.success('Device deleted')
      setDeletingDevice(null)
    } catch (err) {
      toast.error('Failed to delete device: ' + (err.response?.data?.error || err.message))
    } finally {
      setDeleting(false)
    }
  }

  // account-lifecycle-management Requirement 1.11: opens the Suspend/
  // Unsuspend confirmation for a device row, deriving `mode` from the
  // row's own `accountStatus` -- mirrors `TeamDetail.jsx`'s
  // `handleSuspendClick` exactly.
  const handleSuspendClick = (device) => {
    setSuspendingDevice({
      device,
      mode: device.accountStatus === 'suspended' ? 'unsuspend' : 'suspend'
    })
  }

  // TransferMemberDialog is generic over any `{id, first_name, last_name,
  // email, role}`-shaped object -- mechanically, a device is just another
  // `users.id` to it and to the server route it calls
  // (`POST /api/users/:userId/transfer`, `TeamTransferService
  // .executeTransfer`). This adapts a device row into that shape: `id` is
  // the device's `deviceUserId` (the SAME local `users.id` the transfer
  // route expects), `first_name` carries the Device_Display_Name so the
  // dialog's "Move X out of..." copy reads sensibly, `last_name`/`email`
  // are omitted (a device has neither), and `role` is always `'member'`
  // (a Team_Owned_Device is never an admin).
  function toTransferMember(device) {
    return {
      id: device.deviceUserId,
      first_name: deviceDisplayName(device),
      last_name: '',
      email: undefined,
      role: 'member'
    }
  }

  return (
    <div>
      {/* Bug #8: search input, matching the Members/Team Admins tabs'
          own `input`/count-summary row exactly. */}
      <div className="mb-4 flex items-center space-x-4">
        <div className="flex-1 relative">
          <MagnifyingGlassIcon className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
          <input
            type="text"
            placeholder="Search devices..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="input w-full max-w-md pl-9"
          />
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {filteredDevices.length} device{filteredDevices.length !== 1 ? 's' : ''}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">
          {error}
        </p>
      )}

      {loading ? (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
          <p className="text-gray-500 dark:text-gray-400 mt-2">Loading devices...</p>
        </div>
      ) : filteredDevices.length === 0 ? (
        !error && (
          <div className="text-center py-8">
            <p className="text-gray-500 dark:text-gray-400">
              {searchTerm ? 'No devices found matching your search.' : 'No devices are enrolled under this team.'}
            </p>
          </div>
        )
      ) : (
        <>
          {/* Bug #9: mobile card fallback below `sm:`, matching
              `DeviceListCard`'s pattern -- a divided list, never the
              table, on a narrow viewport.
              Bugfix (list-width reduction, consistency with the
              Members/Team Admins tabs' own card): device name +
              username stacked (matching the member card's name +
              username stacking), and "TAK Callsign & Role" -- the
              callsign at normal size, the TAK_Role small and without
              color underneath it -- replacing the old separate
              Device/Username-only shape. */}
          <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
            {filteredDevices.map((device) => (
              <div key={device.deviceUserId} className="p-4 space-y-2 text-sm">
                <div className="flex items-start gap-3 min-w-0">
                  <DeviceTabletIcon className="h-5 w-5 mt-0.5 text-gray-400 dark:text-gray-500 flex-shrink-0" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 dark:text-gray-100 break-all">
                      {deviceDisplayName(device)}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all">
                      {device.username}
                    </p>
                  </div>
                </div>
                {/* account-lifecycle-management Requirement 4.1-4.3
                    (task 8.2): mirrors TeamDetail.jsx's own Members/
                    Team Admins badge treatment. */}
                {describeAccountStatusBadge(device.accountStatus) && (
                  <span className={describeAccountStatusBadge(device.accountStatus).className}>
                    {describeAccountStatusBadge(device.accountStatus).label}
                  </span>
                )}
                <div>
                  <p className="text-gray-900 dark:text-gray-100">{device.callsign || '-'}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">{device.takRole || 'Team Member'}</p>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Added <FormattedDate value={device.createdAt} fallback="Unknown" precision={DATE_PRECISION.DATE} />
                </p>
                <MultipleCertificateWarning count={device.liveCertificateCount} />
                <DeviceActions
                  device={device}
                  onEdit={handleStartEdit}
                  onTransfer={setTransferringDevice}
                  onEnroll={onEnroll}
                  onDelete={setDeletingDevice}
                  onSuspend={device.accountStatus !== 'orphaned' ? handleSuspendClick : undefined}
                  accountStatus={device.accountStatus}
                  variant="card"
                />
              </div>
            ))}
          </div>

          {/* Bug #4/#9: desktop table, matching the Members/Team Admins
              tabs' own table structure -- `overflow-x-auto` wrapper,
              same header cell classes, same Actions column alignment.
              Bugfix (list-width reduction, consistency with the
              Members/Team Admins tabs): "Device" now shows the device
              name AND its username (stacked, matching a member's
              name+username stacking) in ONE column instead of two
              separate Device/Username columns, and "TAK Callsign &
              Role" replaces the plain "Added" being the only other
              informational column -- Added moves to its own column
              after it, matching this tab's requested Device+username /
              Callsign+Role / Added / Actions column order. */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Device
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    TAK Callsign & Role
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Added
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                {filteredDevices.map((device) => (
                  editingDeviceId === device.deviceUserId ? (
                    <DeviceEditRow
                      key={device.deviceUserId}
                      colSpan={4}
                      form={editForm}
                      setForm={setEditForm}
                      saving={savingEdit}
                      error={editError}
                      onSave={() => handleSaveEdit(device.deviceUserId)}
                      onCancel={handleCancelEdit}
                    />
                  ) : (
                    <tr key={device.deviceUserId} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-gray-100">
                        <div className="flex items-center gap-2">
                          <DeviceTabletIcon className="h-4 w-4 text-gray-400 dark:text-gray-500 flex-shrink-0" aria-hidden="true" />
                          <span className="break-all">{deviceDisplayName(device)}</span>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all ml-6">{device.username}</p>
                        {describeAccountStatusBadge(device.accountStatus) && (
                          <div className="ml-6 mt-1">
                            <span className={describeAccountStatusBadge(device.accountStatus).className}>
                              {describeAccountStatusBadge(device.accountStatus).label}
                            </span>
                          </div>
                        )}
                        <MultipleCertificateWarning count={device.liveCertificateCount} className="mt-1" />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <p className="text-gray-900 dark:text-gray-100">{device.callsign || '-'}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{device.takRole || 'Team Member'}</p>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        <FormattedDate value={device.createdAt} fallback="Unknown" precision={DATE_PRECISION.DATE} />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <DeviceActions
                          device={device}
                          onEdit={handleStartEdit}
                          onTransfer={setTransferringDevice}
                          onEnroll={onEnroll}
                          onDelete={setDeletingDevice}
                          onSuspend={device.accountStatus !== 'orphaned' ? handleSuspendClick : undefined}
                          accountStatus={device.accountStatus}
                        />
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Bugfix (#7): the same shared TransferMemberDialog the
          Members/Team Admins tabs use, adapted from a device row via
          `toTransferMember`. */}
      {transferringDevice && (
        <TransferMemberDialog
          member={toTransferMember(transferringDevice)}
          team={{ id: teamId }}
          user={user}
          onClose={() => setTransferringDevice(null)}
          onCompleted={() => {
            setTransferringDevice(null)
            fetchDevices()
          }}
        />
      )}

      {/* account-lifecycle-management Requirement 1.11: the same shared
          SuspendAccountDialog TeamDetail.jsx's Members/Team Admins tabs
          use. On completion, refetches this tab's own device list so the
          row reflects its new account_status without a full page
          reload -- this component owns its own fetch (see the doc
          comment above), so there is no parent-level refresh to lean on
          the way TeamDetail.jsx's `refreshMembersAfterSuspend` does. */}
      {suspendingDevice && (
        <SuspendAccountDialog
          mode={suspendingDevice.mode}
          targetUserId={suspendingDevice.device.deviceUserId}
          targetName={deviceDisplayName(suspendingDevice.device)}
          onClose={() => setSuspendingDevice(null)}
          onCompleted={fetchDevices}
        />
      )}

      {/* Bugfix (#7): delete confirmation, matching the Remove User
          confirmation dialog's own visual weight (danger button, red
          title) without the type-in-email step that dialog uses -- a
          device has no email to type. */}
      {deletingDevice && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-device-title"
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full"
          >
            <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
              <h3 id="delete-device-title" className="text-lg font-medium text-red-600 dark:text-red-400">
                Delete Device
              </h3>
              <button
                type="button"
                onClick={() => setDeletingDevice(null)}
                className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
                aria-label="Close"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>
            <div className="p-6">
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                Are you sure you want to permanently delete{' '}
                <span className="font-medium text-gray-900 dark:text-gray-100">{deviceDisplayName(deletingDevice)}</span>?
                This removes it from every team and channel, and deletes its account from the identity provider.
                This action cannot be undone.
              </p>
              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setDeletingDevice(null)}
                  className="btn-secondary"
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  disabled={deleting}
                  className="btn-danger disabled:opacity-50"
                >
                  {deleting ? 'Deleting...' : 'Delete Device'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
