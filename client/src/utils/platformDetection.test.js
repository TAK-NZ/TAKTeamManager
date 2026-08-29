import { describe, it, expect } from 'vitest'

import { isAndroidClient, isIOSClient } from './platformDetection.js'

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

describe('isIOSClient', () => {
  it('detects iOS via userAgentData.platform', () => {
    const nav = { userAgentData: { platform: 'iOS' }, userAgent: 'irrelevant' }
    expect(isIOSClient(nav)).toBe(true)
  })

  it('detects iPadOS via userAgentData.platform, a distinct value from "iOS"', () => {
    const nav = { userAgentData: { platform: 'iPadOS' }, userAgent: 'irrelevant' }
    expect(isIOSClient(nav)).toBe(true)
  })

  it('falls back to userAgent, matching iPhone, iPad, and iPod', () => {
    expect(isIOSClient({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(true)
    expect(isIOSClient({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe(true)
    expect(isIOSClient({ userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(true)
  })

  it('returns false for Android, and for a desktop platform/user agent', () => {
    expect(isIOSClient({ userAgentData: { platform: 'Android' }, userAgent: 'Android' })).toBe(false)

    const nav = { userAgentData: { platform: 'macOS' }, userAgent: 'Macintosh' }
    expect(isIOSClient(nav)).toBe(false)

    const navNoHints = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    expect(isIOSClient(navNoHints)).toBe(false)
  })

  it('returns false without throwing for null, undefined, and a primitive nav', () => {
    expect(isIOSClient(null)).toBe(false)
    expect(isIOSClient(undefined)).toBe(false)
    expect(isIOSClient(42)).toBe(false)
    expect(isIOSClient('ios')).toBe(false)
  })

  it('returns false without propagating a throw from a hostile platform getter', () => {
    const fakeNav = { userAgentData: {}, userAgent: 'should not be reached anyway' }
    Object.defineProperty(fakeNav.userAgentData, 'platform', {
      get() {
        throw new Error('hostile getter')
      }
    })

    expect(() => isIOSClient(fakeNav)).not.toThrow()
    expect(isIOSClient(fakeNav)).toBe(false)
  })
})
