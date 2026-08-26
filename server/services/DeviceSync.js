const pool = require('../config/database');
const TakServerService = require('./TakServerService');
const { matchesCreatorDn } = TakServerService;
const logger = require('../config/logger').createLogger('DeviceSync');

/**
 * device-management Requirements 4.3-4.7, 4.9, 11 (tasks 7.3, 20.2): the
 * Device_Sync described in design.md's "The Device_Sync" section. Runs inside
 * the Sync_Worker process on its OWN `setInterval`, independent of the main
 * poll loop and of the Subscription_Poller, mirroring the shape already
 * established by `server/services/ExpiryScheduler.js` and
 * `server/services/RetentionCleanupJob.js` (clamped interval from an env
 * var, an idempotent `start()` that runs one pass immediately then schedules
 * the recurring interval, an idempotent `stop()`, and a never-throwing run
 * method). Requirement 4.8: no new background-job framework is introduced.
 *
 * Each run:
 *
 *   1. Fetches the Live_Certificates via
 *      `takServerService.listLiveCertificates()` -- the set difference
 *      between `GET /Marti/api/certadmin/cert/active` and
 *      `GET /Marti/api/certadmin/cert/revoked` (in `/active`, NOT in
 *      `/revoked`), Requirements 4.3, 11.2. The Active_Certificate view is
 *      NOT the live set and is never used as one: verified live, 90 of its
 *      95 certificates also appeared in `/revoked`, which is why the earlier
 *      implementation -- which synced `/active` directly -- listed 10
 *      Devices where only 1 was live, most of them revoked certificates
 *      shown with `revoked = false` (Requirement 11.5).
 *   2. Groups those Live_Certificates by `clientUid` and picks each group's
 *      Newest_Live_Certificate: the greatest `issuanceDate`
 *      (Requirements 4.6, 11.3). Grouping is mandatory rather than an
 *      optimisation -- `clientUid` reuse is the normal case (95 certificates
 *      carried 10 distinct `clientUid`s, 60 of them on `ckadmin (ETL)`), so
 *      a Device is one `clientUid` with a SET of certificates, never one
 *      certificate (Requirement 11.1). Superseding is computed here, locally:
 *      `GET /Marti/api/certadmin/cert/replaced` is deliberately NOT consulted
 *      because it returned the same 95 ids as `/active` and so distinguishes
 *      nothing (Requirement 11.4).
 *   3. Resolves each GROUP's local user from its Newest_Live_Certificate's
 *      `creatorDn` with `matchesCreatorDn(creatorDn, user.username)` over the
 *      local `users` table -- the exact same predicate
 *      `TakServerService.findCertificatesForUser` filters with, reused
 *      rather than reimplemented (Requirement 4.5). It is resolved from the
 *      NEWEST certificate specifically, not an arbitrary group member, so a
 *      re-enrollment that changed the issuing DN is reflected.
 *   4. Upserts exactly ONE `tak_devices` row per distinct `client_uid`
 *      (Requirements 4.4, 11.6) carrying that Newest_Live_Certificate's
 *      `cert_id`, `issued_at`, `expires_at`, the resolved `user_id`, and
 *      `last_polled_at` set to this run's time (Requirement 4.7).
 *   5. Reconciles the Device_Table against the Live_Device_Set: DELETES every
 *      `tak_devices` row whose `client_uid` is absent from the uids this run
 *      derived (Requirement 17.1), reachable only from the fully-successful
 *      path so that a failed run deletes nothing (Requirement 17.2). See
 *      `deleteStaleDevices` and the call site in `run()`.
 *
 * A `clientUid` whose every certificate is revoked yields no group at all, so
 * it is never upserted and can never appear with `revoked = false`
 * (Requirements 5.4, 11.5). An existing row for such a uid is DELETED by step
 * 5 on the next run whose outcome is completed (Requirement 17.7) -- that
 * deletion is the ONE mechanism by which a Device stops being presented.
 *
 * This paragraph previously claimed that such a row "simply stops being
 * refreshed -- its `last_polled_at` goes stale, which is the signal the
 * self-view uses to stop presenting it as current". That was false in both
 * halves and is corrected here rather than left standing: NO such signal was
 * ever implemented, and `DeviceManagementService.listOwnDevices` filters on
 * `user_id` alone -- no freshness predicate, no `revoked` predicate -- so a row
 * upserted while the uid was still live kept being returned by the self-view
 * and the admin view forever (measured live: 13 Devices against 22 rows, nine
 * stale, every one of them `revoked = false`). `last_polled_at` is sync
 * bookkeeping only -- when this job last refreshed the row -- and is NOT a
 * visibility or freshness input; adding one is forbidden (Requirement 17.8),
 * because a read-side filter would be a second removal mechanism that can
 * disagree with the delete.
 *
 * `last_seen_at` and `revoked` are NEVER written by this job: `last_seen_at`
 * belongs to the Subscription_Poller (monotonic-forward, Requirement 3.3)
 * and `revoked` belongs to the Revoke_Operation handler (Requirements 7.6,
 * 8.7). They are therefore absent from both the INSERT column list and the
 * `DO UPDATE SET` list, so Postgres leaves an existing row's values
 * untouched regardless of what this job knows -- which also makes the upsert
 * idempotent: replaying the same Live_Certificate set yields identical rows
 * and preserves `last_seen_at`/`revoked`.
 *
 * Requirements 4.9, 14.1, 14.2, 14.5: every failure is caught and logged via
 * the Structured Logger rather than thrown. A failed fetch is NOT degraded to
 * an empty certificate set -- `listLiveCertificates()` rejects when either view
 * fails, and that rejection ends the run without writing anything, so every
 * existing `tak_devices` row is left exactly as it was and the next scheduled
 * tick retries; the Sync_Worker process is never crashed or exited. In
 * particular a failed Revoked_Certificate_View fetch never reads as "nothing is
 * revoked", which would promote every revoked certificate to live. The failure
 * is logged at ERROR level with the failing `endpoint`, the HTTP `status` (or
 * `null` where the server never answered) and `outcome: 'failed'`; a run that
 * fetched successfully logs at INFO with `outcome: 'completed'`, even when it
 * found nothing at all. That pairing is what keeps "the request was wrong"
 * distinguishable from "TAK Server legitimately has no live certificates"
 * (Requirement 14.5) -- see `run()`.
 *
 * The database is reached through the injectable `pool` (defaulting to the
 * shared `server/config/database` pool, as `RetentionCleanupJob` does), so
 * `run()` is unit-testable against a mocked pool.
 */
