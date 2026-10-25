/**
 * Pure helpers for the Authentik group name of a region channel.
 *
 * A region channel's group is named `tak_<TierPrefix><separator><ascii name>`,
 * e.g. `tak_Coordination - Auckland`. The tier prefix comes from
 * `REGION_CHANNEL_TIER_PREFIX` (server/config/constants.js) and the name is
 * ASCII-normalised the same way the Sync_Worker does when it creates or
 * updates the group, so a name computed here is byte-identical to the one the
 * worker would write.
 *
 * Kept free of framework and database imports so the decision logic can be
 * exercised directly by tests.
 */
const { REGION_CHANNEL_TIER_PREFIX } = require('../config/constants');
const { toAsciiIdentifier } = require('./asciiNormalize');

/**
 * @param {string} tier        a `region_channels.tier` value
 * @param {string} channelName `region_channels.name`
 * @param {string} separator   the channel folder separator (e.g. ' - ')
 * @returns {string|null} the group name, or null when `tier` is not a known tier
 */
function buildRegionGroupName(tier, channelName, separator) {
  const prefix = Object.prototype.hasOwnProperty.call(REGION_CHANNEL_TIER_PREFIX, tier)
    ? REGION_CHANNEL_TIER_PREFIX[tier]
    : undefined;
  if (!prefix) {
    return null;
  }
  return `tak_${prefix}${separator}${toAsciiIdentifier(channelName)}`;
}

/**
 * Picks the region channels whose Authentik group needs renaming.
 *
 * A channel is selected only when ALL of these hold:
 *   - it has a `group_id`;
 *   - that group is present in the fetched map (a group missing from the map
 *     is never touched: it may have been deleted in Authentik, and a short or
 *     failed fetch must never be read as "rename everything");
 *   - its tier is known;
 *   - the group's current name differs from the expected name.
 *
 * @param {Array<{id:number,name:string,tier:string,group_id:string|null,description:string|null}>} channels
 * @param {Record<string,string>} groupMap Authentik group pk -> current name
 * @param {string} separator
 * @returns {Array<{channel: object, expectedName: string, currentName: string}>}
 */
function selectRegionGroupRenames(channels, groupMap, separator) {
  const renames = [];
  for (const channel of channels) {
    if (!channel.group_id) continue;
    if (!Object.prototype.hasOwnProperty.call(groupMap, channel.group_id)) continue;
    const expectedName = buildRegionGroupName(channel.tier, channel.name, separator);
    if (expectedName === null) continue;
    const currentName = groupMap[channel.group_id];
    if (currentName === expectedName) continue;
    renames.push({ channel, expectedName, currentName });
  }
  return renames;
}

module.exports = { buildRegionGroupName, selectRegionGroupRenames };
