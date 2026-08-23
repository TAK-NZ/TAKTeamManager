/**
 * Property test for `GET /api/requests/pending` visibility (spec
 * `team-member-transfer`, task 12.3).
 *
 * Requirement 4.1 gives a Global_Manager every verified pending row.
 * Requirement 4.2 gives everyone else only the rows whose gating Team they
 * administer, Requirement 4.4 fixes "administer" as `Team.isAdmin` (a direct
 * `role = 'admin'` row on that Team or on any Team in its Ancestor_Chain, so
 * an admin ABOVE the gating Team sees the row too), and Requirement 4.3
 * fixes what a returned `team_change` row has to carry.
 *
 * This is a unit test file rather than an `*.integration.test.js` one, so it
 * runs in `npm test` and mocks `pool` the way `./requests.test.js` does. Two
 * collaborators are simulated from the generated data:
 *
 *   - `pool.query` stands in for Postgres. It asserts the route's WHERE
 *     clause is the one Requirements 4.1/4.2 name and then applies that
 *     predicate itself, so the SQL-side half of the filter is simulated
 *     independently of the reference computation below rather than assumed.
 *     `server/models/Team.test.js`'s `getJoinableTeams` property is the model
 *     for that arrangement.
 *   - `Team.isAdmin` runs `simulateTeamIsAdmin`, which re-implements the
 *     recursive CTE in `server/models/Team.js` against the generated
 *     `team_memberships` rows. Its own correctness is covered by
 *     `../models/Team.test.js`'s own property, not here.
 *
 * The reference set is computed by walking the generated hierarchy's parent
 * pointers directly -- through the fixture's `isTeamAdmin` reference helper
 * for admin status and through `referenceTeamPath` for the hierarchy paths --
 * so no expectation is derived from the route, from the mocked
 * `Team.getAncestorChain`, or from the `Team.isAdmin` simulation.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

jest.mock('../models/Team', () => ({
  findById: jest.fn(),
  getJoinableTeams: jest.fn(),
  getAncestorChain: jest.fn(),
  isAdmin: jest.fn()
}));

// The Global_Manager branch of Requirement 4.1 and the filtered branch of
// Requirement 4.2 differ only in `req.user`, so the authenticated user is a
// mutable module-scope value each generated run sets before it calls the
// route. The `mock` name prefix is what lets the factory close over it.
let mockCurrentUser = { id: 'authentik-1', userId: 1, is_global_manager: false };

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockCurrentUser;
    next();
  }
}));

// Authorization is out of scope here: `request:read` gating is covered by
// `../middleware/authorize.test.js`. This suite is about which rows the
// handler itself returns once the caller is through the door.
jest.mock('../middleware/authorize', () => (req, res, next) => next());

jest.mock('axios');

jest.mock('../services/RequestApprovalService', () => {
  return jest.fn().mockImplementation(() => ({
    createAccessRequest: jest.fn(),
    approveRequest: jest.fn(),
    denyRequest: jest.fn()
  }));
});

const express = require('express');
const request = require('supertest');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const pool = require('../config/database');
const Team = require('../models/Team');
const requestsRouter = require('./requests');
const {
  hierarchyArb,
  adminPlacementArb,
  ADMIN_CANDIDATE_USER_IDS
} = require('../services/__fixtures__/transferArbitraries');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/requests', requestsRouter);
  return app;
}

/**
 * Every `request_type` the pending list carries. `team_change` is the one
 * gated on `approval_team_id`; the other three are the pre-existing types,
 * all gated on `target_team_id`, and they have to keep flowing through
 * unchanged.
 */
const REQUEST_TYPES = ['team_change', 'new_account', 'role_change', 'name_change'];

/** Every `access_requests.status` value the pending query can see. */
const STATUSES = ['pending', 'approved', 'denied'];

