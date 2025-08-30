const express = require('express');
const axios = require('axios');
const { authenticateToken } = require('../middleware/auth');
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

module.exports = router;