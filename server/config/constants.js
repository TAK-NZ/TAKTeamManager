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

/**
 * Bugfix (CSV bulk team import mandatory TAK Colour): the fixed set of
 * 14 TAK Colour names this deployment recognises -- the exact same set
 * `server/routes/config.js`'s `GET /api/config/color-mappings` reads
 * from `TAK_COLOR_*` environment variables, `client/src/components/
 * TeamFormDialog.jsx`'s dropdown offers as `<option>` values, and the
 * baseline migration's `SEED_ENV_VARS` seeds into `system_config`.
 * `teams.color` and `user_cache.tak_color` both store one of these
 * NAMES verbatim (not a hex code -- `'#3B82F6'` is only ever this
 * column's un-set DEFAULT, never a value any real creation path writes
 * intentionally), so this is the single place a value is validated
 * against the canonical set before insertion, used by
 * `BulkImportService.parseRowColor` (task: CSV mandatory TAK Colour).
 *
 * Frozen and exported as an array (insertion order matches
 * `TeamFormDialog.jsx`'s own dropdown order) so a caller needing an O(1)
 * membership check can trivially build a `Set` from it without this
 * module needing to expose two different shapes.
 */
const TAK_COLOR_NAMES = Object.freeze([
  'Yellow',
  'Cyan',
  'Green',
  'Red',
  'Purple',
  'Orange',
  'Blue',
  'Magenta',
  'White',
  'Maroon',
  'Dark Blue',
  'Teal',
  'Dark Green',
  'Brown'
]);

/**
 * region-channel-tiers: maps a `region_channels.tier` value ('response' or
 * 'support') to the Authentik group-name prefix used for that tier
 * (`tak_Response...`/`tak_Support...`). 'response' is the ES-only
 * Emergency_Response inner circle, gated by `teams.response_channel_access`;
 * 'support' is the all-agency outer circle, gated by
 * `teams.support_channel_access` and the direct continuation of what the
 * former single, untiered Region channel already did.
 *
 * Single source of truth shared by `server/services/GlobalChannelService.js`
 * (channel creation) and `server/workers/syncWorker.js` (the Authentik group
 * create/update/sync handlers), so the two can never define this mapping
 * differently. Frozen, and deliberately not a superset of the CHECK
 * constraint's own two values -- every value here is one the migration's
 * `region_channels_tier_check` constraint also accepts, and vice versa.
 */
const REGION_CHANNEL_TIER_PREFIX = Object.freeze({
  response: 'Response',
  support: 'Support'
});

/**
 * region-channel-tiers (bugfix): a short, human-readable qualifier
 * distinguishing the two tiers in a channel's DESCRIPTION text, used by
 * `GlobalChannelService.seedRegionChannels` to build each seeded
 * channel's `description` as `"<name> (<qualifier>)"` -- e.g.
 * `"Auckland (Response - Emergency Services)"` vs.
 * `"Auckland (Support - All Agencies)"` -- rather than the bare region
 * name alone, which was IDENTICAL for both tiers and gave a user no way
 * to tell "Response - Auckland" and "Support - Auckland" apart from
 * their description text (client's Response/Support card headings
 * already use this same "Emergency Services"/"All Agencies" wording, so
 * this reuses it rather than inventing new terminology).
 *
 * Manually created region channels (`POST /api/global-channels/region`)
 * are unaffected: their `description` is always caller-supplied, never
 * defaulted from this table.
 */
const REGION_CHANNEL_TIER_DESCRIPTION_QUALIFIER = Object.freeze({
  response: 'Response - Emergency Services',
  support: 'Support - All Agencies'
});

