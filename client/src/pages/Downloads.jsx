import { useState, useEffect } from 'react'
import { ComputerDesktopIcon, GlobeAltIcon } from '@heroicons/react/24/outline'
import { GooglePlayBadge, AppleAppStoreBadge, TakGovBadge, RecommendedOptionMarker, RecommendedOptionGlyph } from '../components/StoreBadges'
import { AndroidPlatformLogo, ApplePlatformLogo } from '../components/PlatformLogos'
import { configAPI } from '../services/api'

/**
 * Downloads_Page (downloads-page-os-sections spec; supersedes the
 * takserver-enrollment Requirement 12 2x2-grid layout this page originally
 * shipped with).
 *
 * The page is organized by target operating system rather than by app
 * store: an Android_Section, an iOS_Section, and a Windows_Section, each
 * rendered by the shared `OsSection` sub-component below. A CloudTAK_Row
 * spanning all three OS_Sections is rendered below the grid, but only once
 * `configAPI.getPublic()`'s `cloudtak_url` field resolves non-null
 * (Criterion 4.6) -- see the fetch effect in the default-exported
 * component below.
 *
 * Each OS_Section's header pairs a decorative Platform_Logo
 * (`aria-hidden="true"`, Criterion 6.8) with a visible OS name text label
 * (Criteria 1.4, 2.4, 2.6, 3.5) -- the logo never carries its own
 * accessible name since the adjacent text already names the platform.
 *
 * The Recommended_Option_Marker (`StoreBadges.jsx`) appears on exactly the
 * recommended Download_Route within each OS_Section (ATAK-via-TAK.gov in
 * Android_Section, TAK Aware in iOS_Section) and on no other route
 * (Criteria 1.2, 1.3, 2.2, 2.3). The same star/legend text is restated once
 * more as a footnote below all sections, at the page level, exactly once
 * (Criterion 7.2) -- unconditional and unchanged from before this
 * restructuring.
 *
 * Every badge renders at the SAME visible size (`BADGE_CLASSNAME`, fixed
 * height with `w-auto`) regardless of its own intrinsic SVG dimensions
 * (Criterion 7.3) -- see the original doc comment history in this file's
 * git log for why (Google Play's 180 x 53.333 viewBox against Apple/TAK.gov's
 * 135 x 40).
 *
 * This page fetches nothing yet in this task: every link is a static
 * external target, so it adds NO entry to
 * `server/config/permissions.registry.js`. Its reachability is a client
 * routing fact (the nav item and the `/downloads` route are both ungated,
 * per `Layout.jsx`), not an authorization one (Criterion 7.4).
 */

/**
 * The one sizing class every badge renders with, so every SVG -- despite
 * different intrinsic sizes across the badge components -- presents at a
 * uniform height within its OS_Section. A fixed height plus `w-auto` scales
 * each badge by its own aspect ratio rather than stretching it to a fixed
 * width.
 */
const BADGE_CLASSNAME = 'h-10 w-auto'

const ANDROID_ROUTES = [
  {
    key: 'atak-tak-gov',
    href: 'https://tak.gov/products/atak-civ',
    label: 'ATAK',
    Badge: TakGovBadge,
    recommended: true,
    badgeAriaLabel: undefined,
  },
  {
    key: 'atak-civ-google-play',
    href: 'https://play.google.com/store/apps/details?id=com.atakmap.app.civ',
    label: 'ATAK',
    Badge: GooglePlayBadge,
    recommended: false,
    badgeAriaLabel: undefined,
  },
]

const IOS_ROUTES = [
  {
    key: 'tak-aware-apple',
    href: 'https://apps.apple.com/in/app/tak-aware/id6738631659',
    label: 'TAK Aware',
    Badge: AppleAppStoreBadge,
    recommended: true,
    badgeAriaLabel: undefined,
  },
  {
    key: 'itak-apple',
    href: 'https://apps.apple.com/us/app/itak/id1561656396',
    label: 'iTAK',
    Badge: AppleAppStoreBadge,
    recommended: false,
    badgeAriaLabel: undefined,
  },
]

// Windows_Section's single WinTAK route. `badgeAriaLabel` gives this
// route's TakGovBadge reuse a distinct accessible name from the
// ATAK-via-TAK.gov route's own TakGovBadge use (Criteria 3.6, 3.7) -- see
// OsSection's `aria-label` override below.
const WINDOWS_ROUTES = [
  {
    key: 'wintak-tak-gov',
    href: 'https://tak.gov/products/wintak-civ',
    label: 'WinTAK',
    Badge: TakGovBadge,
    recommended: false,
    badgeAriaLabel: 'Get it from TAK.gov — WinTAK',
  },
]

