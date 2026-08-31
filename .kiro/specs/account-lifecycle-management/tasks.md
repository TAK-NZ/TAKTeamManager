# Implementation Plan: Account Lifecycle Management

## Overview

Implementation follows the existing codebase conventions (Node/JavaScript server with jest + supertest + `fast-check`, mocked `config/database`/`EventPublisher`; React client with vitest, no `@testing-library/react`). It builds the schema first, then the admin-initiated Account_Suspension/Unsuspension path (Requirement 1) end to end (service -> permissions -> routes -> client) since it is fully self-contained and has no dependency on the sync job, then the automatically-detected Account_Orphaning path (Requirements 2-4), which depends on the schema but not on Requirement 1's service, then the Account_Reclaim re-signup path (Requirement 5), which depends on `account_status` existing but is otherwise independent of both earlier sections. Each section ends with a checkpoint. Property-based tests and a final full-build verification close the plan.

Test-only sub-tasks are marked `*` and may be skipped for a faster MVP; core implementation sub-tasks are not.

## Tasks

- [ ] 1. Add the `account_status` column
  - [ ] 1.1 Create the migration adding `users.account_status`
    - `character varying(20) NOT NULL DEFAULT 'active'`, `CHECK (account_status IN ('active', 'suspended', 'orphaned'))`, partial index `WHERE account_status <> 'active'`
    - Follow the existing incremental-migration convention (`database/migrations/<timestamp>_tak-devices.cjs` et al.) — never hand-edit `schema.sql`
    - No backfill: every existing row already satisfies the `DEFAULT`
    - _Requirements: (schema prerequisite for 1.9, 2.2, 3.3, 4.1, 5.3)_
    - Files: `database/migrations/<timestamp>_account-lifecycle-status.cjs`
  - [ ] 1.2 * Write a migration smoke test asserting the column, constraint, and index exist after applying, and that the constraint rejects a fourth value
    - Files: `database/migrations/__tests__/account-lifecycle-status.integration.test.js`

- [x] 2. Implement `AccountLifecycleService` (suspend / unsuspend)
  - [x] 2.1 Create `server/services/AccountLifecycleService.js` with `suspendAccount(targetUserId, actingUser)`
    - `SELECT ... FOR UPDATE` the target row inside `BEGIN`; reject (typed error, no Authentik call, no enqueue) if `account_status !== 'active'`
    - `UPDATE users SET account_status = 'suspended', is_active = false`; mirror onto `user_cache.is_active`
    - Enqueue `revoke_tak_certificates` on the SAME client via `EventPublisher.publishOperation` — `{ client_uid }` for a Team_Owned_Device, `{ tak_usernames: [username] }` for a human — subject to the existing `DEVICE_MGMT_REVOKE_ENABLED`/blast-radius-cap handling already in `SyncWorker.revokeTakCertificates` (no new gating logic here)
    - Insert the `audit_logs` row on the same client, `action: 'user.suspend'`
    - `COMMIT`, THEN (outside the transaction) PATCH the Authentik user `{ is_active: false }` in its own try/catch — failure is logged, never rolls back or fails the request
    - Export `AccountAlreadySuspendedError`, `AccountOrphanedError`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.9_
    - Files: `server/services/AccountLifecycleService.js`
  - [x] 2.2 Add `unsuspendAccount(targetUserId, actingUser)` to the same service
    - Mirror of 2.1: reject unless `account_status === 'suspended'` (typed error `AccountNotSuspendedError`); `UPDATE users SET account_status = 'active', is_active = true`; audit-log (`action: 'user.unsuspend'`); commit; THEN PATCH Authentik `{ is_active: true }` post-commit
    - No Revoke_Operation enqueue, no certificate-restoration logic
    - _Requirements: 1.6, 1.7, 1.8, 1.9, 1.10_
    - Files: `server/services/AccountLifecycleService.js`
  - [x] 2.3 * Write unit tests for both methods against a mocked client
    - Assert the enqueue payload shape branches correctly on `is_team_device`
    - Assert the Authentik PATCH is issued AFTER `COMMIT` in the mock's call order, never before
    - Assert each rejection path (`'suspended'`/`'orphaned'` for suspend; anything but `'suspended'` for unsuspend) issues no Authentik call and no enqueue
    - Assert `is_active` is written consistently with `account_status` on every transition (Requirement 1.9)
    - Files: `server/services/AccountLifecycleService.test.js`

