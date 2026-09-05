import { describe, it, expect } from 'vitest'
import { countries, getCountry, flagClass, filterCountries } from './isoCountry'

/**
 * Foreign_Partner Organisation country prefix feature (client side).
 * Mirrors server/utils/isoCountry.test.js's convention -- this file mounts
 * nothing (no React import); it is a direct unit test of the pure utility
 * per the placement rule (client/src/utils/, no React import).
 */
describe('countries', () => {
  it('contains the full ISO 3166-1 list (249 countries)', () => {
    expect(countries.length).toBe(249)
  })

  it('is sorted alphabetically by name', () => {
    const names = countries.map((c) => c.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(names).toEqual(sorted)
  })

  it('every row has a non-empty name, a 3-letter uppercase alpha3, and a 2-letter lowercase alpha2', () => {
    for (const country of countries) {
      expect(typeof country.name).toBe('string')
      expect(country.name.length).toBeGreaterThan(0)
      expect(country.alpha3).toMatch(/^[A-Z]{3}$/)
      expect(country.alpha2).toMatch(/^[a-z]{2}$/)
    }
  })

  it('has no duplicate alpha3 codes', () => {
    const alpha3Codes = countries.map((c) => c.alpha3)
    expect(new Set(alpha3Codes).size).toBe(alpha3Codes.length)
  })

  it('includes New Zealand, Australia, and Fiji at their real ISO codes', () => {
    const byAlpha3 = new Map(countries.map((c) => [c.alpha3, c]))
    expect(byAlpha3.get('NZL')).toEqual({ name: 'New Zealand', alpha3: 'NZL', alpha2: 'nz' })
    expect(byAlpha3.get('AUS')).toEqual({ name: 'Australia', alpha3: 'AUS', alpha2: 'au' })
    expect(byAlpha3.get('FJI')).toEqual({ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' })
  })
})

describe('getCountry', () => {
  it('resolves a known alpha-3 code to its full record', () => {
    expect(getCountry('FJI')).toEqual({ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' })
    expect(getCountry('AUS')).toEqual({ name: 'Australia', alpha3: 'AUS', alpha2: 'au' })
    expect(getCountry('NZL')).toEqual({ name: 'New Zealand', alpha3: 'NZL', alpha2: 'nz' })
  })

  it('is case-insensitive on input', () => {
    expect(getCountry('fji')).toEqual({ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' })
  })

  it('returns null for an unknown code', () => {
    expect(getCountry('ZZZ')).toBeNull()
  })

  it('returns null for an empty/null/undefined/non-string value, never throwing', () => {
    expect(getCountry('')).toBeNull()
    expect(getCountry(null)).toBeNull()
    expect(getCountry(undefined)).toBeNull()
    expect(getCountry(5)).toBeNull()
    expect(getCountry({})).toBeNull()
  })
})

describe('flagClass', () => {
  it('returns the flag-icons CSS class for a known country, keyed on alpha-2', () => {
    expect(flagClass('FJI')).toBe('fi fi-fj')
    expect(flagClass('AUS')).toBe('fi fi-au')
    expect(flagClass('NZL')).toBe('fi fi-nz')
  })

  it('is case-insensitive on input', () => {
    expect(flagClass('fji')).toBe('fi fi-fj')
  })

  it('returns null for an empty/unknown/absent code, never a broken class string', () => {
    expect(flagClass('')).toBeNull()
    expect(flagClass(null)).toBeNull()
    expect(flagClass(undefined)).toBeNull()
    expect(flagClass('ZZZ')).toBeNull()
  })
})

describe('filterCountries', () => {
  it('returns the full sorted list for an empty, whitespace-only, null, or undefined term', () => {
    expect(filterCountries('')).toEqual(countries)
    expect(filterCountries('   ')).toEqual(countries)
    expect(filterCountries(null)).toEqual(countries)
    expect(filterCountries(undefined)).toEqual(countries)
  })

  it('matches by a substring of the country name, case-insensitively', () => {
    const results = filterCountries('fiji')
    expect(results).toEqual([{ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' }])

    expect(filterCountries('FIJI')).toEqual(results)
    expect(filterCountries('Fij')).toEqual(results)
  })

  it('matches by a substring of the alpha-3 code, case-insensitively', () => {
    expect(filterCountries('fji')).toEqual([{ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' }])
    expect(filterCountries('FJI')).toEqual([{ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' }])
  })

  it('trims surrounding whitespace before matching', () => {
    expect(filterCountries('  fiji  ')).toEqual([{ name: 'Fiji', alpha3: 'FJI', alpha2: 'fj' }])
  })

  it('returns an empty array (not null/undefined) when no country matches', () => {
    expect(filterCountries('nonexistentcountryxyz')).toEqual([])
  })

  it('preserves the alphabetical-by-name ordering of the underlying full list', () => {
    // "an" matches several country names (e.g. Andorra, France, ...) --
    // asserting the filtered subset's own relative order stays sorted
    // catches a filter implementation that rebuilds the array unsorted.
    const results = filterCountries('an')
    const names = results.map((c) => c.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(results.length).toBeGreaterThan(1)
    expect(names).toEqual(sorted)
  })
})
