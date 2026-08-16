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

const EventPublisher = require('./EventPublisher');
const UserProvisioningService = require('./UserProvisioningService');

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
