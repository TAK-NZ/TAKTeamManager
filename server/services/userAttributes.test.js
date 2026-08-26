/**
 * Unit and property-based tests for `UserAttributesService` (Requirement
 * 12.1 / tasks 58.2, 58.3, and rewritten by task 11.1 for Requirements
 * 3.4, 5.4, 5.5, 8.4, 11.2).
 *
 * `UserAttributesService.splitFullName` is a pure function (unused by the
 * rewritten `computeCallsignAttributes`, but kept as a small standalone
 * utility and still tested here).
 *
 * `computeCallsignAttributes(userId, teamId)` now:
 *  - looks up the user's STORED `callsign_suffix` via `pool.query`
 *    (mocked directly, per this codebase's established convention -- see
 *    `./RequestApprovalService.test.js`, `./MouService.test.js`);
 *  - resolves the Ancestor_Chain via `Team.getAncestorChain(teamId)`
 *    (`../models/Team` is mocked directly, since `getAncestorChain`'s own
 *    SQL shape is already covered by `Team.test.js`);
 *  - filters ancestor `callsign_prefix` values to the Organisation's
 *    `callsign_level_selection` (defaulting to `[1..MAX_TEAM_DEPTH]` when
 *    null);
 *  - assembles the callsign via the REAL (unmocked) `CallsignService`,
 *    since `assembleCallsign` is a pure function with its own dedicated
 *    test coverage and re-mocking it here would just restate its inputs.
 *
 * `generateCallsign(userId, teamId)` is now a thin wrapper delegating
 * directly to `computeCallsignAttributes`.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Team = require('../models/Team');
const UserAttributesService = require('./userAttributes');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const { MAX_TEAM_DEPTH } = require('../config/constants');

/**
 * Builds a root (Organisation, depth 0) Ancestor_Chain row.
 */
function organisationRow({
  id = 1,
  name = 'FENZ',
  callsignPrefix = 'FENZ',
  color = '#3B82F6',
  callsignLevelSelection = null
} = {}) {
  return {
    id,
    parent_team_id: null,
    name,
    callsign_prefix: callsignPrefix,
    color,
    callsign_name_format: 'full_name',
    visibility: 'public',
    callsign_level_selection: callsignLevelSelection,
    depth: 0
  };
}

/**
 * Builds a non-root (depth >= 1) Ancestor_Chain row.
 */
function teamRow({ id, parentTeamId, name, callsignPrefix, depth }) {
  return {
    id,
    parent_team_id: parentTeamId,
    name,
    callsign_prefix: callsignPrefix,
    color: null,
    callsign_name_format: null,
    visibility: 'public',
    callsign_level_selection: null,
    depth
  };
}

