import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { TEMPLATE_VARIABLE_HINTS, getVariableHints } from './templateVariableHints.js'

// Feature: admin-settings-management, task 3.2.
//
// Property 5 (design.md): "Variable hints never break editing" -- for ANY
// Template_Key string, getVariableHints(key) returns an array (empty for an
// unknown key), so a template with no hint entry still renders and remains
// editable. This is the pure, input-varying safety net for the advisory
// Template_Variable_Hints map: the accessor must never hand back undefined/null,
// must return [] for anything it does not know, and must return exactly the
// mapped list for each of the seven known keys.
//
// The expectation for each key is computed DIRECTLY from TEMPLATE_VARIABLE_HINTS
// (own-property lookup) rather than by calling getVariableHints again, so the
// property is an independent statement about the accessor rather than a
// restatement of it.
//
// Extended by cert-expiry-notifications task 7.2 to cover the two new
// digest keys added since this file was first written -- KNOWN_KEYS is
// no longer "the seven" but the comment above KNOWN_KEYS itself carries
// the current count.

// The currently seeded Template_Keys (design.md / Requirements glossary),
// plus the two cert-expiry-notifications digest keys (task 7.2).
const KNOWN_KEYS = [
  'access_request_verification',
  'access_request_approved',
  'access_request_denied',
  'admin_notification_digest',
  'signup_pending_review',
  'signup_already_active',
  'team_transfer_completed',
  'cert_expiry_self_digest',
  'cert_expiry_team_digest'
]

// True iff `key` is an own enumerable Template_Key of the hints map -- the
// independent oracle for "known" vs "unknown", never routed through the code
// under test.
function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_VARIABLE_HINTS, key)
}

describe('templateVariableHints Property 5: Variable hints never break editing (Validates: Requirements 5.1, 5.2)', () => {
  // Arbitrary key strings, explicitly seeded with the seven known keys and a few
  // adversarial keys (prototype-chain names, empty string, whitespace) so the
  // own-property guard is exercised, not just random misses.
  const keyArb = fc.oneof(
    fc.constantFrom(...KNOWN_KEYS),
    fc.constantFrom('toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf', '', '   '),
    fc.string()
  )

  // Feature: admin-settings-management, Property 5: Variable hints never break editing
  it('returns an array for any key string -- exactly the mapped list for a known key, and an empty array for an unknown key', () => {
    fc.assert(
      fc.property(keyArb, (key) => {
        const hints = getVariableHints(key)

        // Never undefined/null: always an array, so the UI can always render and
        // the template stays editable (Requirement 5.2).
        expect(Array.isArray(hints)).toBe(true)

        if (isKnownKey(key)) {
          // A known key returns exactly that key's advisory list (Requirement 5.1),
          // compared element-for-element against the map directly.
          expect(hints).toEqual(TEMPLATE_VARIABLE_HINTS[key])
        } else {
          // An unknown key (including prototype-chain names like `toString`)
          // returns an empty array (Requirement 5.2).
          expect(hints).toEqual([])
        }
      }),
      { numRuns: 100 }
    )
  })
})

describe('templateVariableHints examples', () => {
  // Each known key returns its exact advisory list (Requirement 5.1).
  it('each of the nine known keys returns exactly its mapped advisory list', () => {
    expect(getVariableHints('access_request_verification')).toEqual([
      'first_name', 'verification_link', 'team_path', 'expiry_hours'
    ])
    expect(getVariableHints('access_request_approved')).toEqual([
      'first_name', 'team_path', 'callsign', 'username', 'password_reset_url'
    ])
    expect(getVariableHints('access_request_denied')).toEqual([
      'first_name', 'team_path', 'denial_reason'
    ])
    expect(getVariableHints('admin_notification_digest')).toEqual([
      'pending_count', 'request_list'
    ])
    expect(getVariableHints('signup_pending_review')).toEqual([
      'first_name', 'team_path'
    ])
    expect(getVariableHints('signup_already_active')).toEqual([
      'first_name', 'username'
    ])
    expect(getVariableHints('team_transfer_completed')).toEqual([
      'first_name', 'team_path', 'callsign', 'username'
    ])
    // cert-expiry-notifications Requirements 3.3, 4.3 (task 7.2).
    expect(getVariableHints('cert_expiry_self_digest')).toEqual([
      'first_name', 'device_list', 'revoke_hint_url'
    ])
    expect(getVariableHints('cert_expiry_team_digest')).toEqual([
      'first_name', 'team_sections', 'revoke_hint_url'
    ])
  })

  // An unknown key returns an empty array (Requirement 5.2).
  it('an unknown key returns an empty array', () => {
    expect(getVariableHints('no_such_template')).toEqual([])
  })

  // Prototype-chain property names must not leak through as "known" keys: the
  // own-property guard keeps them returning [] (Requirement 5.2).
  it('prototype-chain keys such as toString and __proto__ return an empty array', () => {
    expect(getVariableHints('toString')).toEqual([])
    expect(getVariableHints('constructor')).toEqual([])
    expect(getVariableHints('hasOwnProperty')).toEqual([])
    expect(getVariableHints('__proto__')).toEqual([])
  })

  // A non-string key still yields an array rather than undefined/null.
  it('a non-string key still returns an empty array', () => {
    expect(getVariableHints(undefined)).toEqual([])
    expect(getVariableHints(null)).toEqual([])
    expect(getVariableHints(42)).toEqual([])
  })
})
