/**
 * Requirements 8.5, 8.6: the App's database pool registers a
 * `pool.on('error', ...)` handler (so an idle client error doesn't crash
 * the process) and is configured with an explicit `max` pool size sourced
 * from `DB_POOL_MAX` (defaulting to 20).
 */

describe('server/config/database', () => {
  const ORIGINAL_ENV = process.env;
  let mockPoolInstance;
  let PoolMock;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };

    mockPoolInstance = {
      on: jest.fn()
    };
    PoolMock = jest.fn(() => mockPoolInstance);

    jest.doMock('pg', () => ({ Pool: PoolMock }));
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.dontMock('pg');
    jest.dontMock('fs');
  });

  /**
   * Security-hardening: this pool USED to set
   * `ssl: { rejectUnauthorized: false }` unconditionally in production
   * -- encrypted but never actually verified. It now defaults to
   * `rejectUnauthorized: true`, optionally loading a CA bundle from
   * `DB_CA_PATH`.
   */
  describe('TLS certificate validation (security-hardening)', () => {
    it('sets ssl: false outside production, regardless of DB_CA_PATH', () => {
      process.env.NODE_ENV = 'test';
      process.env.DB_CA_PATH = '/certs/rds-ca.pem';

      require('./database');

      expect(PoolMock.mock.calls[0][0]).toMatchObject({ ssl: false });
    });

    it('never sets rejectUnauthorized: false, in any environment', () => {
      process.env.NODE_ENV = 'production';

      require('./database');

      const sslOption = PoolMock.mock.calls[0][0].ssl;
      expect(sslOption).not.toEqual(expect.objectContaining({ rejectUnauthorized: false }));
    });

    it('sets ssl: { rejectUnauthorized: true } in production when DB_CA_PATH is unset', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.DB_CA_PATH;

      require('./database');

      expect(PoolMock.mock.calls[0][0]).toMatchObject({ ssl: { rejectUnauthorized: true } });
    });

    it('loads and includes the CA bundle when DB_CA_PATH is set in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.DB_CA_PATH = '/certs/rds-ca.pem';

      const mockCaContents = Buffer.from('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----');
      const readFileSyncMock = jest.fn(() => mockCaContents);
      jest.doMock('fs', () => ({ readFileSync: readFileSyncMock }));

      require('./database');

      expect(readFileSyncMock).toHaveBeenCalledWith('/certs/rds-ca.pem');
      expect(PoolMock.mock.calls[0][0]).toMatchObject({
        ssl: { rejectUnauthorized: true, ca: mockCaContents }
      });
    });
  });

  it('constructs the Pool with the DB_POOL_MAX env value', () => {
    process.env.DB_POOL_MAX = '75';

    require('./database');

    expect(PoolMock).toHaveBeenCalledTimes(1);
    expect(PoolMock.mock.calls[0][0]).toMatchObject({ max: 75 });
  });

  it('defaults max to 20 when DB_POOL_MAX is unset', () => {
    delete process.env.DB_POOL_MAX;

    require('./database');

    expect(PoolMock.mock.calls[0][0]).toMatchObject({ max: 20 });
  });

  it('defaults max to 20 when DB_POOL_MAX is not a valid number', () => {
    process.env.DB_POOL_MAX = 'not-a-number';

    require('./database');

    expect(PoolMock.mock.calls[0][0]).toMatchObject({ max: 20 });
  });

  it('registers an error handler on the pool that does not throw', () => {
    require('./database');

    expect(mockPoolInstance.on).toHaveBeenCalledWith('error', expect.any(Function));

    const errorHandler = mockPoolInstance.on.mock.calls.find(
      ([eventName]) => eventName === 'error'
    )[1];

    expect(() => errorHandler(new Error('idle client error'))).not.toThrow();
  });
});
