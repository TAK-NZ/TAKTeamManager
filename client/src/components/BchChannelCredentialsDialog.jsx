import { XMarkIcon, ClipboardDocumentIcon, ArrowPathIcon, TrashIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'

/**
 * Bugfix (/global-channels "Get credentials" button): the button previously
 * called `navigator.clipboard.writeText` directly with no visible feedback
 * beyond a toast, and did nothing at all visible for the (common) case of a
 * BCH/XtraTools channel with no service account configured -- reading as
 * "doesn't work". This dialog gives the action a visible surface, modelled
 * on the WinTAK/Manual tab's own Username/Password fields
 * (`EnrollmentView.jsx`): the username is shown as copyable plain text, the
 * password is masked behind a fixed run of bullet characters with its own
 * Copy button (never rendered as visible text), and each field's Copy
 * button copies the real value straight to the clipboard.
 *
 * Deliberately NO expiry countdown, unlike the enrollment tab's own
 * `EnrollmentCountdown`: a BCH service account's credentials are a static
 * username/password pair with no AUTOMATIC expiry mechanism (there is no
 * `expires_at` column, no scheduled rotation job) -- rendering a countdown
 * here would still be misleading, implying a rotation that happens on its
 * own. Rotation is instead a deliberate, admin-triggered action (see the
 * "Cycle Password" button below), not a timed one.
 *
 * Bugfix (explicit request): also surfaces "Cycle Password" and "Delete
 * Service Account" -- both dispatched via callback props rather than
 * calling the API directly here, so the PARENT owns opening
 * `ServiceAccountActionConfirmDialog.jsx` (the shared type-to-confirm
 * dialog for both actions) and can stack it above this one, then decide
 * what happens to THIS dialog once that confirm dialog completes (a
 * rotation invalidates the password currently shown here -- the parent
 * closes this dialog so a stale value is never left on screen; a deletion
 * removes the service account entirely, so the parent closes this dialog
 * for the same reason).
 *
 * @param {object} props
 * @param {string} props.channelName the channel this credential belongs to,
 *   shown in the dialog title.
 * @param {{service_account_username: string, service_account_password: string}} props.credentials
 * @param {() => void} props.onClose
 * @param {(username: string) => void} [props.onRotateRequested] invoked
 *   when "Cycle Password" is clicked, with the service account's own
 *   username (the confirm dialog's type-to-confirm target).
 * @param {(username: string) => void} [props.onDeleteRequested] invoked
 *   when "Delete Service Account" is clicked, with the same username.
 */
export default function BchChannelCredentialsDialog({ channelName, credentials, onClose, onRotateRequested, onDeleteRequested }) {
  const handleCopy = async (value, label) => {
    try {
      await copyToClipboard(value)
      toast.success(`${label} copied to clipboard`)
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}`)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center sm:p-4 z-50">
      {/* Mobile fix: full-bleed sheet below `sm:`, unchanged floating card
          at `sm:` and up -- matches every other modal in this app
          (RevokeDeviceDialog.jsx, AddTeamDeviceDialog.jsx, etc.). */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bch-credentials-title"
        className="bg-white dark:bg-gray-800 shadow-xl w-full h-full sm:rounded-lg sm:max-w-md sm:h-auto sm:max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h3 id="bch-credentials-title" className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Service Account Credentials
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close credentials dialog"
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Authentik service account credentials for{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100 break-words">{channelName}</span>.
          </p>

          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Username</dt>
            <dd className="flex items-center gap-2">
              <span className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
                {credentials.service_account_username}
              </span>
              {/* Bugfix (mobile tap target too small): -m-2 p-2 enlarges
                  the hit box without inflating the row's own layout,
                  matching every copy button on the WinTAK/Manual tab. */}
              <button
                type="button"
                onClick={() => handleCopy(credentials.service_account_username, 'Username')}
                className="-m-2 p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700"
                aria-label="Copy username"
                title="Copy username"
              >
                <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </dd>
          </div>

          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Password</dt>
            {/* The real password is NEVER rendered as text -- only a fixed
                run of bullet characters, regardless of the real value's
                length, matching the enrollment tab's own manual-entry
                password field. Only the Copy button ever touches the real
                value, straight to the clipboard. */}
            <dd className="flex items-center gap-2">
              <span
                className="text-sm font-mono text-gray-900 dark:text-gray-100 tracking-widest"
                aria-label="Password hidden"
              >
                {'•'.repeat(12)}
              </span>
              <button
                type="button"
                onClick={() => handleCopy(credentials.service_account_password, 'Password')}
                className="-m-2 p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700"
                aria-label="Copy password"
                title="Copy password"
              >
                <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </dd>
          </div>

          {/* Bugfix: both actions are behind the shared type-to-confirm
              dialog (opened by the parent, per the callback props above),
              never a direct call from here -- consistent with this app's
              "no one-click destructive/credential-affecting action" rule.
              `flex-wrap` so the two secondary actions can drop to their
              own line on a narrow phone rather than crowding beside
              Close. */}
          <div className="flex flex-wrap justify-between items-center gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
            <div className="flex flex-wrap gap-2">
              {onRotateRequested && (
                <button
                  type="button"
                  onClick={() => onRotateRequested(credentials.service_account_username)}
                  className="btn-secondary flex items-center gap-1.5"
                >
                  <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
                  Cycle Password
                </button>
              )}
              {onDeleteRequested && (
                <button
                  type="button"
                  onClick={() => onDeleteRequested(credentials.service_account_username)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-900/60"
                >
                  <TrashIcon className="h-4 w-4" aria-hidden="true" />
                  Delete Service Account
                </button>
              )}
            </div>
            <button type="button" onClick={onClose} className="btn-secondary">
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Copies `value` to the clipboard, preferring the modern async API (only
 * available on a secure context) and falling back to the
 * `execCommand('copy')` shape `EnrollmentView.jsx`/`SignupCodeManager.jsx`
 * already use for the same reason (HTTP/insecure-context support).
 *
 * @param {string} value
 * @returns {Promise<void>}
 */
async function copyToClipboard(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value)
    return
  }
  const textArea = document.createElement('textarea')
  textArea.value = value
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'
  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(textArea)
  }
}
