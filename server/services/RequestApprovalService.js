const pool = require('../config/database');
const EmailService = require('./EmailService');
const UserProvisioningService = require('./UserProvisioningService');
const { TeamTransferService } = require('./TeamTransferService');
const EventPublisher = require('./EventPublisher');
const UserAttributesService = require('./userAttributes');
const Team = require('../models/Team');
const { getLogger } = require('../middleware/requestContext');
const crypto = require('crypto');

class RequestApprovalService {
  constructor() {
    this.emailService = new EmailService();
  }

  async createAccessRequest(requestData) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Generate verification token
      const token = crypto.randomBytes(32).toString('hex');
      const expiryHours = await this.getConfigValue('email_verification_hours', '24');
      const expiresAt = new Date(Date.now() + parseInt(expiryHours) * 60 * 60 * 1000);
      
      // Calculate escalation time (24 hours from now, excluding weekends if configured)
      const escalatesAt = await this.calculateEscalationTime();
      
      // Insert request
      //
      // Requirement 11.9: `callsign_suffix` stores whatever the requester
      // submitted (or `null` if omitted) -- this is the same "accept an
      // optional field" behavior regardless of the target Team's
      // Organisation's `callsign_name_format`; only the REQUIRED-ness of
      // supplying it is format-conditional, enforced by the caller
      // (`POST /api/requests/team-access`), not here.
      const result = await client.query(`
        INSERT INTO access_requests (
          request_type, requester_email, requester_first_name, requester_last_name,
          existing_user_id, target_team_id, current_team_id, requested_role,
          requested_first_name, requested_last_name, justification, callsign_suffix,
          email_verification_token, email_verification_expires_at, escalates_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id
      `, [
        requestData.request_type,
        requestData.requester_email,
        requestData.requester_first_name,
        requestData.requester_last_name,
        requestData.existing_user_id || null,
        requestData.target_team_id || null,
        requestData.current_team_id || null,
        requestData.requested_role || null,
        requestData.requested_first_name || null,
        requestData.requested_last_name || null,
        requestData.justification,
        requestData.callsign_suffix || null,
        token,
        expiresAt,
        escalatesAt
      ]);
      
      const requestId = result.rows[0].id;
      
      // Send verification email
      await this.emailService.sendVerificationEmail(requestData.requester_email, token, requestData.requester_first_name || '');
      
      await client.query('COMMIT');
      return { requestId, token };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyEmail(token) {
    const result = await pool.query(`
      UPDATE access_requests 
      SET email_verified = true 
      WHERE email_verification_token = $1 
        AND email_verification_expires_at > NOW() 
        AND status = 'pending'
      RETURNING id, requester_email, target_team_id
    `, [token]);
    
    if (result.rows.length === 0) {
      throw new Error('Invalid or expired verification token');
    }
    
    const request = result.rows[0];
    
    // Assign to appropriate admin
    await this.assignToAdmin(request.id, request.target_team_id);
    
    return request;
  }

  async assignToAdmin(requestId, teamId) {
    if (!teamId) return;
    
    // Find team admins
    const adminResult = await pool.query(`
      SELECT u.id, u.email, u.first_name, u.last_name
      FROM users u
      JOIN team_memberships tm ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND tm.role IN ('admin', 'owner')
      ORDER BY RANDOM()
      LIMIT 1
    `, [teamId]);
    
    if (adminResult.rows.length > 0) {
      const admin = adminResult.rows[0];
      await pool.query(
        'UPDATE access_requests SET assigned_to_admin = $1 WHERE id = $2',
        [admin.id, requestId]
      );
    }
  }

