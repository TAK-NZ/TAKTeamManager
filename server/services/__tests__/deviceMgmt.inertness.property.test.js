/**
 * Canonical tagged property test for design.md's Property 2 (task 16.2).
 *
 * design.md's exact Property 2 statement: "For all device-management
 * triggers -- a scheduled credential-refresh tick, a poll tick, a sync tick,
 * and a revocation request -- WHILE Device_Mgmt_Enabled is false, exercising
 * the trigger SHALL result in no Admin_Credential load/refresh, no
 * Subscriptions_API call, no Active_Certificate fetch, no Device_Table write,
 * and no Revoke_Operation enqueue."
 *
 * ## How the four triggers are modelled
 *
 * The three background ticks are NOT individually flag-gated by design: each
 * job's `run()` does its work unconditionally, and the gate is the WIRING that
 * decides whether a tick ever happens at all (design.md, "Flag gate and
 * inertness": the flag is consulted at exactly two kinds of place). So the
 * faithful way to exercise "a refresh tick / a poll tick / a sync tick" is to
 * exercise the gate that schedules them -- `SyncWorker.start()`, whose
 * `if (isDeviceMgmtEnabled())` guard is what makes
 * `AdminCredentialRefreshJob.start()` (whose immediate first pass IS the
 * credential load), `SubscriptionPoller.start()` (whose immediate first pass IS
 * the poll's one outbound call -- the Client_Endpoints_API since task 21.2;
 * design.md's Property 2 statement quoted above still calls it the
 * Subscriptions_API, which finding 1 repointed but did not otherwise change),
 * and `DeviceSync.start()` (whose immediate first
 * pass IS an Active_Certificate fetch plus a Device_Table write) run or not
 * run. Testing the jobs' `run()` methods in isolation would assert a gate the
 * design deliberately does not put there.
 *
 * The revocation request is exercised through the real revoke routes, whose
 * `respondNotFoundWhenDisabled(res)` 404 is the second gate, and through
 * `SyncWorker.markDevicesRevoked` -- the third and last flag-gated site, which
 * is where a confirmed revocation would otherwise write the Device_Table.
 *
 * Every run therefore asserts ALL FIVE of the property's negatives at once
 * (not just the one belonging to the drawn trigger), which is what makes this
 * a test of Requirement 9.5's simultaneity: the concerns are disabled
 * together, never some-on/some-off.
 *
 * ## What is real and what is mocked
 *
 * The flag is driven through the REAL `DEVICE_MGMT_ENABLED` environment
 * variable, so the production `isDeviceMgmtEnabled()` predicate stays in the
 * loop and the property quantifies over actual environment values rather than
 * over a mocked boolean. The real `SyncWorker`, the real three jobs, the real
 * routes, and the real `DeviceManagementService` are all exercised; only the
 * OUTERMOST effect boundaries are spied on, so any of them being reached would
 * be caught:
 *
 *   - `AdminCredentialLoader.load`/`refresh`/`readAgentOptions` -- credential
 *     load/refresh (Requirement 1.5);
 *   - `TakServerService.getClientEndpoints` -- the Client_Endpoints_API call
 *     the Subscription_Poller's poll IS (Requirement 1.6). Task 21.1 deleted
 *     `getConnectedSubscriptions()` (`/Marti/clients`, 404 live and absent from
 *     `tak-server-openapispec.json`) and task 21.2 repointed the poller at this
 *     method, so this is the same boundary the property has always asserted --
 *     the single outbound call a poll tick would make -- under its current name;
 *   - `TakServerService.listActiveCertificates` -- Active_Certificate fetch,
 *     and `listCertificates`/`revokeCertificates` for the revocation path
 *     (Requirements 1.7, 1.9);
 *   - the shared `config/database` pool AND the Sync_Worker's own pool -- any
 *     Device_Table write (Requirement 1.7); asserting zero queries also proves
 *     no Device_Table READ happened, which is stronger than the property asks;
 *   - `EventPublisher.publishOperation` -- Revoke_Operation enqueue
 *     (Requirement 1.9).
 *
 * **Validates: Requirements 1.5, 1.6, 1.7, 1.9, 9.5**
 */

// `SyncWorker`'s constructor opens a real `pg.Pool`, so `pg` is mocked the
// same way `server/workers/syncWorker.test.js` does.
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    on: jest.fn(),
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn()
  }))
}));

// The shared pool the Subscription_Poller, the Device_Sync, the routes, and
// `DeviceManagementService` all reach the Device_Table through.
jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../services/EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const mockLoggerInstance = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

jest.mock('../../middleware/requestContext', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }))
}));

