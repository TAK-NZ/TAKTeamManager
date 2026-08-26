/**
 * Integration tests for `server/routes/enrollment.js` (takserver-
 * enrollment task 8.1, Requirements 3.4, 3.9, 11.5, 15.1, 15.2).
 *
 * `authenticateToken` and `authorize` are mocked to bypass real JWT
 * verification and the permission registry -- `enrollment:self`'s
 * registry entry is task 8.4's job, not this task's, so exercising the
 * real `authorize.js` here would deny every request by design (deny-by-
 * default on an unmapped route). Mirrors `server/routes/devices.test.js`'s
 * `authenticateToken` mock; `authorize` is additionally mocked here for
 * the reason above.
 *
 * `DeviceEnrollmentService` is mocked at the class-method boundary, and
 * `pool.query` is mocked for the `audit_logs` insert.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

let mockUser = { id: 1, userId: 1, is_global_manager: false };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

jest.mock('../services/DeviceEnrollmentService', () => {
  class DeviceSessionCannotSelfEnrollError extends Error {
    constructor(message = 'A Team_Owned_Device session cannot self-enroll') {
      super(message);
      this.name = 'DeviceSessionCannotSelfEnrollError';
    }
  }
  class TakServerNotConfiguredError extends Error {
    constructor(message = 'TAK_SERVER_URL must be configured to generate a Team_Owned_Device enrollment QR code') {
      super(message);
      this.name = 'TakServerNotConfiguredError';
    }
  }
  class OrganisationPrefixMissingError extends Error {
    constructor(organisationId) {
      super(`Organisation ${organisationId} has no Organisation_Prefix. A Managed_Identifier cannot be minted for it, and none was.`);
      this.name = 'OrganisationPrefixMissingError';
    }
  }
  class ManagedIdentifierExhaustionError extends Error {
    constructor(organisationId, typeMarker, attempts) {
      super(`Exhausted ${attempts} Managed_Identifier mint attempt(s) for organisation ${organisationId} (type marker ${typeMarker}). No identifier could be claimed.`);
      this.name = 'ManagedIdentifierExhaustionError';
    }
  }

  const MockDeviceEnrollmentService = {
    generateSelfEnrollment: jest.fn(),
    DeviceSessionCannotSelfEnrollError,
    TakServerNotConfiguredError,
    OrganisationPrefixMissingError,
    ManagedIdentifierExhaustionError
  };

  return MockDeviceEnrollmentService;
});

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const DeviceEnrollmentService = require('../services/DeviceEnrollmentService');
const enrollmentRouter = require('./enrollment');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/enrollment', enrollmentRouter);
  return app;
}

function asUser(userId = 1, isGlobalManager = false) {
  mockUser = { id: userId, userId, is_global_manager: isGlobalManager };
}

describe('POST /api/enrollment/me', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
    asUser();
  });

  it('generates a self-enrollment, writes an audit_logs row with no token/QR in details, and responds with the enrollment object', async () => {
    const enrollment = {
      principalId: 7,
      principalKind: 'human',
      username: 'AUK-U7K3QMX',
      host: 'tak.example.com',
      expiresAt: '2024-01-01T00:30:00.000Z',
      reEnrollmentDate: '2025-01-01T00:00:00.000Z',
      atakEnrollmentUri: 'tak://com.atakmap.app/enroll?host=tak.example.com&username=AUK-U7K3QMX&token=secrettoken',
      itakRegistrationPayload: {
        passphrase: 'false',
        type: 'registration',
        serverCredentials: { connectionString: 'tak.example.com:8089:ssl' },
        userCredentials: { username: 'AUK-U7K3QMX', password: 'secrettoken', registrationId: 'uuid-1' }
      },
      atakQrDataUrl: 'data:image/png;base64,AAAA',
      itakQrDataUrl: 'data:image/png;base64,BBBB',
      takAttributes: { callsign: 'None', color: 'None', role: 'None' },
      liveCertificateCount: 0
    };
    DeviceEnrollmentService.generateSelfEnrollment.mockResolvedValue(enrollment);

    const res = await request(app).post('/api/enrollment/me');

    expect(res.status).toBe(200);
    expect(res.body.enrollment).toEqual(enrollment);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO audit_logs');
    expect(params[0]).toBe(mockUser.userId);
    expect(params[1]).toBe('enrollment_self_qr_generated');
    expect(params[2]).toBe('user');
    expect(params[3]).toBe(enrollment.principalId);

    const details = JSON.parse(params[4]);
    expect(details.principalId).toBe(enrollment.principalId);
    expect(details.expiresAt).toBe(enrollment.expiresAt);
    expect(typeof details.generatedAt).toBe('string');
    expect(Object.keys(details).sort()).toEqual(['expiresAt', 'generatedAt', 'principalId'].sort());

    // No token key and no QR data URL anywhere in the serialized details.
    expect(params[4]).not.toContain('secrettoken');
    expect(params[4]).not.toContain('data:image/png');
    expect(params[4]).not.toContain('token');
  });

  it('sets the no-store cache header on a successful response', async () => {
    DeviceEnrollmentService.generateSelfEnrollment.mockResolvedValue({
      principalId: 7,
      expiresAt: '2024-01-01T00:30:00.000Z'
    });

    const res = await request(app).post('/api/enrollment/me');

    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('sets the no-store cache header on an error response too', async () => {
    DeviceEnrollmentService.generateSelfEnrollment.mockRejectedValue(
      new DeviceEnrollmentService.TakServerNotConfiguredError()
    );

    const res = await request(app).post('/api/enrollment/me');

    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('calls generateSelfEnrollment with req.user and no other arguments', async () => {
    DeviceEnrollmentService.generateSelfEnrollment.mockResolvedValue({
      principalId: 7,
      expiresAt: '2024-01-01T00:30:00.000Z'
    });

    await request(app)
      .post('/api/enrollment/me')
      .send({ userId: 999, deviceUserId: 42 })
      .query({ userId: 999 });

    expect(DeviceEnrollmentService.generateSelfEnrollment).toHaveBeenCalledTimes(1);
    expect(DeviceEnrollmentService.generateSelfEnrollment).toHaveBeenCalledWith(mockUser);
    expect(DeviceEnrollmentService.generateSelfEnrollment.mock.calls[0]).toHaveLength(1);
  });

  it('maps DeviceSessionCannotSelfEnrollError to 403 and does not write an audit log', async () => {
    DeviceEnrollmentService.generateSelfEnrollment.mockRejectedValue(
      new DeviceEnrollmentService.DeviceSessionCannotSelfEnrollError()
    );

    const res = await request(app).post('/api/enrollment/me');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('maps TakServerNotConfiguredError to 400 and does not write an audit log', async () => {
    DeviceEnrollmentService.generateSelfEnrollment.mockRejectedValue(
      new DeviceEnrollmentService.TakServerNotConfiguredError()
    );

    const res = await request(app).post('/api/enrollment/me');

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('maps OrganisationPrefixMissingError to 400 and does not write an audit log', async () => {
    DeviceEnrollmentService.generateSelfEnrollment.mockRejectedValue(
      new DeviceEnrollmentService.OrganisationPrefixMissingError(3)
    );

    const res = await request(app).post('/api/enrollment/me');

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('maps ManagedIdentifierExhaustionError to 500 with a generic message and does not write an audit log', async () => {
    const error = new DeviceEnrollmentService.ManagedIdentifierExhaustionError(3, 'U', 5);
    DeviceEnrollmentService.generateSelfEnrollment.mockRejectedValue(error);

    const res = await request(app).post('/api/enrollment/me');

    expect(res.status).toBe(500);
    // The caller-facing message must not echo the service error's own
    // (potentially informative) text -- Criterion 1.9: exhaustion "tells
    // the caller nothing", the detail goes to the log instead.
    expect(res.body.error).not.toBe(error.message);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('maps an unrecognized error to a generic 500 and does not write an audit log', async () => {
    DeviceEnrollmentService.generateSelfEnrollment.mockRejectedValue(new Error('boom'));

    const res = await request(app).post('/api/enrollment/me');

    expect(res.status).toBe(500);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