  /**
   * Requirement 18.1 (task 38.1): for `request_type === 'new_account'`,
   * the Authentik user must be created BEFORE any database transaction
   * opens -- an external HTTP call must never be issued while a `pg`
   * transaction is open, matching the pattern established for
   * `POST /api/users/create-and-add` (task 36.1). This means the
   * request row has to be read once, up front, via a plain (non-
   * transactional) `pool.query` call -- BEFORE `pool.connect()`/`BEGIN`
   * -- so the Authentik user can be created (for `new_account` requests
   * only) ahead of the transactional section that follows.
   *
   * Requirement 18.4 (task 38.4), updated by task 11.1 (Requirement
   * 11.8): `request_type === 'name_change'` has the exact same
   * constraint -- updating the Authentik user's DISPLAY name is an
   * external HTTP call (a PATCH) and must happen here in Phase 1, before
   * any transactional client is acquired. Per Requirement 11.8 (a stored
   * `callsign_suffix` is NEVER recomputed by a name correction), this
   * PATCH is the only Authentik call a name change makes -- it no
   * longer computes or pushes a regenerated callsign/color/role, since
   * none of those attributes derive from the live name anymore.
   *
   * The transactional section re-fetches the row with
   * `AND status = 'pending'` (as before) so a request that was approved/
   * denied concurrently between the pre-fetch and this point is still
   * correctly rejected.
   *
   * Requirement 11.12/11.13/11.15/11.16 (task 24.3), extended by
   * Requirement 9.4 (task 10.1): `callsignSuffixOverride` is an optional
   * 4th parameter honoured by `new_account` AND by `team_change`.
   *
   *  - `new_account` is the sole request type that creates a brand-new
   *    user, and so the only one that resolves/stores an INITIAL
   *    `callsign_suffix` at approval time (resolution order below).
   *  - `team_change` (Requirement 9.4) operates on an existing user, but
   *    a transfer can collide with the Destination_Team's Member_List,
   *    so the approving admin may supply a replacement suffix on the
   *    approval. The value becomes the highest-precedence link of
   *    Requirement 9.7's chain and is stored on the approval
   *    transaction by `TeamTransferService.executeTransfer` -- this
   *    method passes it straight through rather than resolving it,
   *    because links (b) `access_requests.callsign_suffix` and (c) the
   *    user's stored `users.callsign_suffix` are resolved together
   *    inside that one transactional step.
   *  - `role_change`/`name_change` never touch a `callsign_suffix`
   *    (Requirement 11.8: never silently recomputed), so an override
   *    supplied on one of those is ignored -- never applied, never an
   *    error.
   *
   * `approverIsGlobalManager` is the approving user's
   * `req.user.is_global_manager`, threaded through to
   * `executeTransfer`'s `actorIsGlobalManager`. Requirement 11.6's
   * cross-Organisation exemption is evaluated against the APPROVING
   * user, not against the Initiating_Admin recorded in `initiated_by`,
   * so a request created inside one Organisation and approved after a
   * reparenting is rejected unless the approver is themselves a
   * Global_Manager. It defaults to `false` so an omitted argument fails
   * closed.
   *
   * For `new_account`, the effective value (override > the request's own
   * stored `callsign_suffix` > the computed default, matching task
   * 24.2's exact computation) is resolved and uniqueness-checked via
   * `checkCallsignSuffixUniqueness` EARLY -- before
   * `createAuthentikUserForNewAccount` is ever called below -- so a
   * `CallsignSuffixConflictError` here never results in an orphaned
   * Authentik user needing compensation (the same reasoning already
   * applied in task 22.2 for the other creation entry points). This
   * check is a pure DB read (via `Team.getFullMemberList`), so it can
   * safely run before Phase 1's Authentik call without risk of a
   * partially-committed side effect.
   */
  async approveRequest(requestId, adminId, additionalDetails = '', callsignSuffixOverride = null, approverIsGlobalManager = false) {
    // --- Phase 1: pre-fetch (no open transaction) + Authentik user
    // creation for new_account requests, and the Authentik display-name
    // update for name_change requests. ---
    const preFetchResult = await pool.query(
      'SELECT * FROM access_requests WHERE id = $1 AND status = $2',
      [requestId, 'pending']
    );

    if (preFetchResult.rows.length === 0) {
      throw new Error('Request not found or already processed');
    }

    const preFetchedRequest = preFetchResult.rows[0];
    let newAccountAuthentikUser = null;
    let resolvedCallsignSuffix = null;
    let resolvedUsername = null;
    let resolvedClaimId = null;
    let resolvedReclaimedUserId = null;

    if (preFetchedRequest.request_type === 'new_account') {
      // account-lifecycle-management Requirement 5.2/5.3 (task 11.1): a
      // Reclaimable_Account lookup, run BEFORE `createAuthentikUserForNewAccount`
      // below -- a plain DB read with no external-call ordering constraint of
      // its own, so it fits naturally alongside the identity resolution that
      // already runs here in Phase 1. `resolvedClaimId` (the pseudonymous
      // Claim_Row mechanism) and `resolvedReclaimedUserId` (this one) are
      // deliberately mutually exclusive -- a request's email can match AT MOST
      // one of "a Claim_Row this same sign-up flow just inserted" or "an
      // unrelated, pre-existing orphaned row" -- so this lookup only runs when
      // no Claim_Row was resolved, and `UserProvisioningService.createAndAddUser`
      // itself also treats the two params as mutually exclusive (see its own
      // doc comment).
      const resolvedIdentity = await this.resolveAndCheckCallsignSuffixForApproval(
        preFetchedRequest,
        callsignSuffixOverride
      );
      resolvedCallsignSuffix = resolvedIdentity.callsignSuffix;
      resolvedUsername = resolvedIdentity.username;
      resolvedClaimId = resolvedIdentity.claimId;

      if (resolvedClaimId == null) {
        const reclaimResult = await pool.query(
          `SELECT id FROM users WHERE email = $1 AND account_status = 'orphaned' LIMIT 1`,
          [preFetchedRequest.requester_email]
        );
        resolvedReclaimedUserId = reclaimResult.rows[0]?.id ?? null;
      }

      newAccountAuthentikUser = await this.createAuthentikUserForNewAccount(preFetchedRequest, resolvedUsername);
    }

    if (preFetchedRequest.request_type === 'name_change') {
      await this.updateAuthentikNameForNameChange(preFetchedRequest);
    }

    // --- Phase 2: single transaction for the status update + the
    // type-specific state change. ---
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get request details.
      //
      // Requirement 11.5: `FOR UPDATE OF ar` locks the access_requests row
      // for the duration of this transaction, so a second concurrent
      // approval blocks here and then observes status = 'approved' (0 rows)
      // instead of both approvals passing the `status = 'pending'` filter
      // under READ COMMITTED. `OF ar` is required — a bare FOR UPDATE would
      // also try to lock the nullable side of the LEFT JOINs, which Postgres
      // rejects. This applies to every request type, not just team_change.
      const requestResult = await client.query(`
        SELECT ar.*, t.name as team_name, u.first_name as admin_first_name, u.last_name as admin_last_name
        FROM access_requests ar
        LEFT JOIN teams t ON ar.target_team_id = t.id
        LEFT JOIN users u ON u.id = $2
        WHERE ar.id = $1 AND ar.status = 'pending'
        FOR UPDATE OF ar
      `, [requestId, adminId]);
      
      if (requestResult.rows.length === 0) {
        throw new Error('Request not found or already processed');
      }
      
      const request = requestResult.rows[0];

      // Requirement 18.5 (task 38.5): validate that `existing_user_id`/
      // `target_team_id` still reference an existing row BEFORE the
      // status UPDATE below runs, rather than relying on a type-specific
      // branch (e.g. role_change's zero-rows-updated check) to discover
      // the problem only after 'approved' has already been written in
      // this same transaction. A thrown error here is caught by this
      // method's existing catch/ROLLBACK, so the request is naturally
      // left 'pending' with no local mutation having occurred.
      //
      // Field relevance:
      //  - existing_user_id is referenced by team_change, role_change,
      //    and name_change (new_account has no existing_user_id -- it
      //    creates a brand new user).
      //  - target_team_id is referenced by new_account and team_change
      //    (role_change/name_change use current_team_id instead, which
      //    remains covered by task 38.3's zero-rows UPDATE check).
      if (['team_change', 'role_change', 'name_change'].includes(request.request_type)) {
        const existingUserCheck = await client.query('SELECT 1 FROM users WHERE id = $1', [request.existing_user_id]);
        if (existingUserCheck.rows.length === 0) {
          throw new Error(`Referenced user no longer exists: ${request.existing_user_id}`);
        }
      }

      if (['new_account', 'team_change'].includes(request.request_type)) {
        const targetTeamCheck = await client.query('SELECT 1 FROM teams WHERE id = $1', [request.target_team_id]);
        if (targetTeamCheck.rows.length === 0) {
          throw new Error(`Referenced team no longer exists: ${request.target_team_id}`);
        }
      }

      // Update request status
      await client.query(`
        UPDATE access_requests 
        SET status = 'approved', processed_by = $2, processed_at = NOW()
        WHERE id = $1
      `, [requestId, adminId]);
      
      // Process the request based on type
      const processResult = await this.processApprovedRequest(client, request, {
        newAccountAuthentikUser,
        adminId,
        resolvedCallsignSuffix,
        resolvedUsername,
        resolvedClaimId,
        resolvedReclaimedUserId,
        callsignSuffixOverride,
        approverIsGlobalManager
      });
      
      await client.query('COMMIT');

      // Send approval email for non-new_account types (they don't have Phase 3)
      if (request.request_type !== 'new_account') {
        try {
          let teamPath = request.team_name || '';
          try {
            const ancestorChain = await Team.getAncestorChain(request.target_team_id);
            if (ancestorChain.length <= 1) {
              teamPath = ancestorChain[0]?.name || request.team_name || '';
            } else {
              const segments = ancestorChain.map((t, i) => {
                if (i === ancestorChain.length - 1) return t.name;
                return t.callsign_prefix || t.name;
              });
              teamPath = segments.join(' - ');
            }
          } catch (pathErr) {}

          await this.emailService.sendApprovalEmail(
            request.requester_email,
            {
              teamPath,
              username: request.requester_email,
              firstName: request.requested_first_name || request.requester_first_name || '',
              callsign: '',  // non-new_account requests don't generate a callsign
              additionalDetails
            }
          );
        } catch (emailErr) {
          getLogger().error({ err: emailErr }, 'Failed to send approval email');
        }
      }

      // --- Post-commit effects for an approved Transfer_Request
      // (Requirements 8, 13, 14, via task 10.1).
      //
      // Runs strictly AFTER `COMMIT` (Requirement 8.4 -- no external HTTP
      // request while a transaction is open) and after the approval email
      // above, so the ordering of the two notifications matches the order
      // a reviewer sees them in the design's approval sequence.
      // `applyPostCommitEffects` never throws: each of its five steps is
      // individually try/caught and logged, leaving the committed
      // membership change in place and this method's response at
      // `{ success: true }` (Requirements 8.5, 13.4, 14.4).
      if (request.request_type === 'team_change' && processResult?.transferOutcome) {
        await TeamTransferService.applyPostCommitEffects(processResult.transferOutcome);
      }

      // --- Phase 3 (new_account only): eagerly upsert user_cache, same
      // as POST /api/users/create-and-add's own Phase 3
      // (server/routes/users.js). Without this, a newly-approved user
      // only appears in user_cache once the next periodic Authentik sync
      // runs (authentikSync.js, every SYNC_INTERVAL_MINUTES, default 10
      // minutes) -- authenticateToken/GET /api/auth/me's
      // authentikSync.getUserFromCache lookup would return nothing for
      // that user in the meantime, and the OAuth2 callback would
      // redirect with ?error=user_not_synced on their very first login
      // attempt right after approval. Best-effort: runs strictly after
      // COMMIT (an Authentik call must never run inside an open
      // transaction), and its own failure must not undo the already-
      // committed approval.
      if (request.request_type === 'new_account' && newAccountAuthentikUser && processResult?.localUserId) {
        try {
          const email = request.requester_email;
          const firstName = request.requested_first_name || request.requester_first_name;
          const lastName = request.requested_last_name || request.requester_last_name;
          // takserver-enrollment Requirement 6.6 (task 5.2): the resolved
          // username (which may be a minted Pseudonymous_Username, not
          // `email`) already used to create the Authentik user and the
          // local `users` row above -- carried into this best-effort
          // `user_cache` upsert too, so the cache never disagrees with
          // what was actually created.
          const username = resolvedUsername;

          const attributes = await UserAttributesService.generateCallsign(processResult.localUserId, request.target_team_id);
          if (attributes) {
            await UserAttributesService.updateUserAttributes(newAccountAuthentikUser.pk, attributes);
          }

          await pool.query(
            'INSERT INTO user_cache (authentik_id, username, email, first_name, last_name, is_active, tak_callsign, tak_color, tak_role) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8) ON CONFLICT (authentik_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, tak_callsign = $6, tak_color = $7, tak_role = $8',
            [newAccountAuthentikUser.pk, username, email, firstName, lastName, attributes?.callsign, attributes?.color, attributes?.role]
          );

          // Send approval email (after commit so callsign_suffix is readable)
          let teamPath = request.team_name || '';
          try {
            const ancestorChain = await Team.getAncestorChain(request.target_team_id);
            if (ancestorChain.length <= 1) {
              teamPath = ancestorChain[0]?.name || request.team_name || '';
            } else {
              const segments = ancestorChain.map((t, i) => {
                if (i === ancestorChain.length - 1) return t.name;
                return t.callsign_prefix || t.name;
              });
              teamPath = segments.join(' - ');
            }
          } catch (pathErr) {
            // Fall back to team_name
          }

          await this.emailService.sendApprovalEmail(
            request.requester_email,
            {
              teamPath,
              username: request.requester_email,
              firstName: request.requested_first_name || request.requester_first_name || '',
              callsign: attributes?.callsign || '',
              additionalDetails
            }
          );
        } catch (postCommitError) {
          // Logged, not thrown: the approval itself already committed
          // successfully. Worst case, this user_cache row still gets
          // populated by the next periodic Authentik sync.
          getLogger().error(
            { err: postCommitError, authentikUserId: newAccountAuthentikUser.pk },
            'Access request approval: post-commit user_cache upsert failed; user will remain unable to log in until the next periodic Authentik sync'
          );
        }
      }

      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');

      // Requirement 17.2's compensating-action pattern applies whenever a
      // `new_account` approval's local transaction fails AFTER the
      // Authentik user has already been created in Phase 1: that
      // Authentik user is now orphaned (no corresponding local `users`
      // row/team membership was committed). This mirrors the
      // synchronous-delete-then-queued-fallback logic already built for
      // `POST /api/users/create-and-add` (task 36.2, `server/routes/users.js`):
      // attempt a SYNCHRONOUS delete of the orphaned Authentik user
      // first; only if that delete attempt itself fails do we fall back
      // to enqueueing a `cleanup_orphaned_authentik_user` Sync_Operation
      // for the Sync_Worker to retry asynchronously. Either outcome --
      // and the (rare) case where even the enqueue fails -- is logged
      // via the structured logger with the exact `{authentikUserId,
      // failedStep, compensationOutcome}` shape used by that route, for
      // consistency.
      if (newAccountAuthentikUser) {
        const failedStep = 'local_transaction';
        let compensationOutcome;
        try {
          const deleteResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${newAccountAuthentikUser.pk}/`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
          });

          if (deleteResponse.ok || deleteResponse.status === 404) {
            compensationOutcome = 'deleted_synchronously';
          } else {
            throw new Error(`Authentik delete responded with status ${deleteResponse.status}`);
          }
        } catch (deleteError) {
          getLogger().error(
            { err: deleteError, authentikUserId: newAccountAuthentikUser.pk },
            'Synchronous compensating Authentik user delete failed; falling back to a queued cleanup operation'
          );
          try {
            await EventPublisher.publishOperation(
              'cleanup_orphaned_authentik_user',
              { authentik_user_id: newAccountAuthentikUser.pk },
              adminId ?? null
            );
            compensationOutcome = 'cleanup_operation_queued';
          } catch (enqueueError) {
            getLogger().error(
              { err: enqueueError, authentikUserId: newAccountAuthentikUser.pk },
              'Failed to enqueue cleanup_orphaned_authentik_user compensating operation'
            );
            compensationOutcome = 'compensation_failed';
          }
        }

        getLogger().error(
          { authentikUserId: newAccountAuthentikUser.pk, failedStep, compensationOutcome },
          'Access request approval: Authentik user created but local transaction failed; orphaned Authentik user compensating action outcome'
        );
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * takserver-enrollment Requirements 6.6, 9.1, 9.2, 9.3 (task 5.2): a
   * THIN ADAPTER over `UserProvisioningService.resolveNewUserIdentity`,
   * replacing this method's own `computeDefaultCallsignSuffix` call and
   * its own `Team.getAncestorChain` read (both REMOVED) -- both are now
   * `resolveNewUserIdentity`'s job, from the SAME single ancestor-chain
   * read the resolver already performs. This is the consolidation
   * Criterion 9.3 requires before Callsign_Default_Suppression can be
   * relied on anywhere: `CallsignService.computeDefaultCallsignSuffix`
   * had three callers before this task, and this was one of them --
   * left alone, a member self-signing-up into a Pseudonymous_Organisation
   * (this exact path) would have received a name-derived callsign on
   * the commonest creation path, while every other path looked correct.
   *
   * This method's job is now narrower: adapt the pre-fetched
   * `access_requests` row into `resolveNewUserIdentity`'s parameter
   * shape, and figure out the single `requestedCallsignSuffix` value to
   * pass through -- the resolver itself decides what to do with it
   * (compute a default when the policy is disabled, or demand an
   * explicit value with no default when enabled).
   *
   * Field mapping onto `resolveNewUserIdentity`'s params:
   *   - `firstName`/`lastName`: `request.requested_first_name ||
   *     request.requester_first_name` / the `_last_name` equivalent --
   *     the EXACT derivation this method already used.
   *   - `email`: `request.requester_email`.
   *   - `teamId`: `request.target_team_id`.
   *   - `requestedUsername`: `request.requester_email` -- the existing
   *     `new_account` branch's `const username = email` derivation,
   *     unchanged when the policy is disabled (the resolver returns it
   *     verbatim in that case; Criterion 6.8).
   *   - `requestedCallsignSuffix`: this method's OWN resolution of
   *     (1) `callsignSuffixOverride` when non-empty, else (2)
   *     `request.callsign_suffix` -- the same first two links of the
   *     old three-link precedence chain. The THIRD link (the computed
   *     default) is deliberately NOT resolved here anymore:
   *     `resolveNewUserIdentity` computes it internally when the policy
   *     is disabled, and suppresses it (demanding an explicit value)
   *     when the policy is enabled -- this adapter has no way to know
   *     which of those applies without duplicating the resolver's own
   *     ancestor-chain read, which is exactly the duplication this
   *     consolidation removes.
   *
   * `resolveNewUserIdentity` itself runs
   * `checkCallsignSuffixUniqueness` (Requirement 9.4, unchanged) and,
   * when the target Organisation's Pseudonymous_Username_Policy is
   * enabled, mints a Pseudonymous_Username and inserts a Claim_Row via
   * `ManagedIdentifierService.mintUniqueIdentifier` -- see that
   * function's own doc comment for the full resolution order. Both
   * still run, and a `CallsignSuffixConflictError` /
   * `CallsignSuffixRequiredError` /
   * `ManagedIdentifierService.OrganisationPrefixMissingError` /
   * `ManagedIdentifierExhaustionError` still propagates naturally out of
   * `approveRequest` at this point -- before Phase 1/Phase 2 have done
   * anything at all, so nothing needs rolling back.
   *
   * @param {object} request - the pre-fetched `access_requests` row.
   * @param {string|null} callsignSuffixOverride - the reviewer's
   *   optional override supplied on this approve request.
   * @returns {Promise<{
   *   username: string,
   *   callsignSuffix: string,
   *   pseudonymous: boolean,
   *   claimId: number|null
   * }>} `username`/`callsignSuffix` are the exact shape callers already
   *   expect from this method's return value. `pseudonymous`/`claimId`
   *   are ADDED alongside them -- `approveRequest`/`processApprovedRequest`
   *   need `claimId` later in this same task to adopt the Claim_Row
   *   `resolveNewUserIdentity` inserted (when pseudonymous) rather than
   *   re-inserting and colliding on the username it just claimed.
   */
  async resolveAndCheckCallsignSuffixForApproval(request, callsignSuffixOverride) {
    const trimmedOverride = callsignSuffixOverride ? callsignSuffixOverride.trim() : '';
    const requestedCallsignSuffix = trimmedOverride || request.callsign_suffix || undefined;

    const firstName = request.requested_first_name || request.requester_first_name;
    const lastName = request.requested_last_name || request.requester_last_name;

    const identity = await UserProvisioningService.resolveNewUserIdentity(null, {
      firstName,
      lastName,
      email: request.requester_email,
      teamId: request.target_team_id,
      requestedUsername: request.requester_email,
      requestedCallsignSuffix
    });

    return {
      username: identity.username,
      callsignSuffix: identity.callsignSuffix,
      pseudonymous: identity.pseudonymous,
      claimId: identity.claimId
    };
  }

  /**
   * Requirement 18.1 (task 38.1): creates the Authentik user for a
   * `new_account` request, mirroring `POST /api/users/create-and-add`'s
   * existing-email check + create-user call (`server/routes/users.js`).
   * Runs strictly before any transactional client is acquired.
   *
   * takserver-enrollment Requirement 6.6 (task 5.2): `resolvedUsername`
   * is now REQUIRED and is what gets sent to Authentik as `username` --
   * this can no longer always be `request.requester_email`, because
   * `resolveAndCheckCallsignSuffixForApproval` may have already resolved
   * a DIFFERENT username (a minted Pseudonymous_Username) and even
   * already inserted a Claim_Row under it via
   * `UserProvisioningService.resolveNewUserIdentity`. Using
   * `request.requester_email` unconditionally here, as this method did
   * before this task, would create the Authentik user under the WRONG
   * name whenever the target Organisation is pseudonymous.
   *
   * @param {object} request - the pre-fetched `access_requests` row.
   * @param {string} resolvedUsername - the username already resolved by
   *   `resolveAndCheckCallsignSuffixForApproval` (the caller-supplied
   *   email verbatim when the target Organisation's
   *   Pseudonymous_Username_Policy is disabled; a freshly minted
   *   Pseudonymous_Username when enabled).
   * @returns {Promise<{pk: number|string}>} the created Authentik user.
   */
  async createAuthentikUserForNewAccount(request, resolvedUsername) {
    const email = request.requester_email;
    const firstName = request.requested_first_name || request.requester_first_name;
    const lastName = request.requested_last_name || request.requester_last_name;
    const username = resolvedUsername;

    const existingUserResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
    });
    const existingUsers = await existingUserResponse.json();

    if (existingUsers.results && existingUsers.results.length > 0) {
      throw new Error('User with this email already exists');
    }

    const createUserResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username,
        email,
        name: `${firstName} ${lastName}`,
        first_name: firstName,
        last_name: lastName,
        is_active: true
      })
    });

    if (!createUserResponse.ok) {
      const errorData = await createUserResponse.json().catch(() => ({}));
      const error = new Error('Failed to create user in Authentik');
      error.details = errorData;
      throw error;
    }

    return createUserResponse.json();
  }

  /**
   * Requirement 18.4 (task 38.4), updated by task 11.1 (Requirement
   * 11.8): performs the Authentik DISPLAY-name PATCH needed for a
   * `name_change` approval, strictly before any transactional client is
   * acquired (mirroring `new_account`'s Phase 1/Phase 2 split). Runs
   * against the PRE-FETCHED request row (i.e. before Phase 2's
   * transaction re-reads it), using
   * `request.requested_first_name`/`requested_last_name` as the new name
   * values and `request.existing_user_id` to resolve the user's
   * Authentik id.
   *
   * Per Requirement 11.8, a stored `callsign_suffix` is NEVER
   * recomputed by a name correction, so a name change no longer implies
   * any callsign/color/role regeneration -- this function performs only
   * the Authentik name-metadata PATCH and nothing else.
   *
   * @param {object} request - the pre-fetched `access_requests` row.
   * @returns {Promise<void>}
   */
  async updateAuthentikNameForNameChange(request) {
    const firstName = request.requested_first_name;
    const lastName = request.requested_last_name;

    const userResult = await pool.query(
      'SELECT authentik_user_id FROM users WHERE id = $1',
      [request.existing_user_id]
    );

    if (userResult.rows.length === 0) {
      throw new Error(`Cannot apply name change: user ${request.existing_user_id} not found`);
    }

    const authentikUserId = userResult.rows[0].authentik_user_id;

    // Update the user's name in Authentik.
    const patchNameResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: `${firstName} ${lastName}`,
        first_name: firstName,
        last_name: lastName
      })
    });

    if (!patchNameResponse.ok) {
      const errorData = await patchNameResponse.json().catch(() => ({}));
      const error = new Error('Failed to update user name in Authentik');
      error.details = errorData;
      throw error;
    }
  }

  async denyRequest(requestId, adminId, denialReason) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get request details
      const requestResult = await client.query(`
        SELECT ar.*, u.first_name as admin_first_name, u.last_name as admin_last_name
        FROM access_requests ar
        LEFT JOIN users u ON u.id = $2
        WHERE ar.id = $1 AND ar.status = 'pending'
      `, [requestId, adminId]);
      
      if (requestResult.rows.length === 0) {
        throw new Error('Request not found or already processed');
      }
      
      const request = requestResult.rows[0];
      
      // Update request status
      await client.query(`
        UPDATE access_requests 
        SET status = 'denied', processed_by = $2, processed_at = NOW(), denial_reason = $3
        WHERE id = $1
      `, [requestId, adminId, denialReason]);
      
      // Send denial email
      let denialTeamPath = request.team_name || '';
      try {
        const denialAncestorChain = await Team.getAncestorChain(request.target_team_id);
        if (denialAncestorChain.length <= 1) {
          denialTeamPath = denialAncestorChain[0]?.name || request.team_name || '';
        } else {
          const segments = denialAncestorChain.map((t, i) => {
            if (i === denialAncestorChain.length - 1) return t.name;
            return t.callsign_prefix || t.name;
          });
          denialTeamPath = segments.join(' - ');
        }
      } catch (pathErr) {
        // Fall back to just team_name
      }

      await client.query('COMMIT');

      // Requirement 12.4: the denial decision is committed BEFORE the
      // notification is attempted, and a failed send is logged rather than
      // rethrown -- so a refused SMTP connection leaves the row `denied`
      // and the route's response at 200. Previously this send sat inside
      // the transaction, so any email failure rolled the decision back and
      // surfaced as a 500, silently discarding a decision the admin had
      // already made. Mirrors `approveRequest`'s own post-COMMIT,
      // try/caught approval email.
      try {
        await this.emailService.sendDenialEmail(
          request.requester_email,
          {
            teamPath: denialTeamPath,
            firstName: request.requested_first_name || request.requester_first_name || '',
            denialReason
          }
        );
      } catch (emailErr) {
        getLogger().error({ err: emailErr }, 'Failed to send denial email');
      }

      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async processApprovedRequest(client, request, { newAccountAuthentikUser, adminId, resolvedCallsignSuffix = null, resolvedUsername = null, resolvedClaimId = null, resolvedReclaimedUserId = null, callsignSuffixOverride = null, approverIsGlobalManager = false } = {}) {
    switch (request.request_type) {
      case 'new_account': {
        // Requirement 18.1 (task 38.1): the Authentik user was already
        // created in Phase 1 (before this transaction opened); every
        // local write (users upsert, team_memberships incl. inheritance,
        // channel_memberships) now runs through the same shared
        // `UserProvisioningService.createAndAddUser` used by
        // `POST /api/users/create-and-add`, on this transaction's
        // already-open `client`.
        const email = request.requester_email;
        const firstName = request.requested_first_name || request.requester_first_name;
        const lastName = request.requested_last_name || request.requester_last_name;

        // takserver-enrollment Requirement 6.6 (task 5.2): `username` is
        // now `resolvedUsername`, taken from the Phase-1 adapter's
        // result -- NOT `const username = email` as before this task.
        // Under a policy-disabled Organisation this is still exactly
        // `email` (the resolver returns `requestedUsername` verbatim in
        // that case); under a pseudonymous one it is the minted
        // Pseudonymous_Username already used to create the Authentik
        // user above.
        const username = resolvedUsername;

        // Requirement 11.13 (task 24.3): `resolvedCallsignSuffix` was
        // already resolved and uniqueness-checked in Phase 1 (see
        // `resolveAndCheckCallsignSuffixForApproval`), before the
        // Authentik user was even created -- passed through here to be
        // persisted on the new user's row.
        //
        // Returned so the caller (approveRequest) can run Phase 3 (the
        // post-commit user_cache upsert below) -- see that method's
        // comment for why this is necessary.
        return await UserProvisioningService.createAndAddUser(client, {
          authentikUserId: newAccountAuthentikUser.pk,
          username,
          email,
          firstName,
          lastName,
          teamId: request.target_team_id,
          callsign_suffix: resolvedCallsignSuffix,
          createdBy: adminId ?? null,
          // takserver-enrollment Requirement 6.6 (task 5.2): when the
          // target Organisation is pseudonymous, `resolvedClaimId` names
          // the Claim_Row `resolveNewUserIdentity` already inserted under
          // `username` above -- `createAndAddUser` adopts that exact row
          // (`UPDATE ... WHERE id = $claimId`) instead of its generic
          // upsert, which cannot match a Claim_Row's NULL
          // `authentik_user_id` under `ON CONFLICT`. `null` (the default)
          // for a policy-disabled Organisation, where no Claim_Row exists.
          claimId: resolvedClaimId,
          // account-lifecycle-management Requirement 5.3 (task 11.1): when
          // this request's verified email matched a Reclaimable_Account
          // (Phase 1, above), `resolvedReclaimedUserId` names that existing
          // orphaned row -- `createAndAddUser` adopts it (Requirement 5.5:
          // same `id`, so its full prior audit history stays attributed to
          // it) instead of inserting a second row that would collide with
          // `users_email_key`. `null` when no orphaned match exists, and
          // mutually exclusive with `claimId` (see the Phase-1 comment
          // above resolving it).
          reclaimedUserId: resolvedReclaimedUserId
        });
      }
      case 'team_change': {
        // Requirement 6.1 (task 10.1): the approval path and the
        // immediate path go through ONE method, so the outcome cannot
        // depend on which path was taken.
        //
        // This replaces a bare `TeamMembershipService.addUserToTeam`
        // call, which performed only the ADDITIVE half of a move (the
        // direct membership row, the inherited ancestor rows, the
        // destination channel rows). `executeTransfer` wraps that same
        // call and adds the missing halves around it: the locked
        // precondition re-check (Requirements 11.1, 11.6), the
        // Callsign_Suffix resolution (Requirement 9.7), and the
        // subtractive revocation of Source_Team channel access
        // (Requirement 7).
        //
        // `client` is this transaction's own client, so every membership
        // write commits with the `status = 'approved'` update above or
        // neither does (Requirement 6.6). A throw from here -- including
        // `StaleTransferRequestError`, `CrossOrganisationTransferError`,
        // and `CallsignSuffixConflictError` -- propagates to
        // `approveRequest`'s existing catch/ROLLBACK, which leaves the
        // row `pending` with no extra handling.
        const outcome = await TeamTransferService.executeTransfer(client, {
          userId: request.existing_user_id,
          destinationTeamId: request.target_team_id,
          actorId: adminId ?? null,
          // Requirement 11.6: evaluated against the APPROVING user.
          actorIsGlobalManager: approverIsGlobalManager,
          // Requirement 11.1: the Source_Team this request was created
          // against, re-checked under the Direct_Membership row lock.
          expectedSourceTeamId: request.current_team_id,
          // Requirement 9.7's links (a) and (b), passed SEPARATELY rather
          // than pre-collapsed with `||`. The chain's third link is the
          // user's stored `users.callsign_suffix`, which is only readable
          // inside this transaction, so `executeTransfer` step 3 owns the
          // whole precedence chain -- collapsing (a) and (b) here would
          // split one rule across two files.
          callsignSuffix: callsignSuffixOverride || null,
          requestCallsignSuffix: request.callsign_suffix || null,
          // Requirement 14.3: recorded in the audit `details` only
          // because this transfer went through a Transfer_Request.
          transferRequestId: request.id,
          initiatedBy: request.initiated_by
        });

        // Returned rather than `break`ing, mirroring the `new_account`
        // branch's `{ localUserId }`, so `approveRequest` can run
        // `applyPostCommitEffects` after COMMIT.
        return { transferOutcome: outcome };
      }
      case 'role_change': {
        // Requirement 18.3 (task 38.3): a role_change request never moves
        // the user to a different team -- it only changes the `role`
        // column on their existing DIRECT team membership row
        // (`inherited_from_team_id IS NULL`) for their CURRENT team
        // (`current_team_id`; `target_team_id` is reserved for
        // `new_account`/`team_change` requests, which represent a
        // destination team, not the team a role_change applies to).
        // Because this never changes which team the user belongs to,
        // `TeamMembershipService.addUserToTeam` (which deletes the
        // existing membership row and inserts a new one -- i.e. a team
        // move) is not the right tool here; this runs a direct `UPDATE`
        // on this transaction's already-open `client` instead, so it
        // commits/rolls back atomically with the request's status update
        // (Requirement 18.6/18.7).
        const roleChangeResult = await client.query(
          `UPDATE team_memberships
             SET role = $1
             WHERE user_id = $2 AND team_id = $3 AND inherited_from_team_id IS NULL`,
          [request.requested_role, request.existing_user_id, request.current_team_id]
        );

        // If no row was updated, the user no longer has a direct
        // membership in the team the request was submitted against (e.g.
        // they were removed from the team, or moved to another team,
        // after the request was created). Throwing here causes
        // `approveRequest`'s existing catch/ROLLBACK to fire, leaving the
        // request in `pending` rather than silently marking it approved
        // with no actual role change applied.
        if (roleChangeResult.rowCount === 0) {
          throw new Error(
            `Cannot apply role change: no direct team membership found for user ${request.existing_user_id} in team ${request.current_team_id}`
          );
        }
        break;
      }
      case 'name_change': {
        // Requirement 18.4 (task 38.4), updated by task 11.1
        // (Requirement 11.8): the Authentik DISPLAY-name PATCH already
        // happened in Phase 1, via `updateAuthentikNameForNameChange` --
        // before this transaction opened. A name change no longer
        // implies any callsign/color/role regeneration (a stored
        // `callsign_suffix` is never recomputed by a name correction),
        // so this branch performs ONLY local database writes on this
        // transaction's already-open `client`, so it commits/rolls back
        // atomically with the request's status update (Requirement
        // 18.6/18.7): update `users.first_name`/`last_name`, and mirror
        // the same values onto `user_cache`.
        const firstName = request.requested_first_name;
        const lastName = request.requested_last_name;

        const updatedUserResult = await client.query(
          'UPDATE users SET first_name = $1, last_name = $2 WHERE id = $3 RETURNING authentik_user_id',
          [firstName, lastName, request.existing_user_id]
        );

        if (updatedUserResult.rowCount === 0) {
          throw new Error(`Cannot apply name change: user ${request.existing_user_id} not found`);
        }

        const authentikUserId = updatedUserResult.rows[0].authentik_user_id;

        await client.query(
          'UPDATE user_cache SET first_name = $1, last_name = $2 WHERE authentik_id = $3',
          [firstName, lastName, authentikUserId]
        );
        break;
      }
    }
  }

  async calculateEscalationTime() {
    const escalationHours = await this.getConfigValue('escalation_hours', '24');
    const excludeWeekends = await this.getConfigValue('weekend_escalation', 'false') === 'false';
    
    let escalationTime = new Date(Date.now() + parseInt(escalationHours) * 60 * 60 * 1000);
    
    if (excludeWeekends) {
      // Skip weekends
      while (escalationTime.getDay() === 0 || escalationTime.getDay() === 6) {
        escalationTime.setDate(escalationTime.getDate() + 1);
      }
    }
    
    return escalationTime;
  }

  getRequestDescription(request) {
    switch (request.request_type) {
      case 'new_account':
        return `join team "${request.team_name}"`;
      case 'team_change':
        return `change teams`;
      case 'role_change':
        return `change role to "${request.requested_role}"`;
      case 'name_change':
        return `change name`;
      default:
        return 'access TAK Team Manager';
    }
  }

  async getConfigValue(key, defaultValue) {
    try {
      const result = await pool.query('SELECT config_value FROM system_config WHERE config_key = $1', [key]);
      return result.rows[0]?.config_value || defaultValue;
    } catch (error) {
      return defaultValue;
    }
  }
}

module.exports = RequestApprovalService;