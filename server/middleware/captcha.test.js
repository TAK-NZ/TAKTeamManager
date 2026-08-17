/**
 * Unit tests for `isRecaptchaDisabledForTesting` (the RECAPTCHA_DISABLED
 * testing-only bypass in server/middleware/captcha.js).
 *
 * The safety property under test: this bypass must be usable in a
 * non-production environment, but MUST be impossible to activate when
 * NODE_ENV=production, no matter what RECAPTCHA_DISABLED is set to.
 * `server/routes/requests.test.js`'s "RECAPTCHA_DISABLED testing-only
 * bypass" describe block covers the same guarantee end-to-end against the
 * mounted route; this file isolates the pure predicate itself.
 */

const { isRecaptchaDisabledForTesting } = require('./captcha');

describe('isRecaptchaDisabledForTesting', () => {
  it('is false when RECAPTCHA_DISABLED is unset, regardless of NODE_ENV', () => {
    expect(isRecaptchaDisabledForTesting({ NODE_ENV: 'test' })).toBe(false);
    expect(isRecaptchaDisabledForTesting({ NODE_ENV: 'development' })).toBe(false);
    expect(isRecaptchaDisabledForTesting({})).toBe(false);
  });

  it('is false when RECAPTCHA_DISABLED is "false" or any other non-"true" value', () => {
    expect(isRecaptchaDisabledForTesting({ NODE_ENV: 'test', RECAPTCHA_DISABLED: 'false' })).toBe(false);
    expect(isRecaptchaDisabledForTesting({ NODE_ENV: 'test', RECAPTCHA_DISABLED: '0' })).toBe(false);
    expect(isRecaptchaDisabledForTesting({ NODE_ENV: 'test', RECAPTCHA_DISABLED: '' })).toBe(false);
  });

  it('is true when RECAPTCHA_DISABLED="true" (any case) and NODE_ENV is not production', () => {
    expect(isRecaptchaDisabledForTesting({ NODE_ENV: 'test', RECAPTCHA_DISABLED: 'true' })).toBe(true);
    expect(isRecaptchaDisabledForTesting({ NODE_ENV: 'development', RECAPTCHA_DISABLED: 'TRUE' })).toBe(true);
    expect(isRecaptchaDisabledForTesting({ RECAPTCHA_DISABLED: 'True' })).toBe(true);
  });

  it('SAFETY: is always false when NODE_ENV=production, even when RECAPTCHA_DISABLED="true"', () => {
    expect(isRecaptchaDisabledForTesting({ NODE_ENV: 'production', RECAPTCHA_DISABLED: 'true' })).toBe(false);
    expect(isRecaptchaDisabledForTesting({ NODE_ENV: 'production', RECAPTCHA_DISABLED: 'TRUE' })).toBe(false);
  });
});
