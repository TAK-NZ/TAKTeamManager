import { describe, it, expect } from 'vitest'
import { formatDate, formatDateTime } from './dateFormat'

describe('formatDate', () => {
  it('formats an ISO timestamp as yyyy-mm-dd', () => {
    expect(formatDate('2024-03-05T14:30:00.000Z')).toBe('2024-03-05')
  })

  it('pads single-digit month/day with a leading zero', () => {
    expect(formatDate('2024-01-02T00:00:00.000Z')).toBe('2024-01-02')
  })

  it('returns the fallback for null/undefined', () => {
    expect(formatDate(null, 'Never')).toBe('Never')
    expect(formatDate(undefined, 'Never')).toBe('Never')
  })

  it('returns an empty string fallback by default', () => {
    expect(formatDate(null)).toBe('')
  })

  it('returns the fallback for an unparseable value', () => {
    expect(formatDate('not-a-date', 'Never')).toBe('Never')
  })
})

describe('formatDateTime', () => {
  it('formats an ISO timestamp as yyyy-mm-dd HH:MM (24-hour)', () => {
    expect(formatDateTime('2024-03-05T14:30:00.000Z')).toBe('2024-03-05 14:30')
  })

  it('pads single-digit hour/minute with a leading zero', () => {
    expect(formatDateTime('2024-03-05T01:05:00.000Z')).toBe('2024-03-05 01:05')
  })

  it('returns the fallback for null/undefined', () => {
    expect(formatDateTime(null, 'Never')).toBe('Never')
  })
})
