/**
 * Integration tests for `GET /api/teams/my-teams` (Requirement 11.4:
 * pagination applied to the admin "all teams" case).
 *
 * These exercise the actual mounted route via `supertest`, mocking
 * `Team.getAllTeams`/`Team.getTeamCount`/`Team.getUserTeams` to verify:
 *
 *  - An out-of-range `pageSize` is rejected with 400 before any `Team.*`
 *    call runs.
 *  - The admin branch passes the resolved `pageSize`/`offset` through to
 *    `Team.getAllTeams` and echoes pagination metadata in the response.
 *  - The non-admin branch calls `Team.getUserTeams` and is unaffected by
 *    pagination (no `pagination` field in the response, `Team.getAllTeams`
 *    never called).
 *
 * `authenticateToken`/`authorize` are mocked to bypass real JWT/DB-backed
 * authorization, since this test is scoped to the `GET /my-teams`
 * handler's pagination behavior, not the authorization middleware chain
 * (already covered elsewhere).
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../models/Team', () => {
  // Requirement 2.3 (task 5.2) / 5.2, 5.6 (task 8.2): these typed error
  // classes are pulled from the REAL module (via jest.requireActual,
  // which bypasses this very mock) so `error instanceof
  // Team.TeamDepthExceededError`/`Team.CallsignLevelSelectionRangeError`/
  // `Team.CallsignLevelSelectionSubTeamError` in the route handler under
  // test behave identically to production, rather than jest.fn()
  // stand-in classes that `instanceof` could never match.
  const {
    TeamDepthExceededError,
    CallsignLevelSelectionRangeError,
    CallsignLevelSelectionSubTeamError,
    PseudonymousUsernamePolicySubTeamError,
    PseudonymousUsernamePolicyImmutableError,
    ChannelTierAccessSubTeamError,
    OrganisationCallsignPrefixImmutableError,
    CallsignPrefixConflictError,
    TeamNameConflictError
  } = jest.requireActual('../models/Team');
  return {
    getAllTeams: jest.fn(),
    getTeamCount: jest.fn(),
    getJoinableTeams: jest.fn(),
    getJoinableTeamsCount: jest.fn(),
    getUserTeams: jest.fn(),
    getSubTeamsForCallsignLevel: jest.fn(),
    getSubTeams: jest.fn(),
    getAncestorChain: jest.fn(),
    getOrganisationTeams: jest.fn(),
    getManagedTeamIds: jest.fn(),
    findById: jest.fn(),
    getMembers: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    getSubtreeMemberDeviceCounts: jest.fn(),
    deleteWithSubtree: jest.fn(),
    delete: jest.fn(),
    TeamDepthExceededError,
    CallsignLevelSelectionRangeError,
    CallsignLevelSelectionSubTeamError,
    PseudonymousUsernamePolicySubTeamError,
    PseudonymousUsernamePolicyImmutableError,
    ChannelTierAccessSubTeamError,
    OrganisationCallsignPrefixImmutableError,
    CallsignPrefixConflictError,
    TeamNameConflictError
  };
});

// Requirement 6.5 (task 14.2): GET /:teamId/sub-teams filters its result
// list through TeamVisibilityService.filterVisibleBranches -- mocked
// here so the route test below is scoped to confirming the route calls
// it and uses its return value, not TeamVisibilityService's own
// filtering logic (covered separately by TeamVisibilityService.test.js).
jest.mock('../services/TeamVisibilityService', () => ({
  filterVisibleBranches: jest.fn()
}));

let mockIsAdmin = true;

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, isAdmin: mockIsAdmin, is_global_manager: mockIsAdmin };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

// PUT /:teamId/channel-access enqueues a resync_org_channel_tier_access
// Sync_Operation via EventPublisher.publishOperation -- mocked here so
// tests can assert enqueue/no-enqueue behavior without touching a real
// sync_operations table (EventPublisher.publishOperation itself writes
// through `pool`, which is already mocked above).
jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue('op-id')
}));

// Requirement 5.12 (task 11.6) / 13.6 (task 28.1): PUT /api/teams/:teamId
// and PATCH /api/teams/:teamId/members/:userId both require
// `../services/userAttributes` inline inside their handlers (not at
// module load time), but jest.mock still intercepts that require
// regardless of when it happens, so this mock lets the tests below
// assert whether `updateTeamUserAttributes`/`updateUserAttributes` was
// (or wasn't) triggered by a given update.
// Bugfix (callsign-handling): PATCH /:teamId/members/:userId now also
// calls generateCallsign to recompute the assembled tak_callsign after a
// callsign_suffix edit. Defaults to null (the "nothing to persist" path)
// so every EXISTING test below that doesn't care about this behavior is
// unaffected; the dedicated describe block further down overrides it.
jest.mock('../services/userAttributes', () => ({
  updateTeamUserAttributes: jest.fn().mockResolvedValue(true),
  updateUserAttributes: jest.fn().mockResolvedValue(true),
  generateCallsign: jest.fn().mockResolvedValue(null)
}));

// Requirement 11.4, 13.2 (task 28.1): PATCH /api/teams/:teamId/members/:userId
// looks up the target user via `User.findById` and writes via
// `User.update`.
jest.mock('../models/User', () => ({
  findById: jest.fn(),
  update: jest.fn()
}));

// Requirement 11.16 (task 28.1): callsign_suffix uniqueness is checked
// via the shared `checkCallsignSuffixUniqueness` function before any
// write.
jest.mock('../services/CallsignSuffixUniquenessService', () => {
  const { CallsignSuffixConflictError } = jest.requireActual('../services/CallsignSuffixUniquenessService');
  return {
    checkCallsignSuffixUniqueness: jest.fn().mockResolvedValue(undefined),
    CallsignSuffixConflictError
  };
});

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const Team = require('../models/Team');
const User = require('../models/User');
const TeamVisibilityService = require('../services/TeamVisibilityService');
const { checkCallsignSuffixUniqueness, CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
const EventPublisher = require('../services/EventPublisher');
const teamsRouter = require('./teams');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/teams', teamsRouter);
  return app;
}

describe('GET /api/teams/my-teams pagination (Requirement 11.4)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
    // Bugfix (re-parent authorization gap, client-side follow-up): every
    // /my-teams branch now also resolves Team.getManagedTeamIds for a
    // non-Global_Manager to annotate each row's `can_manage`. This suite
    // is scoped to pagination, not can_manage itself (see the dedicated
    // describe block below), so default to an empty Set here.
    Team.getManagedTeamIds.mockResolvedValue(new Set());
  });

  describe('admin "all teams" branch', () => {
    it('returns 400 for an out-of-range pageSize before calling Team.getAllTeams', async () => {
      const res = await request(app).get('/api/teams/my-teams').query({ pageSize: 500 });

      expect(res.status).toBe(400);
      expect(Team.getAllTeams).not.toHaveBeenCalled();
      expect(Team.getTeamCount).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-numeric page before calling Team.getAllTeams', async () => {
      const res = await request(app).get('/api/teams/my-teams').query({ page: 'abc' });

      expect(res.status).toBe(400);
      expect(Team.getAllTeams).not.toHaveBeenCalled();
    });

    it('passes the resolved pageSize/offset through to Team.getAllTeams and echoes pagination metadata', async () => {
      Team.getAllTeams.mockResolvedValue([{ id: 1, name: 'Team A' }]);
      Team.getTeamCount.mockResolvedValue(42);

      const res = await request(app).get('/api/teams/my-teams').query({ page: 2, pageSize: 5 });

      expect(res.status).toBe(200);
      // page=2, pageSize=5 -> offset = (2-1)*5 = 5
      expect(Team.getAllTeams).toHaveBeenCalledWith(5, 5);
      expect(res.body.pagination).toEqual({ page: 2, pageSize: 5, total: 42 });
      // mockIsAdmin=true means req.user.is_global_manager is also true
      // (see the shared authenticateToken mock above), so can_manage is
      // true for every row with no Team.getManagedTeamIds query at all.
      expect(res.body.teams).toEqual([{ id: 1, name: 'Team A', can_manage: true }]);
    });

    it('defaults to page 1 / pageSize 50 when no query params are supplied', async () => {
      Team.getAllTeams.mockResolvedValue([]);
      Team.getTeamCount.mockResolvedValue(0);

      const res = await request(app).get('/api/teams/my-teams');

      expect(res.status).toBe(200);
      expect(Team.getAllTeams).toHaveBeenCalledWith(50, 0);
      expect(res.body.pagination).toEqual({ page: 1, pageSize: 50, total: 0 });
    });
  });

  describe('non-admin branch', () => {
    beforeEach(() => {
      mockIsAdmin = false;
    });

    it('calls org-scoped team resolution and never Team.getAllTeams, with no pagination metadata in the response', async () => {
      // Non-admin branch uses resolveOwnOrganisationTeams + filterVisibleBranches
      pool.query.mockResolvedValue({ rows: [{ team_id: 5 }] });
      Team.getAncestorChain.mockResolvedValue([{ id: 1, parent_team_id: null }]);
      const orgTeams = [{ id: 2, name: 'My Team', parent_team_id: null, visibility: 'public' }];
      Team.getOrganisationTeams.mockResolvedValue(orgTeams);
      TeamVisibilityService.filterVisibleBranches.mockResolvedValue(orgTeams);
      Team.getManagedTeamIds.mockResolvedValue(new Set([2]));

      const res = await request(app).get('/api/teams/my-teams').query({ page: 3, pageSize: 10 });

      expect(res.status).toBe(200);
      expect(Team.getAllTeams).not.toHaveBeenCalled();
      expect(res.body.teams).toEqual([{ ...orgTeams[0], can_manage: true }]);
      expect(res.body.pagination).toBeUndefined();
    });

    it('still validates pagination query params even though the branch does not use req.pagination', async () => {
      const res = await request(app).get('/api/teams/my-teams').query({ pageSize: 500 });

      expect(res.status).toBe(400);
      expect(Team.getUserTeams).not.toHaveBeenCalled();
    });
  });
});

/**
 * Performance-hardening: `GET /api/teams/joinable` (public, no auth) was
 * previously fully unbounded -- no pagination applied at all. It now uses
 * the same shared `paginationParams` middleware as `GET /my-teams`'s
 * admin branch above, mirroring that same request/response contract.
 */
