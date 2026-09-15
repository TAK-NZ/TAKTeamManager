/**
 * Statistics page (Global-Admin-only /statistics): two forward-capture
 * time-series tables. Incremental migration on top of the squashed baseline
 * (`1790200000000_baseline-schema.cjs`); NEVER hand-edit schema.sql.
 *
 * WHY FORWARD-CAPTURE (and not computed on read):
 *   - Daily active users/devices: the only live signals (`tak_devices.
 *     last_seen_at` monotonic-latest, `connected` current-state) cannot
 *     reconstruct "how many distinct devices connected on a past day". So we
 *     record one row per (day, device) as the Subscription_Poller observes a
 *     connection -> `device_daily_activity`.
 *   - Per-day totals of users/teams/team-devices/channels: the source tables
 *     have `created_at`, but teams/channels/devices are HARD-deleted, so a
 *     created_at-based cumulative count is decline-blind and understates the
 *     past. A daily snapshot of the live counts (using the SAME definitions
 *     the /admin stat cards use) is the only accurate history -> `daily_stats`.
 *
 * DAY BUCKETING is in the app's DISPLAY timezone (DISPLAY_TIMEZONE, default
 * `Pacific/Auckland`), matching every user-visible date elsewhere, so a chart
 * day lines up with what operators see. The writers compute the `day` value
 * in that zone; these columns are plain `date`.
 *
 * device_daily_activity
 *   - day        the calendar day (display tz) a connection was observed.
 *   - client_uid the TAK Server client uid observed connected that day
 *                (a tak_devices.client_uid; the Subscription_Poller resolves
 *                the reported connection to this via connectionAlias).
 *   PK (day, client_uid) makes the per-poll write idempotent: ~288 polls/day
 *   collapse to one row per device per day. The read splits users vs
 *   team-devices by joining client_uid -> tak_devices.user_id -> users.
 *
 * daily_stats
 *   - day               the calendar day (display tz) this snapshot is for.
 *   - total_users       exact human user count (excludes ignored-prefix,
 *                       orphaned, and is_team_device rows) -- the /admin
 *                       "Total Users" definition.
 *   - total_teams       every teams row -- the /admin "Total Teams" definition.
 *   - total_team_devices users.is_team_device = true -- /admin "Total Devices".
 *   - total_channels    team + global channels (channels + bch_channels +
 *                       region_channels) -- the /admin "Total Channels".
 *   - captured_at       when the snapshot row was (re)written; diagnostic only.
 *   PK (day): one snapshot per day, upserted (the job re-runs idempotently).
 */

const shorthands = undefined;

const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS public.device_daily_activity (
      day date NOT NULL,
      client_uid character varying(255) NOT NULL,
      PRIMARY KEY (day, client_uid)
    );

    COMMENT ON TABLE public.device_daily_activity IS
      'Statistics/DAU: one row per (calendar day in DISPLAY timezone, tak_devices.client_uid) the Subscription_Poller observed connected to TAK Server that day. Append-only, idempotent per poll via the composite PK. Read split into users vs team-devices by joining client_uid -> tak_devices.user_id -> users.is_team_device.';

    -- Range reads are "all activity in the last N days", i.e. by day; the PK's
    -- leading day column already serves that, but an explicit index keeps the
    -- grouped-by-day distinct count read fast as the table grows.
    CREATE INDEX IF NOT EXISTS idx_device_daily_activity_day
      ON public.device_daily_activity USING btree (day);

    CREATE TABLE IF NOT EXISTS public.daily_stats (
      day date NOT NULL PRIMARY KEY,
      total_users integer NOT NULL DEFAULT 0,
      total_teams integer NOT NULL DEFAULT 0,
      total_team_devices integer NOT NULL DEFAULT 0,
      total_channels integer NOT NULL DEFAULT 0,
      captured_at timestamp with time zone NOT NULL DEFAULT now()
    );

    COMMENT ON TABLE public.daily_stats IS
      'Statistics: one snapshot row per calendar day (DISPLAY timezone) of the four /admin totals, using the SAME definitions the /admin stat cards use (total_users excludes ignored-prefix/orphaned/is_team_device; total_channels = team channels + bch_channels + region_channels). Written by the daily snapshot job (upsert on day); backfillable approximately from created_at for days before capture began.';
  `);
};

const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS public.device_daily_activity;
    DROP TABLE IF EXISTS public.daily_stats;
  `);
};

module.exports = {
  shorthands,
  up,
  down
};
