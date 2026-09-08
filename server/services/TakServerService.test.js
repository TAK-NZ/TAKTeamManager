jest.mock('fs', () => ({
  readFileSync: jest.fn(() => Buffer.from('fake-file-contents'))
}));

const mockGet = jest.fn();
const mockDelete = jest.fn();

jest.mock('axios', () => ({
  // Real axios exposes the create config as `client.defaults`, which is what
  // `setAgentOptions` reassigns `httpsAgent` on to rebuild the agent in place
  // (device-management Requirement 2.7) -- so the mock client carries it too.
  create: jest.fn((config) => ({
    get: mockGet,
    delete: mockDelete,
    defaults: { ...config }
  }))
}));

const mockLoggerInstance = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const fs = require('fs');
const axios = require('axios');
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

/**
 * device-management Requirements 12.4-12.7: verification is membership in the
 * Revoked_Certificate_View (`GET /Marti/api/certadmin/cert/revoked`), never a
 * non-null `revocationDate` -- which every live certificate carries too, so the
 * previous check confirmed everything unconditionally.
 */
describe('TakServerService.revokeCertificates', () => {
  it('reports success when every targeted id is present in the revoked view', async () => {
    mockDelete.mockResolvedValue({ status: 200, data: '' });
    mockGet.mockResolvedValue({
      data: {
        data: [makeTakCert({ id: 1 }), makeTakCert({ id: 2 }), makeTakCert({ id: 3 })]
      }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.revokeCertificates([1, 2]);

    expect(mockDelete).toHaveBeenCalledWith('/Marti/api/certadmin/cert/revoke/1,2');
    // Verification re-queries /revoked, NOT the full certificate list.
    expect(mockGet).toHaveBeenCalledWith('/Marti/api/certadmin/cert/revoked');
    expect(result).toEqual({ success: true });
  });

  it('reports partial failure with the unverified ids when the revoked view omits one', async () => {
    mockDelete.mockResolvedValue({ status: 200, data: '' });
    mockGet.mockResolvedValue({ data: { data: [makeTakCert({ id: 1 })] } });

    const service = new TakServerService(TEST_ENV);
    const result = await service.revokeCertificates([1, 2]);

    expect(result).toEqual({ success: false, unverified: [2] });
    expect(mockLoggerInstance.warn).toHaveBeenCalled();
  });

  it('treats a targeted id missing entirely from the revoked view as unverified', async () => {
    mockDelete.mockResolvedValue({ status: 200, data: '' });
    mockGet.mockResolvedValue({ data: { data: [makeTakCert({ id: 1 })] } });

    const service = new TakServerService(TEST_ENV);
    const result = await service.revokeCertificates([1, 999]);

    expect(result).toEqual({ success: false, unverified: [999] });
  });

  it('does not confirm a targeted id merely because it carries a non-null revocationDate', async () => {
    mockDelete.mockResolvedValue({ status: 200, data: '' });
    // Live observation: id 3212 carries a revocationDate yet /revoked omits it.
    mockGet.mockResolvedValue({ data: { data: [] } });

    const service = new TakServerService(TEST_ENV);
    const result = await service.revokeCertificates([3212]);

    expect(result).toEqual({ success: false, unverified: [3212] });
  });

  it('propagates a failed revoked-view re-query instead of reporting success', async () => {
    mockDelete.mockResolvedValue({ status: 200, data: '' });
    const failure = { response: { status: 404 } };
    mockGet.mockRejectedValue(failure);

    const service = new TakServerService(TEST_ENV);

    await expect(service.revokeCertificates([1])).rejects.toBe(failure);
  });
});

/**
 * device-management Requirements 12.4, 14.1, 14.2: the revoked view is the only
 * revocation signal, and it is documented in `tak-server-openapispec.json`, so
 * no failure -- including a 404 -- may be degraded to an empty result.
 */
describe('TakServerService.listRevokedCertificates', () => {
  it('GETs /Marti/api/certadmin/cert/revoked and unwraps the ApiResponse envelope', async () => {
    const certs = [makeTakCert({ id: 1 }), makeTakCert({ id: 2, clientUid: 'client-uid-2' })];
    mockGet.mockResolvedValue({
      data: { version: '1', type: 'com.bbn...', data: certs, messages: [], nodeId: 'node-1' }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.listRevokedCertificates();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/Marti/api/certadmin/cert/revoked');
    // Returned as-is: camelCase TakCert fields, no re-mapping.
    expect(result).toEqual(certs);
  });

  it.each([
    ['a 404', { response: { status: 404 } }],
    ['a 500', { response: { status: 500 } }]
  ])('rejects on %s rather than reporting an empty revoked set', async (_label, failure) => {
    mockGet.mockRejectedValue(failure);

    const service = new TakServerService(TEST_ENV);

    await expect(service.listRevokedCertificates()).rejects.toBe(failure);
  });

  it('reads an envelope with no data array as empty, so verification fails closed', async () => {
    mockGet.mockResolvedValue({ data: { version: '1', messages: [] } });

    const service = new TakServerService(TEST_ENV);

    await expect(service.listRevokedCertificates()).resolves.toEqual([]);
  });
});

/**
 * device-management Requirements 4.3, 4.6, 11.2, 11.4: the live set is the set
 * difference `/active` MINUS `/revoked` by certificate id. `/active` is not the
 * live set (90 of its 95 live certificates were also in `/revoked`), and
 * `/replaced` is never consulted (it returned the same 95 ids as `/active`).
 */
describe('TakServerService.listLiveCertificates', () => {
  const ACTIVE_PATH = '/Marti/api/certadmin/cert/active';
  const REVOKED_PATH = '/Marti/api/certadmin/cert/revoked';

  /**
   * Routes the shared `mockGet` by URL, since this method fetches both views.
   *
   * @param {{active?: Array<object>|Error|object, revoked?: Array<object>|Error|object}} views
   *   an array resolves as the view's `data` payload; anything else is rejected.
   * @returns {void}
   */
  function mockViews({ active = [], revoked = [] }) {
    mockGet.mockImplementation((url) => {
      const view = url === ACTIVE_PATH ? active : url === REVOKED_PATH ? revoked : null;

      if (Array.isArray(view)) {
        return Promise.resolve({ data: { version: '1', data: view, messages: [] } });
      }

      return Promise.reject(view);
    });
  }

  it('returns the set difference by certificate id: in /active, not in /revoked', async () => {
    const live = makeTakCert({ id: 3212 });
    const alsoRevoked = makeTakCert({ id: 100 });
    const active = [alsoRevoked, live, makeTakCert({ id: 101 })];
    // A revoked entry TAK Server does not list under /active is simply ignored.
    const revoked = [makeTakCert({ id: 100 }), makeTakCert({ id: 101 }), makeTakCert({ id: 999 })];
    mockViews({ active, revoked });

    const service = new TakServerService(TEST_ENV);
    const result = await service.listLiveCertificates();

    expect(result).toEqual([live]);
    expect(mockGet).toHaveBeenCalledWith(ACTIVE_PATH);
    expect(mockGet).toHaveBeenCalledWith(REVOKED_PATH);
    // Requirement 11.4: /replaced returns the same ids as /active, so it is never asked.
    expect(mockGet).not.toHaveBeenCalledWith('/Marti/api/certadmin/cert/replaced');
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('passes heavily reused clientUids through untouched, without grouping or de-duplication', async () => {
    // The live shape: many certificates collapsing onto few clientUids.
    const active = [
      makeTakCert({ id: 1, clientUid: 'ckadmin (ETL)' }),
      makeTakCert({ id: 2, clientUid: 'ckadmin (ETL)' }),
      makeTakCert({ id: 3, clientUid: 'ckadmin (ETL)' }),
      makeTakCert({ id: 4, clientUid: 'ANDROID-63040a40563b5fab' }),
      makeTakCert({ id: 5, clientUid: 'ANDROID-63040a40563b5fab' })
    ];
    mockViews({ active, revoked: [makeTakCert({ id: 3, clientUid: 'ckadmin (ETL)' })] });

    const service = new TakServerService(TEST_ENV);
    const result = await service.listLiveCertificates();

    // Requirement 11.1: grouping certificates into Devices is the caller's job.
    expect(result).toEqual([active[0], active[1], active[3], active[4]]);
    expect(result.map((cert) => cert.clientUid)).toEqual([
      'ckadmin (ETL)',
      'ckadmin (ETL)',
      'ANDROID-63040a40563b5fab',
      'ANDROID-63040a40563b5fab'
    ]);
  });

  it('treats everything in /active as live when /revoked is empty', async () => {
    const active = [makeTakCert({ id: 1 }), makeTakCert({ id: 2, clientUid: 'client-uid-2' })];
    mockViews({ active, revoked: [] });

    const service = new TakServerService(TEST_ENV);

    await expect(service.listLiveCertificates()).resolves.toEqual(active);
  });

  it('returns nothing live when /revoked is a superset of /active', async () => {
    const active = [makeTakCert({ id: 1 }), makeTakCert({ id: 2 })];
    mockViews({
      active,
      revoked: [makeTakCert({ id: 1 }), makeTakCert({ id: 2 }), makeTakCert({ id: 3 })]
    });

    const service = new TakServerService(TEST_ENV);

    // Requirement 11.5: a fully-revoked clientUid is never presented as live.
    await expect(service.listLiveCertificates()).resolves.toEqual([]);
  });

  it('propagates a failed /active fetch instead of computing a live set', async () => {
    const failure = { response: { status: 500 } };
    mockViews({ active: failure, revoked: [makeTakCert({ id: 1 })] });

    const service = new TakServerService(TEST_ENV);

    await expect(service.listLiveCertificates()).rejects.toBe(failure);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'active', endpoint: ACTIVE_PATH }),
      expect.any(String)
    );
  });

  it('propagates a failed /revoked fetch rather than reading it as an empty revoked set', async () => {
    // A 404 here is a wrong URL, not an empty server (Requirements 14.1, 14.2);
    // degrading it to [] would promote every revoked certificate to live.
    const failure = { response: { status: 404 } };
    mockViews({ active: [makeTakCert({ id: 1 })], revoked: failure });

    const service = new TakServerService(TEST_ENV);

    await expect(service.listLiveCertificates()).rejects.toBe(failure);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'revoked', endpoint: REVOKED_PATH }),
      expect.any(String)
    );
  });

  it('attributes each view separately in the log when both fetches fail', async () => {
    const activeFailure = new Error('socket hang up');
    const revokedFailure = { response: { status: 500 } };
    mockViews({ active: activeFailure, revoked: revokedFailure });

    const service = new TakServerService(TEST_ENV);

    await expect(service.listLiveCertificates()).rejects.toBe(activeFailure);
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: activeFailure, view: 'active' }),
      expect.any(String)
    );
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: revokedFailure, view: 'revoked' }),
      expect.any(String)
    );
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

  /**
   * device-management Requirement 10: TAK Server presents a certificate carrying
   * only its own internal name (`CN=takserver` / a single `DNS:takserver` SAN),
   * so the identity check has to be pointed at that name -- without weakening
   * chain verification anywhere.
   */
  describe('optional TLS servername (Requirement 10)', () => {
    // Every credential shape the builder can produce, so the servername
    // assertions cover all of them rather than just the cert/key case.
    const CREDENTIAL_ENVS = [
      ['{ cert, key }', {
        TAK_API_CERT_PATH: '/certs/client.pem',
        TAK_API_KEY_PATH: '/certs/client.key'
      }],
      ['{ pfx, passphrase }', {
        TAK_API_P12_PATH: '/certs/client.p12',
        TAK_API_P12_PASSPHRASE: 'secret'
      }],
      ['{ cert, key, ca }', {
        TAK_API_CERT_PATH: '/certs/client.pem',
        TAK_API_KEY_PATH: '/certs/client.key',
        TAK_CA_PATH: '/certs/ca.pem'
      }],
      ['{ pfx, passphrase, ca }', {
        TAK_API_P12_PATH: '/certs/client.p12',
        TAK_API_P12_PASSPHRASE: 'secret',
        TAK_CA_PATH: '/certs/ca.pem'
      }],
      ['no credential', {}]
    ];

    // Values that must NOT produce a servername key (Requirement 10.5).
    const ABSENT_SERVERNAMES = [
      ['unset', {}],
      ['undefined', { TAK_SERVER_TLS_SERVERNAME: undefined }],
      ['empty', { TAK_SERVER_TLS_SERVERNAME: '' }],
      ['whitespace-only', { TAK_SERVER_TLS_SERVERNAME: '   ' }]
    ];

    // Requirement 10.4
    it('sets servername to the configured TAK_SERVER_TLS_SERVERNAME value', () => {
      const options = buildMutualTlsAgentOptions({
        TAK_API_CERT_PATH: '/certs/client.pem',
        TAK_API_KEY_PATH: '/certs/client.key',
        TAK_CA_PATH: '/certs/ca.pem',
        TAK_SERVER_TLS_SERVERNAME: 'takserver'
      });

      expect(options.servername).toBe('takserver');
    });

    it.each(CREDENTIAL_ENVS)(
      'sets servername alongside the %s credential shape',
      (_label, credentialEnv) => {
        const options = buildMutualTlsAgentOptions({
          ...credentialEnv,
          TAK_SERVER_TLS_SERVERNAME: 'takserver'
        });

        expect(options.servername).toBe('takserver');
      }
    );

    // The value is the name the certificate actually carries, so it is passed
    // through exactly as configured -- no trimming, casing or other
    // normalisation beyond the non-empty check.
    it.each([
      ['a bare host name', 'takserver'],
      ['mixed case', 'TakServer'],
      ['a dotted FQDN', 'takserver.internal.example.com'],
      ['surrounding whitespace', '  takserver  ']
    ])('passes %s through verbatim', (_label, configured) => {
      const options = buildMutualTlsAgentOptions({
        TAK_API_CERT_PATH: '/certs/client.pem',
        TAK_API_KEY_PATH: '/certs/client.key',
        TAK_SERVER_TLS_SERVERNAME: configured
      });

      expect(options.servername).toBe(configured);
    });

    // Requirement 10.5: absent means no key at all, not `servername: undefined`.
    it.each(ABSENT_SERVERNAMES)(
      'adds no servername key when TAK_SERVER_TLS_SERVERNAME is %s',
      (_label, servernameEnv) => {
        const options = buildMutualTlsAgentOptions({
          TAK_API_CERT_PATH: '/certs/client.pem',
          TAK_API_KEY_PATH: '/certs/client.key',
          TAK_CA_PATH: '/certs/ca.pem',
          ...servernameEnv
        });

        expect(options).not.toHaveProperty('servername');
        expect(Object.keys(options)).not.toContain('servername');
      }
    );

    // Requirement 10.5: the pre-existing credential/CA shapes are untouched --
    // with the variable set, servername is the only difference.
    it.each(CREDENTIAL_ENVS)(
      'leaves the %s shape unchanged whether or not the variable is set',
      (_label, credentialEnv) => {
        const withoutServername = buildMutualTlsAgentOptions({ ...credentialEnv });
        const withServername = buildMutualTlsAgentOptions({
          ...credentialEnv,
          TAK_SERVER_TLS_SERVERNAME: 'takserver'
        });

        const { servername, ...remainder } = withServername;

        expect(servername).toBe('takserver');
        expect(remainder).toEqual(withoutServername);

        for (const [, absentEnv] of ABSENT_SERVERNAMES) {
          expect(buildMutualTlsAgentOptions({ ...credentialEnv, ...absentEnv }))
            .toEqual(withoutServername);
        }
      }
    );

    // Requirement 10.3: `rejectUnauthorized: false` would disable chain as well
    // as identity verification, exposing the Admin_Credential to whatever
    // answered the connection. It is never set -- in any environment, with or
    // without a servername -- and no checkServerIdentity override is supplied.
    it.each(CREDENTIAL_ENVS)(
      'never sets rejectUnauthorized or checkServerIdentity for the %s shape',
      (_label, credentialEnv) => {
        const servernameEnvs = [
          { TAK_SERVER_TLS_SERVERNAME: 'takserver' },
          ...ABSENT_SERVERNAMES.map(([, env]) => env)
        ];

        for (const servernameEnv of servernameEnvs) {
          const options = buildMutualTlsAgentOptions({ ...credentialEnv, ...servernameEnv });

          expect(options).not.toHaveProperty('rejectUnauthorized');
          expect(Object.keys(options)).not.toContain('rejectUnauthorized');
          expect(options.rejectUnauthorized).not.toBe(false);
          expect(options).not.toHaveProperty('checkServerIdentity');
        }
      }
    );
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

/**
 * device-management Requirement 2.7: a rotated Admin_Credential must be used by
 * every subsequent Marti call without a process restart, which means the agent
 * has to be rebuilt in place on the shared client rather than by handing out a
 * new service/client instance (Requirement 2.8).
 */
describe('TakServerService.setAgentOptions', () => {
  const NEW_CERT = Buffer.from('rotated-cert');
  const NEW_KEY = Buffer.from('rotated-key');

  it('rebuilds the client httpsAgent in place from the new material and returns it', () => {
    const service = new TakServerService(TEST_ENV);
    const originalAgent = service.client.defaults.httpsAgent;

    const newAgent = service.setAgentOptions({ cert: NEW_CERT, key: NEW_KEY });

    // Same client object -- the agent was swapped in place, not replaced by a
    // new axios client, so existing holders of this instance see the rotation.
    expect(service.client.defaults.httpsAgent).toBe(newAgent);
    expect(newAgent).not.toBe(originalAgent);
    expect(newAgent.options.cert).toBe(NEW_CERT);
    expect(newAgent.options.key).toBe(NEW_KEY);
    // The supplied material is preserved, plus `family: 4` is merged in so the
    // mutual-TLS connection to the dual-stack TAK Server host always dials IPv4
    // (the handshake hangs over IPv6). See setAgentOptions.
    expect(service.agentOptions).toEqual({ cert: NEW_CERT, key: NEW_KEY, family: 4 });
    expect(newAgent.options.family).toBe(4);
    // No new axios client was created (only the constructor's).
    expect(axios.create).toHaveBeenCalledTimes(1);
  });

  it('supports a pfx/passphrase credential and a CA bundle', () => {
    const service = new TakServerService(TEST_ENV);
    const pfx = Buffer.from('rotated-p12');
    const ca = Buffer.from('ca-bundle');

    const newAgent = service.setAgentOptions({ pfx, passphrase: 'secret', ca });

    expect(newAgent.options.pfx).toBe(pfx);
    expect(newAgent.options.passphrase).toBe('secret');
    expect(newAgent.options.ca).toBe(ca);
  });

  it('logs only the shape of the installed credential, never the material', () => {
    const service = new TakServerService(TEST_ENV);

    service.setAgentOptions({ cert: NEW_CERT, key: NEW_KEY });

    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      { hasCert: true, hasKey: true, hasPfx: false, hasCa: false },
      expect.any(String)
    );
    const logged = JSON.stringify(mockLoggerInstance.info.mock.calls);
    expect(logged).not.toContain('rotated-cert');
    expect(logged).not.toContain('rotated-key');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '/certs/client.pem']
  ])('throws a TypeError for %s and keeps the working agent installed', (_label, badOptions) => {
    const service = new TakServerService(TEST_ENV);
    const originalAgent = service.client.defaults.httpsAgent;

    expect(() => service.setAgentOptions(badOptions)).toThrow(TypeError);
    expect(service.client.defaults.httpsAgent).toBe(originalAgent);
  });
});

