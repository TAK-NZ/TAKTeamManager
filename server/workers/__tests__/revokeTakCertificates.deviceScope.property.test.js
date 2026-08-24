/**
 * device-management task 19.5: the single fast-check property test for
 * design.md's Correctness Property 9 (Requirements 7.4, 8.4, 12.1, 12.8).
 *
 * The property is about BLAST RADIUS: a device-scoped Revoke_Operation must
 * target exactly the Live_Certificates carrying the target `clientUid`, and
 * nothing else -- and must flip the Device_Table `revoked` flag for exactly
 * that one `client_uid`. This path previously over-revoked 20 real
 * certificates on a shared live TAK Server, so every collaborator here is
 * mocked: no TAK Server call and no database call leaves this process.
 *
 * The generated catalogue is shaped so the correction is actually observable:
 *
 *  - **Two Devices share one `creatorDn`.** This is the whole test. The old
 *    implementation resolved targets via `matchesCreatorDn`, and a `creatorDn`
 *    is issued per ENROLLING USER, not per Device -- so it is only
 *    distinguishable from the corrected `clientUid` match on a catalogue where
 *    one user holds more than one Device. A generator that gave every Device
 *    its own `creatorDn` would pass against the over-revoking code.
 *  - **`clientUid` is reused across many certificates** (a four-uid alphabet
 *    against up to ~26 certificates), matching the live shape: 95 certificates
 *    carried 10 distinct `clientUid`s, one of them holding 60. A Device's
 *    target set is routinely many ids.
 *  - **Every Device has revoked certificates as well as live ones**, and the
 *    live/revoked split is driven through `listLiveCertificates()` returning
 *    the set difference exactly as the real service does -- so "targets the
 *    LIVE certificates" is a real check rather than "targets all of them".
 *    One Device (`uid-alice-retired`) has ONLY revoked certificates, which is
 *    the no-live-certificate no-op case, and it shares the other two Devices'
 *    `creatorDn` -- the over-revoking implementation would revoke its
 *    siblings' certificates for it.
 *  - **`revocationDate` is generated INDEPENDENTLY of `/revoked` membership**,
 *    including the all-non-null case observed live (all 95 active certificates
 *    carried one), so an implementation reading `revocationDate` to decide what
 *    is live cannot pass (Requirement 12.5).
 *
 * Both device-management flags are armed for the whole block and the cap is
 * set well above the generated catalogue size, because a dry-run or a
 * cap abort issues no `DELETE` at all and the property would then hold
 * vacuously; the "a matching Device really did reach the `DELETE`" assertion
 * below is what keeps that honest.
 *
 * Sibling `server/workers/syncWorker.test.js` covers the concrete examples,
 * the four rails, and the audit record.
 */

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    on: jest.fn(),
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn()
  }))
}));

jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() }))
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const SyncWorker = require('../syncWorker');

/** One `creatorDn` per enrolling USER -- alice holds three Devices under hers. */
const ALICE_DN = 'CN=alice,OU=TAK-NZ,O=TAK,C=NZ';
const BOB_DN = 'CN=bob,OU=TAK-NZ,O=TAK,C=NZ';

/**
 * The Devices in the generated catalogue. The first three SHARE `ALICE_DN`:
 * that sharing is the only shape in which a `creatorDn`-based resolution and a
 * `clientUid`-based one differ.
 *
 * `minLive`/`maxLive` bound each Device's live certificate count:
 * `uid-alice-phone` and `uid-alice-tablet` always hold at least one live
 * certificate (so a shared-`creatorDn` sibling is always available to
 * over-revoke), and `uid-alice-retired` never holds any (the no-op case).
 */
const DEVICES = [
  { clientUid: 'uid-alice-phone', creatorDn: ALICE_DN, minLive: 1, maxLive: 4, minRevoked: 0, maxRevoked: 3 },
  { clientUid: 'uid-alice-tablet', creatorDn: ALICE_DN, minLive: 1, maxLive: 4, minRevoked: 0, maxRevoked: 3 },
  { clientUid: 'uid-alice-retired', creatorDn: ALICE_DN, minLive: 0, maxLive: 0, minRevoked: 1, maxRevoked: 3 },
  { clientUid: 'uid-bob-phone', creatorDn: BOB_DN, minLive: 0, maxLive: 4, minRevoked: 0, maxRevoked: 3 }
];

