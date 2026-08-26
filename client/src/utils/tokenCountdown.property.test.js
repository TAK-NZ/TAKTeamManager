// Feature: takserver-enrollment, Property 10: The Token_Countdown formatter is total and boundary-exact at zero
//
// **Validates: Requirements 10.2**
//
// *For any* remaining-millisecond value -- including exactly `0`, `-1`, `+1`,
// `999`, `1000`, `59999`, `60000`, values just under and just over the
// 30-minute Enrollment_Token_Lifetime, values exceeding 99 minutes, `null`,
// `undefined`, `NaN`, `Infinity`, `-Infinity`, and non-numeric inputs --
// `formatCountdown` SHALL return either the exact terminal string `EXPIRED`
// or a string matching exactly `MM : SS` with both components zero-padded to
// at least two digits and the seconds component in the closed range 00 to
// 59; SHALL return `EXPIRED` if and only if the input is not a finite number
// greater than zero; SHALL never throw; and SHALL never render a minutes
// value smaller than the true remaining minutes.
//
// INDEPENDENT RE-DERIVATION. The expected `MM : SS` value is computed here
// from `Math.ceil(msRemaining / 1000)` split into minutes and seconds --
// transcribed from the acceptance criteria's own rounding direction, not by
// importing `tokenCountdown.js`'s internals and not by calling
// `formatCountdown` to build its own expectation. A test that called the
// subject to compute what the subject "should" return would assert only
// determinism.
//
// BOUNDARY CONCENTRATION. `0`, `-1`, `+1`, `999`/`1000` (the second either
// side of the first whole second), `59999`/`60000` (the second either side of
// one whole minute), the instants either side of and exactly on the
// 30-minute Enrollment_Token_Lifetime (1,800,000 ms), and instants beyond 99
// minutes of remaining time (5,940,000 ms and above, where a truncating or
// wrapping implementation would first misbehave). A uniform generator over a
// wide millisecond range would essentially never land on any of these.
//
// TOTALITY. `null`, `undefined`, `NaN`, `Infinity`, `-Infinity`, non-numeric
// strings, booleans, plain objects, arrays, a `Symbol`, a `BigInt` and a
// function are all drawn from a shared totality arm, per the acceptance
// criteria's explicit list plus the repository's totality-generator
// convention.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { COUNTDOWN_EXPIRED, formatCountdown } from './tokenCountdown.js'

/** The 30-minute Enrollment_Token_Lifetime, in milliseconds. */
const LIFETIME_MS = 30 * 60 * 1000

/** 99 minutes, in milliseconds -- the boundary the criterion names for a
 * minutes value that would first exceed two digits. */
const NINETY_NINE_MINUTES_MS = 99 * 60 * 1000

/**
 * Values concentrated at the exact boundaries the criterion names, plus the
 * neighbours either side of each. Every one of these is a value a uniform
 * generator would essentially never produce on its own.
 */
const boundaryValueArb = fc.constantFrom(
  0,
  -1,
  1,
  999,
  1000,
  59999,
  60000,
  LIFETIME_MS - 1,
  LIFETIME_MS,
  LIFETIME_MS + 1,
  NINETY_NINE_MINUTES_MS - 1,
  NINETY_NINE_MINUTES_MS,
  NINETY_NINE_MINUTES_MS + 1,
  NINETY_NINE_MINUTES_MS + 60_000,
  10_000_000
)

/** A broad arm covering ordinary positive, negative, integer and fractional
 * millisecond values, so the boundary arm above is not the whole property. */
const broadNumberArb = fc.oneof(
  fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
  fc.double({ min: -1_000_000_000, max: 1_000_000_000, noNaN: true })
)

/**
 * Values that are not a finite number greater than zero, drawn from the
 * shared totality set: `null`, `undefined`, `NaN`, `+/-Infinity`,
 * non-numeric strings, booleans, a plain object, an array, a `Symbol`, a
 * `BigInt` and a function.
 */
const nonPositiveFiniteNumberArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.constant(0),
  fc.constant(-0),
  fc.string(),
  fc.constantFrom('', '   ', 'not-a-number', '1000'),
  fc.boolean(),
  fc.constant({}),
  fc.constant({ msRemaining: 5000 }),
  fc.array(fc.integer()),
  fc.constant(Symbol('msRemaining')),
  fc.bigInt(),
  fc.constant(() => 5000)
)

const scenarioArb = fc.oneof(
  { arbitrary: boundaryValueArb, weight: 4 },
  { arbitrary: broadNumberArb, weight: 3 },
  { arbitrary: nonPositiveFiniteNumberArb, weight: 3 }
)

/**
 * Whether `formatCountdown` is defined to render `MM : SS` for this value
 * rather than the terminal `EXPIRED` state -- a finite number strictly
 * greater than zero, and nothing else.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isFiniteNumberGreaterThanZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * The expected `MM : SS` string, re-derived from `Math.ceil(msRemaining /
 * 1000)` split into minutes and seconds -- the acceptance criteria's own
 * rounding direction, transcribed independently of `tokenCountdown.js`.
 *
 * @param {number} msRemaining a finite number strictly greater than zero.
 * @returns {{ text: string, minutes: number, seconds: number }}
 */
function expectedCountdown(msRemaining) {
  const totalSeconds = Math.ceil(msRemaining / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return { text: `${mm} : ${ss}`, minutes, seconds }
}

/** Anchored `MM : SS` shape: minutes zero-padded to at least two digits,
 * seconds exactly two digits in the closed range 00..59. */
const MM_SS_PATTERN = /^(\d{2,}) : ([0-5]\d)$/

describe('Property 10: the Token_Countdown formatter is total and boundary-exact at zero', () => {
  it('returns EXPIRED iff the input is not a finite positive number, and MM : SS otherwise, never throwing', () => {
    // Anti-vacuity counters: both branches, and at least one boundary value
    // from each named cluster, must actually be exercised.
    let expiredCount = 0
    let renderedCount = 0
    let sawZero = false
    let sawJustUnderLifetime = false
    let sawJustOverNinetyNineMinutes = false

    fc.assert(
      fc.property(scenarioArb, (msRemaining) => {
        if (msRemaining === 0) sawZero = true
        if (msRemaining === LIFETIME_MS - 1) sawJustUnderLifetime = true
        if (msRemaining === NINETY_NINE_MINUTES_MS + 1) sawJustOverNinetyNineMinutes = true

        // The call under test is outside any try/catch on purpose: "never
        // throws" is part of the property, so a throw fails the run rather
        // than being caught and re-described.
        const result = formatCountdown(msRemaining)

        if (!isFiniteNumberGreaterThanZero(msRemaining)) {
          // EXPIRED if and only if the input is not a finite number greater
          // than zero.
          expect(result).toBe(COUNTDOWN_EXPIRED)
          expiredCount += 1
          return
        }

        const expected = expectedCountdown(msRemaining)

        // Exact agreement with the independently re-derived expectation.
        expect(result).toBe(expected.text)

        // The result also matches the anchored MM : SS shape on its own
        // terms, independent of the exact-value comparison above.
        const match = MM_SS_PATTERN.exec(result)
        expect(match).not.toBeNull()

        // Never renders a minutes value smaller than the true remaining
        // minutes -- checked explicitly, not merely implied by the exact
        // equality above, since this is the clause the criterion states
        // separately from "EXPIRED iff not positive".
        const renderedMinutes = Number(match[1])
        expect(renderedMinutes).toBeGreaterThanOrEqual(expected.minutes)
        expect(renderedMinutes).toBe(expected.minutes)

        renderedCount += 1
      }),
      { numRuns: 200 }
    )

    expect(expiredCount).toBeGreaterThan(0)
    expect(renderedCount).toBeGreaterThan(0)
    expect(sawZero).toBe(true)
    expect(sawJustUnderLifetime).toBe(true)
    expect(sawJustOverNinetyNineMinutes).toBe(true)
  })
})
