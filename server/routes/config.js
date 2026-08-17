const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const SiteConfig = require('../models/SiteConfig');
const router = express.Router();

// Get public config (no auth required)
router.get('/public', async (req, res) => {
  try {
    const config = await SiteConfig.getPublicConfig();
    res.json(config);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch public config');
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

// Get all config (admin only)
router.get('/all', authenticateToken, authorize, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const config = await SiteConfig.getAll();
    res.json({ config });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch config');
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

// Get color mappings and role descriptions (legacy endpoint for admin page)
router.get('/color-mappings', authenticateToken, authorize, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    // Load color mappings from environment variables
    const colorMappings = {
      'Yellow': process.env.TAK_COLOR_YELLOW || '',
      'Cyan': process.env.TAK_COLOR_CYAN || '',
      'Green': process.env.TAK_COLOR_GREEN || '',
      'Red': process.env.TAK_COLOR_RED || '',
      'Purple': process.env.TAK_COLOR_PURPLE || '',
      'Orange': process.env.TAK_COLOR_ORANGE || '',
      'Blue': process.env.TAK_COLOR_BLUE || '',
      'Magenta': process.env.TAK_COLOR_MAGENTA || '',
      'White': process.env.TAK_COLOR_WHITE || '',
      'Maroon': process.env.TAK_COLOR_MAROON || '',
      'Dark Blue': process.env.TAK_COLOR_DARK_BLUE || '',
      'Teal': process.env.TAK_COLOR_TEAL || '',
      'Dark Green': process.env.TAK_COLOR_DARK_GREEN || '',
      'Brown': process.env.TAK_COLOR_BROWN || ''
    };
    
    // Load role descriptions from environment variables
    const roleDescriptions = {
      'Team Member': process.env.TAK_ROLE_TEAM_MEMBER || '',
      'Team Lead': process.env.TAK_ROLE_TEAM_LEAD || '',
      'Sniper': process.env.TAK_ROLE_SNIPER || '',
      'Medic': process.env.TAK_ROLE_MEDIC || '',
      'Forward Observer': process.env.TAK_ROLE_FORWARD_OBSERVER || '',
      'RTO': process.env.TAK_ROLE_RTO || '',
      'K9': process.env.TAK_ROLE_K9 || '',
      'HQ': process.env.TAK_ROLE_HQ || ''
    };
    
    res.json({ colorMappings, roleDescriptions });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch color mappings');
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

// Update config (admin only)
router.put('/:key', authenticateToken, authorize, [
  body('value').trim().isLength({ min: 1 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { key } = req.params;
    const { value } = req.body;
    
    // req.user.userId is the local users.id -- site_config.updated_by
    // is a foreign key to that column, NOT the Authentik id (req.user.id).
    // Using req.user.id here caused every save to fail with a foreign-key
    // violation (BUG: Site Content tab, same class of bug as BUG-015).
    const updatedConfig = await SiteConfig.update(key, value, req.user.userId);
    if (!updatedConfig) {
      return res.status(404).json({ error: 'Configuration key not found' });
    }

    res.json({ config: updatedConfig });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update config');
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

module.exports = router;