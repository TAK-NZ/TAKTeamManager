/**
 * Route tests for /api/offline-maps.
 *
 * `authenticateToken` is mocked to inject a plain (non-Global_Manager) user, but
 * the REAL `authorize` + permissions.registry.js run — so a 200 here proves the
 * 'offline_maps:read' grant reaches every authenticated user, and a regression
 * removing the registry entry would surface as a 403. The service is mocked at
 * the instance boundary; no S3, no network.
 */

let mockUser = { id: 'authentik-1', userId: 1, is_global_manager: false };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

// Mock the service module: the router does `new OfflineMapService()`, so the
// mock is a constructor returning a shared spy object we can program per test.
const mockServiceInstance = {
  isConfigured: jest.fn(),
  listAvailableMaps: jest.fn(),
  getPresignedUrl: jest.fn()
};
jest.mock('../services/OfflineMapService', () => {
  return jest.fn().mockImplementation(() => mockServiceInstance);
});

const express = require('express');
const request = require('supertest');
const offlineMapsRouter = require('./offlineMaps');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/offline-maps', offlineMapsRouter);
  return app;
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'authentik-1', userId: 1, is_global_manager: false };
  // Default: configured. Individual tests override.
  mockServiceInstance.isConfigured.mockReturnValue(true);
  app = buildApp();
});

describe('GET /api/offline-maps', () => {
  it('returns the catalog list (200) for a plain authenticated user', async () => {
    const maps = [
      { id: 'regional-otago', group: 'south-island', category: 'regional', label: 'Otago', apps: ['atak', 'takaware'], sizeBytes: 694591488, available: true },
      { id: 'marine-charts', group: 'marine', category: 'marine', label: 'NZ Marine Charts', apps: ['atak', 'takaware'], sizeBytes: null, available: false }
    ];
    mockServiceInstance.listAvailableMaps.mockResolvedValue(maps);

    const res = await request(app).get('/api/offline-maps');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ maps });
    expect(mockServiceInstance.listAvailableMaps).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when enabled but no bucket is configured, without hitting S3', async () => {
    mockServiceInstance.isConfigured.mockReturnValue(false);

    const res = await request(app).get('/api/offline-maps');

    expect(res.status).toBe(503);
    expect(mockServiceInstance.listAvailableMaps).not.toHaveBeenCalled();
  });

  it('returns 500 when the service throws', async () => {
    mockServiceInstance.listAvailableMaps.mockRejectedValue(new Error('S3 down'));

    const res = await request(app).get('/api/offline-maps');

    expect(res.status).toBe(500);
  });
});

describe('GET /api/offline-maps/:id/url', () => {
  it('returns a presigned URL (200) for a known id', async () => {
    mockServiceInstance.getPresignedUrl.mockResolvedValue({
      url: 'https://signed.example/otago',
      fileName: 'otago-topo.mbtiles',
      expiresIn: 300
    });

    const res = await request(app).get('/api/offline-maps/regional-otago/url');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: 'https://signed.example/otago',
      fileName: 'otago-topo.mbtiles',
      expiresIn: 300
    });
    expect(mockServiceInstance.getPresignedUrl).toHaveBeenCalledWith('regional-otago');
  });

  it('returns 404 for an unknown id (UNKNOWN_MAP_ID)', async () => {
    const err = new Error('Unknown offline map id: nope');
    err.code = 'UNKNOWN_MAP_ID';
    mockServiceInstance.getPresignedUrl.mockRejectedValue(err);

    const res = await request(app).get('/api/offline-maps/nope/url');

    expect(res.status).toBe(404);
  });

  it('returns 503 when enabled but no bucket is configured', async () => {
    mockServiceInstance.isConfigured.mockReturnValue(false);

    const res = await request(app).get('/api/offline-maps/regional-otago/url');

    expect(res.status).toBe(503);
    expect(mockServiceInstance.getPresignedUrl).not.toHaveBeenCalled();
  });

  it('returns 500 on an unexpected service error', async () => {
    mockServiceInstance.getPresignedUrl.mockRejectedValue(new Error('presign failed'));

    const res = await request(app).get('/api/offline-maps/regional-otago/url');

    expect(res.status).toBe(500);
  });
});