function mockUserLookup(callsignSuffix) {
  pool.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('SELECT callsign_suffix FROM users')) {
      return callsignSuffix === undefined
        ? Promise.resolve({ rows: [] })
        : Promise.resolve({ rows: [{ callsign_suffix: callsignSuffix }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('UserAttributesService.splitFullName', () => {
  it('splits a two-part "First Last" name into firstName/lastName', () => {
    expect(UserAttributesService.splitFullName('John Smith')).toEqual({
      firstName: 'John',
      lastName: 'Smith'
    });
  });

  it('splits a multi-word name, joining everything after the first word into lastName', () => {
    expect(UserAttributesService.splitFullName('Mary Jane Watson')).toEqual({
      firstName: 'Mary',
      lastName: 'Jane Watson'
    });
  });

  it('returns an empty lastName for a single-word name (fallback branch)', () => {
    expect(UserAttributesService.splitFullName('Madonna')).toEqual({
      firstName: 'Madonna',
      lastName: ''
    });
  });

  it('trims surrounding whitespace before splitting', () => {
    expect(UserAttributesService.splitFullName('  John Smith  ')).toEqual({
      firstName: 'John',
      lastName: 'Smith'
    });
  });
});

describe('UserAttributesService.computeCallsignAttributes - Organisation-only user (single-row Ancestor_Chain)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('assembles Org + Name with a default (null) Callsign_Level_Selection', async () => {
    mockUserLookup('J.Doe');
    Team.getAncestorChain.mockResolvedValue([organisationRow({ callsignLevelSelection: null })]);

    const result = await UserAttributesService.computeCallsignAttributes(42, 1);

    expect(result).toEqual({
      callsign: 'FENZ-J.Doe',
      color: '#3B82F6',
      role: 'Team Member'
    });
    expect(Team.getAncestorChain).toHaveBeenCalledWith(1);
  });

  it('omits the Organisation segment when the Organisation has no callsign_prefix', async () => {
    mockUserLookup('J.Doe');
    Team.getAncestorChain.mockResolvedValue([organisationRow({ callsignPrefix: null })]);

    const result = await UserAttributesService.computeCallsignAttributes(42, 1);

    expect(result.callsign).toBe('J.Doe');
  });

  it('omits the Name segment when the stored callsign_suffix is null', async () => {
    mockUserLookup(null);
    Team.getAncestorChain.mockResolvedValue([organisationRow()]);

    const result = await UserAttributesService.computeCallsignAttributes(42, 1);

    expect(result.callsign).toBe('FENZ');
  });
});

describe('UserAttributesService.computeCallsignAttributes - multi-level Ancestor_Chain with Callsign_Level_Selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function fenzChain(callsignLevelSelection) {
    return [
      organisationRow({ callsignLevelSelection }),
      teamRow({ id: 2, parentTeamId: 1, name: 'Te Ihu', callsignPrefix: 'TEIHU', depth: 1 }),
      teamRow({ id: 3, parentTeamId: 2, name: 'Canterbury', callsignPrefix: 'CHC', depth: 2 }),
      teamRow({ id: 4, parentTeamId: 3, name: 'Station 40', callsignPrefix: 'S40', depth: 3 })
    ];
  }

  it('includes only the selected-depth prefixes, in ascending depth order', async () => {
    mockUserLookup('J.Doe');
    Team.getAncestorChain.mockResolvedValue(fenzChain([1, 3]));

    const result = await UserAttributesService.computeCallsignAttributes(42, 4);

    // depth 1 (TEIHU) and depth 3 (S40) selected; depth 2 (CHC) skipped.
    expect(result.callsign).toBe('FENZ-TEIHUS40-J.Doe');
  });

  it('includes every level when Callsign_Level_Selection is null (defaults to 1..MAX_TEAM_DEPTH)', async () => {
    mockUserLookup('J.Doe');
    Team.getAncestorChain.mockResolvedValue(fenzChain(null));

    const result = await UserAttributesService.computeCallsignAttributes(42, 4);

    expect(result.callsign).toBe('FENZ-TEIHUCHCS40-J.Doe');
  });

  it('silently skips a selected depth with no corresponding Ancestor_Chain row (shallower branch)', async () => {
    mockUserLookup('J.Doe');
    // Only 2 levels deep (Org + one Team at depth 1); depth 3/4 are
    // selected but absent from this shorter chain.
    Team.getAncestorChain.mockResolvedValue([
      organisationRow({ callsignLevelSelection: [1, 3, 4] }),
      teamRow({ id: 2, parentTeamId: 1, name: 'Te Ihu', callsignPrefix: 'TEIHU', depth: 1 })
    ]);

    const result = await UserAttributesService.computeCallsignAttributes(42, 2);

    expect(result.callsign).toBe('FENZ-TEIHU-J.Doe');
  });

  it('skips a selected-and-present level whose callsign_prefix is empty', async () => {
    mockUserLookup('J.Doe');
    Team.getAncestorChain.mockResolvedValue([
      organisationRow({ callsignLevelSelection: [1, 2] }),
      teamRow({ id: 2, parentTeamId: 1, name: 'Te Ihu', callsignPrefix: '', depth: 1 }),
      teamRow({ id: 3, parentTeamId: 2, name: 'Canterbury', callsignPrefix: 'CHC', depth: 2 })
    ]);

    const result = await UserAttributesService.computeCallsignAttributes(42, 3);

    expect(result.callsign).toBe('FENZ-CHC-J.Doe');
  });

  it('reads color from the Organisation (ancestorChain[0]), not any descendant Team', async () => {
    mockUserLookup('J.Doe');
    Team.getAncestorChain.mockResolvedValue(fenzChain([1]));

    const result = await UserAttributesService.computeCallsignAttributes(42, 4);

    expect(result.color).toBe('#3B82F6');
    expect(result.role).toBe('Team Member');
  });
});

