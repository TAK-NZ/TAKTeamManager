import { useState, useEffect } from 'react'
import { GooglePlayBadge, AppleAppStoreBadge, TakGovBadge, RecommendedOptionMarker, RecommendedOptionGlyph } from '../components/StoreBadges'
import { AndroidPlatformLogo, ApplePlatformLogo, WindowsPlatformLogo } from '../components/PlatformLogos'
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
  // `sm:pb-0`/`sm:pt-0` still apply once the grid leaves single-column (2
  // or 3 columns), but the horizontal `px-6`/first-last edge trim only
  // makes sense once the vertical divider itself exists, which is now
  // `md:` (see the grid's own `md:divide-x` above) rather than `sm:`.
  //
  // Bugfix: below `sm` the grid's own `divide-y` (active only there --
  // `sm:divide-y-0` turns it off at `sm:` and up) draws a horizontal rule
  // between stacked sections. `pb-8` alone left a gap BEFORE that rule but
  // none AFTER it, so the rule sat flush against the next section's own
  // heading -- reported as the divider "overlapping" the iOS/Windows
  // text. `pt-8 first:pt-0` mirrors the existing `pb-8` pattern: every
  // section but the first (which needs no leading gap, matching
  // `divide-y`'s own "no rule before the first child" behaviour) gets
  // breathing room below the rule too. `sm:pt-0` keeps desktop's
  // side-by-side row alignment unaffected, exactly like `sm:pb-0` already
  // does for the bottom.
  return (
    <div className="flex flex-col gap-6 pb-8 pt-8 first:pt-0 sm:pb-0 sm:pt-0 md:px-6 first:md:pl-0 last:md:pr-0">
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
        {/* `sm:grid-cols-2 md:grid-cols-3` (rather than jumping straight
            from 1 to 3 columns at `sm:`) gives a landscape phone or small
            tablet (~640-767px) a 2-up layout instead of a cramped 3-up
            one; a true phone-portrait viewport still gets the 1-column
            stacked layout below `sm:`, unchanged. The divider classes
            follow the same two-step promotion: no dividers until 2
            columns exist (`sm:`), then the vertical divider only once 3
            columns exist (`md:`). */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8 divide-y divide-gray-200 dark:divide-gray-700 sm:divide-y-0 md:divide-x">
          <OsSection PlatformLogo={AndroidPlatformLogo} osLabel="Android" routes={ANDROID_ROUTES} />
          <OsSection PlatformLogo={ApplePlatformLogo} osLabel="iOS" routes={IOS_ROUTES} />
          <OsSection PlatformLogo={WindowsPlatformLogo} osLabel="Windows" routes={WINDOWS_ROUTES} />
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
              {/* TAK-NZ's own black-and-white CloudTAK mark: an SVG built
                  from CloudTAK's own real vector
                  (api/web/public/CloudTAKLogo.svg), gradient fill swapped
                  for solid black plus a white outline (`paint-order`) --
                  the vector equivalent of this deployment's actual
                  install icon (cdk/src/cloudtak-oidc-setup/CloudTAKLogo.png),
                  legible on any background with no backing shape needed.

                  Bugfix: the mark's native aspect ratio is ~1.59:1 (wider
                  than tall) -- forcing it into the SAME square `h-5 w-5`
                  box the other three (near-square) Platform_Logos use
                  stretched/squashed it vertically. `h-5 w-auto` lets the
                  browser derive the width from the SVG's own viewBox
                  instead of a fixed square, exactly like `BADGE_CLASSNAME`
                  above already does for the store badges for the identical
                  reason. */}
              <img src="/assets/cloudtak-logo.svg" alt="" className="h-5 w-auto flex-shrink-0" aria-hidden="true" />
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
