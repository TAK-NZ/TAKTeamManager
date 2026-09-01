/**
 * Tests for `server/config/certExpiryNotifications.js`
 * (cert-expiry-notifications task 2.2, Requirements 9.1, 9.2, 9.4).
 *
 * Mirrors `deviceMgmt.test.js`'s table-driven shape for the same
 * boolean-env and positive-integer-with-fallback conventions.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const {
  isCertExpiryNotificationsEnabled,
  getCertExpiryTierDays,
  getCertExpiryActivityWindowDays,
} = require('../certExpiryNotifications');

describe('isCertExpiryNotificationsEnabled (Requirement 5.2)', () => {
  test.prop(
    [
      fc.oneof(
        fc.string(),
        fc.constantFrom('true', 'false', '', 'TRUE', 'True', ' true ', 'true ', '1', '0', 'yes')
      )
    ],
    { numRuns: 200 }
  )('is true iff CERT_EXPIRY_NOTIFICATIONS_ENABLED === "true"', (value) => {
    expect(isCertExpiryNotificationsEnabled({ CERT_EXPIRY_NOTIFICATIONS_ENABLED: value })).toBe(
      value === 'true'
    );
  });

  test.prop(
    [
      fc.dictionary(
        fc.string().filter((key) => key !== 'CERT_EXPIRY_NOTIFICATIONS_ENABLED'),
        fc.string()
      )
    ],
    { numRuns: 200 }
  )('is false whenever CERT_EXPIRY_NOTIFICATIONS_ENABLED is unset', (env) => {
    expect(isCertExpiryNotificationsEnabled(env)).toBe(false);
  });

  it('is true for the exact string "true"', () => {
    expect(isCertExpiryNotificationsEnabled({ CERT_EXPIRY_NOTIFICATIONS_ENABLED: 'true' })).toBe(
      true
    );
  });

  it.each([['false'], [''], ['TRUE'], ['True'], [' true '], ['true '], ['1'], ['yes'], ['0']])(
    'is false for the non-exact value %p',
    (value) => {
      expect(
        isCertExpiryNotificationsEnabled({ CERT_EXPIRY_NOTIFICATIONS_ENABLED: value })
      ).toBe(false);
    }
  );

  it('is false when unset, including alongside an unrelated set device-management variable', () => {
    expect(isCertExpiryNotificationsEnabled({})).toBe(false);
    expect(
      isCertExpiryNotificationsEnabled({ CERT_EXPIRY_NOTIFICATIONS_ENABLED: undefined })
    ).toBe(false);
    expect(isCertExpiryNotificationsEnabled({ DEVICE_MGMT_ENABLED: 'true' })).toBe(false);
  });

  it('defaults to process.env when no env argument is supplied', () => {
    const original = process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED;
    try {
      process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED = 'true';
      expect(isCertExpiryNotificationsEnabled()).toBe(true);

      process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED = 'false';
      expect(isCertExpiryNotificationsEnabled()).toBe(false);

      delete process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED;
      expect(isCertExpiryNotificationsEnabled()).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED;
      } else {
        process.env.CERT_EXPIRY_NOTIFICATIONS_ENABLED = original;
      }
    }
  });
});

describe('getCertExpiryTierDays (Requirement 9.1)', () => {
  it('defaults to 30/15/8/1 when every variable is unset', () => {
    expect(getCertExpiryTierDays({})).toEqual({ tier1: 30, tier2: 15, tier3: 8, tier4: 1 });
  });

  it('honours each variable independently', () => {
    expect(
      getCertExpiryTierDays({
        CERT_EXPIRY_TIER1_DAYS: '45',
        CERT_EXPIRY_TIER2_DAYS: '20',
        CERT_EXPIRY_TIER3_DAYS: '10',
        CERT_EXPIRY_TIER4_DAYS: '2'
      })
    ).toEqual({ tier1: 45, tier2: 20, tier3: 10, tier4: 2 });
  });

  it.each([
    ['CERT_EXPIRY_TIER1_DAYS', 'tier1', 30],
    ['CERT_EXPIRY_TIER2_DAYS', 'tier2', 15],
    ['CERT_EXPIRY_TIER3_DAYS', 'tier3', 8],
    ['CERT_EXPIRY_TIER4_DAYS', 'tier4', 1]
  ])('%s falls back to its own default for an unset/empty/non-numeric/zero value (%s -> %i)', (envKey, tierKey, defaultValue) => {
    for (const unusable of ['', 'not-a-number', '0']) {
      expect(getCertExpiryTierDays({ [envKey]: unusable })[tierKey]).toBe(defaultValue);
    }
  });

  // A negative value is non-zero, so `parseInt(...) || default` keeps the
  // negative number itself rather than falling through to `default`; the
  // outer `Math.max(1, ...)` is what actually clamps it -- to 1, not to the
  // tier's own default. This matches `getRevokeMaxCerts`'s existing,
  // documented behaviour for the exact same expression shape.
  it.each([
    ['CERT_EXPIRY_TIER1_DAYS', 'tier1'],
    ['CERT_EXPIRY_TIER2_DAYS', 'tier2'],
    ['CERT_EXPIRY_TIER3_DAYS', 'tier3'],
    ['CERT_EXPIRY_TIER4_DAYS', 'tier4']
  ])('%s clamps a negative value to 1, not to its own default', (envKey, tierKey) => {
    for (const negative of ['-1', '-30']) {
      expect(getCertExpiryTierDays({ [envKey]: negative })[tierKey]).toBe(1);
    }
  });

  // Boundary concentration: a positive value at 1 (the floor) and a large
  // value both pass through unchanged, and setting one tier does not
  // perturb the others' own defaults.
  test.prop(
    [
      fc.oneof(
        fc.constantFrom(1, 2, 8, 15, 30, 89, 90, 365),
        fc.integer({ min: 1, max: 10000 })
      )
    ],
    { numRuns: 200 }
  )('CERT_EXPIRY_TIER1_DAYS passes through any positive integer unchanged, leaving the other tiers at default', (n) => {
    const result = getCertExpiryTierDays({ CERT_EXPIRY_TIER1_DAYS: String(n) });
    expect(result.tier1).toBe(n);
    expect(result.tier2).toBe(15);
    expect(result.tier3).toBe(8);
    expect(result.tier4).toBe(1);
  });
});

describe('getCertExpiryActivityWindowDays (Requirement 9.2)', () => {
  it('defaults to 90 when unset', () => {
    expect(getCertExpiryActivityWindowDays({})).toBe(90);
    expect(getCertExpiryActivityWindowDays({ CERT_EXPIRY_ACTIVITY_WINDOW_DAYS: undefined })).toBe(
      90
    );
  });

  it.each([
    ['30', 30],
    ['90', 90],
    ['180', 180],
    ['1', 1]
  ])('honours CERT_EXPIRY_ACTIVITY_WINDOW_DAYS=%p as %i', (value, expected) => {
    expect(getCertExpiryActivityWindowDays({ CERT_EXPIRY_ACTIVITY_WINDOW_DAYS: value })).toBe(
      expected
    );
  });

  it.each([
    ['', 90],
    ['not-a-number', 90],
    ['0', 90],
    ['-1', 1],
    ['-90', 1],
    ['12abc', 12]
  ])('clamps the unusable value %p to %i', (value, expected) => {
    expect(getCertExpiryActivityWindowDays({ CERT_EXPIRY_ACTIVITY_WINDOW_DAYS: value })).toBe(
      expected
    );
  });

  it('defaults to process.env when no env argument is supplied', () => {
    const original = process.env.CERT_EXPIRY_ACTIVITY_WINDOW_DAYS;
    try {
      delete process.env.CERT_EXPIRY_ACTIVITY_WINDOW_DAYS;
      expect(getCertExpiryActivityWindowDays()).toBe(90);

      process.env.CERT_EXPIRY_ACTIVITY_WINDOW_DAYS = '45';
      expect(getCertExpiryActivityWindowDays()).toBe(45);
    } finally {
      if (original === undefined) {
        delete process.env.CERT_EXPIRY_ACTIVITY_WINDOW_DAYS;
      } else {
        process.env.CERT_EXPIRY_ACTIVITY_WINDOW_DAYS = original;
      }
    }
  });
});
