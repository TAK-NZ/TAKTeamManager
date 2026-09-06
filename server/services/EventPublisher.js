const pool = require('../config/database');
const { getCorrelationId } = require('../middleware/requestContext');
// Authentik scaling (Phase 1): derives the sync_operations.priority for an
// operation type so urgent mutations (delete/suspend/revoke/cleanup) are
// claimed ahead of a bulk backlog. A caller may still override with an
// explicit `priority` argument; otherwise this map decides.
const { priorityForOperationType } = require('../config/syncOperationPriority');

// Performance-hardening: the maximum number of sync_operations rows
// `publishOperationsBatch` inserts in a single multi-row INSERT statement.
// Each row binds 7 parameters (see `publishOperation`'s own column list --
// including the Phase-1 `priority` column), and Postgres's protocol caps a
// single statement at 65535 bound parameters -- 1000 rows * 7 params =
// 7000, comfortably under that limit with room to spare, while still
// cutting a 50,000-row enqueue from 50,000 individual round trips down to 50.
const BATCH_INSERT_CHUNK_SIZE = 1000;

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
   * @param {number|null} [priority] - Authentik scaling (Phase 1): the
   *   claim priority (LOWER = more urgent). Omitted/null derives it from
   *   `operationType` via `priorityForOperationType`, so existing callers
   *   need no change and urgent op types are prioritised automatically. An
   *   explicit value overrides the derived one.
   */
  static async publishOperation(operationType, payload, createdBy = null, client = null, priority = null) {
    const query = `
      INSERT INTO sync_operations (operation_type, target_user_id, target_group_id, payload, created_by, correlation_id, priority)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;

    const executor = client || pool;
    const correlationId = getCorrelationId() || null;
    const resolvedPriority = priority == null ? priorityForOperationType(operationType) : priority;

    const result = await executor.query(query, [
      operationType,
      payload.target_user_id || null,
      payload.target_group_id || null,
      JSON.stringify(payload),
      createdBy,
      correlationId,
      resolvedPriority
    ]);
    
    return result.rows[0].id;
  }

  /**
   * Performance-hardening: enqueues many `sync_operations` rows of the
   * SAME `operationType` in one or more multi-row INSERT statements,
   * instead of one INSERT per row. Introduced because
   * `GlobalChannelService.assignAllUsersToGlobalChannels`,
   * `TeamMembershipService.bulkAddUsersToTeam`, and
   * `SyncWorker.resyncOrgChannelTierAccess` each previously enqueued one
   * operation per user in a sequential `for` loop -- at the documented
   * 50,000-user scale, that is 50,000 individual round trips to Postgres
   * before the Sync_Worker even starts draining the queue.
   *
   * `payloads` is an array of the SAME shape `publishOperation`'s own
   * `payload` argument takes -- each entry's own `target_user_id`/
   * `target_group_id` (if present) are extracted the same way, and the
   * whole entry is stored verbatim as that row's `payload` jsonb column.
   * `operationType` and `createdBy` are shared across every row in the
   * batch, matching every existing call site's own usage (a single bulk
   * action always enqueues one operation type under one actor/system
   * attribution).
   *
   * Chunked into groups of `BATCH_INSERT_CHUNK_SIZE` rows per statement
   * (rather than one unbounded statement for the whole array) so an
   * arbitrarily large `payloads` array can never build a single INSERT
   * that exceeds Postgres's bound-parameter limit. Chunks are inserted
   * sequentially, not concurrently, to avoid opening many simultaneous
   * connections against a possibly-shared `client`/pool for one logical
   * bulk action.
   *
   * Same `client`-or-pool and correlation-id behavior as `publishOperation`
   * (Requirements 17.5, 13.4) -- see that method's own doc comment.
   *
   * @param {string} operationType
   * @param {object[]} payloads - one entry per row to enqueue; may be empty.
   * @param {number|null} [createdBy]
   * @param {import('pg').PoolClient|null} [client]
   * @param {number|null} [priority] - Authentik scaling (Phase 1): the
   *   claim priority for every row in the batch (a batch is always one op
   *   type, so one priority). Omitted/null derives it from `operationType`.
   * @returns {Promise<number[]>} the enqueued rows' ids, in the same
   *   order as `payloads`.
   */
  static async publishOperationsBatch(operationType, payloads, createdBy = null, client = null, priority = null) {
    if (payloads.length === 0) {
      return [];
    }

    const executor = client || pool;
    const correlationId = getCorrelationId() || null;
    const resolvedPriority = priority == null ? priorityForOperationType(operationType) : priority;
    const ids = [];

    // 7 bound parameters per row (operation_type, target_user_id,
    // target_group_id, payload, created_by, correlation_id, priority).
    const PARAMS_PER_ROW = 7;
    for (let chunkStart = 0; chunkStart < payloads.length; chunkStart += BATCH_INSERT_CHUNK_SIZE) {
      const chunk = payloads.slice(chunkStart, chunkStart + BATCH_INSERT_CHUNK_SIZE);

      const values = [];
      const placeholderRows = chunk.map((payload, index) => {
        const base = index * PARAMS_PER_ROW;
        values.push(
          operationType,
          payload.target_user_id || null,
          payload.target_group_id || null,
          JSON.stringify(payload),
          createdBy,
          correlationId,
          resolvedPriority
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });

      const query = `
        INSERT INTO sync_operations (operation_type, target_user_id, target_group_id, payload, created_by, correlation_id, priority)
        VALUES ${placeholderRows.join(', ')}
        RETURNING id
      `;

      const result = await executor.query(query, values);
      ids.push(...result.rows.map((row) => row.id));
    }

    return ids;
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