// `authenticateToken`/`authorize` are stubbed (the established pattern in
// `server/routes/__tests__/deviceManagement.test.js`) so the request reaches
// the handler and the 404 below proves the HANDLER's own flag gate, not an
// upstream auth rejection that would make the inertness assertions vacuous.
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = { id: 7, userId: 7, is_global_manager: false };
    next();
  }
}));

jest.mock('../../middleware/authorize', () => (req, res, next) => next());

const express = require('express');
const request = require('supertest');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../../config/database');
const EventPublisher = require('../../services/EventPublisher');
const SyncWorker = require('../../workers/syncWorker');

const originalFlag = process.env.DEVICE_MGMT_ENABLED;

// Sentinel for "the variable is unset" (Requirement 1.2's case, which is one
// of the ways Device_Mgmt_Enabled is false). Not a possible string value, so
// it can never collide with a generated one.
const UNSET = Symbol('DEVICE_MGMT_ENABLED unset');

// Every value that leaves Device_Mgmt_Enabled false: arbitrary strings other
// than the single accepted `'true'`, the named near-misses (so the frontier
// around the accepted value is exercised directly rather than left to chance),
// and the unset case.
const disabledFlagValue = fc.oneof(
  fc.string().filter((value) => value !== 'true'),
  fc.constantFrom(
    'false',
    '',
    'TRUE',
    'True',
    'tRuE',
    ' true',
    'true ',
    ' true ',
    '\ttrue',
    'true\n',
    '1',
    '0',
    'yes',
    'no',
    'on',
    'off',
    'enabled',
    'null',
    'undefined'
  ),
  fc.constant(UNSET)
);

// The property's four triggers. The three ticks are drawn separately (rather
// than collapsed into one "start the worker" case) so the generated space
// matches design.md's quantification over trigger kinds; each drives the gate
// that decides whether that tick ever fires. The revocation request is drawn
// as its three flag-gated entry points: the self route, the admin route, and
// the post-confirmation Device_Table write.
const TRIGGER_KINDS = [
  'credentialRefreshTick',
  'pollTick',
  'syncTick',
  'selfRevokeRequest',
  'managedRevokeRequest',
  'confirmedRevocationDeviceWrite'
];
const triggerKind = fc.constantFrom(...TRIGGER_KINDS);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/device-management', require('../../routes/deviceManagement'));
  return app;
}

function setFlag(value) {
  if (value === UNSET) {
    delete process.env.DEVICE_MGMT_ENABLED;
    return;
  }
  process.env.DEVICE_MGMT_ENABLED = value;
}

/**
 * Stubs every NON-device-management collaborator `SyncWorker.start()` touches
 * (so no port is bound and no operation is polled) and makes the `while
 * (this.isRunning)` poll loop run exactly one cycle, mirroring
 * `syncWorker.test.js`'s `stubStartLoop`. The three device-management jobs are
 * deliberately left REAL -- they are the subject of the property.
 */
function stubPollLoop(worker) {
  worker.processNextOperation = jest.fn().mockResolvedValue();
  worker.updateHeartbeat = jest.fn().mockResolvedValue();
  worker.startHealthServer = jest.fn();
  worker.stopHealthServer = jest.fn().mockResolvedValue();
  worker.expiryScheduler = { start: jest.fn(), stop: jest.fn() };
  worker.retentionCleanupJob = { start: jest.fn(), stop: jest.fn() };
  worker.sleep = jest.fn().mockImplementation(() => {
    worker.isRunning = false;
    return Promise.resolve();
  });
}

/**
 * Builds one run's worker with spies on every effect boundary the property
 * forbids. Each spy resolves successfully, so nothing is prevented by a
 * rejection -- if a trigger reached one of them, the call would go through and
 * be counted.
 */
function buildHarness() {
  const worker = new SyncWorker();
  stubPollLoop(worker);

  const loader = worker.adminCredentialLoader;
  const takServerService = worker.takServerService;

  const spies = {
    loaderLoad: jest.spyOn(loader, 'load').mockResolvedValue(undefined),
    loaderRefresh: jest.spyOn(loader, 'refresh').mockResolvedValue(false),
    loaderRead: jest.spyOn(loader, 'readAgentOptions').mockResolvedValue({}),
    clientEndpoints: jest.spyOn(takServerService, 'getClientEndpoints').mockResolvedValue([]),
    activeCertificates: jest.spyOn(takServerService, 'listActiveCertificates').mockResolvedValue([]),
    certificates: jest.spyOn(takServerService, 'listCertificates').mockResolvedValue([]),
    revokeCertificates: jest.spyOn(takServerService, 'revokeCertificates').mockResolvedValue({ success: true }),
    workerPoolQuery: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  };

  worker.pool.query = spies.workerPoolQuery;

  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  EventPublisher.publishOperation.mockResolvedValue({ id: 1 });

  return { worker, spies };
}

