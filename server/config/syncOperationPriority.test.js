'use strict';

/**
 * Authentik scaling (Phase 1): the op-type -> claim-priority mapping. Urgent
 * (access-removing / credential-revoking) operations must map to the low
 * URGENT_PRIORITY so they pre-empt a backlog of normal work; everything else
 * maps to NORMAL_PRIORITY.
 */

const {
  NORMAL_PRIORITY,
  URGENT_PRIORITY,
  URGENT_OPERATION_TYPES,
  priorityForOperationType,
  isUrgentOperationType
} = require('./syncOperationPriority');

describe('syncOperationPriority', () => {
  it('orders URGENT below NORMAL (lower number = higher priority)', () => {
    expect(URGENT_PRIORITY).toBeLessThan(NORMAL_PRIORITY);
  });

  it.each([...URGENT_OPERATION_TYPES])('maps urgent op type "%s" to URGENT_PRIORITY', (opType) => {
    expect(priorityForOperationType(opType)).toBe(URGENT_PRIORITY);
    expect(isUrgentOperationType(opType)).toBe(true);
  });

  it.each([
    'add_user_to_group',
    'remove_user_from_group',
    'create_group',
    'assign_user_to_global_channels',
    'bulk_add_user_to_team',
    'create_cloudtak_group',
    'update_cloudtak_group',
    'reconcile_team_channel_group'
  ])('maps non-urgent op type "%s" to NORMAL_PRIORITY', (opType) => {
    expect(priorityForOperationType(opType)).toBe(NORMAL_PRIORITY);
    expect(isUrgentOperationType(opType)).toBe(false);
  });

  it('defaults an unknown op type to NORMAL_PRIORITY (fail toward not-pre-empting)', () => {
    expect(priorityForOperationType('some_future_op_type')).toBe(NORMAL_PRIORITY);
    expect(isUrgentOperationType('some_future_op_type')).toBe(false);
  });

  it('includes revoke and cleanup in the urgent set (the credential/access-removal ops)', () => {
    expect(URGENT_OPERATION_TYPES.has('revoke_tak_certificates')).toBe(true);
    expect(URGENT_OPERATION_TYPES.has('cleanup_orphaned_authentik_user')).toBe(true);
  });
});
