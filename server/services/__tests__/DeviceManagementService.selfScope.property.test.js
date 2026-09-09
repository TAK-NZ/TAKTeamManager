/**
 * device-management task 16.5: the single fast-check property test for
 * design.md's Correctness Property 5 (Requirements 5.5, 7.5, 9.3).
 *
 * MODEL-BASED, like the sibling `DeviceSync.property.test.js`: the mocked
 * `config/database` pool is backed by an in-memory `tak_devices` table and
 * answers each statement by applying THAT statement's own WHERE clause and
 * parameters, with Postgres' semantics for the two things that actually
 * decide this property:
 *
 *   - `user_id = $1` compares an integer column against the bound parameter,
 *     so a route-param STRING `'5'` matches the integer `5`; and
 *   - a NULL `user_id` (an Active_Certificate the Device_Sync could not
 *     attribute to a local user) never equals anything, so such a Device is
 *     owned by nobody.
 *
 * The model refuses any statement it does not recognise, so a service that
 * dropped or widened its filter surfaces as a failure rather than as an
 * empty (vacuously passing) result set.
 *
 * The expected answers are computed independently of the service -- straight
 * from the generated rows, without calling `sameUserId` or reusing the
 * service's SQL -- so the property is a real cross-check and not the
 * implementation compared against itself.
 *
 * Generated tables deliberately mix several owners, rows owned by user ids
 * that no viewer ever holds, and NULL-owner rows; viewers are drawn both as
 * integers and as the string form a route param arrives in. Sibling
 * `DeviceManagementService.test.js` covers the concrete examples, the exact
 * SQL text, and the denial log line.
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../middleware/requestContext', () => ({
  getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

const fc = require('fast-check');

const pool = require('../../config/database');
const DeviceManagementService = require('../DeviceManagementService');
const { DeviceNotOwnedError } = require('../DeviceManagementService');
const { classifyClientType } = require('../../utils/clientType');

/** A `client_uid` that is never generated, so it is always a missing row. */
const ABSENT_CLIENT_UID = 'uid-absent';

/**
 * Postgres' `integer_column = $1`: the bound parameter is coerced to the
 * column's integer type before comparison (so `'5'` = `5`), and NULL on
 * either side yields NULL, which is never true.
 *
 * @param {number|null} columnValue - `tak_devices.user_id`.
 * @param {number|string|null|undefined} param - the bound parameter.
 * @returns {boolean}
 */
function integerColumnEqualsParam(columnValue, param) {
  if (columnValue === null || columnValue === undefined || param === null || param === undefined || param === '') {
    return false;
  }
  return Number(columnValue) === Number(param);
}

/**
 * Installs an in-memory `tak_devices` table behind the mocked pool.
 *
 * Only the two statements this property exercises are recognised -- the
 * self-view's `WHERE user_id = $1` and `findDeviceRow`'s
 * `WHERE client_uid = $1` -- each answered by applying its own WHERE clause.
 * `ORDER BY issued_at DESC NULLS LAST, client_uid ASC` is applied when the
 * statement asks for it, so the returned list is the one the real query
 * would produce.
 *
 * @param {object[]} rows - `tak_devices` rows (snake_case).
 */
function installInMemoryDeviceTable(rows) {
  pool.query.mockImplementation(async (sql, params = []) => {
    if (!sql.includes('FROM tak_devices')) {
      throw new Error(`Unexpected SQL in the self-scope property test: ${sql}`);
    }

    // The self-view now qualifies its predicate/order as `d.user_id`/
    // `d.issued_at`/`d.client_uid` (it joins tak_devices d to users/user_cache
    // for the assigned callsign, callsign-mismatch detection). The self-scope
    // guarantee is unchanged: still bound to $1 alone, no client-supplied
    // filter. Accept either the bare or the `d.`-qualified form.
    if (sql.includes('WHERE user_id = $1') || sql.includes('WHERE d.user_id = $1')) {
      const matched = rows.filter((row) => integerColumnEqualsParam(row.user_id, params[0]));

      if (
        sql.includes('ORDER BY issued_at DESC NULLS LAST, client_uid ASC') ||
        sql.includes('ORDER BY d.issued_at DESC NULLS LAST, d.client_uid ASC')
      ) {
        matched.sort((left, right) => {
          const leftIssued = left.issued_at === null ? null : left.issued_at.getTime();
          const rightIssued = right.issued_at === null ? null : right.issued_at.getTime();

          if (leftIssued !== rightIssued) {
            if (leftIssued === null) return 1; // NULLS LAST
            if (rightIssued === null) return -1;
            return rightIssued - leftIssued; // DESC
          }

          return left.client_uid < right.client_uid ? -1 : 1; // ASC
        });
      }

      return { rows: matched.map((row) => ({ ...row })) };
    }

    if (sql.includes('WHERE client_uid = $1')) {
      return { rows: rows.filter((row) => row.client_uid === params[0]).map((row) => ({ ...row })) };
    }

    throw new Error(`Unexpected tak_devices statement in the self-scope property test: ${sql}`);
  });
}

