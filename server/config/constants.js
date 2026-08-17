/**
 * Shared, system-wide application constants.
 *
 * `MAX_TEAM_DEPTH` (Requirement 2.1): a fixed maximum number of Team levels
 * beneath an Organisation (the root `teams` row, `parent_team_id IS NULL`).
 * An Organisation itself has a Team_Depth of 0; its direct children have a
 * Team_Depth of 1; and so on, up to and including `MAX_TEAM_DEPTH`.
 *
 * This value is intentionally a single, hardcoded constant, NOT a
 * per-Organisation database column and NOT settable/updatable through any
 * API. Every enforcement point across the codebase (Team creation's depth
 * check, Callsign_Level_Selection validation, `BulkImportService`'s
 * row-level depth check, the `GET /api/config/public` response consumed by
 * the Client's disable logic) imports this single constant rather than
 * hardcoding `5` independently, so the limit can never drift between call
 * sites.
 */

const MAX_TEAM_DEPTH = 5;

module.exports = {
  MAX_TEAM_DEPTH
};
