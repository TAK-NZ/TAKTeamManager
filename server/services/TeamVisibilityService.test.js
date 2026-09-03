/**
 * Unit tests for `TeamVisibilityService.isVisibleBranch` (Requirement 6,
 * task 13.1).
 *
 * `Team.getAncestorChain` and `Team.isAdmin` are mocked (the service is
 * built directly on top of them, per design.md), and `pool.query` is
 * mocked for the service's own purpose-built viewer-membership query.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));
jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
  isAdmin: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Team = require('../models/Team');
const TeamVisibilityService = require('./TeamVisibilityService');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

describe('TeamVisibilityService.isVisibleBranch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true for a Global_Manager without consulting the Ancestor_Chain or membership at all', async () => {
    const result = await TeamVisibilityService.isVisibleBranch(42, { userId: 1, is_global_manager: true });

    expect(result).toBe(true);
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns false for a nonexistent team (empty Ancestor_Chain)', async () => {
    Team.getAncestorChain.mockResolvedValueOnce([]);

    const result = await TeamVisibilityService.isVisibleBranch(999, { userId: 1, is_global_manager: false });

    expect(result).toBe(false);
  });

  it('returns false when there is no user at all (anonymous viewer)', async () => {
    Team.getAncestorChain.mockResolvedValueOnce([
      { id: 1, parent_team_id: null, visibility: 'public', depth: 0 }
    ]);

    const result = await TeamVisibilityService.isVisibleBranch(1, null);

    expect(result).toBe(false);
  });

  it('is visible to a non-member when the whole chain is public and same-Organisation', async () => {
    // Target team chain: Organisation(1, public) -> Team(2, public)
    Team.getAncestorChain.mockImplementation((teamId) => {
      if (teamId === 2) {
        return Promise.resolve([
          { id: 1, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 2, parent_team_id: 1, visibility: 'public', depth: 1 }
        ]);
      }
      // Viewer's own membership team (team 1, the same Organisation).
      if (teamId === 1) {
        return Promise.resolve([{ id: 1, parent_team_id: null, visibility: 'public', depth: 0 }]);
      }
      return Promise.resolve([]);
    });
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 1 }] });

    const result = await TeamVisibilityService.isVisibleBranch(2, { userId: 5, is_global_manager: false });

    expect(result).toBe(true);
    // No admin check needed for the simple public/no-private-ancestor path.
    expect(Team.isAdmin).not.toHaveBeenCalled();
  });

  it('is NOT visible to a non-member/non-admin when the chain has a private ancestor, even though it is the same Organisation', async () => {
    // Target team chain: Organisation(1, public) -> PrivateTeam(2, private) -> Team(3, public).
    // The viewer's own membership is on team 4, a SIBLING Sub_Team of the
    // same Organisation (1) -- same-Organisation, but not a member of
    // team 3's own Ancestor_Chain {1, 2, 3}.
    Team.getAncestorChain.mockImplementation((teamId) => {
      if (teamId === 3) {
        return Promise.resolve([
          { id: 1, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 2, parent_team_id: 1, visibility: 'private', depth: 1 },
          { id: 3, parent_team_id: 2, visibility: 'public', depth: 2 }
        ]);
      }
      if (teamId === 4) {
        return Promise.resolve([
          { id: 1, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 4, parent_team_id: 1, visibility: 'public', depth: 1 }
        ]);
      }
      return Promise.resolve([]);
    });
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 4 }] });
    Team.isAdmin.mockResolvedValueOnce(false);

    const result = await TeamVisibilityService.isVisibleBranch(3, { userId: 5, is_global_manager: false });

    expect(result).toBe(false);
  });

  it('IS visible to a direct member of the private ancestor', async () => {
    Team.getAncestorChain.mockImplementation((teamId) => {
      if (teamId === 3) {
        return Promise.resolve([
          { id: 1, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 2, parent_team_id: 1, visibility: 'private', depth: 1 },
          { id: 3, parent_team_id: 2, visibility: 'public', depth: 2 }
        ]);
      }
      // Viewer is a direct member of team 2 (the private ancestor).
      if (teamId === 2) {
        return Promise.resolve([
          { id: 1, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 2, parent_team_id: 1, visibility: 'private', depth: 1 }
        ]);
      }
      return Promise.resolve([]);
    });
    // Viewer's membership: team 2, the private ancestor itself.
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 2 }] });

    const result = await TeamVisibilityService.isVisibleBranch(3, { userId: 7, is_global_manager: false });

    expect(result).toBe(true);
    // Membership intersection alone should resolve this -- no need to
    // fall through to an admin check.
    expect(Team.isAdmin).not.toHaveBeenCalled();
  });

  it('IS visible to an inherited-admin of an ancestor (via Team.isAdmin), even when the viewer holds no membership row anywhere in the target chain itself', async () => {
    Team.getAncestorChain.mockImplementation((teamId) => {
      if (teamId === 3) {
        return Promise.resolve([
          { id: 1, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 2, parent_team_id: 1, visibility: 'private', depth: 1 },
          { id: 3, parent_team_id: 2, visibility: 'public', depth: 2 }
        ]);
      }
      // Viewer's own membership is on team 99, a different Sub_Team of
      // the SAME Organisation (1) -- not team 1, 2, or 3 themselves, so
      // the plain membership-intersection check alone would say "no".
      if (teamId === 99) {
        return Promise.resolve([
          { id: 1, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 99, parent_team_id: 1, visibility: 'public', depth: 1 }
        ]);
      }
      return Promise.resolve([]);
    });
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 99 }] });
    // Team.isAdmin is mocked directly here since it independently walks
    // teamId=3's own Ancestor_Chain via its own CTE -- this test only
    // needs to confirm isVisibleBranch consults it, and grants
    // visibility, when the plain membership-intersection check fails.
    Team.isAdmin.mockResolvedValueOnce(true);

    const result = await TeamVisibilityService.isVisibleBranch(3, { userId: 9, is_global_manager: false });

    expect(result).toBe(true);
    expect(Team.isAdmin).toHaveBeenCalledWith(3, 9);
  });

  it('is NEVER visible to a non-Global_Manager viewer from a different Organisation, even for a fully public chain', async () => {
    Team.getAncestorChain.mockImplementation((teamId) => {
      if (teamId === 20) {
        return Promise.resolve([
          { id: 20, parent_team_id: null, visibility: 'public', depth: 0 }
        ]);
      }
      // Viewer's own membership is under a completely different Organisation (id 30).
      if (teamId === 31) {
        return Promise.resolve([
          { id: 30, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 31, parent_team_id: 30, visibility: 'public', depth: 1 }
        ]);
      }
      return Promise.resolve([]);
    });
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 31 }] });

    const result = await TeamVisibilityService.isVisibleBranch(20, { userId: 11, is_global_manager: false });

    expect(result).toBe(false);
    // Cross-Organisation exclusion is absolute -- membership/admin
    // status is never even consulted once same_organisation is false.
    expect(Team.isAdmin).not.toHaveBeenCalled();
  });
});

describe('TeamVisibilityService.filterVisibleBranches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns every row unfiltered for a Global_Manager, with zero DB calls', async () => {
    const teams = [
      { id: 1, parent_team_id: null, visibility: 'public' },
      { id: 2, parent_team_id: 1, visibility: 'private' }
    ];

    const result = await TeamVisibilityService.filterVisibleBranches(teams, { userId: 1, is_global_manager: true });

    expect(result).toBe(teams);
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns [] for an anonymous/no-userId viewer', async () => {
    const teams = [{ id: 1, parent_team_id: null, visibility: 'public' }];

    const result = await TeamVisibilityService.filterVisibleBranches(teams, null);

    expect(result).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns [] for an empty teams array', async () => {
    const result = await TeamVisibilityService.filterVisibleBranches([], { userId: 1, is_global_manager: false });
    expect(result).toEqual([]);
  });

  it('returns a whole connected single-Organisation public hierarchy unfiltered for a same-Organisation viewer, with no per-row getAncestorChain fallback', async () => {
    // Organisation(1) -> Team(2) -> Team(3), all public, connected (every
    // ancestor of every row is present in `teams` itself).
    const teams = [
      { id: 1, parent_team_id: null, visibility: 'public' },
      { id: 2, parent_team_id: 1, visibility: 'public' },
      { id: 3, parent_team_id: 2, visibility: 'public' }
    ];
    // Viewer's own membership is on team 1 (same Organisation), which IS
    // covered by the local adjacency map built from `teams`.
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 1 }] });

    const result = await TeamVisibilityService.filterVisibleBranches(teams, { userId: 5, is_global_manager: false });

    expect(result).toEqual(teams);
    // Fully connected input + viewer membership resolvable locally ->
    // zero getAncestorChain fallback calls, and no admin check needed
    // since nothing is private.
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
    expect(Team.isAdmin).not.toHaveBeenCalled();
  });

  it('excludes a private branch (and cascades to its own public sub-team) for a non-member, and preserves original order for the rest', async () => {
    // Organisation(1) -> PrivateTeam(2, private) -> Team(3, public);
    // Organisation(1) -> SiblingTeam(4, public).
    const teams = [
      { id: 1, parent_team_id: null, visibility: 'public' },
      { id: 2, parent_team_id: 1, visibility: 'private' },
      { id: 3, parent_team_id: 2, visibility: 'public' },
      { id: 4, parent_team_id: 1, visibility: 'public' }
    ];
    // Viewer's membership is on team 4 -- same Organisation, but not a
    // member/admin of the private branch (2, 3).
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 4 }] });
    Team.isAdmin.mockResolvedValue(false);

    const result = await TeamVisibilityService.filterVisibleBranches(teams, { userId: 9, is_global_manager: false });

    expect(result).toEqual([
      { id: 1, parent_team_id: null, visibility: 'public' },
      { id: 4, parent_team_id: 1, visibility: 'public' }
    ]);
  });

  it('includes a private branch for a member of that branch', async () => {
    const teams = [
      { id: 1, parent_team_id: null, visibility: 'public' },
      { id: 2, parent_team_id: 1, visibility: 'private' },
      { id: 3, parent_team_id: 2, visibility: 'public' }
    ];
    // Viewer is a direct member of team 2 (the private team itself).
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 2 }] });

    const result = await TeamVisibilityService.filterVisibleBranches(teams, { userId: 7, is_global_manager: false });

    expect(result).toEqual(teams);
    // Membership intersection alone resolves both team 2 and team 3 --
    // no admin check needed.
    expect(Team.isAdmin).not.toHaveBeenCalled();
  });

  it('includes a private branch for an inherited-admin of that branch (via Team.isAdmin)', async () => {
    const teams = [
      { id: 1, parent_team_id: null, visibility: 'public' },
      { id: 2, parent_team_id: 1, visibility: 'private' },
      { id: 3, parent_team_id: 2, visibility: 'public' },
      { id: 99, parent_team_id: 1, visibility: 'public' }
    ];
    // Viewer's membership is on team 99, a different Sub_Team of the
    // same Organisation -- not 1, 2, or 3 -- so plain membership
    // intersection fails and Team.isAdmin must be consulted for 2 and 3.
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 99 }] });
    Team.isAdmin.mockResolvedValue(true);

    const result = await TeamVisibilityService.filterVisibleBranches(teams, { userId: 11, is_global_manager: false });

    expect(result).toEqual(teams);
    expect(Team.isAdmin).toHaveBeenCalledWith(2, 11);
    expect(Team.isAdmin).toHaveBeenCalledWith(3, 11);
    // Never consulted for the plain-public Organisation/sibling rows.
    expect(Team.isAdmin).not.toHaveBeenCalledWith(1, 11);
    expect(Team.isAdmin).not.toHaveBeenCalledWith(99, 11);
  });

  it('excludes a row belonging to a different Organisation than the viewer, even if public', async () => {
    const teams = [
      { id: 1, parent_team_id: null, visibility: 'public' }, // viewer's own Organisation
      { id: 20, parent_team_id: null, visibility: 'public' } // a different Organisation
    ];
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 1 }] });

    const result = await TeamVisibilityService.filterVisibleBranches(teams, { userId: 3, is_global_manager: false });

    expect(result).toEqual([{ id: 1, parent_team_id: null, visibility: 'public' }]);
  });

  it('falls back to Team.getAncestorChain for a row whose ancestor is NOT present in the input array, and stays correct', async () => {
    // `teams` contains only a leaf row (5) whose parent (2, private) is
    // NOT included in the array -- the local adjacency map is
    // incomplete for row 5, so the service must fall back to
    // Team.getAncestorChain to resolve it correctly.
    const teams = [{ id: 5, parent_team_id: 2, visibility: 'public' }];
    pool.query.mockResolvedValueOnce({ rows: [{ team_id: 4 }] }); // viewer membership
    Team.getAncestorChain.mockImplementation((teamId) => {
      if (teamId === 5) {
        return Promise.resolve([
          { id: 1, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 2, parent_team_id: 1, visibility: 'private', depth: 1 },
          { id: 5, parent_team_id: 2, visibility: 'public', depth: 2 }
        ]);
      }
      if (teamId === 4) {
        return Promise.resolve([
          { id: 1, parent_team_id: null, visibility: 'public', depth: 0 },
          { id: 4, parent_team_id: 1, visibility: 'public', depth: 1 }
        ]);
      }
      return Promise.resolve([]);
    });
    Team.isAdmin.mockResolvedValueOnce(false);

    const result = await TeamVisibilityService.filterVisibleBranches(teams, { userId: 8, is_global_manager: false });

    expect(result).toEqual([]);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(5);
  });

  it('is consistent with calling isVisibleBranch row-by-row for the same inputs (Property 10)', async () => {
    // A single Organisation's connected hierarchy with a mix of public
    // and private teams, exercised against both the batched and
    // per-row (isVisibleBranch) code paths using the SAME mocked
    // Team.getAncestorChain/Team.isAdmin backing "database".
    const database = new Map([
      [1, { id: 1, parent_team_id: null, visibility: 'public' }],
      [2, { id: 2, parent_team_id: 1, visibility: 'private' }],
      [3, { id: 3, parent_team_id: 2, visibility: 'public' }],
      [4, { id: 4, parent_team_id: 1, visibility: 'public' }]
    ]);
    const buildChain = (teamId) => {
      const chain = [];
      let current = database.get(teamId);
      while (current) {
        chain.unshift({ ...current, depth: 0 });
        current = current.parent_team_id ? database.get(current.parent_team_id) : null;
      }
      chain.forEach((row, index) => { row.depth = index; });
      return chain;
    };
    Team.getAncestorChain.mockImplementation((teamId) => Promise.resolve(buildChain(teamId)));
    // Viewer 9 is a direct member of team 4 only (same Organisation, not
    // a member/admin of the private branch 2/3).
    Team.isAdmin.mockResolvedValue(false);
    const user = { userId: 9, is_global_manager: false };
    const teams = [...database.values()];

    pool.query.mockResolvedValue({ rows: [{ team_id: 4 }] });
    const batched = await TeamVisibilityService.filterVisibleBranches(teams, user);

    const perRow = [];
    for (const team of teams) {
      const visible = await TeamVisibilityService.isVisibleBranch(team.id, user);
      if (visible) {
        perRow.push(team);
      }
    }

    expect(batched.map((t) => t.id)).toEqual(perRow.map((t) => t.id));
    expect(batched.map((t) => t.id)).toEqual([1, 4]);
  });
});

/**
 * Property-based test (design.md's Property 9: "Visible_Branch resolution
 * matches the reference definition", task 13.3), implemented with
 * `fast-check` via `@fast-check/jest`'s `test.prop` integration, matching
 * the convention established in `../models/Team.test.js`'s Property 4
 * test (`hierarchyArb`) and `../config/permissions.registry.test.js`.
 *
 * Per design.md's note on Properties 9-11, this test's reference
 * implementation is deliberately NOT built on top of a shared
 * `teamTreeArb` helper -- task 3.2* (Property 4, admin inheritance)
 * already established the precedent of an inline, self-contained
 * hierarchy generator directly inside its own test file rather than
 * extracting `server/test-helpers/teamTreeArb.js`, and this test follows
 * that same precedent rather than introducing (and having to backfill
 * task 3.2* onto) a shared helper now.
 *
 * The reference implementation below independently re-derives the
 * Visible_Branch definition from requirements.md's Glossary entry,
 * walking the generated hierarchy's OWN parent-pointer data directly
 * (never through a mocked service call), so this property stays a real
 * check against `isVisibleBranch`'s logic rather than a tautology.
 * `Team.getAncestorChain` and the viewer-membership `pool.query` call are
 * mocked from that same generated hierarchy/viewer data; `Team.isAdmin`
 * is mocked directly (its own correctness is already covered by task
 * 3.2*'s Property 4 test) to return the reference-computed direct-or-
 * inherited-admin boolean for the exact `(teamId, userId)` pair
 * `isVisibleBranch` queries it with.
 */
