/**
 * Tests for the idempotent CloudTAK backfill script
 * (`scripts/create-cloudtak-groups.js`), spec: cloudtak-agency-groups,
 * tasks 10.3, 10.4, 10.5.
 *
 * - Property 8: Backfill enqueues one creation per existing Team (10.3)
 *   **Validates: Requirements 8.1, 8.3**
 * - Unit: disabled backfill enqueues nothing / no teardown (10.4)
 *   _Requirements: 1.5, 1.6, 8.5_
 * - Property 2: Disabled inertness enqueues nothing (10.5)
 *   **Validates: Requirements 1.4, 1.5**
 *
 * The script self-invokes `createCloudTakGroupsForAllTeams()` at module
 * load and drives its outcome through `process.exit`, reading the flag via
 * `isCloudTakEnabled()` (which reads `process.env` at call time) and
 * enqueuing exclusively through `EventPublisher.publishOperation`. So each
 * case here toggles `process.env.CLOUDTAK_ENABLED`, mocks the DB pool and
 * `EventPublisher`, stubs `process.exit`/`process.stdout`/`process.stderr`,
 * and re-`require`s the script inside `jest.isolateModules` so the
 * self-invocation runs fresh per run. This follows the codebase convention
 * (see `server/models/Team.test.js`) of mocking `../server/config/database`
 * and `../server/services/EventPublisher` and toggling the real env flag
 * rather than mocking `isCloudTakEnabled` directly.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

jest.mock('../server/config/database', () => ({
  query: jest.fn()
}));
jest.mock('../server/services/EventPublisher', () => ({
  publishOperation: jest.fn()
}));

const pool = require('../server/config/database');
const EventPublisher = require('../server/services/EventPublisher');

/**
 * Run the self-invoking backfill script once against the current mocks and
 * env, resolving with the captured `process.exit` code. The script's
 * top-level `createCloudTakGroupsForAllTeams()` call is fire-and-forget, so
 * we install a `process.exit` stub that resolves a promise (rather than
 * actually exiting the test runner) and await it. `jest.isolateModules`
 * gives each run a fresh module instance so the self-invocation re-runs.
 */
function runBackfillScript() {
  const originalExit = process.exit;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  const stdout = [];
  const stderr = [];
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };

  // The real script calls `process.exit(code)` to TERMINATE; a plain
  // no-op stub would let execution fall through past the disabled-branch
  // `process.exit(0)` into the enqueue path. So the stub records the code
  // and throws a unique sentinel to halt execution exactly like a real
  // exit would. The sentinel is distinguishable from a genuine script
  // error and is re-caught below.
  const exitSentinel = Symbol('process.exit');
  let capturedExitCode;

  const restore = () => {
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  };

  let exitCallCount = 0;
  process.exit = (code) => {
    exitCallCount += 1;
    // Capture only the FIRST exit code (the real outcome).
    if (capturedExitCode === undefined) {
      capturedExitCode = typeof code === 'number' ? code : 0;
    }
    // The real `process.exit` TERMINATES, so nothing after the call runs.
    // Emulate that halt on the FIRST call by throwing a sentinel (this
    // stops the disabled path from falling through into the enqueue code,
    // and stops each success path exactly where it exits). The script's
    // own try/catch will catch that first throw and then itself call
    // `process.exit(1)`; on that SECOND (spurious) call we simply return
    // without throwing, so execution falls off the end of the async
    // function cleanly -- no unhandled rejection, and the captured code
    // stays the real first one.
    if (exitCallCount === 1) {
      const err = new Error('process.exit');
      err[exitSentinel] = true;
      throw err;
    }
    return undefined;
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      restore();
      resolve({ code: capturedExitCode, stdout, stderr });
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      restore();
      reject(err);
    };

    // The script's top-level `createCloudTakGroupsForAllTeams()` is async
    // and fire-and-forget. Its synchronous prefix (flag check, and on the
    // disabled path `process.exit(0)`) runs during `require`, so a
    // disabled-path exit surfaces as the sentinel thrown out of `require`
    // and is caught just below. The enabled path awaits `pool.query`/
    // `Promise.all` first, so its exit happens later and is observed by
    // polling `capturedExitCode`.
    try {
      jest.isolateModules(() => {
        require('./create-cloudtak-groups');
      });
    } catch (err) {
      if (!err || !err[exitSentinel]) {
        fail(err);
        return;
      }
      // synchronous (disabled-path) exit: done.
    }

    // For the enabled path, exit happens after awaited work; poll the
    // microtask/macrotask queue until the exit code is captured.
    const start = Date.now();
    const poll = () => {
      if (settled) return;
      if (capturedExitCode !== undefined) {
        finish();
        return;
      }
      if (Date.now() - start > 3000) {
        fail(new Error('backfill script did not call process.exit'));
        return;
      }
      setImmediate(poll);
    };
    poll();
  });
}

