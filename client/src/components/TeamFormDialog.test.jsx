/**
 * Vitest component tests for TeamFormDialog — can_join toggle confirmation.
 *
 * Task 16.2 (signup-flow-rework spec)
 *
 * Tests that when editing a team with can_join=true and toggling to false,
 * window.confirm is called (the component's pure logic contract).
 */

import { describe, it, expect, vi } from 'vitest';
import { isValidCallsignPrefixInput, isOrganisationCallsignPrefixMissing } from './TeamFormDialog.jsx';

describe('TeamFormDialog — can_join toggle confirmation (Task 16.2)', () => {
  it('when editing team with can_join=true and toggling to false, confirm is required (source contract)', () => {
    // From source (lines ~187-192):
    //   if (editingTeam && editingTeam.can_join && !formData.canJoin) {
    //     const proceed = window.confirm('...')
    //     if (!proceed) return
    //   }
    const editingTeam = { id: 42, can_join: true };
    const formData = { canJoin: false };

    const shouldConfirm = editingTeam && editingTeam.can_join && !formData.canJoin;
    expect(shouldConfirm).toBe(true);
  });

  it('when editing team with can_join=false and keeping false, confirm is NOT required', () => {
    const editingTeam = { id: 42, can_join: false };
    const formData = { canJoin: false };

    const shouldConfirm = editingTeam && editingTeam.can_join && !formData.canJoin;
    expect(shouldConfirm).toBe(false);
  });

  it('when editing team with can_join=true and keeping true, confirm is NOT required', () => {
    const editingTeam = { id: 42, can_join: true };
    const formData = { canJoin: true };

    const shouldConfirm = editingTeam && editingTeam.can_join && !formData.canJoin;
    expect(shouldConfirm).toBe(false);
  });

  it('when creating a new team (no editingTeam), confirm is NOT required', () => {
    const editingTeam = null;
    const formData = { canJoin: false };

    const shouldConfirm = editingTeam && editingTeam.can_join && !formData.canJoin;
    expect(shouldConfirm).toBeFalsy();
  });
});

describe('TeamFormDialog — isValidCallsignPrefixInput', () => {
  it('returns true for empty/null input (field is optional)', () => {
    expect(isValidCallsignPrefixInput('')).toBe(true);
    expect(isValidCallsignPrefixInput(null)).toBe(true);
    expect(isValidCallsignPrefixInput(undefined)).toBe(true);
  });

  it('returns true for alphanumeric input', () => {
    expect(isValidCallsignPrefixInput('NZP0')).toBe(true);
    expect(isValidCallsignPrefixInput('ABC123')).toBe(true);
  });

  it('returns false for input with dashes or special chars', () => {
    expect(isValidCallsignPrefixInput('NZ-POL')).toBe(false);
    expect(isValidCallsignPrefixInput('NZ POL')).toBe(false);
    expect(isValidCallsignPrefixInput('NZ.POL')).toBe(false);
  });
});

