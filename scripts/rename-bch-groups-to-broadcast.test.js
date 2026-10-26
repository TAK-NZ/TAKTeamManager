/**
 * Tests for `scripts/rename-bch-groups-to-broadcast.js`.
 *
 * Same harness as `backfill-team-channel-group-names.test.js`: the script
 * self-invokes `main()` and ends through `process.exit`, so each case mocks
 * the DB pool and the Authentik service, stubs `process.exit`/stdout/stderr,
 * seeds `process.argv`, and re-`require`s the script in `jest.isolateModules`.
 */

jest.mock('../server/config/database', () => ({
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../server/services/authentik', () => ({
  getAllGroups: jest.fn(),
  renameGroup: jest.fn().mockResolvedValue(undefined)
}));

const pool = require('../server/config/database');
const authentik = require('../server/services/authentik');

// bch_channels rows of category 'BCH': channel A has a read+write pair,
// channel B a read group only (a read-only feed with no write group).
const BCH_ROWS = [
  { read_group_id: 'pk-a-read', write_group_id: 'pk-a-write' },
  { read_group_id: 'pk-b-read', write_group_id: null }
];

const GROUPS = [
  { pk: 'pk-a-read', name: 'tak_BCH - Aircraft_READ' },
  { pk: 'pk-a-write', name: 'tak_BCH - Aircraft' },
  { pk: 'pk-b-read', name: 'tak_BCH - Community - Marine_READ' },
  // Prefix matches but no BCH-category channel references it (e.g. an
  // XtraTools channel or a never-imported group): must be left alone.
  { pk: 'pk-stray', name: 'tak_BCH - Stray_READ' },
  // Unrelated groups.
  { pk: 'pk-xt', name: 'tak_XtraTools - Data Packages_READ' },
  { pk: 'pk-team', name: 'tak_Teams - FENZ' }
];

function mockData({ rows = BCH_ROWS, groups = GROUPS } = {}) {
  pool.query.mockImplementation((sql) => {
    if (typeof sql === 'string' && sql.includes('FROM bch_channels') && sql.includes("category = 'BCH'")) {
      return Promise.resolve({ rows });
    }
    return Promise.resolve({ rows: [] });
  });
  authentik.getAllGroups.mockResolvedValue(groups);
}

function runScript(argv) {
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalArgv = process.argv;
  const output = [];
  process.stdout.write = (c) => { output.push(String(c)); return true; };
  process.stderr.write = (c) => { output.push(String(c)); return true; };
  process.argv = ['node', 'scripts/rename-bch-groups-to-broadcast.js', ...argv];

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
    const finish = () => { if (settled) return; settled = true; restore(); resolve({ code: capturedExitCode, output: output.join('') }); };
    const fail = (e) => { if (settled) return; settled = true; restore(); reject(e); };
    try {
      jest.isolateModules(() => { require('./rename-bch-groups-to-broadcast'); });
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

describe('rename-bch-groups-to-broadcast', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authentik.renameGroup.mockResolvedValue(undefined);
    pool.end.mockResolvedValue(undefined);
    process.env.CHANNEL_FOLDER_SEPARATOR = ' - ';
  });

  it('DRY RUN: lists the planned renames and the left-alone group, renames nothing', async () => {
    mockData();

    const { code, output } = await runScript([]);

    expect(code).toBe(0);
    expect(output).toContain('tak_BCH - Aircraft_READ -> tak_Broadcast - Aircraft_READ');
    expect(output).toContain('tak_BCH - Aircraft -> tak_Broadcast - Aircraft');
    expect(output).toContain('tak_BCH - Community - Marine_READ -> tak_Broadcast - Community - Marine_READ');
    expect(output).toContain('[alone]  tak_BCH - Stray_READ');
    expect(authentik.renameGroup).not.toHaveBeenCalled();
  });

  it('APPLY: renames exactly the three linked groups by pk and nothing else', async () => {
    mockData();

    const { code } = await runScript(['--apply']);

    expect(code).toBe(0);
    const calls = authentik.renameGroup.mock.calls.map(([pk, name]) => [pk, name]);
    expect(calls).toHaveLength(3);
    expect(calls).toEqual(expect.arrayContaining([
      ['pk-a-read', 'tak_Broadcast - Aircraft_READ'],
      ['pk-a-write', 'tak_Broadcast - Aircraft'],
      ['pk-b-read', 'tak_Broadcast - Community - Marine_READ']
    ]));
    // The unlinked and unrelated groups are never touched.
    const touchedPks = calls.map(([pk]) => pk);
    expect(touchedPks).not.toContain('pk-stray');
    expect(touchedPks).not.toContain('pk-xt');
    expect(touchedPks).not.toContain('pk-team');
  });

  it('skips a group whose target name is already held by a different group, and exits non-zero', async () => {
    mockData({
      groups: [
        { pk: 'pk-a-read', name: 'tak_BCH - Aircraft_READ' },
        { pk: 'pk-other', name: 'tak_Broadcast - Aircraft_READ' }
      ],
      rows: [{ read_group_id: 'pk-a-read', write_group_id: null }]
    });

    const { code, output } = await runScript(['--apply']);

    expect(authentik.renameGroup).not.toHaveBeenCalled();
    expect(output).toContain('[skip]');
    expect(output).toContain('already exists as pk=pk-other');
    expect(code).toBe(1);
  });

  it('is a clean no-op on a re-run, when everything is already renamed', async () => {
    mockData({
      groups: [
        { pk: 'pk-a-read', name: 'tak_Broadcast - Aircraft_READ' },
        { pk: 'pk-a-write', name: 'tak_Broadcast - Aircraft' }
      ],
      rows: [{ read_group_id: 'pk-a-read', write_group_id: 'pk-a-write' }]
    });

    const { code, output } = await runScript(['--apply']);

    expect(code).toBe(0);
    expect(output).toContain('Nothing to rename.');
    expect(authentik.renameGroup).not.toHaveBeenCalled();
  });

  it('reports a failed rename and exits non-zero while still attempting the rest', async () => {
    mockData();
    authentik.renameGroup.mockImplementation((pk) =>
      pk === 'pk-a-write' ? Promise.reject(new Error('boom')) : Promise.resolve()
    );

    const { code, output } = await runScript(['--apply']);

    expect(authentik.renameGroup).toHaveBeenCalledTimes(3);
    expect(output).toContain('Failed to rename tak_BCH - Aircraft (pk=pk-a-write): boom');
    expect(output).toContain('Renamed 2 group(s), 1 failure(s)');
    expect(code).toBe(1);
  });
});
