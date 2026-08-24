import { describe, it, expect, afterEach } from 'vitest'
import fc from 'fast-check'
import { zonedDayNumber, setDisplayTimezone, DEFAULT_DISPLAY_TIMEZONE } from './dateFormat.js'

// Feature: date-tooltips-and-folder-contrast, Property 3: The Midnight_Anchor is a whole number of days, taken in the display timezone and independent of time of day
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.6
//
// *For all* instants (pre-epoch through far future, concentrated within an
// hour of midnight in the installed zone) and *for all* installed zones drawn
// from the fixed awkward set — `Pacific/Auckland`, `Pacific/Chatham` (+12:45),
// `Asia/Kolkata` (+05:30), `America/Los_Angeles` and `UTC` —
// `zonedDayNumber`:
//
//   * returns an integer or `null`, never a fraction and never a NaN;
//   * returns the SAME integer for two instants sharing a calendar day in the
//     installed zone, whatever their times of day, and a DIFFERENT integer
//     for two instants on different days (Criteria 4.1, 4.3);
//   * returns integers differing by exactly 1 for adjacent calendar days, so
//     a caller differencing two of them gets a whole number of days
//     (Criterion 4.2);
//   * agrees with the installed zone's calendar day rather than the browser's
//     local one — asserted wherever the two disagree, which is what the
//     near-midnight arm of the generator manufactures (Criterion 4.6).
//
// ## The model
//
// The expected calendar day is NOT read with a second components formatter of
// the same shape `readWallClock` already uses — that would be the same
// computation twice and would agree with the subject even if both were wrong.
// It comes instead from an independently constructed `Intl.DateTimeFormat`
// asked only for the zone's UTC OFFSET at that instant
// (`timeZoneName: 'longOffset'`, e.g. `GMT+12:45`); the instant is shifted by
// that offset and its components read with locale-independent `getUTC*`
// getters. This is the model `dateFormat.property.test.js` already established
// for the same module.
//
// The ordinal arithmetic itself is never reimplemented here: no expected day
// number is ever computed. The returned ordinal is only ever DECODED — days
// since 1970-01-01 read back as `new Date(n * MS_PER_DAY)` — and the calendar
// triple it denotes compared with the model's. Everything else is a relation
// between two returned values (equal, or differing by one), which needs no
// model arithmetic at all.

/**
 * Real zones chosen for their awkwardness (design.md, Property 3): the
 * southern-hemisphere DST default, a 45-minute offset, a half-hour offset,
 * the UTC-7/-8 zone the original zoning defect was measured on, and the one
 * zone every runtime must accept.
 */
const REAL_ZONES = [
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Asia/Kolkata',
  'America/Los_Angeles',
  'UTC'
]

const MS_PER_DAY = 86_400_000
const MS_PER_HOUR = 3_600_000

/**
 * The instant range: 1950 (pre-epoch) through 2286 (far future), matching the
 * range the existing `dateFormat` property test covers. Bounded below 1950
 * deliberately — earlier instants reach the zones' pre-standard local-mean-time
 * offsets, which are a property of the IANA database rather than of this
 * module.
 */
const MIN_INSTANT_MS = Date.UTC(1950, 0, 1)
const MAX_INSTANT_MS = Date.UTC(2286, 10, 20)

/** Offset formatters, built once per zone — the model, not the subject. */
const offsetFormatters = new Map()

/**
 * The zone's UTC offset in milliseconds at `epochMs`, read from the zone's own
 * `longOffset` name (`GMT+12:45`, `GMT-07:00`, or bare `GMT` for zero).
 * Seconds are parsed too, because historical offsets can carry them.
 *
 * @param {string} zone an IANA zone name the runtime recognises.
 * @param {number} epochMs
 * @returns {number} offset in ms, east of UTC positive.
 */
