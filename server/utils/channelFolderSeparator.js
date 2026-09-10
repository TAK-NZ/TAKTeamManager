/**
 * Resolves the Channel_Folder_Separator from the environment, tolerating a
 * single matched pair of surrounding quotes.
 *
 * Pure, framework-free logic with an interesting boundary, so it lives here in
 * `server/utils/` (no DB, no Express) where a property test can reach it
 * directly — the same placement rule the other separator/identifier utils
 * follow.
 *
 * WHY THIS EXISTS. The separator is joined into every channel/group display
 * name on the WRITE side (Team/Channel/GlobalChannel creation, the sync
 * worker) and split back out on the READ side (the `/dashboard` folder tree,
 * `channels.js`'s description lookup, `SiteConfig.getPublicConfig`). All of
 * them read the SAME `CHANNEL_FOLDER_SEPARATOR` env var, so they normally
 * agree. But in production the value arrives via an ECS `EnvironmentFile`
 * loaded from S3, and — unlike a shell sourcing a `.env` — ECS does NOT strip
 * surrounding quotes from a `KEY="value"` line. A config file written
 * `CHANNEL_FOLDER_SEPARATOR=" - "` therefore delivered the LITERAL 5-character
 * string `" - "` (quote-space-dash-space-quote) into `process.env`. Channel
 * names already stored with a clean ` - ` then no longer split on that quoted
 * value, so the Dashboard collapsed the whole hierarchy into one flat list and
 * dropped its expand/collapse controls. This helper makes every read site
 * quote-tolerant so that class of config typo can never silently break the
 * folder hierarchy again.
 *
 * THE RULE.
 *   - Unset / empty / whitespace-only after quote-stripping -> the default
 *     `' - '` (space-dash-space). An operator who wants a bare space or an
 *     all-whitespace separator is almost certainly a misconfiguration, and a
 *     collapsing-to-default is the safe, legible outcome.
 *   - If the value both STARTS and ENDS with the same quote character (`"` or
 *     `'`) and is at least two characters long, exactly ONE matched pair is
 *     removed: `" - "` -> ` - `, `'x'` -> `x`. Note the inner spaces are
 *     PRESERVED — the separator's surrounding whitespace is meaningful and is
 *     deliberately NOT trimmed.
 *   - An UNMATCHED quote (`" - `), or quotes only inside the value
 *     (`a"b`), is left exactly as-is: only a fully-matched surrounding pair is
 *     a "the config file quoted the value" signal; anything else is taken
 *     literally, so a separator that genuinely contains a quote still works.
 *   - Only ONE pair is stripped, so a deliberately double-quoted value like
 *     `""x""` becomes `"x"`, never `x`.
 *
 * NOT `.trim()`ed and NEVER throwing: any input yields a usable non-empty
 * separator string.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment source; injectable for testing.
 * @returns {string} the resolved separator (never empty).
 */
const DEFAULT_CHANNEL_FOLDER_SEPARATOR = ' - ';

function resolveChannelFolderSeparator(env = process.env) {
  const raw = env.CHANNEL_FOLDER_SEPARATOR;

  if (typeof raw !== 'string' || raw === '') {
    return DEFAULT_CHANNEL_FOLDER_SEPARATOR;
  }

  const unquoted = stripOneMatchedQuotePair(raw);

  // An all-whitespace value (after quote-stripping) is treated as a
  // misconfiguration and falls back to the default. A separator that is a
  // single space collapses names in confusing ways; the default is the safe
  // legible choice. A value with any non-whitespace content is respected.
  if (unquoted.trim() === '') {
    return DEFAULT_CHANNEL_FOLDER_SEPARATOR;
  }

  return unquoted;
}

/**
 * Removes exactly one matched pair of surrounding quotes (`"` or `'`) from a
 * string, preserving everything between them (including inner whitespace).
 * Returns the input unchanged when there is no fully-matched surrounding pair.
 *
 * @param {string} value
 * @returns {string}
 */
function stripOneMatchedQuotePair(value) {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

module.exports = {
  DEFAULT_CHANNEL_FOLDER_SEPARATOR,
  resolveChannelFolderSeparator,
  stripOneMatchedQuotePair
};
