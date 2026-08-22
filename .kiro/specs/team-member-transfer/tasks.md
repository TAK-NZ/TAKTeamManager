# Implementation Plan: Team Member Transfer

## Overview

Implementation order follows the risk gradient in the design: additive migrations first, then the authorization layer (deny-by-default registry, then resolvers, each independently unit-testable before any route exists), then the `FOR UPDATE OF ar` row lock in isolation so the existing `new_account`/`role_change`/`name_change` approval suites verify it before `team_change` work layers on top, then `TeamTransferService` (transactional core, then post-commit effects), then the two callers, then `GET /api/requests/pending`, then the Client.

Language: JavaScript (CommonJS on the server, JSX/ESM on the client), matching the existing codebase. No new dependency is required — `@fast-check/jest` 2.2.0 and `fast-check` 4.9.0 are already devDependencies.

Conventions every task below inherits:

- Server tests are Jest, client tests are Vitest.
- Property tests use `test.prop([...], { numRuns: 100 })` and compute the expected value by walking the generated data directly, never by calling back into the code under test (`server/services/TeamVisibilityService.test.js` Property 9 is the model).
- Every property test carries the tag comment `// Feature: team-member-transfer, Property N: <property statement>` immediately above it.
- Exactly one property-based test implements each of Properties 1–29. No property is split across tests; no test covers two properties.
- `TeamMembershipService.addUserToTeam` is **not** modified by any task (design decision 2). `TeamTransferService` wraps it.
- `*.integration.test.js` files are excluded from `npm test` by `testPathIgnorePatterns` in `package.json` and require a live Postgres. Run them explicitly against the local test container using the `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` defaulting convention already at the top of `server/routes/requests.approval.integration.test.js` (localhost:15433), e.g. `npx jest server/routes/users.transfer.integration.test.js --testPathIgnorePatterns=/node_modules/ /client/`.
- After every task the repository must be left green: `npm test -- --coverage` (60 percent statement gate), `npm run lint`, `npm run lint:pinned-deps`, and the client Vitest suite.

## Tasks

- [x] 1. Database migrations
  - [x] 1.1 Add `access_requests.approval_team_id` and `initiated_by` with their two partial indexes
    - Create `database/migrations/<timestamp>_add-access-requests-transfer-columns.cjs` using the node-pg-migrate schema-builder API (`pgm.addColumn`, `pgm.createIndex`), not raw SQL
    - Both columns nullable, no default, `approval_team_id` referencing `teams(id)` and `initiated_by` referencing `users(id)`, each with the column comment from the design
    - Create `idx_access_requests_approval_team_pending` on `approval_team_id` with `where: "status = 'pending' AND request_type = 'team_change'"`
    - Create `idx_access_requests_one_pending_team_change_per_user` as a **unique** partial index on `existing_user_id` with the same predicate
    - Use `ifNotExists` on every addition, matching `1786880000000_add-access-requests-signup-code-used.cjs`
    - Write a `down` that drops both indexes and both columns
    - _Requirements: 3.2, 3.7_

  - [x] 1.2 Seed the `team_transfer_completed` email template
    - Create `database/migrations/<timestamp>_seed-team-transfer-completed-email-template.cjs` following `1786900000000_seed-signup-email-templates.cjs`
    - Insert into `email_templates` with `template_key` of `team_transfer_completed`, subject and body per the design, `ON CONFLICT (template_key) DO NOTHING`
    - Dollar-quote the body (`$tpl$...$tpl$`) unconditionally, per the design's note on the earlier `""`-escaping corruption
    - Body substitutes exactly `{{first_name}}`, `{{team_path}}`, `{{callsign}}` and no other variable
    - _Requirements: 13.2, 13.3_

  - [x] 1.3 Migration tests
    - Create `server/config/migrations.teamTransfer.integration.test.js`
    - Seed pre-existing `access_requests` rows and a pre-existing `team_transfer_completed` `email_templates` row, run both migrations, assert every other column value on the seeded rows is unchanged and the pre-existing template row is untouched
    - Run both migrations twice, asserting idempotence
    - _Requirements: 3.2, 13.2_

