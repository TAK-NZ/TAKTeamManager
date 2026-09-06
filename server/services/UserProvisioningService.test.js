/**
 * Unit tests for `UserProvisioningService.createAndAddUser` (Requirement
 * 17.1: `POST /api/users/create-and-add` refactor).
 *
 * These exercise the service function directly against a mocked
 * transactional `client` (the same shape `pool.connect()` would return),
 * verifying:
 *  - the local `users` upsert, `team_memberships` inserts (including
 *    parent-team inheritance), and `channel_memberships` inserts all run
 *    against the SAME passed-in client (never `pool.query` directly);
 *  - the parent-team inheritance/channel-assignment logic is preserved
 *    exactly (matching the pre-refactor route handler's behavior);
 *  - `add_user_to_group` Sync_Operations are queued (via EventPublisher)
 *    for both the target team's primary channel and every parent team's
 *    primary channel that has an Authentik group.
 */

jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));

jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
  getFullMemberList: jest.fn(),
  findById: jest.fn()
}));

jest.mock('./CallsignService', () => ({
  computeDefaultCallsignSuffix: jest.fn()
}));

// `resolveNewUserIdentity`'s pseudonymous branch calls
// `ManagedIdentifierService.mintUniqueIdentifier`, which is NOT mocked here
// (see the `resolveNewUserIdentity` describe block below): its own
// `generateManagedIdentifier` call is real, so the minted username is a
// genuine Managed_Identifier rather than a value this test file invented,
// and its `claim(candidate)` callback runs the real `pool.query` call
// `UserProvisioningService` wires up -- so only the underlying `pool` needs
// mocking, matching the `jest.mock('../config/database', ...)` idiom every
// other server service unit test in this file's sibling tests uses.
jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const EventPublisher = require('./EventPublisher');
const Team = require('../models/Team');
const CallsignService = require('./CallsignService');
const { CallsignSuffixConflictError } = require('./CallsignSuffixUniquenessService');
const { hierarchyArb } = require('./__fixtures__/transferArbitraries');
const UserProvisioningService = require('./UserProvisioningService');
const pool = require('../config/database');
const ManagedIdentifierService = require('./ManagedIdentifierService');
const { isManagedIdentifier } = require('../utils/managedIdentifier');

function buildMockClient(queryImpl) {
  return {
    query: jest.fn(queryImpl)
  };
}

