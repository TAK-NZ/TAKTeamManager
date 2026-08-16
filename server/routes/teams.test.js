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

jest.mock('../models/Team', () => ({
  getAllTeams: jest.fn(),
  getTeamCount: jest.fn(),
  getUserTeams: jest.fn()
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

const express = require('express');
const request = require('supertest');
const Team = require('../models/Team');
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