describe('UserAttributesService.computeCallsignAttributes - not-found cases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when the user lookup finds no rows', async () => {
    mockUserLookup(undefined);
    Team.getAncestorChain.mockResolvedValue([organisationRow()]);

    const result = await UserAttributesService.computeCallsignAttributes(999, 1);

    expect(result).toBeNull();
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
  });

  it('returns null when the Ancestor_Chain is empty (team not found)', async () => {
    mockUserLookup('J.Doe');
    Team.getAncestorChain.mockResolvedValue([]);

    const result = await UserAttributesService.computeCallsignAttributes(42, 999);

    expect(result).toBeNull();
  });

  it('returns null and logs when the user lookup query throws', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT callsign_suffix FROM users')) {
        return Promise.reject(new Error('db connection lost'));
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await UserAttributesService.computeCallsignAttributes(42, 1);

    expect(result).toBeNull();
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });

  it('returns null and logs when Team.getAncestorChain throws', async () => {
    mockUserLookup('J.Doe');
    Team.getAncestorChain.mockRejectedValue(new Error('db unavailable'));

    const result = await UserAttributesService.computeCallsignAttributes(42, 1);

    expect(result).toBeNull();
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });
});

describe('UserAttributesService.generateCallsign', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates directly to computeCallsignAttributes with the same (userId, teamId) arguments', async () => {
    mockUserLookup('J.Doe');
    Team.getAncestorChain.mockResolvedValue([organisationRow()]);

    const result = await UserAttributesService.generateCallsign(42, 1);

    expect(result).toEqual({
      callsign: 'FENZ-J.Doe',
      color: '#3B82F6',
      role: 'Team Member'
    });
  });

  it('returns null when the user is not found (delegated behavior)', async () => {
    mockUserLookup(undefined);

    const result = await UserAttributesService.generateCallsign(999, 1);

    expect(result).toBeNull();
  });
});

describe('UserAttributesService.updateUserAttributes - fetch-merge-PATCH (task 11.4, Flagged Design Decision 2)', () => {
  const AUTHENTIK_USER_ID = 'authentik-user-1';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AUTHENTIK_URL = 'https://authentik.example.com';
    process.env.AUTHENTIK_ADMIN_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete global.fetch;
  });

  function mockGetThenPatch(currentAttributes, patchOk = true) {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ attributes: currentAttributes }) })
      .mockResolvedValueOnce({ ok: patchOk, statusText: patchOk ? 'OK' : 'Bad Request' });
  }

  it('a full {callsign, color, role} call PATCHes all three mapped keys, merged with any existing fetched attributes', async () => {
    mockGetThenPatch({ someOtherKey: 'unrelated-value' });

    const result = await UserAttributesService.updateUserAttributes(AUTHENTIK_USER_ID, {
      callsign: 'FENZ-CHC-J.Doe',
      color: '#FF0000',
      role: 'Team Lead'
    });

    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const [, patchCall] = global.fetch.mock.calls;
    const [patchUrl, patchOptions] = patchCall;
    expect(patchUrl).toBe(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${AUTHENTIK_USER_ID}/`);
    expect(patchOptions.method).toBe('PATCH');
    expect(JSON.parse(patchOptions.body)).toEqual({
      attributes: {
        someOtherKey: 'unrelated-value',
        takCallsign: 'FENZ-CHC-J.Doe',
        takColor: '#FF0000',
        takRole: 'Team Lead'
      }
    });
  });

  it('a partial {role} call fetches current attributes first, then PATCHes a merged object preserving existing takCallsign/takColor', async () => {
    mockGetThenPatch({ takCallsign: 'FENZ-CHC-J.Doe', takColor: '#FF0000', takRole: 'Team Member' });

    const result = await UserAttributesService.updateUserAttributes(AUTHENTIK_USER_ID, {
      role: 'Team Lead'
    });

    expect(result).toBe(true);

    const [getCall, patchCall] = global.fetch.mock.calls;
    expect(getCall[0]).toBe(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${AUTHENTIK_USER_ID}/`);
    expect(getCall[1]?.method).toBeUndefined(); // GET (no method override)

    const [, patchOptions] = patchCall;
    expect(JSON.parse(patchOptions.body)).toEqual({
      attributes: {
        takCallsign: 'FENZ-CHC-J.Doe', // unchanged, from the fetch
        takColor: '#FF0000', // unchanged, from the fetch
        takRole: 'Team Lead' // the only supplied key
      }
    });
  });

  it('a partial {callsign, color} call (no role) preserves an existing takRole in the merged PATCH body -- the bug this task fixes', async () => {
    mockGetThenPatch({ takCallsign: 'OLD-CALLSIGN', takColor: '#000000', takRole: 'Team Lead' });

    const result = await UserAttributesService.updateUserAttributes(AUTHENTIK_USER_ID, {
      callsign: 'NEW-CALLSIGN',
      color: '#FFFFFF'
    });

    expect(result).toBe(true);

    const [, patchCall] = global.fetch.mock.calls;
    const [, patchOptions] = patchCall;
    const patchedAttributes = JSON.parse(patchOptions.body).attributes;

    // The old, blind-PATCH behavior would have sent takRole: undefined
    // (dropping the field, and Authentik's wholesale-replace PATCH would
    // then have cleared it). The new fetch-merge behavior must retain it.
    expect(patchedAttributes.takRole).toBe('Team Lead');
    expect(patchedAttributes.takCallsign).toBe('NEW-CALLSIGN');
    expect(patchedAttributes.takColor).toBe('#FFFFFF');
  });

  it('a present-but-empty-string value is treated as supplied (not absent) and overwrites the existing attribute', async () => {
    mockGetThenPatch({ takCallsign: 'OLD-CALLSIGN', takColor: '#000000', takRole: 'Team Lead' });

    await UserAttributesService.updateUserAttributes(AUTHENTIK_USER_ID, {
      callsign: ''
    });

    const [, patchCall] = global.fetch.mock.calls;
    const patchedAttributes = JSON.parse(patchCall[1].body).attributes;

    expect(patchedAttributes.takCallsign).toBe('');
    expect(patchedAttributes.takColor).toBe('#000000');
    expect(patchedAttributes.takRole).toBe('Team Lead');
  });

  it('returns false and does not attempt a PATCH when the fetch (GET) step fails', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, statusText: 'Not Found' });

    const result = await UserAttributesService.updateUserAttributes(AUTHENTIK_USER_ID, {
      role: 'Team Lead'
    });

    expect(result).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1); // no PATCH attempted
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });

  it('returns false when the PATCH step fails (existing behavior)', async () => {
    mockGetThenPatch({ takCallsign: 'OLD-CALLSIGN' }, false);

    const result = await UserAttributesService.updateUserAttributes(AUTHENTIK_USER_ID, {
      callsign: 'NEW-CALLSIGN'
    });

    expect(result).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });

  it('handles a user with no existing attributes object at all (starts from {})', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // no `attributes` key
      .mockResolvedValueOnce({ ok: true });

    const result = await UserAttributesService.updateUserAttributes(AUTHENTIK_USER_ID, {
      callsign: 'FENZ-J.Doe',
      color: '#3B82F6',
      role: 'Team Member'
    });

    expect(result).toBe(true);
    const [, patchCall] = global.fetch.mock.calls;
    expect(JSON.parse(patchCall[1].body)).toEqual({
      attributes: {
        takCallsign: 'FENZ-J.Doe',
        takColor: '#3B82F6',
        takRole: 'Team Member'
      }
    });
  });
});

