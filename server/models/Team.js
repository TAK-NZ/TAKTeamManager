const pool = require('../config/database');
const logger = require('../config/logger').createLogger('Team');
const EventPublisher = require('../services/EventPublisher');
const { isCloudTakEnabled } = require('../config/cloudtak');
const { MAX_TEAM_DEPTH } = require('../config/constants');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { toAsciiIdentifier } = require('../utils/asciiNormalize');
const { isValidCountryCode, normaliseCountryCode } = require('../utils/isoCountry');
const { resolveChannelFolderSeparator } = require('../utils/channelFolderSeparator');
const { deriveTeamChannelName, teamChannelGroupAttributes } = require('../utils/teamChannelGroupName');

/**
 * Requirement 2.2-2.3 (task 5.1): thrown by `Team.create` when the
 * Sub_Team it would create sits at a Team_Depth greater than
 * `MAX_TEAM_DEPTH`. Thrown BEFORE any INSERT is attempted, from a guard
 * that runs ahead of `create`'s existing try/catch (whose catch block
 * falls back to a basic INSERT when new columns don't exist), so this
 * error is never swallowed by that fallback path and always propagates to
 * the caller distinctly. Callers (e.g. `POST /api/teams`, task 5.2) can
 * check `error instanceof Team.TeamDepthExceededError` to respond with a
 * 400 naming Max_Team_Depth, without creating the team.
 */
class TeamDepthExceededError extends Error {
  constructor(message = `Maximum team depth (${MAX_TEAM_DEPTH}) exceeded`) {
    super(message);
    this.name = 'TeamDepthExceededError';
  }
}

/**
 * Requirement 5.2 (task 8.1): thrown by `Team.create`/`Team.update` when a
 * supplied `callsign_level_selection` value is not an array of integers
 * each between 1 and `MAX_TEAM_DEPTH` inclusive. Thrown BEFORE any
 * INSERT/UPDATE is attempted, mirroring `TeamDepthExceededError`'s
 * placement outside the existing try/catch, so it is never swallowed by
 * that catch's fallback-to-basic-creation behaviour. A later task (8.2)
 * maps `error instanceof Team.CallsignLevelSelectionRangeError` to a 400
 * response: "callsignLevelSelection values must be between 1 and 5".
 */
class CallsignLevelSelectionRangeError extends Error {
  constructor(message = `callsignLevelSelection values must be between 1 and ${MAX_TEAM_DEPTH}`) {
    super(message);
    this.name = 'CallsignLevelSelectionRangeError';
  }
}

/**
 * Requirement 5.6 (task 8.1): thrown by `Team.create`/`Team.update` when a
 * `callsign_level_selection` value is supplied for a Sub_Team (a team
 * whose `parent_team_id` is not null). Thrown BEFORE any INSERT/UPDATE is
 * attempted, for the same reason as `TeamDepthExceededError`. A later
 * task (8.2) maps `error instanceof Team.CallsignLevelSelectionSubTeamError`
 * to a 400 response: "callsignLevelSelection can only be set on an
 * Organisation".
 */
class CallsignLevelSelectionSubTeamError extends Error {
  constructor(message = 'callsignLevelSelection can only be set on an Organisation') {
    super(message);
    this.name = 'CallsignLevelSelectionSubTeamError';
  }
}

/**
 * takserver-enrollment Requirement 6.2 (task 5.4): thrown by
 * `Team.create`/`Team.update` when a `pseudonymous_usernames` value is
 * supplied for a Sub_Team (a team whose `parent_team_id` is not null).
 * The Pseudonymous_Username_Policy is Organisation-only in EXACTLY the
 * way `callsign_level_selection` already is, so this mirrors
 * `CallsignLevelSelectionSubTeamError`'s placement (outside the
 * create/update try/catch, so it always propagates distinctly to the
 * caller rather than being swallowed by the fallback-to-basic-creation
 * catch) and its typed-rejection shape.
 */
class PseudonymousUsernamePolicySubTeamError extends Error {
  constructor(message = 'pseudonymousUsernames can only be set on an Organisation') {
    super(message);
    this.name = 'PseudonymousUsernamePolicySubTeamError';
  }
}

/**
 * Thrown by `Team.create`/`Team.update` when a `response_channel_access`
 * or `support_channel_access` value is supplied for a Sub_Team (a team
 * whose `parent_team_id` is not null). Both flags are Organisation-only
 * in EXACTLY the way `pseudonymous_usernames` is -- this mirrors
 * `PseudonymousUsernamePolicySubTeamError`'s placement (outside the
 * create/update try/catch, so it always propagates distinctly to the
 * caller rather than being swallowed by the fallback-to-basic-creation
 * catch) and its typed-rejection shape. A single parameterized class
 * covers both fields rather than two near-identical classes, since
 * unlike `pseudonymous_usernames` neither flag carries an immutability
 * rule once set on an Organisation -- there is no second, differently-
 * worded error needed for either.
 */
class ChannelTierAccessSubTeamError extends Error {
  constructor(fieldName) {
    super(`${fieldName} can only be set on an Organisation`);
    this.name = 'ChannelTierAccessSubTeamError';
    this.fieldName = fieldName;
  }
}

/**
 * Data-corruption bugfix: thrown by `Team.addMember` when `userId`'s
 * EXISTING `team_memberships` row for `teamId` is an INHERITED one
 * (`inherited_from_team_id` NOT NULL). Thrown BEFORE any write is
 * attempted, mirroring `TeamDepthExceededError`'s placement outside this
 * method's existing try/catch, so it is never swallowed by that catch's
 * fallback-to-basic-insert path.
 *
 * `addMember`'s `INSERT ... ON CONFLICT (user_id, team_id) DO UPDATE SET
 * role = $3` upsert is designed for a DIRECT row (adding a brand-new
 * member, or promoting/demoting an existing direct member/admin) -- it
 * sets `role` alone and never touches `inherited_from_team_id`. Calling
 * it against a user's INHERITED row for this team (e.g. a Sub_Team
 * member appearing on their Organisation's Member_List purely via
 * inheritance) hits that same conflict target and would set
 * `role = 'admin'` on a row that keeps `inherited_from_team_id` set --
 * producing a row that is simultaneously an admin row AND an inherited
 * one, which violates this app's own Team_Admin definition (a DIRECT
 * admin row, per `Team.isAdmin`/the glossary). Every real authorization
 * check keys off `inherited_from_team_id IS NULL`, so such a row reads
 * as "admin" in any UI that only filters on `role` (e.g. the Team Admins
 * tab) while being denied by every actual `Team.isAdmin` check --
 * exactly the corrupted state this error prevents from being created.
 *
 * A user with an inherited row here has a genuine Direct_Membership
 * elsewhere; making them a real Team_Admin of `teamId` requires moving
 * that Direct_Membership via a Team_Transfer
 * (`TeamTransferService.executeTransfer`), not this method.
 */
class InheritedMembershipPromotionError extends Error {
  constructor(teamId, userId) {
    super('This user belongs to this team only by inheritance from a Sub_Team. Transfer their membership to this team before making them an admin here.');
    this.name = 'InheritedMembershipPromotionError';
    this.teamId = teamId;
    this.userId = userId;
  }
}

/**
 * takserver-enrollment Requirement 7.2/7.3 (task 5.4): thrown by
 * `Team.update` when a request attempts to change an EXISTING
 * Organisation's `pseudonymous_usernames` value (a resubmission of the
 * current value is accepted as a no-op; see `Team.update`). The
 * Pseudonymous_Username_Policy is fixed at Organisation creation, and
 * per Criterion 7.3 the rejection must state the CONCRETE consequence,
 * not merely cite a policy: enabling/disabling it on an existing
 * Organisation would require every existing member's username to
 * change, and each such change invalidates that member's certificate
 * Common Name, every certificate issued under it, and every device
 * record referencing it, forcing every device in the Organisation to
 * re-enroll. The same sentence appears here and in the rejection
 * message a caller sees, deliberately -- a rejection message and a code
 * comment that disagree are two chances to get the reason wrong.
 */
class PseudonymousUsernamePolicyImmutableError extends Error {
  constructor(
    message = "Pseudonymous usernames cannot be enabled or disabled on an existing Organisation. Doing so would require every existing member's username to change, and each change invalidates that member's certificate Common Name, every certificate issued under it, and every device record referencing it -- forcing every device in this Organisation to re-enroll. Change a member's Callsign Suffix, first name or last name instead; none of those appear in a certificate."
  ) {
    super(message);
    this.name = 'PseudonymousUsernamePolicyImmutableError';
  }
}

/**
 * Bugfix (callsign-handling): thrown by `Team.update` when a request
 * attempts to CHANGE an existing Organisation's `callsign_prefix` (a
 * resubmission of the current value is accepted as a no-op, mirroring
 * `PseudonymousUsernamePolicyImmutableError`'s exact shape). An
 * Organisation's `callsign_prefix` is its Organisation_Prefix
 * (takserver-enrollment Requirement 2): every already-minted
 * Managed_Identifier (a Human_Principal's Pseudonymous_Username or a
 * Team_Owned_Device's identifier) is a fixed string derived from it at
 * mint time, so changing the Organisation's own row afterward would make
 * the prefix stored on `teams` disagree with every identifier already
 * minted from it, with no mechanism to reconcile the two.
 *
 * A Sub_Team's `callsign_prefix` carries no such constraint -- it
 * participates only in Callsign generation, never in a Managed_Identifier
 * (Requirement 2 Criterion 3) -- so it remains freely editable after
 * creation; only the Organisation's own row is locked by this guard.
 */
class OrganisationCallsignPrefixImmutableError extends Error {
  constructor(
    message = "An Organisation's Prefix cannot be changed after creation: every device and user identifier already minted under it is a fixed string derived from this value, and changing it would leave those identifiers unable to be traced back to their Organisation's current prefix. A Sub_Team's Prefix has no such restriction and may be edited freely."
  ) {
    super(message);
    this.name = 'OrganisationCallsignPrefixImmutableError';
  }
}

/**
 * Foreign_Partner Organisation country prefix feature: thrown by
 * `Team.create`/`Team.update` when a `country_code` is supplied on a
 * Sub_Team (`parent_team_id` present). Country is an Organisation-only
 * field, exactly like `pseudonymous_usernames`/`callsign_level_selection`.
 */
class CountryCodeSubTeamError extends Error {
  constructor(message = 'countryCode can only be set on an Organisation') {
    super(message);
    this.name = 'CountryCodeSubTeamError';
  }
}

/**
 * Foreign_Partner Organisation country prefix feature: thrown by
 * `Team.create`/`Team.update` when a supplied `country_code` is a non-empty
 * value that is not a known ISO 3166-1 alpha-3 code (per the vendored
 * dataset behind `isoCountry.isValidCountryCode`). Distinct from the
 * immutability error below: this is a bad VALUE (mapped to a 400), not a
 * disallowed CHANGE.
 */
class CountryCodeInvalidError extends Error {
  constructor(value) {
    super(`Country code "${value}" is not a valid ISO 3166-1 alpha-3 code`);
    this.name = 'CountryCodeInvalidError';
    this.conflictingValue = value;
  }
}

/**
 * Foreign_Partner Organisation country prefix feature: thrown by
 * `Team.update` when a request attempts to CHANGE an existing
 * Organisation's `country_code` (including setting one where there was
 * none, or clearing one that was set). Mirrors
 * `OrganisationCallsignPrefixImmutableError` exactly: the country code is
 * composed into the Organisation's effective callsign prefix, so every
 * Managed_Identifier and callsign already minted under it embeds it --
 * changing it would orphan those identifiers from their Organisation. A
 * no-op resubmission of the CURRENT value is accepted (normalised to a
 * no-op before the UPDATE); any real change throws this. Only ever fires
 * on an Organisation (a Sub_Team never carries a country_code at all).
 */
class OrganisationCountryCodeImmutableError extends Error {
  constructor(
    message = "An Organisation's Country cannot be changed after creation: it is composed into the Organisation's callsign prefix, so every device and user identifier already minted under it is derived from it. It must be set correctly when the Organisation is first created."
  ) {
    super(message);
    this.name = 'OrganisationCountryCodeImmutableError';
  }
}

/**
 * Bugfix (callsign-handling): thrown by `Team.create`/`Team.update` when
 * a `callsign_prefix` value collides with `idx_teams_callsign_prefix`.
 *
 * Scoping fix: that index is now UNIQUE over non-null `callsign_prefix`
 * values among ORGANISATIONS ONLY (`parent_team_id IS NULL`), not across
 * every team -- see `1789400000000_scope-callsign-prefix-uniqueness-to-organisations.cjs`'s
 * own header comment for why a Sub_Team's prefix never needed this
 * protection in the first place (only an Organisation's prefix ever
 * feeds a Managed_Identifier). So this error can now only actually fire
 * for: (a) creating or promoting-to-root a second Organisation whose
 * prefix collides with an existing Organisation's, or (b) a
 * still-possible-in-principle collision if a future migration ever adds
 * a second Sub_Team-scoped uniqueness rule -- there is none today, so in
 * practice this is purely an Organisation-vs-Organisation conflict now.
 *
 * Bugfix (Foreign_Partner Organisation country prefix): the index is
 * further scoped to `(country_code, callsign_prefix)` with `NULLS NOT
 * DISTINCT` (now part of the squashed baseline schema),
 * since the column this protects is the Organisation-prefix SEGMENT, not
 * the effective composed prefix -- two Foreign_Partner Organisations
 * with the same `callsign_prefix` under DIFFERENT `country_code` values
 * (e.g. `FJI-FIRE` and `AUS-FIRE`) are not actually ambiguous and must
 * not collide, while two domestic (`country_code IS NULL`) Organisations
 * sharing a bare prefix still must.
 */
class CallsignPrefixConflictError extends Error {
  constructor(conflictingValue) {
    super(`Callsign Prefix "${conflictingValue}" is already in use by another team`);
    this.name = 'CallsignPrefixConflictError';
    this.conflictingValue = conflictingValue;
  }
}

/**
 * Org-wide-team-name-uniqueness feature: thrown by `Team.create`/
 * `Team.update` when the team being created/updated/re-parented would
 * share its `name` with ANOTHER team in the SAME Organisation (the whole
 * subtree under one root, `parent_team_id IS NULL`), not merely under
 * the same immediate parent.
 *
 * The baseline DB constraint `teams_name_parent_team_id_key`
 * (`UNIQUE (name, parent_team_id)`) only prevents two teams sharing a
 * name under the SAME immediate parent -- it cannot express org-wide
 * uniqueness, which spans many different `parent_team_id` values under
 * one root. Enforcing that declaratively would require a denormalized
 * `organisation_id` column maintained across every insert/update/
 * re-parent; instead this is enforced at the application layer, resolving
 * the Organisation via `getAncestorChain(...)[0]` -- the SAME primitive
 * and the SAME "check before the write, throw a typed error" approach
 * the sibling `CallsignPrefixConflictError` path already uses. The DB
 * constraint is kept as a strict-subset backstop.
 *
 * Matching the DB constraint's own case-sensitive behaviour, the name
 * comparison is case-sensitive ("Auckland" and "auckland" are distinct).
 *
 * Thrown BEFORE any INSERT/UPDATE (outside the fallback try/catch), so
 * it propagates distinctly to the caller (mapped to a 400 by the
 * `POST`/`PUT /api/teams` routes and recorded as a per-row failure by
 * the bulk import), never swallowed by the fallback-to-basic-creation
 * path.
 */
class TeamNameConflictError extends Error {
  constructor(conflictingName) {
    super(`A team named "${conflictingName}" already exists in this Organisation`);
    this.name = 'TeamNameConflictError';
    this.conflictingName = conflictingName;
  }
}

