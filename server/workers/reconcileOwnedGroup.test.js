'use strict';

/**
 * Authentik scaling (Phase 2): the Sync_Worker's `reconcile_owned_group`
 * dispatch handler.
 *
 * Asserts the handler's control flow (the desired-set queries + PATCH
 * themselves are covered by OwnedGroupReconciler.test.js):
 *   - feature flag OFF  -> immediate no-op, no DB read, no reconcile;
 *   - each group_kind resolves its owning row's group id and delegates to
 *     the matching desired-set query + replaceGroupMembers;
 *   - a missing owning row  -> satisfied no-op (no PATCH);
 *   - a null group id       -> RETRYABLE (its create op hasn't drained);
 *   - a missing kind id     -> PERMANENT payload defect;
 *   - an unknown group_kind -> PERMANENT;
 *   - a CloudTAK group not yet created -> RETRYABLE.
 */

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({ on: jest.fn(), query: jest.fn(), connect: jest.fn(), end: jest.fn() }))
}));

jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() }))
}));

jest.mock('../models/Team', () => ({ getAncestorChain: jest.fn(), getOrganisationTeams: jest.fn() }));
jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn(),
  publishOperationsBatch: jest.fn(),
  publishBulkOperation: jest.fn()
}));

// The reconciler service is mocked so we assert delegation, not its internals.
jest.mock('../services/OwnedGroupReconciler', () => ({
  desiredTeamChannelMembers: jest.fn(),
  desiredBchReadMembers: jest.fn(),
  desiredBchWriteMembers: jest.fn(),
  desiredRegionMembers: jest.fn(),
  desiredCloudTakMembers: jest.fn(),
  replaceGroupMembers: jest.fn()
}));

const mockEnabled = jest.fn();
jest.mock('../config/bulkGroupReconcile', () => ({
  isBulkGroupReconcileEnabled: () => mockEnabled(),
  isBulkGroupReconcileDryRun: jest.fn(() => true)
}));

const SyncWorker = require('./syncWorker');
const reconciler = require('../services/OwnedGroupReconciler');
const { AuthentikApiError } = require('./apiErrors');

