const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const pool = require('../config/database');
const DeviceEnrollmentService = require('../services/DeviceEnrollmentService');

const router = express.Router();

/**
 * server/routes/enrollment.js
 *
 * takserver-enrollment Requirement 3: self-service enrollment for a
 * signed-in Human_Principal's OWN account. Thin HTTP wrapper around
 * `DeviceEnrollmentService.generateSelfEnrollment` -- no route
 * parameters, no body schema and no query schema, because the subject is
 * always `req.user` and nothing else (Criterion 3.4): with no id to
 * supply, there is no id to tamper with.
 *
 * Mirrors `server/routes/devices.js`'s `ERROR_STATUS_BY_NAME`/
 * `handleServiceError` pattern verbatim rather than sharing it -- that
 * file's own header comment cites `server/routes/mou.js`/
 * `server/routes/vendorChannels.js` as precedent for per-route-file
 * duplication of this pattern.
 */

/**
 * Maps a `DeviceEnrollmentService`/`ManagedIdentifierService` named error
 * to an HTTP status code. See `server/routes/devices.js` for the shared
 * reasoning on `TakServerNotConfiguredError`.
 */
const ERROR_STATUS_BY_NAME = {
  // takserver-enrollment Criterion 14.5: a Team_Owned_Device session
  // resolving through the self path is either a defect or an attack, not
  // a normal caller error about a missing/invalid resource -- 403,
  // mirroring `DeviceEnrollmentAuthorizationError`'s treatment on the
  // device path.
  DeviceSessionCannotSelfEnrollError: 403,
  TakServerNotConfiguredError: 400,
  // takserver-enrollment Criterion 2.9: a missing/invalid
  // Organisation_Prefix is a configuration precondition on the
  // Organisation, not a caller-supplied validation failure -- 400,
  // matching `TakServerNotConfiguredError`'s treatment above.
  OrganisationPrefixMissingError: 400,
  // takserver-enrollment Criterion 1.9: every other entry above
  // describes something the caller did or something the deployment has
  // not configured. Exhaustion describes a defect in the generator's
  // random source instead, so it is deliberately the one 500: loud, and
  // its message tells the caller nothing actionable. The detail goes to
  // the log via `handleServiceError`'s generic branch.
  ManagedIdentifierExhaustionError: 500
};

/**
 * Sends the appropriate response for a `DeviceEnrollmentService` error: a
 * specific status + message for any recognized named error class above
 * (except the deliberate 500, which falls through to the generic branch
 * so its detail is logged rather than echoed to the caller), or a
 * generic 500 (logged, no internal detail leaked) for anything else.
 *
 * @param {import('express').Response} res
 * @param {Error} error
 * @param {string} logMessage
 */
function handleServiceError(res, error, logMessage) {
  const status = ERROR_STATUS_BY_NAME[error.name];
  if (status && status !== 500) {
    return res.status(status).json({ error: error.message });
  }

  getLogger().error({ err: error }, logMessage);
  return res.status(500).json({ error: logMessage });
}

// Client UX correction: resolves the "Enrollment Data" section's fields
// (host, username, Callsign/Color/Role, live certificate count) WITHOUT
// minting an Enrollment_Token, so the Enrollment_View can render this
// section automatically on mount without minting a live 30-minute
// Authentik credential every time a user merely visits the page. `no-store`
// is set here too even though the response carries no secret, for the same
// reason the POST route below sets it unconditionally: a consistent
// caching contract across every route on this file is simpler to reason
// about than one that varies by which fields a given response happens to
// carry.
router.get('/me/preview', authenticateToken, authorize, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');

  try {
    const preview = await DeviceEnrollmentService.previewSelfEnrollment(req.user);
    res.json({ preview });
  } catch (error) {
    handleServiceError(res, error, 'Failed to preview self-service enrollment');
  }
});

// takserver-enrollment Criteria 3.4, 15.1, 15.2: self-service enrollment
// for a signed-in Human_Principal's OWN account, whether or not they
// hold any team membership. No route parameters, no body schema, no
// query schema -- `generateSelfEnrollment`'s only argument is `req.user`.
router.post('/me', authenticateToken, authorize, async (req, res) => {
  // Criterion 11.5: `no-store` is the load-bearing directive -- it
  // forbids a shared or private cache from writing the response body
  // (which carries a live Enrollment_Token) to disk at all, where
  // `no-cache` alone only requires revalidation. Set unconditionally, on
  // every response path including the error paths below, per the
  // Enrollment_Lambda's own `index.js:148`.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');

  try {
    const enrollment = await DeviceEnrollmentService.generateSelfEnrollment(req.user);

    // Criteria 3.9, 11.5: the Enrollment_Audit_Record, matching exactly
    // what `routes/devices.js` already writes under `production-
    // hardening` Criterion 27.8 -- same `INSERT INTO audit_logs` column
    // set, written after a successful call and before responding. The
    // `details` document carries only `{ principalId, generatedAt,
    // expiresAt }` -- deliberately NO token key and NO QR data URL.
    const generatedAt = new Date().toISOString();
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.userId,
        'enrollment_self_qr_generated',
        'user',
        enrollment.principalId,
        JSON.stringify({
          principalId: enrollment.principalId,
          generatedAt,
          expiresAt: enrollment.expiresAt
        })
      ]
    );

    res.json({ enrollment });
  } catch (error) {
    handleServiceError(res, error, 'Failed to generate self-service enrollment');
  }
});

module.exports = router;