class DeviceSync {
  constructor({ takServerService = new TakServerService(), pool: dbPool = pool } = {}) {
    this.takServerService = takServerService;
    this.pool = dbPool;

    // design.md: "`DEVICE_MGMT_SYNC_INTERVAL_SECONDS`, clamped, default e.g.
    // 15 minutes". Unlike `ExpiryScheduler`'s 15-minute cap (which encodes a
    // hard vendor-grant SLA), nothing in requirements.md pins this cadence,
    // so the bounds here exist purely as sanity guards: a 1-minute floor
    // stops a misconfigured near-zero value turning this into a tight
    // busy-loop against TAK Server and the database (the same reasoning
    // behind `ExpiryScheduler`/`RetentionCleanupJob`'s MIN_INTERVAL_SECONDS),
    // and a 24-hour ceiling stops a mistyped value (e.g. an extra digit) from
    // silently parking the sync for weeks. Same
    // `parseInt(...) || <default>` + `Math.min`/`Math.max` shape used for
    // the other scheduled jobs, clamped in seconds and converted to
    // milliseconds once at the end -- the field stays `intervalMs` because
    // `setInterval` takes milliseconds.
    const MIN_INTERVAL_SECONDS = 60; // 1 minute
    const MAX_INTERVAL_SECONDS = 24 * 60 * 60; // 24 hours
    const DEFAULT_INTERVAL_SECONDS = 900; // 15 minutes

    const intervalSeconds = Math.min(
      MAX_INTERVAL_SECONDS,
      Math.max(
        MIN_INTERVAL_SECONDS,
        parseInt(process.env.DEVICE_MGMT_SYNC_INTERVAL_SECONDS, 10) || DEFAULT_INTERVAL_SECONDS
      )
    );
    this.intervalMs = intervalSeconds * 1000;

    this.timer = null;
  }

