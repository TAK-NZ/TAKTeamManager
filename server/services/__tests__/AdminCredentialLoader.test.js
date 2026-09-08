/**
 * Unit tests for the Admin_Credential_Loader
 * (`server/services/AdminCredentialLoader.js`), device-management task 3.4.
 *
 * Covers Requirements 2.1 (source selection), 2.2 (Binary_Secret_Read),
 * 2.4 (P12_Passphrase default/override), 2.5 + 2.12 (legacy-algorithm
 * PKCS#12 -> PEM conversion without the OpenSSL legacy provider),
 * 2.9 (file source builds from `buildMutualTlsAgentOptions`; the
 * secrets-manager source never touches file/environment credentials),
 * 2.10 (a failed `refresh()` retains the cached credential and never throws),
 * and 2.11 (no credential material or passphrase is ever logged).
 *
 * Deliberately does NOT mock `fs`, `node-forge`, or `tls`: the conversion and
 * the file-source path are exercised against a real committed
 * legacy-algorithm PKCS#12 fixture (`fixtures/legacy-admin.p12`) and real
 * temporary PEM files, so the tests validate actual credential handling
 * rather than a stubbed approximation of it. Only the Secrets_Provider (an
 * AWS boundary), the shared `TakServerService` (whose agent rebuild is task
 * 4.1's concern), and the Structured_Logger are substituted.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');

const forge = require('node-forge');

const mockLoggerInstance = {
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn()
};
jest.mock('../../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const TakServerService = require('../TakServerService');
const AdminCredentialLoader = require('../AdminCredentialLoader');
const {
  convertP12ToPem,
  agentOptionsEqual,
  SOURCE_SECRETS_MANAGER,
  SOURCE_FILE,
  DEFAULT_P12_PASSPHRASE
} = AdminCredentialLoader;

/**
 * The committed legacy-algorithm PKCS#12 fixture: a throwaway self-signed
 * RSA cert/key pair (`CN=takteammanager-test-admin`) exported with
 * `openssl pkcs12 -export -legacy -certpbe PBE-SHA1-RC2-40
 * -keypbe PBE-SHA1-3DES -macalg sha1`, i.e. the RC2/3DES combination
 * Requirement 2.12 names and the reference TAK admin bundle uses. It carries
 * no real credential -- it exists only so the conversion is tested against a
 * genuinely legacy bundle rather than a modern (AES) one that would load
 * directly and prove nothing.
 */
const FIXTURE_P12_PATH = path.join(__dirname, 'fixtures', 'legacy-admin.p12');
const FIXTURE_P12_PASSPHRASE = DEFAULT_P12_PASSPHRASE;
const FIXTURE_CERT_CN = 'takteammanager-test-admin';

const SECRET_ARN =
  'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:tak/admin-cert-AbCdEf';

let legacyP12;

/** Real on-disk PEM material for the `file`-source tests. */
let fileFixtures;

/**
 * Writes real cert/key/CA files to a temp directory so the `file` source can
 * be exercised through `buildMutualTlsAgentOptions`'s actual `readFileSync`
 * calls. Uses the fixture bundle's own converted material so the files are
 * valid PEM rather than arbitrary bytes.
 *
 * @returns {{dir: string, certPath: string, keyPath: string, caPath: string,
 *   cert: string, key: string}}
 */
function writeFileSourceFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-cred-loader-'));
  const { cert, key } = convertP12ToPem(legacyP12, FIXTURE_P12_PASSPHRASE);

  const certPath = path.join(dir, 'client.pem');
  const keyPath = path.join(dir, 'client.key');
  const caPath = path.join(dir, 'ca.pem');

  fs.writeFileSync(certPath, cert);
  fs.writeFileSync(keyPath, key);
  fs.writeFileSync(caPath, cert);

  return { dir, certPath, keyPath, caPath, cert, key };
}

/**
 * A Secrets_Provider stub exposing only the Binary_Secret_Read the
 * secrets-manager path uses (Requirement 2.2). `getSecret` is included and
 * asserted-unused so a regression that reached for the string read instead
 * would be caught.
 *
 * @param {Buffer | Error} [result] bytes to return, or an error to reject with.
 * @returns {{getSecretBinary: jest.Mock, getSecret: jest.Mock}}
 */
function makeSecretsProvider(result = legacyP12) {
  return {
    getSecretBinary: jest.fn(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    ),
    getSecret: jest.fn(() => Promise.resolve('unused'))
  };
}

