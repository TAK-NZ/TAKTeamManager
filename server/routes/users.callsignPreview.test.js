/**
 * Feature: member-visibility-and-callsign-recompute
 *
 * Property 5: The checked value is the assigned value.
 *
 * The preview route (`POST /api/users/callsign-suffix-preview`) reports
 * what the submit path (`POST /api/users/create-and-add`) WOULD assign as
 * the new user's `callsign_suffix`, or -- on a per-Team uniqueness
 * collision -- the value that collided. Requirements 5.1, 5.2 and 5.5
 * demand that the value the preview reports (as `suffix`, or as
 * `conflict.value` when it reports a conflict) is EXACTLY the value the
 * submit path resolves and applies the uniqueness check to.
 *
 * This is a TEST-ONLY task (task 4.1): the server preview route is already
 * correct, so no production code changes accompany it. The value of this
 * test is that it drives BOTH handlers over the same generated request
 * body and compares the preview's reported value against the
 * `callsign_suffix` argument the create-and-add path actually passes to
 * `UserProvisioningService.createAndAddUser` -- captured via a spy on that
 * method. Computing the expectation by calling the resolver twice would
 * assert nothing, since both handlers already call it; the whole point is
 * to prove that neither call site transforms, defaults, or re-derives the
 * resolved value differently on its way into the report versus into the
 * write.
 *
 * takserver-enrollment Requirements 6.3, 6.6, 6.8 (task 5.3): both
 * handlers now delegate to `UserProvisioningService.resolveNewUserIdentity`,
 * which REPLACED `resolveCallsignSuffixForNewUser` (removed in task 5.1).
 * None of this file's generated Ancestor_Chain rows set
 * `pseudonymous_usernames`, so `resolveNewUserIdentity`'s policy-disabled
 * branch runs throughout -- the exact same resolve/default/
 * uniqueness-check behaviour `resolveCallsignSuffixForNewUser` used to
 * provide, unchanged per Criterion 6.8.
 *
 * Both handlers therefore run the REAL
 * `UserProvisioningService.resolveNewUserIdentity` (and the real
 * `CallsignService.computeDefaultCallsignSuffix` /
 * `checkCallsignSuffixUniqueness` it delegates to); only the model reads
 * `Team.getAncestorChain` / `Team.getFullMemberList` are mocked (to
 * control the Organisation's Callsign_Name_Format and the roster used for
 * collision detection), `createAndAddUser` is spied to capture its
 * argument without performing any real write, and the Authentik HTTP calls
 * plus the post-commit attribute/cache/email side effects are stubbed.
 */

jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));

jest.mock('../services/authentik', () => ({
  getUsers: jest.fn()
}));

jest.mock('../services/userAttributes', () => ({
  generateCallsign: jest.fn().mockResolvedValue(null),
  updateUserAttributes: jest.fn().mockResolvedValue(true)
}));

jest.mock('../services/EmailService', () => {
  return jest.fn().mockImplementation(() => ({
    sendApprovalEmail: jest.fn().mockResolvedValue(undefined)
  }));
});

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 1, userId: 1, is_global_manager: true };
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../middleware/authorize', () => (req, res, next) => next());

jest.mock('../middleware/requestContext', () => ({
  getLogger: () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() })
}));

jest.mock('../services/EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue(1)
}));

// The two `Team` model reads that `resolveNewUserIdentity` depends on
// are mocked so each generated case controls both the Organisation's
// Callsign_Name_Format (via `getAncestorChain`) and the roster the
// uniqueness check runs against (via `getFullMemberList`).
// Everything else about the resolver -- the precedence rule, the default
// computation, the case-insensitive collision check -- runs for real.
jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
  getFullMemberList: jest.fn()
}));

// `createAndAddUser` is the value-capture point: it is spied so no real
// local write happens, while every OTHER static method on the service
// (crucially `resolveNewUserIdentity` and the typed error classes) stays
// real. Assigning the spy directly onto the required class (rather than
// spreading it) preserves the non-enumerable static methods.
jest.mock('../services/UserProvisioningService', () => {
  const actual = jest.requireActual('../services/UserProvisioningService');
  actual.createAndAddUser = jest.fn();
  return actual;
});

