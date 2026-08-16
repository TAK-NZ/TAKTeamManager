/**
 * Integration tests for the shared `textField` sanitization chain applied
 * to `POST /api/requests/team-access` (Requirements 5.7, 5.8).
 *
 * These exercise the actual mounted route via `supertest` rather than the
 * `textField` factory in isolation (already covered by
 * `server/middleware/validators.test.js`), so they verify the specific
 * field names (`firstName`, `lastName`, `reason`) are wired up correctly,
 * that a too-long value is rejected with 400 and the field's name in the
 * error response, and that HTML-significant characters are escaped in the
 * value that would be persisted.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

jest.mock('../models/Team', () => ({
  findById: jest.fn()
}));

jest.mock('axios');

const mockCreateAccessRequest = jest.fn();
jest.mock('../services/RequestApprovalService', () => {
  return jest.fn().mockImplementation(() => ({
    createAccessRequest: mockCreateAccessRequest
  }));
});

const express = require('express');
const request = require('supertest');
const axios = require('axios');
const pool = require('../config/database');
const Team = require('../models/Team');
const requestsRouter = require('./requests');
const {
  requestAccessLimiterStore,
  REQUEST_ACCESS_LIMITER_MAX,
  EMAIL_WINDOW_LIMITER_MAX
} = require('../middleware/rateLimiters');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/requests', requestsRouter);
  return app;
}

/**
 * Builds a mock transactional client for `emailWindowLimiter`'s
 * `pool.connect()` call, matching the `BEGIN` / `SELECT ... FOR UPDATE` /
 * `UPDATE` or `INSERT` / `COMMIT` sequence in
 * `server/middleware/rateLimiters.js`.
 *
 * @param {{ existingCount?: number }} [options] - When `existingCount` is
 *   set, the mocked `SELECT` returns one existing window row with that
 *   count; when unset, the mocked `SELECT` returns no rows (no active
 *   window yet), so the middleware inserts a fresh one.
 */
function buildMockEmailWindowClient({ existingCount } = {}) {
  const client = {
    query: jest.fn(),
    release: jest.fn()
  };

  client.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('SELECT id, count FROM email_rate_tracking')) {
      if (existingCount === undefined) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [{ id: 1, count: existingCount }] });
    }
    // BEGIN / COMMIT / ROLLBACK / UPDATE / INSERT all just need to resolve.
    return Promise.resolve({ rows: [] });
  });

  return client;
}

const VALID_BODY = {
  email: 'vendor@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  teamId: 1,
  reason: 'Requesting access to support the upcoming exercise deployment.',
  'g-recaptcha-response': 'valid-captcha-token'
};

