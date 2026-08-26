/**
 * device-management task 23.3: the single fast-check property test for
 * design.md's Correctness Property 12.
 *
 * design.md's exact Property 12 statement: "For all failure modes of a fetch
 * against an endpoint documented in `tak-server-openapispec.json` (404, other
 * 4xx, 5xx, network error, timeout, malformed payload), the containing run
 * SHALL be reported as failed with an error logged, and SHALL perform no
 * Device_Table write -- in particular a 404 SHALL NOT be converted into an
 * empty result set, and a failed Revoked_Certificate_View fetch SHALL NOT be
 * converted into an empty revoked set."
 *
 * **Validates: Requirements 3.8, 4.9, 14.1, 14.2, 14.5, 20.7**
 *
 * Requirement 20.7 ("a failed poll writes no Connection_Status at all") is
 * covered here rather than by a property of its own, per design.md's "Two
 * existing properties are strengthened rather than duplicated": `connected` is a
 * Device_Table write, so it was already inside "performs no Device_Table write",
 * and a separate property would fail together with this one and never
 * independently of it. What task 28.7 added is the assertion that names the two
 * statements carrying the column -- see `statusWrites()` and
 * `unreportedUidSweeps()`.
 *
 * The defect this pins is the one Requirement 14.5 names: a failure that reads
 * as an empty result. `/Marti/clients` answered 404, the old graceful-404-as-
 * empty handling turned that into "no clients observed", `last_seen_at` stayed
 * null forever, and NOTHING was logged -- so the broken deployment was
 * byte-for-byte indistinguishable from a healthy one whose TAK Server had
 * simply never seen a client. Every assertion below is therefore paired: the
 * failure must be reported failed AND must not be reportable as completed, and
 * each property runs a genuinely-empty SUCCESS through the same job in the same
 * generated case, so an implementation that collapsed the two would fail the
 * contrast rather than pass both halves.
 *
 * Both jobs are covered here, in separate blocks so a counter-example names the
 * job it came from:
 *
 *   1. `SubscriptionPoller` over the Client_Endpoints_API
 *      (`/Marti/api/clientEndPoints`, OpenAPI `getClientEndpoints`).
 *   2. `DeviceSync` over the two certificate views (`/active` + `/revoked`,
 *      OpenAPI `getActive`/`getRevoked`), driven through a
 *      `listLiveCertificates` stub.
 *   3. `DeviceSync` again, but over a REAL `TakServerService` with a recording
 *      HTTP double (the pattern `DeviceSync.test.js` uses), because the
 *      "a failed `/revoked` never becomes an empty revoked set" half of the
 *      property is a statement about the code that actually issues the two
 *      requests and computes the set difference -- a stub cannot show that a
 *      dropped `/revoked` would have promoted revoked certificates to live.
 *
 * Where the malformed-payload case is driven from, and why it matters: the
 * non-array guard lives at the JOB level, not in `TakServerService`. A
 * malformed HTTP BODY (e.g. `{ data: { data: 'nope' } }`) is flattened to `[]`
 * by `unwrapArray()` and legitimately reads as an empty view -- the one
 * tolerated absence of Requirement 14.3, which applies to a 200 that omitted
 * its payload. So the malformed-payload mode is generated as a RESOLVED
 * non-array from the service (a string, a number, an object, `null`), which is
 * the only way to reach the guard this property is about. Blocks 1 and 2 use
 * service stubs for exactly that reason; block 3, which necessarily goes
 * through `unwrapArray`, generates rejections only.
 *
 * Sibling example tests for the log shape live in
 * `SubscriptionPoller.test.js`'s and `DeviceSync.test.js`'s failure-reporting
 * blocks; this file is the across-all-failure-modes coverage.
 */

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const fc = require('fast-check');

const pool = require('../../config/database');
const SubscriptionPoller = require('../SubscriptionPoller');
const DeviceSync = require('../DeviceSync');
const TakServerService = require('../TakServerService');

/** The documented endpoints this property quantifies over (Requirement 14.2). */
const CLIENT_ENDPOINTS_PATH = '/Marti/api/clientEndPoints';
const ACTIVE_VIEW_PATH = '/Marti/api/certadmin/cert/active';
const REVOKED_VIEW_PATH = '/Marti/api/certadmin/cert/revoked';

