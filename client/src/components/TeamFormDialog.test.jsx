/**
 * Vitest component tests for TeamFormDialog — can_join toggle confirmation.
 *
 * Task 16.2 (signup-flow-rework spec)
 *
 * Tests that when editing a team with can_join=true and toggling to false,
 * window.confirm is called (the component's pure logic contract).
 */

import { describe, it, expect, vi } from 'vitest';
import { isValidCallsignPrefixInput, isOrganisationCallsignPrefixMissing, buildTeamSubmitPayload, parentTeamCandidates } from './TeamFormDialog.jsx';

// Bugfix (#10): "Failed to update team: callsignLevelSelection can only be
// set on an Organisation" thrown on every edit of an existing Sub_Team, even
// with zero changes -- because formData.callsignLevelSelection/
// pseudonymousUsernames are ALWAYS seeded to a concrete value ([] and false)
// for a Sub_Team, never undefined/null, and the server's own guard treats
// "supplied" as `value !== undefined` (an empty array still counts).
describe('buildTeamSubmitPayload (bug #10: Sub_Team edit-with-no-changes regression)', () => {
  it('returns the formData object unchanged for an Organisation (no parentTeamId)', () => {
    const formData = { parentTeamId: null, callsignLevelSelection: [1, 2], pseudonymousUsernames: true, name: 'FENZ' }
    expect(buildTeamSubmitPayload(formData)).toEqual(formData)
  })

  it('omits callsignLevelSelection and pseudonymousUsernames entirely for a Sub_Team, rather than sending [] / false', () => {
    const formData = { parentTeamId: 42, callsignLevelSelection: [], pseudonymousUsernames: false, name: 'Southland' }
    const payload = buildTeamSubmitPayload(formData)
    expect(payload).not.toHaveProperty('callsignLevelSelection')
    expect(payload).not.toHaveProperty('pseudonymousUsernames')
    expect('callsignLevelSelection' in payload).toBe(false)
    expect('pseudonymousUsernames' in payload).toBe(false)
    expect(payload.name).toBe('Southland')
    expect(payload.parentTeamId).toBe(42)
  })

  it('a Sub_Team payload survives JSON.stringify with neither key present -- the actual wire shape sent to the server', () => {
    const formData = { parentTeamId: 42, callsignLevelSelection: [], pseudonymousUsernames: false, name: 'Southland' }
    const payload = buildTeamSubmitPayload(formData)
    const wire = JSON.parse(JSON.stringify(payload))
    expect(wire).not.toHaveProperty('callsignLevelSelection')
    expect(wire).not.toHaveProperty('pseudonymousUsernames')
  })

  // Foreign_Partner Organisation country prefix feature: countryCode is
  // Organisation-only, mirroring callsignLevelSelection/pseudonymousUsernames
  // immediately above -- the server rejects it outright on a Sub_Team.
  it('omits countryCode entirely for a Sub_Team, rather than sending an empty string', () => {
    const formData = { parentTeamId: 42, callsignLevelSelection: [], pseudonymousUsernames: false, countryCode: '' }
    const payload = buildTeamSubmitPayload(formData)
    expect(payload).not.toHaveProperty('countryCode')
  })

  it('keeps countryCode for an Organisation (no parentTeamId)', () => {
    const formData = { parentTeamId: null, callsignLevelSelection: [1, 2], pseudonymousUsernames: true, countryCode: 'FJI', name: 'Fiji Fire' }
    expect(buildTeamSubmitPayload(formData)).toEqual(formData)
  })

  // Callsign Team-segment separator toggle: callsignTeamHyphenated is
  // Organisation-only, mirroring countryCode immediately above -- the
  // server rejects it outright on a Sub_Team.
  it('omits callsignTeamHyphenated entirely for a Sub_Team, rather than sending false', () => {
    const formData = { parentTeamId: 42, callsignLevelSelection: [], pseudonymousUsernames: false, callsignTeamHyphenated: false }
    const payload = buildTeamSubmitPayload(formData)
    expect(payload).not.toHaveProperty('callsignTeamHyphenated')
  })

  it('keeps callsignTeamHyphenated for an Organisation (no parentTeamId)', () => {
    const formData = { parentTeamId: null, callsignLevelSelection: [1, 2], pseudonymousUsernames: true, callsignTeamHyphenated: true, name: 'FENZ' }
    expect(buildTeamSubmitPayload(formData)).toEqual(formData)
  })

  it('does not mutate the original formData object', () => {
    const formData = { parentTeamId: 42, callsignLevelSelection: [], pseudonymousUsernames: false }
    buildTeamSubmitPayload(formData)
    expect(formData).toHaveProperty('callsignLevelSelection')
    expect(formData).toHaveProperty('pseudonymousUsernames')
  })
});

