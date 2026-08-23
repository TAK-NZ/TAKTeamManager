/**
 * Integration tests for `POST /api/users` (Requirements 11.6, 11.7,
 * 11.14, 11.15; task 22.2: wiring
 * `UserProvisioningService.resolveCallsignSuffixForNewUser` into this
 * route).
 *
 * These exercise the actual mounted route via `supertest`, mocking
 * `authentikService`, `User.create`/`Team.addMember`, and
 * `UserProvisioningService.resolveCallsignSuffixForNewUser`, to verify:
 *
 *  - A successful creation resolves a `callsign_suffix` and passes it
 *    through to `User.create`.
 *  - A `user_defined`-format Organisation with no `callsignSuffix`
 *    supplied results in a 400 naming the missing value, without ever
 *    calling Authentik.
 *  - A uniqueness collision results in a 400 naming the conflicting
 *    value, without ever calling Authentik.
 */

jest.mock('../services/authentik', () => ({
  createUser: jest.fn(),
  setUserPassword: jest.fn()
}));

jest.mock('../models/User', () => ({
  create: jest.fn()
}));

jest.mock('../models/Team', () => ({
  addMember: jest.fn()
}));

jest.mock('../services/UserProvisioningService', () => {
  class CallsignSuffixRequiredError extends Error {
    constructor(message = "A callsign suffix is required for this Organisation's user_defined callsign format") {
      super(message);
      this.name = 'CallsignSuffixRequiredError';
    }
  }
  return {
    resolveCallsignSuffixForNewUser: jest.fn(),
    CallsignSuffixRequiredError
  };
});

jest.mock('../services/CallsignSuffixUniquenessService', () => {
  class CallsignSuffixConflictError extends Error {
    constructor(conflictingValue) {
      super(`Callsign Suffix "${conflictingValue}" is already in use within this Team`);
      this.name = 'CallsignSuffixConflictError';
      this.conflictingValue = conflictingValue;
    }
  }
  return { CallsignSuffixConflictError };
});

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const express = require('express');
const request = require('supertest');
const authentikService = require('../services/authentik');
const User = require('../models/User');
const Team = require('../models/Team');
const UserProvisioningService = require('../services/UserProvisioningService');
const { CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

const VALID_BODY = {
  username: 'jdoe',
  email: 'jdoe@example.com',
  firstName: 'John',
  lastName: 'Doe',
  password: 'password123',
  teamId: 7
};

describe('POST /api/users callsign_suffix resolution (task 22.2)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('resolves callsign_suffix and passes it through to User.create on a successful creation', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockResolvedValue('J.Doe');
    authentikService.createUser.mockResolvedValue({ pk: 55 });
    authentikService.setUserPassword.mockResolvedValue(true);
    User.create.mockResolvedValue({ id: 1, callsign_suffix: 'J.Doe' });
    Team.addMember.mockResolvedValue(true);

    const res = await request(app).post('/api/users').send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(UserProvisioningService.resolveCallsignSuffixForNewUser).toHaveBeenCalledWith(null, {
      firstName: 'John',
      lastName: 'Doe',
      teamId: 7,
      requestedCallsignSuffix: undefined
    });
    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ callsign_suffix: 'J.Doe' })
    );
    expect(authentikService.createUser).toHaveBeenCalledTimes(1);
  });

  it('returns 400 naming the missing value for a user_defined Organisation with no callsignSuffix supplied, without calling Authentik', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockRejectedValue(
      new UserProvisioningService.CallsignSuffixRequiredError()
    );

    const res = await request(app).post('/api/users').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/callsign suffix is required/i);
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
  });

  it('returns 400 naming the conflicting value on a uniqueness collision, without calling Authentik', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockRejectedValue(
      new CallsignSuffixConflictError('J.Doe')
    );

    const res = await request(app).post('/api/users').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/J\.Doe/);
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
  });

  it('passes an explicitly supplied callsignSuffix through to the resolution call', async () => {
    UserProvisioningService.resolveCallsignSuffixForNewUser.mockResolvedValue('CUSTOM1');
    authentikService.createUser.mockResolvedValue({ pk: 56 });
    authentikService.setUserPassword.mockResolvedValue(true);
    User.create.mockResolvedValue({ id: 2, callsign_suffix: 'CUSTOM1' });
    Team.addMember.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/users')
      .send({ ...VALID_BODY, callsignSuffix: 'CUSTOM1' });

    expect(res.status).toBe(201);
    expect(UserProvisioningService.resolveCallsignSuffixForNewUser).toHaveBeenCalledWith(null, {
      firstName: 'John',
      lastName: 'Doe',
      teamId: 7,
      requestedCallsignSuffix: 'CUSTOM1'
    });
  });
});
