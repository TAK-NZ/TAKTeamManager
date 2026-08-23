# Implementation Plan: CloudTAK Agency Groups

## Overview

Implementation is incremental and test-driven, following the existing codebase conventions (Node/JavaScript, jest + supertest, `fast-check`, mocked `config/database` and `EventPublisher`, mocked `global.fetch` for Sync_Worker handlers). It builds the pure/config primitives first, then the operation-type registration and Sync_Worker handlers, then wires each Team lifecycle enqueue site (each guarded by the flag), then the backfill script, and ends with verification. Test-only sub-tasks are marked `*` and may be skipped for a faster MVP; core implementation sub-tasks are not.

## Tasks

- [x] 1. Add the server-side enablement flag and config plumbing
  - [x] 1.1 Create `server/config/cloudtak.js` exporting `isCloudTakEnabled(env = process.env)` returning `env.CLOUDTAK_ENABLED === 'true'`
    - Match the existing boolean-env convention (`RECAPTCHA_DISABLED === 'true'`)
    - Add `CLOUDTAK_ENABLED=false` with an explanatory comment to `.env.example`
    - _Requirements: 1.1, 1.2_
  - [x]* 1.2 Write property test for `isCloudTakEnabled`
    - **Property 1: Enablement flag predicate**
    - **Validates: Requirements 1.1, 1.2**
  - [x]* 1.3 Write unit test asserting `SiteConfig.getPublicConfig()` never includes a CLOUDTAK/cloudtak key
    - _Requirements: 1.3_

- [x] 2. Add the pure CloudTAK helpers
  - [x] 2.1 Create `server/services/CloudTakAgencyGroup.js` with `groupName(teamId)` and `agencyAttributes(team)`
    - `groupName` returns `` `CloudTAKAgency${teamId}` `` (no prefix)
    - `agencyAttributes` returns `{ agencyId, agencyName, description }` from the team's `id`/`name`/`description`
    - _Requirements: 2.2, 3.1, 3.2, 3.3_
  - [x] 2.2 Add `getDirectAdmins(teamId, client?)` to `server/services/CloudTakAgencyGroup.js`
    - Query `team_memberships` joined to `users` for `role = 'admin' AND inherited_from_team_id IS NULL`, returning `{ user_id, authentik_user_id }`
    - Do NOT use `Team.isAdmin`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - [x]* 2.3 Write property test for `groupName`
    - **Property 3: Group name is exactly `CloudTAKAgency<id>`**
    - **Validates: Requirements 2.2**
  - [x]* 2.4 Write property test for `agencyAttributes`
    - **Property 4: Agency attributes map exactly to the Team's fields**
    - **Validates: Requirements 3.1, 3.2, 3.3, 6.4**
  - [x]* 2.5 Write property test for `getDirectAdmins` against a reference filter over generated membership rows
    - **Property 5: Membership set equals the direct-admin set**
    - **Validates: Requirements 4.1, 4.2, 4.4**

- [x] 3. Register the new operation types in the schema map
  - [x] 3.1 Add `create_cloudtak_group`, `update_cloudtak_group`, and `delete_cloudtak_group` entries to `server/workers/operationSchemas.js`, each with `requiredFields: { team_id: 'number' }`
    - _Requirements: 9.5_
  - [x]* 3.2 Write unit test asserting the three new entries exist (rely on the existing completeness test for switch↔schema parity)
    - _Requirements: 9.5_

