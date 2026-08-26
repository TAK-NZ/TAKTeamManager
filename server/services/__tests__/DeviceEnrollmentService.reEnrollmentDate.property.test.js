// Feature: takserver-enrollment, Property 5: The Re_Enrollment_Date is exactly 365 days of generation time, and no certificate row is read to compute it
//
// **Validates: Requirements 10.3**

/**
 * takserver-enrollment task 7.4: the single fast-check property test for
 * design.md's Property 5 (Requirement 10.3).
 *
 * `#buildEnrollment` is PRIVATE (`static async #buildEnrollment(...)`), so it
 * cannot be called directly from this file. It is driven indirectly through
 * `DeviceEnrollmentService.generateSelfEnrollment(actingUser)`, with every
 * OTHER dependency mocked so the only moving part under test is the
 * `reEnrollmentDate` computation:
 *   - `User.findById` returns a controlled, already-resolved Human_Principal
 *     row (`is_team_device: false`), so `generateSelfEnrollment` reaches
 *     `#buildEnrollment` rather than throwing `DeviceSessionCannotSelfEnrollError`.
 *   - `authentikService.createAppPasswordToken` resolves a fixed token.
 *   - `QRCode.toDataURL` (the `qrcode` package) resolves a fixed data URL, so
 *     no real QR encoding runs across 200+ generated instants.
 *   - The `team_memberships` lookup resolves no row (no team), so the
 *     Callsign/colour resolution short-circuits to the `'None'` literals
 *     and never reaches `UserAttributesService.generateCallsign`.
 *   - `Date.now()` is mocked, via `jest.spyOn(Date, 'now')`, to return each
 *     GENERATED instant for the duration of that one call.
 *
 * `Date.now()` is the ONLY thing that varies run to run. The expected
 * Re_Enrollment_Date is re-derived in this file as
 * `mockedNow + 365 * 24 * 60 * 60 * 1000`, the literal expression written
 * out -- `CERTIFICATE_LIFETIME_DAYS` is never imported from the subject
 * module, per the task's independent-re-derivation instruction: a test that
 * imports the constant would prove only that multiplication works, not that
 * 365 is the right number.
 *
 * ## The structural arm
 *
 * The `tak_devices` count query -- the ONLY `tak_devices` access
 * `#buildEnrollment` makes -- is mocked to return a POISONED row carrying
 * `expires_at`/`issued_at` values dated in 1900, wildly different from any
 * correct `reEnrollmentDate`. Two assertions follow from that:
 *   (a) BEHAVIOURAL -- the returned `reEnrollmentDate` still matches the
 *       independently-computed arithmetic value regardless of what is in
 *       the poisoned row, proving the wrong data (if it existed) would not
 *       have been used even were it present; and
 *   (b) STRUCTURAL -- the actual SQL text `pool.query` was called with for
 *       every `tak_devices` access is inspected directly and asserted to
 *       project neither `expires_at` nor `issued_at` in its column list,
 *       proving the wrong data could not have been read AT ALL, not merely
 *       that this implementation happens not to read it.
 *
 * ## Boundary concentration
 *
 * The generation-instant generator is a weighted `fc.oneof` of PINNED
 * boundary cases plus one broad uniform arm:
 *   - either side of the NZ (southern-hemisphere) autumn/spring DST
 *     transitions (early April / late September 2024);
 *   - either side of the US (northern-hemisphere) DST transitions
 *     (March / November 2024);
 *   - an instant inside a leap year (2024) and the day before a leap day
 *     (28 Feb 2024, `+365 days` lands on 28 Feb 2025 -- a non-leap year);
 *   - pre-epoch instants (before 1 Jan 1970, including a negative ms value);
 *   - far-future instants (year 2100+);
 *   - a broad arm drawing uniformly from the whole `Date`-representable
 *     range (with margin so `mockedNow + 365 days` stays representable).
 *
 * ## Anti-vacuity
 *
 * A module-level counter records, per generated instant, which pinned
 * category (if any) produced it. The trailing `it()` asserts every named
 * category was actually exercised at least once across the whole run --
 * DST-southern, DST-northern, leap-year, leap-day-eve, pre-epoch,
 * far-future, and the broad arm -- so the boundary concentration is
 * verified rather than assumed.
 */

