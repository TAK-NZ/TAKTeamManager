# Requirements Document

## Introduction

TAK Team Manager currently has no way to represent an account (a human member or a Team_Owned_Device) whose Authentik identity has stopped matching local expectations. Two distinct situations are unhandled today:

1. **Deliberate, reversible lockout.** An admin wants to temporarily deny a member or device the ability to authenticate or hold live TAK Server certificates, while preserving the Authentik account exactly as it is (password, group memberships, metadata) so it can be restored later with no further setup.
2. **Irreversible loss of the Authentik identity.** The Authentik account behind a local `users` row stops existing — because someone deleted it directly in Authentik, or because an upstream directory sync (e.g. an LDAP-synced 3rd-party HR system deleting a departed employee) propagated a deletion into Authentik. TAK Team Manager currently never notices this: `server/services/authentikSync.js`'s periodic sync only upserts users present in Authentik's current user list, and never revisits a `user_cache`/`users` row whose `authentik_id` drops out of that list. The row is left exactly as it was — active, listed, holding whatever role and TAK Server certificates it had — indefinitely.

This feature introduces two related, but distinct, capabilities to close that gap: **Account_Suspension** (Requirement 1), an admin-initiated, reversible lockout; and **Account_Orphaning** (Requirements 2-5), an automatically-detected, irreversible state with its own re-signup handling. Both apply identically to a human Team_Member/Team_Admin and to a Team_Owned_Device, since both are simply `users` rows distinguished only by `is_team_device`.

This feature also fixes a pre-existing, unrelated staleness bug surfaced during this feature's design: `GET /api/users/available` (the "Add Existing User" candidate list) reads only from `user_cache`, which the periodic sync never prunes when an account disappears from Authentik, so a deleted-in-Authentik user with no team continues to appear as an addable candidate. The Requirement 3 reconciliation sweep this feature adds fixes that as a side effect, since it is the same underlying gap.

This feature does NOT introduce a mechanism to purge a `users` row entirely (a retention/GDPR-style hard delete). `audit_logs.user_id`, `sync_operations.created_by`, and `access_requests.existing_user_id`/`processed_by` all hold a plain `REFERENCES users(id)` foreign key with no `ON DELETE` action, so `DELETE FROM users` for any row with audit history fails with a Postgres `23503` foreign key violation today. This feature deliberately works WITH that constraint rather than around it: an Orphaned_Account's local row, and its full history, is retained forever. A future, separate, explicitly-triggered purge capability (which would require a schema change to that foreign key) is out of scope.

## Glossary

