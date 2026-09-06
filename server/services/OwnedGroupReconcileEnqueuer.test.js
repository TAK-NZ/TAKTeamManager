'use strict';

/**
 * Authentik scaling (Phase 3): the thin reconcile enqueuer. Asserts each
 * helper enqueues `reconcile_owned_group` with the right group_kind + id,
 * threads the client, dedupes, and (for the global/tier/sweep helpers)
 * reads the active-channel id lists.
 */

const mockQuery = jest.fn();
jest.mock('../config/database', () => ({ query: mockQuery }));

// The enqueuer routes every reconcile through the coalescing
// publishReconcileOwnedGroup (payload, createdBy, client) — NOT the raw
// publishOperation — so at most one PENDING op per group exists.
const mockPublish = jest.fn();
jest.mock('./EventPublisher', () => ({
  publishReconcileOwnedGroup: (...args) => mockPublish(...args)
}));

const enqueuer = require('./OwnedGroupReconcileEnqueuer');

beforeEach(() => {
  jest.clearAllMocks();
  mockPublish.mockResolvedValue(1);
});

describe('enqueueTeamChannelReconcile', () => {
  it('enqueues reconcile_owned_group{team_channel, channel_id}, threading the client', async () => {
    const client = { query: jest.fn() };
    await enqueuer.enqueueTeamChannelReconcile(7, 42, client);

    expect(mockPublish).toHaveBeenCalledWith(
      { group_kind: 'team_channel', channel_id: 7 },
      42,
      client
    );
  });
});

describe('enqueueTeamChannelReconciles', () => {
  it('enqueues one op per UNIQUE channel id', async () => {
    await enqueuer.enqueueTeamChannelReconciles([1, 2, 2, 3, null, undefined], null, null);

    // 3 unique non-null ids.
    expect(mockPublish).toHaveBeenCalledTimes(3);
    const channelIds = mockPublish.mock.calls.map((c) => c[0].channel_id).sort();
    expect(channelIds).toEqual([1, 2, 3]);
  });
});

describe('enqueueAllGlobalChannelReconciles', () => {
  it('enqueues bch_read + bch_write per active BCH channel, and region per active region channel', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 11 }] }) // bch_channels
      .mockResolvedValueOnce({ rows: [{ id: 20 }] }); // region_channels

    const result = await enqueuer.enqueueAllGlobalChannelReconciles(null, null);

    // 2 BCH channels x 2 groups + 1 region = 5 ops.
    expect(mockPublish).toHaveBeenCalledTimes(5);
    expect(result.bchOps).toHaveLength(4);
    expect(result.regionOps).toHaveLength(1);

    const kinds = mockPublish.mock.calls.map((c) => c[0].group_kind).sort();
    expect(kinds).toEqual(['bch_read', 'bch_read', 'bch_write', 'bch_write', 'region']);
  });

  it('reads the active-channel lists (is_active = true)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await enqueuer.enqueueAllGlobalChannelReconciles(null, null);
    expect(mockQuery.mock.calls[0][0]).toContain('is_active = true');
    expect(mockQuery.mock.calls[1][0]).toContain('is_active = true');
  });
});

describe('enqueueRegionTierReconciles', () => {
  it('enqueues region per active region channel of the given tier', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 30 }, { id: 31 }] });

    const ids = await enqueuer.enqueueRegionTierReconciles('response', 42, null);

    expect(ids).toHaveLength(2);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('is_active = true');
    expect(params).toEqual(['response']);
    expect(mockPublish).toHaveBeenCalledWith(
      { group_kind: 'region', region_channel_id: 30 },
      42,
      null
    );
  });
});

describe('sweepAllOwnedGroups', () => {
  it('enqueues team_channel per primary channel, global reconciles, and cloudtak per team when includeCloudTak', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] }) // channels (primary)
      .mockResolvedValueOnce({ rows: [{ id: 10 }] }) // bch_channels (from enqueueAllGlobalChannelReconciles)
      .mockResolvedValueOnce({ rows: [{ id: 20 }] }) // region_channels
      .mockResolvedValueOnce({ rows: [{ id: 100 }, { id: 101 }] }); // teams (cloudtak)

    const counts = await enqueuer.sweepAllOwnedGroups({ includeCloudTak: true });

    expect(counts).toEqual({ teamChannel: 2, bch: 2, region: 1, cloudtak: 2 });
    // Confirm the primary-channel query is scoped to is_primary.
    expect(mockQuery.mock.calls[0][0]).toContain('is_primary = true');
  });

  it('omits cloudtak reconciles when includeCloudTak is false (and never queries teams)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // channels
      .mockResolvedValueOnce({ rows: [] }) // bch
      .mockResolvedValueOnce({ rows: [] }); // region

    const counts = await enqueuer.sweepAllOwnedGroups({ includeCloudTak: false });

    expect(counts.cloudtak).toBe(0);
    // Only 3 queries ran (channels, bch, region) -- no teams query.
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});
