/**
 * Registry and configuration smoke tests for takserver-enrollment (task
 * 8.11; Requirements 3.5, 3.7, 3.9, 5.10, 10.5, 11.3, 15.10, 16.3).
 *
 * These are deliberately SMALL, targeted assertions against the shipped
 * registry/config source rather than a re-statement of the feature's
 * behavioural tests (those live in `server/services/
 * DeviceEnrollmentService.enrollment.test.js`, `server/routes/
 * enrollment.test.js`, `server/routes/devices.test.js`, and
 * `server/config/permissions.registry.test.js`). This file exists so a
 * single "did the wiring survive a refactor" pass can run without pulling
 * in the whole feature's test surface.
 *
 * Each `it` below maps to one bullet of task 8.11's list. Where a bullet
 * says "assert X and Y in the SAME test", that grouping is preserved
 * literally, because the whole point is that a later change satisfying
 * one half must not be able to silently break the other.
 */

const fs = require('fs');
const path = require('path');

const { routes, roleDefaults, resolveAccess } = require('../permissions.registry');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Criteria 3.5, 3.7: POST /api/enrollment/me -> enrollment:self, NOT
// device:manage; enrollment:self IS in roleDefaults.authenticated_user;
// device:read:team_admin is in the registry, NOT in roleDefaults, and HAS
// a resolver. All three asserted together so a later refactor cannot
// satisfy one while quietly breaking another.
// ---------------------------------------------------------------------------

