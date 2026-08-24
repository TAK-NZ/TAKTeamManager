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
 *  - `getSecretBinary` on both providers (device-management Requirement
 *    2.3): the raw-bytes read, and that it leaves `getSecret` unchanged.
 */

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
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

/**
 * `getSecretBinary` (device-management Requirement 2.3).
 *
 * The Admin_Credential is a PKCS#12 bundle stored as `SecretBinary`, so the
 * provider needs a raw-bytes read that is distinct from the string
 * `getSecret`. These tests use real bytes (including 0x00 and high bytes
 * that would not survive a UTF-8 round-trip) so a string-based
 * implementation could not pass.
 */

/** Bytes that are not valid UTF-8 text, standing in for a real P12 bundle. */
const BINARY_FIXTURE = Buffer.from([
  0x30, 0x82, 0x00, 0xff, 0x01, 0x7f, 0x80, 0xfe, 0x00, 0x0a
]);

describe('EnvSecretsProvider.getSecretBinary', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'env-secret-binary-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeFixture(fileName) {
    const filePath = path.join(tempDir, fileName);
    await fs.writeFile(filePath, BINARY_FIXTURE);
    return filePath;
  }

  it('returns the same bytes via a `<NAME>_FILE` path and via a base64 `<NAME>` value', async () => {
    const filePath = await writeFixture('admin.p12');

    const fromFile = await new EnvSecretsProvider({
      ADMIN_P12_FILE: filePath
    }).getSecretBinary('ADMIN_P12');

    const fromBase64 = await new EnvSecretsProvider({
      ADMIN_P12: BINARY_FIXTURE.toString('base64')
    }).getSecretBinary('ADMIN_P12');

    expect(Buffer.isBuffer(fromFile)).toBe(true);
    expect(Buffer.isBuffer(fromBase64)).toBe(true);
    expect(fromFile.equals(BINARY_FIXTURE)).toBe(true);
    expect(fromBase64.equals(BINARY_FIXTURE)).toBe(true);
    // The whole point of the two sources: identical bytes either way.
    expect(fromBase64.equals(fromFile)).toBe(true);
  });

  it('reads a `file:<path>` value from `<NAME>` as a filesystem path', async () => {
    const filePath = await writeFixture('inline-prefixed.p12');
    const provider = new EnvSecretsProvider({ ADMIN_P12: `file:${filePath}` });

    const bytes = await provider.getSecretBinary('ADMIN_P12');

    expect(bytes.equals(BINARY_FIXTURE)).toBe(true);
  });

  it('prefers `<NAME>_FILE` over `<NAME>` when both are set (first match wins)', async () => {
    const filePath = await writeFixture('wins.p12');
    const provider = new EnvSecretsProvider({
      ADMIN_P12_FILE: filePath,
      ADMIN_P12: Buffer.from('a different secret entirely').toString('base64')
    });

    const bytes = await provider.getSecretBinary('ADMIN_P12');

    expect(bytes.equals(BINARY_FIXTURE)).toBe(true);
  });

  it('strips whitespace from wrapped base64 before decoding', async () => {
    const wrapped = BINARY_FIXTURE.toString('base64')
      .split('')
      .join('\n');
    const provider = new EnvSecretsProvider({ ADMIN_P12: wrapped });

    const bytes = await provider.getSecretBinary('ADMIN_P12');

    expect(bytes.equals(BINARY_FIXTURE)).toBe(true);
  });

  it('rejects when neither source is configured', async () => {
    const provider = new EnvSecretsProvider({});
    await expect(provider.getSecretBinary('ADMIN_P12')).rejects.toThrow(
      /missing or empty/
    );
  });

  it('rejects when the configured file path cannot be read', async () => {
    const provider = new EnvSecretsProvider({
      ADMIN_P12_FILE: path.join(tempDir, 'does-not-exist.p12')
    });

    await expect(provider.getSecretBinary('ADMIN_P12')).rejects.toThrow(
      /failed to read binary secret "ADMIN_P12"/
    );
  });

  it('rejects a non-base64 inline value instead of silently decoding garbage', async () => {
    const provider = new EnvSecretsProvider({
      ADMIN_P12: 'this is definitely not base64!!'
    });

    await expect(provider.getSecretBinary('ADMIN_P12')).rejects.toThrow(
      /not valid base64 content/
    );
  });
});

