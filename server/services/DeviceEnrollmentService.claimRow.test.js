/**
 * Dedicated example-based tests for the Claim_Row phasing mechanics and the
 * emailless Team_Owned_Device invariant `DeviceEnrollmentService.createDevice`
 * implements (takserver-enrollment task 6.2; Requirements 1.8, 1.9, 5.1, 5.2,
 * 5.10, 5.11).
 *
 * `DeviceEnrollmentService.test.js` (task 6.1) already covers `createDevice`'s
 * seven top-level example cases: successful creation by a team admin and by a
 * Global_Manager, unauthorized rejection, a missing Organisation_Prefix, a
 * Phase-1 (Authentik) compensation, a Phase-2 (adopt/attach) compensation with
 * a synchronous Authentik delete, and a Phase-2 compensation that falls back
 * to a queued cleanup operation. This file does NOT repeat any of those; it
 * adds a narrower, more exhaustive set of assertions specifically about:
 *
 *   1. ORDER, not just occurrence, of the Claim_Row INSERT relative to the
 *      Authentik createUser call and the Phase-2 adoption UPDATE -- an
 *      assertion that each merely happened would still pass under the OLD
 *      two-phase ordering (authorize -> Authentik createUser -> local
 *      INSERT) `production-hardening` shipped.
 *   2. The EXACT column values the Claim_Row INSERT writes.
 *   3. The compensating DELETE's `authentik_user_id IS NULL` scoping, on
 *      BOTH the Phase-1 and the Phase-2 failure path.
 *   4. NULL, never `''`, for `users.email`, and that `createDevice` itself
 *      never touches `user_cache` at all.
 *   5. The one Device_Display_Name-shaped construction that exists in the
 *      codebase today -- see that describe block's own comment for what
 *      does NOT exist yet and why.
 *   6. `DEVICE_EMAIL_DOMAIN`'s full removal, from the export surface AND
 *      from every non-test server module's source text.
 *   7. Exhaustion after five qualifying (`23505`/`users_username_key`)
 *      rejections, with no Authentik call ever made.
 *   8. First-occurrence propagation of a non-qualifying (`users_email_key`)
 *      rejection, with exactly one claim attempt.
 */

const fs = require('fs');
const path = require('path');

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
jest.mock('./authentik', () => ({
  createUser: jest.fn(),
  createAppPasswordToken: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Team = require('../models/Team');
const TeamMembershipService = require('./TeamMembershipService');
const authentikService = require('./authentik');
const ManagedIdentifierService = require('./ManagedIdentifierService');
const { isManagedIdentifier } = require('../utils/managedIdentifier');
const DeviceEnrollmentService = require('./DeviceEnrollmentService');

const ORGANISATION_ROW = {
  id: 9,
  parent_team_id: null,
  callsign_prefix: 'AUK',
  depth: 0
};

/**
 * A `pool.query` mock dispatching on SQL text, matching the shape used by
 * `DeviceEnrollmentService.test.js`: the Claim_Row INSERT resolves with a
 * fresh id, and the compensating DELETE resolves as a successful removal.
 */
function buildPoolQueryMock({ claimResult = { rows: [{ id: 42 }] } } = {}) {
  return jest.fn((sql) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
      return Promise.resolve(claimResult);
    }
    if (typeof sql === 'string' && sql.includes('DELETE FROM users WHERE id')) {
      return Promise.resolve({ rowCount: 1 });
    }
    return Promise.resolve({ rows: [] });
  });
}

function buildMockClient() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn()
  };
}

// ---------------------------------------------------------------------------
// 1 & 2: order of the Claim_Row INSERT relative to the Authentik call and
// the adoption UPDATE, and the Claim_Row INSERT's exact column values.
// ---------------------------------------------------------------------------

