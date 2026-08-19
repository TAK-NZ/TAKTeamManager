const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const MouService = require('../services/MouService');

const {
  MouDocumentNotFoundError,
  MouSignatureValidationError,
  MouInvalidSignatureMethodError,
  MouSignatureAuthorizationError,
  MouSignatureAlreadyExistsError,
  MouSignatureNotFoundError,
  MouCountersignatureAuthorizationError,
  MouCountersignatureNotRequiredError,
  MouSignatureAlreadyCountersignedError,
  VALID_SIGNATURE_METHODS
} = MouService;

const router = express.Router();
const mouService = new MouService();

/**
 * server/routes/mou.js
 *
 * Express routes for the MOU/Document Management with E-Signature and
 * Login-Time User Agreement Gate feature (Requirement 28, task 50.5).
 * Thin HTTP wrapper around `MouService` (tasks 50.2-50.3): validates
 * input, resolves the acting user from `req.user` (`authenticateToken`
 * already resolves `req.user.userId` to the local `users.id` -- see
 * `server/middleware/auth.js` -- and `req.user.is_global_manager`), calls
 * the service, and maps the service's named error classes to the
 * appropriate HTTP status code, mirroring the exact
 * `ERROR_STATUS_BY_NAME`/`handleServiceError` pattern already used by
 * `server/routes/vendorChannels.js`/`server/routes/deploymentChannels.js`.
 * No business logic lives here.
 *
 * Authorization split, per `design.md`'s Section 23 and this task's own
 * description:
 *   - `POST /documents`, `PUT /documents/:documentId`,
 *     `POST /documents/:documentId/set-current`: Global_Manager-only.
 *     `createDocument`/`updateDocument`/`setAsCurrentAgreement` do NOT
 *     check authorization themselves (see `MouService.js`'s class-level
 *     doc comment), so it is enforced here, at the route/
 *     Permission_Registry layer, via the `mou:manage` permission
 *     identifier (held only by `roleDefaults.global_manager`'s
 *     wildcard).
 *   - `POST /:documentId/sign` (the EXACT signature-submission path
 *     named in `design.md`'s Section 23 and relied upon by
 *     `server/middleware/requireCurrentAgreement.js`'s `BYPASS_ROUTES`,
 *     task 50.4 -- this path MUST stay in sync with that file): any
 *     authenticated user may reach this handler, via the `mou:sign`
 *     permission identifier in `roleDefaults.authenticated_user`.
 *     `MouService.recordSignature` performs the REAL authorization
 *     check itself (`assertSignatureAuthorized` -- team admin for
 *     team-scoped documents, Global_Manager for any, or self-signing a
 *     serverwide document), throwing `MouSignatureAuthorizationError`
 *     when it is not satisfied, which this route maps to 403 below.
 *   - `POST /signatures/:signatureId/countersign`: Global_Manager-only
 *     at BOTH layers (defense in depth, matching this task's own
 *     Requirements list "28.5" which is specifically about
 *     countersignature): the `mou:manage` permission identifier gates
 *     it here, AND `MouService.recordCountersignature` independently
 *     re-checks `actingUser.is_global_manager` and throws
 *     `MouCountersignatureAuthorizationError` if that check fails.
 *   - `GET /documents/:documentId`, `GET /current-agreement`: any
 *     authenticated user, via the `mou:read` permission identifier in
 *     `roleDefaults.authenticated_user`. These read directly from
 *     `mou_documents`; no service method exists for a plain read.
 */

/**
 * Maps a `MouService` named error to an HTTP status code. Every error
 * class below is a deliberate, expected rejection documented on the
 * corresponding `MouService` method (see `MouService.js`) -- none of
 * them represent an unexpected/internal failure, so each maps to a 4xx
 * client-error status with the error's own message as the response
 * body, rather than a generic 500.
 */
const ERROR_STATUS_BY_NAME = {
  MouDocumentNotFoundError: 404,
  MouSignatureValidationError: 400,
  MouInvalidSignatureMethodError: 400,
  MouSignatureAuthorizationError: 403,
  MouSignatureAlreadyExistsError: 409,
  MouSignatureNotFoundError: 404,
  MouCountersignatureAuthorizationError: 403,
  MouCountersignatureNotRequiredError: 400,
  MouSignatureAlreadyCountersignedError: 409
};

