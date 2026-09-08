import { useState, useEffect, Fragment } from 'react'
import { XMarkIcon, MagnifyingGlassPlusIcon } from '@heroicons/react/24/outline'
import { GooglePlayBadge, AppleAppStoreBadge, TakGovBadge, RecommendedOptionMarker, RecommendedOptionGlyph } from '../components/StoreBadges'
import { AndroidPlatformLogo, ApplePlatformLogo, WindowsPlatformLogo } from '../components/PlatformLogos'
import FormattedDate, { DATE_PRECISION } from '../components/FormattedDate'
import toast from 'react-hot-toast'
import { configAPI, offlineMapsAPI } from '../services/api'

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

// ---------------------------------------------------------------------------
// OFFLINE MAPS — LAYOUT MOCK (offline-maps-download-design.md)
//
// This whole block is a PRESENTATION-ONLY mock so we can iterate on the
// layout. It uses hardcoded DUMMY data, renders NO real download, and talks
// to NO server. When the real feature lands, this dummy catalog is replaced
// by the `GET /api/offline-maps` response (catalog + live sizes) and each
// Download button will fetch a presigned URL from `GET /api/offline-maps/:id/url`.
// Ordering here is authoritative-by-array-position, matching the design doc:
// North Island (N->S), South Island (N->S), Chatham Islands, Marine, Vector.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024
const GB = 1024 * MB

// Static PRESENTATION metadata per group (heading, app-compatibility text, and
// the per-section preview image). The map ROWS and their SIZES come from the
// server (`GET /api/offline-maps`, live from S3) and are merged into these
// groups by the server's `group` key. Array order here IS display order:
// North Island, South Island, Chatham Islands, Marine, Vector.
const OFFLINE_MAP_GROUP_META = [
  {
    key: 'north-island',
    heading: 'North Island',
    // The three topographic groups + Marine are usable in both apps.
    compatibility: 'Topographic · ATAK + TAK Aware',
    // One representative topographic preview per island (the topo style is the
    // same LINZ Topo50 look everywhere, but a per-island sample reads as more
    // relevant than one shared image). Still one image per SECTION, never per
    // file.
    previewSrc: '/assets/maps/topographic-north-island.png',
    previewAlt: 'Example North Island topographic map: LINZ Topo50 with relief shading',
  },
  {
    key: 'south-island',
    heading: 'South Island',
    compatibility: 'Topographic · ATAK + TAK Aware',
    previewSrc: '/assets/maps/topographic-south-island.png',
    previewAlt: 'Example South Island topographic map: LINZ Topo50 with relief shading',
  },
  {
    key: 'chatham-islands',
    heading: 'Chatham Islands',
    compatibility: 'Topographic · ATAK + TAK Aware',
    previewSrc: '/assets/maps/topographic-chatham-islands.png',
    previewAlt: 'Example Chatham Islands topographic map: LINZ Topo50 with relief shading',
  },
  {
    key: 'marine',
    heading: 'Marine',
    compatibility: 'Charts · ATAK + TAK Aware',
    previewSrc: '/assets/maps/marine-example.png',
    previewAlt: 'Example marine chart: LINZ nautical charts',
  },
  {
    key: 'vector',
    heading: 'Vector Basemaps',
    // Vector is the one ATAK-only group.
    compatibility: 'Basemap · ATAK only',
    previewSrc: '/assets/maps/vector-example.png',
    previewAlt: 'Example vector basemap: styled roads, labels and landcover',
  },
]

/**
 * Merge the server's flat maps list into ordered display groups.
 *
 * The server returns maps in catalog order, each carrying its `group` key. We
 * bucket them by group, preserving the server's order within a group and the
 * fixed group order above. A group with no maps at all (e.g. Vector before its
 * files are uploaded) is dropped, so the section only appears once it has
 * something to show. A map whose object isn't in S3 yet arrives with
 * `available: false` and is rendered as unavailable rather than omitted.
 *
 * @param {Array<{id,group,label,sizeBytes,available}>} maps
 * @returns {Array<{key,heading,compatibility,previewSrc,previewAlt,maps}>}
 */
