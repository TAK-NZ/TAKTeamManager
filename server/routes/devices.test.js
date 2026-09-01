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
    constructor(message = 'TAK_SERVER_ENROLLMENT_URL must be configured to generate a TAK Server enrollment QR code') {
      super(message);
      this.name = 'TakServerNotConfiguredError';
    }
  }

  const MockDeviceEnrollmentService = {
    createDevice: jest.fn(),
    generateEnrollmentQrCode: jest.fn(),
    previewEnrollmentQrCode: jest.fn(),
    listTeamDevices: jest.fn(),
    listAllDevices: jest.fn(),
    updateDevice: jest.fn(),
    deleteDevice: jest.fn(),
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
    expect(DeviceEnrollmentService.createDevice).toHaveBeenCalledWith(3, 'Engine 4 Tablet', mockUser, null);
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
    expect(DeviceEnrollmentService.createDevice).toHaveBeenCalledWith(4, null, mockUser, null);
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

  it('passes a supplied callsignSuffix through to the service', async () => {
    asGlobalManager();
    DeviceEnrollmentService.createDevice.mockResolvedValue({
      deviceUserId: 10,
      authentikUserId: 99,
      username: 'device-abc',
      label: 'Engine 4 Tablet',
      callsignSuffix: 'Tanker1',
      teamId: 3
    });

    const res = await request(app).post('/api/devices').send({
      teamId: 3,
      label: 'Engine 4 Tablet',
      callsignSuffix: 'Tanker1'
    });

    expect(res.status).toBe(201);
    expect(DeviceEnrollmentService.createDevice).toHaveBeenCalledWith(3, 'Engine 4 Tablet', mockUser, 'Tanker1');
  });

  it('rejects a callsignSuffix containing a disallowed character with 400, without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).post('/api/devices').send({
      teamId: 3,
      callsignSuffix: 'Tanker 1'
    });

    expect(res.status).toBe(400);
    expect(DeviceEnrollmentService.createDevice).not.toHaveBeenCalled();
  });

  it('maps a CallsignSuffixConflictError from the service to 400', async () => {
    asGlobalManager();
    const { CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
    DeviceEnrollmentService.createDevice.mockRejectedValue(
      new CallsignSuffixConflictError('Tanker1')
    );

    const res = await request(app).post('/api/devices').send({
      teamId: 3,
      callsignSuffix: 'Tanker1'
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Tanker1/);
  });
});

