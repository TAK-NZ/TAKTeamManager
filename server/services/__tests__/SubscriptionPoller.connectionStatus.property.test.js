/**
 * device-management task 28.8: the single `fast-check` property test for
 * design.md's Property 17 (Requirements 20.3, 20.4, 20.5, 20.6, 20.12).
 *
 * design.md's Property 17 statement: for all Client_Endpoints_API payloads
 * (arbitrary numbers of entries per `uid`, arbitrary `lastStatus` values
 * including `Connected`, `Disconnected`, absent, null and mixed case, and
 * arbitrary `lastEventTime` sequences deliberately including equal, decreasing,
 * absent and unparseable values) and for all Device_Table contents, a successful
 * poll leaves each Device's stored `last_seen_at` at the running maximum of the
 * parseable reported times for its `uid` (Property 3 unchanged), sets each
 * reported Device's `connected` to whether AT LEAST ONE entry for that `uid`
 * reports `lastStatus` equal to `Connected` compared case-insensitively --
 * invariantly under permutation, and including the case where the only
 * `Connected` entry is one whose `lastEventTime` was unusable -- and sets
 * `connected = false` for exactly the rows whose `client_uid` is absent from the
 * reported set, through a statement parameterised by those `client_uid`s and
 * never one unrestricted by `client_uid`. In particular a reported
 * `lastEventTime` that does not advance past the stored value still has its
 * status written.
 *
 * AMENDED IN PLACE by task 30.3 (Requirement 22.6), exactly as design.md amends
 * the property text rather than renumbering it: "the reported set" handed to the
 * sweep means the deduplicated UNION of every reported entry's
 * Candidate_Client_Uids, and each per-entry write targets that entry's
 * candidates rather than its raw `uid`. This property generates NATIVE uids, for
 * which the two readings are identical -- which is why it is an amendment -- so
 * the expectations below express the union rule (`expectedReportedSet`) while
 * the derivation itself and the mixed native/CloudTAK sweep union are Property
 * 18's (`server/utils/connectionAlias.property.test.js`).
 *
 * WHY THE GENERATORS LOOK LIKE THIS. Two shapes are deliberate rather than
 * incidental:
 *
 *   - A SMALL `uid` alphabet against a much larger entry count, so several
 *     entries for one `uid` is the common case rather than an edge case. That is
 *     the live shape: one Windows SID returned four entries under different
 *     callsigns, which is why the Status_Collapse_Rule exists at all.
 *   - `lastEventTime` offsets drawn from a SMALL pool, and pre-existing stored
 *     values drawn from that same pool plus one value ahead of all of them, so
 *     EQUAL and DECREASING reported times are the norm. Those are the inputs for
 *     which a status write sharing the Monotonic_Guard's `WHERE` clause silently
 *     does nothing: the predicate is a deliberate no-match for a non-advancing
 *     time. An advancing-only generator would pass that broken implementation,
 *     so this generator would be worthless without them.
 *
 * WHY THE MODEL POOL INTERPRETS RATHER THAN PATTERN-MATCHES. The mocked pool
 * below reads each statement's `SET` list and `WHERE` clause and applies what
 * they actually say -- including the regressions this property exists to catch.
 * A clamp moved back into the `WHERE` clause is modelled as the no-match it
 * really is (no `connected` write at all for a non-advancing entry), and a sweep
 * without a `client_uid` restriction is modelled as reaching every row. So those
 * regressions fail this property on BEHAVIOUR -- a Device's status did not land,
 * a reported Device was marked disconnected -- rather than on a test that merely
 * refuses to recognise the SQL text. The exact statements and parameters are
 * asserted too (Requirement 20.6's scoping discipline is a claim about the
 * statement, not only about the resulting rows), but they are not the only thing
 * asserted.
 *
 * The expectations are computed from the GENERATED data by the requirement's own
 * rules -- running maximum of the parseable times, ANY-entry-wins over
 * `lastStatus`, set-difference for the unreported rows -- never by re-running
 * the implementation, so nothing here can be satisfied tautologically.
 *
 * Property 3 (`last_seen_at` monotonic-forward across a SEQUENCE of polls) is
 * `SubscriptionPoller.property.test.js`; this property is about ONE poll and
 * the column that poll writes unconditionally.
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn()
  }))
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const SubscriptionPoller = require('../SubscriptionPoller');

/** Devices that HAVE a Device_Table row for a generated run. */
const TRACKED_UIDS = ['uid-a', 'uid-b', 'uid-c'];

