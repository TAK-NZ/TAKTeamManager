/**
 * Integration tests for `POST /api/users`.
 *
 * takserver-enrollment Requirements 6.3, 6.6, 6.8 (task 5.3): this route
 * now resolves the username AND the callsign_suffix default together via
 * `UserProvisioningService.resolveNewUserIdentity`, replacing the removed
 * `resolveCallsignSuffixForNewUser`. The RESOLVED username -- the
 * caller-supplied `username` verbatim under a policy-disabled
 * Organisation, or a freshly minted Pseudonymous_Username under a
 * pseudonymous one -- is what reaches the Authentik create-user call and
 * `User.create`/the Claim_Row-adoption `UPDATE`.
 *
 * These exercise the actual mounted route via `supertest`, mocking
 * `authentikService`, `User.create`/`Team.addMember`, and
 * `UserProvisioningService.resolveNewUserIdentity`, to verify:
 *
 *  - A successful creation under a policy-disabled Organisation resolves
 *    a `callsign_suffix`, uses the caller-supplied `username` verbatim,
 *    and passes both through to `User.create`.
 *  - A `user_defined`-format Organisation with no `callsignSuffix`
 *    supplied results in a 400 naming the missing value, without ever
 *    calling Authentik.
 *  - A uniqueness collision results in a 400 naming the conflicting
 *    value, without ever calling Authentik.
 *  - An `OrganisationPrefixMissingError` results in a 400 naming the
 *    missing prefix, without ever calling Authentik.
 *  - A `ManagedIdentifierExhaustionError` results in a 500 (a system
 *    defect, not a caller error), without ever calling Authentik.
 *  - A Pseudonymous_Organisation's minted username reaches the Authentik
 *    create-user call, and a returned `claimId` is adopted via
 *    `UPDATE ... WHERE id = $claimId` rather than `User.create`, so the
 *    Claim_Row `resolveNewUserIdentity` already inserted is never
 *    orphaned by a second INSERT under `ON CONFLICT`.
 */

jest.mock('../services/authentik', () => ({
  createUser: jest.fn(),
  setUserPassword: jest.fn()
}));

jest.mock('../models/User', () => ({
  create: jest.fn()
}));

jest.mock('../models/Team', () => ({
  addMember: jest.fn(),
  getAncestorChain: jest.fn()
}));

jest.mock('../services/UserProvisioningService', () => {
  class CallsignSuffixRequiredError extends Error {
    constructor(message = "A callsign suffix is required for this Organisation's user_defined callsign format") {
      super(message);
      this.name = 'CallsignSuffixRequiredError';
    }
  }
  return {
    resolveNewUserIdentity: jest.fn(),
    CallsignSuffixRequiredError
  };
});

jest.mock('../services/ManagedIdentifierService', () => {
  class OrganisationPrefixMissingError extends Error {
    constructor(organisationId) {
      super(`Organisation ${organisationId} has no Organisation_Prefix. A Managed_Identifier cannot be minted for it, and none was.`);
      this.name = 'OrganisationPrefixMissingError';
      this.organisationId = organisationId;
    }
  }
  class ManagedIdentifierExhaustionError extends Error {
    constructor(organisationId, typeMarker, attempts) {
      super(`Exhausted ${attempts} Managed_Identifier mint attempt(s) for organisation ${organisationId} (type marker ${typeMarker}). No identifier could be claimed.`);
      this.name = 'ManagedIdentifierExhaustionError';
    }
  }
  return { OrganisationPrefixMissingError, ManagedIdentifierExhaustionError };
});

jest.mock('../services/CallsignSuffixUniquenessService', () => {
  class CallsignSuffixConflictError extends Error {
    constructor(conflictingValue) {
      super(`Callsign Suffix "${conflictingValue}" is already in use within this Team`);
      this.name = 'CallsignSuffixConflictError';
      this.conflictingValue = conflictingValue;
    }
  }
  return { CallsignSuffixConflictError, checkCallsignSuffixUniqueness: jest.fn() };
});

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

const mockLoggerError = jest.fn();
jest.mock('../middleware/requestContext', () => ({
  getLogger: () => ({ error: mockLoggerError, info: jest.fn(), warn: jest.fn() })
}));

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const express = require('express');
const request = require('supertest');
const authentikService = require('../services/authentik');
const User = require('../models/User');
const Team = require('../models/Team');
const pool = require('../config/database');
const UserProvisioningService = require('../services/UserProvisioningService');
const ManagedIdentifierService = require('../services/ManagedIdentifierService');
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

