import { describe, it, expect } from 'vitest'

import { isAndroidClient } from './platformDetection.js'

// Validates: Requirement 10.6
//
// Basic sanity coverage for the pure platform detector. The exhaustive,
// hostile-input coverage (throwing getters, non-object `nav`, mixed
// generators) lives in `platformDetection.property.test.js` (a later, separate
// task); this file pins the named example cases.

describe('isAndroidClient (Req 10.6)', () => {
  it('detects Android via userAgentData.platform', () => {
    const nav = { userAgentData: { platform: 'Android' }, userAgent: 'irrelevant' }
    expect(isAndroidClient(nav)).toBe(true)
  })

  it('falls back to userAgent when userAgentData is absent', () => {
    const nav = {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'
    }
    expect(isAndroidClient(nav)).toBe(true)
  })

  it('returns false for a non-Android platform and user agent', () => {
    const nav = { userAgentData: { platform: 'Windows' }, userAgent: 'Windows NT 10.0' }
    expect(isAndroidClient(nav)).toBe(false)

    const navNoHints = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)' }
    expect(isAndroidClient(navNoHints)).toBe(false)
  })

  it('returns false without throwing for null, undefined, and a primitive nav', () => {
    expect(isAndroidClient(null)).toBe(false)
    expect(isAndroidClient(undefined)).toBe(false)
    expect(isAndroidClient(42)).toBe(false)
    expect(isAndroidClient('android')).toBe(false)
  })

  it('returns false without propagating a throw from a hostile platform getter', () => {
    const fakeNav = { userAgentData: {}, userAgent: 'should not be reached anyway' }
    Object.defineProperty(fakeNav.userAgentData, 'platform', {
      get() {
        throw new Error('hostile getter')
      }
    })

    expect(() => isAndroidClient(fakeNav)).not.toThrow()
    expect(isAndroidClient(fakeNav)).toBe(false)
  })
})
