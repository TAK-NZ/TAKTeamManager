import { GooglePlayBadge, AppleAppStoreBadge, TakGovBadge, RecommendedOptionMarker, RecommendedOptionGlyph } from '../components/StoreBadges'

/**
 * Downloads_Page (takserver-enrollment Requirement 12, task 10.2).
 *
 * A 2 x 2 grid of the four TAK client download routes, sourced from the
 * Enrollment_Lambda's `views/partials/store_badges.ejs` -- recommended
 * routes on the FIRST row, alternatives on the SECOND (Criterion 12.2):
 *
 *   Row 1 (recommended): ATAK | TAK Aware
 *   Row 2 (alternative):  ATAK | iTAK
 *
 * The four link targets are preserved UNCHANGED from the source partial
 * (Criterion 12.7) and every one of them carries `rel="noopener"`, exactly
 * as the partial does (Criterion 12.8). `AppleAppStoreBadge` is the SAME
 * component rendered twice -- for TAK Aware and for iTAK -- per
 * `StoreBadges.jsx`'s own doc comment; it is one component in two
 * positions, not two copies.
 *
 * The Recommended_Option_Marker (`StoreBadges.jsx`) appears on EXACTLY the
 * two recommended routes -- ATAK and TAK Aware -- and on NEITHER of the
 * other two (Criterion 12.5), and the same star/legend text is restated
 * once more as a footnote below the grid so a reader who has not hovered
 * either marker still learns what the star means.
 *
 * Every badge renders at the SAME visible size (`BADGE_CLASSNAME`, fixed
 * height with `w-auto`) regardless of its own intrinsic SVG dimensions --
 * the Google Play badge's intrinsic viewBox is 180 x 53.333 against the
 * Apple and TAK.gov badges' 135 x 40, and rendering all three at their raw
 * sizes left the Google Play badge visibly larger than its neighbours.
 * Fixing the height and letting the width follow keeps every badge's own
 * aspect ratio intact rather than stretching it.
 *
 * This page fetches nothing: every link is a static external target, so it
 * adds NO entry to `server/config/permissions.registry.js`. Its
 * reachability is a client routing fact (the nav item and the `/downloads`
 * route are both ungated, per `Layout.jsx`), not an authorization one.
 */

/**
 * The one sizing class every badge renders with, so the four SVGs --
 * despite three different intrinsic sizes across the three components --
 * present as a uniform row (the defect this fixes: the Google Play badge's
 * 180 x 53.333 intrinsic size otherwise renders visibly larger than the
 * Apple/TAK.gov badges' 135 x 40). A fixed height plus `w-auto` scales each
 * badge by its own aspect ratio rather than stretching it to a fixed width.
 */
const BADGE_CLASSNAME = 'h-10 w-auto'

const DOWNLOAD_ROUTES = [
  {
    key: 'atak-tak-gov',
    href: 'https://tak.gov/products/atak-civ',
    label: 'ATAK',
    Badge: TakGovBadge,
    recommended: true,
  },
  {
    key: 'tak-aware-apple',
    href: 'https://apps.apple.com/in/app/tak-aware/id6738631659',
    label: 'TAK Aware',
    Badge: AppleAppStoreBadge,
    recommended: true,
  },
  {
    key: 'atak-civ-google-play',
    href: 'https://play.google.com/store/apps/details?id=com.atakmap.app.civ',
    label: 'ATAK',
    Badge: GooglePlayBadge,
    recommended: false,
  },
  {
    key: 'itak-apple',
    href: 'https://apps.apple.com/us/app/itak/id1561656396',
    label: 'iTAK',
    Badge: AppleAppStoreBadge,
    recommended: false,
  },
]

export default function Downloads() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Download a TAK Client</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Install one of the TAK clients below, then enroll it from the Enrollment page.
        </p>
      </div>

      <div className="card">
        {/* Recommended routes (row 1) and alternatives (row 2). The array
            order above already matches this layout -- two recommended
            entries followed by two alternatives -- so a plain 2-column grid
            wraps it into the required 2 x 2 shape without a second data
            structure. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
          {DOWNLOAD_ROUTES.map(({ key, href, label, Badge, recommended }) => (
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
              >
                <Badge className={BADGE_CLASSNAME} />
              </a>
            </div>
          ))}
        </div>

        {/* Footnote legend (Criterion 12.5's marker, restated): the same
            glyph and the same "Recommended option" text the two markers
            above disclose on hover/focus, stated once more as plain,
            always-visible text so the meaning of the star does not depend
            on a reader finding and triggering either tooltip. */}
        <p className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <RecommendedOptionGlyph className="h-3.5 w-3.5" />
          <span>Recommended option</span>
        </p>
      </div>
    </div>
  )
}