describe('enrollment:self / device:read:team_admin registry wiring (Criteria 3.5, 3.7)', () => {
  /**
   * Extracts the `rowScopedResolvers` object's top-level keys from
   * `authorize.js`'s source text, following the exact convention
   * `permissions.registry.test.js` already uses for the same extraction.
   *
   * @returns {string[]}
   */
  function readRowScopedResolverKeys() {
    const authorizeSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'middleware', 'authorize.js'),
      'utf8'
    );

    const declaration = authorizeSource.match(/const rowScopedResolvers = \{([\s\S]*?)\n\};/);

    // Anti-vacuity: fail loudly rather than silently finding zero keys if
    // the declaration is ever renamed or reshaped.
    expect(declaration).not.toBeNull();

    const keys = Array.from(declaration[1].matchAll(/^ {2}'([^']+)':/gm), (m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);

    return keys;
  }

  it('maps POST /api/enrollment/me to enrollment:self and NOT device:manage; enrollment:self is a static grant; device:read:team_admin is registered, resolver-gated, and kept out of roleDefaults', () => {
    // POST /api/enrollment/me -> enrollment:self, never device:manage.
    expect(routes['POST /api/enrollment/me']).toEqual(['enrollment:self']);
    expect(routes['POST /api/enrollment/me']).not.toContain('device:manage');

    // enrollment:self IS in roleDefaults.authenticated_user -- its subject
    // is req.user.userId alone, so a static grant cannot widen anything.
    expect(roleDefaults.authenticated_user).toContain('enrollment:self');

    // device:read:team_admin IS in the registry, backing the team device
    // listing route.
    expect(routes['GET /api/devices/team/:teamId']).toEqual(['device:read:team_admin']);

    // device:read:team_admin is NOT in roleDefaults (any role) -- its
    // subject comes from the :teamId URL parameter, so a static grant
    // would let any authenticated user enumerate any team's devices.
    expect(roleDefaults.authenticated_user).not.toContain('device:read:team_admin');
    expect(roleDefaults.global_manager).not.toContain('device:read:team_admin');

    // device:read:team_admin HAS a row-scoped resolver in authorize.js.
    const resolverKeys = readRowScopedResolverKeys();
    expect(resolverKeys).toContain('device:read:team_admin');

    // enrollment:self correctly has NO resolver -- it is satisfied purely
    // by the static grant above, since there is no row for a resolver to
    // scope.
    expect(resolverKeys).not.toContain('enrollment:self');

    // Behavioural cross-check via the real resolveAccess: a plain
    // authenticated user reaches the self route outright, and does NOT
    // reach the team-listing route without the resolver-granted identifier.
    const registry = { routes, roleDefaults };
    expect(
      resolveAccess('POST /api/enrollment/me', roleDefaults.authenticated_user, registry)
    ).toBe(true);
    expect(
      resolveAccess('GET /api/devices/team/:teamId', roleDefaults.authenticated_user, registry)
    ).toBe(false);
    expect(
      resolveAccess('GET /api/devices/team/:teamId', ['device:read:team_admin'], registry)
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// permissions.registry.completeness.test.js passes unchanged.
//
// The completeness suite's own module exports its route-walking building
// blocks (`buildTestApp`, `collectRouteKeys`) specifically for reuse by a
// sibling test (see that file's trailing comment, written for
// `publicRoutes.completeness.test.js`). Reusing them here -- rather than
// `require()`-ing the whole spec file inside an `it()` body, which would
// try to register new `describe`/`it` calls after Jest's collection phase
// has already finished -- re-runs the SAME walk-and-diff the completeness
// suite performs and asserts the SAME invariant, so a regression there
// fails here too, without duplicating the walker's own implementation.
// ---------------------------------------------------------------------------

const { buildTestApp, collectRouteKeys } = require('../permissions.registry.completeness.test.js');
const publicRoutes = require('../publicRoutes');

describe('permissions.registry.completeness.test.js is unaffected by the enrollment routes', () => {
  it('runs the existing completeness walk and it passes, with the enrollment route resolving cleanly', () => {
    const app = buildTestApp();
    const collected = [];
    collectRouteKeys(app._router.stack, '', collected);

    expect(collected.length).toBeGreaterThan(50);

    const registryKeys = new Set(Object.keys(routes));
    const publicKeys = new Set(publicRoutes.map((r) => `${r.method} ${r.path}`));
    const uniqueCollected = Array.from(new Set(collected));
    const missing = uniqueCollected.filter(
      (key) => !registryKeys.has(key) && !publicKeys.has(key)
    );

    expect(missing).toEqual([]);
    // The enrollment route specifically must be among the routes that
    // resolved cleanly (i.e. not among "missing").
    expect(collected).toContain('POST /api/enrollment/me');
  });
});

// ---------------------------------------------------------------------------
// Criterion 3.9: the audit_logs INSERT's column set on the self path
// names the acting user, the target principal and the generation time,
// and matches what routes/devices.js already writes.
// ---------------------------------------------------------------------------

describe('the self-enrollment audit_logs INSERT matches the shape routes/devices.js already writes (Criterion 3.9)', () => {
  it('has the same INSERT INTO audit_logs column set, and a details document naming principalId/generatedAt/expiresAt with no token or QR data', () => {
    const enrollmentSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'routes', 'enrollment.js'),
      'utf8'
    );
    const devicesSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'routes', 'devices.js'),
      'utf8'
    );

    // Same column set/shape: INSERT INTO audit_logs (user_id, action,
    // resource_type, resource_id, details).
    const auditColumnSet = /INSERT INTO audit_logs \(user_id, action, resource_type, resource_id, details\)/;
    expect(enrollmentSource).toMatch(auditColumnSet);
    expect(devicesSource).toMatch(auditColumnSet);

    // The self path's details document names the acting user (via the
    // params array's req.user.userId as the first bound value), the
    // target principal (enrollment.principalId), and the generation time
    // (generatedAt), and carries none of the secret enrollment artifacts.
    expect(enrollmentSource).toContain('req.user.userId');
    expect(enrollmentSource).toContain('enrollment.principalId');
    expect(enrollmentSource).toContain('generatedAt');
    expect(enrollmentSource).toContain('expiresAt: enrollment.expiresAt');
    expect(enrollmentSource).not.toMatch(/details.*token/i);
    expect(enrollmentSource).not.toMatch(/atakQrDataUrl|itakQrDataUrl|atakEnrollmentUri|itakRegistrationPayload/);
  });
});

// ---------------------------------------------------------------------------
// Criterion 11.3: client/package.json names no QR package. Criterion
// 15.10: the feature reads only TAK_SERVER_URL from the environment, with
// .env.example UNCHANGED (for this feature -- no new variable added).
// ---------------------------------------------------------------------------

