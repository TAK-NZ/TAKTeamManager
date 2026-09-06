/**
 * Standalone, out-of-band CSV user importer for a large batch that would
 * be impractical (or unsafe) to run through `POST /api/bulk-import/users`.
 *
 * Why this exists: that HTTP route processes rows ONE AT A TIME with no
 * concurrency at all -- every row pays for at least two sequential
 * Authentik HTTP round-trips (`BulkImportService.importUserRow`'s Phase 1
 * `createUser`, and Phase 3's `updateUserAttributes`, itself a GET-then-
 * PATCH) plus several sequential DB round trips, entirely serialized.
 * Confirmed live: a 15,000-row FENZ import through that path took long
 * enough that an operator reasonably assumed it had hung, and holding an
 * HTTP request open that long risks a proxy/load-balancer timeout
 * aborting it mid-batch with an unknown number of rows actually
 * committed. `BulkImportService.importUsers` now enforces
 * `MAX_USER_IMPORT_ROWS` (500) on that route for exactly this reason --
 * this script is the documented escape hatch for anything larger.
 *
 * What this script does differently:
 *   - Runs entirely out-of-process, with no HTTP request/response and no
 *     timeout of its own to race against.
 *   - Calls `BulkImportService.importUserRow` DIRECTLY, per row -- the
 *     exact same validated logic `POST /api/bulk-import/users` uses
 *     (identity resolution, the per-row Authentik-create-then-local-
 *     transaction phasing, and its compensating-delete-on-failure path),
 *     so a row that succeeds or fails here does so for the same reasons
 *     it would through the route. `MAX_USER_IMPORT_ROWS` does NOT apply
 *     here -- that cap exists to bound a single HTTP request's cost, and
 *     this script has no such request to bound.
 *   - Runs rows with BOUNDED CONCURRENCY via `p-limit` (already a
 *     dependency, already used the same way by `authentikSync.js`'s own
 *     `processBatch`), so the Authentik round-trips for many rows
 *     actually overlap instead of serializing -- this is the real fix
 *     for the reported "extremely slow" experience, not merely moving
 *     the same serial cost somewhere else.
 *
 * Not (yet) covered: diagnosing per-row work beyond the Authentik round-
 * trips (e.g. `checkCallsignSuffixUniqueness`'s `Team.getFullMemberList`
 * re-query per row) -- concurrency alone is the fix applied here, since
 * it is safe and requires no change to `BulkImportService`'s per-row
 * logic itself.
 *
 * Usage:
 *   node scripts/bulk-import-users.js path/to/users.csv
 *   node scripts/bulk-import-users.js path/to/users.csv --team-id=5791
 *   node scripts/bulk-import-users.js path/to/users.csv --concurrency=10
 *
 * `--team-id` supplies `defaultTeamId` for any row whose own `teamId`
 * column is blank (matching `BulkImportService.importUsers`'s own
 * `defaultTeamId` option) -- omit it if every row's `teamId` column is
 * always populated.
 *
 * `--concurrency` is clamped to 1-20 (default 5), the SAME range and
 * default `authentikSync.js`'s `AUTHENTIK_SYNC_CONCURRENCY` uses, for the
 * same reason: high enough to meaningfully overlap Authentik round-trips,
 * low enough not to overwhelm Authentik's own rate limits or this
 * process's DB pool.
 *
 * Runs as a system-level import: `importingUser` is
 * `{ userId: null, is_global_manager: true }`, bypassing the per-row
 * `Team.isAdmin` check entirely (mirroring `scripts/create-cloudtak-groups.js`/
 * `scripts/cleanup-orphaned-team-groups.js`'s own "operational script runs
 * with system authority, not a specific admin's" convention) -- an
 * operator running this script from a trusted shell is already trusted
 * with more than any single team's admin scope.
 *
 * Exit code: 0 only if every row succeeded. Non-zero (1) if any row
 * failed OR the file/arguments are invalid, so this is safe to wire into
 * a CI job or cron script that should alert on a partial import.
 */

// Load .env exactly like server/index.js does, so this script can be run
// standalone and still pick up DB_*/AUTHENTIK_* the same way the app does
// -- matching scripts/cleanup-orphaned-team-groups.js's own convention.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const BulkImportService = require('../server/services/BulkImportService');
const { enqueueAllGlobalChannelReconciles } = require('../server/services/OwnedGroupReconcileEnqueuer');
const { isBulkGroupReconcileEnabled } = require('../server/config/bulkGroupReconcile');
const { parse } = require('csv-parse/sync');

