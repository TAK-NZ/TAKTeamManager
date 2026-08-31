import { describe, it, expect } from 'vitest'
import { describeAccountStatusBadge } from './accountStatusBadge.js'

// account-lifecycle-management Requirement 4.1-4.3 (task 8.3)
describe('describeAccountStatusBadge', () => {
  it('returns a "Suspended" badge for accountStatus "suspended"', () => {
    const badge = describeAccountStatusBadge('suspended')
    expect(badge).toEqual({ label: 'Suspended', className: expect.stringContaining('bg-amber-100') })
  })

  it('returns an "Account not found in Authentik" badge for accountStatus "orphaned"', () => {
    const badge = describeAccountStatusBadge('orphaned')
    expect(badge).toEqual({ label: 'Account not found in Authentik', className: expect.stringContaining('bg-red-100') })
  })

  it('returns null for accountStatus "active" (no badge to show)', () => {
    expect(describeAccountStatusBadge('active')).toBeNull()
  })

  it('returns null for a missing/undefined/null accountStatus (a row fetched before this feature existed)', () => {
    expect(describeAccountStatusBadge(undefined)).toBeNull()
    expect(describeAccountStatusBadge(null)).toBeNull()
  })

  it('returns null for an unrecognised value, never throwing', () => {
    expect(() => describeAccountStatusBadge('not-a-real-status')).not.toThrow()
    expect(describeAccountStatusBadge('not-a-real-status')).toBeNull()
  })

  it('never carries state through colour alone -- both non-null badges include a visible label string', () => {
    expect(describeAccountStatusBadge('suspended').label.length).toBeGreaterThan(0)
    expect(describeAccountStatusBadge('orphaned').label.length).toBeGreaterThan(0)
  })
})
