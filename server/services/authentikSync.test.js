jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const mockLoggerInstance = {
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

jest.mock('axios');

jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const axios = require('axios');
const db = require('../config/database');
const EventPublisher = require('./EventPublisher');
const authentikSync = require('./authentikSync');

describe('AuthentikSyncService.syncUsers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authentikSync.isRunning = false;
    console.error = jest.fn();
    console.log = jest.fn();
  });

  it('routes a sync failure through the structured logger instead of console.error', async () => {
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockRejectedValue(new Error('Authentik unreachable'));

    await expect(authentikSync.syncUsers()).resolves.toBeUndefined();

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('sync failed')
    );
    expect(console.error).not.toHaveBeenCalled();

    // The failure is also persisted to sync_status, matching existing behavior.
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sync_status'),
      ['error', 'Authentik unreachable', 'user_sync']
    );
  });

  it('does not crash the process when the sync run throws', async () => {
    db.query.mockRejectedValueOnce(new Error('DB unavailable'));

    await expect(authentikSync.syncUsers()).resolves.toBeUndefined();
    expect(authentikSync.isRunning).toBe(false);
  });

  it('logs via the structured logger (not console.log) when sync completes successfully', async () => {
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockResolvedValue({ data: { results: [], pagination: {} } });

    await authentikSync.syncUsers();

    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({ syncedCount: 0 }),
      expect.stringContaining('completed successfully')
    );
    expect(console.log).not.toHaveBeenCalled();
  });

  /**
   * Regression test: the user-list pagination loop previously read
   * `response.data.next` (always `undefined` -- Authentik's actual
   * pagination metadata lives under `response.data.pagination.next`, a
   * page NUMBER, exactly like fetchGroupMap already handles correctly
   * below), so it silently stopped after page 1 every single run. With
   * more users than one page (Authentik's default page_size is 20), any
   * user past the first page was NEVER written to user_cache by ANY
   * sync run -- not delayed until the next sync, but permanently
   * skipped, since every run has the exact same first-page-only bug.
   * That user's every login attempt then hits the "not found in
   * user_cache" path indefinitely.
   */
  it('follows pagination.next across multiple pages of the user list, so a user on page 2+ is not silently skipped by every sync run', async () => {
    const page1Users = [{ pk: 1, username: 'page1-user', email: 'page1@example.com', groups: [] }];
    const page2Users = [{ pk: 2, username: 'page2-user', email: 'page2@example.com', groups: [] }];

    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({ data: { results: [], pagination: {} } });
      }
      if (url.includes('page=2')) {
        return Promise.resolve({ data: { results: page2Users, pagination: { next: null } } });
      }
      return Promise.resolve({ data: { results: page1Users, pagination: { next: 2 } } });
    });

    await authentikSync.syncUsers();

    const userListCalls = axios.get.mock.calls.filter(([url]) => url.includes('/api/v3/core/users/'));
    expect(userListCalls).toHaveLength(2);
    expect(userListCalls[0][0]).toContain('page=1');
    expect(userListCalls[1][0]).toContain('page=2');

    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({ totalUsers: 2 }),
      expect.stringContaining('Total users to sync')
    );

    // Both pages' users were actually processed (user_cache upsert
    // issued for each), not just fetched and discarded.
    const userCacheInserts = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO user_cache')
    );
    expect(userCacheInserts).toHaveLength(2);
  });

  it('stops paginating once pagination.next is absent (single-page case still works)', async () => {
    const users = [{ pk: 1, username: 'solo-user', email: 'solo@example.com', groups: [] }];

    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({ data: { results: [], pagination: {} } });
      }
      return Promise.resolve({ data: { results: users, pagination: {} } });
    });

    await authentikSync.syncUsers();

    const userListCalls = axios.get.mock.calls.filter(([url]) => url.includes('/api/v3/core/users/'));
    expect(userListCalls).toHaveLength(1);
  });

  /**
   * Bugfix (mass false-positive orphaning during a concurrent bulk
   * import): Authentik's `/core/users/` defaults to ordering
   * ALPHABETICALLY BY USERNAME with no stable secondary key. While a
   * large CSV import inserts thousands of new accounts concurrently
   * with a periodic sync run, a user can shift between pages mid-fetch
   * and be silently skipped -- the resulting incomplete-but-
   * looks-complete `allUsers` set then feeds `reconcileOrphanedAccounts`,
   * which wrongly marks every skipped REAL user `'orphaned'` and
   * enqueues a certificate revoke against them. Confirmed live: of 100
   * accounts orphaned during one FENZ CSV import, all 100 still existed
   * in Authentik. `ordering=pk` (immutable once assigned, unaffected by
   * concurrent inserts of OTHER users) fixes this. This test pins the
   * query param is actually sent on every page request, not just the
   * first.
   */
  it('requests the user list with a stable ordering=pk param, on every page, so concurrent inserts cannot shift a user across a page boundary mid-fetch', async () => {
    const page1Users = [{ pk: 1, username: 'page1-user', email: 'page1@example.com', groups: [] }];
    const page2Users = [{ pk: 2, username: 'page2-user', email: 'page2@example.com', groups: [] }];

    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({ data: { results: [], pagination: {} } });
      }
      if (url.includes('page=2')) {
        return Promise.resolve({ data: { results: page2Users, pagination: { next: null } } });
      }
      return Promise.resolve({ data: { results: page1Users, pagination: { next: 2 } } });
    });

    await authentikSync.syncUsers();

    const userListCalls = axios.get.mock.calls.filter(([url]) => url.includes('/api/v3/core/users/'));
    expect(userListCalls).toHaveLength(2);
    for (const [url] of userListCalls) {
      expect(url).toContain('ordering=pk');
    }
  });

  it('requests the group list with a stable ordering=num_pk param, so a concurrently created/renamed group cannot be skipped mid-fetch', async () => {
    const page1Groups = [{ pk: 'g1', name: 'GroupOne' }];
    const page2Groups = [{ pk: 'g2', name: 'GroupTwo' }];

    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/groups/')) {
        if (url.includes('page=2')) {
          return Promise.resolve({ data: { results: page2Groups, pagination: { next: null } } });
        }
        return Promise.resolve({ data: { results: page1Groups, pagination: { next: 2 } } });
      }
      return Promise.resolve({ data: { results: [], pagination: {} } });
    });

    await authentikSync.syncUsers();

    const groupListCalls = axios.get.mock.calls.filter(([url]) => url.includes('/api/v3/core/groups/'));
    expect(groupListCalls.length).toBeGreaterThanOrEqual(2);
    for (const [url] of groupListCalls) {
      expect(url).toContain('ordering=num_pk');
    }
  });

  it('fetches the Authentik group list exactly once per run, even across multiple batches of users', async () => {
    // batchSize inside syncUsers is 50, so 120 users forces 3 processBatch calls
    // within a single syncUsers() run.
    const totalUsers = 120;
    const users = Array.from({ length: totalUsers }, (_, i) => ({
      pk: `user-${i}`,
      username: `user${i}`,
      email: `user${i}@example.com`,
      groups: [],
      is_active: true,
      attributes: {}
    }));

    db.query.mockResolvedValue({ rows: [] });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/users/')) {
        return Promise.resolve({ data: { results: users, next: null } });
      }
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({
          data: { results: [{ pk: 'g1', name: 'GroupOne' }], pagination: {} }
        });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    await authentikSync.syncUsers();

    const groupCalls = axios.get.mock.calls.filter(([url]) =>
      url.includes('/api/v3/core/groups/')
    );
    expect(groupCalls).toHaveLength(1);

    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({ syncedCount: totalUsers }),
      expect.stringContaining('completed successfully')
    );
  });

  // Requirement 11.6: a failed initial group-list fetch must abort the sync
  // run before any user_cache write occurs, leaving sync_status in an
  // 'error' state for retry on the next scheduled interval.
  it('aborts before any user_cache write when the group-list fetch fails on the first page', async () => {
    const users = Array.from({ length: 5 }, (_, i) => ({
      pk: `user-${i}`,
      username: `user${i}`,
      email: `user${i}@example.com`,
      groups: [],
      is_active: true,
      attributes: {}
    }));

    db.query.mockResolvedValue({ rows: [] });

    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/users/')) {
        return Promise.resolve({ data: { results: users, next: null } });
      }
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.reject(new Error('groups endpoint unreachable'));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    await expect(authentikSync.syncUsers()).resolves.toBeUndefined();

    // No INSERT INTO user_cache call was ever made -- processBatch/
    // syncSingleUser never ran.
    const userCacheWrites = db.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO user_cache')
    );
    expect(userCacheWrites).toHaveLength(0);

    // sync_status was set to 'error' for retry on the next scheduled interval.
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sync_status'),
      expect.arrayContaining(['error'])
    );

    // syncUsers() resolves without throwing, matching the existing pattern
    // where it catches and handles errors internally.
    expect(authentikSync.isRunning).toBe(false);
  });

  it('aborts before any user_cache write when a LATER page of the group-list fetch fails (partial group fetch)', async () => {
    const users = Array.from({ length: 5 }, (_, i) => ({
      pk: `user-${i}`,
      username: `user${i}`,
      email: `user${i}@example.com`,
      groups: [],
      is_active: true,
      attributes: {}
    }));

    db.query.mockResolvedValue({ rows: [] });

    let groupsPageRequests = 0;
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/users/')) {
        return Promise.resolve({ data: { results: users, next: null } });
      }
      if (url.includes('/api/v3/core/groups/')) {
        groupsPageRequests += 1;
        if (groupsPageRequests === 1) {
          // First page succeeds, indicating more pages follow.
          return Promise.resolve({
            data: { results: [{ pk: 'g1', name: 'GroupOne' }], pagination: { next: 2 } }
          });
        }
        // Second page fails.
        return Promise.reject(new Error('groups page 2 unreachable'));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    await expect(authentikSync.syncUsers()).resolves.toBeUndefined();

    expect(groupsPageRequests).toBeGreaterThanOrEqual(2);

    // Even though the first group page succeeded, the partial group data
    // must never be used to process any user batch.
    const userCacheWrites = db.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO user_cache')
    );
    expect(userCacheWrites).toHaveLength(0);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sync_status'),
      expect.arrayContaining(['error'])
    );

    expect(authentikSync.isRunning).toBe(false);
  });
});

