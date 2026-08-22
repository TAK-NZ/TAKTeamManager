/**
 * Unit tests for the Requirement 13.7 403 logging branches added to
 * `authorize()` (server/middleware/authorize.js).
 *
 * Requirement 13.7: "IF a request to the App fails authorization (403) or
 * authentication (401), THEN THE App SHALL log that failure with the
 * requesting IP address, the requested route, and the reason for the
 * failure, to support security monitoring."
 *
 * Covers the three distinct 403 reasons `authorize()` can produce:
 *   - `no_registry_entry`: the route+method has no Permission_Registry
 *     entry at all (deny-by-default, Requirement 24.4).
 *   - `permission_denied`: a registry entry exists but neither the user's
 *     base permission set nor any row-scoped resolver satisfies it.
 *   - `resolver_exception`: a row-scoped resolver (e.g. `Team.isAdmin`)
 *     throws, which is treated as denied (fail closed, Requirement 4.3/4.6)
 *     and logged with the more specific `resolver_exception` reason rather
 *     than the generic `permission_denied` fallback.
 *
 * `server/config/permissions.registry.js` is mocked with a small,
 * self-contained registry (rather than the full production registry) so
 * each case can be constructed precisely, and `../models/Team` is mocked
 * to control whether `Team.isAdmin` resolves or throws.
 */

const mockWarn = jest.fn();
const mockError = jest.fn();

jest.mock('./requestContext', () => ({
  getLogger: () => ({ warn: mockWarn, error: mockError })
}));

const mockIsAdmin = jest.fn();
jest.mock('../models/Team', () => ({
  isAdmin: (...args) => mockIsAdmin(...args)
}));

jest.mock('../config/database', () => ({ query: jest.fn() }));

const mockIsVisibleBranch = jest.fn();
jest.mock('../services/TeamVisibilityService', () => ({
  isVisibleBranch: (...args) => mockIsVisibleBranch(...args)
}));

jest.mock('../config/permissions.registry', () => {
  // Minimal, self-contained stand-in for the real `resolveAccess`, matching
  // its deny-by-default / wildcard-satisfies-everything behavior so this
  // test file doesn't depend on the full production registry.
  function resolveAccess(routeKey, userPermissions, registry) {
    const required = registry && registry.routes ? registry.routes[routeKey] : undefined;
    if (!required) {
      return false;
    }
    const held = userPermissions instanceof Set ? userPermissions : new Set(userPermissions || []);
    if (held.has('*')) {
      return true;
    }
    return required.every((permission) => held.has(permission));
  }

  return {
    routes: {
      'GET /api/widgets': ['widget:read'],
      'PUT /api/teams/:teamId': ['team:update'],
      'POST /api/teams/:teamId/members': ['team:members:add'],
      'PATCH /api/teams/:teamId/members/:userId': ['team:members:edit'],
      'GET /api/teams/:teamId': ['team:read'],
      // team-member-transfer Requirement 2.1 (task 3.1's real registry
      // entry, mirrored here so this file's self-contained stand-in
      // registry can exercise the `user:team:transfer` resolver).
      'POST /api/users/:userId/transfer': ['user:team:transfer'],
      // team-member-transfer Requirement 5 (task 3.5): the two entries
      // these identifiers already hold in the production registry,
      // mirrored here so the shared `request:approve` / `request:deny`
      // resolver can be exercised through the middleware.
      'POST /api/requests/:requestId/approve': ['request:approve'],
      'POST /api/requests/:requestId/deny': ['request:deny'],
      // The three user-directory LISTING routes, mirrored from the
      // production registry so the `user:read:team_admin` resolver can be
      // exercised through the middleware. All three share one entry and
      // one resolver.
      'GET /api/users': ['user:read:team_admin'],
      'GET /api/users/search': ['user:read:team_admin'],
      'GET /api/users/available': ['user:read:team_admin']
    },
    roleDefaults: {
      global_manager: ['*'],
      authenticated_user: []
    },
    resolveAccess
  };
});

const express = require('express');
const request = require('supertest');
const authorize = require('./authorize');
// The same mocked `{ query: jest.fn() }` object `authorize.js` holds at
// module scope, so a test can drive the `user:team:transfer` resolver's
// Direct_Membership lookup.
const pool = require('../config/database');

const TEST_IP = '203.0.113.9';

