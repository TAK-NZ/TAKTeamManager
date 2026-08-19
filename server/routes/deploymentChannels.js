const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const DeploymentChannelService = require('../services/DeploymentChannelService');

const router = express.Router();
const deploymentChannelService = new DeploymentChannelService();

/**
 * server/routes/deploymentChannels.js
 *
 * Express routes for the Deployment-Scoped Overseas/Domestic Channel
 * Self-Service Subscription feature (Requirement 22, task 42.4). Thin HTTP
 * wrapper around `DeploymentChannelService` (tasks 42.1-42.3): validates
 * input, resolves the acting user's local id from `req.user.userId` (the
 * local `users.id` that `authenticateToken` already resolves via the user
 * cache -- see `server/middleware/auth.js` -- not `req.user.id`, which is
 * the Authentik id), calls the service, and maps the service's named error
 * classes to the appropriate HTTP status code. No business logic lives
 * here, matching the convention already established by
 * `server/routes/vendorChannels.js` and `server/routes/channelRequests.js`.
 *
 * Authorization for every route below is enforced centrally by
 * `authorize.js` via Permission_Registry entries
 * (`server/config/permissions.registry.js`), not by inline checks here:
 *   - `POST /` (create a Deployment_Channel): Global_Manager-only
 *     (Requirement 22 Criterion 3 -- every Global_Manager is treated as an
 *     authorized Deployment_Coordinator, mirroring the existing
 *     `is_global_manager` check already used for global-channel creation),
 *     via the `deployment_channel:manage` permission identifier, which is
 *     held only by `roleDefaults.global_manager`'s wildcard.
 *   - `GET /` (list active Deployment_Channels, to browse and self-
 *     subscribe), `POST /:channelId/subscribe`, and
 *     `POST /:channelId/unsubscribe`: available to any authenticated user
 *     (Requirement 22 Criteria 6, 7), via the `channel:subscribe:deployment`
 *     permission identifier already present in
 *     `roleDefaults.authenticated_user`.
 */

/**
 * Maps a `DeploymentChannelService` named error to an HTTP status code.
 * Both error classes below are deliberate, expected rejections documented
 * on the corresponding service method (see `DeploymentChannelService.js`)
 * -- neither represents an unexpected/internal failure, so each maps to a
 * 4xx client-error status with the error's own message as the response
 * body, rather than a generic 500. Mirrors the same
 * `ERROR_STATUS_BY_NAME`/`handleServiceError` pattern already used by
 * `server/routes/vendorChannels.js`.
 */
const ERROR_STATUS_BY_NAME = {
  // Requirement 22 Criterion 10: subscribing to an inactive (or
  // nonexistent) Deployment_Channel.
  DeploymentChannelNotActiveError: 400,
  // unsubscribe target Deployment_Channel does not exist at all.
  DeploymentChannelNotFoundError: 404
};

/**
 * Sends the appropriate response for a `DeploymentChannelService` error: a
 * specific 4xx + message for either recognized named error class above, or
 * a generic 500 (logged, no internal detail leaked) for anything else.
 *
 * @param {import('express').Response} res
 * @param {Error} error
 * @param {string} logMessage
 */
function handleServiceError(res, error, logMessage) {
  const status = ERROR_STATUS_BY_NAME[error.name];
  if (status) {
    return res.status(status).json({ error: error.message });
  }

  getLogger().error({ err: error }, logMessage);
  return res.status(500).json({ error: logMessage });
}

// Create a Deployment_Channel (Global_Manager-only, Requirement 22
// Criteria 3-5, 11, 13). `createDeploymentChannel` itself performs the
// naming-format validation (Req 22.5) and the domestic-pattern
// end-date-required validation (Req 22.13) before ever opening a database
// connection, throwing a plain Error identifying the accepted formats /
// the missing field in either case. Both are expected, user-input
// rejections rather than unexpected/internal failures, so -- mirroring
// the exact same catch-all-as-400 pattern already used by
// `server/routes/requests.js`'s `GET /verify/:token` route for a
// service-thrown plain Error -- any error from this call is logged and
// surfaced as 400 with the error's own message, rather than a generic 500.
router.post('/', authenticateToken, authorize, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('deploymentEndDate').optional({ nullable: true }).isISO8601()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { name, description, deploymentEndDate } = req.body;

    const result = await deploymentChannelService.createDeploymentChannel(
      { name, description, deploymentEndDate: deploymentEndDate || null },
      req.user.userId
    );

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'deployment_channel.create', 'deployment_channel', result.channelId, JSON.stringify({ name })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(201).json({
      message: 'Deployment channel created successfully',
      channelId: result.channelId
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to create deployment channel');
    res.status(400).json({ error: error.message });
  }
});

// List active Deployment_Channels, available to any authenticated user so
// they can browse and self-subscribe (Requirement 22 Criterion 6).
// Mirrors `GlobalChannelService.getBchChannels()`/`getRegionChannels()`'s
// existing is_active-filtered listing shape.
router.get('/', authenticateToken, authorize, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT dc.*, u.first_name, u.last_name
      FROM deployment_channels dc
      LEFT JOIN users u ON dc.requested_by = u.id
      WHERE dc.is_active = true
      ORDER BY dc.name
    `);

    const channels = result.rows.map((row) => ({
      ...row,
      requested_by_name: row.first_name ? `${row.first_name} ${row.last_name}` : 'System'
    }));

    res.json({ channels });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch deployment channels');
    res.status(500).json({ error: 'Failed to fetch deployment channels' });
  }
});

// Self-service subscribe (Requirement 22 Criterion 6), available to any
// authenticated user. Rejects with 400 (via DeploymentChannelNotActiveError)
// if the target channel does not exist or is not active (Req 22.10).
router.post('/:channelId/subscribe', authenticateToken, authorize, async (req, res) => {
  try {
    const { channelId } = req.params;

    const result = await deploymentChannelService.subscribe(channelId, req.user.userId);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'deployment_channel.activate', 'deployment_channel', parseInt(channelId, 10), null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({
      message: 'Subscribed to deployment channel successfully',
      success: result.success
    });
  } catch (error) {
    handleServiceError(res, error, 'Failed to subscribe to deployment channel');
  }
});

// Self-service unsubscribe (Requirement 22 Criterion 7), available to any
// authenticated user. Rejects with 404 (via DeploymentChannelNotFoundError)
// if the target channel does not exist at all; unlike subscribe, an
// inactive channel may still be unsubscribed from.
router.post('/:channelId/unsubscribe', authenticateToken, authorize, async (req, res) => {
  try {
    const { channelId } = req.params;

    const result = await deploymentChannelService.unsubscribe(channelId, req.user.userId);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'deployment_channel.deactivate', 'deployment_channel', parseInt(channelId, 10), null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({
      message: 'Unsubscribed from deployment channel successfully',
      success: result.success
    });
  } catch (error) {
    handleServiceError(res, error, 'Failed to unsubscribe from deployment channel');
  }
});

module.exports = router;