- [x] 2. Shared property-test generators
  - [x] 2.1 Create the transfer arbitraries fixture module
    - Create `server/services/__fixtures__/transferArbitraries.js` exporting: a hierarchy arbitrary (Organisation root plus Sub_Teams to `MAX_TEAM_DEPTH`, each with `callsign_prefix`, `visibility`, `callsign_level_selection`); a channel-layout arbitrary (each Team optionally holding a Primary_Channel with a sometimes-null `authentik_group_id`, **plus non-primary Channels** so the Requirement 6.8 / 7.1 asymmetry is reachable); an admin-placement arbitrary (direct `role = 'admin'` rows at any depth); a reparenting arbitrary (changes a Team's `parent_team_id` between two moments); and a Callsign_Suffix arbitrary including mixed case, non-ASCII, empty string, and whitespace-only values
    - Generated hierarchies must expose their parent-pointer data so tests can compute expectations by walking it
    - Required by Properties 1, 3, 7, 8, 14, 15, 16, 27, 29 — land it before any property test
    - _Requirements: 17.1, 17.3, 17.4, 17.9_

- [x] 3. Authorization layer
  - [x] 3.1 Register the transfer route permission
    - In `server/config/permissions.registry.js` add `'POST /api/users/:userId/transfer': ['user:team:transfer']`
    - Do **not** add `user:team:transfer`, `request:approve`, or `request:deny` to `roleDefaults.authenticated_user` — a statically held identifier bypasses the resolver entirely
    - _Requirements: 2.1_

  - [x] 3.2 Implement the `user:team:transfer` row-scoped resolver
    - In `server/middleware/authorize.js` add a `rowScopedResolvers` entry that returns true for a Global_Manager, then for `Team.isAdmin(req.body.targetTeamId, req.user.userId)`, then for `Team.isAdmin(<source team from the Direct_Membership of req.params.userId>, req.user.userId)`
    - Use `req.user.userId` (the local `users.id`), never `req.user.id`
    - Use the **existing module-scope `pool` import**. Do not introduce a function-scoped `const pool = require('../config/database')` — that shadowing pattern caused a total authentication outage in `server/middleware/auth.js` via a temporal dead zone
    - Let exceptions propagate; `isSatisfiedWithRowScopedChecks` catches and fails closed centrally, so add no local try/catch
    - A `:userId` with no `users` row or no Direct_Membership yields no source leg and is denied unless the destination leg or Global_Manager status grants
    - _Requirements: 2.2, 2.3, 2.6_

  - [x] 3.3 Implement the shared `request:approve` / `request:deny` resolver
    - In `server/middleware/authorize.js` add `resolveRequestActionPermission(req)` modelled on the existing `channel_request:process` resolver, and register it for both identifiers
    - Short-circuit true for a Global_Manager before any query
    - Load `request_type, approval_team_id, target_team_id, current_team_id` for `req.params.requestId`; select the gating column by type (`team_change` → `approval_team_id`, `new_account` → `target_team_id`, `role_change`/`name_change` → `current_team_id`); return false for zero rows, an unrecognised type, or a `NULL` gating value; otherwise return `Team.isAdmin(gatingTeamId, req.user.userId)`
    - Leave `PERMISSION_DENIALS_MAPPED_TO_404` untouched so denials stay 403
    - Same module-scope `pool` rule as 3.2
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 3.4 Write property test for the transfer resolver
    - In `server/middleware/authorize.test.js`, using the hierarchy and admin-placement arbitraries from 2.1
    - **Property 8: The transfer resolver grants exactly on the admin disjunction**
    - **Validates: Requirements 2.2, 2.3, 2.6**
    - Alongside it, add the four named examples of Requirement 17.1 (Global_Manager true, Source_Team admin true, Destination_Team admin true, neither false)
    - _Requirements: 17.1_

  - [x] 3.5 Write property test for the approve/deny gating column
    - In `server/middleware/authorize.test.js`, with distinct values in `approval_team_id`, `target_team_id`, and `current_team_id` so a wrong column is observable
    - **Property 15: The gating column is determined solely by request type**
    - **Validates: Requirements 5.2, 5.3, 5.4**
    - Add two examples: both resolvers short-circuit for a Global_Manager with no row lookup (Requirement 5.1), and an unknown `:requestId` returns false (Requirement 5.5)
    - _Requirements: 5.1, 5.5_

  - [x] 3.6 Extend the registry assertions
    - In `server/config/permissions.registry.test.js` assert the new route maps to `user:team:transfer`, that `user:team:transfer` is absent from `roleDefaults.authenticated_user`, and that neither `request:approve` nor `request:deny` was added to `PERMISSION_DENIALS_MAPPED_TO_404`
    - Confirm `permissions.registry.completeness.test.js` and `publicRoutes.completeness.test.js` still pass unchanged
    - _Requirements: 2.1, 5.6_

- [x] 4. Approval transaction row lock (affects all request types)
  - [x] 4.1 Add `FOR UPDATE OF ar` to the transactional re-fetch
    - In `server/services/RequestApprovalService.js`, append `FOR UPDATE OF ar` to the `SELECT ... WHERE ar.id = $1 AND ar.status = 'pending'` inside `approveRequest`'s transaction
    - `OF ar` is required: a bare `FOR UPDATE` is rejected by Postgres against the nullable side of the existing `LEFT JOIN`s
    - This changes behaviour for `new_account`, `role_change`, and `name_change` as well as `team_change`; land it alone so the existing approval suites verify it in isolation
    - _Requirements: 11.5_

  - [x] 4.2 Cover the lock in the existing approval unit tests
    - In `server/services/RequestApprovalService.test.js` assert the re-fetch SQL handed to the mocked client contains `FOR UPDATE OF ar`
    - Re-run `server/routes/requests.approval.integration.test.js` unchanged to confirm no regression on the existing request types
    - _Requirements: 11.5_

- [x] 5. Checkpoint - authorization and locking
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. TeamTransferService transactional core
  - [x] 6.1 Create the service, its typed errors, and the locked precondition step
    - Create `server/services/TeamTransferService.js` exporting `TeamTransferService` plus `NoCurrentTeamError`, `AlreadyInDestinationTeamError`, `SelfTransferError`, `StaleTransferRequestError`, `CrossOrganisationTransferError`, each carrying the data its response needs (following `CallsignSuffixConflictError`'s existing contract)
    - `executeTransfer(client, params)` takes `client` as a required first parameter, issues no `BEGIN`/`COMMIT`/`ROLLBACK`, and never calls `pool.connect()`
    - Step 1: `SELECT team_id, role FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL FOR UPDATE` on `client`; capture `priorRole` before any write; throw `NoCurrentTeamError` on zero rows, `AlreadyInDestinationTeamError` when the row already names the destination, `StaleTransferRequestError` when `expectedSourceTeamId` is set and differs
    - Step 2: resolve `Team.getAncestorChain` for both source and destination; throw `CrossOrganisationTransferError(sourceOrgId, destOrgId)` when the roots differ and `params.actorIsGlobalManager` is false. `actorIsGlobalManager` is a required parameter, not optional
    - Add the `TransferOutcome` typedef from the design
    - _Requirements: 1.4, 1.5, 1.7, 6.1, 11.1, 11.6_

  - [x] 6.2 Resolve and conditionally persist the Callsign_Suffix
    - Step 3 in `server/services/TeamTransferService.js`: resolve the precedence chain `params.callsignSuffix` → `params.requestCallsignSuffix` → `users.callsign_suffix` (read on `client`), treating `null`, `''`, and whitespace-only alike as absent
    - `UPDATE users SET callsign_suffix = $1 WHERE id = $2` on `client` only when the resolved value came from link (a) or (b); set `callsignSuffixApplied` accordingly and always set `callsignSuffixEffective`
    - Do not add a second uniqueness check — ordering this write before step 4 is what makes `addUserToTeam`'s existing `checkCallsignSuffixUniqueness` see the effective value
    - _Requirements: 9.3, 9.4, 9.7, 9.8_

  - [x] 6.3 Delegate the additive half and implement the subtractive half
    - Step 4: `await TeamMembershipService.addUserToTeam(userId, destinationTeamId, 'member', actorId, client)` with `'member'` hardcoded. Do not modify `TeamMembershipService`
    - Step 5: `DELETE FROM channel_memberships cm USING channels c WHERE cm.user_id = $1 AND cm.channel_id = c.id AND NOT (c.team_id = ANY($2::int[])) RETURNING c.id AS channel_id, c.authentik_group_id`, with `$2` the destination Ancestor_Chain ids. Must **not** copy `removeUserFromTeam`'s blanket `DELETE ... WHERE user_id = $1`, which would destroy Deployment_Channel rows on the polymorphic `channel_id` column
    - For each returned row with a non-null `authentik_group_id`, `EventPublisher.publishOperation('remove_user_from_group', { target_user_id, target_group_id }, actorId, client)` — threading `client` so a rollback enqueues nothing
    - Step 6: build and return the `TransferOutcome` (including `priorRole`, `demotedFromAdmin`, `revokedChannelIds`, `revokedAuthentikGroupIds`). No commit, no Authentik call, no email, no audit write
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 7.1, 7.2, 7.3, 7.4, 10.1_

  - [x] 6.4 Write property test for the membership end-state
    - In `server/services/TeamTransferService.test.js`
    - **Property 2: Membership end-state is exactly the destination shape**
    - **Validates: Requirements 6.2, 6.3, 6.7, 10.1**

  - [x] 6.5 Write property test for the channel end-state
    - In `server/services/TeamTransferService.test.js`, using the channel-layout arbitrary including non-primary channels and a non-`channels` (Deployment_Channel) `channel_memberships` row
    - **Property 3: Channel end-state equals the destination chain's channels**
    - **Validates: Requirements 6.4, 7.1, 7.4**
    - This is also the Requirement 17.3 revocation assertion
    - _Requirements: 17.3_

  - [x] 6.6 Write property test for revocation Sync_Operations
    - In `server/services/TeamTransferService.test.js`
    - **Property 4: Revoked channels with an Authentik group produce exactly one removal operation each**
    - **Validates: Requirements 7.2**

  - [x] 6.7 Write property test for destination Sync_Operations
    - In `server/services/TeamTransferService.test.js`, as the deliberate counterpart of Property 4
    - **Property 27: Destination-chain Primary_Channels with an Authentik group produce exactly one addition operation each**
    - **Validates: Requirements 6.8**
    - This is also the Requirement 17.9 assertion
    - _Requirements: 17.9_

  - [x] 6.8 Write property test for Callsign_Suffix resolution
    - In `server/services/TeamTransferService.test.js`, with all three links independently absent, empty, whitespace-only, or a value
    - **Property 29: The Callsign_Suffix used and the Callsign_Suffix checked are both the first available link**
    - **Validates: Requirements 9.7, 9.8**

  - [x] 6.9 Write property test for rollback totality
    - In `server/services/TeamTransferService.test.js`, injecting failure at each step of the sequence as well as exercising each rejection path
    - **Property 5: A transfer that does not succeed changes nothing**
    - **Validates: Requirements 1.2, 6.5, 6.6, 7.3, 9.2, 11.1, 11.2, 11.3, 11.4, 12.2**

  - [x] 6.10 Write property test for identity preservation
    - In `server/services/TeamTransferService.test.js`
    - **Property 6: A transfer never destroys an identity**
    - **Validates: Requirements 1.6**

- [x] 7. Post-commit effects
  - [x] 7.1 Implement `applyPostCommitEffects`
    - In `server/services/TeamTransferService.js`, five steps in this order, each in its own try/catch with a structured log line and no rethrow: `UserAttributesService.generateCallsign(userId, destinationTeamId)`; `user_cache` upsert (`INSERT ... ON CONFLICT (authentik_id) DO UPDATE`, located via `users.authentik_user_id::text = user_cache.authentik_id`, writing `callsign_suffix` only when `callsignSuffixApplied` is non-null); `UserAttributesService.updateUserAttributes`; `team_transfer_completed` email via `emailService.sendEmail`, skipped entirely when `users.is_team_device` is true; `audit_logs` insert with `action` of `user.team_transfer`, `resource_type` of `user`, `resource_id` of the Transferred_User, `user_id` of the actor, and the `details` JSON from the design (`requestId`/`initiatedBy` present only when `viaRequest`)
    - Skip steps 2–4 when the callsign computes to `null`; writing `NULL` to `user_cache` or Authentik is worse than leaving the prior value
    - The cache write must precede the Authentik PATCH — that ordering is what makes a failed PATCH self-correcting within one `SYNC_INTERVAL_MINUTES`
    - Build `team_path` from the destination chain with the `callsign_prefix || name` segment mapping and the separator already used in the surrounding file
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.5, 13.1, 13.3, 13.5, 14.1, 14.2, 14.3_

  - [x] 7.2 Write property test for callsign derivation
    - In `server/services/TeamTransferService.test.js`, over hierarchies with arbitrary `callsign_prefix` and `callsign_level_selection` values, including an Organisation destination
    - **Property 16: The callsign derives from the destination chain and nothing else**
    - **Validates: Requirements 8.1, 8.6**

  - [x] 7.3 Write property test for the `user_cache` round trip
    - In `server/services/TeamTransferService.test.js`, exercising the `::text` cast on the `authentik_user_id` join
    - **Property 17: Computed identity attributes round-trip into user_cache**
    - **Validates: Requirements 8.2, 9.5**
    - This is also the Requirement 17.4 assertion
    - _Requirements: 17.4_

  - [x] 7.4 Write property test for a supplied Callsign_Suffix
    - In `server/services/TeamTransferService.test.js`, covering both the immediate and approval entry values
    - **Property 19: A supplied Callsign_Suffix is applied on both paths**
    - **Validates: Requirements 9.3, 9.4**

  - [x] 7.5 Write property test for `demotedFromAdmin`
    - In `server/services/TeamTransferService.test.js`, over every Direct_Membership role
    - **Property 20: demotedFromAdmin reports the prior role**
    - **Validates: Requirements 10.2, 10.3**

  - [x] 7.6 Write post-commit failure examples
    - In `server/services/TeamTransferService.test.js`: `updateUserAttributes` receives the computed values and is invoked only after `COMMIT` is recorded; an Authentik failure, an email failure, and an `audit_logs` insert failure each leave the committed state in place and produce no throw; `is_team_device` true sends no email
    - _Requirements: 8.3, 8.4, 8.5, 13.4, 13.5, 14.4_

- [x] 8. Checkpoint - transfer service complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Immediate-execution route
  - [x] 9.1 Implement `POST /api/users/:userId/transfer`
    - In `server/routes/users.js`, validators `body('targetTeamId').isInt({ min: 1 }).toInt()`, `body('justification').optional().trim().isLength({ max: 500 })`, `body('callsignSuffix').optional().trim().isLength({ max: 255 })`
    - Handler in exactly this order: user existence → 404; self-transfer (`Number(req.params.userId) === req.user.userId`) → 400 via `SelfTransferError`, with no Global_Manager exemption; `validationResult` → 400; team existence → 400 (not 404); Direct_Membership absent → 400 and already-destination → 400; cross-Organisation and not a Global_Manager → 400; duplicate pending `team_change` → 409
    - The duplicate-pending check must sit **above** the Dual_Admin branch, so Requirement 3.7's 409 is reachable on both paths; also map a `23505` on `idx_access_requests_one_pending_team_change_per_user` to the same 409
    - Dual_Admin = `req.user.is_global_manager || (Team.isAdmin(source) && Team.isAdmin(destination))`. Dual_Admin → `BEGIN`, `executeTransfer(client, { ..., actorIsGlobalManager: !!req.user.is_global_manager, callsignSuffix: req.body.callsignSuffix || null, requestCallsignSuffix: null })`, `COMMIT`, then `applyPostCommitEffects`, then 200 `{ status: 'completed', demotedFromAdmin, callsign, destinationTeamPath, revokedChannelCount }`
    - Otherwise insert the Transfer_Request with every column value from the design's table (`approval_team_id` is the side the initiator does not administer; `requester_*` are the Initiating_Admin's own values; `email_verified` true with no verification email; `assigned_to_admin` selected on `role = 'admin'` only, never `IN ('admin','owner')`) and respond 202 `{ status: 'pending_approval', requestId, demotedFromAdmin, approvalTeamId, approvalTeamName }`
    - Map `CallsignSuffixConflictError` → 400 with the conflicting value in the message
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.4, 2.5, 2.6, 3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 9.1, 10.2, 10.3_

  - [x] 9.2 Write property test for branch selection
    - In `server/routes/users.transfer.integration.test.js`
    - **Property 9: Admin status on both sides selects the branch**
    - **Validates: Requirements 2.4, 2.5**
    - This is also the Requirement 17.2 assertion
    - _Requirements: 17.2_

  - [x] 9.3 Write property test for Transfer_Request columns
    - In `server/routes/users.transfer.integration.test.js`
    - **Property 10: Transfer_Request columns round-trip the submitted values**
    - **Validates: Requirements 3.1, 3.4, 3.5, 3.8**

  - [x] 9.4 Write property test for Approval_Team selection
    - In `server/routes/users.transfer.integration.test.js`
    - **Property 11: The Approval_Team is always the side the initiator does not administer**
    - **Validates: Requirements 3.3**

  - [x] 9.5 Write property test for `assigned_to_admin`
    - In `server/routes/users.transfer.integration.test.js`
    - **Property 12: assigned_to_admin names an eligible Approval_Team admin, or nothing**
    - **Validates: Requirements 3.6**

  - [x] 9.6 Write property test for the one-pending-request rule
    - In `server/routes/users.transfer.integration.test.js`, covering a later attempt from a Global_Manager, from a Dual_Admin, and from a single-side admin
    - **Property 13: At most one pending Transfer_Request exists per user**
    - **Validates: Requirements 3.7**

  - [x] 9.7 Write property test for Callsign_Suffix collisions
    - In `server/routes/users.transfer.integration.test.js`, using the mixed-case suffix arbitrary
    - **Property 18: Callsign_Suffix collisions are detected case-insensitively**
    - **Validates: Requirements 9.1**
    - This is also the Requirement 17.5 assertion (400 plus the Direct_Membership still naming the Source_Team)
    - _Requirements: 9.2, 17.5_

  - [x] 9.8 Write property test for field length limits
    - In `server/routes/users.transfer.integration.test.js`
    - **Property 26: Field length limits are enforced at the stated bounds**
    - **Validates: Requirements 1.1**

  - [x] 9.9 Write property test for self-transfer rejection
    - In `server/routes/users.transfer.integration.test.js`, including a Global_Manager and a Dual_Admin acting on themselves
    - **Property 28: A user's own membership can never be transferred**
    - **Validates: Requirements 1.8**

  - [x] 9.10 Write route examples
    - In `server/routes/users.transfer.integration.test.js`: unknown `:userId` → 404; no Direct_Membership → 400; already in the destination → 400; a created Transfer_Request has `email_verified` true with the verification-email mock uncalled
    - _Requirements: 1.3, 1.4, 1.5, 3.5_

- [x] 10. Transfer_Request approval and denial path
  - [x] 10.1 Rewire `case 'team_change'` to the Transfer_Service
    - In `server/services/RequestApprovalService.js` replace the `case 'team_change'` body with an `executeTransfer(client, { userId, destinationTeamId, actorId, actorIsGlobalManager, expectedSourceTeamId: request.current_team_id, callsignSuffix: callsignSuffixOverride || null, requestCallsignSuffix: request.callsign_suffix || null, transferRequestId, initiatedBy })` call that returns `{ transferOutcome }` rather than `break`ing, mirroring the `new_account` branch's `{ localUserId }`
    - Pass the two suffix links separately; do not pre-collapse them with `||`
    - Add an `approverIsGlobalManager` parameter to `approveRequest` and thread it into `actorIsGlobalManager`
    - After `COMMIT` and after the existing approval email, call `TeamTransferService.applyPostCommitEffects(processResult.transferOutcome)` for `team_change` rows
    - Update the `callsignSuffixOverride` doc comment, which currently states it is ignored for non-`new_account` types
    - Make no change to `denyRequest` — it already satisfies Requirements 12.1 through 12.4
    - _Requirements: 6.1, 6.6, 9.4, 9.7, 11.1, 11.6, 12.1, 12.2, 12.3, 12.4, 14.3_

  - [x] 10.2 Update the approve and deny routes
    - In `server/routes/requests.js` pass `req.user.is_global_manager` into `approveRequest`
    - Add error mapping beside the existing `CallsignSuffixConflictError` → 400 branch and before the generic 500: `StaleTransferRequestError` → 409 stating the user's team changed since the request was created, and `CrossOrganisationTransferError` → 409 naming the diverged Organisations
    - Tighten the deny validator to `body('denialReason').trim().isLength({ min: 1, max: 1000 })`
    - _Requirements: 11.1, 11.6, 12.5, 12.6_

  - [x] 10.3 Write property test for staleness rejection
    - In `server/routes/requests.approval.integration.test.js`
    - **Property 21: Approval is rejected exactly when the recorded source no longer matches**
    - **Validates: Requirements 11.1**
    - This is also the Requirement 17.6 assertion
    - _Requirements: 17.6_

  - [x] 10.4 Write property test for denial recording
    - In `server/routes/requests.approval.integration.test.js`
    - **Property 22: Denial records the decision**
    - **Validates: Requirements 12.1**

  - [x] 10.5 Write property test for denial-reason bounds
    - In `server/routes/requests.approval.integration.test.js`
    - **Property 23: A denial reason outside its bounds is rejected**
    - **Validates: Requirements 12.5, 12.6**

  - [x] 10.6 Write property test for the transfer notification
    - In `server/routes/requests.approval.integration.test.js`, asserting no unsubstituted `{{...}}` remains in the rendered body and that an `is_team_device` record receives nothing
    - **Property 24: The transfer notification is complete and correctly suppressed**
    - **Validates: Requirements 13.1, 13.3, 13.5**

  - [x] 10.7 Write property test for audit completeness
    - In `server/routes/requests.approval.integration.test.js`
    - **Property 25: Every completed transfer is audited with its full context**
    - **Validates: Requirements 10.5, 14.1, 14.2, 14.3**

  - [x] 10.8 Write property test for the Organisation boundary across both moments
    - In `server/routes/users.transfer.integration.test.js` (one test must span create → reparent → approve; splitting it would split one biconditional into two half-assertions), using the reparenting arbitrary
    - **Property 7: Cross-Organisation transfers are rejected at both initiation and execution unless the executing actor is a Global_Manager**
    - **Validates: Requirements 1.7, 11.6**

  - [x] 10.9 Write property test for path equivalence
    - Create `server/services/TeamTransferService.pathEquivalence.test.js`, running the same generated scenario through the immediate path and the approval path against identical starting states and diffing `team_memberships`, `channel_memberships`, `users`, `user_cache`, and the enqueued Sync_Operations
    - **Property 1: Both transfer paths produce identical state**
    - **Validates: Requirements 6.1, 6.7**

  - [x] 10.10 Write concurrency and approval-failure integration tests
    - In `server/routes/requests.approval.integration.test.js`: 2–3 executions firing concurrent approvals of one `pending` Transfer_Request against the real database, asserting exactly one success and exactly one set of membership writes (Requirement 11.5 is deliberately not a property — the guarantee lives in Postgres row locking)
    - Examples: a dangling `existing_user_id` and a dangling `target_team_id` each leave `status` as `pending`; approving an already-`approved` row makes no membership change; the denial email reaches the Initiating_Admin's address with the reason in the body; an email-send failure still responds 200 with `status` of `denied`
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 12.3, 12.4_

- [x] 11. Checkpoint - both server paths complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Pending-request visibility
  - [x] 12.1 Extract the shared enrichment and add the `team_change` fields
    - In `server/routes/requests.js` extract the near-identical ~35-line enrichment block from the Global_Manager and non-Global_Manager branches of `GET /api/requests/pending` into one local `enrichPendingRequests(rows)` helper
    - Add `LEFT JOIN users tu ON ar.existing_user_id = tu.id`, `LEFT JOIN users iu ON ar.initiated_by = iu.id`, `LEFT JOIN teams st ON ar.current_team_id = st.id`, selecting the Transferred_User's first name, last name, email and the Initiating_Admin's first name and last name
    - Resolve hierarchy paths for the union of distinct `target_team_id` and `current_team_id` values, emitting `team_path` (destination, existing field name preserved) and a new `source_team_path`
    - Leave `effective_callsign_suffix` computation as-is
    - _Requirements: 4.1, 4.3_

  - [x] 12.2 Rework the non-Global_Manager gating
    - In `server/routes/requests.js` widen the non-Global_Manager candidate set to all `status = 'pending' AND email_verified = true` rows, then filter in JS by `Team.isAdmin(gatingTeamId, userId)` where `gatingTeamId` is `approval_team_id` for a `team_change` row and `target_team_id` otherwise
    - Memoise `Team.isAdmin` by team id so the recursive-CTE calls are bounded by the number of distinct gating teams, not the number of rows
    - Replace the current `userTeams.filter(t => t.role === 'admin')` intersection entirely; the filter must run before the response is built so nothing leaks
    - _Requirements: 4.2, 4.4_

  - [x] 12.3 Write property test for pending-request visibility
    - Create `server/routes/requests.pending.test.js`, generating rows spanning every `request_type`, `status`, and `email_verified` combination and admin rows at any depth, computing the reference set by walking the generated hierarchy
    - **Property 14: Pending-request visibility equals the reference admin computation**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

- [x] 13. Client surfaces
  - [x] 13.1 Add the transfer API call
    - In `client/src/services/api.js` add a `transfer` method to `usersAPI` that POSTs the body to `/users/{userId}/transfer`, following the file's existing template-literal path style
    - _Requirements: 1.1_

  - [x] 13.2 Create the transfer dialog
    - Create `client/src/components/TransferMemberDialog.jsx` with props `{ member, team, onClose, onCompleted }` and state `targetTeamId`, `justification`, `callsignSuffix`, `serverError`, `callsignSuffixPrompt`, `submitting`
    - Destination options from `teamsAPI.getMyTeams({ scope: 'organisation' })` with the displayed team excluded client-side; fall back to `teamsAPI.getMyTeams()` only when the scoped call returns an empty list **and** `user?.isAdmin` is true
    - Fixed statement that the transfer changes the member's TAK callsign; additional statement about admin-rights removal when `member.role === 'admin'`
    - On a 400 naming a conflicting Callsign_Suffix, show the server message plus a suffix input and resubmit on confirmation, keeping the dialog open
    - 200 `completed` → `onCompleted()` plus a `react-hot-toast` success toast, then close; 202 `pending_approval` → toast stating the transfer awaits the other team's approval, Member_List untouched; 400/403/404/409 → render `error.response.data.error` inline and keep the dialog open
    - No native `confirm`/`alert` anywhere
    - _Requirements: 9.6, 10.4, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9_

  - [x] 13.3 Wire the dialog into the team page
    - In `client/src/pages/TeamDetail.jsx` add `transferringMember` state and an `ArrowRightCircleIcon` action in the existing `canManageTeam &&` action cell of both the members and admins tables, rendering `<TransferMemberDialog>` when set
    - _Requirements: 15.1_

  - [x] 13.4 Render `team_change` requests
    - In `client/src/pages/Requests.jsx` branch the card body on `request.request_type === 'team_change'`: Transferred_User name and email, `source_team_path` → `team_path`, Initiating_Admin name, justification, `created_at`, plus a statement that approval removes the member's admin rights in the Source_Team
    - Suppress the First Name / Last Name / Callsign Suffix inputs for `team_change` rows (those columns hold the Initiating_Admin's values)
    - Leave the existing approve/deny controls, denial-reason modal, optimistic removal, error toast, and `Layout.jsx` badge unchanged
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_

  - [x] 13.5 Write dialog tests
    - Create `client/src/components/TransferMemberDialog.test.jsx` (Vitest): admin-demotion statement for an `admin` member; the callsign-change statement; destination options exclude the displayed team and come from the organisation-scoped call; the all-teams fallback fires only on an empty scoped list for an admin; 200 refreshes and closes; 202 leaves the list unchanged; a parameterised set over 400, 403, 404, 409 keeps the dialog open with the server message displayed; the suffix-conflict retry resubmits with the new value
    - _Requirements: 9.6, 10.4, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 17.7_

  - [x] 13.6 Extend the team page tests
    - In `client/src/pages/TeamDetail.test.jsx` cover the `canManageTeam` gate combinations for the transfer action on both `member` and `admin` rows
    - _Requirements: 15.1_

  - [x] 13.7 Extend the requests page tests
    - In `client/src/pages/Requests.test.jsx` cover the `team_change` card fields, the approve/deny controls, the admin-rights statement, the non-empty denial-reason requirement, optimistic removal with the badge update, and an error response retaining the row
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_

- [x] 14. Final verification
  - Run `npm test -- --coverage` and confirm the 60 percent statement gate holds with no failures
  - Run the integration suites explicitly against the local Postgres test container: `server/routes/users.transfer.integration.test.js`, `server/routes/requests.approval.integration.test.js`, `server/config/migrations.teamTransfer.integration.test.js`
  - Run `npm run lint`, `npm run lint:pinned-deps`, `npm audit --audit-level=high` in the root tree and in `client/`
  - Run the client Vitest suite
  - Confirm no new dependency was added and `TeamMembershipService.addUserToTeam` is unmodified
  - _Requirements: 17.8_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; every core implementation task is unmarked.
- Properties 1–29 are each implemented by exactly one test sub-task: P1→10.9, P2→6.4, P3→6.5, P4→6.6, P5→6.9, P6→6.10, P7→10.8, P8→3.4, P9→9.2, P10→9.3, P11→9.4, P12→9.5, P13→9.6, P14→12.3, P15→3.5, P16→7.2, P17→7.3, P18→9.7, P19→7.4, P20→7.5, P21→10.3, P22→10.4, P23→10.5, P24→10.6, P25→10.7, P26→9.8, P27→6.7, P28→9.9, P29→6.8.
- Requirement 11.5 is covered by the integration test in 10.10, not by a property test — the at-most-once guarantee lives in Postgres row locking, and 100 iterations of live concurrent transactions would explore nothing two or three do.
- Requirement 3.6's narrowing from `role IN ('admin','owner')` to `role = 'admin'` gets no dedicated test: no reachable input distinguishes the two predicates, so Property 12 is the whole coverage.
- Requirement 15.9 is permissive ("MAY") and is asserted as the presence of the admin fallback in 13.5 rather than as a property.
- `server/services/__fixtures__/transferArbitraries.js` (task 2.1) must land before any property test; Properties 1, 3, 7, 8, 14, 15, 16, 27, and 29 all draw on its arbitraries.
- The three checkpoints (5, 8, 11) exist because each precedes a change that layers on the previous one: resolvers before routes, the transfer service before its callers, both server paths before the Client.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.3", "3.2", "3.6"] },
    { "id": 2, "tasks": ["3.3", "3.4", "4.1"] },
    { "id": 3, "tasks": ["3.5", "4.2", "6.1"] },
    { "id": 4, "tasks": ["6.2"] },
    { "id": 5, "tasks": ["6.3"] },
    { "id": 6, "tasks": ["7.1"] },
    { "id": 7, "tasks": ["9.1"] },
    { "id": 8, "tasks": ["10.1"] },
    { "id": 9, "tasks": ["10.2", "6.4"] },
    { "id": 10, "tasks": ["12.1", "6.5", "9.2", "10.3"] },
    { "id": 11, "tasks": ["12.2", "6.6", "9.3", "10.4"] },
    { "id": 12, "tasks": ["13.1", "6.7", "9.4", "10.5"] },
    { "id": 13, "tasks": ["13.2", "6.8", "9.5", "10.6"] },
    { "id": 14, "tasks": ["13.3", "13.4", "6.9", "9.6", "10.7"] },
    { "id": 15, "tasks": ["13.5", "13.6", "6.10", "9.7", "10.10"] },
    { "id": 16, "tasks": ["13.7", "7.2", "9.8", "12.3"] },
    { "id": 17, "tasks": ["7.3", "9.9"] },
    { "id": 18, "tasks": ["7.4", "10.8", "10.9"] },
    { "id": 19, "tasks": ["7.5", "9.10"] },
    { "id": 20, "tasks": ["7.6"] }
  ]
}
```