/**
 * A stand-in for the shared `TakServerService`, recording the agent rebuilds
 * `refresh()` triggers (Requirements 2.7, 2.8) without constructing a real
 * axios client.
 *
 * @param {{failOnRefresh?: boolean}} [options]
 */
function makeTakServerService({ failOnRefresh = false } = {}) {
  return {
    refreshAgent: jest.fn(() => {
      if (failOnRefresh) {
        throw new Error('agent rebuild failed');
      }
    })
  };
}

/**
 * Every value passed to the mocked Structured_Logger across all levels,
 * flattened to comparable strings so Requirement 2.11 can be checked against
 * the whole log surface rather than one hand-picked call. Errors contribute
 * their message and stack; Buffers contribute both their utf8 and base64
 * renderings, so credential bytes cannot hide behind an encoding.
 *
 * @returns {string[]}
 */
function collectLoggedStrings() {
  const collected = [];

  const visit = (value, depth = 0) => {
    if (value === null || value === undefined || depth > 8) {
      return;
    }
    if (typeof value === 'string') {
      collected.push(value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      collected.push(String(value));
      return;
    }
    if (Buffer.isBuffer(value)) {
      collected.push(value.toString('utf8'), value.toString('base64'));
      return;
    }
    if (value instanceof Error) {
      collected.push(String(value.message), String(value.stack));
      // An error may also carry a `cause` chain and arbitrary own fields.
      visit(value.cause, depth + 1);
      Object.values(value).forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach((entry) => visit(entry, depth + 1));
    }
  };

  Object.values(mockLoggerInstance).forEach((level) => {
    level.mock.calls.forEach((args) => visit(args));
  });

  return collected;
}

beforeAll(() => {
  legacyP12 = fs.readFileSync(FIXTURE_P12_PATH);
  fileFixtures = writeFileSourceFixtures();
});

afterAll(() => {
  if (fileFixtures) {
    fs.rmSync(fileFixtures.dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AdminCredentialLoader.selectSource (Requirement 2.1)', () => {
  it('selects secrets-manager for the exact value "secrets-manager"', () => {
    const loader = new AdminCredentialLoader({
      env: { TAK_ADMIN_CERT_SOURCE: 'secrets-manager' },
      secretsProvider: makeSecretsProvider()
    });

    expect(loader.selectSource()).toBe(SOURCE_SECRETS_MANAGER);
  });

  it('selects file for the explicit value "file"', () => {
    const loader = new AdminCredentialLoader({
      env: { TAK_ADMIN_CERT_SOURCE: 'file' },
      secretsProvider: makeSecretsProvider()
    });

    expect(loader.selectSource()).toBe(SOURCE_FILE);
  });

  it('defaults to file when TAK_ADMIN_CERT_SOURCE is unset', () => {
    const loader = new AdminCredentialLoader({
      env: {},
      secretsProvider: makeSecretsProvider()
    });

    expect(loader.selectSource()).toBe(SOURCE_FILE);
  });

  // The default must preserve current behavior rather than fail closed, so
  // every unrecognized value -- including a near-miss typo and a
  // case-variant -- resolves to `file`.
  it.each([
    ['SECRETS-MANAGER', 'a case variant'],
    ['secrets_manager', 'an underscore typo'],
    [' secrets-manager ', 'a padded value'],
    ['aws', 'an unrelated value'],
    ['', 'an empty value']
  ])('resolves %p (%s) to file', (value) => {
    const loader = new AdminCredentialLoader({
      env: { TAK_ADMIN_CERT_SOURCE: value },
      secretsProvider: makeSecretsProvider()
    });

    expect(loader.selectSource()).toBe(SOURCE_FILE);
  });

  it('reads the supplied env argument in preference to the instance env', () => {
    const loader = new AdminCredentialLoader({
      env: { TAK_ADMIN_CERT_SOURCE: 'file' },
      secretsProvider: makeSecretsProvider()
    });

    expect(loader.selectSource({ TAK_ADMIN_CERT_SOURCE: 'secrets-manager' })).toBe(
      SOURCE_SECRETS_MANAGER
    );
  });
});

// The binary-P12 read must use the AWS Secrets Manager provider DIRECTLY when
// the source is secrets-manager, independent of the global SECRETS_PROVIDER
// switch (which is deliberately left unset so the app's env-secret startup
// validation keeps working). Verified by the default provider the loader
// selects when none is injected.
describe('AdminCredentialLoader default provider selection (SECRETS_PROVIDER decoupling)', () => {
  const { AwsSecretsManagerProvider, EnvSecretsProvider } = require('../../config/secretsProvider');

  it('uses the AWS Secrets Manager provider for a secrets-manager source, even with SECRETS_PROVIDER unset', () => {
    const loader = new AdminCredentialLoader({
      // No secretsProvider injected; SECRETS_PROVIDER intentionally absent.
      env: { TAK_ADMIN_CERT_SOURCE: 'secrets-manager', AWS_REGION: 'us-west-2' }
    });

    expect(loader.secretsProvider).toBeInstanceOf(AwsSecretsManagerProvider);
  });

  it('uses the env-based provider for a file source (no AWS client constructed)', () => {
    const loader = new AdminCredentialLoader({
      env: { TAK_ADMIN_CERT_SOURCE: 'file' }
    });

    expect(loader.secretsProvider).toBeInstanceOf(EnvSecretsProvider);
  });

  it('still honours an explicitly injected provider (tests) over the source-based default', () => {
    const injected = makeSecretsProvider();
    const loader = new AdminCredentialLoader({
      env: { TAK_ADMIN_CERT_SOURCE: 'secrets-manager', AWS_REGION: 'us-west-2' },
      secretsProvider: injected
    });

    expect(loader.secretsProvider).toBe(injected);
  });
});

describe('AdminCredentialLoader.load from secrets-manager (Requirements 2.2, 2.5, 2.12)', () => {
  it('reads the bundle via getSecretBinary and caches PEM { cert, key }', async () => {
    const secretsProvider = makeSecretsProvider();
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
      },
      secretsProvider
    });

    await loader.load();

    // Requirement 2.2: the Binary_Secret_Read, against the configured ARN.
    expect(secretsProvider.getSecretBinary).toHaveBeenCalledTimes(1);
    expect(secretsProvider.getSecretBinary).toHaveBeenCalledWith(SECRET_ARN);
    expect(secretsProvider.getSecret).not.toHaveBeenCalled();

    // Requirement 2.5: cached as `{ cert, key }` PEM, not as a raw `pfx`.
    const options = loader.getAgentOptions();
    expect(Object.keys(options).sort()).toEqual(['cert', 'key']);
    expect(options.cert).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(options.key).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);
    expect(options.pfx).toBeUndefined();
    expect(options.passphrase).toBeUndefined();
  });

  it('trims a padded secret id before the Binary_Secret_Read', async () => {
    const secretsProvider = makeSecretsProvider();
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: `  ${SECRET_ARN}  `
      },
      secretsProvider
    });

    await loader.load();

    expect(secretsProvider.getSecretBinary).toHaveBeenCalledWith(SECRET_ARN);
  });

  it('adds { ca } when a CA bundle is configured (Requirement 2.5)', async () => {
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN,
        TAK_CA_PATH: fileFixtures.caPath
      },
      secretsProvider: makeSecretsProvider()
    });

    await loader.load();

    const options = loader.getAgentOptions();
    expect(Object.keys(options).sort()).toEqual(['ca', 'cert', 'key']);
    expect(options.ca.toString('utf8')).toBe(fileFixtures.cert);
  });

  it('getAgentOptions is null until the first successful load', async () => {
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
      },
      secretsProvider: makeSecretsProvider()
    });

    expect(loader.getAgentOptions()).toBeNull();

    await loader.load();

    expect(loader.getAgentOptions()).not.toBeNull();
  });

  it('throws a descriptive error when the secret id is missing', async () => {
    const secretsProvider = makeSecretsProvider();
    const loader = new AdminCredentialLoader({
      env: { TAK_ADMIN_CERT_SOURCE: 'secrets-manager' },
      secretsProvider
    });

    await expect(loader.load()).rejects.toThrow(/TAK_ADMIN_CERT_SECRET_ARN is not set/);
    expect(secretsProvider.getSecretBinary).not.toHaveBeenCalled();
  });

  it('throws when the binary secret yields no bytes', async () => {
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
      },
      secretsProvider: makeSecretsProvider(Buffer.alloc(0))
    });

    await expect(loader.load()).rejects.toThrow(/did not yield any PKCS#12 bytes/);
  });
});

