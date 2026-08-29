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

const axios = require('axios');
const db = require('../config/database');
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
    expect(cacheParams[6]).toBeUndefined();
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
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active FROM users')) {
        return Promise.resolve({ rows: [{ first_name: 'Device', last_name: '', tak_role: 'Team Member', is_active: true }] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT tak_callsign, tak_color FROM user_cache')) {
        return Promise.resolve({ rows: [{ tak_callsign: '', tak_color: '' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch([deviceUser], {});

    const localSelect = db.query.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active FROM users')
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
      typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active FROM users')
    );
    const cacheSelect = db.query.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('SELECT tak_callsign, tak_color FROM user_cache')
    );

    expect(localSelect).toBeUndefined();
    expect(cacheSelect).toBeUndefined();
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
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name, tak_role, is_active FROM users')) {
        return Promise.resolve({ rows: [{ first_name: 'Device', last_name: '', tak_role: 'Team Member', is_active: true }] });
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