const express = require('express');
const request = require('supertest');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../config/database');
const Team = require('../models/Team');
const UserProvisioningService = require('../services/UserProvisioningService');
const usersRouter = require('./users');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

// Every Callsign_Name_Format the resolver understands, plus `user_defined`
// (which computes no default and requires a supplied value).
const CALLSIGN_NAME_FORMATS = [
  'full_name',
  'first_initial_last',
  'first_last_initial',
  'first_initial_dot_last',
  'user_defined'
];

// Names that survive express-validator's `.trim().isLength({ max: 150 })`.
// Kept to a printable, non-empty character set so both `firstName` and
// `lastName` reach the resolver as meaningful values.
const nameArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => s.replace(/[^A-Za-z0-9 ]/g, 'x').trim())
  .filter((s) => s.length > 0);

// A typed callsign suffix, or its absence -- covering absent,
// whitespace-only, and concrete values, matching Property 5's "absent,
// empty, whitespace-only, colliding, or unique" input space.
const callsignSuffixArb = fc.oneof(
  fc.constant(undefined),
  fc.constant('   '),
  fc
    .string({ minLength: 1, maxLength: 20 })
    .map((s) => s.replace(/[^A-Za-z0-9. -]/g, '-').trim())
    .filter((s) => s.length > 0)
);

const bodyArb = fc.record({
  firstName: nameArb,
  lastName: nameArb,
  teamId: fc.integer({ min: 1, max: 100000 }),
  callsignSuffix: callsignSuffixArb,
  format: fc.constantFrom(...CALLSIGN_NAME_FORMATS),
  // Whether the target Team's Member_List already holds the value that
  // WOULD be resolved -- driving the collision / no-collision cases.
  forceConflict: fc.boolean()
});

/**
 * Builds the request body the Client would send, dropping `callsignSuffix`
 * entirely when it is absent (matching `JSON.stringify` dropping
 * `undefined`), so the preview and create bodies are byte-for-byte the
 * same for a given generated case.
 */
function toRequestBody(gen) {
  const base = { teamId: gen.teamId, firstName: gen.firstName, lastName: gen.lastName };
  return gen.callsignSuffix === undefined
    ? base
    : { ...base, callsignSuffix: gen.callsignSuffix };
}

/**
 * Mocks the two `Team` reads for one generated case. `getAncestorChain`
 * returns a single Organisation row carrying the generated
 * Callsign_Name_Format. `getFullMemberList` returns a roster that either
 * already contains the value the resolver is about to produce (forcing a
 * collision) or is empty (no collision).
 *
 * The resolver's own logic decides the effective value; to seed a roster
 * that collides with it we re-derive that value here ONLY to populate the
 * mock -- this is test fixture setup, not the assertion's oracle. The
 * assertion still compares the preview report against the create-and-add
 * spy's captured argument, never against this locally derived value.
 */
function primeTeamMocks(gen, effectiveValueForConflict) {
  Team.getAncestorChain.mockResolvedValue([
    {
      id: gen.teamId,
      parent_team_id: null,
      name: 'Org',
      callsign_prefix: 'ORG',
      callsign_name_format: gen.format
    }
  ]);

  if (gen.forceConflict && effectiveValueForConflict) {
    Team.getFullMemberList.mockResolvedValue([
      { id: 999, callsign_suffix: effectiveValueForConflict }
    ]);
  } else {
    Team.getFullMemberList.mockResolvedValue([]);
  }
}

/**
 * Resolves what the effective value WOULD be for a generated case, using
 * the real resolver against an empty roster, so `primeTeamMocks` can seed
 * a colliding roster. Returns `null` when resolution itself is impossible
 * (e.g. `user_defined` with no supplied value -> required), in which case
 * no conflict roster is seeded.
 */
