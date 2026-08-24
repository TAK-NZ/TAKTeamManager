import { describe, it, expect, afterEach } from 'vitest'
import {
  formatDate,
  formatDateTime,
  setDisplayTimezone,
  getDisplayTimezone,
  DEFAULT_DISPLAY_TIMEZONE,
  zonedDayNumber,
  hasRenderableDate
} from './dateFormat'

// These helpers render in the configured display timezone, which defaults to
// `Pacific/Auckland` (Requirements 18.2, 18.7) -- not in the machine's local
// zone. The expectations below are therefore that instant's Auckland wall
// clock (+13, NZDT, in March 2024), and are independent of the `TZ` the suite
// happens to run under.
//
// Validates: Requirements 18.2, 18.3, 18.8, 18.9, 18.10
//
// The display timezone is module state, so every block below that installs a
// zone is followed by the reset in this `afterEach` -- otherwise a zone
// installed by one test would decide the wall clock a later test asserts.
afterEach(() => {
  setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
})

/**
 * The exact shapes Requirement 18.3 pins down. Anchored at both ends and
 * fully numeric, so a locale rendering (`3/12/2026`, `12/03/2026`,
 * `2026-03-12, 13:58`) fails, and with the hour bounded to `00`-`23` so an
 * `h24` cycle rendering midnight as `24:00` fails too.
 */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME_SHAPE = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/

describe('formatDate', () => {
  it('formats an ISO timestamp as yyyy-mm-dd', () => {
    expect(formatDate('2024-03-05T14:30:00.000Z')).toBe('2024-03-06')
  })

  it('pads single-digit month/day with a leading zero', () => {
    expect(formatDate('2024-01-02T00:00:00.000Z')).toBe('2024-01-02')
  })

  it('returns the fallback for null/undefined', () => {
    expect(formatDate(null, 'Never')).toBe('Never')
    expect(formatDate(undefined, 'Never')).toBe('Never')
  })

  it('returns an empty string fallback by default', () => {
    expect(formatDate(null)).toBe('')
  })

  it('returns the fallback for an unparseable value', () => {
    expect(formatDate('not-a-date', 'Never')).toBe('Never')
  })
})

describe('formatDateTime', () => {
  it('formats an ISO timestamp as yyyy-mm-dd HH:MM (24-hour)', () => {
    expect(formatDateTime('2024-03-05T14:30:00.000Z')).toBe('2024-03-06 03:30')
  })

  it('pads single-digit hour/minute with a leading zero', () => {
    // 12:05Z is 01:05 the next day in Auckland (+13), so this still
    // exercises a single-digit hour as the test name says.
    expect(formatDateTime('2024-03-04T12:05:00.000Z')).toBe('2024-03-05 01:05')
  })

  it('returns the fallback for null/undefined', () => {
    expect(formatDateTime(null, 'Never')).toBe('Never')
  })
})
describe('the measured defect, pinned as a regression test (Requirement 18.2)', () => {
  // The instant TAK Server actually reported for a Device, and the two
  // renderings the requirement names: the operator's own wall clock, and the
  // UTC-7 browser rendering that was observed instead -- seven hours and a
  // calendar DAY away from it. Both are asserted, because the pair is what
  // makes the defect a defect: the same instant, two different days.
  const REPORTED_INSTANT = '2026-03-12T00:58:04.508Z'

  it('renders the reported instant in the operator zone, not the browser zone', () => {
    setDisplayTimezone('Pacific/Auckland')
    expect(formatDateTime(REPORTED_INSTANT)).toBe('2026-03-12 13:58')
    expect(formatDate(REPORTED_INSTANT)).toBe('2026-03-12')
  })

  it('renders the same instant a calendar day earlier in America/Los_Angeles', () => {
    setDisplayTimezone('America/Los_Angeles')
    expect(formatDateTime(REPORTED_INSTANT)).toBe('2026-03-11 17:58')
    expect(formatDate(REPORTED_INSTANT)).toBe('2026-03-11')
  })

  it('renders it in Pacific/Auckland when nothing has been installed at all', () => {
    // Requirement 18.7: a client that never received the public config
    // behaves exactly like one that received the default.
    expect(getDisplayTimezone()).toBe(DEFAULT_DISPLAY_TIMEZONE)
    expect(formatDateTime(REPORTED_INSTANT)).toBe('2026-03-12 13:58')
  })

  it('renders it in a half-hour and a 45-minute offset zone', () => {
    // Zones whose offset is not a whole number of hours are where an
    // implementation that shifted by hours would silently be wrong.
    setDisplayTimezone('Asia/Kolkata')
    expect(formatDateTime(REPORTED_INSTANT)).toBe('2026-03-12 06:28')
    setDisplayTimezone('Pacific/Chatham')
    expect(formatDateTime(REPORTED_INSTANT)).toBe('2026-03-12 14:43')
  })
})

