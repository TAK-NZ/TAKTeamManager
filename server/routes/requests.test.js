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
  findById: jest.fn(),
  getJoinableTeams: jest.fn(),
  getAncestorChain: jest.fn()
}));

jest.mock('../models/User', () => ({
  getTeamMemberships: jest.fn()
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 'authentik-1', userId: 1, is_global_manager: false };
    next();
  }
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

jest.mock('axios');

const mockCreateAccessRequest = jest.fn();
const mockApproveRequest = jest.fn();
jest.mock('../services/RequestApprovalService', () => {
  return jest.fn().mockImplementation(() => ({
    createAccessRequest: mockCreateAccessRequest,
    approveRequest: mockApproveRequest
  }));
});

const express = require('express');
const request = require('supertest');
const axios = require('axios');
const pool = require('../config/database');
const Team = require('../models/Team');
const User = require('../models/User');
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
    Team.getJoinableTeams.mockResolvedValue([{ id: 1, name: 'Team', visibility: 'public' }]);
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);
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
 * Integration tests for the joinable-team check on
 * `POST /api/requests/team-access` (Requirement 7.4).
 *
 * The route resolves joinability via `Team.getJoinableTeams()` (the same
 * method Requirement 7.1/7.2 use to exclude a private-branch-cascaded
 * Team) rather than a plain `Team.findById` lookup, so a Team that is
 * `can_join`/`public` on its own row but has a `private` ancestor is
 * rejected identically to a Team that is not found at all.
 */
