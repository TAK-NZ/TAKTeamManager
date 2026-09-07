import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordAutoLoginAttemptAndCheckLoop,
  clearAutoLoginAttempts,
  AUTO_LOGIN_ATTEMPTS_KEY,
  AUTO_LOGIN_MAX_ATTEMPTS,
  AUTO_LOGIN_WINDOW_MS
} from './autoLoginGuard'

// A minimal in-memory Storage stand-in. jsdom provides a real
// sessionStorage, but an injectable fake lets each case control contents and
// simulate a storage context that throws (the "Access to storage is not
// allowed from this context" case these guards must fail OPEN on).
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
    getItem: () => {
      throw new Error('Access to storage is not allowed from this context.')
    },
    setItem: () => {
      throw new Error('Access to storage is not allowed from this context.')
    },
    removeItem: () => {
      throw new Error('Access to storage is not allowed from this context.')
    }
  }
}

describe('autoLoginGuard.recordAutoLoginAttemptAndCheckLoop', () => {
  let storage
  const t0 = 1_000_000

  beforeEach(() => {
    storage = makeStorage()
  })

  it('does not report a loop on the first auto-login attempt', () => {
    expect(recordAutoLoginAttemptAndCheckLoop(storage, t0)).toBe(false)
  })

  it('reports a loop once AUTO_LOGIN_MAX_ATTEMPTS fire within the window', () => {
    // First MAX-1 attempts stay under the threshold...
    for (let i = 0; i < AUTO_LOGIN_MAX_ATTEMPTS - 1; i++) {
      expect(recordAutoLoginAttemptAndCheckLoop(storage, t0 + i)).toBe(false)
    }
    // ...the MAX-th trips it.
    expect(
      recordAutoLoginAttemptAndCheckLoop(storage, t0 + AUTO_LOGIN_MAX_ATTEMPTS)
    ).toBe(true)
  })

  it('does NOT trip when attempts are spread beyond the window (aged out)', () => {
    // Record MAX-1 attempts, then jump past the window before the next one:
    // the stale ones are discarded, so the count resets and no loop is
    // reported.
    for (let i = 0; i < AUTO_LOGIN_MAX_ATTEMPTS - 1; i++) {
      recordAutoLoginAttemptAndCheckLoop(storage, t0 + i)
    }
    const wayLater = t0 + AUTO_LOGIN_WINDOW_MS + 1
    expect(recordAutoLoginAttemptAndCheckLoop(storage, wayLater)).toBe(false)
  })

  it('persists attempts across calls under the same key', () => {
    recordAutoLoginAttemptAndCheckLoop(storage, t0)
    const stored = JSON.parse(storage._dump()[AUTO_LOGIN_ATTEMPTS_KEY])
    expect(Array.isArray(stored)).toBe(true)
    expect(stored).toEqual([t0])
  })

  it('fails OPEN (returns false) when storage access throws', () => {
    // A privacy/embedded context that throws on access must never block a
    // legitimate first login -- report "not looping".
    expect(recordAutoLoginAttemptAndCheckLoop(throwingStorage(), t0)).toBe(false)
  })

  it('fails OPEN when no storage is available at all', () => {
    expect(recordAutoLoginAttemptAndCheckLoop(undefined, t0)).toBe(false)
  })

  it('ignores a corrupt (non-array) stored value rather than throwing', () => {
    const corrupt = makeStorage({ [AUTO_LOGIN_ATTEMPTS_KEY]: '{"not":"an array"}' })
    // Treated as empty history -> first fresh attempt, no loop.
    expect(recordAutoLoginAttemptAndCheckLoop(corrupt, t0)).toBe(false)
  })
})

describe('autoLoginGuard.clearAutoLoginAttempts', () => {
  it('removes the counter so a later attempt starts fresh', () => {
    const storage = makeStorage()
    const t0 = 2_000_000
    for (let i = 0; i < AUTO_LOGIN_MAX_ATTEMPTS; i++) {
      recordAutoLoginAttemptAndCheckLoop(storage, t0 + i)
    }
    clearAutoLoginAttempts(storage)
    expect(storage._dump()[AUTO_LOGIN_ATTEMPTS_KEY]).toBeUndefined()
    // A fresh attempt after clearing does not immediately report a loop.
    expect(recordAutoLoginAttemptAndCheckLoop(storage, t0 + 100)).toBe(false)
  })

  it('is a silent no-op when storage access throws', () => {
    expect(() => clearAutoLoginAttempts(throwingStorage())).not.toThrow()
  })

  it('is a silent no-op when no storage is available', () => {
    expect(() => clearAutoLoginAttempts(undefined)).not.toThrow()
  })
})
