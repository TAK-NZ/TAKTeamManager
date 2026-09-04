'use strict';

/**
 * Requirement 20.2/20.3/20.4: dependency vulnerability audit for CI.
 *
 * This is a resilient wrapper around `npm audit --audit-level=high`. It
 * exists because the bare command is at the mercy of npm's remote audit
 * endpoint (`https://registry.npmjs.org/-/npm/v1/security/audits/quick`),
 * which intermittently returns transport errors (observed: HTTP 400 and
 * 503) that have NOTHING to do with the dependency tree. `npm audit` exits
 * non-zero for BOTH "found a high/critical vulnerability" AND "could not
 * reach/complete the audit", so a bare invocation turns a transient
 * registry blip into a red build indistinguishable from a real finding.
 *
 * The requirements this must preserve while fixing that flakiness:
 *   - Req 20.3: a high or critical finding MUST fail the build.
 *   - Req 20.4: an audit that genuinely cannot complete MUST also fail the
 *     build -- an errored/incomplete scan must never be mistaken for a
 *     pass. So this does NOT just swallow failures; it distinguishes the
 *     two cases and only RETRIES the transient-transport case.
 *
 * How the two cases are told apart: `npm audit --json` emits a report
 * whose `metadata.vulnerabilities` object is present ONLY when the audit
 * actually completed against the registry's advisory data. A transport
 * failure produces no such report (npm prints an `npm error audit endpoint
 * returned an error` block and emits either non-JSON or an `{ "error": ...
 * }` object). So:
 *   - Report parsed with `metadata.vulnerabilities` present  => COMPLETED.
 *       Fail iff high + critical > 0; otherwise pass. Authoritative, so
 *       NO retry either way -- a real result is never retried.
 *   - No such report                                          => TRANSIENT.
 *       Retry with backoff. If every attempt fails to complete, FAIL the
 *       build (Req 20.4) rather than passing on an unknown vulnerability
 *       state.
 *
 * Usage: node scripts/ci-audit.js [workingDirectory]
 *   workingDirectory defaults to the current working directory, so the CI
 *   job can `cd` (or set `working-directory`) into the tree it audits.
 *
 * Pinned to high/critical to match `--audit-level=high` exactly; change
 * AUDIT_LEVEL below if that threshold is ever revisited.
 */

const { spawnSync } = require('child_process');

const workingDirectory = process.argv[2] || process.cwd();

// The severities that fail the build, matching `npm audit --audit-level=high`
// (high and everything above it, i.e. critical).
const FAILING_SEVERITIES = ['high', 'critical'];

// Bounded retries for the TRANSIENT-transport case only. 5 attempts with
// linear backoff (5s, 10s, 15s, 20s) keeps total worst-case wait under the
// job's 15-minute timeout with wide margin, while riding out a brief
// registry hiccup.
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5000;

function sleep(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/**
 * Runs `npm audit --json` once in `workingDirectory`.
 *
 * @returns {{ completed: boolean, vulnerabilities: object|null, raw: string }}
 *   `completed` is true only when a parseable report with
 *   `metadata.vulnerabilities` was produced (the audit reached the
 *   registry and evaluated the tree). Otherwise the run is treated as a
 *   transient/incomplete failure.
 */
function runAuditOnce() {
  // `--audit-level` does not affect the JSON report's contents (it only
  // changes the human formatter's exit behaviour), so it is omitted here;
  // the threshold is applied explicitly against the JSON below.
  const result = spawnSync('npm', ['audit', '--json'], {
    cwd: workingDirectory,
    encoding: 'utf8',
    // Advisory reports can be large; give stdout plenty of room.
    maxBuffer: 64 * 1024 * 1024,
    // Never inherit a shell; args are passed directly (no injection surface).
    shell: false
  });

  if (result.error) {
    // npm couldn't even be spawned (not on PATH, etc.). Not a transient
    // registry issue -- surface the raw error to the caller as incomplete.
    return { completed: false, vulnerabilities: null, raw: String(result.error.message || result.error) };
  }

  const stdout = result.stdout || '';
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Non-JSON output = npm printed an error block, not a report.
    return { completed: false, vulnerabilities: null, raw: stdout || result.stderr || '' };
  }

  // A completed audit always carries metadata.vulnerabilities (the per-
  // severity counts). Its absence means the endpoint errored even though
  // *some* JSON came back (e.g. `{ "error": { ... } }`).
  const vulnerabilities = parsed && parsed.metadata && parsed.metadata.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') {
    return { completed: false, vulnerabilities: null, raw: stdout };
  }

  return { completed: true, vulnerabilities, raw: stdout };
}

// Output via process.stdout/stderr.write (with explicit newlines), matching
// the lint-clean convention of the other operational scripts here -- the
// server `no-console` lint rule applies to scripts/ too.
function out(message) {
  process.stdout.write(`${message}\n`);
}
function err(message) {
  process.stderr.write(`${message}\n`);
}

function main() {
  out(`[ci-audit] Auditing "${workingDirectory}" (fail threshold: ${FAILING_SEVERITIES.join('+')}).`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { completed, vulnerabilities, raw } = runAuditOnce();

    if (completed) {
      const failingCount = FAILING_SEVERITIES.reduce(
        (sum, sev) => sum + (Number(vulnerabilities[sev]) || 0),
        0
      );
      const summary = FAILING_SEVERITIES.map((sev) => `${sev}=${vulnerabilities[sev] || 0}`).join(', ');

      if (failingCount > 0) {
        // Req 20.3: a real high/critical finding fails the build. Print the
        // full report so the failing advisories are visible in the log.
        err(`[ci-audit] Audit completed with ${failingCount} high/critical finding(s) (${summary}).`);
        err(raw);
        process.exit(1);
      }

      out(`[ci-audit] Audit completed cleanly (${summary}). No high/critical vulnerabilities.`);
      process.exit(0);
    }

    // Transient/incomplete: the registry audit endpoint errored. Retry.
    err(
      `[ci-audit] Audit did not complete on attempt ${attempt}/${MAX_ATTEMPTS} ` +
      `(registry audit endpoint error). Raw output follows:`
    );
    err(raw ? raw.slice(0, 2000) : '(no output)');

    if (attempt < MAX_ATTEMPTS) {
      const delay = BACKOFF_BASE_MS * attempt;
      err(`[ci-audit] Retrying in ${delay / 1000}s...`);
      sleep(delay);
    }
  }

  // Req 20.4: every attempt failed to COMPLETE. An audit that cannot assess
  // the tree must fail the build -- never pass on an unknown vulnerability
  // state.
  err(
    `[ci-audit] Audit could not complete after ${MAX_ATTEMPTS} attempts ` +
    `(persistent registry audit endpoint error). Failing the build: an ` +
    `audit that cannot complete must not be treated as a pass (Req 20.4).`
  );
  process.exit(1);
}

main();
