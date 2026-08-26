import { describe, it, expect } from 'vitest'
import { COUNTDOWN_EXPIRED, formatCountdown } from './tokenCountdown'

// Pure function, no React involved -- plain Vitest describe/it/expect,
// no createRoot/act/globalThis.React ceremony needed (that convention only
// applies to files that mount a .jsx component).

describe('formatCountdown', () => {
  it('formats a normal in-range value as zero-padded MM : SS', () => {
    // 5 minutes, 9 seconds remaining
    expect(formatCountdown(5 * 60 * 1000 + 9 * 1000)).toBe('05 : 09')
  })

  it('treats the exact zero boundary as expired', () => {
    expect(formatCountdown(0)).toBe(COUNTDOWN_EXPIRED)
  })

  it('treats a negative value as expired', () => {
    expect(formatCountdown(-1)).toBe(COUNTDOWN_EXPIRED)
  })

  it('treats non-number, null, undefined, NaN and Infinity as expired', () => {
    expect(formatCountdown(null)).toBe(COUNTDOWN_EXPIRED)
    expect(formatCountdown(undefined)).toBe(COUNTDOWN_EXPIRED)
    expect(formatCountdown(NaN)).toBe(COUNTDOWN_EXPIRED)
    expect(formatCountdown(Infinity)).toBe(COUNTDOWN_EXPIRED)
    expect(formatCountdown(-Infinity)).toBe(COUNTDOWN_EXPIRED)
    expect(formatCountdown('1500')).toBe(COUNTDOWN_EXPIRED)
    expect(formatCountdown({})).toBe(COUNTDOWN_EXPIRED)
    expect(formatCountdown([])).toBe(COUNTDOWN_EXPIRED)
    expect(formatCountdown(true)).toBe(COUNTDOWN_EXPIRED)
  })

  it('does not wrap or truncate minutes beyond 99', () => {
    // 150 minutes remaining must render as 3+ digits, never wrapped to
    // 50 or truncated to 99.
    const msRemaining = 150 * 60 * 1000
    expect(formatCountdown(msRemaining)).toBe('150 : 00')
  })

  it('rounds up so a sub-second remainder does not read as 00 : 00', () => {
    // 1500ms remaining -> ceil(1.5) = 2 total seconds -> 00 : 02
    expect(formatCountdown(1500)).toBe('00 : 02')
  })
})