describe('convertP12ToPem on a legacy-algorithm bundle (Requirements 2.5, 2.12)', () => {
  it('converts the RC2/3DES fixture to PEM that Node\'s TLS stack accepts', () => {
    const { cert, key } = convertP12ToPem(legacyP12, FIXTURE_P12_PASSPHRASE);

    expect(cert).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(key).toMatch(/^-----BEGIN RSA PRIVATE KEY-----/);

    // The converted material is genuinely usable as a mutual-TLS client
    // credential -- not merely PEM-shaped text.
    expect(() => tls.createSecureContext({ cert, key })).not.toThrow();
  });

  // Requirement 2.12's whole point: the fixture uses algorithms OpenSSL 3
  // will not touch unless the legacy provider is explicitly enabled, so
  // handing it to Node as `pfx` fails while the node-forge conversion above
  // succeeds on the same stock runtime. If this ever stops throwing, the
  // fixture has lost its legacy algorithms (or the runtime enabled the
  // legacy provider) and no longer proves the requirement.
  it('is a bundle Node cannot open directly as pfx without the OpenSSL legacy provider', () => {
    expect(() =>
      tls.createSecureContext({ pfx: legacyP12, passphrase: FIXTURE_P12_PASSPHRASE })
    ).toThrow();
  });

  it('returns the leaf certificate matching the bundle private key', () => {
    const { cert } = convertP12ToPem(legacyP12, FIXTURE_P12_PASSPHRASE);

    // The subject is the fixture's own throwaway CN, confirming the leaf (not
    // some unrelated chain entry) was selected.
    const parsed = forge.pki.certificateFromPem(cert);
    expect(parsed.subject.getField('CN').value).toBe(FIXTURE_CERT_CN);
  });

  it('rejects a wrong passphrase with a descriptive error', () => {
    expect(() => convertP12ToPem(legacyP12, 'not-the-passphrase')).toThrow(
      /failed to open the PKCS#12 admin credential bundle/
    );
  });

  it('rejects bytes that are not a PKCS#12 bundle', () => {
    expect(() => convertP12ToPem(Buffer.from('not a p12 at all'), FIXTURE_P12_PASSPHRASE)).toThrow(
      /failed to open the PKCS#12 admin credential bundle/
    );
  });
});

