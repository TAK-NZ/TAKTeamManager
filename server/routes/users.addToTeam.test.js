/**
 * Regression tests for `POST /api/users/add-to-team`'s callsign_suffix
 * default-computation bugfix (callsign-handling).
 *
 * Before the fix, this route called
 * `UserProvisioningService.resolveCallsignSuffixForNewUser` -- a method
 * removed elsewhere in favor of `resolveNewUserIdentity` -- so every
 * invocation for a user with no existing `callsign_suffix` threw a
 * `TypeError`, caught by this route's own try/catch and only logged,
 * silently leaving `callsign_suffix` blank with no error surfaced to the
 * caller. The fix routes through the REAL
 * `UserProvisioningService.resolveNewUserIdentity` -- the sole allowed
 * caller of `CallsignService.computeDefaultCallsignSuffix`
 * (`newUserIdentityChokePoint.test.js`'s Assertion 2 allow-list) --
 * rather than calling `CallsignService` a second time from this route,
 * which would itself be a structural regression that guard exists to
 * catch. `resolveNewUserIdentity`'s own dependencies
 * (`Team.getAncestorChain`/`getFullMemberList`) are mocked below; the
 * resolver itself runs for real.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
  // Consulted by checkCallsignSuffixUniqueness (via CallsignSuffixUniquenessService,
  // the REAL, unmocked module) -- an empty roster means no collision.
  getFullMemberList: jest.fn().mockResolvedValue([])
}));

jest.mock('../services/TeamMembershipService', () => ({
  addUserToTeam: jest.fn()
}));

jest.mock('../services/userAttributes', () => ({
  generateCallsign: jest.fn(),
  updateUserAttributes: jest.fn()
}));

// `UserProvisioningService` itself is NOT mocked (unlike `Team`/
// `TeamMembershipService`/`userAttributes` above): the fix routes through
// its REAL `resolveNewUserIdentity` -- the ONE allowed caller of
// `CallsignService.computeDefaultCallsignSuffix`
// (`newUserIdentityChokePoint.test.js`'s Assertion 2 allow-list) -- so
// these tests exercise the real default-computation logic end to end,
// with only `Team.getAncestorChain`/`getFullMemberList` (its own
// dependencies) mocked above.

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../middleware/requestContext', () => ({
  getLogger: () => mockLoggerInstance
}));

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const Team = require('../models/Team');
const TeamMembershipService = require('../services/TeamMembershipService');
const UserAttributesService = require('../services/userAttributes');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

/** A root (Organisation, depth 0) Ancestor_Chain row. */
function organisationRow({ id = 3, callsignPrefix = 'FENZ', callsignNameFormat = 'first_initial_dot_last' } = {}) {
  return {
    id,
    parent_team_id: null,
    name: 'FENZ',
    callsign_prefix: callsignPrefix,
    color: 'Red',
    callsign_name_format: callsignNameFormat,
    callsign_level_selection: [1],
    depth: 0
  };
}

