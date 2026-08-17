/**
 * Unit tests for `Team.delete` (Requirement 17.3/17.4, task 36.3).
 *
 * `Team.delete` must run its four deletes (`channel_memberships` for the
 * team's channels, `channels`, `team_memberships`, `teams`) on ONE
 * acquired transactional client, in that FK-dependency order, and -- on
 * successful COMMIT -- enqueue one `remove_team_channel_group`
 * Sync_Operation per deleted channel, using that same client (per
 * Requirement 17.5's client-threading pattern) so the enqueue commits/
 * rolls back atomically with the deletion. A failure anywhere in the
 * transaction must roll back everything and enqueue nothing.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const EventPublisher = require('../services/EventPublisher');
const Team = require('./Team');

describe('Team.delete', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
  });

  it('runs all four deletes on the single acquired client, in channel_memberships -> channels -> team_memberships -> teams order, then commits', async () => {
    const deletedChannels = [
      { id: 10, authentik_group_id: 100, authentik_read_group_id: null, authentik_write_group_id: null }
    ];

    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: deletedChannels });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5, name: 'Deleted Team' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await Team.delete(5, 99);

    // Exactly one client acquired for the whole operation.
    expect(pool.connect).toHaveBeenCalledTimes(1);

    const calls = mockClient.query.mock.calls.map(([sql]) => sql);

    expect(calls[0]).toBe('BEGIN');

    const channelMembershipsIdx = calls.findIndex((sql) => sql.includes('DELETE FROM channel_memberships'));
    const channelsIdx = calls.findIndex((sql) => sql.includes('DELETE FROM channels'));
    const teamMembershipsIdx = calls.findIndex((sql) => sql.includes('DELETE FROM team_memberships'));
    const teamsIdx = calls.findIndex((sql) => sql.includes('DELETE FROM teams'));

    expect(channelMembershipsIdx).toBeGreaterThan(-1);
    expect(channelsIdx).toBeGreaterThan(channelMembershipsIdx);
    expect(teamMembershipsIdx).toBeGreaterThan(channelsIdx);
    expect(teamsIdx).toBeGreaterThan(teamMembershipsIdx);

    expect(calls).toContain('COMMIT');
    expect(calls).not.toContain('ROLLBACK');

    expect(result).toEqual({ id: 5, name: 'Deleted Team' });
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('enqueues exactly one remove_team_channel_group Sync_Operation per deleted channel, with the right payload, using the same client', async () => {
    const deletedChannels = [
      { id: 10, authentik_group_id: 100, authentik_read_group_id: null, authentik_write_group_id: null },
      { id: 11, authentik_group_id: null, authentik_read_group_id: 201, authentik_write_group_id: 202 }
    ];

    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: deletedChannels });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.delete(5, 99);

    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(2);
    expect(EventPublisher.publishOperation).toHaveBeenNthCalledWith(
      1,
      'remove_team_channel_group',
      { channel_id: 10, authentik_group_id: 100 },
      99,
      mockClient
    );
    expect(EventPublisher.publishOperation).toHaveBeenNthCalledWith(
      2,
      'remove_team_channel_group',
      { channel_id: 11, authentik_read_group_id: 201, authentik_write_group_id: 202 },
      99,
      mockClient
    );
  });

  it('enqueues nothing when the team has no channels', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.delete(5, 99);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    // No channel_memberships DELETE should run when there are no channel ids.
    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calls.some((sql) => sql.includes('DELETE FROM channel_memberships'))).toBe(false);
  });

  it('rolls back the entire transaction and enqueues nothing when a delete step fails', async () => {
    const deletedChannels = [
      { id: 10, authentik_group_id: 100, authentik_read_group_id: null, authentik_write_group_id: null }
    ];

    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: deletedChannels });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM team_memberships')) {
        return Promise.reject(new Error('constraint violation'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(Team.delete(5, 99)).rejects.toThrow('constraint violation');

    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and enqueues nothing when the Sync_Operation enqueue itself fails', async () => {
    const deletedChannels = [
      { id: 10, authentik_group_id: 100, authentik_read_group_id: null, authentik_write_group_id: null }
    ];

    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: deletedChannels });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    EventPublisher.publishOperation.mockRejectedValue(new Error('sync_operations insert failed'));

    await expect(Team.delete(5, 99)).rejects.toThrow('sync_operations insert failed');

    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  /**
   * Requirement 26.7 (task 48.4): `Team.delete` enqueues exactly ONE
   * bulk `revoke_tak_certificates` Sync_Operation covering every affected
   * user across the team and its sub-teams, rather than one operation
   * per user.
   */
  it('enqueues exactly one bulk revoke_tak_certificates Sync_Operation covering every affected user across the team and its sub-teams', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: [] }); // no channels
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [{ username: 'alice' }, { username: 'bob' }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.delete(5, 99);

    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { tak_usernames: ['alice', 'bob'] },
      99,
      mockClient
    );
  });

  it('resolves affected users BEFORE deleting team_memberships, and enqueues nothing when no user has a resolvable username', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [] }); // no affected usernames
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.delete(5, 99);

    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    const affectedUsersIdx = calls.findIndex((sql) => sql.includes('WITH RECURSIVE team_and_subteams'));
    const teamMembershipsIdx = calls.findIndex((sql) => sql.includes('DELETE FROM team_memberships'));
    expect(affectedUsersIdx).toBeGreaterThan(-1);
    expect(affectedUsersIdx).toBeLessThan(teamMembershipsIdx);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
      'revoke_tak_certificates',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });
});