describe('AwsSecretsManagerProvider.getSecretBinary', () => {
  function buildProviderWithMockClient(sendImpl) {
    const mockClient = { send: jest.fn(sendImpl) };
    const provider = new AwsSecretsManagerProvider({
      region: 'us-east-1',
      client: mockClient
    });
    return { provider, mockClient };
  }

  it('returns a Buffer of the SecretBinary bytes from the SDK Uint8Array shape', async () => {
    const { provider, mockClient } = buildProviderWithMockClient(async () => ({
      // The SDK hands back a Uint8Array, not a Buffer.
      SecretBinary: new Uint8Array(BINARY_FIXTURE)
    }));

    const bytes = await provider.getSecretBinary('prod/tak-admin-p12');

    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.equals(BINARY_FIXTURE)).toBe(true);
    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const sentCommand = mockClient.send.mock.calls[0][0];
    expect(sentCommand).toBeInstanceOf(GetSecretValueCommand);
    expect(sentCommand.input).toEqual({ SecretId: 'prod/tak-admin-p12' });
  });

  it('rejects when SecretBinary is absent (secret holds a SecretString instead)', async () => {
    const { provider } = buildProviderWithMockClient(async () => ({
      SecretString: 'not-binary'
    }));

    await expect(provider.getSecretBinary('prod/tak-admin-p12')).rejects.toThrow(
      /secret "prod\/tak-admin-p12" has no SecretBinary value/
    );
  });

  it('rejects when SecretBinary is present but empty', async () => {
    const { provider } = buildProviderWithMockClient(async () => ({
      SecretBinary: new Uint8Array(0)
    }));

    await expect(provider.getSecretBinary('prod/tak-admin-p12')).rejects.toThrow(
      /no SecretBinary value/
    );
  });

  it('wraps a failing AWS call in a descriptive binary-read error', async () => {
    const { provider } = buildProviderWithMockClient(async () => {
      throw new Error('AccessDeniedException');
    });

    await expect(provider.getSecretBinary('prod/tak-admin-p12')).rejects.toThrow(
      /failed to resolve binary secret "prod\/tak-admin-p12": AccessDeniedException/
    );
  });
});

describe('getSecret is unchanged by the binary read', () => {
  it('EnvSecretsProvider.getSecret still reads `<NAME>` as a plain string, ignoring `<NAME>_FILE`', async () => {
    const provider = new EnvSecretsProvider({
      MY_SECRET: 'plain-string-value',
      MY_SECRET_FILE: '/some/path/that/is/never/read'
    });

    await expect(provider.getSecret('MY_SECRET')).resolves.toBe('plain-string-value');
  });

  it('EnvSecretsProvider.getSecret does not decode a base64-looking value', async () => {
    const base64 = Buffer.from('decoded').toString('base64');
    const provider = new EnvSecretsProvider({ MY_SECRET: base64 });

    await expect(provider.getSecret('MY_SECRET')).resolves.toBe(base64);
  });

  it('EnvSecretsProvider.getSecret still rejects on a missing variable', async () => {
    const provider = new EnvSecretsProvider({});
    await expect(provider.getSecret('MISSING_SECRET')).rejects.toThrow(/missing or empty/);
  });

  it('AwsSecretsManagerProvider.getSecret still returns SecretString and ignores SecretBinary', async () => {
    const mockClient = {
      send: jest.fn(async () => ({
        SecretString: 'the-plaintext-secret',
        SecretBinary: new Uint8Array(BINARY_FIXTURE)
      }))
    };
    const provider = new AwsSecretsManagerProvider({
      region: 'us-east-1',
      client: mockClient
    });

    await expect(provider.getSecret('prod/jwt-secret')).resolves.toBe(
      'the-plaintext-secret'
    );
  });

  it('AwsSecretsManagerProvider.getSecret still rejects with the SecretString message when only SecretBinary exists', async () => {
    const mockClient = {
      send: jest.fn(async () => ({ SecretBinary: new Uint8Array(BINARY_FIXTURE) }))
    };
    const provider = new AwsSecretsManagerProvider({
      region: 'us-east-1',
      client: mockClient
    });

    await expect(provider.getSecret('prod/tak-admin-p12')).rejects.toThrow(
      /no SecretString value/
    );
  });
});
