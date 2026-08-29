import { siAndroid, siApple } from 'simple-icons'
import { faWindows } from '@fortawesome/free-brands-svg-icons'

/**
 * Platform_Logos (downloads-page-os-sections Requirement 6.1/6.2): shared
 * Android/Apple/Windows platform glyphs consumed by the Downloads page's
 * Android_Section/iOS_Section/Windows_Section headers, by
 * `DeviceTypeIcon.jsx`'s `android`/`ios`/`windows` glyphs, and by
 * `EnrollmentView.jsx`'s per-tab OS glyphs, so none of these surfaces can
 * drift apart from one another.
 *
 * This is a new file rather than an addition to `StoreBadges.jsx` --
 * `StoreBadges.jsx`'s existing exports are clickable download badges with a
 * baked-in `role="img"`/`aria-label` for a Downloads-page-specific purpose,
 * while these are decorative glyphs (`aria-hidden` by default) consumed by
 * several otherwise-unrelated call sites. Folding them into `StoreBadges.jsx`
 * would make a Downloads-page badge file a dependency of the shared
 * device-glyph component -- the wrong direction of coupling.
 *
 * Android/Apple come from `simple-icons`. Windows comes from a SEPARATE
 * package, `@fortawesome/free-brands-svg-icons` (pinned to an exact version
 * per this project's dependency convention) -- `simple-icons` does not ship
 * a Windows/Microsoft logo at all (Microsoft required its removal in
 * simple-icons v13.0.0, per that project's own issue tracker), while Font
 * Awesome's free-brands set still carries the classic four-pane Windows
 * flag mark, which is NOT the current Microsoft-trademarked logo that
 * required simple-icons' removal -- that distinction is almost certainly
 * why one project's stricter policy pulled its icon while the other's
 * didn't. Only the icon's raw path data (`faWindows.icon[4]`) is imported
 * here, not any FontAwesome React/CSS runtime, matching this file's existing
 * "wrap one icon object as a component" pattern for the simple-icons glyphs
 * below rather than adding a second icon-rendering mechanism to the app.
 */

/**
 * Wraps a simple-icons icon object (`{ path, title }`) as a React component
 * with the SAME external contract `DeviceTypeIcon.jsx`'s now-removed
 * hand-drawn glyphs had: `viewBox="0 0 24 24"`, `className` passthrough,
 * `aria-hidden` defaulting to `"true"` (decorative -- callers needing an
 * accessible name put it on a wrapping element, matching how
 * `DeviceTypeIcon.jsx`'s `role="img"` span already supplies the accessible
 * name today).
 *
 * `fill="currentColor"` rather than the icon's own brand hex: Requirement
 * 6.1/6.2's >=3:1 contrast floor fails for both brand colors as shipped by
 * simple-icons (Android's `#3DDC84` and Apple's `#000000` both measured
 * failing against this app's backgrounds). `currentColor` lets each call
 * site pick the existing `text-gray-500 dark:text-gray-400` pair already
 * measured passing elsewhere in this app.
 *
 * @param {{ path: string, title: string }} icon a simple-icons icon object.
 * @returns {(props: { className?: string, 'aria-hidden'?: string }) => JSX.Element}
 */
function simpleIcon(icon) {
  function PlatformLogo({ className, 'aria-hidden': ariaHidden = 'true' }) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        className={className}
        aria-hidden={ariaHidden}
      >
        <path d={icon.path} />
      </svg>
    )
  }
  return PlatformLogo
}

export const AndroidPlatformLogo = simpleIcon(siAndroid)
export const ApplePlatformLogo = simpleIcon(siApple)

/**
 * Same external contract as `simpleIcon` above (`className`/`aria-hidden`
 * passthrough, `currentColor` fill for the same >=3:1 contrast reason), but
 * for a FontAwesome icon OBJECT (`{ icon: [width, height, ligatures,
 * unicode, svgPathData] }`) rather than a simple-icons one -- the two
 * libraries' export shapes differ, and FontAwesome's Windows glyph has a
 * non-square `viewBox` (448 x 512) unlike simple-icons' uniform 24 x 24, so
 * this cannot reuse `simpleIcon`'s hardcoded viewBox.
 *
 * `svgPathData` can be a single path string or an array of two (FontAwesome
 * duotone icons carry two paths); Windows is the single-string case, but
 * both are handled here rather than assuming one, since a future FontAwesome
 * icon added through this same wrapper might not be.
 */
