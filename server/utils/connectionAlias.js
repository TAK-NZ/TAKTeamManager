/**
 * Connection_Alias derivation (Requirement 22: A CloudTAK Device's Last_Seen Is
 * Matched Through Its Connection Alias; design decision 18).
 *
 * WHY THIS EXISTS. The Subscription_Poller joins a Client_Endpoints_API entry to
 * a Device by `ClientEndpoint.uid == tak_devices.client_uid`. For a native ATAK,
 * iTAK or WinTAK Device those two strings ARE the same string (verified live,
 * `ANDROID-63040a40563b5fab`) and that join is correct. For a CloudTAK Device
 * they are minted in two unrelated code paths and never coincide, so
 * `chris@chriselsen.net (Web)` rendered "never seen" while the browser session
 * was in use -- not for want of an entry (TAK Server holds one) but because the
 * entry reports `ANDROID-CloudTAK-chris@chriselsen.net`:
 *
 *   | `tak_devices.client_uid` (certificate) | reported `ClientEndpoint.uid`          |
 *   |----------------------------------------|----------------------------------------|
 *   | `ANDROID-63040a40563b5fab` (native)    | `ANDROID-63040a40563b5fab` (identical) |
 *   | `chris@chriselsen.net (Web)`           | `ANDROID-CloudTAK-chris@chriselsen.net`|
 *   | `ckadmin (ETL)`                        | `ANDROID-CloudTAK-ckadmin`             |
 *
 * The certificate `clientUid` gets its ` (ETL)` suffix from upstream
 * `@tak-ps/node-tak` v12.24.0 (`lib/api/credentials.ts:82`,
 * `CredentialCommands.generate()`) and its ` (Web)` suffix from the TAK-NZ
 * CloudTAK fork ONLY (`api/stateless/lib/authentik-provider.ts:623`, a file
 * absent upstream), while the connection uid is `ANDROID-CloudTAK-${email}` from
 * upstream CloudTAK (`api/common/connection-config.ts:170`). Nothing in the
 * reported uid records WHICH of the two certificate paths was taken, which is
 * why both suffixes are generated rather than one (Requirement 22.3): picking
 * one would leave the other form unmatched, which is the bug rather than a fix.
 *
 * ADDITIVE, NEVER A REPLACEMENT (Requirements 22.2, 22.9). The reported uid is
 * ALWAYS a member of the returned candidates and is always tried; alias
 * candidates are only ever ADDED beside it. So a native Device matches
 * bit-for-bit as it did before this module existed, and the failure direction is
 * fixed: this is a heuristic keyed on upstream string construction this project
 * does not control, and WHERE upstream changes that construction the alias
 * simply stops matching and the affected CloudTAK Device's Last_Seen returns to
 * null -- the pre-fix "never seen" state -- rather than attaching a timestamp to
 * a different Device.
 *
 * EXACT STRINGS ONLY (Requirement 22.7). Every candidate is a COMPLETE
 * `client_uid` intended for equality matching. Callers MUST match by string
 * equality (`client_uid = ANY($1::text[])`) and MUST NOT use `LIKE`, a prefix
 * test, a substring test or any wildcard: each candidate's base is the account
 * identifier the connection belongs to, so a row can only be reached by a uid
 * whose base is that row's own account identifier -- which is what keeps one
 * user's connection off another user's Device row.
 *
 * KNOWN-UNHANDLED: the DN_Shaped_Connection_Uid (Requirement 22.11).
 * CloudTAK's `MachineConnConfig` and `AdminConnConfig` return
 * `ConnectionControl.uid(cert)` -- the certificate subject reversed and
 * comma-joined -- rather than the `ANDROID-CloudTAK-` prefixed form. No uid of
 * that shape appeared in the 48 live Client_Endpoints_API entries, so no
 * candidate is generated for it and none is guessed at. This is recorded rather
 * than silently ignored so that a future reader finding an unmatched DN-shaped
 * uid reads it as accounted-for rather than as an oversight.
 *
 * NOTHING IS PERSISTED (Requirement 22.13). The candidates are computed at poll
 * time from a value already in hand: no column, no migration, no derived key on
 * a row, and therefore nothing stored that can fall out of date with CloudTAK's
 * construction.
 *
 * Lives in `server/utils/` beside `clientType.js`, `callsignValidation.js` and
 * `directoryScope.js` for the reason `classifyClientType` does: a pure, total
 * function with interesting boundaries belongs somewhere a property test can
 * call it directly (Requirement 22.1).
 */

/**
 * The prefix upstream CloudTAK puts in front of the account identifier when it
 * mints a connection uid (`ANDROID-CloudTAK-${email}`,
 * `api/common/connection-config.ts:170`). Exported so callers and tests share
 * the one literal rather than re-typing it.
 *
 * @type {string}
 */
const CLOUDTAK_CONNECTION_PREFIX = 'ANDROID-CloudTAK-';

/**
 * The two Certificate_Uid_Suffix forms a CloudTAK certificate `clientUid` can
 * carry. BOTH are generated for a prefixed uid, in this order, because the
 * reported uid carries no evidence of which enrollment path minted the
 * certificate (Requirement 22.3).
 *
 * @type {ReadonlyArray<string>}
 */
const CERTIFICATE_UID_SUFFIXES = Object.freeze([' (Web)', ' (ETL)']);

/** The prefix, case-folded once, for the case-insensitive prefix test. */
const CLOUDTAK_CONNECTION_PREFIX_LOWER = CLOUDTAK_CONNECTION_PREFIX.toLowerCase();

