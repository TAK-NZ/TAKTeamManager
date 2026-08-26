import { GooglePlayBadge, AppleAppStoreBadge, TakGovBadge, RecommendedOptionMarker } from '../components/StoreBadges'

/**
 * Downloads_Page (takserver-enrollment Requirement 12, task 10.2).
 *
 * A 2 x 2 grid of the four TAK client download routes, sourced from the
 * Enrollment_Lambda's `views/partials/store_badges.ejs` -- recommended
 * routes on the FIRST row, alternatives on the SECOND (Criterion 12.2):
 *
 *   Row 1 (recommended): ATAK via TAK.gov          | TAK Aware via Apple App Store
 *   Row 2 (alternative):  ATAK Civ via Google Play  | iTAK via Apple App Store
 *
 * The four link targets are preserved UNCHANGED from the source partial
 * (Criterion 12.7) and every one of them carries `rel="noopener"`, exactly
 * as the partial does (Criterion 12.8). `AppleAppStoreBadge` is the SAME
 * component rendered twice -- for TAK Aware and for iTAK -- per
 * `StoreBadges.jsx`'s own doc comment; it is one component in two
 * positions, not two copies.
 *
 * The Recommended_Option_Marker (`StoreBadges.jsx`) appears on EXACTLY the
 * two recommended routes -- ATAK-via-TAK.gov and TAK Aware -- and on
 * NEITHER of the other two (Criterion 12.5).
 *
 * This page fetches nothing: every link is a static external target, so it
 * adds NO entry to `server/config/permissions.registry.js`. Its
 * reachability is a client routing fact (the nav item and the `/downloads`
 * route are both ungated, per `Layout.jsx`), not an authorization one.
 */

const DOWNLOAD_ROUTES = [
  {
    key: 'atak-tak-gov',
    href: 'https://tak.gov/products/atak-civ',
    label: 'ATAK',
    sublabel: 'via TAK.gov',
    Badge: TakGovBadge,
    recommended: true,
  },
  {
    key: 'tak-aware-apple',
    href: 'https://apps.apple.com/in/app/tak-aware/id6738631659',
    label: 'TAK Aware',
    sublabel: 'via Apple App Store',
    Badge: AppleAppStoreBadge,
    recommended: true,
  },
  {
    key: 'atak-civ-google-play',
    href: 'https://play.google.com/store/apps/details?id=com.atakmap.app.civ',
    label: 'ATAK Civ',
    sublabel: 'via Google Play',
    Badge: GooglePlayBadge,
    recommended: false,
  },
  {
    key: 'itak-apple',
    href: 'https://apps.apple.com/us/app/itak/id1561656396',
    label: 'iTAK',
    sublabel: 'via Apple App Store',
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
          {DOWNLOAD_ROUTES.map(({ key, href, label, sublabel, Badge, recommended }) => (
            <div key={key} className="flex flex-col items-center text-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {label}
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">{sublabel}</span>
                {recommended && <RecommendedOptionMarker />}
              </div>
              <a
                href={href}
                target="_blank"
                rel="noopener"
                className="inline-block"
              >
                <Badge />
              </a>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
