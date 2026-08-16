/**
 * Unit tests for Config_Validator (Requirement 15, Requirement 3 Criteria
 * 3.5-3.6, and Requirement 6.4).
 *
 * Requirement 6.4 focus of this file: when `NODE_ENV=production`,
 * `validateConfig` resolves `AUTHENTIK_ADMIN_TOKEN`, `JWT_SECRET`,
 * `DB_PASSWORD`, and `EMAIL_PASSWORD` (the generic SMTP credential read
 * by `EmailService.js`) through the configured `SecretsProvider`
 * (Requirement 6.4) rather than trusting a plain `.env` value, and exits
 * non-zero listing every secret that failed to resolve when the provider
 * is unreachable or a secret is missing. Outside production, this gate is
 * a no-op.
 *
 * `process.exit` is mocked throughout so a failing check never actually
 * terminates the test runner.
 */

// Requirement 13.1/13.8 (task 33.1): validateConfig now logs invalid
// startup configuration via the structured logger instead of
// console.error. Mock it the same way authentikSync.test.js/
// GlobalChannelService.test.js/syncWorker.test.js do, so tests can assert
// on logger.error calls instead of console.error.
const mockLoggerInstance = {
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};
jest.mock('./logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const {
  validateConfig,
  validateProductionSecrets,
  collectTakServerConfigIssues,
  collectRetentionConfigIssues,
  isWellFormedUrl,
  isValidJwtExpiry,
  isDatabaseTlsCertificateValidationDisabled,
  warnIfDatabaseTlsCertificateValidationDisabled,
  isAuthRouteMounted,
  assertAuthRouteMounted
} = require('./configValidator');

/**
 * A base environment that satisfies every synchronous check in
 * `collectConfigIssues` (Requirement 15.1-15.4, 3.5-3.6), so that tests in
 * this file exercise only the production secrets-manager gate (Req 6.4)
 * added on top of it.
 */
function buildValidBaseEnv(overrides = {}) {
  return {
    DB_HOST: 'db.example.com',
    DB_NAME: 'tak_team_manager',
    DB_USER: 'app_user',
    DB_PASSWORD: 'super-secret-db-password',
    AUTHENTIK_URL: 'https://authentik.example.com',
    AUTHENTIK_ADMIN_TOKEN: 'admin-token-value',
    AUTHENTIK_CLIENT_ID: 'client-id-value',
    AUTHENTIK_CLIENT_SECRET: 'client-secret-value',
    JWT_SECRET: 'a'.repeat(32),
    FRONTEND_URL: 'https://app.example.com',
    APP_URL: 'https://app.example.com',
    JWT_EXPIRES_IN: '1h',
    EMAIL_PASSWORD: 'smtp-password-value',
    ...overrides
  };
}

/**
 * Requirement 26.1/26.2 (task 48.1): TAK Server mutual TLS credential gate,
 * only applicable when `TAK_SERVER_URL` is configured. This integration is
 * optional -- unset `TAK_SERVER_URL` must never require any TAK Server
 * credential variable.
 */
