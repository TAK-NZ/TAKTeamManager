# Design Document: CloudTAK Agency Groups

## Overview

This feature mirrors every Team (root Organisation and Sub_Team alike) in the `teams` table into an Authentik LDAP group named `CloudTAKAgency<id>`, carrying three attributes (`agencyId`, `agencyName`, `description`) and containing the Team's direct admins. The mirror is kept in sync as Teams are created, renamed/re-described, and deleted, and as their direct admins change. The whole integration is gated behind a single server-side flag, `CLOUDTAK_ENABLED` (default `false`), read as `process.env.CLOUDTAK_ENABLED === 'true'` and never surfaced to the client.

All Authentik work is performed asynchronously through the existing durable `sync_operations` queue and the Sync_Worker, so a brief Authentik outage never blocks the originating request and every CloudTAK call is retried on the established schedule. A one-off, idempotent, re-runnable Backfill creates and reconciles the groups for all existing Teams when the integration is first enabled.

The design deliberately reuses the codebase's established primitives rather than introducing new infrastructure:

- The `EventPublisher.publishOperation(operationType, payload, createdBy, client?)` enqueue path and the `sync_operations` table.
- The Sync_Worker's `executeOperation` dispatch switch, per-handler Authentik `fetch` calls, `AuthentikApiError`/`classifyFailure` failure classification, and the Create_Or_Reuse (POST-then-lookup-by-name) pattern from `Team.createTeamChannel`.
- The `operationSchemas.js` payload-validation map.
- The Team lifecycle write points in `server/models/Team.js` and `server/routes/teams.js`.
- The `scripts/create-team-channels.js` backfill precedent.

## Existing Infrastructure Reused

This section records the exact existing components this design builds on, with the observations that constrain the design.

### Durable sync queue: `EventPublisher` + `sync_operations`

`server/services/EventPublisher.js` exposes `publishOperation(operationType, payload, createdBy = null, client = null)`. It inserts one `sync_operations` row and hoists `payload.target_user_id` and `payload.target_group_id` into dedicated columns. The optional `client` parameter lets a caller enqueue on an already-`BEGIN`-ed transactional client so the enqueue commits or rolls back atomically with the caller's other writes (Requirement 9.2). This is the established pattern used by `TeamMembershipService`, `GlobalChannelService`, `VendorChannelService`, and `Team.delete`.

### Sync_Worker handlers and dispatch

`server/workers/syncWorker.js`'s `executeOperation(operation)` validates the payload against `operationSchemas.js` and then dispatches on `operation_type` through a `switch`. Every handler that calls Authentik uses `fetch` against `${process.env.AUTHENTIK_URL}/api/v3/...` with a bearer token from `process.env.AUTHENTIK_ADMIN_TOKEN`. On a non-2xx response the handler throws `AuthentikApiError(message, classifyFailure(status))`; `classifyFailure` returns `'retryable'` for 5xx/network/timeout and `'permanent'` for 4xx. `executeOperationSafely` then either schedules a retry (retryable) or calls `markPermanentlyFailed` (permanent). Handlers that delete a resource treat a `404` as an already-satisfied no-op (see `removeTeamChannelGroup`, `cleanupOrphanedAuthentikUser`).

Existing group helpers demonstrate every Authentik call this feature needs:

- Create: `createGroup(payload)` does `POST /core/groups/` with `{ name, attributes }`.
- Create-or-reuse: `Team.createTeamChannel` does `POST /core/groups/`, and on `!ok` does `GET /core/groups/?name=<encodeURIComponent(name)>` and finds the group by exact name, reusing its `pk`.
- Update: `updateBchChannelGroup`/`updateRegionChannelGroup` do `PATCH /core/groups/{pk}/` with `{ name, attributes }`.
- Delete: `deleteGlobalChannelGroup`/`removeTeamChannelGroup` do `DELETE /core/groups/{pk}/`.
- Membership: `addUserToGroup`/`removeUserFromGroup` resolve `users.authentik_user_id` for `payload.target_user_id` via `getUser`, then `POST /core/groups/{target_group_id}/add_user/` or `/remove_user/` with `{ pk: authentik_user_id }`. `removeAllMembersFromGroup` shows `GET /core/groups/{pk}/` returning the current member `pk` list in `group.users`.

