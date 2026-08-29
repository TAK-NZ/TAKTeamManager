/**
 * Unit tests for `AuthentikService.createAppPasswordToken` (Requirement
 * 27 Criteria 5-7, task 49.3): creates an Authentik `app_password` token
 * scoped to a specific user, expiring no later than the given
 * `expiresInMinutes`, then fetches and returns its plaintext key via
 * Authentik's `GET /core/tokens/{identifier}/view_key/` endpoint (the
 * only endpoint that ever returns token key material).
 */

jest.mock('axios');

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

describe('AuthentikService.createAppPasswordToken', () => {
  let mockClient;
  let authentikService;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockClient = {
      post: jest.fn(),
      get: jest.fn(),
      delete: jest.fn()
    };
    // Re-require axios AFTER resetModules so the mocked `create` is set on
    // the SAME axios module instance `./authentik` resolves when it is
    // required next (resetModules clears the require cache, so requiring
    // axios beforehand at file scope would set `.create` on a now-stale
    // module instance).
    const axios = require('axios');
    // Both the least-privilege client and the isolated enrollment-admin
    // client are built via this same `axios.create` mock, so both resolve
    // to `mockClient` here -- fine for these tests, which only assert on
    // the calls `createAppPasswordToken` itself makes.
    axios.create = jest.fn(() => mockClient);
    // Least-privilege-token follow-up: `createAppPasswordToken` now uses
    // the ISOLATED `enrollmentClient`, built only when
    // AUTHENTIK_ENROLLMENT_ADMIN_TOKEN is set. Set here so the existing
    // assertions below (which target `mockClient` directly) keep exercising
    // the real code path rather than the "not configured" guard, which has
    // its own dedicated test further down.
    process.env.AUTHENTIK_ENROLLMENT_ADMIN_TOKEN = 'enrollment-admin-token-value';
    authentikService = require('./authentik');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('creates an app_password token scoped to the given user, expiring within the given minutes, and returns its key', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(new Date('2024-01-01T00:00:00.000Z').getTime());

    mockClient.post.mockResolvedValue({
      data: { identifier: 'device-enrollment-abc', expires: '2024-01-01T00:30:00.000Z' }
    });
    mockClient.get.mockResolvedValue({ data: { key: 'plaintext-app-password' } });

    const result = await authentikService.createAppPasswordToken(987, {
      identifier: 'device-enrollment-abc',
      expiresInMinutes: 30
    });

    expect(mockClient.post).toHaveBeenCalledWith('/core/tokens/', {
      identifier: 'device-enrollment-abc',
      intent: 'app_password',
      user: 987,
      expiring: true,
      expires: '2024-01-01T00:30:00.000Z'
    });
    expect(mockClient.get).toHaveBeenCalledWith('/core/tokens/device-enrollment-abc/view_key/');

    expect(result).toEqual({
      identifier: 'device-enrollment-abc',
      expires: '2024-01-01T00:30:00.000Z',
      key: 'plaintext-app-password'
    });

    nowSpy.mockRestore();
  });

  it('URL-encodes the identifier when fetching the token key', async () => {
    mockClient.post.mockResolvedValue({
      data: { identifier: 'device enrollment/weird', expires: '2024-01-01T00:30:00.000Z' }
    });
    mockClient.get.mockResolvedValue({ data: { key: 'k' } });

    await authentikService.createAppPasswordToken(1, {
      identifier: 'device enrollment/weird',
      expiresInMinutes: 30
    });

    expect(mockClient.get).toHaveBeenCalledWith('/core/tokens/device%20enrollment%2Fweird/view_key/');
  });

  it('propagates a token-creation failure with no compensating delete attempted', async () => {
    const createError = new Error('Authentik unreachable');
    mockClient.post.mockRejectedValue(createError);

    await expect(
      authentikService.createAppPasswordToken(987, {
        identifier: 'device-enrollment-abc',
        expiresInMinutes: 30
      })
    ).rejects.toBe(createError);

    expect(mockClient.get).not.toHaveBeenCalled();
    expect(mockClient.delete).not.toHaveBeenCalled();
  });

  it('compensates a key-fetch failure by deleting the token, then rethrows the ORIGINAL key-fetch error', async () => {
    mockClient.post.mockResolvedValue({
      data: { identifier: 'device-enrollment-abc', expires: '2024-01-01T00:30:00.000Z' }
    });
    const keyFetchError = new Error('view_key endpoint unreachable');
    mockClient.get.mockRejectedValue(keyFetchError);
    mockClient.delete.mockResolvedValue({ status: 204 });

    await expect(
      authentikService.createAppPasswordToken(987, {
        identifier: 'device-enrollment-abc',
        expiresInMinutes: 30
      })
    ).rejects.toBe(keyFetchError);

    expect(mockClient.delete).toHaveBeenCalledWith('/core/tokens/device-enrollment-abc/');
    expect(mockLoggerInstance.error).not.toHaveBeenCalled();
  });

  it('logs the token IDENTIFIER (never a key) at error level, and still rethrows the original key-fetch error, when the compensating delete also fails', async () => {
    mockClient.post.mockResolvedValue({
      data: { identifier: 'device-enrollment-abc', expires: '2024-01-01T00:30:00.000Z' }
    });
    const keyFetchError = new Error('view_key endpoint unreachable');
    mockClient.get.mockRejectedValue(keyFetchError);
    const deleteError = new Error('delete also unreachable');
    mockClient.delete.mockRejectedValue(deleteError);

    await expect(
      authentikService.createAppPasswordToken(987, {
        identifier: 'device-enrollment-abc',
        expiresInMinutes: 30
      })
    ).rejects.toBe(keyFetchError);

    expect(mockClient.delete).toHaveBeenCalledWith('/core/tokens/device-enrollment-abc/');
    expect(mockLoggerInstance.error).toHaveBeenCalledTimes(1);
    const [logFields] = mockLoggerInstance.error.mock.calls[0];
    expect(logFields.identifier).toBe('device-enrollment-abc');
    expect(logFields).not.toHaveProperty('key');
  });

  // Least-privilege-token follow-up (auth-infra's
  // TAKTEAMMANAGER-AUTHENTIK-LEAST-PRIVILEGE.md, "Option A"): this method
  // is the one deliberate exception that still needs a superuser token,
  // isolated behind its own env var rather than folded into the
  // least-privilege AUTHENTIK_API_TOKEN client every other method uses.
  it('throws a clear, named error and makes NO Authentik call when AUTHENTIK_ENROLLMENT_ADMIN_TOKEN is not configured', async () => {
    // Re-require with the isolated token unset, so `enrollmentClient` is
    // null -- unlike every other test in this file, which sets it in
    // `beforeEach`.
    delete process.env.AUTHENTIK_ENROLLMENT_ADMIN_TOKEN;
    jest.resetModules();
    const axios = require('axios');
    axios.create = jest.fn(() => mockClient);
    const unconfiguredAuthentikService = require('./authentik');

    await expect(
      unconfiguredAuthentikService.createAppPasswordToken(987, {
        identifier: 'device-enrollment-abc',
        expiresInMinutes: 30
      })
    ).rejects.toThrow(/AUTHENTIK_ENROLLMENT_ADMIN_TOKEN is not configured/);

    expect(mockClient.post).not.toHaveBeenCalled();
    expect(mockClient.get).not.toHaveBeenCalled();
    expect(mockClient.delete).not.toHaveBeenCalled();
  });

  // Confirms the isolation itself: the enrollment client is a SEPARATE
  // axios instance, authenticated with the isolated token, not a reuse of
  // the least-privilege client `this.client` builds in the constructor.
  it('builds the enrollment client with its own Authorization header, separate from the least-privilege client', async () => {
    let capturedConfigs = [];
    jest.resetModules();
    const axios = require('axios');
    axios.create = jest.fn((config) => {
      capturedConfigs.push(config);
      return mockClient;
    });
    process.env.AUTHENTIK_ENROLLMENT_ADMIN_TOKEN = 'enrollment-admin-token-value';
    process.env.AUTHENTIK_API_TOKEN = 'least-privilege-token-value';
    require('./authentik');

    expect(capturedConfigs).toHaveLength(2);
    const [leastPrivilegeConfig, enrollmentConfig] = capturedConfigs;
    expect(leastPrivilegeConfig.headers.Authorization).toBe('Bearer least-privilege-token-value');
    expect(enrollmentConfig.headers.Authorization).toBe('Bearer enrollment-admin-token-value');
  });
});
