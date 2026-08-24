/**
 * Shared ISO 8601 (yyyy-mm-dd) date formatting for user-visible dates
 * across the app, instead of each page independently calling
 * `toLocaleDateString()`/`toLocaleTimeString()` -- which render in the
 * browser's locale/format (e.g. American mm/dd/yyyy), not the
 * unambiguous, locale-independent yyyy-mm-dd format this app standardises
 * on everywhere a date is shown to a user.
 *
 * `formatDate` renders the date component only (yyyy-mm-dd); `formatDateTime`
 * additionally appends a 24-hour HH:MM time component (still yyyy-mm-dd
 * for the date part) for timestamps where the time is also meaningful
 * (e.g. "last synced", audit log entries).
 *
 * ## The display timezone (Requirement 18)
 *
 * The wall-clock components both functions render are computed in a
 * configurable display timezone -- NOT in the browser's local zone. The
 * defect that motivated this: TAK Server reported
 * `2026-03-12T00:58:04.508Z` and a UTC-7 browser rendered
 * `2026-03-11 17:58`, seven hours and a calendar day away from the
 * operator's own zone. `Intl.DateTimeFormat` is used only to READ the
 * year/month/day/hour/minute of an instant in that zone via
 * `formatToParts`; the `yyyy-mm-dd` / `yyyy-mm-dd HH:MM` string is still
 * assembled here, because handing the formatting itself to a locale-aware
 * formatter is exactly what this module exists to prevent (Requirement
 * 18.3). `hour12: false` plus `hourCycle: 'h23'` are explicit for the same
 * reason: an `h24` cycle renders midnight as `24:00`.
 *
 * The zone is resolved and validated ONCE and the formatter cached
 * (Requirement 18.9), because these functions run once per rendered table
 * cell. `Intl.DateTimeFormat` throws a `RangeError` for a zone it does not
 * recognise, so resolution walks a fallback chain -- the configured zone,
 * then `Pacific/Auckland`, then `UTC` -- and keeps the first zone that
 * constructs. A mistyped `DISPLAY_TIMEZONE` therefore costs the app its
 * configured zone and nothing else: never a throw, never an empty string,
 * never the caller's fallback for a parseable instant (Requirement 18.8).
 * If even `UTC` fails to construct, the browser-local getters are used --
 * a date in the wrong zone is a smaller failure than no date at all.
 *
 * This is presentation only. Stored, logged and API-transported timestamps
 * stay ISO-8601 UTC (Requirement 18.12).
 */

/**
 * The zone used when no display timezone has been installed, when the
 * public config is unreachable, and when it omits `display_timezone`
 * (Requirements 18.1, 18.7). Deliberately the same literal the server
 * defaults to, duplicated rather than imported: the client bundle and the
 * server process do not share a module graph, and a client that never
 * received the config must behave exactly like one that received the
 * default.
 */
export const DEFAULT_DISPLAY_TIMEZONE = 'Pacific/Auckland'

/**
 * The last link of the fallback chain. `UTC` is last because it is the one
 * zone any runtime with `Intl` support at all is required to accept.
 */
const LAST_RESORT_TIMEZONE = 'UTC'

/** The zone asked for, before the fallback chain has had a say. */
let configuredTimezone = DEFAULT_DISPLAY_TIMEZONE

/** Memoised resolution state -- see `resolveFormatter`. */
let resolutionAttempted = false
let partsFormatter = null
let resolvedTimezone = ''

/**
 * A single formatter carries every component both functions need, so a
 * `formatDateTime` call reads the instant once rather than formatting it
 * twice.
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat|null} null when the runtime rejects the zone.
 */
function buildFormatter(timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23'
    })
    // Construct-time validation is not universal -- probe once, here, where
    // the cost is paid a single time rather than once per rendered cell.
    formatter.formatToParts(new Date(0))
    return formatter
  } catch {
    return null
  }
}

/** The browser's own zone, used only to report what is in force if `Intl` is unusable. */
function localTimezone() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

