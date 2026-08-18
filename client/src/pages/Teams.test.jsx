import { describe, it, expect } from 'vitest';
import { isValidCallsignPrefixInput } from '../components/TeamFormDialog.jsx';

// Validates: Requirement 3.10
//
// The shared Create/Edit Team dialog (`TeamFormDialog`, used by both
// Teams.jsx and TeamDetail.jsx as of the "unify the two drifted Edit
// Team dialogs" bugfix) applies HTML `pattern` validation plus an inline
// error message to its own "Prefix" input (`formData.callsignPrefix`),
// mirroring server/utils/callsignValidation.js's `isValidCallsignPrefix`
// character class (letters and digits only, no `-`) and the same
// convention already established by TeamDetail.jsx's
// `isValidSubTeamCallsignPrefix` for its Create Sub-Team Dialog's own
// "Prefix" input (task 33.3). No component-render test harness (e.g.
// @testing-library/react) is set up in this project -- see
// src/services/api.test.js, src/utils/channelTree.test.js, and
// src/pages/TeamDetail.test.jsx, which all test extracted pure logic
// rather than rendering a component -- so this file follows that same
// convention and tests the pure helper directly. This test file stays at
// its original path (`src/pages/Teams.test.jsx`) even though the helper
// it tests moved, to avoid unnecessary churn.

describe('isValidCallsignPrefixInput (Req 3.10)', () => {
  it('accepts an empty value', () => {
    expect(isValidCallsignPrefixInput('')).toBe(true)
    expect(isValidCallsignPrefixInput(undefined)).toBe(true)
  })

  it('accepts letters and digits only', () => {
    expect(isValidCallsignPrefixInput('FENZ')).toBe(true)
    expect(isValidCallsignPrefixInput('FENZ123')).toBe(true)
  })

  it('rejects a value containing a "-" (stricter than callsign_suffix)', () => {
    expect(isValidCallsignPrefixInput('NZ-POL')).toBe(false)
  })

  it('rejects a value containing any other disallowed character', () => {
    expect(isValidCallsignPrefixInput('FE.NZ')).toBe(false)
    expect(isValidCallsignPrefixInput('FE NZ')).toBe(false)
  })
})
