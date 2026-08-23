/**
 * CloudTAK integration enablement flag (server-side only).
 *
 * `isCloudTakEnabled` derives the CloudTAK_Enabled boolean from the
 * `CLOUDTAK_ENABLED` environment variable. It is true ONLY when the value
 * is exactly the string `'true'`; an unset, empty, or any-other value
 * (including `'TRUE'`, `' true '`, `'1'`, etc.) yields false. This matches
 * the existing boolean-env convention in this codebase (e.g.
 * `RECAPTCHA_DISABLED === 'true'` in server/middleware/captcha.js).
 *
 * This flag is read on the SERVER ONLY. It is deliberately NOT surfaced
 * through the Public_Config_Endpoint (`GET /api/config/public`) and must
 * never be exposed to the client (Requirement 1.3).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {boolean} true iff `env.CLOUDTAK_ENABLED === 'true'`.
 */
function isCloudTakEnabled(env = process.env) {
  return env.CLOUDTAK_ENABLED === 'true';
}

module.exports = { isCloudTakEnabled };
