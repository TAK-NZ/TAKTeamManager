const pool = require('../config/database');
const logger = require('../config/logger').createLogger('TeamTransferService');
const Team = require('../models/Team');
const TeamMembershipService = require('./TeamMembershipService');
const EventPublisher = require('./EventPublisher');
const UserAttributesService = require('./userAttributes');
const EmailService = require('./EmailService');

// Module-scope singleton, following `SignupFlowService`'s existing shape
// for a service whose methods are static: `applyPostCommitEffects` has no
// instance to hang an `EmailService` off, and re-running EmailService's
// constructor (which builds a nodemailer transport) on every transfer
// would be wasteful.
const emailService = new EmailService();

/**
 * Requirement 1.4: thrown by `TeamTransferService.executeTransfer` when the
 * user named for transfer holds no Direct_Membership at all, so there is no
 * Source_Team to move them out of.
 *
 * Follows `CallsignSuffixConflictError`'s established contract -- the typed
 * error carries the data the response needs and nothing route-shaped, so
 * each call site (the immediate path in `server/routes/users.js`, the
 * approval path in `RequestApprovalService`) shapes its own status and
 * message around it.
 */
class NoCurrentTeamError extends Error {
  /**
   * @param {number} userId - the Transferred_User with no Direct_Membership.
   */
  constructor(userId) {
    super('User has no current team');
    this.name = 'NoCurrentTeamError';
    this.userId = userId;
  }
}

/**
 * Requirement 1.5: thrown when the user's Direct_Membership already names
 * the Destination_Team, so the transfer would be a no-op.
 */
class AlreadyInDestinationTeamError extends Error {
  /**
   * @param {number} userId
   * @param {number} teamId - the Team the user already holds a
   *   Direct_Membership in, which is also the requested destination.
   */
  constructor(userId, teamId) {
    super('User is already a member of that team');
    this.name = 'AlreadyInDestinationTeamError';
    this.userId = userId;
    this.teamId = teamId;
  }
}

/**
 * Requirement 1.8: thrown by the `POST /api/users/:userId/transfer` route
 * handler -- NOT by `executeTransfer`, and NOT by the `user:team:transfer`
 * row-scoped resolver -- when the `:userId` route parameter names the
 * requesting user themselves.
 *
 * Defined here alongside the other transfer errors so every typed transfer
 * failure has one home, per design.md's "Typed errors" table. The reasoning
 * for the throw site is in design.md: the resolver would return 403 where
 * Requirement 1.8 specifies 400, and `executeTransfer` compares a local
 * `users.id` actor rather than the authenticated identity, so the check is
 * a route-layer concern.
 */
class SelfTransferError extends Error {
  /**
   * @param {number} userId - the user who is both actor and target.
   */
  constructor(userId) {
    super('An admin cannot transfer their own membership');
    this.name = 'SelfTransferError';
    this.userId = userId;
  }
}

/**
 * Requirement 11.1: thrown when `params.expectedSourceTeamId` is supplied
 * (the approval path passes the Transfer_Request's recorded
 * `current_team_id`) and the locked Direct_Membership names a different
 * Team -- the Transferred_User moved between the Transfer_Request's
 * creation and its approval, so applying it would produce a wrong result.
 */
class StaleTransferRequestError extends Error {
  /**
   * @param {number} expectedSourceTeamId - the Source_Team the
   *   Transfer_Request was created against.
   * @param {number} actualSourceTeamId - the Team the Direct_Membership
   *   names now, read under the row lock.
   */
  constructor(expectedSourceTeamId, actualSourceTeamId) {
    super("The user's team changed since the request was created");
    this.name = 'StaleTransferRequestError';
    this.expectedSourceTeamId = expectedSourceTeamId;
    this.actualSourceTeamId = actualSourceTeamId;
  }
}

/**
 * Requirements 1.7 and 11.6: thrown when the Source_Team and the
 * Destination_Team resolve to different Organisations (different
 * Ancestor_Chain roots) and the actor executing THIS call is not a
 * Global_Manager.
 *
 * This is the one transfer error whose route status depends on the path:
 * 400 on the immediate path (a caller mistake at request time,
 * Requirement 1.7), 409 on the approval path (a Team was reparented under
 * a pending Transfer_Request, a staleness condition, Requirement 11.6).
 * Carrying both Organisation ids lets either call site say which two.
 */