function buildApp(user) {
  const app = express();
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.get('/api/no-such-route-entry', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/widgets', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.put('/api/teams/:teamId', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/teams/:teamId/members', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.patch('/api/teams/:teamId/members/:userId', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/teams/:teamId', authorize, (req, res) => res.status(200).json({ ok: true }));
  // `express.json()` is mounted on this route only (rather than app-wide)
  // so the existing suites above keep their exact current middleware
  // chain; the `user:team:transfer` resolver reads `req.body.targetTeamId`
  // and therefore needs a parsed body, matching production where
  // `express.json()` runs before any route middleware.
  app.post(
    '/api/users/:userId/transfer',
    express.json(),
    authorize,
    (req, res) => res.status(200).json({ ok: true })
  );
  // team-member-transfer Requirement 5 (task 3.5). Both routes carry the
  // same shared resolver, so both are mounted and every assertion below
  // runs against each of them.
  app.post('/api/requests/:requestId/approve', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/requests/:requestId/deny', authorize, (req, res) => res.status(200).json({ ok: true }));
  // The three user-directory listing routes gated by
  // `user:read:team_admin`. All three carry the same registry entry and
  // resolver, so all three are mounted and every assertion below runs
  // against each of them.
  app.get('/api/users', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/users/search', authorize, (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/users/available', authorize, (req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('authorize (Requirement 13.7 logging)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs {ip, route, reason: "no_registry_entry"} and returns 403 when the route has no registry entry', async () => {
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .get('/api/no-such-route-entry')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload, message] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/no-such-route-entry',
      reason: 'no_registry_entry'
    });
    expect(message).toMatch(/Authorization denied/i);
  });

  it('logs reason: "permission_denied" and returns 403 when a registry entry exists but is not satisfied', async () => {
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).get('/api/widgets').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/widgets',
      reason: 'permission_denied'
    });
  });

  it('logs reason: "resolver_exception" and returns 403 when a row-scoped resolver throws (fail closed)', async () => {
    mockIsAdmin.mockRejectedValueOnce(new Error('db connection lost'));
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .put('/api/teams/42')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/teams/42',
      reason: 'resolver_exception'
    });
    // The underlying exception is also logged at `error` level with full
    // context (actorId/resourceId/errorCategory), separate from the
    // Requirement 13.7 warn-level {ip, route, reason} line asserted above.
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError.mock.calls[0][0]).toMatchObject({
      errorCategory: 'authorization_check_exception',
      permission: 'team:update'
    });
  });

  it('does not log a failure when a row-scoped resolver grants access', async () => {
    mockIsAdmin.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .put('/api/teams/42')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('does not log a failure for a global manager (wildcard permission)', async () => {
    const app = buildApp({ userId: 1, is_global_manager: true });

    const res = await request(app).get('/api/widgets').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

/**
 * BUG-015: `team:members:add` had no row-scoped resolver at all, so every
 * non-global-manager team admin was denied with 403 on
 * `POST /api/teams/:teamId/members` before the route's own
 * `requireTeamAdmin` middleware ever ran. This suite mirrors the existing
 * `team:update` coverage above to confirm the resolver added in
 * `rowScopedResolvers['team:members:add']` (Global_Manager OR
 * `Team.isAdmin(:teamId, req.user.userId)`) behaves correctly.
 */
describe('authorize (BUG-015: team:members:add row-scoped resolver)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('permits a team admin (Team.isAdmin true) to POST /api/teams/:teamId/members', async () => {
    mockIsAdmin.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).post('/api/teams/42/members').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockIsAdmin).toHaveBeenCalledWith('42', 1);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('denies a non-admin, non-global-manager user with 403 permission_denied', async () => {
    mockIsAdmin.mockResolvedValueOnce(false);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).post('/api/teams/42/members').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/teams/42/members',
      reason: 'permission_denied'
    });
  });

  it('permits a Global_Manager regardless of Team.isAdmin', async () => {
    const app = buildApp({ userId: 1, is_global_manager: true });

    const res = await request(app).post('/api/teams/42/members').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockIsAdmin).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

/**
 * Task 28.2 (Requirements 4, 13.10): the `'team:members:edit'` row-scoped
 * resolver, backing `PATCH /api/teams/:teamId/members/:userId` (the
 * Member_List name/TAK_Role/callsign_suffix edit route, task 28.1).
 * Permits a Global_Manager, or a Team_Admin of `:teamId` (per
 * `Team.isAdmin`, inherited per Requirement 4) for whom `:teamId` is ALSO
 * a Visible_Branch (per `TeamVisibilityService.isVisibleBranch`,
 * Requirement 13.10) -- both conditions required for a non-Global_Manager.
 */
describe('authorize (task 28.2: team:members:edit row-scoped resolver)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('permits a Global_Manager regardless of Team.isAdmin/isVisibleBranch', async () => {
    const app = buildApp({ userId: 1, is_global_manager: true });

    const res = await request(app)
      .patch('/api/teams/42/members/7')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockIsAdmin).not.toHaveBeenCalled();
    expect(mockIsVisibleBranch).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('permits a Team_Admin (Team.isAdmin true) whose team is a Visible_Branch (isVisibleBranch true)', async () => {
    mockIsAdmin.mockResolvedValueOnce(true);
    mockIsVisibleBranch.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .patch('/api/teams/42/members/7')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockIsAdmin).toHaveBeenCalledWith('42', 1);
    expect(mockIsVisibleBranch).toHaveBeenCalledWith('42', expect.objectContaining({ userId: 1 }));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('denies (403, not 404) a Team_Admin whose team is NOT a Visible_Branch (Requirement 13.10)', async () => {
    mockIsAdmin.mockResolvedValueOnce(true);
    mockIsVisibleBranch.mockResolvedValueOnce(false);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .patch('/api/teams/42/members/7')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/teams/42/members/7',
      reason: 'permission_denied'
    });
  });

  it('denies a non-admin, non-global-manager user', async () => {
    mockIsAdmin.mockResolvedValueOnce(false);
    mockIsVisibleBranch.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .patch('/api/teams/42/members/7')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('denies when Team.isAdmin is true but isVisibleBranch is false (the Requirement 13.10 case specifically)', async () => {
    mockIsAdmin.mockResolvedValueOnce(true);
    mockIsVisibleBranch.mockResolvedValueOnce(false);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app)
      .patch('/api/teams/42/members/7')
      .set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
  });
});