/**
 * Unit tests for `Team.getUserTeams`/`Team.getAllTeams` (Requirement
 * 27.9, task 49.5).
 *
 * `member_count` is a dashboard-style column displayed on the
 * Teams/TeamDetail pages, so it must exclude Team_Owned_Device rows
 * (`users.is_team_device = true`) the same way `GET /api/users` does --
 * a device should never inflate a displayed member count. These tests
 * verify the `member_count` subquery joins to `users` and filters on
 * `is_team_device IS NOT TRUE`, rather than asserting against a live
 * database (these methods use `pool.query` directly, not an acquired
 * transactional client, so `pool.query` is mocked directly here).
 */
describe('Team.getUserTeams / Team.getAllTeams member_count excludes Team_Owned_Device rows (Requirement 27.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getUserTeams: the member_count subquery joins users and filters on is_team_device IS NOT TRUE', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1, name: 'Team A', member_count: '2' }] });

    await Team.getUserTeams(42);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN users u2 ON u2.id = tm2.user_id');
    expect(sql).toContain('u2.is_team_device IS NOT TRUE');
    expect(params).toEqual([42]);
  });

  it('getAllTeams: the member_count subquery joins users and filters on is_team_device IS NOT TRUE, independent of pagination', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1, name: 'Team A', member_count: '3' }] });

    await Team.getAllTeams();

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('JOIN users u ON u.id = tm.user_id');
    expect(sql).toContain('u.is_team_device IS NOT TRUE');
    // sub_teams_count is unrelated to users and must be left untouched.
    expect(sql).toContain('(SELECT COUNT(*) FROM teams t2 WHERE t2.parent_team_id = t.id) as sub_teams_count');
  });

  it('getAllTeams: still applies the same member_count exclusion when called with explicit pagination', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await Team.getAllTeams(50, 0);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('u.is_team_device IS NOT TRUE');
    expect(sql).toContain('LIMIT $1 OFFSET $2');
    expect(params).toEqual([50, 0]);
  });
});

/**
 * Unit tests for `Team.getAncestorChain` / `Team.getTeamDepth`
 * (Requirement 2.1, task 2.2).
 *
 * These methods use `pool.query` directly (not an acquired transactional
 * client), so `pool.query` is mocked directly and made to return the rows
 * the underlying recursive CTE would produce for a given hierarchy shape,
 * consistent with this file's existing mocking convention.
 */
