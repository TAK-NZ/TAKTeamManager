import { useState, useEffect, useCallback } from 'react'
import { XMarkIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { deviceManagementAPI } from '../services/api'

/**
 * Requirements 7.2, 8.2: the exact literal a user must type to confirm a
 * revocation. It is deliberately NOT the device UID -- the requirement names
 * this fixed word, and a UID (TAK-supplied free-form text) would be
 * copy-pasteable and therefore no confirmation at all.
 *
 * Compared with strict `===` and with no trimming or case folding, so
 * `'revoke'`, `' REVOKE'`, and `'REVOKE '` all leave the confirm button
 * disabled -- matching the server's own `confirmation === 'REVOKE'` check so
 * the client never enables a submit the server would reject.
 */
export const REVOKE_CONFIRMATION_WORD = 'REVOKE'

/**
 * Requirements 7.2, 8.2: the warning shown for every revocation. Revocation
 * is not reversible from this app -- the certificate is revoked on TAK Server
 * and the device has to be enrolled again to get a new one.
 */
export const REVOKE_WARNING_STATEMENT =
  'Revoking is permanent. The device loses access to TAK Server immediately and must be enrolled again to reconnect.'

/**
 * Requirements 7.3, 8.3: whether the typed text authorises the revocation.
 *
 * The client check is a convenience only -- it keeps the operator from firing
 * a request the server will reject, and nothing more. The server re-validates
 * the same equality before it enqueues anything, so a client that bypasses
 * this (devtools, a hand-rolled request) gains nothing.
 *
 * Exported for direct unit testing, matching this project's convention of
 * testing extracted pure logic rather than only rendering a component (see
 * `TransferMemberDialog.jsx`'s exported helpers).
 *
 * @param {string|null|undefined} text the raw input value.
 * @returns {boolean} true only when `text` is exactly `REVOKE`.
 */
export function isRevokeConfirmed(text) {
  return text === REVOKE_CONFIRMATION_WORD
}

/**
 * Turns a failed revoke into the message shown inline, keeping the dialog
 * open so the operator can see why nothing happened without losing the
 * dialog's context.
 *
 * The statuses mirror what the route can answer: `400` a rejected
 * confirmation (reachable only if the client check was bypassed), `403` a
 * device that isn't the caller's own / isn't a Managed_User's, `404` the
 * feature being disabled server-side or the device no longer existing.
 * Anything else (5xx, a network failure) falls through to a generic message
 * rather than rendering nothing.
 *
 * @param {{response?: {status?: number, data?: object}}} error an axios error.
 * @returns {string} a user-facing message.
 */
export function interpretRevokeError(error) {
  const status = error?.response?.status
  const serverMessage = error?.response?.data?.error

  if (serverMessage) {
    return serverMessage
  }

  switch (status) {
    case 400:
      return `Type ${REVOKE_CONFIRMATION_WORD} exactly to confirm.`
    case 403:
      return 'You are not allowed to revoke this device.'
    case 404:
      return 'This device is no longer available.'
    default:
      return 'Failed to revoke the device. Please try again.'
  }
}

/**
 * Requirements 7.2, 7.3, 8.2, 8.3: the REVOKE type-in confirmation dialog,
 * shared by BOTH revocation surfaces.
 *
 * One component serves both because the two flows differ only in which
 * endpoint they hit: `userId` selects it. Omit `userId` (or pass a nullish
 * value) and the dialog calls `revokeMyDevice` for the signed-in user's own
 * device -- what the Dashboard "My Devices" card wants. Pass `userId` and it
 * calls `revokeUserDevice` for that Managed_User -- what `UserDevicesModal`
 * wants. Everything else (the warning, the strict type-in gate, the disabled
 * confirm button, the inline error handling) is identical, so nothing else
 * needs to be parameterised and neither caller injects its own request.
 *
 * Both endpoints are authorised server-side (own-device ownership for self,
 * Managed_User + device ownership for admin), so passing a `userId` the
 * caller isn't entitled to simply produces a `403` rendered inline.
 *
 * Uses no native `confirm`/`alert` -- those were deliberately removed from
 * this codebase in favour of in-page dialogs and `react-hot-toast`.
 *
 * @param {object} props
 * @param {{clientUid: string}} props.device the device row being revoked.
 *   Only `clientUid` is used; it is echoed back so the operator can see which
 *   device they are about to disable.
 * @param {number|string|null} [props.userId] the Managed_User who owns the
 *   device, for the admin flow. Omit for the self-service flow.
 * @param {string} [props.userName] the target user's display name, shown in
 *   the admin flow's prompt. Ignored when `userId` is omitted.
 * @param {() => void} props.onClose
 * @param {() => void} [props.onRevoked] invoked after the App accepts the
 *   revocation (HTTP 202), so the parent can refresh its device list. The
 *   Revoke_Operation is queued, not yet applied, so a refreshed list may
 *   still show the device until the worker confirms the revocation.
 */
export default function RevokeDeviceDialog({ device, userId, userName, onClose, onRevoked }) {
  const [confirmationText, setConfirmationText] = useState('')
  const [serverError, setServerError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const clientUid = device?.clientUid
  const isAdminRevoke = userId != null
  const targetName = userName || 'this user'

  const handleClose = useCallback(() => {
    if (!submitting) {
      onClose()
    }
  }, [submitting, onClose])

  // Escape closes the dialog, matching the expectation for any modal; the
  // guard in `handleClose` keeps it from abandoning an in-flight submit.
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        handleClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleClose])

  const confirmed = isRevokeConfirmed(confirmationText)

  const handleSubmit = async (e) => {
    e.preventDefault()

    // Requirements 7.3, 8.3: never send a request whose confirmation the
    // server would reject. The submit button is disabled in this state, so
    // this is the belt to that braces.
    if (!confirmed || submitting) {
      return
    }

    setSubmitting(true)
    setServerError(null)

    try {
      // The literal is sent, not the raw input: the two are equal by the
      // check above, and sending the constant makes the wire payload
      // independent of anything the input could carry.
      if (isAdminRevoke) {
        await deviceManagementAPI.revokeUserDevice(userId, clientUid, REVOKE_CONFIRMATION_WORD)
      } else {
        await deviceManagementAPI.revokeMyDevice(clientUid, REVOKE_CONFIRMATION_WORD)
      }

      toast.success('Revocation queued. The device loses access shortly.')
      if (onRevoked) {
        onRevoked()
      }
      onClose()
    } catch (error) {
      console.error('Failed to revoke device:', error)
      setServerError(interpretRevokeError(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // Bugfix: full-bleed on mobile (h-full w-full, no rounding,
    // sm:p-4 on the overlay), matching the full-screen-on-mobile
    // treatment every other modal in this app now uses -- this one is
    // small enough to fit a phone viewport unscrolled already, but a
    // consistent modal presentation across the app is worth more than
    // this one dialog keeping its old floating-card look below `sm:`.
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="revoke-device-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-lg sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="revoke-device-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Revoke Device
          </h3>
          {/* Bugfix (mobile tap target too small): p-2 rounded-lg box
              around the icon, matching every other modal's close button
              in this app -- was a bare h-6 w-6 icon with no padding at
              all, a ~24px hit target. */}
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close revoke dialog"
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {isAdminRevoke ? (
              <>
                Revoke the certificate of{' '}
                <span className="font-medium text-gray-900 dark:text-gray-100">{targetName}</span>&apos;s device{' '}
              </>
            ) : (
              <>Revoke the certificate of your device </>
            )}
            <span className="font-medium text-gray-900 dark:text-gray-100 break-all">{clientUid}</span>.
          </p>

          {/* Requirements 7.2, 8.2 */}
          <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3 flex items-start space-x-2">
            <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              {REVOKE_WARNING_STATEMENT}
            </p>
          </div>

          <div>
            <label htmlFor="revoke-confirmation" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Type <span className="font-mono font-semibold">{REVOKE_CONFIRMATION_WORD}</span> to confirm *
            </label>
            <input
              id="revoke-confirmation"
              type="text"
              value={confirmationText}
              onChange={(e) => setConfirmationText(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby="revoke-confirmation-help"
              className="input w-full"
              placeholder={REVOKE_CONFIRMATION_WORD}
            />
            <p id="revoke-confirmation-help" className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Must match exactly, in capitals. This is not the device UID.
            </p>
          </div>

          {serverError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {serverError}
            </p>
          )}

          <div className="flex justify-end space-x-3 pt-2 border-t border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="btn-secondary px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!confirmed || submitting}
              className="btn-danger disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Revoking...' : 'Revoke Device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
