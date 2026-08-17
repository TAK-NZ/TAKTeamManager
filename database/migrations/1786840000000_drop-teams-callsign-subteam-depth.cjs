/**
 * Drops `teams.callsign_subteam_depth` (Flagged Design Decision 1,
 * design.md's Overview / task 11.3).
 *
 * Requirement 5 replaces the old "always the first N contiguous levels"
 * dial (`callsign_subteam_depth`) with Callsign_Level_Selection (a
 * non-contiguous set, stored in `teams.callsign_level_selection`, added
 * by `1786820000000_add-teams-callsign-level-selection.cjs`). Requirement
 * 8's rewritten callsign-assembly algorithm (`CallsignService`/
 * `UserAttributesService.computeCallsignAttributes`, task 11.1) never
 * reads `callsign_subteam_depth`, and this migration lands only AFTER
 * that rewrite has shipped (see tasks.md's note on why this destructive
 * migration is deliberately sequenced after task 11.1, not in Phase 1's
 * additive batch) -- `server/models/Team.js`'s `create`/`update` and
 * `server/routes/teams.js`'s create/update routes have likewise already
 * been updated (task 11.3 itself) to stop reading/writing this column
 * before this migration runs.
 *
 * Since this application has no production deployment yet, there is no
 * existing data to protect against an irreversible schema change, so
 * this migration drops the column outright rather than leaving dead
 * schema in place (design.md's Overview, Flagged Design Decision 1).
 *
 * `down` re-adds the column matching its original definition in
 * `1786810000000_add-teams-callsign-subteam-depth-and-name-format.cjs`
 * (`integer`, default `1`) for reversibility, though no application code
 * reads/writes it again once restored.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.dropColumn('teams', 'callsign_subteam_depth');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.addColumn('teams', {
    callsign_subteam_depth: {
      type: 'integer',
      default: 1,
    },
  });
};

module.exports = {
  shorthands,
  up,
  down,
};