/**
 * The Candidate_Client_Uids of one reported `ClientEndpoint.uid`: every
 * `tak_devices.client_uid` value this reported uid may identify (Requirements
 * 22.1, 22.2, 22.3).
 *
 * PURE, TOTAL and NEVER THROWING for every input -- `''`, `null`, `undefined`,
 * numbers, objects, arrays included. It runs inside the poll loop, which must
 * never throw (Requirement 3.8), so a non-string input yields a defined value
 * (`[]`, since there is no reported uid string to try) rather than an exception.
 *
 * A STRING input always yields at least itself, the empty string included:
 * Requirement 22.2 and Property 18 make membership of the reported uid
 * unconditional, and `''` carries no prefix so it takes the exactly-one arm like
 * any other unprefixed uid. Nothing is lost by that -- the poller skips an entry
 * with an empty `uid` before it ever gets here (`extractLastEventTimes`), so the
 * candidate never reaches a statement -- and it keeps the membership rule
 * structural rather than conditional on the input's length.
 *
 * The order is DETERMINISTIC -- reported uid, then `(Web)`, then `(ETL)` -- so
 * the SQL parameter array is stable for a given input and a test can assert it
 * exactly rather than as a set.
 *
 * NOT DEDUPLICATED, deliberately: a prefixed reported uid always carries the
 * prefix while the two suffixed forms never do, and the two suffixes always
 * differ, so no dedupe is needed -- and adding one would make "exactly three"
 * depend on the data instead of being structural. `unionCandidateClientUids`
 * is where duplicates are collapsed.
 *
 * TWO BOUNDARIES WORTH STATING, because both look like invitations to be clever
 * and both must be left alone:
 *
 *   - The uid that is EXACTLY the prefix (`ANDROID-CloudTAK-`) has an EMPTY
 *     base and still yields exactly three candidates, the latter two being the
 *     literal strings ` (Web)` and ` (ETL)`. It is NOT special-cased down to
 *     one: Property 18 requires exactly three for every prefixed uid, so
 *     diverging here would make the code and the property disagree. What keeps
 *     it safe is the exact-equality rule -- ` (Web)` can only ever reach a row
 *     whose `client_uid` IS that exact string, which would require a
 *     certificate minted for an empty account identifier. (If that reading is
 *     ever to change, requirements.md, design.md and Property 18 change first.)
 *   - A base that ALREADY ends in ` (Web)` or ` (ETL)` (e.g.
 *     `ANDROID-CloudTAK-ckadmin (ETL)`) is NOT stripped, NOT deduplicated and
 *     NOT single-suffixed. The rule is a plain concatenation, so this yields
 *     `ckadmin (ETL) (Web)` and `ckadmin (ETL) (ETL)` -- strings that match no
 *     row, the correct outcome for a uid shape upstream does not produce. Any
 *     cleverness here is a way for a candidate to land on a row it does not
 *     name.
 *
 * @param {string|*} reportedUid one `ClientEndpoint.uid` exactly as TAK Server
 *   reported it. Any non-string yields `[]`.
 * @returns {Array<string>} the reported uid first, plus `<base> (Web)` and
 *   `<base> (ETL)` WHERE the reported uid begins with the
 *   `CLOUDTAK_CONNECTION_PREFIX` compared case-insensitively.
 */
function candidateClientUids(reportedUid) {
  if (typeof reportedUid !== 'string') return [];

  // The reported uid is ALWAYS tried on its own, first (Requirement 22.2).
  const candidates = [reportedUid];

  // Case-INSENSITIVE prefix test on a case-folded copy, but the base is sliced
  // from the ORIGINAL string: `client_uid` matching in Postgres is
  // case-sensitive, so suffixing a lowercased remainder would build a base that
  // matches no row.
  if (reportedUid.toLowerCase().startsWith(CLOUDTAK_CONNECTION_PREFIX_LOWER)) {
    const base = reportedUid.slice(CLOUDTAK_CONNECTION_PREFIX.length);
    for (const suffix of CERTIFICATE_UID_SUFFIXES) {
      candidates.push(`${base}${suffix}`);
    }
  }

  return candidates;
}

/**
 * The UNION of the Candidate_Client_Uids of every reported uid, first-seen
 * ordered and with no repeats (Requirement 22.6).
 *
 * This is what the Criterion 20.6 unreported sweep excludes, and feeding it the
 * union rather than the raw reported uids is LOAD-BEARING: a CloudTAK row the
 * per-entry write just marked connected is, by construction, absent from the raw
 * reported uids -- that absence IS the defect -- so a sweep keyed on those raw
 * values would set the row straight back to `connected = false` inside the same
 * poll and the fix would be invisible.
 *
 * Deduplicated so the parameter array is stable for a given payload and does not
 * carry one copy per duplicate entry (TAK Server reports a client more than
 * once, e.g. per callsign). For a native-only payload the result is exactly the
 * reported set, in the order it was given -- which is what makes this change a
 * no-op for native Devices.
 *
 * Total like its per-uid counterpart: a non-array argument yields `[]`, and
 * unusable members contribute nothing rather than raising.
 *
 * @param {Array<string>|*} reportedUids every `ClientEndpoint.uid` this poll
 *   reported.
 * @returns {Array<string>} the deduplicated, first-seen-ordered union.
 */
function unionCandidateClientUids(reportedUids) {
  if (!Array.isArray(reportedUids)) return [];

  // A `Set` keeps first-seen order and makes a uid such as `__proto__` an
  // ordinary key.
  const union = new Set();

  for (const reportedUid of reportedUids) {
    for (const candidate of candidateClientUids(reportedUid)) {
      union.add(candidate);
    }
  }

  return [...union];
}

module.exports = { CLOUDTAK_CONNECTION_PREFIX, candidateClientUids, unionCandidateClientUids };