  /**
   * Starts the job: runs one sync immediately, then schedules a recurring
   * sync every `this.intervalMs`. A no-op if already running (mirrors
   * `ExpiryScheduler.start()`/`RetentionCleanupJob.start()`'s idempotency
   * against a double start).
   *
   * The immediate first run means a freshly-deployed/restarted worker
   * populates `tak_devices` right away instead of waiting a full interval --
   * which also gives the Subscription_Poller rows to record Last_Seen
   * against as early as possible.
   */
  start() {
    if (this.timer) return;

    logger.info({ intervalMs: this.intervalMs }, 'Device sync started');

    this.run();

    this.timer = setInterval(() => {
      this.run();
    }, this.intervalMs);
  }

  /**
   * Stops the job, clearing the recurring interval. A no-op if not currently
   * running, so an unconditional `stop()` from `SyncWorker.stop()` is safe
   * even when device-management was never enabled.
   */
  stop() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
    logger.info('Device sync stopped');
  }

  /**
   * Runs one sync pass. Requirements 4.9, 14.1: NEVER throws -- every error is
   * caught and logged, existing rows are left as they are, and the next
   * scheduled tick retries.
   *
   * A single Device that fails to upsert (e.g. a transient database error on
   * that one row) is logged and skipped rather than aborting the whole pass,
   * so one bad row cannot starve every other Device of its refresh. Rows are
   * upserted independently (no surrounding transaction): each row's upsert is
   * atomic on its own, and a partially-completed pass is self-correcting --
   * the next run re-derives everything from the Live_Certificates.
   *
   * A run is reported failed for EVERY failure mode of the certificate-view
   * fetch -- a 404, any other 4xx, a 5xx, a transport error, a timeout, and a
   * malformed (non-list) payload -- and each of those ends the run before a
   * single row is written.
   *
   * Requirements 14.1, 14.5 -- how a failed run is REPORTED (task 23.2). The
   * report lives in the Structured_Logger, which is the channel Requirement
   * 14.1 names and the only one an operator ever sees: nothing in the process
   * reads this method's return value (`start()` fires `run()` from
   * `setInterval` and discards the promise's value). So the outcome is carried
   * by an explicit `outcome` field on every terminal log line of a run --
   * `'failed'` at error level, `'completed'` at info level -- rather than being
   * left to inference. `outcome=failed` is a single greppable term covering
   * every failure mode (404, other 4xx, 5xx, transport error, timeout), and a
   * successful run that legitimately found nothing still emits
   * `outcome=completed` with zero counts, so the two can never read alike.
   *
   * The RETURN value is deliberately left as it was -- counts on success,
   * `undefined` on failure -- which is already a total, unambiguous
   * discrimination for a caller (there is no third state) and keeps this
   * method's contract identical to the sibling `SubscriptionPoller.run()`.
   *
   * Requirement 17: a run that reaches the completed outcome finishes by
   * DELETING the Stale_Device_Rows -- see `deleteStaleDevices` and the
   * placement note at the call site below.
   *
   * @returns {Promise<{liveCertificates: number, devices: number,
   *   upserted: number, skipped: number, failed: number, matched: number,
   *   unmatched: number, deleted: number}|undefined>} per-run counts, or
   *   `undefined` when the run failed -- a failed fetch or a malformed payload
   *   -- already logged with `outcome: 'failed'`, having written nothing and
   *   deleted nothing (Requirement 17.2).
   */
  async run() {
    const runAt = new Date();

    let certificates;
    try {
      // Requirements 4.3, 11.2: the LIVE set (in `/active`, not in
      // `/revoked`), never `/active` alone.
      certificates = await this.takServerService.listLiveCertificates();
    } catch (error) {
      // Requirements 4.9, 14.1, 14.2: a failed fetch of either documented view
      // ends the run. Nothing has been written at this point, so every existing
      // `tak_devices` row is left exactly as it was, and the failure is NOT
      // degraded to an empty certificate set -- which would present every
      // revoked certificate as live and every live Device as gone.
      //
      // Requirement 14.1 asks for the endpoint AND the status, and Requirement
      // 14.5 for an outcome that cannot be confused with a successful run that
      // legitimately found nothing: `outcome: 'failed'` is the field to search
      // on, and it is the ONLY value of `outcome` this job ever logs alongside
      // an error level (the completion line below logs `'completed'`).
      logger.error(
        { err: error, ...describeFetchFailure(error, CERTIFICATE_VIEW_ENDPOINTS), outcome: 'failed' },
        'Device sync failed to fetch live certificates; leaving devices unchanged'
      );
      return undefined;
    }

    // Requirements 4.9, 14.1, 14.5: a payload that is not a list is a MALFORMED
    // response, not an empty one, and is reported as a failed run -- it used to
    // be coerced to `[]`, which is the same silent degradation a 404-as-empty
    // performs: every live Device would stop being refreshed with nothing
    // logged. This does NOT contradict `TakServerService`'s one tolerated
    // absence (Requirement 14.3): a 200 whose `ApiResponse` omits `data`
    // legitimately means "this view is empty" and `unwrapArray()` still yields
    // `[]`, an array, which reaches the completed path below. Only a shape this
    // job cannot read as a certificate list at all lands here.
    if (!Array.isArray(certificates)) {
      logger.error(
        {
          endpoint: CERTIFICATE_VIEW_ENDPOINTS.join(', '),
          payloadType: describePayloadType(certificates),
          outcome: 'failed'
        },
        'Device sync received a malformed live-certificate payload; leaving devices unchanged'
      );
      return undefined;
    }

    const liveCertificates = certificates;

    let users;
    try {
      users = await this.loadUsers();
    } catch (error) {
      // Not a documented-endpoint failure (this one is the local database), so
      // there is no endpoint or HTTP status to report -- but the run is still
      // reported failed with the same searchable marker, since it too ends
      // before anything is written (Requirements 4.9, 14.5).
      logger.error(
        { err: error, outcome: 'failed' },
        'Device sync failed to load local users; leaving devices unchanged'
      );
      return undefined;
    }

    const { devices, skipped } = groupByClientUid(liveCertificates);

    const counts = {
      liveCertificates: liveCertificates.length,
      devices: devices.size,
      upserted: 0,
      skipped,
      failed: 0,
      matched: 0,
      unmatched: 0,
      // Requirement 17.9: the deleted-row count is reported alongside the rest,
      // so a deletion is observable in the completion line rather than
      // inferred. It stays 0 unless the delete below both runs and succeeds.
      deleted: 0
    };

    for (const [clientUid, cert] of devices) {
      // Requirement 4.5: the user comes from the Newest_Live_Certificate's
      // `creatorDn`, not from an arbitrary member of the group.
      const userId = this.resolveUserId(cert.creatorDn, users);
      if (userId === null) {
        // Requirement 4.2 / the migration's `user_id` comment: an unmatched
        // certificate is still tracked, with a NULL user, so it is visible
        // to the sync's counts and to operators rather than silently
        // dropped. It simply belongs to nobody locally, so no self-view or
        // admin view can reach it.
        counts.unmatched += 1;
      } else {
        counts.matched += 1;
      }

      try {
        await this.upsertDevice({ clientUid, userId, cert, runAt });
        counts.upserted += 1;
      } catch (error) {
        counts.failed += 1;
        logger.error({ err: error, clientUid }, 'Device sync failed to upsert device row; leaving that row unchanged');
      }
    }

    // Requirements 17.1, 17.2: the reconciliation step, and the ONE place in
    // this method whose position is load-bearing. Every early return above --
    // the rejected `listLiveCertificates()`, the non-array payload, the failed
    // `loadUsers()` -- has already returned `undefined` with
    // `outcome: 'failed'`, so the delete is reachable ONLY from the path where
    // the fetch fully succeeded. That, and not a "is the live set non-empty?"
    // test, is what keeps a TAK Server outage from emptying the table: a
    // successful run that legitimately found zero live Devices and a failed run
    // whose response was empty or unreadable ask for the SAME table-level
    // outcome from the data alone (delete everything), and are told apart only
    // by the run's outcome. So the empty live set deletes every row here --
    // correct, because nothing is live -- while a failed run never gets here.
    //
    // The predicate is the Live_Device_Set derived from the fetch, NOT the uids
    // whose upsert happened to succeed: a run in which some rows failed to
    // upsert still deletes only genuinely-absent uids (Requirement 17.4).
    try {
      counts.deleted = await this.deleteStaleDevices([...devices.keys()]);
    } catch (error) {
      // Requirement 17.6: the same handling a single row's failed upsert gets
      // -- logged, swallowed, the rest of the run completed, retried on the next
      // scheduled run. Deletion is derived state, so a missed pass
      // self-corrects, and `run()` keeps never throwing (Requirement 4.9).
      logger.error(
        { err: error, devices: devices.size },
        'Device sync failed to delete stale device rows; leaving them for the next run'
      );
    }

    // Requirement 14.5: a run that fetched successfully is ALWAYS logged as a
    // completed outcome, including the legitimately-empty one (zero
    // Live_Certificates, zero Devices, zero upserts). That is what makes "TAK
    // Server has nothing live" a positive, greppable statement -- `outcome:
    // 'completed'` with zero counts -- rather than the absence of an error,
    // which is indistinguishable from the run never having happened. Silence
    // was the whole shape of the original defect.
    logger.info({ ...counts, outcome: 'completed' }, 'Device sync run completed');
    return counts;
  }

  /**
   * Loads the local users the `creatorDn` matching runs against. Only the
   * two columns the match needs are selected (`id`, `username`), keeping the
   * per-run read small; deactivated users are deliberately included so a
   * disabled account's certificates stay attributed to that account rather
   * than becoming ownerless.
   *
   * @returns {Promise<Array<{id: number, username: string}>>}
   */
  async loadUsers() {
    const result = await this.pool.query('SELECT id, username FROM users');
    return result?.rows ?? [];
  }

  /**
   * Requirement 4.5: resolves the local user for a certificate by matching
   * its `creatorDn` against each local username with the shared
   * `matchesCreatorDn` predicate exported by `TakServerService` -- the same
   * matching logic `findCertificatesForUser` uses, imported rather than
   * duplicated.
   *
   * The first match wins. `matchesCreatorDn`'s CN-anchored check is what
   * makes that safe in practice, and users are scanned in the order the
   * query returned them, so the resolution is deterministic for a given
   * `users` snapshot.
   *
   * @param {string|undefined} creatorDn
   * @param {Array<{id: number, username: string}>} users
   * @returns {number|null} the local user id, or null when nothing matches.
   */
  resolveUserId(creatorDn, users) {
    const match = users.find((user) => matchesCreatorDn(creatorDn, user?.username));
    return match ? match.id : null;
  }

  /**
   * Requirements 4.4/4.7/11.6: upserts one Device_Table row keyed on
   * `client_uid` -- one row per Device, never one per certificate -- carrying
   * the Newest_Live_Certificate's `cert_id`, `issued_at`, `expires_at`, the
   * resolved `user_id`, and `last_polled_at` set to this run's time. A
   * re-enrollment that issues a new certificate for an existing `client_uid`
   * therefore updates that Device's row rather than creating a second Device.
   *
   * `last_seen_at` and `revoked` appear in NEITHER the insert column list
   * NOR the `DO UPDATE SET` list, which is what guarantees the sync can
   * never overwrite them: on insert they take their column defaults (NULL
   * = "never seen", and false), and on conflict Postgres leaves the stored
   * values untouched.
   *
   * Timestamps are passed straight through as the Marti `TakCert`
   * `issuanceDate`/`expirationDate` values (missing values become NULL) and
   * cast to `timestamptz` by Postgres, matching how the rest of this
   * codebase hands date values to `pool.query`. The one exception is an
   * `issuanceDate` that is present but unparseable: it is written as NULL
   * rather than handed to Postgres as a string it would reject, so the Device
   * whose Newest_Live_Certificate carries a broken date still gets its row
   * (with a visibly missing issuance date) instead of failing its upsert.
   * That mirrors how such a certificate is ranked in `isNewerCertificate`:
   * last, but never dropped. `expirationDate` keeps its plain pass-through --
   * nothing in this feature reads or orders by it, so it is left exactly as
   * TAK Server reported it.
   *
   * @param {{clientUid: string, userId: number|null, cert: object, runAt: Date}} args
   * @returns {Promise<void>}
   */
  async upsertDevice({ clientUid, userId, cert, runAt }) {
    await this.pool.query(
      `INSERT INTO tak_devices (client_uid, user_id, cert_id, issued_at, expires_at, last_polled_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (client_uid) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         cert_id = EXCLUDED.cert_id,
         issued_at = EXCLUDED.issued_at,
         expires_at = EXCLUDED.expires_at,
         last_polled_at = EXCLUDED.last_polled_at`,
      [
        clientUid,
        userId,
        cert.id ?? null,
        parseIssuanceTime(cert.issuanceDate) === null ? null : cert.issuanceDate,
        cert.expirationDate ?? null,
        runAt
      ]
    );
  }

  /**
   * Requirements 17.1, 17.3, 17.4: deletes every Stale_Device_Row -- each
   * `tak_devices` row whose `client_uid` is absent from this run's
   * Live_Device_Set. The upsert alone can only add and refresh, so this is what
   * makes the Device_Table converge on the live set instead of accumulating
   * every Device the local database has ever seen (measured live: 13 Devices
   * against 22 rows, nine stale, all of them still `revoked = false`).
   *
   * The statement is SCOPED to the uids absent from `liveClientUids` -- an
   * unscoped `DELETE FROM tak_devices` is forbidden (Requirement 17.3), and the
   * `<> ALL($1::text[])` form is what gives Requirement 17.4 its guarantee from
   * the other side: a `client_uid` present in the array is never matched, so a
   * uid that DOES carry a Live_Certificate cannot be deleted. The explicit
   * `::text[]` cast is required because an empty array carries no element type
   * for Postgres to infer.
   *
   * An EMPTY `liveClientUids` matches every row and so deletes the whole table.
   * That is correct on its own terms -- nothing is live -- and is safe only
   * because of WHERE this is called from: `run()` reaches it only after the
   * fetch fully succeeded (see the call site). A failed fetch produces the same
   * empty derivation and must delete nothing, which is why the discriminator is
   * the run's outcome and never the size of this array (Requirement 17.2).
   *
   * A deleted row is recoverable rather than lost: Last_Seen comes from TAK
   * Server's own reported `lastEventTime` (Requirement 13.1), so if the uid
   * comes back with a fresh certificate the normal upsert re-inserts the row
   * (with `revoked` at its column default) and the next poll re-populates
   * `last_seen_at` (Requirement 17.5).
   *
   * Errors are propagated for the caller to log and swallow (Requirement 17.6).
   *
   * @param {Array<string>} liveClientUids the Live_Device_Set: the `client_uid`s
   *   this run derived from the Live_Certificates, which are exactly the ones it
   *   upserted.
   * @returns {Promise<number>} how many rows were deleted.
   */
  async deleteStaleDevices(liveClientUids) {
    const result = await this.pool.query(
      'DELETE FROM tak_devices WHERE client_uid <> ALL($1::text[])',
      [liveClientUids]
    );

    return result?.rowCount ?? 0;
  }
}