describe('UserProvisioningService.createAndAddUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    EventPublisher.publishOperation.mockResolvedValue('op-id');
  });

  it('performs every local write against the single passed-in client (no direct pool usage)', async () => {
    const client = buildMockClient((sql) => {
      if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 101 }] });
      }
      if (sql.includes('WITH RECURSIVE parent_teams')) {
        return Promise.resolve({ rows: [] }); // no parent teams
      }
      if (sql.includes("SELECT id, authentik_group_id FROM channels")) {
        return Promise.resolve({ rows: [{ id: 5, authentik_group_id: 'grp-team' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: 999,
      username: 'alice',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
      teamId: 7,
      createdBy: 3
    });

    expect(result.localUserId).toBe(101);

    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls.some((sql) => sql.includes('INSERT INTO users'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('INSERT INTO team_memberships (team_id, user_id, role) VALUES'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('INSERT INTO channel_memberships'))).toBe(true);

    // The primary channel's Authentik group is queued as a Sync_Operation,
    // not called directly against Authentik. The already-open transactional
    // `client` is passed through (Requirement 17.5's pattern) so the
    // sync_operations INSERT commits/rolls back atomically with this
    // function's other local writes.
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 101, target_group_id: 'grp-team' },
      3,
      client
    );
  });

  it('enqueues assign_user_to_global_channels for the new user, on the same transactional client', async () => {
    // Bugfix: create-and-add and CSV-bulk-imported users (both via
    // createAndAddUser) previously got only their TEAM channels and none of
    // the global BCH/region channels, because -- unlike
    // TeamMembershipService.addUserToTeam -- this path never enqueued the
    // per-user global-channel reconcile. It must enqueue exactly one
    // `assign_user_to_global_channels` op for the created user, on the
    // caller's open `client` so it commits/rolls back atomically.
    const client = buildMockClient((sql) => {
      if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 101 }] });
      }
      if (sql.includes('WITH RECURSIVE parent_teams')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("SELECT id, authentik_group_id FROM channels")) {
        return Promise.resolve({ rows: [{ id: 5, authentik_group_id: 'grp-team' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: 999,
      username: 'alice',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
      teamId: 7,
      createdBy: 3
    });

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'assign_user_to_global_channels',
      { target_user_id: 101 },
      3,
      client
    );
  });

  it('SUPPRESSES the per-user assign_user_to_global_channels enqueue when skipGlobalChannelEnqueue is true (bulk path)', async () => {
    // At bulk scale the per-user enqueue is O(users); the bulk caller
    // (BulkImportService / the local script) instead issues ONE group-axis
    // reconcile for all global channels after the batch. So with the flag on,
    // createAndAddUser must NOT enqueue an assign_user_to_global_channels op.
    const client = buildMockClient((sql) => {
      if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 101 }] });
      }
      if (sql.includes('WITH RECURSIVE parent_teams')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id, authentik_group_id FROM channels')) {
        return Promise.resolve({ rows: [{ id: 5, authentik_group_id: 'grp-team' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: 999,
      username: 'alice',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
      teamId: 7,
      createdBy: 3,
      skipGlobalChannelEnqueue: true
    });

    const globalEnqueues = EventPublisher.publishOperation.mock.calls.filter(
      (c) => c[0] === 'assign_user_to_global_channels'
    );
    expect(globalEnqueues).toHaveLength(0);
  });

  it('creates an inherited team_membership row and queues a group operation for each parent team', async () => {
    const client = buildMockClient((sql, params) => {
      if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 202 }] });
      }
      if (sql.includes('WITH RECURSIVE parent_teams')) {
        return Promise.resolve({ rows: [{ team_id: 1 }, { team_id: 2 }] });
      }
      if (sql.includes('SELECT id, authentik_group_id FROM channels WHERE team_id = $1 AND is_primary = true')) {
        const [teamId] = params;
        if (teamId === 1) return Promise.resolve({ rows: [{ id: 11, authentik_group_id: 'grp-parent-1' }] });
        if (teamId === 2) return Promise.resolve({ rows: [{ id: 12, authentik_group_id: null }] });
        if (teamId === 9) return Promise.resolve({ rows: [{ id: 90, authentik_group_id: 'grp-target' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: 555,
      username: 'bob',
      email: 'bob@example.com',
      firstName: 'Bob',
      lastName: 'Jones',
      teamId: 9,
      createdBy: 4
    });

    const inheritedInserts = client.query.mock.calls.filter(
      ([sql]) => sql.includes('inherited_from_team_id')
    );
    // One inherited membership INSERT per parent team (2 parents).
    expect(inheritedInserts.filter(([sql]) => sql.includes('INSERT INTO team_memberships')).length).toBe(2);

    // Parent team 1 has an Authentik group -> queued; parent team 2 does not.
    // The same open transactional `client` is passed through each time.
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 202, target_group_id: 'grp-parent-1' },
      4,
      client
    );
    expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
      'add_user_to_group',
      expect.objectContaining({ target_group_id: null }),
      4,
      client
    );
    // Target team's own primary channel is also queued.
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 202, target_group_id: 'grp-target' },
      4,
      client
    );

    expect(result.queuedGroups).toBe(2); // grp-parent-1 + grp-target (grp-parent-2 null skipped)
  });

  it('removes any stale inherited membership for the target team before inserting the direct membership', async () => {
    const client = buildMockClient((sql) => {
      if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 303 }] });
      }
      if (sql.includes('WITH RECURSIVE parent_teams')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: 111,
      username: 'carol',
      email: 'carol@example.com',
      firstName: 'Carol',
      lastName: 'Lee',
      teamId: 3
    });

    const calls = client.query.mock.calls.map(([sql]) => sql);
    const deleteIndex = calls.findIndex((sql) => sql.includes('DELETE FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id = $2'));
    const insertIndex = calls.findIndex((sql) => sql.includes('INSERT INTO team_memberships (team_id, user_id, role) VALUES'));

    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(deleteIndex);
  });

  it('propagates a failure from any local write so the caller can roll back', async () => {
    const client = buildMockClient((sql) => {
      if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 404 }] });
      }
      if (sql.includes('INSERT INTO team_memberships (team_id, user_id, role) VALUES')) {
        return Promise.reject(new Error('constraint violation'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      UserProvisioningService.createAndAddUser(client, {
        authentikUserId: 777,
        username: 'dave',
        email: 'dave@example.com',
        firstName: 'Dave',
        lastName: 'King',
        teamId: 3
      })
    ).rejects.toThrow('constraint violation');
  });
});

