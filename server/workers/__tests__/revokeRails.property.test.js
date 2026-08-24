/**
 * device-management task 24.5: the single fast-check property test for
 * design.md's Correctness Property 13 (Requirements 12.9-12.15).
 *
 * The property is about the GATE, not the resolution: for an arbitrary
 * already-resolved target set and an arbitrary combination of the two
 * independent flags, `revokeTakCertificates` issues the
 * `DELETE /Marti/api/certadmin/cert/revoke/{ids}` if and only if
 *
 *   Revoke_Enabled  AND  (device-scoped => exactly one distinct `client_uid`)
 *                   AND  size <= Revoke_Blast_Radius_Cap  AND  size > 0
 *
 * and in every other case issues no `DELETE` and flips no Device_Table
 * `revoked` flag -- while the Revoke_Audit_Record is logged in EVERY case,
 * before the decision point. This path previously over-revoked 20 real
 * certificates on a shared live TAK Server, so every collaborator is mocked:
 * no TAK Server call and no database call leaves this process.
 *
 * Three things about how the resolved set is generated:
 *
 *  - **The resolution is driven directly**, by stubbing `resolveRevokeTargets`
 *    on the worker instance to return a generated
 *    `{ payloadShape, clientUid, targetCertIds, clientUids, unresolvedReason }`.
 *    That is what makes "for all resolved target sets" mean what it says --
 *    arbitrary size and arbitrary uid spread, independent of what any
 *    particular certificate catalogue happens to admit.
 *  - **The multi-uid conjunct is asserted as an INVARIANT, not as a reachable
 *    resolution.** Since task 19.3 the device-scoped resolution matches
 *    `cert.clientUid === payload.client_uid` exactly, so `resolveRevokeTargets`
 *    cannot itself produce a device-scoped set spanning two uids; rail 2 is a
 *    defensive rail against a future resolution defect, and driving the gate
 *    directly is the only way to exercise it at all.
 *  - **The reachable resolution path is NOT retested here.** Sibling
 *    `revokeTakCertificates.deviceScope.property.test.js` (task 19.5, Property 9)
 *    covers "which certificates a real catalogue resolves to"; this file covers
 *    only what the rails do with an already-resolved set.
 *
 * The cap is set to a small value through the real `DEVICE_MGMT_REVOKE_MAX_CERTS`
 * env var, so the production `getRevokeMaxCerts()` predicate stays in the loop
 * while the fixtures stay small, and the boundary is exercised at cap-1, cap and
 * cap+1 through fast-check `examples` -- run every time rather than left to
 * sampling.
 *
 * "No `DELETE`" is asserted as "`revokeCertificates` received no call at all",
 * and "not shortened" as list equality against the full resolved list: a rail
 * that truncated the set to the cap and proceeded would revoke a partial set,
 * which reports a Device as disabled while leaving it usable (Requirement 12.13).
 *
 * **Validates: Requirements 12.9, 12.10, 12.11, 12.12, 12.13, 12.14, 12.15**
 */

jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    on: jest.fn(),
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn()
  }))
}));

// The module-level logger inside `syncWorker.js` is created ONCE at require
// time, so the mock returns one stable instance -- the same pattern
// `syncWorker.test.js` uses -- and the audit/abort/dry-run records are read off
// it. Its calls are cleared per property RUN (not per jest test) below, since
// all runs of a property share one test.
const mockLoggerInstance = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const SyncWorker = require('../syncWorker');

/** A deliberately small Revoke_Blast_Radius_Cap, driven through the real env var. */
const CAP = 4;

/**
 * The uid alphabet. `UIDS[0]` is the device-scoped payload's target, so a
 * single-uid generated set looks exactly like a real device-scoped resolution;
 * the rest are the foreign uids that make a set span Devices.
 */
const UIDS = ['uid-target', 'uid-other-1', 'uid-other-2', 'uid-other-3'];
const TARGET_UID = UIDS[0];

/** Both flags off, both on, and each one alone -- the full cross-product. */
const FLAG_COMBOS = [
  { deviceMgmt: 'true', revoke: 'true' },
  { deviceMgmt: 'true', revoke: undefined },
  { deviceMgmt: undefined, revoke: 'true' },
  { deviceMgmt: undefined, revoke: undefined }
];

/**
 * The generated plan for a resolved target set: which payload shape resolved
 * it, how many certificate ids it carries (sizes straddling the cap are drawn
 * explicitly as well as uniformly), how many distinct `clientUid`s those ids
 * spread across, and where the id numbering starts.
 */
const planArb = fc.record({
  payloadShape: fc.constantFrom('client_uid', 'tak_usernames'),
  size: fc.oneof(
    fc.constantFrom(0, 1, CAP - 1, CAP, CAP + 1),
    fc.integer({ min: 0, max: CAP + 3 })
  ),
  uidCount: fc.integer({ min: 1, max: UIDS.length }),
  idBase: fc.integer({ min: 1, max: 5000 })
});