/**
 * Walks the fallback chain at most once per installed zone and caches the
 * result (Requirements 18.8, 18.9).
 * @returns {Intl.DateTimeFormat|null} null only when no link constructed.
 */
function resolveFormatter() {
  if (resolutionAttempted) {
    return partsFormatter
  }
  resolutionAttempted = true
  for (const zone of [configuredTimezone, DEFAULT_DISPLAY_TIMEZONE, LAST_RESORT_TIMEZONE]) {
    if (typeof zone !== 'string' || zone.trim() === '') {
      continue
    }
    const formatter = buildFormatter(zone.trim())
    if (formatter) {
      partsFormatter = formatter
      try {
        resolvedTimezone = formatter.resolvedOptions().timeZone || zone.trim()
      } catch {
        resolvedTimezone = zone.trim()
      }
      return partsFormatter
    }
  }
  partsFormatter = null
  resolvedTimezone = localTimezone()
  return null
}

/**
 * Installs the display timezone (typically the `display_timezone` key of
 * the public config) and discards the memoised formatter so the next
 * formatted date resolves the new zone. An unusable value -- null,
 * undefined, a non-string, an empty string -- installs
 * `DEFAULT_DISPLAY_TIMEZONE`, so a client that never received the config
 * behaves like one that received the default (Requirement 18.7). A zone
 * the runtime does not recognise is not rejected here: it is resolved
 * lazily through the fallback chain.
 * @param {string|null|undefined} zone
 * @returns {void}
 */
export function setDisplayTimezone(zone) {
  configuredTimezone =
    typeof zone === 'string' && zone.trim() !== '' ? zone.trim() : DEFAULT_DISPLAY_TIMEZONE
  resolutionAttempted = false
  partsFormatter = null
  resolvedTimezone = ''
}

/**
 * The zone actually in force -- i.e. after the fallback chain resolved, so
 * a mistyped configured zone reports the zone dates are really rendered
 * in, not the one that was asked for.
 * @returns {string} an IANA zone name.
 */
export function getDisplayTimezone() {
  resolveFormatter()
  return resolvedTimezone
}

/**
 * @param {string|number|Date|null|undefined} value
 * @returns {Date|null} null for null/undefined/unparseable input.
 */