describe('AdminCredentialLoader P12_Passphrase resolution (Requirement 2.4)', () => {
  it('defaults to atakatak when TAK_ADMIN_CERT_PASSPHRASE is unset', () => {
    const loader = new AdminCredentialLoader({
      env: { TAK_ADMIN_CERT_SOURCE: 'secrets-manager' },
      secretsProvider: makeSecretsProvider()
    });

    expect(DEFAULT_P12_PASSPHRASE).toBe('atakatak');
    expect(loader.resolvePassphrase()).toBe('atakatak');
  });

  it('uses TAK_ADMIN_CERT_PASSPHRASE when set', () => {
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_PASSPHRASE: 'rotated-passphrase'
      },
      secretsProvider: makeSecretsProvider()
    });

    expect(loader.resolvePassphrase()).toBe('rotated-passphrase');
  });

  it('treats a blank override as unset and falls back to the default', () => {
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_PASSPHRASE: '   '
      },
      secretsProvider: makeSecretsProvider()
    });

    expect(loader.resolvePassphrase()).toBe(DEFAULT_P12_PASSPHRASE);
  });

  // The default passphrase actually opens the fixture (which was exported
  // with `atakatak`), while an override is actually applied to the bundle --
  // so the override is wired through to the conversion, not merely returned
  // by the resolver.
  it('opens the fixture with the default passphrase and fails with a wrong override', async () => {
    const env = {
      TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
      TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
    };

    const withDefault = new AdminCredentialLoader({
      env,
      secretsProvider: makeSecretsProvider()
    });
    await expect(withDefault.load()).resolves.toBeUndefined();
    expect(withDefault.getAgentOptions().cert).toMatch(/BEGIN CERTIFICATE/);

    const withOverride = new AdminCredentialLoader({
      env: { ...env, TAK_ADMIN_CERT_PASSPHRASE: 'wrong-passphrase' },
      secretsProvider: makeSecretsProvider()
    });
    await expect(withOverride.load()).rejects.toThrow(
      /failed to open the PKCS#12 admin credential bundle/
    );
  });
});

