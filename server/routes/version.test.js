/**
 * Unit test for `GET /api` (server/routes/version.js): a minimal,
 * unauthenticated version probe mirroring CloudTAK's own `GET /api/`
 * shape (`{"version": "..."}`).
 */

const express = require('express');
const request = require('supertest');

const { version: packageVersion } = require('../../package.json');
const versionRouter = require('./version');

function buildApp() {
  const app = express();
  app.use('/api', versionRouter);
  return app;
}

describe('GET /api', () => {
  it('returns 200 with exactly {version} matching package.json', async () => {
    const res = await request(buildApp()).get('/api');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: packageVersion });
  });

  it('requires no authentication (no Authorization header, no cookie)', async () => {
    const res = await request(buildApp()).get('/api');

    expect(res.status).toBe(200);
  });
});