describe('SyncWorker.reconcileOwnedGroup', () => {
  let worker;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new SyncWorker();
    worker.pool.query = jest.fn();
    mockEnabled.mockReturnValue(true);
    reconciler.replaceGroupMembers.mockResolvedValue({ patched: true, dryRun: false, memberCount: 0 });
  });

  it('is an immediate no-op when the feature flag is off (no DB read, no reconcile)', async () => {
    mockEnabled.mockReturnValue(false);

    await worker.reconcileOwnedGroup({ group_kind: 'team_channel', channel_id: 1 });

    expect(worker.pool.query).not.toHaveBeenCalled();
    expect(reconciler.desiredTeamChannelMembers).not.toHaveBeenCalled();
    expect(reconciler.replaceGroupMembers).not.toHaveBeenCalled();
  });

  it('team_channel: resolves the channel row, computes members for its team, and PATCHes the group', async () => {
    worker.pool.query.mockResolvedValue({ rows: [{ team_id: 42, authentik_group_id: 'grp-uuid' }] });
    reconciler.desiredTeamChannelMembers.mockResolvedValue(['1', '2']);

    await worker.reconcileOwnedGroup({ group_kind: 'team_channel', channel_id: 9 });

    expect(reconciler.desiredTeamChannelMembers).toHaveBeenCalledWith(42, worker.pool);
    expect(reconciler.replaceGroupMembers).toHaveBeenCalledWith('grp-uuid', ['1', '2'], expect.objectContaining({ groupKind: 'team_channel' }));
  });

  it('bch_read: delegates to desiredBchReadMembers with the read_group_id', async () => {
    worker.pool.query.mockResolvedValue({ rows: [{ read_group_id: 'read-uuid' }] });
    reconciler.desiredBchReadMembers.mockResolvedValue(['1', '99']);

    await worker.reconcileOwnedGroup({ group_kind: 'bch_read', bch_channel_id: 3 });

    expect(reconciler.desiredBchReadMembers).toHaveBeenCalledWith(3, worker.pool);
    expect(reconciler.replaceGroupMembers).toHaveBeenCalledWith('read-uuid', ['1', '99'], expect.any(Object));
  });

  it('bch_write: delegates to desiredBchWriteMembers with the write_group_id', async () => {
    worker.pool.query.mockResolvedValue({ rows: [{ write_group_id: 'write-uuid' }] });
    reconciler.desiredBchWriteMembers.mockResolvedValue(['99']);

    await worker.reconcileOwnedGroup({ group_kind: 'bch_write', bch_channel_id: 3 });

    expect(reconciler.desiredBchWriteMembers).toHaveBeenCalledWith(3, worker.pool);
    expect(reconciler.replaceGroupMembers).toHaveBeenCalledWith('write-uuid', ['99'], expect.any(Object));
  });

  it('bch_write: a NULL write_group_id is a SATISFIED NO-OP, not a retryable defer (read-only broadcast channel with no write group)', async () => {
    // Regression guard: a read-only BCH channel imported via "Sync
    // Existing Channels" (only a _READ group existed in Authentik) has
    // write_group_id = NULL by design. This must NOT throw a retryable
    // error and defer forever (the one bch_write op that sat ~15h behind
    // in the queue) -- there is no write group to reconcile, so it is a
    // no-op success: no desired-set query, no PATCH, no throw.
    worker.pool.query.mockResolvedValue({ rows: [{ write_group_id: null }] });

    await expect(
      worker.reconcileOwnedGroup({ group_kind: 'bch_write', bch_channel_id: 5 })
    ).resolves.toBeUndefined();

    expect(reconciler.desiredBchWriteMembers).not.toHaveBeenCalled();
    expect(reconciler.replaceGroupMembers).not.toHaveBeenCalled();
  });

  it('region: delegates to desiredRegionMembers with the group_id', async () => {
    worker.pool.query.mockResolvedValue({ rows: [{ group_id: 'region-uuid' }] });
    reconciler.desiredRegionMembers.mockResolvedValue(['5']);

    await worker.reconcileOwnedGroup({ group_kind: 'region', region_channel_id: 8 });

    expect(reconciler.desiredRegionMembers).toHaveBeenCalledWith(8, worker.pool);
    expect(reconciler.replaceGroupMembers).toHaveBeenCalledWith('region-uuid', ['5'], expect.any(Object));
  });

  it('cloudtak: resolves the group UUID by name, then reconciles to the Direct_Admin_Set', async () => {
    reconciler.desiredCloudTakMembers.mockResolvedValue(['100']);
    // resolveGroupUuidByName is a method on the worker; stub it.
    worker.resolveGroupUuidByName = jest.fn().mockResolvedValue('cloudtak-uuid');

    await worker.reconcileOwnedGroup({ group_kind: 'cloudtak', team_id: 5 });

    expect(worker.resolveGroupUuidByName).toHaveBeenCalled();
    expect(reconciler.desiredCloudTakMembers).toHaveBeenCalledWith(5, worker.pool);
    expect(reconciler.replaceGroupMembers).toHaveBeenCalledWith('cloudtak-uuid', ['100'], expect.any(Object));
  });

  it('missing owning row is a satisfied no-op (no PATCH)', async () => {
    worker.pool.query.mockResolvedValue({ rows: [] });

    await worker.reconcileOwnedGroup({ group_kind: 'team_channel', channel_id: 9 });

    expect(reconciler.desiredTeamChannelMembers).not.toHaveBeenCalled();
    expect(reconciler.replaceGroupMembers).not.toHaveBeenCalled();
  });

  it('a null group id on the row is RETRYABLE (its create op has not drained)', async () => {
    worker.pool.query.mockResolvedValue({ rows: [{ team_id: 42, authentik_group_id: null }] });

    let caught;
    try {
      await worker.reconcileOwnedGroup({ group_kind: 'team_channel', channel_id: 9 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthentikApiError);
    expect(caught.classification).toBe('retryable');
    expect(reconciler.replaceGroupMembers).not.toHaveBeenCalled();
  });

  it('a group_kind missing its required id is a PERMANENT payload defect', async () => {
    await expect(
      worker.reconcileOwnedGroup({ group_kind: 'team_channel' /* no channel_id */ })
    ).rejects.toMatchObject({ classification: 'permanent' });

    expect(worker.pool.query).not.toHaveBeenCalled();
  });

  it('an unknown group_kind is PERMANENT', async () => {
    await expect(
      worker.reconcileOwnedGroup({ group_kind: 'nonsense', channel_id: 1 })
    ).rejects.toMatchObject({ classification: 'permanent' });
  });

  it('cloudtak group not yet created is RETRYABLE (deferred until create drains)', async () => {
    worker.resolveGroupUuidByName = jest.fn().mockResolvedValue(null);

    let caught;
    try {
      await worker.reconcileOwnedGroup({ group_kind: 'cloudtak', team_id: 5 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthentikApiError);
    expect(caught.classification).toBe('retryable');
    expect(reconciler.replaceGroupMembers).not.toHaveBeenCalled();
  });

  it('fail-closed: a desired-set query error propagates and no PATCH is issued', async () => {
    worker.pool.query.mockResolvedValue({ rows: [{ team_id: 42, authentik_group_id: 'grp-uuid' }] });
    reconciler.desiredTeamChannelMembers.mockRejectedValue(new Error('db partial read'));

    await expect(
      worker.reconcileOwnedGroup({ group_kind: 'team_channel', channel_id: 9 })
    ).rejects.toThrow('db partial read');

    expect(reconciler.replaceGroupMembers).not.toHaveBeenCalled();
  });
});
