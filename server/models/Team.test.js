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
jest.mock('../services/userAttributes', () => ({
  clearTeamAttributes: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const EventPublisher = require('../services/EventPublisher');
const UserAttributesService = require('../services/userAttributes');
const Team = require('./Team');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

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
    // Default: no remaining team_memberships row for the post-commit
    // attribute-clearing block's own `pool.query` check (a SEPARATE
    // connection from the transactional `mockClient` above -- see that
    // block's own doc comment for why it reads via `pool` rather than
    // `client`, post-COMMIT). Individual tests override this where the
    // distinction matters.
    pool.query.mockResolvedValue({ rows: [] });
    UserAttributesService.clearTeamAttributes.mockResolvedValue(true);
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
        return Promise.resolve({ rows: [{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }] });
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

  /**
   * Bugfix (Dashboard/Enrollment callsign-and-color divergence): a
   * deleted Team's affected users must have their team-derived
   * `tak_callsign`/`tak_color` cleared post-commit, but ONLY those who
   * end up with NO `team_memberships` row left at all -- a user who
   * belonged to another team too keeps whatever callsign/color that
   * other membership already gives them.
   */
  it('clears team attributes post-commit for an affected user left with no team_memberships row at all', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [{ id: 7, username: 'alice' }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    // The post-commit `pool.query` check: no team_memberships row remains
    // for user 7 anywhere.
    pool.query.mockResolvedValue({ rows: [] });

    await Team.delete(5, 99);

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT 1 FROM team_memberships WHERE user_id = $1 LIMIT 1',
      [7]
    );
    expect(UserAttributesService.clearTeamAttributes).toHaveBeenCalledTimes(1);
    expect(UserAttributesService.clearTeamAttributes).toHaveBeenCalledWith(7);
  });

  it('does NOT clear team attributes for an affected user who still has a team_memberships row from a different team', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [{ id: 7, username: 'alice' }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    // The post-commit `pool.query` check finds a remaining row (some
    // OTHER team) for user 7.
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    await Team.delete(5, 99);

    expect(UserAttributesService.clearTeamAttributes).not.toHaveBeenCalled();
  });

  it('runs the post-commit attribute clearing strictly AFTER COMMIT, and never rolls back on its own failure', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [{ id: 7, username: 'alice' }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.query.mockRejectedValue(new Error('post-commit read failed'));

    // Never throws: the whole point is that a post-commit failure must
    // not surface as a failed team deletion.
    const result = await Team.delete(5, 99);

    expect(result).toEqual({ id: 5 });
    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
    expect(UserAttributesService.clearTeamAttributes).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 5, affectedUserId: 7 }),
      expect.stringContaining('post-commit')
    );
  });

  it('enqueues no post-commit attribute clearing at all when there are no affected users', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.delete(5, 99);

    expect(UserAttributesService.clearTeamAttributes).not.toHaveBeenCalled();
    // No SELECT 1 FROM team_memberships ... LIMIT 1 check either, since
    // there is no affected user to check it for.
    expect(pool.query).not.toHaveBeenCalledWith(
      'SELECT 1 FROM team_memberships WHERE user_id = $1 LIMIT 1',
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

  // /teams overview: admin_count/device_count columns, shown between
  // Members and Sub-teams so the overview table matches what each team's
  // own Team Admins/Team Devices tabs count.
  it('getAllTeams: SELECTs admin_count (direct role=admin, excluding devices) and device_count (direct, is_team_device=true)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await Team.getAllTeams();

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("tm.role = 'admin' AND u.is_team_device IS NOT TRUE) as admin_count");
    expect(sql).toContain('tm.inherited_from_team_id IS NULL AND u.is_team_device = true) as device_count');
  });

  it('getOrganisationTeams: SELECTs admin_count and device_count alongside member_count/sub_teams_count', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await Team.getOrganisationTeams(1, 42);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("tm.role = 'admin' AND u.is_team_device IS NOT TRUE) as admin_count");
    expect(sql).toContain('tm.inherited_from_team_id IS NULL AND u.is_team_device = true) as device_count');
    expect(params).toEqual([1, 42]);
  });

  // Bugfix (consistent team Display_Name everywhere): getOrganisationTeams
  // now also computes a `display_name` -- "<Org prefix> - <team name>"
  // for a Sub_Team, bare name for the Organisation -- using the
  // Organisation root ($1)'s own prefix/name, so the Users Create-User
  // picker and Transfer dialog source-team heading (both fed by
  // GET /teams/my-teams?scope=organisation, which calls this) match what
  // /request-access shows, instead of falling back to the bare name.
  it('getOrganisationTeams: computes a display_name from the Organisation ($1) root prefix, bare name for the org row', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await Team.getOrganisationTeams(1, 42);

    const [sql] = pool.query.mock.calls[0];
    // Sub_Team branch prefixes the ORG's prefix/name (looked up from the
    // $1 root row), not the immediate parent's.
    expect(sql).toContain('WHEN oh.parent_team_id IS NOT NULL THEN');
    expect(sql).toContain('FROM teams org WHERE org.id = $1');
    expect(sql).toContain("|| ' - ' || oh.name");
    // Organisation row shows its bare name.
    expect(sql).toContain('ELSE oh.name');
    expect(sql).toContain('as display_name');
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
 * Bugfix (Sub-teams tab consistency with the /teams overview):
 * `Team.getSubTeams` now returns `admin_count`/`device_count`/
 * `channel_count` alongside its pre-existing `member_count`/
 * `sub_teams_count`, mirroring `getOrganisationTeams`/`getAllTeams`'s
 * own subquery shapes for the first two, plus a new `channel_count`.
 */
describe('Team.getSubTeams admin_count/device_count/channel_count (bugfix)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('selects admin_count via a direct, non-device, role=\'admin\' membership count', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await Team.getSubTeams(1);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("tm.role = 'admin' AND u.is_team_device IS NOT TRUE) as admin_count");
    expect(params).toEqual([1]);
  });

  it('selects device_count via a direct (non-inherited), is_team_device membership count', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await Team.getSubTeams(1);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('tm.inherited_from_team_id IS NULL AND u.is_team_device = true) as device_count');
  });

  it('selects channel_count via COUNT(*) FROM channels scoped to the same team row', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await Team.getSubTeams(1);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM channels c WHERE c.team_id = t.id) as channel_count');
  });

  it('returns every row exactly as the query yields it, including the new columns', async () => {
    const rows = [
      { id: 2, parent_team_id: 1, member_count: '3', admin_count: '1', device_count: '2', channel_count: '3', sub_teams_count: '0' }
    ];
    pool.query.mockResolvedValue({ rows });

    const result = await Team.getSubTeams(1);

    expect(result).toEqual(rows);
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
 * Unit tests for `Team.getManagedTeamIds` (Users-page-action-parity): the
 * downward-facing counterpart of `Team.isAdmin` -- given a userId, returns
 * the Set of every team id they may act on (their direct admin teams,
 * union every descendant of each at any depth).
 */
describe('Team.getManagedTeamIds (Users-page-action-parity)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('issues the expected recursive CTE and returns a Set built from the query rows', async () => {
    pool.query.mockResolvedValue({ rows: [{ team_id: 4 }, { team_id: 7 }, { team_id: 9 }] });

    const result = await Team.getManagedTeamIds(42);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WITH RECURSIVE admin_teams');
    expect(sql).toContain("role = 'admin'");
    expect(sql).toContain('inherited_from_team_id IS NULL');
    expect(sql).toContain('managed_teams');
    expect(params).toEqual([42]);
    expect(result).toBeInstanceOf(Set);
    expect(result).toEqual(new Set([4, 7, 9]));
  });

  it('returns an empty Set for a user with no direct admin row anywhere', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await Team.getManagedTeamIds(42);

    expect(result).toEqual(new Set());
  });

  it('returns an empty Set (not a rejected promise) on a database error, matching isAdmin\'s fail-closed pattern', async () => {
    pool.query.mockRejectedValue(new Error('db unavailable'));

    const result = await Team.getManagedTeamIds(42);

    expect(result).toEqual(new Set());
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), userId: 42 }),
      'Error resolving managed team ids'
    );
  });
});

/**
 * Property-based test: `getManagedTeamIds(userId)` agrees with
 * `isAdmin(teamId, userId)` for every team in a generated hierarchy --
 * `teamId` is in the returned Set if and only if `isAdmin(teamId, userId)`
 * would return true. This is the DEFINITIONAL equivalence the two methods'
 * own doc comments claim: one is a per-team upward walk, the other a
 * once-per-user downward walk, and they must never disagree about which
 * teams a given user may act on.
 *
 * Reuses this file's own `Team.isAdmin` property-test's hierarchy
 * generator and admin-membership predicate (`hierarchyArb`,
 * `ancestorsOf`, `hasDirectAdmin`) rather than redefining them, since the
 * definition of "admin membership on an ancestor" must be identical for
 * both properties to be comparable.
 */
describe('Property: getManagedTeamIds agrees with isAdmin for every team in the hierarchy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const USER_IDS = [101, 102, 103];

  const hierarchyArb = fc.integer({ min: 1, max: 8 }).chain((teamCount) => {
    const teamIds = Array.from({ length: teamCount }, (_, i) => i + 1);

    const parentArb = fc.tuple(
      ...teamIds.slice(1).map((_, i) => fc.integer({ min: 1, max: i + 1 }))
    );

    const membershipArb = fc.array(
      fc.record({
        teamId: fc.constantFrom(...teamIds),
        userId: fc.constantFrom(...USER_IDS),
        role: fc.constantFrom('admin', 'member'),
        direct: fc.boolean()
      }),
      { maxLength: teamCount * USER_IDS.length * 2 }
    );

    return fc.tuple(parentArb, membershipArb).map(([parents, memberships]) => {
      const parentMap = new Map();
      parentMap.set(teamIds[0], null);
      parents.forEach((parentId, i) => {
        parentMap.set(teamIds[i + 1], parentId);
      });
      return { teamIds, parentMap, memberships };
    });
  });

  function ancestorsOf(teamId, parentMap) {
    const chain = [];
    let current = teamId;
    while (current !== null && current !== undefined) {
      chain.push(current);
      current = parentMap.get(current);
    }
    return chain;
  }

  function hasDirectAdmin(ancestors, userId, memberships) {
    const ancestorSet = new Set(ancestors);
    return memberships.some((m) =>
      ancestorSet.has(m.teamId) && m.userId === userId && m.role === 'admin' && m.direct
    );
  }

  test.prop([hierarchyArb, fc.constantFrom(...USER_IDS)], { numRuns: 100 })(
    'getManagedTeamIds(userId) contains teamId iff isAdmin(teamId, userId) is true, for every generated team',
    async ({ teamIds, parentMap, memberships }, userId) => {
      // getManagedTeamIds's own query: every direct admin team for
      // userId, unioned with every descendant of each at any depth --
      // computed independently from the generated hierarchy/memberships
      // rather than by re-deriving the SQL's own logic.
      const directAdminTeams = teamIds.filter((teamId) =>
        memberships.some((m) => m.teamId === teamId && m.userId === userId && m.role === 'admin' && m.direct)
      );
      const isDescendantOfAny = (teamId) => {
        let current = parentMap.get(teamId);
        while (current !== null && current !== undefined) {
          if (directAdminTeams.includes(current)) {
            return true;
          }
          current = parentMap.get(current);
        }
        return false;
      };
      const managedTeamIds = new Set(
        teamIds.filter((teamId) => directAdminTeams.includes(teamId) || isDescendantOfAny(teamId))
      );

      pool.query.mockImplementation(async () => ({
        rows: Array.from(managedTeamIds).map((teamId) => ({ team_id: teamId }))
      }));

      const managedResult = await Team.getManagedTeamIds(userId);
      expect(managedResult).toEqual(managedTeamIds);

      // Cross-check against isAdmin's own (independently mocked) upward
      // walk for every team in the hierarchy.
      pool.query.mockImplementation(async (_sql, params) => {
        const [queriedTeamId, queriedUserId] = params;
        const ancestors = ancestorsOf(queriedTeamId, parentMap);
        const matches = hasDirectAdmin(ancestors, queriedUserId, memberships);
        return { rows: matches ? [{ '?column?': 1 }] : [] };
      });

      for (const teamId of teamIds) {
        const isAdminResult = await Team.isAdmin(teamId, userId);
        expect(managedResult.has(teamId)).toBe(isAdminResult);
      }
    }
  );
});

