/**
 * Tests for `isDeviceMgmtEnabled` (server/config/deviceMgmt.js), the
 * server-side Device_Mgmt_Enabled predicate.
 *
 * Implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, mirroring the CloudTAK analog in
 * `server/config/cloudtak.test.js`.
 *
 * Property 1: Enablement flag predicate
 * **Validates: Requirements 1.1, 1.2**
 *
 * The canonical tagged Property 1 test lives in
 * `./deviceMgmt.property.test.js` (task 16.1); this file covers the same
 * predicate as the unit/property test for task 1.2 and deliberately does
 * not repeat that file's property tag.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { isDeviceMgmtEnabled } = require('../deviceMgmt');

describe('isDeviceMgmtEnabled', () => {
  // For ANY value of DEVICE_MGMT_ENABLED, isDeviceMgmtEnabled is true IFF
  // the value is exactly the string 'true'. The generator mixes arbitrary
  // strings with explicit near-miss values ('TRUE', ' true ', '', 'false')
  // so the frontier around the single accepted string is exercised
  // directly rather than left to random chance.
  test.prop(
    [
      fc.oneof(
        fc.string(),
        fc.constantFrom('true', 'false', '', 'TRUE', 'True', ' true ', 'true ', '1', '0', 'yes')
      )
    ],
    { numRuns: 200 }
  )('is true iff DEVICE_MGMT_ENABLED === "true" (Requirement 1.1)', (value) => {
    expect(isDeviceMgmtEnabled({ DEVICE_MGMT_ENABLED: value })).toBe(value === 'true');
  });

  // Requirement 1.2: an unset variable yields false. Generated env objects
  // carry unrelated keys only, so no accidental DEVICE_MGMT_ENABLED value
  // can make this pass for the wrong reason.
  test.prop(
    [fc.dictionary(fc.string().filter((key) => key !== 'DEVICE_MGMT_ENABLED'), fc.string())],
    { numRuns: 200 }
  )('is false whenever DEVICE_MGMT_ENABLED is unset (Requirement 1.2)', (env) => {
    expect(isDeviceMgmtEnabled(env)).toBe(false);
  });

  it('is true for the exact string "true"', () => {
    expect(isDeviceMgmtEnabled({ DEVICE_MGMT_ENABLED: 'true' })).toBe(true);
  });

  it('is false for common non-"true" values', () => {
    expect(isDeviceMgmtEnabled({ DEVICE_MGMT_ENABLED: 'false' })).toBe(false);
    expect(isDeviceMgmtEnabled({ DEVICE_MGMT_ENABLED: '' })).toBe(false);
    expect(isDeviceMgmtEnabled({ DEVICE_MGMT_ENABLED: 'TRUE' })).toBe(false);
    expect(isDeviceMgmtEnabled({ DEVICE_MGMT_ENABLED: ' true ' })).toBe(false);
    expect(isDeviceMgmtEnabled({ DEVICE_MGMT_ENABLED: '1' })).toBe(false);
  });

  it('is false when DEVICE_MGMT_ENABLED is undefined', () => {
    expect(isDeviceMgmtEnabled({ DEVICE_MGMT_ENABLED: undefined })).toBe(false);
  });

  it('is false when the variable is unset (empty env)', () => {
    expect(isDeviceMgmtEnabled({})).toBe(false);
  });

  it('defaults to process.env when no env argument is supplied', () => {
    const original = process.env.DEVICE_MGMT_ENABLED;
    try {
      process.env.DEVICE_MGMT_ENABLED = 'true';
      expect(isDeviceMgmtEnabled()).toBe(true);

      process.env.DEVICE_MGMT_ENABLED = 'false';
      expect(isDeviceMgmtEnabled()).toBe(false);

      delete process.env.DEVICE_MGMT_ENABLED;
      expect(isDeviceMgmtEnabled()).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.DEVICE_MGMT_ENABLED;
      } else {
        process.env.DEVICE_MGMT_ENABLED = original;
      }
    }
  });
});

/**
 * Feature device-management, Requirements 12.9/12.13 (task 24.4): the
 * Revoke_Enabled arming flag and the Revoke_Blast_Radius_Cap.
 *
 * `isDeviceMgmtRevokeEnabled` follows the same exact-`'true'` boolean-env
 * convention as `isDeviceMgmtEnabled` above, and is an INDEPENDENT variable:
 * the whole point of the second flag is that turning device management on in
 * order to LOOK at a device list must not also arm certificate revocation, so
 * the cross-product of the two variables is asserted directly rather than
 * inferred from each predicate in isolation.
 */

const { isDeviceMgmtRevokeEnabled, getRevokeMaxCerts } = require('../deviceMgmt');