/**
 * Sends the appropriate response for a `MouService` error: a specific
 * 4xx + message for any recognized named error class above, or a
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

// Requirement 28 Criteria 1, 3 (task 50.2): create an MOU_Document
// (Global_Manager-only).
router.post('/documents', authenticateToken, authorize, [
  body('title').trim().isLength({ min: 1, max: 255 }),
  body('body').trim().isLength({ min: 1 }),
  body('teamId').optional({ nullable: true }).isInt(),
  body('requiresCountersignature').optional().isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { title, body: documentBody, teamId, requiresCountersignature } = req.body;

    const document = await mouService.createDocument(
      { title, body: documentBody, teamId: teamId ?? null, requiresCountersignature },
      req.user.userId
    );

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'mou.create', 'mou_document', document.id, JSON.stringify({ title })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(201).json({ document });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to create MOU document');
    res.status(500).json({ error: 'Failed to create MOU document' });
  }
});

// Requirement 28 Criteria 1, 3 (task 50.2): update an MOU_Document's
// editable content fields (Global_Manager-only).
router.put('/documents/:documentId', authenticateToken, authorize, [
  body('title').optional().trim().isLength({ min: 1, max: 255 }),
  body('body').optional().trim().isLength({ min: 1 }),
  body('requiresCountersignature').optional().isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { documentId } = req.params;
    const { title, body: documentBody, requiresCountersignature } = req.body;

    const document = await mouService.updateDocument(
      documentId,
      { title, body: documentBody, requiresCountersignature },
      req.user.userId
    );

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'mou.update', 'mou_document', parseInt(documentId, 10), null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ document });
  } catch (error) {
    handleServiceError(res, error, 'Failed to update MOU document');
  }
});

// Requirement 28 Criteria 1, 3, 6-7 (task 50.2): designate an
// MOU_Document as the current mandatory user agreement (Global_Manager-
// only).
router.post('/documents/:documentId/set-current', authenticateToken, authorize, async (req, res) => {
  try {
    const { documentId } = req.params;

    const document = await mouService.setAsCurrentAgreement(documentId, req.user.userId);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'mou.activate', 'mou_document', parseInt(documentId, 10), null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ document });
  } catch (error) {
    handleServiceError(res, error, 'Failed to set current MOU agreement');
  }
});

// Requirement 28 Criteria 2, 4 (task 50.3): record an MOU_Signature.
// EXACT path, matching `requireCurrentAgreement.js`'s `BYPASS_ROUTES`
// entry (`POST /api/mou/:documentId/sign`) -- available to any
// authenticated user at this route/Permission_Registry layer;
// `MouService.recordSignature`'s own `assertSignatureAuthorized` check
// performs the real authorization (team admin for team-scoped
// documents, Global_Manager for any, or self-signing a serverwide
// document).
router.post('/:documentId/sign', authenticateToken, authorize, [
  body('signerUserId').optional({ nullable: true }).isInt(),
  body('signerTeamId').optional({ nullable: true }).isInt(),
  body('method').isIn(VALID_SIGNATURE_METHODS),
  body('signatureData').optional({ nullable: true }).isString()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { documentId } = req.params;
    const { signerUserId, signerTeamId, method, signatureData } = req.body;

    const signature = await mouService.recordSignature(
      documentId,
      { signerUserId: signerUserId ?? null, signerTeamId: signerTeamId ?? null },
      method,
      req.user,
      signatureData ?? null
    );

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'mou.accept', 'mou_signature', null, JSON.stringify({ documentId: parseInt(documentId, 10) })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(201).json({ signature });
  } catch (error) {
    handleServiceError(res, error, 'Failed to record MOU signature');
  }
});

// Requirement 28 Criterion 5 (task 50.3): record a Global_Manager
// countersignature. Defense in depth: Global_Manager-only at BOTH this
// route/Permission_Registry layer (`mou:manage`) AND
// `MouService.recordCountersignature`'s own internal check.
router.post('/signatures/:signatureId/countersign', authenticateToken, authorize, async (req, res) => {
  try {
    const { signatureId } = req.params;

    const signature = await mouService.recordCountersignature(signatureId, req.user);

    res.json({ signature });
  } catch (error) {
    handleServiceError(res, error, 'Failed to record MOU countersignature');
  }
});

// Convenience read: a specific MOU_Document by id, available to any
// authenticated user, reading directly from `mou_documents` (no service
// method exists for a plain read).
router.get('/documents/:documentId', authenticateToken, authorize, async (req, res) => {
  try {
    const { documentId } = req.params;

    const result = await pool.query('SELECT * FROM mou_documents WHERE id = $1', [documentId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `MOU document ${documentId} was not found` });
    }

    res.json({ document: result.rows[0] });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch MOU document');
    res.status(500).json({ error: 'Failed to fetch MOU document' });
  }
});

// Convenience read (Requirement 28 Criteria 6-7): the current mandatory
// serverwide user agreement, if any, so the Client can check what a
// user needs to sign. Available to any authenticated user. Mirrors
// `requireCurrentAgreement.js`'s own query
// (`is_current_agreement = true AND team_id IS NULL`).
router.get('/current-agreement', authenticateToken, authorize, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM mou_documents WHERE is_current_agreement = true AND team_id IS NULL LIMIT 1'
    );

    res.json({ currentAgreement: result.rows[0] || null });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch current MOU agreement');
    res.status(500).json({ error: 'Failed to fetch current MOU agreement' });
  }
});

module.exports = router;