/*
 * The servername is a property of the SERVER we dial, not of the credential.
 * The Admin_Credential_Loader's secrets-manager path returns only the
 * credential (`{ cert, key, ca }`) with no servername, so `setAgentOptions`
 * (the single agent-construction chokepoint) must re-apply the configured
 * TAK_SERVER_TLS_SERVERNAME on every build/rotation -- otherwise TAK Server's
 * CN=takserver / DNS:takserver certificate fails the hostname identity check
 * (ERR_TLS_CERT_ALTNAME_INVALID) against the dialed load-balancer host.
 */
describe('TakServerService.setAgentOptions preserves the configured TLS servername', () => {
  const NEW_CERT = Buffer.from('rotated-cert');
  const NEW_KEY = Buffer.from('rotated-key');
  const ENV_WITH_SERVERNAME = { ...TEST_ENV, TAK_SERVER_TLS_SERVERNAME: 'takserver' };

  it('applies TAK_SERVER_TLS_SERVERNAME even when the options carry none (loader path)', () => {
    const service = new TakServerService(ENV_WITH_SERVERNAME);

    // Simulate the loader's secrets-manager result: credential only, no servername.
    const newAgent = service.setAgentOptions({ cert: NEW_CERT, key: NEW_KEY });

    expect(newAgent.options.servername).toBe('takserver');
    expect(service.agentOptions).toEqual({
      cert: NEW_CERT,
      key: NEW_KEY,
      servername: 'takserver',
      family: 4
    });
  });

  it('lets options-supplied servername win over the configured one', () => {
    const service = new TakServerService(ENV_WITH_SERVERNAME);

    const newAgent = service.setAgentOptions({
      cert: NEW_CERT,
      key: NEW_KEY,
      servername: 'explicit-override'
    });

    expect(newAgent.options.servername).toBe('explicit-override');
  });

  it.each([
    ['unset', {}],
    ['empty', { TAK_SERVER_TLS_SERVERNAME: '' }],
    ['whitespace-only', { TAK_SERVER_TLS_SERVERNAME: '   ' }]
  ])('adds no servername when TAK_SERVER_TLS_SERVERNAME is %s and options carry none', (_label, envServername) => {
    const service = new TakServerService({ ...TEST_ENV, ...envServername });

    const newAgent = service.setAgentOptions({ cert: NEW_CERT, key: NEW_KEY });

    expect(newAgent.options).not.toHaveProperty('servername');
  });

  it('survives a refreshAgent from a loader whose material omits servername', () => {
    const loaded = { cert: Buffer.from('loader-cert'), key: Buffer.from('loader-key') };
    const credentialLoader = { getAgentOptions: () => loaded };
    const service = new TakServerService(ENV_WITH_SERVERNAME, { credentialLoader });

    const newAgent = service.refreshAgent();

    expect(newAgent.options.servername).toBe('takserver');
  });
});

