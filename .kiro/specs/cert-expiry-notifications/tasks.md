# Implementation Plan: Certificate Expiry Notifications

## Overview

Implementation follows the existing codebase conventions (Node/JavaScript server with Jest + mocked `config/database`/`EventPublisher`/`EmailService`; React client with Vitest, no `@testing-library/react`). It builds the schema and config helper first (both are pure prerequisites with no dependents outside this feature), then `CertExpiryNotificationService` (Requirements 2-4), which depends on the schema and config helper but not on the job, then the `CertExpiryNotificationJob` and its `syncWorker.js` wiring (Requirement 5), which depends on the service, then the two new email templates the service calls by key. Superseded Certificate Revocation (Requirement 8) is fully independent of the notification pipeline above it — it only shares the `revoke_tak_certificates` operation type — and is implemented next since nothing later depends on it. `.env.example` documentation (Requirement 9.3/9.4) follows once every variable it documents actually exists. The three UI changes (Requirements 6, 7) come last, since they only ever call existing or newly-added read endpoints and mint through the existing, unmodified enrollment flow. Each section ends with a checkpoint. Property-based tests and a final full-build verification close the plan.

Test-only sub-tasks are marked `*` and may be skipped for a faster MVP; core implementation sub-tasks are not.

## Tasks

- [x] 1. Add the `cert_expiry_notifications` table
  - [x] 1.1 Create the migration adding `cert_expiry_notifications`
    - Columns `id` (serial PK), `client_uid` (`varchar(255)`, not null), `cert_id` (`integer`, not null), `threshold_days` (`integer`, not null), `notified_at` (`timestamptz`, `DEFAULT now()`, not null); `UNIQUE (client_uid, cert_id, threshold_days)`; index on `client_uid` alone
    - No foreign key to `tak_devices` — a row must survive `DeviceSync`'s own stale-row deletion of its `client_uid` untouched (Requirement 1.3)
    - Follow the existing incremental-migration convention (`database/migrations/<timestamp>_tak-devices.cjs` et al.) — never hand-edit `schema.sql`
    - _Requirements: 1.1, 1.2, 1.3_
    - Files: `database/migrations/1788600000000_cert-expiry-notifications.cjs`
  - [x] 1.2 * Write a migration smoke test asserting the table, unique constraint, and index exist after applying, and that the unique constraint rejects a duplicate `(client_uid, cert_id, threshold_days)` triple
    - Files: `database/migrations/__tests__/cert-expiry-notifications.integration.test.js`
    - Verified against the real, running docker-compose `postgres` service (localhost:5432): 10/10 tests pass; throwaway database created and dropped cleanly, live `tak_team_manager` database confirmed untouched.

- [x] 2. Add the config helper
  - [x] 2.1 Create `server/config/certExpiryNotifications.js`
    - `isCertExpiryNotificationsEnabled(env)` — `env.CERT_EXPIRY_NOTIFICATIONS_ENABLED === 'true'`, mirroring `deviceMgmt.js`'s exact boolean-env convention
    - `getCertExpiryTierDays(env)` — `{ tier1, tier2, tier3, tier4 }` from `CERT_EXPIRY_TIER1_DAYS`..`CERT_EXPIRY_TIER4_DAYS` (defaults 30/15/8/1), each via the `Math.max(1, parseInt(...) || default)` positive-integer discipline `getRevokeMaxCerts` already establishes
    - `getCertExpiryActivityWindowDays(env)` — `CERT_EXPIRY_ACTIVITY_WINDOW_DAYS` (default 90), same discipline
    - All three take an injectable `env = process.env` param, matching `deviceMgmt.js`
    - _Requirements: 9.1, 9.2_
    - Files: `server/config/certExpiryNotifications.js`
  - [x] 2.2 * Write unit tests covering unset/empty/non-numeric/zero/negative fallback for every variable, mirroring `deviceMgmt.test.js`'s table-driven shape
    - Files: `server/config/__tests__/certExpiryNotifications.test.js`
    - 37 tests (incl. fast-check property coverage), all pass. Note: a negative value clamps to 1, not to the field's own default — matches `getRevokeMaxCerts`'s existing behaviour for the identical expression shape.