/** What each job reports as `endpoint` when the rejection names no URL. */
const POLLER_FALLBACK_ENDPOINT = CLIENT_ENDPOINTS_PATH;
const SYNC_FALLBACK_ENDPOINT = `${ACTIVE_VIEW_PATH}, ${REVOKED_VIEW_PATH}`;

/** The terminal log messages each job ends a run with. */
const POLLER_COMPLETED_MESSAGE = 'Subscription poll completed';
const SYNC_COMPLETED_MESSAGE = 'Device sync run completed';

/**
 * A Live_Certificate in the Marti `TakCert` shape, used as the certificate that
 * WOULD have looked live had a failed `/revoked` been degraded to an empty
 * revoked set.
 */
const REVOKED_CERT = {
  id: 3212,
  clientUid: 'ANDROID-842f08e120efdbe3',
  creatorDn: 'CN=alice,OU=TAK,O=NZ',
  issuanceDate: '2024-01-01T00:00:00.000Z',
  expirationDate: '2025-01-01T00:00:00.000Z'
};

/**
 * Every failure mode Property 12 names, as generated descriptors. The HTTP
 * modes are split so that 404 -- the load-bearing one, the status the original
 * defect turned into an empty result -- is always drawn with its own weight
 * rather than being one status among a dozen.
 *
 * `carriesUrl` decides whether the rejection carries the axios
 * `error.config.url` of the failing request: a real axios rejection does, but a
 * plain `Error` (or a rejection raised before the request was built) does not,
 * and the two resolve the reported `endpoint` differently.
 */
const failureArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      mode: fc.constant('http'),
      label: fc.constant('404'),
      status: fc.constant(404),
      carriesUrl: fc.boolean()
    })
  },
  {
    weight: 2,
    arbitrary: fc.record({
      mode: fc.constant('http'),
      label: fc.constant('other-4xx'),
      status: fc.constantFrom(400, 401, 403, 405, 409, 429),
      carriesUrl: fc.boolean()
    })
  },
  {
    weight: 2,
    arbitrary: fc.record({
      mode: fc.constant('http'),
      label: fc.constant('5xx'),
      status: fc.constantFrom(500, 502, 503, 504),
      carriesUrl: fc.boolean()
    })
  },
  {
    weight: 2,
    arbitrary: fc.record({
      mode: fc.constant('network'),
      label: fc.constant('network-error'),
      code: fc.constantFrom('ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EPROTO', 'EAI_AGAIN'),
      carriesUrl: fc.boolean()
    })
  },
  {
    weight: 2,
    arbitrary: fc.record({
      mode: fc.constant('timeout'),
      label: fc.constant('timeout'),
      code: fc.constantFrom('ECONNABORTED', 'ETIMEDOUT'),
      carriesUrl: fc.boolean()
    })
  },
  {
    weight: 2,
    arbitrary: fc.record({
      mode: fc.constant('malformed'),
      label: fc.constant('malformed-payload'),
      payload: fc.oneof(
        fc.string(),
        fc.integer(),
        fc.constant(null),
        fc.constant({ data: 'nope' }),
        fc.constant({}),
        fc.boolean()
      )
    })
  }
);

/** Rejection-only failures: the modes block 3 can drive over real HTTP. */
const rejectionFailureArb = failureArb.filter((failure) => failure.mode !== 'malformed');

/** Which certificate view a generated `DeviceSync` failure came from. */
const failingViewArb = fc.constantFrom('active', 'revoked', 'both');

/**
 * Materialises a generated descriptor as the rejection the fetch produces.
 *
 * Shapes follow the axios conventions the implementation reads: the HTTP status
 * at `error.response.status` and the failing URL at `error.config.url` (the
 * same places `syncWorker.classifyTakServerError()` reads them).
 *
 * @param {object} failure a generated non-`malformed` descriptor.
 * @param {string} url the endpoint the failing request used.
 * @returns {Error}
 */
