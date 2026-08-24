/**
 * device-management task 16.6: the single fast-check property test for
 * design.md's Correctness Property 6 (Requirements 6.6, 6.7, 8.5, 8.6, 9.4).
 *
 * design.md's exact Property 6 statement: "For all admin/target-user pairs
 * and all Device_Table contents, an admin's view or revocation of a target
 * user's Devices SHALL be permitted only when the target user is a
 * Managed_User of that admin (per the direct-admin scoping) AND, for
 * revocation, the target Device belongs to that target user; any request
 * against a non-Managed_User SHALL be denied."
 *
 * ## How it is modelled
 *
 * The mocked `config/database` pool is a small interpreter over an in-memory
 * `tak_devices` table PLUS a generated set of `[adminId, targetId]`
 * direct-admin pairs, which is the answer the service's managed-user join
 * would produce for that pair. The generated pairs stand in for the join's
 * `admin_row.role = 'admin' AND admin_row.inherited_from_team_id IS NULL`
 * membership graph: what the property quantifies over is "is this pair
 * related or not", not the particular teams that made it so.
 *
 * `DirectoryScopeService.resolveScope` is spied so each run picks the
 * Global_Manager branch (its frozen `UNSCOPED` sentinel, kept REAL via
 * `requireActual` so the service's `scope.unscoped` short-circuit is
 * exercised against the actual object) or the scoped branch. Everything in
 * `DeviceManagementService` itself is real.
 *
 * The table deliberately holds OTHER users' Devices (and unmatched
 * `user_id: null` rows) on every run, so "permitted" is not allowed to mean
 * "returned more than the target's own": the expected list is computed
 * independently and compared exactly.
 *
 * Two things each run checks that a call-shape assertion could not:
 *
 *   - permitted-IFF-managed for the view, and
 *     permitted-IFF-(managed AND the Device's `user_id` is the target) for the
 *     revoke -- both directions, so neither a too-permissive nor a
 *     too-restrictive service passes;
 *   - a denied (non-managed) request issues ZERO `tak_devices` reads, which is
 *     Requirement 6.7/8.6's "deny" in its strong form: the caller learns
 *     nothing about the Devices, not even whether the UID exists.
 *
 * Sibling `DeviceManagementService.test.js` covers the concrete examples, the
 * exact SQL text, the error payloads, and the fail-closed paths.
 *
 * **Validates: Requirements 6.6, 6.7, 8.5, 8.6, 9.4**
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

// Only `resolveScope` is replaced; the frozen `UNSCOPED` sentinel and every
// other static member stay real (the pattern used by
// `DeviceManagementService.test.js`).
jest.mock('../DirectoryScopeService', () => {
  const actual = jest.requireActual('../DirectoryScopeService');
  actual.resolveScope = jest.fn();
  return actual;
});

jest.mock('../../middleware/requestContext', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

const fc = require('fast-check');

const pool = require('../../config/database');
const DirectoryScopeService = require('../DirectoryScopeService');
const DeviceManagementService = require('../DeviceManagementService');
const { NotManagedUserError, DeviceNotOwnedError } = require('../DeviceManagementService');
const { classifyClientType } = require('../../utils/clientType');

/** A non-Global_Manager caller's resolved scope: the direct-admin leg decides. */
const SCOPED = Object.freeze({ unscoped: false, organisationIds: [7], allowedDomains: [] });

/** A `client_uid` that is never generated, for the "no such device" case. */
const ABSENT_UID = 'uid-never-generated';

const userIdArb = fc.integer({ min: 1, max: 6 });

const dateArb = fc.option(
  fc.date({ min: new Date('2020-01-01T00:00:00.000Z'), max: new Date('2030-01-01T00:00:00.000Z'), noInvalidDate: true }),
  { nil: null }
);

/**
 * A `tak_devices` row as the pool hands it back (snake_case). `user_id: null`
 * is an Active_Certificate the Device_Sync could not match to a local user --
 * it belongs to nobody, so it must never be revocable through the admin path
 * either.
 */
const deviceRowArb = fc.record({
  client_uid: fc.integer({ min: 0, max: 30 }).map((n) => `uid-${n}`),
  user_id: fc.oneof(
    { arbitrary: userIdArb, weight: 5 },
    { arbitrary: fc.constant(null), weight: 1 }
  ),
  cert_id: fc.integer({ min: 1, max: 9999 }),
  issued_at: dateArb,
  expires_at: dateArb,
  last_seen_at: dateArb,
  revoked: fc.boolean(),
  connected: fc.boolean()
});

