/**
 * SecretsProvider (Requirement 6 Criterion 6.4: Secrets-manager gate in production)
 *
 * Defines a common interface for resolving secret values at startup, with
 * two implementations:
 *
 *  - `EnvSecretsProvider`: reads secrets from `process.env`. Used in
 *    dev/test, where secrets are just plain environment variables and no
 *    external call is made.
 *  - `AwsSecretsManagerProvider`: reads secrets from AWS Secrets Manager via
 *    `@aws-sdk/client-secrets-manager`. Used in production when
 *    `SECRETS_PROVIDER=aws-secrets-manager` is set.
 *
 * This module intentionally does not wire itself into `Config_Validator`
 * yet -- that is a separate task. It only defines the interface, the two
 * implementations, and a factory function that picks the right one based
 * on `process.env.SECRETS_PROVIDER`.
 *
 * @typedef {Object} SecretsProvider
 * @property {function(string): Promise<string>} getSecret Resolves to the
 *   secret's string value, or rejects if the secret is missing/empty or the
 *   provider is unreachable. Implementations MUST NOT swallow errors
 *   silently -- either let the underlying error propagate or wrap it in a
 *   clear, descriptive error.
 * @property {function(string): Promise<Buffer>} getSecretBinary Resolves to
 *   the secret's raw bytes as a Buffer (device-management Requirement 2.3).
 *   This is a SEPARATE capability from `getSecret`: some secrets (such as a
 *   PKCS#12 bundle) are stored as binary and cannot be read as a string.
 *   Rejects if the secret is missing, empty, or not binary-readable.
 */

const fs = require('fs').promises;
const {
  SecretsManagerClient,
  GetSecretValueCommand
} = require('@aws-sdk/client-secrets-manager');

/**
 * Prefix that marks an `EnvSecretsProvider` binary secret value as a local
 * filesystem path rather than inline base64 content.
 */
const FILE_PREFIX = 'file:';

/**
 * Matches a canonical base64 payload (whitespace already stripped). Used to
 * reject non-base64 values instead of silently decoding garbage, because
 * `Buffer.from(value, 'base64')` ignores invalid characters.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Reads `filePath` as raw bytes, wrapping filesystem failures in a
 * descriptive error that names the secret and the env var it came from.
 *
 * @param {string} filePath
 * @param {string} secretName
 * @param {string} sourceVar the env var that supplied `filePath`.
 * @returns {Promise<Buffer>}
 */
async function readBinaryFile(filePath, secretName, sourceVar) {
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    throw new Error(
      `EnvSecretsProvider: failed to read binary secret "${secretName}" from the path in ` +
        `"${sourceVar}": ${err.message}`,
      { cause: err }
    );
  }
}

/**
 * `EnvSecretsProvider` resolves a secret by reading `process.env[secretName]`
 * directly. No external calls are made, matching the "used in dev/test"
 * mode described in the design (secrets are just environment variables).
 *
 * @implements {SecretsProvider}
 */
class EnvSecretsProvider {
  /**
   * @param {NodeJS.ProcessEnv} [env] defaults to `process.env`; overridable
   *   for testing.
   */
  constructor(env = process.env) {
    this.env = env;
  }

  /**
   * Resolves `secretName` from `process.env`.
   *
   * @param {string} secretName
   * @returns {Promise<string>} the environment variable's value.
   * @throws rejects if the variable is undefined, or empty after trimming.
   */
  async getSecret(secretName) {
    const value = this.env[secretName];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `EnvSecretsProvider: secret "${secretName}" is missing or empty in process.env`
      );
    }
    return value;
  }

  /**
   * Resolves `secretName` to raw bytes for the dev/test path, where there is
   * no Secrets Manager to read `SecretBinary` from.
   *
   * Resolution rule -- checked in this exact order, first match wins:
   *
   *   1. `env[`${secretName}_FILE`]`, when set and non-blank, is treated as a
   *      local filesystem path and its raw bytes are returned as-is (no
   *      decoding). This is the most explicit form and always wins.
   *   2. `env[secretName]`, when set and non-blank:
   *      a. If it starts with `file:` (e.g. `file:/etc/tak/admin.p12`), the
   *         remainder -- after trimming surrounding whitespace -- is treated
   *         as a local filesystem path and its raw bytes are returned as-is.
   *      b. Otherwise it is treated as base64-encoded content: all
   *         whitespace (including newlines from wrapped base64) is stripped,
   *         the result is validated as canonical base64, and the decoded
   *         bytes are returned.
   *   3. Otherwise the read fails.
   *
   * Note that step 1 uses a DIFFERENT env var than `getSecret`, and step 2
   * only reads `env[secretName]` -- `getSecret`'s behavior is untouched.
   *
   * @param {string} secretName
   * @returns {Promise<Buffer>} the secret's raw bytes.
   * @throws rejects if neither source is configured, the file cannot be read,
   *   or the inline value is not valid non-empty base64.
   */
  async getSecretBinary(secretName) {
    const filePathVar = `${secretName}_FILE`;
    const filePath = this.env[filePathVar];
    if (typeof filePath === 'string' && filePath.trim().length > 0) {
      return readBinaryFile(filePath.trim(), secretName, filePathVar);
    }

    const value = this.env[secretName];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(
        `EnvSecretsProvider: binary secret "${secretName}" is missing or empty in process.env ` +
          `(set "${filePathVar}" to a file path, or "${secretName}" to "file:<path>" or base64 content)`
      );
    }

    const trimmed = value.trim();
    if (trimmed.startsWith(FILE_PREFIX)) {
      const inlinePath = trimmed.slice(FILE_PREFIX.length).trim();
      if (inlinePath.length === 0) {
        throw new Error(
          `EnvSecretsProvider: binary secret "${secretName}" has a "${FILE_PREFIX}" prefix but no path`
        );
      }
      return readBinaryFile(inlinePath, secretName, secretName);
    }

    const base64 = trimmed.replace(/\s+/g, '');
    if (!BASE64_PATTERN.test(base64)) {
      throw new Error(
        `EnvSecretsProvider: binary secret "${secretName}" is not valid base64 content ` +
          `(prefix the value with "${FILE_PREFIX}" to read it from a file instead)`
      );
    }

    const decoded = Buffer.from(base64, 'base64');
    if (decoded.length === 0) {
      throw new Error(
        `EnvSecretsProvider: binary secret "${secretName}" decoded to zero bytes`
      );
    }
    return decoded;
  }
}