/**
 * Stand-in for `Team.isAdmin`'s recursive CTE: true when `userId` holds a
 * direct (`inherited_from_team_id IS NULL`) `role = 'admin'` row for
 * `teamId` or for any Team in its Ancestor_Chain. Written against the
 * generated `team_memberships` rows rather than against the fixture's
 * `isTeamAdmin` helper, so the mocked collaborator and the test's own
 * expectation are two independent derivations of the same rule.
 */
function simulateTeamIsAdmin(hierarchy, membershipRows, teamId, userId) {
  const chainIds = hierarchy.ancestorIdsOf(Number(teamId));
  return membershipRows.some(
    (row) =>
      row.user_id === Number(userId) &&
      row.role === 'admin' &&
      row.inherited_from_team_id === null &&
      chainIds.includes(row.team_id)
  );
}

/**
 * The hierarchy path Requirement 4.3 asks for, walked straight off the
 * generated parent pointers: every Team above the named one contributes its
 * `callsign_prefix` (falling back to its name when that is null or empty),
 * the named Team itself contributes its name, joined with ` > `.
 *
 * @param {object} hierarchy A generated Hierarchy.
 * @param {number|null} teamId
 * @param {string|null} fallbackName The joined `teams.name` the route falls
 *   back to when the id names no resolvable chain.
 * @returns {string}
 */
function referenceTeamPath(hierarchy, teamId, fallbackName) {
  if (teamId === null || teamId === undefined) {
    return fallbackName || '';
  }

  const chainIds = [];
  let current = teamId;
  while (current !== null && current !== undefined) {
    chainIds.unshift(current);
    current = hierarchy.parentMap.get(current);
  }

  return chainIds
    .map((id, index) => {
      const team = hierarchy.teams.get(id);
      if (index === chainIds.length - 1) {
        return team.name;
      }
      return team.callsign_prefix || team.name;
    })
    .join(' > ');
}

/**
 * Requirement 4.2's gating column, stated here as the requirement states it
 * rather than as the route expresses it: `approval_team_id` for a
 * `team_change` row, `target_team_id` for anything else.
 */
function referenceGatingTeamId(row) {
  const teamId = row.request_type === 'team_change' ? row.approval_team_id : row.target_team_id;
  return teamId === null || teamId === undefined ? null : teamId;
}

/**
 * The reference visible set: Requirement 4.1's whole verified-pending set
 * for a Global_Manager, otherwise Requirement 4.2/4.4's subset whose gating
 * Team the caller is a Team_Admin of. A row naming no gating Team fails
 * closed.
 */
function referenceVisibleRows(rows, admins, actorId, actorIsGlobalManager) {
  const verifiedPending = rows.filter(
    (row) => row.status === 'pending' && row.email_verified === true
  );

  if (actorIsGlobalManager) {
    return verifiedPending;
  }

  return verifiedPending.filter((row) => {
    const gatingTeamId = referenceGatingTeamId(row);
    return gatingTeamId !== null && admins.isTeamAdmin(gatingTeamId, actorId);
  });
}

/**
 * A team id drawn from the generated hierarchy, or `null`. Every gating
 * candidate column is independently nullable in the schema -- a legacy
 * `team_change` row predating the `approval_team_id` migration holds NULL
 * there -- and Requirement 4.2's gating has to fail closed on it.
 */
function teamIdOrNullArb(hierarchy) {
  return fc.oneof(
    { arbitrary: fc.constantFrom(...hierarchy.teamIds), weight: 6 },
    { arbitrary: fc.constant(null), weight: 1 }
  );
}

/**
 * One `access_requests` row spec. `approval_team_id`, `target_team_id`, and
 * `current_team_id` are drawn independently so a row gated on the wrong
 * column is observable, and so a `team_change` row's Source_Team and
 * Destination_Team paths are two distinct assertions rather than one.
 */
