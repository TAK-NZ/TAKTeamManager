/**
 * Route/authorization tests for `server/routes/deviceManagement.js`
 * (device-management task 13.2).
 *
 * Covers the three things the routes add on top of
 * `DeviceManagementService` (whose own rules are covered by
 * `server/services/__tests__/DeviceManagementService.test.js`):
 *
 *   1. the Device_Mgmt_Enabled 404 gate on all four routes, with nothing
 *      past it running (Requirements 1.8, 1.9);
 *   2. that the self routes are scoped to `req.user.userId` and that the
 *      admin routes surface a service denial as 403, before any enqueue
 *      (Requirements 5.5, 6.6, 6.7, 7.5, 8.5, 8.6);
 *   3. the ordering of the revoke pipeline -- authorize, then a STRICT
 *      `confirmation === 'REVOKE'` check, then exactly one
 *      `revoke_tak_certificates` enqueue carrying the DEVICE-SCOPED payload
 *      `{ client_uid, target_user_id }` (Requirements 7.3, 7.4, 8.3, 8.4,
 *      12.1). The user-scoped `{ tak_usernames: [...] }` shape these routes
 *      used to send is what over-revokes: it revokes every certificate the
 *      owner holds across all their Devices, so the payload assertions below
 *      pin the device-scoped shape specifically, and pin that NOTHING keyed
 *      on a username is sent (task 19.4).
 *
 * These are example/unit tests. Property 7 ("enqueued iff the confirmation
 * is exactly `REVOKE`") gets its own fast-check test in
 * `deviceManagement.confirmation.property.test.js` (task 16.7); the cases
 * below pin the concrete statuses, bodies, and call arguments that a
 * property over confirmation strings does not describe.
 *
 * `authenticateToken` and `authorize` are stubbed (the established pattern
 * in `server/routes/users.create-and-add.test.js`) so each assertion below
 * isolates the HANDLER's own authorization behavior: the real
 * Permission_Registry entries and the `device_mgmt:*:managed` row-scoped
 * resolvers are covered by
 * `server/config/__tests__/permissions.registry.test.js` (task 12.2). That
 * separation is what makes the 403s below meaningful -- they prove the
 * handler re-asserts the row rule itself rather than relying on the
 * middleware that normally runs in front of it.
 *
 * `DeviceManagementService` is mocked at its static-method boundary,
 * including its two named error classes, because the handlers branch purely
 * on `error.name`.
 */

// The routes no longer read `users` at all (task 19.4 dropped the username
// lookup the user-scoped payload needed). The revoke path DOES now write a
// best-effort `device.revoke_requested` audit_logs row via writeAuditLog, so
// `pool.query` is called once (that INSERT) -- the invariant these tests
// protect is narrower: no query against the `users` TABLE is issued. See the
// `usersTableQueried` helper below.
jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

let mockUser = { id: 7, userId: 7, is_global_manager: false };

jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  }
}));

jest.mock('../../middleware/authorize', () => (req, res, next) => next());

