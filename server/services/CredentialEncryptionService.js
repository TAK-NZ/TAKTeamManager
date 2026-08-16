const crypto = require('crypto');

// AES-256-GCM envelope encryption for credential-at-rest protection
// (Requirement 6.1). The encryption key is read once, at module load,
// from CREDENTIAL_ENCRYPTION_KEY (a base64-encoded 32-byte key).
//
// Note: this module intentionally reads process.env directly rather than
// going through a SecretsProvider/Config_Validator gate. The production
// secrets-manager integration for CREDENTIAL_ENCRYPTION_KEY is handled by
// a later task (18.x) that wires Config_Validator into a SecretsProvider;
// this module must work standalone in the meantime.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // recommended IV length for GCM
const KEY_LENGTH_BYTES = 32; // AES-256 requires a 32-byte key

function loadKey() {
  const rawKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

  if (!rawKey || rawKey.trim() === '') {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is not set. A base64-encoded 32-byte key is required.'
    );
  }

  let key;
  try {
    key = Buffer.from(rawKey, 'base64');
  } catch (err) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is not valid base64.');
  }

  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes ` +
      `(got ${key.length} bytes). Generate one with: ` +
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }

  return key;
}

// Read and validate the key once at module load, so a misconfigured
// deployment fails fast at startup rather than on first use.
const encryptionKey = loadKey();

/**
 * Encrypts a plaintext string using AES-256-GCM.
 *
 * @param {string} plaintext - The value to encrypt (e.g. a service account password).
 * @returns {string} A single string in the format `iv:authTag:ciphertext`,
 *   with each segment base64-encoded.
 */
function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new Error('encrypt() requires a string plaintext value.');
  }

  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64')
  ].join(':');
}

/**
 * Decrypts a value produced by encrypt().
 *
 * @param {string} encryptedValue - A string in the format `iv:authTag:ciphertext`.
 * @returns {string} The original plaintext.
 * @throws {Error} A generic "Decryption failed" error on any failure
 *   (malformed input, wrong key, or tampered ciphertext/auth tag). The
 *   underlying crypto error and the ciphertext itself are never included
 *   in the thrown error's message, so callers can safely let this error
 *   propagate without leaking internals (Requirement 6.3).
 */
function decrypt(encryptedValue) {
  try {
    if (typeof encryptedValue !== 'string') {
      throw new Error('invalid input type');
    }

    const parts = encryptedValue.split(':');
    if (parts.length !== 3) {
      throw new Error('malformed encrypted value');
    }

    const [ivB64, authTagB64, ciphertextB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv);
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    return plaintext.toString('utf8');
  } catch (err) {
    // Deliberately do not re-throw the underlying crypto error or include
    // the ciphertext, to avoid leaking internals to callers/logs.
    throw new Error('Decryption failed');
  }
}

module.exports = { encrypt, decrypt };
