/**
 * Integration tests for `server/routes/communications.js` (Requirement
 * 30 Criterion 4, task 52.2).
 *
 * `authenticateToken` is mocked to bypass real JWT verification, but the
 * REAL `authorize.js` middleware and `permissions.registry.js` are used
 * (not mocked), matching the convention already established by
 * `server/routes/settings.test.js`: every test sets
 * `req.user.is_global_manager` explicitly, so the authorization outcome
 * for each request is exercised for real rather than assumed.
 *
 * `pool.query` is mocked at the data-access boundary (`../config/database`),
 * following the same pattern already used by `server/routes/settings.test.js`.
 *
 * Covers (per task 52.2's scope): GET existing template (success), GET
 * nonexistent key (404), PUT updates fields successfully, PUT on
 * nonexistent key (404), and unauthorized (non-Global_Manager) rejection
 * for both routes.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

let mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

// `POST /api/communications/test-email` (task 52.3): `EmailService` is
// mocked at the class-method boundary so the route's `sendEmail` calls can
// be asserted without ever making a real AWS SES call. Declared here,
// before `require('./communications')` below, since `jest.mock` factories
// are hoisted above imports but must not reference a `const` declared
// later in module-evaluation order (that would hit the `mockSendEmail`
// temporal-dead-zone otherwise).
const mockSendEmail = jest.fn();
jest.mock('../services/EmailService', () => {
  return jest.fn().mockImplementation(() => ({
    sendEmail: mockSendEmail
  }));
});

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const communicationsRouter = require('./communications');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/communications', communicationsRouter);
  return app;
}

describe('GET /api/communications/templates', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
  });

  it('returns every template row as { templates: [...] } for a Global_Manager', async () => {
    const rows = [
      {
        template_key: 'access_request_approved',
        subject_template: 'Approved',
        body_template: 'You are approved {{first_name}}',
        description: 'Sent when a request is approved',
        updated_at: '2024-01-02T00:00:00.000Z'
      },
      {
        template_key: 'access_request_verification',
        subject_template: 'Verify your TAK Team Manager access request',
        body_template: 'Please click {{verification_link}}',
        description: 'Sent when a new access request is submitted',
        updated_at: '2024-01-01T00:00:00.000Z'
      }
    ];
    pool.query.mockResolvedValue({ rows });

    const res = await request(app).get('/api/communications/templates');

    expect(res.status).toBe(200);
    expect(res.body.templates).toEqual(rows);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM email_templates');
    expect(sql).toContain('ORDER BY template_key');
  });

  it('returns 500 with an error body when the query rejects', async () => {
    pool.query.mockRejectedValue(new Error('DB unreachable'));

    const res = await request(app).get('/api/communications/templates');

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  it('rejects a non-Global_Manager caller with 403 and never queries email_templates', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app).get('/api/communications/templates');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('GET /api/communications/templates/:key', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
  });

  it('returns the template row when it exists', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        template_key: 'access_request_verification',
        subject_template: 'Verify your TAK Team Manager access request',
        body_template: 'Please click {{verification_link}}',
        description: 'Sent when a new access request is submitted',
        updated_at: '2024-01-01T00:00:00.000Z'
      }]
    });

    const res = await request(app).get('/api/communications/templates/access_request_verification');

    expect(res.status).toBe(200);
    expect(res.body.template.template_key).toBe('access_request_verification');
    expect(res.body.template.subject_template).toBe('Verify your TAK Team Manager access request');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('FROM email_templates');
    expect(params).toEqual(['access_request_verification']);
  });

  it('returns 404 when no template with that key exists', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/communications/templates/does_not_exist');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/does_not_exist/);
  });

  it('rejects a non-Global_Manager caller with 403 and never queries email_templates', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app).get('/api/communications/templates/access_request_verification');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('PUT /api/communications/templates/:key', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
  });

  it('updates subject_template and body_template and returns the refreshed row', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        template_key: 'access_request_verification',
        subject_template: 'New subject',
        body_template: 'New body {{verification_link}}',
        description: 'Sent when a new access request is submitted',
        updated_at: '2024-02-01T00:00:00.000Z'
      }]
    });

    const res = await request(app)
      .put('/api/communications/templates/access_request_verification')
      .send({ subjectTemplate: 'New subject', bodyTemplate: 'New body {{verification_link}}' });

    expect(res.status).toBe(200);
    expect(res.body.template.subject_template).toBe('New subject');
    expect(res.body.template.body_template).toBe('New body {{verification_link}}');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('UPDATE email_templates');
    expect(sql).toContain('COALESCE');
    expect(params).toEqual(['New subject', 'New body {{verification_link}}', 1, 'access_request_verification']);
  });

  it('accepts a partial update of only subjectTemplate', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        template_key: 'access_request_verification',
        subject_template: 'Only subject changed',
        body_template: 'Unchanged body',
        description: null,
        updated_at: '2024-02-01T00:00:00.000Z'
      }]
    });

    const res = await request(app)
      .put('/api/communications/templates/access_request_verification')
      .send({ subjectTemplate: 'Only subject changed' });

    expect(res.status).toBe(200);
    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual(['Only subject changed', null, 1, 'access_request_verification']);
  });

  it('returns 404 when no template with that key exists', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .put('/api/communications/templates/does_not_exist')
      .send({ subjectTemplate: 'New subject' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/does_not_exist/);
  });

  it('rejects an empty-string subjectTemplate with 400 and does not query the database', async () => {
    const res = await request(app)
      .put('/api/communications/templates/access_request_verification')
      .send({ subjectTemplate: '' });

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 400 when neither field is supplied', async () => {
    const res = await request(app)
      .put('/api/communications/templates/access_request_verification')
      .send({});

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a non-Global_Manager caller with 403 and never writes email_templates', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app)
      .put('/api/communications/templates/access_request_verification')
      .send({ subjectTemplate: 'Should not apply' });

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

/**
 * `POST /api/communications/test-email` (Requirement 30.5, task 52.3).
 *
 * `EmailService.sendEmail` is mocked at the class-method boundary (see
 * the `jest.mock('../services/EmailService', ...)` declaration near the
 * top of this file) -- this route is a thin HTTP wrapper that must call
 * `sendEmail` directly and map its outcome to an HTTP response, not
 * re-implement email delivery.
 *
 * Covers: successful test email send (default template key), an explicit
 * `templateKey`/`variables` override, invalid/missing `targetEmail`
 * rejected with 400, an `EmailService.sendEmail` rejection surfaced as
 * 500, and unauthorized (non-Global_Manager) rejection.
 */
