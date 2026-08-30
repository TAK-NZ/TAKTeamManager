/**
 * Unit tests for `DeviceEnrollmentService.createDevice` (takserver-
 * enrollment Requirements 1.3, 5.1, 5.2, 14.1, 14.2, 14.3, 14.4, 14.8,
 * 14.9 -- the Claim_Row/Managed_Identifier re-phasing, task 6.1) and
 * `DeviceEnrollmentService.generateEnrollmentQrCode` (Requirement 27
 * Criteria 3, 5-7, task 49.3, untouched by this task):
 *   - authorized creation by a team admin (`Team.isAdmin` true), minting
 *     a `D`-marker Managed_Identifier and sending Authentik a create-user
 *     body with NO `email` key at all
 *   - authorized creation by a Global_Manager (no `Team.isAdmin` call
 *     needed/short-circuited)
 *   - unauthorized rejection (neither team admin nor Global_Manager),
 *     with no Organisation resolution, no Claim_Row insert, no Authentik
 *     call and no database write performed
 *   - a missing/invalid Organisation_Prefix fails before any Claim_Row
 *     insert and before any Authentik call (Criterion 2.9)
 *   - a Phase-1 (Authentik) failure compensates by deleting the Claim_Row
 *     only, scoped by `authentik_user_id IS NULL`
 *   - a Phase-2 (adopt/attach) failure rolls back the transaction and
 *     compensates by deleting the Claim_Row AND the now-orphaned
 *     Authentik user
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
  isAdmin: jest.fn(),
  getAncestorChain: jest.fn(),
  getFullMemberList: jest.fn()
}));
jest.mock('./TeamMembershipService', () => ({
  addUserToTeam: jest.fn(),
  removeUserFromTeam: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));
jest.mock('./authentik', () => ({
  createUser: jest.fn(),
  createAppPasswordToken: jest.fn()
}));
jest.mock('../models/User', () => ({
  findById: jest.fn(),
  update: jest.fn()
}));
jest.mock('./userAttributes', () => ({
  generateCallsign: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Team = require('../models/Team');
const User = require('../models/User');
const TeamMembershipService = require('./TeamMembershipService');
const EventPublisher = require('./EventPublisher');
const authentikService = require('./authentik');
const UserAttributesService = require('./userAttributes');
const ManagedIdentifierService = require('./ManagedIdentifierService');
const { isManagedIdentifier } = require('../utils/managedIdentifier');
const DeviceEnrollmentService = require('./DeviceEnrollmentService');
const {
  DeviceEnrollmentAuthorizationError,
  NotATeamOwnedDeviceError,
  DeviceSessionCannotSelfEnrollError,
  TakServerNotConfiguredError
} = require('./DeviceEnrollmentService');
const { CallsignSuffixConflictError } = require('./CallsignSuffixUniquenessService');

function buildMockClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn()
  };
}

/**
 * Builds a `pool.query` mock dispatching on SQL text, matching how
 * `createDevice`'s Phase 0 claim and its compensating DELETE both run
 * against the shared `pool` (never a transactional client).
 *
 * @param {object} [opts]
 * @param {*} [opts.claimResult] resolved value for the Claim_Row INSERT.
 *   Defaults to `{ rows: [{ id: 42 }] }`.
 * @param {Error} [opts.claimRejection] when set, the claim INSERT rejects
 *   with this error instead of resolving.
 * @param {*} [opts.deleteResult] resolved value for the compensating
 *   DELETE. Defaults to `{ rowCount: 1 }`.
 */
function buildPoolQueryMock({
  claimResult = { rows: [{ id: 42 }] },
  claimRejection,
  deleteResult = { rowCount: 1 }
} = {}) {
  return jest.fn((sql) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
      return claimRejection ? Promise.reject(claimRejection) : Promise.resolve(claimResult);
    }
    if (typeof sql === 'string' && sql.includes('DELETE FROM users WHERE id')) {
      return Promise.resolve(deleteResult);
    }
    return Promise.resolve({ rows: [] });
  });
}

const ORGANISATION_ROW = {
  id: 9,
  parent_team_id: null,
  callsign_prefix: 'AUK',
  depth: 0
};

