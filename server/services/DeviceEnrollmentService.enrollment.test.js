/**
 * Example tests for `DeviceEnrollmentService`'s private `#buildEnrollment`
 * core and its two public entry points, `generateSelfEnrollment` and
 * `generateEnrollmentQrCode` (takserver-enrollment task 7.6; Requirements
 * 3.2, 3.10, 4.7, 10.5, 11.1, 11.2, 14.5, 15.3).
 *
 * Deliberately DOES NOT mock `./authentik`. Every test in this file mocks
 * `axios` instead (the same pattern `authentik.test.js` uses) and lets the
 * REAL `server/services/authentik.js` run underneath
 * `DeviceEnrollmentService`, so that the token-mint and compensating-DELETE
 * assertions below confirm the WIRING from `DeviceEnrollmentService`'s own
 * call sites, not a re-statement of `authentik.js`'s already-tested
 * internal logic (`authentik.test.js`, task 7.2).
 *
 * Coverage already present elsewhere in this codebase and DELIBERATELY NOT
 * repeated here (see task 7.6's instruction not to duplicate):
 *   - `expiresInMinutes: 30` passed to `createAppPasswordToken` on BOTH
 *     `generateSelfEnrollment` and `generateEnrollmentQrCode`
 *     (`DeviceEnrollmentService.test.js`'s `generateEnrollmentQrCode` and
 *     `generateSelfEnrollment` describe blocks, one assertion each).
 *   - the `atakQrDataUrl`/`itakQrDataUrl` `data:image/png;base64,` prefix
 *     check (`DeviceEnrollmentService.test.js`'s `generateEnrollmentQrCode`
 *     describe block) -- though NOT the "toDataURL, never toBuffer" call
 *     assertion, which is new here (item 1 below).
 *   - `TakServerNotConfiguredError` raised before any
 *     `createAppPasswordToken` call when `TAK_SERVER_ENROLLMENT_URL` is UNSET, via
 *     `generateEnrollmentQrCode` (`DeviceEnrollmentService.test.js`) --
 *     though NOT the UNPARSEABLE case, which is new here (item 3 below).
 *   - `generateSelfEnrollment` refusing an `is_team_device = true` row
 *     (Criterion 14.5) and `generateEnrollmentQrCode`'s
 *     `NotATeamOwnedDeviceError` for a human row, INCLUDING the required
 *     Criterion 3.3 scoping-rule comment naming it as the route's SCOPING
 *     rule rather than a capability limit (both already present, with that
 *     exact comment, in `DeviceEnrollmentService.test.js`'s
 *     `generateEnrollmentQrCode` describe block).
 *
 * This file adds:
 *   1. `QRCode.toDataURL` is the call actually made (never `toBuffer`).
 *   2. The ATAK URI's `encodeURIComponent` applied to all three values,
 *      cross-checked against a hostile host and username carrying `&`,
 *      `=` and a space.
 *   3. `TakServerNotConfiguredError` for an UNPARSEABLE `TAK_SERVER_ENROLLMENT_URL`
 *      (an empty string, and a non-URL string that makes `new URL(...)`
 *      throw), through both entry points, asserting the token-minting
 *      call count is exactly 0.
 *   4. The key-created-but-key-fetch-failed compensating token DELETE,
 *      reached through a full `generateSelfEnrollment` call -- confirming
 *      the WIRING, not `authentik.js`'s own logic -- including the
 *      failed-delete log carrying the token identifier and never the key.
 *   5. `takAttributes` never reflect a (hypothetical, hostile) Authentik
 *      `attributes.takRole`/`takCallsign`/`takColor` value anywhere on
 *      this path.
 *   6. The exact string `'None'` for callsign, color AND role for a
 *      principal with NO team membership and no `tak_role` set.
 *   7. The positive half of Criterion 3.2: `#buildEnrollment`'s full,
 *      complete return shape for a human principal (`is_team_device =
 *      false`), reached via `generateSelfEnrollment`, with no error and no
 *      special-casing.
 */

