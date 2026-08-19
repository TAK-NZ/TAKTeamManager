const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const EmailService = require('../services/EmailService');
const BroadcastEmailService = require('../services/BroadcastEmailService');

const { BroadcastAuthorizationError } = BroadcastEmailService;

const router = express.Router();
const emailService = new EmailService();
const broadcastEmailService = new BroadcastEmailService();

/**
 * Requirement 30.5 / task 52.3's default `templateKey` for
 * `POST /api/communications/test-email` when the caller does not supply
 * one explicitly.
 *
 * design.md Section 25 calls for "a fixed test template", and
 * Requirement 30.5 requires this endpoint to work "without requiring an
 * associated `access_requests` row or broadcast trigger" -- i.e. no NEW
 * template row is required to exist. `database/init.js`'s seed data
 * (four `email_templates` rows: `access_request_verification`,
 * `access_request_approved`, `access_request_denied`,
 * `admin_notification_digest`) has no template purpose-built for a
 * connectivity test, so this route defaults to the existing
 * `admin_notification_digest` row -- the only one of the four addressed
 * to an admin/operator rather than an end-user access-requester, making
 * it the most semantically appropriate "fixed" default for a
 * Global_Manager verifying SES connectivity. `EmailService.replaceVariables`
 * leaves any `{{placeholder}}` untouched when no matching variable key is
 * supplied (see `EmailService.test.js`), so sending this template with no
 * `variables` override is safe and simply leaves its placeholders
 * literal in the delivered message -- there is no need to seed a new
 * template row or migration for this purpose. A Global_Manager may still
 * override both `templateKey` and `variables` in the request body to
 * exercise a different existing template end-to-end.
 */
const DEFAULT_TEST_EMAIL_TEMPLATE_KEY = 'admin_notification_digest';

/**
 * server/routes/communications.js
 *
 * Broadcast Email & Template Management (Requirement 30). This file is
 * being built incrementally by multiple tasks:
 *   - Task 52.2 (this revision): `GET`/`PUT /api/communications/templates/:key`
 *     (Global_Manager-only), reading/writing `email_templates` directly,
 *     per design.md Section 25 ("reads/writes
 *     `email_templates.subject_template`/`body_template` directly -- no
 *     new table needed, this already exists").
 *   - Task 52.3 (this revision): `POST /api/communications/test-email`
 *     (Global_Manager-only), calling `EmailService.sendEmail` directly
 *     against an admin-specified address with a fixed default template,
 *     independent of any `access_requests` row (Requirement 30.5).
 *   - Task 52.4 (this revision): `POST /api/communications/send`, wiring
 *     the already-implemented `BroadcastEmailService.send` (task 52.1) to
 *     an HTTP endpoint (Requirement 30.1). Unlike every other route in
 *     this file, this route is reachable by ANY authenticated user, not
 *     just a Global_Manager -- see the route's own doc comment below for
 *     why.
 *
 * Every route in this file EXCEPT `POST /send` is Global_Manager-only,
 * enforced centrally by `authorize.js` via the Permission_Registry's
 * `communication:template:*`/`communication:test_email:send` entries
 * (resolved through `roleDefaults.global_manager: ['*']`), matching the
 * pattern already used by every other Global_Manager-only route file
 * (`vendorChannels.js`, `deploymentChannels.js`, `auditLogs.js`,
 * `settings.js`) -- no inline `is_global_manager` check is duplicated
 * here.
 *
 * NOTE ON CONCURRENT EDITS: this file is also being extended by a
 * concurrently-executed task (52.3, `POST /api/communications/test-email`).
 * Each route below is a self-contained `router.get/put/post(...)` block
 * with no shared complex state at module scope, so a concurrent append of
 * another route block is low-risk to merge.
 */

/**
 * `email_templates` columns (per `database/schema.sql`): `id`,
 * `template_key` (unique), `subject_template`, `body_template`,
 * `description`, `updated_by`, `updated_at`. `EmailService.sendEmail`
 * already queries this table with
 * `SELECT subject_template, body_template FROM email_templates WHERE template_key = $1`
 * -- the routes below follow that same column-naming convention.
 */

