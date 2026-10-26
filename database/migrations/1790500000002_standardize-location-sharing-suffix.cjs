/**
 * Standardise the location-sharing qualifier on channel descriptions.
 *
 * Every Response/Coordination region channel and every primary team channel
 * description ends with " (Bi-directional location sharing)". The suffix lives
 * IN the stored description (single source of truth: it reaches the Authentik
 * group, the /dashboard tree and the column verbatim), and the application
 * already appends it exactly once when it creates or updates these channels.
 * Rows written before that was introduced are inconsistent:
 *
 *   - `region_channels`: stored WITHOUT any suffix
 *       "All of New Zealand (Coordination - All Agencies)"
 *   - `channels` (primary team channels): stored with the OLD qualifier
 *       "Users from FENZ - Auckland (Location sharing enabled)"
 *
 * This brings both to the unified shape:
 *   - region rows: the suffix is appended when missing;
 *   - primary team rows: a trailing " (Location sharing enabled)" is replaced
 *     by the unified suffix, and the suffix is appended when the row carries
 *     neither.
 *
 * Append-once: a row that already ends with the unified suffix is left alone,
 * so the migration never doubles it and is safe to re-run. An empty description
 * is left alone (there is no base text to qualify). Custom channels are out of
 * scope: their "Custom channel: ..." descriptions intentionally carry no
 * location-sharing qualifier. This is the same normalisation as
 * `scripts/backfill-location-sharing-suffix.js`, which is therefore no longer
 * needed for the local rows.
 *
 * The literals below MUST equal `LOCATION_SHARING_DESCRIPTION_SUFFIX` in
 * `server/config/constants.js` (pinned by `locationSharingSuffixMigration.test.js`).
 *
 * AUTHENTIK GROUP DESCRIPTIONS. This migration touches the local database only.
 * `AuthentikSyncService.reconcileRegionChannelGroups` and
 * `reconcileTeamChannelGroupDescriptions` compare each group's
 * `attributes.description` with these columns on every periodic sync and queue
 * the normal in-place update for any difference, so the groups follow without a
 * one-shot queued operation (which old Sync_Worker tasks running alongside the
 * new ones during a deploy cannot be relied on to handle).
 *
 * Incremental migration on top of the squashed baseline
 * (`1790200000000_baseline-schema.cjs`); NEVER hand-edit schema.sql.
 */
exports.shorthands = undefined;

const SUFFIX = ' (Bi-directional location sharing)';
const OLD_TEAM_SUFFIX = ' (Location sharing enabled)';

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE public.region_channels
       SET description = description || '${SUFFIX}'
     WHERE description IS NOT NULL
       AND description <> ''
       AND right(description, ${SUFFIX.length}) <> '${SUFFIX}';

    UPDATE public.channels
       SET description = CASE
             WHEN right(description, ${OLD_TEAM_SUFFIX.length}) = '${OLD_TEAM_SUFFIX}'
               THEN left(description, length(description) - ${OLD_TEAM_SUFFIX.length}) || '${SUFFIX}'
             ELSE description || '${SUFFIX}'
           END,
           updated_at = CURRENT_TIMESTAMP
     WHERE is_primary = true
       AND team_id IS NOT NULL
       AND description IS NOT NULL
       AND description <> ''
       AND right(description, ${SUFFIX.length}) <> '${SUFFIX}';
  `);
};

exports.down = (pgm) => {
  // Not reversible without losing information: after the up, a description that
  // had the suffix all along is indistinguishable from one that gained it. The
  // unified suffix is the intended steady state, so down is a deliberate no-op.
  pgm.sql('SELECT 1');
};
