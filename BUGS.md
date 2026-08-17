# Bug / Issue Tracker

Running log of issues found during manual testing, outside the formal `.kiro/specs/` workflow.
For anything requiring root-cause investigation before a fix is obvious, promote it to a proper
bugfix spec under `.kiro/specs/` instead of just fixing it inline here.

Status values: `open`, `fixed`, `needs-info`.

---

## BUG-001: Session cookie `secure: true` hardcoded, breaks login over plain HTTP
- **Where:** `server/routes/auth.js`, `getSessionCookieOptions()`
- **Expected:** Logging in via `/api/auth/sso` over `http://` (local/dev testing) results in an authenticated session.
- **Actual:** `tak_session` cookie set with hardcoded `secure: true`; browsers silently drop `Secure` cookies over plain HTTP, so the session never persists.
- **Severity:** blocker (dev/test only — not an issue once served over real HTTPS in production)
- **Status:** fixed — `secure` is now `process.env.NODE_ENV === 'production'`.

## BUG-002: `App.jsx` never checks for an existing session cookie on load
- **Where:** `client/src/App.jsx`
- **Expected:** After a successful OAuth callback (cookie set, redirected to `/dashboard`), the app shows the authenticated dashboard.
- **Actual:** Startup logic only checked a dead `?token=` URL param / `localStorage` token (leftover from a pre-cookie auth model). Since the server never produces either anymore, the app always fell through to the logged-out Login screen regardless of a valid session cookie.
- **Severity:** blocker
- **Status:** fixed — mount effect now calls `authAPI.getProfile()` unconditionally first, falling back to auto-login only on failure.

## BUG-003: Admin actions crash with `Cannot read properties of undefined (reading 'id')`
- **Where:** `server/routes/globalChannels.js` (`POST /api/global-channels/sync-existing` and ~7 other routes), `server/routes/users.js` (2 more)
- **Expected:** Any admin action (sync channels, create/update/delete BCH/region channels, etc.) resolves the acting user's local id and succeeds.
- **Actual:** These routes do `SELECT id FROM users WHERE authentik_user_id = req.user.id`, but the `users` table was only ever populated by explicit provisioning flows (create-and-add, access-request approval, bulk import, device enrollment) — never by the periodic Authentik sync. Any user who only ever logged in via SSO (never explicitly provisioned) has zero rows in `users`, so the lookup returns nothing and `.id` throws.
- **Severity:** blocker
- **Status:** fixed — `authentikSync.js`'s `syncSingleUser` now also upserts a `users` row (keyed on `authentik_user_id`) alongside the existing `user_cache` upsert.

