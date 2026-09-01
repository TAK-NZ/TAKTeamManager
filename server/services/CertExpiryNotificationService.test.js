/**
 * Unit tests for `CertExpiryNotificationService.findEligibleCandidates`
 * (cert-expiry-notifications task 3.3, Requirements 2.1, 2.2, 2.3, 2.4, 2.5).
 *
 * `pool.query` is mocked and driven by call-order (the two SQL statements
 * `findEligibleCandidates` issues -- the candidate SELECT, then the
 * batched already-resolved lookup -- plus, when backlog entries exist, a
 * third statement for the INSERT ... ON CONFLICT write). `Team` is
 * mocked but unused by this file (only the digest senders in
 * `sendTeamOwnedDigests` call it, covered by a later task's tests).
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
}));
jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
}));

const mockSendEmail = jest.fn();
jest.mock('./EmailService', () => jest.fn().mockImplementation(() => ({ sendEmail: mockSendEmail })));

const pool = require('../config/database');
const Team = require('../models/Team');
const CertExpiryNotificationService = require('./CertExpiryNotificationService');

const ORIGINAL_ENV = { ...process.env };

const NOW = new Date('2026-08-31T00:00:00.000Z');

/** A live tak_devices/users/team_memberships joined row, as the candidate SELECT would return it. */
function candidateRow(overrides = {}) {
  return {
    client_uid: 'ANDROID-cert-1',
    cert_id: 1,
    expires_at: new Date('2026-09-30T00:00:00.000Z'), // 30 days out from NOW
    last_seen_at: new Date('2026-08-30T00:00:00.000Z'), // seen yesterday
    issued_at: new Date('2026-01-01T00:00:00.000Z'),
    user_id: 100,
    is_team_device: false,
    email: 'owner@example.com',
    username: 'jdoe',
    first_name: 'Jane',
    direct_team_id: null,
    ...overrides,
  };
}

/**
 * Sets up `pool.query` to answer, in order: the candidate SELECT (`rows`
 * of candidate rows), the batched already-resolved lookup (`resolvedRows`
 * -- entries already written to cert_expiry_notifications), and then any
 * number of further INSERT statements (all answered with an empty result,
 * matching Postgres's real response shape for an INSERT with no RETURNING).
 */
function mockQuerySequence({ candidates, resolved = [] }) {
  pool.query.mockReset();
  pool.query
    .mockResolvedValueOnce({ rows: candidates })
    .mockResolvedValueOnce({ rows: resolved })
    .mockResolvedValue({ rows: [] }); // any subsequent INSERT
}

