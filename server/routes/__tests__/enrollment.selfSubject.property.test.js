// Feature: takserver-enrollment, Property 4: Self-enrollment resolves its subject from the session alone
//
// **Validates: Requirements 3.3, 3.4, 14.5**

/**
 * takserver-enrollment task 8.7: the single fast-check property test for
 * design.md's Property 4 (Requirements 3.3, 3.4, 14.5).
 *
 * `POST /api/enrollment/me`'s handler takes no route parameter and its ONLY
 * call into `DeviceEnrollmentService` is `generateSelfEnrollment(req.user)`
 * (Criterion 3.4: no caller-supplied subject at all). This property proves
 * that at the HTTP-handler boundary directly, rather than trusting the
 * handler's source text to stay that way: the route's real Express handler
 * is extracted from `server/routes/enrollment.js`'s router (bypassing
 * `authenticateToken`/`authorize`, which this property is not about) and
 * invoked with a synthetic `req` object whose `body`, `query` and `params`
 * carry an ARBITRARY, adversarial mix of decoy identifier-shaped keys --
 * `userId`, `deviceUserId`, `user_id`, `sub`, `id`, `principalId`,
 * `__proto__`, `constructor` -- each decoy's value drawn from three kinds:
 * a plain number equal to a DIFFERENT ("other") principal's id, the numeric
 * STRING form of that same other id, or an object whose `valueOf` throws.
 * `req.user` itself carries the same decoy shape merged in (minus the two
 * keys the property actually needs, `userId`/`is_global_manager`, which are
 * always set explicitly afterward so the merge can never accidentally
 * overwrite them) -- satisfying "crossed with arbitrary `req.user`" without
 * losing the one thing every run needs to assert against.
 *
 * `DeviceEnrollmentService` and `authentikSync`-adjacent dependencies are
 * NOT mocked at the service boundary -- only `User.findById` (the "mocked
 * row lookup" design.md's own property statement names explicitly) and the
 * service's other I/O dependencies (`pool`, `authentikService`, `QRCode`)
 * are mocked, so the REAL `generateSelfEnrollment`/`#buildEnrollment`
 * subject-resolution logic runs underneath the property. This is what makes
 * "assert on the mocked row lookup's arguments, so a read that happens and
 * is then ignored still fails" possible: `User.findById` is asserted to
 * have been called EXACTLY ONCE, with EXACTLY `req.user.userId`, regardless
 * of what the generated `body`/`query`/`params`/`req.user` decoys contain.
 * The "other" principal id is a genuinely DIFFERENT id from the acting
 * user's own, and `User.findById` is scripted to return a DIFFERENT,
 * independently-identifiable row for it -- so a hypothetical implementation
 * that read a decoy field instead of `req.user.userId` would either call
 * `User.findById` with the wrong argument (caught directly by the
 * `toHaveBeenCalledWith` assertion) or resolve the wrong principal
 * (independently checkable by `toHaveBeenCalledTimes(1)` combined with the
 * `authentikService.createAppPasswordToken` argument on the success path).
 *
 * `__proto__` and `constructor` decoys are added as genuine OWN properties
 * via `Object.defineProperty` (never a literal `{__proto__: ...}`, which the
 * language specially parses as prototype assignment rather than as an own
 * property) -- so they exercise the actual prototype-pollution-shaped
 * surface the design calls out: "a subject resolution that reaches into a
 * request object by key name is a prototype-pollution surface".
 *
 * A hostile decoy value's `valueOf` throwing is deliberately never
 * defused: if the subject-resolution code path ever coerced one of these
 * fields (e.g. `Number(req.body.userId)`), the call would throw and the
 * property run would fail with that exception, which is the intended
 * failure signal -- no `try`/`catch` around the handler invocation
 * suppresses it.
 *
 * ## Boundary / case concentration
 *
 * `resolvedRowIsDevice` is drawn as a plain boolean, giving both halves of
 * Criterion 14.5's "REFUSED rather than built" statement a genuinely 50/50
 * share of runs rather than leaving the device case to chance.
 *
 * ## Anti-vacuity
 *
 * Module-level counters record, across the whole run: at least one
 * `resolvedRowIsDevice = true` and one `= false` case; at least one decoy
 * object landing in each of `body`/`query`/`params` non-empty; and at least
 * one occurrence each of a hostile-`valueOf` decoy value, a numeric-string
 * decoy value, a literal `__proto__` decoy key and a literal `constructor`
 * decoy key. The trailing `it()` asserts every one of these `> 0`.
 */

