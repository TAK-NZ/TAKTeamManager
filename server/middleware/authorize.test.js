/**
 * Unit tests for the Requirement 13.7 403 logging branches added to
 * `authorize()` (server/middleware/authorize.js).
 *
 * Requirement 13.7: "IF a request to the App fails authorization (403) or
 * authentication (401), THEN THE App SHALL log that failure with the
 * requesting IP address, the requested route, and the reason for the
 * failure, to support security monitoring."
 *
 * Covers the three distinct 403 reasons `authorize()` can produce:
 *   - `no_registry_entry`: the route+method has no Permission_Registry
 *     entry at all (deny-by-default, Requirement 24.4).
 *   - `permission_denied`: a registry entry exists but neither the user's
 *     base permission set nor any row-scoped resolver satisfies it.
 *   - `resolver_exception`: a row-scoped resolver (e.g. `Team.isAdmin`)
 *     throws, which is treated as denied (fail closed, Requirement 4.3/4.6)
 *     and logged with the more specific `resolver_exception` reason rather
 *     than the generic `permission_denied` fallback.
 *
 * `server/config/permissions.registry.js` is mocked with a small,
 * self-contained registry (rather than the full production registry) so
 * each case can be constructed precisely, and `../models/Team` is mocked
 * to control whether `Team.isAdmin` resolves or throws.
 */

const mockWarn = jest.fn();
const mockError = jest.fn();

jest.mock('./requestContext', () => ({
  getLogger: () => ({ warn: mockWarn, error: mockError })
}));

const mockIsAdmin = jest.fn();
jest.mock('../models/Team', () => ({
  isAdmin: (...args) => mockIsAdmin(...args)
}));

jest.mock('../config/database', () => ({ query: jest.fn() }));

jest.mock('../config/permissions.registry', () => {
  // Minimal, self-contained stand-in for the real `resolveAccess`, matching
  // its deny-by-default / wildcard-satisfies-everything behavior so this
  // test file doesn't depend on the full production registry.
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
      'GET /api/widgets': ['widget:read'],
      'PUT /api/teams/:teamId': ['team:update']
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

const TEST_IP = '203.0.113.9';

function buildApp(user) {
  const app = express();
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.get('/api/no-such-route-entry', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/widgets', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.put('/api/teams/:teamId', authorize, (req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('authorize (Requirement 13.7 logging)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs {ip, route, reason: "no_registry_entry"} and returns 403 when the route has no registry entry', async () => {
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .get('/api/no-such-route-entry')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/no-such-route-entry',
      reason: 'no_registry_entry'
    });
    expect(message).toMatch(/Authorization denied/i);
  });

  it('logs reason: "permission_denied" and returns 403 when a registry entry exists but is not satisfied', async () => {
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).get('/api/widgets').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/widgets',
      reason: 'permission_denied'
    });
  });

  it('logs reason: "resolver_exception" and returns 403 when a row-scoped resolver throws (fail closed)', async () => {
    mockIsAdmin.mockRejectedValueOnce(new Error('db connection lost'));
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .put('/api/teams/42')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/teams/42',
      reason: 'resolver_exception'
    });
    // The underlying exception is also logged at `error` level with full
    // context (actorId/resourceId/errorCategory), separate from the
    // Requirement 13.7 warn-level {ip, route, reason} line asserted above.
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError.mock.calls[0][0]).toMatchObject({
      errorCategory: 'authorization_check_exception',
      permission: 'team:update'
    });
  });

  it('does not log a failure when a row-scoped resolver grants access', async () => {
    mockIsAdmin.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .put('/api/teams/42')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('does not log a failure for a global manager (wildcard permission)', async () => {
    const app = buildApp({ userId: 1, is_global_manager: true });

    const res = await request(app).get('/api/widgets').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