describe('TakServerService.refreshAgent', () => {
  it('rebuilds the agent from the attached credential loader current material', () => {
    const loaded = { cert: Buffer.from('loader-cert'), key: Buffer.from('loader-key') };
    const credentialLoader = { getAgentOptions: jest.fn(() => loaded) };

    const service = new TakServerService(TEST_ENV, { credentialLoader });
    const originalAgent = service.client.defaults.httpsAgent;

    const newAgent = service.refreshAgent();

    expect(credentialLoader.getAgentOptions).toHaveBeenCalledTimes(1);
    expect(newAgent).not.toBe(originalAgent);
    expect(service.client.defaults.httpsAgent).toBe(newAgent);
    expect(newAgent.options.cert).toBe(loaded.cert);
    expect(newAgent.options.key).toBe(loaded.key);
  });

  it('uses a loader attached after construction via setCredentialLoader', () => {
    const loaded = { cert: Buffer.from('late-cert'), key: Buffer.from('late-key') };
    const service = new TakServerService(TEST_ENV);

    service.setCredentialLoader({ getAgentOptions: () => loaded });
    const newAgent = service.refreshAgent();

    expect(newAgent.options.cert).toBe(loaded.cert);
  });

  it('falls back to the file/environment credential when no loader is attached', () => {
    const service = new TakServerService(TEST_ENV);
    const rotatedOnDisk = Buffer.from('rotated-on-disk');
    fs.readFileSync.mockReturnValue(rotatedOnDisk);

    try {
      const newAgent = service.refreshAgent();

      // A rotated file on disk is picked up because the credential is re-read.
      expect(fs.readFileSync).toHaveBeenCalledWith(TEST_ENV.TAK_API_CERT_PATH);
      expect(fs.readFileSync).toHaveBeenCalledWith(TEST_ENV.TAK_API_KEY_PATH);
      expect(newAgent.options.cert).toBe(rotatedOnDisk);
      expect(service.client.defaults.httpsAgent).toBe(newAgent);
    } finally {
      fs.readFileSync.mockReturnValue(Buffer.from('fake-file-contents'));
    }
  });

  it('falls back to the file/environment credential when the loader has not loaded yet', () => {
    const credentialLoader = { getAgentOptions: jest.fn(() => null) };
    const service = new TakServerService(TEST_ENV, { credentialLoader });

    const newAgent = service.refreshAgent();

    expect(credentialLoader.getAgentOptions).toHaveBeenCalledTimes(1);
    expect(newAgent.options.cert).toBeInstanceOf(Buffer);
    expect(newAgent.options.key).toBeInstanceOf(Buffer);
  });
});