describe('GET /api/teams/joinable pagination (performance-hardening)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns 400 for an out-of-range pageSize before calling Team.getJoinableTeams', async () => {
    const res = await request(app).get('/api/teams/joinable').query({ pageSize: 500 });

    expect(res.status).toBe(400);
    expect(Team.getJoinableTeams).not.toHaveBeenCalled();
    expect(Team.getJoinableTeamsCount).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-numeric page before calling Team.getJoinableTeams', async () => {
    const res = await request(app).get('/api/teams/joinable').query({ page: 'abc' });

    expect(res.status).toBe(400);
    expect(Team.getJoinableTeams).not.toHaveBeenCalled();
  });

  it('passes the resolved pageSize/offset through to Team.getJoinableTeams and echoes pagination metadata', async () => {
    Team.getJoinableTeams.mockResolvedValue([{ id: 1, name: 'Team A', display_name: 'Team A' }]);
    Team.getJoinableTeamsCount.mockResolvedValue(42);

    const res = await request(app).get('/api/teams/joinable').query({ page: 2, pageSize: 5 });

    expect(res.status).toBe(200);
    // page=2, pageSize=5 -> offset = (2-1)*5 = 5
    expect(Team.getJoinableTeams).toHaveBeenCalledWith(5, 5);
    expect(res.body.pagination).toEqual({ page: 2, pageSize: 5, total: 42 });
    expect(res.body.teams).toEqual([{ id: 1, name: 'Team A', display_name: 'Team A' }]);
  });

  it('defaults to page 1 / pageSize 50 when no query params are supplied', async () => {
    Team.getJoinableTeams.mockResolvedValue([]);
    Team.getJoinableTeamsCount.mockResolvedValue(0);

    const res = await request(app).get('/api/teams/joinable');

    expect(res.status).toBe(200);
    expect(Team.getJoinableTeams).toHaveBeenCalledWith(50, 0);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 50, total: 0 });
  });

  it('is reachable without authentication (no authenticateToken/authorize gate)', async () => {
    Team.getJoinableTeams.mockResolvedValue([]);
    Team.getJoinableTeamsCount.mockResolvedValue(0);

    // buildApp() mounts the real router with no auth middleware bypass
    // needed -- this route runs unauthenticated in production too (see
    // publicRoutes.js), so simply not sending any credential is the
    // correct test shape here.
    const res = await request(app).get('/api/teams/joinable');

    expect(res.status).toBe(200);
  });

  it('returns 500 without leaking the underlying error when Team.getJoinableTeams rejects', async () => {
    Team.getJoinableTeams.mockRejectedValue(new Error('db unavailable'));
    Team.getJoinableTeamsCount.mockResolvedValue(0);

    const res = await request(app).get('/api/teams/joinable');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch joinable teams');
  });
});

/**
 * Integration tests for `GET /api/teams/my-teams?scope=organisation`
 * (Requirement 6.6, task 14.3).
 *
 * This is additive to the existing pagination behavior tested above:
 * when `scope=organisation` is present, the route resolves the caller's
 * own Organisation (via a direct `pool.query` lookup of one of their
 * `team_memberships` rows, then `Team.getAncestorChain`), fetches that
 * Organisation's full hierarchy via `Team.getOrganisationTeams`, and
 * filters it through `TeamVisibilityService.filterVisibleBranches`,
 * returning `{ teams: ... }` with no `pagination` field -- regardless of
 * `req.user.isAdmin`. When ABSENT, the existing admin/non-admin branches
 * are exercised unchanged (already covered above).
 */
