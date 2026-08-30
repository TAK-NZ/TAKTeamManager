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
    // service_account_password is the 5th positional parameter ($5) --
    // name, display_name, description, service_account_username,
    // service_account_password, created_by.
    expect(insertParams[4]).toBe(`encrypted(${plaintextPassword})`);
    expect(insertParams[4]).not.toBe(plaintextPassword);
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

  // bch-channel-category: `category` defaults to 'BCH' when the caller
  // omits it entirely, so every pre-existing caller (no category tests
  // above pass one) keeps working unchanged -- mirrors createRegionChannel's
  // tier-validation tests below in shape, minus the "missing" case being
  // an ERROR there vs. a DEFAULT here.
  it('defaults category to "BCH" when omitted, and stores it as the 6th INSERT parameter', async () => {
    await service.createBchChannel({ name: 'Test Channel', description: 'desc' }, 7);

    const insertCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')
    );
    expect(insertCall).toBeDefined();
    // name, display_name, description, service_account_username,
    // service_account_password, category, created_by.
    expect(insertCall[1][5]).toBe('BCH');
  });

  it('rejects an invalid category before ever connecting to the database', async () => {
    await expect(
      service.createBchChannel({ name: 'Test Channel', description: 'desc', category: 'bogus' }, 7)
    ).rejects.toThrow("Invalid channel category: must be 'BCH' or 'UTL'");

    expect(pool.connect).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('stores a supplied "UTL" category as the 6th INSERT parameter', async () => {
    await service.createBchChannel({ name: 'Data Packages', description: 'desc', category: 'UTL' }, 7);

    const insertCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO bch_channels')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1][5]).toBe('UTL');
  });

  it('publishes create_bch_channel_groups with category included in the payload', async () => {
    await service.createBchChannel({ name: 'Data Packages', description: 'desc', category: 'UTL' }, 7);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_bch_channel_groups',
      expect.objectContaining({
        bch_channel_id: 42,
        channel_name: 'Data Packages',
        category: 'UTL'
      }),
      7
    );
  });

  // Bugfix: `description` was previously missing from this payload
  // entirely, so a freshly created channel's Authentik groups had no
  // `attributes.description` at all until the next edit.
  it('publishes create_bch_channel_groups with the supplied description included in the payload', async () => {
    await service.createBchChannel({ name: 'Data Packages', description: 'Data package delivery channel', category: 'UTL' }, 7);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_bch_channel_groups',
      expect.objectContaining({ description: 'Data package delivery channel' }),
      7
    );
  });

  it('builds the group_membership_rules target_group_pattern with the BCH category prefix by default', async () => {
    await service.createBchChannel({ name: 'Test Channel', description: 'desc' }, 7);

    const ruleCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO group_membership_rules')
    );
    expect(ruleCall).toBeDefined();
    expect(ruleCall[1]).toContain('tak_BCH - Test Channel_READ');
    expect(ruleCall[1]).toContain('tak_BCH - Test Channel');
  });

  it('builds the group_membership_rules target_group_pattern with the UTL category prefix when supplied', async () => {
    await service.createBchChannel({ name: 'Data Packages', description: 'desc', category: 'UTL' }, 7);

    const ruleCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO group_membership_rules')
    );
    expect(ruleCall).toBeDefined();
    expect(ruleCall[1]).toContain('tak_UTL - Data Packages_READ');
    expect(ruleCall[1]).toContain('tak_UTL - Data Packages');
  });
});