### Operation schema registry

`server/workers/operationSchemas.js` is a plain object keyed by `operation_type`, each entry declaring `requiredFields` (and optionally `optionalFields`) as `{ fieldName: typeofString }`. `typeof [] === 'object'` and `typeof {} === 'object'`, so array/object payload fields are declared with type `'object'` (as `group_attributes` and `tak_usernames` already are). `operationSchemas.test.js` enforces that every `switch` case in `executeOperation` has a matching entry, so each new CloudTAK operation type MUST be registered here (Requirement 9.5).

### Team lifecycle hooks (read from the actual handlers)

- **Creation**: `Team.create(teamData)` inserts the `teams` row and calls `createTeamChannel(team.id)`. `POST /api/teams` (`server/routes/teams.js`) calls `Team.create`. The new `teams.id` is available on the returned row.
- **Update**: `Team.update(teamId, updateData)` runs a single `UPDATE teams SET name = COALESCE(...), description = COALESCE(...), ...` and returns the updated row. `PUT /api/teams/:teamId` calls it.
- **Deletion**: `Team.delete(teamId, deletedBy)` runs inside one transaction on one acquired `client`, enqueues per-channel `remove_team_channel_group` and a bulk `revoke_tak_certificates` Sync_Operation on that same `client`, then commits. `DELETE /api/teams/:teamId` calls `Team.delete(req.params.teamId, req.user.userId)`. Because the `teams.id` is deleted inside this transaction, the CloudTAK deletion must carry the id in its payload and resolve the group by name (there is no local row left to look it up from) — mirroring how `remove_team_channel_group` carries the Authentik group ids explicitly.
- **Direct-admin add / promote**: `Team.addMember(teamId, userId, role = 'member')` runs `INSERT INTO team_memberships (team_id, user_id, role) VALUES (...) ON CONFLICT (user_id, team_id) DO UPDATE SET role = $3`. It is the single mutation point for both adding a member with `role: 'admin'` and promoting/demoting an existing member's role. `POST /api/teams/:teamId/members` calls it with the request's `role`. During user creation, `POST /api/users/create-and-add` (`server/routes/users.js`) promotes a freshly created membership to `'admin'` via a direct `UPDATE`.
- **Direct-admin demote**: also flows through `Team.addMember` (the `ON CONFLICT ... DO UPDATE SET role` branch) when the new role is `'member'`.
- **Direct-admin removal / team removal**: `TeamMembershipService.removeUserFromTeam(userId, createdBy, externalClient?)` deletes the user's `team_memberships` rows. `DELETE /api/users/remove-from-team/:userId` calls it and then deletes the user from Authentik and from the local `users`/`user_cache` tables entirely.

### Direct-admin query (must not use `Team.isAdmin`)

`Team.isAdmin(teamId, userId)` resolves inherited admins via a recursive CTE walking the Ancestor_Chain, so it MUST NOT be used for CloudTAK membership (Requirement 4.3). The correct query for a Team's Direct_Admin_Set is:

```sql
SELECT tm.user_id, u.authentik_user_id
FROM team_memberships tm
JOIN users u ON u.id = tm.user_id
WHERE tm.team_id = $1
  AND tm.role = 'admin'
  AND tm.inherited_from_team_id IS NULL
```

Rationale (Requirement 4.4): each Team has its OWN `CloudTAKAgency<id>` group. An inherited admin of a Team is, by definition, a Direct_Admin of some ancestor Team, and is therefore already a member of that ancestor's CloudTAK_Group. Replicating inherited admins into every descendant group would be redundant and would misrepresent who directly administers each Team.

### Backfill precedent

