/**
 * Certificate-expiry classification (Requirement 21: An Imminent Certificate
 * Expiry Is Highlighted)
 *
 * Criterion 21.6: a Device's `expiresAt` falls into EXACTLY ONE of three
 * states, decided by two boundaries against an injected `now`:
 *
 *   expired    the instant is known and STRICTLY EARLIER than `now`
 *   imminent   the instant is known and lies in the CLOSED interval
 *              `now` .. `now + warningDays`, both ends INCLUDED
 *   none       everything else: later than that boundary, or unknown
 *              (null, undefined, unparseable, or a type that is not an
 *              instant at all)
 *
 * The upper boundary is CLOSED deliberately, and that is the whole point of
 * this module existing separately from the row that renders it. An
 * `expiresAt` landing exactly on `now + warningDays` is an `imminent`
 * expiry, so the comparison below is `<=` and not `<` (Criterion 21.6,
 * last sentence). Property 16 exists to catch exactly that one-character
 * defect, with generators concentrated at +/-1 ms around both boundaries,
 * because a uniform generator would essentially never land on the boundary
 * itself.
 *
 * `now` is a PARAMETER, not a `Date.now()` read buried in the body, so both
 * boundaries are reachable from a test by arithmetic rather than by
 * manipulating the clock. Same reasoning for `warningDays`: the threshold
 * arrives from the Public_Config_Endpoint (Criterion 21.7) and the callers
 * pass it in, so this module never reads configuration.
 *
 * This lives in `client/src/utils/` beside `dateFormat.js` and
 * `channelTree.js` for the same reason `classifyClientType` lives in
 * `server/utils/clientType.js`: a pure, total function with interesting
 * boundaries belongs somewhere a property test can reach it directly,
 * rather than inside the component that happens to render it.
 *
 * TOTAL and NEVER THROWING: every input whatsoever yields one of the three
 * values. `classifyExpiry` renders in a table cell for EVERY row of every
 * device list (`DeviceListRow.jsx`, shared by the Dashboard card and the
 * user-details modal, Criteria 21.8 and 16.6), so a throw here would turn
 * one odd `expires_at` into a blank list. Totality is achieved by accepting
 * only three input shapes as instants -- a finite number, a string, and a
 * `Date` -- and answering `none` for everything else, rather than by
 * wrapping a coercion in try/catch. That matters: `new Date(value)` DOES
 * throw for a `symbol` (string conversion) and for a `bigint` (number
 * conversion), and an object with a hostile `valueOf` can throw anything at
 * all, so no arbitrary value is ever handed to the `Date` constructor.
 */

/** Milliseconds in one day, the unit `warningDays` is expressed in. */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * The expiry state set. Exported so the renderer (`DeviceListRow`) and the
 * tests share these values instead of re-typing string literals, which is
 * what keeps a typo from silently becoming a fourth, unstyled state.
 *
 * @type {{ NONE: 'none', IMMINENT: 'imminent', EXPIRED: 'expired' }}
 */
export const EXPIRY_STATES = Object.freeze({
  NONE: 'none',
  IMMINENT: 'imminent',
  EXPIRED: 'expired',
})

/**
 * The Expiry_Warning_Days default (Criteria 21.1, 21.7). Used whenever the
 * configured value is absent or unusable, on the server (where
 * `DEVICE_MGMT_EXPIRY_WARNING_DAYS` is resolved) and again here on the
 * client (where the resolved value may not have arrived at all).
 *
 * @type {number}
 */
export const DEFAULT_EXPIRY_WARNING_DAYS = 30

