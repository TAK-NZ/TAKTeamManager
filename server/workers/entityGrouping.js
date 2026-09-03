/**
 * Same-entity grouping for concurrent Sync_Worker batch processing
 * (Requirement 10.2, 10.5).
 *
 * `processNextOperation` (see `server/workers/syncWorker.js`) fetches a
 * batch of pending `sync_operations` rows and, per task 30.2, routes them
 * through a bounded `p-limit` worker pool so distinct operations can run
 * concurrently (Requirement 10.2/10.3). Two operations that target the
 * *same* entity -- the same `target_user_id`/`target_group_id` pair --
 * must never run concurrently with each other, and must not run out of
 * their original fetch order relative to each other (Requirement 10.5).
 *
 * `groupByEntityKey` partitions a batch into "lanes": arrays of operations
 * that must execute strictly sequentially, in their original relative
 * order, on a single `p-limit` slot. Operations that don't share an
 * entity key each get their own single-operation lane, which is trivially
 * "sequential" and free to run concurrently with every other lane.
 *
 * Entity key derivation:
 *   - If the operation's payload safely yields both a non-null,
 *     non-undefined `target_user_id` AND `target_group_id`, the key is
 *     `` `${target_user_id}:${target_group_id}` ``.
 *   - Otherwise (either field missing/null/undefined, or the payload
 *     can't be safely parsed/read at all -- e.g. it's still a raw JSON
 *     string, or the operation_type simply doesn't have these fields),
 *     the key falls back to the operation's own `id`, so it gets its own
 *     unique lane (no other operation should coincidentally share the
 *     same `id`).
 *
 * This module deliberately does NOT mutate or assume anything about
 * `operation.payload`'s runtime shape beyond what it can safely read: by
 * the time `processNextOperation` has fetched a batch, `payload` may be
 * whatever raw value came back from the DB driver for a JSON/JSONB column
 * (already-parsed object) OR a raw JSON string, depending on driver/
 * column-type configuration -- exactly the same ambiguity `executeOperation`
 * itself already handles via its own `typeof`/`JSON.parse` branch. This
 * module never throws on an unparseable or shape-mismatched payload; it
 * simply treats that operation as ungroupable (falls back to its `id`).
 */

/**
 * Safely extracts `target_user_id`/`target_group_id` off an operation's
 * `payload`, without throwing regardless of the payload's runtime shape.
 *
 * @param {*} payload - `operation.payload` as returned by the DB driver;
 *   may already be a plain object, a raw JSON string, null/undefined, or
 *   (in principle) any other value.
 * @returns {{target_user_id: *, target_group_id: *}} the extracted
 *   values, or `{ target_user_id: undefined, target_group_id: undefined }`
 *   if `payload` can't be safely read (wrong type, unparseable JSON
 *   string, or simply missing either field).
 */
function safeExtractEntityFields(payload) {
  let parsed = payload;

  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Raw JSON string that isn't valid JSON (or isn't JSON at all):
      // treat as ungroupable rather than throwing.
      return { target_user_id: undefined, target_group_id: undefined };
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    // Not an object we can safely read fields off of (null, number,
    // boolean, array-of-nothing-useful, etc.).
    return { target_user_id: undefined, target_group_id: undefined };
  }

  return {
    target_user_id: parsed.target_user_id,
    target_group_id: parsed.target_group_id
  };
}

/**
 * Computes the entity/lane key for a single operation.
 *
 * @param {object} operation - a `sync_operations` row (at minimum `id`
 *   and `payload`).
 * @returns {string} the lane key: `` `${target_user_id}:${target_group_id}` ``
 *   when both fields are present and non-null/non-undefined on the
 *   operation's payload, otherwise the operation's own `id` (coerced to a
 *   string, so `Map` key comparisons behave consistently regardless of
 *   whether `id` is a number or a string in a given deployment).
 */
function computeEntityKey(operation) {
  const { target_user_id, target_group_id } = safeExtractEntityFields(operation.payload);

  const hasBothFields =
    target_user_id !== null &&
    target_user_id !== undefined &&
    target_group_id !== null &&
    target_group_id !== undefined;

  if (hasBothFields) {
    return `${target_user_id}:${target_group_id}`;
  }

  return `id:${operation.id}`;
}

/**
 * Partitions a batch of `sync_operations` rows into same-entity lanes.
 *
 * @param {object[]} operations - the fetched batch, in fetch order.
 * @returns {Map<string, object[]>} a `Map` from lane key to the array of
 *   operations sharing that key, in the input array's original relative
 *   order (a single forward pass, so insertion order into each array is
 *   naturally stable -- no sorting is performed).
 */
function groupByEntityKey(operations) {
  const lanes = new Map();

  for (const operation of operations) {
    const key = computeEntityKey(operation);
    if (!lanes.has(key)) {
      lanes.set(key, []);
    }
    lanes.get(key).push(operation);
  }

  return lanes;
}

module.exports = { groupByEntityKey };
