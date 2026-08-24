import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import { NO_PHRASE, relativeTime } from './relativeTime.js'

// Feature: date-tooltips-and-folder-contrast, Property 1: The Relative_Time classification is total, boundary-exact, correctly signed, and correctly singularised
//
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 1.8, 1.9, 1.11, 1.12**
//
// For all candidate values -- including `null`, `undefined`, `NaN`, `Infinity`,
// symbols, bigints, objects with a hostile `valueOf`, unparseable strings,
// blank strings, finite numbers, `Date` objects and ISO strings -- and for all
// supplied `now` values including unusable ones, `relativeTime` returns either
// a non-empty English phrase or `NO_PHRASE`, and never throws. For all
// distances at each of the six Criterion 1.3 boundaries, one millisecond below
// it and one millisecond above it, in both directions, the returned phrase
// names the unit and magnitude that boundary's rung assigns, with a floored
// magnitude never below 1 and the sub-minute rung rendering `just now` in place
// of any zero-magnitude phrase. A value strictly earlier than `now` never
// produces an `in ...` phrase and a value strictly later never produces an
// `... ago` phrase. A magnitude of exactly 1 is singular and every magnitude of
// 2 or more is plural, in every unit and both directions.
//
// TWO GENERATOR DISCIPLINES, both load-bearing, both inherited verbatim from
// `expiryWarning.property.test.js`:
//
// 1. BOUNDARY CONCENTRATION (Criterion 1.12). Distances are drawn from
//    `fc.oneof` over each of the six Criterion 1.3 boundaries offset by -1, 0
//    and +1 ms, in BOTH directions, PLUS a broad uniform arm spanning three
//    decades. A uniform offset over decades lands on or adjacent to a boundary
//    with vanishing probability, and the boundaries are precisely where an
//    implementation that wrote `<` for `<=` -- or `<=` for `<` -- is wrong. A
//    uniform-only generator would report that bug as a clean pass. The broad
//    arm is what stops the property from being eighteen examples in a loop.
//
// 2. INDEPENDENT RE-DERIVATION. Every expected phrase is computed from the
//    GENERATED distance and the six HARD-CODED boundaries below. The module's
//    ladder is deliberately not exported and is deliberately not imported
//    here, and `relativeTime` is never called to establish its own
//    expectation: a test that computes its expectation with the function it is
//    checking asserts only determinism. The constants below are transcribed
//    from Criterion 1.3, not from `relativeTime.js`, so a ladder edited to
//    31-day months fails this file rather than agreeing with it.

/** The Criterion 1.3 units, hard-coded here rather than imported. */
const MS_MINUTE = 60 * 1000
const MS_HOUR = 60 * MS_MINUTE
const MS_DAY = 24 * MS_HOUR
/** Nominal_Month: exactly 30 days (Criterion 1.5). */
const MS_MONTH = 30 * MS_DAY
/** Nominal_Year: exactly 365 days (Criterion 1.5). */
const MS_YEAR = 365 * MS_DAY

/**
 * The six boundaries of Criterion 1.3, as absolute distances: the lower bound
 * of each of the six half-open ranges. `0` is the first rung's lower bound;
 * `MS_YEAR` is the last rung's, which has no upper bound.
 */
const BOUNDARIES = [0, MS_MINUTE, MS_HOUR, MS_DAY, MS_MONTH, MS_YEAR]

/** The magnitude-bearing rungs, for the singular/plural pivot arm. */
const UNITS = [
  { unitMs: MS_MINUTE, singular: 'minute', plural: 'minutes' },
  { unitMs: MS_HOUR, singular: 'hour', plural: 'hours' },
  { unitMs: MS_DAY, singular: 'day', plural: 'days' },
  { unitMs: MS_MONTH, singular: 'month', plural: 'months' },
  { unitMs: MS_YEAR, singular: 'year', plural: 'years' }
]

// `now` is kept comfortably inside the epoch so that `now + signed` is a
// representable instant for every generated distance in every representation --
// the ISO-string arm has to round-trip exactly, which it does for any integer
// millisecond value in range.
const NOW_MIN = 1_200_000_000_000 // 2008
const NOW_MAX = 2_500_000_000_000 // 2049

/** ~30 years, so the broad arm reaches well past the largest boundary. */
const BROAD_DISTANCE_MS = 30 * MS_YEAR

/**
 * The expected phrase for a signed distance, re-derived from the generated
 * distance and the hard-coded boundaries above (discipline 2 in the header).
 *
 * This is the Criterion 1.3 ladder read straight off the requirement: the
 * first range that contains the absolute distance supplies the unit, the
 * magnitude is FLOORED (Criterion 1.6), the unit noun is singular at exactly
 * 1 and plural at 2 or more (Criterion 1.7), and the direction words come
 * from the SIGN alone (Criterion 1.2) -- with the sub-minute rung carrying
 * neither a direction nor a magnitude (Criteria 1.3.1, 1.4).
 *
 * @param {number} signed `value - now`, in milliseconds.
 * @returns {string} The phrase Criterion 1.3 assigns.
 */
