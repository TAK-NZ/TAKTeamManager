'use strict';

/**
 * Single source of truth mapping a `sync_operations.operation_type` to its
 * claim priority (Authentik scaling, Phase 1).
 *
 * LOWER number = HIGHER priority. The Sync_Worker claims via
 * `ORDER BY priority ASC, created_at ASC`, so an operation with a lower
 * number is drained ahead of a backlog of higher-numbered ones. The
 * `sync_operations.priority` column defaults to `NORMAL_PRIORITY` (100), so
 * any operation type NOT listed here is enqueued at normal priority
 * automatically -- the map only needs to name the exceptions.
 *
 * URGENT operations are the ones a human perceives as "this should have
 * happened already": disabling access and revoking credentials. If a bulk
 * background job (e.g. a 15,000-user import) has filled the queue, an
 * administrator suspending a compromised account or deleting a team must
 * not wait behind all of it. These are also the operations routed to the
 * reserved `write_priority` rate-limit lane, so they still get a token even
 * when the normal write budget is drained -- the two mechanisms
 * (queue-claim priority and the priority rate lane) are deliberately
 * aligned on the same set of operation types.
 */

const NORMAL_PRIORITY = 100;
const URGENT_PRIORITY = 10;

// Operation types that pre-empt normal work. Kept intentionally small and
// explicit: only genuinely urgent, access-removing/credential-revoking
// mutations belong here. Adding a type here also implies it should use the
// write_priority rate lane (see server/services/authentik* callers).
const URGENT_OPERATION_TYPES = new Set([
  'revoke_tak_certificates',
  'cleanup_orphaned_authentik_user',
  'delete_cloudtak_group',
  'remove_team_channel_group',
  'delete_global_channel',
  'delete_bch_service_account'
]);

/**
 * @param {string} operationType
 * @returns {number} the priority to enqueue this operation type at.
 */
function priorityForOperationType(operationType) {
  return URGENT_OPERATION_TYPES.has(operationType) ? URGENT_PRIORITY : NORMAL_PRIORITY;
}

/**
 * @param {string} operationType
 * @returns {boolean} whether this op type is urgent (also the set that uses
 *   the write_priority rate-limit lane).
 */
function isUrgentOperationType(operationType) {
  return URGENT_OPERATION_TYPES.has(operationType);
}

module.exports = {
  NORMAL_PRIORITY,
  URGENT_PRIORITY,
  URGENT_OPERATION_TYPES,
  priorityForOperationType,
  isUrgentOperationType
};
