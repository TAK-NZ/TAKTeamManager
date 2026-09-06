import { describe, it, expect } from 'vitest'
import { formatQueueAge } from './formatQueueAge'

describe('formatQueueAge', () => {
  it('formats sub-minute ages in seconds', () => {
    expect(formatQueueAge(0)).toBe('0s')
    expect(formatQueueAge(45)).toBe('45s')
    expect(formatQueueAge(59)).toBe('59s')
  })

  it('formats minute-scale ages', () => {
    expect(formatQueueAge(60)).toBe('1m')
    expect(formatQueueAge(125)).toBe('2m')
    expect(formatQueueAge(3599)).toBe('59m')
  })

  it('formats hour-scale ages, omitting a trailing 0m', () => {
    expect(formatQueueAge(3600)).toBe('1h')
    expect(formatQueueAge(3600 + 600)).toBe('1h 10m')
    expect(formatQueueAge(2 * 3600)).toBe('2h')
  })

  it('formats day-scale ages, omitting a trailing 0h', () => {
    expect(formatQueueAge(24 * 3600)).toBe('1d')
    expect(formatQueueAge(24 * 3600 + 4 * 3600)).toBe('1d 4h')
    expect(formatQueueAge(3 * 24 * 3600)).toBe('3d')
  })

  it('floors fractional seconds rather than rounding', () => {
    expect(formatQueueAge(59.9)).toBe('59s')
    expect(formatQueueAge(60.4)).toBe('1m')
  })

  // Total, non-throwing: unusable input returns the neutral placeholder, never
  // a misleading "0s" or a thrown error that would blank the /admin card.
  it.each([
    [null],
    [undefined],
    [NaN],
    [Infinity],
    [-Infinity],
    [-5],
    ['120'],
    [{}]
  ])('returns "—" for unusable input %p', (input) => {
    expect(formatQueueAge(input)).toBe('—')
  })
})