function fontAwesomeIcon(iconDefinition) {
  const [width, height, , , svgPathData] = iconDefinition.icon
  const paths = Array.isArray(svgPathData) ? svgPathData : [svgPathData]

  function PlatformLogo({ className, 'aria-hidden': ariaHidden = 'true' }) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${width} ${height}`}
        fill="currentColor"
        className={className}
        aria-hidden={ariaHidden}
      >
        {paths.map((d, index) => <path key={index} d={d} />)}
      </svg>
    )
  }
  return PlatformLogo
}

export const WindowsPlatformLogo = fontAwesomeIcon(faWindows)

/**
 * CloudTAK's mark is not a single-color brand glyph like the three above --
 * it is inherently two-tone (solid black plus a white outline/cutout), the
 * same construction as `client/public/assets/cloudtak-logo.svg` (the
 * Downloads page's own CloudTAK glyph, rendered there via `<img>` since it
 * is a static asset with fixed colors that must not shift with the current
 * text color or theme -- see that file's own comment for why: the region
 * behind the arrow notch is opaque white by design, not a transparent hole,
 * so `currentColor` would erase the two-tone effect this mark depends on).
 *
 * This wrapper duplicates that SAME path data as an inline component
 * instead of an `<img>`, so it can sit in `DeviceTypeIcon.jsx`'s `GLYPHS`
 * map next to `AndroidPlatformLogo`/`ApplePlatformLogo`/`WindowsPlatformLogo`
 * and satisfy that map's "one glyph component per Client_Type" contract
 * (`className`/`aria-hidden` passthrough, rendered inline rather than
 * fetched). There is no shared source between the public SVG asset and this
 * JS module, so the two must be kept in sync by hand if the mark ever
 * changes.
 *
 * Unlike `simpleIcon`/`fontAwesomeIcon` above, this does NOT accept
 * `fill="currentColor"` on the root -- each path below carries its own
 * fixed, explicit fill/stroke, by design.
 */
export function CloudTakPlatformLogo({ className, 'aria-hidden': ariaHidden = 'true' }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 79.3 51.62"
      className={className}
      aria-hidden={ariaHidden}
    >
      <g transform="translate(2.5,2.5)">
        <path
          d="M72.05,23.55c-1.26-1.88-3.01-3.45-5.21-4.65-1.85-1.01-3.69-1.59-5.06-1.91-.42-1.74-1.23-4.28-2.77-6.85C56.44,5.88,51.37.67,41.7.06c-.59-.04-1.18-.06-1.75-.06-7.82,0-12.04,3.52-14.19,6.47-.91,1.24-1.53,2.48-1.95,3.55-.86-.13-1.86-.22-2.93-.22-3.56,0-6.52,1.08-8.54,3.13-1.91,1.92-3.2,4.26-3.73,6.75-.09.41-.15.8-.19,1.16-.95.47-2.12,1.16-3.29,2.11C1.56,25.83-.2,29.67.02,34.06c.22,4.41,2.27,7.96,5.94,10.29,2.6,1.65,5.1,2.19,5.38,2.23l.22.03h.22s48.86,0,48.86,0h.1s.1,0,.1,0c.34-.02,3.39-.26,6.54-2.13,3.04-1.8,6.7-5.45,6.92-12.56.1-3.18-.66-5.99-2.24-8.36Z"
          fill="#ffffff"
        />
        <path
          d="M72.05,23.55c-1.26-1.88-3.01-3.45-5.21-4.65-1.85-1.01-3.69-1.59-5.06-1.91-.42-1.74-1.23-4.28-2.77-6.85C56.44,5.88,51.37.67,41.7.06c-.59-.04-1.18-.06-1.75-.06-7.82,0-12.04,3.52-14.19,6.47-.91,1.24-1.53,2.48-1.95,3.55-.86-.13-1.86-.22-2.93-.22-3.56,0-6.52,1.08-8.54,3.13-1.91,1.92-3.2,4.26-3.73,6.75-.09.41-.15.8-.19,1.16-.95.47-2.12,1.16-3.29,2.11C1.56,25.83-.2,29.67.02,34.06c.22,4.41,2.27,7.96,5.94,10.29,2.6,1.65,5.1,2.19,5.38,2.23l.22.03h.22s48.86,0,48.86,0h.1s.1,0,.1,0c.34-.02,3.39-.26,6.54-2.13,3.04-1.8,6.7-5.45,6.92-12.56.1-3.18-.66-5.99-2.24-8.36ZM14.43,15c1.75-1.77,4.24-2.26,6.45-2.26,2.71,0,4.99.73,4.99.73,0,0,1.33-10.53,14.07-10.53.5,0,1.03.02,1.57.05,16.24,1.03,17.74,16.54,17.74,16.54,0,0,4.67.42,8.21,3.31-3.47,3.22-4.95,5.19-12.77,5.75-8.65.61-7.47,3.95-7.47,3.95l-4.05-8.98h5.79c.14-2.85-.87-5.65-5.31-5.65h-8.49l-6.56,14.62s1.96-3.31-6.69-3.95c-7.69-.55-7.58-2.69-10.61-5.88-.06-.58-.26-4.3,3.13-7.72Z"
          fill="#000000"
          fillRule="evenodd"
          stroke="#ffffff"
          strokeWidth="2.5"
          strokeLinejoin="round"
          paintOrder="stroke fill"
        />
      </g>
    </svg>
  )
}