function materialiseError(failure, url) {
  const message =
    failure.mode === 'http'
      ? `Request failed with status code ${failure.status}`
      : failure.mode === 'timeout'
        ? 'timeout of 5000ms exceeded'
        : `${failure.code} tak.example.test:8443`;

  const error = new Error(message);

  if (failure.mode === 'http') {
    // A real 404 body: TAK Server answering "no such path", which is precisely
    // what must NOT read as "no such data".
    error.response = { status: failure.status, statusText: 'Error', data: '' };
  } else {
    error.code = failure.code;
  }

  if (failure.carriesUrl) {
    error.config = { url, method: 'get' };
  }

  return error;
}

/**
 * The `status` the error line must carry: the answered HTTP status, or a
 * DEFINED `null` when the server never answered at all (transport, DNS/TLS,
 * timeout) -- never an absent field, so the two are told apart in the log
 * without reading `err` (Requirement 14.1).
 */
function expectedStatus(failure) {
  return failure.mode === 'http' ? failure.status : null;
}

/**
 * The `endpoint` the error line must carry: the URL the failing request used
 * when the rejection names one, else the documented endpoint(s) the run
 * required. Never empty (Requirement 14.1).
 */
function expectedEndpoint(failure, url, fallback) {
  return failure.carriesUrl ? url : fallback;
}

/** The name the malformed-payload line reports for a payload's shape. */
function expectedPayloadType(payload) {
  return payload === null ? 'null' : typeof payload;
}

/** Every error-level line a run emitted that reports the run itself as failed. */
function failedRunLines() {
  return mockLoggerInstance.error.mock.calls.filter(
    ([fields]) => fields && typeof fields === 'object' && fields.outcome === 'failed'
  );
}

/** Every `pool.query` call that would write to the Device_Table. */
function deviceTableWrites() {
  return pool.query.mock.calls.filter(
    ([sql]) =>
      typeof sql === 'string' &&
      (sql.includes('UPDATE tak_devices') || sql.includes('INSERT INTO tak_devices'))
  );
}

/**
 * Task 28.7 / Requirement 20.7: the two statements that carry `connected`, named
 * individually rather than left inside `deviceTableWrites()`'s aggregate count,
 * so a counter-example says WHICH status write a failed run leaked.
 *
 * `connected` is a Device_Table write like any other, which is why 20.7 needs no
 * property of its own (design.md, "Two existing properties are strengthened
 * rather than duplicated") -- only these assertions, which pin the specific
 * failure mode 20.7 forbids: a TAK Server outage marking every Device
 * disconnected, making an outage indistinguishable from every device having gone
 * offline.
 */
function statusWrites() {
  return pool.query.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('UPDATE tak_devices') && sql.includes('connected')
  );
}

/**
 * The once-per-run unreported-uid sweep (`UPDATE tak_devices SET connected =
 * false WHERE client_uid <> ALL($1::text[])`, Requirement 20.6).
 *
 * The verb is part of the filter deliberately: `DeviceSync`'s stale-row delete
 * (Requirement 17.1) uses the very same `client_uid <> ALL($1::text[])`
 * predicate, so a filter on the predicate alone would match both statements and
 * this helper would silently be reporting deletes as status sweeps.
 */
function unreportedUidSweeps() {
  return pool.query.mock.calls.filter(
    ([sql]) =>
      typeof sql === 'string' &&
      sql.includes('UPDATE tak_devices') &&
      sql.includes('client_uid <> ALL($1::text[])')
  );
}

/**
 * Asserts the shape every failed run shares, whichever job and whichever mode
 * produced it: exactly one error-level line reporting the run failed, carrying
 * the endpoint and either the status or the payload shape, and NO Device_Table
 * write at all.
 *
 * @param {object} args
 * @param {object} args.failure the generated descriptor.
 * @param {string} args.url the endpoint the failing request used.
 * @param {string} args.fallback the endpoint(s) reported when no URL is named.
 * @param {string} args.completedMessage the completion line that must be absent.
 */
