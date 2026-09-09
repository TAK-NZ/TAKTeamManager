const pool = require('../config/database');
const TakServerService = require('./TakServerService');
const EmailService = require('./EmailService');
const { withJobLock, JOB_LOCK_KEYS } = require('../utils/jobLock');
const { classifyObservedCallsign, isCallsignAcceptable } = require('../utils/callsignMatch');
const logger = require('../config/logger').createLogger('CallsignPoller');

/**
 * Callsign_Poller (design: docs/ARCHITECTURE.md ("Callsign Mismatch Detection" section)).
 *
 * The FAST half of the fast-live / slow-history split. It runs every ~1 minute
 * against TAK Server's LIVE subscription table (`GET /Marti/api/subscriptions/all`,
 * `TakServerService.getAllSubscriptions()`) and detects when a client is
 * connected under a callsign that does not preserve the callsign TAK Team
 * Manager assigned to that user. It:
 *
 *   1. records the observed callsign on the matching `tak_devices` row
 *      (`observed_callsign`),
 *   2. maintains the mismatch-episode latch columns
 *      (`callsign_violation_first_seen_at`, `callsign_violation_notified_at`),
 *      which drive the in-app nudge and the single first-detection email,
 *   3. sends that one email, post-commit and best-effort, on the confirmed
 *      good -> bad transition (see the latch state machine in `run()`).
 *
 * WHY THE LIVE ENDPOINT, NOT THE HISTORY ENDPOINT
 *
 * The history `SubscriptionPoller` (`clientEndPoints`) keeps owning
 * `last_seen_at`/`connected` at its 5-minute cadence and is UNCHANGED. This job
 * is separate because a callsign mismatch is a "what is this client connected
 * as RIGHT NOW" question, best answered by the live subscription table, which
 * updates every few seconds. `SubscriptionInfo` carries a `callsign` and, for
 * real interactive clients (ATAK/iTAK/WinTAK), a populated `clientUid` that IS
 * the certificate's `client_uid` — the join key. API-only connections (CloudTAK
 * ETLs) leave `clientUid` blank; those, and any `ANDROID-CloudTAK-` cert, are
 * IGNORED here (CloudTAK prevents callsign changes at the source, so it cannot
 * produce a real mismatch — design's CloudTAK skip).
 *
 * OWNERSHIP. This job is the SOLE writer of `observed_callsign`,
 * `callsign_violation_first_seen_at`, and `callsign_violation_notified_at` on
 * `tak_devices`. The history poller owns `last_seen_at`/`connected`; the revoke
 * handler owns `revoked`; `DeviceSync`'s upsert lists none of them.
 *
 * CONNECTED-ONLY BY CONSTRUCTION. `subscriptions/all` carries only currently-
 * connected sessions, so a device that connected wrong then disconnected is
 * absent from the feed. Both the in-app nudge and the email are therefore
 * inherently connected-only, and the debounce ("mismatch across two consecutive
 * 1-minute polls") also means "still connected and still wrong."
 *
 * NEVER THROWS. Mirrors the sibling schedulers: `run()` catches its own errors,
 * so a TAK Server outage or a bad row cannot crash the Sync_Worker. A failed
 * fetch ends the run before any write, leaving every tracking column untouched,
 * and the next tick retries.
 *
 * SCHEDULER SHAPE. Identical to `SubscriptionPoller`/`DeviceSync`: a clamped
 * interval from an env var, a `start()` that runs one pass immediately then
 * schedules a recurring `setInterval`, an idempotent `stop()`, and a
 * cross-process `withJobLock` guard so only one worker polls per tick.
 */

/** The `ANDROID-CloudTAK-` cert-prefix marks a CloudTAK client (design's skip). */
const CLOUDTAK_CLIENT_UID_PREFIX = 'ANDROID-CloudTAK-';

class CallsignPoller {
  /**
   * @param {Object} [options]
   * @param {import('./TakServerService')} [options.takServerService] the shared
   *   `TakServerService` (same instance the Admin_Credential_Loader refreshes),
   *   so a rotated credential applies here too.
   * @param {{query: Function, connect: Function}} [options.pool] the db pool;
   *   defaults to the shared pool and is injectable for unit tests.
   * @param {EmailService} [options.emailService] injectable for tests.
   */
  constructor({ takServerService = new TakServerService(), pool: dbPool = pool, emailService } = {}) {
    this.takServerService = takServerService;
    this.pool = dbPool;
    this.emailService = emailService || new EmailService();

    // Clamped interval, mirroring the sibling schedulers. Default 60s; floored
    // at 60s — a callsign check that ran more often than once a minute would
    // hammer the live endpoint for no benefit, and the debounce is expressed in
    // whole polls, so a sub-minute interval only shortens the flap window
    // without adding signal. `parseInt(...) || default` then `Math.max`.
    const MIN_INTERVAL_SECONDS = 60; // 1 minute
    const DEFAULT_INTERVAL_SECONDS = 60; // 1 minute

    const intervalSeconds = Math.max(
      MIN_INTERVAL_SECONDS,
      parseInt(process.env.CALLSIGN_POLL_INTERVAL_SECONDS, 10) || DEFAULT_INTERVAL_SECONDS
    );
    this.intervalMs = intervalSeconds * 1000;

    this.timer = null;
  }

