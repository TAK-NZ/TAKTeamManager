'use strict';

/**
 * Authentik scaling (Phase 2): the reconciler flags. The enablement flag
 * follows the codebase's strict boolean-env convention (true only for
 * 'true'); the dry-run flag is DELIBERATELY INVERTED (dry-run ON unless
 * exactly 'false'), so the safe observe-only state is the default.
 */

const {
  isBulkGroupReconcileEnabled,
  isBulkGroupReconcileDryRun
} = require('./bulkGroupReconcile');

describe('isBulkGroupReconcileEnabled', () => {
  it('is true ONLY for the exact string "true"', () => {
    expect(isBulkGroupReconcileEnabled({ BULK_GROUP_RECONCILE_ENABLED: 'true' })).toBe(true);
  });

  it.each([undefined, '', 'TRUE', ' true ', '1', 'false', 'yes'])(
    'is false for %p',
    (value) => {
      expect(isBulkGroupReconcileEnabled({ BULK_GROUP_RECONCILE_ENABLED: value })).toBe(false);
    }
  );

  it('defaults to false when the variable is absent', () => {
    expect(isBulkGroupReconcileEnabled({})).toBe(false);
  });
});

describe('isBulkGroupReconcileDryRun (inverted default)', () => {
  it('is DISARMED (false) ONLY for the exact string "false"', () => {
    expect(isBulkGroupReconcileDryRun({ BULK_GROUP_RECONCILE_DRY_RUN: 'false' })).toBe(false);
  });

  it.each([undefined, '', 'true', 'TRUE', ' false ', '0', 'no'])(
    'stays in dry-run (true) for %p',
    (value) => {
      expect(isBulkGroupReconcileDryRun({ BULK_GROUP_RECONCILE_DRY_RUN: value })).toBe(true);
    }
  );

  it('defaults to dry-run ON (true) when the variable is absent -- the safe state', () => {
    expect(isBulkGroupReconcileDryRun({})).toBe(true);
  });
});
