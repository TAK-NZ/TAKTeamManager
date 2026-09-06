/**
 * Tests for `server/config/offlineMaps.js` — the offline-maps feature's
 * environment-derived config (enablement flag, bucket, region, presign TTL).
 *
 * Uses `fast-check` via `@fast-check/jest`'s `test.prop`, matching
 * `./cloudtak.test.js`.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const {
  isOfflineMapsEnabled,
  getOfflineMapsBucket,
  getOfflineMapsRegion,
  getOfflineMapsUrlTtlSeconds,
  DEFAULT_URL_TTL_SECONDS
} = require('./offlineMaps');

describe('isOfflineMapsEnabled', () => {
  // True IFF the value is exactly the string 'true'. The generator mixes
  // arbitrary strings with explicit near-misses so the frontier around the
  // single accepted string is exercised directly.
  test.prop(
    [
      fc.oneof(
        fc.string(),
        fc.constantFrom('true', 'false', '', 'TRUE', 'True', ' true ', 'true ', '1', '0', 'yes')
      )
    ],
    { numRuns: 200 }
  )('is true iff OFFLINE_MAPS_ENABLED === "true"', (value) => {
    expect(isOfflineMapsEnabled({ OFFLINE_MAPS_ENABLED: value })).toBe(value === 'true');
  });

  it('is true for the exact string "true"', () => {
    expect(isOfflineMapsEnabled({ OFFLINE_MAPS_ENABLED: 'true' })).toBe(true);
  });

  it('is false for common non-"true" values and when unset', () => {
    expect(isOfflineMapsEnabled({ OFFLINE_MAPS_ENABLED: 'false' })).toBe(false);
    expect(isOfflineMapsEnabled({ OFFLINE_MAPS_ENABLED: 'TRUE' })).toBe(false);
    expect(isOfflineMapsEnabled({ OFFLINE_MAPS_ENABLED: ' true ' })).toBe(false);
    expect(isOfflineMapsEnabled({ OFFLINE_MAPS_ENABLED: '1' })).toBe(false);
    expect(isOfflineMapsEnabled({})).toBe(false);
  });
});

describe('getOfflineMapsBucket', () => {
  it('returns the configured bucket verbatim, trimmed', () => {
    expect(getOfflineMapsBucket({ OFFLINE_MAPS_S3_BUCKET: 'my-bucket' })).toBe('my-bucket');
    expect(getOfflineMapsBucket({ OFFLINE_MAPS_S3_BUCKET: '  my-bucket  ' })).toBe('my-bucket');
  });

  it('returns null when unset, empty, or whitespace-only (never a guessed bucket)', () => {
    expect(getOfflineMapsBucket({})).toBeNull();
    expect(getOfflineMapsBucket({ OFFLINE_MAPS_S3_BUCKET: '' })).toBeNull();
    expect(getOfflineMapsBucket({ OFFLINE_MAPS_S3_BUCKET: '   ' })).toBeNull();
  });
});

describe('getOfflineMapsRegion', () => {
  it('prefers OFFLINE_MAPS_S3_REGION', () => {
    expect(getOfflineMapsRegion({ OFFLINE_MAPS_S3_REGION: 'eu-west-1', AWS_REGION: 'us-east-1' }))
      .toBe('eu-west-1');
  });

  it('falls back to AWS_REGION when the specific override is unset', () => {
    expect(getOfflineMapsRegion({ AWS_REGION: 'us-east-1' })).toBe('us-east-1');
  });

  it('falls back to us-west-2 when nothing is set', () => {
    expect(getOfflineMapsRegion({})).toBe('us-west-2');
    expect(getOfflineMapsRegion({ OFFLINE_MAPS_S3_REGION: '  ', AWS_REGION: '' })).toBe('us-west-2');
  });
});

describe('getOfflineMapsUrlTtlSeconds', () => {
  it('returns the configured positive integer', () => {
    expect(getOfflineMapsUrlTtlSeconds({ OFFLINE_MAPS_URL_TTL_SECONDS: '600' })).toBe(600);
  });

  it('falls back to the default for unset, empty, non-numeric, and zero', () => {
    expect(getOfflineMapsUrlTtlSeconds({})).toBe(DEFAULT_URL_TTL_SECONDS);
    expect(getOfflineMapsUrlTtlSeconds({ OFFLINE_MAPS_URL_TTL_SECONDS: '' })).toBe(DEFAULT_URL_TTL_SECONDS);
    expect(getOfflineMapsUrlTtlSeconds({ OFFLINE_MAPS_URL_TTL_SECONDS: 'abc' })).toBe(DEFAULT_URL_TTL_SECONDS);
    expect(getOfflineMapsUrlTtlSeconds({ OFFLINE_MAPS_URL_TTL_SECONDS: '0' })).toBe(DEFAULT_URL_TTL_SECONDS);
  });

  it('clamps a negative value to the 1-second floor (matching getRevokeMaxCerts convention)', () => {
    // parseInt('-5') is truthy, so it passes the `|| DEFAULT` guard and is then
    // clamped by Math.max(1, ...). This mirrors getRevokeMaxCerts exactly: a
    // negative never yields the default, it yields the floor of 1.
    expect(getOfflineMapsUrlTtlSeconds({ OFFLINE_MAPS_URL_TTL_SECONDS: '-5' })).toBe(1);
  });

  it('has a sane default of 300 seconds', () => {
    expect(DEFAULT_URL_TTL_SECONDS).toBe(300);
  });
});
