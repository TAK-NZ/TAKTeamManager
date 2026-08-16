/**
 * Unit tests for `AuthentikService.createAppPasswordToken` (Requirement
 * 27 Criteria 5-7, task 49.3): creates an Authentik `app_password` token
 * scoped to a specific user, expiring no later than the given
 * `expiresInMinutes`, then fetches and returns its plaintext key via
 * Authentik's `GET /core/tokens/{identifier}/view_key/` endpoint (the
 * only endpoint that ever returns token key material).
 */

jest.mock('axios');

describe('AuthentikService.createAppPasswordToken', () => {
  let mockClient;
  let authentikService;

  beforeEach(() => {
    jest.resetModules();
    mockClient = {
      post: jest.fn(),
      get: jest.fn()
    };
    // Re-require axios AFTER resetModules so the mocked `create` is set on
    // the SAME axios module instance `./authentik` resolves when it is
    // required next (resetModules clears the require cache, so requiring
    // axios beforehand at file scope would set `.create` on a now-stale
    // module instance).
    const axios = require('axios');
    axios.create = jest.fn(() => mockClient);
    authentikService = require('./authentik');
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
});
