// Feature: takserver-enrollment, Property 13: No enrollment artifact reaches a log, a query parameter, a persisted field, or a cache
//
// **Validates: Requirements 11.5**

/**
 * takserver-enrollment task 8.9: the single fast-check property test for
 * design.md's Property 13 (Requirement 11.5).
 *
 * Exercises BOTH enrollment routes end to end -- `POST /api/enrollment/me`
 * (`server/routes/enrollment.js`) and `POST /api/devices/:deviceUserId/qr-
 * code` (`server/routes/devices.js`) -- against the REAL
 * `DeviceEnrollmentService` (including its private `#buildEnrollment` core
 * and its real `logger.info('Enrollment generated', ...)` call site), with
 * only its EXTERNAL dependencies mocked: `../config/database` (`pool`),
 * `../models/Team`, `../models/User`, `../services/TeamMembershipService`,
 * `../services/EventPublisher`, `../services/authentik`,
 * `../services/userAttributes`, `qrcode`, and `../config/logger` (so the
 * Structured_Logger calls the real service issues can be captured
 * directly, rather than re-stating that they don't happen -- mocking the
 * whole service, as `devices.test.js`/`enrollment.test.js` do for their own
 * purposes, would make THIS property vacuous, since it exists specifically
 * to catch a leak inside `#buildEnrollment` or the route handlers around
 * it).
 *
 * For each generated (host, username, tokenKey) triple, a fresh
 * `authentikService.createAppPasswordToken` mock returns `key: tokenKey`,
 * so the real `#buildEnrollment` builds the real ATAK_Enrollment_Uri, the
 * real serialized iTAK_Registration_Payload and both real QR_Data_Urls
 * around that exact token key. Every argument passed to the mocked
 * `createLogger(...)`-returned spy logger (`info`/`warn`/`error`) and every
 * element of every parameter array passed to the mocked `pool.query` --
 * across BOTH the service's own calls and each route's own `audit_logs`
 * INSERT -- is captured and scanned for a substring match against the
 * token key and the three artifacts derived from it. This is a SUBSTRING
 * SCAN of what was actually handed to the logger and the pool, never a
 * check of `REDACT_PATHS`: per this feature's own design decision 15,
 * `server/config/logger.js` omits the `redact` option entirely at
 * `LOG_LEVEL=debug`, and pino redacts by path rather than by value, so a
 * token embedded inside a URI string would match no configured path even
 * when redaction IS active. A configuration-trusting assertion would pass
 * on a build that leaks in exactly the way this property exists to catch.
 *
 * The generated `username` and `tokenKey` are drawn so that the KEY IS A
 * SUBSTRING OF NO OTHER GENERATED VALUE (`host`, `username`): otherwise a
 * detected hit inside a captured argument would be unattributable -- it
 * could be an incidental collision with the generated username rather than
 * an actual leak of the token -- and the property would be unfalsifiable.
 * `host` is drawn from a constrained lowercase alphanumeric-label alphabet
 * (rather than a broad string arbitrary) specifically so
 * `new URL('https://' + host).hostname` -- which lower-cases and
 * percent-normalizes an arbitrary hostname -- returns the EXACT input
 * string, so the `host` value threaded through `TAK_SERVER_ENROLLMENT_URL` and the
 * `host` value used for every later comparison never silently diverge.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

// ---------------------------------------------------------------------------
// Mocks -- every dependency `DeviceEnrollmentService` reaches OUTSIDE of
// itself. `DeviceEnrollmentService` itself, and its real `#buildEnrollment`
// core, are NOT mocked: this property exists to scan what THAT code hands
// to the logger and the pool.
// ---------------------------------------------------------------------------

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

let currentUser = { id: 1, userId: 1, is_global_manager: true };

jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = currentUser;
    next();
  }
}));

// Authorization is not this property's concern -- both routes' own
// permission-registry/row-scoped-resolver coverage lives elsewhere. Bypassed
// here exactly as `server/routes/enrollment.test.js` already does, so every
// generated run reaches the service.
jest.mock('../../middleware/authorize', () => (req, res, next) => next());

const mockSpyLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../../middleware/requestContext', () => ({
  getLogger: jest.fn(() => mockSpyLogger)
}));

jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockSpyLogger)
}));

jest.mock('../../models/Team', () => ({
  isAdmin: jest.fn(),
  getAncestorChain: jest.fn()
}));

jest.mock('../../models/User', () => ({
  findById: jest.fn()
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

jest.mock('../../services/userAttributes', () => ({
  generateCallsign: jest.fn()
}));

jest.mock('qrcode', () => ({
  toDataURL: jest.fn(),
  toBuffer: jest.fn()
}));

const express = require('express');
const request = require('supertest');

const pool = require('../../config/database');
const Team = require('../../models/Team');
const User = require('../../models/User');
const authentikService = require('../../services/authentik');
const UserAttributesService = require('../../services/userAttributes');
const QRCode = require('qrcode');

// Required BEFORE requiring either router: both `DeviceEnrollmentService`
// and `ManagedIdentifierService` call `createLogger(...)` at module-LOAD
// time, so the mock's return value must already be `mockSpyLogger` when the
// routers (and the service they require) are first required below.
const enrollmentRouter = require('../enrollment');
const devicesRouter = require('../devices');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/enrollment', enrollmentRouter);
  app.use('/api/devices', devicesRouter);
  return app;
}

const app = buildApp();

const ORIGINAL_TAK_SERVER_ENROLLMENT_URL = process.env.TAK_SERVER_ENROLLMENT_URL;

afterAll(() => {
  if (ORIGINAL_TAK_SERVER_ENROLLMENT_URL === undefined) {
    delete process.env.TAK_SERVER_ENROLLMENT_URL;
  } else {
    process.env.TAK_SERVER_ENROLLMENT_URL = ORIGINAL_TAK_SERVER_ENROLLMENT_URL;
  }
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const HOST_LABEL_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

/**
 * A lowercase alphanumeric-label host, e.g. `q7k3m.example.test`.
 * Deliberately NOT a broad string arbitrary: `new URL('https://' +
 * host).hostname` lower-cases and normalizes an arbitrary hostname, so a
 * constrained-but-valid alphabet is what keeps the `host` value threaded
 * through `TAK_SERVER_ENROLLMENT_URL` identical to the `host` value used in every
 * later comparison.
 */
