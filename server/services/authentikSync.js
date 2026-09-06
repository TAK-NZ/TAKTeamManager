const axios = require('axios');
const pLimit = require('p-limit');
const db = require('../config/database');
const { createLogger } = require('../config/logger');
const { normaliseAuthentikEmail } = require('../utils/authentikEmail');
const { isIgnoredAuthentikUsername } = require('../config/authentikSyncIgnore');
const EventPublisher = require('./EventPublisher');
// Authentik scaling (Phase 1): the periodic reconciliation sweep is another
// Authentik load source (a full paginated user + group fetch every cycle,
// plus a per-user attribute PATCH on drift). Route its calls through the
// SHARED rate limiter so they draw from the same read/write token budget as
// the request path and the Sync_Worker, rather than a third independent
// stream. Pass-through when the limiter flag is off.
const authentikRequest = require('./authentikRequest');

const logger = createLogger('authentikSync');

// Requirement 11.2: bounded concurrency for processBatch's per-user Authentik
// sync work, configurable via AUTHENTIK_SYNC_CONCURRENCY and clamped to the
// 1-20 range (default 5), following the same
// `Math.min(<max>, Math.max(<min>, parseInt(...) || <default>))` clamp
// pattern already established for SYNC_WORKER_BATCH_SIZE in
// server/workers/syncWorker.js.
function getAuthentikSyncConcurrency() {
  return Math.min(20, Math.max(1, parseInt(process.env.AUTHENTIK_SYNC_CONCURRENCY, 10) || 5));
}

class AuthentikSyncService {
  constructor() {
    this.isRunning = false;
    this.lastSync = null;
  }

