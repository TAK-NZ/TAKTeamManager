/**
 * Property test for `isForceSsoLoginEnabled` (server/config/forceSso.js),
 * the Force_Sso_Login predicate.
 *
 * Implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, matching the convention established in
 * `./cloudtak.test.js`/`./configValidator.test.js`.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { isForceSsoLoginEnabled } = require('./forceSso');

// Feature: forced-sso-login, Property 1: Enablement flag predicate
describe('Property 1: Enablement flag predicate', () => {
  // For ANY value of FORCE_SSO_LOGIN, isForceSsoLoginEnabled is true IFF
  // the value is exactly the string 'true'. The generator mixes arbitrary
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
  )('is true iff FORCE_SSO_LOGIN === "true"', (value) => {
    expect(isForceSsoLoginEnabled({ FORCE_SSO_LOGIN: value })).toBe(value === 'true');
  });

  it('is true for the exact string "true"', () => {
    expect(isForceSsoLoginEnabled({ FORCE_SSO_LOGIN: 'true' })).toBe(true);
  });

  it('is false for common non-"true" values', () => {
    expect(isForceSsoLoginEnabled({ FORCE_SSO_LOGIN: 'false' })).toBe(false);
    expect(isForceSsoLoginEnabled({ FORCE_SSO_LOGIN: '' })).toBe(false);
    expect(isForceSsoLoginEnabled({ FORCE_SSO_LOGIN: 'TRUE' })).toBe(false);
    expect(isForceSsoLoginEnabled({ FORCE_SSO_LOGIN: ' true ' })).toBe(false);
    expect(isForceSsoLoginEnabled({ FORCE_SSO_LOGIN: '1' })).toBe(false);
  });

  it('is false when FORCE_SSO_LOGIN is undefined', () => {
    expect(isForceSsoLoginEnabled({ FORCE_SSO_LOGIN: undefined })).toBe(false);
  });

  it('is false when the variable is unset (empty env)', () => {
    expect(isForceSsoLoginEnabled({})).toBe(false);
  });
});
