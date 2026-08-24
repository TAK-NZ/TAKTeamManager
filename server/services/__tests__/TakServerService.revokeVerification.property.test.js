/**
 * device-management task 19.6: the single fast-check property test for
 * design.md's Correctness Property 10 (Requirements 7.6, 8.7, 12.4, 12.5,
 * 12.6, 12.7).
 *
 * The defect this pins: `revokeCertificates` used to verify a revocation by
 * re-querying `listCertificates()` and treating a non-null `revocationDate`
 * as confirmation. Verified live, all 95 certificates in the
 * Active_Certificate view carry a NON-NULL `revocationDate`, including the 5
 * that `/revoked` does not list (e.g. id 3212,
 * `revocationDate: 2026-01-17T01:15:22.160Z`), so that check reported success
 * unconditionally -- a vacuous verification.
 *
 * The generator therefore draws each certificate's `revocationDate`
 * INDEPENDENTLY of its `/revoked` membership, over three explicitly named
 * shapes -- `all-non-null` (the live shape), `all-null`, and `mixed` -- and
 * the mocked GET serves a `/Marti/api/certadmin/cert` view in which EVERY
 * targeted id is present carrying a non-null `revocationDate`. A
 * `revocationDate`-reading implementation, whichever view it read, would
 * report success for every generated scenario and so would fail this
 * property on any scenario whose expected outcome is `success: false`. The
 * `examples` below guarantee at least one such scenario is always run
 * (example 1 is the live shape: id 3212 dated yet absent from `/revoked`).
 *
 * Sibling `../TakServerService.test.js` covers the concrete examples, the
 * exact request paths, and the propagate-on-failed-re-query path; its
 * `makeTakCert` fixture shape is reused here.
 */

jest.mock('fs', () => ({
  readFileSync: jest.fn(() => Buffer.from('fake-file-contents'))
}));

const mockGet = jest.fn();
const mockDelete = jest.fn();

jest.mock('axios', () => ({
  create: jest.fn((config) => ({
    get: mockGet,
    delete: mockDelete,
    defaults: { ...config }
  }))
}));

jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }))
}));

const fc = require('fast-check');

const TakServerService = require('../TakServerService');

const TEST_ENV = {
  TAK_SERVER_URL: 'https://tak.example.com:8443',
  TAK_API_CERT_PATH: '/certs/client.pem',
  TAK_API_KEY_PATH: '/certs/client.key'
};

const REVOKED_VIEW_PATH = '/Marti/api/certadmin/cert/revoked';

/** The `TakCert` fixture shape used by `../TakServerService.test.js`. */
function makeTakCert(overrides = {}) {
  return {
    id: 1,
    creatorDn: 'CN=alice,OU=TAK-NZ',
    subjectDn: 'CN=alice,OU=TAK-NZ',
    userDn: 'CN=alice,OU=TAK-NZ',
    certificate: '-----BEGIN CERTIFICATE-----',
    hash: 'abc123',
    clientUid: 'client-uid-1',
    issuanceDate: '2024-01-01T00:00:00Z',
    expirationDate: '2025-01-01T00:00:00Z',
    effectiveDate: '2024-01-01T00:00:00Z',
    revocationDate: null,
    token: 'tok',
    serialNumber: '01',
    ...overrides
  };
}

/**
 * A `revocationDate` in the live shape: TAK Server hands back dates that are
 * often in the FUTURE (id 3212 carried 2026-01-17), which is part of why the
 * field says nothing about whether a certificate is revoked.
 */
function revocationDateFor(id) {
  return new Date(Date.UTC(2026, 0, 17, 1, 15, 22, id % 1000)).toISOString();
}

/**
 * Resolves whether a targeted certificate carries a non-null
 * `revocationDate`, from the generated shape. Note this consults only
 * `mode`/`dateFlag` -- never `inRevoked` -- which is what keeps the date
 * independent of `/revoked` membership.
 */
function carriesRevocationDate(mode, target) {
  if (mode === 'all-non-null') return true;
  if (mode === 'all-null') return false;
  return target.dateFlag;
}

/**
 * Builds the two views the mocked client serves and installs them.
 *
 * `/revoked` carries the targeted ids whose generated membership is true,
 * plus untargeted entries (the live `/revoked` view is far larger than any
 * one target set -- those entries must not affect the outcome).
 *
 * Every OTHER path -- the full `/Marti/api/certadmin/cert` list the old
 * implementation re-queried, and `/active` -- serves a view containing every
 * targeted id with a non-null `revocationDate`, i.e. the live shape in which
 * a `revocationDate`-based check confirms everything.
 */
function installViews({ targets, extraRevokedIds, mode, invertDates }) {
  const nonNullDate = (target) => carriesRevocationDate(mode, target) !== Boolean(invertDates);

  const revokedView = [
    ...targets
      .filter((target) => target.inRevoked)
      .map((target) =>
        makeTakCert({
          id: target.id,
          clientUid: `uid-${target.id}`,
          revocationDate: nonNullDate(target) ? revocationDateFor(target.id) : null
        })
      ),
    ...extraRevokedIds.map((id) =>
      makeTakCert({ id, clientUid: `untargeted-uid-${id}`, revocationDate: revocationDateFor(id) })
    )
  ];

  const datedView = targets.map((target) =>
    makeTakCert({
      id: target.id,
      clientUid: `uid-${target.id}`,
      revocationDate: revocationDateFor(target.id)
    })
  );

  mockGet.mockImplementation(async (url) => ({
    data: {
      version: '1',
      type: 'com.bbn.marti.remote.groups.ApiResponse',
      data: url === REVOKED_VIEW_PATH ? revokedView : datedView,
      messages: [],
      nodeId: 'node-1'
    }
  }));

  return { revokedView };
}

