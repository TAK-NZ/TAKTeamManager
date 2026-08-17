const { isValidCallsignPrefix, isValidCallsignSuffix } = require('./callsignValidation');

/**
 * Feature: org-team-hierarchy, task 6.5
 * Validates: Requirements 3.8, 3.9, 11.3
 */
describe('isValidCallsignPrefix', () => {
  it('accepts an empty string', () => {
    expect(isValidCallsignPrefix('')).toBe(true);
  });

  it('accepts null/undefined', () => {
    expect(isValidCallsignPrefix(null)).toBe(true);
    expect(isValidCallsignPrefix(undefined)).toBe(true);
  });

  it('accepts letters-only values', () => {
    expect(isValidCallsignPrefix('FENZ')).toBe(true);
  });

  it('accepts digits-only values', () => {
    expect(isValidCallsignPrefix('123')).toBe(true);
  });

  it('accepts mixed alphanumeric values', () => {
    expect(isValidCallsignPrefix('NZP40')).toBe(true);
  });

  it('rejects a value containing a hyphen', () => {
    expect(isValidCallsignPrefix('NZ-POL')).toBe(false);
  });

  it('rejects a value containing a period', () => {
    expect(isValidCallsignPrefix('NZ.POL')).toBe(false);
  });

  it('rejects a value containing another disallowed character', () => {
    expect(isValidCallsignPrefix('NZ POL')).toBe(false);
    expect(isValidCallsignPrefix('NZ_POL')).toBe(false);
  });
});

describe('isValidCallsignSuffix', () => {
  it('accepts an empty string', () => {
    expect(isValidCallsignSuffix('')).toBe(true);
  });

  it('accepts null/undefined', () => {
    expect(isValidCallsignSuffix(null)).toBe(true);
    expect(isValidCallsignSuffix(undefined)).toBe(true);
  });

  it('accepts letters-only values', () => {
    expect(isValidCallsignSuffix('Doe')).toBe(true);
  });

  it('accepts digits-only values', () => {
    expect(isValidCallsignSuffix('4021')).toBe(true);
  });

  it('accepts mixed alphanumeric values', () => {
    expect(isValidCallsignSuffix('JDoe1')).toBe(true);
  });

  it('accepts a value containing a hyphen', () => {
    expect(isValidCallsignSuffix('J-Doe')).toBe(true);
  });

  it('accepts a value containing a period', () => {
    expect(isValidCallsignSuffix('J.Doe')).toBe(true);
  });

  it('rejects a value containing another disallowed character', () => {
    expect(isValidCallsignSuffix('J Doe')).toBe(false);
    expect(isValidCallsignSuffix('J_Doe')).toBe(false);
  });
});
