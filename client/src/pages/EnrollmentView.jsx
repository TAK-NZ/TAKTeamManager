import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircleIcon, CheckIcon, ClipboardDocumentIcon, InformationCircleIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { enrollmentAPI, configAPI } from '../services/api'
import { AndroidPlatformLogo, ApplePlatformLogo, WindowsPlatformLogo } from '../components/PlatformLogos'
import EnrollmentCountdown from '../components/EnrollmentCountdown'
import FormattedDate, { DATE_PRECISION } from '../components/FormattedDate'
import { isAndroidClient, isIOSClient } from '../utils/platformDetection'
import { getTakColorHex } from '../utils/takColors'
import { tabAria, TabPanel } from '../components/Tabs'

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
 * The WinTAK/Manual tab's "Description" field default, used before
 * `configAPI.getPublic()`'s `enrollment_manual_description` resolves (and
 * as its own fallback if that key is absent) -- matches
 * `server/models/SiteConfig.js`'s own `|| 'TAK.NZ'` default so client and
 * server agree on the unconfigured value.
 */
const DEFAULT_MANUAL_DESCRIPTION = 'TAK.NZ'

/**
 * The WinTAK/Manual tab's Protocol and Port fields. Both are FIXED display
 * values, not data read off `enrollment` -- server-side, `ENROLLMENT_PORT`
 * (`server/services/DeviceEnrollmentService.js`) is a deliberate code
 * constant, never an environment variable (a configurable port would let a
 * deployment render a broken QR code without enabling a working one 8089
 * doesn't already cover), and `:ssl` is likewise baked into the
 * `connectionString` it builds rather than carried as its own field. These
 * two constants keep this tab's Protocol/Port cells in sync with that same
 * fixed shape without parsing it back out of `connectionString`.
 */
const MANUAL_PROTOCOL = 'SSL'
const MANUAL_PORT = '8089'

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
 * Whether `count` is a real, displayable live-certificate count -- a
 * non-negative integer. Mirrors the same totality guard
 * `buildMultipleCertificateWarningText` (`MultipleCertificateWarning.jsx`)
 * used to apply before this field replaced that component on this page:
 * anything that is not a finite non-negative integer (`NaN`, a negative
 * number, a non-number, `null`, `undefined`) is treated as "nothing to
 * show" rather than as zero, so a malformed count renders the same `None`
 * fallback every other unset TAK_Attribute on this page uses instead of a
 * misleading `0`.
 *
 * @param {*} count
 * @returns {boolean}
 */
function isValidCertificateCount(count) {
  return typeof count === 'number' && Number.isFinite(count) && Number.isInteger(count) && count >= 0
}

/**
 * The "Active TAK Server Certificates" field's text colour.
 *
 * Bugfix: this field replaces the old `MultipleCertificateWarning` note,
 * which rendered amber -- a warning colour -- for any count greater than
 * one. On this self-service enrollment page, more than one live
 * certificate is the ORDINARY case (one per enrolled client: ATAK,
 * CloudTAK, a second device, and so on), not an anomaly, so amber there
 * was actively misleading.
 *
 * The one count that IS worth flagging here is exactly zero: on a page
 * whose whole purpose is confirming a client is enrolled, zero live
 * certificates plausibly means nothing has taken effect yet. Every other
 * valid count (one or more) renders green -- "something is enrolled and
 * live" -- and an invalid/unresolved count renders the same neutral gray
 * every other unset field on this page uses, never green (a count this
 * component cannot confirm must not read as a confirmed-good state) and
 * never amber (there is nothing concrete to warn about yet).
 *
 * @param {*} count
 * @returns {string} a Tailwind text-color class pair (light + dark).
 */
