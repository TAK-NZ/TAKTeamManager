'use strict';

/**
 * Tests for the pinned-group-members config + resolver
 * (`server/config/pinnedGroupMembers.js`).
 *
 * Covers: env parsing (comma/trim/empty-drop, empty default); live
 * username->pk resolution via a mocked Authentik call; and the best-effort
 * contract (an unresolvable username is skipped, a lookup failure yields no
 * pin for that name, and neither ever throws).
 */

const mockRun = jest.fn();
jest.mock('../services/authentikRequest', () => ({
  run: (opts, fn) => mockRun(opts, fn)
}));

const mockFetch = jest.fn();
jest.mock('../utils/fetchWithTimeout', () => ({
  fetchWithTimeout: (...args) => mockFetch(...args)
}));

const {
  getPinnedUsernames,
  resolvePinnedPks,
  _clearPinCache
} = require('./pinnedGroupMembers');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  _clearPinCache();
  process.env.AUTHENTIK_URL = 'https://authentik.example';
  process.env.AUTHENTIK_API_TOKEN = 'test-token';
  delete process.env.PINNED_MEMBERS_BCH;
  delete process.env.PINNED_MEMBERS_XTRATOOLS;
  delete process.env.PINNED_MEMBERS_RESPONSE;
  delete process.env.PINNED_MEMBERS_SUPPORT;
  // Default: rate limiter runs the fn.
  mockRun.mockImplementation((_opts, fn) => fn());
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// A `?username=` lookup helper: returns a fetch-shaped response resolving to
// { results: [...] } for the given username->user map.
function mockAuthentikUsers(usersByUsername) {
  mockFetch.mockImplementation((url) => {
    const m = /username=([^&]+)/.exec(url);
    const username = m ? decodeURIComponent(m[1]) : '';
    const user = usersByUsername[username];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ results: user ? [user] : [] })
    });
  });
}

describe('getPinnedUsernames', () => {
  it('parses a comma-separated list, trimming and dropping empties', () => {
    process.env.PINNED_MEMBERS_BCH = ' ckadmin , , akadmin ,';
    expect(getPinnedUsernames('bch')).toEqual(['ckadmin', 'akadmin']);
  });

  it('returns an empty array when unset or blank (pins nobody)', () => {
    expect(getPinnedUsernames('response')).toEqual([]);
    process.env.PINNED_MEMBERS_RESPONSE = '   ';
    expect(getPinnedUsernames('response')).toEqual([]);
  });

  it('reads the correct env var per category', () => {
    process.env.PINNED_MEMBERS_XTRATOOLS = 'ckadmin';
    process.env.PINNED_MEMBERS_SUPPORT = 'other';
    expect(getPinnedUsernames('xtratools')).toEqual(['ckadmin']);
    expect(getPinnedUsernames('support')).toEqual(['other']);
    expect(getPinnedUsernames('bch')).toEqual([]);
  });
});

describe('resolvePinnedPks', () => {
  it('returns [] immediately (no Authentik call) when the list is empty', async () => {
    const pks = await resolvePinnedPks('bch');
    expect(pks).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves usernames to Authentik pks (as strings), via the read lane', async () => {
    process.env.PINNED_MEMBERS_BCH = 'ckadmin,akadmin';
    mockAuthentikUsers({ ckadmin: { pk: 42, username: 'ckadmin' }, akadmin: { pk: 7, username: 'akadmin' } });

    const pks = await resolvePinnedPks('bch');

    expect(pks.sort()).toEqual(['42', '7'].sort());
    // Used the read lane.
    expect(mockRun).toHaveBeenCalled();
    expect(mockRun.mock.calls[0][0]).toEqual({ kind: 'read' });
  });

  it('skips an unresolvable username (no such Authentik user) without throwing', async () => {
    process.env.PINNED_MEMBERS_RESPONSE = 'ckadmin,ghost';
    mockAuthentikUsers({ ckadmin: { pk: 42, username: 'ckadmin' } }); // ghost -> no results

    const pks = await resolvePinnedPks('response');

    expect(pks).toEqual(['42']);
  });

  it('is best-effort on a lookup transport failure: that username contributes nothing, no throw', async () => {
    process.env.PINNED_MEMBERS_SUPPORT = 'ckadmin,boom';
    mockFetch.mockImplementation((url) => {
      if (url.includes('boom')) {
        return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ results: [{ pk: 42, username: 'ckadmin' }] }) });
    });

    const pks = await resolvePinnedPks('support');

    expect(pks).toEqual(['42']);
  });

  it('dedups repeated usernames/pks', async () => {
    process.env.PINNED_MEMBERS_XTRATOOLS = 'ckadmin,ckadmin';
    mockAuthentikUsers({ ckadmin: { pk: 42, username: 'ckadmin' } });

    const pks = await resolvePinnedPks('xtratools');

    expect(pks).toEqual(['42']);
    // Cache: the second occurrence must not issue a second lookup.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