`scripts/create-team-channels.js` runs `SELECT id, name FROM teams ORDER BY id` and calls `Team.createTeamChannel(team.id)` per row, exiting `0`/`1`. The CloudTAK Backfill script models this shape but enqueues CloudTAK_Sync_Operations instead of calling Authentik directly.

### Config validation

`server/config/configValidator.js` validates required env at startup and reads optional variables with safe defaults inline (e.g. retention days). `CLOUDTAK_ENABLED` is optional with a safe default (`false`), so it is documented in `.env.example` rather than added to `REQUIRED_VARS`. It is intentionally excluded from `SiteConfig.getPublicConfig()` (Requirement 1.3).

## Architecture

### Flag read at the enqueue sites

CloudTAK_Enabled is a server-only boolean. A single tiny helper module, `server/config/cloudtak.js`, exports `isCloudTakEnabled(env = process.env)` returning `env.CLOUDTAK_ENABLED === 'true'`, matching the existing boolean-env convention (`RECAPTCHA_DISABLED === 'true'`). Every enqueue site calls this helper and returns early when it is false, so that when the flag is off no CloudTAK_Sync_Operation is ever enqueued (Requirement 1.4) — the guard lives at the enqueue site, never in the Sync_Worker handlers.

A second helper module, `server/services/CloudTakAgencyGroup.js`, holds the pure, side-effect-free logic reused by every enqueue site, the Sync_Worker handlers, and the Backfill:

- `groupName(teamId)` → `` `CloudTAKAgency${teamId}` ``.
- `agencyAttributes(team)` → `{ agencyId: <number>, agencyName: team.name, description: team.description }`.
- The Direct_Admin_Set query helper `getDirectAdmins(teamId, client?)` returning `[{ user_id, authentik_user_id }]`.

Keeping these pure and centralized means the group name, attribute shape, and direct-admin definition have exactly one implementation, testable directly.

### New operation types

Three new `operation_type`s are added and registered in `operationSchemas.js`:

- `create_cloudtak_group` — create-or-reuse the group and set its Agency_Attributes (Requirements 2, 3, 10.1).
- `update_cloudtak_group` — resolve the group by name and set its Agency_Attributes (Requirement 6).
- `delete_cloudtak_group` — resolve the group by name and delete it, treating a 404/absent group as a satisfied no-op (Requirement 7).

Each maps to a new Sync_Worker handler (`createCloudTakGroup`, `updateCloudTakGroup`, `deleteCloudTakGroup`) added to the `executeOperation` switch, following the existing handler shape (fetch → `AuthentikApiError`/`classifyFailure`).

### How membership is synced

Membership reconciliation is performed by the CloudTAK handlers themselves rather than by reusing `add_user_to_group`/`remove_user_from_group`, for one concrete reason: those existing operations require `target_group_id` to be the Authentik group `pk`, but at the enqueue sites the CloudTAK_Group's `pk` is not known (the group may not exist yet, and this feature intentionally keys off the group NAME `CloudTAKAgency<id>`, not a locally stored `pk`). Resolving the group by name and reconciling members therefore lives inside the handlers, which already have to resolve the group by name for create/update/delete.

- `create_cloudtak_group` and `update_cloudtak_group` both reconcile membership after ensuring the group exists: they resolve the group `pk`, read the current member `pk` list (`GET /core/groups/{pk}/` → `group.users`), compute the target set as the Team's current Direct_Admin_Set (`authentik_user_id` values), and issue `add_user`/`remove_user` calls for the difference so the group's membership equals the Direct_Admin_Set (Requirements 5.5, 10.5). Reconciling to the current set — rather than applying a single add/remove delta — makes every CloudTAK_Sync_Operation idempotent and lets a single operation type serve creation, attribute update, and membership change.