describe('GET /api/teams/my-teams?scope=organisation (Requirement 6.6)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = false;
    app = buildApp();
    Team.getManagedTeamIds.mockResolvedValue(new Set());
  });

  it('resolves the caller\'s Organisation, fetches its hierarchy, filters via filterVisibleBranches, and returns { teams } with no pagination field', async () => {
    pool.query.mockResolvedValue({ rows: [{ team_id: 5 }] });
    const ancestorChain = [{ id: 1, parent_team_id: null }, { id: 5, parent_team_id: 1 }];
    Team.getAncestorChain.mockResolvedValue(ancestorChain);
    const orgTeams = [
      { id: 1, parent_team_id: null, visibility: 'public' },
      { id: 5, parent_team_id: 1, visibility: 'public' },
      { id: 6, parent_team_id: 1, visibility: 'private' }
    ];
    Team.getOrganisationTeams.mockResolvedValue(orgTeams);
    const filtered = [orgTeams[0], orgTeams[1]];
    TeamVisibilityService.filterVisibleBranches.mockResolvedValue(filtered);
    Team.getManagedTeamIds.mockResolvedValue(new Set([5]));

    const res = await request(app).get('/api/teams/my-teams').query({ scope: 'organisation' });

    expect(res.status).toBe(200);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(5);
    expect(Team.getOrganisationTeams).toHaveBeenCalledWith(1, null);
    expect(TeamVisibilityService.filterVisibleBranches).toHaveBeenCalledWith(
      orgTeams,
      expect.objectContaining({ userId: 1 })
    );
    expect(res.body.teams).toEqual([
      { ...filtered[0], can_manage: false },
      { ...filtered[1], can_manage: true }
    ]);
    expect(res.body.pagination).toBeUndefined();
    // The existing default-scope branches must not run.
    expect(Team.getAllTeams).not.toHaveBeenCalled();
    expect(Team.getUserTeams).not.toHaveBeenCalled();
  });

  it('returns an empty list when the caller has no team memberships at all', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    // resolveOwnOrganisationTeams short-circuits to [] before ever calling
    // Team.getOrganisationTeams, but filterVisibleBranches is still
    // invoked (with that empty array) so its own empty-input behavior is
    // exercised consistently -- mocked here since the whole service
    // module is mocked in this file.
    TeamVisibilityService.filterVisibleBranches.mockResolvedValue([]);

    const res = await request(app).get('/api/teams/my-teams').query({ scope: 'organisation' });

    expect(res.status).toBe(200);
    expect(res.body.teams).toEqual([]);
    expect(res.body.pagination).toBeUndefined();
    expect(Team.getOrganisationTeams).not.toHaveBeenCalled();
    expect(TeamVisibilityService.filterVisibleBranches).toHaveBeenCalledWith([], expect.any(Object));
  });

  it('returns an empty list for a Global_Manager with no team memberships of their own (documented fallback)', async () => {
    mockIsAdmin = true;
    pool.query.mockResolvedValue({ rows: [] });
    TeamVisibilityService.filterVisibleBranches.mockResolvedValue([]);

    const res = await request(app).get('/api/teams/my-teams').query({ scope: 'organisation' });

    expect(res.status).toBe(200);
    expect(res.body.teams).toEqual([]);
    expect(Team.getAllTeams).not.toHaveBeenCalled();
  });

  it('does not change the default (no scope) admin/non-admin behavior', async () => {
    mockIsAdmin = true;
    Team.getAllTeams.mockResolvedValue([{ id: 1, name: 'Team A' }]);
    Team.getTeamCount.mockResolvedValue(1);

    const res = await request(app).get('/api/teams/my-teams');

    expect(res.status).toBe(200);
    expect(Team.getAllTeams).toHaveBeenCalled();
    expect(res.body.pagination).toBeDefined();
    expect(TeamVisibilityService.filterVisibleBranches).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for `POST /api/teams`'s Max_Team_Depth error handling
 * (Requirement 2.3, task 5.2).
 *
 * `Team.create` is mocked directly to throw the REAL
 * `Team.TeamDepthExceededError` (task 5.1), so this test is scoped to the
 * route handler's own `instanceof` catch/response mapping, not
 * `Team.create`'s own depth-computation logic (already covered by
 * `Team.test.js`'s "Team.create Max_Team_Depth enforcement" suite).
 */
describe('POST /api/teams Max_Team_Depth error handling (Requirement 2.3)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
  });

  it('responds 400 with "Maximum team depth (5) exceeded" and creates no team when Team.create throws TeamDepthExceededError', async () => {
    Team.findById.mockResolvedValue({ id: 42, color: 'Blue' });
    Team.create.mockRejectedValue(new Team.TeamDepthExceededError());

    const res = await request(app)
      .post('/api/teams')
      .send({ name: 'Too Deep Sub-Team', parentTeamId: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Maximum team depth (5) exceeded');
    // The route must not fall through to its generic 500 handler, and
    // must not report a created team.
    expect(res.body.team).toBeUndefined();
  });

  it('propagates a non-depth error to the existing generic 500 handler unchanged', async () => {
    Team.findById.mockResolvedValue({ id: 42, color: 'Blue' });
    Team.create.mockRejectedValue(new Error('unexpected db failure'));

    const res = await request(app)
      .post('/api/teams')
      .send({ name: 'Some Team', parentTeamId: 42 });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to create team');
  });
});

/**
 * Unit tests for the tightened `callsignPrefix` validation chain on
 * `POST /api/teams` and `PUT /api/teams/:teamId` (Requirements 3.8, 3.9,
 * task 6.2). The chain now runs `isValidCallsignPrefix` (task 6.5) via
 * `.custom()`, rejecting any character outside `[A-Za-z0-9]` -- notably
 * the `-` character, which the previous `.trim()`-only rule allowed
 * through.
 */
describe('callsignPrefix character-class validation (Requirements 3.8, 3.9)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
  });

  describe('POST /api/teams', () => {
    // Foreign-partner-prefix extension: callsignPrefix now accepts one or
    // more `-`-separated alphanumeric segments (e.g. "AUS-FIRE"), so a
    // bare internal hyphen like "NZ-POL" is no longer rejected. See
    // server/utils/callsignValidation.js's header comment.
    it('accepts a callsignPrefix containing a single internal "-" (a two-segment prefix)', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'Police', callsign_prefix: 'NZ-POL' });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', callsignPrefix: 'NZ-POL' });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_prefix: 'NZ-POL' }));
    });

    // A segment matching the Managed_Identifier marker+body shape (`D`/`U`
    // followed by exactly 7 Identifier_Alphabet characters) is still
    // rejected, since it would make a minted identifier's own
    // prefix/marker boundary ambiguous. See
    // server/utils/callsignValidation.js's header comment.
    it('rejects a callsignPrefix with a segment matching the Managed_Identifier marker+body shape with 400', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', callsignPrefix: 'NZ-D2345678' });

      expect(res.status).toBe(400);
      expect(Team.create).not.toHaveBeenCalled();
    });

    it('accepts a letters+digits callsignPrefix', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'Police', callsign_prefix: 'NZP0' });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', callsignPrefix: 'NZP0' });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_prefix: 'NZP0' }));
    });

    // takserver-enrollment Criterion 2.1: an Organisation (no
    // parentTeamId) now REQUIRES a non-empty callsignPrefix. These three
    // cases used to accept a missing/empty/whitespace-only prefix on
    // Organisation creation -- that assumption is stale now that the
    // requirement is mandatory, so the assertions are updated to the new,
    // intentional behaviour rather than weakened to keep passing.
    it('rejects an omitted callsignPrefix for an Organisation with 400, naming the field', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/callsignPrefix/);
      expect(Team.create).not.toHaveBeenCalled();
    });

    it('rejects an empty-string callsignPrefix for an Organisation with 400, naming the field', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', callsignPrefix: '' });

      expect(res.status).toBe(400);
      // Criterion 2.1: the error must name the missing field, not just
      // carry a 400 status -- checked precisely (exact message), not via
      // a substring match alone, for both this and the omitted-field case
      // above.
      expect(res.body.error).toBe('callsignPrefix is required for an Organisation');
      expect(Team.create).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only callsignPrefix for an Organisation with 400, naming the field', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', callsignPrefix: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('callsignPrefix is required for an Organisation');
      expect(Team.create).not.toHaveBeenCalled();
    });

    // takserver-enrollment task 4.3 edge case: a whitespace variant other
    // than the plain U+0020 space -- a tab, a newline, and U+00A0
    // (non-breaking space) -- must be treated as empty too. JS's
    // String.prototype.trim() (used by the handler's own emptiness check)
    // and validator.js's trim() sanitizer (which runs first, as part of
    // this route's .trim() chain, and mirrors the same \s character
    // class) both strip U+00A0, so there is no divergence between the two
    // trimming points on the server for this input.
    it('rejects a callsignPrefix of only a tab, newline or non-breaking space for an Organisation with 400', async () => {
      for (const exoticWhitespace of ['\t', '\n', '\u00A0']) {
        Team.create.mockClear();
        const res = await request(app)
          .post('/api/teams')
          .send({ name: 'Police', callsignPrefix: exoticWhitespace });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('callsignPrefix is required for an Organisation');
        expect(Team.create).not.toHaveBeenCalled();
      }
    });

    // takserver-enrollment task 4.3 edge case: parentTeamId is explicitly
    // `null` (the value the Client always sends for a top-level team,
    // per this route's own comment above) rather than omitted from the
    // request body at all -- both must be treated identically as "this is
    // an Organisation, a prefix is required".
    it('rejects a missing callsignPrefix when parentTeamId is explicitly null (not merely omitted)', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', parentTeamId: null });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('callsignPrefix is required for an Organisation');
      expect(Team.create).not.toHaveBeenCalled();
    });

    // takserver-enrollment task 4.3 edge case: a bare "-" is still
    // rejected under the foreign-partner-prefix extension (it is a
    // leading AND trailing hyphen at once -- two empty segments), so it
    // never reaches Team.create, regardless of which of the two
    // independent checks (the express-validator character-class
    // .custom() chain, or the handler's own "required for an
    // Organisation" emptiness check) is the one that catches it. Asserted
    // here as the validator-chain shape (`res.body.errors`, not
    // `res.body.error`), since the character-class check runs as
    // request-shape validation BEFORE the handler body executes, so it is
    // the one that actually fires first for this input -- the emptiness
    // check never gets a chance to run.
    it('rejects a callsignPrefix of only disallowed characters ("-") via the character-class check, not the emptiness check', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', callsignPrefix: '-' });

      expect(res.status).toBe(400);
      expect(res.body.errors).toBeDefined();
      expect(res.body.error).toBeUndefined();
      expect(Team.create).not.toHaveBeenCalled();
    });

    // takserver-enrollment task 4.3 edge case: parentTeamId of `0` is a
    // falsy-but-valid-looking id. `body('parentTeamId').optional({
    // nullable: true }).isInt()` accepts 0 as a valid integer, and the
    // handler's `if (!parentTeamId)` Organisation-classification check
    // is then true for it (0 is falsy), so a request carrying
    // `parentTeamId: 0` is classified as an Organisation and REQUIRES a
    // prefix -- documented here as the current, intentional behaviour
    // rather than a misclassification bug: `teams.id` is a Postgres
    // `serial`/`integer` primary key starting at 1 (see the baseline
    // migration), so 0 can never be a real team id and this classifying
    // as "no parent" is therefore never actually ambiguous in practice.
    it('classifies parentTeamId: 0 as an Organisation (falsy, and no real team ever has id 0), requiring a prefix', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', parentTeamId: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('callsignPrefix is required for an Organisation');
      expect(Team.create).not.toHaveBeenCalled();
    });

    // Criterion 2.3: a Sub_Team's prefix stays optional exactly as it is
    // today -- the requirement applies to Organisations only.
    it('accepts an omitted callsignPrefix for a Sub_Team', async () => {
      Team.findById.mockResolvedValue({ id: 9, color: 'Blue', parent_team_id: null });
      Team.create.mockResolvedValue({ id: 2, name: 'Sub', parent_team_id: 9 });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Sub', parentTeamId: 9 });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalled();
    });
  });

  describe('PUT /api/teams/:teamId', () => {
    beforeEach(() => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: null });
    });

    // Foreign-partner-prefix extension: callsignPrefix now accepts one or
    // more `-`-separated alphanumeric segments (e.g. "AUS-FIRE"), so a
    // bare internal hyphen like "NZ-POL" is no longer rejected on edit
    // either.
    it('accepts a callsignPrefix containing a single internal "-" (a two-segment prefix) on edit', async () => {
      Team.update.mockResolvedValue({ id: 42, callsign_prefix: 'NZ-POL' });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignPrefix: 'NZ-POL' });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalled();
    });

    // A segment matching the Managed_Identifier marker+body shape is
    // still rejected on edit too.
    it('rejects a callsignPrefix with a segment matching the Managed_Identifier marker+body shape with 400 on edit', async () => {
      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignPrefix: 'NZ-D2345678' });

      expect(res.status).toBe(400);
      expect(Team.update).not.toHaveBeenCalled();
    });

    // takserver-enrollment task 4.3 edge case: a bare "-" is still
    // rejected under the foreign-partner-prefix extension (a leading AND
    // trailing hyphen at once). It is caught by the character-class
    // .custom() validator (a validation error, `res.body.errors`) rather
    // than ever reaching the handler's own "cannot be cleared" emptiness
    // check (`res.body.error`) -- the character-class check runs as
    // request-shape validation before the handler body, so it fires
    // first regardless of the emptiness rule existing at all.
    it('rejects a callsignPrefix of only disallowed characters ("-") on edit via the character-class check, not the emptiness check', async () => {
      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignPrefix: '-' });

      expect(res.status).toBe(400);
      expect(res.body.errors).toBeDefined();
      expect(res.body.error).toBeUndefined();
      expect(Team.update).not.toHaveBeenCalled();
    });

    it('accepts a letters+digits callsignPrefix', async () => {
      Team.update.mockResolvedValue({ id: 42, callsign_prefix: 'NZP0' });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignPrefix: 'NZP0' });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalled();
    });

    // takserver-enrollment Criterion 2.2: an omitted callsignPrefix on an
    // edit means "not supplied on this request", not "clear it" -- the
    // existing value is left unchanged. This is unaffected by the
    // requirement becoming mandatory, so the assertion is unchanged.
    it('accepts an omitted callsignPrefix', async () => {
      Team.update.mockResolvedValue({ id: 42 });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalled();
    });

    // Criterion 2.2: an explicit empty-string callsignPrefix on an
    // Organisation edit now means "clear it", which the requirement
    // rejects. This assumption is stale now that the field is mandatory
    // and is updated to the new, intentional behaviour.
    it('rejects an empty-string callsignPrefix on an Organisation edit with 400, naming the field', async () => {
      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignPrefix: '' });

      expect(res.status).toBe(400);
      // Criterion 2.1's "naming the missing field" requirement extends to
      // the edit path's own distinct message (Criterion 2.2), checked
      // precisely rather than by substring alone.
      expect(res.body.error).toBe('callsignPrefix is required for an Organisation and cannot be cleared');
      expect(Team.update).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only callsignPrefix on an Organisation edit with 400, naming the field', async () => {
      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignPrefix: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('callsignPrefix is required for an Organisation and cannot be cleared');
      expect(Team.update).not.toHaveBeenCalled();
    });

    // takserver-enrollment task 4.3 edge case: exotic whitespace (tab,
    // newline, non-breaking space) on the edit path, mirroring the
    // create-path assertion above -- confirms no divergence between the
    // two call sites' identical `typeof callsignPrefix === 'string' ?
    // callsignPrefix.trim() : callsignPrefix` treatment.
    it('rejects a callsignPrefix of only a tab, newline or non-breaking space on an Organisation edit with 400', async () => {
      for (const exoticWhitespace of ['\t', '\n', '\u00A0']) {
        Team.update.mockClear();
        const res = await request(app)
          .put('/api/teams/42')
          .send({ callsignPrefix: exoticWhitespace });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('callsignPrefix is required for an Organisation and cannot be cleared');
        expect(Team.update).not.toHaveBeenCalled();
      }
    });

    it('accepts an edit leaving a non-empty callsignPrefix unchanged', async () => {
      Team.update.mockResolvedValue({ id: 42, callsign_prefix: 'NZP0' });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignPrefix: 'NZP0' });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalled();
    });

    // Criterion 2.3: a Sub_Team's prefix stays optional -- clearing it on
    // a Sub_Team edit is still accepted.
    it('accepts an empty-string callsignPrefix on a Sub_Team edit', async () => {
      Team.findById.mockResolvedValue({ id: 43, color: 'Blue', parent_team_id: 9 });
      Team.update.mockResolvedValue({ id: 43, callsign_prefix: '' });

      const res = await request(app)
        .put('/api/teams/43')
        .send({ callsignPrefix: '' });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalled();
    });

    // takserver-enrollment task 4.3 edge case: re-parenting a Sub_Team to
    // become an Organisation via PUT (parentTeamId: null on a team whose
    // CURRENT parent_team_id is non-null). `Team.update`'s own UPDATE
    // statement sets `parent_team_id = $5` unconditionally (no guard
    // against re-parenting), so this is possible in principle -- but
    // this route's own Criterion 2.2 guard checks `team.parent_team_id
    // === null` against the PRE-update row (`Team.findById`'s result,
    // fetched before Team.update runs), not the team's prospective
    // POST-update classification. A Sub_Team with no prefix that is
    // re-parented to root therefore does NOT trip the "prefix required"
    // check here, and Team.update has no independent check of its own
    // for this case either (unlike callsign_level_selection/
    // pseudonymous_usernames, which Team.update DOES re-derive
    // Organisation-vs-Sub_Team status for on every update). This is
    // documented as a discovered gap relative to Criterion 2.1's "an
    // Organisation must have a prefix" intent -- not asserted as
    // "correct" behaviour, since the resulting row would be an
    // Organisation with an empty callsign_prefix. Retroactive enforcement
    // on re-parent was flagged during test-writing rather than silently
    // fixed, since design.md's own Criterion 2.8 discussion frames the
    // requirement as enforced "in the create and edit paths" without
    // naming re-parenting explicitly.
    it('KNOWN GAP: re-parenting a prefix-less Sub_Team to become an Organisation (parentTeamId: null) is NOT retroactively required to carry a prefix', async () => {
      Team.findById.mockResolvedValue({ id: 43, color: 'Blue', parent_team_id: 9, callsign_prefix: null });
      Team.update.mockResolvedValue({ id: 43, parent_team_id: null, callsign_prefix: null });

      const res = await request(app)
        .put('/api/teams/43')
        .send({ parentTeamId: null });

      // Current behaviour: accepted, and Team.update is reached -- the
      // Criterion 2.2 guard only fires when the team was ALREADY an
      // Organisation before this request.
      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalledWith('43', expect.objectContaining({ parent_team_id: null }));
    });
  });
});

