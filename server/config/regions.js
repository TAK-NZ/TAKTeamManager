/**
 * NZ_Regions (region-channel-tiers): the standing list of region names
 * `GlobalChannelService.seedRegionChannels` creates Response/Coordination
 * channel pairs for, matching docs.tak.nz's Channel Structure page
 * exactly -- ISO 3166-2:NZ subdivisions, root-first alphabetical order as
 * that page lists them, for both tiers.
 *
 * Deliberately EXCLUDES the two additional geographies docs.tak.nz
 * documents as their own National_Channels category (Chatham Islands and
 * "All of New Zealand") -- those two follow different per-tier rules (see
 * `SPECIAL_REGIONS` below) and are seeded separately by
 * `seedRegionChannels`, not folded into this list.
 *
 * A single, centralized list rather than inline literals at the seed
 * call site, so a future region addition/rename is a one-line change in
 * one place.
 */
const NZ_REGIONS = Object.freeze([
  'Northland',
  'Auckland',
  'Waikato',
  'Bay of Plenty',
  'Gisborne',
  'Hawkes Bay',
  'Taranaki',
  'Manawatu-Whanganui',
  'Wellington',
  'Tasman',
  'Nelson',
  'Marlborough',
  'West Coast',
  'Canterbury',
  'Otago',
  'Southland'
]);

/**
 * Special_Regions (region-channel-tiers): the National_Channels
 * geographies outside the 16 standard regions (Chatham Islands, All of New
 * Zealand, North Island, South Island), each with which tiers
 * `seedRegionChannels` creates a channel for.
 *
 * - Chatham Islands: BOTH tiers, like every standard region -- it is
 *   geographically isolated but functions as a normal (if isolated)
 *   region for a local incident, per the explicit product decision this
 *   feature was scoped against.
 * - All of New Zealand: COORDINATION ONLY. A country-scale event is exactly
 *   the case the Response/Coordination escalation model already treats as
 *   "everyone joins Coordination" -- a Response-tier "All of New Zealand"
 *   channel would be an ES-only inner-circle channel for an event that,
 *   by definition, already involves the outer circle, which is not a
 *   coherent channel to seed.
 * - North Island / South Island: COORDINATION ONLY, for the same reason
 *   -- an island-wide coordination space across the regions of that island
 *   has no ES-only inner-circle counterpart. Like every Coordination
 *   channel they are gated by `teams.coordination_channel_access`.
 */
const SPECIAL_REGIONS = Object.freeze([
  { name: 'Chatham Islands', tiers: ['response', 'coordination'] },
  { name: 'All of New Zealand', tiers: ['coordination'] },
  { name: 'North Island', tiers: ['coordination'] },
  { name: 'South Island', tiers: ['coordination'] }
]);

/**
 * region-channel-tiers: the full standard (name, tier) work list --
 * every `NZ_REGIONS` entry for both tiers, plus each `SPECIAL_REGIONS`
 * entry for only the tiers it declares. This is the SAME list
 * `GlobalChannelService.seedRegionChannels` creates channels from and
 * `GlobalChannelService.getMissingRegionSeedItems` diffs against the
 * currently-seeded set (bugfix: lets the client hide its "Seed Standard
 * Region Channels" action once nothing is left to seed, rather than
 * always showing it) -- extracted here as the single source of truth so
 * neither caller can drift from the standing region/tier list above.
 *
 * @returns {Array<{name: string, tier: 'response'|'coordination'}>}
 */
function buildRegionSeedWorkItems() {
  const workItems = [];
  for (const name of NZ_REGIONS) {
    workItems.push({ name, tier: 'response' });
    workItems.push({ name, tier: 'coordination' });
  }
  for (const { name, tiers } of SPECIAL_REGIONS) {
    for (const tier of tiers) {
      workItems.push({ name, tier });
    }
  }
  return workItems;
}

module.exports = {
  NZ_REGIONS,
  SPECIAL_REGIONS,
  buildRegionSeedWorkItems
};