// account-lifecycle-management Requirements 2, 3 (tasks 6.3, 7.6):
// AuthentikSyncService.reconcileOrphanedAccounts, called from syncUsers()
// only on the success path.
describe('AuthentikSyncService.reconcileOrphanedAccounts (account-lifecycle-management)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authentikSync.isRunning = false;
    console.error = jest.fn();
    console.log = jest.fn();
  });

  it('is never invoked when the fetch loop\'s own catch already aborted the run (group-list fetch failure)', async () => {
    const users = [{ pk: 'user-1', username: 'user1', email: 'user1@example.com', groups: [], is_active: true, attributes: {} }];
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/users/')) {
        return Promise.resolve({ data: { results: users, pagination: {} } });
      }
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.reject(new Error('groups endpoint unreachable'));
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const reconcileSpy = jest.spyOn(authentikSync, 'reconcileOrphanedAccounts');

    await authentikSync.syncUsers();

    expect(reconcileSpy).not.toHaveBeenCalled();
    reconcileSpy.mockRestore();
  });

  it('is never invoked when the paginated user-list fetch itself throws (outer catch)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockRejectedValue(new Error('Authentik unreachable'));

    const reconcileSpy = jest.spyOn(authentikSync, 'reconcileOrphanedAccounts');

    await authentikSync.syncUsers();

    expect(reconcileSpy).not.toHaveBeenCalled();
    reconcileSpy.mockRestore();
  });

  it('IS invoked, with the exact fetched authentik id set, after a fully successful sync run', async () => {
    const users = [
      { pk: 1, username: 'user1', email: 'user1@example.com', groups: [], is_active: true, attributes: {} },
      { pk: 2, username: 'user2', email: 'user2@example.com', groups: [], is_active: true, attributes: {} }
    ];
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/users/')) {
        return Promise.resolve({ data: { results: users, pagination: {} } });
      }
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({ data: { results: [], pagination: {} } });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const reconcileSpy = jest.spyOn(authentikSync, 'reconcileOrphanedAccounts').mockResolvedValue(undefined);

    await authentikSync.syncUsers();

    expect(reconcileSpy).toHaveBeenCalledWith(['1', '2']);
    reconcileSpy.mockRestore();
  });

  // Resiliency-hardening (the live mass-false-orphan incident): the paginated
  // user fetch can terminate "cleanly" (pagination.next goes falsy) while the
  // accumulated `allUsers` is INCOMPLETE -- an unhealthy/mid-upgrade Authentik
  // returning a short page or a prematurely-absent `next`. The old code trusted
  // that incomplete set as complete and handed it to reconcileOrphanedAccounts,
  // which then orphaned every real user the run happened not to see. The fix:
  // syncUsers compares the accumulated count against the `pagination.count`
  // Authentik reports and SKIPS the sweep entirely when they disagree.
  it('resiliency-hardening: does NOT run the sweep when the fetched page count disagrees with pagination.count', async () => {
    // Authentik REPORTS count=3 but the loop only ever receives 2 results
    // (pagination.next is absent, so the loop terminates believing it is done).
    const users = [
      { pk: 1, username: 'user1', email: 'user1@example.com', groups: [], is_active: true, attributes: {} },
      { pk: 2, username: 'user2', email: 'user2@example.com', groups: [], is_active: true, attributes: {} }
    ];
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/users/')) {
        return Promise.resolve({ data: { results: users, pagination: { count: 3, next: null } } });
      }
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({ data: { results: [], pagination: {} } });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const reconcileSpy = jest.spyOn(authentikSync, 'reconcileOrphanedAccounts').mockResolvedValue(undefined);

    await authentikSync.syncUsers();

    // The sweep is the destructive, one-way step -- it must NOT run on a
    // provably-incomplete fetch.
    expect(reconcileSpy).not.toHaveBeenCalled();
    // The incompleteness is surfaced (visible anomaly, not a silent skip).
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ fetchedCount: 2, reportedCount: 3 }),
      expect.stringContaining('incomplete')
    );
    reconcileSpy.mockRestore();
  });

  // The batch/user_cache processing is additive and self-correcting (it only
  // writes rows it saw, never removes), so a partial fetch must still sync the
  // cache -- only the destructive sweep is skipped. Assert processBatch still
  // ran for the fetched users even though the sweep was skipped above.
  it('resiliency-hardening: STILL syncs the fetched users to the cache when the sweep is skipped for incompleteness', async () => {
    const users = [
      { pk: 1, username: 'user1', email: 'user1@example.com', groups: [], is_active: true, attributes: {} }
    ];
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/users/')) {
        return Promise.resolve({ data: { results: users, pagination: { count: 99, next: null } } });
      }
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({ data: { results: [], pagination: {} } });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const reconcileSpy = jest.spyOn(authentikSync, 'reconcileOrphanedAccounts').mockResolvedValue(undefined);
    const processBatchSpy = jest.spyOn(authentikSync, 'processBatch').mockResolvedValue(undefined);

    await authentikSync.syncUsers();

    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(processBatchSpy).toHaveBeenCalledTimes(1);
    expect(processBatchSpy).toHaveBeenCalledWith(users, expect.anything());
    reconcileSpy.mockRestore();
    processBatchSpy.mockRestore();
  });

  // The completeness guard fires only on a DISAGREEMENT: when the accumulated
  // count matches pagination.count, the fetch is provably complete and the
  // sweep runs as before.
  it('resiliency-hardening: DOES run the sweep when the fetched count matches pagination.count', async () => {
    const users = [
      { pk: 1, username: 'user1', email: 'user1@example.com', groups: [], is_active: true, attributes: {} },
      { pk: 2, username: 'user2', email: 'user2@example.com', groups: [], is_active: true, attributes: {} }
    ];
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/users/')) {
        return Promise.resolve({ data: { results: users, pagination: { count: 2, next: null } } });
      }
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({ data: { results: [], pagination: {} } });
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const reconcileSpy = jest.spyOn(authentikSync, 'reconcileOrphanedAccounts').mockResolvedValue(undefined);

    await authentikSync.syncUsers();

    expect(reconcileSpy).toHaveBeenCalledWith(['1', '2']);
    reconcileSpy.mockRestore();
  });

  it('resiliency-hardening: refuses to run the sweep at all against an empty fetched-id list, and issues no query', async () => {
    await authentikSync.reconcileOrphanedAccounts([]);

    expect(db.query).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ fetchedAuthentikIds: [] }),
      expect.stringContaining('empty or malformed fetched-id list')
    );
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'not-an-array'],
    ['a plain object', { length: 3 }]
  ])('resiliency-hardening: refuses to run the sweep for a malformed fetchedAuthentikIds (%s), and issues no query', async (_label, malformed) => {
    await authentikSync.reconcileOrphanedAccounts(malformed);

    expect(db.query).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ fetchedAuthentikIds: malformed }),
      expect.stringContaining('empty or malformed fetched-id list')
    );
  });

  it('excludes rows already account_status = \'orphaned\' from its candidate query', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.reconcileOrphanedAccounts(['100', '200']);

    const [sql, params] = db.query.mock.calls.find(([q]) => typeof q === 'string' && q.includes('FROM users'));
    expect(sql).toContain("account_status <> 'orphaned'");
    expect(sql).toContain('authentik_user_id::text <> ALL($1::text[])');
    expect(params).toEqual([['100', '200']]);
  });

  it('does nothing further when the candidate query returns zero rows', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.reconcileOrphanedAccounts(['1']);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1); // only the SELECT
  });

  it('performs all 4 steps for a human candidate row: enqueue tak_usernames, clear cache callsign/color, mark orphaned + is_active=false on both tables, and a system-attributed audit log', async () => {
    const candidateRow = { id: 42, authentik_user_id: 999, is_team_device: false, username: 'ada' };
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users')) {
        return Promise.resolve({ rows: [candidateRow] });
      }
      return Promise.resolve({ rows: [] });
    });
    EventPublisher.publishOperation.mockResolvedValue(1);

    await authentikSync.reconcileOrphanedAccounts(['unrelated-fetched-id']);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { tak_usernames: ['ada'] },
      null
    );

    expect(db.query).toHaveBeenCalledWith(
      'UPDATE user_cache SET tak_callsign = $1, tak_color = $2 WHERE authentik_id = $3',
      ['None', 'None', '999']
    );

    expect(db.query).toHaveBeenCalledWith(
      "UPDATE users SET account_status = 'orphaned', is_active = false WHERE id = $1",
      [42]
    );
    expect(db.query).toHaveBeenCalledWith(
      'UPDATE user_cache SET is_active = false WHERE authentik_id = $1',
      ['999']
    );

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      [null, 'user.orphaned', 'user', 42, JSON.stringify({ reason: 'authentik_account_missing' })]
    );
  });

  it('enqueues client_uid (not tak_usernames) and SKIPS the cache-callsign-clear step for a Team_Owned_Device candidate row', async () => {
    const deviceRow = { id: 7, authentik_user_id: 501, is_team_device: true, username: 'AUK-D7K3QMX' };
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users')) {
        return Promise.resolve({ rows: [deviceRow] });
      }
      return Promise.resolve({ rows: [] });
    });
    EventPublisher.publishOperation.mockResolvedValue(1);

    await authentikSync.reconcileOrphanedAccounts(['unrelated-fetched-id']);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { client_uid: 'AUK-D7K3QMX' },
      null
    );

    // No callsign/color clear for a device row (Requirement 3 Criterion 2).
    expect(db.query).not.toHaveBeenCalledWith(
      'UPDATE user_cache SET tak_callsign = $1, tak_color = $2 WHERE authentik_id = $3',
      expect.anything()
    );

    // The orphan-marking and audit steps still run for a device row.
    expect(db.query).toHaveBeenCalledWith(
      "UPDATE users SET account_status = 'orphaned', is_active = false WHERE id = $1",
      [7]
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      [null, 'user.orphaned', 'user', 7, JSON.stringify({ reason: 'authentik_account_missing' })]
    );
  });

  it('never issues a DELETE statement against any table (Criterion 3.5)', async () => {
    const candidateRow = { id: 1, authentik_user_id: 1, is_team_device: false, username: 'someone' };
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users')) {
        return Promise.resolve({ rows: [candidateRow] });
      }
      return Promise.resolve({ rows: [] });
    });
    EventPublisher.publishOperation.mockResolvedValue(1);

    await authentikSync.reconcileOrphanedAccounts(['unrelated-fetched-id']);

    const deleteCalls = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && /^\s*DELETE/i.test(sql)
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it('continues processing the remaining candidate rows when one row\'s step throws', async () => {
    const failingRow = { id: 1, authentik_user_id: 111, is_team_device: false, username: 'failing-user' };
    const okRow = { id: 2, authentik_user_id: 222, is_team_device: false, username: 'ok-user' };

    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users')) {
        return Promise.resolve({ rows: [failingRow, okRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    EventPublisher.publishOperation.mockImplementation((operationType, payload) => {
      if (payload.tak_usernames && payload.tak_usernames[0] === 'failing-user') {
        return Promise.reject(new Error('enqueue failed'));
      }
      return Promise.resolve(1);
    });

    await authentikSync.reconcileOrphanedAccounts(['unrelated-fetched-id']);

    // The ok-user's steps still ran despite the failing-user's enqueue
    // rejecting first.
    expect(db.query).toHaveBeenCalledWith(
      "UPDATE users SET account_status = 'orphaned', is_active = false WHERE id = $1",
      [2]
    );
    expect(db.query).not.toHaveBeenCalledWith(
      "UPDATE users SET account_status = 'orphaned', is_active = false WHERE id = $1",
      [1]
    );

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), userId: 1 }),
      expect.stringContaining('failed to orphan one candidate row')
    );
  });

  it('does not throw and skips the sweep entirely when the candidate SELECT itself fails', async () => {
    db.query.mockRejectedValue(new Error('DB unavailable'));

    await expect(authentikSync.reconcileOrphanedAccounts(['1'])).resolves.toBeUndefined();

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('failed to query candidate rows')
    );
  });
});

