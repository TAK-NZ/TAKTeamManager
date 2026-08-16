const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const GlobalChannelService = require('../services/GlobalChannelService');
const pool = require('../config/database');
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
    
    // Get local user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    const result = await globalChannelService.createBchChannel({
      name,
      description
    }, userResult.rows[0].id);
    
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
    
    // Get local user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    const result = await globalChannelService.createRegionChannel({
      name,
      description
    }, userResult.rows[0].id);
    
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
    
    // Get local user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    const credentials = await globalChannelService.getBchChannelCredentials(
      channelId,
      userResult.rows[0].id
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
    
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    await globalChannelService.updateBchChannel(channelId, {
      name,
      description
    }, userResult.rows[0].id);
    
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
    
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    await globalChannelService.updateRegionChannel(channelId, {
      name,
      description
    }, userResult.rows[0].id);
    
    res.json({ message: 'Region channel updated successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update region channel');
    res.status(500).json({ error: 'Failed to update region channel' });
  }
});

// Sync existing channels from Authentik (global managers only)
router.post('/sync-existing', authenticateToken, authorize, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    const result = await globalChannelService.syncExistingChannels(userResult.rows[0].id);
    
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
    
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    await globalChannelService.deleteGlobalChannel(
      channelId,
      channelType,
      userResult.rows[0].id
    );
    
    res.json({ message: 'Global channel deleted successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to delete global channel');
    res.status(500).json({ error: 'Failed to delete global channel' });
  }
});

module.exports = router;