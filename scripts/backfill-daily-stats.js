require('dotenv').config();

const pool = require('../server/config/database');
const { getIgnoredUsernamePrefixes } = require('../server/config/authentikSyncIgnore');
const { escapeLikePattern } = require('../server/utils/directoryScope');

/**
 * Backfill `daily_stats` for the Statistics page.
 *
 * The daily snapshot job (server/services/DailyStatsSnapshotJob.js) only
 * starts capturing the four /admin totals from its first run onward, so the
 * Statistics charts would otherwise be empty until enough days accumulate.
 * This one-off script seeds an APPROXIMATE history from each source table's
 * `created_at`, so the totals charts have a curve at launch.
 *
 * IMPORTANT — this backfill is DECLINE-BLIND and APPROXIMATE, by nature:
 *   - teams, channels, and team-devices are HARD-deleted. A `created_at`-based
 *     cumulative count on a past day only counts rows that STILL EXIST today,
 *     so it UNDERSTATES the real past headcount and can NEVER show a decrease.
 *     A day on which 3 teams existed and 1 was later deleted backfills as 2.
 *   - it therefore produces a monotonically non-decreasing curve up to today's
 *     live count. This is a best-effort placeholder for pre-capture history,
 *     NOT an accurate reconstruction. Forward days written by the snapshot job
 *     ARE accurate.
 *
 * It NEVER overwrites a real snapshot: rows are inserted `ON CONFLICT (day) DO
 * NOTHING`, so any day the job has already captured (or a prior backfill
 * seeded) is left untouched. Run it once, ideally right after the migration
 * and before/around first deploy.
 *
 * The four counts use the SAME /admin definitions the snapshot job does
 * (users excl is_team_device/orphaned/ignored-prefix; teams = all; team
 * devices = is_team_device; channels = team + bch + region), evaluated
 * cumulatively as "created on or before the END of that day" in the DISPLAY
 * timezone (DISPLAY_TIMEZONE, default Pacific/Auckland) so the day boundaries
 * line up with the snapshot job and the client charts.
 *
 * NOTE: `created_at` columns are `timestamp without time zone` storing UTC;
 * the day's exclusive upper bound is the next day's midnight in the display
 * zone, converted to UTC for the comparison.
 *
 * Usage:
 *   node scripts/backfill-daily-stats.js                # dry run (default 365 days)
 *   node scripts/backfill-daily-stats.js --days 90      # dry run, 90 days
 *   node scripts/backfill-daily-stats.js --apply        # write the rows
 *   node scripts/backfill-daily-stats.js --days 30 --apply
 */

function parseArgs(argv) {
  const args = { apply: false, days: 365 };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--days') {
      const n = parseInt(rest[i + 1], 10);
      if (Number.isInteger(n) && n > 0) {
        args.days = n;
      }
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const out = (line) => process.stdout.write(line + '\n');

  const displayTimezone = process.env.DISPLAY_TIMEZONE || 'Pacific/Auckland';
  const ignoredPrefixPatterns = getIgnoredUsernamePrefixes().map(
    (prefix) => `${escapeLikePattern(prefix)}%`
  );

  out('Backfill: daily_stats totals from created_at (APPROXIMATE, decline-blind)');
  out(args.apply ? 'MODE: APPLY (rows inserted, ON CONFLICT DO NOTHING)'
                 : 'MODE: DRY RUN (no changes; pass --apply to write)');
  out(`Window: last ${args.days} days   Display timezone: ${displayTimezone}`);
  out('');

  // One row per day for the last N days (day 0 = today, in the display zone),
  // each carrying the cumulative /admin totals as of that day's END. The day
  // series and the per-day upper bound are both computed in the display zone
  // so they match the snapshot job's own `(now() AT TIME ZONE tz)::date`.
  //
  // `day_end_utc` is the exclusive upper bound: the START of the NEXT day in
  // the display zone, expressed as a UTC timestamp to compare against the
  // UTC-stored `created_at` columns.
  const backfillQuery = `
    WITH days AS (
      SELECT ((now() AT TIME ZONE $2)::date - offs) AS day
      FROM generate_series(0, $1::int - 1) AS offs
    ),
    bounds AS (
      SELECT
        day,
        -- next-day midnight in the display zone, converted to UTC
        (((day + 1)::timestamp) AT TIME ZONE $2) AS day_end_utc
      FROM days
    )
    SELECT
      b.day,
      (
        SELECT COUNT(*) FROM users u
         WHERE u.is_team_device = false
           AND u.account_status <> 'orphaned'
           AND NOT (u.username LIKE ANY($3::text[]))
           AND u.created_at < b.day_end_utc
      )::int AS total_users,
      (SELECT COUNT(*) FROM teams t WHERE t.created_at < b.day_end_utc)::int AS total_teams,
      (
        SELECT COUNT(*) FROM users u
         WHERE u.is_team_device = true
           AND u.created_at < b.day_end_utc
      )::int AS total_team_devices,
      (
        (SELECT COUNT(*) FROM channels c WHERE c.created_at < b.day_end_utc)
        + (SELECT COUNT(*) FROM bch_channels bc WHERE bc.created_at < b.day_end_utc)
        + (SELECT COUNT(*) FROM region_channels rc WHERE rc.created_at < b.day_end_utc)
      )::int AS total_channels
    FROM bounds b
    ORDER BY b.day
  `;

  const { rows } = await pool.query(backfillQuery, [args.days, displayTimezone, ignoredPrefixPatterns]);

  out(`Computed ${rows.length} day rows. Sample (first and last):`);
  if (rows.length > 0) {
    const fmt = (r) => `  ${new Date(r.day).toISOString().slice(0, 10)}  users=${r.total_users} teams=${r.total_teams} devices=${r.total_team_devices} channels=${r.total_channels}`;
    out(fmt(rows[0]));
    if (rows.length > 1) out(fmt(rows[rows.length - 1]));
  }
  out('');

  if (!args.apply) {
    out('Dry run complete. Re-run with --apply to insert these rows (existing days are never overwritten).');
    await pool.end();
    process.exit(0);
  }

  // Insert every computed day, but NEVER overwrite a day a real snapshot (or a
  // prior backfill) already wrote. `captured_at` defaults to now(); the
  // approximate nature is documented on the table and in this script.
  let inserted = 0;
  for (const r of rows) {
    const result = await pool.query(
      `INSERT INTO daily_stats (day, total_users, total_teams, total_team_devices, total_channels)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (day) DO NOTHING`,
      [r.day, r.total_users, r.total_teams, r.total_team_devices, r.total_channels]
    );
    inserted += result.rowCount || 0;
  }

  out(`Apply complete. Inserted ${inserted} new day rows (${rows.length - inserted} already existed and were left untouched).`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`Backfill failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
