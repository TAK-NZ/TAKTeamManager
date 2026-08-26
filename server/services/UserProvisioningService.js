/**
 * UserProvisioningService
 *
 * Requirement 17.1: `POST /api/users/create-and-add` must wrap every LOCAL
 * database write for the "create a user and add them to a team" operation
 * inside a single transaction, using one already-acquired `pg` client --
 * while the Authentik user-creation call itself happens strictly BEFORE
 * that transaction opens, since an external HTTP call must never be issued
 * from inside an open DB transaction.
 *
 * This service therefore takes an ALREADY-CREATED Authentik user id
 * (`authentikUserId`) and an ALREADY-BEGUN transactional `client` as
 * inputs; it performs no Authentik API calls itself. Callers are
 * responsible for:
 *   1. Creating the Authentik user (or resolving an existing one) BEFORE
 *      acquiring a client / calling `BEGIN`.
 *   2. Acquiring one `client = await pool.connect()`, calling
 *      `await client.query('BEGIN')`, then calling `createAndAddUser`.
 *   3. Committing on success / rolling back on any thrown error, and
 *      releasing the client in a `finally` block.
 *
 * Any Authentik-side write that would otherwise happen mid-sequence (e.g.
 * adding the new user to a team/parent-team channel's Authentik group) is
 * instead queued as a `sync_operations` row via `EventPublisher`, matching
 * the existing `TeamMembershipService` pattern. This keeps every write
 * performed by this function a plain local database write, so none of them
 * require an Authentik API call while `client`'s transaction is open.
 *
 * The recursive parent-team inheritance logic below is carried over
 * unchanged from the pre-refactor `POST /api/users/create-and-add` handler
 * in `server/routes/users.js`.
 */
const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const Team = require('../models/Team');
const CallsignService = require('./CallsignService');
const ManagedIdentifierService = require('./ManagedIdentifierService');
const { checkCallsignSuffixUniqueness } = require('./CallsignSuffixUniquenessService');
const { IDENTIFIER_TYPE_MARKERS } = require('../utils/managedIdentifier');
const { isValidCallsignPrefix } = require('../utils/callsignValidation');

/**
 * Requirement 11.6 (task 22.1): thrown by `resolveCallsignSuffixForNewUser`
 * when the target Organisation's `callsign_name_format` is `user_defined`
 * and no non-empty `requestedCallsignSuffix` was supplied -- `user_defined`
 * computes no default at all (Requirement 11.5), so a value MUST be
 * supplied by the caller in this case.
 */
class CallsignSuffixRequiredError extends Error {
  constructor(message = "A callsign suffix is required for this Organisation's user_defined callsign format") {
    super(message);
    this.name = 'CallsignSuffixRequiredError';
  }
}

/**
 * Requirement 13.3/13.4/13.5: resolves the Organisation at the root of
 * `teamId`'s Ancestor_Chain on the caller's transaction client.
 *
 * Not `Team.getAncestorChain`: that reads through the shared `pool`, and this
 * value is written inside the caller's open transaction. Not the existing
 * `parent_teams` CTE in this file either -- that projects parent ids
 * without an ORDER BY, and taking "the last row" from a recursive CTE relies
 * on evaluation order Postgres does not guarantee. This predicate
 * (`parent_team_id IS NULL`) is order-independent and returns exactly one row.
 *
 * @param {import('pg').PoolClient} client - the caller's already-open
 *   transactional client.
 * @param {number} teamId
 * @returns {Promise<number|null>} the root Organisation's team id, or `null`
 *   when the chain cannot be resolved.
 */
async function resolveOrganisationIdForTeam(client, teamId) {
  const result = await client.query(`
    WITH RECURSIVE chain AS (
      SELECT id, parent_team_id FROM teams WHERE id = $1
      UNION ALL
      SELECT t.id, t.parent_team_id FROM teams t JOIN chain c ON t.id = c.parent_team_id
    )
    SELECT id FROM chain WHERE parent_team_id IS NULL
  `, [teamId]);
  return result.rows.length > 0 ? result.rows[0].id : null;
}