// Bugfix (re-parent authorization gap, client-side follow-up): the
// "Parent Team" dropdown must not offer a destination the server would
// reject -- `team:update`'s row-scoped resolver now requires admin
// rights on the destination too (authorize.js), for anyone who isn't a
// Global_Manager.
describe('parentTeamCandidates (bugfix: re-parent dropdown filtering)', () => {
  const teamA = { id: 1, name: 'Alpha', can_manage: true }
  const teamB = { id: 2, name: 'Bravo', can_manage: false }
  const teamC = { id: 3, name: 'Charlie' } // can_manage entirely absent

  it('returns every candidate, unfiltered, for a Global_Manager', () => {
    expect(parentTeamCandidates([teamA, teamB, teamC], null, true)).toEqual([teamA, teamB, teamC])
  })

  it('filters to only can_manage: true candidates for a non-Global_Manager', () => {
    expect(parentTeamCandidates([teamA, teamB, teamC], null, false)).toEqual([teamA])
  })

  it('treats a MISSING can_manage field as not manageable (fail closed), for a non-Global_Manager', () => {
    expect(parentTeamCandidates([teamC], null, false)).toEqual([])
  })

  it('treats a truthy-but-not-strictly-true can_manage value as not manageable (strict === true check)', () => {
    expect(parentTeamCandidates([{ id: 4, name: 'Delta', can_manage: 1 }], null, false)).toEqual([])
  })

  it('excludes the team currently being edited, for both a Global_Manager and a non-Global_Manager', () => {
    const editingTeam = { id: 1 }
    expect(parentTeamCandidates([teamA, teamB], editingTeam, true)).toEqual([teamB])
    expect(parentTeamCandidates([teamA, teamB], editingTeam, false)).toEqual([])
  })

  it('does not exclude any team when creating (editingTeam is null)', () => {
    expect(parentTeamCandidates([teamA, teamB], null, true)).toEqual([teamA, teamB])
  })

  it('handles a null/undefined teams array without throwing', () => {
    expect(parentTeamCandidates(null, null, false)).toEqual([])
    expect(parentTeamCandidates(undefined, null, true)).toEqual([])
  })
});

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

  // Foreign-partner-prefix extension: a single internal hyphen (one or
  // more `-`-separated alphanumeric segments, e.g. "AUS-FIRE") is now
  // accepted by this CLIENT-SIDE check, mirroring
  // server/utils/callsignValidation.js's widened CALLSIGN_PREFIX_PATTERN.
  // The Managed_Identifier marker+body-shape rejection is server-side
  // only (see callsignValidation.js) and is not duplicated here.
  it('returns true for a single internal hyphen (a two-segment prefix)', () => {
    expect(isValidCallsignPrefixInput('NZ-POL')).toBe(true);
    expect(isValidCallsignPrefixInput('AUS-FIRE')).toBe(true);
  });

  it('returns false for a leading, trailing, or doubled hyphen, or other special chars', () => {
    expect(isValidCallsignPrefixInput('-NZ')).toBe(false);
    expect(isValidCallsignPrefixInput('NZ-')).toBe(false);
    expect(isValidCallsignPrefixInput('NZ--POL')).toBe(false);
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

  it('the INPUT is disabled when editingTeam is truthy, via disabled={!!editingTeam}', () => {
    expect(dialogSource).toContain('disabled={!!editingTeam}')
  })

  // Bugfix: the FieldLockIndicator ICON must state a fixed fact about the
  // field ("can this ever change once the Organisation exists"), the SAME
  // convention Prefix and TAK Color already follow with `locked={true}`
  // unconditionally -- never `locked={!!editingTeam}`, which would show a
  // green OPEN lock while creating (the field is still freely editable at
  // that point) directly beside text stating the value can never be
  // changed once created. Confirmed by walking FORWARD from THIS specific
  // control's id to the FIRST FieldLockIndicator after it (the restructure
  // moved the label/FieldLockIndicator/InfoTooltip AFTER the checkbox
  // element in source order), rather than a bare
  // dialogSource.toContain('locked={true}') (true elsewhere in the file
  // for Prefix/TAK Color already, which would pass vacuously).
  it('is locked unconditionally (locked={true}), never keyed to editingTeam, on its FieldLockIndicator', () => {
    const controlIndex = dialogSource.indexOf('id="pseudonymousUsernames"')
    const nearbyBlock = dialogSource.slice(controlIndex, controlIndex + 2600)
    const fieldLockIndicatorIndex = nearbyBlock.indexOf('<FieldLockIndicator')
    expect(fieldLockIndicatorIndex).toBeGreaterThan(-1)
    const indicatorBlock = nearbyBlock.slice(fieldLockIndicatorIndex, fieldLockIndicatorIndex + 200)
    expect(indicatorBlock).toContain('locked={true}')
    expect(indicatorBlock).not.toContain('locked={!!editingTeam}')
  })

  it("states the Pseudonymity_Scope: protection is against TAK Server/TAK users, not TAK Team Manager operators, who can always re-identify a member (Criterion 8.2)", () => {
    expect(dialogSource).toContain('an operator can always re-identify them from that record')
    expect(dialogSource).toContain('The protection is only against TAK Server and other TAK users seeing who a member is.')
  })

  it('does NOT describe the policy as anonymity, and does NOT claim TAK Team Manager holds no personal data (Criterion 8.3)', () => {
    // Bugfix (Edit Organisation modal restructure): this statement now
    // lives inside an <InfoTooltip text={...}> node rather than a
    // standalone <p> paragraph -- scan that node's own text instead.
    const tooltipIndex = dialogSource.indexOf('<InfoTooltip text={<>Each new member')
    expect(tooltipIndex).toBeGreaterThan(-1)
    const tooltipNodeEnd = dialogSource.indexOf('} />', tooltipIndex)
    const tooltipText = dialogSource.slice(tooltipIndex, tooltipNodeEnd)
    expect(tooltipText).toContain('not anonymity')
    expect(tooltipText).toContain('TAK Team Manager still stores')
    const anonymMatches = tooltipText.match(/anonym\w*/gi)
    expect(anonymMatches).toEqual(['anonymity'])
  })

  // The CloudTAK/WebTAK pseudonymity-defeat caveat this control used to
  // carry has been REMOVED: that defeat was fixed upstream in the
  // CloudTAK fork, which now builds the certificate Common Name/clientUid
  // and the CoT uid from the Authentik username rather than the email, so
  // a CloudTAK/WebTAK member is pseudonymised exactly like a native one.
  // Pinning the ABSENCE, not just skipping the old assertion, so a stale
  // caveat could not silently be reintroduced.
  it('no longer states a CloudTAK/WebTAK pseudonymity limitation -- that defeat has been fixed upstream', () => {
    expect(dialogSource).not.toContain('not pseudonymised at all')
    expect(dialogSource).not.toContain('This protection does not apply to members who connect via CloudTAK/WebTAK')
  })

  it('carries every stated fact in TEXT, never colour alone', () => {
    // The explanation is now real text passed as InfoTooltip's `text`
    // prop (a JSX node), not merely a colour class on an otherwise-empty
    // element -- InfoTooltip itself renders that text into the DOM
    // unconditionally (see InfoTooltip.jsx), so the fact is always
    // present as text regardless of hover/focus state.
    expect(dialogSource).toContain("<InfoTooltip text={<>Each new member's TAK username")
  })

  it('the disabled-on-edit control also states WHY as text, not merely a title attribute', () => {
    // FieldLockIndicator's `lockedReason` prop is rendered as a `title`
    // attribute on the padlock icon (native tooltip) -- the client
    // convention forbids `title` as the SOLE description mechanism for
    // state a user must perceive. Confirm the same "why" also appears as
    // ordinary text beside the control (now inside InfoTooltip's `text`
    // node), not only in the icon's title.
    const controlIndex = dialogSource.indexOf('id="pseudonymousUsernames"')
    const nearbyText = dialogSource.slice(controlIndex, controlIndex + 3200)
    expect(nearbyText).toContain('This cannot be changed once the Organisation is created.')
  })
})

// Bugfix (#11): a brand-new Organisation's default callsign format is
// "First Initial + Dot + Last Name" (first_initial_dot_last), not
// "Full Name" (full_name).
describe('TeamFormDialog — default callsignNameFormat for a new Organisation (bug #11)', () => {
  it("EMPTY_FORM_DATA's callsignNameFormat is 'first_initial_dot_last'", () => {
    const emptyFormDataIndex = dialogSource.indexOf('const EMPTY_FORM_DATA = {')
    expect(emptyFormDataIndex).toBeGreaterThan(-1)
    const emptyFormDataEnd = dialogSource.indexOf('\n}', emptyFormDataIndex)
    const emptyFormDataBlock = dialogSource.slice(emptyFormDataIndex, emptyFormDataEnd)
    expect(emptyFormDataBlock).toContain("callsignNameFormat: 'first_initial_dot_last'")
    expect(emptyFormDataBlock).not.toContain("callsignNameFormat: 'full_name'")
  })
})

