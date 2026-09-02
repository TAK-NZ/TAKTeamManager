/**
 * BCH/UTL service-account username rules -- the client-side mirror of
 * `server/utils/serviceAccountUsername.js`. Every service account this app
 * creates must start with the literal `etl-` prefix, per explicit product
 * requirement; this module is what `AddServiceAccountDialog.jsx` uses to
 * validate the admin-typed suffix live (enabling/disabling its submit
 * button) BEFORE the request round-trips to the server, which re-validates
 * the same rule via its own copy and is the actual source of truth.
 *
 * Kept in agreement with the server module by two dedicated tests: this
 * file's own unit tests assert the exact same accept/reject cases the
 * server module's tests assert, and the server is what actually enforces
 * the rule -- a client-side pass here is a UX convenience only, never
 * itself a security boundary.
 */

export const SERVICE_ACCOUNT_USERNAME_PREFIX = 'etl-'

const SERVICE_ACCOUNT_USERNAME_SUFFIX_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const MAX_SERVICE_ACCOUNT_USERNAME_SUFFIX_LENGTH = 100 - SERVICE_ACCOUNT_USERNAME_PREFIX.length

/**
 * Validates just the SUFFIX an admin types into the "Add Service Account"
 * dialog's input -- the `etl-` prefix itself is fixed, non-editable UI
 * (rendered beside the input, never part of its value), so there is
 * nothing to validate about the prefix on this side; only the suffix's
 * character class and non-emptiness need checking.
 *
 * @param {string} suffix
 * @returns {boolean}
 */
export function isValidServiceAccountUsernameSuffix(suffix) {
  if (typeof suffix !== 'string' || suffix.length === 0) {
    return false
  }
  if (suffix.length > MAX_SERVICE_ACCOUNT_USERNAME_SUFFIX_LENGTH) {
    return false
  }
  return SERVICE_ACCOUNT_USERNAME_SUFFIX_PATTERN.test(suffix)
}

/**
 * Builds the full username (prefix + suffix) to send to the server, once
 * the suffix has already passed `isValidServiceAccountUsernameSuffix`.
 *
 * @param {string} suffix
 * @returns {string}
 */
export function buildServiceAccountUsername(suffix) {
  return `${SERVICE_ACCOUNT_USERNAME_PREFIX}${suffix}`
}

/**
 * Slugifies a channel's display name into a RECOMMENDED suffix for the
 * "Add Service Account" dialog's input -- e.g. "InReach Devices" ->
 * "inreach-devices" -- mirroring
 * `server/utils/serviceAccountUsername.js`'s `slugifyChannelName` exactly
 * (lowercase, every run of one-or-more non-`[a-z0-9]` characters
 * collapsed to a SINGLE `-`, any leading/trailing `-` stripped). This is
 * a PRE-FILL/placeholder convenience only, editable by the admin before
 * submit -- the server independently re-derives and validates whatever
 * is actually submitted.
 *
 * Bugfix: collapsing every non-alphanumeric run to one `-` (not just
 * whitespace) is what keeps a channel name containing this app's own
 * folder-separator convention (a literal ` - `, e.g. "Alerts -
 * MetService") from recommending a doubled/tripled-hyphen suffix like
 * "alerts---metservice".
 *
 * @param {string} channelName
 * @returns {string} the recommended suffix, WITHOUT the `etl-` prefix.
 */
export function slugifyChannelName(channelName) {
  return channelName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}
