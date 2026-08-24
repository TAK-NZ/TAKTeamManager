const pool = require('../config/database');
const TakServerService = require('./TakServerService');
const { candidateClientUids, unionCandidateClientUids } = require('../utils/connectionAlias');
const logger = require('../config/logger').createLogger('SubscriptionPoller');

/**
 * Subscription_Poller (device-management Requirements 3.1-3.5, 3.7, 3.8, 13;
 * tasks 7.2, 21.2 -- 21.2 wins where they differ).
 *
 * Records each Device's Last_Seen from TAK Server's OWN per-client last-seen
 * history: the Client_Endpoints_API (`GET /Marti/api/clientEndPoints`, OpenAPI
 * `getClientEndpoints` -> `ApiResponseListClientEndpoint`, via
 * `TakServerService.getClientEndpoints()`). An entry is matched to a Device by
 * `tak_devices.client_uid`, and what gets stored is the entry's own reported
 * `lastEventTime`, NEVER the time of the observation (Requirement 3.2).
 *
 * THE TWO IDENTIFIER SPACES COINCIDE FOR NATIVE CLIENTS AND DIVERGE FOR
 * CLOUDTAK (Requirements 13.1, 22.10). An earlier version of this header
 * claimed the two "live in the same identifier space (verified live, e.g.
 * `ANDROID-842f08e120efdbe3`)"; that claim was FALSE, and the cited
 * verification sampled a native ATAK device -- the one case where the two
 * identifiers coincide by accident. For a native ATAK, iTAK or WinTAK Device the
 * reported `ClientEndpoint.uid` and the certificate's `client_uid` ARE the same
 * string, which is what makes this view usable as the Last_Seen source at all.
 * For a CloudTAK Device they are minted in two unrelated places and never
 * coincide:
 *
 *   - the certificate `clientUid` gets its ` (ETL)` suffix from upstream
 *     `@tak-ps/node-tak` v12.24.0 (`lib/api/credentials.ts:82`,
 *     `CredentialCommands.generate()`) and its ` (Web)` suffix from the TAK-NZ
 *     CloudTAK fork ONLY (`api/stateless/lib/authentik-provider.ts:623`, a file
 *     absent upstream) -- giving `ckadmin (ETL)`, `chris@chriselsen.net (Web)`;
 *   - the connection uid is `ANDROID-CloudTAK-${email}` from upstream CloudTAK
 *     (`api/common/connection-config.ts:170`) -- giving
 *     `ANDROID-CloudTAK-chris@chriselsen.net`.
 *
 * Nothing in the reported uid records WHICH of the two certificate paths was
 * taken, which is why both suffixed forms are tried rather than one. So the join
 * is no longer a single equality: it takes the Connection_Alias's
 * Candidate_Client_Uids, derived in `server/utils/connectionAlias.js` -- the one
 * place those rules live, called by both writes below so the two cannot disagree
 * about which rows a reported uid identifies (Requirement 22.1). The derivation
 * rules, their boundaries, the exact-equality discipline and the
 * known-unhandled DN-shaped connection uid are documented there rather than
 * restated here, so there is one place they can drift from.
 *
 * That is the behavioural change task 21.2 makes. The earlier implementation
 * called `getConnectedSubscriptions()` (`GET /Marti/clients`) and stored the
 * observation time, so Last_Seen meant "last seen while our poller happened to
 * observe the device connected": a device offline since before this feature was
 * installed could never acquire a timestamp, and history had to be
 * reconstructed by repeated polling. Both halves of that were wrong:
 *
 *   - `/Marti/clients` does not exist on TAK Server. It answers 404 and is
 *     absent from `tak-server-openapispec.json` entirely, so the source method
 *     was DELETED rather than repointed (Requirement 14.4) -- with the old
 *     graceful-404-as-empty handling in front of it, its non-existence read as
 *     "no clients observed", `last_seen_at` stayed null forever, and nothing
 *     was ever logged as wrong (Requirement 14.5).
 *   - The Client_Endpoints_API has real history, so repeated polling is no
 *     longer the mechanism by which Last_Seen accumulates (Requirement 13.3).
 *
 * `lastStatus` is deliberately NOT FILTERED on (Requirements 3.2, 13.7): the
 * disconnected entries are the ones carrying the timestamps this feature exists
 * to show. Verified live: of 48 entries, 46 were `lastStatus: "Disconnected"`
 * and only 2 `"Connected"`, so requiring `Connected` would discard almost the
 * entire result. `showCurrentlyConnectedClients` is likewise never sent
 * (Requirement 13.7); this job passes no query parameters at all.
 *
 * NOT FILTERED ON is not the same as NOT READ, and since task 28.2 the
 * difference matters: `lastStatus` IS read, as the Connection_Status source
 * (Requirement 20.5). That narrows nothing here -- every entry still
 * contributes its `lastEventTime` whatever its status, which is all
 * Requirement 3.2 ever said.
 *
 * `GET /Marti/api/subscriptions/all` was rejected as the source: its
 * `SubscriptionInfo.clientUid` was empty in 14 of 16 live entries, so most rows
 * cannot be joined to a Device (Requirement 13.2).
 *
 * Last_Seen is derived ONLY from TAK Server's Marti HTTP API -- this feature
 * never queries TAK Server's `cot_router` table or any TAK Server database
 * (Requirement 3.6). It is what TAK Server itself reports, not a
 * guaranteed-complete connection history: TAK Server may retain no entry for a
 * Device, in which case `last_seen_at` stays NULL and the UI presents "never
 * seen" (Requirements 3.5, 3.7).
 *
 * Shape mirrors `ExpiryScheduler` / `RetentionCleanupJob` / the sibling
 * `DeviceSync` exactly (design.md's "Scheduled jobs" note): a constructor that
 * clamps an interval from an environment variable, a `start()` that runs one
 * pass immediately and then schedules a recurring `setInterval`, an idempotent
 * `stop()` that `clearInterval`s, and a `run()` that never throws.
 *
 * The Device_Mgmt_Enabled gate lives in the Sync_Worker wiring, not here
 * (Requirement 1.6): `SyncWorker.start()` only calls `start()` on this job
 * WHILE `isDeviceMgmtEnabled()` is true, so a disabled deployment never
 * constructs a timer and never calls the Client_Endpoints_API.
 */
