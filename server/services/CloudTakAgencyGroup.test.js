/**
 * Property tests for the pure CloudTAK agency-group helpers
 * (spec: cloudtak-agency-groups, tasks 2.3, 2.4, 2.5).
 *
 * - Property 3: Group name is exactly `CloudTAKAgency<id>`
 * - Property 4: Agency attributes map exactly to the Team's fields
 * - Property 5: Membership set equals the direct-admin set
 *
 * Follows the codebase convention (see `OrgInterestService.test.js`,
 * `GroupMembershipCalculator.test.js`) of mocking `../config/database`'s
 * `pool.query` directly, since `getDirectAdmins` issues a plain
 * `client.query(...)` (defaulting to the shared pool).
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const pool = require('../config/database');
const { groupName, agencyAttributes, getDirectAdmins } = require('./CloudTakAgencyGroup');

describe('Property 3: Group name is exactly CloudTAKAgency<id>', () => {
  // Feature: cloudtak-agency-groups, Property 3: Group name is exactly
  // `CloudTAKAgency<id>`
  //
  // Validates: Requirements 2.2
  //
  // `groupName` now reads its prefix from `getCloudTakAgencyGroupPrefix()`
  // (server/config/cloudtak.js), which defaults to "CloudTAKAgency" when
  // `CLOUDTAK_AGENCY_GROUP_PREFIX` is unset. This test runs with that
  // variable deliberately unset/restored, so it exercises the default --
  // the pre-existing hardcoded behavior -- unchanged.
  const originalPrefixEnv = process.env.CLOUDTAK_AGENCY_GROUP_PREFIX;

  beforeEach(() => {
    delete process.env.CLOUDTAK_AGENCY_GROUP_PREFIX;
  });

  afterEach(() => {
    if (originalPrefixEnv === undefined) {
      delete process.env.CLOUDTAK_AGENCY_GROUP_PREFIX;
    } else {
      process.env.CLOUDTAK_AGENCY_GROUP_PREFIX = originalPrefixEnv;
    }
  });

  test.prop([fc.integer()], { numRuns: 100 })(
    'groupName(id) equals the literal "CloudTAKAgency" concatenated with the id, with no extra prefix (in particular no "tak_")',
    (id) => {
      const name = groupName(id);
      expect(name).toBe(`CloudTAKAgency${String(id)}`);
      expect(name.startsWith('CloudTAKAgency')).toBe(true);
      expect(name).not.toContain('tak_');
    }
  );
});

describe('Property 3b: Group name honors a configured CLOUDTAK_AGENCY_GROUP_PREFIX override', () => {
  // Feature: cloudtak-agency-groups, extension: env-configurable agency
  // group prefix. Validates that `groupName` is exactly `<prefix><id>`
  // for ANY non-empty configured prefix, with no separator inserted.
  const originalPrefixEnv = process.env.CLOUDTAK_AGENCY_GROUP_PREFIX;

  afterEach(() => {
    if (originalPrefixEnv === undefined) {
      delete process.env.CLOUDTAK_AGENCY_GROUP_PREFIX;
    } else {
      process.env.CLOUDTAK_AGENCY_GROUP_PREFIX = originalPrefixEnv;
    }
  });

  test.prop(
    [fc.string({ minLength: 1 }).filter((s) => s.length > 0), fc.integer()],
    { numRuns: 100 }
  )('groupName(id) equals the configured prefix concatenated with the id when the env var is set', (prefix, id) => {
    process.env.CLOUDTAK_AGENCY_GROUP_PREFIX = prefix;
    const name = groupName(id);
    expect(name).toBe(`${prefix}${String(id)}`);
  });
});

describe('Property 4: Agency attributes map exactly to the Team fields', () => {
  const teamArb = fc.record({
    id: fc.integer(),
    name: fc.string(),
    description: fc.option(fc.string(), { nil: null }),
    // extra fields that must be ignored by agencyAttributes
    parent_team_id: fc.option(fc.integer(), { nil: null }),
    created_at: fc.date({ noInvalidDate: true }).map((d) => d.toISOString())
  });

  // Feature: cloudtak-agency-groups, Property 4: Agency attributes map
  // exactly to the Team's fields
  //
  // Validates: Requirements 3.1, 3.2, 3.3, 6.4
  test.prop([teamArb], { numRuns: 100 })(
    'agencyAttributes(team) deep-equals exactly { agencyId: team.id, agencyName: team.name, description: team.description } regardless of extra fields',
    (team) => {
      const attributes = agencyAttributes(team);
      expect(attributes).toEqual({
        agencyId: team.id,
        agencyName: team.name,
        description: team.description
      });
      // Exactly those three keys, and agencyId is always the numeric id.
      expect(Object.keys(attributes).sort()).toEqual(['agencyId', 'agencyName', 'description']);
      expect(attributes.agencyId).toBe(team.id);
    }
  );
});

describe('Property 5: Membership set equals the direct-admin set', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // An arbitrary team_memberships row, varying the two columns that decide
  // Direct_Admin membership plus the identifying user fields.
  const membershipRowArb = fc.record({
    user_id: fc.integer({ min: 1, max: 100000 }),
    authentik_user_id: fc.uuid(),
    role: fc.constantFrom('admin', 'member', 'inherited'),
    inherited_from_team_id: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: null })
  });

  // Independent reference filter: the direct-admin definition per Req 4.2.
  const isDirectAdmin = (row) => row.role === 'admin' && row.inherited_from_team_id == null;

  // Feature: cloudtak-agency-groups, Property 5: Membership set equals the
  // direct-admin set
  //
  // Validates: Requirements 4.1, 4.2, 4.4
  test.prop([fc.array(membershipRowArb), fc.integer({ min: 1, max: 1000 })], { numRuns: 100 })(
    'getDirectAdmins issues SQL filtering on role = admin AND inherited_from_team_id IS NULL, and returns exactly the rows the DB resolves for that filter',
    async (rows, teamId) => {
      jest.clearAllMocks();

      // The DB applies the direct-admin filter; model that by resolving
      // pool.query with only the reference-filtered subset, projected to
      // the { user_id, authentik_user_id } shape getDirectAdmins returns.
      const expected = rows
        .filter(isDirectAdmin)
        .map(({ user_id, authentik_user_id }) => ({ user_id, authentik_user_id }));
      pool.query.mockResolvedValue({ rows: expected });

      const result = await getDirectAdmins(teamId);

      // Pass-through: getDirectAdmins returns exactly what the DB resolved.
      expect(result).toEqual(expected);

      // SQL-shape: the filter cannot silently drift away from the
      // direct-admin contract, and the team id is bound as a parameter.
      const [sql, params] = pool.query.mock.calls[0];
      const normalisedSql = sql.replace(/\s+/g, ' ');
      expect(normalisedSql).toContain("role = 'admin'");
      expect(normalisedSql).toContain('inherited_from_team_id IS NULL');
      expect(params).toEqual([teamId]);
    }
  );
});