/**
 * Integration test for `GET /api/teams/:teamId/callsign-level-options`
 * (Requirement 5.8-5.11, task 8.3).
 *
 * The route is a thin wrapper: it calls
 * `Team.getSubTeamsForCallsignLevel(req.params.teamId)` and returns its
 * result as `{ options: [...] }`. `authenticateToken`/`authorize` are
 * mocked (module-level, above) to bypass real JWT/DB-backed
 * authorization, consistent with this file's other route tests.
 */
describe('GET /api/teams/:teamId/callsign-level-options (Requirement 5.8-5.11)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
  });

  it('calls Team.getSubTeamsForCallsignLevel with :teamId and returns its result as { options }', async () => {
    const rows = [
      { team_depth: 1, callsign_prefix: 'CB' },
      { team_depth: 1, callsign_prefix: 'AUK' },
      { team_depth: 2, callsign_prefix: 'ST40' }
    ];
    Team.getSubTeamsForCallsignLevel.mockResolvedValue(rows);

    const res = await request(app).get('/api/teams/1/callsign-level-options');

    expect(res.status).toBe(200);
    expect(Team.getSubTeamsForCallsignLevel).toHaveBeenCalledWith('1');
    expect(res.body.options).toEqual(rows);
  });

  it('responds 500 when Team.getSubTeamsForCallsignLevel rejects', async () => {
    Team.getSubTeamsForCallsignLevel.mockRejectedValue(new Error('db unavailable'));

    const res = await request(app).get('/api/teams/1/callsign-level-options');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch callsign level options');
  });
});

/**
 * Unit tests for the `callsignNameFormat` enum acceptance on
 * `POST /api/teams` and `PUT /api/teams/:teamId` (Requirements 8.6, 8.7,
 * 11.5, task 6.3). The `.isIn([...])` validator chain now additionally
 * accepts `'first_initial_dot_last'` (Requirement 8.6) and `'user_defined'`
 * (Requirement 11.5) alongside the three pre-existing values, while still
 * rejecting any other value.
 */
describe('callsignNameFormat enum validation (Requirements 8.6, 8.7, 11.5)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
  });

  describe('POST /api/teams', () => {
    // takserver-enrollment Criterion 2.1: an Organisation now requires a
    // non-empty callsignPrefix, so these Organisation-creation requests
    // (no parentTeamId) carry one -- unrelated to what this describe
    // block itself is testing (callsignNameFormat's own enum
    // acceptance), but required for the request to reach Team.create at
    // all.
    it('accepts callsignNameFormat "first_initial_dot_last"', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'Org', callsign_name_format: 'first_initial_dot_last' });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Org', callsignPrefix: 'ORG', callsignNameFormat: 'first_initial_dot_last' });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_name_format: 'first_initial_dot_last' }));
    });

    it('accepts callsignNameFormat "user_defined"', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'Org', callsign_name_format: 'user_defined' });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Org', callsignPrefix: 'ORG', callsignNameFormat: 'user_defined' });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_name_format: 'user_defined' }));
    });

    it('rejects an invalid callsignNameFormat value with 400', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Org', callsignPrefix: 'ORG', callsignNameFormat: 'bogus_format' });

      expect(res.status).toBe(400);
      expect(Team.create).not.toHaveBeenCalled();
    });
  });

  describe('PUT /api/teams/:teamId', () => {
    beforeEach(() => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: null });
    });

    it('accepts callsignNameFormat "first_initial_dot_last"', async () => {
      Team.update.mockResolvedValue({ id: 42, callsign_name_format: 'first_initial_dot_last' });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignNameFormat: 'first_initial_dot_last' });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalledWith('42', expect.objectContaining({ callsign_name_format: 'first_initial_dot_last' }));
    });

    it('accepts callsignNameFormat "user_defined"', async () => {
      Team.update.mockResolvedValue({ id: 42, callsign_name_format: 'user_defined' });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignNameFormat: 'user_defined' });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalledWith('42', expect.objectContaining({ callsign_name_format: 'user_defined' }));
    });

    it('rejects an invalid callsignNameFormat value with 400', async () => {
      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignNameFormat: 'bogus_format' });

      expect(res.status).toBe(400);
      expect(Team.update).not.toHaveBeenCalled();
    });
  });
});

/**
 * Unit tests for `callsignLevelSelection` handling on `POST /api/teams`
 * and `PUT /api/teams/:teamId` (Requirements 5.1, 5.2, 5.6, task 8.2).
 *
 * `Team.create`/`Team.update` are mocked to throw the REAL typed errors
 * from task 8.1 (`CallsignLevelSelectionRangeError`/
 * `CallsignLevelSelectionSubTeamError`), so these tests are scoped to the
 * route handlers' own request-shape validation and
 * `instanceof`-catch/response mapping, not the model layer's own
 * range/Sub_Team-rejection logic (already covered by `Team.test.js`).
 */
describe('callsignLevelSelection validation (Requirements 5.1, 5.2, 5.6)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
  });

  describe('POST /api/teams', () => {
    // takserver-enrollment Criterion 2.1: an Organisation now requires a
    // non-empty callsignPrefix -- added to these Organisation-creation
    // requests (no parentTeamId) so each still reaches the
    // callsignLevelSelection validation this describe block actually
    // tests, rather than being rejected earlier for a missing prefix.
    it('rejects a non-array callsignLevelSelection with 400 before calling Team.create', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignPrefix: 'FENZ', callsignLevelSelection: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(Team.create).not.toHaveBeenCalled();
    });

    it('rejects a callsignLevelSelection with a non-integer element with 400 before calling Team.create', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignPrefix: 'FENZ', callsignLevelSelection: [1, 'two'] });

      expect(res.status).toBe(400);
      expect(Team.create).not.toHaveBeenCalled();
    });

    it('responds 400 with the exact range message when Team.create throws CallsignLevelSelectionRangeError', async () => {
      Team.create.mockRejectedValue(new Team.CallsignLevelSelectionRangeError());

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignPrefix: 'FENZ', callsignLevelSelection: [1, 2, 6] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('callsignLevelSelection values must be between 1 and 5');
      expect(res.body.team).toBeUndefined();
    });

    it('responds 400 with the exact Sub_Team message when Team.create throws CallsignLevelSelectionSubTeamError', async () => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: 1 });
      Team.create.mockRejectedValue(new Team.CallsignLevelSelectionSubTeamError());

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Sub Team', parentTeamId: 42, callsignLevelSelection: [1, 3, 5] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('callsignLevelSelection can only be set on an Organisation');
      expect(res.body.team).toBeUndefined();
    });

    it('passes a valid callsignLevelSelection through to Team.create as callsign_level_selection', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'FENZ', callsign_level_selection: [1, 3, 5] });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignPrefix: 'FENZ', callsignLevelSelection: [1, 3, 5] });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_level_selection: [1, 3, 5] }));
    });
  });

  describe('PUT /api/teams/:teamId', () => {
    beforeEach(() => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: null });
    });

    it('rejects a non-array callsignLevelSelection with 400 before calling Team.update', async () => {
      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignLevelSelection: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(Team.update).not.toHaveBeenCalled();
    });

    it('responds 400 with the exact range message when Team.update throws CallsignLevelSelectionRangeError', async () => {
      Team.update.mockRejectedValue(new Team.CallsignLevelSelectionRangeError());

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignLevelSelection: [1, 2, 6] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('callsignLevelSelection values must be between 1 and 5');
      expect(res.body.team).toBeUndefined();
    });

    it('responds 400 with the exact Sub_Team message when Team.update throws CallsignLevelSelectionSubTeamError', async () => {
      Team.update.mockRejectedValue(new Team.CallsignLevelSelectionSubTeamError());

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignLevelSelection: [1, 3, 5] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('callsignLevelSelection can only be set on an Organisation');
      expect(res.body.team).toBeUndefined();
    });

    it('passes a valid callsignLevelSelection through to Team.update as callsign_level_selection', async () => {
      Team.update.mockResolvedValue({ id: 42, callsign_level_selection: [1, 3, 5] });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignLevelSelection: [1, 3, 5] });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalledWith('42', expect.objectContaining({ callsign_level_selection: [1, 3, 5] }));
    });
  });

  /**
   * Requirement 5.12 (task 11.6): a Callsign_Level_Selection change on
   * `PUT /api/teams/:teamId` must trigger the same callsign/color
   * regeneration call (`UserAttributesService.updateTeamUserAttributes`)
   * that a `callsignNameFormat` change already triggers, WITHOUT touching
   * any user's `callsign_suffix` (verified separately, at the unit level,
   * in `userAttributes.test.js`, since `updateTeamUserAttributes` itself
   * is mocked here).
   */
  describe('regeneration trigger (Requirement 5.12)', () => {
    const UserAttributesService = require('../services/userAttributes');

    beforeEach(() => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: null });
    });

    it('calls UserAttributesService.updateTeamUserAttributes when callsignLevelSelection changes', async () => {
      Team.update.mockResolvedValue({ id: 42, callsign_level_selection: [1, 3, 5] });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignLevelSelection: [1, 3, 5] });

      expect(res.status).toBe(200);
      expect(UserAttributesService.updateTeamUserAttributes).toHaveBeenCalledWith('42');
    });

    it('calls UserAttributesService.updateTeamUserAttributes when callsignNameFormat changes (existing trigger, unaffected)', async () => {
      Team.update.mockResolvedValue({ id: 42, callsign_name_format: 'full_name' });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignNameFormat: 'full_name' });

      expect(res.status).toBe(200);
      expect(UserAttributesService.updateTeamUserAttributes).toHaveBeenCalledWith('42');
    });

    it('does NOT call UserAttributesService.updateTeamUserAttributes when neither field is present', async () => {
      Team.update.mockResolvedValue({ id: 42, name: 'Renamed' });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(UserAttributesService.updateTeamUserAttributes).not.toHaveBeenCalled();
    });
  });
});