function expectReportedFailure({ failure, url, fallback, completedMessage }) {
  const lines = failedRunLines();

  // Exactly one terminal failure line: reported, and reported once.
  expect(lines).toHaveLength(1);

  const [fields] = lines[0];

  if (failure.mode === 'malformed') {
    // A resolved non-array never reached the network, so there is no HTTP
    // status to report -- the shape that could not be read is reported instead.
    expect(fields).toMatchObject({
      endpoint: fallback,
      payloadType: expectedPayloadType(failure.payload),
      outcome: 'failed'
    });
  } else {
    expect(fields).toMatchObject({
      endpoint: expectedEndpoint(failure, url, fallback),
      status: expectedStatus(failure),
      outcome: 'failed'
    });
    // `status: null` is a present key, not an omitted one.
    expect(Object.keys(fields)).toContain('status');
    expect(fields.err).toBeInstanceOf(Error);
  }

  // Requirement 14.1: no Device_Table write of any kind.
  expect(deviceTableWrites()).toHaveLength(0);

  // Requirement 20.7: and in particular neither of the two statements that
  // write Connection_Status -- not the per-`uid` status write, and not the
  // once-per-run unreported-uid sweep. A failed poll must leave every stored
  // `connected` exactly as it was rather than marking every Device
  // disconnected, so that an outage cannot read as a fleet that all went
  // offline at once. Both are already inside `deviceTableWrites()`'s scope,
  // which is why 20.7 gets no property of its own; naming them is what makes
  // the coverage checkable rather than argued.
  expect(statusWrites()).toHaveLength(0);
  expect(unreportedUidSweeps()).toHaveLength(0);

  // Requirement 14.5: a failed run must NOT also read as a completed one, or
  // the two would be indistinguishable -- which is the whole defect.
  expect(mockLoggerInstance.info).not.toHaveBeenCalledWith(expect.anything(), completedMessage);
  expect(
    mockLoggerInstance.info.mock.calls.filter(
      ([fields_]) => fields_ && typeof fields_ === 'object' && fields_.outcome === 'completed'
    )
  ).toHaveLength(0);
}