/**
 * Exercises one trigger. The revoke requests deliberately carry a VALID
 * `REVOKE` confirmation and target routes that would otherwise succeed, so the
 * absence of an enqueue is attributable to the flag alone.
 */
async function exerciseTrigger(kind, worker, app) {
  switch (kind) {
    // All three ticks are gated by the same `SyncWorker.start()` wiring, which
    // is the only thing that decides whether the tick ever occurs.
    case 'credentialRefreshTick':
    case 'pollTick':
    case 'syncTick':
      await worker.start();
      return { httpStatus: null };

    case 'selfRevokeRequest': {
      const res = await request(app)
        .post('/api/device-management/me/devices/UID-INERT/revoke')
        .send({ confirmation: 'REVOKE' });
      return { httpStatus: res.status, httpBody: res.body };
    }

    case 'managedRevokeRequest': {
      const res = await request(app)
        .post('/api/device-management/users/9/devices/UID-INERT/revoke')
        .send({ confirmation: 'REVOKE' });
      return { httpStatus: res.status, httpBody: res.body };
    }

    case 'confirmedRevocationDeviceWrite': {
      const updated = await worker.markDevicesRevoked(['UID-INERT']);
      return { httpStatus: null, updated };
    }

    default:
      throw new Error(`Unhandled trigger kind: ${kind}`);
  }
}

// Feature: device-management, Property 2: Disabled inertness
describe('Property 2: Disabled inertness', () => {
  let app;

  beforeAll(() => {
    app = buildApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFlag === undefined) {
      delete process.env.DEVICE_MGMT_ENABLED;
    } else {
      process.env.DEVICE_MGMT_ENABLED = originalFlag;
    }
  });

  test.prop([disabledFlagValue, triggerKind], { numRuns: 200 })(
    'no trigger loads/refreshes the credential, calls the subscriptions API, fetches active certs, writes the Device_Table, or enqueues a revocation',
    async (flagValue, kind) => {
      jest.clearAllMocks();
      setFlag(flagValue);

      const { worker, spies } = buildHarness();

      let outcome;
      try {
        outcome = await exerciseTrigger(kind, worker, app);
      } finally {
        // Unconditional (and idempotent) stop, so a run can never leak a
        // timer into the next one.
        await worker.stop();
      }

      // Requirement 1.5: no Admin_Credential load or refresh.
      expect(spies.loaderLoad).not.toHaveBeenCalled();
      expect(spies.loaderRefresh).not.toHaveBeenCalled();
      expect(spies.loaderRead).not.toHaveBeenCalled();

      // Requirement 1.6: no Client_Endpoints_API call -- exactly the negative
      // this assertion has always carried (the poll's single outbound call),
      // under the method name task 21.2 repointed the poller at.
      expect(spies.clientEndpoints).not.toHaveBeenCalled();

      // Requirement 1.7: no Active_Certificate fetch.
      expect(spies.activeCertificates).not.toHaveBeenCalled();

      // Requirement 1.7: no Device_Table write, through EITHER pool. Zero
      // queries at all also proves no Device_Table read occurred.
      expect(pool.query).not.toHaveBeenCalled();
      expect(spies.workerPoolQuery).not.toHaveBeenCalled();

      // Requirement 1.9: no Revoke_Operation enqueue, and no Marti
      // certificate call on the revocation path either.
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
      expect(spies.certificates).not.toHaveBeenCalled();
      expect(spies.revokeCertificates).not.toHaveBeenCalled();

      // Requirement 9.5: the ticks are not merely no-ops for this instant --
      // no timer was scheduled, so no future tick can fire either. All three
      // together: never a partial mix.
      expect(worker.adminCredentialRefreshJob.timer).toBeNull();
      expect(worker.subscriptionPoller.timer).toBeNull();
      expect(worker.deviceSync.timer).toBeNull();

      // The route surfaces are unreachable, which is what tells the client's
      // reachability probe the feature is absent.
      if (outcome.httpStatus !== null) {
        expect(outcome.httpStatus).toBe(404);
        expect(outcome.httpBody).toEqual({ error: 'Route not found' });
      }

      // The post-confirmation Device_Table write reports zero rows touched.
      if (kind === 'confirmedRevocationDeviceWrite') {
        expect(outcome.updated).toBe(0);
      }
    }
  );
});