/**
 * A `client_uid` the Client_Endpoints_API can report but that has NO
 * Device_Table row: inserting rows is the Device_Sync's job, never the
 * poller's, so this uid must never appear in the table.
 */
const UNTRACKED_UID = 'uid-untracked';

/**
 * Four `uid`s against up to twelve entries -- so several entries per `uid` is
 * the common case, matching the live four-entries-per-SID shape.
 */
const REPORTABLE_UIDS = [...TRACKED_UIDS, UNTRACKED_UID];

/** Fixed epoch the generated millisecond offsets are relative to. */
const BASE_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

/**
 * A deliberately TINY pool of reported offsets. Drawing repeatedly from four
 * values makes equal reported times, and reported times that go backward within
 * one payload, the norm.
 */
const REPORTED_OFFSETS = [0, 1000, 2000, 3000];

/** Ahead of every reportable offset: a stored value no reported time can advance. */
const AHEAD_OF_EVERYTHING = Math.max(...REPORTED_OFFSETS) + 5000;

/** Every `lastEventTime` shape that must leave a stored Last_Seen untouched. */
const UNUSABLE_LAST_EVENT_TIMES = [undefined, null, '', '   ', 'whenever', NaN, {}];

/**
 * `word` in an arbitrary mixture of cases. Requirement 20.5 compares
 * case-insensitively, so `connECTed` must count exactly as `Connected` does.
 *
 * @param {string} word
 */
function randomCaseArb(word) {
  return fc
    .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((upper) =>
      word
        .split('')
        .map((character, index) => (upper[index] ? character.toUpperCase() : character.toLowerCase()))
        .join('')
    );
}

/**
 * Every `lastStatus` shape Requirement 20.5 enumerates: `Connected` and
 * `Disconnected` in arbitrary casing, absent, null, other strings, and a
 * non-string. Only `connected` (case-insensitively) may produce a connected
 * verdict; everything else must not.
 */
const lastStatusArb = fc.oneof(
  { weight: 5, arbitrary: randomCaseArb('Connected') },
  { weight: 5, arbitrary: randomCaseArb('Disconnected') },
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constantFrom('', 'Unknown', 'CONNECTING', 'connect', ' Connected') },
  { weight: 1, arbitrary: fc.oneof(fc.integer(), fc.boolean()) }
);

/** One generated `ClientEndpoint`. */
const entryArb = fc.record({
  uid: fc.constantFrom(...REPORTABLE_UIDS),
  reported: fc.oneof(
    { weight: 8, arbitrary: fc.constantFrom(...REPORTED_OFFSETS) },
    { weight: 2, arbitrary: fc.constantFrom(...UNUSABLE_LAST_EVENT_TIMES) }
  ),
  lastStatus: lastStatusArb
});

/**
 * A generated payload together with a PERMUTATION of the same entries. The
 * collapse rule is order-independent by definition (Requirement 20.5), so both
 * orders must produce the same stored state and the same per-uid writes.
 */
const payloadArb = fc.array(entryArb, { maxLength: 12 }).chain((entries) =>
  fc.tuple(
    fc.constant(entries),
    fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length })
  )
);

/**
 * Pre-existing Device_Table state for one tracked Device. `lastSeenAt` is drawn
 * from the reported pool -- so it is frequently EQUAL to, or ahead of, what this
 * poll reports -- plus null (never seen) and one value ahead of every reportable
 * offset. `connected` starts either way, so a poll must be seen to overwrite a
 * stale `true` as well as to set a fresh one.
 */