function parseArgs(argv) {
  const args = { csvPath: null, teamId: null, concurrency: 5 };
  const positional = [];
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--team-id=')) {
      args.teamId = arg.slice('--team-id='.length);
    } else if (arg.startsWith('--concurrency=')) {
      // Clamped to 1-20, matching authentikSync.js's own
      // AUTHENTIK_SYNC_CONCURRENCY clamp exactly.
      const parsed = parseInt(arg.slice('--concurrency='.length), 10);
      args.concurrency = Math.min(20, Math.max(1, parsed || 5));
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }
  args.csvPath = positional[0] || null;
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.csvPath) {
    process.stderr.write(
      'Usage: node scripts/bulk-import-users.js <path/to/users.csv> [--team-id=N] [--concurrency=1-20]\n'
    );
    process.exit(1);
  }

  const resolvedPath = path.resolve(args.csvPath);
  let csvBuffer;
  try {
    csvBuffer = fs.readFileSync(resolvedPath);
  } catch (readError) {
    process.stderr.write(`Failed to read ${resolvedPath}: ${readError.message}\n`);
    process.exit(1);
  }

  // Parse up front (not streamed) so the total row count is known before
  // any work starts, for the progress line below -- the file sizes this
  // script targets (thousands of rows of a few short text columns) are
  // trivially small to hold fully in memory.
  const rows = parse(csvBuffer, { columns: true, trim: true, skip_empty_lines: true });

  process.stdout.write(
    `Importing ${rows.length} row(s) from ${resolvedPath} with concurrency ${args.concurrency}` +
    (args.teamId ? ` (default teamId: ${args.teamId})` : '') +
    '...\n'
  );

  const importingUser = { userId: null, is_global_manager: true };
  const limit = pLimit(args.concurrency);
  const results = new Array(rows.length);
  let completed = 0;

  // Bulk global-channel handling, mirroring BulkImportService.importUsers:
  // suppress the O(users) per-user assign_user_to_global_channels enqueue and
  // issue ONE group-axis reconcile for all global channels after the batch --
  // only on the group-axis path (BULK_GROUP_RECONCILE_ENABLED). With it off,
  // the old per-user enqueue must run, or imported users get no global
  // channels (the reconciler is inert when the flag is off).
  const useGroupAxis = isBulkGroupReconcileEnabled();

  await Promise.all(
    rows.map((row, index) => limit(async () => {
      const rowNumber = index + 1;
      try {
        const outcome = await BulkImportService.importUserRow(
          row,
          importingUser,
          args.teamId,
          { skipGlobalChannelEnqueue: useGroupAxis }
        );
        results[index] = { row: rowNumber, success: true, userId: outcome.localUserId };
      } catch (error) {
        results[index] = { row: rowNumber, success: false, error: error.message };
      } finally {
        completed++;
        if (completed % 50 === 0 || completed === rows.length) {
          process.stdout.write(`  ...${completed}/${rows.length} rows processed\n`);
        }
      }
    }))
  );

  const successCount = results.filter((r) => r.success).length;
  const failureCount = results.length - successCount;

  // One group-axis global-channel reconcile for the whole run, replacing the
  // per-user ops suppressed above (see BulkImportService.importUsers for the
  // rationale). Only on the group-axis path and only if a row succeeded.
  if (useGroupAxis && successCount > 0) {
    try {
      await enqueueAllGlobalChannelReconciles(null, null);
      process.stdout.write('Enqueued one global-channel reconcile per group for the batch.\n');
    } catch (error) {
      process.stderr.write(
        `Warning: failed to enqueue the post-batch global-channel reconcile (${error.message}); ` +
        'the anti-drift sweep will converge these groups.\n'
      );
    }
  }

  process.stdout.write(`\nDone: ${successCount} succeeded, ${failureCount} failed.\n`);

  if (failureCount > 0) {
    process.stdout.write('\nFailed rows:\n');
    for (const result of results) {
      if (!result.success) {
        process.stdout.write(`  row ${result.row}: ${result.error}\n`);
      }
    }
  }

  process.exit(failureCount > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`Unexpected error: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