describe('DeviceEnrollmentService.createDevice -- Claim_Row phasing ORDER (Requirements 1.8, 5.1, 5.2, 14.3)', () => {
  let callOrder;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    callOrder = [];

    mockClient = {
      query: jest.fn((sql, params) => {
        let type = 'client.query';
        if (sql === 'BEGIN') type = 'client.begin';
        else if (sql === 'COMMIT') type = 'client.commit';
        else if (sql === 'ROLLBACK') type = 'client.rollback';
        else if (typeof sql === 'string' && sql.startsWith('UPDATE users SET authentik_user_id')) type = 'adopt_update';
        callOrder.push({ type, args: params });
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };

    // A single shared array of {type, args} entries, in invocation order,
    // spanning BOTH the pool.query/pool.connect mock and the
    // authentikService.createUser mock -- what an "each happened" test
    // cannot distinguish from a re-ordered implementation.
    pool.connect.mockImplementation(() => {
      callOrder.push({ type: 'pool.connect', args: undefined });
      return Promise.resolve(mockClient);
    });

    pool.query.mockImplementation((sql, params) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        callOrder.push({ type: 'claim_insert', args: params });
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      if (typeof sql === 'string' && sql.includes('DELETE FROM users WHERE id')) {
        callOrder.push({ type: 'compensating_delete', args: params });
        return Promise.resolve({ rowCount: 1 });
      }
      callOrder.push({ type: 'pool.query.other', args: params });
      return Promise.resolve({ rows: [] });
    });

    authentikService.createUser.mockImplementation((body) => {
      callOrder.push({ type: 'authentik_create_user', args: body });
      return Promise.resolve({ pk: 987 });
    });

    Team.isAdmin.mockResolvedValue(true);
    Team.getAncestorChain.mockResolvedValue([ORGANISATION_ROW]);
    TeamMembershipService.addUserToTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
  });

  it('issues the Claim_Row INSERT before the Authentik createUser call, and adopts it AFTER the createUser call -- ORDER, not merely occurrence', async () => {
    await DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false });

    const claimIndex = callOrder.findIndex((entry) => entry.type === 'claim_insert');
    const createUserIndex = callOrder.findIndex((entry) => entry.type === 'authentik_create_user');
    const adoptIndex = callOrder.findIndex((entry) => entry.type === 'adopt_update');

    // Anti-vacuity: all three phases must actually have been observed
    // before their relative order can mean anything.
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(createUserIndex).toBeGreaterThanOrEqual(0);
    expect(adoptIndex).toBeGreaterThanOrEqual(0);

    // Under the OLD two-phase shape (production-hardening's
    // authorize -> Authentik createUser -> local INSERT), createUserIndex
    // would be SMALLER than claimIndex and this assertion would fail --
    // which is exactly the distinction an "each happened" check misses.
    expect(claimIndex).toBeLessThan(createUserIndex);
    expect(createUserIndex).toBeLessThan(adoptIndex);
  });

  it("writes the Claim_Row INSERT's exact column values: a real Managed_Identifier username, authentik_user_id NULL, is_active false, is_team_device true, email NULL, device_label set", async () => {
    const result = await DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false });

    const claimCall = callOrder.find((entry) => entry.type === 'claim_insert');
    expect(claimCall).toBeDefined();

    const claimSql = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    )[0];
    const normalizedSql = claimSql.replace(/\s+/g, ' ').trim();

    // Column list and VALUES clause, matched pair-wise by position: the
    // three literal (non-parameterized) columns carry their exact required
    // value, and the two parameterized columns are asserted below.
    //   username           -> $1  (a real Managed_Identifier)
    //   authentik_user_id  -> NULL
    //   is_active          -> false
    //   is_team_device     -> true
    //   email              -> NULL
    //   device_label       -> $2  (the supplied label)
    expect(normalizedSql).toContain(
      'INSERT INTO users (username, authentik_user_id, is_active, is_team_device, email, device_label)'
    );
    expect(normalizedSql).toContain('VALUES ($1, NULL, false, true, NULL, $2)');

    const [candidateUsername, deviceLabelParam] = claimCall.args;
    expect(isManagedIdentifier(candidateUsername)).toBe(true);
    expect(candidateUsername.startsWith('AUK-D')).toBe(true);
    expect(candidateUsername).toBe(result.username);
    expect(deviceLabelParam).toBe('Engine 4 Tablet');
  });
});

// ---------------------------------------------------------------------------
// 3: the compensating DELETE's authentik_user_id IS NULL scoping, on BOTH
// failure paths. A test that only asserts a DELETE was issued would pass
// the unscoped (dangerous) version just as readily.
// ---------------------------------------------------------------------------

describe('DeviceEnrollmentService.createDevice -- compensating DELETE scoping on BOTH failure paths (task 6.1 TRAP; product rule: never delete a federated identity to achieve a local outcome)', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = buildMockClient();
    pool.connect.mockResolvedValue(mockClient);
    pool.query.mockImplementation(buildPoolQueryMock());
    Team.isAdmin.mockResolvedValue(true);
    Team.getAncestorChain.mockResolvedValue([ORGANISATION_ROW]);
    authentikService.createUser.mockResolvedValue({ pk: 987 });
    TeamMembershipService.addUserToTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
  });

  it('scopes the compensating DELETE by "authentik_user_id IS NULL" on a Phase-1 (Authentik) failure', async () => {
    authentikService.createUser.mockRejectedValue(new Error('Authentik unreachable'));

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false })
    ).rejects.toThrow('Authentik unreachable');

    const deleteCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM users WHERE id')
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain('authentik_user_id IS NULL');
  });

  it('scopes the compensating DELETE by "authentik_user_id IS NULL" on a Phase-2 (adopt/attach) failure too', async () => {
    TeamMembershipService.addUserToTeam.mockRejectedValue(new Error('team membership insert failed'));
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false })
    ).rejects.toThrow('team membership insert failed');

    const deleteCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM users WHERE id')
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain('authentik_user_id IS NULL');

    global.fetch = originalFetch;
  });
});

