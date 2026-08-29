/**
 * Property test for `isIgnoredAuthentikUsername`/`getIgnoredUsernamePrefixes`
 * (server/config/authentikSyncIgnore.js), the Authentik-sync
 * ignored-username-prefix predicate.
 *
 * Implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration, matching the convention established in
 * `./cloudtak.test.js` and `./configValidator.test.js`.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const { isIgnoredAuthentikUsername, getIgnoredUsernamePrefixes } = require('./authentikSyncIgnore');

// Feature: authentik-sync-ignored-prefixes, Property 1: prefix-match predicate
// Validates: username-prefix skip for AuthentikSyncService.syncSingleUser
describe('Property 1: isIgnoredAuthentikUsername matches iff username starts with a configured prefix', () => {
  // A comma-separated prefix list, each entry drawn from a small alphabet
  // and never containing a comma itself, so parsing is unambiguous.
  const prefixArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/);
  const prefixListArb = fc.array(prefixArb, { minLength: 0, maxLength: 5 });

  test.prop(
    [
      prefixListArb,
      fc.string({ minLength: 0, maxLength: 20 })
    ],
    { numRuns: 200 }
  )('agrees with an independent .some(prefix => username.startsWith(prefix)) check', (prefixes, username) => {
    const env = { AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES: prefixes.join(',') };
    const expected = prefixes.length > 0 && prefixes.some((prefix) => username.startsWith(prefix));

    expect(isIgnoredAuthentikUsername(username, env)).toBe(expected);
  });

  // Boundary concentration: the exact prefix itself, the prefix with one
  // extra trailing character, a string that is a STRICT PREFIX of the
  // configured prefix (must NOT match), and the empty string.
  test.prop([prefixArb], { numRuns: 100 })(
    'matches the exact prefix, and the prefix plus a trailing suffix, but not a strict prefix of it',
    (prefix) => {
      const env = { AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES: prefix };

      expect(isIgnoredAuthentikUsername(prefix, env)).toBe(true);
      expect(isIgnoredAuthentikUsername(`${prefix}-suffix`, env)).toBe(true);

      if (prefix.length > 1) {
        const strictPrefix = prefix.slice(0, -1);
        expect(isIgnoredAuthentikUsername(strictPrefix, env)).toBe(false);
      }
    }
  );

  it('is false for a non-string username, for any prefix configuration', () => {
    const env = { AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES: 'etl-,svc-' };
    for (const value of [null, undefined, 42, {}, [], true, Symbol('x')]) {
      expect(isIgnoredAuthentikUsername(value, env)).toBe(false);
    }
  });

  it('is false for every username when the variable is unset', () => {
    expect(isIgnoredAuthentikUsername('etl-earthquakes', {})).toBe(false);
    expect(isIgnoredAuthentikUsername('', {})).toBe(false);
  });

  it('is false for every username when the variable is an empty string', () => {
    const env = { AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES: '' };
    expect(isIgnoredAuthentikUsername('etl-earthquakes', env)).toBe(false);
  });

  it('does not match every username via an empty-string prefix from a trailing/leading comma', () => {
    // 'etl-,' and ',etl-' both contain an empty entry after split(','); the
    // empty entry must be dropped, or "" would match every username since
    // `''.startsWith('')` is always true.
    const env = { AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES: 'etl-,' };
    expect(getIgnoredUsernamePrefixes(env)).toEqual(['etl-']);
    expect(isIgnoredAuthentikUsername('some-unrelated-user', env)).toBe(false);
  });

  it('trims surrounding whitespace around each configured prefix', () => {
    const env = { AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES: ' etl- , svc- ' };
    expect(getIgnoredUsernamePrefixes(env)).toEqual(['etl-', 'svc-']);
    expect(isIgnoredAuthentikUsername('etl-earthquakes', env)).toBe(true);
    expect(isIgnoredAuthentikUsername('svc-backup', env)).toBe(true);
  });

  it('matches the real reported cases: etl-adsbx, etl-earthquakes, etl-aisstream, etl-fenz-test', () => {
    const env = { AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES: 'etl-' };
    for (const username of ['etl-adsbx', 'etl-earthquakes', 'etl-aisstream', 'etl-fenz-test']) {
      expect(isIgnoredAuthentikUsername(username, env)).toBe(true);
    }
    expect(isIgnoredAuthentikUsername('ada.lovelace', env)).toBe(false);
  });

  it('is case-sensitive', () => {
    const env = { AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES: 'etl-' };
    expect(isIgnoredAuthentikUsername('ETL-adsbx', env)).toBe(false);
  });

  it('defaults to process.env when no env argument is supplied', () => {
    const original = process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    try {
      process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'etl-';
      expect(isIgnoredAuthentikUsername('etl-adsbx')).toBe(true);
      expect(getIgnoredUsernamePrefixes()).toEqual(['etl-']);
    } finally {
      if (original === undefined) {
        delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
      } else {
        process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = original;
      }
    }
  });
});
