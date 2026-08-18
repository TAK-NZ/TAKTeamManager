# Implementation Plan: Organisation/Team Hierarchy Rework

## Overview

This plan converts `design.md`'s components into incremental, dependency-ordered coding tasks. Additive schema migrations land first (Phase 1), followed by the shared `Team.getAncestorChain`/`getTeamDepth` primitive and the admin-inheritance rewrite that several later features build on. Phases 2-3 add Max_Team_Depth enforcement, Organisation-only field inheritance, and Callsign_Level_Selection to `Team.create`/`Team.update`. Phase 4 introduces `CallsignService` (the pure assembly/default-computation functions) and rewires `computeCallsignAttributes`/`updateUserAttributes`, implementing both Flagged Design Decisions (dropping `callsign_subteam_depth`, and the fetch-merge-PATCH fix for `updateUserAttributes`). Phase 5 adds Organisation-scoped/private-branch-cascading visibility. Phase 6 rewrites the CSV team-import pipeline. Phase 7 adds the per-user `callsign_suffix` column and its uniqueness/default-computation/never-recomputed guarantees across every creation/approval/membership-change entry point. Phase 8 adds Member_List editing (`TAK_Role`, name) and the Authentik reconciliation fix. Phase 9 wires every capability into the Client per Requirement 14.

Tasks marked with `*` are optional test sub-tasks and are not implemented as part of automated task execution unless explicitly requested.

Both flagged design decisions in `design.md`'s Overview are implemented as written (dropping `teams.callsign_subteam_depth` via migration, and changing `UserAttributesService.updateUserAttributes` to a fetch-merge-PATCH) -- see tasks 11.3 and 11.4 below.

## Tasks

### Phase 1: Foundational Schema and Shared Hierarchy Utilities

- [x] 1. Additive schema migrations
  - [x] 1.1 Write migration adding `teams.callsign_level_selection` (`integer[]`, nullable, no column-level default)
    - _Requirements: 5.1, 5.3_
  - [x] 1.2 Write migration adding `users.callsign_suffix` (`varchar(255)`, nullable)
    - _Requirements: 11.1_
  - [x] 1.3 Write migration adding `user_cache.callsign_suffix` (`varchar(255)`, nullable), mirroring the existing `tak_role`/`tak_color`/`tak_callsign` dual-write convention
    - _Requirements: 11.1_
  - [x] 1.4 Write migration adding `users.tak_role` (`varchar(50)`, not null, default `'Team Member'`)
    - _Requirements: 13.6, 13.7_
  - [x] 1.5 Write migration adding `access_requests.callsign_suffix` (`varchar(255)`, nullable)
    - _Requirements: 11.9_

- [x] 2. Max_Team_Depth constant and shared ancestor-chain utilities
  - [x] 2.1 Create `server/config/constants.js` exporting `MAX_TEAM_DEPTH = 5`
    - _Requirements: 2.1_
  - [x] 2.2 Implement `Team.getAncestorChain(teamId)` (root-first, one row per ancestor including the team itself, with `id`, `name`, `callsign_prefix`, `color`, `callsign_name_format`, `visibility`, `parent_team_id`, `depth`) and `Team.getTeamDepth(teamId)` in `server/models/Team.js`, per design.md's single recursive CTE
    - _Requirements: 2.1_
  - [x] 2.3* Write unit tests for `getAncestorChain`/`getTeamDepth` against a mocked single-node, single-child, deep-chain, and branching hierarchy
    - _Requirements: 2.1_

- [x] 3. Inherited Team_Admin status
  - [x] 3.1 Rewrite `Team.isAdmin(teamId, userId)` to walk the Ancestor_Chain via a recursive CTE, matching only a direct (`inherited_from_team_id IS NULL`), `role = 'admin'` membership on the team itself or any ancestor
    - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - [x] 3.2* Write property test for admin inheritance
    - **Property 4: Admin inheritance walks the full Ancestor_Chain**
    - **Validates: Requirements 4.1, 4.2, 4.3**
  - [x] 3.3* Write unit test confirming every existing `authorize.js` row-scoped resolver that calls `Team.isAdmin` (`team:update`, `team:members:add`, `team:create:root_or_sub`, `user:create:team_admin`, `user:holding_pen:team_admin`, `channel_request:create`, `channel_request:process`) receives inherited-admin behavior with no resolver code changes
    - _Requirements: 4.3_

