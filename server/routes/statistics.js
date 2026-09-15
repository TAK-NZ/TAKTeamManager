const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const { getIgnoredUsernamePrefixes } = require('../config/authentikSyncIgnore');
const { escapeLikePattern } = require('../utils/directoryScope');
const router = express.Router();

/**
 * server/routes/statistics.js
 *
 * `GET /api/statistics?window=8|30|90|365` — Global_Manager-only time series
 * backing the Statistics page. Authorization is enforced centrally by
 * `authorize.js` via the Permission_Registry's `statistics:read` entry
 * (resolved through `roleDefaults.global_manager: ['*']`, NOT in
 * `authenticated_user`), the same Global-Manager-only gate shape as
 * `audit_log:read` / `admin:stats:read` — no inline `is_global_manager`
 * check is duplicated here.
 *
 * Returns one row per calendar day across the window (oldest → newest), with
 * every day in range present (gap-filled) so the client charts a continuous
 * axis. Each row carries:
 *   - dau_users         distinct human users that connected to TAK Server that
 *                       day (device_daily_activity → tak_devices.user_id →
 *                       users, is_team_device = false, excluding ignored-prefix
 *                       usernames — the SAME population the /admin "Total
 *                       Users" count uses).
 *   - dau_team_devices  distinct Team_Owned_Devices that connected that day
 *                       (same join, is_team_device = true).
 *   - total_users / total_teams / total_team_devices / total_channels
 *                       the daily snapshot of the four /admin totals from
 *                       `daily_stats` (null for a day with no snapshot — e.g.
 *                       before capture began and before the backfill ran).
 *
 * Day bucketing is in the DISPLAY timezone (matching the writers and the
 * client), and the window is [today-(N-1) .. today] inclusive in that zone.
 * DAU counts are computed here from the append-only `device_daily_activity`
 * rows; the totals are read straight from the snapshot table.
 */

// The only permitted window sizes (days). A frozen allow-list: an
// out-of-list value is a 400, and the value is used only as a bound on a
// generated day series, never interpolated as SQL.
const ALLOWED_WINDOWS = Object.freeze([8, 30, 90, 365]);

router.get('/', authenticateToken, authorize, [
  query('window').optional().isInt().toInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  // Default to the smallest window when unspecified; reject anything not on
  // the allow-list (a 400 before the query runs).
  const windowDays = req.query.window === undefined ? 8 : req.query.window;
  if (!ALLOWED_WINDOWS.includes(windowDays)) {
    return res.status(400).json({
      error: `Invalid window. Allowed: ${ALLOWED_WINDOWS.join(', ')}`
    });
  }

  try {
    const displayTimezone = process.env.DISPLAY_TIMEZONE || 'Pacific/Auckland';
    const ignoredPrefixPatterns = getIgnoredUsernamePrefixes().map(
      (prefix) => `${escapeLikePattern(prefix)}%`
    );

    // One row per day in [today-(N-1) .. today] (display zone), LEFT JOINed to:
    //   - the DAU split, computed from device_daily_activity joined to the
    //     device's owning user (is_team_device decides the bucket; the users
    //     half also excludes ignored-prefix usernames to match /admin's user
    //     population). COUNT(DISTINCT users.id) so a user with several devices
    //     active the same day counts once.
    //   - the daily_stats snapshot totals for that day.
    // No bind parameter is interpolated as SQL; $1 bounds the series, $2 is the
    // zone literal used by AT TIME ZONE, $3 is the escaped ignored-prefix array.
    const result = await pool.query(
      `
      WITH days AS (
        SELECT ((now() AT TIME ZONE $2)::date - offs) AS day
        FROM generate_series(0, $1::int - 1) AS offs
      ),
      dau AS (
        SELECT
          a.day,
          COUNT(DISTINCT u.id) FILTER (
            WHERE u.is_team_device = false
              AND NOT (u.username LIKE ANY($3::text[]))
          ) AS dau_users,
          COUNT(DISTINCT u.id) FILTER (
            WHERE u.is_team_device = true
          ) AS dau_team_devices
        FROM device_daily_activity a
        JOIN tak_devices d ON d.client_uid = a.client_uid
        JOIN users u ON u.id = d.user_id
        GROUP BY a.day
      )
      SELECT
        to_char(days.day, 'YYYY-MM-DD') AS day,
        COALESCE(dau.dau_users, 0)::int AS dau_users,
        COALESCE(dau.dau_team_devices, 0)::int AS dau_team_devices,
        ds.total_users,
        ds.total_teams,
        ds.total_team_devices,
        ds.total_channels
      FROM days
      LEFT JOIN dau ON dau.day = days.day
      LEFT JOIN daily_stats ds ON ds.day = days.day
      ORDER BY days.day ASC
      `,
      [windowDays, displayTimezone, ignoredPrefixPatterns]
    );

    // total_* are null for days with no snapshot; leave them null (the client
    // renders a gap) rather than coercing to 0, which would misrepresent
    // "no data" as "zero teams".
    const series = result.rows.map((row) => ({
      day: row.day,
      dau_users: row.dau_users,
      dau_team_devices: row.dau_team_devices,
      total_users: row.total_users === null ? null : Number(row.total_users),
      total_teams: row.total_teams === null ? null : Number(row.total_teams),
      total_team_devices: row.total_team_devices === null ? null : Number(row.total_team_devices),
      total_channels: row.total_channels === null ? null : Number(row.total_channels)
    }));

    res.json({ window: windowDays, series });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch statistics');
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

module.exports = router;