class SubscriptionPoller {
  /**
   * @param {Object} [options]
   * @param {import('./TakServerService')} [options.takServerService] the single
   *   shared `TakServerService` instance (the same one the Admin_Credential_
   *   Loader refreshes and the `revoke_tak_certificates` handler uses, per
   *   Requirement 2.8), so a rotated credential applies to polling too.
   * @param {{query: function(string, Array=): Promise<{rowCount: number}>}} [options.pool]
   *   the database pool; defaults to the shared `config/database` pool and is
   *   injectable so `run()` is unit-testable against a mocked pool.
   */
  constructor({ takServerService = new TakServerService(), pool: dbPool = pool } = {}) {
    this.takServerService = takServerService;
    this.pool = dbPool;

    // Requirement 3.1 ("a scheduled cadence"): design.md's stated default for
    // this poller is ~5 minutes. As with `RetentionCleanupJob`, neither
    // requirements.md nor design.md imposes a hard upper bound on this
    // cadence (unlike `ExpiryScheduler`'s 15-minute vendor-grant SLA cap), so
    // only a lower bound is clamped here -- guarding against a misconfigured
    // near-zero interval turning this into a tight loop against TAK Server
    // and the database. Same `parseInt(...) || <default>` + `Math.max` clamp
    // pattern the sibling schedulers use.
    const MIN_INTERVAL_MS = 60000; // 1 minute
    const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    this.intervalMs = Math.max(
      MIN_INTERVAL_MS,
      parseInt(process.env.DEVICE_MGMT_POLL_INTERVAL_MS, 10) || DEFAULT_INTERVAL_MS
    );

    this.timer = null;
  }

  /**
   * Starts the poller: runs one poll immediately, then schedules a recurring
   * poll every `this.intervalMs`. A no-op if already running (mirrors
   * `ExpiryScheduler.start()`'s / `RetentionCleanupJob.start()`'s idempotency
   * against a double start).
   */
  start() {
    if (this.timer) return;

    logger.info({ intervalMs: this.intervalMs }, 'Subscription poller started');

    // Run once immediately so a freshly-deployed/restarted worker doesn't wait
    // a full interval before its first read of TAK Server's history.
    this.run();

    this.timer = setInterval(() => {
      this.run();
    }, this.intervalMs);
  }