const initialRowArb = fc.record({
  lastSeenAt: fc.oneof(
    { weight: 2, arbitrary: fc.constant(null) },
    { weight: 5, arbitrary: fc.constantFrom(...REPORTED_OFFSETS) },
    { weight: 2, arbitrary: fc.constant(AHEAD_OF_EVERYTHING) }
  ),
  connected: fc.boolean(),
  // A revoked row must NEVER be marked connected by a poll: the per-uid write
  // is `connected = ($3 AND revoked = false)`, so a revoked Device resolves to
  // `connected = false` whatever the payload reported for it. Generated here
  // (weighted toward false, the common case) so the property exercises both a
  // revoked row a poll tries to connect and a non-revoked one.
  revoked: fc.oneof(
    { weight: 4, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) }
  )
});

const tableArb = fc.tuple(...TRACKED_UIDS.map(() => initialRowArb));

/**
 * Whether a generated `reported` value is a usable offset from `BASE_MS`. `NaN`
 * is one of the unusable values and is a `number`, so a `typeof` check alone
 * would let it through as a timestamp.
 *
 * @param {unknown} reported
 */
function isUsableOffset(reported) {
  return typeof reported === 'number' && Number.isFinite(reported);
}

/**
 * The wire shape the poller consumes. `lastStatus` is OMITTED rather than set to
 * `undefined` for the absent case, since that is the shape TAK Server sends.
 *
 * @param {{uid: string, reported: unknown, lastStatus: unknown}} entry
 */
function toClientEndpoint(entry) {
  const endpoint = {
    callsign: `CALLSIGN-${entry.uid}`,
    uid: entry.uid,
    username: 'alice',
    team: 'Cyan',
    role: 'Team Member',
    lastEventTime: isUsableOffset(entry.reported)
      ? new Date(BASE_MS + entry.reported).toISOString()
      : entry.reported
  };

  if (entry.lastStatus !== undefined) endpoint.lastStatus = entry.lastStatus;

  return endpoint;
}

/**
 * The expected per-`uid` verdicts, computed straight from the generated data by
 * the requirement's rules and NOT by the implementation's:
 *
 *   - `time`: the GREATEST parseable reported time, or null when this payload
 *     carried none for that `uid` (Requirement 13.6).
 *   - `connected`: ANY entry for that `uid` whose `lastStatus` lowercases to
 *     `connected` (Requirement 20.5) -- including an entry whose
 *     `lastEventTime` was unusable, whose Last_Seen contribution is skipped but
 *     whose status must still count (Requirement 20.4).
 *
 * Insertion order is first-seen order, which is the order the poller issues its
 * per-uid writes in.
 *
 * @param {Array<{uid: string, reported: unknown, lastStatus: unknown}>} entries
 * @returns {Map<string, {time: number|null, connected: boolean}>}
 */
function collapseReported(entries) {
  const reported = new Map();

  for (const entry of entries) {
    const time = isUsableOffset(entry.reported) ? BASE_MS + entry.reported : null;
    const connected =
      typeof entry.lastStatus === 'string' && entry.lastStatus.toLowerCase() === 'connected';

    const incumbent = reported.get(entry.uid);
    if (incumbent === undefined) {
      reported.set(entry.uid, { time, connected });
      continue;
    }

    if (connected) incumbent.connected = true;
    if (time !== null && (incumbent.time === null || time > incumbent.time)) incumbent.time = time;
  }

  return reported;
}

/**
 * The CloudTAK_Connection_Prefix, restated here rather than imported: the
 * expectations below are re-derived from Requirement 22.2/22.3's rule so they
 * stay independent of the derivation they are checking against.
 */
const CLOUDTAK_CONNECTION_PREFIX = 'ANDROID-CloudTAK-';

/**
 * The Candidate_Client_Uids one reported uid identifies, per the rule itself:
 * the reported uid alone unless it carries the CloudTAK_Connection_Prefix
 * (compared case-insensitively), in which case its two certificate-suffixed
 * forms follow it (Requirements 22.2, 22.3).
 *
 * @param {string} uid
 * @returns {Array<string>}
 */