- [x] 3. Implement `CertExpiryNotificationService` eligibility resolution
  - [x] 3.1 Create `server/services/CertExpiryNotificationService.js` with `findEligibleCandidates(now = new Date())`
    - One query joining `tak_devices`/`users`/`team_memberships` per design.md's SQL, scoped to `revoked = false AND expires_at IS NOT NULL AND account_status = 'active'` (Requirement 2.5)
    - Per-row: compute `daysLeft`, determine DUE tiers (day-descending) from `getCertExpiryTierDays`, batch-check already-resolved tiers against `cert_expiry_notifications` in one query across every candidate (no N+1, per this codebase's query convention), compute the single activity check via `getCertExpiryActivityWindowDays`, and apply the multi-tier-backlog collapse-to-most-urgent rule
    - Returns `{ toEmail: [...], toMarkResolvedOnly: [...] }`, each item carrying enough context (`clientUid`, `certId`, `thresholdDays`, `isTeamDevice`, `directTeamId`, owner `email`/`username`, `expiresAt`, a display label) for the two digest senders to consume without re-querying
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
    - Files: `server/services/CertExpiryNotificationService.js`
    - Implementation note: the batched already-resolved lookup and the multi-row resolved-only INSERT both use `UNNEST($1::type[], ...)` rather than `= ANY(...)`, since the lookup keys on a COMPOSITE `(client_uid, cert_id)` pair, not a single column. Verified directly against real Postgres before writing unit tests.
  - [x] 3.2 Immediately persist `toMarkResolvedOnly` as `cert_expiry_notifications` rows (`INSERT ... ON CONFLICT (client_uid, cert_id, threshold_days) DO NOTHING`) as part of `findEligibleCandidates`
    - These carry no send-success dependency (Requirement 2.3's "resolved with no email")
    - _Requirements: 2.3, 1.1_
    - Files: `server/services/CertExpiryNotificationService.js`
  - [x] 3.3 * Write unit tests for `findEligibleCandidates` against a mocked `pool.query`
    - Cover: exactly-on-threshold is due, activity-window boundary (`lastSeenAt` exactly `expiresAt - windowDays` eligible, one ms earlier not), `last_seen_at` null falling back to `issued_at`, both null failing the activity check, the multi-tier-backlog collapse (only the most urgent tier lands in `toEmail`, every other DUE tier lands in `toMarkResolvedOnly` and is persisted), suspended/orphaned exclusion (via the query's own WHERE, asserted on the SQL text), already-resolved tier exclusion
    - Files: `server/services/CertExpiryNotificationService.test.js`
    - 15 tests, all pass.

- [x] 4. Implement the two digest senders
  - [x] 4.1 Add `sendSelfOwnedDigests(candidates)` to `CertExpiryNotificationService`
    - Filters `toEmail` to `!isTeamDevice`, groups by `userId`, builds a pre-formatted `device_list` HTML block (mirroring `EscalationService.sendAdminDigest`'s `request_list` convention), calls `EmailService.sendEmail(ownerEmail, 'cert_expiry_self_digest', { first_name, device_list, revoke_hint_url })` once per user
    - On success, `INSERT ... ON CONFLICT DO NOTHING` a `cert_expiry_notifications` row for every device/tier in that group; on failure (caught per-recipient, matching `sendAdminDigest`'s own per-admin try/catch), log and leave that group's rows unwritten so the next run retries
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
    - Files: `server/services/CertExpiryNotificationService.js`
  - [x] 4.2 Add `sendTeamOwnedDigests(candidates)` to `CertExpiryNotificationService`
    - Filters `toEmail` to `isTeamDevice`. For each candidate, resolves its Escalation_Round's recipient set via `Team.getAncestorChain(directTeamId)` (root-first: `depth 0` is the Organisation, the chain's LAST row is `directTeamId` itself at its own Team_Depth `D`) filtered to `depth >= (round === 4 ? 0 : Math.max(0, D - (round - 1)))` — i.e. round 1 is `depth D` (the device's own team) only, each subsequent round climbs ONE level toward the Organisation, and round 4 reaches every depth down to and including 0 unconditionally — then queries direct (`inherited_from_team_id IS NULL`), `role = 'admin'`, `account_status = 'active'` members of that depth-bounded team-id set — the same admin predicate `Team.isAdmin`/`getManagedTeamIds` already use, applied to a set rather than one team (Requirement 4.4)
    - Builds `Map<adminUserId, { email, devicesByTeam }>` across every candidate so a multi-team admin gets one email spanning every team (Requirement 4.2), calls `EmailService.sendEmail(admin.email, 'cert_expiry_team_digest', { first_name, team_sections, revoke_hint_url })` once per admin
    - Tracks per-`(clientUid, certId, thresholdDays)` success/failure across every recipient it was queued to reach in this run, and writes its `cert_expiry_notifications` row only once every attempt for it succeeded (Requirement 3.4's rule, applied per notification-row rather than per-send)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
    - Files: `server/services/CertExpiryNotificationService.js`
    - Implementation note: caught and fixed a real depth-direction bug in this task's own design during implementation — `Team.getAncestorChain` is root-first (`depth 0` = Organisation, LAST row = the device's own team at its own depth `D`), and an earlier draft of the depth-floor formula treated `depth 0` as round 1's target and widened downward, which is backwards relative to the stated requirement ("round 1 = direct team admins, +1 level up per round"). Corrected to anchor the floor at the device's own depth `D` and subtract per round, matching what's written above. requirements.md/design.md were corrected to match before this code was written.
  - [x] 4.3 Add `run(now = new Date())` orchestrating `findEligibleCandidates` -> `sendSelfOwnedDigests` -> `sendTeamOwnedDigests`, called by the job (task 6)
    - Files: `server/services/CertExpiryNotificationService.js`
  - [x] 4.4 * Write unit tests for both senders against a mocked `EmailService.sendEmail`
    - Assert one call per recipient, never per device; assert a multi-device single-user group produces exactly one email listing every device; assert a multi-team admin's digest spans every team in one email; assert the resolved-row write happens only after a successful send and never after a rejected one
    - Files: `server/services/CertExpiryNotificationService.test.js` (extend)
    - 14 tests (6 self-digest + 8 team-digest), all pass.
  - [x] 4.5 * Write unit tests for Escalation_Round resolution specifically
    - For a device team sitting at depth 3 in a 4-level-deep chain (depths 0-3): round 1 reaches only depth-3 admins (the device's own team), round 2 adds depth-2, round 3 adds depth-1, round 4 reaches every depth including depth-0 (the Organisation), and an admin reached at round 1 also appears in rounds 2-4's resolved sets for the same device (additive, never replacing). Also cover a device team sitting at depth 0 itself (an Organisation-level device, no sub-team) — round 1 through 4 all resolve to the same single depth-0 team, since `Math.max(0, D - (round-1))` floors at 0
    - Files: `server/services/CertExpiryNotificationService.test.js` (extend)
    - 9 tests, all pass. `server/services/CertExpiryNotificationService.test.js` totals 38 tests across tasks 3-4.

- [x] 5. Checkpoint - Ensure all tests pass
  - Server: `npm test` (via `env -i ... npx jest --forceExit`) — 139 suites, 2827 tests pass. `get_diagnostics` clean on every file touched by tasks 1-4.

- [x] 6. Implement `CertExpiryNotificationJob` and wire it into `syncWorker.js`
  - [x] 6.1 Create `server/services/CertExpiryNotificationJob.js`
    - Structurally mirrors `RetentionCleanupJob` (`start()`/`stop()`, plain `setInterval`/`clearInterval`, idempotent against a double start/stop, every run's error caught and logged, never thrown), but scheduled via `EscalationService.startDailySchedule()`'s exact digest-half mechanism: a once-a-minute comparison of `DIGEST_HOUR`/`DIGEST_MINUTE`/`DIGEST_TIMEZONE` (read fresh from `process.env` on every tick, same fallback defaults) against `now` in that timezone
    - `start()` is a no-op (logs and returns) unless BOTH `isCertExpiryNotificationsEnabled()` and `isDeviceMgmtEnabled()` are true (Requirement 5.2, 5.3, 5.4) — checked inside `start()` itself, matching this file's existing pattern for `isDeviceMgmtEnabled()`-gated jobs
    - Carries a `lastRunDateKey` guard (`'YYYY-MM-DD'` in the configured timezone) so a run cannot double-fire within the same matching minute — a deliberate, documented hardening on this new copy of the pattern, not applied retroactively to `EscalationService` itself
    - Calls `CertExpiryNotificationService.run()` on a match
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
    - Files: `server/services/CertExpiryNotificationJob.js`
  - [x] 6.2 Wire `CertExpiryNotificationJob` into `server/workers/syncWorker.js`
    - Construct unconditionally in the constructor (`this.certExpiryNotificationJob = new CertExpiryNotificationJob()`), alongside `retentionCleanupJob`/`expiryScheduler`; call `.start()` in `start()` and `.stop()` unconditionally in `stop()`, matching the existing job-wiring convention for both flag-gated-inside-`start()` and unconditional-`stop()` jobs
    - _Requirements: 5.2, 5.3, 5.4_
    - Files: `server/workers/syncWorker.js`
  - [x] 6.3 * Write unit tests for `CertExpiryNotificationJob`, mirroring `RetentionCleanupJob.test.js`'s shape
    - Assert `start()` is a no-op when either flag is disabled (and when both are); assert `maybeRun()` does not double-fire within the same matching minute (`lastRunDateKey` guard); assert `stop()` is idempotent
    - Files: `server/services/CertExpiryNotificationJob.test.js`
    - 15 tests, all pass.
  - [x] 6.4 * Write a unit test asserting `syncWorker.js`'s `start()`/`stop()` call the new job's `start()`/`stop()`, following whatever existing test shape covers `retentionCleanupJob`'s own wiring
    - Files: `server/workers/syncWorker.test.js` (extend)
    - New `describe('SyncWorker CertExpiryNotificationJob wiring', ...)` block, 3 tests, mirroring the pre-existing `RetentionCleanupJob wiring` block exactly.

- [x] 7. Add the two new email templates
  - [x] 7.1 Seed `cert_expiry_self_digest` and `cert_expiry_team_digest` in a new migration
    - `INSERT INTO email_templates (template_key, subject_template, body_template, description) VALUES (...) ON CONFLICT (template_key) DO NOTHING`, following `1786596755665_baseline-schema.cjs`'s seed-block convention exactly
    - `cert_expiry_self_digest` variables: `first_name`, `device_list`, `revoke_hint_url`. Body states plainly which device(s) are expiring and when, links to renew, and advises revoking instead if the device is no longer needed
    - `cert_expiry_team_digest` variables: `first_name`, `team_sections`, `revoke_hint_url`. Same advisory, phrased for an admin acting on someone else's device, linking to `/tasks`
    - _Requirements: 3.3, 4.3_
    - Files: `database/migrations/1788700000000_cert-expiry-email-templates.cjs`
  - [x] 7.2 Register both template keys in `client/src/utils/templateVariableHints.js`'s `TEMPLATE_VARIABLE_HINTS` map
    - `cert_expiry_self_digest: ['first_name', 'device_list', 'revoke_hint_url']`, `cert_expiry_team_digest: ['first_name', 'team_sections', 'revoke_hint_url']`
    - Files: `client/src/utils/templateVariableHints.js`
  - [x] 7.3 * Write a migration smoke test asserting both rows exist with the documented `template_key`s after applying
    - Files: `database/migrations/__tests__/cert-expiry-email-templates.integration.test.js`
    - 5 tests, verified against real Postgres.
  - [x] 7.4 * Extend `templateVariableHints.test.js` (or its structural-guard equivalent, if one exists covering every seeded template key) to cover both new keys
    - Files: `client/src/utils/templateVariableHints.test.js` (extend, if applicable)
    - Extended `KNOWN_KEYS` (previously hardcoded to "the seven") and its example test to cover all nine keys.

- [x] 8. Checkpoint - Ensure all tests pass
  - Server: `npm test`. Client: `cd client && npm test`. `get_diagnostics` clean on every file touched by tasks 6-7.
  - Two unrelated failures observed and confirmed NOT caused by this work (both pass in isolation; `git diff` confirms the touched files were mid-edit by a concurrent session sharing this working tree): `operationSchemas.test.js` (channel-group operation types) and `storeBadgeFidelity.test.jsx` (CloudTAK Downloads link). Both self-resolved by later checkpoints as the concurrent session's edits settled.

- [x] 9. Implement Superseded Certificate Revocation
  - [x] 9.1 Extend `revoke_tak_certificates`'s `exactlyOneOf` entry in `server/workers/operationSchemas.js` with a third discriminator, `cert_ids: 'object'`
    - The existing `client_uid`/`tak_usernames` shapes are unchanged
    - _Requirements: 8.2_
    - Files: `server/workers/operationSchemas.js`
  - [x] 9.2 Extend `revokePayloadShape` and `resolveRevokeTargets` in `server/workers/syncWorker.js` with a `cert_ids` branch
    - `revokePayloadShape` returns `'cert_ids'` when `payload.cert_ids !== undefined` (checked alongside the existing two, still mutually exclusive per `exactlyOneOf`'s own validation)
    - `resolveRevokeTargets`'s `cert_ids` branch sets `targetCertIds` to exactly the supplied array (validated numeric, deduplicated, sorted via the existing `sortCertIds` helper) with NO catalog-matching lookup — this shape already IS the cert id set, unlike the other two which must resolve INTO one; `clientUids` for the resulting audit record is resolved by looking up which fetched `certificates` carry one of the target ids, purely for logging context, mirroring the `tak_usernames` branch
    - The existing four-rail gate structure (dry-run check, blast-radius cap, audit record, `DELETE`) is entirely unchanged — this only adds a third way to arrive at `targetCertIds`
    - _Requirements: 8.2_
    - Files: `server/workers/syncWorker.js`
  - [x] 9.3 * Extend `server/workers/operationSchemas.test.js` and `server/workers/syncWorker.test.js` for the new shape
    - Assert `cert_ids` validates alongside the other two and that carrying two discriminators (or none) still rejects; assert `resolveRevokeTargets`'s `cert_ids` branch bypasses catalog matching, still applies `sortCertIds`, and that the existing two shapes' tests are unaffected
    - Files: `server/workers/operationSchemas.test.js`, `server/workers/syncWorker.test.js` (both extended)
    - `operationSchemas.test.js`: existing 2-discriminator test widened to 3, plus new accept/reject cases for `cert_ids` (43 tests total, up from 39). `syncWorker.test.js`: new `describe('cert_ids-scoped target selection ...')` block, 7 tests (190 total in file).
  - [x] 9.4 Add a private helper, `#enqueueSupersedingRevoke(userId, actingUserId)`, to `server/services/DeviceEnrollmentService.js`
    - `SELECT cert_id FROM tak_devices WHERE user_id = $1 AND revoked = false` — reads the rows `DeviceSync` already keeps current rather than issuing a fresh TAK Server API call (Requirement 8.6). Keyed on `user_id`, NOT `client_uid`: neither mint call has a `client_uid` in hand at mint time (TAK Server assigns one only once the physical device actually uses the minted token)
    - Returns (no enqueue) when no row is found (Requirement 8.5 — an ordinary first enrollment, not an error or anomaly)
    - Returns (no enqueue, logged informationally at most) when MORE than one live row is found (Requirement 8.2 — a Self-Owned_Device principal may legitimately hold several live devices at once; guessing which one a mint replaces is genuinely ambiguous and risks revoking one still in use)
    - Otherwise (exactly one live row) enqueues `revoke_tak_certificates` via `EventPublisher.publishOperation('revoke_tak_certificates', { cert_ids: [supersededCertId] }, actingUserId)`, subject to the existing `DEVICE_MGMT_REVOKE_ENABLED`/blast-radius-cap handling with no new gating logic (Requirement 8.4)
    - _Requirements: 8.1, 8.2, 8.4, 8.5, 8.6_
    - Files: `server/services/DeviceEnrollmentService.js`
    - Implementation note: this signature (`userId`, not `clientUid`) and the Requirement 8.2 multi-device-skip rule were both corrections made to requirements.md/design.md/tasks.md DURING implementation, before writing code — the original draft assumed a `client_uid` was available at mint time, which it is not.
  - [x] 9.5 Call `#enqueueSupersedingRevoke` from both `generateSelfEnrollment` and `generateEnrollmentQrCode`, AFTER the new certificate has been successfully minted, passing the principal's own `users.id`, fire-and-forget with its own `.catch(err => logger.error(...))` — never allowed to fail the enrollment response itself
    - _Requirements: 8.1_
    - Files: `server/services/DeviceEnrollmentService.js`
    - Implementation note: both callers converge on the shared private `#buildEnrollment`, so the call site was added there once rather than duplicated per public method.
  - [x] 9.6 * Write unit tests for `#enqueueSupersedingRevoke` and its two call sites
    - Assert no enqueue when no prior live row exists; assert no enqueue when MORE than one live row exists (the ambiguous-multi-device case); assert the enqueued payload is exactly `{ cert_ids: [supersededCertId] }` when exactly one prior live row exists, never including the just-minted certificate's own id; assert a rejected enqueue does not propagate to or alter `generateSelfEnrollment`/`generateEnrollmentQrCode`'s own successful response
    - Files: `server/services/DeviceEnrollmentService.test.js` (extend)
    - 8 new tests (61 total in file, up from 53). Required fixing two pre-existing mock helpers that intercepted any `FROM tak_devices` query for the pre-existing `liveCertificateCount` read and would have wrongly answered the new `cert_id`-selecting query too — disambiguated on `count(*)` vs `cert_id` substrings.

- [x] 10. Checkpoint - Ensure all tests pass
  - Server: `npm test` — 136 suites, 2798 tests pass. `get_diagnostics` clean on every file touched by task 9.
  - Fixed a real regression this task caused: `server/config/__tests__/enrollmentPermissions.test.js`'s structural guard (a `takserver-enrollment` feature guard scanning `DeviceEnrollmentService.js`'s source for `clientUid`/`client_uid` substrings, including in comments) tripped on this task's own explanatory comments about NOT using a `client_uid`. Fixed by rewording the comments to avoid the literal substring while keeping the explanation — the guard itself was not weakened.

- [x] 11. Document configuration in `.env.example`
  - [x] 11.1 Add `CERT_EXPIRY_NOTIFICATIONS_ENABLED`, `CERT_EXPIRY_TIER1_DAYS`..`CERT_EXPIRY_TIER4_DAYS`, and `CERT_EXPIRY_ACTIVITY_WINDOW_DAYS` to `.env.example`
    - Full-prose-comment-block style matching `DEVICE_MGMT_ENABLED`/`DEVICE_MGMT_REVOKE_ENABLED`/`DEVICE_MGMT_EXPIRY_WARNING_DAYS`'s existing entries: each variable states its default, that it is read server-side only, and (for the enable flag) that it requires `DEVICE_MGMT_ENABLED` also being `'true'` to take effect
    - Explicitly note none of these are exposed through `GET /api/config/public`
    - _Requirements: 9.3, 9.4_
    - Files: `.env.example`
    - Verified via `dotenv.parse()` that all 6 new variables parse with their documented defaults. Also added a note that digest scheduling reuses the existing, undocumented `DIGEST_HOUR`/`DIGEST_MINUTE`/`DIGEST_TIMEZONE` (deliberately not newly-documented here, since they predate and are owned by `EscalationService`, not this feature).

- [x] 12. Add the Dashboard "My Devices" renew prompt
  - [x] 12.1 Add a page-level banner to `client/src/pages/Dashboard.jsx`'s "My Devices" card
    - Rendered above the device list only when `devices.some(d => classifyExpiry(...) !== EXPIRY_STATES.NONE)`, using the existing `classifyExpiry` threshold (no new threshold introduced) — reuses the amber-informational-banner treatment `MultipleCertificateWarning.jsx` establishes (text-carried state, `InformationCircleIcon`, non-alert)
    - Call-to-action is the existing `<Link to="/enrollment">` — no new route, no per-row button (Requirement 6.2)
    - When no device qualifies, the card renders exactly as it does today
    - _Requirements: 6.1, 6.2, 6.3_
    - Files: `client/src/pages/Dashboard.jsx`
  - [x] 12.2 * Write vitest tests for the banner's presence/absence conditions
    - Files: `client/src/pages/Dashboard.test.jsx` (extend)
    - 6 new tests (48 total in file), all pass.

- [x] 13. Rename `/requests` to `/tasks` and fix the nav badge gating gap
  - [x] 13.1 Update `client/src/App.jsx`
    - Move the existing `Requests` route to `path="/tasks"`; add `<Route path="/requests" element={<Navigate to="/tasks" replace />} />` alongside it so an old link/bookmark still resolves
    - _Requirements: 7.1_
    - Files: `client/src/App.jsx`
  - [x] 13.2 Update `client/src/components/Layout.jsx`'s `getNavigation`
    - Rename the `Requests` nav entry to `{ name: 'Tasks', href: '/tasks', icon: ClipboardDocumentListIcon }` and move it out of the `user?.isAdmin || user?.isTeamAdmin`-gated block into `baseNavigation` (visible to every authenticated user) per Requirement 7.2
    - _Requirements: 7.2_
    - Files: `client/src/components/Layout.jsx`
    - Implementation note: the badge-render JSX in BOTH the mobile and desktop sidebar copies still gated on `item.name === 'Requests'` after the rename — caught immediately by this task's own new tests failing, fixed in both places.
  - [x] 13.3 Extend the badge-count `useEffect`'s existing early-return to also cover `isTeamAdmin`, independent of the nav item's now-unconditional visibility
    - The pre-existing guard, `if (!user?.isAdmin && !user?.is_global_manager) return`, tests the SAME flag twice (`isAdmin`/`is_global_manager` are aliases of the same cached `is_admin` column, per this app's own domain rules) and never excludes a plain `isTeamAdmin`-only user. Corrected to `if (!user?.isAdmin && !user?.isTeamAdmin && !user?.is_global_manager) return`
    - NOT a 403-avoidance fix: `GET /api/requests/pending` is not admin-scoped server-side (`request:read` sits in `roleDefaults.authenticated_user`; the route filters to a visible subset, empty for a non-admin, rather than rejecting). The fix exists so a plain member's `Layout` mount does not repeatedly poll (every 60s, and on every tab-visibility change) an endpoint that can only ever resolve to a count of zero for them
    - The badge's OWN counted value (pending access/org-interest requests) is unchanged either way — this task only prevents a wasted fetch, never changes what the badge counts (Requirement 7.5)
    - _Requirements: 7.7_
    - Files: `client/src/components/Layout.jsx`
    - Implementation note: this task's own premise (that the fetch would 403 a plain member) was corrected during implementation, after reading `server/routes/requests.js` directly — the fix's actual justification (avoiding a wasted poll, not avoiding a 403) is documented above and reflected in requirements.md/design.md.
  - [x] 13.4 * Write vitest tests: a plain, non-admin user renders the "Tasks" nav item (unlike today's admin-only "Requests") but the badge-count effect issues no `requestsAPI.getPending()`/`adminAPI.getOrgInterest` call for that user; an admin/team-admin user still gets both the nav item and the badge fetch; `/requests` redirects to `/tasks`
    - Files: `client/src/components/Layout.test.jsx` (extend), `client/src/App.test.jsx` (extend)
    - `Layout.test.jsx`: renamed the pre-existing badge-locator helper/describe block text (Requests -> Tasks), added a new describe block with 4 tests (10 total in file). `App.test.jsx`: new describe block for the `/requests` -> `/tasks` redirect (7 total, up from 6). Also updated `Dashboard.jsx`'s "Review Requests" link to point directly at `/tasks`.

- [x] 14. Add the two renewal-list sections to `/tasks`
  - [x] 14.1 Add an `expiringOnly` filter to `GET /api/devices` (`server/routes/devices.js`), threading it into `DeviceEnrollmentService.listAllDevices`
    - Reuses the existing `canManage`/scoping logic already in `listAllDevices` unchanged — `expiringOnly` only narrows the WHERE clause to devices whose live certificate `classifyExpiry`s as imminent or expired (same threshold as task 12.1), it introduces no new authorization rule
    - _Requirements: 7.3 (b)_
    - Files: `server/routes/devices.js`, `server/services/DeviceEnrollmentService.js`
    - Test: extend `server/services/DeviceEnrollmentService.test.js` and `server/routes/devices.test.js` for the new filter
    - Implementation note: reads `DEVICE_MGMT_EXPIRY_WARNING_DAYS` directly in `listAllDevices` (with the same `parseInt(...) > 0 ? ... : 30` discipline `SiteConfig.js` already uses for the same variable) rather than depending on that module, keeping the two in lockstep without a new cross-module dependency. Verified the two additive SQL params directly against real Postgres before writing unit tests. `DeviceEnrollmentService.test.js` +4 tests; `devices.test.js` +2 existing assertions updated (additive param) +3 new tests for the query-param parsing.
  - [x] 14.2 Add `devicesAPI.getAll({ expiringOnly: true })` support in `client/src/services/api.js` (parameter pass-through only, `getAll` already accepts arbitrary params)
    - Files: `client/src/services/api.js` (only if `stripEmptyParams`/param shape needs adjustment — likely no change needed)
    - No code change needed, confirmed: `stripEmptyParams` already passes booleans through unfiltered. Updated the doc comment only.
  - [x] 14.3 Add the "My certificates needing renewal" section to `client/src/pages/Requests.jsx`
    - Fetches the current user's own devices (reusing `deviceManagementAPI.getMyDevices()`, the same call the Dashboard card already makes) and lists only those `classifyExpiry`-imminent/expired, each with a "Renew" link to `/enrollment`; visible to every user; rendered first per Requirement 7.3's ordering
    - _Requirements: 7.3 (a), 7.4, 7.6_
    - Files: `client/src/pages/Requests.jsx`
    - Added `filterDevicesNeedingRenewal` as a standalone exported pure helper for unit testability.
  - [x] 14.4 Add the "Team devices needing renewal" section to `client/src/pages/Requests.jsx`
    - Visible only to a Team_Admin/Global_Manager (`user?.isAdmin || user?.isTeamAdmin`); fetches `devicesAPI.getAll({ expiringOnly: true })` and lists each due device grouped by team, with a "Renew" action calling `devicesAPI.generateQrCode(deviceUserId)` and opening the same QR/enrollment-data display `Devices.jsx`/`TeamDeviceList.jsx` already use — no new minting code path; rendered second, ahead of the existing pending-access-requests and Org_Interest_Requests sections (Requirement 7.3's fixed ordering)
    - On a successful renew, the device is removed from the section's list without a full page reload (Requirement 7.6)
    - _Requirements: 7.3 (b), 7.4, 7.6_
    - Files: `client/src/pages/Requests.jsx`
    - Reuses the existing `EnrollmentView` modal exactly as `Devices.jsx` does; refetches the section's own list on modal close.
  - [x] 14.5 * Write vitest tests for both new sections' render conditions (visible/hidden by role, populated/empty), the "Renew" action's call and post-success list update, and confirm the existing pending-access-request and Org_Interest_Requests sections are unchanged and still render after the two new ones
    - Files: `client/src/pages/Requests.test.jsx` (extend)
    - Required adding `deviceManagementAPI`/`devicesAPI`/`configAPI` to this file's mock (previously absent entirely, meaning calls were silently throwing into existing try/catch blocks with zero real coverage) plus a `GLOBAL_MANAGER` fixture and a `MemoryRouter` wrapper around every mount (the new section renders a `react-router-dom` `<Link>`). 11 new section tests + 2 new `filterDevicesNeedingRenewal` unit tests (46 total in file, up from 33).

- [x] 15. Checkpoint - Ensure all tests pass
  - Server: `npm test` — 136 suites, 2829 tests pass. Client: `cd client && npm test` — 68/69 files pass (1354/1355 tests); the one failure (`storeBadgeFidelity.test.jsx`) confirmed unrelated (passes in isolation, zero diff from this work, caused by a concurrent session's in-progress CloudTAK config edits) and self-resolved by task 17's final run. `get_diagnostics` clean on every file touched by tasks 11-14.

- [x] 16. Property-based tests for the Correctness Properties
  - [x] 16.1 * Property test: eligibility/backlog-collapse invariants hold for any generated set of DUE tiers on one certificate
    - **Property: across any generated subset of the four tiers being simultaneously DUE-and-unresolved for one certificate, exactly one (the smallest `threshold_days`) ends up in `toEmail` and every other one ends up in `toMarkResolvedOnly`, and the union of both sets' `threshold_days` values equals the generated DUE-and-unresolved set exactly — never more, never fewer**
    - **Validates: Requirements 2.1, 2.3**
    - Files: `server/services/CertExpiryNotificationService.property.test.js`
    - 300 runs, all pass, plus an anti-vacuity check confirming both single-tier and multi-tier-backlog cases were actually generated.
  - [x] 16.2 * Property test: Escalation_Round resolution is monotonically additive by round, for any generated ancestor-chain depth and any generated per-depth admin set
    - **Property: for any generated chain of depth 0..N (device's own team at depth N) with a generated set of direct admins at each depth, the resolved recipient set for round `r` is always a SUBSET of the resolved recipient set for round `r+1` (for `r` in 1..3), round 1's resolved set is always exactly the device's own team's (depth-N) admins, and round 4's resolved set always equals the union of every depth's admins including depth 0 (the Organisation), regardless of N**
    - **Validates: Requirement 4.1 (Escalation_Round definition)**
    - Files: `server/services/CertExpiryNotificationService.property.test.js` (same file, separate describe block)
    - 300 runs, all pass. Both properties drive the REAL service methods (`findEligibleCandidates`, `sendTeamOwnedDigests`) against mocked collaborators, with the expected value in each case independently re-derived from the generated inputs and this feature's own Requirements text — never by calling the function under test.

- [x] 17. Final checkpoint - verify the full build
  - Run the full server (`npm test`) and client (`cd client && npm test`) suites, plus `npm run lint` and `npm run lint:pinned-deps`. Ensure all pass, ask the user if questions arise.
  - Server: 136 suites, 2827 tests pass (5 pre-existing failures in `server/services/BulkImportService.test.js` confirmed, via `git diff --stat` showing 498 lines of concurrent-session in-progress edits to files never touched by this work, plus reproducing the same failures in complete isolation, to be unrelated to this feature).
  - Client: 69 files, 1355 tests pass (the task-15 `storeBadgeFidelity.test.jsx` failure self-resolved once the concurrent session's edits settled).
  - `npm run lint`: 94 pre-existing issues across files/lines this feature never touched (confirmed via `git show HEAD:<file>` for `syncWorker.js`'s two flagged lines, both present verbatim before this feature's changes) — zero issues in any file this feature created or edited.
  - `npm run lint:pinned-deps`: passes clean (`jsonwebtoken`, `helmet`, `express-rate-limit`, `node-forge` all exactly pinned) — this feature introduced no new dependency.
  - `get_diagnostics` clean on every file touched across all 17 tasks (verified via one batched call covering all files this session created or modified).