describe('AuthentikSyncService.processBatch concurrency (Requirement 11.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
    delete process.env.AUTHENTIK_SYNC_CONCURRENCY;
  });

  afterEach(() => {
    delete process.env.AUTHENTIK_SYNC_CONCURRENCY;
  });

  function makeUsers(count) {
    return Array.from({ length: count }, (_, i) => ({
      pk: `user-${i}`,
      username: `user${i}`,
      email: `user${i}@example.com`,
      groups: [],
      is_active: true,
      attributes: {}
    }));
  }

  it('calls db.query twice per user in the batch (users + user_cache) regardless of concurrency setting', async () => {
    const users = makeUsers(12);
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 1, is_team_device: false }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch(users, {});

    // Each user now results in one INSERT INTO users, one INSERT INTO
    // user_cache, and two SELECTs for the push-to-Authentik comparison.
    expect(db.query).toHaveBeenCalledTimes(48);
    users.forEach(user => {
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_cache'),
        expect.arrayContaining([user.pk, user.username])
      );
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        [user.pk, user.username, user.email, user.username, '', null]
      );
    });
  });

  // takserver-enrollment Requirement 5.6: this test previously pinned the
  // BUG this task fixes -- the old `if (user.email)` guard silently
  // excluded every emailless principal (including every Team_Owned_Device)
  // from the local `users` table entirely. The guard is removed, so the
  // INSERT INTO users is now attempted for an emailless principal too, with
  // `null` (not '') bound to its email parameter via normaliseAuthentikEmail.
  it('no longer skips the INSERT INTO users call for a user with no email (guard removed; null bound to both upserts)', async () => {
    const serviceAccountUser = {
      pk: 'user-svc-1',
      username: 'etl-adsbx',
      email: '',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([serviceAccountUser], {});

    // Both upserts run: the users upsert (no local row returned by this
    // mock, so the push-to-Authentik step below is skipped) and the
    // user_cache upsert.
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      [serviceAccountUser.pk, serviceAccountUser.username, null, serviceAccountUser.username, '', null]
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_cache'),
      expect.arrayContaining([serviceAccountUser.pk, serviceAccountUser.username, null])
    );
  });

  it('no longer skips the INSERT INTO users call for a user with an undefined email (guard removed; null bound to both upserts)', async () => {
    const serviceAccountUser = {
      pk: 'user-svc-2',
      username: 'ak-outpost-1234',
      email: undefined,
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([serviceAccountUser], {});

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      [serviceAccountUser.pk, serviceAccountUser.username, null, serviceAccountUser.username, '', null]
    );
  });

  it('still performs both INSERT INTO users and INSERT INTO user_cache for a user with an email', async () => {
    const humanUser = {
      pk: 'user-human-1',
      username: 'chris',
      email: 'chris@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 42, is_team_device: false }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([humanUser], {});

    // 2 inserts (users + user_cache) + 2 SELECTs for push-to-Authentik check,
    // reached because the users upsert's RETURNING id resolved a local row.
    expect(db.query).toHaveBeenCalledTimes(4);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      [humanUser.pk, humanUser.username, humanUser.email, humanUser.username, '', null]
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_cache'),
      expect.arrayContaining([humanUser.pk, humanUser.username])
    );
  });

  it('continues processing other users when one user\'s DB insert fails', async () => {
    const users = makeUsers(5);
    const failingUser = users[2];

    db.query.mockImplementation((sql, params) => {
      if (params && params[0] === failingUser.pk) {
        return Promise.reject(new Error('insert failed'));
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 1, is_team_device: false }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch(users, {});

    // Every user, including the failing one, still got an INSERT attempt.
    // The 4 succeeding users each make 4 calls (users + user_cache + 2
    // SELECTs for push-to-Authentik check); the failing user's first call
    // (INSERT INTO users, which also keys off user.pk as params[0]) rejects,
    // so its remaining calls never run -- the existing per-user try/catch
    // stops after the first thrown error.
    expect(db.query).toHaveBeenCalledTimes(17);

    // The failure was logged per-user rather than thrown/propagated.
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), username: failingUser.username }),
      'Failed to sync user'
    );

    // The other four users' inserts succeeded (no error logged for them).
    const errorCallsForOtherUsers = mockLoggerInstance.error.mock.calls.filter(
      ([meta]) => meta.username !== failingUser.username
    );
    expect(errorCallsForOtherUsers).toHaveLength(0);
  });

  it('defaults concurrency to 5 when AUTHENTIK_SYNC_CONCURRENCY is unset', () => {
    expect(authentikSync.getAuthentikSyncConcurrency()).toBe(5);
  });

  it('clamps concurrency to 20 when set above the maximum', () => {
    process.env.AUTHENTIK_SYNC_CONCURRENCY = '500';
    expect(authentikSync.getAuthentikSyncConcurrency()).toBe(20);
  });

  it('clamps concurrency to 1 when set to a negative value', () => {
    process.env.AUTHENTIK_SYNC_CONCURRENCY = '-3';
    expect(authentikSync.getAuthentikSyncConcurrency()).toBe(1);
  });

  it('defaults concurrency to 5 when set to a non-numeric value', () => {
    process.env.AUTHENTIK_SYNC_CONCURRENCY = 'not-a-number';
    expect(authentikSync.getAuthentikSyncConcurrency()).toBe(5);
  });

  it('respects a valid in-range concurrency value', () => {
    process.env.AUTHENTIK_SYNC_CONCURRENCY = '12';
    expect(authentikSync.getAuthentikSyncConcurrency()).toBe(12);
  });
});