jest.mock('axios');
jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('../models/Team', () => ({
  isAdmin: jest.fn(),
  getAncestorChain: jest.fn()
}));
jest.mock('./TeamMembershipService', () => ({
  addUserToTeam: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));
jest.mock('../models/User', () => ({
  findById: jest.fn()
}));
jest.mock('./userAttributes', () => ({
  generateCallsign: jest.fn()
}));
jest.mock('qrcode', () => ({
  toDataURL: jest.fn(),
  toBuffer: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

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
  is_team_device: true,
  tak_role: null
};

const ORIGINAL_TAK_SERVER_ENROLLMENT_URL = process.env.TAK_SERVER_ENROLLMENT_URL;

let pool;
let Team;
let User;
let UserAttributesService;
let QRCode;
let mockAxiosClient;
let DeviceEnrollmentService;
let TakServerNotConfiguredError;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  // Least-privilege-token follow-up: the real `./authentik` reads
  // AUTHENTIK_ENROLLMENT_ADMIN_TOKEN in its CONSTRUCTOR to build its
  // isolated enrollment client, so this must be set BEFORE
  // `./DeviceEnrollmentService` (which requires `./authentik`) is
  // required below -- this file runs the REAL authentik.js (see the file
  // header), unlike every other DeviceEnrollmentService test file, which
  // mocks `./authentik` outright.
  process.env.AUTHENTIK_ENROLLMENT_ADMIN_TOKEN = 'enrollment-admin-token-value';

  mockAxiosClient = { post: jest.fn(), get: jest.fn(), delete: jest.fn() };
  // Re-require axios AFTER resetModules so the mocked `.create` lands on
  // the SAME axios module instance the real `./authentik` resolves next
  // (mirrors authentik.test.js's own setup).
  const axios = require('axios');
  axios.create = jest.fn(() => mockAxiosClient);

  pool = require('../config/database');
  Team = require('../models/Team');
  User = require('../models/User');
  UserAttributesService = require('./userAttributes');
  QRCode = require('qrcode');
  DeviceEnrollmentService = require('./DeviceEnrollmentService');
  ({ TakServerNotConfiguredError } = DeviceEnrollmentService);

  process.env.TAK_SERVER_ENROLLMENT_URL = 'https://tak.example.com:8443';

  // Default: no team membership, no live certificates -- individual tests
  // override this where a team/certificate count matters.
  pool.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
      return Promise.resolve({ rows: [] });
    }
    if (typeof sql === 'string' && sql.includes('FROM tak_devices')) {
      return Promise.resolve({ rows: [{ count: '0' }] });
    }
    return Promise.resolve({ rows: [] });
  });

  QRCode.toDataURL.mockImplementation((text) => Promise.resolve(`data:image/png;base64,${Buffer.from(String(text)).toString('base64').slice(0, 24)}`));
});

afterEach(() => {
  if (ORIGINAL_TAK_SERVER_ENROLLMENT_URL === undefined) {
    delete process.env.TAK_SERVER_ENROLLMENT_URL;
  } else {
    process.env.TAK_SERVER_ENROLLMENT_URL = ORIGINAL_TAK_SERVER_ENROLLMENT_URL;
  }
  delete process.env.AUTHENTIK_ENROLLMENT_ADMIN_TOKEN;
});

// ---------------------------------------------------------------------------
// 1. QRCode.toDataURL, never toBuffer (Criteria 11.1, 11.2).
// ---------------------------------------------------------------------------

