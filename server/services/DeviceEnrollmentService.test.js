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
  getFullMemberList: jest.fn(),
  getManagedTeamIds: jest.fn()
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
jest.mock('./DirectoryScopeService', () => ({
  resolveScope: jest.fn(),
  UNSCOPED: Object.freeze({ unscoped: true }),
  TEAM_ROOT_CTE: 'SELECT id AS team_id, id AS root_id, name AS root_name, callsign_prefix AS root_callsign_prefix, parent_team_id FROM teams'
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
const DirectoryScopeService = require('./DirectoryScopeService');
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

    // device-management follow-up: a Team_Owned_Device is created as an
    // Authentik service_account, not the createUser default of
    // 'internal' -- a device has no email and never interactively logs
    // in; it authenticates only via the app-password token
    // `generateEnrollmentQrCode`/`generateSelfEnrollment` mint for it
    // later, exactly the shape `service_account` is for.
    expect(createUserArgs.type).toBe('service_account');

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
  // `priorLiveCertRows` answers cert-expiry-notifications'
  // Superseding_Revoke lookup (`SELECT cert_id FROM tak_devices WHERE
  // user_id = $1 AND revoked = false`) -- distinct from the pre-existing
  // `count(*)` liveCertificateCount read this helper already answered.
  // Defaults to [] ("no prior live certificate") so every pre-existing
  // call site of this helper is unaffected.
  function mockUserAndMembershipLookup({ userRow, teamId, liveCertificateCount = 0, priorLiveCertRows = [] }) {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users WHERE id')) {
        return Promise.resolve({ rows: userRow ? [userRow] : [] });
      }
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: teamId !== undefined ? [{ team_id: teamId }] : [] });
      }
      if (typeof sql === 'string' && sql.includes('count(*)') && sql.includes('FROM tak_devices')) {
        return Promise.resolve({ rows: [{ count: String(liveCertificateCount) }] });
      }
      if (typeof sql === 'string' && sql.includes('cert_id') && sql.includes('FROM tak_devices')) {
        return Promise.resolve({ rows: priorLiveCertRows });
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

  /**
   * cert-expiry-notifications Requirement 8 (task 9.6): the same
   * Superseding_Revoke enqueue, for the Team-Owned_Device path.
   */
  describe('Superseding_Revoke enqueue (cert-expiry-notifications Requirement 8)', () => {
    async function flushMicrotasks() {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    it('enqueues revoke_tak_certificates with the one prior live certificate id when exactly one exists', async () => {
      Team.isAdmin.mockResolvedValue(true);
      mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5, priorLiveCertRows: [{ cert_id: 777 }] });

      await DeviceEnrollmentService.generateEnrollmentQrCode(42, { userId: 1, is_global_manager: false });
      await flushMicrotasks();

      expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
        'revoke_tak_certificates',
        { cert_ids: [777] },
        1
      );
    });

    it('enqueues nothing when no prior live certificate exists', async () => {
      Team.isAdmin.mockResolvedValue(true);
      mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5, priorLiveCertRows: [] });

      await DeviceEnrollmentService.generateEnrollmentQrCode(42, { userId: 1, is_global_manager: false });
      await flushMicrotasks();

      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('a rejected enqueue does not propagate to or alter the successful QR-generation response', async () => {
      Team.isAdmin.mockResolvedValue(true);
      mockUserAndMembershipLookup({ userRow: DEVICE_ROW, teamId: 5, priorLiveCertRows: [{ cert_id: 777 }] });
      EventPublisher.publishOperation.mockRejectedValue(new Error('enqueue failed'));

      const result = await DeviceEnrollmentService.generateEnrollmentQrCode(42, { userId: 1, is_global_manager: false });
      await flushMicrotasks();

      expect(result.principalId).toBe(42);
      expect(result.teamId).toBe(5);
    });
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
    // Two DISTINCT `tak_devices` queries now run per enrollment: the
    // pre-existing `count(*)` liveCertificateCount read (in
    // #resolvePrincipalPreview) and cert-expiry-notifications' new
    // `cert_id`-selecting Superseding_Revoke lookup (in
    // #enqueueSupersedingRevoke) -- matched on the distinguishing
    // `count(*)` substring so each answers correctly. Defaults to "no
    // prior live certificate" for the Superseding_Revoke lookup so
    // every pre-existing test in this describe block (written before
    // that lookup existed) is unaffected; tests exercising the
    // Superseding_Revoke behaviour itself override this via
    // `pool.query.mockImplementationOnce`/a dedicated helper below.
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('count(*)') && sql.includes('FROM tak_devices')) {
        return Promise.resolve({ rows: [{ count: '0' }] });
      }
      if (typeof sql === 'string' && sql.includes('cert_id') && sql.includes('FROM tak_devices')) {
        return Promise.resolve({ rows: [] });
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

  /**
   * cert-expiry-notifications Requirement 8 (task 9.6): the
   * Superseding_Revoke enqueue, fired after a successful self-enrollment
   * mint. Awaited via a microtask flush (`await Promise.resolve()`
   * twice) since the call site is deliberately fire-and-forget
   * (`.catch(...)` at the call site, never awaited by the caller).
   */
  describe('Superseding_Revoke enqueue (cert-expiry-notifications Requirement 8)', () => {
    async function flushMicrotasks() {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    it('enqueues revoke_tak_certificates with exactly the one prior live certificate id when exactly one exists', async () => {
      User.findById.mockResolvedValue(HUMAN_ROW);
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('FROM team_memberships')) return Promise.resolve({ rows: [] });
        if (typeof sql === 'string' && sql.includes('count(*)') && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ count: '0' }] });
        }
        if (typeof sql === 'string' && sql.includes('cert_id') && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ cert_id: 555 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });
      await flushMicrotasks();

      expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
        'revoke_tak_certificates',
        { cert_ids: [555] },
        43
      );
    });

    it('enqueues nothing when no prior live certificate exists (ordinary first enrollment)', async () => {
      User.findById.mockResolvedValue(HUMAN_ROW);
      // Default mock from beforeEach already answers [] for the
      // cert_id lookup -- no override needed.

      await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });
      await flushMicrotasks();

      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('enqueues nothing when MORE than one prior live certificate exists (ambiguous multi-device case)', async () => {
      User.findById.mockResolvedValue(HUMAN_ROW);
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('FROM team_memberships')) return Promise.resolve({ rows: [] });
        if (typeof sql === 'string' && sql.includes('count(*)') && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ count: '2' }] });
        }
        if (typeof sql === 'string' && sql.includes('cert_id') && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ cert_id: 111 }, { cert_id: 222 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });
      await flushMicrotasks();

      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('never includes the just-minted certificate\'s own id, since the lookup only reads rows that existed BEFORE this mint', async () => {
      User.findById.mockResolvedValue(HUMAN_ROW);
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('FROM team_memberships')) return Promise.resolve({ rows: [] });
        if (typeof sql === 'string' && sql.includes('count(*)') && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ count: '0' }] });
        }
        if (typeof sql === 'string' && sql.includes('cert_id') && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ cert_id: 999 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });
      await flushMicrotasks();

      const [, payload] = EventPublisher.publishOperation.mock.calls[0];
      expect(payload.cert_ids).toEqual([999]);
      expect(payload.cert_ids).not.toContain(undefined);
    });

    it('a rejected enqueue does not propagate to or alter the successful enrollment response', async () => {
      User.findById.mockResolvedValue(HUMAN_ROW);
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('FROM team_memberships')) return Promise.resolve({ rows: [] });
        if (typeof sql === 'string' && sql.includes('count(*)') && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ count: '0' }] });
        }
        if (typeof sql === 'string' && sql.includes('cert_id') && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ cert_id: 555 }] });
        }
        return Promise.resolve({ rows: [] });
      });
      EventPublisher.publishOperation.mockRejectedValue(new Error('enqueue failed'));

      const result = await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });
      await flushMicrotasks();

      // The enrollment call itself never rejected, and returned its
      // normal successful shape.
      expect(result.principalId).toBe(43);
      expect(result.atakEnrollmentUri).toBeDefined();
    });
  });
});