describe('GlobalChannelService.updateBchChannel', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    service = new GlobalChannelService();
  });

  // bch-channel-category: category is immutable after creation -- there
  // is no rename-category API, so updateBchChannel reads the row's OWN
  // stored category back (never accepts one from the caller) and
  // forwards it to update_bch_channel_group so the worker's rename PATCH
  // builds the correct tak_BCH.../tak_UTL... group name.
  it('reads the row\'s own stored category back and includes it in the update_bch_channel_group payload', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT category FROM bch_channels')) {
        return Promise.resolve({ rows: [{ category: 'UTL' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await service.updateBchChannel(42, { name: 'Data Packages', description: 'desc' }, 7);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_bch_channel_group',
      expect.objectContaining({
        bch_channel_id: 42,
        channel_name: 'Data Packages',
        category: 'UTL',
        description: 'desc'
      }),
      7
    );
  });

  it('falls back to "BCH" when the row lookup returns no category (defensive default)', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT category FROM bch_channels')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await service.updateBchChannel(42, { name: 'Test Channel', description: 'desc' }, 7);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_bch_channel_group',
      expect.objectContaining({ category: 'BCH' }),
      7
    );
  });

  it('never accepts a caller-supplied category -- only the value read back from the row is ever forwarded', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT category FROM bch_channels')) {
        return Promise.resolve({ rows: [{ category: 'BCH' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    // Even if a caller smuggled a 'category' field into channelData, it
    // must be ignored in favor of the row's real, immutable value.
    await service.updateBchChannel(42, { name: 'Test Channel', description: 'desc', category: 'UTL' }, 7);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'update_bch_channel_group',
      expect.objectContaining({ category: 'BCH' }),
      7
    );
  });
});

describe('GlobalChannelService.createRegionChannel', () => {
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
    service = new GlobalChannelService();
  });

  it('rejects an invalid tier before ever connecting to the database', async () => {
    await expect(
      service.createRegionChannel({ name: 'Northland', description: 'x', tier: 'bogus' }, 7)
    ).rejects.toThrow("Invalid channel tier: must be 'response' or 'support'");

    expect(pool.connect).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('rejects a missing/undefined tier', async () => {
    await expect(
      service.createRegionChannel({ name: 'Northland', description: 'x' }, 7)
    ).rejects.toThrow("Invalid channel tier: must be 'response' or 'support'");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('inserts into region_channels with the supplied tier as the 4th positional parameter', async () => {
    await service.createRegionChannel({ name: 'Northland', description: 'x', tier: 'response' }, 7);

    const insertCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO region_channels')
    );
    expect(insertCall).toBeDefined();
    // name, display_name, description, tier, created_by
    expect(insertCall[1]).toEqual(['Northland', 'Northland', 'x', 'response', 7]);
  });

  it('publishes create_region_channel_group with the tier included in the payload', async () => {
    await service.createRegionChannel({ name: 'Northland', description: 'x', tier: 'support' }, 7);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_region_channel_group',
      expect.objectContaining({
        region_channel_id: 42,
        channel_name: 'Northland',
        tier: 'support'
      }),
      7
    );
  });

  it('builds the group_membership_rules target_group_pattern with the Response tier prefix', async () => {
    await service.createRegionChannel({ name: 'Northland', description: 'x', tier: 'response' }, 7);

    const ruleCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO group_membership_rules')
    );
    expect(ruleCall).toBeDefined();
    expect(ruleCall[1]).toContain('tak_Response - Northland');
  });

  it('builds the group_membership_rules target_group_pattern with the Support tier prefix', async () => {
    await service.createRegionChannel({ name: 'Northland', description: 'x', tier: 'support' }, 7);

    const ruleCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO group_membership_rules')
    );
    expect(ruleCall).toBeDefined();
    expect(ruleCall[1]).toContain('tak_Support - Northland');
  });

  it('rolls back the transaction and never publishes the sync operation when the INSERT fails', async () => {
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO region_channels')) {
        return Promise.reject(new Error('db unavailable'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      service.createRegionChannel({ name: 'Northland', description: 'x', tier: 'response' }, 7)
    ).rejects.toThrow('db unavailable');

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });
});

