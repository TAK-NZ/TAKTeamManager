const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const { paginationParams } = require('../middleware/pagination');
const DeviceEnrollmentService = require('../services/DeviceEnrollmentService');
const { isValidCallsignSuffix } = require('../utils/callsignValidation');

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
 * mirroring the `ERROR_STATUS_BY_NAME`/`handleServiceError` pattern
 * already established elsewhere in this codebase (e.g.
 * `server/routes/deploymentChannels.js`). No business logic lives here.
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
 * wildcard) AND `roleDefaults.authenticated_user` (explicitly). This is
 * intentional and NOT a bug: a team admin who is not a
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
 *
 * takserver-enrollment Criterion 11.5 (task 8.3): `POST
 * /:deviceUserId/qr-code`'s response now carries `#buildEnrollment`'s
 * full corrected shape (Requirement 4) under the existing `qrCode` key,
 * which is why that handler sets `Cache-Control: no-store, no-cache,
 * must-revalidate` and `Pragma: no-cache` unconditionally, at the top of
 * the handler, before calling the service -- mirroring
 * `server/routes/enrollment.js`'s `POST /me` exactly, so the directive is
 * present on every response path including the error paths.
 *
 * takserver-enrollment Criteria 3.11, 5.9, 5.10, 13.6, 14.6, 14.7 (task
 * 8.3): `GET /team/:teamId` surfaces a Team's Team_Owned_Devices via
 * `DeviceEnrollmentService.listTeamDevices`, so a device excluded from
 * every human-user list/count (`production-hardening` Criterion 27.9)
 * stays reachable to the admin who owns it, by its Device_Display_Name
 * and its Managed_Identifier rather than by an email it does not have.
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
  TakServerNotConfiguredError: 400,
  // A device's requested callsignSuffix collided, case-insensitively,
  // with another member's or device's in this team
  // (`checkCallsignSuffixUniqueness`, called by `createDevice` before
  // any Claim_Row is written) -- a request-validation failure, same
  // treatment as every other caller of this shared check
  // (`server/routes/teams.js`'s member-edit route, `server/routes/
  // requests.js`'s approval route).
  CallsignSuffixConflictError: 400
};

// takserver-enrollment Criterion 3.6 (task 8.3): `GET /team/:teamId`
// reuses the SAME `assertAuthorized` failure this file's other two
// routes already map -- `listTeamDevices` calls `assertAuthorized`
// internally, so a caller who is neither an admin of the team (via
// `Team.isAdmin`'s Ancestor_Chain resolution) nor a Global_Manager gets
// the same `DeviceEnrollmentAuthorizationError` -> 403 mapping already
// present in `ERROR_STATUS_BY_NAME` above. No new entry is needed for
// that route.

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
  body('label').optional({ nullable: true }).isString().trim().isLength({ max: 255 }),
  // Mirrors `server/routes/teams.js`'s member-edit route's own
  // `callsignSuffix` validator exactly (`.custom(isValidCallsignSuffix)`)
  // -- the same character class (letters, digits, `-`, `.`) applies to a
  // device's Name segment as to a human's.
  body('callsignSuffix').optional({ nullable: true }).isString().trim().isLength({ max: 150 })
    .custom((value) => isValidCallsignSuffix(value))
    .withMessage('callsignSuffix may only contain letters, digits, "-", and "."')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId, label, callsignSuffix } = req.body;

    const device = await DeviceEnrollmentService.createDevice(teamId, label || null, req.user, callsignSuffix || null);

    res.status(201).json({ device });
  } catch (error) {
    handleServiceError(res, error, 'Failed to create team-owned device');
  }
});

// Client UX correction: resolves the "Enrollment Data" section's fields
// for a Team_Owned_Device WITHOUT minting an Enrollment_Token, so the
// device Enrollment_View can render this section automatically on open
// without minting a live 30-minute Authentik credential just because the
// admin opened the dialog.
router.get('/:deviceUserId/preview', authenticateToken, authorize, [
  param('deviceUserId').isInt().withMessage('deviceUserId must be an integer')
], async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { deviceUserId } = req.params;
    const preview = await DeviceEnrollmentService.previewEnrollmentQrCode(deviceUserId, req.user);
    res.json({ preview });
  } catch (error) {
    handleServiceError(res, error, 'Failed to preview team-owned device enrollment');
  }
});