class UserProvisioningService {
  /**
   * Upserts the local `users` row for an already-created Authentik user,
   * assigns them to `teamId` (removing any stale inherited membership row
   * for that same team first), walks the team's parent hierarchy to create
   * the corresponding inherited `team_memberships` rows, and assigns the
   * user to the primary channel of every team in that chain (queuing an
   * `add_user_to_group` Sync_Operation for each channel that has an
   * Authentik group).
   *
   * @param {import('pg').PoolClient} client - an already-connected client
   *   with an already-open transaction (`BEGIN` already issued by the
   *   caller).
   * @param {object} params
   * @param {number|string} params.authentikUserId - the `pk` of the
   *   already-created Authentik user.
   * @param {string} params.username
   * @param {string} params.email
   * @param {string} params.firstName
   * @param {string} params.lastName
   * @param {number} params.teamId
   * @param {string|null} [params.callsign_suffix] - the resolved
   *   Requirement 11.6/11.7/11.14-checked `callsign_suffix` value for
   *   this new user (task 22.2's wiring of
   *   `resolveCallsignSuffixForNewUser`'s result into this shared local
   *   write path). Stored on `users.callsign_suffix`.
   * @param {number|null} [params.createdBy] - local user id of the actor
   *   performing this operation, recorded on queued Sync_Operations.
   * @param {number|null} [params.claimId] - takserver-enrollment
   *   Requirement 6.6 (task 5.2): when supplied, this is the `users.id`
   *   of a Claim_Row already inserted by
   *   `resolveNewUserIdentity`'s pseudonymous branch (`authentik_user_id
   *   IS NULL`, `is_active = false`, carrying the minted
   *   Pseudonymous_Username and the real email). When present, that
   *   EXACT row is adopted via `UPDATE ... WHERE id = $claimId` instead
   *   of the generic `INSERT ... ON CONFLICT (authentik_user_id)` upsert
   *   below.
   *
   *   This branch exists because the generic upsert cannot adopt a
   *   Claim_Row: Postgres's `ON CONFLICT` target is the
   *   `authentik_user_id` unique constraint, and a Claim_Row's
   *   `authentik_user_id` is `NULL` -- `NULL` is never equal to `NULL`
   *   even under a unique constraint used for conflict detection, so the
   *   generic upsert's `ON CONFLICT` clause would never match the
   *   Claim_Row. It would instead silently INSERT A SECOND row for the
   *   same Authentik user, leaving the original Claim_Row behind
   *   forever with `authentik_user_id IS NULL` -- invisible to every
   *   existing surface (Claim_Row visibility table, design.md) and
   *   permanently holding `users_email_key` for that address. The
   *   explicit `UPDATE ... WHERE id = $claimId` sidesteps `ON CONFLICT`
   *   entirely, so it adopts the exact row by primary key regardless of
   *   what `authentik_user_id` currently holds.
   * @returns {Promise<{localUserId: number, queuedGroups: number}>}
   */
  static async createAndAddUser(client, { authentikUserId, username, email, firstName, lastName, teamId, callsign_suffix = null, createdBy = null, claimId = null }) {
    // Requirement 13.3/13.4/13.5: resolve the target Team's Organisation
    // (the root of its Ancestor_Chain) on the caller's transaction client
    // and record it as the user's provenance.
    const originOrgId = await resolveOrganisationIdForTeam(client, teamId);

    let localUserId;

    if (claimId != null) {
      // Claim_Row adoption (see the `claimId` param doc above for why
      // this cannot go through the generic upsert below). `origin_org_id`
      // keeps the same write-once guarantee via COALESCE, just expressed
      // against the row's own current value rather than `EXCLUDED`,
      // since a plain `UPDATE` has no `EXCLUDED` pseudo-table.
      const adoptResult = await client.query(
        'UPDATE users SET authentik_user_id = $1, username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, callsign_suffix = $6, origin_org_id = COALESCE(origin_org_id, $7) WHERE id = $8 RETURNING id',
        [authentikUserId, username, email, firstName, lastName, callsign_suffix, originOrgId, claimId]
      );

      if (adoptResult.rows.length === 0) {
        throw new Error(`Cannot adopt Claim_Row: no users row with id ${claimId}`);
      }

      localUserId = adoptResult.rows[0].id;
    } else {
      // Upsert local user record. Requirement 13.9: `origin_org_id` is
      // write-once -- `COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)`
      // never overwrites an existing non-null value, so a returning user being
      // re-provisioned into another Organisation is never reclassified.
      await client.query(
        'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active, callsign_suffix, origin_org_id) VALUES ($1, $2, $3, $4, $5, true, $6, $7) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, callsign_suffix = $6, origin_org_id = COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)',
        [authentikUserId, username, email, firstName, lastName, callsign_suffix, originOrgId]
      );

      const localUserResult = await client.query(
        'SELECT id FROM users WHERE authentik_user_id = $1',
        [authentikUserId]
      );
      localUserId = localUserResult.rows[0].id;
    }

    // Remove any existing inherited membership for this user from this team
    // (mirrors the pre-refactor behavior exactly).
    await client.query(
      'DELETE FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id = $2',
      [localUserId, teamId]
    );

    // Add to the target team directly.
    await client.query(
      'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)',
      [teamId, localUserId, 'member']
    );

    let queuedGroups = 0;

    // Walk the target team's parent chain (root-ward) and add one inherited
    // membership row + primary-channel membership per ancestor, exactly as
    // the pre-refactor recursive-CTE logic did.
    const parentTeamsResult = await client.query(`
      WITH RECURSIVE parent_teams AS (
        SELECT parent_team_id FROM teams WHERE id = $1 AND parent_team_id IS NOT NULL
        UNION ALL
        SELECT t.parent_team_id
        FROM teams t
        JOIN parent_teams pt ON t.id = pt.parent_team_id
        WHERE t.parent_team_id IS NOT NULL
      )
      SELECT parent_team_id as team_id FROM parent_teams
    `, [teamId]);

    for (const parentTeam of parentTeamsResult.rows) {
      await client.query(
        'INSERT INTO team_memberships (team_id, user_id, role, inherited_from_team_id) VALUES ($1, $2, $3, $4)',
        [parentTeam.team_id, localUserId, 'inherited', teamId]
      );

      const parentChannelResult = await client.query(
        'SELECT id, authentik_group_id FROM channels WHERE team_id = $1 AND is_primary = true',
        [parentTeam.team_id]
      );

      if (parentChannelResult.rows.length > 0) {
        const parentChannel = parentChannelResult.rows[0];

        await client.query(
          'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [parentChannel.id, localUserId, 'read_write']
        );

        if (parentChannel.authentik_group_id) {
          // Requirement 17.5's client-threading pattern extends here too:
          // this function already runs inside the caller's open
          // transaction, so pass that same `client` through so the
          // sync_operations INSERT commits/rolls back atomically with the
          // rest of this function's local writes.
          await EventPublisher.publishOperation('add_user_to_group', {
            target_user_id: localUserId,
            target_group_id: parentChannel.authentik_group_id
          }, createdBy, client);
          queuedGroups++;
        }
      }
    }

    // Assign the user to the target team's own primary channel.
    const channelResult = await client.query(
      'SELECT id, authentik_group_id FROM channels WHERE team_id = $1 AND is_primary = true',
      [teamId]
    );

    if (channelResult.rows.length > 0) {
      const channel = channelResult.rows[0];

      await client.query(
        'INSERT INTO channel_memberships (channel_id, user_id, permission) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [channel.id, localUserId, 'read_write']
      );

      if (channel.authentik_group_id) {
        await EventPublisher.publishOperation('add_user_to_group', {
          target_user_id: localUserId,
          target_group_id: channel.authentik_group_id
        }, createdBy, client);
        queuedGroups++;
      }
    }

    return { localUserId, queuedGroups };
  }