/**
 * The two documented certificate views a sync run requires (Requirements 4.3,
 * 11.2, 14.2): `getActive` and `getRevoked` in `tak-server-openapispec.json`.
 * Reported as the failing `endpoint` when the rejection itself does not name
 * one (see `describeFetchFailure`).
 */
const CERTIFICATE_VIEW_ENDPOINTS = [
  '/Marti/api/certadmin/cert/active',
  '/Marti/api/certadmin/cert/revoked'
];

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
 * (`error.config.url`, again the axios convention), because a sync run touches
 * BOTH certificate views and only one of them may have failed. When the
 * rejection carries no such URL (a plain `Error`, or a rejection raised before
 * the request was built) the `fallbackEndpoints` the run required are reported
 * instead, so the field is never empty; `TakServerService.listLiveCertificates()`
 * has already logged its own per-view line naming the exact view that failed.
 *
 * Only plain property reads are used, and every branch returns: this runs
 * INSIDE `run()`'s catch block, so it must not be able to throw and turn a
 * reported failure into a thrown one (Requirements 3.8, 4.9).
 *
 * Mirrored deliberately in `SubscriptionPoller`, so both jobs report a failed
 * documented-endpoint fetch with the same two fields.
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
 * Names the shape of a payload that could not be read as a certificate list,
 * for the malformed-payload error log. `typeof null` is `'object'`, which would
 * be actively misleading in a log line, so null is named as itself.
 *
 * @param {unknown} payload
 * @returns {string}
 */