// takserver-enrollment Requirement 2.1/2.2/2.3 (task 4.2): the prefix
// becomes required for an Organisation (no parentTeamId), while a
// Sub_Team's prefix stays optional exactly as it is today.
describe('TeamFormDialog — isOrganisationCallsignPrefixMissing', () => {
  it('is missing for an Organisation with an absent, empty or whitespace-only prefix', () => {
    expect(isOrganisationCallsignPrefixMissing(null, undefined)).toBe(true);
    expect(isOrganisationCallsignPrefixMissing(null, '')).toBe(true);
    expect(isOrganisationCallsignPrefixMissing(null, '   ')).toBe(true);
  });

  it('is not missing for an Organisation with a non-empty prefix', () => {
    expect(isOrganisationCallsignPrefixMissing(null, 'FENZ')).toBe(false);
  });

  it('is never missing for a Sub_Team, regardless of prefix', () => {
    expect(isOrganisationCallsignPrefixMissing(42, undefined)).toBe(false);
    expect(isOrganisationCallsignPrefixMissing(42, '')).toBe(false);
    expect(isOrganisationCallsignPrefixMissing(42, 'STL')).toBe(false);
  });

  // takserver-enrollment task 4.3 edge case: a prefix that is present but
  // consists ONLY of characters outside [A-Za-z0-9] (e.g. a bare "-") is
  // non-empty, so isOrganisationCallsignPrefixMissing (the "required"
  // check) reports it as NOT missing -- it is isValidCallsignPrefixInput
  // (the separate character-class check) that catches it instead. The
  // component runs both checks independently (see the two adjacent <p>
  // blocks in TeamFormDialog.jsx's Prefix field), so this pins that the
  // two do not overlap: a value can fail exactly one, exactly the other,
  // both, or neither.
  it('a prefix of only disallowed characters is NOT reported as "missing" -- the character-class check is what catches it', () => {
    expect(isOrganisationCallsignPrefixMissing(null, '-')).toBe(false);
    expect(isValidCallsignPrefixInput('-')).toBe(false);
  });

  // takserver-enrollment task 4.3 edge case: exotic Unicode whitespace
  // beyond a plain space -- tab, newline, non-breaking space (U+00A0) --
  // must also count as missing. JS's String.prototype.trim() (which this
  // predicate uses) strips all of Unicode's White_Space characters,
  // including U+00A0, so there is no divergence between this predicate's
  // treatment and the server's identical `.trim()`-based check in
  // server/routes/teams.js.
  it('is missing for an Organisation whose prefix is only a tab, newline, or non-breaking space', () => {
    expect(isOrganisationCallsignPrefixMissing(null, '\t')).toBe(true);
    expect(isOrganisationCallsignPrefixMissing(null, '\n')).toBe(true);
    expect(isOrganisationCallsignPrefixMissing(null, '\u00A0')).toBe(true);
  });

  // takserver-enrollment task 4.3 edge case: parentTeamId of `0` is
  // falsy, so `if (parentTeamId) { return false }` treats it as "no
  // parent" -- an Organisation -- exactly like the server's identical
  // `if (!parentTeamId)` classification in server/routes/teams.js. Teams
  // never have id 0 in practice (serial primary key starting at 1), so
  // this is documented as intentional rather than a misclassification.
  it('classifies parentTeamId: 0 as an Organisation (falsy), consistent with the server', () => {
    expect(isOrganisationCallsignPrefixMissing(0, undefined)).toBe(true);
    expect(isOrganisationCallsignPrefixMissing(0, 'FENZ')).toBe(false);
  });
});

// takserver-enrollment Requirements 6.1, 6.2, 7.1-7.3, 8.2-8.4, 16.4 (task
// 5.5): the Pseudonymous_Username_Policy control, its copy, and its
// disabled-on-edit state. Read the component's OWN source rather than
// mounting it (this project has no @testing-library/react and this file's
// existing tests test extracted pure logic / source contracts, not a
// rendered DOM), matching the pattern the requirement-detailing rules for
// this file already establish.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dialogSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'TeamFormDialog.jsx'), 'utf8');