- **Account_Status**: A new `users.account_status` column, one of `'active'`, `'suspended'`, or `'orphaned'`, defaulting to `'active'`. It applies identically to a human Team_Member/Team_Admin row and to a Team_Owned_Device row (`is_team_device = true`). It is independent of, but always kept consistent with, the existing `is_active` column (Requirement 1.9, Requirement 3.5): both `'suspended'` and `'orphaned'` carry `is_active = false`; `'active'` carries `is_active = true`.
- **Account_Suspension**: The admin-initiated, reversible transition of an `active` account to `Account_Status = 'suspended'`. Suspending PATCHes the Authentik account's `is_active` to `false` (leaving every other Authentik attribute — password, group memberships, `attributes` — untouched) and revokes every Live_Certificate the account currently holds. It does NOT delete the Authentik account, the local `users` row, or any team membership.
- **Account_Unsuspension**: The admin-initiated, reversible transition of a `suspended` account back to `Account_Status = 'active'`. Unsuspending PATCHes the Authentik account's `is_active` back to `true` and nothing else — it does NOT restore any revoked certificate; a device or user who needs a certificate again re-enrolls through the existing enrollment flow, exactly as they would after any other revocation.
- **Account_Orphaning**: The automatically-detected, irreversible transition of any account (`active` or `suspended`) to `Account_Status = 'orphaned'`, triggered when the Reconciliation_Sweep finds that account's `authentik_id` absent from Authentik's current user list — regardless of why the Authentik account stopped existing (direct deletion in Authentik, or an upstream directory sync propagating a 3rd-party deletion). There is no Account_Unorphaning action: the Authentik identity is gone, so there is nothing to reactivate. See Requirement 5 for how a NEW sign-up under the same email interacts with an Orphaned_Account.
- **Reconciliation_Sweep**: A new step at the end of a Authentik user sync run (`AuthentikSyncService.syncUsers` in `server/services/authentikSync.js`) that runs ONLY after that run's paginated fetch of Authentik's full user list completed successfully (mirroring `DeviceSync`'s existing "reconcile only on a fully-successful fetch" discipline — Requirement 3.4). It compares every `user_cache.authentik_id` against the fetched set and transitions every account whose id is absent from it to Account_Orphaning, unless it is already `'orphaned'`.
- **Live_Certificate**: As defined in the `device-management` spec: a TAK Server certificate present in the Active_Certificate view and absent from the Revoked_Certificate_View, for a given `client_uid`/`creatorDn`.
- **Revoke_Operation**: The existing `revoke_tak_certificates` Sync_Operation (`server/services/TakCertificateRevocationService.js`, `TakServerService.revokeCertificates`, `SyncWorker.revokeTakCertificates`) that both Account_Suspension and Account_Orphaning reuse to revoke an account's Live_Certificates. Subject to the existing `DEVICE_MGMT_REVOKE_ENABLED` arming flag and blast-radius cap exactly as it is today — this feature introduces no new revocation mechanism.
- **Reclaimable_Account**: An `Account_Status = 'orphaned'` `users` row whose `email` matches a NEW sign-up attempt's verified email (human accounts only; a Team_Owned_Device has no sign-up flow). See Requirement 5.
- **Account_Reclaim**: The admin-approval-time action that adopts a Reclaimable_Account's existing `users` row — `UPDATE users SET authentik_user_id = $newPk, account_status = 'active', ... WHERE id = $reclaimedRowId` — instead of inserting a second row, avoiding a `users_email_key` collision and preserving the row's history under its original `id`. Mirrors the existing Claim_Row adoption pattern in `UserProvisioningService.createAndAddUser`/`server/routes/users.js` (`UPDATE ... WHERE id = $claimId`), which already solves the identical "don't insert a second row for an email/identity that already has one locally" problem for pseudonymous accounts and Team_Owned_Devices.
- **Team_Owned_Device**: As defined in the `device-management`/`takserver-enrollment` specs: a `users` row with `is_team_device = true`, representing an Authentik `service_account`-type user with no email and no interactive login, matched to its TAK Server certificates by `creatorDn`.

## Requirements

### Requirement 1: Account Suspension and Unsuspension

**User Story:** As a Team_Admin or Global_Manager, I want to suspend a member's or device's account, so that they lose the ability to authenticate and hold live TAK Server certificates immediately, without losing the ability to restore them later with no further setup.

#### Acceptance Criteria

1. THE App SHALL provide an action, available to a Global_Manager or a Team_Admin of the target account's Direct_Membership team, that suspends an `Account_Status = 'active'` human member or Team_Owned_Device.
2. WHEN a Team_Admin or Global_Manager suspends an account, THE App SHALL PATCH that account's Authentik user with `is_active: false`, changing NO other Authentik attribute (password, `attributes`, group memberships all remain exactly as they were).
3. WHEN a Team_Admin or Global_Manager suspends an account, THE App SHALL enqueue a Revoke_Operation targeting every Live_Certificate that account currently holds, using the same device-scoped/user-scoped payload shapes the existing Revoke_Operation already supports, subject to the existing `DEVICE_MGMT_REVOKE_ENABLED` arming flag and Revoke_Blast_Radius_Cap exactly as they apply today (a disarmed revoke completes as a dry-run, per the existing `device-management` behavior, and this requirement does not change that).
4. WHEN a suspend action's Authentik PATCH and Revoke_Operation enqueue both complete, THE App SHALL set that account's `Account_Status` to `'suspended'` and SHALL write an `audit_logs` row identifying the acting admin, the affected account, and the action taken.
5. IF an account's `Account_Status` is already `'suspended'` or `'orphaned'`, THEN THE App SHALL reject a suspend action against it with an error naming the account's current status, and SHALL NOT re-issue the Authentik PATCH or enqueue a second Revoke_Operation.
6. THE App SHALL provide an action, available to the same authorization rule as Criterion 1, that unsuspends an `Account_Status = 'suspended'` human member or Team_Owned_Device.
7. WHEN a Team_Admin or Global_Manager unsuspends an account, THE App SHALL PATCH that account's Authentik user with `is_active: true`, changing NO other Authentik attribute, and SHALL NOT attempt to restore any previously revoked certificate.
8. WHEN an unsuspend action's Authentik PATCH completes, THE App SHALL set that account's `Account_Status` back to `'active'` and SHALL write an `audit_logs` row identifying the acting admin, the affected account, and the action taken.
9. THE App SHALL keep `users.is_active` consistent with `Account_Status` at every transition this requirement defines: `false` WHILE `Account_Status` is `'suspended'`, `true` when it returns to `'active'`.
10. IF an account's `Account_Status` is `'active'` or `'orphaned'`, THEN THE App SHALL reject an unsuspend action against it with an error naming the account's current status, and SHALL NOT issue the Authentik PATCH.
11. THE App SHALL surface an account's current `Account_Status` in the Team Members, Team Admins, and Team Devices list views, using a text label (never colour alone), so a Team_Admin can distinguish a suspended account (offered unsuspend) from an orphaned one (Requirement 4.1's distinct treatment).

