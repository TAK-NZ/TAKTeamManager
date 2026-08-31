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

// Bugfix (Channels tab had no delete-channel or manage-members action):
// the new routes below delegate to `Channel`'s model methods, mocked
// here so these tests are scoped to the ROUTE handlers' own logic
// (validation, which Channel method is called with what, audit
// logging, response shape/status) rather than re-exercising
// `Channel.js`'s own already-tested transaction/enqueue behavior
// (`Channel.test.js`).
jest.mock('../models/Channel', () => ({
  findById: jest.fn(),
  getMembers: jest.fn(),
  addMember: jest.fn(),
  removeMember: jest.fn(),
  deleteCustomChannel: jest.fn(),
  updateCustomChannel: jest.fn(),
  resolveGroupIdForPermission: jest.fn(),
  getChannelCount: jest.fn(),
  createCustomChannel: jest.fn(),
  ChannelLimitError: class ChannelLimitError extends Error {}
}));

jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
jest.mock('../middleware/requestContext', () => ({
  getLogger: () => mockLoggerInstance
}));

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const Channel = require('../models/Channel');
const EventPublisher = require('../services/EventPublisher');
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

/**
 * Bugfix (Channels tab had no delete-channel or manage-members
 * action): integration tests for the four new routes. Reuses the SAME
 * `authenticateToken` mock as the `descriptions` tests above (there can
 * be only one `jest.mock('../middleware/auth', ...)` per file -- Jest
 * hoists every call, and a second one for the same module would
 * silently replace the first for the WHOLE file, breaking those
 * earlier tests' reliance on `mockUserGroups`). `req.user.userId` is
 * `1` throughout (set by that shared mock), so the audit-log assertions
 * below use `1`, not a distinct id.
 */

describe('GET /api/channels/:channelId/members', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns the members Channel.getMembers resolves', async () => {
    Channel.getMembers.mockResolvedValue([
      { id: 1, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', permission: 'read_write' }
    ]);

    const res = await request(app).get('/api/channels/10/members');

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(Channel.getMembers).toHaveBeenCalledWith('10');
  });

  it('responds 500 when Channel.getMembers throws', async () => {
    Channel.getMembers.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/channels/10/members');

    expect(res.status).toBe(500);
  });
});

describe('POST /api/channels/:channelId/members', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('rejects a request missing userId or with an invalid permission before calling Channel.addMember', async () => {
    const res = await request(app)
      .post('/api/channels/10/members')
      .send({ userId: 42, permission: 'admin' });

    expect(res.status).toBe(400);
    expect(Channel.addMember).not.toHaveBeenCalled();
  });

  it('returns 404 without calling addMember when the channel does not exist', async () => {
    Channel.findById.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/channels/10/members')
      .send({ userId: 42, permission: 'read' });

    expect(res.status).toBe(404);
    expect(Channel.addMember).not.toHaveBeenCalled();
  });

  it('adds the member, enqueues add_user_to_group on the resolved group id, and writes an audit log entry', async () => {
    const channel = { id: 10, authentik_read_group_id: 'grp-read' };
    Channel.findById.mockResolvedValue(channel);
    Channel.addMember.mockResolvedValue({ channel_id: 10, user_id: 42, permission: 'read' });
    Channel.resolveGroupIdForPermission.mockReturnValue('grp-read');

    const res = await request(app)
      .post('/api/channels/10/members')
      .send({ userId: 42, permission: 'read' });

    expect(res.status).toBe(201);
    expect(Channel.addMember).toHaveBeenCalledWith('10', 42, 'read');
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 42, target_group_id: 'grp-read' },
      1
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      [1, 'channel.member_add', 'channel', 10, JSON.stringify({ userId: 42, permission: 'read' })]
    );
  });

  it('skips the add_user_to_group enqueue (without failing the request) when no matching group id resolves', async () => {
    Channel.findById.mockResolvedValue({ id: 10 });
    Channel.addMember.mockResolvedValue({ channel_id: 10, user_id: 42, permission: 'read' });
    Channel.resolveGroupIdForPermission.mockReturnValue(null);

    const res = await request(app)
      .post('/api/channels/10/members')
      .send({ userId: 42, permission: 'read' });

    expect(res.status).toBe(201);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  // Bugfix (silent permanent sync failure): a real browser form submits
  // `userId` as a STRING (a `<select>` element's value), not a JS
  // number the way `.send({ userId: 42, ... })` above happens to. This
  // test sends it the same way -- as `'42'` -- to actually exercise
  // `.toInt()`'s coercion. Without it, `add_user_to_group`'s payload
  // carried `target_user_id: '42'` (a string), which
  // `operationSchemas.js`'s schema requires to be a `number`, and the
  // enqueued operation failed payload validation PERMANENTLY (never
  // retried) -- the local add succeeded while Authentik silently never
  // received it.
  it('coerces a string userId (as a real form submission sends it) to a number before enqueueing add_user_to_group', async () => {
    const channel = { id: 10, authentik_read_group_id: 'grp-read' };
    Channel.findById.mockResolvedValue(channel);
    Channel.addMember.mockResolvedValue({ channel_id: 10, user_id: 42, permission: 'read' });
    Channel.resolveGroupIdForPermission.mockReturnValue('grp-read');

    const res = await request(app)
      .post('/api/channels/10/members')
      .send({ userId: '42', permission: 'read' });

    expect(res.status).toBe(201);
    expect(Channel.addMember).toHaveBeenCalledWith('10', 42, 'read');
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'add_user_to_group',
      { target_user_id: 42, target_group_id: 'grp-read' },
      1
    );
    // The literal type matters here, not just the value -- assert it
    // explicitly rather than relying on toHaveBeenCalledWith's
    // structural equality alone to make the regression legible.
    const call = EventPublisher.publishOperation.mock.calls.find(([type]) => type === 'add_user_to_group');
    expect(typeof call[1].target_user_id).toBe('number');
  });
});

