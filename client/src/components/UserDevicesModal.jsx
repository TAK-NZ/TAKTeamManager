import { useState, useEffect, useCallback } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import { deviceManagementAPI } from '../services/api'
import RevokeDeviceDialog from './RevokeDeviceDialog'
import DeviceListRow, { DeviceListHeader, DeviceListCard, NEVER_SEEN_LABEL } from './DeviceListRow'

/**
 * Requirement 5.3 / 6.5: what a null `lastSeenAt` renders as, re-exported
 * from `DeviceListRow.jsx` where the row that renders it lives. Callers and
 * tests that already reach for it here keep working, and there is still only
 * one definition of the label (Requirement 16.6).
 */
export { NEVER_SEEN_LABEL }

/**
 * Turns a failed device-list fetch into the message shown inside the modal.
 *
 * The statuses mirror what `GET /api/device-management/users/:userId/devices`
 * can answer: `403` the target is not a Managed_User of the caller
 * (Requirements 6.6, 6.7 -- the server is the authority, so this is a normal
 * outcome the UI has to state plainly rather than an internal error), `404`
 * the feature being disabled server-side (the affordance is normally hidden
 * in that case, but the flag can flip between the probe and the fetch).
 * Anything else (5xx, a network failure) falls through to a generic message
 * rather than rendering an empty list, which would read as "no devices".
 *
 * Exported for direct unit testing, matching this project's convention of
 * testing extracted pure logic (see `RevokeDeviceDialog.jsx`'s helpers).
 *
 * @param {{response?: {status?: number, data?: object}}} error an axios error.
 * @returns {string} a user-facing message.
 */
export function interpretDeviceListError(error) {
  const status = error?.response?.status
  const serverMessage = error?.response?.data?.error

  if (status === 403) {
    return serverMessage || 'You can only view devices for users you directly manage.'
  }
  if (status === 404) {
    return 'Device management is not available.'
  }
  return 'Failed to load this user\'s devices. Please try again.'
}

/**
 * Whether Device_Management is reachable, for deciding if a device
 * affordance should be rendered at all.
 *
 * `DEVICE_MGMT_ENABLED` is deliberately never exposed through
 * `/api/config/public` (Requirement 1.4) and there is no `/enabled`
 * endpoint, so `deviceManagementAPI.probeEnabled()` uses the self-view
 * route as the probe: a 200 means the feature is live, a 404 means the flag
 * is off (see the notes in `services/api.js`).
 *
 * A real failure (5xx, network, 401/403) is swallowed here and treated as
 * "don't show the affordance". That is deliberate for a hook whose only job
 * is to decide whether to render an optional action: the host page has its
 * own primary data to surface errors for, and a broken probe must not put an
 * error on a page that is otherwise fine. The modal itself still reports any
 * fetch failure inline, so nothing is silently swallowed once the user has
 * actually asked to see a device list.
 *
 * Lives in this file rather than in a util of its own so that the single
 * import that gives a page the modal also gives it the gate the modal needs
 * -- both attach sites (`Users.jsx`, `TeamDetail.jsx`) need exactly this
 * pair.
 *
 * @returns {boolean} true once the probe has confirmed the feature is on.
 */