/**
 * Task 14.1 (Requirement 6.1-6.4): the `'team:read'` row-scoped resolver,
 * backed by `TeamVisibilityService.isVisibleBranch`, and the targeted
 * 404-instead-of-403 mapping for a `'team:read'` denial specifically.
 *
 * `'team:read'` backs `GET /api/teams/:teamId`,
 * `GET /api/teams/:teamId/hierarchy`, `GET /api/teams/:teamId/sub-teams`,
 * and `GET /api/teams/:teamId/callsign-level-options` -- this suite only
 * mounts `GET /api/teams/:teamId` since every one of those routes shares
 * the exact same registry entry (`['team:read']`) and resolver, so testing
 * one is representative of all four.
 */
describe('authorize (task 14.1: team:read row-scoped Visible_Branch resolver)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('responds 404 (not 403) when TeamVisibilityService.isVisibleBranch returns false', async () => {
    mockIsVisibleBranch.mockResolvedValueOnce(false);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).get('/api/teams/42').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Team not found' });
    expect(mockIsVisibleBranch).toHaveBeenCalledWith('42', expect.objectContaining({ userId: 1 }));
    // Requirement 13.7 logging still fires (with the underlying
    // 'permission_denied' reason) even though the HTTP response is 404
    // rather than 403 -- only the response status/body changed, not the
    // logging behavior.
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/teams/42',
      reason: 'permission_denied'
    });
  });

  it('calls next() (200) when TeamVisibilityService.isVisibleBranch returns true', async () => {
    mockIsVisibleBranch.mockResolvedValueOnce(true);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).get('/api/teams/42').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('bypasses the resolver entirely for a Global_Manager (wildcard short-circuit)', async () => {
    const app = buildApp({ userId: 1, is_global_manager: true });

    const res = await request(app).get('/api/teams/42').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(200);
    expect(mockIsVisibleBranch).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('still responds 403 (not 404) for a DIFFERENT permission denial (team:update), confirming the 404 mapping is not applied generally', async () => {
    mockIsAdmin.mockResolvedValueOnce(false);
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).put('/api/teams/42').set('X-Forwarded-For', TEST_IP);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(mockIsVisibleBranch).not.toHaveBeenCalled();
  });

  it('denies (fail closed) when the resolver throws; per this implementation, a team:read resolver exception maps to 404, documented explicitly here', async () => {
    mockIsVisibleBranch.mockRejectedValueOnce(new Error('db connection lost'));
    const app = buildApp({ userId: 1, is_global_manager: false });

    const res = await request(app).get('/api/teams/42').set('X-Forwarded-For', TEST_IP);

    // Design choice (see authorize.js's inline comment on this branch):
    // a resolver exception for 'team:read' is treated the same as any
    // other 'team:read' denial (404), rather than the generic 403 used
    // for every other permission's resolver exception, so the client
    // still cannot distinguish "doesn't exist" from "exists but errored
    // checking access".
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Team not found' });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [payload] = mockWarn.mock.calls[0];
    expect(payload).toEqual({
      ip: TEST_IP,
      route: '/api/teams/42',
      reason: 'resolver_exception'
    });
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError.mock.calls[0][0]).toMatchObject({
      errorCategory: 'authorization_check_exception',
      permission: 'team:read'
    });
  });
});