jest.mock('../../middleware/requestContext', () => ({
  getLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

jest.mock('../../services/EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue({ id: 1 })
}));

jest.mock('../../services/DeviceManagementService', () => {
  class NotManagedUserError extends Error {
    constructor(actingUserId = 7, targetUserId = 99) {
      super(`User ${targetUserId} is not a managed user of user ${actingUserId}`);
      this.name = 'NotManagedUserError';
    }
  }
  class DeviceNotOwnedError extends Error {
    constructor(clientUid = 'UID-1', expectedUserId = 7) {
      super(`Device ${clientUid} does not belong to user ${expectedUserId}`);
      this.name = 'DeviceNotOwnedError';
    }
  }

  return {
    listOwnDevices: jest.fn(),
    listManagedUserDevices: jest.fn(),
    assertCanRevokeOwn: jest.fn(),
    assertCanRevokeManaged: jest.fn(),
    NotManagedUserError,
    DeviceNotOwnedError
  };
});

const express = require('express');
const request = require('supertest');
const pool = require('../../config/database');
const EventPublisher = require('../../services/EventPublisher');
const DeviceManagementService = require('../../services/DeviceManagementService');

const { NotManagedUserError, DeviceNotOwnedError } = DeviceManagementService;

// True iff any pool.query call touched the `users` table. The revoke path must
// stay device-scoped (keyed on client_uid) and never consult `users`; it may,
// however, INSERT INTO audit_logs. This lets the "no users read" invariant be
// asserted without also forbidding the (allowed) audit write.
function usersTableQueried() {
  return pool.query.mock.calls.some(
    ([sql]) => typeof sql === 'string' && /\busers\b/.test(sql) && !/audit_logs/.test(sql)
  );
}

const originalFlag = process.env.DEVICE_MGMT_ENABLED;
const originalRevokeFlag = process.env.DEVICE_MGMT_REVOKE_ENABLED;

/** A Device in the shape `DeviceManagementService.mapDevice` returns. */
const OWN_DEVICE = {
  clientUid: 'UID-OWN',
  certId: 41,
  issuedAt: '2025-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:00:00.000Z',
  lastSeenAt: null,
  revoked: false
};

const MANAGED_DEVICE = {
  clientUid: 'UID-MANAGED',
  certId: 42,
  issuedAt: '2025-02-01T00:00:00.000Z',
  expiresAt: '2026-02-01T00:00:00.000Z',
  lastSeenAt: '2025-03-01T00:00:00.000Z',
  revoked: false
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/device-management', require('../deviceManagement'));
  return app;
}

/** Every route, as `[label, () => supertest request]` for the flag gate. */
function allRoutes(app) {
  return [
    ['GET /me/devices', () => request(app).get('/api/device-management/me/devices')],
    ['GET /users/:userId/devices', () => request(app).get('/api/device-management/users/9/devices')],
    [
      'POST /me/devices/:clientUid/revoke',
      () => request(app).post('/api/device-management/me/devices/UID-OWN/revoke').send({ confirmation: 'REVOKE' })
    ],
    [
      'POST /users/:userId/devices/:clientUid/revoke',
      () => request(app)
        .post('/api/device-management/users/9/devices/UID-MANAGED/revoke')
        .send({ confirmation: 'REVOKE' })
    ]
  ];
}

describe('device-management routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = { id: 7, userId: 7, is_global_manager: false };
    process.env.DEVICE_MGMT_ENABLED = 'true';
    // Revoke_Enabled is an INDEPENDENT flag defaulting to false, and the two
    // revoke routes now answer 403 while it is off (Requirements 12.9, 12.10,
    // task 24.2). The cases below are about the OTHER gates, so revocation is
    // armed here; the disarmed-path assertions belong to task 24.4.
    process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
    DeviceManagementService.listOwnDevices.mockResolvedValue([OWN_DEVICE]);
    DeviceManagementService.listManagedUserDevices.mockResolvedValue([MANAGED_DEVICE]);
    DeviceManagementService.assertCanRevokeOwn.mockResolvedValue(OWN_DEVICE);
    DeviceManagementService.assertCanRevokeManaged.mockResolvedValue(MANAGED_DEVICE);
    EventPublisher.publishOperation.mockResolvedValue({ id: 1 });
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

  // Requirements 1.8, 1.9: WHILE Device_Mgmt_Enabled is false every route is
  // unreachable, and nothing past the flag check runs -- no Device_Table read
  // through the service and, on the revoke paths, no Revoke_Operation enqueue,
  // even though these requests carry a valid `REVOKE` confirmation and would
  // otherwise succeed. The 404 body matches `server/index.js`'s catch-all so a
  // disabled feature is indistinguishable from one that does not exist; the
  // client's reachability probe relies on exactly this response.
  describe('with Device_Mgmt_Enabled false', () => {
    it.each([
      ['false'],
      ['TRUE'],
      ['1'],
      [undefined]
    ])('returns 404 from every route when DEVICE_MGMT_ENABLED is %p', async (value) => {
      if (value === undefined) {
        delete process.env.DEVICE_MGMT_ENABLED;
      } else {
        process.env.DEVICE_MGMT_ENABLED = value;
      }

      for (const [, send] of allRoutes(app)) {
        const res = await send();
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Route not found' });
      }

      expect(DeviceManagementService.listOwnDevices).not.toHaveBeenCalled();
      expect(DeviceManagementService.listManagedUserDevices).not.toHaveBeenCalled();
      expect(DeviceManagementService.assertCanRevokeOwn).not.toHaveBeenCalled();
      expect(DeviceManagementService.assertCanRevokeManaged).not.toHaveBeenCalled();
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });
  });

  // Requirements 12.9, 12.10 (task 24.4): WHILE Revoke_Enabled is false both
  // revoke routes refuse, with a distinct NON-404 client error naming the
  // disabled capability, and nothing is enqueued. 404 is deliberately excluded:
  // that response already means Device_Mgmt_Enabled is off (Requirement 1.8),
  // so reusing it here would make "device management is absent" and
  // "revocation is disarmed" indistinguishable to a caller.
  //
  // The read routes are gated on Device_Mgmt_Enabled ALONE, so they must keep
  // working with only `DEVICE_MGMT_ENABLED` on -- an operator who wants
  // visibility without arming revocation is exactly the case the second flag
  // exists to serve.
  describe('with Revoke_Enabled false', () => {
    const revokeRoutes = () => [
      [
        'POST /me/devices/:clientUid/revoke',
        (app) => request(app)
          .post('/api/device-management/me/devices/UID-OWN/revoke')
          .send({ confirmation: 'REVOKE' })
      ],
      [
        'POST /users/:userId/devices/:clientUid/revoke',
        (app) => request(app)
          .post('/api/device-management/users/9/devices/UID-MANAGED/revoke')
          .send({ confirmation: 'REVOKE' })
      ]
    ];

    // Every non-exactly-'true' value leaves revocation disarmed, including the
    // near-misses the boolean-env convention rejects.
    const disarmedValues = [['false'], ['TRUE'], ['1'], [''], [undefined]];

    describe.each(disarmedValues)('when DEVICE_MGMT_REVOKE_ENABLED is %p', (value) => {
      beforeEach(() => {
        if (value === undefined) {
          delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
        } else {
          process.env.DEVICE_MGMT_REVOKE_ENABLED = value;
        }
      });

      it.each(revokeRoutes())('refuses %s with a non-404 error naming the capability, enqueueing nothing', async (_label, send) => {
        const res = await send(app);

        expect(res.status).not.toBe(404);
        expect(res.status).toBe(403);
        expect(res.body).toEqual({
          error: 'Device revocation is disabled',
          capability: 'DEVICE_MGMT_REVOKE_ENABLED'
        });
        // The gate sits before the enqueue: no Revoke_Operation reaches the
        // queue, even though these requests carry a valid `REVOKE` confirmation
        // and an authorized, owned device.
        expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
        expect(pool.query).not.toHaveBeenCalled();
      });

      it('still serves both read routes, which are gated on DEVICE_MGMT_ENABLED alone', async () => {
        const self = await request(app).get('/api/device-management/me/devices');
        expect(self.status).toBe(200);
        expect(self.body).toEqual({ devices: [OWN_DEVICE] });

        const managed = await request(app).get('/api/device-management/users/9/devices');
        expect(managed.status).toBe(200);
        expect(managed.body).toEqual({ devices: [MANAGED_DEVICE] });

        expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
      });
    });

    // The two flags are independent in both directions: arming revocation does
    // not make the feature reachable, so a request with only
    // DEVICE_MGMT_REVOKE_ENABLED on is still the 404 of a disabled feature --
    // not a 403, and still no enqueue.
    it('returns 404 (not 403) from the revoke routes when only DEVICE_MGMT_REVOKE_ENABLED is on', async () => {
      delete process.env.DEVICE_MGMT_ENABLED;
      process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';

      for (const [, send] of revokeRoutes()) {
        const res = await send(app);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Route not found' });
      }

      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });
  });

  // Requirement 5.5: the self-view is scoped on the server, not in the UI.
  describe('GET /me/devices', () => {
    it('returns the caller\'s own devices, scoped by req.user.userId', async () => {
      const res = await request(app).get('/api/device-management/me/devices');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ devices: [OWN_DEVICE] });
      expect(DeviceManagementService.listOwnDevices).toHaveBeenCalledWith(7);
    });

    it('ignores any request-supplied user filter and still scopes to the caller', async () => {
      mockUser = { id: 7, userId: 7, is_global_manager: false };

      const res = await request(app).get('/api/device-management/me/devices?userId=9&user_id=9');

      expect(res.status).toBe(200);
      expect(DeviceManagementService.listOwnDevices).toHaveBeenCalledTimes(1);
      expect(DeviceManagementService.listOwnDevices).toHaveBeenCalledWith(7);
    });
  });

  // Requirements 6.6, 6.7: an admin's view reaches Managed_Users only, and a
  // request for a non-Managed_User is denied -- server-side.
  describe('GET /users/:userId/devices', () => {
    it('returns a managed user\'s devices in the same shape as the self-view', async () => {
      const res = await request(app).get('/api/device-management/users/9/devices');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ devices: [MANAGED_DEVICE] });
      expect(DeviceManagementService.listManagedUserDevices).toHaveBeenCalledWith(mockUser, '9');
    });

    it('returns 403 when the target is not a managed user of the caller', async () => {
      DeviceManagementService.listManagedUserDevices.mockRejectedValue(new NotManagedUserError(7, 9));

      const res = await request(app).get('/api/device-management/users/9/devices');

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('User 9 is not a managed user of user 7');
    });

    it('returns 400 for a non-integer userId without consulting the service', async () => {
      const res = await request(app).get('/api/device-management/users/not-an-id/devices');

      expect(res.status).toBe(400);
      expect(DeviceManagementService.listManagedUserDevices).not.toHaveBeenCalled();
    });
  });

  // Requirements 7.3, 7.4, 7.5.
  describe('POST /me/devices/:clientUid/revoke', () => {
    const revoke = (body) => request(app)
      .post('/api/device-management/me/devices/UID-OWN/revoke')
      .send(body);

    it('enqueues exactly one revoke_tak_certificates operation after a REVOKE confirmation', async () => {
      const res = await revoke({ confirmation: 'REVOKE' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ enqueued: true });
      expect(DeviceManagementService.assertCanRevokeOwn).toHaveBeenCalledWith(7, 'UID-OWN');
      // Requirements 7.4, 12.1: the DEVICE-scoped payload -- keyed on the
      // `:clientUid` being revoked, with the owning user id (here the caller)
      // carried only for traceability, and the acting user recorded as
      // `created_by`. `toHaveBeenCalledWith` is an exact-equality match on the
      // payload object, so this also pins that no `tak_usernames` key rides
      // along: that shape would revoke every certificate the caller holds on
      // every other Device too.
      expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
      expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
        'revoke_tak_certificates',
        { client_uid: 'UID-OWN', target_user_id: 7 },
        7
      );
      // No username resolution happens any more -- `client_uid` is the key --
      // so the revoke path issues no `users`-table query. It DOES now write a
      // best-effort 'device.revoke_requested' audit_logs row, so assert on the
      // absence of a users read specifically rather than on pool.query never
      // being called.
      expect(usersTableQueried()).toBe(false);
      // The revocation REQUEST is audited (resource = target user, device UID
      // in details; no cert material). The worker writes its own
      // revoke_audit/result records for the execution separately.
      const auditCall = pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO audit_logs')
      );
      expect(auditCall).toBeDefined();
      expect(auditCall[1]).toEqual([7, 'device.revoke_requested', 'user', 7, JSON.stringify({ clientUid: 'UID-OWN' })]);
    });

    // Requirement 7.3: strict equality -- no trimming, no case folding, and a
    // missing/non-string value takes the same rejected path.
    it.each([
      ['revoke'],
      ['Revoke'],
      [' REVOKE'],
      ['REVOKE '],
      ['REVOKED'],
      ['']
    ])('returns 400 and enqueues nothing for confirmation %p', async (confirmation) => {
      const res = await revoke({ confirmation });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Type REVOKE exactly to confirm this revocation' });
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('returns 400 and enqueues nothing when confirmation is absent', async () => {
      const res = await revoke({});

      expect(res.status).toBe(400);
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    // Requirement 7.5 / 9.3: only the caller's OWN devices, enforced here.
    it('returns 403 and enqueues nothing when the device is not the caller\'s', async () => {
      DeviceManagementService.assertCanRevokeOwn.mockRejectedValue(new DeviceNotOwnedError('UID-OWN', 7));

      const res = await revoke({ confirmation: 'REVOKE' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Device UID-OWN does not belong to user 7');
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    // Ordering: ownership is asserted BEFORE the confirmation word, so an
    // unauthorized attempt is rejected as unauthorized (403) rather than
    // leaking that the confirmation was the only thing wrong.
    it('asserts ownership before the confirmation check', async () => {
      DeviceManagementService.assertCanRevokeOwn.mockRejectedValue(new DeviceNotOwnedError('UID-OWN', 7));

      const res = await revoke({ confirmation: 'nope' });

      expect(res.status).toBe(403);
      expect(DeviceManagementService.assertCanRevokeOwn).toHaveBeenCalledWith(7, 'UID-OWN');
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    // Task 19.4 removed the `SELECT username FROM users` lookup and, with it,
    // the 409 "the device owner has no resolvable TAK username" branch this
    // case used to assert: the device-scoped payload is keyed on `client_uid`,
    // so a revocation no longer depends on the owner's `users` row in any way
    // and no state of that row can refuse one. The rejecting mock makes the
    // absence of the lookup load-bearing rather than incidental -- any
    // reintroduced `users` read would surface as a 500 here.
    it('enqueues without reading the users table at all', async () => {
      // Reject ONLY a `users`-table query (not the allowed audit_logs INSERT),
      // so any reintroduced `users` read surfaces here while the best-effort
      // audit write is permitted. The audit INSERT resolves normally.
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && /\busers\b/.test(sql) && !/audit_logs/.test(sql)) {
          return Promise.reject(new Error('the users table must not be consulted'));
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await revoke({ confirmation: 'REVOKE' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ enqueued: true });
      expect(usersTableQueried()).toBe(false);
      expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
        'revoke_tak_certificates',
        { client_uid: 'UID-OWN', target_user_id: 7 },
        7
      );
    });
  });

  // Requirements 8.3, 8.4, 8.5, 8.6.
  describe('POST /users/:userId/devices/:clientUid/revoke', () => {
    const revoke = (body) => request(app)
      .post('/api/device-management/users/9/devices/UID-MANAGED/revoke')
      .send(body);

    it('enqueues the target device scoped to the TARGET user, attributed to the acting admin', async () => {
      const res = await revoke({ confirmation: 'REVOKE' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ enqueued: true });
      expect(DeviceManagementService.assertCanRevokeManaged).toHaveBeenCalledWith(mockUser, '9', 'UID-MANAGED');
      expect(usersTableQueried()).toBe(false);
      expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);
      // Requirements 8.4, 12.1: the admin's device-scoped payload names the
      // TARGET's device and the TARGET's user id, while the acting admin is
      // recorded only as `created_by`. `target_user_id` is a NUMBER even
      // though `:userId` arrives as the string `'9'` -- the operation schema
      // declares it `'number'`, so the route coerces it.
      expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
        'revoke_tak_certificates',
        { client_uid: 'UID-MANAGED', target_user_id: 9 },
        7
      );
      const [, payload] = EventPublisher.publishOperation.mock.calls[0];
      expect(typeof payload.target_user_id).toBe('number');
    });

    // Requirement 8.3.
    it.each([
      ['revoke'],
      [' REVOKE '],
      ['REVOKE!']
    ])('returns 400 and enqueues nothing for confirmation %p', async (confirmation) => {
      const res = await revoke({ confirmation });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Type REVOKE exactly to confirm this revocation' });
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    // Requirement 8.6: a non-Managed_User target is denied...
    it('returns 403 and enqueues nothing when the target is not a managed user', async () => {
      DeviceManagementService.assertCanRevokeManaged.mockRejectedValue(new NotManagedUserError(7, 9));

      const res = await revoke({ confirmation: 'REVOKE' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('User 9 is not a managed user of user 7');
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    // ...and Requirement 8.5: that denial happens upfront, before the
    // confirmation check and therefore before any possible enqueue.
    it('asserts managed-user + ownership before the confirmation check', async () => {
      DeviceManagementService.assertCanRevokeManaged.mockRejectedValue(new NotManagedUserError(7, 9));

      const res = await revoke({ confirmation: 'not-the-word' });

      expect(res.status).toBe(403);
      expect(DeviceManagementService.assertCanRevokeManaged).toHaveBeenCalledWith(mockUser, '9', 'UID-MANAGED');
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('returns 403 and enqueues nothing when the device does not belong to the target', async () => {
      DeviceManagementService.assertCanRevokeManaged.mockRejectedValue(
        new DeviceNotOwnedError('UID-MANAGED', 9)
      );

      const res = await revoke({ confirmation: 'REVOKE' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Device UID-MANAGED does not belong to user 9');
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-integer userId without consulting the service or the queue', async () => {
      const res = await request(app)
        .post('/api/device-management/users/abc/devices/UID-MANAGED/revoke')
        .send({ confirmation: 'REVOKE' });

      expect(res.status).toBe(400);
      expect(DeviceManagementService.assertCanRevokeManaged).not.toHaveBeenCalled();
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });
  });

  // Requirements 7.4, 8.4 (task 19.7): the same payload-shape assertion applied
  // to BOTH revoke routes in one place, keyed on what must NOT be there.
  //
  // The per-route cases above pin each route's expected payload by equality;
  // these pin the property that equality is standing in for -- the enqueued
  // payload carries the device discriminator and nothing keyed on a username,
  // for either route. `{ tak_usernames: [...] }` is a VALID payload for this
  // operation (the pre-existing user-scoped call sites still send it, and
  // Requirement 12.3 keeps it working), so nothing downstream would reject it
  // if a revoke route regressed into sending it -- it would simply revoke every
  // certificate the owner holds across all their Devices. This is the assertion
  // that catches that, so the key-set check is exhaustive rather than a spot
  // check for `tak_usernames` alone.
  describe('the enqueued payload is device-scoped on both revoke routes (7.4, 8.4)', () => {
    it.each([
      [
        'POST /me/devices/:clientUid/revoke',
        () => request(app)
          .post('/api/device-management/me/devices/UID-OWN/revoke')
          .send({ confirmation: 'REVOKE' }),
        { client_uid: 'UID-OWN', target_user_id: 7 }
      ],
      [
        'POST /users/:userId/devices/:clientUid/revoke',
        () => request(app)
          .post('/api/device-management/users/9/devices/UID-MANAGED/revoke')
          .send({ confirmation: 'REVOKE' }),
        { client_uid: 'UID-MANAGED', target_user_id: 9 }
      ]
    ])('%s enqueues { client_uid, target_user_id } and nothing keyed on a username', async (_label, send, expectedPayload) => {
      const res = await send();

      expect(res.status).toBe(202);
      expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(1);

      const [operationType, payload, createdBy] = EventPublisher.publishOperation.mock.calls[0];
      expect(operationType).toBe('revoke_tak_certificates');
      expect(payload).toEqual(expectedPayload);
      // Exactly these two keys -- no third field rides along, and in particular
      // no username-keyed one under any spelling.
      expect(Object.keys(payload).sort()).toEqual(['client_uid', 'target_user_id']);
      expect(payload.tak_usernames).toBeUndefined();
      expect(Object.keys(payload).filter((key) => /user_?name/i.test(key))).toEqual([]);
      // The acting user is attribution (`created_by`), never the scope.
      expect(createdBy).toBe(7);
      // And no username was even looked up to arrive at that payload -- the
      // only pool.query the route makes is the best-effort audit_logs INSERT,
      // never a `users` read.
      expect(usersTableQueried()).toBe(false);
    });
  });
});
