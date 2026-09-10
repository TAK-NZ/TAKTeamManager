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

module.exports = {
  composeEffectiveRootPrefix,
  deriveTeamChannelName
};
