import { useCallback, useEffect, useState } from 'react'
import { ClipboardDocumentIcon, ComputerDesktopIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { enrollmentAPI } from '../services/api'
import EnrollmentCountdown from '../components/EnrollmentCountdown'
import MultipleCertificateWarning from '../components/MultipleCertificateWarning'
import FormattedDate, { DATE_PRECISION } from '../components/FormattedDate'
import { isAndroidClient } from '../utils/platformDetection'
import { getTakColorHex } from '../utils/takColors'

/**
 * Enrollment_View (takserver-enrollment Requirement 10, task 9.5; UX
 * correction: layout re-aligned to the retired Enrollment_Lambda's
 * `content.ejs` -- Enrollment Data summary, Device Enrollment
 * Requirements, a deferred "Generate Enrollment Data" action, and a
 * three-tab QR/manual-entry surface).
 *
 * ONE component serving BOTH Enrollment_Principals from one API response
 * shape (Criterion 10.10): a signed-in Human_Principal enrolling their OWN
 * account (this page's default, via `enrollmentAPI.generateSelf()`), and a
 * Team_Owned_Device (the team-device surface, task 11.2/11.3, supplies its
 * own `fetchEnrollment`/`fetchPreview` pair that call
 * `POST`/`GET /api/devices/:deviceUserId/qr-code|preview` instead). Both
 * pairs of server routes return the SAME shapes, so this component renders
 * one thing regardless of which principal it is showing.
 *
 * ## Preview first, mint only on an explicit click
 *
 * The "Enrollment Data" section (TAK Server / User or Device / Callsign /
 * Team Color / Role / live-certificate note) never needs a live
 * Enrollment_Token to render -- every value in it is either a local
 * database column or a locally-derived attribute. This component therefore
 * fetches a NO-MINT preview automatically on mount (`fetchPreview`), and
 * defers the actual token mint (`fetchEnrollment`, which DOES call
 * Authentik) to an explicit "Generate Enrollment Data" click.
 *
 * This is a deliberate correction to the original, single-phase design,
 * which minted a fresh 30-minute Authentik `app_password` token on every
 * page LOAD -- so a user who merely browsed Dashboard -> Enrollment ->
 * Teams -> back to Enrollment minted a brand new live credential each
 * time, for no reason. Splitting the fetch this way means the ONLY two
 * times a token is minted are an explicit "Generate Enrollment Data" click
 * and an explicit "Generate Enrollment Data" click after expiry -- never a
 * page load, and never a background timer.
 *
 * ## What this page does NOT do, each a deliberate omission
 *
 * - **No polling, no interval, no background refresh of the MINTED
 *   payload.** The only two times `generate` is called are an explicit
 *   "Generate Enrollment Data" click and the SAME click again once expired
 *   (routed through `<EnrollmentCountdown onRegenerate={generate}>`).
 * - **A failed generation never clears a previously rendered payload.**
 *   `generate` sets `error` on a rejection and leaves `enrollment` exactly
 *   as it was.
 * - **No app-store badges.** Those live on the Downloads_Page.
 * - **No two-request loading pattern and no branding switch.**
 *
 * ## The Re_Enrollment_Date is a future estimate, never a read of a certificate
 *
 * `enrollment.reEnrollmentDate` is computed server-side, at generation
 * time, as `now + 365 days`. Rendered through `<FormattedDate
 * precision="date">` -- the ONLY non-test client module permitted to
 * import the Date_Format_Helpers.
 *
 * ## Android_Only_Suppression removes the deep link, never merely hides it
 *
 * On a non-Android client the ATAK deep-link `<a>` is removed from the DOM
 * entirely (Criterion 10.6), not hidden with CSS. Both QR codes keep
 * rendering regardless (Criterion 10.7).
 *
 * ## Manual entry never shows the real enrollment code as text
 *
 * The WinTAK/Manual tab shows the username as copyable plain text, but the
 * enrollment code itself is rendered as a fixed run of `•` characters --
 * NEVER the real value -- with its own "Copy" button copying the real
 * value straight to the clipboard. This is a stricter posture than the
 * previous manual-entry block, which rendered the raw token as visible
 * text: the value is exactly as secret whether or not it happens to be on
 * screen, and never displaying it removes the shoulder-surfing/screen-
 * share exposure that visible text has and a copy button does not need.
 *
 * @param {object} [props]
 * @param {() => Promise<object>} [props.fetchEnrollment] Resolves to the
 *   full, secret-carrying enrollment object (mints a token). Defaults to
 *   the self-service route, `POST /api/enrollment/me`.
 * @param {() => Promise<object>} [props.fetchPreview] Resolves to the
 *   no-mint preview object. Defaults to `GET /api/enrollment/me/preview`.
 */

/** takserver-enrollment Criterion 15.3: the explicit fallback text for any TAK_Attribute this view cannot resolve. */
const UNSET_ATTRIBUTE_LABEL = 'None'

/**
 * The client-side half of Criterion 15.3's "render `None`, never an empty
 * field" rule.
 *
 * @param {*} value
 * @returns {string}
 */
function orNone(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : UNSET_ATTRIBUTE_LABEL
}


/**
 * Turns a failed `fetchEnrollment()`/`fetchPreview()` call into the
 * message shown inline. Prefers the server's own message, falls back to a
 * generic message for a network failure or an unnamed 5xx.
 *
 * @param {{response?: {status?: number, data?: {error?: string}}}} error
 * @returns {string}
 */
export function interpretEnrollmentError(error) {
  const serverMessage = error?.response?.data?.error
  if (typeof serverMessage === 'string' && serverMessage.trim() !== '') {
    return serverMessage
  }
  return 'Failed to generate an enrollment code. Please try again.'
}

/**
 * Copies `value` to the clipboard, preferring the modern async API (only
 * available on a secure context) and falling back to the
 * `execCommand('copy')` shape `SignupCodeManager.jsx` already uses for the
 * same reason (HTTP/insecure-context support).
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

/** The default no-mint preview: self-service, `GET /api/enrollment/me/preview`. */
async function fetchSelfPreview() {
  const response = await enrollmentAPI.previewSelf()
  return response.data.preview
}

/** The default mint-generating call: self-service, `POST /api/enrollment/me`. */
async function fetchSelfEnrollment() {
  const response = await enrollmentAPI.generateSelf()
  return response.data.enrollment
}

/** The three tabs this view renders, in display order. */
const TABS = Object.freeze({
  ATAK: 'atak',
  ITAK: 'itak',
  MANUAL: 'manual'
})

export default function EnrollmentView({
  fetchEnrollment = fetchSelfEnrollment,
  fetchPreview = fetchSelfPreview
}) {
  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [enrollment, setEnrollment] = useState(null)
  const [error, setError] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [activeTab, setActiveTab] = useState(TABS.ATAK)
  const [codeRevealed, setCodeRevealed] = useState(false)

  // See the file header's "The ATAK deep link's text" note on
  // `EnrollmentCountdown` -- this page owns the deep link, so this page
  // reacts to the countdown's terminal-state transition.
  const [isExpired, setIsExpired] = useState(false)

  const [isAndroid] = useState(() =>
    isAndroidClient(typeof navigator === 'undefined' ? null : navigator)
  )

  // The NO-MINT preview call. Runs automatically on mount (the effect
  // below) and is the ONLY thing that runs automatically -- it mints
  // nothing and calls Authentik nowhere on the server.
  const loadPreview = useCallback(async () => {
    try {
      const result = await fetchPreview()
      setPreview(result)
      setPreviewError(null)
    } catch (err) {
      setPreviewError(interpretEnrollmentError(err))
    }
  }, [fetchPreview])

  useEffect(() => {
    loadPreview()
  }, [loadPreview])

  // The mint-generating call. Runs ONLY in response to an explicit human
  // click -- the initial "Generate Enrollment Data" button, or the SAME
  // action again via <EnrollmentCountdown onRegenerate> once expired.
  // Never on mount, never on a timer.
  const generate = useCallback(async () => {
    setGenerating(true)
    try {
      const result = await fetchEnrollment()
      setEnrollment(result)
      setError(null)
      setIsExpired(false)
      setCodeRevealed(false)
      setActiveTab(TABS.ATAK)
    } catch (err) {
      setError(interpretEnrollmentError(err))
    } finally {
      setGenerating(false)
    }
  }, [fetchEnrollment])

  const handleExpired = useCallback(() => {
    setIsExpired(true)
  }, [])

  const handleCopy = useCallback(async (value, label) => {
    try {
      await copyToClipboard(value)
      toast.success(`${label} copied to clipboard`)
    } catch {
      toast.error(`Failed to copy ${label.toLowerCase()}`)
    }
  }, [])

  // Whichever object currently has the richest data to show: the minted
  // enrollment once generated, the no-mint preview before that.
  const summary = enrollment || preview
  const takAttributes = summary?.takAttributes ?? {}
  const itakUserCredentials = enrollment?.itakRegistrationPayload?.userCredentials ?? {}
  const itakServerCredentials = enrollment?.itakRegistrationPayload?.serverCredentials ?? {}
  const isDevicePrincipal = summary?.principalKind === 'device'

  const tabButtonClass = (tab) =>
    `flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
      activeTab === tab
        ? 'border-primary-500 text-primary-600 dark:text-primary-400'
        : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
    }`

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Enroll a TAK Client</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Review your enrollment data below, then generate a code to scan with ATAK, iTAK, or enter manually.
        </p>
      </div>

      {previewError && !summary && (
        <div className="card">
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-3">
            {previewError}
          </p>
          <button type="button" onClick={loadPreview} className="btn-secondary text-sm">
            Retry
          </button>
        </div>
      )}

      {summary && (
        <div className="card space-y-6">
          {/* Enrollment Data -- matches the retired Enrollment_Lambda's
              "Enrollment data" section: TAK Server, User (or Device for a
              Team_Owned_Device), Callsign, Team Color (with the swatch),
              Role. Rendered from the no-mint preview -- nothing here
              needs a live token. */}
          <div>
            <h2 className="text-sm font-semibold text-primary-600 dark:text-primary-400 uppercase tracking-wide mb-3">
              Enrollment Data
            </h2>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">TAK Server</dt>
                <dd className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">{summary.host}</dd>
              </div>
              <div>
                {/* Client display correction: labelled "User" for a human
                    Enrollment_Principal and "Device" for a Team_Owned_
                    Device, always showing the Managed_Identifier
                    `username` -- never an email, which is not what the
                    enrollment credentials are keyed on and which a
                    device does not have at all. */}
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  {isDevicePrincipal ? 'Device' : 'User'}
                </dt>
                <dd className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">{summary.username}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Callsign</dt>
                <dd className="text-sm text-gray-900 dark:text-gray-100">{orNone(takAttributes.callsign)}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Team Color</dt>
                <dd className="text-sm text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  {orNone(takAttributes.color)}
                  {takAttributes.color && takAttributes.color !== UNSET_ATTRIBUTE_LABEL && (
                    <span
                      aria-hidden="true"
                      className="inline-block w-3.5 h-3.5 rounded border border-gray-300 dark:border-gray-600"
                      style={{ backgroundColor: getTakColorHex(takAttributes.color) }}
                    />
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Role</dt>
                <dd className="text-sm text-gray-900 dark:text-gray-100">{orNone(takAttributes.role)}</dd>
              </div>
            </dl>

            {/* Requirement 13: information, never an error, never a gate
                on anything below it. Renders nothing at all for a count
                of 0 or 1 -- this keeps the "N active TAK Server
                certificates" note as part of the Enrollment Data
                section. */}
            <MultipleCertificateWarning count={summary.liveCertificateCount} className="mt-3" />
          </div>

          <hr className="border-gray-200 dark:border-gray-700" />

          {/* Device Enrollment Requirements -- matches the retired
              Enrollment_Lambda's section of the same name verbatim. */}
          <div>
            <h2 className="text-sm font-semibold text-primary-600 dark:text-primary-400 uppercase tracking-wide mb-3">
              Device Enrollment Requirements
            </h2>
            <ul className="list-disc list-inside space-y-1 text-sm text-gray-700 dark:text-gray-300">
              <li>
                <span className="font-medium">Device Registration:</span> This device will be linked to your
                account. Only enroll devices that you are authorized to use and are personally responsible for.
              </li>
              <li>
                <span className="font-medium">Enrollment Duration:</span> Your device enrollment is valid for 1
                year.
              </li>
            </ul>
          </div>

          <hr className="border-gray-200 dark:border-gray-700" />

          {error && (
            <div>
              <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-3">
                {error}
              </p>
              <button type="button" onClick={generate} className="btn-secondary text-sm">
                Retry
              </button>
            </div>
          )}

          {!enrollment ? (
            // No token minted yet: show the deferred-generation action
            // instead of any QR codes. This is the ONLY control on this
            // page that mints a live Enrollment_Token on its own
            // initiative -- and even that only in direct response to this
            // click.
            <div className="text-center py-4">
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="btn-primary px-6 py-2.5"
              >
                {generating ? 'Generating…' : 'Generate Enrollment Data'}
              </button>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                This mints a one-time enrollment code valid for 30 minutes.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Criterion 10.2: the live MM : SS countdown, shared across
                  all three tabs (one token, one expiry, regardless of
                  which tab is active). "Generate Enrollment Data" is
                  reused as the regenerate label too -- functionally the
                  identical action as the first click, so it keeps the
                  same name rather than a second phrase for the same
                  thing. */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">Code expires in</dt>
                  <EnrollmentCountdown
                    expiresAt={enrollment.expiresAt}
                    onExpired={handleExpired}
                    onRegenerate={generate}
                    regenerateLabel="Generate Enrollment Data"
                  />
                </div>
                <div className="text-sm text-gray-900 dark:text-gray-100">
                  <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Next re-enrollment</dt>
                  <dd>
                    The certificate this code issues will need to be replaced by{' '}
                    <FormattedDate value={enrollment.reEnrollmentDate} precision={DATE_PRECISION.DATE} />.
                  </dd>
                </div>
              </div>

              {/* Three tabs, matching the retired Enrollment_Lambda's own
                  tab shape exactly: ATAK/TAK Aware, iTAK, and a third
                  WinTAK/Manual tab this application adds. */}
              <div>
                <div className="flex border-b border-gray-200 dark:border-gray-700" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === TABS.ATAK}
                    className={tabButtonClass(TABS.ATAK)}
                    onClick={() => setActiveTab(TABS.ATAK)}
                  >
                    ATAK / TAK Aware
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === TABS.ITAK}
                    className={tabButtonClass(TABS.ITAK)}
                    onClick={() => setActiveTab(TABS.ITAK)}
                  >
                    iTAK
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === TABS.MANUAL}
                    className={tabButtonClass(TABS.MANUAL)}
                    onClick={() => setActiveTab(TABS.MANUAL)}
                  >
                    <ComputerDesktopIcon className="h-4 w-4" aria-hidden="true" />
                    WinTAK / Manual
                  </button>
                </div>

                <div className="pt-4">
                  {activeTab === TABS.ATAK && (
                    <div className="text-center">
                      <ul className="text-sm text-gray-700 dark:text-gray-300 text-left list-disc list-inside mb-4 space-y-1 max-w-md mx-auto">
                        <li>ATAK or TAK Aware must already be installed.</li>
                        <li>
                          <span className="font-medium">For ATAK (Android):</span> open your camera app, point at
                          the QR code below, and tap the link that appears.
                        </li>
                        <li>
                          <span className="font-medium">For TAK Aware (iPhone):</span> open TAK Aware, select
                          "Connect to a TAK Server", then "Scan Android QR code", and point the camera at the QR
                          code below.
                        </li>
                      </ul>
                      <img
                        src={enrollment.atakQrDataUrl}
                        alt="ATAK enrollment QR code"
                        className="mx-auto border border-gray-200 dark:border-gray-700 rounded-lg"
                      />
                      {isAndroid && (
                        isExpired ? (
                          // Criterion 10.2: the same transition that ticks
                          // the countdown to its terminal state replaces
                          // this link's text with an expired message. No
                          // longer a clickable <a> once expired.
                          <p className="mt-3 text-sm text-red-600 dark:text-red-400">Enrollment link expired</p>
                        ) : (
                          <a href={enrollment.atakEnrollmentUri} className="btn-primary inline-block mt-3 text-sm">
                            Open in ATAK
                          </a>
                        )
                      )}
                    </div>
                  )}

                  {activeTab === TABS.ITAK && (
                    <div className="text-center">
                      <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
                        <span className="font-medium">Note:</span> QR code enrollment requires iTAK version 2.12.3
                        or later.
                      </p>
                      <ul className="text-sm text-gray-700 dark:text-gray-300 text-left list-disc list-inside mb-4 space-y-1 max-w-md mx-auto">
                        <li>Within iTAK tap "Network", then "Servers".</li>
                        <li>Select the plus icon (+) in the bottom right.</li>
                        <li>Tap on "Scan QR" and scan the QR code below.</li>
                        <li>You will be prompted to enter your username and password.</li>
                      </ul>
                      <img
                        src={enrollment.itakQrDataUrl}
                        alt="iTAK enrollment QR code"
                        className="mx-auto border border-gray-200 dark:border-gray-700 rounded-lg"
                      />
                    </div>
                  )}

                  {activeTab === TABS.MANUAL && (
                    <div className="max-w-md mx-auto space-y-4">
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        Enter these details manually on a WinTAK or other TAK client that cannot scan a QR code.
                      </p>
                      <div>
                        <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Server</dt>
                        <dd className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
                          {itakServerCredentials.connectionString}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Username</dt>
                        <dd className="flex items-center gap-2">
                          <span className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
                            {enrollment.username}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(enrollment.username, 'Username')}
                            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                            aria-label="Copy username"
                            title="Copy username"
                          >
                            <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Enrollment code</dt>
                        {/* The real enrollment code is NEVER rendered as
                            text -- only a fixed run of bullet characters,
                            regardless of the real code's length. Only the
                            Copy button ever touches the real value, and it
                            goes straight to the clipboard, never through
                            component state that could re-render it visibly. */}
                        <dd className="flex items-center gap-2">
                          <span
                            className="text-sm font-mono text-gray-900 dark:text-gray-100 tracking-widest"
                            aria-label="Enrollment code hidden"
                          >
                            {'•'.repeat(12)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(itakUserCredentials.password, 'Enrollment code')}
                            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                            aria-label="Copy enrollment code"
                            title="Copy enrollment code"
                          >
                            <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </dd>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {!summary && !previewError && (
        <div className="card text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
          <p className="text-gray-500 dark:text-gray-400 mt-2">Loading your enrollment data...</p>
        </div>
      )}
    </div>
  )
}
