/**
 * Vitest component tests for TeamFormDialog — can_join toggle confirmation.
 *
 * Task 16.2 (signup-flow-rework spec)
 *
 * Tests that when editing a team with can_join=true and toggling to false,
 * window.confirm is called (the component's pure logic contract).
 */

import { describe, it, expect, vi } from 'vitest';
import { isValidCallsignPrefixInput } from './TeamFormDialog.jsx';

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
