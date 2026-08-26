import { useCallback, useEffect, useState } from 'react'
import { enrollmentAPI } from '../services/api'
import EnrollmentCountdown from '../components/EnrollmentCountdown'
import MultipleCertificateWarning from '../components/MultipleCertificateWarning'
import FormattedDate, { DATE_PRECISION } from '../components/FormattedDate'
import { isAndroidClient } from '../utils/platformDetection'

/**
 * Enrollment_View (takserver-enrollment Requirement 10, task 9.5).
 *
 * ONE component serving BOTH Enrollment_Principals from one API response
 * shape (Criterion 10.10): a signed-in Human_Principal enrolling their OWN
 * account (this page's default, via `enrollmentAPI.generateSelf()`), and a
 * Team_Owned_Device (the team-device surface, task 11.2/11.3, supplies its
 * own `fetchEnrollment` that calls `POST /api/devices/:deviceUserId/qr-code`
 * instead). Both server routes return `DeviceEnrollmentService#buildEnrollment`'s
 * identical object shape, so this component renders one thing regardless of
 * which principal it is showing -- the countdown, the Re_Enrollment_Date and
 * the payload rendering cannot diverge between the self view and the device
 * view, because there is exactly one of each here.
 *
 * ## What this page does NOT do, each a deliberate omission
 *
 * - **No polling, no interval, no background refresh of any kind.**
 *   Generating an enrollment payload mints a live 30-minute Authentik
 *   `app_password` token, so a page that quietly re-minted one on a timer
 *   would mint an unbounded number of live credentials for an idle open
 *   tab. The ONLY two times `fetchEnrollment` is called are on mount and on
 *   an explicit "Generate a new code" click, routed through
 *   `<EnrollmentCountdown onRegenerate={generate}>` (design decision 14).
 *   Because there is no interval, there is nothing here to pause when the
 *   tab is hidden and nothing to restart when it becomes visible again --
 *   unlike the Dashboard's auto-refreshing cards, this page needs none of
 *   that machinery.
 * - **A failed generation never clears a previously rendered payload.**
 *   `generate` sets `error` on a rejection and leaves `enrollment` exactly
 *   as it was -- it is never set to `null` in the catch branch. So a
 *   "Generate a new code" click that fails leaves the EXPIRED code still on
 *   screen (following the client convention that a failed background
 *   refresh must never clear a rendered list, extended here to a page-level
 *   refresh triggered by the user rather than a timer) with the error and a
 *   Retry control rendered alongside it, never in its place.
 * - **No app-store badges.** Those moved to the Downloads_Page (Criteria
 *   10.11, 12.1); this file renders none, and `storeBadgeFidelity.test.jsx`
 *   /the Downloads tests assert the badges live there instead.
 * - **No two-request loading pattern and no branding switch.** The
 *   Enrollment_Lambda's `views/loader.ejs` -> `?load=true` sequence exists
 *   because a Lambda behind an ALB must answer before its own Authentik
 *   calls complete; a single-page application fetches asynchronously by
 *   construction and has no such constraint (Criterion 15.8). Likewise the
 *   Lambda's `BRANDING`/`getBrandingStrings` switch has no counterpart here
 *   -- TAK Team Manager already has its own site branding, and a second
 *   mechanism for it would be a second place to configure the same thing
 *   (Criterion 15.9).
 *
 * ## The Re_Enrollment_Date is a future estimate, never a read of a certificate
 *
 * `enrollment.reEnrollmentDate` is computed server-side, at generation
 * time, as `now + 365 days` -- it describes when the certificate this code
 * is ABOUT TO ISSUE will need replacing, never a read of
 * `tak_devices.expires_at` (Criterion 10.3). The label below is worded to
 * say so explicitly (Criterion 10.4), and the date itself renders through
 * `<FormattedDate precision="date">` -- the ONLY non-test client module
 * permitted to import the Date_Format_Helpers
 * (`client/src/utils/dateFormatConsumers.test.js` enforces this as a set
 * equality), so this page imports `FormattedDate` and never
 * `formatDate`/`formatDateTime` directly (Criterion 10.9).
 *
 * ## Android_Only_Suppression removes the deep link, never merely hides it
 *
 * The ATAK deep link (`tak://com.atakmap.app/enroll?...`) resolves to
 * nothing on a client with no ATAK installed, and a link that resolves
 * nowhere is a link that does nothing when a keyboard user tabs to it --
 * so on a non-Android client the `<a>` is removed from the DOM entirely
 * (Criterion 10.6), not hidden with `hidden`/`display:none`/`opacity-0`.
 * Detection runs ONCE, via `isAndroidClient(navigator)` -- the real global,
 * passed explicitly per that function's designed API, which never reaches
 * for `navigator` itself so a property test can hand it hostile shapes.
 * BOTH QR codes keep rendering regardless: they are scanned by a SECOND
 * device and are useful on any platform, and only the deep link, which
 * acts on the CURRENT device, is platform-bound (Criterion 10.7).
 *
 * ## Works for a signed-in user with no team membership at all
 *
 * This is the one behavioural gap between the Enrollment_Lambda (which
 * authorizes on session validity alone) and the rest of this application
 * (whose authorization is team-scoped throughout), and closing it is a
 * precondition for switching the Lambda off (Criterion 15.2). The server
 * already renders the explicit string `'None'` for any TAK_Attribute it
 * cannot resolve without a team, following the Lambda's own
 * `extractAttribute` default (Criterion 15.3); `orNone` below is a second,
 * client-side line of the same defence, so this page never renders an
 * empty attribute cell regardless of exactly what the response contains.
 *
 * @param {object} [props]
 * @param {() => Promise<object>} [props.fetchEnrollment] Resolves to
 *   `#buildEnrollment`'s response object. Defaults to the self-service
 *   route, `POST /api/enrollment/me`. The team-device surface passes its
 *   own function calling `POST /api/devices/:deviceUserId/qr-code`
 *   instead, which is what lets this ONE component serve both
 *   Enrollment_Principals (Criterion 10.10) without knowing which one it
 *   is showing.
 */