// Org-wide Team_Owned_Device listing backing the `/devices` page.
describe('GET /api/devices', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns the devices and pagination info for an authorized caller (Global_Manager)', async () => {
    asGlobalManager();
    DeviceEnrollmentService.listAllDevices.mockResolvedValue({
      devices: [
        {
          deviceUserId: 10,
          username: 'AUK-D7K3QMX',
          deviceLabel: 'Engine 4 Tablet',
          callsignSuffix: 'Tanker1',
          takRole: 'Team Member',
          callsign: 'AUKTanker1',
          teamId: 3,
          teamName: 'Auckland',
          createdAt: '2024-01-01T00:00:00.000Z',
          accountStatus: 'active',
          liveCertificateCount: 1,
          canManage: true
        }
      ],
      pagination: { page: 1, pageSize: 50, total: 1 }
    });

    const res = await request(app).get('/api/devices');

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0]).not.toHaveProperty('email');
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 50, total: 1 });
    expect(DeviceEnrollmentService.listAllDevices).toHaveBeenCalledWith(
      mockUser,
      { page: 1, pageSize: 50, search: undefined, expiringOnly: false }
    );
  });

  it('passes page/pageSize/search query params through to the service', async () => {
    asGlobalManager();
    DeviceEnrollmentService.listAllDevices.mockResolvedValue({
      devices: [],
      pagination: { page: 2, pageSize: 10, total: 0 }
    });

    const res = await request(app).get('/api/devices').query({ page: 2, pageSize: 10, search: 'tanker' });

    expect(res.status).toBe(200);
    expect(DeviceEnrollmentService.listAllDevices).toHaveBeenCalledWith(
      mockUser,
      { page: 2, pageSize: 10, search: 'tanker', expiringOnly: false }
    );
  });

  /**
   * cert-expiry-notifications Requirement 7.3(b) (task 14.1): the
   * expiringOnly query param, threaded through to the service.
   */
  describe('expiringOnly query param', () => {
    it('passes expiringOnly: true only for the exact string "true"', async () => {
      asGlobalManager();
      DeviceEnrollmentService.listAllDevices.mockResolvedValue({
        devices: [],
        pagination: { page: 1, pageSize: 50, total: 0 }
      });

      const res = await request(app).get('/api/devices').query({ expiringOnly: 'true' });

      expect(res.status).toBe(200);
      expect(DeviceEnrollmentService.listAllDevices).toHaveBeenCalledWith(
        mockUser,
        { page: 1, pageSize: 50, search: undefined, expiringOnly: true }
      );
    });

    it.each(['TRUE', '1', 'yes', ''])('treats the non-exact value %p as false', async (value) => {
      asGlobalManager();
      DeviceEnrollmentService.listAllDevices.mockResolvedValue({
        devices: [],
        pagination: { page: 1, pageSize: 50, total: 0 }
      });

      await request(app).get('/api/devices').query({ expiringOnly: value });

      expect(DeviceEnrollmentService.listAllDevices).toHaveBeenCalledWith(
        mockUser,
        expect.objectContaining({ expiringOnly: false })
      );
    });

    it('defaults to false when the param is absent entirely', async () => {
      asGlobalManager();
      DeviceEnrollmentService.listAllDevices.mockResolvedValue({
        devices: [],
        pagination: { page: 1, pageSize: 50, total: 0 }
      });

      await request(app).get('/api/devices');

      expect(DeviceEnrollmentService.listAllDevices).toHaveBeenCalledWith(
        mockUser,
        expect.objectContaining({ expiringOnly: false })
      );
    });
  });

  it('allows a Team_Admin (non-global-manager) to reach the handler', async () => {
    asStandardUser(5);
    // The real `authorize.js` middleware and `device:read:org` resolver
    // run for this route (not mocked, per this file's header comment) --
    // its resolver issues a real `pool.query` existence check. A
    // non-empty row set is what makes it resolve `true` for a standard
    // user, mirroring `GET /api/devices/team/:teamId`'s own test above.
    pool.query.mockResolvedValue({ rows: [{ exists: 1 }] });
    DeviceEnrollmentService.listAllDevices.mockResolvedValue({
      devices: [],
      pagination: { page: 1, pageSize: 50, total: 0 }
    });

    const res = await request(app).get('/api/devices');

    expect(res.status).toBe(200);
    expect(DeviceEnrollmentService.listAllDevices).toHaveBeenCalled();
  });

  it('denies a plain team member (no direct admin row) with 403', async () => {
    asStandardUser(6);
    // No direct admin row anywhere -- the `device:read:org` resolver's
    // existence check resolves empty.
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/devices');

    expect(res.status).toBe(403);
    expect(DeviceEnrollmentService.listAllDevices).not.toHaveBeenCalled();
  });

  it('returns 400 for an out-of-range pageSize without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).get('/api/devices').query({ pageSize: 1000 });

    expect(res.status).toBe(400);
    expect(DeviceEnrollmentService.listAllDevices).not.toHaveBeenCalled();
  });
});

