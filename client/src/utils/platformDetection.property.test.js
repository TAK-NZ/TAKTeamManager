// Feature: takserver-enrollment, Property 11: Android detection is total over hostile navigator shapes
//
// **Validates: Requirements 10.6**
//
// *For any* navigator-like argument -- `null`, `undefined`, a primitive, an
// object with no `userAgent`, a non-string `userAgent`, an object with no
// `userAgentData`, a `userAgentData` whose `platform` getter THROWS, a
// `userAgentData.platform` of arbitrary case, and arbitrary `userAgent`
// strings including ones naming Android in mixed case and ones naming it
// inside an unrelated token -- `isAndroidClient` SHALL return a boolean;
// SHALL never throw; and SHALL be a pure function of its argument alone,
// returning the same value for the same argument on repeated calls and
// reading no global.
//
// This property does NOT assert which boolean is correct for a given shape --
// that is a matter for unit tests over the documented detection order. It
// asserts only totality, determinism and global-independence, which is
// exactly what the design's Property 11 states.
//
// THE "reads no global" CLAUSE is the one that needs a mechanism rather than
// a plain assertion: `isAndroidClient` takes `nav` as a parameter and never
// mentions `navigator` in its body, so the only way to catch a regression
// that reached for the global anyway is to make the global say something
// DIFFERENT from the parameter and confirm the answer does not move. For
// every generated scenario this test:
//
//   1. calls `isAndroidClient(nav)` with the real (jsdom) global `navigator`
//      in place, to get a reference result;
//   2. deletes `globalThis.navigator` entirely and calls again -- if the
//      subject secretly read the global, a missing one would either throw
//      or change the answer;
//   3. replaces `globalThis.navigator` with a HOSTILE shape engineered to
//      produce the OPPOSITE boolean, were it consulted, and calls a third
//      time.
//
// All three calls must agree, and the global is restored afterward
// (`afterEach`) so this test cannot leak a stubbed navigator into any other
// suite in the same run.

import { describe, it, expect, afterEach } from 'vitest'
import fc from 'fast-check'

import { isAndroidClient } from './platformDetection.js'

/** Named so a failing anti-vacuity assertion can say exactly which category never appeared. */
const CATEGORY = {
  NULL: 'null',
  UNDEFINED: 'undefined',
  PRIMITIVE: 'primitive',
  NO_USER_AGENT: 'objectWithNoUserAgent',
  NON_STRING_USER_AGENT: 'nonStringUserAgent',
  NO_USER_AGENT_DATA: 'objectWithNoUserAgentData',
  THROWING_PLATFORM_GETTER: 'userAgentDataPlatformGetterThrows',
  PLATFORM_ARBITRARY_CASE: 'userAgentDataPlatformArbitraryCase',
  ANDROID_MIXED_CASE_USER_AGENT: 'userAgentNamingAndroidMixedCase',
  ANDROID_UNRELATED_TOKEN_USER_AGENT: 'userAgentNamingAndroidInsideUnrelatedToken'
}

/** Every category the task names explicitly; the anti-vacuity check requires all of them. */
const REQUIRED_CATEGORIES = Object.values(CATEGORY)

const nullArb = fc.constant({ category: CATEGORY.NULL, nav: null })
const undefinedArb = fc.constant({ category: CATEGORY.UNDEFINED, nav: undefined })

const primitiveArb = fc
  .oneof(fc.string(), fc.integer(), fc.double(), fc.boolean())
  .map((value) => ({ category: CATEGORY.PRIMITIVE, nav: value }))

const noUserAgentArb = fc
  .oneof(
    fc.constant({}),
    fc.record({ platform: fc.string() }),
    fc.record({ language: fc.string(), vendor: fc.string() })
  )
  .map((nav) => ({ category: CATEGORY.NO_USER_AGENT, nav }))

const nonStringUserAgentArb = fc
  .oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.string(), { maxLength: 3 }), fc.record({ x: fc.string() }))
  .map((userAgent) => ({ category: CATEGORY.NON_STRING_USER_AGENT, nav: { userAgent } }))

// Has a `userAgent` (so the fallback path is reached) but no `userAgentData`
// key at all -- exercises `readUserAgentDataPlatform`'s `nav?.userAgentData`
// optional-chain returning `undefined` rather than throwing.
const noUserAgentDataArb = fc
  .string()
  .map((userAgent) => ({ category: CATEGORY.NO_USER_AGENT_DATA, nav: { userAgent } }))

/** A `userAgentData` object whose `platform` accessor throws when read. */
function makeThrowingUserAgentData() {
  const userAgentData = {}
  Object.defineProperty(userAgentData, 'platform', {
    get() {
      throw new Error('hostile platform getter must never propagate')
    },
    enumerable: true,
    configurable: true
  })
  return userAgentData
}

