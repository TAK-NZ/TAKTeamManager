jest.mock('../config/database', () => ({ query: jest.fn() }));
const mockLoggerInstance = { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({ createLogger: jest.fn(() => mockLoggerInstance) }));
jest.mock('axios');
jest.mock('./EventPublisher', () => ({ publishOperation: jest.fn() }));

const db = require('../config/database');
const EventPublisher = require('./EventPublisher');
const authentikSync = require('./authentikSync');

const channelRow = (over = {}) => ({
  id: 1, name: 'Auckland', description: 'Auckland (Coordination - All Agencies)',
  tier: 'coordination', group_id: 'g1', ...over
});

describe('AuthentikSyncService.reconcileRegionChannelGroupNames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CHANNEL_FOLDER_SEPARATOR;
  });

  it('enqueues an in-place rename for a group that still has the retired prefix', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [channelRow()] })   // region_channels
      .mockResolvedValueOnce({ rows: [] });              // in-flight renames
    const n = await authentikSync.reconcileRegionChannelGroupNames({ g1: 'tak_Support - Auckland' });
    expect(n).toBe(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_region_channel_group',
      { region_channel_id: 1, channel_name: 'Auckland', description: 'Auckland (Coordination - All Agencies)' },
      null
    );
  });

  it('does nothing, and runs no second query, when every name already matches', async () => {
    db.query.mockResolvedValueOnce({ rows: [channelRow()] });
    const n = await authentikSync.reconcileRegionChannelGroupNames({ g1: 'tak_Coordination - Auckland' });
    expect(n).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('skips a channel that already has a pending or processing rename', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [channelRow({ id: 1 }), channelRow({ id: 2, name: 'Waikato', group_id: 'g2' })] })
      .mockResolvedValueOnce({ rows: [{ region_channel_id: 1 }] });
    const n = await authentikSync.reconcileRegionChannelGroupNames({
      g1: 'tak_Support - Auckland',
      g2: 'tak_Support - Waikato'
    });
    expect(n).toBe(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation.mock.calls[0][1].region_channel_id).toBe(2);
  });

  it('never renames a group that is missing from the fetched map', async () => {
    db.query.mockResolvedValueOnce({ rows: [channelRow()] });
    expect(await authentikSync.reconcileRegionChannelGroupNames({})).toBe(0);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('uses the configured folder separator when computing the expected name', async () => {
    process.env.CHANNEL_FOLDER_SEPARATOR = ' / ';
    db.query.mockResolvedValueOnce({ rows: [channelRow()] });
    // Already correct for ' / ', so no rename even though ' - ' would differ.
    expect(await authentikSync.reconcileRegionChannelGroupNames({ g1: 'tak_Coordination / Auckland' })).toBe(0);
  });

  it('swallows a database failure so it can never fail the user sync', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    await expect(authentikSync.reconcileRegionChannelGroupNames({ g1: 'x' })).resolves.toBe(0);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('reconcile failed')
    );
  });

  it('swallows an enqueue failure', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [channelRow()] })
      .mockResolvedValueOnce({ rows: [] });
    EventPublisher.publishOperation.mockRejectedValueOnce(new Error('queue down'));
    await expect(authentikSync.reconcileRegionChannelGroupNames({ g1: 'tak_Support - Auckland' })).resolves.toBe(0);
  });
});

describe('AuthentikSyncService.syncUsers wiring', () => {
  const axios = require('axios');

  beforeEach(() => {
    jest.clearAllMocks();
    authentikSync.isRunning = false;
  });

  it('runs the region group name reconcile on the success path with the fetched group map', async () => {
    const spy = jest.spyOn(authentikSync, 'reconcileRegionChannelGroupNames').mockResolvedValue(0);
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({ data: { results: [{ pk: 'g1', name: 'tak_Support - Auckland' }], pagination: {} } });
      }
      return Promise.resolve({ data: { results: [], pagination: {} } });
    });
    await authentikSync.syncUsers();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ g1: 'tak_Support - Auckland' });
    spy.mockRestore();
  });

  it('does not run it when the group list fetch fails', async () => {
    const spy = jest.spyOn(authentikSync, 'reconcileRegionChannelGroupNames').mockResolvedValue(0);
    db.query.mockResolvedValue({ rows: [] });
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/groups/')) return Promise.reject(new Error('groups down'));
      return Promise.resolve({ data: { results: [], pagination: {} } });
    });
    await authentikSync.syncUsers();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