/**
 * Unit tests for `pseudonymousUsernames` handling on `POST /api/teams`
 * and `PUT /api/teams/:teamId` (takserver-enrollment Requirements 6.1,
 * 6.2, 7.1, 7.2, task 5.4).
 *
 * `Team.create`/`Team.update` are mocked to throw the REAL typed errors
 * (`PseudonymousUsernamePolicySubTeamError`/
 * `PseudonymousUsernamePolicyImmutableError`), so these tests are scoped
 * to the route handlers' own request-shape validation and
 * `instanceof`-catch/response mapping, not the model layer's own
 * Sub_Team-rejection/immutability logic (covered separately by
 * `Team.test.js`), mirroring the callsignLevelSelection describe block
 * above exactly.
 */
describe('pseudonymousUsernames validation (takserver-enrollment Requirements 6.1, 6.2, 7.1, 7.2)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
  });

  describe('POST /api/teams', () => {
    it('rejects a non-boolean pseudonymousUsernames with 400 before calling Team.create', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignPrefix: 'FENZ', pseudonymousUsernames: 'not-a-boolean' });

      expect(res.status).toBe(400);
      expect(Team.create).not.toHaveBeenCalled();
    });

    it('responds 400 with the exact Sub_Team message when Team.create throws PseudonymousUsernamePolicySubTeamError', async () => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: 1 });
      Team.create.mockRejectedValue(new Team.PseudonymousUsernamePolicySubTeamError());

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Sub Team', parentTeamId: 42, pseudonymousUsernames: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('pseudonymousUsernames can only be set on an Organisation');
      expect(res.body.team).toBeUndefined();
    });

    it('passes a supplied pseudonymousUsernames through to Team.create as pseudonymous_usernames', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'FENZ', pseudonymous_usernames: true });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignPrefix: 'FENZ', pseudonymousUsernames: true });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ pseudonymous_usernames: true }));
    });

    it('passes undefined through to Team.create as pseudonymous_usernames when omitted, so Team.create supplies the false default', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'FENZ', pseudonymous_usernames: false });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignPrefix: 'FENZ' });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ pseudonymous_usernames: undefined }));
    });

    // takserver-enrollment Requirement 6.1/6.2 (task 5.9): the fourth of
    // the four (parent_team_id present/absent) x (pseudonymous_usernames
    // supplied/absent) combinations -- the other three (Sub_Team+supplied,
    // Organisation+absent, Organisation+supplied) are already covered by
    // the three tests immediately above. A Sub_Team creation that omits
    // pseudonymousUsernames entirely passes `undefined` through to
    // Team.create exactly like the Organisation+absent case; Team.create
    // itself (covered by Team.test.js) is what stores `null` rather than
    // defaulting to `false` for a Sub_Team. This route-level test confirms
    // the route does not special-case a Sub_Team's omitted value.
    it('passes undefined through to Team.create as pseudonymous_usernames when omitted on Sub_Team creation, and reflects Team.create\'s null result', async () => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: null });
      Team.create.mockResolvedValue({ id: 2, name: 'Sub Team', parent_team_id: 42, pseudonymous_usernames: null });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Sub Team', parentTeamId: 42 });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ pseudonymous_usernames: undefined }));
      expect(res.body.team.pseudonymous_usernames).toBeNull();
    });

    // Bugfix (callsign-handling): Team.create now throws
    // CallsignPrefixConflictError (rather than silently falling back to
    // creating the team with no prefix at all) on a duplicate
    // callsignPrefix -- this asserts the route maps it to a 400 naming
    // the conflict, mirroring PUT /:teamId's identical handling of the
    // same error from Team.update.
    it('responds 400 with the CallsignPrefixConflictError message when Team.create throws it', async () => {
      Team.create.mockRejectedValue(new Team.CallsignPrefixConflictError('STL'));

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'LandSAR', callsignPrefix: 'STL' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Callsign Prefix "STL" is already in use by another team');
      expect(res.body.team).toBeUndefined();
    });

    // Org-wide-team-name-uniqueness: Team.create throws TeamNameConflictError
    // when a new Sub_Team's name already exists elsewhere in the same
    // Organisation; the route maps it to a client-correctable 400.
    it('responds 400 with the TeamNameConflictError message when Team.create throws it', async () => {
      Team.create.mockRejectedValue(new Team.TeamNameConflictError('Auckland'));

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Auckland', parentTeamId: 2 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A team named "Auckland" already exists in this Organisation');
      expect(res.body.team).toBeUndefined();
    });
  });

  describe('PUT /api/teams/:teamId', () => {
    beforeEach(() => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: null, pseudonymous_usernames: false });
    });

    it('rejects a non-boolean pseudonymousUsernames with 400 before calling Team.update', async () => {
      const res = await request(app)
        .put('/api/teams/42')
        .send({ pseudonymousUsernames: 'not-a-boolean' });

      expect(res.status).toBe(400);
      expect(Team.update).not.toHaveBeenCalled();
    });

    it('responds 400 with the exact Sub_Team message when Team.update throws PseudonymousUsernamePolicySubTeamError', async () => {
      Team.update.mockRejectedValue(new Team.PseudonymousUsernamePolicySubTeamError());

      const res = await request(app)
        .put('/api/teams/42')
        .send({ pseudonymousUsernames: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('pseudonymousUsernames can only be set on an Organisation');
      expect(res.body.team).toBeUndefined();
    });

    it('responds 400 with the concrete-consequence message when Team.update throws PseudonymousUsernamePolicyImmutableError', async () => {
      Team.update.mockRejectedValue(new Team.PseudonymousUsernamePolicyImmutableError());

      const res = await request(app)
        .put('/api/teams/42')
        .send({ pseudonymousUsernames: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/re-enroll/);
      expect(res.body.error).toMatch(/certificate Common Name/);
      expect(res.body.team).toBeUndefined();
    });

    // Org-wide-team-name-uniqueness: Team.update throws TeamNameConflictError
    // when a rename OR a re-parent would make this team's name collide
    // with another team in the same Organisation; the route maps it to
    // a client-correctable 400.
    it('responds 400 with the TeamNameConflictError message when Team.update throws it', async () => {
      Team.update.mockRejectedValue(new Team.TeamNameConflictError('Auckland'));

      const res = await request(app)
        .put('/api/teams/42')
        .send({ name: 'Auckland' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A team named "Auckland" already exists in this Organisation');
      expect(res.body.team).toBeUndefined();
    });

    it('passes a supplied pseudonymousUsernames through to Team.update as pseudonymous_usernames', async () => {
      Team.update.mockResolvedValue({ id: 42, pseudonymous_usernames: false });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ pseudonymousUsernames: false });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalledWith('42', expect.objectContaining({ pseudonymous_usernames: false }));
    });

    // takserver-enrollment Requirement 7.2 (task 5.9): resubmitting the
    // SAME value the Organisation already has stored is accepted as a
    // no-op, not rejected -- Team.update itself (Team.test.js's "accepts
    // a resubmission of the current value on an Organisation as a no-op"
    // test) is what implements the no-op/reject branch; this route-level
    // test confirms the route's own 200 response path is reached rather
    // than the PseudonymousUsernamePolicyImmutableError catch block, when
    // Team.update resolves (rather than rejects) for a same-value
    // resubmission.
    it('accepts a same-value resubmission of pseudonymousUsernames on an existing Organisation as a no-op (200, not the immutability rejection)', async () => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: null, pseudonymous_usernames: true });
      Team.update.mockResolvedValue({ id: 42, pseudonymous_usernames: true });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ pseudonymousUsernames: true });

      expect(res.status).toBe(200);
      expect(res.body.team.pseudonymous_usernames).toBe(true);
      expect(res.body.error).toBeUndefined();
    });
  });
});

