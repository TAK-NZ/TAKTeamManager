'use strict';

/**
 * Authentik scaling (Phase 2): the group-authoritative reconciler.
 *
 * These tests mock the DB pool, the rate-limiter chokepoint, `fetch`, and
 * the reconcile flags so they assert:
 *   - each desired-set query issues the right SQL and maps rows to
 *     authentik_user_id strings (families 1-4);
 *   - the fail-closed contract: a query that THROWS propagates (the caller
 *     must not PATCH);
 *   - replaceGroupMembers issues NO Authentik write in dry-run, and issues
 *     exactly one PATCH with the full numeric member list otherwise;
 *   - a non-2xx PATCH becomes a classified AuthentikApiError.
 */

const mockQuery = jest.fn();
jest.mock('../config/database', () => ({ query: mockQuery }));

const mockRun = jest.fn();
jest.mock('./authentikRequest', () => ({
  run: (opts, fn) => mockRun(opts, fn)
}));

const mockDryRun = jest.fn();
jest.mock('../config/bulkGroupReconcile', () => ({
  isBulkGroupReconcileEnabled: jest.fn(() => true),
  isBulkGroupReconcileDryRun: () => mockDryRun()
}));

// Pinned owned-group members: mocked so the union behaviour is deterministic
// and never hits the Authentik lookup. Defaults to [] (no pins) in beforeEach,
// so every existing desired-set test is unaffected.
const mockResolvePinnedPks = jest.fn();
jest.mock('../config/pinnedGroupMembers', () => ({
  resolvePinnedPks: (category) => mockResolvePinnedPks(category)
}));

// getDirectAdmins is exercised through the real CloudTakAgencyGroup module,
// which queries the pool we already mock -- so we let it run against mockQuery.
const reconciler = require('./OwnedGroupReconciler');
const { AuthentikApiError } = require('../workers/apiErrors');

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AUTHENTIK_URL = 'https://authentik.example';
  process.env.AUTHENTIK_API_TOKEN = 'test-token';
  // Default: rate limiter simply runs the fn (token granted).
  mockRun.mockImplementation((_opts, fn) => fn());
  // Default: dry-run OFF (so PATCH paths are exercised unless a test opts in).
  mockDryRun.mockReturnValue(false);
  // Default: no pinned members (so existing desired-set tests are unaffected).
  mockResolvePinnedPks.mockResolvedValue([]);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('desiredTeamChannelMembers', () => {
  it('returns every team_memberships user (direct or inherited) as authentik_user_id strings', async () => {
    mockQuery.mockResolvedValue({ rows: [{ authentik_user_id: 10 }, { authentik_user_id: 11 }] });

    const members = await reconciler.desiredTeamChannelMembers(5);

    expect(members).toEqual(['10', '11']);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('FROM team_memberships');
    expect(sql).toContain('authentik_user_id IS NOT NULL');
    // Behaviour-preserving: the desired set deliberately does NOT filter on
    // is_active, so a merely-deactivated but still-present member is NOT
    // stripped from the group (matching the event path). Guard against the
    // filter being reintroduced.
    expect(sql).not.toContain('is_active');
    expect(params).toEqual([5]);
  });

  it('propagates a query error (fail-closed: caller must not PATCH)', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(reconciler.desiredTeamChannelMembers(5)).rejects.toThrow('db down');
  });
});

describe('desiredBchReadMembers', () => {
  it('is every active user UNION the channel service account', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ authentik_user_id: 1 }, { authentik_user_id: 2 }] }) // active users
      .mockResolvedValueOnce({ rows: [{ service_account_id: 99 }] }); // channel row

    const members = await reconciler.desiredBchReadMembers(7);

    expect(members.sort()).toEqual(['1', '2', '99'].sort());
  });

  it('omits the service account when the channel has none', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ authentik_user_id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ service_account_id: null }] });

    const members = await reconciler.desiredBchReadMembers(7);
    expect(members).toEqual(['1']);
  });
});

describe('desiredBchWriteMembers', () => {
  it('is the service account ONLY', async () => {
    mockQuery.mockResolvedValue({ rows: [{ service_account_id: 99 }] });
    const members = await reconciler.desiredBchWriteMembers(7);
    expect(members).toEqual(['99']);
  });

  it('is an empty set (legitimately, not a failure) when no service account is provisioned', async () => {
    mockQuery.mockResolvedValue({ rows: [{ service_account_id: null }] });
    const members = await reconciler.desiredBchWriteMembers(7);
    expect(members).toEqual([]);
  });
});