function describePayloadType(payload) {
  if (payload === null) return 'null';
  return typeof payload;
}

/**
 * Requirements 11.1, 11.3, 4.6: turns a flat Live_Certificate list into
 * Devices -- one entry per distinct `clientUid`, holding that group's
 * Newest_Live_Certificate (greatest `issuanceDate`).
 *
 * This is the local superseding computation. TAK Server exposes no usable
 * superseded view (`/Marti/api/certadmin/cert/replaced` returned the same 95
 * ids as `/active`, Requirement 11.4), so "which certificate represents this
 * Device" is decided here and nowhere else.
 *
 * A `Map` is used rather than a plain object so that a `clientUid` such as
 * `__proto__` or `constructor` is an ordinary key, and so iteration order is
 * first-seen order (making the resulting upsert sequence deterministic for a
 * given input list).
 *
 * A certificate with no usable `clientUid` is counted as skipped and forms no
 * group: `client_uid` is the Device_Table's primary key, so such a
 * certificate cannot be keyed and is not written under a synthesised
 * identifier.
 *
 * @param {Array<object>} liveCertificates
 * @returns {{devices: Map<string, object>, skipped: number}}
 */
function groupByClientUid(liveCertificates) {
  const devices = new Map();
  let skipped = 0;

  for (const cert of liveCertificates) {
    const clientUid = cert && typeof cert === 'object' ? cert.clientUid : null;

    if (typeof clientUid !== 'string' || clientUid.length === 0) {
      skipped += 1;
      logger.warn({ certId: cert?.id }, 'Device sync skipping live certificate with no clientUid');
      continue;
    }

    const incumbent = devices.get(clientUid);
    if (incumbent === undefined || isNewerCertificate(cert, incumbent)) {
      devices.set(clientUid, cert);
    }
  }

  return { devices, skipped };
}

