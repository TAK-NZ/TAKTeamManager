const pool = require('../config/database');
const TakServerService = require('./TakServerService');
const { candidateClientUids, unionCandidateClientUids } = require('../utils/connectionAlias');
const { withJobLock, JOB_LOCK_KEYS } = require('../utils/jobLock');
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
 * `GET /Marti/api/subscriptions/all` was rejected as the PRIMARY source: its
 * `SubscriptionInfo.clientUid` was empty in 14 of 16 live entries (12 of 14 on
 * a later live check -- the remaining 2 were CloudTAK's own ETL/service
 * ingest connections, identified by `dn` instead), so most rows cannot be
 * joined to a Device (Requirement 13.2). It IS used as a SUPPLEMENTARY
 * freshness signal for the minority of entries that DO carry a `clientUid` --
 * see `mergeSubscriptionFreshness()` below.
 *
 * WHY A SECOND SOURCE AT ALL. `ClientEndpoint.lastEventTime` (the primary
 * source, above) is not a heartbeat: verified live, a CloudTAK connection's
 * `lastStatus` stayed `"Connected"` across many consecutive polls while its
 * `lastEventTime` sat unchanged for over 20 minutes, only advancing when TAK
 * Server next logged a discrete event for it. `SubscriptionInfo.
 * lastReportMilliseconds`, from the SAME live-subscription table TAK
 * Server's own admin UI (`/Marti/clients/index.html`) reads, tracks that same
 * connection's freshness far more granularly -- observed advancing multiple
 * times within one minute. `mergeSubscriptionFreshness()` takes the greater
 * of the two per reported uid, under the same Monotonic_Guard the primary
 * source already applies, so a currently-live connection's Last_Seen reflects
 * whichever source most recently observed it, while a Device this endpoint
 * cannot identify (no `clientUid`, e.g. every ETL connection) is entirely
 * unaffected -- it keeps relying on `lastEventTime` alone, exactly as before.
 *
 * Bugfix (Connection_Status disagreement between TAK Server's two views).
 * `mergeSubscriptionFreshness()` used to touch `lastEventTime` only -- a uid
 * "does NOT gain a `connected` value from this source" was an explicit rule.
 * That rule produced a real defect: TAK Server's two connection-tracking
 * views can disagree about the SAME session, and verified live they did --
 * a CloudTAK session's live-subscription entry reported every few seconds
 * (proving the session was open) while its `clientEndPoints` entry sat at
 * `lastStatus: "Disconnected"` throughout, so the Device_List's "Currently
 * Connected" badge stayed absent for a session that plainly was connected,
 * with its Last_Seen advancing to "just now" every poll the whole time --
 * an inconsistent, confusing combination. Since that bugfix,
 * `mergeSubscriptionFreshness()` also OR's a positive `connected` signal in
 * for any uid this view reports at all: simple PRESENCE in a live-subscription
 * table is itself proof of an open session, independent of whatever
 * `ClientEndpoint.lastStatus` says. This is additive/OR, never a replacement
 * -- `ClientEndpoint.lastStatus: "Connected"` still marks a uid connected on
 * its own, which remains the ONLY signal for the majority of live entries
 * this view cannot identify at all (empty `clientUid`, Requirement 13.2).
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
    // pattern the sibling schedulers use, clamped in seconds and converted to
    // milliseconds once at the end -- the field stays `intervalMs` because
    // `setInterval` takes milliseconds.
    const MIN_INTERVAL_SECONDS = 60; // 1 minute
    const DEFAULT_INTERVAL_SECONDS = 5 * 60; // 5 minutes

    const intervalSeconds = Math.max(
      MIN_INTERVAL_SECONDS,
      parseInt(process.env.DEVICE_MGMT_POLL_INTERVAL_SECONDS, 10) || DEFAULT_INTERVAL_SECONDS
    );
    this.intervalMs = intervalSeconds * 1000;

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
    this.runGuarded();

    this.timer = setInterval(() => {
      this.runGuarded();
    }, this.intervalMs);
  }

  /**
   * The SCHEDULED entry point: `run()` wrapped in the cross-process
   * single-runner advisory lock, so at desiredCount > 1 only one worker polls
   * TAK Server per tick. Running the poll in every worker would double the
   * Marti `clientEndPoints` API load and race on `last_seen_at` (which this
   * job owns as monotonic-forward) for no benefit. `run()` itself is left
   * unguarded so direct/test callers exercise the poll logic without needing a
   * lock. A worker that does not win the lock skips this tick; the next
   * interval retries. `run()` catches its own errors, but the lock's own
   * failure path is caught here so a lock/connection error never becomes an
   * unhandled rejection from the interval callback.
   */
  async runGuarded() {
    try {
      await withJobLock(this.pool, JOB_LOCK_KEYS.SUBSCRIPTION_POLLER, () => this.run());
    } catch (error) {
      logger.error({ err: error }, 'Subscription poll (guarded) failed');
    }
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
   *   freshened: number, updated: number, failed: number, connected: number,
   *   disconnected: number, unreported: number}|undefined>} per-run counts --
   *   `ClientEndpoint` entries returned, reported `uid`s carrying a parseable
   *   `lastEventTime`, entries skipped for the Last_Seen write, reported
   *   `uid`s the live-subscriptions merge advanced beyond the primary
   *   source alone (always 0 when that best-effort fetch failed or found
   *   nothing to advance -- see `mergeSubscriptionFreshness()`), DEVICE_TABLE
   *   ROWS the per-uid writes matched (not reported `uid`s: one entry's
   *   Candidate_Client_Uids may match more than one row -- Requirement 22.8),
   *   writes that errored, reported `uid`s
   *   collapsed to connected and to not connected, and rows set not connected
   *   for having gone unreported -- or `undefined` when the PRIMARY fetch
   *   failed or returned a malformed payload -- already logged with
   *   `outcome: 'failed'`, having touched no `last_seen_at` and no
   *   `connected`. The freshening fetch failing does NOT produce `undefined`
   *   here; see above.
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

    // Requirement 13 freshening follow-up: BEST-EFFORT ONLY. Unlike the fetch
    // above, a failure here must not abort the run or touch `outcome` -- the
    // primary source (`getClientEndpoints()`) is already a complete, correct
    // history on its own, so this second source is additive in the same sense
    // Requirement 22.2 already established for the Connection_Alias:
    // candidates are ADDED beside the reported uid, never substituted for it.
    // A malformed or unreachable freshening source therefore costs this poll
    // only the extra granularity it would have added, logged at WARN (not
    // ERROR, and not `outcome: 'failed'`) precisely so it is never confused
    // with the primary fetch failing.
    let freshened = 0;
    try {
      const liveSubscriptions = await this.takServerService.getAllSubscriptions();
      if (Array.isArray(liveSubscriptions)) {
        freshened = mergeSubscriptionFreshness(reportedByUid, liveSubscriptions);
      } else {
        logger.warn(
          {
            endpoint: LIVE_SUBSCRIPTIONS_PATH,
            payloadType: describePayloadType(liveSubscriptions)
          },
          'Subscription poll received a malformed live-subscriptions payload; skipping last-seen freshening for this poll'
        );
      }
    } catch (error) {
      logger.warn(
        { err: error, endpoint: LIVE_SUBSCRIPTIONS_PATH },
        'Subscription poll failed to reach the live subscriptions API; last-seen freshening skipped for this poll'
      );
    }

    const counts = {
      entries: entries.length,
      // Reported `uid`s whose Last_Seen this poll can move. Deliberately NOT
      // `reportedByUid.size` any more: since task 28.2 that map also holds the
      // `uid`s whose `lastEventTime` was unusable, which contribute a status
      // but no timestamp (Requirements 13.6, 20.4).
      observed: countWithUsableTime(reportedByUid),
      skipped,
      // Reported uids whose `lastEventTime` the live-subscriptions merge above
      // advanced further than the primary source alone would have. Zero on a
      // poll where the freshening fetch failed or found nothing to advance --
      // never a sign that something is wrong, since this whole step is
      // best-effort (see above).
      freshened,
      updated: 0,
      failed: 0,
      connected: 0,
      disconnected: 0,
      unreported: 0
    };

    // Counted AFTER mergeSubscriptionFreshness() has already run above, so a
    // uid its Connection_Status bugfix OR'd to connected -- despite
    // ClientEndpoint.lastStatus disagreeing -- is counted connected here, not
    // just written connected below. These two counts are the poll's own
    // final view of the fleet across BOTH sources, not a write tally.
    for (const [clientUid, { lastEventTime, connected }] of reportedByUid) {
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
 * The freshening source's path (Requirement 13 freshening), named only for
 * log lines -- unlike `CLIENT_ENDPOINTS_PATH` it does not gate a failed-run
 * report, because a failure here costs this poll only the freshening step
 * (Requirement 13.2's rejection of this endpoint as a join-key source is
 * unaffected: this constant exists for logging, not for a new failure path).
 */
const LIVE_SUBSCRIPTIONS_PATH = '/Marti/api/subscriptions/all';

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
 * Merges TAK Server's live subscription table into a poll's reported-uid map,
 * in two INDEPENDENT ways -- see the file header and `TakServerService.
 * getAllSubscriptions()`'s doc comment for why a second source exists at all:
 *
 *   1. ADVANCES `lastEventTime` wherever this source reports a MORE RECENT
 *      observation for the SAME uid than the primary source did this poll (a
 *      currently-live connection's `lastEventTime` can sit unchanged for many
 *      minutes while its live subscription entry advances every few
 *      seconds).
 *   2. Bugfix (Connection_Status disagreement between TAK Server's two
 *      views): OR's a positive `connected` signal in. Simple PRESENCE in
 *      this view is itself evidence of a live connection -- every entry here
 *      is, by construction, a session that is open right now -- so a uid
 *      this source reports is marked connected REGARDLESS of what
 *      `ClientEndpoint.lastStatus` said for it. Verified live: a CloudTAK
 *      session reported here every few seconds while its `clientEndPoints`
 *      entry sat at `lastStatus: "Disconnected"` the entire time, which
 *      previously left the Device_List's "Currently Connected" badge absent
 *      for a session that plainly was connected. This is an OR, never a
 *      replacement -- `ClientEndpoint.lastStatus: "Connected"` still marks a
 *      uid connected on its own (`extractLastEventTimes`'s
 *      Status_Collapse_Rule, unchanged), for the Devices this view cannot
 *      identify at all (Requirement 13.2's empty-`clientUid` majority).
 *
 * Mutates `reportedByUid` in place, matching `extractLastEventTimes`'s own
 * collapse-in-place shape, and returns the count of uids whose
 * `lastEventTime` it actually advanced, for the run summary's `freshened`
 * field -- `freshened` counts (1) only; the `connected` OR is invisible to
 * that count and is instead visible in `counts.connected`/
 * `counts.disconnected`, computed from `reportedByUid` AFTER this call runs.
 *
 * ADDITIVE ONLY, for the same reason Requirement 22.2's Candidate_Client_Uids
 * rule is additive only: a uid the PRIMARY source already reported THIS poll
 * is eligible for both effects above; a uid this endpoint names but
 * `getClientEndpoints()` did not report this poll is left alone entirely --
 * it is NOT inserted as a new reported uid. That keeps this change scoped to
 * REFINING an already-reported uid's Last_Seen and Connection_Status, never
 * to widening which uids a poll can report at all.
 *
 * `SubscriptionInfo.clientUid` is EMPTY for the majority of live entries --
 * verified live, every CloudTAK ETL/service ingest connection, identified by
 * `dn` instead -- so those entries are silently skipped here rather than
 * logged as unusable: an empty `clientUid` is the NORMAL shape for a
 * non-Device connection, not a data defect (contrast
 * `extractLastEventTimes`'s `logger.warn` for an unusable `lastEventTime` on
 * an entry that DOES carry a uid).
 *
 * Exact string equality against the uid, matching `extractLastEventTimes`'s
 * own join and the Candidate_Client_Uids discipline elsewhere in this file --
 * no `LIKE`, no prefix, no wildcard.
 *
 * PURE and TOTAL over its `liveSubscriptions` argument: a non-object entry, a
 * missing/empty/non-string `clientUid`, and a missing/non-finite
 * `lastReportMilliseconds` are each skipped rather than thrown on for the
 * TIMESTAMP effect (1 above), since that step is best-effort (Requirement 13
 * freshening) and must never be what turns a poll that reached both
 * endpoints into a failed one. The CONNECTED effect (2 above) needs only a
 * usable `clientUid` naming an already-reported uid -- an unusable
 * `lastReportMilliseconds` costs a uid its freshened timestamp but never its
 * positive `connected` signal, since presence alone is what that signal
 * means.
 *
 * @param {Map<string, {lastEventTime: Date|null, connected: boolean}>} reportedByUid
 *   this poll's reported-uid map, from `extractLastEventTimes()`. Mutated in
 *   place.
 * @param {Array<unknown>} liveSubscriptions the `SubscriptionInfo` list from
 *   `TakServerService.getAllSubscriptions()`.
 * @returns {number} the number of uids whose `lastEventTime` this call moved
 *   forward.
 */
function mergeSubscriptionFreshness(reportedByUid, liveSubscriptions) {
  let freshened = 0;

  for (const subscription of liveSubscriptions) {
    const clientUid = subscription && typeof subscription === 'object' ? subscription.clientUid : null;
    if (typeof clientUid !== 'string' || clientUid.length === 0) continue;

    // Additive only -- see doc comment: a uid the primary source did not
    // report this poll is left untouched, never inserted here.
    const incumbent = reportedByUid.get(clientUid);
    if (incumbent === undefined) continue;

    // Bugfix: presence in this view IS a positive connected signal on its
    // own, independent of whether a usable lastReportMilliseconds follows --
    // an entry naming this uid at all means TAK Server currently holds an
    // open subscription for it, which is a stronger, more current claim than
    // ClientEndpoint.lastStatus can make. OR, never AND: this never turns an
    // already-true value false.
    incumbent.connected = true;

    const reportMs = subscription.lastReportMilliseconds;
    if (typeof reportMs !== 'number' || !Number.isFinite(reportMs)) continue;

    if (incumbent.lastEventTime === null || reportMs > incumbent.lastEventTime.getTime()) {
      incumbent.lastEventTime = new Date(reportMs);
      freshened += 1;
    }
  }

  return freshened;
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
module.exports.mergeSubscriptionFreshness = mergeSubscriptionFreshness;