function rowSpecArb(hierarchy) {
  return fc.record({
    request_type: fc.constantFrom(...REQUEST_TYPES),
    // Weighted towards the rows the route can actually return, so a run
    // does not spend most of its rows on the trivially-excluded half.
    status: fc.oneof(
      { arbitrary: fc.constant('pending'), weight: 4 },
      { arbitrary: fc.constantFrom(...STATUSES), weight: 1 }
    ),
    email_verified: fc.oneof(
      { arbitrary: fc.constant(true), weight: 4 },
      { arbitrary: fc.constant(false), weight: 1 }
    ),
    approval_team_id: teamIdOrNullArb(hierarchy),
    target_team_id: teamIdOrNullArb(hierarchy),
    current_team_id: teamIdOrNullArb(hierarchy)
  });
}

/**
 * Materialises a row spec into the row shape `PENDING_REQUESTS_SELECT`
 * produces, including the join-derived `team_change` columns of Requirement
 * 4.3. The joined name columns are NULL exactly when the column they are
 * joined on is NULL, matching the LEFT JOINs.
 */
function materialiseRow(hierarchy, spec, index) {
  const id = 1000 + index;
  const isTeamChange = spec.request_type === 'team_change';

  return {
    id,
    request_type: spec.request_type,
    status: spec.status,
    email_verified: spec.email_verified,
    approval_team_id: spec.approval_team_id,
    target_team_id: spec.target_team_id,
    current_team_id: spec.current_team_id,
    existing_user_id: isTeamChange ? 300 + index : null,
    initiated_by: isTeamChange ? 400 + index : null,
    team_name: spec.target_team_id === null ? null : hierarchy.teams.get(spec.target_team_id).name,
    source_team_name:
      spec.current_team_id === null ? null : hierarchy.teams.get(spec.current_team_id).name,
    callsign_suffix: null,
    requested_first_name: null,
    requested_last_name: null,
    requester_first_name: `Init${index}`,
    requester_last_name: `Admin${index}`,
    // Requirement 4.3's enrichment payload, as the LEFT JOINs on
    // `existing_user_id` and `initiated_by` would return it.
    transferred_user_first_name: isTeamChange ? `Moved${index}` : null,
    transferred_user_last_name: isTeamChange ? `User${index}` : null,
    transferred_user_email: isTeamChange ? `moved${index}@example.com` : null,
    initiated_by_first_name: isTeamChange ? `Init${index}` : null,
    initiated_by_last_name: isTeamChange ? `Admin${index}` : null,
    created_at: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString()
  };
}

const pendingVisibilityScenarioArb = hierarchyArb({
  maxOrganisations: 2,
  minTeamsPerOrganisation: 3,
  maxTeamsPerOrganisation: 6
}).chain((hierarchy) =>
  fc.record({
    hierarchy: fc.constant(hierarchy),
    // Admin rows land at any depth, including on an Organisation root, which
    // is what makes Requirement 4.4's "an admin above the gating Team sees
    // it" case reachable.
    admins: adminPlacementArb(hierarchy),
    actorId: fc.constantFrom(...ADMIN_CANDIDATE_USER_IDS),
    // Biased towards false: the Global_Manager branch returns everything
    // without consulting admin status at all, so an unbiased draw would
    // spend half the runs never exercising the filter.
    actorIsGlobalManager: fc.oneof(
      { arbitrary: fc.constant(false), weight: 4 },
      { arbitrary: fc.constant(true), weight: 1 }
    ),
    rowSpecs: fc.array(rowSpecArb(hierarchy), { minLength: 1, maxLength: 8 })
  })
);

