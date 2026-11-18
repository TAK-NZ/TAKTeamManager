/**
 * Route tests for `DELETE /api/users/remove-from-team/:userId`.
 *
 * The removal logic itself (local transaction first, the orphaned tombstone for
 * a user with history, the Authentik delete and its compensating cleanup, the
 * certificate-revoke dry-run reporting and the audit row) lives in
 * `UserRemovalService` and is covered in `UserRemovalService.test.js`. This file
 * covers only what the route owns: wiring, status codes and the response shape.
 */
jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));
jest.mock('../middleware/authorize', () => (req, res, next) => next());
jest.mock('../services/UserRemovalService', () => ({
  permanentlyRemoveUser: jest.fn()
}));
const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../middleware/requestContext', () => ({
  getLogger: () => mockLoggerInstance
}));

const express = require('express');
const request = require('supertest');
const UserRemovalService = require('../services/UserRemovalService');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

const OUTCOME = {
  groupsQueued: 2,
  authentikAccountDeleted: true,
  certificateRevocationDryRun: true,
  localRowRetained: false
};

describe('DELETE /api/users/remove-from-team/:userId', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    UserRemovalService.permanentlyRemoveUser.mockResolvedValue(OUTCOME);
  });

  it('removes the user, passing the target and the requesting admin to the service', async () => {
    const res = await request(app).delete('/api/users/remove-from-team/7').send({ teamId: 3 });
    expect(res.status).toBe(200);
    expect(UserRemovalService.permanentlyRemoveUser).toHaveBeenCalledTimes(1);
    expect(UserRemovalService.permanentlyRemoveUser).toHaveBeenCalledWith('7', 1);
  });

  it('reports the service outcome in the response', async () => {
    const res = await request(app).delete('/api/users/remove-from-team/7').send({ teamId: 3 });
    expect(res.body).toEqual({
      message: 'User removed from team successfully',
      operationsQueued: 2,
      authentikAccountDeleted: true,
      certificateRevocationDryRun: true,
      localRowRetained: false
    });
  });

  it('tells the admin when the local row had to be kept (the user has history)', async () => {
    UserRemovalService.permanentlyRemoveUser.mockResolvedValue({ ...OUTCOME, localRowRetained: true });
    const res = await request(app).delete('/api/users/remove-from-team/7').send({ teamId: 3 });
    expect(res.status).toBe(200);
    expect(res.body.localRowRetained).toBe(true);
  });

  it('reports a failed Authentik delete without turning it into an error', async () => {
    UserRemovalService.permanentlyRemoveUser.mockResolvedValue({ ...OUTCOME, authentikAccountDeleted: false });
    const res = await request(app).delete('/api/users/remove-from-team/7').send({ teamId: 3 });
    expect(res.status).toBe(200);
    expect(res.body.authentikAccountDeleted).toBe(false);
  });

  it('returns 404 for an unknown user', async () => {
    UserRemovalService.permanentlyRemoveUser.mockResolvedValue(null);
    const res = await request(app).delete('/api/users/remove-from-team/999').send({ teamId: 3 });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  it('returns a generic 500 (no internals leaked) when the removal fails, as nothing was changed', async () => {
    UserRemovalService.permanentlyRemoveUser.mockRejectedValue(new Error('connection reset to 10.0.2.5:5432'));
    const res = await request(app).delete('/api/users/remove-from-team/7').send({ teamId: 3 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to remove user from team' });
    expect(JSON.stringify(res.body)).not.toContain('10.0.2.5');
  });

  it('rejects a body without a teamId before calling the service', async () => {
    const res = await request(app).delete('/api/users/remove-from-team/7').send({});
    expect(res.status).toBe(400);
    expect(UserRemovalService.permanentlyRemoveUser).not.toHaveBeenCalled();
  });
});
