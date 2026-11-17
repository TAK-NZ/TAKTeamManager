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
  reconciler.resetKnownMissingUserPks();
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

// A GET group-detail response carrying an expanded members list (and, like the
// real API, the bare `users` pk array).
const groupDetail = (usersObj, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ pk: 'grp-uuid', users: usersObj.map((u) => u.pk), users_obj: usersObj, ...extra })
});
// Routes GET (current-member read) and PATCH (write) separately and records them.
const mockAuthentik = (currentMembers, { patchResponse = { ok: true, status: 200 } } = {}) => {
  global.fetch = jest.fn().mockImplementation((url, options) => {
    if ((options?.method ?? 'GET') === 'GET') return Promise.resolve(groupDetail(currentMembers));
    return Promise.resolve(patchResponse);
  });
  return {
    patchCalls: () => global.fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH'),
    getCalls: () => global.fetch.mock.calls.filter(([, o]) => (o?.method ?? 'GET') === 'GET')
  };
};

describe('replaceGroupMembers', () => {
  beforeEach(() => {
    delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
  });
  it('DRY-RUN: issues no Authentik write and reports patched=false', async () => {
    mockDryRun.mockReturnValue(true);
    const authentik = mockAuthentik([]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10', '11']);
    expect(result).toEqual({ patched: false, unchanged: false, dryRun: true, memberCount: 2 });
    expect(authentik.patchCalls()).toHaveLength(0);
    // Only the read lane was used; the write lane was never entered.
    expect(mockRun.mock.calls.map((c) => c[0].kind)).toEqual(['read']);
  });
  it('issues ONE PATCH with the full numeric member list when armed', async () => {
    const authentik = mockAuthentik([]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10', '11', '12']);
    expect(result).toEqual({ patched: true, unchanged: false, dryRun: false, memberCount: 3, droppedMissingPks: [] });
    // One read (to check for a change), then one write.
    expect(mockRun.mock.calls.map((c) => c[0].kind)).toEqual(['read', 'write']);
    expect(authentik.patchCalls()).toHaveLength(1);
    const [url, options] = authentik.patchCalls()[0];
    expect(url).toContain('/core/groups/grp-uuid/');
    expect(JSON.parse(options.body)).toEqual({ users: [10, 11, 12] });
  });
  it('PATCHes an empty users[] to clear a populated group', async () => {
    const authentik = mockAuthentik([{ pk: 5, username: 'alice' }]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', []);
    expect(result.patched).toBe(true);
    expect(JSON.parse(authentik.patchCalls()[0][1].body)).toEqual({ users: [] });
  });
  it('throws a classified AuthentikApiError on a non-2xx PATCH', async () => {
    mockAuthentik([], { patchResponse: { ok: false, status: 500, statusText: 'Server Error' } });
    await expect(reconciler.replaceGroupMembers('grp-uuid', ['10'])).rejects.toMatchObject({
      name: 'AuthentikApiError',
      classification: 'retryable' // 5xx
    });
  });
  it('classifies a 4xx PATCH as permanent', async () => {
    mockAuthentik([], { patchResponse: { ok: false, status: 400, statusText: 'Bad Request' } });
    await expect(reconciler.replaceGroupMembers('grp-uuid', ['10'])).rejects.toMatchObject({
      classification: 'permanent'
    });
  });
});

// The point of the change: a PATCH that would write exactly what Authentik
// already holds is skipped. Authentik turns every group PATCH into an event and
// queued background tasks, so the hourly sweep over many owned groups (almost
// all already correct) used to saturate its database.
describe('replaceGroupMembers: skips a PATCH that would change nothing', () => {
  beforeEach(() => {
    mockDryRun.mockReturnValue(false);
    delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
  });
  it('skips an EMPTY group that should stay empty (the common case in a large environment)', async () => {
    const authentik = mockAuthentik([]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', []);
    expect(result).toEqual({ patched: false, unchanged: true, dryRun: false, memberCount: 0 });
    expect(authentik.patchCalls()).toHaveLength(0);
    // No write-lane token was spent either.
    expect(mockRun.mock.calls.map((c) => c[0].kind)).toEqual(['read']);
  });
  it('skips a populated group whose members already match, whatever the order or pk type', async () => {
    const authentik = mockAuthentik([
      { pk: 12, username: 'c' },
      { pk: 10, username: 'a' },
      { pk: 11, username: 'b' }
    ]);
    // desired arrives as strings in a different order (as the DB queries return them)
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10', '11', '12']);
    expect(result.unchanged).toBe(true);
    expect(result.patched).toBe(false);
    expect(authentik.patchCalls()).toHaveLength(0);
  });
  it('still PATCHes when a member must be ADDED', async () => {
    const authentik = mockAuthentik([{ pk: 10, username: 'a' }]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10', '11']);
    expect(result).toMatchObject({ patched: true, unchanged: false });
    expect(JSON.parse(authentik.patchCalls()[0][1].body)).toEqual({ users: [10, 11] });
  });
  it('still PATCHes when a member must be REMOVED', async () => {
    const authentik = mockAuthentik([{ pk: 10, username: 'a' }, { pk: 77, username: 'bob' }]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    expect(result).toMatchObject({ patched: true, unchanged: false });
    expect(JSON.parse(authentik.patchCalls()[0][1].body)).toEqual({ users: [10] });
  });
  it('still PATCHes for the same number of members with a different member', async () => {
    const authentik = mockAuthentik([{ pk: 10, username: 'a' }, { pk: 77, username: 'bob' }]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10', '11']);
    expect(result.patched).toBe(true);
    expect(JSON.parse(authentik.patchCalls()[0][1].body)).toEqual({ users: [10, 11] });
  });
  it('does NOT skip when the bare `users` array holds a member that users_obj omits', async () => {
    // Cross-check: Authentik reports pk 12 in `users` but not in `users_obj`.
    global.fetch = jest.fn().mockImplementation((url, options) => {
      if ((options?.method ?? 'GET') === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ users: [10, 12], users_obj: [{ pk: 10, username: 'a' }] })
        });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    expect(result.patched).toBe(true);
    expect(result.unchanged).toBe(false);
  });
  it('counts a current member with no username as a member (so a stale one is removed, not skipped)', async () => {
    const authentik = mockAuthentik([{ pk: 10, username: 'a' }, { pk: 55, username: null }]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    expect(result.patched).toBe(true);
    expect(JSON.parse(authentik.patchCalls()[0][1].body)).toEqual({ users: [10] });
  });
  it('DRY-RUN reports unchanged for an already-correct group and issues no write', async () => {
    mockDryRun.mockReturnValue(true);
    const authentik = mockAuthentik([{ pk: 10, username: 'a' }]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    expect(result).toEqual({ patched: false, unchanged: true, dryRun: true, memberCount: 1 });
    expect(authentik.patchCalls()).toHaveLength(0);
  });
  it('falls back to the unconditional PATCH when the current-member read fails and no ignored prefixes are configured', async () => {
    // Same behaviour as before the change: with nothing to preserve there was
    // never a read, so a failed read must not block the reconcile.
    global.fetch = jest.fn().mockImplementation((url, options) => {
      if ((options?.method ?? 'GET') === 'GET') {
        return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    expect(result).toMatchObject({ patched: true, unchanged: false });
    const patch = global.fetch.mock.calls.find(([, o]) => o?.method === 'PATCH');
    expect(JSON.parse(patch[1].body)).toEqual({ users: [10] });
  });
});

// Ignored-prefix member PRESERVATION: an owned-group full replace must NOT
// strip a currently-present user whose username matches AUTHENTIK_SYNC_
// IGNORED_USERNAME_PREFIXES (e.g. an `etl-` service account), because such a
// user is deliberately unmaterialised locally and so is never in the
// DB-computed desired set. The reconciler reads current members and unions
// the ignored ones' pks back into the replace.
describe('replaceGroupMembers: ignored-prefix member preservation', () => {
  beforeEach(() => {
    mockDryRun.mockReturnValue(false);
    process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES = 'etl-,svc-';
  });
  it('reads current members (for the change check) but preserves nothing when no ignored prefixes are configured', async () => {
    delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
    const authentik = mockAuthentik([]);
    await reconciler.replaceGroupMembers('grp-uuid', ['10', '11']);
    expect(authentik.getCalls()).toHaveLength(1);
    expect(authentik.patchCalls()).toHaveLength(1);
    expect(JSON.parse(authentik.patchCalls()[0][1].body)).toEqual({ users: [10, 11] });
  });
  it('unions a currently-present ignored-prefix member into the PATCH so it is not stripped', async () => {
    // Current: alice (10, desired), an out-of-band `etl-` account (99, NOT
    // desired, ignored) and bob (77, NOT desired, NOT ignored). The desired set
    // is [10]. The PATCH must remove bob, keep 99.
    const authentik = mockAuthentik([
      { pk: 10, username: 'alice' },
      { pk: 99, username: 'etl-nightly' },
      { pk: 77, username: 'bob' }
    ]);
    await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    expect(authentik.patchCalls()).toHaveLength(1);
    expect(JSON.parse(authentik.patchCalls()[0][1].body).users.sort()).toEqual([10, 99]);
    // The GET went through the READ lane, the PATCH through the WRITE lane.
    expect(mockRun.mock.calls.map((c) => c[0].kind)).toEqual(['read', 'write']);
  });
  it('SKIPS the PATCH when the only difference is a preserved ignored member', async () => {
    // Current [alice, etl-nightly]; desired [alice]. After preservation the set
    // to write is [alice, etl-nightly], which is exactly what is there: no-op.
    const authentik = mockAuthentik([
      { pk: 10, username: 'alice' },
      { pk: 99, username: 'etl-nightly' }
    ]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    expect(result).toMatchObject({ patched: false, unchanged: true, memberCount: 2 });
    expect(authentik.patchCalls()).toHaveLength(0);
  });
  it('reads the group ONCE per replace (one consistent snapshot for the check and the preservation)', async () => {
    const authentik = mockAuthentik([{ pk: 99, username: 'etl-nightly' }]);
    await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    expect(authentik.getCalls()).toHaveLength(1);
    expect(authentik.patchCalls()).toHaveLength(1);
  });
  it('does NOT preserve a non-ignored current member that is absent from the desired set (still removed)', async () => {
    const authentik = mockAuthentik([{ pk: 10, username: 'alice' }, { pk: 77, username: 'bob' }]);
    await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    expect(JSON.parse(authentik.patchCalls()[0][1].body).users).toEqual([10]);
  });
  it('is FAIL-CLOSED: a failed current-member read throws (retryable) and issues NO PATCH', async () => {
    global.fetch = jest.fn().mockImplementation((url, options) => {
      if ((options?.method ?? 'GET') === 'GET') {
        return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable' });
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
    let caught;
    try {
      await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AuthentikApiError);
    expect(caught.classification).toBe('retryable');
    // No PATCH was issued -- only the (failed) GET.
    const patchCall = global.fetch.mock.calls.find(([, o]) => o?.method === 'PATCH');
    expect(patchCall).toBeUndefined();
  });
  it('DRY-RUN still preserves ignored members in the logged set and issues no write', async () => {
    mockDryRun.mockReturnValue(true);
    const authentik = mockAuthentik([{ pk: 99, username: 'etl-nightly' }]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    // Preservation read happens even in dry-run (so the logged count reflects
    // what WOULD be written), but no PATCH is issued.
    expect(result).toEqual({ patched: false, unchanged: false, dryRun: true, memberCount: 2 });
    expect(authentik.patchCalls()).toHaveLength(0);
  });
});

// A user whose Authentik account is gone can leave a local row whose authentik_user_id
// is still in the "every user" desired sets. Authentik then rejects the whole
// PATCH with HTTP 400 `Invalid pk "N" - object does not exist.` and writes
// nothing. The reconciler omits exactly the pks Authentik names and retries.
describe('replaceGroupMembers: users Authentik no longer has', () => {
  const missingPkBody = (pk) => JSON.stringify({ users: [`Invalid pk "${pk}" - object does not exist.`] });
  const bad400 = (pk) => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => missingPkBody(pk) });
  const ok200 = { ok: true, status: 200 };

  // GET returns `current`; PATCH answers come from `patchResponses` in order.
  const mockWith = (current, patchResponses) => {
    const queue = [...patchResponses];
    global.fetch = jest.fn().mockImplementation((url, options) => {
      if ((options?.method ?? 'GET') === 'GET') return Promise.resolve(groupDetail(current));
      return Promise.resolve(queue.shift() ?? ok200);
    });
    return {
      patchBodies: () =>
        global.fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH').map(([, o]) => JSON.parse(o.body).users)
    };
  };

  beforeEach(() => {
    mockDryRun.mockReturnValue(false);
    delete process.env.AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES;
  });

  it('omits the pk Authentik says does not exist, retries, and succeeds', async () => {
    const authentik = mockWith([{ pk: 10, username: 'a' }], [bad400(474), ok200]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['10', '11', '474']);
    expect(authentik.patchBodies()).toEqual([[10, 11, 474], [10, 11]]);
    expect(result).toMatchObject({ patched: true, memberCount: 2, droppedMissingPks: [474] });
    // Each attempt went through the write lane (and its rate limit).
    expect(mockRun.mock.calls.filter((c) => c[0].kind === 'write')).toHaveLength(2);
  });

  it('never ADDS or KEEPS anyone: the retry body is the original minus only the named pk', async () => {
    const authentik = mockWith([], [bad400(12), ok200]);
    await reconciler.replaceGroupMembers('grp-uuid', ['10', '11', '12', '13']);
    const [first, second] = authentik.patchBodies();
    expect(second).toEqual(first.filter((pk) => pk !== 12));
    expect(second.every((pk) => first.includes(pk))).toBe(true);
  });

  it('handles several deleted users, one per Authentik response', async () => {
    const authentik = mockWith([], [bad400(7), bad400(474), ok200]);
    const result = await reconciler.replaceGroupMembers('grp-uuid', ['7', '10', '474']);
    expect(authentik.patchBodies()).toEqual([[7, 10, 474], [10, 474], [10]]);
    expect(result.droppedMissingPks).toEqual([7, 474]);
  });

  it('remembers the pk, so the NEXT group omits it up front and an already-correct group is skipped', async () => {
    mockWith([{ pk: 10, username: 'a' }], [bad400(474), ok200]);
    await reconciler.replaceGroupMembers('grp-1', ['10', '474']);
    // Second group: Authentik already holds exactly [10]; desired is [10, 474].
    const authentik = mockWith([{ pk: 10, username: 'a' }], []);
    const result = await reconciler.replaceGroupMembers('grp-2', ['10', '474']);
    expect(authentik.patchBodies()).toEqual([]);
    expect(result).toMatchObject({ patched: false, unchanged: true, memberCount: 1 });
  });

  it('omits a remembered pk up front when the next group does need a PATCH (one request, not a failed one first)', async () => {
    mockWith([], [bad400(474), ok200]);
    await reconciler.replaceGroupMembers('grp-1', ['10', '474']);
    const authentik = mockWith([{ pk: 10, username: 'a' }], []);
    await reconciler.replaceGroupMembers('grp-2', ['10', '11', '474']);
    expect(authentik.patchBodies()).toEqual([[10, 11]]);
  });

  it('is bounded: gives up with a permanent error after the retry limit instead of looping', async () => {
    // A different missing pk every time, forever.
    let n = 100;
    global.fetch = jest.fn().mockImplementation((url, options) => {
      if ((options?.method ?? 'GET') === 'GET') return Promise.resolve(groupDetail([]));
      n += 1;
      return Promise.resolve(bad400(n - 1));
    });
    const members = Array.from({ length: 20 }, (_, i) => String(100 + i));
    await expect(reconciler.replaceGroupMembers('grp-uuid', members)).rejects.toMatchObject({
      name: 'AuthentikApiError',
      classification: 'permanent'
    });
    const patches = global.fetch.mock.calls.filter(([, o]) => o?.method === 'PATCH');
    expect(patches).toHaveLength(6); // first try + 5 retries
  });

  it('does NOT retry a 400 that is not the missing-user message, and puts Authentik\'s reason in the error', async () => {
    const authentik = mockWith([], [
      { ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ users: ['This list may not be empty.'] }) }
    ]);
    let caught;
    try {
      await reconciler.replaceGroupMembers('grp-uuid', ['10']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toMatchObject({ name: 'AuthentikApiError', classification: 'permanent' });
    expect(caught.message).toContain('400 Bad Request');
    expect(caught.message).toContain('This list may not be empty.');
    expect(authentik.patchBodies()).toHaveLength(1);
  });

  it('does NOT retry when the named pk is not one we sent (nothing to omit)', async () => {
    const authentik = mockWith([], [bad400(999)]);
    await expect(reconciler.replaceGroupMembers('grp-uuid', ['10', '11'])).rejects.toMatchObject({
      classification: 'permanent'
    });
    expect(authentik.patchBodies()).toHaveLength(1);
  });

  it('does NOT learn from a 5xx or a malformed body', async () => {
    const authentik = mockWith([], [
      { ok: false, status: 500, statusText: 'Server Error', text: async () => missingPkBody(10) },
    ]);
    await expect(reconciler.replaceGroupMembers('grp-uuid', ['10'])).rejects.toMatchObject({ classification: 'retryable' });
    expect(authentik.patchBodies()).toHaveLength(1);
    // And nothing was remembered: the pk is still sent next time.
    const next = mockWith([], [ok200]);
    await reconciler.replaceGroupMembers('grp-uuid-2', ['10']);
    expect(next.patchBodies()).toEqual([[10]]);
  });

  it('survives an error response whose body cannot be read', async () => {
    mockWith([], [{ ok: false, status: 400, statusText: 'Bad Request', text: async () => { throw new Error('socket closed'); } }]);
    await expect(reconciler.replaceGroupMembers('grp-uuid', ['10'])).rejects.toMatchObject({ classification: 'permanent' });
  });
});
