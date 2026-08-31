/**
 * Unit tests for the `channel:manage` row-scoped resolver added to
 * `server/middleware/authorize.js` (bugfix: Channels tab had no
 * delete-channel or manage-members action). Mirrors
 * `authorize.channelRequest.test.js`'s exact self-contained-registry-mock
 * pattern: a minimal `permissions.registry` mock covering only the
 * routes under test, `../models/Team` mocked to control `Team.isAdmin`'s
 * resolution, and `../config/database` mocked to control the resolver's
 * `SELECT team_id FROM channels WHERE id = $1` lookup.
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
      'DELETE /api/channels/:channelId': ['channel:manage'],
      'POST /api/channels/:channelId/members': ['channel:manage']
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
  app.delete('/api/channels/:channelId', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/channels/:channelId/members', authorize, (req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('channel:manage resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('permits a Global_Manager without querying channels', async () => {
    const app = buildApp({ userId: 1, is_global_manager: true });

    const res = await request(app).delete('/api/channels/10');

    expect(res.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('permits a non-Global_Manager who admins the channel\'s team', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ team_id: 5 }] });
    mockIsAdmin.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).delete('/api/channels/10');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM channels'), ['10']);
    expect(mockIsAdmin).toHaveBeenCalledWith(5, 1);
  });

  it('denies a non-Global_Manager who does not admin the channel\'s team', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ team_id: 5 }] });
    mockIsAdmin.mockResolvedValueOnce(false);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).delete('/api/channels/10');

    expect(res.status).toBe(403);
  });

  it('denies when the channel id does not resolve to an existing row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).delete('/api/channels/999');

    expect(res.status).toBe(403);
    expect(mockIsAdmin).not.toHaveBeenCalled();
  });

  it('is also satisfied for the members-add route, by the same team ownership rule', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ team_id: 5 }] });
    mockIsAdmin.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).post('/api/channels/10/members').send({ userId: 42, permission: 'read' });

    expect(res.status).toBe(200);
    expect(mockIsAdmin).toHaveBeenCalledWith(5, 1);
  });
});