describe('#buildEnrollment renders QR codes via QRCode.toDataURL, never toBuffer', () => {
  it('calls QRCode.toDataURL exactly twice and never calls QRCode.toBuffer, for both the ATAK and iTAK codes', async () => {
    User.findById.mockResolvedValue(HUMAN_ROW);
    mockAxiosClient.post.mockResolvedValue({ data: { identifier: 'device-enrollment-xyz', expires: '2024-01-01T00:30:00.000Z' } });
    mockAxiosClient.get.mockResolvedValue({ data: { key: 'super-secret-app-password' } });

    const result = await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });

    expect(QRCode.toDataURL).toHaveBeenCalledTimes(2);
    expect(QRCode.toBuffer).not.toHaveBeenCalled();
    expect(result.atakQrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.itakQrDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});

// ---------------------------------------------------------------------------
// 2. The ATAK URI's exact construction, cross-checked against a hostile
// host/username carrying '&', '=' and a space (Criterion 4.7).
// ---------------------------------------------------------------------------

describe("the ATAK URI's encodeURIComponent, cross-checked against a hostile host and username", () => {
  it('encodes a host carrying "&"/"=" and a username carrying "&"/"="/a space, so the raw characters never leak into the query string unescaped', async () => {
    // A host that PARSES successfully (new URL(...) does not throw) yet
    // still carries '&' and '=' in its hostname -- confirmed against the
    // live URL parser rather than assumed.
    const hostileTakServerUrl = 'https://tak&eq=server.example.com:8443';
    process.env.TAK_SERVER_ENROLLMENT_URL = hostileTakServerUrl;
    const expectedHost = new URL(hostileTakServerUrl).hostname;
    expect(expectedHost).toContain('&');
    expect(expectedHost).toContain('=');

    const hostileUsername = 'j smith&code=1';
    User.findById.mockResolvedValue({ ...HUMAN_ROW, username: hostileUsername });
    mockAxiosClient.post.mockResolvedValue({ data: { identifier: 'device-enrollment-xyz', expires: '2024-01-01T00:30:00.000Z' } });
    const hostileTokenKey = 'tok&en=value with space';
    mockAxiosClient.get.mockResolvedValue({ data: { key: hostileTokenKey } });

    const result = await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });

    const expectedUri = `tak://com.atakmap.app/enroll?host=${encodeURIComponent(expectedHost)}` +
      `&username=${encodeURIComponent(hostileUsername)}` +
      `&token=${encodeURIComponent(hostileTokenKey)}`;
    expect(result.atakEnrollmentUri).toBe(expectedUri);

    // Anti-vacuity: the raw, unescaped hostile substrings must NOT survive
    // into the built URI -- if they did, encodeURIComponent was skipped.
    expect(result.atakEnrollmentUri).not.toContain('host=tak&eq=server');
    expect(result.atakEnrollmentUri).not.toContain('username=j smith&code=1');
    expect(result.atakEnrollmentUri).not.toContain('token=tok&en=value with space');
    expect(result.atakEnrollmentUri).toContain('%26');
    expect(result.atakEnrollmentUri).toContain('%3D');
    expect(result.atakEnrollmentUri).toContain('%20');
  });
});

// ---------------------------------------------------------------------------
// 3. TakServerNotConfiguredError for an UNPARSEABLE TAK_SERVER_ENROLLMENT_URL (the
// UNSET case is already covered elsewhere via generateEnrollmentQrCode).
// ---------------------------------------------------------------------------

