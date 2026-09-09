/**
 * Integration tests for `server/routes/settings.js` (Requirement 32
 * Criterion 2, task 54.2).
 *
 * `authenticateToken` is mocked to bypass real JWT verification, but the
 * REAL `authorize.js` middleware and `permissions.registry.js` are used
 * (not mocked), matching the convention already established by
 * `server/routes/auditLogs.test.js`: every test sets
 * `req.user.is_global_manager` explicitly, so the authorization outcome
 * for each request is exercised for real rather than assumed, and a
 * regression removing this route's `settings:manage` registry entry would
 * be caught by the "success" tests failing with 403 instead of 200.
 *
 * `SiteConfig` (branding, backed by `site_config`) and `pool.query`
 * (TAK Server settings/export/import, backed by `system_config`) are
 * mocked at the data-access boundary, following the same pattern already
 * used by `server/models/SiteConfig.test.js` and
 * `server/routes/auditLogs.test.js` respectively.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  // Requirement 32.6 (task 54.6): `POST /api/settings/import` applies its
  // writes on a single transactional client via `pool.connect()`, distinct
  // from every other route in this file (which use the plain `pool.query`
  // mock above). Added here rather than as a separate `jest.mock` call
  // since Jest only honors the first `jest.mock('../config/database', ...)`
  // factory per test file.
  connect: jest.fn()
}));

let mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

jest.mock('../models/SiteConfig', () => ({
  getByKey: jest.fn(),
  update: jest.fn()
}));

// Requirement 32.4 (task 54.4): the atomic upload routes call
// `fs.promises.mkdir`/`writeFile`/`rename`/`unlink` inside
// `atomicFileWrite`. Mocking `fs` at the module boundary (matching the
// existing `jest.mock('fs', ...)` pattern already used by
// `TakServerService.test.js`) lets these tests assert the exact
// tmp-write-then-rename sequence without touching the real filesystem.
jest.mock('fs', () => {
  const realFs = jest.requireActual('fs');
  return {
    ...realFs,
    promises: {
      ...realFs.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn().mockResolvedValue(undefined),
      rename: jest.fn().mockResolvedValue(undefined),
      unlink: jest.fn().mockResolvedValue(undefined)
    }
  };
});

const express = require('express');
const request = require('supertest');
const path = require('path');
const os = require('os');
const pool = require('../config/database');
const SiteConfig = require('../models/SiteConfig');
const fs = require('fs');
const settingsRouter = require('./settings');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  return app;
}

describe('GET/PUT /api/settings/branding', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
  });

  it('GET returns the current branding fields from site_config', async () => {
    SiteConfig.getByKey.mockImplementation((key) => {
      if (key === 'organization_display_name') {
        return Promise.resolve({ config_key: key, config_value: 'TAK Team Manager' });
      }
      if (key === 'organization_logo_path') {
        return Promise.resolve({ config_key: key, config_value: '' });
      }
      return Promise.resolve(undefined);
    });

    const res = await request(app).get('/api/settings/branding');

    expect(res.status).toBe(200);
    expect(res.body.branding).toEqual({
      organizationDisplayName: 'TAK Team Manager',
      organizationLogoPath: ''
    });
    expect(SiteConfig.getByKey).toHaveBeenCalledWith('organization_display_name');
    expect(SiteConfig.getByKey).toHaveBeenCalledWith('organization_logo_path');
  });

  it('GET defaults missing rows to an empty string rather than throwing', async () => {
    SiteConfig.getByKey.mockResolvedValue(undefined);

    const res = await request(app).get('/api/settings/branding');

    expect(res.status).toBe(200);
    expect(res.body.branding).toEqual({
      organizationDisplayName: '',
      organizationLogoPath: ''
    });
  });

  it('PUT updates organizationDisplayName via SiteConfig.update and returns the refreshed branding', async () => {
    SiteConfig.update.mockResolvedValue({ config_key: 'organization_display_name', config_value: 'Acme Response' });
    SiteConfig.getByKey.mockImplementation((key) => {
      if (key === 'organization_display_name') {
        return Promise.resolve({ config_key: key, config_value: 'Acme Response' });
      }
      return Promise.resolve({ config_key: key, config_value: '' });
    });

    const res = await request(app)
      .put('/api/settings/branding')
      .send({ organizationDisplayName: 'Acme Response' });

    expect(res.status).toBe(200);
    expect(SiteConfig.update).toHaveBeenCalledWith('organization_display_name', 'Acme Response', 1);
    expect(res.body.branding.organizationDisplayName).toBe('Acme Response');
  });

  it('PUT updates organizationLogoPath as a plain string reference, not a file upload', async () => {
    SiteConfig.update.mockResolvedValue({ config_key: 'organization_logo_path', config_value: '/uploads/logo.png' });
    SiteConfig.getByKey.mockImplementation((key) =>
      Promise.resolve({ config_key: key, config_value: key === 'organization_logo_path' ? '/uploads/logo.png' : '' })
    );

    const res = await request(app)
      .put('/api/settings/branding')
      .send({ organizationLogoPath: '/uploads/logo.png' });

    expect(res.status).toBe(200);
    expect(SiteConfig.update).toHaveBeenCalledWith('organization_logo_path', '/uploads/logo.png', 1);
    expect(res.body.branding.organizationLogoPath).toBe('/uploads/logo.png');
  });

  it('PUT returns 400 when neither field is supplied', async () => {
    const res = await request(app).put('/api/settings/branding').send({});

    expect(res.status).toBe(400);
    expect(SiteConfig.update).not.toHaveBeenCalled();
  });

  it('rejects a non-Global_Manager caller with 403 on GET and never reads site_config', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app).get('/api/settings/branding');

    expect(res.status).toBe(403);
    expect(SiteConfig.getByKey).not.toHaveBeenCalled();
  });

  it('rejects a non-Global_Manager caller with 403 on PUT and never writes site_config', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app)
      .put('/api/settings/branding')
      .send({ organizationDisplayName: 'Should Not Apply' });

    expect(res.status).toBe(403);
    expect(SiteConfig.update).not.toHaveBeenCalled();
  });
});

/**
 * `GET/PUT /api/settings/tak-server` (Requirement 32 Criterion 3, task
 * 54.3). Reuses this file's existing `pool.query` mock, `authenticateToken`
 * mock, and `mockUser` variable declared above.
 *
 * Covers:
 *  - GET tak-server success (reads from system_config, falls back to env).
 *  - GET never leaks a passphrase/key content in the response body.
 *  - PUT tak-server success (validates URL, persists via system_config upsert).
 *  - Unauthorized rejection (non-Global_Manager gets 403, no DB access).
 */