const hostArb = fc
  .array(fc.constantFrom(...HOST_LABEL_CHARS), { minLength: 3, maxLength: 20 })
  .map((chars) => `${chars.join('')}.example.test`);

const usernameArb = fc.string({ minLength: 1, maxLength: 30 });

const tokenKeyArb = fc.string({ minLength: 8, maxLength: 40 });

/**
 * A (host, username, tokenKey) triple where `tokenKey` is a substring of
 * NEITHER `host` NOR `username` -- otherwise a detected hit would be
 * unattributable (it could be the username/host colliding with the token
 * key rather than an actual leak), and the property would be
 * unfalsifiable.
 */
const tripleArb = fc
  .record({ host: hostArb, username: usernameArb, tokenKey: tokenKeyArb })
  .filter(({ host, username, tokenKey }) => tokenKey.length > 0 && !host.includes(tokenKey) && !username.includes(tokenKey));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flattens every argument of every captured mock call into a scannable
 * string list: strings pass through as-is, everything else is
 * JSON-serialized so a leak nested inside an object argument (e.g. a
 * logger's first `fields` argument, or a JSON.stringify'd `audit_logs`
 * `details` parameter) is still reachable by a plain substring search.
 *
 * @param {Array<Array<any>>} mockCalls - a jest mock's `.mock.calls`.
 * @returns {string[]}
 */
function flattenCallArguments(mockCalls) {
  const strings = [];
  for (const callArgs of mockCalls) {
    for (const arg of callArgs) {
      if (typeof arg === 'string') {
        strings.push(arg);
      } else {
        try {
          strings.push(JSON.stringify(arg));
        } catch {
          strings.push(String(arg));
        }
      }
    }
  }
  return strings;
}

