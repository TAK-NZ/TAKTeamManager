/**
 * Integration tests for `GET /api/audit-logs` (Requirement 31 Criterion
 * 1, task 53.1).
 *
 * These exercise the actual mounted route via `supertest`, mocking
 * `pool.query` to verify:
 *
 *  - No filters: returns all rows, paginated.
 *  - Each individual filter (`userId`, `action`, `resourceType`,
 *    `teamId`, `startDate`/`endDate`) is translated into the expected
 *    SQL WHERE fragment and parameter list.
 *  - Combined filters compose with AND.
 *  - Authorization is enforced (a non-Global_Manager caller is rejected)
 *    -- exercised here by mocking `authorize.js` to reproduce its
 *    deny-by-default/permission-check behavior against the real
 *    Permission_Registry entry for this route, rather than trivially
 *    always calling `next()` as most other route test files do, since
 *    this specific test is about proving the route is NOT reachable by
 *    a plain authenticated user.
 *
 * `authenticateToken` is mocked to bypass real JWT verification, but the
 * REAL `authorize.js` middleware and `permissions.registry.js` are used
 * (not mocked): every test below sets `req.user.is_global_manager`
 * explicitly, so the authorization outcome for each request is exercised
 * for real rather than assumed, and a regression removing this route's
 * `audit_log:read` registry entry would be caught by the "no filters"
 * test failing with 403 instead of 200.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

let mockUser = { id: 1, userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const auditLogsRouter = require('./auditLogs');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/audit-logs', auditLogsRouter);
  return app;
}

describe('GET /api/audit-logs authorization (Requirement 31 Criterion 4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('rejects a non-Global_Manager authenticated user with 403 and never queries the database', async () => {
    mockUser = { id: 2, userId: 2, is_global_manager: false };

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('permits a Global_Manager caller', async () => {
    mockUser = { id: 1, userId: 1, is_global_manager: true };
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: '0' }] });

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(200);
  });
});

describe('GET /api/audit-logs filtering and pagination', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 1, userId: 1, is_global_manager: true };
    app = buildApp();
  });

  function mockRowsAndCount(rows, total) {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT COUNT(*)')) {
        return Promise.resolve({ rows: [{ total: String(total) }] });
      }
      return Promise.resolve({ rows });
    });
  }

  it('returns all rows, paginated, with no filters supplied', async () => {
    const rows = [{ id: 1, user_id: 1, action: 'x', resource_type: 'team', resource_id: 1, details: null, created_at: '2024-01-01' }];
    mockRowsAndCount(rows, 1);

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body.auditLogs).toEqual(rows);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 50, total: 1 });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).not.toContain('WHERE');
    expect(dataCall[1]).toEqual([50, 0]);
  });

  it('filters by userId alone', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({ userId: 7 });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain('user_id = $1');
    expect(dataCall[1]).toEqual(['7', 50, 0]);
  });

  it('filters by action alone', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({ action: 'vendor_channel_grant_created' });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain('action = $1');
    expect(dataCall[1]).toEqual(['vendor_channel_grant_created', 50, 0]);
  });

  it('filters by resourceType alone', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({ resourceType: 'vendor_channel_grant' });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain('resource_type = $1');
    expect(dataCall[1]).toEqual(['vendor_channel_grant', 50, 0]);
  });

  it('filters by teamId alone, matching team-scoped resource_type rows only', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({ teamId: 3 });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain("audit_logs.resource_type = 'team' AND audit_logs.resource_id = $1");
    expect(dataCall[0]).toContain("audit_logs.resource_type = 'channel' AND audit_logs.resource_id IN");
    expect(dataCall[1]).toEqual(['3', '3', 50, 0]);
  });

  it('filters by startDate/endDate date range', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({ startDate: '2024-01-01', endDate: '2024-01-31' });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain('created_at >= $1');
    expect(dataCall[0]).toContain('created_at <= $2');
    expect(dataCall[1]).toEqual(['2024-01-01', '2024-01-31', 50, 0]);
  });

  it('combines multiple filters with AND', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({
      userId: 7,
      action: 'vendor_channel_grant_created',
      resourceType: 'vendor_channel_grant',
      startDate: '2024-01-01',
      endDate: '2024-01-31'
    });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain('user_id = $1');
    expect(dataCall[0]).toContain('action = $2');
    expect(dataCall[0]).toContain('resource_type = $3');
    expect(dataCall[0]).toContain('created_at >= $4');
    expect(dataCall[0]).toContain('created_at <= $5');
    expect(dataCall[1]).toEqual([
      '7',
      'vendor_channel_grant_created',
      'vendor_channel_grant',
      '2024-01-01',
      '2024-01-31',
      50,
      0
    ]);
  });

  it('applies page/pageSize from the shared pagination middleware', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({ page: 3, pageSize: 10 });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    // page=3, pageSize=10 -> offset = (3-1)*10 = 20
    expect(dataCall[1]).toEqual([10, 20]);
  });

  it('returns 400 for an out-of-range pageSize before querying the database', async () => {
    const res = await request(app).get('/api/audit-logs').query({ pageSize: 500 });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-integer userId before querying the database', async () => {
    const res = await request(app).get('/api/audit-logs').query({ userId: 'abc' });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed startDate before querying the database', async () => {
    const res = await request(app).get('/api/audit-logs').query({ startDate: 'not-a-date' });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

/**
 * Integration tests for `GET /api/audit-logs/export.csv` (Requirement 31
 * Criterion 2, task 53.2).
 *
 * Mirrors the JSON route's test shape: `authenticateToken` is mocked, the
 * REAL `authorize.js` middleware and `permissions.registry.js` are used,
 * and `pool.query` is mocked to control exactly what rows the chunked
 * fetch loop sees.
 */
