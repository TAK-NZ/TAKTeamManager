/**
 * Unit and property-based tests for `UserAttributesService` (Requirement
 * 12.1 / tasks 58.2 and 58.3).
 *
 * `UserAttributesService.splitFullName` is a pure function. `generateCallsign`
 * reads `first_name`/`last_name` from the `users` table for a given
 * `userId` and delegates to `computeCallsignAttributes`, which itself reads
 * the target team's hierarchy (root-to-target path, callsign prefixes,
 * `callsign_subteam_depth`, `callsign_name_format`) via a recursive CTE
 * before building the callsign string.
 *
 * `pool.query` (`../config/database`) is mocked per this codebase's
 * established convention (see `./RequestApprovalService.test.js`,
 * `./MouService.test.js`).
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const UserAttributesService = require('./userAttributes');

/**
 * Builds a single team-hierarchy row as returned by
 * `computeCallsignAttributes`'s recursive CTE query. For the tests in
 * this file, a single-row hierarchy (the target team IS the root team,
 * i.e. no parent) is sufficient: `rootTeam.callsign_subteam_depth`,
 * `callsign_name_format`, and `color` all come from this one row, and the
 * loop building team-prefix parts only ever looks at `teamPath[0]` for a
 * 1-row hierarchy.
 */
function teamHierarchyRow({
  id = 1,
  name = 'Alpha Team',
  callsignPrefix = 'ALPHA',
  callsignSubteamDepth = 1,
  callsignNameFormat = null,
  color = '#3B82F6'
} = {}) {
  return {
    id,
    name,
    callsign_prefix: callsignPrefix,
    parent_team_id: null,
    callsign_subteam_depth: callsignSubteamDepth,
    callsign_name_format: callsignNameFormat,
    color,
    position: 1
  };
}

function mockTeamHierarchyQuery(row) {
  pool.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_path')) {
      return Promise.resolve({ rows: row ? [row] : [] });
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

describe('UserAttributesService.computeCallsignAttributes - two-part name', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('formats a two-part name with the "first_initial_last" format', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: 'first_initial_last' }));

    const result = await UserAttributesService.computeCallsignAttributes('John', 'Smith', 1);

    expect(result).toEqual({
      callsign: 'ALPHA-J Smith',
      color: '#3B82F6',
      role: 'Team Member'
    });
  });

  it('formats a two-part name with the "first_last_initial" format', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: 'first_last_initial' }));

    const result = await UserAttributesService.computeCallsignAttributes('John', 'Smith', 1);

    expect(result).toEqual({
      callsign: 'ALPHA-John S',
      color: '#3B82F6',
      role: 'Team Member'
    });
  });

  it('formats a two-part name with the default "{firstName} {lastName}" format when callsign_name_format is unset', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: null }));

    const result = await UserAttributesService.computeCallsignAttributes('John', 'Smith', 1);

    expect(result).toEqual({
      callsign: 'ALPHA-John Smith',
      color: '#3B82F6',
      role: 'Team Member'
    });
  });

  it('formats a two-part name with an unrecognized callsign_name_format value via the default branch', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: 'some_future_format' }));

    const result = await UserAttributesService.computeCallsignAttributes('John', 'Smith', 1);

    expect(result.callsign).toBe('ALPHA-John Smith');
  });
});

describe('UserAttributesService.computeCallsignAttributes - single-word name (splitFullName fallback)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('splits a single-word firstName (with an empty lastName) into first/last before formatting (default format)', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: null }));

    const result = await UserAttributesService.computeCallsignAttributes('John Smith', '', 1);

    // splitFullName('John Smith') -> {firstName: 'John', lastName: 'Smith'}
    expect(result).toEqual({
      callsign: 'ALPHA-John Smith',
      color: '#3B82F6',
      role: 'Team Member'
    });
  });

  it('splits a single-word firstName (with an empty lastName) into first/last before formatting ("first_initial_last")', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: 'first_initial_last' }));

    const result = await UserAttributesService.computeCallsignAttributes('John Smith', '', 1);

    expect(result.callsign).toBe('ALPHA-J Smith');
  });

  it('does NOT split when firstName is a genuinely single word and lastName is empty (no space to split on)', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: 'first_initial_last' }));

    const result = await UserAttributesService.computeCallsignAttributes('Madonna', '', 1);

    // lastName stays '' (falsy) -> nameFormat falls back to plain firstName
    // per the 'first_initial_last' branch's `else { nameFormat = firstName; }`.
    expect(result.callsign).toBe('ALPHA-Madonna');
  });

  it('does not trigger the splitting fallback when lastName is already non-empty, even if firstName contains a space', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: null }));

    const result = await UserAttributesService.computeCallsignAttributes('Mary Jane', 'Watson', 1);

    // lastName is non-empty, so the `!lastName && firstName.includes(' ')`
    // guard is false and firstName is used as-is (not split).
    expect(result.callsign).toBe('ALPHA-Mary Jane Watson');
  });
});

