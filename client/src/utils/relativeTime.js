/**
 * Relative_Time classification (Requirement 1: The Relative_Time Ladder)
 *
 * Turns the signed distance between a rendered instant and a supplied `now`
 * into one English phrase -- `just now`, `3 minutes ago`, `in 2 days` --
 * or into No_Phrase when there is nothing honest to say about the input.
 *
 * This module holds only the decidable part of the Date_Tooltip, the same
 * split `expiryWarning.js` already makes: a pure, total function with
 * interesting boundaries lives somewhere a property test can reach it by
 * arithmetic, rather than inside the component that happens to render it.
 * `FormattedDate.jsx` owns the disclosure, the ARIA wiring and the clock
 * read; this file owns the ladder.
 *
 * ## `now` is a REQUIRED parameter with NO default (Criterion 1.1)
 *
 * `classifyExpiry` in the sibling module defaults `now` to `Date.now()`,
 * and copying that would have been the consistent choice. Criterion 1.1
 * forbids it, and the reason is worth recording here rather than in the
 * spec alone:
 *
 * A defaulted clock read SILENTLY WORKS for a caller who forgot to pass
 * the disclosure-time clock. It would produce a plausible phrase computed
 * from the wrong moment -- the moment of the render rather than the moment
 * of the disclosure -- which is precisely the staleness Criterion 2.5
 * exists to prevent, and it would look correct in every screenshot. With
 * no default, an omitted `now` arrives as `undefined`, `undefined` is not
 * a usable instant, and an unusable instant already means No_Phrase
 * (Criterion 1.8). So totality makes the mistake visible as a MISSING
 * TOOLTIP -- something a reader notices -- rather than as a wrong phrase.
 *
 * ## Total and never throwing (Criterion 1.8)
 *
 * `relativeTime` runs once per rendered table cell across ten
 * Date_Render_Positions, so a throw here would turn one odd timestamp into
 * a blank page. Totality is achieved the way `expiryWarning.js` achieves
 * it: by accepting exactly three input shapes BY TYPE and answering
 * No_Phrase for everything else, never by wrapping a coercion in
 * try/catch. See `toEpochMs` below for why that distinction is structural
 * rather than stylistic.
 *
 * ## English literals only (Criterion 1.10)
 *
 * Every phrase is assembled from string literals held in this file. The
 * locale-aware relative-time formatter in `Intl` is deliberately NOT used:
 * a locale-dependent phrase would vary with the browser while the
 * `yyyy-mm-dd` date beside it does not -- the same reasoning
 * `dateFormat.js` already records -- and it would not produce this ladder
 * anyway, since its unit selection and pluralisation are locale-driven and
 * its `numeric: 'auto'` mode emits `yesterday`/`last month`, a second
 * vocabulary Criterion 4.4 declined.
 *
 * That formatter is deliberately not NAMED as a literal anywhere in this
 * file, not even in prose: `relativeTime.test.js` carries a one-line
 * structural assertion that this source contains no reference to it
 * (Criterion 1.10), and a mention in a comment explaining why it is unused
 * would fail that scan for the wrong reason.
 */

/** Milliseconds in one minute -- the second rung's unit and lower bound. */
const MS_PER_MINUTE = 60 * 1000

/** Milliseconds in one hour. */
const MS_PER_HOUR = 60 * MS_PER_MINUTE

/** Milliseconds in one day. */
const MS_PER_DAY = 24 * MS_PER_HOUR

/**
 * Nominal_Month: exactly 30 days (2 592 000 000 ms).
 *
 * A deliberate approximation, accepted by Criterion 1.5 as a decision open
 * to review. Calendar months are uneven; carrying month-length arithmetic
 * for a phrase already rounded to whole units buys nothing measurable.
 */
const NOMINAL_MONTH_MS = 30 * MS_PER_DAY

/**
 * Nominal_Year: exactly 365 days (31 536 000 000 ms). Same approximation,
 * same criterion.
 */
const NOMINAL_YEAR_MS = 365 * MS_PER_DAY

/** The directionless sub-minute phrase (Criteria 1.3.1, 1.4). */
const JUST_NOW = 'just now'

/** The past template's trailing word: `<n> <unit> ago`. */
const PAST_SUFFIX = ' ago'

/** The future template's leading word: `in <n> <unit>`. */
const FUTURE_PREFIX = 'in '

