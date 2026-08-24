/**
 * WCAG 2.1 contrast arithmetic and the Color_Token_Table (Requirement 7:
 * Contrast Ratios Are Computed and Asserted, Not Eyeballed)
 *
 * This module exists so the contrast figures in the spec are COMPUTED from
 * the colours the pages actually declare rather than restated as numbers
 * somebody believed once (Criterion 7.1). It holds three pure functions --
 * `hexToRgb`, `relativeLuminance`, `contrastRatio` -- and the one mapping
 * from a Tailwind colour token to its sRGB hex value, `COLOR_TOKEN_TABLE`.
 *
 * It lives in `src/utils` on purpose, beside `expiryWarning.js` and
 * `dateFormat.js`, rather than being inlined in the test that consumes it:
 * a luminance formula transcribed inside a test file is a formula nothing
 * tests, and Property 2 needs something to point at. No component imports
 * it, so Vite tree-shakes it out of the bundle.
 */

// The extension on this specifier is LOAD-BEARING. `tailwindcss` 3.4
// publishes no `exports` map, so Node's ESM resolver cannot complete the
// extensionless `'tailwindcss/resolveConfig'` form and fails the import with
// ERR_MODULE_NOT_FOUND -- at RESOLUTION time, so the whole test file dies
// rather than one assertion. It reads exactly like a stray extension
// somebody forgot to clean up. It is not. Leave it.
import resolveConfig from 'tailwindcss/resolveConfig.js'

import tailwindConfig from '../../tailwind.config.js'

/**
 * Matches a 3- or 6-digit sRGB hex colour, and nothing else.
 *
 * 3-digit is accepted because the resolved palette really does contain it:
 * Tailwind's `black` and `white` are `#000` and `#fff`. Everything that is
 * NOT this shape -- `transparent`, `inherit`, `currentColor`, an `rgb(...)`
 * or `hsl(...)` string, a CSS variable -- is rejected rather than salvaged.
 */
const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * Converts a hex colour to its three 8-bit sRGB channels.
 *
 * THROWS for anything that is not a hex colour, and that is the point. The
 * resolved Tailwind palette holds flat non-hex values (`transparent`,
 * `inherit`, `currentColor`) alongside the colour families, and a
 * `transparent` finding its way into `relativeLuminance` would yield a
 * NUMBER rather than an error -- a silently wrong contrast ratio, which is
 * the worst outcome available here. A throw is loud; a wrong ratio that
 * clears its threshold is invisible.
 *
 * @param {string} hex A 3- or 6-digit hex colour, e.g. `'#1f2937'`, `'#fff'`.
 * @returns {[number, number, number]} The `[r, g, b]` channels, 0-255.
 * @throws {TypeError} When `hex` is not a 3- or 6-digit hex colour.
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string' || !HEX_PATTERN.test(hex)) {
    throw new TypeError(`hexToRgb: not a hex colour: ${String(hex)}`)
  }

  const digits = hex.slice(1)
  const expanded =
    digits.length === 3
      ? digits.replace(/./g, (digit) => digit + digit)
      : digits

  return [
    parseInt(expanded.slice(0, 2), 16),
    parseInt(expanded.slice(2, 4), 16),
    parseInt(expanded.slice(4, 6), 16),
  ]
}

/**
 * Linearises one 8-bit sRGB channel, per the WCAG 2.1 relative-luminance
 * definition.
 *
 * The 0.03928 threshold is the one WCAG 2.1 prints. The sRGB specification
 * itself says 0.04045, and the two agree on every 8-bit channel there is:
 * channel 10 is 0.039216, below both, and channel 11 is 0.043137, above
 * both. Neither value can therefore change a single ratio computed here.
 *
 * @param {number} channel One channel, 0-255.
 * @returns {number} The linearised value, 0-1.
 */
function linearise(channel) {
  const scaled = channel / 255
  return scaled <= 0.03928
    ? scaled / 12.92
    : Math.pow((scaled + 0.055) / 1.055, 2.4)
}

/**
 * The WCAG 2.1 relative luminance of a hex colour.
 *
 * @param {string} hex A 3- or 6-digit hex colour.
 * @returns {number} Relative luminance, 0 for black through 1 for white.
 * @throws {TypeError} When `hex` is not a hex colour (see `hexToRgb`).
 */
export function relativeLuminance(hex) {
  const [red, green, blue] = hexToRgb(hex)
  return (
    0.2126 * linearise(red) +
    0.7152 * linearise(green) +
    0.0722 * linearise(blue)
  )
}

/**
 * The Contrast_Ratio between two hex colours:
 * `(L_lighter + 0.05) / (L_darker + 0.05)`.
 *
 * Symmetric by construction -- the lighter of the two goes on top, whichever
 * argument it arrived in -- and therefore bounded by 1 (identical colours)
 * and 21 (black against white). Property 2 asserts exactly that.
 *
 * @param {string} hexA One colour.
 * @param {string} hexB The other colour.
 * @returns {number} The ratio, 1 through 21.
 * @throws {TypeError} When either argument is not a hex colour.
 */