class CrossOrganisationTransferError extends Error {
  /**
   * @param {number} sourceOrganisationId - root of the Source_Team's chain.
   * @param {number} destinationOrganisationId - root of the
   *   Destination_Team's chain.
   */
  constructor(sourceOrganisationId, destinationOrganisationId) {
    super('A transfer is limited to teams within one organisation');
    this.name = 'CrossOrganisationTransferError';
    this.sourceOrganisationId = sourceOrganisationId;
    this.destinationOrganisationId = destinationOrganisationId;
  }
}

/**
 * Requirement 9.7's "non-empty" qualifier, made total over every value the
 * two supplying links can produce.
 *
 * `null`, `undefined`, `''`, and a whitespace-only string are all treated
 * alike as absent. The route's `express-validator` `.trim()` already
 * collapses a whitespace-only submission to `''`, but
 * `access_requests.callsign_suffix` is a plain nullable column that older
 * rows may hold untrimmed, so the whitespace case is handled here rather
 * than assumed away.
 *
 * Returns the trimmed value when present, so a suffix that survives this
 * filter is what gets stored and what the uniqueness check compares.
 *
 * @param {string|null|undefined} value
 * @returns {string|null} the trimmed value, or null when absent.
 */
function nonEmpty(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

/**
 * @typedef {object} TransferOutcome
 * @property {number} userId
 * @property {number} sourceTeamId
 * @property {number} destinationTeamId
 * @property {string} priorRole                  // role on the Direct_Membership before the move
 * @property {boolean} demotedFromAdmin          // priorRole === 'admin'
 * @property {number} actorId
 * @property {string|null} callsignSuffixApplied // non-null only when this transfer wrote one
 * @property {string|null} callsignSuffixEffective // Requirement 9.7's resolved value:
 *                                              // what the callsign is built from and what
 *                                              // the uniqueness check ran against
 * @property {number[]} revokedChannelIds
 * @property {string[]} revokedAuthentikGroupIds
 * @property {number|null} transferRequestId
 * @property {number|null} initiatedBy
 * @property {boolean} viaRequest
 */

class TeamTransferService {
  /**
   * Requirement 6.1. The single method that performs a Team_Transfer.
   *
   * `client` is REQUIRED and must already be inside a BEGIN. This service
   * never issues BEGIN/COMMIT/ROLLBACK and never calls pool.connect():
   * the caller owns the transaction lifecycle unconditionally. This is a
   * deliberate departure from TeamMembershipService.addUserToTeam's
   * optional-externalClient / ownsTransaction pattern -- that flexibility
   * exists there for backward compatibility with callers that predate it,
   * and both callers here already hold an open transaction, so making the
   * client mandatory turns Requirement 6.6's atomicity from a caller
   * obligation into a signature guarantee.
   *
   * Performs NO Authentik call, NO email send, and NO audit write --
   * those are applyPostCommitEffects's job (Requirements 8.4, 13.4, 14.4).
   *
   * @param {import('pg').PoolClient} client
   * @param {object} params
   * @param {number} params.userId              local users.id of the Transferred_User
   * @param {number} params.destinationTeamId
   * @param {number} params.actorId             local users.id performing/approving
   * @param {boolean} params.actorIsGlobalManager  Requirement 11.6's exemption,
   *   evaluated against the user performing or approving THIS call. Passed in
   *   rather than re-derived: this service takes a local users.id, not a
   *   req.user, and re-querying Global_Manager status inside the transactional
   *   core would move an authorization decision into the execution path. The
   *   caller already holds the authoritative value (req.user.is_global_manager).
   * @param {number|null} [params.expectedSourceTeamId]  when set, a mismatch
   *   against the locked Direct_Membership throws StaleTransferRequestError
   *   (Requirement 11.1)
   * @param {string|null} [params.callsignSuffix]        Requirement 9.3 / 9.4,
   *   the highest-precedence link of Requirement 9.7's resolution chain
   * @param {string|null} [params.requestCallsignSuffix] Requirement 9.7's second
   *   link: the associated Transfer_Request's access_requests.callsign_suffix
   * @param {number|null} [params.transferRequestId]     Requirement 14.3
   * @param {number|null} [params.initiatedBy]           Requirement 14.3
   * @returns {Promise<TransferOutcome>}
   * @throws {NoCurrentTeamError|AlreadyInDestinationTeamError|StaleTransferRequestError|CrossOrganisationTransferError|CallsignSuffixConflictError}
   */
  static async executeTransfer(client, params) {
    if (!client) {
      throw new TypeError('TeamTransferService.executeTransfer requires a transaction client');
    }

    const {
      userId,
      destinationTeamId,
      actorId,
      actorIsGlobalManager,
      expectedSourceTeamId = null,
      callsignSuffix = null,
      requestCallsignSuffix = null,
      transferRequestId = null,
      initiatedBy = null
    } = params;

    // -----------------------------------------------------------------
    // Step 1 -- lock and read the Direct_Membership.
    //
    // `FOR UPDATE` on the Direct_Membership row is the second of two
    // concurrency guards (the first is the `access_requests` row lock on
    // the approval path) and is the ONLY guard on the immediate path. It
    // serialises two concurrent transfers of the same user regardless of
    // which entry point each came through.
    // `idx_team_memberships_one_direct_per_user` guarantees at most one
    // row, so this is a single-row lock.
    //
    // The immediate path repeats these three checks in its own pre-flight
    // (outside any transaction) so it can return the specified status
    // codes without opening a transaction for a doomed request. The
    // in-transaction repetition here is the authoritative, race-free one.
    // That duplication is intentional: pre-flight is for status-code
    // shaping, the locked read is for correctness.
    // -----------------------------------------------------------------
    const membershipResult = await client.query(
      `SELECT team_id, role
         FROM team_memberships
        WHERE user_id = $1 AND inherited_from_team_id IS NULL
          FOR UPDATE`,
      [userId]
    );

    const membership = membershipResult.rows[0];

    if (!membership) {
      throw new NoCurrentTeamError(userId);
    }

    const sourceTeamId = membership.team_id;

    // `priorRole` MUST be captured here, before step 4: `addUserToTeam`
    // deletes this row, and it feeds `demotedFromAdmin` (Requirements
    // 10.2, 10.3) and the audit `details` (Requirements 10.5, 14.2).
    const priorRole = membership.role;

    if (sourceTeamId === destinationTeamId) {
      throw new AlreadyInDestinationTeamError(userId, destinationTeamId);
    }

    if (expectedSourceTeamId != null && sourceTeamId !== expectedSourceTeamId) {
      throw new StaleTransferRequestError(expectedSourceTeamId, sourceTeamId);
    }

    // -----------------------------------------------------------------
    // Step 2 -- resolve both Ancestor_Chains and re-validate the
    // Organisation boundary (Requirements 1.7, 11.6).
    //
    // Both calls read through `pool`, which is correct here: they read
    // `teams`, a table this transaction does not modify, and
    // `PUT /api/teams/:teamId` reparenting is precisely the concurrent
    // writer Requirement 11.6 exists to catch -- so reading the committed
    // present state is the intended semantics rather than a hazard.
    //
    // The source chain is resolved from the team id read under the row
    // lock in step 1, NOT from a Transfer_Request's recorded
    // `current_team_id`. The exemption is evaluated against whoever is
    // executing THIS call (the approving user on the approval path, the
    // Initiating_Admin on the immediate path), which is what Requirement
    // 11.6 specifies. `actorIsGlobalManager` is a required parameter
    // rather than an optional one so that a caller cannot omit it and
    // silently obtain the exempt-by-default behaviour.
    //
    // A `destinationTeamId` naming no `teams` row yields an empty chain
    // and a TypeError below. That is the Requirement 11.3 dangling-foreign
    // -key case, which design.md deliberately routes to the callers'
    // generic error branch rather than a typed error: the route pre-flight
    // (Requirement 1.2) and the approval path's own existence check both
    // reject it first, so reaching here means a genuine internal
    // inconsistency.
    // -----------------------------------------------------------------
    // `destinationChain` is root-first and includes destinationTeamId
    // itself, so step 5 derives its revocation predicate's team-id array
    // straight from it -- Requirement 11.6 therefore costs exactly one
    // additional `getAncestorChain` call, on the source team.
    const destinationChain = await Team.getAncestorChain(destinationTeamId);
    const sourceChain = await Team.getAncestorChain(sourceTeamId);

    if (sourceChain[0].id !== destinationChain[0].id && !actorIsGlobalManager) {
      throw new CrossOrganisationTransferError(sourceChain[0].id, destinationChain[0].id);
    }

    // -----------------------------------------------------------------
    // Step 3 -- resolve the Callsign_Suffix precedence chain and
    // optionally persist it (Requirements 9.3, 9.4, 9.7, 9.8).
    //
    // Requirement 9.7's chain is resolved here, in one place, rather than
    // split between the call sites and the service. Links (a) and (b)
    // arrive as parameters -- (a) is the value supplied on the call that
    // executes the transfer (`callsignSuffix` on the immediate path,
    // `callsignSuffix` on the approve body per Requirement 9.4), (b) is
    // the associated Transfer_Request's `access_requests.callsign_suffix`.
    // Link (c) is read below on `client`, so the read is transactional and
    // sees any write this transaction has already made.
    // -----------------------------------------------------------------
    const suppliedSuffix = nonEmpty(callsignSuffix) ?? nonEmpty(requestCallsignSuffix);

    let callsignSuffixApplied = null;
    let callsignSuffixEffective = suppliedSuffix;

    if (suppliedSuffix !== null) {
      // The resolved value came from link (a) or (b), so it is new
      // information this transfer contributes: persist it on `client`
      // (Requirements 9.3, 9.4) and report it on the outcome so
      // `applyPostCommitEffects` mirrors it to `user_cache`
      // (Requirement 9.5).
      await client.query(
        'UPDATE users SET callsign_suffix = $1 WHERE id = $2',
        [suppliedSuffix, userId]
      );

      callsignSuffixApplied = suppliedSuffix;
    } else {
      // Chain link (c): the stored value IS the effective value, so no
      // UPDATE is issued -- leaving `users.callsign_suffix` untouched is
      // the correct expression of that. `callsignSuffixApplied` stays
      // null, which is what suppresses the `user_cache` suffix mirror.
      const userResult = await client.query(
        'SELECT callsign_suffix FROM users WHERE id = $1',
        [userId]
      );

      callsignSuffixEffective = nonEmpty(userResult.rows[0]?.callsign_suffix);
    }

    // Requirement 9.8 -- that the uniqueness check runs against
    // `callsignSuffixEffective` falls out of this write ordering rather
    // than needing its own enforcement. `addUserToTeam`'s existing
    // `checkCallsignSuffixUniqueness` call re-reads the candidate from
    // `client`, so it sees the (a)/(b) write above when there was one and
    // the untouched (c) value when there was not. Adding a second check
    // here would be redundant, and there is no path on which the checked
    // value and the used value can differ.

    // -----------------------------------------------------------------
    // Step 4 -- the additive half, delegated.
    //
    // This one call supplies Requirements 6.2 (exactly one Direct_
    // Membership row, naming the destination), 6.3 (an `inherited` row per
    // ancestor of the Destination_Team), 6.4 (a `channel_memberships` row
    // per Primary_Channel of the destination chain), 6.8 (exactly one
    // `add_user_to_group` Sync_Operation per destination-chain
    // Primary_Channel holding a non-null `authentik_group_id`), and the
    // `assign_user_to_global_channels` enqueue -- all on `client`, all
    // already implemented and already tested. Reusing it rather than
    // reimplementing the ancestor walk is why this service does not
    // duplicate `UserProvisioningService.createAndAddUser`'s logic a third
    // time; `addUserToTeam` is deliberately left unmodified.
    //
    // `'member'` is hardcoded: Requirement 10.1, a transferred admin
    // always arrives demoted. `priorRole` was captured in step 1 because
    // this call deletes the row it was read from.
    //
    // Requirement 6.7 needs no branch -- an Organisation-to-Sub_Team move
    // goes through this same delegation like any other transfer.
    //
    // This is also where Requirement 9.8's uniqueness check happens, via
    // `addUserToTeam`'s existing `checkCallsignSuffixUniqueness` call: a
    // destination Member_List collision throws `CallsignSuffixConflictError`
    // out of `executeTransfer` before any write of this step lands, and
    // the caller's ROLLBACK undoes step 3's `UPDATE users` too
    // (Requirements 6.5, 9.2).
    // -----------------------------------------------------------------
    await TeamMembershipService.addUserToTeam(userId, destinationTeamId, 'member', actorId, client);

    // -----------------------------------------------------------------
    // Step 5 -- the subtractive half (Requirement 7).
    //
    // Each part of this statement is load-bearing:
    //
    // - The `USING channels c` join, NOT a blanket
    //   `DELETE FROM channel_memberships WHERE user_id = $1`, is what
    //   keeps Deployment_Channel (and any future polymorphic) rows out of
    //   scope: `channel_memberships.channel_id` is polymorphic, so the
    //   blanket form used by `removeUserFromTeam` would destroy rows that
    //   name no `channels` row at all. This is the deliberate divergence
    //   from `removeUserFromTeam`.
    // - `NOT (c.team_id = ANY($2))` with `$2` = the destination chain's
    //   team ids expresses Requirements 7.1 and 7.4 as ONE predicate. A
    //   Team appearing in both the Source_Team's and the Destination_
    //   Team's Ancestor_Chain -- the shared-Organisation case, which is
    //   the common one -- is in the array, so its Channel is retained and
    //   no Sync_Operation is enqueued for it. The source chain is
    //   deliberately not consulted: the destination chain alone is
    //   sufficient, and expressing revocation purely as "not owned by a
    //   destination-chain Team" means the result cannot depend on the
    //   source chain being complete or resolvable.
    // - Running this AFTER step 4 is safe and intentional. Step 4 inserted
    //   the destination-chain channel rows; those rows' `c.team_id` values
    //   are inside the array and so are never deletion candidates.
    //   Expressing the delete as an end-state predicate over owning teams
    //   -- rather than "rows that existed before step 4" -- makes it
    //   directly checkable against Requirement 7.1's own end-state
    //   wording.
    // - Channels of a non-destination Team that are NOT that Team's
    //   Primary_Channel are revoked too: Requirement 7.1 says "a Channel
    //   whose owning Team is absent from the Destination_Team's
    //   Ancestor_Chain" without restricting to `is_primary = true`, so the
    //   predicate matches the requirement literally. The additive side
    //   (Requirements 6.4, 6.8) IS Primary_Channel-scoped, so the two
    //   halves are deliberately asymmetric.
    // -----------------------------------------------------------------
    const destinationTeamIds = destinationChain.map(team => team.id);

    const revokedResult = await client.query(
      `DELETE FROM channel_memberships cm
             USING channels c
             WHERE cm.user_id = $1
               AND cm.channel_id = c.id
               AND NOT (c.team_id = ANY($2::int[]))
         RETURNING c.id AS channel_id, c.authentik_group_id`,
      [userId, destinationTeamIds]
    );

    const revokedChannelIds = [];
    const revokedAuthentikGroupIds = [];

    for (const row of revokedResult.rows) {
      revokedChannelIds.push(row.channel_id);

      // Requirement 7.2 -- one `remove_user_from_group` Sync_Operation per
      // revoked Channel that actually has an Authentik group to remove
      // from. A Channel whose Authentik group creation has not completed
      // holds a null `authentik_group_id` and has nothing to enqueue
      // against, matching `addUserToTeam`'s treatment on the additive
      // side.
      if (row.authentik_group_id) {
        // Threading `client` is Requirement 7.3: a rolled-back transfer
        // leaves no `sync_operations` row behind. Same pattern as
        // `createAndAddUser` and `addUserToTeam`.
        await EventPublisher.publishOperation('remove_user_from_group', {
          target_user_id: userId,
          target_group_id: row.authentik_group_id
        }, actorId, client);

        revokedAuthentikGroupIds.push(row.authentik_group_id);
      }
    }

    // -----------------------------------------------------------------
    // Step 6 -- build and return the TransferOutcome.
    //
    // No COMMIT (Requirement 6.6 -- the caller owns the transaction, so
    // the `access_requests` status update on the approval path commits
    // with these writes or not at all), no Authentik call, no email, and
    // no audit write: those are `applyPostCommitEffects`'s job, run
    // strictly after the caller's COMMIT (Requirements 8.4, 13.4, 14.4).
    // -----------------------------------------------------------------
    return {
      userId,
      sourceTeamId,
      destinationTeamId,
      priorRole,
      demotedFromAdmin: priorRole === 'admin',
      actorId,
      callsignSuffixApplied,
      callsignSuffixEffective,
      revokedChannelIds,
      revokedAuthentikGroupIds,
      transferRequestId,
      initiatedBy,
      viaRequest: transferRequestId != null
    };
  }

  /**
   * Requirements 8, 13, 14. Runs strictly AFTER the caller's COMMIT.
   *
   * Never throws: every step is individually try/caught and logged, so a
   * failed callsign computation, `user_cache` upsert, Authentik PATCH,
   * email, or audit insert leaves the committed membership change in
   * place and the caller's response at 200 (Requirements 8.5, 13.4,
   * 14.4). Each failure is bounded and recoverable, so there is nothing
   * for a caller to do with an exception even if one were raised.
   *
   * Reads through the shared `pool` rather than a transaction client, by
   * construction: this function exists precisely because Requirement 8.4
   * forbids an external HTTP request while a transaction is open, and
   * everything it reads was committed by the caller before it was
   * called.
   *
   * @param {TransferOutcome} outcome
   * @returns {Promise<{callsign: string|null, emailSent: boolean, audited: boolean}>}
   */
  static async applyPostCommitEffects(outcome) {
    let callsign = null;
    let emailSent = false;
    let audited = false;

    if (!outcome) {
      // Defensive: the contract is "never throws", and a caller that
      // reached here with nothing to apply has already committed.
      logger.error({}, 'Team transfer post-commit effects called with no outcome');

      return { callsign, emailSent, audited };
    }

    const {
      userId,
      sourceTeamId,
      destinationTeamId,
      priorRole,
      actorId,
      callsignSuffixApplied = null,
      revokedChannelIds = [],
      transferRequestId = null,
      initiatedBy = null,
      viaRequest = false
    } = outcome;

    // -----------------------------------------------------------------
    // Prerequisite -- one read of the Transferred_User's `users` row,
    // shared by steps 2, 3, and 4.
    //
    // Steps 2 and 3 need `authentik_user_id`; step 4 needs `email`,
    // `first_name`, `username`, and `is_team_device` (Requirement 13.5).
    // `username` is read here (not previously) so the notification email
    // can carry it in the same blue info box `access_request_approved`
    // uses, matching that template's `{{username}}` variable. Reading
    // the row once rather than three times costs nothing in failure
    // tolerance: a database failure here would fail each per-step read
    // identically, and steps 2-4 each guard on the result being present,
    // so a missing row skips them individually rather than aborting the
    // function. Step 5's audit write needs none of it and runs
    // regardless.
    // -----------------------------------------------------------------
    let user = null;

    try {
      const userResult = await pool.query(
        `SELECT authentik_user_id, email, first_name, username, is_team_device
           FROM users
          WHERE id = $1`,
        [userId]
      );

      user = userResult.rows[0] || null;
    } catch (error) {
      logger.error(
        { err: error, userId, sourceTeamId, destinationTeamId },
        'Team transfer post-commit: failed to read the transferred user'
      );
    }

    // -----------------------------------------------------------------
    // Step 1 -- compute the callsign, colour, and TAK role from the
    // Destination_Team's Ancestor_Chain (Requirements 8.1, 8.6).
    //
    // Requirement 8.6 needs no special case: `computeCallsignAttributes`
    // filters ancestors to `depth >= 1`, so a root-Organisation
    // destination yields an empty `teamSegmentPrefixes` and
    // `assembleCallsign` produces `PREFIX-Suffix` with no Sub_Team
    // segment.
    //
    // `generateCallsign` reads `users.callsign_suffix` through `pool`, so
    // it sees whatever step 3 of `executeTransfer` committed -- which is
    // why this cannot run before the caller's COMMIT.
    // -----------------------------------------------------------------
    let attributes = null;

    try {
      attributes = await UserAttributesService.generateCallsign(userId, destinationTeamId);
      callsign = attributes?.callsign ?? null;
    } catch (error) {
      logger.error(
        { err: error, userId, destinationTeamId },
        'Team transfer post-commit: callsign computation failed'
      );
    }

    // A null callsign means the user or the Destination_Team could not be
    // resolved. Steps 2-4 are skipped wholesale in that case: writing
    // NULL into `user_cache` or pushing NULL to Authentik is strictly
    // worse than leaving the prior value in place, since the periodic
    // Authentik synchronisation treats the local value as authoritative
    // and would then propagate the erasure. The audit write (step 5)
    // still runs either way -- the membership change did happen, and
    // Requirement 14 does not depend on the callsign.
    if (callsign === null) {
      logger.error(
        { userId, sourceTeamId, destinationTeamId },
        'Team transfer post-commit: no callsign could be computed; user_cache mirror, Authentik push, and notification skipped to avoid erasing the prior values'
      );
    } else if (!user) {
      logger.error(
        { userId, sourceTeamId, destinationTeamId },
        'Team transfer post-commit: transferred user row unavailable; user_cache mirror, Authentik push, and notification skipped'
      );
    } else {
      // ---------------------------------------------------------------
      // Step 2 -- mirror the computed identity attributes into
      // `user_cache` (Requirements 8.2, 9.5).
      //
      // This MUST precede the Authentik PATCH of step 3. The periodic
      // Authentik synchronisation treats `tak_callsign`, `tak_color`, and
      // `tak_role` as locally authoritative and pushes the local values
      // whenever they differ, so a cache row written first makes a failed
      // PATCH self-correcting within one `SYNC_INTERVAL_MINUTES`. The
      // reverse order would leave a successful PATCH to be overwritten by
      // the stale cache value instead.
      //
      // `INSERT ... ON CONFLICT (authentik_id) DO UPDATE` rather than a
      // bare `UPDATE`, following `approveRequest`'s Phase 3, so a user
      // with no cache row yet is handled. The row is located by
      // `users.authentik_user_id::text = user_cache.authentik_id` -- the
      // cast is required because `users.authentik_user_id` is an integer
      // and `user_cache.authentik_id` is a varchar. Sourcing the
      // NOT NULL `username`/`email` columns from that same `users` row
      // means the INSERT branch needs no separate lookup.
      //
      // `DO UPDATE` deliberately sets ONLY the columns this transfer
      // computed. `username`, `email`, `first_name`, and `last_name` are
      // owned by the periodic Authentik synchronisation on an existing
      // cache row, and a transfer has no new information about them.
      //
      // `callsign_suffix` is written only when `callsignSuffixApplied` is
      // non-null -- that is, only when this transfer actually stored a
      // new suffix on `users` (Requirement 9.5). When the suffix resolved
      // to the user's existing stored value, there is nothing to mirror
      // and the cache column is left alone.
      // ---------------------------------------------------------------
      const mirrorsSuffix = callsignSuffixApplied !== null;

      try {
        await pool.query(
          `INSERT INTO user_cache (
             authentik_id, username, email, first_name, last_name, is_active,
             tak_callsign, tak_color, tak_role${mirrorsSuffix ? ', callsign_suffix' : ''}
           )
           SELECT u.authentik_user_id::text, u.username, u.email, u.first_name,
                  u.last_name, COALESCE(u.is_active, true), $2, $3, $4${mirrorsSuffix ? ', $5' : ''}
             FROM users u
            WHERE u.id = $1 AND u.authentik_user_id IS NOT NULL
           ON CONFLICT (authentik_id) DO UPDATE SET
             tak_callsign = $2,
             tak_color = $3,
             tak_role = $4${mirrorsSuffix ? ',\n             callsign_suffix = $5' : ''}`,
          mirrorsSuffix
            ? [userId, callsign, attributes.color, attributes.role, callsignSuffixApplied]
            : [userId, callsign, attributes.color, attributes.role]
        );
      } catch (error) {
        logger.error(
          { err: error, userId, destinationTeamId, callsign },
          'Team transfer post-commit: user_cache upsert failed; the next periodic Authentik sync will refresh it'
        );
      }

      // ---------------------------------------------------------------
      // Step 3 -- push the computed attributes to Authentik
      // (Requirements 8.3, 8.4, 8.5).
      //
      // `updateUserAttributes` already returns `false` rather than
      // throwing on failure, and already merges rather than replaces the
      // user's Authentik attributes, so Requirement 8.5 needs no handling
      // beyond logging the `false`. Per Requirement 8's note, no retry is
      // added here: the periodic synchronisation corrects a failed push
      // within one interval, using the `user_cache` row step 2 just
      // wrote.
      // ---------------------------------------------------------------
      try {
        if (user.authentik_user_id == null) {
          logger.warn(
            { userId, destinationTeamId },
            'Team transfer post-commit: user has no Authentik id; attribute push skipped'
          );
        } else {
          const pushed = await UserAttributesService.updateUserAttributes(user.authentik_user_id, {
            callsign,
            color: attributes.color,
            role: attributes.role
          });

          if (!pushed) {
            logger.error(
              { userId, authentikUserId: user.authentik_user_id, destinationTeamId, callsign },
              'Team transfer post-commit: Authentik attribute push failed; the next periodic Authentik sync will retry it'
            );
          }
        }
      } catch (error) {
        logger.error(
          { err: error, userId, destinationTeamId, callsign },
          'Team transfer post-commit: Authentik attribute push threw'
        );
      }

      // ---------------------------------------------------------------
      // Step 4 -- notify the Transferred_User (Requirement 13).
      //
      // Skipped entirely for a Team_Owned_Device (Requirement 13.5): such
      // a record holds a synthetic, non-deliverable address.
      //
      // `team_path` uses the same `callsign_prefix || name` segment
      // mapping and `' - '` join as `RequestApprovalService`'s approval
      // and denial emails, so the path a user sees in a transfer
      // notification reads identically to the one in every other email
      // the app sends. (`requests.js` joins with `' > '`, but that is an
      // API response field, not email copy.) The last segment is the
      // Team's full `name` rather than its prefix, matching those same
      // call sites.
      //
      // `username` is now passed alongside `team_path`/`callsign` (a
      // widening of Requirement 13.3's original three-variable set) so
      // the `team_transfer_completed` template can render the same blue
      // Team/Username/TAK-Callsign info box `access_request_approved`
      // uses, keeping the two emails visually aligned. Falls back to
      // `user.email` on the rare chance `username` is unset, mirroring
      // `sendApprovalEmail`'s own `username || email` fallback.
      //
      // The destination chain is re-resolved here rather than carried on
      // the outcome: `TransferOutcome` is a value object of ids that both
      // callers can hand back after their COMMIT, and re-reading `teams`
      // -- a table the transfer did not modify -- is cheap.
      // ---------------------------------------------------------------
      if (user.is_team_device) {
        logger.info(
          { userId, destinationTeamId },
          'Team transfer post-commit: transferred record is a team-owned device; no notification sent'
        );
      } else {
        try {
          const destinationChain = await Team.getAncestorChain(destinationTeamId);
          const teamPath = destinationChain
            .map((team, index) => (index === destinationChain.length - 1 ? team.name : team.callsign_prefix || team.name))
            .join(' - ');

          await emailService.sendEmail(user.email, 'team_transfer_completed', {
            first_name: user.first_name || '',
            team_path: teamPath,
            username: user.username || user.email,
            callsign
          });

          emailSent = true;
        } catch (error) {
          logger.error(
            { err: error, userId, destinationTeamId },
            'Team transfer post-commit: transfer notification email failed'
          );
        }
      }
    }

    // -----------------------------------------------------------------
    // Step 5 -- audit the completed transfer (Requirement 14).
    //
    // `user_id` is the actor who performed or approved it, `resource_id`
    // the Transferred_User (Requirement 14.1). `requestId` and
    // `initiatedBy` appear in `details` only for a transfer that went
    // through a Transfer_Request (Requirement 14.3), so an immediate
    // transfer's audit row carries no null-valued keys that would read as
    // "approved through a request whose id we lost".
    //
    // Runs last and unconditionally: it is the one effect that depends on
    // nothing but the outcome itself, so a failure anywhere above still
    // leaves the transfer recorded. Its own failure is logged and
    // swallowed (Requirement 14.4), matching the existing audit-write
    // behaviour in `server/routes/requests.js` and `server/routes/teams.js`.
    // -----------------------------------------------------------------
    try {
      const details = {
        sourceTeamId,
        destinationTeamId,
        priorRole,
        viaRequest: !!viaRequest,
        ...(viaRequest ? { requestId: transferRequestId, initiatedBy } : {}),
        revokedChannelIds,
        callsignSuffixApplied
      };

      await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'user.team_transfer', 'user', $2, $3)`,
        [actorId, userId, JSON.stringify(details)]
      );

      audited = true;
    } catch (error) {
      logger.error(
        { err: error, userId, actorId, sourceTeamId, destinationTeamId },
        'Team transfer post-commit: audit log insert failed'
      );
    }

    return { callsign, emailSent, audited };
  }
}

module.exports = {
  TeamTransferService,
  NoCurrentTeamError,
  AlreadyInDestinationTeamError,
  SelfTransferError,
  StaleTransferRequestError,
  CrossOrganisationTransferError
};