describe('DeviceEnrollmentService.createDevice', () => {
  let mockClient;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    mockClient = buildMockClient();
    pool.connect.mockResolvedValue(mockClient);
    pool.query.mockImplementation(buildPoolQueryMock());
    Team.getAncestorChain.mockResolvedValue([ORGANISATION_ROW]);
    // Real `checkCallsignSuffixUniqueness` (not mocked here) calls
    // `Team.getFullMemberList` -- an empty roster means no collision for
    // every test that doesn't explicitly set up one.
    Team.getFullMemberList.mockResolvedValue([]);
    authentikService.createUser.mockResolvedValue({ pk: 987 });
    TeamMembershipService.addUserToTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('creates a device when the acting user is an admin of the target team, minting a D-marker Managed_Identifier and sending Authentik no email key at all', async () => {
    Team.isAdmin.mockResolvedValue(true);

    const result = await DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', {
      userId: 1,
      is_global_manager: false
    });

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(5);

    // Claim_Row insert (Phase 0): the candidate username, authentik_user_id
    // NULL, is_active false, is_team_device true, email NULL, device_label
    // set -- against the shared pool, no transaction.
    const claimCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(claimCall[0]).toMatch(/authentik_user_id.*is_active.*is_team_device.*email.*device_label/s);
    const [candidateUsername, deviceLabelParam] = claimCall[1];
    expect(isManagedIdentifier(candidateUsername)).toBe(true);
    expect(candidateUsername.startsWith('AUK-D')).toBe(true);
    expect(deviceLabelParam).toBe('Engine 4 Tablet');

    // Authentik user creation uses the CLAIMED username, and the request
    // body carries NO email key at all -- not `email: undefined`, a
    // genuinely absent key. Both the own-property check and the
    // serialized-form check are required: an `email: undefined` property
    // would pass a JSON.stringify-only check but fail hasOwnProperty.
    expect(authentikService.createUser).toHaveBeenCalledTimes(1);
    const createUserArgs = authentikService.createUser.mock.calls[0][0];
    expect(createUserArgs.username).toBe(candidateUsername);
    expect(createUserArgs.name).toBe('Engine 4 Tablet');
    expect(Object.prototype.hasOwnProperty.call(createUserArgs, 'email')).toBe(false);
    expect('email' in createUserArgs).toBe(false);
    expect(JSON.stringify(createUserArgs)).not.toContain('"email"');

    // Phase 2: one client, one transaction, adopting the Claim_Row and
    // attaching team membership on the SAME client.
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith(
      'UPDATE users SET authentik_user_id = $1, is_active = true WHERE id = $2',
      [987, 42]
    );
    expect(TeamMembershipService.addUserToTeam).toHaveBeenCalledWith(42, 5, 'member', 1, mockClient);
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);

    // No compensation ran on the success path.
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM users'))).toBe(false);

    expect(result).toEqual({
      deviceUserId: 42,
      authentikUserId: 987,
      username: candidateUsername,
      label: 'Engine 4 Tablet',
      callsignSuffix: null,
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
    // No label provided -> falls back to the minted username for the
    // Authentik display name, and label is reported as null.
    expect(result.label).toBeNull();
  });

  it('writes the supplied callsignSuffix into the Claim_Row INSERT and echoes it back on the result', async () => {
    Team.isAdmin.mockResolvedValue(true);

    const result = await DeviceEnrollmentService.createDevice(
      5,
      'Engine 4 Tablet',
      { userId: 1, is_global_manager: false },
      'Tanker1'
    );

    expect(Team.getFullMemberList).toHaveBeenCalledWith(5);

    const claimCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(claimCall[1][2]).toBe('Tanker1');
    expect(result.callsignSuffix).toBe('Tanker1');
  });

  it('trims a supplied callsignSuffix before checking uniqueness and before writing it', async () => {
    Team.isAdmin.mockResolvedValue(true);

    const result = await DeviceEnrollmentService.createDevice(
      5,
      'Engine 4 Tablet',
      { userId: 1, is_global_manager: false },
      '  Tanker1  '
    );

    const claimCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(claimCall[1][2]).toBe('Tanker1');
    expect(result.callsignSuffix).toBe('Tanker1');
  });

  it('treats a null/empty callsignSuffix as absent -- no collision check against the roster, and NULL written', async () => {
    Team.isAdmin.mockResolvedValue(true);

    const result = await DeviceEnrollmentService.createDevice(
      5,
      'Engine 4 Tablet',
      { userId: 1, is_global_manager: false },
      ''
    );

    // checkCallsignSuffixUniqueness short-circuits on a falsy candidate
    // without even calling Team.getFullMemberList.
    expect(Team.getFullMemberList).not.toHaveBeenCalled();
    const claimCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(claimCall[1][2]).toBeNull();
    expect(result.callsignSuffix).toBeNull();
  });

  it('rejects with CallsignSuffixConflictError, mints no identifier and performs no Authentik call, when the callsignSuffix collides with an existing team member', async () => {
    Team.isAdmin.mockResolvedValue(true);
    Team.getFullMemberList.mockResolvedValue([
      { id: 100, callsign_suffix: 'Tanker1' }
    ]);

    await expect(
      DeviceEnrollmentService.createDevice(
        5,
        'Engine 4 Tablet',
        { userId: 1, is_global_manager: false },
        'tanker1'
      )
    ).rejects.toThrow(CallsignSuffixConflictError);

    expect(pool.query).not.toHaveBeenCalled();
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects with CallsignSuffixConflictError when the callsignSuffix collides with an existing team-owned device (a users row via team_memberships, same table the check already queries)', async () => {
    Team.isAdmin.mockResolvedValue(true);
    Team.getFullMemberList.mockResolvedValue([
      { id: 101, callsign_suffix: 'Truck2', is_team_device: true }
    ]);

    await expect(
      DeviceEnrollmentService.createDevice(
        5,
        'Spare Tablet',
        { userId: 1, is_global_manager: false },
        'Truck2'
      )
    ).rejects.toThrow(CallsignSuffixConflictError);

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects with DeviceEnrollmentAuthorizationError and resolves no Organisation, mints nothing, and performs no Authentik call or database write when unauthorized', async () => {
    Team.isAdmin.mockResolvedValue(false);

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 3, is_global_manager: false })
    ).rejects.toThrow(DeviceEnrollmentAuthorizationError);

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 3);
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(TeamMembershipService.addUserToTeam).not.toHaveBeenCalled();
  });

  it('rejects with OrganisationPrefixMissingError and mints no identifier when the Organisation carries no valid callsign_prefix', async () => {
    Team.isAdmin.mockResolvedValue(true);
    Team.getAncestorChain.mockResolvedValue([{ ...ORGANISATION_ROW, callsign_prefix: null }]);

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false })
    ).rejects.toThrow(ManagedIdentifierService.OrganisationPrefixMissingError);

    expect(pool.query).not.toHaveBeenCalled();
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('compensates by deleting only the Claim_Row (authentik_user_id IS NULL) on a Phase-1 Authentik failure, and never calls the Authentik delete endpoint', async () => {
    Team.isAdmin.mockResolvedValue(true);
    pool.query.mockImplementation(buildPoolQueryMock({ claimResult: { rows: [{ id: 77 }] } }));
    authentikService.createUser.mockRejectedValue(new Error('Authentik unreachable'));
    global.fetch = jest.fn();

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false })
    ).rejects.toThrow('Authentik unreachable');

    // The compensating DELETE's WHERE clause must carry
    // `authentik_user_id IS NULL` -- that predicate is the entire safety
    // of the statement, since it is what stops it ever reaching a row
    // that already acquired a federated counterpart.
    const deleteCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM users WHERE id')
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain('authentik_user_id IS NULL');
    expect(deleteCall[1]).toEqual([77]);

    // Phase 1 never succeeded, so there is no orphaned Authentik user to
    // compensate for, and no transaction was ever opened.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('rolls back and compensates by deleting the Claim_Row AND the orphaned Authentik user on a Phase-2 adopt/attach failure', async () => {
    Team.isAdmin.mockResolvedValue(true);
    pool.query.mockImplementation(buildPoolQueryMock({ claimResult: { rows: [{ id: 88 }] } }));
    authentikService.createUser.mockResolvedValue({ pk: 555 });
    TeamMembershipService.addUserToTeam.mockRejectedValue(new Error('team membership insert failed'));
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false })
    ).rejects.toThrow('team membership insert failed');

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);

    // Both compensations run, beside each other, scoped by the SAME
    // authentik_user_id IS NULL predicate so they cannot conflict over
    // the same row.
    const deleteCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM users WHERE id')
    );
    expect(deleteCall[0]).toContain('authentik_user_id IS NULL');
    expect(deleteCall[1]).toEqual([88]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [deleteUrl, deleteOptions] = global.fetch.mock.calls[0];
    expect(deleteUrl).toContain('/core/users/555/');
    expect(deleteOptions.method).toBe('DELETE');
  });

  it('falls back to a queued cleanup operation when the synchronous Authentik delete also fails on a Phase-2 failure', async () => {
    Team.isAdmin.mockResolvedValue(true);
    pool.query.mockImplementation(buildPoolQueryMock({ claimResult: { rows: [{ id: 99 }] } }));
    authentikService.createUser.mockResolvedValue({ pk: 321 });
    TeamMembershipService.addUserToTeam.mockRejectedValue(new Error('team membership insert failed'));
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false })
    ).rejects.toThrow('team membership insert failed');

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'cleanup_orphaned_authentik_user',
      { authentik_user_id: 321 },
      null
    );
  });
});

