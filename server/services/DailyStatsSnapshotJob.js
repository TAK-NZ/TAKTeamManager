const pool = require('../config/database');
const logger = require('../config/logger').createLogger('DailyStatsSnapshotJob');
const { withJobLock, JOB_LOCK_KEYS } = require('../utils/jobLock');
const { getIgnoredUsernamePrefixes } = require('../config/authentikSyncIgnore');
const { escapeLikePattern } = require('../utils/directoryScope');

/**
 * Statistics page: the Daily_Stats_Snapshot_Job.
 *
 * Writes ONE `daily_stats` row per calendar day (in the DISPLAY timezone)
 * capturing the four totals the /admin stat cards show, so the Statistics
 * page can chart their history. Runs inside the Sync_Worker on its OWN
 * `setInterval`, mirroring `RetentionCleanupJob`/`ExpiryScheduler`'s
 * "separate interval, run-once-on-start, single-runner advisory lock,
 * never crash the worker" shape.
 *
 * WHY A DAILY SNAPSHOT (and not computed from created_at on read): teams,
 * channels, and team-devices are HARD-deleted, so a created_at-based
 * cumulative count is decline-blind and understates the past. Sampling the
 * live counts once a day is the only accurate forward history. (A separate
 * one-off backfill script seeds an APPROXIMATE created_at-based history for
 * days before capture began -- see scripts/backfill-daily-stats.js.)
 *
 * THE DEFINITIONS MUST MATCH /admin EXACTLY (the user's requirement), so
 * each count is the SAME query the /admin stat cards use:
 *   - total_users        = users, excluding is_team_device, orphaned, and
 *                          ignored-username-prefix accounts. `GET /api/users/
 *                          count` does the prefix exclusion in JS (the prefix
 *                          list is env-configured); reproduced here in SQL via
 *                          the same escaped `LIKE ANY` patterns the list query
 *                          uses, so the number is identical without pulling
 *                          every username into the job.
 *   - total_teams        = every `teams` row (the /admin card reads
 *                          `getMyTeams().pagination.total`, which for a
 *                          Global_Manager is the whole `teams` table).
 *   - total_team_devices = users WHERE is_team_device = true (the /admin
 *                          "Total Devices" definition, orgDomains.js).
 *   - total_channels     = channels + bch_channels + region_channels (the
 *                          /admin "Total Channels" definition, orgDomains.js).
 *
 * The `day` is TODAY in the DISPLAY timezone (`DISPLAY_TIMEZONE`, default
 * Pacific/Auckland), so a snapshot lands on the same calendar day operators
 * see everywhere else. Upsert on `day`: re-running (start + every interval)
 * simply refreshes today's row with the latest live counts, which is why the
 * value on the current day always matches /admin exactly.
 */
class DailyStatsSnapshotJob {
  constructor({ pool: dbPool = pool } = {}) {
    this.pool = dbPool;

    // Default once per hour: frequent enough that "today" tracks /admin
    // closely through the day, cheap enough to be negligible (four COUNTs +
    // one upsert). Lower-bounded like the sibling jobs against a misconfigured
    // near-zero interval. A daily cadence would also be defensible, but an
    // hourly refresh keeps the current day's point live rather than stale
    // until midnight.
    const MIN_INTERVAL_SECONDS = 60; // 1 minute
    const DEFAULT_INTERVAL_SECONDS = 60 * 60; // 1 hour

    const intervalSeconds = Math.max(
      MIN_INTERVAL_SECONDS,
      parseInt(process.env.DAILY_STATS_SNAPSHOT_INTERVAL_SECONDS, 10) || DEFAULT_INTERVAL_SECONDS
    );
    this.intervalMs = intervalSeconds * 1000;

    this.timer = null;
  }

  /**
   * Starts the job: runs one snapshot immediately (so a fresh deploy/restart
   * has today's row without waiting a full interval), then schedules the
   * recurring snapshot. Idempotent against a double start.
   */
  start() {
    if (this.timer) return;

    logger.info({ intervalMs: this.intervalMs }, 'Daily stats snapshot job started');

    this.runSnapshot();

    this.timer = setInterval(() => {
      this.runSnapshot();
    }, this.intervalMs);
  }

  /**
   * Stops the job, clearing the recurring interval. A no-op if not running.
   */
  stop() {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = null;
    logger.info('Daily stats snapshot job stopped');
  }

  /**
   * Runs one snapshot under the single-runner advisory lock (the upsert is
   * idempotent, so a duplicate run is harmless-but-wasteful; the lock avoids
   * two workers both writing today's row every tick). Any error is caught and
   * logged -- never allowed to crash or exit the Sync_Worker; the next tick
   * retries.
   *
   * @returns {Promise<void>}
   */
  async runSnapshot() {
    try {
      await withJobLock(this.pool, JOB_LOCK_KEYS.DAILY_STATS_SNAPSHOT, async () => {
        const result = await this.captureToday();
        logger.info(result, 'Daily stats snapshot run completed');
      });
    } catch (error) {
      logger.error({ err: error }, 'Daily stats snapshot run failed');
    }
  }

  /**
   * Computes today's four totals (with the /admin definitions above) and
   * upserts the `daily_stats` row for today's DISPLAY-timezone date.
   *
   * @returns {Promise<{day: string, totalUsers: number, totalTeams: number, totalTeamDevices: number, totalChannels: number}>}
   */
  async captureToday() {
    const displayTimezone = process.env.DISPLAY_TIMEZONE || 'Pacific/Auckland';

    // Ignored-prefix exclusion, expressed as escaped `prefix%` LIKE patterns --
    // the SAME construction the GET /api/users list query uses. An empty list
    // yields an empty array, and `username LIKE ANY('{}')` is false, so nothing
    // is excluded (the unset-variable default), exactly matching
    // GET /api/users/count's JS filter over the same set.
    const ignoredPrefixPatterns = getIgnoredUsernamePrefixes().map(
      (prefix) => `${escapeLikePattern(prefix)}%`
    );

    const result = await this.pool.query(
      `
      INSERT INTO daily_stats (day, total_users, total_teams, total_team_devices, total_channels, captured_at)
      SELECT
        (now() AT TIME ZONE $2)::date AS day,
        (
          SELECT COUNT(*) FROM users
           WHERE is_team_device = false
             AND account_status <> 'orphaned'
             AND NOT (username LIKE ANY($1::text[]))
        )::int AS total_users,
        (SELECT COUNT(*) FROM teams)::int AS total_teams,
        (SELECT COUNT(*) FROM users WHERE is_team_device = true)::int AS total_team_devices,
        (
          (SELECT COUNT(*) FROM channels)
          + (SELECT COUNT(*) FROM bch_channels)
          + (SELECT COUNT(*) FROM region_channels)
        )::int AS total_channels,
        now() AS captured_at
      ON CONFLICT (day) DO UPDATE SET
        total_users = EXCLUDED.total_users,
        total_teams = EXCLUDED.total_teams,
        total_team_devices = EXCLUDED.total_team_devices,
        total_channels = EXCLUDED.total_channels,
        captured_at = EXCLUDED.captured_at
      RETURNING day, total_users, total_teams, total_team_devices, total_channels
      `,
      [ignoredPrefixPatterns, displayTimezone]
    );

    const row = result.rows[0] || {};
    return {
      day: row.day,
      totalUsers: row.total_users,
      totalTeams: row.total_teams,
      totalTeamDevices: row.total_team_devices,
      totalChannels: row.total_channels
    };
  }
}

module.exports = DailyStatsSnapshotJob;