// ---------------------------------------------------------------------------
// 4: NULL, never '', for a device's email -- and createDevice touches no
// user_cache row at all.
// ---------------------------------------------------------------------------

describe("DeviceEnrollmentService.createDevice -- NULL, never '', for a Team_Owned_Device's email (Requirement 5.2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.connect.mockResolvedValue(buildMockClient());
    pool.query.mockImplementation(buildPoolQueryMock());
    Team.isAdmin.mockResolvedValue(true);
    Team.getAncestorChain.mockResolvedValue([ORGANISATION_ROW]);
    authentikService.createUser.mockResolvedValue({ pk: 987 });
    TeamMembershipService.addUserToTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
  });

  it("writes a literal NULL (never the string '') for users.email in the Claim_Row INSERT, and issues no user_cache statement at all on this path", async () => {
    await DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false });

    const claimSql = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    )[0];
    const normalizedSql = claimSql.replace(/\s+/g, ' ').trim();

    // `email`'s VALUES slot is a literal NULL, not a parameter and not the
    // empty string -- there is no code path by which this statement could
    // write ''.
    expect(normalizedSql).toContain('VALUES ($1, NULL, false, true, NULL, $2)');
    expect(claimSql).not.toContain("''");

    // `createDevice` itself never touches `user_cache`: that table is
    // populated later, out-of-band, by `authentikSync`'s own upsert (whose
    // is_team_device-sourcing and email-normalisation behaviour is covered
    // by takserver-enrollment task 3.4's tests in `authentikSync.test.js`),
    // reading its `is_team_device` flag off the `users` row this Claim_Row
    // becomes once adopted. There is no `user_cache` write on THIS code
    // path to assert a value for.
    const userCacheCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('user_cache')
    );
    expect(userCacheCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5: Device_Display_Name with no '@' and no throw for a NULL email.
//
// A search of the repository (client/src/**/*.jsx and server/**/*.js) for
// "Device_Display_Name" or an equivalent rendering concept -- a component,
// a formatter, or a route that projects a device's displayable name --
// found NONE. The two surfaces the design and tasks.md name for this --
// `DeviceEnrollmentService.listTeamDevices` (task 8.2) and
// `client/src/components/TeamDeviceList.jsx` (task 11.2), which is where
// Criterion 5.10 ("WHERE an email would be displayed for a Team_Owned_
// Device, display the Device_Display_Name or the Managed_Identifier
// instead") actually has a UI surface to apply to -- are BOTH still marked
// not-yet-implemented in tasks.md (waves 7 and 11, after this task's wave).
// There is therefore no isolated, testable Device_Display_Name render
// function to call here, and this file does not fabricate one.
//
// What DOES exist today, and what these two tests cover instead, is the
// one server-side construction that plays the same role ahead of that UI
// landing: `createDevice`'s own `displayName = label || username`, which is
// (a) the value sent to Authentik as the device's `name` field in place of
// a first/last name (Criterion 14.3), and (b) echoed back on the service's
// return value as `result.label`/`result.username`. Both assertions below
// hold for a NULL email precisely because a Team_Owned_Device's email is
// unconditionally NULL on this path (Requirement 5.1) -- there is no email
// value anywhere in this flow for a display name to leak or substitute.
// ---------------------------------------------------------------------------

describe('DeviceEnrollmentService.createDevice -- the Device_Display_Name-shaped value that exists today carries no "@" and never throws (Requirement 5.10)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.connect.mockResolvedValue(buildMockClient());
    pool.query.mockImplementation(buildPoolQueryMock());
    Team.isAdmin.mockResolvedValue(true);
    Team.getAncestorChain.mockResolvedValue([ORGANISATION_ROW]);
    authentikService.createUser.mockResolvedValue({ pk: 987 });
    TeamMembershipService.addUserToTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
  });

  it('sends Authentik a display name (the supplied label) with no "@", and returns no email/placeholder address at all', async () => {
    const result = await DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false });

    const createUserArgs = authentikService.createUser.mock.calls[0][0];
    expect(createUserArgs.name).toBe('Engine 4 Tablet');
    expect(createUserArgs.name).not.toContain('@');

    expect(result).not.toHaveProperty('email');
    expect(Object.keys(result)).not.toContain('email');
    expect(result.label).not.toContain('@');
    expect(result.username).not.toContain('@');
  });

  it('falls back to the Managed_Identifier as the display name with no throw and no "@" when no label is supplied', async () => {
    const result = await DeviceEnrollmentService.createDevice(5, null, { userId: 2, is_global_manager: true });

    const createUserArgs = authentikService.createUser.mock.calls[0][0];
    expect(createUserArgs.name).toBe(result.username);
    expect(createUserArgs.name).not.toContain('@');
    expect(result.label).toBeNull();
    expect(result).not.toHaveProperty('email');
  });
});