describe('DeviceEnrollmentService.generateEnrollmentQrCode', () => {
  const DEVICE_ROW = {
    id: 42,
    username: 'device-abc123',
    authentik_user_id: 987,
    is_team_device: true,
    tak_role: null
  };
  const HUMAN_ROW = {
    id: 43,
    username: 'jsmith',
    authentik_user_id: 555,
    is_team_device: false
  };

  const ORIGINAL_TAK_SERVER_ENROLLMENT_URL = process.env.TAK_SERVER_ENROLLMENT_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TAK_SERVER_ENROLLMENT_URL = 'https://tak.example.com:8443';
    authentikService.createAppPasswordToken.mockResolvedValue({
      identifier: 'device-enrollment-xyz',
      expires: '2024-01-01T00:30:00.000Z',
      key: 'super-secret-app-password'
    });
    UserAttributesService.generateCallsign.mockResolvedValue(null);
  });

  afterAll(() => {
    if (ORIGINAL_TAK_SERVER_ENROLLMENT_URL === undefined) {
      delete process.env.TAK_SERVER_ENROLLMENT_URL;
    } else {
      process.env.TAK_SERVER_ENROLLMENT_URL = ORIGINAL_TAK_SERVER_ENROLLMENT_URL;
    }
  });

  // `#buildEnrollment`'s membership lookup re-runs the SAME
  // `team_memberships` query `generateEnrollmentQrCode` already ran, so
  // this mock must keep answering it the second time too; and it now
  // also answers the `tak_devices` live-certificate-count query.
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

  it('generates an enrollment for an authorized team admin, routed through #buildEnrollment\'s corrected shape, with teamId added back', async () => {
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

    // takserver-enrollment task 7.2: the return shape is #buildEnrollment's
    // full, corrected object, with teamId added back explicitly since
    // #buildEnrollment resolves it internally but does not return it.
    expect(result.principalId).toBe(42);
    expect(result.principalKind).toBe('device');
    expect(result.teamId).toBe(5);
    expect(result.host).toBe('tak.example.com');
    expect(result.username).toBe('device-abc123');
    expect(result.atakEnrollmentUri).toBe(
      'tak://com.atakmap.app/enroll?host=tak.example.com&username=device-abc123&token=super-secret-app-password'
    );

    // The corrected iTAK payload (Correction 3), NOT the old
    // { host, username, token } shape.
    expect(result.itakRegistrationPayload).toMatchObject({
      passphrase: 'false',
      type: 'registration',
      serverCredentials: { connectionString: 'tak.example.com:8089:ssl' },
      userCredentials: {
        username: 'device-abc123',
        password: 'super-secret-app-password'
      }
    });
    expect(result).not.toHaveProperty('itakEnrollmentPayload');

    // The richer fields #buildEnrollment adds are exposed, not truncated.
    expect(result.reEnrollmentDate).toBeDefined();
    expect(result.atakQrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.itakQrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.takAttributes).toEqual({ callsign: 'None', color: 'None', role: 'None' });
    expect(result.liveCertificateCount).toBe(0);
  });

  it('generates an enrollment for a Global_Manager, without checking Team.isAdmin', async () => {
    mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5 });

    const result = await DeviceEnrollmentService.generateEnrollmentQrCode(42, {
      userId: 2,
      is_global_manager: true
    });

    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(result.atakEnrollmentUri).toContain('tak://com.atakmap.app/enroll?');
    expect(result.teamId).toBe(5);
  });

  it('rejects with DeviceEnrollmentAuthorizationError and performs no Authentik call when unauthorized', async () => {
    Team.isAdmin.mockResolvedValue(false);
    mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5 });

    await expect(
      DeviceEnrollmentService.generateEnrollmentQrCode(42, { userId: 3, is_global_manager: false })
    ).rejects.toThrow(DeviceEnrollmentAuthorizationError);

    expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
  });

  // This is the route's SCOPING rule per Criterion 3.3, not a capability
  // limit on #buildEnrollment -- see NotATeamOwnedDeviceError's doc
  // comment. Do not delete this test alongside the guard: the only
  // subject kind a caller may address BY ID through this method is a
  // Team_Owned_Device, because widening it to a human target would force
  // an "is the caller an admin of that human's team" rule, which
  // contradicts Criterion 3.3's "deny every request whose target is any
  // other account".
  it('rejects with NotATeamOwnedDeviceError when the target user is not a Team_Owned_Device (Criterion 3.3 scoping rule)', async () => {
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

  it('rejects with TakServerNotConfiguredError when TAK_SERVER_ENROLLMENT_URL is unset', async () => {
    delete process.env.TAK_SERVER_ENROLLMENT_URL;
    mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5 });

    await expect(
      DeviceEnrollmentService.generateEnrollmentQrCode(42, { userId: 2, is_global_manager: true })
    ).rejects.toThrow(TakServerNotConfiguredError);

    expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
  });
});

