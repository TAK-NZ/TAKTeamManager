const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const EmailService = require('../services/EmailService');

const router = express.Router();
const emailService = new EmailService();

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
 *
 * The broadcast-composer endpoint (`POST /api/communications/send`,
 * originally task 52.4, wiring `BroadcastEmailService.send`) has been
 * removed -- the product no longer needs it. It never had a client
 * caller (no composer UI was ever built), so removal is backend-only;
 * the template-editor/test-email routes below are unaffected and remain
 * in active use by `Admin.jsx`'s Email Templates tab.
 *
 * Every route in this file is Global_Manager-only, enforced centrally by
 * `authorize.js` via the Permission_Registry's
 * `communication:template:*`/`communication:test_email:send` entries
 * (resolved through `roleDefaults.global_manager: ['*']`), matching the
 * pattern already used by every other Global_Manager-only route file
 * (`deploymentChannels.js`, `auditLogs.js`, `settings.js`) -- no inline
 * `is_global_manager` check is duplicated here.
 */

/**
 * `email_templates` columns (per `database/schema.sql`): `id`,
 * `template_key` (unique), `subject_template`, `body_template`,
 * `description`, `updated_by`, `updated_at`. `EmailService.sendEmail`
 * already queries this table with
 * `SELECT subject_template, body_template FROM email_templates WHERE template_key = $1`
 * -- the routes below follow that same column-naming convention.
 */

// GET /api/communications/templates (admin-settings-management
// Requirement 2, Global_Manager-only). Returns every row of the
// `email_templates` table so the Template_Editor has a single source of
// truth for the set of template keys. Reuses the same `email_templates`
// table and the same `authenticateToken` + `authorize` gate the
// `:key` route below uses; introduces no new table, column, or migration.
// This literal `/templates` path is distinct from the parameterized
// `/templates/:key` route below and does not collide with it.
router.get('/templates', authenticateToken, authorize, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT template_key, subject_template, body_template, description, updated_at FROM email_templates ORDER BY template_key'
    );

    res.json({ templates: result.rows });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch email templates');
    res.status(500).json({ error: 'Failed to fetch email templates' });
  }
});

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
      // Bugfix: `audit_logs.resource_id` is `integer`, but
      // `template_key` is a string (e.g. `'welcome_email'`) -- passing it
      // as `resource_id` made Postgres reject the insert every time,
      // silently swallowed by the surrounding catch, so template edits
      // were never actually audited. Fixed by passing `resource_id: null`
      // and putting the identifying `template_key` into `details`
      // instead, matching the established convention for a
      // non-integer-id resource (see `bulkImport.js`'s
      // `bulk_import.users` insert).
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'email_template.update', 'email_template', null, JSON.stringify({ templateKey: result.rows[0].template_key })]
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

module.exports = router;
