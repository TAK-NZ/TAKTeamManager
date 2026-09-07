const pool = require('../config/database');
const logger = require('../config/logger').createLogger('auditLog');

/**
 * writeAuditLog — the ONE helper for appending a row to `audit_logs`.
 *
 * Every data-mutating action a user performs must leave an audit trail; this
 * function is the single place that INSERT is expressed, so a new call site
 * cannot drift from the column set/shape (and the completeness guard test can
 * point offenders at one helper to adopt). It replaces the ~30 hand-written
 * `INSERT INTO audit_logs (...) VALUES ($1..$5)` copies previously scattered
 * across the route files; those remain byte-compatible with what this writes.
 *
 * `audit_logs` shape (see database/schema.sql): user_id int NULL (FK ->
 * users.id, non-cascading), action varchar(100) NOT NULL, resource_type
 * varchar(50) NOT NULL, resource_id int NULL, details jsonb NULL, created_at
 * default now(). The table is append-only (the only non-INSERT is
 * RetentionCleanupJob's age-based DELETE).
 *
 * Failure policy — TWO modes, chosen by whether a transaction client is passed:
 *
 *   - No client (the default): the write goes to the shared pool and is
 *     BEST-EFFORT. A failure is logged and swallowed, never thrown. This
 *     matches every existing route-level audit write, whose own try/catch
 *     already treated the audit row as non-load-bearing: an action that
 *     already succeeded must not be reported as failed just because its audit
 *     row could not be written. Callers therefore do NOT need their own
 *     try/catch and should `await` this after the action succeeds.
 *
 *   - With a client (in-transaction): the write is issued on that client and
 *     any error PROPAGATES, so the audit row commits or rolls back atomically
 *     with the action it records (the AccountLifecycleService /
 *     TeamTransferService pattern). The caller owns the transaction and its
 *     error handling.
 *
 * `details` is serialized to JSON here so call sites pass a plain object (or
 * null), never a pre-stringified string — one fewer thing to get inconsistent.
 *
 * @param {object} params
 * @param {number|null} params.userId  Acting user's LOCAL users.id (the FK).
 *   Null is allowed by the column, but the FK means a NON-null value must be a
 *   real users.id — never a made-up/sentinel id (a -1 sentinel once violated
 *   this FK and silently aborted a whole sync step).
 * @param {string} params.action        e.g. 'user.create', 'user.suspend'.
 * @param {string} params.resourceType  e.g. 'user', 'team', 'channel'.
 * @param {number|null} [params.resourceId=null]  The affected row's id.
 * @param {object|null} [params.details=null]     Extra context; JSON-encoded.
 * @param {import('pg').PoolClient} [params.client]  When supplied, write on
 *   this transaction client and let errors propagate (atomic mode).
 * @returns {Promise<void>}
 */
async function writeAuditLog({ userId, action, resourceType, resourceId = null, details = null, client } = {}) {
  const params = [
    userId ?? null,
    action,
    resourceType,
    resourceId ?? null,
    details == null ? null : JSON.stringify(details)
  ];
  const sql =
    'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)';

  if (client) {
    // In-transaction: propagate so the audit row commits/rolls back with the
    // action. The caller owns error handling.
    await client.query(sql, params);
    return;
  }

  // Best-effort: the recorded action has already succeeded, so a failed audit
  // write is logged, not thrown.
  try {
    await pool.query(sql, params);
  } catch (err) {
    logger.error({ err, action, resourceType, resourceId }, 'Failed to write audit_logs row');
  }
}

module.exports = { writeAuditLog };