describe('no client QR dependency, and no new environment variable for this feature (Criteria 11.3, 15.10)', () => {
  it('client/package.json names no QR-rendering package in dependencies or devDependencies', () => {
    const clientPackageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'client', 'package.json'), 'utf8')
    );

    const allDeps = {
      ...(clientPackageJson.dependencies || {}),
      ...(clientPackageJson.devDependencies || {})
    };

    const qrPackageNames = Object.keys(allDeps).filter((name) => /qr/i.test(name));
    expect(qrPackageNames).toEqual([]);
  });

  it('introduces exactly one NEW environment variable across the feature\'s server files -- TAK_SERVER_ENROLLMENT_URL (a dedicated enrollment host, deliberately distinct from the Marti certadmin API\'s TAK_SERVER_URL) -- plus the pre-existing AUTHENTIK_URL/AUTHENTIK_API_TOKEN compensating-delete pair, and (cert-expiry-notifications Requirement 7.3(b), a LATER spec) DEVICE_MGMT_EXPIRY_WARNING_DAYS', () => {
    // Every server module this feature touches or introduces. Scanned for
    // `process.env.` reads. TAK_SERVER_ENROLLMENT_URL is the one NEW
    // variable this feature's enrollment-generation path reads (a later
    // correction to Criterion 15.10's original "reads only the already-
    // configured TAK_SERVER_URL" -- the enrollment host and the Marti
    // certadmin API host are not always the same name, so a dedicated
    // variable is documented in .env.example with a safe default, per
    // that criterion's own fallback clause). AUTHENTIK_URL/
    // AUTHENTIK_API_TOKEN also appear, in `DeviceEnrollmentService.js`'s
    // `#compensateClaimRow` -- but those are the SAME pair every other
    // Authentik-calling path in this codebase already reads
    // (`server/services/authentik.js`, `server/routes/users.js`'s own
    // compensating-delete site), already documented in `.env.example`,
    // and not new to this feature. No ENROLLMENT_*/MANAGED_IDENTIFIER_*-
    // shaped variable is introduced.
    //
    // cert-expiry-notifications Requirement 7.3(b) (a LATER spec, which
    // per this codebase's own convention overrules an earlier one where
    // they conflict) added `listAllDevices`'s `expiringOnly` filter to
    // `DeviceEnrollmentService.js`, which reads the PRE-EXISTING,
    // already-documented `DEVICE_MGMT_EXPIRY_WARNING_DAYS` (the same
    // threshold `classifyExpiry` already applies client-side) to compute
    // the SQL boundary -- not a new, undocumented, or secret-shaped
    // variable, so this guard's intent (catch an undocumented server env
    // var creeping into this feature's files) is unaffected; only the
    // exact set this ONE test asserts needed widening.
    const featureFiles = [
      'server/routes/enrollment.js',
      'server/routes/devices.js',
      'server/services/DeviceEnrollmentService.js',
      'server/services/ManagedIdentifierService.js',
      'server/utils/managedIdentifier.js',
      'server/utils/identifierAlphabet.js',
      'server/utils/authentikEmail.js',
      'server/services/UserProvisioningService.js',
      'server/services/RequestApprovalService.js',
      'server/services/BulkImportService.js',
      'server/routes/teams.js'
    ];

    const envVarPattern = /process\.env\.([A-Z0-9_]+)/g;
    const foundVars = new Set();
    for (const relativePath of featureFiles) {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
      for (const match of source.matchAll(envVarPattern)) {
        foundVars.add(match[1]);
      }
    }

    // Anti-vacuity: TAK_SERVER_ENROLLMENT_URL must actually have been
    // found by the scan, so this assertion is measuring something.
    expect(foundVars.has('TAK_SERVER_ENROLLMENT_URL')).toBe(true);

    const expectedVars = [
      'AUTHENTIK_API_TOKEN',
      'AUTHENTIK_URL',
      'TAK_SERVER_ENROLLMENT_URL',
      'DEVICE_MGMT_EXPIRY_WARNING_DAYS'
    ];
    expect(Array.from(foundVars).sort()).toEqual(expectedVars.sort());

    // AUTHENTIK_URL/AUTHENTIK_API_TOKEN are documented as literal keys
    // in .env.example already (pre-existing). TAK_SERVER_ENROLLMENT_URL
    // is documented there with a literal `TAK_SERVER_ENROLLMENT_URL=`
    // line and a safe (empty) default. DEVICE_MGMT_EXPIRY_WARNING_DAYS is
    // likewise pre-existing, documented with a safe (30) default.
    const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    expect(envExample).toMatch(/^AUTHENTIK_URL=/m);
    expect(envExample).toMatch(/^AUTHENTIK_API_TOKEN=/m);
    expect(envExample).toMatch(/^TAK_SERVER_ENROLLMENT_URL=/m);
    expect(envExample).toMatch(/^DEVICE_MGMT_EXPIRY_WARNING_DAYS=/m);
  });

  it('does not add a new ENROLLMENT_* or MANAGED_IDENTIFIER_* variable to .env.example', () => {
    const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');

    // The feature's own constants (Enrollment_Port 8089, the 30-minute
    // token lifetime, the 365-day certificate lifetime) are code
    // constants, deliberately never environment variables (Criteria 4.4,
    // 3.10) -- so none of these should ever appear as a KEY in
    // .env.example.
    expect(envExample).not.toMatch(/^ENROLLMENT_/m);
    expect(envExample).not.toMatch(/^MANAGED_IDENTIFIER_/m);
    expect(envExample).not.toMatch(/^CERTIFICATE_LIFETIME/m);
    expect(envExample).not.toMatch(/^IDENTIFIER_/m);
  });
});