describe('DeviceEnrollmentService.generateSelfEnrollment', () => {
  const HUMAN_ROW = {
    id: 43,
    username: 'jsmith',
    authentik_user_id: 555,
    is_team_device: false,
    tak_role: 'Team Member'
  };
  const DEVICE_ROW = {
    id: 42,
    username: 'AUK-D7K3QMX',
    authentik_user_id: 987,
    is_team_device: true
  };

  const ORIGINAL_TAK_SERVER_ENROLLMENT_URL = process.env.TAK_SERVER_ENROLLMENT_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TAK_SERVER_ENROLLMENT_URL = 'https://tak.example.com:8443';
    authentikService.createAppPasswordToken.mockResolvedValue({
      identifier: 'device-enrollment-xyz',
      expires: '2024-01-01T00:30:00.000Z',
      key: 'super-secret-app-password'
    });
    UserAttributesService.generateCallsign.mockResolvedValue(null);
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM tak_devices')) {
        return Promise.resolve({ rows: [{ count: '0' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  });

  afterAll(() => {
    if (ORIGINAL_TAK_SERVER_ENROLLMENT_URL === undefined) {
      delete process.env.TAK_SERVER_ENROLLMENT_URL;
    } else {
      process.env.TAK_SERVER_ENROLLMENT_URL = ORIGINAL_TAK_SERVER_ENROLLMENT_URL;
    }
  });

  it('resolves the subject from actingUser.userId ALONE and builds an enrollment for it, with no team/admin check', async () => {
    User.findById.mockResolvedValue(HUMAN_ROW);

    const result = await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });

    expect(User.findById).toHaveBeenCalledWith(43);
    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(result.principalId).toBe(43);
    expect(result.principalKind).toBe('human');
    expect(result.username).toBe('jsmith');
    expect(authentikService.createAppPasswordToken).toHaveBeenCalledWith(
      555,
      expect.objectContaining({ expiresInMinutes: 30 })
    );
  });

  it('rejects with DeviceSessionCannotSelfEnrollError, and mints no token, when the session resolves to a Team_Owned_Device row (Criterion 14.5)', async () => {
    User.findById.mockResolvedValue(DEVICE_ROW);

    await expect(
      DeviceEnrollmentService.generateSelfEnrollment({ userId: 42, is_global_manager: false })
    ).rejects.toThrow(DeviceSessionCannotSelfEnrollError);

    expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
  });

  it('never reads a caller-supplied subject id -- the same session always resolves to the same row via User.findById(actingUser.userId)', async () => {
    User.findById.mockResolvedValue(HUMAN_ROW);

    await DeviceEnrollmentService.generateSelfEnrollment({
      userId: 43,
      is_global_manager: false,
      // Hostile extra keys a caller might smuggle in; none of them may
      // ever reach User.findById.
      body: { userId: 999, deviceUserId: 999 }
    });

    expect(User.findById).toHaveBeenCalledTimes(1);
    expect(User.findById).toHaveBeenCalledWith(43);
  });
});