/**
 * Spec `team-member-transfer`, task 3.4: the `user:team:transfer`
 * row-scoped resolver added in task 3.2, backing
 * `POST /api/users/:userId/transfer`.
 *
 * Requirement 2.2 states the grant as a three-way disjunction:
 * Global_Manager, OR Team_Admin of the Source_Team (the Team named by the
 * `:userId` param's Direct_Membership), OR Team_Admin of the
 * Destination_Team (`req.body.targetTeamId`). Requirement 2.3 is its
 * complement (403 when none of the three holds), and Requirement 2.6
 * fixes the meaning of "Team_Admin" as `Team.isAdmin`, i.e. a DIRECT
 * `role = 'admin'` row on the Team itself or anywhere in its
 * Ancestor_Chain.
 *
 * The resolver is not exported, so it is exercised the way every other
 * resolver in this file is: through `authorize` on a mounted route, with
 * 200 standing for "granted" and 403 for "denied".
 *
 * Two collaborators are mocked from the generated data:
 *   - `Team.isAdmin` is simulated by `simulateTeamIsAdmin` below, which
 *     re-implements the recursive-CTE semantics of
 *     `server/models/Team.js`'s `isAdmin` (direct admin row on the team or
 *     any ancestor) against the generated `team_memberships` rows. Its own
 *     correctness is already covered by `../models/Team.test.js`'s
 *     Property 4.
 *   - the Direct_Membership `pool.query` lookup returns the generated
 *     Source_Team, or no rows at all for a `:userId` with no
 *     Direct_Membership.
 *
 * The expectation is computed by walking the generated hierarchy directly
 * through the fixture's own `isTeamAdmin` reference computation — never by
 * calling back into `authorize`, and never through the `Team.isAdmin`
 * simulation, so the two derivations stay independent.
 */
const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const {
  hierarchyArb,
  adminPlacementArb,
  ADMIN_CANDIDATE_USER_IDS,
  TRANSFERRED_USER_ID
} = require('../services/__fixtures__/transferArbitraries');

const DIRECT_MEMBERSHIP_SQL = /FROM team_memberships[\s\S]*inherited_from_team_id IS NULL/;

