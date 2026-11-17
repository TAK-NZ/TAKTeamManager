'use strict';
/**
 * Permanent removal of a user ("permanently delete"), shared by
 * `DELETE /api/users/remove-from-team/:userId` and
 * `POST /api/users/bulk-remove-from-team`.
 *
 * ORDER MATTERS. Both routes used to delete the Authentik account first and the
 * local `users` row last, with nothing making the two atomic. The local
 * `DELETE FROM users` fails (foreign key violation, SQLSTATE 23503) for any user
 * with history, because audit_logs.user_id, sync_operations.created_by and
 * several `created_by` columns reference users(id) without cascading. When it
 * failed the Authentik account was already gone, so the local row survived with
 * a dead `authentik_user_id`: the Reconciliation_Sweep later marked it
 * `orphaned`, it stayed in the "every user" group sets, and Authentik rejected
 * every group PATCH that included it (demo, 2026-11-09, see
 * docs/authentik-scaling-lessons.md).
 *
 * Now:
 *   1. Everything local happens in ONE transaction: memberships, the queued
 *      Sync_Operations, user_cache, and the users row. It commits (or rolls
 *      back completely) BEFORE Authentik is touched.
 *   2. If the users row cannot be deleted because of its history (23503), it is
 *      kept as a tombstone: `account_status = 'orphaned'`, inactive, and
 *      `authentik_user_id` cleared. That is exactly the retained-row design the
 *      schema documents for orphaned accounts (history kept, a returning sign-up
 *      adopts it through Account_Reclaim), minus the dangling Authentik id that
 *      the group reconciler would otherwise keep trying to write.
 *   3. Any OTHER local failure aborts with nothing changed in Authentik.
 *   4. Only then is the Authentik account deleted; a failure there falls back to
 *      the existing `cleanup_orphaned_authentik_user` compensating operation.
 */
const pool = require('../config/database');
const logger = require('../config/logger').createLogger('UserRemovalService');
const TeamMembershipService = require('./TeamMembershipService');
const UserAttributesService = require('./userAttributes');
const EventPublisher = require('./EventPublisher');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
const { isDeviceMgmtRevokeEnabled } = require('../config/deviceMgmt');

const FOREIGN_KEY_VIOLATION = '23503';
const ROW_SAVEPOINT = 'remove_user_row';

/**
 * @param {number|string} userId  local users.id
 * @param {number|null} requestedBy  local users.id of the admin performing it
 * @returns {Promise<null | {
 *   groupsQueued: number,
 *   authentikAccountDeleted: boolean,
 *   certificateRevocationDryRun: boolean,
 *   localRowRetained: boolean
 * }>} null when no such user exists.
 * @throws when the local transaction fails for any reason other than the
 *   history-FK case (nothing was changed locally or in Authentik).
 */
async function permanentlyRemoveUser(userId, requestedBy) {
  const userResult = await pool.query('SELECT authentik_user_id FROM users WHERE id = $1', [userId]);
  if (userResult.rows.length === 0) {
    return null;
  }
  const authentikUserId = userResult.rows[0].authentik_user_id;

  // ---- 1. Everything local, atomically -------------------------------------
  let groupsQueued;
  let localRowRetained = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deletes every team/channel membership and enqueues the group removals,
    // the certificate revoke and any CloudTAK group reconciles, all on this
    // client so they commit or roll back together with the row below.
    const removal = await TeamMembershipService.removeUserFromTeam(userId, requestedBy, client);
    groupsQueued = removal.groupsQueued;

    if (authentikUserId !== null && authentikUserId !== undefined) {
      await client.query('DELETE FROM user_cache WHERE authentik_id = $1', [String(authentikUserId)]);
    }

    await client.query(`SAVEPOINT ${ROW_SAVEPOINT}`);
    try {
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.query(`RELEASE SAVEPOINT ${ROW_SAVEPOINT}`);
    } catch (err) {
      if (err.code !== FOREIGN_KEY_VIOLATION) {
        throw err;
      }
      // The user has history (audit log, created rows, ...). Keep the row as an
      // orphaned tombstone instead of failing half way through.
      await client.query(`ROLLBACK TO SAVEPOINT ${ROW_SAVEPOINT}`);
      await client.query(
        `UPDATE users
            SET account_status = 'orphaned',
                is_active = false,
                authentik_user_id = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [userId]
      );
      localRowRetained = true;
      logger.info(
        { userId, constraint: err.constraint },
        'User has history that blocks deleting the local row; retained it as an orphaned tombstone'
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr, userId }, 'Rollback after a failed user removal also failed');
    }
    throw err;
  } finally {
    client.release();
  }

  // ---- 2. Only now Authentik ----------------------------------------------
  // Whether the revoke enqueued above will really run is already fully known;
  // it is recorded so an admin can see that an unarmed revoke is a dry run.
  const certificateRevocationDryRun = !isDeviceMgmtRevokeEnabled();

  let authentikAccountDeleted = true;
  if (authentikUserId !== null && authentikUserId !== undefined) {
    await UserAttributesService.clearUserAttributes(authentikUserId);

    // A failed or unreachable delete used to be only logged, leaving a fully
    // intact, loginable Authentik account with no record. A non-2xx/non-404
    // response (404 means already gone) falls back to a cleanup operation that
    // the Sync_Worker retries.
    try {
      const deleteResponse = await fetchWithTimeout(
        `${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` } }
      );
      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`Authentik delete responded with status ${deleteResponse.status}`);
      }
    } catch (deleteErr) {
      logger.error({ err: deleteErr, userId }, 'Failed to delete user from Authentik');
      authentikAccountDeleted = false;
      try {
        await EventPublisher.publishOperation(
          'cleanup_orphaned_authentik_user',
          { authentik_user_id: authentikUserId },
          requestedBy
        );
      } catch (enqueueErr) {
        logger.error(
          { err: enqueueErr, authentikUserId },
          'Failed to enqueue cleanup_orphaned_authentik_user compensating operation'
        );
      }
    }
  }

  // ---- 3. Audit ------------------------------------------------------------
  try {
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
      [
        requestedBy,
        'user.remove_from_team',
        'user',
        parseInt(userId, 10),
        JSON.stringify({ authentikAccountDeleted, certificateRevocationDryRun, localRowRetained })
      ]
    );
  } catch (auditErr) {
    logger.error({ err: auditErr, userId }, 'Failed to write audit log');
  }

  return { groupsQueued, authentikAccountDeleted, certificateRevocationDryRun, localRowRetained };
}

module.exports = { permanentlyRemoveUser };
