/**
 * Integration tests for `server/routes/bulkImport.js` (Requirement 29,
 * task 51.4).
 *
 * `authenticateToken` is mocked to bypass real JWT verification, but the
 * REAL `authorize.js` middleware and `permissions.registry.js` are used
 * (not mocked), matching the convention already established by
 * `server/routes/settings.test.js`/`server/routes/auditLogs.test.js`:
 * every test sets `req.user.is_global_manager` explicitly, so the
 * authorization outcome for each request is exercised for real rather
 * than assumed, and a regression removing this route's
 * `bulk_import:users`/`bulk_import:teams` registry entries would be
 * caught by the "success" tests failing with 403 instead of 200.
 *
 * `BulkImportService.importUsers`/`.importTeams` are mocked at the
 * class-method boundary (`jest.mock('../services/BulkImportService')`),
 * so these tests exercise only the route layer: multipart upload
 * handling, missing-file validation, authorization, and error-class ->
 * HTTP-status mapping -- not the service's own CSV-parsing or per-row
 * logic (already covered by `BulkImportService.test.js`).
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

let mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

jest.mock('../services/BulkImportService', () => {
  class BulkImportAuthorizationError extends Error {
    constructor(message = 'Team import is restricted to Global_Manager') {
      super(message);
      this.name = 'BulkImportAuthorizationError';
    }
  }

  return {
    importUsers: jest.fn(),
    importTeams: jest.fn(),
    BulkImportAuthorizationError
  };
});

const express = require('express');
const request = require('supertest');
const BulkImportService = require('../services/BulkImportService');
const bulkImportRouter = require('./bulkImport');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bulk-import', bulkImportRouter);
  return app;
}

describe('POST /api/bulk-import/users', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: false };
    app = buildApp();
  });

  it('returns the full per-row results summary on success', async () => {
    const serviceResult = {
      successCount: 1,
      failureCount: 1,
      results: [
        { row: 1, success: true, userId: 42 },
        { row: 2, success: false, error: 'Missing required field: email' }
      ]
    };
    BulkImportService.importUsers.mockResolvedValue(serviceResult);

    const res = await request(app)
      .post('/api/bulk-import/users')
      .attach('csv', Buffer.from('email,firstName,lastName,teamId\n'), { filename: 'users.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(serviceResult);
    expect(BulkImportService.importUsers).toHaveBeenCalledTimes(1);
    const [bufferArg, userArg] = BulkImportService.importUsers.mock.calls[0];
    expect(Buffer.isBuffer(bufferArg)).toBe(true);
    expect(userArg).toEqual(mockUser);
  });

  it('permits a team-admin (non-Global_Manager) caller to reach the route (200, not 403), since per-row auth is the service\'s job', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };
    BulkImportService.importUsers.mockResolvedValue({ successCount: 0, failureCount: 0, results: [] });

    const res = await request(app)
      .post('/api/bulk-import/users')
      .attach('csv', Buffer.from('email,firstName,lastName,teamId\n'), { filename: 'users.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(BulkImportService.importUsers).toHaveBeenCalledTimes(1);
  });

  it('returns 400 and never calls the service when no file is uploaded', async () => {
    const res = await request(app).post('/api/bulk-import/users');

    expect(res.status).toBe(400);
    expect(BulkImportService.importUsers).not.toHaveBeenCalled();
  });

  it('returns 500 when the service throws an unexpected error', async () => {
    BulkImportService.importUsers.mockRejectedValue(new Error('unexpected failure'));

    const res = await request(app)
      .post('/api/bulk-import/users')
      .attach('csv', Buffer.from('email,firstName,lastName,teamId\n'), { filename: 'users.csv', contentType: 'text/csv' });

    expect(res.status).toBe(500);
  });
});

describe('POST /api/bulk-import/teams', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns the full per-row results summary on success for a Global_Manager', async () => {
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    const serviceResult = {
      successCount: 1,
      failureCount: 0,
      results: [{ row: 1, success: true, teamId: 7 }]
    };
    BulkImportService.importTeams.mockResolvedValue(serviceResult);

    const res = await request(app)
      .post('/api/bulk-import/teams')
      .attach('csv', Buffer.from('name,parentTeamName,parentTeamId\n'), { filename: 'teams.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(serviceResult);
    expect(BulkImportService.importTeams).toHaveBeenCalledTimes(1);
    const [, userArg] = BulkImportService.importTeams.mock.calls[0];
    expect(userArg).toEqual(mockUser);
  });

  it('passes through a rejected: true whole-file-rejection response body unchanged, with 200', async () => {
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    const serviceResult = {
      successCount: 0,
      failureCount: 2,
      results: [
        { error: 'Duplicate rowId: org1', rowIds: ['org1'] }
      ],
      rejected: true
    };
    BulkImportService.importTeams.mockResolvedValue(serviceResult);

    const res = await request(app)
      .post('/api/bulk-import/teams')
      .attach('csv', Buffer.from('rowId,name\norg1,FENZ A\norg1,FENZ B\n'), { filename: 'teams.csv', contentType: 'text/csv' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(serviceResult);
    expect(BulkImportService.importTeams).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-Global_Manager caller with 403 at the registry/permission layer and never calls the service', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app)
      .post('/api/bulk-import/teams')
      .attach('csv', Buffer.from('name,parentTeamName,parentTeamId\n'), { filename: 'teams.csv', contentType: 'text/csv' });

    expect(res.status).toBe(403);
    expect(BulkImportService.importTeams).not.toHaveBeenCalled();
  });

  it('returns 400 and never calls the service when no file is uploaded', async () => {
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };

    const res = await request(app).post('/api/bulk-import/teams');

    expect(res.status).toBe(400);
    expect(BulkImportService.importTeams).not.toHaveBeenCalled();
  });

  it('maps a BulkImportAuthorizationError thrown by the service to 403', async () => {
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    BulkImportService.importTeams.mockRejectedValue(
      new BulkImportService.BulkImportAuthorizationError()
    );

    const res = await request(app)
      .post('/api/bulk-import/teams')
      .attach('csv', Buffer.from('name,parentTeamName,parentTeamId\n'), { filename: 'teams.csv', contentType: 'text/csv' });

    expect(res.status).toBe(403);
  });

  it('returns 500 when the service throws an unexpected error', async () => {
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    BulkImportService.importTeams.mockRejectedValue(new Error('unexpected failure'));

    const res = await request(app)
      .post('/api/bulk-import/teams')
      .attach('csv', Buffer.from('name,parentTeamName,parentTeamId\n'), { filename: 'teams.csv', contentType: 'text/csv' });

    expect(res.status).toBe(500);
  });
});