async function deriveEffectiveValue(gen) {
  Team.getAncestorChain.mockResolvedValue([
    {
      id: gen.teamId,
      parent_team_id: null,
      name: 'Org',
      callsign_prefix: 'ORG',
      callsign_name_format: gen.format
    }
  ]);
  Team.getFullMemberList.mockResolvedValue([]);
  try {
    // takserver-enrollment Requirements 6.3, 6.6, 6.8 (task 5.3):
    // `resolveCallsignSuffixForNewUser` was REMOVED (task 5.1);
    // `resolveNewUserIdentity` is the single choke point both this
    // route and the create-and-add path now delegate to. None of this
    // property's generated Ancestor_Chain rows set
    // `pseudonymous_usernames`, so `resolveNewUserIdentity`'s
    // policy-disabled branch runs -- the exact same
    // resolve/default/uniqueness-check behaviour
    // `resolveCallsignSuffixForNewUser` used to provide.
    const identity = await UserProvisioningService.resolveNewUserIdentity(null, {
      firstName: gen.firstName,
      lastName: gen.lastName,
      email: 'newuser@example.com',
      teamId: gen.teamId,
      requestedUsername: 'newuser@example.com',
      requestedCallsignSuffix: gen.callsignSuffix
    });
    return identity.callsignSuffix;
  } catch {
    return null;
  }
}

function mockAuthentikCreationSuccess() {
  global.fetch = jest.fn()
    // 1. existing-user-by-email lookup -> no results
    .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
    // 2. create user
    .mockResolvedValueOnce({ ok: true, json: async () => ({ pk: 4242 }) });
}

