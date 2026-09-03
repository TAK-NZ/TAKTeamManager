/**
 * Unit tests for the Requirement 13.7 401/403 logging branches added to
 * `authenticateToken`/`requireTeamAdmin` (server/middleware/auth.js).
 *
 * Requirement 13.7: "IF a request to the App fails authorization (403) or
 * authentication (401), THEN THE App SHALL log that failure with the
 * requesting IP address, the requested route, and the reason for the
 * failure, to support security monitoring."
 *
 * These tests mock `server/config/database` (the `token_revocations`
 * lookup), `server/services/authentikSync` (the user-cache lookup), and
 * `server/middleware/requestContext`'s `getLogger()` so that every branch
 * can be exercised in isolation and asserted against a captured
 * `{ip, route, reason}` payload, without changing any response body or
 * status code behavior (this task is purely additive logging).
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../services/authentikSync', () => ({
  getUserFromCache: jest.fn()
}));

const mockWarn = jest.fn();
const mockError = jest.fn();

jest.mock('./requestContext', () => ({
  getLogger: () => ({ warn: mockWarn, error: mockError })
}));

const jwt = require('jsonwebtoken');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const pool = require('../config/database');
const authentikSync = require('../services/authentikSync');
const { authenticateToken } = require('./auth');

const JWT_SECRET = 'a'.repeat(32);
const TEST_IP = '203.0.113.7';

function buildApp(middleware) {
  const app = express();
  // `req.ip` is a read-only Express getter derived from the connection's
  // remote address (or `X-Forwarded-For` when `trust proxy` is enabled).
  // Enabling `trust proxy` and setting that header per-request is the
  // standard supertest-friendly way to get a deterministic `req.ip`.
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(cookieParser());
  app.get('/api/protected', middleware, (req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

function signToken(payload, options = {}) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h', ...options });
}

describe('authenticateToken (Requirement 13.7 logging)', () => {
  let originalJwtSecret;

  beforeAll(() => {
    originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalJwtSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs {ip, route, reason: "missing_token"} and returns 401 when no token cookie is present', async () => {
    const app = buildApp(authenticateToken);

    const res = await request(app).get('/api/protected').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(401);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/protected',
      reason: 'missing_token'
    });
    expect(message).toMatch(/Authentication failed/i);
  });

  it('logs reason: "expired_token" and returns 403 for an expired token', async () => {
    const app = buildApp(authenticateToken);
    const expiredToken = jwt.sign({ username: 'alice', jti: 'jti-1' }, JWT_SECRET, {
      expiresIn: '-1h'
    });

    const res = await request(app)
      .get('/api/protected')
      .set('X-Forwarded-For', TEST_IP)
      .set('Cookie', [`tak_session=${expiredToken}`]);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/protected',
      reason: 'expired_token'
    });
  });

  it('logs reason: "invalid_signature" and returns 403 for a token signed with the wrong secret', async () => {
    const app = buildApp(authenticateToken);
    const badToken = jwt.sign({ username: 'alice', jti: 'jti-2' }, 'wrong-secret-value', {
      expiresIn: '1h'
    });

    const res = await request(app)
      .get('/api/protected')
      .set('X-Forwarded-For', TEST_IP)
      .set('Cookie', [`tak_session=${badToken}`]);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/protected',
      reason: 'invalid_signature'
    });
  });

  it('logs reason: "token_revoked" and returns 401 when the token jti is in token_revocations', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    const app = buildApp(authenticateToken);
    const token = signToken({ username: 'alice', jti: 'revoked-jti' });

    const res = await request(app)
      .get('/api/protected')
      .set('X-Forwarded-For', TEST_IP)
      .set('Cookie', [`tak_session=${token}`]);

    expect(res.status).toBe(401);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/protected',
      reason: 'token_revoked'
    });
  });

  it('logs reason: "user_not_found" and returns 401 when the cached user lookup misses', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    authentikSync.getUserFromCache.mockResolvedValueOnce(null);
    const app = buildApp(authenticateToken);
    const token = signToken({ username: 'ghost', jti: 'jti-3' });

    const res = await request(app)
      .get('/api/protected')
      .set('X-Forwarded-For', TEST_IP)
      .set('Cookie', [`tak_session=${token}`]);

    expect(res.status).toBe(401);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/protected',
      reason: 'user_not_found'
    });
  });

  it('does not log a failure for a valid token referencing a cached user', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    authentikSync.getUserFromCache.mockResolvedValueOnce({
      id: 1,
      authentik_id: 'auth-1',
      username: 'alice',
      email: 'alice@example.com',
      first_name: 'Alice',
      last_name: 'Example',
      is_admin: false,
      groups: []
    });
    const app = buildApp(authenticateToken);
    const token = signToken({ username: 'alice', jti: 'jti-4' });

    const res = await request(app)
      .get('/api/protected')
      .set('X-Forwarded-For', TEST_IP)
      .set('Cookie', [`tak_session=${token}`]);

    expect(res.status).toBe(200);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe('requireTeamAdmin (Requirement 13.7 logging)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs {ip, route, reason: "team_admin_required"} and returns 403 when the user is not a team admin', async () => {
    let freshRequireTeamAdmin;

    jest.isolateModules(() => {
      jest.doMock('../models/Team', () => ({
        isAdmin: jest.fn().mockResolvedValue(false)
      }));
      jest.doMock('./requestContext', () => ({
        getLogger: () => ({ warn: mockWarn, error: mockError })
      }));
      jest.doMock('../config/database', () => ({ query: jest.fn() }));

      freshRequireTeamAdmin = require('./auth').requireTeamAdmin;
    });

    const app = express();
    app.set('trust proxy', true);
    app.use((req, res, next) => {
      req.user = { userId: 42 };
      next();
    });
    app.get('/api/teams/:teamId/admin-only', freshRequireTeamAdmin, (req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app)
      .get('/api/teams/9/admin-only')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/teams/9/admin-only',
      reason: 'team_admin_required'
    });
  });
});
