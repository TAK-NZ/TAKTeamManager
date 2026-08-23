# Requirements Document

## Introduction

This feature adds an optional CloudTAK integration to TAK Team Manager. WHEN the integration is enabled, every Team and Organisation in the `teams` table (root Organisations and Sub_Teams alike) is mirrored into a corresponding Authentik LDAP group named `CloudTAKAgency<id>` (where `<id>` is that Team's numeric `teams.id`). Each such group carries three attributes describing the Team (`agencyId`, `agencyName`, `description`), and the Team's DIRECT admins are kept as members of the group. The group's name, attributes, and membership are kept in sync as Teams are created, renamed or re-described, deleted, and as their direct admins are added, removed, promoted, or demoted.

The integration is gated behind a single server-side environment flag, `CLOUDTAK_ENABLED`, defaulting to `false`. WHEN the flag is disabled the feature is entirely inert: no CloudTAK group is created, updated, or deleted, no membership change is made, and no backfill runs. The flag is read only on the server and is deliberately not surfaced through the public configuration endpoint.

All CloudTAK Authentik work is performed through the existing durable `sync_operations` queue processed by the Sync_Worker (`server/workers/syncWorker.js`), rather than by calling Authentik synchronously from a request handler. This means a brief Authentik outage never blocks the originating request and every CloudTAK Authentik call is retried by the Sync_Worker on the established schedule. A one-off, idempotent, re-runnable Backfill retroactively creates the group, attributes, and direct-admin members for all existing Teams when the integration is first enabled.

This document specifies only the behavior of this integration. It does not restate the existing Sync_Worker, `EventPublisher`, Authentik group API, or Team lifecycle behavior it builds on, except where a new requirement constrains that behavior.

## Glossary

- **CloudTAK_Integration**: The optional feature specified by this document that mirrors each Team into an Authentik CloudTAK_Group.
- **CloudTAK_Enabled**: The server-side boolean derived from the `CLOUDTAK_ENABLED` environment variable, true only when `process.env.CLOUDTAK_ENABLED === 'true'`, defaulting to false when the variable is unset or holds any other value. Read on the server only.
- **Team**: A row in the `teams` table. This term covers both a root Organisation (`parent_team_id IS NULL`) and a Sub_Team (`parent_team_id` non-null); the CloudTAK_Integration treats them identically.
- **CloudTAK_Group**: The Authentik group corresponding to a Team, named exactly `CloudTAKAgency<id>` where `<id>` is that Team's `teams.id`.
- **Agency_Attributes**: The three Authentik group attributes carried by a CloudTAK_Group: `agencyId` (the numeric `teams.id`), `agencyName` (the Team's `name`), and `description` (the Team's `description`).
- **Direct_Admin**: A user who holds a `team_memberships` row for a given Team with `role = 'admin'` AND `inherited_from_team_id IS NULL`. A Direct_Admin is distinct from an inherited admin, whose admin status derives from a Direct_Admin row on an ancestor Team.
- **Direct_Admin_Set**: The set of all Direct_Admins of a given Team, resolved directly from `team_memberships` and NOT via `Team.isAdmin` (which resolves inherited admins up the Ancestor_Chain).
- **Authentik_User_Pk**: The Authentik primary key of a user, stored locally as `users.authentik_user_id`, used as the identifier when adding or removing a user from an Authentik group.
- **Sync_Operation**: A row in the `sync_operations` table enqueued via `EventPublisher.publishOperation`, processed asynchronously and with retries by the Sync_Worker.
- **Sync_Worker**: The durable background worker (`server/workers/syncWorker.js`) that dequeues and executes each Sync_Operation, retrying transient failures.
- **CloudTAK_Sync_Operation**: A Sync_Operation whose `operation_type` is one of the new CloudTAK operation types (`create_cloudtak_group`, `update_cloudtak_group`, `delete_cloudtak_group`) or a membership Sync_Operation enqueued specifically to reconcile a CloudTAK_Group's members.
- **Backfill**: The one-off, idempotent, re-runnable operation that creates or reconciles the CloudTAK_Group, Agency_Attributes, and Direct_Admin members for every existing Team.
- **Create_Or_Reuse**: The idempotent behavior whereby creating a CloudTAK_Group that already exists in Authentik (matched by name) reuses the existing group rather than failing, mirroring the existing `Team.createTeamChannel` create-or-lookup pattern.
- **Public_Config_Endpoint**: The `GET /api/config/public` endpoint that returns client-visible configuration.

## Requirements

### Requirement 1: CloudTAK Integration Enablement Flag

**User Story:** As an operator, I want to enable or disable the CloudTAK integration with a single server-side flag, so that I can turn the feature on for deployments that use CloudTAK and leave it entirely off elsewhere.

#### Acceptance Criteria

1. THE CloudTAK_Integration SHALL derive CloudTAK_Enabled as true WHEN `process.env.CLOUDTAK_ENABLED` equals the string `'true'`, and as false otherwise.
2. WHERE the `CLOUDTAK_ENABLED` environment variable is unset, THE CloudTAK_Integration SHALL treat CloudTAK_Enabled as false.
3. THE CloudTAK_Integration SHALL read CloudTAK_Enabled on the server only and SHALL NOT include CloudTAK_Enabled in the response of the Public_Config_Endpoint.
4. WHILE CloudTAK_Enabled is false, THE CloudTAK_Integration SHALL NOT enqueue any CloudTAK_Sync_Operation for any Team creation, update, deletion, or direct-admin membership change.
5. WHILE CloudTAK_Enabled is false, THE Backfill SHALL make no change to Authentik and SHALL enqueue no CloudTAK_Sync_Operation.
6. WHEN CloudTAK_Enabled transitions from true to false, THE CloudTAK_Integration SHALL leave every existing CloudTAK_Group in Authentik unchanged and SHALL NOT delete, empty, or modify any CloudTAK_Group.

### Requirement 2: CloudTAK Group Creation on Team Creation

**User Story:** As an operator, I want a CloudTAK group created for every new Team and Organisation, so that CloudTAK has an agency group for each Team without manual intervention.

#### Acceptance Criteria

1. WHILE CloudTAK_Enabled is true, WHEN a Team is created, THE CloudTAK_Integration SHALL enqueue a CloudTAK_Sync_Operation to create the CloudTAK_Group for that Team.
2. THE CloudTAK_Integration SHALL name the CloudTAK_Group exactly `CloudTAKAgency<id>`, where `<id>` is the created Team's `teams.id`, with no additional prefix.
3. WHEN the Sync_Worker processes a CloudTAK_Group creation Sync_Operation, THE Sync_Worker SHALL create the CloudTAK_Group in Authentik carrying the Agency_Attributes for that Team.
4. IF a CloudTAK_Group with the target name already exists in Authentik WHEN the Sync_Worker processes a CloudTAK_Group creation Sync_Operation, THEN THE Sync_Worker SHALL reuse the existing group rather than fail (Create_Or_Reuse).
5. WHEN the Sync_Worker reuses an existing CloudTAK_Group during Create_Or_Reuse, THE Sync_Worker SHALL set the Agency_Attributes on that group so the attributes are present even if the group predated them.
6. THE CloudTAK_Integration SHALL apply Requirement 2 identically to a root Organisation and to a Sub_Team.

### Requirement 3: CloudTAK Group Agency Attributes

**User Story:** As a CloudTAK administrator, I want each CloudTAK group to carry its Team's identifier, name, and description, so that CloudTAK can identify and label each agency.

#### Acceptance Criteria

1. THE CloudTAK_Integration SHALL set the CloudTAK_Group's `agencyId` attribute to the Team's numeric `teams.id`.
2. THE CloudTAK_Integration SHALL set the CloudTAK_Group's `agencyName` attribute to the Team's `name`.
3. THE CloudTAK_Integration SHALL set the CloudTAK_Group's `description` attribute to the Team's `description`.
4. WHEN the Sync_Worker creates or updates a CloudTAK_Group, THE Sync_Worker SHALL write all three Agency_Attributes authoritatively from the Team's current stored values.

### Requirement 4: Direct-Admin Membership Definition

**User Story:** As a CloudTAK administrator, I want each CloudTAK group to contain exactly the Team's direct admins, so that inherited admins are not redundantly duplicated into every descendant Team's group.

#### Acceptance Criteria

1. THE CloudTAK_Integration SHALL define the members of a Team's CloudTAK_Group as that Team's Direct_Admin_Set.
2. THE CloudTAK_Integration SHALL resolve the Direct_Admin_Set from `team_memberships` rows for that Team with `role = 'admin'` AND `inherited_from_team_id IS NULL`.
3. THE CloudTAK_Integration SHALL NOT use `Team.isAdmin` to resolve CloudTAK_Group membership, because `Team.isAdmin` resolves inherited admins up the Ancestor_Chain.
4. THE CloudTAK_Integration SHALL exclude an inherited admin of a Team from that Team's CloudTAK_Group membership, because that user is a Direct_Admin of an ancestor Team and is already a member of the ancestor's CloudTAK_Group.
5. WHEN the Sync_Worker adds a Direct_Admin to a CloudTAK_Group, THE Sync_Worker SHALL identify that user in Authentik by the user's Authentik_User_Pk.

### Requirement 5: Membership Synchronization on Direct-Admin Change

**User Story:** As a CloudTAK administrator, I want a CloudTAK group's membership to follow its Team's direct-admin changes, so that the group always reflects who currently administers the Team.

#### Acceptance Criteria

1. WHILE CloudTAK_Enabled is true, WHEN a user is added to a Team as a Direct_Admin, THE CloudTAK_Integration SHALL enqueue a CloudTAK_Sync_Operation to add that user to the Team's CloudTAK_Group.
2. WHILE CloudTAK_Enabled is true, WHEN a user is promoted to Direct_Admin of a Team, THE CloudTAK_Integration SHALL enqueue a CloudTAK_Sync_Operation to add that user to the Team's CloudTAK_Group.
3. WHILE CloudTAK_Enabled is true, WHEN a Direct_Admin of a Team is demoted to a non-admin role, THE CloudTAK_Integration SHALL enqueue a CloudTAK_Sync_Operation to remove that user from the Team's CloudTAK_Group.
4. WHILE CloudTAK_Enabled is true, WHEN a Direct_Admin of a Team is removed from that Team, THE CloudTAK_Integration SHALL enqueue a CloudTAK_Sync_Operation to remove that user from the Team's CloudTAK_Group.
5. WHEN the Sync_Worker processes a CloudTAK_Group membership Sync_Operation for a Team, THE Sync_Worker SHALL make the CloudTAK_Group's membership equal to the Team's current Direct_Admin_Set.

### Requirement 6: CloudTAK Group Attribute Update on Team Rename or Re-Description

**User Story:** As a CloudTAK administrator, I want a CloudTAK group's attributes updated when its Team is renamed or re-described, so that the group's `agencyName` and `description` stay accurate.

#### Acceptance Criteria

1. WHILE CloudTAK_Enabled is true, WHEN a Team's `name` changes, THE CloudTAK_Integration SHALL enqueue a CloudTAK_Sync_Operation to update the CloudTAK_Group's `agencyName` attribute to the Team's new `name`.
2. WHILE CloudTAK_Enabled is true, WHEN a Team's `description` changes, THE CloudTAK_Integration SHALL enqueue a CloudTAK_Sync_Operation to update the CloudTAK_Group's `description` attribute to the Team's new `description`.
3. WHEN the Sync_Worker processes a CloudTAK_Group update Sync_Operation, THE Sync_Worker SHALL set the CloudTAK_Group's Agency_Attributes from the Team's current stored values.
4. THE CloudTAK_Integration SHALL keep the CloudTAK_Group's `agencyId` attribute equal to the Team's `teams.id` across every attribute update.

### Requirement 7: CloudTAK Group Deletion on Team Deletion

**User Story:** As a CloudTAK administrator, I want a CloudTAK group deleted when its Team is deleted, so that CloudTAK does not retain agency groups for Teams that no longer exist.

#### Acceptance Criteria

1. WHILE CloudTAK_Enabled is true, WHEN a Team is deleted, THE CloudTAK_Integration SHALL enqueue a CloudTAK_Sync_Operation to delete that Team's CloudTAK_Group.
2. WHEN the Sync_Worker processes a CloudTAK_Group deletion Sync_Operation, THE Sync_Worker SHALL delete the CloudTAK_Group identified by the name `CloudTAKAgency<id>` from Authentik.
3. IF the CloudTAK_Group named `CloudTAKAgency<id>` is already absent from Authentik WHEN the Sync_Worker processes a CloudTAK_Group deletion Sync_Operation, THEN THE Sync_Worker SHALL treat the deletion as already satisfied and complete the Sync_Operation successfully.

### Requirement 8: Idempotent Backfill for Existing Teams

**User Story:** As an operator, I want to retroactively create CloudTAK groups for all existing Teams when I first enable the integration, so that Teams created before enablement are also mirrored into CloudTAK.

#### Acceptance Criteria

1. WHILE CloudTAK_Enabled is true, WHEN the Backfill runs, THE Backfill SHALL enqueue a CloudTAK_Group creation Sync_Operation for every existing Team.
2. THE Backfill SHALL cause each existing Team's CloudTAK_Group to be created or reused with its Agency_Attributes set (Create_Or_Reuse) and its members reconciled to the Team's Direct_Admin_Set.
3. WHEN the Backfill runs a second time, THE Backfill SHALL produce the same end state in Authentik as a single run and SHALL NOT fail because a CloudTAK_Group already exists.
4. THE Backfill SHALL be runnable as a one-off script invoked through an npm script, consistent with the existing `scripts/create-team-channels.js` precedent.
5. WHILE CloudTAK_Enabled is false, WHEN the Backfill is invoked, THE Backfill SHALL make no change to Authentik, SHALL enqueue no CloudTAK_Sync_Operation, and SHALL report that the integration is disabled.

### Requirement 9: Durable, Retrying, Non-Blocking Synchronization

**User Story:** As an operator, I want all CloudTAK Authentik work to run through the durable retrying queue, so that a brief Authentik outage never blocks a user's request and never permanently loses a CloudTAK change.

#### Acceptance Criteria

1. THE CloudTAK_Integration SHALL perform every CloudTAK_Group creation, update, deletion, and membership change by enqueuing a Sync_Operation via `EventPublisher.publishOperation`, and SHALL NOT call Authentik synchronously from a request handler.
2. WHEN a CloudTAK_Sync_Operation is enqueued from within an open database transaction for a Team write, THE CloudTAK_Integration SHALL enqueue that Sync_Operation on the same transactional client so the enqueue commits or rolls back atomically with the Team write.
3. IF the Sync_Worker receives a retryable failure from Authentik WHILE processing a CloudTAK_Sync_Operation, THEN THE Sync_Worker SHALL retry the Sync_Operation on its established retry schedule.
4. THE CloudTAK_Integration SHALL NOT block or fail the originating request when a CloudTAK Authentik call fails, because the Authentik call is performed asynchronously by the Sync_Worker.
5. THE CloudTAK_Integration SHALL register each new CloudTAK operation type in the Sync_Worker's operation payload schema map with the fields and types each corresponding Sync_Worker handler reads.

### Requirement 10: CloudTAK Failure Classification and Idempotency

**User Story:** As an operator, I want CloudTAK Authentik failures classified correctly and CloudTAK operations to be safely repeatable, so that transient failures retry and repeated processing never corrupts group state.

#### Acceptance Criteria

1. IF Authentik returns a name-conflict response indicating a CloudTAK_Group with the target name already exists WHEN the Sync_Worker processes a CloudTAK_Group creation Sync_Operation, THEN THE Sync_Worker SHALL look up the existing group by name and reuse it rather than mark the Sync_Operation permanently failed.
2. IF the Sync_Worker receives a transient Authentik failure classified as retryable WHILE processing a CloudTAK_Sync_Operation, THEN THE Sync_Worker SHALL schedule a retry.
3. IF the Sync_Worker receives an Authentik failure classified as permanent, other than the name-conflict case in Criterion 1, WHILE processing a CloudTAK_Sync_Operation, THEN THE Sync_Worker SHALL mark the Sync_Operation permanently failed without scheduling a retry.
4. WHEN the Sync_Worker processes the same CloudTAK_Group creation or update Sync_Operation more than once, THE Sync_Worker SHALL produce the same CloudTAK_Group name and Agency_Attributes each time.
5. WHEN the Sync_Worker processes a CloudTAK_Group membership Sync_Operation more than once for an unchanged Direct_Admin_Set, THE Sync_Worker SHALL leave the CloudTAK_Group's membership equal to that Direct_Admin_Set.