**Design decision (flagged for review):** the direct-admin membership-change routes (`POST /:teamId/members`, the create-and-add promotion, `removeUserFromTeam`) enqueue an `update_cloudtak_group` operation for the affected Team, which re-reconciles the whole Direct_Admin_Set, rather than a targeted single-user add/remove. This is simpler and self-healing (a missed event is corrected by the next reconcile), at the cost of one `GET` plus the diff per change. The alternative — enqueuing `add_user_to_group`/`remove_user_from_group` with the resolved group `pk` — would require each route to first resolve the group `pk` synchronously (an Authentik call in the request path) or to store the `pk` locally, both of which conflict with keying off the group name. The reconcile-on-`update_cloudtak_group` approach is recommended and used below.

### Exact enqueue points

Each enqueue site first calls `isCloudTakEnabled()` and returns early if false.

1. **`Team.create`** (creation, Requirement 2.1): after the `teams` INSERT succeeds and `team.id` is known, enqueue `create_cloudtak_group` with `{ team_id: team.id }`. `Team.create` does not currently run inside an explicit transaction for the INSERT, so this enqueue uses the default pool (no `client`); this is acceptable because a Team with no group is self-healed by the Backfill and by any later update. (If `Team.create` is refactored to a transaction, thread the `client` through per Requirement 9.2.)
2. **`Team.update`** (rename/re-describe, Requirement 6.1/6.2): after the `UPDATE teams` returns the updated row, enqueue `update_cloudtak_group` with `{ team_id: teamId }`. Enqueue only when `name` or `description` was actually part of the update, to avoid needless operations.
3. **`Team.delete`** (deletion, Requirement 7.1): inside the existing transaction, before `COMMIT`, enqueue `delete_cloudtak_group` with `{ team_id: teamId }` on the same `client` (Requirement 9.2), alongside the existing `remove_team_channel_group`/`revoke_tak_certificates` enqueues. The id is captured before the row is deleted.
4. **`Team.addMember`** (direct-admin add/promote/demote, Requirement 5.1/5.2/5.3): after the upsert, enqueue `update_cloudtak_group` with `{ team_id: teamId }` to re-reconcile the Direct_Admin_Set. This single site covers adding an admin, promoting a member to admin, and demoting an admin to member, because all three flow through `Team.addMember`'s `ON CONFLICT ... DO UPDATE SET role`.
5. **`POST /api/users/create-and-add` admin promotion** (Requirement 5.2): after the membership is promoted to `'admin'` on the transactional client, enqueue `update_cloudtak_group` with `{ team_id }` on that same client.
6. **`TeamMembershipService.removeUserFromTeam`** (direct-admin removal / team removal, Requirement 5.4): this method deletes the user's `team_memberships` rows. Before deleting them, capture the set of Team ids for which the user held a Direct_Admin row (`role = 'admin' AND inherited_from_team_id IS NULL`); after deletion, enqueue one `update_cloudtak_group` per such Team id on the same transactional client, so each affected group re-reconciles without the removed user.

Because the Backfill and each `create`/`update` reconcile to the full Direct_Admin_Set, a race (e.g. the group not existing yet when a membership operation runs) is self-correcting: `update_cloudtak_group` performs Create_Or_Reuse itself, so it can safely run even if `create_cloudtak_group` has not yet been processed.

### Backfill script design

`scripts/create-cloudtak-groups.js`, invoked via a new `package.json` script `cloudtak:backfill`, models `scripts/create-team-channels.js`:

1. If `isCloudTakEnabled()` is false, log that the integration is disabled and exit `0` without enqueuing anything (Requirement 8.5).
2. `SELECT id FROM teams ORDER BY id`.
3. For each Team, enqueue a `create_cloudtak_group` Sync_Operation with `{ team_id: id }` (default pool; no request transaction).
4. Log a summary and exit `0` (or `1` on unexpected error).

The Backfill is idempotent because each enqueued `create_cloudtak_group` is itself idempotent: Create_Or_Reuse never fails on an existing group, always sets the Agency_Attributes authoritatively, and reconciles members to the current Direct_Admin_Set (Requirements 8.2, 8.3, 10.4, 10.5). Running the Backfill twice enqueues a second round of identical operations that converge to the same end state.

