/**
 * BCH_Channel_Category migration.
 *
 * Generalizes `bch_channels` from a single implicit category ("BCH",
 * hardcoded as a literal string throughout `GlobalChannelService.js` and
 * `syncWorker.js`) to an explicit, data-driven `category` column, so a
 * second category ("UTL" -- Utility channels, e.g. "UTL - Data Packages")
 * can be created and managed through the SAME table and the SAME
 * mechanism BCH channels already use: an Authentik read/write group pair,
 * an ETL service account in the write group, and unconditional read-group
 * membership for every active user via
 * `syncWorker.assignUserToGlobalChannels`'s existing
 * `SELECT read_group_id FROM bch_channels WHERE read_group_id IS NOT NULL`
 * query -- that query has no category filter and needs none, since every
 * row in this table (regardless of category) is meant to be a mandatory,
 * unconditional channel for every active user.
 *
 * `category` is NOT NULL DEFAULT 'BCH': unlike `region_channels.tier`
 * (which has no default, because a Sub_Team's flags are meaningfully
 * absent/NULL rather than defaulted), every `bch_channels` row IS one
 * category or another with no third "not applicable" state, and every
 * pre-existing row in this deployment's dev database is unambiguously a
 * "BCH" channel today. A DEFAULT lets the column exist without a
 * backfill migration step and means every caller that doesn't yet know
 * about categories (there are none left after this feature ships, but a
 * DEFAULT is also simply correct here since 'BCH' is a valid, real
 * value, not a placeholder) still gets a valid row.
 *
 * This migration ALSO widens `bch_channels`' pre-existing
 * `bch_channels_name_key` UNIQUE constraint from `UNIQUE(name)` alone to
 * `UNIQUE(name, category)`, mirroring exactly what the
 * region-channel-tiers migration did for `region_channels_name_key` ->
 * `region_channels_name_tier_key` when `region_channels.tier` was added:
 * a bare `UNIQUE(name)` predates the category split and would wrongly
 * block a BCH channel and a UTL channel from ever sharing a display
 * name, even though they are legitimately distinct rows once category
 * exists.
 *
 * Nothing is shipped yet (per-project convention for an unreleased
 * feature) -- this migration can be amended in place rather than
 * corrected by a second migration if anything about its shape needs to
 * change before this ships.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.sql(`
ALTER TABLE public.bch_channels
    ADD COLUMN category character varying(20) NOT NULL DEFAULT 'BCH';

ALTER TABLE public.bch_channels
    ADD CONSTRAINT bch_channels_category_check CHECK (category IN ('BCH', 'UTL'));

COMMENT ON COLUMN public.bch_channels.category IS 'Which channel category this row belongs to: ''BCH'' (broadcast/ETL feeds, the original category) or ''UTL'' (utility channels, e.g. "UTL - Data Packages"). NOT NULL DEFAULT ''BCH'' -- every row is unambiguously one category or the other, with no Sub_Team-style "not applicable" state. Drives the Authentik group-name prefix (tak_BCH.../tak_UTL...) via BCH_CHANNEL_CATEGORY_PREFIX in server/config/constants.js. Every row, regardless of category, is an unconditional read-group membership target for every active user -- category changes NAMING only, never the sync-worker''s unconditional-membership treatment.';

-- Widen the pre-existing name-uniqueness constraint to (name, category):
-- a bare UNIQUE(name) predates the category split and would block a BCH
-- channel and a UTL channel from ever sharing a display name, even
-- though they would be two legitimately distinct rows once category
-- exists. Mirrors region_channels_name_key -> region_channels_name_tier_key
-- from the region-channel-tiers migration exactly.
ALTER TABLE public.bch_channels
    DROP CONSTRAINT bch_channels_name_key;

ALTER TABLE public.bch_channels
    ADD CONSTRAINT bch_channels_name_category_key UNIQUE (name, category);
`);
};

/**
 * Reverses exactly what `up()` did.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
ALTER TABLE public.bch_channels
    DROP CONSTRAINT IF EXISTS bch_channels_name_category_key;

ALTER TABLE public.bch_channels
    ADD CONSTRAINT bch_channels_name_key UNIQUE (name);

ALTER TABLE public.bch_channels
    DROP CONSTRAINT IF EXISTS bch_channels_category_check;

ALTER TABLE public.bch_channels
    DROP COLUMN IF EXISTS category;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
