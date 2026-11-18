/**
 * Permanent user removal: local work first and atomic, Authentik last.
 *
 * Regression target (demo, 2026-11-09): the routes deleted the Authentik
 * account first and the local `users` row second. The local delete failed on a
 * non-cascading foreign key (audit_logs.user_id) for a user with history, so the
 * Authentik account was gone but the local row survived with a dead
 * authentik_user_id, and every group PATCH containing it was rejected by
 * Authentik from then on.
 *
 * Also carries over the behaviours the old route tests pinned down:
 * certificateRevocationDryRun reporting, authentikAccountDeleted reporting, and
 * the cleanup_orphaned_authentik_user compensating operation.
 */
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('./TeamMembershipService', () => ({ removeUserFromTeam: jest.fn() }));
jest.mock('./userAttributes', () => ({ clearUserAttributes: jest.fn() }));
jest.mock('./EventPublisher', () => ({ publishOperation: jest.fn() }));

const pool = require('../config/database');
const TeamMembershipService = require('./TeamMembershipService');
const UserAttributesService = require('./userAttributes');
const EventPublisher = require('./EventPublisher');
const { permanentlyRemoveUser } = require('./UserRemovalService');

const ADMIN = 1;
const USER = 7;
const AK_PK = 4242;

function fkViolation() {
  const err = new Error('update or delete on table "users" violates foreign key constraint "audit_logs_user_id_fkey" on table "audit_logs"');
  err.code = '23503';
  err.constraint = 'audit_logs_user_id_fkey';
  return err;
}

const clientSql = () => mockClient.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').trim());
const sawClientSql = (fragment) => clientSql().some((s) => s.includes(fragment));
const auditDetails = () => {
  const call = pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO audit_logs'));
  expect(call).toBeTruthy();
  return JSON.parse(call[1][4]);
};

let originalFetch;
let originalRevokeEnabled;

beforeEach(() => {
  jest.clearAllMocks();
  originalFetch = global.fetch;
  originalRevokeEnabled = process.env.DEVICE_MGMT_REVOKE_ENABLED;
  process.env.AUTHENTIK_URL = 'https://authentik.example';
  process.env.AUTHENTIK_API_TOKEN = 'test-token';
  mockClient.query.mockResolvedValue({ rows: [] });
  pool.connect.mockResolvedValue(mockClient);
  pool.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('SELECT authentik_user_id FROM users')) {
      return Promise.resolve({ rows: [{ authentik_user_id: AK_PK }] });
    }
    return Promise.resolve({ rows: [] });
  });
  TeamMembershipService.removeUserFromTeam.mockResolvedValue({ success: true, groupsQueued: 2 });
  UserAttributesService.clearUserAttributes.mockResolvedValue(true);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalRevokeEnabled === undefined) delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
  else process.env.DEVICE_MGMT_REVOKE_ENABLED = originalRevokeEnabled;
});