An optional Global_Manager-only admin endpoint could enqueue the same operations, but the script is the primary, recommended mechanism per the requirement; the endpoint is left out of scope unless later requested.

## Components and Interfaces

### `server/config/cloudtak.js` (new)

```
isCloudTakEnabled(env = process.env) -> boolean   // env.CLOUDTAK_ENABLED === 'true'
```

### `server/services/CloudTakAgencyGroup.js` (new)

```
groupName(teamId) -> string                        // `CloudTAKAgency${teamId}`
agencyAttributes(team) -> { agencyId, agencyName, description }
getDirectAdmins(teamId, client?) -> Promise<Array<{ user_id, authentik_user_id }>>
```

### `server/services/EventPublisher.js` (reused, unchanged)

`publishOperation('create_cloudtak_group' | 'update_cloudtak_group' | 'delete_cloudtak_group', payload, createdBy, client?)`.

### `server/workers/operationSchemas.js` (extended)

Adds three entries (see Data Models).

### `server/workers/syncWorker.js` (extended)

Adds three `switch` cases and three handler methods:

```
createCloudTakGroup(payload)   // create-or-reuse group by name, set Agency_Attributes, reconcile members
updateCloudTakGroup(payload)   // create-or-reuse group by name, set Agency_Attributes, reconcile members
deleteCloudTakGroup(payload)   // resolve group by name, DELETE; 404/absent = no-op
```

`createCloudTakGroup` and `updateCloudTakGroup` share a private reconcile helper. Each handler loads the Team's current `name`/`description` and Direct_Admin_Set from the database (for create/update) so the attributes and membership reflect the current stored state at processing time.

### Team lifecycle write points (extended)

`Team.create`, `Team.update`, `Team.delete`, `Team.addMember`, `TeamMembershipService.removeUserFromTeam`, and the create-and-add promotion in `server/routes/users.js`, each guarded by `isCloudTakEnabled()`.

### `scripts/create-cloudtak-groups.js` (new) + `package.json` `cloudtak:backfill` script

## Data Models

### Sync_Operation payloads

`create_cloudtak_group`:

```json
{ "team_id": 10 }
```

`update_cloudtak_group`:

```json
{ "team_id": 10 }
```

`delete_cloudtak_group`:

```json
{ "team_id": 10 }
```

All three carry only `team_id` (the numeric `teams.id`). For create/update the handler resolves the Team's current `name`, `description`, and Direct_Admin_Set from the database at processing time, so a rename or membership change that occurred between enqueue and processing is reflected. For delete the Team row is gone, so the handler derives the group name purely from `team_id` (`CloudTAKAgency<team_id>`) and resolves the group by name in Authentik.

### `operationSchemas.js` entries

```js
create_cloudtak_group: { requiredFields: { team_id: 'number' } },
update_cloudtak_group: { requiredFields: { team_id: 'number' } },
delete_cloudtak_group: { requiredFields: { team_id: 'number' } },
```

### Authentik CloudTAK_Group representation

- Name: `CloudTAKAgency<team_id>`.
- Attributes: `{ agencyId: <number>, agencyName: <string>, description: <string|null> }`.
- Members: the Team's Direct_Admin_Set, identified by each user's `users.authentik_user_id`.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The properties below were derived from the acceptance-criteria prework analysis. Several criteria are UI/structural/one-shot (e.g. "not in public config", "runnable as npm script", "register in schema map") and are covered by example, edge-case, integration, or smoke tests in the Testing Strategy rather than by universal properties. Redundant criteria were consolidated: `agencyId` remaining equal to the id (6.4) is subsumed by the attribute-mapping property; the inherited-admin exclusion (4.4) is subsumed by the direct-admin-set property; and idempotent re-reconcile (10.5) is subsumed by the membership-reconcile property.

### Property 1: Enablement flag predicate