describe('desiredRegionMembers', () => {
  it('reads the tier from the row and gates on the matching Organisation flag', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tier: 'response' }] }) // tier lookup
      .mockResolvedValueOnce({ rows: [{ authentik_user_id: 3 }, { authentik_user_id: 4 }] }); // members

    const members = await reconciler.desiredRegionMembers(12);

    expect(members).toEqual(['3', '4']);
    const [memberSql, memberParams] = mockQuery.mock.calls[1];
    expect(memberSql).toContain('response_channel_access');
    expect(memberSql).toContain('inherited_from_team_id IS NULL');

    // Regression guard (the "bind message supplies 1 parameters, but
    // prepared statement requires 0" bug that made every `region` reconcile
    // fail and retry for ~a day): the member query is PARAMETERLESS -- it
    // references no `$N` placeholder, so it must be called with NO params
    // array. A params array here is exactly what Postgres rejects.
    expect(memberSql).not.toMatch(/\$\d/);
    expect(memberParams).toBeUndefined();
  });

  it('throws a PERMANENT AuthentikApiError for a row with an invalid tier (never PATCHes)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ tier: 'bogus' }] });

    let caught;
    try {
      await reconciler.desiredRegionMembers(12);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthentikApiError);
    expect(caught.classification).toBe('permanent');
    // Only the tier lookup ran; the member query never did.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('pinned members union into desired sets', () => {
  it('desiredBchReadMembers unions PINNED_MEMBERS_BCH only for a BCH-category channel', async () => {
    mockResolvePinnedPks.mockResolvedValue(['42']);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ authentik_user_id: 1 }] }) // active users
      .mockResolvedValueOnce({ rows: [{ category: 'BCH', service_account_id: 99 }] }); // channel row

    const members = await reconciler.desiredBchReadMembers(7);

    expect(members.sort()).toEqual(['1', '42', '99'].sort());
    expect(mockResolvePinnedPks).toHaveBeenCalledWith('bch');
  });

  it('desiredBchReadMembers does NOT union pins for a UTL-category channel (BCH pins are BCH-only)', async () => {
    mockResolvePinnedPks.mockResolvedValue(['42']);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ authentik_user_id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ category: 'UTL', service_account_id: null }] });

    const members = await reconciler.desiredBchReadMembers(14);

    expect(members).toEqual(['1']);
    expect(mockResolvePinnedPks).not.toHaveBeenCalled();
  });

  it('desiredBchWriteMembers unions PINNED_MEMBERS_XTRATOOLS only for a UTL-category channel', async () => {
    mockResolvePinnedPks.mockResolvedValue(['42']);
    mockQuery.mockResolvedValue({ rows: [{ category: 'UTL', service_account_id: null }] });

    const members = await reconciler.desiredBchWriteMembers(14);

    // UTL write group is otherwise empty; the pin becomes the sole member.
    expect(members).toEqual(['42']);
    expect(mockResolvePinnedPks).toHaveBeenCalledWith('xtratools');
  });

  it('desiredBchWriteMembers does NOT union pins for a BCH-category channel (keeps service-account-only)', async () => {
    mockResolvePinnedPks.mockResolvedValue(['42']);
    mockQuery.mockResolvedValue({ rows: [{ category: 'BCH', service_account_id: 99 }] });

    const members = await reconciler.desiredBchWriteMembers(7);

    expect(members).toEqual(['99']);
    expect(mockResolvePinnedPks).not.toHaveBeenCalled();
  });

  it('desiredRegionMembers unions the tier-matching pin category', async () => {
    mockResolvePinnedPks.mockResolvedValue(['42']);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tier: 'response' }] }) // tier lookup
      .mockResolvedValueOnce({ rows: [{ authentik_user_id: 3 }] }); // members

    const members = await reconciler.desiredRegionMembers(12);

    expect(members.sort()).toEqual(['3', '42'].sort());
    expect(mockResolvePinnedPks).toHaveBeenCalledWith('response');
  });

  it('an empty pin set leaves the desired set unchanged (BCH read)', async () => {
    mockResolvePinnedPks.mockResolvedValue([]);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ authentik_user_id: 1 }] })
      .mockResolvedValueOnce({ rows: [{ category: 'BCH', service_account_id: 99 }] });

    const members = await reconciler.desiredBchReadMembers(7);

    expect(members.sort()).toEqual(['1', '99'].sort());
  });
});

describe('desiredCloudTakMembers', () => {
  it('is the Direct_Admin_Set (getDirectAdmins) mapped to authentik_user_id, null pks dropped', async () => {
    // getDirectAdmins runs its own query against the mocked pool.
    mockQuery.mockResolvedValue({
      rows: [
        { user_id: 1, authentik_user_id: 100 },
        { user_id: 2, authentik_user_id: null },
        { user_id: 3, authentik_user_id: 102 }
      ]
    });

    const members = await reconciler.desiredCloudTakMembers(5);

    expect(members.sort()).toEqual(['100', '102'].sort());
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("role = 'admin'");
    expect(sql).toContain('inherited_from_team_id IS NULL');
  });
});

describe('replaceGroupMembers', () => {
  it('DRY-RUN: issues no Authentik write and reports patched=false', async () => {
    mockDryRun.mockReturnValue(true);
    global.fetch = jest.fn();

    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10', '11']);

    expect(result).toEqual({ patched: false, dryRun: true, memberCount: 2 });
    expect(mockRun).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('issues ONE PATCH with the full numeric member list when armed', async () => {
    mockDryRun.mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10', '11', '12']);

    expect(result.patched).toBe(true);
    expect(mockRun).toHaveBeenCalledTimes(1);
    // The lane is the write lane.
    expect(mockRun.mock.calls[0][0]).toEqual({ kind: 'write' });
    // One fetch, a PATCH to the group, body carrying numeric users[].
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain('/core/groups/grp-uuid/');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ users: [10, 11, 12] });
  });

  it('PATCHes an empty users[] for a legitimately empty desired set', async () => {
    mockDryRun.mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    await reconciler.replaceGroupMembers('grp-uuid', []);

    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ users: [] });
  });

  it('throws a classified AuthentikApiError on a non-2xx PATCH', async () => {
    mockDryRun.mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

    let caught;
    try {
      await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthentikApiError);
    expect(caught.classification).toBe('retryable'); // 5xx
  });

  it('classifies a 4xx PATCH as permanent', async () => {
    mockDryRun.mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' });

    await expect(reconciler.replaceGroupMembers('grp-uuid', ['10'])).rejects.toMatchObject({
      classification: 'permanent'
    });
  });
});