function buildGroups(maps) {
  return OFFLINE_MAP_GROUP_META
    .map((meta) => ({
      ...meta,
      maps: maps.filter((m) => m.group === meta.key),
    }))
    .filter((group) => group.maps.length > 0)
}

/**
 * formatBytes: compact, human-readable size label. `null` (an object not yet
 * uploaded to S3) has no size to show.
 */
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return null
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  return `${Math.round(bytes / MB)} MB`
}

/**
 * Token: a styled inline literal used in the install notes to set concrete,
 * copy/tap-this values -- a file path, a file extension, or a named UI action
 * ("Files", "Share", "TAK Aware") -- apart from the surrounding prose, so a
 * user can pick them out at a glance. A `<code>` element in a subtle rounded
 * pill; `whitespace-nowrap` keeps a path or two-word action from wrapping
 * mid-token.
 */
function Token({ children }) {
  return (
    <code className="whitespace-nowrap rounded bg-gray-100 dark:bg-gray-700/60 px-1.5 py-0.5 text-xs font-mono text-gray-800 dark:text-gray-200">
      {children}
    </code>
  )
}

/**
 * MapTypePreview: a small representative thumbnail for a map TYPE, shown beside
 * a section heading. One image per type (topographic per island, marine) reused
 * across all sections of that type -- never a per-file thumbnail. Renders
 * nothing when a group has no `previewSrc` at all (every group has one today).
 *
 * When `onEnlarge` is supplied (desktop only -- see OfflineMapsTable), the
 * thumbnail is a button that opens a larger preview in a modal, with a small
 * magnifier affordance on hover so the click target reads as interactive.
 * Without it (mobile), it is a plain, non-interactive image -- enlarging a
 * 256px tile into a modal on a phone adds little and keeps mobile lean.
 *
 * `loading="lazy"` keeps these off the initial paint. A subtle ring frames the
 * (bright) map tile so it doesn't glare against a dark card.
 */
