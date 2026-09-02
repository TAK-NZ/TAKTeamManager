/**
 * `GET /api/openapi.json`: serves the generated OpenAPI document
 * (`server/config/openapi.js`'s `buildOpenApiDocument()`).
 *
 * Gated to `docs:openapi:read` (Global_Manager, or any Team_Admin of at
 * least one team) rather than left public or opened to every
 * authenticated user -- see that identifier's own comment in
 * `server/config/permissions.registry.js` for why. A regular member gets
 * no useful capability from reading this document (per the same registry
 * that decides what THEY can call), while it names every admin-only
 * route's exact permission identifier -- minor reconnaissance value this
 * route declines to hand out to a non-admin.
 *
 * The document is rebuilt on every request rather than cached at module
 * load: `buildOpenApiDocument()` is a small, pure, synchronous function
 * over two in-memory registries (no I/O, no DB, no network), so the cost
 * of recomputing it is negligible, and this avoids ever serving a stale
 * document if the registries are hot-reloaded in a dev environment.
 */

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { buildOpenApiDocument } = require('../config/openapi');

const router = express.Router();

router.get('/openapi.json', authenticateToken, authorize, (req, res) => {
  res.json(buildOpenApiDocument());
});

module.exports = router;
