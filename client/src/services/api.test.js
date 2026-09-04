import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isValidBaseUrl, shouldRedirectToLogin } from './api.js';

// Validates: Requirements 2.7, 2.8
//
// Requirement 2.8 (success path): a syntactically valid absolute URL or
// relative path is accepted without error.
// Requirement 2.7 (failure path): anything that is not a syntactically
// valid absolute URL or relative path is rejected.
describe('isValidBaseUrl', () => {
  describe('success paths (Requirement 2.8)', () => {
    it('accepts an empty string (unset -> same-origin relative path)', () => {
      expect(isValidBaseUrl('')).toBe(true);
    });

    it('accepts a well-formed absolute https:// URL', () => {
      expect(isValidBaseUrl('https://api.example.com')).toBe(true);
    });

    it('accepts a well-formed absolute http:// URL', () => {
      expect(isValidBaseUrl('http://api.example.com:8080')).toBe(true);
    });

    it('accepts a well-formed absolute HTTPS URL regardless of scheme case', () => {
      expect(isValidBaseUrl('HTTPS://api.example.com')).toBe(true);
    });

    it('accepts a relative path starting with a slash', () => {
      expect(isValidBaseUrl('/api')).toBe(true);
    });

    it('accepts a relative path without a leading slash', () => {
      expect(isValidBaseUrl('some/relative/path')).toBe(true);
    });
  });

  describe('failure paths (Requirement 2.7)', () => {
    it('rejects a value containing whitespace', () => {
      expect(isValidBaseUrl('https://example.com/has space')).toBe(false);
    });

    it('rejects a javascript:// scheme', () => {
      expect(isValidBaseUrl('javascript://alert(1)')).toBe(false);
    });

    it('rejects an ftp:// scheme', () => {
      expect(isValidBaseUrl('ftp://files.example.com')).toBe(false);
    });

    it('rejects a data: scheme with a "://"-shaped payload', () => {
      expect(isValidBaseUrl('data://text/plain')).toBe(false);
    });

    it('rejects a malformed absolute https:// URL with no host', () => {
      // `new URL('https://')` throws (empty host), unlike most other
      // strings passed to `new URL()`, so this exercises the try/catch
      // failure branch of the http(s) validation path.
      expect(isValidBaseUrl('https://')).toBe(false);
    });

    it('rejects a malformed absolute http:// URL with no host', () => {
      expect(isValidBaseUrl('http://')).toBe(false);
    });
  });
});

// Regression coverage for the /request-access <-> /login endless redirect
// loop: an anonymous visitor's GET /auth/me (or any other API call) 401s
// on a page that's intentionally public, and the interceptor must not
// force-navigate to /login in that case -- doing so used to reload the
// SPA, remount App.jsx's auth check, 401 again, and loop forever.
describe('shouldRedirectToLogin', () => {
  it('redirects on a 401 from an ordinary authenticated page', () => {
    expect(shouldRedirectToLogin(401, '/dashboard')).toBe(true);
    expect(shouldRedirectToLogin(401, '/teams')).toBe(true);
  });

  it('does not redirect on a 401 while already on /login (expected/normal there, not a mid-use expiry)', () => {
    expect(shouldRedirectToLogin(401, '/login')).toBe(false);
  });

  it('does not redirect on a 401 while on /request-access', () => {
    expect(shouldRedirectToLogin(401, '/request-access')).toBe(false);
  });

  it('does not redirect on a non-401 status, regardless of path', () => {
    expect(shouldRedirectToLogin(500, '/dashboard')).toBe(false);
    expect(shouldRedirectToLogin(403, '/dashboard')).toBe(false);
    expect(shouldRedirectToLogin(undefined, '/dashboard')).toBe(false);
  });
});

// --- Admin settings management wrappers (admin-settings-management spec) ---
//
// Validates: Requirements 2.4, 3.1, 4.2, 6.2, 7.2, 8.5
//
// These assert the thin `communicationsAPI`/`settingsAPI` wrappers each call
// the right method on the shared `api` axios instance with the right URL and
// arguments. The instance is created via `axios.create()` at module load, so
// we mock `axios` and expose the created instance's spied methods, matching
// the network-boundary-only mocking used elsewhere in the suite. The wrappers
// are imported dynamically (after the mock is registered) so the mocked
// instance is the one they close over.
describe('communicationsAPI / settingsAPI wrappers', () => {
  let instance;
  let communicationsAPI;
  let settingsAPI;

  beforeEach(async () => {
    vi.resetModules();
    instance = {
      get: vi.fn(() => Promise.resolve({ data: {} })),
      post: vi.fn(() => Promise.resolve({ data: {} })),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
      patch: vi.fn(() => Promise.resolve({ data: {} })),
      interceptors: { response: { use: vi.fn() } },
    };
    vi.doMock('axios', () => ({
      default: { create: vi.fn(() => instance) },
    }));
    const mod = await import('./api.js');
    communicationsAPI = mod.communicationsAPI;
    settingsAPI = mod.settingsAPI;
  });

  afterEach(() => {
    vi.doUnmock('axios');
    vi.resetModules();
  });

  it('communicationsAPI.listTemplates() GETs /communications/templates', () => {
    communicationsAPI.listTemplates();
    expect(instance.get).toHaveBeenCalledWith('/communications/templates');
  });

  it('communicationsAPI.getTemplate(key) GETs /communications/templates/:key', () => {
    communicationsAPI.getTemplate('some_key');
    expect(instance.get).toHaveBeenCalledWith('/communications/templates/some_key');
  });

  it('communicationsAPI.updateTemplate(key, body) PUTs /communications/templates/:key with the body', () => {
    const body = { subjectTemplate: 'S', bodyTemplate: 'B' };
    communicationsAPI.updateTemplate('some_key', body);
    expect(instance.put).toHaveBeenCalledWith('/communications/templates/some_key', body);
  });

  it('communicationsAPI.sendTestEmail(body) POSTs /communications/test-email with the body', () => {
    const body = { targetEmail: 'a@b.co', templateKey: 'k' };
    communicationsAPI.sendTestEmail(body);
    expect(instance.post).toHaveBeenCalledWith('/communications/test-email', body);
  });

  it('settingsAPI.exportSettings() GETs /settings/export with responseType: blob', () => {
    settingsAPI.exportSettings();
    expect(instance.get).toHaveBeenCalledWith(
      '/settings/export',
      expect.objectContaining({ responseType: 'blob' })
    );
  });

  it('settingsAPI.importSettings(payload) POSTs /settings/import with the payload', () => {
    const payload = { systemConfig: [], siteConfig: [] };
    settingsAPI.importSettings(payload);
    expect(instance.post).toHaveBeenCalledWith('/settings/import', payload);
  });
});

