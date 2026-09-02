import { useState, useEffect, useCallback } from 'react'
import { XMarkIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { globalChannelsAPI } from '../services/api'

/**
 * Bugfix (BCH credentials modal: "cycle the password" / "delete the
 * service account"): both actions act on a real Authentik identity
 * (a live credential in one case, the identity itself in the other), so
 * both get this app's type-to-confirm tier -- explicitly requested,
 * and consistent with `SuspendAccountDialog.jsx`'s own reasoning for why
 * a one-way, credential-affecting action warrants typed confirmation
 * even when the surrounding row survives. The literal to type is the
 * service account's own USERNAME (never a static word): mirrors
 * `SuspendAccountDialog.jsx`'s `targetUsername` convention -- the
 * stable identifying field the surrounding UI already shows as this
 * row's primary label -- rather than `RevokeDeviceDialog.jsx`'s
 * narrower static `REVOKE` literal, which exists there specifically
 * because a device revocation already commits to one unambiguous
 * target with no name a typed value could usefully resolve.
 *
 * One component serves both actions (mirroring `SuspendAccountDialog.jsx`'s
 * own suspend/unsuspend `mode` prop) because they differ only in which
 * endpoint they hit and their copy; the type-to-confirm mechanics,
 * warning banner, and inline error handling are identical.
 *
 * @param {object} props
 * @param {'rotate'|'delete'} props.mode
 * @param {number|string} props.channelId
 * @param {string} props.channelName shown in the prompt.
 * @param {string} props.serviceAccountUsername the value the admin must
 *   type exactly to confirm.
 * @param {() => void} props.onClose
 * @param {() => void} [props.onCompleted] invoked after the App accepts
 *   the action, so the parent can refresh its channel list (a rotation
 *   invalidates the credentials dialog's displayed password; a deletion
 *   should close that dialog entirely -- both are the parent's job to
 *   react to, not this dialog's).
 */
export default function ServiceAccountActionConfirmDialog({
  mode,
  channelId,
  channelName,
  serviceAccountUsername,
  onClose,
  onCompleted
}) {
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [confirmInput, setConfirmInput] = useState('')

  const isDelete = mode === 'delete'

  const handleClose = useCallback(() => {
    if (!submitting) {
      onClose()
    }
  }, [submitting, onClose])

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

  const confirmed = confirmInput === serviceAccountUsername

  const handleConfirm = async () => {
    if (!confirmed || submitting) {
      return
    }

    setSubmitting(true)
    setServerError(null)

    try {
      if (isDelete) {
        await globalChannelsAPI.deleteServiceAccount(channelId)
        toast.success(`Service account "${serviceAccountUsername}" deletion queued`)
      } else {
        await globalChannelsAPI.rotateServiceAccountPassword(channelId)
        toast.success(`Password rotation queued for "${serviceAccountUsername}"`)
      }
      setConfirmInput('')
      onCompleted?.()
      onClose()
    } catch (error) {
      setServerError(error.response?.data?.error || `Failed to ${isDelete ? 'delete service account' : 'rotate password'}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="service-account-action-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-lg sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="service-account-action-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {isDelete ? 'Delete Service Account' : 'Cycle Service Account Password'}
          </h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label={`Close ${isDelete ? 'delete service account' : 'cycle password'} dialog`}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {isDelete ? (
              <>
                Delete the service account for{' '}
                <span className="font-medium text-gray-900 dark:text-gray-100 break-words">{channelName}</span>?
              </>
            ) : (
              <>
                Generate a new password for {channelName}&apos;s service account?
              </>
            )}
          </p>

          <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3 flex items-start space-x-2">
            <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              {isDelete
                ? 'This removes the Authentik service account entirely. Any external process using its credentials loses access immediately. The channel and its read/write groups are unaffected -- a new service account can be added afterwards.'
                : 'The current password stops working immediately once this is applied in Authentik. Any external process using it will need the new password shown after this completes.'}
            </p>
          </div>

          <div>
            <label htmlFor="service-account-action-confirm" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Type <span className="font-mono font-bold text-gray-900 dark:text-gray-100 break-all">{serviceAccountUsername}</span> to confirm:
            </label>
            <input
              id="service-account-action-confirm"
              type="text"
              className="input w-full"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={serviceAccountUsername}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={submitting}
            />
          </div>

          {serverError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {serverError}
            </p>
          )}

          <div className="flex justify-end space-x-3 pt-2 border-t border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={() => {
                setConfirmInput('')
                handleClose()
              }}
              disabled={submitting}
              className="btn-secondary px-4 py-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!confirmed || submitting}
              className={isDelete ? 'btn-danger disabled:opacity-50 disabled:cursor-not-allowed' : 'btn-primary disabled:opacity-50 disabled:cursor-not-allowed'}
            >
              {submitting
                ? (isDelete ? 'Deleting...' : 'Rotating...')
                : (isDelete ? 'Delete Service Account' : 'Cycle Password')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
