/**
 * BCH/UTL service-account username rules.
 *
 * Every service account this app ever creates for a `bch_channels` row --
 * whether auto-derived from the channel's own name (the original
 * `createBchChannel` behaviour) or explicitly named by an admin via the
 * "Add Service Account" dialog -- must start with the literal `etl-`
 * prefix, per explicit product requirement. This module is the single
 * place that builds the auto-derived default AND validates an
 * admin-supplied override, so `GlobalChannelService`'s three call sites
 * (create, provision-with-default, provision-with-custom-name) can never
 * define or enforce the prefix differently from one another.
 *
 * `SERVICE_ACCOUNT_USERNAME_PREFIX` is exported (not just used internally)
 * so a caller building UI copy (e.g. a fixed, non-editable "etl-" prefix
 * shown beside a suffix input) can reference the exact same literal rather
 * than retyping it.
 */

const SERVICE_ACCOUNT_USERNAME_PREFIX = 'etl-';

/**
 * The character class allowed after the `etl-` prefix: lowercase letters,
 * digits, and `-`, matching the shape `buildDefaultServiceAccountUsername`
 * itself produces (a channel name lowercased with whitespace runs
 * collapsed to a single `-`). Deliberately does NOT allow uppercase,
 * spaces, `.`, `_`, or any other punctuation: Authentik usernames accept a
 * wider set than this, but this app's OWN convention -- visible in every
 * auto-derived username -- is lowercase-and-hyphens only, and a
 * custom-named service account should read identically to an
 * auto-generated one rather than introducing a visibly different style
 * for no functional reason.
 */
const SERVICE_ACCOUNT_USERNAME_SUFFIX_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// `bch_channels.service_account_username` is `character varying(255)` (see
// the baseline schema); capped comfortably under that so the prefix plus a
// reasonable channel-derived suffix never approaches the column limit.
const MAX_SERVICE_ACCOUNT_USERNAME_LENGTH = 100;

/**
 * Slugifies a channel's display name into the suffix shape this app's
 * service account usernames use: lowercase, every RUN of one-or-more
 * non-`[a-z0-9]` characters collapsed to a SINGLE `-`, and any leading or
 * trailing `-` stripped.
 *
 * Bugfix: the previous implementation only replaced whitespace RUNS
 * (`/\s+/g`) with `-`, leaving a channel name's own internal `-` (this
 * app's folder-separator convention -- e.g. `"Alerts - MetService"`,
 * `"Community - Amateur Radio APRS"`) untouched. A name like that has a
 * literal ` - ` (space, hyphen, space): the space before the hyphen
 * became its own `-`, the literal hyphen stayed as-is, and the space
 * after became a third `-`, producing `alerts---metservice` --
 * confirmed live for exactly those two channels, both of which silently
 * failed to provision in Authentik because "Unknown operation type" was
 * a SEPARATE, coincidental deployment issue (a stale Sync_Worker
 * process) masking this naming bug at the same time. Collapsing every
 * non-alphanumeric RUN (not just whitespace) to one `-` fixes both the
 * doubled/tripled-hyphen artifact and any other punctuation a channel
 * name might contain, and stripping a leading/trailing `-` prevents a
 * name that starts or ends with punctuation from producing an
 * `isValidServiceAccountUsername`-rejecting leading/trailing hyphen.
 *
 * @param {string} channelName
 * @returns {string} the suffix alone, WITHOUT the `etl-` prefix -- e.g.
 *   `"Alerts - MetService"` -> `"alerts-metservice"`,
 *   `"InReach Devices"` -> `"inreach-devices"`.
 */
function slugifyChannelName(channelName) {
  return channelName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/**
 * Builds the DEFAULT (auto-derived) service account username for a BCH/UTL
 * channel, from its display name -- e.g. `"Data Packages"` ->
 * `"etl-data-packages"`. This is the exact behaviour `createBchChannel`
 * always had (now fixed via `slugifyChannelName`, see its own doc
 * comment); extracted here (rather than left inline) so
 * `provisionServiceAccount`'s own default-name path can reuse it verbatim
 * instead of re-deriving the same slug independently.
 *
 * @param {string} channelName
 * @returns {string}
 */
function buildDefaultServiceAccountUsername(channelName) {
  return `${SERVICE_ACCOUNT_USERNAME_PREFIX}${slugifyChannelName(channelName)}`;
}

/**
 * Validates a service account username -- whether auto-derived or
 * admin-supplied via the "Add Service Account" dialog's name field --
 * against this app's own convention: starts with the literal `etl-`
 * prefix, is non-empty after that prefix, contains only lowercase
 * letters/digits/`-` in the suffix (no leading/trailing/doubled `-`), and
 * stays within `MAX_SERVICE_ACCOUNT_USERNAME_LENGTH`.
 *
 * Deliberately STRICT (no null/undefined/empty passthrough, unlike
 * `callsignValidation.js`'s prefix/suffix validators): a service account
 * username is never optional at the point this is called -- every caller
 * already has a concrete string in hand (either freshly built by
 * `buildDefaultServiceAccountUsername` or typed by an admin) -- so there is
 * no "absent field" case to treat as trivially valid.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidServiceAccountUsername(value) {
  if (typeof value !== 'string') {
    return false;
  }
  if (!value.startsWith(SERVICE_ACCOUNT_USERNAME_PREFIX)) {
    return false;
  }
  if (value.length > MAX_SERVICE_ACCOUNT_USERNAME_LENGTH) {
    return false;
  }
  const suffix = value.slice(SERVICE_ACCOUNT_USERNAME_PREFIX.length);
  return SERVICE_ACCOUNT_USERNAME_SUFFIX_PATTERN.test(suffix);
}

module.exports = {
  SERVICE_ACCOUNT_USERNAME_PREFIX,
  MAX_SERVICE_ACCOUNT_USERNAME_LENGTH,
  slugifyChannelName,
  buildDefaultServiceAccountUsername,
  isValidServiceAccountUsername
};
