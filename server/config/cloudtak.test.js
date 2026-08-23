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

const { isCloudTakEnabled } = require('./cloudtak');

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