// GET /api/communications/templates/:key (Requirement 30.4,
// Global_Manager-only). Looks up an email_templates row by template_key
// and returns its subject_template/body_template/description fields.
// 404 if no template with that key exists.
router.get('/templates/:key', authenticateToken, authorize, [
  param('key').isString().trim().isLength({ min: 1, max: 100 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { key } = req.params;

    const result = await pool.query(
      'SELECT template_key, subject_template, body_template, description, updated_at FROM email_templates WHERE template_key = $1',
      [key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Email template not found: ${key}` });
    }

    res.json({ template: result.rows[0] });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch email template');
    res.status(500).json({ error: 'Failed to fetch email template' });
  }
});

// PUT /api/communications/templates/:key (Requirement 30.4,
// Global_Manager-only). Updates the subject_template/body_template
// columns of an EXISTING email_templates row -- this does NOT create new
// template keys, only edits existing ones. Validates both fields are
// non-empty strings when provided; accepts partial updates (only one of
// the two fields) via the same COALESCE pattern already used by
// `SiteConfig.update`/`MouService.updateDocument`. 404 if no template
// with that key exists.
router.put('/templates/:key', authenticateToken, authorize, [
  param('key').isString().trim().isLength({ min: 1, max: 100 }),
  body('subjectTemplate').optional().isString().trim().isLength({ min: 1, max: 1000 })
    .withMessage('subjectTemplate must be a non-empty string'),
  body('bodyTemplate').optional().isString().trim().isLength({ min: 1, max: 10000 })
    .withMessage('bodyTemplate must be a non-empty string')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { key } = req.params;
  const { subjectTemplate, bodyTemplate } = req.body;

  if (subjectTemplate === undefined && bodyTemplate === undefined) {
    return res.status(400).json({ error: 'At least one of subjectTemplate or bodyTemplate is required' });
  }

  try {
    const result = await pool.query(
      `UPDATE email_templates
       SET subject_template = COALESCE($1, subject_template),
           body_template = COALESCE($2, body_template),
           updated_by = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE template_key = $4
       RETURNING template_key, subject_template, body_template, description, updated_at`,
      [
        subjectTemplate === undefined ? null : subjectTemplate,
        bodyTemplate === undefined ? null : bodyTemplate,
        req.user.userId,
        key
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Email template not found: ${key}` });
    }

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'email_template.update', 'email_template', result.rows[0].template_key, null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ template: result.rows[0] });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update email template');
    res.status(500).json({ error: 'Failed to update email template' });
  }
});

// POST /api/communications/test-email (Requirement 30.5,
// Global_Manager-only). Calls `EmailService.sendEmail` directly against
// an admin-specified `targetEmail`, using a fixed default template key
// (see `DEFAULT_TEST_EMAIL_TEMPLATE_KEY` above) unless the caller
// supplies an explicit `templateKey` override -- independent of any
// `access_requests` row or broadcast filter, per design.md Section 25.
router.post('/test-email', authenticateToken, authorize, [
  body('targetEmail').isEmail().withMessage('targetEmail must be a valid email address'),
  body('templateKey').optional().isString().trim().isLength({ min: 1, max: 100 }),
  body('variables').optional().isObject()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { targetEmail, templateKey, variables } = req.body;

  try {
    await emailService.sendEmail(
      targetEmail,
      templateKey || DEFAULT_TEST_EMAIL_TEMPLATE_KEY,
      variables || {}
    );

    res.json({ message: 'Test email sent successfully', targetEmail });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to send test email');
    res.status(500).json({ error: 'Failed to send test email' });
  }
});

// POST /api/communications/send (Requirement 30.1, task 52.4). Wires
// `BroadcastEmailService.send` (already implemented, task 52.1) to an
// HTTP endpoint that sends a broadcast email to users filtered by team
// membership, team role, or channel membership (or every active user via
// `filter.allUsers`).
//
// Unlike every other route in this file, this route is reachable by ANY
// authenticated user (`communication:broadcast:send` is present in BOTH
// `roleDefaults.global_manager` -- via its wildcard -- AND
// `roleDefaults.authenticated_user` in permissions.registry.js), NOT
// Global_Manager-only at this route/Permission_Registry layer. This
// mirrors the `mou:sign` precedent in `server/routes/mou.js`: Requirement
// 30.2/30.3 specifically describe the SERVICE's own behavior ("a team
// admin may only send within teams they administer... reject fail-closed
// if the request would reach a user outside that scope") rather than a
// route-level Global_Manager gate, so `BroadcastEmailService.send`'s own
// internal, fail-closed scoping check (see that file's doc comment) is
// the real access control for a non-Global_Manager caller -- duplicating
// a coarser Global_Manager-only gate here would only prevent a team
// admin from ever reaching this endpoint at all, contradicting Req 30.2's
// "a team admin ... may send ... within their administered team(s)".
router.post('/send', authenticateToken, authorize, [
  body('templateKey').isString().trim().isLength({ min: 1, max: 100 })
    .withMessage('templateKey must be a non-empty string'),
  body('filter').optional().isObject(),
  body('variables').optional().isObject()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { templateKey, filter, variables } = req.body;

  try {
    const { sentCount } = await broadcastEmailService.send(
      filter || {},
      req.user,
      templateKey,
      variables || {}
    );

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'communication.send', 'communication', null, JSON.stringify({ templateKey, recipientCount: sentCount })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    // The full recipient email-address list is intentionally omitted
    // from the response (and never logged) -- the caller already knows
    // which filter they submitted, and echoing back every matched
    // address would needlessly expose other users' email addresses in
    // an HTTP response body / any client-side logging of it, for no
    // benefit beyond a debugging convenience. `sentCount` alone is
    // sufficient to confirm the broadcast reached the expected number of
    // recipients.
    res.json({ sentCount });
  } catch (error) {
    if (error instanceof BroadcastAuthorizationError) {
      return res.status(403).json({ error: error.message });
    }

    getLogger().error({ err: error }, 'Failed to send broadcast email');
    res.status(500).json({ error: 'Failed to send broadcast email' });
  }
});

module.exports = router;
