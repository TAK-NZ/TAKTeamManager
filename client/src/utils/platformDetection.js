/**
 * Client-side platform detection (Requirement 10.6: Android_Only_Suppression)
 *
 * The Enrollment_Lambda suppresses the ATAK_Deep_Link server-side, by reading
 * the `sec-ch-ua-platform` request header on the page request. A single-page
 * application has no such request to inspect -- it renders from data fetched
 * by an API call -- so the same decision has to be made client-side instead
 * (Criterion 10.6).
 *
 * `isAndroidClient` takes `nav` as a PARAMETER rather than reaching for the
 * global `navigator` object anywhere in its body. This is deliberate: a
 * property test (a later, separate task) hands this function hostile and
 * synthetic shapes -- including a `userAgentData.platform` getter that
 * throws -- and doing that without stubbing `globalThis.navigator` requires
 * the object to arrive as an argument.
 *
 * Detection order, in order of preference:
 *
 *   1. `nav.userAgentData.platform` -- the modern client-hints equivalent of
 *      the `sec-ch-ua-platform` header the Enrollment_Lambda reads. Checked
 *      case-insensitively for `'android'`, since `userAgentData.platform` is
 *      a defined platform name (`"Android"`, `"Windows"`, `"macOS"`, ...)
 *      rather than free text.
 *   2. FALLBACK: `/android/i` tested against `nav.userAgent`, matching
 *      "Android" appearing anywhere in the user-agent string. Used only when
 *      `userAgentData`/`userAgentData.platform` is absent or unusable.
 *
 * PURE, TOTAL, NEVER THROWING. Every input whatsoever yields `true` or
 * `false`. In particular:
 *
 *   - `null`, `undefined`, or a non-object `nav` (a primitive) -> `false`.
 *   - An absent or non-string `nav.userAgent`, when the fallback path is
 *     reached -> `false`.
 *   - A `nav.userAgentData` whose `platform` accessor is a GETTER THAT
 *     THROWS -> `false`, never propagated. Guarded with try/catch, because
 *     merely reading `nav.userAgentData.platform` can throw before any type
 *     check on the result runs.
 *
 * This lives in `client/src/utils/` beside `expiryWarning.js` for the same
 * reason: a pure, total function with an interesting boundary (the throwing
 * getter) belongs somewhere a property test can reach it directly, rather
 * than inside the component that happens to consume it.
 */

/**
 * Reads `nav.userAgentData.platform` defensively, tolerating every shape
 * `nav` might take -- including a `platform` accessor that throws.
 *
 * @param {*} nav Anything at all.
 * @returns {string|null} The `platform` value when it is a string, `null`
 *   otherwise (including when reading it throws).
 */
function readUserAgentDataPlatform(nav) {
  try {
    const platform = nav?.userAgentData?.platform
    return typeof platform === 'string' ? platform : null
  } catch {
    // A hostile getter on `userAgentData.platform` (or on `userAgentData`
    // itself) must never propagate out of `isAndroidClient`.
    return null
  }
}

/**
 * Reads `nav.userAgent` defensively.
 *
 * @param {*} nav Anything at all.
 * @returns {string|null} The `userAgent` value when it is a string, `null`
 *   otherwise (including when reading it throws).
 */
function readUserAgent(nav) {
  try {
    const userAgent = nav?.userAgent
    return typeof userAgent === 'string' ? userAgent : null
  } catch {
    return null
  }
}

/**
 * Detects whether `nav` describes an Android client (Criterion 10.6).
 *
 * @param {*} nav A navigator-shaped object, or anything at all. NEVER the
 *   global `navigator` -- always the caller-supplied value.
 * @returns {boolean} `true` when Android is detected, `false` otherwise.
 *   Never throws.
 */
export function isAndroidClient(nav) {
  const platform = readUserAgentDataPlatform(nav)
  if (platform !== null) {
    return platform.toLowerCase() === 'android'
  }

  const userAgent = readUserAgent(nav)
  if (userAgent !== null) {
    return /android/i.test(userAgent)
  }

  return false
}

/**
 * Detects whether `nav` describes an iOS or iPadOS client -- an iPhone,
 * iPod touch, or iPad. Same total/never-throwing/pure contract and same
 * detection order as `isAndroidClient` above: `userAgentData.platform`
 * first (checked against BOTH `'ios'` and `'ipados'`, since those are the
 * two distinct platform names Apple's own client hints report -- an iPad
 * does not report `'ios'`), then a `userAgent` fallback matching
 * `iphone`/`ipad`/`ipod` anywhere in the string.
 *
 * Consumed by `EnrollmentView.jsx`'s pre-generation notice, which needs to
 * tell an iPhone/iPad user apart from every OTHER non-Android client
 * (desktop Windows/macOS/Linux) -- only an iOS/iPadOS visitor is the one
 * actually at risk of trying to scan a QR code with the same device
 * currently showing it.
 *
 * Known limitation, shared with any client-side check of this kind: modern
 * iPadOS Safari requests the desktop site by default and its `userAgent`
 * string names "Macintosh" rather than "iPad" (no `userAgentData` client
 * hints either, since Safari does not implement that API at all), so an
 * iPad in that default mode is NOT detected here and instead falls through
 * to the generic non-Android notice. This is a false negative, never a
 * false positive -- it degrades to the SAME wording a desktop Mac user
 * already sees, not an incorrect Android-branch answer.
 *
 * @param {*} nav A navigator-shaped object, or anything at all. NEVER the
 *   global `navigator` -- always the caller-supplied value.
 * @returns {boolean} `true` when iOS/iPadOS is detected, `false` otherwise.
 *   Never throws.
 */
export function isIOSClient(nav) {
  const platform = readUserAgentDataPlatform(nav)
  if (platform !== null) {
    const lowered = platform.toLowerCase()
    return lowered === 'ios' || lowered === 'ipados'
  }

  const userAgent = readUserAgent(nav)
  if (userAgent !== null) {
    return /iphone|ipad|ipod/i.test(userAgent)
  }

  return false
}
