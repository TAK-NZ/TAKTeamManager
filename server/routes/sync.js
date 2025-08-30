const express = require('express');
const authentikSync = require('../services/authentikSync');
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// Manual sync trigger (admin only)
router.post('/users', authenticateToken, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Trigger sync
    authentikSync.syncUsers().catch(console.error);
    
    res.json({ message: 'User sync started' });
  } catch (error) {
    console.error('Manual sync error:', error);
    res.status(500).json({ error: 'Failed to start sync' });
  }
});

// Get sync status
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const status = await authentikSync.getSyncStatus();
    res.json(status);
  } catch (error) {
    console.error('Sync status error:', error);
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

module.exports = router;