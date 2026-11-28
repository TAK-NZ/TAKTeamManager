/**
 * `user:reset_mfa:team_admin` (authorize.js), through the middleware and the REAL registry: a Global_Manager, or an
 * admin of one of the target user's teams. Anyone else is refused.
 */
const mockIsAdmin = jest.fn();
const mockGetTeamMemberships = jest.fn();
jest.mock('./requestContext', () => ({ getLogger: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }) }));
jest.mock('../models/Team', () => ({ isAdmin: (...a) => mockIsAdmin(...a), findById: jest.fn() }));
jest.mock('../models/User', () => ({ getTeamMemberships: (...a) => mockGetTeamMemberships(...a) }));
jest.mock('../config/database', () => ({ query: jest.fn() }));
const express = require('express');
const request = require('supertest');
const authorize = require('./authorize');
function appFor(user) {
  const app = express();
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.post('/api/users/:userId/reset-mfa', authorize, (req, res) => res.status(200).json({ ok: true }));
  return app;
}
describe('authorize: user:reset_mfa:team_admin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('permits a Global_Manager without looking at any team', async () => {
    const res = await request(appFor({ userId: 1, id: 'a1', is_global_manager: true })).post('/api/users/42/reset-mfa');
    expect(res.status).toBe(200);
    expect(mockGetTeamMemberships).not.toHaveBeenCalled();
  });
  it('permits an admin of one of the target user\u2019s teams', async () => {
    mockGetTeamMemberships.mockResolvedValue([{ id: 5 }, { id: 7 }]);
    mockIsAdmin.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const res = await request(appFor({ userId: 3, id: 'a3', is_global_manager: false })).post('/api/users/42/reset-mfa');
    expect(res.status).toBe(200);
    expect(mockGetTeamMemberships).toHaveBeenCalledWith('42');
    expect(mockIsAdmin).toHaveBeenCalledWith(7, 3);
  });
  it('refuses an admin of none of the target user\u2019s teams', async () => {
    mockGetTeamMemberships.mockResolvedValue([{ id: 5 }]);
    mockIsAdmin.mockResolvedValue(false);
    const res = await request(appFor({ userId: 3, id: 'a3', is_global_manager: false })).post('/api/users/42/reset-mfa');
    expect(res.status).toBe(403);
  });
  it('refuses when the target user has no team', async () => {
    mockGetTeamMemberships.mockResolvedValue([]);
    const res = await request(appFor({ userId: 3, id: 'a3', is_global_manager: false })).post('/api/users/42/reset-mfa');
    expect(res.status).toBe(403);
  });
});