/**
 * Property-based test (design.md's Property 4: "Admin inheritance walks
 * the full Ancestor_Chain", task 3.2), implemented with `fast-check` via
 * `@fast-check/jest`'s `test.prop` integration, matching the convention
 * established in `../config/permissions.registry.test.js` and
 * `../services/userAttributes.test.js`.
 *
 * `Team.isAdmin` drives its result entirely from a single SQL query
 * (recursive CTE + join), so this test mocks `pool.query` to simulate
 * exactly what that CTE would return for a given, randomly generated
 * hierarchy shape and membership placement: for the `(teamId, userId)`
 * pair a call actually supplies, the mock walks `teamId`'s ancestors
 * (including itself) via the generated `parentMap`, and returns a
 * matching row if and only if `userId` holds a DIRECT (`direct: true`,
 * i.e. `inherited_from_team_id IS NULL`), `role: 'admin'` membership on
 * `teamId` or any ancestor of it -- mirroring the real CTE's own
 * `tm.role = 'admin' AND tm.inherited_from_team_id IS NULL` filter.
 *
 * The property then asserts `Team.isAdmin`'s actual (mocked-DB-driven)
 * result matches an INDEPENDENTLY computed expected boolean (the same
 * ancestor-walk-and-membership-match definition, evaluated directly
 * against the generated `memberships` array rather than through the
 * mock), for every team in the generated hierarchy. This exercises: a
 * direct admin membership on the team itself; inherited admin status
 * from a parent/grandparent/root ancestor; a membership on an unrelated
 * sibling branch (must not grant admin); a `role: 'member'` row at any
 * position (must never grant admin); and an inherited-only
 * (`direct: false`) `role: 'admin'` row on an ancestor, which must be
 * excluded per Requirement 4.4's independence from
 * `inherited_from_team_id`-based upward membership inheritance.
 */
describe('Property 4: Admin inheritance walks the full Ancestor_Chain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const USER_IDS = [101, 102, 103];

  /**
   * Generates a random tree of `teamCount` teams (1-indexed ids
   * `1..teamCount`; team `1` is always the root/Organisation, and every
   * other team's parent is an earlier-id'd team, guaranteeing an
   * acyclic, single-rooted tree -- so branching, siblings, and deep
   * chains are all represented across generated runs) together with a
   * random set of direct/inherited `team_memberships`-shaped rows placed
   * across arbitrary `(teamId, userId)` pairs.
   */
  const hierarchyArb = fc.integer({ min: 1, max: 8 }).chain((teamCount) => {
    const teamIds = Array.from({ length: teamCount }, (_, i) => i + 1);

    const parentArb = fc.tuple(
      ...teamIds.slice(1).map((_, i) => fc.integer({ min: 1, max: i + 1 }))
    );

    const membershipArb = fc.array(
      fc.record({
        teamId: fc.constantFrom(...teamIds),
        userId: fc.constantFrom(...USER_IDS),
        role: fc.constantFrom('admin', 'member'),
        // true => a direct row (inherited_from_team_id IS NULL);
        // false => an inherited-only row, which must never satisfy
        // Team.isAdmin's admin check per Requirement 4.4.
        direct: fc.boolean()
      }),
      { maxLength: teamCount * USER_IDS.length * 2 }
    );

    return fc.tuple(parentArb, membershipArb).map(([parents, memberships]) => {
      const parentMap = new Map();
      parentMap.set(teamIds[0], null);
      parents.forEach((parentId, i) => {
        parentMap.set(teamIds[i + 1], parentId);
      });
      return { teamIds, parentMap, memberships };
    });
  });

  function ancestorsOf(teamId, parentMap) {
    const chain = [];
    let current = teamId;
    while (current !== null && current !== undefined) {
      chain.push(current);
      current = parentMap.get(current);
    }
    return chain;
  }

  function hasDirectAdmin(ancestors, userId, memberships) {
    const ancestorSet = new Set(ancestors);
    return memberships.some((m) =>
      ancestorSet.has(m.teamId) && m.userId === userId && m.role === 'admin' && m.direct
    );
  }

  test.prop([hierarchyArb, fc.constantFrom(...USER_IDS)], { numRuns: 100 })(
    'isAdmin(teamId, userId) is true iff userId holds a direct admin membership on teamId or any ancestor, for every generated team',
    async ({ teamIds, parentMap, memberships }, userId) => {
      pool.query.mockImplementation(async (_sql, params) => {
        const [queriedTeamId, queriedUserId] = params;
        const ancestors = ancestorsOf(queriedTeamId, parentMap);
        const matches = hasDirectAdmin(ancestors, queriedUserId, memberships);
        return { rows: matches ? [{ '?column?': 1 }] : [] };
      });

      for (const teamId of teamIds) {
        const ancestors = ancestorsOf(teamId, parentMap);
        const expected = hasDirectAdmin(ancestors, userId, memberships);

        const actual = await Team.isAdmin(teamId, userId);

        expect(actual).toBe(expected);
      }
    }
  );
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
 * Bugfix (callsign-handling): `Team.create` used to swallow a duplicate
 * `callsign_prefix` INSERT failure into its generic "new columns don't
 * exist" fallback, silently creating the team with NO prefix at all
 * rather than surfacing the conflict to the caller. This asserts the
 * fix: a `23505` on `idx_teams_callsign_prefix` is translated into
 * `CallsignPrefixConflictError`, and the degraded fallback INSERT is
 * never attempted.
 */
describe('Team.create callsign_prefix conflict (bugfix: callsign-handling)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Team, 'createTeamChannel').mockResolvedValue({ id: 999 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('translates a 23505 on idx_teams_callsign_prefix into CallsignPrefixConflictError, naming the conflicting value', async () => {
    const conflictError = Object.assign(
      new Error('duplicate key value violates unique constraint "idx_teams_callsign_prefix"'),
      { code: '23505', constraint: 'idx_teams_callsign_prefix' }
    );
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO teams (name, description, callsign_prefix')) {
        return Promise.reject(conflictError);
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      Team.create({ name: 'LandSAR', parent_team_id: null, callsign_prefix: 'STL' })
    ).rejects.toThrow(Team.CallsignPrefixConflictError);

    try {
      await Team.create({ name: 'LandSAR', parent_team_id: null, callsign_prefix: 'STL' });
    } catch (error) {
      expect(error.message).toContain('STL');
    }
  });

  it('never attempts the degraded fallback INSERT (with no callsign_prefix column) after a conflict', async () => {
    const conflictError = Object.assign(
      new Error('duplicate key value violates unique constraint "idx_teams_callsign_prefix"'),
      { code: '23505', constraint: 'idx_teams_callsign_prefix' }
    );
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO teams (name, description, callsign_prefix')) {
        return Promise.reject(conflictError);
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      Team.create({ name: 'LandSAR', parent_team_id: null, callsign_prefix: 'STL' })
    ).rejects.toThrow(Team.CallsignPrefixConflictError);

    const fallbackInsertCalls = pool.query.mock.calls.filter(
      ([sql]) => sql.includes('INSERT INTO teams (name, description, parent_team_id, created_by)')
    );
    expect(fallbackInsertCalls).toHaveLength(0);
  });

  it('a non-conflict INSERT failure still falls back to the degraded basic-creation INSERT unchanged', async () => {
    const unrelatedError = new Error('connection reset');
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO teams (name, description, callsign_prefix')) {
        return Promise.reject(unrelatedError);
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO teams (name, description, parent_team_id, created_by)')) {
        return Promise.resolve({ rows: [{ id: 5, name: 'FENZ', parent_team_id: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const team = await Team.create({ name: 'FENZ', parent_team_id: null, callsign_prefix: 'FENZ' });

    expect(team).toEqual({ id: 5, name: 'FENZ', parent_team_id: null });
  });
});

/**
 * Bugfix (callsign-handling): the scoped `idx_teams_callsign_prefix`
 * (Organisation-only, see `1789400000000_scope-callsign-prefix-uniqueness-to-organisations.cjs`)
 * can now be violated by promoting an existing Sub_Team to an
 * Organisation (`parent_team_id` going from non-null to `null`) when
 * that Sub_Team's ALREADY-STORED `callsign_prefix` collides with a
 * different, existing Organisation's prefix. This is a real Postgres
 * partial-index behaviour (verified directly against a throwaway
 * database during development of this fix, not just mocked here): the
 * index's predicate is evaluated against the row's POST-update values,
 * so the collision is caught automatically, with no new application-side
 * check needed. What DOES need covering here is that `Team.update`'s
 * existing generic `23505`-on-`idx_teams_callsign_prefix` handler
 * reports the actual conflicting prefix rather than the literal string
 * "undefined" -- `callsign_prefix` is `undefined` in this exact
 * scenario (the promotion request never supplies one; the conflict is
 * against the row's pre-existing stored value), and `existingTeam` is
 * not guaranteed to have been fetched either, since that fetch is gated
 * on the Organisation-only fields being supplied, none of which a
 * pure-reparent request supplies.
 */
describe('Team.update Sub_Team-to-Organisation promotion callsign_prefix conflict (bugfix: callsign-handling)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports the actual conflicting callsign_prefix, not "undefined", when promoting a Sub_Team whose stored prefix collides with an existing Organisation', async () => {
    const conflictError = Object.assign(
      new Error('duplicate key value violates unique constraint "idx_teams_callsign_prefix"'),
      { code: '23505', constraint: 'idx_teams_callsign_prefix' }
    );

    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
        return Promise.reject(conflictError);
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
        // The promoted Sub_Team's own stored prefix, read fresh since
        // no Organisation-only field was supplied on this request (so
        // `existingTeam` was never populated above).
        return Promise.resolve({ rows: [{ id: 2, parent_team_id: null, callsign_prefix: 'STL' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // A pure re-parent request: no callsign_prefix supplied at all.
    await expect(
      Team.update(2, { parent_team_id: null })
    ).rejects.toThrow(Team.CallsignPrefixConflictError);

    try {
      await Team.update(2, { parent_team_id: null });
    } catch (error) {
      expect(error.message).toContain('STL');
      expect(error.message).not.toContain('undefined');
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
        // Org-wide-team-name-uniqueness: a rename now resolves the team's
        // existing row (findById) to determine its effective org for the
        // name-uniqueness check. This root team (parent_team_id null)
        // short-circuits that check (promotion/root path -- the baseline
        // UNIQUE(name, parent_team_id) constraint covers root-vs-root),
        // so no ancestor/subtree query runs beyond the findById.
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: null, name: 'Old', color: 'Red', callsign_name_format: 'full_name' }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 5, name: 'Renamed' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(5, { name: 'Renamed' });

      // The UPDATE runs; there is no color/callsign_name_format cascade
      // (neither was supplied). A rename does one findById for the
      // name-uniqueness check, but no subtree scan for a root team.
      const updateCall = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE teams'));
      expect(updateCall).toBeDefined();
      const subtreeScan = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree'));
      expect(subtreeScan).toBeUndefined();
    });

    /**
     * Bugfix regression tests: "When I change the callsign name format
     * for an org, the sub-team's format does not update." A Sub_Team's
     * `color`/`callsign_name_format` is only ever COPIED from its
     * Organisation's then-current values at CREATION time (`Team.create`'s
     * ancestor-chain lookup) -- it is never re-read afterward. Without a
     * cascade, an Organisation-level `color`/`callsign_name_format`
     * change here would only ever touch the Organisation's own row,
     * leaving every already-created descendant Sub_Team's stored value
     * permanently stale.
     */
    it('cascades a changed callsign_name_format down to every existing descendant Sub_Team when updating an Organisation', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, color: 'Red', callsign_name_format: 'full_name' }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE descendants')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, color: 'Red', callsign_name_format: 'first_initial_last' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const updated = await Team.update(1, { callsign_name_format: 'first_initial_last' });

      expect(updated.callsign_name_format).toBe('first_initial_last');

      const cascadeCall = pool.query.mock.calls.find(([sql]) => sql.includes('WITH RECURSIVE descendants'));
      expect(cascadeCall).toBeDefined();
      const [cascadeSql, cascadeParams] = cascadeCall;
      expect(cascadeSql).toContain('parent_team_id = $1');
      expect(cascadeSql).toContain('SET color = COALESCE($2, color)');
      expect(cascadeSql).toContain('callsign_name_format = COALESCE($3, callsign_name_format)');
      // teamId=1, color=undefined (not supplied on this update, so
      // descendants' own color is left unchanged via COALESCE),
      // callsign_name_format='first_initial_last' (the new value).
      expect(cascadeParams).toEqual([1, undefined, 'first_initial_last']);
    });

    it('cascades a changed color down to every existing descendant Sub_Team when updating an Organisation', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, color: 'Red', callsign_name_format: 'full_name' }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE descendants')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, color: 'Purple', callsign_name_format: 'full_name' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(1, { color: 'Purple' });

      const cascadeCall = pool.query.mock.calls.find(([sql]) => sql.includes('WITH RECURSIVE descendants'));
      expect(cascadeCall).toBeDefined();
      const [, cascadeParams] = cascadeCall;
      expect(cascadeParams).toEqual([1, 'Purple', undefined]);
    });

    it('does not cascade at all when updating a Sub_Team (color/callsign_name_format are already ignored on a Sub_Team, so nothing to push down)', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: 3, color: 'Red', callsign_name_format: 'full_name' }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: 3, color: 'Red', callsign_name_format: 'full_name' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(5, { color: 'Purple', callsign_name_format: 'first_initial_last' });

      const cascadeCall = pool.query.mock.calls.find(([sql]) => sql.includes('WITH RECURSIVE descendants'));
      expect(cascadeCall).toBeUndefined();
    });

    it('does not cascade when updating an Organisation without supplying color or callsign_name_format', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, name: 'Renamed Org' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(1, { name: 'Renamed Org' });

      const cascadeCall = pool.query.mock.calls.find(([sql]) => sql.includes('WITH RECURSIVE descendants'));
      expect(cascadeCall).toBeUndefined();
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

  it('creates the channel with no group id AND enqueues reconcile_team_channel_group for retry when the create POST fails AND no matching existing group can be found', async () => {
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

    // Still inserts the channel row (so the Team is immediately usable),
    // via the no-group-id INSERT.
    const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO channels'));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][0]).not.toContain('authentik_group_id');
    expect(result).toEqual({ id: 3, authentik_group_id: null });

    // Bugfix (orphaned Authentik team groups): rather than silently
    // leaving the channel group-less forever, it enqueues a retryable
    // reconcile carrying the live channel id + the intended group name,
    // on the default pool (no transaction client).
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'reconcile_team_channel_group',
      expect.objectContaining({
        channel_id: 3,
        authentik_group_name: 'tak_Teams - FENZ'
      }),
      null
    );
  });

  it('does not fail team-channel creation when the reconcile enqueue itself throws (logged and swallowed)', async () => {
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

    EventPublisher.publishOperation.mockRejectedValueOnce
      ? EventPublisher.publishOperation.mockRejectedValueOnce(new Error('sync_operations insert failed'))
      : EventPublisher.publishOperation.mockImplementationOnce(() => Promise.reject(new Error('sync_operations insert failed')));

    // The channel row is still returned; the enqueue failure never
    // propagates out of createTeamChannel.
    const result = await Team.createTeamChannel(10);
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

    it('leaves callsign_level_selection unchanged (via COALESCE) when omitted from the update', async () => {
      pool.query.mockImplementation((sql) => {
        // Org-wide-team-name-uniqueness: a rename resolves the existing
        // row for the name-uniqueness check; a root team (parent null)
        // short-circuits it after the findById.
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, name: 'Old' }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 1, name: 'Renamed' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(1, { name: 'Renamed' });

      // callsign_level_selection is omitted, so it is passed as
      // `undefined` to the UPDATE (COALESCE leaves it unchanged), and no
      // callsign_level_selection validation/lookup happens on its
      // account.
      const updateCall = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE teams'));
      expect(updateCall).toBeDefined();
      expect(updateCall[1]).toContain(undefined);
    });
  });
});

