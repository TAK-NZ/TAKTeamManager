const pool = require('../config/database');
const Channel = require('../models/Channel');
const logger = require('../config/logger').createLogger('ChannelRequestService');

/**
 * Thrown by `approveChannelRequest`/`denyChannelRequest` when the target
 * `channel_requests` row's `status` is not `'pending'` at the moment the
 * approval/denial transaction re-checks it (Req 23.8) -- including when a
 * row simply does not exist for the given id, which is indistinguishable
 * from "already processed" from the caller's perspective (there is no
 * pending row to act on either way). Mirrors the shape of other small,
 * named error classes used elsewhere in this codebase (e.g.
 * `Channel.ChannelLimitError`, `VendorChannelService`'s
 * `VendorChannelAlreadyActiveError`) so callers (route handlers) can
 * respond with a specific 400-equivalent error rather than a generic 500.
 */
class ChannelRequestAlreadyProcessedError extends Error {
  constructor(message = 'Channel request not found or already processed') {
    super(message);
    this.name = 'ChannelRequestAlreadyProcessedError';
  }
}

/**
 * ChannelRequestService
 *
 * Requirement 23 (Channel Creation Approval Workflow for Teams): today's
 * `POST /api/channels/custom` creates a custom team channel immediately,
 * with no pending/approval state. This service introduces that pending
 * state for non-Global_Manager requesters while leaving the
 * Global_Manager path's existing immediate-creation behavior unchanged.
 *
 * Task 45.1 introduced `requestChannel`; tasks 45.2/45.3 added
 * `approveChannelRequest`/`denyChannelRequest` respectively.
 *
 * Per `design.md`'s Section 19: `requestChannel(teamId, customSuffix,
 * memberPermissions, requestedBy)` -- if `requestedBy` is a
 * Global_Manager, it behaves exactly like today's
 * `POST /api/channels/custom` (immediate creation, Req 23.3) by
 * delegating straight to `Channel.createCustomChannel`. Otherwise it
 * inserts a `channel_requests` row (`status='pending'`) and performs NO
 * Authentik enqueue and NO `channels` insert (Req 23.2).
 *
 * ## How the Global_Manager check is resolved
 *
 * `design.md`'s method signature is deliberately 4 parameters --
 * `requestChannel(teamId, customSuffix, memberPermissions, requestedBy)`
 * -- with no explicit `isGlobalManager` boolean parameter. `requestedBy`
 * is a user identifier (the local `users.id`, matching every other
 * `*By`/`*_by` parameter already used by sibling services --
 * `Channel.createCustomChannel`'s callers, `GlobalChannelService`'s
 * `createdBy`/`deletedBy`/`updatedBy` params, `EventPublisher`'s
 * `createdBy` param -- none of which are ever a boolean or a
 * pre-resolved permissions object).
 *
 * Requirement 4 Criterion 4 already establishes the codebase's answer to
 * "how does a request determine Global_Manager status": a server-side
 * check against `users.is_global_manager` (see
 * `server/middleware/auth.js`'s `is_global_manager: cachedUser.is_admin`
 * and, at the service layer specifically,
 * `GlobalChannelService.getBchChannelCredentials`'s
 * `SELECT is_global_manager FROM users WHERE id = $1` -- the exact same
 * shape: a SERVICE method, given only a user id, resolving Global_Manager
 * status itself via a fresh DB lookup rather than trusting a caller-
 * supplied flag that could be stale or forged). This service follows
 * that same established convention: `requestChannel` queries
 * `users.is_global_manager` for `requestedBy` itself, rather than adding
 * a 5th parameter to the signature `design.md` explicitly specifies as
 * 4-argument, and rather than trusting an unverified boolean from the
 * caller.
 *
 * A future route handler (task 45.4, out of scope here) is expected to
 * call `requestChannel(teamId, customSuffix, memberPermissions,
 * req.user.userId)` -- passing the local `users.id` (NOT the Authentik
 * id `req.user.id`; see `server/middleware/auth.js`'s distinction
 * between the two, and `server/middleware/authorize.js`'s repeated
 * comments on the same point for every other row-scoped resolver in this
 * codebase).
 */