### Requirement 2: Orphan Detection via Sync Reconciliation

**User Story:** As an operator, I want TAK Team Manager to notice, within one sync interval, that an account's Authentik identity has stopped existing — whether deleted directly in Authentik or via an upstream directory sync — so that its TAK Server certificates are revoked promptly rather than remaining live indefinitely.

#### Acceptance Criteria

1. WHEN `AuthentikSyncService.syncUsers` completes its paginated fetch of Authentik's full current user list WITHOUT error, THE App SHALL run the Reconciliation_Sweep before that sync run ends.
2. THE Reconciliation_Sweep SHALL identify every `user_cache` row whose `authentik_id` is absent from the fetched user list AND whose corresponding `users.account_status` (joined via `authentik_user_id`) is not already `'orphaned'`.
3. IF `AuthentikSyncService.syncUsers`'s paginated fetch fails partway through (any page), THEN THE App SHALL NOT run the Reconciliation_Sweep for that run, mirroring the existing `DeviceSync` discipline of never reconciling against a partial/failed fetch.
4. THE Reconciliation_Sweep SHALL apply identically to a human `users` row and to a Team_Owned_Device `users` row (`is_team_device = true`) — no `is_team_device` distinction in the detection query itself.
5. THE Reconciliation_Sweep SHALL NOT be gated by, or interact with, the `DEVICE_MGMT_ENABLED` flag: detecting an orphaned account and revoking its certificates is independent of whether the device-management self-service/admin UI is enabled, since the certificates being revoked already exist on TAK Server regardless of that flag.

### Requirement 3: Orphan Response

**User Story:** As a Global_Manager, I want an account the Reconciliation_Sweep identifies as orphaned to have its TAK Server certificates revoked automatically and its team-derived display attributes cleared, so that a deleted-upstream identity cannot continue to hold a live, unmanageable credential.

#### Acceptance Criteria

