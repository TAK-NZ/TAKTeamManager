/**
 * Route tests for POST /api/users/:userId/reset-mfa. MfaResetService is mocked; authorization (the
 * `user:reset_mfa:team_admin` resolver) is covered in authorize.resetMfa.test.js.
 */
jest.mock('../services/MfaResetService', () => {
  class MfaResetError extends Error {
    constructor(message, status = 400) {
      super(message);
      this.name = 'MfaResetError';
      this.status = status;
    }
  }
  const svc = { resetMfa: jest.fn() };
  svc.MfaResetError = MfaResetError;
  return svc;
});
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { userId: 9, id: 'authentik-9', is_global_manager: false };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));
jest.mock('../middleware/authorize', () => (req, res, next) => next());
const express = require('express');
const request = require('supertest');
const MfaResetService = require('../services/MfaResetService');
const usersRouter = require('./users');
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}
describe('POST /api/users/:userId/reset-mfa', () => {
  beforeEach(() => jest.clearAllMocks());
  it('refuses a request that does not confirm the identity of the person', async () => {
    for (const body of [undefined, {}, { identityConfirmed: false }, { identityConfirmed: 'true' }]) {
      const req = request(buildApp()).post('/api/users/42/reset-mfa');
      const res = await (body === undefined ? req : req.send(body));
      expect(res.status).toBe(400);
    }
    expect(MfaResetService.resetMfa).not.toHaveBeenCalled();
  });
  it('calls the service with the target and the acting user, and returns its result', async () => {
    MfaResetService.resetMfa.mockResolvedValue({ userId: 42, email: 'p@example.com', devicesRemoved: 2, sessionsEnded: 1 });
    const res = await request(buildApp()).post('/api/users/42/reset-mfa').send({ identityConfirmed: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: 42, devicesRemoved: 2, sessionsEnded: 1 });
    expect(MfaResetService.resetMfa).toHaveBeenCalledWith('42', expect.objectContaining({ userId: 9 }));
  });
  it('passes on the status and message of a refusal', async () => {
    MfaResetService.resetMfa.mockRejectedValue(new MfaResetService.MfaResetError('Only a Global Manager can reset the MFA of an administrator', 403));
    const res = await request(buildApp()).post('/api/users/42/reset-mfa').send({ identityConfirmed: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Global Manager/);
  });
  it('maps an unexpected error to 500 without its message', async () => {
    MfaResetService.resetMfa.mockRejectedValue(new Error('secret detail'));
    const res = await request(buildApp()).post('/api/users/42/reset-mfa').send({ identityConfirmed: true });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret detail');
  });
});