  /**
   * Stops the poller, clearing the recurring interval. A no-op if not
   * currently running.
   */
  stop() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
    logger.info('Subscription poller stopped');
  }

  /**
   * Runs one poll: reads the Client_Endpoints_API and records each matching
   * Device's Last_Seen as that entry's reported `lastEventTime`
   * (Requirements 3.2, 13.1), under the Monotonic_Guard (Requirements 3.3,
   * 13.4).
   *
   * Requirements 3.8, 14.1: this method NEVER throws, so nothing here can
   * crash or exit the Sync_Worker process. A failed fetch ends the run before
   * anything is written, so every stored `last_seen_at` is left exactly as it
   * was and the next tick retries. It is NOT degraded to an empty endpoint
   * list. A failure on an individual row update is logged and the remaining
   * entries still get recorded, since each update is independent and
   * idempotent.
   *
   * A run is reported failed for EVERY failure mode of the fetch -- a 404, any
   * other 4xx, a 5xx, a transport error, a timeout, and a malformed (non-list)
   * payload -- and each of those ends the run before a single `UPDATE` is
   * issued.
   *
   * Requirements 14.1, 14.5 -- how a failed run is REPORTED (task 23.2). The
   * report lives in the Structured_Logger, which is the channel Requirement
   * 14.1 names and the only one an operator ever sees: nothing in the process
   * reads this method's return value (`start()` fires `run()` from
   * `setInterval` and discards the promise's value). So every run ends with
   * exactly one terminal log line carrying an explicit `outcome` field --
   * `'failed'` at error level, with the `endpoint` and the HTTP `status`, or
   * `'completed'` at info level with the run's counts -- rather than leaving
   * the outcome to inference. A poll that legitimately found nothing is
   * therefore still an affirmative `outcome=completed`, `entries=0` line, never
   * silence, which is what keeps it distinguishable from "the request was
   * wrong" (Requirement 14.5).
   *
   * The RETURN value is deliberately unchanged -- counts on success,
   * `undefined` on failure -- which is already a total, unambiguous
   * discrimination for a caller (there is no third state) and keeps this
   * method's contract identical to the sibling `DeviceSync.run()`.
   *
   * Requirement 20.3-20.7 (task 28.2): a SUCCESSFUL run also writes
   * Connection_Status. That happens in two statements, and both sit behind
   * every early return above -- a failed fetch or a non-list payload writes no
   * status at all, so a TAK Server outage can never read as every Device
   * having gone offline (Requirement 20.7):
   *
   *   1. `recordLastSeen()` per reported `uid`, which writes `connected`
   *      unconditionally while clamping `last_seen_at` alone.
   *   2. `clearUnreportedConnections()` once, which sets `connected = false`
   *      for the Device_Table rows this poll saw no entry for -- scoped to
   *      those `client_uid`s, and leaving their `last_seen_at` exactly as it
   *      was (Requirements 20.6, 3.4).
   *
   * Requirement 22 (task 30): both of those are targeted at the reported uid's
   * Candidate_Client_Uids rather than at the raw reported uid -- the per-entry
   * write at that entry's candidates, and the sweep at the UNION of every
   * entry's candidates. The union is not tidiness: a CloudTAK row step 1 just
   * marked connected is by construction ABSENT from the raw reported uids, so a
   * sweep keyed on those would unmark it inside the same poll and the whole
   * alias would be invisible (Requirement 22.6).
   *
   * @returns {Promise<{entries: number, observed: number, skipped: number,
   *   updated: number, failed: number, connected: number,
   *   disconnected: number, unreported: number}|undefined>} per-run counts --
   *   `ClientEndpoint` entries returned, reported `uid`s carrying a parseable
   *   `lastEventTime`, entries skipped for the Last_Seen write, DEVICE_TABLE
   *   ROWS the per-uid writes matched (not reported `uid`s: one entry's
   *   Candidate_Client_Uids may match more than one row -- Requirement 22.8),
   *   writes that errored, reported `uid`s
   *   collapsed to connected and to not connected, and rows set not connected
   *   for having gone unreported -- or `undefined` when the fetch failed or
   *   returned a malformed payload -- already logged with `outcome: 'failed'`,
   *   having touched no `last_seen_at` and no `connected`.
   */
  async run() {
    let clientEndpoints;
    try {
      // Requirements 3.1, 13.7: no query parameters -- in particular never
      // `showCurrentlyConnectedClients`, which would drop the disconnected
      // entries that carry the timestamps of interest.
      clientEndpoints = await this.takServerService.getClientEndpoints();
    } catch (error) {
      // Requirements 3.8, 14.1, 14.2: `/Marti/api/clientEndPoints` is
      // documented in `tak-server-openapispec.json`, so ANY failure -- a 404
      // included -- means the request was wrong, not that no client has ever
      // been seen. Log it, leave every `last_seen_at` unchanged, retry next
      // tick. Never degraded to an empty result set.
      //
      // Requirement 14.1 asks for the endpoint AND the status; Requirement
      // 14.5 for an outcome a legitimately-empty poll can never be mistaken
      // for. `endpoint` keeps the value it always had -- this job calls exactly
      // one endpoint, and `describeFetchFailure` resolves to that same path
      // whether it reads it off the rejection or falls back to the literal.
      logger.error(
        {
          err: error,
          ...describeFetchFailure(error, [CLIENT_ENDPOINTS_PATH]),
          outcome: 'failed'
        },
        'Subscription poll failed to reach the client endpoints API; leaving last-seen values unchanged'
      );
      return undefined;
    }

    // Requirements 3.8, 14.1, 14.5: a payload that is not a list is a MALFORMED
    // response, not an empty history, and is reported as a failed run -- it used
    // to be coerced to `[]`, which is the same silent degradation the old
    // 404-as-empty handling performed: every `last_seen_at` would stay as it was
    // with nothing logged, the exact symptom this requirement exists to kill.
    // This does NOT contradict `TakServerService`'s one tolerated absence
    // (Requirement 14.3): a 200 whose `ApiResponse` omits `data` legitimately
    // means "no client has been seen" and `unwrapArray()` still yields `[]`, an
    // array, which reaches the completed path below as the legitimately-empty
    // history case. Only a shape this job cannot read as an entry list lands
    // here.
    if (!Array.isArray(clientEndpoints)) {
      logger.error(
        {
          endpoint: CLIENT_ENDPOINTS_PATH,
          payloadType: describePayloadType(clientEndpoints),
          outcome: 'failed'
        },
        'Subscription poll received a malformed client endpoints payload; leaving last-seen values unchanged'
      );
      return undefined;
    }

    const entries = clientEndpoints;

    const { reportedByUid, skipped } = extractLastEventTimes(entries);

    const counts = {
      entries: entries.length,
      // Reported `uid`s whose Last_Seen this poll can move. Deliberately NOT
      // `reportedByUid.size` any more: since task 28.2 that map also holds the
      // `uid`s whose `lastEventTime` was unusable, which contribute a status
      // but no timestamp (Requirements 13.6, 20.4).
      observed: countWithUsableTime(reportedByUid),
      skipped,
      updated: 0,
      failed: 0,
      connected: 0,
      disconnected: 0,
      unreported: 0
    };

    for (const [clientUid, { lastEventTime, connected }] of reportedByUid) {
      // Counted from what TAK Server reported, before the write is attempted:
      // these two are the poll's own view of the fleet, not a write tally.
      if (connected) counts.connected += 1;
      else counts.disconnected += 1;

      try {
        // Requirement 22.1/22.4/22.5: the write is targeted at this reported
        // uid's Candidate_Client_Uids, which ALWAYS include the reported uid
        // itself -- so a native Device matches exactly as it did before.
        // `rowCount` therefore counts Device_Table ROWS, which a prefixed uid
        // may legitimately match twice (`<base> (Web)` and `<base> (ETL)`,
        // Requirement 22.8); the arithmetic is unchanged, the meaning is
        // "rows matched" rather than "reported uids matched".
        const result = await this.recordLastSeen(
          candidateClientUids(clientUid),
          lastEventTime,
          connected
        );
        counts.updated += result?.rowCount || 0;
      } catch (error) {
        // One bad row must not cost the rest of this poll its updates.
        counts.failed += 1;
        logger.error({ err: error, clientUid }, 'Failed to record last-seen for reported device');
      }
    }

    // Requirement 20.6: on a successful run only, every Device_Table row this
    // poll saw no entry for goes to not connected. Issued even when the
    // reported set is EMPTY -- a poll that legitimately returned nothing is
    // positive evidence that nothing is connected, and skipping it there would
    // leave a stale `true` standing forever in exactly the case where TAK
    // Server dropped its entries, which is the defect this criterion exists to
    // prevent. `last_seen_at` is untouched by that statement (Requirement 3.4).
    //
    // Requirement 22.6 -- THE LOAD-BEARING INTERACTION, do not "simplify" this
    // back to `[...reportedByUid.keys()]`. The excluded set is the UNION of
    // every reported entry's Candidate_Client_Uids, not the raw reported uids. A
    // CloudTAK row the loop above just marked connected is, by construction,
    // absent from the raw reported uids -- that absence IS the defect this
    // section closes -- so a sweep keyed on the raw keys would set it straight
    // back to false inside this same poll, and the fix would be invisible on the
    // UI while every per-entry test still passed. The union is deduplicated and
    // first-seen ordered, so for a native-only payload it is exactly the
    // reported set this call has always been given.
    const excludedClientUids = unionCandidateClientUids([...reportedByUid.keys()]);

    try {
      const cleared = await this.clearUnreportedConnections(excludedClientUids);
      counts.unreported = cleared?.rowCount || 0;
    } catch (error) {
      // Same isolation as the per-uid writes: a failure here costs this poll
      // the unreported sweep, not the updates it already made, and never
      // throws out of `run()` (Requirements 3.8, 14.1).
      counts.failed += 1;
      // `reported` keeps meaning what it has always meant -- the number of
      // reported `uid`s. The candidate count is a different number and gets its
      // OWN field rather than quietly displacing that one.
      logger.error(
        {
          err: error,
          reported: reportedByUid.size,
          excludedCandidates: excludedClientUids.length
        },
        'Failed to clear connection status for unreported devices'
      );
    }

    // Requirement 14.5: logged at INFO, not DEBUG. `LOG_LEVEL` defaults to
    // `info` (see `config/logger.js`), so a debug-level completion line means a
    // deployment where a poll that legitimately found nothing emits NO log line
    // at all -- and "no line" is exactly the signature the original defect had,
    // indistinguishable from the poller never running. At info level the empty
    // poll states itself positively (`outcome: 'completed'`, `entries: 0`) and
    // the failed one states itself at error level (`outcome: 'failed'`), so
    // "TAK Server reported nothing" and "the request was wrong" can be told
    // apart at a glance and by a search for `outcome`. Mirrors the sibling
    // `DeviceSync.run()`'s completion line, which was already at info.
    logger.info({ ...counts, outcome: 'completed' }, 'Subscription poll completed');

    return counts;
  }

  /**
   * Writes one reported Device's Connection_Status, and its reported
   * `lastEventTime` under the Monotonic_Guard, in ONE statement
   * (Requirements 3.2, 3.3, 3.4, 13.1, 13.4, 20.3, 20.4).
   *
   * ==========================================================================
   * DO NOT MOVE THE CLAMP BACK INTO THE `WHERE` CLAUSE.
   * ==========================================================================
   *
   * This statement used to read
   *
   *   UPDATE tak_devices SET last_seen_at = $2
   *    WHERE client_uid = $1 AND (last_seen_at IS NULL OR last_seen_at < $2)
   *
   * and that `WHERE` clause is a DELIBERATE no-match for a non-advancing
   * reported time -- exactly right for a running maximum, and exactly wrong for
   * current state. A Device that is connected RIGHT NOW is precisely the case
   * where TAK Server may report the same `lastEventTime` it reported last poll,
   * so a `connected` write riding on that predicate would never fire for the
   * Devices most likely to be connected. Connection_Status is current state,
   * not a running maximum (Requirement 20.3, the load-bearing constraint of
   * that requirement). Hence: the `WHERE` narrows to the Device, and the clamp
   * lives in the `SET` list where it governs `last_seen_at` alone.
   *
   * `last_seen_at` keeps its exact previous semantics -- never rewound, never
   * nulled, so design.md's Property 3 is unchanged. The `$2::timestamptz IS
   * NOT NULL` arm is what lets a `uid` whose `lastEventTime` was absent or
   * unparseable still have its status written: `null` binds to `$2`, the `CASE`
   * falls to `ELSE last_seen_at`, and the stored value is left exactly as it
   * was (Requirements 13.6, 20.4).
   *
   * THE `WHERE` NOW TAKES AN ARRAY -- `client_uid = ANY($1::text[])` -- because
   * a reported uid identifies its Connection_Alias's Candidate_Client_Uids
   * rather than one string (Requirements 22.4, 22.5). That widens WHICH ROWS
   * this statement may match and changes NOTHING about what it writes: the
   * clamp stays in the `SET` list governing `last_seen_at` alone, and
   * `connected` stays outside it, written unconditionally. Matching is by
   * string EQUALITY against complete `client_uid` values only -- no `LIKE`, no
   * prefix or substring test, no wildcard (Requirement 22.7).
   *
   * ONE COST, ACCEPTED IN design.md AND RECORDED HERE so a future reader does
   * not "optimise" the guard back into the `WHERE` clause: this statement now
   * MATCHES rows whose `last_seen_at` did not move, so the table's
   * `update_tak_devices_updated_at` trigger bumps their `updated_at`. The old
   * guarded form avoided that. It is the price of writing a second column in
   * the same statement, and it is accepted -- reintroducing the guard to avoid
   * it silently reintroduces the defect above.
   *
   * A consequence for the caller: `rowCount` means "the number of Device_Table
   * rows matched by this entry's candidates", not "Last_Seen moved forward" and
   * no longer 0-or-1. It is legitimately 2 where a base has both a
   * `<base> (Web)` and a `<base> (ETL)` row -- TAK Server reports one connection
   * for the account and nothing in the entry says which certificate established
   * it, so both receive the same Last_Seen and the same Connection_Status; that
   * ambiguity is ACCEPTED rather than resolved (Requirement 22.8). Candidates
   * with no row match nothing -- inserting rows is the Device_Sync's job, not
   * the poller's.
   *
   * Only the candidates of a REPORTED uid are targeted, so Devices this poll saw
   * no entry for keep their `last_seen_at` untouched -- no null, no rewind
   * (Requirement 3.4), and a Device TAK Server has never reported keeps it
   * NULL and is presented as "never seen" (Requirement 3.5). Their
   * `connected` is the separate, separately-scoped concern of
   * `clearUnreportedConnections()` (Requirement 20.6).
   *
   * @param {Array<string>} clientUids the reported uid's Candidate_Client_Uids
   *   (`candidateClientUids()`), which always include the reported
   *   `ClientEndpoint.uid` itself and, for a CloudTAK connection uid, its two
   *   certificate-suffixed forms. Every member is a complete `client_uid`
   *   matched by equality.
   * @param {Date|null} lastEventTime the entry's own reported last-event time,
   *   already parsed, or `null` when it was absent or unparseable (see
   *   `extractLastEventTimes`) -- in which case `last_seen_at` is left alone
   *   and only `connected` is written.
   * @param {boolean} connected the Status_Collapse_Rule's verdict for this
   *   `uid` across every entry that reported it.
   * @returns {Promise<{rowCount: number}>}
   */
  async recordLastSeen(clientUids, lastEventTime, connected) {
    return this.pool.query(
      `UPDATE tak_devices
          SET connected = $3,
              last_seen_at = CASE
                WHEN $2::timestamptz IS NOT NULL
                 AND (last_seen_at IS NULL OR last_seen_at < $2) THEN $2
                ELSE last_seen_at
              END
        WHERE client_uid = ANY($1::text[])`,
      [clientUids, lastEventTime, connected]
    );
  }

  /**
   * Sets `connected = false` for the Device_Table rows whose `client_uid` this
   * poll saw no Client_Endpoints_API entry for (Requirement 20.6). Called ONCE
   * per successful run, never on a failed one.
   *
   * "Connected" is a positive claim that needs evidence from the CURRENT poll.
   * A stale `true` left in place would present a Device as online indefinitely
   * if TAK Server stopped reporting it, whereas this rule's failure mode costs
   * a connected Device its label for at most one poll interval.
   *
   * `WHERE client_uid <> ALL($1::text[])` is the scoping discipline
   * Requirement 20.6 imposes (the same one Requirement 17.3 imposes on the
   * stale-row delete): the statement is parameterised by the reported set and
   * is NEVER issued unrestricted by `client_uid`, so it cannot reach a row this
   * poll positively reported. Note that an EMPTY reported set makes
   * `<> ALL('{}')` true of every row -- which is the correct reading of a poll
   * that reported nothing, not an unscoped write.
   *
   * `last_seen_at` is deliberately absent from the `SET` list: Requirement 3.4
   * is untouched by this statement, so an unreported Device's Last_Seen stays
   * exactly as it was.
   *
   * @param {Array<string>} reportedClientUids every `client_uid` this poll
   *   reported, as the deduplicated UNION of every reported entry's
   *   Candidate_Client_Uids (Requirement 22.6) -- so a row a reported entry just
   *   marked connected through an alias candidate cannot be swept back inside
   *   the same poll. Includes the candidates of entries whose `lastEventTime`
   *   was unusable: an unusable timestamp is still positive evidence that TAK
   *   Server reported the Device (Requirement 20.4).
   * @returns {Promise<{rowCount: number}>} `rowCount` is the number of
   *   Device_Table rows this poll reported no entry for.
   */
  async clearUnreportedConnections(reportedClientUids) {
    return this.pool.query(
      `UPDATE tak_devices
          SET connected = false
        WHERE client_uid <> ALL($1::text[])`,
      [reportedClientUids]
    );
  }
}

