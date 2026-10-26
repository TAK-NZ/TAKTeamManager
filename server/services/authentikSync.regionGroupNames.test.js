jest.mock('../config/database', () => ({ query: jest.fn() }));
const mockLoggerInstance = { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({ createLogger: jest.fn(() => mockLoggerInstance) }));
jest.mock('axios');
jest.mock('./EventPublisher', () => ({ publishOperation: jest.fn() }));

const db = require('../config/database');
const EventPublisher = require('./EventPublisher');
const authentikSync = require('./authentikSync');

const SUFFIX = ' (Bi-directional location sharing)';
const channelRow = (over = {}) => ({
  id: 1, name: 'Auckland', description: `Auckland (Coordination - All Agencies)${SUFFIX}`,
  tier: 'coordination', group_id: 'g1', ...over
});
// A fetched Authentik group in the shape the sync receives.
const group = (pk, name, description) => ({
  pk, name, attributes: description === undefined ? null : { description }
});
const IN_SYNC = group('g1', 'tak_Coordination - Auckland', `Auckland (Coordination - All Agencies)${SUFFIX}`);

describe('AuthentikSyncService.reconcileRegionChannelGroups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CHANNEL_FOLDER_SEPARATOR;
  });

  it('enqueues an in-place update for a group that still has the retired prefix', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [channelRow()] })   // region_channels
      .mockResolvedValueOnce({ rows: [] });              // in-flight updates
    const n = await authentikSync.reconcileRegionChannelGroups([
      group('g1', 'tak_Support - Auckland', channelRow().description)
    ]);
    expect(n).toBe(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_region_channel_group',
      { region_channel_id: 1, channel_name: 'Auckland', description: channelRow().description },
      null
    );
  });

  it('enqueues an update for a group whose description lacks the location-sharing suffix', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [channelRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const n = await authentikSync.reconcileRegionChannelGroups([
      group('g1', 'tak_Coordination - Auckland', 'Auckland (Coordination - All Agencies)')
    ]);
    expect(n).toBe(1);
    expect(EventPublisher.publishOperation.mock.calls[0][1].description).toBe(channelRow().description);
  });

  it('does nothing, and runs no second query, when name and description already match', async () => {
    db.query.mockResolvedValueOnce({ rows: [channelRow()] });
    expect(await authentikSync.reconcileRegionChannelGroups([IN_SYNC])).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('skips a channel that already has a pending or processing update', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [channelRow({ id: 1 }), channelRow({ id: 2, name: 'Waikato', group_id: 'g2' })] })
      .mockResolvedValueOnce({ rows: [{ region_channel_id: 1 }] });
    const n = await authentikSync.reconcileRegionChannelGroups([
      group('g1', 'tak_Support - Auckland', 'x'),
      group('g2', 'tak_Support - Waikato', 'x')
    ]);
    expect(n).toBe(1);
    expect(EventPublisher.publishOperation.mock.calls[0][1].region_channel_id).toBe(2);
  });

  it('never touches a group that is missing from the fetched list', async () => {
    db.query.mockResolvedValueOnce({ rows: [channelRow()] });
    expect(await authentikSync.reconcileRegionChannelGroups([])).toBe(0);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('uses the configured folder separator when computing the expected name', async () => {
    process.env.CHANNEL_FOLDER_SEPARATOR = ' / ';
    db.query.mockResolvedValueOnce({ rows: [channelRow()] });
    expect(await authentikSync.reconcileRegionChannelGroups([
      group('g1', 'tak_Coordination / Auckland', channelRow().description)
    ])).toBe(0);
  });

  it('swallows a database failure so it can never fail the user sync', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    await expect(authentikSync.reconcileRegionChannelGroups([IN_SYNC])).resolves.toBe(0);
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
    await expect(authentikSync.reconcileRegionChannelGroups([
      group('g1', 'tak_Support - Auckland', 'x')
    ])).resolves.toBe(0);
  });
});