describe('AdminCredentialLoader.load from file (Requirement 2.9)', () => {
  it('builds the agent options from buildMutualTlsAgentOptions', async () => {
    const spy = jest.spyOn(TakServerService, 'buildMutualTlsAgentOptions');
    const env = {
      TAK_ADMIN_CERT_SOURCE: 'file',
      TAK_API_CERT_PATH: fileFixtures.certPath,
      TAK_API_KEY_PATH: fileFixtures.keyPath
    };

    const secretsProvider = makeSecretsProvider();
    const loader = new AdminCredentialLoader({ env, secretsProvider });

    await loader.load();

    expect(spy).toHaveBeenCalledWith(env);
    expect(loader.getAgentOptions()).toEqual(
      TakServerService.buildMutualTlsAgentOptions(env)
    );
    expect(loader.getAgentOptions().cert.toString('utf8')).toBe(fileFixtures.cert);
    // No Secrets Manager read happens on the file path.
    expect(secretsProvider.getSecretBinary).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('preserves the pfx/passphrase shape buildMutualTlsAgentOptions produces', async () => {
    const env = {
      TAK_API_P12_PATH: FIXTURE_P12_PATH,
      TAK_API_P12_PASSPHRASE: FIXTURE_P12_PASSPHRASE
    };

    const loader = new AdminCredentialLoader({
      env,
      secretsProvider: makeSecretsProvider()
    });

    await loader.load();

    // The file source is passed through verbatim: no PEM conversion, no
    // reshaping. The bundle is handed to Node exactly as it is today.
    const options = loader.getAgentOptions();
    expect(Object.keys(options).sort()).toEqual(['passphrase', 'pfx']);
    expect(options.pfx.equals(legacyP12)).toBe(true);
    expect(options.passphrase).toBe(FIXTURE_P12_PASSPHRASE);
  });

  it('never reads file or environment credentials when the source is secrets-manager', async () => {
    const spy = jest.spyOn(TakServerService, 'buildMutualTlsAgentOptions');
    const readFileSync = jest.spyOn(fs, 'readFileSync');

    // Every file/environment credential variable is set, and each path is
    // deliberately nonexistent: touching any of them would throw ENOENT
    // rather than quietly succeed.
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN,
        TAK_API_P12_PATH: '/nonexistent/admin.p12',
        TAK_API_P12_PASSPHRASE: 'file-passphrase',
        TAK_API_CERT_PATH: '/nonexistent/client.pem',
        TAK_API_KEY_PATH: '/nonexistent/client.key'
      },
      secretsProvider: makeSecretsProvider()
    });

    await loader.load();

    expect(spy).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();

    // And the cached credential is the converted secret, not file material.
    const options = loader.getAgentOptions();
    expect(Object.keys(options).sort()).toEqual(['cert', 'key']);
    expect(options.passphrase).toBeUndefined();

    readFileSync.mockRestore();
    spy.mockRestore();
  });
});