*For all* possible values of the `CLOUDTAK_ENABLED` environment variable (including unset, empty, and arbitrary strings), `isCloudTakEnabled` SHALL return `true` if and only if the value is exactly the string `'true'`.

**Validates: Requirements 1.1, 1.2**

### Property 2: Disabled inertness enqueues nothing

*For all* Team lifecycle events (creation, update, deletion, direct-admin add, promote, demote, removal) and for the Backfill, WHILE CloudTAK_Enabled is false, exercising the event SHALL result in zero CloudTAK_Sync_Operations being enqueued.

**Validates: Requirements 1.4, 1.5**

### Property 3: Group name is exactly `CloudTAKAgency<id>`

*For all* Team ids, `groupName(id)` SHALL equal the concatenation of the literal `CloudTAKAgency` and the id's decimal representation, and SHALL NOT contain any additional prefix (in particular no `tak_` prefix).

**Validates: Requirements 2.2**

### Property 4: Agency attributes map exactly to the Team's fields

*For all* Team objects, `agencyAttributes(team)` SHALL equal `{ agencyId: team.id, agencyName: team.name, description: team.description }`, so that `agencyId` is always the Team's numeric id regardless of any name or description change.

**Validates: Requirements 3.1, 3.2, 3.3, 6.4**

### Property 5: Membership set equals the direct-admin set

*For all* sets of `team_memberships` rows for a Team, the resolved Direct_Admin_Set SHALL equal exactly the subset of rows with `role = 'admin'` AND `inherited_from_team_id IS NULL` — thereby excluding every inherited-admin row — matching a reference filter over those two columns.

**Validates: Requirements 4.1, 4.2, 4.4**

### Property 6: Membership reconciliation yields the direct-admin set

*For all* current CloudTAK_Group member sets and all target Direct_Admin_Sets, after the Sync_Worker reconciles the group, the group's membership SHALL equal the target Direct_Admin_Set (missing members added, extra members removed), and reconciling again with an unchanged target set SHALL leave the membership unchanged.

**Validates: Requirements 5.5, 10.5**

### Property 7: Create/update attribute idempotence

*For all* Team stored values, processing a `create_cloudtak_group` or `update_cloudtak_group` Sync_Operation more than once SHALL leave the CloudTAK_Group's name and Agency_Attributes identical to the result of processing it once (`f(x) = f(f(x))`).

**Validates: Requirements 10.4, 2.5, 3.4, 6.3**

### Property 8: Backfill enqueues one creation per existing Team

*For all* sets of existing Teams, WHILE CloudTAK_Enabled is true, running the Backfill SHALL enqueue exactly one `create_cloudtak_group` Sync_Operation carrying that Team's id for each existing Team, and no more.

**Validates: Requirements 8.1, 8.3**

## Error Handling

CloudTAK Authentik calls reuse the Sync_Worker's existing failure-classification machinery, so error handling is consistent with every other Authentik-calling handler.