describe('DeviceEnrollmentService.listTeamDevices', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockDevicesQuery(rows) {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users u')) {
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('lists a team\'s devices for an authorized team admin, in the documented shape with no email field anywhere', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([
      {
        device_user_id: 42,
        username: 'AUK-D7K3QMX',
        device_label: 'Engine 4 Tablet',
        created_at: '2024-01-01T00:00:00.000Z',
        live_certificate_count: 0
      }
    ]);

    const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
    expect(result).toEqual({
      devices: [
        {
          deviceUserId: 42,
          username: 'AUK-D7K3QMX',
          deviceLabel: 'Engine 4 Tablet',
          teamId: 5,
          createdAt: '2024-01-01T00:00:00.000Z',
          liveCertificateCount: 0
        }
      ]
    });
    expect(result.devices[0]).not.toHaveProperty('email');
    expect(JSON.stringify(result)).not.toContain('"email"');
  });

  it('lists a team\'s devices for a Global_Manager, without checking Team.isAdmin', async () => {
    mockDevicesQuery([
      {
        device_user_id: 7,
        username: 'AUK-D2M4XYZ',
        device_label: null,
        created_at: '2024-02-02T00:00:00.000Z',
        live_certificate_count: 3
      }
    ]);

    const result = await DeviceEnrollmentService.listTeamDevices(9, { userId: 2, is_global_manager: true });

    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(result.devices).toEqual([
      {
        deviceUserId: 7,
        username: 'AUK-D2M4XYZ',
        deviceLabel: null,
        teamId: 9,
        createdAt: '2024-02-02T00:00:00.000Z',
        liveCertificateCount: 3
      }
    ]);
  });

  it('rejects with DeviceEnrollmentAuthorizationError and executes no query when the acting user is neither a team admin nor a Global_Manager', async () => {
    Team.isAdmin.mockResolvedValue(false);

    await expect(
      DeviceEnrollmentService.listTeamDevices(5, { userId: 3, is_global_manager: false })
    ).rejects.toThrow(DeviceEnrollmentAuthorizationError);

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 3);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns an empty array for a team with zero Team_Owned_Devices', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([]);

    const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    expect(result).toEqual({ devices: [] });
  });

  it('resolves liveCertificateCount for devices with 0, 1 and 2+ live (non-revoked) certificates via ONE derived-table join, in a single query call for the whole listing', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([
      { device_user_id: 1, username: 'AUK-D0000AA', device_label: null, created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 0 },
      { device_user_id: 2, username: 'AUK-D0000BB', device_label: null, created_at: '2024-01-02T00:00:00.000Z', live_certificate_count: 1 },
      { device_user_id: 3, username: 'AUK-D0000CC', device_label: null, created_at: '2024-01-03T00:00:00.000Z', live_certificate_count: 2 }
    ]);

    const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    expect(result.devices.map((d) => d.liveCertificateCount)).toEqual([0, 1, 2]);
    // No N+1: exactly one pool.query call resolves the whole list,
    // independent of how many devices it returns.
    expect(pool.query).toHaveBeenCalledTimes(1);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('COUNT(*)::int AS live_certificate_count');
    expect(sql).toContain('revoked = false');
    expect(sql).toContain('COALESCE(certs.live_certificate_count, 0)');
  });

  it('never selects an email column, structurally, on top of the returned shape carrying none', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([]);

    await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    const [sql] = pool.query.mock.calls[0];
    expect(sql.toLowerCase()).not.toMatch(/\bemail\b/);
  });

  it('scopes the listing to direct membership and Team_Owned_Devices only, echoing back the teamId parameter rather than re-deriving it per row', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([
      { device_user_id: 42, username: 'AUK-D7K3QMX', device_label: 'Engine 4 Tablet', created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 0 }
    ]);

    const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('inherited_from_team_id IS NULL');
    expect(sql).toContain('is_team_device = true');
    expect(params).toEqual([5]);
    expect(result.devices.every((d) => d.teamId === 5)).toBe(true);
  });
});