describe('/api/settings/tak-server authorization (Requirement 32.3)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('rejects a non-Global_Manager authenticated user on GET with 403 and never queries the database', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app).get('/api/settings/tak-server');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a non-Global_Manager authenticated user on PUT with 403 and never queries the database', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app)
      .put('/api/settings/tak-server')
      .send({ takServerUrl: 'https://tak.example.com' });

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('GET /api/settings/tak-server', () => {
  let app;
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns the effective configuration from system_config rows when present', async () => {
    pool.query.mockImplementation((sql, params) => {
      const key = params[0];
      const values = {
        tak_server_url: 'https://tak.example.com',
        tak_server_p12_path: '/certs/api.p12',
        tak_server_p12_passphrase: 'super-secret-passphrase',
        tak_server_cert_path: null,
        tak_server_key_path: null,
        tak_server_ca_path: '/certs/ca.pem'
      };
      const value = values[key];
      return Promise.resolve({ rows: value !== null && value !== undefined ? [{ config_value: value }] : [] });
    });

    const res = await request(app).get('/api/settings/tak-server');

    expect(res.status).toBe(200);
    expect(res.body.takServerUrl).toBe('https://tak.example.com');
    expect(res.body.credentialMode).toBe('p12');
    expect(res.body.p12.path).toBe('/certs/api.p12');
    expect(res.body.p12.passphraseSet).toBe(true);
    expect(res.body.caPath).toBe('/certs/ca.pem');
  });

  it('never returns the passphrase content, only a passphraseSet boolean', async () => {
    pool.query.mockImplementation((sql, params) => {
      const key = params[0];
      if (key === 'tak_server_p12_passphrase') {
        return Promise.resolve({ rows: [{ config_value: 'super-secret-passphrase' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get('/api/settings/tak-server');

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('super-secret-passphrase');
    expect(res.body.p12.passphraseSet).toBe(true);
    expect(res.body.p12.passphrase).toBeUndefined();
  });

  it('falls back to the live environment variable when no system_config row exists', async () => {
    process.env.TAK_SERVER_URL = 'https://env-fallback.example.com';
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/settings/tak-server');

    expect(res.status).toBe(200);
    expect(res.body.takServerUrl).toBe('https://env-fallback.example.com');
    expect(res.body.credentialMode).toBe('none');
  });

  it('reports credentialMode "cert_key" when only the cert/key pair is configured', async () => {
    pool.query.mockImplementation((sql, params) => {
      const key = params[0];
      const values = {
        tak_server_cert_path: '/certs/client.crt',
        tak_server_key_path: '/certs/client.key'
      };
      const value = values[key];
      return Promise.resolve({ rows: value ? [{ config_value: value }] : [] });
    });

    const res = await request(app).get('/api/settings/tak-server');

    expect(res.status).toBe(200);
    expect(res.body.credentialMode).toBe('cert_key');
    expect(res.body.certKey.certPath).toBe('/certs/client.crt');
    expect(res.body.certKey.keyPath).toBe('/certs/client.key');
  });
});

describe('PUT /api/settings/tak-server', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('updates takServerUrl when it is a well-formed URL', async () => {
    const res = await request(app)
      .put('/api/settings/tak-server')
      .send({ takServerUrl: 'https://tak.example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const upsertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO system_config'));
    expect(upsertCall[1][0]).toBe('tak_server_url');
    expect(upsertCall[1][1]).toBe('https://tak.example.com');
  });

  it('rejects a malformed takServerUrl with 400 and does not write to the database', async () => {
    const res = await request(app)
      .put('/api/settings/tak-server')
      .send({ takServerUrl: 'not-a-url' });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('allows clearing takServerUrl with an empty string', async () => {
    const res = await request(app)
      .put('/api/settings/tak-server')
      .send({ takServerUrl: '' });

    expect(res.status).toBe(200);
    const upsertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO system_config'));
    expect(upsertCall[1][1]).toBe('');
  });

  it('updates a plain path field (p12Path) without touching other fields', async () => {
    const res = await request(app)
      .put('/api/settings/tak-server')
      .send({ p12Path: '/new/path/api.p12' });

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const upsertCall = pool.query.mock.calls[0];
    expect(upsertCall[1][0]).toBe('tak_server_p12_path');
    expect(upsertCall[1][1]).toBe('/new/path/api.p12');
  });
});

/**
 * GET /api/settings/export (Requirement 32.5, task 54.5).
 *
 * `pool.query` is mocked at the data-access boundary, matching this
 * file's existing convention. `archiver`'s output is a real zip stream
 * (not mocked), so these tests capture the actual bytes streamed to the
 * HTTP response and unzip them to assert on the real archive contents --
 * this is the most reliable way to verify the passphrase is NEVER present
 * in the exported bytes, rather than only asserting on the SQL query
 * parameters (which could pass even if a bug later concatenated
 * unrelated data into the archive).
 */
describe('GET /api/settings/export', () => {
  let app;
  const AdmZip = require('adm-zip');

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
  });

  it('streams a zip with the correct headers containing only allow-listed settings and email_templates rows', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM system_config')) {
        return Promise.resolve({
          rows: [
            // A passphrase row should never be selected by this route's
            // query in the first place (it is not in the allow-list), but
            // this mock also proves that even if it *were* returned by a
            // buggy query, the test below inspects the real archive bytes.
            { config_key: 'tak_server_url', config_value: 'https://tak.example.com', description: null }
          ]
        });
      }
      if (sql.includes('FROM site_config')) {
        return Promise.resolve({
          rows: [
            { config_key: 'organization_display_name', config_value: 'Acme Response', description: null }
          ]
        });
      }
      if (sql.includes('FROM email_templates')) {
        return Promise.resolve({
          rows: [
            { template_key: 'welcome_email', subject_template: 'Welcome', body_template: 'Hi {{name}}', description: null }
          ]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get('/api/settings/export').buffer(true).parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="settings-export.zip"');

    const zip = new AdmZip(res.body);
    const entryNames = zip.getEntries().map((entry) => entry.entryName);
    expect(entryNames).toEqual(expect.arrayContaining(['settings.json', 'email_templates.json']));

    const settingsJson = JSON.parse(zip.readAsText('settings.json'));
    // CDK trim: system_config is no longer exported, so settings.json carries
    // only siteConfig and has no systemConfig key at all.
    expect(settingsJson.systemConfig).toBeUndefined();
    expect(settingsJson.siteConfig).toEqual(
      expect.arrayContaining([{ config_key: 'organization_display_name', config_value: 'Acme Response', description: null }])
    );

    const emailTemplatesJson = JSON.parse(zip.readAsText('email_templates.json'));
    expect(emailTemplatesJson).toEqual([
      { template_key: 'welcome_email', subject_template: 'Welcome', body_template: 'Hi {{name}}', description: null }
    ]);

    // The strongest guarantee that no TAK Server config (including the
    // passphrase) can leak into the archive: this route never queries
    // system_config at all.
    const systemConfigQuery = pool.query.mock.calls.find(([sql]) => sql.includes('FROM system_config'));
    expect(systemConfigQuery).toBeUndefined();
  });

  it('never queries system_config, so no tak_server_* value (incl. the passphrase) can reach the archive', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('FROM site_config')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM email_templates')) {
        return Promise.resolve({ rows: [] });
      }
      // A system_config read would be a bug under the CDK trim; return a
      // passphrase-bearing row so that, IF the route ever queried it, the
      // archive-bytes assertion below would catch the leak.
      if (sql.includes('FROM system_config')) {
        return Promise.resolve({
          rows: [{ config_key: 'tak_server_p12_passphrase', config_value: 'super-secret-passphrase', description: null }]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get('/api/settings/export').buffer(true).parse((response, callback) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);

    const zip = new AdmZip(res.body);
    const settingsJson = zip.readAsText('settings.json');
    const emailTemplatesJson = zip.readAsText('email_templates.json');

    // Neither the passphrase value nor any system_config content appears.
    expect(settingsJson).not.toContain('tak_server_p12_passphrase');
    expect(settingsJson).not.toContain('super-secret-passphrase');
    expect(emailTemplatesJson).not.toContain('tak_server_p12_passphrase');

    // The structural guarantee: system_config is never read by the export.
    const systemConfigQuery = pool.query.mock.calls.find(([sql]) => sql.includes('FROM system_config'));
    expect(systemConfigQuery).toBeUndefined();
  });

  it('rejects a non-Global_Manager caller with 403 and never queries the database', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app).get('/api/settings/export');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

/**
 * Atomic cert/key/logo file upload endpoints (Requirement 32.4, task
 * 54.4): `POST /api/settings/branding/logo`, `POST
 * /api/settings/tak-server/cert`, `POST /api/settings/tak-server/key`.
 *
 * `fs.promises` is mocked at the top of this file (see the `jest.mock`
 * block above), so `atomicFileWrite`'s tmp-write-then-rename sequence is
 * asserted against the mock's call arguments rather than the real
 * filesystem. `SiteConfig.update`/`pool.query` (via `setTakServerConfigValue`)
 * are mocked exactly as they are for the plain-string branding/tak-server
 * PUT routes above, since these upload routes reuse those exact same
 * persistence calls once the file itself has been written.
 */
describe('POST /api/settings/branding/logo', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
    SiteConfig.update.mockResolvedValue({ config_key: 'organization_logo_path', config_value: '/uploads/branding/whatever.png' });
    SiteConfig.getByKey.mockImplementation((key) =>
      Promise.resolve({ config_key: key, config_value: key === 'organization_logo_path' ? '/uploads/branding/whatever.png' : '' })
    );
  });

  it('writes the uploaded logo atomically (tmp file then rename, same directory) and updates organization_logo_path', async () => {
    const res = await request(app)
      .post('/api/settings/branding/logo')
      .attach('logo', Buffer.from('fake-png-bytes'), { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);

    // Requirement 32.4: written to a sibling tmp file first, then
    // renamed into place -- never written directly to the final path.
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    const [tmpPathArg, bufferArg] = fs.promises.writeFile.mock.calls[0];
    expect(tmpPathArg).toMatch(/\.tmp-[0-9a-f-]+$/);
    expect(Buffer.isBuffer(bufferArg)).toBe(true);

    expect(fs.promises.rename).toHaveBeenCalledTimes(1);
    const [renameFrom, renameTo] = fs.promises.rename.mock.calls[0];
    expect(renameFrom).toBe(tmpPathArg);
    // Same-directory rename, per Requirement 32.4's atomicity requirement.
    expect(path.dirname(renameFrom)).toBe(path.dirname(renameTo));
    expect(renameTo.endsWith('.png')).toBe(true);

    expect(SiteConfig.update).toHaveBeenCalledWith(
      'organization_logo_path',
      expect.stringMatching(/^\/uploads\/branding\/.+\.png$/),
      1
    );
    expect(res.body.branding.organizationLogoPath).toBe('/uploads/branding/whatever.png');
  });

  it('rejects an oversized logo upload with 400 and never writes any file', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);

    const res = await request(app)
      .post('/api/settings/branding/logo')
      .attach('logo', oversized, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
    expect(SiteConfig.update).not.toHaveBeenCalled();
  });

  it('rejects a disallowed MIME type with 400 and never writes any file', async () => {
    const res = await request(app)
      .post('/api/settings/branding/logo')
      .attach('logo', Buffer.from('not-an-image'), { filename: 'malware.exe', contentType: 'application/octet-stream' });

    expect(res.status).toBe(400);
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
    expect(SiteConfig.update).not.toHaveBeenCalled();
  });

  it('rejects a non-Global_Manager caller with 403 and never writes any file', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app)
      .post('/api/settings/branding/logo')
      .attach('logo', Buffer.from('fake-png-bytes'), { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
    expect(SiteConfig.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/tak-server/cert and /key', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('writes the uploaded cert atomically and updates tak_server_cert_path', async () => {
    const res = await request(app)
      .post('/api/settings/tak-server/cert')
      .attach('cert', Buffer.from('-----BEGIN CERTIFICATE-----'), { filename: 'client.crt', contentType: 'application/x-x509-ca-cert' });

    expect(res.status).toBe(200);
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.promises.rename).toHaveBeenCalledTimes(1);

    const upsertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO system_config'));
    expect(upsertCall[1][0]).toBe('tak_server_cert_path');
    expect(upsertCall[1][1]).toBe(res.body.certPath);
  });

  it('writes the uploaded key atomically and updates tak_server_key_path', async () => {
    const res = await request(app)
      .post('/api/settings/tak-server/key')
      .attach('key', Buffer.from('-----BEGIN PRIVATE KEY-----'), { filename: 'client.key', contentType: 'application/octet-stream' });

    expect(res.status).toBe(200);
    expect(fs.promises.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.promises.rename).toHaveBeenCalledTimes(1);

    const upsertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO system_config'));
    expect(upsertCall[1][0]).toBe('tak_server_key_path');
    expect(upsertCall[1][1]).toBe(res.body.keyPath);
  });

  it('rejects a non-Global_Manager caller with 403 on both routes and never writes any file', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const certRes = await request(app)
      .post('/api/settings/tak-server/cert')
      .attach('cert', Buffer.from('cert-bytes'), { filename: 'client.crt', contentType: 'application/x-x509-ca-cert' });
    const keyRes = await request(app)
      .post('/api/settings/tak-server/key')
      .attach('key', Buffer.from('key-bytes'), { filename: 'client.key', contentType: 'application/octet-stream' });

    expect(certRes.status).toBe(403);
    expect(keyRes.status).toBe(403);
    expect(fs.promises.writeFile).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

/**
 * POST /api/settings/import (Requirement 32.6, task 54.6).
 *
 * Unlike every other route in this file, this route applies its writes on
 * a single transactional client acquired via `pool.connect()` (mocked
 * below via a `buildMockClient` helper mirroring the convention already
 * used by `TeamMembershipService.test.js`/`GlobalChannelService.test.js`),
 * not the plain `pool.query` mock used by the rest of this file's tests.
 */
describe('POST /api/settings/import', () => {
  let app;

  function buildMockClient(queryImpl) {
    return {
      query: jest.fn(queryImpl || (() => Promise.resolve({ rows: [] }))),
      release: jest.fn()
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
  });

  it('applies a valid import atomically: BEGIN, one upsert per row, COMMIT, then releases the client', async () => {
    const mockClient = buildMockClient();
    pool.connect.mockResolvedValue(mockClient);

    const res = await request(app)
      .post('/api/settings/import')
      .send({
        siteConfig: [
          { config_key: 'organization_display_name', config_value: 'Acme Response' }
        ],
        emailTemplates: [
          { template_key: 'welcome_email', subject_template: 'Welcome', body_template: 'Hi {{name}}' }
        ]
      });

    expect(res.status).toBe(200);
    // CDK trim: no systemConfig in the response counts anymore.
    expect(res.body).toEqual({
      success: true,
      imported: { siteConfig: 1, emailTemplates: 1 }
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);

    // CDK trim: system_config is NEVER written by import anymore.
    const systemConfigUpsert = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO system_config')
    );
    expect(systemConfigUpsert).toBeUndefined();

    const siteConfigUpsert = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO site_config')
    );
    expect(siteConfigUpsert[1][0]).toBe('organization_display_name');
    expect(siteConfigUpsert[1][3]).toBe(1); // updated_by = req.user.userId

    const emailTemplateUpsert = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO email_templates')
    );
    expect(emailTemplateUpsert[1][0]).toBe('welcome_email');
  });

  it('ignores a legacy systemConfig array (does not reject it, and never writes system_config)', async () => {
    // CDK trim: an archive exported by an older version still carries a
    // systemConfig array. Import must tolerate it -- apply the still-relevant
    // siteConfig/emailTemplates, silently ignore systemConfig, and NEVER write
    // a system_config row (including a passphrase, were one present).
    const mockClient = buildMockClient();
    pool.connect.mockResolvedValue(mockClient);

    const res = await request(app)
      .post('/api/settings/import')
      .send({
        systemConfig: [
          { config_key: 'tak_server_url', config_value: 'https://tak.example.com' },
          { config_key: 'tak_server_p12_passphrase', config_value: 'super-secret' }
        ],
        siteConfig: [
          { config_key: 'organization_display_name', config_value: 'Acme Response' }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual({ siteConfig: 1, emailTemplates: 0 });

    const systemConfigUpsert = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO system_config')
    );
    expect(systemConfigUpsert).toBeUndefined();
    // The passphrase value never reaches any query parameter.
    const anyQueryWithPassphrase = mockClient.query.mock.calls.find(
      ([, params]) => Array.isArray(params) && params.includes('super-secret')
    );
    expect(anyQueryWithPassphrase).toBeUndefined();
  });

  it('accepts an import with no emailTemplates key, treating it as zero rows imported', async () => {
    const mockClient = buildMockClient();
    pool.connect.mockResolvedValue(mockClient);

    const res = await request(app)
      .post('/api/settings/import')
      .send({ siteConfig: [] });

    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual({ siteConfig: 0, emailTemplates: 0 });
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects the entire import when siteConfig contains a disallowed config_key, applying no changes', async () => {
    const res = await request(app)
      .post('/api/settings/import')
      .send({
        siteConfig: [
          { config_key: 'organization_display_name', config_value: 'Acme' },
          { config_key: 'not_an_allowed_site_key', config_value: 'x' }
        ]
      });

    expect(res.status).toBe(400);
    expect(res.body.problems.join(' ')).toContain('not_an_allowed_site_key');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects the entire import when a siteConfig row is malformed (missing config_value), applying no changes', async () => {
    const res = await request(app)
      .post('/api/settings/import')
      .send({
        siteConfig: [{ config_key: 'organization_display_name' }]
      });

    expect(res.status).toBe(400);
    expect(res.body.problems.length).toBeGreaterThan(0);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects the entire import when an emailTemplates row is malformed (missing body_template), applying no changes', async () => {
    const res = await request(app)
      .post('/api/settings/import')
      .send({
        siteConfig: [],
        emailTemplates: [{ template_key: 'welcome_email', subject_template: 'Welcome' }]
      });

    expect(res.status).toBe(400);
    expect(res.body.problems.join(' ')).toContain('emailTemplates[0]');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a missing/non-array siteConfig body with 400 and never opens a transaction', async () => {
    const res = await request(app)
      .post('/api/settings/import')
      .send({ siteConfig: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a legacy body whose systemConfig is present but not an array (broken file)', async () => {
    // A stray systemConfig is ignored when it's an array, but a non-array one
    // still signals a malformed file, so it is rejected.
    const res = await request(app)
      .post('/api/settings/import')
      .send({ siteConfig: [], systemConfig: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body.problems.join(' ')).toContain('systemConfig');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rolls back the entire transaction if a mid-loop database error occurs, applying no partial writes', async () => {
    const mockClient = buildMockClient((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO site_config')) {
        return Promise.reject(new Error('constraint violation'));
      }
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValue(mockClient);

    const res = await request(app)
      .post('/api/settings/import')
      .send({
        siteConfig: [{ config_key: 'organization_display_name', config_value: 'Acme' }]
      });

    expect(res.status).toBe(500);
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-Global_Manager caller with 403 and never opens a transaction', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app)
      .post('/api/settings/import')
      .send({ siteConfig: [] });

    expect(res.status).toBe(403);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

/**
 * `atomicFileWrite` against the REAL filesystem (task 54.8, Requirement
 * 32.4).
 *
 * Every `atomicFileWrite` test above (in the branding/tak-server upload
 * `describe` blocks) exercises `fs.promises` as a full mock, which proves
 * the CALL ORDER (writeFile against a `.tmp-<uuid>` path, then rename)
 * but never proves the atomicity guarantee itself, nor exercises the
 * function's own `catch` block's `unlink`-based tmp-file cleanup on a
 * failed write -- a mocked `rename` that always resolves can never take
 * that branch. These tests override this file's `fs` mock (declared at
 * the top of this file) with the REAL `fs.promises` implementations,
 * scoped to a throwaway `os.tmpdir()`-based directory created in
 * `beforeEach` and removed in `afterEach`, so:
 *
 *   1. A successful call leaves the final path holding the complete
 *      written content and leaves no `.tmp-*` file behind in the
 *      directory (rename MOVES the file -- there is nothing left to
 *      clean up on success).
 *   2. A call whose `rename` step fails (simulated by mocking only
 *      `fs.promises.rename` to reject, while `writeFile`/`mkdir`/`unlink`
 *      remain real) is cleaned up by `atomicFileWrite`'s own `catch`
 *      block: no orphaned `.tmp-*` file remains, and the final
 *      destination path is never created.
 */
describe('atomicFileWrite against the real filesystem (Requirement 32.4)', () => {
  const realFs = jest.requireActual('fs');
  const { atomicFileWrite } = require('./settings');
  let tempDir;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = await realFs.promises.mkdtemp(path.join(os.tmpdir(), 'settings-atomic-write-test-'));
    // Route every fs.promises call atomicFileWrite makes through to the
    // REAL implementation for this describe block only; the module-level
    // jest.mock('fs', ...) at the top of this file otherwise leaves these
    // as no-op jest.fn()s that never touch disk.
    fs.promises.mkdir.mockImplementation(realFs.promises.mkdir);
    fs.promises.writeFile.mockImplementation(realFs.promises.writeFile);
    fs.promises.rename.mockImplementation(realFs.promises.rename);
    fs.promises.unlink.mockImplementation(realFs.promises.unlink);
  });

  afterEach(async () => {
    await realFs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('leaves the final path with the complete content and no leftover tmp file after a successful write', async () => {
    const destinationPath = path.join(tempDir, 'cert.pem');
    const content = Buffer.from('-----BEGIN CERTIFICATE-----\nreal-file-content\n-----END CERTIFICATE-----');

    await atomicFileWrite(destinationPath, content);

    const writtenContent = await realFs.promises.readFile(destinationPath);
    expect(writtenContent.equals(content)).toBe(true);

    const entries = await realFs.promises.readdir(tempDir);
    const tmpEntries = entries.filter((name) => name.includes('.tmp-'));
    expect(tmpEntries).toEqual([]);
  });

  it('cleans up the orphaned tmp file and never creates the final path when rename fails', async () => {
    const destinationPath = path.join(tempDir, 'key.pem');
    const content = Buffer.from('-----BEGIN PRIVATE KEY-----\nshould-never-land\n-----END PRIVATE KEY-----');

    fs.promises.rename.mockImplementation(() => Promise.reject(new Error('simulated rename failure')));

    await expect(atomicFileWrite(destinationPath, content)).rejects.toThrow('simulated rename failure');

    const entries = await realFs.promises.readdir(tempDir);
    const tmpEntries = entries.filter((name) => name.includes('.tmp-'));
    expect(tmpEntries).toEqual([]);

    const destinationExists = await realFs.promises.access(destinationPath).then(() => true).catch(() => false);
    expect(destinationExists).toBe(false);
  });
});

/**
 * `TAK_ROLE_VALUES` export (task 27.1, Requirement 13.4): the flat
 * allow-list of TAK_Role display values, derived from `ROLE_KEY_LABELS`,
 * for later Member_List/CSV-import `TAK_Role` edit validation to reuse.
 */
describe('TAK_ROLE_VALUES export', () => {
  it('is an array equal to Object.values(ROLE_KEY_LABELS)', () => {
    const { TAK_ROLE_VALUES, ROLE_KEY_LABELS } = require('./settings');

    expect(Array.isArray(TAK_ROLE_VALUES)).toBe(true);
    expect(TAK_ROLE_VALUES).toEqual(Object.values(ROLE_KEY_LABELS));
  });

  it('contains every expected TAK_Role display label', () => {
    const { TAK_ROLE_VALUES } = require('./settings');

    expect(TAK_ROLE_VALUES).toEqual([
      'Team Member',
      'Team Lead',
      'Sniper',
      'Medic',
      'Forward Observer',
      'RTO',
      'K9',
      'HQ'
    ]);
  });
});