/**
 * `AwsSecretsManagerProvider` resolves a secret by calling AWS Secrets
 * Manager's `GetSecretValueCommand`. Used in production when
 * `SECRETS_PROVIDER=aws-secrets-manager` is set.
 *
 * @implements {SecretsProvider}
 */
class AwsSecretsManagerProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.region] AWS region; defaults to
   *   `process.env.AWS_REGION`.
   * @param {SecretsManagerClient} [options.client] an already-constructed
   *   client, primarily for testing; if omitted, a new client is created
   *   for `region`.
   */
  constructor(options = {}) {
    const region = options.region || process.env.AWS_REGION;
    this.client = options.client || new SecretsManagerClient({ region });
  }

  /**
   * Calls AWS Secrets Manager's `GetSecretValueCommand` for `secretName`
   * and returns its `SecretString`.
   *
   * @param {string} secretName
   * @returns {Promise<string>} the secret's string value.
   * @throws rejects if the AWS call fails (network error, access denied,
   *   secret not found, provider unreachable, etc.) or if the response has
   *   no `SecretString`. Underlying AWS SDK errors are wrapped in a
   *   descriptive error rather than swallowed.
   */
  async getSecret(secretName) {
    let response;
    try {
      response = await this.client.send(
        new GetSecretValueCommand({ SecretId: secretName })
      );
    } catch (err) {
      throw new Error(
        `AwsSecretsManagerProvider: failed to resolve secret "${secretName}": ${err.message}`,
        { cause: err }
      );
    }

    if (typeof response.SecretString !== 'string' || response.SecretString.length === 0) {
      throw new Error(
        `AwsSecretsManagerProvider: secret "${secretName}" has no SecretString value`
      );
    }

    return response.SecretString;
  }

  /**
   * Calls AWS Secrets Manager's `GetSecretValueCommand` for `secretName` and
   * returns its `SecretBinary` as a Buffer (device-management Requirement
   * 2.3). The SDK returns `SecretBinary` as a `Uint8Array`, so it is copied
   * into a Buffer for callers that expect Buffer semantics.
   *
   * @param {string} secretName
   * @returns {Promise<Buffer>} the secret's raw bytes.
   * @throws rejects if the AWS call fails (network error, access denied,
   *   secret not found, provider unreachable, etc.) or if the response has no
   *   `SecretBinary` -- for example when the secret holds a `SecretString`
   *   instead. Underlying AWS SDK errors are wrapped in a descriptive error
   *   rather than swallowed.
   */
  async getSecretBinary(secretName) {
    let response;
    try {
      response = await this.client.send(
        new GetSecretValueCommand({ SecretId: secretName })
      );
    } catch (err) {
      throw new Error(
        `AwsSecretsManagerProvider: failed to resolve binary secret "${secretName}": ${err.message}`,
        { cause: err }
      );
    }

    const { SecretBinary } = response;
    if (SecretBinary === undefined || SecretBinary === null) {
      throw new Error(
        `AwsSecretsManagerProvider: secret "${secretName}" has no SecretBinary value`
      );
    }

    const buffer = Buffer.from(SecretBinary);
    if (buffer.length === 0) {
      throw new Error(
        `AwsSecretsManagerProvider: secret "${secretName}" has no SecretBinary value`
      );
    }

    return buffer;
  }
}

/**
 * Factory function returning a `SecretsProvider` instance based on
 * `process.env.SECRETS_PROVIDER`.
 *
 * Returns an `AwsSecretsManagerProvider` when `SECRETS_PROVIDER` equals
 * `'aws-secrets-manager'`; otherwise defaults to `EnvSecretsProvider`
 * (dev/test mode).
 *
 * @param {NodeJS.ProcessEnv} [env] defaults to `process.env`; overridable
 *   for testing.
 * @returns {SecretsProvider}
 */
function getSecretsProvider(env = process.env) {
  if (env.SECRETS_PROVIDER === 'aws-secrets-manager') {
    return new AwsSecretsManagerProvider({ region: env.AWS_REGION });
  }
  return new EnvSecretsProvider(env);
}

module.exports = {
  EnvSecretsProvider,
  AwsSecretsManagerProvider,
  getSecretsProvider
};