/**
 * Total, order-independent "is `candidate` the newer certificate?" comparison
 * used to pick a group's Newest_Live_Certificate (Requirement 11.3).
 *
 * The ordering is deliberately total so the winner never depends on the order
 * TAK Server happened to return the certificates in:
 *
 *   1. A certificate with a parseable `issuanceDate` always beats one whose
 *      `issuanceDate` is absent or unparseable. Such a certificate cannot be
 *      compared on the attribute Requirement 11.3 orders by, so it is ranked
 *      LAST rather than dropped -- dropping it could leave a `clientUid` that
 *      does have Live_Certificates with no Device at all, which would hide a
 *      live Device (the opposite of the Requirement 11.5 failure mode). Its
 *      unusable date is still written through as NULL, so the row shows a
 *      missing issuance date rather than a fabricated one.
 *   2. Otherwise the greater `issuanceDate` wins.
 *   3. Ties on `issuanceDate` -- including two certificates that BOTH lack a
 *      usable one -- are broken by the greater `cert_id`. TAK Server issues
 *      ids monotonically, so the greater id is the later enrollment, and the
 *      tiebreak is stable regardless of input order.
 *
 * @param {object} candidate
 * @param {object} incumbent
 * @returns {boolean}
 */
function isNewerCertificate(candidate, incumbent) {
  const candidateTime = parseIssuanceTime(candidate?.issuanceDate);
  const incumbentTime = parseIssuanceTime(incumbent?.issuanceDate);

  if (candidateTime !== incumbentTime) {
    if (incumbentTime === null) return true;
    if (candidateTime === null) return false;
    return candidateTime > incumbentTime;
  }

  return compareCertIds(candidate?.id, incumbent?.id) > 0;
}