// Foreign_Partner Organisation country prefix feature: an Organisation may
// carry an ISO 3166-1 alpha-3 country code, composed as the leading
// segment of the callsign prefix. Default is no country (domestic New
// Zealand); write-once after creation, mirroring the Prefix field's own
// immutability exactly. Source-contract checks, matching this file's
// established convention.
describe('TeamFormDialog — Foreign_Partner Organisation country prefix (Country field)', () => {
  it("EMPTY_FORM_DATA defaults countryCode to '' (domestic, no country)", () => {
    const emptyFormDataIndex = dialogSource.indexOf('const EMPTY_FORM_DATA = {')
    expect(emptyFormDataIndex).toBeGreaterThan(-1)
    const emptyFormDataEnd = dialogSource.indexOf('\n}', emptyFormDataIndex)
    const emptyFormDataBlock = dialogSource.slice(emptyFormDataIndex, emptyFormDataEnd)
    expect(emptyFormDataBlock).toContain("countryCode: ''")
  })

  it('seeds countryCode from team.country_code on edit, and forces it to \'\' for a Sub_Team', () => {
    expect(dialogSource).toContain("countryCode: team.parent_team_id ? '' : (team.country_code || '')")
  })

  it('defines countryLocked with the SAME condition as prefixLocked (write-once after Organisation creation)', () => {
    const prefixLockedIndex = dialogSource.indexOf('const prefixLocked = ')
    const countryLockedIndex = dialogSource.indexOf('const countryLocked = ')
    expect(prefixLockedIndex).toBeGreaterThan(-1)
    expect(countryLockedIndex).toBeGreaterThan(-1)
    expect(dialogSource).toContain('const prefixLocked = !!editingTeam && !formData.parentTeamId')
    expect(dialogSource).toContain('const countryLocked = !!editingTeam && !formData.parentTeamId')
  })

  it('renders the Country field only inside the Organisation-only (!formData.parentTeamId) fragment, never for a Sub_Team', () => {
    const countryLockedIndex = dialogSource.indexOf('const countryLocked = ')
    const countryFieldGateIndex = dialogSource.indexOf('{!formData.parentTeamId && (', countryLockedIndex)
    expect(countryFieldGateIndex).toBeGreaterThan(countryLockedIndex)
    // The gate immediately precedes the Country label, not some unrelated
    // Organisation-only fragment further down the file.
    const nextCountryLabelIndex = dialogSource.indexOf('Country', countryFieldGateIndex)
    const nextFieldLockIndicatorIndex = dialogSource.indexOf('FieldLockIndicator', countryFieldGateIndex)
    expect(nextCountryLabelIndex).toBeGreaterThan(countryFieldGateIndex)
    expect(nextFieldLockIndicatorIndex).toBeGreaterThan(nextCountryLabelIndex)
  })

  // Bugfix: Country and Prefix are Organisation-only fields that can
  // NEVER be changed once the Organisation exists (unlike a Sub_Team's
  // Prefix, which genuinely stays editable) -- the padlock ICON beside
  // each must therefore state that fixed fact unconditionally, the same
  // convention `pseudonymousUsernames` above already follows with
  // `locked={true}`. Passing `countryLocked`/`prefixLocked` straight
  // through was wrong: both are `false` while CREATING a brand-new
  // Organisation, which rendered a GREEN OPEN padlock directly beside
  // text stating the value is permanent once created -- the exact drift
  // already fixed for pseudonymousUsernames above. Confirmed by walking
  // FORWARD from each field's own label text to the first
  // FieldLockIndicator after it, matching that existing test's technique.
  it("Country's FieldLockIndicator is locked unconditionally (locked={true}), never keyed to countryLocked", () => {
    const countryLockedDefIndex = dialogSource.indexOf('const countryLocked = ')
    const countryLabelIndex = dialogSource.indexOf('Country', countryLockedDefIndex)
    expect(countryLabelIndex).toBeGreaterThan(countryLockedDefIndex)
    const nearbyBlock = dialogSource.slice(countryLabelIndex, countryLabelIndex + 2000)
    const fieldLockIndicatorIndex = nearbyBlock.indexOf('<FieldLockIndicator')
    expect(fieldLockIndicatorIndex).toBeGreaterThan(-1)
    const indicatorBlock = nearbyBlock.slice(fieldLockIndicatorIndex, fieldLockIndicatorIndex + 200)
    expect(indicatorBlock).toContain('locked={true}')
    expect(indicatorBlock).not.toContain('locked={countryLocked}')
  })

  it("an Organisation's Prefix FieldLockIndicator is locked unconditionally (locked={true}); a Sub_Team's stays keyed to prefixLocked", () => {
    const prefixLabelIndex = dialogSource.indexOf("Prefix{!formData.parentTeamId && ' *'}")
    expect(prefixLabelIndex).toBeGreaterThan(-1)
    const nearbyBlock = dialogSource.slice(prefixLabelIndex, prefixLabelIndex + 1200)
    const fieldLockIndicatorIndex = nearbyBlock.indexOf('<FieldLockIndicator')
    expect(fieldLockIndicatorIndex).toBeGreaterThan(-1)
    const indicatorBlock = nearbyBlock.slice(fieldLockIndicatorIndex, fieldLockIndicatorIndex + 200)
    // An Organisation always shows the RED closed lock; a Sub_Team keeps
    // the genuinely-conditional (green-capable) icon.
    expect(indicatorBlock).toContain('locked={formData.parentTeamId ? prefixLocked : true}')
    expect(indicatorBlock).not.toContain('locked={prefixLocked}\n')
  })

  it('the Country field sits before the Prefix field (country is the leading callsign segment)', () => {
    const countryFieldIndex = dialogSource.indexOf('Country')
    const prefixFieldIndex = dialogSource.indexOf("Prefix{!formData.parentTeamId && ' *'}")
    expect(countryFieldIndex).toBeGreaterThan(-1)
    expect(prefixFieldIndex).toBeGreaterThan(-1)
    expect(countryFieldIndex).toBeLessThan(prefixFieldIndex)
  })

  it('locked-state renders a read-only div (disabled inputs), unlocked-state renders a search input plus a <select>', () => {
    const countryLockedIndex = dialogSource.indexOf('const countryLocked = ')
    const countryFieldGateIndex = dialogSource.indexOf('{!formData.parentTeamId && (', countryLockedIndex)
    const parentFieldIndex = dialogSource.indexOf('Parent Team', countryFieldGateIndex)
    const countryFieldBlock = dialogSource.slice(countryFieldGateIndex, parentFieldIndex)

    expect(countryFieldBlock).toContain('countryLocked ? (')
    expect(countryFieldBlock).toContain("id=\"team-country-select\"")
    expect(countryFieldBlock).toContain('value={countrySearch}')
    expect(countryFieldBlock).toContain('Domestic (New Zealand)')
  })

  it('imports getCountry and filterCountries from utils/isoCountry', () => {
    expect(dialogSource).toContain("import { getCountry, filterCountries } from '../utils/isoCountry'")
  })

  it('clears the country selection if a search narrows the list to exclude the currently-selected country (mirrors TransferMemberDialog\'s destination-search safety net)', () => {
    expect(dialogSource).toContain('filterCountries(countrySearch).some((c) => c.alpha3 === formData.countryCode)')
    expect(dialogSource).toContain("setFormData((prev) => ({ ...prev, countryCode: '' }))")
  })
})

