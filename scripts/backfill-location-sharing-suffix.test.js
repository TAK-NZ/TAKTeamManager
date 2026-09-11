/**
 * Tests for scripts/backfill-location-sharing-suffix.js.
 *
 * The script self-invokes `main()` at module load and drives its outcome
 * through `process.exit`. Following the harness convention established by
 * `scripts/create-cloudtak-groups.test.js` / `backfill-team-channel-group-names.test.js`,
 * each case mocks the DB pool and `EventPublisher`, stubs
 * `process.exit`/`process.stdout`/`process.stderr`, seeds `process.argv`, and
 * re-`require`s the script inside `jest.isolateModules`.
 *
 * Behaviour under test: team rows ending in the OLD "(Location sharing
 * enabled)" qualifier are rewritten to the unified "(Bi-directional location
 * sharing)"; region rows (no suffix) get it appended; a row already carrying
 * the unified suffix is skipped; and the matching per-type sync op is
 * enqueued on apply.
 */

jest.mock('../server/config/database', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../server/services/EventPublisher', () => ({
  publishOperation: jest.fn().mockResolvedValue('op-id')
}));

const pool = require('../server/config/database');
const EventPublisher = require('../server/services/EventPublisher');

const TEAM_ROWS = [
  // old suffix -> rewritten
  { id: 5, team_id: 5, display_name: 'Teams - FENZ', description: 'Users from Teams - FENZ (Location sharing enabled)' },
  // already unified -> skipped
  { id: 6, team_id: 6, display_name: 'Teams - NZDF', description: 'Users from Teams - NZDF (Bi-directional location sharing)' }
];
const REGION_ROWS = [
  // no suffix -> appended
  { id: 11, name: 'Auckland', description: 'Auckland (Response - Emergency Services)' }
];

function mockTables({ team = [], region = [] }) {
  pool.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('FROM channels') && sql.includes('is_primary')) {
      return Promise.resolve({ rows: team });
    }
    if (typeof sql === 'string' && sql.includes('FROM region_channels') && sql.includes('ORDER BY id')) {
      return Promise.resolve({ rows: region });
    }
    return Promise.resolve({ rows: [] });
  });
}

function runScript(argv) {
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalArgv = process.argv;
  const out = [];
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { out.push(String(c)); return true; };
  process.argv = ['node', 'scripts/backfill-location-sharing-suffix.js', ...argv];

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
    const finish = () => { if (settled) return; settled = true; restore(); resolve({ code: capturedExitCode, stdout: out.join('') }); };
    const fail = (e) => { if (settled) return; settled = true; restore(); reject(e); };
    try {
      jest.isolateModules(() => { require('./backfill-location-sharing-suffix'); });
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

describe('backfill-location-sharing-suffix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    EventPublisher.publishOperation.mockResolvedValue('op-id');
    pool.end.mockResolvedValue(undefined);
  });

  it('DRY RUN: reports the rewrites/appends and enqueues nothing', async () => {
    mockTables({ team: TEAM_ROWS, region: REGION_ROWS });

    const { stdout } = await runScript([]);

    // team 5 rewritten, region 11 appended; team 6 already unified -> not listed.
    expect(stdout).toContain('channel 5');
    expect(stdout).toContain('(Bi-directional location sharing)');
    expect(stdout).toContain('channel 11');
    expect(stdout).toContain('1 to update'); // team: 1 of 2
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });

  it('APPLY: rewrites the team row + enqueues update_channel_group, appends the region row + enqueues update_region_channel_group, skips the already-unified row', async () => {
    mockTables({ team: TEAM_ROWS, region: REGION_ROWS });

    await runScript(['--apply']);

    // Team channel 5 description rewritten to the unified suffix.
    const teamUpdate = pool.query.mock.calls.find(
      ([sql, params]) => typeof sql === 'string' && sql.startsWith('UPDATE channels SET description') && params && params[1] === 5
    );
    expect(teamUpdate).toBeDefined();
    expect(teamUpdate[1][0]).toBe('Users from Teams - FENZ (Bi-directional location sharing)');

    // Team channel 6 (already unified) is NOT updated.
    const team6Update = pool.query.mock.calls.find(
      ([sql, params]) => typeof sql === 'string' && sql.startsWith('UPDATE channels SET description') && params && params[1] === 6
    );
    expect(team6Update).toBeUndefined();

    // Region channel 11 description appended.
    const regionUpdate = pool.query.mock.calls.find(
      ([sql, params]) => typeof sql === 'string' && sql.startsWith('UPDATE region_channels SET description') && params && params[1] === 11
    );
    expect(regionUpdate).toBeDefined();
    expect(regionUpdate[1][0]).toBe('Auckland (Response - Emergency Services) (Bi-directional location sharing)');

    // One team op + one region op, each with the right shape.
    const teamOps = EventPublisher.publishOperation.mock.calls.filter(([op]) => op === 'update_channel_group');
    expect(teamOps).toHaveLength(1);
    expect(teamOps[0][1]).toEqual({ channel_id: 5 });

    const regionOps = EventPublisher.publishOperation.mock.calls.filter(([op]) => op === 'update_region_channel_group');
    expect(regionOps).toHaveLength(1);
    expect(regionOps[0][1]).toEqual({
      region_channel_id: 11,
      channel_name: 'Auckland',
      description: 'Auckland (Response - Emergency Services) (Bi-directional location sharing)'
    });
  });

  it('is a clean no-op when every description already carries the unified suffix', async () => {
    mockTables({
      team: [{ id: 6, team_id: 6, display_name: 'Teams - NZDF', description: 'Users from Teams - NZDF (Bi-directional location sharing)' }],
      region: [{ id: 11, name: 'Auckland', description: 'Auckland (Bi-directional location sharing)' }]
    });

    const { stdout } = await runScript([]);

    expect(stdout).toContain('Nothing to update');
    expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
  });
});
