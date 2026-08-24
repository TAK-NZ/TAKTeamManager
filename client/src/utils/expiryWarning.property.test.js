import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import {
  EXPIRY_STATES,
  DEFAULT_EXPIRY_WARNING_DAYS,
  classifyExpiry
} from './expiryWarning.js'

// Feature: device-management, Property 16: Expiry classification is total and boundary-exact
//
// **Validates: Requirements 21.4, 21.6, 21.11**
//
// For all `expiresAt` values and all thresholds, `classifyExpiry` returns
// exactly one of `none`/`imminent`/`expired` and never raises; `expired` iff
// the instant is known and STRICTLY earlier than `now`; `imminent` iff it is
// known and within the CLOSED interval `now` .. `now + warningDays`; `none`
// otherwise, including for every unknown or unparseable input.
//
// TWO DELIBERATE GENERATOR DECISIONS, both load-bearing:
//
// 1. The offset distribution is CONCENTRATED AT THE BOUNDARIES -- exactly `0`,
//    +/-1 ms around `now`, and +/-1 ms around `now + warningDays` -- alongside
//    broad random offsets spanning tens of years. A uniform generator over a
//    range that wide would essentially never land on the inclusive upper
//    boundary, so it would pass an implementation that wrote `<` where
//    Criterion 21.6 requires `<=`. The boundary cases are what this property
//    exists to catch; the broad offsets are what stop it from being three
//    examples in a loop.
//
// 2. The expected state is RE-DERIVED from the generated inputs -- from the
//    generated `offset` and the threshold's known resolved value -- and never
//    by calling back into `classifyExpiry` or `resolveWarningDays`. That is
//    why the threshold arbitrary yields a PAIR: the raw value handed to the
//    function under test, together with the day count that value is defined to
//    resolve to (Criterion 21.7). A threshold that is not a positive integer
//    normalises to 30, so `'abc'`, `0`, `-5` and `30.7` all put the boundary
//    at 30 days, NOT at the raw value and NOT at a truncation of it. Deriving
//    the boundary by asking the module would make the property agree with any
//    implementation, including a wrong one.

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Every value `classifyExpiry` can return, for the "exactly one of" check. */
const ALL_STATES = [EXPIRY_STATES.NONE, EXPIRY_STATES.IMMINENT, EXPIRY_STATES.EXPIRED]

// `now` is kept comfortably inside the epoch so that `now + offset` is still a
// representable instant for every generated offset, in every representation --
// the ISO-string arm of the representation generator has to round-trip
// exactly, which it does for any integer millisecond value.
const NOW_MIN = 1_200_000_000_000 // 2008
const NOW_MAX = 2_500_000_000_000 // 2049

/** ~31 years, so the broad arm reaches well past any generated threshold. */
const BROAD_OFFSET_MS = 1_000_000_000_000

/**
 * A threshold to hand to `classifyExpiry`, paired with the day count it is
 * DEFINED to resolve to (Criterion 21.7). The pairing is what lets the
 * expected state be derived without consulting the module.
 */
const thresholdArb = fc.oneof(
  // Positive integers, the only values a healthy config can carry: the
  // resolved value is the raw one.
  fc.integer({ min: 1, max: 3650 }).map((days) => ({ raw: days, resolvedDays: days })),
  // The same values as strings, which is how they arrive over JSON.
  fc.integer({ min: 1, max: 3650 }).map((days) => ({ raw: String(days), resolvedDays: days })),
  // Everything Criterion 21.7 says to answer with 30: absent, zero, negative,
  // unparseable, fractional, part-numeric, and the wrong type entirely.
  fc
    .constantFrom(
      undefined,
      null,
      0,
      -5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      30.7,
      45.9,
      '0',
      '-5',
      'abc',
      '30.7',
      '12abc',
      '',
      '   ',
      true,
      [30]
    )
    .map((raw) => ({ raw, resolvedDays: DEFAULT_EXPIRY_WARNING_DAYS }))
)

/**
 * The offset of `expiresAt` from `now`, in milliseconds, concentrated at the
 * boundaries (decision 1 in the header).
 *
 * @param {number} boundaryMs `warningDays` in milliseconds, i.e. the distance
 *   from `now` to the inclusive upper end of the imminent interval.
 */
const offsetArb = (boundaryMs) =>
  fc.oneof(
    fc.constantFrom(
      0, // exactly `now` -- imminent, the lower end is inclusive too
      -1, // one ms before `now` -- expired
      1, // one ms after `now` -- imminent
      boundaryMs - 1, // just inside the window
      boundaryMs, // EXACTLY on the boundary -- imminent (`<=`, not `<`)
      boundaryMs + 1 // one ms past it -- none
    ),
    fc.integer({ min: -BROAD_OFFSET_MS, max: BROAD_OFFSET_MS })
  )