describe('collectTakServerConfigIssues', () => {
  it('reports no issues when TAK_SERVER_URL is unset', () => {
    const env = buildValidBaseEnv();
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toEqual([]);
  });

  it('reports no issues when TAK_SERVER_URL is an empty string', () => {
    const env = buildValidBaseEnv({ TAK_SERVER_URL: '   ' });
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toEqual([]);
  });

  it('reports no issues when TAK_SERVER_URL is set with a complete P12 credential pair', () => {
    const env = buildValidBaseEnv({
      TAK_SERVER_URL: 'https://tak.example.com:8443',
      TAK_API_P12_PATH: '/etc/tak/certs/client.p12',
      TAK_API_P12_PASSPHRASE: 'p12-passphrase-value'
    });
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toEqual([]);
  });

  it('reports no issues when TAK_SERVER_URL is set with a complete cert/key credential pair', () => {
    const env = buildValidBaseEnv({
      TAK_SERVER_URL: 'https://tak.example.com:8443',
      TAK_API_CERT_PATH: '/etc/tak/certs/client.pem',
      TAK_API_KEY_PATH: '/etc/tak/certs/client.key'
    });
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toEqual([]);
  });

  it('reports no issues when TAK_SERVER_URL is set with a complete pair plus the optional TAK_CA_PATH', () => {
    const env = buildValidBaseEnv({
      TAK_SERVER_URL: 'https://tak.example.com:8443',
      TAK_API_CERT_PATH: '/etc/tak/certs/client.pem',
      TAK_API_KEY_PATH: '/etc/tak/certs/client.key',
      TAK_CA_PATH: '/etc/tak/certs/ca.pem'
    });
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toEqual([]);
  });

  it('reports an issue when TAK_SERVER_URL is set but no credential pair is present at all', () => {
    const env = buildValidBaseEnv({ TAK_SERVER_URL: 'https://tak.example.com:8443' });
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/mutual TLS client credential pair/);
    expect(issues[0]).toMatch(/TAK_API_P12_PATH/);
    expect(issues[0]).toMatch(/TAK_API_CERT_PATH/);
  });

  it('reports an issue when only one half of the P12 pair is present', () => {
    const env = buildValidBaseEnv({
      TAK_SERVER_URL: 'https://tak.example.com:8443',
      TAK_API_P12_PATH: '/etc/tak/certs/client.p12'
      // TAK_API_P12_PASSPHRASE intentionally omitted
    });
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/mutual TLS client credential pair/);
  });

  it('reports an issue when only one half of the cert/key pair is present', () => {
    const env = buildValidBaseEnv({
      TAK_SERVER_URL: 'https://tak.example.com:8443',
      TAK_API_CERT_PATH: '/etc/tak/certs/client.pem'
      // TAK_API_KEY_PATH intentionally omitted
    });
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/mutual TLS client credential pair/);
  });

  it('reports a malformed-URL issue when TAK_SERVER_URL is not a well-formed URL, independent of credentials', () => {
    const env = buildValidBaseEnv({
      TAK_SERVER_URL: 'not-a-url',
      TAK_API_CERT_PATH: '/etc/tak/certs/client.pem',
      TAK_API_KEY_PATH: '/etc/tak/certs/client.key'
    });
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/TAK_SERVER_URL is not a well-formed URL/);
  });

  it('reports both a malformed-URL issue and a missing-credentials issue when both are wrong', () => {
    const env = buildValidBaseEnv({ TAK_SERVER_URL: 'not-a-url' });
    const issues = collectTakServerConfigIssues(env);
    expect(issues).toHaveLength(2);
    expect(issues.some((issue) => issue.match(/not a well-formed URL/))).toBe(true);
    expect(issues.some((issue) => issue.match(/mutual TLS client credential pair/))).toBe(true);
  });
});

/**
 * Requirement 25.1/25.4 (task 47.2): SYNC_OPERATIONS_RETENTION_DAYS
 * (default 90) and AUDIT_LOGS_RETENTION_DAYS (default 365) validation,
 * including the "distinct from and longer than" ordering requirement
 * between the two EFFECTIVE (default-applying) values.
 */