describe('AuthentikSyncService.reconcileTeamChannelGroupDescriptions', () => {
  const NEW = `Users from FENZ - Auckland${SUFFIX}`;
  const OLD = 'Users from FENZ - Auckland (Location sharing enabled)';
  const teamRow = (over = {}) => ({ id: 10, description: NEW, group_id: 'tg1', ...over });

  beforeEach(() => jest.clearAllMocks());

  it('enqueues update_channel_group for a team group still carrying the old qualifier', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [teamRow()] })
      .mockResolvedValueOnce({ rows: [] });
    const n = await authentikSync.reconcileTeamChannelGroupDescriptions([group('tg1', 'tak_Teams - FENZ - Auckland', OLD)]);
    expect(n).toBe(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith('update_channel_group', { channel_id: 10 }, null);
  });

  it('does nothing when the description already matches', async () => {
    db.query.mockResolvedValueOnce({ rows: [teamRow()] });
    expect(await authentikSync.reconcileTeamChannelGroupDescriptions([group('tg1', 'n', NEW)])).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('only reads primary team channels that have a main group', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await authentikSync.reconcileTeamChannelGroupDescriptions([]);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/is_primary = true/);
    expect(sql).toMatch(/team_id IS NOT NULL/);
    expect(sql).toMatch(/authentik_group_id IS NOT NULL/);
  });

  it('skips a channel that already has a pending or processing update', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [teamRow({ id: 10 }), teamRow({ id: 11, group_id: 'tg2' })] })
      .mockResolvedValueOnce({ rows: [{ channel_id: 10 }] });
    const n = await authentikSync.reconcileTeamChannelGroupDescriptions([
      group('tg1', 'n1', OLD),
      group('tg2', 'n2', OLD)
    ]);
    expect(n).toBe(1);
    expect(EventPublisher.publishOperation.mock.calls[0][1]).toEqual({ channel_id: 11 });
  });

  it('never touches a group that is missing from the fetched list', async () => {
    db.query.mockResolvedValueOnce({ rows: [teamRow()] });
    expect(await authentikSync.reconcileTeamChannelGroupDescriptions([])).toBe(0);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('swallows failures so it can never fail the user sync', async () => {
    db.query.mockRejectedValueOnce(new Error('db down'));
    await expect(authentikSync.reconcileTeamChannelGroupDescriptions([])).resolves.toBe(0);
  });
});

describe('AuthentikSyncService.syncUsers wiring', () => {
  const axios = require('axios');
  const fetched = [{ pk: 'g1', name: 'tak_Support - Auckland', attributes: { description: 'd' } }];
  let regionSpy;
  let teamSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    authentikSync.isRunning = false;
    regionSpy = jest.spyOn(authentikSync, 'reconcileRegionChannelGroups').mockResolvedValue(0);
    teamSpy = jest.spyOn(authentikSync, 'reconcileTeamChannelGroupDescriptions').mockResolvedValue(0);
    db.query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    regionSpy.mockRestore();
    teamSpy.mockRestore();
  });

  it('runs both reconciles on the success path with the full fetched group list', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/groups/')) {
        return Promise.resolve({ data: { results: fetched, pagination: {} } });
      }
      return Promise.resolve({ data: { results: [], pagination: {} } });
    });
    await authentikSync.syncUsers();
    expect(regionSpy).toHaveBeenCalledTimes(1);
    expect(regionSpy).toHaveBeenCalledWith(fetched);
    expect(teamSpy).toHaveBeenCalledTimes(1);
    expect(teamSpy).toHaveBeenCalledWith(fetched);
  });

  it('runs neither when the group list fetch fails', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/api/v3/core/groups/')) return Promise.reject(new Error('groups down'));
      return Promise.resolve({ data: { results: [], pagination: {} } });
    });
    await authentikSync.syncUsers();
    expect(regionSpy).not.toHaveBeenCalled();
    expect(teamSpy).not.toHaveBeenCalled();
  });
});