// Callsign Team-segment separator toggle: an Organisation may opt into
// hyphenating its Team segment (each selected/present Team-Depth level
// joined with a '-' instead of the pre-existing no-separator
// concatenation). Organisation-only, defaulting to false (unchanged
// behaviour); freely editable at any time (unlike Country/Prefix), so
// its FieldLockIndicator is unconditionally `locked={false}`, matching
// Callsign Level Selection's own unconditional icon immediately above
// it. Source-contract checks, matching this file's established
// convention.
describe('TeamFormDialog — Callsign Team-segment separator toggle (callsignTeamHyphenated)', () => {
  it("EMPTY_FORM_DATA defaults callsignTeamHyphenated to false (no separator, unchanged behaviour)", () => {
    const emptyFormDataIndex = dialogSource.indexOf('const EMPTY_FORM_DATA = {')
    expect(emptyFormDataIndex).toBeGreaterThan(-1)
    const emptyFormDataEnd = dialogSource.indexOf('\n}', emptyFormDataIndex)
    const emptyFormDataBlock = dialogSource.slice(emptyFormDataIndex, emptyFormDataEnd)
    expect(emptyFormDataBlock).toContain('callsignTeamHyphenated: false')
  })

  it('seeds callsignTeamHyphenated from team.callsign_team_hyphenated on edit, and forces it to false for a Sub_Team', () => {
    expect(dialogSource).toContain('callsignTeamHyphenated: team.parent_team_id ? false : Boolean(team.callsign_team_hyphenated)')
  })

  it('renders the toggle only inside the Organisation-only (!formData.parentTeamId) fragment, never for a Sub_Team', () => {
    const controlIndex = dialogSource.indexOf('id="callsignTeamHyphenated"')
    expect(controlIndex).toBeGreaterThan(-1)
    // Walk backward from the control to the nearest preceding
    // Organisation-only gate, and confirm it is the one that actually
    // wraps this control (no unrelated `{!formData.parentTeamId && (`
    // gate sits between the two).
    const precedingSource = dialogSource.slice(0, controlIndex)
    const lastGateIndex = precedingSource.lastIndexOf('{!formData.parentTeamId && (')
    expect(lastGateIndex).toBeGreaterThan(-1)
    const gateToControl = dialogSource.slice(lastGateIndex, controlIndex)
    // No closing of that fragment (`)}` at the same nesting level) before
    // reaching the control -- a loose but effective proxy given this
    // file's existing structural-check conventions (exact JSX AST
    // parsing is not done anywhere else in this file either).
    expect(gateToControl).not.toContain('\n              )}\n')
  })

  it('sits inside the Callsign Structure section, after Callsign Level Selection and before Callsign Name Format', () => {
    const levelSelectionIndex = dialogSource.indexOf('Callsign Level Selection')
    const toggleIndex = dialogSource.indexOf('id="callsignTeamHyphenated"')
    const nameFormatIndex = dialogSource.indexOf('Callsign Name Format')
    expect(levelSelectionIndex).toBeGreaterThan(-1)
    expect(toggleIndex).toBeGreaterThan(-1)
    expect(nameFormatIndex).toBeGreaterThan(-1)
    expect(toggleIndex).toBeGreaterThan(levelSelectionIndex)
    expect(toggleIndex).toBeLessThan(nameFormatIndex)
  })

  // The padlock ICON must state a fixed fact: this field is freely
  // editable at any time (unlike Country/Prefix, which are permanent
  // once an Organisation exists) -- unconditionally `locked={false}`,
  // never keyed to editingTeam/countryLocked/prefixLocked.
  it('is unlocked unconditionally (locked={false}), on its FieldLockIndicator', () => {
    const controlIndex = dialogSource.indexOf('id="callsignTeamHyphenated"')
    const nearbyBlock = dialogSource.slice(controlIndex, controlIndex + 800)
    const fieldLockIndicatorIndex = nearbyBlock.indexOf('<FieldLockIndicator')
    expect(fieldLockIndicatorIndex).toBeGreaterThan(-1)
    const indicatorBlock = nearbyBlock.slice(fieldLockIndicatorIndex, fieldLockIndicatorIndex + 200)
    expect(indicatorBlock).toContain('locked={false}')
  })

  it('is a whole-row clickable <label>, mirroring the pseudonymousUsernames/canJoin checkbox row convention', () => {
    const labelIndex = dialogSource.indexOf('htmlFor="callsignTeamHyphenated"')
    expect(labelIndex).toBeGreaterThan(-1)
    const precedingBlock = dialogSource.slice(Math.max(0, labelIndex - 50), labelIndex)
    expect(precedingBlock).toContain('<label')
    const followingBlock = dialogSource.slice(labelIndex, labelIndex + 200)
    expect(followingBlock).toContain('cursor-pointer')
  })

  it('buildTeamSubmitPayload drops callsignTeamHyphenated for a Sub_Team (already covered directly in the buildTeamSubmitPayload describe block above, restated here as a source-contract cross-check)', () => {
    expect(dialogSource).toContain('delete payload.callsignTeamHyphenated')
  })
})

// Bugfix (#12): a checkmark icon inside a selected Callsign Level
// Selection toggle button, so selected items are distinguishable at a
// glance rather than only by a subtle background-colour change.
// Bugfix (mobile tap targets too small): the Callsign Level Selection
// pills were px-3 py-1 on text-xs -- roughly a ~24px-tall pill, well
// under the ~36-40px floor. py-2.5 brings this to a real tap target
// while keeping the compact px-3 horizontal padding several pills per
// row need.
describe('TeamFormDialog — Callsign Level Selection pill tap target (mobile tap-target bugfix)', () => {
  it('uses py-2.5 (was py-1) on the toggle pill', () => {
    const toggleButtonIndex = dialogSource.indexOf('formatLevelLabel(depth, prefixesForDepth)')
    expect(toggleButtonIndex).toBeGreaterThan(-1)
    const precedingBlock = dialogSource.slice(Math.max(0, toggleButtonIndex - 600), toggleButtonIndex)
    expect(precedingBlock).toContain('px-3 py-2.5')
    expect(precedingBlock).not.toContain('px-3 py-1 ')
  })
})