describe('collectRetentionConfigIssues', () => {
  it('reports no issues when both retention variables are unset (defaults 90/365 apply)', () => {
    const env = buildValidBaseEnv();
    const issues = collectRetentionConfigIssues(env);
    expect(issues).toEqual([]);
  });

  it('reports no issues when both retention variables are set validly (e.g. 30/60)', () => {
    const env = buildValidBaseEnv({
      SYNC_OPERATIONS_RETENTION_DAYS: '30',
      AUDIT_LOGS_RETENTION_DAYS: '60'
    });
    const issues = collectRetentionConfigIssues(env);
    expect(issues).toEqual([]);
  });

  it('reports an ordering issue when SYNC_OPERATIONS_RETENTION_DAYS is set higher than AUDIT_LOGS_RETENTION_DAYS', () => {
    const env = buildValidBaseEnv({
      SYNC_OPERATIONS_RETENTION_DAYS: '400',
      AUDIT_LOGS_RETENTION_DAYS: '90'
    });
    const issues = collectRetentionConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/AUDIT_LOGS_RETENTION_DAYS/);
    expect(issues[0]).toMatch(/strictly greater than/);
  });

  it('reports an ordering issue when SYNC_OPERATIONS_RETENTION_DAYS equals AUDIT_LOGS_RETENTION_DAYS', () => {
    const env = buildValidBaseEnv({
      SYNC_OPERATIONS_RETENTION_DAYS: '90',
      AUDIT_LOGS_RETENTION_DAYS: '90'
    });
    const issues = collectRetentionConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/strictly greater than/);
  });

  it('reports an ordering issue against the default AUDIT_LOGS_RETENTION_DAYS (365) when SYNC_OPERATIONS_RETENTION_DAYS is set above it', () => {
    const env = buildValidBaseEnv({ SYNC_OPERATIONS_RETENTION_DAYS: '400' });
    const issues = collectRetentionConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/strictly greater than/);
  });

  it('reports a non-positive-integer issue for SYNC_OPERATIONS_RETENTION_DAYS (zero)', () => {
    const env = buildValidBaseEnv({ SYNC_OPERATIONS_RETENTION_DAYS: '0' });
    const issues = collectRetentionConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/SYNC_OPERATIONS_RETENTION_DAYS must be a positive integer/);
  });

  it('reports a non-positive-integer issue for AUDIT_LOGS_RETENTION_DAYS (negative)', () => {
    const env = buildValidBaseEnv({ AUDIT_LOGS_RETENTION_DAYS: '-5' });
    const issues = collectRetentionConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/AUDIT_LOGS_RETENTION_DAYS must be a positive integer/);
  });

  it('reports a non-positive-integer issue for a non-numeric value and skips the ordering check', () => {
    const env = buildValidBaseEnv({ SYNC_OPERATIONS_RETENTION_DAYS: 'not-a-number' });
    const issues = collectRetentionConfigIssues(env);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/SYNC_OPERATIONS_RETENTION_DAYS must be a positive integer/);
  });

  it('reports issues for both variables when both are invalid, without an additional ordering issue', () => {
    const env = buildValidBaseEnv({
      SYNC_OPERATIONS_RETENTION_DAYS: '0',
      AUDIT_LOGS_RETENTION_DAYS: '-1'
    });
    const issues = collectRetentionConfigIssues(env);
    expect(issues).toHaveLength(2);
    expect(issues.some((issue) => issue.includes('SYNC_OPERATIONS_RETENTION_DAYS'))).toBe(true);
    expect(issues.some((issue) => issue.includes('AUDIT_LOGS_RETENTION_DAYS'))).toBe(true);
  });
});

describe('validateConfig (Requirement 25.1/25.4 retention threshold gate integration)', () => {
  let exitSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('does not exit when both retention variables are unset', async () => {
    const env = buildValidBaseEnv();
    await validateConfig(env);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not exit when both retention variables are set validly', async () => {
    const env = buildValidBaseEnv({
      SYNC_OPERATIONS_RETENTION_DAYS: '30',
      AUDIT_LOGS_RETENTION_DAYS: '60'
    });
    await validateConfig(env);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero and logs the ordering issue when SYNC_OPERATIONS_RETENTION_DAYS is not less than AUDIT_LOGS_RETENTION_DAYS', async () => {
    const env = buildValidBaseEnv({
      SYNC_OPERATIONS_RETENTION_DAYS: '400',
      AUDIT_LOGS_RETENTION_DAYS: '90'
    });

    await validateConfig(env);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const loggedLines = mockLoggerInstance.error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedLines).toMatch(/AUDIT_LOGS_RETENTION_DAYS/);
    expect(loggedLines).toMatch(/strictly greater than/);
  });

  it('exits non-zero and logs the specific invalid variable for a non-positive-integer value', async () => {
    const env = buildValidBaseEnv({ AUDIT_LOGS_RETENTION_DAYS: 'forever' });

    await validateConfig(env);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const loggedLines = mockLoggerInstance.error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedLines).toMatch(/AUDIT_LOGS_RETENTION_DAYS must be a positive integer/);
  });
});

