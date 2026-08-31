/**
 * Integration tests for `DELETE /api/users/remove-from-team/:userId`
 * (bugfix: silent Authentik-delete failure, silent revoke-disarmed
 * outcome).
 *
 * `TeamMembershipService.removeUserFromTeam` unconditionally deletes
 * EVERY `team_memberships` row for the target user (no `team_id`
 * filter), and this app enforces at most one direct team per user, so
 * this route's call to it always leaves the user teamless -- its "no
 * teams left" branch always fires, meaning a `revoke_tak_certificates`
 * Sync_Operation is always enqueued by this route. Two things about that
 * enqueue and about the subsequent Authentik account delete were
 * previously invisible to the caller:
 *
 *  - Whether `DEVICE_MGMT_REVOKE_ENABLED` is armed at all -- an unarmed
 *    revoke completes as a no-op Revoke_Dry_Run when the Sync_Worker
 *    later drains the queue, and the admin who just permanently deleted
 *    a user had no way to know their TAK Server certificates were never
 *    actually revoked.
 *  - Whether the synchronous Authentik user-delete call itself
 *    succeeded -- a failure was only logged, and local rows were
 *    deleted anyway, leaving a fully intact, loginable Authentik
 *    account with no compensating action and no record that anything
 *    went wrong.
 *
 * Both outcomes now ride on the JSON response (`certificateRevocationDryRun`,
 * `authentikAccountDeleted`) and on the `user.remove_from_team` audit log
 * row's `details`. A failed Authentik delete additionally falls back to
 * enqueueing a `cleanup_orphaned_authentik_user` Sync_Operation, mirroring
 * `POST /api/users/create-and-add`'s own compensating-action pattern.
 */

jest.mock('../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

jest.mock('../services/TeamMembershipService', () => ({
  removeUserFromTeam: jest.fn()
}));

jest.mock('../services/userAttributes', () => ({
  clearUserAttributes: jest.fn()
}));

jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../middleware/requestContext', () => ({
  getLogger: () => mockLoggerInstance
}));

const express = require('express');
const request = require('supertest');
const pool = require('../config/database');
const TeamMembershipService = require('../services/TeamMembershipService');
const UserAttributesService = require('../services/userAttributes');
const EventPublisher = require('../services/EventPublisher');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

describe('DELETE /api/users/remove-from-team/:userId (bugfix: silent failures on permanent delete)', () => {
  let app;
  let originalFetch;
  let originalRevokeEnabled;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    originalFetch = global.fetch;
    originalRevokeEnabled = process.env.DEVICE_MGMT_REVOKE_ENABLED;

    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT authentik_user_id FROM users')) {
        return Promise.resolve({ rows: [{ authentik_user_id: 4242 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    TeamMembershipService.removeUserFromTeam.mockResolvedValue({ success: true, groupsQueued: 2 });
    UserAttributesService.clearUserAttributes.mockResolvedValue(true);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalRevokeEnabled === undefined) {
      delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
    } else {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = originalRevokeEnabled;
    }
  });

  function auditLogDetails() {
    const call = pool.query.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO audit_logs')
    );
    expect(call).toBeTruthy();
    const [, params] = call;
    return JSON.parse(params[4]);
  }

  describe('certificateRevocationDryRun', () => {
    it('reports true (and records it in the audit log) when DEVICE_MGMT_REVOKE_ENABLED is unset', async () => {
      delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app)
        .delete('/api/users/remove-from-team/7')
        .send({ teamId: 3 });

      expect(res.status).toBe(200);
      expect(res.body.certificateRevocationDryRun).toBe(true);
      expect(auditLogDetails().certificateRevocationDryRun).toBe(true);
    });

    it('reports false when DEVICE_MGMT_REVOKE_ENABLED is exactly "true"', async () => {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app)
        .delete('/api/users/remove-from-team/7')
        .send({ teamId: 3 });

      expect(res.status).toBe(200);
      expect(res.body.certificateRevocationDryRun).toBe(false);
      expect(auditLogDetails().certificateRevocationDryRun).toBe(false);
    });

    it('reports true for a near-miss value ("TRUE"), matching the exact-string boolean-env convention', async () => {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = 'TRUE';
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app)
        .delete('/api/users/remove-from-team/7')
        .send({ teamId: 3 });

      expect(res.body.certificateRevocationDryRun).toBe(true);
    });
  });

  describe('authentikAccountDeleted', () => {
    it('reports true and never enqueues a cleanup operation when the Authentik delete succeeds (200)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      const res = await request(app)
        .delete('/api/users/remove-from-team/7')
        .send({ teamId: 3 });

      expect(res.status).toBe(200);
      expect(res.body.authentikAccountDeleted).toBe(true);
      expect(auditLogDetails().authentikAccountDeleted).toBe(true);
      expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
        'cleanup_orphaned_authentik_user',
        expect.anything(),
        expect.anything()
      );
    });

    it('treats a 404 (already absent) as success, not a failure', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });

      const res = await request(app)
        .delete('/api/users/remove-from-team/7')
        .send({ teamId: 3 });

      expect(res.status).toBe(200);
      expect(res.body.authentikAccountDeleted).toBe(true);
      expect(EventPublisher.publishOperation).not.toHaveBeenCalledWith(
        'cleanup_orphaned_authentik_user',
        expect.anything(),
        expect.anything()
      );
    });

    it('reports false, enqueues cleanup_orphaned_authentik_user, and still deletes local rows when the Authentik delete responds with a non-2xx/non-404 status', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
      EventPublisher.publishOperation.mockResolvedValue('op-id');

      const res = await request(app)
        .delete('/api/users/remove-from-team/7')
        .send({ teamId: 3 });

      expect(res.status).toBe(200);
      expect(res.body.authentikAccountDeleted).toBe(false);
      expect(auditLogDetails().authentikAccountDeleted).toBe(false);
      expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
        'cleanup_orphaned_authentik_user',
        { authentik_user_id: 4242 },
        1
      );
      // Local cleanup proceeds regardless -- this app never leaves its
      // own rows around waiting on an Authentik-side outcome.
      expect(pool.query).toHaveBeenCalledWith(
        'DELETE FROM user_cache WHERE authentik_id = $1',
        ['4242']
      );
      expect(pool.query).toHaveBeenCalledWith('DELETE FROM users WHERE id = $1', ['7']);
    });

    it('reports false and enqueues cleanup_orphaned_authentik_user when the fetch call itself throws (network failure)', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network unreachable'));
      EventPublisher.publishOperation.mockResolvedValue('op-id');

      const res = await request(app)
        .delete('/api/users/remove-from-team/7')
        .send({ teamId: 3 });

      expect(res.status).toBe(200);
      expect(res.body.authentikAccountDeleted).toBe(false);
      expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
        'cleanup_orphaned_authentik_user',
        { authentik_user_id: 4242 },
        1
      );
    });

    it('still reports authentikAccountDeleted: false (not a 500) when the compensating enqueue itself also fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
      EventPublisher.publishOperation.mockRejectedValue(new Error('queue insert failed'));

      const res = await request(app)
        .delete('/api/users/remove-from-team/7')
        .send({ teamId: 3 });

      expect(res.status).toBe(200);
      expect(res.body.authentikAccountDeleted).toBe(false);
    });
  });
});