/**
 * The single documented endpoint a poll requires (Requirements 3.1, 13.1,
 * 14.2): OpenAPI `getClientEndpoints` in `tak-server-openapispec.json`.
 * Reported as the failing `endpoint` when a rejection does not name one (see
 * `describeFetchFailure`).
 */
const CLIENT_ENDPOINTS_PATH = '/Marti/api/clientEndPoints';

/**
 * Requirement 14.1 ("log the failure as an error ... with the endpoint and the
 * status"): describes a failed documented-endpoint fetch as the two fields the
 * error log carries beyond `err`.
 *
 * `status` is the HTTP status TAK Server answered with, read from the axios
 * convention `error.response.status` -- the same place
 * `syncWorker.classifyTakServerError()` reads it from. It is `null` -- a
 * DEFINED value, never an absent field -- exactly when the request produced no
 * HTTP response at all: a transport failure, DNS or TLS error, or a timeout.
 * So `status: 404` means "the server answered 404, the URL is wrong" while
 * `status: null` means "the server never answered", and the two are told apart
 * in the log without reading the `err` object.
 *
 * `endpoint` prefers the URL the failing request actually used
 * (`error.config.url`, again the axios convention), falling back to the
 * documented endpoint(s) the run required when the rejection carries none (a
 * plain `Error`, or a rejection raised before the request was built). For this
 * job both resolve to the same `/Marti/api/clientEndPoints`, since it is the
 * only endpoint a poll calls.
 *
 * Only plain property reads are used, and every branch returns: this runs
 * INSIDE `run()`'s catch block, so it must not be able to throw and turn a
 * reported failure into a thrown one (Requirement 3.8).
 *
 * Mirrors `DeviceSync`'s identical helper deliberately (as `parseLastEventTime`
 * mirrors its `parseIssuanceTime`), so both jobs report a failed
 * documented-endpoint fetch with exactly the same two fields.
 *
 * @param {unknown} error the rejection from the fetch.
 * @param {Array<string>} fallbackEndpoints the documented endpoint(s) the run
 *   required, used when `error` does not name one.
 * @returns {{endpoint: string, status: number|null}}
 */
