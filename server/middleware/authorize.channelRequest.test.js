/**
 * Unit tests for the `channel_request:create`/`channel_request:process`
 * row-scoped resolvers added to `server/middleware/authorize.js` (task
 * 45.4, Requirement 23.4).
 *
 * Follows the same self-contained-registry-mock pattern already
 * established by `authorize.test.js`: a minimal `permissions.registry`
 * mock covering only the two routes under test, `../models/Team` mocked
 * to control `Team.isAdmin`'s resolution, and `../config/database` mocked
 * to control the `channel_request:process` resolver's
 * `SELECT team_id FROM channel_requests WHERE id = $1` lookup.
 */

const mockIsAdmin = jest.fn();
jest.mock('../models/Team', () => ({
  isAdmin: (...args) => mockIsAdmin(...args)
}));

const mockQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...args) => mockQuery(...args)
}));

jest.mock('./requestContext', () => ({
  getLogger: () => ({ warn: jest.fn(), error: jest.fn() })
}));

jest.mock('../config/permissions.registry', () => {
  function resolveAccess(routeKey, userPermissions, registry) {
    const required = registry && registry.routes ? registry.routes[routeKey] : undefined;
    if (!required) {
      return false;
    }
    const held = userPermissions instanceof Set ? userPermissions : new Set(userPermissions || []);
    if (held.has('*')) {
      return true;
    }
    return required.every((permission) => held.has(permission));
  }

  return {
    routes: {
      'POST /api/channel-requests': ['channel_request:create'],
      'POST /api/channel-requests/:requestId/approve': ['channel_request:process']
    },
    roleDefaults: {
      global_manager: ['*'],
      authenticated_user: []
    },
    resolveAccess
  };
});

const express = require('express');
const request = require('supertest');
const authorize = require('./authorize');

function buildApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.post('/api/channel-requests', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/channel-requests/:requestId/approve', authorize, (req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('channel_request:create resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('permits a Global_Manager regardless of team admin status', async () => {
    const app = buildApp({ userId: 1, is_global_manager: true });

    const res = await request(app).post('/api/channel-requests').send({ teamId: 5 });

    expect(res.status).toBe(200);
    expect(mockIsAdmin).not.toHaveBeenCalled();
  });

  it('permits a non-Global_Manager who is an admin of the named team', async () => {
    mockIsAdmin.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).post('/api/channel-requests').send({ teamId: 5 });

    expect(res.status).toBe(200);
    expect(mockIsAdmin).toHaveBeenCalledWith(5, 1);
  });

  it('denies a non-Global_Manager who is not an admin of the named team', async () => {
    mockIsAdmin.mockResolvedValueOnce(false);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).post('/api/channel-requests').send({ teamId: 5 });

    expect(res.status).toBe(403);
  });

  it('denies a non-Global_Manager request with no teamId in the body', async () => {
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).post('/api/channel-requests').send({});

    expect(res.status).toBe(403);
    expect(mockIsAdmin).not.toHaveBeenCalled();
  });
});

describe('channel_request:process resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('permits a Global_Manager without querying channel_requests', async () => {
    const app = buildApp({ userId: 1, is_global_manager: true });

    const res = await request(app).post('/api/channel-requests/10/approve');

    expect(res.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('permits a non-Global_Manager who admins the request\'s team', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ team_id: 5 }] });
    mockIsAdmin.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).post('/api/channel-requests/10/approve');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM channel_requests'), ['10']);
    expect(mockIsAdmin).toHaveBeenCalledWith(5, 1);
  });

  it('denies a non-Global_Manager who does not admin the request\'s team', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ team_id: 5 }] });
    mockIsAdmin.mockResolvedValueOnce(false);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).post('/api/channel-requests/10/approve');

    expect(res.status).toBe(403);
  });

  it('denies when the request id does not resolve to an existing row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).post('/api/channel-requests/999/approve');

    expect(res.status).toBe(403);
    expect(mockIsAdmin).not.toHaveBeenCalled();
  });
});
