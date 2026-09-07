const express = require('express');
const authentikSync = require('../services/authentikSync');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const router = express.Router();

// Manual sync trigger (admin only)
router.post('/users', authenticateToken, authorize, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // A sync (manual or the periodic timer) may already be in flight. The
    // service's own `isRunning` guard would silently no-op a second call, so
    // report that back to the caller rather than pretending a new run started
    // — the client uses this to tell the operator "already running" instead of
    // showing a misleading fresh-sync result.
    if (authentikSync.isRunning) {
      return res.json({ started: false, alreadyRunning: true, message: 'A user sync is already running' });
    }

    // Trigger sync (fire-and-forget: the run reports its outcome via the
    // sync_status row, which the client polls through GET /sync/status).
    authentikSync.syncUsers().catch((err) => getLogger().error({ err }, 'Manual sync error'));

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'sync.trigger_manual', 'sync', null, null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ started: true, alreadyRunning: false, message: 'User sync started' });
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