const flagsArb = fc.constantFrom(...FLAG_COMBOS);

/**
 * Materializes a plan into the exact shape `resolveRevokeTargets` returns, with
 * the uids dealt round-robin across the ids so all `uidCount` of them really
 * appear (up to the set size). `targetCertIds` is ascending, matching the
 * handler's own `sortCertIds` ordering, so the logged list, the digest and the
 * list handed to the `DELETE` are all comparable as-is.
 *
 * @param {object} plan
 * @returns {{payloadShape: string, clientUid: string|null, targetCertIds: number[],
 *   clientUids: Set<string>, unresolvedReason: null}}
 */
function buildResolution(plan) {
  const targetCertIds = Array.from({ length: plan.size }, (_unused, index) => plan.idBase + index);
  const clientUids = new Set(
    targetCertIds.map((_id, index) => UIDS[index % plan.uidCount])
  );

  return {
    payloadShape: plan.payloadShape,
    clientUid: plan.payloadShape === 'client_uid' ? TARGET_UID : null,
    targetCertIds,
    clientUids,
    unresolvedReason: null
  };
}

/**
 * A payload of the plan's shape. It has to agree with the generated
 * `payloadShape`, because the handler picks which certificate view to fetch
 * from the payload itself (`fetchRevokeResolutionInputs`) even though the
 * resolution is stubbed.
 *
 * @param {object} plan
 * @returns {object}
 */
function payloadFor(plan) {
  return plan.payloadShape === 'client_uid'
    ? { client_uid: TARGET_UID, target_user_id: 7 }
    : { tak_usernames: ['alice'] };
}

/**
 * Every straddling size, on both payload shapes, under every flag combination,
 * for both a single-uid and a multi-uid set: 48 cases run on every invocation
 * rather than left to sampling.
 */
const EXAMPLES = [];
for (const size of [CAP - 1, CAP, CAP + 1]) {
  for (const payloadShape of ['client_uid', 'tak_usernames']) {
    for (const flags of FLAG_COMBOS) {
      for (const uidCount of [1, 3]) {
        EXAMPLES.push([{ payloadShape, size, uidCount, idBase: 1 }, flags]);
      }
    }
  }
}