describe('POST /api/users/add-to-team callsign_suffix default computation (bugfix: callsign-handling)', () => {
  let app;
  const USER_CACHE_ROW = {
    authentik_id: '14',
    username: 'chris@chriselsen.net',
    email: 'chris@chriselsen.net',
    first_name: 'Chris',
    last_name: 'Elsen'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();

    TeamMembershipService.addUserToTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
    UserAttributesService.generateCallsign.mockResolvedValue(null);
    UserAttributesService.updateUserAttributes.mockResolvedValue(true);
    Team.getAncestorChain.mockResolvedValue([organisationRow()]);
  });

  /**
   * Wires up the sequence of `pool.query` calls this route makes, in
   * order, for the happy path: user_cache lookup, users upsert, local id
   * lookup, existing-membership check (none), callsign_suffix/name check
   * (BLANK, so the default-computation branch runs), the UPDATE
   * users/UPDATE user_cache writes, and the final audit log insert.
   */
  function mockHappyPathQueries({ existingCallsignSuffix = null } = {}) {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT authentik_id, username, email, first_name, last_name FROM user_cache')) {
        return Promise.resolve({ rows: [USER_CACHE_ROW] });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 2 }] });
      }
      if (typeof sql === 'string' && sql.includes("FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL")) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT callsign_suffix, first_name, last_name FROM users WHERE id')) {
        return Promise.resolve({ rows: [{ callsign_suffix: existingCallsignSuffix, first_name: 'Chris', last_name: 'Elsen' }] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE users SET callsign_suffix')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE user_cache SET callsign_suffix')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE user_cache SET tak_callsign')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO audit_logs')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('computes and persists a default callsign_suffix without throwing, for a user with none (the exact bug reproduction)', async () => {
    mockHappyPathQueries({ existingCallsignSuffix: null });

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4 });

    expect(res.status).toBe(200);
    // The dead resolveCallsignSuffixForNewUser call used to throw here,
    // caught only by the route's own try/catch and logged via
    // getLogger().error -- asserting it was NOT called is the direct
    // regression check.
    expect(mockLoggerInstance.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'Failed to compute default callsign_suffix for existing user'
    );

    // Team.getAncestorChain(teamId) resolved the destination team's
    // Organisation for its callsign_name_format, per the fix.
    expect(Team.getAncestorChain).toHaveBeenCalledWith(4);

    // first_initial_dot_last("Chris", "Elsen") -> "C.Elsen".
    const usersUpdateCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE users SET callsign_suffix')
    );
    expect(usersUpdateCall).toBeDefined();
    expect(usersUpdateCall[1]).toEqual(['C.Elsen', 2]);

    const cacheUpdateCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE user_cache SET callsign_suffix')
    );
    expect(cacheUpdateCall).toBeDefined();
    expect(cacheUpdateCall[1]).toEqual(['C.Elsen', '14']);
  });

  it('is a no-op (does not overwrite) when the user already has a callsign_suffix', async () => {
    mockHappyPathQueries({ existingCallsignSuffix: 'Existing.Suffix' });

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4 });

    expect(res.status).toBe(200);
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
    const usersUpdateCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE users SET callsign_suffix')
    );
    expect(usersUpdateCall).toBeUndefined();
  });

  it('leaves callsign_suffix blank, without failing the request, when the Organisation format is user_defined (computes null)', async () => {
    mockHappyPathQueries({ existingCallsignSuffix: null });
    Team.getAncestorChain.mockResolvedValue([organisationRow({ callsignNameFormat: 'user_defined' })]);

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4 });

    expect(res.status).toBe(200);
    const usersUpdateCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE users SET callsign_suffix')
    );
    expect(usersUpdateCall).toBeUndefined();
  });

  it('logs a warning and leaves callsign_suffix blank (non-fatal) when the computed default collides with an existing member', async () => {
    mockHappyPathQueries({ existingCallsignSuffix: null });
    Team.getFullMemberList.mockResolvedValue([
      { id: 99, callsign_suffix: 'C.Elsen' } // same value computeDefaultCallsignSuffix will derive
    ]);

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4 });

    expect(res.status).toBe(200);
    expect(mockLoggerInstance.warn).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 4, localUserId: 2, conflictingValue: 'C.Elsen' }),
      'Computed default callsign_suffix conflicts with an existing member; leaving callsign_suffix blank for existing user add'
    );
    const usersUpdateCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE users SET callsign_suffix')
    );
    expect(usersUpdateCall).toBeUndefined();
  });
});

/**
 * Feature: Add Existing User onboarding review (member-only "Add Existing
 * User" tab). This is the ONLY step that turns a user who exists in
 * Authentik but has never been touched by TAK Team Manager into a
 * Team-Manager-managed user, so this route now accepts optional
 * `firstName`/`lastName`/`callsignSuffix` corrections, validates and
 * PERSISTS them (never a one-off override for this add alone), before
 * proceeding with the pre-existing membership-add logic.
 */
