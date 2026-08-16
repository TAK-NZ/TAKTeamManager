const pool = require('../config/database');
const EmailService = require('./EmailService');
const UserProvisioningService = require('./UserProvisioningService');
const TeamMembershipService = require('./TeamMembershipService');
const UserAttributesService = require('./userAttributes');
const EventPublisher = require('./EventPublisher');
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
      const result = await client.query(`
        INSERT INTO access_requests (
          request_type, requester_email, requester_first_name, requester_last_name,
          existing_user_id, target_team_id, current_team_id, requested_role,
          requested_first_name, requested_last_name, justification,
          email_verification_token, email_verification_expires_at, escalates_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
        token,
        expiresAt,
        escalatesAt
      ]);
      
      const requestId = result.rows[0].id;
      
      // Send verification email
      await this.emailService.sendVerificationEmail(requestData.requester_email, token);
      
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
   * Requirement 18.4 (task 38.4): `request_type === 'name_change'` has
   * the exact same constraint -- updating the Authentik user's name is
   * an external HTTP call (a PATCH), and so is the follow-on
   * `UserAttributesService.updateUserAttributes` call needed to push the
   * regenerated callsign. Both must happen here in Phase 1, before any
   * transactional client is acquired. The new callsign is computed via
   * `UserAttributesService.computeCallsignAttributes` using the
   * request's `requested_first_name`/`requested_last_name` values
   * directly (NOT by writing the new name to `users` first and then
   * calling the DB-reading `generateCallsign` -- that would require a
   * write to `users` outside of Phase 2's transaction, breaking
   * atomicity). The user's current team is looked up via a read-only
   * `pool.query` (safe outside a transaction, since it performs no
   * write) so `computeCallsignAttributes` has a `teamId` to resolve the
   * team-hierarchy callsign prefix/format from.
   *
   * The transactional section re-fetches the row with
   * `AND status = 'pending'` (as before) so a request that was approved/
   * denied concurrently between the pre-fetch and this point is still
   * correctly rejected.
   */
  async approveRequest(requestId, adminId, additionalDetails = '') {
    // --- Phase 1: pre-fetch (no open transaction) + Authentik user
    // creation for new_account requests, and Authentik name/callsign
    // updates for name_change requests. ---
    const preFetchResult = await pool.query(
      'SELECT * FROM access_requests WHERE id = $1 AND status = $2',
      [requestId, 'pending']
    );

    if (preFetchResult.rows.length === 0) {
      throw new Error('Request not found or already processed');
    }

    const preFetchedRequest = preFetchResult.rows[0];
    let newAccountAuthentikUser = null;
    let nameChangeCallsignAttributes = null;

    if (preFetchedRequest.request_type === 'new_account') {
      newAccountAuthentikUser = await this.createAuthentikUserForNewAccount(preFetchedRequest);
    }

    if (preFetchedRequest.request_type === 'name_change') {
      nameChangeCallsignAttributes = await this.updateAuthentikNameAndCallsignForNameChange(preFetchedRequest);
    }

    // --- Phase 2: single transaction for the status update + the
    // type-specific state change. ---
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get request details
      const requestResult = await client.query(`
        SELECT ar.*, t.name as team_name, u.first_name as admin_first_name, u.last_name as admin_last_name
        FROM access_requests ar
        LEFT JOIN teams t ON ar.target_team_id = t.id
        LEFT JOIN users u ON u.id = $2
        WHERE ar.id = $1 AND ar.status = 'pending'
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
      await this.processApprovedRequest(client, request, {
        newAccountAuthentikUser,
        nameChangeCallsignAttributes,
        adminId
      });
      
      // Send approval email
      const adminName = `${request.admin_first_name} ${request.admin_last_name}`;
      const requestDescription = this.getRequestDescription(request);
      
      await this.emailService.sendApprovalEmail(
        request.requester_email,
        requestDescription,
        adminName,
        additionalDetails
      );
      
      await client.query('COMMIT');
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
            headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
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
   * Requirement 18.1 (task 38.1): creates the Authentik user for a
   * `new_account` request, mirroring `POST /api/users/create-and-add`'s
   * existing-email check + create-user call (`server/routes/users.js`).
   * Runs strictly before any transactional client is acquired.
   *
   * @param {object} request - the pre-fetched `access_requests` row.
   * @returns {Promise<{pk: number|string}>} the created Authentik user.
   */
  async createAuthentikUserForNewAccount(request) {
    const email = request.requester_email;
    const firstName = request.requested_first_name || request.requester_first_name;
    const lastName = request.requested_last_name || request.requester_last_name;
    const username = email.split('@')[0];

    const existingUserResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
    });
    const existingUsers = await existingUserResponse.json();

    if (existingUsers.results && existingUsers.results.length > 0) {
      throw new Error('User with this email already exists');
    }

    const createUserResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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
   * Requirement 18.4 (task 38.4): performs BOTH external Authentik calls
   * needed for a `name_change` approval -- the name-metadata PATCH and
   * the regenerated-callsign attributes PATCH -- strictly before any
   * transactional client is acquired (mirroring `new_account`'s Phase 1/
   * Phase 2 split). Runs against the PRE-FETCHED request row (i.e.
   * before Phase 2's transaction re-reads it), using
   * `request.requested_first_name`/`requested_last_name` as the new
   * name values and `request.existing_user_id` to resolve the user's
   * Authentik id and current team.
   *
   * @param {object} request - the pre-fetched `access_requests` row.
   * @returns {Promise<{callsign: string, color: string, role: string}|null>}
   *   the callsign attributes that were computed and pushed to
   *   Authentik (null if the user has no team, in which case no
   *   callsign exists to compute/push).
   */
  async updateAuthentikNameAndCallsignForNameChange(request) {
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
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
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

    // Resolve the user's current team (a read, safe outside a
    // transaction) so the regenerated callsign reflects the correct
    // team-hierarchy prefix/format. A direct (non-inherited) membership
    // row is used since that is the user's actual team assignment.
    const teamResult = await pool.query(
      'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
      [request.existing_user_id]
    );

    if (teamResult.rows.length === 0) {
      // No team assigned -- nothing to compute/push a callsign against.
      return null;
    }

    const teamId = teamResult.rows[0].team_id;

    const callsignAttributes = await UserAttributesService.computeCallsignAttributes(firstName, lastName, teamId);

    if (callsignAttributes) {
      await UserAttributesService.updateUserAttributes(authentikUserId, callsignAttributes);
    }

    return callsignAttributes;
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
      const adminName = `${request.admin_first_name} ${request.admin_last_name}`;
      const requestDescription = this.getRequestDescription(request);
      
      await this.emailService.sendDenialEmail(
        request.requester_email,
        requestDescription,
        adminName,
        denialReason
      );
      
      await client.query('COMMIT');
      return { success: true };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async processApprovedRequest(client, request, { newAccountAuthentikUser, nameChangeCallsignAttributes, adminId } = {}) {
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
        const username = email.split('@')[0];

        await UserProvisioningService.createAndAddUser(client, {
          authentikUserId: newAccountAuthentikUser.pk,
          username,
          email,
          firstName,
          lastName,
          teamId: request.target_team_id,
          createdBy: adminId ?? null
        });
        break;
      }
      case 'team_change':
        // Requirement 18.2 (task 38.2): moves the user identified by
        // `existing_user_id` to the team identified by `target_team_id`
        // using `TeamMembershipService.addUserToTeam`, passing this
        // transaction's already-open `client` through so the membership
        // change commits/rolls back atomically with the request's status
        // update to `approved` (Requirement 18.6/18.7).
        await TeamMembershipService.addUserToTeam(
          request.existing_user_id,
          request.target_team_id,
          'member',
          adminId ?? null,
          client
        );
        break;
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
        // Requirement 18.4 (task 38.4): BOTH external Authentik calls
        // (the name PATCH and the callsign-attributes PATCH) already
        // happened in Phase 1, via `updateAuthentikNameAndCallsignForNameChange`
        // -- before this transaction opened. This branch performs ONLY
        // local database writes on this transaction's already-open
        // `client`, so it commits/rolls back atomically with the
        // request's status update (Requirement 18.6/18.7): update
        // `users.first_name`/`last_name`, and mirror the same values
        // (plus the regenerated callsign attributes, if one was
        // computed in Phase 1) onto `user_cache`.
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

        if (nameChangeCallsignAttributes) {
          await client.query(
            'UPDATE user_cache SET first_name = $1, last_name = $2, tak_callsign = $3, tak_color = $4, tak_role = $5 WHERE authentik_id = $6',
            [
              firstName,
              lastName,
              nameChangeCallsignAttributes.callsign,
              nameChangeCallsignAttributes.color,
              nameChangeCallsignAttributes.role,
              authentikUserId
            ]
          );
        } else {
          await client.query(
            'UPDATE user_cache SET first_name = $1, last_name = $2 WHERE authentik_id = $3',
            [firstName, lastName, authentikUserId]
          );
        }
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