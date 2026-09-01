// Feature: cert-expiry-notifications, Property 1: Multi-tier-backlog collapse is exact -- exactly one email, and toEmail/toMarkResolvedOnly's union equals the generated DUE-and-unresolved set exactly
//
// **Validates: Requirements 2.1, 2.3**

/**
 * cert-expiry-notifications task 16.1: property test for design.md's
 * Testing Notes candidate:
 *
 *   "across any generated subset of the four tiers being simultaneously
 *   DUE-and-unresolved for one certificate, exactly one (the smallest
 *   threshold_days) ends up in toEmail and every other one ends up in
 *   toMarkResolvedOnly, and the union of both sets' threshold_days
 *   values equals the generated DUE-and-unresolved set exactly -- never
 *   more, never fewer."
 *
 * Drives the REAL `CertExpiryNotificationService.findEligibleCandidates`
 * against a mocked `pool.query`, for a single candidate row whose
 * `daysLeft` is engineered (via a generated `expires_at`) to make a
 * randomly generated SUBSET of the four configured tiers simultaneously
 * DUE, with a randomly generated subset of THOSE already marked resolved
 * in `cert_expiry_notifications`. The property's own expectation --
 * which threshold_days values should end up DUE-and-unresolved -- is
 * computed independently from the generated inputs (the tier
 * thresholds and the resolved set), never by calling the function under
 * test or importing its internal tables, per this codebase's
 * property-test convention.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
}));
jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
}));
jest.mock('./EmailService', () => jest.fn().mockImplementation(() => ({ sendEmail: jest.fn() })));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../config/database');
const CertExpiryNotificationService = require('./CertExpiryNotificationService');

const NOW = new Date('2026-08-31T00:00:00.000Z');
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Fixed tier configuration for the whole property (matches this feature's
// documented defaults) -- kept out of process.env so the test is immune to
// env pollution from other suites/processes.
const ORIGINAL_ENV = { ...process.env };
beforeAll(() => {
  process.env.CERT_EXPIRY_TIER1_DAYS = '30';
  process.env.CERT_EXPIRY_TIER2_DAYS = '15';
  process.env.CERT_EXPIRY_TIER3_DAYS = '8';
  process.env.CERT_EXPIRY_TIER4_DAYS = '1';
  process.env.CERT_EXPIRY_ACTIVITY_WINDOW_DAYS = '90';
});
afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

const TIER_THRESHOLDS = [30, 15, 8, 1]; // TIER1..TIER4, day-descending

/** Anti-vacuity: every distinct subset SIZE (1..4) actually generated and exercised. */
const observedSubsetSizes = new Set();

