const pool = require('../config/database');
const { getCorrelationId } = require('../middleware/requestContext');

class EventPublisher {
  /**
   * Enqueues a `sync_operations` row.
   *
   * Requirement 17.5: callers that already hold an open transactional
   * `client` (e.g. `TeamMembershipService.addUserToTeam`/
   * `removeUserFromTeam`) may pass it through as the optional `client`
   * parameter so this INSERT runs on that same connection/transaction,
   * meaning it commits or rolls back atomically with the caller's other
   * writes. WHEN `client` is omitted (the default), this preserves the
   * existing behavior of writing directly via the shared `pool`, for
   * backward compatibility with callers that have no open transaction.
   *
   * Requirement 13.4 (task 33.2): persists the active HTTP request's
   * correlation ID (per `server/middleware/requestContext.js`'s
   * `AsyncLocalStorage`-backed `getCorrelationId()`) onto the enqueued
   * row's `correlation_id` column, so the Sync_Worker can later trace an
   * operation back to the request that enqueued it. WHEN this is called
   * outside of an active request context -- e.g. from the Sync_Worker
   * process itself, or from a call site not wrapped in the
   * `requestContext` middleware -- `getCorrelationId()` returns
   * `undefined`, which is inserted as `NULL`; the column is nullable for
   * exactly this reason.
   *
   * @param {string} operationType
   * @param {object} payload
   * @param {number|null} [createdBy]
   * @param {import('pg').PoolClient|null} [client] - an already-connected,
   *   already-`BEGIN`-ed client to use instead of the shared pool.
   */
  static async publishOperation(operationType, payload, createdBy = null, client = null) {
    const query = `
      INSERT INTO sync_operations (operation_type, target_user_id, target_group_id, payload, created_by, correlation_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `;

    const executor = client || pool;
    const correlationId = getCorrelationId() || null;

    const result = await executor.query(query, [
      operationType,
      payload.target_user_id || null,
      payload.target_group_id || null,
      JSON.stringify(payload),
      createdBy,
      correlationId
    ]);
    
    return result.rows[0].id;
  }

  static async publishBulkOperation(operationName, totalItems, createdBy) {
    const query = `
      INSERT INTO bulk_operations (operation_name, total_items, created_by)
      VALUES ($1, $2, $3)
      RETURNING id
    `;
    
    const result = await pool.query(query, [operationName, totalItems, createdBy]);
    return result.rows[0].id;
  }
}

module.exports = EventPublisher;