// account-lifecycle-management Requirement 5.3, 5.4, 5.5 (task 11.2, 11.5):
// the reclaimedUserId branch of createAndAddUser -- Account_Reclaim.
describe('UserProvisioningService.createAndAddUser reclaimedUserId (account-lifecycle-management)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    EventPublisher.publishOperation.mockResolvedValue('op-id');
  });

  it('adopts the reclaimed row by id via UPDATE, setting account_status = \'active\', rather than the generic upsert', async () => {
    const client = buildMockClient((sql) => {
      if (sql.includes("UPDATE users SET authentik_user_id")) {
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      if (sql.includes('WITH RECURSIVE parent_teams')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: 9001,
      username: 'reclaimed.user',
      email: 'reclaimed@example.com',
      firstName: 'Reclaimed',
      lastName: 'Person',
      teamId: 7,
      callsign_suffix: 'ReUser',
      createdBy: 3,
      reclaimedUserId: 42
    });

    expect(result.localUserId).toBe(42);

    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    // Requirement 5.5: the row's id survives -- adopted by UPDATE ... WHERE
    // id = $reclaimedUserId, never the generic INSERT ... ON CONFLICT upsert.
    expect(sqlCalls.some((sql) => sql.includes('UPDATE users SET authentik_user_id'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('INSERT INTO users ('))).toBe(false);

    const [reclaimSql, reclaimParams] = client.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE users SET authentik_user_id')
    );
    expect(reclaimSql).toContain("account_status = 'active'");
    expect(reclaimSql).toContain('WHERE id = $7');
    expect(reclaimParams).toEqual([9001, 'reclaimed.user', 'reclaimed@example.com', 'Reclaimed', 'Person', 'ReUser', 42]);
  });

  it('throws when reclaimedUserId names no existing row', async () => {
    const client = buildMockClient((sql) => {
      if (sql.includes('UPDATE users SET authentik_user_id')) {
        return Promise.resolve({ rows: [] }); // no matching row
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      UserProvisioningService.createAndAddUser(client, {
        authentikUserId: 9002,
        username: 'ghost.user',
        email: 'ghost@example.com',
        firstName: 'Ghost',
        lastName: 'User',
        teamId: 7,
        reclaimedUserId: 999
      })
    ).rejects.toThrow('Cannot reclaim account: no users row with id 999');
  });

  it('never reads team_memberships history off the reclaimed row before assigning the fresh team (Requirement 5.4: no automatic restoration)', async () => {
    const client = buildMockClient((sql) => {
      if (sql.includes('UPDATE users SET authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      if (sql.includes('WITH RECURSIVE parent_teams')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: 9003,
      username: 'reclaimed.user2',
      email: 'reclaimed2@example.com',
      firstName: 'Reclaimed',
      lastName: 'Two',
      teamId: 7,
      reclaimedUserId: 42
    });

    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    // No SELECT of the reclaimed row's own prior team_memberships occurs --
    // only the shared DELETE-stale-inherited + fresh direct INSERT every
    // branch already performs.
    expect(sqlCalls.some((sql) => sql.startsWith('SELECT') && sql.includes('team_memberships') && sql.includes('user_id'))).toBe(false);
    expect(sqlCalls.some((sql) => sql.includes('DELETE FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id = $2'))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes('INSERT INTO team_memberships (team_id, user_id, role) VALUES'))).toBe(true);
  });

  it('does not touch origin_org_id at all for a reclaimed row (contrast with the claimId branch\'s COALESCE)', async () => {
    const client = buildMockClient((sql) => {
      if (sql.includes('UPDATE users SET authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      if (sql.includes('WITH RECURSIVE parent_teams')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: 9004,
      username: 'reclaimed.user3',
      email: 'reclaimed3@example.com',
      firstName: 'Reclaimed',
      lastName: 'Three',
      teamId: 7,
      reclaimedUserId: 42
    });

    const [reclaimSql] = client.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE users SET authentik_user_id')
    );
    expect(reclaimSql).not.toContain('origin_org_id');
  });
});

/**
 * Unit tests for `UserProvisioningService.resolveNewUserIdentity`
 * (takserver-enrollment Requirements 6.3, 6.5, 6.7, 6.8, 9.1, 9.2, 9.3, 9.4,
 * 8.1; task 5.1), which REPLACES `resolveCallsignSuffixForNewUser`
 * (Requirements 11.6, 11.7, 11.14, 11.15; task 22.1).
 * `Team.getAncestorChain`/`Team.getFullMemberList` and
 * `CallsignService.computeDefaultCallsignSuffix` are mocked directly, as
 * before. The policy-disabled cases below carry an explicit
 * `requestedUsername` and `email` -- inputs the old function never took --
 * chosen to match what each case is actually testing, and assert against
 * `result.callsignSuffix` (the new function returns an object, not a bare
 * string).
 */
describe('UserProvisioningService.resolveNewUserIdentity', () => {
  const fakeClient = {};

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves to the requested suffix when callsign_name_format is user_defined and a value is supplied', async () => {
    Team.getAncestorChain.mockResolvedValueOnce([
      { id: 1, parent_team_id: null, callsign_name_format: 'user_defined', pseudonymous_usernames: false, depth: 0 },
      { id: 7, parent_team_id: 1, callsign_name_format: 'user_defined', depth: 1 }
    ]);
    Team.getFullMemberList.mockResolvedValueOnce([]);

    const result = await UserProvisioningService.resolveNewUserIdentity(fakeClient, {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      teamId: 7,
      requestedUsername: 'john.doe',
      requestedCallsignSuffix: 'Badge123'
    });

    expect(result.callsignSuffix).toBe('Badge123');
    expect(result.username).toBe('john.doe');
    expect(result.pseudonymous).toBe(false);
    expect(CallsignService.computeDefaultCallsignSuffix).not.toHaveBeenCalled();
  });

  it('throws CallsignSuffixRequiredError when callsign_name_format is user_defined and no value is supplied', async () => {
    Team.getAncestorChain.mockResolvedValueOnce([
      { id: 1, parent_team_id: null, callsign_name_format: 'user_defined', pseudonymous_usernames: false, depth: 0 }
    ]);

    await expect(
      UserProvisioningService.resolveNewUserIdentity(fakeClient, {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        teamId: 1,
        requestedUsername: 'john.doe',
        requestedCallsignSuffix: undefined
      })
    ).rejects.toThrow(UserProvisioningService.CallsignSuffixRequiredError);

    expect(Team.getFullMemberList).not.toHaveBeenCalled();
  });

  it('throws CallsignSuffixRequiredError when callsign_name_format is user_defined and an empty/whitespace value is supplied', async () => {
    Team.getAncestorChain.mockResolvedValueOnce([
      { id: 1, parent_team_id: null, callsign_name_format: 'user_defined', pseudonymous_usernames: false, depth: 0 }
    ]);

    await expect(
      UserProvisioningService.resolveNewUserIdentity(fakeClient, {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        teamId: 1,
        requestedUsername: 'john.doe',
        requestedCallsignSuffix: '   '
      })
    ).rejects.toThrow(UserProvisioningService.CallsignSuffixRequiredError);
  });

  it('computes the default via CallsignService when callsign_name_format is not user_defined and no value is supplied', async () => {
    Team.getAncestorChain.mockResolvedValueOnce([
      { id: 1, parent_team_id: null, callsign_name_format: 'full_name', pseudonymous_usernames: false, depth: 0 },
      { id: 7, parent_team_id: 1, callsign_name_format: 'full_name', depth: 1 }
    ]);
    CallsignService.computeDefaultCallsignSuffix.mockReturnValueOnce('John Doe');
    Team.getFullMemberList.mockResolvedValueOnce([]);

    const result = await UserProvisioningService.resolveNewUserIdentity(fakeClient, {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      teamId: 7,
      requestedUsername: 'john.doe@example.com',
      requestedCallsignSuffix: undefined
    });

    expect(CallsignService.computeDefaultCallsignSuffix).toHaveBeenCalledWith('John', 'Doe', 'full_name');
    expect(result.callsignSuffix).toBe('John Doe');
    expect(result.username).toBe('john.doe@example.com');
  });

  it('prefers a supplied requestedCallsignSuffix over the computed default for a non-user_defined format', async () => {
    Team.getAncestorChain.mockResolvedValueOnce([
      { id: 1, parent_team_id: null, callsign_name_format: 'full_name', pseudonymous_usernames: false, depth: 0 }
    ]);
    Team.getFullMemberList.mockResolvedValueOnce([]);

    const result = await UserProvisioningService.resolveNewUserIdentity(fakeClient, {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      teamId: 1,
      requestedUsername: 'john.doe@example.com',
      requestedCallsignSuffix: 'Badge123'
    });

    expect(result.callsignSuffix).toBe('Badge123');
    expect(CallsignService.computeDefaultCallsignSuffix).not.toHaveBeenCalled();
  });

  it('propagates CallsignSuffixConflictError from a uniqueness collision', async () => {
    Team.getAncestorChain.mockResolvedValueOnce([
      { id: 1, parent_team_id: null, callsign_name_format: 'full_name', pseudonymous_usernames: false, depth: 0 }
    ]);
    CallsignService.computeDefaultCallsignSuffix.mockReturnValueOnce('John Doe');
    Team.getFullMemberList.mockResolvedValueOnce([
      { id: 99, callsign_suffix: 'John Doe' }
    ]);

    await expect(
      UserProvisioningService.resolveNewUserIdentity(fakeClient, {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        teamId: 1,
        requestedUsername: 'john.doe@example.com',
        requestedCallsignSuffix: undefined
      })
    ).rejects.toThrow(CallsignSuffixConflictError);
  });

  it('calls Team.getAncestorChain with teamId and uses the root (depth 0) row\'s callsign_name_format', async () => {
    Team.getAncestorChain.mockResolvedValueOnce([
      { id: 1, parent_team_id: null, callsign_name_format: 'first_initial_last', pseudonymous_usernames: false, depth: 0 },
      { id: 5, parent_team_id: 1, callsign_name_format: 'first_initial_last', depth: 1 },
      { id: 9, parent_team_id: 5, callsign_name_format: 'first_initial_last', depth: 2 }
    ]);
    CallsignService.computeDefaultCallsignSuffix.mockReturnValueOnce('J Doe');
    Team.getFullMemberList.mockResolvedValueOnce([]);

    const result = await UserProvisioningService.resolveNewUserIdentity(fakeClient, {
      firstName: 'John',
      lastName: 'Doe',
      email: 'john.doe@example.com',
      teamId: 9,
      requestedUsername: 'john.doe@example.com',
      requestedCallsignSuffix: undefined
    });

    expect(Team.getAncestorChain).toHaveBeenCalledWith(9);
    expect(CallsignService.computeDefaultCallsignSuffix).toHaveBeenCalledWith('John', 'Doe', 'first_initial_last');
    expect(Team.getFullMemberList).toHaveBeenCalledWith(9);
    expect(result.callsignSuffix).toBe('J Doe');
    expect(result.organisationId).toBe(1);
    expect(result.organisationPrefix).toBeUndefined();
  });

  /**
   * The previously-untested pseudonymous/policy-enabled path (Requirements
   * 6.3, 6.5, 6.7, 8.1, 9.1, 9.2). `ManagedIdentifierService` runs for
   * real -- only the underlying `pool.query` the Claim_Row `INSERT` reaches
   * is mocked, per the module-level `jest.mock('../config/database', ...)`
   * above -- so a minted username is a genuine `generateManagedIdentifier`
   * output, checked here via `isManagedIdentifier` rather than by
   * re-deriving the exact seven-character body (which is random and cannot
   * be predicted by the test).
   */
  describe('the pseudonymous/policy-enabled path', () => {
    it('mints a Pseudonymous_Username, ignores requestedUsername, and never computes a name-derived default', async () => {
      Team.getAncestorChain.mockResolvedValueOnce([
        {
          id: 3,
          parent_team_id: null,
          callsign_name_format: 'full_name',
          pseudonymous_usernames: true,
          callsign_prefix: 'AUK',
          depth: 0
        }
      ]);
      Team.getFullMemberList.mockResolvedValueOnce([]);
      pool.query.mockResolvedValueOnce({ rows: [{ id: 555 }] });

      const result = await UserProvisioningService.resolveNewUserIdentity(fakeClient, {
        firstName: 'John',
        lastName: 'Doe',
        email: 'john.doe@example.com',
        teamId: 3,
        requestedUsername: 'john.doe@example.com',
        requestedCallsignSuffix: 'Badge123'
      });

      expect(isManagedIdentifier(result.username)).toBe(true);
      expect(result.username.startsWith('AUK-U')).toBe(true);
      expect(result.username).not.toBe('john.doe@example.com');
      expect(result.pseudonymous).toBe(true);
      expect(result.callsignSuffix).toBe('Badge123');
      expect(result.claimId).toBe(555);
      expect(CallsignService.computeDefaultCallsignSuffix).not.toHaveBeenCalled();

      // The Claim_Row insert ran against the shared `pool`, carrying the
      // real supplied email (design decision 5) and authentik_user_id NULL
      // / is_active false (the two columns that make it invisible to every
      // existing surface).
      expect(pool.query).toHaveBeenCalledTimes(1);
      const [claimSql, claimParams] = pool.query.mock.calls[0];
      expect(claimSql).toContain('INSERT INTO users');
      expect(claimParams).toEqual([result.username, 'john.doe@example.com', 'John', 'Doe']);
    });

    it('throws CallsignSuffixRequiredError for a blank requestedCallsignSuffix and never attempts a mint', async () => {
      Team.getAncestorChain.mockResolvedValueOnce([
        {
          id: 3,
          parent_team_id: null,
          callsign_name_format: 'full_name',
          pseudonymous_usernames: true,
          callsign_prefix: 'AUK',
          depth: 0
        }
      ]);

      await expect(
        UserProvisioningService.resolveNewUserIdentity(fakeClient, {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john.doe@example.com',
          teamId: 3,
          requestedUsername: 'john.doe@example.com',
          requestedCallsignSuffix: '   '
        })
      ).rejects.toThrow(UserProvisioningService.CallsignSuffixRequiredError);

      // No Claim_Row insert / mint attempt occurred: Callsign_Default_
      // Suppression's validation runs BEFORE any mint attempt (Criteria
      // 9.1, 9.2), so a request-validation failure never reaches the
      // Claim_Row.
      expect(pool.query).not.toHaveBeenCalled();
      expect(Team.getFullMemberList).not.toHaveBeenCalled();
    });

    it('throws OrganisationPrefixMissingError when the Organisation has no valid callsign_prefix', async () => {
      Team.getAncestorChain.mockResolvedValueOnce([
        {
          id: 3,
          parent_team_id: null,
          callsign_name_format: 'full_name',
          pseudonymous_usernames: true,
          callsign_prefix: null,
          depth: 0
        }
      ]);

      await expect(
        UserProvisioningService.resolveNewUserIdentity(fakeClient, {
          firstName: 'John',
          lastName: 'Doe',
          email: 'john.doe@example.com',
          teamId: 3,
          requestedUsername: 'john.doe@example.com',
          requestedCallsignSuffix: 'Badge123'
        })
      ).rejects.toThrow(ManagedIdentifierService.OrganisationPrefixMissingError);

      expect(pool.query).not.toHaveBeenCalled();
    });
  });
});

/**
 * Property 19: Provenance is the target Team's Organisation and is written
 * once (task 13.3). Over any Team hierarchy, any target Team at any depth,
 * and any prior `origin_org_id` value, `createAndAddUser` must write into the
 * users upsert an `origin_org_id` VALUE equal to the Organisation at the root
 * of the target Team's Ancestor_Chain (Requirement 13.3), and the upsert's
 * ON CONFLICT DO UPDATE SET clause must guard that write with
 * `COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)` so a prior non-null
 * value is never overwritten (Requirement 13.9, the write-once guarantee).
 *
 * The transactional `client` is mocked, exactly as the createAndAddUser
 * tests above do. The reference root Organisation id is computed by walking
 * the generated hierarchy directly (`hierarchy.rootOf`), never by calling
 * `resolveOrganisationIdForTeam`; the mocked `WITH RECURSIVE chain` query is
 * simply told to return that reference id, and the test then asserts that
 * this is the value the INSERT is parameterised with. Every other query the
 * function issues (the `SELECT id FROM users`, the `parent_teams` CTE, and
 * the channel SELECTs) is mocked to a benign result so the function runs to
 * completion.
 */
describe('UserProvisioningService.createAndAddUser provenance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    EventPublisher.publishOperation.mockResolvedValue('op-id');
  });

  // Feature: member-visibility-and-callsign-recompute, Property 19: Provenance is the target Team's Organisation and is written once
  // Validates: Requirements 13.3, 13.4, 13.5, 13.9
  test.prop(
    [
      hierarchyArb({ minOrganisations: 1, maxOrganisations: 3 }).chain((hierarchy) =>
        fc.record({
          hierarchy: fc.constant(hierarchy),
          // The target Team is any Team in the forest, at any depth (an
          // Organisation root, a leaf, or anywhere between).
          targetTeamId: fc.constantFrom(...hierarchy.teamIds),
          // Any prior `origin_org_id`: `null` (a first-time provision) or a
          // non-null value (a returning user being re-provisioned). This
          // value is not consumed by the mocked client -- it only exists to
          // let the property state the write-once claim over "any prior
          // value" -- but is drawn so the intent is explicit.
          priorOriginOrgId: fc.oneof(
            fc.constant(null),
            fc.constantFrom(...hierarchy.teamIds)
          )
        })
      )
    ],
    { numRuns: 100 }
  )(
    'writes the target Team\'s Organisation as origin_org_id, guarded by a write-once COALESCE',
    async ({ hierarchy, targetTeamId }) => {
      jest.clearAllMocks();
      EventPublisher.publishOperation.mockResolvedValue('op-id');

      // The expected provenance, computed by walking the generated hierarchy
      // directly: the root of the target Team's Ancestor_Chain.
      const expectedRootOrgId = hierarchy.rootOf(targetTeamId);

      let capturedInsertSql = null;
      let capturedOriginOrgIdParam;

      const client = {
        query: jest.fn((sql, params) => {
          // The resolveOrganisationIdForTeam recursive query: return the
          // reference root org id for the target Team. The service uses this
          // return value as the origin_org_id it writes.
          if (sql.includes('WITH RECURSIVE chain')) {
            return Promise.resolve({ rows: [{ id: expectedRootOrgId }] });
          }
          // The users upsert: capture its SQL and the origin_org_id param
          // (the 7th positional parameter, $7).
          if (sql.includes('INSERT INTO users')) {
            capturedInsertSql = sql;
            capturedOriginOrgIdParam = params[6];
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
            return Promise.resolve({ rows: [{ id: 4242 }] });
          }
          // Benign: no parent teams, no channels.
          if (sql.includes('WITH RECURSIVE parent_teams')) {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        })
      };

      await UserProvisioningService.createAndAddUser(client, {
        authentikUserId: 12345,
        username: 'provenance.user',
        email: 'provenance.user@example.com',
        firstName: 'Prov',
        lastName: 'Enance',
        teamId: targetTeamId,
        createdBy: 1
      });

      // Requirement 13.3: the origin_org_id VALUE passed to the upsert equals
      // the target Team's Organisation (the root of its Ancestor_Chain).
      expect(capturedOriginOrgIdParam).toBe(expectedRootOrgId);

      // Requirement 13.9 (write-once): the upsert's ON CONFLICT DO UPDATE SET
      // clause guards origin_org_id with
      // COALESCE(users.origin_org_id, EXCLUDED.origin_org_id). At the SQL
      // level this is the write-once guarantee: COALESCE(prior, new) = prior
      // whenever `prior` is non-null, so a returning user's existing
      // provenance is never overwritten regardless of the target Team.
      expect(capturedInsertSql).not.toBeNull();
      expect(capturedInsertSql).toContain(
        'origin_org_id = COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)'
      );
    }
  );
});