describe('validateConfig (Requirement 26.1/26.2 TAK Server credential gate integration)', () => {
  let exitSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('does not exit when TAK_SERVER_URL is unset', async () => {
    const env = buildValidBaseEnv();
    await validateConfig(env);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not exit when TAK_SERVER_URL is set with a complete credential pair', async () => {
    const env = buildValidBaseEnv({
      TAK_SERVER_URL: 'https://tak.example.com:8443',
      TAK_API_CERT_PATH: '/etc/tak/certs/client.pem',
      TAK_API_KEY_PATH: '/etc/tak/certs/client.key'
    });
    await validateConfig(env);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero and logs the specific missing variables when TAK_SERVER_URL is set without credentials', async () => {
    const env = buildValidBaseEnv({ TAK_SERVER_URL: 'https://tak.example.com:8443' });

    await validateConfig(env);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const loggedLines = mockLoggerInstance.error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedLines).toMatch(/TAK_API_P12_PATH/);
    expect(loggedLines).toMatch(/TAK_API_CERT_PATH/);
  });
});

describe('validateProductionSecrets', () => {
  it('is a no-op (returns no issues) when NODE_ENV is not production', async () => {
    const env = buildValidBaseEnv({ NODE_ENV: 'test', EMAIL_PASSWORD: '' });
    const issues = await validateProductionSecrets(env);
    expect(issues).toEqual([]);
  });

  it('is a no-op when NODE_ENV is unset', async () => {
    const env = buildValidBaseEnv({ EMAIL_PASSWORD: '' });
    delete env.NODE_ENV;
    const issues = await validateProductionSecrets(env);
    expect(issues).toEqual([]);
  });

  describe('with a working EnvSecretsProvider (NODE_ENV=production, SECRETS_PROVIDER unset)', () => {
    it('returns no issues when every production secret is present and non-empty', async () => {
      const env = buildValidBaseEnv({ NODE_ENV: 'production' });
      const issues = await validateProductionSecrets(env);
      expect(issues).toEqual([]);
    });

    it('reports an issue for a required secret that is present but empty', async () => {
      const env = buildValidBaseEnv({ NODE_ENV: 'production', EMAIL_PASSWORD: '' });
      const issues = await validateProductionSecrets(env);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/EMAIL_PASSWORD/);
      expect(issues[0]).toMatch(/missing or empty/);
    });

    it('reports every missing/empty secret, not just the first', async () => {
      const env = buildValidBaseEnv({
        NODE_ENV: 'production',
        DB_PASSWORD: '',
        EMAIL_PASSWORD: '   '
      });
      const issues = await validateProductionSecrets(env);
      expect(issues).toHaveLength(2);
      expect(issues.some((issue) => issue.includes('DB_PASSWORD'))).toBe(true);
      expect(issues.some((issue) => issue.includes('EMAIL_PASSWORD'))).toBe(true);
    });
  });

  describe('with a mocked-unreachable AwsSecretsManagerProvider (SECRETS_PROVIDER=aws-secrets-manager)', () => {
    // secretsProvider.js destructures `SecretsManagerClient` from
    // `@aws-sdk/client-secrets-manager` at require-time, so a `jest.spyOn`
    // applied after that module graph is already loaded would not affect
    // its already-bound local reference. `jest.isolateModules` +
    // `jest.doMock` re-requires the module graph fresh, with the mocked
    // SDK client wired in from the start.
    it('reports every production secret as unresolved when the provider is unreachable', async () => {
      let issues;
      let mockClient;
      let GetSecretValueCommandRef;

      await jest.isolateModulesAsync(async () => {
        mockClient = {
          send: jest.fn(async () => {
            throw new Error('getaddrinfo ENOTFOUND secretsmanager.us-east-1.amazonaws.com');
          })
        };

        jest.doMock('@aws-sdk/client-secrets-manager', () => {
          const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
          return {
            ...actual,
            SecretsManagerClient: jest.fn().mockImplementation(() => mockClient)
          };
        });

        GetSecretValueCommandRef = require('@aws-sdk/client-secrets-manager').GetSecretValueCommand;
        const isolatedConfigValidator = require('./configValidator');

        const env = buildValidBaseEnv({
          NODE_ENV: 'production',
          SECRETS_PROVIDER: 'aws-secrets-manager',
          AWS_REGION: 'us-east-1'
        });

        issues = await isolatedConfigValidator.validateProductionSecrets(env);
      });

      expect(issues).toHaveLength(4); // AUTHENTIK_ADMIN_TOKEN, JWT_SECRET, DB_PASSWORD, EMAIL_PASSWORD
      expect(issues.some((issue) => issue.includes('AUTHENTIK_ADMIN_TOKEN'))).toBe(true);
      expect(issues.some((issue) => issue.includes('JWT_SECRET'))).toBe(true);
      expect(issues.some((issue) => issue.includes('DB_PASSWORD'))).toBe(true);
      expect(issues.some((issue) => issue.includes('EMAIL_PASSWORD'))).toBe(true);
      expect(mockClient.send).toHaveBeenCalledTimes(4);
      expect(mockClient.send.mock.calls[0][0]).toBeInstanceOf(GetSecretValueCommandRef);
    });
  });
});