describe('Team.getAncestorChain / Team.getTeamDepth (Requirement 2.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getAncestorChain: returns a single row with depth 0 for a root-only (single-node) team', async () => {
    // Organisation with no parent: the CTE's only row has
    // hops_from_target = 0, so MAX(hops_from_target) - 0 = 0.
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 1, parent_team_id: null, name: 'FENZ', callsign_prefix: 'FENZ',
          color: 'Red', callsign_name_format: 'full_name', visibility: 'public',
          depth: 0
        }
      ]
    });

    const chain = await Team.getAncestorChain(1);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WITH RECURSIVE ancestors');
    expect(sql).toContain('ORDER BY depth ASC');
    expect(params).toEqual([1]);

    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ id: 1, depth: 0, parent_team_id: null, name: 'FENZ' });
  });

  it('getAncestorChain: returns ancestors ROOT-FIRST with correctly re-derived depths for a multi-level chain', async () => {
    // Simulated hierarchy: Org(1) -> Region(2) -> District(3) -> Station(4)
    // Query walks UPWARD from teamId=4, so the CTE (pre-final-SELECT) would
    // number hops_from_target as: Station=0, District=1, Region=2, Org=3.
    // depth = MAX(hops_from_target) [3] - hops_from_target, giving
    // Org=0, Region=1, District=2, Station=3 -- and the mocked result below
    // represents the already-computed, ORDER BY depth ASC output rows.
    pool.query.mockResolvedValue({
      rows: [
        { id: 1, parent_team_id: null, name: 'Org', callsign_prefix: 'FENZ', color: 'Red', callsign_name_format: 'full_name', visibility: 'public', depth: 0 },
        { id: 2, parent_team_id: 1, name: 'Region', callsign_prefix: 'TEIHU', color: 'Red', callsign_name_format: 'full_name', visibility: 'public', depth: 1 },
        { id: 3, parent_team_id: 2, name: 'District', callsign_prefix: 'CHC', color: 'Red', callsign_name_format: 'full_name', visibility: 'public', depth: 2 },
        { id: 4, parent_team_id: 3, name: 'Station', callsign_prefix: 'S40', color: 'Red', callsign_name_format: 'full_name', visibility: 'private', depth: 3 }
      ]
    });

    const chain = await Team.getAncestorChain(4);

    expect(chain).toHaveLength(4);
    // Root-first ordering: the Organisation (parent_team_id null) is first.
    expect(chain[0]).toMatchObject({ id: 1, parent_team_id: null, depth: 0 });
    expect(chain[1]).toMatchObject({ id: 2, parent_team_id: 1, depth: 1 });
    expect(chain[2]).toMatchObject({ id: 3, parent_team_id: 2, depth: 2 });
    // The target team itself is last, with depth equal to its true
    // Team_Depth (3), not its hops-from-target value (0).
    expect(chain[3]).toMatchObject({ id: 4, parent_team_id: 3, depth: 3 });

    // Depths are strictly ascending root-to-target.
    const depths = chain.map((row) => row.depth);
    expect(depths).toEqual([0, 1, 2, 3]);
  });

  it('getAncestorChain: propagates a query error to the caller', async () => {
    pool.query.mockRejectedValue(new Error('db unavailable'));

    await expect(Team.getAncestorChain(1)).rejects.toThrow('db unavailable');
  });

  it('getTeamDepth: returns 0 for a root (single-node) team', async () => {
    pool.query.mockResolvedValue({ rows: [{ depth: 0 }] });

    const depth = await Team.getTeamDepth(1);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WITH RECURSIVE ancestors');
    expect(sql).toContain('MAX(hops_from_target)');
    expect(params).toEqual([1]);
    expect(depth).toBe(0);
  });

  it('getTeamDepth: returns the correct depth for a multi-level chain', async () => {
    // Team 4 sits 3 levels beneath its Organisation (Org=0, Region=1,
    // District=2, Station=3), so MAX(hops_from_target) = 3.
    pool.query.mockResolvedValue({ rows: [{ depth: 3 }] });

    const depth = await Team.getTeamDepth(4);

    expect(depth).toBe(3);
  });

  it('getTeamDepth: propagates a query error to the caller', async () => {
    pool.query.mockRejectedValue(new Error('db unavailable'));

    await expect(Team.getTeamDepth(1)).rejects.toThrow('db unavailable');
  });
});

/**
 * Unit tests for `Team.getSubTeamsForCallsignLevel` (Requirement
 * 5.8-5.11, task 8.3).
 *
 * `getSubTeamsForCallsignLevel(organisationId)` must run a single
 * recursive CTE walking DOWNWARD from `organisationId`, bounded by
 * `team_depth BETWEEN 1 AND $2` where `$2` is the imported
 * `MAX_TEAM_DEPTH` constant (not a hardcoded `5`), and return the flat
 * `{ team_depth, callsign_prefix }` row shape unchanged -- no grouping,
 * de-duplication, or truncation server-side (that is the Client's job
 * per design.md).
 */
describe('Team.getSubTeamsForCallsignLevel (Requirement 5.8-5.11)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs the recursive CTE with [organisationId, MAX_TEAM_DEPTH] params', async () => {
    pool.query.mockResolvedValue({
      rows: [
        { team_depth: 1, callsign_prefix: 'CB' },
        { team_depth: 1, callsign_prefix: 'AUK' }
      ]
    });

    await Team.getSubTeamsForCallsignLevel(1);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WITH RECURSIVE tree');
    expect(sql).toContain('t.parent_team_id = tr.id');
    expect(sql).toContain('team_depth BETWEEN 1 AND $2');
    expect(sql).toContain("callsign_prefix IS NOT NULL AND callsign_prefix != ''");
    // MAX_TEAM_DEPTH is 5 in this codebase's constants.js; asserting the
    // literal value here confirms the shared constant (not a hardcoded
    // 5 inline in the query) is what's passed as $2.
    expect(params).toEqual([1, 5]);
  });

  it('returns the flat row shape unchanged, with no grouping/dedup/truncation applied', async () => {
    const rows = [
      { team_depth: 1, callsign_prefix: 'CB' },
      { team_depth: 1, callsign_prefix: 'AUK' },
      { team_depth: 1, callsign_prefix: 'WGN' },
      { team_depth: 2, callsign_prefix: 'ST40' }
    ];
    pool.query.mockResolvedValue({ rows });

    const result = await Team.getSubTeamsForCallsignLevel(1);

    expect(result).toEqual(rows);
  });

  it('propagates a query error to the caller', async () => {
    pool.query.mockRejectedValue(new Error('db unavailable'));

    await expect(Team.getSubTeamsForCallsignLevel(1)).rejects.toThrow('db unavailable');
  });
});