describe('POST /api/users identity resolution (takserver-enrollment task 5.3)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('resolves callsign_suffix and the verbatim username, passing both through to User.create on a policy-disabled Organisation', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'jdoe',
      callsignSuffix: 'J.Doe',
      pseudonymous: false,
      organisationId: 3,
      organisationPrefix: 'ORG',
      claimId: null
    });
    authentikService.createUser.mockResolvedValue({ pk: 55 });
    authentikService.setUserPassword.mockResolvedValue(true);
    User.create.mockResolvedValue({ id: 1, callsign_suffix: 'J.Doe' });
    Team.addMember.mockResolvedValue(true);

    const res = await request(app).post('/api/users').send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(null, {
      firstName: 'John',
      lastName: 'Doe',
      email: 'jdoe@example.com',
      teamId: 7,
      requestedUsername: 'jdoe',
      requestedCallsignSuffix: undefined
    });
    // The RESOLVED username -- here identical to the caller-supplied one
    // under a policy-disabled Organisation -- reaches the Authentik call.
    expect(authentikService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'jdoe' })
    );
    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'jdoe', callsign_suffix: 'J.Doe' })
    );
    expect(authentikService.createUser).toHaveBeenCalledTimes(1);
    // No Claim_Row adoption on this path.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("uses the resolved (minted) username for the Authentik call and adopts the Claim_Row instead of calling User.create, for a pseudonymous Organisation", async () => {
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'ORG-U7K3QMX',
      callsignSuffix: 'Ghost1',
      pseudonymous: true,
      organisationId: 3,
      organisationPrefix: 'ORG',
      claimId: 999
    });
    authentikService.createUser.mockResolvedValue({ pk: 4242 });
    authentikService.setUserPassword.mockResolvedValue(true);
    pool.query.mockResolvedValue({
      rows: [{ id: 999, username: 'ORG-U7K3QMX', email: 'jdoe@example.com' }]
    });
    Team.addMember.mockResolvedValue(true);

    const res = await request(app).post('/api/users').send(VALID_BODY);

    expect(res.status).toBe(201);
    // The Authentik create-user call uses the RESOLVED (minted) username,
    // never the caller-supplied raw `username` body field.
    expect(authentikService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'ORG-U7K3QMX' })
    );
    // Claim_Row adoption: an UPDATE ... WHERE id = $claimId, NOT
    // User.create -- User.create would INSERT a second row and leave the
    // Claim_Row orphaned forever under ON CONFLICT (authentik_user_id),
    // since the Claim_Row's authentik_user_id is NULL and NULL is never
    // equal to NULL under a unique constraint used for conflict
    // detection.
    expect(User.create).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET'),
      expect.arrayContaining([4242, 'ORG-U7K3QMX', 999])
    );
    expect(pool.query.mock.calls[0][0]).toMatch(/WHERE id = \$\d+/);
    expect(res.body.user.username).toBe('ORG-U7K3QMX');
  });

  it('returns 400 naming the missing value for a user_defined Organisation with no callsignSuffix supplied, without calling Authentik', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockRejectedValue(
      new UserProvisioningService.CallsignSuffixRequiredError()
    );

    const res = await request(app).post('/api/users').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/callsign suffix is required/i);
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
  });

  it('returns 400 naming the conflicting value on a uniqueness collision, without calling Authentik', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockRejectedValue(
      new CallsignSuffixConflictError('J.Doe')
    );

    const res = await request(app).post('/api/users').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/J\.Doe/);
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
  });

  it('returns 400 naming the Organisation when the target Organisation has no Organisation_Prefix, without calling Authentik', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockRejectedValue(
      new ManagedIdentifierService.OrganisationPrefixMissingError(3)
    );

    const res = await request(app).post('/api/users').send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Organisation_Prefix/);
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
  });

  it('returns 500 (a system defect, not a caller error) when the Managed_Identifier mint is exhausted, without calling Authentik', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockRejectedValue(
      new ManagedIdentifierService.ManagedIdentifierExhaustionError(3, 'U', 5)
    );

    const res = await request(app).post('/api/users').send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(authentikService.createUser).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('passes an explicitly supplied callsignSuffix through to the resolution call', async () => {
    UserProvisioningService.resolveNewUserIdentity.mockResolvedValue({
      username: 'jdoe',
      callsignSuffix: 'CUSTOM1',
      pseudonymous: false,
      organisationId: 3,
      organisationPrefix: 'ORG',
      claimId: null
    });
    authentikService.createUser.mockResolvedValue({ pk: 56 });
    authentikService.setUserPassword.mockResolvedValue(true);
    User.create.mockResolvedValue({ id: 2, callsign_suffix: 'CUSTOM1' });
    Team.addMember.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/users')
      .send({ ...VALID_BODY, callsignSuffix: 'CUSTOM1' });

    expect(res.status).toBe(201);
    expect(UserProvisioningService.resolveNewUserIdentity).toHaveBeenCalledWith(null, {
      firstName: 'John',
      lastName: 'Doe',
      email: 'jdoe@example.com',
      teamId: 7,
      requestedUsername: 'jdoe',
      requestedCallsignSuffix: 'CUSTOM1'
    });
  });
});
