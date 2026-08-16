/**
 * Adds `is_team_device` (boolean, default `false`) and `device_label`
 * (text, nullable) to BOTH `users` and `user_cache`, as the first schema
 * change for the Team-Owned Device Enrollment feature (Requirement 27,
 * task 49.1).
 *
 * Per `requirements.md`'s Glossary, a Team_Owned_Device is "a user
 * record (`users.is_team_device`) representing a device-only,
 * non-human account (e.g. shared or apparatus equipment) provisioned
 * with a synthetic, non-deliverable email address so that no OIDC login
 * can be completed against it, distinguished from a human team member
 * by its `is_team_device` flag and `device_label`." Requirement 27
 * Criterion 1 explicitly allows adding these columns to "`users`
 * and/or `user_cache`"; this migration adds them to both, mirroring the
 * dual-table pattern already established for `is_vendor` (see
 * `1786700000000_add-users-is-vendor.cjs` for `users`, and
 * `database/schema.sql`'s baseline `user_cache` definition) and for
 * `tak_role`/`tak_color`/`tak_callsign` -- every other per-user
 * display/classification attribute in this schema is duplicated across
 * `users` (the source-of-truth row created by
 * `UserProvisioningService`/`DeviceEnrollmentService`) and `user_cache`
 * (the read-optimized, Authentik-sync-refreshed row queried by
 * `GET /api/users` and the dashboard). Both tables need `is_team_device`
 * so that:
 *   - `users.is_team_device` can be set once, authoritatively, at
 *     device-creation time (task 49.2, not implemented here) and read
 *     by services that operate off the `users` table (e.g.
 *     `TeamMembershipService.addUserToTeam`, authorization checks); and
 *   - `user_cache.is_team_device` can be filtered on directly by
 *     `GET /api/users`'s and dashboard/user-count queries (task 49.5,
 *     not implemented here), which per the existing `authentikSync.js`
 *     pattern read from `user_cache` rather than joining back to
 *     `users` for every list/count query.
 * `device_label` is added to both tables for the same reason: `users`
 * is the authoritative row a team admin edits, and `user_cache` is what
 * list/detail views read to render a human-readable name for a device
 * that (per Requirement 27 Criterion 2) has no real first/last name.
 *
 * `is_team_device` uses `NOT NULL DEFAULT false` (rather than a
 * nullable boolean), matching the style of every other boolean flag in
 * this schema (`users.is_vendor`, `teams.can_join`,
 * `bch_channels.is_active`) so that every existing and future row has a
 * deterministic, non-null value with no code needing to treat `NULL` as
 * a third state.
 *
 * `device_label` is a plain nullable `text` column with no default: it
 * is only meaningful once a Team_Owned_Device exists (human team
 * members never populate it), so there is no sensible non-null default,
 * mirroring other optional free-text columns already in the baseline
 * schema (e.g. `teams.description`, `channels.description`).
 *
 * This task is scoped to ONLY the migration adding these four columns
 * (two per table); `DeviceEnrollmentService`, `server/routes/devices.js`,
 * and the `GET /api/users`/dashboard exclusion filtering that read and
 * write them (tasks 49.2-49.5) are deliberately out of scope here and
 * land in later tasks, per `tasks.md`'s dependency-ordering note ("Every
 * new table or column lands as its own migration task ahead of the
 * service/route tasks that depend on it").
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumn`), matching
 * the convention established by every migration after the baseline
 * (see e.g. `1786700000000_add-users-is-vendor.cjs`).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.addColumn('users', {
    is_team_device: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    device_label: {
      type: 'text',
      notNull: false,
    },
  });

  pgm.addColumn('user_cache', {
    is_team_device: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    device_label: {
      type: 'text',
      notNull: false,
    },
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropColumn('user_cache', ['is_team_device', 'device_label']);
  pgm.dropColumn('users', ['is_team_device', 'device_label']);
};

module.exports = {
  shorthands,
  up,
  down,
};
