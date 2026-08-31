# Design Document: Account Lifecycle Management

## Overview

This feature adds three related pieces of state and behavior to the existing `users` table, none of which exist today:

1. **Account_Suspension** — an admin-initiated, reversible lockout (Requirement 1).
2. **Account_Orphaning** — an automatically-detected, irreversible response to an Authentik identity disappearing (Requirements 2-4).
3. **Account_Reclaim** — the re-signup path that lets a NEW sign-up adopt an orphaned row rather than colliding with it (Requirement 5).

All three apply identically to a human `users` row and to a Team_Owned_Device `users` row (`is_team_device = true`); the only per-type differences are (a) a device has no `tak_callsign`/`tak_color` cache fields to clear, and (b) a device has no sign-up flow, so Account_Reclaim is human-only.

This design reuses, rather than reimplements, three pieces of existing infrastructure:

- **Certificate revocation** — the existing `revoke_tak_certificates` Sync_Operation (`EventPublisher.publishOperation` → `SyncWorker.revokeTakCertificates` → `TakServerService.revokeCertificates`), already device-scoped (`client_uid`) and user-scoped (`tak_usernames`) via `operationSchemas.js`'s `exactlyOneOf` discriminator. Neither Account_Suspension nor Account_Orphaning introduces a new revocation mechanism or a new operation type.
- **Authentik attribute patching** — the existing PATCH-`/core/users/{id}/`-with-partial-body pattern already used by `UserAttributesService.updateUserAttributes`/`clearUserAttributes` and by `authentikSync.js`'s push-to-Authentik step. Account_Suspension/Unsuspension add one more caller of this pattern, patching only `is_active`.
- **Row adoption instead of insertion** — the existing Claim_Row pattern in `UserProvisioningService.createAndAddUser` (`UPDATE users SET authentik_user_id = $1, ... WHERE id = $claimId`), reused by Account_Reclaim for the mirror-image problem: adopting an EXISTING orphaned row instead of inserting a new one that would collide with `users_email_key`.

## Schema

One migration, `database/migrations/<timestamp>_account-lifecycle-status.cjs`, following the existing incremental-migration convention (`1787518155760_tak-devices.cjs` et al. — never hand-editing `schema.sql`):

```sql
ALTER TABLE public.users
  ADD COLUMN account_status character varying(20) NOT NULL DEFAULT 'active';

ALTER TABLE public.users
  ADD CONSTRAINT users_account_status_check
  CHECK (account_status IN ('active', 'suspended', 'orphaned'));

CREATE INDEX idx_users_account_status ON public.users (account_status)
  WHERE account_status <> 'active';
```

