jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../models/Channel', () => ({
  createCustomChannel: jest.fn(),
  prepareCustomChannelCreation: jest.fn(),
  insertCustomChannelAndMembers: jest.fn(),
  ChannelLimitError: class ChannelLimitError extends Error {}
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Channel = require('../models/Channel');
const ChannelRequestService = require('./ChannelRequestService');

describe('ChannelRequestService.requestChannel', () => {
  const teamId = 10;
  const customSuffix = 'Ops';
  const memberPermissions = [{ userId: 1, permission: 'read_write' }];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates immediately to Channel.createCustomChannel for a Global_Manager, without touching channel_requests', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ is_global_manager: true }] });
    Channel.createCustomChannel.mockResolvedValueOnce({ id: 55, name: 'created-channel' });

    const result = await ChannelRequestService.requestChannel(teamId, customSuffix, memberPermissions, 7);

    expect(Channel.createCustomChannel).toHaveBeenCalledWith(teamId, customSuffix, memberPermissions);
    expect(result).toEqual({ id: 55, name: 'created-channel' });

    // Only the is_global_manager lookup should have hit the pool; no
    // INSERT INTO channel_requests should have been issued.
    expect(pool.query).toHaveBeenCalledTimes(1);
    const insertCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('channel_requests')
    );
    expect(insertCall).toBeUndefined();
  });

  it('inserts a pending channel_requests row for a non-Global_Manager, without creating a channel or enqueueing anything', async () => {
    const pendingRow = {
      id: 1,
      team_id: teamId,
      custom_suffix: customSuffix,
      member_permissions: memberPermissions,
      requested_by: 3,
      status: 'pending'
    };
    pool.query
      .mockResolvedValueOnce({ rows: [{ is_global_manager: false }] }) // isGlobalManager check
      .mockResolvedValueOnce({ rows: [pendingRow] }); // INSERT INTO channel_requests

    const result = await ChannelRequestService.requestChannel(teamId, customSuffix, memberPermissions, 3);

    expect(Channel.createCustomChannel).not.toHaveBeenCalled();
    expect(result).toEqual(pendingRow);

    const insertCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO channel_requests')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain("'pending'");
    expect(insertCall[1]).toEqual([teamId, customSuffix, JSON.stringify(memberPermissions), 3]);
  });

  it('treats a user with no is_global_manager row (or a false/null value) as a non-Global_Manager', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // isGlobalManager lookup finds no user row
      .mockResolvedValueOnce({ rows: [{ id: 2, status: 'pending' }] });

    await ChannelRequestService.requestChannel(teamId, customSuffix, memberPermissions, 999);

    expect(Channel.createCustomChannel).not.toHaveBeenCalled();
  });
});