/**
 * Parses a Marti `TakCert.issuanceDate` to a comparable epoch-millisecond
 * number, or `null` when it is absent or unparseable.
 *
 * `Date` instances are accepted alongside the documented ISO-8601 strings
 * because a caller may hand through already-parsed values; anything that does
 * not yield a finite time is `null` (see `isNewerCertificate` for how those
 * are ranked).
 *
 * @param {unknown} issuanceDate
 * @returns {number|null}
 */
function parseIssuanceTime(issuanceDate) {
  if (issuanceDate === null || issuanceDate === undefined) return null;

  const time = issuanceDate instanceof Date ? issuanceDate.getTime() : Date.parse(issuanceDate);
  return Number.isFinite(time) ? time : null;
}

/**
 * Deterministic total ordering of two `TakCert.id` values, used only as the
 * `issuanceDate` tiebreak in `isNewerCertificate`.
 *
 * Ids are numeric on TAK Server, so they compare numerically whenever both
 * sides are finite numbers; any other shape (a string id, a missing id) falls
 * back to a string comparison so the result is still total and stable rather
 * than order-dependent.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} negative when `a < b`, positive when `a > b`, 0 when equal.
 */
function compareCertIds(a, b) {
  const aNumber = toFiniteNumber(a);
  const bNumber = toFiniteNumber(b);

  if (aNumber !== null && bNumber !== null) {
    if (aNumber === bNumber) return 0;
    return aNumber > bNumber ? 1 : -1;
  }

  const aString = a === null || a === undefined ? '' : String(a);
  const bString = b === null || b === undefined ? '' : String(b);

  if (aString === bString) return 0;
  return aString > bString ? 1 : -1;
}

/**
 * @param {unknown} value
 * @returns {number|null} `value` as a finite number, or null.
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

module.exports = DeviceSync;
module.exports.groupByClientUid = groupByClientUid;
module.exports.isNewerCertificate = isNewerCertificate;