describe('CertExpiryNotificationService.findEligibleCandidates', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      CERT_EXPIRY_TIER1_DAYS: '30',
      CERT_EXPIRY_TIER2_DAYS: '15',
      CERT_EXPIRY_TIER3_DAYS: '8',
      CERT_EXPIRY_TIER4_DAYS: '1',
      CERT_EXPIRY_ACTIVITY_WINDOW_DAYS: '90',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('returns empty sets when no candidate rows exist', async () => {
    mockQuerySequence({ candidates: [] });

    const result = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(result).toEqual({ toEmail: [], toMarkResolvedOnly: [] });
    // Only the candidate SELECT is issued -- no batched-resolved lookup,
    // no INSERT, when there is nothing to evaluate.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('scopes the candidate SELECT to non-revoked, non-null expires_at, active-account rows', async () => {
    mockQuerySequence({ candidates: [] });
    await CertExpiryNotificationService.findEligibleCandidates(NOW);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('d.revoked = false');
    expect(sql).toContain('d.expires_at IS NOT NULL');
    expect(sql).toContain("u.account_status = 'active'");
  });

  it('is DUE exactly on the threshold boundary (daysLeft === thresholdDays)', async () => {
    // 30 days out exactly matches TIER1's default 30-day threshold.
    const row = candidateRow({ expires_at: new Date(NOW.getTime() + 30 * 86400000) });
    mockQuerySequence({ candidates: [row] });

    const { toEmail, toMarkResolvedOnly } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(toEmail).toHaveLength(1);
    expect(toEmail[0]).toMatchObject({ clientUid: row.client_uid, thresholdDays: 30 });
    expect(toMarkResolvedOnly).toHaveLength(0);
  });

  it('is NOT due one day short of the threshold', async () => {
    // 31 days out -- one day short of TIER1's 30-day threshold.
    const row = candidateRow({ expires_at: new Date(NOW.getTime() + 31 * 86400000) });
    mockQuerySequence({ candidates: [row] });

    const { toEmail, toMarkResolvedOnly } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(toEmail).toHaveLength(0);
    expect(toMarkResolvedOnly).toHaveLength(0);
  });

  it('activity-window boundary: last_seen_at exactly at expiresAt - windowDays is eligible', async () => {
    const expiresAt = new Date(NOW.getTime() + 1 * 86400000); // TIER4 due
    const lastSeenAt = new Date(expiresAt.getTime() - 90 * 86400000); // exactly 90 days before expiry
    const row = candidateRow({ expires_at: expiresAt, last_seen_at: lastSeenAt, issued_at: null });
    mockQuerySequence({ candidates: [row] });

    const { toEmail } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(toEmail).toHaveLength(1);
    expect(toEmail[0].thresholdDays).toBe(1);
  });

  it('activity-window boundary: last_seen_at one millisecond earlier than the boundary is NOT eligible', async () => {
    const expiresAt = new Date(NOW.getTime() + 1 * 86400000);
    const lastSeenAt = new Date(expiresAt.getTime() - 90 * 86400000 - 1); // 1ms too early
    const row = candidateRow({ expires_at: expiresAt, last_seen_at: lastSeenAt, issued_at: null });
    mockQuerySequence({ candidates: [row] });

    const { toEmail, toMarkResolvedOnly } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    // Requirement 2.4: fails the activity check -> no email, no
    // mark-resolved-only write either -- stays open for the next run.
    expect(toEmail).toHaveLength(0);
    expect(toMarkResolvedOnly).toHaveLength(0);
  });

  it('falls back to issued_at when last_seen_at is null', async () => {
    const expiresAt = new Date(NOW.getTime() + 1 * 86400000);
    const issuedAt = new Date(expiresAt.getTime() - 10 * 86400000); // well within 90-day window
    const row = candidateRow({ expires_at: expiresAt, last_seen_at: null, issued_at: issuedAt });
    mockQuerySequence({ candidates: [row] });

    const { toEmail } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(toEmail).toHaveLength(1);
  });

  it('fails the activity check when both last_seen_at and issued_at are null', async () => {
    const expiresAt = new Date(NOW.getTime() + 1 * 86400000);
    const row = candidateRow({ expires_at: expiresAt, last_seen_at: null, issued_at: null });
    mockQuerySequence({ candidates: [row] });

    const { toEmail, toMarkResolvedOnly } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(toEmail).toHaveLength(0);
    expect(toMarkResolvedOnly).toHaveLength(0);
  });

  it('excludes a tier already resolved for this exact (client_uid, cert_id)', async () => {
    const row = candidateRow({ expires_at: new Date(NOW.getTime() + 30 * 86400000) });
    mockQuerySequence({
      candidates: [row],
      resolved: [{ client_uid: row.client_uid, cert_id: row.cert_id, threshold_days: 30 }],
    });

    const { toEmail, toMarkResolvedOnly } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(toEmail).toHaveLength(0);
    expect(toMarkResolvedOnly).toHaveLength(0);
  });

  it('a renewed certificate (new cert_id, same client_uid) is eligible again despite the old cert_id being resolved', async () => {
    const row = candidateRow({ cert_id: 2, expires_at: new Date(NOW.getTime() + 30 * 86400000) });
    mockQuerySequence({
      candidates: [row],
      // The OLD cert_id (1) was already resolved at this tier -- must not
      // suppress the NEW cert_id (2)'s eligibility (Requirement 1.2).
      resolved: [{ client_uid: row.client_uid, cert_id: 1, threshold_days: 30 }],
    });

    const { toEmail } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(toEmail).toHaveLength(1);
    expect(toEmail[0].certId).toBe(2);
  });

  it('multi-tier backlog: collapses to the single most urgent DUE-and-unresolved tier in toEmail, every other DUE tier lands in toMarkResolvedOnly', async () => {
    // 1 day left -- TIER1 (30), TIER2 (15), TIER3 (8), and TIER4 (1) are
    // all simultaneously DUE (an outage spanning every threshold).
    const row = candidateRow({ expires_at: new Date(NOW.getTime() + 1 * 86400000) });
    mockQuerySequence({ candidates: [row] });

    const { toEmail, toMarkResolvedOnly } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(toEmail).toHaveLength(1);
    expect(toEmail[0].thresholdDays).toBe(1); // the smallest threshold_days = most urgent

    expect(toMarkResolvedOnly).toHaveLength(3);
    expect(toMarkResolvedOnly.map((e) => e.thresholdDays).sort((a, b) => a - b)).toEqual([8, 15, 30]);
  });

  it('multi-tier backlog: persists toMarkResolvedOnly entries via an INSERT ... ON CONFLICT DO NOTHING', async () => {
    const row = candidateRow({ expires_at: new Date(NOW.getTime() + 1 * 86400000) });
    mockQuerySequence({ candidates: [row] });

    await CertExpiryNotificationService.findEligibleCandidates(NOW);

    // Call 1: candidate SELECT. Call 2: batched already-resolved lookup.
    // Call 3: the mark-resolved-only INSERT.
    expect(pool.query).toHaveBeenCalledTimes(3);
    const [insertSql, insertParams] = pool.query.mock.calls[2];
    expect(insertSql).toContain('INSERT INTO cert_expiry_notifications');
    expect(insertSql).toContain('ON CONFLICT (client_uid, cert_id, threshold_days) DO NOTHING');
    // Three backlog tiers (8, 15, 30) for the one client_uid/cert_id.
    expect(insertParams[0]).toEqual([row.client_uid, row.client_uid, row.client_uid]);
    expect(insertParams[1]).toEqual([row.cert_id, row.cert_id, row.cert_id]);
    expect(insertParams[2].sort((a, b) => a - b)).toEqual([8, 15, 30]);
  });

  it('issues no INSERT when there are no backlog (toMarkResolvedOnly) entries', async () => {
    const row = candidateRow({ expires_at: new Date(NOW.getTime() + 30 * 86400000) }); // only TIER1 due
    mockQuerySequence({ candidates: [row] });

    await CertExpiryNotificationService.findEligibleCandidates(NOW);

    // Only the candidate SELECT and the batched-resolved lookup -- no
    // third (INSERT) call.
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('carries isTeamDevice/directTeamId/email/username/expiresAt through to both toEmail and toMarkResolvedOnly entries', async () => {
    const row = candidateRow({
      is_team_device: true,
      direct_team_id: 55,
      expires_at: new Date(NOW.getTime() + 1 * 86400000),
    });
    mockQuerySequence({ candidates: [row] });

    const { toEmail, toMarkResolvedOnly } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    for (const entry of [...toEmail, ...toMarkResolvedOnly]) {
      expect(entry).toMatchObject({
        clientUid: row.client_uid,
        isTeamDevice: true,
        directTeamId: 55,
        email: row.email,
        username: row.username,
      });
    }
  });

  it('evaluates multiple independent candidates in one run without cross-contamination', async () => {
    const dueRow = candidateRow({
      client_uid: 'ANDROID-due',
      cert_id: 10,
      expires_at: new Date(NOW.getTime() + 30 * 86400000),
    });
    const notDueRow = candidateRow({
      client_uid: 'ANDROID-not-due',
      cert_id: 20,
      expires_at: new Date(NOW.getTime() + 365 * 86400000),
    });
    mockQuerySequence({ candidates: [dueRow, notDueRow] });

    const { toEmail } = await CertExpiryNotificationService.findEligibleCandidates(NOW);

    expect(toEmail).toHaveLength(1);
    expect(toEmail[0].clientUid).toBe('ANDROID-due');
  });
});

/**
 * Unit tests for `CertExpiryNotificationService.sendSelfOwnedDigests`
 * (cert-expiry-notifications task 4.4, Requirements 3.1, 3.2, 3.3, 3.4).
 */
describe('CertExpiryNotificationService.sendSelfOwnedDigests', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  /** A `toEmail` entry as `findEligibleCandidates` would produce it, for a self-owned device. */
  function selfOwnedEntry(overrides = {}) {
    return {
      clientUid: 'ANDROID-self-1',
      certId: 1,
      thresholdDays: 30,
      round: 1,
      isTeamDevice: false,
      directTeamId: null,
      email: 'owner@example.com',
      username: 'jdoe',
      firstName: 'Jane',
      expiresAt: new Date('2026-09-30T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('ignores team-owned entries entirely', async () => {
    const teamEntry = selfOwnedEntry({ isTeamDevice: true });
    await CertExpiryNotificationService.sendSelfOwnedDigests([teamEntry]);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('sends exactly one email for a single-device candidate, then marks it resolved', async () => {
    mockSendEmail.mockResolvedValue(undefined);
    pool.query.mockResolvedValue({ rows: [] });

    const entry = selfOwnedEntry();
    await CertExpiryNotificationService.sendSelfOwnedDigests([entry]);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      'owner@example.com',
      'cert_expiry_self_digest',
      expect.objectContaining({ first_name: 'Jane' })
    );

    // Resolved-row write happens AFTER the successful send.
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO cert_expiry_notifications');
    expect(params).toEqual([['ANDROID-self-1'], [1], [30]]);
  });

  it('sends exactly one email for a user with multiple devices, listing every device', async () => {
    mockSendEmail.mockResolvedValue(undefined);
    pool.query.mockResolvedValue({ rows: [] });

    const entries = [
      selfOwnedEntry({ clientUid: 'ANDROID-self-1', certId: 1, username: 'jdoe-phone' }),
      selfOwnedEntry({ clientUid: 'ANDROID-self-2', certId: 2, username: 'jdoe-tablet' }),
    ];
    await CertExpiryNotificationService.sendSelfOwnedDigests(entries);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [, , variables] = mockSendEmail.mock.calls[0];
    expect(variables.device_list).toContain('jdoe-phone');
    expect(variables.device_list).toContain('jdoe-tablet');
  });

  it('groups two different users into two separate emails', async () => {
    mockSendEmail.mockResolvedValue(undefined);
    pool.query.mockResolvedValue({ rows: [] });

    const entries = [
      selfOwnedEntry({ email: 'alice@example.com' }),
      selfOwnedEntry({ clientUid: 'ANDROID-self-2', certId: 2, email: 'bob@example.com' }),
    ];
    await CertExpiryNotificationService.sendSelfOwnedDigests(entries);

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const recipients = mockSendEmail.mock.calls.map(([to]) => to);
    expect(recipients.sort()).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('leaves the resolved-row write unwritten when the send rejects, and does not throw', async () => {
    mockSendEmail.mockRejectedValue(new Error('SMTP down'));

    await expect(
      CertExpiryNotificationService.sendSelfOwnedDigests([selfOwnedEntry()])
    ).resolves.toBeUndefined();

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('one recipient failing does not prevent the other recipient from being sent to', async () => {
    mockSendEmail.mockImplementation((to) => {
      if (to === 'alice@example.com') return Promise.reject(new Error('SMTP down'));
      return Promise.resolve(undefined);
    });
    pool.query.mockResolvedValue({ rows: [] });

    const entries = [
      selfOwnedEntry({ email: 'alice@example.com' }),
      selfOwnedEntry({ clientUid: 'ANDROID-self-2', certId: 2, email: 'bob@example.com' }),
    ];
    await CertExpiryNotificationService.sendSelfOwnedDigests(entries);

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    // Only bob's group is marked resolved -- one INSERT call, naming bob's device.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][1]).toEqual([['ANDROID-self-2'], [2], [30]]);
  });
});

/**
 * Unit tests for `CertExpiryNotificationService.sendTeamOwnedDigests`
 * (cert-expiry-notifications task 4.4/4.5, Requirements 4.1, 4.2, 4.3, 4.4).
 */
describe('CertExpiryNotificationService.sendTeamOwnedDigests', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  /** A `toEmail` entry as `findEligibleCandidates` would produce it, for a team-owned device. */
  function teamOwnedEntry(overrides = {}) {
    return {
      clientUid: 'ANDROID-team-1',
      certId: 1,
      thresholdDays: 30,
      round: 1,
      isTeamDevice: true,
      directTeamId: 55,
      email: null, // a Team_Owned_Device's own users row carries no meaningful email
      username: 'AUK-D7K3QMX',
      firstName: null,
      expiresAt: new Date('2026-09-30T00:00:00.000Z'),
      ...overrides,
    };
  }

  /** A root-first ancestor chain: depth 0 = Organisation ... depth `deviceDepth` = the device's own team. */
  function buildChain(deviceDepth) {
    return Array.from({ length: deviceDepth + 1 }, (_, depth) => ({
      id: 1000 + depth,
      depth,
    }));
  }

  it('ignores self-owned entries entirely', async () => {
    const selfEntry = teamOwnedEntry({ isTeamDevice: false });
    await CertExpiryNotificationService.sendTeamOwnedDigests([selfEntry]);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(Team.getAncestorChain).not.toHaveBeenCalled();
  });

  it('skips a candidate with no directTeamId, without throwing', async () => {
    const entry = teamOwnedEntry({ directTeamId: null });
    await expect(CertExpiryNotificationService.sendTeamOwnedDigests([entry])).resolves.toBeUndefined();

    expect(Team.getAncestorChain).not.toHaveBeenCalled();
  });

  it('resolves round-1 recipients to only the device team depth, sends one email, then marks resolved', async () => {
    Team.getAncestorChain.mockResolvedValue(buildChain(3)); // device team at depth 3
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, email: 'admin1@example.com' }] }) // recipient resolution
      .mockResolvedValueOnce({ rows: [] }); // markResolved INSERT
    mockSendEmail.mockResolvedValue(undefined);

    const entry = teamOwnedEntry({ round: 1 });
    await CertExpiryNotificationService.sendTeamOwnedDigests([entry]);

    // Round 1 -> depth floor = 3 (device's own depth) -> only team id 1003.
    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toEqual([1003]);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith('admin1@example.com', 'cert_expiry_team_digest', expect.any(Object));

    // Second call is the resolved-row INSERT.
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][0]).toContain('INSERT INTO cert_expiry_notifications');
  });

  it('round 4 reaches every depth including depth 0 (the Organisation), unconditionally', async () => {
    Team.getAncestorChain.mockResolvedValue(buildChain(3));
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, email: 'admin1@example.com' }] })
      .mockResolvedValueOnce({ rows: [] });
    mockSendEmail.mockResolvedValue(undefined);

    const entry = teamOwnedEntry({ round: 4 });
    await CertExpiryNotificationService.sendTeamOwnedDigests([entry]);

    const [, params] = pool.query.mock.calls[0];
    expect(params[0].sort((a, b) => a - b)).toEqual([1000, 1001, 1002, 1003]);
  });

  it('a multi-team admin gets exactly one email spanning every team with a due device', async () => {
    Team.getAncestorChain.mockImplementation((teamId) =>
      Promise.resolve(teamId === 2000 ? buildChain(1).map((t) => ({ ...t, id: t.id + 1000 })) : buildChain(0))
    );
    // Both resolveEscalationRecipients calls resolve to the SAME admin.
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42, email: 'admin@example.com' }] })
      .mockResolvedValueOnce({ rows: [{ id: 42, email: 'admin@example.com' }] })
      .mockResolvedValueOnce({ rows: [] });
    mockSendEmail.mockResolvedValue(undefined);

    const entries = [
      teamOwnedEntry({ clientUid: 'ANDROID-team-A', certId: 1, directTeamId: 1000, round: 1, username: 'device-A' }),
      teamOwnedEntry({ clientUid: 'ANDROID-team-B', certId: 2, directTeamId: 2000, round: 1, username: 'device-B' }),
    ];
    await CertExpiryNotificationService.sendTeamOwnedDigests(entries);

    // One email, not two.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [, , variables] = mockSendEmail.mock.calls[0];
    expect(variables.team_sections).toContain('device-A');
    expect(variables.team_sections).toContain('device-B');
  });

  it('excludes a recipient whose account is suspended/orphaned via the query predicate', async () => {
    Team.getAncestorChain.mockResolvedValue(buildChain(0));
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    mockSendEmail.mockResolvedValue(undefined);

    await CertExpiryNotificationService.sendTeamOwnedDigests([teamOwnedEntry()]);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("u.account_status = 'active'");
    expect(sql).toContain("tm.role = 'admin'");
    expect(sql).toContain('tm.inherited_from_team_id IS NULL');
  });

  it('a device/tier is marked resolved only once every recipient it reached succeeded', async () => {
    Team.getAncestorChain.mockResolvedValue(buildChain(0));
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, email: 'admin1@example.com' },
        { id: 2, email: 'admin2@example.com' },
      ],
    });
    // admin1 succeeds, admin2 fails.
    mockSendEmail.mockImplementation((to) => {
      if (to === 'admin2@example.com') return Promise.reject(new Error('SMTP down'));
      return Promise.resolve(undefined);
    });

    await CertExpiryNotificationService.sendTeamOwnedDigests([teamOwnedEntry()]);

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    // No markResolved INSERT: only pool.query call is the recipient resolution.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('skips a recipient with no email on file, without throwing, and logs it', async () => {
    Team.getAncestorChain.mockResolvedValue(buildChain(0));
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, email: null }] });

    await expect(
      CertExpiryNotificationService.sendTeamOwnedDigests([teamOwnedEntry()])
    ).resolves.toBeUndefined();

    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests specifically for Escalation_Round resolution
 * (cert-expiry-notifications task 4.5, Requirement 4.1).
 *
 * Covers the depth-direction correction: round 1 is the device's OWN
 * team (whatever depth it happens to sit at), climbing TOWARD the
 * Organisation (depth 0) as the round number increases, with round 4
 * reaching every depth unconditionally.
 */
