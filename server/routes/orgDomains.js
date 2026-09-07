const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const { writeAuditLog } = require('../utils/auditLog');
const OrgInterestService = require('../services/OrgInterestService');

const router = express.Router();
const orgInterestService = new OrgInterestService();

// GET /orgs/:orgId/domains — get allowed domains for an org
router.get('/orgs/:orgId/domains', authenticateToken, authorize, [
  param('orgId').isInt({ min: 1 }).withMessage('orgId must be a positive integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const result = await pool.query(
      'SELECT domain FROM org_allowed_domains WHERE org_id = $1 ORDER BY domain',
      [req.params.orgId]
    );
    res.json({ domains: result.rows.map(r => r.domain) });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to get org domains');
    res.status(500).json({ error: 'Failed to get org domains' });
  }
});

// PUT /orgs/:orgId/domains — set allowed domains for an org
router.put('/orgs/:orgId/domains', authenticateToken, authorize, [
  param('orgId').isInt({ min: 1 }).withMessage('orgId must be a positive integer'),
  body('domains').isArray().withMessage('domains must be an array')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { orgId } = req.params;
    const { domains } = req.body;

    // Validate orgId is a root team (no parent)
    const teamResult = await pool.query(
      'SELECT id, parent_team_id FROM teams WHERE id = $1',
      [orgId]
    );

    if (teamResult.rows.length === 0) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    if (teamResult.rows[0].parent_team_id !== null) {
      return res.status(400).json({ error: 'Domain restrictions can only be set on root organisations' });
    }

    // Replace all domains in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM org_allowed_domains WHERE org_id = $1', [orgId]);

      for (const domain of domains) {
        if (typeof domain === 'string' && domain.trim().length > 0) {
          await client.query(
            'INSERT INTO org_allowed_domains (org_id, domain) VALUES ($1, $2)',
            [orgId, domain.trim().toLowerCase()]
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await writeAuditLog({
      userId: req.user.userId,
      action: 'org_domains.update',
      resourceType: 'team',
      resourceId: parseInt(orgId, 10),
      details: { domainCount: Array.isArray(domains) ? domains.length : 0 }
    });

    res.json({ success: true });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update org domains');
    res.status(500).json({ error: 'Failed to update org domains' });
  }
});

// GET /admin/excluded-domains — get globally excluded email domains
router.get('/admin/excluded-domains', authenticateToken, authorize, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT config_value FROM system_config WHERE config_key = $1",
      ['excluded_email_domains']
    );

    let domains = [];
    if (result.rows.length > 0) {
      try {
        domains = JSON.parse(result.rows[0].config_value);
      } catch {
        domains = [];
      }
    }

    res.json({ domains });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to get excluded domains');
    res.status(500).json({ error: 'Failed to get excluded domains' });
  }
});

// PUT /admin/excluded-domains — set globally excluded email domains
router.put('/admin/excluded-domains', authenticateToken, authorize, [
  body('domains').isArray().withMessage('domains must be an array')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { domains } = req.body;
    const value = JSON.stringify(domains.map(d => (typeof d === 'string' ? d.trim().toLowerCase() : d)));

    // Upsert into system_config
    await pool.query(
      `INSERT INTO system_config (config_key, config_value)
       VALUES ($1, $2)
       ON CONFLICT (config_key) DO UPDATE SET config_value = $2`,
      ['excluded_email_domains', value]
    );

    await writeAuditLog({
      userId: req.user.userId,
      action: 'excluded_domains.update',
      resourceType: 'system_config',
      resourceId: null,
      details: { domainCount: Array.isArray(domains) ? domains.length : 0 }
    });

    res.json({ success: true });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update excluded domains');
    res.status(500).json({ error: 'Failed to update excluded domains' });
  }
});

// GET /admin/org-interest — list org interest requests
router.get('/admin/org-interest', authenticateToken, authorize, async (req, res) => {
  try {
    const requests = await orgInterestService.listRequests(req.query);
    res.json({ requests });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to list org interest requests');
    res.status(500).json({ error: 'Failed to list org interest requests' });
  }
});

// PATCH /admin/org-interest/:id — update org interest request status
router.patch('/admin/org-interest/:id', authenticateToken, authorize, [
  param('id').isInt({ min: 1 }).withMessage('id must be a positive integer'),
  body('status').isIn(['actioned', 'dismissed']).withMessage('status must be actioned or dismissed')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    await orgInterestService.updateStatus(req.params.id, req.body.status);

    await writeAuditLog({
      userId: req.user.userId,
      action: 'org_interest.update_status',
      resourceType: 'org_interest_request',
      resourceId: parseInt(req.params.id, 10),
      details: { status: req.body.status }
    });

    res.json({ success: true });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update org interest request');
    if (error.message === 'Org interest request not found') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to update org interest request' });
  }
});