/** takserver-enrollment Criterion 15.3: the explicit fallback text for any TAK_Attribute this view cannot resolve. */
const UNSET_ATTRIBUTE_LABEL = 'None'

/**
 * The client-side half of Criterion 15.3's "render `None`, never an empty
 * field" rule. The server already sends the literal string `'None'` for an
 * unresolved TAK_Attribute (`DeviceEnrollmentService#buildEnrollment`), so
 * in normal operation this is a no-op pass-through; it exists so this
 * component never renders a blank cell even if a future response shape
 * omits the field entirely rather than naming it `'None'`.
 *
 * @param {*} value
 * @returns {string}
 */
function orNone(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : UNSET_ATTRIBUTE_LABEL
}

/**
 * Turns a failed `fetchEnrollment()` call into the message shown inline.
 *
 * Prefers the server's own message (every named error this feature defines
 * -- `TakServerNotConfiguredError`, `OrganisationPrefixMissingError`,
 * `DeviceSessionCannotSelfEnrollError` -- responds with `{ error: message }`
 * carrying a caller-actionable string), and falls back to a generic message
 * for a network failure or an unnamed 5xx (in particular
 * `ManagedIdentifierExhaustionError`, which is deliberately generic on the
 * wire -- its detail is in the server log, not the response body).
 *
 * Exported for direct unit testing, matching this project's convention of
 * testing extracted pure logic rather than only rendering a component (see
 * `RevokeDeviceDialog.jsx`'s `interpretRevokeError`).
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
 * The default `fetchEnrollment`: self-service enrollment of the caller's OWN
 * account, `POST /api/enrollment/me`. No route parameters and no body --
 * the subject is always resolved server-side from the session (Requirement
 * 3.4), so there is nothing for this call to supply.
 *
 * @returns {Promise<object>} `#buildEnrollment`'s response object.
 */
