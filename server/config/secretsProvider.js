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
 */

const {
  SecretsManagerClient,
  GetSecretValueCommand
} = require('@aws-sdk/client-secrets-manager');

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
        `AwsSecretsManagerProvider: failed to resolve secret "${secretName}": ${err.message}`
      );
    }

    if (typeof response.SecretString !== 'string' || response.SecretString.length === 0) {
      throw new Error(
        `AwsSecretsManagerProvider: secret "${secretName}" has no SecretString value`
      );
    }

    return response.SecretString;
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