  /**
   * Starts the poller: one immediate pass, then a recurring one every
   * `this.intervalMs`. No-op if already running (idempotent double-start guard,
   * as with the sibling schedulers).
   */
  start() {
    if (this.timer) return;

    logger.info({ intervalMs: this.intervalMs }, 'Callsign poller started');

    this.runGuarded();

    this.timer = setInterval(() => {
      this.runGuarded();
    }, this.intervalMs);
  }

  /** Stops the poller, clearing the recurring interval. No-op if not running. */
  stop() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
    logger.info('Callsign poller stopped');
  }

  /**
   * The SCHEDULED entry point: `run()` under the cross-process single-runner
   * advisory lock, so at desiredCount > 1 only one worker polls per tick.
   * `run()` itself is left unguarded so direct/test callers exercise the logic
   * without a lock. The lock's own failure path is caught here so a
   * lock/connection error never becomes an unhandled rejection.
   */
  async runGuarded() {
    try {
      await withJobLock(this.pool, JOB_LOCK_KEYS.CALLSIGN_POLLER, () => this.run());
    } catch (error) {
      logger.error({ err: error }, 'Callsign poll (guarded) failed');
    }
  }

  /**
   * Runs one poll. NEVER throws.
   *
   * Steps:
   *  1. Fetch the live subscription table. A failure ends the run with an
   *     `outcome: 'failed'` log line and NO writes.
   *  2. Reduce to a `client_uid -> observed callsign` map, keeping the most
   *     recent entry per uid (by `lastReportMilliseconds`) and dropping blank-
   *     `clientUid` and CloudTAK entries.
   *  3. For each reported uid, load the matching `tak_devices` row joined to its
   *     user's assigned callsign + email/first name, classify the observed
   *     callsign, write `observed_callsign` and advance the latch columns, and
   *     collect any device that just crossed the confirmed good->bad transition.
   *  4. AFTER those writes, send the single first-detection email per collected
   *     device (best-effort, outside any transaction), then stamp
   *     `callsign_violation_notified_at` on success.
   *
   * @returns {Promise<{reported: number, matched: number, acceptable: number,
   *   mismatched: number, firstSeen: number, emailed: number,
   *   failed: number}|undefined>} per-run counts, or `undefined` when the fetch
   *   failed or returned a non-list (already logged `outcome: 'failed'`).
   */
  async run() {
    let subscriptions;
    try {
      subscriptions = await this.takServerService.getAllSubscriptions();
    } catch (error) {
      // `subscriptions/all` is documented; any failure means the request was
      // wrong or TAK Server is unreachable, NOT that nobody is connected.
      // Leave every tracking column untouched and retry next tick.
      logger.error(
        { err: error, endpoint: LIVE_SUBSCRIPTIONS_PATH, outcome: 'failed' },
        'Callsign poll failed to reach the live subscriptions API; leaving callsign state unchanged'
      );
      return undefined;
    }

    if (!Array.isArray(subscriptions)) {
      logger.error(
        { endpoint: LIVE_SUBSCRIPTIONS_PATH, outcome: 'failed' },
        'Callsign poll received a malformed live-subscriptions payload; leaving callsign state unchanged'
      );
      return undefined;
    }

    const observedByUid = reduceObservedCallsigns(subscriptions);

    const counts = {
      reported: observedByUid.size,
      matched: 0,
      acceptable: 0,
      mismatched: 0,
      firstSeen: 0,
      emailed: 0,
      failed: 0
    };

    // Devices that crossed the confirmed good->bad transition THIS poll and so
    // need the single first-detection email. Collected during the write pass,
    // sent after it (never inside a per-row transaction).
    const toEmail = [];

    for (const [clientUid, observedCallsign] of observedByUid) {
      try {
        const row = await this.loadDeviceForUid(clientUid);
        if (!row) {
          // A live session whose certificate we have no `tak_devices` row for
          // (or whose row has no owning user) — nothing to attribute. Not an
          // error; the history poller/DeviceSync owns row creation.
          continue;
        }
        counts.matched += 1;

        const assignedCallsign = row.tak_callsign; // user_cache.tak_callsign (assembled), may be null (teamless)
        const acceptable = isCallsignAcceptable(observedCallsign, assignedCallsign);

        if (acceptable) {
          counts.acceptable += 1;
          // Good (or teamless -> no assignment to violate): record the observed
          // callsign and CLEAR the latch, re-arming the next episode.
          await this.recordAcceptable(clientUid, observedCallsign);
          continue;
        }

        counts.mismatched += 1;
        const transition = await this.recordMismatch(clientUid, observedCallsign);
        if (transition === 'first_seen') {
          counts.firstSeen += 1;
        } else if (transition === 'confirmed') {
          // Second consecutive mismatching poll AND not yet notified this
          // episode: queue the email. Only queue when we can actually reach the
          // user.
          if (row.email) {
            toEmail.push({
              clientUid,
              email: row.email,
              firstName: row.first_name || '',
              assignedCallsign: assignedCallsign || '',
              observedCallsign
            });
          } else {
            logger.warn(
              { clientUid },
              'Callsign mismatch confirmed but user has no email; relying on the in-app nudge only'
            );
          }
        }
      } catch (error) {
        counts.failed += 1;
        logger.error({ err: error, clientUid }, 'Failed to process callsign for reported device');
      }
    }

    // Post-write, best-effort email send. Each send is independently caught; a
    // failure logs and does NOT stamp `notified_at`, so the next poll retries
    // (a rare duplicate on a mid-send crash is preferable to silently never
    // sending — see design's ordering note).
    for (const target of toEmail) {
      try {
        await this.sendMismatchEmail(target);
        await this.markNotified(target.clientUid);
        counts.emailed += 1;
      } catch (error) {
        counts.failed += 1;
        logger.error(
          { err: error, clientUid: target.clientUid },
          'Failed to send callsign-mismatch email; will retry next poll'
        );
      }
    }

    logger.info({ ...counts, outcome: 'completed' }, 'Callsign poll completed');
    return counts;
  }

  /**
   * Loads the single `tak_devices` row for `clientUid` joined to its owning
   * user's assigned callsign (`user_cache.tak_callsign`) and contact fields.
   * The assigned callsign is read from `user_cache` — the already-assembled,
   * already-trusted value the rest of the UI reads — never recomputed here.
   *
   * @param {string} clientUid
   * @returns {Promise<{email: string|null, first_name: string|null,
   *   tak_callsign: string|null}|null>} null when no device row matches or it
   *   has no owning user.
   */
  async loadDeviceForUid(clientUid) {
    const result = await this.pool.query(
      `SELECT u.email, u.first_name, uc.tak_callsign
         FROM tak_devices d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN user_cache uc ON uc.authentik_id = u.authentik_user_id::text
        WHERE d.client_uid = $1`,
      [clientUid]
    );
    return result.rows[0] || null;
  }

  /**
   * Records an ACCEPTABLE observation: store the observed callsign and CLEAR the
   * mismatch-episode latch (both timestamps to NULL), so a later re-breakage is
   * treated as a fresh episode and emails again.
   *
   * @param {string} clientUid
   * @param {string} observedCallsign
   * @returns {Promise<void>}
   */
  async recordAcceptable(clientUid, observedCallsign) {
    await this.pool.query(
      `UPDATE tak_devices
          SET observed_callsign = $2,
              callsign_violation_first_seen_at = NULL,
              callsign_violation_notified_at = NULL
        WHERE client_uid = $1`,
      [clientUid, observedCallsign]
    );
  }

  /**
   * Records a MISMATCH observation and advances the latch, returning which
   * transition this poll represents:
   *
   *  - 'first_seen': no episode was in flight (`first_seen_at` was NULL); this
   *    poll opens one. NO email yet (the one-poll debounce).
   *  - 'confirmed': an episode was already in flight AND not yet notified
   *    (`first_seen_at` set, `notified_at` NULL); this is the second consecutive
   *    mismatching poll — the caller sends the single email and then stamps
   *    `notified_at` via `markNotified`.
   *  - 'already_notified': the episode was already notified; nothing more to do.
   *
   * `observed_callsign` is written in every case. `first_seen_at` is set with
   * `COALESCE(existing, NOW())` so it marks the FIRST poll of the episode and is
   * not rewound on subsequent mismatching polls.
   *
   * @param {string} clientUid
   * @returns {Promise<'first_seen'|'confirmed'|'already_notified'>}
   */
  async recordMismatch(clientUid, observedCallsign) {
    const result = await this.pool.query(
      `UPDATE tak_devices
          SET observed_callsign = $2,
              callsign_violation_first_seen_at = COALESCE(callsign_violation_first_seen_at, NOW())
        WHERE client_uid = $1
      RETURNING
        (callsign_violation_first_seen_at IS NULL) AS was_first_seen,
        (callsign_violation_notified_at IS NOT NULL) AS already_notified`,
      [clientUid, observedCallsign]
    );

    const row = result.rows[0];
    // Defensive: if the row vanished between load and update, treat as no-op.
    if (!row) return 'already_notified';
    if (row.was_first_seen) return 'first_seen';
    if (row.already_notified) return 'already_notified';
    return 'confirmed';
  }

  /**
   * Stamps `callsign_violation_notified_at = NOW()` for the current episode,
   * AFTER a successful email send. Only sets it when still NULL, so a concurrent
   * clear (a correction observed by another worker) is not clobbered.
   *
   * @param {string} clientUid
   * @returns {Promise<void>}
   */
  async markNotified(clientUid) {
    await this.pool.query(
      `UPDATE tak_devices
          SET callsign_violation_notified_at = NOW()
        WHERE client_uid = $1
          AND callsign_violation_notified_at IS NULL`,
      [clientUid]
    );
  }

  /**
   * Sends the single first-detection email via the shared `EmailService` and the
   * `callsign_mismatch_notice` template. Contains identifiers only — no
   * credential material. The link points at the Dashboard (`/`), where the
   * "My Devices" card (and now the callsign-mismatch highlight) lives — not
   * `/tasks` — built from `FRONTEND_URL`, the same convention
   * `EscalationService`/`CertExpiryNotificationService` use.
   *
   * @param {{email: string, firstName: string, assignedCallsign: string,
   *   observedCallsign: string}} target
   * @returns {Promise<void>}
   */
  async sendMismatchEmail(target) {
    await this.emailService.sendEmail(target.email, 'callsign_mismatch_notice', {
      first_name: target.firstName,
      assigned_callsign: target.assignedCallsign,
      observed_callsign: target.observedCallsign,
      login_url: `${process.env.FRONTEND_URL || ''}/`
    });
  }
}