function describeFetchFailure(error, fallbackEndpoints) {
  const source = error && typeof error === 'object' ? error : {};

  const response = source.response;
  const rawStatus = response && typeof response === 'object' ? response.status : undefined;
  const status = typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : null;

  const config = source.config;
  const url = config && typeof config === 'object' ? config.url : undefined;
  const endpoint =
    typeof url === 'string' && url.length > 0 ? url : fallbackEndpoints.join(', ');

  return { endpoint, status };
}

/**
 * Names the shape of a payload that could not be read as an entry list, for the
 * malformed-payload error log. `typeof null` is `'object'`, which would be
 * actively misleading in a log line, so null is named as itself. Mirrors
 * `DeviceSync`'s identical helper.
 *
 * @param {unknown} payload
 * @returns {string}
 */
function describePayloadType(payload) {
  if (payload === null) return 'null';
  return typeof payload;
}

/**
 * Reduces a Client_Endpoints_API payload to the newest reported
 * `lastEventTime` per `uid` (Requirements 13.1, 13.6).
 *
 * `getClientEndpoints()` returns `ClientEndpoint` objects as-is from TAK
 * Server, so this is where the payload is made safe to query with:
 *
 *   - An entry that is not an object, or carries no usable `uid`, is skipped
 *     rather than turned into a query with a null parameter -- `client_uid` is
 *     the join key and there is nothing to match without it.
 *   - An entry whose `lastEventTime` is absent or unparseable is skipped, so
 *     that Device's stored Last_Seen is left untouched (Requirement 13.6). It
 *     is never written as NULL and never handed to Postgres as a string it
 *     would reject: an unusable timestamp must cost a Device nothing, not
 *     erase what is already known about it.
 *   - `lastStatus` IS consulted -- it is the Connection_Status source
 *     (Requirement 20.5) -- but it never FILTERS an entry out of the Last_Seen
 *     write (Requirements 3.2, 13.7): a `Disconnected` entry carries exactly
 *     the timestamp this feature shows, so it contributes its `lastEventTime`
 *     like any other.
 *   - Duplicate entries for the same `uid` (TAK Server may report a client
 *     more than once, e.g. per group) collapse to the GREATEST reported time,
 *     so one poll issues at most one update per Device and the winner does not
 *     depend on the order TAK Server happened to return the entries in. The
 *     Monotonic_Guard would reject the older duplicates anyway; collapsing
 *     them here just avoids the wasted round trips.
 *
 * A `Map` is used rather than a plain object so a `uid` such as `__proto__` is
 * an ordinary key, and so iteration order is first-seen order (making the
 * resulting update sequence deterministic for a given payload).
 *
 * Task 28.2 (Requirements 20.4, 20.5) changed the VALUE type from a bare `Date`
 * to `{ lastEventTime, connected }`, for two reasons:
 *
 *   - An entry whose `lastEventTime` is unusable is still skipped for the
 *     Last_Seen write -- it contributes `lastEventTime: null`, which
 *     `recordLastSeen`'s `CASE` leaves the stored value alone for (Requirement
 *     13.6) -- but it is no longer DROPPED, because its `lastStatus` is
 *     evidence about the Device's current connection and an unusable timestamp
 *     must cost a Device its Last_Seen update, not its status (Requirement
 *     20.4). Such an entry therefore still counts in `skipped`, and its `uid`
 *     still appears in the returned map.
 *   - Two collapse rules now run over the entries for one `uid`, and they are
 *     deliberately DIFFERENT. `lastEventTime` keeps the GREATEST-time collapse
 *     unchanged. `connected` uses the Status_Collapse_Rule: ANY entry reporting
 *     `Connected` (case-insensitively) makes the Device connected, because a
 *     Device with one live connection is connected however many stale
 *     per-callsign entries TAK Server also holds for it -- verified live, one
 *     Windows SID returned four entries under different callsigns. Neither rule
 *     depends on the order the entries arrived in (Requirement 20.5).
 *
 * @param {Array<unknown>} clientEndpoints
 * @returns {{reportedByUid: Map<string, {lastEventTime: Date|null,
 *   connected: boolean}>, skipped: number}} one entry per reported `uid`, and
 *   the number of ENTRIES skipped for the Last_Seen write.
 */