describe('AdminCredentialLoader.refresh (Requirements 2.7, 2.10)', () => {
  /**
   * A `file`-source loader. Rotation is simulated by rewriting the on-disk
   * PEM, which is how a real credential rotation presents itself on this
   * path -- no second fixture bundle needed.
   *
   * @param {string} certPath
   * @param {string} keyPath
   * @param {object} [takServerService]
   * @returns {AdminCredentialLoader}
   */
  function makeFileLoader(certPath, keyPath, takServerService) {
    return new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'file',
        TAK_API_CERT_PATH: certPath,
        TAK_API_KEY_PATH: keyPath
      },
      secretsProvider: makeSecretsProvider(),
      takServerService
    });
  }

  it('swaps the cache and rebuilds the shared agent when the material changed', async () => {
    const takServerService = makeTakServerService();
    const loader = makeFileLoader(
      fileFixtures.certPath,
      fileFixtures.keyPath,
      takServerService
    );

    await loader.load();
    const before = loader.getAgentOptions();

    // Rotate the on-disk credential.
    fs.writeFileSync(fileFixtures.certPath, `${fileFixtures.cert}\n# rotated\n`);

    await expect(loader.refresh()).resolves.toBe(true);

    expect(loader.getAgentOptions()).not.toEqual(before);
    expect(takServerService.refreshAgent).toHaveBeenCalledTimes(1);

    // Restore the fixture for the remaining tests in this block.
    fs.writeFileSync(fileFixtures.certPath, fileFixtures.cert);
  });

  it('reports no change and leaves the shared agent alone for identical material', async () => {
    const takServerService = makeTakServerService();
    const loader = makeFileLoader(
      fileFixtures.certPath,
      fileFixtures.keyPath,
      takServerService
    );

    await loader.load();

    await expect(loader.refresh()).resolves.toBe(false);
    expect(takServerService.refreshAgent).not.toHaveBeenCalled();
  });

  it('retains the cached credential and does not throw when the reload fails', async () => {
    const takServerService = makeTakServerService();
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
      },
      secretsProvider: makeSecretsProvider(),
      takServerService
    });

    await loader.load();
    const cached = loader.getAgentOptions();
    expect(cached).not.toBeNull();

    // Simulate a Secrets Manager outage on the refresh read.
    loader.secretsProvider.getSecretBinary.mockRejectedValue(
      new Error('Secrets Manager unavailable')
    );

    await expect(loader.refresh()).resolves.toBe(false);

    // Requirement 2.10: the previously cached credential is untouched, and
    // the failure was logged rather than thrown.
    expect(loader.getAgentOptions()).toBe(cached);
    expect(takServerService.refreshAgent).not.toHaveBeenCalled();
    expect(mockLoggerInstance.error).toHaveBeenCalledTimes(1);
  });

  it('never throws for any reload failure mode and keeps retrying', async () => {
    const takServerService = makeTakServerService();
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
      },
      secretsProvider: makeSecretsProvider(),
      takServerService
    });

    await loader.load();
    const cached = loader.getAgentOptions();

    const failures = [
      new Error('network timeout'),
      Object.assign(new Error('AccessDeniedException'), { name: 'AccessDeniedException' })
    ];

    for (const failure of failures) {
      loader.secretsProvider.getSecretBinary.mockRejectedValueOnce(failure);
      await expect(loader.refresh()).resolves.toBe(false);
      expect(loader.getAgentOptions()).toBe(cached);
    }

    // A bundle that will not open is a failure too, not a crash: empty bytes
    // and undecryptable bytes both leave the cache in place.
    loader.secretsProvider.getSecretBinary.mockResolvedValueOnce(Buffer.alloc(0));
    await expect(loader.refresh()).resolves.toBe(false);
    expect(loader.getAgentOptions()).toBe(cached);

    loader.secretsProvider.getSecretBinary.mockResolvedValueOnce(Buffer.from('garbage'));
    await expect(loader.refresh()).resolves.toBe(false);
    expect(loader.getAgentOptions()).toBe(cached);

    // Once the source recovers, the very next refresh succeeds -- the failed
    // attempts left no poisoned state behind.
    loader.secretsProvider.getSecretBinary.mockResolvedValue(legacyP12);
    await expect(loader.refresh()).resolves.toBe(false); // unchanged material
    expect(loader.getAgentOptions()).toEqual(cached);
  });

  it('restores the previous credential when the shared agent rebuild fails', async () => {
    const takServerService = makeTakServerService({ failOnRefresh: true });
    const loader = makeFileLoader(
      fileFixtures.certPath,
      fileFixtures.keyPath,
      takServerService
    );

    await loader.load();
    const cached = loader.getAgentOptions();

    fs.writeFileSync(fileFixtures.certPath, `${fileFixtures.cert}\n# rotated again\n`);

    await expect(loader.refresh()).resolves.toBe(false);

    // The cache never advertises material the shared service is not using.
    expect(loader.getAgentOptions()).toBe(cached);
    expect(mockLoggerInstance.error).toHaveBeenCalledTimes(1);

    fs.writeFileSync(fileFixtures.certPath, fileFixtures.cert);
  });

  it('is a no-op on the shared service when no TakServerService is attached', async () => {
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
      },
      secretsProvider: makeSecretsProvider()
    });

    await expect(loader.refresh()).resolves.toBe(true);
    expect(loader.getAgentOptions().cert).toMatch(/BEGIN CERTIFICATE/);
  });

  it('falls back to setAgentOptions for a service without refreshAgent', async () => {
    const takServerService = { setAgentOptions: jest.fn() };
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
      },
      secretsProvider: makeSecretsProvider(),
      takServerService
    });

    await expect(loader.refresh()).resolves.toBe(true);
    expect(takServerService.setAgentOptions).toHaveBeenCalledWith(loader.getAgentOptions());
  });
});

describe('agentOptionsEqual', () => {
  it('treats byte-identical Buffer and string material as equal', () => {
    expect(
      agentOptionsEqual({ cert: Buffer.from('pem-bytes') }, { cert: 'pem-bytes' })
    ).toBe(true);
  });

  it('detects changed material', () => {
    expect(agentOptionsEqual({ cert: 'old' }, { cert: 'new' })).toBe(false);
  });

  it('detects an added or removed field', () => {
    expect(agentOptionsEqual({ cert: 'a' }, { cert: 'a', ca: 'b' })).toBe(false);
    expect(agentOptionsEqual({ cert: 'a', passphrase: 'p' }, { cert: 'a' })).toBe(false);
  });

  it('compares array ca bundles element-wise', () => {
    expect(agentOptionsEqual({ ca: ['a', 'b'] }, { ca: [Buffer.from('a'), 'b'] })).toBe(true);
    expect(agentOptionsEqual({ ca: ['a', 'b'] }, { ca: ['a'] })).toBe(false);
  });

  it('treats two empty option sets as equal', () => {
    expect(agentOptionsEqual({}, {})).toBe(true);
  });
});

