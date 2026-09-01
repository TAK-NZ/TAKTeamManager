/**
 * TAK_Color name -> swatch hex, and the single definition of it.
 *
 * `Dashboard.jsx`, `TeamDetail.jsx` and `EnrollmentView.jsx` each carried
 * their own hand-copied `colorMap` for this exact purpose (rendering the
 * small colour swatch beside a user's/team's TAK Color name); the three
 * had already drifted apart from a maintenance standpoint (three places
 * to edit for one visual fact) even though their VALUES still agreed.
 * This is now the one place that fact lives.
 *
 * The 14 keys are exactly the canonical TAK_Color set the server treats
 * as configurable -- the `colorMappings` object `server/routes/config.js`'s
 * `GET /color-mappings` builds from the `TAK_COLOR_*` environment
 * variables -- so a key here is never invented independently of what an
 * Organisation can actually be assigned. The hex values are the ATAK
 * app's own RGB palette for each named colour, not an approximation
 * chosen for looks.
 *
 * `Pink`, `Gray`, and `Black`, present in the three previous hand-copied
 * maps, are dropped here: none of the three is a real, assignable TAK
 * Color (none appears in that `colorMappings` object or any `TAK_COLOR_*`
 * variable), so keeping them here would let an unreal colour render a
 * swatch. An unrecognised name -- including those three, and the literal
 * string `'None'` a teamless user's cached colour carries -- still falls
 * through to `DEFAULT_COLOR_HEX`, a neutral grey, via `getTakColorHex`
 * below; callers that must NOT render a swatch at all for `'None'`
 * (Dashboard.jsx's TAK Profile card) check for that sentinel themselves
 * before calling this function, exactly as they did before this
 * extraction.
 */
export const TAK_COLOR_HEX_TABLE = Object.freeze({
  White: '#FFFFFF',
  Yellow: '#FFFF00',
  Orange: '#FF7700',
  Magenta: '#FF00FF',
  Red: '#FF0000',
  Maroon: '#7F0000',
  Purple: '#7F007F',
  'Dark Blue': '#00007F',
  Blue: '#0000FF',
  Cyan: '#00FFFF',
  Teal: '#007F7F',
  Green: '#00FF00',
  'Dark Green': '#007F00',
  Brown: '#A0714F'
})

/** The swatch colour for any name outside `TAK_COLOR_HEX_TABLE` (unknown, unset, or the `'None'` sentinel). */
export const DEFAULT_COLOR_HEX = '#6b7280'

/**
 * The swatch hex for a TAK_Color name.
 *
 * Total: any input outside the 14 canonical names -- including `null`,
 * `undefined`, `'None'`, or a typo -- resolves to `DEFAULT_COLOR_HEX`
 * rather than throwing or returning `undefined`, so a swatch always has
 * SOME colour to render if a caller chooses to render one at all.
 *
 * @param {string|null|undefined} colorName
 * @returns {string} a `#`-prefixed hex colour.
 */
export function getTakColorHex(colorName) {
  return TAK_COLOR_HEX_TABLE[colorName] || DEFAULT_COLOR_HEX
}
