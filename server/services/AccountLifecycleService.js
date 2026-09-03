const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const logger = require('../config/logger').createLogger('AccountLifecycleService');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');

/**
 * account-lifecycle-management Requirement 1 Criterion 5: thrown by
 * `suspendAccount` when the target account's `account_status` is already
 * `'suspended'`. No Authentik call is made and no Revoke_Operation is
 * enqueued -- the row is read-then-checked under `FOR UPDATE` before either
 * happens.
 */
class AccountAlreadySuspendedError extends Error {
  /**
   * @param {number} userId - the target account's local `users.id`.
   */
  constructor(userId) {
    super('Account is already suspended');
    this.name = 'AccountAlreadySuspendedError';
    this.userId = userId;
  }
}

/**
 * account-lifecycle-management Requirement 1 Criteria 5, 10: thrown by
 * BOTH `suspendAccount` and `unsuspendAccount` when the target account's
 * `account_status` is `'orphaned'` -- there is no Authentik identity left
 * to lock or unlock, so neither action is permitted against it.
 */
class AccountOrphanedError extends Error {
  /**
   * @param {number} userId - the target account's local `users.id`.
   */
  constructor(userId) {
    super('Account has no Authentik identity (orphaned)');
    this.name = 'AccountOrphanedError';
    this.userId = userId;
  }
}

/**
 * account-lifecycle-management Requirement 1 Criterion 10: thrown by
 * `unsuspendAccount` when the target account's `account_status` is
 * anything other than `'suspended'` (i.e. `'active'` -- `'orphaned'` is
 * covered by `AccountOrphanedError` instead, checked first).
 */
class AccountNotSuspendedError extends Error {
  /**
   * @param {number} userId - the target account's local `users.id`.
   * @param {string} currentStatus - the account's actual `account_status`.
   */
  constructor(userId, currentStatus) {
    super(`Account is not suspended (current status: ${currentStatus})`);
    this.name = 'AccountNotSuspendedError';
    this.userId = userId;
    this.currentStatus = currentStatus;
  }
}

/**
 * Thrown by `suspendAccount`/`unsuspendAccount` when `targetUserId` names
 * no `users` row at all -- distinct from every `Account*` state error
 * above, since there is no account whose state to report. Named
 * generically (not `Account...`) so a route's error-mapping table cannot
 * mistake it for one of the state-conflict errors and map it to the same
 * 400 they use; this one is a 404.
 */
class TargetUserNotFoundError extends Error {
  /**
   * @param {number} userId - the id that named no row.
   */
  constructor(userId) {
    super('Target user not found');
    this.name = 'TargetUserNotFoundError';
    this.userId = userId;
  }
}

/**
 * AccountLifecycleService (account-lifecycle-management Requirement 1).
 *
 * `suspendAccount`/`unsuspendAccount` are the admin-initiated,
 * Account_Suspension/Account_Unsuspension half of this feature -- the
 * OTHER half, automatic Account_Orphaning via the Reconciliation_Sweep, is
 * implemented separately in `server/services/authentikSync.js` (a
 * background-sync concern, not an admin-action one) and shares only the
 * Revoke_Operation enqueue shape with this service, duplicated rather than
 * factored out because the two call sites differ in what they hold open
 * (this service owns a transaction; the sweep runs against the bare
 * `pool`, per design.md).
 *
 * Both methods follow the SAME transactional shape already established by
 * `TeamTransferService.executeTransfer`/`applyPostCommitEffects`: acquire
 * a client, `BEGIN`, lock and read the target row with `SELECT ... FOR
 * UPDATE` (closing the race where two concurrent calls both observe the
 * pre-transition status), validate, write the local state change and
 * enqueue the Revoke_Operation on that SAME client (so a rollback also
 * un-enqueues it), write the `audit_logs` row, `COMMIT`, THEN -- strictly
 * after commit, per this codebase's "no HTTP call inside a transaction"
 * rule -- PATCH the Authentik user. The post-commit PATCH is best-effort:
 * a failure there is logged and does NOT roll back or fail the request,
 * because the local suspension/unsuspension and the queued revoke are the
 * durable, load-bearing effects. A PATCH failure here also self-heals: the
 * existing periodic push-to-Authentik step in `authentikSync.js` already
 * reads local `users.is_active` as authoritative and PATCHes Authentik
 * when it differs, so a missed suspend/unsuspend PATCH is corrected on
 * that service's own next run with no new reconciliation code needed for
 * this specific failure mode.
 */