describe('TakServerNotConfiguredError is raised before any token mint, for an unset or an unparseable TAK_SERVER_ENROLLMENT_URL', () => {
  it('raises before any token mint when TAK_SERVER_ENROLLMENT_URL is unset, via generateSelfEnrollment (exact call count, not merely "an error was thrown")', async () => {
    delete process.env.TAK_SERVER_ENROLLMENT_URL;
    User.findById.mockResolvedValue(HUMAN_ROW);

    await expect(
      DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false })
    ).rejects.toThrow(TakServerNotConfiguredError);

    expect(mockAxiosClient.post).toHaveBeenCalledTimes(0);
    expect(mockAxiosClient.get).toHaveBeenCalledTimes(0);
  });

  it('raises before any token mint when TAK_SERVER_ENROLLMENT_URL is the empty string, via generateSelfEnrollment', async () => {
    process.env.TAK_SERVER_ENROLLMENT_URL = '';
    User.findById.mockResolvedValue(HUMAN_ROW);

    await expect(
      DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false })
    ).rejects.toThrow(TakServerNotConfiguredError);

    expect(mockAxiosClient.post).toHaveBeenCalledTimes(0);
  });

  it('raises before any token mint when TAK_SERVER_ENROLLMENT_URL is a non-URL string that makes new URL(...) throw, via generateSelfEnrollment', async () => {
    process.env.TAK_SERVER_ENROLLMENT_URL = 'not a valid url';
    // Confirm the premise: this string really does make the native parser throw.
    expect(() => new URL(process.env.TAK_SERVER_ENROLLMENT_URL)).toThrow();
    User.findById.mockResolvedValue(HUMAN_ROW);

    await expect(
      DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false })
    ).rejects.toThrow(TakServerNotConfiguredError);

    expect(mockAxiosClient.post).toHaveBeenCalledTimes(0);
  });

  it('raises before any token mint when TAK_SERVER_ENROLLMENT_URL is unparseable, via generateEnrollmentQrCode too (both entry points share #buildEnrollment)', async () => {
    process.env.TAK_SERVER_ENROLLMENT_URL = 'not a valid url';
    Team.isAdmin.mockResolvedValue(true);
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users WHERE id')) {
        return Promise.resolve({ rows: [DEVICE_ROW] });
      }
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: [{ team_id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      DeviceEnrollmentService.generateEnrollmentQrCode(42, { userId: 1, is_global_manager: false })
    ).rejects.toThrow(TakServerNotConfiguredError);

    expect(mockAxiosClient.post).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The key-created-but-key-fetch-failed compensating token DELETE,
// reached through a FULL enrollment call -- confirming the WIRING from
// DeviceEnrollmentService's own call site, not authentik.js's internal
// logic (already covered by authentik.test.js at that unit level).
// ---------------------------------------------------------------------------

describe('the compensating token DELETE, wired end-to-end through DeviceEnrollmentService.generateSelfEnrollment', () => {
  it('issues a compensating DELETE for the exact token identifier when the key fetch fails, and logs nothing when the delete itself succeeds', async () => {
    User.findById.mockResolvedValue(HUMAN_ROW);
    mockAxiosClient.post.mockResolvedValue({ data: { identifier: 'device-enrollment-xyz', expires: '2024-01-01T00:30:00.000Z' } });
    const keyFetchError = new Error('view_key endpoint unreachable');
    mockAxiosClient.get.mockRejectedValue(keyFetchError);
    mockAxiosClient.delete.mockResolvedValue({ status: 204 });

    await expect(
      DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false })
    ).rejects.toBe(keyFetchError);

    expect(mockAxiosClient.delete).toHaveBeenCalledTimes(1);
    const [deleteUrl] = mockAxiosClient.delete.mock.calls[0];
    expect(deleteUrl).toMatch(/^\/core\/tokens\/device-enrollment-[0-9a-f-]+\/$/);
    expect(mockLoggerInstance.error).not.toHaveBeenCalled();
  });

  it('logs the token IDENTIFIER, never the key, when the compensating delete ALSO fails, and still rethrows the original key-fetch error', async () => {
    User.findById.mockResolvedValue(HUMAN_ROW);
    mockAxiosClient.post.mockResolvedValue({ data: { identifier: 'device-enrollment-xyz', expires: '2024-01-01T00:30:00.000Z' } });
    const keyFetchError = new Error('view_key endpoint unreachable');
    mockAxiosClient.get.mockRejectedValue(keyFetchError);
    const deleteError = new Error('delete also unreachable');
    mockAxiosClient.delete.mockRejectedValue(deleteError);

    await expect(
      DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false })
    ).rejects.toBe(keyFetchError);

    expect(mockAxiosClient.delete).toHaveBeenCalledTimes(1);
    expect(mockLoggerInstance.error).toHaveBeenCalledTimes(1);
    const [logFields] = mockLoggerInstance.error.mock.calls[0];
    expect(logFields.identifier).toBeDefined();
    expect(typeof logFields.identifier).toBe('string');
    expect(logFields).not.toHaveProperty('key');
    expect(JSON.stringify(logFields)).not.toContain('super-secret');
  });
});

// ---------------------------------------------------------------------------
// 5. takAttributes never reflect a hostile Authentik attributes.takRole /
// takCallsign / takColor value anywhere on this path (Criterion 10.5).
// ---------------------------------------------------------------------------

describe('takAttributes are read from LOCAL columns only, never from any Authentik attributes.takRole/takCallsign/takColor field', () => {
  it('ignores a suspicious attributes.takRole/takCallsign/takColor field present on the Authentik token-creation and key-fetch responses, using local values instead', async () => {
    User.findById.mockResolvedValue({ ...HUMAN_ROW, tak_role: 'Team Member' });
    // A real Authentik token response never carries this shape, but the
    // test asserts the NEGATIVE: even if it did, #buildEnrollment must
    // never read it, because it never inspects a `.attributes` field on
    // ANY Authentik response object it receives.
    mockAxiosClient.post.mockResolvedValue({
      data: {
        identifier: 'device-enrollment-xyz',
        expires: '2024-01-01T00:30:00.000Z',
        attributes: { takRole: 'WRONG_ROLE', takCallsign: 'WRONG_CALLSIGN', takColor: 'WRONG_COLOR' }
      }
    });
    mockAxiosClient.get.mockResolvedValue({
      data: {
        key: 'super-secret-app-password',
        attributes: { takRole: 'WRONG_ROLE_2', takCallsign: 'WRONG_CALLSIGN_2', takColor: 'WRONG_COLOR_2' }
      }
    });
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: [{ team_id: 7 }] });
      }
      if (typeof sql === 'string' && sql.includes('FROM tak_devices')) {
        return Promise.resolve({ rows: [{ count: '0' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    UserAttributesService.generateCallsign.mockResolvedValue({ callsign: 'AUK-Alpha-Bravo', color: 'Blue' });

    const result = await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });

    expect(result.takAttributes).toEqual({ callsign: 'AUK-Alpha-Bravo', color: 'Blue', role: 'Team Member' });
    expect(JSON.stringify(result.takAttributes)).not.toMatch(/WRONG/);
  });
});

