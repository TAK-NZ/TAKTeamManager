/**
 * Canonical tagged property test for design.md's Property 7 (task 16.7).
 *
 * design.md's exact Property 7 statement: "For all confirmation strings
 * submitted with a revocation request (self or admin), the Revoke_Operation
 * SHALL be enqueued if and only if the confirmation string is exactly equal
 * to the Revoke_Confirmation_Word `REVOKE`."
 *
 * ## Why this is an "iff" and not just a "reject the wrong words" test
 *
 * Requirements 7.3 and 8.3 are two-sided: a non-matching confirmation must
 * NOT enqueue, and the enqueue must happen only AFTER a matching one. A test
 * that only checked rejections would be satisfied by a route that never
 * enqueues at all, so every run below asserts BOTH directions from the same
 * generated string -- the exactly-`REVOKE` case must reach the queue (202,
 * exactly one `revoke_tak_certificates` operation with the exact payload) and
 * every other string must not (400, zero enqueues). The generator therefore
 * includes `'REVOKE'` itself as a named case rather than relying on
 * `fc.string()` to stumble onto it.
 *
 * ## What is real and what is mocked
 *
 * The real routes and the real strict comparison in
 * `server/routes/deviceManagement.js` are exercised end to end through
 * supertest, including express-validator and JSON body parsing, so the
 * property quantifies over strings as they actually arrive over HTTP.
 *
 * Mocked, following `server/routes/__tests__/deviceManagement.test.js`:
 *
 *   - `authenticateToken`/`authorize` are stubbed, so the request reaches the
 *     handler and the outcome is attributable to the confirmation gate rather
 *     than to an upstream auth rejection that would make the "not enqueued"
 *     half vacuous;
 *   - `DeviceManagementService`'s assertions RESOLVE, i.e. authorization
 *     passes on both routes. Property 7 is about the confirmation gate alone,
 *     and letting authorization pass is what makes a missing enqueue mean "the
 *     confirmation was rejected" and nothing else. The authorization gate
 *     itself is Properties 5 and 6 (tasks 16.5, 16.6);
 *   - `config/database` is mocked but never expected to be used: since task
 *     19.4 the enqueued payload is device-scoped (`{ client_uid,
 *     target_user_id }`), so the routes no longer look a username up in
 *     `users`. The mock stands in for that table so a reintroduced read would
 *     fail loudly rather than reach a real pool;
 *   - `EventPublisher.publishOperation` is the observable the property is
 *     stated in terms of -- the Revoke_Operation enqueue.
 *
 * Both routes are drawn in the same property (rather than split into two
 * tests) because design.md quantifies over "self or admin" as part of the
 * property's input space.
 *
 * **Validates: Requirements 7.3, 8.3**
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 7, userId: 7, is_global_manager: false };
    next();
  }
}));

jest.mock('../../middleware/authorize', () => (req, res, next) => next());

jest.mock('../../middleware/requestContext', () => ({
  getLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

jest.mock('../../services/EventPublisher', () => ({
  publishOperation: jest.fn()
}));

jest.mock('../../services/DeviceManagementService', () => ({
  listOwnDevices: jest.fn(),
  listManagedUserDevices: jest.fn(),
  assertCanRevokeOwn: jest.fn(),
  assertCanRevokeManaged: jest.fn()
}));

const express = require('express');
const request = require('supertest');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../../config/database');
const EventPublisher = require('../../services/EventPublisher');
const DeviceManagementService = require('../../services/DeviceManagementService');

const originalFlag = process.env.DEVICE_MGMT_ENABLED;
const originalRevokeFlag = process.env.DEVICE_MGMT_REVOKE_ENABLED;

/** The Revoke_Confirmation_Word. The ONLY string that may reach the queue. */
const REVOKE_CONFIRMATION_WORD = 'REVOKE';

const ACTING_USER_ID = 7;
const TARGET_USER_ID = 9;