const throwingPlatformGetterArb = fc
  .string()
  .map((userAgent) => ({
    category: CATEGORY.THROWING_PLATFORM_GETTER,
    nav: { userAgentData: makeThrowingUserAgentData(), userAgent }
  }))

const platformArbitraryCaseArb = fc
  .constantFrom(
    'android',
    'Android',
    'ANDROID',
    'AnDroId',
    'aNDROId',
    'windows',
    'Windows',
    'macOS',
    'Linux',
    'iOS',
    'iPadOS',
    'ChromeOS',
    ''
  )
  .map((platform) => ({ category: CATEGORY.PLATFORM_ARBITRARY_CASE, nav: { userAgentData: { platform } } }))

const androidMixedCaseUserAgentArb = fc
  .constantFrom(
    'Mozilla/5.0 (Linux; Android 10; SM-G973F)',
    'ANDROID device browsing',
    'AndroId Mobile Safari',
    'aNdRoId/13',
    'Mozilla/5.0 (ANDROID; Mobile)'
  )
  .map((userAgent) => ({ category: CATEGORY.ANDROID_MIXED_CASE_USER_AGENT, nav: { userAgent } }))

// "Android" appearing as a substring of an unrelated token, e.g. inside a
// product name that merely contains the letters -- distinct from Android
// appearing as its own recognisable token in a real user-agent string.
const androidUnrelatedTokenUserAgentArb = fc
  .constantFrom(
    'PandroidQBrowser/1.0',
    'MyAndroidToneGenerator/2.3',
    'xxandroidxxWidget',
    'NotAndroidRelatedAtAll/9',
    'FooANDROIDBarBaz'
  )
  .map((userAgent) => ({ category: CATEGORY.ANDROID_UNRELATED_TOKEN_USER_AGENT, nav: { userAgent } }))

// A broad arm of arbitrary user-agent strings, beyond the named categories
// above, so the totality claim is not limited to a short constant list.
const arbitraryUserAgentArb = fc
  .string()
  .map((userAgent) => ({ category: 'arbitraryUserAgent', nav: { userAgent } }))

const scenarioArb = fc.oneof(
  nullArb,
  undefinedArb,
  primitiveArb,
  noUserAgentArb,
  nonStringUserAgentArb,
  noUserAgentDataArb,
  throwingPlatformGetterArb,
  platformArbitraryCaseArb,
  androidMixedCaseUserAgentArb,
  androidUnrelatedTokenUserAgentArb,
  arbitraryUserAgentArb
)

/** Restored after every test, so a stubbed navigator cannot leak into another suite. */
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function restoreNavigator() {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor)
  } else {
    delete globalThis.navigator
  }
}

function stubNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  restoreNavigator()
})

describe('Property 11: Android detection is total over hostile navigator shapes', () => {
  it('returns a boolean, never throws, and is pure -- reading no global -- for every hostile navigator shape', () => {
    const seenCategories = new Set()

    fc.assert(
      fc.property(scenarioArb, ({ category, nav }) => {
        seenCategories.add(category)

        try {
          // Baseline: the real jsdom `navigator` is in place, untouched.
          let referenceResult
          expect(() => {
            referenceResult = isAndroidClient(nav)
          }).not.toThrow()
          expect(typeof referenceResult).toBe('boolean')

          // Purity / determinism: same argument, same result, on repeated
          // calls with nothing else changed.
          expect(isAndroidClient(nav)).toBe(referenceResult)

          // Reads no global, arm 1: delete the global `navigator` entirely.
          // A subject that secretly reached for it would either throw on the
          // missing object or answer differently; a subject reading only
          // its parameter is unaffected.
          delete globalThis.navigator
          expect(() => isAndroidClient(nav)).not.toThrow()
          expect(isAndroidClient(nav)).toBe(referenceResult)

          // Reads no global, arm 2: replace the global `navigator` with a
          // HOSTILE shape engineered to produce the OPPOSITE boolean, were
          // it consulted instead of `nav`.
          const hostileNavigator = referenceResult
            ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }
            : { userAgentData: { platform: 'Android' }, userAgent: 'Mozilla/5.0 (Linux; Android 14)' }
          stubNavigator(hostileNavigator)
          expect(() => isAndroidClient(nav)).not.toThrow()
          expect(isAndroidClient(nav)).toBe(referenceResult)
        } finally {
          restoreNavigator()
        }
      }),
      { numRuns: 300 }
    )

    // Anti-vacuity: every hostile shape category the task names must have
    // actually been generated at least once, or this property could pass
    // while never exercising the case it exists to test.
    for (const category of REQUIRED_CATEGORIES) {
      expect(seenCategories.has(category), `category "${category}" was never generated`).toBe(true)
    }
  })
})