describe('DELETE /api/channels/:channelId/members/:userId', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('returns 404 when Channel.removeMember finds no matching membership', async () => {
    Channel.removeMember.mockResolvedValue(false);

    const res = await request(app).delete('/api/channels/10/members/42');

    expect(res.status).toBe(404);
  });

  it('removes the member and writes an audit log entry on success', async () => {
    Channel.removeMember.mockResolvedValue(true);

    const res = await request(app).delete('/api/channels/10/members/42');

    expect(res.status).toBe(200);
    // Bugfix (silent permanent sync failure): the route parses the
    // route param to an integer before calling Channel.removeMember --
    // req.params.userId arrives as the string '42' (Express route
    // params are ALWAYS strings), but the enqueued Sync_Operation
    // payload's target_user_id must be a number per operationSchemas.js
    // -- a string there fails payload validation PERMANENTLY (never
    // retried), so the local remove would succeed while Authentik
    // silently never received it. Asserted as a real number, not just
    // a value that happens to compare equal.
    const [, userIdArg] = Channel.removeMember.mock.calls[0];
    expect(userIdArg).toBe(42);
    expect(typeof userIdArg).toBe('number');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      [1, 'channel.member_remove', 'channel', 10, JSON.stringify({ userId: 42 })]
    );
  });

  it('responds 500 when Channel.removeMember throws', async () => {
    Channel.removeMember.mockRejectedValue(new Error('db down'));

    const res = await request(app).delete('/api/channels/10/members/42');

    expect(res.status).toBe(500);
  });
});

// Bugfix (Channels tab has no edit action, and no way to add/edit a
// custom channel's Authentik/LDAP description).
describe('PUT /api/channels/:channelId', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('returns 404 when Channel.updateCustomChannel returns null (not found, or a primary channel)', async () => {
    Channel.updateCustomChannel.mockResolvedValue(null);

    const res = await request(app).put('/api/channels/10').send({ description: 'New description' });

    expect(res.status).toBe(404);
  });

  it('updates the channel, passing the description and acting user id through, and writes an audit log entry', async () => {
    Channel.updateCustomChannel.mockResolvedValue({ id: 10, team_id: 7, description: 'New description' });

    const res = await request(app).put('/api/channels/10').send({ description: 'New description' });

    expect(res.status).toBe(200);
    expect(Channel.updateCustomChannel).toHaveBeenCalledWith('10', { description: 'New description' }, 1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      [1, 'channel.update', 'channel', 10, JSON.stringify({ description: 'New description' })]
    );
    expect(res.body.channel).toEqual({ id: 10, team_id: 7, description: 'New description' });
  });

  it('accepts an omitted description (optional field)', async () => {
    Channel.updateCustomChannel.mockResolvedValue({ id: 10, team_id: 7, description: '' });

    const res = await request(app).put('/api/channels/10').send({});

    expect(res.status).toBe(200);
    expect(Channel.updateCustomChannel).toHaveBeenCalledWith('10', { description: undefined }, 1);
  });

  it('rejects a description longer than 500 characters with a 400', async () => {
    const res = await request(app).put('/api/channels/10').send({ description: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    expect(Channel.updateCustomChannel).not.toHaveBeenCalled();
  });

  it('responds 500 when Channel.updateCustomChannel throws', async () => {
    Channel.updateCustomChannel.mockRejectedValue(new Error('db down'));

    const res = await request(app).put('/api/channels/10').send({ description: 'x' });

    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/channels/:channelId', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('returns 404 when Channel.deleteCustomChannel returns null (not found, or a primary channel)', async () => {
    Channel.deleteCustomChannel.mockResolvedValue(null);

    const res = await request(app).delete('/api/channels/10');

    expect(res.status).toBe(404);
  });

  it('deletes the channel, passing the acting user id through, and writes an audit log entry', async () => {
    Channel.deleteCustomChannel.mockResolvedValue({ id: 10, team_id: 7 });

    const res = await request(app).delete('/api/channels/10');

    expect(res.status).toBe(200);
    expect(Channel.deleteCustomChannel).toHaveBeenCalledWith('10', 1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_logs'),
      [1, 'channel.delete', 'channel', 10, JSON.stringify({ teamId: 7 })]
    );
  });

  it('responds 500 when Channel.deleteCustomChannel throws', async () => {
    Channel.deleteCustomChannel.mockRejectedValue(new Error('db down'));

    const res = await request(app).delete('/api/channels/10');

    expect(res.status).toBe(500);
  });
});