/**
 * Bugfix (Dashboard/Enrollment callsign-and-color divergence):
 * `clearTeamAttributes` is the post-commit cleanup `Team.delete` calls for
 * a user left with no `team_memberships` row at all. It must clear BOTH
 * the Authentik-side attributes (via `updateUserAttributes`, leaving
 * `takRole` untouched since role is not team-derived) AND the
 * `user_cache` mirror, using the explicit string `'None'` rather than an
 * empty string or a real assignable color name -- see the method's own
 * doc comment for why `'None'` specifically.
 */
describe('UserAttributesService.clearTeamAttributes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AUTHENTIK_URL = 'https://authentik.example.com';
    process.env.AUTHENTIK_ADMIN_TOKEN = 'test-token';
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('sets callsign and color to the literal string "None" in both Authentik and user_cache, leaving takRole untouched', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 'authentik-user-7' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ attributes: { takCallsign: 'OLD-CALLSIGN', takColor: 'Red', takRole: 'Team Lead' } })
      })
      .mockResolvedValueOnce({ ok: true });

    const result = await UserAttributesService.clearTeamAttributes(42);

    expect(result).toBe(true);

    // Authentik: takRole preserved, callsign/color overwritten to 'None'.
    const [, patchCall] = global.fetch.mock.calls;
    const patchedAttributes = JSON.parse(patchCall[1].body).attributes;
    expect(patchedAttributes).toEqual({
      takCallsign: 'None',
      takColor: 'None',
      takRole: 'Team Lead'
    });

    // user_cache mirror, keyed by authentik_id (not the local users.id).
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE user_cache SET tak_callsign = $1, tak_color = $2 WHERE authentik_id = $3',
      ['None', 'None', 'authentik-user-7']
    );
  });

  it('returns false and logs, without touching Authentik or user_cache, when the user is not found', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    global.fetch = jest.fn();

    const result = await UserAttributesService.clearTeamAttributes(999);

    expect(result).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockLoggerInstance.warn).toHaveBeenCalled();
  });

  it('returns false and logs when the underlying Authentik call fails, without throwing', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 'authentik-user-7' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, statusText: 'Not Found' });

    const result = await UserAttributesService.clearTeamAttributes(42);

    expect(result).toBe(false);
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });
});

