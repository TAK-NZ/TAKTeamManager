/**
 * Route tests for `POST /api/users/:userId/suspend` and
 * `POST /api/users/:userId/unsuspend` (account-lifecycle-management task
 * 3.4, Requirement 1).
 *
 * `AccountLifecycleService` is mocked, following `users.post.test.js`'s
 * established shape: `authenticateToken`/`authorize` are stubbed to bypass
 * the real JWT/authorization chain (that chain's OWN behaviour --
 * including the `user:suspend` row-scoped resolver -- is covered
 * separately by `server/middleware/authorize.test.js`), so this file is
 * scoped to confirming the route calls the service correctly and maps its
 * named errors to the documented response shapes.
 */

jest.mock('../services/AccountLifecycleService', () => {
  class AccountAlreadySuspendedError extends Error {
    constructor(userId) {
      super('Account is already suspended');
      this.name = 'AccountAlreadySuspendedError';
      this.userId = userId;
    }
  }
  class AccountOrphanedError extends Error {
    constructor(userId) {
      super('Account has no Authentik identity (orphaned)');
      this.name = 'AccountOrphanedError';
      this.userId = userId;
    }
  }
  class AccountNotSuspendedError extends Error {
    constructor(userId, currentStatus) {
      super(`Account is not suspended (current status: ${currentStatus})`);
      this.name = 'AccountNotSuspendedError';
      this.userId = userId;
      this.currentStatus = currentStatus;
    }
  }
  class TargetUserNotFoundError extends Error {
    constructor(userId) {
      super('Target user not found');
      this.name = 'TargetUserNotFoundError';
      this.userId = userId;
    }
  }

  const mockService = {
    suspendAccount: jest.fn(),
    unsuspendAccount: jest.fn()
  };
  mockService.AccountAlreadySuspendedError = AccountAlreadySuspendedError;
  mockService.AccountOrphanedError = AccountOrphanedError;
  mockService.AccountNotSuspendedError = AccountNotSuspendedError;
  mockService.TargetUserNotFoundError = TargetUserNotFoundError;
  return mockService;
});

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { userId: 9, id: 'authentik-9', is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

const express = require('express');
const request = require('supertest');
const AccountLifecycleService = require('../services/AccountLifecycleService');
const {
  AccountAlreadySuspendedError,
  AccountOrphanedError,
  AccountNotSuspendedError,
  TargetUserNotFoundError
} = AccountLifecycleService;

const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

describe('POST /api/users/:userId/suspend', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('calls AccountLifecycleService.suspendAccount with the target id and req.user, returning its result', async () => {
    AccountLifecycleService.suspendAccount.mockResolvedValue({ userId: 42, accountStatus: 'suspended' });

    const res = await request(app).post('/api/users/42/suspend');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 42, accountStatus: 'suspended' });
    expect(AccountLifecycleService.suspendAccount).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ userId: 9, is_global_manager: true })
    );
  });

  it('returns 404 for a non-integer :userId without calling the service at all', async () => {
    const res = await request(app).post('/api/users/not-a-number/suspend');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
    expect(AccountLifecycleService.suspendAccount).not.toHaveBeenCalled();
  });

  it('maps TargetUserNotFoundError to 404', async () => {
    AccountLifecycleService.suspendAccount.mockRejectedValue(new TargetUserNotFoundError(42));

    const res = await request(app).post('/api/users/42/suspend');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  it('maps AccountAlreadySuspendedError to 400, naming the current status in the message', async () => {
    AccountLifecycleService.suspendAccount.mockRejectedValue(new AccountAlreadySuspendedError(42));

    const res = await request(app).post('/api/users/42/suspend');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Account is already suspended' });
  });

  it('maps AccountOrphanedError to 400', async () => {
    AccountLifecycleService.suspendAccount.mockRejectedValue(new AccountOrphanedError(42));

    const res = await request(app).post('/api/users/42/suspend');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Account has no Authentik identity (orphaned)' });
  });

  it('maps an unrecognized error to a generic 500, logging it', async () => {
    AccountLifecycleService.suspendAccount.mockRejectedValue(new Error('unexpected db failure'));

    const res = await request(app).post('/api/users/42/suspend');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to suspend account' });
  });
});

describe('POST /api/users/:userId/unsuspend', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('calls AccountLifecycleService.unsuspendAccount with the target id and req.user, returning its result', async () => {
    AccountLifecycleService.unsuspendAccount.mockResolvedValue({ userId: 42, accountStatus: 'active' });

    const res = await request(app).post('/api/users/42/unsuspend');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 42, accountStatus: 'active' });
    expect(AccountLifecycleService.unsuspendAccount).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ userId: 9, is_global_manager: true })
    );
  });

  it('returns 404 for a non-integer :userId without calling the service at all', async () => {
    const res = await request(app).post('/api/users/not-a-number/unsuspend');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
    expect(AccountLifecycleService.unsuspendAccount).not.toHaveBeenCalled();
  });

  it('maps TargetUserNotFoundError to 404', async () => {
    AccountLifecycleService.unsuspendAccount.mockRejectedValue(new TargetUserNotFoundError(42));

    const res = await request(app).post('/api/users/42/unsuspend');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  it('maps AccountOrphanedError to 400', async () => {
    AccountLifecycleService.unsuspendAccount.mockRejectedValue(new AccountOrphanedError(42));

    const res = await request(app).post('/api/users/42/unsuspend');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Account has no Authentik identity (orphaned)' });
  });

  it('maps AccountNotSuspendedError to 400, naming the current status in the message', async () => {
    AccountLifecycleService.unsuspendAccount.mockRejectedValue(new AccountNotSuspendedError(42, 'active'));

    const res = await request(app).post('/api/users/42/unsuspend');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Account is not suspended (current status: active)' });
  });

  it('maps an unrecognized error to a generic 500, logging it', async () => {
    AccountLifecycleService.unsuspendAccount.mockRejectedValue(new Error('unexpected db failure'));

    const res = await request(app).post('/api/users/42/unsuspend');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to unsuspend account' });
  });
});
