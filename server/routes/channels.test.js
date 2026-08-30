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

  it('returns the real local description for a BCH channel, matched by name+category with the "BCH - " prefix stripped', async () => {
    mockUserGroups = ['tak_BCH - Community - Amateur Radio APRS_READ'];
    mockTables({
      bch: [
        { name: 'Community - Amateur Radio APRS', category: 'BCH', description: 'Amateur Radio APRS location data' }
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

  // Bugfix (bch-channel-category): a UTL channel's base name never
  // started with the single literal 'BCH - ' prefix the route used to
  // check, so it fell through to the team-channel branch and always
  // missed, rendering the 'TAK Channel' fallback regardless of the real
  // description stored on the row.
  it('returns the real local description for a UTL channel, matched by name+category with the "UTL - " prefix stripped', async () => {
    mockUserGroups = ['tak_UTL - Data Packages_READ'];
    mockTables({
      bch: [
        { name: 'Data Packages', category: 'UTL', description: 'Data package delivery channel' }
      ]
    });

    const res = await request(app).get('/api/channels/descriptions');

    expect(res.status).toBe(200);
    expect(res.body.channels[0]).toMatchObject({
      name: 'tak_UTL - Data Packages',
      display_name: 'UTL - Data Packages',
      description: 'Data package delivery channel'
    });
  });

  // A same-named BCH and UTL channel are two distinct rows (per
  // UNIQUE(name, category)) -- the lookup must never let one shadow the
  // other's description.
  it('does not conflate a BCH and a UTL channel that share the same underlying name', async () => {
    mockUserGroups = ['tak_BCH - Shared_READ', 'tak_UTL - Shared_READ'];
    mockTables({
      bch: [
        { name: 'Shared', category: 'BCH', description: 'The BCH one' },
        { name: 'Shared', category: 'UTL', description: 'The UTL one' }
      ]
    });

    const res = await request(app).get('/api/channels/descriptions');

    const byName = Object.fromEntries(res.body.channels.map((c) => [c.display_name, c.description]));
    expect(byName['BCH - Shared']).toBe('The BCH one');
    expect(byName['UTL - Shared']).toBe('The UTL one');
  });

  // Bugfix (region-channel-tiers): a Response/Support channel's base
  // name never started with the single literal 'Regions - ' prefix the
  // route used to check (that untiered prefix no longer exists in this
  // deployment at all), so every region channel fell through to the
  // team-channel branch and always missed too.
  it('returns the real local description for a Response-tier region channel, matched by name+tier with the "Response - " prefix stripped', async () => {
    mockUserGroups = ['tak_Response - Auckland'];
    mockTables({
      region: [{ name: 'Auckland', tier: 'response', description: 'Auckland (Response - Emergency Services)' }]
    });

    const res = await request(app).get('/api/channels/descriptions');

    expect(res.status).toBe(200);
    expect(res.body.channels[0]).toMatchObject({
      name: 'tak_Response - Auckland',
      display_name: 'Response - Auckland',
      description: 'Auckland (Response - Emergency Services)'
    });
  });

  it('returns the real local description for a Support-tier region channel, matched by name+tier with the "Support - " prefix stripped', async () => {
    mockUserGroups = ['tak_Support - Auckland'];
    mockTables({
      region: [{ name: 'Auckland', tier: 'support', description: 'Auckland (Support - All Agencies)' }]
    });

    const res = await request(app).get('/api/channels/descriptions');

    expect(res.status).toBe(200);
    expect(res.body.channels[0]).toMatchObject({
      name: 'tak_Support - Auckland',
      display_name: 'Support - Auckland',
      description: 'Auckland (Support - All Agencies)'
    });
  });

  // A same-named Response and Support channel are two distinct rows (per
  // UNIQUE(name, tier)) -- the lookup must never let one shadow the other.
  it('does not conflate a Response and a Support channel that share the same underlying name', async () => {
    mockUserGroups = ['tak_Response - Auckland', 'tak_Support - Auckland'];
    mockTables({
      region: [
        { name: 'Auckland', tier: 'response', description: 'The response one' },
        { name: 'Auckland', tier: 'support', description: 'The support one' }
      ]
    });

    const res = await request(app).get('/api/channels/descriptions');

    const byName = Object.fromEntries(res.body.channels.map((c) => [c.display_name, c.description]));
    expect(byName['Response - Auckland']).toBe('The response one');
    expect(byName['Support - Auckland']).toBe('The support one');
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
      bch: [{ name: 'Community - Amateur Radio APRS', category: 'BCH', description: 'Amateur Radio APRS location data' }]
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