function toDate(value) {
  if (value == null) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * The instant's wall-clock components in the resolved display timezone,
 * every one a zero-padded string ready to be concatenated.
 * @param {Date} date
 * @returns {{year: string, month: string, day: string, hour: string, minute: string}}
 */
function readWallClock(date) {
  const formatter = resolveFormatter()
  if (formatter) {
    try {
      const parts = {}
      for (const part of formatter.formatToParts(date)) {
        if (part.type !== 'literal') {
          parts[part.type] = part.value
        }
      }
      const { year, month, day, hour, minute } = parts
      if (year && month && day && hour && minute) {
        // `year: 'numeric'` is not padded by the formatter; the rest are.
        return {
          year: year.padStart(4, '0'),
          month,
          day,
          hour,
          minute
        }
      }
    } catch {
      // Fall through to the local getters rather than raising: a date in
      // the wrong zone is a smaller failure than no date (Requirement 18.8).
    }
  }
  return {
    year: String(date.getFullYear()).padStart(4, '0'),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    hour: String(date.getHours()).padStart(2, '0'),
    minute: String(date.getMinutes()).padStart(2, '0')
  }
}

/**
 * @param {string|number|Date|null|undefined} value - anything `new Date()`
 *   accepts, or null/undefined.
 * @param {string} [fallback] - returned when `value` is null/undefined/
 *   unparseable. Defaults to an empty string.
 * @returns {string} `yyyy-mm-dd` in the display timezone, or `fallback`.
 */
export function formatDate(value, fallback = '') {
  const date = toDate(value)
  if (!date) {
    return fallback
  }
  const { year, month, day } = readWallClock(date)
  return `${year}-${month}-${day}`
}

/**
 * @param {string|number|Date|null|undefined} value
 * @param {string} [fallback]
 * @returns {string} `yyyy-mm-dd HH:MM` (24-hour) in the display timezone,
 *   or `fallback`.
 */
export function formatDateTime(value, fallback = '') {
  const date = toDate(value)
  if (!date) {
    return fallback
  }
  // Reads all five components from ONE `formatToParts` call, rather than
  // delegating the date half to `formatDate` and formatting the same
  // instant twice.
  const { year, month, day, hour, minute } = readWallClock(date)
  return `${year}-${month}-${day} ${hour}:${minute}`
}
/**
 * Milliseconds in a calendar-independent day. Only ever used to scale an
 * already-computed UTC midnight into a day ordinal -- never to add or
 * subtract a "day" from a real instant, which is where DST lives.
 */
const MS_PER_DAY = 86_400_000

/** Digits only: the shape `year: 'numeric'` / `2-digit` parts read back as. */
const DIGITS_ONLY = /^\d+$/

/**
 * The calendar day `value` falls on in the resolved display timezone, as
 * whole days since 1970-01-01. Always the display zone, never the
 * browser's (Requirement 4.6).
 *
 * ## Why a calendar ordinal and not a zoned midnight instant
 *
 * The obvious reading of "midnight in the display timezone" is an actual
 * instant whose wall clock in that zone reads `00:00`. Constructing one
 * means either offset arithmetic against a DST table or an iterative
 * search for the instant that reads back `00:00` -- both fiddly, and both
 * wrong in a way that only shows up twice a year in one hemisphere (the
 * day a zone has no 00:00 at all, or has two). Mapping the zoned calendar
 * triple to an integer instead has no zone and no DST anywhere in it: the
 * zone is applied exactly once, when `readWallClock` reads the triple,
 * by the formatter that is already memoised and already tested. **No
 * zoned midnight instant is ever constructed here.**
 *
 * Callers difference two of these ordinals and scale by `MS_PER_DAY`, so
 * both ends are anchored by construction (Requirement 4.2) and the
 * distance is an exact multiple of a day.
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {number|null} an integer, or null when there is no such day --
 *   unparseable input, or zoned components that do not read back as plain
 *   integers. Callers treat null as "nothing to say", which is better than
 *   a guess.
 */
export function zonedDayNumber(value) {
  const date = toDate(value)
  if (!date) {
    return null
  }
  const { year, month, day } = readWallClock(date)
  if (!DIGITS_ONLY.test(year) || !DIGITS_ONLY.test(month) || !DIGITS_ONLY.test(day)) {
    // Where a BCE instant and an era-bearing formatter would land. There
    // is no honest ordinal for it, so say nothing.
    return null
  }
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return null
  }
  // `Date.UTC` maps years 0-99 to 1900-1999, so a year in that range has
  // to be built through `setUTCFullYear`. Certificates and audit rows
  // never reach it; totality does.
  let midnightUtcMs
  if (y >= 0 && y <= 99) {
    const anchored = new Date(0)
    anchored.setUTCFullYear(y, m - 1, d)
    anchored.setUTCHours(0, 0, 0, 0)
    midnightUtcMs = anchored.getTime()
  } else {
    midnightUtcMs = Date.UTC(y, m - 1, d)
  }
  if (!Number.isFinite(midnightUtcMs)) {
    return null
  }
  const dayNumber = midnightUtcMs / MS_PER_DAY
  return Number.isInteger(dayNumber) ? dayNumber : null
}

/**
 * Whether `formatDate`/`formatDateTime` would render this value rather
 * than returning the caller's fallback.
 *
 * Exported so a caller can make a LAYOUT decision without importing a
 * renderer: `DeviceListRow`'s connected branch has to know whether there
 * is a timestamp before it decides whether to render the wrapper and the
 * deliberate leading space beside the connected label, and it does not
 * own the element the date goes in. Keeping `formatDateTime(value, '')`
 * around purely as a predicate would work and would keep a helper import
 * alive in a module that should no longer have one.
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {boolean}
 */
export function hasRenderableDate(value) {
  return toDate(value) !== null
}
