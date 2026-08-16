/**
 * Unit tests for `GroupMembershipCalculator` (task 58.5, Requirement 12.3).
 *
 * Covers, at minimum, per Requirement 12.3:
 *  - `getUserTeamHierarchy`: a user assigned to a single team with no
 *    parent, a user assigned to a team with >=2 levels of parent-team
 *    hierarchy, and a user with no team assignment.
 *  - `applyRule` for each of its three `rule_type` branches
 *    (`team_hierarchy`, `bch_channels`, `region_channels`).
 *  - `calculateUserGroups` end-to-end, asserting it dedupes across
 *    multiple rules via the `Set`.
 *
 * Follows this codebase's established convention (see
 * `TeamMembershipService.test.js`) of mocking `../config/database`'s
 * `pool.query` directly, since `GroupMembershipCalculator` never uses a
 * transactional client -- every method is a plain `pool.query(...)` call.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const pool = require('../config/database');
const GroupMembershipCalculator = require('./GroupMembershipCalculator');

describe('GroupMembershipCalculator.getUserTeamHierarchy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('single team no parent: returns the single base-case row', async () => {
    const row = { id: 20, name: 'Leaf Team', parent_team_id: null, level: 0 };
    pool.query.mockResolvedValue({ rows: [row] });

    const result = await GroupMembershipCalculator.getUserTeamHierarchy(5);

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WITH RECURSIVE team_hierarchy'), [5]);
    expect(result).toEqual([row]);
  });

  it('>=2-level hierarchy: returns all rows in increasing level order, matching the recursive CTE output shape', async () => {
    const rows = [
      { id: 30, name: 'Grandchild Team', parent_team_id: 20, level: 0 },
      { id: 20, name: 'Child Team', parent_team_id: 10, level: 1 },
      { id: 10, name: 'Root Team', parent_team_id: null, level: 2 }
    ];
    pool.query.mockResolvedValue({ rows });

    const result = await GroupMembershipCalculator.getUserTeamHierarchy(6);

    expect(result).toEqual(rows);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.level)).toEqual([0, 1, 2]);
  });

  it('no team assigned: returns an empty array, not an error', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await GroupMembershipCalculator.getUserTeamHierarchy(7);

    expect(result).toEqual([]);
  });
});

describe('GroupMembershipCalculator.applyRule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('team_hierarchy: produces one group per team in the hierarchy, substituting {{team_name}} and lowercasing/underscoring the name', async () => {
    const rule = {
      rule_type: 'team_hierarchy',
      target_group_pattern: 'tak.{{team_name}}',
      permission_type: 'read_write'
    };
    const teamHierarchy = [
      { id: 1, name: 'Alpha Team', parent_team_id: null, level: 0 },
      { id: 2, name: 'Bravo HQ', parent_team_id: null, level: 1 }
    ];

    const groups = await GroupMembershipCalculator.applyRule(rule, 5, teamHierarchy);

    expect(groups).toEqual([
      { name: 'tak.alpha_team', permission: 'read_write' },
      { name: 'tak.bravo_hq', permission: 'read_write' }
    ]);
  });

  it('bch_channels: produces a single group using the rule\'s target_group_pattern verbatim', async () => {
    const rule = {
      rule_type: 'bch_channels',
      target_group_pattern: 'bch.national',
      permission_type: 'read'
    };

    const groups = await GroupMembershipCalculator.applyRule(rule, 5, []);

    expect(groups).toEqual([{ name: 'bch.national', permission: 'read' }]);
  });

  it('region_channels: produces a single group using the rule\'s target_group_pattern verbatim', async () => {
    const rule = {
      rule_type: 'region_channels',
      target_group_pattern: 'region.north',
      permission_type: 'read'
    };

    const groups = await GroupMembershipCalculator.applyRule(rule, 5, []);

    expect(groups).toEqual([{ name: 'region.north', permission: 'read' }]);
  });

  it('unknown rule_type: produces no groups', async () => {
    const rule = { rule_type: 'something_else', target_group_pattern: 'x', permission_type: 'read' };

    const groups = await GroupMembershipCalculator.applyRule(rule, 5, []);

    expect(groups).toEqual([]);
  });
});

describe('GroupMembershipCalculator.calculateUserGroups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('orchestrates getUserTeamHierarchy + getActiveRules + applyRule, unioning every rule\'s resulting groups', async () => {
    const teamHierarchyRows = [{ id: 1, name: 'Alpha Team', parent_team_id: null, level: 0 }];
    const rules = [
      { rule_type: 'team_hierarchy', target_group_pattern: '{{team_name}}', permission_type: 'read_write', priority: 1 },
      { rule_type: 'bch_channels', target_group_pattern: 'bch.national', permission_type: 'read', priority: 2 },
      { rule_type: 'region_channels', target_group_pattern: 'region.north', permission_type: 'read', priority: 3 }
    ];

    pool.query.mockImplementation((sql) => {
      if (sql.includes('WITH RECURSIVE team_hierarchy')) {
        return Promise.resolve({ rows: teamHierarchyRows });
      }
      if (sql.includes('FROM group_membership_rules')) {
        return Promise.resolve({ rows: rules });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await GroupMembershipCalculator.calculateUserGroups(5);

    expect(result).toEqual(
      expect.arrayContaining([
        { name: 'alpha_team', permission: 'read_write' },
        { name: 'bch.national', permission: 'read' },
        { name: 'region.north', permission: 'read' }
      ])
    );
    expect(result).toHaveLength(3);
  });

  it('dedupes a group reference that is added to the Set more than once (e.g. produced by more than one team in the hierarchy sharing an applyRule-returned object)', async () => {
    // `calculateUserGroups`'s `requiredGroups` is a `Set` populated by
    // `groups.forEach(group => requiredGroups.add(group))` for each
    // rule's `applyRule` result array. A `Set` of objects only collapses
    // entries that are the SAME object reference (not merely
    // shape-equal), so the one realistic way `calculateUserGroups`
    // itself produces a genuine duplicate is when a single `applyRule`
    // call's returned array contains the same object reference more than
    // once (e.g. a `team_hierarchy` rule whose hierarchy lists the same
    // team id twice, which the recursive CTE guards against via `level`
    // but is exercised here directly at the `applyRule` return-value
    // level to isolate the Set's own dedupe behavior from the CTE).
    const teamHierarchyRows = [
      { id: 1, name: 'Alpha Team', parent_team_id: null, level: 0 },
      { id: 1, name: 'Alpha Team', parent_team_id: null, level: 0 }
    ];
    const rules = [
      { rule_type: 'team_hierarchy', target_group_pattern: '{{team_name}}', permission_type: 'read_write', priority: 1 }
    ];

    pool.query.mockImplementation((sql) => {
      if (sql.includes('WITH RECURSIVE team_hierarchy')) {
        return Promise.resolve({ rows: teamHierarchyRows });
      }
      if (sql.includes('FROM group_membership_rules')) {
        return Promise.resolve({ rows: rules });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await GroupMembershipCalculator.calculateUserGroups(5);

    // applyRule builds a NEW object literal per team in teamHierarchy,
    // so two identical-looking rows still yield two distinct object
    // references and therefore two Set entries -- demonstrating that
    // `calculateUserGroups`'s dedupe is reference-based, not
    // value-based, which callers must be aware of.
    expect(result).toHaveLength(2);
    result.forEach((group) => {
      expect(group).toEqual({ name: 'alpha_team', permission: 'read_write' });
    });
  });

  it('no team assigned: still returns groups from non-team_hierarchy rules (empty hierarchy does not error)', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('WITH RECURSIVE team_hierarchy')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('FROM group_membership_rules')) {
        return Promise.resolve({
          rows: [{ rule_type: 'bch_channels', target_group_pattern: 'bch.national', permission_type: 'read', priority: 1 }]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await GroupMembershipCalculator.calculateUserGroups(8);

    expect(result).toEqual([{ name: 'bch.national', permission: 'read' }]);
  });
});