/** The wire shape `mapDevice` promises, derived here from the raw row. */
function expectedDevice(row) {
  return {
    clientUid: row.client_uid,
    certId: row.cert_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revoked: row.revoked,
    // Requirement 20.8: read straight off the stored column. This property is
    // about scope, so `connected` is here only to keep the wire shape whole --
    // it never affects which rows are visible (Criterion 17.8).
    connected: row.connected,
    // Callsign-mismatch detection: the seeded rows in this scope property carry
    // no `observed_callsign`/`assigned_callsign`, so mapDevice reports the
    // absent-input defaults. (The mismatch classification itself is covered by
    // this feature's own tests; this property is about scope.)
    observedCallsign: null,
    callsignMismatch: false,
    // Requirement 15.1: derived on read from the Client_Uid alone. This
    // property is about scope, not classification (Property 11 covers the
    // rules), so it reuses the classifier rather than restating its rules.
    clientType: classifyClientType(row.client_uid)
  };
}

const timestampArb = fc.date({
  min: new Date('2020-01-01T00:00:00.000Z'),
  max: new Date('2030-01-01T00:00:00.000Z'),
  noInvalidDate: true
});

/**
 * A generated `tak_devices` row. `user_id` is drawn from a small pool so most
 * tables hold several owners, includes ids outside the viewer pool (rows no
 * viewer owns), and is sometimes NULL (owned by nobody).
 */
const deviceRowArb = fc.record({
  client_uid: fc.integer({ min: 0, max: 30 }).map((n) => `uid-${n}`),
  user_id: fc.option(fc.integer({ min: 1, max: 8 }), { nil: null }),
  cert_id: fc.integer({ min: 1, max: 100000 }),
  issued_at: fc.option(timestampArb, { nil: null }),
  expires_at: fc.option(timestampArb, { nil: null }),
  last_seen_at: fc.option(timestampArb, { nil: null }),
  revoked: fc.boolean(),
  connected: fc.boolean()
});

const scenarioArb = fc.record({
  devices: fc.uniqueArray(deviceRowArb, { minLength: 0, maxLength: 12, selector: (row) => row.client_uid }),
  // Viewer ids span owners present in the table and ids that own nothing;
  // `asString` makes the id arrive the way a route param does.
  viewers: fc.uniqueArray(
    fc.record({ id: fc.integer({ min: 1, max: 10 }), asString: fc.boolean() }),
    { minLength: 1, maxLength: 5, selector: (viewer) => viewer.id }
  )
});

// Feature: device-management, Property 5: Self scope is enforced server-side
describe('Property 5: Self scope is enforced server-side', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('holds for all users and Device_Table contents', async () => {
    // Non-vacuity: an empty or single-owner table would make the assertions
    // below trivially true, so both outcomes are counted and checked after
    // the run.
    const observed = { permitted: 0, denied: 0, nullOwner: 0, stringIds: 0 };

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ devices, viewers }) => {
        installInMemoryDeviceTable(devices);

        for (const viewer of viewers) {
          const userId = viewer.asString ? String(viewer.id) : viewer.id;

          // Computed from the generated rows, independently of the service.
          const owned = devices.filter((row) => row.user_id === viewer.id);
          const notOwned = devices.filter((row) => row.user_id !== viewer.id);

          observed.permitted += owned.length;
          observed.denied += notOwned.length;
          observed.nullOwner += notOwned.filter((row) => row.user_id === null).length;
          observed.stringIds += viewer.asString ? 1 : 0;

          // Self-view: exactly the Devices whose user_id is this user.
          const returned = await DeviceManagementService.listOwnDevices(userId);

          expect([...returned].sort((a, b) => (a.clientUid < b.clientUid ? -1 : 1))).toEqual(
            owned.map(expectedDevice).sort((a, b) => (a.clientUid < b.clientUid ? -1 : 1))
          );

          // Self-revocation reaches the caller (and so an enqueue) only for a
          // Device whose user_id is this user...
          for (const row of owned) {
            await expect(DeviceManagementService.assertCanRevokeOwn(userId, row.client_uid)).resolves.toEqual(
              expectedDevice(row)
            );
          }

          // ...and is denied for every other row in the table -- another
          // user's Device, or a NULL-owner Device owned by nobody...
          for (const row of notOwned) {
            await expect(DeviceManagementService.assertCanRevokeOwn(userId, row.client_uid)).rejects.toThrow(
              DeviceNotOwnedError
            );
          }

          // ...and for a client_uid that has no row at all.
          await expect(DeviceManagementService.assertCanRevokeOwn(userId, ABSENT_CLIENT_UID)).rejects.toThrow(
            DeviceNotOwnedError
          );
        }
      }),
      { numRuns: 200 }
    );

    expect(observed.permitted).toBeGreaterThan(0);
    expect(observed.denied).toBeGreaterThan(0);
    expect(observed.nullOwner).toBeGreaterThan(0);
    expect(observed.stringIds).toBeGreaterThan(0);
  });
});
