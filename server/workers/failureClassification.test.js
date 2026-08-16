const { classifyFailure } = require('./failureClassification');

describe('classifyFailure', () => {
  describe('5xx status codes classify as retryable', () => {
    it.each([500, 502, 503])('status %d is retryable', (status) => {
      expect(classifyFailure(status)).toBe('retryable');
    });
  });

  describe('4xx status codes classify as permanent', () => {
    it.each([400, 401, 403, 404, 429])('status %d is permanent', (status) => {
      expect(classifyFailure(status)).toBe('permanent');
    });
  });

  describe('Error instances (network/timeout failures) classify as retryable', () => {
    it('a generic Error instance is retryable', () => {
      expect(classifyFailure(new Error('fetch failed'))).toBe('retryable');
    });

    it('a TypeError (Node fetch network failure shape) is retryable', () => {
      const err = new TypeError('fetch failed');
      err.cause = new Error('getaddrinfo ENOTFOUND authentik.example.com');
      expect(classifyFailure(err)).toBe('retryable');
    });

    it('an AbortError-shaped DOMException/Error (timeout) is retryable', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      expect(classifyFailure(err)).toBe('retryable');
    });
  });

  describe('edge cases default to retryable', () => {
    it('null defaults to retryable', () => {
      expect(classifyFailure(null)).toBe('retryable');
    });

    it('undefined defaults to retryable', () => {
      expect(classifyFailure(undefined)).toBe('retryable');
    });

    it('a string input defaults to retryable', () => {
      expect(classifyFailure('500')).toBe('retryable');
    });

    it('a plain object without a status defaults to retryable', () => {
      expect(classifyFailure({ message: 'oops' })).toBe('retryable');
    });

    it('a 2xx/3xx status (unexpected input) defaults to retryable', () => {
      expect(classifyFailure(200)).toBe('retryable');
      expect(classifyFailure(304)).toBe('retryable');
    });

    it('a status outside the documented ranges (e.g. 600) defaults to retryable', () => {
      expect(classifyFailure(600)).toBe('retryable');
    });
  });
});