class Team {
  static async create(teamData) {
    const { name, description, callsign_prefix, visibility, can_join, parent_team_id, created_by } = teamData;
    // Control option (NOT a persisted column): when true, the
    // auto-created primary team channel defers its Authentik group
    // creation to the sync worker instead of making a blocking Authentik
    // call inline -- see `createTeamChannel`'s doc comment. Used by CSV
    // bulk team import to keep each per-row create pure DB work. Defaults
    // to false so every single-team-creation caller is unchanged.
    const deferGroupCreation = teamData.deferGroupCreation === true;
    // Requirement 3.2 (task 6.1): `color`/`callsign_name_format` are
    // Organisation-only fields -- declared with `let` (not `const`)
    // because, when `parent_team_id` is present, they are overridden
    // below with the Sub_Team's Organisation's CURRENT values, regardless
    // of whatever value was supplied on `teamData`.
    let { color, callsign_name_format } = teamData;
    // Requirement 5.1/5.3/5.6 (task 8.1): `callsign_level_selection` is an
    // Organisation-only field, declared with `let` because it is
    // validated/defaulted (root team) or forced to `null` (Sub_Team)
    // below, before ever reaching the INSERT.
    let { callsign_level_selection } = teamData;
    // takserver-enrollment Requirement 6.1/6.2 (task 5.4):
    // `pseudonymous_usernames` is an Organisation-only field, mirroring
    // `callsign_level_selection` exactly: declared with `let` because it
    // is defaulted to `false` (root team) or forced to `null` (Sub_Team)
    // below, before ever reaching the INSERT.
    let { pseudonymous_usernames } = teamData;
    // response_channel_access/support_channel_access are Organisation-only
    // fields, mirroring pseudonymous_usernames exactly in tri-state shape:
    // declared with `let` because each is defaulted (root team) or forced
    // to `null` (Sub_Team) below, before ever reaching the INSERT. Unlike
    // pseudonymous_usernames, both are freely mutable after creation via
    // Team.update -- flipping either only triggers Response/Support
    // group-membership reconciliation, never an identifier/certificate
    // consequence, so neither carries an immutability guard.
    let { response_channel_access, support_channel_access } = teamData;
    // Foreign_Partner Organisation country prefix feature: `country_code`
    // is an Organisation-only field, mirroring `pseudonymous_usernames`'s
    // tri-state shape -- declared with `let` because it is validated and
    // normalised to upper-case alpha-3 (root team) or forced to `null`
    // (Sub_Team) below, before ever reaching the INSERT. NULL means a
    // domestic (NZ) Organisation.
    let { country_code } = teamData;
    // Callsign Team-segment separator toggle: `callsign_team_hyphenated`
    // is an Organisation-only field, mirroring `pseudonymous_usernames`'s
    // tri-state shape exactly -- declared with `let` because it is
    // defaulted to `false` (root team) or forced to `null` (Sub_Team)
    // below, before ever reaching the INSERT. It is NEVER read off a
    // Sub_Team's own row (`computeCallsignAttributes`/
    // `DeviceEnrollmentService` only ever read it from
    // `ancestorChain[0]`, the Organisation), so unlike `color`/
    // `callsign_name_format` it needs no inheritance-copy or
    // cascade-to-descendants -- a Sub_Team's own stored value is simply
    // always NULL and never consulted.
    let { callsign_team_hyphenated } = teamData;

    // Requirement 2.2/2.3: compute the Team_Depth this Sub_Team would
    // occupy (the parent's Team_Depth plus one), or 0 for a root
    // Organisation, BEFORE attempting any INSERT. This guard is
    // deliberately OUTSIDE the try/catch below, so a TeamDepthExceededError
    // is never caught and swallowed by that catch block's
    // fallback-to-basic-creation behaviour -- it always propagates
    // distinctly to the caller.
    const targetDepth = parent_team_id
      ? (await this.getTeamDepth(parent_team_id)) + 1
      : 0;
    if (targetDepth > MAX_TEAM_DEPTH) {
      throw new TeamDepthExceededError();
    }

    // Requirement 3.2 (task 6.1): a Sub_Team's `color`/`callsign_name_format`
    // are always set to its ORGANISATION's current values -- not
    // necessarily its immediate parent's -- so this resolves the root
    // (depth 0) row of the Ancestor_Chain via `getAncestorChain`
    // (root-first ordering, per its own contract) rather than trusting
    // the immediate parent's own stored value to already be correct.
    // Any `color`/`callsign_name_format` value supplied on `teamData` is
    // silently overridden here, never rejected. This is deliberately
    // OUTSIDE the try/catch below for the same reason the depth guard is:
    // a failure resolving the Ancestor_Chain must propagate to the
    // caller, not be swallowed by the fallback-to-basic-creation catch.
    if (parent_team_id) {
      const ancestorChain = await this.getAncestorChain(parent_team_id);
      const organisation = ancestorChain[0];
      if (organisation) {
        color = organisation.color;
        callsign_name_format = organisation.callsign_name_format;

        // Org-wide-team-name-uniqueness feature: a Sub_Team's `name` must
        // be unique across its whole Organisation (the subtree under
        // `organisation.id`), not just under its immediate parent (which
        // is all the baseline `teams_name_parent_team_id_key` constraint
        // enforces). Otherwise two sub-teams under different parents in
        // the same org could both be "Auckland", producing two identical
        // "LSAR - Auckland" Display_Names. Checked here -- reusing the
        // Organisation already resolved for color/format inheritance --
        // and OUTSIDE the try/catch below so the typed
        // `TeamNameConflictError` propagates distinctly rather than being
        // swallowed by the fallback-to-basic-creation catch.
        await this.assertNameUniqueInOrganisation(organisation.id, name);
      }
    }

    // Requirement 5.1/5.2/5.3/5.6 (task 8.1): `callsign_level_selection`
    // is only ever stored on an Organisation row (`parent_team_id IS
    // NULL`) -- a Sub_Team's value is always `NULL`, and it is never
    // read at Sub_Team level (design.md's Data Models section). This
    // guard is deliberately OUTSIDE the try/catch below, for the same
    // reason the depth guard and Organisation-field-inheritance lookup
    // above are: a typed rejection here must propagate to the caller,
    // never be swallowed by the fallback-to-basic-creation catch.
    if (parent_team_id) {
      // Sub_Team: reject if the caller supplied a value at all (Requirement
      // 5.6). `undefined`/`null` means "not supplied" and is accepted
      // silently, always storing NULL.
      if (callsign_level_selection !== undefined && callsign_level_selection !== null) {
        throw new CallsignLevelSelectionSubTeamError();
      }
      callsign_level_selection = null;
    } else {
      // Organisation (root team): default to every Team_Depth position
      // 1..MAX_TEAM_DEPTH when omitted (Requirement 5.3); otherwise
      // validate every element is an integer in [1, MAX_TEAM_DEPTH]
      // (Requirement 5.1/5.2).
      if (callsign_level_selection === undefined || callsign_level_selection === null) {
        callsign_level_selection = Array.from({ length: MAX_TEAM_DEPTH }, (_, i) => i + 1);
      } else if (
        !Array.isArray(callsign_level_selection) ||
        !callsign_level_selection.every(
          (value) => Number.isInteger(value) && value >= 1 && value <= MAX_TEAM_DEPTH
        )
      ) {
        throw new CallsignLevelSelectionRangeError();
      }
    }

    // takserver-enrollment Requirement 6.1/6.2 (task 5.4):
    // `pseudonymous_usernames` is only ever stored on an Organisation row
    // (`parent_team_id IS NULL`) -- a Sub_Team's value is always `NULL`,
    // and a Sub_Team creation request that supplies one is a typed
    // rejection, exactly as `callsign_level_selection` already behaves.
    // This guard is deliberately OUTSIDE the try/catch below, for the
    // same reason the `callsign_level_selection` guard above is: a typed
    // rejection here must propagate to the caller, never be swallowed by
    // the fallback-to-basic-creation catch.
    if (parent_team_id) {
      // Sub_Team: reject if the caller supplied a value at all.
      // `undefined`/`null` means "not supplied" and is accepted
      // silently, always storing NULL.
      if (pseudonymous_usernames !== undefined && pseudonymous_usernames !== null) {
        throw new PseudonymousUsernamePolicySubTeamError();
      }
      pseudonymous_usernames = null;
    } else {
      // Organisation (root team): default to `false` when omitted
      // (Criterion 6.1 -- the migration itself deliberately carries no
      // column default, so the application supplies one here).
      if (pseudonymous_usernames === undefined || pseudonymous_usernames === null) {
        pseudonymous_usernames = false;
      } else {
        pseudonymous_usernames = Boolean(pseudonymous_usernames);
      }
    }

    // response_channel_access/support_channel_access: only ever stored on
    // an Organisation row (`parent_team_id IS NULL`) -- a Sub_Team's value
    // is always `NULL`, and a Sub_Team creation request that supplies
    // either is a typed rejection, exactly as `pseudonymous_usernames`
    // already behaves. Deliberately OUTSIDE the try/catch below, for the
    // same reason as every other Organisation-only guard above: a typed
    // rejection here must propagate to the caller, never be swallowed by
    // the fallback-to-basic-creation catch.
    if (parent_team_id) {
      if (response_channel_access !== undefined && response_channel_access !== null) {
        throw new ChannelTierAccessSubTeamError('responseChannelAccess');
      }
      if (support_channel_access !== undefined && support_channel_access !== null) {
        throw new ChannelTierAccessSubTeamError('supportChannelAccess');
      }
      response_channel_access = null;
      support_channel_access = null;
    } else {
      // Organisation (root team): the migration deliberately carries no
      // column default, so the application supplies one here.
      // response_channel_access defaults to `false` -- the Response/
      // Emergency_Response tier is ES-only and opt-in. support_channel_access
      // defaults to `true` -- the Support/outer tier is the all-agency
      // continuation of what the former single Region tier already did.
      response_channel_access = response_channel_access === undefined || response_channel_access === null
        ? false
        : Boolean(response_channel_access);
      support_channel_access = support_channel_access === undefined || support_channel_access === null
        ? true
        : Boolean(support_channel_access);
    }

    // Foreign_Partner Organisation country prefix feature: `country_code`
    // is only ever stored on an Organisation row (`parent_team_id IS
    // NULL`). A Sub_Team's value is always NULL, and a Sub_Team creation
    // request that supplies one is a typed rejection, exactly as
    // `pseudonymous_usernames`/`callsign_level_selection` already behave.
    // For an Organisation, a non-empty value must be a known ISO 3166-1
    // alpha-3 code and is normalised to upper-case; an empty/absent value
    // is a domestic Organisation (NULL). Deliberately OUTSIDE the
    // try/catch below, for the same reason as every other Organisation-only
    // guard: a typed rejection must propagate to the caller, never be
    // swallowed by the fallback-to-basic-creation catch.
    if (parent_team_id) {
      if (country_code !== undefined && country_code !== null && country_code !== '') {
        throw new CountryCodeSubTeamError();
      }
      country_code = null;
    } else {
      if (!isValidCountryCode(country_code)) {
        throw new CountryCodeInvalidError(country_code);
      }
      country_code = normaliseCountryCode(country_code);
    }

    // Callsign Team-segment separator toggle: only ever stored on an
    // Organisation row (`parent_team_id IS NULL`) -- a Sub_Team's value
    // is always `NULL`, and a Sub_Team creation request that supplies
    // one is a typed rejection, exactly as `pseudonymous_usernames`
    // already behaves. Deliberately OUTSIDE the try/catch below, for the
    // same reason as every other Organisation-only guard above.
    if (parent_team_id) {
      if (callsign_team_hyphenated !== undefined && callsign_team_hyphenated !== null) {
        throw new ChannelTierAccessSubTeamError('callsignTeamHyphenated');
      }
      callsign_team_hyphenated = null;
    } else {
      // Organisation (root team): default to `false` when omitted --
      // the migration deliberately carries no column default, so the
      // application supplies one here, mirroring
      // response_channel_access's own defaulting.
      callsign_team_hyphenated = callsign_team_hyphenated === undefined || callsign_team_hyphenated === null
        ? false
        : Boolean(callsign_team_hyphenated);
    }

    try {
      const result = await pool.query(
        'INSERT INTO teams (name, description, callsign_prefix, color, visibility, can_join, parent_team_id, created_by, callsign_name_format, callsign_level_selection, pseudonymous_usernames, response_channel_access, support_channel_access, country_code, callsign_team_hyphenated) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *',
        [name, description, callsign_prefix, color, visibility, can_join, parent_team_id, created_by, callsign_name_format, callsign_level_selection, pseudonymous_usernames, response_channel_access, support_channel_access, country_code, callsign_team_hyphenated]
      );
      
      const team = result.rows[0];
      
      // Auto-create team channel. `deferGroupCreation` is threaded
      // through so a bulk import routes the Authentik group create onto
      // the sync worker rather than blocking this call (the 504 fix).
      await this.createTeamChannel(team.id, { deferGroupCreation });

      // Requirement 2.1/2.6/9.1 (task 6.1): enqueue a CloudTAK_Group
      // creation Sync_Operation for the newly created Team (root
      // Organisation or Sub_Team, identically). Guarded by
      // isCloudTakEnabled() so nothing is enqueued while the integration
      // is off (Requirement 1.4). Team.create does NOT run inside an
      // explicit transaction for the INSERT (design.md "Exact enqueue
      // points" #1), so this enqueues on the default pool (no client).
      // A transient enqueue failure must never fail the whole team
      // creation -- a Team with no group is self-healed by the backfill
      // and by any later update -- so this is wrapped in its own
      // try/catch that logs and does NOT rethrow.
      if (isCloudTakEnabled()) {
        try {
          await EventPublisher.publishOperation(
            'create_cloudtak_group',
            { team_id: team.id },
            created_by || null
          );
        } catch (enqueueError) {
          logger.error({ err: enqueueError, teamId: team.id }, 'Error enqueuing create_cloudtak_group');
        }
      }

      return team;
    } catch (error) {
      // Bugfix (callsign-handling): a duplicate `callsign_prefix` used to
      // fall straight into the generic "new columns don't exist" fallback
      // below, which silently created the team WITHOUT a prefix at all
      // rather than surfacing the conflict -- a bulk import or a create
      // request hitting a real collision got an apparently-successful
      // 201 whose resulting Organisation had no Organisation_Prefix,
      // discovered only much later when Managed_Identifier minting failed
      // for a wholly unrelated reason. Checked and thrown BEFORE the
      // fallback, mirroring `Team.update`'s own `23505`-on-
      // `idx_teams_callsign_prefix` -> `CallsignPrefixConflictError`
      // translation exactly, so both entry points behave identically.
      if (error.code === '23505' && error.constraint === 'idx_teams_callsign_prefix') {
        throw new CallsignPrefixConflictError(callsign_prefix);
      }
      logger.error({ err: error }, 'Error creating team');
      // Fallback to basic creation if new columns don't exist
      const result = await pool.query(
        'INSERT INTO teams (name, description, parent_team_id, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, description, parent_team_id, created_by]
      );
      return result.rows[0];
    }
  }

  static async findById(id) {
    const result = await pool.query('SELECT * FROM teams WHERE id = $1', [id]);
    return result.rows[0];
  }