/**
 * device-management Requirements 4.3, 14.1, 14.2: the Device_Sync derives Device
 * rows from the Active_Certificate view, and because that view IS documented in
 * `tak-server-openapispec.json` (OpenAPI `getActive`), no failure -- including a
 * 404 -- may be degraded to an empty result. A 404 means the request was wrong,
 * not that the server holds no certificates.
 */
describe('TakServerService.listActiveCertificates', () => {
  it('GETs /Marti/api/certadmin/cert/active and unwraps the ApiResponse envelope', async () => {
    const certs = [makeTakCert({ id: 1 }), makeTakCert({ id: 2, clientUid: 'client-uid-2' })];
    mockGet.mockResolvedValue({
      data: { version: '1', type: 'com.bbn...', data: certs, messages: [], nodeId: 'node-1' }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.listActiveCertificates();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/Marti/api/certadmin/cert/active');
    // Returned as-is: camelCase TakCert fields, no re-mapping.
    expect(result).toEqual(certs);
  });

  it('accepts a bare JSON array body', async () => {
    const certs = [makeTakCert({ id: 7 })];
    mockGet.mockResolvedValue({ data: certs });

    const service = new TakServerService(TEST_ENV);

    await expect(service.listActiveCertificates()).resolves.toEqual(certs);
  });

  it.each([
    ['an envelope with no data array', { data: { version: '1', messages: [] } }],
    ['a null body', { data: null }],
    ['no body at all', {}]
  ])('returns an empty array for %s', async (_label, response) => {
    // Requirement 14.3: a 200 carrying no payload is a real observation of an
    // empty view, which is not the same thing as a failed request below.
    mockGet.mockResolvedValue(response);

    const service = new TakServerService(TEST_ENV);

    await expect(service.listActiveCertificates()).resolves.toEqual([]);
  });

  it.each([
    ['a 404', { response: { status: 404 } }],
    ['a 401', { response: { status: 401 } }],
    ['a 500', { response: { status: 500 } }],
    ['a transport failure', new Error('socket hang up')]
  ])('rejects on %s rather than reporting an empty active view', async (_label, failure) => {
    // Requirements 14.1, 14.2, 14.5: `getActive` IS documented, so a 404 is a
    // wrong URL -- degrading it to [] made a bug look like "nothing to sync".
    mockGet.mockRejectedValue(failure);

    const service = new TakServerService(TEST_ENV);

    await expect(service.listActiveCertificates()).rejects.toBe(failure);
  });
});

/**
 * device-management Requirements 3.1, 13.1, 13.2, 13.7, 14.4: Last_Seen is
 * sourced from the Client_Endpoints_API (`GET /Marti/api/clientEndPoints`,
 * OpenAPI `getClientEndpoints` -> `ApiResponseListClientEndpoint`), whose `uid`
 * lives in the `client_uid` space. It replaces the removed
 * `getConnectedSubscriptions()` (`/Marti/clients`, 404 live and absent from
 * `tak-server-openapispec.json` entirely), and because it IS documented no
 * failure -- including a 404 -- may be degraded to an empty result.
 */
describe('TakServerService.getClientEndpoints', () => {
  const CLIENT_ENDPOINTS_PATH = '/Marti/api/clientEndPoints';

  /**
   * The live shape: mostly `Disconnected` entries, which are the ones carrying
   * the last-seen timestamps this feature exists to show (46 of 48 live).
   *
   * @param {object} [overrides]
   * @returns {object}
   */
  function makeClientEndpoint(overrides = {}) {
    return {
      callsign: 'ALPHA',
      uid: 'ANDROID-842f08e120efdbe3',
      username: 'alice',
      team: 'Cyan',
      role: 'Team Member',
      lastEventTime: '2026-01-17T01:15:22.160Z',
      lastStatus: 'Disconnected',
      ...overrides
    };
  }

  it('GETs /Marti/api/clientEndPoints and unwraps the ApiResponse envelope', async () => {
    const endpoints = [
      makeClientEndpoint(),
      makeClientEndpoint({ uid: 'ANDROID-other', lastStatus: 'Connected' })
    ];
    mockGet.mockResolvedValue({
      data: { version: '1', type: 'com.bbn...', data: endpoints, messages: [], nodeId: 'node-1' }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.getClientEndpoints();

    expect(mockGet).toHaveBeenCalledTimes(1);
    // No params at all by default, so the request carries no query string.
    expect(mockGet).toHaveBeenCalledWith(CLIENT_ENDPOINTS_PATH);
    // Returned as-is: camelCase ClientEndpoint fields, no re-mapping.
    expect(result).toEqual(endpoints);
  });

  it('returns Disconnected entries with their lastEventTime, keyed by uid', async () => {
    // Requirement 13.2: lastStatus is never filtered on -- a Disconnected entry
    // carries the timestamp of interest, and `uid` is the join key.
    const endpoints = [
      makeClientEndpoint({ uid: 'ANDROID-a', lastEventTime: '2026-01-01T00:00:00Z' }),
      makeClientEndpoint({ uid: 'ANDROID-b', lastEventTime: '2026-02-02T00:00:00Z' })
    ];
    mockGet.mockResolvedValue({ data: { data: endpoints } });

    const service = new TakServerService(TEST_ENV);
    const result = await service.getClientEndpoints();

    expect(result.map((entry) => entry.lastStatus)).toEqual(['Disconnected', 'Disconnected']);
    expect(result.map((entry) => entry.uid)).toEqual(['ANDROID-a', 'ANDROID-b']);
    expect(result.map((entry) => entry.lastEventTime)).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-02-02T00:00:00Z'
    ]);
  });

  it('never sends showCurrentlyConnectedClients, even when a caller supplies it', async () => {
    // Requirement 13.7: narrowing to currently-connected clients would discard
    // 46 of the 48 live entries -- precisely the ones with useful timestamps.
    mockGet.mockResolvedValue({ data: { data: [] } });

    const service = new TakServerService(TEST_ENV);
    await service.getClientEndpoints({ showCurrentlyConnectedClients: 'true', secAgo: 3600 });

    expect(mockGet).toHaveBeenCalledWith(CLIENT_ENDPOINTS_PATH, { params: { secAgo: 3600 } });
    expect(mockLoggerInstance.warn).toHaveBeenCalled();
  });

  it('forwards the other documented query parameters when supplied', async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });

    const service = new TakServerService(TEST_ENV);
    await service.getClientEndpoints({ secAgo: 60, showMostRecentOnly: 'true', group: ['__ANON__'] });

    expect(mockGet).toHaveBeenCalledWith(CLIENT_ENDPOINTS_PATH, {
      params: { secAgo: 60, showMostRecentOnly: 'true', group: ['__ANON__'] }
    });
  });

  it.each([
    ['a 404', { response: { status: 404 } }],
    ['a 500', { response: { status: 500 } }],
    ['a transport failure', new Error('socket hang up')]
  ])('rejects on %s rather than reporting an empty history', async (_label, failure) => {
    // Requirements 14.1, 14.2, 14.4, 14.5: this endpoint IS documented, so a
    // 404 means the request was wrong, not that no client has ever been seen.
    mockGet.mockRejectedValue(failure);

    const service = new TakServerService(TEST_ENV);

    await expect(service.getClientEndpoints()).rejects.toBe(failure);
  });

  it('reads an envelope with no data array as a legitimately empty history', async () => {
    mockGet.mockResolvedValue({ data: { version: '1', messages: [] } });

    const service = new TakServerService(TEST_ENV);

    await expect(service.getClientEndpoints()).resolves.toEqual([]);
  });
});