  async syncUsers() {
    if (this.isRunning) {
      logger.info('Authentik sync already running, skipping');
      return;
    }

    this.isRunning = true;
    logger.info('Starting Authentik user sync');

    try {
      // Update sync status
      await db.query(
        'UPDATE sync_status SET status = $1, last_sync = CURRENT_TIMESTAMP WHERE sync_type = $2',
        ['running', 'user_sync']
      );

      let allUsers = [];
      let currentPage = 1;
      let hasMorePages = true;
      // The total Authentik REPORTS for this fetch (DRF pagination `count`).
      // Captured from whatever page carries it (kept as the last non-null
      // value seen) so it can be compared against `allUsers.length` after the
      // loop -- see the completeness guard below the loop. Stays null if
      // Authentik never reports a count (older shapes / test doubles that mock
      // `pagination: {}`), in which case the guard falls back to proceeding.
      let reportedCount = null;

      // Fetch all users with pagination. Authentik's pagination metadata
      // lives under `response.data.pagination.next` (a page NUMBER), not
      // a top-level `response.data.next` URL -- the same shape
      // `fetchGroupMap` below already handles correctly. This loop
      // previously read the wrong field, which is always `undefined`, so
      // it silently terminated after page 1 every run: with the default
      // page_size of 20 and this Authentik instance now having 24+
      // users, any user beyond the first page (e.g. a normal, active,
      // non-admin user alphabetically/insertion-ordered past the first
      // 20) was NEVER written to user_cache, causing their every login
      // attempt to hit the "not found in cache" path indefinitely -- not
      // just a delay until the next sync, since that next sync had the
      // exact same bug.
      //
      // Bugfix (mass false-positive orphaning during a concurrent bulk
      // import): `GET /core/users/` defaults to ordering ALPHABETICALLY
      // BY USERNAME, with no stable secondary key. While a large CSV
      // import is inserting thousands of new Authentik accounts
      // concurrently with a periodic sync run, every new username
      // shifts the alphabetical position of every user sorted after it
      // -- so a user can shift from a not-yet-fetched page to an
      // already-fetched one (or vice versa) BETWEEN two page requests of
      // the SAME pagination loop, and be silently skipped entirely. This
      // loop's `allUsers` result is then incomplete but looks complete
      // (`hasMorePages` correctly went false), so
      // `reconcileOrphanedAccounts` -- which trusts a non-empty result
      // as a COMPLETE one -- wrongly marked every skipped real user
      // `'orphaned'` and enqueued a certificate revoke against them.
      // Confirmed live: of 100 accounts orphaned during one FENZ import,
      // all 100 still existed in Authentik. `ordering=pk` sorts by the
      // one field that is immutable once assigned and unaffected by
      // concurrent inserts of OTHER users, so a user already returned on
      // an earlier page can never later reappear on, or be skipped from,
      // a later page because same-run inserts changed its sort key.
      while (hasMorePages) {
        const response = await authentikRequest.run({ kind: 'read' }, () => axios.get(
          `${process.env.AUTHENTIK_URL}/api/v3/core/users/?ordering=pk&page=${currentPage}`,
          {
            headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` },
            timeout: 30000
          }
        ));

        allUsers = allUsers.concat(response.data.results);

        logger.debug(
          { fetchedCount: response.data.results.length, totalFetched: allUsers.length },
          'Fetched a page of Authentik users'
        );

        if (
          response.data.pagination
          && typeof response.data.pagination.count === 'number'
        ) {
          reportedCount = response.data.pagination.count;
        }

        if (response.data.pagination && response.data.pagination.next) {
          currentPage = response.data.pagination.next;
        } else {
          hasMorePages = false;
        }
      }

      logger.info({ totalUsers: allUsers.length }, 'Total users to sync');

      // Requirement 11.6: fetch the full Authentik group list once per sync
      // run, in its own dedicated try/catch, so that a failure on ANY page
      // of the pagination loop (the first page, or a later page after some
      // earlier pages already succeeded) is caught here explicitly and
      // aborts the run BEFORE the `for` loop below ever calls
      // processBatch/syncSingleUser. This makes the "no partial user_cache
      // write" guarantee explicit in the code rather than relying solely on
      // the outer try/catch's exception propagation -- a partial
      // `allGroups`/`groupMap` (from an interrupted pagination loop) must
      // never be used to process a user batch.
      let groupMap;
      try {
        groupMap = await this.fetchGroupMap();
      } catch (groupFetchError) {
        logger.error({ err: groupFetchError }, 'Authentik group list fetch failed; aborting user sync before any user_cache write');

        await db.query(
          'UPDATE sync_status SET status = $1, error_message = $2 WHERE sync_type = $3',
          ['error', `Group list fetch failed: ${groupFetchError.message}`, 'user_sync']
        );

        return; // Explicit early return: abort before the processBatch loop.
      }

      // Process users in batches
      const batchSize = 50;
      let syncedCount = 0;

      for (let i = 0; i < allUsers.length; i += batchSize) {
        const batch = allUsers.slice(i, i + batchSize);
        await this.processBatch(batch, groupMap);
        syncedCount += batch.length;
        logger.debug({ syncedCount, totalUsers: allUsers.length }, 'Synced a batch of users');
      }

      // account-lifecycle-management Requirement 2 (task 6.2): the
      // Reconciliation_Sweep runs only on this success path -- after the
      // batch-processing loop above has fully completed, still inside
      // this `try` block -- never when the paginated fetch itself failed
      // (that already returns early via the fetchGroupMap catch above,
      // or throws into the outer catch below before reaching here).
      // `allUsers` is exactly the set this run's fetch returned; passing
      // anything less than the complete set would orphan every row this
      // run happened not to see.
      //
      // COMPLETENESS GUARD (the live mass-false-orphan incident): the
      // pagination loop terminates when `pagination.next` goes falsy, but a
      // page can go missing WITHOUT the loop ever noticing -- an
      // unhealthy/mid-upgrade Authentik can answer 200 with a short page or a
      // prematurely-absent `next`, so the loop "cleanly" finishes with an
      // INCOMPLETE `allUsers` that looks complete. Authentik reports the true
      // total on every page as `pagination.count`; if that disagrees with what
      // we actually accumulated, the fetch is NOT trustworthy as the complete
      // set, and running the sweep against it would orphan every real user the
      // short fetch missed (confirmed live: ~1100 real, still-existing accounts
      // false-orphaned during a concurrent bulk import + DB upgrade). In that
      // case we SKIP the sweep only -- the destructive, effectively one-way
      // step -- while still having synced whatever users we did fetch to the
      // cache above (that write is additive and self-correcting: it only writes
      // rows it saw and never removes, so a partial sync is harmless and the
      // next complete run fills the gaps). When Authentik reports no count at
      // all (`reportedCount` stayed null), we fall back to the prior behaviour
      // and run the sweep, since there is no signal to prove incompleteness.
      const fetchComplete = reportedCount === null || allUsers.length === reportedCount;
      let sweepSkippedMessage = null;
      if (fetchComplete) {
        await this.reconcileOrphanedAccounts(allUsers.map(u => String(u.pk)));
      } else {
        sweepSkippedMessage = `Reconciliation sweep skipped: incomplete fetch (${allUsers.length} of ${reportedCount})`;
        logger.error(
          { fetchedCount: allUsers.length, reportedCount },
          'Reconciliation_Sweep: SKIPPED -- the paginated Authentik user fetch '
            + 'was incomplete (accumulated count disagrees with the reported total); '
            + 'refusing to orphan against a partial set. The cache sync still ran; '
            + 'the sweep will run on the next fully-complete fetch.'
        );
      }

      // Update sync status. The cache sync itself succeeded, so status is
      // 'success' either way -- but when the sweep was SKIPPED for an
      // incomplete fetch, `error_message` carries that skip reason (instead of
      // being cleared to NULL) so the anomaly stays visible to an operator on
      // the Admin sync-status surface rather than being silently swallowed by a
      // 'success' row.
      await db.query(
        'UPDATE sync_status SET status = $1, records_synced = $2, error_message = $3 WHERE sync_type = $4',
        ['success', syncedCount, sweepSkippedMessage, 'user_sync']
      );

      this.lastSync = new Date();
      logger.info({ syncedCount }, 'Authentik user sync completed successfully');

    } catch (error) {
      logger.error({ err: error }, 'Authentik user sync failed');

      await db.query(
        'UPDATE sync_status SET status = $1, error_message = $2 WHERE sync_type = $3',
        ['error', error.message, 'user_sync']
      );
    } finally {
      this.isRunning = false;
    }
  }

  // Requirement 11.1/11.6: fetches the full Authentik group list, paginated,
  // exactly once per sync run, and returns the completed pk->name map.
  // Throws if any page of the pagination loop fails, so a partial
  // `allGroups` list is never returned to the caller and never used to
  // build a groupMap for processBatch.
  //
  // Bugfix: same stable-ordering fix as the user-list loop above --
  // Authentik's default group ordering is by name, which is not immune
  // to a group being created/renamed concurrently with this fetch (e.g.
  // a CloudTAK agency-group sync running alongside a bulk team import).
  // `ordering=num_pk` (the group's own stable integer key, distinct from
  // its UUID `pk`) is unaffected by concurrent name changes/inserts.
  async fetchGroupMap() {
    let allGroups = [];
    let currentPage = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      const groupsResponse = await authentikRequest.run({ kind: 'read' }, () => axios.get(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/?ordering=num_pk&page=${currentPage}`, {
        headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` },
        timeout: 30000
      }));

      allGroups = allGroups.concat(groupsResponse.data.results);

      if (groupsResponse.data.pagination && groupsResponse.data.pagination.next) {
        currentPage = groupsResponse.data.pagination.next;
      } else {
        hasMorePages = false;
      }
    }

    const groupMap = {};
    allGroups.forEach(group => {
      groupMap[group.pk] = group.name;
    });

    return groupMap;
  }

  /**
   * account-lifecycle-management Requirements 2, 3 (tasks 6.1, 7.1-7.5):
   * the Reconciliation_Sweep. Called exactly once per successful
   * `syncUsers` run (see that method's own call site, gated to the
   * success path only), with `fetchedAuthentikIds` being the exact set
   * of `authentik_id` values THIS run's paginated fetch returned.
   *
   * Finds every local `users` row whose `authentik_user_id` is absent
   * from that set and is not already `'orphaned'` -- i.e. a row this
   * Authentik instance no longer has an account for -- and, for each:
   * enqueues a certificate Revoke_Operation, clears the cached TAK
   * identity (human rows only), marks the row `'orphaned'`, and writes
   * an audit log attributed to the system rather than an admin.
   *
   * No `is_team_device` branch in the SELECT itself (Requirement 2
   * Criterion 4): a Team_Owned_Device row is found identically to a
   * human one; the per-type difference (skipping the cache-clear step)
   * is handled per-row below, not by excluding device rows from
   * detection.
   *
   * Runs against the bare `pool`/`db`, never an explicit transaction --
   * there is no caller-held transaction to share (this runs on the
   * periodic sync's own timer, not inside a request), matching how
   * every other write in this file already uses `db.query` directly.
   * Each row's four steps (enqueue, clear-cache, mark-orphaned,
   * audit-log) are wrapped in their own try/catch (Requirement 3
   * Criterion 1's robustness note) so one row's failure cannot prevent
   * the rest of the sweep from running -- mirroring `processBatch`'s own
   * "one user's failure must not abort or delay the others" discipline.
   *
   * @param {string[]} fetchedAuthentikIds - every `authentik_id` (as a
   *   string) this run's fetch returned.
   */
  async reconcileOrphanedAccounts(fetchedAuthentikIds) {
    // Resiliency-hardening: the candidate query below is
    // `authentik_user_id::text <> ALL($1::text[])`, and Postgres's `<>
    // ALL(...)` over an EMPTY array is vacuously true for every non-null
    // `authentik_user_id` -- so an empty (or malformed/non-array)
    // `fetchedAuthentikIds` would make EVERY active/suspended account in
    // the system a sweep candidate, and this method would orphan all of
    // them in one run. A live Authentik instance always has at least one
    // user (this app's own service-account token among them), so an
    // empty fetched-id list reaching here is itself evidence of an
    // upstream anomaly -- e.g. Authentik answering 200 with a truncated
    // or empty `results` page -- rather than a legitimate "Authentik
    // currently holds zero user accounts" state. This guard refuses to
    // run the sweep in that case rather than trusting it, logging so the
    // anomaly is visible without silently mass-orphaning every account.
    if (!Array.isArray(fetchedAuthentikIds) || fetchedAuthentikIds.length === 0) {
      logger.error(
        { fetchedAuthentikIds },
        'Reconciliation_Sweep: refusing to run against an empty or malformed fetched-id list; ' +
        'this would incorrectly orphan every account'
      );
      return;
    }

    let candidates;
    try {
      const result = await db.query(
        `SELECT id, authentik_user_id, is_team_device, username
           FROM users
          WHERE authentik_user_id::text <> ALL($1::text[])
            AND account_status <> 'orphaned'`,
        [fetchedAuthentikIds]
      );
      candidates = result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Reconciliation_Sweep: failed to query candidate rows; skipping this run\'s sweep');
      return;
    }

    if (candidates.length === 0) {
      return;
    }

    logger.info({ candidateCount: candidates.length }, 'Reconciliation_Sweep: orphaning accounts with no matching Authentik identity');

    for (const row of candidates) {
      try {
        // Step 1 (Requirement 3 Criterion 1): enqueue the Revoke_Operation,
        // the exact same client_uid/tak_usernames branch
        // AccountLifecycleService.suspendAccount uses, on the bare pool
        // (no open transaction to share here).
        const revokePayload = row.is_team_device
          ? { client_uid: row.username }
          : { tak_usernames: [row.username] };
        // Bugfix: `sync_operations.created_by` carries a real FK to
        // `users(id)` (confirmed against the schema -- there is no seeded
        // sentinel row for SYSTEM_USER_ID), so passing the -1 sentinel
        // here unconditionally threw inside this row's own try/catch,
        // silently skipping every remaining step below (the row was NEVER
        // actually marked orphaned) on every sync run, forever. NULL is a
        // valid, already-nullable value for this column and is what
        // `UserProvisioningService`'s own system-attributed write already
        // uses for the identical situation.
        await EventPublisher.publishOperation('revoke_tak_certificates', revokePayload, null);

        // Step 2 (Requirement 3 Criterion 2): clear the cached TAK
        // identity for a human row only -- a Team_Owned_Device carries
        // no tak_callsign/tak_color cache fields to clear. The exact
        // statement UserAttributesService.clearTeamAttributes issues,
        // reused directly rather than re-derived, keyed on
        // authentik_user_id since that (not the local id) is
        // user_cache's own key.
        //
        // Bugfix (stale takColor='None' on team-holding members): this
        // clear is now GATED on the user actually being teamless (zero
        // DIRECT team_memberships rows). An orphaning can be a FALSE
        // POSITIVE -- a pagination race during a concurrent bulk import
        // once falsely orphaned ~180 real, still-existing accounts, and
        // this exact clear then wiped the callsign/color of members who
        // still held a valid FENZ (etc.) membership. Because the
        // orphan-RECOVERY paths (External_Unlock and Account_Reclaim)
        // restore is_active but historically never recomputed the
        // team-derived callsign/color, that cleared value became permanent
        // and was subsequently pushed up to Authentik by the routine
        // per-user push -- surfacing as the impossible `takColor: None` on
        // a user assigned to a team. Clearing ONLY when the user is
        // genuinely teamless keeps the legitimate teamless behaviour intact
        // while never corrupting a still-teamed member's attributes on a
        // false orphan. (The recovery-path recompute added alongside this
        // is the belt-and-braces other half; this gate is the part that
        // stops the bad write happening in the first place.)
        //
        // ABSENT-not-'None' rule: when the user IS genuinely teamless we
        // NULL the user_cache columns -- never the literal 'None' or ''
        // ('None' is not a valid TAK_Color and must never be stored or
        // pushed; "no team" is the attribute being absent). Deliberately a
        // DIRECT cache NULL rather than a call to
        // UserAttributesService.clearTeamAttributes: this row is being
        // orphaned precisely because Authentik reports its identity as
        // MISSING, so there is no live Authentik user to PATCH/delete keys
        // on -- issuing an Authentik HTTP call here would just 404. The
        // cache NULL is the whole job; if the account is ever reclaimed,
        // the recovery recompute (recomputeTeamAttributesOnRecovery) or a
        // team re-add restores real values, and the push block only ever
        // deletes/sets keys for a still-present Authentik user.
        if (!row.is_team_device && row.authentik_user_id) {
          const directMembership = await db.query(
            'SELECT 1 FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL LIMIT 1',
            [row.id]
          );
          if (directMembership.rows.length === 0) {
            await db.query(
              'UPDATE user_cache SET tak_callsign = NULL, tak_color = NULL WHERE authentik_id = $1',
              [String(row.authentik_user_id)]
            );
          } else {
            logger.info(
              { authentikUserId: row.authentik_user_id, localUserId: row.id },
              'Reconciliation_Sweep: NOT clearing tak_callsign/tak_color -- ' +
              'this orphan candidate still holds a direct team membership (a likely ' +
              'false orphan); its team-derived attributes are preserved'
            );
          }
        }

        // Step 3 (Requirement 3 Criterion 3): mark the row orphaned and
        // deactivate it, mirroring AccountLifecycleService.suspendAccount's
        // own users/user_cache pair.
        await db.query(
          `UPDATE users SET account_status = 'orphaned', is_active = false WHERE id = $1`,
          [row.id]
        );
        if (row.authentik_user_id) {
          await db.query(
            'UPDATE user_cache SET is_active = false WHERE authentik_id = $1',
            [String(row.authentik_user_id)]
          );
        }

        // Step 4 (Requirement 3 Criterion 4): the audit row, attributed
        // to the system (not an admin) via a NULL user_id -- distinct
        // from an admin-initiated suspend's own 'user.suspend' audit
        // action. Bugfix: NOT the former SYSTEM_USER_ID (-1) sentinel,
        // which violated audit_logs.user_id's real FK to users(id) and
        // silently aborted this whole step (and every step after it) on
        // every run -- see the doc comment on the revoke-enqueue call
        // above.
        await db.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            null,
            'user.orphaned',
            'user',
            row.id,
            JSON.stringify({ reason: 'authentik_account_missing' })
          ]
        );
      } catch (rowError) {
        logger.error(
          { err: rowError, userId: row.id },
          'Reconciliation_Sweep: failed to orphan one candidate row; continuing with the rest of the sweep'
        );
      }
    }
  }

  async processBatch(users, groupMap) {
    const adminGroupName = process.env.ADMIN_GROUP_NAME || 'TakTeamManager_Admin';

    // Requirement 11.2: bounded concurrency instead of a fully serial `for`
    // loop. Each user's sync task is wrapped by `limit(...)`, and
    // syncSingleUser's own try/catch continues to swallow per-user
    // failures internally (logging via logger.error) so Promise.all never
    // observes a rejection from a single user's failure -- one user's
    // failure must not abort or delay other users in the batch.
    const limit = pLimit(getAuthentikSyncConcurrency());

    await Promise.all(
      users.map(user => limit(() => this.syncSingleUser(user, groupMap, adminGroupName)))
    );
  }

  async syncSingleUser(user, groupMap, adminGroupName) {
    try {
      // Skip a recognized ignored-prefix account (e.g. an ETL/service
      // account with no email and no local is_team_device row) BEFORE
      // attempting the upsert at all, rather than attempting it and
      // relying on the users_email_required_unless_device catch below to
      // discover it. That catch remains as a safety net for any
      // emailless, non-prefixed, non-device account -- this check only
      // shortcuts the ALREADY-KNOWN, ALREADY-EXPECTED case, so it logs at
      // `debug` (an expected skip) rather than `warn` (a caught failure).
      if (isIgnoredAuthentikUsername(user.username)) {
        logger.debug(
          { authentikUserId: user.pk, username: user.username },
          'Skipped users/user_cache sync for a username matching AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES'
        );
        return;
      }

      const groupNames = user.groups?.map(groupId => groupMap[groupId]).filter(Boolean) || [];
      const isAdmin = groupNames.includes(adminGroupName);

      // TAK Team Manager is authoritative for all user attributes after
      // initial bootstrap. The periodic sync pushes local values to Authentik
      // when they differ (see push-to-Authentik section below).
      //
      // Upsert into the local `users` table, keyed on authentik_user_id.
      // On INSERT (new user): seeds first_name/last_name from Authentik
      // attributes (bootstrap), sets is_active = true always, seeds tak_role
      // from Authentik if present.
      // On UPDATE (existing user): only identity fields (username, email) are
      // synced from Authentik. first_name, last_name, is_active, and tak_role
      // are LOCAL-authoritative and never overwritten by Authentik values.
      //
      // takserver-enrollment Requirement 5.6: this upsert is NOT skipped for
      // an emailless Authentik principal any more. `users.email` is nullable
      // now (Requirement 5.3), guarded instead by the
      // users_email_required_unless_device CHECK constraint -- a Team_Owned_
      // Device satisfies it via its existing is_team_device = true row and
      // therefore syncs normally. A recognized ignored-prefix account
      // (AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES) is already skipped above,
      // before reaching here. The one remaining reason a sync can still skip
      // a principal is a genuinely emailless, non-prefixed, NON-device row
      // with no local `users` row yet: the CHECK constraint rejects that
      // INSERT, and the narrow catch below (23514 on
      // users_email_required_unless_device) is what decides it, logging at
      // warn and skipping that principal's users AND user_cache writes,
      // rather than silently excluding it as the old `if (user.email)` guard
      // did for every emailless principal including every Team_Owned_Device.
      const takRoleFromAuthentik = user.attributes?.takRole ?? null;
      const seedFirstName = user.attributes?.first_name || user.name || user.username;
      const seedLastName = user.attributes?.last_name || '';

      // takserver-enrollment Requirement 5.5: normalise Authentik's
      // Empty_String_Email ('') to null exactly once, and bind that single
      // value to `email` in BOTH the `users` upsert and the `user_cache`
      // upsert below, so "no email" is NULL consistently on both tables for
      // the same principal rather than NULL on one and '' on the other.
      const email = normaliseAuthentikEmail(user.email);

      // BUGFIX (found during takserver-enrollment task 12.2 live
      // verification): `is_team_device` was omitted from the INSERT's
      // column list below, so Postgres evaluated the tentative INSERT
      // tuple's `is_team_device` at the column DEFAULT (false) against the
      // users_email_required_unless_device CHECK constraint BEFORE
      // `ON CONFLICT ... DO UPDATE` ever ran -- per Postgres's documented
      // INSERT ... ON CONFLICT semantics, the proposed row is checked
      // against constraints before conflict resolution. For an EXISTING
      // Team_Owned_Device row (email NULL, is_team_device already true in
      // the stored row), that made the tentative tuple (email=NULL,
      // is_team_device=false) violate the CHECK constraint on EVERY sync,
      // even though the real stored row already satisfied it -- and the
      // catch below misclassified it as "genuinely emailless principal
      // with no local row", silently skipping this device's users AND
      // user_cache writes on every run. The device kept working (its
      // `users` row was written once by DeviceEnrollmentService.createDevice)
      // but was never reconciled by sync again.
      //
      // The fix: the VALUES clause's own `is_team_device` expression reads
      // the row's EXISTING stored value via a same-statement subquery
      // keyed on authentik_user_id (reusing $1 -- no new bound parameter),
      // defaulting to false only when no row exists yet (a genuinely new
      // principal, which is never a device on this path -- devices are
      // created by DeviceEnrollmentService.createDevice's own INSERT, never
      // materialized for the first time here). Doing this as a subquery
      // inside the single INSERT statement, rather than a separate SELECT
      // issued beforehand, keeps the read and the write atomic within one
      // round trip: there is no window between "read is_team_device" and
      // "write the row" for Postgres to race in, which is a strictly
      // tighter guarantee than the other reads in this function settle for
      // (e.g. the push-to-Authentik SELECTs below, which already tolerate a
      // race against a concurrent write for the same principal). It is
      // deliberately NOT added to `ON CONFLICT ... DO UPDATE SET`: the
      // local `users` row is the authority for this column, and the update
      // path must leave whatever value the row already holds untouched.
      let isTeamDevice = false;
      let localUserId = null;
      let localTakRole = null;
      try {
        const usersUpsertResult = await db.query(
          'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active, tak_role, is_team_device) VALUES ($1, $2, $3, $4, $5, true, COALESCE($6, \'Team Member\'), COALESCE((SELECT is_team_device FROM users WHERE authentik_user_id = $1), false)) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3 RETURNING id, is_team_device, tak_role',
          [
            user.pk,
            user.username,
            email,
            seedFirstName,
            seedLastName,
            takRoleFromAuthentik
          ]
        );
        localUserId = usersUpsertResult.rows[0]?.id ?? null;
        isTeamDevice = usersUpsertResult.rows[0]?.is_team_device === true;
        // Bugfix (TAK Role blank on /dashboard for bulk-import/create-and-add
        // users): tak_role is LOCAL-authoritative (Authentik carries no
        // takRole for users provisioned locally, so `user.attributes?.takRole`
        // is null/undefined for them). Seed the user_cache mirror from the
        // effective value the `users` upsert just resolved -- which already
        // COALESCEs to 'Team Member' on INSERT and preserves the existing
        // local value on UPDATE -- rather than from the (often-absent)
        // Authentik attribute, which left user_cache.tak_role NULL and made
        // the Dashboard's "My TAK Role" block (reads user_cache via
        // GET /api/users/me) render nothing. This mirrors how the sibling
        // `users` upsert already treats tak_role as bootstrap-then-local.
        localTakRole = usersUpsertResult.rows[0]?.tak_role ?? null;
      } catch (usersUpsertError) {
        if (
          usersUpsertError.code === '23514' &&
          usersUpsertError.constraint === 'users_email_required_unless_device'
        ) {
          logger.warn(
            { authentikUserId: user.pk },
            'Skipped users/user_cache sync for an emailless Authentik principal with no local row (users_email_required_unless_device)'
          );
          return;
        }
        throw usersUpsertError;
      }

      // user_cache upsert: TAK Team Manager is authoritative for first_name,
      // last_name, tak_role, tak_color, tak_callsign, is_active after initial
      // bootstrap. On INSERT, seed identity/attribute values -- tak_color and
      // tak_callsign from Authentik's attributes, but tak_role from the LOCAL
      // `users` row (`localTakRole`, resolved by the upsert above), since
      // tak_role is local-authoritative and Authentik carries no takRole for
      // locally-provisioned users. On UPDATE, only sync identity fields
      // (username, email) and admin-related fields (groups, is_admin) from
      // Authentik.
      //
      // takserver-enrollment Requirement 5.6: is_team_device is added to the
      // INSERT column list, sourced from the `users` upsert's
      // RETURNING is_team_device above -- the local `users` row is the
      // authority for it, since Authentik carries no such field.
      // Deliberately absent from ON CONFLICT DO UPDATE SET, so the cache
      // adopts the flag on first insert and never overwrites it afterwards,
      // matching how this upsert already treats first_name/tak_role as
      // bootstrap-then-local.
      await db.query(`
        INSERT INTO user_cache (
          authentik_id, username, email, first_name, last_name, 
          is_active, tak_role, tak_color, tak_callsign, groups, is_admin, is_team_device, last_login
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (authentik_id) DO UPDATE SET
          username = EXCLUDED.username,
          email = EXCLUDED.email,
          groups = EXCLUDED.groups,
          is_admin = EXCLUDED.is_admin,
          -- last_login is a cached MIRROR of Authentik's value and is inherently
          -- mutable (advances on every login), so unlike the bootstrap-then-local
          -- fields above it IS refreshed from EXCLUDED every sync. Authentik is
          -- authoritative for it; there is no local write path that sets it.
          last_login = EXCLUDED.last_login,
          updated_at = CURRENT_TIMESTAMP
      `, [
        user.pk,
        user.username,
        email,
        seedFirstName,
        seedLastName,
        true,
        // tak_role: seeded from the local-authoritative `users` row (see the
        // usersUpsertResult.tak_role bugfix note above), NOT from Authentik's
        // often-absent takRole attribute. tak_color/tak_callsign remain
        // Authentik-sourced here -- those ARE pushed to and mirrored from
        // Authentik's attributes, unlike tak_role.
        localTakRole,
        user.attributes?.takColor,
        user.attributes?.takCallsign,
        groupNames,
        isAdmin,
        isTeamDevice,
        // last_login: Authentik's own field. `null` (never logged in) is a
        // valid, expected value and is stored as-is; the /users page renders
        // it as "Never". `?? null` normalises `undefined` (an older Authentik
        // response shape omitting the field) to a real SQL NULL.
        user.last_login ?? null
      ]);

      // --- Push local-authoritative attributes to Authentik when they differ ---
      // TAK Team Manager is authoritative for: first_name, last_name,
      // tak_callsign, tak_color, tak_role, is_active. Only PATCH if at least
      // one value differs (avoids unnecessary API calls).
      //
      // takserver-enrollment Requirement 5.6: this guard is keyed on "has a
      // local `users` row" (localUserId), not "has an email" -- that is the
      // condition the comment above always meant. With email now nullable,
      // "has an email" and "has a local row" are different questions: there
      // is nothing local to push for a principal with no local row, and a
      // Team_Owned_Device with a local row and no email has a tak_role
      // worth pushing back like any other principal.
      if (localUserId) {
        try {
          // Read the LOCAL authoritative values for this user
          const localResult = await db.query(
            'SELECT first_name, last_name, tak_role, is_active, account_status FROM users WHERE authentik_user_id = $1',
            [user.pk]
          );
          const cacheResult = await db.query(
            'SELECT tak_callsign, tak_color FROM user_cache WHERE authentik_id = $1',
            [String(user.pk)]
          );

          if (localResult.rows.length > 0) {
            const local = localResult.rows[0];
            const cache = cacheResult.rows[0] || {};

            // account-lifecycle-management (bugfix -- External_Lock
            // Detection): this service is otherwise entirely one-directional
            // for is_active -- LOCAL is authoritative, and any mismatch is
            // resolved by PATCHing Authentik to match (below). That is
            // backwards for exactly one case: an admin manually disabling
            // this account DIRECTLY in Authentik (bypassing
            // AccountLifecycleService.suspendAccount entirely). Before this
            // fix, that manual lock was invisible here and was actively
            // UNDONE on the very next sync, since local `is_active` (still
            // `true`, unaware of the change) would be pushed back onto
            // Authentik as `is_active: true` by the push-to-Authentik step
            // below -- silently re-enabling an account an admin just tried
            // to lock, with no certificate revocation ever triggered.
            //
            // Detected as: Authentik reports `is_active: false` for an
            // account whose LOCAL `account_status` is still `'active'` --
            // i.e. this app never suspended it itself (an app-initiated
            // suspend already sets local `account_status = 'suspended'`
            // synchronously, before any PATCH is attempted, so that case
            // never reaches this branch). Deliberately NOT keyed on
            // `is_team_device` -- Requirement 1's "applies identically to a
            // human and a Team_Owned_Device" framing applies here too, and
            // `isTeamDevice`/`user.username` are already in scope from the
            // upsert above, so no extra query is needed for the revoke
            // payload shape.
            //
            // Response mirrors `AccountLifecycleService.suspendAccount`'s
            // own local-write + Revoke_Operation shape, and
            // `reconcileOrphanedAccounts`'s own audit-attribution
            // convention (NULL user_id, not an admin) for a
            // system-detected transition. `local.is_active`/
            // `local.account_status` are updated IN PLACE afterward so the
            // push-to-Authentik comparison immediately below sees the NEW,
            // already-Authentik-consistent state -- without that, the
            // stale `local.is_active = true` read above would make
            // `isActiveChanged` true and re-push `is_active: true`,
            // undoing the very lock just reflected.
            //
            // See the mirror-image External_Unlock Detection branch just
            // below this one for the reverse direction (Authentik-side
            // unlock of a locally-suspended account).
            if (user.is_active === false && local.account_status === 'active') {
              try {
                await db.query(
                  `UPDATE users SET account_status = 'suspended', is_active = false WHERE id = $1`,
                  [localUserId]
                );
                await db.query(
                  'UPDATE user_cache SET is_active = false WHERE authentik_id = $1',
                  [String(user.pk)]
                );

                const revokePayload = isTeamDevice
                  ? { client_uid: user.username }
                  : { tak_usernames: [user.username] };
                // Bugfix: see the identical fix + comment on
                // reconcileOrphanedAccounts's own revoke-enqueue above --
                // SYSTEM_USER_ID (-1) violates the real FK on
                // sync_operations.created_by and silently aborted this
                // whole branch via its enclosing try/catch on every run.
                await EventPublisher.publishOperation('revoke_tak_certificates', revokePayload, null);

                await db.query(
                  `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [
                    null,
                    'user.suspended_externally',
                    'user',
                    localUserId,
                    JSON.stringify({ reason: 'authentik_is_active_false' })
                  ]
                );

                logger.info(
                  { authentikUserId: user.pk, localUserId },
                  'External_Lock Detection: Authentik reports is_active=false for a locally-active account; reflected as account_status=suspended and enqueued certificate revocation'
                );

                // Keep the in-memory `local` snapshot consistent with what
                // was just written, so the push-to-Authentik comparison
                // below does not treat this row as needing a PATCH at all.
                local.is_active = false;
                local.account_status = 'suspended';
              } catch (lockDetectionError) {
                // Non-fatal, matching every other per-user/per-row
                // best-effort step in this file: log and continue with the
                // REST of this user's sync (and every other user in the
                // batch) rather than aborting. An undetected lock simply
                // retries on the next sync interval.
                logger.error(
                  { err: lockDetectionError, authentikUserId: user.pk, localUserId },
                  'External_Lock Detection: failed to reflect a detected Authentik-side account lock; will retry on the next sync'
                );
              }
            }

            // External_Unlock Detection: the mirror-image direction. TAK
            // Team Manager is meant to be the single source of truth, but
            // an admin unlocking an account directly in Authentik (the
            // exact reverse of the External_Lock case just above) is a
            // real, supported workflow this app should recognise rather
            // than silently ignore or fight -- the whole reason the LOCK
            // direction is detected at all is "reflect what actually
            // happened in Authentik", and an unlock is just as real an
            // event as a lock.
            //
            // Detected as: Authentik reports `is_active: true` for an
            // account whose LOCAL `account_status` is still `'suspended'`
            // -- i.e. nobody unsuspended it through
            // `AccountLifecycleService.unsuspendAccount` (that path already
            // sets local `account_status = 'active'` synchronously before
            // any PATCH, so it never reaches this branch either).
            // Deliberately does NOT touch an `'orphaned'` row: `orphaned`
            // means the Reconciliation_Sweep already found this identity
            // MISSING from Authentik on a past run, and an `'orphaned'` row
            // is only ever reachable in THIS loop at all if Authentik's
            // current fetch returned a user sharing its `authentik_user_id`
            // -- a distinct, separate re-signup/re-creation situation that
            // Requirement 5's Account_Reclaim flow owns, not this sync.
            //
            // No certificate action here, deliberately mirroring
            // `AccountLifecycleService.unsuspendAccount`'s OWN behaviour:
            // unsuspending never restores a previously revoked
            // certificate, so an externally-detected unsuspend does not
            // either -- re-enrollment is the only path back to a live one,
            // exactly as after any other revoke.
            if (user.is_active === true && local.account_status === 'suspended') {
              try {
                await db.query(
                  `UPDATE users SET account_status = 'active', is_active = true WHERE id = $1`,
                  [localUserId]
                );
                await db.query(
                  'UPDATE user_cache SET is_active = true WHERE authentik_id = $1',
                  [String(user.pk)]
                );

                await db.query(
                  `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [
                    null,
                    'user.unsuspended_externally',
                    'user',
                    localUserId,
                    JSON.stringify({ reason: 'authentik_is_active_true' })
                  ]
                );

                logger.info(
                  { authentikUserId: user.pk, localUserId },
                  'External_Unlock Detection: Authentik reports is_active=true for a locally-suspended account; reflected as account_status=active'
                );

                // Same reasoning as External_Lock Detection above: keep
                // the in-memory snapshot consistent with what was just
                // written, so the push-to-Authentik comparison below sees
                // no is_active mismatch to re-push.
                local.is_active = true;
                local.account_status = 'active';

                // Bugfix (stale takColor='None' on team-holding members):
                // recompute this recovered account's team-derived
                // callsign/color from its DIRECT team, rather than leaving
                // whatever `user_cache` currently holds. The observed
                // failure mode is orphaned -> suspended_externally ->
                // unsuspended_externally: the Reconciliation_Sweep had
                // (often falsely) cleared tak_callsign/tak_color on
                // orphaning, and NOTHING between there and here ever
                // restored them -- so a real FENZ member came back active
                // with an absent/stale colour, which the routine per-user
                // push below then propagated up to Authentik. Now that the
                // account is active again, if it still holds a direct team
                // membership we re-derive the correct values (organisation
                // colour + assembled callsign) and mirror them into
                // user_cache here; the push block immediately below then
                // sends the CORRECT value to Authentik in the same sync
                // pass. A genuinely teamless recovered account has no
                // direct membership, so generateCallsign resolves nothing
                // and we leave the cache untouched -- its absent (NULL)
                // callsign/colour is then legitimate.
                await this.recomputeTeamAttributesOnRecovery(localUserId, user.pk, cache);
              } catch (unlockDetectionError) {
                logger.error(
                  { err: unlockDetectionError, authentikUserId: user.pk, localUserId },
                  'External_Unlock Detection: failed to reflect a detected Authentik-side account unlock; will retry on the next sync'
                );
              }
            }

            // Bugfix (mass false-positive account deactivation via a
            // false orphaning): this push-to-Authentik block used to run
            // unconditionally on `account_status`, treating
            // `local.is_active` as authoritative and PATCHing Authentik
            // to match it whenever they differ. That is correct for
            // `'active'`/`'suspended'` rows, but actively harmful for an
            // `'orphaned'` one: `reconcileOrphanedAccounts` sets
            // `is_active = false` the moment it believes an Authentik
            // identity is gone, but an `'orphaned'` row's `is_active` is a
            // SIDE EFFECT of that belief, not a deliberate, confirmed
            // lock -- and that belief can be wrong (confirmed live: a
            // pagination race during a concurrent bulk import falsely
            // orphaned ~180 real, still-existing accounts in one
            // incident). Before this fix, the very next sync run after a
            // false orphan would see `user.is_active` (true, since the
            // Authentik account never actually went away) disagree with
            // `localIsActive` (false, from the orphaning) and PATCH
            // Authentik's `is_active` to `false` -- turning a false LOCAL
            // belief into a REAL deactivation of a live account, which is
            // a strictly worse outcome than the original false orphan and
            // is not self-healing: Account_Reclaim is the only path back
            // out of `'orphaned'`, but nothing before this fix ever
            // reversed the Authentik-side deactivation this block caused
            // along the way, so even a manual local restore (setting
            // `account_status` back to `'active'`) left Authentik and the
            // local row disagreeing until an operator also manually
            // PATCHed Authentik -- and if that PATCH is missed, the NEXT
            // sync's External_Lock Detection (correctly, by its own
            // logic) treats the still-stale Authentik `is_active: false`
            // as a fresh external lock and suspends the account all over
            // again.
            //
            // The fix: skip this entire diff-and-PATCH block for an
            // `'orphaned'` row. This mirrors the External_Lock/
            // External_Unlock branches just above, which already
            // deliberately leave `'orphaned'` rows alone for the same
            // reason (see their own comments) -- Account_Reclaim owns
            // recovering an orphaned identity, not the routine per-sync
            // attribute push.
            if (local.account_status === 'orphaned') {
              return;
            }

            // Current Authentik values (from the user object we already fetched)
            const authentikAttrs = user.attributes || {};
            const authentikName = user.name || '';

            // Local authoritative values
            const localFirstName = local.first_name || '';
            const localLastName = local.last_name || '';
            const localTakRole = local.tak_role || 'Team Member';
            const localIsActive = local.is_active !== false; // default true
            const localFullName = `${localFirstName}${localLastName ? ' ' + localLastName : ''}`;

            // ABSENT-not-'None' rule for the team-derived attributes:
            // tak_callsign/tak_color are team-derived and a teamless user
            // has them ABSENT (NULL in user_cache, key deleted in
            // Authentik) -- never the literal 'None' or ''. Treat NULL,
            // '' and the legacy 'None' sentinel all as "absent" here: a
            // present local value is pushed/set; an absent one means the
            // Authentik key must be DELETED, never set to '' or 'None'
            // (which would re-introduce exactly the invalid value this
            // whole change removes, and 'None' is not a valid TAK_Color).
            const isAbsentTakValue = (v) => v === null || v === undefined || v === '' || v === 'None';
            const hasLocalCallsign = !isAbsentTakValue(cache.tak_callsign);
            const hasLocalColor = !isAbsentTakValue(cache.tak_color);
            const localTakCallsign = hasLocalCallsign ? cache.tak_callsign : '';
            const localTakColor = hasLocalColor ? cache.tak_color : '';

            // Authentik-side presence, normalising its own legacy '' /
            // 'None' values to "absent" so a stale 'None' up there is seen
            // as a difference worth correcting (by deletion).
            const authentikHasCallsign = !isAbsentTakValue(authentikAttrs.takCallsign);
            const authentikHasColor = !isAbsentTakValue(authentikAttrs.takColor);

            // Check if anything differs
            const nameChanged = authentikName !== localFullName;
            const isActiveChanged = user.is_active !== localIsActive;
            const callsignChanged = hasLocalCallsign
              ? (authentikAttrs.takCallsign || '') !== localTakCallsign
              : authentikHasCallsign; // local absent: changed iff Authentik still has one
            const colorChanged = hasLocalColor
              ? (authentikAttrs.takColor || '') !== localTakColor
              : authentikHasColor; // local absent: changed iff Authentik still has one
            const attrsChanged = (
              (authentikAttrs.first_name || '') !== localFirstName ||
              (authentikAttrs.last_name || '') !== localLastName ||
              callsignChanged ||
              colorChanged ||
              (authentikAttrs.takRole || '') !== localTakRole
            );

            if (nameChanged || isActiveChanged || attrsChanged) {
              const mergedAttributes = {
                ...authentikAttrs,
                first_name: localFirstName,
                last_name: localLastName,
                takRole: localTakRole
              };

              // ABSENT-not-'None': set the team-derived key only when a
              // real local value exists; otherwise DELETE it from the
              // merged dict so the PATCH removes it from Authentik (rather
              // than writing '' or 'None').
              if (hasLocalCallsign) {
                mergedAttributes.takCallsign = localTakCallsign;
              } else {
                delete mergedAttributes.takCallsign;
              }
              if (hasLocalColor) {
                mergedAttributes.takColor = localTakColor;
              } else {
                delete mergedAttributes.takColor;
              }

              const patchPayload = {
                name: localFullName,
                is_active: localIsActive,
                attributes: mergedAttributes
              };

              const patchResponse = await authentikRequest.run({ kind: 'write' }, () => axios.patch(
                `${process.env.AUTHENTIK_URL}/api/v3/core/users/${user.pk}/`,
                patchPayload,
                {
                  headers: {
                    'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
                    'Content-Type': 'application/json'
                  },
                  timeout: 10000
                }
              ));

              if (patchResponse.status >= 200 && patchResponse.status < 300) {
                logger.debug({ username: user.username }, 'Pushed local attributes to Authentik');
              }
            }
          }
        } catch (pushError) {
          // Non-fatal: log and continue — the next sync will retry
          logger.error({ err: pushError, username: user.username }, 'Failed to push attributes to Authentik');
        }
      }
    } catch (error) {
      logger.error({ err: error, username: user.username }, 'Failed to sync user');
    }
  }

  /**
   * Bugfix (stale takColor='None' on team-holding members): re-derive a
   * just-recovered account's team-derived callsign/color from its DIRECT
   * team and mirror the result into `user_cache`, mutating the in-memory
   * `cache` snapshot in place so the caller's push-to-Authentik comparison
   * (which reads `cache.tak_callsign`/`cache.tak_color`) sees the corrected
   * values and pushes THOSE to Authentik in the same pass.
   *
   * A user directly in a Sub_Team also holds INHERITED membership rows in
   * every ancestor; the callsign/colour must be resolved against the
   * DIRECT team (`inherited_from_team_id IS NULL`) only, exactly as
   * `server/routes/teams.js`'s member-edit path documents -- resolving
   * against an ancestor drops the Sub_Team segment. A genuinely teamless
   * account has no such row: `generateCallsign` is never called, the cache
   * is left untouched, and any legitimate absent (NULL) callsign/colour it
   * carries stands.
   *
   * Best-effort and self-contained: any failure is logged and swallowed so
   * it can never abort the enclosing per-user sync -- the next sync run
   * retries. This is a private helper on the service so it can be spied on
   * directly in tests without reaching into Authentik.
   *
   * @param {number} localUserId - local `users.id` of the recovered account
   * @param {string|number} authentikUserId - Authentik pk (user_cache key)
   * @param {{tak_callsign?: string, tak_color?: string}} cache - the
   *   in-memory user_cache snapshot to keep consistent with the DB write
   * @returns {Promise<void>}
   */
  async recomputeTeamAttributesOnRecovery(localUserId, authentikUserId, cache) {
    try {
      if (!localUserId) return;

      const directTeamResult = await db.query(
        'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL LIMIT 1',
        [localUserId]
      );
      const directTeamId = directTeamResult.rows[0]?.team_id;

      // No direct membership -> genuinely teamless -> nothing team-derived
      // to restore. Leave the cache exactly as-is (a legitimate 'None').
      if (directTeamId === undefined || directTeamId === null) {
        return;
      }

      const UserAttributesService = require('./userAttributes');
      const attributes = await UserAttributesService.generateCallsign(localUserId, directTeamId);

      // generateCallsign returns null when the user/team can't be resolved
      // (e.g. team since deleted). Don't overwrite the cache with nothing.
      if (!attributes) {
        return;
      }

      await db.query(
        'UPDATE user_cache SET tak_callsign = $1, tak_color = $2 WHERE authentik_id = $3',
        [attributes.callsign, attributes.color, String(authentikUserId)]
      );

      // Keep the caller's in-memory snapshot consistent, so the
      // push-to-Authentik comparison sends the corrected values this pass.
      if (cache) {
        cache.tak_callsign = attributes.callsign;
        cache.tak_color = attributes.color;
      }

      logger.info(
        { authentikUserId, localUserId, directTeamId, color: attributes.color },
        'Recovery recompute: restored team-derived tak_callsign/tak_color for a recovered account that still holds a direct team membership'
      );
    } catch (recomputeError) {
      logger.error(
        { err: recomputeError, authentikUserId, localUserId },
        'Recovery recompute: failed to restore team-derived callsign/color; will retry on the next sync'
      );
    }
  }

  async getUserFromCache(username) {
    const result = await db.query(
      'SELECT * FROM user_cache WHERE username = $1 AND is_active = true',
      [username]
    );
    return result.rows[0];
  }

  async getSyncStatus() {
    const result = await db.query(
      'SELECT * FROM sync_status WHERE sync_type = $1',
      ['user_sync']
    );
    return result.rows[0];
  }

  startPeriodicSync() {
    // Operational kill-switch for the periodic user sync AND its
    // Reconciliation_Sweep. This is an opt-OUT, not the usual `'true'`-only
    // feature-flag: the sync is ON by default (an absent or any-other value
    // leaves it running, preserving existing behaviour), and is disabled ONLY
    // when AUTHENTIK_SYNC_ENABLED is explicitly the string 'false'. It exists
    // so an operator can halt the sweep during a bulk import or an Authentik
    // maintenance window, where a partial/errored Authentik fetch would
    // otherwise drive reconcileOrphanedAccounts to false-orphan real users
    // (the documented pagination-race incident this file already carries
    // several comments about). Disabling here stops the initial run and the
    // recurring interval both -- nothing schedules the sweep if this returns.
    if (process.env.AUTHENTIK_SYNC_ENABLED === 'false') {
      logger.warn(
        'Periodic Authentik sync DISABLED via AUTHENTIK_SYNC_ENABLED=false; '
          + 'the reconciliation sweep will not run until it is re-enabled'
      );
      return;
    }

    // Clamped to a 1-minute floor, mirroring the guard already used for the
    // Sync_Worker's own scheduled jobs (ExpiryScheduler, RetentionCleanupJob,
    // SubscriptionPoller, DeviceSync, AdminCredentialRefreshJob): a
    // misconfigured 0 or negative value would otherwise fire `setInterval`
    // on effectively every tick. `this.isRunning` already collapses any
    // overlapping tick into a no-op, so the floor is a sanity guard against
    // busy-looping the timer itself, not a correctness requirement. No
    // upper bound is imposed -- nothing pins a maximum staleness for this
    // reconciliation sweep.
    const MIN_INTERVAL_MINUTES = 1;
    const DEFAULT_INTERVAL_MINUTES = 10;

    const intervalMinutes = Math.max(
      MIN_INTERVAL_MINUTES,
      parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || DEFAULT_INTERVAL_MINUTES
    );
    logger.info({ intervalMinutes }, 'Starting periodic Authentik sync');

    // Run initial sync. syncUsers() already has its own internal try/catch
    // (which logs via the structured logger and updates sync_status on
    // failure), but setTimeout's callback return value is discarded either
    // way, so this is a fire-and-forget invocation of an async function.
    // The .catch() below is a defensive backstop per Requirement 8.7: if a
    // future change ever removes that internal try/catch, or an error is
    // thrown outside of it (e.g. synchronously, before the try block), the
    // rejection is still routed through the structured logger instead of
    // becoming an unhandled rejection or falling back to console.error.
    setTimeout(() => {
      this.syncUsers().catch(err =>
        logger.error({ err }, 'Periodic Authentik sync failed (initial run)')
      );
    }, 5000); // 5 second delay on startup

    // Set up periodic sync. Same fire-and-forget reasoning applies here:
    // setInterval never awaits or catches the promise returned by
    // syncUsers(), so an explicit .catch() backstop routes any error
    // through the structured logger.
    setInterval(() => {
      this.syncUsers().catch(err =>
        logger.error({ err }, 'Periodic Authentik sync failed')
      );
    }, intervalMinutes * 60 * 1000);
  }
}

module.exports = new AuthentikSyncService();
// Exposed for unit testing the concurrency clamp logic (Requirement 11.2)
// independent of the singleton instance's internal state.
module.exports.getAuthentikSyncConcurrency = getAuthentikSyncConcurrency;