## BUG-004: `users` upsert crashes on emailless Authentik service accounts
- **Where:** `server/services/authentikSync.js` (regression introduced by the BUG-003 fix)
- **Expected:** Sync completes cleanly for all Authentik users, including non-human service/API accounts (`etl-*`, `ak-outpost-*`, etc.).
- **Actual:** `users.email` is `UNIQUE NOT NULL`; service accounts have no email in Authentik, so the first one to sync claims the empty-string email and every subsequent emailless account fails with a duplicate-key error.
- **Severity:** minor (sync still completes overall; only affects non-human accounts, which don't need a `users` row anyway)
- **Status:** fixed — `users` upsert is now skipped when `user.email` is falsy; `user_cache` upsert is unaffected.

## BUG-005: `.env`/`FRONTEND_URL` pointed at the API port instead of the Vite dev server
- **Where:** `.env`
- **Expected:** OAuth callback redirect lands on the actual client app.
- **Actual:** `FRONTEND_URL=http://44.229.3.37:3000` (API port, no client build there in dev) caused `ENOENT: /app/client/dist/index.html` on every redirect.
- **Severity:** blocker (local dev only)
- **Status:** fixed — `FRONTEND_URL` now points at `:5173` (Vite dev server) in local dev; in production this and `APP_URL` should be the same single HTTPS origin (see NOTE-001).

---

## Follow-ups / not yet fixed

## NOTE-001: No `app.set('trust proxy', ...)` in `server/index.js`
- **Where:** `server/index.js`
- **Issue:** Behind a real load balancer/reverse proxy (the intended ECS Fargate production topology), `req.ip` will resolve to the LB's internal IP for every request, collapsing all `req.ip`-keyed rate limiters (`authLimiter`, `requestAccessLimiter`, etc.) onto a single shared bucket. Also affects `helmet`'s HSTS behavior, which relies on correctly detecting HTTPS via `X-Forwarded-Proto`.
- **Severity:** major, production-only
- **Status:** open — flagged to user, not yet fixed (deferred pending decision on when the LB layer is actually stood up).

## NOTE-002: Dead `localStorage`/`Authorization: Bearer` code remains in several client pages
- **Where:** `client/src/pages/Dashboard.jsx`, `client/src/pages/Admin.jsx`, `client/src/components/Layout.jsx`
- **Issue:** These still read `localStorage.getItem('token')` and send `Authorization: Bearer ...` headers, left over from the pre-cookie auth model. Currently harmless (the server's `authenticateToken` middleware only ever reads the `tak_session` cookie, and these calls use relative same-origin paths so the cookie is sent automatically regardless) but it's dead/misleading code.
- **Severity:** minor (cleanup only, no functional impact)
- **Status:** open

## NOTE-003: All production-hardening work (64 tasks) is uncommitted
- **Where:** whole repo
- **Issue:** `git status` shows ~40 modified files and ~90 untracked new files (new services, middleware, tests, migrations, etc.) — none of it committed. It only exists in this working directory. No durable record, nothing deployable/reviewable until committed.
- **Severity:** major (process risk, not a functional bug)
- **Status:** fixed — committed as `d5477e8` on `main` (195 files). Still needs to be pushed to a remote branch/PR when the user is ready.

---

## Full requirements.md audit (production-hardening spec, Req 1-33)

Systematic re-verification of every acceptance criterion in `.kiro/specs/production-hardening/requirements.md`
against actual code, since `tasks.md` marks all 64 tasks `[x]` but that does not by itself confirm correct or
complete implementation. Focused especially on client-side (React) coverage, since a backend endpoint existing
does not mean a feature is usable through the actual web app.

### Systemic issue: most new features have zero client UI

Despite full backend implementations (routes, services, migrations, tests), the following requirements have
**NO corresponding page/component/route anywhere in `client/src`** — confirmed via exhaustive grep across
`client/src/pages`, `client/src/components`, and `client/src/App.jsx`'s route table. Each of these features is
completely unusable by an actual user through the web app today; the only way to exercise them is a raw API
call (e.g. curl/Postman) with a valid session cookie.

## BUG-006: Requirement 21 (Vendor Time-Limited Channel Access) has no client UI
- **Where:** `client/src/` (missing entirely); backend at `server/routes/vendorChannels.js`, `server/services/VendorChannelService.js`
- **Expected:** A Global_Manager can create the Vendor_Channel, flag a user as vendor, and grant/revoke channel access from the web app — this is one of the three headline "Undelivered Documented Features" the spec's own introduction was written to close.
- **Actual:** Backend fully implemented and correctly passes all 12 acceptance criteria (singleton enforcement, audit logging, expiry sweep). Zero client UI. Grepped `client/src` for `vendor|Vendor|VND|isVendor` — no matches.
- **Severity:** major (documented feature still inaccessible to end users)
- **Status:** open

## BUG-007: Requirement 22 (Deployment-Scoped Overseas Channel Self-Service) has no client UI
- **Where:** `client/src/` (missing entirely); backend at `server/routes/deploymentChannels.js`, `server/services/DeploymentChannelService.js`
- **Expected:** A Deployment_Coordinator (any Global_Manager) can create a deployment/domestic-mission channel, and any user can self-service subscribe/unsubscribe — the second of the three headline "Undelivered Documented Features."
- **Actual:** Backend fully implemented (naming validation, transactional create+enqueue, self-service subscribe/unsubscribe, `deactivateExpired()`). Zero client UI. Grepped for `deployment|Deployment|Overseas` — no matches anywhere in `client/src`.
- **Severity:** major (documented feature still inaccessible to end users)
- **Status:** open

## BUG-008: Requirement 23 (Channel Creation Approval Workflow) has no client UI
- **Where:** `client/src/` (missing entirely); backend at `server/routes/channelRequests.js`, `server/services/ChannelRequestService.js`
- **Expected:** A team admin can submit a channel request, and an authorized approver (Global_Manager or parent-team admin) can approve/deny it — the third headline "Undelivered Documented Feature."
- **Actual:** Backend fully implemented, including the transactional approve-with-rollback pattern. Zero client UI — no page/component/route for submitting, listing, approving, or denying channel requests.
- **Severity:** major (documented feature still inaccessible to end users)
- **Status:** open

## BUG-009: Requirement 27 (Team-Owned Device Enrollment) has no client UI
- **Where:** `client/src/` (missing entirely); backend at `server/routes/devices.js`, `server/services/DeviceEnrollmentService.js`
- **Expected:** A team admin can create a device account and view/regenerate its ATAK/iTAK enrollment QR code from the web app.
- **Actual:** Backend fully implemented (synthetic non-deliverable email, suppressed verification email, 30-minute token cap, correct QR URI scheme). No page exists to create a device or display its QR code.
- **Severity:** major
- **Status:** open

## BUG-010: Requirement 28 (MOU/Document Management) has no client UI, AND the login-time agreement gate is a no-op bug
- **Where:** `client/src/` (missing entirely); `server/middleware/requireCurrentAgreement.js`, mounted in `server/index.js`
- **Expected:** A Global_Manager can publish/designate a mandatory user agreement; every user without a current signature is blocked from all routes except sign/logout until they sign.
- **Actual (two separate problems):**
  1. **No client UI at all** — no document listing/signing page, no gate screen. (Still open — tracked separately as future client work, not fixed here.)
  2. **Functional bug, not just missing UI:** `requireCurrentAgreement` is mounted globally in `server/index.js` *before* any route's own `authenticateToken` middleware runs (each route file mounts auth itself, further down the chain). At that global mount point `req.user` is never populated yet, so the middleware's own "skip if no req.user" guard fires unconditionally and calls `next()` every time. The mandatory-agreement gate **never actually blocks anyone**, in any environment — confirmed by tracing the middleware mount order in `server/index.js`, not just the isolated unit test (which manually injects `req.user` and therefore never exercises the real, broken wiring).
- **Severity:** blocker for criterion 2 (the gate itself is non-functional despite being marked `[x]` and unit-tested in isolation); major for the missing UI
- **Status:** partially fixed — criterion 2 (functional gate) fixed: `server/middleware/auth.js`'s JWT-verify/revocation-check/user-cache-lookup logic was extracted into a shared `resolveUserFromRequest` helper (also used by `authenticateToken`), and `requireCurrentAgreement` now calls it directly to resolve the current user from the `tak_session` cookie when `req.user` isn't already set (i.e. at its global mount point), rather than depending on a downstream per-route `authenticateToken` that hasn't run yet. An unresolved/invalid session still just calls `next()` (rejecting is `authenticateToken`'s job). Criterion 1 (missing client UI) remains open, unchanged, tracked for future feature work.

## BUG-011: Requirement 29 (CSV Bulk Import) — template CSVs are not actually downloadable
- **Where:** `public/templates/user-import-template.csv`, `public/templates/team-import-template.csv`
- **Expected:** THE Repository SHALL provide a downloadable CSV template for user import and team import (Criterion 1).
- **Actual:** The files exist on disk but nothing serves them over HTTP — `express.static` in `server/index.js` only mounts `client/dist` and `UPLOADS_DIR`, never the repo-root `public/` directory, and no API route serves them either. They are unreachable by any client. Also: no client UI exists for the bulk import feature itself (no upload page).
- **Severity:** major
- **Status:** fixed (Criterion 1 only) — added `app.use('/templates', express.static(path.join(__dirname, '../public/templates')))` in `server/index.js`, mirroring the existing `/uploads` static mount pattern. Not added to the Public_Route_Registry (`server/config/publicRoutes.js`), since that registry is scoped to Express router-handled routes with a `req.route` (see `permissions.registry.completeness.test.js`'s own documented exclusion of the `/uploads` static mount for the same reason) — a static-file mount has no such notion. The missing client upload-page UI remains open, unchanged.

## BUG-012: Requirement 30 (Broadcast Email / Template Management) has no client UI
- **Where:** `client/src/` (missing entirely); backend at `server/routes/communications.js`, `server/services/BroadcastEmailService.js`
- **Expected:** A Global_Manager/team admin can compose and send a filtered broadcast email and edit email template wording in-app.
- **Actual:** Backend fully implemented and correctly fail-closed on authorization-check failures. Zero client UI — no composer, no template editor.
- **Severity:** major
- **Status:** open

## BUG-013: Requirement 31 (Audit Log with CSV Export) has no client UI
- **Where:** `client/src/` (missing entirely); backend at `server/routes/auditLogs.js`
- **Expected:** A Global_Manager can search, filter, and export the audit log from the web app (this is the specific gap the user originally flagged).
- **Actual:** Backend fully implemented (filtering, pagination, CSV streaming export, correctly Global_Manager-gated, retention-window-aware). Zero client UI anywhere.
- **Severity:** major
- **Status:** fixed — new `client/src/pages/AuditLogs.jsx` page at `/audit-logs`, gated on `user.is_global_manager` with a matching nav entry, built via a dedicated design-first spec at `.kiro/specs/audit-log-ui/`. Adds filter form (actor, action, resource type, team, date range), Apply/Clear Filters, a paginated results table, an Export CSV action (direct browser navigation to the export endpoint), and error handling that preserves stale results on a failed refetch. No backend changes — integrates against the existing `server/routes/auditLogs.js` as-is.

## BUG-014: Requirement 32 (In-App Settings) — Admin.jsx UI is non-functional and reads the wrong backend, rest is missing entirely
- **Where:** `client/src/pages/Admin.jsx`; backend at `server/routes/settings.js`
- **Expected:** A Global_Manager can manage branding, TAK color/role mappings, TAK Server credentials, and config export/import from an in-app settings page.
- **Actual:** Worse than just "missing" — `Admin.jsx`'s "Color Mappings"/"Role Descriptions" tabs look functional but are not:
  1. `handleSaveColor`/`handleSaveRole` only update local React state — no API call is ever made. An edit appears to save, then silently reverts on refresh.
  2. Even the *read* path calls the legacy `GET /api/config/color-mappings` (`server/routes/config.js`), which still reads from `process.env.TAK_COLOR_*` env vars — never updated to use the new `system_config` rows created by this spec. The correct new endpoint (`GET`/`PUT /api/settings/tak-mappings`) is never called by any client code, so the entire migration-to-database-config effort (Requirement 32.1) is invisible/ineffective from the UI's perspective.
  3. `Admin.jsx` (and `Dashboard.jsx`) still send `Authorization: Bearer ${localStorage.getItem('token')}` — dead code, since nothing writes a token to `localStorage` anymore (see NOTE-002) and the server never reads that header.
  4. Branding (org name/logo), TAK Server credentials, and config export/import have **zero** client UI — no page, route, or API wrapper at all. Only the "Site Content" tab (the `request_access_*` fields) is genuinely functional end-to-end.
- **Severity:** blocker (silent data-loss UX on the color/role tabs — an admin editing these will believe they saved, and lose the change)
- **Status:** open

---

## Individual bugs found during the Req 1-33 code audit (not missing-UI, actual logic bugs)

## BUG-015: Team admins cannot add members to their own team (403 regression from Permission_Registry migration)
- **Where:** `server/config/permissions.registry.js`, `server/middleware/authorize.js`
- **Expected:** `POST /api/teams/:teamId/members` should succeed for a team admin adding a member to their own team (per `Team.isAdmin`), or a Global_Manager, per Requirement 4 Criterion 1's authorization pattern (already correctly implemented elsewhere, e.g. sub-team creation).
- **Actual:** The registry requires permission `team:members:add` for this route, but `authorize.js` has no row-scoped resolver for `team:members:add` at all, and it's absent from `roleDefaults.authenticated_user`. Every non-global-manager team admin gets HTTP 403 before the route's own `requireTeamAdmin` middleware (still chained after `authorize`, but now dead code — it's never reached) ever runs. Confirmed live with a throwaway supertest reproduction (a legitimate team admin with `Team.isAdmin` returning `true` still gets 403).
- **Severity:** blocker (functional regression — team admins lost a core capability they had before the Requirement 24 Permission_Registry migration)
- **Status:** fixed — added a `team:members:add` entry to `authorize.js`'s `rowScopedResolvers` map, mirroring `team:update` exactly (Global_Manager OR `Team.isAdmin(req.params.teamId, req.user.userId)`).

## BUG-016: `TeamMembershipService.removeUserFromTeam` cannot participate in an external transaction
- **Where:** `server/services/TeamMembershipService.js`
- **Expected:** Per Requirement 17 Criterion 5, both `addUserToTeam` AND `removeUserFromTeam` should accept an already-open transactional client so a caller (e.g. a future approval/bulk-operation flow) can make the membership change atomic with other writes.
- **Actual:** Only `addUserToTeam` was built with an optional `externalClient` parameter. `removeUserFromTeam` always calls `pool.connect()` itself and manages its own transaction — no caller can currently make a team removal atomic with anything else.
- **Severity:** minor (no current caller is broken by this, but it's an incomplete implementation of an explicit requirement, and blocks any future feature that needs an atomic "remove from team + X" operation)
- **Status:** fixed — `removeUserFromTeam` now accepts an optional `externalClient` parameter (appended after `createdBy`, defaulting to `null`), mirroring `addUserToTeam`'s `ownsTransaction` pattern: `BEGIN`/`COMMIT`/`ROLLBACK`/`client.release()` are only issued when this method owns the transaction. Existing callers (`server/routes/users.js`) are unaffected since the new parameter is optional and defaults to the prior behavior.

## BUG-017: No compensating action when a `new_account` access-request approval fails after the Authentik user is created
- **Where:** `server/services/RequestApprovalService.js`, `approveRequest`'s catch block
- **Expected:** Per Requirement 17 Criterion 2 (which Requirement 18 Criterion 7 relies on), a post-Authentik-creation local-transaction failure should trigger a synchronous compensating delete of the newly created Authentik user, falling back to an enqueued `cleanup_orphaned_authentik_user` Sync_Operation if that delete itself fails.
- **Actual:** The catch block only logs `{authentikUserId, failedStep: 'local_transaction', compensationOutcome: 'not_attempted'}` — no delete is attempted, no cleanup Sync_Operation is enqueued. An orphaned Authentik user is left behind with no automated remediation path.
- **Severity:** major (silent data/identity drift between Authentik and the local DB on this failure path)
- **Status:** fixed — `approveRequest`'s catch block now mirrors the exact synchronous-delete-then-queued-fallback pattern already built for `POST /api/users/create-and-add` (`server/routes/users.js`, task 36.2): it attempts a synchronous Authentik user delete first, falls back to enqueueing a `cleanup_orphaned_authentik_user` Sync_Operation via `EventPublisher.publishOperation` if that delete fails, and logs `{authentikUserId, failedStep, compensationOutcome}` with `compensationOutcome` now one of `deleted_synchronously` / `cleanup_operation_queued` / `compensation_failed` instead of always `not_attempted`. Only applies when `newAccountAuthentikUser` is truthy (new_account requests); other branches unchanged.

## BUG-018: No startup warning when TLS certificate validation is disabled in production
- **Where:** `server/config/configValidator.js`, `server/config/database.js`
- **Expected:** Per Requirement 15 Criterion 5, if `NODE_ENV=production` and the DB pool sets `ssl: { rejectUnauthorized: false }` (which `server/config/database.js` does, unconditionally, whenever `NODE_ENV=production`), a warning identifying that TLS certificate validation is disabled should be logged at startup.
- **Actual:** No such check exists anywhere in `configValidator.js`. Grepped the whole `server/` tree for `rejectUnauthorized`/"TLS certificate validation" — only the one unconditional setter in `database.js`, no warning logic at all.
- **Severity:** minor (silent security-relevant misconfiguration — an operator running production with an unverified DB TLS cert gets no signal)
- **Status:** fixed — `validateConfig` now calls `warnIfDatabaseTlsCertificateValidationDisabled`, which logs a `logger.warn` (never a hard failure) whenever `NODE_ENV=production`, mirroring `database.js`'s exact unconditional condition. `server/workers/syncWorker.js`'s dedicated pool sets no `ssl` option at all today, so there was no second call site to mirror there; the single `NODE_ENV`-driven check still runs at Sync_Worker startup since it also calls `validateConfig`.

## BUG-019: No startup/health verification that the OAuth2 auth route module is actually mounted
- **Where:** `server/config/configValidator.js`, `server/routes/health.js`
- **Expected:** Per Requirement 1 Criterion 5, correct `APP_URL`/`FRONTEND_URL` configuration alone should not be treated as sufficient evidence that auth is functional — there should be an explicit startup or health check confirming the `/api/auth` route module is mounted and reachable.
- **Actual:** No such check exists. `configValidator.js` validates env var values only; `/health`, `/health/ready`, `/health/live` check DB/Authentik connectivity, never the app's own route table.
- **Severity:** minor (a correctly-configured-but-somehow-unmounted auth route would silently pass every existing health check)
- **Status:** fixed — added `assertAuthRouteMounted` to `configValidator.js`, which walks `app._router.stack` (same pattern as `permissions.registry.completeness.test.js`'s router walker) to confirm a layer is mounted at `/api/auth`, logging a descriptive error and calling `process.exit(1)` if not. Called from `server/index.js` after every route is mounted but before `app.listen()`.

## BUG-020: Requirement 12 Criterion 5 — described integration tests don't exist despite task marked complete
- **Where:** task 58.6 in `tasks.md` (marked `[x]`); no corresponding test file
- **Expected:** Integration tests against a dedicated, reset-before-each-run test database for team creation (success/validation-failure), membership add/remove (success/not-found), and access-request approve/deny (success/already-processed).
- **Actual:** No such tests exist anywhere. Existing real-DB `*.integration.test.js` files cover health, audit logs, the channel 3-limit race, `TeamMembershipService` round-trip, retention cleanup, expiry sweep, and schema consistency — but none exercise `POST /api/teams`, a membership "not-found" case, or `RequestApprovalService.approveRequest`/`denyRequest` against a real DB. `server/routes/teams.test.js` and `requests.test.js` are unit tests with a fully mocked `pool`/`Team`.
- **Severity:** minor (test-coverage gap, not a runtime bug — but the task was marked done incorrectly)
- **Status:** fixed — added `server/routes/teams.integration.test.js` (`POST /api/teams` success/validation-failure/authorization-failure; `POST /api/teams/:teamId/members` success and not-found for both target user and team) and `server/routes/requests.approval.integration.test.js` (`POST /api/requests/:requestId/approve`/`deny` success and already-processed-request rejection), both run via `supertest` against the real, mounted Express routers and a real Postgres test database (`tak_migration_test_501`, same connection convention as every other `*.integration.test.js` file in this repo). All 11 new tests pass against that database; verified no leftover rows remain afterward and that the pre-existing mocked unit test files (`teams.test.js`, `RequestApprovalService.test.js`) still pass unmodified.

## BUG-021: `GET /api/audit-logs` returned a 400 for the Audit Log page's default "Apply Filters" click (empty fields)
- **Where:** `client/src/services/api.js`, `auditLogsAPI.getAuditLogs`/`buildExportUrl`
- **Expected:** Clicking "Apply Filters" with every field left blank returns the full unfiltered result set.
- **Actual:** `getAuditLogs` passed `{...filters, ...pageParams}` straight to axios's `params`. Axios serializes an empty string as `key=` (present-but-empty), not omitted. The server's `express-validator` `.optional()` chains only skip validation when a field is fully ABSENT from the querystring; a present-but-empty value still runs `.isInt()`/`.isISO8601()` and fails, producing 400. The design doc's claim that "axios's params serialization omits empty-string values" was never actually tested and was false.
- **Severity:** blocker (the page's primary action was broken on first use)
- **Status:** fixed — added a shared `stripEmptyParams` helper (removes `''`/`null`/`undefined` values) used by both `getAuditLogs` and `buildExportUrl` (the latter already had equivalent inline filtering; now shares the same helper).

## BUG-022: Admin → Site Content tab — every save throws 500, no edits ever persist
- **Where:** `server/routes/config.js`, `PUT /:key`
- **Expected:** Editing and saving any Site Content field (`request_access_title`/`subtitle`/`footer`) persists the change.
- **Actual:** `SiteConfig.update(key, value, req.user.id)` passed the Authentik id (`req.user.id`) into `site_config.updated_by`, which is a foreign key to the LOCAL `users.id` (`req.user.userId`). No local user row exists with that id (Authentik ids and local ids are different, unrelated numbering — confirmed against the live DB: admin's Authentik id is 14, local id is 2), so every save violates the FK constraint and throws, caught and surfaced as a generic 500.
- **Severity:** blocker
- **Status:** fixed — changed to `req.user.userId`.

## BUG-023: Same Authentik-id/local-id confusion as BUG-015, present in 6 more places
- **Where:** `server/routes/users.js` (`GET /me`'s channel-membership lookup, add/remove-from-team requester-id lookups), `server/routes/requests.js` (pending/approve/deny), `server/routes/teams.js` (`GET /my-teams` for non-admin users), `server/routes/globalChannels.js` (create/update BCH+region, get credentials, sync-existing, delete — 6 call sites querying `SELECT id FROM users WHERE authentik_user_id = req.user.id` where `req.user.userId` was already available and correct)
- **Expected:** Every route resolving "the acting user's local id" uses `req.user.userId` (already resolved by `authenticateToken` — see `server/middleware/auth.js`), not `req.user.id` (the Authentik id) or a redundant DB round-trip to convert one to the other.
- **Actual:** Same bug class as BUG-015/BUG-022, just not yet swept across the whole codebase. Several of these silently returned wrong/no data (e.g. `channel_memberships`/`team_memberships` lookups keyed on the wrong id space return zero rows rather than throwing, so the bug manifested as "empty list" rather than a crash) rather than a hard error, making it easy to miss in ad-hoc testing.
- **Severity:** major (data-correctness bug, not just crashes — some of these silently returned incomplete/empty data rather than erroring)
- **Status:** fixed — all 6 sites switched to `req.user.userId` directly; the `globalChannels.js` sites' now-redundant `SELECT id FROM users WHERE authentik_user_id = $1` lookups were removed entirely (no lookup needed once using the already-resolved local id), which also let the now-unused `pool` import be dropped from that file.

## BUG-024: Audit Log "User ID" column showed a raw internal database id instead of a username
- **Where:** `client/src/pages/AuditLogs.jsx`, `server/routes/auditLogs.js`
- **Expected:** An admin reviewing the audit log sees the acting user's username/email, not an opaque internal id they'd have to look up separately.
- **Actual:** The column rendered `row.user_id` verbatim (a bare integer, the local `users.id` — not even the Authentik id). The design doc explicitly called for "a best-effort resolved username" but the implementation shipped without it, with an inline comment rationalizing the omission as intentional.
- **Severity:** minor (usability, not a crash) — but reinforces the broader point that internal ids (Authentik or local) are implementation details and must never be surfaced to a human reviewing the app.
- **Status:** fixed — `GET /api/audit-logs` now `LEFT JOIN`s `users` on `user_id` and returns `username`/`email`; the client renders `username || email || user_id || '—'`, falling back to the numeric id only if the actor's user row was later deleted (LEFT JOIN keeps the row, just with null username/email in that case).

## BUG-025: Dashboard's `/api/users/me` made 1+N sequential Authentik HTTP calls on every load
- **Where:** `server/routes/users.js`, `GET /me`
- **Expected:** Loading the Dashboard should be fast — it only needs locally-cached data plus a live user/group lookup.
- **Actual:** After fetching the user's own record from Authentik, the route resolved each of the user's group names with a separate, sequential (`for` loop with `await` inside, not parallelized) call to Authentik's groups API — one full external HTTP round trip per group membership, all blocking the response.
- **Severity:** major (perceived performance — this was the actual server-side cause of the reported "Dashboard loads so slowly" complaint, on top of the already-fixed client-side request waterfall)
- **Status:** fixed — group name lookups now run in parallel via `Promise.all`; a failed individual group lookup still only drops that one group's name (matching prior per-group error handling) instead of serializing the whole set.

## BUG-026: `Users.jsx` — "Create User" and "Manage" buttons have no click handler
- **Where:** `client/src/pages/Users.jsx`
- **Expected:** Clicking "Create User" opens a create-user flow; clicking "Manage" on a user row opens that user's management view (team assignment etc. — `TeamDetail.jsx` already has an equivalent "Add Member"/"Create & Add User" flow that could be reused/linked to).
- **Actual:** Both buttons render with no `onClick` at all — clicking them does nothing, with no error and no console output. Distinct from the other bugs in this file: these are simply unfinished, not regressed.
- **Severity:** major (visible, always-present dead controls on a core admin page)
- **Status:** open — needs a design decision (standalone create-user page vs. reusing `TeamDetail.jsx`'s existing add-member dialog) before implementing; flagged rather than guessed at.

## BUG-027: `TeamDetail.jsx` — "Add Admin" button has no click handler
- **Where:** `client/src/pages/TeamDetail.jsx`, team header action buttons
- **Expected:** Clicking "Add Admin" opens a flow to promote an existing team member (or add a new user directly as) admin, mirroring the existing "Add Member" dialog.
- **Actual:** Button renders with no `onClick` — inert. `handleAddExistingUser`/`handleCreateNewUser` currently always add as `role: 'member'` (server-side default); there is no way to add/promote a team admin through the UI at all.
- **Severity:** major
- **Status:** open — likely fix is a `role` parameter threaded through the existing Add Member dialog/API call rather than a wholly separate flow, but needs confirming against `server/routes/teams.js`'s member-add route before implementing.

## Correction to NOTE-002
- **Where:** `client/src/pages/Dashboard.jsx`, `client/src/pages/Admin.jsx`
- **Correction:** Confirmed via code fix + build/test verification (not just re-reading) that this dead `localStorage`/`Authorization: Bearer` code was, as NOTE-002 already correctly said, harmless in practice — same-origin requests carry cookies automatically regardless of the (always-null) `Authorization` header or missing `withCredentials`. It was NOT the cause of any reported 401. Fixed anyway as cleanup: replaced with the shared `configAPI`/`usersAPI`/`channelsAPI`/`syncAPI` wrappers (added `configAPI.getColorMappings`, `syncAPI`, `usersAPI.getMe`, `channelsAPI.getDescriptions`), and fixed a real bug found in the same code path — `Admin.jsx`'s stats cards counted the paginated response array's `.length` (capped at 50) instead of `pagination.total`, silently undercounting once user/team counts exceed one page.