export function useDeviceManagementEnabled() {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let cancelled = false

    deviceManagementAPI
      .probeEnabled()
      .then((result) => {
        if (!cancelled) {
          setEnabled(result.enabled)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEnabled(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  return enabled
}

/**
 * Requirements 6.3, 6.4, 6.5: the user-details device modal, shared by BOTH
 * admin surfaces.
 *
 * ONE component serves the Users view (`Users.jsx`, from a row action) and
 * the Orgs & Teams view (`TeamDetail.jsx`'s Members and Team Admins member
 * lists) -- the device list is not duplicated per surface. The two attach
 * sites differ only in which row they hand over, so the component takes just
 * the target user (`userId` + a display `userName`) and owns everything else:
 * the fetch, the table, and the admin Revoke flow. The rows themselves come
 * from `DeviceListRow.jsx`, shared with the Dashboard card, so the
 * Device_Type_Icon, the icon-only Revoke control, the "Revoked" badge and the
 * "never seen" rendering have one definition across both surfaces
 * (Requirement 16.6).
 *
 * `userId` is the LOCAL `users.id` (what `tak_devices.user_id` references and
 * what the route's `:userId` validates as an integer), NOT an Authentik id.
 *
 * Authorization is entirely the server's: the modal simply asks for the
 * user's devices and renders whatever comes back, so a target who is not a
 * Managed_User of the caller produces a `403` shown inline (Requirements 6.6,
 * 6.7). Nothing here is a security control.
 *
 * Revocation reuses `RevokeDeviceDialog` with `userId` passed through, which
 * is what selects that dialog's admin flow (`revokeUserDevice`) over the
 * self-service one.
 *
 * @param {object} props
 * @param {number|string} props.userId LOCAL `users.id` of the target user.
 * @param {string} [props.userName] display name shown in the title and in
 *   the revoke confirmation prompt.
 * @param {() => void} props.onClose
 */
export default function UserDevicesModal({ userId, userName, onClose }) {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [deviceToRevoke, setDeviceToRevoke] = useState(null)

  const targetName = userName || 'this user'

  const fetchDevices = useCallback(async () => {
    setLoading(true)
    try {
      const response = await deviceManagementAPI.getUserDevices(userId)
      setDevices(response.data?.devices ?? [])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch user devices:', err)
      setDevices([])
      setError(interpretDeviceListError(err))
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    fetchDevices()
  }, [fetchDevices])

  // Escape closes the modal, matching every other dialog in this app. The
  // revoke dialog renders on top and handles its own Escape, so it is closed
  // first by its own handler.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !deviceToRevoke) {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, deviceToRevoke])

  return (
    <>
      {/* Bugfix: full-bleed on mobile, matching the app-wide modal
          treatment -- see RevokeDeviceDialog.jsx's identical comment. */}
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="user-devices-title"
          className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-3xl sm:h-auto sm:max-h-[90vh] overflow-y-auto"
        >
          <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
            <div>
              <h3 id="user-devices-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Devices
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">{targetName}</p>
            </div>
            {/* Bugfix (mobile tap target too small): p-2 rounded-lg box
                around the icon, matching every other modal's close
                button in this app -- was a bare h-6 w-6 icon with no
                padding. */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close devices dialog"
              className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
            >
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>

          <div className="p-6">
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
                  No devices are enrolled under this user&apos;s name.
                </p>
              )
            ) : (
              <>
                {/* Below `sm`: same stacked-card fallback as the Dashboard
                    "My Devices" card -- see `DeviceListRow.jsx`'s
                    `DeviceListCard` doc comment. */}
                <div className="sm:hidden divide-y divide-gray-200 dark:divide-gray-700">
                  {devices.map((device) => (
                    <DeviceListCard
                      key={device.clientUid}
                      device={device}
                      onRevoke={setDeviceToRevoke}
                    />
                  ))}
                </div>
                <div className="hidden sm:block overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    {/* Requirements 15.6, 16.1-16.6: header and rows both come from
                        `DeviceListRow.jsx`, the single definition this modal shares
                        with the Dashboard "My Devices" card -- including the
                        Device_Type_Icon, the icon-only Revoke action, the "Revoked"
                        badge, and the "never seen" Last_Seen fallback (Req 6.5).
                        `compact` is the only difference between the two surfaces:
                        this table sits inside a dialog. */}
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <DeviceListHeader compact />
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                      {devices.map((device) => (
                        <DeviceListRow
                          key={device.clientUid}
                          device={device}
                          onRevoke={setDeviceToRevoke}
                          compact
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          <div className="flex justify-end p-6 border-t border-gray-200 dark:border-gray-700">
            <button type="button" onClick={onClose} className="btn-secondary px-4 py-2">
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Requirements 8.2, 8.3: the shared REVOKE type-in confirmation dialog.
          Passing `userId` selects its admin flow (`revokeUserDevice`). The
          revocation is queued, not applied, so the refreshed list may still
          show the device until the Sync_Worker confirms it. */}
      {deviceToRevoke && (
        <RevokeDeviceDialog
          device={deviceToRevoke}
          userId={userId}
          userName={userName}
          onClose={() => setDeviceToRevoke(null)}
          onRevoked={fetchDevices}
        />
      )}
    </>
  )
}