/**
 * Unit tests for `Team.isAdmin` (Requirement 4.1-4.4, task 3.1).
 *
 * `isAdmin` must walk the Ancestor_Chain via a recursive CTE, matching
 * only a DIRECT (`inherited_from_team_id IS NULL`), `role = 'admin'`
 * membership on the team itself or any ancestor. These tests mock
 * `pool.query` directly (not an acquired transactional client), matching
 * this file's existing `getAncestorChain`/`getTeamDepth` mocking
 * convention.
 */
describe('Team.isAdmin (Requirement 4.1-4.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true for a direct admin membership on the team itself', async () => {
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const result = await Team.isAdmin(4, 42);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WITH RECURSIVE ancestors');
    expect(sql).toContain("role = 'admin'");
    expect(sql).toContain('inherited_from_team_id IS NULL');
    expect(params).toEqual([4, 42]);
    expect(result).toBe(true);
  });

  it('returns true for an admin inherited from a parent ancestor', async () => {
    // Simulates: user has a direct admin row on the parent (Team 3), and
    // the query's JOIN across the ancestors CTE surfaces that row when
    // checking child Team 4.
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const result = await Team.isAdmin(4, 42);

    expect(result).toBe(true);
  });

  it('returns true for an admin inherited from a grandparent ancestor', async () => {
    // Simulates: user has a direct admin row on the grandparent (Team 2),
    // several levels above the checked Team (4).
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const result = await Team.isAdmin(4, 42);

    expect(result).toBe(true);
  });

  it('returns false when the user only has a non-admin (member) membership on an ancestor', async () => {
    // A role != 'admin' row on an ancestor must not grant admin status --
    // the SQL's WHERE clause filters on role = 'admin', so a member-only
    // row produces no matching database rows.
    pool.query.mockResolvedValue({ rows: [] });

    const result = await Team.isAdmin(4, 42);

    expect(result).toBe(false);
  });

  it('returns false when the user has no membership at all in the chain', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await Team.isAdmin(4, 42);

    expect(result).toBe(false);
  });

  it('returns false (not a rejected promise) on a database error, matching the existing catch-and-return-false pattern', async () => {
    pool.query.mockRejectedValue(new Error('db unavailable'));

    const result = await Team.isAdmin(4, 42);

    expect(result).toBe(false);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), teamId: 4, userId: 42 }),
      'Error checking admin status'
    );
  });
});

/**
 * Unit tests for `Team.create`'s Max_Team_Depth enforcement (Requirement
 * 2.2/2.3, task 5.1).
 *
 * `Team.create` must compute the target Team_Depth (via `getTeamDepth`
 * when `parent_team_id` is present, else 0) BEFORE attempting any INSERT,
 * and throw `Team.TeamDepthExceededError` without inserting when that
 * depth exceeds `MAX_TEAM_DEPTH`. These tests mock `pool.query` directly,
 * matching this file's existing convention, and stub `createTeamChannel`
 * (a separate concern with its own DB/Authentik calls) so these tests
 * stay focused on the depth guard.
 */
