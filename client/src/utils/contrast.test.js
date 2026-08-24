import { describe, it, expect } from 'vitest'

import {
  COLOR_TOKEN_TABLE,
  resolveColorToken,
} from './contrast.js'
import tailwindConfig from '../../tailwind.config.js'

// Validates: Requirements 7.3
//
// Table-driven example tests for `resolveColorToken` and for the PROVENANCE
// of the Color_Token_Table it reads (date-tooltips-and-folder-contrast task
// 1.3).
//
// WHY THERE IS NO PROPERTY TEST FOR `resolveColorToken`, DELIBERATELY.
// This absence is a decision, not an omission, and design.md records it
// under "The token resolver gets no property". The resolver's input space is
// small and FINITE -- three utility prefixes (`bg`, `text`, `border`) crossed
// with four variant combinations (none, `dark:`, `hover:`, `dark:hover:`)
// crossed with the dozen colour tokens the two Channel_Tree_Pages use, plus
// the handful of non-colour classes it must skip and the colour-SHAPED
// unknowns it must throw for. Every one of those cases has a single correct
// answer. A generator would rediscover the same dozen cases a hundred times
// and a reader could no longer see the space whole, so the space is
// enumerated below instead. The arithmetic in the same module -- where the
// input space really is unbounded -- IS property-tested, as Property 2 in
// `contrast.property.test.js`.
//
// The expected hex values below are written as LITERALS on purpose, even
// though the module derives them from the Tailwind config. That is what makes
// this an example test: it pins the specific numbers `requirements.md` and
// `design.md` computed their ratios from, so a palette edit fails loudly here
// rather than silently changing what every downstream ratio measures. The
// separate provenance suite is what checks the values came from the config in
// the first place.

/** The resolver returned no colour, and the caller skips the class. */
const NOT_A_COLOUR = Symbol('not a colour utility')

/** The class is colour-SHAPED and names no table entry, so it throws. */
const THROWS = Symbol('unresolvable colour token')

/**
 * The whole finite input space, in one table.
 *
 * `prefix` and `variant` are recorded per row so the structural guard at the
 * bottom of this file can prove the cross product is actually covered rather
 * than merely intended.
 */