function extractLastEventTimes(clientEndpoints) {
  const reportedByUid = new Map();
  let skipped = 0;

  if (!Array.isArray(clientEndpoints)) return { reportedByUid, skipped };

  for (const endpoint of clientEndpoints) {
    const uid = endpoint && typeof endpoint === 'object' ? endpoint.uid : null;

    if (typeof uid !== 'string' || uid.length === 0) {
      skipped += 1;
      continue;
    }

    const connected = isConnectedStatus(endpoint.lastStatus);
    const time = parseLastEventTime(endpoint.lastEventTime);

    if (time === null) {
      // Requirement 13.6: leave this Device's stored Last_Seen alone. NOT a
      // `continue` since task 28.2 -- the entry falls through carrying
      // `lastEventTime: null` so its status still lands (Requirement 20.4).
      skipped += 1;
      logger.warn({ clientUid: uid }, 'Subscription poll skipping client endpoint with no usable lastEventTime');
    }

    const incumbent = reportedByUid.get(uid);

    if (incumbent === undefined) {
      reportedByUid.set(uid, { lastEventTime: time === null ? null : new Date(time), connected });
      continue;
    }

    // Status_Collapse_Rule: ANY connected entry wins (Requirement 20.5).
    if (connected) incumbent.connected = true;

    // GREATEST reported time, unchanged.
    if (time !== null && (incumbent.lastEventTime === null || time > incumbent.lastEventTime.getTime())) {
      incumbent.lastEventTime = new Date(time);
    }
  }

  return { reportedByUid, skipped };
}