// Confirmation strings. Arbitrary unicode strings cover the space, and the
// named cases pin the frontier immediately around the accepted word -- case
// variants, leading/trailing whitespace, the empty string, and prefix/suffix
// extensions -- which random generation would essentially never produce. The
// accepted word itself is included so the positive half of the "iff" is
// exercised on a meaningful share of runs rather than by luck.
const confirmationString = fc.oneof(
  { weight: 3, arbitrary: fc.string() },
  { weight: 2, arbitrary: fc.constant(REVOKE_CONFIRMATION_WORD) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      'revoke',
      'Revoke',
      'ReVoKe',
      ' REVOKE',
      'REVOKE ',
      ' REVOKE ',
      '\tREVOKE',
      'REVOKE\n',
      '',
      'REVOKED',
      'REVOK',
      'XREVOKE',
      'REVOKE!',
      'REVOKE REVOKE',
      'ＲＥＶＯＫＥ'
    )
  }
);

// The two revocation surfaces the property quantifies over, each with the
// device-scoped payload it must enqueue on the accepted confirmation (task
// 19.4): the Device named in ITS OWN path, and ITS OWN owner -- the caller on
// the self route, the `:userId` target on the admin route. The owner id is a
// number in both payloads even though it arrives as a route-param string on
// the admin path.
const ROUTES = {
  self: {
    path: '/api/device-management/me/devices/UID-OWN/revoke',
    expectedPayload: { client_uid: 'UID-OWN', target_user_id: ACTING_USER_ID }
  },
  admin: {
    path: `/api/device-management/users/${TARGET_USER_ID}/devices/UID-MANAGED/revoke`,
    expectedPayload: { client_uid: 'UID-MANAGED', target_user_id: TARGET_USER_ID }
  }
};

const routeKind = fc.constantFrom('self', 'admin');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/device-management', require('../deviceManagement'));
  return app;
}

/**
 * The routes must not query the database on either path -- the device-scoped
 * payload is built from the route params and `req.user` alone. Rejecting makes
 * that load-bearing: a reintroduced read would turn the accepted-confirmation
 * half of the property into a 500 instead of a 202.
 */
function forbidDatabaseReads() {
  pool.query.mockRejectedValue(new Error('the revoke routes must not query the database'));
}

// Feature: device-management, Property 7: Revoke enqueue only after REVOKE confirmation
describe('Property 7: Revoke enqueue only after REVOKE confirmation', () => {
  let app;

  beforeAll(() => {
    // The routes are inert while Device_Mgmt_Enabled is false (Property 2), so
    // the flag has to be on for the confirmation gate to be the deciding
    // factor at all.
    process.env.DEVICE_MGMT_ENABLED = 'true';
    // Likewise the revoke routes reject while Revoke_Enabled is false
    // (Requirements 12.9, 12.10, task 24.2), and that gate sits ahead of the
    // confirmation check, so revocation has to be ARMED for the confirmation
    // word to be the deciding factor here.
    process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
    app = buildApp();
  });

  afterAll(() => {
    if (originalFlag === undefined) {
      delete process.env.DEVICE_MGMT_ENABLED;
    } else {
      process.env.DEVICE_MGMT_ENABLED = originalFlag;
    }

    if (originalRevokeFlag === undefined) {
      delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
    } else {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = originalRevokeFlag;
    }
  });

  test.prop([confirmationString, routeKind], { numRuns: 300 })(
    'the Revoke_Operation is enqueued iff the confirmation is exactly REVOKE',
    async (confirmation, kind) => {
      jest.clearAllMocks();

      // Authorization passes on both routes, so the enqueue decision below is
      // the confirmation gate's alone.
      DeviceManagementService.assertCanRevokeOwn.mockResolvedValue({ clientUid: 'UID-OWN' });
      DeviceManagementService.assertCanRevokeManaged.mockResolvedValue({ clientUid: 'UID-MANAGED' });
      EventPublisher.publishOperation.mockResolvedValue({ id: 1 });
      forbidDatabaseReads();

      const route = ROUTES[kind];
      const res = await request(app).post(route.path).send({ confirmation });

      if (confirmation === REVOKE_CONFIRMATION_WORD) {
        // Enqueued: accepted for later processing by the Sync_Worker, exactly
        // one operation, with the device-scoped payload the handler consumes
        // and the acting user recorded as `created_by`.
        expect(res.status).toBe(202);
        expect(res.body).toEqual({ enqueued: true });
        expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
        expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
          'revoke_tak_certificates',
          route.expectedPayload,
          ACTING_USER_ID
        );
      } else {
        // Not enqueued, and the revocation did not proceed: the request is
        // rejected as a bad request with the confirmation-specific message,
        // and the queue was never touched.
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Type REVOKE exactly to confirm this revocation' });
        expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
      }
    }
  );
});
