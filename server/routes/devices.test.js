/**
 * Integration tests for `server/routes/devices.js` (Requirement 27, task
 * 49.4), plus the QR-generation audit-logging half of task 49.5
 * (Requirement 27.8) that is scoped to this route file.
 *
 * `authenticateToken` is mocked to bypass real JWT verification, but the
 * REAL `authorize.js` middleware and `permissions.registry.js` are used
 * (not mocked) -- mirroring `server/routes/mou.test.js`/
 * `server/routes/settings.test.js`'s established pattern -- so each test
 * below exercises the actual Permission_Registry entries added for this
 * route file.
 *
 * `DeviceEnrollmentService` is mocked at the class-method boundary (its
 * own logic is already covered by `server/services/
 * DeviceEnrollmentService.test.js`), and `pool.query` is mocked for the
 * `audit_logs` insert written by `POST /:deviceUserId/qr-code`.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

let mockUser = { id: 1, userId: 1, is_global_manager: true };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

jest.mock('../services/DeviceEnrollmentService', () => {
  class DeviceEnrollmentAuthorizationError extends Error {
    constructor(message = 'Insufficient authorization to manage this team\'s devices') {
      super(message);
      this.name = 'DeviceEnrollmentAuthorizationError';
    }
  }
  class NotATeamOwnedDeviceError extends Error {
    constructor(message = 'Target user is not a Team_Owned_Device') {
      super(message);
      this.name = 'NotATeamOwnedDeviceError';
    }
  }
  class TakServerNotConfiguredError extends Error {
    constructor(message = 'TAK_SERVER_URL must be configured to generate a Team_Owned_Device enrollment QR code') {
      super(message);
      this.name = 'TakServerNotConfiguredError';
    }
  }

  const MockDeviceEnrollmentService = {
    createDevice: jest.fn(),
    generateEnrollmentQrCode: jest.fn(),
    DeviceEnrollmentAuthorizationError,
    NotATeamOwnedDeviceError,
    TakServerNotConfiguredError
  };

  return MockDeviceEnrollmentService;
});

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const DeviceEnrollmentService = require('../services/DeviceEnrollmentService');
const devicesRouter = require('./devices');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', devicesRouter);
  return app;
}

function asGlobalManager(userId = 1) {
  mockUser = { id: userId, userId, is_global_manager: true };
}

function asStandardUser(userId = 2) {
  mockUser = { id: userId, userId, is_global_manager: false };
}

describe('POST /api/devices', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('creates a device for a Global_Manager and returns 201 with the device info', async () => {
    asGlobalManager();
    DeviceEnrollmentService.createDevice.mockResolvedValue({
      deviceUserId: 10,
      authentikUserId: 99,
      username: 'device-abc',
      email: 'device-abc@devices.tak.nz.invalid',
      label: 'Engine 4 Tablet',
      teamId: 3
    });

    const res = await request(app).post('/api/devices').send({
      teamId: 3,
      label: 'Engine 4 Tablet'
    });

    expect(res.status).toBe(201);
    expect(res.body.device).toEqual({
      deviceUserId: 10,
      authentikUserId: 99,
      username: 'device-abc',
      email: 'device-abc@devices.tak.nz.invalid',
      label: 'Engine 4 Tablet',
      teamId: 3
    });
    expect(DeviceEnrollmentService.createDevice).toHaveBeenCalledWith(3, 'Engine 4 Tablet', mockUser);
  });

  it('allows a standard authenticated user to reach the handler (team-admin success case)', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.createDevice.mockResolvedValue({
      deviceUserId: 11,
      authentikUserId: 100,
      username: 'device-def',
      email: 'device-def@devices.tak.nz.invalid',
      label: null,
      teamId: 4
    });

    const res = await request(app).post('/api/devices').send({ teamId: 4 });

    expect(res.status).toBe(201);
    expect(DeviceEnrollmentService.createDevice).toHaveBeenCalledWith(4, null, mockUser);
  });

  it('returns 400 on invalid body without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).post('/api/devices').send({});

    expect(res.status).toBe(400);
    expect(DeviceEnrollmentService.createDevice).not.toHaveBeenCalled();
  });

  it('maps DeviceEnrollmentAuthorizationError from the service to 403', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.createDevice.mockRejectedValue(
      new DeviceEnrollmentService.DeviceEnrollmentAuthorizationError()
    );

    const res = await request(app).post('/api/devices').send({ teamId: 4 });

    expect(res.status).toBe(403);
  });
});

describe('POST /api/devices/:deviceUserId/qr-code', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('generates a QR code and writes an audit_logs row on success', async () => {
    asGlobalManager();
    DeviceEnrollmentService.generateEnrollmentQrCode.mockResolvedValue({
      deviceUserId: 10,
      teamId: 3,
      username: 'device-abc',
      host: 'tak.example.com',
      expiresAt: '2024-01-01T00:30:00.000Z',
      atakEnrollmentUri: 'tak://com.atakmap.app/enroll?host=tak.example.com&username=device-abc&token=xyz',
      itakEnrollmentPayload: { host: 'tak.example.com', username: 'device-abc', token: 'xyz' }
    });

    const res = await request(app).post('/api/devices/10/qr-code');

    expect(res.status).toBe(200);
    expect(res.body.qrCode.atakEnrollmentUri).toContain('tak://com.atakmap.app/enroll');
    expect(DeviceEnrollmentService.generateEnrollmentQrCode).toHaveBeenCalledWith('10', mockUser);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO audit_logs');
    expect(params[0]).toBe(mockUser.userId);
    expect(params[1]).toBe('device_enrollment_qr_generated');
    expect(params[2]).toBe('user');
    expect(params[3]).toBe(10);
    const details = JSON.parse(params[4]);
    expect(details.deviceUserId).toBe(10);
    expect(details.expiresAt).toBe('2024-01-01T00:30:00.000Z');
    expect(typeof details.generatedAt).toBe('string');
  });

  it('allows a standard authenticated user to reach the handler', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.generateEnrollmentQrCode.mockResolvedValue({
      deviceUserId: 12,
      teamId: 4,
      username: 'device-ghi',
      host: 'tak.example.com',
      expiresAt: '2024-01-01T00:30:00.000Z',
      atakEnrollmentUri: 'tak://com.atakmap.app/enroll?host=tak.example.com&username=device-ghi&token=abc',
      itakEnrollmentPayload: { host: 'tak.example.com', username: 'device-ghi', token: 'abc' }
    });

    const res = await request(app).post('/api/devices/12/qr-code');

    expect(res.status).toBe(200);
    expect(DeviceEnrollmentService.generateEnrollmentQrCode).toHaveBeenCalledWith('12', mockUser);
  });

  it('returns 400 for a non-integer deviceUserId without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).post('/api/devices/not-a-number/qr-code');

    expect(res.status).toBe(400);
    expect(DeviceEnrollmentService.generateEnrollmentQrCode).not.toHaveBeenCalled();
  });

  it('maps DeviceEnrollmentAuthorizationError from the service to 403 and does not write an audit log', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.generateEnrollmentQrCode.mockRejectedValue(
      new DeviceEnrollmentService.DeviceEnrollmentAuthorizationError()
    );

    const res = await request(app).post('/api/devices/10/qr-code');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('maps NotATeamOwnedDeviceError from the service to 400', async () => {
    asGlobalManager();
    DeviceEnrollmentService.generateEnrollmentQrCode.mockRejectedValue(
      new DeviceEnrollmentService.NotATeamOwnedDeviceError()
    );

    const res = await request(app).post('/api/devices/10/qr-code');

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('maps TakServerNotConfiguredError from the service to 400', async () => {
    asGlobalManager();
    DeviceEnrollmentService.generateEnrollmentQrCode.mockRejectedValue(
      new DeviceEnrollmentService.TakServerNotConfiguredError()
    );

    const res = await request(app).post('/api/devices/10/qr-code');

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