// ---------------------------------------------------------------------------
// 6. 'None' for callsign, color AND role for a principal with NO team
// membership and no tak_role set (Criterion 15.3) -- not '', not null,
// not undefined.
// ---------------------------------------------------------------------------

describe("a principal with NO team membership yields the exact string 'None' for callsign, color AND role", () => {
  it("returns { callsign: 'None', color: 'None', role: 'None' } when tak_role is null and the principal has no team membership at all", async () => {
    User.findById.mockResolvedValue({ ...HUMAN_ROW, tak_role: null });
    mockAxiosClient.post.mockResolvedValue({ data: { identifier: 'device-enrollment-xyz', expires: '2024-01-01T00:30:00.000Z' } });
    mockAxiosClient.get.mockResolvedValue({ data: { key: 'super-secret-app-password' } });
    // Default beforeEach mock already answers the team_memberships query
    // with an empty row set (no team).

    const result = await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });

    expect(result.takAttributes).toEqual({ callsign: 'None', color: 'None', role: 'None' });
    expect(result.takAttributes.callsign).not.toBe('');
    expect(result.takAttributes.color).not.toBe('');
    expect(result.takAttributes.role).not.toBe('');
    expect(result.takAttributes.callsign).not.toBeNull();
    expect(result.takAttributes.role).not.toBeUndefined();
    // With no team resolved, generateCallsign has nothing to be called with.
    expect(UserAttributesService.generateCallsign).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. The POSITIVE half of Criterion 3.2: #buildEnrollment, reached via
// generateSelfEnrollment, accepts an is_team_device = false row with no
// special-casing and produces a COMPLETE enrollment shape.
// ---------------------------------------------------------------------------

describe("#buildEnrollment's core accepts an is_team_device = false row with no special-casing, producing a complete shape (positive half of Criterion 3.2)", () => {
  it('generates a full, complete enrollment for a human principal via generateSelfEnrollment, with every expected field present and no error thrown', async () => {
    User.findById.mockResolvedValue({ ...HUMAN_ROW, tak_role: 'Team Member' });
    mockAxiosClient.post.mockResolvedValue({ data: { identifier: 'device-enrollment-xyz', expires: '2024-01-01T00:30:00.000Z' } });
    mockAxiosClient.get.mockResolvedValue({ data: { key: 'super-secret-app-password' } });
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
        return Promise.resolve({ rows: [{ team_id: 7 }] });
      }
      if (typeof sql === 'string' && sql.includes('FROM tak_devices')) {
        return Promise.resolve({ rows: [{ count: '2' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    UserAttributesService.generateCallsign.mockResolvedValue({ callsign: 'AUK-Alpha-Bravo', color: 'Blue' });

    const result = await DeviceEnrollmentService.generateSelfEnrollment({ userId: 43, is_global_manager: false });

    expect(result).toMatchObject({
      principalId: 43,
      principalKind: 'human',
      username: 'jsmith',
      host: 'tak.example.com',
      liveCertificateCount: 2,
      takAttributes: { callsign: 'AUK-Alpha-Bravo', color: 'Blue', role: 'Team Member' }
    });
    expect(result.expiresAt).toBeDefined();
    expect(result.reEnrollmentDate).toBeDefined();
    expect(result.atakEnrollmentUri).toContain('tak://com.atakmap.app/enroll?');
    expect(result.itakRegistrationPayload).toMatchObject({ passphrase: 'false', type: 'registration' });
    expect(result.atakQrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(result.itakQrDataUrl).toMatch(/^data:image\/png;base64,/);

    // Every field #buildEnrollment's doc comment promises is present --
    // no field silently dropped and no unexpected extra field either.
    expect(Object.keys(result).sort()).toEqual(
      [
        'principalId',
        'principalKind',
        'username',
        'host',
        'expiresAt',
        'reEnrollmentDate',
        'atakEnrollmentUri',
        'itakRegistrationPayload',
        'atakQrDataUrl',
        'itakQrDataUrl',
        'takAttributes',
        'liveCertificateCount'
      ].sort()
    );
  });
});