/**
 * Stand-in for `Team.isAdmin`'s recursive CTE: true when `userId` holds a
 * direct (`inherited_from_team_id IS NULL`) `role = 'admin'`
 * `team_memberships` row for `teamId` or for any Team in its
 * Ancestor_Chain. Written against the generated `team_memberships` rows
 * rather than the fixture's `isTeamAdmin` helper, so the mocked
 * collaborator and the test's expectation are derived independently.
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

describe('authorize (task 3.4: user:team:transfer row-scoped resolver)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // These two mocks are shared with the suites above, which rely on
    // per-test `mockResolvedValueOnce` queues rather than a standing
    // implementation -- so any implementation installed here is removed
    // again rather than left in place for whatever runs next.
    mockIsAdmin.mockReset();
    pool.query.mockReset();
  });

  // Feature: team-member-transfer, Property 8: The transfer resolver grants exactly on the admin disjunction
  test.prop(
    [
      hierarchyArb({ maxOrganisations: 2, maxTeamsPerOrganisation: 6 }).chain((hierarchy) =>
        fc.record({
          hierarchy: fc.constant(hierarchy),
          admins: adminPlacementArb(hierarchy),
          actorId: fc.constantFrom(...ADMIN_CANDIDATE_USER_IDS),
          // Biased towards false: the Global_Manager leg short-circuits
          // the whole disjunction, so an unbiased draw would spend half
          // the runs never reaching the two admin legs at all.
          actorIsGlobalManager: fc.oneof(
            { arbitrary: fc.constant(false), weight: 4 },
            { arbitrary: fc.constant(true), weight: 1 }
          ),
          // `null` = the Transferred_User holds no Direct_Membership, so
          // there is no Source_Team leg to grant on.
          sourceTeamId: fc.oneof(
            { arbitrary: fc.constantFrom(...hierarchy.teamIds), weight: 5 },
            { arbitrary: fc.constant(null), weight: 1 }
          ),
          destinationTeamId: fc.constantFrom(...hierarchy.teamIds)
        })
      )
    ],
    { numRuns: 100 }
  )(
    'grants a transfer attempt if and only if the requesting user is a Global_Manager, a Team_Admin of the Source_Team, or a Team_Admin of the Destination_Team',
    async ({ hierarchy, admins, actorId, actorIsGlobalManager, sourceTeamId, destinationTeamId }) => {
      mockIsAdmin.mockImplementation(async (teamId, userId) =>
        simulateTeamIsAdmin(hierarchy, admins.membershipRows, teamId, userId)
      );
      pool.query.mockImplementation(async (sql, params) => {
        expect(sql).toMatch(DIRECT_MEMBERSHIP_SQL);
        // The resolver must look the Direct_Membership up for the
        // Transferred_User named by `:userId`, not for the actor.
        expect(String(params[0])).toBe(String(TRANSFERRED_USER_ID));
        return { rows: sourceTeamId === null ? [] : [{ team_id: sourceTeamId }] };
      });

      // Reference computation: the Requirement 2.2 disjunction, walked
      // straight off the generated hierarchy and admin placement.
      const expectedGranted =
        actorIsGlobalManager ||
        admins.isTeamAdmin(destinationTeamId, actorId) ||
        (sourceTeamId !== null && admins.isTeamAdmin(sourceTeamId, actorId));

      const app = buildApp({ userId: actorId, is_global_manager: actorIsGlobalManager });

      const res = await request(app)
        .post(`/api/users/${TRANSFERRED_USER_ID}/transfer`)
        .send({ targetTeamId: destinationTeamId });

      expect(res.status).toBe(expectedGranted ? 200 : 403);
      if (!expectedGranted) {
        // Requirement 2.3: the denial is the generic 403, never the
        // `team:read`-only 404 mapping.
        expect(res.body).toEqual({ error: 'Forbidden' });
      }
    }
  );

  /**
   * Requirement 17.1's four named examples, stated as concrete cases
   * alongside the property above. Source_Team 11 and Destination_Team 22
   * sit in unrelated hierarchies here, so a grant can only come from the
   * leg each example names.
   */
  describe('Requirement 17.1 examples', () => {
    const SOURCE_TEAM_ID = 11;
    const DESTINATION_TEAM_ID = 22;
    const ACTOR_ID = 201;

    /** Mocks the Direct_Membership lookup as naming SOURCE_TEAM_ID. */
    function mockDirectMembership() {
      pool.query.mockImplementation(async () => ({ rows: [{ team_id: SOURCE_TEAM_ID }] }));
    }

    /** `Team.isAdmin` true for exactly the given team ids, for ACTOR_ID. */
    function mockAdminOf(...teamIds) {
      mockIsAdmin.mockImplementation(async (teamId, userId) =>
        Number(userId) === ACTOR_ID && teamIds.includes(Number(teamId))
      );
    }

    function attemptTransfer(user) {
      return request(buildApp(user))
        .post(`/api/users/${TRANSFERRED_USER_ID}/transfer`)
        .send({ targetTeamId: DESTINATION_TEAM_ID })
        .set('X-Forwarded-For', TEST_IP);
    }

    it('returns true for a Global_Manager, without consulting either Team or the database', async () => {
      mockDirectMembership();
      mockAdminOf();

      const res = await attemptTransfer({ userId: ACTOR_ID, is_global_manager: true });

      expect(res.status).toBe(200);
      expect(mockIsAdmin).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('returns true for a Team_Admin of the Source_Team', async () => {
      mockDirectMembership();
      mockAdminOf(SOURCE_TEAM_ID);

      const res = await attemptTransfer({ userId: ACTOR_ID, is_global_manager: false });

      expect(res.status).toBe(200);
      // The Source_Team leg is reached only via the `:userId` param's
      // Direct_Membership, and `Team.isAdmin` is asked about that team
      // with the LOCAL users.id.
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(mockIsAdmin).toHaveBeenCalledWith(SOURCE_TEAM_ID, ACTOR_ID);
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('returns true for a Team_Admin of the Destination_Team', async () => {
      mockDirectMembership();
      mockAdminOf(DESTINATION_TEAM_ID);

      const res = await attemptTransfer({ userId: ACTOR_ID, is_global_manager: false });

      expect(res.status).toBe(200);
      expect(mockIsAdmin).toHaveBeenCalledWith(DESTINATION_TEAM_ID, ACTOR_ID);
      // The destination leg needs no Direct_Membership lookup at all.
      expect(pool.query).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('returns false (403) for a user who is a Team_Admin of neither side', async () => {
      mockDirectMembership();
      mockAdminOf();

      const res = await attemptTransfer({ userId: ACTOR_ID, is_global_manager: false });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
      expect(mockIsAdmin).toHaveBeenCalledWith(DESTINATION_TEAM_ID, ACTOR_ID);
      expect(mockIsAdmin).toHaveBeenCalledWith(SOURCE_TEAM_ID, ACTOR_ID);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      const [payload] = mockWarn.mock.calls[0];
      expect(payload).toEqual({
        ip: TEST_IP,
        route: `/api/users/${TRANSFERRED_USER_ID}/transfer`,
        reason: 'permission_denied'
      });
    });
  });
});

/**
 * Task 3.5 (spec `team-member-transfer`): the shared `request:approve` /
 * `request:deny` row-scoped resolver, `resolveRequestActionPermission` in
 * `server/middleware/authorize.js`.
 *
 * The whole point of the resolver is that ONE `access_requests` column
 * gates the check and which column that is depends only on
 * `request_type`, so every row generated below carries three DISTINCT,
 * non-interchangeable team ids in `approval_team_id`, `target_team_id`,
 * and `current_team_id`. Consulting the wrong column therefore changes
 * the observable outcome instead of accidentally agreeing with the right
 * one — which is what makes Requirements 5.2, 5.3, and 5.4 separable at
 * all.
 *
 * As in the task 3.4 suite above, the expectation is computed by walking
 * the generated hierarchy through the fixture's own `isTeamAdmin`
 * reference computation, while the mocked `Team.isAdmin` collaborator
 * runs the independent `simulateTeamIsAdmin` walk over the generated
 * `team_memberships` rows.
 */
const ACCESS_REQUEST_ROW_SQL =
  /SELECT[\s\S]*request_type[\s\S]*approval_team_id[\s\S]*target_team_id[\s\S]*current_team_id[\s\S]*FROM access_requests/;

/** The four `request_type` values Requirements 5.2-5.4 name. */
const GATED_REQUEST_TYPES = ['team_change', 'new_account', 'role_change', 'name_change'];

/**
 * `request_type` values no criterion names. A row can hold one either
 * because a future type lands without a resolver update or because the
 * column is null, and Property 15 requires both to deny.
 */
const UNGATED_REQUEST_TYPES = ['channel_change', 'org_interest', '', null];

/**
 * Requirements 5.2/5.3/5.4 as a reference computation over the row's own
 * column values — deliberately written as a lookup table rather than as
 * the implementation's `switch`, so the test states the mapping
 * independently of how the code expresses it.
 */
const GATING_COLUMN_BY_REQUEST_TYPE = {
  team_change: 'approval_team_id',
  new_account: 'target_team_id',
  role_change: 'current_team_id',
  name_change: 'current_team_id'
};

function expectedGatingTeamId(row) {
  const column = GATING_COLUMN_BY_REQUEST_TYPE[row.request_type];
  if (!column) {
    return null;
  }
  const value = row[column];
  return value === null || value === undefined ? null : value;
}

describe('authorize (task 3.5: request:approve / request:deny gating column resolver)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    mockIsAdmin.mockReset();
    pool.query.mockReset();
  });

  // Feature: team-member-transfer, Property 15: The gating column is determined solely by request type
  test.prop(
    [
      hierarchyArb({
        maxOrganisations: 2,
        minTeamsPerOrganisation: 3,
        maxTeamsPerOrganisation: 6
      }).chain((hierarchy) =>
        fc.record({
          hierarchy: fc.constant(hierarchy),
          admins: adminPlacementArb(hierarchy),
          actorId: fc.constantFrom(...ADMIN_CANDIDATE_USER_IDS),
          requestId: fc.integer({ min: 1, max: 99999 }),
          // Both identifiers share one implementation, so each run drives
          // whichever of the two routes it draws.
          action: fc.constantFrom('approve', 'deny'),
          requestType: fc.oneof(
            { arbitrary: fc.constantFrom(...GATED_REQUEST_TYPES), weight: 4 },
            { arbitrary: fc.constantFrom(...UNGATED_REQUEST_TYPES), weight: 1 }
          ),
          // Three DISTINCT team ids, one per gating-candidate column, so
          // reading the wrong column is observable. Each column is
          // independently nullable: a legacy `team_change` row predating
          // the `approval_team_id` migration holds NULL there, and a
          // `new_account` row holds NULL in `current_team_id`.
          columnTeamIds: fc.uniqueArray(fc.constantFrom(...hierarchy.teamIds), {
            minLength: 3,
            maxLength: 3
          }),
          columnsNull: fc.tuple(
            fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 }),
            fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 }),
            fc.oneof({ arbitrary: fc.constant(false), weight: 4 }, { arbitrary: fc.constant(true), weight: 1 })
          )
        })
      )
    ],
    { numRuns: 100 }
  )(
    'consults admin status against exactly the one team the request type selects, and denies when that column names no team',
    async ({
      hierarchy,
      admins,
      actorId,
      requestId,
      action,
      requestType,
      columnTeamIds,
      columnsNull
    }) => {
      // `beforeEach` runs once per TEST, not once per generated run, so
      // the call records of the previous iteration are cleared here — the
      // "exactly one Team consulted" assertion below counts calls.
      jest.clearAllMocks();

      const row = {
        request_type: requestType,
        approval_team_id: columnsNull[0] ? null : columnTeamIds[0],
        target_team_id: columnsNull[1] ? null : columnTeamIds[1],
        current_team_id: columnsNull[2] ? null : columnTeamIds[2]
      };

      mockIsAdmin.mockImplementation(async (teamId, userId) =>
        simulateTeamIsAdmin(hierarchy, admins.membershipRows, teamId, userId)
      );
      pool.query.mockImplementation(async (sql, params) => {
        expect(sql).toMatch(ACCESS_REQUEST_ROW_SQL);
        expect(String(params[0])).toBe(String(requestId));
        return { rows: [row] };
      });

      // Reference computation: the gating column per Requirements
      // 5.2-5.4, then Team_Admin status for that ONE team, walked
      // straight off the generated hierarchy and admin placement.
      const gatingTeamId = expectedGatingTeamId(row);
      const expectedGranted = gatingTeamId !== null && admins.isTeamAdmin(gatingTeamId, actorId);

      const app = buildApp({ userId: actorId, is_global_manager: false });

      const res = await request(app).post(`/api/requests/${requestId}/${action}`);

      expect(res.status).toBe(expectedGranted ? 200 : 403);
      if (!expectedGranted) {
        // Requirement 5.6: the denial stays the generic 403; nothing here
        // is in `PERMISSION_DENIALS_MAPPED_TO_404`.
        expect(res.body).toEqual({ error: 'Forbidden' });
      }

      if (gatingTeamId === null) {
        // "against no Team at all": an unrecognised or absent
        // `request_type`, or a NULL gating column, is decided without
        // consulting any Team.
        expect(mockIsAdmin).not.toHaveBeenCalled();
      } else {
        // Exactly one Team is consulted, and it is the one the request
        // type selects — never one of the other two columns' teams.
        expect(mockIsAdmin).toHaveBeenCalledTimes(1);
        expect(mockIsAdmin).toHaveBeenCalledWith(gatingTeamId, actorId);
      }
    }
  );

  /**
   * The two named examples of Requirements 5.1 and 5.5, stated as
   * concrete cases beside the property, and run against BOTH identifiers
   * because both are backed by the one resolver.
   */
  describe.each([['approve'], ['deny']])('POST /api/requests/:requestId/%s', (action) => {
    const REQUEST_ID = 7788;

    function act(user) {
      return request(buildApp(user))
        .post(`/api/requests/${REQUEST_ID}/${action}`)
        .set('X-Forwarded-For', TEST_IP);
    }

    // Requirement 5.1
    it('grants a Global_Manager without looking the access_requests row up at all', async () => {
      // Standing implementations that would DENY if they were reached, so
      // a passing assertion can only mean the short-circuit fired.
      pool.query.mockImplementation(async () => ({ rows: [] }));
      mockIsAdmin.mockImplementation(async () => false);

      const res = await act({ userId: 201, is_global_manager: true });

      expect(res.status).toBe(200);
      expect(pool.query).not.toHaveBeenCalled();
      expect(mockIsAdmin).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    // Requirement 5.5
    it('returns false (403) when :requestId names no access_requests row', async () => {
      pool.query.mockImplementation(async () => ({ rows: [] }));
      mockIsAdmin.mockImplementation(async () => true);

      const res = await act({ userId: 201, is_global_manager: false });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
      expect(pool.query).toHaveBeenCalledTimes(1);
      // No row means no gating team, so admin status is never consulted —
      // not even against a team the actor does administer.
      expect(mockIsAdmin).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledTimes(1);
      const [payload] = mockWarn.mock.calls[0];
      expect(payload).toEqual({
        ip: TEST_IP,
        route: `/api/requests/${REQUEST_ID}/${action}`,
        reason: 'permission_denied'
      });
    });
  });
});

