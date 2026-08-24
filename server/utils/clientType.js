/**
 * Client_Type classification (Requirement 15: Client Type Classification)
 *
 * Criterion 15.1: Client_Type is a pure function of Client_Uid ALONE — no
 * database row, no TAK Server lookup, no other field of the Device. That is
 * what lets it be derived on read in `DeviceManagementService.mapDevice()`
 * with no column, no migration and no backfill (Criterion 15.2), and it is
 * why this module lives beside the other pure helpers in `server/utils/`
 * (`callsignValidation.js`, `directoryScope.js`) rather than inside the
 * service.
 *
 * Criterion 15.3: the five rules are evaluated in the order below and the
 * FIRST match wins, matching case-insensitively:
 *
 *   1. CloudTAK          contains `(ETL)`, `(Web)`, or the literal `CloudTAK`
 *                        anywhere      -- `ckadmin (ETL)`,
 *                                         `chris@chriselsen.net (Web)`,
 *                                         `etl-volcano (ETL)`,
 *                                         `ANDROID-CloudTAK-chris@chriselsen.net`
 *   2. Android / ATAK    starts with `ANDROID-`
 *                                      -- `ANDROID-63040a40563b5fab`
 *   3. iOS / iTAK        a UUID, `8-4-4-4-12` hex groups
 *                                      -- `CE17C84D-9700-4080-BA5A-44AF51809453`
 *   4. Windows / WinTAK  a Windows SID, `S-1-5-21-<digits>-<digits>-<digits>-<digits>`
 *                                      -- `S-1-5-21-2281966494-490247268-205662872-1002`
 *   5. Unknown           anything else
 *
 * Every example above is a real Client_Uid observed on the live server.
 *
 * Criterion 15.4: CloudTAK OUTRANKS Android deliberately.
 * `ANDROID-CloudTAK-chris@chriselsen.net` exists on the live server and is a
 * CloudTAK browser session, not an ATAK device; testing the `ANDROID-` prefix
 * first would misclassify it. The ordering of the two branches in
 * `classifyClientType` is therefore load-bearing, not incidental.
 *
 * Criterion 15.5: `unknown` is a first-class outcome with its own icon and
 * label. An unrecognised Client_Uid is never nudged into a neighbouring
 * category on a hunch.
 *
 * TOTAL and NEVER THROWING: any input whatsoever yields one of the five
 * values, including `null`, `undefined`, a number, an object, or the empty
 * string, all of which are `unknown`. This function is called from
 * `mapDevice()` on the way out of every device endpoint, so a throw here
 * would turn one odd Client_Uid into a failed response for the whole list.
 *
 * The classifier does NOT trim its input: the rules are stated over the
 * Client_Uid exactly as TAK Server issued it, and `' CE17C84D-...'` is a
 * different identifier from `'CE17C84D-...'` rather than a sloppy spelling of
 * it. Whitespace-padded values fall to `unknown`, which is the honest answer.
 */

/**
 * The Client_Type value set. Exported so callers — `mapDevice()` and the
 * client's `DeviceTypeIcon` — share these values rather than re-typing string
 * literals, which is what keeps a typo from silently becoming a sixth,
 * unrenderable Client_Type.
 *
 * @type {{ CLOUDTAK: 'cloudtak', ANDROID: 'android', IOS: 'ios', WINDOWS: 'windows', UNKNOWN: 'unknown' }}
 */
const CLIENT_TYPES = Object.freeze({
  CLOUDTAK: 'cloudtak',
  ANDROID: 'android',
  IOS: 'ios',
  WINDOWS: 'windows',
  UNKNOWN: 'unknown',
});

/** Rule 1: `(ETL)`, `(Web)`, or `CloudTAK` anywhere in the Client_Uid. */
const CLOUDTAK_PATTERN = /\(ETL\)|\(Web\)|CloudTAK/i;

/** Rule 2: the `ANDROID-` prefix. Anchored at the start only. */
const ANDROID_PREFIX_PATTERN = /^ANDROID-/i;

/** Rule 3: a UUID — `8-4-4-4-12` hex groups, whole string. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rule 4: a Windows SID — `S-1-5-21-` plus four digit groups, whole string. */
const WINDOWS_SID_PATTERN = /^S-1-5-21-\d+-\d+-\d+-\d+$/i;

/**
 * Classifies a Client_Uid into its Client_Type (Requirement 15 Criteria 1,
 * 3, 4, 5).
 *
 * Pure, total, deterministic, case-insensitive, and never throwing. The
 * branch order below IS the precedence order of Criterion 15.3, and the
 * CloudTAK branch preceding the Android branch is Criterion 15.4.
 *
 * @param {string|null|undefined|*} clientUid The Device's Client_Uid. Any
 *   non-string value is `unknown`.
 * @returns {'cloudtak'|'android'|'ios'|'windows'|'unknown'} one of
 *   `CLIENT_TYPES`.
 */
function classifyClientType(clientUid) {
  if (typeof clientUid !== 'string' || clientUid === '') {
    return CLIENT_TYPES.UNKNOWN;
  }

  // Rule 1 — CloudTAK. MUST stay ahead of the Android rule (Criterion 15.4).
  if (CLOUDTAK_PATTERN.test(clientUid)) {
    return CLIENT_TYPES.CLOUDTAK;
  }

  // Rule 2 — Android / ATAK.
  if (ANDROID_PREFIX_PATTERN.test(clientUid)) {
    return CLIENT_TYPES.ANDROID;
  }

  // Rule 3 — iOS / iTAK.
  if (UUID_PATTERN.test(clientUid)) {
    return CLIENT_TYPES.IOS;
  }

  // Rule 4 — Windows / WinTAK.
  if (WINDOWS_SID_PATTERN.test(clientUid)) {
    return CLIENT_TYPES.WINDOWS;
  }

  // Rule 5 — Unknown, a first-class outcome (Criterion 15.5).
  return CLIENT_TYPES.UNKNOWN;
}

module.exports = { CLIENT_TYPES, classifyClientType };
