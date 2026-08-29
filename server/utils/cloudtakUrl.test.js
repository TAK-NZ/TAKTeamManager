const { resolveCloudTakUrl } = require('./cloudtakUrl');

/**
 * downloads-page-os-sections task 1.3: the concrete, readable named-case
 * unit tests for `resolveCloudTakUrl` (Requirements 5.1, 5.2, 5.3).
 *
 * Division of labour with the sibling file: `./cloudtakUrl.property.test.js`
 * (Property 1) quantifies totality and the exact-passthrough/null partition
 * over generated inputs. This file is the counterpart a reader reaches for
 * to answer "what does `<this string>` resolve to, and why" without
 * decoding a generator.
 *
 * Note on `'https:///no-host'`: design.md's Testing Strategy names this as
 * a `-> null` case, reasoning that an empty authority (`https:///...`)
 * leaves `URL.hostname === ''`. On the Node version this project runs
 * (verified directly against `new URL(...)` before writing this test),
 * `new URL('https:///no-host')` instead parses `no-host` itself as the
 * hostname (there is no empty-authority special case once a path-like
 * segment follows the third slash), so `resolveCloudTakUrl` returns the
 * value unchanged rather than `null`. That is asserted below as a
 * passthrough case, matching actual runtime behaviour rather than the
 * design doc's assumption. `'https:///'` and `'https://'` are used instead
 * for the genuinely-empty-authority `-> null` case: both throw out of
 * `new URL(...)` on this Node version (no host segment at all), so they are
 * caught and resolve to `null` via the try/catch path.
 */

describe('resolveCloudTakUrl named cases (Requirements 5.1, 5.2, 5.3)', () => {
  it('returns null for unset (undefined) input', () => {
    expect(resolveCloudTakUrl(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(resolveCloudTakUrl('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(resolveCloudTakUrl('   ')).toBeNull();
  });

  it('returns the exact, unmodified input for a valid https URL', () => {
    const input = 'https://cloudtak.example.com';
    const result = resolveCloudTakUrl(input);
    expect(result).toBe(input);
  });

  it('returns the exact, unmodified input for a valid http URL with port, path and query', () => {
    const input = 'http://cloudtak.internal:8080/path?x=1';
    const result = resolveCloudTakUrl(input);
    expect(result).toBe(input);
  });

  it('returns the exact, unmodified input for an uppercase HTTPS scheme (case-insensitive match)', () => {
    const input = 'HTTPS://cloudtak.example.com';
    const result = resolveCloudTakUrl(input);
    expect(result).toBe(input);
  });

  it('returns null for a non-http(s) scheme (ftp)', () => {
    expect(resolveCloudTakUrl('ftp://cloudtak.example.com')).toBeNull();
  });

  it('returns null for a javascript: scheme', () => {
    expect(resolveCloudTakUrl('javascript:alert(1)')).toBeNull();
  });

  it('returns null for a syntactically malformed, non-URL string', () => {
    expect(resolveCloudTakUrl('not a url')).toBeNull();
  });

  it('returns the exact, unmodified input for "https:///no-host" (actual Node behaviour: parses as a real hostname, not an empty authority)', () => {
    const input = 'https:///no-host';
    const result = resolveCloudTakUrl(input);
    expect(result).toBe(input);
  });

  it('returns null for "https:///" (no host segment at all -- throws out of the URL constructor)', () => {
    expect(resolveCloudTakUrl('https:///')).toBeNull();
  });

  it('returns null for "https://" (no authority at all -- throws out of the URL constructor)', () => {
    expect(resolveCloudTakUrl('https://')).toBeNull();
  });
});