jest.mock('../../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('../../models/Team', () => ({
  isAdmin: jest.fn(),
  getAncestorChain: jest.fn()
}));
jest.mock('../../services/TeamMembershipService', () => ({
  addUserToTeam: jest.fn()
}));
jest.mock('../../services/EventPublisher', () => ({
  publishOperation: jest.fn()
}));
jest.mock('../../services/authentik', () => ({
  createUser: jest.fn(),
  createAppPasswordToken: jest.fn()
}));
jest.mock('../../models/User', () => ({
  findById: jest.fn()
}));
jest.mock('../../services/userAttributes', () => ({
  generateCallsign: jest.fn()
}));
jest.mock('qrcode', () => ({
  toDataURL: jest.fn()
}));
jest.mock('../../config/logger', () => {
  const instance = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  instance.child = jest.fn(() => instance);
  instance.createLogger = jest.fn(() => instance);
  return instance;
});

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../../config/database');
const authentikService = require('../../services/authentik');
const User = require('../../models/User');
const QRCode = require('qrcode');
const enrollmentRouter = require('../enrollment');

// ---------------------------------------------------------------------------
// Extract the REAL `POST /me` handler from the router, bypassing
// `authenticateToken`/`authorize` (not this property's subject) so the
// synthetic `req` below reaches the actual route logic directly.
// ---------------------------------------------------------------------------

function getRouteHandler(router, method, path) {
  const layer = router.stack.find(
    (candidate) => candidate.route && candidate.route.path === path && candidate.route.methods[method]
  );
  if (!layer) {
    throw new Error(`No route found for ${method.toUpperCase()} ${path}`);
  }
  const routeLayers = layer.route.stack;
  return routeLayers[routeLayers.length - 1].handle;
}

const selfEnrollHandler = getRouteHandler(enrollmentRouter, 'post', '/me');

function buildRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: undefined
  };
  res.set = (name, value) => {
    res._headers[name] = value;
    return res;
  };
  res.status = (code) => {
    res._status = code;
    return res;
  };
  res.json = (body) => {
    res._body = body;
    return res;
  };
  return res;
}

// ---------------------------------------------------------------------------
// Decoy generation: identifier-shaped keys, adversarial values, and a
// hostile-valueOf probe that can be recognized WITHOUT invoking it.
// ---------------------------------------------------------------------------

const DECOY_KEYS = ['userId', 'deviceUserId', 'user_id', 'sub', 'id', 'principalId', '__proto__', 'constructor'];

/** Sets `key` as a genuine OWN property via defineProperty -- never a
 * literal `{__proto__: value}`, which the language specially parses as a
 * prototype assignment rather than an own property, for `__proto__`
 * specifically. */
function setOwnKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
  return obj;
}

/** A hostile decoy value: `valueOf` throws if invoked. Recognizable via the
 * non-enumerable `__isHostileProbe` marker, so anti-vacuity tracking never
 * has to invoke (and trigger) the hostile accessor itself. */
function hostileValueOfObject() {
  const obj = { toString() { return 'safe-tostring'; } };
  Object.defineProperty(obj, 'valueOf', {
    value() { throw new Error('hostile valueOf'); },
    enumerable: false
  });
  Object.defineProperty(obj, '__isHostileProbe', { value: true, enumerable: false });
  return obj;
}

function decoyValueArb(otherPrincipalId) {
  return fc.oneof(
    fc.constant(otherPrincipalId),
    fc.constant(String(otherPrincipalId)),
    fc.constant(hostileValueOfObject())
  );
}