1. WHEN the Reconciliation_Sweep identifies an account to orphan, THE App SHALL enqueue a Revoke_Operation targeting every Live_Certificate that account currently holds, subject to the existing `DEVICE_MGMT_REVOKE_ENABLED` arming flag and Revoke_Blast_Radius_Cap exactly as they apply today.
2. WHEN the Reconciliation_Sweep identifies a HUMAN account (`is_team_device` is not `true`) to orphan, THE App SHALL clear that account's `tak_callsign`/`tak_color` `user_cache` fields to the literal string `'None'`, following the existing `UserAttributesService.clearTeamAttributes` convention for a user who no longer has a usable team-derived identity. THE App SHALL NOT attempt this for a Team_Owned_Device row, which carries no `tak_callsign`/`tak_color` cache fields.
3. WHEN the Reconciliation_Sweep identifies an account to orphan, THE App SHALL set that account's `Account_Status` to `'orphaned'` and `users.is_active`/`user_cache.is_active` to `false`.
4. WHEN the Reconciliation_Sweep identifies an account to orphan, THE App SHALL write an `audit_logs` row identifying the affected account and recording that the transition was system-detected (distinct from an admin-initiated suspend's audit row per Requirement 1.4), using a sentinel `created_by`/actor value consistent with the existing `SYSTEM_USER_ID` convention used elsewhere for automated, non-admin-initiated actions.
5. THE App SHALL NOT delete an orphaned account's local `users` row, `team_memberships` row(s), or any row referencing it (`audit_logs`, `sync_operations`, `access_requests`) as part of orphan detection or response. The row and its full history are retained indefinitely.
6. THE App SHALL NOT offer an unsuspend/reactivate action for an `Account_Status = 'orphaned'` account, since no Authentik identity exists for such an action to reach.
7. GET /api/users/available and any other query that currently reads `user_cache.is_active = true` as its sole "is this a usable, addable candidate" predicate SHALL continue to work correctly once Requirement 2's sweep sets `is_active = false` on an orphaned row — this requirement introduces no new query changes beyond what Requirement 2/3's `is_active` write already causes those existing predicates to reflect.

### Requirement 4: Orphan Visibility

**User Story:** As a Team_Admin, I want to see at a glance which of my team's members or devices are orphaned, so that I can decide whether to remove them from the team or wait for a legitimate re-signup to reclaim the account.

#### Acceptance Criteria

1. THE App SHALL surface an `Account_Status = 'orphaned'` account distinctly from `'suspended'` in the Team Members, Team Admins, and Team Devices list views, using a text label (never colour alone) that communicates the Authentik identity no longer exists.
2. THE App SHALL continue to offer the existing "Remove from Team" action (`DELETE /api/users/remove-from-team/:userId` for a human, the existing device-delete route for a Team_Owned_Device) against an orphaned account, unchanged from its current behavior — both routes already tolerate a missing/already-deleted Authentik user gracefully (a caught, logged, non-blocking failure on the Authentik-side `DELETE` call), so no change is required there.
3. THE App SHALL NOT automatically remove an orphaned account from its team as part of orphan detection or response (Requirement 3) — team-membership removal for an orphaned account remains a deliberate, admin-initiated action via the existing mechanism named in Criterion 2.

### Requirement 5: Re-signup Against an Orphaned Email

**User Story:** As a person whose previous account was orphaned (deleted in Authentik, directly or via an upstream directory sync) but who has a legitimate ongoing or renewed need for access, I want to be able to sign up again with the same email address, so that I am not permanently locked out by an account state I cannot see or control.

#### Acceptance Criteria

1. `SignupFlowService.determineEmailState` SHALL NOT classify an email as `'active'` on the sole basis of a matching `users`/`team_memberships` row whose `Account_Status` is `'orphaned'` — an orphaned account has no reachable Authentik identity, so directing that email to "you already have an account, use password reset" is a dead end.
2. WHEN a new sign-up's email, once verified, matches a Reclaimable_Account, THE App SHALL present that fact distinctly to the approving admin at approval time — distinguishable from an ordinary brand-new-person request — rather than silently treating it as an unrelated new account.
3. WHEN an approving admin approves a sign-up request whose email matches a Reclaimable_Account, THE App SHALL perform an Account_Reclaim: adopt the existing orphaned `users` row by primary key (mirroring the existing Claim_Row adoption pattern) rather than inserting a second row, which would otherwise collide with `users_email_key`.
4. AN Account_Reclaim SHALL NOT automatically restore the Reclaimable_Account's previous team membership, role, or admin grants. THE approving admin SHALL make a fresh, explicit team/role assignment as part of approving the request, exactly as for any other new-account approval.
5. THE App SHALL preserve the reclaimed `users` row's original `id` and therefore its full prior audit history (`audit_logs`, etc.) across an Account_Reclaim — the row is adopted, never replaced.
6. THIS requirement applies to human sign-up only. A Team_Owned_Device has no sign-up flow and is unaffected by this requirement; a device's `Account_Status = 'orphaned'` row can only be addressed via Requirement 4's Remove-from-Team action followed by ordinary re-enrollment under a new device account.

## Out of Scope

- **Hard deletion / purge of a `users` row**, orphaned or otherwise, and any associated schema change to the non-cascading foreign keys on `audit_logs.user_id`, `sync_operations.created_by`, or `access_requests.existing_user_id`/`processed_by` that such a purge would require. This feature deliberately retains every row indefinitely instead.
- **Bulk/self-service suspension.** Requirement 1's suspend/unsuspend actions are per-account, admin-initiated actions on an existing account detail view; this feature does not add a bulk-suspend workflow.
- **Any change to `DEVICE_MGMT_ENABLED`'s gating of the device-management self-service/admin UI.** Certificate revocation via the Revoke_Operation continues to be gated by `DEVICE_MGMT_REVOKE_ENABLED` alone, exactly as today; this feature does not loosen or tighten that gate.
