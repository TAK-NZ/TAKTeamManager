'use strict';

/**
 * Scoping fix: `idx_teams_callsign_prefix` (the baseline's UNIQUE
 * partial index over every non-null `teams.callsign_prefix` value) was
 * stricter than what this application actually needs, and blocked a
 * legitimate real-world import scenario -- see the git history around
 * this migration for the discussion that motivated it (a FENZ + LandSAR
 * bulk-team-import fixture, both hierarchies legitimately wanting to
 * reuse a short code like "STL" for a Southland-named Sub_Team at
 * different places in their own, unrelated trees).
 *
 * Why the OLD index was wrong: per this app's own design
 * (`takserver-enrollment` Requirement 2 Criterion 2.6, and this repo's
 * own doc comments on `OrganisationCallsignPrefixImmutableError`/
 * `CallsignPrefixConflictError`), the ONLY thing `callsign_prefix`
 * uniqueness protects is the Managed_Identifier scheme: a Managed_
 * Identifier's prefix segment must unambiguously name exactly ONE
 * Organisation. Every real reader of `callsign_prefix` for that purpose
 * -- `ManagedIdentifierService.resolveOrganisationPrefix`,
 * `UserProvisioningService.js`'s pseudonymous-username mint path -- goes
 * through `Team.getAncestorChain(teamId)[0]`, i.e. always the root
 * Organisation row, NEVER a Sub_Team's own `callsign_prefix`.
 * `CallsignService.assembleCallsign` (the only other consumer) has no
 * uniqueness dependency at all -- it just concatenates whatever prefixes
 * it is given, and two Sub_Teams sharing a prefix still produce
 * different assembled callsigns for their members because the
 * Organisation segment and the person's own Name segment are also part
 * of the string. Nothing in this codebase ever does
 * `SELECT ... FROM teams WHERE callsign_prefix = ...` -- the column is
 * never used as a lookup key. So a Sub_Team's prefix was NEVER what
 * needed protecting; the old index simply over-enforced.
 *
 * The fix: scope the UNIQUE index to Organisation rows only
 * (`parent_team_id IS NULL`), matching Criterion 2.6's actual scope
 * exactly. A Sub_Team's `callsign_prefix` may now freely repeat --
 * across different Organisations (already true before this migration,
 * unaffected) AND under the SAME Organisation, as long as it does not
 * collide with a SIBLING Sub_Team under the identical immediate parent
 * (an application-layer concern for readability/callsign-collision
 * avoidance, not a schema-level identity concern -- deliberately left
 * unenforced at the DB layer, matching how team NAMES already work).
 *
 * The re-parenting/promotion edge case this scoping change newly
 * surfaces: `Team.update` lets a caller flip an existing Sub_Team's
 * `parent_team_id` to `null`, promoting it into an Organisation. Before
 * this migration that was always safe with respect to `callsign_prefix`
 * (the old index applied identically regardless of level, so a
 * promoted row's prefix was already guaranteed globally unique). After
 * this migration, a promoted Sub_Team's prefix is checked against every
 * OTHER Organisation's prefix for the FIRST time at the moment of
 * promotion -- exactly the scope Criterion 2.6 always intended, now
 * actually enforced at that specific transition too. `server/models/
 * Team.js`'s `update()` is updated alongside this migration to
 * recognise that transition and translate the resulting `23505` into
 * `CallsignPrefixConflictError`, the same way a same-level edit already
 * does, rather than letting a raw constraint violation surface as an
 * unhandled 500.
 *
 * `down()` restores the original DB-wide index exactly as the baseline
 * defined it, so a rollback returns to a database that is byte-for-byte
 * the pre-migration state (not merely "some unique index exists").
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const up = (pgm) => {
  // Raw SQL via `pgm.sql(...)`, matching this codebase's established
  // migration convention (see `1789200000000_baseline-schema.cjs`'s own
  // header comment) and keeping this migration compatible with
  // `database/migrations/__tests__/baselineMigration.integration.test.js`'s
  // `extractSeedSqlBlocks`, which runs every migration's `up()` against a
  // minimal mock `pgm` implementing only `.sql()`.
  pgm.sql(`
    DROP INDEX IF EXISTS idx_teams_callsign_prefix;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX idx_teams_callsign_prefix
      ON teams (callsign_prefix)
      WHERE (callsign_prefix IS NOT NULL AND parent_team_id IS NULL);
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_teams_callsign_prefix;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX idx_teams_callsign_prefix
      ON teams (callsign_prefix)
      WHERE (callsign_prefix IS NOT NULL);
  `);
};

module.exports = { shorthands, up, down };