describe('AuthentikSyncService.syncSingleUser users.tak_role reconciliation (Requirements 13.7, 13.8, task 29.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
  });

  it('updates users.tak_role to match Authentik\'s takRole attribute when it differs from the local value', async () => {
    // TAK Team Manager is authoritative for tak_role: the ON CONFLICT
    // clause no longer overwrites tak_role from Authentik. The takRole
    // from Authentik is only used to seed new users on INSERT via
    // COALESCE($6, 'Team Member').
    const user = {
      pk: 'user-1',
      username: 'alice',
      email: 'alice@example.com',
      groups: [],
      is_active: true,
      attributes: { takRole: 'Team Lead' }
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([user], {});

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      [user.pk, user.username, user.email, user.username, '', 'Team Lead']
    );
    const [usersSql] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    expect(usersSql).toContain('COALESCE($6, \'Team Member\')');
    // On conflict, only identity fields are updated (local is authoritative for tak_role)
    expect(usersSql).toContain('ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3');
    expect(usersSql).not.toContain('tak_role = COALESCE');
  });

  it('sets users.tak_role from Authentik\'s takRole attribute on initial insert for a user with no existing users row', async () => {
    const user = {
      pk: 'user-2',
      username: 'bob',
      email: 'bob@example.com',
      groups: [],
      is_active: true,
      attributes: { takRole: 'Medic' }
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([user], {});

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      [user.pk, user.username, user.email, user.username, '', 'Medic']
    );
  });

  it('does not clobber an established local users.tak_role when Authentik has no takRole attribute set (sparse attribute)', async () => {
    // TAK Team Manager is authoritative for tak_role. The ON CONFLICT
    // clause no longer touches tak_role at all. On INSERT, COALESCE($6,
    // 'Team Member') seeds a default when Authentik has no value.
    const user = {
      pk: 'user-3',
      username: 'carol',
      email: 'carol@example.com',
      groups: [],
      is_active: true,
      attributes: {} // no takRole attribute at all
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([user], {});

    const [usersSql, usersParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    // The tak_role param passed is null (Authentik has no value), and
    // COALESCE($6, 'Team Member') handles the INSERT seed.
    expect(usersParams).toEqual([user.pk, user.username, user.email, user.username, '', null]);
    expect(usersSql).toContain('COALESCE($6, \'Team Member\')');
    // On conflict, tak_role is NOT updated (local is authoritative)
    expect(usersSql).not.toContain('tak_role = COALESCE');
  });

  it('leaves the user_cache.tak_role upsert seed-only (not overwritten on conflict), since local is authoritative', async () => {
    const user = {
      pk: 'user-4',
      username: 'dave',
      email: 'dave@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([user], {});

    const [cacheSql, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    // tak_role is NOT in the ON CONFLICT DO UPDATE SET (local authoritative)
    expect(cacheSql).not.toContain('tak_role = EXCLUDED.tak_role');
    // tak_role is the 7th positional value (index 6) in the user_cache insert.
    // Bugfix: it is now seeded from the `users` upsert's RETURNING tak_role
    // (`localTakRole`), not from Authentik's attribute. This mock returns
    // `{ rows: [] }` for the users upsert, so localTakRole resolves to null
    // (via `?? null`) rather than the previous `undefined` from
    // `user.attributes?.takRole`.
    expect(cacheParams[6]).toBeNull();
  });

  // /users "Last Login" restoration: the sync captures Authentik's own
  // `last_login` into user_cache.last_login so the local-sourced /users list
  // can render it (it showed "Never" for everyone after /users was migrated
  // off the live Authentik fetch). Unlike the bootstrap-then-local fields,
  // last_login is a mutable mirror and IS refreshed on conflict.
  it('captures Authentik last_login into the user_cache upsert (positional value) and refreshes it on conflict', async () => {
    const user = {
      pk: 'user-ll',
      username: 'lorna',
      email: 'lorna@example.com',
      groups: [],
      is_active: true,
      last_login: '2026-09-01T08:30:00.000Z',
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([user], {});

    const [cacheSql, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    // last_login is the 13th positional value (index 12), appended after
    // is_team_device so no existing index shifts.
    expect(cacheParams[12]).toBe('2026-09-01T08:30:00.000Z');
    // Mutable mirror: refreshed from EXCLUDED on conflict, unlike the
    // bootstrap-then-local fields.
    expect(cacheSql).toContain('last_login = EXCLUDED.last_login');
  });

  it('binds null last_login for a user Authentik reports as never having logged in', async () => {
    const user = {
      pk: 'user-never',
      username: 'newbie',
      email: 'newbie@example.com',
      groups: [],
      is_active: true,
      last_login: null,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([user], {});

    const [, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    expect(cacheParams[12]).toBeNull();
  });

  it('seeds user_cache.tak_role from the local users row (RETURNING tak_role), NOT from Authentik\'s takRole attribute', async () => {
    // The Dashboard bug: for a bulk-import/create-and-add user, Authentik
    // carries no takRole attribute but the local `users.tak_role` holds the
    // authoritative value (e.g. the 'Team Member' default). The cache mirror
    // must be seeded from that local value, or user_cache.tak_role stays
    // NULL and the "My TAK Role" block renders nothing.
    const user = {
      pk: 'user-role-seed',
      username: 'erin',
      email: 'erin@example.com',
      groups: [],
      is_active: true,
      // Authentik has NO takRole -- exactly the locally-provisioned case.
      attributes: {}
    };
    // The users upsert's RETURNING resolves the local authoritative value
    // (COALESCE'd to 'Team Member' on insert). Every other query resolves
    // empty. `tak_role` must be present on the returned row for this path.
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 42, is_team_device: false, tak_role: 'Team Member' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([user], {});

    const usersInsert = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    // The users upsert asks Postgres to RETURN tak_role, so the cache seed
    // can mirror the effective (defaulted/local) value.
    expect(usersInsert[0]).toContain('RETURNING id, is_team_device, tak_role');

    const [, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    // Index 6 = tak_role: comes from the users RETURNING value, not the
    // (absent) Authentik attribute.
    expect(cacheParams[6]).toBe('Team Member');
  });
});

describe('AuthentikSyncService.syncSingleUser first_name/last_name one-way seed-only sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
  });

  it('seeds first_name/last_name from Authentik\'s name for a brand-new user (no existing local row)', async () => {
    const user = {
      pk: 'user-new-1',
      username: 'newuser',
      email: 'newuser@example.com',
      name: 'New Person',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([user], {});

    // The INSERT ... VALUES list still seeds first_name/last_name from
    // Authentik's `name` (no local row exists yet to protect), but the
    // ON CONFLICT DO UPDATE SET clause must not mention first_name/last_name
    // at all, so a later sync can never overwrite an established value.
    const [usersSql, usersParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    expect(usersParams).toEqual([user.pk, user.username, user.email, 'New Person', '', null]);
    expect(usersSql).not.toContain('first_name = $4');
    expect(usersSql).not.toContain('last_name = $5');

    const [cacheSql] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    expect(cacheSql).not.toContain('first_name = EXCLUDED.first_name');
    expect(cacheSql).not.toContain('last_name = EXCLUDED.last_name');
  });

  it('does not overwrite an existing user\'s first_name/last_name on conflict, even when Authentik\'s name differs', async () => {
    // Simulates a user whose first_name/last_name were correctly split
    // locally (e.g. via the Member_List inline-edit route), while
    // Authentik still only has a single, differing `name` value. The
    // ON CONFLICT DO UPDATE SET clause omitting first_name/last_name means
    // Postgres leaves the existing stored columns untouched regardless of
    // what params are passed -- this test asserts that clause shape,
    // since a mocked db.query can't exercise real conflict resolution.
    const user = {
      pk: 'user-existing-1',
      username: 'existinguser',
      email: 'existing@example.com',
      name: 'Full Name From Authentik',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([user], {});

    const [usersSql] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    expect(usersSql).toContain('ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3');
    expect(usersSql).not.toMatch(/DO UPDATE SET[^)]*first_name/);
    expect(usersSql).not.toMatch(/DO UPDATE SET[^)]*last_name/);
  });
});

describe('AuthentikSyncService.startPeriodicSync fire-and-forget backstop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    authentikSync.isRunning = false;
    console.error = jest.fn();
    console.log = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('routes an error from the initial delayed syncUsers() call through logger.error instead of an unhandled rejection', async () => {
    const syncSpy = jest
      .spyOn(authentikSync, 'syncUsers')
      .mockRejectedValue(new Error('boom'));

    authentikSync.startPeriodicSync();

    // Advance past the 5s startup delay so the setTimeout callback fires.
    jest.advanceTimersByTime(5000);
    // Let the rejected promise's .catch() handler run.
    await Promise.resolve();
    await Promise.resolve();

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Periodic Authentik sync failed')
    );

    syncSpy.mockRestore();
  });

  it('routes an error from the recurring setInterval syncUsers() call through logger.error', async () => {
    const syncSpy = jest
      .spyOn(authentikSync, 'syncUsers')
      .mockRejectedValue(new Error('interval boom'));

    process.env.SYNC_INTERVAL_MINUTES = '10';
    authentikSync.startPeriodicSync();

    // Skip past the initial 5s delayed call first.
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();
    mockLoggerInstance.error.mockClear();
    syncSpy.mockClear();

    // Advance to the first recurring interval firing.
    jest.advanceTimersByTime(10 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Periodic Authentik sync failed')
    );

    syncSpy.mockRestore();
  });
});

describe('AuthentikSyncService.startPeriodicSync interval configuration', () => {
  const originalEnv = process.env.SYNC_INTERVAL_MINUTES;

  beforeEach(() => {
    jest.clearAllMocks();
    authentikSync.isRunning = false;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SYNC_INTERVAL_MINUTES;
    } else {
      process.env.SYNC_INTERVAL_MINUTES = originalEnv;
    }
  });

  // Asserts the CLAMPED delay startPeriodicSync() actually hands to
  // `setInterval`, by spying on the global rather than driving fake timers
  // across repeated calls on the shared singleton (which has no
  // stop()/clearInterval counterpart, so leftover intervals from an earlier
  // case would otherwise keep firing into a later one).
  //
  // `0` is deliberately included as its own case, not folded into the
  // "clamped up" case above: `parseInt('0', 10) || DEFAULT_INTERVAL_MINUTES`
  // reads `0` as falsy in JS, so it takes the OR's right-hand default before
  // the clamp ever runs -- landing on the 10-minute default, not the
  // 1-minute floor. A negative value is not falsy, so it DOES reach the
  // clamp and IS raised to the floor. Both outcomes are correct; asserting
  // them separately is what would catch a change that broke either path.
  it.each([
    ['unset, defaults to 10 minutes', undefined, 10],
    ['5 minutes, above the floor, respected as configured', '5', 5],
    ['0, falsy to parseInt(...) ||, falls back to the 10-minute default', '0', 10],
    ['a negative value, clamped up to the 1-minute floor', '-5', 1],
    ['non-numeric, falls back to the 10-minute default', 'often', 10]
  ])('%s', (_label, configuredValue, expectedMinutes) => {
    if (configuredValue === undefined) {
      delete process.env.SYNC_INTERVAL_MINUTES;
    } else {
      process.env.SYNC_INTERVAL_MINUTES = configuredValue;
    }

    // Neither mock invokes its callback or schedules a real timer -- this
    // test only inspects the arguments startPeriodicSync() passed.
    const intervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);

    authentikSync.startPeriodicSync();

    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), expectedMinutes * 60 * 1000);

    intervalSpy.mockRestore();
    timeoutSpy.mockRestore();
  });
});

