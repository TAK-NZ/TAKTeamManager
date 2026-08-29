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