describe('Team.create Max_Team_Depth enforcement (Requirement 2.2/2.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Team, 'createTeamChannel').mockResolvedValue({ id: 999 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a root team (no parent_team_id) at depth 0 without calling getTeamDepth', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1, name: 'FENZ', parent_team_id: null }] });

    const team = await Team.create({ name: 'FENZ', parent_team_id: null });

    // No depth lookup needed for a root team: the only pool.query call is
    // the INSERT itself.
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO teams');
    expect(team).toEqual({ id: 1, name: 'FENZ', parent_team_id: null });
  });

  it('creates a Sub_Team whose computed depth is within MAX_TEAM_DEPTH', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
        // Parent sits at depth 3, so this Sub_Team would be depth 4 (<= 5).
        return Promise.resolve({ rows: [{ depth: 3 }] });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO teams')) {
        return Promise.resolve({ rows: [{ id: 10, name: 'Station 40', parent_team_id: 4 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const team = await Team.create({ name: 'Station 40', parent_team_id: 4 });

    expect(team).toEqual({ id: 10, name: 'Station 40', parent_team_id: 4 });
    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO teams'));
    expect(insertCall).toBeDefined();
  });

  it('throws TeamDepthExceededError and never inserts when the computed depth exceeds MAX_TEAM_DEPTH', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
        // Parent already sits at depth 5 (MAX_TEAM_DEPTH), so this
        // Sub_Team would be depth 6 -- exceeds the limit.
        return Promise.resolve({ rows: [{ depth: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(Team.create({ name: 'Too Deep', parent_team_id: 99 }))
      .rejects.toThrow(Team.TeamDepthExceededError);

    // The INSERT must never have been attempted.
    const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO teams'));
    expect(insertCalls).toHaveLength(0);
    expect(Team.createTeamChannel).not.toHaveBeenCalled();
  });

  it('the thrown error carries a message naming MAX_TEAM_DEPTH and is identifiable via .name', async () => {
    pool.query.mockResolvedValue({ rows: [{ depth: 5 }] });

    try {
      await Team.create({ name: 'Too Deep', parent_team_id: 99 });
      throw new Error('expected Team.create to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Team.TeamDepthExceededError);
      expect(error.name).toBe('TeamDepthExceededError');
      expect(error.message).toContain('5');
    }
  });
});

/**
 * Unit tests for `Team.create`/`Team.update`'s Organisation-only
 * `color`/`callsign_name_format` inheritance (Requirement 3.2/3.3, task
 * 6.1).
 *
 * `Team.create` must resolve a Sub_Team's `color`/`callsign_name_format`
 * from its ORGANISATION's current values (the root, depth-0 row of
 * `getAncestorChain`) -- not necessarily its immediate parent's own
 * stored value -- and silently override whatever was supplied on
 * `teamData`. `Team.update` must silently ignore (never reject) a
 * supplied `color`/`callsign_name_format` value when the target team is
 * a Sub_Team, while an Organisation (`parent_team_id IS NULL`) remains
 * freely updatable/settable for both fields.
 */
describe('Team.create / Team.update Organisation-only color/callsign_name_format inheritance (Requirement 3.2/3.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Team, 'createTeamChannel').mockResolvedValue({ id: 999 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Team.create', () => {
    it('a root Organisation keeps its own supplied color/callsign_name_format (no ancestor lookup)', async () => {
      pool.query.mockResolvedValue({
        rows: [{ id: 1, name: 'FENZ', parent_team_id: null, color: 'Red', callsign_name_format: 'full_name' }]
      });

      const team = await Team.create({
        name: 'FENZ',
        parent_team_id: null,
        color: 'Red',
        callsign_name_format: 'full_name'
      });

      // No ancestor-chain lookup for a root team: only the INSERT runs.
      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO teams');
      expect(params).toEqual(
        expect.arrayContaining(['Red', 'full_name'])
      );
      expect(team.color).toBe('Red');
    });

    it('a Sub_Team created under a deep chain inherits color/callsign_name_format from its ORGANISATION (depth 0), not its immediate parent', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors') && sql.includes('MAX(hops_from_target) AS depth')) {
          // getTeamDepth(parent_team_id) -- parent sits at depth 2.
          return Promise.resolve({ rows: [{ depth: 2 }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
          // getAncestorChain(parent_team_id), root-first: Organisation's
          // color/format ('Red'/'full_name') differs from the immediate
          // parent's own stored (and here deliberately WRONG/stale)
          // values ('Blue'/'first_initial_last'), to prove the
          // Organisation's value -- not the parent's -- is used.
          return Promise.resolve({
            rows: [
              { id: 1, parent_team_id: null, color: 'Red', callsign_name_format: 'full_name', depth: 0 },
              { id: 2, parent_team_id: 1, color: 'Blue', callsign_name_format: 'first_initial_last', depth: 1 },
              { id: 3, parent_team_id: 2, color: 'Blue', callsign_name_format: 'first_initial_last', depth: 2 }
            ]
          });
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO teams')) {
          return Promise.resolve({ rows: [{ id: 10, name: 'Station 40', parent_team_id: 3, color: 'Red', callsign_name_format: 'full_name' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const team = await Team.create({
        name: 'Station 40',
        parent_team_id: 3,
        // Client-supplied override -- must be ignored entirely.
        color: 'Green',
        callsign_name_format: 'first_last_initial'
      });

      const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO teams'));
      expect(insertCall).toBeDefined();
      const [, insertParams] = insertCall;
      expect(insertParams).toEqual(
        expect.arrayContaining(['Red', 'full_name'])
      );
      expect(insertParams).not.toEqual(expect.arrayContaining(['Green']));
      expect(team.color).toBe('Red');
      expect(team.callsign_name_format).toBe('full_name');
    });
  });

  describe('Team.update', () => {
    it('silently ignores a supplied color/callsign_name_format on a Sub_Team, preserving the existing stored value via COALESCE', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          // Sub_Team: has a non-null parent_team_id.
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: 3, color: 'Red', callsign_name_format: 'full_name' }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 5, color: 'Red', callsign_name_format: 'full_name' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const updated = await Team.update(5, {
        name: 'Renamed Station',
        color: 'Purple',
        callsign_name_format: 'first_initial_last'
      });

      const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE teams'));
      expect(updateCall).toBeDefined();
      const [, updateParams] = updateCall;
      // color/callsign_name_format params are undefined -- COALESCE keeps
      // the existing stored value, never applying 'Purple'/
      // 'first_initial_last'.
      expect(updateParams).not.toContain('Purple');
      expect(updateParams).not.toContain('first_initial_last');
      expect(updated.color).toBe('Red');
      expect(updated.callsign_name_format).toBe('full_name');
    });

    it('allows changing color/callsign_name_format on an Organisation (parent_team_id IS NULL)', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, color: 'Red', callsign_name_format: 'full_name' }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 1, color: 'Purple', callsign_name_format: 'first_initial_last' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const updated = await Team.update(1, {
        color: 'Purple',
        callsign_name_format: 'first_initial_last'
      });

      const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE teams'));
      const [, updateParams] = updateCall;
      expect(updateParams).toContain('Purple');
      expect(updateParams).toContain('first_initial_last');
      expect(updated.color).toBe('Purple');
      expect(updated.callsign_name_format).toBe('first_initial_last');
    });

    it('does not look up the existing team at all when neither color nor callsign_name_format is supplied', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 5, name: 'Renamed' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(5, { name: 'Renamed' });

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain('UPDATE teams');
    });
  });
});

/**
 * Regression tests for `Team.createTeamChannel`'s Authentik group
 * creation step (the bug behind "a team's primary channel shows an empty
 * Status column / no Synced badge even though nothing errored"):
 * previously the code never checked `groupResponse.ok` before calling
 * `.json()`, so a failed POST (e.g. 400 because a group with that exact
 * name already exists in Authentik -- easy to hit for a team whose
 * channel group was created out-of-band, or left over from an earlier
 * partially-failed run) silently produced `group.pk === undefined`,
 * which was inserted as `authentik_group_id = NULL` with no error ever
 * logged or thrown. The fix checks `.ok`, and on a non-ok response looks
 * up and reuses an existing group with the same name instead of treating
 * this as an unrecoverable failure.
 */
describe('Team.createTeamChannel Authentik group creation/reconciliation', () => {
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const teamRow = {
    id: 10,
    name: 'Fire and Emergency New Zealand (FENZ)',
    parent_team_id: null,
    root_prefix: 'FENZ',
    display_name: 'Fire and Emergency New Zealand (FENZ)'
  };

  it('reuses an existing Authentik group (looked up by name) and stores its pk, instead of leaving authentik_group_id NULL, when the create POST fails (e.g. 400 duplicate name)', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('WITH RECURSIVE root_team')) {
        return Promise.resolve({ rows: [teamRow] });
      }
      if (sql.includes('INSERT INTO channels')) {
        return Promise.resolve({ rows: [{ id: 3, authentik_group_id: 'existing-group-pk' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    global.fetch = jest.fn().mockImplementation((url, options) => {
      if (options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"name":["This field must be unique."]}')
        });
      }
      // GET lookup-by-name.
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          results: [{ pk: 'existing-group-pk', name: 'tak_Teams - FENZ' }]
        })
      });
    });

    const result = await Team.createTeamChannel(10);

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO channels'));
    expect(insertCall).toBeDefined();
    // authentik_group_id is the 5th positional parameter.
    expect(insertCall[1][4]).toBe('existing-group-pk');
    expect(result).toEqual({ id: 3, authentik_group_id: 'existing-group-pk' });

    // Logged as an informational reuse, not swallowed silently.
    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 10, groupId: 'existing-group-pk' }),
      'Reused existing Authentik group instead of creating a duplicate'
    );
  });

  it('falls back to a channel with no Authentik group (existing behavior) when the create POST fails AND no matching existing group can be found', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('WITH RECURSIVE root_team')) {
        return Promise.resolve({ rows: [teamRow] });
      }
      if (sql.includes('INSERT INTO channels')) {
        return Promise.resolve({ rows: [{ id: 3, authentik_group_id: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    global.fetch = jest.fn().mockImplementation((url, options) => {
      if (options?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('Internal error') });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
    });

    const result = await Team.createTeamChannel(10);

    // Falls all the way through to the outer catch's no-group-id insert.
    const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO channels'));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][0]).not.toContain('authentik_group_id');
    expect(result).toEqual({ id: 3, authentik_group_id: null });
  });

  it('creates a new group normally (no reuse path) when the create POST succeeds', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('WITH RECURSIVE root_team')) {
        return Promise.resolve({ rows: [teamRow] });
      }
      if (sql.includes('INSERT INTO channels')) {
        return Promise.resolve({ rows: [{ id: 3, authentik_group_id: 'new-group-pk' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ pk: 'new-group-pk' })
    });

    const result = await Team.createTeamChannel(10);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO channels'));
    expect(insertCall[1][4]).toBe('new-group-pk');
    expect(result).toEqual({ id: 3, authentik_group_id: 'new-group-pk' });
  });
});

