import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { NO_PHRASE, relativeTime } from './relativeTime.js'

// Validates: Requirements 1.1, 1.3, 1.4, 1.5, 1.7, 1.9, 1.10
//
// The named example cases for the Relative_Time classifier (task 3.3),
// following the `expiryWarning.test.js` convention: the whole input space and
// the +/-1 ms behaviour of every boundary belong to Property 1 in
// `relativeTime.property.test.js`; this file pins the specific values the
// acceptance criteria name and a reader can check by eye.
//
// What is asserted here and nowhere else:
//   - `just now` at distance 0 and at 59 999 ms (Criteria 1.3.1, 1.4)
//   - the singular/plural pivot in all FIVE magnitude-bearing units, in both
//     directions (Criterion 1.7)
//   - `12 months ago` immediately below the year boundary -- the 365/30
//     artifact Criterion 1.5 accepts, which reads as an off-by-one until you
//     have read that criterion
//   - `NO_PHRASE` is a DISTINCT VALUE rather than an empty string, asserted by
//     IDENTITY (Criterion 1.9)
//   - an OMITTED `now` yields `NO_PHRASE` rather than a clock read
//     (Criterion 1.1)
//   - a structural assertion that the module source names no locale-aware
//     relative-time formatter (Criterion 1.10)

const MS_PER_MINUTE = 60 * 1000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR

// The nominal units of Criterion 1.5, hard-coded here rather than imported.
// The ladder is module-private on purpose, and a test that read its constants
// would agree with a ladder someone had edited to 31-day months.
const NOMINAL_MONTH_MS = 30 * MS_PER_DAY
const NOMINAL_YEAR_MS = 365 * MS_PER_DAY

// A fixed reference instant. `now` is a parameter precisely so every boundary
// is reachable by arithmetic, with no clock manipulation and no dependence on
// when the suite happens to run.
const NOW = Date.parse('2026-06-01T00:00:00Z')

/** The phrase for a value `distance` ms in the PAST of `NOW`. */
const ago = (distance) => relativeTime(NOW - distance, NOW)

/** The phrase for a value `distance` ms in the FUTURE of `NOW`. */
const ahead = (distance) => relativeTime(NOW + distance, NOW)

describe('the sub-minute rung is `just now` (Criteria 1.3.1, 1.4)', () => {
  // Distance zero: `value === now` falls in the first rung, whose phrase is
  // directionless (Criterion 1.2, last sentence).
  it('renders `just now` at distance 0', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now')
  })

  // The top of the rung. 59 999 ms is one millisecond below the 1-minute
  // boundary, in both directions -- the range is half-open.
  it('renders `just now` at 59 999 ms in both directions', () => {
    expect(ago(59_999)).toBe('just now')
    expect(ahead(59_999)).toBe('just now')
  })

  // Criterion 1.4 in the negative: a zero magnitude is never emitted. The
  // floored magnitude of the minute rung cannot be 0 because that rung's
  // lower bound is exactly one minute, so these phrases are unreachable
  // rather than merely unlikely.
  it('never emits a zero-magnitude phrase near the boundary', () => {
    for (const distance of [0, 1, 59_999, MS_PER_MINUTE, MS_PER_MINUTE + 1]) {
      expect(ago(distance)).not.toContain('0 minute')
      expect(ahead(distance)).not.toContain('0 minute')
    }
  })

  // The boundary itself belongs to the NEXT rung, since every range is
  // half-open and closed at the bottom (Criterion 1.3).
  it('leaves `just now` at exactly one minute', () => {
    expect(ago(MS_PER_MINUTE)).toBe('1 minute ago')
    expect(ahead(MS_PER_MINUTE)).toBe('in 1 minute')
  })
})

describe('the singular/plural pivot in all five magnitude-bearing units (Criterion 1.7)', () => {
  // One row per unit: the unit's own length is magnitude 1 and singular,
  // twice it is magnitude 2 and plural. Both directions, every unit --
  // Criterion 1.7 is explicit that it holds in each.
  const UNITS = [
    { name: 'minute', unitMs: MS_PER_MINUTE, singular: 'minute', plural: 'minutes' },
    { name: 'hour', unitMs: MS_PER_HOUR, singular: 'hour', plural: 'hours' },
    { name: 'day', unitMs: MS_PER_DAY, singular: 'day', plural: 'days' },
    { name: 'month', unitMs: NOMINAL_MONTH_MS, singular: 'month', plural: 'months' },
    { name: 'year', unitMs: NOMINAL_YEAR_MS, singular: 'year', plural: 'years' }
  ]

  for (const { name, unitMs, singular, plural } of UNITS) {
    it(`singularises one ${name} and pluralises two, in both directions`, () => {
      expect(ago(unitMs)).toBe(`1 ${singular} ago`)
      expect(ahead(unitMs)).toBe(`in 1 ${singular}`)

      expect(ago(2 * unitMs)).toBe(`2 ${plural} ago`)
      expect(ahead(2 * unitMs)).toBe(`in 2 ${plural}`)
    })

    // The pivot is at the MAGNITUDE, not at the distance: anything that
    // floors to 1 is singular, right up to one millisecond below 2 units.
    it(`keeps the singular for ${name} magnitudes that floor to 1`, () => {
      expect(ago(2 * unitMs - 1)).toBe(`1 ${singular} ago`)
      expect(ahead(2 * unitMs - 1)).toBe(`in 1 ${singular}`)
    })
  }

  // Flooring, not rounding (Criterion 1.6): 1 hour 59 minutes reads
  // `1 hour ago`, so the phrase never claims more elapsed time than has
  // elapsed. Included here because it is the same magnitude arithmetic the
  // pivot turns on.
  it('floors rather than rounding, so 1 h 59 m reads `1 hour ago`', () => {
    expect(ago(MS_PER_HOUR + 59 * MS_PER_MINUTE)).toBe('1 hour ago')
    expect(ahead(MS_PER_HOUR + 59 * MS_PER_MINUTE)).toBe('in 1 hour')
  })
})

