/**
 * Replaces `team_memberships`' unconditional `UNIQUE(user_id)` constraint
 * with a partial unique index that only enforces "at most one row per
 * user" for DIRECT (non-inherited) memberships, plus a separate
 * `UNIQUE(user_id, team_id)` constraint covering INHERITED rows
 * (Requirement 16.4).
 *
 * Why this is needed: the baseline migration's `team_memberships` table
 * declared `user_id INTEGER ... UNIQUE`, meaning a user could only ever
 * have ONE row in this table, period — direct or inherited. But
 * `UserProvisioningService.createAndAddUser` (task 36.1) intentionally
 * inserts BOTH one direct membership row (`team_id` = the target team,
 * `inherited_from_team_id IS NULL`) AND one inherited membership row per
 * ancestor team (`inherited_from_team_id` = the target team's id) for the
 * SAME user, to represent that a member of a sub-team is also implicitly
 * a member of every parent team above it. Under the old unconditional
 * `UNIQUE(user_id)` constraint, the second `INSERT INTO team_memberships`
 * call for any given user (regardless of whether it's the direct row or
 * the first inherited row) would violate the constraint and fail.
 *
 * The replacement enforces the two invariants the application actually
 * relies on:
 *   1. At most one DIRECT membership per user — a user can only directly
 *      belong to one team at a time. Enforced by a partial unique index
 *      on `user_id` `WHERE inherited_from_team_id IS NULL`.
 *   2. At most one INHERITED membership per (user, ancestor team) pair —
 *      a user can be inherited into many distinct ancestor teams (one per
 *      level of the team hierarchy above their direct team), but not
 *      inherited into the very same team twice. Enforced by a plain
 *      `UNIQUE(user_id, team_id)` constraint, which applies to every row
 *      (direct and inherited alike) but only actually matters for
 *      inherited rows in practice, since invariant 1 already prevents a
 *      user from having two direct rows (which would be the only way to
 *      get two rows with the same `user_id` and the same direct `team_id`
 *      in the first place).
 *
 * The exact name of the constraint being dropped is
 * `team_memberships_user_id_key` — Postgres's default auto-generated name
 * for a column-level `UNIQUE` constraint on `team_memberships.user_id`
 * (`<table>_<column>_key`), confirmed by inspecting the constraint list
 * of a freshly-migrated database (`\d team_memberships`). The baseline
 * migration's raw-SQL `CREATE TABLE` statement declares this constraint
 * inline (`user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
 * UNIQUE`) without an explicit name, so node-pg-migrate/Postgres's
 * default naming convention is what determines the name used here.
 *
 * ADDITIONAL FIX FOLDED INTO THIS MIGRATION: `team_memberships` has no
 * `inherited_from_team_id` column anywhere in the baseline schema or any
 * migration up to this point — despite `UserProvisioningService
 * .createAndAddUser` (task 36.1, already merged) already inserting rows
 * with `inherited_from_team_id = <ancestor team id>`, and
 * `server/models/Team.js`/`server/models/User.js` already querying
 * `tm.inherited_from_team_id` in `SELECT`/`WHERE` clauses. That is a
 * pre-existing schema/code drift bug (the exact class of drift this
 * whole task group, 35, exists to remediate) that would otherwise make
 * every one of those already-merged queries fail with `column
 * "inherited_from_team_id" does not exist`, and would make this
 * migration's own partial index impossible to create (a `WHERE` clause
 * can't reference a column that doesn't exist). This migration therefore
 * adds the column — nullable, referencing `teams(id)` with `ON DELETE
 * CASCADE` (matching the existing `team_id` column's FK style on this
 * same table) — before creating the partial index that depends on it.
 *
 * Uses node-pg-migrate's schema-builder API (`pgm.addColumn`,
 * `pgm.dropConstraint`, `pgm.createIndex` with a `where` clause,
 * `pgm.addConstraint`), matching the convention established by every
 * migration after the baseline.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const ONE_DIRECT_PER_USER_INDEX = 'idx_team_memberships_one_direct_per_user';
const ONE_INHERITED_PER_ANCESTOR_CONSTRAINT = 'team_memberships_user_id_team_id_key';
const ORIGINAL_UNIQUE_USER_ID_CONSTRAINT = 'team_memberships_user_id_key';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  // Pre-existing drift fix: add the missing `inherited_from_team_id`
  // column that already-merged application code reads/writes but that
  // no migration has ever created. See the file-level comment above.
  pgm.addColumn('team_memberships', {
    inherited_from_team_id: {
      type: 'integer',
      notNull: false,
      references: 'teams',
      onDelete: 'CASCADE',
    },
  });

  // Drop the old "at most one row per user, full stop" constraint.
  pgm.dropConstraint('team_memberships', ORIGINAL_UNIQUE_USER_ID_CONSTRAINT);

  // Invariant 1: at most one DIRECT membership per user.
  pgm.createIndex('team_memberships', 'user_id', {
    name: ONE_DIRECT_PER_USER_INDEX,
    unique: true,
    where: 'inherited_from_team_id IS NULL',
  });

  // Invariant 2: at most one membership row per (user, team) pair — in
  // practice this only bites on inherited rows, since invariant 1 already
  // prevents duplicate direct rows for the same user.
  pgm.addConstraint('team_memberships', ONE_INHERITED_PER_ANCESTOR_CONSTRAINT, {
    unique: ['user_id', 'team_id'],
  });
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.dropConstraint('team_memberships', ONE_INHERITED_PER_ANCESTOR_CONSTRAINT);
  pgm.dropIndex('team_memberships', 'user_id', { name: ONE_DIRECT_PER_USER_INDEX });

  pgm.addConstraint('team_memberships', ORIGINAL_UNIQUE_USER_ID_CONSTRAINT, {
    unique: ['user_id'],
  });

  pgm.dropColumn('team_memberships', 'inherited_from_team_id');
};

module.exports = {
  shorthands,
  up,
  down,
};
