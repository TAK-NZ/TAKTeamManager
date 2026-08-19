const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const router = express.Router();

// Get operation status
router.get('/status', authenticateToken, authorize, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM sync_operations 
      GROUP BY status
    `);
    
    const bulkStats = await pool.query(`
      SELECT 
        status,
        COUNT(*) as count,
        SUM(total_items) as total_items,
        SUM(processed_items) as processed_items
      FROM bulk_operations 
      GROUP BY status
    `);
    
    res.json({
      operations: stats.rows,
      bulkOperations: bulkStats.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch operation status' });
  }
});

// Get recent operations
router.get('/recent', authenticateToken, authorize, async (req, res) => {
  try {
    const operations = await pool.query(`
      SELECT 
        id,
        operation_type,
        status,
        retry_count,
        error_message,
        created_at,
        completed_at
      FROM sync_operations 
      ORDER BY created_at DESC 
      LIMIT 50
    `);
    
    res.json({ operations: operations.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch recent operations' });
  }
});

// Retry failed operations
router.post('/retry-failed', authenticateToken, authorize, async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE sync_operations 
      SET status = 'pending', 
          retry_count = 0, 
          next_retry_at = NOW(),
          error_message = NULL
      WHERE status = 'failed'
    `);
    
    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'operations.retry_failed', 'sync_operation', null, JSON.stringify({ retriedCount: result.rowCount })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ 
      message: `${result.rowCount} operations queued for retry` 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retry operations' });
  }
});

module.exports = router;