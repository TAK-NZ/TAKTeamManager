jest.mock('../services/EmailRateLimitService', () => ({
  checkAndRecordEmailAttempt: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('./requestContext', () => ({
  getLogger: () => mockLoggerInstance
}));

const express = require('express');
const request = require('supertest');
const EmailRateLimitService = require('../services/EmailRateLimitService');
const {
  createEmailKeyedLimiter,
  emailRequestAccessLimiter,
  availableTeamsLimiter,
  availableTeamsLimiterStore,
  AVAILABLE_TEAMS_LIMITER_MAX
} = require('./rateLimiters');

function buildApp(middleware) {
  const app = express();
  app.use(express.json());
  app.post('/test', middleware, (req, res) => res.status(200).json({ ok: true }));
  app.get('/test', middleware, (req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('createEmailKeyedLimiter (Requirement 7.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls through to the handler when the email resolver allows the attempt', async () => {
    EmailRateLimitService.checkAndRecordEmailAttempt.mockResolvedValueOnce({ allowed: true });
    const app = buildApp(createEmailKeyedLimiter(async () => 'user@example.com'));

    const res = await request(app).post('/test').send({});

    expect(res.status).toBe(200);
    expect(EmailRateLimitService.checkAndRecordEmailAttempt).toHaveBeenCalledWith('user@example.com');
  });

  it('normalizes (trims/lowercases) the resolved email before checking', async () => {
    EmailRateLimitService.checkAndRecordEmailAttempt.mockResolvedValueOnce({ allowed: true });
    const app = buildApp(createEmailKeyedLimiter(async () => '  User@Example.com  '));

    await request(app).post('/test').send({});

    expect(EmailRateLimitService.checkAndRecordEmailAttempt).toHaveBeenCalledWith('user@example.com');
  });

  it('returns 429 without reaching the handler when the email resolver disallows the attempt', async () => {
    EmailRateLimitService.checkAndRecordEmailAttempt.mockResolvedValueOnce({ allowed: false });
    const app = buildApp(createEmailKeyedLimiter(async () => 'user@example.com'));

    const res = await request(app).post('/test').send({});

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Too many requests/i);
  });

  it('passes through (no rate check performed) when the resolver returns null/empty', async () => {
    const app = buildApp(createEmailKeyedLimiter(async () => null));

    const res = await request(app).post('/test').send({});

    expect(res.status).toBe(200);
    expect(EmailRateLimitService.checkAndRecordEmailAttempt).not.toHaveBeenCalled();
  });

  it('fails open (calls through to the handler) when the resolver itself throws', async () => {
    const app = buildApp(createEmailKeyedLimiter(async () => {
      throw new Error('token lookup failed');
    }));

    const res = await request(app).post('/test').send({});

    expect(res.status).toBe(200);
    expect(EmailRateLimitService.checkAndRecordEmailAttempt).not.toHaveBeenCalled();
    expect(mockLoggerInstance.warn).toHaveBeenCalled();
  });
});

describe('emailRequestAccessLimiter (Requirement 7.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keys off req.body.email directly', async () => {
    EmailRateLimitService.checkAndRecordEmailAttempt.mockResolvedValueOnce({ allowed: true });
    const app = buildApp(emailRequestAccessLimiter);

    await request(app).post('/test').send({ email: 'user@example.com' });

    expect(EmailRateLimitService.checkAndRecordEmailAttempt).toHaveBeenCalledWith('user@example.com');
  });

  it('passes through when the request body has no email field', async () => {
    const app = buildApp(emailRequestAccessLimiter);

    const res = await request(app).post('/test').send({});

    expect(res.status).toBe(200);
    expect(EmailRateLimitService.checkAndRecordEmailAttempt).not.toHaveBeenCalled();
  });
});

describe('availableTeamsLimiter (Requirement 7.1)', () => {
  beforeEach(() => {
    availableTeamsLimiterStore.resetAll();
  });

  it(`returns 429 on the (${AVAILABLE_TEAMS_LIMITER_MAX + 1})th request from the same IP within the window`, async () => {
    const app = buildApp(availableTeamsLimiter);

    let lastStatus;
    for (let i = 0; i < AVAILABLE_TEAMS_LIMITER_MAX + 1; i += 1) {
      const res = await request(app).get('/test').query({ token: 'x' });
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });

  it('allows requests up to the configured max', async () => {
    const app = buildApp(availableTeamsLimiter);

    let sawNon200 = false;
    for (let i = 0; i < AVAILABLE_TEAMS_LIMITER_MAX; i += 1) {
      const res = await request(app).get('/test').query({ token: 'x' });
      if (res.status !== 200) sawNon200 = true;
    }

    expect(sawNon200).toBe(false);
  });
});