// Requirement 27 Criteria 3, 5-8 (task 49.4 + the QR-generation-audit-log
// half of task 49.5); takserver-enrollment Criteria 4.1, 4.3, 11.5 (task
// 8.3, response-shape correction): generate a fresh enrollment payload
// for an existing Team_Owned_Device, and record the generation event as
// an `audit_logs` row (Requirement 27.8) on success, before responding.
router.post('/:deviceUserId/qr-code', authenticateToken, authorize, [
  param('deviceUserId').isInt().withMessage('deviceUserId must be an integer')
], async (req, res) => {
  // takserver-enrollment Criterion 11.5: `no-store` is the load-bearing
  // directive -- it forbids a shared or private cache from writing the
  // response body (which carries a live Enrollment_Token) to disk at
  // all, where `no-cache` alone only requires revalidation. Set
  // unconditionally, at the top of the handler, before calling the
  // service, so it is present on every response path including the
  // error paths below -- mirroring `server/routes/enrollment.js`'s
  // `POST /me` exactly.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { deviceUserId } = req.params;

    // takserver-enrollment Criteria 4.1, 4.3 (Correction 3): `qrCode` is
    // now `#buildEnrollment`'s full corrected shape (`principalId`,
    // `principalKind`, `username`, `host`, `expiresAt`,
    // `reEnrollmentDate`, `atakEnrollmentUri`, `itakRegistrationPayload`,
    // `atakQrDataUrl`, `itakQrDataUrl`, `takAttributes`,
    // `liveCertificateCount`) plus `teamId` -- NOT the old narrow
    // `{ host, username, token }`-shaped `itakEnrollmentPayload`. The
    // route's own call to the service is unchanged; only the audit log
    // below, which used to read the now-removed `qrCode.deviceUserId`,
    // is updated to read `qrCode.principalId` instead.
    const qrCode = await DeviceEnrollmentService.generateEnrollmentQrCode(deviceUserId, req.user);

    // Requirement 27 Criterion 8: log the generating user's identifier,
    // the target Team_Owned_Device's identifier, and the generation
    // timestamp as an auditable event, matching the exact
    // `INSERT INTO audit_logs (user_id, action, resource_type,
    // resource_id, details)` column set already used elsewhere (e.g.
    // `VendorChannelService.js`). `resource_id` is the device's local
    // `users.id` (`resource_type: 'user'`), since that is the row this
    // action is about. takserver-enrollment task 8.3: `#buildEnrollment`
    // returns `principalId`, not `deviceUserId` -- that field name is
    // gone from the response, so this INSERT's column set/shape is
    // otherwise UNCHANGED (still `device_enrollment_qr_generated`,
    // still `resource_type: 'user'`, still no token key and no QR data
    // URL in `details`) and only the field reference is corrected.
    const generatedAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'device_enrollment_qr_generated',
        'user',
        qrCode.principalId,
        JSON.stringify({
          deviceUserId: qrCode.principalId,
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

// Org-wide Team_Owned_Device listing, backing the `/devices` page --
// mirrors `GET /api/users` exactly: no `:teamId` in scope, visibility
// resolved via `DirectoryScopeService` (the SAME Scoped_Organisations
// rule `GET /api/users` already applies to human members, since a
// Team_Owned_Device is a `users` row like any other), and `device:read:org`
// below is the listing-route counterpart of `user:read:team_admin` --
// "does this caller administer SOMETHING", not "does this caller
// administer THIS team" (there is no `:teamId` route param here for a
// per-row check to scope against). Per-row `canManage` in the response
// answers the narrower "may THIS caller act on THIS row" question the
// client needs to gate its action icons, exactly like `GET /api/users`'
// own `can_manage` field.
router.get('/', authenticateToken, authorize, paginationParams, async (req, res) => {
  try {
    const { page, pageSize } = req.pagination;
    const { search } = req.query;
    // cert-expiry-notifications Requirement 7.3(b): only the exact string
    // "true" narrows the listing, matching this codebase's boolean-env/
    // query-param convention elsewhere -- any other value (including
    // "1"/"TRUE") is treated as absent/false, never partially truthy.
    const expiringOnly = req.query.expiringOnly === 'true';

    const result = await DeviceEnrollmentService.listAllDevices(req.user, { page, pageSize, search, expiringOnly });

    res.json(result);
  } catch (error) {
    handleServiceError(res, error, 'Failed to list devices');
  }
});

// takserver-enrollment Criteria 3.11, 5.9, 5.10, 13.6, 14.6, 14.7 (task
// 8.3): list a Team's Team_Owned_Devices. `express-validator` param
// validation matches the `POST /:deviceUserId/qr-code` route's
// `param('deviceUserId').isInt()` pattern above.
// `DeviceEnrollmentService.listTeamDevices` performs the real
// authorization check internally (`assertAuthorized`: Global_Manager OR
// `Team.isAdmin(teamId, actingUser)`), mapped to 403 via
// `DeviceEnrollmentAuthorizationError` in `ERROR_STATUS_BY_NAME` above --
// the route layer here only gates general reachability via the
// `device:read:team_admin` permission identifier's row-scoped resolver
// (`server/middleware/authorize.js`).
router.get('/team/:teamId', authenticateToken, authorize, [
  param('teamId').isInt().withMessage('teamId must be an integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId } = req.params;

    const result = await DeviceEnrollmentService.listTeamDevices(teamId, req.user);

    res.json(result);
  } catch (error) {
    handleServiceError(res, error, 'Failed to list team-owned devices');
  }
});

// Bugfix ("unable to edit ... a team device"): updates an EXISTING
// Team_Owned_Device's label and/or callsign suffix.
// `DeviceEnrollmentService.updateDevice`'s own `assertAuthorized` call
// performs the real "team admin OR Global_Manager" check, rejecting
// with `DeviceEnrollmentAuthorizationError` (mapped to 403 below)
// otherwise -- this route layer only gates general reachability via the
// `device:manage` identifier, shared with `POST /` above (same
// authorization boundary: an admin who may create devices for a team
// may also edit them).
router.patch('/:deviceUserId', authenticateToken, authorize, [
  param('deviceUserId').isInt().withMessage('deviceUserId must be an integer'),
  body('deviceLabel').optional({ nullable: true }).isString().trim().isLength({ max: 255 }),
  body('callsignSuffix').optional({ nullable: true }).isString().trim().isLength({ max: 150 })
    .custom((value) => isValidCallsignSuffix(value))
    .withMessage('callsignSuffix may only contain letters, digits, "-", and "."')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { deviceUserId } = req.params;
    const { deviceLabel, callsignSuffix } = req.body;

    const device = await DeviceEnrollmentService.updateDevice(
      deviceUserId,
      { deviceLabel, callsignSuffix },
      req.user
    );

    res.json({ device });
  } catch (error) {
    handleServiceError(res, error, 'Failed to update team-owned device');
  }
});

// Bugfix ("unable to ... delete a team device"): permanently removes an
// EXISTING Team_Owned_Device (team/channel memberships, Authentik user,
// and local `users` row). Shares `device:manage` with the create/edit
// routes above for the same reason.
router.delete('/:deviceUserId', authenticateToken, authorize, [
  param('deviceUserId').isInt().withMessage('deviceUserId must be an integer')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { deviceUserId } = req.params;

    await DeviceEnrollmentService.deleteDevice(deviceUserId, req.user);

    try {
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user.userId, 'device.delete', 'user', parseInt(deviceUserId, 10), null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ message: 'Team-owned device deleted successfully' });
  } catch (error) {
    handleServiceError(res, error, 'Failed to delete team-owned device');
  }
});

/**
 * bulk-actions (Team Devices tab multi-select): the same delete as the
 * single-item route above, applied to an array of `deviceUserId`s.
 * Shares `device:manage` with every other device route -- reachable
 * broadly, with `DeviceEnrollmentService.deleteDevice`'s own
 * `assertAuthorized` call (Global_Manager OR `Team.isAdmin` of the
 * device's team) performing the REAL per-row authorization, exactly as
 * it already does for the single-item route. One device's failure
 * (not found, not authorized, or an unexpected error) never affects any
 * other device in the batch -- see the module doc comment's per-row
 * result-array convention, matching `BulkImportService`'s own shape.
 */
router.post('/bulk-delete', authenticateToken, authorize, [
  body('deviceUserIds').isArray({ min: 1 }),
  body('deviceUserIds.*').isInt({ min: 1 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const deviceUserIds = req.body.deviceUserIds.map((id) => Number(id));
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (const deviceUserId of deviceUserIds) {
    try {
      await DeviceEnrollmentService.deleteDevice(deviceUserId, req.user);

      try {
        await pool.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user.userId, 'device.delete', 'user', deviceUserId, null]
        );
      } catch (auditErr) {
        getLogger().error({ err: auditErr }, 'Failed to write audit log');
      }

      results.push({ deviceUserId, success: true });
      successCount++;
    } catch (error) {
      const status = ERROR_STATUS_BY_NAME[error.name];
      const message = status ? error.message : 'Failed to delete team-owned device';
      if (!status) {
        getLogger().error({ err: error, deviceUserId }, 'Failed to bulk-delete team-owned device');
      }
      results.push({ deviceUserId, success: false, error: message });
      failureCount++;
    }
  }

  res.json({ successCount, failureCount, results });
});

module.exports = router;