describe('POST /api/devices/:deviceUserId/qr-code', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  // takserver-enrollment Criteria 4.1, 4.3 (Correction 3, task 8.3): the
  // corrected `#buildEnrollment` shape a mocked service call now
  // resolves with, used across the tests below in place of the retired
  // `itakEnrollmentPayload: { host, username, token }` shape.
  const correctedQrCode = {
    principalId: 10,
    principalKind: 'device',
    teamId: 3,
    username: 'device-abc',
    host: 'tak.example.com',
    expiresAt: '2024-01-01T00:30:00.000Z',
    reEnrollmentDate: '2025-01-01T00:00:00.000Z',
    atakEnrollmentUri: 'tak://com.atakmap.app/enroll?host=tak.example.com&username=device-abc&token=xyz',
    itakRegistrationPayload: {
      passphrase: 'false',
      type: 'registration',
      serverCredentials: { connectionString: 'tak.example.com:8089:ssl' },
      userCredentials: { username: 'device-abc', password: 'xyz', registrationId: 'a1b2c3d4-0000-0000-0000-000000000000' }
    },
    atakQrDataUrl: 'data:image/png;base64,AAA=',
    itakQrDataUrl: 'data:image/png;base64,BBB=',
    takAttributes: { callsign: 'Callsign1', color: 'Blue', role: 'Team Member' },
    liveCertificateCount: 1
  };

  it('generates the corrected enrollment payload and writes an audit_logs row on success', async () => {
    asGlobalManager();
    DeviceEnrollmentService.generateEnrollmentQrCode.mockResolvedValue(correctedQrCode);

    const res = await request(app).post('/api/devices/10/qr-code');

    expect(res.status).toBe(200);
    // takserver-enrollment Criterion 4.1: assert the EXACT key set of
    // the corrected shape, not a loose/partial shape check -- no
    // `token` key anywhere.
    expect(Object.keys(res.body.qrCode).sort()).toEqual([
      'atakEnrollmentUri',
      'atakQrDataUrl',
      'expiresAt',
      'host',
      'itakQrDataUrl',
      'itakRegistrationPayload',
      'liveCertificateCount',
      'principalId',
      'principalKind',
      'reEnrollmentDate',
      'takAttributes',
      'teamId',
      'username'
    ].sort());
    expect(res.body.qrCode).not.toHaveProperty('deviceUserId');
    expect(res.body.qrCode).not.toHaveProperty('itakEnrollmentPayload');
    expect(res.body.qrCode.itakRegistrationPayload).toEqual({
      passphrase: 'false',
      type: 'registration',
      serverCredentials: { connectionString: 'tak.example.com:8089:ssl' },
      userCredentials: { username: 'device-abc', password: 'xyz', registrationId: 'a1b2c3d4-0000-0000-0000-000000000000' }
    });
    expect(JSON.stringify(res.body.qrCode)).not.toContain('"token"');
    expect(res.body.qrCode.atakEnrollmentUri).toContain('tak://com.atakmap.app/enroll');
    expect(DeviceEnrollmentService.generateEnrollmentQrCode).toHaveBeenCalledWith('10', mockUser);

    // takserver-enrollment Criterion 11.5: `no-store` present on the
    // success response.
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(res.headers['pragma']).toBe('no-cache');

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO audit_logs');
    expect(params[0]).toBe(mockUser.userId);
    expect(params[1]).toBe('device_enrollment_qr_generated');
    expect(params[2]).toBe('user');
    // takserver-enrollment task 8.3: `#buildEnrollment` returns
    // `principalId`, not `deviceUserId` -- the audit log's `resource_id`
    // and `details.deviceUserId` now read the corrected field.
    expect(params[3]).toBe(10);
    const details = JSON.parse(params[4]);
    expect(details.deviceUserId).toBe(10);
    expect(details.expiresAt).toBe('2024-01-01T00:30:00.000Z');
    expect(typeof details.generatedAt).toBe('string');
  });

  it('allows a standard authenticated user to reach the handler', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.generateEnrollmentQrCode.mockResolvedValue({
      ...correctedQrCode,
      principalId: 12,
      teamId: 4,
      username: 'device-ghi'
    });

    const res = await request(app).post('/api/devices/12/qr-code');

    expect(res.status).toBe(200);
    expect(DeviceEnrollmentService.generateEnrollmentQrCode).toHaveBeenCalledWith('12', mockUser);
  });

  it('sets the no-store Cache-Control and Pragma headers even on an error response', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.generateEnrollmentQrCode.mockRejectedValue(
      new DeviceEnrollmentService.DeviceEnrollmentAuthorizationError()
    );

    const res = await request(app).post('/api/devices/10/qr-code');

    expect(res.status).toBe(403);
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(res.headers['pragma']).toBe('no-cache');
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

describe('GET /api/devices/:deviceUserId/preview', () => {
  let app;

  const previewShape = {
    principalId: 10,
    principalKind: 'device',
    teamId: 3,
    username: 'device-abc',
    host: 'tak.example.com',
    takAttributes: { callsign: 'Callsign1', color: 'Blue', role: 'Team Member' },
    liveCertificateCount: 1
  };

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('resolves the preview shape, writes no audit_logs row, and sets no-store', async () => {
    asGlobalManager();
    DeviceEnrollmentService.previewEnrollmentQrCode.mockResolvedValue(previewShape);

    const res = await request(app).get('/api/devices/10/preview');

    expect(res.status).toBe(200);
    expect(res.body.preview).toEqual(previewShape);
    expect(DeviceEnrollmentService.previewEnrollmentQrCode).toHaveBeenCalledWith('10', mockUser);
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(res.headers['pragma']).toBe('no-cache');
    // No secret was generated, so no audit_logs row.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-integer deviceUserId without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).get('/api/devices/not-a-number/preview');

    expect(res.status).toBe(400);
    expect(DeviceEnrollmentService.previewEnrollmentQrCode).not.toHaveBeenCalled();
  });

  it('maps DeviceEnrollmentAuthorizationError from the service to 403', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.previewEnrollmentQrCode.mockRejectedValue(
      new DeviceEnrollmentService.DeviceEnrollmentAuthorizationError()
    );

    const res = await request(app).get('/api/devices/10/preview');

    expect(res.status).toBe(403);
  });

  it('maps NotATeamOwnedDeviceError from the service to 400', async () => {
    asGlobalManager();
    DeviceEnrollmentService.previewEnrollmentQrCode.mockRejectedValue(
      new DeviceEnrollmentService.NotATeamOwnedDeviceError()
    );

    const res = await request(app).get('/api/devices/10/preview');

    expect(res.status).toBe(400);
  });

  it('maps TakServerNotConfiguredError from the service to 400', async () => {
    asGlobalManager();
    DeviceEnrollmentService.previewEnrollmentQrCode.mockRejectedValue(
      new DeviceEnrollmentService.TakServerNotConfiguredError()
    );

    const res = await request(app).get('/api/devices/10/preview');

    expect(res.status).toBe(400);
  });
});