describe('isDeviceMgmtRevokeEnabled (Requirement 12.9)', () => {
  it('is true for the exact string "true"', () => {
    expect(isDeviceMgmtRevokeEnabled({ DEVICE_MGMT_REVOKE_ENABLED: 'true' })).toBe(true);
  });

  it.each([
    ['false'],
    [''],
    ['TRUE'],
    ['True'],
    [' true '],
    ['true '],
    ['1'],
    ['yes'],
    ['0']
  ])('is false for the non-exact value %p', (value) => {
    expect(isDeviceMgmtRevokeEnabled({ DEVICE_MGMT_REVOKE_ENABLED: value })).toBe(false);
  });

  it('defaults to false when DEVICE_MGMT_REVOKE_ENABLED is unset', () => {
    expect(isDeviceMgmtRevokeEnabled({})).toBe(false);
    expect(isDeviceMgmtRevokeEnabled({ DEVICE_MGMT_REVOKE_ENABLED: undefined })).toBe(false);
    // Unset alongside an unrelated, set device-management variable: still false.
    expect(isDeviceMgmtRevokeEnabled({ DEVICE_MGMT_ENABLED: 'true' })).toBe(false);
  });

  // Requirement 12.9: the two flags are independent. Each cell of the
  // cross-product is asserted for BOTH predicates, so neither
  // "DEVICE_MGMT_ENABLED implies armed" nor "revocation arms reading" can pass.
  it.each([
    ['both true', 'true', 'true', true, true],
    ['only DEVICE_MGMT_ENABLED true', 'true', undefined, true, false],
    ['only DEVICE_MGMT_REVOKE_ENABLED true', undefined, 'true', false, true],
    ['both unset', undefined, undefined, false, false],
    ['DEVICE_MGMT_ENABLED true, revoke explicitly false', 'true', 'false', true, false],
    ['DEVICE_MGMT_ENABLED false, revoke true', 'false', 'true', false, true]
  ])(
    'is derived independently of DEVICE_MGMT_ENABLED (%s)',
    (_label, enabled, revokeEnabled, expectedEnabled, expectedRevoke) => {
      const env = {};
      if (enabled !== undefined) env.DEVICE_MGMT_ENABLED = enabled;
      if (revokeEnabled !== undefined) env.DEVICE_MGMT_REVOKE_ENABLED = revokeEnabled;

      expect(isDeviceMgmtEnabled(env)).toBe(expectedEnabled);
      expect(isDeviceMgmtRevokeEnabled(env)).toBe(expectedRevoke);
    }
  );

  it('defaults to process.env when no env argument is supplied', () => {
    const original = process.env.DEVICE_MGMT_REVOKE_ENABLED;
    try {
      process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
      expect(isDeviceMgmtRevokeEnabled()).toBe(true);

      process.env.DEVICE_MGMT_REVOKE_ENABLED = 'false';
      expect(isDeviceMgmtRevokeEnabled()).toBe(false);

      delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
      expect(isDeviceMgmtRevokeEnabled()).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
      } else {
        process.env.DEVICE_MGMT_REVOKE_ENABLED = original;
      }
    }
  });
});

describe('getRevokeMaxCerts (Requirement 12.13)', () => {
  it('defaults to 250 when DEVICE_MGMT_REVOKE_MAX_CERTS is unset', () => {
    expect(getRevokeMaxCerts({})).toBe(250);
    expect(getRevokeMaxCerts({ DEVICE_MGMT_REVOKE_MAX_CERTS: undefined })).toBe(250);
  });

  // Requirement 12.13: the documented default must exceed the largest real
  // per-Device certificate count observed live (60 on `ckadmin (ETL)`), so a
  // re-enrollment-heavy Device is not blocked by the rail.
  it('defaults above the largest observed real per-Device certificate count (60)', () => {
    expect(getRevokeMaxCerts({})).toBeGreaterThan(60);
  });

  it.each([
    ['1', 1],
    ['5', 5],
    ['60', 60],
    ['1000', 1000],
    ['250', 250]
  ])('honours DEVICE_MGMT_REVOKE_MAX_CERTS=%p as %i', (value, expected) => {
    expect(getRevokeMaxCerts({ DEVICE_MGMT_REVOKE_MAX_CERTS: value })).toBe(expected);
  });

  // A cap of 0 or a negative one would abort every revoke, and a non-numeric
  // value has no defensible cap at all, so both clamp back to a usable
  // positive value rather than silently disarming the whole path.
  it.each([
    ['', 250],
    ['not-a-number', 250],
    ['0', 250],
    ['-1', 1],
    ['-250', 1],
    ['12abc', 12]
  ])('clamps the unusable value %p to %i', (value, expected) => {
    expect(getRevokeMaxCerts({ DEVICE_MGMT_REVOKE_MAX_CERTS: value })).toBe(expected);
  });

  it('defaults to process.env when no env argument is supplied', () => {
    const original = process.env.DEVICE_MGMT_REVOKE_MAX_CERTS;
    try {
      delete process.env.DEVICE_MGMT_REVOKE_MAX_CERTS;
      expect(getRevokeMaxCerts()).toBe(250);

      process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = '7';
      expect(getRevokeMaxCerts()).toBe(7);
    } finally {
      if (original === undefined) {
        delete process.env.DEVICE_MGMT_REVOKE_MAX_CERTS;
      } else {
        process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = original;
      }
    }
  });
});