describe('PUT /api/teams/:teamId/channel-access', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('rejects a non-boolean responseChannelAccess with 400 before calling Team.update', async () => {
    const res = await request(app)
      .put('/api/teams/42/channel-access')
      .send({ responseChannelAccess: 'not-a-boolean' });

    expect(res.status).toBe(400);
    expect(Team.update).not.toHaveBeenCalled();
  });

  it('returns 404 when the target team does not exist', async () => {
    Team.findById.mockResolvedValue(null);

    const res = await request(app)
      .put('/api/teams/999/channel-access')
      .send({ responseChannelAccess: true });

    expect(res.status).toBe(404);
    expect(Team.update).not.toHaveBeenCalled();
  });

  it('rejects a Sub_Team target with 400 before calling Team.update, using the request-shape-specific message', async () => {
    Team.findById.mockResolvedValue({
      id: 5,
      parent_team_id: 1,
      response_channel_access: null,
      support_channel_access: null
    });

    const res = await request(app)
      .put('/api/teams/5/channel-access')
      .send({ responseChannelAccess: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only be set on an Organisation/);
    expect(Team.update).not.toHaveBeenCalled();
  });

  it('rejects an empty body (neither field supplied) with 400 before calling Team.update', async () => {
    Team.findById.mockResolvedValue({
      id: 42,
      parent_team_id: null,
      response_channel_access: false,
      support_channel_access: true
    });

    const res = await request(app).put('/api/teams/42/channel-access').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/At least one of/);
    expect(Team.update).not.toHaveBeenCalled();
  });

  it('responds 400 with the Sub_Team message when Team.update throws ChannelTierAccessSubTeamError (defense in depth)', async () => {
    Team.findById.mockResolvedValue({
      id: 42,
      parent_team_id: null,
      response_channel_access: false,
      support_channel_access: true
    });
    Team.update.mockRejectedValue(new Team.ChannelTierAccessSubTeamError('responseChannelAccess'));

    const res = await request(app)
      .put('/api/teams/42/channel-access')
      .send({ responseChannelAccess: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('responseChannelAccess can only be set on an Organisation');
    expect(res.body.team).toBeUndefined();
  });

  it('passes both flags through to Team.update as response_channel_access/support_channel_access', async () => {
    Team.findById.mockResolvedValue({
      id: 42,
      parent_team_id: null,
      response_channel_access: false,
      support_channel_access: false
    });
    Team.update.mockResolvedValue({
      id: 42,
      response_channel_access: true,
      support_channel_access: true
    });

    const res = await request(app)
      .put('/api/teams/42/channel-access')
      .send({ responseChannelAccess: true, supportChannelAccess: true });

    expect(res.status).toBe(200);
    expect(Team.update).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({ response_channel_access: true, support_channel_access: true })
    );
    expect(res.body.team).toEqual(
      expect.objectContaining({ response_channel_access: true, support_channel_access: true })
    );
  });

  it('enqueues a resync_org_channel_tier_access operation only for the tier that actually changed', async () => {
    Team.findById.mockResolvedValue({
      id: 42,
      parent_team_id: null,
      response_channel_access: false,
      support_channel_access: true
    });
    Team.update.mockResolvedValue({
      id: 42,
      response_channel_access: true, // changed: false -> true
      support_channel_access: true // unchanged: stays true
    });

    const res = await request(app)
      .put('/api/teams/42/channel-access')
      .send({ responseChannelAccess: true, supportChannelAccess: true });

    expect(res.status).toBe(200);
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'resync_org_channel_tier_access',
      { organisation_id: 42, tier: 'response' },
      1
    );
  });

  it('enqueues nothing when both flags are resubmitted with their current, unchanged values (no-op)', async () => {
    Team.findById.mockResolvedValue({
      id: 42,
      parent_team_id: null,
      response_channel_access: false,
      support_channel_access: true
    });
    Team.update.mockResolvedValue({
      id: 42,
      response_channel_access: false,
      support_channel_access: true
    });

    const res = await request(app)
      .put('/api/teams/42/channel-access')
      .send({ responseChannelAccess: false, supportChannelAccess: true });

    expect(res.status).toBe(200);
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('enqueues both tiers when both flags actually change', async () => {
    Team.findById.mockResolvedValue({
      id: 42,
      parent_team_id: null,
      response_channel_access: false,
      support_channel_access: true
    });
    Team.update.mockResolvedValue({
      id: 42,
      response_channel_access: true,
      support_channel_access: false
    });

    const res = await request(app)
      .put('/api/teams/42/channel-access')
      .send({ responseChannelAccess: true, supportChannelAccess: false });

    expect(res.status).toBe(200);
    expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(2);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'resync_org_channel_tier_access',
      { organisation_id: 42, tier: 'response' },
      1
    );
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'resync_org_channel_tier_access',
      { organisation_id: 42, tier: 'support' },
      1
    );
  });

  it('still returns 200 with the updated team when the enqueue itself fails (fire-and-forget, logged not thrown)', async () => {
    Team.findById.mockResolvedValue({
      id: 42,
      parent_team_id: null,
      response_channel_access: false,
      support_channel_access: true
    });
    Team.update.mockResolvedValue({
      id: 42,
      response_channel_access: true,
      support_channel_access: true
    });
    EventPublisher.publishOperation.mockRejectedValue(new Error('queue unavailable'));

    const res = await request(app)
      .put('/api/teams/42/channel-access')
      .send({ responseChannelAccess: true });

    expect(res.status).toBe(200);
    expect(res.body.team.response_channel_access).toBe(true);
  });

  it('writes an audit log entry with the resulting flag values', async () => {
    Team.findById.mockResolvedValue({
      id: 42,
      parent_team_id: null,
      response_channel_access: false,
      support_channel_access: true
    });
    Team.update.mockResolvedValue({
      id: 42,
      response_channel_access: true,
      support_channel_access: true
    });

    await request(app)
      .put('/api/teams/42/channel-access')
      .send({ responseChannelAccess: true });

    const auditCall = pool.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO audit_logs')
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[1]).toEqual([
      1,
      'team.channel_access.update',
      'team',
      42,
      JSON.stringify({ response_channel_access: true, support_channel_access: true })
    ]);
  });
});

/**
 * Structural guard, takserver-enrollment Requirement 7.1 (task 5.9): no
 * route anywhere in `server/routes/users.js` accepts a change to an
 * existing user's `username`. Requirement 7.1 requires "no interface,
 * route, or administrative action that changes an existing user's
 * username", and per task 5.4's own note there is no user-EDIT route in
 * `server/routes/users.js` today at all -- the verbs are `GET /`,
 * `GET /me`, `POST /`, `GET /search`, `GET /available`,
 * `POST /callsign-suffix-preview`, `POST /create-and-add`,
 * `POST /add-to-team`, `DELETE /remove-from-team/:userId`,
 * `POST /:userId/transfer`, `POST /:userId/resend-welcome`. Since there
 * is no route to hit with a rejection assertion, this is confirmed by a
 * STRUCTURAL ABSENCE check instead: no `router.put`/`router.patch` call
 * exists in that file at all (the only mutation verbs capable of editing
 * an existing resource in place), and `router.post` calls that touch an
 * EXISTING user (`add-to-team`, `transfer`, `resend-welcome`,
 * `remove-from-team`) accept no `username` field in their body-validation
 * chain.
 *
 * A change here that adds a PUT/PATCH route, or a POST route that reads
 * `req.body.username` for an existing user, must fail this test rather
 * than silently reopening a username-change path -- the reason a
 * standalone `describe` reads the real source file rather than mocking
 * the router.
 */
describe('server/routes/users.js has no username-change path (takserver-enrollment Requirement 7.1)', () => {
  const fs = require('fs');
  const path = require('path');
  const usersRouteSource = fs.readFileSync(
    path.join(__dirname, 'users.js'),
    'utf8'
  );

  it('defines no router.put or router.patch route at all', () => {
    expect(usersRouteSource).not.toMatch(/router\.put\(/);
    expect(usersRouteSource).not.toMatch(/router\.patch\(/);
  });

  it('the existing-user POST routes (add-to-team, transfer, resend-welcome) read no username field from the request body', () => {
    // Anti-vacuity: confirm the routes this test is scoped to actually
    // exist in the source before asserting anything about their bodies.
    expect(usersRouteSource).toContain("router.post('/add-to-team'");
    expect(usersRouteSource).toContain("router.post('/:userId/transfer'");
    expect(usersRouteSource).toContain("router.post('/:userId/resend-welcome'");

    const routeStarts = [
      "router.post('/add-to-team'",
      "router.post('/:userId/transfer'",
      "router.post('/:userId/resend-welcome'",
      "router.delete('/remove-from-team/:userId'"
    ];
    for (const marker of routeStarts) {
      const startIndex = usersRouteSource.indexOf(marker);
      expect(startIndex).toBeGreaterThan(-1);
      // Slice to the next top-level route declaration (or EOF), and
      // confirm no `body('username'` validator and no
      // `req.body.username` read appears inside that route's own
      // handler.
      const nextRouteIndex = usersRouteSource.indexOf('router.', startIndex + marker.length);
      const routeBlock = usersRouteSource.slice(
        startIndex,
        nextRouteIndex > -1 ? nextRouteIndex : usersRouteSource.length
      );
      expect(routeBlock).not.toContain("body('username'");
      expect(routeBlock).not.toContain('req.body.username');
    }
  });
});

/**
 * Integration tests for `GET /api/teams/:teamId/sub-teams` (Requirement
 * 6.5, task 14.2).
 *
 * This route's OWN access to `:teamId` is already gated by the
 * `'team:read'` row-scoped Visible_Branch check (enforced centrally via
 * the mocked `authorize` middleware -- covered separately by
 * `authorize.test.js`). What's under test here is that the CHILDREN in
 * the returned list are filtered through
 * `TeamVisibilityService.filterVisibleBranches`, so a private sub-team
 * is excluded from the response rather than causing the whole request
 * to fail.
 */
describe('GET /api/teams/:teamId/sub-teams (Requirement 6.5)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
  });

  it('calls filterVisibleBranches with the raw sub-teams list and req.user, returning its filtered result', async () => {
    const rawSubTeams = [
      { id: 2, parent_team_id: 1, visibility: 'public' },
      { id: 3, parent_team_id: 1, visibility: 'private' }
    ];
    const filtered = [rawSubTeams[0]];
    Team.getSubTeams.mockResolvedValue(rawSubTeams);
    TeamVisibilityService.filterVisibleBranches.mockResolvedValue(filtered);

    const res = await request(app).get('/api/teams/1/sub-teams');

    expect(res.status).toBe(200);
    expect(Team.getSubTeams).toHaveBeenCalledWith('1');
    expect(TeamVisibilityService.filterVisibleBranches).toHaveBeenCalledWith(
      rawSubTeams,
      expect.objectContaining({ userId: 1 })
    );
    // The response must reflect the FILTERED list, not the raw list.
    expect(res.body.subTeams).toEqual(filtered);
    expect(res.body.subTeams).not.toEqual(rawSubTeams);
  });

  it('returns an empty list when Team.getSubTeams returns an empty array', async () => {
    Team.getSubTeams.mockResolvedValue([]);
    TeamVisibilityService.filterVisibleBranches.mockResolvedValue([]);

    const res = await request(app).get('/api/teams/1/sub-teams');

    expect(res.status).toBe(200);
    expect(TeamVisibilityService.filterVisibleBranches).toHaveBeenCalledWith([], expect.any(Object));
    expect(res.body.subTeams).toEqual([]);
  });

  it('returns an empty list when Team.getSubTeams returns null/undefined (null-safety fallback preserved)', async () => {
    Team.getSubTeams.mockResolvedValue(null);
    TeamVisibilityService.filterVisibleBranches.mockResolvedValue([]);

    const res = await request(app).get('/api/teams/1/sub-teams');

    expect(res.status).toBe(200);
    // The `|| []` fallback must still apply before filtering.
    expect(TeamVisibilityService.filterVisibleBranches).toHaveBeenCalledWith([], expect.any(Object));
    expect(res.body.subTeams).toEqual([]);
  });

  it('responds 500 when Team.getSubTeams rejects', async () => {
    Team.getSubTeams.mockRejectedValue(new Error('db unavailable'));

    const res = await request(app).get('/api/teams/1/sub-teams');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch sub-teams');
    expect(TeamVisibilityService.filterVisibleBranches).not.toHaveBeenCalled();
  });
});