- **Retryable failures** (5xx responses, network errors, timeouts): each CloudTAK handler throws `AuthentikApiError(message, classifyFailure(status | error))`, which classifies these as `'retryable'`. `executeOperationSafely` then routes the operation through `handleOperationError`, scheduling a retry on the established backoff (Requirements 9.3, 10.2). The originating request already returned successfully, so nothing is blocked (Requirement 9.4).
- **Name-conflict on creation** (a 4xx from `POST /core/groups/` because a group with the target name already exists): the `createCloudTakGroup`/`updateCloudTakGroup` handlers catch this specific case by performing a `GET /core/groups/?name=<encoded>` lookup and reusing the existing group's `pk` (Create_Or_Reuse), exactly like `Team.createTeamChannel`. This is NOT treated as a permanent failure (Requirement 10.1). After reuse, the handler still sets the Agency_Attributes authoritatively (Requirement 2.5) and reconciles membership.
- **Other permanent failures** (a non-conflict 4xx on create, update, or delete — e.g. an authorization error): the handler throws `AuthentikApiError(message, 'permanent')`; `executeOperationSafely` calls `markPermanentlyFailed` without scheduling a retry (Requirement 10.3).
- **Absent group on deletion** (a 404 from the lookup or the `DELETE`): `deleteCloudTakGroup` treats an already-absent group as an already-satisfied deletion and completes the operation successfully, mirroring `removeTeamChannelGroup`/`cleanupOrphanedAuthentikUser`'s 404 handling (Requirement 7.3).
- **Membership reconciliation partial failures**: within a reconcile, an individual `add_user`/`remove_user` returning 404 for a member that changed between the `GET` and the call is treated as a no-op `continue`; any other non-2xx classifies via `classifyFailure` and aborts the reconcile, so a retry re-reads the current membership and resumes — the reconcile is safely idempotent across retries (Requirement 10.5).
- **Enqueue atomicity**: at transactional sites (`Team.delete`, `TeamMembershipService.removeUserFromTeam`, the create-and-add promotion), the enqueue is performed on the caller's open `client`, so if the surrounding transaction rolls back, the CloudTAK_Sync_Operation is never persisted (Requirement 9.2). At non-transactional sites (`Team.create`, `Team.update`, `Team.addMember` on the pool, and the Backfill), a lost enqueue is self-healed by the Backfill and by the next reconcile, because `update_cloudtak_group` performs Create_Or_Reuse.

## Testing Strategy

Testing follows the existing conventions: server tests use jest + supertest with `jest.mock('../config/database')` and mock `EventPublisher.publishOperation`; Sync_Worker handlers are unit-tested by mocking `global.fetch` (the Authentik calls). Property-based tests use `fast-check` (already used across the codebase, e.g. `server/routes/users.transfer.integration.test.js`).

### Dual approach

- **Unit / example tests** cover specific behaviors, edge cases, and error conditions: the public-config exclusion (Requirement 1.3); the disabled Backfill report (1.5); no teardown on disable (1.6); per-site enqueue on create/update/delete/add/promote/demote/remove (2.1, 5.1–5.4, 6.1, 6.2, 7.1); handler Authentik call shapes (2.3, 2.5, 3.4, 4.5, 6.3, 7.2); Create_Or_Reuse on name conflict (2.4, 10.1); absent-group deletion (7.3); retryable vs permanent classification (9.3, 10.2, 10.3); transactional-client enqueue (9.2); and the structural "no synchronous Authentik in the request path" assertion (9.1, 9.4).
- **Property-based tests** cover the input-varying, pure or reconcile logic, one property per Correctness Property above.
- **Smoke / integration tests** cover one-shot setup: the `cloudtak:backfill` npm script entry exists and the script module loads (8.4); and `operationSchemas` contains the three new entries, with the existing `operationSchemas.test.js` completeness test enforcing switch↔schema parity (9.5).

### Property test configuration

- Each Correctness Property is implemented by a SINGLE `fast-check` property test.
- Each property test runs a minimum of 100 iterations (`fc.assert(..., { numRuns: 100 })` or higher).
- Each property test is tagged with a comment referencing its design property, in the format:
  `// Feature: cloudtak-agency-groups, Property {number}: {property text}`.
- Properties over pure functions (`isCloudTakEnabled`, `groupName`, `agencyAttributes`) run directly against those functions. The direct-admin-set property (Property 5) validates the resolver's result against an independent reference filter over generated membership rows (model-based). The reconcile property (Property 6) validates the diff computation against a generated current-set/target-set pair. The idempotence property (Property 7) applies the handler twice against a mocked Authentik and asserts the resulting name/attributes are identical. The backfill property (Property 8) generates a random set of team ids returned by the mocked database and asserts exactly one `create_cloudtak_group` enqueue per id.

### Unit testing balance

Unit tests focus on concrete examples, integration points (the exact Authentik request shapes), and error conditions. They deliberately do not attempt to enumerate input spaces that the property tests already cover (flag values, ids, attribute mappings, membership sets), keeping the example suite small and focused.
