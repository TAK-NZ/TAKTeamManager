import { useState, useEffect, useCallback } from 'react'
import { DeviceTabletIcon } from '@heroicons/react/24/outline'
import { devicesAPI } from '../services/api'
import FormattedDate, { DATE_PRECISION } from './FormattedDate'
import MultipleCertificateWarning from './MultipleCertificateWarning'

/**
 * takserver-enrollment Requirements 5.9, 5.10, 14.7 (task 11.2): the
 * team-device surface that keeps a Team_Owned_Device reachable despite
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
 * already owns.
 *
 * ## Layout: no `overflow-x-auto` table, no vertically-opening tooltip
 *
 * This surface renders as a divided list (`divide-y`), not a `<table>`
 * wrapped in `overflow-x-auto` -- there is no wide row here that would
 * need horizontal scrolling, and the client convention is that tooltips in
 * this codebase open SIDEWAYS ONLY (`left-full`/`ml-2` or
 * `right-full`/`mr-2` plus `top-1/2 -translate-y-1/2`), because a box with
 * one overflow axis `auto` and the other `visible` clips on BOTH axes
 * (the Tooltip_Clipping_Defect `DeviceTypeIcon.jsx` records in full). This
 * component adds no tooltip of its own -- the dates it renders go through
 * `<FormattedDate>`, whose OWN Date_Tooltip already follows that rule --
 * but it inherits the constraint anyway: no ancestor of this component may
 * introduce the `overflow-x-auto` + vertical-tooltip combination that
 * causes it.
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

export default function TeamDeviceList({ teamId, onEnroll }) {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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

  if (!teamId) {
    return null
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Devices</h2>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {devices.length} device{devices.length !== 1 ? 's' : ''}
        </span>
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
      ) : devices.length === 0 ? (
        !error && (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No devices are enrolled under this team.
          </p>
        )
      ) : (
        // A divided LIST, not a `<table>` wrapped in `overflow-x-auto` -- see
        // the file header. Each row carries the Device_Display_Name and the
        // Managed_Identifier as two separate labelled fields, never an email.
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {devices.map((device) => (
            <li
              key={device.deviceUserId}
              className="py-3 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="flex items-start gap-3 min-w-0">
                <DeviceTabletIcon
                  className="h-5 w-5 mt-0.5 text-gray-400 dark:text-gray-500 flex-shrink-0"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-all">
                    {deviceDisplayName(device)}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 font-mono break-all">
                    {device.username}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Added <FormattedDate value={device.createdAt} fallback="Unknown" precision={DATE_PRECISION.DATE} />
                  </p>
                  <MultipleCertificateWarning count={device.liveCertificateCount} className="mt-1" />
                </div>
              </div>
              <button
                type="button"
                onClick={() => onEnroll?.(device)}
                className="btn-secondary text-sm flex-shrink-0"
              >
                Enroll
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
