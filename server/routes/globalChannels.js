const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const GlobalChannelService = require('../services/GlobalChannelService');
const router = express.Router();

const globalChannelService = new GlobalChannelService();

// Global-manager-only authorization for the routes below is enforced
// centrally by authorize.js via the Permission_Registry's
// 'global_channel:manage'/'global_channel:credentials' entries
// (resolved through roleDefaults.global_manager: ['*']).

// Get all BCH channels
router.get('/bch', authenticateToken, authorize, async (req, res) => {
  try {
    const channels = await globalChannelService.getBchChannels();
    res.json({ channels });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch BCH channels' });
  }
});

// Get all region channels
router.get('/region', authenticateToken, authorize, async (req, res) => {
  try {
    const channels = await globalChannelService.getRegionChannels();
    res.json({ channels });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch region channels' });
  }
});

// Create BCH channel (global managers only)
router.post('/bch', authenticateToken, authorize, [
  body('name').trim().isLength({ min: 1, max: 100 }),
  body('description').optional().trim().isLength({ max: 500 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, description } = req.body;
    
    // req.user.userId is already the local users.id (see
    // server/middleware/auth.js) -- no separate lookup by Authentik id is
    // needed. The prior code looked this up via `req.user.id` (the
    // Authentik id), which is a different id space entirely.
    const result = await globalChannelService.createBchChannel({
      name,
      description
    }, req.user.userId);
    
    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'global_channel.create_bch', 'bch_channel', result.channelId, JSON.stringify({ name })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(201).json({
      message: 'BCH channel created successfully',
      channelId: result.channelId,
      serviceAccount: result.serviceAccountUsername
    });
  } catch (error) {
    getLogger().error({ err: error }, 'BCH channel creation failed');
    res.status(500).json({ error: 'Failed to create BCH channel' });
  }
});

// Create region channel (global managers only)
router.post('/region', authenticateToken, authorize, [
  body('name').trim().isLength({ min: 1, max: 100 }),
  body('description').optional().trim().isLength({ max: 500 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, description } = req.body;
    
    // req.user.userId is already the local users.id -- see comment on the
    // BCH create route above.
    const result = await globalChannelService.createRegionChannel({
      name,
      description
    }, req.user.userId);
    
    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'global_channel.create_region', 'region_channel', result.channelId, JSON.stringify({ name })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(201).json({
      message: 'Region channel created successfully',
      channelId: result.channelId
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Region channel creation failed');
    res.status(500).json({ error: 'Failed to create region channel' });
  }
});

// Get BCH channel credentials (global managers only)
router.get('/bch/:channelId/credentials', authenticateToken, authorize, async (req, res) => {
  try {
    const { channelId } = req.params;
    
    // req.user.userId is already the local users.id -- see comment on the
    // BCH create route above.
    const credentials = await globalChannelService.getBchChannelCredentials(
      channelId,
      req.user.userId
    );
    
    res.json({ credentials });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to get credentials');
    res.status(403).json({ error: error.message });
  }
});

// Assign all users to global channels (global managers only)
router.post('/assign-all-users', authenticateToken, authorize, async (req, res) => {
  try {
    const result = await globalChannelService.assignAllUsersToGlobalChannels();
    
    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'global_channel.assign_all_users', 'global_channel', null, JSON.stringify({ usersProcessed: result.usersProcessed })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({
      message: 'Global channel assignment queued for all users',
      usersProcessed: result.usersProcessed,
      bulkOperationId: result.bulkOperationId
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to assign users to global channels');
    res.status(500).json({ error: 'Failed to assign users to global channels' });
  }
});

// Update BCH channel (global managers only)
router.put('/bch/:channelId', authenticateToken, authorize, [
  body('name').trim().isLength({ min: 1, max: 100 }),
  body('description').optional().trim().isLength({ max: 500 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { channelId } = req.params;
    const { name, description } = req.body;
    
    // req.user.userId is already the local users.id -- see comment on the
    // BCH create route above.
    await globalChannelService.updateBchChannel(channelId, {
      name,
      description
    }, req.user.userId);
    
    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'global_channel.update_bch', 'bch_channel', parseInt(channelId, 10), JSON.stringify({ name })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ message: 'BCH channel updated successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update BCH channel');
    res.status(500).json({ error: 'Failed to update BCH channel' });
  }
});

// Update region channel (global managers only)
router.put('/region/:channelId', authenticateToken, authorize, [
  body('name').trim().isLength({ min: 1, max: 100 }),
  body('description').optional().trim().isLength({ max: 500 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { channelId } = req.params;
    const { name, description } = req.body;
    
    // req.user.userId is already the local users.id -- see comment on the
    // BCH create route above.
    await globalChannelService.updateRegionChannel(channelId, {
      name,
      description
    }, req.user.userId);
    
    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'global_channel.update_region', 'region_channel', parseInt(channelId, 10), JSON.stringify({ name })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ message: 'Region channel updated successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update region channel');
    res.status(500).json({ error: 'Failed to update region channel' });
  }
});

// Sync existing channels from Authentik (global managers only)
router.post('/sync-existing', authenticateToken, authorize, async (req, res) => {
  try {
    // req.user.userId is already the local users.id -- see comment on the
    // BCH create route above.
    const result = await globalChannelService.syncExistingChannels(req.user.userId);
    
    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'global_channel.sync_existing', 'global_channel', null, JSON.stringify({ bchCount: result.bchCount, regionCount: result.regionCount })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({
      message: 'Existing channels synced successfully',
      bchCount: result.bchCount,
      regionCount: result.regionCount
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to sync existing channels');
    res.status(500).json({ error: 'Failed to sync existing channels' });
  }
});

// Delete global channel (global managers only)
router.delete('/:channelType/:channelId', authenticateToken, authorize, async (req, res) => {
  try {
    const { channelType, channelId } = req.params;
    
    if (!['bch', 'region'].includes(channelType)) {
      return res.status(400).json({ error: 'Invalid channel type' });
    }
    
    // req.user.userId is already the local users.id -- see comment on the
    // BCH create route above.
    await globalChannelService.deleteGlobalChannel(
      channelId,
      channelType,
      req.user.userId
    );
    
    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'global_channel.delete', 'global_channel', parseInt(channelId, 10), JSON.stringify({ channelType })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ message: 'Global channel deleted successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to delete global channel');
    res.status(500).json({ error: 'Failed to delete global channel' });
  }
});

module.exports = router;