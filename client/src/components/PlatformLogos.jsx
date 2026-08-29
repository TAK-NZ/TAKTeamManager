import { siAndroid, siApple } from 'simple-icons'

/**
 * Platform_Logos (downloads-page-os-sections Requirement 6.1/6.2): shared
 * Android/Apple platform glyphs consumed by the Downloads page's
 * Android_Section/iOS_Section headers and by `DeviceTypeIcon.jsx`'s
 * `android`/`ios` glyphs, so the two surfaces never drift apart.
 *
 * This is a new file rather than an addition to `StoreBadges.jsx` --
 * `StoreBadges.jsx`'s existing exports are clickable download badges with a
 * baked-in `role="img"`/`aria-label` for a Downloads-page-specific purpose,
 * while these are decorative glyphs (`aria-hidden` by default) consumed by
 * two otherwise-unrelated call sites. Folding them into `StoreBadges.jsx`
 * would make a Downloads-page badge file a dependency of the shared
 * device-glyph component -- the wrong direction of coupling.
 *
 * Windows gets NO entry here: `simple-icons` does not ship a Windows or
 * Microsoft logo (Microsoft required its removal in simple-icons v13.0.0),
 * so `ComputerDesktopIcon` is imported directly from
 * `@heroicons/react/24/outline` at each of its two call sites
 * (`Downloads.jsx`, `DeviceTypeIcon.jsx`) instead, since it needs no
 * simple-icons wrapping.
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
