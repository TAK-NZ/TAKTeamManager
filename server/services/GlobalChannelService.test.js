jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));
jest.mock('./CredentialEncryptionService', () => ({
  encrypt: jest.fn(),
  decrypt: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const CredentialEncryptionService = require('./CredentialEncryptionService');
const GlobalChannelService = require('./GlobalChannelService');

describe('GlobalChannelService.deleteGlobalChannel', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    service = new GlobalChannelService();
  });

  it('deletes from bch_channels when channelType is "bch"', async () => {
    await service.deleteGlobalChannel(1, 'bch', 99);

    const deleteCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM')
    );
    expect(deleteCall[0]).toContain('bch_channels');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('deletes from region_channels when channelType is "region"', async () => {
    await service.deleteGlobalChannel(1, 'region', 99);

    const deleteCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM')
    );
    expect(deleteCall[0]).toContain('region_channels');
  });

  it('rejects a channelType absent from the allow-list before connecting to the database', async () => {
    await expect(
      service.deleteGlobalChannel(1, 'DROP TABLE users; --', 99)
    ).rejects.toThrow('Invalid channel type');

    expect(pool.connect).not.toHaveBeenCalled();
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('rejects an unmapped but plausible-looking channelType (e.g. "team")', async () => {
    await expect(service.deleteGlobalChannel(1, 'team', 99)).rejects.toThrow(
      'Invalid channel type'
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a missing/undefined channelType', async () => {
    await expect(service.deleteGlobalChannel(1, undefined, 99)).rejects.toThrow(
      'Invalid channel type'
    );
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('never interpolates the raw channelType value into the SQL string', async () => {
    // Even for valid types, the executed SQL must come from the frozen
    // allow-list table name, not from echoing the caller-controlled value.
    await service.deleteGlobalChannel(1, 'bch', 99);
    const deleteCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM')
    );
    expect(deleteCall[0]).not.toContain('${channelType}');
  });
});

describe('GlobalChannelService.createBchChannel', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 42 }] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    CredentialEncryptionService.encrypt.mockImplementation(
      (plaintext) => `encrypted(${plaintext})`
    );
    service = new GlobalChannelService();
  });

  it('stores an encrypted value in the INSERT parameters, not the plaintext', async () => {
    await service.createBchChannel({ name: 'Test Channel', description: 'desc' }, 7);

    expect(CredentialEncryptionService.encrypt).toHaveBeenCalledTimes(1);
    const plaintextPassword = CredentialEncryptionService.encrypt.mock.calls[0][0];
    expect(typeof plaintextPassword).toBe('string');

    const insertCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall[1];
    // service_account_password is the 4th positional parameter ($4)
    expect(insertParams[3]).toBe(`encrypted(${plaintextPassword})`);
    expect(insertParams[3]).not.toBe(plaintextPassword);
  });

  it('still publishes the plaintext password in the sync operation payload', async () => {
    await service.createBchChannel({ name: 'Test Channel', description: 'desc' }, 7);

    const plaintextPassword = CredentialEncryptionService.encrypt.mock.calls[0][0];

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_bch_channel_groups',
      expect.objectContaining({
        service_account_password: plaintextPassword
      }),
      7
    );
  });
});

describe('GlobalChannelService.getBchChannelCredentials', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GlobalChannelService();
  });

  it('returns the decrypted plaintext password to the caller', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ is_global_manager: true }] }) // requester check
      .mockResolvedValueOnce({
        rows: [
          {
            service_account_username: 'etl-test',
            service_account_password: 'iv:authTag:ciphertext'
          }
        ]
      }); // credential fetch
    CredentialEncryptionService.decrypt.mockReturnValue('plaintext-password');

    const credentials = await service.getBchChannelCredentials(1, 99);

    expect(CredentialEncryptionService.decrypt).toHaveBeenCalledWith('iv:authTag:ciphertext');
    expect(credentials.service_account_password).toBe('plaintext-password');
  });

  it('logs the successful access as an auditable event with actorId/channelId/timestamp', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ is_global_manager: true }] })
      .mockResolvedValueOnce({
        rows: [
          {
            service_account_username: 'etl-test',
            service_account_password: 'iv:authTag:ciphertext'
          }
        ]
      });
    CredentialEncryptionService.decrypt.mockReturnValue('plaintext-password');

    await service.getBchChannelCredentials(1, 99);

    expect(mockLoggerInstance.info).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 99,
        channelId: 1,
        event: 'credential_access',
        accessedAt: expect.any(String)
      }),
      expect.any(String)
    );

    // The plaintext password must never appear in the logged fields.
    const loggedArgs = mockLoggerInstance.info.mock.calls[0][0];
    expect(JSON.stringify(loggedArgs)).not.toContain('plaintext-password');
  });

  it('throws a generic error and logs the failure without leaking plaintext/ciphertext on decrypt failure', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ is_global_manager: true }] })
      .mockResolvedValueOnce({
        rows: [
          {
            service_account_username: 'etl-test',
            service_account_password: 'corrupted-ciphertext'
          }
        ]
      });
    CredentialEncryptionService.decrypt.mockImplementation(() => {
      throw new Error('Decryption failed');
    });

    await expect(service.getBchChannelCredentials(1, 99)).rejects.toThrow('Decryption failed');

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 1,
        actorId: 99,
        event: 'credential_decrypt_failure'
      }),
      expect.any(String)
    );

    // Neither the ciphertext nor any internal crypto error detail should be
    // present in the error thrown to the caller.
    const loggedArgs = mockLoggerInstance.error.mock.calls[0][0];
    expect(JSON.stringify(loggedArgs)).not.toContain('corrupted-ciphertext');

    // No successful-access audit log should be emitted on failure.
    expect(mockLoggerInstance.info).not.toHaveBeenCalled();
  });
});
