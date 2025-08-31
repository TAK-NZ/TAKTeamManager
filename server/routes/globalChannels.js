const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const GlobalChannelService = require('../services/GlobalChannelService');
const pool = require('../config/database');
const router = express.Router();

const globalChannelService = new GlobalChannelService();

// Middleware to check global manager access (Authentik TakTeamManager_Admin group)
const requireGlobalManager = async (req, res, next) => {
  if (!req.user.is_global_manager) {
    return res.status(403).json({ error: 'Global manager access required' });
  }
  next();
};

// Get all BCH channels
router.get('/bch', authenticateToken, async (req, res) => {
  try {
    const channels = await globalChannelService.getBchChannels();
    res.json({ channels });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch BCH channels' });
  }
});

// Get all region channels
router.get('/region', authenticateToken, async (req, res) => {
  try {
    const channels = await globalChannelService.getRegionChannels();
    res.json({ channels });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch region channels' });
  }
});

// Create BCH channel (global managers only)
router.post('/bch', authenticateToken, requireGlobalManager, [
  body('name').trim().isLength({ min: 1, max: 50 }),
  body('display_name').trim().isLength({ min: 1, max: 100 }),
  body('description').optional().trim().isLength({ max: 500 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, display_name, description } = req.body;
    
    // Get local user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    const result = await globalChannelService.createBchChannel({
      name,
      display_name,
      description
    }, userResult.rows[0].id);
    
    res.status(201).json({
      message: 'BCH channel created successfully',
      channelId: result.channelId,
      serviceAccount: result.serviceAccountUsername
    });
  } catch (error) {
    console.error('BCH channel creation failed:', error);
    res.status(500).json({ error: 'Failed to create BCH channel' });
  }
});

// Create region channel (global managers only)
router.post('/region', authenticateToken, requireGlobalManager, [
  body('name').trim().isLength({ min: 1, max: 50 }),
  body('display_name').trim().isLength({ min: 1, max: 100 }),
  body('description').optional().trim().isLength({ max: 500 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, display_name, description } = req.body;
    
    // Get local user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    const result = await globalChannelService.createRegionChannel({
      name,
      display_name,
      description
    }, userResult.rows[0].id);
    
    res.status(201).json({
      message: 'Region channel created successfully',
      channelId: result.channelId
    });
  } catch (error) {
    console.error('Region channel creation failed:', error);
    res.status(500).json({ error: 'Failed to create region channel' });
  }
});

// Get BCH channel credentials (global managers only)
router.get('/bch/:channelId/credentials', authenticateToken, requireGlobalManager, async (req, res) => {
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
    console.error('Failed to get credentials:', error);
    res.status(403).json({ error: error.message });
  }
});

// Assign all users to global channels (global managers only)
router.post('/assign-all-users', authenticateToken, requireGlobalManager, async (req, res) => {
  try {
    const result = await globalChannelService.assignAllUsersToGlobalChannels();
    
    res.json({
      message: 'Global channel assignment queued for all users',
      usersProcessed: result.usersProcessed,
      bulkOperationId: result.bulkOperationId
    });
  } catch (error) {
    console.error('Failed to assign users to global channels:', error);
    res.status(500).json({ error: 'Failed to assign users to global channels' });
  }
});

// Deactivate global channel (global managers only)
router.delete('/:channelType/:channelId', authenticateToken, requireGlobalManager, async (req, res) => {
  try {
    const { channelType, channelId } = req.params;
    
    if (!['bch', 'region'].includes(channelType)) {
      return res.status(400).json({ error: 'Invalid channel type' });
    }
    
    // Get local user ID
    const userResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [req.user.id]
    );
    
    await globalChannelService.deactivateGlobalChannel(
      channelId,
      channelType,
      userResult.rows[0].id
    );
    
    res.json({ message: 'Global channel deactivated successfully' });
  } catch (error) {
    console.error('Failed to deactivate global channel:', error);
    res.status(500).json({ error: 'Failed to deactivate global channel' });
  }
});

module.exports = router;