// ---------------------------------------------------------------------------
// Criterion 16.3: no code path rewrites a client_uid or a certificate
// Common_Name for display. Criterion 10.5: the enrollment path reads no
// attributes.takRole / takCallsign / takColor.
// ---------------------------------------------------------------------------

describe('no CloudTAK display-layer rewrite, and no read of Authentik TAK attributes (Criteria 16.3, 10.5)', () => {
  it('the enrollment service source contains no clientUid/client_uid rewrite and no commonName rewrite', () => {
    const enrollmentServiceSource = fs.readFileSync(
      path.join(REPO_ROOT, 'server', 'services', 'DeviceEnrollmentService.js'),
      'utf8'
    );

    // This feature never reads or writes clientUid/client_uid at all --
    // it has no business with TAK Server certificate inventory rows.
    expect(enrollmentServiceSource).not.toMatch(/clientUid|client_uid/);
    expect(enrollmentServiceSource).not.toMatch(/commonName|Common_Name/i);
  });

  it('no non-test server file rewrites, masks or filters a clientUid or a certificate Common_Name for display purposes', () => {
    // Repo-wide structural check: scan every non-test server/ source file
    // for a function/variable name that suggests a display-layer rewrite
    // of a CloudTAK identifier, per Criterion 16.3's prohibition. This is
    // deliberately broad (name-based, not behavioural) because the
    // criterion is about ABSENCE -- there being no such mechanism at all.
    const suspiciousNamePattern = /(rewrite|mask|redact|sanitize|filter)(Client ?Uid|Common ?Name)/i;

    function walk(dir, out) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, out);
        } else if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
          out.push(fullPath);
        }
      }
    }

    const serverFiles = [];
    walk(path.join(REPO_ROOT, 'server'), serverFiles);

    // Anti-vacuity: the scan must have found a plausible number of files.
    expect(serverFiles.length).toBeGreaterThan(50);

    const offenders = serverFiles.filter((filePath) =>
      suspiciousNamePattern.test(fs.readFileSync(filePath, 'utf8'))
    );

    expect(offenders).toEqual([]);
  });

  it("the enrollment builder never reads a response field named 'attributes' on any Authentik token/key-fetch call, and takAttributes is derived only from local columns/services", () => {
    const enrollmentServiceSource = fs.readFileSync(
      path.join(REPO_ROOT, 'server', 'services', 'DeviceEnrollmentService.js'),
      'utf8'
    );

    // No read of an Authentik response's .attributes.takRole/takCallsign/
    // takColor anywhere in this file.
    expect(enrollmentServiceSource).not.toMatch(/attributes\.takRole/);
    expect(enrollmentServiceSource).not.toMatch(/attributes\.takCallsign/);
    expect(enrollmentServiceSource).not.toMatch(/attributes\.takColor/);

    // Positive confirmation that takAttributes IS built from the local
    // principal row and the local UserAttributesService, so the negative
    // assertion above is not merely because the field is unused.
    expect(enrollmentServiceSource).toMatch(/principal\.tak_role/);
    expect(enrollmentServiceSource).toMatch(/UserAttributesService\.generateCallsign/);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5.10: GET /api/devices/team/:teamId returns no email field
// for any device.
// ---------------------------------------------------------------------------

describe('GET /api/devices/team/:teamId returns no email field for any device (Criterion 5.10)', () => {
  it('listTeamDevices\'s SQL selects no email column, and its mapped output shape carries no email key', () => {
    const enrollmentServiceSource = fs.readFileSync(
      path.join(REPO_ROOT, 'server', 'services', 'DeviceEnrollmentService.js'),
      'utf8'
    );

    // Isolate the listTeamDevices method body so the assertion cannot be
    // satisfied by the absence of "email" somewhere unrelated elsewhere
    // in a 900+ line file.
    const methodMatch = enrollmentServiceSource.match(
      /static async listTeamDevices\([\s\S]*?\n {2}\}/
    );
    expect(methodMatch).not.toBeNull();
    const methodBody = methodMatch[0];

    expect(methodBody.toLowerCase()).not.toMatch(/\bemail\b/);

    // The mapped device object's key set is exactly the documented shape
    // -- no email key present.
    expect(methodBody).toMatch(/deviceUserId:/);
    expect(methodBody).toMatch(/username:/);
    expect(methodBody).toMatch(/deviceLabel:/);
    expect(methodBody).toMatch(/liveCertificateCount:/);
  });
});