/**
 * Integration tests for `PATCH /api/teams/:teamId/members/:userId`
 * (Requirements 11.4, 11.16, 13.2, 13.3, 13.4, 13.5, 13.6, 13.9, task
 * 28.1).
 *
 * `authenticateToken`/`authorize` are mocked (module-level, above) to
 * bypass real JWT/DB-backed authorization -- the `'team:members:edit'`
 * resolver itself is a separate task (28.2) and is not exercised here.
 */
describe('PATCH /api/teams/:teamId/members/:userId (Requirements 11.4, 11.16, 13.2-13.6, 13.9)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
    User.findById.mockResolvedValue({ id: 7, authentik_user_id: 900, first_name: 'John', last_name: 'Doe', email: 'john@example.com' });
    checkCallsignSuffixUniqueness.mockResolvedValue(undefined);
    // Bugfix (callsign-handling, second pass): a callsignSuffix edit now
    // issues a direct-team-membership SELECT before recomputing the
    // callsign (see the dedicated describe block below, which overrides
    // this with its own scenario-specific rows). Every other test in
    // this block that merely SENDS callsignSuffix, without asserting on
    // the recompute itself, still needs this query to resolve to
    // SOMETHING rather than `undefined` (`pool.query` is a bare
    // `jest.fn()` with no default implementation).
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('updates firstName only', async () => {
    User.update.mockResolvedValue({ id: 7, first_name: 'Jane', last_name: 'Doe' });

    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ firstName: 'Jane' });

    expect(res.status).toBe(200);
    expect(User.update).toHaveBeenCalledWith('7', { first_name: 'Jane' });
    expect(res.body.member).toEqual({ id: 7, first_name: 'Jane', last_name: 'Doe' });
  });

  it('updates lastName only', async () => {
    User.update.mockResolvedValue({ id: 7, first_name: 'John', last_name: 'Smith' });

    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ lastName: 'Smith' });

    expect(res.status).toBe(200);
    expect(User.update).toHaveBeenCalledWith('7', { last_name: 'Smith' });
  });

  it('updates takRole only, dual-writing user_cache and pushing to Authentik', async () => {
    const UserAttributesService = require('../services/userAttributes');
    User.update.mockResolvedValue({ id: 7, tak_role: 'Team Lead' });

    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ takRole: 'Team Lead' });

    expect(res.status).toBe(200);
    expect(User.update).toHaveBeenCalledWith('7', { tak_role: 'Team Lead' });
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE user_cache SET tak_role = $1 WHERE authentik_id = $2',
      ['Team Lead', 900]
    );
    expect(UserAttributesService.updateUserAttributes).toHaveBeenCalledWith(900, { role: 'Team Lead' });
  });

  it('updates callsignSuffix only, dual-writing user_cache and checking uniqueness excluding the edited user', async () => {
    User.update.mockResolvedValue({ id: 7, callsign_suffix: 'J.Doe' });

    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ callsignSuffix: 'J.Doe' });

    expect(res.status).toBe(200);
    expect(checkCallsignSuffixUniqueness).toHaveBeenCalledWith('1', 'J.Doe', 7);
    expect(User.update).toHaveBeenCalledWith('7', { callsign_suffix: 'J.Doe' });
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE user_cache SET callsign_suffix = $1 WHERE authentik_id = $2',
      ['J.Doe', 900]
    );
  });

  /**
   * Bugfix (callsign-handling): a callsign_suffix edit must recompute
   * and persist the ASSEMBLED tak_callsign, not just the raw
   * callsign_suffix column -- otherwise the DISPLAYED callsign
   * (user_cache.tak_callsign, and the value pushed to Authentik) stays
   * stale until an unrelated trigger (a Team-level prefix/format change,
   * or the next periodic Authentik sync) happens to regenerate it.
   */
  describe('callsignSuffix edit recomputes the assembled tak_callsign', () => {
    const UserAttributesService = require('../services/userAttributes');

    /**
     * Bugfix (callsign-handling, second pass): the recompute now reads
     * the user's DIRECT team via a `SELECT team_id FROM team_memberships
     * WHERE user_id = $1 AND inherited_from_team_id IS NULL` query
     * (never the URL's `:teamId`, which may name an ancestor the user
     * only holds an INHERITED row in) -- these tests mock `pool.query`
     * for exactly that SELECT, defaulting every OTHER query this handler
     * issues to `{ rows: [] }` (harmless for the writes, which never
     * read their own result).
     *
     * @param {number|string|null} directTeamId - the row this mock
     *   returns for the direct-team lookup; `null` models "no direct
     *   membership row found" (falls back to the URL's teamId).
     */
    function mockDirectTeamLookup(directTeamId) {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL')) {
          return Promise.resolve({ rows: directTeamId === null ? [] : [{ team_id: directTeamId }] });
        }
        return Promise.resolve({ rows: [] });
      });
    }

    it('calls generateCallsign with the user\'s DIRECT team id, not the URL\'s :teamId, and persists the result to user_cache and Authentik', async () => {
      User.update.mockResolvedValue({ id: 7, callsign_suffix: 'K.Kokako' });
      // The URL below is team 1, but the user's real direct team is 4 --
      // e.g. this PATCH was issued from an ancestor Organisation's page,
      // where the user shows up via an inherited row.
      mockDirectTeamLookup(4);
      UserAttributesService.generateCallsign.mockResolvedValue({
        callsign: 'FENZ-STL-K.Kokako',
        color: 'Red',
        role: 'Team Member'
      });

      const res = await request(app)
        .patch('/api/teams/1/members/7')
        .send({ callsignSuffix: 'K.Kokako' });

      expect(res.status).toBe(200);
      // The direct team (4), never the URL's team (1).
      expect(UserAttributesService.generateCallsign).toHaveBeenCalledWith('7', 4);
      expect(UserAttributesService.updateUserAttributes).toHaveBeenCalledWith(900, {
        callsign: 'FENZ-STL-K.Kokako',
        color: 'Red'
      });
      expect(pool.query).toHaveBeenCalledWith(
        'UPDATE user_cache SET tak_callsign = $1, tak_color = $2 WHERE authentik_id = $3',
        ['FENZ-STL-K.Kokako', 'Red', 900]
      );
    });

    it('falls back to the URL\'s :teamId when no direct-membership row is found', async () => {
      User.update.mockResolvedValue({ id: 7, callsign_suffix: 'K.Kokako' });
      mockDirectTeamLookup(null);
      UserAttributesService.generateCallsign.mockResolvedValue({
        callsign: 'FENZ-K.Kokako',
        color: 'Red',
        role: 'Team Member'
      });

      const res = await request(app)
        .patch('/api/teams/1/members/7')
        .send({ callsignSuffix: 'K.Kokako' });

      expect(res.status).toBe(200);
      expect(UserAttributesService.generateCallsign).toHaveBeenCalledWith('7', '1');
    });

    it('never applies the role field from generateCallsign\'s result (tak_role is separately managed)', async () => {
      User.update.mockResolvedValue({ id: 7, callsign_suffix: 'K.Kokako' });
      mockDirectTeamLookup(4);
      UserAttributesService.generateCallsign.mockResolvedValue({
        callsign: 'FENZ-STL-K.Kokako',
        color: 'Red',
        role: 'Team Member'
      });

      await request(app)
        .patch('/api/teams/1/members/7')
        .send({ callsignSuffix: 'K.Kokako' });

      const updateAttributesCall = UserAttributesService.updateUserAttributes.mock.calls.find(
        ([authentikId]) => authentikId === 900
      );
      expect(updateAttributesCall[1]).not.toHaveProperty('role');
      const cacheCall = pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE user_cache SET tak_callsign')
      );
      expect(cacheCall[0]).not.toContain('tak_role');
    });

    it('makes no recompute call when generateCallsign resolves null (e.g. team not found)', async () => {
      User.update.mockResolvedValue({ id: 7, callsign_suffix: 'K.Kokako' });
      mockDirectTeamLookup(4);
      UserAttributesService.generateCallsign.mockResolvedValue(null);

      const res = await request(app)
        .patch('/api/teams/1/members/7')
        .send({ callsignSuffix: 'K.Kokako' });

      expect(res.status).toBe(200);
      expect(UserAttributesService.updateUserAttributes).not.toHaveBeenCalled();
      const cacheCall = pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.startsWith('UPDATE user_cache SET tak_callsign')
      );
      expect(cacheCall).toBeUndefined();
    });

    it('does not call generateCallsign at all when callsignSuffix is not part of the update', async () => {
      User.update.mockResolvedValue({ id: 7, first_name: 'Jane' });
      mockDirectTeamLookup(4);

      await request(app)
        .patch('/api/teams/1/members/7')
        .send({ firstName: 'Jane' });

      expect(UserAttributesService.generateCallsign).not.toHaveBeenCalled();
    });
  });

  it('updates all fields together', async () => {
    User.update.mockResolvedValue({
      id: 7, first_name: 'Jane', last_name: 'Smith', tak_role: 'Medic', callsign_suffix: 'J.Smith'
    });

    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ firstName: 'Jane', lastName: 'Smith', takRole: 'Medic', callsignSuffix: 'J.Smith' });

    expect(res.status).toBe(200);
    expect(User.update).toHaveBeenCalledWith('7', {
      first_name: 'Jane',
      last_name: 'Smith',
      callsign_suffix: 'J.Smith',
      tak_role: 'Medic'
    });
  }); // generateCallsign defaults to resolving null in this describe block's beforeEach, so no extra recompute write occurs here.

  it('confirms a firstName/lastName-only edit writes directly to users with no access_requests interaction (Requirement 13.9)', async () => {
    User.update.mockResolvedValue({ id: 7, first_name: 'Jane', last_name: 'Smith' });

    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ firstName: 'Jane', lastName: 'Smith' });

    expect(res.status).toBe(200);
    // Only the name fields are written -- no takRole/callsignSuffix
    // supplied, so User.update is called with exactly those two fields.
    expect(User.update).toHaveBeenCalledWith('7', { first_name: 'Jane', last_name: 'Smith' });

    // Requirement 13.9: this edit path writes directly to `users` and is
    // completely independent of the existing self-service `name_change`
    // access-request/approval flow (`server/routes/requests.js`'s
    // `POST /api/requests/team-access` + `RequestApprovalService`'s
    // `name_change` branch, which INSERTs into/reads from
    // `access_requests`) -- confirm no `pool.query` call anywhere in
    // this request touches the `access_requests` table at all.
    const accessRequestsCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('access_requests')
    );
    expect(accessRequestsCalls).toHaveLength(0);
  });

  it('rejects an invalid takRole with 400 before writing anything', async () => {
    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ takRole: 'Not A Real Role' });

    expect(res.status).toBe(400);
    expect(User.update).not.toHaveBeenCalled();
  });

  it('rejects a callsignSuffix containing a disallowed character with 400 before writing anything', async () => {
    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ callsignSuffix: 'J Doe' });

    expect(res.status).toBe(400);
    expect(User.update).not.toHaveBeenCalled();
  });

  it('rejects a conflicting callsignSuffix with 400 and does not change the stored value', async () => {
    checkCallsignSuffixUniqueness.mockRejectedValue(new CallsignSuffixConflictError('J.Doe'));

    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ callsignSuffix: 'J.Doe' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/J\.Doe/);
    expect(User.update).not.toHaveBeenCalled();
  });

  it('ignores an email field even if sent', async () => {
    User.update.mockResolvedValue({ id: 7, first_name: 'Jane' });

    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ firstName: 'Jane', email: 'attacker@example.com' });

    expect(res.status).toBe(200);
    expect(User.update).toHaveBeenCalledWith('7', { first_name: 'Jane' });
    const updateCallArgs = User.update.mock.calls[0][1];
    expect(updateCallArgs.email).toBeUndefined();
  });

  it('returns 404 when the target user does not exist', async () => {
    User.findById.mockResolvedValue(undefined);

    const res = await request(app)
      .patch('/api/teams/1/members/999')
      .send({ firstName: 'Jane' });

    expect(res.status).toBe(404);
    expect(User.update).not.toHaveBeenCalled();
  });

  it('responds 500 when User.update rejects', async () => {
    User.update.mockRejectedValue(new Error('db unavailable'));

    const res = await request(app)
      .patch('/api/teams/1/members/7')
      .send({ firstName: 'Jane' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update team member');
  });
});

