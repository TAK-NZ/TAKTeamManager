const express = require('express');
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const BulkImportService = require('../services/BulkImportService');

const router = express.Router();

/**
 * server/routes/bulkImport.js
 *
 * Express routes for CSV Bulk Import for Users and Teams (Requirement
 * 29, task 51.4). Thin HTTP wrapper around `BulkImportService` (tasks
 * 51.1-51.2): accepts a multipart CSV file upload, delegates to the
 * service, and returns its per-row result summary. No business logic
 * (authorization, CSV parsing, row processing) lives here.
 *
 * --- Multipart field name ---
 *
 * Both routes below accept the uploaded CSV under the multipart field
 * name `csv` (i.e. `multer.single('csv')`) -- documented here as the
 * one canonical name a client must use, matching the naming already used
 * by the downloadable templates this feature ships
 * (`public/templates/user-import-template.csv` /
 * `team-import-template.csv`, task 51.3).
 *
 * --- Upload constraints ---
 *
 * Reuses the exact `multer.memoryStorage()` + a configured upload
 * middleware + `handleUpload()`-wrapper-translating-`MulterError`-into-a-
 * `{error}` 400 response pattern already established by
 * `server/routes/settings.js`'s logo/cert/key upload routes. A CSV file
 * is small text, so a generous but bounded 10MB `fileSize` limit is
 * applied. Unlike the logo upload (which allow-lists specific image MIME
 * types), no MIME-type allow-list is applied here: CSV MIME sniffing is
 * notoriously inconsistent across browsers/OSes (`text/csv`,
 * `application/vnd.ms-excel`, and `application/octet-stream` are all
 * commonly seen for the exact same file depending on client/OS), so
 * rejecting solely on MIME type would be more likely to reject a
 * legitimate CSV than to catch a malicious one. Malformed content is
 * instead safely rejected row-by-row by `csv-parse` itself inside
 * `BulkImportService` (an unparseable row simply fails that row, per
 * Requirement 29.2/29.6 -- it never crashes the request).
 *
 * --- Authorization ---
 *
 * `POST /users/preview`: a read-only dry run over
 * the identical upload, sharing `POST /users`'s Permission_Registry
 * identifier and authorization semantics -- see its own route comment
 * below.
 *
 * `POST /users` (Requirement 29.2-29.4, 29.6): `BulkImportService
 * .importUsers` already performs its own per-row authorization
 * internally (`Team.isAdmin(row.teamId, importingUser) OR
 * importingUser.is_global_manager`, task 51.1) -- a team admin who does
 * not administer a particular row's target team simply gets that row
 * recorded as a failure in the results array; the batch continues
 * (Requirement 29.4). Because the real access control lives in the
 * service, this route's Permission_Registry identifier
 * (`bulk_import:users`) is held by BOTH `roleDefaults.global_manager`
 * (via its wildcard) AND `roleDefaults.authenticated_user`, so any
 * authenticated user -- including a team admin who administers no team
 * at all -- can reach this route; the service is what actually decides,
 * per row, whether the import is allowed.
 *
 * `POST /teams` (Requirement 29.5): `BulkImportService.importTeams` is
 * Global_Manager-only for the ENTIRE batch -- it throws
 * `BulkImportAuthorizationError` up front (task 51.2), before parsing a
 * single CSV row, when `importingUser.is_global_manager` is not `true`.
 * Creating an arbitrary new team isn't scoped to any single team an
 * admin might administer, mirroring Requirement 4.5's root-team-create
 * restriction. This route's Permission_Registry identifier
 * (`bulk_import:teams`) is therefore a SEPARATE identifier held ONLY by
 * `roleDefaults.global_manager`'s wildcard (defense in depth): in
 * practice a non-Global_Manager caller is denied at the
 * `authorize.js`/Permission_Registry layer before
 * `BulkImportService.importTeams` is ever invoked, so its own internal
 * `BulkImportAuthorizationError` never actually fires over HTTP through
 * this route -- the `catch` below for that error class is retained as
 * defense in depth (and because the service itself is also called
 * directly by its own unit tests without going through this route).
 */

const CSV_MAX_BYTES = 10 * 1024 * 1024; // 10MB -- generous but bounded for a text CSV upload.

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CSV_MAX_BYTES }
});

/**
 * Translates a `multer` upload failure (thrown/passed to `next` as a
 * `MulterError`) into the same `{error: string}` 400 response shape used
 * throughout the app, rather than letting it fall through to the
 * generic error-handling middleware in `server/index.js` (which would
 * respond 500 for what is actually a client input error). Mirrors
 * `server/routes/settings.js`'s `handleUpload` helper exactly.
 *
 * @param {Function} uploadMiddleware - A configured `multer` middleware (e.g. `csvUpload.single('csv')`).
 * @returns {Function} An Express middleware wrapping `uploadMiddleware` with error translation.
 */