/** Runs `revokeCertificates` once against freshly installed views. */
async function runRevoke(scenario, { invertDates = false } = {}) {
  jest.clearAllMocks();
  mockDelete.mockResolvedValue({ status: 200, data: '' });
  installViews({ ...scenario, invertDates });

  const service = new TakServerService(TEST_ENV);
  const certIds = scenario.targets.map((target) => target.id);
  const result = await service.revokeCertificates(certIds);

  return { result, certIds, getPaths: mockGet.mock.calls.map(([url]) => url) };
}

const targetArb = fc.record({
  id: fc.integer({ min: 1, max: 4000 }),
  /** Whether the re-queried `/revoked` view lists this id. */
  inRevoked: fc.boolean(),
  /** Only consulted in the `mixed` shape; independent of `inRevoked`. */
  dateFlag: fc.boolean()
});

const scenarioArb = fc.record({
  targets: fc.uniqueArray(targetArb, { minLength: 1, maxLength: 8, selector: (target) => target.id }),
  /** Ids present in `/revoked` that were never targeted. */
  extraRevokedIds: fc.uniqueArray(fc.integer({ min: 100000, max: 200000 }), { maxLength: 5 }),
  mode: fc.constantFrom('all-non-null', 'all-null', 'mixed')
});

/**
 * Explicit shapes, so the distinguishing cases are run on every invocation
 * rather than left to sampling.
 */
const EXAMPLES = [
  // 1. The live shape: every certificate dated, yet a targeted id (3212) is
  //    absent from /revoked -- must be reported unverified.
  [
    {
      targets: [
        { id: 3212, inRevoked: false, dateFlag: true },
        { id: 100, inRevoked: true, dateFlag: true }
      ],
      extraRevokedIds: [199999],
      mode: 'all-non-null'
    }
  ],
  // 2. Every date null, every targeted id in /revoked -- must be success.
  [
    {
      targets: [
        { id: 1, inRevoked: true, dateFlag: false },
        { id: 2, inRevoked: true, dateFlag: false }
      ],
      extraRevokedIds: [],
      mode: 'all-null'
    }
  ],
  // 3. Mixed dates, mixed membership, untargeted /revoked entries present.
  [
    {
      targets: [
        { id: 10, inRevoked: true, dateFlag: false },
        { id: 11, inRevoked: false, dateFlag: true },
        { id: 12, inRevoked: true, dateFlag: true }
      ],
      extraRevokedIds: [100001, 100002],
      mode: 'mixed'
    }
  ]
];

// Feature: device-management, Property 10: Revocation is confirmed only by revoked-view membership
describe('Property 10: Revocation is confirmed only by revoked-view membership', () => {
  it('reports success iff every targeted id is in the revoked view, independently of revocationDate', async () => {
    // Non-vacuity: at least one scenario must have carried a dated-but-absent
    // targeted id, the exact shape the old revocationDate check got wrong.
    let sawDatedButAbsentTarget = false;
    let sawSuccess = false;

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const { targets } = scenario;
        const revokedIds = new Set(targets.filter((target) => target.inRevoked).map((target) => target.id));
        const expectedUnverified = targets.filter((target) => !revokedIds.has(target.id)).map((target) => target.id);

        if (expectedUnverified.some((id) => carriesRevocationDate(scenario.mode, targets.find((t) => t.id === id)))) {
          sawDatedButAbsentTarget = true;
        }

        const { result, certIds, getPaths } = await runRevoke(scenario);

        // 1. success iff every targeted id is a member of the revoked view.
        expect(result.success).toBe(expectedUnverified.length === 0);

        // 2. When not verified, `unverified` is exactly the targeted ids
        //    absent from that view (contract shape unchanged, so the
        //    main-spec Requirement 26 callers keep their retry semantics).
        if (expectedUnverified.length === 0) {
          expect(result).toEqual({ success: true });
          sawSuccess = true;
        } else {
          expect(result).toEqual({ success: false, unverified: expectedUnverified });
        }

        // 4. The DELETE carries the targeted ids, and verification is a
        //    re-query of /revoked -- never /active or the full cert list.
        expect(mockDelete).toHaveBeenCalledTimes(1);
        expect(mockDelete).toHaveBeenCalledWith(`/Marti/api/certadmin/cert/revoke/${certIds.join(',')}`);
        expect(getPaths).toEqual([REVOKED_VIEW_PATH]);

        // 3. Invariance under `revocationDate`: holding membership fixed and
        //    inverting every date (all-non-null <-> all-null, mixed flipped)
        //    must not change the outcome.
        const inverted = await runRevoke(scenario, { invertDates: true });
        expect(inverted.result).toEqual(result);
        expect(inverted.getPaths).toEqual([REVOKED_VIEW_PATH]);
      }),
      { numRuns: 200, examples: EXAMPLES }
    );

    expect(sawDatedButAbsentTarget).toBe(true);
    expect(sawSuccess).toBe(true);
  });
});
