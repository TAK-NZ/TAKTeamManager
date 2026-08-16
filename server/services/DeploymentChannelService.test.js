jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const DeploymentChannelService = require('./DeploymentChannelService');
const {
  DeploymentChannelNotActiveError,
  DeploymentChannelNotFoundError
} = require('./DeploymentChannelService');

describe('DeploymentChannelService.createDeploymentChannel', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 42 }] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    service = new DeploymentChannelService();
  });

  it('creates an Overseas-prefixed channel with no deploymentEndDate (standing Pacific-partner channel)', async () => {
    const result = await service.createDeploymentChannel(
      { name: 'Overseas - Tonga', description: 'Tonga deployment' },
      7
    );

    expect(result).toEqual({ channelId: 42 });

    const insertCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO deployment_channels')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toEqual(['Overseas - Tonga', 'Tonga deployment', null, 7]);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_deployment_channel_group',
      { deployment_channel_id: 42, channel_name: 'Overseas - Tonga' },
      7
    );
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('creates a domestic-pattern channel when deploymentEndDate is supplied', async () => {
    const result = await service.createDeploymentChannel(
      { name: 'AUS-FIRE-STL-2026', description: 'Foreign partner support', deploymentEndDate: '2026-06-01' },
      7
    );

    expect(result).toEqual({ channelId: 42 });

    const insertCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO deployment_channels')
    );
    expect(insertCall[1]).toEqual(['AUS-FIRE-STL-2026', 'Foreign partner support', '2026-06-01', 7]);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_deployment_channel_group',
      { deployment_channel_id: 42, channel_name: 'AUS-FIRE-STL-2026' },
      7
    );
  });

  it('rejects a domestic-pattern name without a deploymentEndDate, without inserting a row', async () => {
    await expect(
      service.createDeploymentChannel({ name: 'AUS-FIRE-STL-2026', description: 'no end date' }, 7)
    ).rejects.toThrow(/deployment_end_date is required/);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('rejects a domestic-pattern name with a null deploymentEndDate, without inserting a row', async () => {
    await expect(
      service.createDeploymentChannel(
        { name: 'AUS-FIRE-STL-2026', description: 'no end date', deploymentEndDate: null },
        7
      )
    ).rejects.toThrow(/deployment_end_date is required/);

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a name matching neither accepted pattern, naming both formats, without inserting a row', async () => {
    await expect(
      service.createDeploymentChannel({ name: 'Not A Valid Name', description: 'bad name' }, 7)
    ).rejects.toThrow(/Overseas - .*AUS-FIRE-STL-2026|domestic/);

    let thrown;
    try {
      await service.createDeploymentChannel({ name: 'Not A Valid Name' }, 7);
    } catch (error) {
      thrown = error;
    }
    expect(thrown.message).toMatch(/Overseas - /);
    expect(thrown.message).toMatch(/COUNTRY.*FUNCTION.*REGION.*SUFFIX/);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('rolls back the transaction and does not enqueue a sync operation when the INSERT fails', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO deployment_channels')) {
        return Promise.reject(new Error('db error'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      service.createDeploymentChannel({ name: 'Overseas - Fiji' }, 7)
    ).rejects.toThrow('db error');

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();
  });
});

describe('DeploymentChannelService.subscribe', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    service = new DeploymentChannelService();
  });

  it('checks is_active, inserts channel_memberships directly, enqueues add_user_to_group, and commits', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id, is_active FROM deployment_channels')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-deploy-42', is_active: true }] });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO channel_memberships')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.subscribe(42, 7);

    expect(result).toEqual({ success: true });

    const calls = mockClient.query.mock.calls;
    const calledSql = calls.map(([sql]) => sql);
    expect(calledSql[0]).toBe('BEGIN');
    expect(calledSql.some((sql) => sql.includes('INSERT INTO channel_memberships'))).toBe(true);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');

    // Direct INSERT, not Channel.addMember's upsert -- no ON CONFLICT clause.
    const insertCall = calls.find(([sql]) => sql.includes('INSERT INTO channel_memberships'));
    expect(insertCall[0]).not.toMatch(/ON CONFLICT/i);
    expect(insertCall[1]).toEqual([7, 42, 'read_write']);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      {
        target_user_id: 7,
        target_group_id: 'grp-deploy-42'
      },
      7,
      mockClient
    );

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with DeploymentChannelNotActiveError, rolls back, and does not mutate or enqueue when is_active is false', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id, is_active FROM deployment_channels')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-deploy-42', is_active: false }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.subscribe(42, 7)).rejects.toThrow(DeploymentChannelNotActiveError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO channel_memberships'))).toBe(false);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql).not.toContain('COMMIT');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with DeploymentChannelNotActiveError, rolls back, and does not mutate or enqueue when the channel does not exist', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id, is_active FROM deployment_channels')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.subscribe(999, 7)).rejects.toThrow(DeploymentChannelNotActiveError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO channel_memberships'))).toBe(false);
    expect(calledSql).toContain('ROLLBACK');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('propagates a duplicate-key error cleanly (not silently swallowed) when the INSERT hits the accepted collision risk', async () => {
    const duplicateKeyError = new Error(
      'duplicate key value violates unique constraint "channel_memberships_user_id_channel_id_key"'
    );
    duplicateKeyError.code = '23505';

    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id, is_active FROM deployment_channels')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-deploy-42', is_active: true }] });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO channel_memberships')) {
        return Promise.reject(duplicateKeyError);
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.subscribe(42, 7)).rejects.toThrow(
      'duplicate key value violates unique constraint'
    );
    await expect(service.subscribe(42, 7)).rejects.toMatchObject({ code: '23505' });

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql).not.toContain('COMMIT');
    // The enqueue happened before the failing INSERT, but the transaction
    // rolled back, so the overall operation is not treated as successful.
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('releases the client even when an error is thrown', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id, is_active FROM deployment_channels')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.subscribe(42, 7)).rejects.toThrow(DeploymentChannelNotActiveError);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('DeploymentChannelService.unsubscribe', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    service = new DeploymentChannelService();
  });

  it('deletes channel_memberships, enqueues remove_user_from_group, and commits regardless of is_active state', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id FROM deployment_channels')) {
        // Note: only authentik_group_id is selected -- is_active is not
        // checked at all for unsubscribe.
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-deploy-42' }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM channel_memberships')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.unsubscribe(42, 7);

    expect(result).toEqual({ success: true });

    const calls = mockClient.query.mock.calls;
    const calledSql = calls.map(([sql]) => sql);
    expect(calledSql[0]).toBe('BEGIN');
    expect(calledSql.some((sql) => sql.includes('DELETE FROM channel_memberships'))).toBe(true);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');

    const deleteCall = calls.find(([sql]) => sql.includes('DELETE FROM channel_memberships'));
    expect(deleteCall[1]).toEqual([7, 42]);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      {
        target_user_id: 7,
        target_group_id: 'grp-deploy-42'
      },
      7,
      mockClient
    );

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with DeploymentChannelNotFoundError, rolls back, and does not mutate or enqueue when the channel does not exist', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id FROM deployment_channels')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.unsubscribe(999, 7)).rejects.toThrow(DeploymentChannelNotFoundError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('DELETE FROM channel_memberships'))).toBe(false);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql).not.toContain('COMMIT');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('releases the client even when an error is thrown', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT authentik_group_id FROM deployment_channels')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.unsubscribe(42, 7)).rejects.toThrow(DeploymentChannelNotFoundError);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('DeploymentChannelService.deactivateExpired', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    service = new DeploymentChannelService();
  });

  it('is a no-op and returns cleanly when there are no expired channels', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE deployment_channels')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.deactivateExpired();

    expect(result).toEqual({ deactivatedCount: 0 });
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();

    const calledSql = pool.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('DELETE FROM channel_memberships'))).toBe(false);

    // Never applied when deployment_end_date is null: verified by the
    // WHERE clause on the UPDATE itself, not a post-hoc filter.
    const updateCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE deployment_channels')
    );
    expect(updateCall[0]).toContain('deployment_end_date <= NOW()');
    expect(updateCall[0]).toContain('is_active = true');
    expect(updateCall[0]).not.toMatch(/COALESCE/i);
  });

  it('deactivates a single expired channel, deletes its channel_memberships, and enqueues remove_all_members_from_group', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE deployment_channels')) {
        return Promise.resolve({
          rows: [{ id: 42, authentik_group_id: 'grp-deploy-42', is_active: false }]
        });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM channel_memberships')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.deactivateExpired();

    expect(result).toEqual({ deactivatedCount: 1 });

    const deleteCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes('DELETE FROM channel_memberships')
    );
    expect(deleteCall[1]).toEqual([42]);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_all_members_from_group',
      { channel_id: 42, target_group_id: 'grp-deploy-42' },
      null
    );
  });

  it('excludes a null-deployment_end_date channel from the returned/deactivated set (never touched)', async () => {
    // The bulk UPDATE's WHERE clause is what enforces exclusion; this
    // test simulates the DB-level behavior by having the mocked UPDATE
    // only ever RETURN the non-null-end-date row, confirming the service
    // code performs no additional client-side filtering that could mask
    // a would-be bug, and that a standing channel never appears in any
    // downstream cleanup call.
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE deployment_channels')) {
        // Only the expired, non-null-end-date channel (id 42) is
        // returned -- a standing channel (id 99, null deployment_end_date)
        // is never matched by the WHERE clause and so never appears here.
        return Promise.resolve({
          rows: [{ id: 42, authentik_group_id: 'grp-deploy-42', is_active: false }]
        });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM channel_memberships')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.deactivateExpired();

    expect(result).toEqual({ deactivatedCount: 1 });

    const deleteCalls = pool.query.mock.calls.filter(([sql]) =>
      sql.includes('DELETE FROM channel_memberships')
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][1]).toEqual([42]);

    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
      'remove_all_members_from_group',
      expect.objectContaining({ channel_id: 99 }),
      expect.anything()
    );
  });

  it('processes multiple expired channels in one call', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE deployment_channels')) {
        return Promise.resolve({
          rows: [
            { id: 1, authentik_group_id: 'grp-1', is_active: false },
            { id: 2, authentik_group_id: 'grp-2', is_active: false }
          ]
        });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM channel_memberships')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.deactivateExpired();

    expect(result).toEqual({ deactivatedCount: 2 });
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(2);
    expect(EventPublisher.publishOperation).toHaveBeenNthCalledWith(
      1,
      'remove_all_members_from_group',
      { channel_id: 1, target_group_id: 'grp-1' },
      null
    );
    expect(EventPublisher.publishOperation).toHaveBeenNthCalledWith(
      2,
      'remove_all_members_from_group',
      { channel_id: 2, target_group_id: 'grp-2' },
      null
    );

    const deleteCalls = pool.query.mock.calls.filter(([sql]) =>
      sql.includes('DELETE FROM channel_memberships')
    );
    expect(deleteCalls).toHaveLength(2);
  });

  it('logs and continues past a per-channel channel_memberships delete failure without aborting the rest of the batch', async () => {
    // The DELETE for channel 1 fails, channel 2 succeeds.
    pool.query.mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes('UPDATE deployment_channels')) {
        return Promise.resolve({
          rows: [
            { id: 1, authentik_group_id: 'grp-1', is_active: false },
            { id: 2, authentik_group_id: 'grp-2', is_active: false }
          ]
        });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM channel_memberships')) {
        if (params && params[0] === 1) {
          return Promise.reject(new Error('db delete failed'));
        }
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.deactivateExpired();

    // Both channels are still counted as deactivated (the UPDATE already
    // committed both regardless of downstream cleanup outcome).
    expect(result).toEqual({ deactivatedCount: 2 });

    // Only the successfully-cleaned-up channel enqueues.
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_all_members_from_group',
      { channel_id: 2, target_group_id: 'grp-2' },
      null
    );

    // The failure was logged rather than thrown/propagated.
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 1, authentikGroupId: 'grp-1' }),
      expect.stringContaining('Failed to complete membership cleanup')
    );
  });

  it('does not enqueue remove_all_members_from_group when the channel has no authentik_group_id yet', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('UPDATE deployment_channels')) {
        return Promise.resolve({
          rows: [{ id: 7, authentik_group_id: null, is_active: false }]
        });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM channel_memberships')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.deactivateExpired();

    expect(result).toEqual({ deactivatedCount: 1 });
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();

    const deleteCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes('DELETE FROM channel_memberships')
    );
    expect(deleteCall[1]).toEqual([7]);
  });
});