// --- teamsAPI.getAllMyTeams: follows server pagination across all pages ---
//
// Bugfix (overview tree rendered flat + Display_Name used the wrong
// immediate-parent prefix): the admin "all teams" branch of
// GET /teams/my-teams is hard-capped at 200 rows/page. Any consumer that
// rebuilds the hierarchy client-side needs EVERY team, so getAllMyTeams
// loops over pagination.total. These assert the loop math and the
// non-paginated (regular-user) short-circuit, mocking only the axios
// instance (network boundary), matching the suite's convention above.
describe('teamsAPI.getAllMyTeams', () => {
  let instance;
  let teamsAPI;

  beforeEach(async () => {
    vi.resetModules();
    instance = {
      get: vi.fn(),
      post: vi.fn(() => Promise.resolve({ data: {} })),
      put: vi.fn(() => Promise.resolve({ data: {} })),
      delete: vi.fn(() => Promise.resolve({ data: {} })),
      patch: vi.fn(() => Promise.resolve({ data: {} })),
      interceptors: { response: { use: vi.fn() } },
    };
    vi.doMock('axios', () => ({
      default: { create: vi.fn(() => instance) },
    }));
    const mod = await import('./api.js');
    teamsAPI = mod.teamsAPI;
  });

  afterEach(() => {
    vi.doUnmock('axios');
    vi.resetModules();
  });

  const teamRows = (n, startId) =>
    Array.from({ length: n }, (_, i) => ({ id: startId + i, name: `t${startId + i}` }));

  it('returns page 1 alone when the total fits within one page (no extra requests)', async () => {
    instance.get.mockResolvedValueOnce({ data: { teams: teamRows(50, 1), pagination: { page: 1, pageSize: 200, total: 50 } } });

    const teams = await teamsAPI.getAllMyTeams();

    expect(teams).toHaveLength(50);
    expect(instance.get).toHaveBeenCalledTimes(1);
    expect(instance.get).toHaveBeenCalledWith('/teams/my-teams', { params: { page: 1, pageSize: 200 } });
  });

  it('loops every page when total exceeds one page, concatenating all rows in order', async () => {
    // total 663 -> 4 pages (200,200,200,63), mirroring the real FENZ tree.
    instance.get
      .mockResolvedValueOnce({ data: { teams: teamRows(200, 1), pagination: { page: 1, pageSize: 200, total: 663 } } })
      .mockResolvedValueOnce({ data: { teams: teamRows(200, 201), pagination: { page: 2, pageSize: 200, total: 663 } } })
      .mockResolvedValueOnce({ data: { teams: teamRows(200, 401), pagination: { page: 3, pageSize: 200, total: 663 } } })
      .mockResolvedValueOnce({ data: { teams: teamRows(63, 601), pagination: { page: 4, pageSize: 200, total: 663 } } });

    const teams = await teamsAPI.getAllMyTeams();

    expect(teams).toHaveLength(663);
    expect(instance.get).toHaveBeenCalledTimes(4);
    // Requested pages 2,3,4 explicitly after page 1.
    expect(instance.get).toHaveBeenCalledWith('/teams/my-teams', { params: { page: 2, pageSize: 200 } });
    expect(instance.get).toHaveBeenCalledWith('/teams/my-teams', { params: { page: 4, pageSize: 200 } });
    // Every id present, no gaps/dupes.
    expect(new Set(teams.map((t) => t.id)).size).toBe(663);
    expect(teams[0].id).toBe(1);
    expect(teams[662].id).toBe(663);
  });

  it('returns the single unpaginated response as-is for the regular-user branch (no pagination field)', async () => {
    instance.get.mockResolvedValueOnce({ data: { teams: teamRows(12, 1) } });

    const teams = await teamsAPI.getAllMyTeams();

    expect(teams).toHaveLength(12);
    expect(instance.get).toHaveBeenCalledTimes(1);
  });
});
