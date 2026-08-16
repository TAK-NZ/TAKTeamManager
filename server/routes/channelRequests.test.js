/**
 * Integration tests for `server/routes/channelRequests.js` (Requirement
 * 23, task 45.4).
 *
 * `authenticateToken`/`authorize` are mocked to bypass real JWT/DB-backed
 * authorization, since authorization itself (the `channel_request:create`/
 * `channel_request:process` row-scoped resolvers added to
 * `authorize.js`) is exercised separately; this test is scoped to the
 * route handlers' own behavior -- request/response shape and how they
 * call `ChannelRequestService`/`Channel`/`Team`/`User`.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../services/ChannelRequestService', () => {
  class ChannelRequestAlreadyProcessedError extends Error {
    constructor(message = 'Channel request not found or already processed') {
      super(message);
      this.name = 'ChannelRequestAlreadyProcessedError';
    }
  }
  const mockService = {
    requestChannel: jest.fn(),
    approveChannelRequest: jest.fn(),
    denyChannelRequest: jest.fn(),
    ChannelRequestAlreadyProcessedError
  };
  return mockService;
});

jest.mock('../models/Team', () => ({
  findById: jest.fn()
}));

jest.mock('../models/User', () => ({
  getTeamMemberships: jest.fn()
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 'authentik-1', userId: 1, is_global_manager: false };
    next();
  }
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

const express = require('express');
const request = require('supertest');
const Channel = require('../models/Channel');
const Team = require('../models/Team');
const User = require('../models/User');
const pool = require('../config/database');
const ChannelRequestService = require('../services/ChannelRequestService');
const channelRequestsRouter = require('./channelRequests');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/channel-requests', channelRequestsRouter);
  return app;
}

describe('POST /api/channel-requests', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns 400 on invalid body without calling the service', async () => {
    const res = await request(app).post('/api/channel-requests').send({});

    expect(res.status).toBe(400);
    expect(ChannelRequestService.requestChannel).not.toHaveBeenCalled();
  });

  it('returns 404 when the team does not exist', async () => {
    Team.findById.mockResolvedValue(null);

    const res = await request(app).post('/api/channel-requests').send({
      teamId: 1,
      customSuffix: 'ops',
      memberPermissions: []
    });

    expect(res.status).toBe(404);
    expect(ChannelRequestService.requestChannel).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid memberPermissions entry without calling the service', async () => {
    Team.findById.mockResolvedValue({ id: 1 });

    const res = await request(app).post('/api/channel-requests').send({
      teamId: 1,
      customSuffix: 'ops',
      memberPermissions: [{ userId: 5, permission: 'nonsense' }]
    });

    expect(res.status).toBe(400);
    expect(ChannelRequestService.requestChannel).not.toHaveBeenCalled();
  });

  it('returns 202 with the pending channel_requests row for the non-Global_Manager path', async () => {
    Team.findById.mockResolvedValue({ id: 1 });
    ChannelRequestService.requestChannel.mockResolvedValue({
      id: 10,
      team_id: 1,
      status: 'pending'
    });

    const res = await request(app).post('/api/channel-requests').send({
      teamId: 1,
      customSuffix: 'ops',
      memberPermissions: [{ userId: 5, permission: 'read' }]
    });

    expect(res.status).toBe(202);
    expect(res.body.channelRequest).toEqual({ id: 10, team_id: 1, status: 'pending' });
    expect(ChannelRequestService.requestChannel).toHaveBeenCalledWith(1, 'ops', [{ userId: 5, permission: 'read' }], 1);
  });

  it('returns 201 with the created channel for the Global_Manager immediate-creation path', async () => {
    Team.findById.mockResolvedValue({ id: 1 });
    ChannelRequestService.requestChannel.mockResolvedValue({ id: 99, team_id: 1 });

    const res = await request(app).post('/api/channel-requests').send({
      teamId: 1,
      customSuffix: 'ops',
      memberPermissions: []
    });

    expect(res.status).toBe(201);
    expect(res.body.channel).toEqual({ id: 99, team_id: 1 });
  });

  it('returns 400 when Channel.createCustomChannel signals the 3-channel limit', async () => {
    Team.findById.mockResolvedValue({ id: 1 });
    ChannelRequestService.requestChannel.mockRejectedValue(new Channel.ChannelLimitError());

    const res = await request(app).post('/api/channel-requests').send({
      teamId: 1,
      customSuffix: 'ops',
      memberPermissions: []
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/3 channels/);
  });
});

describe('GET /api/channel-requests/pending', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('scopes the query to administered teams for a non-Global_Manager', async () => {
    User.getTeamMemberships.mockResolvedValue([
      { id: 1, role: 'admin' },
      { id: 2, role: 'member' }
    ]);
    pool.query.mockResolvedValue({ rows: [{ id: 10, team_id: 1, status: 'pending' }] });

    const res = await request(app).get('/api/channel-requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.channelRequests).toEqual([{ id: 10, team_id: 1, status: 'pending' }]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('cr.team_id IN'), [1]);
  });

  it('returns an empty list without querying when the caller administers no teams', async () => {
    User.getTeamMemberships.mockResolvedValue([{ id: 2, role: 'member' }]);

    const res = await request(app).get('/api/channel-requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.channelRequests).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('POST /api/channel-requests/:requestId/approve', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns the created channel on success', async () => {
    ChannelRequestService.approveChannelRequest.mockResolvedValue({ id: 5, name: 'custom-channel' });

    const res = await request(app).post('/api/channel-requests/10/approve');

    expect(res.status).toBe(200);
    expect(res.body.channel).toEqual({ id: 5, name: 'custom-channel' });
    expect(ChannelRequestService.approveChannelRequest).toHaveBeenCalledWith('10', 1);
  });

  it('returns 400 when the request is already processed', async () => {
    ChannelRequestService.approveChannelRequest.mockRejectedValue(
      new ChannelRequestService.ChannelRequestAlreadyProcessedError()
    );

    const res = await request(app).post('/api/channel-requests/10/approve');

    expect(res.status).toBe(400);
  });
});

describe('POST /api/channel-requests/:requestId/deny', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns 400 when denialReason is missing', async () => {
    const res = await request(app).post('/api/channel-requests/10/deny').send({});

    expect(res.status).toBe(400);
    expect(ChannelRequestService.denyChannelRequest).not.toHaveBeenCalled();
  });

  it('returns the denied channel_requests row on success', async () => {
    ChannelRequestService.denyChannelRequest.mockResolvedValue({ id: 10, status: 'denied' });

    const res = await request(app).post('/api/channel-requests/10/deny').send({ denialReason: 'not needed' });

    expect(res.status).toBe(200);
    expect(res.body.channelRequest).toEqual({ id: 10, status: 'denied' });
    expect(ChannelRequestService.denyChannelRequest).toHaveBeenCalledWith('10', 1, 'not needed');
  });

  it('returns 400 when the request is already processed', async () => {
    ChannelRequestService.denyChannelRequest.mockRejectedValue(
      new ChannelRequestService.ChannelRequestAlreadyProcessedError()
    );

    const res = await request(app).post('/api/channel-requests/10/deny').send({ denialReason: 'x' });

    expect(res.status).toBe(400);
  });
});