describe('POST /api/requests/team-access field sanitization', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    requestAccessLimiterStore.resetAll();
    Team.findById.mockResolvedValue({ id: 1, can_join: true, visibility: 'public' });
    mockCreateAccessRequest.mockResolvedValue({ requestId: 42, token: 'tok' });
    // Default: no existing email_rate_tracking window, so emailWindowLimiter
    // inserts a fresh row and calls next() for every test in this describe
    // block unless a test overrides `pool.connect` itself.
    pool.connect.mockResolvedValue(buildMockEmailWindowClient());
    // Default: reCAPTCHA v3 verification succeeds with a passing action
    // and score, so these field-sanitization tests exercise the
    // validator chain, not the CAPTCHA middleware (which has its own
    // dedicated describe block below).
    axios.post.mockResolvedValue({
      data: { success: true, action: 'team_access_request', score: 0.9 }
    });
    app = buildApp();
  });

  it('accepts a request with valid field lengths', async () => {
    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
  });

  it.each(['firstName', 'lastName'])(
    'rejects %s exceeding the 255-character schema-matched max length, without persisting it',
    async (field) => {
      const res = await request(app)
        .post('/api/requests/team-access')
        .send({ ...VALID_BODY, [field]: 'a'.repeat(256) });

      expect(res.status).toBe(400);
      expect(res.body.errors.some((e) => e.path === field)).toBe(true);
      expect(mockCreateAccessRequest).not.toHaveBeenCalled();
    }
  );

  it('rejects reason exceeding its 500-character max length, without persisting it', async () => {
    const res = await request(app)
      .post('/api/requests/team-access')
      .send({ ...VALID_BODY, reason: 'a'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e) => e.path === 'reason')).toBe(true);
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('still enforces the pre-existing reason min length of 10 characters', async () => {
    const res = await request(app)
      .post('/api/requests/team-access')
      .send({ ...VALID_BODY, reason: 'too short' });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e) => e.path === 'reason')).toBe(true);
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('still enforces the pre-existing firstName/lastName non-empty (min 1) constraint', async () => {
    const res = await request(app)
      .post('/api/requests/team-access')
      .send({ ...VALID_BODY, firstName: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.errors.some((e) => e.path === 'firstName')).toBe(true);
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('HTML-escapes significant characters in firstName/lastName/reason before they reach the handler', async () => {
    const res = await request(app).post('/api/requests/team-access').send({
      ...VALID_BODY,
      firstName: '<script>alert(1)</script>',
      lastName: 'O\'Brien & Co',
      reason: '<b>Reason</b> with "quotes" & <script>evil()</script> content here.'
    });

    expect(res.status).toBe(200);
    expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);

    const persistedArg = mockCreateAccessRequest.mock.calls[0][0];
    expect(persistedArg.requester_first_name).not.toContain('<script>');
    expect(persistedArg.requester_first_name).toBe(
      '&lt;script&gt;alert(1)&lt;&#x2F;script&gt;'
    );
    // `.escape()` HTML-encodes `&` itself, so `O'Brien & Co` becomes
    // `O&#x27;Brien &amp; Co` - the raw apostrophe/ampersand characters are
    // gone, replaced by their escaped entity forms.
    expect(persistedArg.requester_last_name).toBe('O&#x27;Brien &amp; Co');
    expect(persistedArg.justification).not.toContain('<script>');
    expect(persistedArg.justification).not.toContain('<b>');
  });
});

/**
 * Integration tests for `requestAccessLimiter` (Requirement 7.1, 20
 * requests/IP/15min) and `emailWindowLimiter` (Requirement 7.2, 5
 * requests/submitted-email/60min) mounted on
 * `POST /api/requests/team-access` and `GET /api/requests/verify/:token`.
 */