/**
 * The distinct "nothing to say about this value" result (Criteria 1.8, 1.9).
 *
 * A VALUE, not an empty string and not a thrown error, so a caller can
 * tell "there is nothing to say about this value" apart from "the phrase
 * happened to be empty". Criterion 2.7's suppression of the whole tooltip
 * is then driven by an identity check against this export rather than by a
 * string test on the phrase.
 *
 * @type {null}
 */
export const NO_PHRASE = null

/**
 * The Relative_Time_Ladder (Criterion 1.3): six ordered rungs, evaluated
 * top to bottom against `|value - now|`, stopping at the first whose
 * `limitMs` the distance falls below. Exactly one rung matches any finite
 * distance, since the last rung's limit is `Infinity`.
 *
 * MODULE-PRIVATE AND NOT EXPORTED, on purpose. These boundaries are the
 * thing Property 1 exists to check, and a test that imported them would
 * agree with a ladder someone had edited to 31-day months. The property
 * test hard-codes the six Criterion 1.3 boundaries instead -- the same
 * re-derivation rule `expiryWarning.property.test.js` records.
 *
 * `unitMs === null` marks the first rung as the directionless, magnitudeless
 * one: it renders `just now` with no number and no `ago`/`in` (Criterion
 * 1.4). Every other rung carries the singular and plural forms of its unit
 * noun; the direction words are applied by `relativeTime` from the sign
 * alone, so each noun appears once here rather than in four templates.
 *
 * Every magnitude is `Math.floor(distance / unitMs)` (Criterion 1.6), and
 * every rung from the second down has a lower bound of exactly one of its
 * own units -- 1 minute for the minute rung, 1 hour for the hour rung, and
 * so on. A floored magnitude of 0 is therefore UNREACHABLE below the first
 * rung, which is what makes `0 minutes ago` impossible to emit rather than
 * merely unlikely (Criteria 1.4, 1.6).
 *
 * THE 365 / 30 = 12.17 ARTIFACT. The month rung's top magnitude is **12**,
 * not 11: a distance one millisecond below the 365-day year boundary floors
 * to `Math.floor(364.999.../30) === 12`, so `12 months ago` is reachable
 * immediately below the year boundary and `12 months` and `1 year` are
 * adjacent phrases. This reads like an off-by-one to anyone who has not
 * read Criterion 1.5, which accepts it as a consequence of the nominal
 * units above. It is not a bug and it is not to be "corrected" by clamping
 * the month magnitude to 11.
 *
 * @type {ReadonlyArray<{ limitMs: number, unitMs: number|null, singular: string|null, plural: string|null }>}
 */
const LADDER = Object.freeze([
  Object.freeze({ limitMs: MS_PER_MINUTE, unitMs: null, singular: null, plural: null }),
  Object.freeze({ limitMs: MS_PER_HOUR, unitMs: MS_PER_MINUTE, singular: 'minute', plural: 'minutes' }),
  Object.freeze({ limitMs: MS_PER_DAY, unitMs: MS_PER_HOUR, singular: 'hour', plural: 'hours' }),
  Object.freeze({ limitMs: NOMINAL_MONTH_MS, unitMs: MS_PER_DAY, singular: 'day', plural: 'days' }),
  Object.freeze({ limitMs: NOMINAL_YEAR_MS, unitMs: NOMINAL_MONTH_MS, singular: 'month', plural: 'months' }),
  Object.freeze({ limitMs: Infinity, unitMs: NOMINAL_YEAR_MS, singular: 'year', plural: 'years' }),
])

/**
 * Converts a value to epoch milliseconds, or reports it as not an instant.
 *
 * The DISCIPLINE here is copied from `expiryWarning.js`'s function of the
 * same name -- the same three accepted shapes, the same by-type rejection,
 * the same reason -- rather than the code, since neither module should
 * import the other's private helper for the sake of six lines.
 *
 * Exactly these three shapes are accepted:
 *
 *   - a finite `number`, treated as epoch milliseconds. `NaN`, `Infinity`
 *     and `-Infinity` are NOT instants (Criterion 1.8).
 *   - a `Date` whose time is not `NaN`. An Invalid Date is not an instant.
 *   - a non-blank `string` that `new Date(...)` parses to a real time. An
 *     empty or whitespace-only string is not an instant, and neither is
 *     `'not a date'` or `'2024-13-45'`. (`new Date(string)` never throws;
 *     it yields an Invalid Date.)
 *
 * EVERYTHING else is reported as not an instant WITHOUT being converted:
 * `null`, `undefined` (which is what an omitted `now` arrives as), booleans,
 * arrays, plain objects, functions, symbols and bigints all land at the
 * final `return null`.
 *
 * REJECTING BY TYPE IS WHAT MAKES THIS UNABLE TO THROW, and that is the
 * whole reason no arbitrary value is ever handed to the `Date` constructor:
 * `new Date(Symbol())` throws on string conversion, `new Date(1n)` throws
 * on number conversion, and an object with a hostile `valueOf` can throw
 * anything at all. A classifier that runs once per table cell across ten
 * surfaces must be structurally unable to throw, not merely observed not
 * to -- so this is by-type rejection and never a coercion in try/catch.
 *
 * A cross-realm `Date` (from an iframe) fails `instanceof` and is reported
 * as not an instant. The API layer hands this module JSON-decoded strings,
 * so the case does not arise in practice, and No_Phrase for it is a
 * tooltip that is merely absent rather than wrong.
 *
 * @param {*} value Anything at all.
 * @returns {number|null} Epoch milliseconds, or `null` when `value` is not
 *   a usable instant.
 */
function toEpochMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : time
  }
  if (typeof value === 'string') {
    if (value.trim() === '') {
      return null
    }
    const time = new Date(value).getTime()
    return Number.isNaN(time) ? null : time
  }
  return null
}

/**
 * Classifies the signed distance between `value` and `now` into one
 * Relative_Time phrase (Requirement 1).
 *
 * Pure, total, deterministic and never throwing. The direction comes from
 * the sign of `value - now` ALONE (Criterion 1.2): strictly earlier renders
 * `<n> <unit> ago`, strictly later renders `in <n> <unit>`, and a value
 * equal to `now` has distance zero, which falls in the first rung, whose
 * phrase is directionless. Magnitudes are floored, never rounded
 * (Criterion 1.6), so a distance of 1 hour 59 minutes reads `1 hour ago`
 * and the phrase never claims more elapsed time than has elapsed -- which
 * matters because it sits beside the absolute date a user can check.
 *
 * Singularisation happens at a magnitude of exactly 1 and pluralisation at
 * 2 or more, in every unit and both directions (Criterion 1.7).
 *
 * `now` is REQUIRED and has no default; see the module header for why.
 * An unusable `now` -- omitted, `null`, `NaN`, a non-instant type -- yields
 * No_Phrase for every value, because with no reference instant there is no
 * honest way to place one (Criterion 1.8).
 *
 * @param {string|number|Date|null|undefined|*} value The candidate instant.
 *   Anything that is not a usable instant yields `NO_PHRASE`.
 * @param {string|number|Date|null|undefined|*} now The reference instant.
 *   REQUIRED -- there is deliberately no `Date.now()` default (Criterion 1.1).
 * @returns {string|null} A non-empty English phrase, or `NO_PHRASE`.
 */
export function relativeTime(value, now) {
  const valueMs = toEpochMs(value)
  if (valueMs === null) {
    return NO_PHRASE
  }

  const nowMs = toEpochMs(now)
  if (nowMs === null) {
    return NO_PHRASE
  }

  // Sign first, magnitude second (Criterion 1.2). Both operands are finite,
  // but their DIFFERENCE can still overflow to +/-Infinity for two extreme
  // epoch values (roughly +/-1e308, which no calendar produces and no API
  // sends). An unusable distance is an unusable comparison, so it answers
  // No_Phrase rather than emitting `Infinity years ago`.
  const signed = valueMs - nowMs
  if (!Number.isFinite(signed)) {
    return NO_PHRASE
  }

  const distance = Math.abs(signed)

  for (const rung of LADDER) {
    if (distance >= rung.limitMs) {
      continue
    }

    // The first rung: no direction, no magnitude (Criteria 1.3.1, 1.4).
    if (rung.unitMs === null) {
      return JUST_NOW
    }

    // FLOOR, not round (Criterion 1.6). Unreachable at 0 from this rung
    // down, because each rung's lower bound is one of its own units.
    const magnitude = Math.floor(distance / rung.unitMs)
    const unit = magnitude === 1 ? rung.singular : rung.plural

    return signed < 0
      ? `${magnitude} ${unit}${PAST_SUFFIX}`
      : `${FUTURE_PREFIX}${magnitude} ${unit}`
  }

  // Unreachable: the last rung's limit is Infinity and `distance` is a
  // finite non-negative number by the guard above, so the loop always
  // returns. Present so the function has no implicit `undefined` exit --
  // No_Phrase is the only non-phrase result this module produces.
  return NO_PHRASE
}