function handleUpload(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Uploaded CSV file exceeds the maximum allowed size' });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      next();
    });
  };
}

// Bugfix: parses the optional `teamId`/`rowNumbers`
// multipart form fields shared by POST /users/preview and POST /users
// below. `teamId` backs the team-scoped import surface (Team_Detail's
// "Import Users" action already knows its own team and never asks the
// operator to type one); `rowNumbers` backs the confirm step, letting
// a caller commit exactly the rows an operator approved in the preview
// response, from a JSON-encoded array of 1-based row numbers.
function parseOptionalTeamId(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  return value;
}

function parseOptionalRowNumbers(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// POST /api/bulk-import/users/preview (preview-then-confirm). Accepts the same `csv` multipart field (plus an
// optional `teamId` field for a team-scoped upload) and delegates to
// `BulkImportService.previewUsers` -- a READ-ONLY dry run: no Authentik
// call, no DB write, no audit log entry (nothing has happened yet).
// Shares the SAME Permission_Registry identifier as `POST /users`
// (`bulk_import:users`), since previewing is strictly less privileged
// than actually importing and gating it any tighter would let an
// operator who is authorized to import be denied merely previewing.
router.post('/users/preview', authenticateToken, authorize, handleUpload(csvUpload.single('csv')), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'A CSV file is required (multipart field name: csv)' });
  }

  try {
    const result = await BulkImportService.previewUsers(req.file.buffer, req.user, parseOptionalTeamId(req.body.teamId));
    res.status(200).json(result);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to preview user CSV import');
    res.status(500).json({ error: 'Failed to preview user CSV import' });
  }
});

// POST /api/bulk-import/users (Requirement 29.2-29.4, 29.6). Accepts a
// `csv` multipart field, delegates to `BulkImportService.importUsers`,
// and returns its full {successCount, failureCount, results} per-row
// summary with 200 (Requirement 29.6: a per-row result summary, not a
// single pass/fail for the batch).
//
// Bugfix: also accepts optional `teamId` (a
// team-scoped upload's fixed target team, used as `defaultTeamId` for
// any row whose own `teamId` column is blank) and `rowNumbers` (a
// JSON-encoded array of 1-based row numbers to actually commit -- every
// other row in the uploaded file is skipped, letting a caller re-upload
// the exact same file it already previewed and commit only the rows an
// operator approved).
router.post('/users', authenticateToken, authorize, handleUpload(csvUpload.single('csv')), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'A CSV file is required (multipart field name: csv)' });
  }

  try {
    const result = await BulkImportService.importUsers(req.file.buffer, req.user, {
      defaultTeamId: parseOptionalTeamId(req.body.teamId),
      rowNumbers: parseOptionalRowNumbers(req.body.rowNumbers)
    });

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'bulk_import.users', 'bulk_import', null, JSON.stringify({ rowCount: result.results ? result.results.length : 0 })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(200).json(result);
  } catch (error) {
    // Bugfix (row-count cap): a whole-batch rejection, distinct from a
    // per-row `results` entry -- mirrors the `BulkImportAuthorizationError`
    // -> 403 mapping just below for `POST /teams`, at 400 instead since
    // this is a client-correctable "your file is too big for this
    // endpoint" rejection, not an authorization failure.
    if (error.name === 'BulkImportRowLimitExceededError') {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to process user CSV import');
    res.status(500).json({ error: 'Failed to process user CSV import' });
  }
});

// POST /api/bulk-import/teams (Requirement 29.5). Accepts a `csv`
// multipart field, delegates to `BulkImportService.importTeams`, and
// returns its full {successCount, failureCount, results} per-row summary
// with 200. `BulkImportAuthorizationError` (thrown for the WHOLE request
// when the importing user is not a Global_Manager) is mapped to 403 --
// distinct from the per-row `results` array's row-level failures -- as
// defense in depth alongside the Permission_Registry's own
// `bulk_import:teams` gating (see header comment above).
router.post('/teams', authenticateToken, authorize, handleUpload(csvUpload.single('csv')), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'A CSV file is required (multipart field name: csv)' });
  }

  try {
    const result = await BulkImportService.importTeams(req.file.buffer, req.user);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'bulk_import.teams', 'bulk_import', null, JSON.stringify({ rowCount: result.results ? result.results.length : 0 })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(200).json(result);
  } catch (error) {
    if (error.name === 'BulkImportAuthorizationError') {
      return res.status(403).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to process team CSV import');
    res.status(500).json({ error: 'Failed to process team CSV import' });
  }
});

module.exports = router;