describe('Feature: member-visibility-and-callsign-recompute, Property 5: The checked value is the assigned value', () => {
  let app;
  let originalFetch;

  beforeEach(() => {
    app = buildApp();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // Feature: member-visibility-and-callsign-recompute, Property 5: The checked value is the assigned value
  test.prop([bodyArb], { numRuns: 100 })(
    "the preview's reported value equals the value the create-and-add path applies (or would collide on) for the same body",
    async (gen) => {
      jest.clearAllMocks();

      const effectiveValueForConflict = await deriveEffectiveValue(gen);
      primeTeamMocks(gen, effectiveValueForConflict);

      const body = toRequestBody(gen);

      // --- Drive the PREVIEW handler. ---
      const previewRes = await request(app)
        .post('/api/users/callsign-suffix-preview')
        .send(body);

      expect(previewRes.status).toBe(200);
      const preview = previewRes.body;

      // --- Drive the CREATE-AND-ADD handler over the same body. ---
      // A successful local transaction: the spy captures the
      // `callsign_suffix` argument and returns a benign result so the
      // route commits and responds 201. A colliding value never reaches
      // the spy -- Phase 0 rejects it with 400 before Authentik is
      // called.
      UserProvisioningService.createAndAddUser.mockResolvedValue({ localUserId: 55, queuedGroups: 0 });
      mockAuthentikCreationSuccess();
      // The transactional client used by Phase 2 / Phase 3.
      const mockClient = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
      pool.connect.mockResolvedValue(mockClient);
      pool.query.mockResolvedValue({ rows: [] });

      const createRes = await request(app)
        .post('/api/users/create-and-add')
        .send({ ...body, email: 'newuser@example.com' });

      if (preview.required === true) {
        // `user_defined` with no supplied value: the preview reports no
        // value to assign, and the submit path rejects for the same
        // reason (400, "callsign suffix is required"), never assigning
        // anything.
        expect(preview.suffix).toBeNull();
        expect(preview.conflict).toBeNull();
        expect(createRes.status).toBe(400);
        expect(createRes.body.error).toMatch(/callsign suffix is required/i);
        expect(UserProvisioningService.createAndAddUser).not.toHaveBeenCalled();
        return;
      }

      if (preview.conflict !== null) {
        // The preview reports a collision. The submit path resolves the
        // SAME value, applies the SAME uniqueness check, and rejects with
        // a 400 whose message names that value. `conflict.value` is the
        // value the check was applied to -- so it must appear in the
        // submit path's rejection and equal the reported `suffix`.
        expect(createRes.status).toBe(400);
        expect(typeof preview.conflict.value).toBe('string');
        expect(preview.conflict.value.length).toBeGreaterThan(0);
        expect(preview.suffix).toBe(preview.conflict.value);
        expect(createRes.body.error).toContain(preview.conflict.value);
        expect(UserProvisioningService.createAndAddUser).not.toHaveBeenCalled();
        return;
      }

      // A clean preview: the submit path assigns a value. The value the
      // preview reported as `suffix` must be EXACTLY the `callsign_suffix`
      // the create-and-add path passed to `createAndAddUser`.
      expect(createRes.status).toBe(201);
      expect(UserProvisioningService.createAndAddUser).toHaveBeenCalledTimes(1);
      const [, createArgs] = UserProvisioningService.createAndAddUser.mock.calls[0];
      expect(preview.suffix).toBe(createArgs.callsign_suffix);
      // ...and the 201 response echoes that same assigned value.
      expect(createRes.body.user.callsign_suffix).toBe(preview.suffix);
    }
  );
});

/**
 * Task 4.2 (test-only): the read-only negative facts of Requirement 5.6 and
 * the two `user_defined` response-shape regression guards (Requirements 6.1,
 * 6.5). These are plain example tests, not property tests, and they share the
 * Property 5 block's setup convention above: the REAL
 * `UserProvisioningService.resolveCallsignSuffixForNewUser` (and the real
 * `CallsignService` / `checkCallsignSuffixUniqueness` it delegates to) runs,
 * with only the two `Team` model reads mocked to control the Organisation's
 * Callsign_Name_Format (via `getAncestorChain`) and the roster the uniqueness
 * check runs against (via `getFullMemberList`).
 *
 * No production code changes accompany this task. `resolveNewUserIdentity`'s
 * `trimmedRequested || computeDefault(...)` precedence (in its policy-disabled
 * branch) is correct and explicitly out of scope -- a Team_Admin who types a
 * suffix must receive it.
 */
describe('Feature: member-visibility-and-callsign-recompute, Task 4.2: read-only and user_defined preview examples', () => {
  let app;
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    originalFetch = global.fetch;
    // A spy that records any Authentik HTTP call so the read-only assertion can
    // prove none was made. It never resolves to a used value: the preview path
    // must not touch it at all.
    global.fetch = jest.fn();
    pool.query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // A non-`user_defined` Organisation so the resolver computes a default and
  // returns a concrete `suffix` -- the ordinary success path whose side effects
  // (or absence of them) Requirement 5.6 constrains.
  function primeComputedFormat() {
    Team.getAncestorChain.mockResolvedValue([
      {
        id: 7,
        parent_team_id: null,
        name: 'Org',
        callsign_prefix: 'ORG',
        callsign_name_format: 'first_initial_dot_last'
      }
    ]);
    Team.getFullMemberList.mockResolvedValue([]);
  }

  // A `user_defined` Organisation: the resolver requires a supplied value and
  // computes no default.
  function primeUserDefinedFormat() {
    Team.getAncestorChain.mockResolvedValue([
      {
        id: 7,
        parent_team_id: null,
        name: 'Org',
        callsign_prefix: 'ORG',
        callsign_name_format: 'user_defined'
      }
    ]);
    Team.getFullMemberList.mockResolvedValue([]);
  }

  // Requirement 5.6: handling a preview performs no INSERT/UPDATE/DELETE, opens
  // no transaction (no BEGIN), and makes no Authentik request.
  it('handles a preview with no write, no transaction, and no Authentik request (Req 5.6)', async () => {
    primeComputedFormat();

    const res = await request(app)
      .post('/api/users/callsign-suffix-preview')
      .send({ teamId: 7, firstName: 'New', lastName: 'User' });

    expect(res.status).toBe(200);

    // No transaction: a transaction is opened by acquiring a pooled client and
    // issuing BEGIN. Neither happened.
    expect(pool.connect).not.toHaveBeenCalled();

    // No Authentik request: the preview path never reaches out over HTTP.
    expect(global.fetch).not.toHaveBeenCalled();

    // No mutating statement and no BEGIN reached the pool. (In this setup both
    // Team reads are mocked, so the preview path issues no pool query at all --
    // but assert against every statement that did reach the pool regardless, so
    // the guard still holds if the resolver's read path ever changes shape.)
    for (const [sql] of pool.query.mock.calls) {
      expect(String(sql)).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
      expect(String(sql)).not.toMatch(/\bBEGIN\b/i);
    }
    if (typeof pool.connect.mock !== 'undefined') {
      // Defensive: if a client were ever acquired, no BEGIN should have been
      // issued on it either. `pool.connect` was asserted uncalled above, so
      // there are no client statements to inspect -- this loop is a no-op today
      // and a trip-wire if that ever changes.
      for (const call of pool.connect.mock.results) {
        const client = call.value;
        if (client && client.query && client.query.mock) {
          for (const [sql] of client.query.mock.calls) {
            expect(String(sql)).not.toMatch(/\bBEGIN\b/i);
          }
        }
      }
    }
  });

  // Requirement 6.1 (regression guard): a `user_defined` Organisation with no
  // callsignSuffix supplied responds 200 with { suffix: null, required: true,
  // conflict: null }. Re-expressed here against the real resolver with Team
  // reads mocked, matching this file's 4.1 setup.
  it('reports { suffix: null, required: true, conflict: null } for user_defined with no suffix (Req 6.1)', async () => {
    primeUserDefinedFormat();

    // Omitted callsignSuffix.
    const omitted = await request(app)
      .post('/api/users/callsign-suffix-preview')
      .send({ teamId: 7, firstName: 'New', lastName: 'User' });

    expect(omitted.status).toBe(200);
    expect(omitted.body).toEqual({ suffix: null, required: true, conflict: null });

    // Whitespace-only callsignSuffix trims to empty and is treated the same.
    const whitespace = await request(app)
      .post('/api/users/callsign-suffix-preview')
      .send({ teamId: 7, firstName: 'New', lastName: 'User', callsignSuffix: '   ' });

    expect(whitespace.status).toBe(200);
    expect(whitespace.body).toEqual({ suffix: null, required: true, conflict: null });
  });

  // Requirement 6.5 (regression guard): a `user_defined` Organisation with a
  // non-empty trimmed callsignSuffix responds with required: false and performs
  // the uniqueness check against that value.
  it('reports required: false and checks uniqueness of the supplied value for user_defined (Req 6.5)', async () => {
    // A roster that does NOT collide: the supplied value passes the check and is
    // reported back verbatim.
    primeUserDefinedFormat();

    const clean = await request(app)
      .post('/api/users/callsign-suffix-preview')
      .send({ teamId: 7, firstName: 'New', lastName: 'User', callsignSuffix: 'Bravo1' });

    expect(clean.status).toBe(200);
    expect(clean.body).toEqual({ suffix: 'Bravo1', required: false, conflict: null });
    // The uniqueness check ran against that Team's roster for this value.
    expect(Team.getFullMemberList).toHaveBeenCalledWith(7);

    // A roster that DOES collide (case-insensitively) with the supplied value:
    // the check runs against that same value and reports it as the conflict.
    Team.getAncestorChain.mockResolvedValue([
      {
        id: 7,
        parent_team_id: null,
        name: 'Org',
        callsign_prefix: 'ORG',
        callsign_name_format: 'user_defined'
      }
    ]);
    Team.getFullMemberList.mockResolvedValue([{ id: 999, callsign_suffix: 'bravo1' }]);

    const collide = await request(app)
      .post('/api/users/callsign-suffix-preview')
      .send({ teamId: 7, firstName: 'New', lastName: 'User', callsignSuffix: 'Bravo1' });

    expect(collide.status).toBe(200);
    expect(collide.body.required).toBe(false);
    expect(collide.body.conflict).toEqual({
      value: 'Bravo1',
      message: expect.stringContaining('Bravo1')
    });
    expect(collide.body.suffix).toBe('Bravo1');
  });
});
