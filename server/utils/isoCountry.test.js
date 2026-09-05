const fs = require('fs');
const path = require('path');
const {
  isValidCountryCode,
  getCountry,
  normaliseCountryCode,
  COUNTRIES
} = require('./isoCountry');

/**
 * Foreign_Partner Organisation country prefix feature.
 * Validates: the write-once `country_code` column's validation/lookup
 * layer, mirroring `callsignValidation.test.js`'s convention.
 */
describe('isValidCountryCode', () => {
  it('accepts an empty string, null, and undefined (the field is optional)', () => {
    expect(isValidCountryCode('')).toBe(true);
    expect(isValidCountryCode(null)).toBe(true);
    expect(isValidCountryCode(undefined)).toBe(true);
  });

  it('accepts a known ISO 3166-1 alpha-3 code', () => {
    expect(isValidCountryCode('FJI')).toBe(true);
    expect(isValidCountryCode('AUS')).toBe(true);
    expect(isValidCountryCode('NZL')).toBe(true);
  });

  it('is case-insensitive on input', () => {
    expect(isValidCountryCode('fji')).toBe(true);
    expect(isValidCountryCode('Fji')).toBe(true);
    expect(isValidCountryCode('fJi')).toBe(true);
  });

  it('rejects an unknown 3-letter string', () => {
    expect(isValidCountryCode('ZZZ')).toBe(false);
    expect(isValidCountryCode('XXX')).toBe(false);
  });

  it('rejects a value of the wrong length', () => {
    expect(isValidCountryCode('FJ')).toBe(false);
    expect(isValidCountryCode('FJIA')).toBe(false);
  });

  it('rejects a non-string input without throwing (totality)', () => {
    expect(isValidCountryCode(5)).toBe(false);
    expect(isValidCountryCode(true)).toBe(false);
    expect(isValidCountryCode({})).toBe(false);
    expect(isValidCountryCode(['FJI'])).toBe(false);
    expect(isValidCountryCode(NaN)).toBe(false);
  });
});

describe('getCountry', () => {
  it('resolves a known alpha-3 code to its full record', () => {
    expect(getCountry('FJI')).toEqual({ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' });
    expect(getCountry('AUS')).toEqual({ name: 'Australia', alpha3: 'AUS', alpha2: 'au' });
    expect(getCountry('NZL')).toEqual({ name: 'New Zealand', alpha3: 'NZL', alpha2: 'nz' });
  });

  it('is case-insensitive on input', () => {
    expect(getCountry('fji')).toEqual({ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' });
  });

  it('returns null for an unknown code', () => {
    expect(getCountry('ZZZ')).toBeNull();
  });

  it('returns null for an empty/null/undefined/non-string value, never throwing', () => {
    expect(getCountry('')).toBeNull();
    expect(getCountry(null)).toBeNull();
    expect(getCountry(undefined)).toBeNull();
    expect(getCountry(5)).toBeNull();
    expect(getCountry({})).toBeNull();
  });
});

describe('normaliseCountryCode', () => {
  it('upper-cases a valid lower/mixed-case code', () => {
    expect(normaliseCountryCode('fji')).toBe('FJI');
    expect(normaliseCountryCode('Fji')).toBe('FJI');
  });

  it('trims surrounding whitespace before upper-casing', () => {
    expect(normaliseCountryCode('  fji  ')).toBe('FJI');
  });

  it('returns null for an empty, whitespace-only, null, or undefined value', () => {
    expect(normaliseCountryCode('')).toBeNull();
    expect(normaliseCountryCode('   ')).toBeNull();
    expect(normaliseCountryCode(null)).toBeNull();
    expect(normaliseCountryCode(undefined)).toBeNull();
  });

  it('does not validate -- an unknown code is still upper-cased, not rejected', () => {
    // normaliseCountryCode canonicalises only; callers combine it with
    // isValidCountryCode when a value must be a REAL country.
    expect(normaliseCountryCode('zzz')).toBe('ZZZ');
  });
});

/**
 * Anti-vacuity + dataset-shape guards: the vendored dataset itself must
 * actually be the ISO 3166-1 alpha-3 list this feature depends on, not an
 * empty or malformed array that would make every test above pass by
 * accident.
 */
describe('the vendored COUNTRIES dataset', () => {
  it('contains the full ISO 3166-1 list (249 countries)', () => {
    expect(COUNTRIES.length).toBe(249);
  });

  it('every row has a non-empty name, a 3-letter uppercase alpha3, and a 2-letter lowercase alpha2', () => {
    for (const country of COUNTRIES) {
      expect(typeof country.name).toBe('string');
      expect(country.name.length).toBeGreaterThan(0);
      expect(country.alpha3).toMatch(/^[A-Z]{3}$/);
      expect(country.alpha2).toMatch(/^[a-z]{2}$/);
    }
  });

  it('has no duplicate alpha3 codes', () => {
    const alpha3Codes = COUNTRIES.map((c) => c.alpha3);
    expect(new Set(alpha3Codes).size).toBe(alpha3Codes.length);
  });

  it('is sorted alphabetically by name', () => {
    const names = COUNTRIES.map((c) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('includes New Zealand, Australia, and Fiji at their real ISO codes', () => {
    const byAlpha3 = new Map(COUNTRIES.map((c) => [c.alpha3, c]));
    expect(byAlpha3.get('NZL')).toEqual({ name: 'New Zealand', alpha3: 'NZL', alpha2: 'nz' });
    expect(byAlpha3.get('AUS')).toEqual({ name: 'Australia', alpha3: 'AUS', alpha2: 'au' });
    expect(byAlpha3.get('FJI')).toEqual({ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' });
  });
});

/**
 * Structural guard: the server's vendored dataset
 * (`server/config/iso3166Countries.json`) and the client's own vendored
 * copy (`client/src/utils/iso3166Countries.json`) must be BYTE-IDENTICAL.
 * The client carries its own copy rather than fetching this one at
 * runtime (a static 249-row list over the network for every dialog open
 * would be wasteful, and flags must render without a round trip), so
 * nothing enforces agreement between the two files except this test. If
 * either is ever regenerated or hand-edited independently, this fails
 * loudly rather than the two silently drifting -- e.g. the client
 * offering a country the server then rejects, or vice versa.
 */
describe('server and client vendored country datasets stay in sync', () => {
  it('are byte-identical', () => {
    const serverPath = path.join(__dirname, '..', 'config', 'iso3166Countries.json');
    const clientPath = path.join(__dirname, '..', '..', 'client', 'src', 'utils', 'iso3166Countries.json');
    const serverContents = fs.readFileSync(serverPath, 'utf8');
    const clientContents = fs.readFileSync(clientPath, 'utf8');
    expect(clientContents).toBe(serverContents);
  });
});