describe('POST /api/requests/team-access joinable-team check (Requirement 7.4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    requestAccessLimiterStore.resetAll();
    mockCreateAccessRequest.mockResolvedValue({ requestId: 42, token: 'tok' });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);
    pool.connect.mockResolvedValue(buildMockEmailWindowClient());
    axios.post.mockResolvedValue({
      data: { success: true, action: 'team_access_request', score: 0.9 }
    });
    app = buildApp();
  });

  it('rejects with 400 "Team is not available for joining" when the target team has a private ancestor (excluded from getJoinableTeams even though can_join/public on its own row)', async () => {
    // Regression test: `Team.getJoinableTeams()` already excludes this
    // Team (per its own private-ancestor `NOT EXISTS` clause), so it
    // simply never appears in the list returned here - the route must
    // not fall back to a plain `findById`-style own-row check that would
    // incorrectly accept it.
    Team.getJoinableTeams.mockResolvedValue([]);

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Team is not available for joining');
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('rejects with 400 "Team is not available for joining" when the target team does not exist at all', async () => {
    Team.getJoinableTeams.mockResolvedValue([
      { id: 999, name: 'Some other team', visibility: 'public' }
    ]);

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Team is not available for joining');
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('succeeds when the target team is present in getJoinableTeams (genuinely joinable, no private ancestor)', async () => {
    Team.getJoinableTeams.mockResolvedValue([
      { id: 1, name: 'Joinable Team', visibility: 'public' }
    ]);

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
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
    Team.getJoinableTeams.mockResolvedValue([{ id: 1, name: 'Team', visibility: 'public' }]);
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);
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
    Team.getJoinableTeams.mockResolvedValue([{ id: 1, name: 'Team', visibility: 'public' }]);
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);
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

  it('every rejection path returns a specific, non-generic error message (not just "CAPTCHA verification failed")', async () => {
    const { 'g-recaptcha-response': _omit, ...bodyWithoutToken } = VALID_BODY;
    const missingTokenRes = await request(app).post('/api/requests/team-access').send(bodyWithoutToken);
    expect(missingTokenRes.body.error).toMatch(/no CAPTCHA challenge was submitted/i);

    axios.post.mockResolvedValue({ data: { success: false } });
    const failedRes = await request(app).post('/api/requests/team-access').send(VALID_BODY);
    expect(failedRes.body.error).toMatch(/reload the page/i);

    axios.post.mockResolvedValue({ data: { success: true, action: 'wrong_action', score: 0.9 } });
    const actionRes = await request(app).post('/api/requests/team-access').send(VALID_BODY);
    expect(actionRes.body.error).toMatch(/does not match this form/i);

    axios.post.mockResolvedValue({ data: { success: true, action: 'team_access_request', score: 0.1 } });
    const scoreRes = await request(app).post('/api/requests/team-access').send(VALID_BODY);
    expect(scoreRes.body.error).toMatch(/flagged as likely automated/i);

    axios.post.mockRejectedValue(new Error('timeout of 10000ms exceeded'));
    const timeoutRes = await request(app).post('/api/requests/team-access').send(VALID_BODY);
    expect(timeoutRes.body.error).toMatch(/could not reach the CAPTCHA verification service/i);
  });
});

/**
 * Regression tests for the RECAPTCHA_DISABLED testing-only bypass
 * (isRecaptchaDisabledForTesting in server/middleware/captcha.js).
 * Verifies the bypass actually skips the CAPTCHA check end-to-end on the
 * mounted route, AND -- most importantly -- that it is HARD-DISABLED
 * whenever NODE_ENV=production regardless of the RECAPTCHA_DISABLED
 * value, so it can never accidentally leave the production CAPTCHA check
 * disabled.
 */
describe('RECAPTCHA_DISABLED testing-only bypass on POST /team-access', () => {
  let app;
  const ORIGINAL_ENV = { NODE_ENV: process.env.NODE_ENV, RECAPTCHA_DISABLED: process.env.RECAPTCHA_DISABLED };

  beforeEach(() => {
    jest.clearAllMocks();
    requestAccessLimiterStore.resetAll();
    Team.getJoinableTeams.mockResolvedValue([{ id: 1, name: 'Team', visibility: 'public' }]);
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);
    mockCreateAccessRequest.mockResolvedValue({ requestId: 42, token: 'tok' });
    pool.connect.mockResolvedValue(buildMockEmailWindowClient());
    app = buildApp();
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
    process.env.RECAPTCHA_DISABLED = ORIGINAL_ENV.RECAPTCHA_DISABLED;
  });

  it('skips the CAPTCHA check entirely (no token required, no verify API call) when RECAPTCHA_DISABLED=true and NODE_ENV is not production', async () => {
    process.env.NODE_ENV = 'test';
    process.env.RECAPTCHA_DISABLED = 'true';
    const { 'g-recaptcha-response': _omit, ...bodyWithoutToken } = VALID_BODY;

    const res = await request(app).post('/api/requests/team-access').send(bodyWithoutToken);

    expect(res.status).toBe(200);
    expect(axios.post).not.toHaveBeenCalled();
    expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
  });

  it('still enforces the CAPTCHA check when NODE_ENV=production, even if RECAPTCHA_DISABLED=true', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RECAPTCHA_DISABLED = 'true';
    const { 'g-recaptcha-response': _omit, ...bodyWithoutToken } = VALID_BODY;

    const res = await request(app).post('/api/requests/team-access').send(bodyWithoutToken);

    expect(res.status).toBe(400);
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('still enforces the CAPTCHA check when RECAPTCHA_DISABLED is unset/false, regardless of NODE_ENV', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.RECAPTCHA_DISABLED;
    const { 'g-recaptcha-response': _omit, ...bodyWithoutToken } = VALID_BODY;

    const res = await request(app).post('/api/requests/team-access').send(bodyWithoutToken);

    expect(res.status).toBe(400);
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });
});

/**
 * Integration tests for the conditionally-required `callsignSuffix` field
 * on `POST /api/requests/team-access` (Requirements 11.9, 11.10).
 *
 * The target Team's Organisation's `callsign_name_format` is resolved via
 * `Team.getAncestorChain(teamId)` (root-first, so index 0 is always the
 * Organisation), AFTER the existing joinability check passes.
 */
describe('POST /api/requests/team-access callsignSuffix handling (Requirements 11.9, 11.10)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    requestAccessLimiterStore.resetAll();
    Team.getJoinableTeams.mockResolvedValue([{ id: 1, name: 'Team', visibility: 'public' }]);
    mockCreateAccessRequest.mockResolvedValue({ requestId: 42, token: 'tok' });
    pool.connect.mockResolvedValue(buildMockEmailWindowClient());
    axios.post.mockResolvedValue({
      data: { success: true, action: 'team_access_request', score: 0.9 }
    });
    app = buildApp();
  });

  it('rejects with 400 when callsignSuffix is omitted and the target Organisation format is user_defined', async () => {
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'user_defined' }]);

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('callsignSuffix is required for this team');
    expect(mockCreateAccessRequest).not.toHaveBeenCalled();
  });

  it('succeeds and stores the submitted callsignSuffix when the target Organisation format is user_defined', async () => {
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'user_defined' }]);

    const res = await request(app)
      .post('/api/requests/team-access')
      .send({ ...VALID_BODY, callsignSuffix: 'J.Doe' });

    expect(res.status).toBe(200);
    expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
    expect(mockCreateAccessRequest.mock.calls[0][0].callsign_suffix).toBe('J.Doe');
  });

  it('succeeds with callsign_suffix: null when callsignSuffix is omitted and the target Organisation format is not user_defined', async () => {
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);

    const res = await request(app).post('/api/requests/team-access').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
    expect(mockCreateAccessRequest.mock.calls[0][0].callsign_suffix).toBeNull();
  });

  it('succeeds and stores a submitted callsignSuffix even when the target Organisation format is not user_defined', async () => {
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);

    const res = await request(app)
      .post('/api/requests/team-access')
      .send({ ...VALID_BODY, callsignSuffix: 'Badge123' });

    expect(res.status).toBe(200);
    expect(mockCreateAccessRequest).toHaveBeenCalledTimes(1);
    expect(mockCreateAccessRequest.mock.calls[0][0].callsign_suffix).toBe('Badge123');
  });
});