- [x] 4. Implement the Sync_Worker CloudTAK group handlers
  - [x] 4.1 Add a private reconcile helper and the create/update handlers to `server/workers/syncWorker.js`
    - Add `case 'create_cloudtak_group'` and `case 'update_cloudtak_group'` to the `executeOperation` switch
    - `createCloudTakGroup`/`updateCloudTakGroup`: resolve group by name via Create_Or_Reuse (POST `/core/groups/`, on 4xx name-conflict GET `?name=<encoded>` and reuse), set Agency_Attributes authoritatively from the Team's current DB values, then reconcile members to the Team's current Direct_Admin_Set (GET group members, add/remove diff by `authentik_user_id`)
    - Throw `AuthentikApiError(message, classifyFailure(status))` on non-conflict failures
    - _Requirements: 2.3, 2.4, 2.5, 3.4, 4.5, 5.5, 6.3, 10.1, 10.4, 10.5_
  - [x] 4.2 Add the delete handler `deleteCloudTakGroup` to `server/workers/syncWorker.js`
    - Add `case 'delete_cloudtak_group'` to the switch
    - Resolve the group by name `CloudTAKAgency<team_id>`, `DELETE /core/groups/{pk}/`; treat a 404/absent group as an already-satisfied no-op
    - _Requirements: 7.2, 7.3_
  - [x]* 4.3 Write unit tests for the create/update handlers (mock `global.fetch`)
    - Assert the POST body carries name + the three Agency_Attributes (2.3, 3.4)
    - Assert Create_Or_Reuse on a 400 name-conflict looks up by name, reuses, and still sets attributes (2.4, 2.5, 10.1)
    - Assert member add uses the user's `authentik_user_id` (4.5)
    - Assert a 5xx yields a `'retryable'` classification and a non-conflict 4xx yields `'permanent'` (9.3, 10.2, 10.3)
    - _Requirements: 2.3, 2.4, 2.5, 3.4, 4.5, 9.3, 10.1, 10.2, 10.3_
  - [x]* 4.4 Write property test for membership reconciliation
    - **Property 6: Membership reconciliation yields the direct-admin set**
    - **Validates: Requirements 5.5, 10.5**
  - [x]* 4.5 Write property test for create/update attribute idempotence (apply handler twice against mocked Authentik)
    - **Property 7: Create/update attribute idempotence**
    - **Validates: Requirements 10.4, 2.5, 3.4, 6.3**
  - [x]* 4.6 Write unit tests for the delete handler
    - Assert resolve-by-name then DELETE (7.2), and 404/absent group completes successfully (7.3)
    - _Requirements: 7.2, 7.3_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Wire the Team-creation and Team-update enqueue sites (flag-guarded)
  - [x] 6.1 Enqueue `create_cloudtak_group` in `Team.create`
    - After the `teams` INSERT succeeds, if `isCloudTakEnabled()`, enqueue `create_cloudtak_group` with `{ team_id: team.id }` via `EventPublisher.publishOperation`
    - _Requirements: 2.1, 2.6, 9.1_
  - [x] 6.2 Enqueue `update_cloudtak_group` in `Team.update`
    - After the `UPDATE teams` returns, if `isCloudTakEnabled()` and `name` or `description` was part of the update, enqueue `update_cloudtak_group` with `{ team_id: teamId }`
    - _Requirements: 6.1, 6.2, 9.1_
  - [x]* 6.3 Write tests for the create/update enqueue sites (mock `EventPublisher`)
    - Assert enqueue occurs with the correct `team_id` when the flag is on, for both a root and a sub-team creation (2.1, 2.6)
    - Assert update enqueues on name/description change (6.1, 6.2)
    - Assert NOTHING enqueues when the flag is off (1.4)
    - Assert no synchronous `global.fetch` at these sites (9.1, 9.4)
    - _Requirements: 1.4, 2.1, 2.6, 6.1, 6.2, 9.1, 9.4_

- [x] 7. Wire the Team-deletion enqueue site (flag-guarded, transactional)
  - [x] 7.1 Enqueue `delete_cloudtak_group` in `Team.delete`
    - Inside the existing transaction, before `COMMIT`, if `isCloudTakEnabled()`, enqueue `delete_cloudtak_group` with `{ team_id: teamId }` on the same `client`
    - _Requirements: 7.1, 9.1, 9.2_
  - [x]* 7.2 Write tests for the delete enqueue site
    - Assert enqueue with `team_id` on the transactional client when the flag is on (7.1, 9.2)
    - Assert nothing enqueues when the flag is off (1.4)
    - _Requirements: 1.4, 7.1, 9.2_

