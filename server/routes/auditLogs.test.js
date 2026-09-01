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
    expect(res.body.auditLogs).toEqual(rows.map(r => ({ ...r, resource_name: null })));
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 50, total: 1 });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).not.toContain('WHERE');
    expect(dataCall[1]).toEqual([50, 0]);
  });

  it('filters by userEmail alone', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({ userEmail: 'test@example.com' });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain('users.email = $1');
    expect(dataCall[1]).toEqual(['test@example.com', 50, 0]);
  });

  it('filters by action alone', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({ action: 'bch_channel.create' });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain('action = $1');
    expect(dataCall[1]).toEqual(['bch_channel.create', 50, 0]);
  });

  it('filters by resourceType alone', async () => {
    mockRowsAndCount([], 0);

    await request(app).get('/api/audit-logs').query({ resourceType: 'bch_channel' });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain('resource_type = $1');
    expect(dataCall[1]).toEqual(['bch_channel', 50, 0]);
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
      userEmail: 'test@example.com',
      action: 'bch_channel.create',
      resourceType: 'bch_channel',
      startDate: '2024-01-01',
      endDate: '2024-01-31'
    });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && !sql.includes('COUNT'));
    expect(dataCall[0]).toContain('users.email = $1');
    expect(dataCall[0]).toContain('action = $2');
    expect(dataCall[0]).toContain('resource_type = $3');
    expect(dataCall[0]).toContain('created_at >= $4');
    expect(dataCall[0]).toContain('created_at <= $5');
    expect(dataCall[1]).toEqual([
      'test@example.com',
      'bch_channel.create',
      'bch_channel',
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

  it('ignores an unknown userId query parameter (no longer a recognized filter)', async () => {
    mockRowsAndCount([], 0);

    const res = await request(app).get('/api/audit-logs').query({ userId: 'abc' });

    expect(res.status).toBe(200);
  });

  it('returns 400 for a malformed startDate before querying the database', async () => {
    const res = await request(app).get('/api/audit-logs').query({ startDate: 'not-a-date' });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

/**
 * Bugfix (a raw internal id is meaningless to an admin reviewing the
 * log -- the same complaint already fixed for the User column):
 * `GET /api/audit-logs` resolves a `resource_id` to a human-readable
 * `resource_name` for every `resource_type` that carries one, including
 * the ones added here (`bch_channel`, `region_channel`) alongside the
 * pre-existing `team`/`user`/`channel`/`access_request` handling. A
 * `resource_type` this route has no name-resolution rule for (or a
 * resolvable id whose row has since been deleted) must resolve to
 * `resource_name: null` -- the client renders that as '—', never the raw
 * numeric id.
 */
describe('GET /api/audit-logs resolves resource_name for every nameable resource_type', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 1, userId: 1, is_global_manager: true };
    app = buildApp();
  });

  /**
   * A `pool.query` mock that answers the main audit_logs SELECT with
   * `rows`, the COUNT(*) query with `rows.length`, and every batched
   * name-resolution SELECT this route issues with whatever rows the
   * matching lookup table supplies -- keyed by the FROM clause's table
   * name so this helper needs no knowledge of query order or count.
   *
   * @param {object[]} rows the raw audit_logs rows (pre-enrichment).
   * @param {object} lookups optional per-table resolution rows, e.g.
   *   `{ bch_channels: [{ id: 5, display_name: 'BCH - Ops' }] }`.
   */
  function mockRowsAndResolution(rows, lookups = {}) {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT COUNT(*)')) {
        return Promise.resolve({ rows: [{ total: String(rows.length) }] });
      }
      if (sql.includes('FROM audit_logs')) {
        return Promise.resolve({ rows });
      }
      for (const [table, tableRows] of Object.entries(lookups)) {
        if (sql.includes(`FROM ${table}`)) {
          return Promise.resolve({ rows: tableRows });
        }
      }
      // Any other lookup table not explicitly stubbed above (e.g. this
      // fixture has no bch_channels row to resolve) has nothing to
      // return -- matching what a real ANY($1) WHERE clause over an
      // empty/non-matching id set would answer.
      return Promise.resolve({ rows: [] });
    });
  }

  it.each([
    ['bch_channel', 'bch_channels', { id: 5, display_name: 'BCH - Ops' }, 'BCH - Ops'],
    ['region_channel', 'region_channels', { id: 6, display_name: 'North - Alpha' }, 'North - Alpha']
  ])('resolves a %s resource_id to its real name via %s', async (resourceType, table, lookupRow, expectedName) => {
    const rows = [{
      id: 1,
      user_id: 1,
      action: `${resourceType}.create`,
      resource_type: resourceType,
      resource_id: lookupRow.id,
      details: null,
      created_at: '2024-01-01'
    }];
    mockRowsAndResolution(rows, { [table]: [lookupRow] });

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body.auditLogs[0].resource_name).toBe(expectedName);
  });

  it('resolves resource_name to null (not the raw resource_id) when the resolvable row has since been deleted', async () => {
    const rows = [{
      id: 1,
      user_id: 1,
      action: 'bch_channel.create',
      resource_type: 'bch_channel',
      resource_id: 999,
      details: null,
      created_at: '2024-01-01'
    }];
    // The lookup query runs but returns no matching row -- the channel
    // was deleted after this audit_logs row was written.
    mockRowsAndResolution(rows, { bch_channels: [] });

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body.auditLogs[0].resource_name).toBeNull();
    // The raw id must not leak into resource_name as a fallback.
    expect(res.body.auditLogs[0].resource_name).not.toBe(999);
  });

  it('resolves resource_name to null for a resource_type with no meaningful name of its own (e.g. a sync operation)', async () => {
    const rows = [{
      id: 1,
      user_id: 1,
      action: 'sync.trigger',
      resource_type: 'sync',
      resource_id: 42,
      details: null,
      created_at: '2024-01-01'
    }];
    mockRowsAndResolution(rows);

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body.auditLogs[0].resource_name).toBeNull();
  });

  it('resolves resource_name to null for a row whose resource_id is itself null (e.g. settings.update_branding)', async () => {
    const rows = [{
      id: 1,
      user_id: 1,
      action: 'settings.update_branding',
      resource_type: 'settings',
      resource_id: null,
      details: null,
      created_at: '2024-01-01'
    }];
    mockRowsAndResolution(rows);

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body.auditLogs[0].resource_name).toBeNull();
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

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && sql.includes('LEFT JOIN users'));
    expect(dataCall[0]).toContain("audit_logs.resource_type = 'team' AND audit_logs.resource_id = $1");
    expect(dataCall[0]).toContain("audit_logs.resource_type = 'channel' AND audit_logs.resource_id IN");
    // teamId param twice, then chunk LIMIT/OFFSET.
    expect(dataCall[1]).toEqual(['3', '3', 500, 0]);
  });

  it('applies a combination of filters identically to the JSON endpoint', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/audit-logs/export.csv').query({
      userEmail: 'test@example.com',
      action: 'deployment_channel.create',
      resourceType: 'deployment_channel'
    });

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && sql.includes('LEFT JOIN users'));
    expect(dataCall[0]).toContain('users.email = $1');
    expect(dataCall[0]).toContain('audit_logs.action = $2');
    expect(dataCall[0]).toContain('audit_logs.resource_type = $3');
    expect(dataCall[1]).toEqual(['test@example.com', 'deployment_channel.create', 'deployment_channel', 500, 0]);
  });

  it('orders results by created_at DESC (with id DESC tiebreak), matching the JSON route', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/audit-logs/export.csv');

    const dataCall = pool.query.mock.calls.find(([sql]) => sql.includes('FROM audit_logs') && sql.includes('LEFT JOIN users'));
    expect(dataCall[0]).toContain('ORDER BY audit_logs.created_at DESC, audit_logs.id DESC');
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