describe('the emitted format is exactly yyyy-mm-dd / yyyy-mm-dd HH:MM (Requirement 18.3)', () => {
  it('emits the anchored numeric shapes, not a locale rendering', () => {
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
      setDisplayTimezone(zone)
      expect(formatDate('2026-03-12T00:58:04.508Z')).toMatch(DATE_SHAPE)
      expect(formatDateTime('2026-03-12T00:58:04.508Z')).toMatch(DATE_TIME_SHAPE)
    }
  })

  it('renders midnight in the display zone as 00:00 and never 24:00', () => {
    // 11:00Z on 2026-03-11 is exactly 00:00 on 2026-03-12 in Auckland
    // (+13, NZDT). `hourCycle: 'h24'` would render this as `24:00` against
    // the PREVIOUS day -- both the hour and the date would be wrong.
    setDisplayTimezone('Pacific/Auckland')
    expect(formatDateTime('2026-03-11T11:00:00.000Z')).toBe('2026-03-12 00:00')
    expect(formatDate('2026-03-11T11:00:00.000Z')).toBe('2026-03-12')

    // And in a zone where midnight is not an offset artefact.
    setDisplayTimezone('UTC')
    expect(formatDateTime('2026-03-12T00:00:00.000Z')).toBe('2026-03-12 00:00')
  })

  it('zero-pads every component, including a single-digit month, day and hour', () => {
    setDisplayTimezone('UTC')
    expect(formatDate('2026-01-02T03:04:00.000Z')).toBe('2026-01-02')
    expect(formatDateTime('2026-01-02T03:04:00.000Z')).toBe('2026-01-02 03:04')
  })

  it('renders 23:59 as 23:59, the other end of the h23 range', () => {
    setDisplayTimezone('UTC')
    expect(formatDateTime('2026-12-31T23:59:59.999Z')).toBe('2026-12-31 23:59')
  })

  it('keeps the shape across a daylight-saving transition in the display zone', () => {
    // NZDT ends at 03:00 NZDT on 2026-04-05, i.e. 14:00Z on 2026-04-04:
    // +13 before, +12 after. Both sides still render the same shape, and
    // the wall clock moves back an hour rather than forward.
    setDisplayTimezone('Pacific/Auckland')
    expect(formatDateTime('2026-04-04T13:30:00.000Z')).toBe('2026-04-05 02:30')
    expect(formatDateTime('2026-04-04T14:30:00.000Z')).toBe('2026-04-05 02:30')
  })
})

describe('the fallback semantics are unchanged (Requirement 18.10)', () => {
  it("returns the caller's fallback for null, undefined and unparseable input", () => {
    setDisplayTimezone('Asia/Kolkata')
    for (const value of [null, undefined, 'not-a-date', '', new Date('nope'), NaN]) {
      expect(formatDate(value, 'Never')).toBe('Never')
      expect(formatDateTime(value, 'Never')).toBe('Never')
    }
  })

  it('defaults that fallback to the empty string', () => {
    expect(formatDate(null)).toBe('')
    expect(formatDateTime(null)).toBe('')
    expect(formatDateTime('not-a-date')).toBe('')
  })

  it('returns the fallback verbatim rather than a formatted date', () => {
    // The audit log passes the raw ISO string as its own fallback, so the
    // value has to come back untouched.
    const raw = '2026-03-12T00:58:04.508Z'
    expect(formatDateTime(null, raw)).toBe(raw)
  })
})