/** Inputs that are not instants at all. Every one of them must yield `none`. */
const UNKNOWN_LABELS = [
  'null',
  'undefined',
  'emptyString',
  'blankString',
  'garbage',
  'impossibleDate',
  'invalidDate',
  'nan',
  'infinity',
  'negativeInfinity',
  'boolean',
  'object',
  'array',
  'symbol',
  'bigint',
  'hostileValueOf',
  'function'
]

/**
 * Builds the unknown input a label names.
 *
 * The values are constructed here rather than being generated as constants so
 * that a counterexample prints as a readable label, and so the hostile
 * `valueOf` is only ever reachable through the code under test -- which must
 * not hand it to the `Date` constructor. `symbol` and `bigint` are in this
 * list for the same reason: `new Date(Symbol())` and `new Date(1n)` both
 * THROW, so a totality claim that has not been tested against them is
 * untested where it matters.
 *
 * @param {string} label one of `UNKNOWN_LABELS`.
 * @returns {*} the value that label names.
 */
function makeUnknown(label) {
  switch (label) {
    case 'null':
      return null
    case 'undefined':
      return undefined
    case 'emptyString':
      return ''
    case 'blankString':
      return '   '
    case 'garbage':
      return 'not a date'
    case 'impossibleDate':
      return '2024-13-45T99:99:99Z'
    case 'invalidDate':
      return new Date('not a date')
    case 'nan':
      return Number.NaN
    case 'infinity':
      return Number.POSITIVE_INFINITY
    case 'negativeInfinity':
      return Number.NEGATIVE_INFINITY
    case 'boolean':
      return true
    case 'object':
      return {}
    case 'array':
      return []
    case 'symbol':
      return Symbol('expires')
    case 'bigint':
      return 1n
    case 'hostileValueOf':
      return {
        valueOf() {
          throw new Error('valueOf must never be called')
        }
      }
    case 'function':
      return () => 0
    default:
      throw new Error(`unhandled label ${label}`)
  }
}

/**
 * A known instant, `offset` ms from `now`, in one of the three shapes the
 * classifier accepts. All three describe the SAME instant, so all three must
 * classify identically -- an ISO string is what the wire actually carries.
 */
const knownArb = fc
  .record({
    now: fc.integer({ min: NOW_MIN, max: NOW_MAX }),
    threshold: thresholdArb,
    representation: fc.constantFrom('number', 'string', 'date'),
    nowAsDate: fc.boolean()
  })
  .chain((base) =>
    offsetArb(base.threshold.resolvedDays * MS_PER_DAY).map((offset) => ({
      kind: 'known',
      ...base,
      offset
    }))
  )

/** An input that is not an instant, against an arbitrary `now` and threshold. */
const unknownArb = fc.record({
  kind: fc.constant('unknown'),
  now: fc.integer({ min: NOW_MIN, max: NOW_MAX }),
  threshold: thresholdArb,
  label: fc.constantFrom(...UNKNOWN_LABELS)
})

/** Renders an instant in the generated representation. */
function represent(epochMs, representation) {
  if (representation === 'number') return epochMs
  if (representation === 'string') return new Date(epochMs).toISOString()
  return new Date(epochMs)
}

describe('Property 16: expiry classification is total and boundary-exact', () => {
  it('returns exactly one state, expired iff strictly before now, imminent iff within the closed window', () => {
    fc.assert(
      fc.property(fc.oneof(knownArb, unknownArb), (scenario) => {
        const nowArgument = scenario.kind === 'known' && scenario.nowAsDate
          ? new Date(scenario.now)
          : scenario.now

        const expiresAt =
          scenario.kind === 'known'
            ? represent(scenario.now + scenario.offset, scenario.representation)
            : makeUnknown(scenario.label)

        // The single call under test. It is outside any try/catch on purpose:
        // "never raises" is part of the property, so a throw fails the run
        // rather than being caught and re-described.
        const state = classifyExpiry(expiresAt, scenario.threshold.raw, nowArgument)

        // Exactly one of the three states, for every input whatsoever.
        expect(ALL_STATES).toContain(state)

        if (scenario.kind === 'unknown') {
          // Criterion 21.4 and the last clause of 21.6: an unknown or
          // unparseable `expiresAt` is `none`, whatever the threshold.
          expect(state).toBe(EXPIRY_STATES.NONE)
          return
        }

        // Re-derived from the generated offset and the threshold's DEFINED
        // resolved value -- never from the module (decision 2 in the header).
        const boundaryMs = scenario.threshold.resolvedDays * MS_PER_DAY
        let expected = EXPIRY_STATES.NONE
        if (scenario.offset < 0) {
          expected = EXPIRY_STATES.EXPIRED
        } else if (scenario.offset <= boundaryMs) {
          expected = EXPIRY_STATES.IMMINENT
        }

        expect(state).toBe(expected)
      }),
      { numRuns: 500 }
    )
  })
})