// Feature: device-management, Property 13: A DELETE is issued only when armed, single-Device, and within the cap
describe('Property 13: A DELETE is issued only when armed, single-Device, and within the cap', () => {
  const originalEnabled = process.env.DEVICE_MGMT_ENABLED;
  const originalRevokeEnabled = process.env.DEVICE_MGMT_REVOKE_ENABLED;
  const originalCap = process.env.DEVICE_MGMT_REVOKE_MAX_CERTS;

  afterEach(() => {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('DEVICE_MGMT_ENABLED', originalEnabled);
    restore('DEVICE_MGMT_REVOKE_ENABLED', originalRevokeEnabled);
    restore('DEVICE_MGMT_REVOKE_MAX_CERTS', originalCap);
  });

  /** Applies a generated flag combination, leaving an absent flag genuinely unset. */
  function applyFlags(flags) {
    if (flags.deviceMgmt === undefined) delete process.env.DEVICE_MGMT_ENABLED;
    else process.env.DEVICE_MGMT_ENABLED = flags.deviceMgmt;
    if (flags.revoke === undefined) delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
    else process.env.DEVICE_MGMT_REVOKE_ENABLED = flags.revoke;
    process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = String(CAP);
  }

  /** The `{ record, order }` of a log line, matched on its message. */
  function logLine(mockFn, matches) {
    const index = mockFn.mock.calls.findIndex(([, msg]) => matches(msg));
    if (index === -1) return undefined;
    return { record: mockFn.mock.calls[index][0], order: mockFn.mock.invocationCallOrder[index] };
  }

  test.prop([planArb, flagsArb], { numRuns: 200, examples: EXAMPLES })(
    'issues the DELETE with the full, unshortened id list exactly when armed, single-Device and within the cap, flips no revoked flag otherwise, and logs the audit record before the decision point in every case',
    async (plan, flags) => {
      // Per RUN, not per test: all runs of a property share one jest test, so
      // without this the log lines of earlier runs would still be visible.
      mockLoggerInstance.info.mockClear();
      mockLoggerInstance.debug.mockClear();
      mockLoggerInstance.warn.mockClear();
      mockLoggerInstance.error.mockClear();

      applyFlags(flags);

      const resolution = buildResolution(plan);
      const payload = payloadFor(plan);
      const operation = {
        id: 'op-prop-13',
        operation_type: 'revoke_tak_certificates',
        correlation_id: 'corr-prop-13',
        created_by: 42,
        retry_count: 0,
        max_retries: 48,
        payload
      };

      const worker = new SyncWorker();
      worker.pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
      worker.takServerService = {
        listCertificates: jest.fn().mockResolvedValue([]),
        listLiveCertificates: jest.fn().mockResolvedValue([]),
        listRevokedCertificates: jest.fn().mockResolvedValue([]),
        revokeCertificates: jest.fn().mockResolvedValue({ success: true })
      };
      // The gate is driven directly: see this file's header on why rail 2 is
      // only reachable this way.
      worker.resolveRevokeTargets = jest.fn(() => resolution);

      const size = resolution.targetCertIds.length;
      const armed = flags.revoke === 'true';
      const deviceMgmtOn = flags.deviceMgmt === 'true';
      // The single-uid conjunct is device-scoped only: the user-scoped shape
      // legitimately spans a user's Devices (Requirements 12.3, 12.15).
      const multiUid = plan.payloadShape === 'client_uid' && resolution.clientUids.size > 1;
      const overCap = size > CAP;
      const expectDelete = armed && !multiUid && !overCap && size > 0;
      // Rails 2 and 3 refuse permanently; the empty set and the dry-run are
      // successful no-ops.
      const expectAbort = multiUid || overCap;

      if (expectAbort) {
        await expect(worker.revokeTakCertificates(payload, operation)).rejects.toThrow(
          multiUid ? /revoke_multiple_client_uids/ : /revoke_cap_exceeded/
        );
      } else {
        await expect(worker.revokeTakCertificates(payload, operation)).resolves.toBeUndefined();
      }

      // The stub really was the resolution the rails ran against.
      expect(worker.resolveRevokeTargets).toHaveBeenCalledTimes(1);

      // --- Rail 1: the audit record, in EVERY case (12.14, 12.15) -----------
      const audit = logLine(mockLoggerInstance.info, (msg) => msg === 'revoke_audit');
      expect(audit).toBeDefined();
      expect(audit.record.operationId).toBe('op-prop-13');
      expect(audit.record.actingUserId).toBe(42);
      expect(audit.record.payloadShape).toBe(plan.payloadShape);
      expect(audit.record.capLimit).toBe(CAP);
      expect(audit.record.dryRun).toBe(!armed);
      // The full list, never truncated, in the log as well as at the DELETE.
      expect(audit.record.targetCertIds).toEqual(resolution.targetCertIds);
      expect(audit.record.targetCertCount).toBe(size);
      expect(audit.record.resolvedClientUids).toEqual(Array.from(resolution.clientUids));

      const deviceUpdate = worker.pool.query.mock.calls.find(
        ([sql]) =>
          typeof sql === 'string' && sql.includes('tak_devices') && sql.includes('revoked = true')
      );

      if (!expectDelete) {
        // No `DELETE` at all -- not a shortened one, not an empty one -- and no
        // `revoked` flag flipped (Requirements 12.11, 12.12, 12.13).
        expect(worker.takServerService.revokeCertificates).not.toHaveBeenCalled();
        expect(deviceUpdate).toBeUndefined();

        // The audit record still preceded whichever rail refused it.
        const refusal =
          logLine(mockLoggerInstance.error, (msg) => typeof msg === 'string' && msg.startsWith('revoke_abort')) ||
          logLine(mockLoggerInstance.warn, (msg) => typeof msg === 'string' && msg.startsWith('revoke_dry_run'));
        // An empty resolved set returns at the no-match no-op, which sits
        // BETWEEN rails 3 and 4 -- so it logs neither an abort nor a dry-run,
        // and there is no refusal line to order against.
        if (expectAbort || (!armed && size > 0)) {
          expect(refusal).toBeDefined();
          expect(audit.order).toBeLessThan(refusal.order);
        }
        return;
      }

      // --- The DELETE was issued: exactly once, with the FULL list ----------
      expect(worker.takServerService.revokeCertificates).toHaveBeenCalledTimes(1);
      const [revokedIds] = worker.takServerService.revokeCertificates.mock.calls[0];
      expect(revokedIds).toEqual(resolution.targetCertIds);
      expect(revokedIds).toHaveLength(size);

      // The audit record was logged BEFORE the decision point, asserted on real
      // invocation order rather than on the mere presence of the line.
      expect(audit.order).toBeLessThan(
        worker.takServerService.revokeCertificates.mock.invocationCallOrder[0]
      );

      // `revoked` is only ever flipped when Device_Mgmt_Enabled is also true
      // (Requirement 12.9): the second flag arms the `DELETE`, the first one
      // owns the Device_Table.
      if (deviceMgmtOn) {
        expect(deviceUpdate).toBeDefined();
        expect(deviceUpdate[1][0]).toEqual(Array.from(resolution.clientUids));
      } else {
        expect(deviceUpdate).toBeUndefined();
      }
    }
  );
});