- [x] 4. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 2: Max_Team_Depth Enforcement, Organisation-Only Fields, `callsign_prefix` Validation

- [x] 5. Max_Team_Depth enforcement on team creation
  - [x] 5.1 In `Team.create`, compute the target depth (`parent_team_id` present -> `getTeamDepth(parent_team_id) + 1`, else `0`) and throw a typed depth-exceeded error before inserting when it exceeds `MAX_TEAM_DEPTH`
    - _Requirements: 2.2, 2.3_
  - [x] 5.2 In `POST /api/teams` (`server/routes/teams.js`), catch the depth-exceeded error and respond 400 with `"Maximum team depth (5) exceeded"`, without creating the team
    - _Requirements: 2.3_
  - [x] 5.3* Write property test for depth-bounded creation
    - **Property 1: Depth-bounded creation**
    - **Validates: Requirements 2.1, 2.2, 2.3**

- [x] 6. Organisation-only field inheritance and `callsign_prefix`/`callsign_suffix` character-class validation
  - [x] 6.1 Generalize `Team.create`'s existing inline `color = parentTeam.color` sub-team inheritance to also cover `callsign_name_format`, and apply the same Organisation-value inheritance in `Team.update` when the target team is a Sub_Team, silently ignoring (never rejecting) any client-supplied `color`/`callsignNameFormat`
    - _Requirements: 3.2, 3.3_
  - [x] 6.2 Tighten the `callsignPrefix` `express-validator` chain in `POST /api/teams` and `PUT /api/teams/:teamId` to `.matches(/^[A-Za-z0-9]*$/)`, replacing the current unconstrained `.trim()`-only rule
    - _Requirements: 3.8, 3.9_
  - [x] 6.3 Add `'first_initial_dot_last'` and `'user_defined'` to the `callsignNameFormat` enum accepted by `POST /api/teams` and `PUT /api/teams/:teamId`
    - _Requirements: 8.6, 8.7, 11.5_
  - [x] 6.4* Write property test for Organisation-only field inheritance
    - **Property 2: Sub_Team always inherits Organisation-only fields, ignoring any supplied override**
    - **Validates: Requirements 3.2, 3.3**
  - [x] 6.5 Create `server/utils/callsignValidation.js` exporting `isValidCallsignPrefix(value)` (letters/digits only) and `isValidCallsignSuffix(value)` (letters/digits/`-`/`.`), and use `isValidCallsignPrefix` inside task 6.2's validator chain
    - _Requirements: 3.8, 3.9, 11.3_
  - [x] 6.6* Write property test for the character-class differential
    - **Property 3: `callsign_prefix` and `callsign_suffix` accept disjoint-but-overlapping character classes**
    - **Validates: Requirements 3.8, 3.9, 11.3**
  - [x] 6.7* Write unit test confirming `'first_initial_dot_last'`/`'user_defined'` are accepted by both `POST /api/teams` and `PUT /api/teams/:teamId`
    - _Requirements: 8.6, 8.7_

- [x] 7. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 3: Callsign_Level_Selection

- [x] 8. Callsign_Level_Selection accept/validate/default/reject
  - [x] 8.1 In `Team.create`/`Team.update`, accept `callsign_level_selection` only when the target is a root team, validate every element is an integer between 1 and `MAX_TEAM_DEPTH`, default to `[1..MAX_TEAM_DEPTH]` when omitted on Organisation creation, and throw a typed error when supplied on a Sub_Team
    - _Requirements: 5.1, 5.2, 5.3, 5.6_
  - [x] 8.2 Wire `callsignLevelSelection` validation into `POST /api/teams`/`PUT /api/teams/:teamId` request bodies, mapping task 8.1's typed errors to 400 responses (`"callsignLevelSelection values must be between 1 and 5"` / `"callsignLevelSelection can only be set on an Organisation"`)
    - _Requirements: 5.1, 5.2, 5.6_
  - [x] 8.3 Implement `Team.getSubTeamsForCallsignLevel(organisationId)` and a new `GET /api/teams/:teamId/callsign-level-options` route wrapping it, with a `'team:read'`-scoped Permission_Registry entry
    - _Requirements: 5.8, 5.9, 5.10, 5.11_
  - [x] 8.4 Extend `SiteConfig.getPublicConfig()`'s response (`GET /api/config/public`) with a `maxTeamDepth` field sourced from `MAX_TEAM_DEPTH`
    - _Requirements: 2.4, 2.5, 5.7_
  - [x] 8.5* Write property test for Callsign_Level_Selection range validation
    - **Property 5: Callsign_Level_Selection range validation**
    - **Validates: Requirements 5.1, 5.2, 5.6**

