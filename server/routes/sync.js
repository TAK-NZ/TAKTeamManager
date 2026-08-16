const express = require('express');
const authentikSync = require('../services/authentikSync');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const router = express.Router();

// Manual sync trigger (admin only)
router.post('/users', authenticateToken, authorize, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Trigger sync
    authentikSync.syncUsers().catch((err) => getLogger().error({ err }, 'Manual sync error'));
    
    res.json({ message: 'User sync started' });
  } catch (error) {
    getLogger().error({ err: error }, 'Manual sync error');
    res.status(500).json({ error: 'Failed to start sync' });
  }
});

// Get sync status
router.get('/status', authenticateToken, authorize, async (req, res) => {
  try {
    const status = await authentikSync.getSyncStatus();
    res.json(status);
  } catch (error) {
    getLogger().error({ err: error }, 'Sync status error');
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

module.exports = router;