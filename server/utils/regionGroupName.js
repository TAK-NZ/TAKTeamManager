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
 * Picks the region channels whose Authentik group has drifted from the local
 * row, in its NAME (`tak_<Prefix> - <Name>`) or its DESCRIPTION.
 *
 * The local row is authoritative: `region_channels.description` already
 * carries the location-sharing suffix, and the Sync_Worker writes it verbatim
 * to the group's `attributes.description`. A group whose description is
 * missing or different therefore needs the same `update_region_channel_group`
 * operation that fixes a stale name.
 *
 * A channel is selected only when ALL of these hold:
 *   - it has a `group_id`;
 *   - that group is present in the fetched map (a group missing from the map
 *     is never touched: it may have been deleted in Authentik, and a short or
 *     failed fetch must never be read as "update everything");
 *   - its tier is known;
 *   - the group's name or description differs from what the row implies.
 *
 * @param {Array<{id:number,name:string,tier:string,group_id:string|null,description:string|null}>} channels
 * @param {Record<string,{name:string,description?:string|null}>} groupsByPk
 *   Authentik group pk -> current name and `attributes.description`
 * @param {string} separator
 * @returns {Array<{channel: object, expectedName: string, currentName: string,
 *   nameDrift: boolean, descriptionDrift: boolean}>}
 */
function selectRegionGroupUpdates(channels, groupsByPk, separator) {
  const updates = [];
  for (const channel of channels) {
    if (!channel.group_id) continue;
    if (!Object.prototype.hasOwnProperty.call(groupsByPk, channel.group_id)) continue;
    const expectedName = buildRegionGroupName(channel.tier, channel.name, separator);
    if (expectedName === null) continue;
    const group = groupsByPk[channel.group_id];
    const currentName = group.name;
    const nameDrift = currentName !== expectedName;
    const descriptionDrift = (group.description || '') !== (channel.description || '');
    if (!nameDrift && !descriptionDrift) continue;
    updates.push({ channel, expectedName, currentName, nameDrift, descriptionDrift });
  }
  return updates;
}

module.exports = { buildRegionGroupName, selectRegionGroupUpdates };