export function contrastRatio(hexA, hexB) {
  const luminanceA = relativeLuminance(hexA)
  const luminanceB = relativeLuminance(hexB)
  const lighter = Math.max(luminanceA, luminanceB)
  const darker = Math.min(luminanceA, luminanceB)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Builds the Color_Token_Table from the project's own Tailwind config.
 *
 * `resolveConfig` is the indirection Criterion 7.3 REQUIRES, and the reason
 * it is required rather than merely tidy is a coincidence:
 *
 *   - `client/tailwind.config.js` declares only `primary` and `gray` under
 *     `theme.extend.colors`, so reading `theme.extend.colors` directly
 *     cannot resolve `blue-400` or `blue-600` AT ALL -- those come from
 *     stock Tailwind, and the channel tree uses them.
 *   - the declared `gray` scale is currently byte-identical to stock
 *     Tailwind 3.4.19's, so a hand-written stock table would pass today and
 *     quietly stop measuring the real colours the first time somebody edits
 *     the config. That is the failure Criterion 7.3 forbids.
 *
 * `resolveConfig` merges the two, so both `gray-800` (declared here) and
 * `blue-400` (stock) resolve, and a palette edit in the config flows into
 * every assertion downstream.
 *
 * Only the OBJECT-valued families are flattened, to `family-shade` keys.
 * `theme.colors` also holds flat values -- `transparent`, `inherit`,
 * `currentColor`, and the 3-digit `black`/`white` -- which carry no shade
 * and so have no `family-shade` key to occupy; the `bg|text|border`-with-a-
 * numeric-shade grammar `resolveColorToken` matches cannot name them
 * either. Non-hex shade values inside a family are skipped for the reason
 * `hexToRgb` throws: a table entry that is not a colour is a ratio that is
 * not a measurement.
 *
 * Built ONCE, at import time.
 *
 * @returns {Readonly<Record<string, string>>} `{ 'gray-800': '#1f2937', ... }`
 */
function buildColorTokenTable() {
  const palette = resolveConfig(tailwindConfig).theme.colors
  const table = {}

  for (const [family, value] of Object.entries(palette)) {
    if (value === null || typeof value !== 'object') {
      continue
    }
    for (const [shade, hex] of Object.entries(value)) {
      if (typeof hex === 'string' && HEX_PATTERN.test(hex)) {
        table[`${family}-${shade}`] = hex
      }
    }
  }

  return Object.freeze(table)
}

/**
 * The Color_Token_Table: every `family-shade` colour token this project's
 * resolved Tailwind palette defines, mapped to its sRGB hex value.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const COLOR_TOKEN_TABLE = buildColorTokenTable()

/**
 * What a colour utility looks like: one of the three prefixes the markup
 * uses to name a colour -- `bg` for a row background, `text` for an icon or
 * a label, `border` for a border colour -- then a family, then a shade.
 * Side-specific forms (`border-r-gray-900`) carry an extra segment and are
 * outside the shape; no Channel_Tree_Row uses one.
 *
 * The shade is `\d{2,}` rather than the `\d{2,3}` of every real Tailwind
 * shade, ON PURPOSE. Every token the table can define has two or three
 * digits, so widening the pattern resolves nothing new; what it does is
 * bring a MISTAKEN shade like `bg-gray-1000` inside the shape, where it
 * throws as an unresolvable colour token instead of falling out as "not a
 * colour utility" and being skipped in silence. Skipping is the one outcome
 * Criterion 7.3's last sentence rules out.
 *
 * The lower bound of two digits is what keeps single-digit sizing
 * utilities (`border-t-2`, `border-x-4`) out of the shape entirely.
 *
 * KNOWN EDGE: v2-style opacity utilities (`bg-opacity-50`, which this
 * codebase does still use on modal overlays) are colour-SHAPED by this
 * pattern and name no colour token, so they throw. That is the intended
 * treatment of an unresolvable colour-shaped class, and it is harmless
 * here because no Channel_Tree_Row carries one -- but a caller feeding this
 * resolver an arbitrary class list from elsewhere should know it.
 */
const COLOR_UTILITY_PATTERN = /^(?:bg|text|border)-([a-z]+)-(\d{2,})$/

/**
 * Resolves a single Tailwind class name to the hex colour it names.
 *
 * Variant prefixes are stripped first, so `dark:`, `hover:` and
 * `dark:hover:` all reduce to the bare utility -- the caller reads a class
 * list off a rendered element and wants the colour, not the variant.
 *
 * Two outcomes for a class that names no colour, and the difference between
 * them is Criterion 7.3's last sentence:
 *
 *   - a class that is not a colour utility at all (`rounded-lg`, `p-3`,
 *     `h-5`, `transition-transform`) resolves to `null`, and the caller
 *     skips it. A class list is mostly not colours.
 *   - a class that LOOKS like a colour utility and has no table entry
 *     (`bg-gray-1000`, `text-blurple-400`) THROWS. A token renamed to one
 *     the table does not know about must be reported, not silently left
 *     unmeasured -- an unmeasured pair is a pair that passes. See
 *     `COLOR_UTILITY_PATTERN` for what "looks like" means exactly.
 *
 * @param {string} className One class name, e.g. `'dark:hover:bg-gray-700'`.
 * @returns {string|null} The hex colour, or `null` when `className` names no
 *   colour.
 * @throws {Error} When `className` is shaped like a colour utility but
 *   resolves to no Color_Token_Table entry.
 */
export function resolveColorToken(className) {
  if (typeof className !== 'string') {
    return null
  }

  // Strip leading `dark:` / `hover:` in any order and any combination.
  let utility = className.trim()
  let stripped = true
  while (stripped) {
    stripped = false
    for (const variant of ['dark:', 'hover:']) {
      if (utility.startsWith(variant)) {
        utility = utility.slice(variant.length)
        stripped = true
      }
    }
  }

  const match = COLOR_UTILITY_PATTERN.exec(utility)
  if (match === null) {
    return null
  }

  const token = `${match[1]}-${match[2]}`
  const hex = COLOR_TOKEN_TABLE[token]
  if (hex === undefined) {
    throw new Error(
      `resolveColorToken: '${className}' names colour token '${token}', ` +
        'which the Color_Token_Table does not define. Either the token is ' +
        'wrong, or the Tailwind palette no longer declares it.'
    )
  }

  return hex
}
