import { describe, it, expect } from 'vitest'
import {
  captureReturnPath,
  consumeReturnPath,
  isReturnablePath,
  RETURN_PATH_KEY
} from './returnPath'

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map)
  }
}

function throwingStorage() {
  return {
    getItem: () => { throw new Error('Access to storage is not allowed from this context.') },
    setItem: () => { throw new Error('Access to storage is not allowed from this context.') },
    removeItem: () => { throw new Error('Access to storage is not allowed from this context.') }
  }
}

describe('returnPath.isReturnablePath', () => {
  it('accepts a plain in-app path', () => {
    expect(isReturnablePath('/downloads')).toBe(true)
    expect(isReturnablePath('/enrollment')).toBe(true)
    expect(isReturnablePath('/teams/123')).toBe(true)
    expect(isReturnablePath('/users?search=ada')).toBe(true)
  })

  it('rejects the default and auth/anonymous routes (nothing to return to / would loop)', () => {
    expect(isReturnablePath('/dashboard')).toBe(false)
    expect(isReturnablePath('/login')).toBe(false)
    expect(isReturnablePath('/api/auth/login')).toBe(false)
    expect(isReturnablePath('/request-access')).toBe(false)
    // sub-paths / query variants of those roots too
    expect(isReturnablePath('/login?next=x')).toBe(false)
    expect(isReturnablePath('/dashboard/anything')).toBe(false)
  })

  it('rejects off-origin / open-redirect shapes', () => {
    expect(isReturnablePath('//evil.com')).toBe(false)          // protocol-relative
    expect(isReturnablePath('https://evil.com')).toBe(false)    // absolute URL
    expect(isReturnablePath('/\\evil.com')).toBe(false)         // backslash host trick
    expect(isReturnablePath('relative/path')).toBe(false)       // not app-absolute
  })

  it('rejects non-strings and empties', () => {
    expect(isReturnablePath(null)).toBe(false)
    expect(isReturnablePath(undefined)).toBe(false)
    expect(isReturnablePath('')).toBe(false)
    expect(isReturnablePath(42)).toBe(false)
    expect(isReturnablePath({})).toBe(false)
  })
})

describe('returnPath.captureReturnPath', () => {
  it('stores a returnable path under the key', () => {
    const s = makeStorage()
    captureReturnPath('/downloads', s)
    expect(s._dump()[RETURN_PATH_KEY]).toBe('/downloads')
  })

  it('does NOT store a non-returnable path (e.g. /dashboard)', () => {
    const s = makeStorage()
    captureReturnPath('/dashboard', s)
    expect(s._dump()[RETURN_PATH_KEY]).toBeUndefined()
  })

  it('is a silent no-op when storage throws', () => {
    expect(() => captureReturnPath('/downloads', throwingStorage())).not.toThrow()
  })

  it('is a silent no-op when no storage is available', () => {
    expect(() => captureReturnPath('/downloads', undefined)).not.toThrow()
  })
})

describe('returnPath.consumeReturnPath', () => {
  it('returns the stored path AND clears it', () => {
    const s = makeStorage({ [RETURN_PATH_KEY]: '/downloads' })
    expect(consumeReturnPath(s)).toBe('/downloads')
    // cleared
    expect(s._dump()[RETURN_PATH_KEY]).toBeUndefined()
    // second consume is null
    expect(consumeReturnPath(s)).toBeNull()
  })

  it('returns null (and clears) when the stored value is not returnable (tampered)', () => {
    const s = makeStorage({ [RETURN_PATH_KEY]: 'https://evil.com' })
    expect(consumeReturnPath(s)).toBeNull()
    // still cleared so it cannot re-fire
    expect(s._dump()[RETURN_PATH_KEY]).toBeUndefined()
  })

  it('returns null when nothing is stored', () => {
    expect(consumeReturnPath(makeStorage())).toBeNull()
  })

  it('returns null (never throws) when storage access throws', () => {
    expect(consumeReturnPath(throwingStorage())).toBeNull()
  })

  it('round-trips a real deep link: capture then consume', () => {
    const s = makeStorage()
    captureReturnPath('/downloads', s)
    expect(consumeReturnPath(s)).toBe('/downloads')
  })
})