  /**
   * Bugfix (Sub-teams tab consistency with the /teams overview): also
   * returns `admin_count`, `device_count` and `channel_count` -- the
   * SAME four stat columns (alongside the pre-existing `member_count`/
   * `sub_teams_count`) the /teams overview table already shows for
   * every Team, per `getOrganisationTeams`/`getAllTeams` above. Mirrors
   * their `admin_count`/`device_count` subqueries exactly (role =
   * 'admin' direct-membership count; direct, non-inherited
   * Team_Owned_Device count), and adds a `channel_count` neither of
   * those two methods needed before now -- a straightforward
   * `COUNT(*) FROM channels WHERE channels.team_id = t.id`, matching
   * `Channel.getChannelCount`'s own query shape.
   */
  static async getSubTeams(parentId) {
    const result = await pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM team_memberships tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = t.id AND u.is_team_device IS NOT TRUE) as member_count,
        (SELECT COUNT(*) FROM team_memberships tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = t.id AND tm.role = 'admin' AND u.is_team_device IS NOT TRUE) as admin_count,
        (SELECT COUNT(*) FROM team_memberships tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = t.id AND tm.inherited_from_team_id IS NULL AND u.is_team_device = true) as device_count,
        (SELECT COUNT(*) FROM channels c WHERE c.team_id = t.id) as channel_count,
        (SELECT COUNT(*) FROM teams t2 WHERE t2.parent_team_id = t.id) as sub_teams_count,
          EXISTS(SELECT 1 FROM signup_codes sc WHERE sc.team_id = t.id) as has_signup_code
      FROM teams t
      WHERE t.parent_team_id = $1
    `, [parentId]);
    return result.rows;
  }

  static async getTeamHierarchy(teamId) {
    const result = await pool.query(`
      WITH RECURSIVE team_hierarchy AS (
        SELECT id, name, parent_team_id, 0 as level
        FROM teams WHERE id = $1
        UNION ALL
        SELECT t.id, t.name, t.parent_team_id, th.level + 1
        FROM teams t
        JOIN team_hierarchy th ON t.parent_team_id = th.id
      )
      SELECT * FROM team_hierarchy ORDER BY level
    `, [teamId]);
    return result.rows;
  }

  /**
   * Requirement 2.1 (design.md's shared ancestor-chain utility): returns
   * the given Team's Ancestor_Chain -- every Team from its Organisation
   * (root, `parent_team_id IS NULL`) down to and including the given Team
   * itself -- ordered ROOT-FIRST, each row carrying `id`, `name`,
   * `callsign_prefix`, `color`, `callsign_name_format`, `visibility`,
   * `parent_team_id`, `pseudonymous_usernames`, `response_channel_access`,
   * `support_channel_access`, and `depth` (0 at the Organisation,
   * incrementing by one per level down to the given Team).
   *
   * region-channel-tiers: `response_channel_access`/`support_channel_access`
   * are included for the same reason `pseudonymous_usernames` is (see
   * below) -- `syncWorker.assignUserToGlobalChannels` reads both from
   * index 0 (the Organisation) of this same call to decide Response/
   * Support region-channel membership; on every other row both are
   * always `NULL` (Sub_Teams never carry a value) and must never be read
   * positionally from the tail.
   *
   * takserver-enrollment Requirement 6.7 (task 5.1): `pseudonymous_usernames`
   * is included so `UserProvisioningService.resolveNewUserIdentity` can read
   * the Pseudonymous_Username_Policy from this same single call -- index 0
   * (the Organisation) is the only row where the value is authoritative; on
   * every other row it is always `NULL` (Sub_Teams never carry a value) and
   * must never be read positionally from the tail.
   *
   * Implemented as a single recursive CTE that walks UPWARD from `teamId`
   * (counting `hops_from_target`, which is easy to compute without knowing
   * the chain's total length in advance), then re-derives the root-first
   * `depth` value from that hop count in the final SELECT
   * (`MAX(hops_from_target) - hops_from_target`), per design.md.
   *
   * This is the shared primitive every other Ancestor_Chain-based
   * consumer (Team_Admin inheritance, Max_Team_Depth enforcement,
   * Organisation-only field inheritance, the Callsign_Generator, and
   * Visible_Branch resolution) is built on top of, rather than each
   * repeating its own recursive CTE.
   *
   * @param {number|string} teamId
   * @returns {Promise<Array<object>>} root-first ancestor chain rows.
   */
  static async getAncestorChain(teamId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_team_id, name, callsign_prefix, color,
                 callsign_name_format, visibility, callsign_level_selection,
                 pseudonymous_usernames, response_channel_access, support_channel_access,
                 country_code, callsign_team_hyphenated,
                 0 AS hops_from_target
          FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.parent_team_id, t.name, t.callsign_prefix, t.color,
                 t.callsign_name_format, t.visibility, t.callsign_level_selection,
                 t.pseudonymous_usernames, t.response_channel_access, t.support_channel_access,
                 t.country_code, t.callsign_team_hyphenated,
                 a.hops_from_target + 1
          FROM teams t JOIN ancestors a ON t.id = a.parent_team_id
        )
        SELECT id, parent_team_id, name, callsign_prefix, color,
               callsign_name_format, visibility, callsign_level_selection,
               pseudonymous_usernames, response_channel_access, support_channel_access,
               country_code, callsign_team_hyphenated,
               (SELECT MAX(hops_from_target) FROM ancestors) - hops_from_target AS depth
        FROM ancestors ORDER BY depth ASC
      `, [teamId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error fetching ancestor chain');
      throw error;
    }
  }

  /**
   * The canonical Team Display_Name: `<Organisation prefix> - <team name>`
   * for a Sub_Team, or the bare `name` for an Organisation (root) team.
   *
   * This is the SAME rule the SQL `display_name` columns already encode
   * (`getOrganisationTeams`, `getJoinableTeams`, `GET /api/users`'
   * `team_name`, `SignupFlowService`): the prefix segment is the ROOT
   * Organisation's `callsign_prefix` (falling back to its `name`), NOT the
   * concatenation of every ancestor's prefix. So a deeply nested team
   * FENZ > Te Kei (TEKE) > Southland (STL) > Manapouri renders as
   * "FENZ - Manapouri", never "FENZ - TEKE - STL - Manapouri".
   *
   * Provided as a reusable method (rather than re-deriving the path inline)
   * so the notification emails -- which previously built a full
   * ancestor-prefix path by hand and got this wrong -- share one
   * authoritative implementation with the display surfaces.
   *
   * Resolves the chain via `getAncestorChain` (ROOT-FIRST, per its
   * contract): index 0 is the Organisation, the last row is `teamId`
   * itself. Returns `null` if the team can't be resolved, so a caller can
   * fall back to whatever name it already has.
   *
   * @param {number|string} teamId
   * @returns {Promise<string|null>} the Display_Name, or null if not found.
   */
  static async getDisplayName(teamId) {
    const chain = await this.getAncestorChain(teamId);
    if (!chain || chain.length === 0) {
      return null;
    }
    const organisation = chain[0];
    const team = chain[chain.length - 1];
    // Organisation (root) team: bare name, no prefix. A single-element
    // chain means teamId IS the Organisation.
    if (chain.length === 1 || !team.parent_team_id) {
      return team.name;
    }
    const orgLabel = organisation.callsign_prefix || organisation.name || '';
    return `${orgLabel} - ${team.name}`;
  }

  /**
   * Requirement 2.1: the depth-only sibling of `getAncestorChain` -- the
   * given Team's Team_Depth (0 at its Organisation, incrementing by one
   * per level down to the given Team), computed directly rather than by
   * calling `getAncestorChain` and reading the last row's `depth`, for
   * efficiency (a single scalar `MAX(hops_from_target)` rather than every
   * ancestor's full row).
   *
   * @param {number|string} teamId
   * @returns {Promise<number>} the given Team's Team_Depth.
   */
  static async getTeamDepth(teamId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_team_id, 0 AS hops_from_target
          FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.parent_team_id, a.hops_from_target + 1
          FROM teams t JOIN ancestors a ON t.id = a.parent_team_id
        )
        SELECT MAX(hops_from_target) AS depth FROM ancestors
      `, [teamId]);
      return parseInt(result.rows[0]?.depth, 10);
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error fetching team depth');
      throw error;
    }
  }

  /**
   * Org-wide-team-name-uniqueness feature: throws `TeamNameConflictError`
   * if `name` is already used by ANY team in the Organisation rooted at
   * `organisationId` -- the whole subtree under that root, spanning every
   * `parent_team_id` -- OTHER than `excludeTeamId` (the team being
   * updated, so it never conflicts with itself). Case-sensitive, matching
   * the baseline `teams_name_parent_team_id_key` constraint.
   *
   * A single recursive CTE walks DOWNWARD from `organisationId` (the
   * Organisation root) collecting every descendant team id, then checks
   * for a name collision within that set. Bounded by the Organisation's
   * total Team count, never large. Called from `Team.create`/
   * `Team.update` BEFORE the write, so the typed error propagates
   * distinctly rather than surfacing as a raw constraint 500 or being
   * swallowed by the fallback-to-basic-creation path.
   *
   * @param {number|string} organisationId - the Organisation root id
   *   (a `parent_team_id IS NULL` team). Resolve it via
   *   `getAncestorChain(parentId)[0].id` (or the team's own id when
   *   creating/keeping a root Organisation).
   * @param {string} name - the candidate team name.
   * @param {number|string|null} [excludeTeamId] - a team id to exclude
   *   from the collision check (the team being updated). Omitted/null
   *   for a create.
   * @throws {TeamNameConflictError} on a collision.
   * @returns {Promise<void>}
   */
  static async assertNameUniqueInOrganisation(organisationId, name, excludeTeamId = null) {
    const result = await pool.query(
      `WITH RECURSIVE org_subtree AS (
         SELECT id, name, parent_team_id FROM teams WHERE id = $1
         UNION ALL
         SELECT t.id, t.name, t.parent_team_id
         FROM teams t JOIN org_subtree s ON t.parent_team_id = s.id
       )
       SELECT id FROM org_subtree
       WHERE name = $2 AND ($3::int IS NULL OR id <> $3)
       LIMIT 1`,
      [organisationId, name, excludeTeamId != null ? excludeTeamId : null]
    );
    if (result.rows.length > 0) {
      throw new TeamNameConflictError(name);
    }
  }

  /**
   * Requirement 5.8-5.11 (task 8.3): returns, for the given Organisation's
   * whole hierarchy, ONE flat row per (Team_Depth, `callsign_prefix`)
   * pair present among that Organisation's Sub_Teams at Team_Depth 1
   * through `MAX_TEAM_DEPTH`, e.g.:
   * `[{ team_depth: 1, callsign_prefix: 'CB' }, { team_depth: 1, callsign_prefix: 'AUK' }, ...]`.
   *
   * This is the data source for the Client's Callsign_Level_Selection
   * toggle labels (design.md's "Callsign_Level_Selection toggle-labelling
   * query"): the Client -- not this method -- groups these rows by
   * `team_depth`, de-duplicates `callsign_prefix` values per depth, sorts
   * them, and applies the "up to 3 examples, then an ellipsis" truncation
   * (Requirement 5.10) purely in rendering code. This method deliberately
   * returns every distinct prefix per depth, un-grouped and un-truncated
   * -- bounded only by the Organisation's total Team count, never large.
   *
   * Implemented as a single recursive CTE walking DOWNWARD from
   * `organisationId` (the opposite direction from `getAncestorChain`/
   * `getTeamDepth`, which walk upward from a descendant), numbering
   * `team_depth` directly from 0 at `organisationId` itself. `$2` is
   * `MAX_TEAM_DEPTH` (imported at the top of this file), not a hardcoded
   * `5`, so the query stays bounded by the single shared constant.
   * Team_Depth 0 (the Organisation's own row) is excluded from the
   * result, since Requirement 5.7 never renders a toggle for it, and a
   * row is only included when its `callsign_prefix` is non-null and
   * non-empty.
   *
   * @param {number|string} organisationId
   * @returns {Promise<Array<{team_depth: number, callsign_prefix: string}>>}
   */
  static async getSubTeamsForCallsignLevel(organisationId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE tree AS (
          SELECT id, callsign_prefix, 0 AS team_depth FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.callsign_prefix, tr.team_depth + 1
          FROM teams t JOIN tree tr ON t.parent_team_id = tr.id
        )
        SELECT team_depth, callsign_prefix FROM tree
        WHERE team_depth BETWEEN 1 AND $2 AND callsign_prefix IS NOT NULL AND callsign_prefix != ''
      `, [organisationId, MAX_TEAM_DEPTH]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, organisationId }, 'Error fetching sub-teams for callsign level');
      throw error;
    }
  }

  /**
   * Requirement 6.6 (task 14.3): returns every Team belonging to the
   * given Organisation's hierarchy (the Organisation's own row plus
   * every descendant Team at any depth), as a flat list of full `teams`
   * rows (every column, including `visibility` and `parent_team_id`),
   * for `GET /api/teams/my-teams?scope=organisation` to hand to
   * `TeamVisibilityService.filterVisibleBranches`.
   *
   * Walks DOWNWARD from `organisationId` (the opposite direction from
   * `getAncestorChain`, which walks upward from a descendant), mirroring
   * `getTeamHierarchy`'s own recursive-CTE shape but selecting every
   * column (`t.*`) rather than only `id`/`name`/`parent_team_id`/`level`,
   * since `filterVisibleBranches` needs `visibility` on every row and
   * this route's response is expected to carry full Team rows,
   * consistent with every other Team list endpoint. Deliberately a NEW
   * method rather than an extension of `getTeamHierarchy`'s own existing
   * SELECT, so `getTeamHierarchy`'s other caller (`GET /:teamId/hierarchy`,
   * which expects its current narrower shape) is never affected.
   *
   * @param {number|string} organisationId
   * @returns {Promise<Array<object>>} every Team in the Organisation's
   *   hierarchy (the Organisation's own row plus every descendant), in
   *   no particular guaranteed order.
   */
  static async getOrganisationTeams(organisationId, userId = null) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE org_hierarchy AS (
          SELECT * FROM teams WHERE id = $1
          UNION ALL
          SELECT t.* FROM teams t
          JOIN org_hierarchy oh ON t.parent_team_id = oh.id
        )
        SELECT oh.*,
          (SELECT COUNT(*) FROM team_memberships tm
           JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = oh.id AND u.is_team_device IS NOT TRUE) as member_count,
          -- /teams overview: admin_count, matching what THIS team's own
          -- Team Admins tab counts (TeamDetail.jsx's admins state,
          -- Team.getMembers(teamId) rows filtered to role === 'admin').
          -- An inherited team_memberships row is always written with the
          -- literal role 'inherited' (TeamMembershipService.addUserToTeam),
          -- never the original 'admin'/'member' -- so role = 'admin' on
          -- THIS team's own rows is already exactly the direct-admin count,
          -- with no separate inherited_from_team_id filter needed.
          (SELECT COUNT(*) FROM team_memberships tm
           JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = oh.id AND tm.role = 'admin' AND u.is_team_device IS NOT TRUE) as admin_count,
          -- /teams overview: device_count, matching what THIS team's own
          -- Team Devices tab counts (DeviceEnrollmentService.listTeamDevices'
          -- inherited_from_team_id IS NULL AND is_team_device = true
          -- filter) -- a device belongs directly to exactly one team, so
          -- only its direct row is counted here, not the 'inherited' rows
          -- materialised on ancestor teams.
          (SELECT COUNT(*) FROM team_memberships tm
           JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = oh.id AND tm.inherited_from_team_id IS NULL AND u.is_team_device = true) as device_count,
          (SELECT COUNT(*) FROM teams t2 WHERE t2.parent_team_id = oh.id) as sub_teams_count,
          COALESCE(
            (SELECT tm.role FROM team_memberships tm
             WHERE tm.team_id = oh.id AND tm.user_id = $2
             AND tm.inherited_from_team_id IS NULL
             LIMIT 1),
            (SELECT 'inherited' FROM team_memberships tm
             WHERE tm.team_id = oh.id AND tm.user_id = $2
             AND tm.inherited_from_team_id IS NOT NULL
             LIMIT 1)
          ) as role,
          -- Team Display_Name (bugfix: consistent "<Org prefix> - <team
          -- name>" everywhere). Every row in this CTE descends from the
          -- single Organisation root ($1), so the Organisation's own
          -- prefix/name -- looked up once from that root row -- is the
          -- correct prefix for EVERY Sub_Team here, matching the
          -- ancestor-chain-root rule the other display_name query sites
          -- (Team.getJoinableTeams, SignupFlowService.getAvailableTeams,
          -- GET /users/me) already use. The Organisation's own row shows
          -- its bare name (no prefix), same as those sites. This lets the
          -- Users Create-User picker and the Transfer dialog's source-
          -- team heading show the same Display_Name /request-access does,
          -- rather than falling back to the bare team name.
          CASE
            WHEN oh.parent_team_id IS NOT NULL THEN
              COALESCE(
                (SELECT COALESCE(org.callsign_prefix, org.name, '') FROM teams org WHERE org.id = $1),
                ''
              ) || ' - ' || oh.name
            ELSE oh.name
          END as display_name
        FROM org_hierarchy oh
        ORDER BY oh.name
      `, [organisationId, userId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, organisationId }, 'Error fetching organisation teams');
      throw error;
    }
  }

  static async addMember(teamId, userId, role = 'member') {
    // Data-corruption bugfix: reject BEFORE the upsert below when
    // `userId`'s existing row for `teamId` (if any) is inherited. See
    // `InheritedMembershipPromotionError`'s own doc comment for the full
    // rationale. A user with no existing row at all for this team (the
    // ordinary "add a new member" case) has nothing here to match, so
    // this check is a no-op for that case.
    const existingResult = await pool.query(
      'SELECT inherited_from_team_id FROM team_memberships WHERE user_id = $1 AND team_id = $2',
      [userId, teamId]
    );
    if (existingResult.rows[0] && existingResult.rows[0].inherited_from_team_id != null) {
      throw new InheritedMembershipPromotionError(teamId, userId);
    }

    try {
      const result = await pool.query(
        'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, team_id) DO UPDATE SET role = $3 RETURNING *',
        [teamId, userId, role]
      );
      // Requirement 5.1/5.2/5.3 (task 8.1): re-reconcile the Team's CloudTAK
      // group membership after any direct-admin add/promote/demote. This single
      // upsert site covers all three cases (design "Exact enqueue points" #4).
      // Non-transactional (default pool) and non-rethrowing so a queue failure
      // never breaks membership changes.
      if (isCloudTakEnabled()) {
        try {
          // Coerce to a number: the `update_cloudtak_group` payload schema
          // requires `team_id: 'number'`, but this method is reached from
          // routes that pass `req.params.teamId` (always a STRING). A string
          // here enqueues `{ team_id: "3" }`, which then fails payload
          // validation at dequeue as a PERMANENT `validation` failure -- the
          // op never runs and sits `failed` forever (this is exactly the
          // batch of failed update_cloudtak_group ops found in the queue).
          await EventPublisher.publishOperation('update_cloudtak_group', { team_id: Number(teamId) }, null);
        } catch (enqueueError) {
          logger.error({ err: enqueueError, teamId }, 'Error enqueuing update_cloudtak_group');
        }
      }
      return result.rows[0];
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error adding team member');
      // Fallback to basic membership without role if column doesn't exist
      const result = await pool.query(
        'INSERT INTO team_memberships (team_id, user_id) VALUES ($1, $2) RETURNING *',
        [teamId, userId]
      );
      return result.rows[0];
    }
  }

  /**
   * Requirement 11.14, 13.1 (task 21.1): every direct + inherited
   * member/admin of `teamId`, for both the Client's Member_List display
   * (Requirement 13.1, hence the explicit `u.callsign_suffix`/`u.tak_role`
   * columns alongside `u.*`) and the `callsign_suffix` per-Team
   * uniqueness check (Requirement 11.14, via `getFullMemberList` below).
   * `u.callsign_suffix`/`u.tak_role` are re-listed explicitly here (even
   * though `u.*` already includes them) so this query's contract with
   * its callers -- both of whom depend on these two columns being
   * present -- stays visible at a glance and isn't silently broken by a
   * future change to `u.*`'s column set.
   */
  static async getMembers(teamId) {
    try {
      // Get members including inherited memberships
      const result = await pool.query(`
        SELECT u.*, u.callsign_suffix, u.tak_role, tm.role, tm.inherited_from_team_id,
               uc.tak_callsign,
               CASE 
                 WHEN tm.inherited_from_team_id IS NOT NULL THEN t.name
                 ELSE NULL
               END as inherited_from_team_name
        FROM users u 
        JOIN team_memberships tm ON u.id = tm.user_id 
        LEFT JOIN teams t ON tm.inherited_from_team_id = t.id
        LEFT JOIN user_cache uc ON u.authentik_user_id::text = uc.authentik_id::text
        WHERE tm.team_id = $1
        ORDER BY tm.role DESC, u.first_name, u.last_name
      `, [teamId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error fetching team members with users table');
      try {
        // Fallback to just team memberships
        const result = await pool.query(`
          SELECT tm.user_id as id, tm.role, tm.inherited_from_team_id,
                 tm.user_id::text as first_name, 
                 '' as last_name, 
                 tm.user_id::text || '@example.com' as email,
                 NULL as inherited_from_team_name
          FROM team_memberships tm 
          WHERE tm.team_id = $1
        `, [teamId]);
        return result.rows;
      } catch (fallbackError) {
        logger.error({ err: fallbackError, teamId }, 'Error in fallback team members query');
        return [];
      }
    }
  }

  /**
   * Requirement 11.14, 13.1 (task 21.1): a deliberate ALIAS of
   * `getMembers`, not a separate implementation -- design.md's "Shared
   * Member_List roster query" section requires this to be exactly
   * today's `getMembers(teamId)` result, reused verbatim. Used by both
   * the Client's Member_List view (Requirement 13.1) and every
   * `callsign_suffix` per-Team uniqueness check (Requirement
   * 11.14-11.18): callers compare a candidate `callsign_suffix` value
   * case-insensitively against every returned row's `callsign_suffix`
   * (excluding the row being edited, for an update). Given a second name
   * here purely to make that dual use explicit at call sites -- no new
   * query is introduced.
   *
   * @param {number|string} teamId
   * @returns {Promise<Array<object>>} identical to `getMembers(teamId)`.
   */
  static async getFullMemberList(teamId) {
    return this.getMembers(teamId);
  }

  /**
   * Requirement 4.1-4.3 (task 3.1): a user is a Team_Admin of `teamId` if
   * they hold a direct (non-inherited, `inherited_from_team_id IS NULL`)
   * `role = 'admin'` `team_memberships` row for `teamId` itself, OR for
   * any Team in `teamId`'s Ancestor_Chain. Computed at check time via a
   * self-contained recursive CTE walking upward from `teamId` (the
   * `ancestors` CTE here includes `id = $1`, i.e. the team itself, so no
   * separate "check the team itself" branch is needed).
   *
   * This is a deliberately minimal, standalone CTE (only `id`/
   * `parent_team_id`) rather than a reuse of `getAncestorChain`, per
   * design.md -- it only needs to know WHICH teams are ancestors, not any
   * of their other columns, and this is the single most frequently called
   * authorization check in the app.
   *
   * `tm.role = 'admin' AND tm.inherited_from_team_id IS NULL` matches
   * only a DIRECT admin row on an ancestor -- this is independent of, and
   * does not modify, the pre-existing `inherited_from_team_id` upward
   * membership-inheritance mechanism (Requirement 4.4).
   *
   * Every existing caller continues to call `Team.isAdmin(teamId, userId)`
   * exactly as before and transparently receives inherited-admin
   * behaviour (Requirement 4.3).
   *
   * @param {number|string} teamId
   * @param {number|string} userId
   * @returns {Promise<boolean>}
   */
  static async isAdmin(teamId, userId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE ancestors AS (
          SELECT id, parent_team_id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, t.parent_team_id FROM teams t
          JOIN ancestors a ON t.id = a.parent_team_id
        )
        SELECT 1 FROM team_memberships tm
        JOIN ancestors a ON tm.team_id = a.id
        WHERE tm.user_id = $2 AND tm.role = 'admin' AND tm.inherited_from_team_id IS NULL
        LIMIT 1
      `, [teamId, userId]);
      return result.rows.length > 0;
    } catch (error) {
      logger.error({ err: error, teamId, userId }, 'Error checking admin status');
      return false;
    }
  }

  /**
   * Users-page-action-parity: the SET of every `teams.id` that `userId`
   * may act on as a Team_Admin -- every team they hold a DIRECT
   * (`inherited_from_team_id IS NULL`) `role = 'admin'` row on, UNION
   * every DESCENDANT of each of those teams at any depth. This is the
   * downward-facing counterpart of `isAdmin` above (which walks UPWARD
   * from a single `teamId` to answer "is userId an admin of teamId or one
   * of its ancestors"): this method walks DOWNWARD from userId's admin
   * teams to answer "which teams, in total, can userId act on".
   *
   * `isAdmin(teamId, userId)` and `getManagedTeamIds(userId).has(teamId)`
   * are DEFINITIONALLY equivalent for any given `teamId` -- both encode
   * "an admin of an ancestor may act on a descendant" -- so a caller with
   * many rows to check (e.g. `GET /api/users` gating each row's
   * `can_manage`) should call this ONCE and test membership in the
   * returned Set, rather than calling `isAdmin` per row (which would
   * re-run the recursive walk once per row instead of once per request).
   *
   * No existing helper already returns this: `DeviceManagementService
   * .isManagedUser` answers a per-user existence question via a
   * materialized-inherited-row join rather than building an explicit team
   * set at all, which is deliberately NARROWER than "every team
   * `Team.isAdmin` would say yes to" and so is not reused here.
   *
   * @param {number|string} userId
   * @returns {Promise<Set<number>>} every managed team id, `teamId`s as
   *   returned by Postgres (numbers). Empty for a user with no direct
   *   admin row anywhere.
   */
  static async getManagedTeamIds(userId) {
    try {
      const result = await pool.query(`
        WITH RECURSIVE admin_teams AS (
          SELECT team_id
          FROM team_memberships
          WHERE user_id = $1 AND role = 'admin' AND inherited_from_team_id IS NULL
        ), managed_teams AS (
          SELECT team_id FROM admin_teams
          UNION
          SELECT t.id AS team_id
          FROM teams t
          JOIN managed_teams mt ON t.parent_team_id = mt.team_id
        )
        SELECT team_id FROM managed_teams
      `, [userId]);
      return new Set(result.rows.map((row) => row.team_id));
    } catch (error) {
      logger.error({ err: error, userId }, 'Error resolving managed team ids');
      // Fail closed: an empty set denies every row's can_manage rather
      // than a thrown error propagating as a 500 for the whole listing,
      // matching isAdmin's own fail-closed `catch` above.
      return new Set();
    }
  }

  // Requirement 27.9 (task 49.5): `member_count` here is a dashboard-style
  // member count displayed on the Teams/TeamDetail pages, so it must
  // exclude Team_Owned_Device rows (`users.is_team_device = true`) the
  // same way `GET /api/users` does -- a device should never inflate a
  // displayed member count. The subquery joins `team_memberships` ->
  // `users` (on `user_id`) to reach `is_team_device`, using `IS NOT TRUE`
  // (rather than `= false`) so a NULL `is_team_device` value -- which
  // should never occur given the column's `NOT NULL DEFAULT false`
  // migration, but also matches how boolean flags are treated elsewhere
  // in this codebase, e.g. `Channel.getChannelCount`/`is_active` checks
  // that never need to special-case NULL -- is still counted as "not a
  // device" rather than excluded by a stricter `= false` comparison that
  // would silently drop an unexpected NULL row.
  static async getUserTeams(userId) {
    try {
      const result = await pool.query(`
        SELECT t.*, tm.role, 
          (SELECT COUNT(*) FROM team_memberships tm2
           JOIN users u2 ON u2.id = tm2.user_id
           WHERE tm2.team_id = t.id AND u2.is_team_device IS NOT TRUE) as member_count
        FROM teams t
        LEFT JOIN team_memberships tm ON t.id = tm.team_id AND tm.user_id = $1
        WHERE tm.user_id IS NOT NULL
        ORDER BY t.name
      `, [userId]);
      return result.rows;
    } catch (error) {
      logger.error({ err: error, userId }, 'Error fetching user teams');
      return [];
    }
  }

  // Requirement 11.4: pagination for the admin "all teams" case of
  // `GET /api/teams/my-teams`. `limit`/`offset` are optional so that any
  // other caller of `getAllTeams()` (there are none elsewhere in the
  // codebase today, per a repo-wide grep) keeps the original unbounded
  // behavior by simply omitting them.
  //
  // Requirement 27.9 (task 49.5): `member_count` here is the same
  // dashboard-style column as `getUserTeams` above and gets the identical
  // `is_team_device IS NOT TRUE` exclusion, for the same reason.
  // `sub_teams_count` counts `teams` rows, not users, and is intentionally
  // left unchanged.
  static async getAllTeams(limit, offset) {
    try {
      const hasPagination = Number.isInteger(limit) && Number.isInteger(offset);
      const query = `
        SELECT t.*, 'admin' as role,
          (SELECT COUNT(*) FROM team_memberships tm
           JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = t.id AND u.is_team_device IS NOT TRUE) as member_count,
          -- /teams overview: same admin_count/device_count columns as
          -- getOrganisationTeams above, for the Global_Manager "all teams"
          -- branch of GET /api/teams/my-teams.
          (SELECT COUNT(*) FROM team_memberships tm
           JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = t.id AND tm.role = 'admin' AND u.is_team_device IS NOT TRUE) as admin_count,
          (SELECT COUNT(*) FROM team_memberships tm
           JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = t.id AND tm.inherited_from_team_id IS NULL AND u.is_team_device = true) as device_count,
          (SELECT COUNT(*) FROM teams t2 WHERE t2.parent_team_id = t.id) as sub_teams_count,
          EXISTS(SELECT 1 FROM signup_codes sc WHERE sc.team_id = t.id) as has_signup_code
        FROM teams t
        ORDER BY t.name
        ${hasPagination ? 'LIMIT $1 OFFSET $2' : ''}
      `;
      const result = hasPagination
        ? await pool.query(query, [limit, offset])
        : await pool.query(query);
      return result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching all teams');
      return [];
    }
  }

  // Requirement 11.4: total team count, used alongside the paginated
  // `getAllTeams()` result to report pagination metadata.
  static async getTeamCount() {
    try {
      const result = await pool.query('SELECT COUNT(*) as count FROM teams');
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ err: error }, 'Error counting teams');
      return 0;
    }
  }

  static async update(teamId, updateData) {
    const { name, description, visibility, can_join, parent_team_id } = updateData;
    // Requirement 3.3 (task 6.1): `color`/`callsign_name_format` are
    // Organisation-only fields -- declared with `let` (not `const`)
    // because, when the team being updated is a Sub_Team, any
    // client-supplied value here is silently discarded (set to
    // `undefined`) below so the SQL's own `COALESCE(..., <column>)`
    // fallback preserves the Sub_Team's existing stored value unchanged,
    // rather than applying the supplied override. The request is NEVER
    // rejected for supplying these fields on a Sub_Team -- Requirement
    // 3.3 requires the value be ignored, not an error.
    let { color, callsign_name_format } = updateData;
    // Bugfix (callsign-handling): `callsign_prefix` is the OPPOSITE shape
    // from `color`/`callsign_name_format` above -- it is freely editable
    // on a Sub_Team (never ignored, never rejected) but IMMUTABLE on an
    // existing Organisation (a resubmission of the current value is
    // accepted as a no-op; any other value throws
    // `OrganisationCallsignPrefixImmutableError`, validated below).
    // Declared with `let` because a no-op resubmission on an Organisation
    // is normalised to `undefined` below, mirroring
    // `pseudonymous_usernames`'s own no-op handling exactly.
    let { callsign_prefix } = updateData;
    // Requirement 5.2/5.6 (task 8.1): `callsign_level_selection` is
    // validated/rejected below, before ever reaching the UPDATE.
    let { callsign_level_selection } = updateData;
    // takserver-enrollment Requirement 7.2/7.3 (task 5.4):
    // `pseudonymous_usernames` is validated/rejected below, before ever
    // reaching the UPDATE. Unlike `callsign_level_selection`, a value
    // supplied on an EXISTING Organisation is only ever a no-op
    // (resubmitting the currently-stored value) or a rejection -- there
    // is no "change" case that reaches the UPDATE at all.
    let { pseudonymous_usernames } = updateData;
    // response_channel_access/support_channel_access are validated/
    // rejected below, before ever reaching the UPDATE. Unlike
    // pseudonymous_usernames, a value supplied on an EXISTING Organisation
    // is simply APPLIED (no immutability guard, no no-op-only handling) --
    // flipping either flag only triggers Response/Support group-membership
    // reconciliation via the Sync_Worker, never an identifier/certificate
    // consequence.
    let { response_channel_access, support_channel_access } = updateData;
    // Foreign_Partner Organisation country prefix feature: `country_code`
    // is WRITE-ONCE on an Organisation -- exactly the same shape as
    // `callsign_prefix` above. A no-op resubmission of the current value
    // is accepted (normalised to `undefined` below so COALESCE leaves the
    // column untouched); any real change throws
    // `OrganisationCountryCodeImmutableError`. A Sub_Team never carries
    // one, so a value supplied on a Sub_Team update is a typed rejection.
    let { country_code } = updateData;
    // Callsign Team-segment separator toggle: rejected/ignored on a
    // Sub_Team exactly like response_channel_access/support_channel_access
    // below -- but UNLIKE country_code/callsign_prefix, freely APPLIED on
    // an existing Organisation with no immutability guard: it only
    // changes how the callsign is DISPLAYED going forward, never a
    // Managed_Identifier already minted.
    let { callsign_team_hyphenated } = updateData;

    // Requirement 3.3/5.6/7.2: determine whether `teamId` is a Sub_Team (a
    // non-null `parent_team_id`) BEFORE building the UPDATE, so the
    // ignore-on-Sub_Team behaviour (color/callsign_name_format) and the
    // reject-on-Sub_Team behaviour (callsign_level_selection,
    // pseudonymous_usernames) both apply regardless of whether this same
    // call is also moving the team to a new parent
    // (`updateData.parent_team_id`) -- the check is against the team's
    // CURRENT (pre-update) parent, consistent with `color`/
    // `callsign_name_format` already having been fixed to the
    // Organisation's value at creation time and only ever needing to be
    // ignored (never re-derived) on update. This single `findById` lookup
    // is reused for all these checks to avoid a duplicate query when
    // multiple Organisation-only fields are updated together.
    let existingTeam;
    if (
      color !== undefined ||
      callsign_name_format !== undefined ||
      callsign_level_selection !== undefined ||
      pseudonymous_usernames !== undefined ||
      callsign_prefix !== undefined ||
      response_channel_access !== undefined ||
      support_channel_access !== undefined ||
      country_code !== undefined ||
      callsign_team_hyphenated !== undefined
    ) {
      existingTeam = await this.findById(teamId);
    }

    if (existingTeam && existingTeam.parent_team_id !== null) {
      if (color !== undefined || callsign_name_format !== undefined) {
        color = undefined;
        callsign_name_format = undefined;
      }
      // Requirement 5.6: reject (never silently ignore) a
      // callsign_level_selection value supplied on a Sub_Team update --
      // this is deliberately OUTSIDE the try/catch below, for the same
      // reason as `Team.create`'s equivalent guard, so it always
      // propagates to the caller distinctly.
      if (callsign_level_selection !== undefined) {
        throw new CallsignLevelSelectionSubTeamError();
      }
      // Requirement 6.2: reject (never silently ignore) a
      // pseudonymous_usernames value supplied on a Sub_Team update,
      // mirroring callsign_level_selection's typed rejection exactly.
      if (pseudonymous_usernames !== undefined) {
        throw new PseudonymousUsernamePolicySubTeamError();
      }
      // response_channel_access/support_channel_access: reject (never
      // silently ignore) either value supplied on a Sub_Team update,
      // mirroring pseudonymous_usernames's typed rejection exactly.
      if (response_channel_access !== undefined) {
        throw new ChannelTierAccessSubTeamError('responseChannelAccess');
      }
      if (support_channel_access !== undefined) {
        throw new ChannelTierAccessSubTeamError('supportChannelAccess');
      }
      // Foreign_Partner country prefix: a country_code supplied on a
      // Sub_Team update is a typed rejection, mirroring the guards above.
      if (country_code !== undefined) {
        throw new CountryCodeSubTeamError();
      }
      // Callsign Team-segment separator toggle: a value supplied on a
      // Sub_Team update is a typed rejection, mirroring the guards above
      // (never silently ignored, unlike color/callsign_name_format).
      if (callsign_team_hyphenated !== undefined) {
        throw new ChannelTierAccessSubTeamError('callsignTeamHyphenated');
      }
    } else if (callsign_level_selection !== undefined && callsign_level_selection !== null) {
      // Organisation: validate every element is an integer in
      // [1, MAX_TEAM_DEPTH] (Requirement 5.2). `null` is accepted
      // (explicitly clearing the value); `undefined` means "not
      // supplied", handled below via COALESCE.
      if (
        !Array.isArray(callsign_level_selection) ||
        !callsign_level_selection.every(
          (value) => Number.isInteger(value) && value >= 1 && value <= MAX_TEAM_DEPTH
        )
      ) {
        throw new CallsignLevelSelectionRangeError();
      }
    }

    // takserver-enrollment Requirement 7.2/7.3 (task 5.4): the
    // Pseudonymous_Username_Policy is fixed at Organisation creation. A
    // request that supplies `pseudonymous_usernames` on an EXISTING
    // Organisation is accepted ONLY when the submitted value equals the
    // currently-stored one (a no-op, normalised to a boolean since the
    // stored column may be `false`/`true` and the request body may carry
    // either a boolean or a truthy/falsy equivalent) -- any other
    // submitted value is rejected, stating the concrete consequence
    // being prevented (Criterion 7.3) rather than merely citing a
    // policy. This check runs BEFORE the UPDATE, deliberately outside
    // the try/catch below, for the same reason every other typed
    // rejection in this method is: it must always propagate to the
    // caller distinctly, never be swallowed by a fallback path.
    if (
      existingTeam &&
      existingTeam.parent_team_id === null &&
      pseudonymous_usernames !== undefined
    ) {
      const storedValue = Boolean(existingTeam.pseudonymous_usernames);
      const submittedValue = Boolean(pseudonymous_usernames);
      if (submittedValue !== storedValue) {
        throw new PseudonymousUsernamePolicyImmutableError();
      }
      // A no-op resubmission of the current value: nothing to change,
      // so the UPDATE's own COALESCE below simply leaves the column
      // untouched. `undefined` here (rather than passing the boolean
      // through) keeps the UPDATE statement's COALESCE fallback
      // behaviour uniform with every other "not supplied" field.
      pseudonymous_usernames = undefined;
    }

    // response_channel_access/support_channel_access: freely mutable on
    // an existing Organisation, unlike pseudonymous_usernames -- no
    // no-op-only/immutability guard, just a boolean normalisation so the
    // UPDATE's COALESCE always receives a real boolean or `undefined`
    // ("not supplied"), never a truthy/falsy non-boolean equivalent.
    // `null` is accepted the same as `undefined` here (COALESCE would
    // otherwise store a literal NULL, re-introducing the Sub_Team-only
    // "not applicable" state on an Organisation row, which the migration's
    // own comment says should never happen once a row IS an Organisation).
    if (response_channel_access !== undefined) {
      response_channel_access = response_channel_access === null ? undefined : Boolean(response_channel_access);
    }
    if (support_channel_access !== undefined) {
      support_channel_access = support_channel_access === null ? undefined : Boolean(support_channel_access);
    }
    // Callsign Team-segment separator toggle: freely mutable on an
    // existing Organisation, exactly like response_channel_access/
    // support_channel_access above -- same `null` -> `undefined`
    // normalisation so COALESCE never re-introduces the Sub_Team-only
    // NULL state on an Organisation row.
    if (callsign_team_hyphenated !== undefined) {
      callsign_team_hyphenated = callsign_team_hyphenated === null ? undefined : Boolean(callsign_team_hyphenated);
    }

    // Bugfix (callsign-handling): an Organisation's `callsign_prefix` is
    // its Organisation_Prefix -- immutable after creation, because every
    // Managed_Identifier already minted under it is a fixed string
    // derived from this value (see `OrganisationCallsignPrefixImmutableError`'s
    // doc comment). A request that supplies `callsign_prefix` on an
    // EXISTING Organisation is accepted ONLY as a no-op resubmission of
    // the current value; any other value is a typed rejection, mirroring
    // `pseudonymous_usernames`'s handling immediately above exactly. A
    // SUB_TEAM's `callsign_prefix` is NOT covered by this guard at all --
    // it passes straight through to the UPDATE below, unrestricted,
    // which is the whole point of this fix (a Sub_Team's prefix can now
    // be corrected after creation, unlike an Organisation's).
    if (
      existingTeam &&
      existingTeam.parent_team_id === null &&
      callsign_prefix !== undefined
    ) {
      const storedPrefix = existingTeam.callsign_prefix || '';
      const submittedPrefix = typeof callsign_prefix === 'string' ? callsign_prefix.trim() : (callsign_prefix || '');
      if (submittedPrefix !== storedPrefix) {
        throw new OrganisationCallsignPrefixImmutableError();
      }
      // A no-op resubmission: nothing to change, so the UPDATE's own
      // COALESCE below simply leaves the column untouched.
      callsign_prefix = undefined;
    }

    // Foreign_Partner Organisation country prefix: `country_code` is
    // WRITE-ONCE on an existing Organisation, mirroring `callsign_prefix`
    // immediately above -- it is composed into the callsign, so changing
    // it (including setting one where there was none, or clearing one)
    // would orphan every identifier already minted. A no-op resubmission
    // of the current value is accepted (normalised to `undefined` so
    // COALESCE leaves the column untouched); any real change throws.
    // Comparison is on the NORMALISED (upper-case alpha-3, or null)
    // submitted value vs the stored value, so a case-only difference
    // ('fji' vs stored 'FJI') is correctly treated as a no-op, not a
    // change. A Sub_Team never reaches here (it was rejected above).
    if (
      existingTeam &&
      existingTeam.parent_team_id === null &&
      country_code !== undefined
    ) {
      // A non-empty submitted value must be a real ISO code before we can
      // even compare it -- an invalid value is a 400 (bad value), distinct
      // from the immutability rejection.
      if (country_code !== null && country_code !== '' && !isValidCountryCode(country_code)) {
        throw new CountryCodeInvalidError(country_code);
      }
      const storedCountry = existingTeam.country_code || null;
      const submittedCountry = normaliseCountryCode(country_code);
      if (submittedCountry !== storedCountry) {
        throw new OrganisationCountryCodeImmutableError();
      }
      // No-op resubmission: leave the column untouched via COALESCE.
      country_code = undefined;
    }

    // Org-wide-team-name-uniqueness feature: enforce that the team's
    // EFFECTIVE post-update name is unique across its EFFECTIVE
    // post-update Organisation -- covering both a plain rename and a
    // re-parent (moving a team into an org where the name already
    // exists). Runs BEFORE the UPDATE, deliberately outside the
    // try/catch below, so the typed `TeamNameConflictError` propagates
    // distinctly rather than surfacing as a raw constraint 500 or being
    // swallowed by a fallback path.
    //
    // Skipped entirely when neither `name` nor `parent_team_id` is being
    // touched (both `undefined`), since nothing that could introduce a
    // name collision is changing. A promotion-to-root
    // (`parent_team_id === null`) is also skipped here: the team becomes
    // its OWN Organisation, and a root-vs-root name collision is already
    // enforced by the baseline `teams_name_parent_team_id_key`
    // constraint (`UNIQUE (name, parent_team_id)` with
    // `parent_team_id IS NULL`), which surfaces via the existing
    // `23505` handling.
    if (name !== undefined || parent_team_id !== undefined) {
      if (!existingTeam) {
        existingTeam = await this.findById(teamId);
      }
      // The effective parent after this update: `parent_team_id` when
      // supplied (including `null` for promote-to-root), else the team's
      // current parent. Note `update`'s SQL sets `parent_team_id = $5`
      // directly (not COALESCE), so an omitted `parent_team_id` in
      // `updateData` means "keep current" only because the route always
      // re-sends the current value; resolve against `existingTeam` here
      // to be correct regardless of how the caller supplies it.
      const effectiveParentId = parent_team_id !== undefined
        ? parent_team_id
        : (existingTeam ? existingTeam.parent_team_id : null);
      const effectiveName = name !== undefined ? name : (existingTeam ? existingTeam.name : undefined);

      if (effectiveParentId != null && effectiveName !== undefined) {
        // Sub_Team (has, or is being moved under, a parent): resolve its
        // effective Organisation (the root of the effective parent's
        // ancestor chain) and check the name across that whole subtree,
        // excluding this team itself so a no-op rename never conflicts
        // with its own current row.
        const ancestorChain = await this.getAncestorChain(effectiveParentId);
        const organisation = ancestorChain[0];
        if (organisation) {
          await this.assertNameUniqueInOrganisation(organisation.id, effectiveName, teamId);
        }
      }
    }

    try {
      const result = await pool.query(
        'UPDATE teams SET name = COALESCE($1, name), description = COALESCE($2, description), visibility = COALESCE($3, visibility), can_join = COALESCE($4, can_join), parent_team_id = $5, callsign_name_format = COALESCE($6, callsign_name_format), color = COALESCE($8, color), callsign_level_selection = COALESCE($9, callsign_level_selection), pseudonymous_usernames = COALESCE($10, pseudonymous_usernames), callsign_prefix = COALESCE($11, callsign_prefix), response_channel_access = COALESCE($12, response_channel_access), support_channel_access = COALESCE($13, support_channel_access), country_code = COALESCE($14, country_code), callsign_team_hyphenated = COALESCE($15, callsign_team_hyphenated), updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *',
        [name, description, visibility, can_join, parent_team_id, callsign_name_format, teamId, color, callsign_level_selection, pseudonymous_usernames, callsign_prefix, response_channel_access, support_channel_access, country_code, callsign_team_hyphenated]
      );
      const updatedTeam = result.rows[0];

      // Bugfix (Requirement 3.2/3.3): a Sub_Team's `color`/
      // `callsign_name_format` is only ever COPIED from its
      // Organisation's then-current values at CREATION time
      // (`Team.create`'s ancestor-chain lookup above) -- it is never
      // re-read afterward. Without this cascade, changing an
      // Organisation's own `color`/`callsign_name_format` here would
      // only ever update the Organisation's own row, leaving every
      // already-created descendant Sub_Team's stored (denormalized)
      // value permanently stale -- exactly the reported bug ("the
      // sub-team's format does not update"). When the team just updated
      // is itself an Organisation (`parent_team_id IS NULL`, checked
      // against the POST-update row so a same-request re-parent to root
      // is also handled correctly) AND at least one of these two fields
      // was actually supplied on this update, push the new value down to
      // every existing descendant Sub_Team's own row too, in one
      // recursive-CTE-scoped UPDATE. `COALESCE` here mirrors the
      // Organisation row's own update above: a field that was NOT
      // supplied on this request (`undefined`) leaves each descendant's
      // existing stored value for that field untouched.
      if (
        updatedTeam &&
        updatedTeam.parent_team_id === null &&
        (color !== undefined || callsign_name_format !== undefined)
      ) {
        await pool.query(
          `WITH RECURSIVE descendants AS (
            SELECT id FROM teams WHERE parent_team_id = $1
            UNION ALL
            SELECT t.id FROM teams t JOIN descendants d ON t.parent_team_id = d.id
          )
          UPDATE teams
          SET color = COALESCE($2, color),
              callsign_name_format = COALESCE($3, callsign_name_format),
              updated_at = CURRENT_TIMESTAMP
          WHERE id IN (SELECT id FROM descendants)`,
          [teamId, color, callsign_name_format]
        );
      }

      // Requirement 6.1/6.2/9.1 (task 6.2): enqueue a CloudTAK_Group
      // update Sync_Operation after a successful `teams` UPDATE, but only
      // when this update actually touched the Team's `name` or
      // `description` -- the two fields mirrored into the CloudTAK_Group's
      // Agency_Attributes. Given the COALESCE pattern above, a field left
      // out of `updateData` arrives here as `undefined` ("not being
      // updated"), so guarding on `name !== undefined || description !==
      // undefined` skips needless operations for unrelated updates (e.g.
      // a visibility-only or reparent-only change). Guarded by
      // isCloudTakEnabled() so nothing is enqueued while the integration
      // is off (Requirement 1.4). `Team.update`'s UPDATE does not run
      // inside an explicit transaction (design.md "Exact enqueue points"
      // #2), so this enqueues on the default pool (no client). A transient
      // enqueue failure must not break the team update -- it is
      // self-healed by the Backfill and by any later update -- so this is
      // wrapped in its own try/catch that logs and does NOT rethrow.
      if (isCloudTakEnabled() && (name !== undefined || description !== undefined)) {
        try {
          // Coerce to a number: the `update_cloudtak_group` payload schema
          // requires `team_id: 'number'`, and this method is reached from
          // `PATCH /api/teams/:teamId` routes that pass `req.params.teamId`
          // (always a STRING). Without this, the enqueued `{ team_id: "5585" }`
          // fails payload validation at dequeue (permanent `validation`
          // failure) and never runs.
          await EventPublisher.publishOperation('update_cloudtak_group', { team_id: Number(teamId) }, null);
        } catch (enqueueError) {
          logger.error({ err: enqueueError, teamId }, 'Error enqueuing update_cloudtak_group');
        }
      }

      // Bugfix (a renamed team's Authentik group kept its stale name): a
      // rename changes the team's derived Team_Channel group name
      // (`tak_Teams - <root prefix>[ - <team name>]`), but nothing here
      // ever recomputed it — the only rename-triggered enqueue above is
      // `update_cloudtak_group`, whose group is keyed by numeric id and
      // whose name never contains the team name, so the `tak_Teams - ...`
      // group kept its old name forever. When `name` actually changed,
      // recompute the affected channel name(s), UPDATE the local
      // `channels.display_name`/`name` so every read site and a future
      // reconcile see the new name, and enqueue a `rename_team_channel_group`
      // per affected channel so the Sync_Worker PATCHes the Authentik group
      // `name`.
      //
      // Scope: the team's OWN channel always, PLUS every descendant channel.
      // A Sub_Team's group name embeds the root Organisation's prefix and
      // the Sub_Team's own name, so a Sub_Team rename only changes its own
      // channel; but a prefix-less Organisation's own name feeds the root
      // fallback (`effectiveRootPrefix || teamName`) that descendants can
      // depend on too, so recomputing the whole subtree and enqueuing only
      // where the derived name actually DIFFERS from the stored one is both
      // correct and cheap (a no-diff subtree enqueues nothing). Non-transactional
      // like the CloudTAK enqueue above, and failures are logged, not
      // rethrown — a later rename or manual reconcile is the backstop.
      if (updatedTeam && name !== undefined) {
        try {
          await this.renameTeamChannelGroups(teamId);
        } catch (renameError) {
          logger.error({ err: renameError, teamId }, 'Error reconciling team channel group name(s) after rename');
        }
      }

      return updatedTeam;
    } catch (error) {
      // Bugfix (callsign-handling): `idx_teams_callsign_prefix` is UNIQUE
      // over non-null `callsign_prefix` values among ORGANISATIONS ONLY
      // (see `1789400000000_scope-callsign-prefix-uniqueness-to-organisations.cjs`).
      // A Sub_Team prefix edit that collides with an existing
      // Organisation's prefix hits this constraint the same way it
      // always did -- translated into a typed, callsign_prefix-specific
      // rejection rather than the update's own generic 500 (this
      // codebase's established `23505` -> typed-error translation
      // convention).
      //
      // Promotion case: this constraint can ALSO now fire when this same
      // call is promoting an existing Sub_Team to an Organisation
      // (`parent_team_id` going from non-null to `null`) and its own
      // ALREADY-STORED `callsign_prefix` (not a value supplied on THIS
      // request -- `callsign_prefix` here is `undefined`, since it was
      // never part of this promotion request) collides with a different
      // Organisation's prefix. `existingTeam` is not guaranteed to be
      // populated in that scenario (its own fetch above is gated on the
      // Organisation-only fields being supplied, none of which a
      // pure-reparent request supplies), so the conflicting value is
      // read fresh here rather than reporting the literal string
      // "undefined" to the caller.
      if (error.code === '23505' && error.constraint === 'idx_teams_callsign_prefix') {
        const conflictingValue = callsign_prefix !== undefined
          ? callsign_prefix
          : (existingTeam?.callsign_prefix ?? (await this.findById(teamId))?.callsign_prefix);
        throw new CallsignPrefixConflictError(conflictingValue);
      }
      logger.error({ err: error, teamId }, 'Error updating team');
      throw error;
    }
  }

  /**
   * Requirement 17.3/17.4 (task 36.3): deletes a SINGLE team, and
   * everything that references it, inside a single transaction on one
   * acquired client, in FK-dependency order (deepest first):
   * `channel_memberships` for every channel belonging to this team, then
   * the `channels` rows themselves, then `team_memberships`, then the
   * `teams` row. The baseline schema's `channels.team_id`/
   * `channel_memberships.channel_id` foreign keys do NOT declare `ON
   * DELETE CASCADE` (only `teams.parent_team_id` and
   * `team_memberships.team_id`/`.user_id` do), so those two deletes must
   * be performed explicitly here rather than relying on the database to
   * cascade them.
   *
   * Cascade-delete feature: the per-team deletion work is factored into
   * `_deleteSingleTeamInTransaction`, shared with `deleteWithSubtree`
   * (which deletes a whole subtree deepest-first). This method remains
   * the single-team entry point and additionally rejects a team that has
   * sub-teams at the ROUTE layer (`DELETE /api/teams/:teamId` calls
   * `deleteWithSubtree` instead once its empty-subtree gate passes) --
   * `Team.delete` itself does not cascade into sub-teams, matching its
   * long-standing single-team contract.
   *
   * On successful commit, one `remove_team_channel_group` Sync_Operation
   * is enqueued per deleted channel (each carrying that channel's
   * `authentik_group_id`/`authentik_read_group_id`/
   * `authentik_write_group_id`, whichever are non-null) so the
   * Sync_Worker can asynchronously delete the corresponding Authentik
   * group(s). Per Requirement 17.5's established pattern
   * (`TeamMembershipService`, `UserProvisioningService`), the enqueue
   * itself happens INSIDE the same transaction, passing the open `client`
   * through to `EventPublisher.publishOperation`, so the `sync_operations`
   * rows commit/roll back atomically with the deletion.
   *
   * Requirement 26.7 (task 48.4): additionally enqueues a SINGLE bulk
   * `revoke_tak_certificates` Sync_Operation covering every user who is a
   * direct or inherited member of this team OR any of its sub-teams
   * (resolved via the same descendants-of-`teamId` recursive query
   * `getTeamHierarchy` already uses), carrying the full list of affected
   * users' TAK usernames (`users.username`) in one payload so
   * `TakServerService.listCertificates()` only needs to be called once
   * for the whole batch when the Sync_Worker processes it (task 48.5),
   * rather than once per user -- the same N+1-avoidance principle already
   * established in Requirement 11. That membership list is resolved
   * BEFORE the `team_memberships` rows are deleted below (step 3), since
   * the membership rows are the only way to know which users are
   * affected. Nothing is enqueued when no affected user has a resolvable
   * username (e.g. an empty team).
   *
   * IF any step fails, the entire transaction is rolled back, leaving the
   * team and its associated records unchanged, and the error is
   * propagated to the caller.
   *
   * @param {number|string} teamId
   * @param {number|null} [deletedBy] - local user id of the actor
   *   performing the deletion, recorded on queued Sync_Operations.
   * @returns {Promise<object>} the deleted team row.
   */
  static async delete(teamId, deletedBy = null) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Requirement 26.7: resolve every affected user's TAK username
      // (this team's members plus every sub-team's members, direct or
      // inherited) BEFORE any team_memberships row is deleted, so a
      // SINGLE bulk revoke_tak_certificates covers the whole subtree.
      // The recursive CTE mirrors getTeamHierarchy's descendants-of-
      // teamId traversal (its recursive step joins t.parent_team_id =
      // th.id, i.e. "find children of the accumulated set"), scoped here
      // to just the id column since only team_memberships.team_id
      // membership is needed.
      // Bugfix (Dashboard/Enrollment callsign-and-color divergence): the
      // SAME query also carries `u.id`, captured as `affectedUserIds`
      // below -- the set of users whose team-derived callsign/color
      // attributes need re-checking once this deletion commits, per the
      // post-commit block at the end of this method.
      const affectedUsersResult = await client.query(
        `WITH RECURSIVE team_and_subteams AS (
          SELECT id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id FROM teams t JOIN team_and_subteams ts ON t.parent_team_id = ts.id
        )
        SELECT DISTINCT u.id, u.username
        FROM team_memberships tm
        JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id IN (SELECT id FROM team_and_subteams)`,
        [teamId]
      );
      const affectedTakUsernames = affectedUsersResult.rows
        .map((row) => row.username)
        .filter((username) => username != null);
      const affectedUserIds = affectedUsersResult.rows.map((row) => row.id);

      // Delete this single team (channels/memberships/teams row + the
      // per-channel/CloudTAK enqueues), reusing the shared per-team
      // routine. The bulk cert-revocation for the whole subtree is
      // enqueued separately below rather than inside the per-team
      // routine, so a single-team delete still emits exactly ONE
      // revoke_tak_certificates operation (Requirement 26.7).
      const deletedRow = await this._deleteSingleTeamInTransaction(client, teamId, deletedBy);

      // Requirement 26.7: a single bulk revoke_tak_certificates
      // Sync_Operation for the whole team + sub-team batch, rather than
      // one operation per affected user.
      if (affectedTakUsernames.length > 0) {
        await EventPublisher.publishOperation(
          'revoke_tak_certificates',
          { tak_usernames: affectedTakUsernames },
          deletedBy,
          client
        );
      }

      await client.query('COMMIT');

      await this._clearTeamlessUserAttributesPostCommit(affectedUserIds, teamId);

      return deletedRow;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ err: error, teamId }, 'Error deleting team');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Cascade-delete feature (Global_Manager deletion of a team/org that
   * has sub-teams): counts how many HUMAN members and how many
   * Team_Owned_Devices exist anywhere in the given team's subtree (the
   * team itself plus every descendant, to any depth), so a caller can
   * refuse the cascade delete when the subtree is not empty.
   *
   * "Member" and "device" are counted the SAME way the /teams overview's
   * own `member_count`/`device_count` columns are (see `getAllTeams`/
   * `getOrganisationTeams`): a member is a `team_memberships` row whose
   * user has `is_team_device IS NOT TRUE`; a device is a DIRECT
   * (`inherited_from_team_id IS NULL`) membership row whose user has
   * `is_team_device = true`. A single human who is a member of two teams
   * in the subtree is counted once (DISTINCT user id); the device count
   * counts direct device-membership rows (a device belongs directly to
   * exactly one team, so this is effectively per-device).
   *
   * Inherited human memberships are deliberately INCLUDED in the member
   * count: an inherited member still "is in" a subtree team from an
   * operator's point of view, and surfacing them in the gate's refusal
   * message ("contains N members") is the honest, non-surprising
   * behaviour -- even though those inherited rows would themselves
   * cascade away cleanly. The gate exists to force the operator to
   * consciously empty the subtree first, not to make a fine distinction
   * about which membership rows are "real".
   *
   * @param {number|string} teamId
   * @returns {Promise<{ memberCount: number, deviceCount: number, subTeamCount: number }>}
   */
  static async getSubtreeMemberDeviceCounts(teamId) {
    try {
      const result = await pool.query(
        `WITH RECURSIVE team_and_subteams AS (
          SELECT id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id FROM teams t JOIN team_and_subteams ts ON t.parent_team_id = ts.id
        )
        SELECT
          (SELECT COUNT(DISTINCT u.id)
             FROM team_memberships tm
             JOIN users u ON u.id = tm.user_id
            WHERE tm.team_id IN (SELECT id FROM team_and_subteams)
              AND u.is_team_device IS NOT TRUE) AS member_count,
          (SELECT COUNT(*)
             FROM team_memberships tm
             JOIN users u ON u.id = tm.user_id
            WHERE tm.team_id IN (SELECT id FROM team_and_subteams)
              AND tm.inherited_from_team_id IS NULL
              AND u.is_team_device = true) AS device_count,
          (SELECT COUNT(*)
             FROM team_and_subteams
            WHERE id <> $1) AS sub_team_count`,
        [teamId]
      );
      const row = result.rows[0] || {};
      return {
        memberCount: parseInt(row.member_count, 10) || 0,
        deviceCount: parseInt(row.device_count, 10) || 0,
        subTeamCount: parseInt(row.sub_team_count, 10) || 0
      };
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error counting subtree members/devices');
      throw error;
    }
  }

  /**
   * Cascade-delete feature: deletes the given team AND every descendant
   * team (to any depth), in one transaction, DEEPEST-FIRST. Each team is
   * removed via the SAME per-team routine `Team.delete` uses
   * (`_deleteSingleTeamInTransaction`), so every descendant's channels
   * and its Authentik/CloudTAK groups get their own
   * `remove_team_channel_group`/`delete_cloudtak_group` Sync_Operations
   * enqueued -- rather than relying on the raw
   * `teams.parent_team_id ON DELETE CASCADE` FK, which would silently
   * drop descendant `teams` rows WITHOUT any of that cleanup, orphaning
   * their groups (exactly the orphaned-group class of bug this codebase
   * has hit before).
   *
   * Deepest-first ordering matters: deleting a parent first would let
   * the FK cascade remove its children out from under the loop before
   * their own cleanup ran. Ordering by descending depth guarantees every
   * child is fully cleaned up and removed before its parent's own
   * `DELETE FROM teams` executes.
   *
   * This method does NOT enforce the empty-subtree gate itself -- that is
   * the route's responsibility (it calls `getSubtreeMemberDeviceCounts`
   * first and refuses with a clear message). By the time this runs the
   * subtree is expected to be empty of members/devices, so it enqueues
   * NO bulk `revoke_tak_certificates` (there is nothing to revoke) and
   * the post-commit teamless-attribute clear is a no-op in practice --
   * both are still driven off the actually-resolved affected-user set so
   * the method stays correct even if called on a non-empty subtree.
   *
   * @param {number|string} teamId - the subtree root (an Organisation or
   *   any Sub_Team).
   * @param {number|null} [deletedBy]
   * @returns {Promise<object>} the deleted ROOT team's row (the
   *   `teamId` team), matching `Team.delete`'s own return shape.
   */
  static async deleteWithSubtree(teamId, deletedBy = null) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Resolve every team in the subtree WITH its depth, so we can
      // delete deepest-first. Mirrors getTeamHierarchy's descendants
      // traversal, carrying a `depth` accumulator.
      const subtreeResult = await client.query(
        `WITH RECURSIVE subtree AS (
          SELECT id, 0 AS depth FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id, s.depth + 1 FROM teams t JOIN subtree s ON t.parent_team_id = s.id
        )
        SELECT id, depth FROM subtree ORDER BY depth DESC`,
        [teamId]
      );
      const orderedTeamIds = subtreeResult.rows.map((row) => row.id);

      // Resolve every affected user across the WHOLE subtree up front
      // (before any membership row is deleted), for the same reasons
      // Team.delete does: a single bulk cert-revocation and the
      // post-commit teamless-attribute clear.
      const affectedUsersResult = await client.query(
        `WITH RECURSIVE team_and_subteams AS (
          SELECT id FROM teams WHERE id = $1
          UNION ALL
          SELECT t.id FROM teams t JOIN team_and_subteams ts ON t.parent_team_id = ts.id
        )
        SELECT DISTINCT u.id, u.username
        FROM team_memberships tm
        JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id IN (SELECT id FROM team_and_subteams)`,
        [teamId]
      );
      const affectedTakUsernames = affectedUsersResult.rows
        .map((row) => row.username)
        .filter((username) => username != null);
      const affectedUserIds = affectedUsersResult.rows.map((row) => row.id);

      let rootDeletedRow = null;
      for (const subtreeTeamId of orderedTeamIds) {
        const deletedRow = await this._deleteSingleTeamInTransaction(client, subtreeTeamId, deletedBy);
        if (String(subtreeTeamId) === String(teamId)) {
          rootDeletedRow = deletedRow;
        }
      }

      // One bulk revoke_tak_certificates for the whole subtree, matching
      // Team.delete. In the gated (empty-subtree) case this list is
      // empty and nothing is enqueued.
      if (affectedTakUsernames.length > 0) {
        await EventPublisher.publishOperation(
          'revoke_tak_certificates',
          { tak_usernames: affectedTakUsernames },
          deletedBy,
          client
        );
      }

      await client.query('COMMIT');

      await this._clearTeamlessUserAttributesPostCommit(affectedUserIds, teamId);

      return rootDeletedRow;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ err: error, teamId }, 'Error deleting team subtree');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Shared per-team deletion routine used by BOTH `Team.delete` (single
   * team) and `Team.deleteWithSubtree` (each team in a subtree),
   * operating on an ALREADY-OPEN transaction client the caller owns
   * (this method issues no BEGIN/COMMIT/ROLLBACK of its own -- the caller
   * controls the transaction boundary, matching this codebase's
   * "atomicity is the caller's guarantee" convention).
   *
   * Deletes, for the single team `teamId`, in FK-dependency order:
   *   1. channel_memberships for every channel belonging to the team
   *   2. the channels rows themselves
   *   3. team_memberships for the team
   *   4. the teams row itself
   * then enqueues (on the SAME client, so they commit/roll back
   * atomically) one `remove_team_channel_group` per deleted channel and,
   * when CloudTAK is enabled, one `delete_cloudtak_group` for the team.
   *
   * Deliberately does NOT enqueue `revoke_tak_certificates` or perform
   * the post-commit teamless-attribute clear: those are subtree-wide
   * concerns the CALLER handles once for the whole operation (a single
   * bulk cert revocation; one attribute-clear pass), so calling this
   * per-team in a subtree loop does not emit N cert-revocation
   * operations.
   *
   * @param {import('pg').PoolClient} client - the caller's open client.
   * @param {number|string} teamId
   * @param {number|null} deletedBy
   * @returns {Promise<object>} the deleted teams row.
   */
  static async _deleteSingleTeamInTransaction(client, teamId, deletedBy) {
    // Fetch the channels belonging to this team BEFORE deleting them,
    // so their Authentik group ids are available for the enqueue below.
    const channelsResult = await client.query(
      'SELECT id, authentik_group_id, authentik_read_group_id, authentik_write_group_id FROM channels WHERE team_id = $1',
      [teamId]
    );
    const deletedChannels = channelsResult.rows;
    const channelIds = deletedChannels.map((channel) => channel.id);

    // 1. channel_memberships for every channel belonging to this team.
    if (channelIds.length > 0) {
      await client.query('DELETE FROM channel_memberships WHERE channel_id = ANY($1)', [channelIds]);
    }

    // 2. channels rows for this team.
    await client.query('DELETE FROM channels WHERE team_id = $1', [teamId]);

    // 3. team_memberships for this team.
    await client.query('DELETE FROM team_memberships WHERE team_id = $1', [teamId]);

    // 4. the teams row itself.
    const result = await client.query('DELETE FROM teams WHERE id = $1 RETURNING *', [teamId]);

    // Requirement 17.4: enqueue one remove_team_channel_group
    // Sync_Operation per deleted channel, inside the caller's
    // transaction (Requirement 17.5's client-threading pattern). Group-id
    // fields that are null on the channel row are omitted entirely
    // (rather than passed through as `null`) so that
    // `operationSchemas.js`'s optional-field type check -- which only
    // skips a field when it is `undefined`, not merely falsy -- doesn't
    // reject an otherwise-valid payload for a channel that never had a
    // read/write group pair (e.g. a primary team channel).
    for (const channel of deletedChannels) {
      const payload = { channel_id: channel.id };
      if (channel.authentik_group_id != null) {
        payload.authentik_group_id = channel.authentik_group_id;
      }
      if (channel.authentik_read_group_id != null) {
        payload.authentik_read_group_id = channel.authentik_read_group_id;
      }
      if (channel.authentik_write_group_id != null) {
        payload.authentik_write_group_id = channel.authentik_write_group_id;
      }
      await EventPublisher.publishOperation('remove_team_channel_group', payload, deletedBy, client);
    }

    // Requirement 7.1/9.1/9.2 (task 7.1): enqueue a CloudTAK_Group
    // deletion Sync_Operation for the just-deleted Team, inside the
    // caller's transaction (design.md "Exact enqueue points" #3), so the
    // sync_operations row commits/rolls back atomically. Guarded by
    // isCloudTakEnabled() so nothing is enqueued while the integration is
    // off (Requirement 1.4). `deletedTeamId` is coerced to a number from
    // the deleted row (falling back to the coerced `teamId` argument) so
    // the payload's `team_id` satisfies the schema's `number` type even
    // though the row is already removed by the DELETE above.
    if (isCloudTakEnabled()) {
      const deletedTeamId = Number(result.rows[0]?.id ?? teamId);
      await EventPublisher.publishOperation(
        'delete_cloudtak_group',
        { team_id: deletedTeamId },
        deletedBy,
        client
      );
    }

    return result.rows[0];
  }

  /**
   * Shared post-commit step used by BOTH `Team.delete` and
   * `Team.deleteWithSubtree`: after the deletion has COMMITTED, clears
   * the cached `tak_callsign`/`tak_color` (and the mirrored Authentik
   * attributes) of any affected user who is now left with ZERO
   * team_memberships rows -- see the Dashboard/Enrollment callsign-and-
   * color divergence bugfix.
   *
   * Runs strictly AFTER COMMIT, per this codebase's "no HTTP call inside
   * a transaction" convention (`TeamTransferService.applyPostCommitEffects`
   * is the precedent) -- `clearTeamAttributes` calls Authentik.
   * Individually caught and logged per user, never thrown, so a single
   * failure never turns an already-committed deletion into a reported
   * error.
   *
   * Deliberately scoped to users left with NO team_memberships row at all
   * (not just none in the deleted subtree): a user who belonged to two
   * teams and lost only this one still has a valid callsign/color from
   * their remaining team, and clearing it here would be wrong.
   *
   * Lazy `require`, matching `server/routes/teams.js`'s existing pattern:
   * `userAttributes.js` itself requires `../models/Team`, so a top-level
   * require here would be circular.
   *
   * @param {number[]} affectedUserIds
   * @param {number|string} teamId - for log context only.
   * @returns {Promise<void>}
   */
  static async _clearTeamlessUserAttributesPostCommit(affectedUserIds, teamId) {
    if (!affectedUserIds || affectedUserIds.length === 0) {
      return;
    }
    const UserAttributesService = require('../services/userAttributes');
    for (const affectedUserId of affectedUserIds) {
      try {
        const remaining = await pool.query(
          'SELECT 1 FROM team_memberships WHERE user_id = $1 LIMIT 1',
          [affectedUserId]
        );
        if (remaining.rows.length === 0) {
          await UserAttributesService.clearTeamAttributes(affectedUserId);
        }
      } catch (postCommitError) {
        logger.error(
          { err: postCommitError, teamId, affectedUserId },
          'Team deletion post-commit: failed to clear team-derived attributes for a now-teamless user'
        );
      }
    }
  }

  /**
   * Requirement 7.1/7.2 (task 15.1): the public, unauthenticated
   * team-access-request flow's joinable-teams listing. In addition to
   * the existing `t.can_join = true AND t.visibility = 'public'` filter
   * (which already excludes a Team whose OWN `visibility` is `private`,
   * Requirement 7.1), this also excludes a Team whose Ancestor_Chain
   * contains a `private` Team, even when the Team itself is `public`
   * (Requirement 7.2) -- a private-branch cascade.
   *
   * This is DELIBERATELY a standalone, unconditional exclusion rule, not
   * a call into `TeamVisibilityService` (Requirement 6's Visible_Branch):
   * this route has no `req.user` at all (it is fully anonymous), and
   * Requirement 7's rule is simpler than Visible_Branch -- there is no
   * Global_Manager bypass and no membership exception here, full stop.
   * See `TeamVisibilityService`'s own doc comment for the same point
   * from the other side.
   *
   * Implemented as a correlated `NOT EXISTS` subquery per row, matching
   * this query's own existing style of a recursive-CTE-per-correlated-
   * subquery (as already done above for the `rt` LEFT JOIN): for each
   * candidate Team `t`, walk its Ancestor_Chain via a recursive CTE
   * (starting from `t.parent_team_id`, i.e. `t`'s STRICT ancestors --
   * `t`'s own `visibility` is already constrained to `'public'` by the
   * outer `WHERE`, so it does not need to be re-checked here) and check
   * whether any row reached that way is `private`.
   *
   * Requirement 11.9/11.10 (task 34.1): each row also carries the
   * resolved root Team's (i.e. `t`'s Organisation's) `callsign_name_format`
   * value as `callsignNameFormat`, reusing the same `rt` LEFT JOIN already
   * computed above for `display_name` rather than adding a second
   * root-resolution subquery. The Client (`RequestAccess.jsx`) uses this
   * to conditionally render a required "Preferred Callsign Suffix" input
   * only when the selected Team's Organisation's format is `user_defined`,
   * without an extra request.
   */
  // Performance-hardening: `limit`/`offset` are optional so any other
  // caller (there are none elsewhere in the codebase today, per a
  // repo-wide grep) keeps the original unbounded behavior by simply
  // omitting them. Mirrors `getAllTeams(limit, offset)`'s own optional-
  // pagination shape above. `GET /api/teams/joinable` (the sole caller)
  // always supplies both, via the shared `paginationParams` middleware.
  static async getJoinableTeams(limit, offset) {
    try {
      const hasPagination = Number.isInteger(limit) && Number.isInteger(offset);
      const query = `
        SELECT t.id, t.name, t.description, t.visibility,
               rt.callsign_name_format AS "callsignNameFormat",
               CASE 
                 WHEN t.parent_team_id IS NOT NULL THEN 
                   COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
                 ELSE t.name
               END as display_name
        FROM teams t
        LEFT JOIN teams rt ON rt.id = (
          WITH RECURSIVE root_team AS (
            SELECT id, name, parent_team_id FROM teams WHERE id = t.id
            UNION ALL
            SELECT p.id, p.name, p.parent_team_id 
            FROM teams p JOIN root_team r ON p.id = r.parent_team_id
          )
          SELECT id FROM root_team WHERE parent_team_id IS NULL
        )
        WHERE t.can_join = true AND t.visibility = 'public'
        AND NOT EXISTS (
          WITH RECURSIVE ancestors AS (
            SELECT parent_team_id FROM teams WHERE id = t.id
            UNION ALL
            SELECT p.parent_team_id FROM teams p
            JOIN ancestors a ON p.id = a.parent_team_id
          )
          SELECT 1 FROM teams anc
          JOIN ancestors a ON anc.id = a.parent_team_id
          WHERE anc.visibility = 'private'
        )
        ORDER BY display_name
        ${hasPagination ? 'LIMIT $1 OFFSET $2' : ''}
      `;
      const result = hasPagination
        ? await pool.query(query, [limit, offset])
        : await pool.query(query);
      return result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Error fetching joinable teams');
      return [];
    }
  }

  // Performance-hardening: total joinable-team count, used alongside the
  // paginated `getJoinableTeams()` result to report pagination metadata
  // to GET /api/teams/joinable's caller. Mirrors the exact same
  // WHERE/NOT EXISTS predicate `getJoinableTeams()` filters on, so the
  // reported total always matches what a full (unpaginated) fetch of
  // that same predicate would return.
  static async getJoinableTeamsCount() {
    try {
      const result = await pool.query(`
        SELECT COUNT(*) as count
        FROM teams t
        WHERE t.can_join = true AND t.visibility = 'public'
        AND NOT EXISTS (
          WITH RECURSIVE ancestors AS (
            SELECT parent_team_id FROM teams WHERE id = t.id
            UNION ALL
            SELECT p.parent_team_id FROM teams p
            JOIN ancestors a ON p.id = a.parent_team_id
          )
          SELECT 1 FROM teams anc
          JOIN ancestors a ON anc.id = a.parent_team_id
          WHERE anc.visibility = 'private'
        )
      `);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error({ err: error }, 'Error counting joinable teams');
      return 0;
    }
  }

  /**
   * Bugfix (a renamed team's Authentik group kept its stale name):
   * recomputes the derived Team_Channel group name for `teamId` AND every
   * descendant, and for each primary channel whose recomputed name DIFFERS
   * from its stored `display_name`, updates the local `channels` row and
   * enqueues a `rename_team_channel_group` Sync_Operation so the worker
   * PATCHes the Authentik group `name`.
   *
   * Called from `Team.update` only when the team's `name` actually changed.
   * Derives names via the SAME shared helper (`deriveTeamChannelName`) the
   * create path uses, so the recomputed group name is byte-identical to what
   * a fresh creation would produce (including the `country_code` leading
   * segment). Only the PRIMARY team channel (`is_primary = true`) is renamed
   * — a custom channel's name is independent of the team name.
   *
   * A channel whose group has not been reconciled yet (`authentik_group_id
   * IS NULL`) still gets its local name updated here; its pending
   * `reconcile_team_channel_group` will then create the group under the new
   * name, and the enqueued rename is a no-op in that case (the worker guards
   * on a null group id). Enqueue failures are per-channel and swallowed by
   * the caller's try/catch — a later rename or manual reconcile is the
   * backstop, matching every other non-transactional enqueue in this model.
   *
   * @param {number} teamId the just-renamed team.
   */
  static async renameTeamChannelGroups(teamId) {
    const separator = resolveChannelFolderSeparator();

    // The subtree rooted at the renamed team (the team itself + all
    // descendants), each joined to its PRIMARY channel and to its
    // Organisation's prefix/country (via a per-row ancestor walk to the
    // root), so a single query yields every primitive the shared name
    // helper needs. `display_name` is the current stored channel name we
    // diff the recomputed name against.
    const subtree = await pool.query(`
      WITH RECURSIVE subtree AS (
        SELECT id, name, parent_team_id FROM teams WHERE id = $1
        UNION ALL
        SELECT t.id, t.name, t.parent_team_id
        FROM teams t JOIN subtree s ON t.parent_team_id = s.id
      ),
      roots AS (
        SELECT s.id AS team_id,
               (SELECT r.callsign_prefix FROM (
                  WITH RECURSIVE anc AS (
                    SELECT id, callsign_prefix, country_code, parent_team_id FROM teams WHERE id = s.id
                    UNION ALL
                    SELECT p.id, p.callsign_prefix, p.country_code, p.parent_team_id
                    FROM teams p JOIN anc a ON p.id = a.parent_team_id
                  )
                  SELECT callsign_prefix FROM anc WHERE parent_team_id IS NULL
                ) r) AS root_prefix,
               (SELECT r.country_code FROM (
                  WITH RECURSIVE anc AS (
                    SELECT id, callsign_prefix, country_code, parent_team_id FROM teams WHERE id = s.id
                    UNION ALL
                    SELECT p.id, p.callsign_prefix, p.country_code, p.parent_team_id
                    FROM teams p JOIN anc a ON p.id = a.parent_team_id
                  )
                  SELECT country_code FROM anc WHERE parent_team_id IS NULL
                ) r) AS root_country_code,
               s.name AS team_name,
               s.parent_team_id
        FROM subtree s
      )
      SELECT roots.team_id, roots.root_prefix, roots.root_country_code,
             roots.team_name, roots.parent_team_id,
             c.id AS channel_id, c.display_name, c.authentik_group_id
      FROM roots
      JOIN channels c ON c.team_id = roots.team_id AND c.is_primary = true
    `, [teamId]);

    for (const row of subtree.rows) {
      const { channelName, authentikGroupName } = deriveTeamChannelName({
        rootPrefix: row.root_prefix,
        rootCountryCode: row.root_country_code,
        teamName: row.team_name,
        isSubTeam: row.parent_team_id !== null,
        separator,
        toAsciiIdentifier
      });

      // Nothing to do when the derived name is unchanged (the common case
      // for descendants of a renamed team, whose names embed the root
      // prefix rather than the renamed team's name).
      if (channelName === row.display_name) {
        continue;
      }

      const description = `Users from ${channelName} (Location sharing enabled)`;
      const channelDbName = channelName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      // Update the local channel row FIRST so every read site and any
      // pending reconcile see the new name; then enqueue the Authentik
      // rename.
      await pool.query(
        'UPDATE channels SET name = $1, display_name = $2, description = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
        [channelDbName, channelName, description, row.channel_id]
      );

      try {
        await EventPublisher.publishOperation(
          'rename_team_channel_group',
          {
            channel_id: row.channel_id,
            authentik_group_name: authentikGroupName,
            description
          },
          null
        );
      } catch (enqueueError) {
        logger.error(
          { err: enqueueError, teamId, channelId: row.channel_id },
          'Failed to enqueue rename_team_channel_group; Authentik group name left stale until a later rename or reconcile'
        );
      }
    }
  }

  /**
   * @param {number} teamId
   * @param {{deferGroupCreation?: boolean}} [options]
   *   `deferGroupCreation` (default false): skip the SYNCHRONOUS
   *   Authentik group create/lookup entirely and take the
   *   enqueue-reconcile path directly -- insert the channel row with no
   *   `authentik_group_id` and enqueue a `reconcile_team_channel_group`
   *   Sync_Operation for the worker to create-or-reuse the group with
   *   backoff and rate limiting. This is used by CSV bulk team import
   *   (`BulkImportService`): a large batch would otherwise make one (or
   *   two) blocking Authentik HTTP calls PER ROW inside the request
   *   handler -- measured at ~250-300ms each against the live Test
   *   deployment -- pushing a multi-hundred-row import past the ALB idle
   *   timeout and returning a 504 to the browser while the server kept
   *   working. Deferring makes each `Team.create` pure DB work so the
   *   request finishes quickly, and routes every group create through
   *   the same rate-limited, retryable worker path the codebase already
   *   mandates for Authentik writes (see server-conventions.md's
   *   "Transactions and the sync queue" and authentik-scaling.md). The
   *   worker's `reconcile_team_channel_group` handler is idempotent
   *   (create-or-reuse by name), so this is behaviourally identical to
   *   the synchronous path, only later.
   */
  static async createTeamChannel(teamId, { deferGroupCreation = false } = {}) {
    try {
      // Get team with root team info
      const teamResult = await pool.query(`
        WITH RECURSIVE root_team AS (
          SELECT id, name, callsign_prefix, country_code, parent_team_id FROM teams WHERE id = $1
          UNION ALL
          SELECT p.id, p.name, p.callsign_prefix, p.country_code, p.parent_team_id 
          FROM teams p JOIN root_team r ON p.id = r.parent_team_id
        )
        SELECT t.id, t.name, t.parent_team_id,
               rt.callsign_prefix as root_prefix,
               rt.country_code as root_country_code,
               CASE 
                 WHEN t.parent_team_id IS NOT NULL THEN 
                   COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
                 ELSE t.name
               END as display_name
        FROM teams t
        LEFT JOIN (SELECT name, callsign_prefix, country_code FROM root_team WHERE parent_team_id IS NULL) rt ON true
        WHERE t.id = $1
      `, [teamId]);
      
      if (!teamResult.rows[0]) return null;
      
      const team = teamResult.rows[0];
      
      // Generate channel name and the ASCII-normalized Authentik group
      // name via the shared helper, so this create path, `Team.update`'s
      // rename path and the Sync_Worker's `renameTeamChannelGroup` all
      // derive the SAME string from the same primitives (see
      // teamChannelGroupName.js).
      //
      // The root Organisation's `country_code` is composed as the LEADING
      // segment of the effective root prefix ('CHL' + 'CDEM' ->
      // 'CHL-CDEM'), matching userAttributes.js. Without it, two distinct
      // Foreign_Partner Organisations sharing a `callsign_prefix` under
      // different country codes (CHL-CDEM vs USA-CDEM) collapsed onto ONE
      // Authentik group named `tak_Teams - CDEM`.
      //
      // Special-character handling (Māori macrons): TAK Server cannot carry
      // non-ASCII in an LDAP group name, so the group name is
      // ASCII-normalized ("Teams - FENZ - Ngā Tai ki te Puku" ->
      // "tak_Teams - FENZ - Nga Tai ki te Puku") while `channelName` keeps
      // its macrons and is stored as the channel's `display_name` below.
      const separator = resolveChannelFolderSeparator();
      const { channelName, authentikGroupName } = deriveTeamChannelName({
        rootPrefix: team.root_prefix,
        rootCountryCode: team.root_country_code,
        teamName: team.name,
        isSubTeam: !!team.parent_team_id,
        separator,
        toAsciiIdentifier
      });

      const description = `Users from ${team.display_name} (Location sharing enabled)`;
      const channelDbName = channelName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      // Bulk-import fast path: skip the synchronous Authentik call(s)
      // and go straight to the enqueue-reconcile path the catch block
      // below already implements, so a bulk batch does zero blocking
      // Authentik HTTP work in the request handler (see this method's
      // doc comment). Behaviourally identical to the synchronous path
      // via the idempotent worker handler, only later.
      if (deferGroupCreation) {
        return await this.insertChannelAndEnqueueGroupReconcile({
          teamId,
          channelDbName,
          channelName,
          description,
          authentikGroupName
        });
      }

      try {
        // Create read/write group. If a group with this name already
        // exists in Authentik (e.g. left over from an earlier
        // partially-failed team creation, or created out-of-band), the
        // POST fails with a 400 (unique-name constraint) -- reuse that
        // existing group's pk instead of silently proceeding with no
        // group id, which is what happened before this check existed
        // (groupResponse.ok was never verified, so `group.pk` was
        // `undefined` and got inserted as NULL with no error surfaced).
        let group;
        const groupResponse = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: authentikGroupName,
            attributes: {
              description: description
            }
          })
        });

        if (groupResponse.ok) {
          group = await groupResponse.json();
        } else {
          const lookupResponse = await fetchWithTimeout(
            `${process.env.AUTHENTIK_URL}/api/v3/core/groups/?name=${encodeURIComponent(authentikGroupName)}`,
            { headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` } }
          );
          const lookupData = lookupResponse.ok ? await lookupResponse.json() : null;
          group = lookupData?.results?.find((g) => g.name === authentikGroupName);

          if (!group) {
            const errorText = await groupResponse.text();
            throw new Error(
              `Failed to create or find existing Authentik group "${authentikGroupName}": ${groupResponse.status} ${errorText}`
            );
          }
          logger.info(
            { teamId, authentikGroupName, groupId: group.pk },
            'Reused existing Authentik group instead of creating a duplicate'
          );
        }
        
        // Create channel with Authentik group ID
        const channelResult = await pool.query(
          'INSERT INTO channels (name, display_name, description, team_id, authentik_group_id, is_primary) VALUES ($1, $2, $3, $4, $5, true) RETURNING *',
          [channelDbName, channelName, description, teamId, group.pk]
        );
        const channel = channelResult.rows[0];

        // CloudTAK team-channel attributes: the group was POSTed with only
        // `description` above, because the channel's own id (`channelId`)
        // is not known until the INSERT just above. Now that it is, PATCH
        // the group's attributes with the COMPLETE CloudTAK set
        // (agencyId/channelId/channelName/description) so a teamed group
        // carries what CloudTAK expects. The deferred/failure paths do this
        // via `reconcileTeamChannelGroup` instead (the channel id is known
        // there too). A transient PATCH failure must not fail team creation
        // -- the channel row and its group id are already persisted, and a
        // later reconcile/backfill re-applies the attributes -- so it is
        // logged and swallowed, matching this method's other post-insert
        // best-effort work.
        try {
          const attributes = teamChannelGroupAttributes({
            teamId,
            channelId: channel.id,
            channelName,
            description
          });
          const attrResponse = await fetchWithTimeout(
            `${process.env.AUTHENTIK_URL}/api/v3/core/groups/${group.pk}/`,
            {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ attributes })
            }
          );
          if (!attrResponse.ok) {
            logger.error(
              { teamId, channelId: channel.id, groupId: group.pk, status: attrResponse.status },
              'Failed to PATCH CloudTAK attributes onto team channel group; a later reconcile/backfill will re-apply them'
            );
          }
        } catch (attrError) {
          logger.error(
            { err: attrError, teamId, channelId: channel.id, groupId: group.pk },
            'Error PATCHing CloudTAK attributes onto team channel group; a later reconcile/backfill will re-apply them'
          );
        }

        return channel;
      } catch (authentikError) {
        // Bugfix (orphaned Authentik team groups): the synchronous
        // group-create above failed (e.g. an Authentik timeout or rate
        // limit during a bulk-import burst). Previously this fell back to
        // inserting the channel row with a NULL `authentik_group_id` and
        // NOTHING ever repaired it -- so if Authentik had actually created
        // (or already held) the group, it became an orphan that the team's
        // eventual deletion could never clean up (deletion only removes
        // groups whose pk is stored locally). We STILL create the channel
        // row here so the Team is immediately usable, but we now ALSO
        // enqueue a `reconcile_team_channel_group` Sync_Operation so the
        // worker retries (with backoff) until the group is created-or-
        // reused-by-name and its pk is written back onto this channel row.
        // This is the codebase's mandated pattern: an Authentik write that
        // could not complete synchronously must become a retryable queued
        // operation, never a silently-dropped one.
        logger.error({ err: authentikError, teamId }, 'Error creating Authentik team group; enqueueing reconcile for retry');

        return await this.insertChannelAndEnqueueGroupReconcile({
          teamId,
          channelDbName,
          channelName,
          description,
          authentikGroupName
        });
      }
    } catch (error) {
      logger.error({ err: error, teamId }, 'Error creating team channel');
      return null;
    }
  }

  /**
   * Inserts the primary team channel row WITHOUT an `authentik_group_id`
   * and enqueues a `reconcile_team_channel_group` Sync_Operation for the
   * worker to create-or-reuse the Authentik group (with backoff and rate
   * limiting) and write its pk back onto the row.
   *
   * Extracted from `createTeamChannel` so the SAME code serves both the
   * synchronous path's failure fallback (an Authentik timeout / rate
   * limit during a burst) and the bulk-import `deferGroupCreation` fast
   * path -- see `createTeamChannel`'s doc comment. This is the
   * codebase's mandated pattern: an Authentik write that did not (or
   * deliberately will not) complete synchronously becomes a retryable
   * queued operation, never a silently-dropped one.
   *
   * A transient enqueue failure must never fail team creation, so it is
   * logged and swallowed: a later manual reconcile or the cleanup script
   * remains the backstop. Enqueues on the default pool (Team.create does
   * not run inside an explicit transaction -- see the
   * create_cloudtak_group enqueue in Team.create).
   */
  static async insertChannelAndEnqueueGroupReconcile({
    teamId,
    channelDbName,
    channelName,
    description,
    authentikGroupName
  }) {
    const channelResult = await pool.query(
      'INSERT INTO channels (name, display_name, description, team_id, is_primary) VALUES ($1, $2, $3, $4, true) RETURNING *',
      [channelDbName, channelName, description, teamId]
    );
    const channel = channelResult.rows[0];

    try {
      await EventPublisher.publishOperation(
        'reconcile_team_channel_group',
        {
          channel_id: channel.id,
          authentik_group_name: authentikGroupName,
          description
        },
        null
      );
    } catch (enqueueError) {
      logger.error(
        { err: enqueueError, teamId, channelId: channel.id },
        'Failed to enqueue reconcile_team_channel_group; channel left without a group id until a manual reconcile'
      );
    }

    return channel;
  }
}

Team.TeamDepthExceededError = TeamDepthExceededError;
Team.CallsignLevelSelectionRangeError = CallsignLevelSelectionRangeError;
Team.CallsignLevelSelectionSubTeamError = CallsignLevelSelectionSubTeamError;
Team.PseudonymousUsernamePolicySubTeamError = PseudonymousUsernamePolicySubTeamError;
Team.PseudonymousUsernamePolicyImmutableError = PseudonymousUsernamePolicyImmutableError;
Team.OrganisationCallsignPrefixImmutableError = OrganisationCallsignPrefixImmutableError;
Team.CallsignPrefixConflictError = CallsignPrefixConflictError;
Team.TeamNameConflictError = TeamNameConflictError;
Team.CountryCodeSubTeamError = CountryCodeSubTeamError;
Team.CountryCodeInvalidError = CountryCodeInvalidError;
Team.OrganisationCountryCodeImmutableError = OrganisationCountryCodeImmutableError;
Team.ChannelTierAccessSubTeamError = ChannelTierAccessSubTeamError;
Team.InheritedMembershipPromotionError = InheritedMembershipPromotionError;

module.exports = Team;