/**
 * Requirement 5.12 (task 11.6): `updateTeamUserAttributes` (triggered by a
 * `PUT /api/teams/:teamId` `callsignLevelSelection` change, wired in
 * `server/routes/teams.js`) must regenerate callsign/color/role for every
 * affected user WITHOUT ever reading or writing `callsign_suffix` other
 * than the single existing read inside `computeCallsignAttributes`
 * ("SELECT callsign_suffix FROM users ..."). This confirms that
 * `updateTeamUserAttributes`'s own `user_cache` write only ever sets
 * `tak_callsign`/`tak_color`/`tak_role`, and that no `pool.query` call in
 * the whole flow issues an UPDATE/SET referencing `callsign_suffix`.
 */
describe('UserAttributesService.updateTeamUserAttributes - never writes callsign_suffix (Requirement 5.12)', () => {
  const TEAM_ID = 4;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AUTHENTIK_URL = 'https://authentik.example.com';
    process.env.AUTHENTIK_ADMIN_TOKEN = 'test-token';

    global.fetch = jest.fn()
      .mockResolvedValue({ ok: true, json: async () => ({ attributes: {} }) });

    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM users u')) {
        // the team_tree + users/team_memberships roster query
        return Promise.resolve({
          rows: [{ id: 42, authentik_user_id: 'authentik-user-1', team_id: TEAM_ID }]
        });
      }
      if (typeof sql === 'string' && sql.includes('SELECT callsign_suffix FROM users')) {
        return Promise.resolve({ rows: [{ callsign_suffix: 'J.Doe' }] });
      }
      if (typeof sql === 'string' && sql.includes('UPDATE user_cache')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    Team.getAncestorChain.mockResolvedValue([organisationRow()]);
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('regenerates callsign/color/role for every affected user and returns true', async () => {
    const result = await UserAttributesService.updateTeamUserAttributes(TEAM_ID);

    expect(result).toBe(true);
    // The stored callsign_suffix ("J.Doe") is READ (via computeCallsignAttributes)
    // and used as the Name segment, but never rewritten.
    expect(global.fetch).toHaveBeenCalled(); // the Authentik PATCH via updateUserAttributes
  });

  it('the user_cache UPDATE call never references callsign_suffix', async () => {
    await UserAttributesService.updateTeamUserAttributes(TEAM_ID);

    const userCacheCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE user_cache')
    );

    expect(userCacheCalls.length).toBeGreaterThan(0);
    for (const [sql] of userCacheCalls) {
      expect(sql).not.toMatch(/callsign_suffix/);
      expect(sql).toMatch(/tak_callsign/);
      expect(sql).toMatch(/tak_color/);
      expect(sql).toMatch(/tak_role/);
    }
  });

  it('no pool.query call anywhere in the flow issues an UPDATE/SET referencing callsign_suffix', async () => {
    await UserAttributesService.updateTeamUserAttributes(TEAM_ID);

    for (const [sql] of pool.query.mock.calls) {
      if (typeof sql !== 'string') continue;
      const isWrite = /UPDATE|INSERT|SET/i.test(sql);
      if (isWrite) {
        expect(sql).not.toMatch(/callsign_suffix/);
      }
    }

    // Confirm the only callsign_suffix reference anywhere is the existing
    // read-only SELECT added by task 11.1.
    const callsignSuffixCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('callsign_suffix')
    );
    expect(callsignSuffixCalls.length).toBeGreaterThan(0);
    for (const [sql] of callsignSuffixCalls) {
      expect(sql.trim().startsWith('SELECT')).toBe(true);
    }
  });
});

/**
 * Property-based test (design.md's Property 21: "Authentik attribute
 * updates are a partial merge, never a wholesale replace"), implemented
 * with `fast-check` via `@fast-check/jest`'s `test.prop` integration.
 *
 * For any existing Authentik attributes object and any subset of
 * `{callsign, color, role}` supplied, the resulting PATCH body must equal
 * the original object with only the supplied (mapped) keys overwritten,
 * leaving every other existing key unchanged.
 */