function expectedPhrase(signed) {
  const distance = Math.abs(signed)

  if (distance < MS_MINUTE) {
    return 'just now'
  }

  let unitMs
  let singular
  let plural
  if (distance < MS_HOUR) {
    unitMs = MS_MINUTE
    singular = 'minute'
    plural = 'minutes'
  } else if (distance < MS_DAY) {
    unitMs = MS_HOUR
    singular = 'hour'
    plural = 'hours'
  } else if (distance < MS_MONTH) {
    unitMs = MS_DAY
    singular = 'day'
    plural = 'days'
  } else if (distance < MS_YEAR) {
    unitMs = MS_MONTH
    singular = 'month'
    plural = 'months'
  } else {
    unitMs = MS_YEAR
    singular = 'year'
    plural = 'years'
  }

  const magnitude = Math.floor(distance / unitMs)
  const unit = magnitude === 1 ? singular : plural

  return signed < 0 ? `${magnitude} ${unit} ago` : `in ${magnitude} ${unit}`
}

/**
 * Absolute distances, CONCENTRATED AT THE BOUNDARIES (discipline 1 in the
 * header): each of the six Criterion 1.3 boundaries at -1, 0 and +1 ms,
 * combined with a broad uniform arm spanning three decades.
 *
 * `0 - 1` is dropped rather than clamped: a negative absolute distance is not
 * a case, and the -1 ms side of the zero boundary is already covered by the
 * signed direction the caller applies.
 */
const distanceArb = fc.oneof(
  fc.constantFrom(
    ...BOUNDARIES.flatMap((boundary) => [boundary - 1, boundary, boundary + 1]).filter(
      (distance) => distance >= 0
    )
  ),
  fc.integer({ min: 0, max: BROAD_DISTANCE_MS })
)

/** Renders an instant in one of the three shapes the classifier accepts. */
function represent(epochMs, representation) {
  if (representation === 'number') return epochMs
  if (representation === 'string') return new Date(epochMs).toISOString()
  return new Date(epochMs)
}

/**
 * Inputs that are NOT usable instants. Every one of them must yield
 * `NO_PHRASE`, whether it arrives as the value or as `now` (Criterion 1.8).
 *
 * `undefined` is in this list twice over: it is a non-instant in its own
 * right, and it is what an OMITTED `now` arrives as, which is how Criterion
 * 1.1's "no `Date.now()` default" is observable from outside the module.
 */
const UNUSABLE_LABELS = [
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
 * Inputs that ARE usable instants, in every accepted shape.
 *
 * `extremeFiniteNumber` and `negativeExtremeFiniteNumber` are each a usable
 * instant on their own, but their DIFFERENCE overflows to a non-finite number.
 * The module answers `NO_PHRASE` for that pair rather than emitting
 * `Infinity years ago`, so the totality arm below accepts `NO_PHRASE` for any
 * usable/usable combination rather than demanding a phrase.
 */
const USABLE_LABELS = [
  'zeroNumber',
  'finiteNumber',
  'negativeFiniteNumber',
  'dateObject',
  'isoString',
  'looseDateString',
  'extremeFiniteNumber',
  'negativeExtremeFiniteNumber'
]

/**
 * Builds the input a label names.
 *
 * The values are constructed here rather than generated as constants so that a
 * counterexample prints as a readable label, and so the hostile `valueOf` is
 * only ever reachable through the code under test -- which must not hand it to
 * the `Date` constructor. `symbol` and `bigint` are in the list for the same
 * reason: `new Date(Symbol())` and `new Date(1n)` both THROW, so a totality
 * claim that has not been tested against them is untested where it matters.
 *
 * @param {string} label One of `UNUSABLE_LABELS` or `USABLE_LABELS`.
 * @returns {*} The value that label names.
 */
function makeInput(label) {
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
      return Symbol('instant')
    case 'bigint':
      return 1n
    case 'hostileValueOf':
      return {
        valueOf() {
          throw new Error('valueOf must never be called')
        },
        toString() {
          throw new Error('toString must never be called')
        }
      }
    case 'function':
      return () => 0
    case 'zeroNumber':
      return 0
    case 'finiteNumber':
      return 1_700_000_000_000
    case 'negativeFiniteNumber':
      return -1_000_000_000
    case 'dateObject':
      return new Date(1_700_000_000_000)
    case 'isoString':
      return '2023-11-14T22:13:20.000Z'
    case 'looseDateString':
      return '2023-11-14'
    case 'extremeFiniteNumber':
      return Number.MAX_VALUE
    case 'negativeExtremeFiniteNumber':
      return -Number.MAX_VALUE
    default:
      throw new Error(`unhandled label ${label}`)
  }
}

/** Any phrase the ladder can emit names one of these nouns. */
const UNIT_NOUNS = ['minute', 'minutes', 'hour', 'hours', 'day', 'days', 'month', 'months', 'year', 'years']