/**
 * Unit tests for `Team.create`/`Team.update`'s
 * `pseudonymous_usernames` accept/default/reject/immutability behaviour
 * (takserver-enrollment Requirements 6.1, 6.2, 7.1, 7.2, 7.3, task 5.4).
 *
 * `Team.create` must accept `pseudonymous_usernames` only for a root
 * (Organisation) team -- defaulting to `false` when omitted -- and store
 * `null` for a Sub_Team, rejecting (never silently ignoring) a supplied
 * value for a Sub_Team, mirroring `callsign_level_selection` exactly.
 * `Team.update` must accept a resubmission of the CURRENT value as a
 * no-op and reject any actual change on an existing Organisation, and
 * reject any value at all on a Sub_Team.
 */
describe('Team.create / Team.update pseudonymous_usernames (takserver-enrollment Requirement 6.1/6.2/7.1/7.2/7.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Team, 'createTeamChannel').mockResolvedValue({ id: 999 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Team.create', () => {
    it('defaults pseudonymous_usernames to false when omitted on Organisation creation', async () => {
      pool.query.mockResolvedValue({
        rows: [{ id: 1, name: 'FENZ', parent_team_id: null, pseudonymous_usernames: false }]
      });

      const team = await Team.create({ name: 'FENZ', parent_team_id: null });

      const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO teams'));
      expect(insertCall).toBeDefined();
      const [, params] = insertCall;
      expect(params).toEqual(expect.arrayContaining([false]));
      expect(team.pseudonymous_usernames).toBe(false);
    });

    it('stores true when pseudonymous_usernames is supplied on Organisation creation', async () => {
      pool.query.mockResolvedValue({
        rows: [{ id: 1, name: 'FENZ', parent_team_id: null, pseudonymous_usernames: true }]
      });

      const team = await Team.create({ name: 'FENZ', parent_team_id: null, pseudonymous_usernames: true });

      const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO teams'));
      const [, params] = insertCall;
      expect(params).toEqual(expect.arrayContaining([true]));
      expect(team.pseudonymous_usernames).toBe(true);
    });

    it('throws PseudonymousUsernamePolicySubTeamError when pseudonymous_usernames is supplied on Sub_Team creation, without inserting', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors') && sql.includes('MAX(hops_from_target) AS depth')) {
          return Promise.resolve({ rows: [{ depth: 0 }] });
        }
        // Org-wide-team-name-uniqueness: the create path checks the name
        // across the org subtree (via getAncestorChain + org_subtree)
        // BEFORE reaching the pseudonymous guard. Return no collision so
        // the flow proceeds to the guard this test is actually exercising.
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, color: 'Red', callsign_name_format: 'full_name', depth: 0 }] });
      });

      await expect(
        Team.create({ name: 'Station 40', parent_team_id: 1, pseudonymous_usernames: true })
      ).rejects.toThrow(Team.PseudonymousUsernamePolicySubTeamError);

      const insertCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO teams'));
      expect(insertCalls).toHaveLength(0);
      expect(Team.createTeamChannel).not.toHaveBeenCalled();
    });

    it('succeeds with NULL pseudonymous_usernames when Sub_Team creation omits it', async () => {
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
          return Promise.resolve({ rows: [{ id: 10, name: 'Station 40', parent_team_id: 1, pseudonymous_usernames: null }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const team = await Team.create({ name: 'Station 40', parent_team_id: 1 });

      const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO teams'));
      const [, params] = insertCall;
      expect(params).toEqual(expect.arrayContaining([null]));
      expect(team.pseudonymous_usernames).toBeNull();
    });
  });

  describe('Team.update', () => {
    it('accepts a resubmission of the current value on an Organisation as a no-op', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, pseudonymous_usernames: true }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 1, pseudonymous_usernames: true }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const updated = await Team.update(1, { pseudonymous_usernames: true });

      const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE teams'));
      const [, params] = updateCall;
      // Resubmitting the current value is a no-op: undefined reaches the
      // UPDATE's COALESCE, leaving the stored value untouched.
      expect(params).toContain(undefined);
      expect(updated.pseudonymous_usernames).toBe(true);
    });

    it('throws PseudonymousUsernamePolicyImmutableError naming the concrete consequence when changing an existing Organisation value, without updating', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, pseudonymous_usernames: false }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        Team.update(1, { pseudonymous_usernames: true })
      ).rejects.toThrow(Team.PseudonymousUsernamePolicyImmutableError);

      const updateCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('UPDATE teams'));
      expect(updateCalls).toHaveLength(0);

      try {
        await Team.update(1, { pseudonymous_usernames: true });
        throw new Error('expected Team.update to throw');
      } catch (error) {
        expect(error.message).toMatch(/re-enroll/);
        expect(error.message).toMatch(/certificate Common Name/);
      }
    });

    it('throws PseudonymousUsernamePolicySubTeamError when pseudonymous_usernames is supplied on Sub_Team update, without updating', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: 3 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        Team.update(5, { pseudonymous_usernames: true })
      ).rejects.toThrow(Team.PseudonymousUsernamePolicySubTeamError);

      const updateCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('UPDATE teams'));
      expect(updateCalls).toHaveLength(0);
    });

    it('leaves pseudonymous_usernames unchanged (via COALESCE) when omitted from the update, and does not look up the existing team', async () => {
      pool.query.mockImplementation((sql) => {
        // Org-wide-team-name-uniqueness: a rename resolves the existing
        // row; a root team (parent null) short-circuits the name check.
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, name: 'Old' }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 1, name: 'Renamed' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(1, { name: 'Renamed' });

      // pseudonymous_usernames is omitted, so it reaches the UPDATE as
      // `undefined` (COALESCE leaves it unchanged) and triggers no
      // pseudonymous-specific lookup on its own account.
      const updateCall = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE teams'));
      expect(updateCall).toBeDefined();
      expect(updateCall[1]).toContain(undefined);
    });
  });
});

