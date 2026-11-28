import { useState, useEffect, useCallback } from 'react'
import { XMarkIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { usersAPI } from '../services/api'
/**
 * Confirmation dialog for resetting a person's MFA, shared by the Users page and the team member lists.
 *
 * The reset removes the person's password, passkeys, authenticator apps and recovery codes, signs them out everywhere,
 * and emails them a new one-time link to set up their sign-in again. The email address on file is not proof of who is
 * asking (the person may have lost access to it too), so the administrator must tick that they have checked who the
 * person is, and the server refuses a request that does not say so.
 *
 * @param {object} props
 * @param {number} props.targetUserId the local `users.id`
 * @param {string} [props.targetName] display name shown in the prompt
 * @param {string} [props.targetEmail] the address the new link is sent to
 * @param {() => void} props.onClose
 * @param {() => void} [props.onCompleted] called after the server accepted the reset, so the parent can refresh
 */
export default function ResetMfaDialog({ targetUserId, targetName, targetEmail, onClose, onCompleted }) {
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState(null)
  const [identityChecked, setIdentityChecked] = useState(false)
  const displayName = targetName || 'this person'
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
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleClose])
  const handleConfirm = async () => {
    if (submitting || !identityChecked) {
      return
    }
    setSubmitting(true)
    setServerError(null)
    try {
      await usersAPI.resetMfa(targetUserId, true)
      toast.success('MFA reset. A new sign-in link was emailed.')
      onCompleted?.()
      onClose()
    } catch (error) {
      setServerError(error.response?.data?.error || 'Failed to reset MFA')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-mfa-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-lg sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="reset-mfa-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Reset MFA
          </h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close reset MFA dialog"
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Reset the sign-in methods of <span className="font-medium text-gray-900 dark:text-gray-100">{displayName}</span>?
          </p>
          <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3 flex items-start space-x-2">
            <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-sm text-amber-800 dark:text-amber-300">
              This removes their password, passkeys, authenticator apps and recovery codes, signs them out everywhere, and
              emails {targetEmail ? <span className="font-medium">{targetEmail}</span> : 'them'} a new one-time link (valid for 24 hours) to
              set up their sign-in again. Use it when they have lost every way of signing in.
            </p>
          </div>
          <label className="flex items-start space-x-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              id="reset-mfa-identity"
              type="checkbox"
              className="mt-1"
              checked={identityChecked}
              onChange={(e) => setIdentityChecked(e.target.checked)}
              disabled={submitting}
            />
            <span>
              I have checked that the person asking is {displayName}, for example by speaking to them on a number I already
              had. The email address on file is not enough, because they may have lost access to it as well.
            </span>
          </label>
          {serverError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {serverError}
            </p>
          )}
          <div className="flex justify-end space-x-3 pt-2 border-t border-gray-200 dark:border-gray-700">
            <button type="button" onClick={handleClose} disabled={submitting} className="btn-secondary px-4 py-2">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={submitting || !identityChecked}
              className="btn-danger disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Resetting...' : 'Reset MFA'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
