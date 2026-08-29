/**
 * Ignored-username-prefix predicate for the Authentik user sync
 * (server-side only).
 *
 * `isIgnoredAuthentikUsername` derives the list of ignored prefixes from
 * the `AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES` environment variable --
 * a comma-separated list (e.g. `etl-,svc-`) -- and reports whether a given
 * Authentik username starts with any of them.
 *
 * This exists for Authentik principals that are legitimately excluded from
 * local materialization: ETL/service accounts with no email address and no
 * `is_team_device` local row. Before this flag existed, `authentikSync.js`
 * attempted the `users` upsert for every such account on every sync cycle,
 * always hit the `users_email_required_unless_device` CHECK constraint,
 * and relied on catching that Postgres error to skip the row -- correct in
 * outcome, but it guaranteed a rejected statement (logged as an ERROR by
 * Postgres itself, regardless of the catch) every cycle, forever, for an
 * account whose shape was already known in advance. This predicate lets
 * `syncSingleUser` skip the attempt entirely for a recognized prefix,
 * logging at `debug` (an expected skip) rather than `warn` (a caught
 * failure) -- the `23514` catch in `authentikSync.js` remains in place as
 * a safety net for any emailless, non-prefixed, non-device account that
 * still reaches the upsert.
 *
 * Comparison is case-sensitive and exact-prefix (`String.prototype
 * .startsWith`) -- no normalization, no wildcard syntax. Each configured
 * prefix is trimmed of surrounding whitespace and empty entries (e.g. a
 * trailing comma, or the unset/empty-string default) are dropped, so an
 * unset or empty variable ignores nothing rather than matching every
 * username via an empty-string prefix.
 *
 * Never exposed through the Public_Config_Endpoint -- this is an
 * Authentik-sync implementation detail, not a client-facing value.
 *
 * @param {string} username the Authentik username to test.
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {boolean} true iff `username` starts with at least one configured prefix.
 */
function isIgnoredAuthentikUsername(username, env = process.env) {
  if (typeof username !== 'string') {
    return false;
  }

  const prefixes = getIgnoredUsernamePrefixes(env);
  return prefixes.some((prefix) => username.startsWith(prefix));
}

/**
 * The configured, parsed list of ignored username prefixes.
 *
 * Exported separately from `isIgnoredAuthentikUsername` so a caller that
 * wants to name WHICH prefix matched (for logging) can do so without
 * re-parsing the environment variable itself.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {string[]} trimmed, non-empty prefixes; empty array when unset.
 */
function getIgnoredUsernamePrefixes(env = process.env) {
  const raw = env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return [];
  }

  return raw
    .split(',')
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix !== '');
}

module.exports = { isIgnoredAuthentikUsername, getIgnoredUsernamePrefixes };
