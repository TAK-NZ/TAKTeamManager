/**
 * Unit tests for `DeviceEnrollmentService.createDevice` (Requirement 27
 * Criteria 2-4, task 49.2) and `DeviceEnrollmentService
 * .generateEnrollmentQrCode` (Requirement 27 Criteria 3, 5-7, task 49.3):
 *   - authorized creation by a team admin (`Team.isAdmin` true)
 *   - authorized creation by a Global_Manager (no `Team.isAdmin` call
 *     needed/short-circuited)
 *   - unauthorized rejection (neither team admin nor Global_Manager),
 *     with no Authentik call and no database write performed
 *   - authorized QR code generation by a team admin and by a
 *     Global_Manager, asserting the returned URI/payload shape
 *   - unauthorized QR-generation rejection
 *   - rejection when the target user is not a Team_Owned_Device
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('../models/Team', () => ({
  isAdmin: jest.fn()
}));
jest.mock('./TeamMembershipService', () => ({
  addUserToTeam: jest.fn()
}));
jest.mock('./authentik', () => ({
  createUser: jest.fn(),
  createAppPasswordToken: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Team = require('../models/Team');
const TeamMembershipService = require('./TeamMembershipService');
const authentikService = require('./authentik');
const DeviceEnrollmentService = require('./DeviceEnrollmentService');
const {
  DeviceEnrollmentAuthorizationError,
  NotATeamOwnedDeviceError,
  TakServerNotConfiguredError,
  DEVICE_EMAIL_DOMAIN
} = require('./DeviceEnrollmentService');

function buildMockClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ id: 42 }] }),
    release: jest.fn()
  };
}

describe('DeviceEnrollmentService.createDevice', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = buildMockClient();
    pool.connect.mockResolvedValue(mockClient);
    authentikService.createUser.mockResolvedValue({ pk: 987 });
    TeamMembershipService.addUserToTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
  });

  it('creates a device when the acting user is an admin of the target team', async () => {
    Team.isAdmin.mockResolvedValue(true);

    const result = await DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', {
      userId: 1,
      is_global_manager: false
    });

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);

    // Authentik user creation uses a synthetic, non-deliverable email
    // under the reserved devices.tak.nz.invalid subdomain.
    expect(authentikService.createUser).toHaveBeenCalledTimes(1);
    const createUserArgs = authentikService.createUser.mock.calls[0][0];
    expect(createUserArgs.email.endsWith(`@${DEVICE_EMAIL_DOMAIN}`)).toBe(true);
    expect(createUserArgs.name).toBe('Engine 4 Tablet');

    // Local users row insert sets is_team_device = true and device_label.
    const insertCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(insertCall[1]).toEqual([987, createUserArgs.username, createUserArgs.email, 'Engine 4 Tablet']);

    // addUserToTeam is called on the SAME transactional client (Requirement
    // 17.5's client-threading pattern), and BEGIN/COMMIT bracket everything.
    expect(TeamMembershipService.addUserToTeam).toHaveBeenCalledWith(42, 5, 'member', 1, mockClient);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);

    expect(result).toEqual({
      deviceUserId: 42,
      authentikUserId: 987,
      username: createUserArgs.username,
      email: createUserArgs.email,
      label: 'Engine 4 Tablet',
      teamId: 5
    });
  });

  it('creates a device when the acting user is a Global_Manager, without checking Team.isAdmin', async () => {
    const result = await DeviceEnrollmentService.createDevice(5, null, {
      userId: 2,
      is_global_manager: true
    });

    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(authentikService.createUser).toHaveBeenCalledTimes(1);
    expect(TeamMembershipService.addUserToTeam).toHaveBeenCalledWith(42, 5, 'member', 2, mockClient);
    expect(result.deviceUserId).toBe(42);
    // No label provided -> falls back to the generated username for the
    // Authentik display name, and label is reported as null.
    expect(result.label).toBeNull();
  });

  it('rejects with DeviceEnrollmentAuthorizationError and performs no Authentik call or database write when unauthorized', async () => {
    Team.isAdmin.mockResolvedValue(false);

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 3, is_global_manager: false })
    ).rejects.toThrow(DeviceEnrollmentAuthorizationError);

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 3);
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(TeamMembershipService.addUserToTeam).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows when the local transaction fails after Authentik user creation', async () => {
    Team.isAdmin.mockResolvedValue(true);
    TeamMembershipService.addUserToTeam.mockRejectedValue(new Error('team membership insert failed'));

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false })
    ).rejects.toThrow('team membership insert failed');

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});

describe('DeviceEnrollmentService.generateEnrollmentQrCode', () => {
  const DEVICE_ROW = {
    id: 42,
    username: 'device-abc123',
    authentik_user_id: 987,
    is_team_device: true
  };
  const HUMAN_ROW = {
    id: 43,
    username: 'jsmith',
    authentik_user_id: 555,
    is_team_device: false
  };

  const ORIGINAL_TAK_SERVER_URL = process.env.TAK_SERVER_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TAK_SERVER_URL = 'https://tak.example.com:8443';
    authentikService.createAppPasswordToken.mockResolvedValue({
      identifier: 'device-enrollment-xyz',
      expires: '2024-01-01T00:30:00.000Z',
      key: 'super-secret-app-password'
    });
  });

  afterAll(() => {
    if (ORIGINAL_TAK_SERVER_URL === undefined) {
      delete process.env.TAK_SERVER_URL;
    } else {
      process.env.TAK_SERVER_URL = ORIGINAL_TAK_SERVER_URL;
    }
  });

  function mockUserAndMembershipLookup({ userRow, teamId }) {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users WHERE id')) {
        return Promise.resolve({ rows: userRow ? [userRow] : [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: teamId !== undefined ? [{ team_id: teamId }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('generates an enrollment QR code for an authorized team admin', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5 });

    const result = await DeviceEnrollmentService.generateEnrollmentQrCode(42, {
      userId: 1,
      is_global_manager: false
    });

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
    expect(authentikService.createAppPasswordToken).toHaveBeenCalledWith(
      987,
      expect.objectContaining({ expiresInMinutes: 30 })
    );

    expect(result.deviceUserId).toBe(42);
    expect(result.teamId).toBe(5);
    expect(result.host).toBe('tak.example.com');
    expect(result.atakEnrollmentUri).toBe(
      'tak://com.atakmap.app/enroll?host=tak.example.com&username=device-abc123&token=super-secret-app-password'
    );
    expect(result.itakEnrollmentPayload).toEqual({
      host: 'tak.example.com',
      username: 'device-abc123',
      token: 'super-secret-app-password'
    });
  });

  it('generates an enrollment QR code for a Global_Manager, without checking Team.isAdmin', async () => {
    mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5 });

    const result = await DeviceEnrollmentService.generateEnrollmentQrCode(42, {
      userId: 2,
      is_global_manager: true
    });

    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(result.atakEnrollmentUri).toContain('tak://com.atakmap.app/enroll?');
  });

  it('rejects with DeviceEnrollmentAuthorizationError and performs no Authentik call when unauthorized', async () => {
    Team.isAdmin.mockResolvedValue(false);
    mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5 });

    await expect(
      DeviceEnrollmentService.generateEnrollmentQrCode(42, { userId: 3, is_global_manager: false })
    ).rejects.toThrow(DeviceEnrollmentAuthorizationError);

    expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
  });

  it('rejects with NotATeamOwnedDeviceError when the target user is not a Team_Owned_Device', async () => {
    mockUserAndMembershipLookup({ userRow: HUMAN_ROW, teamId: 5 });

    await expect(
      DeviceEnrollmentService.generateEnrollmentQrCode(43, { userId: 2, is_global_manager: true })
    ).rejects.toThrow(NotATeamOwnedDeviceError);

    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
  });

  it('rejects with NotATeamOwnedDeviceError when deviceUserId does not exist', async () => {
    mockUserAndMembershipLookup({ userRow: undefined, teamId: undefined });

    await expect(
      DeviceEnrollmentService.generateEnrollmentQrCode(999, { userId: 2, is_global_manager: true })
    ).rejects.toThrow(NotATeamOwnedDeviceError);
  });

  it('rejects with TakServerNotConfiguredError when TAK_SERVER_URL is unset', async () => {
    delete process.env.TAK_SERVER_URL;
    mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5 });

    await expect(
      DeviceEnrollmentService.generateEnrollmentQrCode(42, { userId: 2, is_global_manager: true })
    ).rejects.toThrow(TakServerNotConfiguredError);

    expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
  });
});