No backfill needed: every existing row defaults to `'active'`, which is correct for every row that predates this feature. The partial index (mirroring `idx_teams_callsign_prefix`'s partial-index style elsewhere in this schema) keeps the common case — "give me every non-active account for this list view" — cheap without indexing the overwhelming majority of rows that will always be `'active'`.

`account_status` lives on `users`, not `user_cache`: `user_cache` is documented throughout this codebase as a mirror of Authentik-plus-locally-authoritative-attributes for fast lookup (`getUserFromCache`), and `account_status` is a fact ABOUT the local row's relationship to Authentik, not a display attribute — it belongs with `is_team_device`, `origin_org_id`, and the other structural columns already on `users`. `user_cache.is_active` continues to be written wherever `users.is_active` changes, exactly as today; this feature adds no new `user_cache` column.

## Account_Suspension / Account_Unsuspension (Requirement 1)

### New service: `server/services/AccountLifecycleService.js`

A new, small service — not folded into `UserAttributesService` (which is Authentik-attribute-focused and has no concept of team-scoped authorization) or `TeamMembershipService` (which is membership-focused, not account-state-focused). Two public static methods, mirroring the transactional shape `TeamTransferService.executeTransfer` and `TeamMembershipService.addUserToTeam` already establish (acquire or accept a client, do the local write, enqueue the Sync_Operation on that SAME client so a rollback also un-enqueues it, `COMMIT`, then perform the Authentik PATCH AFTER commit — never inside the transaction, per the existing "no HTTP call inside a transaction" rule this codebase already follows in `TeamTransferService.applyPostCommitEffects`):

```js
class AccountLifecycleService {
  // Requirement 1.1-1.5. Throws AccountAlreadySuspendedError /
  // AccountOrphanedError if account_status is not 'active'.
  static async suspendAccount(targetUserId, actingUser) { ... }

  // Requirement 1.6-1.10. Throws AccountNotSuspendedError if account_status
  // is not 'suspended'.
  static async unsuspendAccount(targetUserId, actingUser) { ... }
}
```

**Authorization** (Criterion 1.1/1.6): both methods take `actingUser` and resolve the target's Direct_Membership team via the same `team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL` query `DeviceEnrollmentService.deleteDevice` already uses, then call `Team.isAdmin(teamId, actingUser.userId)` OR check `actingUser.is_global_manager` — the SAME two-part rule every other team-scoped admin action in this codebase uses. Wired into `server/middleware/authorize.js` as two new resolvers, `resolveTeamAdminOfTargetAccount` for suspend/unsuspend, registered in `permissions.registry.js` as:

```js
'POST /api/users/:userId/suspend': ['user:suspend'],
'POST /api/users/:userId/unsuspend': ['user:suspend'],
```

(one identifier for both actions, mirroring how `device:manage` already covers create/edit/delete under one identifier — suspend and unsuspend are the same authorization question asked twice, not two different capabilities).

**`suspendAccount` steps** (Criteria 1.2-1.5):
1. `SELECT authentik_user_id, is_team_device, account_status, username FROM users WHERE id = $1 FOR UPDATE` on an acquired client, inside `BEGIN`. `FOR UPDATE` closes the race where two concurrent suspend calls both read `'active'`.
2. If `account_status !== 'active'`, `ROLLBACK` and throw `AccountAlreadySuspendedError`/`AccountOrphanedError` (Criterion 1.5) naming the current status — no Authentik PATCH, no enqueue.
3. `UPDATE users SET account_status = 'suspended', is_active = false WHERE id = $1` (Criterion 1.9) and the matching `UPDATE user_cache SET is_active = false WHERE authentik_id = $1`.
4. Enqueue the Revoke_Operation on the SAME client via `EventPublisher.publishOperation('revoke_tak_certificates', { client_uid: ... } | { tak_usernames: [username] }, actingUser.userId, client)` — `client_uid` for a Team_Owned_Device (it has exactly one), `tak_usernames: [username]` for a human (mirroring the three existing user-scoped call sites `device-management`'s design doc names). This is enqueue-only; the actual TAK Server `DELETE` happens later in the Sync_Worker, exactly like every other Revoke_Operation caller — Account_Suspension does not call `TakServerService` directly.
5. Insert the `audit_logs` row (`action: 'user.suspend'`, `resource_type: 'user'`) on the same client.
6. `COMMIT`.
7. AFTER commit (Criterion 1.2): PATCH Authentik `is_active: false`, in its own try/catch — a failure here is logged and does NOT roll back or fail the request; the local suspension and the queued revoke are the durable, load-bearing effects (mirroring `TeamTransferService.applyPostCommitEffects`'s established "local state commits first, best-effort external call after" pattern). A failed PATCH here means Authentik's `is_active` may briefly disagree with the local `account_status` until the periodic `authentikSync.js` push-to-Authentik step (which already reads local `is_active` as authoritative and PATCHes Authentik when it differs) reconciles it on its own next run — no new reconciliation code needed for this specific failure mode, since the existing push-to-Authentik logic already covers exactly this drift.

**`unsuspendAccount` steps** (Criteria 1.7-1.10) are the mirror: `FOR UPDATE`, reject if not `'suspended'`, `UPDATE users SET account_status = 'active', is_active = true`, audit-log, `COMMIT`, then PATCH Authentik `is_active: true` post-commit. No Revoke_Operation is enqueued (there is nothing to re-revoke), and no certificate-restoration logic exists (Criterion 1.7) — this is a deliberate absence, not an oversight, since a revoked certificate cannot be un-revoked on TAK Server; re-enrollment is the only path back to a live certificate, exactly as after any other revoke.

### Routes

`server/routes/users.js` gains two routes, following the existing `POST /api/users/:userId/transfer`-style shape (thin route, delegate to service, map named errors to status codes):

```js
router.post('/:userId/suspend', authenticateToken, authorize, async (req, res) => { ... });
router.post('/:userId/unsuspend', authenticateToken, authorize, async (req, res) => { ... });
```

`AccountAlreadySuspendedError`/`AccountOrphanedError`/`AccountNotSuspendedError` → 400, naming the current status in the message body, following the existing named-error-to-400 convention `CallsignSuffixConflictError`/`OrganisationPrefixMissingError` already establish at their own route call sites.

### Client

Members/Team Admins/Team Devices rows (`TeamDetail.jsx`) gain a Suspend/Unsuspend action in `MemberActions`/the device-row action group, alongside the existing Edit/Remove actions, following the existing `variant='table'|'card'` icon-button convention (`client-conventions` steering: grey box for an ordinary action, red-tinted box for the destructive one — Suspend is the red-tinted one, Unsuspend is the ordinary grey one). A confirmation dialog (mirroring `RevokeDeviceDialog.jsx`'s shape) states plainly what will happen: "This revokes every live TAK Server certificate this [member/device] holds and locks their Authentik account. It can be undone later." No type-to-confirm text is required here (Criterion 1 carries no such requirement, unlike the existing Revoke_Confirmation_Word convention for a raw device-management revoke) since suspension is itself reversible.

## Account_Orphaning: Reconciliation_Sweep (Requirements 2-4)

### Where it runs: end of `AuthentikSyncService.syncUsers`

`server/services/authentikSync.js`'s `syncUsers` already has the exact shape this needs: a paginated fetch into `allUsers`, wrapped so that ANY page's failure is caught before the per-user `processBatch` loop runs (the existing `fetchGroupMap`-failure early-return is the precedent — see the comment already in that method about "no partial write" being explicit rather than incidental). The Reconciliation_Sweep is a new step inserted AFTER the existing `for (batch of allUsers) processBatch(...)` loop completes, still inside the same `try` block, so it runs only on the success path (Criterion 2.1/2.3) — never on a fetch failure, mirroring `DeviceSync`'s "reconcile only on a fully-successful fetch" discipline named directly in Requirement 2.3.

```js
// After the existing batch-processing loop, still inside syncUsers()'s try block:
await this.reconcileOrphanedAccounts(allUsers.map(u => String(u.pk)));
```

### `reconcileOrphanedAccounts(fetchedAuthentikIds)`

A new method on `AuthentikSyncService`, taking the exact set of `authentik_id` values this run's fetch returned (Criterion 2.2):

```sql
SELECT u.id, u.authentik_user_id, u.is_team_device, u.username
FROM users u
WHERE u.authentik_user_id::text <> ALL($1::text[])
  AND u.account_status <> 'orphaned'
```

This mirrors the existing "scope every destructive-adjacent write by an explicit key set, never an unrestricted predicate" convention (`server-conventions`: `WHERE client_uid <> ALL($1::text[])` in `DeviceSync`) — an empty or malformed `$1` here would orphan EVERY row, which is exactly the failure mode Criterion 2.3's "never reconcile against a partial fetch" guards against; `$1` is the argument, so the caller (this method's one call site, guarded by the success path above) is what makes the empty-set case unreachable, not a check inside the query itself.

No `is_team_device` branch in the query (Criterion 2.4) — human and device rows are found identically. For each row returned:

1. Enqueue the Revoke_Operation exactly as `suspendAccount` does (Criterion 3.1): `client_uid` for a device, `tak_usernames: [username]` for a human. Uses the default `pool` (no open transaction to share — this runs outside any caller's transaction, on the periodic sync's own timer), matching how `authentikSync.js`'s existing writes already use `db.query` directly rather than an explicit transaction.
2. IF `!is_team_device` (Criterion 3.2): `UPDATE user_cache SET tak_callsign = 'None', tak_color = 'None' WHERE authentik_id = $1` — the exact statement `UserAttributesService.clearTeamAttributes` already issues for a teamless user, reused here for the same "no team-derived identity is displayable" reasoning, not duplicated as new SQL.
3. `UPDATE users SET account_status = 'orphaned', is_active = false WHERE id = $1` and `UPDATE user_cache SET is_active = false WHERE authentik_id = $1` (Criterion 3.3).
4. Insert an `audit_logs` row with `created_by = SYSTEM_USER_ID` (Criterion 3.4) — importing the existing `SYSTEM_USER_ID = -1` sentinel from `VendorChannelService` rather than declaring a second one, `action: 'user.orphaned'`, `resource_type: 'user'`, `resource_id: row.id`, `details: { reason: 'authentik_account_missing' }`.

Each row's four steps run independently and are individually try/caught and logged (mirroring `DeviceEnrollmentService`'s/`DeploymentChannelService.deactivateExpired`'s "one row's failure must not abort the rest of the batch" convention) — one account's Revoke_Operation enqueue failing must not prevent every other orphaned account in this run from being marked.

Nothing here deletes a `users`/`team_memberships`/`audit_logs`/`sync_operations`/`access_requests` row (Criterion 3.5) — this method only ever issues `UPDATE`/`INSERT`, matching the "orphaning never deletes" requirement directly.

Gated by nothing beyond "the sync run itself is running" (Criterion 2.5) — no `isDeviceMgmtEnabled()` check, since the certificates being revoked exist on TAK Server independent of whether the device-management UI is turned on; the enqueue is gated by the EXISTING `DEVICE_MGMT_REVOKE_ENABLED` flag at the `SyncWorker.revokeTakCertificates` handler, exactly as every other Revoke_Operation caller already is — no new gating logic is added here.

### Why `GET /api/users/available` needs no code change (Requirement 3.7)

This was the originally-reported bug. Its query already filters `uc.is_active = true`. Once the Reconciliation_Sweep sets `is_active = false` on an orphaned row (step 3 above), that row stops being returned by `/available` on the very next call after the next sync — no change to `server/routes/users.js` is needed; the existing predicate now has correct data to filter against. This requirement is stated explicitly (rather than left implicit) so a future reader confirms this is a deliberate "fixed by the write, not by a second read-side change" design rather than an oversight.

## Orphan Visibility (Requirement 4)

`GET /api/teams/:teamId` and `Team.getMembers`/`listTeamDevices` already project `u.*` (members) or explicit columns (devices); `account_status` is added to each SELECT's column list — no new query, an additive column on an existing one.

Client: `TeamDetail.jsx`'s Members/Team Admins/Team Devices tabs render a text badge next to the name/username — `"Suspended"` (amber) or `"Account not found in Authentik"` (red) — sourced from `account_status`, following the existing `status-icon cluster` convention in `Teams.jsx` (private/joinable/has-signup-code icons, always paired with a `title`/visible text per the accessibility steering rule that "state must be carried by TEXT, never colour alone"). An orphaned row's row-action group loses the Suspend/Unsuspend actions entirely (there is nothing left to suspend or unsuspend) but keeps the existing Remove-from-Team/Delete-Device action untouched (Criterion 4.2) — no change to `TeamMembershipService.removeUserFromTeam`/`DeviceEnrollmentService.deleteDevice` themselves, since both already tolerate a missing Authentik user gracefully today.

## Account_Reclaim (Requirement 5)

### Fixing `determineEmailState` (Criterion 5.1)

`SignupFlowService.determineEmailState`'s first check today is:

```sql
SELECT u.id FROM users u
JOIN team_memberships tm ON u.id = tm.user_id AND tm.inherited_from_team_id IS NULL
WHERE u.email = $1 LIMIT 1
```

This is changed to also read `u.account_status`, and the `'active'` classification is only returned when `account_status = 'active'`. When a match is found with `account_status = 'orphaned'`, `determineEmailState` falls through to its existing `access_requests`-based checks and, finding none (an orphaned account by definition predates this NEW sign-up attempt), returns `'new'` — the SAME code path an entirely-unseen email already takes. No new state value is introduced in `determineEmailState`'s own return set; Account_Reclaim is detected later, at approval time (Criterion 5.2), not at this email-state-classification step. This keeps `determineEmailState`'s contract simple: it answers "should I treat this email as new," not "does this email have history."

### Detecting a Reclaimable_Account at approval time (Criterion 5.2)

`RequestApprovalService.processApprovedRequest`'s `new_account` branch, immediately before calling `UserProvisioningService.createAndAddUser`, gains one lookup:

```sql
SELECT id FROM users WHERE email = $1 AND account_status = 'orphaned'
```

using the request's `requester_email`. If a row is found, `reclaimedUserId` is threaded through to `createAndAddUser` instead of `claimId` (both name "an existing row to adopt instead of inserting," but `claimId` specifically means a Claim_Row created earlier in the SAME sign-up flow by `resolveNewUserIdentity`'s pseudonymous branch — a different, unrelated mechanism reusing the same UPDATE-by-id shape, not the same code path). The distinct notice to the approving admin (Criterion 5.2) is surfaced on `GET /api/requests/pending`'s response for this request: an additive `reclaimableAccount: { userId, previousTeamId }` field the Client's approval-review UI renders as a highlighted note, rather than changing the request's own displayed type.

### Adopting the row (Criteria 5.3, 5.5)

`UserProvisioningService.createAndAddUser` already branches on `claimId` vs. a plain insert; it gains a third branch for `reclaimedUserId`, using the exact same `UPDATE ... WHERE id = $1` shape the `claimId` branch already uses, but resetting `account_status = 'active'` additionally:

```sql
UPDATE users
SET authentik_user_id = $1, username = $2, email = $3, first_name = $4, last_name = $5,
    is_active = true, account_status = 'active', callsign_suffix = $6
WHERE id = $7
RETURNING id
```

The row's `id` is unchanged (Criterion 5.5), so every existing `audit_logs`/`sync_operations`/`access_requests` row already pointing at it via that `id` continues to describe the SAME row across the reclaim, with no migration or backfill needed — this falls out of "adopt by primary key" for free, exactly as it already does for the pre-existing Claim_Row case.

### No automatic membership restoration (Criterion 5.4)

`createAndAddUser`'s existing `teamId` parameter is supplied by the CURRENT request being approved (the team the person is signing up for NOW), never read from the reclaimed row's prior `team_memberships` history — nothing in this design reads the orphaned row's old membership at all before it is overwritten by the fresh `addUserToTeam` call `createAndAddUser` already performs for every new approval. This is the natural consequence of reusing the existing approval flow unmodified apart from the row-adoption branch, not an extra check that needs writing.

### Device exclusion (Criterion 5.6)

No code path exists for a device to reach `SignupFlowService`/`RequestApprovalService` at all — devices are created exclusively via `DeviceEnrollmentService.createDevice`, which has no sign-up/approval concept. Account_Reclaim is therefore human-only by construction; this criterion documents that boundary rather than requiring a new guard.

## Error Classes

| Class | HTTP status | Thrown by |
| --- | --- | --- |
| `AccountAlreadySuspendedError` | 400 | `AccountLifecycleService.suspendAccount` when `account_status === 'suspended'` |
| `AccountOrphanedError` | 400 | `suspendAccount`/`unsuspendAccount` when `account_status === 'orphaned'` |
| `AccountNotSuspendedError` | 400 | `unsuspendAccount` when `account_status !== 'suspended'` |
| `TargetUserNotFoundError` | 404 | `suspendAccount`/`unsuspendAccount` when `targetUserId` names no `users` row at all -- added during implementation (task 2.1/2.2) since the four `Account*` state errors all presuppose a row exists to have a state, and mapping a missing row to one of them would mislead the route layer's 400 mapping |

## Testing Notes

- Unit: `AccountLifecycleService.suspendAccount`/`unsuspendAccount` against a mocked client — same mocking shape as `TeamTransferService.test.js`; assert the enqueue payload shape (`client_uid` vs `tak_usernames`) branches correctly on `is_team_device`, assert the post-commit PATCH is NOT inside the transaction (i.e. not called before `COMMIT` in the mock's call order).
- Unit: `AuthentikSyncService.reconcileOrphanedAccounts` — mocked `db.query`, assert it is never invoked when the fetch loop's own try/catch already aborted the run (Criterion 2.3), assert one failing row's per-row try/catch doesn't block the rest.
- Property test candidate: `account_status`/`is_active` consistency (Criterion 1.9) — for any sequence of suspend/unsuspend/orphan transitions reachable per the state machine (`active → suspended → active`, `active → orphaned`, `suspended → orphaned`; `orphaned` is terminal), `is_active` always agrees with the table in Requirement 1.9/glossary. This is the kind of small, pure state-machine invariant this codebase already favors a `fast-check` property test for (see `callsignValidation.test.js`'s Property 3 precedent).
- Integration: `SignupFlowService.determineEmailState` against a real orphaned row returns `'new'`, not `'active'` (Criterion 5.1) — following the existing `users.directoryScope.integration.test.js` real-Postgres convention rather than a mock, since this is exactly the kind of query-behavior claim that file's own header argues should be verified against a real database.