/**
 * device-management Requirement 13 (freshness follow-up): `getAllSubscriptions()`
 * fetches the live subscription table, TAK Server's own admin UI's data
 * source, so a currently-reporting connection's freshness is not limited to
 * however infrequently `getClientEndpoints()`'s `lastEventTime` happens to
 * advance for it.
 */
describe('TakServerService.getAllSubscriptions', () => {
  const SUBSCRIPTIONS_PATH = '/Marti/api/subscriptions/all';

  /**
   * The live shape: most entries carry NO `clientUid` (CloudTAK's own
   * ETL/service ingest connections, identified by `dn` instead), and only a
   * real end-user Device's live session carries one.
   *
   * @param {object} [overrides]
   * @returns {object}
   */
  function makeSubscriptionInfo(overrides = {}) {
    return {
      dn: null,
      callsign: 'FENZ-STL-C.Elsen',
      clientUid: 'ANDROID-CloudTAK-chris@chriselsen.net',
      lastReportMilliseconds: 1787633240530,
      takClient: 'CloudTAK',
      username: 'chris@chriselsen.net',
      ...overrides
    };
  }

  it('GETs /Marti/api/subscriptions/all with no query parameters, and unwraps the ApiResponse envelope', async () => {
    const subscriptions = [
      makeSubscriptionInfo(),
      makeSubscriptionInfo({ dn: 'CN=etl-adsbx, OU=TAK Unit, O=TAK', clientUid: '', callsign: 'tls:7101' })
    ];
    mockGet.mockResolvedValue({
      data: { version: '3', type: 'SubscriptionInfo', data: subscriptions }
    });

    const service = new TakServerService(TEST_ENV);
    const result = await service.getAllSubscriptions();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(SUBSCRIPTIONS_PATH);
    // Returned as-is: camelCase SubscriptionInfo fields, no re-mapping, no
    // filtering on clientUid here -- that is the caller's job.
    expect(result).toEqual(subscriptions);
  });

  it.each([
    ['a 404', { response: { status: 404 } }],
    ['a 500', { response: { status: 500 } }],
    ['a transport failure', new Error('socket hang up')]
  ])('rejects on %s rather than reporting an empty result', async (_label, failure) => {
    mockGet.mockRejectedValue(failure);

    const service = new TakServerService(TEST_ENV);

    await expect(service.getAllSubscriptions()).rejects.toBe(failure);
  });

  it('reads an envelope with no data array as a legitimately empty live-subscription table', async () => {
    mockGet.mockResolvedValue({ data: { version: '3', messages: [] } });

    const service = new TakServerService(TEST_ENV);

    await expect(service.getAllSubscriptions()).resolves.toEqual([]);
  });
});

/**
 * device-management Requirement 14.4: `/Marti/clients` is absent from
 * `tak-server-openapispec.json` and answers 404 live, so
 * `getConnectedSubscriptions()` is DELETED rather than repointed -- no caller
 * may keep the old "connected right now" semantics by accident.
 */
describe('TakServerService.getConnectedSubscriptions (removed)', () => {
  it('no longer exists on the service', () => {
    const service = new TakServerService(TEST_ENV);

    expect(service.getConnectedSubscriptions).toBeUndefined();
  });
});
