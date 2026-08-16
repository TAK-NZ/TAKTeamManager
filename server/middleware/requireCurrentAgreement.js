/**
 * requireCurrentAgreement (Requirement 28 Criteria 6-7: Login-Time User
 * Agreement Gate, task 50.4)
 *
 * `design.md`'s Section 23 describes this middleware as running
 * "immediately after `authenticateToken`/`authorize`", while itself being
 * "listed as a special case that always runs, similar to how
 * `publicRouteBootstrap` always runs before auth". The two halves of that
 * sentence are in tension in THIS codebase specifically, and the tension
 * needs to be spelled out before describing what this file does:
 *
 *   - `publicRouteBootstrap` (`server/middleware/publicRouteBootstrap.js`)
 *     is mounted globally via a single `app.use()` in `server/index.js`,
 *     ahead of every route mount, and its own header comment documents
 *     that `authenticateToken`/`authorize` are NOT mounted globally in
 *     this codebase -- they are mounted per-route, inside each individual
 *     `server/routes/*.js` file (task 12.3's own commit message: `req.route`,
 *     which `authorize.js` depends on, is only populated by Express once a
 *     request has matched a specific route, not at router-mount time).
 *     `publicRouteBootstrap` therefore cannot actually delegate to
 *     `authenticateToken` from its global mount point -- it says so
 *     explicitly in its own NOTE -- and every route's own
 *     `authenticateToken`/`authorize` pair continues to run exactly as it
 *     did before that global middleware existed.
 *   - The same constraint applies here: `req.user` (set by
 *     `authenticateToken`) is not yet populated at a global,
 *     ahead-of-every-route-mount position in the middleware chain, because
 *     nothing sets it until a specific route's own `authenticateToken`
 *     call runs, further down the chain, per route.
 *
 * Given that constraint, this module is written to be usable in BOTH of
 * the two positions design.md's sentence describes, and defensively
 * inert when `req.user` isn't present yet:
 *
 *   1. Mounted globally in `server/index.js` (task 50.4's chosen mounting
 *      point here, matching `publicRouteBootstrap`'s existing precedent
 *      for a globally-mounted, "always runs" middleware in this exact
 *      position of the chain) -- where, today, `req.user` is never yet
 *      set, so step 1 of `requireCurrentAgreement()` below (skip when
 *      `req.user` is absent) applies to every request reaching this
 *      global mount point. This satisfies Req 33.2/Section 23's "always
 *      runs" framing and Requirement 28.6's requirement that the check be
 *      consulted centrally rather than duplicated ad hoc, without
 *      requiring an invasive, cross-cutting retrofit of every existing
 *      route file's per-route middleware chain (out of scope for this
 *      task; no task in this plan currently owns that retrofit).
 *   2. Mounted per-route, immediately after `authenticateToken`/
 *      `authorize` (exactly as design.md's sentence describes), in any
 *      route -- including `server/routes/mou.js` (task 50.5) -- where
 *      `req.user` IS already populated by that point. This is where the
 *      gate is actually enforced today, and is the pattern task 50.5
 *      (and any future route needing this gate) should follow.
 *
 * Requirement 28 Criterion 6: "require every authenticated user who has
 * not recorded an MOU_Signature for the current version of that
 * MOU_Document to record one before being permitted to access any route
 * other than the signature-submission endpoint and the existing logout
 * route." Requirement 28 Criterion 7: re-acceptance is required
 * transparently when a new version supersedes the current agreement --
 * per `MouService.setAsCurrentAgreement`'s own doc comment, a
 * supersession creates a brand-new `mou_documents` row with a new id, so
 * a user's existing `mou_signatures` row (referencing the OLD document's
 * id) simply does not match the NEW current document's id; no separate
 * "supersession" bookkeeping is needed here.
 *
 * Only a SERVERWIDE (`team_id IS NULL`) current agreement gates every
 * user (Requirement 28.6's "mandatory serverwide user agreement" wording)
 * -- a team-scoped `is_current_agreement` row (if the schema even permits
 * more than one concurrently, given the partial unique index is not
 * scoped by `team_id`) would not gate every user, only that team's, so it
 * is deliberately excluded from the query below via `team_id IS NULL`.
 */

const pathToRegexp = require('path-to-regexp');
const pool = require('../config/database');
const logger = require('../config/logger').createLogger('requireCurrentAgreement');