function expectedCandidates(uid) {
  if (!uid.toLowerCase().startsWith(CLOUDTAK_CONNECTION_PREFIX.toLowerCase())) return [uid];

  const base = uid.slice(CLOUDTAK_CONNECTION_PREFIX.length);
  return [uid, `${base} (Web)`, `${base} (ETL)`];
}

/**
 * "The reported set" as design.md's Property 17 was AMENDED IN PLACE to read
 * (Requirement 22.6): the deduplicated, first-seen-ordered UNION of every
 * reported entry's Candidate_Client_Uids, not the raw reported `uid` values. For
 * a payload of native uids -- which is what this property generates -- the two
 * readings are identical, which is why the property text is amended rather than
 * renumbered; Property 18 is what pins the derivation and the mixed-payload
 * sweep union down.
 *
 * @param {Array<string>} uids
 * @returns {Array<string>}
 */
function expectedReportedSet(uids) {
  const union = [];

  for (const uid of uids) {
    for (const candidate of expectedCandidates(uid)) {
      if (!union.includes(candidate)) union.push(candidate);
    }
  }

  return union;
}

/** Entries whose `lastEventTime` this poll cannot use (Requirement 13.6). */
function countUnusableEntries(entries) {
  return entries.filter((entry) => !isUsableOffset(entry.reported)).length;
}

/**
 * Builds the in-memory Device_Table from a generated initial state.
 *
 * @param {Array<{lastSeenAt: number|null, connected: boolean}>} initialRows
 * @returns {Map<string, {lastSeenAt: Date|null, connected: boolean}>}
 */
function createTable(initialRows) {
  return new Map(
    TRACKED_UIDS.map((uid, index) => [
      uid,
      {
        lastSeenAt: initialRows[index].lastSeenAt === null ? null : new Date(BASE_MS + initialRows[index].lastSeenAt),
        connected: initialRows[index].connected,
        revoked: initialRows[index].revoked
      }
    ])
  );
}

/** A comparable snapshot of the table's state. */
function snapshot(table) {
  return Object.fromEntries(
    [...table].map(([uid, row]) => [
      uid,
      { lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.getTime(), connected: row.connected, revoked: row.revoked }
    ])
  );
}

/**
 * A pool that INTERPRETS each statement against `table` -- reading its `SET`
 * list and `WHERE` clause and doing what they say -- rather than accepting only
 * the shape the implementation currently sends. See the file header: this is what
 * makes the two regressions of interest fail on behaviour.
 *
 * @param {Map<string, {lastSeenAt: Date|null, connected: boolean}>} table
 * @param {{statements: Array, unscoped: Array<string>, unmodelled: Array<string>}} log
 */