- [x] 8. Wire the direct-admin membership enqueue sites (flag-guarded)
  - [x] 8.1 Enqueue `update_cloudtak_group` in `Team.addMember`
    - After the upsert, if `isCloudTakEnabled()`, enqueue `update_cloudtak_group` with `{ team_id: teamId }` (covers admin add, promote, and demote)
    - _Requirements: 5.1, 5.2, 5.3, 9.1_
  - [x] 8.2 Enqueue `update_cloudtak_group` at the create-and-add admin promotion in `server/routes/users.js`
    - After the membership is promoted to `'admin'` on the transactional client, if `isCloudTakEnabled()`, enqueue `update_cloudtak_group` with `{ team_id }` on that same client
    - _Requirements: 5.2, 9.1, 9.2_
  - [x] 8.3 Enqueue `update_cloudtak_group` in `TeamMembershipService.removeUserFromTeam`
    - Before deleting the user's `team_memberships` rows, capture the Team ids where the user held a direct-admin row (`role = 'admin' AND inherited_from_team_id IS NULL`); after deletion, if `isCloudTakEnabled()`, enqueue one `update_cloudtak_group` per captured Team id on the same transactional client
    - _Requirements: 5.4, 9.1, 9.2_
  - [x]* 8.4 Write tests for the membership enqueue sites (mock `EventPublisher`)
    - Assert `Team.addMember` enqueues `update_cloudtak_group` for admin add, promote, and demote (5.1, 5.2, 5.3)
    - Assert the create-and-add promotion enqueues on the transactional client (5.2, 9.2)
    - Assert `removeUserFromTeam` enqueues per direct-admin Team on the transactional client (5.4, 9.2)
    - Assert NOTHING enqueues at any of these sites when the flag is off (1.4)
    - _Requirements: 1.4, 5.1, 5.2, 5.3, 5.4, 9.2_

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement the idempotent backfill
  - [x] 10.1 Create `scripts/create-cloudtak-groups.js`
    - If `isCloudTakEnabled()` is false, log that the integration is disabled and exit 0 without enqueuing (Requirement 8.5)
    - Otherwise `SELECT id FROM teams ORDER BY id` and enqueue one `create_cloudtak_group` with `{ team_id: id }` per Team; log a summary; exit 0 (or 1 on error)
    - Model on `scripts/create-team-channels.js`
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 1.5_
  - [x] 10.2 Add a `cloudtak:backfill` script entry to `package.json`
    - `"cloudtak:backfill": "node scripts/create-cloudtak-groups.js"`
    - _Requirements: 8.4_
  - [x]* 10.3 Write property test for the backfill enqueue-per-team behavior (mock the database + `EventPublisher`)
    - **Property 8: Backfill enqueues one creation per existing Team**
    - **Validates: Requirements 8.1, 8.3**
  - [x]* 10.4 Write unit tests for the disabled backfill and no-teardown-on-disable behavior
    - Assert the backfill enqueues nothing and reports disabled when the flag is off (1.5, 8.5)
    - Assert there is no disable-time teardown hook (1.6)
    - _Requirements: 1.5, 1.6, 8.5_
  - [x]* 10.5 Write property test for disabled inertness across all enqueue sites
    - **Property 2: Disabled inertness enqueues nothing**
    - **Validates: Requirements 1.4, 1.5**

- [x] 11. Final checkpoint - verify the full build
  - Run `npm test` and confirm all tests pass
  - Run `npm run lint` and confirm the problem count does not increase above the `157 problems (145 errors, 12 warnings)` baseline
  - _Requirements: 9.5_

## Notes

- Tasks marked with `*` are optional (test-only) and can be skipped for a faster MVP.
- Each task references specific granular requirements for traceability.
- Checkpoints ensure incremental validation.
- Property tests validate the universal Correctness Properties from the design; unit tests validate specific Authentik request shapes, edge cases, and error conditions.
- Every enqueue site is guarded by `isCloudTakEnabled()`, and each site's test asserts nothing enqueues when the flag is off.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "2.3", "2.4", "3.2"] },
    { "id": 2, "tasks": ["2.5", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.4", "4.5"] },
    { "id": 4, "tasks": ["4.6", "6.1", "8.2", "8.3", "10.1"] },
    { "id": 5, "tasks": ["6.2", "10.2", "10.3", "10.4"] },
    { "id": 6, "tasks": ["7.1"] },
    { "id": 7, "tasks": ["8.1"] },
    { "id": 8, "tasks": ["6.3", "7.2", "8.4", "10.5"] }
  ]
}
```