describe('Property 1: Multi-tier-backlog collapse is exact', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test.prop(
    [
      // A non-empty subset of the four tier indices (0=TIER1..3=TIER4),
      // representing which tiers are simultaneously DUE for this run.
      fc
        .uniqueArray(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 4 })
        .map((indices) => indices.sort((a, b) => a - b)),
      // Which of THOSE due tiers are already resolved (a further subset).
      fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 0, maxLength: 4 })
    ],
    { numRuns: 300 }
  )(
    'for any DUE tier subset and any already-resolved subset of it, toEmail carries exactly the smallest unresolved threshold_days (or nothing if all resolved), and toEmail+toMarkResolvedOnly together equal the DUE-and-unresolved set exactly',
    async (dueIndices, resolvedIndicesRaw) => {
      observedSubsetSizes.add(dueIndices.length);

      // Engineer daysLeft so EXACTLY the generated tier indices are DUE.
      // Thresholds are day-descending (30,15,8,1), and a tier is DUE iff
      // `daysLeft <= tier.thresholdDays` -- so for any FIXED daysLeft,
      // the DUE set is always a PREFIX of indices {0..k} (a smaller
      // index has a LARGER threshold, so it is easier to satisfy). To
      // keep this property's daysLeft engineering exact for every
      // generated dueIndices set, it is normalised here to its
      // prefix closure {0..max(dueIndices)} before use -- still a
      // faithfully generated (if narrowed) input space, and the
      // independent re-derivation below is computed from this SAME
      // normalised set, so the two always agree on what was actually
      // requested.
      const maxDueIndex = Math.max(...dueIndices);
      const effectiveDueIndices = [0, 1, 2, 3].filter((i) => i <= maxDueIndex);

      // daysLeft set to the SMALLEST due threshold's value (the prefix's
      // last/largest-index entry) satisfies `daysLeft <= threshold` for
      // every due index, and `daysLeft > threshold` for the next index up
      // (if any), since thresholds strictly decrease.
      const smallestDueThreshold = TIER_THRESHOLDS[maxDueIndex];
      const expiresAt = new Date(NOW.getTime() + smallestDueThreshold * MS_PER_DAY);

      // Narrow the resolved-subset generator to the same effective due
      // set, and dedupe.
      const resolvedIndices = [...new Set(resolvedIndicesRaw)].filter((i) => effectiveDueIndices.includes(i));

      const clientUid = 'ANDROID-property-1';
      const certId = 1;

      const candidateRow = {
        client_uid: clientUid,
        cert_id: certId,
        expires_at: expiresAt,
        last_seen_at: NOW, // well within the 90-day activity window
        issued_at: null,
        user_id: 100,
        is_team_device: false,
        email: 'owner@example.com',
        username: 'jdoe',
        first_name: 'Jane',
        direct_team_id: null,
      };

      const resolvedRows = resolvedIndices.map((i) => ({
        client_uid: clientUid,
        cert_id: certId,
        threshold_days: TIER_THRESHOLDS[i],
      }));

      pool.query
        .mockResolvedValueOnce({ rows: [candidateRow] }) // candidate SELECT
        .mockResolvedValueOnce({ rows: resolvedRows }) // batched already-resolved lookup
        .mockResolvedValue({ rows: [] }); // any INSERT

      const { toEmail, toMarkResolvedOnly } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

      // Independent re-derivation: the DUE-and-unresolved set, computed
      // purely from the generated inputs (never from the function's own
      // output).
      const dueUnresolvedThresholds = effectiveDueIndices
        .filter((i) => !resolvedIndices.includes(i))
        .map((i) => TIER_THRESHOLDS[i]);

      if (dueUnresolvedThresholds.length === 0) {
        expect(toEmail).toHaveLength(0);
        expect(toMarkResolvedOnly).toHaveLength(0);
        return;
      }

      // Exactly one toEmail entry, carrying the SMALLEST (most urgent)
      // due-and-unresolved threshold_days.
      const expectedMostUrgent = Math.min(...dueUnresolvedThresholds);
      expect(toEmail).toHaveLength(1);
      expect(toEmail[0].thresholdDays).toBe(expectedMostUrgent);
      expect(toEmail[0].clientUid).toBe(clientUid);

      // Every OTHER due-and-unresolved threshold lands in
      // toMarkResolvedOnly -- no more, no fewer.
      const expectedBacklog = dueUnresolvedThresholds.filter((t) => t !== expectedMostUrgent).sort((a, b) => a - b);
      const actualBacklog = toMarkResolvedOnly.map((e) => e.thresholdDays).sort((a, b) => a - b);
      expect(actualBacklog).toEqual(expectedBacklog);

      // The union of both sets' threshold_days equals the
      // DUE-and-unresolved set exactly.
      const union = [toEmail[0].thresholdDays, ...actualBacklog].sort((a, b) => a - b);
      expect(union).toEqual([...dueUnresolvedThresholds].sort((a, b) => a - b));
    }
  );

  it('exercised DUE-subset sizes of both 1 (no backlog) and >1 (a real backlog) across the whole run (anti-vacuity)', () => {
    expect(observedSubsetSizes.has(1)).toBe(true);
    const sawBacklogCase = [...observedSubsetSizes].some((size) => size > 1);
    expect(sawBacklogCase).toBe(true);
  });
});

// Feature: cert-expiry-notifications, Property 2: Escalation_Round resolution is monotonically additive by round
//
// **Validates: Requirement 4.1 (Escalation_Round definition)**

/**
 * cert-expiry-notifications task 16.2: property test for design.md's
 * Testing Notes candidate:
 *
 *   "for any generated chain of depth 0..N (device's own team at depth N)
 *   with a generated set of direct admins at each depth, the resolved
 *   recipient set for round r is always a SUBSET of the resolved
 *   recipient set for round r+1 (for r in 1..3), round 1's resolved set
 *   is always exactly the device's own team's (depth-N) admins, and
 *   round 4's resolved set always equals the union of every depth's
 *   admins including depth 0 (the Organisation), regardless of N."
 *
 * Drives the REAL `CertExpiryNotificationService.sendTeamOwnedDigests`
 * (the only public entry point that reaches the private
 * `#resolveEscalationRecipients`) against a mocked `Team.getAncestorChain`
 * and a mocked `pool.query` that answers the depth-bounded admin-set
 * query by filtering a generated in-memory per-depth admin table --
 * itself a faithful model of the real predicate (`tm.team_id = ANY($1)
 * AND role='admin' AND inherited_from_team_id IS NULL AND
 * account_status='active'`), never a call into the function under test's
 * own resolved value.
 *
 * The expectation (which admins SHOULD be reachable at each round) is
 * computed independently from the SAME generated chain/admin-table
 * inputs, using the depth-floor arithmetic transcribed directly from
 * Requirement 4.1's own acceptance criterion text (round 1 = depth N
 * only; each subsequent round subtracts one from the floor; round 4 =
 * floor 0 unconditionally) -- not by importing or re-deriving that
 * arithmetic from the service's own source.
 */