async function fetchSelfEnrollment() {
  const response = await enrollmentAPI.generateSelf()
  return response.data.enrollment
}

export default function EnrollmentView({ fetchEnrollment = fetchSelfEnrollment }) {
  const [enrollment, setEnrollment] = useState(null)
  const [error, setError] = useState(null)

  // Criterion 10.2: the ATAK deep link's text is replaced with an expired
  // message the moment the countdown reaches its terminal state -- matching
  // the Enrollment_Lambda's `generateCountdownScript`. `EnrollmentCountdown`
  // deliberately owns none of this DOM (see its own doc comment): it only
  // exposes the transition, once per distinct `expiresAt`, through
  // `onExpired`. This page is the thing that renders the deep link, so this
  // page is what reacts to it. Reset to `false` on every successful
  // `generate()` -- including the very regeneration `onExpired`'s own
  // "Generate a new code" button triggers -- so a freshly minted code's
  // still-live deep link is never shown carrying the previous code's
  // expired message.
  const [isExpired, setIsExpired] = useState(false)

  // Read ONCE, not on every render: `isAndroidClient` is pure and total over
  // its argument, but `navigator` itself does not change over a page's
  // lifetime, so there is nothing to gain by re-reading it. The lazy
  // initializer form (`useState(() => ...)`) is what makes this a one-time
  // read rather than a per-render one.
  const [isAndroid] = useState(() =>
    isAndroidClient(typeof navigator === 'undefined' ? null : navigator)
  )

  // The single function behind BOTH triggers this page ever fires:
  // the initial mount (via the effect below) and an explicit
  // "Generate a new code" / "Retry" click (both wire directly to this,
  // never to anything that could re-run on its own). A rejection sets
  // `error` and deliberately leaves `enrollment` untouched -- see the file
  // header's "never clears a previously rendered payload" note.
  const generate = useCallback(async () => {
    try {
      const result = await fetchEnrollment()
      setEnrollment(result)
      setError(null)
      // A freshly minted code is not expired, whatever the previous one's
      // state was -- including when this call IS the regeneration a
      // "Generate a new code" click triggered.
      setIsExpired(false)
    } catch (err) {
      setError(interpretEnrollmentError(err))
    }
  }, [fetchEnrollment])

  // Criterion 10.2: fired exactly once per distinct `expiresAt` by
  // `EnrollmentCountdown`, never on a re-render and never in response to
  // anything but that one transition -- see its own doc comment.
  const handleExpired = useCallback(() => {
    setIsExpired(true)
  }, [])

  // Runs exactly once per mount (per distinct `fetchEnrollment` identity):
  // this is the FIRST of the two calls the file header describes. There is
  // no second entry in this dependency array and no interval anywhere in
  // this component -- the only other call site is the button below.
  useEffect(() => {
    generate()
  }, [generate])

  const takAttributes = enrollment?.takAttributes ?? {}
  const itakUserCredentials = enrollment?.itakRegistrationPayload?.userCredentials ?? {}
  const itakServerCredentials = enrollment?.itakRegistrationPayload?.serverCredentials ?? {}

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Enroll a TAK Client</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Scan a code below with ATAK or iTAK, or enter the details manually on the device.
        </p>
      </div>

      {error && (
        <div className="card">
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-3">
            {error}
          </p>
          <button type="button" onClick={generate} className="btn-secondary text-sm">
            Retry
          </button>
        </div>
      )}

      {enrollment ? (
        <div className="card space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Username</dt>
              <dd className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
                {enrollment.username}
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">TAK Server</dt>
              <dd className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
                {enrollment.host}
              </dd>
            </div>
          </div>

          {/* Requirement 13: information, never an error, never a gate on
              anything below it -- see `MultipleCertificateWarning.jsx`'s own
              doc comment. Renders nothing at all for a count of 0 or 1. */}
          <MultipleCertificateWarning count={enrollment.liveCertificateCount} />

          <div>
            <dt className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-1">
              Code expires in
            </dt>
            {/* Criterion 10.2: the live MM : SS countdown, and the ONLY
                affordance in this whole page that ever calls `generate`
                again on its own initiative -- and even that only in
                response to a human clicking the button EnrollmentCountdown
                renders once expired, never automatically (design decision
                14). */}
            <EnrollmentCountdown
              expiresAt={enrollment.expiresAt}
              onExpired={handleExpired}
              onRegenerate={generate}
              regenerateLabel="Generate a new code"
            />
          </div>

          {/* Criteria 10.3, 10.4: an ARITHMETIC ESTIMATE of when the
              certificate this code is about to issue will need replacing --
              never a read of `tak_devices.expires_at`, and the wording below
              says so explicitly rather than reading like a report on a
              certificate that already exists. */}
          <div>
            <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
              Next re-enrollment
            </dt>
            <dd className="text-sm text-gray-900 dark:text-gray-100">
              The certificate this code issues will need to be replaced by{' '}
              <FormattedDate value={enrollment.reEnrollmentDate} precision={DATE_PRECISION.DATE} />.
            </dd>
          </div>

          {/* Criterion 10.5: local values only. A user with no team
              membership at all (Criterion 15.2) gets `'None'` for each of
              these three, never a blank cell (Criterion 15.3). */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Callsign</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{orNone(takAttributes.callsign)}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Color</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{orNone(takAttributes.color)}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Role</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{orNone(takAttributes.role)}</dd>
            </div>
          </div>

          {/* Criteria 10.1, 10.6, 10.7: both QR_Data_Urls always render --
              they are `<img src>` values the server already computed, so
              nothing here decodes, generates or transforms them. Only the
              ATAK deep link beneath the first image is platform-bound, and
              it is REMOVED FROM THE DOM (not merely hidden) on a
              non-Android client. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="text-center">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">ATAK</h3>
              <img
                src={enrollment.atakQrDataUrl}
                alt="ATAK enrollment QR code"
                className="mx-auto border border-gray-200 dark:border-gray-700 rounded-lg"
              />
              {isAndroid && (
                isExpired ? (
                  // Criterion 10.2: the same transition that ticks the
                  // countdown to its terminal state replaces this link's
                  // text with an expired message, matching the
                  // Enrollment_Lambda's `generateCountdownScript`. Text,
                  // not colour alone, carries the state, and the element is
                  // no longer an `<a>` -- an expired token's deep link
                  // resolves nowhere, so it is not left clickable.
                  <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                    Enrollment link expired
                  </p>
                ) : (
                  <a href={enrollment.atakEnrollmentUri} className="btn-primary inline-block mt-3 text-sm">
                    Open in ATAK
                  </a>
                )
              )}
            </div>
            <div className="text-center">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">iTAK</h3>
              <img
                src={enrollment.itakQrDataUrl}
                alt="iTAK enrollment QR code"
                className="mx-auto border border-gray-200 dark:border-gray-700 rounded-lg"
              />
            </div>
          </div>

          {/* Criterion 10.8: the Enrollment_Token as TEXT beside the codes,
              so a device that cannot scan can still be enrolled by manual
              entry. The connection string and the password/token come from
              the SAME iTAK_Registration_Payload the QR code above encodes --
              nothing here is computed independently of it, so the manual
              values and the scanned values can never disagree. */}
          <div>
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Manual entry</h3>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm font-mono text-gray-900 dark:text-gray-100">
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Username</dt>
                <dd className="break-all">{enrollment.username}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500 dark:text-gray-400">Server</dt>
                <dd className="break-all">{itakServerCredentials.connectionString}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-gray-500 dark:text-gray-400">Enrollment code</dt>
                <dd className="break-all">{itakUserCredentials.password}</dd>
              </div>
            </dl>
          </div>
        </div>
      ) : (
        !error && (
          <div className="card text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
            <p className="text-gray-500 dark:text-gray-400 mt-2">Generating your enrollment code...</p>
          </div>
        )
      )}
    </div>
  )
}
