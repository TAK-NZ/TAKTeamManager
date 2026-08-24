import { describe, it, expect, afterEach } from 'vitest'
import fc from 'fast-check'
import {
  formatDate,
  formatDateTime,
  setDisplayTimezone,
  getDisplayTimezone,
  DEFAULT_DISPLAY_TIMEZONE
} from './dateFormat.js'

// Feature: device-management, Property 15: Date rendering is total, correctly zoned, and format-invariant
//
// Validates: Requirements 18.2, 18.3, 18.8, 18.10, 18.14
//
// *For all* instants (pre-epoch through far future, and instants within an
// hour either side of midnight in the target zone) and *for all* installed
// zone values (real IANA names including half-hour and 45-minute offsets,
// plus arbitrary strings, the empty string and `undefined`):
//
//   * `formatDate` returns exactly `yyyy-mm-dd` and `formatDateTime` exactly
//     `yyyy-mm-dd HH:MM` on a 24-hour clock, every component zero-padded;
//   * those components equal the instant's wall clock in the zone the
//     Display_Timezone_Fallback_Chain actually resolved to;
//   * neither function raises for any input, so no installed zone value can
//     blank out or crash a rendered date;
//   * null, undefined and unparseable input still return the caller's
//     `fallback` unchanged.
//
// ## The model
//
// The expected value is NOT produced by calling back into `dateFormat.js`,
// and not by a second `formatToParts`-of-components formatter either -- that
// would be the same computation twice and would agree with the code under
// test even if both were wrong. Instead the model reads only the zone's UTC
// OFFSET at that instant (`timeZoneName: 'longOffset'`, e.g. `GMT+12:45`),
// shifts the instant by it, and reads the components with `getUTC*` getters.
// Those getters are locale-independent and calendar-exact, so the model
// shares nothing with the implementation except the fact that both consult
// the IANA database for the same zone.
//
// The shape assertion is an anchored, fully numeric regex with the hour
// bounded to `00`-`23`, so a locale rendering (`3/12/2026`) and an `h24`
// cycle (`24:00`) both fail rather than slipping through a looser match.

/** Requirement 18.3's two shapes, anchored at both ends. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME_SHAPE = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/

/**
 * Real zones chosen for their awkwardness (design.md, Testing Strategy):
 * the southern-hemisphere DST default, a 45-minute offset, a half-hour
 * offset, the UTC-7/-8 zone the reported defect was measured on, and the
 * one zone every runtime must accept.
 */
const REAL_ZONES = [
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Asia/Kolkata',
  'America/Los_Angeles',
  'UTC'
]

const MS_PER_DAY = 86_400_000

/**
 * The instant range: 1950 (pre-epoch) through 2286 (far future). Bounded
 * below 1950 deliberately -- earlier instants reach the zones' pre-standard
 * local-mean-time offsets, which are a property of the IANA database rather
 * than of this module.
 */
const MIN_INSTANT_MS = Date.UTC(1950, 0, 1)
const MAX_INSTANT_MS = Date.UTC(2286, 10, 20)

/** Offset formatters, built once per zone -- the model, not the subject. */
const offsetFormatters = new Map()

/**
 * The zone's UTC offset in milliseconds at `epochMs`, read from the zone's
 * own `longOffset` name (`GMT+12:45`, `GMT-07:00`, or bare `GMT` for zero).
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
 * The instant's wall clock in `zone`, as zero-padded component strings --
 * computed by shifting the instant by the zone's offset and reading `getUTC*`
 * getters, so nothing locale-aware and nothing from `dateFormat.js` is
 * involved.
 *
 * @param {string} zone
 * @param {number} epochMs
 * @returns {{date: string, dateTime: string}} the two expected renderings.
 */
function modelWallClock(zone, epochMs) {
  const shifted = new Date(epochMs + modelOffsetMs(zone, epochMs))
  const year = String(shifted.getUTCFullYear()).padStart(4, '0')
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  const hour = String(shifted.getUTCHours()).padStart(2, '0')
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0')
  const date = `${year}-${month}-${day}`
  return { date, dateTime: `${date} ${hour}:${minute}` }
}

/**
 * The instant of local midnight in `zone` on the day containing `epochMs`.
 * Used to aim the generator at the day boundary, which is where a
 * browser-local getter and a zoned one disagree about the calendar DAY --
 * the exact shape of the reported defect.
 *
 * @param {string} zone
 * @param {number} epochMs
 * @returns {number}
 */
function localMidnightMs(zone, epochMs) {
  const offset = modelOffsetMs(zone, epochMs)
  const localMs = epochMs + offset
  return Math.floor(localMs / MS_PER_DAY) * MS_PER_DAY - offset
}

/**
 * Instants for one zone: a broad arm across the whole range, and an arm
 * concentrated within an hour either side of local midnight in that zone.
 *
 * @param {string} zone the zone the near-midnight arm is aimed at.
 * @returns {fc.Arbitrary<number>}
 */
function instantArbitrary(zone) {
  const broad = fc.integer({ min: MIN_INSTANT_MS, max: MAX_INSTANT_MS })
  const nearMidnight = fc
    .tuple(broad, fc.integer({ min: -3_600_000, max: 3_600_000 }))
    .map(([anchor, jitter]) => localMidnightMs(zone, anchor) + jitter)
  return fc.oneof(
    broad,
    nearMidnight,
    // The measured instant itself, and the epoch, kept reachable by the
    // generator rather than only by the example tests.
    fc.constantFrom(Date.parse('2026-03-12T00:58:04.508Z'), 0, -1, MIN_INSTANT_MS, MAX_INSTANT_MS)
  )
}

