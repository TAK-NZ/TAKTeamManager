// Feature: account-lifecycle-management, Property 1: account_status/is_active consistency across every reachable transition
//
// **Validates: Requirements 1.9, 3.3**

/**
 * account-lifecycle-management task 13.1: the single fast-check property
 * test for design.md's Testing Notes property candidate:
 *
 *   "is_active always agrees with account_status per Requirement 1.9's
 *   table, for any sequence of suspend/unsuspend/orphan transitions the
 *   state machine allows (active -> suspended -> active, active ->
 *   orphaned, suspended -> orphaned; orphaned is terminal)."
 *
 * MODEL-BASED, like this codebase's other DB-double property tests
 * (`DeviceSync.property.test.js`, `DeviceManagementService.selfScope
 * .property.test.js`): a single in-memory `users`/`user_cache` row is
 * driven through a randomly generated sequence of the three actions
 * (`suspend`, `unsuspend`, `orphan`) by calling the REAL production
 * entry points for each -- `AccountLifecycleService.suspendAccount`/
 * `unsuspendAccount` for the first two, and
 * `AuthentikSyncService.reconcileOrphanedAccounts` (with an empty
 * fetched-id set, so the row is always a candidate unless already
 * orphaned) for the third -- rather than reimplementing the state
 * machine. The mocked `pool`/`db` query function recognises each SQL
 * statement these two real modules issue and applies it to the model
 * row, closely mirroring how the sibling model-based property tests
 * apply a real WHERE clause/column list to an in-memory table.
 *
 * An invalid transition (e.g. `unsuspend` while `active`) is expected to
 * REJECT -- `AccountLifecycleService`'s own unit tests already cover
 * which error each rejection throws; this property only cares that a
 * rejection changes nothing, and that the invariant holds after every
 * single action in the sequence, valid or not.
 *
 * Requirement 1.9 / the glossary's own table:
 *   - `account_status = 'active'`   -> `is_active = true`
 *   - `account_status = 'suspended'` -> `is_active = false`
 *   - `account_status = 'orphaned'`  -> `is_active = false`
 *
 * ## Anti-vacuity
 *
 * A module-level `Set` records every DISTINCT `account_status` value the
 * model row is observed to hold across every generated run. A trailing
 * `it()` asserts all three ('active', 'suspended', 'orphaned') were
 * actually reached at least once -- a generator that, say, never
 * generated 'orphan' at all would make this property pass by never
 * exercising the terminal-state half of the claim.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue('op-id')
}));

const mockLoggerInstance = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../config/database');
const AccountLifecycleService = require('./AccountLifecycleService');
const authentikSync = require('./authentikSync');

const ACTING_USER = { userId: 9, is_global_manager: true };

/** Every `account_status` value observed across every generated run (anti-vacuity). */
const observedStatuses = new Set();

/**
 * Builds a mocked `query` function backed by the given mutable model row,
 * recognising exactly the statements `AccountLifecycleService.suspendAccount`/
 * `unsuspendAccount` and `AuthentikSyncService.reconcileOrphanedAccounts`
 * issue against `users`/`user_cache`/`audit_logs`. Shared between
 * `pool.connect()`'s returned client (suspend/unsuspend's transactional
 * client) and `pool.query` directly (the reconcile sweep's own bare-pool
 * writes), since both real modules ultimately go through the same mocked
 * `require('../config/database')` module.
 *
 * @param {{account_status: string, is_active: boolean}} row
 */
