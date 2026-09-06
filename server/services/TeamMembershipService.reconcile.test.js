'use strict';

/**
 * Authentik scaling (Phase 3): with BULK_GROUP_RECONCILE_ENABLED on,
 * `addUserToTeam`/`removeUserFromTeam` enqueue a reconcile_owned_group per
 * affected team channel INSTEAD of the per-user add/remove_user_from_group,
 * while STILL keeping the per-user assign_user_to_global_channels (add path)
 * and the targeted teamless global-channel removal. This file mocks the flag
 * ON; the flag-OFF behaviour is covered by TeamMembershipService.test.js.
 */

jest.mock('../config/database', () => ({ connect: jest.fn(), query: jest.fn() }));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn(),
  publishOperationsBatch: jest.fn(),
  publishBulkOperation: jest.fn()
}));
jest.mock('../models/Team', () => ({ getFullMemberList: jest.fn() }));
jest.mock('../config/cloudtak', () => ({ isCloudTakEnabled: () => false }));

// Flag ON for this whole file.
jest.mock('../config/bulkGroupReconcile', () => ({
  isBulkGroupReconcileEnabled: () => true,
  isBulkGroupReconcileDryRun: () => true
}));

const mockEnqueueTeamChannelReconcile = jest.fn();
jest.mock('./OwnedGroupReconcileEnqueuer', () => ({
  enqueueTeamChannelReconcile: (...args) => mockEnqueueTeamChannelReconcile(...args)
}));

const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const TeamMembershipService = require('./TeamMembershipService');

function buildMockClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnqueueTeamChannelReconcile.mockResolvedValue(1);
});

describe('addUserToTeam with the reconciler enabled', () => {
  it('enqueues a team_channel reconcile per affected channel INSTEAD of add_user_to_group, threading the client', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ id: 55, authentik_group_id: 'grp-team' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);

    await TeamMembershipService.addUserToTeam(1, 2, 'member', 9);

    // Reconcile enqueued for the channel; NO per-user add_user_to_group.
    expect(mockEnqueueTeamChannelReconcile).toHaveBeenCalledWith(55, 9, mockClient);
    const addCalls = EventPublisher.publishOperation.mock.calls.filter((c) => c[0] === 'add_user_to_group');
    expect(addCalls).toHaveLength(0);
  });

  it('STILL enqueues the per-user assign_user_to_global_channels (kept, not flipped)', async () => {
    const mockClient = buildMockClient(() => Promise.resolve({ rows: [] }));
    pool.connect.mockResolvedValue(mockClient);

    await TeamMembershipService.addUserToTeam(1, 2, 'member', 9);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'assign_user_to_global_channels',
      { target_user_id: 1 },
      9,
      mockClient
    );
  });

  it('enqueues a reconcile even for a channel whose authentik_group_id is not yet set', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ id: 77, authentik_group_id: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);

    await TeamMembershipService.addUserToTeam(1, 2, 'member', 9);

    expect(mockEnqueueTeamChannelReconcile).toHaveBeenCalledWith(77, 9, mockClient);
  });
});

describe('removeUserFromTeam with the reconciler enabled', () => {
  it('enqueues a team_channel reconcile per current channel INSTEAD of remove_user_from_group', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [{ id: 55, authentik_group_id: 'grp-team' }] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: '1' }] }); // still has other teams
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);

    await TeamMembershipService.removeUserFromTeam(1, 9);

    expect(mockEnqueueTeamChannelReconcile).toHaveBeenCalledWith(55, 9, mockClient);
    const removeCalls = EventPublisher.publishOperation.mock.calls.filter((c) => c[0] === 'remove_user_from_group');
    expect(removeCalls).toHaveLength(0);
  });

  it('KEEPS the targeted per-user global-channel removal when the user is left teamless (reconcile cannot do it)', async () => {
    const mockClient = buildMockClient((sql) => {
      if (sql.includes('SELECT c.id, c.authentik_group_id')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('SELECT COUNT(*) as count FROM team_memberships')) {
        return Promise.resolve({ rows: [{ count: 0 }] }); // no teams left
      }
      if (sql.includes('FROM bch_channels')) {
        return Promise.resolve({ rows: [{ read_group_id: 'grp-read', write_group_id: 'grp-write' }] });
      }
      if (sql.includes('SELECT username FROM users WHERE id = $1')) {
        return Promise.resolve({ rows: [{ username: 'alice' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);

    await TeamMembershipService.removeUserFromTeam(1, 9);

    // The teamless global removal is still a per-user remove_user_from_group.
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'remove_user_from_group',
      { target_user_id: 1, target_group_id: 'grp-read' },
      9,
      mockClient
    );
  });
});