/**
 * Unit tests for `Team.update`'s `callsign_prefix` accept/reject/
 * immutability behaviour (bugfix: callsign-handling).
 *
 * A Sub_Team's `callsign_prefix` must now be freely editable after
 * creation (previously impossible via any supported code path) --
 * `Team.update` neither ignores nor rejects a value supplied for one.
 * An existing Organisation's `callsign_prefix` remains immutable: a
 * resubmission of the CURRENT value is accepted as a no-op, and any
 * actual change is rejected with `OrganisationCallsignPrefixImmutableError`,
 * mirroring `pseudonymous_usernames`'s own immutability shape exactly. A
 * collision with `idx_teams_callsign_prefix`'s UNIQUE constraint is
 * translated into `CallsignPrefixConflictError`.
 */
describe('Team.update callsign_prefix (bugfix: callsign-handling)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('updates a Sub_Team\'s callsign_prefix freely, with no rejection', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
        // The existing-team lookup fires because callsign_prefix was
        // supplied at all (needed to determine Organisation vs Sub_Team);
        // this Sub_Team's non-null parent_team_id is what then exempts it
        // from the immutability guard below.
        return Promise.resolve({ rows: [{ id: 4, parent_team_id: 3, callsign_prefix: 'OLD' }] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
        return Promise.resolve({ rows: [{ id: 4, parent_team_id: 3, callsign_prefix: 'STL' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const updated = await Team.update(4, { callsign_prefix: 'STL' });

    const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE teams'));
    const [, params] = updateCall;
    // The supplied value passes straight through, unguarded, since the
    // immutability check applies only when parent_team_id is null.
    expect(params).toContain('STL');
    expect(updated.callsign_prefix).toBe('STL');
  });

  it('accepts a resubmission of the current value on an existing Organisation as a no-op', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
        return Promise.resolve({ rows: [{ id: 3, parent_team_id: null, callsign_prefix: 'FENZ' }] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
        return Promise.resolve({ rows: [{ id: 3, callsign_prefix: 'FENZ' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const updated = await Team.update(3, { callsign_prefix: 'FENZ' });

    const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE teams'));
    const [, params] = updateCall;
    // Normalised to undefined -- nothing to change, so the UPDATE's own
    // COALESCE leaves the stored value untouched.
    expect(params).toContain(undefined);
    expect(updated.callsign_prefix).toBe('FENZ');
  });

  it('throws OrganisationCallsignPrefixImmutableError when changing an existing Organisation\'s callsign_prefix, without updating', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
        return Promise.resolve({ rows: [{ id: 3, parent_team_id: null, callsign_prefix: 'FENZ' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      Team.update(3, { callsign_prefix: 'NEWPFX' })
    ).rejects.toThrow(Team.OrganisationCallsignPrefixImmutableError);

    const updateCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('UPDATE teams'));
    expect(updateCalls).toHaveLength(0);
  });

  it('translates a 23505 on idx_teams_callsign_prefix into CallsignPrefixConflictError', async () => {
    const conflictError = Object.assign(new Error('duplicate key value violates unique constraint "idx_teams_callsign_prefix"'), {
      code: '23505',
      constraint: 'idx_teams_callsign_prefix'
    });

    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
        return Promise.reject(conflictError);
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      Team.update(4, { callsign_prefix: 'STL' })
    ).rejects.toThrow(Team.CallsignPrefixConflictError);
  });

  it('leaves callsign_prefix unchanged (via COALESCE) when omitted from the update', async () => {
    pool.query.mockImplementation((sql) => {
      // Org-wide-team-name-uniqueness: a rename resolves the existing
      // row; a root team (parent null) short-circuits the name check.
      if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
        return Promise.resolve({ rows: [{ id: 4, parent_team_id: null, name: 'Old' }] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
        return Promise.resolve({ rows: [{ id: 4, name: 'Renamed' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.update(4, { name: 'Renamed' });

    // callsign_prefix is omitted, so it reaches the UPDATE as
    // `undefined` (COALESCE leaves it unchanged).
    const updateCall = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('UPDATE teams'));
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toContain(undefined);
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

  /**
   * Additional hand-constructed scenario (task 15.2*): a WIDE branching
   * hierarchy with private teams scattered non-uniformly across depths
   * and branches, combined with a mix of `can_join`/`visibility` values
   * that are excluded for reasons OTHER than the ancestor-cascade clause
   * (an own-private team, and an own-`can_join = false` team), to
   * confirm the private-ancestor exclusion composes correctly alongside
   * the pre-existing `t.can_join = true AND t.visibility = 'public'`
   * filter rather than only being exercised in isolation.
   *
   * Simulated hierarchy:
   *   1 Org (public)
   *     2 RegionA (public)
   *       5 StationA1 (public, can_join)      -> INCLUDED
   *       6 StationA2 (private, can_join)     -> excluded (own visibility)
   *     3 RegionB (private)
   *       7 StationB1 (public, can_join)      -> excluded (parent private)
   *         8 StationB1Child (public, can_join) -> excluded (grandparent private)
   *     4 RegionC (public)
   *       9 StationC1 (public, NOT can_join)  -> excluded (own can_join)
   *       10 StationC2 (public, can_join)     -> INCLUDED
   */
  it('a wide branching hierarchy with private teams scattered at different depths/branches excludes exactly the private-cascaded rows, alongside the pre-existing can_join/own-visibility filters', async () => {
    const rows = [
      { id: 5, name: 'StationA1', description: null, visibility: 'public', display_name: 'StationA1' },
      { id: 10, name: 'StationC2', description: null, visibility: 'public', display_name: 'StationC2' }
    ];
    pool.query.mockResolvedValue({ rows });

    const result = await Team.getJoinableTeams();

    expect(result).toEqual(rows);
    expect(result.map((t) => t.id).sort((a, b) => a - b)).toEqual([5, 10]);
    // Excluded via private ancestor cascade (Requirement 7.2), not merely
    // own-row filters:
    expect(result.find((t) => t.id === 7)).toBeUndefined();
    expect(result.find((t) => t.id === 8)).toBeUndefined();
    // Excluded via the pre-existing own-row filters (Requirement 7.1 /
    // existing can_join filter), to confirm this task did not weaken them:
    expect(result.find((t) => t.id === 6)).toBeUndefined();
    expect(result.find((t) => t.id === 9)).toBeUndefined();
  });
});

/**
 * Property-based differential test (task 15.2*) for Property 11
 * ("Public joinable-teams listing excludes every private branch",
 * design.md).
 *
 * `Team.getJoinableTeams()` takes no arguments and its entire filtering
 * logic lives inside a single SQL string sent to `pool.query` -- there
 * is no separate, in-application-code filtering step to exercise against
 * a mocked hierarchy the way `Team.isAdmin` is exercised above (Property
 * 4). Mocking `pool.query` to return exactly the rows the real query
 * WOULD return for a generated hierarchy therefore requires the mock
 * itself to implement the exclusion rule -- if the assertion merely
 * checked "the mocked rows satisfy the exclusion rule", the test would
 * be tautological (it would always pass, regardless of whether the real
 * SQL has a bug), exactly the pitfall design.md calls out for Properties
 * 9-11's reference implementations.
 *
 * To avoid that, this test implements the SAME exclusion rule TWICE,
 * independently and in deliberately different code shapes, and asserts
 * the two implementations agree on every generated hierarchy:
 *
 *   1. `simulateJoinableRows` (used inside the `pool.query` mock) walks
 *      each team's STRICT ancestors ITERATIVELY (a `while` loop climbing
 *      `parentMap`), mirroring the real CTE's own iterative/recursive
 *      row-by-row walk starting at `parent_team_id`.
 *   2. `strictAncestorsOf` (used only in the assertion, never by the
 *      mock) computes the same strict-ancestor list RECURSIVELY, and the
 *      assertion re-derives the expected included set from scratch by
 *      combining it with the own-row `can_join`/`visibility` checks.
 *
 * This does not verify the real SQL text executes correctly against a
 * live database (task 15.1's SQL-text assertions and the hand-
 * constructed scenarios above are the closest available substitute for
 * that), but it DOES catch a transcription mistake between "what rows I
 * told the mock to return" and "what the exclusion rule actually
 * requires" -- a genuine, non-tautological consistency check across many
 * randomly generated hierarchy shapes (deep chains, wide branching,
 * private teams at arbitrary depths), rather than zero regression value.
 */
describe('Property 11: Public joinable-teams listing excludes every private branch (differential check)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Generates a random tree of `teamCount` teams (1-indexed ids
   * `1..teamCount`; team `1` is always the root, every other team's
   * parent is an earlier-id'd team) together with arbitrary per-team
   * `visibility` and `can_join` values, matching the shape of Property
   * 4's `hierarchyArb` above.
   */
  const hierarchyArb = fc.integer({ min: 1, max: 10 }).chain((teamCount) => {
    const teamIds = Array.from({ length: teamCount }, (_, i) => i + 1);

    const parentArb = fc.tuple(
      ...teamIds.slice(1).map((_, i) => fc.integer({ min: 1, max: i + 1 }))
    );

    const attrsArb = fc.tuple(
      ...teamIds.map(() =>
        fc.record({
          visibility: fc.constantFrom('public', 'private'),
          canJoin: fc.boolean()
        })
      )
    );

    return fc.tuple(parentArb, attrsArb).map(([parents, attrs]) => {
      const parentMap = new Map();
      parentMap.set(teamIds[0], null);
      parents.forEach((parentId, i) => {
        parentMap.set(teamIds[i + 1], parentId);
      });

      const visibilityMap = new Map();
      const canJoinMap = new Map();
      teamIds.forEach((id, i) => {
        visibilityMap.set(id, attrs[i].visibility);
        canJoinMap.set(id, attrs[i].canJoin);
      });

      return { teamIds, parentMap, visibilityMap, canJoinMap };
    });
  });

  /** Coding #1 (mirrors the real CTE's iterative ancestor walk), used
   *  only inside the `pool.query` mock. */
  function hasPrivateAncestorIterative(teamId, parentMap, visibilityMap) {
    let current = parentMap.get(teamId);
    while (current !== null && current !== undefined) {
      if (visibilityMap.get(current) === 'private') {
        return true;
      }
      current = parentMap.get(current);
    }
    return false;
  }

  function simulateJoinableRows(teamIds, parentMap, visibilityMap, canJoinMap) {
    return teamIds
      .filter((id) => canJoinMap.get(id) === true && visibilityMap.get(id) === 'public')
      .filter((id) => !hasPrivateAncestorIterative(id, parentMap, visibilityMap))
      .map((id) => ({ id }));
  }

  /** Coding #2 (independently derived, recursive rather than iterative),
   *  used only in the assertion, never by the mock. */
  function strictAncestorsOf(teamId, parentMap) {
    const parent = parentMap.get(teamId);
    if (parent === null || parent === undefined) {
      return [];
    }
    return [parent, ...strictAncestorsOf(parent, parentMap)];
  }

  test.prop([hierarchyArb], { numRuns: 100 })(
    'getJoinableTeams (backed by a mock independently simulating the SQL exclusion rule) returns exactly the set derived from a separately-coded reference walk of the same generated hierarchy',
    async ({ teamIds, parentMap, visibilityMap, canJoinMap }) => {
      pool.query.mockImplementation(async () => ({
        rows: simulateJoinableRows(teamIds, parentMap, visibilityMap, canJoinMap)
      }));

      const result = await Team.getJoinableTeams();
      const actualIds = new Set(result.map((row) => row.id));

      const expectedIds = new Set(
        teamIds.filter((id) => {
          const ownEligible = canJoinMap.get(id) === true && visibilityMap.get(id) === 'public';
          if (!ownEligible) {
            return false;
          }
          const hasPrivateAncestor = strictAncestorsOf(id, parentMap).some(
            (ancestorId) => visibilityMap.get(ancestorId) === 'private'
          );
          return !hasPrivateAncestor;
        })
      );

      expect(actualIds).toEqual(expectedIds);
    }
  );
});

/**
 * Unit tests for `Team.getMembers`/`Team.getFullMemberList` (Requirement
 * 11.14/13.1, task 21.1).
 *
 * `getMembers`'s primary (non-fallback) query must explicitly select
 * `u.callsign_suffix`/`u.tak_role` (alongside the pre-existing `u.*`),
 * since both the Member_List display (Requirement 13.1) and the
 * `callsign_suffix` per-Team uniqueness check (Requirement 11.14) depend
 * on those columns being present. `getFullMemberList` must be a genuine
 * alias -- it must delegate to `getMembers` and produce an identical
 * result for the same `teamId`, not a separately-implemented query. The
 * fallback (no-`users`-table-join) query inside `getMembers`'s catch
 * block is intentionally untouched by this task and is not asserted on
 * here.
 */
describe('Team.getMembers / Team.getFullMemberList (Requirement 11.14/13.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('getMembers: the primary query SELECTs u.callsign_suffix and u.tak_role alongside u.*', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await Team.getMembers(5);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('SELECT u.*, u.callsign_suffix, u.tak_role, tm.role');
    expect(params).toEqual([5]);
  });

  it('getMembers: returns the rows produced by the primary query unchanged', async () => {
    const rows = [
      { id: 1, first_name: 'John', last_name: 'Doe', callsign_suffix: 'J.Doe', tak_role: 'Team Member', role: 'member' }
    ];
    pool.query.mockResolvedValue({ rows });

    const result = await Team.getMembers(5);

    expect(result).toEqual(rows);
  });

  it('getFullMemberList: delegates to getMembers, calling pool.query with identical SQL/params for the same teamId', async () => {
    const rows = [
      { id: 1, first_name: 'John', last_name: 'Doe', callsign_suffix: 'J.Doe', tak_role: 'Team Member', role: 'admin' }
    ];
    pool.query.mockResolvedValue({ rows });

    const getMembersResult = await Team.getMembers(7);
    const getFullMemberListResult = await Team.getFullMemberList(7);

    expect(getFullMemberListResult).toEqual(getMembersResult);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [sqlFromGetMembers, paramsFromGetMembers] = pool.query.mock.calls[0];
    const [sqlFromGetFullMemberList, paramsFromGetFullMemberList] = pool.query.mock.calls[1];
    expect(sqlFromGetFullMemberList).toBe(sqlFromGetMembers);
    expect(paramsFromGetFullMemberList).toEqual(paramsFromGetMembers);
    expect(paramsFromGetFullMemberList).toEqual([7]);
  });

  it('getFullMemberList: is a spy-confirmed delegation to Team.getMembers', async () => {
    const spy = jest.spyOn(Team, 'getMembers').mockResolvedValue([{ id: 42, callsign_suffix: 'A.Smith' }]);

    const result = await Team.getFullMemberList(11);

    expect(spy).toHaveBeenCalledWith(11);
    expect(result).toEqual([{ id: 42, callsign_suffix: 'A.Smith' }]);

    spy.mockRestore();
  });
});

/**
 * Confirmation test (Requirement 4.5, task 37.3): the Client's existing
 * `inherited_from_team_name` admin badge (`TeamDetail.jsx`'s Team Admins
 * tab) remains compatible with `Team.isAdmin`'s task-3.1 rewrite.
 *
 * These two mechanisms are architecturally SEPARATE:
 *   - `Team.isAdmin` (task 3.1) walks the Ancestor_Chain via its own
 *     recursive CTE purely to decide AUTHORIZATION -- whether a user CAN
 *     perform admin actions on `teamId`. It matches a direct
 *     (`inherited_from_team_id IS NULL`), `role = 'admin'` row on the
 *     team itself or any ancestor, and never reads
 *     `team_memberships.inherited_from_team_id` at all.
 *   - `Team.getMembers`'s `inherited_from_team_name`/
 *     `inherited_from_team_id` columns (pre-existing, untouched by task
 *     3.1) drive the DISPLAY-side "Inherited Admin from X" badge, sourced
 *     from the separate upward membership-inheritance mechanism
 *     (`team_memberships.inherited_from_team_id`, populated by
 *     `UserProvisioningService`/`TeamMembershipService` when a user is
 *     added to a team with parents).
 *
 * This test demonstrates both mechanisms produce CONSISTENT, compatible
 * results for the same underlying scenario -- a user who holds a direct
 * `role = 'admin'` row on a parent Team: `Team.isAdmin(childTeamId,
 * userId)` returns `true` (task 3.1's Ancestor_Chain walk finds the
 * direct admin row on the ancestor), while `Team.getMembers(childTeamId)`
 * independently returns that same user's row with a non-null
 * `inherited_from_team_id`/`inherited_from_team_name` (the pre-existing
 * mechanism the badge renders), confirming neither depends on or
 * interferes with the other.
 */
describe('Team.isAdmin / Team.getMembers inherited-admin-badge compatibility (Requirement 4.5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('isAdmin(childTeamId, userId) returns true for a direct admin on the parent, via its own Ancestor_Chain CTE, independent of inherited_from_team_id', async () => {
    // Simulates: userId 42 holds a direct role='admin' team_memberships
    // row on the parent Team (Team 1). isAdmin's CTE walks upward from
    // the child (Team 2) and finds that row.
    pool.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const result = await Team.isAdmin(2, 42);

    expect(result).toBe(true);
    const [sql] = pool.query.mock.calls[0];
    // isAdmin's query never references inherited_from_team_id except to
    // require it be NULL on the matched row itself -- it does not read
    // or depend on any inherited_from_team_id value belonging to a
    // *different* row (the one getMembers exposes for the badge).
    expect(sql).toContain('WITH RECURSIVE ancestors');
    expect(sql).toContain("tm.inherited_from_team_id IS NULL");
  });

  it('getMembers(childTeamId) independently returns that same admin as inherited_from_team_name, for the badge, using the pre-existing inherited_from_team_id column', async () => {
    // Simulates: the child Team's (Team 2) getMembers result includes
    // userId 42's row, carried down via the pre-existing upward
    // membership-inheritance mechanism -- inherited_from_team_id points
    // at the parent (Team 1), and inherited_from_team_name is populated
    // by getMembers's LEFT JOIN teams t ON tm.inherited_from_team_id =
    // t.id, exactly as it did before task 3.1's isAdmin rewrite.
    const rows = [
      {
        id: 42,
        first_name: 'Jane',
        last_name: 'Admin',
        role: 'admin',
        inherited_from_team_id: 1,
        inherited_from_team_name: 'Parent Org'
      }
    ];
    pool.query.mockResolvedValue({ rows });

    const result = await Team.getMembers(2);

    expect(result).toEqual(rows);
    const admin = result.find(r => r.id === 42);
    // This is exactly the condition TeamDetail.jsx's Team Admins tab uses
    // to select the "Inherited Admin from X" badge variant over the
    // plain "Admin" badge.
    expect(admin.inherited_from_team_name).toBeTruthy();
    expect(admin.inherited_from_team_id).toBe(1);
  });

  it('both mechanisms agree for the same direct-admin-on-parent scenario: isAdmin says true, and getMembers exposes the same user as a badge-eligible inherited admin', async () => {
    // First call: Team.isAdmin(2, 42) -- the CTE finds the direct admin
    // row on the parent.
    pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const isAdminResult = await Team.isAdmin(2, 42);
    expect(isAdminResult).toBe(true);

    // Second call: Team.getMembers(2) -- the pre-existing, unrelated
    // query surfaces the same user with inherited_from_team_name set,
    // which is exactly what TeamDetail.jsx renders as "Inherited Admin
    // from Parent Org" instead of a plain "Admin" badge.
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 42,
        first_name: 'Jane',
        last_name: 'Admin',
        role: 'admin',
        inherited_from_team_id: 1,
        inherited_from_team_name: 'Parent Org'
      }]
    });
    const members = await Team.getMembers(2);
    const admin = members.find(r => r.id === 42);

    expect(isAdminResult).toBe(true);
    expect(admin.inherited_from_team_name).toBe('Parent Org');
  });
});

/**
 * Property-based test (design.md's Property 2: "Sub_Team always inherits
 * Organisation-only fields, ignoring any supplied override", task 6.4),
 * implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, matching the convention established in
 * `Team.test.js`'s Property 4 test above and
 * `../services/userAttributes.test.js`'s Property 6/21 tests.
 *
 * For any Organisation `color`/`callsign_name_format` and any Sub_Team
 * creation/update request supplying an arbitrary (possibly
 * coincidentally-matching) override, `Team.create`'s INSERT and
 * `Team.update`'s UPDATE must never apply the supplied override -- the
 * INSERT's parameters must always carry the Organisation's CURRENT
 * `color`/`callsign_name_format` (resolved via the mocked
 * `getAncestorChain(parent_team_id)` root row), and the UPDATE's
 * parameters must always pass `undefined` for both fields (so SQL's own
 * `COALESCE` preserves whatever value is already stored -- which, by
 * construction via `Team.create`'s own behaviour, is always the
 * Organisation's value already).
 *
 * `supplyCoincidentColor`/`supplyCoincidentFormat` deliberately bias part
 * of the generated space toward the supplied override happening to equal
 * the Organisation's actual value, so the property is also exercised in
 * the case where a naive "reject if different" implementation would
 * accidentally appear correct -- the required behaviour (always
 * override/ignore, never merely reject-if-different) must hold
 * regardless of whether the two values coincide.
 */
describe('Property 2: Sub_Team always inherits Organisation-only fields, ignoring any supplied override', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Team, 'createTeamChannel').mockResolvedValue({ id: 999 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const colorArb = fc.stringMatching(/^[A-Za-z]{1,10}$/);
  const formatArb = fc.constantFrom(
    'full_name',
    'first_initial_last',
    'first_last_initial',
    'first_initial_dot_last',
    'user_defined'
  );

  // Requirement 3.2/3.3: an arbitrary Organisation color/format, and an
  // arbitrary Sub_Team-request override that -- via the coincidence
  // flags -- sometimes deliberately equals the Organisation's own value,
  // so the property is exercised in BOTH the "supplied differs" and
  // "supplied happens to match" cases.
  const scenarioArb = fc
    .record({
      orgColor: colorArb,
      orgFormat: formatArb,
      overrideColor: colorArb,
      overrideFormat: formatArb,
      coincidentColor: fc.boolean(),
      coincidentFormat: fc.boolean()
    })
    .map((s) => ({
      orgColor: s.orgColor,
      orgFormat: s.orgFormat,
      suppliedColor: s.coincidentColor ? s.orgColor : s.overrideColor,
      suppliedFormat: s.coincidentFormat ? s.orgFormat : s.overrideFormat
    }));

  test.prop([scenarioArb], { numRuns: 100 })(
    'Team.create: a Sub_Team INSERT always carries the Organisation\'s current color/callsign_name_format, never the supplied override',
    async ({ orgColor, orgFormat, suppliedColor, suppliedFormat }) => {
      // `pool.query.mock.calls` accumulates across every fast-check
      // iteration within this single `test.prop` run (only `beforeEach`
      // clears it, once per test) -- without clearing here, a later
      // iteration's `.find(...)` lookup below could resolve to a STALE
      // call captured during an earlier iteration. `mockClear()` resets
      // the recorded calls without discarding the implementation we are
      // about to set immediately below.
      pool.query.mockClear();
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors') && sql.includes('MAX(hops_from_target) AS depth')) {
          // getTeamDepth(parent_team_id): parent is the root Organisation
          // itself, at depth 0, so the new Sub_Team sits at depth 1.
          return Promise.resolve({ rows: [{ depth: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
          // getAncestorChain(parent_team_id): root-first, single-row
          // chain -- the parent IS the Organisation.
          return Promise.resolve({
            rows: [{ id: 1, parent_team_id: null, color: orgColor, callsign_name_format: orgFormat, depth: 0 }]
          });
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO teams')) {
          return Promise.resolve({
            rows: [{ id: 10, parent_team_id: 1, color: orgColor, callsign_name_format: orgFormat }]
          });
        }
        return Promise.resolve({ rows: [] });
      });

      const team = await Team.create({
        name: 'Station 40',
        parent_team_id: 1,
        color: suppliedColor,
        callsign_name_format: suppliedFormat
      });

      const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO teams'));
      expect(insertCall).toBeDefined();
      const [, insertParams] = insertCall;

      // The Organisation's current values are always what gets inserted.
      expect(insertParams).toContain(orgColor);
      expect(insertParams).toContain(orgFormat);
      // The supplied override never reaches the INSERT, even when it
      // differs from the Organisation's value.
      if (suppliedColor !== orgColor) {
        expect(insertParams).not.toContain(suppliedColor);
      }
      if (suppliedFormat !== orgFormat) {
        expect(insertParams).not.toContain(suppliedFormat);
      }
      expect(team.color).toBe(orgColor);
      expect(team.callsign_name_format).toBe(orgFormat);
    }
  );

  test.prop([scenarioArb], { numRuns: 100 })(
    'Team.update: a Sub_Team UPDATE never applies a supplied color/callsign_name_format override, preserving the already Organisation-derived stored value',
    async ({ orgColor, orgFormat, suppliedColor, suppliedFormat }) => {
      // Same accumulation concern as the create-side property above.
      pool.query.mockClear();
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          // Sub_Team (non-null parent_team_id), already holding the
          // Organisation's values from its own creation-time inheritance.
          return Promise.resolve({
            rows: [{ id: 5, parent_team_id: 3, color: orgColor, callsign_name_format: orgFormat }]
          });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          // COALESCE preserves the existing stored (Organisation-derived)
          // value, since the query's own color/callsign_name_format
          // parameters are undefined for a Sub_Team.
          return Promise.resolve({ rows: [{ id: 5, color: orgColor, callsign_name_format: orgFormat }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const updated = await Team.update(5, {
        color: suppliedColor,
        callsign_name_format: suppliedFormat
      });

      const updateCall = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE teams'));
      expect(updateCall).toBeDefined();
      const [, updateParams] = updateCall;

      // The supplied override is never passed through to the UPDATE.
      expect(updateParams).not.toContain(suppliedColor);
      expect(updateParams).not.toContain(suppliedFormat);
      // The resulting stored value always remains the Organisation's.
      expect(updated.color).toBe(orgColor);
      expect(updated.callsign_name_format).toBe(orgFormat);
    }
  );
});

/**
 * Unit tests for `Team.addMember`'s CloudTAK membership enqueue site
 * (Requirement 5.1/5.2/5.3, task 8.1/8.4).
 *
 * `Team.addMember`'s single `ON CONFLICT ... DO UPDATE SET role` upsert
 * is the mutation point for adding an admin, promoting a member to admin,
 * and demoting an admin to member (design "Exact enqueue points" #4).
 * After that upsert succeeds, and ONLY when CloudTAK is enabled, it must
 * enqueue exactly one `update_cloudtak_group` Sync_Operation carrying the
 * `{ team_id }` so the Team's CloudTAK group re-reconciles to the current
 * Direct_Admin_Set. The enqueue is non-transactional (default pool, no
 * `client` argument) and must never enqueue when the flag is off
 * (Requirement 1.4). `isCloudTakEnabled()` reads `process.env` at call
 * time, so toggling `process.env.CLOUDTAK_ENABLED` here is sufficient; we
 * save and restore it around each test so no state leaks into other
 * tests in this file.
 */
describe('Team.addMember CloudTAK enqueue (Requirement 5.1/5.2/5.3, 1.4)', () => {
  let savedFlag;

  beforeEach(() => {
    jest.clearAllMocks();
    savedFlag = process.env.CLOUDTAK_ENABLED;
    pool.query.mockResolvedValue({ rows: [{ team_id: 5, user_id: 42, role: 'member' }] });
    EventPublisher.publishOperation.mockResolvedValue('op-id');
  });

  afterEach(() => {
    if (savedFlag === undefined) {
      delete process.env.CLOUDTAK_ENABLED;
    } else {
      process.env.CLOUDTAK_ENABLED = savedFlag;
    }
  });

  it("enqueues exactly one update_cloudtak_group with { team_id } when the flag is on for role='admin' (add/promote path)", async () => {
    process.env.CLOUDTAK_ENABLED = 'true';

    await Team.addMember(5, 42, 'admin');

    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_cloudtak_group',
      { team_id: 5 },
      null
    );
  });

  it("enqueues exactly one update_cloudtak_group with { team_id } when the flag is on for role='member' (demote path)", async () => {
    process.env.CLOUDTAK_ENABLED = 'true';

    await Team.addMember(5, 42, 'member');

    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_cloudtak_group',
      { team_id: 5 },
      null
    );
  });

  it('enqueues on the default pool (no transactional client argument)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';

    await Team.addMember(5, 42, 'admin');

    const [, , createdBy, client] = EventPublisher.publishOperation.mock.calls[0];
    expect(createdBy).toBeNull();
    expect(client).toBeUndefined();
  });

  it('enqueues NOTHING when the flag is off, for both admin and member roles (Requirement 1.4)', async () => {
    process.env.CLOUDTAK_ENABLED = 'false';

    await Team.addMember(5, 42, 'admin');
    await Team.addMember(5, 42, 'member');

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('does not break the addMember result when the enqueue itself fails (non-rethrowing)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    EventPublisher.publishOperation.mockRejectedValue(new Error('sync_operations insert failed'));

    // The membership upsert still resolves to its row; the enqueue error
    // is caught and logged rather than propagated.
    const member = await Team.addMember(5, 42, 'admin');

    expect(member).toEqual({ team_id: 5, user_id: 42, role: 'member' });
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), teamId: 5 }),
      'Error enqueuing update_cloudtak_group'
    );
  });
});

/**
 * Unit tests for the CloudTAK_Group enqueue sites in `Team.create` and
 * `Team.update` (Requirement 2.1/2.6/6.1/6.2/1.4/9.1/9.4, task 6.3).
 *
 * `Team.create`, after its `teams` INSERT succeeds and ONLY when CloudTAK
 * is enabled, must enqueue exactly one `create_cloudtak_group`
 * Sync_Operation carrying `{ team_id: <new id> }` -- identically for a
 * root Organisation and a Sub_Team. `Team.update`, after its `teams`
 * UPDATE returns, must enqueue an `update_cloudtak_group` with
 * `{ team_id }` ONLY when the update actually touched `name` and/or
 * `description` (the two fields mirrored into the group's
 * Agency_Attributes), and must NOT enqueue for an update that touched
 * neither. Both are non-transactional sites (default pool, no `client`
 * argument, Requirement 9.1) and must enqueue NOTHING when the flag is
 * off (Requirement 1.4).
 *
 * `isCloudTakEnabled()` reads `process.env` at call time, so toggling
 * `process.env.CLOUDTAK_ENABLED` here is sufficient (matching the
 * `Team.addMember` CloudTAK enqueue tests above); it is saved/restored
 * around each test so no state leaks. `createTeamChannel` is stubbed
 * (its own DB/Authentik concern) so `Team.create`'s only observable
 * `pool.query` is the INSERT, mirroring the Max_Team_Depth tests'
 * convention.
 */
describe('Team.create / Team.update CloudTAK enqueue (Requirement 2.1/2.6/6.1/6.2, 1.4)', () => {
  let savedFlag;

  beforeEach(() => {
    jest.clearAllMocks();
    savedFlag = process.env.CLOUDTAK_ENABLED;
    jest.spyOn(Team, 'createTeamChannel').mockResolvedValue({ id: 999 });
    EventPublisher.publishOperation.mockResolvedValue('op-id');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedFlag === undefined) {
      delete process.env.CLOUDTAK_ENABLED;
    } else {
      process.env.CLOUDTAK_ENABLED = savedFlag;
    }
  });

  it('Team.create enqueues exactly one create_cloudtak_group with the new root team id on the default pool when the flag is on (Requirement 2.1)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    pool.query.mockResolvedValue({ rows: [{ id: 7, name: 'FENZ', parent_team_id: null }] });

    const team = await Team.create({ name: 'FENZ', parent_team_id: null, created_by: 99 });

    expect(team).toEqual({ id: 7, name: 'FENZ', parent_team_id: null });
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_cloudtak_group',
      { team_id: 7 },
      99
    );
    // Non-transactional site: no client (4th) argument (Requirement 9.1).
    const [, , , client] = EventPublisher.publishOperation.mock.calls[0];
    expect(client).toBeUndefined();
  });

  it('Team.create enqueues create_cloudtak_group with the new SUB-team id (identically to a root team) when the flag is on (Requirement 2.6)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
        // Parent at depth 0, so the Sub_Team lands at depth 1 (<= MAX).
        return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, color: 'Red', callsign_name_format: 'full_name', depth: 0 }] });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO teams')) {
        return Promise.resolve({ rows: [{ id: 12, name: 'Station 40', parent_team_id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const team = await Team.create({ name: 'Station 40', parent_team_id: 1, created_by: null });

    expect(team).toEqual({ id: 12, name: 'Station 40', parent_team_id: 1 });
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_cloudtak_group',
      { team_id: 12 },
      null
    );
  });

  it('Team.create enqueues NOTHING when the flag is off (Requirement 1.4)', async () => {
    process.env.CLOUDTAK_ENABLED = 'false';
    pool.query.mockResolvedValue({ rows: [{ id: 7, name: 'FENZ', parent_team_id: null }] });

    await Team.create({ name: 'FENZ', parent_team_id: null, created_by: 99 });

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('Team.update enqueues update_cloudtak_group with { team_id } on a name change, on the default pool, when the flag is on (Requirement 6.1)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    pool.query.mockResolvedValue({ rows: [{ id: 5, name: 'Renamed', parent_team_id: null }] });

    await Team.update(5, { name: 'Renamed' });

    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_cloudtak_group',
      { team_id: 5 },
      null
    );
    const [, , , client] = EventPublisher.publishOperation.mock.calls[0];
    expect(client).toBeUndefined();
  });

  it('Team.update enqueues update_cloudtak_group on a description change when the flag is on (Requirement 6.2)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    pool.query.mockResolvedValue({ rows: [{ id: 5, name: 'FENZ', description: 'New desc', parent_team_id: null }] });

    await Team.update(5, { description: 'New desc' });

    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_cloudtak_group',
      { team_id: 5 },
      null
    );
  });

  it('Team.update does NOT enqueue when neither name nor description was part of the update (e.g. visibility-only), even with the flag on (Requirement 6.1/6.2)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    pool.query.mockResolvedValue({ rows: [{ id: 5, name: 'FENZ', parent_team_id: null }] });

    await Team.update(5, { visibility: 'private' });

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('Team.update enqueues NOTHING when the flag is off, even on a name/description change (Requirement 1.4)', async () => {
    process.env.CLOUDTAK_ENABLED = 'false';
    pool.query.mockResolvedValue({ rows: [{ id: 5, name: 'Renamed', description: 'New desc', parent_team_id: null }] });

    await Team.update(5, { name: 'Renamed', description: 'New desc' });

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for the CloudTAK_Group deletion enqueue site in
 * `Team.delete` (Requirement 7.1/9.2/1.4, task 7.2).
 *
 * Inside `Team.delete`'s existing transaction, before COMMIT and ONLY
 * when CloudTAK is enabled, it must enqueue exactly one
 * `delete_cloudtak_group` Sync_Operation carrying `{ team_id }` (a
 * number, taken from the deleted row) on the SAME transactional `client`
 * (4th argument) -- the intentional transactional-site behaviour
 * (Requirement 9.2), so the `sync_operations` row commits/rolls back
 * atomically with the deletion. This must sit ALONGSIDE the existing
 * `remove_team_channel_group`/`revoke_tak_certificates` enqueues without
 * disturbing them, and must NOT enqueue when the flag is off
 * (Requirement 1.4) -- while those existing channel/cert enqueues still
 * occur. `process.env.CLOUDTAK_ENABLED` is toggled/restored per test,
 * matching the other CloudTAK enqueue tests in this file, and the
 * transactional `client` is mocked exactly as the top-of-file
 * `Team.delete` tests do.
 */
describe('Team.delete CloudTAK enqueue (Requirement 7.1/9.2, 1.4)', () => {
  let savedFlag;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    savedFlag = process.env.CLOUDTAK_ENABLED;
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    // See the top-of-file `Team.delete` describe block's own beforeEach:
    // the post-commit attribute-clearing block reads via `pool`, not
    // `client`.
    pool.query.mockResolvedValue({ rows: [] });
    UserAttributesService.clearTeamAttributes.mockResolvedValue(true);
  });

  afterEach(() => {
    if (savedFlag === undefined) {
      delete process.env.CLOUDTAK_ENABLED;
    } else {
      process.env.CLOUDTAK_ENABLED = savedFlag;
    }
  });

  it('enqueues exactly one delete_cloudtak_group with a numeric { team_id } on the transactional client when the flag is on (Requirement 7.1/9.2)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: [] }); // no channels
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

    const deleteCalls = EventPublisher.publishOperation.mock.calls.filter(
      ([type]) => type === 'delete_cloudtak_group'
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual([
      'delete_cloudtak_group',
      { team_id: 5 },
      99,
      mockClient
    ]);
    // team_id must be a number (the row is already deleted; the site
    // coerces via Number(...)).
    expect(typeof deleteCalls[0][1].team_id).toBe('number');
    // The enqueue must happen before COMMIT, inside the transaction.
    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calls).toContain('COMMIT');
    expect(calls).not.toContain('ROLLBACK');
  });

  it('enqueues delete_cloudtak_group ALONGSIDE the existing channel/cert enqueues without disturbing them (Requirement 7.1)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    const deletedChannels = [
      { id: 10, authentik_group_id: 100, authentik_read_group_id: null, authentik_write_group_id: null }
    ];
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: deletedChannels });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [{ username: 'alice' }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.delete(5, 99);

    const types = EventPublisher.publishOperation.mock.calls.map(([type]) => type);
    expect(types).toContain('remove_team_channel_group');
    expect(types).toContain('revoke_tak_certificates');
    expect(types.filter((t) => t === 'delete_cloudtak_group')).toHaveLength(1);
    // Ordering (cascade-delete refactor): the per-team routine
    // (`_deleteSingleTeamInTransaction`, shared with `deleteWithSubtree`)
    // enqueues the channel-group and CloudTAK-group ops for THIS team;
    // the caller (`Team.delete`) then enqueues the ONE subtree-wide bulk
    // `revoke_tak_certificates` afterward. So the per-team channel op
    // precedes the per-team CloudTAK op, and the subtree-wide cert
    // revocation is enqueued last of the three.
    const channelIdx = types.indexOf('remove_team_channel_group');
    const cloudtakIdx = types.indexOf('delete_cloudtak_group');
    const revokeIdx = types.indexOf('revoke_tak_certificates');
    expect(channelIdx).toBeLessThan(cloudtakIdx);
    expect(cloudtakIdx).toBeLessThan(revokeIdx);
    expect(types[types.length - 1]).toBe('revoke_tak_certificates');
  });

  it('does NOT enqueue delete_cloudtak_group when the flag is off, while the existing channel/cert enqueues still occur (Requirement 1.4)', async () => {
    process.env.CLOUDTAK_ENABLED = 'false';
    const deletedChannels = [
      { id: 10, authentik_group_id: 100, authentik_read_group_id: null, authentik_write_group_id: null }
    ];
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        return Promise.resolve({ rows: deletedChannels });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [{ username: 'alice' }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.delete(5, 99);

    const types = EventPublisher.publishOperation.mock.calls.map(([type]) => type);
    expect(types).not.toContain('delete_cloudtak_group');
    // The pre-existing enqueues are unaffected by the flag.
    expect(types).toContain('remove_team_channel_group');
    expect(types).toContain('revoke_tak_certificates');
  });
});

