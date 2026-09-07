/**
 * Standalone, out-of-band CSV user PURGE — the destructive inverse of
 * `scripts/bulk-import-users.js`. Given the SAME CSV that created a batch
 * of users, this fully destroys each of those users: it removes their team
 * and channel memberships, clears their TAK attributes in Authentik,
 * DELETEs the federated Authentik account, and removes the local
 * `users`/`user_cache` rows.
 *
 * Built specifically to clean up the 15,000-row FENZ test import
 * (examples/user-import/fenz-15000-user-import.csv), but works for any CSV
 * with an `email` column.
 *
 * ============================ SAFETY ============================
 * Deleting an Authentik user is IRREVERSIBLE and hits the shared IdP, not
 * just this app. Accordingly:
 *
 *   - DRY RUN IS THE DEFAULT. Without `--execute`, this script only
 *     RESOLVES and REPORTS which users it WOULD delete (matched count,
 *     unmatched rows, a sample) and performs NO writes of any kind — no
 *     DB change, no Authentik call.
 *   - `--execute` is the ONLY thing that arms real deletion. Even then it
 *     first prints the resolved plan and pauses for a typed confirmation
 *     unless `--yes` is also supplied (for non-interactive/CI use).
 *   - The CSV is treated as an explicit ALLOWLIST. A row is only acted on
 *     if its `email` resolves to EXACTLY ONE local `users` row. Anything
 *     that does not resolve (already deleted, never existed, ambiguous) is
 *     reported and SKIPPED, never guessed at.
 *
 * The per-user destroy sequence is a faithful copy of the app's own
 * human-member delete path (`DELETE /api/users/:userId/remove` in
 * `server/routes/users.js`), in the same order, so a user removed here is
 * removed for exactly the same reasons and with the same side effects
 * (certificate-revocation enqueue, attribute clearing) as through the UI:
 *
 *   1. TeamMembershipService.removeUserFromTeam(userId)   (memberships +
 *      revoke_tak_certificates enqueue)
 *   2. UserAttributesService.clearUserAttributes(authentikUserId)
 *   3. DELETE {AUTHENTIK_URL}/api/v3/core/users/{authentikUserId}/
 *   4. DELETE FROM user_cache WHERE authentik_id = ...
 *   5. DELETE FROM users WHERE id = ...
 *
 * A user with a NULL authentik_user_id (a never-federated local Claim_Row,
 * or an already-partially-cleaned row) skips steps 2–3 and only has its
 * local rows removed. A 404 from the Authentik DELETE is treated as
 * success (already gone), matching the route.
 *
 * Runs with bounded concurrency via `p-limit` (clamped 1–20, default 5 —
 * the SAME range/default as bulk-import-users.js and authentikSync.js), so
 * the Authentik round-trips overlap without exceeding Authentik's write
 * rate ceiling.
 *
 * NOTE: while purging at this scale, consider setting
 * AUTHENTIK_SYNC_ENABLED=false for the duration so the periodic sync does
 * not observe half-deleted state (it is an opt-OUT flag; set it back after).
 *
 * Usage:
 *   node scripts/purge-users.js <path/to/users.csv>                 # dry run
 *   node scripts/purge-users.js <path/to/users.csv> --execute       # prompts, then deletes
 *   node scripts/purge-users.js <path/to/users.csv> --execute --yes # non-interactive delete
 *   node scripts/purge-users.js <path/to/users.csv> --concurrency=8
 *
 * Exit code: 0 if every matched row was purged (or a clean dry run). Non-zero
 * (1) if any row failed, or the file/arguments are invalid — safe to gate a
 * CI/cron job on.
 */

// Load .env exactly like server/index.js / bulk-import-users.js do, so this
// script picks up DB_*/AUTHENTIK_* the same way the app does.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pLimit = require('p-limit');
const { parse } = require('csv-parse/sync');
const pool = require('../server/config/database');
const TeamMembershipService = require('../server/services/TeamMembershipService');
const UserAttributesService = require('../server/services/userAttributes');
const { fetchWithTimeout } = require('../server/utils/fetchWithTimeout');
const logger = require('../server/config/logger').createLogger('purge-users');

