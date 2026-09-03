const crypto = require('crypto');

const MODULE_PATH = './CredentialEncryptionService';
const VALID_KEY = crypto.randomBytes(32).toString('base64');

/**
 * The service reads and validates CREDENTIAL_ENCRYPTION_KEY once, at module
 * load time, so each test that needs a specific key value must reset the
 * module registry and re-require it after setting process.env.
 */
function loadServiceWithKey(keyValue) {
  jest.resetModules();
  if (keyValue === undefined) {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  } else {
    process.env.CREDENTIAL_ENCRYPTION_KEY = keyValue;
  }
  return require(MODULE_PATH);
}

describe('CredentialEncryptionService', () => {
  const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    } else {
      process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
    }
    jest.resetModules();
  });

  describe('startup key validation', () => {
    it('throws a descriptive error when CREDENTIAL_ENCRYPTION_KEY is missing', () => {
      expect(() => loadServiceWithKey(undefined)).toThrow(
        /CREDENTIAL_ENCRYPTION_KEY is not set/
      );
    });

    it('throws a descriptive error when CREDENTIAL_ENCRYPTION_KEY is an empty string', () => {
      expect(() => loadServiceWithKey('   ')).toThrow(
        /CREDENTIAL_ENCRYPTION_KEY is not set/
      );
    });

    it('throws a descriptive error when the key does not decode to 32 bytes', () => {
      const shortKey = crypto.randomBytes(16).toString('base64');
      expect(() => loadServiceWithKey(shortKey)).toThrow(
        /must decode to exactly 32 bytes/
      );
    });

    it('loads successfully with a valid 32-byte base64 key', () => {
      expect(() => loadServiceWithKey(VALID_KEY)).not.toThrow();
    });
  });

  describe('encrypt/decrypt round trip', () => {
    let service;

    beforeEach(() => {
      service = loadServiceWithKey(VALID_KEY);
    });

    it('decrypts back to the original plaintext', () => {
      const plaintext = 'super-secret-service-account-password';
      const encrypted = service.encrypt(plaintext);
      expect(service.decrypt(encrypted)).toBe(plaintext);
    });

    it('round-trips an empty string', () => {
      const encrypted = service.encrypt('');
      expect(service.decrypt(encrypted)).toBe('');
    });

    it('round-trips a value containing unicode characters', () => {
      const plaintext = 'pässwörd-🔒-value';
      const encrypted = service.encrypt(plaintext);
      expect(service.decrypt(encrypted)).toBe(plaintext);
    });

    it('produces an output in iv:authTag:ciphertext base64 segment format', () => {
      const encrypted = service.encrypt('some-password');
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);
      parts.forEach((part) => {
        expect(() => Buffer.from(part, 'base64')).not.toThrow();
      });
    });

    it('produces different ciphertext for the same plaintext on repeated calls (random IV)', () => {
      const plaintext = 'repeatable-password';
      const first = service.encrypt(plaintext);
      const second = service.encrypt(plaintext);
      expect(first).not.toBe(second);
      // Both must still independently decrypt to the same plaintext.
      expect(service.decrypt(first)).toBe(plaintext);
      expect(service.decrypt(second)).toBe(plaintext);
    });
  });

  describe('decrypt failure behavior', () => {
    let service;

    beforeEach(() => {
      service = loadServiceWithKey(VALID_KEY);
    });

    it('throws a generic error, not the plaintext or internals, for a tampered ciphertext segment', () => {
      const encrypted = service.encrypt('a-password-value');
      const [iv, authTag, ciphertext] = encrypted.split(':');
      const tamperedBuffer = Buffer.from(ciphertext, 'base64');
      tamperedBuffer[0] ^= 0xff; // flip a bit
      const tampered = [iv, authTag, tamperedBuffer.toString('base64')].join(':');

      expect(() => service.decrypt(tampered)).toThrow('Decryption failed');
      // Ensure no other message (e.g. the plaintext or a crypto internal
      // message) leaks through the thrown error.
      try {
        service.decrypt(tampered);
      } catch (err) {
        expect(err.message).toBe('Decryption failed');
        expect(err.message).not.toContain('a-password-value');
      }
    });

    it('throws a generic error for a tampered auth tag segment', () => {
      const encrypted = service.encrypt('another-password');
      const [iv, authTag, ciphertext] = encrypted.split(':');
      const tamperedTag = Buffer.from(authTag, 'base64');
      tamperedTag[0] ^= 0xff;
      const tampered = [iv, tamperedTag.toString('base64'), ciphertext].join(':');

      expect(() => service.decrypt(tampered)).toThrow('Decryption failed');
    });

    it('throws a generic error for a malformed (wrong segment count) encrypted value', () => {
      expect(() => service.decrypt('not-a-valid-encrypted-value')).toThrow(
        'Decryption failed'
      );
    });

    it('throws a generic error for a non-string input', () => {
      expect(() => service.decrypt(undefined)).toThrow('Decryption failed');
      expect(() => service.decrypt(12345)).toThrow('Decryption failed');
    });

    it('fails to decrypt a value produced under a different encryption key', () => {
      const encrypted = service.encrypt('cross-key-password');

      const otherKey = crypto.randomBytes(32).toString('base64');
      const otherService = loadServiceWithKey(otherKey);

      expect(() => otherService.decrypt(encrypted)).toThrow('Decryption failed');
    });
  });

  describe('encrypt input validation', () => {
    let service;

    beforeEach(() => {
      service = loadServiceWithKey(VALID_KEY);
    });

    it('throws when given a non-string plaintext', () => {
      expect(() => service.encrypt(12345)).toThrow(
        'encrypt() requires a string plaintext value.'
      );
      expect(() => service.encrypt(null)).toThrow(
        'encrypt() requires a string plaintext value.'
      );
      expect(() => service.encrypt(undefined)).toThrow(
        'encrypt() requires a string plaintext value.'
      );
    });
  });
});
