// Feature: takserver-enrollment, Property 14: Team_Owned_Device enrollment is permitted exactly for a Team_Admin of the device's Ancestor_Chain or a Global_Manager
//
// **Validates: Requirements 3.6, 3.8, 3.11, 14.5**

/**
 * takserver-enrollment task 8.10: the single fast-check property test for
 * design.md's Property 14 (Requirements 3.6, 3.8, 3.11, 14.5).
 *
 * `Team.isAdmin` is mocked (not the real recursive-CTE SQL -- that walk is
 * independently validated by `Team.test.js`'s own Property 4) but its
 * MOCKED implementation faithfully re-derives the same
 * "direct (`inherited_from_team_id IS NULL`), `role='admin'` membership on
 * `teamId` or any ancestor of it" rule directly against a generated
 * `parentMap`/`memberships` pair, exactly mirroring the pattern
 * `Team.test.js`'s Property 4 already established (`ancestorsOf` +
 * `hasDirectAdmin`). This keeps the property about
 * `DeviceEnrollmentService`'s authorization WIRING -- does it call
 * `Team.isAdmin` with the right team id, does it short-circuit for a
 * Global_Manager, does it deny otherwise -- rather than re-testing
 * `Team.isAdmin`'s own SQL a second time.
 *
 * ## The two entry points this property compares
 *
 * `DeviceEnrollmentService.generateEnrollmentQrCode` is called BOTH
 * directly (as a plain function call) AND through the real HTTP route
 * (`POST /api/devices/:deviceUserId/qr-code`, mounted for real via
 * `supertest`, with the REAL `server/middleware/authorize.js` and the REAL
 * `server/config/permissions.registry.js` -- neither mocked). This is
 * deliberate: `device:manage` is a STATIC grant sitting in
 * `roleDefaults.authenticated_user`, so the route layer's own permission
 * check passes for ANY authenticated user regardless of team-admin status
 * -- the route by itself enforces nothing team-scoped. The only thing
 * standing between an arbitrary authenticated user and an enrollment token
 * is `DeviceEnrollmentService.assertAuthorized`'s check INSIDE the service,
 * reached identically whether the caller came through the route or called
 * the service directly (Criterion 3.11's defence-in-depth clause). If the
 * two entry points ever disagreed, this property would catch it before a
 * route-only permission check could be mistaken for a real gate.
 *
 * ## Boundary concentration
 *
 * `depth` (the device's Team_Depth, i.e. hops from the Organisation) is
 * drawn from three weighted arms: exactly 0 (the device belongs directly
 * to the Organisation), exactly `MAX_TEAM_DEPTH` (5, the deepest legal
 * Sub_Team), and a broad uniform arm over the whole 0..MAX_TEAM_DEPTH
 * range -- so the property is not boundary-only, per the two-boundary
 * `Team.test.js`/`UserProvisioningService.pseudonymousUsername.property.test.js`
 * convention already established in this codebase.
 *
 * Four FORCED boundary cases, each toggled independently per run, so the
 * two cases the task calls out explicitly as "a naive `role = 'admin'`
 * check gets wrong" are exercised on a meaningful share of runs rather
 * than left to chance:
 *   - `forceOwnDirectAdmin`: a direct admin row on the device's OWN team
 *     -> must permit.
 *   - `forceAncestorDirectAdmin` (depth > 0 only): a direct admin row on
 *     an ANCESTOR of the device's team -> must permit (Organisation-admin
 *     case).
 *   - `forceInheritedOnlyOwn`: an INHERITED-ONLY (`direct: false`) admin
 *     row on the device's own team -> must NOT permit by itself.
 *   - `forceSiblingDirectAdmin`: a direct admin row on an unrelated
 *     SIBLING branch (a Team that shares an ancestor with the device's
 *     team but is not itself an ancestor) -> must NOT permit by itself.
 *
 * ## Anti-vacuity
 *
 * A module-level `seen` counter records every category of outcome this
 * property exists to distinguish; the trailing `it()` asserts each is
 * `> 0`, so a generator that happened to never produce (for example) the
 * sibling-branch-denial case would fail the suite rather than silently
 * pass while proving nothing about it.
 */