describe('validateConfig (Requirement 6.4 production secrets gate integration)', () => {
  let exitSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('does not exit when NODE_ENV=production and every secret resolves via EnvSecretsProvider', async () => {
    const env = buildValidBaseEnv({ NODE_ENV: 'production' });

    await validateConfig(env);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero and logs the specific secret when it is empty under EnvSecretsProvider', async () => {
    // EMAIL_PASSWORD is not in REQUIRED_VARS (Req 15.1), so this
    // exercises the production secrets gate itself rather than the
    // pre-existing synchronous presence check.
    const secretsOnlyEnv = buildValidBaseEnv({
      NODE_ENV: 'production',
      EMAIL_PASSWORD: ''
    });

    await validateConfig(secretsOnlyEnv);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const loggedLines = mockLoggerInstance.error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedLines).toMatch(/EMAIL_PASSWORD/);
  });

  it('exits non-zero listing every failing secret when the AWS provider is unreachable', async () => {
    await jest.isolateModulesAsync(async () => {
      const mockClient = {
        send: jest.fn(async () => {
          throw new Error('connection refused');
        })
      };

      jest.doMock('@aws-sdk/client-secrets-manager', () => {
        const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
        return {
          ...actual,
          SecretsManagerClient: jest.fn().mockImplementation(() => mockClient)
        };
      });

      const isolatedConfigValidator = require('./configValidator');

      const env = buildValidBaseEnv({
        NODE_ENV: 'production',
        SECRETS_PROVIDER: 'aws-secrets-manager',
        AWS_REGION: 'us-east-1'
      });

      await isolatedConfigValidator.validateConfig(env);
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const loggedLines = mockLoggerInstance.error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedLines).toMatch(/AUTHENTIK_ADMIN_TOKEN/);
    expect(loggedLines).toMatch(/JWT_SECRET/);
    expect(loggedLines).toMatch(/DB_PASSWORD/);
    expect(loggedLines).toMatch(/EMAIL_PASSWORD/);
  });

  it('skips the production secrets gate entirely when NODE_ENV is not production', async () => {
    // EMAIL_PASSWORD is not in REQUIRED_VARS (Req 15.1), so leaving it
    // empty here exercises ONLY the production secrets gate's own
    // skip-when-not-production behavior, not the pre-existing synchronous
    // presence check (which DB_PASSWORD, a REQUIRED_VARS member, would
    // trigger regardless of NODE_ENV if left empty).
    const env = buildValidBaseEnv({
      NODE_ENV: 'test',
      EMAIL_PASSWORD: ''
    });

    await validateConfig(env);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('skips the production secrets gate when NODE_ENV is unset', async () => {
    const env = buildValidBaseEnv({ EMAIL_PASSWORD: '' });
    delete env.NODE_ENV;

    await validateConfig(env);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still performs the existing synchronous checks unaffected by the secrets gate addition', async () => {
    const env = buildValidBaseEnv({ NODE_ENV: 'production', JWT_SECRET: 'too-short' });

    await validateConfig(env);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const loggedLines = mockLoggerInstance.error.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedLines).toMatch(/JWT_SECRET must be at least 32 characters/);
  });
});

/**
 * Property-based tests (design.md's "Property-Based Tests" section),
 * implemented with `fast-check` via `@fast-check/jest`'s `test.prop`
 * integration. Each test below runs a minimum of 100 iterations (fast-check's
 * default `numRuns` is 100; `numRuns: 100` is set explicitly here for
 * clarity/documentation purposes rather than relying on the implicit
 * default).
 *
 * These tests exercise the REAL exported `isWellFormedUrl`/`isValidJwtExpiry`
 * predicates from `./configValidator` (imported above) against an
 * independently-computed reference/oracle -- the oracle logic is
 * deliberately re-derived here (not imported from the module under test),
 * so a bug in the real implementation cannot also be "baked into" the
 * check that's supposed to catch it.
 */

// Feature: production-hardening, Property 8: URL well-formedness predicate
describe('Property 8: URL well-formedness predicate (isWellFormedUrl)', () => {
  /**
   * Independently-computed reference check: a string is a well-formed URL
   * iff it parses via `new URL()` with an http/https scheme and a
   * non-empty host. Mirrors design.md's Property 8 statement exactly,
   * without reusing any logic from `configValidator.js` itself.
   */
  function referenceIsWellFormedUrl(input) {
    if (typeof input !== 'string' || input.trim().length === 0) {
      return false;
    }
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      return false;
    }
    const scheme = parsed.protocol.replace(':', '');
    return (scheme === 'http' || scheme === 'https') && parsed.host.length > 0;
  }

  // A mix of well-formed http/https URLs, non-http(s)-scheme URLs (ftp,
  // mailto, javascript, file), a corpus of known near-miss/edge-case
  // strings (empty, whitespace-only, relative paths, scheme-less), and
  // fully arbitrary strings -- so the generator covers both "realistic"
  // near-misses and unconstrained fuzzing input.
  const wellFormedHttpUrlArb = fc.webUrl({ validSchemes: ['http', 'https'] });
  const nonHttpSchemeUrlArb = fc.oneof(
    fc.webUrl({ validSchemes: ['ftp'] }),
    fc.constantFrom(
      'mailto:someone@example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://files.example.com/path'
    )
  );
  const nearMissStringArb = fc.constantFrom(
    '',
    ' ',
    '   ',
    'not a url',
    '//example.com',
    'http://',
    'https://',
    'relative/path',
    '/absolute/path',
    'example.com',
    'http:example.com',
    'ht!tp://example.com'
  );
  const arbitraryStringArb = fc.string();

  const anyUrlLikeInputArb = fc.oneof(
    wellFormedHttpUrlArb,
    nonHttpSchemeUrlArb,
    nearMissStringArb,
    arbitraryStringArb
  );

  test.prop([anyUrlLikeInputArb], { numRuns: 100 })(
    'matches an independently-computed http/https+non-empty-host reference check, and never throws',
    (input) => {
      const expected = referenceIsWellFormedUrl(input);

      let actual;
      expect(() => {
        actual = isWellFormedUrl(input);
      }).not.toThrow();

      expect(actual).toBe(expected);
    }
  );

  // Seed corpus: a few named, human-legible examples alongside the
  // randomized run above, matching the "well-formed absolute http/https
  // URL with non-empty host" vs. "not" boundary called out in design.md.
  it.each([
    ['https://authentik.example.com', true],
    ['http://app.example.com:3000', true],
    ['ftp://files.example.com', false],
    ['mailto:someone@example.com', false],
    ['javascript:alert(1)', false],
    ['', false],
    ['   ', false],
    ['not-a-url', false],
    ['//example.com', false],
    ['http://', false]
  ])('isWellFormedUrl(%j) === %j', (input, expected) => {
    expect(isWellFormedUrl(input)).toBe(expected);
  });
});