/**
 * The `user:read:team_admin` row-scoped resolver, backing the three
 * user-directory LISTING routes (`GET /api/users`,
 * `GET /api/users/search`, `GET /api/users/available`).
 *
 * Those three previously required a plain `user:read` that also sat in
 * `roleDefaults.authenticated_user`, so `resolveAccess` permitted them
 * outright for every authenticated user -- a plain non-admin team member
 * could enumerate the whole user directory (names, emails) and the pool of
 * unassigned users. The resolver restricts them to a Global_Manager or a
 * Team_Admin of ANY team.
 *
 * Unlike the other `:team_admin` resolvers exercised above, this one is
 * NOT row-scoped: there is no target row on a listing route, so the check
 * is "administers something", expressed as a single existence query
 * against `team_memberships` rather than a `Team.isAdmin` call -- which is
 * why `mockIsAdmin` is asserted to stay untouched throughout.
 *
 * `simulateAdminMembershipLookup` below stands in for the database: it
 * applies the resolver's own predicate to a fixture set of
 * `team_memberships` rows, but applies each clause ONLY if that clause is
 * actually present in the SQL the resolver issued. So dropping
 * `inherited_from_team_id IS NULL` from the query makes the
 * inherited-admin case return a row and its test fail, rather than the
 * test silently agreeing with a looser implementation.
 */
