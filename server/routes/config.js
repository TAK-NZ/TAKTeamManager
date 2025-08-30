const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// Get color mappings from environment variables
router.get('/color-mappings', authenticateToken, (req, res) => {
  try {
    const colorMappings = {
      'Yellow': process.env.TAK_COLOR_YELLOW || 'Yellow',
      'Cyan': process.env.TAK_COLOR_CYAN || 'Cyan',
      'Green': process.env.TAK_COLOR_GREEN || 'Green',
      'Red': process.env.TAK_COLOR_RED || 'Red',
      'Purple': process.env.TAK_COLOR_PURPLE || 'Purple',
      'Orange': process.env.TAK_COLOR_ORANGE || 'Orange',
      'Blue': process.env.TAK_COLOR_BLUE || 'Blue',
      'Magenta': process.env.TAK_COLOR_MAGENTA || 'Magenta',
      'White': process.env.TAK_COLOR_WHITE || 'White',
      'Maroon': process.env.TAK_COLOR_MAROON || 'Maroon',
      'Dark Blue': process.env.TAK_COLOR_DARK_BLUE || 'Dark Blue',
      'Teal': process.env.TAK_COLOR_TEAL || 'Teal',
      'Dark Green': process.env.TAK_COLOR_DARK_GREEN || 'Dark Green',
      'Brown': process.env.TAK_COLOR_BROWN || 'Brown'
    };
    
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
    console.error('Failed to get color mappings:', error);
    res.status(500).json({ error: 'Failed to get color mappings' });
  }
});

module.exports = router;