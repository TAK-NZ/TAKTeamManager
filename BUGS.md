# Bug / Issue Tracker

Running log of issues found during manual testing, outside the formal `.kiro/specs/` workflow.
For anything requiring root-cause investigation before a fix is obvious, promote it to a proper
bugfix spec under `.kiro/specs/` instead of just fixing it inline here.

Status values: `open`, `partially fixed`, `fixed`, `needs-info`.

Statuses were re-verified against actual code as of this audit. They were stale in BOTH directions:
BUG-027 was already implemented but still marked `open`; BUG-011/BUG-012 understated shipped progress; parts of
BUG-014's and NOTE-002's descriptions no longer matched the code. Five entries then marked `fixed` (BUG-015,
BUG-019, BUG-021, BUG-022, BUG-023) were spot-checked and confirmed still fixed, with no regressions — they are
now archived rather than carried in full. NOTE-002 already absorbed the content of the standalone
"Correction to NOTE-002" section, so that section has been dropped as redundant.

This file lists only live work: every entry below is `open` or `partially fixed`. Resolved entries are kept as
an id-and-title index under "Resolved (archived)" at the end of the file.

---

## Follow-ups / not yet fixed

## NOTE-001: No `app.set('trust proxy', ...)` in `server/index.js`
- **Where:** `server/index.js`
- **Issue:** Behind a real load balancer/reverse proxy (the intended ECS Fargate production topology), `req.ip` will resolve to the LB's internal IP for every request, collapsing all `req.ip`-keyed rate limiters (`authLimiter`, `requestAccessLimiter`, etc.) onto a single shared bucket. Also affects `helmet`'s HSTS behavior, which relies on correctly detecting HTTPS via `X-Forwarded-Proto`.
- **Severity:** major, production-only
- **Status:** fixed — `server/config/trustProxy.js`'s `getTrustProxyHops()` reads a new `TRUSTED_PROXY_HOPS` env var (documented in `.env.example`, default `0`) and `server/index.js` now calls `app.set('trust proxy', getTrustProxyHops())` before any middleware/route mount. Default `0` (trust nothing) leaves local/dev/test behavior unchanged today. Deliberately a hop COUNT, never `true` — `true` would trust an attacker-forged `X-Forwarded-For` prefix and defeat every IP-keyed limiter. **Follow-up still required at CDK-stack time** (tracked in `README.md`'s new "When the CDK stack for the ALB is built" section): set `TRUSTED_PROXY_HOPS=1` in the production environment once the ALB exists, and restrict the ECS task's security group to accept inbound traffic only from the ALB's security group — the hop count alone doesn't help if a request can reach the task directly and forge the header itself. Covered by `server/config/trustProxy.test.js`, including an integration test proving a forged `X-Forwarded-For` prefix is ignored once hops=1.