function modelOffsetMs(zone, epochMs) {
  let formatter = offsetFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    offsetFormatters.set(zone, formatter)
  }
  const name = formatter
    .formatToParts(new Date(epochMs))
    .find((part) => part.type === 'timeZoneName')?.value
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?)?$/.exec(name ?? '')
  if (!match) {
    throw new Error(`the model could not read an offset for ${zone}: ${String(name)}`)
  }
  if (!match[1]) {
    return 0
  }
  const sign = match[1] === '-' ? -1 : 1
  const hours = Number(match[2])
  const minutes = Number(match[3] ?? 0)
  const seconds = Number(match[4] ?? 0)
  return sign * ((hours * 60 + minutes) * 60 + seconds) * 1000
}

/**
 * The calendar day `epochMs` falls on in `zone`, as a plain triple — the
 * model's answer, computed by offset shift and `getUTC*` getters.
 *
 * @param {string} zone
 * @param {number} epochMs
 * @returns {{year: number, month: number, day: number}}
 */
function modelZonedTriple(zone, epochMs) {
  const shifted = new Date(epochMs + modelOffsetMs(zone, epochMs))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  }
}

/**
 * The calendar day `epochMs` falls on in the BROWSER's zone, so Criterion 4.6
 * can be asserted where the two readings disagree.
 *
 * @param {number} epochMs
 * @returns {{year: number, month: number, day: number}}
 */
function localTriple(epochMs) {
  const date = new Date(epochMs)
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() }
}

/**
 * The calendar day a returned ordinal DENOTES: days since 1970-01-01, read
 * back as an instant and decoded with `getUTC*`. The inverse direction only —
 * the forward mapping the subject performs is never repeated here.
 *
 * @param {number} dayNumber
 * @returns {{year: number, month: number, day: number}}
 */
function decodeDayNumber(dayNumber) {
  const midnight = new Date(dayNumber * MS_PER_DAY)
  return {
    year: midnight.getUTCFullYear(),
    month: midnight.getUTCMonth() + 1,
    day: midnight.getUTCDate()
  }
}

/**
 * The calendar day after `triple`, by calendar succession rather than by any
 * ordinal: a UTC date is stepped one `setUTCDate` forward and read back, so
 * month lengths and leap years come from the engine's calendar.
 *
 * @param {{year: number, month: number, day: number}} triple
 * @returns {{year: number, month: number, day: number}}
 */
function nextCalendarDay(triple) {
  const date = new Date(0)
  date.setUTCFullYear(triple.year, triple.month - 1, triple.day)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + 1)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  }
}

/**
 * @param {{year: number, month: number, day: number}} a
 * @param {{year: number, month: number, day: number}} b
 * @returns {boolean}
 */
function sameDay(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day
}

/**
 * The instant of local midnight in `zone` on the day containing `epochMs`.
 * Used only to AIM the generator at the day boundary, which is where a
 * browser-local reading and a zoned one disagree about the calendar DAY — the
 * shape of the defect device-management Requirement 18 fixed.
 *
 * @param {string} zone
 * @param {number} epochMs
 * @returns {number}
 */
function localMidnightMs(zone, epochMs) {
  const offset = modelOffsetMs(zone, epochMs)
  return Math.floor((epochMs + offset) / MS_PER_DAY) * MS_PER_DAY - offset
}

/**
 * Instants for one zone: a broad arm across the whole range, an arm
 * concentrated within an hour either side of midnight in that zone, and the
 * measured instant plus the epoch kept reachable by the generator.
 *
 * @param {string} zone the zone the near-midnight arm is aimed at.
 * @returns {fc.Arbitrary<number>}
 */
function instantArbitrary(zone) {
  const broad = fc.integer({ min: MIN_INSTANT_MS, max: MAX_INSTANT_MS })
  const nearMidnight = fc
    .tuple(broad, fc.integer({ min: -MS_PER_HOUR, max: MS_PER_HOUR }))
    .map(([anchor, jitter]) => localMidnightMs(zone, anchor) + jitter)
  return fc.oneof(
    nearMidnight,
    nearMidnight,
    broad,
    fc.constantFrom(Date.parse('2026-03-12T00:58:04.508Z'), 0, -1, MIN_INSTANT_MS, MAX_INSTANT_MS)
  )
}

/**
 * How far the second instant of a pair sits from the first. The arms aim at
 * the three relations the property asserts: a different time of day WITHIN the
 * same zoned day, a step across one midnight into the adjacent day, and a
 * broad arm that lands anywhere.
 */
