jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

// `resolveScope` is spied so each test can force the Global_Manager
// (`UNSCOPED`) branch or the scoped branch deterministically; every other
// static member (the frozen `UNSCOPED` sentinel itself, `buildScopeResponse`,
// ...) stays real, following the pattern in
// `server/routes/users.directoryScope.test.js`.
jest.mock('../DirectoryScopeService', () => {
  const actual = jest.requireActual('../DirectoryScopeService');
  actual.resolveScope = jest.fn();
  return actual;
});

const mockLoggerWarn = jest.fn();
jest.mock('../../middleware/requestContext', () => ({
  getLogger: () => ({ warn: mockLoggerWarn, info: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

const pool = require('../../config/database');
const DirectoryScopeService = require('../DirectoryScopeService');
const DeviceManagementService = require('../DeviceManagementService');
const { NotManagedUserError, DeviceNotOwnedError } = require('../DeviceManagementService');

/**
 * device-management task 11.2: unit tests for `DeviceManagementService`
 * (Requirements 5.5, 6.2, 6.6, 6.7, 7.5, 8.5, 8.6, 9.3, 9.4).
 *
 * Mocked collaborators only: the `config/database` pool (the convention used
 * by the sibling service tests) and `DirectoryScopeService.resolveScope`.
 *
 * The pool mock is a small interpreter rather than a fixed `mockResolvedValue`:
 * it holds a seeded `tak_devices` table and a seeded set of direct-admin
 * relationships, and answers each of the service's three statements by
 * applying that statement's own parameters. So "the self-view returns only the
 * caller's own rows" is asserted against a table that also contains OTHER
 * users' rows -- the assertion fails if the service ever widens its filter,
 * which a stubbed row list could not detect.
 *
 * Coverage of these rules across many generated admin/target/device
 * relationships is tasks 16.5 and 16.6 (Properties 5 and 6); these are
 * example/unit tests.
 */

/** A `tak_devices` row as the pool would hand it back (snake_case). */
function deviceRow(overrides = {}) {
  return {
    client_uid: 'uid-1',
    user_id: 1,
    cert_id: 10,
    issued_at: new Date('2024-01-01T00:00:00.000Z'),
    expires_at: new Date('2025-01-01T00:00:00.000Z'),
    last_seen_at: null,
    revoked: false,
    // Criterion 20.2: a stored column with a default of false, so a row that
    // no successful poll has touched yet arrives from the pool as false.
    connected: false,
    ...overrides
  };
}

/**
 * Seeds the mocked pool with a `tak_devices` table and a set of
 * `[adminId, targetId]` direct-admin pairs, then answers:
 *
 *   - the managed-user join   -> whether the pair was seeded
 *   - `WHERE user_id = $1`    -> the rows whose `user_id` matches
 *   - `WHERE client_uid = $1` -> the row with that primary key, if any
 *
 * Any other statement throws, so an unexpected read shows up as a failure
 * rather than as an empty result.
 */
function mockDb({ devices = [], managedPairs = [] } = {}) {
  pool.query.mockImplementation((sql, params = []) => {
    if (sql.includes('FROM team_memberships')) {
      const [adminId, targetId] = params;
      const managed = managedPairs.some(
        ([admin, target]) => String(admin) === String(adminId) && String(target) === String(targetId)
      );
      return Promise.resolve({ rows: managed ? [{ exists: 1 }] : [] });
    }

    // The self/managed list now qualifies the predicate as `d.user_id = $1`
    // (it joins `tak_devices d` to users/user_cache for the assigned callsign,
    // callsign-mismatch detection); accept either form. Seeded rows carry no
    // `observed_callsign`/`assigned_callsign`, so mapDevice reports no callsign
    // mismatch for them, which is what these pre-callsign tests expect.
    if (
      sql.includes('FROM tak_devices') &&
      (sql.includes('WHERE user_id = $1') || sql.includes('WHERE d.user_id = $1'))
    ) {
      return Promise.resolve({
        rows: devices.filter((row) => row.user_id !== null && String(row.user_id) === String(params[0]))
      });
    }

    if (sql.includes('FROM tak_devices') && sql.includes('WHERE client_uid = $1')) {
      return Promise.resolve({ rows: devices.filter((row) => row.client_uid === params[0]) });
    }

    throw new Error(`Unexpected query: ${sql}`);
  });
}

/** The `tak_devices` reads the service issued, for "read nothing" assertions. */
function deviceQueries() {
  return pool.query.mock.calls.filter(([sql]) => sql.includes('FROM tak_devices'));
}

/** The managed-user join calls the service issued. */
function membershipQueries() {
  return pool.query.mock.calls.filter(([sql]) => sql.includes('FROM team_memberships'));
}

const SCOPED = Object.freeze({ unscoped: false, organisationIds: [7], allowedDomains: [] });

beforeEach(() => {
  jest.clearAllMocks();
  // Default: a non-Global_Manager caller, so the direct-admin leg decides.
  DirectoryScopeService.resolveScope.mockResolvedValue(SCOPED);
});

// ══════════════════════════════════════════════════════════════════════════
// Requirements 5.5, 9.3: the self-view is scoped on the SERVER to the
// caller's own Devices.
// ══════════════════════════════════════════════════════════════════════════
describe('DeviceManagementService.listOwnDevices', () => {
  it('returns only the caller\'s own rows out of a table holding several users\' devices', async () => {
    mockDb({
      devices: [
        deviceRow({ client_uid: 'mine-a', user_id: 1 }),
        deviceRow({ client_uid: 'theirs-a', user_id: 2 }),
        deviceRow({ client_uid: 'mine-b', user_id: 1 }),
        deviceRow({ client_uid: 'orphan', user_id: null })
      ]
    });

    const devices = await DeviceManagementService.listOwnDevices(1);

    expect(devices.map((d) => d.clientUid).sort()).toEqual(['mine-a', 'mine-b']);
  });

  it('passes the caller\'s own id as the only query parameter, filtering on user_id', async () => {
    mockDb({ devices: [deviceRow({ user_id: 42 })] });

    await DeviceManagementService.listOwnDevices(42);

    const [sql, params] = deviceQueries()[0];
    expect(sql).toContain('WHERE d.user_id = $1');
    expect(params).toEqual([42]);
  });

  it('returns an empty list for a user with no devices', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'theirs', user_id: 2 })] });

    await expect(DeviceManagementService.listOwnDevices(1)).resolves.toEqual([]);
  });

  it('maps each row to the camelCase wire shape, passing a null lastSeenAt through', async () => {
    mockDb({
      devices: [
        deviceRow({
          client_uid: 'uid-9',
          user_id: 3,
          cert_id: 99,
          last_seen_at: null,
          revoked: true,
          last_polled_at: new Date('2024-06-01T00:00:00.000Z')
        })
      ]
    });

    const [device] = await DeviceManagementService.listOwnDevices(3);

    // Requirements 5.3/6.5: null survives as null so the client renders
    // "never seen" -- the server substitutes nothing.
    expect(device).toEqual({
      clientUid: 'uid-9',
      certId: 99,
      issuedAt: new Date('2024-01-01T00:00:00.000Z'),
      expiresAt: new Date('2025-01-01T00:00:00.000Z'),
      lastSeenAt: null,
      revoked: true,
      // Requirement 20.8: Connection_Status is passed straight through from
      // the stored column, on the same single wire shape.
      connected: false,
      // Callsign-mismatch detection: the seeded row carries no
      // observed_callsign/assigned_callsign, so mapDevice reports the
      // absent-input defaults (no observed callsign, no mismatch).
      observedCallsign: null,
      callsignMismatch: false,
      // Requirements 15.1/15.2: derived on read from the Client_Uid alone;
      // `uid-9` matches no rule, so `unknown` is the honest answer.
      clientType: 'unknown'
    });
    // Internal bookkeeping and the redundant owner id are not on the wire.
    expect(Object.keys(device)).not.toContain('user_id');
    expect(Object.keys(device)).not.toContain('lastPolledAt');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirements 7.5, 9.3: self-revocation is authorized on the SERVER, and
// only for a Device the caller owns.
// ══════════════════════════════════════════════════════════════════════════
describe('DeviceManagementService.assertCanRevokeOwn', () => {
  it('resolves the mapped device when the caller owns it', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'mine', user_id: 1, cert_id: 55 })] });

    await expect(DeviceManagementService.assertCanRevokeOwn(1, 'mine')).resolves.toMatchObject({
      clientUid: 'mine',
      certId: 55
    });
  });

  it('accepts a route-param string id for the same owner', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'mine', user_id: 5 })] });

    await expect(DeviceManagementService.assertCanRevokeOwn('5', 'mine')).resolves.toMatchObject({
      clientUid: 'mine'
    });
  });

  it('throws DeviceNotOwnedError for a device belonging to another user', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'theirs', user_id: 2 })] });

    await expect(DeviceManagementService.assertCanRevokeOwn(1, 'theirs')).rejects.toThrow(DeviceNotOwnedError);
  });

  it('throws the same DeviceNotOwnedError for a client_uid that does not exist', async () => {
    mockDb({ devices: [] });

    // Deliberately indistinguishable from "not yours", so the status code
    // cannot be used to probe which device UIDs exist.
    await expect(DeviceManagementService.assertCanRevokeOwn(1, 'nope')).rejects.toThrow(DeviceNotOwnedError);
  });

  it('throws for a device whose user_id is NULL (an unmatched certificate belongs to nobody)', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'orphan', user_id: null })] });

    await expect(DeviceManagementService.assertCanRevokeOwn(1, 'orphan')).rejects.toThrow(DeviceNotOwnedError);
  });

  it('carries the requested uid and the expected owner on the error', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'theirs', user_id: 2 })] });

    await expect(DeviceManagementService.assertCanRevokeOwn(1, 'theirs')).rejects.toMatchObject({
      name: 'DeviceNotOwnedError',
      clientUid: 'theirs',
      expectedUserId: 1
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirements 6.2, 6.6, 6.7, 9.4: an admin's view reaches Managed_Users
// only, decided on the SERVER.
// ══════════════════════════════════════════════════════════════════════════
describe('DeviceManagementService.listManagedUserDevices', () => {
  const admin = { userId: 10, is_global_manager: false };

  it('returns the target\'s devices when the target is a direct-admin managed user', async () => {
    mockDb({
      devices: [
        deviceRow({ client_uid: 'target-a', user_id: 20 }),
        deviceRow({ client_uid: 'other', user_id: 30 })
      ],
      managedPairs: [[10, 20]]
    });

    const devices = await DeviceManagementService.listManagedUserDevices(admin, 20);

    expect(devices.map((d) => d.clientUid)).toEqual(['target-a']);
  });

  it('decides the relationship from a DIRECT admin row only', async () => {
    mockDb({ devices: [], managedPairs: [[10, 20]] });

    await DeviceManagementService.listManagedUserDevices(admin, 20);

    const [sql, params] = membershipQueries()[0];
    expect(sql).toContain("admin_row.role = 'admin'");
    expect(sql).toContain('admin_row.inherited_from_team_id IS NULL');
    expect(params).toEqual([10, 20]);
  });

  it('rejects with NotManagedUserError for a target the admin does not manage', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'target-a', user_id: 99 })], managedPairs: [[10, 20]] });

    await expect(DeviceManagementService.listManagedUserDevices(admin, 99)).rejects.toThrow(NotManagedUserError);
  });

  it('reads no device data at all when the target is not managed', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'target-a', user_id: 99 })], managedPairs: [] });

    await expect(DeviceManagementService.listManagedUserDevices(admin, 99)).rejects.toThrow(NotManagedUserError);
    expect(deviceQueries()).toHaveLength(0);
  });

  it('returns any user\'s devices for a Global_Manager without issuing a managed-user query', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'anyones', user_id: 77 })], managedPairs: [] });
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);

    const globalManager = { userId: 1, is_global_manager: true };
    const devices = await DeviceManagementService.listManagedUserDevices(globalManager, 77);

    expect(devices.map((d) => d.clientUid)).toEqual(['anyones']);
    // The UNSCOPED short-circuit decides it -- no direct-admin lookup needed.
    expect(membershipQueries()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirements 8.5, 8.6, 9.4: admin revocation requires BOTH that the target
// is a Managed_User AND that the Device belongs to that target, checked
// upfront.
// ══════════════════════════════════════════════════════════════════════════
describe('DeviceManagementService.assertCanRevokeManaged', () => {
  const admin = { userId: 10, is_global_manager: false };

  it('resolves the device when the target is managed and owns it', async () => {
    mockDb({
      devices: [deviceRow({ client_uid: 'target-a', user_id: 20, cert_id: 33 })],
      managedPairs: [[10, 20]]
    });

    await expect(DeviceManagementService.assertCanRevokeManaged(admin, 20, 'target-a')).resolves.toMatchObject({
      clientUid: 'target-a',
      certId: 33
    });
  });

  it('resolves for a Global_Manager against any user\'s device', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'anyones', user_id: 77 })], managedPairs: [] });
    DirectoryScopeService.resolveScope.mockResolvedValue(DirectoryScopeService.UNSCOPED);

    const globalManager = { userId: 1, is_global_manager: true };

    await expect(
      DeviceManagementService.assertCanRevokeManaged(globalManager, 77, 'anyones')
    ).resolves.toMatchObject({ clientUid: 'anyones' });
  });

  it('rejects with NotManagedUserError, before reading the device, for a non-managed target', async () => {
    mockDb({ devices: [deviceRow({ client_uid: 'target-a', user_id: 99 })], managedPairs: [[10, 20]] });

    await expect(DeviceManagementService.assertCanRevokeManaged(admin, 99, 'target-a')).rejects.toThrow(
      NotManagedUserError
    );
    expect(deviceQueries()).toHaveLength(0);
  });

  it('rejects with DeviceNotOwnedError when the target is managed but the device is someone else\'s', async () => {
    mockDb({
      devices: [deviceRow({ client_uid: 'not-theirs', user_id: 30 })],
      managedPairs: [[10, 20]]
    });

    await expect(DeviceManagementService.assertCanRevokeManaged(admin, 20, 'not-theirs')).rejects.toThrow(
      DeviceNotOwnedError
    );
  });

  it('carries the acting and target ids on the NotManagedUserError', async () => {
    mockDb({ devices: [], managedPairs: [] });

    await expect(DeviceManagementService.assertCanRevokeManaged(admin, 99, 'uid-1')).rejects.toMatchObject({
      name: 'NotManagedUserError',
      actingUserId: 10,
      targetUserId: 99
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// device-management task 22.6 / Requirements 15.1, 15.2: `clientType` is on
// the wire shape of the self-view AND the admin view, derived on read from
// the Client_Uid alone.
//
// Both views are asserted against the SAME seeded rows, because Criterion
// 15.2's whole point is that the Dashboard card and the user-details modal
// cannot diverge: they read through one `mapDevice`, so the same Client_Uid
// must yield the same `clientType` on both paths. A per-rule expectation is
// used rather than a single spot-check so a regression in the ordering of
// `mapDevice`'s call shows up here as well as in the classifier's own tests.
// ══════════════════════════════════════════════════════════════════════════
describe('clientType on the Device wire shape (Requirements 15.1, 15.2)', () => {
  const admin = { userId: 10, is_global_manager: false };

  /** One real Client_Uid per classification rule, as seen on the live server. */
  const LIVE_ROWS = [
    { client_uid: 'ckadmin (ETL)', clientType: 'cloudtak' },
    { client_uid: 'ANDROID-CloudTAK-chris@chriselsen.net', clientType: 'cloudtak' },
    { client_uid: 'ANDROID-63040a40563b5fab', clientType: 'android' },
    { client_uid: 'CE17C84D-9700-4080-BA5A-44AF51809453', clientType: 'ios' },
    { client_uid: 'S-1-5-21-2281966494-490247268-205662872-1002', clientType: 'windows' },
    { client_uid: 'some-random-client-name', clientType: 'unknown' }
  ];

  /** `{ [clientUid]: clientType }` for a returned device list. */
  function typesByUid(devices) {
    return Object.fromEntries(devices.map((device) => [device.clientUid, device.clientType]));
  }

  const EXPECTED_TYPES = Object.fromEntries(LIVE_ROWS.map((row) => [row.client_uid, row.clientType]));

  function seedLiveRows(userId) {
    mockDb({
      devices: LIVE_ROWS.map((row) => deviceRow({ client_uid: row.client_uid, user_id: userId })),
      managedPairs: [[10, 20]]
    });
  }

  it('puts a clientType on every device returned by the self-view', async () => {
    seedLiveRows(1);

    const devices = await DeviceManagementService.listOwnDevices(1);

    expect(devices).toHaveLength(LIVE_ROWS.length);
    expect(typesByUid(devices)).toEqual(EXPECTED_TYPES);
    devices.forEach((device) => {
      expect(device).toHaveProperty('clientType');
    });
  });

  it('puts the SAME clientType on every device returned by the admin view', async () => {
    seedLiveRows(20);

    const devices = await DeviceManagementService.listManagedUserDevices(admin, 20);

    expect(typesByUid(devices)).toEqual(EXPECTED_TYPES);
  });

  it('puts a clientType on the device returned by each revoke assertion', async () => {
    seedLiveRows(20);

    await expect(
      DeviceManagementService.assertCanRevokeOwn(20, 'ANDROID-63040a40563b5fab')
    ).resolves.toMatchObject({ clientType: 'android' });

    await expect(
      DeviceManagementService.assertCanRevokeManaged(admin, 20, 'ckadmin (ETL)')
    ).resolves.toMatchObject({ clientType: 'cloudtak' });
  });

  it('derives clientType on read rather than selecting a stored column (Requirement 15.2)', async () => {
    seedLiveRows(1);

    // No `client_type` column is read, because none exists: the field is a
    // pure function of `client_uid`, so there is nothing to migrate, nothing
    // to backfill, and nothing that can go stale (Criterion 15.2).
    const [device] = await DeviceManagementService.listOwnDevices(1);
    expect(device.clientType).toBe('cloudtak');
    deviceQueries().forEach(([sql]) => {
      expect(sql).not.toContain('client_type');
    });
  });

  it('classifies a NULL client_uid as unknown instead of failing the whole list', async () => {
    // `mapDevice` runs for every row of every device response, so an odd
    // Client_Uid must never turn one row into a failed request.
    mockDb({ devices: [deviceRow({ client_uid: null, user_id: 1 })] });

    const [device] = await DeviceManagementService.listOwnDevices(1);
    expect(device.clientType).toBe('unknown');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// device-management task 28.6 / Requirement 20.8: `connected` is on the
// Device wire shape, READ FROM THE STORED COLUMN rather than derived.
//
// The contrast with `clientType` above is the point. Both fields appear on the
// same wire shape and look alike there, but `clientType` is a pure function of
// `client_uid` with no column behind it (Criterion 15.2) while `connected` is
// current state observed on TAK Server with nothing in the row to derive it
// from (Criterion 20.2). So these tests pin the OPPOSITE property to the
// `clientType` tests: that no other field on the row influences `connected`,
// and that the column is actually selected.
// ══════════════════════════════════════════════════════════════════════════
describe('connected on the Device wire shape (Requirement 20.8)', () => {
  const admin = { userId: 10, is_global_manager: false };

  it('passes the stored column value straight through, for both true and false', () => {
    expect(DeviceManagementService.mapDevice(deviceRow({ connected: true }))).toMatchObject({
      connected: true
    });
    expect(DeviceManagementService.mapDevice(deviceRow({ connected: false }))).toMatchObject({
      connected: false
    });
  });

  it('is decided by the column ALONE: two rows differing only in `connected` differ only in `connected`', () => {
    // Everything else about these rows is identical, so if the mapped outputs
    // differ anywhere other than `connected`, something is deriving state.
    const disconnected = DeviceManagementService.mapDevice(deviceRow({ connected: false }));
    const connected = DeviceManagementService.mapDevice(deviceRow({ connected: true }));

    expect(connected).toEqual({ ...disconnected, connected: true });
  });

  it('does NOT derive `connected` from last_seen_at, revoked, or expires_at', () => {
    // A recent Last_Seen is the most tempting thing to infer a live connection
    // from -- and inferring it is exactly the defect Requirement 20.1 exists
    // to close ("not left inferring a live connection from a timestamp in the
    // past"). A fresh timestamp with a stored false must stay false.
    expect(
      DeviceManagementService.mapDevice(
        deviceRow({ last_seen_at: new Date(), revoked: false, connected: false })
      ).connected
    ).toBe(false);

    // ...and the mirror image: no Last_Seen at all, revoked, and an expired
    // certificate must not talk a stored true down to false. Only the poller
    // writes this column (Criterion 20.10); the read path just reports it.
    expect(
      DeviceManagementService.mapDevice(
        deviceRow({
          last_seen_at: null,
          revoked: true,
          expires_at: new Date('2000-01-01T00:00:00.000Z'),
          connected: true
        })
      ).connected
    ).toBe(true);
  });

  it('selects the `connected` column, because stored state cannot be reported without reading it', async () => {
    mockDb({ devices: [deviceRow({ user_id: 1, connected: true })] });

    const [device] = await DeviceManagementService.listOwnDevices(1);

    expect(device.connected).toBe(true);
    expect(deviceQueries()).not.toHaveLength(0);
    deviceQueries().forEach(([sql]) => {
      expect(sql).toMatch(/SELECT[\s\S]*\bconnected\b[\s\S]*FROM tak_devices/);
    });
  });

  it('carries `connected` on all four endpoints\' devices, from the one mapDevice', async () => {
    mockDb({
      devices: [
        deviceRow({ client_uid: 'live', user_id: 20, connected: true }),
        deviceRow({ client_uid: 'offline', user_id: 20, connected: false })
      ],
      managedPairs: [[10, 20]]
    });

    // Self-view, admin view, and both revoke assertions -- one wire shape, so
    // no surface can see the field while another does not.
    const own = await DeviceManagementService.listOwnDevices(20);
    expect(own.map((d) => [d.clientUid, d.connected]).sort()).toEqual([
      ['live', true],
      ['offline', false]
    ]);

    const managed = await DeviceManagementService.listManagedUserDevices(admin, 20);
    expect(managed.map((d) => [d.clientUid, d.connected]).sort()).toEqual([
      ['live', true],
      ['offline', false]
    ]);

    await expect(DeviceManagementService.assertCanRevokeOwn(20, 'live')).resolves.toMatchObject({
      connected: true
    });
    await expect(
      DeviceManagementService.assertCanRevokeManaged(admin, 20, 'offline')
    ).resolves.toMatchObject({ connected: false });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Callsign-mismatch detection (docs/callsign-mismatch-design.md): mapDevice
// emits observedCallsign + a computed callsignMismatch flag when the query
// supplied the observed and assigned callsigns. The flag is scoped exactly like
// the poller/nudge: connected, non-CloudTAK, observed not acceptable.
// ══════════════════════════════════════════════════════════════════════════
describe('callsign mismatch on the Device wire shape', () => {
  // A native (android) row connected with the assigned callsign present.
  function callsignRow(overrides = {}) {
    return deviceRow({
      client_uid: 'ANDROID-63040a40563b5fab',
      connected: true,
      observed_callsign: 'FENZ-STL-J.Doe',
      assigned_callsign: 'FENZ-STL-J.Doe',
      ...overrides
    });
  }

  it('reports observedCallsign and no mismatch when the connected callsign matches the assigned one', () => {
    const mapped = DeviceManagementService.mapDevice(callsignRow());
    expect(mapped.observedCallsign).toBe('FENZ-STL-J.Doe');
    expect(mapped.callsignMismatch).toBe(false);
  });

  it('reports no mismatch for a valid append', () => {
    const mapped = DeviceManagementService.mapDevice(
      callsignRow({ observed_callsign: 'FENZ-STL-J.Doe (Tablet)' })
    );
    expect(mapped.callsignMismatch).toBe(false);
  });

  it('flags a mismatch when the connected callsign does not preserve the assigned one', () => {
    const mapped = DeviceManagementService.mapDevice(
      callsignRow({ observed_callsign: 'FENZ-WRONG' })
    );
    expect(mapped.observedCallsign).toBe('FENZ-WRONG');
    expect(mapped.callsignMismatch).toBe(true);
  });

  it('does not flag a disconnected device even if the observed callsign is wrong', () => {
    const mapped = DeviceManagementService.mapDevice(
      callsignRow({ observed_callsign: 'FENZ-WRONG', connected: false })
    );
    expect(mapped.callsignMismatch).toBe(false);
  });

  it('does not flag a CloudTAK device (it cannot change its callsign)', () => {
    const mapped = DeviceManagementService.mapDevice(
      callsignRow({ client_uid: 'ANDROID-CloudTAK-jdoe@example.com', observed_callsign: 'FENZ-WRONG' })
    );
    expect(mapped.callsignMismatch).toBe(false);
  });

  it('does not flag a teamless user (no assigned callsign)', () => {
    const mapped = DeviceManagementService.mapDevice(
      callsignRow({ observed_callsign: 'FENZ-WRONG', assigned_callsign: null })
    );
    expect(mapped.callsignMismatch).toBe(false);
  });

  it('defaults to no observed callsign and no mismatch when the query did not join them (revoke-path lookup)', () => {
    // A plain tak_devices row (no observed_callsign / assigned_callsign keys).
    const mapped = DeviceManagementService.mapDevice(deviceRow({ connected: true }));
    expect(mapped.observedCallsign).toBeNull();
    expect(mapped.callsignMismatch).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirements 17.8, 21.9: visibility has EXACTLY ONE mechanism -- the
// presence of the Device_Table row.
//
// Stale rows are removed by the Device_Sync's deletion (Criterion 17.1) and
// nothing else, so the read path must not grow a second, redundant filter that
// can disagree with it: no `last_polled_at` freshness check, no `revoked`
// check, no `connected` check now that the column is selected (20.8), and no
// expiry predicate (21.9 -- the classification of an imminent or already-past
// expiry is presentation, decided client-side against the threshold on the
// public config).
//
// Asserted two ways deliberately. Behaviourally, because that is what actually
// matters: a row that every one of those filters would have excluded is still
// returned. And textually against the emitted SQL, because a filter added to
// the statement is the specific regression these criteria forbid, and a
// behavioural test using a hand-written pool interpreter could be satisfied by
// an interpreter that simply ignored the new predicate.
// ══════════════════════════════════════════════════════════════════════════
describe('listOwnDevices keeps exactly one visibility mechanism (Requirements 17.8, 21.9)', () => {
  /** A row that a freshness, revoked, connected or expiry filter would all hide. */
  function unappealingRow() {
    return deviceRow({
      client_uid: 'stale-revoked-expired-offline',
      user_id: 1,
      // Long expired.
      expires_at: new Date('2000-01-01T00:00:00.000Z'),
      // Never observed.
      last_seen_at: null,
      // Revoked, and not yet deleted by the next completed sync (17.7).
      revoked: true,
      connected: false,
      // Not touched by a recent sync.
      last_polled_at: new Date('2000-01-01T00:00:00.000Z')
    });
  }

  it('returns a row that is revoked, expired, never-seen, not connected and stale-polled', async () => {
    mockDb({ devices: [unappealingRow()] });

    const devices = await DeviceManagementService.listOwnDevices(1);

    // Present because its row is present. The "Revoked" badge and the
    // "Expired" marker are how the client presents this Device; neither is a
    // reason for the server to hide it.
    expect(devices.map((d) => d.clientUid)).toEqual(['stale-revoked-expired-offline']);
    expect(devices[0]).toMatchObject({ revoked: true, connected: false, lastSeenAt: null });
  });

  it('filters on user_id and nothing else, with the owner id as the only parameter', async () => {
    mockDb({ devices: [unappealingRow()] });

    await DeviceManagementService.listOwnDevices(1);

    const [sql, params] = deviceQueries()[0];
    const whereClause = sql.slice(sql.indexOf('WHERE'), sql.indexOf('ORDER BY'));

    // Qualified as `d.user_id = $1` since the self-view now joins tak_devices d
    // to users/user_cache for the assigned callsign (callsign-mismatch
    // detection). The scope guarantee is unchanged and is what this asserts:
    // the ONLY device-scoping predicate is user_id, bound to the single
    // parameter $1 -- no client-supplied filter widens it.
    expect(whereClause.trim()).toBe('WHERE d.user_id = $1');
    expect(params).toEqual([1]);
    // One placeholder, so there is no second predicate to bind.
    expect(sql.match(/\$\d/g)).toEqual(['$1']);
  });

  it('adds no connected predicate and no expiry predicate to any device read', async () => {
    mockDb({ devices: [unappealingRow()] });

    await DeviceManagementService.listOwnDevices(1);
    await DeviceManagementService.findDeviceRow('stale-revoked-expired-offline');

    deviceQueries().forEach(([sql]) => {
      // `connected` and `expires_at` appear in the SELECT list; what is
      // forbidden is either of them appearing as a COMPARISON.
      expect(sql).not.toMatch(/connected\s*(=|<>|!=|IS\b)/i);
      expect(sql).not.toMatch(/expires_at\s*(=|<|>|<=|>=|<>|!=|IS\b)/i);
      expect(sql).not.toMatch(/revoked\s*(=|<>|!=|IS\b)/i);
      // Internal sync bookkeeping is neither selected nor filtered on.
      expect(sql).not.toContain('last_polled_at');
      expect(sql).not.toMatch(/\b(NOW|CURRENT_TIMESTAMP|CURRENT_DATE)\s*\(?/i);
      expect(sql).not.toMatch(/INTERVAL/i);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Requirement 9.4 must fail CLOSED: an unusable acting user is not managed,
// and a database failure is never swallowed into "permitted".
// ══════════════════════════════════════════════════════════════════════════
describe('DeviceManagementService.isManagedUser fails closed', () => {
  it('returns false when the acting user carries no id', async () => {
    mockDb({ managedPairs: [] });

    await expect(DeviceManagementService.isManagedUser({ is_global_manager: false }, 20)).resolves.toBe(false);
  });

  it('returns false for a missing target id, without querying', async () => {
    mockDb({ managedPairs: [] });

    await expect(
      DeviceManagementService.isManagedUser({ userId: 10, is_global_manager: false }, undefined)
    ).resolves.toBe(false);
    expect(membershipQueries()).toHaveLength(0);
  });

  it('propagates a database failure instead of degrading to permitted', async () => {
    const dbError = new Error('connection terminated');
    pool.query.mockRejectedValue(dbError);

    await expect(
      DeviceManagementService.isManagedUser({ userId: 10, is_global_manager: false }, 20)
    ).rejects.toBe(dbError);
  });
});
