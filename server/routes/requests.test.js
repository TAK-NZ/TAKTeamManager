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
  getAncestorChain: jest.fn(),
  isAdmin: jest.fn()
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
 * `POST /api/requests/team-access`.
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
    // The approve route now queries for requester_email before calling approveRequest
    pool.query.mockResolvedValue({ rows: [{ requester_email: 'test@example.com' }] });
    app = buildApp();
  });

  it('passes callsignSuffix through to approveRequest as the 4th argument', async () => {
    mockApproveRequest.mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({ additionalDetails: 'welcome', callsignSuffix: 'Override-Suffix' });

    expect(res.status).toBe(200);
    // 5th argument is the approver's Global_Manager status (Requirement
    // 11.6): the mocked `authenticateToken` above sets
    // `is_global_manager: false`, and the route normalises it with `!!`.
    expect(mockApproveRequest).toHaveBeenCalledWith('1', 1, 'welcome', 'Override-Suffix', false);
  });

  it('approves successfully with no callsignSuffix supplied (passed through as undefined)', async () => {
    mockApproveRequest.mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/api/requests/1/approve')
      .send({});

    expect(res.status).toBe(200);
    expect(mockApproveRequest).toHaveBeenCalledWith('1', 1, undefined, undefined, false);
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

  // Requirement 4.4: the non-Global_Manager branch gates each row on
  // `Team.isAdmin(gatingTeamId, userId)`, so admin status is stubbed per
  // gating team id rather than as a list of direct membership rows.
  function mockAdminTeams(teamIds) {
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamIds.includes(teamId)));
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

  // Task 12.2 changed the shape of this case rather than its outcome: the
  // candidate rows are now fetched first and filtered in JS, so the query
  // does run for a caller who administers nothing. What still holds is that
  // no row survives the filter, so nothing is enriched and nothing is
  // returned.
  it('returns an empty requests array when the user administers no gating team', async () => {
    mockAdminTeams([]);
    pool.query.mockResolvedValue({
      rows: [{ id: 300, request_type: 'new_account', target_team_id: 1, team_name: 'Team A' }]
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
  });
});

/**
 * Feature: team-member-transfer, task 12.1.
 *
 * Examples for the shared `enrichPendingRequests` helper on
 * `GET /api/requests/pending`: the `team_change` fields of Requirement 4.3
 * (Source_Team and Destination_Team hierarchy paths, the Transferred_User's
 * name and email, the Initiating_Admin's name), and the guarantee that rows
 * of the other request types keep their existing shape.
 *
 * These exercise the non-Global_Manager branch (the auth mock at the top of
 * this file is a non-Global_Manager); the enrichment is the same code on
 * both branches by construction, since both call the one helper.
 */
describe('GET /api/requests/pending team_change enrichment (Requirements 4.1, 4.3)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // Requirement 4.4: the non-Global_Manager branch gates each row on
  // `Team.isAdmin(gatingTeamId, userId)`, so admin status is stubbed per
  // gating team id rather than as a list of direct membership rows.
  function mockAdminTeams(teamIds) {
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamIds.includes(teamId)));
  }

  it('resolves source_team_path and team_path from the distinct source and destination teams, and passes the joined user fields through', async () => {
    mockAdminTeams([2]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 200,
          request_type: 'team_change',
          existing_user_id: 7,
          initiated_by: 9,
          current_team_id: 3,
          target_team_id: 2,
          approval_team_id: 2,
          team_name: 'Bravo',
          source_team_name: 'Alpha',
          callsign_suffix: null,
          transferred_user_first_name: 'Mia',
          transferred_user_last_name: 'Ngata',
          transferred_user_email: 'mia@example.com',
          initiated_by_first_name: 'Sam',
          initiated_by_last_name: 'Reid'
        }
      ]
    });
    Team.getAncestorChain.mockImplementation((teamId) => {
      if (teamId === 3) {
        return Promise.resolve([
          { id: 1, name: 'Org', callsign_prefix: 'ORG', callsign_name_format: 'full_name' },
          { id: 3, name: 'Alpha', callsign_prefix: 'ALP' }
        ]);
      }
      return Promise.resolve([
        { id: 1, name: 'Org', callsign_prefix: 'ORG', callsign_name_format: 'full_name' },
        { id: 2, name: 'Bravo', callsign_prefix: 'BRV' }
      ]);
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    const [row] = res.body.requests;
    expect(row.team_path).toBe('ORG > Bravo');
    expect(row.source_team_path).toBe('ORG > Alpha');
    expect(row.transferred_user_first_name).toBe('Mia');
    expect(row.transferred_user_last_name).toBe('Ngata');
    expect(row.transferred_user_email).toBe('mia@example.com');
    expect(row.initiated_by_first_name).toBe('Sam');
    expect(row.initiated_by_last_name).toBe('Reid');
    // One chain resolution per distinct team id across BOTH columns.
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(2);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(3);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(2);
  });

  it('joins the Transferred_User, the Initiating_Admin, and the Source_Team on the pending query', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({ rows: [] });

    await request(app).get('/api/requests/pending');

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('LEFT JOIN users tu ON ar.existing_user_id = tu.id');
    expect(sql).toContain('LEFT JOIN users iu ON ar.initiated_by = iu.id');
    expect(sql).toContain('LEFT JOIN teams st ON ar.current_team_id = st.id');
  });

  it('leaves source_team_path empty and effective_callsign_suffix intact for a row with no current_team_id', async () => {
    mockAdminTeams([1]);
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 201,
          request_type: 'new_account',
          target_team_id: 1,
          current_team_id: null,
          team_name: 'Team A',
          source_team_name: null,
          callsign_suffix: null,
          requester_first_name: 'John',
          requester_last_name: 'Doe'
        }
      ]
    });
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, name: 'Team A', callsign_prefix: null, callsign_name_format: 'first_initial_dot_last' }
    ]);

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests[0].source_team_path).toBe('');
    expect(res.body.requests[0].team_path).toBe('Team A');
    expect(res.body.requests[0].effective_callsign_suffix).toBe('J.Doe');
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(1);
  });
});