/**
 * Integration tests for `POST /api/requests/:requestId/approve`'s optional
 * `callsignSuffix` override field (Requirements 11.12, 11.13, 11.15,
 * 11.16; task 24.3). `RequestApprovalService.approveRequest` itself is
 * mocked here (its own resolution/uniqueness-check logic is covered by
 * `server/services/RequestApprovalService.test.js`) -- these tests only
 * verify the route wires the body field through as the 4th positional
 * argument, and maps a thrown `CallsignSuffixConflictError` to a 400
 * naming the conflicting value.
 */
describe('POST /api/requests/:requestId/approve callsignSuffix handling (Requirements 11.12, 11.13, 11.15, 11.16)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('passes callsignSuffix through to approveRequest as the 4th argument', async () => {
    mockApproveRequest.mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({ additionalDetails: 'welcome', callsignSuffix: 'Override-Suffix' });

    expect(res.status).toBe(200);
    expect(mockApproveRequest).toHaveBeenCalledWith('1', 1, 'welcome', 'Override-Suffix');
  });

  it('approves successfully with no callsignSuffix supplied (passed through as undefined)', async () => {
    mockApproveRequest.mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({});

    expect(res.status).toBe(200);
    expect(mockApproveRequest).toHaveBeenCalledWith('1', 1, undefined, undefined);
  });

  it('responds 400 naming the conflicting value when approveRequest throws CallsignSuffixConflictError, without a generic 500', async () => {
    const { CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
    mockApproveRequest.mockRejectedValue(new CallsignSuffixConflictError('J.Doe'));

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({ callsignSuffix: 'J.Doe' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('J.Doe');
  });

  it('responds 500 for a non-CallsignSuffixConflictError failure, unchanged from existing behavior', async () => {
    mockApproveRequest.mockRejectedValue(new Error('Request not found or already processed'));

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to approve request');
  });
});

/**
 * Integration tests for `GET /api/requests/pending` (Requirements 11.11,
 * 11.12; task 24.2), covering the new per-row `effective_callsign_suffix`
 * field: the request's own submitted `callsign_suffix` when present,
 * otherwise the server-computed default via
 * `CallsignService.computeDefaultCallsignSuffix`, resolving the target
 * team's Organisation's `callsign_name_format` via
 * `Team.getAncestorChain`, deduped by `target_team_id`.
 */
describe('GET /api/requests/pending effective_callsign_suffix (Requirements 11.11, 11.12)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  function mockAdminTeams(teamIds) {
    User.getTeamMemberships.mockResolvedValue(
      teamIds.map((id) => ({ id, role: 'admin' }))
    );
  }

  it('returns the request\'s own callsign_suffix as effective_callsign_suffix, calling getAncestorChain only for team_path resolution', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 100,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: 'Badge123',
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, name: 'Team A', callsign_prefix: null, callsign_name_format: 'full_name' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('Badge123');
    expect(res.body.requests[0].team_path).toBe('Team A');
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(1);
  });

  it('computes the default via CallsignService when callsign_suffix is not set, using requested_* falling back to requester_* names', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 101,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'first_initial_dot_last' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('J.Doe');
    expect(Team.getAncestorChain).toHaveBeenCalledWith(1);
  });

  it('prefers requested_first_name/requested_last_name over requester_first_name/requester_last_name when computing the default', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 102,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: 'James',
          requested_last_name: 'Smith',
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'first_initial_dot_last' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('J.Smith');
  });

  it('resolves the target team\'s Organisation callsign_name_format only ONCE for multiple pending requests targeting the same team', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 103,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        },
        {
          id: 104,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'Jane',
          requester_last_name: 'Roe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([{ id: 1, callsign_name_format: 'full_name' }]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('John-Doe');
    expect(res.body.requests[1].effective_callsign_suffix).toBe('Jane-Roe');
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(1);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(1);
  });

  it('resolves each Organisation\'s callsign_name_format independently for pending requests targeting DIFFERENT teams', async () => {
    mockAdminTeams([1, 2]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 105,
          target_team_id: 1,
          team_name: 'Team A',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        },
        {
          id: 106,
          target_team_id: 2,
          team_name: 'Team B',
          callsign_suffix: null,
          requested_first_name: null,
          requested_last_name: null,
          requester_first_name: 'Jane',
          requester_last_name: 'Roe'
        }
      ]
    });
    Team.getAncestorChain.mockImplementation((targetTeamId) => {
      if (targetTeamId === 1) {
        return Promise.resolve([{ id: 1, callsign_name_format: 'full_name' }]);
      }
      return Promise.resolve([{ id: 2, callsign_name_format: 'first_initial_last' }]);
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].effective_callsign_suffix).toBe('John-Doe');
    expect(res.body.requests[1].effective_callsign_suffix).toBe('J-Roe');
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(2);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(1);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(2);
  });

  it('returns an empty requests array without querying access_requests when the user administers no teams', async () => {
    mockAdminTeams([]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
  });
});