describe('an unrecognised display timezone (Requirement 18.8)', () => {
  // `getDisplayTimezone()` reports the zone the fallback chain settled on,
  // which is what makes these assertions possible without reaching into the
  // module's internals.
  const UNUSABLE_ZONES = [
    'Pacific/Aukland',      // the plausible typo the requirement names
    'Not/AZone',
    'xyzzy',
    '   ',
    'Pacific/Auckland; DROP TABLE',
    '13'
  ]

  it('falls back down the chain to Pacific/Auckland and still renders', () => {
    for (const zone of UNUSABLE_ZONES) {
      setDisplayTimezone(zone)
      expect(getDisplayTimezone()).toBe(DEFAULT_DISPLAY_TIMEZONE)
      // A mistyped zone costs the app its configured zone and NOTHING else:
      // the same correctly formatted default-zone date it would have had if
      // the variable had been left unset.
      expect(formatDateTime('2026-03-12T00:58:04.508Z')).toBe('2026-03-12 13:58')
    }
  })

  it('treats an empty string and a non-string as "nothing was configured"', () => {
    for (const zone of ['', null, undefined, 42, {}, [], true]) {
      setDisplayTimezone(zone)
      expect(getDisplayTimezone()).toBe(DEFAULT_DISPLAY_TIMEZONE)
      expect(formatDate('2026-03-12T00:58:04.508Z')).toBe('2026-03-12')
    }
  })

  it('never raises, never returns the empty string, and never returns the fallback', () => {
    for (const zone of [...UNUSABLE_ZONES, '', undefined, 0]) {
      setDisplayTimezone(zone)
      expect(() => formatDate('2026-03-12T00:58:04.508Z')).not.toThrow()
      expect(() => formatDateTime('2026-03-12T00:58:04.508Z')).not.toThrow()
      // A parseable instant must not be reported as unknown just because
      // the configured zone was unusable.
      expect(formatDate('2026-03-12T00:58:04.508Z', 'FALLBACK')).toMatch(DATE_SHAPE)
      expect(formatDateTime('2026-03-12T00:58:04.508Z', 'FALLBACK')).toMatch(DATE_TIME_SHAPE)
    }
  })

  it('keeps a recognised zone rather than falling back', () => {
    setDisplayTimezone('America/Los_Angeles')
    expect(getDisplayTimezone()).toBe('America/Los_Angeles')
  })
})

describe('the zone is resolved once and the formatter reused (Requirement 18.9)', () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat

  /**
   * Counts `new Intl.DateTimeFormat(...)` constructions while `body` runs.
   * The stand-in delegates to the real constructor, so the code under test
   * gets a genuine formatter and the assertions below are about how MANY
   * were built, not about a fake.
   *
   * @param {(count: () => number) => void} body
   */
  const countingConstructions = (body) => {
    let constructions = 0
    const Counting = function (...args) {
      constructions += 1
      return new OriginalDateTimeFormat(...args)
    }
    Counting.prototype = OriginalDateTimeFormat.prototype
    Counting.supportedLocalesOf = OriginalDateTimeFormat.supportedLocalesOf
    Intl.DateTimeFormat = Counting
    try {
      body(() => constructions)
    } finally {
      Intl.DateTimeFormat = OriginalDateTimeFormat
    }
  }

  const INSTANTS = Array.from(
    { length: 200 },
    (_, i) => new Date(Date.UTC(2026, 2, 12, 0, 58, 4) + i * 37_000).toISOString()
  )

  it('does not construct a formatter per formatted value', () => {
    countingConstructions((count) => {
      setDisplayTimezone('Pacific/Auckland')
      formatDateTime(INSTANTS[0])
      const afterFirst = count()
      expect(afterFirst).toBeGreaterThan(0)

      for (const instant of INSTANTS) {
        formatDate(instant)
        formatDateTime(instant)
      }
      // 400 further formatted values, not one more formatter. These run once
      // per rendered table cell, so a per-call construction is the cost this
      // criterion exists to prevent.
      expect(count()).toBe(afterFirst)
    })
  })

  it('does not re-walk the fallback chain per formatted value for a bad zone', () => {
    countingConstructions((count) => {
      setDisplayTimezone('Pacific/Aukland')
      formatDate(INSTANTS[0])
      const afterFirst = count()
      for (const instant of INSTANTS) {
        formatDateTime(instant)
      }
      expect(count()).toBe(afterFirst)
    })
  })

  it('re-resolves when a new zone is installed, so the memo is not stale', () => {
    countingConstructions((count) => {
      setDisplayTimezone('UTC')
      expect(formatDateTime('2026-03-12T00:58:04.508Z')).toBe('2026-03-12 00:58')
      const afterFirst = count()

      setDisplayTimezone('Pacific/Auckland')
      expect(formatDateTime('2026-03-12T00:58:04.508Z')).toBe('2026-03-12 13:58')
      expect(count()).toBeGreaterThan(afterFirst)
    })
  })
})