const scenarioArb = fc.record({
  actingUserId: userIdArb,
  targetUserId: userIdArb,
  // The route param arrives as a STRING, so both spellings of the same id are
  // generated: a service that compared with `===` would deny half of these.
  targetIdAsString: fc.boolean(),
  isGlobalManager: fc.boolean(),
  // The direct-admin relationships the managed-user join can answer from.
  directAdminPairs: fc.uniqueArray(fc.tuple(userIdArb, userIdArb), {
    maxLength: 8,
    selector: ([admin, target]) => `${admin}:${target}`
  }),
  // Biases the space so the interesting combinations are hit often rather
  // than left to chance, while the unbiased draws above still cover the rest.
  forceManagedPair: fc.boolean(),
  forceTargetOwnedDevice: fc.boolean(),
  devices: fc.uniqueArray(deviceRowArb, { maxLength: 10, selector: (row) => row.client_uid }),
  // Which device the revoke is attempted against: one of the generated rows,
  // or a UID that does not exist at all.
  revokeUidChoice: fc.option(fc.nat({ max: 15 }), { nil: null })
});

/**
 * Seeds the mocked pool and answers the service's three statements from the
 * seeded state, applying each statement's own parameters:
 *
 *   - the managed-user join   -> whether the `[admin, target]` pair was seeded
 *   - `WHERE user_id = $1`    -> the rows whose `user_id` matches
 *   - `WHERE client_uid = $1` -> the row with that primary key, if any
 *
 * Any other statement throws, so an unexpected read surfaces as a failure
 * rather than as an empty result.
 */