const RESOLVER_CASES = [
  // ---------------------------------------------------------------------
  // The three utility prefixes crossed with the four variant combinations.
  // `bg` rows are the Channel_Tree_Row backgrounds; `text` rows are the
  // Folder_Icon, the Disclosure_Chevron and the row text. `border` rows and
  // the `hover:text-*` row name no class these two pages render -- they are
  // here because the resolver's grammar accepts the shape, so the shape is
  // enumerated.
  // ---------------------------------------------------------------------
  { className: 'bg-gray-100', prefix: 'bg', variant: 'none', expected: '#f3f4f6' },
  { className: 'dark:bg-gray-800', prefix: 'bg', variant: 'dark:', expected: '#1f2937' },
  { className: 'hover:bg-gray-200', prefix: 'bg', variant: 'hover:', expected: '#e5e7eb' },
  { className: 'dark:hover:bg-gray-700', prefix: 'bg', variant: 'dark:hover:', expected: '#374151' },

  { className: 'text-blue-600', prefix: 'text', variant: 'none', expected: '#2563eb' },
  { className: 'dark:text-blue-400', prefix: 'text', variant: 'dark:', expected: '#60a5fa' },
  { className: 'hover:text-gray-900', prefix: 'text', variant: 'hover:', expected: '#111827' },
  { className: 'dark:hover:text-gray-300', prefix: 'text', variant: 'dark:hover:', expected: '#d1d5db' },

  { className: 'border-gray-200', prefix: 'border', variant: 'none', expected: '#e5e7eb' },
  { className: 'dark:border-gray-700', prefix: 'border', variant: 'dark:', expected: '#374151' },
  { className: 'hover:border-gray-300', prefix: 'border', variant: 'hover:', expected: '#d1d5db' },
  { className: 'dark:hover:border-gray-600', prefix: 'border', variant: 'dark:hover:', expected: '#4b5563' },

  // ---------------------------------------------------------------------
  // Every remaining colour token the two Channel_Tree_Pages carry, before
  // and after the Section 2 class edits. Both states are here because this
  // resolver has to measure the markup on both sides of that change: the
  // pre-change tokens are the ones task 1.4's test must be RED on, and the
  // post-change tokens are the ones it must be green on.
  // ---------------------------------------------------------------------
  // Pre-change Folder_Row background and hover (the 1.46:1 row).
  { className: 'dark:bg-gray-600', prefix: 'bg', variant: 'dark:', expected: '#4b5563' },
  { className: 'dark:hover:bg-gray-500', prefix: 'bg', variant: 'dark:hover:', expected: '#6b7280' },
  // Pre-change Expandable_Channel_Row background, and its toggle button's hover.
  { className: 'bg-gray-50', prefix: 'bg', variant: 'none', expected: '#f9fafb' },
  { className: 'dark:bg-gray-700', prefix: 'bg', variant: 'dark:', expected: '#374151' },
  { className: 'dark:hover:bg-gray-600', prefix: 'bg', variant: 'dark:hover:', expected: '#4b5563' },
  // Disclosure_Chevron, before and after.
  { className: 'text-gray-500', prefix: 'text', variant: 'none', expected: '#6b7280' },
  { className: 'dark:text-gray-300', prefix: 'text', variant: 'dark:', expected: '#d1d5db' },
  // Row heading and description, before and after.
  { className: 'text-gray-900', prefix: 'text', variant: 'none', expected: '#111827' },
  { className: 'dark:text-gray-100', prefix: 'text', variant: 'dark:', expected: '#f3f4f6' },
  { className: 'text-gray-600', prefix: 'text', variant: 'none', expected: '#4b5563' },
  { className: 'dark:text-gray-400', prefix: 'text', variant: 'dark:', expected: '#9ca3af' },

  // Surrounding whitespace is trimmed, because a class list read off a
  // rendered element and split on whitespace can carry it.
  { className: '  dark:bg-gray-800  ', prefix: 'bg', variant: 'dark:', expected: '#1f2937' },

  // ---------------------------------------------------------------------
  // Non-colour classes. These SKIP -- a class list is mostly not colours,
  // and the caller filters on a null.
  // ---------------------------------------------------------------------
  { className: 'rounded-lg', prefix: null, variant: null, expected: NOT_A_COLOUR },
  { className: 'p-3', prefix: null, variant: null, expected: NOT_A_COLOUR },
  { className: 'h-5', prefix: null, variant: null, expected: NOT_A_COLOUR },
  { className: 'transition-transform', prefix: null, variant: null, expected: NOT_A_COLOUR },
  { className: 'mr-2', prefix: null, variant: null, expected: NOT_A_COLOUR },
  // Two more from the same rows, for the same reason.
  { className: 'cursor-pointer', prefix: null, variant: null, expected: NOT_A_COLOUR },
  { className: 'rotate-90', prefix: null, variant: null, expected: NOT_A_COLOUR },
  // Single-digit sizing utilities stay outside the shape, which is what the
  // pattern's two-digit lower bound buys.
  { className: 'border-t-2', prefix: null, variant: null, expected: NOT_A_COLOUR },
  // A side-specific colour utility carries an extra segment and is outside
  // the shape. No Channel_Tree_Row uses one; the tooltip caret does.
  { className: 'border-r-gray-900', prefix: null, variant: null, expected: NOT_A_COLOUR },
  // Non-strings resolve to nothing rather than throwing.
  { className: null, prefix: null, variant: null, expected: NOT_A_COLOUR },
  { className: undefined, prefix: null, variant: null, expected: NOT_A_COLOUR },

  // ---------------------------------------------------------------------
  // Colour-SHAPED classes that name no table entry. These THROW rather than
  // skip: an unmeasured pair is a pair that passes, which is the one outcome
  // Criterion 7.3's last sentence rules out.
  // ---------------------------------------------------------------------
  // A shade that does not exist. `bg-gray-1000` is INSIDE the shape --
  // that is what the pattern's open-ended `\d{2,}` is for -- so a mistyped
  // shade is reported instead of silently skipped.
  { className: 'bg-gray-1000', prefix: 'bg', variant: 'none', expected: THROWS },
  { className: 'dark:bg-gray-1000', prefix: 'bg', variant: 'dark:', expected: THROWS },
  // A family that does not exist, i.e. a token renamed out from under the
  // markup. `blurple` is fictional.
  { className: 'text-blurple-400', prefix: 'text', variant: 'none', expected: THROWS },
  { className: 'dark:hover:text-blurple-400', prefix: 'text', variant: 'dark:hover:', expected: THROWS },
  // KNOWN EDGE, documented in `contrast.js`: v2-style opacity utilities are
  // colour-SHAPED by this grammar and name no colour token, so they throw.
  // Harmless for the Channel_Tree_Rows, which carry none, and pinned here so
  // a caller feeding the resolver an arbitrary class list is not surprised.
  { className: 'bg-opacity-50', prefix: 'bg', variant: 'none', expected: THROWS },
]