describe('CertExpiryNotificationService Escalation_Round resolution (via sendTeamOwnedDigests)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  function buildChain(deviceDepth) {
    return Array.from({ length: deviceDepth + 1 }, (_, depth) => ({ id: 1000 + depth, depth }));
  }

  function teamOwnedEntryAt(round) {
    return {
      clientUid: 'ANDROID-team-1',
      certId: 1,
      thresholdDays: 30,
      round,
      isTeamDevice: true,
      directTeamId: 55,
      email: null,
      username: 'AUK-D7K3QMX',
      firstName: null,
      expiresAt: new Date('2026-09-30T00:00:00.000Z'),
    };
  }

  it.each([
    [1, [1003]],
    [2, [1002, 1003]],
    [3, [1001, 1002, 1003]],
    [4, [1000, 1001, 1002, 1003]],
  ])('for a device team at depth 3 in a 4-level chain, round %i resolves team ids %j', async (round, expectedTeamIds) => {
    Team.getAncestorChain.mockResolvedValue(buildChain(3));
    pool.query.mockResolvedValueOnce({ rows: [] });
    // No recipients resolved -> nothing else to mock.

    await CertExpiryNotificationService.sendTeamOwnedDigests([teamOwnedEntryAt(round)]);

    const [, params] = pool.query.mock.calls[0];
    expect(params[0].slice().sort((a, b) => a - b)).toEqual(expectedTeamIds.slice().sort((a, b) => a - b));
  });

  it.each([1, 2, 3, 4])(
    'for a device team at depth 0 (an Organisation-level device), every round %i resolves to the same single depth-0 team',
    async (round) => {
      Team.getAncestorChain.mockResolvedValue(buildChain(0));
      pool.query.mockResolvedValueOnce({ rows: [] });

      await CertExpiryNotificationService.sendTeamOwnedDigests([teamOwnedEntryAt(round)]);

      const [, params] = pool.query.mock.calls[0];
      expect(params[0]).toEqual([1000]);
    }
  );

  it('an admin reached at round 1 is also reached at rounds 2-4 for the same device (additive, never replacing)', async () => {
    Team.getAncestorChain.mockResolvedValue(buildChain(3));
    const round1Admin = { id: 1, email: 'round1-admin@example.com' };

    for (const round of [1, 2, 3, 4]) {
      pool.query.mockReset();
      pool.query.mockResolvedValueOnce({ rows: [round1Admin] });

      await CertExpiryNotificationService.sendTeamOwnedDigests([teamOwnedEntryAt(round)]);

      const [, params] = pool.query.mock.calls[0];
      // The device's own team (depth 3, id 1003) is in scope at every round.
      expect(params[0]).toContain(1003);
    }
  });
});