/** Restore the CLOUDTAK_ENABLED env var to its pre-test value. */
function makeFlagRestorer() {
  const saved = process.env.CLOUDTAK_ENABLED;
  return () => {
    if (saved === undefined) {
      delete process.env.CLOUDTAK_ENABLED;
    } else {
      process.env.CLOUDTAK_ENABLED = saved;
    }
  };
}

/**
 * An arbitrary list of Team rows as returned by `SELECT id FROM teams`.
 * Ids are distinct (the real query orders by a PK), and rows may carry
 * extra columns (name/description) that the backfill must ignore -- it
 * only ever reads `id`.
 */
const teamRowsArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 40 })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((id) =>
        fc.record({
          id: fc.constant(id),
          name: fc.string(),
          description: fc.option(fc.string(), { nil: null })
        })
      )
    )
  );

describe('CloudTAK backfill script (scripts/create-cloudtak-groups.js)', () => {
  let restoreFlag;

  beforeEach(() => {
    jest.clearAllMocks();
    restoreFlag = makeFlagRestorer();
    EventPublisher.publishOperation.mockResolvedValue('op-id');
  });

  afterEach(() => {
    restoreFlag();
  });

  // --------------------------------------------------------------------
  // Task 10.3 — Property 8: Backfill enqueues one creation per Team
  // Validates: Requirements 8.1, 8.3
  // --------------------------------------------------------------------
  describe('Property 8: Backfill enqueues one create_cloudtak_group per existing Team (task 10.3)', () => {
    test.prop([teamRowsArb], { numRuns: 100 })(
      'with the flag ON, enqueues exactly one create_cloudtak_group per team with { team_id } and no other operations',
      async (teams) => {
        // fast-check re-runs this body many times within one jest test, so
        // reset the mocks each run rather than only in beforeEach.
        jest.clearAllMocks();
        EventPublisher.publishOperation.mockResolvedValue('op-id');
        process.env.CLOUDTAK_ENABLED = 'true';
        pool.query.mockResolvedValue({ rows: teams });

        const { code } = await runBackfillScript();

        expect(code).toBe(0);
        // One enqueue per team, and nothing else.
        expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(teams.length);

        const calls = EventPublisher.publishOperation.mock.calls;
        // Every call is a create_cloudtak_group carrying exactly { team_id }.
        for (const call of calls) {
          const [operationType, payload] = call;
          expect(operationType).toBe('create_cloudtak_group');
          expect(payload).toEqual({ team_id: expect.any(Number) });
        }

        // The set of enqueued team_ids equals the set of team ids, and the
        // multiset matches exactly (one per team, no duplicates/omissions).
        const enqueuedIds = calls.map((c) => c[1].team_id).sort((a, b) => a - b);
        const expectedIds = teams.map((t) => t.id).sort((a, b) => a - b);
        expect(enqueuedIds).toEqual(expectedIds);
      }
    );

    test.prop([teamRowsArb], { numRuns: 30 })(
      'is idempotent in enqueue shape: a second run enqueues the same set of create_cloudtak_group operations as the first (Requirement 8.3)',
      async (teams) => {
        jest.clearAllMocks();
        EventPublisher.publishOperation.mockResolvedValue('op-id');
        process.env.CLOUDTAK_ENABLED = 'true';
        pool.query.mockResolvedValue({ rows: teams });

        await runBackfillScript();
        const firstRun = EventPublisher.publishOperation.mock.calls.map((c) => [c[0], c[1]]);

        jest.clearAllMocks();
        EventPublisher.publishOperation.mockResolvedValue('op-id');
        pool.query.mockResolvedValue({ rows: teams });

        await runBackfillScript();
        const secondRun = EventPublisher.publishOperation.mock.calls.map((c) => [c[0], c[1]]);

        expect(secondRun).toEqual(firstRun);
      }
    );
  });

  // --------------------------------------------------------------------
  // Task 10.4 — Unit: disabled backfill + no teardown on disable
  // Requirements: 1.5, 1.6, 8.5
  // --------------------------------------------------------------------
  describe('Disabled backfill and no-teardown-on-disable (task 10.4)', () => {
    it('enqueues NOTHING and exits 0 when the flag is off (Requirements 1.5, 8.5)', async () => {
      process.env.CLOUDTAK_ENABLED = 'false';
      pool.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });

      const { code } = await runBackfillScript();

      expect(code).toBe(0);
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('does not query the teams table at all when the flag is off (short-circuits before any DB read)', async () => {
      process.env.CLOUDTAK_ENABLED = 'false';
      pool.query.mockResolvedValue({ rows: [{ id: 1 }] });

      await runBackfillScript();

      // The disabled branch returns before `SELECT id FROM teams`, so the
      // pool is never touched.
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('reports that the integration is disabled (Requirement 8.5)', async () => {
      process.env.CLOUDTAK_ENABLED = 'false';
      pool.query.mockResolvedValue({ rows: [{ id: 1 }] });

      const { stdout } = await runBackfillScript();

      expect(stdout.join('')).toMatch(/disabled/i);
    });

    it('performs no teardown when disabled: never enqueues delete_cloudtak_group nor any other operation (Requirement 1.6)', async () => {
      process.env.CLOUDTAK_ENABLED = 'false';
      // Simulate existing teams whose groups already exist in Authentik --
      // a naive "teardown on disable" would try to remove them.
      pool.query.mockResolvedValue({ rows: [{ id: 10 }, { id: 20 }] });

      await runBackfillScript();

      // No delete_cloudtak_group (nor create/update) is ever enqueued: the
      // disabled path leaves existing groups untouched.
      const deleteCalls = EventPublisher.publishOperation.mock.calls.filter(
        (c) => c[0] === 'delete_cloudtak_group'
      );
      expect(deleteCalls).toHaveLength(0);
      expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
    });

    it('treats a non-"true" flag value the same as off (unset/empty/"TRUE" all enqueue nothing)', async () => {
      pool.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });

      for (const value of [undefined, '', 'TRUE', 'false', '1', ' true ']) {
        jest.clearAllMocks();
        EventPublisher.publishOperation.mockResolvedValue('op-id');
        pool.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });
        if (value === undefined) {
          delete process.env.CLOUDTAK_ENABLED;
        } else {
          process.env.CLOUDTAK_ENABLED = value;
        }

        const { code } = await runBackfillScript();

        expect(code).toBe(0);
        expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
      }
    });
  });

  // --------------------------------------------------------------------
  // Task 10.5 — Property 2: Disabled inertness enqueues nothing
  // Validates: Requirements 1.4, 1.5
  // --------------------------------------------------------------------
  describe('Property 2: Disabled inertness enqueues nothing (task 10.5)', () => {
    // For ANY set of existing teams and ANY non-"true" flag value, the
    // backfill (the enqueue site exercised end-to-end here) enqueues zero
    // Sync_Operations of any kind and never touches the DB. This is the
    // shared guard behavior every enqueue site inherits: `isCloudTakEnabled()`
    // is false unless the flag is exactly 'true', so every guarded site is
    // inert.
    const nonTrueFlagArb = fc.oneof(
      fc.constant(undefined),
      fc.constant(''),
      fc.constant('false'),
      fc.constant('TRUE'),
      fc.constant('1'),
      fc.constant(' true '),
      fc.string().filter((s) => s !== 'true')
    );

    test.prop([teamRowsArb, nonTrueFlagArb], { numRuns: 100 })(
      'for any teams and any non-"true" flag value, zero EventPublisher.publishOperation calls occur and the DB is never queried',
      async (teams, flagValue) => {
        jest.clearAllMocks();
        EventPublisher.publishOperation.mockResolvedValue('op-id');
        pool.query.mockResolvedValue({ rows: teams });

        if (flagValue === undefined) {
          delete process.env.CLOUDTAK_ENABLED;
        } else {
          process.env.CLOUDTAK_ENABLED = flagValue;
        }

        const { code } = await runBackfillScript();

        expect(code).toBe(0);
        expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
        expect(pool.query).not.toHaveBeenCalled();
      }
    );

    // Complement: the guard is the ONLY thing gating enqueue -- with the
    // flag exactly 'true', the same inputs DO produce enqueues (so the
    // inertness above is attributable to the flag, not to a broken script).
    test.prop([teamRowsArb.filter((t) => t.length > 0)], { numRuns: 50 })(
      'the flag being exactly "true" is what enables enqueue: same inputs enqueue one op per team',
      async (teams) => {
        jest.clearAllMocks();
        EventPublisher.publishOperation.mockResolvedValue('op-id');
        process.env.CLOUDTAK_ENABLED = 'true';
        pool.query.mockResolvedValue({ rows: teams });

        await runBackfillScript();

        expect(EventPublisher.publishOperation).toHaveBeenCalledTimes(teams.length);
      }
    );
  });
});