class ChannelRequestService {
  /**
   * @param {number|string} teamId
   * @param {string} customSuffix
   * @param {Array<{userId: number, permission: string}>} memberPermissions
   * @param {number} requestedBy - local `users.id` of the requesting user.
   * @returns {Promise<object>} the created `channels` row (Global_Manager
   *   path) or the created `channel_requests` row (pending path).
   */
  static async requestChannel(teamId, customSuffix, memberPermissions, requestedBy) {
    const isGlobalManager = await this.isGlobalManager(requestedBy);

    if (isGlobalManager) {
      // Requirement 23.3: a Global_Manager's request creates the channel
      // immediately, following the existing behavior of
      // `POST /api/channels/custom` -- delegate straight to
      // `Channel.createCustomChannel` (which itself performs the
      // Requirement 16.6 SERIALIZABLE-transaction channel-limit check and
      // enqueues the Authentik Sync_Operations) rather than duplicating
      // any of that logic here.
      return Channel.createCustomChannel(teamId, customSuffix, memberPermissions);
    }

    // Requirement 23.2: a non-Global_Manager's request inserts a pending
    // `channel_requests` row and performs NO Authentik enqueue and NO
    // `channels` insert.
    const result = await pool.query(
      `INSERT INTO channel_requests (team_id, custom_suffix, member_permissions, requested_by, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [teamId, customSuffix, JSON.stringify(memberPermissions), requestedBy]
    );

    return result.rows[0];
  }

  /**
   * Requirement 23.4-23.6, 23.8 (task 45.2): approves a pending
   * `channel_requests` row, creating its corresponding `channels` row and
   * enqueueing the associated Authentik Sync_Operation(s) atomically with
   * the `status` flip to `'approved'`.
   *
   * Authorization ("Global_Manager OR admin of the parent team of the
   * request's `team_id`", Req 23.4) is deliberately NOT checked here --
   * per `design.md`'s Section 19 and this codebase's established
   * pattern, that check belongs at the route/Permission_Registry layer
   * (task 45.4, out of scope here), exactly as `Channel.createCustomChannel`
   * and `GlobalChannelService`'s create methods already assume their
   * caller is authorized rather than re-checking it themselves.
   *
   * ## Transaction-atomicity approach
   *
   * `design.md` describes this as running "within a single transaction":
   * the `channel_requests` status flip, the `channels` INSERT, and the
   * Authentik-group Sync_Operation enqueue must all commit or roll back
   * together, so that a failure anywhere in `Channel.createCustomChannel`
   * leaves the request `pending` and retryable (Req 23.6) rather than
   * `approved` with no channel ever created.
   *
   * `Channel.createCustomChannel` (task 35.6) was written to manage its
   * OWN `pool.connect()` + `BEGIN ISOLATION LEVEL SERIALIZABLE`/`COMMIT`/
   * `ROLLBACK` internally, with no way for an external caller to supply
   * its own client -- calling it as-is from inside a second, separate
   * transaction here would mean TWO independent Postgres transactions,
   * not one, and a `Channel.createCustomChannel` failure would roll back
   * only its own (already-empty, since it failed) transaction while
   * leaving this method's `channel_requests` status-flip transaction
   * either already committed or in an inconsistent state depending on
   * ordering -- true single-transaction atomicity would not be achieved.
   *
   * Rather than threading a whole new optional-`client` parameter through
   * `Channel.createCustomChannel` itself (which would also force it to
   * accept a caller-chosen isolation level, weakening its documented
   * guarantee that the Requirement 16.6 count re-check ALWAYS runs at
   * `SERIALIZABLE`), `Channel.js` was refactored (this same task) to
   * split `createCustomChannel` into two already-existing, independently
   * reusable phases:
   *
   *   - `prepareCustomChannelCreation(teamId, customSuffix)` -- Phase 1,
   *     team lookup + Authentik group creation, no open DB transaction.
   *   - `insertCustomChannelAndMembers(teamId, customSuffix,
   *     memberPermissions, prepared, client)` -- Phase 2, the count
   *     re-check + `channels` INSERT + member INSERTs, run on a
   *     caller-supplied, already-`BEGIN`-ed client.
   *
   * `createCustomChannel` itself is unchanged in behavior (same SQL
   * sequence, same `SERIALIZABLE` isolation, same `ChannelLimitError`/
   * `40001` handling) -- it simply now calls these two phases internally.
   * This method calls the SAME two phases directly, opening its OWN
   * `SERIALIZABLE` transaction (matching `Channel.createCustomChannel`'s
   * isolation level exactly, since Phase 2's count re-check requires it)
   * and running the `channel_requests` status-flip UPDATE, the pending
   * re-check SELECT, and both phases' writes all on that ONE client. This
   * achieves genuine single-transaction atomicity (option (a) from this
   * task's brief) without needing to loosen `Channel.createCustomChannel`'s
   * own isolation guarantee or its existing external callers'/tests'
   * behavior.
   *
   * The Authentik-group-creation Sync_Operation enqueue happens inside
   * `insertCustomChannelAndMembers`'s member-add calls in the current
   * `Channel.createCustomChannel` implementation only in the sense that
   * the Authentik GROUPS themselves are created synchronously in Phase 1
   * (not via a queued Sync_Operation) -- there is no separate
   * `sync_operations` INSERT in this path today; this mirrors
   * `Channel.createCustomChannel`'s existing behavior exactly, which this
   * task does not change.
   *
   * @param {number|string} requestId - `channel_requests.id`.
   * @param {number} approverId - local `users.id` of the authorized approver.
   * @returns {Promise<object>} the created `channels` row.
   * @throws {ChannelRequestAlreadyProcessedError} if the request does not
   *   exist or its `status` is not `'pending'` (Req 23.8) -- no mutation
   *   occurs in this case.
   * @throws {Error|Channel.ChannelLimitError} if `Channel.createCustomChannel`'s
   *   underlying phases fail for any other reason (e.g. the 3-channel
   *   limit is still reached, or an Authentik call fails) -- the entire
   *   transaction, including the status flip, is rolled back, leaving the
   *   request `pending` and retryable (Req 23.6).
   */
  static async approveChannelRequest(requestId, approverId) {
    // --- Phase 1: pre-fetch (no open transaction), mirroring
    // `RequestApprovalService.approveRequest`'s established pattern --
    // reject fast, before acquiring a client or issuing any Authentik
    // calls, if the request is obviously not pending. The transactional
    // re-check below is still authoritative (guards against a concurrent
    // approve/deny between this pre-fetch and the transaction).
    const preFetchResult = await pool.query(
      "SELECT * FROM channel_requests WHERE id = $1 AND status = 'pending'",
      [requestId]
    );

    if (preFetchResult.rows.length === 0) {
      throw new ChannelRequestAlreadyProcessedError();
    }

    const preFetchedRequest = preFetchResult.rows[0];

    // Team lookup + Authentik group creation (Channel.createCustomChannel's
    // Phase 1) -- no open DB transaction during these external HTTP calls.
    const prepared = await Channel.prepareCustomChannelCreation(
      preFetchedRequest.team_id,
      preFetchedRequest.custom_suffix
    );

    // --- Phase 2: single SERIALIZABLE transaction wrapping the
    // channel_requests status flip AND Channel.createCustomChannel's own
    // count re-check + channels INSERT + member INSERTs, all on one
    // client, so a failure anywhere below rolls back everything,
    // including the status flip (Req 23.5, 23.6). ---
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Authoritative re-check (Req 23.8): re-read the row on THIS
      // client/transaction, guarding against a concurrent approve/deny
      // that committed between the pre-fetch above and this point.
      const requestResult = await client.query(
        "SELECT * FROM channel_requests WHERE id = $1 AND status = 'pending'",
        [requestId]
      );

      if (requestResult.rows.length === 0) {
        throw new ChannelRequestAlreadyProcessedError();
      }

      const request = requestResult.rows[0];

      // Set status='approved' + processed_by/processed_at (Req 23.5).
      await client.query(
        `UPDATE channel_requests
         SET status = 'approved', processed_by = $2, processed_at = NOW()
         WHERE id = $1`,
        [requestId, approverId]
      );

      // Channel.createCustomChannel's Phase 2 -- the same count re-check
      // + channels INSERT + member INSERTs it would run on its own
      // internally-managed client, now run on THIS transaction's client
      // instead, so it commits/rolls back atomically with the status
      // flip above.
      const channel = await Channel.insertCustomChannelAndMembers(
        request.team_id,
        request.custom_suffix,
        request.member_permissions,
        prepared,
        client
      );

      await client.query('COMMIT');
      return channel;
    } catch (error) {
      await client.query('ROLLBACK');

      // Mirror Channel.createCustomChannel's own 40001-as-ChannelLimitError
      // handling, since this transaction runs at the same SERIALIZABLE
      // isolation level and can surface the same commit-time conflict.
      if (error.code === '40001' && !(error instanceof Channel.ChannelLimitError)) {
        logger.error(
          { err: error, requestId, teamId: preFetchedRequest.team_id },
          'Serialization failure approving channel request; treating as limit reached'
        );
        throw new Channel.ChannelLimitError();
      }

      if (!(error instanceof ChannelRequestAlreadyProcessedError)) {
        logger.error({ err: error, requestId }, 'Error approving channel request; rolled back, request remains pending');
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Requirement 23.7-23.8 (task 45.3): denies a pending `channel_requests`
   * row, recording the `denial_reason`.
   *
   * Per `design.md`'s Section 19: "`denyChannelRequest` is a simple
   * status update to `'denied'` with `denial_reason`, no transaction
   * needed since nothing else is written." Unlike `approveChannelRequest`,
   * this method never calls `Channel.createCustomChannel` and never
   * touches Authentik, so there is nothing else that needs to commit or
   * roll back alongside the status flip -- a single `pool.query` UPDATE
   * suffices.
   *
   * The `status = 'pending'` guard on the `WHERE` clause is the
   * authoritative re-check for Req 23.8 (mirroring
   * `approveChannelRequest`'s pre-fetch-then-re-check pattern, collapsed
   * into one statement here since there is no transaction to re-check
   * inside of): if the row doesn't exist, or its `status` is no longer
   * `'pending'`, the `UPDATE` affects zero rows and no mutation occurs,
   * exactly as required by Req 23.8 ("SHALL NOT modify the
   * `channel_requests` row").
   *
   * Authorization ("Global_Manager OR admin of the parent team of the
   * request's `team_id`", Req 23.4) is deliberately NOT checked here,
   * for the same reason it isn't checked in `approveChannelRequest`:
   * that belongs at the route/Permission_Registry layer (task 45.4).
   *
   * @param {number|string} requestId - `channel_requests.id`.
   * @param {number} denierId - local `users.id` of the authorized denier.
   * @param {string} denialReason
   * @returns {Promise<object>} the updated `channel_requests` row.
   * @throws {ChannelRequestAlreadyProcessedError} if the request does not
   *   exist or its `status` is not `'pending'` (Req 23.8) -- no mutation
   *   occurs in this case.
   */
  static async denyChannelRequest(requestId, denierId, denialReason) {
    const result = await pool.query(
      `UPDATE channel_requests
       SET status = 'denied', denial_reason = $2, processed_by = $3, processed_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [requestId, denialReason, denierId]
    );

    if (result.rows.length === 0) {
      throw new ChannelRequestAlreadyProcessedError();
    }

    return result.rows[0];
  }

  /**
   * Resolves whether the given local user id is a Global_Manager, per
   * `users.is_global_manager` -- the same server-side source of truth
   * already used elsewhere in this codebase (Requirement 4 Criterion 4;
   * `GlobalChannelService.getBchChannelCredentials`'s identical query
   * shape).
   *
   * @param {number} userId - local `users.id`.
   * @returns {Promise<boolean>}
   */
  static async isGlobalManager(userId) {
    const result = await pool.query(
      'SELECT is_global_manager FROM users WHERE id = $1',
      [userId]
    );
    return Boolean(result.rows[0]?.is_global_manager);
  }
}

ChannelRequestService.ChannelRequestAlreadyProcessedError = ChannelRequestAlreadyProcessedError;

module.exports = ChannelRequestService;