/**
 * Unit test for can_join=false code deletion (Task 10.2, signup-flow-rework).
 *
 * When PUT /api/teams/:teamId is called with canJoin=false, verify
 * DELETE FROM signup_codes is executed for that team.
 */
describe('PUT /api/teams/:teamId — can_join=false deletes signup codes (Task 10.2)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
    Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: null });
    Team.update.mockResolvedValue({ id: 42, name: 'Test', can_join: false });
  });

  it('executes DELETE FROM signup_codes when canJoin is set to false', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .put('/api/teams/42')
      .send({ canJoin: false });

    expect(res.status).toBe(200);

    // Verify DELETE FROM signup_codes was called for team 42
    const deleteCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM signup_codes')
    );
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);
    expect(deleteCalls[0][1]).toEqual(['42']);
  });

  it('does NOT delete signup codes when canJoin is true', async () => {
    Team.update.mockResolvedValue({ id: 42, name: 'Test', can_join: true });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .put('/api/teams/42')
      .send({ canJoin: true });

    expect(res.status).toBe(200);

    const deleteCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM signup_codes')
    );
    expect(deleteCalls).toHaveLength(0);
  });
});

/**
 * Integration tests for `GET /api/teams/:teamId`'s `team.allowed_domains`
 * field (Client UX: the Team_Detail_Page header's "Join limited by Email
 * Domain" summary badge).
 *
 * Organisation-only (no `parent_team_id`): an array (possibly empty) of
 * the Organisation's `org_allowed_domains` rows for an Organisation, and
 * `null` for a Sub_Team, matching `OrgDomainManager`'s own Organisation-
 * only gating. This is ADDITIVE to the existing response shape -- no
 * existing field changes.
 */
describe("GET /api/teams/:teamId team.allowed_domains summary field", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
    Team.getMembers.mockResolvedValue([]);
  });

  it('includes the Organisation\'s allowed_domains as a sorted array when domains are configured', async () => {
    Team.findById.mockResolvedValue({ id: 1, name: 'FENZ', parent_team_id: null, color: 'Red' });
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM org_allowed_domains')) {
        return Promise.resolve({ rows: [{ domain: 'fenz.govt.nz' }, { domain: 'fire.govt.nz' }] });
      }
      if (typeof sql === 'string' && sql.includes('FROM channels')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get('/api/teams/1');

    expect(res.status).toBe(200);
    expect(res.body.team.allowed_domains).toEqual(['fenz.govt.nz', 'fire.govt.nz']);
  });

  it('includes an empty array when the Organisation has no configured domains (unrestricted)', async () => {
    Team.findById.mockResolvedValue({ id: 1, name: 'FENZ', parent_team_id: null, color: 'Red' });
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM org_allowed_domains')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get('/api/teams/1');

    expect(res.status).toBe(200);
    expect(res.body.team.allowed_domains).toEqual([]);
  });

  it('sets allowed_domains to null for a Sub_Team, without querying org_allowed_domains at all', async () => {
    Team.findById.mockResolvedValue({ id: 5, name: 'Sub', parent_team_id: 1, color: 'Red' });
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app).get('/api/teams/5');

    expect(res.status).toBe(200);
    expect(res.body.team.allowed_domains).toBeNull();
    const domainCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('org_allowed_domains')
    );
    expect(domainCalls).toHaveLength(0);
  });

  it('sets allowed_domains to null and does not fail the whole request when the domains query itself fails', async () => {
    Team.findById.mockResolvedValue({ id: 1, name: 'FENZ', parent_team_id: null, color: 'Red' });
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('FROM org_allowed_domains')) {
        return Promise.reject(new Error('db unavailable'));
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get('/api/teams/1');

    expect(res.status).toBe(200);
    expect(res.body.team.allowed_domains).toBeNull();
  });
});

/**
 * Integration tests for `DELETE /api/teams/:teamId` (cascade-delete
 * feature). Authorization (`team:delete:global`, Global_Manager-only) is
 * enforced by the real authorize.js/Permission_Registry in production;
 * in this suite `authorize` is a pass-through mock (module-level), so
 * these tests focus on the route's own logic: the 404 for a missing
 * team, the empty-subtree GATE (refuse with 409 + counts when the
 * subtree still has members or team devices), and the delegation to
 * `Team.deleteWithSubtree` (which cascades) once the gate passes.
 */
describe('DELETE /api/teams/:teamId (cascade-delete + empty-subtree gate)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdmin = true;
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [] });
  });

  it('responds 404 without consulting the gate when the team does not exist', async () => {
    Team.findById.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/teams/999');

    expect(res.status).toBe(404);
    expect(Team.getSubtreeMemberDeviceCounts).not.toHaveBeenCalled();
    expect(Team.deleteWithSubtree).not.toHaveBeenCalled();
  });

  it('deletes a leaf team (no sub-teams, empty) via deleteWithSubtree', async () => {
    Team.findById.mockResolvedValue({ id: 5, name: 'Leaf Team', parent_team_id: 3 });
    Team.getSubtreeMemberDeviceCounts.mockResolvedValue({ memberCount: 0, deviceCount: 0, subTeamCount: 0 });
    Team.deleteWithSubtree.mockResolvedValue({ id: 5, name: 'Leaf Team' });

    const res = await request(app).delete('/api/teams/5');

    expect(res.status).toBe(200);
    expect(Team.deleteWithSubtree).toHaveBeenCalledWith('5', 1);
  });

  it('cascade-deletes a team WITH sub-teams when the whole subtree is empty of members and devices', async () => {
    Team.findById.mockResolvedValue({ id: 3, name: 'FENZ', parent_team_id: null });
    Team.getSubtreeMemberDeviceCounts.mockResolvedValue({ memberCount: 0, deviceCount: 0, subTeamCount: 12 });
    Team.deleteWithSubtree.mockResolvedValue({ id: 3, name: 'FENZ' });

    const res = await request(app).delete('/api/teams/3');

    expect(res.status).toBe(200);
    expect(Team.deleteWithSubtree).toHaveBeenCalledWith('3', 1);
  });

  it('refuses (409) and never deletes when the subtree still has members, naming the member count', async () => {
    Team.findById.mockResolvedValue({ id: 3, name: 'FENZ', parent_team_id: null });
    Team.getSubtreeMemberDeviceCounts.mockResolvedValue({ memberCount: 5, deviceCount: 0, subTeamCount: 12 });

    const res = await request(app).delete('/api/teams/3');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/5 members/);
    expect(res.body.error).toMatch(/sub-teams/);
    expect(res.body).toMatchObject({ memberCount: 5, deviceCount: 0, subTeamCount: 12 });
    expect(Team.deleteWithSubtree).not.toHaveBeenCalled();
  });

  it('refuses (409) and never deletes when the subtree still has team devices, naming the device count', async () => {
    Team.findById.mockResolvedValue({ id: 3, name: 'FENZ', parent_team_id: null });
    Team.getSubtreeMemberDeviceCounts.mockResolvedValue({ memberCount: 0, deviceCount: 1, subTeamCount: 0 });

    const res = await request(app).delete('/api/teams/3');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/1 team device\b/);
    // subTeamCount 0 -> the message scopes to "this team", not "sub-teams".
    expect(res.body.error).toMatch(/this team\b/);
    expect(res.body.error).not.toMatch(/sub-teams/);
    expect(Team.deleteWithSubtree).not.toHaveBeenCalled();
  });

  it('names BOTH counts when the subtree has members AND devices', async () => {
    Team.findById.mockResolvedValue({ id: 3, name: 'FENZ', parent_team_id: null });
    Team.getSubtreeMemberDeviceCounts.mockResolvedValue({ memberCount: 2, deviceCount: 3, subTeamCount: 4 });

    const res = await request(app).delete('/api/teams/3');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2 members/);
    expect(res.body.error).toMatch(/3 team devices/);
    expect(Team.deleteWithSubtree).not.toHaveBeenCalled();
  });

  it('responds 500 when the cascade delete itself throws', async () => {
    Team.findById.mockResolvedValue({ id: 3, name: 'FENZ', parent_team_id: null });
    Team.getSubtreeMemberDeviceCounts.mockResolvedValue({ memberCount: 0, deviceCount: 0, subTeamCount: 0 });
    Team.deleteWithSubtree.mockRejectedValue(new Error('boom'));

    const res = await request(app).delete('/api/teams/3');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to delete team');
  });
});