// ---------------------------------------------------------------------------
// 6: DEVICE_EMAIL_DOMAIN's full removal.
// ---------------------------------------------------------------------------

describe('DeviceEnrollmentService -- DEVICE_EMAIL_DOMAIN fully removed (Requirement 5.11, Correction 2)', () => {
  it('no longer exports DEVICE_EMAIL_DOMAIN from the module', () => {
    expect(DeviceEnrollmentService.DEVICE_EMAIL_DOMAIN).toBeUndefined();
    expect(require('./DeviceEnrollmentService').DEVICE_EMAIL_DOMAIN).toBeUndefined();
  });

  it('the literal string "devices.tak.nz.invalid" appears nowhere in any non-test .js file under server/', () => {
    const serverRoot = path.resolve(__dirname, '..', '..');
    const offenders = [];
    let scannedCount = 0;

    function isTestFileName(name) {
      return /\.(test|property\.test)\.js$/.test(name);
    }

    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const absolutePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(absolutePath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
        if (isTestFileName(entry.name)) continue;

        scannedCount += 1;
        const contents = fs.readFileSync(absolutePath, 'utf8');
        if (contents.includes('devices.tak.nz.invalid')) {
          offenders.push(path.relative(serverRoot, absolutePath));
        }
      }
    }

    walk(serverRoot);

    // Anti-vacuity: the walk must actually have visited a plausible number
    // of non-test server files (including this test's own tree, which is
    // itself excluded by name), or a broken walk would pass this vacuously.
    expect(scannedCount).toBeGreaterThanOrEqual(50);

    if (offenders.length > 0) {
      throw new Error(
        [
          'The literal string "devices.tak.nz.invalid" was found in non-test',
          'server code, which Requirement 5.11 (Correction 2) forbids -- a',
          'Team_Owned_Device gets NO email address at all, and no synthetic',
          '.invalid address may be minted or referenced anywhere:',
          ...offenders.map((offender) => `  - ${offender}`)
        ].join('\n')
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7 & 8: exhaustion after five qualifying rejections vs. first-occurrence
// propagation of a non-qualifying rejection.
// ---------------------------------------------------------------------------

describe('DeviceEnrollmentService.createDevice -- Claim_Row mint exhaustion and exact-constraint propagation (Requirements 1.8, 1.9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Team.isAdmin.mockResolvedValue(true);
    Team.getAncestorChain.mockResolvedValue([ORGANISATION_ROW]);
    pool.connect.mockResolvedValue(buildMockClient());
    authentikService.createUser.mockResolvedValue({ pk: 987 });
    TeamMembershipService.addUserToTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
  });

  it('surfaces five consecutive 23505/users_username_key rejections as ManagedIdentifierExhaustionError, with NO Authentik call ever made', async () => {
    const collisionError = Object.assign(new Error('duplicate key value violates unique constraint "users_username_key"'), {
      code: '23505',
      constraint: 'users_username_key'
    });
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.reject(collisionError);
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false })
    ).rejects.toThrow(ManagedIdentifierService.ManagedIdentifierExhaustionError);

    const claimAttempts = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(claimAttempts).toHaveLength(ManagedIdentifierService.MAX_IDENTIFIER_ATTEMPTS);
    expect(claimAttempts).toHaveLength(5);
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(TeamMembershipService.addUserToTeam).not.toHaveBeenCalled();
  });

  it('propagates a 23505 on users_email_key on its FIRST occurrence, with exactly one claim attempt and no Authentik call', async () => {
    const emailCollisionError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: '23505',
      constraint: 'users_email_key'
    });
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.reject(emailCollisionError);
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      DeviceEnrollmentService.createDevice(5, 'Engine 4 Tablet', { userId: 1, is_global_manager: false })
    ).rejects.toBe(emailCollisionError);

    const claimAttempts = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(claimAttempts).toHaveLength(1);
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
