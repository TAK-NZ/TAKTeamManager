import { describe, it, expect, afterEach } from 'vitest'
import { formatNumber } from './formatNumber'
import { setDisplayLocale, getDisplayLocale, DEFAULT_DISPLAY_LOCALE } from './dateFormat'

// `configuredLocale` is module state shared with every other test that touches
// the date/locale helpers, so restore the documented default after each test
// (the same discipline the date tests follow with setDisplayTimezone).
afterEach(() => {
  setDisplayLocale(DEFAULT_DISPLAY_LOCALE)
})

describe('formatNumber', () => {
  it('groups thousands under the default (en-NZ) locale', () => {
    setDisplayLocale('en-NZ')
    expect(formatNumber(13329)).toBe('13,329')
    expect(formatNumber(1000)).toBe('1,000')
    expect(formatNumber(1234567)).toBe('1,234,567')
  })

  it('leaves numbers <= 999 without a separator', () => {
    setDisplayLocale('en-NZ')
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(42)).toBe('42')
    expect(formatNumber(999)).toBe('999')
  })

  it('respects the configured locale (call-time, not import-time)', () => {
    // de-DE groups with a period; a late install must still take effect.
    setDisplayLocale('de-DE')
    expect(getDisplayLocale()).toBe('de-DE')
    expect(formatNumber(13329)).toBe('13.329')
  })

  it('handles negative numbers with grouping', () => {
    setDisplayLocale('en-NZ')
    expect(formatNumber(-13329)).toBe('-13,329')
  })

  // Totality: unusable input returns '' (not a throw, not "0"/"NaN").
  it.each([
    [null],
    [undefined],
    [NaN],
    [Infinity],
    [-Infinity],
    ['13329'],
    [{}],
    [[]]
  ])('returns "" for unusable input %p', (input) => {
    expect(formatNumber(input)).toBe('')
  })
})
