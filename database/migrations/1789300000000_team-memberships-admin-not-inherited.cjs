'use strict';

/**
 * Data-corruption bugfix (incident: a Team_Admin promotion silently
 * corrupted a `team_memberships` row -- see the git history around this
 * migration for the full incident writeup).
 *
 * Encodes, as a real DB `CHECK` constraint, an invariant this
 * application's code has always assumed but never enforced at the data
 * layer: a `team_memberships` row cannot simultaneously be
 * `role = 'admin'` AND carry a non-null `inherited_from_team_id`.
 *
 * Why this invariant matters: per this app's glossary, Team_Admin is
 * defined as a DIRECT (`inherited_from_team_id IS NULL`) `role = 'admin'`
 * membership row -- `Team.isAdmin` (server/models/Team.js) and every
 * row-scoped authorization resolver in server/middleware/authorize.js key
 * on exactly that condition. An INHERITED admin row (one with
 * `inherited_from_team_id` set) never confers Team_Admin status by
 * design (Requirement 4.4 in this app's own specs).
 *
 * How the corruption happened: `Team.addMember`'s upsert
 * (`INSERT ... ON CONFLICT (user_id, team_id) DO UPDATE SET role = $3`)
 * is designed for a DIRECT row -- adding a new member, or promoting/
 * demoting an EXISTING direct member/admin. It sets `role` alone and
 * never touches `inherited_from_team_id`. The client's "Add Admin"
 * picker on an Organisation's team page used to also offer users who
 * appeared on that page only via an INHERITED membership row (a direct
 * member of a Sub_Team, inherited up to the Organisation). Promoting one
 * of those hit the SAME upsert's conflict branch against that user's
 * EXISTING inherited row for the Organisation, flipping `role` to
 * 'admin' while leaving `inherited_from_team_id` set -- producing a row
 * that displayed as an admin in the Team Admins tab (which only filters
 * on `role`) while `Team.isAdmin` correctly excluded it, so the affected
 * user was silently denied every real team-admin-gated action (e.g.
 * `GET /api/devices/team/:teamId`) despite appearing to be an admin.
 *
 * The application-layer fix (client-side picker exclusion, plus
 * `Team.addMember` throwing `InheritedMembershipPromotionError` before
 * attempting this exact upsert -- see `server/models/Team.js`) already
 * prevents this specific code path from producing the bad row again.
 * This migration is the second, independent layer: it makes the bad row
 * shape impossible to persist AT ALL, regardless of which code path (a
 * future bug, a manual `UPDATE`, a script, a different ORM call) might
 * attempt it. A `CHECK` constraint fails loudly and immediately (a
 * thrown DB error) the moment anything tries to create this state,
 * rather than allowing a silent corruption to surface later as an
 * unrelated, confusing 403.
 *
 * Placement: this is the first INCREMENTAL migration on top of the
 * squashed baseline (`1789200000000_baseline-schema.cjs`), per this
 * repo's own convention (`tech.md`'s steering: "the next schema change
 * should be its own new incremental migration alongside it").
 *
 * `up()` first repairs any pre-existing violating rows (setting
 * `inherited_from_team_id = NULL` on any row that is `role = 'admin'`
 * with a non-null `inherited_from_team_id`, converting them into
 * legitimate direct admin rows) before adding the constraint -- run
 * unconditionally so this migration is safe to apply to ANY database in
 * this state, not just the one instance already manually repaired
 * during this incident. This repair choice (keep `role = 'admin'`, clear
 * `inherited_from_team_id`) is deliberately the SAFER of the two
 * possible resolutions: it grants Team_Admin nowhere it wasn't already
 * displayed as granted (the row already read as "admin" in every UI
 * that only checks `role`), and is trivially reversible by a
 * Global_Manager (demote via the existing "Remove as admin" action) if
 * that turns out to be the wrong call for a given row -- unlike silently
 * reverting to a non-admin inherited row, which could not be
 * distinguished from "this promotion never happened" and would remove
 * access without any indication a decision was made.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const up = (pgm) => {
  // Repair pass: convert any existing violating row into a legitimate
  // direct admin row (see file header for why this resolution, not the
  // reverse). A no-op UPDATE (matches zero rows) on a database that has
  // no violation, so this is safe to run against every environment.
  pgm.sql(`
    UPDATE team_memberships
       SET inherited_from_team_id = NULL
     WHERE role = 'admin' AND inherited_from_team_id IS NOT NULL
  `);

  // Raw SQL via `pgm.sql(...)`, not the schema-builder API
  // (`pgm.addConstraint`) -- matching this codebase's established
  // migration convention (see `1789200000000_baseline-schema.cjs`'s own
  // header comment). This also keeps this migration compatible with
  // `database/migrations/__tests__/baselineMigration.integration.test.js`'s
  // `extractSeedSqlBlocks`, which runs every migration's `up()` against a
  // minimal mock `pgm` implementing only `.sql()`.
  pgm.sql(`
    ALTER TABLE team_memberships
      ADD CONSTRAINT team_memberships_admin_not_inherited
      CHECK (NOT (role = 'admin' AND inherited_from_team_id IS NOT NULL))
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE team_memberships
      DROP CONSTRAINT team_memberships_admin_not_inherited
  `);
};

module.exports = { shorthands, up, down };