/**
 * Flattens every element of every parameter ARRAY passed to `pool.query`
 * (the second argument of each call) into a scannable string list.
 *
 * @param {Array<Array<any>>} mockCalls - `pool.query.mock.calls`.
 * @returns {string[]}
 */
function flattenPoolParams(mockCalls) {
  const strings = [];
  for (const [, params] of mockCalls) {
    if (!Array.isArray(params)) continue;
    for (const value of params) {
      if (typeof value === 'string') {
        strings.push(value);
      } else if (value !== undefined && value !== null) {
        try {
          strings.push(JSON.stringify(value));
        } catch {
          strings.push(String(value));
        }
      }
    }
  }
  return strings;
}

/**
 * Independent re-derivation: scans `haystacks` for the FIRST occurrence of
 * ANY of `forbiddenValues` as a substring, never calling back into the
 * subject to decide what "contains" means. Returns `null` when clean, or
 * `{ forbidden, haystack }` naming the exact leaked value and the exact
 * string it was found in, so a failure's message carries the measured
 * values rather than a bare boolean.
 *
 * @param {string[]} haystacks
 * @param {string[]} forbiddenValues
 * @returns {{forbidden: string, haystack: string}|null}
 */
function findLeak(haystacks, forbiddenValues) {
  for (const forbidden of forbiddenValues) {
    if (!forbidden) continue;
    for (const haystack of haystacks) {
      if (typeof haystack === 'string' && haystack.includes(forbidden)) {
        return { forbidden, haystack };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Anti-vacuity tracking -- confirms the scan actually had something to
// scan, on both routes, across the whole run.
// ---------------------------------------------------------------------------

const seen = {
  selfAuditInsertCaptured: 0,
  deviceAuditInsertCaptured: 0,
  selfLoggerInfoCaptured: 0,
  deviceLoggerInfoCaptured: 0
};

/**
 * Resets every mock's call history AND re-installs the fixtures a run
 * needs, keyed on the generated triple. Called once per generated triple,
 * and again between the two routes within the SAME triple (so each route's
 * captured calls are scoped to that route alone).
 *
 * @param {{host: string, username: string, tokenKey: string}} triple
 */
function primeFixtures({ host, username, tokenKey }) {
  process.env.TAK_SERVER_ENROLLMENT_URL = `https://${host}`;

  pool.query.mockReset();
  pool.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('FROM users WHERE id')) {
      return Promise.resolve({
        rows: [{ id: 42, username, authentik_user_id: 987, is_team_device: true, tak_role: null }]
      });
    }
    if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
      return Promise.resolve({ rows: [{ team_id: 5 }] });
    }
    if (typeof sql === 'string' && sql.includes('FROM tak_devices')) {
      return Promise.resolve({ rows: [{ count: '0' }] });
    }
    // INSERT INTO audit_logs, and anything else -- record the call, no rows needed.
    return Promise.resolve({ rows: [] });
  });

  User.findById.mockReset();
  User.findById.mockResolvedValue({
    id: 43,
    username,
    authentik_user_id: 555,
    is_team_device: false,
    tak_role: null
  });

  Team.isAdmin.mockReset();
  Team.isAdmin.mockResolvedValue(true);
  Team.getAncestorChain.mockReset();
  Team.getAncestorChain.mockResolvedValue([]);

  authentikService.createAppPasswordToken.mockReset();
  authentikService.createAppPasswordToken.mockResolvedValue({
    identifier: 'device-enrollment-test',
    expires: '2030-01-01T00:30:00.000Z',
    key: tokenKey
  });

  UserAttributesService.generateCallsign.mockReset();
  UserAttributesService.generateCallsign.mockResolvedValue(null);

  QRCode.toDataURL.mockReset();
  QRCode.toDataURL.mockImplementation((text) =>
    Promise.resolve(`data:image/png;base64,${Buffer.from(String(text)).toString('base64')}`)
  );

  mockSpyLogger.info.mockClear();
  mockSpyLogger.warn.mockClear();
  mockSpyLogger.error.mockClear();
}