/**
 * Whether the runtime accepts `value` as a zone name -- asked on the model
 * side only, to keep the two arms of the zone generator disjoint.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isRecognisedZone(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() })
    return true
  } catch {
    return false
  }
}

/**
 * The runtime's canonical spelling of a zone name.
 *
 * This exists because a zone name and the zone itself are not the same
 * thing: `Asia/Kolkata` is an IANA LINK to `Asia/Calcutta`, and this
 * runtime's `resolvedOptions().timeZone` reports the link TARGET. So
 * `getDisplayTimezone()` legitimately answers `Asia/Calcutta` for a
 * configured `Asia/Kolkata` -- the same zone, the same offsets, the other
 * spelling. The property therefore asserts the chain resolved to the zone
 * that was installed, not to the string that was installed.
 *
 * @param {string} zone a zone name the runtime recognises.
 * @returns {string}
 */
function canonicalZone(zone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone || zone
}

/**
 * The two arms of the zone space. Arm one installs a real IANA name; arm two
 * installs a value the runtime will not recognise -- an arbitrary string, the
 * empty string, whitespace, `undefined`, or a non-string -- which
 * Requirement 18.8 says must cost the app its configured zone and nothing
 * else.
 *
 * `resolvesTo` is what the Display_Timezone_Fallback_Chain is expected to
 * settle on, and is also the zone the model is asked about: for arm one the
 * installed zone in its canonical spelling, for arm two `Pacific/Auckland`.
 */
const zoneArbitrary = fc.oneof(
  fc
    .constantFrom(...REAL_ZONES)
    .map((zone) => ({ installed: zone, resolvesTo: canonicalZone(zone) })),
  fc
    .oneof(
      fc.string(),
      fc.constantFrom('', '   ', 'Pacific/Aukland', 'Not/AZone', 'GMT+13', '13', undefined, null, 42)
    )
    // Arm two is specifically the values the runtime does NOT recognise. A
    // random string that happens to name a real zone (`utc` -- zone names are
    // matched case-insensitively) would resolve to itself, not to the
    // default, so it is excluded here rather than allowed to flake.
    .filter((value) => !isRecognisedZone(value))
    .map((value) => ({ installed: value, resolvesTo: DEFAULT_DISPLAY_TIMEZONE }))
)

/** Values that are not instants at all -- Requirement 18.10's input space. */
const nonInstantArbitrary = fc.oneof(
  fc.constantFrom(null, undefined, '', '   ', 'not-a-date', '2024-13-45', 'NaN'),
  fc.constant(new Date('nope'))
)

afterEach(() => {
  setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
})

describe('Property 15: date rendering is total, correctly zoned, and format-invariant', () => {
  it('renders every instant in the resolved zone, in exactly the required shape, for every installed zone value', () => {
    fc.assert(
      fc.property(
        zoneArbitrary.chain((zone) =>
          fc.tuple(
            fc.constant(zone),
            instantArbitrary(zone.resolvesTo),
            nonInstantArbitrary,
            fc.string()
          )
        ),
        ([zone, epochMs, nonInstant, fallback]) => {
          setDisplayTimezone(zone.installed)

          // Requirement 18.8: the chain settles on the installed zone when
          // the runtime knows it, and on Pacific/Auckland when it does not.
          expect(getDisplayTimezone()).toBe(zone.resolvesTo)

          const expected = modelWallClock(zone.resolvesTo, epochMs)

          // Requirement 18.8's never-raise obligation, asserted for both the
          // string and the Date input shapes a caller can hand over.
          let renderedDate
          let renderedDateTime
          let renderedFromDate
          expect(() => {
            renderedDate = formatDate(new Date(epochMs).toISOString(), fallback)
            renderedDateTime = formatDateTime(new Date(epochMs).toISOString(), fallback)
            renderedFromDate = formatDateTime(new Date(epochMs), fallback)
          }).not.toThrow()

          // Requirement 18.3: the exact shapes, checked before the values, so
          // a locale rendering or an h24 midnight fails on its own terms.
          expect(renderedDate).toMatch(DATE_SHAPE)
          expect(renderedDateTime).toMatch(DATE_TIME_SHAPE)

          // Requirement 18.2: the components are that instant's wall clock in
          // the resolved zone, per the independent model.
          expect(renderedDate).toBe(expected.date)
          expect(renderedDateTime).toBe(expected.dateTime)
          expect(renderedFromDate).toBe(expected.dateTime)

          // A parseable instant never yields the caller's fallback, however
          // unusable the installed zone was (Requirement 18.8).
          expect(renderedDateTime.startsWith(renderedDate)).toBe(true)

          // Requirement 18.10: an unparseable input still returns the
          // caller's fallback, unchanged and unformatted.
          expect(formatDate(nonInstant, fallback)).toBe(fallback)
          expect(formatDateTime(nonInstant, fallback)).toBe(fallback)
          expect(formatDate(nonInstant)).toBe('')
          expect(formatDateTime(nonInstant)).toBe('')

          return true
        }
      ),
      { numRuns: 500 }
    )
  })
})