/**
 * Unit tests for `Team.create`/`Team.update`'s `callsign_level_selection`
 * accept/validate/default/reject behaviour (Requirement 5.1/5.2/5.3/5.6,
 * task 8.1).
 *
 * `Team.create` must accept `callsign_level_selection` only for a root
 * (Organisation) team: default to `[1..MAX_TEAM_DEPTH]` when omitted,
 * validate every supplied element is an integer in [1, MAX_TEAM_DEPTH]
 * (throwing `Team.CallsignLevelSelectionRangeError` otherwise), and throw
 * `Team.CallsignLevelSelectionSubTeamError` when a value is supplied for
 * a Sub_Team (always storing NULL for a Sub_Team instead). `Team.update`
 * mirrors this: validates the range for an Organisation, and rejects any
 * supplied value for a Sub_Team.
 */
describe('Team.create / Team.update callsign_level_selection (Requirement 5.1/5.2/5.3/5.6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Team, 'createTeamChannel').mockResolvedValue({ id: 999 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Team.create', () => {
    it('defaults callsign_level_selection to [1,2,3,4,5] when omitted on Organisation creation', async () => {
      pool.query.mockResolvedValue({
        rows: [{ id: 1, name: 'FENZ', parent_team_id: null, callsign_level_selection: [1, 2, 3, 4, 5] }]
      });

      const team = await Team.create({ name: 'FENZ', parent_team_id: null });

      const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO teams'));
      expect(insertCall).toBeDefined();
      const [, params] = insertCall;
      expect(params).toEqual(expect.arrayContaining([[1, 2, 3, 4, 5]]));
      expect(team.callsign_level_selection).toEqual([1, 2, 3, 4, 5]);
    });

    it('stores a valid supplied callsign_level_selection on Organisation creation', async () => {
      pool.query.mockResolvedValue({
        rows: [{ id: 1, name: 'FENZ', parent_team_id: null, callsign_level_selection: [1, 3] }]
      });

      const team = await Team.create({ name: 'FENZ', parent_team_id: null, callsign_level_selection: [1, 3] });

      const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO teams'));
      const [, params] = insertCall;
      expect(params).toEqual(expect.arrayContaining([[1, 3]]));
      expect(team.callsign_level_selection).toEqual([1, 3]);
    });

    it('throws CallsignLevelSelectionRangeError for an out-of-range value (0) on Organisation creation, without inserting', async () => {
      await expect(
        Team.create({ name: 'FENZ', parent_team_id: null, callsign_level_selection: [0, 1] })
      ).rejects.toThrow(Team.CallsignLevelSelectionRangeError);

      const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO teams'));
      expect(insertCalls).toHaveLength(0);
    });

    it('throws CallsignLevelSelectionRangeError for an out-of-range value (6, above MAX_TEAM_DEPTH) on Organisation creation, without inserting', async () => {
      await expect(
        Team.create({ name: 'FENZ', parent_team_id: null, callsign_level_selection: [1, 6] })
      ).rejects.toThrow(Team.CallsignLevelSelectionRangeError);

      const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO teams'));
      expect(insertCalls).toHaveLength(0);
    });

    it('throws CallsignLevelSelectionRangeError for a non-integer element on Organisation creation', async () => {
      await expect(
        Team.create({ name: 'FENZ', parent_team_id: null, callsign_level_selection: [1.5] })
      ).rejects.toThrow(Team.CallsignLevelSelectionRangeError);
    });

    it('throws CallsignLevelSelectionSubTeamError when callsign_level_selection is supplied on Sub_Team creation, without inserting', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors') && sql.includes('MAX(hops_from_target) AS depth')) {
          return Promise.resolve({ rows: [{ depth: 0 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        Team.create({ name: 'Station 40', parent_team_id: 1, callsign_level_selection: [1, 2] })
      ).rejects.toThrow(Team.CallsignLevelSelectionSubTeamError);

      const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO teams'));
      expect(insertCalls).toHaveLength(0);
      expect(Team.createTeamChannel).not.toHaveBeenCalled();
    });

    it('succeeds with NULL callsign_level_selection when Sub_Team creation omits it', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors') && sql.includes('MAX(hops_from_target) AS depth')) {
          return Promise.resolve({ rows: [{ depth: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
          return Promise.resolve({
            rows: [{ id: 1, parent_team_id: null, color: 'Red', callsign_name_format: 'full_name', depth: 0 }]
          });
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO teams')) {
          return Promise.resolve({ rows: [{ id: 10, name: 'Station 40', parent_team_id: 1, callsign_level_selection: null }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const team = await Team.create({ name: 'Station 40', parent_team_id: 1 });

      const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO teams'));
      const [, params] = insertCall;
      expect(params).toEqual(expect.arrayContaining([null]));
      expect(team.callsign_level_selection).toBeNull();
    });
  });

  describe('Team.update', () => {
    it('updates callsign_level_selection on an Organisation with a valid value', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 1, callsign_level_selection: [2, 4] }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const updated = await Team.update(1, { callsign_level_selection: [2, 4] });

      const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE teams'));
      const [, params] = updateCall;
      expect(params).toEqual(expect.arrayContaining([[2, 4]]));
      expect(updated.callsign_level_selection).toEqual([2, 4]);
    });

    it('throws CallsignLevelSelectionRangeError for an out-of-range value on Organisation update, without updating', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        Team.update(1, { callsign_level_selection: [0] })
      ).rejects.toThrow(Team.CallsignLevelSelectionRangeError);

      const updateCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('UPDATE teams'));
      expect(updateCalls).toHaveLength(0);
    });

    it('throws CallsignLevelSelectionSubTeamError when callsign_level_selection is supplied on Sub_Team update, without updating', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: 3 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        Team.update(5, { callsign_level_selection: [1, 2] })
      ).rejects.toThrow(Team.CallsignLevelSelectionSubTeamError);

      const updateCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('UPDATE teams'));
      expect(updateCalls).toHaveLength(0);
    });

    it('leaves callsign_level_selection unchanged (via COALESCE) when omitted from the update, and does not look up the existing team', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 1, name: 'Renamed' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(1, { name: 'Renamed' });

      // No findById lookup when none of color/callsign_name_format/
      // callsign_level_selection is supplied.
      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('UPDATE teams');
      expect(params).toContain(undefined);
    });
  });
});

