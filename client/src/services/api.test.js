import { describe, it, expect } from 'vitest';
import { isValidBaseUrl } from './api.js';

// Validates: Requirements 2.7, 2.8
//
// Requirement 2.8 (success path): a syntactically valid absolute URL or
// relative path is accepted without error.
// Requirement 2.7 (failure path): anything that is not a syntactically
// valid absolute URL or relative path is rejected.
describe('isValidBaseUrl', () => {
  describe('success paths (Requirement 2.8)', () => {
    it('accepts an empty string (unset -> same-origin relative path)', () => {
      expect(isValidBaseUrl('')).toBe(true);
    });

    it('accepts a well-formed absolute https:// URL', () => {
      expect(isValidBaseUrl('https://api.example.com')).toBe(true);
    });

    it('accepts a well-formed absolute http:// URL', () => {
      expect(isValidBaseUrl('http://api.example.com:8080')).toBe(true);
    });

    it('accepts a well-formed absolute HTTPS URL regardless of scheme case', () => {
      expect(isValidBaseUrl('HTTPS://api.example.com')).toBe(true);
    });

    it('accepts a relative path starting with a slash', () => {
      expect(isValidBaseUrl('/api')).toBe(true);
    });

    it('accepts a relative path without a leading slash', () => {
      expect(isValidBaseUrl('some/relative/path')).toBe(true);
    });
  });

  describe('failure paths (Requirement 2.7)', () => {
    it('rejects a value containing whitespace', () => {
      expect(isValidBaseUrl('https://example.com/has space')).toBe(false);
    });

    it('rejects a javascript:// scheme', () => {
      expect(isValidBaseUrl('javascript://alert(1)')).toBe(false);
    });

    it('rejects an ftp:// scheme', () => {
      expect(isValidBaseUrl('ftp://files.example.com')).toBe(false);
    });

    it('rejects a data: scheme with a "://"-shaped payload', () => {
      expect(isValidBaseUrl('data://text/plain')).toBe(false);
    });

    it('rejects a malformed absolute https:// URL with no host', () => {
      // `new URL('https://')` throws (empty host), unlike most other
      // strings passed to `new URL()`, so this exercises the try/catch
      // failure branch of the http(s) validation path.
      expect(isValidBaseUrl('https://')).toBe(false);
    });

    it('rejects a malformed absolute http:// URL with no host', () => {
      expect(isValidBaseUrl('http://')).toBe(false);
    });
  });
});