/**
 * Bugfix ("unable to edit ... a team device"): unit tests for
 * `DeviceEnrollmentService.updateDevice`.
 */
describe('DeviceEnrollmentService.updateDevice', () => {
  function mockDeviceLookup({ deviceRow = { id: 42, username: 'AUK-D7K3QMX', is_team_device: true }, teamId = 5 } = {}) {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, username, is_team_device FROM users')) {
        return Promise.resolve({ rows: deviceRow ? [deviceRow] : [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: teamId !== undefined ? [{ team_id: teamId }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    Team.getFullMemberList.mockResolvedValue([]);
  });

  it('updates deviceLabel and callsignSuffix for an authorized team admin, returning the updated row', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDeviceLookup();
    User.update.mockResolvedValue({
      id: 42,
      username: 'AUK-D7K3QMX',
      device_label: 'Renamed Tablet',
      callsign_suffix: 'Tanker1'
    });

    const result = await DeviceEnrollmentService.updateDevice(
      42,
      { deviceLabel: 'Renamed Tablet', callsignSuffix: 'Tanker1' },
      { userId: 1, is_global_manager: false }
    );

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
    expect(User.update).toHaveBeenCalledWith(42, { device_label: 'Renamed Tablet', callsign_suffix: 'Tanker1' });
    expect(result).toEqual({
      deviceUserId: 42,
      username: 'AUK-D7K3QMX',
      deviceLabel: 'Renamed Tablet',
      callsignSuffix: 'Tanker1',
      teamId: 5
    });
  });

  it('leaves a field untouched (no key in the User.update call) when it is not supplied', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDeviceLookup();
    User.update.mockResolvedValue({ id: 42, username: 'AUK-D7K3QMX', device_label: 'Old Label', callsign_suffix: null });

    await DeviceEnrollmentService.updateDevice(42, { deviceLabel: 'New Label' }, { userId: 1, is_global_manager: false });

    expect(User.update).toHaveBeenCalledWith(42, { device_label: 'New Label' });
  });

  it('checks callsignSuffix uniqueness before writing, excluding the device\'s own row from the comparison', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDeviceLookup();
    Team.getFullMemberList.mockResolvedValue([{ id: 42, callsign_suffix: 'Tanker1' }]);
    User.update.mockResolvedValue({ id: 42, username: 'AUK-D7K3QMX', device_label: null, callsign_suffix: 'Tanker1' });

    await DeviceEnrollmentService.updateDevice(42, { callsignSuffix: 'Tanker1' }, { userId: 1, is_global_manager: false });

    expect(User.update).toHaveBeenCalledWith(42, { callsign_suffix: 'Tanker1' });
  });

  it('rejects with CallsignSuffixConflictError and performs no write when callsignSuffix collides with another team member/device', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDeviceLookup();
    Team.getFullMemberList.mockResolvedValue([{ id: 99, callsign_suffix: 'Tanker1' }]);

    await expect(
      DeviceEnrollmentService.updateDevice(42, { callsignSuffix: 'Tanker1' }, { userId: 1, is_global_manager: false })
    ).rejects.toThrow(CallsignSuffixConflictError);

    expect(User.update).not.toHaveBeenCalled();
  });

  it('rejects with NotATeamOwnedDeviceError for a non-device target', async () => {
    mockDeviceLookup({ deviceRow: { id: 42, username: 'jsmith', is_team_device: false } });

    await expect(
      DeviceEnrollmentService.updateDevice(42, { deviceLabel: 'x' }, { userId: 1, is_global_manager: false })
    ).rejects.toThrow(NotATeamOwnedDeviceError);

    expect(Team.isAdmin).not.toHaveBeenCalled();
  });

  it('rejects with NotATeamOwnedDeviceError when no matching users row exists at all', async () => {
    mockDeviceLookup({ deviceRow: null });

    await expect(
      DeviceEnrollmentService.updateDevice(999, { deviceLabel: 'x' }, { userId: 1, is_global_manager: false })
    ).rejects.toThrow(NotATeamOwnedDeviceError);
  });

  it('rejects with DeviceEnrollmentAuthorizationError and performs no write when the acting user is neither a team admin nor a Global_Manager', async () => {
    Team.isAdmin.mockResolvedValue(false);
    mockDeviceLookup();

    await expect(
      DeviceEnrollmentService.updateDevice(42, { deviceLabel: 'x' }, { userId: 3, is_global_manager: false })
    ).rejects.toThrow(DeviceEnrollmentAuthorizationError);

    expect(User.update).not.toHaveBeenCalled();
  });

  it('updates without checking Team.isAdmin for a Global_Manager', async () => {
    mockDeviceLookup();
    User.update.mockResolvedValue({ id: 42, username: 'AUK-D7K3QMX', device_label: 'x', callsign_suffix: null });

    await DeviceEnrollmentService.updateDevice(42, { deviceLabel: 'x' }, { userId: 2, is_global_manager: true });

    expect(Team.isAdmin).not.toHaveBeenCalled();
  });
});

