import { describe, it, expect } from 'vitest';
import { shouldShowCallsignSuffixInput, isValidCodeFormat, filterTeamsBySearch } from './RequestAccess.jsx';

// Validates: Requirements 11.9, 11.10
//
// RequestAccess.jsx conditionally renders a required "Preferred Callsign
// Suffix" input only when the selected joinable-team row's
// `callsignNameFormat` (a field added to GET /api/teams/joinable's response
// shape by server/models/Team.js's `getJoinableTeams`, per task 34.1) is
// `user_defined`. No component-render test harness (e.g.
// @testing-library/react) is set up in this project -- see
// Requests.test.jsx and TeamDetail.test.jsx, which both test extracted pure
// logic rather than rendering a component -- so this file follows that same
// convention and tests the pure helper RequestAccess.jsx uses to decide
// whether to render the input.

describe('shouldShowCallsignSuffixInput', () => {
  it('renders the input when the selected team\'s Organisation format is user_defined (Req 11.9)', () => {
    const team = { id: 1, name: 'Station 40', callsignNameFormat: 'user_defined' };

    expect(shouldShowCallsignSuffixInput(team)).toBe(true);
  });

  it('does not render the input for any other callsignNameFormat value (Req 11.10)', () => {
    expect(shouldShowCallsignSuffixInput({ callsignNameFormat: 'full_name' })).toBe(false);
    expect(shouldShowCallsignSuffixInput({ callsignNameFormat: 'first_initial_last' })).toBe(false);
    expect(shouldShowCallsignSuffixInput({ callsignNameFormat: 'first_last_initial' })).toBe(false);
    expect(shouldShowCallsignSuffixInput({ callsignNameFormat: 'first_initial_dot_last' })).toBe(false);
  });

  it('does not render the input when callsignNameFormat is absent', () => {
    expect(shouldShowCallsignSuffixInput({ id: 1, name: 'Some Team' })).toBe(false);
  });

  it('does not render the input when no team is selected', () => {
    expect(shouldShowCallsignSuffixInput(null)).toBe(false);
    expect(shouldShowCallsignSuffixInput(undefined)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 12.2 — Vitest component tests for RequestAccess page
// ──────────────────────────────────────────────────────────────────────────────

describe('isValidCodeFormat helper (Task 12.2)', () => {
  it('returns true for empty input (code is optional)', () => {
    expect(isValidCodeFormat('')).toBe(true);
    expect(isValidCodeFormat(null)).toBe(true);
    expect(isValidCodeFormat(undefined)).toBe(true);
  });

  it('returns true for valid 8-char codes', () => {
    expect(isValidCodeFormat('ABCDEFGH')).toBe(true);
    expect(isValidCodeFormat('23456789')).toBe(true);
    expect(isValidCodeFormat('ABCD5678')).toBe(true);
  });

  it('returns true for valid codes with dash (XXXX-XXXX)', () => {
    expect(isValidCodeFormat('ABCD-EFGH')).toBe(true);
    expect(isValidCodeFormat('2345-6789')).toBe(true);
  });

  it('returns true for lowercase input (normalized to upper)', () => {
    expect(isValidCodeFormat('abcdefgh')).toBe(true);
    expect(isValidCodeFormat('abcd-efgh')).toBe(true);
  });

  it('returns false for codes with invalid chars (0, O, 1, I, L)', () => {
    expect(isValidCodeFormat('0BCDEFGH')).toBe(false);
    expect(isValidCodeFormat('OBCDEFGH')).toBe(false);
    expect(isValidCodeFormat('1BCDEFGH')).toBe(false);
    expect(isValidCodeFormat('IBCDEFGH')).toBe(false);
    expect(isValidCodeFormat('LBCDEFGH')).toBe(false);
  });

  it('returns false for wrong length', () => {
    expect(isValidCodeFormat('ABCDE')).toBe(false);
    expect(isValidCodeFormat('ABCDEFGHIJ')).toBe(false);
    expect(isValidCodeFormat('A')).toBe(false);
  });
});

describe('shouldShowCallsignSuffixInput helper (Task 12.2 extended)', () => {
  it('returns true for user_defined format', () => {
    expect(shouldShowCallsignSuffixInput({ callsignNameFormat: 'user_defined' })).toBe(true);
  });

  it('returns false for other formats', () => {
    expect(shouldShowCallsignSuffixInput({ callsignNameFormat: 'full_name' })).toBe(false);
    expect(shouldShowCallsignSuffixInput({ callsignNameFormat: 'first_initial_last' })).toBe(false);
  });
});

// Team-name search for /request-access team selection: filters the
// available teams by a free-text term, matched case-insensitively as a
// substring against display_name (falling back to name).
describe('filterTeamsBySearch', () => {
  const teams = [
    { id: 1, display_name: 'FENZ - Manapouri', name: 'Manapouri' },
    { id: 2, display_name: 'FENZ - Auckland', name: 'Auckland' },
    { id: 3, name: 'Land Search and Rescue' } // no display_name -> falls back to name
  ];

  it('returns every team unchanged for an empty/whitespace-only term', () => {
    expect(filterTeamsBySearch(teams, '')).toEqual(teams);
    expect(filterTeamsBySearch(teams, '   ')).toEqual(teams);
    expect(filterTeamsBySearch(teams, null)).toEqual(teams);
    expect(filterTeamsBySearch(teams, undefined)).toEqual(teams);
  });

  it('matches display_name case-insensitively as a substring', () => {
    expect(filterTeamsBySearch(teams, 'manapouri').map((t) => t.id)).toEqual([1]);
    expect(filterTeamsBySearch(teams, 'AUCKLAND').map((t) => t.id)).toEqual([2]);
  });

  it('matches a shared segment across multiple teams', () => {
    expect(filterTeamsBySearch(teams, 'FENZ').map((t) => t.id)).toEqual([1, 2]);
  });

  it('falls back to name when a team has no display_name', () => {
    expect(filterTeamsBySearch(teams, 'rescue').map((t) => t.id)).toEqual([3]);
  });

  it('trims the term before matching', () => {
    expect(filterTeamsBySearch(teams, '  auckland  ').map((t) => t.id)).toEqual([2]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterTeamsBySearch(teams, 'zzz')).toEqual([]);
  });

  it('returns an empty array for a non-array input rather than throwing', () => {
    expect(filterTeamsBySearch(undefined, 'x')).toEqual([]);
    expect(filterTeamsBySearch(null, 'x')).toEqual([]);
  });
});
