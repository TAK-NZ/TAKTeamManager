/**
 * Tests for `previewSelfEnrollment`/`previewEnrollmentQrCode` -- the
 * client-UX-correction preview counterparts to `generateSelfEnrollment`/
 * `generateEnrollmentQrCode`. Both resolve the SAME subject and apply the
 * SAME authorization rule as their full-generation counterparts, but
 * MINT NO Enrollment_Token: this is what lets the Enrollment_View render
 * its "Enrollment Data" section automatically on mount without minting a
 * live 30-minute Authentik credential just because the page loaded.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('../models/Team', () => ({
  isAdmin: jest.fn(),
  getAncestorChain: jest.fn()
}));
jest.mock('../models/User', () => ({
  findById: jest.fn()
}));
jest.mock('./TeamMembershipService', () => ({
  addUserToTeam: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));
jest.mock('./authentik', () => ({
  createUser: jest.fn(),
  createAppPasswordToken: jest.fn()
}));
jest.mock('./userAttributes', () => ({
  generateCallsign: jest.fn()
}));
jest.mock('qrcode', () => ({
  toDataURL: jest.fn()
}));
jest.mock('../config/logger', () => {
  const instance = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  instance.child = jest.fn(() => instance);
  instance.createLogger = jest.fn(() => instance);
  return instance;
});

const pool = require('../config/database');
const Team = require('../models/Team');
const User = require('../models/User');
const authentikService = require('./authentik');
const QRCode = require('qrcode');
const UserAttributesService = require('./userAttributes');
const DeviceEnrollmentService = require('./DeviceEnrollmentService');

const {
  DeviceSessionCannotSelfEnrollError,
  NotATeamOwnedDeviceError,
  DeviceEnrollmentAuthorizationError,
  TakServerNotConfiguredError
} = DeviceEnrollmentService;

const ORIGINAL_TAK_SERVER_ENROLLMENT_URL = process.env.TAK_SERVER_ENROLLMENT_URL;

describe('previewSelfEnrollment / previewEnrollmentQrCode (mint nothing)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TAK_SERVER_ENROLLMENT_URL = 'https://ops.example.com';
    UserAttributesService.generateCallsign.mockResolvedValue(null);
  });

  afterAll(() => {
    if (ORIGINAL_TAK_SERVER_ENROLLMENT_URL === undefined) {
      delete process.env.TAK_SERVER_ENROLLMENT_URL;
    } else {
      process.env.TAK_SERVER_ENROLLMENT_URL = ORIGINAL_TAK_SERVER_ENROLLMENT_URL;
    }
  });

  function mockUserAndMembershipLookup({ userRow, teamId, liveCertificateCount = 0 }) {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users WHERE id')) {
        return Promise.resolve({ rows: userRow ? [userRow] : [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: teamId !== undefined ? [{ team_id: teamId }] : [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM tak_devices')) {
        return Promise.resolve({ rows: [{ count: String(liveCertificateCount) }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  describe('previewSelfEnrollment', () => {
    const HUMAN_ROW = {
      id: 43,
      username: 'jsmith',
      authentik_user_id: 555,
      is_team_device: false,
      tak_role: 'Team Lead'
    };

    it('resolves the preview shape from req.user alone, mints no token, and calls Authentik nowhere', async () => {
      User.findById.mockResolvedValue(HUMAN_ROW);
      mockUserAndMembershipLookup({ userRow: HUMAN_ROW, teamId: 9, liveCertificateCount: 2 });
      UserAttributesService.generateCallsign.mockResolvedValue({ callsign: 'AUK-Alpha', color: 'Blue' });

      const result = await DeviceEnrollmentService.previewSelfEnrollment({ userId: 43 });

      expect(User.findById).toHaveBeenCalledWith(43);
      expect(result).toEqual({
        principalId: 43,
        principalKind: 'human',
        username: 'jsmith',
        host: 'ops.example.com',
        takAttributes: { callsign: 'AUK-Alpha', color: 'Blue', role: 'Team Lead' },
        liveCertificateCount: 2
      });

      // The load-bearing assertion: no Enrollment_Token is minted and no
      // QR code is rendered by a preview call.
      expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
      expect(QRCode.toDataURL).not.toHaveBeenCalled();

      // No secret-shaped field anywhere in the response.
      expect(result).not.toHaveProperty('expiresAt');
      expect(result).not.toHaveProperty('atakEnrollmentUri');
      expect(result).not.toHaveProperty('itakRegistrationPayload');
      expect(result).not.toHaveProperty('atakQrDataUrl');
      expect(result).not.toHaveProperty('itakQrDataUrl');
      expect(result).not.toHaveProperty('reEnrollmentDate');
    });

    it('rejects with DeviceSessionCannotSelfEnrollError when the session resolves to a Team_Owned_Device row, minting nothing', async () => {
      User.findById.mockResolvedValue({ id: 99, is_team_device: true });

      await expect(
        DeviceEnrollmentService.previewSelfEnrollment({ userId: 99 })
      ).rejects.toThrow(DeviceSessionCannotSelfEnrollError);

      expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
    });

    it('rejects with TakServerNotConfiguredError when TAK_SERVER_ENROLLMENT_URL is unset, before any Authentik call', async () => {
      delete process.env.TAK_SERVER_ENROLLMENT_URL;
      User.findById.mockResolvedValue(HUMAN_ROW);

      await expect(
        DeviceEnrollmentService.previewSelfEnrollment({ userId: 43 })
      ).rejects.toThrow(TakServerNotConfiguredError);

      expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
    });
  });

  describe('previewEnrollmentQrCode', () => {
    const DEVICE_ROW = {
      id: 42,
      username: 'AUK-DW8YK3T9',
      authentik_user_id: 987,
      is_team_device: true,
      tak_role: null
    };

    it('resolves the preview shape for a Team_Owned_Device, with teamId added back, minting no token', async () => {
      Team.isAdmin.mockResolvedValue(true);
      mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5, liveCertificateCount: 0 });

      const result = await DeviceEnrollmentService.previewEnrollmentQrCode(42, {
        userId: 1,
        is_global_manager: false
      });

      expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
      expect(result).toEqual({
        principalId: 42,
        principalKind: 'device',
        username: 'AUK-DW8YK3T9',
        host: 'ops.example.com',
        takAttributes: { callsign: null, color: null, role: null },
        liveCertificateCount: 0,
        teamId: 5
      });

      expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
      expect(QRCode.toDataURL).not.toHaveBeenCalled();
    });

    it('rejects with NotATeamOwnedDeviceError for a non-device target, minting nothing', async () => {
      mockUserAndMembershipLookup({ userRow: { id: 42, is_team_device: false }, teamId: 5 });

      await expect(
        DeviceEnrollmentService.previewEnrollmentQrCode(42, { userId: 1, is_global_manager: true })
      ).rejects.toThrow(NotATeamOwnedDeviceError);

      expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
    });

    it('rejects with DeviceEnrollmentAuthorizationError for a non-admin, non-global-manager caller, minting nothing', async () => {
      Team.isAdmin.mockResolvedValue(false);
      mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5 });

      await expect(
        DeviceEnrollmentService.previewEnrollmentQrCode(42, { userId: 3, is_global_manager: false })
      ).rejects.toThrow(DeviceEnrollmentAuthorizationError);

      expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
    });

    it('skips Team.isAdmin for a Global_Manager, minting nothing', async () => {
      mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5 });

      await DeviceEnrollmentService.previewEnrollmentQrCode(42, { userId: 1, is_global_manager: true });

      expect(Team.isAdmin).not.toHaveBeenCalled();
      expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
    });
  });
});