/**
 * Converts a value to epoch milliseconds, or reports it as not an instant.
 *
 * "Unparseable" is enumerated rather than left to the `Date` constructor's
 * judgement. Exactly these three shapes are accepted:
 *
 *   - a finite `number`, treated as epoch milliseconds. `NaN`, `Infinity`
 *     and `-Infinity` are NOT instants.
 *   - a `Date` whose time is not `NaN`. An Invalid Date is not an instant.
 *   - a non-blank `string` that `new Date(...)` parses to a real time. An
 *     empty or whitespace-only string is not an instant, and neither is
 *     `'not a date'`, `'2024-13-45'`, or any other string `Date` rejects.
 *     (`new Date(string)` never throws; it yields an Invalid Date.)
 *
 * EVERYTHING else is not an instant, and is reported as such WITHOUT being
 * converted: `null`, `undefined`, booleans, arrays, plain objects,
 * functions, symbols and bigints all land here. Rejecting them by type is
 * what makes this function -- and therefore `classifyExpiry` -- unable to
 * throw; `new Date(Symbol())` and `new Date(1n)` both throw, and an object
 * with a throwing `valueOf` would too.
 *
 * A cross-realm `Date` (from an iframe, say) fails `instanceof` and is
 * reported as not an instant. The API layer hands this module JSON-decoded
 * strings, so that case does not arise in practice, and answering `none`
 * for it is a display that is merely unhighlighted rather than broken.
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
 * Resolves the Expiry_Warning_Days threshold the client should apply
 * (Criteria 21.1, 21.7).
 *
 * Criterion 21.7 is explicit about the client's contract: where the public
 * config is unreachable, omits `device_expiry_warning_days`, or carries a
 * value that IS NOT A POSITIVE INTEGER, the client applies 30. So the test
 * applied here is strict membership, not salvage:
 *
 *   - a `number` counts only when it is an integer greater than zero, so
 *     `45` -> 45, while `0`, `-5`, `30.7`, `NaN` and `Infinity` -> 30
 *   - a `string` counts only when its whole trimmed content is a decimal
 *     integer greater than zero, so `'45'` and `' 45 '` -> 45, while
 *     `'0'`, `'-5'`, `'abc'`, `'30.7'`, `'12abc'` and `''` -> 30
 *   - every other type, `null` and `undefined` included, -> 30
 *
 * Both string and number are accepted because the value arrives over JSON
 * and the shape of a config key is not something this module should insist
 * on knowing.
 *
 * DECISION on non-integer numerics (`'30.7'`, `45.9`): they yield the
 * default, they are NOT truncated. This is where the client deliberately
 * differs from the server's `parseInt(...) || <default>` discipline
 * (`getRevokeMaxCerts`, Criterion 21.1), which would salvage `'30.7'` as 30
 * and `'12abc'` as 12. The server resolves the environment variable to a
 * positive integer BEFORE it goes on the wire, so a fractional or
 * part-numeric value reaching the client is not a sloppy spelling of an
 * operator's intent -- it is evidence the response did not come from a
 * healthy server, and Criterion 21.7 says to apply 30 in exactly that
 * situation. Guessing that `45.9` meant 45 would be inventing a
 * configuration nobody wrote. The two disciplines agree on every value
 * Criterion 21.1 enumerates -- unset, unparseable, zero and negative all
 * yield 30 on both sides -- so this is a difference only for values the
 * server cannot produce.
 *
 * @param {*} value The `device_expiry_warning_days` value from the public
 *   config, or anything at all.
 * @returns {number} A positive integer: `value` when it is one,
 *   `DEFAULT_EXPIRY_WARNING_DAYS` otherwise.
 */
export function resolveWarningDays(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_EXPIRY_WARNING_DAYS
  }
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_EXPIRY_WARNING_DAYS
}

/**
 * The installed Expiry_Warning_Days, always a positive integer.
 *
 * Module state rather than a prop, for the reason set out on
 * `setExpiryWarningDays` below.
 */
let installedWarningDays = DEFAULT_EXPIRY_WARNING_DAYS

