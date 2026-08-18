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
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch(users, {});

    // Each user now results in one INSERT INTO users and one
    // INSERT INTO user_cache call.
    expect(db.query).toHaveBeenCalledTimes(24);
    users.forEach(user => {
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_cache'),
        expect.arrayContaining([user.pk, user.username])
      );
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        [user.pk, user.username, user.email, user.username, '', user.is_active, null]
      );
    });
  });

  it('skips the INSERT INTO users call (but still writes user_cache) for a user with no email', async () => {
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

    // Only the user_cache upsert should run; the users upsert is skipped
    // because there's no email to satisfy the UNIQUE NOT NULL constraint.
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_cache'),
      expect.arrayContaining([serviceAccountUser.pk, serviceAccountUser.username])
    );

    const usersInsertCalls = db.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(usersInsertCalls).toHaveLength(0);
  });

  it('skips the INSERT INTO users call for a user with an undefined email', async () => {
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

    expect(db.query).toHaveBeenCalledTimes(1);
    const usersInsertCalls = db.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(usersInsertCalls).toHaveLength(0);
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
    db.query.mockResolvedValue({ rows: [] });

    await authentikSync.processBatch([humanUser], {});

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      [humanUser.pk, humanUser.username, humanUser.email, humanUser.username, '', humanUser.is_active, null]
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
      return Promise.resolve({ rows: [] });
    });

    await authentikSync.processBatch(users, {});

    // Every user, including the failing one, still got an INSERT attempt.
    // The 4 succeeding users each make 2 calls (users + user_cache); the
    // failing user's first call (INSERT INTO users, which also keys off
    // user.pk as params[0]) rejects, so its second call (user_cache) never
    // runs -- the existing per-user try/catch stops after the first thrown
    // error.
    expect(db.query).toHaveBeenCalledTimes(9);

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
    // Authentik is authoritative: ON CONFLICT DO UPDATE unconditionally
    // overwrites to COALESCE($7, tak_role), so a present Authentik value
    // always wins over whatever is currently stored locally.
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
      [user.pk, user.username, user.email, user.username, '', user.is_active, 'Team Lead']
    );
    const [usersSql] = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'));
    expect(usersSql).toContain('COALESCE($7, \'Team Member\')');
    expect(usersSql).toContain('tak_role = COALESCE($7, tak_role)');
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
      [user.pk, user.username, user.email, user.username, '', user.is_active, 'Medic']
    );
  });

  it('does not clobber an established local users.tak_role when Authentik has no takRole attribute set (sparse attribute)', async () => {
    // Authentik's takRole attribute is sparse -- some users have no
    // attribute set at all. An unconditional overwrite here would clobber
    // a real Team_Admin/Global_Manager edit (task 28.1) with null,
    // violating Requirement 13.8. The COALESCE($7, tak_role) fallback
    // means the query param passed is `null`, and Postgres's COALESCE at
    // query time (not application code) falls back to the existing
    // stored value on conflict, or 'Team Member' on initial insert.
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
    // The tak_role param passed is null (Authentik has no value), relying
    // on the query's COALESCE to preserve the existing/default value
    // rather than overwriting with null in application code.
    expect(usersParams).toEqual([user.pk, user.username, user.email, user.username, '', user.is_active, null]);
    expect(usersSql).toContain('COALESCE($7, \'Team Member\')');
    expect(usersSql).toContain('tak_role = COALESCE($7, tak_role)');
  });

  it('leaves the user_cache.tak_role upsert unconditional (unchanged), still overwriting from EXCLUDED even when Authentik\'s takRole is absent', async () => {
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
    expect(cacheSql).toContain('tak_role = EXCLUDED.tak_role');
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
    expect(usersParams).toEqual([user.pk, user.username, user.email, 'New Person', '', user.is_active, null]);
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
    expect(usersSql).toContain('ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3, is_active = $6, tak_role = COALESCE($7, tak_role)');
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
