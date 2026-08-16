/**
 * Renames `user_cache.takRole`/`takColor`/`takCallsign` to
 * `tak_role`/`tak_color`/`tak_callsign`, matching the snake_case naming
 * convention used by every other column in the schema (Requirement
 * 16.1).
 *
 * IMPORTANT: the baseline migration's `CREATE TABLE` statement declared
 * these three columns as *unquoted* identifiers
 * (`takRole VARCHAR(100)`, `takColor VARCHAR(50)`,
 * `takCallsign VARCHAR(100)`). PostgreSQL case-folds unquoted
 * identifiers to lowercase, so the columns that actually exist in the
 * database are `takrole`, `takcolor`, and `takcallsign` — not literal
 * camelCase. This migration's `up()` therefore targets the real,
 * lowercase-folded names (confirmed via `\d user_cache` against a fresh
 * migration run) rather than a quoted `"takRole"`-style reference, which
 * would fail with `column "takRole" does not exist` since no
 * quoted/case-sensitive column by that exact spelling was ever created.
 *
 * This case-folding detail is also *why* the existing "fallback for old
 * column names" `try/catch` blocks in `server/routes/users.js` and
 * `server/services/userAttributes.js` never actually exercise their
 * `catch` branch today: an unquoted `takCallsign` written directly in a
 * raw SQL string (the "primary" attempt in those try blocks) is itself
 * folded to `takcallsign` by Postgres at query time, which already
 * matches the real column — so the primary attempt always succeeds
 * against the current schema, and the snake_case fallback is
 * unreachable dead code. Task 35.2 (not this task) removes those
 * try/catch blocks now that a single, consistent snake_case column name
 * exists going forward.
 *
 * Uses node-pg-migrate's schema-builder `pgm.renameColumn` API, matching
 * the convention established by every migration after the baseline
 * (`1786597988855_create-token-revocations.cjs` and later), rather than
 * raw SQL — no case-sensitivity concern applies here since the source
 * names are plain lowercase identifiers.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.renameColumn('user_cache', 'takrole', 'tak_role');
  pgm.renameColumn('user_cache', 'takcolor', 'tak_color');
  pgm.renameColumn('user_cache', 'takcallsign', 'tak_callsign');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.renameColumn('user_cache', 'tak_role', 'takrole');
  pgm.renameColumn('user_cache', 'tak_color', 'takcolor');
  pgm.renameColumn('user_cache', 'tak_callsign', 'takcallsign');
};

module.exports = {
  shorthands,
  up,
  down,
};