/**
 * The Status_Collapse_Rule's per-entry half (Requirement 20.5): whether one
 * `ClientEndpoint.lastStatus` reports a live connection.
 *
 * The classification is TOTAL and defaults to not connected: `Connected` in any
 * casing is the only value that counts, and an absent, null, non-string or
 * unrecognised `lastStatus` -- including `Disconnected` -- counts as not
 * connected. That direction is deliberate: `connected` is a positive claim, so
 * a value this code does not understand must never produce one.
 *
 * @param {unknown} lastStatus
 * @returns {boolean}
 */
function isConnectedStatus(lastStatus) {
  return typeof lastStatus === 'string' && lastStatus.toLowerCase() === 'connected';
}

/**
 * Counts the reported `uid`s carrying a usable `lastEventTime` -- the ones
 * whose Last_Seen this poll can actually move. Reported as `observed`, the
 * meaning that count has always had, which is why it is no longer simply the
 * map's size (see `extractLastEventTimes`).
 *
 * @param {Map<string, {lastEventTime: Date|null}>} reportedByUid
 * @returns {number}
 */
function countWithUsableTime(reportedByUid) {
  let count = 0;
  for (const { lastEventTime } of reportedByUid.values()) {
    if (lastEventTime !== null) count += 1;
  }
  return count;
}