describe('GET /api/requests/pending visibility (task 12.3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    Team.isAdmin.mockReset();
    Team.getAncestorChain.mockReset();
    pool.query.mockReset();
  });

  // Feature: team-member-transfer, Property 14: Pending-request visibility equals the reference admin computation
  test.prop([pendingVisibilityScenarioArb], { numRuns: 100 })(
    'returns exactly the reference visible set for every hierarchy, admin placement, and request_type/status/email_verified combination, with every team_change row fully enriched',
    async ({ hierarchy, admins, actorId, actorIsGlobalManager, rowSpecs }) => {
      // `beforeEach` runs once per TEST, not once per generated run, so the
      // previous iteration's call records are cleared here.
      jest.clearAllMocks();

      const rows = rowSpecs.map((spec, index) => materialiseRow(hierarchy, spec, index));

      // Postgres stand-in. The route's own WHERE clause is asserted first,
      // then applied here, so the status/email_verified half of the filter
      // is simulated rather than taken on trust.
      pool.query.mockImplementation(async (sql) => {
        expect(sql).toContain("ar.status = 'pending'");
        expect(sql).toContain('ar.email_verified = true');
        return {
          rows: rows.filter((row) => row.status === 'pending' && row.email_verified === true)
        };
      });

      Team.isAdmin.mockImplementation(async (teamId, userId) =>
        simulateTeamIsAdmin(hierarchy, admins.membershipRows, teamId, userId)
      );
      Team.getAncestorChain.mockImplementation(async (teamId) =>
        hierarchy.ancestorChainOf(Number(teamId))
      );

      mockCurrentUser = {
        id: `authentik-${actorId}`,
        userId: actorId,
        is_global_manager: actorIsGlobalManager
      };

      const expectedRows = referenceVisibleRows(rows, admins, actorId, actorIsGlobalManager);

      const res = await request(buildApp()).get('/api/requests/pending');

      expect(res.status).toBe(200);
      // Requirements 4.1, 4.2, 4.4: the returned set is exactly the
      // reference set, in the query's order.
      expect(res.body.requests.map((row) => row.id)).toEqual(expectedRows.map((row) => row.id));

      // Requirement 4.2: admin status is only ever asked about a gating
      // Team, and only on the filtered branch.
      if (actorIsGlobalManager) {
        expect(Team.isAdmin).not.toHaveBeenCalled();
      } else {
        const consultedTeamIds = Team.isAdmin.mock.calls.map(([teamId]) => teamId);
        const gatingTeamIds = new Set(
          rows
            .filter((row) => row.status === 'pending' && row.email_verified === true)
            .map(referenceGatingTeamId)
            .filter((teamId) => teamId !== null)
        );
        expect(new Set(consultedTeamIds)).toEqual(gatingTeamIds);
        // Requirement 4.4: `Team.isAdmin` is called with the caller's LOCAL
        // `users.id`, which is what `team_memberships.user_id` references.
        Team.isAdmin.mock.calls.forEach(([, userId]) => expect(userId).toBe(actorId));
      }

      // Requirement 4.3: every returned `team_change` row carries both
      // hierarchy paths, the Transferred_User's name and email, and the
      // Initiating_Admin's name.
      const returnedById = new Map(res.body.requests.map((row) => [row.id, row]));
      expectedRows
        .filter((row) => row.request_type === 'team_change')
        .forEach((expectedRow) => {
          const returned = returnedById.get(expectedRow.id);
          expect(returned.source_team_path).toBe(
            referenceTeamPath(hierarchy, expectedRow.current_team_id, expectedRow.source_team_name)
          );
          expect(returned.team_path).toBe(
            referenceTeamPath(hierarchy, expectedRow.target_team_id, expectedRow.team_name)
          );
          expect(returned.transferred_user_first_name).toBe(
            expectedRow.transferred_user_first_name
          );
          expect(returned.transferred_user_last_name).toBe(expectedRow.transferred_user_last_name);
          expect(returned.transferred_user_email).toBe(expectedRow.transferred_user_email);
          expect(returned.initiated_by_first_name).toBe(expectedRow.initiated_by_first_name);
          expect(returned.initiated_by_last_name).toBe(expectedRow.initiated_by_last_name);
        });
    }
  );
});