describe('AdminCredentialLoader secret hygiene (Requirement 2.11)', () => {
  /**
   * Asserts no logged string contains the passphrase or any credential
   * material. Checks both PEM text and raw bundle bytes, in utf8 and base64,
   * plus a distinctive slice of each so a truncated leak is caught too.
   *
   * @param {string} passphrase
   */
  function expectNoSecretsLogged(passphrase) {
    const logged = collectLoggedStrings();
    expect(logged.length).toBeGreaterThan(0);

    const { cert, key } = convertP12ToPem(legacyP12, FIXTURE_P12_PASSPHRASE);
    const keyBody = key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    const certBody = cert.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');

    const forbidden = [
      passphrase,
      key,
      cert,
      keyBody.slice(0, 40),
      certBody.slice(0, 40),
      legacyP12.toString('base64').slice(0, 40),
      'BEGIN RSA PRIVATE KEY',
      'PRIVATE KEY'
    ];

    for (const line of logged) {
      for (const secret of forbidden) {
        expect(line).not.toContain(secret);
      }
    }
  }

  it('logs only shape information on a successful secrets-manager load', async () => {
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN,
        TAK_ADMIN_CERT_PASSPHRASE: FIXTURE_P12_PASSPHRASE
      },
      secretsProvider: makeSecretsProvider()
    });

    await loader.load();

    expectNoSecretsLogged(FIXTURE_P12_PASSPHRASE);

    // What IS logged: the source and boolean field presence only.
    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      { source: 'secrets-manager', hasCert: true, hasKey: true, hasPfx: false, hasCa: false },
      'Loaded TAK admin credential'
    );
  });

  it('logs no credential material on a successful file load', async () => {
    const loader = new AdminCredentialLoader({
      env: {
        TAK_API_P12_PATH: FIXTURE_P12_PATH,
        TAK_API_P12_PASSPHRASE: 'file-source-passphrase-value'
      },
      secretsProvider: makeSecretsProvider()
    });

    // The file path's own `passphrase` option is credential material too, so
    // it must not appear in any log line either.
    await loader.load();

    expectNoSecretsLogged('file-source-passphrase-value');
  });

  it('logs no credential material or passphrase on a refresh failure', async () => {
    const takServerService = makeTakServerService();
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN,
        TAK_ADMIN_CERT_PASSPHRASE: 'refresh-failure-passphrase'
      },
      secretsProvider: makeSecretsProvider(),
      takServerService
    });

    // A wrong passphrase makes the conversion itself fail, which is the log
    // path most likely to echo the passphrase back.
    await expect(loader.load()).rejects.toThrow();

    loader.secretsProvider.getSecretBinary.mockResolvedValue(legacyP12);
    await expect(loader.refresh()).resolves.toBe(false);

    expect(mockLoggerInstance.error).toHaveBeenCalled();
    expectNoSecretsLogged('refresh-failure-passphrase');
  });

  it('logs no credential material when a rotation succeeds', async () => {
    const takServerService = makeTakServerService();
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN,
        TAK_ADMIN_CERT_PASSPHRASE: FIXTURE_P12_PASSPHRASE
      },
      secretsProvider: makeSecretsProvider(),
      takServerService
    });

    await expect(loader.refresh()).resolves.toBe(true);
    expect(takServerService.refreshAgent).toHaveBeenCalledTimes(1);

    expectNoSecretsLogged(FIXTURE_P12_PASSPHRASE);
  });
});

/**
 * Builds a modern (AES) multi-certificate PKCS#12 bundle in memory: a `leaf`
 * client certificate signed by a self-signed `ca`, with BOTH certificates in
 * the bundle (leaf first, then its issuer) alongside the leaf's private key.
 * This mirrors the shape of the real TAK admin bundle, which carries the full
 * issuing chain (`CN=admin` leaf -> `CN=intermediate-ca` -> self-signed root),
 * so the CA-chain extraction can be exercised without committing a second
 * fixture. Legacy algorithms are irrelevant here (that is the single-cert
 * fixture's job); this bundle only needs to parse and expose two certs.
 *
 * @returns {{p12: Buffer, leafCn: string, caCn: string, caPem: string,
 *   leafPem: string}}
 */