## NOTE-002: Dead `localStorage.removeItem('token')` remains in `Layout.jsx`'s logout path
- **Where:** `client/src/components/Layout.jsx`, `handleLogout`'s `finally` block
- **Issue:** Narrowed and corrected on re-verification. `Dashboard.jsx` and `Admin.jsx` are now confirmed clean — the only `localStorage`/`Authorization: Bearer` mentions left in them are explanatory comments, not code. The original entry's claim that `Layout.jsx` reads `localStorage.getItem('token')` and sends an `Authorization: Bearer ...` header was **wrong** — it never did either. What actually remains is a single dead `localStorage.removeItem('token')` in `handleLogout`'s `finally` (`client/src/components/Layout.jsx:124`), removing a key nothing has ever written. Harmless, just misleading.
- **Severity:** trivial (one-line cleanup, no functional impact)
- **Status:** open

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
- **Actual (three separate problems — the third identified on re-verification):**
  1. **No client UI at all** — no document listing/signing page, no gate screen. (Still open — tracked separately as future client work, not fixed here.)
  2. **Functional bug, not just missing UI:** `requireCurrentAgreement` is mounted globally in `server/index.js` *before* any route's own `authenticateToken` middleware runs (each route file mounts auth itself, further down the chain). At that global mount point `req.user` is never populated yet, so the middleware's own "skip if no req.user" guard fires unconditionally and calls `next()` every time. The mandatory-agreement gate **never actually blocks anyone**, in any environment — confirmed by tracing the middleware mount order in `server/index.js`, not just the isolated unit test (which manually injects `req.user` and therefore never exercises the real, broken wiring).
  3. **New hazard identified on re-verification — the criterion-2 fix turns the missing UI from a gap into a lockout risk.** The gate really does block now: `resolveUserFromRequest` exists in `server/middleware/auth.js` (exported alongside `authenticateToken`), `requireCurrentAgreement` calls it directly, it resolves from the `tak_session` cookie itself, and `cookieParser()` is mounted at `server/index.js:77` — well ahead of the gate at `server/index.js:150`. `BYPASS_ROUTES` (`server/middleware/requireCurrentAgreement.js:112`) contains exactly two entries: `POST /api/mou/:documentId/sign` and `POST /api/auth/logout`. So if a serverwide agreement were ever published, an unsigned user would get 403 on **everything else** — including `GET /api/mou/current-agreement` and `GET /api/mou/documents/:documentId` (both `authenticateToken, authorize` routes in `server/routes/mou.js`, so they are gated too — the user cannot fetch the text they are being told to sign) and `GET /api/config/public` (so the SPA bootstrap fails). The static SPA shell still loads, because `express.static(client/dist)` is mounted at `server/index.js:91`, above the gate. The result is a rendered app in which every request 403s, with no client code anywhere interpreting the `requiresSignature: true` response field (grepped: it appears only in the middleware and its own test). Only logout works.
- **Severity:** blocker for criterion 2 (the gate itself was non-functional despite being marked `[x]` and unit-tested in isolation) — now fixed; **blocker for the missing UI too**, raised from major: with a working gate and no signing UI, publishing a serverwide agreement is a total, self-inflicted lockout. **Do not publish a serverwide agreement until a signing UI exists.**
- **Status:** partially fixed — criterion 2 (functional gate) fixed: `server/middleware/auth.js`'s JWT-verify/revocation-check/user-cache-lookup logic was extracted into a shared `resolveUserFromRequest` helper (also used by `authenticateToken`), and `requireCurrentAgreement` now calls it directly to resolve the current user from the `tak_session` cookie when `req.user` isn't already set (i.e. at its global mount point), rather than depending on a downstream per-route `authenticateToken` that hasn't run yet. An unresolved/invalid session still just calls `next()` (rejecting is `authenticateToken`'s job). Criterion 1 (missing client UI) remains open, unchanged, tracked for future feature work.

