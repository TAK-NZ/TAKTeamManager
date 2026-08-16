/**
 * Unit tests for `TakCertificateRevocationService.revokeUserTakCertificates`
 * (Requirement 26.6, task 48.4): the "explicit revoke action" enqueue call
 * site. Focused on the authorization gate (Global_Manager or Team.isAdmin
 * of the target user's team allowed, others rejected) and on the enqueued
 * `revoke_tak_certificates` payload shape.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));
jest.mock('../models/Team', () => ({
  isAdmin: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const Team = require('../models/Team');
const EventPublisher = require('./EventPublisher');
const TakCertificateRevocationService = require('./TakCertificateRevocationService');
const {
  TakCertificateRevocationAuthorizationError,
  TakCertificateRevocationTargetUserNotFoundError
} = TakCertificateRevocationService;

describe('TakCertificateRevocationService.revokeUserTakCertificates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows a Global_Manager to revoke any user\'s certificates, without checking Team.isAdmin', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, username: 'alice' }] }); // users lookup
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const result = await TakCertificateRevocationService.revokeUserTakCertificates(42, {
      userId: 1,
      is_global_manager: true
    });

    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { target_user_id: 42, tak_usernames: ['alice'] },
      1
    );
    expect(result).toEqual({ queued: true, takUsername: 'alice' });
  });

  it('allows an admin (per Team.isAdmin) of the target user\'s direct team to revoke their certificates', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42, username: 'alice' }] }) // users lookup
      .mockResolvedValueOnce({ rows: [{ team_id: 5 }] }); // direct team membership lookup
    Team.isAdmin.mockResolvedValue(true);
    EventPublisher.publishOperation.mockResolvedValue('op-id');

    const result = await TakCertificateRevocationService.revokeUserTakCertificates(42, {
      userId: 7,
      is_global_manager: false
    });

    expect(Team.isAdmin).toHaveBeenCalledWith(5, 7);
    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'revoke_tak_certificates',
      { target_user_id: 42, tak_usernames: ['alice'] },
      7
    );
    expect(result).toEqual({ queued: true, takUsername: 'alice' });
  });

  it('rejects a user who is neither a Global_Manager nor an admin of the target user\'s team, and enqueues nothing', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42, username: 'alice' }] })
      .mockResolvedValueOnce({ rows: [{ team_id: 5 }] });
    Team.isAdmin.mockResolvedValue(false);

    await expect(
      TakCertificateRevocationService.revokeUserTakCertificates(42, { userId: 7, is_global_manager: false })
    ).rejects.toThrow(TakCertificateRevocationAuthorizationError);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('rejects a non-Global_Manager acting user when the target user has no team membership to check admin status against', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42, username: 'alice' }] })
      .mockResolvedValueOnce({ rows: [] }); // no team membership

    await expect(
      TakCertificateRevocationService.revokeUserTakCertificates(42, { userId: 7, is_global_manager: false })
    ).rejects.toThrow(TakCertificateRevocationAuthorizationError);

    expect(Team.isAdmin).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('throws TakCertificateRevocationTargetUserNotFoundError when the target user does not exist, and enqueues nothing', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      TakCertificateRevocationService.revokeUserTakCertificates(999, { userId: 1, is_global_manager: true })
    ).rejects.toThrow(TakCertificateRevocationTargetUserNotFoundError);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('throws TakCertificateRevocationTargetUserNotFoundError when the target user has no username, and enqueues nothing', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, username: null }] });

    await expect(
      TakCertificateRevocationService.revokeUserTakCertificates(42, { userId: 1, is_global_manager: true })
    ).rejects.toThrow(TakCertificateRevocationTargetUserNotFoundError);

    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });
});
