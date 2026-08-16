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
const VendorChannelService = require('./VendorChannelService');
const {
  VendorChannelAlreadyActiveError,
  VendorChannelNotActiveError,
  VendorChannelProvisioningPendingError,
  TargetUserNotVendorError,
  ChannelNotFoundError,
  ChannelGroupNotProvisionedError,
  VendorChannelGrantNotActiveError,
  SYSTEM_USER_ID
} = require('./VendorChannelService');

describe('VendorChannelService.createVendorChannel', () => {
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
    service = new VendorChannelService();
  });

  it('inserts a vendor_channels row, enqueues create_vendor_channel_group, and commits when no active row exists', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id FROM vendor_channels')) {
        return Promise.resolve({ rows: [] }); // no active row
      }
      if (sql.includes('INSERT INTO vendor_channels')) {
        return Promise.resolve({ rows: [{ id: 55 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.createVendorChannel(7);

    expect(result).toEqual({ channelId: 55 });

    // Transactional order: BEGIN -> SELECT ... FOR UPDATE -> INSERT -> COMMIT
    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql[0]).toBe('BEGIN');
    expect(calledSql.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO vendor_channels'))).toBe(true);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_vendor_channel_group',
      { vendor_channel_id: 55 },
      7,
      mockClient
    );

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with VendorChannelAlreadyActiveError, rolls back, and does not enqueue when an active row already exists', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id FROM vendor_channels')) {
        return Promise.resolve({ rows: [{ id: 1 }] }); // an active row already exists
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.createVendorChannel(7)).rejects.toThrow(VendorChannelAlreadyActiveError);
    await expect(service.createVendorChannel(7)).rejects.toThrow(
      'An active Vendor_Channel already exists'
    );

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO vendor_channels'))).toBe(false);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql).not.toContain('COMMIT');

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows when the INSERT fails', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id FROM vendor_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO vendor_channels')) {
        return Promise.reject(new Error('db insert failed'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.createVendorChannel(7)).rejects.toThrow('db insert failed');

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
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
      if (sql.includes('SELECT id FROM vendor_channels')) {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.createVendorChannel(7)).rejects.toThrow(VendorChannelAlreadyActiveError);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('VendorChannelService.setVendorFlag', () => {
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
    service = new VendorChannelService();
  });

  it('sets is_vendor=true, enqueues add_user_to_group for VND only, and commits when an active channel with a populated authentik_group_id exists', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id, authentik_group_id FROM vendor_channels')) {
        return Promise.resolve({ rows: [{ id: 1, authentik_group_id: 'grp-vnd-123' }] });
      }
      if (sql.includes('UPDATE users SET is_vendor = true')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.setVendorFlag(42, true, 7);

    expect(result).toEqual({ success: true });

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql[0]).toBe('BEGIN');
    expect(calledSql.some((sql) => sql.includes('UPDATE users SET is_vendor = true'))).toBe(true);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');

    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      {
        target_user_id: 42,
        target_group_id: 'grp-vnd-123'
      },
      7,
      mockClient
    );

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with VendorChannelNotActiveError, rolls back, and does not mutate or enqueue when no active vendor_channels row exists', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id, authentik_group_id FROM vendor_channels')) {
        return Promise.resolve({ rows: [] }); // no active row
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.setVendorFlag(42, true, 7)).rejects.toThrow(
      VendorChannelNotActiveError
    );

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('UPDATE users SET is_vendor'))).toBe(false);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql).not.toContain('COMMIT');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with VendorChannelProvisioningPendingError, rolls back, and does not mutate or enqueue when the active row has a null authentik_group_id', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id, authentik_group_id FROM vendor_channels')) {
        return Promise.resolve({ rows: [{ id: 1, authentik_group_id: null }] }); // still provisioning
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.setVendorFlag(42, true, 7)).rejects.toThrow(
      VendorChannelProvisioningPendingError
    );
    await expect(service.setVendorFlag(42, true, 7)).rejects.toThrow(
      'Vendor channel group is still being provisioned, try again shortly'
    );

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('UPDATE users SET is_vendor'))).toBe(false);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql).not.toContain('COMMIT');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('sets is_vendor=false and enqueues remove_user_from_group for VND when clearing the flag with a known group id', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE users SET is_vendor = false')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT authentik_group_id FROM vendor_channels')) {
        return Promise.resolve({ rows: [{ authentik_group_id: 'grp-vnd-123' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.setVendorFlag(42, false, 7);

    expect(result).toEqual({ success: true });

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('UPDATE users SET is_vendor = false'))).toBe(
      true
    );
    expect(calledSql).toContain('COMMIT');

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      {
        target_user_id: 42,
        target_group_id: 'grp-vnd-123'
      },
      7,
      mockClient
    );
  });

  it('sets is_vendor=false and does not enqueue when clearing the flag and no active channel/group id is known', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE users SET is_vendor = false')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT authentik_group_id FROM vendor_channels')) {
        return Promise.resolve({ rows: [] }); // no active channel at all
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.setVendorFlag(42, false, 7);

    expect(result).toEqual({ success: true });
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql).toContain('COMMIT');
  });

  it('releases the client even when an error is thrown', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id, authentik_group_id FROM vendor_channels')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.setVendorFlag(42, true, 7)).rejects.toThrow(VendorChannelNotActiveError);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('VendorChannelService.createGrant', () => {
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
    service = new VendorChannelService();
  });

  it('validates is_vendor, resolves the channel group id, inserts the grant, enqueues add_user_to_group, writes an audit_logs row, and commits', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT is_vendor FROM users')) {
        return Promise.resolve({ rows: [{ is_vendor: true }] });
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({ rows: [] }); // not a bch channel
      }
      if (sql.includes('FROM region_channels')) {
        return Promise.resolve({ rows: [{ group_id: 'grp-region-42' }] }); // matches here
      }
      if (sql.includes('FROM deployment_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM vendor_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO vendor_channel_grants')) {
        return Promise.resolve({ rows: [{ id: 99 }] });
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.createGrant(42, 7, 3, null);

    expect(result).toEqual({ grantId: 99 });

    const calls = mockClient.query.mock.calls;
    const calledSql = calls.map(([sql]) => sql);
    expect(calledSql[0]).toBe('BEGIN');
    expect(calledSql.some((sql) => sql.includes('INSERT INTO vendor_channel_grants'))).toBe(true);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO audit_logs'))).toBe(true);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');

    // Insert used the vendor user id, channel id, granting user id, and expiresAt
    const insertGrantCall = calls.find(([sql]) => sql.includes('INSERT INTO vendor_channel_grants'));
    expect(insertGrantCall[1]).toEqual([42, 7, 3, null]);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      {
        target_user_id: 42,
        target_group_id: 'grp-region-42'
      },
      3,
      mockClient
    );

    const auditCall = calls.find(([sql]) => sql.includes('INSERT INTO audit_logs'));
    expect(auditCall[1]).toEqual([
      3,
      'vendor_channel_grant_created',
      'vendor_channel_grant',
      99,
      JSON.stringify({ vendorUserId: 42, channelId: 7 })
    ]);

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with TargetUserNotVendorError, rolls back, and does not insert a grant when the target user is not a vendor', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT is_vendor FROM users')) {
        return Promise.resolve({ rows: [{ is_vendor: false }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.createGrant(42, 7, 3, null)).rejects.toThrow(TargetUserNotVendorError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO vendor_channel_grants'))).toBe(
      false
    );
    expect(calledSql.some((sql) => sql.includes('FROM bch_channels'))).toBe(false);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql).not.toContain('COMMIT');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with ChannelNotFoundError, rolls back, and does not insert a grant when channelId matches no channel-like table', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT is_vendor FROM users')) {
        return Promise.resolve({ rows: [{ is_vendor: true }] });
      }
      // No table matches channelId 999
      return Promise.resolve({ rows: [] });
    });

    await expect(service.createGrant(42, 999, 3, null)).rejects.toThrow(ChannelNotFoundError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO vendor_channel_grants'))).toBe(
      false
    );
    expect(calledSql).toContain('ROLLBACK');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('rejects with ChannelGroupNotProvisionedError, rolls back, and does not insert a grant when the resolved channel has no group id yet', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT is_vendor FROM users')) {
        return Promise.resolve({ rows: [{ is_vendor: true }] });
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({ rows: [{ group_id: null }] }); // matches, but not provisioned
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.createGrant(42, 7, 3, null)).rejects.toThrow(
      ChannelGroupNotProvisionedError
    );

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO vendor_channel_grants'))).toBe(
      false
    );
    expect(calledSql).toContain('ROLLBACK');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('releases the client even when an error is thrown', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT is_vendor FROM users')) {
        return Promise.resolve({ rows: [{ is_vendor: false }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.createGrant(42, 7, 3, null)).rejects.toThrow(TargetUserNotVendorError);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('VendorChannelService.revokeGrant', () => {
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
    service = new VendorChannelService();
  });

  it('sets revoked_at/revoked_by, enqueues remove_user_from_group, writes an audit_logs row, and commits', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id, user_id, channel_id FROM vendor_channel_grants')) {
        return Promise.resolve({ rows: [{ id: 99, user_id: 42, channel_id: 7 }] });
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM region_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM deployment_channels')) {
        return Promise.resolve({ rows: [{ group_id: 'grp-deploy-7' }] }); // matches here
      }
      if (sql.includes('FROM vendor_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE vendor_channel_grants')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.revokeGrant(99, 5);

    expect(result).toEqual({ success: true });

    const calls = mockClient.query.mock.calls;
    const calledSql = calls.map(([sql]) => sql);
    expect(calledSql[0]).toBe('BEGIN');
    expect(calledSql.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(calledSql.some((sql) => sql.includes('UPDATE vendor_channel_grants'))).toBe(true);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO audit_logs'))).toBe(true);
    expect(calledSql).toContain('COMMIT');
    expect(calledSql).not.toContain('ROLLBACK');

    const updateCall = calls.find(([sql]) => sql.includes('UPDATE vendor_channel_grants'));
    expect(updateCall[1]).toEqual([5, 99]);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      {
        target_user_id: 42,
        target_group_id: 'grp-deploy-7'
      },
      5,
      mockClient
    );

    const auditCall = calls.find(([sql]) => sql.includes('INSERT INTO audit_logs'));
    expect(auditCall[1]).toEqual([
      5,
      'vendor_channel_grant_revoked',
      'vendor_channel_grant',
      99,
      JSON.stringify({ vendorUserId: 42, channelId: 7 })
    ]);

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with VendorChannelGrantNotActiveError, rolls back, and does not mutate when the grant does not exist', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id, user_id, channel_id FROM vendor_channel_grants')) {
        return Promise.resolve({ rows: [] }); // not found
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.revokeGrant(404, 5)).rejects.toThrow(VendorChannelGrantNotActiveError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('UPDATE vendor_channel_grants'))).toBe(false);
    expect(calledSql).toContain('ROLLBACK');
    expect(calledSql).not.toContain('COMMIT');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects with VendorChannelGrantNotActiveError, rolls back, and does not mutate when the grant is already revoked', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id, user_id, channel_id FROM vendor_channel_grants')) {
        // The query filters on revoked_at IS NULL, so an already-revoked
        // grant is indistinguishable from "not found" at this layer.
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.revokeGrant(99, 5)).rejects.toThrow(VendorChannelGrantNotActiveError);

    const calledSql = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('UPDATE vendor_channel_grants'))).toBe(false);
    expect(calledSql).toContain('ROLLBACK');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('releases the client even when an error is thrown', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT id, user_id, channel_id FROM vendor_channel_grants')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.revokeGrant(99, 5)).rejects.toThrow(VendorChannelGrantNotActiveError);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('VendorChannelService.expireGrants', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    service = new VendorChannelService();
  });

  it('is a no-op and returns cleanly when there are no expired grants', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('UPDATE vendor_channel_grants')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.expireGrants();

    expect(result).toEqual({ expiredCount: 0 });
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();

    const calledSql = pool.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes('INSERT INTO audit_logs'))).toBe(false);
  });

  it('revokes a single expired grant with the SYSTEM_USER_ID sentinel, enqueues remove_user_from_group with the resolved group id, and writes an audit_logs row', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('UPDATE vendor_channel_grants')) {
        return Promise.resolve({
          rows: [{ id: 99, user_id: 42, channel_id: 7 }]
        });
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM region_channels')) {
        return Promise.resolve({ rows: [{ group_id: 'grp-region-42' }] });
      }
      if (sql.includes('FROM deployment_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM vendor_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.expireGrants();

    expect(result).toEqual({ expiredCount: 1 });

    // The bulk UPDATE uses the SYSTEM_USER_ID sentinel as revoked_by.
    const updateCall = pool.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE vendor_channel_grants')
    );
    expect(updateCall[1]).toEqual([SYSTEM_USER_ID]);
    expect(SYSTEM_USER_ID).toBe(-1);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      {
        target_user_id: 42,
        target_group_id: 'grp-region-42'
      },
      SYSTEM_USER_ID
    );

    const auditCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_logs'));
    expect(auditCall[1]).toEqual([
      SYSTEM_USER_ID,
      'vendor_channel_grant_expired',
      'vendor_channel_grant',
      99,
      JSON.stringify({ vendorUserId: 42, channelId: 7 })
    ]);
  });

  it('processes multiple expired grants in one call', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('UPDATE vendor_channel_grants')) {
        return Promise.resolve({
          rows: [
            { id: 1, user_id: 10, channel_id: 100 },
            { id: 2, user_id: 20, channel_id: 200 }
          ]
        });
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM region_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM deployment_channels')) {
        return Promise.resolve({ rows: [{ group_id: 'grp-deploy' }] });
      }
      if (sql.includes('FROM vendor_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.expireGrants();

    expect(result).toEqual({ expiredCount: 2 });
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(2);
    expect(EventPublisher.publishOperation).toHaveBeenNthCalledWith(
      1,
      'remove_user_from_group',
      { target_user_id: 10, target_group_id: 'grp-deploy' },
      SYSTEM_USER_ID
    );
    expect(EventPublisher.publishOperation).toHaveBeenNthCalledWith(
      2,
      'remove_user_from_group',
      { target_user_id: 20, target_group_id: 'grp-deploy' },
      SYSTEM_USER_ID
    );

    const auditCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit_logs'));
    expect(auditCalls).toHaveLength(2);
  });

  it('logs and continues past a per-grant group-resolution failure without aborting the rest of the batch', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('UPDATE vendor_channel_grants')) {
        return Promise.resolve({
          rows: [
            { id: 1, user_id: 10, channel_id: 999 }, // channel since deleted: resolves to none
            { id: 2, user_id: 20, channel_id: 200 } // resolves fine
          ]
        });
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM region_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM deployment_channels')) {
        // channel_id 200 matches here; channel_id 999 matches nowhere
        // (query is keyed by WHERE id = $1, so a mismatched id returns
        // no rows regardless of table, but we simulate via params)
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM vendor_channels')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('INSERT INTO audit_logs')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Make resolveChannelGroupId behave per-channel: throw for 999,
    // succeed for 200. Spying keeps the rest of expireGrants exercising
    // real behavior while isolating the resolution failure to one grant.
    const resolveSpy = jest.spyOn(service, 'resolveChannelGroupId');
    resolveSpy.mockImplementation(async (channelId) => {
      if (channelId === 999) {
        throw new ChannelNotFoundError(channelId);
      }
      return { table: 'deployment_channels', groupId: 'grp-deploy' };
    });

    const result = await service.expireGrants();

    // Both grants are still counted as expired (the UPDATE already
    // committed both regardless of downstream cleanup outcome).
    expect(result).toEqual({ expiredCount: 2 });

    // Only the successfully-resolved grant enqueues/audits.
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      { target_user_id: 20, target_group_id: 'grp-deploy' },
      SYSTEM_USER_ID
    );

    const auditCalls = pool.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit_logs'));
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][1]).toEqual([
      SYSTEM_USER_ID,
      'vendor_channel_grant_expired',
      'vendor_channel_grant',
      2,
      JSON.stringify({ vendorUserId: 20, channelId: 200 })
    ]);

    // The failure was logged rather than thrown/propagated.
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 1, vendorUserId: 10, channelId: 999 }),
      expect.stringContaining('Failed to complete Authentik cleanup/audit logging')
    );

    resolveSpy.mockRestore();
  });
});