describe('AuthentikSyncService.syncSingleUser email normalisation (normalise-once, bind-twice) (takserver-enrollment Requirements 5.2, 5.5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
  });

  it('binds null to BOTH the users upsert and the user_cache upsert for an empty-string Authentik email', async () => {
    const user = {
      pk: 'user-empty-email',
      username: 'empty-email-user',
      email: '',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [{ id: 1, is_team_device: false }] });

    await authentikSync.processBatch([user], {});

    const [, usersParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    const [, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));

    // The email parameter sits at index 2 in both upserts' parameter lists.
    expect(usersParams[2]).toBeNull();
    expect(cacheParams[2]).toBeNull();
  });

  it('binds the same trimmed value to both upserts for a real Authentik email', async () => {
    const user = {
      pk: 'user-real-email',
      username: 'real-email-user',
      email: '  real@example.com  ',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [{ id: 2, is_team_device: false }] });

    await authentikSync.processBatch([user], {});

    const [, usersParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    const [, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));

    expect(usersParams[2]).toBe('real@example.com');
    expect(cacheParams[2]).toBe('real@example.com');
  });

  it('binds null to both upserts for a whitespace-only Authentik email', async () => {
    const user = {
      pk: 'user-whitespace-email',
      username: 'whitespace-email-user',
      email: '   \t\n  ',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [{ id: 3, is_team_device: false }] });

    await authentikSync.processBatch([user], {});

    const [, usersParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    const [, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));

    expect(usersParams[2]).toBeNull();
    expect(cacheParams[2]).toBeNull();
  });
});

describe('AuthentikSyncService.syncSingleUser the users_email_required_unless_device CHECK-constraint catch is exact (takserver-enrollment Requirement 5.6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
  });

  it('logs its OWN warn naming the Authentik user id and skips BOTH writes when the users upsert violates users_email_required_unless_device exactly', async () => {
    const user = {
      pk: 'user-check-violation',
      username: 'no-email-no-device',
      email: '',
      groups: [],
      is_active: true,
      attributes: {}
    };
    const checkError = new Error('violates check constraint "users_email_required_unless_device"');
    checkError.code = '23514';
    checkError.constraint = 'users_email_required_unless_device';

    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.reject(checkError);
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([user], {});

    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ authentikUserId: user.pk }),
      expect.any(String)
    );

    const userCacheWrites = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO user_cache')
    );
    expect(userCacheWrites).toHaveLength(0);

    // This condition is normal by design and must not share the blanket
    // catch's generic 'Failed to sync user' log line.
    expect(mockLoggerInstance.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'Failed to sync user'
    );
  });

  it('propagates a plain network/other error into the outer per-user catch instead of the narrow warn path', async () => {
    const user = {
      pk: 'user-network-error',
      username: 'network-error-user',
      email: 'x@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    const networkError = new Error('ECONNRESET');

    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.reject(networkError);
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([user], {});

    expect(mockLoggerInstance.warn).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: networkError, username: user.username }),
      'Failed to sync user'
    );
  });

  it('propagates a 23514 rejection on a DIFFERENT constraint into the outer per-user catch instead of the narrow warn path', async () => {
    const user = {
      pk: 'user-different-constraint',
      username: 'different-constraint-user',
      email: 'y@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    const differentCheckError = new Error('violates check constraint "user_cache_email_required_unless_device"');
    differentCheckError.code = '23514';
    differentCheckError.constraint = 'user_cache_email_required_unless_device';

    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.reject(differentCheckError);
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([user], {});

    expect(mockLoggerInstance.warn).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: differentCheckError, username: user.username }),
      'Failed to sync user'
    );
  });

  it('propagates a 23505 unique-violation into the outer per-user catch instead of the narrow warn path', async () => {
    const user = {
      pk: 'user-unique-violation',
      username: 'unique-violation-user',
      email: 'z@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    const uniqueError = new Error('duplicate key value violates unique constraint "users_username_key"');
    uniqueError.code = '23505';
    uniqueError.constraint = 'users_username_key';

    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.reject(uniqueError);
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([user], {});

    expect(mockLoggerInstance.warn).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: uniqueError, username: user.username }),
      'Failed to sync user'
    );
  });
});