function createModelPool(table, log) {
  return {
    query: jest.fn(async (sql, params = []) => {
      if (typeof sql !== 'string' || !sql.includes('UPDATE tak_devices')) {
        log.unmodelled.push(String(sql));
        return { rowCount: 0 };
      }

      log.statements.push([sql, params]);

      const whereIndex = sql.search(/\bWHERE\b/);
      const setClause = sql.slice(sql.search(/\bSET\b/), whereIndex === -1 ? undefined : whereIndex);
      const whereClause = whereIndex === -1 ? '' : sql.slice(whereIndex);

      // The unreported-uid sweep (Requirement 20.6): the one statement that
      // writes a LITERAL false.
      if (/connected\s*=\s*false/i.test(setClause)) {
        const scoped = /client_uid <> ALL\(\$1::text\[\]\)/.test(whereClause) && Array.isArray(params[0]);

        // An unscoped sweep is modelled as what it would really be -- a write
        // reaching every row -- so the state assertions below fail on it, on top
        // of the explicit `log.unscoped` assertion.
        if (!scoped) log.unscoped.push(sql);

        const reported = scoped ? new Set(params[0]) : new Set();
        let rowCount = 0;
        for (const [clientUid, row] of table) {
          if (reported.has(clientUid)) continue;
          row.connected = false;
          if (/last_seen_at/.test(setClause)) row.lastSeenAt = null;
          rowCount += 1;
        }

        return { rowCount };
      }

      // The per-uid write. Since the revoked-guard fix the SET form is
      // `connected = ($3 AND revoked = false)` rather than a bare
      // `connected = $3`: a revoked row is never marked connected whatever the
      // poll reported. The model recognises this form and applies the guard
      // below (`connected && !row.revoked`), so a regression that dropped the
      // guard (bare `connected = $3`) would let a revoked row go connected and
      // fail this property on state.
      const bindsConnectedWithRevokedGuard = /connected\s*=\s*\(\s*\$3\s+AND\s+revoked\s*=\s*false\s*\)/i.test(setClause);
      if (!bindsConnectedWithRevokedGuard) {
        log.unmodelled.push(sql);
        return { rowCount: 0 };
      }

      const [clientUids, lastEventTime, connected] = params;
      if (!Array.isArray(clientUids)) {
        // Since task 30.2 the per-entry write is targeted at the entry's
        // Candidate_Client_Uids array, never a single `client_uid`
        // (Requirement 22.4).
        log.unmodelled.push(`candidate client_uids not bound as an array: ${String(clientUids)}`);
        return { rowCount: 0 };
      }
      if (typeof connected !== 'boolean') {
        log.unmodelled.push(`connection status not bound as a boolean: ${String(connected)}`);
        return { rowCount: 0 };
      }
      if (lastEventTime !== null && !(lastEventTime instanceof Date && Number.isFinite(lastEventTime.getTime()))) {
        // Requirement 13.6: an unusable reported time must reach the database as
        // `null`, never as an invalid Date or an unparseable string.
        log.unmodelled.push(`reported lastEventTime not bound as a Date or null: ${String(lastEventTime)}`);
        return { rowCount: 0 };
      }
      if (!/client_uid = ANY\(\$1::text\[\]\)/.test(whereClause)) log.unscoped.push(sql);

      // `= ANY($1::text[])` matches EVERY row named by the candidate array, so
      // the model applies the statement once per matched row (Requirements 22.4,
      // 22.8) and a candidate naming no row contributes nothing.
      let rowCount = 0;
      for (const clientUid of clientUids) {
        const row = table.get(clientUid);
        if (row === undefined) continue;

        const advances =
          lastEventTime !== null &&
          (row.lastSeenAt === null || row.lastSeenAt.getTime() < lastEventTime.getTime());

        // THE REGRESSION, modelled faithfully: with the clamp back in the
        // `WHERE` clause the row does not match for a non-advancing reported
        // time, so NOTHING is written -- not the timestamp and not the status.
        // That is exactly what Requirement 20.3 forbids, and it is what this
        // branch makes visible as wrong state rather than as an unrecognised
        // statement.
        if (/last_seen_at/.test(whereClause) && !advances) continue;

        rowCount += 1;
        // The revoked guard from the SET form: a revoked row is never connected.
        row.connected = connected && !row.revoked;

        if (/last_seen_at = CASE/.test(setClause)) {
          if (advances) row.lastSeenAt = lastEventTime;
        } else if (/last_seen_at = \$2/.test(setClause)) {
          // An unclamped write, which Property 3 forbids; modelled so it shows
          // up as a rewound timestamp.
          row.lastSeenAt = lastEventTime;
        }
      }

      return { rowCount };
    })
  };
}

/**
 * Drives ONE real `SubscriptionPoller.run()` over `entries` against a fresh
 * table built from `initialRows`.
 *
 * @param {Array<object>} entries
 * @param {Array<{lastSeenAt: number|null, connected: boolean}>} initialRows
 */