// takserver-enrollment Criteria 3.11, 5.9, 5.10, 13.6, 14.6, 14.7 (task
// 8.3): the new team device listing route.
describe('GET /api/devices/team/:teamId', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns the team\'s devices for an authorized caller (Global_Manager)', async () => {
    asGlobalManager();
    DeviceEnrollmentService.listTeamDevices.mockResolvedValue({
      devices: [
        {
          deviceUserId: 10,
          username: 'AUK-D7K3QMX',
          deviceLabel: 'Engine 4 Tablet',
          teamId: 3,
          createdAt: '2024-01-01T00:00:00.000Z',
          liveCertificateCount: 1
        }
      ]
    });

    const res = await request(app).get('/api/devices/team/3');

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0]).toEqual({
      deviceUserId: 10,
      username: 'AUK-D7K3QMX',
      deviceLabel: 'Engine 4 Tablet',
      teamId: 3,
      createdAt: '2024-01-01T00:00:00.000Z',
      liveCertificateCount: 1
    });
    // takserver-enrollment Criterion 5.10: no email field for any device.
    expect(res.body.devices[0]).not.toHaveProperty('email');
    expect(DeviceEnrollmentService.listTeamDevices).toHaveBeenCalledWith('3', mockUser);
  });

  it('returns the team\'s devices for an authorized caller (team admin, non-global-manager)', async () => {
    asStandardUser(5);
    // The real `authorize.js` middleware and `device:read:team_admin`
    // resolver run for this route (not mocked, per this file's header
    // comment) -- its resolver calls `Team.isAdmin(teamId, userId)`,
    // which issues a real `pool.query`. `pool.query` is mocked at the
    // module boundary here, so a non-empty row set is what makes the
    // resolver's admin check resolve `true` for a standard user.
    pool.query.mockResolvedValue({ rows: [{ exists: 1 }] });
    DeviceEnrollmentService.listTeamDevices.mockResolvedValue({ devices: [] });

    const res = await request(app).get('/api/devices/team/4');

    expect(res.status).toBe(200);
    expect(res.body.devices).toEqual([]);
    expect(DeviceEnrollmentService.listTeamDevices).toHaveBeenCalledWith('4', mockUser);
  });

  it('maps DeviceEnrollmentAuthorizationError from the service to 403 for an unauthorized caller', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.listTeamDevices.mockRejectedValue(
      new DeviceEnrollmentService.DeviceEnrollmentAuthorizationError()
    );

    const res = await request(app).get('/api/devices/team/4');

    expect(res.status).toBe(403);
  });

  it('returns 400 for a non-integer teamId without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).get('/api/devices/team/not-a-number');

    expect(res.status).toBe(400);
    expect(DeviceEnrollmentService.listTeamDevices).not.toHaveBeenCalled();
  });
});

