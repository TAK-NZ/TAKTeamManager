import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { contrastRatio } from './contrast.js'

// Feature: date-tooltips-and-folder-contrast, Property 2: The Contrast_Ratio computation is symmetric, bounded, and monotone
//
// **Validates: Requirements 7.1, 7.4**
//
// For all pairs of sRGB colours, `contrastRatio(a, b)` equals
// `contrastRatio(b, a)`, is at least 1, is at most 21, and is exactly 1 when
// the two colours are identical. For all triples where one colour's relative
// luminance lies between the other two, the ratio against the NEARER
// luminance never exceeds the ratio against the FURTHER one. And the ratio of
// black to white is 21.
//
// This is the property Criterion 7.4's threshold comparisons rest on: an
// inequality is only as trustworthy as the number it compares, so the number
// gets checked here and the pairs get checked by example elsewhere.
//
// TWO DELIBERATE GENERATOR DECISIONS, both load-bearing:
//
// 1. INDEPENDENT RE-DERIVATION. The expected ratio is computed from the
//    generated sRGB triple by the formula written out in THIS file, from the
//    WCAG 2.1 definition, and never by calling back into `contrastRatio` or
//    `relativeLuminance`. A test that computes its expectation with the
//    function under test asserts only that the function is deterministic.
//    The local linearisation deliberately uses the sRGB specification's
//    0.04045 threshold where the module uses the 0.03928 that WCAG 2.1
//    prints -- two genuinely different transcriptions which agree on every
//    8-bit channel there is (channel 10 is 0.0392, below both; channel 11 is
//    0.0431, above both), so the independence costs nothing in agreement.
//
// 2. CHANNEL VALUES CONCENTRATED AT THE BOUNDARIES -- 0 and 255, where the
//    bounds are attained, and 10/11, the pair that straddles the
//    linearisation branch. A uniform generator over 0..255 hits the branch
//    boundary about once in a hundred draws per channel and hits pure black
//    or pure white essentially never, so it would report a clean pass on an
//    implementation that took the wrong branch at the threshold or that
//    clamped the ratio slightly inside 21. The uniform arm is what stops the
//    property from being four examples in a loop.

/**
 * Linearises one 8-bit sRGB channel, transcribed from the sRGB specification
 * rather than from the module under test. See decision 1 in the header for
 * why the 0.04045 threshold here and the module's 0.03928 cannot disagree.
 *
 * @param {number} channel One channel, 0-255.
 * @returns {number} The linearised value, 0-1.
 */
function expectedLinearise(channel) {
  const scaled = channel / 255
  return scaled <= 0.04045
    ? scaled / 12.92
    : Math.pow((scaled + 0.055) / 1.055, 2.4)
}

/**
 * The WCAG 2.1 relative luminance of an sRGB triple.
 *
 * @param {{r: number, g: number, b: number}} colour An sRGB triple, 0-255.
 * @returns {number} Relative luminance, 0 for black through 1 for white.
 */
function expectedLuminance({ r, g, b }) {
  return (
    0.2126 * expectedLinearise(r) +
    0.7152 * expectedLinearise(g) +
    0.0722 * expectedLinearise(b)
  )
}

/**
 * The WCAG 2.1 contrast ratio between two sRGB triples.
 *
 * @param {{r: number, g: number, b: number}} colourA One colour.
 * @param {{r: number, g: number, b: number}} colourB The other colour.
 * @returns {number} The ratio, 1 through 21.
 */
function expectedRatio(colourA, colourB) {
  const luminanceA = expectedLuminance(colourA)
  const luminanceB = expectedLuminance(colourB)
  const lighter = Math.max(luminanceA, luminanceB)
  const darker = Math.min(luminanceA, luminanceB)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Renders an sRGB triple as the 6-digit hex colour the module accepts. The
 * generators produce RAW TRIPLES and this is the only place they become
 * strings, so nothing in the test depends on the module's own `hexToRgb`.
 *
 * @param {{r: number, g: number, b: number}} colour An sRGB triple, 0-255.
 * @returns {string} e.g. `'#1f2937'`.
 */
function toHex({ r, g, b }) {
  const pad = (channel) => channel.toString(16).padStart(2, '0')
  return `#${pad(r)}${pad(g)}${pad(b)}`
}

/** One channel, concentrated at the boundaries (decision 2 in the header). */
const channelArb = fc.oneof(
  fc.constantFrom(
    0, // pure black channel -- the lower bound is attained here
    10, // last channel BELOW the linearisation threshold
    11, // first channel ABOVE it
    255 // pure white channel -- the upper bound is attained here
  ),
  fc.integer({ min: 0, max: 255 })
)

/** An arbitrary sRGB colour as a raw triple. */
const colourArb = fc.record({
  r: channelArb,
  g: channelArb,
  b: channelArb
})

const BLACK = '#000000'
const WHITE = '#ffffff'

describe('Property 2: the Contrast_Ratio computation is symmetric, bounded, and monotone', () => {
  it('is symmetric, bounded by 1 and 21, and agrees with the WCAG formula written out here', () => {
    fc.assert(
      fc.property(colourArb, colourArb, (colourA, colourB) => {
        const hexA = toHex(colourA)
        const hexB = toHex(colourB)

        const ratio = contrastRatio(hexA, hexB)

        // Symmetric EXACTLY, not approximately: the definition puts the
        // lighter luminance on top whichever argument it arrived in, so the
        // two calls perform the identical arithmetic.
        expect(contrastRatio(hexB, hexA)).toBe(ratio)

        // Bounded. Both bounds are exact rather than approximate: white
        // linearises to exactly 1 and black to exactly 0, so black against
        // white is exactly (1 + 0.05) / (0 + 0.05) = 21, and identical
        // colours divide a float by itself for exactly 1.
        expect(ratio).toBeGreaterThanOrEqual(1)
        expect(ratio).toBeLessThanOrEqual(21)

        // Agreement with the independently transcribed formula.
        expect(ratio).toBeCloseTo(expectedRatio(colourA, colourB), 12)
      }),
      { numRuns: 300 }
    )
  })

  it('is exactly 1 for identical colours', () => {
    fc.assert(
      fc.property(colourArb, (colour) => {
        const hex = toHex(colour)
        expect(contrastRatio(hex, hex)).toBe(1)
      }),
      { numRuns: 300 }
    )
  })

  it('is monotone: the ratio against a nearer luminance never exceeds the ratio against a further one', () => {
    fc.assert(
      fc.property(colourArb, colourArb, colourArb, (first, second, third) => {
        // Order the triple by luminance so one colour's luminance provably
        // lies between the other two -- the premise of the property. Sorting
        // uses the LOCAL luminance, so the ordering is not taken from the
        // module either.
        const [low, middle, high] = [first, second, third].sort(
          (left, right) => expectedLuminance(left) - expectedLuminance(right)
        )

        const lowHex = toHex(low)
        const middleHex = toHex(middle)
        const highHex = toHex(high)

        // From the darkest colour, `middle` is the nearer of the two.
        expect(contrastRatio(lowHex, middleHex)).toBeLessThanOrEqual(
          contrastRatio(lowHex, highHex)
        )

        // From the lightest, `middle` is the nearer of the two.
        expect(contrastRatio(highHex, middleHex)).toBeLessThanOrEqual(
          contrastRatio(highHex, lowHex)
        )
      }),
      { numRuns: 300 }
    )
  })

  it('rates black against white at 21', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 9)
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 9)
  })
})
