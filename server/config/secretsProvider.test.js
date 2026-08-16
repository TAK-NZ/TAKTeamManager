/**
 * Unit tests for the SecretsProvider interface (Requirement 6.4).
 *
 * Covers:
 *  - `EnvSecretsProvider`: reads from `process.env` correctly, including
 *    missing/empty-variable behavior.
 *  - `AwsSecretsManagerProvider`: success, missing-secret (no
 *    `SecretString`), and unreachable/error cases, with the AWS SDK client
 *    mocked so no real network call is made.
 *  - `getSecretsProvider`: factory selection based on
 *    `process.env.SECRETS_PROVIDER`.
 */

const {
  EnvSecretsProvider,
  AwsSecretsManagerProvider,
  getSecretsProvider
} = require('./secretsProvider');
const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

describe('EnvSecretsProvider', () => {
  it('resolves a secret present and non-empty in the given env object', async () => {
    const provider = new EnvSecretsProvider({ MY_SECRET: 'super-secret-value' });
    const value = await provider.getSecret('MY_SECRET');
    expect(value).toBe('super-secret-value');
  });

  it('rejects when the variable is missing from the env object', async () => {
    const provider = new EnvSecretsProvider({});
    await expect(provider.getSecret('MISSING_SECRET')).rejects.toThrow(
      /missing or empty/
    );
  });

  it('rejects when the variable is present but empty or whitespace-only', async () => {
    const provider = new EnvSecretsProvider({ BLANK_SECRET: '   ' });
    await expect(provider.getSecret('BLANK_SECRET')).rejects.toThrow(
      /missing or empty/
    );
  });

  it('defaults to process.env when no env object is supplied', async () => {
    process.env.TEST_ENV_SECRET_PROVIDER_VAR = 'from-process-env';
    try {
      const provider = new EnvSecretsProvider();
      const value = await provider.getSecret('TEST_ENV_SECRET_PROVIDER_VAR');
      expect(value).toBe('from-process-env');
    } finally {
      delete process.env.TEST_ENV_SECRET_PROVIDER_VAR;
    }
  });
});

describe('AwsSecretsManagerProvider', () => {
  function buildProviderWithMockClient(sendImpl) {
    const mockClient = { send: jest.fn(sendImpl) };
    const provider = new AwsSecretsManagerProvider({
      region: 'us-east-1',
      client: mockClient
    });
    return { provider, mockClient };
  }

  it('resolves the SecretString on a successful call', async () => {
    const { provider, mockClient } = buildProviderWithMockClient(async () => ({
      SecretString: 'the-plaintext-secret'
    }));

    const value = await provider.getSecret('prod/jwt-secret');

    expect(value).toBe('the-plaintext-secret');
    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const sentCommand = mockClient.send.mock.calls[0][0];
    expect(sentCommand).toBeInstanceOf(GetSecretValueCommand);
    expect(sentCommand.input).toEqual({ SecretId: 'prod/jwt-secret' });
  });

  it('rejects distinctly when the response has no SecretString (missing secret)', async () => {
    const { provider } = buildProviderWithMockClient(async () => ({}));

    await expect(provider.getSecret('prod/missing-secret')).rejects.toThrow(
      /no SecretString value/
    );
  });

  it('rejects distinctly when the response has an empty SecretString', async () => {
    const { provider } = buildProviderWithMockClient(async () => ({
      SecretString: ''
    }));

    await expect(provider.getSecret('prod/empty-secret')).rejects.toThrow(
      /no SecretString value/
    );
  });

  it('rejects distinctly when the underlying AWS call fails (unreachable/error)', async () => {
    const { provider } = buildProviderWithMockClient(async () => {
      throw new Error('getaddrinfo ENOTFOUND secretsmanager.us-east-1.amazonaws.com');
    });

    await expect(provider.getSecret('prod/jwt-secret')).rejects.toThrow(
      /failed to resolve secret "prod\/jwt-secret"/
    );
  });

  it('constructs its own client with the given region when none is supplied', () => {
    const provider = new AwsSecretsManagerProvider({ region: 'ap-southeast-2' });
    expect(provider.client).toBeDefined();
  });
});

describe('getSecretsProvider factory', () => {
  it('returns an EnvSecretsProvider by default (SECRETS_PROVIDER unset)', () => {
    const provider = getSecretsProvider({});
    expect(provider).toBeInstanceOf(EnvSecretsProvider);
  });

  it('returns an EnvSecretsProvider for any non-matching SECRETS_PROVIDER value', () => {
    const provider = getSecretsProvider({ SECRETS_PROVIDER: 'something-else' });
    expect(provider).toBeInstanceOf(EnvSecretsProvider);
  });

  it('returns an AwsSecretsManagerProvider when SECRETS_PROVIDER=aws-secrets-manager', () => {
    const provider = getSecretsProvider({
      SECRETS_PROVIDER: 'aws-secrets-manager',
      AWS_REGION: 'us-east-1'
    });
    expect(provider).toBeInstanceOf(AwsSecretsManagerProvider);
  });
});