const deltaArbitrary = fc.oneof(
  fc.integer({ min: 0, max: 22 * MS_PER_HOUR }),
  fc.integer({ min: -26 * MS_PER_HOUR, max: 26 * MS_PER_HOUR }),
  fc.integer({ min: -MS_PER_HOUR, max: MS_PER_HOUR }),
  fc.constantFrom(0, 1, -1, MS_PER_DAY, -MS_PER_DAY)
)

/**
 * Values that are not instants at all. Requirement 4's null outcome: no
 * calendar day, therefore no anchor, therefore nothing for a tooltip to say.
 *
 * Symbols, BigInts and hostile `valueOf` objects are deliberately absent:
 * `zonedDayNumber` inherits the module-private `toDate`'s behaviour for values
 * `new Date(...)` itself throws on, exactly as `formatDate` does today, and
 * changing that would mean changing `toDate` — which Criterion 2.13 puts out
 * of scope.
 */
const nonInstantArbitrary = fc.oneof(
  fc.constantFrom(null, undefined, '', '   ', 'not-a-date', '2024-13-45', 'NaN', NaN),
  fc.constant(new Date('nope'))
)

/** One run's worth of inputs: a zone, two instants in it, and a non-instant. */
const scenarioArbitrary = fc.constantFrom(...REAL_ZONES).chain((zone) =>
  fc.record({
    zone: fc.constant(zone),
    instant: instantArbitrary(zone),
    delta: deltaArbitrary,
    nonInstant: nonInstantArbitrary
  })
)

afterEach(() => {
  setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
})

describe('Property 3: the Midnight_Anchor is a whole number of days in the display timezone', () => {
  it('returns the zone\'s calendar day as an integer, invariant to time of day and one apart on adjacent days', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ zone, instant, delta, nonInstant }) => {
        setDisplayTimezone(zone)

        const other = instant + delta
        const first = zonedDayNumber(new Date(instant).toISOString())
        const second = zonedDayNumber(new Date(other))

        // A whole number of days or nothing — never a fraction, never NaN.
        for (const dayNumber of [first, second]) {
          expect(dayNumber === null || Number.isInteger(dayNumber)).toBe(true)
        }
        // Every instant the generator produces is parseable and inside the
        // range the zones have standard offsets for, so both are integers.
        expect(Number.isInteger(first)).toBe(true)
        expect(Number.isInteger(second)).toBe(true)

        const modelFirst = modelZonedTriple(zone, instant)
        const modelSecond = modelZonedTriple(zone, other)

        // Criterion 4.1: the ordinal denotes the calendar day the instant
        // falls on in the installed zone, per the independent model.
        expect(decodeDayNumber(first)).toEqual(modelFirst)
        expect(decodeDayNumber(second)).toEqual(modelSecond)

        // Criterion 4.6: the zone's calendar day, NOT the browser's. Asserted
        // wherever the two disagree — which the near-midnight arm manufactures.
        const localFirst = localTriple(instant)
        if (!sameDay(modelFirst, localFirst)) {
          expect(decodeDayNumber(first)).not.toEqual(localFirst)
        }

        // Criteria 4.1, 4.3: the same day gives the same integer whatever the
        // time of day, and a different day gives a different one.
        if (sameDay(modelFirst, modelSecond)) {
          expect(second).toBe(first)
        } else {
          expect(second).not.toBe(first)
        }

        // Criterion 4.2: adjacent calendar days are exactly one apart, so a
        // caller differencing two anchors gets a whole number of days.
        if (sameDay(nextCalendarDay(modelFirst), modelSecond)) {
          expect(second - first).toBe(1)
        }
        if (sameDay(nextCalendarDay(modelSecond), modelFirst)) {
          expect(first - second).toBe(1)
        }

        // No calendar day at all: null, and never a throw.
        let nullResult
        expect(() => {
          nullResult = zonedDayNumber(nonInstant)
        }).not.toThrow()
        expect(nullResult).toBe(null)

        return true
      }),
      { numRuns: 300 }
    )
  })
})