describe('AuthentikSyncService.syncSingleUser AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES skip (bugfix: authentik-sync-ignored-prefixes)', () => {
  const originalEnv = process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;

  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    } else {
      process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = originalEnv;
    }
  });

  it('skips a matching-prefix account before attempting the users upsert at all, logging at debug rather than warn', async () => {
    process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'etl-';

    const user = {
      pk: 16,
      username: 'etl-adsbx',
      email: '',
      groups: [],
      is_active: true,
      attributes: {}
    };

    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([user], {});

    // No INSERT INTO users was ever attempted for this account -- the
    // check-constraint violation this feature exists to avoid never has a
    // chance to occur.
    const usersUpsertCalls = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(usersUpsertCalls).toHaveLength(0);

    const userCacheWrites = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO user_cache')
    );
    expect(userCacheWrites).toHaveLength(0);

    expect(mockLoggerInstance.debug).toHaveBeenCalledWith(
      expect.objectContaining({ authentikUserId: user.pk, username: user.username }),
      expect.any(String)
    );
    expect(mockLoggerInstance.warn).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).not.toHaveBeenCalled();
  });

  it('does not skip a non-matching-prefix account, even with the variable configured', async () => {
    process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'etl-';

    const user = {
      pk: 'user-not-ignored',
      username: 'ada.lovelace',
      email: 'ada@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };

    db.query.mockResolvedValue({ rows: [{ id: 1, is_team_device: false }] });

    await authentikSync.processBatch([user], {});

    const usersUpsertCalls = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(usersUpsertCalls).toHaveLength(1);
  });

  it('does not skip any account when the variable is unset (preserves existing behavior)', async () => {
    delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;

    const user = {
      pk: 'user-unset-var',
      username: 'etl-adsbx',
      email: 'x@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };

    db.query.mockResolvedValue({ rows: [{ id: 1, is_team_device: false }] });

    await authentikSync.processBatch([user], {});

    const usersUpsertCalls = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(usersUpsertCalls).toHaveLength(1);
  });
});