// Bugfix (mobile tap targets too small): both checkboxes' outer element
// is now the <label> itself (was a plain <div> with the checkbox and a
// separate <label> as siblings) -- clicking ANYWHERE in the row, not
// just the bare 16px checkbox square, now toggles the field.
describe('TeamFormDialog — checkbox rows are fully clickable <label>s (mobile tap-target bugfix)', () => {
  it('"Allow join requests": the outer element is a <label htmlFor="canJoin"> wrapping both the input and its text', () => {
    const labelIndex = dialogSource.indexOf('<label htmlFor="canJoin"')
    expect(labelIndex).toBeGreaterThan(-1)
    const inputIndex = dialogSource.indexOf('id="canJoin"', labelIndex)
    expect(inputIndex).toBeGreaterThan(labelIndex)
    const labelLine = dialogSource.slice(labelIndex, dialogSource.indexOf('>', labelIndex))
    expect(labelLine).toContain('-m-2 p-2')
    expect(labelLine).toContain('cursor-pointer')
  })

  it('"Allow join requests": stops click propagation on its FieldLockIndicator/InfoTooltip icons so tapping them does not toggle the checkbox', () => {
    const labelIndex = dialogSource.indexOf('<label htmlFor="canJoin"')
    const nextSectionIndex = dialogSource.indexOf('Pseudonymous_Username_Policy control', labelIndex)
    const block = dialogSource.slice(labelIndex, nextSectionIndex)
    expect(block).toContain('onClick={(e) => e.stopPropagation()}')
  })

  it('"pseudonymousUsernames": the outer element is a <label htmlFor="pseudonymousUsernames"> wrapping both the input and its text', () => {
    const labelIndex = dialogSource.indexOf('<label\n                  htmlFor="pseudonymousUsernames"')
    expect(labelIndex).toBeGreaterThan(-1)
    const inputIndex = dialogSource.indexOf('id="pseudonymousUsernames"', labelIndex)
    expect(inputIndex).toBeGreaterThan(labelIndex)
    const labelBlock = dialogSource.slice(labelIndex, inputIndex)
    expect(labelBlock).toContain('-m-2 p-2')
  })

  it('"pseudonymousUsernames": uses cursor-not-allowed (not cursor-pointer) on the label when editingTeam disables the input', () => {
    const labelIndex = dialogSource.indexOf('<label\n                  htmlFor="pseudonymousUsernames"')
    const classNameEnd = dialogSource.indexOf('>', dialogSource.indexOf('className', labelIndex))
    const classNameBlock = dialogSource.slice(labelIndex, classNameEnd)
    expect(classNameBlock).toContain("editingTeam ? 'cursor-not-allowed'")
  })

  it('"pseudonymousUsernames": stops click propagation on its FieldLockIndicator/InfoTooltip icons', () => {
    const controlIndex = dialogSource.indexOf('id="pseudonymousUsernames"')
    const nearbyBlock = dialogSource.slice(controlIndex, controlIndex + 2600)
    expect(nearbyBlock).toContain('onClick={(e) => e.stopPropagation()}')
  })

  // Bugfix (tooltip see-through): the disabled-look dimming
  // (`opacity-50` while editingTeam, matching the checkbox `input`'s own
  // `disabled:opacity-50`) must apply to ONLY the label text, never to
  // an ancestor of the FieldLockIndicator/InfoTooltip icons -- CSS
  // opacity compounds through descendants, so an opacity-reduced
  // ancestor would make the InfoTooltip's disclosed popup translucent
  // too (letting whatever sits behind it, e.g. the "Allow join
  // requests" row above, show through), unlike every other InfoTooltip
  // on this page.
  it('"pseudonymousUsernames": the opacity-50 dimming wraps only the label text, not the icon/tooltip span (tooltip see-through bugfix)', () => {
    const controlIndex = dialogSource.indexOf('id="pseudonymousUsernames"')
    const labelTextSpanIndex = dialogSource.indexOf('Give new members usernames that carry no personal information', controlIndex)
    const dimmedSpanStart = dialogSource.lastIndexOf('<span className={editingTeam', labelTextSpanIndex)
    expect(dimmedSpanStart).toBeGreaterThan(controlIndex)
    const dimmedSpanEnd = dialogSource.indexOf('</span>', labelTextSpanIndex)
    const dimmedSpanBlock = dialogSource.slice(dimmedSpanStart, dimmedSpanEnd)

    // The dimmed span closes (its own </span>) BEFORE the icon/tooltip
    // span opens -- i.e. FieldLockIndicator/InfoTooltip are siblings of
    // the dimmed span, not descendants of it.
    const iconSpanIndex = dialogSource.indexOf('<span onClick={(e) => e.stopPropagation()}', dimmedSpanEnd)
    expect(iconSpanIndex).toBeGreaterThan(dimmedSpanEnd)
    expect(dimmedSpanBlock).not.toContain('FieldLockIndicator')
    expect(dimmedSpanBlock).not.toContain('InfoTooltip')

    // The outer wrapping <span> around the whole label+icons group no
    // longer itself carries the opacity toggle -- only the inner one does.
    const outerSpanIndex = dialogSource.lastIndexOf('<span className="ml-3 text-sm font-medium', dimmedSpanStart)
    expect(outerSpanIndex).toBeGreaterThan(controlIndex)
    const outerSpanTagEnd = dialogSource.indexOf('>', outerSpanIndex)
    expect(dialogSource.slice(outerSpanIndex, outerSpanTagEnd)).not.toContain('opacity-50')
  })
})

describe('TeamFormDialog — Callsign Level Selection checkmark on selected items (bug #12)', () => {
  it('imports CheckIcon from heroicons', () => {
    const importLineIndex = dialogSource.indexOf("from '@heroicons/react/24/outline'")
    const importLine = dialogSource.slice(Math.max(0, importLineIndex - 200), importLineIndex)
    expect(importLine).toContain('CheckIcon')
  })

  it('renders CheckIcon conditionally on `selected` inside the Callsign Level Selection toggle button', () => {
    const toggleButtonIndex = dialogSource.indexOf('formatLevelLabel(depth, prefixesForDepth)')
    expect(toggleButtonIndex).toBeGreaterThan(-1)
    const precedingBlock = dialogSource.slice(Math.max(0, toggleButtonIndex - 400), toggleButtonIndex)
    expect(precedingBlock).toContain('{selected && <CheckIcon')
  })
})

