/**
 * Forced-SSO presentation flag.
 *
 * `isForceSsoLoginEnabled` derives the Force_Sso_Login boolean from the
 * `FORCE_SSO_LOGIN` environment variable. It is true ONLY when the value
 * is exactly the string `'true'`; an unset, empty, or any-other value
 * (including `'TRUE'`, `' true '`, `'1'`, etc.) yields false. This matches
 * the existing boolean-env convention in this codebase (e.g.
 * `CLOUDTAK_ENABLED === 'true'` in server/config/cloudtak.js).
 *
 * Unlike `DEVICE_MGMT_ENABLED`/`DEVICE_MGMT_REVOKE_ENABLED`, this flag arms
 * no capability and is not a security boundary -- it only decides whether
 * the Login page immediately starts the OAuth2 redirect itself
 * (`authAPI.login()`) instead of waiting for the user to click "Sign in".
 * The unauthenticated visitor still goes through the exact same
 * `GET /api/auth/login` -> Authentik -> `GET /api/auth/callback` flow
 * either way; this only removes one manual click. That makes it a
 * Presentation_Config value, safe to surface through
 * `GET /api/config/public` (see `SiteConfig.getPublicConfig`), unlike the
 * two device-management flags above.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {boolean} true iff `env.FORCE_SSO_LOGIN === 'true'`.
 */
function isForceSsoLoginEnabled(env = process.env) {
  return env.FORCE_SSO_LOGIN === 'true';
}

module.exports = { isForceSsoLoginEnabled };