function buildMultiCertP12() {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCn = 'admin-cred-loader-test-ca';
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = '01';
  ca.validity.notBefore = new Date();
  ca.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const caAttrs = [{ name: 'commonName', value: caCn }];
  ca.setSubject(caAttrs);
  ca.setIssuer(caAttrs); // self-signed
  ca.setExtensions([{ name: 'basicConstraints', cA: true }]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());

  const leafKeys = forge.pki.rsa.generateKeyPair(2048);
  const leafCn = 'admin-cred-loader-test-leaf';
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = leafKeys.publicKey;
  leaf.serialNumber = '02';
  leaf.validity.notBefore = new Date();
  leaf.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  leaf.setSubject([{ name: 'commonName', value: leafCn }]);
  leaf.setIssuer(caAttrs);
  leaf.setExtensions([{ name: 'basicConstraints', cA: false }]);
  leaf.sign(caKeys.privateKey, forge.md.sha256.create());

  const asn1 = forge.pkcs12.toPkcs12Asn1(
    leafKeys.privateKey,
    [leaf, ca],
    FIXTURE_P12_PASSPHRASE,
    { algorithm: 'aes256' }
  );
  const der = forge.asn1.toDer(asn1).getBytes();

  return {
    p12: Buffer.from(der, 'binary'),
    leafCn,
    caCn,
    caPem: forge.pki.certificateToPem(ca),
    leafPem: forge.pki.certificateToPem(leaf)
  };
}

describe('convertP12ToPem chain extraction (self-signed TAK PKI trust material)', () => {
  it('returns an empty caChain for a single self-signed cert bundle', () => {
    const { caChain } = convertP12ToPem(legacyP12, FIXTURE_P12_PASSPHRASE);

    // The committed fixture holds only its own self-signed leaf, so there is
    // no separate issuing certificate to trust.
    expect(caChain).toEqual([]);
  });

  it('extracts the non-leaf certificate(s) as the CA chain, leaf excluded', () => {
    const { p12, leafCn, caCn } = buildMultiCertP12();

    const { cert, caChain } = convertP12ToPem(p12, FIXTURE_P12_PASSPHRASE);

    // The leaf is the one matching the private key.
    expect(forge.pki.certificateFromPem(cert).subject.getField('CN').value).toBe(leafCn);

    // The CA chain is exactly the issuer, and never re-includes the leaf.
    expect(caChain).toHaveLength(1);
    const caSubjects = caChain.map(
      (pem) => forge.pki.certificateFromPem(pem).subject.getField('CN').value
    );
    expect(caSubjects).toEqual([caCn]);
    expect(caSubjects).not.toContain(leafCn);
  });
});

describe('AdminCredentialLoader trusts the admin P12 chain by default (SELF_SIGNED_CERT_IN_CHAIN fix)', () => {
  it('uses the bundle-carried CA chain as { ca } when no TAK_CA_PATH is set', async () => {
    const { p12, caCn } = buildMultiCertP12();

    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
      },
      secretsProvider: makeSecretsProvider(p12)
    });

    await loader.load();

    const options = loader.getAgentOptions();
    // The server-trust material is now present, derived from the same P12 —
    // this is what makes TAK Server's self-signed chain verify without ever
    // setting rejectUnauthorized:false.
    expect(Object.keys(options).sort()).toEqual(['ca', 'cert', 'key']);
    expect(Array.isArray(options.ca)).toBe(true);
    expect(options.ca).toHaveLength(1);
    expect(forge.pki.certificateFromPem(options.ca[0]).subject.getField('CN').value).toBe(caCn);
  });

  it('leaves { ca } unset for a single-cert bundle with no TAK_CA_PATH', async () => {
    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN
      },
      secretsProvider: makeSecretsProvider() // single self-signed fixture
    });

    await loader.load();

    const options = loader.getAgentOptions();
    expect(Object.keys(options).sort()).toEqual(['cert', 'key']);
    expect(options.ca).toBeUndefined();
  });

  it('lets an explicit TAK_CA_PATH win over the bundle-carried chain', async () => {
    const { p12 } = buildMultiCertP12();

    const loader = new AdminCredentialLoader({
      env: {
        TAK_ADMIN_CERT_SOURCE: 'secrets-manager',
        TAK_ADMIN_CERT_SECRET_ARN: SECRET_ARN,
        TAK_CA_PATH: fileFixtures.caPath
      },
      secretsProvider: makeSecretsProvider(p12)
    });

    await loader.load();

    const options = loader.getAgentOptions();
    // The configured file wins: `ca` is the file's bytes, not the P12 chain.
    expect(Object.keys(options).sort()).toEqual(['ca', 'cert', 'key']);
    expect(options.ca.toString('utf8')).toBe(fileFixtures.cert);
  });
});