describe('GlobalChannelService.seedRegionChannels', () => {
  let service;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
      release: jest.fn()
    };
    pool.connect.mockResolvedValue(mockClient);
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    service = new GlobalChannelService();
  });

  it('builds a 35-item work list: 16 standard regions x 2 tiers, plus Chatham Islands x 2 tiers, plus All of New Zealand support-only', async () => {
    // No existing rows -- every work item is created.
    pool.query.mockResolvedValue({ rows: [] });

    const result = await service.seedRegionChannels(7);

    expect(result).toEqual({ created: 35, skipped: 0, failed: 0 });
    // 16 * 2 + 2 (Chatham both tiers) + 1 (All of NZ support only) = 35
    expect(mockClient.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO region_channels')
    )).toHaveLength(35);
  });

  it('seeds "All of New Zealand" as support tier only, never response', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await service.seedRegionChannels(7);

    const insertedTiersForNzWide = mockClient.query.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO region_channels'))
      .map(([, params]) => params)
      .filter((params) => params[0] === 'All of New Zealand')
      .map((params) => params[3]);

    expect(insertedTiersForNzWide).toEqual(['support']);
  });

  it('seeds "Chatham Islands" for both tiers', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await service.seedRegionChannels(7);

    const insertedTiersForChatham = mockClient.query.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO region_channels'))
      .map(([, params]) => params)
      .filter((params) => params[0] === 'Chatham Islands')
      .map((params) => params[3])
      .sort();

    expect(insertedTiersForChatham).toEqual(['response', 'support']);
  });

  it('is idempotent: an existing (name, tier) row is skipped, not duplicated', async () => {
    // Every existence check reports a match -- nothing should be created.
    pool.query.mockResolvedValue({ rows: [{ id: 1 }] });

    const result = await service.seedRegionChannels(7);

    expect(result).toEqual({ created: 0, skipped: 35, failed: 0 });
    expect(mockClient.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO region_channels')
    )).toHaveLength(0);
  });

  // Bugfix: a seeded response/support pair for the same region name must
  // have DISTINGUISHABLE descriptions -- `description: name` alone gave
  // "Auckland" for both, with no way for a user to tell which tier they
  // were looking at.
  it('gives the response and support channel for the same region name distinguishable descriptions', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await service.seedRegionChannels(7);

    const aucklandInserts = mockClient.query.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO region_channels'))
      .map(([, params]) => params)
      .filter((params) => params[0] === 'Auckland');

    expect(aucklandInserts).toHaveLength(2);
    // name, display_name, description, tier, created_by
    const descriptionsByTier = Object.fromEntries(
      aucklandInserts.map((params) => [params[3], params[2]])
    );
    expect(descriptionsByTier.response).not.toBe(descriptionsByTier.support);
    expect(descriptionsByTier.response).toContain('Auckland');
    expect(descriptionsByTier.support).toContain('Auckland');
    expect(descriptionsByTier.response).toMatch(/Response/);
    expect(descriptionsByTier.support).toMatch(/Support/);
  });

  it('checks existence case-insensitively and scoped by tier via a single ILIKE + tier query', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await service.seedRegionChannels(7);

    const existenceCall = pool.query.mock.calls.find(
      ([sql, params]) =>
        typeof sql === 'string' &&
        sql.includes('ILIKE') &&
        sql.includes('region_channels') &&
        params[0] === 'Northland' &&
        params[1] === 'response'
    );
    expect(existenceCall).toBeDefined();
  });

  it('continues past one failed work item and still counts/creates the remaining ones', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    let insertCount = 0;
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO region_channels')) {
        insertCount++;
        if (insertCount === 1) {
          return Promise.reject(new Error('simulated Authentik failure'));
        }
        return Promise.resolve({ rows: [{ id: insertCount }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await service.seedRegionChannels(7);

    expect(result.failed).toBe(1);
    expect(result.created).toBe(34);
    expect(result.skipped).toBe(0);
  });

  it('passes createdBy through to each created region channel', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await service.seedRegionChannels(99);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'create_region_channel_group',
      expect.any(Object),
      99
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