/**
 * Parses a `ClientEndpoint.lastEventTime` to a comparable epoch-millisecond
 * number, or `null` when it is absent or unparseable (Requirement 13.6).
 *
 * The documented shape is an ISO-8601 `date-time` string (e.g.
 * `2026-01-17T01:15:22.160Z`); `Date` instances and finite epoch-millisecond
 * numbers are also accepted, since a caller may hand through already-parsed
 * values. Anything that does not yield a finite time is `null`, which the
 * caller turns into a skipped entry rather than a write. Mirrors
 * `DeviceSync`'s `parseIssuanceTime` deliberately, so the two jobs treat an
 * unusable TAK Server timestamp the same way.
 *
 * @param {unknown} lastEventTime
 * @returns {number|null}
 */
function parseLastEventTime(lastEventTime) {
  if (lastEventTime === null || lastEventTime === undefined) return null;

  if (lastEventTime instanceof Date) {
    return Number.isFinite(lastEventTime.getTime()) ? lastEventTime.getTime() : null;
  }

  if (typeof lastEventTime === 'number') {
    return Number.isFinite(lastEventTime) ? lastEventTime : null;
  }

  if (typeof lastEventTime !== 'string' || lastEventTime.trim() === '') return null;

  const time = Date.parse(lastEventTime);
  return Number.isFinite(time) ? time : null;
}

module.exports = SubscriptionPoller;
module.exports.extractLastEventTimes = extractLastEventTimes;
module.exports.parseLastEventTime = parseLastEventTime;
