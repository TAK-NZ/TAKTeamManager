/**
 * Test for the `/templates` static-file mount (Requirement 29 Criterion
 * 1, BUG-011).
 *
 * `public/templates/user-import-template.csv` and
 * `public/templates/team-import-template.csv` exist on disk but were
 * never reachable over HTTP before this fix -- `server/index.js` only
 * mounted `express.static` for `client/dist` and `UPLOADS_DIR`. This test
 * builds a minimal Express app mounting `express.static` at `/templates`
 * pointed at the real `public/templates` directory, exactly as
 * `server/index.js` now does, and confirms both template files are
 * actually servable with a 200 status and CSV content, without needing
 * to boot the full app (which would require DB config, `validateConfig`,
 * `app.listen`, etc. -- see
 * `server/config/permissions.registry.completeness.test.js`'s doc
 * comment for why other tests in this codebase also avoid
 * `require('./index')` directly).
 */

const path = require('path');
const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use('/templates', express.static(path.join(__dirname, '../public/templates')));
  return app;
}

describe('/templates static mount (Requirement 29.1, BUG-011)', () => {
  it('serves the user import CSV template with a 200 status', async () => {
    const app = buildApp();
    const res = await request(app).get('/templates/user-import-template.csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('serves the team import CSV template with a 200 status', async () => {
    const app = buildApp();
    const res = await request(app).get('/templates/team-import-template.csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('returns 404 for a template file that does not exist', async () => {
    const app = buildApp();
    const res = await request(app).get('/templates/does-not-exist.csv');

    expect(res.status).toBe(404);
  });
});