// Feature: production-hardening, Property 9: JWT expiry duration bounds
describe('Property 9: JWT expiry duration bounds (isValidJwtExpiry)', () => {
  const MIN_MS = 5 * 60 * 1000; // 5 minutes
  const MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const UNIT_MS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };

  /**
   * Independently-computed reference parser/predicate, re-derived from
   * design.md's/`parseDurationMs`'s documented accepted formats (a bare
   * number of seconds, or `<number><unit>` for s/m/h/d/w) without reusing
   * `configValidator.js`'s own `parseDurationMs`/`isValidJwtExpiry`
   * implementation.
   */
  function referenceParseDurationMs(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value * 1000 : null;
    }
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return parseFloat(trimmed) * 1000;
    }
    const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(trimmed);
    if (!match) {
      return null;
    }
    const amount = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    return amount * UNIT_MS[unit];
  }

  function referenceIsValidJwtExpiry(value) {
    const ms = referenceParseDurationMs(value);
    if (ms === null || !Number.isFinite(ms)) {
      return false;
    }
    return ms >= MIN_MS && ms <= MAX_MS;
  }

  // Well-formed duration strings spanning below-min, in-bounds, and
  // above-max, across every accepted unit (s/m/h/d/w) plus bare-number
  // (seconds) form -- deliberately generated near the 5-minute/30-day
  // boundary as well as far outside it.
  const unitArb = fc.constantFrom('s', 'm', 'h', 'd', 'w');
  const boundaryAwareAmountArb = fc.oneof(
    fc.double({ min: 0, max: 45, noNaN: true }), // small amounts, likely below 5 minutes for larger units
    fc.double({ min: 0.001, max: 2, noNaN: true }), // amounts very close to a boundary once combined with a unit
    fc.nat({ max: 100 })
  );
  const durationStringArb = fc
    .tuple(boundaryAwareAmountArb, unitArb)
    .map(([amount, unit]) => `${amount}${unit}`);
  const bareNumberSecondsArb = fc.oneof(
    fc.nat({ max: 3_000_000 }),
    fc.double({ min: 0, max: 3_000_000, noNaN: true }),
    fc.nat({ max: 3_000_000 }).map((n) => String(n))
  );
  const garbageStringArb = fc.string();

  const anyDurationLikeInputArb = fc.oneof(
    durationStringArb,
    bareNumberSecondsArb,
    garbageStringArb
  );

  test.prop([anyDurationLikeInputArb], { numRuns: 100 })(
    'matches an independently-computed 5-minute..30-day bounds reference check, and never throws',
    (input) => {
      const expected = referenceIsValidJwtExpiry(input);

      let actual;
      expect(() => {
        actual = isValidJwtExpiry(input);
      }).not.toThrow();

      expect(actual).toBe(expected);
    }
  );

  // Seed corpus: named boundary examples (just below 5 minutes, exactly at
  // the 5-minute/30-day boundaries, comfortably in-range, and strictly
  // above 30 days), matching design.md's "some strictly below 5 minutes,
  // some between 5 minutes and 30 days inclusive, some strictly above 30
  // days" guidance.
  it.each([
    ['4m', false], // 4 minutes, strictly below the 5-minute minimum
    ['299s', false], // 299 seconds, strictly below 300s (5 minutes)
    ['300s', true], // exactly 5 minutes
    ['5m', true], // exactly 5 minutes
    ['1h', true],
    ['7d', true],
    ['30d', true], // exactly 30 days
    ['31d', false], // strictly above 30 days
    ['720h', true], // 30 days expressed in hours
    ['721h', false], // strictly above 30 days
    ['3600', true], // bare number of seconds (1 hour)
    ['not-a-duration', false],
    ['', false],
    [undefined, false]
  ])('isValidJwtExpiry(%j) === %j', (input, expected) => {
    expect(isValidJwtExpiry(input)).toBe(expected);
  });
});