// Feature: device-management, Property 12: A documented-endpoint failure is never an empty result
describe('Property 12: A documented-endpoint failure is never an empty result', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('SubscriptionPoller over the Client_Endpoints_API', () => {
    it('reports every failure mode as a failed run that writes nothing, while a genuinely empty poll completes', async () => {
      await fc.assert(
        fc.asyncProperty(failureArb, async (failure) => {
          jest.clearAllMocks();
          pool.query.mockResolvedValue({ rowCount: 1 });

          const takServerService = {
            getClientEndpoints: jest.fn(),
            // Requirement 13 freshening follow-up: stubbed to a no-op so this
            // property stays about the PRIMARY fetch's failure modes; the
            // freshening fetch's own best-effort tolerance has its own
            // coverage in SubscriptionPoller.test.js.
            getAllSubscriptions: jest.fn().mockResolvedValue([])
          };
          if (failure.mode === 'malformed') {
            takServerService.getClientEndpoints.mockResolvedValue(failure.payload);
          } else {
            takServerService.getClientEndpoints.mockRejectedValue(
              materialiseError(failure, CLIENT_ENDPOINTS_PATH)
            );
          }

          const poller = new SubscriptionPoller({ takServerService, pool });

          // Requirements 3.8, 14.1: never throws, and the run is reported
          // failed -- not degraded to "nothing was reported".
          await expect(poller.run()).resolves.toBeUndefined();

          expectReportedFailure({
            failure,
            url: CLIENT_ENDPOINTS_PATH,
            fallback: POLLER_FALLBACK_ENDPOINT,
            completedMessage: POLLER_COMPLETED_MESSAGE
          });

          // This job's only writes are the per-uid UPDATE and task 28.2's
          // unreported-uid status sweep, both of which sit behind every early
          // return, so a failed run issues no statement whatsoever -- and in
          // particular does not mark every Device disconnected (Requirement 20.7).
          expect(pool.query).not.toHaveBeenCalled();

          // Requirement 14.5, the contrast that gives the property its point:
          // the SAME job, in the SAME generated case, fed a genuinely empty
          // Client_Endpoints_API result. A 404 (or any other failure) is
          // reported failed above; an empty result is reported COMPLETED with
          // zero counts here. An implementation that turned the failure into
          // `[]` would produce this line for both and fail the pairing.
          jest.clearAllMocks();
          takServerService.getClientEndpoints.mockReset();
          takServerService.getClientEndpoints.mockResolvedValue([]);

          const summary = await poller.run();

          expect(summary).toEqual({
            entries: 0,
            observed: 0,
            skipped: 0,
            freshened: 0,
            updated: 0,
            failed: 0,
            connected: 0,
            disconnected: 0,
            unreported: 1
          });
          expect(mockLoggerInstance.error).not.toHaveBeenCalled();
          expect(mockLoggerInstance.info).toHaveBeenCalledWith(
            expect.objectContaining({ entries: 0, outcome: 'completed' }),
            POLLER_COMPLETED_MESSAGE
          );
          // The contrast in writes, too: the SUCCEEDED-but-empty run records no
          // Last_Seen, but it does issue task 28.2's status sweep -- a poll that
          // reported nothing is positive evidence that nothing is connected
          // (Requirement 20.6), and that statement is still scoped to the
          // (empty) reported set rather than unrestricted by `client_uid`. The
          // FAILED run above issued no statement at all (Requirement 20.7).
          expect(deviceTableWrites()).toHaveLength(1);
          expect(deviceTableWrites()[0][0]).toMatch(/client_uid <> ALL\(\$1::text\[\]\)/);
          expect(deviceTableWrites()[0][0]).not.toContain('last_seen_at');
          // Named as the sweep specifically, so the contrast with the failed run
          // above is exact: zero status statements there, exactly this one here,
          // setting `connected = false` and parameterised by the (empty)
          // reported set (Requirements 20.6, 20.7).
          expect(unreportedUidSweeps()).toHaveLength(1);
          expect(unreportedUidSweeps()[0][0]).toContain('connected = false');
          expect(unreportedUidSweeps()[0][1]).toEqual([[]]);
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('DeviceSync over the two certificate views', () => {
    it('reports every failure mode of either view as a failed run that writes nothing, while a genuinely empty live set completes', async () => {
      await fc.assert(
        fc.asyncProperty(failureArb, failingViewArb, async (failure, failingView) => {
          jest.clearAllMocks();
          pool.query.mockImplementation((sql) => {
            if (typeof sql === 'string' && sql.includes('FROM users')) {
              return Promise.resolve({ rows: [{ id: 7, username: 'alice' }] });
            }
            return Promise.resolve({ rowCount: 1 });
          });

          // `listLiveCertificates()` rejects with the FIRST failing view's
          // reason, so `both` reports the `/active` rejection.
          const url = failingView === 'revoked' ? REVOKED_VIEW_PATH : ACTIVE_VIEW_PATH;

          const takServerService = { listLiveCertificates: jest.fn() };
          if (failure.mode === 'malformed') {
            takServerService.listLiveCertificates.mockResolvedValue(failure.payload);
          } else {
            takServerService.listLiveCertificates.mockRejectedValue(materialiseError(failure, url));
          }

          const job = new DeviceSync({ takServerService, pool });

          // Requirements 4.9, 14.1: never throws, run reported failed.
          await expect(job.run()).resolves.toBeUndefined();

          expectReportedFailure({
            failure,
            url,
            fallback: SYNC_FALLBACK_ENDPOINT,
            completedMessage: SYNC_COMPLETED_MESSAGE
          });

          // The fetch precedes the local users read, so a failed run reaches
          // the database not at all -- neither to read nor to write.
          expect(pool.query).not.toHaveBeenCalled();

          // Requirement 14.5's contrast again: a live set that is legitimately
          // empty (TAK Server has nothing live) is an affirmative completed
          // run with zero counts, never silence and never an error.
          jest.clearAllMocks();
          takServerService.listLiveCertificates.mockReset();
          takServerService.listLiveCertificates.mockResolvedValue([]);

          const counts = await job.run();

          expect(counts).toMatchObject({ liveCertificates: 0, devices: 0, upserted: 0, failed: 0 });
          expect(mockLoggerInstance.error).not.toHaveBeenCalled();
          expect(mockLoggerInstance.info).toHaveBeenCalledWith(
            expect.objectContaining({ liveCertificates: 0, outcome: 'completed' }),
            SYNC_COMPLETED_MESSAGE
          );
          expect(deviceTableWrites()).toHaveLength(0);
        }),
        { numRuns: 200 }
      );
    });
  });

  /**
   * The half of Property 12 that a service stub cannot express: a failed
   * Revoked_Certificate_View fetch must never read as an empty revoked set.
   *
   * Driven through a real `TakServerService` over a recording HTTP double so
   * the actual `Promise.allSettled` + set-difference code runs. `/active`
   * always answers 200 with a certificate that IS revoked, so degrading the
   * failed `/revoked` to `[]` would compute that certificate as live and upsert
   * it -- exactly the Requirement 11.5 symptom (revoked certificates presented
   * as live Devices). The assertion is therefore that NO row is upserted.
   *
   * Malformed payloads are absent from this block by design: at the HTTP
   * boundary a body that is not a list is flattened to `[]` by `unwrapArray()`
   * and legitimately means "this view is empty" (Requirement 14.3), so only
   * rejections are generated here.
   */
  describe('DeviceSync over a real TakServerService: a failed /revoked is never an empty revoked set', () => {
    it('upserts nothing for any failure mode of /revoked, while an empty /revoked syncs the live certificate', async () => {
      await fc.assert(
        fc.asyncProperty(rejectionFailureArb, async (failure) => {
          jest.clearAllMocks();
          pool.query.mockImplementation((sql) => {
            if (typeof sql === 'string' && sql.includes('FROM users')) {
              return Promise.resolve({ rows: [{ id: 7, username: 'alice' }] });
            }
            return Promise.resolve({ rowCount: 1 });
          });

          // No network is touched: the env carries no credential paths and the
          // HTTP client is replaced outright by the recording double.
          const service = new TakServerService({ TAK_SERVER_URL: 'https://tak.example.test' });
          const requestedPaths = [];
          service.client = {
            get: jest.fn(async (path) => {
              requestedPaths.push(path);
              if (path === ACTIVE_VIEW_PATH) return { data: { data: [REVOKED_CERT] } };
              if (path === REVOKED_VIEW_PATH) throw materialiseError(failure, REVOKED_VIEW_PATH);
              throw new Error(`Unexpected TAK Server request: ${path}`);
            })
          };

          const job = new DeviceSync({ takServerService: service, pool });

          await expect(job.run()).resolves.toBeUndefined();

          // Both views were asked for, and the failing one was NOT skipped past.
          expect(requestedPaths.sort()).toEqual([ACTIVE_VIEW_PATH, REVOKED_VIEW_PATH]);

          expectReportedFailure({
            failure,
            url: REVOKED_VIEW_PATH,
            fallback: SYNC_FALLBACK_ENDPOINT,
            completedMessage: SYNC_COMPLETED_MESSAGE
          });

          // The certificate `/active` served would have looked live under an
          // empty revoked set. Nothing was written, so it did not.
          expect(pool.query).not.toHaveBeenCalled();

          // `listLiveCertificates()` also attributes the failure to the VIEW
          // it came from, so the log names `/revoked` even before the job's own
          // line (Requirement 14.5).
          expect(mockLoggerInstance.error).toHaveBeenCalledWith(
            expect.objectContaining({ view: 'revoked', endpoint: REVOKED_VIEW_PATH }),
            expect.stringContaining('certificate view fetch failed')
          );

          // The contrast: `/revoked` answering 200 with an EMPTY view really
          // does mean nothing is revoked, so the same certificate now syncs.
          // That is what makes degrading the failure above indefensible -- the
          // two inputs must not produce the same outcome.
          jest.clearAllMocks();
          service.client.get.mockImplementation(async (path) => {
            if (path === ACTIVE_VIEW_PATH) return { data: { data: [REVOKED_CERT] } };
            if (path === REVOKED_VIEW_PATH) return { data: { data: [] } };
            throw new Error(`Unexpected TAK Server request: ${path}`);
          });

          const counts = await job.run();

          expect(counts).toMatchObject({ liveCertificates: 1, devices: 1, upserted: 1 });
          expect(deviceTableWrites()).toHaveLength(1);
          expect(mockLoggerInstance.error).not.toHaveBeenCalled();
        }),
        { numRuns: 120 }
      );
    });
  });
});
