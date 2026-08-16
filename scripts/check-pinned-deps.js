'use strict';

/**
 * Requirement 20.5 / 20.6: jsonwebtoken, bcryptjs, helmet, and
 * express-rate-limit must be declared in package.json with an exact
 * version (no `^`/`~` range operator), to avoid unreviewed automatic
 * upgrades of these security-sensitive packages. This script fails CI
 * (non-zero exit) if any of them is declared with a `^` or `~` range.
 *
 * bcryptjs is intentionally allowed to be absent (Requirement 20.7
 * resolved by removing it as an unused dependency); absence is treated
 * as passing, not failing, for that package specifically. The other
 * three packages are expected to be present; a missing required
 * package is also reported as a violation so the check stays useful if
 * one is accidentally dropped from package.json.
 */

const path = require('path');

const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

// Packages that must use an exact version when present.
const PINNED_PACKAGES = ['jsonwebtoken', 'bcryptjs', 'helmet', 'express-rate-limit'];

// Packages that are required to be present in dependencies (all except
// bcryptjs, which was intentionally removed as unused per Requirement 20.7).
const REQUIRED_PACKAGES = ['jsonwebtoken', 'helmet', 'express-rate-limit'];

function hasRangeOperator(versionString) {
  return versionString.startsWith('^') || versionString.startsWith('~');
}

function checkPinnedDeps(pkg) {
  const dependencies = pkg.dependencies || {};
  const violations = [];

  for (const name of PINNED_PACKAGES) {
    const declaredVersion = dependencies[name];

    if (declaredVersion === undefined) {
      if (REQUIRED_PACKAGES.includes(name)) {
        violations.push(`${name}: expected to be declared in dependencies, but it is missing`);
      }
      // Absent and not required (bcryptjs) -> passes, no violation.
      continue;
    }

    if (hasRangeOperator(declaredVersion)) {
      violations.push(`${name}: "${declaredVersion}" uses a "^"/"~" range; an exact version is required`);
    }
  }

  return violations;
}

function main() {
  const pkg = require(PACKAGE_JSON_PATH);
  const violations = checkPinnedDeps(pkg);

  if (violations.length > 0) {
    process.stderr.write('Version-pin lint failed (Requirements 20.5/20.6):\n');
    for (const violation of violations) {
      process.stderr.write(`  - ${violation}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write('Version-pin lint passed: jsonwebtoken, helmet, and express-rate-limit are exactly pinned; bcryptjs is absent.\n');
}

if (require.main === module) {
  main();
}

module.exports = { checkPinnedDeps, hasRangeOperator, PINNED_PACKAGES, REQUIRED_PACKAGES };