jest.mock('../../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('../../models/Team', () => ({
  isAdmin: jest.fn(),
  getAncestorChain: jest.fn()
}));
jest.mock('../TeamMembershipService', () => ({
  addUserToTeam: jest.fn()
}));
jest.mock('../EventPublisher', () => ({
  publishOperation: jest.fn()
}));
jest.mock('../authentik', () => ({
  createUser: jest.fn(),
  createAppPasswordToken: jest.fn()
}));
jest.mock('../../models/User', () => ({
  findById: jest.fn()
}));
jest.mock('../userAttributes', () => ({
  generateCallsign: jest.fn()
}));
jest.mock('qrcode', () => ({
  toDataURL: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn() };
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../../config/database');
const authentikService = require('../authentik');
const User = require('../../models/User');
const QRCode = require('qrcode');
const DeviceEnrollmentService = require('../DeviceEnrollmentService');

const HUMAN_PRINCIPAL_ROW = Object.freeze({
  id: 100,
  username: 'jdoe',
  authentik_user_id: 555,
  is_team_device: false,
  tak_role: 'Team Member'
});

const ACTING_USER = Object.freeze({ userId: 100, is_global_manager: false });

/** The poisoned tak_devices row: a live-certificate count PLUS timestamp-shaped
 * columns dated wildly earlier than any correct reEnrollmentDate. If
 * #buildEnrollment misread either of these as the basis for
 * reEnrollmentDate, the returned value would differ from the independently
 * computed one by many decades. */
const POISONED_TAK_DEVICES_ROW = Object.freeze({
  count: '3',
  expires_at: '1900-01-01T00:00:00.000Z',
  issued_at: '1899-01-01T00:00:00.000Z'
});

// ---------------------------------------------------------------------------
// Generation-instant generator: pinned boundary cases + one broad uniform arm
// ---------------------------------------------------------------------------

// `Date`-representable range is roughly +/-8.64e15 ms from the epoch. Margin
// is left on both ends so `mockedNow + 365 days` in ms stays representable.
const CERTIFICATE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const DATE_MARGIN_MS = CERTIFICATE_LIFETIME_MS + 1_000_000_000;
const DATE_MAX_MS = 8_640_000_000_000_000;

const PINNED_INSTANTS = Object.freeze([
  // Southern hemisphere (NZ) DST transitions, either side, 2024.
  { tag: 'dstSouthern', ms: new Date('2024-04-07T01:59:00+13:00').getTime() }, // just before NZDT ends
  { tag: 'dstSouthern', ms: new Date('2024-04-07T02:01:00+13:00').getTime() }, // just after NZDT ends
  { tag: 'dstSouthern', ms: new Date('2024-09-29T01:59:00+12:00').getTime() }, // just before NZDT starts
  { tag: 'dstSouthern', ms: new Date('2024-09-29T02:01:00+13:00').getTime() }, // just after NZDT starts

  // Northern hemisphere (US) DST transitions, either side, 2024.
  { tag: 'dstNorthern', ms: new Date('2024-03-10T01:59:00-05:00').getTime() }, // just before spring-forward
  { tag: 'dstNorthern', ms: new Date('2024-03-10T02:01:00-04:00').getTime() }, // just after spring-forward
  { tag: 'dstNorthern', ms: new Date('2024-11-03T01:59:00-04:00').getTime() }, // just before fall-back
  { tag: 'dstNorthern', ms: new Date('2024-11-03T01:01:00-05:00').getTime() }, // just after fall-back

  // Inside a leap year.
  { tag: 'leapYear', ms: new Date('2024-06-15T12:00:00.000Z').getTime() },
  { tag: 'leapYear', ms: new Date('2024-02-29T00:30:00.000Z').getTime() }, // leap day itself

  // The day before a leap day (28 Feb of a leap year): +365 days lands on
  // 28 Feb of the FOLLOWING, non-leap year.
  { tag: 'leapDayEve', ms: new Date('2024-02-28T23:59:00.000Z').getTime() },
  { tag: 'leapDayEve', ms: new Date('2024-02-28T00:00:01.000Z').getTime() },

  // Pre-epoch instants.
  { tag: 'preEpoch', ms: new Date('1960-01-01T00:00:00.000Z').getTime() },
  { tag: 'preEpoch', ms: new Date('1969-12-31T23:59:59.000Z').getTime() },
  { tag: 'preEpoch', ms: -1 },
  { tag: 'preEpoch', ms: -86400000 },

  // Far-future instants (2100+).
  { tag: 'farFuture', ms: new Date('2100-01-01T00:00:00.000Z').getTime() },
  { tag: 'farFuture', ms: new Date('2999-12-31T23:59:59.000Z').getTime() },

  // The epoch itself -- a boundary in its own right.
  { tag: 'epochBoundary', ms: 0 }
]);

const pinnedInstantArb = fc.constantFrom(...PINNED_INSTANTS);

const broadInstantArb = fc
  .integer({ min: -DATE_MAX_MS + DATE_MARGIN_MS, max: DATE_MAX_MS - DATE_MARGIN_MS })
  .map((ms) => ({ tag: 'broad', ms }));

const generationInstantArb = fc.oneof(
  { weight: 3, arbitrary: pinnedInstantArb },
  { weight: 1, arbitrary: broadInstantArb }
);

// ---------------------------------------------------------------------------
// Anti-vacuity tracking
// ---------------------------------------------------------------------------

const seenTags = {
  dstSouthern: 0,
  dstNorthern: 0,
  leapYear: 0,
  leapDayEve: 0,
  preEpoch: 0,
  farFuture: 0,
  epochBoundary: 0,
  broad: 0
};

describe('Property 5: The Re_Enrollment_Date is exactly 365 days of generation time, and no certificate row is read to compute it', () => {
  test.prop([generationInstantArb], { numRuns: 300 })(
    'reEnrollmentDate equals mockedNow + 365*24*60*60*1000 exactly, and no query it issues to tak_devices projects expires_at or issued_at',
    async ({ tag, ms: mockedNow }) => {
      seenTags[tag] += 1;

      jest.clearAllMocks();

      const issuedQueries = [];
      pool.query.mockImplementation((sql) => {
        issuedQueries.push(sql);
        if (typeof sql === 'string' && sql.includes('FROM team_memberships')) {
          // No Direct_Membership team -- keeps Callsign/colour resolution
          // out of scope for this property (Property 7/8's subject, not
          // this one's).
          return Promise.resolve({ rows: [] });
        }
        if (typeof sql === 'string' && sql.includes('FROM tak_devices')) {
          return Promise.resolve({ rows: [POISONED_TAK_DEVICES_ROW] });
        }
        return Promise.resolve({ rows: [] });
      });

      User.findById.mockResolvedValue(HUMAN_PRINCIPAL_ROW);
      authentikService.createAppPasswordToken.mockResolvedValue({
        key: 'fixed-token-key',
        expires: '2024-01-01T00:30:00.000Z',
        identifier: 'device-enrollment-fixed'
      });
      QRCode.toDataURL.mockResolvedValue('data:image/png;base64,FAKE');

      const originalTakServerUrl = process.env.TAK_SERVER_URL;
      process.env.TAK_SERVER_URL = 'https://tak.example.com:8443';

      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(mockedNow);

      let result;
      try {
        result = await DeviceEnrollmentService.generateSelfEnrollment(ACTING_USER);
      } finally {
        dateNowSpy.mockRestore();
        if (originalTakServerUrl === undefined) {
          delete process.env.TAK_SERVER_URL;
        } else {
          process.env.TAK_SERVER_URL = originalTakServerUrl;
        }
      }

      // --- Behavioural arm ---
      // Independently re-derived: the literal expression, never
      // CERTIFICATE_LIFETIME_DAYS imported from the subject module.
      const expectedReEnrollmentDate = new Date(mockedNow + 365 * 24 * 60 * 60 * 1000).toISOString();
      expect(result.reEnrollmentDate).toBe(expectedReEnrollmentDate);

      // --- Structural arm ---
      // The query was actually issued (anti-vacuity for the structural
      // check itself) ...
      const takDevicesQueries = issuedQueries.filter(
        (sql) => typeof sql === 'string' && sql.includes('tak_devices')
      );
      expect(takDevicesQueries.length).toBeGreaterThan(0);

      // ... and NONE of them project expires_at or issued_at in their
      // column list, whatever the mocked row above contained.
      takDevicesQueries.forEach((sql) => {
        expect(sql.toLowerCase()).not.toMatch(/expires_at/);
        expect(sql.toLowerCase()).not.toMatch(/issued_at/);
      });
    }
  );

  it('exercised every pinned boundary category and the broad arm (anti-vacuity)', () => {
    expect(seenTags.dstSouthern).toBeGreaterThan(0);
    expect(seenTags.dstNorthern).toBeGreaterThan(0);
    expect(seenTags.leapYear).toBeGreaterThan(0);
    expect(seenTags.leapDayEve).toBeGreaterThan(0);
    expect(seenTags.preEpoch).toBeGreaterThan(0);
    expect(seenTags.farFuture).toBeGreaterThan(0);
    expect(seenTags.epochBoundary).toBeGreaterThan(0);
    expect(seenTags.broad).toBeGreaterThan(0);
  });
});