describe('POST /api/communications/test-email', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 'authentik-1', userId: 1, is_global_manager: true };
    app = buildApp();
  });

  it('sends a test email to the target address using the default template key', async () => {
    mockSendEmail.mockResolvedValue({ MessageId: 'msg-1' });

    const res = await request(app)
      .post('/api/communications/test-email')
      .send({ targetEmail: 'admin@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.targetEmail).toBe('admin@example.com');
    expect(mockSendEmail).toHaveBeenCalledWith('admin@example.com', 'admin_notification_digest', {});
  });

  it('honors an explicit templateKey/variables override', async () => {
    mockSendEmail.mockResolvedValue({ MessageId: 'msg-2' });

    const res = await request(app)
      .post('/api/communications/test-email')
      .send({
        targetEmail: 'admin@example.com',
        templateKey: 'access_request_approved',
        variables: { admin_name: 'Alice' }
      });

    expect(res.status).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledWith('admin@example.com', 'access_request_approved', { admin_name: 'Alice' });
  });

  it('rejects a missing targetEmail with 400 and never calls sendEmail', async () => {
    const res = await request(app).post('/api/communications/test-email').send({});

    expect(res.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('rejects a malformed targetEmail with 400 and never calls sendEmail', async () => {
    const res = await request(app)
      .post('/api/communications/test-email')
      .send({ targetEmail: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('surfaces an EmailService/SES failure as a 500', async () => {
    mockSendEmail.mockRejectedValue(new Error('SES unreachable'));

    const res = await request(app)
      .post('/api/communications/test-email')
      .send({ targetEmail: 'admin@example.com' });

    expect(res.status).toBe(500);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-Global_Manager caller with 403 and never calls sendEmail', async () => {
    mockUser = { id: 'authentik-2', userId: 2, is_global_manager: false };

    const res = await request(app)
      .post('/api/communications/test-email')
      .send({ targetEmail: 'admin@example.com' });

    expect(res.status).toBe(403);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