describe('requestAccessLimiter and emailWindowLimiter (Requirements 7.1, 7.2)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    requestAccessLimiterStore.resetAll();
    Team.findById.mockResolvedValue({ id: 1, can_join: true, visibility: 'public' });
    mockCreateAccessRequest.mockResolvedValue({ requestId: 42, token: 'tok' });
    pool.connect.mockResolvedValue(buildMockEmailWindowClient());
    axios.post.mockResolvedValue({
      data: { success: true, action: 'team_access_request', score: 0.9 }
    });
    app = buildApp();
  });

  describe('requestAccessLimiter (per-IP) on POST /team-access', () => {
    it('allows requests up to the configured limit and rejects the one after it with 429', async () => {
      for (let i = 0; i < REQUEST_ACCESS_LIMITER_MAX; i++) {
        const res = await request(app)
          .post('/api/requests/team-access')
          .send({ ...VALID_BODY, email: `user${i}@example.com` });
        expect(res.status).toBe(200);
      }

      const limitedRes = await request(app)
        .post('/api/requests/team-access')
        .send({ ...VALID_BODY, email: 'onemore@example.com' });

      expect(limitedRes.status).toBe(429);
      // The 21st request never reaches the handler, so no access request
      // is created and no verification email is sent for it.
      expect(mockCreateAccessRequest).toHaveBeenCalledTimes(REQUEST_ACCESS_LIMITER_MAX);
    });
  });

  describe('requestAccessLimiter (per-IP) on GET /verify/:token', () => {
    it('allows requests up to the configured limit and rejects the one after it with 429', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      for (let i = 0; i < REQUEST_ACCESS_LIMITER_MAX; i++) {
        const res = await request(app).get(`/api/requests/verify/tok-${i}`);
        // Not asserting a specific success status here since verifyEmail's
        // internals aren't mocked in this describe block -- only that the
        // request isn't rate-limited (i.e. not 429).
        expect(res.status).not.toBe(429);
      }

      const limitedRes = await request(app).get('/api/requests/verify/tok-extra');
      expect(limitedRes.status).toBe(429);
    });
  });

  describe('emailWindowLimiter (per-email) on POST /team-access', () => {
    it('rejects with 429 once the email has already reached the 5/60min limit, without creating an access request', async () => {
      pool.connect.mockResolvedValue(
        buildMockEmailWindowClient({ existingCount: EMAIL_WINDOW_LIMITER_MAX })
      );

      const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

      expect(res.status).toBe(429);
      expect(mockCreateAccessRequest).not.toHaveBeenCalled();
    });

    it('allows the request through and increments the count when under the limit', async () => {
      const client = buildMockEmailWindowClient({ existingCount: EMAIL_WINDOW_LIMITER_MAX - 1 });
      pool.connect.mockResolvedValue(client);

      const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

      expect(res.status).toBe(200);
      expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
      const updateCall = client.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE email_rate_tracking SET count = count + 1')
      );
      expect(updateCall).toBeDefined();
    });

    it('does not increment the count further when the limit has already been exceeded', async () => {
      const client = buildMockEmailWindowClient({ existingCount: EMAIL_WINDOW_LIMITER_MAX });
      pool.connect.mockResolvedValue(client);

      await request(app).post('/api/requests/team-access').send(VALID_BODY);

      const updateCall = client.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE email_rate_tracking SET count = count + 1')
      );
      expect(updateCall).toBeUndefined();
    });

    it('does not apply the per-email limiter to GET /verify/:token (no submitted email on that route)', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      // pool.connect (used only by emailWindowLimiter) should never be
      // invoked for this route, since emailWindowLimiter is not mounted
      // on it.
      const res = await request(app).get('/api/requests/verify/some-token');

      expect(res.status).not.toBe(429);
      expect(pool.connect).not.toHaveBeenCalled();
    });
  });

  describe('requests under both limits succeed normally', () => {
    it('succeeds when well under both the per-IP and per-email limits', async () => {
      const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

      expect(res.status).toBe(200);
      expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * Integration tests for `verifyCaptcha` (Requirements 7.3, 7.4) mounted on
 * `POST /api/requests/team-access`, in front of the express-validator
 * chain and `emailWindowLimiter`. Covers reCAPTCHA v3's specific
 * verification shape: `success`, `action` (anti-replay), and `score`
 * (risk threshold) -- not just a v2-style pass/fail.
 */
describe('verifyCaptcha (reCAPTCHA v3) on POST /team-access (Requirements 7.3, 7.4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    requestAccessLimiterStore.resetAll();
    Team.findById.mockResolvedValue({ id: 1, can_join: true, visibility: 'public' });
    mockCreateAccessRequest.mockResolvedValue({ requestId: 42, token: 'tok' });
    pool.connect.mockResolvedValue(buildMockEmailWindowClient());
    app = buildApp();
  });

  it('rejects with 400 when the CAPTCHA token is missing, without calling the verify API or creating an access request', async () => {
    const { 'g-recaptcha-response': _omit, ...bodyWithoutToken } = VALID_BODY;

    const res = await request(app).post('/api/requests/team-access').send(bodyWithoutToken);

    expect(res.status).toBe(400);
    expect(axios.post).not.toHaveBeenCalled();
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the CAPTCHA verify call reports success: false, without creating an access request', async () => {
    axios.post.mockResolvedValue({ data: { success: false } });

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the returned action does not match the expected action, without creating an access request', async () => {
    axios.post.mockResolvedValue({
      data: { success: true, action: 'some_other_action', score: 0.9 }
    });

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the returned score is below the minimum threshold, without creating an access request', async () => {
    axios.post.mockResolvedValue({
      data: { success: true, action: 'team_access_request', score: 0.1 }
    });

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('rejects with 400 when the CAPTCHA verify call itself throws/times out, without creating an access request', async () => {
    axios.post.mockRejectedValue(new Error('timeout of 10000ms exceeded'));

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('proceeds to the validators/handler when the CAPTCHA token is valid, the action matches, and the score is at/above the minimum threshold', async () => {
    axios.post.mockResolvedValue({
      data: { success: true, action: 'team_access_request', score: 0.9 }
    });

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the score is exactly at the default minimum threshold (0.5)', async () => {
    axios.post.mockResolvedValue({
      data: { success: true, action: 'team_access_request', score: 0.5 }
    });

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
  });
});
