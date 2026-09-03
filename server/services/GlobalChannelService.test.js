jest.mock('../config/database', () => ({
  connect: jest.fn(),
  query: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn(),
  publishOperationsBatch: jest.fn(),
  publishBulkOperation: jest.fn()
}));
jest.mock('./CredentialEncryptionService', () => ({
  encrypt: jest.fn(),
  decrypt: jest.fn()
}));
// Bugfix (collision/takeover risk): checkServiceAccountUsernameAvailability
// calls authentikService.getUserByUsername -- mocked so tests control
// whether Authentik reports the candidate username as already taken.
jest.mock('./authentik', () => ({
  getUserByUsername: jest.fn()
}));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const pool = require('../config/database');
const EventPublisher = require('./EventPublisher');
const CredentialEncryptionService = require('./CredentialEncryptionService');
const authentikService = require('./authentik');
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

  it('builds the group_membership_rules target_group_pattern with the UTL category\'s XtraTools display prefix when supplied', async () => {
    await service.createBchChannel({ name: 'Data Packages', description: 'desc', category: 'UTL' }, 7);

    const ruleCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO group_membership_rules')
    );
    expect(ruleCall).toBeDefined();
    expect(ruleCall[1]).toContain('tak_XtraTools - Data Packages_READ');
    expect(ruleCall[1]).toContain('tak_XtraTools - Data Packages');
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
    // Bugfix: no longer mocks a first "requester check" pool.query call --
    // this method used to re-check `users.is_global_manager` itself (a
    // dead column, always false), which the fix removed. Authorization
    // for this route is the `authorize` middleware's job, already tested
    // separately; this service method's only remaining pool.query call is
    // the credential fetch itself.
    pool.query.mockResolvedValueOnce({
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
    pool.query.mockResolvedValueOnce({
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
    pool.query.mockResolvedValueOnce({
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

// Bugfix (collision/takeover risk): checkServiceAccountUsernameAvailability.
describe('GlobalChannelService.checkServiceAccountUsernameAvailability', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GlobalChannelService();
  });

  it('reports available when neither the local table nor Authentik has a matching username', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    authentikService.getUserByUsername.mockResolvedValue(null);

    const result = await service.checkServiceAccountUsernameAvailability('etl-new-channel');

    expect(result).toEqual({ available: true });
  });

  it('reports unavailable, naming the conflicting channel, when another bch_channels row already owns the username', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 5, name: 'Data Packages' }] });
    authentikService.getUserByUsername.mockResolvedValue(null);

    const result = await service.checkServiceAccountUsernameAvailability('etl-data-packages');

    expect(result.available).toBe(false);
    expect(result.reason).toContain('Data Packages');
  });

  it('excludes excludeChannelId from the local-conflict query, via the SQL parameter', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    authentikService.getUserByUsername.mockResolvedValue(null);

    await service.checkServiceAccountUsernameAvailability('etl-data-packages', 7);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('id <> $2'),
      ['etl-data-packages', 7]
    );
  });

  it('reports unavailable when Authentik already has a user with this username, even with no local conflict', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    authentikService.getUserByUsername.mockResolvedValue({ pk: 42, username: 'etl-someone-elses' });

    const result = await service.checkServiceAccountUsernameAvailability('etl-someone-elses');

    expect(result.available).toBe(false);
    expect(result.reason).toContain('etl-someone-elses');
  });

  it('checks the local table BEFORE calling Authentik, and short-circuits without calling it on a local conflict', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 5, name: 'Data Packages' }] });

    await service.checkServiceAccountUsernameAvailability('etl-data-packages');

    expect(authentikService.getUserByUsername).not.toHaveBeenCalled();
  });

  it('propagates (fails closed) when the Authentik lookup itself throws, rather than reporting available', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    authentikService.getUserByUsername.mockRejectedValue(new Error('Authentik unreachable'));

    await expect(service.checkServiceAccountUsernameAvailability('etl-data-packages')).rejects.toThrow(
      'Authentik unreachable'
    );
  });
});