## BUG-011: Requirement 29 (CSV Bulk Import) — template CSVs are not actually downloadable
- **Where:** `public/templates/user-import-template.csv`, `public/templates/team-import-template.csv`
- **Expected:** THE Repository SHALL provide a downloadable CSV template for user import and team import (Criterion 1).
- **Actual:** The files exist on disk but nothing serves them over HTTP — `express.static` in `server/index.js` only mounts `client/dist` and `UPLOADS_DIR`, never the repo-root `public/` directory, and no API route serves them either. They are unreachable by any client. Also: no client UI exists for the bulk import feature itself (no upload page).
- **Severity:** major
- **Status:** partially fixed — Criterion 1 (templates downloadable) stays **fixed**: added `app.use('/templates', express.static(path.join(__dirname, '../public/templates')))` in `server/index.js`, mirroring the existing `/uploads` static mount pattern. Not added to the Public_Route_Registry (`server/config/publicRoutes.js`), since that registry is scoped to Express router-handled routes with a `req.route` (see `permissions.registry.completeness.test.js`'s own documented exclusion of the `/uploads` static mount for the same reason) — a static-file mount has no such notion.

  **Correction:** the original "missing client upload-page UI remains open, unchanged" is now stale. `Admin.jsx` has a working **Bulk Import** tab (`activeTab === 'bulkImport'`) with a file input, an upload button calling `bulkImportAPI.importTeams(formData)`, and a real `download` link to `/templates/team-import-template.csv`. But it is **team import only**. `bulkImportAPI` in `client/src/services/api.js` exposes exactly one method, `importTeams`; there is no `importUsers`. The server's `POST /api/bulk-import/users` (`server/routes/bulkImport.js`, registry-mapped to `bulk_import:users`) has no client caller at all, and `user-import-template.csv` is served but linked from nowhere. So: **team import reachable, user import still unreachable.**

## BUG-012: Requirement 30 (Broadcast Email / Template Management) has no client UI
- **Where:** `client/src/` (missing entirely); backend at `server/routes/communications.js`, `server/services/BroadcastEmailService.js`
- **Expected:** A Global_Manager/team admin can compose and send a filtered broadcast email and edit email template wording in-app.
- **Actual:** Backend fully implemented and correctly fail-closed on authorization-check failures. Originally: zero client UI — no composer, no template editor.
- **Severity:** major
- **Status:** partially fixed — the **template-editor half is fixed**: `Admin.jsx` has an **Email Templates** tab (`activeTab === 'emailTemplates'`) wired through `communicationsAPI.listTemplates`/`getTemplate`/`updateTemplate`, plus a test-email send control. The **broadcast-composer half is still open**: `POST /api/communications/send` exists in `server/routes/communications.js` with no client caller — `communicationsAPI` in `client/src/services/api.js` has exactly four methods (`listTemplates`, `getTemplate`, `updateTemplate`, `sendTestEmail`), none of them `send`.

## BUG-014: Requirement 32 (In-App Settings) — Admin.jsx UI is non-functional and reads the wrong backend, rest is missing entirely
- **Where:** `client/src/pages/Admin.jsx`; backend at `server/routes/settings.js`
- **Expected:** A Global_Manager can manage branding, TAK color/role mappings, TAK Server credentials, and config export/import from an in-app settings page.
- **Actual:** Worse than just "missing" — `Admin.jsx`'s "Color Mappings"/"Role Descriptions" tabs look functional but are not. Sub-point status re-verified against code (the original description had gone partly stale):
  1. **Still open — and this is the blocker.** `handleSaveColor` (`client/src/pages/Admin.jsx:192`) and `handleSaveRole` (`:208`) only update local React state — both are non-`async`, contain no `await`, and touch no API wrapper at all. They are wired to the visible save buttons (`:762`, `:822`). Contrast `handleSaveConfig` (`:225`) in the same file, which is `async` and correctly `await`s `configAPI.update` — proving the omission is an oversight, not a pattern. The silent-revert data loss is real.
  2. **Still open.** `Admin.jsx` calls `configAPI.getColorMappings()` → `GET /api/config/color-mappings`, whose handler (`server/routes/config.js:33`) still builds its whole response from `process.env.TAK_COLOR_*`/`TAK_ROLE_*`. The newer `GET`/`PUT /api/settings/tak-mappings` endpoints **do** exist (`server/routes/settings.js`), do read `system_config`, and are registry-mapped under `settings:manage` — but no client code calls them (grepped `client/src` for `tak-mappings`: zero matches). `Dashboard.jsx` (and also `Teams.jsx` and `TeamDetail.jsx`) read the same legacy env-backed endpoint. So the entire migration-to-database-config effort (Requirement 32.1) remains invisible from the UI's perspective.
  3. **Now fixed** — the dead `localStorage`/`Authorization: Bearer` code in `Dashboard.jsx`/`Admin.jsx` was replaced with the shared `configAPI`/`usersAPI`/`channelsAPI`/`syncAPI` wrappers, which also fixed `Admin.jsx`'s stats cards counting a paginated array's `.length` (capped at 50) instead of `pagination.total`. See NOTE-002 for what remains; full detail in git history.
  4. **Partially fixed, 1 of 3 closed.** Config export/import now has a working **Export / Import** tab (`activeTab === 'settingsBackup'`) driven by `settingsAPI.exportSettings`/`importSettings`. **Branding (org name/logo) and TAK Server credentials still have zero client UI** despite live backends: `GET`/`PUT /api/settings/branding`, `POST /api/settings/branding/logo`, `GET`/`PUT /api/settings/tak-server`, `POST /api/settings/tak-server/cert`, `POST /api/settings/tak-server/key` — none of them has any caller in `client/src`.
- **Severity:** blocker (silent data-loss UX on the color/role tabs — an admin editing these will believe they saved, and lose the change)
- **Status:** open

---

## Individual bugs found during the Req 1-33 code audit (not missing-UI, actual logic bugs)

## BUG-026: `Users.jsx` — "Create User" and "Manage" buttons have no click handler
- **Where:** `client/src/pages/Users.jsx`
- **Expected:** Clicking "Create User" opens a create-user flow; clicking "Manage" on a user row opens that user's management view (team assignment etc. — `TeamDetail.jsx` already has an equivalent "Add Member"/"Create & Add User" flow that could be reused/linked to).
- **Actual:** Both buttons render with no `onClick` at all — clicking them does nothing, with no error and no console output. Distinct from the other bugs in this file: these are simply unfinished, not regressed.
- **Severity:** major (visible, always-present dead controls on a core admin page)
- **Status:** open — needs a design decision (standalone create-user page vs. reusing `TeamDetail.jsx`'s existing add-member dialog) before implementing; flagged rather than guessed at.

## BUG-028: Email template edits are silently never audited (type mismatch swallowed by a catch)
- **Where:** `server/routes/communications.js`, the `PUT /templates/:key` handler's audit insert
- **Expected:** An `email_template.update` row in `audit_logs` for every template edit, as `admin-settings-management`'s design claims.
- **Actual:** `audit_logs.resource_id` is declared `integer` in the baseline schema (`database/migrations/1786596755665_baseline-schema.cjs`), but the insert passes `result.rows[0].template_key` — a string. Postgres rejects the cast, the error is caught by the surrounding try/catch and only logged, and the request still returns 200. Template edits have therefore never been audited, and nothing about the response tells you so.
- **Severity:** major (audit gap on a Global_Manager-only mutation; fails silently)
- **Status:** open

## BUG-029: Callsign regeneration clobbers every affected user's TAK role
- **Where:** `server/services/userAttributes.js`, `computeCallsignAttributes` and `updateTeamUserAttributes`
- **Expected:** Regenerating callsigns after an Organisation's `callsign_name_format`/`callsign_level_selection` change updates the callsign and leaves `tak_role` alone (org-team-hierarchy Requirement 13.8).
- **Actual:** `computeCallsignAttributes` returns a hardcoded `role: 'Team Member'`, and `updateTeamUserAttributes` writes it straight into `user_cache.tak_role` for every user in the subtree (`UPDATE user_cache SET tak_callsign = $1, tak_color = $2, tak_role = $3 ...`). A fetch-merge-PATCH helper (`updateUserAttributes`) exists in the same module precisely to prevent this class of clobber, but this caller bypasses it. `users.tak_role` survives, and the sync pushes the local value back to Authentik, so Authentik self-heals and the visible symptom is a transient wrong `user_cache.tak_role` — easy to miss, which is why it survived.
- **Severity:** major (silent data corruption in the cache, subtree-wide)
- **Status:** open

## BUG-030: Two public team-listing endpoints disagree about private teams
- **Where:** `server/services/SignupFlowService.js` (`getAvailableTeams` and the submit-time re-eligibility query) vs `server/models/Team.js` (`getJoinableTeams`)
- **Expected:** An unauthenticated caller never sees a private Team, or a Team under a private ancestor, consistently across every public endpoint.
- **Actual:** `GET /api/teams/joinable` filters `t.can_join = true AND t.visibility = 'public'` **and** excludes private-ancestored teams via a recursive `NOT EXISTS`. `GET /api/requests/available-teams` never references the `visibility` column at all — its only predicates are `t.can_join = true`, the sign-up-code disjunct and the org-domain disjunct. (The one occurrence of the word "visibility" in `SignupFlowService.js` is a doc comment meaning code-gated visibility, not the column.) Both routes are in the Public_Route_Registry. So a Team with `can_join = true` and `visibility = 'private'` is hidden from one public endpoint and listed by the other, contradicting the whole-branch-hiding rule enforced in `TeamVisibilityService`.
- **Severity:** needs a decision — a genuine information leak if a private Team would ever legitimately carry `can_join = true`; harmless if that combination is never valid. Worth deciding explicitly (and then enforcing it, in a constraint or in both queries) rather than leaving it implicit.
- **Status:** open

---

## Notes on armed-but-unreachable machinery

Neither of these is a defect in something a user can reach today. Both are cases where a backend is live and
active for a feature that has no client UI, which changes the risk profile of the missing-UI entries above.

## NOTE-004: A background sweep mutates data for two features that have no UI
- **Where:** `server/services/ExpiryScheduler.js`, started unconditionally from `server/workers/syncWorker.js`
- **Issue:** `this.expiryScheduler.start()` is called with no feature-flag guard — contrast the device-management jobs a few lines below, wrapped in `if (isDeviceMgmtEnabled())`. `start()` runs one sweep immediately and then every 15 minutes by default, and each `runSweep()` calls `VendorChannelService.expireGrants()` and `DeploymentChannelService.deactivateExpired()`, which issue UPDATEs and can enqueue Authentik group-membership removals — for the two features BUG-006 and BUG-007 record as having zero client UI. The tables are empty today, so the sweeps are no-ops. But the machinery is armed: any row created by a raw API call will be expired and its Authentik membership stripped by a background process no operator can observe or explain from the app. This gives BUG-006/BUG-007 a materially different severity profile from BUG-008, which is genuinely inert.
- **Severity:** minor today, major if either feature is ever used before it has a UI
- **Status:** open

## NOTE-005: `channel:subscribe:deployment` is granted to every authenticated user for an unreachable endpoint
- **Where:** `server/config/permissions.registry.js`, `roleDefaults.authenticated_user`
- **Issue:** The identifier sits in the default grant set, so every authenticated user holds list/subscribe/unsubscribe permission on the deployment-channel endpoints (`GET /api/deployment-channels`, `POST /api/deployment-channels/:channelId/subscribe`, `.../unsubscribe`) — which have no client UI (BUG-007). Not a vulnerability: the permission is the intended one per Req 22.6/22.7. But the grant is live for a surface nobody can reach, so it will not get exercised or reviewed in practice until the UI ships.
- **Severity:** trivial (hygiene)
- **Status:** open

---

## Resolved (archived)

These entries are closed and their bodies have been removed, but the ids stay listed here for three reasons:
code comments cite BUG ids, so every number must keep resolving to the bug it was written about; ids are never
reused, so a new finding always takes the next unused number; and the full body of any archived entry is
recoverable from git history via `git log -p -- BUGS.md`. Lines marked "cited in code" are referenced from source
comments — do not prune them.

- BUG-001 — Session cookie `secure: true` hardcoded, broke login over plain HTTP
- BUG-002 — `App.jsx` never checked for an existing session cookie on load
- BUG-003 — Admin actions crashed resolving the acting user's local id
- BUG-004 — `users` upsert crashed on emailless Authentik service accounts
- BUG-005 — `FRONTEND_URL` pointed at the API port instead of the Vite dev server
- BUG-013 — Requirement 31 (Audit Log with CSV Export) had no client UI
- BUG-015 — Team admins could not add members to their own team (403 registry regression) — cited in code
- BUG-016 — `TeamMembershipService.removeUserFromTeam` could not join an external transaction — cited in code
- BUG-017 — No compensating action when a `new_account` approval failed after Authentik user creation
- BUG-018 — No startup warning when database TLS certificate validation is disabled in production — cited in code
- BUG-019 — No startup verification that the auth route module is actually mounted — cited in code
- BUG-020 — Requirement 12 Criterion 5 integration tests did not exist despite the task being marked done — cited in code
- BUG-021 — `GET /api/audit-logs` returned 400 for the Audit Log page's empty-filter default
- BUG-022 — Admin Site Content saves threw 500 (Authentik id written into a local-id foreign key)
- BUG-023 — Same Authentik-id/local-id confusion in 6 further routes
- BUG-024 — Audit Log "User ID" column showed a raw internal database id
- BUG-025 — `/api/users/me` made 1+N sequential Authentik calls on every Dashboard load
- BUG-027 — `TeamDetail.jsx` "Add Admin" button had no click handler
- NOTE-003 — Production-hardening work was uncommitted (since committed and pushed)