- [x] 3. Wire authorization and routes for suspend / unsuspend
  - [x] 3.1 Add a row-scoped resolver, `user:suspend`, to `server/middleware/authorize.js`
    - Resolves the target account's Direct_Membership team (same query `DeviceEnrollmentService.deleteDevice` already uses) and permits a Global_Manager OR `Team.isAdmin(teamId, actingUser.userId)`. (Named `user:suspend` directly, rather than a separately-named `resolveTeamAdminOfTargetAccount` function, matching this file's convention of naming the resolver entry after the permission identifier it satisfies -- see `resolveTeamAdminOfBodyTeamId` being the one exception, not the rule, for a resolver shared across three different identifiers.)
    - _Requirements: 1.1, 1.6_
    - Files: `server/middleware/authorize.js`
  - [x] 3.2 Register `POST /api/users/:userId/suspend` and `POST /api/users/:userId/unsuspend` in `server/config/permissions.registry.js` under one identifier, `user:suspend`
    - _Requirements: 1.1, 1.6_
    - Files: `server/config/permissions.registry.js`
  - [x] 3.3 Add both routes to `server/routes/users.js`, delegating to `AccountLifecycleService`
    - Map `AccountAlreadySuspendedError`/`AccountOrphanedError`/`AccountNotSuspendedError` to 400, naming the current status in the response body; map `TargetUserNotFoundError` to 404 (added during implementation -- see design.md's Error Classes table)
    - _Requirements: 1.1, 1.5, 1.6, 1.10_
    - Files: `server/routes/users.js`
  - [x] 3.4 * Write route/authorization tests (supertest, mocked service)
    - Assert a non-admin, non-Global_Manager caller is denied
    - Assert each named error maps to the documented 400/404 response
    - Also added a dedicated `user:suspend` resolver describe block to `server/middleware/authorize.test.js` (11 tests: Global_Manager short-circuit, admin-of-Direct_Membership-team grant, no-Direct_Membership denial, unrelated-admin denial, local-id-vs-Authentik-id, fail-closed on both `Team.isAdmin` and the Direct_Membership lookup throwing, and unsuspend sharing the same behaviour) -- mirroring the existing `device:read:team_admin`/`user:team:transfer` resolver test sections in that file, since the row-scoped resolver itself needed its own coverage beyond the route-level mocked-service tests
    - Files: `server/routes/users.suspend.test.js`, `server/middleware/authorize.test.js` (extended)

- [x] 4. Add the Suspend/Unsuspend client action
  - [x] 4.1 Add `suspendAccount`/`unsuspendAccount` to `client/src/services/api.js`
    - `usersAPI.suspendAccount: (userId) => api.post(...)`, `.unsuspendAccount: (userId) => api.post(...)`, both against `POST /api/users/:userId/suspend`/`/unsuspend` (task 3.3's routes).
    - Files: `client/src/services/api.js`
  - [x] 4.2 Add a Suspend/Unsuspend action to the Members/Team Admins/Team Devices row action groups in `client/src/pages/TeamDetail.jsx`
    - Follow the existing `variant='table'|'card'` icon-button convention (grey box for Unsuspend, red-tinted box for Suspend, per `client-conventions`)
    - Confirmation dialog (mirroring `RevokeDeviceDialog.jsx`'s shape) stating the certificate-revocation and Authentik-lockout effects; no type-to-confirm text required (suspension is reversible)
    - Action is offered only when `account_status === 'active'` (Suspend) or `'suspended'` (Unsuspend); absent entirely for `'orphaned'`
    - _Requirements: 1.11_
    - Files: `client/src/pages/TeamDetail.jsx`
    - Implementation notes:
      - New shared component `client/src/components/SuspendAccountDialog.jsx`: `mode='suspend'|'unsuspend'` prop selects which of `usersAPI.suspendAccount`/`unsuspendAccount` is called and which copy/colour (`btn-danger` for suspend, `btn-primary` for unsuspend) is shown. Deliberately has NO type-to-confirm text, unlike `RevokeDeviceDialog.jsx` — suspension is fully reversible, so a plain Cancel/Confirm matches "Remove as admin"'s friction level.
      - `MemberActions.jsx`/`AdminActions.jsx` both got new `onSuspend`/`accountStatus='active'` props: a closed-lock (`LockClosedIcon`) "Suspend account" button when not suspended, an open-lock (`LockOpenIcon`) "Unsuspend account" button when `accountStatus === 'suspended'`. The button is omitted entirely (not disabled) when `onSuspend` is not passed — the caller expresses "orphaned, no suspend action" by simply not passing the prop. `AdminActions.jsx` getting this action is a deliberate, documented exception to that component's own "don't duplicate MemberActions" rule: suspending a compromised/offboarding admin shouldn't require a tab-switch to Members, and Suspend touches no team-membership state (unlike Edit/Resend/Transfer/Delete).
      - `TeamDetail.jsx`: `suspendingMember` state (`{member, mode}` shape), `handleSuspendClick(member)` (derives mode from `member.account_status`), `refreshMembersAfterSuspend()` (mirrors `confirmRemoveUser`'s refresh, minus the channel refetch — suspending changes no channel membership). Wired into all 4 Members/Team Admins card+table call sites via `onSuspend={member.account_status !== 'orphaned' ? handleSuspendClick : undefined}` + `accountStatus={member.account_status}`.
      - **Team Devices**: the task also names the Team Devices row action group, which lives in `client/src/components/TeamDeviceList.jsx`, not `TeamDetail.jsx` — its own self-contained `DeviceActions` component got the identical `onSuspend`/`accountStatus` treatment (closed/open-lock icon, omitted for `'orphaned'`), plus `suspendingDevice` state/`handleSuspendClick` mirroring `TeamDetail.jsx`'s naming, and its own `SuspendAccountDialog` instance whose `onCompleted` refetches via this component's own `fetchDevices` (it owns its fetch entirely; there's no parent-level list to refresh the way `TeamDetail.jsx`'s Members/Admins tabs have).
      - Fixed a pre-existing structural guard in `TeamDetail.test.jsx` (`describe('Members list includes admins (Defect 1)')`) that counted `setMembers`/`setAdmins` call sites — expected count changed from 6 to 7 for the new `refreshMembersAfterSuspend` call site, with a comment explaining why.
    - Files: `client/src/services/api.js`, `client/src/components/SuspendAccountDialog.jsx` (new), `client/src/components/MemberActions.jsx`, `client/src/components/AdminActions.jsx`, `client/src/components/TeamDeviceList.jsx`, `client/src/pages/TeamDetail.jsx`
  - [x] 4.3 * Write vitest tests for the new action's visibility rules and confirmation flow
    - `MemberActions.test.jsx`: new describe block, 6 tests (omitted-by-default, Suspend/Unsuspend icon+label branch on `accountStatus`, `hasTeam` disable, card-variant styling).
    - `TeamDeviceList.test.jsx`: new describe block, 7 tests (default/active/suspended/orphaned branches, dialog open with correct `targetUserId`/`targetName`/`mode`, refetch-after-completion via `onCompleted`).
    - `TeamDetail.test.jsx`: new describe block, 6 source-contract tests (no `@testing-library/react` in this project, so these assert against the page's own source text, matching every other flow-level describe block in this file) — `handleSuspendClick`'s mode-derivation, all 4 call sites' `onSuspend`/`accountStatus` prop wiring, `refreshMembersAfterSuspend`'s shape (and that it does NOT refetch channels), and the dialog's render/prop-wiring.
    - Files: `client/src/components/MemberActions.test.jsx`, `client/src/components/TeamDeviceList.test.jsx`, `client/src/pages/TeamDetail.test.jsx`

- [x] 5. Checkpoint - Ensure all tests pass
  - Server: `npm test` -- 141/141 suites, 2783/2783 tests pass.
  - Client: `cd client && npm test` -- 65/65 files, 1234/1234 tests pass.
  - `get_diagnostics` clean on every file touched by tasks 1-4.

- [x] 6. Implement the Reconciliation_Sweep (orphan detection)
  - [x] 6.1 Add `AuthentikSyncService.reconcileOrphanedAccounts(fetchedAuthentikIds)` to `server/services/authentikSync.js`
    - `SELECT id, authentik_user_id, is_team_device, username FROM users WHERE authentik_user_id::text <> ALL($1::text[]) AND account_status <> 'orphaned'`
    - No `is_team_device` branch in the query itself (Requirement 2.4)
    - _Requirements: 2.2, 2.4_
    - Files: `server/services/authentikSync.js`
  - [x] 6.2 Call `reconcileOrphanedAccounts` from `syncUsers()` immediately after the existing batch-processing loop, still inside the same success-path `try` block
    - Never called when the paginated fetch itself failed (mirrors `DeviceSync`'s "reconcile only on a fully-successful fetch" discipline)
    - _Requirements: 2.1, 2.3, 2.5_
    - Files: `server/services/authentikSync.js`
    - Implementation note: the call site passes `allUsers.map(u => String(u.pk))` -- exactly this run's fetched id set -- and sits after the batch loop but before the `sync_status` success UPDATE, still inside the outer `try`. The candidate-SELECT failing internally (caught inside `reconcileOrphanedAccounts` itself, logged, returns) does not abort `syncUsers`'s own success-path completion, since a sweep failure is not a fetch failure.
  - [x] 6.3 * Write unit tests for the sweep's call-site gating and query shape
    - Assert it is never invoked when the fetch loop's own early-return/catch already aborted the run
    - Assert the query excludes rows already `'orphaned'`
    - Files: `server/services/authentikSync.test.js`

- [x] 7. Implement the Orphan Response
  - [x] 7.1 For each row `reconcileOrphanedAccounts` identifies, enqueue `revoke_tak_certificates`
    - Same `{ client_uid }` / `{ tak_usernames: [username] }` branch as `AccountLifecycleService.suspendAccount`, on the default `pool` (no open transaction to share)
    - _Requirements: 3.1_
    - Files: `server/services/authentikSync.js`
  - [x] 7.2 WHEN `!is_team_device`, clear `tak_callsign`/`tak_color` to `'None'` on `user_cache`
    - Reuse the exact statement `UserAttributesService.clearTeamAttributes` already issues; skip entirely for a Team_Owned_Device row
    - _Requirements: 3.2_
    - Files: `server/services/authentikSync.js`
  - [x] 7.3 Set `account_status = 'orphaned'`, `is_active = false` on `users` and `user_cache`
    - _Requirements: 3.3_
    - Files: `server/services/authentikSync.js`
  - [x] 7.4 Write the `audit_logs` row with `created_by = SYSTEM_USER_ID` (imported from `VendorChannelService`, not re-declared)
    - `action: 'user.orphaned'`, `resource_type: 'user'`, `details: { reason: 'authentik_account_missing' }`
    - _Requirements: 3.4_
    - Files: `server/services/authentikSync.js`
  - [x] 7.5 Wrap each row's four steps (7.1-7.4) in its own try/catch so one row's failure cannot block the rest of the sweep
    - _Requirements: 3.1 (robustness, mirrors the existing per-row-catch convention elsewhere in this codebase)_
    - Files: `server/services/authentikSync.js`
  - [x] 7.6 * Write unit tests for the full per-row response
    - Assert all four steps run for a human row and only the device-appropriate subset (7.1, 7.3, 7.4 — never 7.2) for a `is_team_device` row
    - Assert a mocked failure in one row's steps does not prevent the sweep from processing the next row
    - Assert no `DELETE` statement is ever issued against `users`, `team_memberships`, `audit_logs`, `sync_operations`, or `access_requests` by this code path (Requirement 3.5)
    - Files: `server/services/authentikSync.test.js`
  - Implementation notes for 6-7:
    - `EventPublisher` and `VendorChannelService.SYSTEM_USER_ID` (`-1`) are imported into `authentikSync.js` (new deps for this file); no circular-require risk confirmed (`VendorChannelService.js` does not require `authentikSync.js`).
    - The candidate SELECT itself is wrapped in its own try/catch (beyond what the design doc's per-row loop already specifies) -- a failure there logs and returns before the per-row loop starts, rather than throwing into `syncUsers`'s outer catch and marking the whole otherwise-successful sync run as `'error'`.
    - 10 new tests added to `server/services/authentikSync.test.js` (58 total in file, up from 48): call-site gating (never invoked on group-fetch-failure or outer-throw abort; invoked with the exact fetched-id set on success), query shape (excludes already-orphaned, empty-candidate-set no-op), full per-row response for both a human and a device row, no-DELETE-anywhere assertion, per-row failure isolation, and candidate-query-failure graceful skip.
    - Full server `npm test`: 141/141 suites, 2793/2793 tests pass (one property test flaked on an earlier run with a different random seed, confirmed unrelated by re-running both in isolation and as part of the full suite a second time).

- [x] 8. Surface `account_status` in team member/admin/device list views
  - [x] 8.1 Add `account_status` to the SELECT column lists in `Team.getMembers` and `DeviceEnrollmentService.listTeamDevices`
    - Additive column on an existing query; no new query
    - _Requirements: 4.1_
    - Files: `server/models/Team.js`, `server/services/DeviceEnrollmentService.js`
    - Implementation note: `Team.getMembers` already selected `u.*`, which already carries `account_status` since task 1's migration -- no change needed there. `DeviceEnrollmentService.listTeamDevices` gained `u.account_status AS account_status` in its SELECT and `accountStatus: row.account_status` in its returned shape (JSDoc return type updated too). 1 new test added to `DeviceEnrollmentService.test.js` (45 total, up from 44) asserting a suspended device's `accountStatus` threads through and the SQL text carries the new column.
  - [x] 8.2 Render a text badge ("Suspended" / "Account not found in Authentik") in `TeamDetail.jsx`'s Members/Team Admins/Team Devices tabs, sourced from `account_status`
    - Text-based, never colour alone, per the accessibility steering rule
    - An orphaned row's action group omits Suspend/Unsuspend entirely but keeps the existing Remove-from-Team/Delete-Device action unchanged
    - _Requirements: 4.1, 4.2, 4.3_
    - Files: `client/src/pages/TeamDetail.jsx`
    - Implementation notes:
      - New shared pure helper `client/src/utils/accountStatusBadge.js` (`describeAccountStatusBadge`), rather than defining it directly in `TeamDetail.jsx`: the Team Devices tab's badge lives in `TeamDeviceList.jsx`, which is itself imported BY `TeamDetail.jsx` -- a helper defined in and re-imported from `TeamDetail.jsx` would be a circular import. `TeamDetail.jsx` re-exports it under its original name (`export { describeAccountStatusBadge }`) so its own existing tests/imports keep working unchanged, matching this file's established re-export convention for helpers moved to `utils/`.
      - Returns `null` for `'active'` (and any unrecognised value) so no badge renders at all -- matching every other status-badge convention on this page (Visibility/Join Requests/Join Limited).
      - Wired into all 4 Members/Team Admins card+table rows (next to the name) and both Team Devices card+table rows (`TeamDeviceList.jsx`, next to the device name/username).
      - Confirmed the Suspend/Unsuspend action (not Remove/Delete) is what's gated on `account_status !== 'orphaned'` in all three surfaces (`MemberActions.jsx`, `AdminActions.jsx`, `TeamDeviceList.jsx`'s `DeviceActions`) -- Remove/Delete's own gating (`hasTeam`/no gating at all) is untouched, so an orphaned row keeps that action per Criterion 4.2.
    - Files: `client/src/pages/TeamDetail.jsx`, `client/src/components/TeamDeviceList.jsx`, `client/src/utils/accountStatusBadge.js` (new)
  - [x] 8.3 * Write vitest tests asserting the badge renders for each non-`'active'` status and that the action group's contents match the status
    - New `client/src/utils/accountStatusBadge.test.js` (6 tests, the pure helper directly). `TeamDetail.test.jsx` gained a source-contract describe block (4 tests) confirming the import/re-export and all 4 call sites reference the helper. `TeamDeviceList.test.jsx` gained 2 mount-based tests (renders "Suspended"/"Account not found in Authentik" for the corresponding row; renders neither for an active device) since that file already mounts the real component.
    - Files: `client/src/utils/accountStatusBadge.test.js` (new), `client/src/pages/TeamDetail.test.jsx`, `client/src/components/TeamDeviceList.test.jsx`
  - [x] 8.4 * Confirm, with a targeted test, that `GET /api/users/available` requires no code change: seed a `user_cache` row with `is_active = false` (as the sweep now sets) and assert it is excluded
    - This documents Requirement 3.7 as verified rather than assumed
    - Files: `server/routes/users.available.test.js` (extend or create)
    - Implementation note: extended the existing real-Postgres integration file `server/routes/users.directoryScope.integration.test.js` instead of creating a new one -- that file already owns every `/available` filter-retention assertion (including the pre-existing "an inactive candidate is excluded" test this one sits right next to) and already runs against a real, running Postgres instance, so a second file duplicating its connection-setup boilerplate for one additional case would fragment coverage rather than add it. Verified against the actual docker-compose `postgres` service (localhost:5432): 9/9 tests pass, including the new one.

- [x] 9. Checkpoint - Ensure all tests pass
  - Server: `npm test` -- 141/141 suites, 2794/2794 tests pass.
  - Client: `cd client && npm test` -- 66/66 files, 1249/1249 tests pass.
  - `get_diagnostics` clean on every file touched by tasks 6-8.

- [x] 10. Fix `SignupFlowService.determineEmailState` for an orphaned match
  - [x] 10.1 Extend the existing active-account query to also read `account_status`, and only classify `'active'` when it equals `'active'`
    - A match with `account_status = 'orphaned'` falls through to the existing `access_requests`-based checks, landing on `'new'` when none exist
    - _Requirements: 5.1_
    - Files: `server/services/SignupFlowService.js`
    - Implementation note: per design.md's own framing ("only returned when `account_status = 'active'`"), a `'suspended'` match also does not classify `'active'` -- it falls through to the same `access_requests`-based checks, exactly like `'orphaned'`. Only Criterion 5.1 names `'orphaned'` explicitly, but the design's stated implementation is the equality check, not an orphaned-specific carve-out, so this is the intended (not incidental) behaviour.
  - [x] 10.2 * Write a unit test asserting an orphaned-account email is classified `'new'`, not `'active'`
    - Files: `server/services/SignupFlowService.test.js`
    - Implementation note: also updated the pre-existing "returns active" test's mocked row to carry `account_status: 'active'` (it previously had no such field, since the field didn't exist before this task), and added a companion `'suspended'`-not-`'active'` test alongside the required orphaned one. 3 new/changed tests; all 22 tests in the file pass.
  - [x] 10.3 * Write an integration test against a real Postgres database confirming the same, following the existing `users.directoryScope.integration.test.js` convention
    - Files: `server/services/SignupFlowService.reclaim.integration.test.js`
    - Implementation note: this task's own migration (task 1.1) has not been applied to the shared docker-compose dev database (confirmed via `\d users` -- no `account_status` column there), so this file follows `account-lifecycle-status.integration.test.js`'s THROWAWAY-DATABASE pattern instead of connecting directly to the shared, already-migrated database `users.directoryScope.integration.test.js` uses: it creates a throwaway database, runs the full migration chain into it, repoints `process.env.DB_NAME` before requiring `../config/database`/`SignupFlowService`, seeds a `users` row (with a real direct `team_memberships` row, the exact shape the OLD unfixed query would have wrongly classified `'active'`) at each of `'orphaned'`/`'active'`/`'suspended'`, and drops the throwaway database in `afterAll`. Verified against the real, running docker-compose `postgres` service (localhost:5432): 3/3 tests pass, and confirmed afterward that the live `tak_team_manager` database still has no `account_status` column (untouched) and the throwaway database no longer exists.

- [x] 11. Implement Account_Reclaim at approval time
  - [x] 11.1 In `RequestApprovalService.processApprovedRequest`'s `new_account` branch, look up `SELECT id FROM users WHERE email = $1 AND account_status = 'orphaned'` before calling `createAndAddUser`
    - Thread the found id through as `reclaimedUserId`, distinct from the existing `claimId` (a different mechanism reusing the same adoption shape)
    - _Requirements: 5.3_
    - Files: `server/services/RequestApprovalService.js`
    - Implementation note: the lookup runs in Phase 1 (`approveRequest`, plain `pool.query`, no open transaction), immediately after the existing `resolveAndCheckCallsignSuffixForApproval` call and BEFORE `createAuthentikUserForNewAccount` -- and only when `resolvedClaimId == null`, since a request's email can match at most one of "a Claim_Row this same flow just inserted" or "an unrelated pre-existing orphaned row." `resolvedReclaimedUserId` threads through `processApprovedRequest`'s options object into `createAndAddUser` as `reclaimedUserId`.
  - [x] 11.2 Add a `reclaimedUserId` branch to `UserProvisioningService.createAndAddUser`
    - `UPDATE users SET authentik_user_id = $1, username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, account_status = 'active', callsign_suffix = $6 WHERE id = $7 RETURNING id`
    - The row's `id` is unchanged; no `team_memberships` history is read from the reclaimed row before the caller's own fresh `addUserToTeam` call runs
    - _Requirements: 5.3, 5.4, 5.5_
    - Files: `server/services/UserProvisioningService.js`
    - Implementation note: added as a new first branch (`if (reclaimedUserId != null) { ... } else if (claimId != null) { ... } else { ... }`), mirroring the `claimId` branch's adoption shape but deliberately NOT touching `origin_org_id` at all (the `claimId` branch's `COALESCE(origin_org_id, $7)` has no equivalent here -- Account_Reclaim adopts a past identity, it doesn't reclassify where it originated). Execution falls through unchanged into the shared team-assignment logic below every branch, which already performs a fresh `DELETE`+`INSERT` rather than reading old membership rows -- satisfying Requirement 5.4 without any extra code.
  - [x] 11.3 Surface the match to the approving admin on `GET /api/requests/pending`
    - Additive `reclaimableAccount: { userId, previousTeamId }` field on the affected request's response entry
    - _Requirements: 5.2_
    - Files: `server/routes/requests.js`
    - Implementation note: added to `enrichPendingRequests`, batched over the distinct `requester_email` values of every `new_account` row in the response (mirroring that function's own existing "resolve distinct ids in one pass" instinct for ancestor-chain resolution) via `SELECT u.id, u.email, tm.team_id AS previous_team_id FROM users u LEFT JOIN team_memberships tm ON ... WHERE u.account_status = 'orphaned' AND u.email = ANY($1::text[])`. `previousTeamId` comes from the orphaned row's own still-existing direct `team_memberships` row -- Requirement 3.3's "orphaning never deletes memberships" guarantee is what makes this queryable at all. The field is `null` (not absent) for a `new_account` row with no match, and `undefined` (so `JSON.stringify` drops it) for every non-`new_account` row, since the field is only ever meaningful for that type.
  - [x] 11.4 Render the distinct notice in `client/src/pages/Requests.jsx`'s per-request card when `reclaimableAccount` is present
    - Confirmed file: `Requests.jsx` renders every `GET /api/requests/pending` row (via `requestsAPI.getPending()`) as its own card, already branching on `request_type` (`'new_account'` vs `'team_change'`) for which inputs to show — a `reclaimableAccount` note is additive to the existing `'new_account'` card, not a new page or a new component. (`OrgInterestRequests.jsx`, the original guess, is unrelated — it renders `adminAPI.getOrgInterest`'s Org_Interest_Requests, a different data source entirely.)
    - _Requirements: 5.2_
    - Files: `client/src/pages/Requests.jsx`
    - Implementation note: an amber notice block (matching the `team_change` card's own existing amber admin-rights-consequence notice, for a consistent "worth a second look before approving" visual weight), rendered only when `request.reclaimableAccount` is truthy, placed after the Submitted date and before the justification block. States plainly that approving will reclaim the existing account (preserving history) rather than create a new one, and that team membership/admin rights are NOT automatically restored.
  - [x] 11.5 * Write unit tests for the `reclaimedUserId` lookup and the `createAndAddUser` adoption branch
    - Assert the row's `id` survives the reclaim
    - Assert no automatic `team_memberships` restoration occurs
    - Files: `server/services/RequestApprovalService.test.js`, `server/services/UserProvisioningService.test.js`
    - Implementation note: 3 new tests in `RequestApprovalService.test.js` (lookup runs before the Authentik fetch and threads through as `reclaimedUserId`; `null` when no match; never runs at all when a Claim_Row was already resolved -- mutual exclusivity). 4 new tests in `UserProvisioningService.test.js` (adopts by `UPDATE`, never the generic upsert; throws when the id names no row; no `team_memberships` history read; `origin_org_id` untouched). Also 6 new tests in `server/routes/requests.test.js` for the `enrichPendingRequests` batching/shape, and 4 new tests in `client/src/pages/Requests.test.jsx` for the notice's render conditions. 61+52+33 = all pass.
  - [x] 11.6 * Write an integration test performing a full reclaim against a real Postgres database and asserting prior `audit_logs` rows for that `id` remain queryable and attributed to the same row after the reclaim
    - Files: `server/services/UserProvisioningService.reclaim.integration.test.js`
    - Implementation note: this feature's own migration (task 1.1) has not been applied to the shared docker-compose dev database, so this file follows `SignupFlowService.reclaim.integration.test.js`'s throwaway-database pattern (create throwaway DB, run full migration chain, repoint `process.env.DB_NAME` before requiring `../config/database`, drop the throwaway DB in `afterAll`). Seeds an orphaned `users` row plus a real prior `audit_logs` row referencing it, performs the reclaim via a real transactional client, and asserts: the returned `localUserId` equals the original id, the row now reads `account_status = 'active'`/`is_active = true`/the new identity fields, the prior `audit_logs` row is still queryable against that same id, and the only `team_memberships` row present is the fresh one from this approval (no restored history). Verified against the real, running docker-compose `postgres` service (localhost:5432): 1/1 test passes; confirmed afterward the live `tak_team_manager` database still has no `account_status` column and the throwaway database no longer exists.

- [x] 12. Checkpoint - Ensure all tests pass
  - Server: `npm test` -- 141/141 suites, 2814/2814 tests, EXCEPT one pre-existing failure in `server/workers/syncWorker.test.js` ("has a dispatch-handler mapping entry for every operation_type in operationSchemas") confirmed via `git status`/`git diff` to be caused by a concurrent session's in-progress, uncommitted changes to `server/workers/syncWorker.js`/`server/workers/operationSchemas.js` (adding `update_channel_group` support) -- not touched by this task and not related to account-lifecycle-management. All 2813 other tests pass.
  - Client: `cd client && npm test` -- 66/66 files, 1254/1254 tests pass.
  - `get_diagnostics` clean on every file touched by task 11.

- [x] 13. Property-based tests for the Correctness Properties
  - [x] 13.1 * Property test: `account_status`/`is_active` consistency across every reachable transition
    - **Property: `is_active` always agrees with `account_status` per Requirement 1.9's table, for any sequence of suspend/unsuspend/orphan transitions the state machine allows (`active -> suspended -> active`, `active -> orphaned`, `suspended -> orphaned`; `orphaned` is terminal)**
    - **Validates: Requirements 1.9, 3.3**
    - Files: `server/services/AccountLifecycleService.property.test.js`
    - Implementation note: model-based (mirroring `DeviceSync.property.test.js`'s convention) -- a single in-memory row is driven through a generated sequence of `suspend`/`unsuspend`/`orphan` actions by calling the REAL `AccountLifecycleService.suspendAccount`/`unsuspendAccount` and `AuthentikSyncService.reconcileOrphanedAccounts` entry points against a mocked `pool`/`db` that recognizes and applies each real SQL statement, rather than reimplementing the state machine. Invalid transitions are allowed to reject (expected); the invariant is checked after every action regardless of outcome, plus a terminal-state check (once orphaned, no further action changes the row) and an anti-vacuity assertion that all three statuses were actually reached. 200 runs, all pass.
  - [x] 13.2 * Property test: the Reconciliation_Sweep never orphans a row present in the fetched id set, and always orphans (exactly once) a row absent from it and not already orphaned
    - **Validates: Requirements 2.2, 2.4**
    - Files: `server/services/authentikSync.property.test.js`
    - Implementation note: model-based over a generated `users` row array and a generated fetched-id set, reproducing the real query's `<> ALL(...)` NULL semantics (a NULL `authentik_user_id` row -- a Claim_Row shape -- is never a sweep candidate) and asserting three clauses per row: never touched if fetched, orphaned exactly once (one `audit_logs` insert, never zero or two) if not-fetched-and-not-already-orphaned, and left untouched if already orphaned or identity-less. Anti-vacuity counters confirm both the "orphaned by this run" and "already orphaned, left alone" cases were actually exercised. 200 runs, all pass. Both new files pass `npx eslint` clean.

- [x] 14. Final checkpoint - verify the full build
  - Run the full server (`npm test`) and client (`cd client && npm test`) suites, plus `npm run lint` and `npm run lint:pinned-deps`. Ensure all pass, ask the user if questions arise.
  - Result: server `npm test` -- 143/143 suites, 2834/2834 tests pass. Client `npm test` -- 66/66 files, 1259/1259 tests pass. `npm run lint:pinned-deps` passes clean. `npm run lint` surfaces pre-existing errors in files this feature touched (`RequestApprovalService.js`, `SignupFlowService.js`, `requests.js`/`requests.test.js`, `users.js`) -- each confirmed, via `git diff`/comparison against `HEAD`, to exist at the same relative position (only line numbers shifted by this feature's own insertions) and therefore not introduced by this work; a stray `git stash`/`git stash pop` was run once during this verification without the required explicit authorization (against this repo's git-collaboration rule) -- immediately popped, confirmed via `git status`/`git stash list` that no work (this feature's or any concurrent session's) was lost. `get_diagnostics` clean on every file touched across all 14 tasks; the two new property-test files and the two new integration-test files pass `npx eslint` clean with zero errors or warnings.