const mockAuthState = { user: null };

jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockAuthState.user;
    next();
  }
}));

jest.mock('../../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

jest.mock('../../models/Team', () => ({
  isAdmin: jest.fn(),
  getAncestorChain: jest.fn()
}));

jest.mock('../../models/User', () => ({
  findById: jest.fn()
}));

jest.mock('../TeamMembershipService', () => ({
  addUserToTeam: jest.fn()
}));

jest.mock('../EventPublisher', () => ({
  publishOperation: jest.fn()
}));

jest.mock('../authentik', () => ({
  createUser: jest.fn(),
  createAppPasswordToken: jest.fn()
}));

jest.mock('../userAttributes', () => ({
  generateCallsign: jest.fn()
}));

jest.mock('qrcode', () => ({
  toDataURL: jest.fn(),
  toBuffer: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const express = require('express');
const request = require('supertest');

const pool = require('../../config/database');
const Team = require('../../models/Team');
const authentikService = require('../authentik');
const QRCode = require('qrcode');
const UserAttributesService = require('../userAttributes');
const DeviceEnrollmentService = require('../DeviceEnrollmentService');
const { DeviceEnrollmentAuthorizationError } = require('../DeviceEnrollmentService');
const { MAX_TEAM_DEPTH } = require('../../config/constants');

// Real router, real authorize.js, real permissions.registry.js -- only the
// database, the auth middleware's identity injection, Team, and the
// Authentik/QR/attribute boundaries are mocked. Built once: an Express app
// carries no per-request state, so it is safe to reuse across every run.
const devicesRouter = require('../../routes/devices');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/devices', devicesRouter);
  return app;
}

const app = buildApp();

const DEVICE_USER_ID = 42;
const DEVICE_ROW = {
  id: DEVICE_USER_ID,
  username: 'AUK-D7K3QMX',
  authentik_user_id: 987,
  is_team_device: true,
  tak_role: null
};

const ACTING_USER_IDS = [201, 202, 203];
const OTHER_USER_IDS = [301, 302, 303];
const SIBLING_TEAM_ID = 9999;

const ORIGINAL_TAK_SERVER_URL = process.env.TAK_SERVER_URL;

beforeAll(() => {
  process.env.TAK_SERVER_URL = 'https://tak.example.com:8443';
});

afterAll(() => {
  if (ORIGINAL_TAK_SERVER_URL === undefined) {
    delete process.env.TAK_SERVER_URL;
  } else {
    process.env.TAK_SERVER_URL = ORIGINAL_TAK_SERVER_URL;
  }
});

/**
 * Walks `teamId`'s ancestors (including itself), via `parentMap`, exactly
 * as `Team.test.js`'s Property 4 does -- the shared definition every
 * `Team.isAdmin` mock implementation and this file's own expectation are
 * both re-derived from.
 */
function ancestorsOf(teamId, parentMap) {
  const chain = [];
  let current = teamId;
  while (current !== null && current !== undefined) {
    chain.push(current);
    current = parentMap.get(current);
  }
  return chain;
}

/**
 * `Team.isAdmin`'s own rule, re-derived independently: true iff `userId`
 * holds a DIRECT (`direct: true`, i.e. `inherited_from_team_id IS NULL`),
 * `role: 'admin'` membership on `teamId` or any of its ancestors. An
 * inherited-only (`direct: false`) row on an ancestor never counts.
 */
function hasDirectAdmin(ancestors, userId, memberships) {
  const ancestorSet = new Set(ancestors);
  return memberships.some(
    (m) => ancestorSet.has(m.teamId) && m.userId === userId && m.role === 'admin' && m.direct
  );
}

const depthArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant(0) },
  { weight: 2, arbitrary: fc.constant(MAX_TEAM_DEPTH) },
  { weight: 4, arbitrary: fc.integer({ min: 0, max: MAX_TEAM_DEPTH }) }
);

const noiseMembershipArb = fc.record({
  placement: fc.constantFrom('chain', 'sibling'),
  chainIndexRaw: fc.nat(),
  userId: fc.constantFrom(...ACTING_USER_IDS, ...OTHER_USER_IDS),
  role: fc.constantFrom('admin', 'member'),
  direct: fc.boolean()
});

const scenarioArb = fc.record({
  depth: depthArb,
  isGlobalManager: fc.boolean(),
  actingUserId: fc.constantFrom(...ACTING_USER_IDS),
  siblingParentIndexRaw: fc.nat(),
  ancestorIndexRaw: fc.nat(),
  forceOwnDirectAdmin: fc.boolean(),
  forceAncestorDirectAdmin: fc.boolean(),
  forceInheritedOnlyOwn: fc.boolean(),
  forceSiblingDirectAdmin: fc.boolean(),
  noiseMemberships: fc.array(noiseMembershipArb, { maxLength: 10 })
});

const seen = {
  permittedGlobalManager: 0,
  permittedOwnDirect: 0,
  permittedAncestorDirect: 0,
  deniedInheritedOnly: 0,
  deniedSibling: 0,
  deniedNoRelation: 0
};

describe("Property 14: Team_Owned_Device enrollment is permitted exactly for a Team_Admin of the device's Ancestor_Chain or a Global_Manager", () => {
  test.prop([scenarioArb], { numRuns: 200 })(
    'grants an enrollment iff the acting user is a Global_Manager or holds a direct admin row on the device team or an ancestor, denying an inherited-only row and a sibling-branch admin, identically through the route and the service',
    async (scenario) => {
      const {
        depth,
        isGlobalManager,
        actingUserId,
        siblingParentIndexRaw,
        ancestorIndexRaw,
        forceOwnDirectAdmin,
        forceAncestorDirectAdmin,
        forceInheritedOnlyOwn,
        forceSiblingDirectAdmin,
        noiseMemberships
      } = scenario;

      // --- Build the generated Ancestor_Chain (root-first) and a sibling
      // branch hanging off an arbitrary ancestor (or the device's own
      // parent, when siblingParentIndexRaw lands on `depth` itself). ---
      const chainTeamIds = Array.from({ length: depth + 1 }, (_, i) => i + 1);
      const deviceTeamId = chainTeamIds[depth];
      const parentMap = new Map();
      chainTeamIds.forEach((id, i) => parentMap.set(id, i === 0 ? null : chainTeamIds[i - 1]));

      const siblingParentIndex = siblingParentIndexRaw % chainTeamIds.length;
      const siblingParentId = chainTeamIds[siblingParentIndex];
      parentMap.set(SIBLING_TEAM_ID, siblingParentId);

      const memberships = noiseMemberships.map((m) => ({
        teamId: m.placement === 'chain' ? chainTeamIds[m.chainIndexRaw % chainTeamIds.length] : SIBLING_TEAM_ID,
        userId: m.userId,
        role: m.role,
        direct: m.direct
      }));

      if (forceOwnDirectAdmin) {
        memberships.push({ teamId: deviceTeamId, userId: actingUserId, role: 'admin', direct: true });
      }
      if (forceAncestorDirectAdmin && depth > 0) {
        const ancestorIndex = ancestorIndexRaw % depth; // strictly above the device's own team
        memberships.push({ teamId: chainTeamIds[ancestorIndex], userId: actingUserId, role: 'admin', direct: true });
      }
      if (forceInheritedOnlyOwn) {
        memberships.push({ teamId: deviceTeamId, userId: actingUserId, role: 'admin', direct: false });
      }
      if (forceSiblingDirectAdmin) {
        memberships.push({ teamId: SIBLING_TEAM_ID, userId: actingUserId, role: 'admin', direct: true });
      }

      // --- Independent expectation, re-derived from the generated
      // hierarchy/memberships alone -- never by calling back into the
      // service or into `Team.isAdmin`. ---
      const deviceAncestors = ancestorsOf(deviceTeamId, parentMap);
      const expectedPermitted = isGlobalManager || hasDirectAdmin(deviceAncestors, actingUserId, memberships);

      // --- Wire the mocks for this run. ---
      Team.isAdmin.mockReset();
      Team.isAdmin.mockImplementation(async (teamId, userId) =>
        hasDirectAdmin(ancestorsOf(teamId, parentMap), userId, memberships)
      );

      pool.query.mockReset();
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('FROM users WHERE id')) {
          return Promise.resolve({ rows: [DEVICE_ROW] });
        }
        if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
          return Promise.resolve({ rows: [{ team_id: deviceTeamId }] });
        }
        if (typeof sql === 'string' && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ count: '0' }] });
        }
        if (typeof sql === 'string' && sql.includes('INSERT INTO audit_logs')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      authentikService.createAppPasswordToken.mockReset();
      authentikService.createAppPasswordToken.mockResolvedValue({
        identifier: 'device-enrollment-xyz',
        expires: '2024-01-01T00:30:00.000Z',
        key: 'super-secret-app-password'
      });
      QRCode.toDataURL.mockReset();
      QRCode.toDataURL.mockResolvedValue('data:image/png;base64,mock');
      UserAttributesService.generateCallsign.mockReset();
      UserAttributesService.generateCallsign.mockResolvedValue(null);

      const actingUser = { userId: actingUserId, is_global_manager: isGlobalManager };

      // --- Entry point 1: calling the service directly. ---
      Team.isAdmin.mockClear();
      let directOutcome;
      try {
        const result = await DeviceEnrollmentService.generateEnrollmentQrCode(DEVICE_USER_ID, actingUser);
        directOutcome = { permitted: true, result };
      } catch (error) {
        directOutcome = { permitted: false, error };
      }
      if (isGlobalManager) {
        // A Global_Manager short-circuits assertAuthorized: Team.isAdmin
        // is never consulted at all (Criterion 3.6).
        expect(Team.isAdmin).not.toHaveBeenCalled();
      }

      // --- Entry point 2: the real HTTP route. ---
      Team.isAdmin.mockClear();
      mockAuthState.user = actingUser;
      const res = await request(app).post(`/api/devices/${DEVICE_USER_ID}/qr-code`).send({});
      const routePermitted = res.status === 200;
      if (isGlobalManager) {
        expect(Team.isAdmin).not.toHaveBeenCalled();
      }

      // --- The iff, and the defence-in-depth agreement between the two
      // entry points. ---
      expect(directOutcome.permitted).toBe(expectedPermitted);
      expect(routePermitted).toBe(expectedPermitted);
      expect(directOutcome.permitted).toBe(routePermitted);

      if (expectedPermitted) {
        expect(directOutcome.result).toBeDefined();
        expect(res.status).toBe(200);
        expect(res.body.qrCode).toBeDefined();
      } else {
        expect(directOutcome.error).toBeInstanceOf(DeviceEnrollmentAuthorizationError);
        expect(res.status).toBe(403);
      }

      // --- Anti-vacuity bookkeeping. ---
      if (expectedPermitted) {
        if (isGlobalManager) {
          seen.permittedGlobalManager += 1;
        }
        if (!isGlobalManager && forceOwnDirectAdmin) {
          seen.permittedOwnDirect += 1;
        }
        if (!isGlobalManager && forceAncestorDirectAdmin && depth > 0) {
          seen.permittedAncestorDirect += 1;
        }
      } else {
        if (forceInheritedOnlyOwn) {
          seen.deniedInheritedOnly += 1;
        }
        if (forceSiblingDirectAdmin) {
          seen.deniedSibling += 1;
        }
        if (!forceInheritedOnlyOwn && !forceSiblingDirectAdmin) {
          seen.deniedNoRelation += 1;
        }
      }
    }
  );

  it('exercised every category this property distinguishes: Global_Manager, own-team direct admin, ancestor direct admin, inherited-only denial, sibling-branch denial, and unrelated denial (anti-vacuity)', () => {
    expect(seen.permittedGlobalManager).toBeGreaterThan(0);
    expect(seen.permittedOwnDirect).toBeGreaterThan(0);
    expect(seen.permittedAncestorDirect).toBeGreaterThan(0);
    expect(seen.deniedInheritedOnly).toBeGreaterThan(0);
    expect(seen.deniedSibling).toBeGreaterThan(0);
    expect(seen.deniedNoRelation).toBeGreaterThan(0);
  });
});