describe('the 365/30 artifact: `12 months ago` is reachable (Criterion 1.5)', () => {
  // 365 / 30 = 12.17, so the month rung's TOP magnitude is 12, not 11. One
  // millisecond below the year boundary floors to 12, which means
  // `12 months` and `1 year` are adjacent phrases. This looks like an
  // off-by-one and is not one; Criterion 1.5 accepts it as a consequence of
  // the nominal units.
  it('renders `12 months ago` one millisecond below the year boundary', () => {
    expect(ago(NOMINAL_YEAR_MS - 1)).toBe('12 months ago')
    expect(ahead(NOMINAL_YEAR_MS - 1)).toBe('in 12 months')
  })

  it('steps straight from 12 months to 1 year at the boundary', () => {
    expect(ago(NOMINAL_YEAR_MS)).toBe('1 year ago')
    expect(ahead(NOMINAL_YEAR_MS)).toBe('in 1 year')
  })

  // The month magnitude is NOT clamped to 11. Stated as its own assertion so
  // a later "correction" that clamps it fails here with the reason attached.
  it('does not clamp the month magnitude to 11', () => {
    expect(ago(12 * NOMINAL_MONTH_MS)).toBe('12 months ago')
    expect(ago(NOMINAL_YEAR_MS - 1)).not.toBe('11 months ago')
  })

  // The other accepted artifact of the same criterion: 31 days reads
  // `1 month ago` regardless of how long the calendar month it spans is.
  it('reads 31 days as `1 month ago`', () => {
    expect(ago(31 * MS_PER_DAY)).toBe('1 month ago')
  })
})

describe('NO_PHRASE is a distinct value, not an empty string (Criterion 1.9)', () => {
  // The point of the criterion: a caller must be able to tell "there is
  // nothing to say about this value" apart from "the phrase happened to be
  // empty", so Criterion 2.7's suppression of the whole tooltip is driven by
  // a VALUE rather than by a string test.
  it('is not the empty string and not any string at all', () => {
    expect(NO_PHRASE).not.toBe('')
    expect(typeof NO_PHRASE).not.toBe('string')
    expect(NO_PHRASE).toBeNull()
  })

  // IDENTITY, not truthiness and not `toBeFalsy`. `Object.is` here so the
  // assertion cannot be satisfied by any other falsy value a future edit
  // might return in its place.
  it('is returned by IDENTITY for input that is not an instant', () => {
    for (const value of [
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      '',
      '   ',
      'not a date',
      true,
      {},
      []
    ]) {
      expect(Object.is(relativeTime(value, NOW), NO_PHRASE)).toBe(true)
    }
  })

  it('is returned by IDENTITY when `now` itself is unusable', () => {
    for (const badNow of [null, NaN, 'not a date', '', {}]) {
      expect(Object.is(relativeTime(NOW, badNow), NO_PHRASE)).toBe(true)
    }
  })

  // The complement: a usable pair produces a NON-EMPTY string, so the
  // distinction above is a real one rather than vacuous.
  it('returns a non-empty string for a usable pair', () => {
    const phrase = ago(MS_PER_HOUR)

    expect(typeof phrase).toBe('string')
    expect(phrase.length).toBeGreaterThan(0)
    expect(Object.is(phrase, NO_PHRASE)).toBe(false)
  })
})

describe('an omitted `now` yields NO_PHRASE rather than a clock read (Criterion 1.1)', () => {
  // `now` is a REQUIRED parameter with no `Date.now()` default. A caller who
  // forgets it gets `undefined`, which is not a usable instant, so the
  // mistake surfaces as a MISSING TOOLTIP rather than as a plausible phrase
  // computed from the wrong moment.
  it('returns NO_PHRASE when called with one argument', () => {
    expect(Object.is(relativeTime(NOW), NO_PHRASE)).toBe(true)
    expect(Object.is(relativeTime(new Date(NOW)), NO_PHRASE)).toBe(true)
    expect(Object.is(relativeTime('2026-06-01T00:00:00Z'), NO_PHRASE)).toBe(true)
  })

  // The same value with the clock supplied DOES produce a phrase, so the
  // assertion above is about the missing argument and not about the value.
  it('produces a phrase for the same value once `now` is supplied', () => {
    expect(relativeTime(NOW - MS_PER_HOUR, NOW)).toBe('1 hour ago')
  })

  // The classifier reads no clock at all: the same arguments give the same
  // answer, and an instant far from the real present is placed by arithmetic
  // against the SUPPLIED `now` rather than against today.
  it('does not read the clock, so the result depends only on its arguments', () => {
    const past = Date.parse('1999-12-31T00:00:00Z')

    expect(relativeTime(past, past + MS_PER_DAY)).toBe('1 day ago')
    expect(relativeTime(past, past + MS_PER_DAY)).toBe(relativeTime(past, past + MS_PER_DAY))
  })
})

describe('no locale-aware relative-time formatter in the module source (Criterion 1.10)', () => {
  // Every phrase is assembled from English string literals held in the
  // repository. The structural check is one line because that is all it
  // needs to be: the forbidden API cannot be used without being named.
  //
  // `relativeTime.js` deliberately avoids naming it even in the comment
  // explaining why it is unused, so this assertion passes for the right
  // reason. Naming it HERE is fine -- this file is the scanner, not the
  // file being scanned.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'relativeTime.js'),
    'utf8'
  )

  it('contains no reference to Intl.RelativeTimeFormat', () => {
    expect(source).not.toContain('RelativeTimeFormat')
  })
})