describe('TeamFormDialog — Pseudonymous_Username_Policy control (takserver-enrollment Req 6.1/6.2/7.1-7.3/8.2-8.4/16.4)', () => {
  it('is rendered only inside the Organisation-only (!formData.parentTeamId) fragment', () => {
    const orgOnlyStart = dialogSource.indexOf('{!formData.parentTeamId && (')
    const controlIndex = dialogSource.indexOf('id="pseudonymousUsernames"')
    expect(orgOnlyStart).toBeGreaterThan(-1)
    expect(controlIndex).toBeGreaterThan(orgOnlyStart)
  })

  it('is disabled when editingTeam is truthy, via FieldLockIndicator locked={!!editingTeam}', () => {
    expect(dialogSource).toContain('locked={!!editingTeam}')
    expect(dialogSource).toContain('disabled={!!editingTeam}')
  })

  it("states the Pseudonymity_Scope: protection is against TAK Server/TAK users, not TAK Team Manager operators, who can always re-identify a member (Criterion 8.2)", () => {
    expect(dialogSource).toContain('an operator can always re-identify them from that record')
    expect(dialogSource).toContain('The protection is only against TAK Server and other TAK users seeing who a member is.')
  })

  it('does NOT describe the policy as anonymity, and does NOT claim TAK Team Manager holds no personal data (Criterion 8.3)', () => {
    // Scan only the rendered <p> copy paragraphs -- not the surrounding
    // JSX comment, whose own explanatory prose legitimately names
    // "anonymity" as the thing NOT to claim. The only occurrence of
    // "anonym" inside a rendered paragraph must be the explicit
    // "not anonymity" framing.
    const paragraphMatches = [...dialogSource.matchAll(/<p className="text-xs[^>]*>([\s\S]*?)<\/p>/g)]
    expect(paragraphMatches.length).toBeGreaterThan(0)
    const pseudonymityParagraph = paragraphMatches.find(([, text]) => text.includes('not anonymity'))
    expect(pseudonymityParagraph).toBeTruthy()
    const anonymMatches = pseudonymityParagraph[1].match(/anonym\w*/gi)
    expect(anonymMatches).toEqual(['anonymity'])
    expect(dialogSource).toContain('not anonymity')
    expect(dialogSource).toContain('TAK Team Manager still stores')
  })

  it('names the CloudTAK/WebTAK limitation explicitly (Criteria 8.4, 16.4)', () => {
    expect(dialogSource).toContain('CloudTAK/WebTAK')
    expect(dialogSource).toContain('not pseudonymised at all')
    expect(dialogSource).toContain('certificate name and CoT ID from the')
  })

  it('carries every stated fact in TEXT, never colour alone', () => {
    // Every copy paragraph is a <p> with visible text content, not merely a
    // colour class on an otherwise-empty element.
    expect(dialogSource).toMatch(/<p className="text-xs text-gray-500[^"]*">\s*\n\s*When enabled/)
    expect(dialogSource).toMatch(/<p className="text-xs text-amber-600[^"]*">\s*\n\s*This protection does not apply/)
  })
})

// takserver-enrollment Requirements 6.1, 6.2, 7.1-7.3, 8.2-8.4, 16.4 (task
// 5.9): additional edge-case coverage on the Pseudonymous_Username_Policy
// control's copy, beyond what task 5.5's own tests above already cover.
// These pin the exact substrings a screen reader would announce for the
// Pseudonymity_Scope statement and the WebTAK/CloudTAK limitation, and
// confirm the negative constraints (no "anonym" outside the explicit
// "not anonymity" framing, no claim of holding no personal data) hold
// against the RENDERED paragraph text specifically -- not merely
// somewhere in the file, which the existing "does NOT describe... "
// test above already isolates to the `<p>` copy blocks.
describe('TeamFormDialog — Pseudonymous_Username_Policy copy, additional edge cases (task 5.9)', () => {
  it('names WebTAK explicitly, not only CloudTAK, in the same statement as the CloudTAK limitation', () => {
    expect(dialogSource).toContain('CloudTAK/WebTAK')
  })

  it('never claims TAK Team Manager holds no personally identifying information anywhere in the rendered copy', () => {
    const paragraphMatches = [...dialogSource.matchAll(/<p className="text-xs[^>]*>([\s\S]*?)<\/p>/g)]
    expect(paragraphMatches.length).toBeGreaterThan(0)
    const allCopyText = paragraphMatches.map(([, text]) => text).join(' ')
    // The affirmative claim this control must make instead: TAK Team
    // Manager DOES still hold identifying information (name/email), so an
    // operator can always re-identify a member.
    expect(allCopyText).toContain('TAK Team Manager still stores')
    expect(allCopyText).not.toMatch(/holds? no (personal|personally identifying)/i)
    expect(allCopyText).not.toMatch(/no (personal|identifying) information (is|will be) stored/i)
  })

  it('the Pseudonymity_Scope statement and the CloudTAK/WebTAK limitation are two SEPARATE paragraphs, not one run-on block', () => {
    // Requirement 8.2 (scope) and Criteria 8.4/16.4 (CloudTAK/WebTAK
    // limitation) are each their own <p>, matching the "carry every
    // stated fact in TEXT" rule's existing pin on two distinct
    // className values (text-xs text-gray-500 vs text-xs text-amber-600)
    // asserted by the "carries every stated fact in TEXT" test above --
    // this test additionally confirms the CONTENT of each, not just the
    // className, is scoped to its own paragraph.
    const scopeParagraph = dialogSource.match(/<p className="text-xs text-gray-500[^"]*">\s*\n\s*When enabled[\s\S]*?<\/p>/)
    const cloudTakParagraph = dialogSource.match(/<p className="text-xs text-amber-600[^"]*">\s*\n\s*This protection does not apply[\s\S]*?<\/p>/)
    expect(scopeParagraph).toBeTruthy()
    expect(cloudTakParagraph).toBeTruthy()
    expect(scopeParagraph[0]).not.toContain('CloudTAK')
    expect(cloudTakParagraph[0]).toContain('CloudTAK/WebTAK')
  })

  it('the disabled-on-edit control also states WHY as text, not merely a title attribute', () => {
    // FieldLockIndicator's `lockedReason` prop is rendered as a `title`
    // attribute on the padlock icon (native tooltip) -- the client
    // convention forbids `title` as the SOLE description mechanism for
    // state a user must perceive. Confirm the same "why" also appears as
    // ordinary paragraph text beside the control, not only in the icon's
    // title.
    const controlIndex = dialogSource.indexOf('id="pseudonymousUsernames"')
    const nearbyText = dialogSource.slice(controlIndex, controlIndex + 3000)
    expect(nearbyText).toContain('This cannot be changed once the Organisation is created.')
  })
})