/**
 * Bugfix ("unable to ... delete a team device"): unit tests for
 * `DeviceEnrollmentService.deleteDevice`.
 */
describe('DeviceEnrollmentService.deleteDevice', () => {
  let originalFetch;

  function mockDeviceLookup({ deviceRow = { id: 42, username: 'AUK-D7K3QMX', authentik_user_id: 555, is_team_device: true }, teamId = 5 } = {}) {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT id, username, authentik_user_id, is_team_device FROM users')) {
        return Promise.resolve({ rows: deviceRow ? [deviceRow] : [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: teamId !== undefined ? [{ team_id: teamId }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    TeamMembershipService.removeUserFromTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('deletes an authorized device: removes team/channel memberships, deletes the Authentik user, and deletes the local users/user_cache rows', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDeviceLookup();

    const result = await DeviceEnrollmentService.deleteDevice(42, { userId: 1, is_global_manager: false });

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
    expect(TeamMembershipService.removeUserFromTeam).toHaveBeenCalledWith(42, 1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/core/users/555/'),
      expect.objectContaining({ method: 'DELETE' })
    );
    const deleteCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM')
    );
    expect(deleteCalls.some(([sql]) => sql.includes('user_cache'))).toBe(true);
    expect(deleteCalls.some(([sql]) => sql.includes('FROM users'))).toBe(true);
    expect(result).toEqual({ deviceUserId: 42, teamId: 5 });
  });

  it('rejects with NotATeamOwnedDeviceError for a non-device target, performing no delegated removal', async () => {
    mockDeviceLookup({ deviceRow: { id: 42, username: 'jsmith', authentik_user_id: 555, is_team_device: false } });

    await expect(
      DeviceEnrollmentService.deleteDevice(42, { userId: 1, is_global_manager: false })
    ).rejects.toThrow(NotATeamOwnedDeviceError);

    expect(TeamMembershipService.removeUserFromTeam).not.toHaveBeenCalled();
  });

  it('rejects with DeviceEnrollmentAuthorizationError and performs no delegated removal when the acting user is neither a team admin nor a Global_Manager', async () => {
    Team.isAdmin.mockResolvedValue(false);
    mockDeviceLookup();

    await expect(
      DeviceEnrollmentService.deleteDevice(42, { userId: 3, is_global_manager: false })
    ).rejects.toThrow(DeviceEnrollmentAuthorizationError);

    expect(TeamMembershipService.removeUserFromTeam).not.toHaveBeenCalled();
  });

  it('deletes without checking Team.isAdmin for a Global_Manager', async () => {
    mockDeviceLookup();

    await DeviceEnrollmentService.deleteDevice(42, { userId: 2, is_global_manager: true });

    expect(Team.isAdmin).not.toHaveBeenCalled();
  });

  it('still deletes the local rows when the Authentik delete call itself fails (logged, not rethrown)', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDeviceLookup();
    global.fetch = jest.fn().mockRejectedValue(new Error('Authentik unreachable'));

    const result = await DeviceEnrollmentService.deleteDevice(42, { userId: 1, is_global_manager: false });

    expect(result).toEqual({ deviceUserId: 42, teamId: 5 });
    const deleteCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM users')
    );
    expect(deleteCalls.length).toBeGreaterThan(0);
  });
});