/**
 * Installs the Expiry_Warning_Days threshold (Criterion 21.7), normally the
 * `device_expiry_warning_days` key of the public config.
 *
 * WHY A MODULE-LEVEL INSTALL RATHER THAN A PROP. The threshold is consumed by
 * `DeviceListRow`, the ONE shared device row (Criteria 16.6, 21.8), and that
 * row has two parents -- the Dashboard card and `UserDevicesModal` -- while
 * the modal in turn has two parents of its own (`Users.jsx`,
 * `TeamDetail.jsx`) and is documented as taking only its target user and
 * owning everything else. Threading a config scalar down that tree would put
 * FOUR copies of "read this key, fall back to 30" in the codebase, and
 * Criterion 21.8's failure mode would simply move from the rule to the rule's
 * input: two surfaces rendering one component with two different thresholds
 * is exactly the divergence Criterion 16.6 forbids. One installed value
 * cannot diverge.
 *
 * This is deliberately the SAME mechanism `dateFormat.js`'s
 * `setDisplayTimezone` uses for the sibling Presentation_Config key, which is
 * what Criterion 21.7 means by this value reaching the client "the same way
 * the Display_Timezone does": one public-config read, one install, every
 * renderer downstream agreeing by construction. `folderSeparator` is threaded
 * as page state instead because the PAGE is the consumer there -- it calls
 * `buildFolderTree` itself -- which is not the case here.
 *
 * An unusable value installs the default, so a client that never received the
 * config behaves identically to one that received 30 (Criterion 21.7).
 *
 * @param {*} value the `device_expiry_warning_days` value, or anything at all.
 * @returns {void}
 */
export function setExpiryWarningDays(value) {
  installedWarningDays = resolveWarningDays(value)
}

/**
 * The Expiry_Warning_Days threshold in force, for the row that renders the
 * highlighting to hand to `classifyExpiry`.
 *
 * Always a positive integer: `DEFAULT_EXPIRY_WARNING_DAYS` until something
 * installs a usable value, which is the state a client whose public-config
 * read failed or omitted the key stays in (Criterion 21.7).
 *
 * @returns {number}
 */
export function getExpiryWarningDays() {
  return installedWarningDays
}

/**
 * Classifies an expiry instant into its expiry state (Criterion 21.6).
 *
 * Pure, total, deterministic and never throwing. The two comparisons below
 * ARE the boundaries of Criterion 21.6:
 *
 *   `expiryMs < nowMs`        strictly earlier than now  -> expired
 *   `expiryMs <= thresholdMs` now .. now + warningDays,
 *                             UPPER BOUND INCLUDED       -> imminent
 *
 * `<=` in the second comparison is load-bearing, not incidental: an
 * `expiresAt` exactly on `now + warningDays` is an `imminent` expiry, and
 * `<` there is the defect Property 16 is written to catch.
 *
 * `warningDays` is normalised through `resolveWarningDays`, so an unusable
 * threshold behaves as 30 rather than producing a `NaN` boundary that would
 * make every comparison false and silently classify a genuinely imminent
 * expiry as `none`. For any positive integer -- every value the config can
 * legitimately carry -- normalisation is the identity.
 *
 * An unusable `now` yields `none` for every input: with no reference
 * instant there is no honest way to place an expiry relative to it, and
 * `none` is the state that changes nothing about how the cell already
 * renders (Criterion 21.4).
 *
 * @param {string|number|Date|null|undefined|*} expiresAt The Device's
 *   `expiresAt`. Anything that is not a usable instant is `none`.
 * @param {number} [warningDays=DEFAULT_EXPIRY_WARNING_DAYS] The
 *   Expiry_Warning_Days threshold, in days.
 * @param {number|Date} [now=Date.now()] The reference instant. A parameter
 *   so both boundaries are testable without clock manipulation.
 * @returns {'none'|'imminent'|'expired'} one of `EXPIRY_STATES`.
 */
export function classifyExpiry(
  expiresAt,
  warningDays = DEFAULT_EXPIRY_WARNING_DAYS,
  now = Date.now()
) {
  const expiryMs = toEpochMs(expiresAt)
  if (expiryMs === null) {
    return EXPIRY_STATES.NONE
  }

  const nowMs = toEpochMs(now)
  if (nowMs === null) {
    return EXPIRY_STATES.NONE
  }

  // Strictly earlier than now -- the certificate has already lapsed.
  if (expiryMs < nowMs) {
    return EXPIRY_STATES.EXPIRED
  }

  // The CLOSED interval `now` .. `now + warningDays`. `<=`, not `<`.
  const thresholdMs = nowMs + resolveWarningDays(warningDays) * MS_PER_DAY
  if (expiryMs <= thresholdMs) {
    return EXPIRY_STATES.IMMINENT
  }

  // Further out than the warning window: no highlighting.
  return EXPIRY_STATES.NONE
}