function MapTypePreview({ src, alt, onEnlarge }) {
  if (!src) return null

  const img = (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="h-12 w-12 flex-shrink-0 rounded object-cover ring-1 ring-gray-200 dark:ring-gray-700"
    />
  )

  if (!onEnlarge) return img

  return (
    <button
      type="button"
      onClick={onEnlarge}
      aria-label={`Enlarge preview: ${alt}`}
      className="group relative flex-shrink-0 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
    >
      {img}
      {/* Decorative hover affordance; the accessible name is on the button. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center rounded bg-black/0 text-white/0 transition group-hover:bg-black/40 group-hover:text-white/90 group-focus:bg-black/40 group-focus:text-white/90"
      >
        <MagnifyingGlassPlusIcon className="h-5 w-5" />
      </span>
    </button>
  )
}

/**
 * MapPreviewModal: a desktop-only lightbox showing the enlarged map-type
 * preview. Mirrors the app's modal convention (role="dialog" aria-modal,
 * Escape closes, backdrop click closes, XMark close button). Gated
 * `hidden sm:flex` so it never appears on a phone -- the enlarge affordance is
 * a non-mobile feature (a phone user is already on the device they'd download
 * to, and a 256px tile doesn't warrant a mobile lightbox).
 */
function MapPreviewModal({ src, alt, heading, onClose }) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 hidden sm:flex items-center justify-center bg-black bg-opacity-50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview: ${heading}`}
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{heading} — preview</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="p-2 rounded-lg text-gray-400 hover:text-gray-500 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-700"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="p-4">
          {/* The tiles are 256px square; render at a comfortable size, pixelated
              scaling avoided by letting the browser smooth it. Caption carries
              the descriptive text so the meaning isn't image-only. */}
          <img src={src} alt={alt} className="mx-auto w-full max-w-sm rounded ring-1 ring-gray-200 dark:ring-gray-700" />
          <p className="mt-3 text-center text-sm text-gray-500 dark:text-gray-400">{alt}</p>
        </div>
      </div>
    </div>
  )
}

/**
 * DownloadButton: the per-map action, shared by the mobile card list and the
 * desktop table so the two never diverge. Disabled (with a distinct label)
 * when the object isn't in S3 yet (`available: false`) or while a presign is
 * in flight. On click it delegates to `onDownload(map)`, which fetches a
 * presigned URL and navigates the browser to it.
 */
function DownloadButton({ map, onDownload, pending, className = '' }) {
  if (!map.available) {
    return (
      <button
        type="button"
        disabled
        className={`btn-secondary px-3 py-2 text-sm opacity-50 cursor-not-allowed ${className}`}
      >
        Unavailable
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onDownload(map)}
      disabled={pending}
      className={`btn-secondary px-3 py-2 text-sm ${pending ? 'opacity-50 cursor-wait' : ''} ${className}`}
    >
      {pending ? 'Preparing…' : 'Download'}
    </button>
  )
}

/**
 * OfflineMapsMobileGroup: one island/standalone section as a stacked card
 * list, shown only below `sm:`. Column alignment across sections is not a
 * concern for stacked cards (each row is a flex row, value beside label), so
 * the mobile rendering stays per-group.
 */
function OfflineMapsMobileGroup({ heading, compatibility, previewSrc, previewAlt, maps, onDownload, pendingIds }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <MapTypePreview src={previewSrc} alt={previewAlt} />
        <div className="min-w-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{heading}</h3>
          {/* App compatibility as visible text, not colour (accessibility rule). */}
          <span className="text-xs text-gray-500 dark:text-gray-400">{compatibility}</span>
        </div>
      </div>
      <ul className="divide-y divide-gray-200 dark:divide-gray-700 border-y border-gray-200 dark:border-gray-700">
        {maps.map((map) => (
          <li key={map.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{map.label}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {map.available ? (
                  <>
                    {formatBytes(map.sizeBytes)}
                    {map.lastModified && (
                      <>
                        {' · Updated '}
                        <FormattedDate value={map.lastModified} precision={DATE_PRECISION.DATE} />
                      </>
                    )}
                  </>
                ) : (
                  'Currently unavailable'
                )}
              </p>
            </div>
            <DownloadButton map={map} onDownload={onDownload} pending={pendingIds.has(map.id)} className="flex-shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * OfflineMapsTable: the desktop (`sm:` and up) rendering of ALL groups as a
 * SINGLE `table-fixed` table. Because it is one table with one `<colgroup>`,
 * the Map / Size / Download columns line up across every section -- the
 * previous per-group tables each sized their own columns, so they didn't
 * align. Section headings are rendered as full-width heading rows (a single
 * `colSpan` cell) inside the same table body, keeping the shared column grid.
 */
function OfflineMapsTable({ groups, onDownload, onEnlarge, pendingIds }) {
  return (
    <table className="w-full table-fixed text-sm">
      {/* Fixed column widths make alignment deterministic across sections;
          the Map column takes the remaining space. */}
      <colgroup>
        <col />
        <col className="w-24" />
        <col className="w-32" />
        <col className="w-36" />
      </colgroup>
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
          <th className="pb-2 font-medium">Map</th>
          <th className="pb-2 font-medium">Size</th>
          <th className="pb-2 font-medium">Updated</th>
          <th className="pb-2 font-medium sr-only">Download</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
        {groups.map((group) => (
          <Fragment key={group.key}>
            {/* Section heading row: full width, so every data row below it
                still shares the table's single column layout. */}
            <tr>
              <td colSpan={4} className="pt-6 pb-2">
                <div className="flex items-center gap-3">
                  <MapTypePreview
                    src={group.previewSrc}
                    alt={group.previewAlt}
                    onEnlarge={group.previewSrc ? () => onEnlarge(group) : undefined}
                  />
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{group.heading}</span>
                    <span className="text-xs font-normal normal-case tracking-normal text-gray-500 dark:text-gray-400">
                      {group.compatibility}
                    </span>
                  </div>
                </div>
              </td>
            </tr>
            {group.maps.map((map) => (
              <tr key={map.id}>
                <td className="py-2 pr-4 font-medium text-gray-900 dark:text-gray-100 truncate">{map.label}</td>
                <td className="py-2 pr-4 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  {map.available ? formatBytes(map.sizeBytes) : 'Currently unavailable'}
                </td>
                <td className="py-2 pr-4 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  {/* Live S3 last-modified date; date-only precision (an annual
                      map refresh makes the day the meaningful unit). For a
                      not-yet-uploaded object there is no date and the cell is
                      left empty -- the row's Size cell already carries the
                      "Currently unavailable" state, so a placeholder here would
                      be redundant (and visually collided with it). */}
                  {map.available && map.lastModified && (
                    <FormattedDate value={map.lastModified} precision={DATE_PRECISION.DATE} />
                  )}
                </td>
                <td className="py-2 text-right">
                  <DownloadButton map={map} onDownload={onDownload} pending={pendingIds.has(map.id)} />
                </td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

/**
 * OfflineMapsCard: the whole "Offline Maps" area (Card 2). Mock only.
 *
 * In the real feature this renders only when `GET /api/offline-maps` returns a
 * list (the reachability probe); here it always renders with dummy data so we
 * can see the layout. Contains the intro copy, the app-compatibility legend,
 * the desktop->phone QR affordance, the grouped map lists, and per-app install
 * notes.
 */
function OfflineMapsCard() {
  // The catalog fetched from the server. `null` = not-yet-known / feature off:
  // the card renders nothing until a successful list arrives. A 404 (feature
  // off or not permitted) leaves it null, so the card stays hidden — the same
  // fail-closed treatment the CloudTAK row uses.
  const [groups, setGroups] = useState(null)
  // The map-type preview currently enlarged in the desktop lightbox (or null).
  const [preview, setPreview] = useState(null)
  // Ids with a presign request in flight, so the button shows a pending state.
  const [pendingIds, setPendingIds] = useState(() => new Set())

  useEffect(() => {
    let cancelled = false
    offlineMapsAPI.list()
      .then((response) => {
        if (cancelled) return
        const maps = response.data?.maps ?? []
        setGroups(buildGroups(maps))
      })
      .catch(() => {
        // Fail closed: a 404 (feature off / not permitted) or any error leaves
        // `groups` null, so the whole card stays hidden. No error surfaced —
        // the feature simply isn't offered.
      })
    return () => { cancelled = true }
  }, [])

  const handleDownload = async (map) => {
    if (!map.available) return
    setPendingIds((prev) => new Set(prev).add(map.id))
    try {
      const response = await offlineMapsAPI.getUrl(map.id)
      const url = response.data?.url
      if (url) {
        // Navigate the browser directly to the presigned S3 URL; the
        // Content-Disposition on the object makes it download rather than open.
        window.location.href = url
      } else {
        toast.error('Could not prepare the download. Please try again.')
      }
    } catch {
      // A failed presign must not clear the rendered list — just report it.
      toast.error('Could not prepare the download. Please try again.')
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(map.id)
        return next
      })
    }
  }

  // Feature off / not permitted / not yet loaded: render nothing at all (no
  // empty state, no spinner), exactly like the CloudTAK row when its URL is null.
  if (!groups || groups.length === 0) return null

  return (
    <div className="card space-y-8">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Offline Maps</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Download offline map files (.mbtiles) to your phone and load them into ATAK or
          TAK Aware. These are large files — download over Wi-Fi where you can.
        </p>
        {/* App-compatibility legend, stated in text (never colour alone). */}
        <p className="text-sm text-gray-500 dark:text-gray-400">
          ATAK supports all maps. TAK Aware supports the topographic and marine maps only —
          the vector basemaps are ATAK-only.
        </p>
      </div>

      <QrHandoff />

      {/* Mobile (below sm:): per-group stacked card lists. */}
      <div className="sm:hidden space-y-8">
        {groups.map((group) => (
          <OfflineMapsMobileGroup
            key={group.key}
            heading={group.heading}
            compatibility={group.compatibility}
            previewSrc={group.previewSrc}
            previewAlt={group.previewAlt}
            maps={group.maps}
            onDownload={handleDownload}
            pendingIds={pendingIds}
          />
        ))}
      </div>

      {/* Desktop (sm: and up): ONE table so columns align across sections. */}
      <div className="hidden sm:block">
        <OfflineMapsTable
          groups={groups}
          onDownload={handleDownload}
          onEnlarge={setPreview}
          pendingIds={pendingIds}
        />
      </div>

      {/* Desktop-only enlarged preview lightbox. */}
      {preview && (
        <MapPreviewModal
          src={preview.previewSrc}
          alt={preview.previewAlt}
          heading={preview.heading}
          onClose={() => setPreview(null)}
        />
      )}

      {/* Per-app install notes (short; deeper detail belongs in ATAK-facing docs). */}
      <div className="pt-6 border-t border-gray-200 dark:border-gray-700 space-y-3 text-sm text-gray-500 dark:text-gray-400">
        <p className="font-medium text-gray-900 dark:text-gray-100">Installing on your device</p>
        <p>
          <span className="font-medium text-gray-700 dark:text-gray-300">ATAK (Android):</span>{' '}
          download the <Token>.mbtiles</Token> file to the device, then place it in{' '}
          <Token>atak/imagery/mobile/</Token>.
        </p>
        <p>
          <span className="font-medium text-gray-700 dark:text-gray-300">TAK Aware (iOS):</span>{' '}
          download the file, open the <Token>Files</Token> app, long-press the{' '}
          <Token>.mbtiles</Token> file, tap <Token>Share</Token>, and choose{' '}
          <Token>TAK Aware</Token>.
        </p>
      </div>
    </div>
  )
}

/**
/**
 * QrHandoff: the desktop -> phone handoff (design.md §4.7). A single
 * page-level QR for /downloads, collapsed by default and shown only at `sm:`
 * and up (a phone user scanning with the same phone is pointless).
 *
 * The QR is generated SERVER-SIDE (`GET /api/offline-maps/qr` -> a PNG data
 * URL), the same pattern the enrollment surface uses -- so there is no client
 * QR dependency, and the code encodes the canonical APP_URL origin (e.g.
 * https://team.tak.nz/downloads), not the browser's own host. Fetched lazily
 * the first time the panel opens. The visible URL text beside the image is the
 * real accessible information and also the fallback if generation fails.
 */
function QrHandoff() {
  const [open, setOpen] = useState(false)
  // { url, qrCodeDataUrl } once fetched; null until then.
  const [qr, setQr] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!open || qr) return
    let cancelled = false
    offlineMapsAPI.getQr()
      .then((response) => {
        if (cancelled) return
        if (response.data?.qrCodeDataUrl) {
          setQr(response.data)
        } else {
          setError(true)
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => { cancelled = true }
  }, [open, qr])

  return (
    <div className="hidden sm:block rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm font-medium text-primary-600 dark:text-primary-500"
        aria-expanded={open}
      >
        {open ? 'Hide QR code' : 'On a computer? Show a QR code to open this page on your phone'}
      </button>
      {open && (
        <div className="mt-4 flex items-center gap-4">
          {qr?.qrCodeDataUrl ? (
            // Server-generated QR (PNG data URL). aria-hidden -- the URL text
            // beside it is the real, accessible information.
            <img
              src={qr.qrCodeDataUrl}
              alt=""
              aria-hidden="true"
              className="h-32 w-32 flex-shrink-0 rounded border border-gray-200 dark:border-gray-700"
            />
          ) : (
            // Loading / failed: a neutral box, no broken-image icon. The URL
            // text still lets a user reach the page manually.
            <div
              className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded border border-dashed border-gray-300 dark:border-gray-600 text-xs text-gray-400 dark:text-gray-500 text-center"
              aria-hidden="true"
            >
              {error ? 'QR unavailable' : 'Loading…'}
            </div>
          )}
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              Scan to open this page on your phone, then download the files there.
            </p>
            {qr?.url && (
              <p className="truncate text-sm text-primary-600 dark:text-primary-500">{qr.url}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Downloads</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Get the TAK client apps and offline map files for your devices.
        </p>
      </div>

      <div className="card space-y-6">
        {/* Section heading, matching the Offline Maps card's heading style, so
            the two sections read as peers ("get the app" then "get the maps"). */}
        <div className="space-y-2">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">TAK Clients</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Install one of the TAK clients below, then enroll it from the Enrollment page.
          </p>
        </div>

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

      {/* Card 2: Offline Maps (offline-maps-download-design.md §4). LAYOUT
          MOCK with dummy data -- always rendered here so we can see the
          layout; in the real feature it renders only when the offline-maps
          reachability probe returns a list. */}
      <OfflineMapsCard />
    </div>
  )
}