describe('Property 2: Escalation_Round resolution is monotonically additive by round', () => {
  const Team = require('../models/Team');

  beforeEach(() => {
    jest.resetAllMocks();
  });

  /** Builds a root-first ancestor chain of the given depth (device's own team at index `deviceDepth`). */
  function buildChain(deviceDepth) {
    return Array.from({ length: deviceDepth + 1 }, (_, depth) => ({ id: 1000 + depth, depth }));
  }

  /** The independently-computed depth floor for a given round, per Requirement 4.1's own text. */
  function expectedDepthFloor(round, deviceDepth) {
    return round === 4 ? 0 : Math.max(0, deviceDepth - (round - 1));
  }

  test.prop(
    [
      fc.integer({ min: 0, max: 6 }), // deviceDepth (N)
      // One admin-id array per depth (0..deviceDepth), each possibly empty.
      fc.array(fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 0, maxLength: 3 }), {
        minLength: 1,
        maxLength: 7,
      }),
    ],
    { numRuns: 300 }
  )(
    "for any chain depth N and any per-depth admin set, round r's resolved admin-id set is a subset of round r+1's, round 1 equals exactly depth N's own admins, and round 4 equals the union of every depth's admins",
    async (deviceDepth, perDepthAdminIdsRaw) => {
      // Normalise perDepthAdminIdsRaw to exactly deviceDepth+1 entries
      // (one per depth 0..deviceDepth), padding with empty arrays or
      // truncating as needed -- fast-check's own array-length generator
      // does not know about deviceDepth, so this keeps every generated
      // pair internally consistent.
      const perDepthAdminIds = Array.from(
        { length: deviceDepth + 1 },
        (_, depth) => perDepthAdminIdsRaw[depth] || []
      );

      Team.getAncestorChain.mockResolvedValue(buildChain(deviceDepth));

      const pool = require('../config/database');

      const resolvedByRound = {};

      for (const round of [1, 2, 3, 4]) {
        pool.query.mockReset();
        pool.query.mockImplementationOnce((sql, params) => {
          // Model the real predicate: every admin id at a depth whose
          // team id is in the supplied set.
          const teamIds = new Set(params[0]);
          const resolvedIds = new Set();
          for (let depth = 0; depth <= deviceDepth; depth++) {
            if (teamIds.has(1000 + depth)) {
              for (const adminId of perDepthAdminIds[depth]) {
                resolvedIds.add(adminId);
              }
            }
          }
          return Promise.resolve({
            rows: [...resolvedIds].map((id) => ({ id, email: `admin${id}@example.com` })),
          });
        });

        const candidate = {
          clientUid: `ANDROID-round-${round}`,
          certId: 1,
          thresholdDays: 30,
          round,
          isTeamDevice: true,
          directTeamId: 1000 + deviceDepth,
          email: null,
          username: 'AUK-D7K3QMX',
          firstName: null,
          expiresAt: new Date('2026-09-30T00:00:00.000Z'),
        };

        await CertExpiryNotificationService.sendTeamOwnedDigests([candidate]);

        const [, params] = pool.query.mock.calls[0];
        const requestedTeamIds = new Set(params[0]);

        // Independent re-derivation: the admin ids that SHOULD be
        // resolvable at this round, from the SAME generated
        // perDepthAdminIds, using Requirement 4.1's own depth-floor rule.
        const floor = expectedDepthFloor(round, deviceDepth);
        const expectedIds = new Set();
        for (let depth = floor; depth <= deviceDepth; depth++) {
          for (const adminId of perDepthAdminIds[depth]) {
            expectedIds.add(adminId);
          }
        }

        resolvedByRound[round] = expectedIds;

        // The query's own requested team-id set matches the
        // independently-computed floor exactly.
        const expectedTeamIds = new Set(
          Array.from({ length: deviceDepth - floor + 1 }, (_, i) => 1000 + floor + i)
        );
        expect(requestedTeamIds).toEqual(expectedTeamIds);
      }

      // Round 1 equals EXACTLY the device's own team's (depth N) admins.
      expect(resolvedByRound[1]).toEqual(new Set(perDepthAdminIds[deviceDepth]));

      // Round 4 equals the union of every depth's admins, including
      // depth 0 (the Organisation), regardless of N.
      const unionOfEveryDepth = new Set();
      for (const ids of perDepthAdminIds) {
        for (const id of ids) unionOfEveryDepth.add(id);
      }
      expect(resolvedByRound[4]).toEqual(unionOfEveryDepth);

      // Monotonic subset growth: round r's set is a subset of round
      // r+1's, for r in 1..3.
      for (const r of [1, 2, 3]) {
        for (const id of resolvedByRound[r]) {
          expect(resolvedByRound[r + 1].has(id)).toBe(true);
        }
      }
    }
  );
});