const DEVICE_BY_UID = new Map(DEVICES.map((device) => [device.clientUid, device]));

/** A cap comfortably above the largest generated catalogue, so rail 3 never fires. */
const CAP = 250;

/** An arbitrary non-null `revocationDate`, generated independently of `/revoked`. */
const REVOCATION_DATE = '2026-01-17T01:15:22.160Z';

/**
 * The generated plan: per-Device live/revoked certificate counts, a few
 * certificates carrying no usable `clientUid` (an older enrollment shape), the
 * starting certificate id, and the `revocationDate` decision -- which is either
 * "every certificate carries one" (the live-observed case) or a per-certificate
 * coin flip, in both cases unrelated to `/revoked` membership.
 */
const planArb = fc.record({
  perDevice: fc.tuple(
    ...DEVICES.map((device) =>
      fc.record({
        live: fc.integer({ min: device.minLive, max: device.maxLive }),
        revoked: fc.integer({ min: device.minRevoked, max: device.maxRevoked })
      })
    )
  ),
  unattributedLive: fc.integer({ min: 0, max: 2 }),
  idBase: fc.integer({ min: 1, max: 3000 }),
  allRevocationDatesNonNull: fc.boolean(),
  revocationDateFlags: fc.array(fc.boolean(), { minLength: 32, maxLength: 32 })
});

/**
 * Materializes a plan into `{ live, revoked }` certificate lists in the Marti
 * `TakCert` shape. `revocationDate` is decided by the plan's own flags, never
 * by which list a certificate lands in.
 *
 * @param {object} plan
 * @returns {{live: object[], revoked: object[], all: object[]}}
 */
function buildCatalogue(plan) {
  const live = [];
  const revoked = [];
  let nextId = plan.idBase;
  let flagIndex = 0;

  const push = (target, clientUid, creatorDn) => {
    const nonNullDate =
      plan.allRevocationDatesNonNull || plan.revocationDateFlags[flagIndex % plan.revocationDateFlags.length];
    flagIndex += 1;
    target.push({
      id: nextId++,
      creatorDn,
      clientUid,
      revocationDate: nonNullDate ? REVOCATION_DATE : null
    });
  };

  DEVICES.forEach((device, index) => {
    const counts = plan.perDevice[index];
    for (let i = 0; i < counts.live; i += 1) push(live, device.clientUid, device.creatorDn);
    for (let i = 0; i < counts.revoked; i += 1) push(revoked, device.clientUid, device.creatorDn);
  });

  // Certificates carrying no usable `clientUid`: they belong to no Device row,
  // and they share alice's `creatorDn`, so a `creatorDn`-based resolution
  // targets them too.
  for (let i = 0; i < plan.unattributedLive; i += 1) push(live, undefined, ALICE_DN);

  return { live, revoked, all: [...live, ...revoked] };
}

/**
 * The catalogue arbitrary: a materialized plan whose live list is then fully
 * shuffled, so nothing can pass by relying on catalogue order.
 */
const catalogueArb = planArb
  .map(buildCatalogue)
  .chain((catalogue) =>
    fc
      .shuffledSubarray(catalogue.live, {
        minLength: catalogue.live.length,
        maxLength: catalogue.live.length
      })
      .map((shuffledLive) => ({ ...catalogue, live: shuffledLive }))
  );

/** Every Device is eligible as the revoke target, including the live-certificate-free one. */
const targetUidArb = fc.constantFrom(...DEVICES.map((device) => device.clientUid));

const ascending = (a, b) => a - b;

