import { useEffect, useState } from 'react'
import { QrCodeIcon } from '@heroicons/react/24/outline'
import { deviceManagementAPI } from '../services/api'

/**
 * DeviceMgmtGate — wraps a page/surface that only works when TAK Server
 * device management is enabled server-side, rendering a clean
 * "not available" state instead of letting the page mount and hit a
 * `TAK_SERVER_ENROLLMENT_URL must be configured`-style error.
 *
 * WHY THIS EXISTS, AND WHY IT PROBES RATHER THAN READS A FLAG
 *
 * `DEVICE_MGMT_ENABLED` is deliberately NEVER exposed through
 * `GET /api/config/public` (it is a capability gate, not Presentation_Config
 * -- see feature-flags steering + SiteConfig). The client therefore cannot
 * ask "is this on?" up front; it discovers the feature by PROBING an actual
 * device-management route, whose handlers answer 404 while the flag is off.
 * `deviceManagementAPI.probeEnabled()` uses the self-view route as that probe
 * (200 = live, 404 = off), exactly as `useDeviceManagementEnabled`
 * (UserDevicesModal.jsx) does for the row-action buttons.
 *
 * TRI-STATE, unlike `useDeviceManagementEnabled`
 *
 * That hook collapses "still probing" and "confirmed off" into a single
 * `false`, which is right for an optional button (absent until confirmed on)
 * but wrong for a whole-page gate: rendering the "not available" panel while
 * the probe is still in flight would flash it on every normal load before the
 * real page appears. This gate keeps the three states distinct -- `loading`,
 * `enabled`, `disabled` -- so it shows a neutral spinner while probing, the
 * children once confirmed on, and the not-available panel only once the
 * server has actually reported the feature off.
 *
 * FAIL-CLOSED on a real error (5xx/network/401/403): treated as `disabled`,
 * matching the hook's own stance -- a broken probe hides a feature that may
 * not work rather than mounting a page that will error. `probeEnabled`
 * rethrows non-404 errors, so those land here in the `.catch`.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children the real surface, rendered only
 *   once the feature is confirmed enabled.
 * @param {string} [props.title] heading for the not-available panel.
 * @param {string} [props.message] body text for the not-available panel.
 */
export default function DeviceMgmtGate({
  children,
  title = 'Device management is not available',
  message = 'This deployment does not have TAK Server device management enabled, so device enrollment is unavailable. Contact your administrator if you believe this is a mistake.'
}) {
  // 'loading' | 'enabled' | 'disabled'
  const [state, setState] = useState('loading')

  useEffect(() => {
    let cancelled = false

    deviceManagementAPI
      .probeEnabled()
      .then((result) => {
        if (!cancelled) {
          setState(result.enabled ? 'enabled' : 'disabled')
        }
      })
      .catch(() => {
        // Fail closed: a non-404 failure (5xx/network/401/403) is treated as
        // "not available" rather than surfacing an error on a page that may
        // not be usable anyway.
        if (!cancelled) {
          setState('disabled')
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'loading') {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
      </div>
    )
  }

  if (state === 'disabled') {
    return (
      <div className="max-w-md mx-auto text-center py-16 px-4">
        <QrCodeIcon
          className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
          aria-hidden="true"
        />
        <h1 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{message}</p>
      </div>
    )
  }

  return children
}