describe('Property 9: Visible_Branch resolution matches the reference definition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const USER_IDS = [201, 202, 203];

  /**
   * Generates a random forest of up to 3 independent trees (so a viewer
   * placed in one tree and a target team in another naturally exercises
   * the cross-Organisation exclusion case), each tree built the same way
   * as `Team.test.js`'s Property 4 `hierarchyArb`: up to 8 teams,
   * 1-indexed per tree with globally-unique ids across the whole forest,
   * team `treeIds[0]` is always that tree's root/Organisation, and every
   * other team's parent is an earlier-id'd team within the SAME tree
   * (guaranteeing an acyclic, single-rooted tree per Organisation, with
   * branching/siblings/deep chains all represented across runs).
   *
   * Each team is independently given an arbitrary `visibility`
   * ('public' or 'private').
   */
  const forestArb = fc
    .array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 3 })
    .chain((treeSizes) => {
      let nextId = 1;
      const treeArbs = treeSizes.map((teamCount) => {
        const teamIds = Array.from({ length: teamCount }, () => nextId++);
        const parentArb = fc.tuple(
          ...teamIds.slice(1).map((_, i) => fc.integer({ min: 0, max: i }))
        );
        const visibilityArb = fc.array(fc.constantFrom('public', 'private'), {
          minLength: teamCount,
          maxLength: teamCount
        });
        return fc.tuple(parentArb, visibilityArb).map(([parentOffsets, visibilities]) => {
          const parentMap = new Map();
          const visibilityMap = new Map();
          parentMap.set(teamIds[0], null);
          visibilityMap.set(teamIds[0], visibilities[0]);
          parentOffsets.forEach((offset, i) => {
            parentMap.set(teamIds[i + 1], teamIds[offset]);
            visibilityMap.set(teamIds[i + 1], visibilities[i + 1]);
          });
          return { rootId: teamIds[0], teamIds, parentMap, visibilityMap };
        });
      });
      return fc.tuple(...treeArbs);
    });

  /**
   * Generates an arbitrary viewer: a Global_Manager flag, and a random
   * set of `team_memberships`-shaped rows (direct or inherited, admin or
   * member) placed across ANY team id present in the generated forest
   * (so a viewer may be a member/admin in a different tree than the
   * team being checked, or in the same tree, at any position).
   */
  function viewerArb(allTeamIds) {
    return fc.record({
      userId: fc.constantFrom(...USER_IDS),
      is_global_manager: fc.boolean(),
      memberships: fc.array(
        fc.record({
          teamId: fc.constantFrom(...allTeamIds),
          role: fc.constantFrom('admin', 'member'),
          direct: fc.boolean()
        }),
        { maxLength: allTeamIds.length * 2 }
      )
    });
  }

  function ancestorsOf(teamId, parentMap) {
    const chain = [];
    let current = teamId;
    while (current !== null && current !== undefined) {
      chain.push(current);
      current = parentMap.get(current);
    }
    return chain.reverse(); // root-first, matching getAncestorChain's contract
  }

  function rootOf(teamId, parentMap) {
    const chain = ancestorsOf(teamId, parentMap);
    return chain[0];
  }

  /**
   * Naive reference implementation of the Visible_Branch definition
   * (requirements.md Glossary), re-derived directly from the generated
   * hierarchy's own parent-pointer/visibility data -- independent of any
   * mocked service call.
   */
  function referenceIsVisibleBranch(targetTeamId, viewer, parentMap, visibilityMap) {
    if (viewer && viewer.is_global_manager) {
      return true;
    }
    const userId = viewer && viewer.userId;
    if (!userId) {
      return false;
    }

    const ancestorIds = ancestorsOf(targetTeamId, parentMap);
    const targetRoot = ancestorIds[0];

    // Every membership team's root (the viewer's Organisation set).
    const memberships = (viewer.memberships || []).filter((m) => parentMap.has(m.teamId));
    const viewerOrgIds = new Set(memberships.map((m) => rootOf(m.teamId, parentMap)));
    if (!viewerOrgIds.has(targetRoot)) {
      return false; // Requirement 6.2: absolute cross-Organisation exclusion
    }

    const hasPrivateAncestor = ancestorIds.some((id) => visibilityMap.get(id) === 'private');
    if (!hasPrivateAncestor) {
      return true; // Requirement 6.1: public branch, no private ancestor
    }

    // Requirement 6.3/6.8: member (direct or inherited) or Team_Admin
    // (direct or inherited) of the target team or any ancestor.
    const ancestorSet = new Set(ancestorIds);
    const isMemberOfChain = memberships.some((m) => ancestorSet.has(m.teamId));
    if (isMemberOfChain) {
      return true;
    }
    const isAdminOfChain = memberships.some(
      (m) => m.direct && m.role === 'admin' && ancestorSet.has(m.teamId)
    );
    return isAdminOfChain;
  }

  // Chaining the viewer generator off the forest (rather than sampling it
  // independently inside the property body) keeps the viewer's
  // memberships properly integrated with fast-check's own shrinking, and
  // lets the viewer's `teamId` choices be drawn from the SAME forest a
  // given run generated.
  const forestAndViewerArb = forestArb.chain((forest) => {
    const allTeamIds = forest.flatMap((tree) => tree.teamIds);
    return fc.tuple(fc.constant(forest), viewerArb(allTeamIds));
  });

  test.prop([forestAndViewerArb], { numRuns: 100 })(
    "isVisibleBranch's actual result equals the independently-computed reference result, for every generated (hierarchy, viewer, target team) combination",
    async ([forest, viewer]) => {
      const parentMap = new Map();
      const visibilityMap = new Map();
      const allTeamIds = [];
      for (const tree of forest) {
        for (const [id, parent] of tree.parentMap) {
          parentMap.set(id, parent);
        }
        for (const [id, visibility] of tree.visibilityMap) {
          visibilityMap.set(id, visibility);
        }
        allTeamIds.push(...tree.teamIds);
      }

      Team.getAncestorChain.mockImplementation((teamId) =>
        Promise.resolve(
          ancestorsOf(teamId, parentMap).map((id, index) => ({
            id,
            parent_team_id: parentMap.get(id) ?? null,
            visibility: visibilityMap.get(id),
            depth: index
          }))
        )
      );
      pool.query.mockImplementation(async () => ({
        rows: viewer.memberships.map((m) => ({ team_id: m.teamId }))
      }));
      Team.isAdmin.mockImplementation(async (teamId, userId) => {
        if (userId !== viewer.userId) {
          return false;
        }
        const ancestorSet = new Set(ancestorsOf(teamId, parentMap));
        return viewer.memberships.some(
          (m) => m.direct && m.role === 'admin' && ancestorSet.has(m.teamId)
        );
      });

      for (const teamId of allTeamIds) {
        const expected = referenceIsVisibleBranch(teamId, viewer, parentMap, visibilityMap);
        const actual = await TeamVisibilityService.isVisibleBranch(teamId, viewer);
        expect(actual).toBe(expected);
      }
    }
  );
});