/**
 * bch-channel-category: maps a `bch_channels.category` value ('BCH' or
 * 'UTL') to the Authentik group-name prefix used for that category
 * (`tak_BCH...`/`tak_XtraTools...`). 'BCH' is the original broadcast/ETL
 * category (external data feeds pushed in via a service account);
 * 'UTL' is the general miscellaneous/utility category (e.g.
 * "XtraTools - Data Packages", covering things like map overlays and
 * data packages/syncs), added so a non-ETL channel can still get the
 * exact same service-account/read-write-group/unconditional-membership
 * machinery BCH channels already have, without inventing a second
 * mechanism.
 *
 * The DISPLAY PREFIX was renamed from 'UTL' to 'XtraTools' (the DB
 * category VALUE stays 'UTL' -- see the `bch_channels_category_check`
 * migration, unchanged) because 'UTL' read to non-technical users as a
 * utility-company abbreviation, and because channels are sorted
 * alphabetically: 'XtraTools' keeps this category sorting near the end
 * of the list (as 'UTL' did) while being an unambiguous, plain-language
 * name. Renaming this value alone is sufficient to rename every group
 * this category creates going forward -- see
 * `createBchChannelGroups`/`updateBchChannelGroup`/
 * `syncExistingGlobalChannels` in `server/workers/syncWorker.js`, none of
 * which hardcode the literal string 'UTL' as a display prefix. Any
 * ALREADY-CREATED Authentik group under the old `tak_UTL...` name needs
 * a one-time rename to match (not something this constant alone can
 * retroactively fix).
 *
 * Single source of truth shared by `server/services/GlobalChannelService.js`
 * (channel creation) and `server/workers/syncWorker.js` (the Authentik
 * group create/update/sync handlers), mirroring `REGION_CHANNEL_TIER_PREFIX`
 * exactly. Frozen. The KEYS here (not the values) are what the CHECK
 * constraint's own two values must match -- every key here is one the
 * migration's `bch_channels_category_check` constraint also accepts, and
 * vice versa; the values are free-standing display text.
 *
 * Every `bch_channels` row, regardless of category, is treated
 * identically by `syncWorker.assignUserToGlobalChannels`'s unconditional
 * read-group-membership query (`SELECT read_group_id FROM bch_channels
 * WHERE read_group_id IS NOT NULL`, no category filter) -- category
 * changes Authentik NAMING only, never that unconditional-membership
 * treatment.
 */
const BCH_CHANNEL_CATEGORY_PREFIX = Object.freeze({
  BCH: 'BCH',
  UTL: 'XtraTools'
});

/**
 * The trailing qualifier appended to a Team / Response / Support channel's
 * STORED `description` (e.g. `Users from Teams - FENZ (Bi-directional
 * location sharing)`). "Bi-directional" is deliberate: these are read/write
 * channels, so a member both sees others' locations and shares their own --
 * the phrase says WHAT the channel does, not merely that a feature is on.
 *
 * SINGLE SOURCE OF TRUTH. Because the suffix is stored IN the description
 * column (not appended only at Authentik-write time), the SAME string
 * reaches three places verbatim: the Authentik/LDAP group's
 * `attributes.description`, the `/dashboard` channel tree, and the local DB
 * row. Every site that builds one of these descriptions must use this
 * constant so the wording can never drift between them. It is stored
 * exactly ONCE per description -- helpers append it when building a fresh
 * description, and the Authentik write uses the stored value verbatim (no
 * second append), so there is no risk of doubling.
 *
 * Leading space included so callers concatenate `${base}${SUFFIX}` cleanly.
 * NOTE: custom channels are intentionally OUT of scope -- their
 * `Custom channel: ...` descriptions carry no location-sharing qualifier.
 */
const LOCATION_SHARING_DESCRIPTION_SUFFIX = ' (Bi-directional location sharing)';

module.exports = {
  MAX_TEAM_DEPTH,
  TAK_COLOR_NAMES,
  REGION_CHANNEL_TIER_PREFIX,
  REGION_CHANNEL_TIER_DESCRIPTION_QUALIFIER,
  BCH_CHANNEL_CATEGORY_PREFIX,
  LOCATION_SHARING_DESCRIPTION_SUFFIX
};
