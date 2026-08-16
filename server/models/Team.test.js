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