// Feature: device-management, Property 9: Revocation targets exactly one Device's live certificates
describe('Property 9: Revocation targets exactly one Device\'s live certificates', () => {
  const originalEnabled = process.env.DEVICE_MGMT_ENABLED;
  const originalRevokeEnabled = process.env.DEVICE_MGMT_REVOKE_ENABLED;
  const originalCap = process.env.DEVICE_MGMT_REVOKE_MAX_CERTS;

  beforeEach(() => {
    jest.clearAllMocks();
    // BOTH flags: `markDevicesRevoked` is gated on the first and the `DELETE`
    // on the second, so with either off every run would be a no-write no-op and
    // the property would hold vacuously.
    process.env.DEVICE_MGMT_ENABLED = 'true';
    process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
    process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = String(CAP);
  });

  afterEach(() => {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('DEVICE_MGMT_ENABLED', originalEnabled);
    restore('DEVICE_MGMT_REVOKE_ENABLED', originalRevokeEnabled);
    restore('DEVICE_MGMT_REVOKE_MAX_CERTS', originalCap);
  });

  test.prop([catalogueArb, targetUidArb], { numRuns: 200 })(
    'revokes exactly the target clientUid\'s live certificate ids, none of any other clientUid even under a shared creatorDn, and flips exactly that one Device row',
    async (catalogue, targetUid) => {
      const worker = new SyncWorker();
      worker.pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      worker.takServerService = {
        // The Live_Certificates: in `/active` AND NOT in `/revoked`, which is
        // the set difference the real `listLiveCertificates()` computes.
        listLiveCertificates: jest.fn().mockResolvedValue(catalogue.live),
        listCertificates: jest.fn().mockResolvedValue(catalogue.all),
        listRevokedCertificates: jest.fn().mockResolvedValue(catalogue.revoked),
        revokeCertificates: jest.fn().mockResolvedValue({ success: true })
      };

      const targetDn = DEVICE_BY_UID.get(targetUid).creatorDn;
      const expectedIds = catalogue.live
        .filter((cert) => cert.clientUid === targetUid)
        .map((cert) => cert.id)
        .sort(ascending);
      const foreignLive = catalogue.live.filter((cert) => cert.clientUid !== targetUid);
      const foreignSharingTargetDn = foreignLive.filter((cert) => cert.creatorDn === targetDn);

      // Generator sanity, asserted per run rather than assumed: whenever the
      // target belongs to the multi-Device user, live certificates of OTHER
      // Devices under the same `creatorDn` exist to be wrongly revoked. Without
      // this the property could pass against the over-revoking implementation.
      if (targetDn === ALICE_DN) {
        expect(foreignSharingTargetDn.length).toBeGreaterThan(0);
      }
      // And the catalogue always stays inside the cap, so rail 3 never turns a
      // real revoke into an abort.
      expect(catalogue.live.length).toBeLessThanOrEqual(CAP);

      await expect(
        worker.revokeTakCertificates({ client_uid: targetUid, target_user_id: 7 })
      ).resolves.toBeUndefined();

      const deviceUpdate = worker.pool.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('tak_devices') && sql.includes('revoked = true')
      );

      if (expectedIds.length === 0) {
        // No live certificate for this Device: a successful no-op. No `DELETE`,
        // no `revoked` flip -- not even for the siblings sharing its `creatorDn`.
        expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
        expect(deviceUpdate).toBeUndefined();
        return;
      }

      // The `DELETE` really was reached, so the assertions below are about a
      // revoke that happened rather than one the rails suppressed.
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledTimes(1);
      const [revokedIds] = worker.takServerService.revokeCertificates.mock.calls[0];

      // 1. Exactly the target Device's LIVE certificate ids -- no more, no fewer,
      //    and no already-revoked id re-targeted.
      expect([...revokedIds].sort(ascending)).toEqual(expectedIds);

      // 2. Not one id of any other `clientUid`, including the ones sharing this
      //    Device's `creatorDn` and the ones carrying no `clientUid` at all.
      for (const cert of foreignLive) {
        expect(revokedIds).not.toContain(cert.id);
      }
      for (const cert of catalogue.revoked) {
        expect(revokedIds).not.toContain(cert.id);
      }

      // 3. Exactly ONE `client_uid` reached the Device_Table update: the target.
      expect(deviceUpdate).toBeDefined();
      expect(deviceUpdate[1][0]).toEqual([targetUid]);
    }
  );
});
