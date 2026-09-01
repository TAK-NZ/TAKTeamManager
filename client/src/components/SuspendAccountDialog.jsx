import { useState, useEffect, useCallback } from 'react'
import { XMarkIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { usersAPI } from '../services/api'

/**
 * account-lifecycle-management Requirement 1: the Suspend/Unsuspend
 * confirmation dialog, shared by the Members/Team Admins/Team Devices
 * action groups (mirroring `RevokeDeviceDialog.jsx`'s "one dialog serves
 * both a suspend-shaped and an unsuspend-shaped call" pattern -- `mode`
 * selects which of `usersAPI.suspendAccount`/`unsuspendAccount` is called
 * and which copy is shown).
 *
 * Bugfix (consistency with "Permanently Delete User"/"Delete Channel"):
 * Suspend now requires the admin to TYPE the target's username exactly,
 * matching this app's established type-to-confirm pattern for
 * destructive-*feeling* actions -- locking someone's account out and
 * revoking every live certificate they hold is disruptive enough to
 * warrant the same friction, even though it is fully reversible.
 * Unsuspend stays a plain Cancel/Confirm pair (no type-to-confirm input):
 * it undoes exactly that disruption rather than causing it, matching how
 * "Remove as admin" (reversible -- simply re-promote) never grew a
 * type-to-confirm requirement either. `targetUsername` -- the value the
 * admin must type -- is the account's own `username` column (present for
 * BOTH a human row and a Team_Owned_Device row, unlike `email`, which
 * the Device_Email_Null_Invariant allows to be null for a device), the
 * SAME field `AccountLifecycleService.suspendAccount` itself reads to
 * build the Revoke_Operation payload.
 *
 * The warning statement below is still explicit about what suspending
 * DOES (locks the Authentik account, revokes every live TAK Server
 * certificate) so an admin cannot mistake it for a purely-cosmetic
 * status flip.
 *
 * @param {object} props
 * @param {'suspend'|'unsuspend'} props.mode
 * @param {number} props.targetUserId the local `users.id` being
 *   suspended/unsuspended.
 * @param {string} [props.targetName] the target's display name, shown in
 *   the prompt. Falls back to a generic phrase when omitted.
 * @param {string} [props.targetUsername] the target's `username` column
 *   -- REQUIRED for `mode="suspend"` (the Confirm button stays disabled
 *   with no value to match against if omitted); unused for
 *   `mode="unsuspend"`, which has no type-to-confirm input at all.
 * @param {() => void} props.onClose
 * @param {() => void} [props.onCompleted] invoked after the App accepts
 *   the action (HTTP 200), so the parent can refresh its list.
 */
export default function SuspendAccountDialog({ mode, targetUserId, targetName, targetUsername, onClose, onCompleted }) {
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [confirmInput, setConfirmInput] = useState('')

  const isSuspend = mode === 'suspend'
  const displayName = targetName || 'this account'

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

  const handleConfirm = async () => {
    if (submitting) {
      return
    }

    setSubmitting(true)
    setServerError(null)

    try {
      if (isSuspend) {
        await usersAPI.suspendAccount(targetUserId)
      } else {
        await usersAPI.unsuspendAccount(targetUserId)
      }

      toast.success(isSuspend ? 'Account suspended' : 'Account unsuspended')
      setConfirmInput('')
      onCompleted?.()
      onClose()
    } catch (error) {
      const message = error.response?.data?.error || `Failed to ${isSuspend ? 'suspend' : 'unsuspend'} account`
      setServerError(message)
    } finally {
      setSubmitting(false)
    }
  }

  // Only Suspend requires typing the username; Unsuspend's Confirm button
  // is never gated by `confirmInput` at all (see the dialog's own doc
  // comment for why the two modes carry different friction).
  const confirmDisabled = submitting || (isSuspend && confirmInput !== targetUsername)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="suspend-account-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-lg sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="suspend-account-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {isSuspend ? 'Suspend Account' : 'Unsuspend Account'}
          </h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label={`Close ${isSuspend ? 'suspend' : 'unsuspend'} dialog`}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {isSuspend ? (
              <>
                Suspend <span className="font-medium text-gray-900 dark:text-gray-100">{displayName}</span>?
              </>
            ) : (
              <>
                Unsuspend <span className="font-medium text-gray-900 dark:text-gray-100">{displayName}</span>?
              </>
            )}
          </p>

          <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3 flex items-start space-x-2">
            <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              {isSuspend
                ? 'This locks their Authentik account and revokes every live TAK Server certificate they currently hold. It can be undone later, but a revoked certificate cannot be restored -- re-enrollment issues a new one.'
                : 'This unlocks their Authentik account. No certificate is restored automatically -- if they need one again, they (or an admin) will need to re-enroll.'}
            </p>
          </div>

          {isSuspend && (
            <div>
              <label htmlFor="suspend-account-confirm" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Type <span className="font-mono font-bold text-gray-900 dark:text-gray-100">{targetUsername}</span> to confirm:
              </label>
              <input
                id="suspend-account-confirm"
                type="text"
                className="input w-full"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={targetUsername}
                autoComplete="off"
                disabled={submitting}
              />
            </div>
          )}

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
              disabled={confirmDisabled}
              className={isSuspend ? 'btn-danger disabled:opacity-50 disabled:cursor-not-allowed' : 'btn-primary disabled:opacity-50 disabled:cursor-not-allowed'}
            >
              {submitting
                ? (isSuspend ? 'Suspending...' : 'Unsuspending...')
                : (isSuspend ? 'Suspend Account' : 'Unsuspend Account')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
