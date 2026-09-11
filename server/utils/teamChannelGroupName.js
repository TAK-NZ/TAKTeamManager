/**
 * Derives the primary Team_Channel's display name and its Authentik group
 * name from a team's primitives (the root Organisation's callsign prefix and
 * country code, the team's own name, and whether it is a Sub_Team).
 *
 * Pure, framework-free logic with an interesting boundary, so it lives here in
 * `server/utils/` (no DB, no Express) where a property test can reach it
 * directly — the same placement rule the other name/identifier utils follow.
 *
 * WHY THIS EXISTS. This one derivation is consumed on three sides that must
 * agree byte-for-byte or the Authentik group silently splits/collides:
 *   - `Team.createTeamChannel` (create path — POSTs the group by this name),
 *   - `Team.update` (rename path — recomputes the name and enqueues a PATCH),
 *   - the Sync_Worker's `renameTeamChannelGroup` (applies the PATCH).
 * Keeping it in one place stops those three drifting apart.
 *
 * TWO RULES THIS ENCODES.
 *
 * 1. The root prefix ALWAYS composes `country_code` as its LEADING segment,
 *    exactly the way `userAttributes.js` builds the effective Organisation
 *    prefix (`[country_code, callsign_prefix].join('-')`). Without this, two
 *    distinct Foreign_Partner Organisations that legitimately share a
 *    `callsign_prefix` under different country codes (e.g. `CHL-CDEM` and
 *    `USA-CDEM`, whose DB uniqueness index is scoped to
 *    `(country_code, callsign_prefix)`) both derived the SAME group name
 *    `tak_Teams - CDEM` and collapsed onto ONE shared Authentik group. The
 *    country code makes them `tak_Teams - CHL-CDEM` vs `tak_Teams - USA-CDEM`.
 *
 * 2. The Authentik group name is ASCII-normalized via `toAsciiIdentifier`
 *    (TAK Server / LDAP cannot carry non-ASCII in a group name), while the
 *    human-facing `channelName`/`display_name` keeps its original characters
 *    (macrons and the like). Only the identifier that reaches TAK is
 *    normalized.
 *
 * @param {object} params
 * @param {string|null|undefined} params.rootPrefix   the root Organisation's `callsign_prefix`.
 * @param {string|null|undefined} params.rootCountryCode the root Organisation's `country_code` (ISO 3166-1 alpha-3, or null).
 * @param {string} params.teamName                    this team's own `name`.
 * @param {boolean} params.isSubTeam                   true when the team has a non-null `parent_team_id`.
 * @param {string} params.separator                   the resolved Channel_Folder_Separator (` - ` by default).
 * @param {(value: string) => string} params.toAsciiIdentifier ASCII-normalizer (injected so this stays framework/require-free).
 * @returns {{channelName: string, authentikGroupName: string}}
 */
function composeEffectiveRootPrefix(rootPrefix, rootCountryCode) {
  // Mirror userAttributes.js: join only the non-empty parts with `-`, so a
  // domestic Organisation (no country_code) is unchanged and a Foreign_Partner
  // Organisation gets its country as the leading segment. No stray
  // leading/trailing separator.
  return [rootCountryCode, rootPrefix]
    .filter((segment) => !!segment && String(segment).trim() !== '')
    .join('-');
}

function deriveTeamChannelName({
  rootPrefix,
  rootCountryCode,
  teamName,
  isSubTeam,
  separator,
  toAsciiIdentifier
}) {
  const effectiveRootPrefix = composeEffectiveRootPrefix(rootPrefix, rootCountryCode);

  let channelName;
  if (isSubTeam) {
    // Sub-team: "Teams - CHL-CDEM - Southland District"
    channelName = `Teams${separator}${effectiveRootPrefix}${separator}${teamName}`;
  } else {
    // Root team: "Teams - CHL-CDEM" (falls back to the team's own name only
    // when a root team has neither a prefix nor a country code).
    channelName = `Teams${separator}${effectiveRootPrefix || teamName}`;
  }

  const authentikGroupName = `tak_${toAsciiIdentifier(channelName)}`;

  return { channelName, authentikGroupName };
}

/**
 * Builds the `attributes` object CloudTAK expects on a team-owned "main"
 * Authentik group — the primary team channel's group AND a custom channel's
 * read/write (main) group. NOT the custom channel's `_READ`/`_WRITE` groups,
 * and NOT any global/BCH/region group.
 *
 * WHY THIS EXISTS. Authentik's PATCH on a group's `attributes` replaces the
 * WHOLE dict, not a merge (see tak-server-integration.md). Every site that
 * writes a main group's attributes must therefore write the COMPLETE set, or
 * a later partial write silently drops keys CloudTAK relies on. Centralising
 * the object here means create, reconcile, rename and the custom-channel edit
 * all emit an identical shape — a missing key can't drift in at one site.
 *
 * KEYS (exactly what CloudTAK expects):
 *   - `agencyId`   NUMBER — the owning Team id (`channels.team_id`).
 *   - `channelId`  NUMBER — the channel's own id (`channels.id`); unique per
 *                  channel, so two channels never share it. For a custom
 *                  channel this is the channel row's id, applied only to its
 *                  main group.
 *   - `channelName` STRING — the human display name (`channels.display_name`,
 *                  macrons preserved), NOT the ASCII-normalized group `name`.
 *   - `description` STRING — the group description (`channels.description`).
 *
 * `agencyId`/`channelId` are coerced to numbers (route params and some call
 * sites carry strings); a nullish `description` becomes `''` so the key is
 * always present.
 *
 * @param {object} params
 * @param {number|string} params.teamId      the owning Team id.
 * @param {number|string} params.channelId   the channel's own id.
 * @param {string} params.channelName        the human display name.
 * @param {string|null|undefined} params.description
 * @returns {{agencyId: number, channelId: number, channelName: string, description: string}}
 */
function teamChannelGroupAttributes({ teamId, channelId, channelName, description }) {
  return {
    agencyId: Number(teamId),
    channelId: Number(channelId),
    channelName,
    description: description ?? ''
  };
}

module.exports = {
  composeEffectiveRootPrefix,
  deriveTeamChannelName,
  teamChannelGroupAttributes
};