/** An object carrying a random SUBSET of `DECOY_KEYS`, each independently
 * present-or-absent, each present value drawn from `decoyValueArb`. */
function decoyRecordArb(otherPrincipalId) {
  const perKeyArb = fc.option(decoyValueArb(otherPrincipalId), { nil: undefined });
  return fc
    .record(
      DECOY_KEYS.reduce((acc, key) => {
        acc[key] = perKeyArb;
        return acc;
      }, {}),
      { requiredKeys: [] }
    )
    .map((record) => {
      const obj = {};
      for (const key of DECOY_KEYS) {
        if (record[key] !== undefined) {
          setOwnKey(obj, key, record[key]);
        }
      }
      return obj;
    });
}

const idPairArb = fc
  .tuple(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 100000 }))
  .map(([a, b]) => (a === b ? [a, b + 1] : [a, b]))
  .map(([actualUserId, otherPrincipalId]) => ({ actualUserId, otherPrincipalId }));

const scenarioArb = idPairArb.chain(({ actualUserId, otherPrincipalId }) =>
  fc.record({
    actualUserId: fc.constant(actualUserId),
    otherPrincipalId: fc.constant(otherPrincipalId),
    isGlobalManager: fc.boolean(),
    resolvedRowIsDevice: fc.boolean(),
    userDecoys: decoyRecordArb(otherPrincipalId),
    body: decoyRecordArb(otherPrincipalId),
    query: decoyRecordArb(otherPrincipalId),
    params: decoyRecordArb(otherPrincipalId)
  })
);

// ---------------------------------------------------------------------------
// Anti-vacuity tracking
// ---------------------------------------------------------------------------

const seen = {
  device: 0,
  human: 0,
  bodyNonEmpty: 0,
  queryNonEmpty: 0,
  paramsNonEmpty: 0,
  hostileValue: 0,
  numericStringValue: 0,
  protoKey: 0,
  constructorKey: 0
};

function recordDecoyShapes(obj, otherPrincipalId) {
  const keys = Object.keys(obj);
  const flags = { nonEmpty: keys.length > 0 };
  for (const key of keys) {
    const value = obj[key];
    if (key === '__proto__') seen.protoKey += 1;
    if (key === 'constructor') seen.constructorKey += 1;
    if (value && typeof value === 'object' && value.__isHostileProbe === true) {
      seen.hostileValue += 1;
    }
    if (typeof value === 'string' && value === String(otherPrincipalId)) {
      seen.numericStringValue += 1;
    }
  }
  return flags;
}