/**
 * Unit tests for `Team.getJoinableTeams` (Requirement 7.1/7.2, task 15.1).
 *
 * The public, unauthenticated team-access-request flow's joinable-teams
 * query must exclude a Team whose OWN `visibility` is `private`
 * (Requirement 7.1, already covered by the pre-existing
 * `t.visibility = 'public'` filter) AND exclude a Team whose
 * Ancestor_Chain contains a `private` Team, even when the Team itself is
 * `public` (Requirement 7.2, the new private-branch-cascade exclusion
 * added by this task). This method uses `pool.query` directly (not an
 * acquired transactional client), and returns `[]` on error -- both
 * matching this file's existing mocking convention and this method's own
 * pre-existing catch-and-log-and-return-empty-array behaviour, which
 * this task leaves unchanged.
 */
describe('Team.getJoinableTeams private-ancestor exclusion (Requirement 7.1/7.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes a public, can_join team with no private ancestor (regression)', async () => {
    const rows = [
      { id: 1, name: 'FENZ', description: null, visibility: 'public', display_name: 'FENZ' }
    ];
    pool.query.mockResolvedValue({ rows });

    const result = await Team.getJoinableTeams();

    expect(result).toEqual(rows);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    // Existing filter/shape must be preserved unchanged.
    expect(sql).toContain("t.can_join = true AND t.visibility = 'public'");
    expect(sql).toContain('ORDER BY display_name');
  });

  it('runs a single query whose SQL text includes a NOT EXISTS / recursive-ancestor private-visibility exclusion clause', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await Team.getJoinableTeams();

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('WITH RECURSIVE ancestors');
    expect(sql).toContain("anc.visibility = 'private'");
    // The exclusion walks strict ancestors of `t` (parent_team_id
    // upward), not `t` itself -- `t`'s own visibility is already
    // constrained to 'public' by the outer WHERE clause.
    expect(sql).toContain('SELECT parent_team_id FROM teams WHERE id = t.id');
  });

  /**
   * This test documents the INTENDED exclusion semantics at the SQL
   * level, since this method's own unit tests mock `pool.query` and
   * cannot execute the real recursive CTE against a database. The query
   * text assertions above confirm the clause exists in the right shape;
   * this test confirms the mocked row-shape contract callers rely on
   * (a Team with a private ancestor several levels up would simply never
   * appear in the mocked result set, exactly as it would never appear in
   * a real database's result set once the NOT EXISTS clause filters it
   * out row-by-row inside Postgres).
   */
  it('a public, can_join team with a private ancestor several levels up is excluded from the result set', async () => {
    // Simulated hierarchy: Org(1, public) -> Region(2, public) ->
    // District(3, private) -> Station(4, public, can_join). Station (4)
    // is itself public/can_join, but District (3) -- its parent -- is
    // private, so the NOT EXISTS clause excludes it: only the
    // unaffected, unrelated Team (5) is returned.
    const rows = [
      { id: 5, name: 'Unrelated Team', description: null, visibility: 'public', display_name: 'Unrelated Team' }
    ];
    pool.query.mockResolvedValue({ rows });

    const result = await Team.getJoinableTeams();

    expect(result).toEqual(rows);
    expect(result.find((team) => team.id === 4)).toBeUndefined();
  });

  it('a public, can_join team with an immediate private parent is excluded from the result set', async () => {
    // Simulated hierarchy: Org(1, public) -> PrivateUnit(2, private) ->
    // Sub(3, public, can_join). Sub (3)'s immediate parent is private, so
    // it is excluded; only the unrelated Team (6) is returned.
    const rows = [
      { id: 6, name: 'Another Team', description: null, visibility: 'public', display_name: 'Another Team' }
    ];
    pool.query.mockResolvedValue({ rows });

    const result = await Team.getJoinableTeams();

    expect(result).toEqual(rows);
    expect(result.find((team) => team.id === 3)).toBeUndefined();
  });

  it('returns an empty array (not a rejected promise) on a database error, matching the existing catch-and-log pattern', async () => {
    pool.query.mockRejectedValue(new Error('db unavailable'));

    const result = await Team.getJoinableTeams();

    expect(result).toEqual([]);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Error fetching joinable teams'
    );
  });
});
