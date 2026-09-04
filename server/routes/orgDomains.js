const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
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

module.exports = router;