  /**
   * takserver-enrollment Requirements 6.3, 6.5, 6.7, 6.8, 9.1, 9.2, 9.3,
   * 9.4, 8.1 (task 5.1): the single Phase-0 resolver for BOTH the
   * username decision and the Callsign-suffix-default decision for a
   * brand-new user, replacing `resolveCallsignSuffixForNewUser`
   * (REMOVED -- not kept as a delegate). One function, not two: both
   * decisions are properties of the SAME row --
   * `Team.getAncestorChain(teamId)[0]`, the Organisation -- read exactly
   * ONCE here, and both are keyed on that same row's
   * `pseudonymous_usernames` policy flag. Splitting them into two
   * resolvers would mean two ancestor-chain reads that could disagree
   * about which Organisation is in force, and two things a new creation
   * path could remember one of and forget the other (design decision 10).
   *
   * Resolution order:
   *   1. Resolve the Organisation as `getAncestorChain(teamId)[0]` -- the
   *      chain is ROOT-FIRST (`Team.getAncestorChain`'s own contract), so
   *      index 0 IS the Organisation; this is never a positional read
   *      from the tail (Criterion 6.7). This single call is also where
   *      `callsign_name_format` and `callsign_prefix` come from -- no
   *      second query for either.
   *   2. Policy ENABLED (`organisation.pseudonymous_usernames === true`):
   *      - `requestedUsername` is IGNORED, never rejected (design
   *        decision 8), matching how `Team.create` already silently
   *        overrides a supplied `color` on a Sub_Team.
   *      - Callsign_Default_Suppression applies FIRST, before any mint
   *        attempt: `CallsignService.computeDefaultCallsignSuffix` is
   *        NEVER called, and a blank `requestedCallsignSuffix` throws
   *        the existing `CallsignSuffixRequiredError` immediately
   *        (Criteria 9.1, 9.2) -- so a request that would fail this
   *        validation never reaches the mint, exactly as a
   *        `CallsignSuffixRequiredError` today is a request-validation
   *        failure returned before any Authentik call.
   *      - `username` is then a freshly minted Pseudonymous_Username: a
   *        Managed_Identifier with Identifier_Type_Marker `U`, minted via
   *        `ManagedIdentifierService.mintUniqueIdentifier` against the
   *        Organisation's own `callsign_prefix` (validated inline against
   *        `isValidCallsignPrefix` rather than via
   *        `ManagedIdentifierService.resolveOrganisationPrefix`, which
   *        would re-read the Organisation through `Team.findById` -- a
   *        SECOND database read of the same row this function already
   *        holds from step 1; see "The `claim` callback" below for what
   *        the mint's `claim(candidate)` callback does here specifically).
   *   3. Policy DISABLED (`false` or `null`): `username` is
   *      `requestedUsername` VERBATIM, so each of the four creation paths
   *      keeps its own current derivation exactly -- the caller-supplied
   *      body value, `email`, or `row.username || email.split('@')[0]`
   *      (Criterion 6.8) -- and the Callsign_Suffix resolution runs
   *      EXACTLY as `resolveCallsignSuffixForNewUser` did: `user_defined`
   *      requires a non-empty `requestedCallsignSuffix`
   *      (`CallsignSuffixRequiredError` otherwise); any other format
   *      prefers a non-empty `requestedCallsignSuffix` when supplied, else
   *      computes the default via `CallsignService.computeDefaultCallsignSuffix`.
   *   4. Either way: `checkCallsignSuffixUniqueness(teamId, ...)` runs
   *      UNCHANGED (Criterion 9.4), and the supplied `email` is returned
   *      UNTOUCHED -- a Pseudonymous_Organisation's members still carry a
   *      real, deliverable address (Criteria 6.5, 8.1); only a
   *      Team_Owned_Device has none, and the Device_Email_Null_Invariant
   *      rejects an emailless HUMAN row outright, which is exactly why
   *      this function never nulls it out.
   *
   * The `claim` callback (why it does what it does, and what it does
   * NOT do here):
   *
   * `ManagedIdentifierService.mintUniqueIdentifier`'s uniqueness
   * guarantee comes ENTIRELY from `claim(candidate)` being the caller's
   * own single `INSERT ... RETURNING id`, retried against a REAL
   * `users_username_key` rejection (Criterion 1.7 -- no pre-insert
   * `SELECT` probe is permitted anywhere on this path, because it races).
   * A `claim` that does not actually write a row cannot ever receive a
   * `23505`, so the retry loop could never fire and a genuine collision
   * would instead surface later, unhandled, at whichever downstream phase
   * performs the REAL `users` insert -- and only AFTER that phase's
   * Authentik user has already been created under the colliding name.
   * That is precisely the scenario the Claim_Row concept exists to
   * prevent (design decision 4: "a `users_username_key` violation on the
   * local write would arrive with a federated account already minted
   * under the colliding name"), and design decision 5 states explicitly
   * that this reasoning is NOT device-only: "The Claim_Row carries the
   * real email for a HUMAN, rather than weakening the
   * Device_Email_Null_Invariant." So `claim(candidate)` here performs a
   * genuine Claim_Row insert:
   *
   *   INSERT INTO users (username, email, first_name, last_name,
   *                       authentik_user_id, is_active)
   *   VALUES ($1, $2, $3, $4, NULL, false)
   *   RETURNING id
   *
   * carrying the REAL supplied `email` (per design decision 5 -- a human
   * Claim_Row is never emailless, unlike a device's), `authentik_user_id
   * = NULL` and `is_active = false` -- the same two columns the "Claim_Row
   * state" table in design.md names as what makes a Claim_Row invisible
   * to every existing surface (`GET /api/users` joins on
   * `authentik_user_id`; `search`/`available` filter `is_active = true`;
   * every team surface joins `team_memberships`, which this row has none
   * of yet). No transaction is opened around this `INSERT` -- it runs
   * against the shared `pool` (never the `client` parameter, which this
   * function does not use for the same reason
   * `resolveCallsignSuffixForNewUser` never used it: every existing call
   * site passes `null` for it, since this all happens at Phase 0, before
   * any transaction exists) -- so a rejected candidate costs one local
   * round trip and nothing external, exactly as the device path's own
   * Phase 0 does.
   *
   * What this function deliberately does NOT do: adopt, attach, or
   * delete that Claim_Row. Phase 1 (creating the Authentik user with this
   * resolved `username`) and Phase 2 (adopting the Claim_Row by `UPDATE
   * ... WHERE id = $claimId` rather than a second `INSERT`, then
   * attaching team membership) belong to the FOUR CALLERS this task does
   * not touch -- task 5.2 (the approval-path adapter) and task 5.3 (the
   * three remaining routes) are separate, later tasks. This function
   * therefore surfaces the created Claim_Row's local `users.id` as
   * `claimId` (`null` when the policy is disabled and no Claim_Row was
   * created) so a later caller has what it needs to adopt rather than
   * re-insert -- re-inserting would collide on the very `username` this
   * function just claimed via `users_username_key`.
   *
   * @param {import('pg').PoolClient|null} client - unused by this
   *   function's own body, for the same reason it was unused by
   *   `resolveCallsignSuffixForNewUser`: accepted only for signature
   *   consistency. The Claim_Row insert (when the policy is enabled) runs
   *   against the shared `pool`, deliberately outside any transaction.
   * @param {object} params
   * @param {string} params.firstName
   * @param {string} params.lastName
   * @param {string} params.email - returned UNTOUCHED regardless of
   *   policy state (Criteria 6.5, 8.1).
   * @param {number} params.teamId
   * @param {string|null|undefined} [params.requestedUsername] - the
   *   caller's own current username derivation. Used verbatim when the
   *   policy is disabled; IGNORED (not rejected) when enabled.
   * @param {string|null|undefined} [params.requestedCallsignSuffix]
   * @returns {Promise<{
   *   username: string,
   *   callsignSuffix: string,
   *   pseudonymous: boolean,
   *   organisationId: number|undefined,
   *   organisationPrefix: string|null|undefined,
   *   claimId: number|null
   * }>}
   * @throws {CallsignSuffixRequiredError} when Callsign_Default_Suppression
   *   applies and no non-blank `requestedCallsignSuffix` was supplied, or
   *   when the policy is disabled and `callsign_name_format` is
   *   `user_defined` with none supplied.
   * @throws {import('./ManagedIdentifierService').OrganisationPrefixMissingError}
   *   when the policy is enabled and the Organisation carries no valid
   *   Organisation_Prefix to mint against (Criterion 2.9).
   * @throws {import('./ManagedIdentifierService').ManagedIdentifierExhaustionError}
   *   when five consecutive mint attempts all collide.
   * @throws {CallsignSuffixConflictError} on a per-Team uniqueness
   *   collision.
   */
  static async resolveNewUserIdentity(client, {
    firstName, lastName, email, teamId, requestedUsername, requestedCallsignSuffix
  }) {
    const ancestorChain = await Team.getAncestorChain(teamId);
    const organisation = ancestorChain[0];
    const callsignNameFormat = organisation?.callsign_name_format;
    const pseudonymous = organisation?.pseudonymous_usernames === true;

    let username;
    let effectiveCallsignSuffix;
    let claimId = null;

    if (pseudonymous) {
      // Callsign_Default_Suppression (Criteria 9.1, 9.2): validated
      // BEFORE the mint attempt, so a request that fails this check never
      // creates a Claim_Row for what is fundamentally a
      // request-validation failure -- the same reasoning that already
      // places this check ahead of every Authentik call.
      const trimmedRequested = requestedCallsignSuffix ? requestedCallsignSuffix.trim() : '';
      if (!trimmedRequested) {
        throw new CallsignSuffixRequiredError();
      }
      effectiveCallsignSuffix = trimmedRequested;

      // Criterion 2.9: the Organisation_Prefix is resolved and validated
      // from the SAME ancestor-chain row read above -- not a second
      // `Team.findById` query via `ManagedIdentifierService.
      // resolveOrganisationPrefix` -- and `claim` is never invoked when
      // it is missing/invalid.
      const organisationPrefix = organisation?.callsign_prefix;
      if (
        typeof organisationPrefix !== 'string' ||
        organisationPrefix.trim().length === 0 ||
        !isValidCallsignPrefix(organisationPrefix)
      ) {
        throw new ManagedIdentifierService.OrganisationPrefixMissingError(organisation?.id);
      }

      const mintResult = await ManagedIdentifierService.mintUniqueIdentifier({
        organisationPrefix,
        organisationId: organisation.id,
        typeMarker: IDENTIFIER_TYPE_MARKERS.USER,
        claim: async (candidate) => pool.query(
          'INSERT INTO users (username, email, first_name, last_name, authentik_user_id, is_active) VALUES ($1, $2, $3, $4, NULL, false) RETURNING id',
          [candidate, email, firstName, lastName]
        )
      });

      username = mintResult.username;
      claimId = mintResult.claim.rows[0].id;
    } else {
      // requestedUsername verbatim (Criterion 6.8): each of the four
      // creation paths keeps its own current derivation exactly.
      username = requestedUsername;

      // Callsign resolution exactly as `resolveCallsignSuffixForNewUser`
      // ran it: unchanged for a policy-disabled Organisation.
      const trimmedRequested = requestedCallsignSuffix ? requestedCallsignSuffix.trim() : '';
      if (callsignNameFormat === 'user_defined') {
        if (!trimmedRequested) {
          throw new CallsignSuffixRequiredError();
        }
        effectiveCallsignSuffix = trimmedRequested;
      } else {
        effectiveCallsignSuffix = trimmedRequested || CallsignService.computeDefaultCallsignSuffix(firstName, lastName, callsignNameFormat);
      }
    }

    // Criterion 9.4: unchanged either way.
    await checkCallsignSuffixUniqueness(teamId, effectiveCallsignSuffix);

    return {
      username,
      callsignSuffix: effectiveCallsignSuffix,
      pseudonymous,
      organisationId: organisation?.id,
      organisationPrefix: organisation?.callsign_prefix,
      claimId
    };
  }
}

UserProvisioningService.CallsignSuffixRequiredError = CallsignSuffixRequiredError;

module.exports = UserProvisioningService;