describe('Property 21: Authentik attribute updates are a partial merge, never a wholesale replace', () => {
  const attrValueArb = fc.string({ minLength: 0, maxLength: 10 });
  const suppliedAttributesArb = fc.record(
    {
      callsign: attrValueArb,
      color: attrValueArb,
      role: attrValueArb
    },
    { requiredKeys: [] }
  );
  const existingAttributesArb = fc.dictionary(
    fc.constantFrom('takCallsign', 'takColor', 'takRole', 'someUnrelatedKey', 'anotherKey'),
    attrValueArb
  );

  test.prop([existingAttributesArb, suppliedAttributesArb], { numRuns: 100 })(
    'the PATCHed attributes always equal the original object with only the supplied keys overwritten',
    async (existingAttributes, suppliedAttributes) => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ attributes: existingAttributes }) })
        .mockResolvedValueOnce({ ok: true });

      await UserAttributesService.updateUserAttributes('authentik-user-x', suppliedAttributes);

      const [, patchCall] = global.fetch.mock.calls;
      const patchedAttributes = JSON.parse(patchCall[1].body).attributes;

      const expected = { ...existingAttributes };
      if (suppliedAttributes.callsign !== undefined) expected.takCallsign = suppliedAttributes.callsign;
      if (suppliedAttributes.color !== undefined) expected.takColor = suppliedAttributes.color;
      if (suppliedAttributes.role !== undefined) expected.takRole = suppliedAttributes.role;

      expect(patchedAttributes).toEqual(expected);

      delete global.fetch;
    }
  );
});

/**
 * Property-based test (design.md's Property 6: "Callsign_Generator
 * selects exactly the present, selected levels"), implemented with
 * `fast-check` via `@fast-check/jest`'s `test.prop` integration, matching
 * the convention established in `../config/configValidator.test.js`,
 * `../config/permissions.registry.test.js`, and
 * `../config/htmlSafeSubset.test.js`.
 *
 * For any generated Ancestor_Chain (0..MAX_TEAM_DEPTH levels beneath the
 * Organisation, each with a random callsign_prefix) and any
 * Callsign_Level_Selection subset of [1..MAX_TEAM_DEPTH],
 * `computeCallsignAttributes`'s Team segment must equal exactly the
 * `callsign_prefix` values at depths that are both selected AND present
 * in the chain, in ascending depth order -- with no error raised for a
 * selected depth absent from the chain.
 */
describe('Property 6: Callsign_Generator selects exactly the present, selected levels', () => {
  const prefixArb = fc.stringMatching(/^[A-Z0-9]{1,6}$/);

  const chainDepthArb = fc.integer({ min: 0, max: MAX_TEAM_DEPTH });
  const levelSelectionArb = fc.uniqueArray(fc.integer({ min: 1, max: MAX_TEAM_DEPTH }));

  test.prop([chainDepthArb, levelSelectionArb, prefixArb, prefixArb], { numRuns: 100 })(
    'the assembled Team segment always equals the ascending-depth-ordered concatenation of prefixes at (selection ∩ present depths)',
    async (chainDepth, callsignLevelSelection, orgPrefix, suffix) => {
      pool.query.mockReset();
      Team.getAncestorChain.mockReset();
      mockUserLookup(suffix);

      const chain = [organisationRow({ callsignPrefix: orgPrefix, callsignLevelSelection })];
      for (let depth = 1; depth <= chainDepth; depth += 1) {
        chain.push(
          teamRow({
            id: depth + 1,
            parentTeamId: depth,
            name: `Team${depth}`,
            callsignPrefix: `L${depth}`,
            depth
          })
        );
      }
      Team.getAncestorChain.mockResolvedValue(chain);

      const result = await UserAttributesService.computeCallsignAttributes(42, 999);

      expect(result).not.toBeNull();

      const expectedTeamSegment = callsignLevelSelection
        .filter((depth) => depth <= chainDepth)
        .sort((a, b) => a - b)
        .map((depth) => `L${depth}`)
        .join('');

      const expectedCallsign = [orgPrefix, expectedTeamSegment, suffix]
        .filter((segment) => segment !== '' && segment != null)
        .join('-');

      expect(result.callsign).toBe(expectedCallsign);
    }
  );
});
