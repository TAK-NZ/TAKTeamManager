/**
 * Region_Channel_Tier + Organisation channel-access flags migration.
 *
 * Two independent additions that together implement the Response/Support
 * channel split (docs.tak.nz "Channel Structure" -- inner-circle Emergency
 * Response coordination vs. outer-circle Support/all-agency coordination):
 *
 * 1. `region_channels.tier` -- every region channel row (the former single
 *    "Regions - X" tier) now declares which of the two tiers it belongs to.
 *    CHECK-constrained to exactly 'response' or 'support'. No column DEFAULT:
 *    every insert path (`GlobalChannelService.createRegionChannel`,
 *    `seedRegionChannels`) supplies a tier explicitly, and there are no
 *    pre-existing region_channels rows to backfill in this deployment (the
 *    former dummy/test rows were deleted directly against the test
 *    Authentik instance before this migration was written).
 *
 *    This migration ALSO widens `region_channels`' pre-existing
 *    `region_channels_name_key` UNIQUE constraint from `UNIQUE(name)` alone
 *    to `UNIQUE(name, tier)`. A bare `UNIQUE(name)` predates the tier split
 *    and is now WRONG: it would make a "Waikato" Response channel and a
 *    "Waikato" Support channel -- two legitimately different rows sharing a
 *    display name -- collide on name uniqueness alone, which
 *    `seedRegionChannels` hits immediately on its very first run (every
 *    region needs both tiers). Caught live against this migration's own
 *    dev database before this feature shipped anywhere. `up()` drops the
 *    old single-column constraint and adds the two-column one in the same
 *    migration as the `tier` column itself, since the old constraint is
 *    only wrong in a world where `tier` exists; `down()` reverses both,
 *    restoring the original bare `UNIQUE(name)`.
 *
 * 2. `teams.response_channel_access` / `teams.support_channel_access` --
 *    two Organisation-level policy flags, in EXACTLY the tri-state shape
 *    `pseudonymous_usernames` and `callsign_level_selection` already use:
 *    nullable with NO default, because NULL ("this row is a Sub_Team and the
 *    question does not apply") is a different fact from `false` ("this is an
 *    Organisation and the answer is no"). Collapsing them would make a
 *    Sub_Team indistinguishable from an Organisation that opted out. The
 *    resolver reads both flags from `Team.getAncestorChain(teamId)[0]`
 *    (the Organisation, index 0, root-first), never from a Sub_Team's own
 *    row.
 *
 *    Unlike `pseudonymous_usernames`, these two flags ARE mutable after
 *    Organisation creation -- there is no cryptographic/identifier
 *    consequence to flipping them, only group-membership reconciliation
 *    (handled by the `resync_org_channel_tier_access` sync operation).
 *
 *    The application supplies `false` (response) / `true` (support) at
 *    Organisation creation -- that default is the application's job
 *    (`Team.create`), not this migration's. This migration supplies no
 *    column default at all, matching the sibling flags' migrations.
 *
 * Follows the conventions of the migrations in this directory: raw SQL via
 * `pgm.sql(...)`, plain quotes with no backticks inside the SQL string, and a
 * `down()` that reverses exactly what `up()` did.
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
ALTER TABLE public.region_channels
    ADD COLUMN tier character varying(20);

ALTER TABLE public.region_channels
    ADD CONSTRAINT region_channels_tier_check CHECK (tier IN ('response', 'support'));

COMMENT ON COLUMN public.region_channels.tier IS 'Which channel tier this region channel belongs to: ''response'' (Emergency_Response, ES-only inner circle, gated by teams.response_channel_access) or ''support'' (all-agency outer circle, gated by teams.support_channel_access). No default -- every insert path supplies it explicitly. See docs.tak.nz Channel Structure.';

-- Widen the pre-existing name-uniqueness constraint to (name, tier): a
-- bare UNIQUE(name) predates the tier split and would block a same-named
-- Response/Support pair (e.g. "Waikato" of each tier) from coexisting.
ALTER TABLE public.region_channels
    DROP CONSTRAINT region_channels_name_key;

ALTER TABLE public.region_channels
    ADD CONSTRAINT region_channels_name_tier_key UNIQUE (name, tier);

ALTER TABLE public.teams
    ADD COLUMN response_channel_access boolean;

COMMENT ON COLUMN public.teams.response_channel_access IS 'Organisation-level only, exactly as pseudonymous_usernames and callsign_level_selection are. NULL on a Sub_Team (parent_team_id IS NOT NULL); false or true on an Organisation. Resolved via Team.getAncestorChain(teamId)[0]. Whether members of this Organisation (and its Sub_Teams) are synced into response-tier region channels. Defaults to false at Organisation creation (application-supplied, not a column default) and is mutable thereafter -- unlike pseudonymous_usernames, flipping it only triggers group-membership reconciliation, never an identifier/certificate consequence.';

ALTER TABLE public.teams
    ADD COLUMN support_channel_access boolean;

COMMENT ON COLUMN public.teams.support_channel_access IS 'Organisation-level only, exactly as response_channel_access is (see that column''s comment for the tri-state rationale). NULL on a Sub_Team; false or true on an Organisation. Resolved via Team.getAncestorChain(teamId)[0]. Whether members of this Organisation (and its Sub_Teams) are synced into support-tier region channels. Defaults to true at Organisation creation (application-supplied) -- the outer/support tier is the all-agency default, opposite of response_channel_access. Mutable thereafter.';
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
ALTER TABLE public.teams
    DROP COLUMN IF EXISTS support_channel_access;

ALTER TABLE public.teams
    DROP COLUMN IF EXISTS response_channel_access;

ALTER TABLE public.region_channels
    DROP CONSTRAINT IF EXISTS region_channels_name_tier_key;

ALTER TABLE public.region_channels
    ADD CONSTRAINT region_channels_name_key UNIQUE (name);

ALTER TABLE public.region_channels
    DROP CONSTRAINT IF EXISTS region_channels_tier_check;

ALTER TABLE public.region_channels
    DROP COLUMN IF EXISTS tier;
`);
};

module.exports = {
  shorthands,
  up,
  down,
};