function mockDb({ devices, managedPairs }) {
  pool.query.mockImplementation((sql, params = []) => {
    if (sql.includes('FROM team_memberships')) {
      const [adminId, targetId] = params;
      const managed = managedPairs.some(
        ([admin, target]) => String(admin) === String(adminId) && String(target) === String(targetId)
      );
      return Promise.resolve({ rows: managed ? [{ exists: 1 }] : [] });
    }

    if (sql.includes('FROM tak_devices') && sql.includes('WHERE user_id = $1')) {
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

/** The `tak_devices` reads issued so far, for the "read nothing" assertions. */
function deviceQueryCount() {
  return pool.query.mock.calls.filter(([sql]) => sql.includes('FROM tak_devices')).length;
}

/** The managed-user join calls issued so far. */
function membershipQueryCount() {
  return pool.query.mock.calls.filter(([sql]) => sql.includes('FROM team_memberships')).length;
}

/** The wire shape `mapDevice` produces, computed independently of the service. */
function expectedWireShape(row) {
  return {
    clientUid: row.client_uid,
    certId: row.cert_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revoked: row.revoked,
    // Requirement 20.8: read straight off the stored column. This property is
    // about admin scope, so `connected` is here only to keep the wire shape
    // whole -- it never affects which rows are visible (Criterion 17.8).
    connected: row.connected,
    // Requirement 15.1: derived on read from the Client_Uid alone. This
    // property is about admin scope, not classification (Property 11 covers
    // the rules), so it reuses the classifier rather than restating its rules.
    clientType: classifyClientType(row.client_uid)
  };
}

/** Runs `fn`, returning the outcome as data so both branches are assertable. */
async function attempt(fn) {
  try {
    return { permitted: true, value: await fn() };
  } catch (error) {
    return { permitted: false, error };
  }
}

// Feature: device-management, Property 6: Admin scope is strictly limited to managed users
describe('Property 6: Admin scope is strictly limited to managed users', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('holds for all generated admin/target/managed relationships and Device_Table contents', async () => {
    // Non-vacuity counters: the run space has to actually contain permitted
    // AND denied cases of both kinds, or the assertions below prove nothing.
    const seen = { viewPermitted: 0, viewDenied: 0, revokePermitted: 0, notManaged: 0, notOwned: 0 };

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const {
          actingUserId,
          targetUserId,
          targetIdAsString,
          isGlobalManager,
          forceManagedPair,
          forceTargetOwnedDevice,
          revokeUidChoice
        } = scenario;

        const managedPairs = forceManagedPair
          ? [...scenario.directAdminPairs, [actingUserId, targetUserId]]
          : scenario.directAdminPairs;

        const devices = forceTargetOwnedDevice
          ? [
              ...scenario.devices,
              {
                client_uid: 'uid-forced-target',
                user_id: targetUserId,
                cert_id: 4242,
                issued_at: new Date('2024-05-05T00:00:00.000Z'),
                expires_at: new Date('2025-05-05T00:00:00.000Z'),
                last_seen_at: null,
                revoked: false
              }
            ]
          : scenario.devices;

        // Per-run reset: the call LOG has to start empty for the "read
        // nothing" counts below to be about this run only (`mockClear` keeps
        // the implementation `mockDb` installs next).
        pool.query.mockClear();
        DirectoryScopeService.resolveScope.mockClear();

        mockDb({ devices, managedPairs });
        DirectoryScopeService.resolveScope.mockResolvedValue(
          isGlobalManager ? DirectoryScopeService.UNSCOPED : SCOPED
        );

        const actingUser = { userId: actingUserId, is_global_manager: isGlobalManager };
        const routeTargetId = targetIdAsString ? String(targetUserId) : targetUserId;

        // ── The model ────────────────────────────────────────────────────
        // A Global_Manager reaches every user; anyone else reaches exactly
        // the targets they hold a direct-admin relationship with.
        const expectManaged =
          isGlobalManager ||
          managedPairs.some(([admin, target]) => admin === actingUserId && target === targetUserId);

        const expectedVisible = devices
          .filter((row) => row.user_id === targetUserId)
          .map(expectedWireShape);

        const revokeUid =
          revokeUidChoice === null || devices.length === 0
            ? ABSENT_UID
            : devices[revokeUidChoice % devices.length].client_uid;

        const revokeRow = devices.find((row) => row.client_uid === revokeUid);
        const expectOwned = Boolean(revokeRow) && revokeRow.user_id === targetUserId;
        const expectRevokePermitted = expectManaged && expectOwned;

        // ── The admin view (Requirements 6.6, 6.7, 9.4) ──────────────────
        const view = await attempt(() =>
          DeviceManagementService.listManagedUserDevices(actingUser, routeTargetId)
        );

        expect(view.permitted).toBe(expectManaged);

        if (expectManaged) {
          seen.viewPermitted += 1;
          // Exactly the target's own Devices, in the one wire shape -- never a
          // row belonging to another user or to nobody, even though the table
          // holds those too.
          expect(sortByUid(view.value)).toEqual(sortByUid(expectedVisible));
        } else {
          seen.viewDenied += 1;
          expect(view.error).toBeInstanceOf(NotManagedUserError);
          expect(view.error).toMatchObject({ actingUserId, targetUserId: routeTargetId });
          // Denied means no device data was read at all.
          expect(deviceQueryCount()).toBe(0);
        }

        // A Global_Manager is decided by the resolved scope alone -- the
        // direct-admin join is not (and need not be) consulted.
        if (isGlobalManager) {
          expect(membershipQueryCount()).toBe(0);
        }

        // ── The admin revoke (Requirements 8.5, 8.6, 9.4) ────────────────
        // Call log cleared (the seeded implementation is kept) so the
        // "read nothing" assertion below is about this call only.
        pool.query.mockClear();

        const revoke = await attempt(() =>
          DeviceManagementService.assertCanRevokeManaged(actingUser, routeTargetId, revokeUid)
        );

        expect(revoke.permitted).toBe(expectRevokePermitted);

        if (expectRevokePermitted) {
          seen.revokePermitted += 1;
          expect(revoke.value).toEqual(expectedWireShape(revokeRow));
        } else if (!expectManaged) {
          seen.notManaged += 1;
          // The managed-user leg is evaluated FIRST, so a caller with no
          // relationship to the target never touches the Device_Table.
          expect(revoke.error).toBeInstanceOf(NotManagedUserError);
          expect(deviceQueryCount()).toBe(0);
        } else {
          seen.notOwned += 1;
          // Managed target, but the Device is someone else's, nobody's, or
          // does not exist -- all one indistinguishable denial.
          expect(revoke.error).toBeInstanceOf(DeviceNotOwnedError);
          expect(revoke.error).toMatchObject({ clientUid: revokeUid, expectedUserId: routeTargetId });
        }
      }),
      { numRuns: 200 }
    );

    expect(seen.viewPermitted).toBeGreaterThan(0);
    expect(seen.viewDenied).toBeGreaterThan(0);
    expect(seen.revokePermitted).toBeGreaterThan(0);
    expect(seen.notManaged).toBeGreaterThan(0);
    expect(seen.notOwned).toBeGreaterThan(0);
  });
});

/** Order-independent comparison: the ordering contract belongs to Property 5. */
function sortByUid(devices) {
  return [...devices].sort((a, b) => a.clientUid.localeCompare(b.clientUid));
}