async function runPoll(entries, initialRows) {
  const table = createTable(initialRows);
  const log = { statements: [], unscoped: [], unmodelled: [] };
  const pool = createModelPool(table, log);
  const takServerService = {
    getClientEndpoints: jest.fn().mockResolvedValue(entries.map(toClientEndpoint)),
    // Requirement 13 freshening follow-up: kept a no-op throughout this model
    // (which is about Connection_Status/Property 17, not the freshening
    // merge -- that has its own coverage in SubscriptionPoller.test.js), so
    // `summary.freshened` is always 0 here.
    getAllSubscriptions: jest.fn().mockResolvedValue([])
  };

  const summary = await new SubscriptionPoller({ takServerService, pool }).run();

  return { table, log, pool, summary };
}

/**
 * The per-entry writes a run issued, as `[sql, [candidateClientUids, time,
 * connected]]`. Discriminated on the STATEMENT rather than on the parameter
 * shape: since task 30.2 both statements bind an array as `$1`, so the parameter
 * shape no longer tells them apart (Requirement 22.4).
 */
function perUidWrites(log) {
  // The per-uid write binds `$3` inside the revoked-guarded form
  // `connected = ($3 AND revoked = false)`; the sweep writes a literal false and
  // binds no `$3`, so keying on the `$3` bind still tells the two apart.
  return log.statements.filter(([sql]) => /connected\s*=\s*\(\s*\$3\s+AND\s+revoked\s*=\s*false\s*\)/i.test(sql));
}

/** The unreported-uid sweeps a run issued -- the only statement writing a literal false. */
function sweeps(log) {
  return log.statements.filter(([sql]) => /connected\s*=\s*false/i.test(sql));
}

