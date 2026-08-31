// Feature: account-lifecycle-management, Property 2: The Reconciliation_Sweep never orphans a row present in the fetched id set, and always orphans (exactly once) a row absent from it and not already orphaned
//
// **Validates: Requirements 2.2, 2.4**

/**
 * account-lifecycle-management task 13.2: the single fast-check property
 * test for design.md's Testing Notes property candidate covering
 * `AuthentikSyncService.reconcileOrphanedAccounts`.
 *
 * MODEL-BASED, mirroring this codebase's other DB-double property tests
 * (`DeviceSync.property.test.js`): the mocked `db.query` is backed by an
 * in-memory `users` table (an array of plain row objects), and answers
 * each statement `reconcileOrphanedAccounts` actually issues by applying
 * THAT statement's own predicate/column-list against the model, rather
 * than by a hand-written stand-in that assumes the outcome. In
 * particular, the candidate SELECT's real WHERE clause is
 * `authentik_user_id::text <> ALL($1::text[]) AND account_status <>
 * 'orphaned'` -- reproduced here with real SQL `<> ALL` NULL semantics
 * (a NULL `authentik_user_id` compared with `<> ALL(...)` evaluates to
 * NULL/unknown, which a `WHERE` clause treats as false, so a
 * Claim_Row-shaped NULL-`authentik_user_id` row is NEVER a sweep
 * candidate -- it has no Authentik identity to have "gone missing" in
 * the first place).
 *
 * `EventPublisher.publishOperation` is mocked to a no-op resolve (its
 * own payload-shape correctness is covered by
 * `authentikSync.test.js`'s example tests); this property only cares
 * about the resulting `account_status`/`is_active` state, matching
 * `AccountLifecycleService.property.test.js`'s sibling property's own
 * scope.
 *
 * ## The property
 *
 * For any generated set of `users` rows and any generated
 * `fetchedAuthentikIds` set:
 *   1. every row whose `authentik_user_id` (as a string) IS a member of
 *      `fetchedAuthentikIds` is left completely untouched -- Never
 *      Orphaned, regardless of its account_status;
 *   2. every row whose `authentik_user_id` is a non-null string NOT in
 *      `fetchedAuthentikIds`, and whose `account_status` was NOT
 *      already `'orphaned'`, ends up `account_status = 'orphaned'`,
 *      `is_active = false`, with EXACTLY ONE `audit_logs` insert
 *      recorded for it (never zero, never more than one);
 *   3. every row whose `authentik_user_id` is `null`, OR whose
 *      `account_status` was ALREADY `'orphaned'`, is left completely
 *      untouched (no re-orphaning, no duplicate audit row) --
 *      `<> ALL(...)`'s NULL semantics for the first case, the explicit
 *      `account_status <> 'orphaned'` predicate for the second.
 *
 * ## Anti-vacuity
 *
 * A module-level pair of counters tracks, across the whole run, how
 * many rows actually took the "was orphaned by this run" path and how
 * many took the "left alone because already orphaned" path. A trailing
 * `it()` asserts both are non-zero, so the property is proven to have
 * actually exercised the interesting cases rather than only ever
 * generating all-fetched or all-orphaned-already fixtures.
 */

jest.mock('axios');

