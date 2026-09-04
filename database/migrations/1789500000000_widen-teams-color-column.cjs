'use strict';

/**
 * Bugfix (CSV bulk team import mandatory TAK Colour): `teams.color` was
 * declared `character varying(7)` in the baseline schema -- sized for
 * exactly a `#RRGGBB` hex literal (the column's own default,
 * `'#3B82F6'`), never for a NAMED TAK Colour. Every actual write path
 * that sets a real, human-chosen colour, though, stores a NAME, not a
 * hex code: `TeamFormDialog.jsx`'s dropdown submits values like `'Red'`,
 * `'Dark Blue'`, `'Dark Green'`, and those are exactly the same 14 names
 * `server/routes/config.js`'s `colorMappings` and the baseline
 * migration's own `SEED_ENV_VARS` (`TAK_COLOR_YELLOW`..`TAK_COLOR_BROWN`)
 * already treat as the fixed, canonical set. Two of those 14 -- `'Dark
 * Blue'` (9 characters) and `'Dark Green'` (10 characters) -- do not fit
 * in 7 characters at all: attempting to create an Organisation with
 * either value throws a raw, unhandled `22001 value too long for type
 * character varying(7)` straight out of `Team.create`'s INSERT, caught
 * by its generic catch block and silently swallowed into the
 * degraded "create without the new columns" fallback -- the team is
 * created with NO colour at all, and the operator sees a normal-looking
 * success with no indication anything was dropped. This was found and
 * confirmed directly against a live database while wiring up
 * CSV-import colour validation (`BulkImportService.js`'s
 * `parseRowColor`), which is the first code path to actually validate
 * `color` against the fixed 14-name list before insertion -- a bug that
 * existed already, independent of CSV import, since the very first
 * Organisation ever created through the UI with either colour.
 *
 * Widened to `character varying(50)`, matching `user_cache.tak_color`'s
 * own column width (`1789200000000_baseline-schema.cjs`) exactly, since
 * that column already stores the identical 14 possible name strings
 * (mirrored from `teams.color` at Team-membership-derivation time) and
 * is the closest existing precedent for "how wide does a TAK Colour
 * name actually need to be". 50 comfortably fits every current name
 * (`'Dark Green'` is the longest at 10) with headroom for a future
 * addition, without being unboundedly wide.
 *
 * `down()` reverts to `character varying(7)` exactly as the baseline
 * declared it. Note this WILL fail against a live database that still
 * has any row storing a named colour longer than 7 characters (e.g. any
 * `'Dark Blue'`/`'Dark Green'` Organisation created after this
 * migration ran) -- an intentional, honest rollback rather than a silent
 * truncation; any such row must be corrected or removed before rolling
 * back this migration.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE teams ALTER COLUMN color TYPE character varying(50);
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE teams ALTER COLUMN color TYPE character varying(7);
  `);
};

module.exports = { shorthands, up, down };
