/**
 * Property test for `isCloudTakEnabled` (server/config/cloudtak.js), the
 * server-side CloudTAK_Enabled predicate.
 *
 * Implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, matching the convention established in
 * `./configValidator.test.js` and `./permissions.registry.test.js`.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { isCloudTakEnabled, getCloudTakAgencyGroupPrefix } = require('./cloudtak');

// Feature: cloudtak-agency-groups, Property 1: Enablement flag predicate
// Validates: Requirements 1.1, 1.2
describe('Property 1: Enablement flag predicate', () => {
  // For ANY value of CLOUDTAK_ENABLED, isCloudTakEnabled is true IFF the
  // value is exactly the string 'true'. The generator mixes arbitrary
  // strings with explicit near-miss values ('TRUE', ' true ', '', 'false')
  // so the frontier around the single accepted string is exercised
  // directly, not just left to random chance.
  test.prop(
    [
      fc.oneof(
        fc.string(),
        fc.constantFrom('true', 'false', '', 'TRUE', 'True', ' true ', 'true ', '1', '0', 'yes')
      )
    ],
    { numRuns: 200 }
  )('is true iff CLOUDTAK_ENABLED === "true"', (value) => {
    expect(isCloudTakEnabled({ CLOUDTAK_ENABLED: value })).toBe(value === 'true');
  });

  it('is true for the exact string "true"', () => {
    expect(isCloudTakEnabled({ CLOUDTAK_ENABLED: 'true' })).toBe(true);
  });

  it('is false for common non-"true" values', () => {
    expect(isCloudTakEnabled({ CLOUDTAK_ENABLED: 'false' })).toBe(false);
    expect(isCloudTakEnabled({ CLOUDTAK_ENABLED: '' })).toBe(false);
    expect(isCloudTakEnabled({ CLOUDTAK_ENABLED: 'TRUE' })).toBe(false);
    expect(isCloudTakEnabled({ CLOUDTAK_ENABLED: ' true ' })).toBe(false);
    expect(isCloudTakEnabled({ CLOUDTAK_ENABLED: '1' })).toBe(false);
  });

  it('is false when CLOUDTAK_ENABLED is undefined', () => {
    expect(isCloudTakEnabled({ CLOUDTAK_ENABLED: undefined })).toBe(false);
  });

  it('is false when the variable is unset (empty env)', () => {
    expect(isCloudTakEnabled({})).toBe(false);
  });
});

// Feature: cloudtak-agency-groups, Property 2: Agency group prefix defaulting
// Validates: env-configurable CLOUDTAK_AGENCY_GROUP_PREFIX (server-config-only extension)
describe('Property 2: Agency group prefix defaulting', () => {
  // For ANY non-empty string, a set CLOUDTAK_AGENCY_GROUP_PREFIX is returned
  // verbatim; for ANY "empty" value (unset, undefined, or the empty string),
  // the "CloudTAKAgency" default is returned instead.
  test.prop(
    [
      fc.oneof(
        fc.string({ minLength: 1 }).filter((s) => s.length > 0),
        fc.constantFrom('', undefined)
      )
    ],
    { numRuns: 200 }
  )('returns the configured prefix verbatim when non-empty, otherwise "CloudTAKAgency"', (value) => {
    const result = getCloudTakAgencyGroupPrefix({ CLOUDTAK_AGENCY_GROUP_PREFIX: value });
    if (value) {
      expect(result).toBe(value);
    } else {
      expect(result).toBe('CloudTAKAgency');
    }
  });

  it('defaults to "CloudTAKAgency" when unset (empty env)', () => {
    expect(getCloudTakAgencyGroupPrefix({})).toBe('CloudTAKAgency');
  });

  it('returns a custom configured prefix verbatim', () => {
    expect(getCloudTakAgencyGroupPrefix({ CLOUDTAK_AGENCY_GROUP_PREFIX: 'CustomPrefix' })).toBe('CustomPrefix');
  });
});
