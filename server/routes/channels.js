const express = require('express');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const Channel = require('../models/Channel');
const Team = require('../models/Team');
const pool = require('../config/database');
const router = express.Router();

// Get channel descriptions for user's groups
router.get('/descriptions', authenticateToken, async (req, res) => {
  try {
    const userGroups = req.user.groups || [];
    const takGroups = userGroups.filter(groupName => groupName.startsWith('tak_'));
    
    // Get unique base channel names
    const baseChannels = new Set()
    takGroups.forEach(groupName => {
      let baseName
      if (groupName.endsWith('_READ')) {
        baseName = groupName.slice(0, -5)
      } else if (groupName.endsWith('_WRITE')) {
        baseName = groupName.slice(0, -6)
      } else {
        baseName = groupName
      }
      baseChannels.add(baseName)
    })
    
    // Fetch descriptions from base channels
    const groupDetailsPromises = Array.from(baseChannels).map(async (baseName) => {
      try {
        const groupResponse = await axios.get(`${process.env.AUTHENTIK_URL}/api/v3/core/groups/?name=${encodeURIComponent(baseName)}`, {
          headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
        });
        const group = groupResponse.data.results[0];
        return {
          name: baseName,
          display_name: group?.attributes?.CN || baseName.replace('tak_', '').replace(/_/g, ' / '),
          description: group?.attributes?.description || 'TAK Channel'
        };
      } catch (error) {
        return {
          name: baseName,
          display_name: baseName.replace('tak_', '').replace(/_/g, ' / '),
          description: 'TAK Channel'
        };
      }
    });
    
    const channelDescriptions = await Promise.all(groupDetailsPromises);
    res.json({ channels: channelDescriptions });
  } catch (error) {
    console.error('Failed to fetch channel descriptions:', error);
    res.status(500).json({ error: 'Failed to fetch channel descriptions' });
  }
});

// Create custom channel
router.post('/custom', authenticateToken, [
  body('teamId').isInt(),
  body('customSuffix').trim().isLength({ min: 1, max: 100 }),
  body('memberPermissions').isArray()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId, customSuffix, memberPermissions } = req.body;
    
    // Check if team exists and user has permission
    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    // Check channel limit (3 total including primary)
    const channelCount = await Channel.getChannelCount(teamId);
    if (channelCount >= 3) {
      return res.status(400).json({ error: 'Maximum of 3 channels allowed per team' });
    }
    
    // Validate member permissions format
    for (const memberPerm of memberPermissions) {
      if (!memberPerm.userId || !['read', 'write', 'read_write'].includes(memberPerm.permission)) {
        return res.status(400).json({ error: 'Invalid member permission format' });
      }
    }
    
    const channel = await Channel.createCustomChannel(teamId, customSuffix, memberPermissions);
    res.status(201).json({ channel });
  } catch (error) {
    console.error('Failed to create custom channel:', error);
    res.status(500).json({ error: 'Failed to create custom channel' });
  }
});

// Get channels for a team with member counts
router.get('/team/:teamId', authenticateToken, async (req, res) => {
  try {
    const { teamId } = req.params;
    
    const result = await pool.query(`
      SELECT c.*, COUNT(cm.user_id) as member_count
      FROM channels c
      LEFT JOIN channel_memberships cm ON c.id = cm.channel_id
      WHERE c.team_id = $1
      GROUP BY c.id
      ORDER BY c.is_primary DESC, c.name
    `, [teamId]);
    
    res.json({ channels: result.rows });
  } catch (error) {
    console.error('Failed to fetch channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

module.exports = router;