/**
 * The four forbidden artifacts named by Property 13, plus the token key
 * itself, derived from a route's own JSON response body -- never
 * re-derived from the input triple, since the exact serialized form (JSON
 * key order, QR encoding) is the service's own output.
 *
 * @param {object} enrollment - a route's `enrollment`/`qrCode` response field.
 * @param {string} tokenKey
 * @returns {string[]}
 */
function forbiddenValuesFor(enrollment, tokenKey) {
  return [
    tokenKey,
    enrollment.atakEnrollmentUri,
    JSON.stringify(enrollment.itakRegistrationPayload),
    enrollment.atakQrDataUrl,
    enrollment.itakQrDataUrl
  ];
}

// Feature: takserver-enrollment, Property 13: No enrollment artifact reaches a log, a query parameter, a persisted field, or a cache
describe('Property 13: No enrollment artifact reaches a log, a query parameter, a persisted field, or a cache', () => {
  test.prop([tripleArb], { numRuns: 100 })(
    'POST /api/enrollment/me leaves no logger call, pool parameter or Cache-Control response free of no-store carrying the token key or its derived artifacts',
    async ({ host, username, tokenKey }) => {
      primeFixtures({ host, username, tokenKey });

      const res = await request(app).post('/api/enrollment/me');

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');

      const enrollment = res.body.enrollment;
      const forbidden = forbiddenValuesFor(enrollment, tokenKey);

      const poolStrings = flattenPoolParams(pool.query.mock.calls);
      const loggerStrings = [
        ...flattenCallArguments(mockSpyLogger.info.mock.calls),
        ...flattenCallArguments(mockSpyLogger.warn.mock.calls),
        ...flattenCallArguments(mockSpyLogger.error.mock.calls)
      ];

      if (pool.query.mock.calls.some((call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO audit_logs'))) {
        seen.selfAuditInsertCaptured += 1;
      }
      if (mockSpyLogger.info.mock.calls.length > 0) {
        seen.selfLoggerInfoCaptured += 1;
      }

      expect(findLeak(poolStrings, forbidden)).toBeNull();
      expect(findLeak(loggerStrings, forbidden)).toBeNull();
    }
  );

  test.prop([tripleArb], { numRuns: 100 })(
    'POST /api/devices/:deviceUserId/qr-code leaves no logger call, pool parameter or Cache-Control response free of no-store carrying the token key or its derived artifacts',
    async ({ host, username, tokenKey }) => {
      primeFixtures({ host, username, tokenKey });

      const res = await request(app).post('/api/devices/42/qr-code');

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');

      const qrCode = res.body.qrCode;
      const forbidden = forbiddenValuesFor(qrCode, tokenKey);

      const poolStrings = flattenPoolParams(pool.query.mock.calls);
      const loggerStrings = [
        ...flattenCallArguments(mockSpyLogger.info.mock.calls),
        ...flattenCallArguments(mockSpyLogger.warn.mock.calls),
        ...flattenCallArguments(mockSpyLogger.error.mock.calls)
      ];

      if (pool.query.mock.calls.some((call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO audit_logs'))) {
        seen.deviceAuditInsertCaptured += 1;
      }
      if (mockSpyLogger.info.mock.calls.length > 0) {
        seen.deviceLoggerInfoCaptured += 1;
      }

      expect(findLeak(poolStrings, forbidden)).toBeNull();
      expect(findLeak(loggerStrings, forbidden)).toBeNull();
    }
  );

  it('exercised the audit_logs INSERT and a captured logger call on BOTH routes across the whole run (anti-vacuity)', () => {
    expect(seen.selfAuditInsertCaptured).toBeGreaterThan(0);
    expect(seen.deviceAuditInsertCaptured).toBeGreaterThan(0);
    expect(seen.selfLoggerInfoCaptured).toBeGreaterThan(0);
    expect(seen.deviceLoggerInfoCaptured).toBeGreaterThan(0);
  });
});
