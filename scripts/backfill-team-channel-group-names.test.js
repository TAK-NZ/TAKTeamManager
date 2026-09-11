/**
 * Tests for the collision-split behaviour of
 * `scripts/backfill-team-channel-group-names.js`.
 *
 * The script self-invokes `main()` at module load and drives its outcome
 * through `process.exit`. Following the harness convention established by
 * `scripts/create-cloudtak-groups.test.js`, each case mocks the DB pool and
 * `EventPublisher`, stubs `process.exit`/`process.stdout`/`process.stderr`,
 * seeds `process.argv`, and re-`require`s the script inside
 * `jest.isolateModules` so the self-invocation runs fresh.
 *
 * The behaviour under test is the one pure name-drift detection missed: two
 * channels whose local `display_name`s are ALREADY correct but that SHARE one
 * Authentik `authentik_group_id` (the real Bug-2 aftermath, e.g. CHL-CDEM and
 * USA-CDEM). The keeper (lowest channel id) keeps the shared group; every
 * other member is split off via `reconcile_team_channel_group`.
 */

jest.mock('../server/config/database', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../server/services/EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue('op-id'),
  publishReconcileOwnedGroup: jest.fn().mockResolvedValue('reconcile-op-id')
}));

const pool = require('../server/config/database');
const EventPublisher = require('../server/services/EventPublisher');

// The rows loadPrimaryTeamChannels() returns. Two orgs sharing ONE Authentik
// group id, both with already-correct names -> a pure collision (no name
// drift), plus an unrelated correct channel that must be left alone.
const COLLIDED_ROWS = [
  { team_id: 11, team_name: 'Chile CDEM', parent_team_id: null, root_prefix: 'CDEM', root_country_code: 'CHL', channel_id: 11, display_name: 'Teams - CHL-CDEM', authentik_group_id: 'shared-pk' },
  { team_id: 12, team_name: 'USA CDEM', parent_team_id: null, root_prefix: 'CDEM', root_country_code: 'USA', channel_id: 12, display_name: 'Teams - USA-CDEM', authentik_group_id: 'shared-pk' },
  { team_id: 16, team_name: 'FENZ', parent_team_id: null, root_prefix: 'FENZ', root_country_code: null, channel_id: 16, display_name: 'Teams - FENZ', authentik_group_id: 'fenz-pk' }
];

function mockLoad(rows) {
  pool.query.mockImplementation((sql) => {
    // The loader query joins channels through the roots CTE.
    if (typeof sql === 'string' && sql.includes('roots AS') && sql.includes('JOIN channels c')) {
      return Promise.resolve({ rows });
    }
    // UPDATE channels ... and any other query.
    return Promise.resolve({ rows: [] });
  });
}

function runScript(argv) {
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalArgv = process.argv;
  const stdout = [];
  process.stdout.write = (c) => { stdout.push(String(c)); return true; };
  process.stderr.write = (c) => { stdout.push(String(c)); return true; };
  process.argv = ['node', 'scripts/backfill-team-channel-group-names.js', ...argv];

  const exitSentinel = Symbol('exit');
  let capturedExitCode;
  let exitCalls = 0;
  const restore = () => {
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.argv = originalArgv;
  };
  process.exit = (code) => {
    exitCalls += 1;
    if (capturedExitCode === undefined) capturedExitCode = typeof code === 'number' ? code : 0;
    if (exitCalls === 1) {
      const err = new Error('exit');
      err[exitSentinel] = true;
      throw err;
    }
    return undefined;
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; restore(); resolve({ code: capturedExitCode, stdout: stdout.join('') }); };
    const fail = (e) => { if (settled) return; settled = true; restore(); reject(e); };
    try {
      jest.isolateModules(() => { require('./backfill-team-channel-group-names'); });
    } catch (err) {
      if (!err || !err[exitSentinel]) { fail(err); return; }
    }
    const start = Date.now();
    const poll = () => {
      if (settled) return;
      if (capturedExitCode !== undefined) { finish(); return; }
      if (Date.now() - start > 3000) { fail(new Error('script did not exit')); return; }
      setImmediate(poll);
    };
    poll();
  });
}

describe('backfill-team-channel-group-names collision-split', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    EventPublisher.publishReconcileOwnedGroup.mockResolvedValue('reconcile-op-id');
    pool.end.mockResolvedValue(undefined);
    process.env.CHANNEL_FOLDER_SEPARATOR = ' - ';
  });

  it('DRY RUN: reports both collision members (split + keeper) and enqueues nothing', async () => {
    mockLoad(COLLIDED_ROWS);

    const { stdout } = await runScript([]);

    // Both collided channels appear: 12 as a split, 11 as the keeper. The
    // unique, correct FENZ channel (16) is left out entirely.
    expect(stdout).toContain('channel 12');
    expect(stdout).toContain('collision-split');
    expect(stdout).toContain('channel 11');
    expect(stdout).toContain('collision-keeper');
    expect(stdout).toContain('membership reconcile');
    expect(stdout).not.toContain('channel 16');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(EventPublisher.publishReconcileOwnedGroup).not.toHaveBeenCalled();
  });

  it('APPLY: splits the non-keeper and enqueues a MEMBERSHIP reconcile for BOTH the split and the keeper', async () => {
    mockLoad(COLLIDED_ROWS);

    await runScript(['--apply']);

    // The non-keeper (channel 12) has its group id NULLed locally.
    const nullUpdate = pool.query.mock.calls.find(
      ([sql, params]) => typeof sql === 'string' && sql.includes('UPDATE channels SET') && sql.includes('authentik_group_id = NULL') && params && params[params.length - 1] === 12
    );
    expect(nullUpdate).toBeDefined();

    // Channel 12 gets a group-identity reconcile under the DISTINCT USA-CDEM name.
    const identityReconciles = EventPublisher.publishOperation.mock.calls.filter(([op]) => op === 'reconcile_team_channel_group');
    expect(identityReconciles).toHaveLength(1);
    expect(identityReconciles[0][1]).toMatchObject({ channel_id: 12, authentik_group_name: 'tak_Teams - USA-CDEM' });

    // Channel 11 (keeper) gets a rename (idempotent on its already-correct name).
    const renames = EventPublisher.publishOperation.mock.calls.filter(([op]) => op === 'rename_team_channel_group');
    expect(renames).toHaveLength(1);
    expect(renames[0][1]).toMatchObject({ channel_id: 11, authentik_group_name: 'tak_Teams - CHL-CDEM' });

    // CRITICAL: a MEMBERSHIP reconcile_owned_group is enqueued for BOTH
    // collided channels (11 the keeper AND 12 the split), so the keeper's
    // wrong members and the split's empty group both get corrected.
    const memberReconciles = EventPublisher.publishReconcileOwnedGroup.mock.calls.map(([payload]) => payload);
    const memberChannelIds = memberReconciles.map((p) => p.channel_id).sort((a, b) => a - b);
    expect(memberChannelIds).toEqual([11, 12]);
    memberReconciles.forEach((p) => expect(p.group_kind).toBe('team_channel'));
  });

  it('is a clean no-op when there are no collisions and no name drift', async () => {
    mockLoad([COLLIDED_ROWS[2]]); // just the unique, correct FENZ channel

    const { stdout } = await runScript([]);

    expect(stdout).toContain('Nothing to repair');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    expect(EventPublisher.publishReconcileOwnedGroup).not.toHaveBeenCalled();
  });
});
