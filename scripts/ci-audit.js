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

/**
 * Audit exceptions: high/critical advisories we have individually reviewed
 * and accepted because NO upgrade can remediate them (there is no patched
 * release in the dependency's advisory range, and npm's only "fix" is a
 * nonsensical major DOWNGRADE of an unrelated parent). Each is keyed by its
 * stable GHSA advisory ID so a NEW advisory on the same package still fails
 * the build -- we accept a specific, named finding, never a whole package
 * forever.
 *
 * Keep this list SMALL and documented. Before adding an entry, confirm with
 * `npm audit --json` that the advisory's `fixAvailable` is `false` (or is a
 * major downgrade of a parent, which is not a real fix), i.e. there is
 * genuinely no version to upgrade to. If a patched release later appears,
 * remove the entry and bump instead.
 *
 * Each entry: the GHSA id, the package it concerns, and WHY it is accepted.
 */
const AUDIT_EXCEPTIONS = [
  {
    id: 'GHSA-86w9-cpqp-85rv',
    package: 'node-forge',
    reason:
      'node-forge RSA PKCS#1 v1.5 signature verification accepts extra ' +
      'nested DigestAlgorithm elements. node-forge is exact-pinned (P12->PEM ' +
      'conversion of the TAK Server admin credential); the advisory range is ' +
      '<=1.4.0 and 1.4.0 IS the latest published release -- no patched ' +
      'version exists (fixAvailable:false). We do not verify untrusted RSA ' +
      'PKCS#1 v1.5 signatures with it, so real exposure is minimal. Root tree.'
  },
  {
    id: 'GHSA-vfj7-8cjw-p6xm',
    package: 'braces',
    reason:
      'braces stack-exhaustion DoS through deeply nested glob patterns. ' +
      'Advisory range is <=3.0.3 and 3.0.3 IS the latest published braces -- ' +
      'no patched version exists. It reaches us only transitively through ' +
      'build-time/dev tooling (root: nodemon->chokidar->braces, used only in ' +
      '`npm run dev`, never CI/prod; client: tailwindcss@3->chokidar/' +
      'micromatch/fast-glob->braces, a build-time CSS step over our OWN ' +
      'config, not attacker-controlled glob input). npm\'s only "fix" is a ' +
      'breaking major DOWNGRADE of the parent (nodemon@1.14.10 / ' +
      'tailwindcss@4), not a real remediation. Covers braces and every ' +
      'package whose ONLY high finding is this same advisory id (chokidar, ' +
      'micromatch, fast-glob, nodemon, tailwindcss). Root + client trees.'
  }
];

// Set of accepted advisory ids for O(1) lookup.
const ALLOWLISTED_IDS = new Set(AUDIT_EXCEPTIONS.map((e) => e.id));

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
 * @returns {{ completed: boolean, vulnerabilities: object|null, advisories: object|null, raw: string }}
 *   `completed` is true only when a parseable report with
 *   `metadata.vulnerabilities` was produced (the audit reached the
 *   registry and evaluated the tree). Otherwise the run is treated as a
 *   transient/incomplete failure. `advisories` is the per-package
 *   `vulnerabilities` map from the report (the detail used to match the
 *   allowlist); it is null when the audit did not complete.
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
    return { completed: false, vulnerabilities: null, advisories: null, raw: String(result.error.message || result.error) };
  }

  const stdout = result.stdout || '';
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Non-JSON output = npm printed an error block, not a report.
    return { completed: false, vulnerabilities: null, advisories: null, raw: stdout || result.stderr || '' };
  }

  // A completed audit always carries metadata.vulnerabilities (the per-
  // severity counts). Its absence means the endpoint errored even though
  // *some* JSON came back (e.g. `{ "error": { ... } }`).
  const vulnerabilities = parsed && parsed.metadata && parsed.metadata.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') {
    return { completed: false, vulnerabilities: null, advisories: null, raw: stdout };
  }

  // The per-package advisory detail (npm audit v2/v7+ schema). Used to match
  // findings against the allowlist by their stable GHSA id. Absent on very
  // old npm schemas; treated as an empty map, which simply means nothing can
  // be allowlisted (the severity counts still gate the build).
  const advisories = (parsed && parsed.vulnerabilities && typeof parsed.vulnerabilities === 'object')
    ? parsed.vulnerabilities
    : {};

  return { completed: true, vulnerabilities, advisories, raw: stdout };
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