describe('GET /api/audit-logs/export.csv authorization (Requirement 31 Criterion 4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('rejects a non-Global_Manager authenticated user with 403 and never queries the database', async () => {
    mockUser = { id: 2, userId: 2, is_global_manager: false };

    const res = await request(app).get('/api/audit-logs/export.csv');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('permits a Global_Manager caller', async () => {
    mockUser = { id: 1, userId: 1, is_global_manager: true };
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/audit-logs/export.csv');

    expect(res.status).toBe(200);
  });
});

describe('GET /api/audit-logs/export.csv headers and content', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 1, userId: 1, is_global_manager: true };
    app = buildApp();
  });

  it('sets Content-Type and Content-Disposition headers for a CSV file download', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/audit-logs/export.csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe('attachment; filename="audit-logs-export.csv"');
  });

  it('streams a CSV header row plus one row per matching audit_logs row', async () => {
    const rows = [
      { id: 2, user_id: 1, action: 'y', resource_type: 'team', resource_id: 3, details: { foo: 'bar' }, created_at: '2024-01-02T00:00:00.000Z' },
      { id: 1, user_id: 1, action: 'x', resource_type: 'team', resource_id: 3, details: null, created_at: '2024-01-01T00:00:00.000Z' }
    ];
    pool.query.mockResolvedValueOnce({ rows });

    const res = await request(app).get('/api/audit-logs/export.csv');

    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('id,user_id,action,resource_type,resource_id,details,created_at');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('2,1,y,team,3');
    expect(lines[2]).toContain('1,1,x,team,3');
  });

  it('applies the same filter criteria as the JSON endpoint (teamId filter)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/audit-logs/export.csv').query({ teamId: 3 });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('SELECT id, user_id'));
    expect(dataCall[0]).toContain("audit_logs.resource_type = 'team' AND audit_logs.resource_id = $1");
    expect(dataCall[0]).toContain("audit_logs.resource_type = 'channel' AND audit_logs.resource_id IN");
    // teamId param twice, then chunk LIMIT/OFFSET.
    expect(dataCall[1]).toEqual(['3', '3', 500, 0]);
  });

  it('applies a combination of filters identically to the JSON endpoint', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/audit-logs/export.csv').query({
      userId: 7,
      action: 'vendor_channel_grant_created',
      resourceType: 'vendor_channel_grant'
    });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('SELECT id, user_id'));
    expect(dataCall[0]).toContain('audit_logs.user_id = $1');
    expect(dataCall[0]).toContain('audit_logs.action = $2');
    expect(dataCall[0]).toContain('audit_logs.resource_type = $3');
    expect(dataCall[1]).toEqual(['7', 'vendor_channel_grant_created', 'vendor_channel_grant', 500, 0]);
  });

  it('orders results by created_at DESC (with id DESC tiebreak), matching the JSON route', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/audit-logs/export.csv');

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('SELECT id, user_id'));
    expect(dataCall[0]).toContain('ORDER BY created_at DESC, id DESC');
  });

  it('does not accept page/pageSize (exports every matching row across multiple chunks)', async () => {
    const firstChunk = Array.from({ length: 2 }, (_, i) => ({
      id: 500 - i,
      user_id: 1,
      action: 'x',
      resource_type: 'team',
      resource_id: 1,
      details: null,
      created_at: '2024-01-01T00:00:00.000Z'
    }));
    // First call returns fewer than EXPORT_CHUNK_SIZE (2 rows), so the
    // loop should stop after just one chunk fetch.
    pool.query.mockResolvedValueOnce({ rows: firstChunk });

    const res = await request(app).get('/api/audit-logs/export.csv');

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 rows
  });
});
