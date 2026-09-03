/**
 * Unit tests for signup routes.
 *
 * Task 8.2 (signup-flow-rework spec)
 *
 * Tests POST /requests/initiate (always 200), GET /requests/available-teams,
 * POST /requests/team-access, and POST /org-interest.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

jest.mock('../middleware/requestContext', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() })
}));

// Mock rate limiters to be pass-throughs. createEmailKeyedLimiter must
// return an actual pass-through middleware function (not the factory
// itself) since signup.js calls it at module load time to build
// `teamAccessEmailLimiter`.
jest.mock('../middleware/rateLimiters', () => ({
  requestAccessLimiter: (req, res, next) => next(),
  emailRequestAccessLimiter: (req, res, next) => next(),
  availableTeamsLimiter: (req, res, next) => next(),
  createEmailKeyedLimiter: () => (req, res, next) => next()
}));

// Mock captcha to be a pass-through
jest.mock('../middleware/captcha', () => ({
  verifyCaptcha: (req, res, next) => next()
}));

const mockInitiateSignup = jest.fn();
const mockGetAvailableTeams = jest.fn();
const mockSubmitTeamAccess = jest.fn();

jest.mock('../services/SignupFlowService', () => {
  return jest.fn().mockImplementation(() => ({
    initiateSignup: mockInitiateSignup,
    getAvailableTeams: mockGetAvailableTeams,
    submitTeamAccess: mockSubmitTeamAccess
  }));
});

const mockSubmitRequest = jest.fn();

jest.mock('../services/OrgInterestService', () => {
  return jest.fn().mockImplementation(() => ({
    submitRequest: mockSubmitRequest
  }));
});

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('./signup'));
  return app;
}

describe('signup routes (Task 8.2)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  describe('POST /requests/initiate', () => {
    it('always returns 200 with same message on success', async () => {
      mockInitiateSignup.mockResolvedValueOnce({ message: 'Check your email to continue' });

      const res = await request(app)
        .post('/api/requests/initiate')
        .send({ email: 'user@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Check your email to continue');
    });

    it('returns 200 with same message even on internal error (anti-enumeration)', async () => {
      mockInitiateSignup.mockRejectedValueOnce(new Error('DB failure'));

      const res = await request(app)
        .post('/api/requests/initiate')
        .send({ email: 'user@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Check your email to continue');
    });

    it('returns 400 for invalid email', async () => {
      const res = await request(app)
        .post('/api/requests/initiate')
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /requests/available-teams', () => {
    it('returns teams for valid token', async () => {
      mockGetAvailableTeams.mockResolvedValueOnce({
        teams: [{ id: 1, name: 'Team A' }],
        email: 'user@example.com'
      });

      const res = await request(app)
        .get('/api/requests/available-teams')
        .query({ token: 'valid-token' });

      expect(res.status).toBe(200);
      expect(res.body.teams).toHaveLength(1);
      expect(res.body.email).toBe('user@example.com');
    });

    it('returns 400 for missing token', async () => {
      const res = await request(app)
        .get('/api/requests/available-teams');

      expect(res.status).toBe(400);
    });

    it('returns 400 for expired/invalid token', async () => {
      mockGetAvailableTeams.mockRejectedValueOnce(
        new Error('Invalid or expired verification token')
      );

      const res = await request(app)
        .get('/api/requests/available-teams')
        .query({ token: 'expired-token' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid or expired');
    });
  });

  describe('POST /requests/team-access', () => {
    it('returns success on valid submission', async () => {
      mockSubmitTeamAccess.mockResolvedValueOnce({ requestId: 1 });

      const res = await request(app)
        .post('/api/requests/team-access')
        .send({
          token: 'valid-token',
          firstName: 'Jane',
          lastName: 'Doe',
          teamId: 5,
          reason: 'I need access to collaborate with the team'
        });

      expect(res.status).toBe(200);
      expect(res.body.requestId).toBe(1);
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/api/requests/team-access')
        .send({ token: 'valid-token' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid teamId', async () => {
      const res = await request(app)
        .post('/api/requests/team-access')
        .send({
          token: 'valid-token',
          firstName: 'Jane',
          lastName: 'Doe',
          teamId: 'abc'
        });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /org-interest', () => {
    it('returns success on valid submission', async () => {
      mockSubmitRequest.mockResolvedValueOnce({ id: 1 });

      const res = await request(app)
        .post('/api/org-interest')
        .send({
          token: 'valid-token',
          firstName: 'Jane',
          lastName: 'Doe',
          orgName: 'MyCorp'
        });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(1);
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/api/org-interest')
        .send({ token: 'valid-token' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for excluded domain error', async () => {
      mockSubmitRequest.mockRejectedValueOnce(
        new Error('Please use an organisational email address to request a new organisation')
      );

      const res = await request(app)
        .post('/api/org-interest')
        .send({
          token: 'valid-token',
          firstName: 'Jane',
          lastName: 'Doe',
          orgName: 'MyCorp'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('organisational email');
    });

    it('returns 400 for duplicate pending error', async () => {
      mockSubmitRequest.mockRejectedValueOnce(
        new Error('A request is already pending for this email')
      );

      const res = await request(app)
        .post('/api/org-interest')
        .send({
          token: 'valid-token',
          firstName: 'Jane',
          lastName: 'Doe',
          orgName: 'MyCorp'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('already pending');
    });
  });
});