// Allowed Email Domains (OrgDomainManager), moved here from its own
// standalone card on TeamDetail.jsx. Nested VISUALLY only -- it keeps its
// own independent fetch/save, decoupled from this dialog's own single
// `teamsAPI.update(...)` submit. Source-contract checks, matching this
// file's existing convention.
describe('TeamFormDialog — nested OrgDomainManager (Allowed Email Domains)', () => {
  it('imports OrgDomainManager', () => {
    expect(dialogSource).toContain("import OrgDomainManager from './OrgDomainManager'")
  })

  it('renders OrgDomainManager only when editing (editingTeam truthy), only for an Organisation (!formData.parentTeamId), and only while the domains tab is active', () => {
    const gateIndex = dialogSource.indexOf("{editingTeam && !formData.parentTeamId && activeFormTab === 'domains' && (")
    expect(gateIndex).toBeGreaterThan(-1)
    const nearbyBlock = dialogSource.slice(gateIndex, gateIndex + 300)
    expect(nearbyBlock).toContain('<OrgDomainManager')
  })

  it('renders OrgDomainManager AFTER the main form\'s closing </form> tag -- its own tab, not inside the submit flow', () => {
    const formEndIndex = dialogSource.lastIndexOf('</form>')
    const gateIndex = dialogSource.indexOf("{editingTeam && !formData.parentTeamId && activeFormTab === 'domains' && (")
    expect(formEndIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeGreaterThan(formEndIndex)
  })

  it('passes orgId={editingTeam.id} and isAdmin={isAdmin} through to OrgDomainManager, not folded into formData or doSubmit', () => {
    const orgDomainManagerIndex = dialogSource.indexOf('<OrgDomainManager')
    expect(orgDomainManagerIndex).toBeGreaterThan(-1)
    const propsBlock = dialogSource.slice(orgDomainManagerIndex, orgDomainManagerIndex + 150)
    expect(propsBlock).toContain('orgId={editingTeam.id}')
    expect(propsBlock).toContain('isAdmin={isAdmin}')
  })

  it('accepts an isAdmin prop defaulting to true, so Teams.jsx\'s call site (which never passes it) still shows the nested manager', () => {
    expect(dialogSource).toMatch(/isAdmin\s*=\s*true/)
  })

  // Bug #13: "Allowed Email Domains" moves into its own TAB inside the
  // Edit Organisation modal, rather than a nested section beneath the
  // main form.
  describe('Allowed Email Domains tab (bug #13)', () => {
    it('renders a tab bar with "Team Settings" and "Allowed Email Domains" tabs, gated the same way the domains section itself was', () => {
      const tabBarGateIndex = dialogSource.indexOf('{editingTeam && !formData.parentTeamId && (')
      expect(tabBarGateIndex).toBeGreaterThan(-1)
      const tabBarBlock = dialogSource.slice(tabBarGateIndex, tabBarGateIndex + 1600)
      expect(tabBarBlock).toContain('Team Settings')
      expect(tabBarBlock).toContain('Allowed Email Domains')
      expect(tabBarBlock).toContain("setActiveFormTab('settings')")
      expect(tabBarBlock).toContain("setActiveFormTab('domains')")
    })

    it('resets activeFormTab to \'settings\' in the seeding effect, so a stale domains-tab selection never survives a team switch', () => {
      const effectIndex = dialogSource.indexOf('useEffect(() => {')
      const effectEnd = dialogSource.indexOf('[isOpen, mode, team])')
      expect(effectIndex).toBeGreaterThan(-1)
      expect(effectEnd).toBeGreaterThan(effectIndex)
      const effectBody = dialogSource.slice(effectIndex, effectEnd)
      expect(effectBody).toContain("setActiveFormTab('settings')")
    })

    it('hides (not unmounts) the main form via a `hidden` attribute while the domains tab is active, rather than conditionally rendering it', () => {
      expect(dialogSource).toContain("hidden={editingTeam && !formData.parentTeamId && activeFormTab !== 'settings'}")
    })

    it('declares the activeFormTab state, defaulting to settings', () => {
      expect(dialogSource).toContain("useState('settings')")
    })
  })

  it('never merges OrgDomainManager\'s domains into formData or into the doSubmit/teamsAPI.update call', () => {
    expect(dialogSource).not.toContain('formData.domains')
    expect(dialogSource).not.toContain('allowedDomains: formData')
    // doSubmit's own body must not reference orgDomainsAPI at all -- that
    // save stays entirely inside OrgDomainManager's own independent
    // fetch/save cycle.
    const doSubmitIndex = dialogSource.indexOf('const doSubmit = async')
    expect(doSubmitIndex).toBeGreaterThan(-1)
    const doSubmitEnd = dialogSource.indexOf('\n  }', doSubmitIndex)
    const doSubmitBody = dialogSource.slice(doSubmitIndex, doSubmitEnd > -1 ? doSubmitEnd : doSubmitIndex + 800)
    expect(doSubmitBody).not.toContain('orgDomainsAPI')
    expect(doSubmitBody).not.toContain('OrgDomainManager')
  })
})

// Edit Organisation modal restructure: fields are now grouped under four
// named sections (Identity, Callsign Structure, Membership Policy,
// Description) rather than the old two arbitrary height-balanced
// columns, and every field carries an InfoTooltip alongside its
// FieldLockIndicator.
describe('TeamFormDialog — Team Settings tab restructure into named sections', () => {
  it('imports InfoTooltip and renders a SectionHeading for each of the four sections, in order', () => {
    expect(dialogSource).toContain("import InfoTooltip from './InfoTooltip'")

    const identityIndex = dialogSource.indexOf('<SectionHeading>Identity</SectionHeading>')
    const callsignIndex = dialogSource.indexOf('<SectionHeading>Callsign Structure</SectionHeading>')
    const membershipIndex = dialogSource.indexOf('<SectionHeading>Membership Policy</SectionHeading>')
    const descriptionIndex = dialogSource.indexOf('<SectionHeading>Description</SectionHeading>')

    expect(identityIndex).toBeGreaterThan(-1)
    expect(callsignIndex).toBeGreaterThan(identityIndex)
    expect(membershipIndex).toBeGreaterThan(callsignIndex)
    expect(descriptionIndex).toBeGreaterThan(membershipIndex)
  })

  it('groups Team Name, Prefix and Parent Team under Identity', () => {
    const identityIndex = dialogSource.indexOf('<SectionHeading>Identity</SectionHeading>')
    const callsignIndex = dialogSource.indexOf('<SectionHeading>Callsign Structure</SectionHeading>')
    const identitySection = dialogSource.slice(identityIndex, callsignIndex)
    expect(identitySection).toContain('Team Name *')
    expect(identitySection).toContain('Prefix{!formData.parentTeamId')
    expect(identitySection).toContain('Parent Team')
  })

  it('groups Callsign Level Selection, Callsign Name Format and TAK Colour under Callsign Structure', () => {
    const callsignIndex = dialogSource.indexOf('<SectionHeading>Callsign Structure</SectionHeading>')
    const membershipIndex = dialogSource.indexOf('<SectionHeading>Membership Policy</SectionHeading>')
    const callsignSection = dialogSource.slice(callsignIndex, membershipIndex)
    expect(callsignSection).toContain('Callsign Level Selection')
    expect(callsignSection).toContain('Callsign Name Format')
    expect(callsignSection).toContain('TAK Colour')
  })

  it('groups Visibility, Allow join requests and Pseudonymous Usernames under Membership Policy', () => {
    const membershipIndex = dialogSource.indexOf('<SectionHeading>Membership Policy</SectionHeading>')
    const descriptionIndex = dialogSource.indexOf('<SectionHeading>Description</SectionHeading>')
    const membershipSection = dialogSource.slice(membershipIndex, descriptionIndex)
    expect(membershipSection).toContain('Visibility')
    expect(membershipSection).toContain('Allow join requests')
    expect(membershipSection).toContain('id="pseudonymousUsernames"')
  })

  it('every InfoTooltip usage passes a non-empty text prop', () => {
    const tooltipUsages = [...dialogSource.matchAll(/<InfoTooltip\s/g)]
    expect(tooltipUsages.length).toBeGreaterThanOrEqual(9)
  })
})

// region-channel-tiers: the third "Channel Access" tab, gated STRICTER
// than the "Allowed Email Domains" tab -- it must be invisible to a
// Team_Admin who is not also a Global_Manager, unlike Allowed Email
// Domains which a Team_Admin can see. Source-contract checks, matching
// this file's existing convention for TeamFormDialog's other tabs.
describe('TeamFormDialog — nested ChannelAccessManager (Channel Access tab)', () => {
  it('imports ChannelAccessManager', () => {
    expect(dialogSource).toContain("import ChannelAccessManager from './ChannelAccessManager'")
  })

  it('accepts an isGlobalManager prop defaulting to true, so a call site that never passes it still shows the tab', () => {
    expect(dialogSource).toMatch(/isGlobalManager\s*=\s*true/)
  })

  it('renders the "Channel Access" tab button only when isGlobalManager is true, alongside the two other tabs', () => {
    const tabBarGateIndex = dialogSource.indexOf('{editingTeam && !formData.parentTeamId && (')
    expect(tabBarGateIndex).toBeGreaterThan(-1)
    const tabBarBlock = dialogSource.slice(tabBarGateIndex, tabBarGateIndex + 2600)
    expect(tabBarBlock).toContain('{isGlobalManager && (')
    expect(tabBarBlock).toContain("setActiveFormTab('channelAccess')")
    expect(tabBarBlock).toContain('Channel Access')
  })

  it('gates the tab button STRICTER than the domains tab: isGlobalManager alone, with no isAdmin/Team_Admin fallback in the same condition', () => {
    const channelAccessButtonIndex = dialogSource.indexOf("setActiveFormTab('channelAccess')")
    expect(channelAccessButtonIndex).toBeGreaterThan(-1)
    // Walk back to the nearest gating condition wrapping this button.
    const precedingBlock = dialogSource.slice(Math.max(0, channelAccessButtonIndex - 300), channelAccessButtonIndex)
    const gateIndex = precedingBlock.lastIndexOf('{isGlobalManager && (')
    expect(gateIndex).toBeGreaterThan(-1)
    // Nothing between the gate and the button ORs in isAdmin/isTeamAdmin.
    const gateToButton = precedingBlock.slice(gateIndex)
    expect(gateToButton).not.toContain('isAdmin')
    expect(gateToButton).not.toContain('isTeamAdmin')
  })

  it('renders ChannelAccessManager only when editing (editingTeam truthy), only for an Organisation (!formData.parentTeamId), only for a Global_Manager, and only while the channelAccess tab is active', () => {
    const gateIndex = dialogSource.indexOf(
      "{editingTeam && !formData.parentTeamId && isGlobalManager && activeFormTab === 'channelAccess' && ("
    )
    expect(gateIndex).toBeGreaterThan(-1)
    const nearbyBlock = dialogSource.slice(gateIndex, gateIndex + 300)
    expect(nearbyBlock).toContain('<ChannelAccessManager')
  })

  it('renders ChannelAccessManager AFTER the main form\'s closing </form> tag -- its own tab, not inside the submit flow', () => {
    const formEndIndex = dialogSource.lastIndexOf('</form>')
    const gateIndex = dialogSource.indexOf(
      "{editingTeam && !formData.parentTeamId && isGlobalManager && activeFormTab === 'channelAccess' && ("
    )
    expect(formEndIndex).toBeGreaterThan(-1)
    expect(gateIndex).toBeGreaterThan(formEndIndex)
  })

  it('passes org={editingTeam} (the stored team row, not formData) and isGlobalManager/onSaved through to ChannelAccessManager', () => {
    const componentIndex = dialogSource.indexOf('<ChannelAccessManager')
    expect(componentIndex).toBeGreaterThan(-1)
    const propsBlock = dialogSource.slice(componentIndex, componentIndex + 200)
    expect(propsBlock).toContain('org={editingTeam}')
    expect(propsBlock).toContain('isGlobalManager={isGlobalManager}')
    expect(propsBlock).toContain('onSaved={onSaved}')
    expect(propsBlock).not.toContain('org={formData}')
  })

  it('resets activeFormTab to \'settings\' in the seeding effect, so a stale channelAccess-tab selection never survives a team switch (shared reset with the domains tab)', () => {
    const effectIndex = dialogSource.indexOf('useEffect(() => {')
    const effectEnd = dialogSource.indexOf('[isOpen, mode, team])')
    expect(effectIndex).toBeGreaterThan(-1)
    expect(effectEnd).toBeGreaterThan(effectIndex)
    const effectBody = dialogSource.slice(effectIndex, effectEnd)
    expect(effectBody).toContain("setActiveFormTab('settings')")
  })

  it('hides (not unmounts) the main form while the channelAccess tab is active too, via the same shared `hidden` condition as the domains tab', () => {
    expect(dialogSource).toContain("hidden={editingTeam && !formData.parentTeamId && activeFormTab !== 'settings'}")
  })
})

// Bugfix: the Cancel/Update footer used to live INSIDE the Team Settings
// <form>, which is hidden (not unmounted) while a different tab is
// active -- so switching to "Allowed Email Domains" or "Channel Access"
// hid the only way to close or save the dialog at all.
describe('TeamFormDialog — Cancel/Update footer visible on every tab (bugfix)', () => {
  it('gives the Team Settings <form> an id, and targets the submit button at it via the `form` attribute rather than nesting the button inside it', () => {
    expect(dialogSource).toContain('<form id="team-settings-form" onSubmit={handleSubmit}')
    expect(dialogSource).toContain('form="team-settings-form"')
  })

  it('renders the Cancel/Update footer AFTER the hidden main-form wrapper\'s closing </div>, not inside it', () => {
    const hiddenDivOpenIndex = dialogSource.indexOf("hidden={editingTeam && !formData.parentTeamId && activeFormTab !== 'settings'}")
    expect(hiddenDivOpenIndex).toBeGreaterThan(-1)
    const formEndIndex = dialogSource.indexOf('</form>', hiddenDivOpenIndex)
    const hiddenDivCloseIndex = dialogSource.indexOf('</div>', formEndIndex)
    const footerIndex = dialogSource.indexOf('form="team-settings-form"')
    expect(footerIndex).toBeGreaterThan(hiddenDivCloseIndex)
  })

  it('renders exactly one Cancel button and one submit button wired to the Team Settings form, regardless of which tab is active', () => {
    // The footer itself carries no `hidden`/tab-conditional wrapper of
    // its own -- it is a plain sibling <div>, unlike the domains/
    // channelAccess panels above it which ARE tab-gated.
    const footerBlockStart = dialogSource.indexOf('Cancel/Update footer, moved OUTSIDE')
    expect(footerBlockStart).toBeGreaterThan(-1)
    const footerBlockEnd = dialogSource.indexOf('Disable join requests confirmation modal')
    const footerBlock = dialogSource.slice(footerBlockStart, footerBlockEnd)
    expect(footerBlock).not.toMatch(/activeFormTab ===/)
    // The submit button in this footer is wired to the Team Settings
    // form via the `form` attribute on the SAME element as its own
    // `type="submit"`.
    expect(footerBlock).toMatch(/type="submit"\s+form="team-settings-form"/)
  })
})

// Bugfix: three InfoTooltips sitting in the RIGHT-hand column of a
// two-column grid (Parent Team, TAK Colour, Allow join requests) opened
// rightward by default, pushing their w-64 popup past the modal's right
// edge -- the wrapper's `overflow-y-auto`-only styling computes
// `overflow-x: auto` implicitly (CSS: one axis non-visible forces the
// other to `auto`, never staying `visible`), so this manifested as a
// persistent horizontal scrollbar on the Team Settings tab.
describe('TeamFormDialog — trailing-column InfoTooltips open leftward (bugfix: unwanted horizontal scrollbar)', () => {
  it('opens the Parent Team tooltip leftward (side="left")', () => {
    const index = dialogSource.indexOf('Select a parent team to make this a Sub-team')
    expect(index).toBeGreaterThan(-1)
    const nearby = dialogSource.slice(index, index + 200)
    expect(nearby).toContain('side="left"')
  })

  it('opens the TAK Colour tooltip leftward (side="left")', () => {
    const index = dialogSource.indexOf('The TAK colour designation for this')
    expect(index).toBeGreaterThan(-1)
    const nearby = dialogSource.slice(index, index + 250)
    expect(nearby).toContain('side="left"')
  })

  it('opens the Allow join requests tooltip leftward (side="left")', () => {
    const index = dialogSource.indexOf('Lets users request to join this team')
    expect(index).toBeGreaterThan(-1)
    const nearby = dialogSource.slice(index, index + 200)
    expect(nearby).toContain('side="left"')
  })

  it('leaves the left-hand-column tooltips (Team Name, Prefix) opening rightward (the default, no side prop)', () => {
    const nameIndex = dialogSource.indexOf('The name shown throughout the app for this team')
    const prefixIndex = dialogSource.indexOf('The Sub-team segment of generated callsigns')
    expect(nameIndex).toBeGreaterThan(-1)
    expect(prefixIndex).toBeGreaterThan(-1)
    expect(dialogSource.slice(nameIndex, nameIndex + 100)).not.toContain('side=')
    expect(dialogSource.slice(prefixIndex, prefixIndex + 250)).not.toContain('side=')
  })
})

// Bugfix: switching between the Team Settings / Allowed Email Domains /
// Channel Access tabs used to resize AND reposition the whole modal,
// since the outer box's height was content-driven (`max-h-[90vh]` plus
// `overflow-y-auto` on that SAME element) and each tab's panel has a
// very different content height. The outer box now has a FIXED height
// (`h-[85vh]`) and only an inner wrapper between the tab bar and the
// footer scrolls, so the header/tab bar/footer never move regardless of
// which tab's content is showing.
describe('TeamFormDialog — modal size/position stable across tabs (bugfix)', () => {
  it('gives the outer dialog box a fixed height (sm: and up) and a column flex layout, not a content-driven max-height', () => {
    const outerBoxIndex = dialogSource.indexOf('bg-white dark:bg-gray-800 shadow-xl w-full h-full')
    expect(outerBoxIndex).toBeGreaterThan(-1)
    const outerBoxLine = dialogSource.slice(outerBoxIndex, dialogSource.indexOf('>', outerBoxIndex))
    expect(outerBoxLine).toContain('sm:h-[85vh]')
    expect(outerBoxLine).toContain('flex flex-col')
    expect(outerBoxLine).toContain('overflow-hidden')
    // The old content-driven sizing must be gone from this element, not
    // just superseded elsewhere.
    expect(outerBoxLine).not.toContain('max-h-[90vh]')
    expect(outerBoxLine).not.toContain('overflow-y-auto')
  })

  // Bugfix (mobile full-screen): below `sm:`, the box is a full-bleed
  // sheet (h-full w-full, no rounding) rather than a floating card --
  // the Team Settings tab's content never fits a phone viewport
  // regardless of container size, so a full-screen sheet uses the
  // available space better than a small floating box would.
  it('is a full-bleed sheet below sm: (h-full w-full, no rounding), and the floating-card treatment only applies at sm: and up', () => {
    const outerBoxIndex = dialogSource.indexOf('bg-white dark:bg-gray-800 shadow-xl w-full h-full')
    expect(outerBoxIndex).toBeGreaterThan(-1)
    const outerBoxLine = dialogSource.slice(outerBoxIndex, dialogSource.indexOf('>', outerBoxIndex))
    expect(outerBoxLine).toContain('w-full h-full')
    expect(outerBoxLine).toContain('sm:rounded-lg')
    expect(outerBoxLine).toContain('sm:max-w-4xl')
    // No unconditional (non-sm:-prefixed) rounding/max-width on this
    // element -- both must be sm:-gated, not always-on.
    expect(outerBoxLine).not.toMatch(/(?<!sm:)rounded-lg/)
    expect(outerBoxLine).not.toMatch(/(?<!sm:)max-w-4xl/)
  })

  it("drops the overlay's own padding below sm: (sm:p-4, was an unconditional p-4), so the full-bleed sheet reaches every edge", () => {
    const overlayIndex = dialogSource.indexOf('fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center')
    expect(overlayIndex).toBeGreaterThan(-1)
    const overlayLine = dialogSource.slice(overlayIndex, dialogSource.indexOf('>', overlayIndex))
    expect(overlayLine).toContain('sm:p-4')
    expect(overlayLine).not.toMatch(/(?<!sm:)p-4/)
  })

  it('marks the header and tab bar as flex-shrink-0, so the scrolling child cannot compress them', () => {
    const headerIndex = dialogSource.indexOf('border-b border-gray-200 dark:border-gray-700 flex-shrink-0')
    expect(headerIndex).toBeGreaterThan(-1)
    const tabBarIndex = dialogSource.indexOf('border-b border-gray-200 dark:border-gray-700 px-6 flex-shrink-0')
    expect(tabBarIndex).toBeGreaterThan(headerIndex)
  })

  it('wraps every tab panel (Team Settings form, Allowed Email Domains, Channel Access) in one shared `flex-1 overflow-y-auto` scrolling region', () => {
    const scrollWrapperIndex = dialogSource.indexOf('<div className="flex-1 overflow-y-auto">')
    const domainsGateIndex = dialogSource.indexOf("{editingTeam && !formData.parentTeamId && activeFormTab === 'domains' && (")
    const channelGateIndex = dialogSource.indexOf(
      "{editingTeam && !formData.parentTeamId && isGlobalManager && activeFormTab === 'channelAccess' && ("
    )
    expect(scrollWrapperIndex).toBeGreaterThan(-1)
    expect(domainsGateIndex).toBeGreaterThan(scrollWrapperIndex)
    expect(channelGateIndex).toBeGreaterThan(domainsGateIndex)
  })

  it('keeps the Cancel/Update footer OUTSIDE the scrolling region and marks it flex-shrink-0, so it stays fixed at the bottom on every tab', () => {
    const scrollWrapperIndex = dialogSource.indexOf('<div className="flex-1 overflow-y-auto">')
    const footerDivIndex = dialogSource.indexOf('<div className="flex justify-end space-x-3 px-6 py-4')
    expect(scrollWrapperIndex).toBeGreaterThan(-1)
    expect(footerDivIndex).toBeGreaterThan(scrollWrapperIndex)
    const footerDivLine = dialogSource.slice(footerDivIndex, dialogSource.indexOf('>', footerDivIndex))
    expect(footerDivLine).toContain('flex-shrink-0')
    // The actual `form="team-settings-form"` attribute usage on the
    // submit button must be AFTER this footer div, confirming the
    // button lives inside it.
    const submitAttrIndex = dialogSource.indexOf('form="team-settings-form"', footerDivIndex)
    expect(submitAttrIndex).toBeGreaterThan(footerDivIndex)
  })
})
