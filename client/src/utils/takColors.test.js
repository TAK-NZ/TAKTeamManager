import { describe, it, expect } from 'vitest'
import { getTakColorHex, TAK_COLOR_HEX_TABLE, DEFAULT_COLOR_HEX } from './takColors.js'

// Bugfix (colour-code duplication): getTakColorHex is the ONE definition
// of TAK_Color name -> swatch hex, replacing three hand-copied `colorMap`
// objects previously duplicated verbatim across Dashboard.jsx,
// TeamDetail.jsx and EnrollmentView.jsx.
describe('getTakColorHex', () => {
  it('resolves every one of the 14 canonical TAK_Color names to their ATAK RGB hex value', () => {
    // Pinned to the ATAK app's own RGB palette (the values the user
    // supplied), not an approximation. Table-driven so any transcription
    // slip on either side of the pair fails loudly.
    const expected = {
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
    }

    for (const [name, hex] of Object.entries(expected)) {
      expect(getTakColorHex(name)).toBe(hex)
    }

    // Anti-vacuity / exhaustiveness: the table above names EVERY key the
    // module exports, in both directions -- nothing extra, nothing missing.
    expect(Object.keys(TAK_COLOR_HEX_TABLE).sort()).toEqual(Object.keys(expected).sort())
  })

  it('falls back to the neutral default for the "None" sentinel', () => {
    expect(getTakColorHex('None')).toBe(DEFAULT_COLOR_HEX)
  })

  it('falls back to the neutral default for an unrecognised name', () => {
    expect(getTakColorHex('Not A Real Color')).toBe(DEFAULT_COLOR_HEX)
  })

  it('falls back to the neutral default for null/undefined/empty input', () => {
    expect(getTakColorHex(null)).toBe(DEFAULT_COLOR_HEX)
    expect(getTakColorHex(undefined)).toBe(DEFAULT_COLOR_HEX)
    expect(getTakColorHex('')).toBe(DEFAULT_COLOR_HEX)
  })

  it('drops the three non-canonical entries the old hand-copied maps carried (Pink, Gray, Black)', () => {
    // None of these three is a real, assignable TAK_Color (none appears
    // in server/routes/settings.js's COLOR_KEY_LABELS or any TAK_COLOR_*
    // environment variable), so they must not resolve to a colour of
    // their own -- each falls through to the same default as any other
    // unrecognised name.
    expect(getTakColorHex('Pink')).toBe(DEFAULT_COLOR_HEX)
    expect(getTakColorHex('Gray')).toBe(DEFAULT_COLOR_HEX)
    expect(getTakColorHex('Black')).toBe(DEFAULT_COLOR_HEX)
  })

  it('is case-sensitive, matching exactly the canonical capitalisation', () => {
    expect(getTakColorHex('red')).toBe(DEFAULT_COLOR_HEX)
    expect(getTakColorHex('RED')).toBe(DEFAULT_COLOR_HEX)
    expect(getTakColorHex('dark blue')).toBe(DEFAULT_COLOR_HEX)
  })
})
