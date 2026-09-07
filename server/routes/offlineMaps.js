const express = require('express');
const { param, validationResult } = require('express-validator');
const QRCode = require('qrcode');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const OfflineMapService = require('../services/OfflineMapService');

const router = express.Router();

const offlineMapService = new OfflineMapService();

// Both routes below are gated by the Permission_Registry's
// 'offline_maps:read' entry, granted to every authenticated user
// (roleDefaults.authenticated_user). The whole router is mounted only while
// OFFLINE_MAPS_ENABLED is true (see server/index.js), so while the feature is
// off these routes do not exist and the app's catch-all answers them 404 —
// which is also how the client discovers the feature (probe this list route).

// List the offline-map catalog with live availability + sizes from S3.
router.get('/', authenticateToken, authorize, async (req, res) => {
  if (!offlineMapService.isConfigured()) {
    // Enabled but not wired up (no bucket): distinct from a runtime S3 error.
    getLogger().error('Offline maps enabled but OFFLINE_MAPS_S3_BUCKET is not configured');
    return res.status(503).json({ error: 'Offline maps are not configured' });
  }

  try {
    const maps = await offlineMapService.listAvailableMaps();
    res.json({ maps });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to list offline maps');
    res.status(500).json({ error: 'Failed to list offline maps' });
  }
});

// Desktop -> phone handoff QR code (design §4.7): a QR encoding this app's
// /downloads page URL, so a user browsing on a PC can jump to the same page
// on their phone (where the maps actually need to land). The QR is generated
// SERVER-SIDE as a data URL via `qrcode` — the SAME pattern the enrollment
// surface uses (`DeviceEnrollmentService.renderQrDataUrl` -> `<img src>`),
// so no client QR dependency is needed. The encoded URL uses the canonical
// APP_URL origin (e.g. https://team.tak.nz), NOT the browser's own host, so
// the code always points at the real public page rather than whatever
// internal host/port the desktop happened to reach. Placed before the
// `/:id/url` route so the literal `/qr` path is matched before the `:id` param.
router.get('/qr', authenticateToken, authorize, async (req, res) => {
  try {
    const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
    if (!appUrl) {
      // APP_URL is a required, validated config var; treat absence as a
      // misconfiguration rather than encoding a bogus URL.
      getLogger().error('APP_URL is not configured; cannot build the /downloads QR code');
      return res.status(503).json({ error: 'Offline maps QR code is not available' });
    }
    const url = `${appUrl}/downloads`;
    const qrCodeDataUrl = await QRCode.toDataURL(url);
    res.json({ url, qrCodeDataUrl });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to generate offline maps QR code');
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Mint a short-lived presigned download URL for a single catalog entry.
// The client supplies a catalog id (e.g. `regional-otago`), never an S3 key.
router.get(
  '/:id/url',
  authenticateToken,
  authorize,
  [param('id').isString().trim().isLength({ min: 1, max: 100 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!offlineMapService.isConfigured()) {
      getLogger().error('Offline maps enabled but OFFLINE_MAPS_S3_BUCKET is not configured');
      return res.status(503).json({ error: 'Offline maps are not configured' });
    }

    try {
      const result = await offlineMapService.getPresignedUrl(req.params.id);
      res.json(result);
    } catch (error) {
      if (error.code === 'UNKNOWN_MAP_ID') {
        return res.status(404).json({ error: 'Offline map not found' });
      }
      getLogger().error({ err: error }, 'Failed to generate offline map download URL');
      res.status(500).json({ error: 'Failed to generate download URL' });
    }
  }
);

module.exports = router;