/**
 * Requirement 15.5 (BUG-018): WHERE the App or Sync_Worker is started
 * with NODE_ENV=production, a warning identifying that TLS certificate
 * validation is disabled for the database pool must be logged at
 * startup, mirroring `server/config/database.js`'s unconditional
 * `ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false`.
 * This must be a warning only -- it must never cause `validateConfig` to
 * exit non-zero.
 */
describe('isDatabaseTlsCertificateValidationDisabled / warnIfDatabaseTlsCertificateValidationDisabled (Requirement 15.5, BUG-018)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is false when NODE_ENV is not production', () => {
    expect(isDatabaseTlsCertificateValidationDisabled({ NODE_ENV: 'test' })).toBe(false);
    expect(isDatabaseTlsCertificateValidationDisabled({})).toBe(false);
  });

  it('is true when NODE_ENV is production', () => {
    expect(isDatabaseTlsCertificateValidationDisabled({ NODE_ENV: 'production' })).toBe(true);
  });

  it('does not log a warning when NODE_ENV is not production', () => {
    warnIfDatabaseTlsCertificateValidationDisabled({ NODE_ENV: 'test' });
    expect(mockLoggerInstance.warn).not.toHaveBeenCalled();
  });

  it('logs a warning identifying disabled TLS certificate validation when NODE_ENV is production', () => {
    warnIfDatabaseTlsCertificateValidationDisabled({ NODE_ENV: 'production' });
    expect(mockLoggerInstance.warn).toHaveBeenCalledTimes(1);
    expect(mockLoggerInstance.warn.mock.calls[0][0]).toMatch(/TLS certificate validation is disabled/);
  });
});