describe('ChannelRequestService.approveChannelRequest', () => {
  const requestId = 42;
  const approverId = 9;
  const pendingRow = {
    id: requestId,
    team_id: 10,
    custom_suffix: 'Ops',
    member_permissions: [{ userId: 1, permission: 'read_write' }],
    requested_by: 3,
    status: 'pending'
  };
  const preparedPhase1 = {
    fullChannelName: 'Teams - ALPHA - Ops',
    description: 'Custom channel: Teams - ALPHA - Ops',
    channelDbName: 'teams-alpha-ops',
    rwGroup: { pk: 'grp-rw' },
    readGroup: { pk: 'grp-read' },
    writeGroup: { pk: 'grp-write' }
  };

  function buildMockClient() {
    return { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('approves successfully: status flip and Channel.createCustomChannel-equivalent creation both commit in one transaction', async () => {
    // Pre-fetch (Phase 1) sees the pending row.
    pool.query.mockResolvedValueOnce({ rows: [pendingRow] });
    Channel.prepareCustomChannelCreation.mockResolvedValueOnce(preparedPhase1);

    const client = buildMockClient();
    // Re-check inside the transaction also sees the pending row.
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes("SELECT * FROM channel_requests")) {
        return Promise.resolve({ rows: [pendingRow] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);

    const createdChannel = { id: 501, name: 'teams-alpha-ops', team_id: 10 };
    Channel.insertCustomChannelAndMembers.mockResolvedValueOnce(createdChannel);

    const result = await ChannelRequestService.approveChannelRequest(requestId, approverId);

    expect(result).toEqual(createdChannel);

    // Team lookup + Authentik group creation happened before any client
    // was acquired.
    expect(Channel.prepareCustomChannelCreation).toHaveBeenCalledWith(pendingRow.team_id, pendingRow.custom_suffix);

    // Status flip UPDATE ran on the transactional client.
    const updateCall = client.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE channel_requests') && sql.includes("status = 'approved'")
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual([requestId, approverId]);

    // Channel creation ran on the SAME client, after the status flip.
    expect(Channel.insertCustomChannelAndMembers).toHaveBeenCalledWith(
      pendingRow.team_id,
      pendingRow.custom_suffix,
      pendingRow.member_permissions,
      preparedPhase1,
      client
    );

    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls[0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(sqlCalls).toContain('COMMIT');
    expect(sqlCalls).not.toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects an already-processed request without any mutation, and never acquires a client', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // pre-fetch finds no pending row

    await expect(ChannelRequestService.approveChannelRequest(requestId, approverId))
      .rejects.toThrow(ChannelRequestService.ChannelRequestAlreadyProcessedError);

    expect(Channel.prepareCustomChannelCreation).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rolls back the entire transaction -- including the status flip -- leaving the request pending, when Channel creation fails (e.g. channel limit reached)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [pendingRow] });
    Channel.prepareCustomChannelCreation.mockResolvedValueOnce(preparedPhase1);

    const client = buildMockClient();
    client.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT * FROM channel_requests')) {
        return Promise.resolve({ rows: [pendingRow] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);

    const limitError = new Channel.ChannelLimitError();
    Channel.insertCustomChannelAndMembers.mockRejectedValueOnce(limitError);

    await expect(ChannelRequestService.approveChannelRequest(requestId, approverId))
      .rejects.toThrow(Channel.ChannelLimitError);

    const sqlCalls = client.query.mock.calls.map(([sql]) => sql);
    // The status-flip UPDATE was issued on this transaction...
    expect(sqlCalls.some((sql) => typeof sql === 'string' && sql.includes('UPDATE channel_requests'))).toBe(true);
    // ...but the whole transaction rolled back, so it never committed.
    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('ChannelRequestService.denyChannelRequest', () => {
  const requestId = 42;
  const denierId = 9;
  const denialReason = 'Team already has enough channels for this purpose';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('denies a pending request via a single UPDATE, setting status/denial_reason/processed_by/processed_at', async () => {
    const deniedRow = {
      id: requestId,
      status: 'denied',
      denial_reason: denialReason,
      processed_by: denierId,
      processed_at: new Date()
    };
    pool.query.mockResolvedValueOnce({ rows: [deniedRow] });

    const result = await ChannelRequestService.denyChannelRequest(requestId, denierId, denialReason);

    expect(result).toEqual(deniedRow);

    // No transaction should be opened -- design.md explicitly calls for
    // a single pool.query UPDATE, not pool.connect()/BEGIN/COMMIT.
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('UPDATE channel_requests');
    expect(sql).toContain("status = 'denied'");
    expect(sql).toContain('denial_reason');
    expect(sql).toContain('processed_by');
    expect(sql).toContain('processed_at');
    expect(sql).toContain("WHERE id = $1 AND status = 'pending'");
    expect(params).toEqual([requestId, denialReason, denierId]);
  });

  it('rejects an already-processed (or non-existent) request without any mutation', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE affected zero rows

    await expect(ChannelRequestService.denyChannelRequest(requestId, denierId, denialReason))
      .rejects.toThrow(ChannelRequestService.ChannelRequestAlreadyProcessedError);

    // The (single, no-op) UPDATE still ran, re-checking pending status,
    // but affected zero rows -- no separate mutating call was made.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