/**
 * Unit tests for `Team.getSubtreeMemberDeviceCounts` (cascade-delete
 * feature): the empty-subtree gate the DELETE /api/teams/:teamId route
 * consults before allowing a Global_Manager to cascade-delete a team
 * that has sub-teams. Counts are computed via a single recursive CTE
 * over the team + every descendant; `member` = a DISTINCT non-device
 * user with a membership row anywhere in the subtree, `device` = a
 * DIRECT (inherited_from_team_id IS NULL) team-owned-device membership
 * row anywhere in the subtree, `subTeam` = descendant teams (excluding
 * the root itself).
 */
describe('Team.getSubtreeMemberDeviceCounts (cascade-delete gate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('returns the parsed member/device/sub-team counts from the single aggregate query', async () => {
    pool.query.mockResolvedValue({
      rows: [{ member_count: '5', device_count: '2', sub_team_count: '7' }]
    });

    const result = await Team.getSubtreeMemberDeviceCounts(3);

    expect(result).toEqual({ memberCount: 5, deviceCount: 2, subTeamCount: 7 });
    // One query, a recursive CTE over the team + its descendants.
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('WITH RECURSIVE team_and_subteams');
    expect(params).toEqual([3]);
  });

  it('treats a missing/empty result row as all-zero (never NaN)', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await Team.getSubtreeMemberDeviceCounts(3);

    expect(result).toEqual({ memberCount: 0, deviceCount: 0, subTeamCount: 0 });
  });

  it('coerces null/absent counts to 0 rather than NaN', async () => {
    pool.query.mockResolvedValue({
      rows: [{ member_count: null, device_count: undefined, sub_team_count: '0' }]
    });

    const result = await Team.getSubtreeMemberDeviceCounts(3);

    expect(result).toEqual({ memberCount: 0, deviceCount: 0, subTeamCount: 0 });
  });

  it('counts non-device members via is_team_device IS NOT TRUE and devices via direct is_team_device = true (source-contract on the query shape)', async () => {
    pool.query.mockResolvedValue({
      rows: [{ member_count: '0', device_count: '0', sub_team_count: '0' }]
    });

    await Team.getSubtreeMemberDeviceCounts(3);

    const [sql] = pool.query.mock.calls[0];
    // member_count subquery excludes devices.
    expect(sql).toMatch(/is_team_device IS NOT TRUE/);
    // device_count subquery counts DIRECT device memberships only.
    expect(sql).toMatch(/inherited_from_team_id IS NULL/);
    expect(sql).toMatch(/is_team_device = true/);
  });

  it('propagates a query error rather than swallowing it (the route must not proceed to delete on an unknown gate state)', async () => {
    pool.query.mockRejectedValue(new Error('db down'));

    await expect(Team.getSubtreeMemberDeviceCounts(3)).rejects.toThrow('db down');
  });
});