// ---------------------------------------------------------------------------
// The Midnight_Anchor and the renderable predicate (Requirement 4)
//
// Everything above this line asserts `formatDate`/`formatDateTime` and is left
// exactly as it was: this feature added two exports and changed no rendering
// (Criterion 2.13).
//
// The integers below are day ordinals -- whole days since 1970-01-01 -- and are
// written as literals rather than recomputed in the test, so a defect in the
// arithmetic cannot be reproduced by the assertion that is supposed to catch
// it. `2026-03-12` is day 20524 and `2026-03-11` is day 20523.
// ---------------------------------------------------------------------------

/** The instant Requirement 18 was written about, reused for the anchor. */
const REPORTED_INSTANT = '2026-03-12T00:58:04.508Z'

const DAY_2026_03_11 = 20523
const DAY_2026_03_12 = 20524

/** The browser-local calendar day of an instant, in the same shape `formatDate` emits. */
function localCalendarDay(value) {
  const date = new Date(value)
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
}

describe('zonedDayNumber is a whole day, independent of time of day (Criteria 4.1, 4.2)', () => {
  it('gives the same integer just after 00:00 and just before 24:00 on one day', () => {
    setDisplayTimezone('Pacific/Auckland')
    // Auckland is +13 (NZDT) in March, so 11:00Z is exactly 00:00 in-zone:
    // one second after it and one second before the next midnight are the
    // two ends of the SAME displayed day.
    const justAfterMidnight = '2026-03-11T11:00:01.000Z'
    const justBeforeNextMidnight = '2026-03-12T10:59:59.000Z'

    // The cell shows one day for both, so the anchor must too.
    expect(formatDate(justAfterMidnight)).toBe('2026-03-12')
    expect(formatDate(justBeforeNextMidnight)).toBe('2026-03-12')

    expect(zonedDayNumber(justAfterMidnight)).toBe(DAY_2026_03_12)
    expect(zonedDayNumber(justBeforeNextMidnight)).toBe(DAY_2026_03_12)
    // 23 hours 59 minutes 58 seconds apart, distance zero: Criterion 4.4's
    // `just now` falls straight out of this.
    expect(zonedDayNumber(justBeforeNextMidnight) - zonedDayNumber(justAfterMidnight)).toBe(0)
  })

  it('gives integers differing by exactly one for adjacent displayed days', () => {
    setDisplayTimezone('Pacific/Auckland')
    // Two seconds apart in real time, either side of in-zone midnight.
    expect(zonedDayNumber('2026-03-11T10:59:59.000Z')).toBe(DAY_2026_03_11)
    expect(zonedDayNumber('2026-03-11T11:00:01.000Z')).toBe(DAY_2026_03_12)
  })

  it('counts from 1970-01-01, so the epoch is day zero', () => {
    setDisplayTimezone('UTC')
    expect(zonedDayNumber('1970-01-01T00:00:00.000Z')).toBe(0)
    expect(zonedDayNumber('1970-01-02T23:59:59.999Z')).toBe(1)
    expect(zonedDayNumber('1969-12-31T00:00:00.000Z')).toBe(-1)
  })

  it('returns null for exactly the values the helpers fall back on', () => {
    setDisplayTimezone('Asia/Kolkata')
    for (const value of [null, undefined, 'not-a-date', '', new Date('nope'), NaN]) {
      expect(zonedDayNumber(value)).toBeNull()
    }
  })
})