/**
 * Feature: team-member-transfer, task 12.2.
 *
 * Examples for the reworked non-Global_Manager gating on
 * `GET /api/requests/pending` (Requirements 4.2, 4.4). The auth mock at the
 * top of this file is a non-Global_Manager with `userId` 1, so every request
 * here takes the filtered branch.
 *
 * The behaviour under test is the gating column and the gating predicate: a
 * `team_change` row is gated on `approval_team_id` via `Team.isAdmin` (which
 * walks that Team's Ancestor_Chain), every other type stays gated on
 * `target_team_id`, and a row naming no gating Team is invisible.
 */
describe('GET /api/requests/pending non-Global_Manager gating (Requirements 4.2, 4.4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    Team.getAncestorChain.mockResolvedValue([
      { id: 1, name: 'Org', callsign_prefix: 'ORG', callsign_name_format: 'full_name' }
    ]);
  });

  it('includes a team_change row gated on approval_team_id, not on target_team_id', async () => {
    // Caller administers team 5 (the Approval_Team) and NOT team 9 (the
    // Destination_Team), which is precisely the case the old
    // `target_team_id IN (...)` predicate got backwards.
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamId === 5));
    pool.query.mockResolvedValue({
      rows: [
        {
          id: 400,
          request_type: 'team_change',
          approval_team_id: 5,
          target_team_id: 9,
          current_team_id: 5,
          callsign_suffix: null
        }
      ]
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests.map((r) => r.id)).toEqual([400]);
    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
    expect(Team.isAdmin).not.toHaveBeenCalledWith(9, 1);
  });

  it('excludes a team_change row whose approval_team_id the caller does not administer, and one with no approval_team_id at all', async () => {
    Team.isAdmin.mockImplementation((teamId) => Promise.resolve(teamId === 5));
    pool.query.mockResolvedValue({
      rows: [
        { id: 401, request_type: 'team_change', approval_team_id: 7, target_team_id: 5, callsign_suffix: null },
        { id: 402, request_type: 'team_change', approval_team_id: null, target_team_id: 5, callsign_suffix: null },
        { id: 403, request_type: 'new_account', target_team_id: 5, callsign_suffix: null }
      ]
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    // 401 is gated on team 7 (not administered); 402 names no Approval_Team
    // so it fails closed; only the `new_account` row, gated on its
    // `target_team_id`, survives.
    expect(res.body.requests.map((r) => r.id)).toEqual([403]);
  });

  it('resolves admin status once per distinct gating team rather than once per row', async () => {
    Team.isAdmin.mockResolvedValue(true);
    pool.query.mockResolvedValue({
      rows: [
        { id: 404, request_type: 'team_change', approval_team_id: 5, target_team_id: 9, callsign_suffix: null },
        { id: 405, request_type: 'team_change', approval_team_id: 5, target_team_id: 8, callsign_suffix: null },
        { id: 406, request_type: 'new_account', target_team_id: 5, callsign_suffix: null }
      ]
    });

    const res = await request(app).get('/api/requests/pending');

    expect(res.status).toBe(200);
    expect(res.body.requests.map((r) => r.id)).toEqual([404, 405, 406]);
    expect(Team.isAdmin).toHaveBeenCalledTimes(1);
    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
  });
});
