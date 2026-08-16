/**
 * Unit tests for BroadcastEmailService (Requirement 30, task 52.1).
 *
 * Covers:
 *  - Global_Manager sending to allUsers skips the authorization-scoping
 *    check entirely.
 *  - A team admin sending within the team(s) they administer succeeds.
 *  - A team admin whose filter reaches a user outside their administered
 *    teams is rejected, with no email sent (no partial send).
 *  - A team admin whose administered-team-resolution query throws is
 *    rejected fail-closed, with no email sent.
 *
 * `EmailService.sendEmail` is mocked so no real SES call is ever made.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const mockSendEmail = jest.fn();
jest.mock('./EmailService', () => {
  return jest.fn().mockImplementation(() => ({
    sendEmail: mockSendEmail
  }));
});

const mockLoggerInstance = { info: jest.fn(), error: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const BroadcastEmailService = require('./BroadcastEmailService');
const { BroadcastAuthorizationError } = require('./BroadcastEmailService');

describe('BroadcastEmailService.send', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSendEmail.mockResolvedValue({ MessageId: 'msg-123' });
    service = new BroadcastEmailService();
  });

  it('sends to every active user for a Global_Manager with allUsers, skipping the authorization-scoping check', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('LEFT JOIN team_memberships')) {
        return Promise.resolve({
          rows: [
            { id: 1, email: 'alice@example.com', teamId: 5 },
            { id: 2, email: 'bob@example.com', teamId: null }
          ]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const actingUser = { userId: 99, is_global_manager: true };
    const result = await service.send({ allUsers: true }, actingUser, 'broadcast_announcement', { foo: 'bar' });

    expect(result).toEqual({
      sentCount: 2,
      recipients: ['alice@example.com', 'bob@example.com']
    });

    // No administered-team-id query issued for a Global_Manager.
    const calledSql = pool.query.mock.calls.map(([sql]) => sql);
    expect(calledSql.some((sql) => sql.includes("role = 'admin'"))).toBe(false);

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail).toHaveBeenNthCalledWith(1, 'alice@example.com', 'broadcast_announcement', { foo: 'bar' });
    expect(mockSendEmail).toHaveBeenNthCalledWith(2, 'bob@example.com', 'broadcast_announcement', { foo: 'bar' });
  });

  it('sends successfully when a team admin filters to only the team(s) they administer', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('JOIN team_memberships') && sql.includes('tm.team_id = ANY')) {
        return Promise.resolve({
          rows: [{ id: 10, email: 'carol@example.com', teamId: 5 }]
        });
      }
      if (sql.includes("role = 'admin'")) {
        return Promise.resolve({ rows: [{ team_id: 5 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const actingUser = { userId: 42, is_global_manager: false };
    const result = await service.send({ teamIds: [5] }, actingUser, 'broadcast_announcement');

    expect(result).toEqual({ sentCount: 1, recipients: ['carol@example.com'] });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith('carol@example.com', 'broadcast_announcement', {});
  });

  it('rejects the entire request, sending no email, when a team admin filter reaches a user outside their administered teams', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('JOIN team_memberships') && sql.includes('tm.team_id = ANY')) {
        return Promise.resolve({
          rows: [
            { id: 10, email: 'carol@example.com', teamId: 5 },
            { id: 11, email: 'dave@example.com', teamId: 6 } // outside admin's scope
          ]
        });
      }
      if (sql.includes("role = 'admin'")) {
        return Promise.resolve({ rows: [{ team_id: 5 }] }); // only administers team 5
      }
      return Promise.resolve({ rows: [] });
    });

    const actingUser = { userId: 42, is_global_manager: false };

    await expect(service.send({ teamIds: [5, 6] }, actingUser, 'broadcast_announcement')).rejects.toThrow(
      BroadcastAuthorizationError
    );

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('rejects fail-closed, sending no email, when the administered-team resolution query throws', async () => {
    pool.query.mockImplementation((sql) => {
      if (sql.includes('JOIN team_memberships') && sql.includes('tm.team_id = ANY')) {
        return Promise.resolve({
          rows: [{ id: 10, email: 'carol@example.com', teamId: 5 }]
        });
      }
      if (sql.includes("role = 'admin'")) {
        return Promise.reject(new Error('db connection lost'));
      }
      return Promise.resolve({ rows: [] });
    });

    const actingUser = { userId: 42, is_global_manager: false };

    await expect(service.send({ teamIds: [5] }, actingUser, 'broadcast_announcement')).rejects.toThrow(
      BroadcastAuthorizationError
    );

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 42 }),
      expect.stringContaining('Failed to resolve administered teams')
    );
  });
});