// Bugfix (a BCH/UTL channel imported via "Sync Existing Channels" has no
// service account): GlobalChannelService.provisionServiceAccount.
describe('GlobalChannelService.provisionServiceAccount', () => {
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
    CredentialEncryptionService.encrypt.mockImplementation(
      (plaintext) => `encrypted(${plaintext})`
    );
    // Available by default in every test below unless a test overrides
    // this -- most of this describe block is about provisioning
    // mechanics, not the availability check itself (which has its own
    // dedicated describe block above).
    authentikService.getUserByUsername.mockResolvedValue(null);
    service = new GlobalChannelService();
  });

  /**
   * Configures `pool.query` (the precheck SELECT, run before any
   * transaction is opened, and the availability check's own local-conflict
   * SELECT) AND `mockClient.query` (the transaction's re-SELECT, UPDATE,
   * BEGIN/COMMIT/ROLLBACK) to agree on the same channel row -- both must
   * return it identically, since `provisionServiceAccount` reads it
   * twice (once outside the transaction, once inside with a lock) by
   * design (see the method's own doc comment on closing that race).
   */
  function mockChannelRow(overrides = {}) {
    const row = {
      name: 'Data Packages',
      service_account_username: null,
      read_group_id: 'grp-read',
      write_group_id: 'grp-write',
      ...overrides
    };
    const selectMatcher = (sql) =>
      typeof sql === 'string' && sql.includes('SELECT name, service_account_username');

    pool.query.mockImplementation((sql) => {
      if (selectMatcher(sql)) {
        return Promise.resolve({ rows: [row] });
      }
      // The availability check's local-conflict query -- no conflicting
      // row by default.
      return Promise.resolve({ rows: [] });
    });
    mockClient.query.mockImplementation((sql) => {
      if (selectMatcher(sql)) {
        return Promise.resolve({ rows: [row] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it("builds the username as 'etl-<slugified-name>', matching createBchChannel's own convention exactly", async () => {
    mockChannelRow({ name: 'Data Packages' });

    const result = await service.provisionServiceAccount(1, 99);

    expect(result.serviceAccountUsername).toBe('etl-data-packages');
  });

  it('always prefixes the generated username with "etl-", per explicit product requirement', async () => {
    mockChannelRow({ name: 'Some Weird Channel Name' });

    const result = await service.provisionServiceAccount(1, 99);

    expect(result.serviceAccountUsername.startsWith('etl-')).toBe(true);
  });

  it('checks availability of the auto-derived default username, not just a custom one', async () => {
    mockChannelRow({ name: 'Data Packages' });

    await service.provisionServiceAccount(1, 99);

    expect(authentikService.getUserByUsername).toHaveBeenCalledWith('etl-data-packages');
  });

  it('encrypts the password before persisting it, and enqueues the plaintext for the Sync_Worker', async () => {
    mockChannelRow();

    await service.provisionServiceAccount(1, 99);

    expect(CredentialEncryptionService.encrypt).toHaveBeenCalledTimes(1);
    const plaintextPassword = CredentialEncryptionService.encrypt.mock.calls[0][0];

    const updateCall = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('UPDATE bch_channels')
    );
    expect(updateCall[1]).toContain(`encrypted(${plaintextPassword})`);
    expect(updateCall[1]).not.toContain(plaintextPassword);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'provision_bch_service_account',
      expect.objectContaining({ service_account_password: plaintextPassword }),
      99,
      mockClient
    );
  });

  it("passes the channel's already-known read_group_id/write_group_id through in the enqueued payload", async () => {
    mockChannelRow({ read_group_id: 'grp-read-123', write_group_id: 'grp-write-456' });

    await service.provisionServiceAccount(1, 99);

    expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
      'provision_bch_service_account',
      expect.objectContaining({
        bch_channel_id: 1,
        read_group_id: 'grp-read-123',
        write_group_id: 'grp-write-456'
      }),
      99,
      mockClient
    );
  });

  it('rejects with "BCH channel not found" and never opens a transaction when no active row matches', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await expect(service.provisionServiceAccount(999, 99)).rejects.toThrow('BCH channel not found');

    expect(pool.connect).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('rejects with a specific message and never opens a transaction when the channel already has a service account', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ name: 'Data Packages', service_account_username: 'etl-already-configured' }]
    });

    await expect(service.provisionServiceAccount(1, 99)).rejects.toThrow(
      'This channel already has a service account configured'
    );

    expect(pool.connect).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('commits the transaction on success', async () => {
    mockChannelRow();

    await service.provisionServiceAccount(1, 99);

    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('rolls back and releases the client when the transaction-scoped re-check finds the row missing (closing the precheck-to-lock race)', async () => {
    // Precheck (pool.query) finds the row, and its own availability
    // check's local-conflict query finds nothing; the transaction's own
    // re-SELECT (mockClient.query) finds the row GONE -- simulating a
    // concurrent delete between the two reads.
    pool.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT name, service_account_username')) {
        return Promise.resolve({ rows: [{ name: 'Data Packages', service_account_username: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockClient.query.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('SELECT name, service_account_username')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.provisionServiceAccount(1, 99)).rejects.toThrow('BCH channel not found');

    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });

  // Bugfix (collision/takeover risk): a username collision is caught
  // BEFORE any transaction is opened, for both the auto-derived default
  // and an admin-supplied custom name.
  describe('collision handling', () => {
    it('rejects with the availability check\'s reason when the auto-derived default collides locally, before opening a transaction', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT name, service_account_username')) {
          return Promise.resolve({ rows: [{ name: 'Data Packages', service_account_username: null }] });
        }
        // The availability check's local-conflict query finds a match.
        return Promise.resolve({ rows: [{ id: 5, name: 'Another Channel' }] });
      });

      await expect(service.provisionServiceAccount(1, 99)).rejects.toThrow(
        'already the service account for another channel'
      );

      expect(pool.connect).not.toHaveBeenCalled();
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('rejects when the auto-derived default already exists in Authentik, before opening a transaction', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT name, service_account_username')) {
          return Promise.resolve({ rows: [{ name: 'Data Packages', service_account_username: null }] });
        }
        return Promise.resolve({ rows: [] });
      });
      authentikService.getUserByUsername.mockResolvedValue({ pk: 1, username: 'etl-data-packages' });

      await expect(service.provisionServiceAccount(1, 99)).rejects.toThrow(
        'already exists in Authentik'
      );

      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('rejects when a custom username collides, before opening a transaction', async () => {
      pool.query.mockImplementation((sql) => {
        if (typeof sql === 'string' && sql.includes('SELECT name, service_account_username')) {
          return Promise.resolve({ rows: [{ name: 'Data Packages', service_account_username: null }] });
        }
        return Promise.resolve({ rows: [{ id: 5, name: 'Another Channel' }] });
      });

      await expect(service.provisionServiceAccount(1, 99, 'etl-taken-name')).rejects.toThrow(
        'already the service account for another channel'
      );

      expect(pool.connect).not.toHaveBeenCalled();
    });
  });

  // Bugfix (Add Service Account modal): an admin-supplied custom name,
  // rather than the channel-name-derived default.
  describe('with a custom username (the "Add Service Account" dialog)', () => {
    it('uses the supplied custom username instead of deriving one from the channel name', async () => {
      mockChannelRow({ name: 'Data Packages' });

      const result = await service.provisionServiceAccount(1, 99, 'etl-custom-name');

      expect(result.serviceAccountUsername).toBe('etl-custom-name');
      expect(EventPublisher.publishOperation).toHaveBeenCalledWith(
        'provision_bch_service_account',
        expect.objectContaining({ service_account_username: 'etl-custom-name' }),
        99,
        mockClient
      );
    });

    it('rejects a custom username with no etl- prefix, before ever connecting to the database', async () => {
      await expect(service.provisionServiceAccount(1, 99, 'not-etl-prefixed')).rejects.toThrow(
        'Service account username must start with "etl-"'
      );

      expect(pool.query).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('rejects a custom username with invalid characters after the prefix', async () => {
      await expect(service.provisionServiceAccount(1, 99, 'etl-Has Spaces')).rejects.toThrow(
        'Service account username must start with "etl-"'
      );

      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('rejects a custom username that is only the bare prefix', async () => {
      await expect(service.provisionServiceAccount(1, 99, 'etl-')).rejects.toThrow(
        'Service account username must start with "etl-"'
      );

      expect(pool.connect).not.toHaveBeenCalled();
    });

    it('falls back to the channel-name-derived default when customUsername is null', async () => {
      mockChannelRow({ name: 'Data Packages' });

      const result = await service.provisionServiceAccount(1, 99, null);

      expect(result.serviceAccountUsername).toBe('etl-data-packages');
    });
  });
});


/**
 * Performance-hardening: `assignAllUsersToGlobalChannels` enqueues its
 * per-user `assign_user_to_global_channels` operations via
 * `EventPublisher.publishOperationsBatch` (one/few multi-row INSERTs)
 * rather than one `publishOperation` call per user in a sequential loop
 * -- at the documented 50,000-user scale, the former issued 50,000
 * individual round trips before the Sync_Worker even started draining
 * the queue.
 */
describe('GlobalChannelService.assignAllUsersToGlobalChannels', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GlobalChannelService();
  });

  it('enqueues one batched publishOperationsBatch call with one payload per active user, after a single bulk-operation record', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    EventPublisher.publishBulkOperation.mockResolvedValue('bulk-op-99');

    const result = await service.assignAllUsersToGlobalChannels();

    expect(pool.query).toHaveBeenCalledWith('SELECT id FROM users WHERE is_active = true');
    expect(EventPublisher.publishBulkOperation).toHaveBeenCalledWith(
      expect.stringContaining('3'),
      3,
      null
    );
    expect(EventPublisher.publishOperationsBatch).toHaveBeenCalledTimes(1);
    expect(EventPublisher.publishOperationsBatch).toHaveBeenCalledWith(
      'assign_user_to_global_channels',
      [
        { target_user_id: 1, bulk_operation_id: 'bulk-op-99' },
        { target_user_id: 2, bulk_operation_id: 'bulk-op-99' },
        { target_user_id: 3, bulk_operation_id: 'bulk-op-99' }
      ]
    );
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(result).toEqual({ usersProcessed: 3, bulkOperationId: 'bulk-op-99' });
  });

  it('does nothing (no bulk op, no batch enqueue) when there are no active users', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const result = await service.assignAllUsersToGlobalChannels();

    expect(EventPublisher.publishBulkOperation).not.toHaveBeenCalled();
    expect(EventPublisher.publishOperationsBatch).not.toHaveBeenCalled();
    expect(result).toEqual({ usersProcessed: 0 });
  });
});