class AccountLifecycleService {
  /**
   * Suspends an `account_status = 'active'` account (Requirement 1
   * Criteria 1-5, 9): locks the Authentik user (`is_active: false`,
   * nothing else) and revokes every Live_Certificate the account
   * currently holds, WITHOUT deleting the Authentik account, the local
   * `users` row, or any team membership.
   *
   * @param {number} targetUserId - the target account's local `users.id`.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser -
   *   the acting admin, used only for the `audit_logs`/Revoke_Operation
   *   actor id here -- authorization itself is the caller's
   *   responsibility (the row-scoped resolver in `authorize.js`), not
   *   re-checked in this service, mirroring `TeamTransferService`'s own
   *   division of responsibility.
   * @returns {Promise<{userId: number, accountStatus: 'suspended'}>}
   * @throws {TargetUserNotFoundError|AccountAlreadySuspendedError|AccountOrphanedError}
   */
  static async suspendAccount(targetUserId, actingUser) {
    const client = await pool.connect();
    const actingUserId = actingUser?.userId ?? null;

    // Assigned inside the try block below (never read before that
    // assignment happens, and the function throws before reaching the
    // post-commit section on every path that would leave it unset).
    let authentikUserId;

    try {
      await client.query('BEGIN');

      // Step 1 -- lock and read the target row (Requirement 1 Criteria
      // 1-5). `FOR UPDATE` closes the race where two concurrent
      // suspend calls both observe `account_status = 'active'`.
      const targetResult = await client.query(
        `SELECT id, authentik_user_id, is_team_device, username, account_status
           FROM users
          WHERE id = $1
          FOR UPDATE`,
        [targetUserId]
      );
      const target = targetResult.rows[0];

      if (!target) {
        await client.query('ROLLBACK');
        throw new TargetUserNotFoundError(targetUserId);
      }

      if (target.account_status === 'orphaned') {
        await client.query('ROLLBACK');
        throw new AccountOrphanedError(targetUserId);
      }

      if (target.account_status === 'suspended') {
        await client.query('ROLLBACK');
        throw new AccountAlreadySuspendedError(targetUserId);
      }

      authentikUserId = target.authentik_user_id;

      // Step 2 -- local state transition (Requirement 1 Criterion 9):
      // account_status -> 'suspended', is_active -> false, mirrored onto
      // user_cache.
      await client.query(
        `UPDATE users SET account_status = 'suspended', is_active = false WHERE id = $1`,
        [targetUserId]
      );
      if (authentikUserId) {
        await client.query(
          `UPDATE user_cache SET is_active = false WHERE authentik_id = $1`,
          [String(authentikUserId)]
        );
      }

      // Step 3 -- enqueue the Revoke_Operation on the SAME client
      // (Requirement 1 Criterion 3), so a rollback also un-enqueues it.
      // client_uid for a Team_Owned_Device (it has exactly one);
      // tak_usernames for a human, mirroring the three pre-existing
      // user-scoped revoke call sites. Subject to the EXISTING
      // DEVICE_MGMT_REVOKE_ENABLED arming flag and blast-radius cap
      // inside SyncWorker.revokeTakCertificates -- no new gating logic
      // here.
      const revokePayload = target.is_team_device
        ? { client_uid: target.username }
        : { tak_usernames: [target.username] };
      await EventPublisher.publishOperation('revoke_tak_certificates', revokePayload, actingUserId, client);

      // Step 4 -- audit log (Requirement 1 Criterion 4).
      await client.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [actingUserId, 'user.suspend', 'user', targetUserId, JSON.stringify({ targetUserId })]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // Step 5 -- the Authentik PATCH, strictly post-commit (Requirement 1
    // Criterion 2). Best-effort: a failure here is logged, never thrown,
    // and never undoes the committed suspension above.
    if (authentikUserId) {
      try {
        const response = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ is_active: false })
        });
        if (!response.ok) {
          throw new Error(`Failed to lock Authentik user: ${response.statusText}`);
        }
      } catch (error) {
        logger.error(
          { err: error, targetUserId, authentikUserId },
          'Failed to PATCH Authentik is_active=false after suspend; will self-correct on the next periodic sync push'
        );
      }
    }

    return { userId: targetUserId, accountStatus: 'suspended' };
  }

  /**
   * Unsuspends an `account_status = 'suspended'` account (Requirement 1
   * Criteria 6-10): unlocks the Authentik user (`is_active: true`,
   * nothing else) and does NOT attempt to restore any previously revoked
   * certificate -- a revoked certificate cannot be un-revoked on TAK
   * Server; re-enrollment is the only path back to a live one, exactly
   * as after any other revoke.
   *
   * @param {number} targetUserId - the target account's local `users.id`.
   * @param {{userId?: number, is_global_manager?: boolean}} actingUser -
   *   the acting admin; see `suspendAccount`'s doc comment for the same
   *   authorization-division note.
   * @returns {Promise<{userId: number, accountStatus: 'active'}>}
   * @throws {TargetUserNotFoundError|AccountOrphanedError|AccountNotSuspendedError}
   */
  static async unsuspendAccount(targetUserId, actingUser) {
    const client = await pool.connect();
    const actingUserId = actingUser?.userId ?? null;

    // See suspendAccount's identical comment on this declaration.
    let authentikUserId;

    try {
      await client.query('BEGIN');

      const targetResult = await client.query(
        `SELECT id, authentik_user_id, account_status
           FROM users
          WHERE id = $1
          FOR UPDATE`,
        [targetUserId]
      );
      const target = targetResult.rows[0];

      if (!target) {
        await client.query('ROLLBACK');
        throw new TargetUserNotFoundError(targetUserId);
      }

      if (target.account_status === 'orphaned') {
        await client.query('ROLLBACK');
        throw new AccountOrphanedError(targetUserId);
      }

      if (target.account_status !== 'suspended') {
        await client.query('ROLLBACK');
        throw new AccountNotSuspendedError(targetUserId, target.account_status);
      }

      authentikUserId = target.authentik_user_id;

      await client.query(
        `UPDATE users SET account_status = 'active', is_active = true WHERE id = $1`,
        [targetUserId]
      );
      if (authentikUserId) {
        await client.query(
          `UPDATE user_cache SET is_active = true WHERE authentik_id = $1`,
          [String(authentikUserId)]
        );
      }

      await client.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [actingUserId, 'user.unsuspend', 'user', targetUserId, JSON.stringify({ targetUserId })]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (authentikUserId) {
      try {
        const response = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ is_active: true })
        });
        if (!response.ok) {
          throw new Error(`Failed to unlock Authentik user: ${response.statusText}`);
        }
      } catch (error) {
        logger.error(
          { err: error, targetUserId, authentikUserId },
          'Failed to PATCH Authentik is_active=true after unsuspend; will self-correct on the next periodic sync push'
        );
      }
    }

    return { userId: targetUserId, accountStatus: 'active' };
  }
}

module.exports = AccountLifecycleService;
module.exports.AccountAlreadySuspendedError = AccountAlreadySuspendedError;
module.exports.AccountOrphanedError = AccountOrphanedError;
module.exports.AccountNotSuspendedError = AccountNotSuspendedError;
module.exports.TargetUserNotFoundError = TargetUserNotFoundError;
