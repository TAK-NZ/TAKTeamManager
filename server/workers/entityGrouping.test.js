/**
 * Requirement 10.2/10.5 (task 30.2): `groupByEntityKey` partitions a batch
 * of `sync_operations` rows into same-entity "lanes" so that operations
 * sharing a `target_user_id:target_group_id` key stay together (and, per
 * task 30.2's implementation notes, in their original relative fetch
 * order within that lane), while every other operation gets its own
 * unique lane keyed by its own `id`.
 *
 * The property-based test below (task 30.3, design.md's Property 4)
 * complements the example-based tests above: it exercises the SAME
 * `groupByEntityKey` export against randomly generated batches, rather
 * than a handful of hand-picked ones, using `fast-check` via
 * `@fast-check/jest`'s `test.prop` integration -- matching the convention
 * established in `server/config/configValidator.test.js`,
 * `server/config/permissions.registry.test.js`, and
 * `server/config/htmlSafeSubset.test.js`.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { groupByEntityKey } = require('./entityGrouping');

describe('groupByEntityKey', () => {
  it('groups operations sharing the same target_user_id/target_group_id payload fields into one lane, in original relative order', () => {
    const operations = [
      { id: 'op-1', payload: { target_user_id: 1, target_group_id: 'group-a' } },
      { id: 'op-2', payload: { target_user_id: 2, target_group_id: 'group-b' } },
      { id: 'op-3', payload: { target_user_id: 1, target_group_id: 'group-a' } }
    ];

    const lanes = groupByEntityKey(operations);

    // op-1 and op-3 share a key; op-2 gets its own lane.
    expect(lanes.size).toBe(2);

    const sharedLane = [...lanes.values()].find((lane) => lane.length === 2);
    expect(sharedLane).toEqual([operations[0], operations[2]]);
    // Original relative order preserved (op-1 before op-3).
    expect(sharedLane[0].id).toBe('op-1');
    expect(sharedLane[1].id).toBe('op-3');

    const soloLane = [...lanes.values()].find((lane) => lane.length === 1);
    expect(soloLane).toEqual([operations[1]]);
  });

  it('gives each operation its own lane (falling back to id) when target_user_id or target_group_id is missing', () => {
    const operations = [
      { id: 'op-1', payload: { target_user_id: 1 } }, // missing target_group_id
      { id: 'op-2', payload: { target_group_id: 'group-a' } }, // missing target_user_id
      { id: 'op-3', payload: {} } // missing both
    ];

    const lanes = groupByEntityKey(operations);

    expect(lanes.size).toBe(3);
    for (const operation of operations) {
      const matchingLanes = [...lanes.values()].filter((lane) =>
        lane.some((op) => op.id === operation.id)
      );
      expect(matchingLanes).toHaveLength(1);
      expect(matchingLanes[0]).toEqual([operation]);
    }
  });

  it('gives each operation its own lane when target_user_id/target_group_id are explicitly null', () => {
    const operations = [
      { id: 'op-1', payload: { target_user_id: null, target_group_id: null } },
      { id: 'op-2', payload: { target_user_id: 1, target_group_id: null } }
    ];

    const lanes = groupByEntityKey(operations);

    expect(lanes.size).toBe(2);
  });

  it('never groups an operation with an unparsed JSON-string payload with anything else, without throwing', () => {
    const operations = [
      { id: 'op-1', payload: '{"target_user_id":1,"target_group_id":"group-a"}' },
      { id: 'op-2', payload: 'not valid json at all' },
      { id: 'op-3', payload: { target_user_id: 1, target_group_id: 'group-a' } }
    ];

    expect(() => groupByEntityKey(operations)).not.toThrow();
    const lanes = groupByEntityKey(operations);

    // op-1's payload IS a valid, parseable JSON string with both fields,
    // so it safely parses and groups with op-3.
    // op-2's payload is unparseable and gets its own lane.
    expect(lanes.size).toBe(2);

    const sharedLane = [...lanes.values()].find((lane) => lane.length === 2);
    expect(sharedLane.map((op) => op.id)).toEqual(['op-1', 'op-3']);

    const soloLane = [...lanes.values()].find((lane) => lane.length === 1);
    expect(soloLane[0].id).toBe('op-2');
  });

  it('isolates operations from operation_types that never carry target_user_id/target_group_id onto their own lane by id', () => {
    const operations = [
      { id: 'op-1', payload: { synced_by: 5 } }, // sync_existing_global_channels-shaped payload
      { id: 'op-2', payload: { channel_id: 10 } }, // deactivate_global_channel-shaped payload
      { id: 'op-3', payload: { synced_by: 5 } } // same shape as op-1, but not the same entity key fields
    ];

    const lanes = groupByEntityKey(operations);

    // None of these share target_user_id/target_group_id, so despite
    // op-1 and op-3 having identical payload content, they must NOT be
    // grouped together -- each falls back to its own id.
    expect(lanes.size).toBe(3);
    for (const operation of operations) {
      const lane = lanes.get(`id:${operation.id}`);
      expect(lane).toEqual([operation]);
    }
  });

  it('produces the expected Map shape for a mix of grouped and ungrouped operations', () => {
    const operations = [
      { id: 'op-1', payload: { target_user_id: 1, target_group_id: 'group-a' } },
      { id: 'op-2', payload: { target_user_id: 1, target_group_id: 'group-a' } },
      { id: 'op-3', payload: { channel_id: 99 } },
      { id: 'op-4', payload: { target_user_id: 2, target_group_id: 'group-b' } },
      { id: 'op-5', payload: { target_user_id: 1, target_group_id: 'group-a' } }
    ];

    const lanes = groupByEntityKey(operations);

    expect(lanes).toBeInstanceOf(Map);
    // Lane for (1, group-a): op-1, op-2, op-5, in that order.
    expect(lanes.get('1:group-a')).toEqual([operations[0], operations[1], operations[4]]);
    // Lane for (2, group-b): op-4 alone.
    expect(lanes.get('2:group-b')).toEqual([operations[3]]);
    // op-3 falls back to its own id-keyed lane.
    expect(lanes.get('id:op-3')).toEqual([operations[2]]);

    expect(lanes.size).toBe(3);
  });

  it('returns an empty Map for an empty input array', () => {
    const lanes = groupByEntityKey([]);
    expect(lanes).toBeInstanceOf(Map);
    expect(lanes.size).toBe(0);
  });
});

// Feature: production-hardening, Property 4: Same-entity operations stay ordered within a batch
describe('Property 4: Same-entity operations stay ordered within a batch (groupByEntityKey)', () => {
  /**
   * design.md's exact Property 4 statement: "For any batch of pending
   * `sync_operations` rows with arbitrary `(target_user_id,
   * target_group_id)` pairs and arbitrary fetch order, all rows sharing
   * the same pair are assigned to the same concurrency lane, and execute
   * in their original relative fetch order."
   *
   * A generator drawing `target_user_id`/`target_group_id` from a small,
   * bounded set (2-4 user ids x 2-3 group ids) is used deliberately,
   * rather than fully arbitrary values: with fully arbitrary values every
   * generated operation would almost certainly land in its own unique
   * lane, and the "same lane" case the property is actually about would
   * essentially never be exercised. Bounding the value space makes
   * entity-key collisions -- and therefore multi-element lanes -- common
   * across a batch of any reasonable size.
   */
  const userIdArb = fc.constantFrom('user-1', 'user-2', 'user-3', 'user-4');
  const groupIdArb = fc.constantFrom('group-a', 'group-b', 'group-c');

  // Each generated operation gets a unique, monotonically-assigned `id`
  // (via the array index at build time) so lane membership/order can be
  // checked back against the original input unambiguously, and a payload
  // that's EITHER a plain object OR a JSON string (exercising both code
  // paths `safeExtractEntityFields` supports).
  const operationArb = fc
    .tuple(userIdArb, groupIdArb, fc.boolean())
    .map(([target_user_id, target_group_id, asJsonString]) => {
      const payloadObject = { target_user_id, target_group_id };
      return {
        payload: asJsonString ? JSON.stringify(payloadObject) : payloadObject
      };
    });

  const operationsBatchArb = fc
    .array(operationArb, { minLength: 5, maxLength: 30 })
    .map((ops) => ops.map((op, index) => ({ ...op, id: `op-${index}` })));

  test.prop([operationsBatchArb], { numRuns: 100 })(
    'every lane preserves original relative order, and every operation appears in exactly one lane (partition)',
    (operations) => {
      const originalIndexById = new Map(operations.map((op, index) => [op.id, index]));

      let lanes;
      expect(() => {
        lanes = groupByEntityKey(operations);
      }).not.toThrow();

      // --- Partition check: every operation appears in exactly one lane,
      // none dropped, none duplicated. ---
      const seenIds = [];
      for (const lane of lanes.values()) {
        for (const op of lane) {
          seenIds.push(op.id);
        }
      }
      expect(seenIds.sort()).toEqual(
        operations.map((op) => op.id).sort()
      );
      // No duplicates: every id in seenIds is unique.
      expect(new Set(seenIds).size).toBe(seenIds.length);

      // --- Ordering check: within each lane, the original indices of its
      // elements (mapped back via id) must be strictly increasing, i.e.
      // the lane preserves the operations' original relative order. ---
      for (const lane of lanes.values()) {
        const indices = lane.map((op) => originalIndexById.get(op.id));
        for (let i = 1; i < indices.length; i++) {
          expect(indices[i]).toBeGreaterThan(indices[i - 1]);
        }
      }
    }
  );
});
