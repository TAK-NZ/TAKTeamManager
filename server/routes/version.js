/**
 * `GET /api` (mounted here at the app root -- see `server/index.js`):
 * a minimal, unauthenticated version probe, mirroring the shape
 * CloudTAK's own `GET /api/` returns (`{"version": "..."}`) so the same
 * "hit /api/ to see what's running" habit works across TAK-NZ's apps.
 *
 * Deliberately returns ONLY the version -- no build metadata, no git SHA,
 * nothing else -- matching CloudTAK's own minimal shape. `Layout.jsx`
 * fetches this once on mount to show the running version at the bottom of
 * the left-hand nav.
 *
 * This endpoint, and any future raw JSON API-schema/OpenAPI document, are
 * deliberately kept machine-readable JSON at this path -- a future
 * Swagger UI (a rendered HTML page) belongs at a SEPARATE path (e.g.
 * `/api-docs`), not here, so the two never collide and `/api/` stays a
 * predictable, scriptable version check.
 */

const express = require('express');
const { version } = require('../../package.json');

const router = express.Router();

router.get('/', (req, res) => {
  res.status(200).json({ version });
});

module.exports = router;