describe('validateConfig (Requirement 15.5 TLS certificate validation warning integration, BUG-018)', () => {
  let exitSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('logs the TLS warning but does not exit when NODE_ENV=production and config is otherwise valid', async () => {
    const env = buildValidBaseEnv({ NODE_ENV: 'production' });

    await validateConfig(env);

    expect(mockLoggerInstance.warn).toHaveBeenCalledTimes(1);
    expect(mockLoggerInstance.warn.mock.calls[0][0]).toMatch(/TLS certificate validation is disabled/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not log the TLS warning when NODE_ENV is not production', async () => {
    const env = buildValidBaseEnv();

    await validateConfig(env);

    expect(mockLoggerInstance.warn).not.toHaveBeenCalled();
  });

  it('still logs the TLS warning even when another check fails and validateConfig exits non-zero', async () => {
    const env = buildValidBaseEnv({ NODE_ENV: 'production', JWT_SECRET: 'too-short' });

    await validateConfig(env);

    expect(mockLoggerInstance.warn).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

/**
 * Requirement 1 Criterion 5 (BUG-019): correct APP_URL/FRONTEND_URL
 * configuration alone must not be treated as sufficient evidence that
 * authentication is functional -- there must be an explicit startup
 * assertion that a route module is mounted at '/api/auth'.
 */
describe('isAuthRouteMounted / assertAuthRouteMounted (Requirement 1 Criterion 5, BUG-019)', () => {
  const express = require('express');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true when a router is mounted at /api/auth', () => {
    const app = express();
    app.use('/api/auth', express.Router());
    expect(isAuthRouteMounted(app)).toBe(true);
  });

  it('returns true when a router is mounted at /api/auth alongside other routes', () => {
    const app = express();
    app.use('/api/teams', express.Router());
    app.use('/api/auth', express.Router());
    app.use('/api/users', express.Router());
    expect(isAuthRouteMounted(app)).toBe(true);
  });

  it('returns false when no router is mounted at /api/auth', () => {
    const app = express();
    app.use('/api/teams', express.Router());
    app.use('/api/users', express.Router());
    expect(isAuthRouteMounted(app)).toBe(false);
  });

  it('returns false for a freshly constructed app with no routes at all', () => {
    const app = express();
    // Force _router to exist without any mounted routes: express only
    // lazily initializes app._router on the first app.use()/route call,
    // so mount something unrelated to exercise the "present but no
    // /api/auth entry" path distinctly from an app with no _router yet.
    app.use('/unrelated', express.Router());
    expect(isAuthRouteMounted(app)).toBe(false);
  });

  it('returns false when app._router does not exist yet', () => {
    const app = express();
    expect(isAuthRouteMounted(app)).toBe(false);
  });

  it('does not exit when a router is mounted at /api/auth', () => {
    const app = express();
    app.use('/api/auth', express.Router());

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      assertAuthRouteMounted(app);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(mockLoggerInstance.error).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('logs a descriptive error and exits non-zero when no router is mounted at /api/auth', () => {
    const app = express();
    app.use('/api/teams', express.Router());

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      assertAuthRouteMounted(app);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockLoggerInstance.error).toHaveBeenCalledTimes(1);
      expect(mockLoggerInstance.error.mock.calls[0][0]).toMatch(/\/api\/auth/);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