describe('POST /api/users/add-to-team optional firstName/lastName/callsignSuffix corrections (Add Existing User onboarding)', () => {
  let app;
  const USER_CACHE_ROW = {
    authentik_id: '14',
    username: 'chris@chriselsen.net',
    email: 'chris@chriselsen.net',
    first_name: 'Chris',
    last_name: 'Elsen'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();

    TeamMembershipService.addUserToTeam.mockResolvedValue({ success: true, groupsQueued: 0 });
    UserAttributesService.generateCallsign.mockResolvedValue(null);
    UserAttributesService.updateUserAttributes.mockResolvedValue(true);
    Team.getAncestorChain.mockResolvedValue([organisationRow()]);
    Team.getFullMemberList.mockResolvedValue([]);
  });

  /** Same wiring as mockHappyPathQueries above, factored out so this
   * describe block's tests can each layer their own assertions on top. */
  function mockQueries({ existingCallsignSuffix = null } = {}) {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT authentik_id, username, email, first_name, last_name FROM user_cache')) {
        return Promise.resolve({ rows: [USER_CACHE_ROW] });
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO users')) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT id FROM users WHERE authentik_user_id')) {
        return Promise.resolve({ rows: [{ id: 2 }] });
      }
      if (typeof sql === 'string' && sql.includes("FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL")) {
        return Promise.resolve({ rows: [] });
      }
      if (typeof sql === 'string' && sql.includes('SELECT callsign_suffix, first_name, last_name FROM users WHERE id')) {
        return Promise.resolve({ rows: [{ callsign_suffix: existingCallsignSuffix, first_name: 'Chris', last_name: 'Elsen' }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('rejects a callsignSuffix containing a disallowed character with 400, before any write', async () => {
    mockQueries();

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4, callsignSuffix: 'J Doe' });

    expect(res.status).toBe(400);
    const usersInsertCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(usersInsertCall).toBeUndefined();
  });

  it('rejects an empty-string firstName/lastName with 400 (min length 1), before any write', async () => {
    mockQueries();

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4, firstName: '' });

    expect(res.status).toBe(400);
    const usersInsertCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(usersInsertCall).toBeUndefined();
  });

  it('rejects a conflicting callsignSuffix with 400 naming the value, and adds no membership', async () => {
    mockQueries();
    Team.getFullMemberList.mockResolvedValue([{ id: 99, callsign_suffix: 'K.Kokako' }]);

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4, callsignSuffix: 'K.Kokako' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/K\.Kokako/);
    expect(TeamMembershipService.addUserToTeam).not.toHaveBeenCalled();
  });

  it('persists a corrected firstName/lastName to users (COALESCE upsert) and mirrors to user_cache', async () => {
    mockQueries({ existingCallsignSuffix: 'Existing.Suffix' });

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4, firstName: 'Kingston', lastName: 'Kokako' });

    expect(res.status).toBe(200);

    const upsertCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    expect(upsertCall).toBeDefined();
    // effectiveFirstName/effectiveLastName (used to seed a brand-new row)
    // are the corrected values; firstName/lastName (used by COALESCE for
    // an existing row) are the corrected values too.
    expect(upsertCall[1]).toEqual(['14', 'chris@chriselsen.net', 'chris@chriselsen.net', 'Kingston', 'Kokako', 'Kingston', 'Kokako']);

    const cacheFirstNameCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql === 'UPDATE user_cache SET first_name = $1 WHERE authentik_id = $2'
    );
    expect(cacheFirstNameCall[1]).toEqual(['Kingston', '14']);
    const cacheLastNameCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql === 'UPDATE user_cache SET last_name = $1 WHERE authentik_id = $2'
    );
    expect(cacheLastNameCall[1]).toEqual(['Kokako', '14']);

    // Pushed to Authentik alongside the (here null) callsign recompute.
    expect(UserAttributesService.updateUserAttributes).toHaveBeenCalledWith('14', {
      firstName: 'Kingston',
      lastName: 'Kokako'
    });
  });

  it('persists an explicit callsignSuffix correction, overwriting an existing stored value, and never runs the auto-default branch', async () => {
    mockQueries({ existingCallsignSuffix: 'Stale.Value' });

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4, callsignSuffix: 'K.Kokako' });

    expect(res.status).toBe(200);

    const usersSuffixUpdate = pool.query.mock.calls.find(
      ([sql, params]) => sql === 'UPDATE users SET callsign_suffix = $1 WHERE id = $2' && params[0] === 'K.Kokako'
    );
    expect(usersSuffixUpdate).toBeDefined();
    const cacheSuffixUpdate = pool.query.mock.calls.find(
      ([sql, params]) => sql === 'UPDATE user_cache SET callsign_suffix = $1 WHERE authentik_id = $2' && params[0] === 'K.Kokako'
    );
    expect(cacheSuffixUpdate).toBeDefined();

    // The auto-default branch (resolveNewUserIdentity) never runs when an
    // explicit value was supplied -- Team.getAncestorChain would have
    // been consulted a SECOND time (once for generateCallsign, mocked to
    // null here) if it had, but resolveNewUserIdentity's own call is what
    // this asserts is absent by checking the suffix value written is
    // exactly the submitted one, never a computed default.
    expect(usersSuffixUpdate[1][0]).toBe('K.Kokako');
  });

  it('checks callsign_suffix uniqueness BEFORE TeamMembershipService.addUserToTeam runs, excluding the user\'s own row', async () => {
    mockQueries({ existingCallsignSuffix: null });
    let uniquenessCheckedBeforeAdd = false;
    TeamMembershipService.addUserToTeam.mockImplementation(() => {
      // Team.getFullMemberList is called by checkCallsignSuffixUniqueness;
      // if it was already called before this point, the check ran first.
      uniquenessCheckedBeforeAdd = Team.getFullMemberList.mock.calls.length > 0;
      return Promise.resolve({ success: true, groupsQueued: 0 });
    });

    await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4, callsignSuffix: 'K.Kokako' });

    expect(uniquenessCheckedBeforeAdd).toBe(true);
  });

  it('applies no correction and preserves existing behavior exactly when none of the three fields are supplied', async () => {
    mockQueries({ existingCallsignSuffix: 'Existing.Suffix' });

    const res = await request(app)
      .post('/api/users/add-to-team')
      .send({ userId: '14', teamId: 4 });

    expect(res.status).toBe(200);
    const upsertCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO users')
    );
    // effectiveFirstName/effectiveLastName fall back to the user_cache
    // row's own values; the two COALESCE params are undefined (dropped).
    expect(upsertCall[1]).toEqual(['14', 'chris@chriselsen.net', 'chris@chriselsen.net', 'Chris', 'Elsen', undefined, undefined]);

    const cacheFirstNameCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql === 'UPDATE user_cache SET first_name = $1 WHERE authentik_id = $2'
    );
    expect(cacheFirstNameCall).toBeUndefined();
    const suffixUpdateCall = pool.query.mock.calls.find(
      ([sql]) => sql === 'UPDATE users SET callsign_suffix = $1 WHERE id = $2'
    );
    expect(suffixUpdateCall).toBeUndefined();
  });
});