// Feature: takserver-enrollment, Property 4: Self-enrollment resolves its subject from the session alone
describe('Property 4: Self-enrollment resolves its subject from the session alone', () => {
  test.prop([scenarioArb], { numRuns: 200 })(
    'resolves the subject from req.user.userId alone, reads no identifier from body/query/params, and refuses a Team_Owned_Device row',
    async ({ actualUserId, otherPrincipalId, isGlobalManager, resolvedRowIsDevice, userDecoys, body, query, params }) => {
      jest.clearAllMocks();

      if (resolvedRowIsDevice) seen.device += 1;
      else seen.human += 1;
      const bodyFlags = recordDecoyShapes(body, otherPrincipalId);
      const queryFlags = recordDecoyShapes(query, otherPrincipalId);
      const paramsFlags = recordDecoyShapes(params, otherPrincipalId);
      if (bodyFlags.nonEmpty) seen.bodyNonEmpty += 1;
      if (queryFlags.nonEmpty) seen.queryNonEmpty += 1;
      if (paramsFlags.nonEmpty) seen.paramsNonEmpty += 1;
      // req.user's own decoys are scanned too, so the anti-vacuity counters
      // reflect the full "crossed with arbitrary req.user" input space.
      recordDecoyShapes(userDecoys, otherPrincipalId);

      // The ACTUAL acting-user row and a DELIBERATELY DIFFERENT "other
      // principal" row -- the two independently identifiable outcomes a
      // misresolved subject would produce.
      const actualRow = {
        id: actualUserId,
        username: `user-${actualUserId}`,
        authentik_user_id: 500000 + actualUserId,
        is_team_device: resolvedRowIsDevice,
        tak_role: 'Team Member'
      };
      const otherRow = {
        id: otherPrincipalId,
        username: `other-${otherPrincipalId}`,
        authentik_user_id: 900000 + otherPrincipalId,
        is_team_device: !resolvedRowIsDevice,
        tak_role: 'Other Role'
      };

      User.findById.mockImplementation(async (id) => {
        if (id === actualUserId) return actualRow;
        if (id === otherPrincipalId) return otherRow;
        return undefined;
      });

      authentikService.createAppPasswordToken.mockResolvedValue({
        key: 'fixed-token-key',
        expires: '2024-01-01T00:30:00.000Z',
        identifier: 'device-enrollment-fixed'
      });
      QRCode.toDataURL.mockResolvedValue('data:image/png;base64,FAKE');
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [{ count: '0' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      // req.user carries the decoy shape merged in, with `userId`/
      // `is_global_manager` set AFTER the spread so a decoy `userId` key
      // (DECOY_KEYS includes it) can never override the real one.
      const req = {
        user: { ...userDecoys, userId: actualUserId, is_global_manager: isGlobalManager },
        body,
        query,
        params,
        headers: {}
      };
      const res = buildRes();

      const originalTakServerUrl = process.env.TAK_SERVER_URL;
      process.env.TAK_SERVER_URL = 'https://tak.example.com:8443';

      try {
        // No try/catch swallowing a thrown error here: a hostile decoy's
        // `valueOf` throwing IS the failure signal for a subject resolution
        // that reached into body/query/params by key name.
        await selfEnrollHandler(req, res);
      } finally {
        if (originalTakServerUrl === undefined) {
          delete process.env.TAK_SERVER_URL;
        } else {
          process.env.TAK_SERVER_URL = originalTakServerUrl;
        }
      }

      // --- The core assertion: the resolved subject is req.user.userId and
      // NOTHING else. Asserted on the mocked row lookup's ARGUMENTS
      // directly, so a read that happens and is then ignored still fails
      // this -- the resolver may only ever ask for the acting user's own id.
      expect(User.findById).toHaveBeenCalledTimes(1);
      expect(User.findById).toHaveBeenCalledWith(actualUserId);
      // The "other principal" was never resolved through any decoy path.
      expect(User.findById).not.toHaveBeenCalledWith(otherPrincipalId);

      if (resolvedRowIsDevice) {
        // Criterion 14.5: refused rather than built. No token minted, no QR
        // rendered, no 200 response.
        expect(res._status).toBe(403);
        expect(authentikService.createAppPasswordToken).not.toHaveBeenCalled();
        expect(QRCode.toDataURL).not.toHaveBeenCalled();
      } else {
        expect(res._status).toBe(200);
        expect(res._body.enrollment).toBeDefined();
        expect(res._body.enrollment.principalId).toBe(actualUserId);
        // The token was minted for the RESOLVED (actual) principal's
        // Authentik id, never the decoy "other" principal's.
        expect(authentikService.createAppPasswordToken).toHaveBeenCalledWith(
          actualRow.authentik_user_id,
          expect.any(Object)
        );
      }
    }
  );

  it('exercised both the device-refusal and human-success cases, decoys landing in each of body/query/params, and every named hostile decoy shape (anti-vacuity)', () => {
    expect(seen.device).toBeGreaterThan(0);
    expect(seen.human).toBeGreaterThan(0);
    expect(seen.bodyNonEmpty).toBeGreaterThan(0);
    expect(seen.queryNonEmpty).toBeGreaterThan(0);
    expect(seen.paramsNonEmpty).toBeGreaterThan(0);
    expect(seen.hostileValue).toBeGreaterThan(0);
    expect(seen.numericStringValue).toBeGreaterThan(0);
    expect(seen.protoKey).toBeGreaterThan(0);
    expect(seen.constructorKey).toBeGreaterThan(0);
  });
});