describe('Property 1: the Relative_Time classification is total, boundary-exact, correctly signed, and correctly singularised', () => {
  it('returns a non-empty phrase or NO_PHRASE for any value and any now, and never throws', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...UNUSABLE_LABELS, ...USABLE_LABELS),
        fc.constantFrom(...UNUSABLE_LABELS, ...USABLE_LABELS),
        (valueLabel, nowLabel) => {
          const value = makeInput(valueLabel)
          const now = makeInput(nowLabel)

          // The single call under test, deliberately outside any try/catch:
          // "never throws" is part of the property, so a throw must fail the
          // run rather than be caught and re-described (Criterion 1.8).
          const phrase = relativeTime(value, now)

          const eitherUnusable =
            UNUSABLE_LABELS.includes(valueLabel) || UNUSABLE_LABELS.includes(nowLabel)

          if (eitherUnusable) {
            // Criterion 1.8: an unusable value OR an unusable `now` is
            // No_Phrase, and Criterion 1.9 makes that a DISTINCT value rather
            // than an empty string -- so this is an identity check.
            expect(phrase).toBe(NO_PHRASE)
            return
          }

          // Both usable. A phrase, or No_Phrase where the difference of two
          // extreme-but-finite instants overflows (see USABLE_LABELS).
          if (phrase !== NO_PHRASE) {
            expect(typeof phrase).toBe('string')
            expect(phrase.length).toBeGreaterThan(0)
          }
        }
      ),
      { numRuns: 500 }
    )
  })

  it('places every boundary-adjacent distance in the rung Criterion 1.3 assigns, in both directions', () => {
    fc.assert(
      fc.property(
        fc.record({
          now: fc.integer({ min: NOW_MIN, max: NOW_MAX }),
          distance: distanceArb,
          future: fc.boolean(),
          valueRepresentation: fc.constantFrom('number', 'string', 'date'),
          nowRepresentation: fc.constantFrom('number', 'string', 'date')
        }),
        ({ now, distance, future, valueRepresentation, nowRepresentation }) => {
          const signed = future ? distance : -distance
          const phrase = relativeTime(
            represent(now + signed, valueRepresentation),
            represent(now, nowRepresentation)
          )

          // Re-derived from the generated distance and the hard-coded
          // boundaries -- never by asking the module (discipline 2).
          expect(phrase).toBe(expectedPhrase(signed))

          // Criteria 1.3.1 and 1.4: the sub-minute rung is `just now`, with no
          // direction and no magnitude, and NO zero-magnitude phrase exists
          // anywhere in the ladder.
          if (distance < MS_MINUTE) {
            expect(phrase).toBe('just now')
          } else {
            expect(phrase).not.toBe('just now')
          }
          for (const noun of UNIT_NOUNS) {
            expect(phrase).not.toBe(`0 ${noun} ago`)
            expect(phrase).not.toBe(`in 0 ${noun}`)
          }

          // Criterion 1.2, the sign rule. Distance 0 is the directionless
          // first rung whichever way `future` fell, so it is exempt.
          if (distance >= MS_MINUTE) {
            if (signed < 0) {
              expect(phrase.endsWith(' ago')).toBe(true)
              expect(phrase.startsWith('in ')).toBe(false)
            } else {
              expect(phrase.startsWith('in ')).toBe(true)
              expect(phrase.endsWith(' ago')).toBe(false)
            }
          }
        }
      ),
      { numRuns: 1000 }
    )
  })

  it('singularises at exactly 1 and pluralises at 2 or more, in every unit and both directions', () => {
    fc.assert(
      fc.property(
        fc.record({
          now: fc.integer({ min: NOW_MIN, max: NOW_MAX }),
          // 1..5 stays inside every rung's range: 5 minutes < 1 hour,
          // 5 hours < 1 day, 5 days < 1 month, 5 months < 1 year, and the
          // year rung has no upper bound.
          magnitude: fc.integer({ min: 1, max: 5 }),
          unitIndex: fc.integer({ min: 0, max: UNITS.length - 1 }),
          future: fc.boolean()
        }).chain((base) =>
          // A sub-unit jitter, so the magnitude is exercised as a FLOOR of a
          // range rather than only at each unit's exact multiple
          // (Criterion 1.6).
          fc
            .integer({ min: 0, max: UNITS[base.unitIndex].unitMs - 1 })
            .map((jitter) => ({ ...base, jitter }))
        ),
        ({ now, magnitude, unitIndex, future, jitter }) => {
          const { unitMs, singular, plural } = UNITS[unitIndex]
          const distance = magnitude * unitMs + jitter
          const signed = future ? distance : -distance

          const phrase = relativeTime(now + signed, now)

          const noun = magnitude === 1 ? singular : plural
          expect(phrase).toBe(future ? `in ${magnitude} ${noun}` : `${magnitude} ${noun} ago`)

          // Criterion 1.7 stated as the pivot rather than as the string: the
          // plural form never appears at 1 and the singular never at 2 or more.
          if (magnitude === 1) {
            expect(phrase).toContain(` ${singular}`)
            expect(phrase).not.toContain(` ${plural}`)
          } else {
            expect(phrase).toContain(` ${plural}`)
          }
        }
      ),
      { numRuns: 500 }
    )
  })
})