describe('resolveColorToken (Req 7.3)', () => {
  for (const { className, expected } of RESOLVER_CASES) {
    const label = String(className)

    if (expected === NOT_A_COLOUR) {
      it(`skips '${label}', which names no colour`, () => {
        expect(resolveColorToken(className)).toBeNull()
      })
      continue
    }

    if (expected === THROWS) {
      it(`throws for '${label}', which is colour-shaped and unresolvable`, () => {
        expect(() => resolveColorToken(className)).toThrow(/Color_Token_Table/)
      })
      continue
    }

    it(`resolves '${label}' to ${expected}`, () => {
      expect(resolveColorToken(className)).toBe(expected)
    })
  }

  // Anti-vacuity: the table above is only an enumeration of the input space
  // if it actually covers the cross product it claims to. A deleted row would
  // otherwise leave this suite passing while measuring less than it says.
  it('covers all three prefixes crossed with all four variant combinations', () => {
    const covered = new Set(
      RESOLVER_CASES.filter((row) => row.prefix !== null).map(
        (row) => `${row.prefix}|${row.variant}`
      )
    )

    for (const prefix of ['bg', 'text', 'border']) {
      for (const variant of ['none', 'dark:', 'hover:', 'dark:hover:']) {
        expect(covered).toContain(`${prefix}|${variant}`)
      }
    }
  })
})

describe('COLOR_TOKEN_TABLE provenance (Req 7.3)', () => {
  // This is the half of Criterion 7.3 that a contents-only test cannot
  // reach. `gray` is DECLARED by this project and `blue` is NOT -- it comes
  // from stock Tailwind -- so an implementation reading
  // `theme.extend.colors` directly would resolve `gray-800` correctly and be
  // unable to see `blue-400` at all. Asserting both, and asserting WHERE
  // each one comes from, is what pins `resolveConfig` as the source.

  it('takes gray-800 from the scale this project declares', () => {
    const declared = tailwindConfig.theme.extend.colors.gray

    expect(declared[800]).toBe('#1f2937')
    expect(COLOR_TOKEN_TABLE['gray-800']).toBe(declared[800])
    expect(COLOR_TOKEN_TABLE['gray-800']).toBe('#1f2937')
  })

  it('takes blue-400 from stock Tailwind, which this project does not declare', () => {
    // The premise: nothing in the config declares `blue`. If that ever
    // changes this assertion fails and the reasoning below needs revisiting.
    expect(tailwindConfig.theme.extend.colors.blue).toBeUndefined()

    // And yet it resolves -- which is only possible via the stock palette.
    expect(COLOR_TOKEN_TABLE['blue-400']).toBe('#60a5fa')
    expect(COLOR_TOKEN_TABLE['blue-600']).toBe('#2563eb')
  })

  it('resolves BOTH a declared and a stock token through the resolver', () => {
    expect(resolveColorToken('dark:bg-gray-800')).toBe('#1f2937')
    expect(resolveColorToken('dark:text-blue-400')).toBe('#60a5fa')
  })

  it('carries the project-only `primary` family, which stock Tailwind has no notion of', () => {
    // The mirror image of the `blue` case: `primary` exists ONLY because the
    // config declares it, so its presence proves the config was read rather
    // than assumed.
    expect(COLOR_TOKEN_TABLE['primary-600']).toBe(
      tailwindConfig.theme.extend.colors.primary[600]
    )
  })

  it('admits hex colours only, so no non-colour can reach the arithmetic', () => {
    // `theme.colors` also holds `transparent`, `inherit` and `currentColor`.
    // A `transparent` reaching `relativeLuminance` would produce a NUMBER
    // rather than an error -- a silently wrong ratio.
    for (const [token, hex] of Object.entries(COLOR_TOKEN_TABLE)) {
      expect(hex, `token ${token}`).toMatch(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i)
    }

    expect(COLOR_TOKEN_TABLE.transparent).toBeUndefined()
    expect(COLOR_TOKEN_TABLE.currentColor).toBeUndefined()
  })
})
