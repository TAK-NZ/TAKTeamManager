import { describe, it, expect } from 'vitest'

import {
  EXPIRY_STATES,
  DEFAULT_EXPIRY_WARNING_DAYS,
  resolveWarningDays,
  setExpiryWarningDays,
  getExpiryWarningDays,
  classifyExpiry
} from './expiryWarning.js'

// Validates: Requirements 21.1, 21.4, 21.5, 21.6, 21.7
//
// The named example cases for the pure classifier (device-management task
// 29.4). The three-way classification across the WHOLE input space, and in
// particular the inclusive upper boundary, is asserted by Property 16 in
// `expiryWarning.property.test.js`; this file pins the specific values the
// acceptance criteria name -- unset/`'0'`/`'-5'`/`'abc'`/`'45'` for the
// threshold (21.1, 21.7), and null / one day ago / one day ahead / exactly on
// the boundary / a year ahead for the classification (21.4, 21.5, 21.6).

const MS_PER_DAY = 24 * 60 * 60 * 1000

// A fixed reference instant. `now` is a parameter of `classifyExpiry`
// precisely so both boundaries are reachable by arithmetic, with no clock
// manipulation and no dependence on when the suite happens to run.
const NOW = Date.parse('2026-06-01T00:00:00Z')

describe('resolveWarningDays (Reqs 21.1, 21.7)', () => {
  // Criterion 21.7: unreachable config, a missing key, or a value that is not
  // a positive integer all mean 30 client-side.
  it('falls back to 30 when the value is unset', () => {
    expect(resolveWarningDays(undefined)).toBe(30)
    expect(resolveWarningDays(null)).toBe(30)
    expect(DEFAULT_EXPIRY_WARNING_DAYS).toBe(30)
  })

  it('falls back to 30 for zero and for a negative value', () => {
    expect(resolveWarningDays('0')).toBe(30)
    expect(resolveWarningDays('-5')).toBe(30)
    expect(resolveWarningDays(0)).toBe(30)
    expect(resolveWarningDays(-5)).toBe(30)
  })

  it('falls back to 30 for an unparseable value', () => {
    expect(resolveWarningDays('abc')).toBe(30)
  })

  it('accepts a positive integer, as a string or as a number', () => {
    expect(resolveWarningDays('45')).toBe(45)
    expect(resolveWarningDays(45)).toBe(45)
  })

  // The documented difference from the server's `parseInt(...) || <default>`
  // discipline: a fractional value is not truncated, because the server
  // resolves the variable to a positive integer BEFORE it goes on the wire,
  // so a fractional value reaching the client is evidence of an unhealthy
  // response rather than a sloppy spelling of an operator's intent.
  it('falls back to 30 rather than truncating a fractional value', () => {
    expect(resolveWarningDays('30.7')).toBe(30)
    expect(resolveWarningDays(45.9)).toBe(30)
    expect(resolveWarningDays('12abc')).toBe(30)
  })
})

describe('setExpiryWarningDays / getExpiryWarningDays (Req 21.7)', () => {
  it('installs a usable value and normalises an unusable one to the default', () => {
    setExpiryWarningDays('45')
    expect(getExpiryWarningDays()).toBe(45)

    setExpiryWarningDays('abc')
    expect(getExpiryWarningDays()).toBe(DEFAULT_EXPIRY_WARNING_DAYS)

    // Leave the module in its default state for anything that runs after.
    setExpiryWarningDays(DEFAULT_EXPIRY_WARNING_DAYS)
    expect(getExpiryWarningDays()).toBe(DEFAULT_EXPIRY_WARNING_DAYS)
  })
})

describe('classifyExpiry named cases (Reqs 21.4, 21.5, 21.6)', () => {
  // Criterion 21.4: a null `expires_at` gets no highlighting and no marker,
  // so the cell renders exactly as it did before this requirement existed.
  it('classifies a null or unparseable expiry as none', () => {
    expect(classifyExpiry(null, 30, NOW)).toBe(EXPIRY_STATES.NONE)
    expect(classifyExpiry(undefined, 30, NOW)).toBe(EXPIRY_STATES.NONE)
    expect(classifyExpiry('not a date', 30, NOW)).toBe(EXPIRY_STATES.NONE)
  })

  // Criterion 21.5: strictly earlier than now is the Expired_Certificate_State.
  it('classifies an instant one day ago as expired', () => {
    expect(classifyExpiry(new Date(NOW - MS_PER_DAY).toISOString(), 30, NOW)).toBe(
      EXPIRY_STATES.EXPIRED
    )
  })

  it('classifies an instant one day ahead as imminent', () => {
    expect(classifyExpiry(new Date(NOW + MS_PER_DAY).toISOString(), 30, NOW)).toBe(
      EXPIRY_STATES.IMMINENT
    )
  })

  // Criterion 21.6, last sentence: the upper bound is INCLUSIVE, so exactly on
  // `now + warningDays` is still imminent. One millisecond past it is not.
  it('classifies an instant exactly on the boundary as imminent, and one ms past it as none', () => {
    const boundary = NOW + 30 * MS_PER_DAY

    expect(classifyExpiry(boundary, 30, NOW)).toBe(EXPIRY_STATES.IMMINENT)
    expect(classifyExpiry(boundary - 1, 30, NOW)).toBe(EXPIRY_STATES.IMMINENT)
    expect(classifyExpiry(boundary + 1, 30, NOW)).toBe(EXPIRY_STATES.NONE)

    // `now` itself is the other end of the same closed interval.
    expect(classifyExpiry(NOW, 30, NOW)).toBe(EXPIRY_STATES.IMMINENT)
    expect(classifyExpiry(NOW - 1, 30, NOW)).toBe(EXPIRY_STATES.EXPIRED)
  })

  it('classifies an instant a year ahead as none', () => {
    expect(classifyExpiry(new Date(NOW + 365 * MS_PER_DAY).toISOString(), 30, NOW)).toBe(
      EXPIRY_STATES.NONE
    )
  })

  // The threshold moves the boundary and nothing else: the same instant is
  // `none` at 30 days and `imminent` at 45.
  it('places the boundary at the resolved threshold', () => {
    const in40Days = NOW + 40 * MS_PER_DAY

    expect(classifyExpiry(in40Days, 30, NOW)).toBe(EXPIRY_STATES.NONE)
    expect(classifyExpiry(in40Days, 45, NOW)).toBe(EXPIRY_STATES.IMMINENT)
    // An unusable threshold behaves as 30 rather than producing a NaN
    // boundary that would classify a genuinely imminent expiry as none.
    expect(classifyExpiry(in40Days, 'abc', NOW)).toBe(EXPIRY_STATES.NONE)
    expect(classifyExpiry(NOW + MS_PER_DAY, 'abc', NOW)).toBe(EXPIRY_STATES.IMMINENT)
  })
})
