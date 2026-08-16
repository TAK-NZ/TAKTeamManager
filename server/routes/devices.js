const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const DeviceEnrollmentService = require('../services/DeviceEnrollmentService');

const router = express.Router();

/**
 * server/routes/devices.js
 *
 * Express routes for Team-Owned Device Enrollment (Requirement 27, task
 * 49.4), plus the "log every QR-code generation as an `audit_logs` event"
 * half of task 49.5 (Requirement 27.8) that is scoped to this route file.
 * Thin HTTP wrapper around `DeviceEnrollmentService` (tasks 49.1-49.3):
 * validates input, resolves the acting user from `req.user`
 * (`authenticateToken` already resolves `req.user.userId` to the local
 * `users.id` -- see `server/middleware/auth.js` -- and
 * `req.user.is_global_manager`), calls the service, and maps the
 * service's named error classes to the appropriate HTTP status code,
 * mirroring the exact `ERROR_STATUS_BY_NAME`/`handleServiceError` pattern
 * already used by `server/routes/mou.js`/`server/routes/vendorChannels.js`.
 * No business logic lives here.
 *
 * Authorization (Requirement 27 Criterion 3 -- "team admin OR
 * Global_Manager"): `DeviceEnrollmentService.assertAuthorized` already
 * performs the real team-scoped check (`Team.isAdmin(teamId, actingUser)
 * OR actingUser.is_global_manager`) internally, on every public method of
 * that service. Per `design.md`'s "authorization is checked once, reused
 * by every method in this service" note, this route layer does NOT
 * duplicate that fine-grained check -- it only gates general reachability
 * via the `device:manage` permission identifier, which is deliberately
 * placed in BOTH `roleDefaults.global_manager` (automatically, via the
 * wildcard) AND `roleDefaults.authenticated_user` (explicitly), mirroring
 * exactly how `mou:sign` is set up for `POST /api/mou/:documentId/sign`.
 * This is intentional and NOT a bug: a team admin who is not a
 * Global_Manager must still be able to reach these routes to create/
 * enroll devices for their own team, and the service's own
 * `assertAuthorized` call is what rejects a caller who is neither an
 * admin of the target team nor a Global_Manager (mapped to 403 below via
 * `DeviceEnrollmentAuthorizationError`).
 *
 * Requirement 27.8 audit logging: `generateEnrollmentQrCode` itself does
 * NOT write an `audit_logs` row (see that method's own doc comment in
 * `DeviceEnrollmentService.js` -- it explicitly defers this to the route
 * layer). `POST /:deviceUserId/qr-code` below writes that row after a
 * successful call, before responding, following the exact
 * `INSERT INTO audit_logs (user_id, action, resource_type, resource_id,
 * details)` column set/shape already used by
 * `VendorChannelService.js`/`ChannelRequestService.js`.
 */

/**
 * Maps a `DeviceEnrollmentService` named error to an HTTP status code.
 * Every error class below is a deliberate, expected rejection documented
 * on the corresponding service method (see `DeviceEnrollmentService.js`)
 * -- none of them represent an unexpected/internal failure, so each maps
 * to a 4xx client-error status with the error's own message as the
 * response body, rather than a generic 500.
 */
const ERROR_STATUS_BY_NAME = {
  DeviceEnrollmentAuthorizationError: 403,
  NotATeamOwnedDeviceError: 400,
  // TakServerNotConfiguredError is a configuration precondition (the
  // integration is simply not set up for this environment), not a
  // transient failure of a reachable-but-erroring dependency -- 400
  // rather than 503, matching how `configValidator.isWellFormedUrl`
  // failures are surfaced elsewhere as client-facing 400s.
  TakServerNotConfiguredError: 400
};

/**
 * Sends the appropriate response for a `DeviceEnrollmentService` error: a
 * specific 4xx + message for any recognized named error class above, or a
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

// Requirement 27 Criteria 2, 4 (task 49.4): create a Team_Owned_Device
// for a team. `DeviceEnrollmentService.createDevice`'s own
// `assertAuthorized` call performs the real "team admin OR
// Global_Manager" check (Requirement 27 Criterion 3), rejecting with
// `DeviceEnrollmentAuthorizationError` (mapped to 403 below) otherwise.
router.post('/', authenticateToken, authorize, [
  body('teamId').notEmpty().withMessage('teamId is required'),
  body('label').optional({ nullable: true }).isString().trim().isLength({ max: 255 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId, label } = req.body;

    const device = await DeviceEnrollmentService.createDevice(teamId, label || null, req.user);

    res.status(201).json({ device });
  } catch (error) {
    handleServiceError(res, error, 'Failed to create team-owned device');
  }
});

// Requirement 27 Criteria 3, 5-8 (task 49.4 + the QR-generation-audit-log
// half of task 49.5): generate a fresh enrollment QR code for an
// existing Team_Owned_Device, and record the generation event as an
// `audit_logs` row (Requirement 27.8) on success, before responding.
router.post('/:deviceUserId/qr-code', authenticateToken, authorize, [
  param('deviceUserId').isInt().withMessage('deviceUserId must be an integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { deviceUserId } = req.params;

    const qrCode = await DeviceEnrollmentService.generateEnrollmentQrCode(deviceUserId, req.user);

    // Requirement 27 Criterion 8: log the generating user's identifier,
    // the target Team_Owned_Device's identifier, and the generation
    // timestamp as an auditable event, matching the exact
    // `INSERT INTO audit_logs (user_id, action, resource_type,
    // resource_id, details)` column set already used elsewhere (e.g.
    // `VendorChannelService.js`). `resource_id` is the device's local
    // `users.id` (`resource_type: 'user'`), since that is the row this
    // action is about; `deviceUserId` and `expiresAt`/`generatedAt` are
    // additionally placed into `details`, matching design.md's
    // `{generatingUserId, deviceUserId, generatedAt}` shape.
    const generatedAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'device_enrollment_qr_generated',
        'user',
        qrCode.deviceUserId,
        JSON.stringify({
          deviceUserId: qrCode.deviceUserId,
          generatedAt,
          expiresAt: qrCode.expiresAt
        })
      ]
    );

    res.json({ qrCode });
  } catch (error) {
    handleServiceError(res, error, 'Failed to generate team-owned device enrollment QR code');
  }
});

module.exports = router;
