/**
 * Unit tests for orgDomains routes.
 *
 * Task 9.2 (signup-flow-rework spec)
 *
 * Tests GET /orgs/:orgId/domains, PUT /orgs/:orgId/domains,
 * GET /admin/excluded-domains, PUT /admin/excluded-domains,
 * PATCH /admin/org-interest/:id.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, isAdmin: true, is_global_manager: true };
    next();
  }
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

jest.mock('../middleware/requestContext', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() })
}));

// GET /admin/sync-status requires the heartbeat staleness threshold from the
// sync worker. Mock it to just the exported constant so the test does not pull
// in the whole worker module (Pool, jobs, etc.).
jest.mock('../workers/syncWorker', () => ({
  HEARTBEAT_STALE_THRESHOLD_MS: 90000
}));

const mockListRequests = jest.fn();
const mockUpdateStatus = jest.fn();

jest.mock('../services/OrgInterestService', () => {
  return jest.fn().mockImplementation(() => ({
    listRequests: mockListRequests,
    updateStatus: mockUpdateStatus
  }));
});

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('./orgDomains'));
  return app;
}

describe('orgDomains routes (Task 9.2)', () => {
  let app;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    mockClient = {
      query: jest.fn().mockResolvedValue({}),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
  });

  describe('GET /orgs/:orgId/domains', () => {
    it('returns domain list', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ domain: 'example.com' }, { domain: 'test.org' }]
      });

      const res = await request(app).get('/api/orgs/1/domains');

      expect(res.status).toBe(200);
      expect(res.body.domains).toEqual(['example.com', 'test.org']);
    });

    it('returns 400 for invalid orgId', async () => {
      const res = await request(app).get('/api/orgs/abc/domains');

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /orgs/:orgId/domains', () => {
    it('validates orgId is a root team (no parent)', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 1, parent_team_id: 5 }] // not root
      });

      const res = await request(app)
        .put('/api/orgs/1/domains')
        .send({ domains: ['example.com'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('root organisations');
    });

    it('returns 404 when org not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .put('/api/orgs/999/domains')
        .send({ domains: ['example.com'] });

      expect(res.status).toBe(404);
    });

    it('saves domains for valid root team', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 1, parent_team_id: null }] // root team
      });

      const res = await request(app)
        .put('/api/orgs/1/domains')
        .send({ domains: ['example.com', 'test.org'] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('returns 400 for missing domains array', async () => {
      const res = await request(app)
        .put('/api/orgs/1/domains')
        .send({ domains: 'not-an-array' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /admin/excluded-domains', () => {
    it('returns JSON array of excluded domains', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ config_value: JSON.stringify(['gmail.com', 'yahoo.com']) }]
      });

      const res = await request(app).get('/api/admin/excluded-domains');

      expect(res.status).toBe(200);
      expect(res.body.domains).toEqual(['gmail.com', 'yahoo.com']);
    });

    it('returns empty array when no config exists', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/api/admin/excluded-domains');

      expect(res.status).toBe(200);
      expect(res.body.domains).toEqual([]);
    });
  });

  describe('PUT /admin/excluded-domains', () => {
    it('saves excluded domains correctly', async () => {
      pool.query.mockResolvedValueOnce({}); // UPSERT

      const res = await request(app)
        .put('/api/admin/excluded-domains')
        .send({ domains: ['gmail.com', 'yahoo.com'] });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the upsert query was called with correct params
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO system_config'),
        ['excluded_email_domains', JSON.stringify(['gmail.com', 'yahoo.com'])]
      );
    });

    it('returns 400 for missing domains array', async () => {
      const res = await request(app)
        .put('/api/admin/excluded-domains')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /admin/org-interest/:id', () => {
    it('validates status values — rejects invalid', async () => {
      const res = await request(app)
        .patch('/api/admin/org-interest/1')
        .send({ status: 'invalid' });

      expect(res.status).toBe(400);
    });

    it('accepts "actioned" status', async () => {
      mockUpdateStatus.mockResolvedValueOnce();

      const res = await request(app)
        .patch('/api/admin/org-interest/1')
        .send({ status: 'actioned' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('accepts "dismissed" status', async () => {
      mockUpdateStatus.mockResolvedValueOnce();

      const res = await request(app)
        .patch('/api/admin/org-interest/1')
        .send({ status: 'dismissed' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 when request not found', async () => {
      mockUpdateStatus.mockRejectedValueOnce(new Error('Org interest request not found'));

      const res = await request(app)
        .patch('/api/admin/org-interest/99')
        .send({ status: 'actioned' });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/stats', () => {
    it('returns totalDevices and totalChannels from the aggregate query', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ total_devices: '7', total_channels: '42' }]
      });

      const res = await request(app).get('/api/admin/stats');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ totalDevices: 7, totalChannels: 42 });

      // The single query counts Team_Owned_Devices and sums team + BCH +
      // region channels -- the "all team channels and global channels" total.
      const [sql] = pool.query.mock.calls[0];
      expect(sql).toContain('FROM users WHERE is_team_device = true');
      expect(sql).toContain('FROM channels');
      expect(sql).toContain('FROM bch_channels');
      expect(sql).toContain('FROM region_channels');
    });

    it('coerces the counts to numbers and defaults missing values to 0', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{}] });

      const res = await request(app).get('/api/admin/stats');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ totalDevices: 0, totalChannels: 0 });
    });

    it('returns 500 when the query fails', async () => {
      pool.query.mockRejectedValueOnce(new Error('db down'));

      const res = await request(app).get('/api/admin/stats');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to get admin stats');
    });
  });

  describe('GET /admin/sync-status', () => {
    // The handler fires four pool.query calls via Promise.all, in this order:
    // (1) queue aggregate, (2) pending-by-type, (3) user_sync row, (4) heartbeat.
    const mockFourQueries = ({ queue, byType, userSync, heartbeat }) => {
      pool.query
        .mockResolvedValueOnce({ rows: [queue] })
        .mockResolvedValueOnce({ rows: byType })
        .mockResolvedValueOnce({ rows: userSync ? [userSync] : [] })
        .mockResolvedValueOnce({ rows: heartbeat ? [heartbeat] : [] });
    };

    it('reports queue depth, oldest-pending age, per-type breakdown, user_sync, and a fresh worker', async () => {
      mockFourQueries({
        queue: { pending: 42, failed: 3, processing: 1, oldest_pending_age_seconds: 125 },
        byType: [
          { operation_type: 'reconcile_owned_group', count: 40 },
          { operation_type: 'assign_user_to_global_channels', count: 2 }
        ],
        userSync: { status: 'success', last_sync: '2026-09-06T04:00:00.000Z', records_synced: 100, error_message: null },
        heartbeat: { last_heartbeat_at: new Date().toISOString(), worker_id: '77' }
      });

      const res = await request(app).get('/api/admin/sync-status');

      expect(res.status).toBe(200);
      expect(res.body.queue.pending).toBe(42);
      expect(res.body.queue.failed).toBe(3);
      expect(res.body.queue.oldestPendingAgeSeconds).toBe(125);
      expect(res.body.queue.pendingByType).toHaveLength(2);
      expect(res.body.userSync.status).toBe('success');
      expect(res.body.worker.stale).toBe(false);
      expect(res.body.worker.staleThresholdSeconds).toBe(90);
    });

    it('flags the worker stale when the last heartbeat is older than the threshold', async () => {
      mockFourQueries({
        queue: { pending: 0, failed: 0, processing: 0, oldest_pending_age_seconds: null },
        byType: [],
        userSync: null,
        heartbeat: { last_heartbeat_at: new Date(Date.now() - 120000).toISOString(), worker_id: '77' }
      });

      const res = await request(app).get('/api/admin/sync-status');

      expect(res.status).toBe(200);
      expect(res.body.worker.stale).toBe(true);
      // Empty queue -> null age, not a misleading 0.
      expect(res.body.queue.oldestPendingAgeSeconds).toBeNull();
    });

    it('flags the worker stale when no heartbeat row exists yet', async () => {
      mockFourQueries({
        queue: { pending: 0, failed: 0, processing: 0, oldest_pending_age_seconds: null },
        byType: [],
        userSync: null,
        heartbeat: null
      });

      const res = await request(app).get('/api/admin/sync-status');

      expect(res.status).toBe(200);
      expect(res.body.worker.stale).toBe(true);
      expect(res.body.worker.lastHeartbeatAt).toBeNull();
    });

    it('surfaces the completeness-guard sweep-skipped note from the user_sync error_message', async () => {
      mockFourQueries({
        queue: { pending: 5, failed: 0, processing: 0, oldest_pending_age_seconds: 10 },
        byType: [{ operation_type: 'reconcile_owned_group', count: 5 }],
        userSync: {
          status: 'success',
          last_sync: '2026-09-06T04:00:00.000Z',
          records_synced: 100,
          error_message: 'Reconciliation sweep skipped: incomplete fetch (900 of 1000)'
        },
        heartbeat: { last_heartbeat_at: new Date().toISOString(), worker_id: '77' }
      });

      const res = await request(app).get('/api/admin/sync-status');

      expect(res.status).toBe(200);
      expect(res.body.userSync.message).toContain('incomplete fetch');
    });

    it('returns 500 when a query fails', async () => {
      pool.query.mockRejectedValue(new Error('db down'));

      const res = await request(app).get('/api/admin/sync-status');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to get sync status');
    });
  });
});