/**
 * OsSection (downloads-page-os-sections design.md, "Downloads.jsx
 * (restructured)"): one Android_Section/iOS_Section/Windows_Section column.
 * Defined in this file rather than extracted -- it has a single caller.
 *
 * Renders the section header (decorative `PlatformLogo` beside the visible
 * `osLabel` text) and the routes list: each route's label, its
 * Recommended_Option_Marker when `recommended`, and a badge anchor carrying
 * `rel="noopener"`, `target="_blank"`, and an optional `aria-label`
 * override (`badgeAriaLabel`) applied only when present -- used by the
 * WinTAK route (task 7.2) to give its `TakGovBadge` reuse a distinct
 * accessible name from the ATAK-via-TAK.gov route's own `TakGovBadge` use.
 */
function OsSection({ PlatformLogo, osLabel, routes }) {
  return (
    <div className="flex flex-col gap-6 pb-8 sm:pb-0 sm:px-6 first:sm:pl-0 last:sm:pr-0">
      <div className="flex items-center gap-2 justify-center">
        <PlatformLogo className="h-5 w-5 text-gray-700 dark:text-gray-300" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{osLabel}</h2>
      </div>
      <div className="flex flex-col items-center gap-6">
        {routes.map(({ key, href, label, Badge, recommended, badgeAriaLabel }) => (
          <div key={key} className="flex flex-col items-center text-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {label}
              </span>
              {recommended && <RecommendedOptionMarker />}
            </div>
            <a
              href={href}
              target="_blank"
              rel="noopener"
              className="inline-block"
              {...(badgeAriaLabel ? { 'aria-label': badgeAriaLabel } : {})}
            >
              <Badge className={BADGE_CLASSNAME} />
            </a>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Downloads() {
  // CloudTAK_Row's data source (design.md "The CloudTAK_Row fetch"): a
  // mount-only fetch of the Public_Config_Endpoint's `cloudtak_url` field.
  // `cloudTakUrl` starts `null`, so a rejected fetch is indistinguishable
  // from a successful `{ cloudtak_url: null }` response -- fail-closed per
  // Criterion 4.6's spirit, extended to the network-failure case.
  const [cloudTakUrl, setCloudTakUrl] = useState(null)

  useEffect(() => {
    let cancelled = false
    configAPI.getPublic()
      .then((response) => {
        if (!cancelled) setCloudTakUrl(response.data?.cloudtak_url ?? null)
      })
      .catch(() => {
        // Fail closed: cloudTakUrl's initial state is already null, so no
        // action is needed beyond not throwing.
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Download a TAK Client</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Install one of the TAK clients below, then enroll it from the Enrollment page.
        </p>
      </div>

      <div className="card">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 divide-y divide-gray-200 dark:divide-gray-700 sm:divide-y-0 sm:divide-x">
          <OsSection PlatformLogo={AndroidPlatformLogo} osLabel="Android" routes={ANDROID_ROUTES} />
          <OsSection PlatformLogo={ApplePlatformLogo} osLabel="iOS" routes={IOS_ROUTES} />
          <OsSection PlatformLogo={ComputerDesktopIcon} osLabel="Windows" routes={WINDOWS_ROUTES} />
        </div>

        {/* CloudTAK_Row (Requirement 4): a sibling block below the
            3-column grid, inside the same .card, rather than a 4th grid
            item with col-span-full (design.md Decision 2) -- this way the
            row's markup carries no dependency on the grid's own column
            count. Rendered only when cloudTakUrl resolves non-null
            (Criterion 4.6); omitted entirely otherwise, with no loading
            state in between. */}
        {cloudTakUrl && (
          <div className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-700 flex flex-col items-center text-center gap-3">
            <div className="flex items-center gap-2">
              <GlobeAltIcon className="h-5 w-5 text-gray-700 dark:text-gray-300" aria-hidden="true" />
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">CloudTAK</span>
            </div>
            <a
              href={cloudTakUrl}
              target="_blank"
              rel="noopener"
              className="text-sm text-primary-600 dark:text-primary-500 underline"
            >
              {cloudTakUrl}
            </a>
            <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">
              CloudTAK runs in any web browser — no install needed. Use it on Android, iOS,
              Windows, or any other operating system with a browser, including macOS and Linux.
            </p>
          </div>
        )}

        {/* Footnote legend (Criterion 7.2): the same glyph and the same
            "Recommended option" text the markers above disclose on
            hover/focus, stated once more as plain, always-visible text at
            the page level -- not duplicated per OS_Section -- so the
            meaning of the star does not depend on a reader finding and
            triggering any one tooltip. */}
        <p className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <RecommendedOptionGlyph className="h-3.5 w-3.5" />
          <span>Recommended option</span>
        </p>
      </div>
    </div>
  )
}
