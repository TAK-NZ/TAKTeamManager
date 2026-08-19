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
    CallsignLevelSelectionSubTeamError
  } = jest.requireActual('../models/Team');
  return {
    getAllTeams: jest.fn(),
    getTeamCount: jest.fn(),
    getUserTeams: jest.fn(),
    getSubTeamsForCallsignLevel: jest.fn(),
    getSubTeams: jest.fn(),
    getAncestorChain: jest.fn(),
    getOrganisationTeams: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    TeamDepthExceededError,
    CallsignLevelSelectionRangeError,
    CallsignLevelSelectionSubTeamError
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

// Requirement 5.12 (task 11.6) / 13.6 (task 28.1): PUT /api/teams/:teamId
// and PATCH /api/teams/:teamId/members/:userId both require
// `../services/userAttributes` inline inside their handlers (not at
// module load time), but jest.mock still intercepts that require
// regardless of when it happens, so this mock lets the tests below
// assert whether `updateTeamUserAttributes`/`updateUserAttributes` was
// (or wasn't) triggered by a given update.
jest.mock('../services/userAttributes', () => ({
  updateTeamUserAttributes: jest.fn().mockResolvedValue(true),
  updateUserAttributes: jest.fn().mockResolvedValue(true)
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
      expect(res.body.teams).toEqual([{ id: 1, name: 'Team A' }]);
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

    it('calls Team.getUserTeams and never Team.getAllTeams, with no pagination metadata in the response', async () => {
      Team.getUserTeams.mockResolvedValue([{ id: 2, name: 'My Team' }]);

      const res = await request(app).get('/api/teams/my-teams').query({ page: 3, pageSize: 10 });

      expect(res.status).toBe(200);
      expect(Team.getUserTeams).toHaveBeenCalledWith(1);
      expect(Team.getAllTeams).not.toHaveBeenCalled();
      expect(res.body.teams).toEqual([{ id: 2, name: 'My Team' }]);
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

    const res = await request(app).get('/api/teams/my-teams').query({ scope: 'organisation' });

    expect(res.status).toBe(200);
    expect(Team.getAncestorChain).toHaveBeenCalledWith(5);
    expect(Team.getOrganisationTeams).toHaveBeenCalledWith(1);
    expect(TeamVisibilityService.filterVisibleBranches).toHaveBeenCalledWith(
      orgTeams,
      expect.objectContaining({ userId: 1 })
    );
    expect(res.body.teams).toEqual(filtered);
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
    it('rejects a callsignPrefix containing a "-" with 400', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', callsignPrefix: 'NZ-POL' });

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

    it('accepts an omitted callsignPrefix', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'Police' });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police' });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalled();
    });

    it('accepts an empty-string callsignPrefix', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'Police', callsign_prefix: '' });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Police', callsignPrefix: '' });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalled();
    });
  });

  describe('PUT /api/teams/:teamId', () => {
    beforeEach(() => {
      Team.findById.mockResolvedValue({ id: 42, color: 'Blue', parent_team_id: null });
    });

    it('rejects a callsignPrefix containing a "-" with 400', async () => {
      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignPrefix: 'NZ-POL' });

      expect(res.status).toBe(400);
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

    it('accepts an omitted callsignPrefix', async () => {
      Team.update.mockResolvedValue({ id: 42 });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalled();
    });

    it('accepts an empty-string callsignPrefix', async () => {
      Team.update.mockResolvedValue({ id: 42, callsign_prefix: '' });

      const res = await request(app)
        .put('/api/teams/42')
        .send({ callsignPrefix: '' });

      expect(res.status).toBe(200);
      expect(Team.update).toHaveBeenCalled();
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
    it('accepts callsignNameFormat "first_initial_dot_last"', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'Org', callsign_name_format: 'first_initial_dot_last' });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Org', callsignNameFormat: 'first_initial_dot_last' });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_name_format: 'first_initial_dot_last' }));
    });

    it('accepts callsignNameFormat "user_defined"', async () => {
      Team.create.mockResolvedValue({ id: 1, name: 'Org', callsign_name_format: 'user_defined' });

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Org', callsignNameFormat: 'user_defined' });

      expect(res.status).toBe(201);
      expect(Team.create).toHaveBeenCalledWith(expect.objectContaining({ callsign_name_format: 'user_defined' }));
    });

    it('rejects an invalid callsignNameFormat value with 400', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'Org', callsignNameFormat: 'bogus_format' });

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
    it('rejects a non-array callsignLevelSelection with 400 before calling Team.create', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignLevelSelection: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(Team.create).not.toHaveBeenCalled();
    });

    it('rejects a callsignLevelSelection with a non-integer element with 400 before calling Team.create', async () => {
      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignLevelSelection: [1, 'two'] });

      expect(res.status).toBe(400);
      expect(Team.create).not.toHaveBeenCalled();
    });

    it('responds 400 with the exact range message when Team.create throws CallsignLevelSelectionRangeError', async () => {
      Team.create.mockRejectedValue(new Team.CallsignLevelSelectionRangeError());

      const res = await request(app)
        .post('/api/teams')
        .send({ name: 'FENZ', callsignLevelSelection: [1, 2, 6] });

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
        .send({ name: 'FENZ', callsignLevelSelection: [1, 3, 5] });

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
  });

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