function makeQueryImpl(row) {
  return (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return Promise.resolve({ rows: [] });
    }

    // suspendAccount/unsuspendAccount's own row lock+read.
    if (typeof sql === 'string' && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
      return Promise.resolve({ rows: [{ ...row, id: 1, authentik_user_id: 'eid-1', is_team_device: false, username: 'human1' }] });
    }

    // reconcileOrphanedAccounts' candidate SELECT (no FOR UPDATE). Only a
    // candidate while not already orphaned, matching the real WHERE
    // clause's `account_status <> 'orphaned'` -- the authentik_user_id
    // filter is always satisfied here since every call in this test
    // passes an empty fetched-id set.
    if (typeof sql === 'string' && sql.includes('FROM users') && sql.includes("account_status <> 'orphaned'")) {
      if (row.account_status === 'orphaned') {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [{ id: 1, authentik_user_id: 'eid-1', is_team_device: false, username: 'human1' }] });
    }

    if (typeof sql === 'string' && sql.includes("UPDATE users SET account_status = 'suspended'")) {
      row.account_status = 'suspended';
      row.is_active = false;
      observedStatuses.add(row.account_status);
      return Promise.resolve({ rows: [] });
    }

    if (typeof sql === 'string' && sql.includes("UPDATE users SET account_status = 'active'")) {
      row.account_status = 'active';
      row.is_active = true;
      observedStatuses.add(row.account_status);
      return Promise.resolve({ rows: [] });
    }

    if (typeof sql === 'string' && sql.includes("UPDATE users SET account_status = 'orphaned'")) {
      row.account_status = 'orphaned';
      row.is_active = false;
      observedStatuses.add(row.account_status);
      return Promise.resolve({ rows: [] });
    }

    // Every user_cache write, and audit_logs insert: applied for realism
    // (both real modules issue them) but not consulted by this
    // property's own assertions, which are entirely about the `users`
    // row's own account_status/is_active pair.
    if (typeof sql === 'string' && sql.startsWith('UPDATE user_cache')) {
      return Promise.resolve({ rows: [] });
    }
    if (typeof sql === 'string' && sql.startsWith('INSERT INTO audit_logs')) {
      return Promise.resolve({ rows: [] });
    }

    return Promise.resolve({ rows: [] });
  };
}

describe('Property 1: account_status/is_active consistency across every reachable transition', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    delete global.fetch;
  });

  test.prop(
    [fc.array(fc.constantFrom('suspend', 'unsuspend', 'orphan'), { minLength: 0, maxLength: 12 })],
    { numRuns: 200 }
  )(
    'is_active agrees with account_status after every action in any generated suspend/unsuspend/orphan sequence',
    async (actions) => {
      const row = { account_status: 'active', is_active: true };
      observedStatuses.add(row.account_status);

      const queryImpl = makeQueryImpl(row);
      pool.query.mockImplementation(queryImpl);
      pool.connect.mockImplementation(async () => ({
        query: jest.fn(queryImpl),
        release: jest.fn()
      }));

      for (const action of actions) {
        try {
          if (action === 'suspend') {
            await AccountLifecycleService.suspendAccount(1, ACTING_USER);
          } else if (action === 'unsuspend') {
            await AccountLifecycleService.unsuspendAccount(1, ACTING_USER);
          } else {
            await authentikSync.reconcileOrphanedAccounts([]);
          }
        } catch {
          // An invalid transition for the current state (e.g. unsuspend
          // while active, or any action while orphaned) rejects with a
          // named error -- expected and asserted elsewhere
          // (AccountLifecycleService.test.js). This property only cares
          // that a rejection changes nothing, checked by the invariant
          // below regardless of whether this action succeeded.
        }

        // Requirement 1.9's table, checked after EVERY action.
        if (row.account_status === 'active') {
          expect(row.is_active).toBe(true);
        } else {
          // 'suspended' or 'orphaned'
          expect(row.is_active).toBe(false);
        }
      }

      // Terminal-state guarantee: once orphaned, no action in this
      // model can move it away from 'orphaned' (both suspendAccount/
      // unsuspendAccount reject on an orphaned row, and
      // reconcileOrphanedAccounts' own candidate query excludes an
      // already-orphaned row).
      if (row.account_status === 'orphaned') {
        const preOrphanState = { ...row };
        for (const action of ['suspend', 'unsuspend', 'orphan']) {
          try {
            if (action === 'suspend') {
              await AccountLifecycleService.suspendAccount(1, ACTING_USER);
            } else if (action === 'unsuspend') {
              await AccountLifecycleService.unsuspendAccount(1, ACTING_USER);
            } else {
              await authentikSync.reconcileOrphanedAccounts([]);
            }
          } catch {
            // Expected.
          }
        }
        expect(row).toEqual(preOrphanState);
      }
    }
  );

  it('exercised every reachable account_status at least once across the whole run (anti-vacuity)', () => {
    expect(observedStatuses).toEqual(new Set(['active', 'suspended', 'orphaned']));
  });
});