// Bugfix ("unable to edit ... a team device"): device edit route.
describe('PATCH /api/devices/:deviceUserId', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('updates a device and returns 200 with the updated device info', async () => {
    asGlobalManager();
    DeviceEnrollmentService.updateDevice.mockResolvedValue({
      deviceUserId: 10,
      username: 'AUK-D7K3QMX',
      deviceLabel: 'Renamed Tablet',
      callsignSuffix: 'Tanker1',
      teamId: 3
    });

    const res = await request(app).patch('/api/devices/10').send({
      deviceLabel: 'Renamed Tablet',
      callsignSuffix: 'Tanker1'
    });

    expect(res.status).toBe(200);
    expect(res.body.device).toEqual({
      deviceUserId: 10,
      username: 'AUK-D7K3QMX',
      deviceLabel: 'Renamed Tablet',
      callsignSuffix: 'Tanker1',
      teamId: 3
    });
    expect(DeviceEnrollmentService.updateDevice).toHaveBeenCalledWith(
      '10',
      { deviceLabel: 'Renamed Tablet', callsignSuffix: 'Tanker1' },
      mockUser
    );
  });

  it('allows a standard authenticated user to reach the handler (team-admin success case)', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.updateDevice.mockResolvedValue({
      deviceUserId: 11,
      username: 'AUK-D0000AA',
      deviceLabel: 'x',
      callsignSuffix: null,
      teamId: 4
    });

    const res = await request(app).patch('/api/devices/11').send({ deviceLabel: 'x' });

    expect(res.status).toBe(200);
    expect(DeviceEnrollmentService.updateDevice).toHaveBeenCalledWith('11', { deviceLabel: 'x', callsignSuffix: undefined }, mockUser);
  });

  it('returns 400 for a non-integer deviceUserId without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).patch('/api/devices/not-a-number').send({ deviceLabel: 'x' });

    expect(res.status).toBe(400);
    expect(DeviceEnrollmentService.updateDevice).not.toHaveBeenCalled();
  });

  it('rejects a callsignSuffix containing a disallowed character with 400, without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).patch('/api/devices/10').send({ callsignSuffix: 'Tanker 1' });

    expect(res.status).toBe(400);
    expect(DeviceEnrollmentService.updateDevice).not.toHaveBeenCalled();
  });

  it('maps DeviceEnrollmentAuthorizationError from the service to 403', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.updateDevice.mockRejectedValue(
      new DeviceEnrollmentService.DeviceEnrollmentAuthorizationError()
    );

    const res = await request(app).patch('/api/devices/10').send({ deviceLabel: 'x' });

    expect(res.status).toBe(403);
  });

  it('maps NotATeamOwnedDeviceError from the service to 400', async () => {
    asGlobalManager();
    DeviceEnrollmentService.updateDevice.mockRejectedValue(
      new DeviceEnrollmentService.NotATeamOwnedDeviceError()
    );

    const res = await request(app).patch('/api/devices/10').send({ deviceLabel: 'x' });

    expect(res.status).toBe(400);
  });

  it('maps a CallsignSuffixConflictError from the service to 400', async () => {
    asGlobalManager();
    const { CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
    DeviceEnrollmentService.updateDevice.mockRejectedValue(
      new CallsignSuffixConflictError('Tanker1')
    );

    const res = await request(app).patch('/api/devices/10').send({ callsignSuffix: 'Tanker1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Tanker1/);
  });
});

// Bugfix ("unable to ... delete a team device"): device delete route.
describe('DELETE /api/devices/:deviceUserId', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('deletes a device, writes an audit_logs row, and returns 200', async () => {
    asGlobalManager();
    DeviceEnrollmentService.deleteDevice.mockResolvedValue({ deviceUserId: 10, teamId: 3 });

    const res = await request(app).delete('/api/devices/10');

    expect(res.status).toBe(200);
    expect(DeviceEnrollmentService.deleteDevice).toHaveBeenCalledWith('10', mockUser);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO audit_logs');
    expect(params[0]).toBe(mockUser.userId);
    expect(params[1]).toBe('device.delete');
    expect(params[2]).toBe('user');
    expect(params[3]).toBe(10);
  });

  it('allows a standard authenticated user to reach the handler (team-admin success case)', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.deleteDevice.mockResolvedValue({ deviceUserId: 11, teamId: 4 });

    const res = await request(app).delete('/api/devices/11');

    expect(res.status).toBe(200);
    expect(DeviceEnrollmentService.deleteDevice).toHaveBeenCalledWith('11', mockUser);
  });

  it('returns 400 for a non-integer deviceUserId without calling the service', async () => {
    asGlobalManager();

    const res = await request(app).delete('/api/devices/not-a-number');

    expect(res.status).toBe(400);
    expect(DeviceEnrollmentService.deleteDevice).not.toHaveBeenCalled();
  });

  it('maps DeviceEnrollmentAuthorizationError from the service to 403 and writes no audit log', async () => {
    asStandardUser(5);
    DeviceEnrollmentService.deleteDevice.mockRejectedValue(
      new DeviceEnrollmentService.DeviceEnrollmentAuthorizationError()
    );

    const res = await request(app).delete('/api/devices/10');

    expect(res.status).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('maps NotATeamOwnedDeviceError from the service to 400', async () => {
    asGlobalManager();
    DeviceEnrollmentService.deleteDevice.mockRejectedValue(
      new DeviceEnrollmentService.NotATeamOwnedDeviceError()
    );

    const res = await request(app).delete('/api/devices/10');

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// Team Devices tab multi-select: bulk delete. `DeviceEnrollmentService
// .deleteDevice` already performs the REAL per-row authorization
// internally (assertAuthorized) -- this route's job is just looping it
// and reporting a per-row result, mirroring the single-item route's own
// behaviour and error mapping exactly.
describe('POST /api/devices/bulk-delete', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('returns 400 without calling the service when deviceUserIds is missing/empty/invalid', async () => {
    asGlobalManager();

    const empty = await request(app).post('/api/devices/bulk-delete').send({ deviceUserIds: [] });
    expect(empty.status).toBe(400);

    const notArray = await request(app).post('/api/devices/bulk-delete').send({ deviceUserIds: 'nope' });
    expect(notArray.status).toBe(400);

    const badId = await request(app).post('/api/devices/bulk-delete').send({ deviceUserIds: [1, 'x'] });
    expect(badId.status).toBe(400);

    expect(DeviceEnrollmentService.deleteDevice).not.toHaveBeenCalled();
  });

  it('deletes every device for a Global_Manager, writing one audit_logs row per device, and returns a per-row success result', async () => {
    asGlobalManager();
    DeviceEnrollmentService.deleteDevice
      .mockResolvedValueOnce({ deviceUserId: 10, teamId: 3 })
      .mockResolvedValueOnce({ deviceUserId: 11, teamId: 4 });

    const res = await request(app).post('/api/devices/bulk-delete').send({ deviceUserIds: [10, 11] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      successCount: 2,
      failureCount: 0,
      results: [
        { deviceUserId: 10, success: true },
        { deviceUserId: 11, success: true }
      ]
    });
    expect(DeviceEnrollmentService.deleteDevice).toHaveBeenCalledWith(10, mockUser);
    expect(DeviceEnrollmentService.deleteDevice).toHaveBeenCalledWith(11, mockUser);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("relies on the service's own per-row assertAuthorized: a DeviceEnrollmentAuthorizationError becomes that row's own failure, never a whole-request 403", async () => {
    asStandardUser(5);
    DeviceEnrollmentService.deleteDevice.mockRejectedValue(
      new DeviceEnrollmentService.DeviceEnrollmentAuthorizationError()
    );

    const res = await request(app).post('/api/devices/bulk-delete').send({ deviceUserIds: [10] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({
      deviceUserId: 10,
      success: false,
      error: expect.stringMatching(/authorization/i)
    });
  });

  it("one row's NotATeamOwnedDeviceError does not affect another row's success (per-row isolation)", async () => {
    asGlobalManager();
    DeviceEnrollmentService.deleteDevice
      .mockRejectedValueOnce(new DeviceEnrollmentService.NotATeamOwnedDeviceError())
      .mockResolvedValueOnce({ deviceUserId: 11, teamId: 4 });

    const res = await request(app).post('/api/devices/bulk-delete').send({ deviceUserIds: [10, 11] });

    expect(res.body.successCount).toBe(1);
    expect(res.body.failureCount).toBe(1);
    expect(res.body.results[0]).toEqual(
      expect.objectContaining({ deviceUserId: 10, success: false })
    );
    expect(res.body.results[1]).toEqual({ deviceUserId: 11, success: true });
  });

  it('maps an unrecognized error to a generic per-row message rather than failing the whole request', async () => {
    asGlobalManager();
    DeviceEnrollmentService.deleteDevice.mockRejectedValue(new Error('unexpected db failure'));

    const res = await request(app).post('/api/devices/bulk-delete').send({ deviceUserIds: [10] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toEqual({
      deviceUserId: 10,
      success: false,
      error: 'Failed to delete team-owned device'
    });
  });
});