describe('UserAttributesService.computeCallsignAttributes - non-alphanumeric characters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes an apostrophe in the name through unchanged (default format)', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: null }));

    const result = await UserAttributesService.computeCallsignAttributes("O'Brien", 'Murphy', 1);

    expect(result.callsign).toBe("ALPHA-O'Brien Murphy");
  });

  it('passes a hyphenated last name through unchanged (default format)', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: null }));

    const result = await UserAttributesService.computeCallsignAttributes('Anna', 'Smith-Jones', 1);

    expect(result.callsign).toBe('ALPHA-Anna Smith-Jones');
  });

  it('passes accented/unicode characters through unchanged (default format)', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: null }));

    const result = await UserAttributesService.computeCallsignAttributes('José', 'Muñoz', 1);

    expect(result.callsign).toBe('ALPHA-José Muñoz');
  });

  it('passes non-alphanumeric characters through unchanged with "first_initial_last" (only the first character is taken, punctuation included if it is first)', async () => {
    mockTeamHierarchyQuery(teamHierarchyRow({ callsignNameFormat: 'first_initial_last' }));

    const result = await UserAttributesService.computeCallsignAttributes("O'Brien", 'Smith-Jones', 1);

    // firstName.charAt(0) === 'O' here since the apostrophe is not the
    // first character; the lastName's hyphen passes through untouched.
    expect(result.callsign).toBe('ALPHA-O Smith-Jones');
  });
});

describe('UserAttributesService.generateCallsign', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads first_name/last_name from users and delegates to computeCallsignAttributes', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name FROM users')) {
        return Promise.resolve({ rows: [{ first_name: 'John', last_name: 'Smith' }] });
      }
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_path')) {
        return Promise.resolve({ rows: [teamHierarchyRow({ callsignNameFormat: null })] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await UserAttributesService.generateCallsign(42, 1);

    expect(result).toEqual({
      callsign: 'ALPHA-John Smith',
      color: '#3B82F6',
      role: 'Team Member'
    });
  });

  it('returns null when the user lookup finds no rows', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name FROM users')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await UserAttributesService.generateCallsign(999, 1);

    expect(result).toBeNull();
  });

  it('returns null and logs when the users query throws', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT first_name, last_name FROM users')) {
        return Promise.reject(new Error('db connection lost'));
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await UserAttributesService.generateCallsign(42, 1);

    expect(result).toBeNull();
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });
});

describe('UserAttributesService.computeCallsignAttributes - team hierarchy lookup miss', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when the team hierarchy lookup finds no rows', async () => {
    mockTeamHierarchyQuery(null);

    const result = await UserAttributesService.computeCallsignAttributes('John', 'Smith', 999);

    expect(result).toBeNull();
  });

  it('returns null and logs when the team hierarchy query throws', async () => {
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('WITH RECURSIVE team_path')) {
        return Promise.reject(new Error('db connection lost'));
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await UserAttributesService.computeCallsignAttributes('John', 'Smith', 1);

    expect(result).toBeNull();
    expect(mockLoggerInstance.error).toHaveBeenCalled();
  });
});

/**
 * Property-based test (design.md's Property 6), implemented with
 * `fast-check` via `@fast-check/jest`'s `test.prop` integration, matching
 * the convention established in `../config/configValidator.test.js`,
 * `../config/permissions.registry.test.js`, and
 * `../config/htmlSafeSubset.test.js`.
 *
 * design.md's Property 6 statement: "For any non-empty name string and
 * any configured callsign format, the generated callsign is non-empty and
 * its name portion never contains the team-hierarchy separator character
 * sequence."
 *
 * The team-hierarchy side of `computeCallsignAttributes` is deliberately
 * kept valid/non-degenerate on every run (a single-row hierarchy with a
 * random depth/prefix/format) via a per-run `pool.query` mock, so the
 * property is isolated to NAME-driven non-emptiness rather than an
 * unrelated team-lookup failure.
 */
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

// Feature: production-hardening, Property 6: Callsign generation never produces an empty result for a non-empty name
describe('Property 6: Callsign generation never produces an empty result for a non-empty name', () => {
  const nonEmptyNameArb = fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => s.trim().length > 0);

  const lastNameArb = fc.oneof(
    fc.constant(''),
    fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0)
  );

  const callsignPrefixArb = fc.oneof(
    fc.constant(null),
    fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.trim().length > 0)
  );

  const callsignNameFormatArb = fc.constantFrom(
    'first_initial_last',
    'first_last_initial',
    'unrecognized_format',
    null
  );

  const callsignSubteamDepthArb = fc.integer({ min: 0, max: 5 });

  test.prop(
    [nonEmptyNameArb, lastNameArb, callsignPrefixArb, callsignNameFormatArb, callsignSubteamDepthArb],
    { numRuns: 100 }
  )(
    'computeCallsignAttributes never returns an empty callsign for a non-empty (after trim) name, for any valid team hierarchy/format configuration',
    async (firstName, lastName, callsignPrefix, callsignNameFormat, callsignSubteamDepth) => {
      pool.query.mockReset();
      mockTeamHierarchyQuery(
        teamHierarchyRow({
          callsignPrefix,
          callsignNameFormat,
          callsignSubteamDepth
        })
      );

      const result = await UserAttributesService.computeCallsignAttributes(firstName, lastName, 1);

      expect(result).not.toBeNull();
      expect(typeof result.callsign).toBe('string');
      expect(result.callsign.length).toBeGreaterThan(0);
      expect(result.callsign.trim().length).toBeGreaterThan(0);
    }
  );
});