describe('DeviceEnrollmentService.listTeamDevices', () => {
  const ORG_ANCESTOR_CHAIN = [{ id: 5, parent_team_id: null, callsign_prefix: 'AUK', callsign_level_selection: null, depth: 0 }];

  beforeEach(() => {
    jest.clearAllMocks();
    // Bugfix (Members/Team Admins/Team Devices tab consistency): every
    // test below that returns >= 1 device row now also triggers ONE
    // Team.getAncestorChain call to compute each device's callsign --
    // default to a simple single-level Organisation chain so existing
    // assertions about the OTHER fields don't have to care about this
    // one unless a test is specifically about it.
    Team.getAncestorChain.mockResolvedValue(ORG_ANCESTOR_CHAIN);
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
        callsign_suffix: 'Tanker1',
        tak_role: 'Team Member',
        created_at: '2024-01-01T00:00:00.000Z',
        account_status: 'active',
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
          callsignSuffix: 'Tanker1',
          takRole: 'Team Member',
          callsign: 'AUK-Tanker1',
          teamId: 5,
          createdAt: '2024-01-01T00:00:00.000Z',
          accountStatus: 'active',
          liveCertificateCount: 0
        }
      ]
    });
    expect(result.devices[0]).not.toHaveProperty('email');
    expect(JSON.stringify(result)).not.toContain('"email"');
  });

  // account-lifecycle-management Requirement 4.1 (task 8.1): account_status
  // is added to this query's SELECT column list and threaded through to
  // the returned shape as accountStatus, additive on the same query --
  // no new query, matching the requirement's own framing.
  it('threads account_status through as accountStatus for a suspended device', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([
      {
        device_user_id: 43,
        username: 'AUK-D9Q2WXY',
        device_label: 'Spare Tablet',
        callsign_suffix: null,
        tak_role: 'Team Member',
        created_at: '2024-03-01T00:00:00.000Z',
        account_status: 'suspended',
        live_certificate_count: 0
      }
    ]);

    const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    expect(result.devices[0].accountStatus).toBe('suspended');
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('u.account_status AS account_status');
  });

  it('lists a team\'s devices for a Global_Manager, without checking Team.isAdmin', async () => {
    mockDevicesQuery([
      {
        device_user_id: 7,
        username: 'AUK-D2M4XYZ',
        device_label: null,
        callsign_suffix: null,
        tak_role: 'Team Lead',
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
        callsignSuffix: null,
        takRole: 'Team Lead',
        callsign: 'AUK',
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

  it('returns an empty array for a team with zero Team_Owned_Devices, without resolving an Ancestor_Chain at all', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([]);

    const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    expect(result).toEqual({ devices: [] });
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
  });

  it('resolves liveCertificateCount for devices with 0, 1 and 2+ live (non-revoked) certificates via ONE derived-table join, in a single query call for the whole listing', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([
      { device_user_id: 1, username: 'AUK-D0000AA', device_label: null, callsign_suffix: null, tak_role: 'Team Member', created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 0 },
      { device_user_id: 2, username: 'AUK-D0000BB', device_label: null, callsign_suffix: null, tak_role: 'Team Member', created_at: '2024-01-02T00:00:00.000Z', live_certificate_count: 1 },
      { device_user_id: 3, username: 'AUK-D0000CC', device_label: null, callsign_suffix: null, tak_role: 'Team Member', created_at: '2024-01-03T00:00:00.000Z', live_certificate_count: 2 }
    ]);

    const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    expect(result.devices.map((d) => d.liveCertificateCount)).toEqual([0, 1, 2]);
    // No N+1: exactly one pool.query call resolves the whole list,
    // independent of how many devices it returns (Team.getAncestorChain
    // is a separate, ALSO single call per listing -- not per row).
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(Team.getAncestorChain).toHaveBeenCalledTimes(1);

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

  // Bugfix (admins had no way to see a device's certificate expiring soon
  // on the Team Devices tab): `expiresAt` -- the SOONEST `expires_at` among
  // a device's own live certificates -- is added to the same derived-table
  // join `liveCertificateCount` already uses, no second query.
  it('resolves expiresAt as the row\'s soonest live-certificate expiry, and null for a device with no live certificate', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([
      { device_user_id: 1, username: 'AUK-D0000AA', device_label: null, callsign_suffix: null, tak_role: 'Team Member', created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 1, expires_at: '2026-04-01T00:00:00.000Z' },
      { device_user_id: 2, username: 'AUK-D0000BB', device_label: null, callsign_suffix: null, tak_role: 'Team Member', created_at: '2024-01-02T00:00:00.000Z', live_certificate_count: 0, expires_at: null }
    ]);

    const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    expect(result.devices[0].expiresAt).toBe('2026-04-01T00:00:00.000Z');
    expect(result.devices[1].expiresAt).toBeNull();

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('MIN(expires_at) AS earliest_expires_at');
  });

  it('scopes the listing to direct membership and Team_Owned_Devices only, echoing back the teamId parameter rather than re-deriving it per row', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDevicesQuery([
      { device_user_id: 42, username: 'AUK-D7K3QMX', device_label: 'Engine 4 Tablet', callsign_suffix: 'Tanker1', tak_role: 'Team Member', created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 0 }
    ]);

    const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('inherited_from_team_id IS NULL');
    expect(sql).toContain('is_team_device = true');
    expect(params).toEqual([5]);
    expect(result.devices.every((d) => d.teamId === 5)).toBe(true);
  });

  // Bugfix (Members/Team Admins/Team Devices tab consistency): the new
  // `callsign` field assembles the SAME way a human member's
  // `tak_callsign` does (`CallsignService.assembleCallsign`), reusing
  // ONE `Team.getAncestorChain` resolution for the whole device list
  // rather than re-querying it per device.
  describe('computed callsign field', () => {
    it('assembles Organisation + Team segments + the device\'s own callsign_suffix as the Name segment', async () => {
      Team.isAdmin.mockResolvedValue(true);
      Team.getAncestorChain.mockResolvedValue([
        { id: 1, parent_team_id: null, callsign_prefix: 'AUK', callsign_level_selection: null, depth: 0 },
        { id: 5, parent_team_id: 1, callsign_prefix: 'STL', callsign_level_selection: null, depth: 1 }
      ]);
      mockDevicesQuery([
        { device_user_id: 42, username: 'AUK-D7K3QMX', device_label: 'Engine 4', callsign_suffix: 'Tanker1', tak_role: 'Team Member', created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 0 }
      ]);

      const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

      expect(Team.getAncestorChain).toHaveBeenCalledWith(5);
      expect(result.devices[0].callsign).toBe('AUK-STL-Tanker1');
    });

    it('omits the Name segment entirely when the device carries no callsign_suffix', async () => {
      Team.isAdmin.mockResolvedValue(true);
      mockDevicesQuery([
        { device_user_id: 42, username: 'AUK-D7K3QMX', device_label: null, callsign_suffix: null, tak_role: 'Team Member', created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 0 }
      ]);

      const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

      expect(result.devices[0].callsign).toBe('AUK');
    });

    it('respects the Organisation\'s Callsign_Level_Selection, skipping a Team_Depth not selected', async () => {
      Team.isAdmin.mockResolvedValue(true);
      Team.getAncestorChain.mockResolvedValue([
        { id: 1, parent_team_id: null, callsign_prefix: 'AUK', callsign_level_selection: [2], depth: 0 },
        { id: 5, parent_team_id: 1, callsign_prefix: 'STL', callsign_level_selection: null, depth: 1 }
      ]);
      mockDevicesQuery([
        { device_user_id: 42, username: 'AUK-D7K3QMX', device_label: null, callsign_suffix: 'Tanker1', tak_role: 'Team Member', created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 0 }
      ]);

      const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

      // depth 1 (STL) is NOT in the selection [2], so the Team segment
      // is omitted entirely.
      expect(result.devices[0].callsign).toBe('AUK-Tanker1');
    });

    // Callsign Team-segment separator toggle: an Organisation may opt
    // into hyphenating its Team segment via `callsign_team_hyphenated`,
    // read off ancestorChain[0] identically to how userAttributes.js
    // reads it for a human member's callsign.
    it('hyphenates the Team segment when the Organisation\'s callsign_team_hyphenated is true', async () => {
      Team.isAdmin.mockResolvedValue(true);
      Team.getAncestorChain.mockResolvedValue([
        { id: 1, parent_team_id: null, callsign_prefix: 'AUK', callsign_level_selection: null, callsign_team_hyphenated: true, depth: 0 },
        { id: 5, parent_team_id: 1, callsign_prefix: 'STL', callsign_level_selection: null, depth: 1 }
      ]);
      mockDevicesQuery([
        { device_user_id: 42, username: 'AUK-D7K3QMX', device_label: 'Engine 4', callsign_suffix: 'Tanker1', tak_role: 'Team Member', created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 0 }
      ]);

      const result = await DeviceEnrollmentService.listTeamDevices(5, { userId: 1, is_global_manager: false });

      expect(result.devices[0].callsign).toBe('AUK-STL-Tanker1');
    });

    it('never produces a doubled hyphen when an intermediate level is unselected, even when hyphenated', async () => {
      Team.isAdmin.mockResolvedValue(true);
      Team.getAncestorChain.mockResolvedValue([
        { id: 1, parent_team_id: null, callsign_prefix: 'AUK', callsign_level_selection: [1, 3], callsign_team_hyphenated: true, depth: 0 },
        { id: 5, parent_team_id: 1, callsign_prefix: 'NSW', callsign_level_selection: null, depth: 1 },
        { id: 6, parent_team_id: 5, callsign_prefix: 'UNS', callsign_level_selection: null, depth: 2 },
        { id: 7, parent_team_id: 6, callsign_prefix: 'SYD', callsign_level_selection: null, depth: 3 }
      ]);
      mockDevicesQuery([
        { device_user_id: 42, username: 'AUK-D7K3QMX', device_label: null, callsign_suffix: 'Tanker1', tak_role: 'Team Member', created_at: '2024-01-01T00:00:00.000Z', live_certificate_count: 0 }
      ]);

      const result = await DeviceEnrollmentService.listTeamDevices(7, { userId: 1, is_global_manager: false });

      expect(result.devices[0].callsign).toBe('AUK-NSW-SYD-Tanker1');
      expect(result.devices[0].callsign).not.toContain('--');
    });
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
    // Bugfix (Members/Team Admins/Team Devices tab consistency):
    // updateDevice now also resolves an Ancestor_Chain (to recompute the
    // returned `callsign`) after the write -- default to a simple
    // single-level Organisation chain, mirroring listTeamDevices' own
    // tests, unless a specific test needs a deeper one.
    Team.getAncestorChain.mockResolvedValue([
      { id: 5, parent_team_id: null, callsign_prefix: 'AUK', callsign_level_selection: null, depth: 0 }
    ]);
  });

  it('updates deviceLabel and callsignSuffix for an authorized team admin, returning the updated row', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDeviceLookup();
    User.update.mockResolvedValue({
      id: 42,
      username: 'AUK-D7K3QMX',
      device_label: 'Renamed Tablet',
      callsign_suffix: 'Tanker1',
      tak_role: 'Team Member'
    });

    const result = await DeviceEnrollmentService.updateDevice(
      42,
      { deviceLabel: 'Renamed Tablet', callsignSuffix: 'Tanker1' },
      { userId: 1, is_global_manager: false }
    );

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 1);
    expect(User.update).toHaveBeenCalledWith(42, { device_label: 'Renamed Tablet', callsign_suffix: 'Tanker1' });
    expect(Team.getAncestorChain).toHaveBeenCalledWith(5);
    expect(result).toEqual({
      deviceUserId: 42,
      username: 'AUK-D7K3QMX',
      deviceLabel: 'Renamed Tablet',
      callsignSuffix: 'Tanker1',
      takRole: 'Team Member',
      callsign: 'AUK-Tanker1',
      teamId: 5
    });
  });

  it('leaves a field untouched (no key in the User.update call) when it is not supplied', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDeviceLookup();
    User.update.mockResolvedValue({ id: 42, username: 'AUK-D7K3QMX', device_label: 'Old Label', callsign_suffix: null, tak_role: 'Team Member' });

    await DeviceEnrollmentService.updateDevice(42, { deviceLabel: 'New Label' }, { userId: 1, is_global_manager: false });

    expect(User.update).toHaveBeenCalledWith(42, { device_label: 'New Label' });
  });

  it('checks callsignSuffix uniqueness before writing, excluding the device\'s own row from the comparison', async () => {
    Team.isAdmin.mockResolvedValue(true);
    mockDeviceLookup();
    Team.getFullMemberList.mockResolvedValue([{ id: 42, callsign_suffix: 'Tanker1' }]);
    User.update.mockResolvedValue({ id: 42, username: 'AUK-D7K3QMX', device_label: null, callsign_suffix: 'Tanker1', tak_role: 'Team Member' });

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

/**
 * Org-wide Team_Owned_Device listing backing the `/devices` page --
 * mirrors `GET /api/users`' own scoping shape (DirectoryScopeService,
 * Team.getManagedTeamIds) rather than `listTeamDevices`'s single-team
 * `Team.isAdmin` gate.
 */
describe('DeviceEnrollmentService.listAllDevices', () => {
  const ORG_ANCESTOR_CHAIN = [{ id: 5, parent_team_id: null, callsign_prefix: 'AUK', callsign_level_selection: null, depth: 0 }];

  function mockCandidatesQuery(rows) {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users u')) {
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    Team.getAncestorChain.mockResolvedValue(ORG_ANCESTOR_CHAIN);
    Team.getManagedTeamIds.mockResolvedValue(new Set([5]));
  });

  it('returns every device unfiltered for a Global_Manager (UNSCOPED), with can_manage true for every row', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
    mockCandidatesQuery([
      {
        device_user_id: 42,
        username: 'AUK-D7K3QMX',
        device_label: 'Engine 4 Tablet',
        callsign_suffix: 'Tanker1',
        tak_role: 'Team Member',
        created_at: '2024-01-01T00:00:00.000Z',
        account_status: 'active',
        origin_org_id: null,
        team_id: 5,
        team_name: 'Auckland',
        direct_membership_org_id: 5,
        live_certificate_count: 2,
        expires_at: '2026-04-01T00:00:00.000Z',
        in_scope: true,
        total_count: '1'
      }
    ]);

    const result = await DeviceEnrollmentService.listAllDevices(
      { userId: 1, is_global_manager: true },
      { page: 1, pageSize: 50 }
    );

    expect(Team.getManagedTeamIds).not.toHaveBeenCalled();
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]).toEqual({
      deviceUserId: 42,
      username: 'AUK-D7K3QMX',
      deviceLabel: 'Engine 4 Tablet',
      callsignSuffix: 'Tanker1',
      takRole: 'Team Member',
      callsign: 'AUK-Tanker1',
      teamId: 5,
      teamName: 'Auckland',
      createdAt: '2024-01-01T00:00:00.000Z',
      accountStatus: 'active',
      liveCertificateCount: 2,
      expiresAt: '2026-04-01T00:00:00.000Z',
      canManage: true
    });
    expect(result.devices[0]).not.toHaveProperty('email');
    expect(result.pagination).toEqual({ page: 1, pageSize: 50, total: 1 });
  });

  it('resolves canManage per row via Team.getManagedTeamIds for a non-Global_Manager, resolved once for the whole page', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue({
      organisations: [{ id: 5, name: 'Auckland' }],
      organisationIds: [5],
      allowedDomains: new Set(),
      domainsConfigured: false
    });
    Team.getManagedTeamIds.mockResolvedValue(new Set([5]));
    mockCandidatesQuery([
      {
        device_user_id: 42,
        username: 'AUK-D7K3QMX',
        device_label: 'Engine 4 Tablet',
        callsign_suffix: null,
        tak_role: 'Team Member',
        created_at: '2024-01-01T00:00:00.000Z',
        account_status: 'active',
        origin_org_id: null,
        team_id: 5,
        team_name: 'Auckland',
        direct_membership_org_id: 5,
        live_certificate_count: 0,
        in_scope: true,
        total_count: '1'
      },
      {
        device_user_id: 43,
        username: 'AUK-D0000BB',
        device_label: null,
        callsign_suffix: null,
        tak_role: 'Team Member',
        created_at: '2024-01-02T00:00:00.000Z',
        account_status: 'active',
        origin_org_id: null,
        team_id: 9,
        team_name: 'Sub Team',
        direct_membership_org_id: 5,
        live_certificate_count: 0,
        in_scope: true,
        total_count: '1'
      }
    ]);
    Team.getAncestorChain.mockImplementation((teamId) =>
      Promise.resolve(teamId === 9 ? [ORG_ANCESTOR_CHAIN[0], { id: 9, parent_team_id: 5, callsign_prefix: 'STL', callsign_level_selection: null, depth: 1 }] : ORG_ANCESTOR_CHAIN)
    );

    const result = await DeviceEnrollmentService.listAllDevices(
      { userId: 1, is_global_manager: false },
      { page: 1, pageSize: 50 }
    );

    expect(Team.getManagedTeamIds).toHaveBeenCalledTimes(1);
    expect(Team.getManagedTeamIds).toHaveBeenCalledWith(1);
    expect(result.devices.find((d) => d.deviceUserId === 42).canManage).toBe(true);
    // team_id 9 is not in the managed set -- visible (scope admits it via
    // direct_membership_org_id) but not manageable by this caller.
    expect(result.devices.find((d) => d.deviceUserId === 43).canManage).toBe(false);
  });

  it('excludes a row the DirectoryScope predicate rejects, via the belt-and-braces partitionCandidates pass', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue({
      organisations: [{ id: 5, name: 'Auckland' }],
      organisationIds: [5],
      allowedDomains: new Set(),
      domainsConfigured: false
    });
    // The SQL predicate is trusted to have already excluded this row in
    // production, but the belt-and-braces pass must ALSO exclude a row
    // whose facts don't actually match the resolved scope -- e.g. one
    // that slipped through with a mismatched org id.
    mockCandidatesQuery([
      {
        device_user_id: 99,
        username: 'WLG-D0000ZZ',
        device_label: null,
        callsign_suffix: null,
        tak_role: 'Team Member',
        created_at: '2024-01-01T00:00:00.000Z',
        account_status: 'active',
        origin_org_id: 77,
        team_id: 12,
        team_name: 'Wellington',
        direct_membership_org_id: 77,
        live_certificate_count: 0,
        in_scope: false,
        total_count: '0'
      }
    ]);

    const result = await DeviceEnrollmentService.listAllDevices(
      { userId: 1, is_global_manager: false },
      { page: 1, pageSize: 50 }
    );

    expect(result.devices).toEqual([]);
  });

  it('passes organisationIds, the search pattern, page size and offset as SQL parameters', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
    mockCandidatesQuery([]);

    await DeviceEnrollmentService.listAllDevices(
      { userId: 1, is_global_manager: true },
      { page: 2, pageSize: 10, search: 'tanker' }
    );

    const [, params] = pool.query.mock.calls.find(([sql]) => sql.includes('FROM users u'));
    // cert-expiry-notifications task 14.1: two additive parameters,
    // expiringOnly (defaulting to false when not requested) and the
    // resolved expiryWarningDays threshold (defaulting to 30 when
    // DEVICE_MGMT_EXPIRY_WARNING_DAYS is unset). Large-directory filters add
    // two more, $8 teamId and $9 labelInitial, both null when not supplied.
    expect(params).toEqual([[], '%tanker%', true, 10, 10, false, 30, null, null]);
  });

  it('binds the large-directory teamId ($8) and labelInitial ($9) filters, and adds their SQL predicates', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
    mockCandidatesQuery([]);

    await DeviceEnrollmentService.listAllDevices(
      { userId: 1, is_global_manager: true },
      { page: 1, pageSize: 50, teamId: '42', labelInitial: 'b' }
    );

    const [sql, params] = pool.query.mock.calls.find(([q]) => q.includes('FROM users u'));
    expect(sql).toContain('tm.team_id = $8::int');
    expect(sql).toContain('u.device_label ILIKE $9 || \'%\'');
    expect(params[7]).toBe(42); // teamId parsed to int
    expect(params[8]).toBe('B'); // labelInitial uppercased
  });

  it('binds null for an invalid teamId and the # bucket for labelInitial', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
    mockCandidatesQuery([]);

    await DeviceEnrollmentService.listAllDevices(
      { userId: 1, is_global_manager: true },
      { page: 1, pageSize: 50, teamId: 'abc', labelInitial: '#' }
    );

    const [sql, params] = pool.query.mock.calls.find(([q]) => q.includes('FROM users u'));
    expect(sql).toContain('u.device_label !~ \'^[A-Za-z]\'');
    expect(params[7]).toBeNull(); // invalid teamId -> null
    expect(params[8]).toBe('#');
  });

  // Bugfix (admins had no way to see a device's certificate expiring soon
  // in the org-wide /devices listing): same soonest-live-certificate
  // resolution as listTeamDevices, via the same derived-table join.
  it('resolves expiresAt as the row\'s soonest live-certificate expiry, and null for a device with no live certificate', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
    mockCandidatesQuery([
      {
        device_user_id: 1,
        username: 'AUK-D0000AA',
        device_label: null,
        callsign_suffix: null,
        tak_role: 'Team Member',
        created_at: '2024-01-01T00:00:00.000Z',
        account_status: 'active',
        origin_org_id: null,
        team_id: 5,
        team_name: 'Auckland',
        direct_membership_org_id: 5,
        live_certificate_count: 0,
        expires_at: null,
        in_scope: true,
        total_count: '1'
      }
    ]);

    const result = await DeviceEnrollmentService.listAllDevices(
      { userId: 1, is_global_manager: true },
      { page: 1, pageSize: 50 }
    );

    expect(result.devices[0].expiresAt).toBeNull();

    const [sql] = pool.query.mock.calls.find(([q]) => q.includes('FROM users u'));
    expect(sql).toContain('MIN(expires_at) AS earliest_expires_at');
  });

  it('returns zero total and an empty device array when the candidates CTE yields no rows', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
    mockCandidatesQuery([]);

    const result = await DeviceEnrollmentService.listAllDevices(
      { userId: 1, is_global_manager: true },
      { page: 1, pageSize: 50 }
    );

    expect(result).toEqual({ devices: [], pagination: { page: 1, pageSize: 50, total: 0 } });
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
  });

  it('resolves each distinct team\'s Ancestor_Chain at most once across the whole page', async () => {
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
    mockCandidatesQuery([
      { device_user_id: 1, username: 'AUK-D0000AA', device_label: null, callsign_suffix: null, tak_role: 'Team Member', created_at: '2024-01-01T00:00:00.000Z', account_status: 'active', origin_org_id: null, team_id: 5, team_name: 'Auckland', direct_membership_org_id: 5, live_certificate_count: 0, in_scope: true, total_count: '2' },
      { device_user_id: 2, username: 'AUK-D0000BB', device_label: null, callsign_suffix: null, tak_role: 'Team Member', created_at: '2024-01-02T00:00:00.000Z', account_status: 'active', origin_org_id: null, team_id: 5, team_name: 'Auckland', direct_membership_org_id: 5, live_certificate_count: 0, in_scope: true, total_count: '2' }
    ]);

    await DeviceEnrollmentService.listAllDevices(
      { userId: 1, is_global_manager: true },
      { page: 1, pageSize: 50 }
    );

    expect(Team.getAncestorChain).toHaveBeenCalledTimes(1);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(5);
  });

  /**
   * cert-expiry-notifications Requirement 7.3(b) (task 14.1): the
   * `expiringOnly` filter, threaded into the SQL as two additive
   * parameters.
   */
  describe('expiringOnly filter (cert-expiry-notifications Requirement 7.3(b))', () => {
    const ORIGINAL_WARNING_DAYS = process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS;

    afterEach(() => {
      if (ORIGINAL_WARNING_DAYS === undefined) {
        delete process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS;
      } else {
        process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS = ORIGINAL_WARNING_DAYS;
      }
    });

    it('passes expiringOnly=false and the default 30-day threshold when not requested', async () => {
      delete process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS;
      DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
      mockCandidatesQuery([]);

      await DeviceEnrollmentService.listAllDevices(
        { userId: 1, is_global_manager: true },
        { page: 1, pageSize: 50 }
      );

      const [sql, params] = pool.query.mock.calls.find(([q]) => q.includes('FROM users u'));
      expect(sql).toContain('$6::boolean');
      // expiringOnly is $6 (index 5), expiryWarningDays is $7 (index 6) --
      // referenced by fixed position now that $8 teamId / $9 labelInitial
      // are appended AFTER them.
      expect(params[5]).toBe(false);
      expect(params[6]).toBe(30);
    });

    it('passes expiringOnly=true and the configured DEVICE_MGMT_EXPIRY_WARNING_DAYS threshold when requested', async () => {
      process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS = '45';
      DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
      mockCandidatesQuery([]);

      await DeviceEnrollmentService.listAllDevices(
        { userId: 1, is_global_manager: true },
        { page: 1, pageSize: 50, expiringOnly: true }
      );

      const [, params] = pool.query.mock.calls.find(([q]) => q.includes('FROM users u'));
      expect(params[5]).toBe(true); // expiringOnly ($6)
      expect(params[6]).toBe(45); // expiryWarningDays ($7)
    });

    it.each(['', '0', '-5', 'not-a-number'])(
      'falls back to the 30-day default when DEVICE_MGMT_EXPIRY_WARNING_DAYS=%p',
      async (value) => {
        process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS = value;
        DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);
        mockCandidatesQuery([]);

        await DeviceEnrollmentService.listAllDevices(
          { userId: 1, is_global_manager: true },
          { page: 1, pageSize: 50, expiringOnly: true }
        );

        const [, params] = pool.query.mock.calls.find(([q]) => q.includes('FROM users u'));
        expect(params[6]).toBe(30); // expiryWarningDays ($7), fixed position
      }
    );

    it('introduces no new authorization rule -- canManage/scoping is resolved identically regardless of expiringOnly', async () => {
      DirectoryScopeService.resolveScope.mockResolvedValue({ organisationIds: [5] });
      mockCandidatesQuery([
        {
          device_user_id: 1,
          username: 'AUK-D0000AA',
          device_label: null,
          callsign_suffix: null,
          tak_role: 'Team Member',
          created_at: '2024-01-01T00:00:00.000Z',
          account_status: 'active',
          origin_org_id: 5,
          team_id: 5,
          team_name: 'Auckland',
          direct_membership_org_id: 5,
          live_certificate_count: 1,
          expires_at: '2024-06-01T00:00:00.000Z',
          in_scope: true,
          total_count: '1'
        }
      ]);
      Team.getManagedTeamIds.mockResolvedValue(new Set([5]));

      const result = await DeviceEnrollmentService.listAllDevices(
        { userId: 1, is_global_manager: false },
        { page: 1, pageSize: 50, expiringOnly: true }
      );

      expect(result.devices[0].canManage).toBe(true);
    });
  });
});
