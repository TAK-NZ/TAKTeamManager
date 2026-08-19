/**
 * Unit tests for signupCodes routes.
 *
 * Task 7.3 (signup-flow-rework spec)
 *
 * Tests permission enforcement, validation, and successful flows
 * for generate/get/delete/QR/PDF endpoints.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

let mockIsAdmin = true;

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, isAdmin: mockIsAdmin, is_global_manager: mockIsAdmin };
    next();
  }
}));

jest.mock('../middleware/authorize', () => {
  return (req, res, next) => {
    if (!mockIsAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
});

jest.mock('../middleware/requestContext', () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() })
}));

const mockGenerateCode = jest.fn();
const mockGetCode = jest.fn();
const mockRevokeCode = jest.fn();
const mockGenerateQrPng = jest.fn();
const mockGeneratePdf = jest.fn();

jest.mock('../services/SignupCodeService', () => {
  return jest.fn().mockImplementation(() => ({
    generateCode: mockGenerateCode,
    getCode: mockGetCode,
    revokeCode: mockRevokeCode,
    generateQrPng: mockGenerateQrPng,
    generatePdf: mockGeneratePdf
  }));
});

jest.mock('../models/Team', () => ({
  findById: jest.fn().mockResolvedValue({ id: 1, name: 'Test Team' })
}));

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/signup-codes', require('./signupCodes'));
  return app;
}

describe('signupCodes routes (Task 7.3)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
  });

  describe('permission enforcement', () => {
    it('non-admin gets 403 on POST /generate', async () => {
      mockIsAdmin = false;
      app = buildApp();

      const res = await request(app)
        .post('/api/signup-codes/generate')
        .send({ teamId: 1 });

      expect(res.status).toBe(403);
    });

    it('non-admin gets 403 on GET /:teamId', async () => {
      mockIsAdmin = false;
      app = buildApp();

      const res = await request(app).get('/api/signup-codes/1');

      expect(res.status).toBe(403);
    });

    it('non-admin gets 403 on DELETE /:teamId', async () => {
      mockIsAdmin = false;
      app = buildApp();

      const res = await request(app).delete('/api/signup-codes/1');

      expect(res.status).toBe(403);
    });
  });

  describe('validation', () => {
    it('returns 400 for invalid teamId on POST /generate', async () => {
      const res = await request(app)
        .post('/api/signup-codes/generate')
        .send({ teamId: 'abc' });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing teamId on POST /generate', async () => {
      const res = await request(app)
        .post('/api/signup-codes/generate')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid teamId on GET /:teamId', async () => {
      const res = await request(app).get('/api/signup-codes/abc');

      expect(res.status).toBe(400);
    });
  });

  describe('successful generate flow', () => {
    it('returns generated code on POST /generate', async () => {
      mockGenerateCode.mockResolvedValueOnce({
        code: 'ABCD5678',
        formatted: 'ABCD-5678',
        url: 'https://app.example.com/request-access?code=ABCD5678'
      });

      const res = await request(app)
        .post('/api/signup-codes/generate')
        .send({ teamId: 1 });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe('ABCD5678');
      expect(res.body.formatted).toBe('ABCD-5678');
    });
  });

  describe('successful get flow', () => {
    it('returns code on GET /:teamId', async () => {
      mockGetCode.mockResolvedValueOnce({
        code: 'ABCD5678',
        formatted: 'ABCD-5678',
        url: 'https://app.example.com/request-access?code=ABCD5678'
      });

      const res = await request(app).get('/api/signup-codes/1');

      expect(res.status).toBe(200);
      expect(res.body.code).toBe('ABCD5678');
    });

    it('returns 404 when no code exists', async () => {
      mockGetCode.mockResolvedValueOnce(null);

      const res = await request(app).get('/api/signup-codes/1');

      expect(res.status).toBe(404);
    });
  });

  describe('successful delete flow', () => {
    it('returns success on DELETE /:teamId', async () => {
      mockRevokeCode.mockResolvedValueOnce();

      const res = await request(app).delete('/api/signup-codes/1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('QR code endpoint', () => {
    it('returns image/png content-type on GET /:teamId/qr', async () => {
      mockGetCode.mockResolvedValueOnce({
        code: 'ABCD5678',
        formatted: 'ABCD-5678',
        url: 'https://app.example.com/request-access?code=ABCD5678'
      });
      mockGenerateQrPng.mockResolvedValueOnce(Buffer.from('fake-png'));

      const res = await request(app).get('/api/signup-codes/1/qr');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
    });
  });

  describe('PDF endpoint', () => {
    it('returns application/pdf content-type on GET /:teamId/pdf', async () => {
      mockGetCode.mockResolvedValueOnce({
        code: 'ABCD5678',
        formatted: 'ABCD-5678',
        url: 'https://app.example.com/request-access?code=ABCD5678'
      });
      mockGeneratePdf.mockResolvedValueOnce(Buffer.from('fake-pdf'));

      const res = await request(app).get('/api/signup-codes/1/pdf');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });
  });
});