- [x] 9. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 4: Callsign Assembly, Default-Suffix Computation, and the Two Flagged Design Decisions

- [x] 10. Pure callsign services
  - [x] 10.1 Create `server/services/CallsignService.js` with `assembleCallsign({ organisationPrefix, teamSegmentPrefixes, nameSegment })`, implementing the three-segment, `-`-joined, empty-segment-omitting assembly rule
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 10.2 Add `CallsignService.computeDefaultCallsignSuffix(firstName, lastName, callsignNameFormat)` supporting `full_name`, `first_initial_last`, `first_last_initial`, `first_initial_dot_last`, and returning `null` for `user_defined`, replacing every character outside `[A-Za-z0-9.-]` with a single `-` (preserving a `first_initial_dot_last`-synthesized `.`)
    - _Requirements: 11.5, 11.7_
  - [x] 10.3* Write property test for callsign segment assembly
    - **Property 12: Callsign segment assembly preserves segment identity and separator placement**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5**
  - [x] 10.4* Write property test for default-suffix computation
    - **Property 17: Default `callsign_suffix` computation is a well-formed, character-class-safe transform**
    - **Validates: Requirements 11.7**

- [x] 11. Rewire callsign generation and Authentik attribute updates (Flagged Design Decisions 1 and 2)
  - [x] 11.1 Rewrite `UserAttributesService.computeCallsignAttributes` to read the Ancestor_Chain via `Team.getAncestorChain`, read the Organisation's `callsign_level_selection` (defaulting to `[1..MAX_TEAM_DEPTH]` when null), filter ancestor `callsign_prefix` values to Team_Depth positions in that selection, read the target user's stored `callsign_suffix` (no live computation), and call `CallsignService.assembleCallsign` -- no longer reading `callsign_subteam_depth` or `callsign_name_format` at generation time
    - _Requirements: 3.4, 5.4, 5.5, 8.4_
  - [x] 11.2* Write property test for level-filtered selection
    - **Property 6: Callsign_Generator selects exactly the present, selected levels**
    - **Validates: Requirements 5.4, 5.5**
  - [x] 11.3 Remove every remaining read/write of `teams.callsign_subteam_depth` in `server/models/Team.js`, `server/routes/teams.js`, and `server/services/userAttributes.js`, then write migration `drop-teams-callsign-subteam-depth.cjs` dropping the column (Flagged Design Decision 1)
    - _Requirements: (design.md Flagged Design Decision 1, superseding Requirement 5's Callsign_Level_Selection)_
  - [x] 11.4 Change `UserAttributesService.updateUserAttributes` from a blind full-object PATCH to a fetch-current-Authentik-attributes-then-merge-supplied-keys-then-PATCH, so a partial `{takCallsign, takColor}` call can no longer clobber an existing `takRole` (Flagged Design Decision 2)
    - _Requirements: 13.6, 13.8_
  - [x] 11.5* Write property test for the partial-merge guarantee
    - **Property 21: Authentik attribute updates are a partial merge, never a wholesale replace**
    - **Validates: Requirements 13.6**
  - [x] 11.6 Confirm (via `Team.update`'s existing `callsignLevelSelection`-change regeneration call to `UserAttributesService.updateTeamUserAttributes`) that a Callsign_Level_Selection change regenerates callsign/color but never touches `callsign_suffix`, relying on task 11.1's read-only-stored-suffix behavior
    - _Requirements: 5.12_
  - [x] 11.7* Write property test for suffix stability across a level-selection change
    - **Property 8: Callsign_Level_Selection changes never alter `callsign_suffix`**
    - **Validates: Requirements 5.12**

- [x] 12. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 5: Organisation-Scoped, Private-Branch-Cascading Visibility

- [x] 13. Visible_Branch resolution service
  - [x] 13.1 Create `server/services/TeamVisibilityService.js` implementing `isVisibleBranch(teamId, user)` per the Visible_Branch definition (cross-Organisation exclusion, private-ancestor cascade, Global_Manager bypass), built on `Team.getAncestorChain`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.7, 6.8_
  - [x] 13.2 Implement `TeamVisibilityService.filterVisibleBranches(teams, user)` as a batched (one-or-two-query-per-Organisation) equivalent of calling `isVisibleBranch` per row
    - _Requirements: 6.5, 6.6_
  - [x] 13.3* Write property test for single-team visibility resolution
    - **Property 9: Visible_Branch resolution matches the reference definition**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.7, 6.8**
  - [x] 13.4* Write property test for batched-vs-per-row consistency
    - **Property 10: Batched visibility filtering is consistent with per-team resolution**
    - **Validates: Requirements 6.5, 6.6**

- [x] 14. Wire visibility into authorization and routes
  - [x] 14.1 Remove `'team:read'` from `roleDefaults.authenticated_user`; add a `'team:read'` row-scoped resolver in `server/middleware/authorize.js` backed by `TeamVisibilityService.isVisibleBranch`, and add a permission-specific branch mapping a `'team:read'` denial to 404 instead of the generic 403
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [x] 14.2 Apply `TeamVisibilityService.filterVisibleBranches` to `GET /api/teams/:teamId/sub-teams`'s result list, rather than 404ing the whole list when only some children are hidden
    - _Requirements: 6.5_
  - [x] 14.3 Add an optional `?scope=organisation` query parameter to `GET /api/teams/my-teams`, returning every Visible_Branch Team in the caller's Organisation (via `filterVisibleBranches`) when present, additive to the existing default response shape
    - _Requirements: 6.6_
  - [x] 14.4* Write integration test confirming a cross-Organisation or private-branch-cascade denial on `GET /api/teams/:teamId` responds 404, never 403
    - _Requirements: 6.2, 6.3_

- [x] 15. Public joinable-teams exclusion and access-request rejection
  - [x] 15.1 Add a "has a private ancestor" `WHERE NOT EXISTS` clause to `Team.getJoinableTeams` (the public, unauthenticated query)
    - _Requirements: 7.1, 7.2_
  - [x] 15.2* Write property test for the public exclusion rule
    - **Property 11: Public joinable-teams listing excludes every private branch**
    - **Validates: Requirements 7.1, 7.2**
  - [x] 15.3 In `POST /api/requests/team-access`, confirm the existing `!team.can_join || team.visibility !== 'public'` check rejects a Team excluded by task 15.1's clause (a private-branch-cascaded Team is `can_join`/`public` on its own row but never appears in `getJoinableTeams`, so this check already covers it once the caller looks the team up the same way -- verify and adjust if the route bypasses `getJoinableTeams`)
    - _Requirements: 7.4_
  - [x] 15.4* Write integration test submitting a team-access request naming a Team under a private ancestor, asserting 400
    - _Requirements: 7.4_

- [x] 16. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 6: CSV Import of a Multi-Level Team Hierarchy

- [x] 17. CSV import dependency-graph resolution (pure logic)
  - [x] 17.1 Implement `buildImportGraph(rows)` in `server/services/BulkImportService.js`: build one node per row (keyed by `rowId`, else a synthetic `__row_${lineNumber}` key), resolve `parentRowRef`/`parentTeamName`/`parentTeamId` into edges, and reject the whole file when a non-empty `rowId` is duplicated or when a row supplies both `parentRowRef` and `parentTeamName`/`parentTeamId`
    - _Requirements: 9.1, 9.2, 9.3, 9.5_
  - [x] 17.2 Implement cycle detection over `parentRowRef` edges using a three-colour (white/grey/black) DFS, rejecting the whole file and naming every row on a detected cycle
    - _Requirements: 9.13_
  - [x] 17.3 Implement dangling-`parentRowRef` row failure with transitive-dependent-failure propagation (a row whose resolved parent node is itself failed/absent is failed), and a topological ordering (Kahn's algorithm) of every non-failed row
    - _Requirements: 9.4, 9.6, 9.12_
  - [x] 17.4* Write property test for duplicate-`rowId` whole-file rejection
    - **Property 13: Duplicate `rowId` values reject the entire import before any creation**
    - **Validates: Requirements 9.2**
  - [x] 17.5* Write property test for failure isolation
    - **Property 14: Parent-resolution failure isolates exactly its dependent subtree**
    - **Validates: Requirements 9.4, 9.12**
  - [x] 17.6* Write property test for row-order independence
    - **Property 15: CSV import outcome is independent of row order**
    - **Validates: Requirements 9.6**
  - [x] 17.7* Write property test for cycle detection
    - **Property 16: Cycle detection identifies exactly the rows on a cycle**
    - **Validates: Requirements 9.13**

- [x] 18. CSV import pipeline wiring
  - [x] 18.1 Rewrite `BulkImportService.importTeams` as the two-phase pipeline (parse all rows, `buildImportGraph`, then create rows in topological order via `Team.create`, reusing task 5.1/6.1's Max_Team_Depth and Organisation-only-field enforcement unchanged)
    - _Requirements: 9.6, 9.7, 9.9, 9.10, 9.11_
  - [x] 18.2 Add `rowId`, `parentRowRef`, `visibility` (default `public` when omitted), and `callsignPrefix` columns to the Team_Import_Row parsing logic, and extend `POST /api/bulk-import/teams`'s response shape with a `rejected: true` + combined error array for whole-file rejections (duplicate `rowId`, cycle), distinct from the existing per-row `results` array
    - _Requirements: 9.1, 9.3, 9.7, 9.8_
  - [x] 18.3* Write unit test for a row supplying both `parentRowRef` and `parentTeamId`/`parentTeamName`
    - _Requirements: 9.5_
  - [x] 18.4* Write unit test confirming a CSV row exceeding Max_Team_Depth is rejected with the same error shape as the direct `POST /api/teams` API
    - _Requirements: 9.9_

- [x] 19. CSV import template
  - [x] 19.1 Rewrite `public/templates/team-import-template.csv` to demonstrate a hierarchy at least 3 Team_Depth levels deep using `rowId`/`parentRowRef`, plus the existing `parentTeamName`/`parentTeamId` columns and the new `visibility`/`callsignPrefix` columns
    - _Requirements: 9.14_
  - [x] 19.2* Write unit test parsing the shipped template and asserting it reaches Team_Depth >= 3 via `rowId`/`parentRowRef` chaining
    - _Requirements: 9.14_

- [x] 20. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 7: Per-User `callsign_suffix` -- Default Computation, Uniqueness, Stability

- [x] 21. Shared Member_List roster query
  - [x] 21.1 Add `callsign_suffix` and `tak_role` to `Team.getMembers`'s `SELECT`, and add `Team.getFullMemberList(teamId)` as an explicit alias reusing the exact same query
    - _Requirements: 11.14, 13.1_

- [x] 22. Callsign_suffix creation-time resolution
  - [x] 22.1 Create `UserProvisioningService.resolveCallsignSuffixForNewUser(client, { firstName, lastName, teamId, requestedCallsignSuffix })`: resolve the target Organisation's `callsign_name_format` via `Team.getAncestorChain`, require a non-empty `requestedCallsignSuffix` for `user_defined` (throwing a typed error otherwise), compute the default via `CallsignService.computeDefaultCallsignSuffix` otherwise (preferring `requestedCallsignSuffix` when supplied), and check the effective value against `Team.getFullMemberList(teamId)` for a case-insensitive collision (throwing a typed `CallsignSuffixConflictError`, see task 23.1)
    - _Requirements: 11.6, 11.7, 11.14, 11.15_
  - [x] 22.2 Wire `resolveCallsignSuffixForNewUser` into `POST /api/users`, `POST /api/users/create-and-add`, and `BulkImportService.importUserRow`, mapping its typed errors to a 400 naming the missing/conflicting value
    - _Requirements: 11.6, 11.7, 11.14, 11.15_
  - [x] 22.3* Write unit test confirming all three creation entry points share the same default-computation/uniqueness behavior via `resolveCallsignSuffixForNewUser`
    - _Requirements: 11.6, 11.7_

- [x] 23. Shared per-Team uniqueness check
  - [x] 23.1 Create a `CallsignSuffixConflictError` class and a shared `checkCallsignSuffixUniqueness(teamId, candidateValue, excludeUserId)` function (used by task 22.1, and by tasks 24.3 and 25.1 below) comparing case-insensitively against `Team.getFullMemberList(teamId)`, excluding the user being edited when applicable
    - _Requirements: 11.14_
  - [x] 23.2* Write property test for per-Team uniqueness
    - **Property 19: Per-Team `callsign_suffix` uniqueness is case-insensitive and self-exclusive**
    - **Validates: Requirements 11.14, 11.15, 11.16, 11.18**

- [x] 24. Access-request `callsign_suffix` flow
  - [x] 24.1 In `POST /api/requests/team-access`, accept an optional `callsignSuffix` field, requiring it (400 if absent) when the target Team's Organisation's `callsign_name_format` is `user_defined`, and store it on the new `access_requests.callsign_suffix` column
    - _Requirements: 11.9_
  - [x] 24.2 Extend `GET /api/requests/pending` to include, per pending request, the reviewer-facing effective `callsign_suffix` (the request's own submitted value when present, otherwise the server-computed default via `CallsignService.computeDefaultCallsignSuffix`)
    - _Requirements: 11.11, 11.12_
  - [x] 24.3 Extend `POST /api/requests/:requestId/approve` to accept an optional `callsignSuffix` override, resolve the effective value (override > request's stored value > computed default), check it via `checkCallsignSuffixUniqueness` against the target Team, and reject (returning the conflicting value) on collision instead of committing
    - _Requirements: 11.11, 11.12, 11.17_
  - [x] 24.4* Write unit test for the override/submitted-value/computed-default precedence and the collision-rejection response shape
    - _Requirements: 11.11, 11.17_

- [x] 25. Membership-change uniqueness enforcement
  - [x] 25.1 In `TeamMembershipService.addUserToTeam` (and the approval `team_change` branch that calls it), reject a membership change that would create a same-Team `callsign_suffix` collision via `checkCallsignSuffixUniqueness`
    - _Requirements: 11.18_
  - [x] 25.2* Write unit test for membership-change collision rejection
    - _Requirements: 11.18_

- [x] 26. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 8: Member_List Editing (`TAK_Role`, Name) and Authentik Reconciliation

- [x] 27. TAK_Role shared allow-list
  - [x] 27.1 Export `TAK_ROLE_VALUES = Object.values(ROLE_KEY_LABELS)` from `server/routes/settings.js`
    - _Requirements: 13.4_
  - [x] 27.2* Write property test for TAK_Role membership validation
    - **Property 20: TAK_Role acceptance is an exact membership predicate**
    - **Validates: Requirements 13.4**

- [x] 28. Member_List edit route
  - [x] 28.1 Create `PATCH /api/teams/:teamId/members/:userId` in `server/routes/teams.js`: accepts optional `firstName`, `lastName`, `takRole`, `callsignSuffix`; ignores an `email` field if present; validates `takRole` against `TAK_ROLE_VALUES` (400 otherwise); validates `callsignSuffix` via `isValidCallsignSuffix` and `checkCallsignSuffixUniqueness` (excluding the edited user); writes `firstName`/`lastName` directly to `users`; writes `takRole` to `users.tak_role` and pushes `{role: takRole}` to Authentik via the fetch-merge-PATCH `updateUserAttributes` from task 11.4
    - _Requirements: 11.4, 11.16, 13.2, 13.3, 13.4, 13.5, 13.6, 13.9_
  - [x] 28.2 Add a `'team:members:edit'` Permission_Registry entry/resolver (Team_Admin of `:teamId`, inherited via task 3.1, or Global_Manager), additionally gated by `TeamVisibilityService.isVisibleBranch`
    - _Requirements: 13.10_
  - [x] 28.3* Write integration test confirming a name edit updates `users.first_name`/`last_name` directly with no `access_requests` row created
    - _Requirements: 13.9_
  - [x] 28.4* Write unit test confirming an `email` field present in the request body is ignored
    - _Requirements: 13.3_
  - [x] 28.5* Write property test for stored-suffix stability across every write path built in Phases 4, 7, and 8
    - **Property 18: A stored `callsign_suffix` is stable across unrelated changes**
    - **Validates: Requirements 11.8**

- [x] 29. Authentik `tak_role` reconciliation
  - [x] 29.1 Extend `authentikSync.js`'s per-user upsert loop: when Authentik's `takRole` attribute differs from `users.tak_role`, update `users.tak_role` to match Authentik's value (never the reverse), leaving `user_cache.tak_role`'s existing Authentik-preferred behavior unchanged
    - _Requirements: 13.8_
  - [x] 29.2* Write property test for `TAK_Role` stability across unrelated changes
    - **Property 22: A stored TAK_Role is stable across unrelated changes**
    - **Validates: Requirements 13.8**

- [x] 30. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 9: Client Wiring (Requirement 14)

- [x] 31. `client/src/services/api.js` additions
  - [x] 31.1 Add `teamsAPI.getCallsignLevelOptions(id)`, `teamsAPI.updateMember(teamId, userId, data)`, and `bulkImportAPI.importTeams(formData)`
    - _Requirements: 5.7, 9.14, 13.2_

- [x] 32. `client/src/pages/Teams.jsx`
  - [x] 32.1 Add `labelFor(team)`/`labelForNew(parentTeamId)` helpers and apply "Organisation"/"Team" labelling to the create/edit dialog title, submit button text, and delete-confirmation copy
    - _Requirements: 1.1, 1.2, 1.4, 1.5_
  - [x] 32.2 Disable and grey any Parent-Team dropdown option whose `team_depth === maxTeamDepth` (fetched from `GET /api/config/public`), with a tooltip explaining why
    - _Requirements: 2.4, 2.5_
  - [x] 32.3 Extend the existing parent-selected disable behavior to the "Callsign Name Format" select (already applied to "TAK Color"), and add `'first_initial_dot_last'`/`'user_defined'` options with inline help text for `user_defined`
    - _Requirements: 3.5, 3.6, 8.6, 8.7, 11.5_
  - [x] 32.4 Replace the single "Callsign Sub-team Depth" select with a Callsign_Level_Selection toggle row (one toggle per Team_Depth 1..`maxTeamDepth`), fetching `teamsAPI.getCallsignLevelOptions(id)` when editing an existing Organisation, and implement the pure `formatLevelLabel(depth, prefixes)` helper (up-to-3-example, comma-separated, ellipsis-if-more labelling)
    - _Requirements: 5.7, 5.8, 5.9, 5.10, 5.11_
  - [x] 32.5* Write property test for level-toggle label formatting
    - **Property 7: Level-toggle label formatting**
    - **Validates: Requirements 5.9, 5.10, 5.11**
  - [x] 32.6 Add `pattern="[A-Za-z0-9]*"` and an inline validation message to the `callsignPrefix` input
    - _Requirements: 3.10_

- [x] 33. `client/src/pages/TeamDetail.jsx`
  - [x] 33.1 Apply `labelFor` to the header, breadcrumbs, and Edit/Sub-team dialog titles; disable and grey the "Add Sub-team" control when `team.team_depth === maxTeamDepth`; replace the root-only depth/format badge pair with a "Levels: ..." summary (from `callsign_level_selection`) plus the format badge, including example strings for the two new format values
    - _Requirements: 1.1, 1.2, 2.4, 2.5_
  - [x] 33.2 Add a `TAK_Role` column to the Members and Team Admins tabs, and a per-row inline edit form (first name, last name, a `TAK_ROLE_VALUES` select, and a `callsign_suffix` input enforcing the Requirement 11.3 pattern) wired to `teamsAPI.updateMember`; render email as plain, non-editable text
    - _Requirements: 11.13, 13.1, 13.2, 13.3, 13.5_
  - [x] 33.3 Apply the same `callsignPrefix` pattern validation from task 32.6 to the Sub-team creation dialog
    - _Requirements: 3.10_

- [x] 34. `client/src/pages/RequestAccess.jsx`
  - [x] 34.1 Fetch the selected team's Organisation `callsignNameFormat` (extending the joinable-team row shape returned by `teamsAPI.getJoinable()`), and render a required "Preferred Callsign Suffix" input only when it is `user_defined`
    - _Requirements: 11.9, 11.10_

- [x] 35. `client/src/pages/Requests.jsx`
  - [x] 35.1 Render an editable "Callsign Suffix" field per pending request, pre-filled with the request's submitted value when present or the server-computed default otherwise, editable before approving; on a 400 collision response from `POST /api/requests/:requestId/approve`, surface the conflicting value inline and keep the field open for retry
    - _Requirements: 11.11, 11.12, 11.17_

- [x] 36. `client/src/pages/Admin.jsx` -- Bulk Import tab
  - [x] 36.1 Add a Global_Manager-only "Bulk Import" tab: a file picker + "Upload Team CSV" button posting via `bulkImportAPI.importTeams`, a download link for the updated template, and a results view distinguishing a whole-file rejection from a per-row results table
    - _Requirements: 9.14, 14.1_

- [x] 37. Client wiring verification
  - [x] 37.1 Audit every control added in tasks 32-36: confirm each handles both a successful and a 4xx/5xx response with a user-visible failure indication, and reflects saved values from the response/re-fetch rather than optimistic-only local state
    - _Requirements: 14.2, 14.3_
  - [x] 37.2* Write component tests for the Add-Sub-team/Parent-dropdown disable state at depth-4-vs-5
    - _Requirements: 2.4, 2.5_
  - [x] 37.3* Write component test confirming the existing `inherited_from_team_name` admin badge remains compatible with the rewritten `isAdmin` (task 3.1)
    - _Requirements: 4.5_
  - [x] 37.4* Write component tests for `RequestAccess.jsx`'s conditional `callsign_suffix` field (rendered only for `user_defined`)
    - _Requirements: 11.9, 11.10_

- [x] 38. Final checkpoint - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks (unit, property-based, integration, component) and are skipped by default during automated task execution; core implementation tasks are never marked optional.
- Every property test task references the property number and requirement clause(s) it validates, per `design.md`'s Correctness Properties section (Properties 1-22).
- Both Flagged Design Decisions from `design.md`'s Overview are implemented exactly as approved: dropping `teams.callsign_subteam_depth` via migration (task 11.3) and changing `UserAttributesService.updateUserAttributes` to a fetch-merge-PATCH (task 11.4).
- Every new column lands as its own migration task in Phase 1, ahead of every model/service/route task that reads or writes it; the one destructive migration (dropping `callsign_subteam_depth`, task 11.3) is deliberately sequenced AFTER the code that reads it is rewritten (task 11.1), not in Phase 1, since the column must stop being read before it is safe to drop.
- Requirement 14 Criterion 4 (exercising every Client control against a running instance of the App) is a manual verification step, not an automatable coding task, and is intentionally not represented as its own task; task 37.1's audit covers the automatable portion (error handling, state reflection) of that requirement.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "2.1"] },
    { "id": 1, "tasks": ["2.2"] },
    { "id": 2, "tasks": ["2.3", "3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "5.1"] },
    { "id": 4, "tasks": ["5.2"] },
    { "id": 5, "tasks": ["5.3", "6.1", "6.5"] },
    { "id": 6, "tasks": ["6.2", "6.4", "6.6"] },
    { "id": 7, "tasks": ["6.3"] },
    { "id": 8, "tasks": ["6.7", "8.1"] },
    { "id": 9, "tasks": ["8.2", "8.4"] },
    { "id": 10, "tasks": ["8.3", "8.5"] },
    { "id": 11, "tasks": ["10.1"] },
    { "id": 12, "tasks": ["10.2", "10.3"] },
    { "id": 13, "tasks": ["10.4", "11.1"] },
    { "id": 14, "tasks": ["11.2", "11.4"] },
    { "id": 15, "tasks": ["11.3", "11.5"] },
    { "id": 16, "tasks": ["11.6"] },
    { "id": 17, "tasks": ["11.7", "13.1"] },
    { "id": 18, "tasks": ["13.2", "13.3"] },
    { "id": 19, "tasks": ["13.4", "14.1"] },
    { "id": 20, "tasks": ["14.2"] },
    { "id": 21, "tasks": ["14.3", "15.1"] },
    { "id": 22, "tasks": ["14.4", "15.2", "15.3"] },
    { "id": 23, "tasks": ["15.4", "17.1"] },
    { "id": 24, "tasks": ["17.2", "17.4"] },
    { "id": 25, "tasks": ["17.3", "17.7"] },
    { "id": 26, "tasks": ["17.5", "17.6", "18.1"] },
    { "id": 27, "tasks": ["18.2"] },
    { "id": 28, "tasks": ["18.3", "18.4", "19.1"] },
    { "id": 29, "tasks": ["19.2", "21.1"] },
    { "id": 30, "tasks": ["22.1", "23.1"] },
    { "id": 31, "tasks": ["22.2", "23.2"] },
    { "id": 32, "tasks": ["22.3", "24.1", "25.1"] },
    { "id": 33, "tasks": ["24.2", "25.2"] },
    { "id": 34, "tasks": ["24.3"] },
    { "id": 35, "tasks": ["24.4", "27.1"] },
    { "id": 36, "tasks": ["27.2", "28.1"] },
    { "id": 37, "tasks": ["28.2"] },
    { "id": 38, "tasks": ["28.3", "28.4", "28.5", "29.1"] },
    { "id": 39, "tasks": ["29.2", "31.1"] },
    { "id": 40, "tasks": ["32.1", "33.1", "34.1", "35.1", "36.1"] },
    { "id": 41, "tasks": ["32.2", "33.2"] },
    { "id": 42, "tasks": ["32.3", "33.3"] },
    { "id": 43, "tasks": ["32.4"] },
    { "id": 44, "tasks": ["32.5", "32.6"] },
    { "id": 45, "tasks": ["37.1"] },
    { "id": 46, "tasks": ["37.2", "37.3", "37.4"] }
  ]
}
```