/**
 * Reduces a raw `SubscriptionInfo` list to a `Map<client_uid, callsign>`:
 *  - drops entries with a non-string/blank `clientUid` (API-only/ETL sessions),
 *  - drops CloudTAK entries (`ANDROID-CloudTAK-` cert prefix),
 *  - drops entries with no usable `callsign`,
 *  - keeps the MOST RECENT entry per `clientUid` by `lastReportMilliseconds`
 *    (current-state semantics: newest observation wins), falling back to
 *    last-seen-wins when the recency field is absent.
 *
 * Pure and total; exported for unit testing.
 *
 * @param {Array<object>} subscriptions
 * @returns {Map<string, string>}
 */
function reduceObservedCallsigns(subscriptions) {
  /** @type {Map<string, {callsign: string, recency: number}>} */
  const byUid = new Map();

  for (const entry of subscriptions) {
    if (!entry || typeof entry !== 'object') continue;

    const clientUid = entry.clientUid;
    if (typeof clientUid !== 'string' || clientUid === '') continue;
    if (clientUid.startsWith(CLOUDTAK_CLIENT_UID_PREFIX)) continue;

    const callsign = entry.callsign;
    if (typeof callsign !== 'string' || callsign === '') continue;

    const recency =
      typeof entry.lastReportMilliseconds === 'number' && Number.isFinite(entry.lastReportMilliseconds)
        ? entry.lastReportMilliseconds
        : -Infinity;

    const incumbent = byUid.get(clientUid);
    if (incumbent === undefined || recency >= incumbent.recency) {
      byUid.set(clientUid, { callsign, recency });
    }
  }

  const result = new Map();
  for (const [uid, { callsign }] of byUid) {
    result.set(uid, callsign);
  }
  return result;
}

/**
 * The single documented endpoint this poll requires: OpenAPI `getAllSubscriptions`
 * in `tak-server-openapispec.json`. Named for the failed-run log line.
 */
const LIVE_SUBSCRIPTIONS_PATH = '/Marti/api/subscriptions/all';

module.exports = CallsignPoller;
module.exports.reduceObservedCallsigns = reduceObservedCallsigns;
module.exports.CLOUDTAK_CLIENT_UID_PREFIX = CLOUDTAK_CLIENT_UID_PREFIX;
// Re-exported so tests can assert against the classifier the poller uses.
module.exports.classifyObservedCallsign = classifyObservedCallsign;