// Feature: device-management, Property 17: One poll writes current status for every reported UID, independently of the monotonic guard
describe('Property 17: One poll writes current status for every reported UID, independently of the monotonic guard', () => {
  test.prop([tableArb, payloadArb], { numRuns: 200 })(
    'writes the collapsed status for every reported uid whatever the reported time did, clamps last_seen_at alone, and scopes the unreported sweep to the reported uids',
    async (initialRows, [entries, permutedEntries]) => {
      const { table, log, pool, summary } = await runPoll(entries, initialRows);

      const expected = collapseReported(entries);
      const reportedUids = [...expected.keys()];
      const trackedReported = reportedUids.filter((uid) => TRACKED_UIDS.includes(uid));

      // --- the exact statements and parameters (Requirements 20.3, 20.6) ---

      // One write per reported uid, in first-seen order, carrying the greatest
      // parseable reported time (or null) and the collapsed verdict. No entry is
      // dropped for an unusable timestamp: its uid is still written.
      // Each write is targeted at that entry's Candidate_Client_Uids rather
      // than its raw `uid` (Requirement 22.4, the same in-place amendment).
      expect(perUidWrites(log).map(([, params]) => params)).toEqual(
        reportedUids.map((uid) => {
          const { time, connected } = expected.get(uid);
          return [expectedCandidates(uid), time === null ? null : new Date(time), connected];
        })
      );

      // Exactly one sweep, parameterised by the reported set -- including when
      // that set is EMPTY, which is the correct reading of a poll that reported
      // nothing rather than a reason to skip the write.
      expect(sweeps(log)).toHaveLength(1);
      const [[sweepSql, sweepParams]] = sweeps(log);
      expect(sweepParams).toEqual([expectedReportedSet(reportedUids)]);
      expect(sweepSql).toMatch(/WHERE\s+client_uid <> ALL\(\$1::text\[\]\)/);
      expect(sweepSql).not.toContain('last_seen_at');

      // Nothing unscoped by `client_uid`, and nothing this model could not read.
      expect(log.unscoped).toEqual([]);
      expect(log.unmodelled).toEqual([]);
      expect(pool.query).toHaveBeenCalledTimes(reportedUids.length + 1);

      // --- the resulting state ---

      for (const [index, uid] of TRACKED_UIDS.entries()) {
        const initial = initialRows[index];
        const priorLastSeen = initial.lastSeenAt === null ? null : BASE_MS + initial.lastSeenAt;
        const verdict = expected.get(uid);
        const row = table.get(uid);

        if (verdict === undefined) {
          // Unreported: to not connected (Requirement 20.6), with `last_seen_at`
          // untouched (Requirement 3.4).
          expect(row.connected).toBe(false);
          expect(row.lastSeenAt === null ? null : row.lastSeenAt.getTime()).toBe(priorLastSeen);
          continue;
        }

        // Reported: the collapsed status landed, whatever the reported time did.
        // This is the load-bearing assertion of Requirement 20.3 -- for the
        // frequent generated cases where the reported time is equal to or behind
        // the stored one, a status write sharing the Monotonic_Guard's `WHERE`
        // clause writes nothing at all and this fails.
        //
        // The revoked guard: a revoked row is NEVER connected, whatever the poll
        // reported (`connected = ($3 AND revoked = false)`). So the expected
        // landed status is the collapsed verdict ANDed with not-revoked.
        expect(row.connected).toBe(verdict.connected && !row.revoked);

        // `last_seen_at` keeps exactly its old semantics: the running maximum of
        // the parseable reported times and the stored value (Property 3).
        const expectedLastSeen =
          verdict.time === null
            ? priorLastSeen
            : priorLastSeen === null
              ? verdict.time
              : Math.max(priorLastSeen, verdict.time);
        expect(row.lastSeenAt === null ? null : row.lastSeenAt.getTime()).toBe(expectedLastSeen);
      }

      // A reported uid with no Device_Table row is never inserted.
      expect(table.has(UNTRACKED_UID)).toBe(false);

      // --- the run's own counts ---

      expect(summary).toEqual({
        entries: entries.length,
        observed: reportedUids.filter((uid) => expected.get(uid).time !== null).length,
        skipped: countUnusableEntries(entries),
        freshened: 0,
        updated: trackedReported.length,
        failed: 0,
        connected: reportedUids.filter((uid) => expected.get(uid).connected).length,
        disconnected: reportedUids.filter((uid) => !expected.get(uid).connected).length,
        unreported: TRACKED_UIDS.filter((uid) => !expected.has(uid)).length
      });

      // --- invariance under permutation (Requirement 20.5) ---

      const permuted = await runPoll(permutedEntries, initialRows);

      // Same stored state, and the same per-uid writes as a set -- the ORDER of
      // the writes follows the payload, but neither collapse rule may depend on
      // it.
      expect(snapshot(permuted.table)).toEqual(snapshot(table));
      // Keyed on the reported uid, which is ALWAYS the first candidate
      // (Requirement 22.2), since `$1` is now an array.
      expect(
        new Map(perUidWrites(permuted.log).map(([, params]) => [params[0][0], params]))
      ).toEqual(new Map(perUidWrites(log).map(([, params]) => [params[0][0], params])));
      expect(permuted.summary).toEqual(summary);
      expect(new Set(sweeps(permuted.log)[0][1][0])).toEqual(
        new Set(expectedReportedSet(reportedUids))
      );
    }
  );

  /**
   * The generator's teeth, asserted rather than assumed. A payload whose
   * reported times only ever ADVANCE past the stored value would pass an
   * implementation whose status write sits behind the Monotonic_Guard's `WHERE`
   * clause, so this property is only worth anything if non-advancing reported
   * times are common in what it actually generates.
   */
  it('generates non-advancing reported times for a reported, tracked device in most samples', () => {
    const samples = fc.sample(fc.tuple(tableArb, payloadArb), { numRuns: 200, seed: 20 });

    const withNonAdvancing = samples.filter(([initialRows, [entries]]) => {
      const expected = collapseReported(entries);

      return TRACKED_UIDS.some((uid, index) => {
        const verdict = expected.get(uid);
        if (verdict === undefined || verdict.time === null) return false;
        if (initialRows[index].lastSeenAt === null) return false;

        // Equal or decreasing: the stored value is at least the reported one.
        return BASE_MS + initialRows[index].lastSeenAt >= verdict.time;
      });
    });

    expect(withNonAdvancing.length).toBeGreaterThan(samples.length / 4);
  });
});