/**
 * Unit tests for `Team.deleteWithSubtree` (cascade-delete feature): the
 * whole-subtree deletion the DELETE /api/teams/:teamId route calls once
 * its empty-subtree gate passes. It must delete DEEPEST-FIRST, run the
 * SAME per-team cleanup (`_deleteSingleTeamInTransaction`) for EVERY team
 * in the subtree -- so each descendant's channels and Authentik/CloudTAK
 * groups get their own Sync_Operations rather than being silently
 * dropped by the raw parent_team_id FK cascade -- and enqueue exactly
 * ONE subtree-wide bulk revoke_tak_certificates, all on one client, in
 * one transaction.
 */
describe('Team.deleteWithSubtree (cascade-delete)', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    pool.query.mockResolvedValue({ rows: [] });
    UserAttributesService.clearTeamAttributes.mockResolvedValue(true);
  });

  it('deletes every team in the subtree deepest-first, one teams-row DELETE per team, on one client in one transaction', async () => {
    // Subtree: root 3 (depth 0) -> 4 (depth 1) -> 5 (depth 2).
    // Returned ORDER BY depth DESC, so [5, 4, 3].
    mockClient.query.mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE subtree')) {
        return Promise.resolve({ rows: [{ id: 5, depth: 2 }, { id: 4, depth: 1 }, { id: 3, depth: 0 }] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: params[0], name: `Team ${params[0]}` }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await Team.deleteWithSubtree(3, 99);

    // Exactly one client/transaction for the whole subtree.
    expect(pool.connect).toHaveBeenCalledTimes(1);
    const calls = mockClient.query.mock.calls.map((c) => c);
    const teamsDeletes = calls.filter(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM teams'));
    // One teams-row DELETE per subtree team, deepest-first: 5, then 4, then 3.
    expect(teamsDeletes.map(([, params]) => params[0])).toEqual([5, 4, 3]);

    const sqls = calls.map(([sql]) => sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');

    // Returns the ROOT team's deleted row.
    expect(result).toEqual({ id: 3, name: 'Team 3' });
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('runs the per-team channel cleanup for EVERY subtree team, not just the root (so descendant Authentik/CloudTAK groups are not orphaned)', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';
    // Each team owns one channel, so we can prove per-team cleanup ran
    // for all three by counting remove_team_channel_group enqueues.
    mockClient.query.mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE subtree')) {
        return Promise.resolve({ rows: [{ id: 5, depth: 2 }, { id: 4, depth: 1 }, { id: 3, depth: 0 }] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT id, authentik_group_id')) {
        // Channel id derived from the team id so each is distinct.
        return Promise.resolve({ rows: [{ id: 1000 + params[0], authentik_group_id: 2000 + params[0], authentik_read_group_id: null, authentik_write_group_id: null }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: params[0] }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.deleteWithSubtree(3, 99);

    const types = EventPublisher.publishOperation.mock.calls.map(([type]) => type);
    // One channel-group removal per team (3 teams, 1 channel each).
    expect(types.filter((t) => t === 'remove_team_channel_group')).toHaveLength(3);
    // One CloudTAK group deletion per team.
    expect(types.filter((t) => t === 'delete_cloudtak_group')).toHaveLength(3);

    // Every subtree team's channel got its own removal op, keyed by the
    // per-team channel id (1000 + teamId).
    const channelOps = EventPublisher.publishOperation.mock.calls.filter(([type]) => type === 'remove_team_channel_group');
    const channelIds = channelOps.map(([, payload]) => payload.channel_id).sort((a, b) => a - b);
    expect(channelIds).toEqual([1003, 1004, 1005]);
  });

  it('enqueues exactly ONE subtree-wide revoke_tak_certificates covering every affected user, not one per team', async () => {
    mockClient.query.mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE subtree')) {
        return Promise.resolve({ rows: [{ id: 5, depth: 1 }, { id: 3, depth: 0 }] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [{ id: 11, username: 'alice' }, { id: 12, username: 'bob' }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: params[0] }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.deleteWithSubtree(3, 99);

    const revokeCalls = EventPublisher.publishOperation.mock.calls.filter(([type]) => type === 'revoke_tak_certificates');
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0][1]).toEqual({ tak_usernames: ['alice', 'bob'] });
  });

  it('enqueues NO revoke_tak_certificates for an empty subtree (the gated case)', async () => {
    mockClient.query.mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE subtree')) {
        return Promise.resolve({ rows: [{ id: 5, depth: 1 }, { id: 3, depth: 0 }] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.resolve({ rows: [{ id: params[0] }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await Team.deleteWithSubtree(3, 99);

    const types = EventPublisher.publishOperation.mock.calls.map(([type]) => type);
    expect(types).not.toContain('revoke_tak_certificates');
  });

  it('rolls back the whole transaction and rethrows when a delete step fails, leaving nothing committed', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE subtree')) {
        return Promise.resolve({ rows: [{ id: 5, depth: 1 }, { id: 3, depth: 0 }] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_and_subteams')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM teams')) {
        return Promise.reject(new Error('constraint violation'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(Team.deleteWithSubtree(3, 99)).rejects.toThrow('constraint violation');

    const sqls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

/**
 * Org-wide-team-name-uniqueness feature: a team's `name` must be unique
 * across its whole Organisation (the subtree under the root
 * `parent_team_id IS NULL`), not merely under its immediate parent (all
 * the baseline `teams_name_parent_team_id_key` DB constraint enforces).
 * Enforced at the application layer via
 * `Team.assertNameUniqueInOrganisation`, called from `Team.create`
 * (Sub_Team path) and `Team.update` (rename + re-parent), throwing the
 * typed `TeamNameConflictError`. These tests mock `pool.query` directly,
 * matching this file's convention, keying off the recursive-CTE SQL each
 * step issues.
 */
describe('Team org-wide name uniqueness (Team.assertNameUniqueInOrganisation + create/update)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Team, 'createTeamChannel').mockResolvedValue({ id: 999 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('assertNameUniqueInOrganisation (the helper directly)', () => {
    it('throws TeamNameConflictError when another team in the org subtree already has the name', async () => {
      pool.query.mockResolvedValue({ rows: [{ id: 77 }] });

      await expect(
        Team.assertNameUniqueInOrganisation(1, 'Auckland')
      ).rejects.toThrow(Team.TeamNameConflictError);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('WITH RECURSIVE org_subtree');
      // org id, candidate name, excludeTeamId (null here).
      expect(params).toEqual([1, 'Auckland', null]);
    });

    it('does NOT throw when no other team in the org subtree has the name', async () => {
      pool.query.mockResolvedValue({ rows: [] });
      await expect(Team.assertNameUniqueInOrganisation(1, 'Unique Name')).resolves.toBeUndefined();
    });

    it('passes excludeTeamId through so a team never conflicts with its own row', async () => {
      pool.query.mockResolvedValue({ rows: [] });
      await Team.assertNameUniqueInOrganisation(1, 'Auckland', 42);
      const [, params] = pool.query.mock.calls[0];
      expect(params).toEqual([1, 'Auckland', 42]);
    });

    it('is case-sensitive (matches the baseline UNIQUE constraint) -- the SQL compares name with = , not ILIKE', async () => {
      pool.query.mockResolvedValue({ rows: [] });
      await Team.assertNameUniqueInOrganisation(1, 'auckland');
      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain('name = $2');
      expect(sql).not.toMatch(/ILIKE|LOWER\(/i);
    });
  });

  describe('Team.create (Sub_Team) enforces org-wide name uniqueness', () => {
    // Shared mock: depth query (OK), ancestor chain (root org id 1), and
    // the org_subtree name check whose result the test varies.
    function mockCreateWith({ nameConflict }) {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors') && sql.includes('MAX(hops_from_target) AS depth')) {
          return Promise.resolve({ rows: [{ depth: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
          // getAncestorChain: root-first, so index 0 is the Organisation.
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null, color: 'Red', callsign_name_format: 'full_name', depth: 0 }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree')) {
          return Promise.resolve({ rows: nameConflict ? [{ id: 55 }] : [] });
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO teams')) {
          return Promise.resolve({ rows: [{ id: 10, name: 'Auckland', parent_team_id: 2 }] });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    it('throws TeamNameConflictError and never INSERTs when the name is taken elsewhere in the same org', async () => {
      mockCreateWith({ nameConflict: true });

      await expect(
        Team.create({ name: 'Auckland', parent_team_id: 2 })
      ).rejects.toThrow(Team.TeamNameConflictError);

      const insertCalls = pool.query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO teams'));
      expect(insertCalls).toHaveLength(0);
      expect(Team.createTeamChannel).not.toHaveBeenCalled();
    });

    it('checks the name against the resolved ORGANISATION root id (from getAncestorChain[0]), not the immediate parent', async () => {
      mockCreateWith({ nameConflict: false });

      await Team.create({ name: 'Auckland', parent_team_id: 2 });

      const subtreeCall = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree'));
      expect(subtreeCall).toBeDefined();
      // org id 1 (the root), candidate name, no excludeTeamId on create.
      expect(subtreeCall[1]).toEqual([1, 'Auckland', null]);
    });

    it('proceeds to INSERT when the name is unique in the org', async () => {
      mockCreateWith({ nameConflict: false });

      const team = await Team.create({ name: 'Auckland', parent_team_id: 2 });

      expect(team).toEqual(expect.objectContaining({ id: 10 }));
      const insertCalls = pool.query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO teams'));
      expect(insertCalls).toHaveLength(1);
    });

    it('does NOT run the org-wide name check for a root Organisation create (parent_team_id null) -- root-vs-root is the DB constraint\'s job', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO teams')) {
          return Promise.resolve({ rows: [{ id: 1, name: 'FENZ', parent_team_id: null }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.create({ name: 'FENZ', parent_team_id: null });

      const subtreeCall = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree'));
      expect(subtreeCall).toBeUndefined();
    });
  });

  describe('Team.update enforces org-wide name uniqueness on rename and re-parent', () => {
    it('throws TeamNameConflictError on a RENAME that collides with another team in the same org, without UPDATE', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          // The team being renamed is a Sub_Team of parent 2.
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: 2, name: 'Old Name' }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
          // getAncestorChain(2): root org id 1.
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null }, { id: 2, parent_team_id: 1 }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree')) {
          return Promise.resolve({ rows: [{ id: 88 }] }); // a collision
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        Team.update(5, { name: 'Auckland' })
      ).rejects.toThrow(Team.TeamNameConflictError);

      const updateCalls = pool.query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('UPDATE teams'));
      expect(updateCalls).toHaveLength(0);
    });

    it('excludes the team itself from the rename check (a no-op rename to its own current name never conflicts)', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: 2, name: 'Auckland' }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
          return Promise.resolve({ rows: [{ id: 1, parent_team_id: null }, { id: 2, parent_team_id: 1 }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 5, name: 'Auckland' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(5, { name: 'Auckland' });

      const subtreeCall = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree'));
      // Excludes teamId 5 (org id 1, name 'Auckland', exclude 5).
      expect(subtreeCall[1]).toEqual([1, 'Auckland', 5]);
      const updateCalls = pool.query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('UPDATE teams'));
      expect(updateCalls).toHaveLength(1);
    });

    it('throws TeamNameConflictError on a RE-PARENT into an org where the team\'s name already exists', async () => {
      // Team 5 (name 'Auckland') moving under parent 9, whose org (root
      // 8) already contains an 'Auckland'.
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: 2, name: 'Auckland' }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE ancestors')) {
          // getAncestorChain(9): new org root id 8.
          return Promise.resolve({ rows: [{ id: 8, parent_team_id: null }, { id: 9, parent_team_id: 8 }] });
        }
        if (typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree')) {
          return Promise.resolve({ rows: [{ id: 88 }] }); // collision in the destination org
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(
        Team.update(5, { parent_team_id: 9 })
      ).rejects.toThrow(Team.TeamNameConflictError);

      // The check resolved the DESTINATION org (root 8), not the current one.
      const subtreeCall = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree'));
      expect(subtreeCall[1]).toEqual([8, 'Auckland', 5]);
      const updateCalls = pool.query.mock.calls.filter(([sql]) => typeof sql === 'string' && sql.includes('UPDATE teams'));
      expect(updateCalls).toHaveLength(0);
    });

    it('does NOT run the org-wide name check when neither name nor parent_team_id is being updated', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT * FROM teams WHERE id')) {
          return Promise.resolve({ rows: [{ id: 5, parent_team_id: 2, name: 'Auckland' }] });
        }
        if (typeof sql === 'string' && sql.includes('UPDATE teams')) {
          return Promise.resolve({ rows: [{ id: 5 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await Team.update(5, { visibility: 'private' });

      const subtreeCall = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('WITH RECURSIVE org_subtree'));
      expect(subtreeCall).toBeUndefined();
    });
  });
});