// GET /admin/stats — Global_Manager-only aggregate counts for the /admin
// dashboard's stat cards. Returns the two counts the page can't already
// derive from its existing calls:
//   - totalDevices:  Team_Owned_Devices, defined app-wide the SAME way the
//                    /teams overview's per-team `device_count` is -- a
//                    `users` row with `is_team_device = true` (see
//                    Team.getAllTeams / getSubtreeMemberDeviceCounts). An
//                    app-wide total is a single unqualified COUNT of those
//                    rows (a device belongs to exactly one team, so this is
//                    per-device, not per-membership).
//   - totalChannels: EVERY channel, team AND global -- team channels
//                    (`channels`) plus both global-channel kinds
//                    (`bch_channels` + `region_channels`), matching the
//                    user's "include all team channels and global channels".
// Local-only counts (no Authentik round-trip); all three run in one query.
// Global_Manager-only via the 'admin:stats:read' permission identifier
// (not in roleDefaults.authenticated_user), mirroring audit_log:read's gate.
router.get('/admin/stats', authenticateToken, authorize, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE is_team_device = true) AS total_devices,
        (
          (SELECT COUNT(*) FROM channels)
          + (SELECT COUNT(*) FROM bch_channels)
          + (SELECT COUNT(*) FROM region_channels)
        ) AS total_channels
    `);
    const row = result.rows[0] || {};
    res.json({
      totalDevices: parseInt(row.total_devices, 10) || 0,
      totalChannels: parseInt(row.total_channels, 10) || 0
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to get admin stats');
    res.status(500).json({ error: 'Failed to get admin stats' });
  }
});

// GET /admin/sync-status — Global_Manager-only background-process health for
// the /admin "Background Sync" card. Gives an operator direct insight into how
// far behind the background processes are, which previously was invisible in
// the UI. Three parts, all local reads (no Authentik round-trip):
//
//   - queue:  the `sync_operations` backlog. `pending` (total) + `pendingByType`
//             (per operation_type) show DEPTH; `oldestPendingAgeSeconds`
//             (NOW() - the oldest pending row's created_at) shows how far BEHIND
//             the worker is in wall-clock terms; `failed` counts rows that
//             exhausted retries / hit a permanent validation failure.
//   - userSync: the single `sync_status` 'user_sync' row (status, last_sync,
//             records_synced, and error_message -- which also carries the
//             completeness-guard "Reconciliation sweep skipped: incomplete
//             fetch" note, so it surfaces here instead of being invisible).
//   - worker: the sync-worker liveness, read from the shared
//             `sync_worker_heartbeat` row and compared against the worker's OWN
//             staleness threshold (required from syncWorker.js so the two never
//             disagree). `stale` true means the worker has not heartbeat within
//             the threshold -- i.e. it may be down and the queue is not draining.
router.get('/admin/sync-status', authenticateToken, authorize, async (req, res) => {
  try {
    // Single-source the staleness threshold from the worker rather than
    // re-declaring 90000 here (mirrors the health endpoint's own reuse).
    const { HEARTBEAT_STALE_THRESHOLD_MS } = require('../workers/syncWorker');

    const [queueResult, byTypeResult, userSyncResult, heartbeatResult] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          -- RECENT failures only (rolling 24h), not all-time. The retention
          -- job keeps terminal rows for 90 days, so an all-time COUNT would
          -- report long-closed failures (e.g. an incident's cancelled ops)
          -- as if they were current — alarming and useless to an operator.
          -- A rolling window self-resets as old failures age out, with no
          -- data deleted and the forensic trail intact. Keyed on
          -- COALESCE(completed_at, created_at) since a failed row's
          -- completed_at is when it reached the failed state.
          COUNT(*) FILTER (
            WHERE status = 'failed'
              AND COALESCE(completed_at, created_at) > NOW() - INTERVAL '24 hours'
          )::int AS failed_recent,
          COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
          EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status = 'pending')))::int AS oldest_pending_age_seconds
        FROM sync_operations
      `),
      pool.query(`
        SELECT operation_type, COUNT(*)::int AS count
        FROM sync_operations
        WHERE status = 'pending'
        GROUP BY operation_type
        ORDER BY count DESC
      `),
      pool.query(
        `SELECT status, last_sync, records_synced, error_message
         FROM sync_status WHERE sync_type = 'user_sync'`
      ),
      pool.query('SELECT last_heartbeat_at, worker_id FROM sync_worker_heartbeat WHERE id = 1')
    ]);

    const q = queueResult.rows[0] || {};
    const userSync = userSyncResult.rows[0] || null;

    // Worker liveness: stale (or unknown) when there is no heartbeat row yet or
    // the last heartbeat is at/over the worker's staleness threshold. Mirrors
    // checkSyncWorkerHeartbeatHealth's own logic without re-importing it (a
    // NaN/absent timestamp is treated as stale).
    const hb = heartbeatResult.rows[0] || null;
    const lastHeartbeatAt = hb && hb.last_heartbeat_at ? hb.last_heartbeat_at : null;
    let workerStale = true;
    if (lastHeartbeatAt) {
      const ageMs = Date.now() - new Date(lastHeartbeatAt).getTime();
      workerStale = Number.isNaN(ageMs) || ageMs >= HEARTBEAT_STALE_THRESHOLD_MS;
    }

    res.json({
      queue: {
        pending: q.pending || 0,
        processing: q.processing || 0,
        // Failures in the last 24h only (rolling window; see the query note).
        failedRecent: q.failed_recent || 0,
        // null (not 0) when the queue is empty, so the client can render "—"
        // rather than a misleading "0 seconds behind".
        oldestPendingAgeSeconds: q.oldest_pending_age_seconds ?? null,
        pendingByType: byTypeResult.rows
      },
      userSync: userSync
        ? {
            status: userSync.status,
            lastSync: userSync.last_sync,
            recordsSynced: userSync.records_synced,
            // Carries the completeness-guard skip note when present.
            message: userSync.error_message
          }
        : null,
      worker: {
        lastHeartbeatAt,
        workerId: hb ? hb.worker_id : null,
        stale: workerStale,
        staleThresholdSeconds: Math.round(HEARTBEAT_STALE_THRESHOLD_MS / 1000)
      }
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to get sync status');
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

module.exports = router;