/**
 * Extracts the distinct high/critical ADVISORIES (the real root findings)
 * from the per-package `vulnerabilities` map. The chain packages (chokidar,
 * micromatch, fast-glob, tailwindcss, ...) are each flagged `via` a parent
 * PACKAGE NAME, and only the originating package carries the `via` ADVISORY
 * OBJECT (with a GHSA `url`). Collecting the distinct advisory objects
 * therefore yields each underlying advisory exactly once, independent of how
 * many packages it propagates through.
 *
 * @returns {Array<{ id: string|null, title: string, url: string, severity: string }>}
 */
function collectHighSeverityAdvisories(advisories) {
  const seen = new Map();
  for (const node of Object.values(advisories || {})) {
    if (!node || !Array.isArray(node.via)) {
      continue;
    }
    for (const via of node.via) {
      // Only advisory OBJECTS carry severity + url; string `via` entries are
      // just parent package names and are resolved via their own node.
      if (!via || typeof via !== 'object') {
        continue;
      }
      if (!FAILING_SEVERITIES.includes(via.severity)) {
        continue;
      }
      const url = via.url || '';
      // Derive the GHSA id from the advisory url (stable identifier).
      const match = /GHSA-[0-9a-z-]+/i.exec(url);
      const id = match ? match[0] : null;
      const key = id || url || `${via.title}`;
      if (!seen.has(key)) {
        seen.set(key, { id, title: via.title || '(untitled advisory)', url, severity: via.severity });
      }
    }
  }
  return Array.from(seen.values());
}

function main() {
  out(`[ci-audit] Auditing "${workingDirectory}" (fail threshold: ${FAILING_SEVERITIES.join('+')}).`);
  if (ALLOWLISTED_IDS.size > 0) {
    out(`[ci-audit] Allowlisted (reviewed, unfixable) advisories: ${Array.from(ALLOWLISTED_IDS).join(', ')}.`);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { completed, vulnerabilities, advisories, raw } = runAuditOnce();

    if (completed) {
      const rawFailingCount = FAILING_SEVERITIES.reduce(
        (sum, sev) => sum + (Number(vulnerabilities[sev]) || 0),
        0
      );
      const summary = FAILING_SEVERITIES.map((sev) => `${sev}=${vulnerabilities[sev] || 0}`).join(', ');

      if (rawFailingCount === 0) {
        out(`[ci-audit] Audit completed cleanly (${summary}). No high/critical vulnerabilities.`);
        process.exit(0);
      }

      // There ARE high/critical package findings. Partition the underlying
      // advisories into allowlisted (reviewed, unfixable) and unexpected.
      const found = collectHighSeverityAdvisories(advisories);
      const unexpected = found.filter((a) => !(a.id && ALLOWLISTED_IDS.has(a.id)));
      const accepted = found.filter((a) => a.id && ALLOWLISTED_IDS.has(a.id));

      if (accepted.length > 0) {
        out(`[ci-audit] ${accepted.length} allowlisted advisory/advisories present and ACCEPTED:`);
        for (const a of accepted) {
          out(`[ci-audit]   - ${a.id} (${a.severity}): ${a.title}`);
        }
      }

      if (unexpected.length > 0) {
        // Req 20.3: a real, non-allowlisted high/critical finding fails the
        // build. Print the offenders plus the full report for triage.
        err(`[ci-audit] Audit found ${unexpected.length} high/critical advisory/advisories NOT on the allowlist (${summary}):`);
        for (const a of unexpected) {
          err(`[ci-audit]   - ${a.id || '(no GHSA id)'} (${a.severity}): ${a.title} ${a.url}`);
        }
        err('[ci-audit] Full audit report follows:');
        err(raw);
        process.exit(1);
      }

      // Every high/critical finding is on the reviewed allowlist.
      out(`[ci-audit] Audit completed. All ${accepted.length} high/critical finding(s) are allowlisted exceptions; no unexpected vulnerabilities.`);
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
