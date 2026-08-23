# Requirements Document

## Introduction

A user's team assignment changes routinely: a member relocates, transfers between stations, or is initially landed at an Organisation root and needs to be placed in a real Sub_Team. Today TAK Team Manager has no non-destructive way to do this.

The move operation itself already exists and is transactional. `RequestApprovalService.processApprovedRequest` has a complete `case 'team_change'` branch (backed by the production-hardening spec's Requirement 18.2) that calls `TeamMembershipService.addUserToTeam(existing_user_id, target_team_id, 'member', adminId, client)` on the approval transaction's own client, and it is covered by `server/routes/requests.approval.integration.test.js`. The `access_requests` table already carries every column the operation needs (`request_type`, `existing_user_id`, `current_team_id`, `target_team_id`, `status`, `processed_by`, `processed_at`).

That branch is unreachable. Searching `team_change` across `server/routes/` and `client/src/` returns zero hits: there is no route that creates a `team_change` Access_Request, and no Client surface that displays or initiates one. The only route that assigns an existing user to a team, `POST /api/users/add-to-team`, explicitly rejects an already-assigned user with `400 User is already a member of another team`, and the only route that clears a team assignment, `DELETE /api/users/remove-from-team/:userId`, deletes the user from Authentik and from the local `users`/`user_cache` tables entirely. `GET /api/users/available` lists only users with no direct membership (`WHERE tm.user_id IS NULL`), so an assigned user cannot even be selected. The net effect is that relocating a member today requires deleting and recreating the account, which for an OIDC/LDAP-federated identity destroys the federated account.

Two correctness gaps in the existing, already-wired move operation were found while investigating and are in scope for this spec, because a Team_Transfer that exhibits either of them is not a usable feature:

- `TeamMembershipService.addUserToTeam` deletes the user's `team_memberships` rows but never deletes their `channel_memberships` rows, and never enqueues a `remove_user_from_group` Sync_Operation. A moved user therefore retains Channel access to the Source_Team, locally and in Authentik. (`removeUserFromTeam`, by contrast, does both.)
- Nothing on the `team_change` path regenerates the user's callsign. Only the `new_account` branch calls `UserAttributesService.generateCallsign`/`updateUserAttributes`. Because a callsign is derived from the Destination_Team's Ancestor_Chain, a transferred user would keep a callsign naming the team they left (`FENZ-STL-C.Elsen` after moving to Ōtautahi, where `FENZ-OTA-C.Elsen` is correct).

A third finding is a specification gap rather than a behavioural one: `addUserToTeam` does already insert the destination `channel_memberships` rows and enqueue one `add_user_to_group` Sync_Operation per Primary_Channel of the Destination_Team's Ancestor_Chain that holds an `authentik_group_id`, but no acceptance criterion in any spec covers that, so the destination half of a Team_Transfer's Authentik effect is untested. Requirement 6 states it so it becomes covered.

This spec covers creating Transfer_Requests, executing them, the authorization model on both sides, the Client surfaces to initiate and to review, and the notification and audit trail. It also resolves an existing inconsistency: `request:read` is in `roleDefaults.authenticated_user` and the Requests nav item is shown to Team_Admins, but `request:approve` and `request:deny` hold no row-scoped resolver and are absent from `authenticated_user`, so a Team_Admin can list pending Access_Requests and is guaranteed a 403 on every attempt to act on one.

## Scope

In scope: Transfer_Request creation, the immediate-execution path, the approve/deny path and its row-scoped authorization resolvers, Destination_Team Channel assignment and its Sync_Operations, Source_Team Channel revocation, callsign regeneration, Callsign_Suffix resolution and collision handling, demotion of a transferred Team_Admin, rejection of a self-transfer, re-validation of the request's preconditions at approval time, notification of the transferred user, audit logging, Permission_Registry entries for every new route, the Client initiate and review surfaces, and automated tests for all of the above.

Out of scope, and a candidate follow-up rather than an oversight: withdrawal or cancellation of a pending Transfer_Request by its Initiating_Admin. The Approval_Team can already decline it under Requirement 12, which produces the same end state plus a recorded reason, and Requirement 3's one-pending-Transfer_Request-per-user rule means a stale pending row blocks nothing except a second transfer of that same user.

Out of scope, tracked as a separate follow-up: domain-based and Authentik-group-based auto-assignment of externally created (OIDC/LDAP) users to an Organisation root, and the associated lockdown of `GET /api/users`, `GET /api/users/search`, and `GET /api/users/available`. Team_Transfer is a prerequisite for that work, not a part of it: auto-assignment lands users at an Organisation root, and those users must be relocatable into a real Sub_Team without destroying the federated account, which is exactly what this spec delivers.

## Glossary

Terms already defined by the `org-team-hierarchy` and `production-hardening` specs are restated here unchanged so this document is self-contained.

- **App**: The Express.js web API process defined in `server/index.js`.
- **Client**: The React single-page application in `client/src`.
- **Database**: The PostgreSQL instance accessed via the connection pool in `server/config/database.js`.
- **Authentik**: The external OAuth2/LDAP identity provider integrated with via its REST API v3.
- **Sync_Operation**: A row in the `sync_operations` table representing a queued, asynchronous action against Authentik, enqueued via `EventPublisher.publishOperation`.
- **Team**: A row in the `teams` table.
- **Organisation**: A Team whose `parent_team_id` is `NULL` (the root of a hierarchy).
- **Sub_Team**: A Team whose `parent_team_id` is not `NULL`.
- **Ancestor_Chain**: For a given Team, the ordered sequence of Teams from that Team's Organisation down to and including that Team itself, following `parent_team_id` links.
- **Global_Manager**: A user whose cached `is_global_manager` attribute is true.
- **Team_Admin**: A user who holds a direct (non-inherited, `inherited_from_team_id IS NULL`) `team_memberships` row with `role = 'admin'` for a given Team, OR who holds such a row for any Team in that Team's Ancestor_Chain, as computed by `Team.isAdmin`.
- **Visible_Branch**: For a given viewing user, a Team T is a Visible_Branch if EITHER T's `visibility` is `public` AND no Team in T's Ancestor_Chain (including T itself) has `visibility` set to `private`, OR the viewing user is a member or Team_Admin of T or of any Team in T's Ancestor_Chain, OR the viewing user is a Global_Manager. Computed by `TeamVisibilityService.isVisibleBranch`.
- **Direct_Membership**: A user's single `team_memberships` row with `inherited_from_team_id IS NULL`, constrained system-wide to at most one per user by the partial unique index `idx_team_memberships_one_direct_per_user`. The only `role` values a Direct_Membership holds are `member` and `admin`; `inherited` is reserved for rows with a non-null `inherited_from_team_id`. No other value occurs: `SELECT DISTINCT role FROM team_memberships` returns only `admin`, `inherited`, and `member`, and no code path writes any other value. The demotion rule of Requirement 10 is therefore total over the real role domain.
- **Primary_Channel**: A row in the `channels` table with `is_primary = true` — the single Channel automatically associated with a Team and used for that Team's default Channel membership assignment.
- **Member_List**: The members/admins tables rendered on the Team Detail page's Members and Team Admins tabs (`client/src/pages/TeamDetail.jsx`).
- **Callsign_Suffix**: The per-user `users.callsign_suffix` value used as the Name segment of every generated callsign, unique (case-insensitively) within a Team's Member_List per `CallsignSuffixUniquenessService.checkCallsignSuffixUniqueness`.
- **Callsign_Generator**: The existing logic that computes a user's TAK callsign, colour, and role attributes from their Ancestor_Chain (`computeCallsignAttributes` in `server/services/userAttributes.js`, assembled by `CallsignService.assembleCallsign`).
- **Access_Request**: A row in the `access_requests` table, processed by `RequestApprovalService`.
- **Permission_Registry**: The route-to-permission-identifier map in `server/config/permissions.registry.js`.
- **Authorization_Middleware**: The middleware in `server/middleware/authorize.js` that consults the Permission_Registry on every authenticated request and denies any route with no registry entry.
- **Row_Scoped_Resolver**: An entry in `authorize.js`'s `rowScopedResolvers` map that grants a single permission identifier for a single request by inspecting request parameters, body, or Database rows.
- **Team_Transfer**: The operation of changing a user's Direct_Membership from a Source_Team to a Destination_Team, together with the Channel, callsign, and role consequences specified in this document.
- **Source_Team**: The Team named by the transferred user's Direct_Membership at the moment a Team_Transfer is initiated.
- **Destination_Team**: The Team the transferred user is to hold a Direct_Membership in after a Team_Transfer completes.
- **Transferred_User**: The user whose Direct_Membership a Team_Transfer changes.
- **Initiating_Admin**: The authenticated user who initiates a Team_Transfer.
- **Dual_Admin**: An Initiating_Admin who is a Team_Admin of both the Source_Team and the Destination_Team, or who is a Global_Manager.
- **Transfer_Request**: An `access_requests` row with `request_type = 'team_change'`, recording a Team_Transfer awaiting approval.
- **Approval_Team**: The Team whose Team_Admins are authorized to approve or deny a specific Transfer_Request, recorded on that Transfer_Request at creation time.
- **Transfer_Service**: The server-side component that executes a Team_Transfer, invoked both by the immediate-execution path and by the Transfer_Request approval path.

## Requirements

### Requirement 1: Non-Destructive Team Transfer Endpoint

**User Story:** As a Team_Admin, I want to move an existing member to another team without deleting their account, so that a federated OIDC/LDAP identity survives the move.

#### Acceptance Criteria

1. THE App SHALL expose a route `POST /api/users/:userId/transfer` accepting a JSON body containing an integer `targetTeamId`, an optional `justification` string of at most 500 characters, and an optional `callsignSuffix` string of at most 255 characters.
2. WHEN `POST /api/users/:userId/transfer` is called with a `targetTeamId` that names no row in the `teams` table, THE App SHALL respond with status 400 and leave every `team_memberships`, `channel_memberships`, `users`, and `access_requests` row unchanged.
3. WHEN `POST /api/users/:userId/transfer` is called with a `:userId` that names no row in the `users` table, THE App SHALL respond with status 404.
4. IF the user named by `:userId` holds no Direct_Membership, THEN THE App SHALL respond with status 400 and a message stating that the user has no current team.
5. IF the user named by `:userId` holds a Direct_Membership in the Team named by `targetTeamId`, THEN THE App SHALL respond with status 400 and a message stating that the user is already a member of that team.
6. THE App SHALL complete a Team_Transfer without issuing any Authentik user-deletion request and without deleting any row from the `users` or `user_cache` tables.
7. WHERE the Team named by `targetTeamId` and the Source_Team belong to different Organisations AND the Initiating_Admin is not a Global_Manager, THE App SHALL respond with status 400 and a message stating that a transfer is limited to teams within one organisation.
8. IF the `:userId` route parameter names the requesting user themselves, THEN THE App SHALL respond with status 400 and a message stating that an admin cannot transfer their own membership, SHALL perform no Team_Transfer, and SHALL insert no `access_requests` row.

**Note on Criterion 8:** a self-transfer would demote the acting user per Requirement 10 Criterion 1 and could remove the last Team_Admin from the Source_Team, and the acting user cannot be relied on to be a disinterested Approval_Team for their own move. The rejection applies to a Global_Manager as well; a Global_Manager who needs to move their own membership can have another Global_Manager or a Team_Admin of either side initiate the transfer.

### Requirement 2: Dual-Admin Authorization Determines Immediate Versus Pending

**User Story:** As a Team_Admin, I want a transfer I have authority over on both sides to take effect immediately, and any other transfer to require the other side's agreement, so that no team can unilaterally take or push a member.

#### Acceptance Criteria

1. THE Permission_Registry SHALL map `POST /api/users/:userId/transfer` to the permission identifier `user:team:transfer`.
2. THE Authorization_Middleware SHALL hold a Row_Scoped_Resolver for `user:team:transfer` that returns true WHEN the requesting user is a Global_Manager, OR WHEN the requesting user is a Team_Admin of the Source_Team, OR WHEN the requesting user is a Team_Admin of the Team named by `targetTeamId`.
3. IF the requesting user is a Team_Admin of neither the Source_Team nor the Team named by `targetTeamId` AND is not a Global_Manager, THEN THE Authorization_Middleware SHALL respond with status 403.
4. WHEN the Initiating_Admin is a Dual_Admin, THE App SHALL execute the Team_Transfer immediately, SHALL insert no `access_requests` row, and SHALL respond with status 200 and a body whose `status` field equals `completed`.
5. WHEN the Initiating_Admin is a Team_Admin of exactly one of the Source_Team and the Destination_Team, THE App SHALL create a Transfer_Request, SHALL leave every `team_memberships` and `channel_memberships` row unchanged, and SHALL respond with status 202 and a body whose `status` field equals `pending_approval` and whose `requestId` field holds the created `access_requests` row's id.
6. THE App SHALL determine Team_Admin status for both the Source_Team and the Destination_Team using `Team.isAdmin`, so that a Team_Admin of any Team in either Team's Ancestor_Chain is treated as a Team_Admin of that Team.

### Requirement 3: Transfer Request Creation

**User Story:** As the admin of a team losing a member, I want a transfer another team initiated to arrive as a pending item I can act on, so that a member leaves my team only with my agreement.

#### Acceptance Criteria

1. WHEN THE App creates a Transfer_Request, THE App SHALL insert an `access_requests` row with `request_type` set to `team_change`, `existing_user_id` set to the Transferred_User's `users.id`, `current_team_id` set to the Source_Team's id, `target_team_id` set to the Destination_Team's id, `status` set to `pending`, and `justification` set to the submitted `justification` value or `NULL` when that value is absent.
2. THE Database SHALL provide nullable `access_requests` columns `approval_team_id` (referencing `teams(id)`) and `initiated_by` (referencing `users(id)`), added by an additive migration in `database/migrations` that leaves every existing `access_requests` row's other column values unchanged.
3. WHEN THE App creates a Transfer_Request, THE App SHALL set `initiated_by` to the Initiating_Admin's `users.id` and SHALL set `approval_team_id` to the Source_Team's id WHEN the Initiating_Admin is a Team_Admin of the Destination_Team, and to the Destination_Team's id WHEN the Initiating_Admin is a Team_Admin of the Source_Team.
4. WHEN THE App creates a Transfer_Request, THE App SHALL set `requester_email`, `requester_first_name`, and `requester_last_name` to the Initiating_Admin's own email, first name, and last name, so that the existing approval and denial emails sent by `RequestApprovalService` reach the Initiating_Admin.
5. WHEN THE App creates a Transfer_Request, THE App SHALL set `email_verified` to `true` and SHALL send no verification email, because the Initiating_Admin's identity is already established by the authenticated session.
6. WHEN THE App creates a Transfer_Request, THE App SHALL set `assigned_to_admin` to the `users.id` of one user holding a direct `team_memberships` row with `role` of `admin` for the Approval_Team, or leave `assigned_to_admin` as `NULL` WHEN the Approval_Team has no such row.
7. IF an `access_requests` row already exists with `request_type` of `team_change`, `status` of `pending`, and `existing_user_id` equal to the Transferred_User's id, THEN THE App SHALL respond with status 409, SHALL perform no Team_Transfer, and SHALL insert no additional `access_requests` row, regardless of whether the Initiating_Admin is a Dual_Admin.
8. WHEN a Transfer_Request is created, THE App SHALL store the submitted `callsignSuffix` value in the `access_requests.callsign_suffix` column, or `NULL` WHEN that value is absent.

**Note on Criterion 6:** two existing queries (`RequestApprovalService.js` and `EscalationService.js`) select on `role IN ('admin', 'owner')`, but no code path writes `'owner'`, no `team_memberships` row holds it, and no CHECK constraint admits it. That predicate is dead defensive code, so this document specifies `'admin'` only.

**Note on Criterion 7:** the check applies on the immediate-execution path of Requirement 2 Criterion 4 as well as on the Transfer_Request creation path. A pending Transfer_Request is blocking rather than superseded: it carries a justification and an outstanding Approval_Team decision that should be resolved deliberately through approval or denial rather than silently discarded by a second transfer attempt.

### Requirement 4: Transfer Request Visibility

**User Story:** As the admin of the approving team, I want a pending transfer to appear in my Requests list, so that I discover it without being told out of band.

#### Acceptance Criteria

1. WHEN a Global_Manager calls `GET /api/requests/pending`, THE App SHALL include every `access_requests` row with `status` of `pending` and `email_verified` of `true`, including rows with `request_type` of `team_change`.
2. WHEN a user who is not a Global_Manager calls `GET /api/requests/pending`, THE App SHALL include every `access_requests` row with `status` of `pending`, `email_verified` of `true`, and `request_type` of `team_change` whose `approval_team_id` names a Team of which the requesting user is a Team_Admin.
3. THE App SHALL include, for each returned row with `request_type` of `team_change`, the Source_Team's hierarchy path, the Destination_Team's hierarchy path, the Transferred_User's first name, last name, and email, and the Initiating_Admin's first name and last name.
4. THE App SHALL determine Team_Admin status for Criterion 2 using `Team.isAdmin` against each candidate row's `approval_team_id`, so that a Team_Admin of a Team above the Approval_Team in its Ancestor_Chain sees that row.

### Requirement 5: Transfer Request Approval and Denial Authorization

**User Story:** As a Team_Admin, I want the ability to act on the pending requests I can already see, so that the Requests page is not a read-only list that returns 403 on every action.

#### Acceptance Criteria

1. THE Authorization_Middleware SHALL hold a Row_Scoped_Resolver for `request:approve` and a Row_Scoped_Resolver for `request:deny`, each of which returns true WHEN the requesting user is a Global_Manager.
2. WHERE the `access_requests` row named by `:requestId` has `request_type` of `team_change`, THE Row_Scoped_Resolvers for `request:approve` and `request:deny` SHALL return true WHEN the requesting user is a Team_Admin of the Team named by that row's `approval_team_id`.
3. WHERE the `access_requests` row named by `:requestId` has `request_type` of `new_account`, THE Row_Scoped_Resolvers for `request:approve` and `request:deny` SHALL return true WHEN the requesting user is a Team_Admin of the Team named by that row's `target_team_id`.
4. WHERE the `access_requests` row named by `:requestId` has `request_type` of `role_change` or `name_change`, THE Row_Scoped_Resolvers for `request:approve` and `request:deny` SHALL return true WHEN the requesting user is a Team_Admin of the Team named by that row's `current_team_id`.
5. IF the `:requestId` route parameter names no `access_requests` row, THEN THE Row_Scoped_Resolvers for `request:approve` and `request:deny` SHALL return false, and THE Authorization_Middleware SHALL respond with status 403.
6. THE Authorization_Middleware SHALL continue to respond with status 403 for a denied `request:approve` or `request:deny` check, because the 404 mapping in `PERMISSION_DENIALS_MAPPED_TO_404` applies to `team:read` only.

### Requirement 6: Transfer Execution

**User Story:** As an operator, I want an approved transfer and an immediate transfer to produce identical results, so that the outcome does not depend on which path was taken.

#### Acceptance Criteria

1. THE Transfer_Service SHALL expose one method that performs a Team_Transfer, and THE App SHALL invoke that same method from both the immediate-execution path of Requirement 2 Criterion 4 and the Transfer_Request approval path.
2. WHEN a Team_Transfer completes, THE Database SHALL hold exactly one Direct_Membership row for the Transferred_User, naming the Destination_Team.
3. WHEN a Team_Transfer completes, THE Database SHALL hold one `team_memberships` row with `role` of `inherited` and `inherited_from_team_id` set to the Destination_Team's id for each Team in the Destination_Team's Ancestor_Chain other than the Destination_Team itself.
4. WHEN a Team_Transfer completes, THE Database SHALL hold one `channel_memberships` row for the Transferred_User for each Primary_Channel of each Team in the Destination_Team's Ancestor_Chain.
5. WHEN any single step of a Team_Transfer fails, THE App SHALL roll back every Database write made by that Team_Transfer, SHALL leave the Transferred_User's Direct_Membership naming the Source_Team, and SHALL leave any associated Transfer_Request's `status` as `pending`.
6. WHERE a Team_Transfer is performed through the Transfer_Request approval path, THE App SHALL perform the `access_requests` status update to `approved` and every membership write on one Database transaction, so that both commit together or neither commits.
7. WHERE a Team_Transfer moves the Transferred_User from an Organisation to a Sub_Team of that Organisation, THE App SHALL use the same Transfer_Service method as any other Team_Transfer.
8. WHEN a Team_Transfer completes, THE App SHALL have enqueued exactly one `add_user_to_group` Sync_Operation for the Transferred_User for each Primary_Channel of each Team in the Destination_Team's Ancestor_Chain that holds a non-null `authentik_group_id`, and SHALL have enqueued every such Sync_Operation on the same Database transaction as the membership writes of Criteria 2 through 4.

**Note on Criterion 8:** this behaviour is already supplied by the existing `TeamMembershipService.addUserToTeam`, which walks the Destination_Team's Ancestor_Chain, inserts the `channel_memberships` rows, and enqueues one `add_user_to_group` Sync_Operation per Primary_Channel holding an `authentik_group_id`. It is stated as an acceptance criterion because no existing criterion covers it, leaving the destination half of a Team_Transfer's Authentik effect unspecified and untested.

### Requirement 7: Source Team Access Revocation

**User Story:** As a security-conscious operator, I want a transferred member to lose access to their former team's channels, so that a transfer is not a silent grant of standing access to a team the member has left.

#### Acceptance Criteria

1. WHEN a Team_Transfer completes, THE Database SHALL hold no `channel_memberships` row for the Transferred_User naming a Channel whose owning Team is absent from the Destination_Team's Ancestor_Chain.
2. WHEN a Team_Transfer completes, THE App SHALL have enqueued one `remove_user_from_group` Sync_Operation for the Transferred_User for each Channel identified in Criterion 1 that holds a non-null `authentik_group_id`.
3. THE App SHALL enqueue every Sync_Operation described in Criterion 2 on the same Database transaction as the membership writes of Requirement 6, so that a rolled-back Team_Transfer enqueues no Sync_Operation.
4. WHERE a Channel's owning Team appears in both the Source_Team's Ancestor_Chain and the Destination_Team's Ancestor_Chain, THE App SHALL retain the Transferred_User's `channel_memberships` row for that Channel and SHALL enqueue no `remove_user_from_group` Sync_Operation for it.

### Requirement 8: Callsign Regeneration

**User Story:** As a TAK operator, I want a transferred member's callsign to name their new team, so that the callsign shown in TAK matches where the member actually is.

#### Acceptance Criteria

1. WHEN a Team_Transfer commits, THE App SHALL compute the Transferred_User's callsign, colour, and TAK role from the Destination_Team's Ancestor_Chain using the Callsign_Generator.
2. WHEN a Team_Transfer commits, THE App SHALL store the computed callsign, colour, and TAK role in the Transferred_User's `user_cache` row.
3. WHEN a Team_Transfer commits, THE App SHALL send the computed callsign, colour, and TAK role to Authentik for the Transferred_User.
4. THE App SHALL issue the Authentik request described in Criterion 3 after the Database transaction of Requirement 6 has committed, so that no external HTTP request is issued while a transaction is open.
5. IF the Authentik request described in Criterion 3 fails, THEN THE App SHALL record the failure through the structured logger and SHALL respond with status 200, leaving the committed membership change in place.
6. WHERE the Destination_Team is an Organisation, THE App SHALL produce a callsign containing the Organisation's callsign prefix and the Transferred_User's Callsign_Suffix, with no Sub_Team segment.

**Note on Criterion 5:** no additional retry mechanism is required. The existing periodic Authentik synchronisation treats `tak_callsign`, `tak_color`, and `tak_role` as locally authoritative and pushes the local values to Authentik whenever they differ, so a failed post-commit push is corrected within one synchronisation interval.

### Requirement 9: Callsign Suffix Collision Handling

**User Story:** As a Team_Admin, I want a transfer blocked by a duplicate callsign suffix to tell me the conflicting value and let me supply a different one, so that I can complete the move without reading server logs.

#### Acceptance Criteria

1. WHEN a Team_Transfer is attempted AND the Transferred_User's Callsign_Suffix matches, case-insensitively, the Callsign_Suffix of another member of the Destination_Team's Member_List, THE App SHALL respond with status 400 and a message naming the conflicting Callsign_Suffix value.
2. WHEN THE App responds as described in Criterion 1, THE Database SHALL hold the Transferred_User's Direct_Membership naming the Source_Team, and any associated Transfer_Request SHALL hold `status` of `pending`.
3. WHERE the request body of `POST /api/users/:userId/transfer` contains a non-empty `callsignSuffix`, THE App SHALL store that value in the Transferred_User's `users.callsign_suffix` column on the same Database transaction as the membership writes of Requirement 6, and SHALL check that value for uniqueness against the Destination_Team's Member_List.
4. WHERE the request body of `POST /api/requests/:requestId/approve` contains a non-empty `callsignSuffix` AND the named `access_requests` row has `request_type` of `team_change`, THE App SHALL store that value in the Transferred_User's `users.callsign_suffix` column on the approval transaction and SHALL check that value for uniqueness against the Destination_Team's Member_List.
5. WHEN THE App stores a new Callsign_Suffix per Criterion 3 or Criterion 4, THE App SHALL mirror that value to the Transferred_User's `user_cache` row.
6. THE Client SHALL display the message returned per Criterion 1 alongside an input control for a replacement callsign suffix, and SHALL resubmit the transfer with that value WHEN the operating user confirms it.
7. THE App SHALL resolve the Callsign_Suffix used by a Team_Transfer to the first available of: the non-empty `callsignSuffix` supplied on the call that executes the Team_Transfer, then the non-null `access_requests.callsign_suffix` value stored on the associated Transfer_Request, then the Transferred_User's existing `users.callsign_suffix` value.
8. THE App SHALL apply the uniqueness check of Criterion 1 to the value resolved per Criterion 7, so that the checked value is always the value the Team_Transfer uses.

### Requirement 10: Team Admin Demotion on Transfer

**User Story:** As a Team_Admin, I want a transferred admin to arrive as a plain member, so that admin authority over a team is always granted explicitly by that team.

#### Acceptance Criteria

1. WHEN a Team_Transfer completes, THE Database SHALL hold the Transferred_User's Direct_Membership with `role` set to `member`.
2. WHEN a Team_Transfer is initiated for a Transferred_User whose Direct_Membership holds `role` of `admin`, THE App SHALL include in its response a field named `demotedFromAdmin` set to `true`.
3. WHEN a Team_Transfer is initiated for a Transferred_User whose Direct_Membership holds `role` other than `admin`, THE App SHALL include in its response a field named `demotedFromAdmin` set to `false`.
4. WHILE the transfer confirmation dialog is displayed for a Transferred_User whose Direct_Membership holds `role` of `admin`, THE Client SHALL display a statement that the transfer removes the user's admin rights and that admin rights must be granted again in the Destination_Team.
5. WHEN a Team_Transfer completes for a Transferred_User whose Direct_Membership held `role` of `admin`, THE App SHALL record the prior role in the audit log entry required by Requirement 14.

### Requirement 11: Stale Transfer Request Rejection

**User Story:** As an approving admin, I want a transfer request that no longer matches reality to be rejected rather than silently applied, so that an approval never produces a wrong or misleading result.

#### Acceptance Criteria

1. WHEN a Transfer_Request is approved AND the Transferred_User's Direct_Membership names a Team other than the row's `current_team_id`, THE App SHALL roll back the approval transaction, SHALL leave the row's `status` as `pending`, and SHALL respond with status 409 and a message stating that the user's team changed since the request was created.
2. WHEN a Transfer_Request is approved AND the row's `existing_user_id` names no row in the `users` table, THE App SHALL roll back the approval transaction, SHALL leave the row's `status` as `pending`, and SHALL respond with an error status.
3. WHEN a Transfer_Request is approved AND the row's `target_team_id` names no row in the `teams` table, THE App SHALL roll back the approval transaction, SHALL leave the row's `status` as `pending`, and SHALL respond with an error status.
4. WHEN a Transfer_Request is approved AND the row's `status` is other than `pending`, THE App SHALL make no membership change and SHALL respond with an error status.
5. WHEN a Transfer_Request whose `status` is `pending` is approved twice concurrently, THE App SHALL apply the Team_Transfer at most once.
6. WHEN a Transfer_Request is approved, THE App SHALL re-evaluate whether the Source_Team and the Destination_Team belong to the same Organisation, and IF they belong to different Organisations AND the approving user is not a Global_Manager, THEN THE App SHALL roll back the approval transaction, SHALL leave the row's `status` as `pending`, and SHALL respond with an error status.

**Note on Criterion 6:** `PUT /api/teams/:teamId` can change a Team's `parent_team_id`, so either Team's Organisation can change between the creation of a Transfer_Request and its approval. Requirement 1 Criterion 7's initiation-time check can therefore be invalidated while a Transfer_Request sits pending, and the same constraint — including its Global_Manager exemption, evaluated against the approving user — is re-applied at execution time.

### Requirement 12: Transfer Denial

**User Story:** As the admin of a team losing a member, I want to decline a transfer with a reason, so that the requesting admin learns why the move did not happen.

#### Acceptance Criteria

1. WHEN a Team_Admin of the Approval_Team calls `POST /api/requests/:requestId/deny` for a Transfer_Request with a non-empty `denialReason`, THE App SHALL set that row's `status` to `denied`, `processed_by` to the denying user's `users.id`, `processed_at` to the current timestamp, and `denial_reason` to the submitted reason.
2. WHEN a Transfer_Request is denied, THE Database SHALL hold the Transferred_User's Direct_Membership naming the Source_Team, and SHALL hold the Transferred_User's `channel_memberships` rows unchanged.
3. WHEN a Transfer_Request is denied, THE App SHALL send the denial email to the Initiating_Admin's email address, including the submitted reason.
4. IF sending the email described in Criterion 3 fails, THEN THE App SHALL record the failure through the structured logger and SHALL respond with status 200, leaving the row's `status` as `denied`.
5. WHEN `POST /api/requests/:requestId/deny` is called with an empty or absent `denialReason`, THE App SHALL respond with status 400 and leave the row's `status` as `pending`.
6. WHEN `POST /api/requests/:requestId/deny` is called with a `denialReason` longer than 1000 characters, THE App SHALL respond with status 400 and leave the row's `status` as `pending`.

**Note on Criterion 6:** this tightens the existing `POST /api/requests/:requestId/deny` route, which validates a non-empty minimum only and accepts a reason of unbounded length.

### Requirement 13: Transfer Notification

**User Story:** As a transferred member, I want to be told that my team and callsign changed, so that I am not surprised when my TAK callsign differs from what I used yesterday.

#### Acceptance Criteria

1. WHEN a Team_Transfer commits, THE App SHALL send an email to the Transferred_User's `users.email` address stating the Destination_Team's hierarchy path and the callsign computed per Requirement 8.
2. THE Database SHALL hold an `email_templates` row with `template_key` of `team_transfer_completed`, inserted by a migration in `database/migrations` that leaves an existing row with that `template_key` unchanged.
3. THE email template named in Criterion 2 SHALL accept the substitution variables `first_name`, `team_path`, and `callsign`.
4. IF sending the email described in Criterion 1 fails, THEN THE App SHALL record the failure through the structured logger and SHALL respond with status 200, leaving the committed Team_Transfer in place.
5. WHERE the Transferred_User's `users.is_team_device` value is `true`, THE App SHALL send no email, because such a record holds a synthetic, non-deliverable address.

### Requirement 14: Transfer Audit Logging

**User Story:** As a compliance reviewer, I want every completed transfer recorded, so that I can answer who moved which member, from where, to where, and when.

#### Acceptance Criteria

1. WHEN a Team_Transfer commits, THE App SHALL insert an `audit_logs` row with `action` of `user.team_transfer`, `resource_type` of `user`, `resource_id` of the Transferred_User's `users.id`, and `user_id` of the `users.id` of the user who performed or approved the Team_Transfer.
2. THE `audit_logs` row described in Criterion 1 SHALL hold a `details` value containing the Source_Team's id, the Destination_Team's id, the Transferred_User's role in the Source_Team, and a boolean indicating whether the Team_Transfer was approved through a Transfer_Request.
3. WHERE a Team_Transfer was approved through a Transfer_Request, THE `details` value described in Criterion 2 SHALL additionally hold that Transfer_Request's `access_requests.id` and its `initiated_by` value.
4. IF inserting the `audit_logs` row described in Criterion 1 fails, THEN THE App SHALL record the failure through the structured logger and SHALL respond with status 200, matching the existing audit-write behaviour in `server/routes/requests.js` and `server/routes/teams.js`.

### Requirement 15: Client Transfer Initiation

**User Story:** As a Team_Admin viewing a team, I want a transfer action on each member row, so that I can move a member from the page where I already manage them.

#### Acceptance Criteria

1. WHILE the operating user is a Team_Admin of the displayed Team or a Global_Manager, THE Client SHALL display a transfer action on each Member_List row whose `role` is `member` or `admin`.
2. WHEN the operating user activates the transfer action, THE Client SHALL display a dialog containing a Destination_Team selection control listing only Teams that are a Visible_Branch for the operating user.
3. THE Client SHALL exclude the displayed Team from the Destination_Team selection control.
4. WHILE the transfer dialog is displayed, THE Client SHALL display a statement that the transfer changes the member's TAK callsign.
5. WHEN THE App responds with status 200 and a `status` field of `completed`, THE Client SHALL refresh the displayed Member_List and display a confirmation that the member was transferred.
6. WHEN THE App responds with status 202 and a `status` field of `pending_approval`, THE Client SHALL display a statement that the transfer awaits approval by the other team, and SHALL leave the displayed Member_List unchanged.
7. IF THE App responds with status 400, 403, 404, or 409, THEN THE Client SHALL display the message from the response body and SHALL keep the transfer dialog open.
8. WHERE the operating user is not a Global_Manager, THE Client SHALL offer in the Destination_Team selection control only Teams within the Source_Team's Organisation, so that a selection Requirement 1 Criterion 7 would reject cannot be made.
9. WHERE the operating user is a Global_Manager, THE Client MAY offer in the Destination_Team selection control Teams outside the Source_Team's Organisation.

### Requirement 16: Client Transfer Review

**User Story:** As the admin of an approving team, I want a pending transfer rendered with both teams and the member named, so that I can decide without opening another page.

#### Acceptance Criteria

1. WHEN the Requests page renders an Access_Request whose `request_type` is `team_change`, THE Client SHALL display the Transferred_User's name and email, the Source_Team's hierarchy path, the Destination_Team's hierarchy path, the Initiating_Admin's name, the submitted justification, and the submission timestamp.
2. WHEN the Requests page renders an Access_Request whose `request_type` is `team_change`, THE Client SHALL display an approve control and a deny control.
3. WHEN the Requests page renders an Access_Request whose `request_type` is `team_change`, THE Client SHALL display a statement that approval removes the member's admin rights in the Source_Team.
4. WHEN the operating user activates the deny control, THE Client SHALL require a non-empty denial reason before submitting.
5. WHEN an approve or deny action succeeds, THE Client SHALL remove that Access_Request from the displayed list and SHALL update the pending-request count badge.
6. IF an approve or deny action returns a non-success status, THEN THE Client SHALL display the message from the response body and SHALL retain that Access_Request in the displayed list.

### Requirement 17: Automated Test Coverage for Transfer

**User Story:** As a maintainer, I want the transfer paths covered by automated tests, so that the two correctness gaps described in the Introduction cannot silently return.

#### Acceptance Criteria

1. THE Repository SHALL contain Jest tests asserting that the Row_Scoped_Resolver for `user:team:transfer` returns true for a Global_Manager, true for a Team_Admin of the Source_Team, true for a Team_Admin of the Destination_Team, and false for a user who is a Team_Admin of neither.
2. THE Repository SHALL contain Jest tests asserting that a Dual_Admin transfer inserts no `access_requests` row and that a single-side transfer inserts an `access_requests` row with `request_type` of `team_change` and a populated `approval_team_id`.
3. THE Repository SHALL contain a Jest test asserting that a completed Team_Transfer leaves no `channel_memberships` row for a Channel of a Team absent from the Destination_Team's Ancestor_Chain, and enqueues a `remove_user_from_group` Sync_Operation for each such Channel holding an `authentik_group_id`.
4. THE Repository SHALL contain a Jest test asserting that a completed Team_Transfer stores a callsign derived from the Destination_Team's Ancestor_Chain in the Transferred_User's `user_cache` row.
5. THE Repository SHALL contain a Jest test asserting that a Callsign_Suffix collision in the Destination_Team produces status 400 and leaves the Transferred_User's Direct_Membership naming the Source_Team.
6. THE Repository SHALL contain a Jest test asserting that approving a Transfer_Request whose Transferred_User has since moved to a different Team leaves that row's `status` as `pending`.
7. THE Repository SHALL contain Vitest tests asserting that the Client transfer dialog states the admin-demotion consequence for an admin member, and that a 400 response keeps the dialog open with the server message displayed.
8. THE Repository SHALL sustain the statement coverage threshold of 60 percent enforced by the existing CI configuration after the additions described in Criteria 1 through 7 and Criterion 9.
9. THE Repository SHALL contain a Jest test asserting that a completed Team_Transfer enqueues one `add_user_to_group` Sync_Operation for the Transferred_User for each Primary_Channel of each Team in the Destination_Team's Ancestor_Chain holding a non-null `authentik_group_id`, as the counterpart to the `remove_user_from_group` assertion of Criterion 3.
