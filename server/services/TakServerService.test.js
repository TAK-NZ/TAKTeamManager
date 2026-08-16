jest.mock('fs', () => ({
  readFileSync: jest.fn(() => Buffer.from('fake-file-contents'))
}));

const mockGet = jest.fn();
const mockDelete = jest.fn();

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: mockGet,
    delete: mockDelete
  }))
}));

const mockLoggerInstance = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const TakServerService = require('./TakServerService');
const { buildMutualTlsAgentOptions, matchesCreatorDn } = TakServerService;

const TEST_ENV = {
  TAK_SERVER_URL: 'https://tak.example.com:8443',
  TAK_API_CERT_PATH: '/certs/client.pem',
  TAK_API_KEY_PATH: '/certs/client.key'
};

function makeTakCert(overrides = {}) {
  return {
    id: 1,
    creatorDn: 'CN=alice,OU=TAK-NZ',
    subjectDn: 'CN=alice,OU=TAK-NZ',
    userDn: 'CN=alice,OU=TAK-NZ',
    certificate: '-----BEGIN CERTIFICATE-----',
    hash: 'abc123',
    clientUid: 'client-uid-1',
    issuanceDate: '2024-01-01T00:00:00Z',
    expirationDate: '2025-01-01T00:00:00Z',
    effectiveDate: '2024-01-01T00:00:00Z',
    revocationDate: null,
    token: 'tok',
    serialNumber: '01',
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('TakServerService.listCertificates', () => {
  it('unwraps the ApiResponse envelope and returns the raw TakCert list', async () => {
    const certs = [makeTakCert({ id: 1 }), makeTakCert({ id: 2, creatorDn: 'CN=bob,OU=TAK-NZ' })];
    mockGet.mockResolvedValue({
      data: { version: '1', type: 'com.bbn...', data: certs, messages: [], nodeId: 'node-1' }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.listCertificates();

    expect(mockGet).toHaveBeenCalledWith('/Marti/api/certadmin/cert');
    expect(result).toEqual(certs);
  });
});

describe('TakServerService.findCertificatesForUser', () => {
  it('matches by creatorDn (CN component), not userDn, and excludes non-matching certs', async () => {
    const aliceCert = makeTakCert({ id: 1, creatorDn: 'CN=alice,OU=TAK-NZ' });
    // userDn intentionally differs from creatorDn to prove userDn is not used.
    const bobCertWithAliceUserDn = makeTakCert({
      id: 2,
      creatorDn: 'CN=bob,OU=TAK-NZ',
      userDn: 'CN=alice,OU=TAK-NZ'
    });
    const carolCert = makeTakCert({ id: 3, creatorDn: 'CN=carol,OU=TAK-NZ' });

    mockGet.mockResolvedValue({
      data: { data: [aliceCert, bobCertWithAliceUserDn, carolCert] }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.findCertificatesForUser('alice');

    expect(result).toEqual([aliceCert]);
    // The unfiltered list endpoint was used -- no ?username= query param.
    expect(mockGet).toHaveBeenCalledWith('/Marti/api/certadmin/cert');
  });

  it('falls back to a substring match for a DN not following the CN=<username> convention', async () => {
    const cert = makeTakCert({ id: 5, creatorDn: 'O=TAK-NZ,DC=alice-device' });
    mockGet.mockResolvedValue({ data: { data: [cert] } });

    const service = new TakServerService(TEST_ENV);
    const result = await service.findCertificatesForUser('alice-device');

    expect(result).toEqual([cert]);
  });

  it('returns an empty array when no certificate matches', async () => {
    mockGet.mockResolvedValue({ data: { data: [makeTakCert({ id: 1, creatorDn: 'CN=dave' })] } });

    const service = new TakServerService(TEST_ENV);
    const result = await service.findCertificatesForUser('alice');

    expect(result).toEqual([]);
  });
});

describe('TakServerService.revokeCertificates', () => {
  it('reports success when every targeted id is confirmed revoked on re-query', async () => {
    mockDelete.mockResolvedValue({ status: 200, data: '' });
    mockGet.mockResolvedValue({
      data: {
        data: [
          makeTakCert({ id: 1, revocationDate: '2024-06-01T00:00:00Z' }),
          makeTakCert({ id: 2, revocationDate: '2024-06-01T00:00:00Z' }),
          makeTakCert({ id: 3, revocationDate: null })
        ]
      }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.revokeCertificates([1, 2]);

    expect(mockDelete).toHaveBeenCalledWith('/Marti/api/certadmin/cert/revoke/1,2');
    expect(result).toEqual({ success: true });
  });

  it('reports partial failure with the unverified ids when re-query does not confirm every id', async () => {
    mockDelete.mockResolvedValue({ status: 200, data: '' });
    mockGet.mockResolvedValue({
      data: {
        data: [
          makeTakCert({ id: 1, revocationDate: '2024-06-01T00:00:00Z' }),
          makeTakCert({ id: 2, revocationDate: null })
        ]
      }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.revokeCertificates([1, 2]);

    expect(result).toEqual({ success: false, unverified: [2] });
    expect(mockLoggerInstance.warn).toHaveBeenCalled();
  });

  it('treats a targeted id missing entirely from the re-queried list as unverified', async () => {
    mockDelete.mockResolvedValue({ status: 200, data: '' });
    mockGet.mockResolvedValue({
      data: { data: [makeTakCert({ id: 1, revocationDate: '2024-06-01T00:00:00Z' })] }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.revokeCertificates([1, 999]);

    expect(result).toEqual({ success: false, unverified: [999] });
  });
});

describe('buildMutualTlsAgentOptions', () => {
  it('builds { cert, key } from TAK_API_CERT_PATH/TAK_API_KEY_PATH', () => {
    const options = buildMutualTlsAgentOptions({
      TAK_API_CERT_PATH: '/certs/client.pem',
      TAK_API_KEY_PATH: '/certs/client.key'
    });

    expect(options).toHaveProperty('cert');
    expect(options).toHaveProperty('key');
    expect(options).not.toHaveProperty('pfx');
    expect(options).not.toHaveProperty('ca');
  });

  it('builds { pfx, passphrase } from TAK_API_P12_PATH/TAK_API_P12_PASSPHRASE', () => {
    const options = buildMutualTlsAgentOptions({
      TAK_API_P12_PATH: '/certs/client.p12',
      TAK_API_P12_PASSPHRASE: 'secret'
    });

    expect(options).toHaveProperty('pfx');
    expect(options.passphrase).toBe('secret');
    expect(options).not.toHaveProperty('cert');
  });

  it('additionally includes ca when TAK_CA_PATH is set', () => {
    const options = buildMutualTlsAgentOptions({
      TAK_API_CERT_PATH: '/certs/client.pem',
      TAK_API_KEY_PATH: '/certs/client.key',
      TAK_CA_PATH: '/certs/ca.pem'
    });

    expect(options).toHaveProperty('ca');
  });

  it('returns an empty options object when no TAK Server credential variable is set', () => {
    const options = buildMutualTlsAgentOptions({});
    expect(options).toEqual({});
  });
});

describe('matchesCreatorDn', () => {
  it('matches via the CN component, including the permissive substring fallback', () => {
    expect(matchesCreatorDn('CN=alice,OU=TAK-NZ', 'alice')).toBe(true);
    // The permissive substring fallback intentionally still matches a DN
    // whose CN merely contains the username as a substring (e.g.
    // "alice2"), per the task's explicit instruction to implement "a
    // reasonably permissive substring/CN match" -- documented here as
    // accepted behavior rather than a bug.
    expect(matchesCreatorDn('CN=alice2,OU=TAK-NZ', 'alice')).toBe(true);
  });

  it('falls back to a substring match for a non-CN-prefixed DN', () => {
    expect(matchesCreatorDn('O=TAK-NZ,DC=alice-device', 'alice-device')).toBe(true);
  });

  it('returns false for a non-string creatorDn or username', () => {
    expect(matchesCreatorDn(null, 'alice')).toBe(false);
    expect(matchesCreatorDn('CN=alice', undefined)).toBe(false);
  });
});