function certificateCountColorClass(count) {
  if (!isValidCertificateCount(count)) {
    return 'text-gray-900 dark:text-gray-100'
  }
  return count === 0
    ? 'text-amber-700 dark:text-amber-400'
    : 'text-green-700 dark:text-green-400'
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

/**
 * The WinTAK/Manual tab's two informational, permanently-checked, disabled
 * "checkboxes" ("Enroll for Client Certificate", "Use Authentication").
 *
 * Bugfix: these used to be real `<input type="checkbox" checked disabled>`
 * elements. A `disabled` checkbox is commonly rendered by the BROWSER's own
 * native/system styling rather than the page's CSS -- Tailwind's
 * `text-primary-600` (which sets `accent-color`) and the `disabled:opacity-100`
 * override on the surrounding classes do not reliably reach a disabled
 * control in every browser, so the box desaturated to a flat system gray
 * and the white tick mark sat on that low-contrast gray instead of the
 * intended blue, in both light and dark mode. Rebuilt as a plain decorative
 * `<div>` box with an explicit `bg-primary-600` (never disabled, so nothing
 * can override it) and a heroicons `CheckIcon`, so every colour here is
 * literal Tailwind classes this app already controls rather than
 * browser-native checkbox chrome.
 *
 * `bg-primary-500` (not the darker `primary-600` used for buttons
 * elsewhere in this app) is the ONE shade in this app's `primary` scale
 * (`client/tailwind.config.js`) that clears the WCAG graphical-object
 * floor (>= 3:1, computed with `contrastRatio` from `utils/contrast.js`'s
 * arithmetic) against BOTH card backgrounds this box can sit on: 3.68:1
 * against the light card (white) and 3.99:1 against the dark card
 * (`gray-800`, `#1f2937`) -- `primary-600` measures a stronger 5.17:1
 * against the light card but only 2.84:1 against the dark one, FAILING
 * the floor there, so it is deliberately not used even though it is this
 * app's more common primary shade. The white check mark against the box
 * itself measures 3.68:1 too (same pair, `#ffffff` on `#3b82f6`), also
 * clearing the floor, and applies identically in both modes since neither
 * colour in that pair changes with theme. This is a fixed, non-interactive
 * decorative box (never `hover:`/`disabled:`-styled), so nothing here can
 * be overridden by browser-native control chrome the way the checkbox this
 * replaces was.
 */
function StaticCheckedIndicator({ label }) {
  return (
    <div className="flex items-center gap-2">
      <span
        role="img"
        aria-label={`${label}: enabled`}
        className="flex h-4 w-4 items-center justify-center rounded bg-primary-500 flex-shrink-0"
      >
        <CheckIcon className="h-3 w-3 text-white" aria-hidden="true" />
      </span>
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
    </div>
  )
}

/**
 * The "scan from a different device" callout shown before the QR-scan
 * bullets on the ATAK, TAK Aware and iTAK tabs.
 *
 * The QR code below it is meant to be scanned by the CLIENT device being
 * enrolled -- but if that client device is the same one currently showing
 * this web page, there is nothing else to point a camera at: the QR code
 * and the camera app trying to read it would be running on one screen at
 * once. A plain sentence dropped into the bullet list read too easily as
 * "just another instruction" to skim past, so this renders as its own
 * visually distinct, icon-led callout ABOVE the bullets instead -- the
 * same `bg-blue-50`/informational treatment `MultipleCertificateWarning.jsx`
 * used to use for its own non-error, worth-noticing note, adapted here
 * since that component itself no longer renders on this page.
 */
function DifferentDeviceNotice() {
  return (
    <p className="flex items-start gap-2 text-left text-sm text-blue-800 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 mb-3 max-w-md mx-auto">
      <InformationCircleIcon className="h-5 w-5 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <span>These steps must be performed from a different device: you cannot scan the QR code below using the same device this page is open on.</span>
    </p>
  )
}

/**
 * The pre-generation callout shown above the "Generate Enrollment Data"
 * button. At most ONE of two mutually exclusive variants renders,
 * depending on `isAndroid`/`isIOS` (the same Android platform check that
 * gates the ATAK direct-enroll shortcut elsewhere on this page, plus the
 * analogous iOS/iPadOS check):
 *
 * - On an Android device: a green, checkmark-led notice confirming THIS
 *   device can be enrolled directly with ATAK -- the fast path the ATAK
 *   tab's direct-enroll shortcut goes on to offer once a code is minted.
 * - On an iOS or iPadOS device specifically (an iPhone or iPad): a blue,
 *   informational notice targeted at the exact mistake an iPhone/iPad
 *   visitor is prone to making -- tapping "Generate Enrollment Data" on
 *   THIS device and then trying to scan the resulting QR code with this
 *   SAME device's camera, which cannot work (a screen cannot photograph
 *   itself). It tells them to instead do the generating step on a
 *   different device and scan from the iPhone/iPad.
 * - Every other case (a desktop browser, or an iPad in default Safari's
 *   desktop-site mode that this check cannot distinguish from a Mac --
 *   see `isIOSClient`'s own doc comment): no notice at all. Neither
 *   mistake this pair addresses applies to a desktop user generating a
 *   code to scan with a separate phone, which is the ordinary case there.
 *
 * Green/checkmark is a genuine "you're all set" confirmation, never a mere
 * decoration -- carried by TEXT ("can be enrolled directly with ATAK"),
 * not colour alone, matching this app's convention that state a user must
 * perceive is never colour-only.
 */
function PreGenerationDeviceNotice({ isAndroid, isIOS }) {
  if (isAndroid) {
    return (
      <p className="flex items-start gap-2 text-left text-sm text-green-800 dark:text-green-300 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg px-3 py-2 mb-4 max-w-md mx-auto">
        <CheckCircleIcon className="h-5 w-5 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <span>This Android device can be enrolled directly with ATAK.</span>
      </p>
    )
  }
  if (isIOS) {
    return (
      <p className="flex items-start gap-2 text-left text-sm text-blue-800 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2 mb-4 max-w-md mx-auto">
        <InformationCircleIcon className="h-5 w-5 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <span>To enroll TAK Aware or iTAK on this device, tap "Generate Enrollment Data" from a different device, then scan the QR code it shows using this device's camera.</span>
      </p>
    )
  }
  return null
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

/**
 * Bugfix: on a phone, letting the screen sleep and waking it back up often
 * reloads the page outright (mobile browsers routinely discard a
 * backgrounded tab to reclaim memory) -- and since the minted `enrollment`
 * object (QR codes, the deep link, the manual-entry credentials) lived only
 * in React state, that reload silently wiped it. The countdown said there
 * were still N minutes left, but the QR codes were simply gone, with no
 * way back to them short of generating an entirely new code.
 *
 * The fix persists the minted enrollment to `sessionStorage` -- tab-scoped
 * and cleared on browser close, unlike `localStorage`, which is the right
 * lifetime for a short-lived enrollment secret -- and restores it on
 * mount if it is both present and still unexpired.
 *
 * Only ONE key: this module serves the self-service `/enrollment` route
 * (the actual case a phone's own screen sleeps on) via the DEFAULT
 * `fetchSelfPreview`/`fetchSelfEnrollment` pair. `restoreStoredEnrollment`/
 * `persistEnrollment`/`clearStoredEnrollment` are only ever called when the
 * component is using those defaults (checked by identity in the component
 * body) -- the OTHER caller, `TeamDetail.jsx`'s device-enrollment modal,
 * supplies its own `fetchEnrollment`/`fetchPreview` bound to a specific
 * Team_Owned_Device and must never read or write this key: a short-lived
 * admin dialog enrolling one device, then closed and reopened for a
 * DIFFERENT device in the same browser tab, must never resurrect the
 * first device's stale QR codes under the second device's identity.
 */
const STORED_ENROLLMENT_KEY = 'enrollmentView.selfService.enrollment'

/**
 * Reads and parses whatever is stored under `STORED_ENROLLMENT_KEY`, or
 * `null` for anything that is not a usable, still-live enrollment.
 *
 * Deliberately does NOT check `principalId` against the current session
 * here -- that comparison needs the freshly-fetched preview, which is not
 * yet available at the point this is first called (mount time). The
 * caller (`EnrollmentView`'s own effect) is responsible for discarding a
 * restored value whose `principalId` does not match the live preview's,
 * which is the actual guard against one signed-in user's browser tab
 * leaking a previous, DIFFERENT user's minted enrollment secret to them
 * (`sessionStorage` is not automatically cleared just because the
 * `tak_session` cookie identity changed within the same tab).
 *
 * Never throws: `sessionStorage` access itself can throw (Safari private
 * mode, a locked-down iframe), and a malformed/foreign JSON blob under
 * this key must not crash the page over a feature that only ever
 * softens a screen-wake reload.
 *
 * @returns {object|null}
 */
function restoreStoredEnrollment() {
  try {
    const raw = sessionStorage.getItem(STORED_ENROLLMENT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const expiresAtMs = new Date(parsed.expiresAt).getTime()
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      // Already expired (or unparseable) -- nothing usable to restore.
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Persists `enrollment` under `STORED_ENROLLMENT_KEY`, or clears the key
 * entirely when `enrollment` is `null`/`undefined`. Never throws for the
 * same reason `restoreStoredEnrollment` never does.
 *
 * @param {object|null|undefined} enrollment
 */
function persistEnrollment(enrollment) {
  try {
    if (!enrollment) {
      sessionStorage.removeItem(STORED_ENROLLMENT_KEY)
      return
    }
    sessionStorage.setItem(STORED_ENROLLMENT_KEY, JSON.stringify(enrollment))
  } catch {
    // Storage unavailable/full/blocked -- the page still works, it just
    // loses the wake-from-sleep recovery this exists to provide.
  }
}

/**
 * The four tabs this view renders, in display order.
 *
 * Bugfix: ATAK and TAK Aware used to share ONE tab ("ATAK / TAK Aware")
 * with both platforms' instructions stacked in a single list, even though
 * they are two distinct apps on two distinct platforms (ATAK is
 * Android-only, TAK Aware is iOS-only). They now split into separate
 * tabs -- ATAK and TAK_AWARE -- each with only its own instructions.
 * Both continue to render the SAME QR code (`enrollment.atakQrDataUrl`):
 * splitting the tab is a UI clarity fix, not a change to what credential
 * either platform scans -- TAK Aware's own onboarding flow explicitly
 * tells the user to scan an "Android QR code", so reusing the identical
 * image is correct, not a shortcut.
 */
const TABS = Object.freeze({
  ATAK: 'atak',
  TAK_AWARE: 'tak_aware',
  ITAK: 'itak',
  MANUAL: 'manual'
})

export default function EnrollmentView({
  fetchEnrollment = fetchSelfEnrollment,
  fetchPreview = fetchSelfPreview
}) {
  // Whether THIS instance is using the default self-service fetchers --
  // checked by identity, not by any prop the caller sets explicitly. Only
  // the self-service `/enrollment` route (a phone's own screen can sleep
  // on it) persists/restores across a reload; `TeamDetail.jsx`'s
  // device-enrollment modal supplies its own bound fetchers and must
  // never touch `STORED_ENROLLMENT_KEY` at all (see that constant's own
  // doc comment).
  const isSelfServiceInstance = fetchEnrollment === fetchSelfEnrollment && fetchPreview === fetchSelfPreview

  const [preview, setPreview] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [enrollment, setEnrollment] = useState(() => (isSelfServiceInstance ? restoreStoredEnrollment() : null))
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
  const [isIOS] = useState(() =>
    isIOSClient(typeof navigator === 'undefined' ? null : navigator)
  )

  // The WinTAK/Manual tab's configurable "Description" label
  // (WINTAK_MANUAL_DESCRIPTION, server/models/SiteConfig.js). A
  // mount-only fetch, matching Downloads.jsx's identical `cloudtak_url`
  // pattern: starts at the same default the server itself falls back to,
  // and a failed fetch silently keeps that default rather than blocking
  // or erroring the page over one presentational string.
  const [manualDescription, setManualDescription] = useState(DEFAULT_MANUAL_DESCRIPTION)

  useEffect(() => {
    let cancelled = false
    configAPI.getPublic()
      .then((response) => {
        if (!cancelled) {
          setManualDescription(response.data?.enrollment_manual_description || DEFAULT_MANUAL_DESCRIPTION)
        }
      })
      .catch(() => {
        // Fail closed to the same default already in state -- no action needed.
      })
    return () => { cancelled = true }
  }, [])

  // The NO-MINT preview call. Runs automatically on mount (the effect
  // below) and is the ONLY thing that runs automatically -- it mints
  // nothing and calls Authentik nowhere on the server.
  const loadPreview = useCallback(async () => {
    try {
      const result = await fetchPreview()
      setPreview(result)
      setPreviewError(null)

      // Bugfix (screen-wake reload): the actual guard against a restored
      // `enrollment` (see the lazy `useState` initializer above) belonging
      // to a DIFFERENT signed-in identity than whoever is looking at the
      // page right now -- `sessionStorage` persists across a same-tab
      // re-login, but a `principalId` mismatch against this freshly
      // fetched, live preview means the stored value is stale for THIS
      // session and must never be shown or reused.
      if (isSelfServiceInstance) {
        setEnrollment((current) => {
          if (current && current.principalId !== result.principalId) {
            persistEnrollment(null)
            return null
          }
          return current
        })
      }
    } catch (err) {
      setPreviewError(interpretEnrollmentError(err))
    }
  }, [fetchPreview, isSelfServiceInstance])

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
      // Bugfix (screen-wake reload): persist the freshly minted
      // enrollment so a mid-countdown page reload (a phone's screen
      // sleeping and waking is the common real-world trigger) can restore
      // it instead of losing the QR codes outright. Self-service only --
      // see `STORED_ENROLLMENT_KEY`'s own doc comment.
      if (isSelfServiceInstance) {
        persistEnrollment(result)
      }
    } catch (err) {
      setError(interpretEnrollmentError(err))
    } finally {
      setGenerating(false)
    }
  }, [fetchEnrollment, isSelfServiceInstance])

  const handleExpired = useCallback(() => {
    setIsExpired(true)
    // Bugfix (screen-wake reload): an EXPIRED enrollment must not survive
    // a reload either -- restoring an already-lapsed code would just
    // reproduce the "Enrollment link expired" state a moment later, and
    // worse, would keep a spent Enrollment_Token's secret material sitting
    // in sessionStorage indefinitely rather than clearing it the moment it
    // stops being useful.
    if (isSelfServiceInstance) {
      persistEnrollment(null)
    }
  }, [isSelfServiceInstance])

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
  const isDevicePrincipal = summary?.principalKind === 'device'

  const tabButtonClass = (tab) =>
    `flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
      activeTab === tab
        ? 'border-primary-500 text-primary-600 dark:text-primary-400'
        : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
    }`

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Enroll a TAK Client</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Review your enrollment data below, then generate a code to scan with ATAK, TAK Aware, iTAK, or enter manually.
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
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-3">
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
              {/* Bugfix: this used to be a separate amber
                  "This account has N active TAK Server certificates"
                  note below the grid (MultipleCertificateWarning),
                  rendered ONLY for N > 1 -- amber reads as a warning, but
                  more than one certificate here is the ORDINARY case (one
                  per enrolled client: ATAK, CloudTAK, a second device,
                  etc.), not an anomaly. Folded into the grid as its own
                  field instead, showing the count unconditionally
                  (including 0 and 1, where the old component rendered
                  nothing at all): green for any count of at least one
                  ("something is enrolled and live"), amber ONLY at
                  exactly zero -- the one value on this self-service
                  enrollment page that plausibly means "nothing has taken
                  effect yet", the actual condition worth a second look. */}
              <div>
                <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">
                  Active TAK Server Certificates
                </dt>
                <dd className={`text-sm font-medium ${certificateCountColorClass(summary.liveCertificateCount)}`}>
                  {isValidCertificateCount(summary.liveCertificateCount)
                    ? summary.liveCertificateCount
                    : UNSET_ATTRIBUTE_LABEL}
                </dd>
              </div>
            </dl>
          </div>

          <hr className="border-gray-200 dark:border-gray-700" />

          {/* Device Enrollment Requirements -- matches the retired
              Enrollment_Lambda's section of the same name verbatim. */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-3">
              Device Enrollment Requirements
            </h2>
            <ul className="list-disc list-inside space-y-1 text-sm text-gray-700 dark:text-gray-300">
              <li>
                <span className="font-medium">Device Registration:</span>{' '}
                {isDevicePrincipal
                  ? 'This device will be linked to the team, not to a personal account. Only enroll a device you are authorised to register on the team\'s behalf.'
                  : 'This device will be linked to your account. Only enroll devices that you are authorised to use and are personally responsible for.'}
              </li>
              <li>
                <span className="font-medium">Enrollment Duration:</span> Your device enrollment is valid for 1
                year.
              </li>
              <li>
                <span className="font-medium">Client Software:</span> ATAK, TAK Aware, iTAK or WinTAK must
                already be{' '}
                <Link to="/downloads" className="text-primary-600 dark:text-primary-400 underline">
                  installed
                </Link>
                .
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
              <PreGenerationDeviceNotice isAndroid={isAndroid} isIOS={isIOS} />
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="btn-primary px-6 py-2.5"
              >
                {generating ? 'Generating…' : 'Generate Enrollment Data'}
              </button>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                This generates a one-time enrollment code valid for 30 minutes.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Four tabs -- ATAK, TAK Aware, iTAK, and Manual -- each led
                  by its platform's OS logo (Android for ATAK, Apple for
                  TAK Aware and iTAK, Windows for Manual/WinTAK). Bugfix:
                  ATAK and TAK Aware used to share one combined tab; they
                  are now split (see the TABS doc comment above).
                  Bugfix: below `sm`, a single non-wrapping row previously
                  either overflowed (scrolling the desktop row too, since
                  the same `overflow-x-auto` class applied at every width)
                  or truncated "TAK Aware" down to "Aware" to fit. Below
                  `sm` this is now a 2x2 GRID -- every full label fits at
                  full width on its own half-row, nothing is ever
                  abbreviated -- and `sm:` and up reverts to the original
                  single, non-scrolling row (`sm:flex`), which is where the
                  stray scrollbar came from: `overflow-x-auto` on a row
                  that fits its container still measures as a
                  horizontally-scrollable box in some browsers even when
                  there's nothing to scroll to. */}
              <div>
                <div
                  className="grid grid-cols-2 gap-1 sm:flex sm:gap-0 border-b border-gray-200 dark:border-gray-700"
                  role="tablist"
                >
                  <button
                    type="button"
                    {...tabAria(activeTab, TABS.ATAK)}
                    className={tabButtonClass(TABS.ATAK)}
                    onClick={() => setActiveTab(TABS.ATAK)}
                  >
                    <AndroidPlatformLogo className="h-4 w-4 flex-shrink-0" />
                    ATAK
                  </button>
                  <button
                    type="button"
                    {...tabAria(activeTab, TABS.TAK_AWARE)}
                    className={tabButtonClass(TABS.TAK_AWARE)}
                    onClick={() => setActiveTab(TABS.TAK_AWARE)}
                  >
                    <ApplePlatformLogo className="h-4 w-4 flex-shrink-0" />
                    TAK Aware
                  </button>
                  <button
                    type="button"
                    {...tabAria(activeTab, TABS.ITAK)}
                    className={tabButtonClass(TABS.ITAK)}
                    onClick={() => setActiveTab(TABS.ITAK)}
                  >
                    <ApplePlatformLogo className="h-4 w-4 flex-shrink-0" />
                    iTAK
                  </button>
                  <button
                    type="button"
                    {...tabAria(activeTab, TABS.MANUAL)}
                    className={tabButtonClass(TABS.MANUAL)}
                    onClick={() => setActiveTab(TABS.MANUAL)}
                  >
                    <WindowsPlatformLogo className="h-4 w-4 flex-shrink-0" />
                    <span className="sm:hidden">WinTAK</span>
                    <span className="hidden sm:inline">WinTAK / Manual</span>
                  </button>
                </div>

                <div className="pt-4">
                  <TabPanel id={TABS.ATAK} activeTab={activeTab}>
                    <div className="text-center">
                      {/* The direct-enroll shortcut, ANDROID-ONLY (this
                          device already has ATAK installed and can follow
                          the deep link straight away, skipping the
                          QR-scan flow below entirely) -- moved above the
                          QR instructions, with an "OR" divider beneath it,
                          so a user on the device being enrolled sees the
                          fast path FIRST rather than after already reading
                          past it once. Non-Android clients (viewing this
                          page on a laptop to generate a code for a
                          different phone) never see this block at all --
                          same `isAndroid` gate as the deep-link button
                          itself always used. */}
                      {isAndroid && (
                        <div className="mb-4">
                          <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
                            Already have ATAK installed on this Android device? You can directly enroll this
                            device.
                          </p>
                          {isExpired ? (
                            // Criterion 10.2: the same transition that ticks
                            // the countdown to its terminal state replaces
                            // this link's text with an expired message. No
                            // longer a clickable <a> once expired.
                            <p className="text-sm text-red-600 dark:text-red-400">Enrollment link expired</p>
                          ) : (
                            <a href={enrollment.atakEnrollmentUri} className="btn-primary inline-block text-sm">
                              Enroll this device now
                            </a>
                          )}
                          <div className="flex items-center gap-3 max-w-md mx-auto mt-4">
                            <hr className="flex-1 border-gray-200 dark:border-gray-700" />
                            <span className="text-xs font-medium text-gray-400 dark:text-gray-500">OR</span>
                            <hr className="flex-1 border-gray-200 dark:border-gray-700" />
                          </div>
                        </div>
                      )}
                      <DifferentDeviceNotice />
                      <ul className="text-sm text-gray-700 dark:text-gray-300 text-left list-disc list-inside mb-4 space-y-1 max-w-md mx-auto">
                        <li>
                          ATAK must already be{' '}
                          <Link to="/downloads" className="text-primary-600 dark:text-primary-400 underline">
                            installed
                          </Link>
                          .
                        </li>
                        <li>Open your camera app.</li>
                        <li>Point at the QR code below.</li>
                        <li>Tap the link that appears.</li>
                        <li>Follow the on-screen instructions.</li>
                      </ul>
                      <img
                        src={enrollment.atakQrDataUrl}
                        alt="ATAK enrollment QR code"
                        className="mx-auto w-full max-w-[240px] border border-gray-200 dark:border-gray-700 rounded-lg"
                      />
                    </div>
                  </TabPanel>

                  <TabPanel id={TABS.TAK_AWARE} activeTab={activeTab}>
                    <div className="text-center">
                      <DifferentDeviceNotice />
                      <ul className="text-sm text-gray-700 dark:text-gray-300 text-left list-disc list-inside mb-4 space-y-1 max-w-md mx-auto">
                        <li>
                          TAK Aware must already be{' '}
                          <Link to="/downloads" className="text-primary-600 dark:text-primary-400 underline">
                            installed
                          </Link>
                          .
                        </li>
                        <li>Open TAK Aware and select "Connect to a TAK Server".</li>
                        <li>Set your Callsign, Team Color and Role as shown above.</li>
                        <li>Select "Scan Android QR code".</li>
                        <li>Point the camera at the QR code below.</li>
                      </ul>
                      {/* Same image as the ATAK tab (`atakQrDataUrl`), not a
                          distinct one -- TAK Aware's own onboarding flow
                          explicitly asks the user to scan an "Android QR
                          code", so this is the credential TAK Aware
                          expects, not a placeholder. */}
                      <img
                        src={enrollment.atakQrDataUrl}
                        alt="TAK Aware enrollment QR code"
                        className="mx-auto w-full max-w-[240px] border border-gray-200 dark:border-gray-700 rounded-lg"
                      />
                    </div>
                  </TabPanel>

                  <TabPanel id={TABS.ITAK} activeTab={activeTab}>
                    <div className="text-center">
                      <DifferentDeviceNotice />
                      <ul className="text-sm text-gray-700 dark:text-gray-300 text-left list-disc list-inside mb-4 space-y-1 max-w-md mx-auto">
                        <li>
                          iTAK version 2.12.3 or later must already be{' '}
                          <Link to="/downloads" className="text-primary-600 dark:text-primary-400 underline">
                            installed
                          </Link>
                          .
                        </li>
                        <li>Within iTAK tap "Network", then "Servers".</li>
                        <li>Select the plus icon (+) in the bottom right.</li>
                        <li>Tap on "Scan QR" and scan the QR code below.</li>
                        <li>Follow the on-screen instructions.</li>
                      </ul>
                      <img
                        src={enrollment.itakQrDataUrl}
                        alt="iTAK enrollment QR code"
                        className="mx-auto w-full max-w-[240px] border border-gray-200 dark:border-gray-700 rounded-lg"
                      />
                    </div>
                  </TabPanel>

                  <TabPanel id={TABS.MANUAL} activeTab={activeTab}>
                    <div className="max-w-md mx-auto space-y-4">
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        Enter these details manually on a WinTAK or other TAK client that cannot scan a QR code.
                      </p>
                      <div>
                        <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Description</dt>
                        <dd className="flex items-center gap-2">
                          <span className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
                            {manualDescription}
                          </span>
                          {/* Bugfix (mobile tap target too small): -m-2
                              p-2 enlarges the hit box (was a bare h-4 w-4
                              icon with no padding, a ~16px target) without
                              inflating the row's own visible layout --
                              same technique InfoTooltip.jsx/
                              OrgDomainManager.jsx use. Applied identically
                              to all four copy buttons on this tab. */}
                          <button
                            type="button"
                            onClick={() => handleCopy(manualDescription, 'Description')}
                            className="-m-2 p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700"
                            aria-label="Copy description"
                            title="Copy description"
                          >
                            <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Protocol</dt>
                        <dd className="text-sm font-mono text-gray-900 dark:text-gray-100">{MANUAL_PROTOCOL}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Host Address</dt>
                        <dd className="flex items-center gap-2">
                          <span className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
                            {enrollment.host}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(enrollment.host, 'Host address')}
                            className="-m-2 p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700"
                            aria-label="Copy host address"
                            title="Copy host address"
                          >
                            <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Port</dt>
                        <dd className="text-sm font-mono text-gray-900 dark:text-gray-100">{MANUAL_PORT}</dd>
                      </div>
                      {/* Both are FIXED, permanently-checked, decorative
                          indicators (`StaticCheckedIndicator`, see its own
                          doc comment) -- not real form controls. Every
                          manual enrollment this view generates a code for
                          enrolls a client certificate and requires
                          authentication; there is no configuration path
                          that produces the opposite, so nothing here can be
                          unticked. They exist so a user copying WinTAK's own
                          manual-enrollment form field-for-field sees exactly
                          which options to set there, matching WinTAK's own
                          labels. */}
                      <StaticCheckedIndicator label="Enroll for Client Certificate" />
                      <StaticCheckedIndicator label="Use Authentication" />
                      <div>
                        <dt className="text-xs text-gray-500 dark:text-gray-400 mb-1">Username</dt>
                        <dd className="flex items-center gap-2">
                          <span className="text-sm font-mono text-gray-900 dark:text-gray-100 break-all">
                            {enrollment.username}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(enrollment.username, 'Username')}
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
                        {/* The real enrollment code is NEVER rendered as
                            text -- only a fixed run of bullet characters,
                            regardless of the real code's length. Only the
                            Copy button ever touches the real value, and it
                            goes straight to the clipboard, never through
                            component state that could re-render it visibly. */}
                        <dd className="flex items-center gap-2">
                          <span
                            className="text-sm font-mono text-gray-900 dark:text-gray-100 tracking-widest"
                            aria-label="Password hidden"
                          >
                            {'•'.repeat(12)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(itakUserCredentials.password, 'Password')}
                            className="-m-2 p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-700"
                            aria-label="Copy password"
                            title="Copy password"
                          >
                            <ClipboardDocumentIcon className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </dd>
                      </div>
                    </div>
                  </TabPanel>
                </div>
              </div>

              <hr className="border-gray-200 dark:border-gray-700" />

              {/* Moved to the bottom of the page (was above the tabs):
                  the live MM : SS countdown, shared across all three
                  scan-based tabs (one token, one expiry, regardless of
                  which tab is active), plus the re-enrollment date.
                  "Generate Enrollment Data" is reused as the regenerate
                  label too -- functionally the identical action as the
                  first click, so it keeps the same name rather than a
                  second phrase for the same thing. */}
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