const ADMIN_MEMBERSHIP_EXISTS_SQL = /SELECT 1[\s\S]*FROM team_memberships[\s\S]*user_id = \$1/;

/**
 * Installs a `pool.query` implementation over `membershipRows`, asserting
 * the resolver's query shape and returning whichever rows the SQL's own
 * clauses select for `params[0]`.
 *
 * @param {Array<{user_id: number, role: string, inherited_from_team_id: number|null}>} membershipRows
 */
function simulateAdminMembershipLookup(membershipRows) {
  pool.query.mockImplementation(async (sql, params) => {
    expect(sql).toMatch(ADMIN_MEMBERSHIP_EXISTS_SQL);

    const filtersOnAdminRole = sql.includes("role = 'admin'");
    const filtersOnDirectMembership = sql.includes('inherited_from_team_id IS NULL');

    const rows = membershipRows.filter(
      (row) =>
        String(row.user_id) === String(params[0]) &&
        (!filtersOnAdminRole || row.role === 'admin') &&
        (!filtersOnDirectMembership || row.inherited_from_team_id === null)
    );

    return { rows: rows.map(() => ({ '?column?': 1 })) };
  });
}

describe('authorize (user:read:team_admin resolver for the user-directory listing routes)', () => {
  // The LOCAL users.id, and a deliberately different Authentik id, so a
  // resolver reading the wrong one is observable.
  const LOCAL_USER_ID = 1;
  const AUTHENTIK_ID = 9001;

  const LISTING_PATHS = ['/api/users', '/api/users/search', '/api/users/available'];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Shared with the suites above, which rely on per-test
    // `mockResolvedValueOnce` queues rather than standing implementations.
    mockIsAdmin.mockReset();
    pool.query.mockReset();
  });

  describe.each(LISTING_PATHS)('GET %s', (path) => {
    function list(user) {
      return request(buildApp(user)).get(path).set('X-Forwarded-For', TEST_IP);
    }

    it('permits a Global_Manager without issuing the admin-membership query at all', async () => {
      // A standing implementation that would DENY if it were reached, so a
      // passing assertion can only mean the short-circuit fired.
      simulateAdminMembershipLookup([]);

      const res = await list({ id: AUTHENTIK_ID, userId: LOCAL_USER_ID, is_global_manager: true });

      expect(res.status).toBe(200);
      expect(pool.query).not.toHaveBeenCalled();
      expect(mockIsAdmin).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('permits a user holding a direct role=admin membership', async () => {
      simulateAdminMembershipLookup([
        { user_id: LOCAL_USER_ID, role: 'admin', inherited_from_team_id: null }
      ]);

      const res = await list({ id: AUTHENTIK_ID, userId: LOCAL_USER_ID, is_global_manager: false });

      expect(res.status).toBe(200);
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(mockIsAdmin).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('looks the membership up by the LOCAL users.id (req.user.userId), never the Authentik id', async () => {
      simulateAdminMembershipLookup([
        { user_id: LOCAL_USER_ID, role: 'admin', inherited_from_team_id: null }
      ]);

      await list({ id: AUTHENTIK_ID, userId: LOCAL_USER_ID, is_global_manager: false });

      const [, params] = pool.query.mock.calls[0];
      expect(params).toEqual([LOCAL_USER_ID]);
      expect(params).not.toContain(AUTHENTIK_ID);
    });

    it('denies a user holding only a member (non-admin) membership', async () => {
      simulateAdminMembershipLookup([
        { user_id: LOCAL_USER_ID, role: 'member', inherited_from_team_id: null }
      ]);

      const res = await list({ id: AUTHENTIK_ID, userId: LOCAL_USER_ID, is_global_manager: false });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
      expect(mockWarn).toHaveBeenCalledTimes(1);
      const [payload] = mockWarn.mock.calls[0];
      expect(payload).toEqual({ ip: TEST_IP, route: path, reason: 'permission_denied' });
    });

    it('denies a user whose only admin row is INHERITED (non-null inherited_from_team_id)', async () => {
      // Pins the stricter `inherited_from_team_id IS NULL` filter, i.e. the
      // glossary's Team_Admin, matching Team.isAdmin's own predicate --
      // rather than auth.js /auth/me's looser `role = 'admin'` alone.
      simulateAdminMembershipLookup([
        { user_id: LOCAL_USER_ID, role: 'admin', inherited_from_team_id: 42 }
      ]);

      const res = await list({ id: AUTHENTIK_ID, userId: LOCAL_USER_ID, is_global_manager: false });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
    });

    it('denies a user with no memberships at all', async () => {
      simulateAdminMembershipLookup([]);

      const res = await list({ id: AUTHENTIK_ID, userId: LOCAL_USER_ID, is_global_manager: false });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('denies a user whose admin row belongs to somebody else', async () => {
      simulateAdminMembershipLookup([
        { user_id: LOCAL_USER_ID + 1, role: 'admin', inherited_from_team_id: null }
      ]);

      const res = await list({ id: AUTHENTIK_ID, userId: LOCAL_USER_ID, is_global_manager: false });

      expect(res.status).toBe(403);
    });
  });
});