describe('AuthentikSyncService.syncSingleUser push-to-Authentik guard is keyed on localUserId, not email (takserver-enrollment Requirement 5.6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
  });

  it('reaches the push-to-Authentik comparison for a device user with no email but a resolved localUserId', async () => {
    const deviceUser = {
      pk: 'device-1',
      username: 'AUK-D7K3QMX',
      email: '',
      groups: [],
      is_active: true,
      attributes: {}
    };

    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 99, is_team_device: true }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active, account_status FROM users')) {
        return Promise.resolve({ rows: [{ first_name: 'Device', last_name: '', tak_role: 'Team Member', is_active: true, account_status: 'active' }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT tak_callsign, tak_color FROM user_cache')) {
        return Promise.resolve({ rows: [{ tak_callsign: '', tak_color: '' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([deviceUser], {});

    const localSelect = db.query.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active, account_status FROM users')
    );
    const cacheSelect = db.query.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT tak_callsign, tak_color FROM user_cache')
    );

    expect(localSelect).toBeDefined();
    expect(cacheSelect).toBeDefined();
  });

  it('does NOT reach the push-to-Authentik comparison when the users upsert RETURNING resolved no row (no localUserId)', async () => {
    const user = {
      pk: 'user-no-local-row',
      username: 'no-local-row-user',
      email: '',
      groups: [],
      is_active: true,
      attributes: {}
    };

    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([user], {});

    const localSelect = db.query.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active, account_status FROM users')
    );
    const cacheSelect = db.query.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT tak_callsign, tak_color FROM user_cache')
    );

    expect(localSelect).toBeUndefined();
    expect(cacheSelect).toBeUndefined();
  });

  // Bugfix regression test (mass false-positive account deactivation via a
  // false orphaning, confirmed live during the 2026-09-05 FENZ bulk-import
  // incident): before this fix, the diff-and-PATCH block ran unconditionally
  // for any row with a resolved `localUserId`, including an `'orphaned'`
  // one. An orphaned row's `is_active` is a SIDE EFFECT of
  // `reconcileOrphanedAccounts`'s belief that the Authentik identity is
  // gone -- when that belief is wrong (as in the live incident: a
  // pagination race falsely orphaned ~180 real, still-existing accounts),
  // the very next sync saw Authentik's real `is_active: true` disagree with
  // the falsely-orphaned local row's `is_active: false`, and PATCHed
  // Authentik's `is_active` to `false` -- turning a false LOCAL belief into
  // a REAL deactivation of a live account. This test's `localRow` is
  // deliberately constructed so that, absent the `account_status ===
  // 'orphaned'` guard, `isActiveChanged` would be true (local false vs.
  // Authentik true) and a PATCH would fire -- proving the guard is what
  // prevents it, not an incidental absence of any other diff.
  it('never PATCHes Authentik for an orphaned row, even when local is_active disagrees with Authentik (bugfix: false-orphan deactivation)', async () => {
    const user = {
      pk: 'user-orphaned-is-active-mismatch',
      username: 'nora',
      email: 'nora@example.com',
      name: 'Nora Local',
      groups: [],
      is_active: true, // Authentik: the account is genuinely still active
      attributes: { first_name: 'Nora', last_name: 'Local', takCallsign: '', takColor: '', takRole: 'Team Member' }
    };

    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 77, is_team_device: false }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active, account_status FROM users')) {
        // Local: falsely orphaned, is_active=false -- disagrees with
        // Authentik's is_active: true above.
        return Promise.resolve({ rows: [{ first_name: 'Nora', last_name: 'Local', tak_role: 'Team Member', is_active: false, account_status: 'orphaned' }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT tak_callsign, tak_color FROM user_cache')) {
        return Promise.resolve({ rows: [{ tak_callsign: '', tak_color: '' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([user], {});

    expect(axios.patch).not.toHaveBeenCalled();
  });
});

describe('AuthentikSyncService.syncSingleUser is_team_device threading into user_cache (takserver-enrollment Requirement 5.6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
  });

  it('includes is_team_device=true, sourced from the users upsert RETURNING, in the user_cache INSERT for a device row', async () => {
    const deviceUser = {
      pk: 'device-2',
      username: 'AUK-D9Z2XQP',
      email: '',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [{ id: 5, is_team_device: true }] });

    await authentikSync.processBatch([deviceUser], {});

    const [cacheSql, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    // is_team_device is the 12th positional parameter (index 11).
    expect(cacheParams[11]).toBe(true);
    const updateSetClause = cacheSql.slice(cacheSql.indexOf('DO UPDATE SET'));
    expect(updateSetClause).not.toContain('is_team_device');
  });

  it('includes is_team_device=false, sourced from the users upsert RETURNING, in the user_cache INSERT for a human row', async () => {
    const humanUser = {
      pk: 'human-1',
      username: 'human-user',
      email: 'human@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [{ id: 6, is_team_device: false }] });

    await authentikSync.processBatch([humanUser], {});

    const [cacheSql, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    expect(cacheParams[11]).toBe(false);
    const updateSetClause = cacheSql.slice(cacheSql.indexOf('DO UPDATE SET'));
    expect(updateSetClause).not.toContain('is_team_device');
  });

  it('lists is_team_device in the user_cache INSERT column list but NEVER in its ON CONFLICT DO UPDATE SET column list', async () => {
    const user = {
      pk: 'human-2',
      username: 'human-user-2',
      email: 'human2@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockResolvedValue({ rows: [{ id: 7, is_team_device: false }] });

    await authentikSync.processBatch([user], {});

    const [cacheSql] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    const conflictIndex = cacheSql.indexOf('DO UPDATE SET');
    const insertColumnList = cacheSql.slice(cacheSql.indexOf('INSERT INTO user_cache'), cacheSql.indexOf('VALUES'));
    const updateSetClause = cacheSql.slice(conflictIndex);

    expect(insertColumnList).toContain('is_team_device');
    expect(updateSetClause).not.toContain('is_team_device');
  });
});

/**
 * Bugfix (External_Lock Detection): a manual Authentik-side lock
 * (`is_active: false` set directly in Authentik, bypassing
 * `AccountLifecycleService.suspendAccount` entirely) was previously
 * invisible to this sync and, worse, ACTIVELY UNDONE on the very next
 * run -- local `users.is_active` (unaware of the change, still `true`)
 * is authoritative and gets pushed onto Authentik, silently re-enabling
 * an account someone just tried to lock. `syncSingleUser` now detects
 * `user.is_active === false` for a locally `'active'` row, reflects it
 * as `account_status = 'suspended'`/`is_active = false` locally,
 * enqueues a `revoke_tak_certificates` Sync_Operation, and writes a
 * `user.suspended_externally` audit row attributed to a NULL user_id
 * (system-attributed, not a real admin) -- mirroring
 * `AccountLifecycleService.suspendAccount`'s own shape for an
 * admin-initiated suspend.
 */
describe('AuthentikSyncService.syncSingleUser External_Lock Detection (bugfix)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
    EventPublisher.publishOperation.mockResolvedValue(1);
  });

  function mockLockDetectionQueries({ localRow, cacheRow = { tak_callsign: '', tak_color: '' }, isTeamDevice = false }) {
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 42, is_team_device: isTeamDevice }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active, account_status FROM users')) {
        return Promise.resolve({ rows: [localRow] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT tak_callsign, tak_color FROM user_cache')) {
        return Promise.resolve({ rows: [cacheRow] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('reflects a manual Authentik lock (is_active: false) for a locally-active human account: suspends locally, enqueues a Revoke_Operation, and audit-logs as system-detected', async () => {
    const user = {
      pk: 'user-locked-1',
      username: 'alice',
      email: 'alice@example.com',
      groups: [],
      is_active: false, // manually disabled directly in Authentik
      attributes: {}
    };
    mockLockDetectionQueries({
      localRow: { first_name: 'Alice', last_name: 'Local', tak_role: 'Team Member', is_active: true, account_status: 'active' }
    });

    await authentikSync.processBatch([user], {});

    expect(db.query).toHaveBeenCalledWith(
      `UPDATE users SET account_status = 'suspended', is_active = false WHERE id = $1`,
      [42]
    );
    expect(db.query).toHaveBeenCalledWith(
      'UPDATE user_cache SET is_active = false WHERE authentik_id = $1',
      ['user-locked-1']
    );
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { tak_usernames: ['alice'] },
      null
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      [null, 'user.suspended_externally', 'user', 42, JSON.stringify({ reason: 'authentik_is_active_false' })]
    );
  });

  it('uses the client_uid revoke payload shape for a Team_Owned_Device row, not tak_usernames', async () => {
    const deviceUser = {
      pk: 'device-locked-1',
      username: 'AUK-D7K3QMX',
      email: '',
      groups: [],
      is_active: false,
      attributes: {}
    };
    mockLockDetectionQueries({
      localRow: { first_name: 'Device', last_name: '', tak_role: 'Team Member', is_active: true, account_status: 'active' },
      isTeamDevice: true
    });

    await authentikSync.processBatch([deviceUser], {});

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { client_uid: 'AUK-D7K3QMX' },
      null
    );
  });

  it('does NOT re-push is_active: true to Authentik in the same run after detecting and reflecting the lock', async () => {
    // name/attributes deliberately match the local row exactly so the
    // ONLY thing that could still trigger a PATCH is a stale is_active
    // comparison -- isolating this assertion to the lock-detection fix
    // itself, not any of this function's other, unrelated push
    // conditions (name/attrs mismatches, which are pre-existing and out
    // of scope here).
    const user = {
      pk: 'user-locked-2',
      username: 'bob',
      email: 'bob@example.com',
      name: 'Bob',
      groups: [],
      is_active: false,
      attributes: { first_name: 'Bob', last_name: '', takCallsign: '', takColor: '', takRole: 'Team Member' }
    };
    mockLockDetectionQueries({
      localRow: { first_name: 'Bob', last_name: '', tak_role: 'Team Member', is_active: true, account_status: 'active' }
    });

    await authentikSync.processBatch([user], {});

    // The push-to-Authentik PATCH must never fire in this run: the
    // detection branch updates the in-memory `local` snapshot to match
    // what Authentik already reports, so isActiveChanged/nameChanged/
    // attrsChanged are all false and no axios.patch is issued.
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('does nothing when Authentik reports is_active: false for an account ALREADY locally suspended (no duplicate revoke/audit row)', async () => {
    const user = {
      pk: 'user-already-suspended',
      username: 'carol',
      email: 'carol@example.com',
      groups: [],
      is_active: false,
      attributes: {}
    };
    mockLockDetectionQueries({
      localRow: { first_name: 'Carol', last_name: '', tak_role: 'Team Member', is_active: false, account_status: 'suspended' }
    });

    await authentikSync.processBatch([user], {});

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['user.suspended_externally'])
    );
  });

  it('does nothing when Authentik reports is_active: true for a locally-active account (the ordinary, unlocked case)', async () => {
    const user = {
      pk: 'user-normal',
      username: 'dave',
      email: 'dave@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    mockLockDetectionQueries({
      localRow: { first_name: 'Dave', last_name: '', tak_role: 'Team Member', is_active: true, account_status: 'active' }
    });

    await authentikSync.processBatch([user], {});

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  // Bugfix: this used to assert the OPPOSITE -- that an Authentik-side
  // re-enable of a locally-suspended account was deliberately ignored.
  // That asymmetry has been reverted: TAK Team Manager should reflect a
  // real Authentik-side change rather than fight or ignore it. See the
  // dedicated `External_Unlock Detection` describe block below for the
  // full behaviour this case now exercises (it belongs there, not here,
  // since External_Lock Detection's own `if` condition is simply not
  // met when `local.account_status` is already `'suspended'` -- the two
  // detections are independent branches, each with its own tests).
  it('leaves External_Lock Detection\'s own branch a no-op for an already-suspended row reported active by Authentik (handled by External_Unlock Detection instead)', async () => {
    const user = {
      pk: 'user-reenabled-in-authentik',
      username: 'erin',
      email: 'erin@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    mockLockDetectionQueries({
      localRow: { first_name: 'Erin', last_name: '', tak_role: 'Team Member', is_active: false, account_status: 'suspended' }
    });

    await authentikSync.processBatch([user], {});

    // External_Lock Detection's own audit action never fires for this
    // row -- account_status was already 'suspended', not 'active', so
    // its `if` condition is false. (External_Unlock Detection's OWN
    // 'active' write for this exact scenario is asserted in that
    // describe block below.)
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['user.suspended_externally'])
    );
  });

  it('does not throw and continues the batch when the lock-detection write fails (non-fatal, logged)', async () => {
    const user = {
      pk: 'user-lock-detection-failure',
      username: 'frank',
      email: 'frank@example.com',
      groups: [],
      is_active: false,
      attributes: {}
    };
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 43, is_team_device: false }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active, account_status FROM users')) {
        return Promise.resolve({ rows: [{ first_name: 'Frank', last_name: '', tak_role: 'Team Member', is_active: true, account_status: 'active' }] });
      }
      if (typeof sql === 'string' && sql.startsWith("UPDATE users SET account_status = 'suspended'")) {
        return Promise.reject(new Error('DB unavailable'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(authentikSync.processBatch([user], {})).resolves.toBeUndefined();

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('External_Lock Detection')
    );
  });

  it('never orphans the account -- External_Lock Detection sets account_status to suspended, never orphaned', async () => {
    const user = {
      pk: 'user-locked-3',
      username: 'grace',
      email: 'grace@example.com',
      groups: [],
      is_active: false,
      attributes: {}
    };
    mockLockDetectionQueries({
      localRow: { first_name: 'Grace', last_name: '', tak_role: 'Team Member', is_active: true, account_status: 'active' }
    });

    await authentikSync.processBatch([user], {});

    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("account_status = 'orphaned'"),
      expect.anything()
    );
  });
});

/**
 * Bugfix (External_Unlock Detection): the mirror-image direction of
 * External_Lock Detection above. An admin unlocking an account directly
 * in Authentik (`is_active: true`, bypassing
 * `AccountLifecycleService.unsuspendAccount` entirely) is now recognised
 * and reflected -- `account_status` flips back to `'active'` locally, an
 * audit row (`user.unsuspended_externally`, attributed to a NULL
 * user_id) is written, and NO certificate action is taken (mirroring
 * `unsuspendAccount`'s own behaviour: unsuspending never restores a
 * revoked certificate).
 */
describe('AuthentikSyncService.syncSingleUser External_Unlock Detection (bugfix)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
    EventPublisher.publishOperation.mockResolvedValue(1);
  });

  function mockUnlockDetectionQueries({ localRow, cacheRow = { tak_callsign: '', tak_color: '' }, isTeamDevice = false }) {
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 42, is_team_device: isTeamDevice }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active, account_status FROM users')) {
        return Promise.resolve({ rows: [localRow] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT tak_callsign, tak_color FROM user_cache')) {
        return Promise.resolve({ rows: [cacheRow] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('reflects a manual Authentik unlock (is_active: true) for a locally-suspended human account: reactivates locally and audit-logs as system-detected, with NO certificate action', async () => {
    const user = {
      pk: 'user-unlocked-1',
      username: 'heidi',
      email: 'heidi@example.com',
      groups: [],
      is_active: true, // manually re-enabled directly in Authentik
      attributes: {}
    };
    mockUnlockDetectionQueries({
      localRow: { first_name: 'Heidi', last_name: 'Local', tak_role: 'Team Member', is_active: false, account_status: 'suspended' }
    });

    await authentikSync.processBatch([user], {});

    expect(db.query).toHaveBeenCalledWith(
      `UPDATE users SET account_status = 'active', is_active = true WHERE id = $1`,
      [42]
    );
    expect(db.query).toHaveBeenCalledWith(
      'UPDATE user_cache SET is_active = true WHERE authentik_id = $1',
      ['user-unlocked-1']
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      [null, 'user.unsuspended_externally', 'user', 42, JSON.stringify({ reason: 'authentik_is_active_true' })]
    );
    // Unsuspending never restores a certificate -- no Revoke_Operation,
    // and no other Sync_Operation of any kind, is enqueued here.
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('applies identically to a Team_Owned_Device row (no is_team_device branch in the detection itself)', async () => {
    const deviceUser = {
      pk: 'device-unlocked-1',
      username: 'AUK-D7K3QMX',
      email: '',
      groups: [],
      is_active: true,
      attributes: {}
    };
    mockUnlockDetectionQueries({
      localRow: { first_name: 'Device', last_name: '', tak_role: 'Team Member', is_active: false, account_status: 'suspended' },
      isTeamDevice: true
    });

    await authentikSync.processBatch([deviceUser], {});

    expect(db.query).toHaveBeenCalledWith(
      `UPDATE users SET account_status = 'active', is_active = true WHERE id = $1`,
      [42]
    );
  });

  it('does NOT re-push is_active: false to Authentik in the same run after detecting and reflecting the unlock', async () => {
    // name/attributes deliberately match the local row exactly, isolating
    // this assertion to the unlock-detection fix itself (see the
    // equivalent External_Lock Detection test's identical reasoning).
    const user = {
      pk: 'user-unlocked-2',
      username: 'ivan',
      email: 'ivan@example.com',
      name: 'Ivan',
      groups: [],
      is_active: true,
      attributes: { first_name: 'Ivan', last_name: '', takCallsign: '', takColor: '', takRole: 'Team Member' }
    };
    mockUnlockDetectionQueries({
      localRow: { first_name: 'Ivan', last_name: '', tak_role: 'Team Member', is_active: false, account_status: 'suspended' }
    });

    await authentikSync.processBatch([user], {});

    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('does nothing when Authentik reports is_active: true for an account ALREADY locally active (no duplicate audit row)', async () => {
    const user = {
      pk: 'user-already-active',
      username: 'judy',
      email: 'judy@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    mockUnlockDetectionQueries({
      localRow: { first_name: 'Judy', last_name: '', tak_role: 'Team Member', is_active: true, account_status: 'active' }
    });

    await authentikSync.processBatch([user], {});

    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.arrayContaining(['user.unsuspended_externally'])
    );
  });

  it('does NOT reactivate an orphaned account even if Authentik reports is_active: true (orphan reclaim is a separate flow)', async () => {
    const user = {
      pk: 'user-orphaned-but-present',
      username: 'karl',
      email: 'karl@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    mockUnlockDetectionQueries({
      localRow: { first_name: 'Karl', last_name: '', tak_role: 'Team Member', is_active: false, account_status: 'orphaned' }
    });

    await authentikSync.processBatch([user], {});

    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET account_status = 'active'"),
      expect.anything()
    );
  });

  it('does not throw and continues the batch when the unlock-detection write fails (non-fatal, logged)', async () => {
    const user = {
      pk: 'user-unlock-detection-failure',
      username: 'liam',
      email: 'liam@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [{ id: 44, is_team_device: false }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active, account_status FROM users')) {
        return Promise.resolve({ rows: [{ first_name: 'Liam', last_name: '', tak_role: 'Team Member', is_active: false, account_status: 'suspended' }] });
      }
      if (typeof sql === 'string' && sql.startsWith("UPDATE users SET account_status = 'active'")) {
        return Promise.reject(new Error('DB unavailable'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(authentikSync.processBatch([user], {})).resolves.toBeUndefined();

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('External_Unlock Detection')
    );
  });
});

describe('AuthentikSyncService.syncSingleUser reconciles an EXISTING Team_Owned_Device on every sync (bugfix found in takserver-enrollment task 12.2 live verification)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    console.error = jest.fn();
    console.log = jest.fn();
  });

  // Regression test. Against the unfixed code, the `users` upsert statement
  // omitted `is_team_device` from its INSERT column list, so Postgres
  // checked the tentative INSERT tuple -- which carries `is_team_device` at
  // its column DEFAULT (false), since the column was never mentioned --
  // against the `users_email_required_unless_device` CHECK constraint
  // BEFORE `ON CONFLICT ... DO UPDATE` ever ran (Postgres evaluates
  // constraints against the proposed row prior to conflict resolution).
  // For an EXISTING Team_Owned_Device row (email NULL, is_team_device
  // already true in the ACTUAL stored row), that made the tentative tuple
  // (email=NULL, is_team_device=false) violate the CHECK constraint on
  // every single sync run, even though the real stored row already
  // satisfied it. The narrow 23514 catch then misclassified this as
  // "genuinely emailless principal with no local row" and silently skipped
  // both the `users` and `user_cache` writes -- the device kept working
  // (nothing revoked its certificate) but was never reconciled by sync
  // again, and the skip was indistinguishable in the logs from the
  // legitimate emailless-service-account case.
  it('does NOT violate users_email_required_unless_device for an existing Team_Owned_Device with email=NULL, and reconciles user_cache with is_team_device=true/email=NULL', async () => {
    const deviceUser = {
      pk: 'device-existing-1',
      username: 'AUK-D7K3QMX',
      email: '', // Authentik's Empty_String_Email for a device account
      groups: [],
      is_active: true,
      attributes: {}
    };

    // Simulate Postgres's real behaviour for the FIXED statement: the
    // subquery reads the existing stored is_team_device (true) and the
    // CHECK constraint is satisfied because is_team_device evaluates to
    // true in the tentative tuple, so the INSERT ... ON CONFLICT succeeds
    // and returns the existing row's id and is_team_device.
    db.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        // A correct implementation must read the EXISTING is_team_device
        // value (true) rather than defaulting to false -- assert the SQL
        // text actually performs that read, so a fix that instead widens
        // the CHECK constraint or otherwise sidesteps the read would fail
        // this test rather than passing it by coincidence.
        expect(sql).toMatch(/is_team_device/);
        return Promise.resolve({ rows: [{ id: 501, is_team_device: true }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active, account_status FROM users')) {
        return Promise.resolve({ rows: [{ first_name: 'Device', last_name: '', tak_role: 'Team Member', is_active: true, account_status: 'active' }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT tak_callsign, tak_color FROM user_cache')) {
        return Promise.resolve({ rows: [{ tak_callsign: '', tak_color: '' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([deviceUser], {});

    // The narrow 23514 skip path must NOT have fired: no warn was logged,
    // and no error was logged either. This is the "no thrown 23514" half
    // of the criterion.
    expect(mockLoggerInstance.warn).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'Failed to sync user'
    );

    // The users upsert was actually attempted with email=NULL (index 2).
    const usersCall = db.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users'));
    expect(usersCall).toBeDefined();
    expect(usersCall[1][2]).toBeNull();

    // user_cache ends up with is_team_device = true and email = NULL.
    const cacheCall = db.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO user_cache'));
    expect(cacheCall).toBeDefined();
    const [, cacheParams] = cacheCall;
    expect(cacheParams[2]).toBeNull(); // email
    expect(cacheParams[11]).toBe(true); // is_team_device
  });

  // The companion case: a genuinely NEW principal (no existing users row)
  // still defaults to is_team_device = false, so a first-time human sync is
  // unaffected by the fix.
  it('still defaults is_team_device to false for a genuinely NEW principal with no existing users row', async () => {
    const newHumanUser = {
      pk: 'brand-new-user',
      username: 'brand-new-user',
      email: 'brand-new@example.com',
      groups: [],
      is_active: true,
      attributes: {}
    };

    db.query.mockResolvedValue({ rows: [{ id: 900, is_team_device: false }] });

    await authentikSync.processBatch([newHumanUser], {});

    const [cacheSql, cacheParams] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO user_cache'));
    expect(cacheParams[11]).toBe(false);
    void cacheSql;
  });
});