jest.mock('../config/database', () => ({
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

const db = require('../config/database');
const authentikSync = require('./authentikSync');

let orphanedByThisRunCount = 0;
let alreadyOrphanedLeftAloneCount = 0;

/**
 * Builds a `db.query` mock backed by the given mutable model rows array,
 * recognising exactly the statements `reconcileOrphanedAccounts` issues.
 * `auditInsertCountByRowId` is a `Map` this function populates so the
 * property can assert "exactly one audit row per newly-orphaned row".
 *
 * @param {Array<{id: number, authentik_user_id: string|null, is_team_device: boolean, username: string, account_status: string, is_active: boolean}>} rows
 * @param {Map<number, number>} auditInsertCountByRowId
 */
function makeDbQueryImpl(rows, auditInsertCountByRowId) {
  return (sql, params) => {
    if (typeof sql === 'string' && sql.includes('FROM users') && sql.includes('authentik_user_id::text <> ALL')) {
      const [fetchedIds] = params;
      const candidates = rows.filter((row) => {
        // Real SQL <> ALL($1) NULL semantics: NULL <> ALL(...) is
        // NULL/unknown, which WHERE treats as false -- a NULL
        // authentik_user_id row is never a candidate.
        if (row.authentik_user_id === null) {
          return false;
        }
        const notFetched = !fetchedIds.includes(String(row.authentik_user_id));
        const notAlreadyOrphaned = row.account_status !== 'orphaned';
        return notFetched && notAlreadyOrphaned;
      });
      return Promise.resolve({
        rows: candidates.map((row) => ({
          id: row.id,
          authentik_user_id: row.authentik_user_id,
          is_team_device: row.is_team_device,
          username: row.username
        }))
      });
    }

    if (typeof sql === 'string' && sql.includes("UPDATE users SET account_status = 'orphaned'")) {
      const [rowId] = params;
      const row = rows.find((r) => r.id === rowId);
      if (row) {
        row.account_status = 'orphaned';
        row.is_active = false;
      }
      return Promise.resolve({ rows: [] });
    }

    if (typeof sql === 'string' && sql.startsWith('UPDATE user_cache')) {
      return Promise.resolve({ rows: [] });
    }

    if (typeof sql === 'string' && sql.startsWith('INSERT INTO audit_logs')) {
      const rowId = params[3]; // resource_id positional param
      auditInsertCountByRowId.set(rowId, (auditInsertCountByRowId.get(rowId) || 0) + 1);
      return Promise.resolve({ rows: [] });
    }

    return Promise.resolve({ rows: [] });
  };
}

const rowArb = fc.record({
  id: fc.integer({ min: 1, max: 1000 }),
  // A minority of rows carry no Authentik identity at all (a Claim_Row
  // shape) -- these must never be swept regardless of account_status.
  authentik_user_id: fc.oneof(
    { arbitrary: fc.constant(null), weight: 1 },
    { arbitrary: fc.integer({ min: 1, max: 50 }).map(String), weight: 4 }
  ),
  is_team_device: fc.boolean(),
  username: fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0),
  account_status: fc.constantFrom('active', 'suspended', 'orphaned')
});

describe('Property 2: The Reconciliation_Sweep never orphans a fetched row, and always orphans (exactly once) a non-fetched, not-already-orphaned row', () => {
  test.prop(
    [
      fc.uniqueArray(rowArb, { minLength: 0, maxLength: 15, selector: (r) => r.id }),
      fc.array(fc.integer({ min: 1, max: 50 }).map(String), { minLength: 0, maxLength: 20 })
    ],
    { numRuns: 200 }
  )(
    'orphans exactly the non-fetched, not-already-orphaned rows, and leaves every other row untouched',
    async (seedRows, fetchedAuthentikIds) => {
      // Deep-copy the model so each generated run starts from a fresh,
      // independent row set.
      const rows = seedRows.map((r) => ({ ...r, is_active: r.account_status !== 'active' ? false : true }));
      const auditInsertCountByRowId = new Map();

      db.query.mockImplementation(makeDbQueryImpl(rows, auditInsertCountByRowId));

      const beforeSnapshot = rows.map((r) => ({ ...r }));

      await authentikSync.reconcileOrphanedAccounts(fetchedAuthentikIds);

      const fetchedSet = new Set(fetchedAuthentikIds);

      for (let i = 0; i < rows.length; i++) {
        const before = beforeSnapshot[i];
        const after = rows[i];

        const wasFetched = before.authentik_user_id !== null && fetchedSet.has(String(before.authentik_user_id));
        const wasAlreadyOrphaned = before.account_status === 'orphaned';
        const hasNoIdentity = before.authentik_user_id === null;

        if (wasFetched || wasAlreadyOrphaned || hasNoIdentity) {
          // Property clauses 1 and 3: never touched.
          expect(after).toEqual(before);
          if (wasAlreadyOrphaned && !hasNoIdentity) {
            alreadyOrphanedLeftAloneCount++;
            // No duplicate/second audit row for an already-orphaned row.
            expect(auditInsertCountByRowId.get(before.id) || 0).toBe(0);
          }
        } else {
          // Property clause 2: a genuine candidate -- orphaned exactly once.
          expect(after.account_status).toBe('orphaned');
          expect(after.is_active).toBe(false);
          expect(auditInsertCountByRowId.get(before.id)).toBe(1);
          orphanedByThisRunCount++;
        }
      }
    }
  );

  it('exercised both the "orphaned by this run" and the "already orphaned, left alone" cases at least once (anti-vacuity)', () => {
    expect(orphanedByThisRunCount).toBeGreaterThan(0);
    expect(alreadyOrphanedLeftAloneCount).toBeGreaterThan(0);
  });
});