/**
 * Requirement 28 Criterion 6's explicit allow-list: "any route other than
 * the signature-submission endpoint and the existing logout route."
 *
 * `POST /api/mou/:documentId/sign` is the exact signature-submission
 * path named in `design.md`'s Section 23 (not a placeholder -- task 50.5,
 * a separate concurrent task, is expected to define `server/routes/mou.js`
 * using this same path so the two stay in sync). `POST /api/auth/logout`
 * is the existing logout route (Requirement 3.3/3.4), already public per
 * `server/config/publicRoutes.js`.
 *
 * Path patterns use the same Express mounted-route-pattern style (and the
 * same `path-to-regexp` matching approach) already established by
 * `server/middleware/publicRouteBootstrap.js`, for a param-aware match
 * against the real incoming `req.path` (e.g. `:documentId`).
 */
const BYPASS_ROUTES = [
  { method: 'POST', path: '/api/mou/:documentId/sign' },
  { method: 'POST', path: '/api/auth/logout' }
];

const compiledBypassRoutes = BYPASS_ROUTES.map(({ method, path }) => ({
  method: method.toUpperCase(),
  regexp: pathToRegexp(path)
}));

/**
 * Returns `true` if `{method, path}` matches an entry in
 * `BYPASS_ROUTES` -- the signature-submission endpoint or logout.
 *
 * @param {string} method - HTTP method, e.g. `"POST"`.
 * @param {string} path - request path, e.g. `/api/mou/5/sign`.
 * @returns {boolean}
 */
function isBypassRoute(method, path) {
  const upperMethod = (method || '').toUpperCase();
  return compiledBypassRoutes.some(
    (route) => route.method === upperMethod && route.regexp.test(path)
  );
}

/**
 * Express middleware implementing the Requirement 28 Criteria 6-7
 * login-time user agreement gate.
 *
 * Behavior:
 *   1. Bypass routes (signature submission, logout) always call `next()`
 *      immediately, checked first, before any other branch.
 *   2. No `req.user` (unauthenticated, or this middleware is running
 *      ahead of `authenticateToken` in the chain -- see this file's
 *      header comment): calls `next()`, deferring entirely to whatever
 *      authentication/authorization already ran or will run for this
 *      request.
 *   3. Queries for the current mandatory SERVERWIDE agreement
 *      (`is_current_agreement = true AND team_id IS NULL`). If none
 *      exists, calls `next()` -- nothing to enforce.
 *   4. If one exists, checks whether `req.user.userId` has an
 *      `mou_signatures` row referencing that exact document's id. If so,
 *      calls `next()`.
 *   5. Otherwise blocks the request with 403 and a
 *      `{error, requiresSignature: true, documentId}` body, so a client
 *      can redirect the user to a signing UI for that specific document.
 *
 * A database error while performing either query is treated as a
 * fail-closed block (403), consistent with this codebase's established
 * "resolver/authorization-check exceptions are treated as denied, not as
 * a pass-through" convention (see `authorize.js`'s
 * `isSatisfiedWithRowScopedChecks`, Requirement 4 Criteria 4.3/4.6) --
 * silently letting every user through on a transient DB error would
 * defeat the mandatory-agreement gate entirely.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireCurrentAgreement(req, res, next) {
  if (isBypassRoute(req.method, req.path)) {
    return next();
  }

  if (!req.user || req.user.userId == null) {
    // Unauthenticated, or this middleware ran ahead of `authenticateToken`
    // in the chain -- see this file's header comment. Defer to whatever
    // already ran (or will run) before/after this point.
    return next();
  }

  try {
    const currentAgreementResult = await pool.query(
      'SELECT id FROM mou_documents WHERE is_current_agreement = true AND team_id IS NULL LIMIT 1'
    );

    const currentAgreement = currentAgreementResult.rows[0];

    if (!currentAgreement) {
      // No mandatory serverwide agreement is currently in force.
      return next();
    }

    const signatureResult = await pool.query(
      'SELECT 1 FROM mou_signatures WHERE mou_document_id = $1 AND signer_user_id = $2 LIMIT 1',
      [currentAgreement.id, req.user.userId]
    );

    if (signatureResult.rows.length > 0) {
      // Already signed this exact version.
      return next();
    }

    return res.status(403).json({
      error: 'You must sign the current user agreement before continuing',
      requiresSignature: true,
      documentId: currentAgreement.id
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Error checking current MOU agreement; blocking request');
    return res.status(403).json({
      error: 'Unable to verify user agreement status'
    });
  }
}

module.exports = requireCurrentAgreement;
module.exports.isBypassRoute = isBypassRoute;
module.exports.BYPASS_ROUTES = BYPASS_ROUTES;