function parseArgs(argv) {
  const args = { csvPath: null, execute: false, yes: false, concurrency: 5 };
  const positional = [];
  for (const arg of argv.slice(2)) {
    if (arg === '--execute') {
      args.execute = true;
    } else if (arg === '--yes' || arg === '-y') {
      args.yes = true;
    } else if (arg.startsWith('--concurrency=')) {
      // Clamped 1–20, matching bulk-import-users.js / AUTHENTIK_SYNC_CONCURRENCY.
      const parsed = parseInt(arg.slice('--concurrency='.length), 10);
      args.concurrency = Math.min(20, Math.max(1, parsed || 5));
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }
  args.csvPath = positional[0] || null;
  return args;
}

/**
 * Resolve one CSV row to a local user by EMAIL. Email is the org-policy-
 * independent key: `BulkImportService.importUserRow` stores the real email
 * on both `users` and `user_cache` regardless of whether the Organisation
 * is pseudonymous (which mints its OWN username, so username==email cannot
 * be assumed). `users.email` is UNIQUE, so this is at most one row.
 */
async function resolveRowByEmail(email) {
  const res = await pool.query(
    'SELECT id, authentik_user_id, username, email FROM users WHERE email = $1',
    [email]
  );
  return res.rows; // 0 or 1 (UNIQUE), but return the array so callers can detect duplicates defensively.
}

/**
 * Faithful copy of server/routes/users.js's human-member delete ordering.
 * Returns a short outcome string for the audit line.
 */
async function destroyUser({ id, authentik_user_id }) {
  // 1. Memberships + revoke_tak_certificates enqueue (unconditional full removal).
  await TeamMembershipService.removeUserFromTeam(id, null);

  let authentikOutcome = 'no_authentik_account';
  if (authentik_user_id !== null && authentik_user_id !== undefined) {
    // 2. Clear TAK attributes in Authentik (best-effort in the app too).
    try {
      await UserAttributesService.clearUserAttributes(authentik_user_id);
    } catch (attrErr) {
      logger.warn({ err: attrErr, authentikUserId: authentik_user_id },
        'purge-users: clearUserAttributes failed; continuing to delete');
    }

    // 3. DELETE the federated Authentik account. 404 == already gone == success.
    const deleteResponse = await fetchWithTimeout(
      `${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentik_user_id}/`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` } }
    );
    if (deleteResponse.ok) {
      authentikOutcome = 'deleted';
    } else if (deleteResponse.status === 404) {
      authentikOutcome = 'already_absent';
    } else {
      // Surface it — do NOT silently drop the local rows for a user whose
      // Authentik account we failed to remove (that would leak a federated
      // account with no local record).
      throw new Error(`Authentik DELETE responded ${deleteResponse.status} for pk ${authentik_user_id}`);
    }
  }

  // 4 + 5. Remove the local rows.
  if (authentik_user_id !== null && authentik_user_id !== undefined) {
    await pool.query('DELETE FROM user_cache WHERE authentik_id = $1', [String(authentik_user_id)]);
  }
  await pool.query('DELETE FROM users WHERE id = $1', [id]);

  return authentikOutcome;
}

function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.csvPath) {
    process.stderr.write(
      'Usage: node scripts/purge-users.js <path/to/users.csv> [--execute] [--yes] [--concurrency=1-20]\n'
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

  const rows = parse(csvBuffer, { columns: true, trim: true, skip_empty_lines: true });
  if (rows.length === 0 || !('email' in rows[0])) {
    process.stderr.write('CSV has no rows, or no `email` column — nothing to resolve.\n');
    process.exit(1);
  }

  process.stdout.write(
    `${args.execute ? 'PURGE' : 'DRY RUN'}: resolving ${rows.length} row(s) from ${resolvedPath} by email...\n`
  );

  // --- Resolution pass (read-only, runs in BOTH dry-run and execute). ---
  const toDelete = [];   // { row, email, id, authentik_user_id, username }
  const unmatched = [];  // { row, email } — no local user
  const ambiguous = [];  // { row, email, count } — should be impossible (email UNIQUE)
  const missingEmail = []; // { row } — blank email column

  for (let i = 0; i < rows.length; i++) {
    const email = (rows[i].email || '').trim();
    if (!email) { missingEmail.push({ row: i + 1 }); continue; }
    const matches = await resolveRowByEmail(email);
    if (matches.length === 0) {
      unmatched.push({ row: i + 1, email });
    } else if (matches.length > 1) {
      ambiguous.push({ row: i + 1, email, count: matches.length });
    } else {
      toDelete.push({ row: i + 1, email, ...matches[0] });
    }
  }

  // --- Report the plan. ---
  process.stdout.write('\n=== Resolution summary ===\n');
  process.stdout.write(`  matched (will be deleted): ${toDelete.length}\n`);
  process.stdout.write(`  unmatched (no local user; skipped): ${unmatched.length}\n`);
  process.stdout.write(`  ambiguous (skipped): ${ambiguous.length}\n`);
  process.stdout.write(`  blank email (skipped): ${missingEmail.length}\n`);

  const sample = toDelete.slice(0, 5)
    .map((u) => `    - ${u.email} (users.id=${u.id}, authentik_user_id=${u.authentik_user_id ?? 'NULL'})`)
    .join('\n');
  if (sample) process.stdout.write(`\n  sample of matched users:\n${sample}\n`);
  if (unmatched.length > 0) {
    process.stdout.write(`\n  first unmatched emails: ${unmatched.slice(0, 5).map((u) => u.email).join(', ')}\n`);
  }

  if (!args.execute) {
    process.stdout.write('\nDRY RUN complete — no changes made. Re-run with --execute to delete.\n');
    await pool.end();
    process.exit(0);
  }

  if (toDelete.length === 0) {
    process.stdout.write('\nNothing to delete. Exiting.\n');
    await pool.end();
    process.exit(0);
  }

  // --- Confirmation gate for --execute. ---
  if (!args.yes) {
    const answer = await promptYesNo(
      `\n!! IRREVERSIBLE: this will delete ${toDelete.length} users from the LOCAL DB and from Authentik ` +
      `at ${process.env.AUTHENTIK_URL}.\nType "delete" to proceed: `
    );
    if (answer !== 'delete') {
      process.stdout.write('Aborted — no changes made.\n');
      await pool.end();
      process.exit(1);
    }
  }

  process.stdout.write(`\nDeleting ${toDelete.length} users with concurrency ${args.concurrency}...\n`);

  const limit = pLimit(args.concurrency);
  const results = new Array(toDelete.length);
  let completed = 0;

  await Promise.all(
    toDelete.map((user, index) => limit(async () => {
      try {
        const authentikOutcome = await destroyUser(user);
        results[index] = { email: user.email, success: true, authentikOutcome };
        logger.info(
          { email: user.email, userId: user.id, authentikUserId: user.authentik_user_id, authentikOutcome },
          'purge-users: user deleted'
        );
      } catch (error) {
        results[index] = { email: user.email, success: false, error: error.message };
        logger.error(
          { err: error, email: user.email, userId: user.id, authentikUserId: user.authentik_user_id },
          'purge-users: user deletion FAILED'
        );
      } finally {
        completed++;
        if (completed % 50 === 0 || completed === toDelete.length) {
          process.stdout.write(`  ...${completed}/${toDelete.length} processed\n`);
        }
      }
    }))
  );

  const successCount = results.filter((r) => r && r.success).length;
  const failureCount = results.length - successCount;

  process.stdout.write(`\nDone: ${successCount} deleted, ${failureCount} failed.\n`);
  if (failureCount > 0) {
    process.stdout.write('\nFailed rows:\n');
    for (const r of results) {
      if (r && !r.success) process.stdout.write(`  ${r.email}: ${r.error}\n`);
    }
  }

  await pool.end();
  process.exit(failureCount > 0 ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(`Unexpected error: ${error && error.stack ? error.stack : error}\n`);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