describe('permanentlyRemoveUser', () => {
  it('returns null for an unknown user and touches nothing', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await expect(permanentlyRemoveUser(USER, ADMIN)).resolves.toBeNull();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  describe('happy path', () => {
    it('does all local work in one transaction, on the transaction client, and commits', async () => {
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result).toEqual({
        groupsQueued: 2,
        authentikAccountDeleted: true,
        certificateRevocationDryRun: true,
        localRowRetained: false
      });
      // The membership removal and its queued operations ride on the SAME client.
      expect(TeamMembershipService.removeUserFromTeam).toHaveBeenCalledWith(USER, ADMIN, mockClient);
      expect(clientSql()).toEqual([
        'BEGIN',
        'DELETE FROM user_cache WHERE authentik_id = $1',
        'SAVEPOINT remove_user_row',
        'DELETE FROM users WHERE id = $1',
        'RELEASE SAVEPOINT remove_user_row',
        'COMMIT'
      ]);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
      expect(auditDetails().localRowRetained).toBe(false);
    });

    it('commits the local work BEFORE it touches Authentik (the ordering that was wrong)', async () => {
      await permanentlyRemoveUser(USER, ADMIN);
      const commitOrder = mockClient.query.mock.invocationCallOrder[
        mockClient.query.mock.calls.findIndex(([sql]) => sql === 'COMMIT')
      ];
      const clearOrder = UserAttributesService.clearUserAttributes.mock.invocationCallOrder[0];
      const deleteOrder = global.fetch.mock.invocationCallOrder[0];
      expect(commitOrder).toBeLessThan(clearOrder);
      expect(commitOrder).toBeLessThan(deleteOrder);
    });

    it('deletes the Authentik account with the service token', async () => {
      await permanentlyRemoveUser(USER, ADMIN);
      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toBe(`https://authentik.example/api/v3/core/users/${AK_PK}/`);
      expect(options.method).toBe('DELETE');
      expect(UserAttributesService.clearUserAttributes).toHaveBeenCalledWith(AK_PK);
    });
  });

  describe('a user with history (foreign key blocks deleting the row)', () => {
    beforeEach(() => {
      mockClient.query.mockImplementation((sql) => {
        if (String(sql).includes('DELETE FROM users')) return Promise.reject(fkViolation());
        return Promise.resolve({ rows: [] });
      });
    });

    it('keeps the row as an orphaned tombstone with no Authentik id, and still commits', async () => {
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result.localRowRetained).toBe(true);
      const sql = clientSql();
      expect(sql).toContain('ROLLBACK TO SAVEPOINT remove_user_row');
      const update = sql.find((s) => s.startsWith('UPDATE users'));
      expect(update).toContain("account_status = 'orphaned'");
      expect(update).toContain('is_active = false');
      expect(update).toContain('authentik_user_id = NULL');
      expect(sql[sql.length - 1]).toBe('COMMIT');
      expect(sql).not.toContain('ROLLBACK');
    });

    it('scopes the tombstone update to that one user', async () => {
      await permanentlyRemoveUser(USER, ADMIN);
      const call = mockClient.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE users'));
      expect(call[1]).toEqual([USER]);
    });

    it('still deletes the Authentik account, after the commit, and records the tombstone in the audit log', async () => {
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result.authentikAccountDeleted).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(auditDetails()).toMatchObject({ localRowRetained: true, authentikAccountDeleted: true });
    });
  });

  describe('a local failure that is NOT the history foreign key', () => {
    it('rolls everything back, leaves Authentik untouched and writes no audit row', async () => {
      mockClient.query.mockImplementation((sql) => {
        if (String(sql).includes('DELETE FROM users')) return Promise.reject(new Error('connection reset'));
        return Promise.resolve({ rows: [] });
      });
      await expect(permanentlyRemoveUser(USER, ADMIN)).rejects.toThrow('connection reset');
      expect(clientSql()).toContain('ROLLBACK');
      expect(clientSql()).not.toContain('COMMIT');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(UserAttributesService.clearUserAttributes).not.toHaveBeenCalled();
      expect(pool.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO audit_logs'))).toBe(false);
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('does the same when removing the memberships fails', async () => {
      TeamMembershipService.removeUserFromTeam.mockRejectedValue(new Error('enqueue failed'));
      await expect(permanentlyRemoveUser(USER, ADMIN)).rejects.toThrow('enqueue failed');
      expect(clientSql()).toContain('ROLLBACK');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('is not fooled by a different SQLSTATE that merely looks similar', async () => {
      const err = new Error('unique violation');
      err.code = '23505';
      mockClient.query.mockImplementation((sql) => {
        if (String(sql).includes('DELETE FROM users')) return Promise.reject(err);
        return Promise.resolve({ rows: [] });
      });
      await expect(permanentlyRemoveUser(USER, ADMIN)).rejects.toThrow('unique violation');
      expect(clientSql().some((s) => s.startsWith('UPDATE users'))).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('a user with no Authentik id (already orphaned)', () => {
    it('removes locally and makes no Authentik calls', async () => {
      pool.query.mockImplementation((sql) =>
        Promise.resolve({ rows: String(sql).includes('SELECT authentik_user_id') ? [{ authentik_user_id: null }] : [] })
      );
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result).toMatchObject({ authentikAccountDeleted: true, localRowRetained: false });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(UserAttributesService.clearUserAttributes).not.toHaveBeenCalled();
      expect(sawClientSql('DELETE FROM user_cache')).toBe(false);
      expect(sawClientSql('DELETE FROM users')).toBe(true);
    });
  });

  describe('certificateRevocationDryRun', () => {
    it('is true (and in the audit log) when DEVICE_MGMT_REVOKE_ENABLED is unset', async () => {
      delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result.certificateRevocationDryRun).toBe(true);
      expect(auditDetails().certificateRevocationDryRun).toBe(true);
    });

    it('is false when DEVICE_MGMT_REVOKE_ENABLED is exactly "true"', async () => {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result.certificateRevocationDryRun).toBe(false);
      expect(auditDetails().certificateRevocationDryRun).toBe(false);
    });

    it('is true for a near-miss value ("TRUE"), matching the exact-string boolean-env convention', async () => {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = 'TRUE';
      expect((await permanentlyRemoveUser(USER, ADMIN)).certificateRevocationDryRun).toBe(true);
    });
  });

  describe('authentikAccountDeleted', () => {
    it('is true and enqueues no cleanup when the Authentik delete succeeds', async () => {
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result.authentikAccountDeleted).toBe(true);
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('treats a 404 (already absent) as success', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 404 });
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result.authentikAccountDeleted).toBe(true);
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('is false and enqueues cleanup_orphaned_authentik_user on a non-2xx/non-404 response, with local work already committed', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 500 });
      EventPublisher.publishOperation.mockResolvedValue('op-id');
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result.authentikAccountDeleted).toBe(false);
      expect(auditDetails().authentikAccountDeleted).toBe(false);
      expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
        'cleanup_orphaned_authentik_user',
        { authentik_user_id: AK_PK },
        ADMIN
      );
      expect(clientSql()).toContain('COMMIT');
    });

    it('is false and enqueues cleanup when the call itself throws (network failure)', async () => {
      global.fetch.mockRejectedValue(new Error('network unreachable'));
      EventPublisher.publishOperation.mockResolvedValue('op-id');
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result.authentikAccountDeleted).toBe(false);
      expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
    });

    it('still reports false, not an error, when the compensating enqueue also fails', async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 500 });
      EventPublisher.publishOperation.mockRejectedValue(new Error('queue insert failed'));
      const result = await permanentlyRemoveUser(USER, ADMIN);
      expect(result.authentikAccountDeleted).toBe(false);
    });
  });

  it('a failed audit write does not fail the removal', async () => {
    pool.query.mockImplementation((sql) => {
      if (String(sql).includes('INSERT INTO audit_logs')) return Promise.reject(new Error('audit down'));
      return Promise.resolve({ rows: String(sql).includes('SELECT authentik_user_id') ? [{ authentik_user_id: AK_PK }] : [] });
    });
    await expect(permanentlyRemoveUser(USER, ADMIN)).resolves.toMatchObject({ authentikAccountDeleted: true });
  });
});
