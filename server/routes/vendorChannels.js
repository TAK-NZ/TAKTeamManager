const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const VendorChannelService = require('../services/VendorChannelService');

const router = express.Router();
const vendorChannelService = new VendorChannelService();

/**
 * server/routes/vendorChannels.js
 *
 * Express routes for the Vendor Time-Limited Channel Access feature
 * (Requirement 21). Every route below is Global_Manager-only; that
 * authorization is enforced centrally by `authorize.js` via the
 * Permission_Registry's `vendor_channel:manage` entries (resolved through
 * `roleDefaults.global_manager: ['*']`), matching the pattern already
 * used by `server/routes/globalChannels.js` — no inline
 * `is_global_manager` check is duplicated here.
 *
 * This file is a thin HTTP wrapper around `VendorChannelService` (task
 * 40.1-40.4): it validates input, resolves the acting user's local id
 * from `req.user.userId` (the local `users.id` that `authenticateToken`
 * already resolves via the user cache — see `server/middleware/auth.js`
 * — not `req.user.id`, which is the Authentik id), calls the service, and
 * maps the service's named error classes to the appropriate HTTP status
 * code and message. No business logic lives here.
 */

/**
 * Maps a `VendorChannelService` named error to an HTTP status code. Every
 * error class below is a deliberate, expected rejection documented on the
 * corresponding service method (see `VendorChannelService.js`) — none of
 * them represent an unexpected/internal failure, so each maps to a
 * 4xx client-error status with the error's own message as the response
 * body, rather than a generic 500.
 */
const ERROR_STATUS_BY_NAME = {
  VendorChannelAlreadyActiveError: 409,
  VendorChannelNotActiveError: 400,
  VendorChannelProvisioningPendingError: 400,
  TargetUserNotVendorError: 400,
  ChannelNotFoundError: 404,
  ChannelGroupNotProvisionedError: 400,
  VendorChannelGrantNotActiveError: 400
};

/**
 * Sends the appropriate response for a `VendorChannelService` error: a
 * specific 4xx + message for any recognized named error class, or a
 * generic 500 (logged, no internal detail leaked) for anything else.
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

// Requirement 21 Criterion 10: create the singleton Vendor_Channel
// (Global_Manager-only). Rejects with 409 if an active Vendor_Channel
// already exists (Requirement 21 Criterion 11).
router.post('/', authenticateToken, authorize, async (req, res) => {
  try {
    const result = await vendorChannelService.createVendorChannel(req.user.userId);
    res.status(201).json({
      message: 'Vendor channel created successfully',
      channelId: result.channelId
    });
  } catch (error) {
    handleServiceError(res, error, 'Failed to create vendor channel');
  }
});

// Requirement 21 Criterion 1: set or clear a target user's `is_vendor`
// flag (Global_Manager-only). Setting it to `true` requires an active
// Vendor_Channel to exist (Requirement 21 Criterion 12).
router.put('/users/:userId/vendor-flag', authenticateToken, authorize, [
  body('isVendor').isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId } = req.params;
    const { isVendor } = req.body;

    const result = await vendorChannelService.setVendorFlag(userId, isVendor, req.user.userId);

    res.json({
      message: 'Vendor flag updated successfully',
      success: result.success
    });
  } catch (error) {
    handleServiceError(res, error, 'Failed to update vendor flag');
  }
});

// Requirement 21 Criteria 4, 8: create a Vendor_Channel_Grant
// (Global_Manager-only). Rejects with 400 if the target user's
// `is_vendor` flag is not `true` (Requirement 21 Criterion 8).
router.post('/grants', authenticateToken, authorize, [
  body('vendorUserId').isInt(),
  body('channelId').isInt(),
  body('expiresAt').optional({ nullable: true }).isISO8601()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { vendorUserId, channelId, expiresAt } = req.body;

    const result = await vendorChannelService.createGrant(
      vendorUserId,
      channelId,
      req.user.userId,
      expiresAt || null
    );

    res.status(201).json({
      message: 'Vendor channel grant created successfully',
      grantId: result.grantId
    });
  } catch (error) {
    handleServiceError(res, error, 'Failed to create vendor channel grant');
  }
});

// Requirement 21 Criterion 5: revoke an active Vendor_Channel_Grant
// (Global_Manager-only).
router.post('/grants/:grantId/revoke', authenticateToken, authorize, async (req, res) => {
  try {
    const { grantId } = req.params;

    const result = await vendorChannelService.revokeGrant(grantId, req.user.userId);

    res.json({
      message: 'Vendor channel grant revoked successfully',
      success: result.success
    });
  } catch (error) {
    handleServiceError(res, error, 'Failed to revoke vendor channel grant');
  }
});

module.exports = router;
