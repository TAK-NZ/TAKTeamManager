import { useState, useEffect, useRef, useCallback } from 'react'
import { XMarkIcon, ExclamationTriangleIcon, CheckCircleIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { globalChannelsAPI } from '../services/api'
import {
  SERVICE_ACCOUNT_USERNAME_PREFIX,
  isValidServiceAccountUsernameSuffix,
  buildServiceAccountUsername,
  slugifyChannelName
} from '../utils/serviceAccountUsername'

// Bugfix (collision/takeover risk): how long to wait after the admin
// stops typing before firing the live availability check -- long enough
// that a fast typist doesn't fire one request per keystroke, short
// enough that the result feels immediate once they pause. Exported so
// the test file can wait exactly this long rather than an arbitrary
// guess.
export const AVAILABILITY_CHECK_DEBOUNCE_MS = 400

/**
 * Bugfix (a BCH/UTL channel imported via "Sync Existing Channels" has no
 * service account; explicit request): replaces the previous one-click
 * "Provision Service Account" action with a dialog that lets the admin
 * name it. The `etl-` prefix is fixed, non-editable UI -- rendered as
 * plain text beside the input, never part of the input's own value -- so
 * there is no way for the submitted name to NOT carry it, matching the
 * explicit "the etl- prefix should still be enforced" requirement. The
 * server re-validates the same rule independently
 * (`server/utils/serviceAccountUsername.js`'s `isValidServiceAccountUsername`)
 * -- this dialog's own live validation is a UX convenience, not the
 * enforcement point.
 *
 * Bugfix (collision/takeover risk): also runs a debounced live
 * availability check (`globalChannelsAPI.checkServiceAccountAvailability`)
 * against both this app's own `bch_channels` table and Authentik itself,
 * surfacing a collision inline BEFORE the admin can click "Add Service
 * Account" -- submit stays disabled until the CURRENT suffix has been
 * confirmed available. This is still only the UX layer: the server's
 * `provisionServiceAccount` re-checks availability of its own accord
 * immediately before provisioning, since the gap between this dialog's
 * last check and the actual submit is a real (if narrow) race.
 *
 * Modelled on `SuspendAccountDialog.jsx`'s shape (header + body + footer,
 * Escape-to-close guarded against an in-flight submit, inline server
 * error), since this is a plain single-field form dialog rather than a
 * type-to-confirm destructive action.
 *
 * @param {object} props
 * @param {number|string} props.channelId
 * @param {string} props.channelName shown in the prompt, e.g. "Data Packages".
 * @param {() => void} props.onClose
 * @param {() => void} [props.onCompleted] invoked after the App accepts
 *   the provisioning request, so the parent can refresh its channel list.
 */
export default function AddServiceAccountDialog({ channelId, channelName, onClose, onCompleted }) {
  // Bugfix (explicit request): pre-fills with the channel-name-derived
  // recommendation (e.g. "InReach Devices" -> "inreach-devices") rather
  // than starting empty -- the admin can still edit it before submitting.
  // `useState(() => ...)` computes this once, from the channelName this
  // dialog was opened with, rather than recomputing on every render.
  const [suffix, setSuffix] = useState(() => slugifyChannelName(channelName))
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState(null)
  // Bugfix (collision/takeover risk): the live availability check's
  // result for the CURRENT suffix -- 'checking' | 'available' |
  // 'unavailable' | 'unknown'. 'unknown' covers both "not checked yet"
  // (an empty/invalid suffix, or before the debounce has fired even
  // once) and "the check itself failed" (e.g. a network error): in
  // NEITHER case does this dialog claim a name is available when it
  // hasn't actually confirmed that, so submit stays disabled rather than
  // defaulting to permissive.
  const [availability, setAvailability] = useState('unknown')
  const [availabilityReason, setAvailabilityReason] = useState(null)
  const debounceTimerRef = useRef(null)
  // Guards against a stale, slower-to-resolve check overwriting a more
  // recent one's result if requests resolve out of order.
  const latestCheckedSuffixRef = useRef(null)

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

  const suffixValid = isValidServiceAccountUsernameSuffix(suffix)

  // Bugfix (collision/takeover risk): fires the live availability check
  // AVAILABILITY_CHECK_DEBOUNCE_MS after the admin stops typing a
  // format-valid suffix. An invalid suffix resets straight to 'unknown'
  // with no request at all -- there is nothing useful to check yet, and
  // the format error is already shown by the existing help text/disabled
  // submit button.
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    if (!suffixValid) {
      setAvailability('unknown')
      setAvailabilityReason(null)
      return
    }

    setAvailability('checking')
    const username = buildServiceAccountUsername(suffix)

    debounceTimerRef.current = setTimeout(async () => {
      latestCheckedSuffixRef.current = suffix
      try {
        const response = await globalChannelsAPI.checkServiceAccountAvailability(username, channelId)
        // Ignore a resolved check for a suffix the admin has since typed
        // past -- the ref comparison, not a closure variable, is what
        // makes this correct across out-of-order resolution too.
        if (latestCheckedSuffixRef.current !== suffix) {
          return
        }
        if (response.data.available) {
          setAvailability('available')
          setAvailabilityReason(null)
        } else {
          setAvailability('unavailable')
          setAvailabilityReason(response.data.reason)
        }
      } catch {
        if (latestCheckedSuffixRef.current !== suffix) {
          return
        }
        // Fails closed: an inconclusive check is never treated as a pass
        // (see the `availability` state's own doc comment above).
        setAvailability('unknown')
        setAvailabilityReason(null)
      }
    }, AVAILABILITY_CHECK_DEBOUNCE_MS)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [suffix, suffixValid, channelId])

  const canSubmit = suffixValid && availability === 'available' && !submitting

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (!canSubmit) {
      return
    }

    setSubmitting(true)
    setServerError(null)

    const username = buildServiceAccountUsername(suffix)

    try {
      await globalChannelsAPI.provisionServiceAccount(channelId, username)
      toast.success(`Service account "${username}" queued for ${channelName}`)
      onCompleted?.()
      onClose()
    } catch (error) {
      setServerError(error.response?.data?.error || 'Failed to add service account')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-service-account-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-md sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="add-service-account-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Add Service Account
          </h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close add service account dialog"
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Create a service account for{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100 break-words">{channelName}</span>.
          </p>

          <div>
            <label htmlFor="service-account-suffix" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Service account name
            </label>
            {/* The etl- prefix is fixed, non-editable text -- never part of
                the input's own value -- so the submitted username is
                guaranteed to carry it regardless of what the admin types. */}
            <div className="flex items-stretch rounded-md overflow-hidden border border-gray-300 dark:border-gray-600 focus-within:ring-2 focus-within:ring-primary-500 focus-within:border-primary-500">
              <span className="inline-flex items-center px-3 bg-gray-100 dark:bg-gray-700 text-sm font-mono text-gray-600 dark:text-gray-300 border-r border-gray-300 dark:border-gray-600">
                {SERVICE_ACCOUNT_USERNAME_PREFIX}
              </span>
              <input
                id="service-account-suffix"
                type="text"
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
                disabled={submitting}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby="service-account-suffix-help"
                className="input flex-1 border-0 rounded-none focus:ring-0"
              />
            </div>
            <p id="service-account-suffix-help" className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Lowercase letters, digits and hyphens only.
            </p>
            {/* Bugfix (collision/takeover risk): the live availability
                check's result -- shown only once the suffix is
                format-valid (an invalid suffix already has its own help
                text above and nothing to check yet). 'checking' and
                'unknown' (a failed check) both render as a neutral
                in-progress note, never claiming a name is fine when it
                hasn't actually been confirmed. */}
            {suffixValid && availability === 'checking' && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Checking availability&hellip;</p>
            )}
            {suffixValid && availability === 'available' && (
              <p className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400 mt-1">
                <CheckCircleIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                Available
              </p>
            )}
            {suffixValid && availability === 'unavailable' && (
              <p role="alert" className="flex items-start gap-1 text-xs text-red-600 dark:text-red-400 mt-1">
                <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
                {availabilityReason || 'This name is already taken.'}
              </p>
            )}
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
              disabled={!canSubmit}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Adding...' : 'Add Service Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
