/**
 * Integration tests for `GET /api/channels/descriptions`.
 *
 * Regression coverage: this route previously returned the literal string
 * 'TAK Channel' for every channel unconditionally (a prior fix removed a
 * live per-channel Authentik call but, in doing so, also dropped the
 * local database lookup it should have fallen back to instead). It now
 * looks up each channel's real description from the local `channels`/
 * `bch_channels`/`region_channels` tables -- populated by
 * Team.createTeamChannel / GlobalChannelService / syncWorker.js's sync,
 * with no Authentik call involved -- and only falls back to the literal
 * 'TAK Channel' string when no matching local row has a description.
 *
 * `authenticateToken`/`authorize` are mocked to inject `req.user.groups`
 * directly, matching the convention already used in `teams.test.js`, so
 * this test is scoped to the handler's own local-lookup/matching logic.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

let mockUserGroups = [];

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, groups: mockUserGroups };
    next();
  }
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const channelsRouter = require('./channels');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/channels', channelsRouter);
  return app;
}

describe('GET /api/channels/descriptions', () => {
  let app;
  const ORIGINAL_SEPARATOR = process.env.CHANNEL_FOLDER_SEPARATOR;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CHANNEL_FOLDER_SEPARATOR = ' - ';
    app = buildApp();
  });

  afterAll(() => {
    process.env.CHANNEL_FOLDER_SEPARATOR = ORIGINAL_SEPARATOR;
  });

  function mockTables({ channels = [], bch = [], region = [] } = {}) {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM channels')) return Promise.resolve({ rows: channels });
      if (sql.includes('FROM bch_channels')) return Promise.resolve({ rows: bch });
      if (sql.includes('FROM region_channels')) return Promise.resolve({ rows: region });
      return Promise.resolve({ rows: [] });
    });
  }

  it('returns the real local description for a team channel, matched by display_name', async () => {
    mockUserGroups = ['tak_Teams - FENZ - Southland District'];
    mockTables({
      channels: [
        { display_name: 'Teams - FENZ - Southland District', description: 'Users from FENZ - Southland District (Location sharing enabled)' }
      ]
    });

    const res = await request(app).get('/api/channels/descriptions');

    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0]).toMatchObject({
      name: 'tak_Teams - FENZ - Southland District',
      display_name: 'Teams - FENZ - Southland District',
      description: 'Users from FENZ - Southland District (Location sharing enabled)'
    });
  });

  it('returns the real local description for a BCH channel, matched by name with the "BCH - " prefix stripped', async () => {
    mockUserGroups = ['tak_BCH - Community - Amateur Radio APRS_READ'];
    mockTables({
      bch: [
        { name: 'Community - Amateur Radio APRS', description: 'Amateur Radio APRS location data' }
      ]
    });

    const res = await request(app).get('/api/channels/descriptions');

    expect(res.status).toBe(200);
    expect(res.body.channels[0]).toMatchObject({
      name: 'tak_BCH - Community - Amateur Radio APRS',
      display_name: 'BCH - Community - Amateur Radio APRS',
      description: 'Amateur Radio APRS location data'
    });
  });

  it('returns the real local description for a Region channel, matched by name with the "Regions - " prefix stripped', async () => {
    mockUserGroups = ['tak_Regions - Auckland'];
    mockTables({
      region: [{ name: 'Auckland', description: 'Activities in Auckland (AUK)' }]
    });

    const res = await request(app).get('/api/channels/descriptions');

    expect(res.status).toBe(200);
    expect(res.body.channels[0]).toMatchObject({
      name: 'tak_Regions - Auckland',
      display_name: 'Regions - Auckland',
      description: 'Activities in Auckland (AUK)'
    });
  });

  it('falls back to the literal "TAK Channel" string only when no matching local row has a description', async () => {
    mockUserGroups = ['tak_Teams - Unknown Team'];
    mockTables({ channels: [] });

    const res = await request(app).get('/api/channels/descriptions');

    expect(res.status).toBe(200);
    expect(res.body.channels[0].description).toBe('TAK Channel');
  });

  it('deduplicates _READ/_WRITE suffixes into a single base channel entry using the real description', async () => {
    mockUserGroups = ['tak_BCH - Community - Amateur Radio APRS_READ', 'tak_BCH - Community - Amateur Radio APRS'];
    mockTables({
      bch: [{ name: 'Community - Amateur Radio APRS', description: 'Amateur Radio APRS location data' }]
    });

    const res = await request(app).get('/api/channels/descriptions');

    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].description).toBe('Amateur Radio APRS location data');
  });

  it('ignores non-tak_ groups entirely', async () => {
    mockUserGroups = ['authentik Admins', 'tak_Teams - FENZ'];
    mockTables({ channels: [{ display_name: 'Teams - FENZ', description: 'Real description' }] });

    const res = await request(app).get('/api/channels/descriptions');

    expect(res.body.channels).toHaveLength(1);
    expect(res.body.channels[0].name).toBe('tak_Teams - FENZ');
  });
});
