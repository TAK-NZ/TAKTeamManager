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

/**
 * device-management follow-up: `AuthentikService.createUser` defaults to
 * `type: 'internal'` when the caller passes no `type` (every EXISTING
 * caller -- `routes/users.js`, `RequestApprovalService.js`,
 * `BulkImportService.js`), and sends the caller-supplied `type` verbatim
 * otherwise (`DeviceEnrollmentService.createDevice`, which passes
 * `type: 'service_account'`). Verified live against account.test.tak.nz
 * (see this file's git history / the task's chat record) that Authentik's
 * `POST /core/users/` accepts `type: 'service_account'` directly and that
 * a subsequent `app_password` token mint against that user succeeds
 * identically to an `internal` user.
 */
describe('AuthentikService.createUser', () => {
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
    const axios = require('axios');
    axios.create = jest.fn(() => mockClient);
    authentikService = require('./authentik');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to type: 'internal' when no type is supplied", async () => {
    mockClient.post.mockResolvedValue({ data: { pk: 1, type: 'internal' } });

    await authentikService.createUser({ username: 'jdoe', name: 'Jane Doe', email: 'jdoe@example.com' });

    expect(mockClient.post).toHaveBeenCalledWith('/core/users/', {
      username: 'jdoe',
      name: 'Jane Doe',
      email: 'jdoe@example.com',
      is_active: true,
      type: 'internal'
    });
  });

  it('sends a caller-supplied type verbatim (e.g. service_account for a Team_Owned_Device)', async () => {
    mockClient.post.mockResolvedValue({ data: { pk: 2, type: 'service_account' } });

    await authentikService.createUser({ username: 'AUK-D1', name: 'Engine 4 Tablet', type: 'service_account' });

    expect(mockClient.post).toHaveBeenCalledWith('/core/users/', {
      username: 'AUK-D1',
      name: 'Engine 4 Tablet',
      email: undefined,
      is_active: true,
      type: 'service_account'
    });
  });
});

/**
 * Bugfix: `getUsers` must send a stable `ordering=pk` query param on
 * every request -- Authentik's default ordering for `/core/users/` is
 * alphabetical by username, which is NOT stable across a page boundary
 * while accounts are concurrently created/renamed (e.g. a bulk CSV
 * import racing against a `GET /api/users` request). Without a stable
 * sort key a user can be silently skipped or duplicated between two
 * page fetches. Confirmed live against a real Authentik instance: the
 * default ordering visibly changed page 1's contents between two
 * requests made seconds apart during an active import.
 */
describe('AuthentikService.getUsers', () => {
  let mockClient;
  let authentikService;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockClient = {
      post: jest.fn(),
      get: jest.fn(),
      delete: jest.fn()
    };
    const axios = require('axios');
    axios.create = jest.fn(() => mockClient);
    authentikService = require('./authentik');
  });

  it('includes ordering=pk on the unpaginated (no page/pageSize) call', async () => {
    mockClient.get.mockResolvedValue({ data: { results: [] } });

    await authentikService.getUsers();

    expect(mockClient.get).toHaveBeenCalledWith('/core/users/', { params: { type: 'internal', ordering: 'pk' } });
  });

  it('includes ordering=pk alongside page/page_size on the paginated call', async () => {
    mockClient.get.mockResolvedValue({ data: { results: [], pagination: { count: 0 } } });

    await authentikService.getUsers({ page: 2, pageSize: 25 });

    expect(mockClient.get).toHaveBeenCalledWith('/core/users/', {
      params: { type: 'internal', ordering: 'pk', page: 2, page_size: 25 }
    });
  });

  it('still returns the full result array unchanged on the unpaginated call', async () => {
    const results = [{ pk: 1, username: 'alice' }, { pk: 2, username: 'bob' }];
    mockClient.get.mockResolvedValue({ data: { results } });

    const returned = await authentikService.getUsers();

    expect(returned).toEqual(results);
  });

  it('still returns {results, count} unchanged on the paginated call', async () => {
    const results = [{ pk: 1, username: 'alice' }];
    mockClient.get.mockResolvedValue({ data: { results, pagination: { count: 42 } } });

    const returned = await authentikService.getUsers({ page: 1, pageSize: 50 });

    expect(returned).toEqual({ results, count: 42 });
  });

  // Requirement: server-side search for the paginated /users list.
  // Confirmed live against account.test.tak.nz that Authentik's
  // `search` param matches a substring across username/name/email.
  it('includes a supplied search term as the search param on the paginated call', async () => {
    mockClient.get.mockResolvedValue({ data: { results: [], pagination: { count: 0 } } });

    await authentikService.getUsers({ page: 1, pageSize: 50, search: 'reynolds' });

    expect(mockClient.get).toHaveBeenCalledWith('/core/users/', {
      params: { type: 'internal', ordering: 'pk', page: 1, page_size: 50, search: 'reynolds' }
    });
  });

  it('includes a supplied search term as the search param on the unpaginated call', async () => {
    mockClient.get.mockResolvedValue({ data: { results: [] } });

    await authentikService.getUsers({ search: 'reynolds' });

    expect(mockClient.get).toHaveBeenCalledWith('/core/users/', {
      params: { type: 'internal', ordering: 'pk', search: 'reynolds' }
    });
  });

  it('omits the search param entirely when no search term is supplied (not even an empty string)', async () => {
    mockClient.get.mockResolvedValue({ data: { results: [], pagination: { count: 0 } } });

    await authentikService.getUsers({ page: 1, pageSize: 50 });

    const [, options] = mockClient.get.mock.calls[0];
    expect(options.params).not.toHaveProperty('search');
  });

  it('omits the search param when an empty string is supplied (falsy, treated as no search)', async () => {
    mockClient.get.mockResolvedValue({ data: { results: [], pagination: { count: 0 } } });

    await authentikService.getUsers({ page: 1, pageSize: 50, search: '' });

    const [, options] = mockClient.get.mock.calls[0];
    expect(options.params).not.toHaveProperty('search');
  });
});
