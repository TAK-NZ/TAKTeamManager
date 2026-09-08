'use strict';

/**
 * Authentik scaling (Phase 3): the periodic anti-drift sweep job. Asserts
 * it starts ONLY when both flags are on, runs a sweep pass that delegates to
 * sweepAllOwnedGroups (passing includeCloudTak from isCloudTakEnabled),
 * collapses overlapping ticks, and never throws on a sweep failure.
 */

const mockSweepEnabled = jest.fn();
const mockReconcileEnabled = jest.fn();
jest.mock('../config/bulkGroupReconcile', () => ({
  isOwnedGroupSweepEnabled: () => mockSweepEnabled(),
  isBulkGroupReconcileEnabled: () => mockReconcileEnabled(),
  getOwnedGroupSweepIntervalMinutes: () => 60
}));

const mockCloudTak = jest.fn();
jest.mock('../config/cloudtak', () => ({ isCloudTakEnabled: () => mockCloudTak() }));

const mockSweep = jest.fn();
jest.mock('./OwnedGroupReconcileEnqueuer', () => ({
  sweepAllOwnedGroups: (...args) => mockSweep(...args)
}));

// runOnce() now routes the sweep through withJobLock (the desiredCount>1
// single-runner guard). Mock the pool's connect() to return a client that
// GRANTS the advisory lock, so these tests exercise the "won the lock, so it
// sweeps" path; jobLock.test.js covers the lock-lost skip path directly.
jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(async () => ({
    query: jest.fn(async (sql) =>
      typeof sql === 'string' && sql.includes('pg_try_advisory_lock')
        ? { rows: [{ locked: true }] }
        : { rows: [] }
    ),
    release: jest.fn()
  }))
}));

const OwnedGroupSweepJob = require('./OwnedGroupSweepJob');

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockSweepEnabled.mockReturnValue(true);
  mockReconcileEnabled.mockReturnValue(true);
  mockCloudTak.mockReturnValue(false);
  mockSweep.mockResolvedValue({ teamChannel: 1, bch: 2, region: 1, cloudtak: 0 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('OwnedGroupSweepJob.start gating', () => {
  it('does not start a timer when OWNED_GROUP_SWEEP_ENABLED is off', () => {
    mockSweepEnabled.mockReturnValue(false);
    const job = new OwnedGroupSweepJob();
    job.start();
    expect(job.timer).toBeNull();
  });

  it('does not start a timer when BULK_GROUP_RECONCILE_ENABLED is off (sweep pointless)', () => {
    mockReconcileEnabled.mockReturnValue(false);
    const job = new OwnedGroupSweepJob();
    job.start();
    expect(job.timer).toBeNull();
  });

  it('starts a timer when BOTH flags are on', () => {
    const job = new OwnedGroupSweepJob();
    job.start();
    expect(job.timer).not.toBeNull();
    job.stop();
    expect(job.timer).toBeNull();
  });
});

describe('OwnedGroupSweepJob.runOnce', () => {
  it('delegates to sweepAllOwnedGroups, passing includeCloudTak from isCloudTakEnabled', async () => {
    mockCloudTak.mockReturnValue(true);
    const job = new OwnedGroupSweepJob();

    await job.runOnce();

    expect(mockSweep).toHaveBeenCalledWith({ includeCloudTak: true });
  });

  it('collapses an overlapping tick to a no-op (guards against double-enqueue)', async () => {
    const job = new OwnedGroupSweepJob();
    job.isSweeping = true; // simulate a sweep already in progress

    await job.runOnce();

    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('never throws when a sweep fails; clears the in-progress guard', async () => {
    mockSweep.mockRejectedValue(new Error('enqueue failed'));
    const job = new OwnedGroupSweepJob();

    await expect(job.runOnce()).resolves.toBeUndefined();
    expect(job.isSweeping).toBe(false); // guard released for the next tick
  });
});