describe('the anchor follows the display timezone, not the browser (Criteria 4.6, 4.8)', () => {
  // Auckland (+13) and Honolulu (-10) put this instant on two different
  // calendar days, and the browser's own zone can only agree with one of
  // them: every real UTC offset (-12..+14) reads 00:58Z as either
  // 2026-03-11 or 2026-03-12 locally. So one of the two blocks below is
  // always a case where the local and display calendar days DISAGREE --
  // whatever `TZ` the suite runs under.
  const AUCKLAND = { zone: 'Pacific/Auckland', day: '2026-03-12', dayNumber: DAY_2026_03_12 }
  const HONOLULU = { zone: 'Pacific/Honolulu', day: '2026-03-11', dayNumber: DAY_2026_03_11 }

  it('gives a different integer per installed zone for one instant', () => {
    // A local-zone anchor would ignore the installed zone entirely and
    // return the SAME integer twice, which is the regression Criterion 4.8
    // exists to catch.
    setDisplayTimezone(AUCKLAND.zone)
    expect(zonedDayNumber(REPORTED_INSTANT)).toBe(AUCKLAND.dayNumber)
    setDisplayTimezone(HONOLULU.zone)
    expect(zonedDayNumber(REPORTED_INSTANT)).toBe(HONOLULU.dayNumber)
    expect(AUCKLAND.dayNumber - HONOLULU.dayNumber).toBe(1)
  })

  it('follows the display zone where it disagrees with the local calendar day', () => {
    const local = localCalendarDay(REPORTED_INSTANT)
    // Guards the premise of this test rather than the code: if this ever
    // fails, the instant above stopped straddling the two zones.
    expect([AUCKLAND.day, HONOLULU.day]).toContain(local)

    const disagreeing = local === AUCKLAND.day ? HONOLULU : AUCKLAND
    setDisplayTimezone(disagreeing.zone)
    expect(formatDate(REPORTED_INSTANT)).toBe(disagreeing.day)
    expect(formatDate(REPORTED_INSTANT)).not.toBe(local)
    // The cell shows the display zone's day; the anchor is that day.
    expect(zonedDayNumber(REPORTED_INSTANT)).toBe(disagreeing.dayNumber)
  })
})

describe('a year in the 0-99 range does not land in 1900-1999', () => {
  it('anchors year 50 in year 50, not 1950', () => {
    setDisplayTimezone('UTC')
    // `Date.UTC(50, 5, 15)` would silently mean 1950-06-15 -- day -7140
    // instead of -701100, an error of nearly two thousand years.
    expect(formatDate('0050-06-15T12:00:00.000Z')).toBe('0050-06-15')
    expect(zonedDayNumber('0050-06-15T12:00:00.000Z')).toBe(-701100)
    expect(zonedDayNumber('0050-06-15T12:00:00.000Z')).not.toBe(
      zonedDayNumber('1950-06-15T12:00:00.000Z')
    )
    expect(zonedDayNumber('1950-06-15T12:00:00.000Z')).toBe(-7140)
  })
})

describe('hasRenderableDate agrees with the helpers (Criterion 2.13)', () => {
  // The same value set the fallback assertions above already use, so the
  // predicate and the renderers cannot drift apart.
  const UNRENDERABLE = [null, undefined, 'not-a-date', '', new Date('nope'), NaN]
  const RENDERABLE = [
    '2024-03-05T14:30:00.000Z',
    REPORTED_INSTANT,
    '2026-03-12',
    0,
    Date.UTC(2026, 2, 12),
    new Date(REPORTED_INSTANT)
  ]

  it('is false for every value the helpers return the fallback for', () => {
    for (const value of UNRENDERABLE) {
      expect(hasRenderableDate(value)).toBe(false)
      // ...and the helpers still do return the fallback for them.
      expect(formatDate(value, 'Never')).toBe('Never')
      expect(formatDateTime(value, 'Never')).toBe('Never')
    }
  })

  it('is true for every value the helpers render', () => {
    for (const value of RENDERABLE) {
      expect(hasRenderableDate(value)).toBe(true)
      expect(formatDate(value, 'Never')).toMatch(DATE_SHAPE)
      expect(formatDateTime(value, 'Never')).toMatch(DATE_TIME_SHAPE)
    }
  })

  it('does not depend on which zone is installed, usable or not', () => {
    for (const zone of ['UTC', 'Pacific/Auckland', 'Pacific/Aukland', '', 42]) {
      setDisplayTimezone(zone)
      expect(hasRenderableDate(REPORTED_INSTANT)).toBe(true)
      expect(hasRenderableDate(null)).toBe(false)
    }
  })
})
