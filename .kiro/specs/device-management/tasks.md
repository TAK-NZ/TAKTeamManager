# Implementation Plan: Device Management

## Overview

Implementation is incremental and test-driven, following the existing codebase conventions (Node/JavaScript server with jest + supertest + `fast-check`, mocked `config/database` and `EventPublisher`, mocked axios/`global.fetch` for TakServerService and Sync_Worker handlers; React client with vitest + React Testing Library). It builds the pure/config primitives first (the flag module and the secrets-provider binary read), then the credential loader and its P12->PEM conversion, then makes `TakServerService` agent-refreshable and adds the active-cert/subscriptions fetches, then the `tak_devices` migration, then the three scheduled jobs, then wires them into the Sync_Worker, then extends the revoke handler, then the query/authorization service and routes + permission registry, then the client surfaces, and ends with the property tests, checkpoints, and a final verification. Task 18 then adds the optional TAK Server TLS `servername` pinning (Requirement 10) that lets the Marti calls actually complete their handshake, without weakening chain verification.

Tasks 19-23 are the corrections that came out of checking this feature against the live TAK Server (see design.md's "Findings that invalidated earlier assumptions" and Requirements 11-16). They are sequenced by priority: (19) revocation correctness — the device-scoped payload and `/revoked`-membership verification, because the current code over-revokes and reports success unconditionally; (20) Device derivation from Live_Certificates, because the current list is mostly revoked certificates shown as live; (21) Last_Seen from the Client_Endpoints_API, because the current source endpoint does not exist; (22) Client_Type plus the icon/tooltip UI convention; (23) endpoint-tolerance tightening, so a wrong URL can never masquerade as an empty result again. Each section ends with a checkpoint.

Task 24 adds the revocation rails: the separate `DEVICE_MGMT_REVOKE_ENABLED` flag, the disarmed-by-default dry-run, the blast-radius cap, and the pre-action audit record (Requirements 12.9-12.16). **Task 24 MUST be implemented BEFORE task 19.3**, even though it is numbered after it. Task 19.3 is the handler's `client_uid` branch — it is precisely the change that makes a device-scoped revoke actually resolve a target set and issue a `DELETE`. Landing 19.3 first means the destructive path goes live with no separate arming flag, no cap, and no audit record, which is the exposure task 24 exists to close. The Task Dependency Graph orders every 24.x task that gates the `DELETE` (24.1 flag module, 24.2 route gate, 24.3 handler dry-run/cap/audit) into waves ahead of 19.3.

Task 25 closes the read-side half of Requirement 11.5 (Requirement 17): the sync deletes the Device_Table rows whose `client_uid` is absent from the live set it just derived, so a Device whose certificates have all been revoked stops appearing in the Dashboard card and the admin modal. Task 20.2 only ever fixed the write side — it stopped such a `clientUid` being upserted — and no read path filtered a previously-upserted row out. Task 25 also corrects, in place, the claim in design.md and in `DeviceSync.js`/`syncWorker.js` that a stale `last_polled_at` was the signal the self-view used to drop such a Device; nothing ever consumed that signal.

Tasks 26-29 are four presentation capabilities (Requirements 18-21), kept as four sections rather than one because they touch disjoint code and carry disjoint risk: (26) the configurable Display_Timezone, applied app-wide inside the shared date formatters — the widest-reaching change in this spec and the one to flag in review; (27) the device list auto-refreshing on the channel card's existing 60 s Visibility_Pause_Pattern; (28) presenting a currently-connected Device as connected, which needs a stored `connected` column and a poller write deliberately outside the Monotonic_Guard; (29) highlighting an imminent certificate expiry. Each section ends with a checkpoint.

Test-only sub-tasks are marked `*` and may be skipped for a faster MVP; core implementation sub-tasks are not. The design uses a specific implementation language (JavaScript/Node for the server, React/JavaScript for the client), so no language selection is required.

## Tasks

- [x] 1. Add the server-side enablement flag and its public-config exclusion
  - [x] 1.1 Create `server/config/deviceMgmt.js` exporting `isDeviceMgmtEnabled(env = process.env)` returning `env.DEVICE_MGMT_ENABLED === 'true'`
    - Mirror `server/config/cloudtak.js` exactly (same boolean-env convention, same server-only doc comment)
    - Add `DEVICE_MGMT_ENABLED=false` with an explanatory comment to `.env.example` (optional var, safe default; NOT added to `REQUIRED_VARS`)
    - _Requirements: 1.1, 1.2, 1.3_
  - [x] 1.2 Write property test for `isDeviceMgmtEnabled`
    - **Property 1: Enablement flag predicate**
    - **Validates: Requirements 1.1, 1.2**
    - Files: `server/config/__tests__/deviceMgmt.test.js`
  - [x] 1.3 Write unit test asserting `SiteConfig.getPublicConfig()` never includes a `DEVICE_MGMT_ENABLED`/device-mgmt key, set and unset
    - Mirror the existing CloudTAK exclusion test in `SiteConfig.test.js`
    - _Requirements: 1.4, 9.5_
    - Files: `server/models/__tests__/SiteConfig.test.js` (extend)

- [x] 2. Extend the secrets provider with a binary read
  - [x] 2.1 Add `getSecretBinary(secretName) -> Promise<Buffer>` to `EnvSecretsProvider` and `AwsSecretsManagerProvider` in `server/config/secretsProvider.js`
    - `EnvSecretsProvider`: dev/test path — read a local file path or decode a base64 env var; document the precise resolution rule in code
    - `AwsSecretsManagerProvider`: `GetSecretValueCommand` -> `Buffer.from(response.SecretBinary)`; throw a descriptive error if `SecretBinary` is absent
    - Leave the existing string `getSecret` behavior entirely unchanged
    - _Requirements: 2.3_
    - Files: `server/config/secretsProvider.js`
  - [x] 2.2 Write unit tests for `getSecretBinary`
    - Assert `AwsSecretsManagerProvider.getSecretBinary` returns a Buffer from `SecretBinary` and throws when absent
    - Assert `EnvSecretsProvider.getSecretBinary` returns the same bytes via file path and via base64 env var
    - Assert existing `getSecret` behavior is unchanged
    - _Requirements: 2.3_
    - Files: `server/config/__tests__/secretsProvider.test.js` (extend)

- [x] 3. Add the pinned `node-forge` dependency and the Admin_Credential_Loader
  - [x] 3.1 Add `node-forge` as a pinned exact-version dependency
    - Add `node-forge` to `dependencies` in `package.json` with an exact version (no `^`/`~`), satisfying `npm run lint:pinned-deps`
    - _Requirements: 2.5, 2.12_
    - Files: `package.json`, `package-lock.json`
  - [x] 3.2 Create `server/services/AdminCredentialLoader.js` with source selection and P12->PEM conversion
    - `constructor({ takServerService, env = process.env, secretsProvider = getSecretsProvider(env) })`
    - `selectSource(env)`: `secrets-manager` when `TAK_ADMIN_CERT_SOURCE === 'secrets-manager'`, else `file` (default preserves current behavior)
    - `load()`: `secrets-manager` -> `secretsProvider.getSecretBinary(TAK_ADMIN_CERT_SECRET_ARN)` -> Buffer -> convert P12->PEM via `node-forge` using P12_Passphrase (default `atakatak`, overridable via `TAK_ADMIN_CERT_PASSPHRASE`) -> cache `{ cert, key }` (+ `{ ca }` when a CA bundle is configured); `file` -> reuse `TakServerService.buildMutualTlsAgentOptions(env)` unchanged (never use file/env creds when source is `secrets-manager`)
    - `getAgentOptions()` returns the currently-cached agent options
    - NEVER log the credential material or the P12_Passphrase at any level
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.9, 2.11, 2.12_
    - Files: `server/services/AdminCredentialLoader.js`
  - [x] 3.3 Implement `refresh()` with retain-cache-on-failure
    - `refresh()` reloads from the configured source; on changed material, swap the cached credential and notify/refresh the shared `TakServerService` agent; on failure, retain the previously cached credential, log via the Structured_Logger (no secret material), and return without throwing
    - _Requirements: 2.7, 2.10_
    - Files: `server/services/AdminCredentialLoader.js`
  - [x] 3.4 Write unit tests for the Admin_Credential_Loader
    - Assert source selection: `secrets-manager` vs `file` vs unset-default-`file` (2.1)
    - Assert secrets-manager load uses `getSecretBinary` and converts a legacy-algorithm P12 fixture (RC2/3DES) to PEM `{ cert, key }` without the OpenSSL legacy provider (2.2, 2.5, 2.12)
    - Assert passphrase default `atakatak` vs `TAK_ADMIN_CERT_PASSPHRASE` override (2.4)
    - Assert file-source builds from `buildMutualTlsAgentOptions` and secrets-manager does NOT read file/env creds (2.9)
    - Assert `refresh()` failure retains the previously cached credential and never throws (2.10)
    - Assert no secret material or passphrase is ever logged (2.11)
    - Include a committed legacy-algorithm P12 test fixture
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.9, 2.10, 2.11, 2.12_
    - Files: `server/services/__tests__/AdminCredentialLoader.test.js`, `server/services/__tests__/fixtures/legacy-admin.p12`

- [x] 4. Make TakServerService agent-refreshable and add the two fetches
  - [x] 4.1 Add `setAgentOptions(options)` / `refreshAgent()` to `server/services/TakServerService.js`
    - Rebuild `this.client`'s `httpsAgent` in place from the supplied/Loader-current agent options, so a rotated credential is used on subsequent Marti calls without a restart
    - Leave `buildMutualTlsAgentOptions`, `listCertificates`, `findCertificatesForUser`, `matchesCreatorDn`, and `revokeCertificates` unchanged
    - _Requirements: 2.7, 2.8_
    - Files: `server/services/TakServerService.js`
  - [x] 4.2 Add `listActiveCertificates()` and `getConnectedSubscriptions()` to `server/services/TakServerService.js`
    - `listActiveCertificates()`: `GET /Marti/api/certadmin/cert/active`, unwrap the data array; treat 404/absent as empty
    - `getConnectedSubscriptions()`: `GET /Marti/clients`, return live connected clients keyed by `clientUid`; treat 404/absent as empty
    - _Requirements: 3.1, 4.3_
    - Files: `server/services/TakServerService.js`
  - [x] 4.3 Write unit tests for the refreshable agent and the two fetches
    - Assert `refreshAgent()`/`setAgentOptions()` rebuilds the client httpsAgent from new material (2.7)
    - Assert the exact Marti request shapes for `listActiveCertificates` and `getConnectedSubscriptions`, and empty-on-404 handling (3.1, 4.3)
    - _Requirements: 2.7, 3.1, 4.3_
    - Files: `server/services/__tests__/TakServerService.test.js` (extend)

- [x] 5. Create the Device_Table migration
  - [x] 5.1 Add a `node-pg-migrate` incremental migration creating `tak_devices`
    - Columns: `client_uid` PRIMARY KEY; `user_id integer NULL REFERENCES users(id) ON DELETE SET NULL`; `cert_id integer NOT NULL`; `issued_at timestamptz NULL`; `expires_at timestamptz NULL`; `last_seen_at timestamptz NULL`; `last_polled_at timestamptz NULL`; `revoked boolean NOT NULL DEFAULT false`; `created_at`/`updated_at timestamptz DEFAULT now()`
    - Indexes: PK on `client_uid`; index on `(user_id)`; index on `(cert_id)`
    - Follow the baseline migration conventions in `database/migrations/`
    - _Requirements: 4.1, 4.2_
    - Files: `database/migrations/<timestamp>_tak-devices.cjs`
  - [x] 5.2 Write a migration smoke/integration test asserting the table, columns, and indexes exist after applying
    - _Requirements: 4.1, 4.2_
    - Files: `database/migrations/__tests__/tak-devices.integration.test.js`

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement the three scheduled jobs
  - [x] 7.1 Create `server/services/AdminCredentialRefreshJob.js`
    - Mirror the `ExpiryScheduler`/`RetentionCleanupJob` shape: clamped interval from `TAK_ADMIN_CERT_REFRESH_INTERVAL_MS` (default 24h), `this.timer = null`; `start()` runs one pass immediately then `setInterval` (idempotent); `stop()` `clearInterval` (idempotent)
    - `run()` calls `loader.refresh()` (which swaps/refreshes the shared agent) inside try/catch; logs failures via the Structured_Logger; NEVER throws
    - _Requirements: 2.6, 2.7, 2.10_
    - Files: `server/services/AdminCredentialRefreshJob.js`
  - [x] 7.2 Create `server/services/SubscriptionPoller.js`
    - Clamped interval from `DEVICE_MGMT_POLL_INTERVAL_MS` (default ~5 min); same `start()`/`stop()` shape
    - `run()`: call `takServerService.getConnectedSubscriptions()`; for each connected `clientUid`, monotonic-forward update `UPDATE tak_devices SET last_seen_at = GREATEST(last_seen_at, $observedAt) WHERE client_uid = $uid` (or `WHERE last_seen_at IS NULL OR last_seen_at < $observedAt`); leave unobserved devices unchanged (no null, no rewind)
    - On failure: log, leave all `last_seen_at` unchanged, retry next tick, NEVER throw
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.8_
    - Files: `server/services/SubscriptionPoller.js`
  - [x] 7.3 Create `server/services/DeviceSync.js`
    - Clamped interval from `DEVICE_MGMT_SYNC_INTERVAL_MS` (default ~15 min); same `start()`/`stop()` shape
    - `run()`: fetch `takServerService.listActiveCertificates()`; resolve each cert's local user via `matchesCreatorDn(cert.creatorDn, user.username)` over the `users` table; upsert a `tak_devices` row keyed on `client_uid` carrying `cert_id`, `issued_at`, `expires_at`, `user_id`, `last_polled_at = <run time>`; NEVER overwrite `last_seen_at` or `revoked`
    - On failure: log, leave existing rows unchanged, retry next run, NEVER throw
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 4.9_
    - Files: `server/services/DeviceSync.js`
  - [x] 7.4 Write unit tests for the three jobs (fake timers, mocked collaborators)
    - Assert interval clamp + immediate-first-run + idempotent start/stop for each (2.6, 3.1, 4.8)
    - Assert `SubscriptionPoller` records monotonic-forward last_seen and leaves unobserved devices unchanged (3.2, 3.3, 3.4)
    - Assert `DeviceSync` upsert carries the right columns, resolves user via `matchesCreatorDn`, sets `last_polled_at`, and never overwrites `last_seen_at`/`revoked` (4.4, 4.5, 4.7)
    - Assert every `run()` never throws on collaborator failure and leaves data unchanged (2.10, 3.8, 4.9)
    - _Requirements: 2.6, 2.10, 3.1, 3.2, 3.3, 3.4, 3.8, 4.4, 4.5, 4.7, 4.9_
    - Files: `server/services/__tests__/AdminCredentialRefreshJob.test.js`, `server/services/__tests__/SubscriptionPoller.test.js`, `server/services/__tests__/DeviceSync.test.js`

- [x] 8. Wire the jobs and loader into the Sync_Worker
  - [x] 8.1 Construct the loader and three jobs in the `SyncWorker` constructor
    - `this.adminCredentialLoader = new AdminCredentialLoader({ takServerService: this.takServerService })` (the shared instance the revoke handler uses); `this.adminCredentialRefreshJob`, `this.subscriptionPoller`, `this.deviceSync` built with the shared `this.takServerService`/loader
    - _Requirements: 2.8_
    - Files: `server/workers/syncWorker.js`
  - [x] 8.2 Start/stop the three jobs guarded by `isDeviceMgmtEnabled()`
    - In `start()`, after the existing schedulers: `if (isDeviceMgmtEnabled()) { this.adminCredentialRefreshJob.start(); this.subscriptionPoller.start(); this.deviceSync.start(); }` (the refresh job's immediate-first-run loads the credential before the first poll/sync)
    - In `stop()`, unconditionally call each job's idempotent `stop()`
    - When off: no credential load/refresh, no poll, no sync
    - _Requirements: 1.5, 1.6, 1.7, 9.5_
    - Files: `server/workers/syncWorker.js`
  - [x] 8.3 Write unit tests for the Sync_Worker wiring
    - Assert the three jobs start only when `isDeviceMgmtEnabled()` is true and are stopped on `stop()` (1.5, 1.6, 1.7)
    - Assert the revoke handler and the jobs share one `TakServerService`/loader instance (2.8)
    - _Requirements: 1.5, 1.6, 1.7, 2.8, 9.5_
    - Files: `server/workers/__tests__/syncWorker.test.js` (extend)

- [x] 9. Extend the revoke handler to flip the Device_Table `revoked` flag
  - [x] 9.1 Update `revokeTakCertificates` in `server/workers/syncWorker.js`
    - After `revokeCertificates` reports `{ success: true }`, when `isDeviceMgmtEnabled()`, `UPDATE tak_devices SET revoked = true WHERE client_uid = ANY(<matched uids>)` for the confirmed-revoked certificates; keep the existing verify-before-success and no-match no-op semantics
    - _Requirements: 7.6, 8.7_
    - Files: `server/workers/syncWorker.js`
  - [x] 9.2 Write unit tests for the revoked-flag flip
    - Assert `revoked` is set true on matched devices only after a confirmed-success revoke (7.6, 8.7)
    - Assert nothing is flipped when `isDeviceMgmtEnabled()` is false (9.5)
    - _Requirements: 7.6, 8.7, 9.5_
    - Files: `server/workers/__tests__/syncWorker.test.js` (extend)

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement the DeviceManagementService (query + authorization)
  - [x] 11.1 Create `server/services/DeviceManagementService.js`
    - `listOwnDevices(userId)` returns the caller's `tak_devices` rows (`user_id = userId`)
    - `listManagedUserDevices(actingUser, targetUserId)` returns the target's devices only when the target is a Managed_User of the acting admin (Global_Manager `UNSCOPED` short-circuit via `DirectoryScopeService.resolveScope`, else direct-admin `role='admin' AND inherited_from_team_id IS NULL` scoping); throws a `NotManagedUserError` otherwise
    - `assertCanRevokeOwn(userId, clientUid)` resolves the device and throws unless `user_id === userId`
    - `assertCanRevokeManaged(actingUser, targetUserId, clientUid)` throws unless the target is managed AND the device's `user_id === targetUserId`
    - _Requirements: 5.5, 6.2, 6.6, 6.7, 7.5, 8.5, 8.6, 9.3, 9.4_
    - Files: `server/services/DeviceManagementService.js`
  - [x] 11.2 Write unit tests for the service (mocked `config/database`, `DirectoryScopeService`)
    - Assert self-view returns only own rows and self-revoke assert passes only for owned devices (5.5, 7.5, 9.3)
    - Assert managed-view/revoke succeed for a managed target and deny a non-managed target, with Global_Manager unscoped (6.6, 6.7, 8.5, 8.6, 9.4)
    - _Requirements: 5.5, 6.2, 6.6, 6.7, 7.5, 8.5, 8.6, 9.3, 9.4_
    - Files: `server/services/__tests__/DeviceManagementService.test.js`

- [x] 12. Add permission registry entries and row-scoped resolvers
  - [x] 12.1 Register the four endpoints and defaults in `server/config/permissions.registry.js`
    - Registry entries mapping `GET/POST /api/device-management/...` to `device_mgmt:read:own` / `device_mgmt:read:managed` / `device_mgmt:revoke:own` / `device_mgmt:revoke:managed`
    - Place `device_mgmt:read:own` and `device_mgmt:revoke:own` in `roleDefaults.authenticated_user`; keep `device_mgmt:read:managed` and `device_mgmt:revoke:managed` OUT of `roleDefaults` (resolver-gated, mirroring `user:team:transfer`)
    - Add `rowScopedResolvers` for the two `:managed` identifiers, each short-circuiting `true` for a Global_Manager, then checking managed-user (+ device ownership for revoke) against the DB via `DeviceManagementService`
    - _Requirements: 6.2, 6.6, 6.7, 8.5, 8.6, 9.3, 9.4_
    - Files: `server/config/permissions.registry.js`
  - [x] 12.2 Write unit tests for the registry entries and resolvers
    - Assert the `:own` identifiers are in `authenticated_user` defaults and the `:managed` ones are not (resolver always consulted)
    - Assert the managed resolvers permit Global_Manager + managed target and deny non-managed / non-owned (6.6, 6.7, 8.5, 8.6)
    - _Requirements: 6.2, 6.6, 6.7, 8.5, 8.6, 9.3, 9.4_
    - Files: `server/config/__tests__/permissions.registry.test.js` (extend)

- [x] 13. Implement the device-management routes
  - [x] 13.1 Create `server/routes/deviceManagement.js` mounted at `/api/device-management`
    - Four routes, each `authenticateToken` -> `authorize` -> handler that re-checks `isDeviceMgmtEnabled()` and returns 404 when off:
      - `GET /me/devices` -> `listOwnDevices(req.user.userId)` -> `200 { devices: [...] }` (`lastSeenAt` null = "never seen")
      - `GET /users/:userId/devices` -> `listManagedUserDevices(req.user, :userId)` -> `200` same shape; `403` when not managed
      - `POST /me/devices/:clientUid/revoke` -> assert ownership -> validate `confirmation === 'REVOKE'` (else 400, no enqueue) -> resolve owner `username` -> `EventPublisher.publishOperation('revoke_tak_certificates', { tak_usernames: [username] }, req.user.userId)` -> `202 { enqueued: true }`
      - `POST /users/:userId/devices/:clientUid/revoke` -> assert managed + ownership upfront (before enqueue) -> validate `confirmation === 'REVOKE'` -> enqueue for the target's `username` -> `202`
    - Mount the router in the app only when `isDeviceMgmtEnabled()` (defense-in-depth alongside the in-handler check)
    - _Requirements: 1.8, 1.9, 5.1, 5.2, 5.3, 5.5, 6.3, 6.4, 6.5, 7.1, 7.3, 7.4, 7.5, 8.1, 8.3, 8.4, 8.5, 8.6_
    - Files: `server/routes/deviceManagement.js`, `server/index.js` (mount)
  - [x] 13.2 Write route/authorization tests (supertest, mocked service + `EventPublisher`)
    - Assert each route returns 404 when the flag is off (1.8, 1.9)
    - Assert self-view/self-revoke restricted to own devices; managed-view/revoke restricted to managed users and denied (403) for non-managed (5.5, 6.6, 6.7, 7.5, 8.5, 8.6)
    - Assert enqueue happens only after `confirmation === 'REVOKE'` (400 + no enqueue otherwise) with the exact `{ tak_usernames: [username] }` payload (7.3, 7.4, 8.3, 8.4)
    - _Requirements: 1.8, 1.9, 5.5, 6.6, 6.7, 7.3, 7.4, 7.5, 8.3, 8.4, 8.5, 8.6_
    - Files: `server/routes/__tests__/deviceManagement.test.js`

- [x] 14. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Implement the client surfaces
  - [x] 15.1 Add `deviceManagementAPI` to `client/src/services/api.js`
    - `getMyDevices()`, `getUserDevices(userId)`, `revokeMyDevice(clientUid, confirmation)`, `revokeUserDevice(userId, clientUid, confirmation)`, plus a reachability probe used to decide whether to render the surfaces
    - _Requirements: 5.1, 6.3, 6.4, 7.4, 8.4_
    - Files: `client/src/services/api.js`
  - [x] 15.2 Add the reusable REVOKE type-in confirmation dialog
    - Modeled on `TransferMemberDialog.jsx`: shows a warning, disables the confirm button until the input strictly equals `REVOKE`, then POSTs with `{ confirmation: 'REVOKE' }` (client check is convenience only; server re-validates)
    - _Requirements: 7.2, 7.3, 8.2, 8.3_
    - Files: `client/src/components/RevokeDeviceDialog.jsx`
  - [x] 15.3 Add the Dashboard "My Devices" card
    - Rendered only when the reachability probe succeeds; lists each device's UID, issued, expires, and Last_Seen ("never seen" when null); "Revoke" opens the confirmation dialog; matches existing card/table/dark-mode styling
    - _Requirements: 5.1, 5.2, 5.3_
    - Files: `client/src/pages/Dashboard.jsx`
  - [x] 15.4 Add the reusable `UserDevicesModal` and attach it in both views
    - `UserDevicesModal.jsx` takes a `userId`, calls `deviceManagementAPI.getUserDevices(userId)`, renders the same device list plus an admin "Revoke" action; attach it in `Users.jsx` and in the Orgs & Teams view (`Teams.jsx`/`TeamDetail.jsx`) so ONE component is reused
    - _Requirements: 6.3, 6.4, 6.5_
    - Files: `client/src/components/UserDevicesModal.jsx`, `client/src/pages/Users.jsx`, `client/src/pages/Teams.jsx`, `client/src/pages/TeamDetail.jsx`
  - [x] 15.5 Write vitest tests for the client surfaces
    - Assert "never seen" rendering for null `lastSeenAt` while other fields still show (5.3, 6.5)
    - Assert the confirm button is disabled until input === `REVOKE` and the modal is reused in both views (6.3, 6.4, 7.2, 8.2)
    - _Requirements: 5.2, 5.3, 6.3, 6.4, 6.5, 7.2, 8.2_
    - Files: `client/src/components/__tests__/RevokeDeviceDialog.test.jsx`, `client/src/components/__tests__/UserDevicesModal.test.jsx`, `client/src/pages/__tests__/Dashboard.test.jsx`

- [x] 16. Property-based tests for the Correctness Properties
  - [x] 16.1 Property test: enablement flag predicate
    - **Property 1: For all values of `DEVICE_MGMT_ENABLED`, `isDeviceMgmtEnabled` returns true iff the value is exactly `'true'`**
    - Tag: `// Feature: device-management, Property 1: Enablement flag predicate`
    - fast-check, `numRuns >= 100`, run directly against `isDeviceMgmtEnabled`
    - **Validates: Requirements 1.1, 1.2**
    - Files: `server/config/__tests__/deviceMgmt.property.test.js`
  - [x] 16.2 Property test: disabled inertness
    - **Property 2: WHILE Device_Mgmt_Enabled is false, a refresh tick, poll tick, sync tick, and revocation request cause no credential load/refresh, no Subscriptions_API call, no active-cert fetch, no Device_Table write, and no Revoke_Operation enqueue**
    - Tag: `// Feature: device-management, Property 2: Disabled inertness`
    - fast-check over flag values / trigger kinds, `numRuns >= 100`, asserting against mocked loader/TakServerService/DB/`EventPublisher`
    - **Validates: Requirements 1.5, 1.6, 1.7, 1.9, 9.5**
    - Files: `server/services/__tests__/deviceMgmt.inertness.property.test.js`
  - [x] 16.3 Property test: Last_Seen is monotonic-forward
    - **Property 3: For all sequences of poll observations, stored Last_Seen equals the running max; no observation moves it backward or nulls an already-set value; no observation retains null**
    - Tag: `// Feature: device-management, Property 3: Last_Seen is monotonic-forward`
    - fast-check generating `(clientUid, observedAt)` sequences, `numRuns >= 100` (the required fast-check test, Requirement 9.8)
    - **Validates: Requirements 3.2, 3.3, 3.4, 9.8**
    - Files: `server/services/__tests__/SubscriptionPoller.property.test.js`
  - [x] 16.4 Property test: active-certificate sync is idempotent and preserves Last_Seen
    - **Property 4: For all Active_Certificate sets, upserting twice yields the same rows as once (same `client_uid`, `cert_id`, `issued_at`, `expires_at`, `user_id`) and leaves each row's `last_seen_at` and `revoked` unchanged**
    - Tag: `// Feature: device-management, Property 4: Device sync is idempotent and preserves Last_Seen`
    - fast-check over cert sets against a mocked DB, `numRuns >= 100`
    - **Validates: Requirements 4.4, 4.7**
    - Files: `server/services/__tests__/DeviceSync.property.test.js`
  - [x] 16.5 Property test: self scope is enforced server-side
    - **Property 5: For all users and Device_Table contents, self-view returns exactly the devices whose `user_id` is that user, and self-revocation reaches enqueue only for a device whose `user_id` is that user**
    - Tag: `// Feature: device-management, Property 5: Self scope is enforced server-side`
    - fast-check over user/device relationships, `numRuns >= 100`
    - **Validates: Requirements 5.5, 7.5, 9.3**
    - Files: `server/services/__tests__/DeviceManagementService.selfScope.property.test.js`
  - [x] 16.6 Property test: admin scope is strictly limited to managed users
    - **Property 6: For all admin/target pairs and Device_Table contents, an admin's view/revocation is permitted only when the target is a Managed_User (and for revoke the device belongs to that target); any request against a non-Managed_User is denied**
    - Tag: `// Feature: device-management, Property 6: Admin scope is strictly limited to managed users`
    - fast-check over admin/target/managed relationships, `numRuns >= 100`
    - **Validates: Requirements 6.6, 6.7, 8.5, 8.6, 9.4**
    - Files: `server/services/__tests__/DeviceManagementService.adminScope.property.test.js`
  - [x] 16.7 Property test: revoke enqueue only after REVOKE confirmation
    - **Property 7: For all confirmation strings (self or admin), the Revoke_Operation is enqueued iff the string is exactly `REVOKE`**
    - Tag: `// Feature: device-management, Property 7: Revoke enqueue only after REVOKE confirmation`
    - fast-check over confirmation strings against mocked `EventPublisher`, `numRuns >= 100`
    - **Validates: Requirements 7.3, 8.3**
    - Files: `server/routes/__tests__/deviceManagement.confirmation.property.test.js`

- [x] 17. Final checkpoint - verify the full build
  - Capture the current `npm run lint` problem count on a clean tree FIRST as the baseline (do NOT hardcode a possibly-stale number)
  - Run `npm test` and confirm all server (jest) tests pass; run the client vitest suite and confirm it passes
  - Run `npm run lint` and confirm the problem count does NOT increase above the captured baseline
  - Run `npm run lint:pinned-deps` and confirm `node-forge` is pinned
  - _Requirements: 9.1, 9.6, 9.7_

- [x] 18. Verify TAK Server's TLS server identity against its Expected_Server_Name
  - [x] 18.1 Add the optional `servername` to `buildMutualTlsAgentOptions` and document `TAK_SERVER_TLS_SERVERNAME`
    - In `server/services/TakServerService.js`, set `options.servername = env.TAK_SERVER_TLS_SERVERNAME` when that variable holds a non-empty value, so TAK Server's certificate identity is verified against the Expected_Server_Name it actually carries instead of the dialed URL host
    - When the variable is unset or empty, return exactly the options the builder returns today: the `{ pfx, passphrase }` / `{ cert, key }` precedence and the optional `{ ca }` from `TAK_CA_PATH` are untouched, and no `servername` key is added
    - NEVER set `rejectUnauthorized` (in particular never `false`) and NEVER supply a `checkServerIdentity` override — chain verification against the Server_Trust_Bundle stays in force
    - The option is read at agent-construction time, so it applies to every request the agent carries, including the pre-existing `revoke_tak_certificates` path that shares this builder; inert while the variable is unset, so that path is unaffected by default
    - Add `TAK_SERVER_TLS_SERVERNAME` to `.env.example` with an explanatory comment (optional variable; unset = current behavior; typical value `takserver`, because a stock TAK Server certificate carries `CN=takserver` / a single `DNS:takserver` SAN rather than the DNS name operators dial)
    - _Requirements: 10.2, 10.3, 10.4, 10.5, 10.6_
    - Files: `server/services/TakServerService.js`, `.env.example`
  - [x] 18.2 Write unit tests for the optional `servername`
    - Assert `servername` is present and equals the configured value when `TAK_SERVER_TLS_SERVERNAME` is set (10.4)
    - Assert no `servername` key is present when the variable is unset or empty (10.5)
    - Assert the existing `{ cert, key }`, `{ pfx, passphrase }`, and `{ ca }` shapes are unchanged both with and without the variable set (10.5)
    - Assert `rejectUnauthorized` is never present in the agent options — and in particular never `false` — across all of those combinations (10.3)
    - _Requirements: 10.3, 10.4, 10.5_
    - Files: `server/services/TakServerService.test.js` (extend)
  - [x] 18.3 Checkpoint - run the full suite and lint
    - Run `npm test` and confirm all server (jest) tests pass; run the client vitest suite and confirm it passes
    - Run `npm run lint` and confirm the problem count does NOT increase above the baseline captured in task 17
    - _Requirements: 9.1, 9.6, 9.7_

## Notes

- Tasks marked with `*` are optional (test-only: unit, property, integration, and smoke tests) and can be skipped for a faster MVP; core implementation sub-tasks are not marked and must be implemented.
- Each task references specific granular requirements for traceability.
- Checkpoints ensure incremental validation.
- Every enqueue, poll, sync, credential-load, and route site is guarded by `isDeviceMgmtEnabled()`; WHILE the flag is off the feature is completely inert (no credential load/refresh, no poll, no sync, no enqueue) and every route returns 404 (Property 2 / Requirement 9.5).
- Property tests implement one test per Correctness Property (1-14) from the design, each tagged `// Feature: device-management, Property {n}: {text}` and using `fast-check` with `numRuns >= 100`; unit tests cover concrete Marti request shapes, exact enqueue payloads, edge cases, and the never-throwing error paths.
- The final verification captures the current `npm run lint` baseline on a clean tree and requires the feature not to increase it, rather than relying on a hardcoded count.
- Task 18's `TAK_SERVER_TLS_SERVERNAME` reaches outside device-management: `buildMutualTlsAgentOptions` is shared, so the pre-existing `revoke_tak_certificates` path picks it up too. It is backwards compatible because the option is inert while the variable is unset, and `rejectUnauthorized: false` is never used anywhere (Requirements 10.3, 10.5, 10.6).
- Tasks 19-23 supersede parts of the completed tasks above, and those tasks are deliberately left as-is rather than renumbered, because their numbers are cited by code comments and test headers. Specifically: task 4.2's `getConnectedSubscriptions()` (`/Marti/clients`) is removed by 21.1; tasks 7.2 and 21.2 both describe `SubscriptionPoller.run()`, and 21.2 wins; tasks 7.3 and 20.2 both describe `DeviceSync.run()`, and 20.2 wins; task 13.1's `{ tak_usernames: [username] }` enqueue is replaced by 19.4's device-scoped payload; and task 15.3/15.4's text `Revoke` button is replaced by 22.4's icon-only action. Where two tasks disagree, the higher-numbered one is the current specification.
- Two of the task-19 changes reach outside device-management and should be flagged in review: 19.1 corrects `TakServerService.revokeCertificates`' verification, which is shared with the pre-existing main-spec Requirement 26 revoke path (a strict tightening — a previously false success now becomes the existing retryable unverified failure); and 19.2 changes the shared `revoke_tak_certificates` operation schema additively, so the three pre-existing user-scoped call sites keep working unchanged.
- Requirement 9.8's fast-check property test remains required after task 21: the Last_Seen source changed, but the Monotonic_Guard stays and Property 3 now asserts it over reported `lastEventTime` sequences.
- **Task 24 must be implemented before task 19.3, despite its higher number.** 19.3 is the handler branch that makes a device-scoped revoke resolve a target set and issue the `DELETE`; until 24.1-24.3 are in place there is no separate arming flag, no blast-radius cap and no audit record, so 19.3 would put a live destructive path into a shared TAK Server with none of the rails. The dependency graph reflects this: 24.1 lands in the wave with 19.1/19.2, 24.2 and 24.3 in the wave after it, and 19.3/19.4 only after that. The numbering is left as-is rather than renumbered, consistent with the convention above, because task numbers are cited by code comments and test headers.
- Task 24's `DEVICE_MGMT_REVOKE_ENABLED` is a SEPARATE variable from `DEVICE_MGMT_ENABLED`, with its own `false` default; it is never derived from or defaulted to the read flag. Read paths (self-view, admin view, poller, sync, route reachability) keep consulting `isDeviceMgmtEnabled()` alone, and only the two revoke routes plus the handler's pre-`DELETE` gate consult `isDeviceMgmtRevokeEnabled()` (Requirement 12.9).
- **Task 25 supersedes the `last_polled_at`-staleness claim**, following the same convention as the tasks-19-23 supersessions above. Tasks 7.3 and 20.2 (and design.md's "The Device_Sync" step 5, and `DeviceSync.js`'s header comment) stated that a fully-revoked `clientUid`'s row "stops being refreshed — its `last_polled_at` goes stale, which is the signal the self-view uses to stop presenting it as current". **No such signal was ever implemented**, and `listOwnDevices` filters on `user_id` alone. Task 25 replaces that claim with deletion during the sync and corrects the wrong statement in place in both files (25.2). Where task 25 and any earlier task or comment disagree, task 25 is the current specification. `last_polled_at` remains sync bookkeeping only and is NOT a visibility input (Requirement 17.8).
- Task 25's read path is deliberately unchanged: `DeviceManagementService.listOwnDevices` gets NO `last_polled_at` freshness filter and NO `revoked` filter. Once the rows are deleted both the self-view and the admin view stop returning them, and a second read-side mechanism could only disagree with the first (Requirement 17.8). Do not add one.
- Task 25's `revoked = true` rows are deleted by the next completed sync, which is intended — the Device is gone. The consequence to keep in mind when reading the UI: the "Revoked" badge is transient (up to one sync interval), not a permanent record; the durable record is the `sync_operations` row plus the Revoke_Audit_Record (Requirements 17.7, 12.14). A user-visible revocation audit trail, and clearing `revoked` on a `clientUid` re-enrolled inside one sync interval, are both recorded as FOLLOW-UPS in design.md and are out of task 25's scope.
- Task 24's cap and audit record apply to BOTH `revoke_tak_certificates` payload shapes, including the three pre-existing user-scoped call sites, since the user-scoped shape has the larger blast radius. Only the single-`client_uid` abort (24.3) is device-scoped-only, because the user-scoped shape legitimately spans a user's Devices (Requirements 12.12, 12.15).
- **Task 26's Display_Timezone reaches outside device-management — the widest reach in this spec.** It lands inside the shared `client/src/utils/dateFormat.js`, so EVERY user-visible date in the application renders in the configured zone: the device lists, `pages/Users.jsx`, `pages/AuditLogs.jsx`, `pages/Admin.jsx`, `pages/Requests.jsx`, and `components/OrgInterestRequests.jsx`. Dates on pages unrelated to this feature WILL shift (measured: TAK reported `2026-03-12T00:58:04.508Z` and the UI showed `2026-03-11 17:58`, the browser's UTC−7 — a different calendar day). This is the chosen scope, not a side effect, and it belongs on the review list alongside task 19.1's shared `revokeCertificates` fix and task 18.1's shared `servername` (Requirement 18.4).
- Task 26 puts two Presentation_Config keys into `SiteConfig.getPublicConfig()` (`display_timezone`, and `device_expiry_warning_days` in task 29). That does NOT weaken Requirement 12.9 or 1.4: `DEVICE_MGMT_ENABLED` and `DEVICE_MGMT_REVOKE_ENABLED` stay out of the public config, and feature discovery keeps using the self-view probe. The two categories are asserted in the SAME test — new keys present, both flags absent — so a later refactor cannot quietly move a flag into the presentation bucket (Requirements 18.5, 18.6, 21.7).
- **Task 28 supersedes the claim that `lastStatus` is unread.** `SubscriptionPoller.js`'s header says "`lastStatus` is deliberately NOT filtered on" (correct, and it stays correct — Requirement 3.2 is unchanged) but its `extractLastEventTimes` doc block says "`lastStatus` is not consulted at all", which task 28 makes false: the field becomes the Connection_Status source. Both comment sites also cite Requirement 13.2, which is about `GET /Marti/api/subscriptions/all`, not about `lastStatus`; the correct citations are 3.2 and 13.7. Task 28.5 corrects both in place. Requirements 3.2, 13.7 and Property 3 are all unchanged in force — nothing about the Last_Seen write narrows.
- **Task 28 also supersedes `DeviceListRow.jsx`'s NEVER_SEEN_LABEL rationale**, which still carries the pre-21.2 claim that "the Subscription_Poller only records a Last_Seen when it happens to observe a device connected, so null means 'no poll has ever seen this device'". Since task 21.2 the source is TAK Server's own reported `lastEventTime`, so null means TAK Server retains no entry for the Device. Same convention as task 25.2: the wrong claim is corrected in place, not annotated beside.
- Task 28's `connected` write is deliberately NOT behind the Monotonic_Guard, and that is the one thing in that section that must not be got wrong: the poller's current `WHERE last_seen_at IS NULL OR last_seen_at < $2` is a no-match for a non-advancing timestamp, so a status riding on it would never update for the devices most likely to be connected right now. The clamp moves into the `SET` list; `last_seen_at` keeps its exact semantics and Property 3 is unchanged (Requirement 20.3, Property 17).
- Task 28 does NOT add a `connected` filter, and task 29 does NOT add an expiry filter, to `DeviceManagementService.listOwnDevices`. Requirement 17.8 stands: visibility has exactly one mechanism, the presence of the row. `last_polled_at` remains sync bookkeeping.
- Requirement 9.x's test obligations carry into tasks 26-29 unchanged: jest for the server, vitest for the client, and a `fast-check` property test with `numRuns >= 100` for each of the three new Correctness Properties (15, 16, 17). Properties 15 and 16 run in the client (vitest) suite because their subjects are client modules; Property 17 runs in the server (jest) suite.
- Requirement 19 gets NO property test on purpose. A `setInterval`, a `visibilitychange` transition, and "the open dialog kept its typed text" are single interleavings with single correct outcomes; 100 iterations would test the browser's timers rather than this code. Recorded so the absence reads as a decision (see design.md's note under Property 17).
- Properties 4 and 12 gain one assertion each rather than new properties: Property 4's upsert-preservation list gains `connected` (Requirement 20.10) and Property 12's no-Device_Table-write assertion covers the status write too (Requirement 20.7). No new property-test files for either.
- New environment variables introduced by tasks 26 and 29 — `DISPLAY_TIMEZONE` (default `Pacific/Auckland`, app-wide) and `DEVICE_MGMT_EXPIRY_WARNING_DAYS` (default 30) — must be documented in `.env.example` with their defaults and left out of `REQUIRED_VARS`. Do NOT edit `.env` (Requirements 18.13, 21.10).

- [x] 19. Correct revocation: device-scoped payload and `/revoked` verification
  - [x] 19.1 Replace `revokeCertificates`' verification with Revoked_Certificate_View membership
    - Add `listRevokedCertificates()` to `server/services/TakServerService.js`: `GET /Marti/api/certadmin/cert/revoked` (OpenAPI `getRevoked` -> `ApiResponseListTakCert` in `tak-server-openapispec.json`), unwrapping the `data` array the same way `listCertificates()` does
    - In `revokeCertificates(certIds)`, replace the post-`DELETE` re-query of `listCertificates()` + `cert.revocationDate === null` check with a re-query of `listRevokedCertificates()` and a MEMBERSHIP check: an id is confirmed only when it is present in that view
    - Do NOT read `revocationDate` for revocation decisions anywhere: verified live, all 95 certificates in `/active` carry a non-null `revocationDate`, including the 5 that `/revoked` does not list (e.g. id 3212, `revocationDate: 2026-01-17T01:15:22.160Z`), so the old check reports success unconditionally
    - Keep the existing return contract (`{success:true}` / `{success:false, unverified:[...]}`) and the retryable-failure semantics that depend on it
    - Add a code comment recording that this method is SHARED, so the fix also corrects the pre-existing main-spec Requirement 26 revoke path
    - _Requirements: 12.4, 12.5, 12.6, 12.7, 7.6, 8.7_
    - Files: `server/services/TakServerService.js`
  - [x] 19.2 Add the device-scoped payload shape to the `revoke_tak_certificates` operation schema
    - In `server/workers/operationSchemas.js`, extend the `revoke_tak_certificates` entry (currently `requiredFields: { tak_usernames: 'object' }`, `optionalFields: { target_user_id: 'number' }`) to accept EITHER `{ client_uid: 'string' }` OR `{ tak_usernames: 'object' }`, with exactly one of the two present, `target_user_id` optional in both
    - Keep the user-scoped shape valid and unchanged so the three pre-existing call sites (`TakCertificateRevocationService.revokeUserTakCertificates`, `TeamMembershipService.removeUserFromTeam`'s no-teams-left branch, `Team.delete`'s bulk enqueue) keep working; document in the entry's comment that the device-scoped shape is ADDITIVE
    - _Requirements: 12.2, 12.3_
    - Files: `server/workers/operationSchemas.js`
  - [x] 19.3 Branch `revokeTakCertificates` on the payload shape
    - In `server/workers/syncWorker.js`, when the payload carries `client_uid`, select target certificate ids as the Live_Certificates (in `/active`, NOT in `/revoked`) whose `clientUid === payload.client_uid`, instead of matching `creatorDn` via `matchesCreatorDn`
    - When the payload carries `tak_usernames`, keep the existing `matchesCreatorDn` behavior byte-for-byte
    - Keep the single-fetch-per-operation principle, the no-match-is-a-successful-no-op path, and the `classifyTakServerError` retry/permanent classification unchanged
    - Pass ONLY the target `client_uid` to `markDevicesRevoked`, so no other Device of the same user has its flag flipped
    - _Requirements: 12.1, 12.8, 7.4, 7.6, 8.4, 8.7_
    - Files: `server/workers/syncWorker.js`
  - [x] 19.4 Enqueue the device-scoped payload from both revoke routes
    - In `server/routes/deviceManagement.js`, change both enqueues from `{ tak_usernames: [username] }` to `{ client_uid: <the :clientUid Device>, target_user_id: <owning user id> }`; the authorization and `confirmation === 'REVOKE'` gates stay exactly where they are, still before any enqueue
    - _Requirements: 7.4, 8.4, 12.1_
    - Files: `server/routes/deviceManagement.js`
  - [x] 19.5 Write property test: revocation targets exactly one Device's live certificates
    - **Property 9: For all certificate catalogues with `clientUid` reuse and shared `creatorDn`s, a device-scoped Revoke_Operation targets exactly the Live_Certificates carrying that `clientUid` and no certificate carrying another `clientUid`; at most that one Device_Table row has `revoked` flipped**
    - Tag: `// Feature: device-management, Property 9: Revocation targets exactly one Device's live certificates`
    - fast-check, `numRuns >= 100`; the generator MUST produce two Devices sharing one `creatorDn`, since that is the only shape in which the old over-revocation is visible
    - **Validates: Requirements 7.4, 8.4, 12.1, 12.8**
    - Files: `server/workers/__tests__/revokeTakCertificates.deviceScope.property.test.js`
  - [x] 19.6 Write property test: revocation is confirmed only by revoked-view membership
    - **Property 10: `revokeCertificates` reports success iff every targeted id is present in the Revoked_Certificate_View, independently of `revocationDate`**
    - Tag: `// Feature: device-management, Property 10: Revocation is confirmed only by revoked-view membership`
    - fast-check, `numRuns >= 100`; generate `revocationDate` independently of `/revoked` membership, INCLUDING the all-non-null case observed live, so a `revocationDate`-based implementation cannot pass
    - **Validates: Requirements 7.6, 8.7, 12.4, 12.5, 12.6, 12.7**
    - Files: `server/services/__tests__/TakServerService.revokeVerification.property.test.js`
  - [x] 19.7 Write unit tests for the schema, handler branch, and route payloads
    - Assert the device-scoped payload validates and the user-scoped payload still validates, and that a payload with both or neither discriminator is rejected (12.2, 12.3)
    - Assert the handler revokes only the target `clientUid`'s live certificates when two Devices share a `creatorDn`, and that the user-scoped path is unchanged (12.1)
    - Assert `markDevicesRevoked` is called with exactly one `client_uid` (12.8)
    - Assert both routes enqueue `{ client_uid, target_user_id }` and never `{ tak_usernames }` (7.4, 8.4)
    - _Requirements: 7.4, 8.4, 12.1, 12.2, 12.3, 12.8_
    - Files: `server/workers/operationSchemas.test.js` (extend), `server/workers/syncWorker.test.js` (extend), `server/routes/__tests__/deviceManagement.test.js` (extend)
  - [x] 19.8 Checkpoint - Ensure all tests pass
    - Ensure all tests pass, ask the user if questions arise.

- [x] 20. Derive Devices from Live_Certificates, one row per `client_uid`
  - [x] 20.1 Add `listLiveCertificates()` to `TakServerService`
    - Fetch `GET /Marti/api/certadmin/cert/active` (OpenAPI `getActive`) AND `GET /Marti/api/certadmin/cert/revoked` (OpenAPI `getRevoked`) and return the set difference by certificate id: in `/active`, NOT in `/revoked`
    - Do NOT treat `/active` as the live set: verified live, 90 of its 95 certificates also appear in `/revoked`
    - Do NOT fetch `GET /Marti/api/certadmin/cert/replaced` for superseding: it returned the same 95 ids as `/active`
    - _Requirements: 4.3, 4.6, 11.2, 11.4_
    - Files: `server/services/TakServerService.js`
  - [x] 20.2 Rewrite `DeviceSync.run()` to group by `client_uid` and pick the Newest_Live_Certificate
    - Group Live_Certificates by `clientUid`; per group pick the greatest `issuanceDate` (the Newest_Live_Certificate) and upsert ONE `tak_devices` row carrying that certificate's `cert_id`, `issued_at`, `expires_at`, the `user_id` resolved from ITS `creatorDn` via `matchesCreatorDn`, and `last_polled_at = <run time>`
    - Never overwrite `last_seen_at` or `revoked`; keep the upsert idempotent
    - A `clientUid` whose every certificate is revoked yields no group and is NOT upserted, so it never appears with `revoked = false` (the earlier implementation listed 10 devices where only 1 is live)
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 5.4, 11.1, 11.3, 11.5, 11.6_
    - Files: `server/services/DeviceSync.js`
  - [x] 20.3 Write property test: Devices are live client UIDs carrying their newest live certificate
    - **Property 8: For all (active, revoked) pairs, the derived Device set has exactly one entry per `clientUid` with at least one live certificate; each entry's `certId`/`issuedAt`/`expiresAt` come from the greatest-`issuanceDate` Live_Certificate; a fully-revoked `clientUid` does not appear**
    - Tag: `// Feature: device-management, Property 8: Devices are live client UIDs carrying their newest live certificate`
    - fast-check, `numRuns >= 100`; the generator MUST reproduce the live shape: a small `clientUid` alphabet against a much larger certificate count, `/revoked` as a random SUBSET of `/active`, and shuffled `issuanceDate`s so "newest" is never accidentally "last in the array"
    - **Validates: Requirements 4.3, 4.4, 4.6, 5.4, 11.1, 11.2, 11.3, 11.5, 11.6**
    - Files: `server/services/__tests__/DeviceSync.deviceIdentity.property.test.js`
  - [x] 20.4 Update the existing Device_Sync unit and property tests for the new derivation
    - Update `DeviceSync.test.js` and the Property 4 test to feed Live_Certificates and assert one row per `client_uid` from the Newest_Live_Certificate, keeping the idempotence and `last_seen_at`/`revoked` preservation assertions (4.4, 4.7)
    - Assert `/Marti/api/certadmin/cert/replaced` is never requested (11.4)
    - _Requirements: 4.4, 4.6, 4.7, 11.3, 11.4_
    - Files: `server/services/__tests__/DeviceSync.test.js`, `server/services/__tests__/DeviceSync.property.test.js`
  - [x] 20.5 Checkpoint - Ensure all tests pass
    - Ensure all tests pass, ask the user if questions arise.

- [x] 21. Source Last_Seen from the Client_Endpoints_API
  - [x] 21.1 Add `getClientEndpoints()` and remove `getConnectedSubscriptions()`
    - Add `getClientEndpoints(params?)` to `server/services/TakServerService.js`: `GET /Marti/api/clientEndPoints` (OpenAPI `getClientEndpoints` -> `ApiResponseListClientEndpoint`, schema `ClientEndpoint { callsign, uid, username, team, role, lastEventTime, lastStatus }`), unwrapping `data`
    - DELETE `getConnectedSubscriptions()` rather than repointing it: it targeted `/Marti/clients`, which returns 404 and is absent from `tak-server-openapispec.json` entirely, so no caller may keep the old semantics by accident
    - Do NOT set `showCurrentlyConnectedClients`: 46 of 48 live entries were `lastStatus: "Disconnected"` and those carry the last-seen timestamps this feature shows
    - Do NOT use `GET /Marti/api/subscriptions/all` as the source: its `SubscriptionInfo.clientUid` was empty in 14 of 16 live entries
    - _Requirements: 3.1, 13.1, 13.2, 13.7, 14.4_
    - Files: `server/services/TakServerService.js`
  - [x] 21.2 Rewrite `SubscriptionPoller.run()` to store the reported `lastEventTime`
    - Match `ClientEndpoint.uid` to `tak_devices.client_uid` and write the entry's own `lastEventTime` — NOT the observation time — under the Monotonic_Guard (`SET last_seen_at = GREATEST(last_seen_at, $lastEventTime)`, or `WHERE last_seen_at IS NULL OR last_seen_at < $lastEventTime`)
    - Do not require `lastStatus === 'Connected'`; skip an entry whose `lastEventTime` is absent or unparseable, leaving the stored value untouched
    - Leave Devices with no entry unchanged (no null, no rewind)
    - Keep the class name `SubscriptionPoller` so existing tests, tasks and comments citing it stay valid
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.7, 13.1, 13.3, 13.4, 13.6_
    - Files: `server/services/SubscriptionPoller.js`
  - [x] 21.3 Update the poller's unit and property tests for the new source
    - Update `SubscriptionPoller.test.js` for the new request URL and for storing `lastEventTime` rather than the observation time, including a `lastStatus: "Disconnected"` entry being stored and an absent/unparseable `lastEventTime` being skipped (3.2, 13.1, 13.6)
    - Update the Property 3 test so its generated sequences are reported `lastEventTime` values, keeping the running-max/never-null assertions — Requirement 9.8's fast-check property remains REQUIRED and now applies to the Monotonic_Guard (3.3, 9.8, 13.4, 13.5)
    - Assert no code path requests `/Marti/clients` (14.4)
    - _Requirements: 3.2, 3.3, 3.4, 9.8, 13.1, 13.4, 13.5, 13.6, 14.4_
    - Files: `server/services/__tests__/SubscriptionPoller.test.js`, `server/services/__tests__/SubscriptionPoller.property.test.js`
  - [x] 21.4 Checkpoint - Ensure all tests pass
    - Ensure all tests pass, ask the user if questions arise.

- [x] 22. Client_Type classification and the icon/tooltip UI convention
  - [x] 22.1 Create `server/utils/clientType.js` with the pure classifier
    - Export `classifyClientType(clientUid)` returning `'cloudtak' | 'android' | 'ios' | 'windows' | 'unknown'`, total, deterministic, case-insensitive, never throwing
    - Rules in THIS precedence order, first match wins: (1) CloudTAK — contains `(ETL)`, `(Web)`, or the literal `CloudTAK` anywhere; (2) Android/ATAK — starts with `ANDROID-`; (3) iOS/iTAK — UUID `8-4-4-4-12` hex; (4) Windows/WinTAK — SID `S-1-5-21-<digits>-<digits>-<digits>-<digits>`; (5) Unknown
    - CloudTAK MUST be evaluated before Android: `ANDROID-CloudTAK-chris@chriselsen.net` exists on the server and is CloudTAK, not an ATAK device
    - Place it beside the existing pure helpers in `server/utils/` (`callsignValidation.js`, `directoryScope.js`)
    - _Requirements: 15.1, 15.3, 15.4, 15.5_
    - Files: `server/utils/clientType.js`
  - [x] 22.2 Expose `clientType` on the Device wire shape
    - In `server/services/DeviceManagementService.js`, add `clientType: classifyClientType(row.client_uid)` inside `mapDevice(row)` — the single wire-shape definition every method already returns through, so all four endpoints gain the field at once
    - No column, no migration, no backfill: derived on read
    - _Requirements: 15.1, 15.2_
    - Files: `server/services/DeviceManagementService.js`
  - [x] 22.3 Create the shared `DeviceTypeIcon` component
    - `client/src/components/DeviceTypeIcon.jsx` maps `clientType` to a glyph plus a platform label ("CloudTAK", "Android / ATAK", "iOS / iTAK", "Windows / WinTAK", "Unknown client type")
    - Glyphs are committed inline SVG in this one file — NO new client dependency; `@heroicons/react` (already a dependency) supplies `GlobeAltIcon` for CloudTAK and `QuestionMarkCircleIcon` for Unknown
    - Each icon carries an accessible name and a tooltip visible on hover AND keyboard focus, using the existing `relative group` pattern from `client/src/pages/Dashboard.jsx`
    - _Requirements: 15.6, 15.7, 16.3, 16.4_
    - Files: `client/src/components/DeviceTypeIcon.jsx`
  - [x] 22.4 Convert both device lists to icon-only actions and render the type icon
    - In `client/src/pages/Dashboard.jsx` and `client/src/components/UserDevicesModal.jsx`: render `<DeviceTypeIcon clientType={device.clientType} />` per row, and replace the text `Revoke` button with an icon-only control carrying `aria-label={`Revoke device ${device.clientUid}`}` and a `relative group` tooltip made visible on hover AND focus (`group-focus-within:opacity-100` or an equivalent focus-visible rule)
    - Keep the control `disabled` for an already-revoked Device alongside the existing "Revoked" badge, so the state is announced and not conveyed by color alone
    - Both lists MUST render the same markup from the same helper/component so the surfaces cannot diverge
    - _Requirements: 15.6, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6_
    - Files: `client/src/pages/Dashboard.jsx`, `client/src/components/UserDevicesModal.jsx`
  - [x] 22.5 Write property test: Client_Type classification is total, deterministic, and precedence-correct
    - **Property 11: For all strings, `classifyClientType` returns exactly one of the five Client_Types, is case-insensitive, returns `cloudtak` for anything containing `(ETL)`/`(Web)`/`CloudTAK` even when it also starts with `ANDROID-`, `android` for other `ANDROID-` strings, `ios` for UUIDs, `windows` for SIDs, and `unknown` otherwise, never throwing**
    - Tag: `// Feature: device-management, Property 11: Client_Type classification is total, deterministic, and precedence-correct`
    - fast-check, `numRuns >= 100`, with targeted generators for UUIDs, SIDs, `ANDROID-` prefixes and `ANDROID-`+CloudTAK strings, plus random case
    - **Validates: Requirements 15.1, 15.3, 15.4, 15.5, 15.8**
    - Files: `server/utils/clientType.property.test.js`
  - [x] 22.6 Write unit tests for the classifier, the wire field, and the icon-only UI
    - Assert each rule with the live examples (`ckadmin (ETL)`, `ANDROID-CloudTAK-chris@chriselsen.net`, `ANDROID-63040a40563b5fab`, `CE17C84D-9700-4080-BA5A-44AF51809453`, `S-1-5-21-2281966494-490247268-205662872-1002`, and an unclassifiable string) (15.3, 15.4, 15.5)
    - Assert `clientType` is present on the devices returned by the self-view and the admin view (15.1, 15.2)
    - Assert the Revoke control has an accessible name naming the device, that its tooltip is present on focus as well as hover, and that a revoked Device's control is disabled and announced (16.2, 16.3, 16.5, 16.7)
    - Assert the type icon renders with its platform label in BOTH the Dashboard card and the modal (15.6, 16.6)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 16.2, 16.3, 16.5, 16.6, 16.7_
    - Files: `server/utils/clientType.test.js`, `server/services/__tests__/DeviceManagementService.test.js` (extend), `client/src/components/DeviceTypeIcon.test.jsx`, `client/src/components/UserDevicesModal.test.jsx` (extend), `client/src/pages/Dashboard.test.jsx` (extend)
  - [x] 22.7 Checkpoint - Ensure all tests pass
    - Ensure all tests pass, ask the user if questions arise.

- [x] 23. Tighten endpoint tolerance so a documented endpoint fails loudly
  - [x] 23.1 Remove the graceful-404-as-empty handling from documented-endpoint fetches
    - In `server/services/TakServerService.js`, remove the `isNotFound(error) -> []` branch from `listActiveCertificates()` and apply no such branch to `listRevokedCertificates()` or `getClientEndpoints()`: all three are documented in `tak-server-openapispec.json`, so a 404 means the request was wrong, not that the server is empty
    - Where a tolerated absence genuinely remains, record in a code comment which OpenAPI operation the view corresponds to and why its absence is safe
    - _Requirements: 14.1, 14.2, 14.3_
    - Files: `server/services/TakServerService.js`
  - [x] 23.2 Make the jobs report a failed run rather than a silent empty one
    - In `SubscriptionPoller.run()` and `DeviceSync.run()`, log a documented-endpoint failure at ERROR level with the endpoint and status, report the run as failed, and leave all rows unchanged; keep `run()` never throwing so the Sync_Worker cannot crash
    - A failed `/revoked` fetch MUST NOT be treated as an empty revoked set, since that would present revoked certificates as live
    - Ensure a failed fetch is distinguishable in the logs from a successful fetch that legitimately returned zero rows — the exact defect the earlier graceful-404 handling produced, where a non-existent endpoint read as "no clients observed" and `last_seen_at` stayed null with nothing logged
    - _Requirements: 3.8, 4.9, 14.1, 14.2, 14.5_
    - Files: `server/services/SubscriptionPoller.js`, `server/services/DeviceSync.js`
  - [x] 23.3 Write property test: a documented-endpoint failure is never an empty result
    - **Property 12: For all failure modes of a documented-endpoint fetch (404, other 4xx, 5xx, network error, timeout, malformed payload), the run is reported failed with an error logged and performs no Device_Table write; a 404 is never converted into an empty result set and a failed `/revoked` fetch is never converted into an empty revoked set**
    - Tag: `// Feature: device-management, Property 12: A documented-endpoint failure is never an empty result`
    - fast-check over generated axios-shaped errors, `numRuns >= 100`, asserting the run outcome and the absence of DB writes against a mocked pool
    - **Validates: Requirements 3.8, 4.9, 14.1, 14.2, 14.5**
    - Files: `server/services/__tests__/endpointTolerance.property.test.js`
  - [x] 23.4 Write a structural test asserting no call to an undocumented endpoint
    - Assert no server source file requests `/Marti/clients`, and that every Marti path the device-management code requests appears in `tak-server-openapispec.json`
    - _Requirements: 14.4_
    - Files: `server/services/__tests__/martiEndpointContract.test.js`
  - [x] 23.5 Checkpoint - verify the full build
    - Run `npm test` and confirm all server (jest) tests pass; run the client vitest suite and confirm it passes
    - Run `npm run lint` and confirm the problem count does NOT increase above the baseline captured in task 17
    - _Requirements: 9.1, 9.6, 9.7_

- [x] 24. Add the revocation rails: separate destructive flag, dry-run, blast-radius cap, audit record
  - **Implement this section BEFORE task 19.3.** 19.3 is what makes a device-scoped revoke resolve a target set and issue the `DELETE`; without 24.1-24.3 that path goes live against a shared TAK Server with no arming flag, no cap and no audit trail.
  - [x] 24.1 Add `isDeviceMgmtRevokeEnabled()` and document `DEVICE_MGMT_REVOKE_ENABLED`
    - In `server/config/deviceMgmt.js`, export `isDeviceMgmtRevokeEnabled(env = process.env)` returning `env.DEVICE_MGMT_REVOKE_ENABLED === 'true'`, alongside the existing `isDeviceMgmtEnabled()` and following the same boolean-env convention and server-only doc comment
    - It is an INDEPENDENT variable with its own default of `false`: do NOT derive it from, nest it under, or default it to `DEVICE_MGMT_ENABLED`. Both must be `'true'` for a revoke to be issued; reading Devices requires only `DEVICE_MGMT_ENABLED`
    - Export the cap too: `getRevokeMaxCerts(env = process.env)` reading `DEVICE_MGMT_REVOKE_MAX_CERTS` with a documented default of `250`, clamped to a positive integer (`parseInt(...) || 250` in the codebase's existing style)
    - Add `DEVICE_MGMT_REVOKE_ENABLED=false` and `DEVICE_MGMT_REVOKE_MAX_CERTS=250` to `.env.example` with explanatory comments: the first arms the destructive capability separately from the read capability and is safe to leave `false`; the second bounds one operation's blast radius and defaults above the largest real per-Device certificate count observed live (60 on `ckadmin (ETL)`). Neither is added to `REQUIRED_VARS`
    - Never add either variable to `SiteConfig.getPublicConfig()`
    - _Requirements: 12.9, 12.13_
    - Files: `server/config/deviceMgmt.js`, `.env.example`
  - [x] 24.2 Gate both revoke routes on Revoke_Enabled with a distinct non-404 error
    - In `server/routes/deviceManagement.js`, reject both `POST .../revoke` routes when `isDeviceMgmtRevokeEnabled()` is false, BEFORE any `EventPublisher.publishOperation` call. The existing `isDeviceMgmtEnabled()` re-check and the authorization + `confirmation === 'REVOKE'` gates keep their current positions and behavior
    - Respond `403` with a body that names the disabled capability (e.g. `{ error: 'Device revocation is disabled', capability: 'DEVICE_MGMT_REVOKE_ENABLED' }`). Do NOT respond `404`: `404` already means `DEVICE_MGMT_ENABLED` is off (Requirement 1.8), so reusing it would make "feature absent" and "revocation disarmed" indistinguishable
    - Leave the read routes untouched — they stay gated on `isDeviceMgmtEnabled()` alone
    - _Requirements: 12.9, 12.10_
    - Files: `server/routes/deviceManagement.js`
  - [x] 24.3 Add the dry-run, the single-`client_uid` abort, the cap check, and the audit record to the handler
    - In `server/workers/syncWorker.js`'s `revokeTakCertificates`, resolve the target certificate ids first, then run these gates in this order, all BEFORE any `DELETE /Marti/api/certadmin/cert/revoke/{ids}`:
      1. **Audit record** — log `revoke_audit` via the Structured_Logger with `operationId`, `actingUserId`, `payloadShape`, `clientUid`, the FULL `targetCertIds` list, `targetCertCount`, a stable `targetCertIdsDigest` of the sorted id list, `capLimit`, `dryRun`, and `revokedViewCountBefore` (the pre-flight `/revoked` size, from the fetch the operation already makes). Never truncate the id list; where the count makes a full list impractical, log the count and the digest alongside whatever ids are recorded. No credential material or passphrase, ever (Requirements 2.11, 9.2 unchanged)
      2. **Single-`client_uid`** (device-scoped shape only) — if the resolved set carries more than one distinct `clientUid`, abort without issuing the `DELETE` and mark the operation PERMANENTLY failed (not retryable): a resolution spanning Devices is a defect retrying cannot fix
      3. **Blast-radius cap** — if `targetCertCount > getRevokeMaxCerts()`, abort without issuing the `DELETE`. Do NOT truncate the set and proceed: a partial revocation reports a Device disabled while leaving it usable
      4. **Dry-run** — if `isDeviceMgmtRevokeEnabled()` is false, issue no `DELETE`, flip no `tak_devices.revoked` flag, and complete the operation as a SUCCESSFUL dry-run (marked `dryRun: true` in the audit record) rather than failing, so it is neither retried forever nor left queued to fire when the flag flips
    - After a live `DELETE`, log `revoke_audit_result` with `operationId`, `clientUid`, `targetCertCount`, `verified`, `unverified`, `revokedViewCountAfter`, and `revokedFlagFlipped`, so what changed is answerable by differencing the recorded pre/post `/revoked` counts
    - Apply the audit record and the cap to BOTH payload shapes, including the pre-existing user-scoped one (it has the larger blast radius); apply the single-`client_uid` abort to the device-scoped shape only
    - Keep the existing verify-before-success, no-match-is-a-successful-no-op, and `classifyTakServerError` retry/permanent semantics otherwise unchanged
    - _Requirements: 12.10, 12.11, 12.12, 12.13, 12.14, 12.15, 12.16_
    - Files: `server/workers/syncWorker.js`
  - [x] 24.4 Write unit tests for the flag, the route gate, and the handler rails
    - Assert `isDeviceMgmtRevokeEnabled()` is true only for exactly `'true'`, defaults false when unset, and is independent of `DEVICE_MGMT_ENABLED` (both true, each true alone, both unset) (12.9)
    - Assert `getRevokeMaxCerts()` defaults to 250 and honours `DEVICE_MGMT_REVOKE_MAX_CERTS` (12.13)
    - Assert neither variable appears in `SiteConfig.getPublicConfig()`, set and unset (12.9)
    - Assert both revoke routes reject with a non-404 status naming the capability and make NO `publishOperation` call while Revoke_Enabled is false, and that the read routes still succeed with only `DEVICE_MGMT_ENABLED` on (12.9, 12.10)
    - Assert the handler, while Revoke_Enabled is false, logs the full audit record, issues no `DELETE`, flips no `revoked` flag, and completes as a successful dry-run (12.11)
    - Assert a resolved set spanning two `client_uid`s aborts with no `DELETE` and is marked permanently failed (12.12)
    - Assert a resolved set one over the cap aborts with no `DELETE` and is NOT truncated (the `DELETE` is never called with a shortened id list) (12.13)
    - Assert the audit record carries every targeted id plus the count and digest, is emitted before the `DELETE`, and that the result record carries the verification outcome and the pre/post `/revoked` counts (12.14, 12.16)
    - Assert the cap and audit apply to a user-scoped payload as well as a device-scoped one (12.15)
    - Assert no test log output contains credential material or a passphrase (2.11, 9.2)
    - _Requirements: 12.9, 12.10, 12.11, 12.12, 12.13, 12.14, 12.15, 12.16_
    - Files: `server/config/__tests__/deviceMgmt.test.js` (extend), `server/models/__tests__/SiteConfig.test.js` (extend), `server/routes/__tests__/deviceManagement.test.js` (extend), `server/workers/__tests__/syncWorker.test.js` (extend)
  - [x] 24.5 Write property test: a DELETE is issued only when armed, single-Device, and within the cap
    - **Property 13: For all resolved target sets (arbitrary size, arbitrary `clientUid` spread including multi-uid sets, sizes both under and over the cap) and all combinations of Device_Mgmt_Enabled and Revoke_Enabled, a `DELETE` is issued iff Revoke_Enabled is true AND the set carries exactly one distinct `client_uid` AND its size is within the cap; otherwise no `DELETE` is issued and no `revoked` flag is flipped. The single-`client_uid` conjunct applies to the device-scoped shape; the audit record is logged before the decision point in every case**
    - Tag: `// Feature: device-management, Property 13: A DELETE is issued only when armed, single-Device, and within the cap`
    - fast-check, `numRuns >= 100`; generators MUST cover both payload shapes, sets spanning several `clientUid`s, and sizes straddling the cap boundary (cap-1, cap, cap+1), asserting against a mocked `TakServerService`/pool that `revokeCertificates` was or was not called and that the id list handed to it was never shortened
    - **Validates: Requirements 12.9, 12.10, 12.11, 12.12, 12.13, 12.14, 12.15**
    - Files: `server/workers/__tests__/revokeRails.property.test.js`
  - [x] 24.6 Checkpoint - Ensure all tests pass
    - Ensure all tests pass, ask the user if questions arise.
    - Confirm before moving on that 24.1-24.3 are in place, since task 19.3 is what arms the device-scoped `DELETE` and must not land ahead of them

- [x] 25. Delete stale Device rows during the sync
  - Closes the read-side half of Requirement 11.5: task 20.2 stopped a fully-revoked `clientUid` from ever being UPSERTED, but nothing removes a row that was upserted while that uid was still live, and `listOwnDevices` filters on `user_id` alone — no freshness check, no `revoked` check. Measured live: 13 Live_Certificates yielding 13 Devices against 22 `tak_devices` rows, nine stale, all with `revoked = false`.
  - The single most important behaviour in this section is the NEGATIVE one: a run that did not fully succeed must delete NOTHING. Everything else here is secondary to that.
  - [x] 25.1 Delete the Stale_Device_Rows at the end of a successful `DeviceSync.run()`
    - In `server/services/DeviceSync.js`, after the upsert loop and BEFORE the `outcome: 'completed'` log line, delete every `tak_devices` row whose `client_uid` is absent from the Live_Device_Set — the keys of the `devices` map `groupByClientUid` returned, which are exactly the `client_uid`s this run upserted
    - Scope the statement to those uids (e.g. `DELETE FROM tak_devices WHERE client_uid <> ALL($1::text[])`). NEVER issue an unscoped `DELETE FROM tak_devices`
    - Run the delete ONLY on a run that fully succeeded. Every existing early return in `run()` — the rejected `listLiveCertificates()`, the non-array payload, the failed `loadUsers()`, each of which already reports `outcome: 'failed'` and returns `undefined` (task 23.2) — MUST return before the delete, so a TAK Server outage cannot empty the table
    - Handle the empty-Live_Device_Set case explicitly: a SUCCESSFUL run that legitimately found zero live Devices deletes every row (correct), which is why the delete must be reachable only from the success path — the same table state produced by a failed run must delete nothing
    - Wrap the delete in its own try/catch: log the failure via the Structured_Logger, complete the rest of the run, and let the next run retry — matching how a single row's failed upsert is already logged and skipped. `run()` MUST continue never to throw
    - Add the deleted-row count to the per-run counts so it appears in the `outcome: 'completed'` log line alongside `upserted`/`skipped`/`failed`/`matched`/`unmatched`
    - Do NOT touch `DeviceManagementService.listOwnDevices`: once the rows are gone both views stop returning them, and a `last_polled_at` or `revoked` filter would be a second removal mechanism that can disagree with this one
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9_
    - Files: `server/services/DeviceSync.js`
  - [x] 25.2 Correct the false `last_polled_at`-staleness claim in the code comments
    - In `server/services/DeviceSync.js`'s header doc block, replace the claim that a fully-revoked uid's row "simply stops being refreshed -- its `last_polled_at` goes stale, which is the signal the self-view uses to stop presenting it as current -- rather than being rewritten or deleted here". No such signal was ever implemented. State instead that the row is DELETED by the reconciliation step (Requirement 17) and that `last_polled_at` is sync bookkeeping, not a visibility input
    - In `server/workers/syncWorker.js`'s `markDevicesRevoked` doc block, correct the same reasoning: it currently justifies swallowing a failed flag flip with "a revoked certificate drops out of the Active_Certificate view, so the row stops being refreshed". Both halves are wrong — a revoked certificate does NOT drop out of `/active` (90 of 95 live certificates appeared in BOTH `/active` and `/revoked`, finding 2), and nothing consumed the staleness. The swallow stays correct, but for the corrected reason: the next completed sync finds no Live_Certificate for that `clientUid` and DELETES the row, so a stale `revoked = false` is genuinely transient
    - Keep the correction in place in both files — do not add a new comment beside the wrong one
    - design.md's own copy of this claim (the "The Device_Sync" section, step 5) and its Data Models `last_polled_at` note were corrected in place as part of this revision; verify they match the code comments after this task
    - _Requirements: 17.7, 17.8_
    - Files: `server/services/DeviceSync.js`, `server/workers/syncWorker.js`
  - [x]* 25.3 Write unit tests for the deletion step
    - Assert a successful run deletes exactly the rows whose `client_uid` is absent from the derived Device set, and that the statement is parameterised by those uids rather than unscoped (17.1, 17.3)
    - Assert a successful run deletes NO row whose `client_uid` is in the derived Device set, including when that uid's own upsert failed (17.4)
    - Assert NO delete is issued on each failure path separately — rejected `listLiveCertificates()`, non-array payload, failed `loadUsers()` — and that the table is left untouched in each (17.2)
    - Assert a successful run that derived ZERO Devices deletes every row, while a FAILED run against the same table deletes nothing (17.2, 17.1)
    - Assert a delete failure is logged, does not throw out of `run()`, and does not prevent the upserts or the completion log line (17.6)
    - Assert the completion log line carries the deleted count (17.9)
    - Assert a re-appearing `client_uid` is re-inserted by the normal upsert with `revoked` at its default (17.5)
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.9_
    - Files: `server/services/__tests__/DeviceSync.test.js` (extend)
  - [x]* 25.4 Write property test: a row is deleted iff the fetch succeeded and its client UID is not live
    - **Property 14: For all fetch outcomes and all (Live_Device_Set, table content) pairs, a row is deleted if and only if the fetch fully succeeded AND its `client_uid` is absent from the derived Live_Device_Set; a failed or malformed fetch deletes nothing, and every deletion is restricted by `client_uid`**
    - Tag: `// Feature: device-management, Property 14: A row is deleted if and only if the fetch succeeded and its client UID is not live`
    - fast-check, `numRuns >= 100`; generators MUST cover the four outcomes (rejection, non-list payload, failed user load, success) crossed with disjoint / identical / subset / empty-live-set / empty-table pairs, and MUST include the empty-live-set-on-success case — the one case where correct behaviour and catastrophic behaviour produce the same table and are distinguished only by the run outcome
    - Assert against a mocked pool the exact set of `client_uid`s the delete was asked for, so an implementation issuing an unscoped `DELETE FROM tak_devices` fails
    - **Validates: Requirements 17.1, 17.2, 17.3, 17.4**
    - Files: `server/services/__tests__/DeviceSync.staleDeletion.property.test.js`
  - [x] 25.5 Checkpoint - verify the full build
    - Run `npm test` and confirm all server (jest) tests pass; run the client vitest suite and confirm it passes
    - Run `npm run lint` and confirm the problem count does NOT increase above the baseline captured in task 17
    - Ensure all tests pass, ask the user if questions arise
    - _Requirements: 9.1, 9.6, 9.7_

- [x] 26. Render every date in a configurable Display_Timezone
  - The measured defect: TAK Server reported `2026-03-12T00:58:04.508Z` and the UI showed `2026-03-11 17:58` — UTC−7, the browser's zone, a different calendar day. `formatDate`/`formatDateTime` build their output from `getFullYear()`/`getMonth()`/`getDate()`/`getHours()`/`getMinutes()`, all browser-local getters.
  - **This section reaches outside device-management by design.** The fix is in the shared formatters, so every date in the app shifts. Flag it in review (Requirement 18.4).
  - [x] 26.1 Expose the resolved Display_Timezone on the public config and document the variable
    - In `server/models/SiteConfig.js`'s `getPublicConfig()`, add `config.display_timezone = process.env.DISPLAY_TIMEZONE || 'Pacific/Auckland'`, beside the existing `channel_folder_separator` / `maxTeamDepth` / `takRoleValues` presentation keys
    - Do NOT add `DEVICE_MGMT_ENABLED` or `DEVICE_MGMT_REVOKE_ENABLED` to this response, and do not treat this key as a precedent for doing so: a display timezone is presentation with no security meaning and is useless server-side, while those two describe the arming state of a destructive capability (Requirements 1.4, 12.9, 18.6). Feature discovery keeps using the self-view probe
    - Add `DISPLAY_TIMEZONE=Pacific/Auckland` to `.env.example` with a comment stating that it is optional, that it defaults to `Pacific/Auckland`, that it applies to EVERY user-visible date in the app rather than to device management alone, and that it is presentation only — no stored, logged or API-transported timestamp changes. Do NOT add it to `REQUIRED_VARS`, and do NOT edit `.env`
    - _Requirements: 18.1, 18.5, 18.6, 18.12, 18.13_
    - Files: `server/models/SiteConfig.js`, `.env.example`
  - [x] 26.2 Compute the date components in the Display_Timezone inside the shared formatters
    - In `client/src/utils/dateFormat.js`, replace the browser-local getters with components read from a memoised `Intl.DateTimeFormat` configured with `timeZone`, numeric parts, `hour12: false` and `hourCycle: 'h23'`, via `formatToParts`
    - Keep the emitted format EXACTLY as it is: `yyyy-mm-dd` and `yyyy-mm-dd HH:MM`, 24-hour, every component zero-padded, assembled in this module. Do NOT return `toLocaleDateString`/`toLocaleTimeString`-style or `dateStyle`-based output — that is the locale-dependent rendering these helpers exist to replace, and `h24` would render midnight as `24:00` (Requirement 18.3)
    - Keep both signatures and the `fallback` semantics unchanged: null, undefined and unparseable input still return the caller's `fallback`, defaulting to `''` (Requirement 18.10)
    - Resolve the zone ONCE and cache the formatters; wrap construction in a try/catch that walks the Display_Timezone_Fallback_Chain — configured zone, then `Pacific/Auckland`, then `UTC` — because `Intl.DateTimeFormat` throws a `RangeError` for a zone it does not know and these functions run once per rendered cell, so an unmemoised bad zone would throw once per row and blank the page (Requirements 18.8, 18.9)
    - Export `setDisplayTimezone(zone)` (installs a zone and resets the memoised formatters), `getDisplayTimezone()` (the zone actually in force after the chain resolved, so a test can assert the fallback without reading module internals), and `DEFAULT_DISPLAY_TIMEZONE = 'Pacific/Auckland'`
    - _Requirements: 18.2, 18.3, 18.7, 18.8, 18.9, 18.10_
    - Files: `client/src/utils/dateFormat.js`
  - [x] 26.3 Install the zone at startup, before the first date renders
    - In `client/src/App.jsx`, fetch the public config once on mount REGARDLESS of session state and call `setDisplayTimezone(response.data?.display_timezone)`. The existing `configAPI.getPublic()` call in that file sits inside the `authAPI.getProfile()` rejection branch — the unauthenticated auto-login path — so a signed-in user never reaches it and it cannot be reused as an app-wide install point
    - Resolve it within the startup gate `App.jsx` already holds the interface behind (`loading`), so the first rendered date is already in the configured zone and correctness does not depend on a module-level mutation reaching components that have already rendered — React does not re-render for that
    - A failed or slow fetch must NOT extend that gate or block the interface: swallow the failure and let the `Pacific/Auckland` default stand (Requirements 18.7, 18.11)
    - _Requirements: 18.7, 18.11_
    - Files: `client/src/App.jsx`
  - [x]* 26.4 Write unit tests for the zoned formatters, the config key, and the startup install
    - Assert `formatDate`/`formatDateTime` render the measured case correctly: `2026-03-12T00:58:04.508Z` yields `2026-03-12 13:58` in `Pacific/Auckland` (NZDT, +13) and `2026-03-11 17:58` in `America/Los_Angeles`, so the defect is pinned by a regression test rather than described (18.2)
    - Assert the emitted strings match `yyyy-mm-dd` / `yyyy-mm-dd HH:MM` exactly, including a midnight instant rendering as `00:00` and never `24:00` (18.3)
    - Assert the existing null/undefined/unparseable `fallback` behaviour is unchanged (18.10)
    - Assert an unrecognised zone (`'Pacific/Aukland'`, `''`, a random string) still renders, falls back down the chain, and never throws (18.8)
    - Assert memoisation by spying on `Intl.DateTimeFormat` and checking the construction count does not grow with the number of formatted values (18.9)
    - Assert `getPublicConfig()` includes `display_timezone` (set and unset) in the SAME test that asserts `DEVICE_MGMT_ENABLED` and `DEVICE_MGMT_REVOKE_ENABLED` are still absent, so the presentation and capability categories cannot be conflated by a later refactor (18.5, 18.6)
    - Assert `App.jsx` installs the zone with a resolved public config and that the interface still renders with a rejected one (18.7, 18.11)
    - Assert one non-device surface (`pages/AuditLogs.jsx`) renders in the configured zone, so the app-wide claim is tested rather than asserted (18.4)
    - _Requirements: 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10, 18.11_
    - Files: `client/src/utils/dateFormat.test.js` (extend), `client/src/App.test.jsx`, `client/src/pages/AuditLogs.test.jsx`, `server/models/__tests__/SiteConfig.test.js` (extend)
  - [x]* 26.5 Write property test: date rendering is total, correctly zoned, and format-invariant
    - **Property 15: For all instants and all installed zone values, `formatDate` returns exactly `yyyy-mm-dd` and `formatDateTime` exactly `yyyy-mm-dd HH:MM` (24-hour, zero-padded) whose components equal that instant's wall clock in the resolved zone, and neither ever raises; null/unparseable input still returns the caller's `fallback`**
    - Tag: `// Feature: device-management, Property 15: Date rendering is total, correctly zoned, and format-invariant`
    - fast-check (already a client devDependency), `numRuns >= 100`. Generators MUST cross a wide instant range (pre-epoch through far future, and instants within an hour either side of midnight in the target zone — where a local getter and a zoned one disagree about the calendar DAY, the exact shape of the reported defect) with real zones including `Pacific/Auckland`, `Pacific/Chatham` (+12:45), `Asia/Kolkata` (+05:30), `America/Los_Angeles` and `UTC`; and a second arm installing arbitrary strings, `''` and `undefined` as the zone
    - Compare values against an INDEPENDENTLY constructed `Intl.DateTimeFormat` (a model comparison), never by calling back into the code under test; assert the shape with a strict anchored regex so a locale formatter or an `h24` cycle cannot pass
    - **Validates: Requirements 18.2, 18.3, 18.8, 18.10, 18.14**
    - Files: `client/src/utils/dateFormat.property.test.js`
  - [x] 26.6 Checkpoint - verify the full build
    - Run `npm test` and confirm all server (jest) tests pass; run the client vitest suite and confirm it passes
    - Confirm no existing client test asserted a browser-local-time rendering that this change legitimately alters; where one did, update the assertion rather than the code
    - Run `npm run lint` and confirm the problem count does NOT increase above the baseline captured in task 17
    - _Requirements: 9.1, 9.6, 9.7_

- [x] 27. Auto-refresh the device list without a page reload
  - [x] 27.1 Refresh the Dashboard "My Devices" card on the existing Visibility_Pause_Pattern
    - In `client/src/pages/Dashboard.jsx`, add an effect that calls `fetchDevices` on a `setInterval` at 60000 ms, clears it when `document.hidden` via a `visibilitychange` listener, re-fetches immediately and restarts the interval when the tab becomes visible again, and clears BOTH the interval and the listener in the effect's cleanup — the same shape `fetchChannelData` already uses in this file. Do NOT introduce a second, differently-behaved refresh mechanism beside it
    - A background refresh MUST NOT raise the loading state: only the first fetch shows the spinner, or the card flickers every minute
    - A failed refresh MUST NOT call `setDevices([])`, MUST NOT return the card to its loading or empty-list state, and MUST NOT hide the card. Only an explicit `404` from the probe — the feature genuinely turned off server-side — hides it; a network failure or a 5xx retains the last successful list
    - A refresh MUST leave `deviceToRevoke` untouched, so an open `RevokeDeviceDialog` stays open with the Device it targets and the text the user has typed into it intact; do not re-resolve the open Device against the refreshed list
    - The 60000 ms figure is a UI-consistency choice, not a data-freshness one: the server re-polls TAK every `DEVICE_MGMT_POLL_INTERVAL_MS` (default 5 min) and re-syncs every `DEVICE_MGMT_SYNC_INTERVAL_MS` (default 15 min), so most refreshes re-read unchanged rows. Record that in a code comment and do NOT change either server cadence to match
    - Do NOT add an interval to `client/src/components/UserDevicesModal.jsx`: it is a short-lived dialog that already refetches on open and after a revoke, and a background refresh under a stacked confirmation dialog is disruption rather than freshness
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8_
    - Files: `client/src/pages/Dashboard.jsx`
  - [x]* 27.2 Write unit tests for the refresh behaviour (fake timers)
    - Assert n interval ticks produce n device fetches while the tab is visible (19.1)
    - Assert `visibilitychange` with `document.hidden` true stops the fetches, and becoming visible again fetches immediately then resumes the interval (19.2)
    - Assert unmounting stops the fetches and removes the listener — advance timers past several intervals and assert no further call (19.3)
    - Assert an open revoke dialog survives a refresh: open it, type a partial `REVOKE`, let a refresh resolve, and assert the dialog is still open with the input value preserved (19.4)
    - Assert a rejected refresh after a successful first fetch leaves the rendered rows exactly as they were, with no spinner and no empty-list message (19.5)
    - Assert a `404` from the probe hides the card while a `500` does not (19.6)
    - Assert the user-details modal fetches exactly once across several intervals (19.8)
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.8_
    - Files: `client/src/pages/Dashboard.test.jsx` (extend), `client/src/components/UserDevicesModal.test.jsx` (extend)
  - [x] 27.3 Checkpoint - Ensure all tests pass
    - Ensure all tests pass, ask the user if questions arise.

- [x] 28. Present a currently-connected Device as connected
  - The single most important behaviour in this section is that the Connection_Status write is NOT behind the Monotonic_Guard. Everything else here is secondary to that.
  - [x] 28.1 Add the `connected` column and correct the stale `last_seen_at` column comment
    - Add a `node-pg-migrate` incremental migration doing `ALTER TABLE public.tak_devices ADD COLUMN connected boolean NOT NULL DEFAULT false`, following the `pgm.sql(...)` conventions of `1787518155760_tak-devices.cjs`, with a `down()` that drops the column
    - `COMMENT ON COLUMN public.tak_devices.connected`: Connection_Status from `ClientEndpoint.lastStatus` collapsed by the Status_Collapse_Rule, written by the Subscription_Poller only, on every successful poll, NOT behind the Monotonic_Guard
    - `NOT NULL DEFAULT false`, not a nullable tri-state: nothing consumes a "never polled" state distinct from "reported, not connected" — both render identically and both mean "no evidence this Device is connected" — and the `false` an `ALTER` fills existing rows with is correct under that reading, so no backfill is needed
    - In the SAME migration, re-issue `COMMENT ON COLUMN public.tak_devices.last_seen_at`: its current text says the value comes "from the live subscriptions API", which is the endpoint that does not exist (finding 1). Since task 21.2 Last_Seen comes from the Client_Endpoints_API's reported `lastEventTime`. Also correct that text in place in `1787518155760_tak-devices.cjs` for readers, noting it will not re-run
    - _Requirements: 20.2_
    - Files: `database/migrations/<timestamp>_tak-devices-connected.cjs`, `database/migrations/1787518155760_tak-devices.cjs`
  - [x] 28.2 Write Connection_Status on every successful poll, outside the Monotonic_Guard
    - In `server/services/SubscriptionPoller.js`, change `extractLastEventTimes` to reduce to `Map<uid, { lastEventTime: Date|null, connected: boolean }>`. An entry whose `lastEventTime` is absent or unparseable is STILL skipped for the Last_Seen write (Requirement 13.6) but now contributes `{ lastEventTime: null, connected }` so its `lastStatus` is not discarded (Requirement 20.4)
    - Collapse several entries for one `uid` by the Status_Collapse_Rule: connected when AT LEAST ONE entry reports `lastStatus` equal to `Connected`, compared case-insensitively; absent, null and any other value count as not connected. A device with one live connection is connected regardless of how many stale per-callsign entries TAK Server holds for it — verified live, one Windows SID returned four entries under different callsigns. Keep the existing GREATEST-time collapse for `lastEventTime` unchanged
    - Change `recordLastSeen` to one statement that writes `connected` for every reported `uid` while keeping the monotonic clamp on `last_seen_at` alone — move the clamp from the `WHERE` clause into the `SET` list (`SET connected = $3, last_seen_at = CASE WHEN $2 IS NOT NULL AND (last_seen_at IS NULL OR last_seen_at < $2) THEN $2 ELSE last_seen_at END WHERE client_uid = $1`). Do NOT leave the status write behind `WHERE last_seen_at IS NULL OR last_seen_at < $2`: that predicate is a deliberate no-match for a non-advancing timestamp, so the devices most likely to be connected right now would never have their status written
    - On a SUCCESSFUL run only, set `connected = false` for the Device_Table rows whose `client_uid` is absent from the reported set, scoped to those uids (`WHERE client_uid <> ALL($1::text[])`). NEVER issue an update unrestricted by `client_uid`. "Connected" is a positive claim needing current evidence; a stale `true` would show a Device online forever if TAK Server dropped its entry, while this rule's failure mode costs a connected Device its label for at most one poll interval. Leave that Device's `last_seen_at` untouched (Requirement 3.4)
    - Every existing early return — the rejected fetch and the non-list payload, both already reporting `outcome: 'failed'` — MUST precede every status write, so a failed poll writes nothing and does not mark every Device disconnected
    - Add the connected/disconnected/unreported counts to the `outcome: 'completed'` log line alongside the existing counts
    - _Requirements: 20.3, 20.4, 20.5, 20.6, 20.7_
    - Files: `server/services/SubscriptionPoller.js`
  - [x] 28.3 Expose `connected` on the Device wire shape
    - In `server/services/DeviceManagementService.js`, add `connected: row.connected` inside `mapDevice(row)` — the single wire-shape definition every method already returns through, so all four endpoints gain the field at once — and include the column in `listOwnDevices`' select if it selects columns explicitly
    - Do NOT add a `connected` predicate to `listOwnDevices`: visibility keeps exactly one mechanism, the presence of the row (Requirement 17.8)
    - _Requirements: 20.8_
    - Files: `server/services/DeviceManagementService.js`
  - [x] 28.4 Render the Connected_Label in the shared device row
    - In `client/src/components/DeviceListRow.jsx`, render the Last Seen cell as: when `device.connected` is true, the text `Connected` (exported as `CONNECTED_LABEL`), with the `formatDateTime(lastSeenAt)` value retained beside it when one is known; otherwise exactly what the cell renders today, including the `NEVER_SEEN_LABEL` fallback
    - The state MUST be carried by text a screen reader announces, following the "Revoked" badge precedent — a coloured dot MAY accompany it but must be `aria-hidden`, and colour alone must never be the only signal
    - Because both surfaces render this one component, no change is needed in `Dashboard.jsx` or `UserDevicesModal.jsx` (Requirement 16.6)
    - _Requirements: 20.1, 20.9_
    - Files: `client/src/components/DeviceListRow.jsx`
  - [x] 28.5 Correct the two stale `lastStatus` / Last_Seen claims in place
    - In `server/services/SubscriptionPoller.js`'s `extractLastEventTimes` doc block, replace "`lastStatus` is not consulted at all (Requirement 13.2)" — it is now the Connection_Status source. Keep the separate, still-correct statement in the class header that `lastStatus` is NOT FILTERED on (Requirement 3.2 is unchanged: every entry contributes its `lastEventTime` whatever its status), and correct the requirement citations at both sites: they cite 13.2, which is about `GET /Marti/api/subscriptions/all`, where the correct citations are 3.2 and 13.7
    - In `client/src/components/DeviceListRow.jsx`'s `NEVER_SEEN_LABEL` doc block, replace "The Subscription_Poller only records a Last_Seen when it happens to observe a device connected, so null means 'no poll has ever seen this device'". That is the pre-21.2 claim: since task 21.2 the source is TAK Server's own reported `lastEventTime`, so null means TAK Server retains no entry for that Device
    - Correct both in place — do not add a new comment beside the wrong one (same convention as task 25.2)
    - _Requirements: 20.4, 20.5_
    - Files: `server/services/SubscriptionPoller.js`, `client/src/components/DeviceListRow.jsx`
  - [x]* 28.6 Write unit tests for the column, the poll write, the wire field, and the rendering
    - Assert the migration adds `connected` as `boolean NOT NULL DEFAULT false` and that both corrected column comments are in place after applying (20.2)
    - Assert a reported entry whose `lastEventTime` equals the stored value still has its `connected` written, and that `last_seen_at` did not move — the regression this section exists to prevent (20.3)
    - Assert an entry with an absent or unparseable `lastEventTime` leaves `last_seen_at` untouched while its status is still written (20.4, 13.6)
    - Assert four entries for one `uid` with a single `Connected` among them yield connected, in any order, and that `connected`/`CONNECTED`/`connECTed` all count while absent, null and `Disconnected` do not (20.5)
    - Assert a successful poll sets `connected = false` for rows absent from the reported set, with the statement parameterised by those uids and never unscoped (20.6)
    - Assert a failed fetch and a non-list payload each write NO status, and in particular do not mark every Device disconnected (20.7)
    - Assert `mapDevice` output carries `connected`, and that `listOwnDevices` gained no `connected` predicate (20.8, 17.8)
    - Assert the four connected × last-seen-known render combinations in BOTH the Dashboard card and the modal, with the label present as text in the accessibility tree, and that a re-inserted row starts at the `connected` default (20.9, 20.11)
    - _Requirements: 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 20.9, 20.11_
    - Files: `server/services/__tests__/SubscriptionPoller.test.js` (extend), `database/migrations/__tests__/tak-devices.integration.test.js` (extend), `server/services/__tests__/DeviceManagementService.test.js` (extend), `client/src/pages/Dashboard.test.jsx` (extend), `client/src/components/UserDevicesModal.test.jsx` (extend)
  - [x]* 28.7 Strengthen Properties 4 and 12 rather than adding properties for 20.7 and 20.10
    - Add `connected` to Property 4's upsert-preservation assertion, so a sync run is asserted to leave a stored `connected` untouched, and assert the column appears in neither the `INSERT` column list nor the `ON CONFLICT DO UPDATE SET` list — the poller is the only writer (20.10)
    - Extend Property 12's no-Device_Table-write assertion to cover the status statement and the unreported-uid statement, so a documented-endpoint failure is asserted to write no `connected` either (20.7)
    - Do NOT add separate properties for 20.7 or 20.10: each would be implied by the existing property and both would fail together
    - _Requirements: 20.7, 20.10_
    - Files: `server/services/__tests__/DeviceSync.property.test.js` (extend), `server/services/__tests__/endpointTolerance.property.test.js` (extend), `server/services/__tests__/DeviceSync.test.js` (extend)
  - [x]* 28.8 Write property test: one poll writes current status for every reported UID, independently of the monotonic guard
    - **Property 17: For all Client_Endpoints_API payloads and Device_Table contents, a successful poll leaves each `last_seen_at` at the running maximum of the parseable reported times, sets each reported Device's `connected` to whether ANY entry for that `uid` reports `Connected` (case-insensitively, invariantly under permutation, including when the only `Connected` entry had an unusable `lastEventTime`), and sets `connected = false` for exactly the rows absent from the reported set through a statement scoped to those `client_uid`s; a non-advancing `lastEventTime` still has its status written**
    - Tag: `// Feature: device-management, Property 17: One poll writes current status for every reported UID, independently of the monotonic guard`
    - fast-check, `numRuns >= 100`. Generators MUST use a small `uid` alphabet against a larger entry count so several entries per `uid` is the common case, draw `lastStatus` from `Connected`/`Disconnected`/absent/null/random-case, and produce `lastEventTime` sequences that deliberately include EQUAL and DECREASING values as well as absent and unparseable ones — equal and decreasing are the inputs for which a status write sharing the guard's `WHERE` clause silently does nothing, so an advancing-only generator would pass the broken implementation
    - Assert against a mocked pool the exact statements and parameters issued, so both the per-`uid` write and the scoping of the unreported-uid update are checked rather than inferred; assert the same result under a permutation of the entries
    - **Validates: Requirements 20.3, 20.4, 20.5, 20.6, 20.12**
    - Files: `server/services/__tests__/SubscriptionPoller.connectionStatus.property.test.js`
  - [x] 28.9 Checkpoint - Ensure all tests pass
    - Ensure all tests pass, ask the user if questions arise.
    - Confirm the migration applies and rolls back cleanly before moving on

- [x] 29. Highlight an imminent certificate expiry
  - [x] 29.1 Expose the threshold on the public config and document the variable
    - In `server/models/SiteConfig.js`'s `getPublicConfig()`, add `config.device_expiry_warning_days`, resolved from `DEVICE_MGMT_EXPIRY_WARNING_DAYS` as a positive integer with a default of 30 — the same `parseInt(...) || <default>` discipline `getRevokeMaxCerts()` uses, so unset, unparseable, zero and negative all yield 30
    - Add `DEVICE_MGMT_EXPIRY_WARNING_DAYS=30` to `.env.example` beside the other device-management variables, with a comment stating it is optional, defaults to 30, and controls only how a date is drawn. Do NOT add it to `REQUIRED_VARS`, and do NOT edit `.env`
    - The same Requirement 18.6 reasoning applies: this is a Presentation_Config key, and the two device-management flags stay out of this response
    - _Requirements: 21.1, 21.7, 21.10_
    - Files: `server/models/SiteConfig.js`, `.env.example`
  - [x] 29.2 Create the pure expiry classifier
    - Create `client/src/utils/expiryWarning.js` exporting `EXPIRY_STATES` (`none`/`imminent`/`expired`), `DEFAULT_EXPIRY_WARNING_DAYS = 30`, `resolveWarningDays(value)` (a positive integer from the public config, else the default), and `classifyExpiry(expiresAt, warningDays, now)`
    - Total, boundary-explicit and never throwing: null, undefined and unparseable input yield `none`; an instant strictly earlier than `now` yields `expired`; an instant in the CLOSED interval `now` through `now + warningDays` yields `imminent` (so exactly on the boundary is imminent); anything later yields `none`
    - `now` is a parameter so the boundaries are testable without clock manipulation. Place the module beside the existing pure client helpers (`dateFormat.js`, `channelTree.js`), matching where `classifyClientType` sits on the server
    - _Requirements: 21.1, 21.6, 21.7_
    - Files: `client/src/utils/expiryWarning.js`
  - [x] 29.3 Render the two expiry states in the shared device row
    - In `client/src/components/DeviceListRow.jsx`, classify `device.expiresAt` against the resolved threshold and render the Expires cell accordingly: `imminent` and `expired` both bold and red, `imminent` carrying the text marker `Expires soon` and `expired` carrying `Expired` (both exported as constants for direct testing)
    - Two distinct markers, not one shared style: "expires soon" is a false statement about a date that has passed, and the two states call for different action
    - The state MUST be conveyed by text a screen reader announces — neither colour nor font weight reaches assistive technology — following the "Revoked" badge precedent (Requirement 16.5)
    - `none` renders exactly what the cell renders today, including the `'Unknown'` fallback for a null `expiresAt`, with no marker and no styling
    - Take the threshold from the public config where the surrounding page already has it, falling back to 30 client-side when it is absent or not a positive integer; because both surfaces render this one component, neither `Dashboard.jsx` nor `UserDevicesModal.jsx` needs its own copy of the rule (Requirements 16.6, 21.8)
    - _Requirements: 21.2, 21.3, 21.4, 21.5, 21.7, 21.8_
    - Files: `client/src/components/DeviceListRow.jsx`
  - [x]* 29.4 Write unit tests for the threshold, the classifier's named cases, and the rendering
    - Assert `getPublicConfig()` includes `device_expiry_warning_days`, and `resolveWarningDays` over unset, `'0'`, `'-5'`, `'abc'` and `'45'` (21.1, 21.7)
    - Assert `classifyExpiry` for null, an instant one day ago, an instant one day ahead, an instant exactly on the boundary, and an instant a year ahead (21.4, 21.5, 21.6)
    - Assert the imminent rendering is bold and red AND carries `Expires soon` as text queryable in the accessibility tree; the expired rendering carries `Expired` and not `Expires soon`; and a null `expiresAt` renders `Unknown` with no marker and no styling (21.2, 21.3, 21.4, 21.5)
    - Assert both renderings appear identically in the Dashboard card and in the modal (21.8)
    - Assert `listOwnDevices` gained no expiry predicate (17.8, 21.9)
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.7, 21.8, 21.9_
    - Files: `client/src/utils/expiryWarning.test.js`, `client/src/pages/Dashboard.test.jsx` (extend), `client/src/components/UserDevicesModal.test.jsx` (extend), `server/models/__tests__/SiteConfig.test.js` (extend), `server/services/__tests__/DeviceManagementService.test.js` (extend)
  - [x]* 29.5 Write property test: expiry classification is total and boundary-exact
    - **Property 16: For all `expiresAt` values and all thresholds, `classifyExpiry` returns exactly one of `none`/`imminent`/`expired` and never raises; `expired` iff the instant is known and strictly earlier than `now`; `imminent` iff it is known and within the closed interval `now` through `now + warningDays`; `none` otherwise, including for every unknown or unparseable input**
    - Tag: `// Feature: device-management, Property 16: Expiry classification is total and boundary-exact`
    - fast-check, `numRuns >= 100`. The offset generator MUST be concentrated at the boundaries — exactly `0`, ±1 ms around `now`, and ±1 ms around `now + warningDays` — alongside broad random offsets: a uniform generator would essentially never land on the inclusive boundary, and the property would pass an implementation using `<` where it needs `<=`
    - Re-derive the expected state from the generated inputs, never by calling back into the code under test
    - **Validates: Requirements 21.4, 21.6, 21.11**
    - Files: `client/src/utils/expiryWarning.property.test.js`
  - [x] 29.6 Checkpoint - verify the full build
    - Run `npm test` and confirm all server (jest) tests pass; run the client vitest suite and confirm it passes
    - Run `npm run lint` and confirm the problem count does NOT increase above the baseline captured in task 17
    - Ensure all tests pass, ask the user if questions arise
    - _Requirements: 9.1, 9.6, 9.7_

- [x] 30. Match a CloudTAK Device through its connection alias
  - The measured defect: `chris@chriselsen.net (Web)` renders "never seen" while the browser session is in use. TAK Server DOES hold an entry for it — the entry just reports `uid: ANDROID-CloudTAK-chris@chriselsen.net`, and the poller's join is `ClientEndpoint.uid == tak_devices.client_uid` equality, so it matches nothing. The certificate `clientUid` and the connection uid are minted in two unrelated code paths and never coincide for a CloudTAK Device.
  - The close is an ADDITIVE alias: the reported uid is ALWAYS still tried on its own and candidates are only ever added beside it. That fixes the failure direction (design decision 18). The direction that must never be possible is a timestamp landing on the WRONG Device — so every candidate is a complete `client_uid` compared by equality, and there is no `LIKE`, prefix test, substring test or wildcard anywhere on this path (Requirement 22.7). A native ATAK/iTAK/WinTAK Device must match bit-for-bit as it does today; if any native match changes, the implementation is wrong.
  - Nothing is persisted and there is NO migration: the alias is computed at poll time from a value already in hand (Requirement 22.13). Do not go looking for a `database/migrations/` entry in this section and do not add one.
  - [x] 30.1 Create the pure Connection_Alias derivation
    - Create `server/utils/connectionAlias.js` — beside `clientType.js`, `callsignValidation.js` and `directoryScope.js`, which is the established home for a pure total server helper with interesting boundaries and the precedent `classifyClientType` set (task 22.x). Export `CLOUDTAK_CONNECTION_PREFIX = 'ANDROID-CloudTAK-'`, `candidateClientUids(reportedUid) -> string[]`, and `unionCandidateClientUids(reportedUids) -> string[]`, using the same `module.exports = { ... }` shape `clientType.js` uses
    - `candidateClientUids` MUST be pure, total and non-throwing for EVERY input, including `''`, `null`, `undefined`, numbers, objects and arrays — it runs inside a poll loop that must never throw (Requirement 3.8), so a non-string input returns a defined value rather than raising
    - A uid that does NOT begin with the prefix yields EXACTLY ONE candidate: that uid alone. This is the arm that protects every native Device — one candidate, the reported uid, is the same match the poller makes today (Requirements 22.2, 22.9)
    - A uid that DOES begin with the prefix yields EXACTLY THREE candidates: the reported uid itself, `` `${base} (Web)` `` and `` `${base} (ETL)` ``, where `base` is the remainder after the prefix. Generate BOTH suffixes rather than choosing one: ` (ETL)` comes from upstream `@tak-ps/node-tak`, ` (Web)` from the TAK-NZ CloudTAK fork only, and the reported uid carries no evidence of which enrollment path minted the certificate — picking one leaves the other form unmatched, which is the bug rather than a fix (Requirement 22.3)
    - Compare the prefix CASE-INSENSITIVELY, but build the candidates from the ORIGINAL substring: `client_uid` matching in Postgres is case-sensitive, so lowercasing the whole uid to test the prefix and then suffixing the lowercased remainder would produce a base that matches no row. Test on a case-folded copy, slice from the original
    - Return the candidates in a DETERMINISTIC order — reported uid first, then `(Web)`, then `(ETL)` — so the SQL parameter array is stable for a given input and a test can assert it exactly rather than as a set
    - Do NOT deduplicate inside `candidateClientUids`: no dedupe is needed (the reported uid always carries the prefix while the suffixed forms never do, and the two suffixes always differ), and adding one would make "exactly three" depend on the data instead of being structural. Deduplicate only in `unionCandidateClientUids`, which collapses the per-entry arrays into one first-seen-ordered array with no repeats, so the sweep's parameter array is stable and does not grow with the duplicate entries TAK Server reports per uid
    - TRAP 1 — the uid that is EXACTLY the prefix, `ANDROID-CloudTAK-`, whose base is the empty string. It MUST stay total and MUST still yield exactly three candidates, which are then the literal strings ` (Web)` and ` (ETL)`. Do NOT special-case it down to one candidate: Property 18 requires exactly three for every prefixed uid, and diverging silently would make the code and the property disagree. What keeps this safe is the exact-equality rule — ` (Web)` can only reach a row whose `client_uid` is that exact string, which requires a certificate minted for an empty account identifier. Record that reasoning in a comment at the derivation site. If a reviewer decides the empty base must instead yield one candidate, requirements.md, design.md and Property 18 change FIRST — do not implement that reading off this task
    - TRAP 2 — a base that ALREADY ends in ` (Web)` or ` (ETL)` (e.g. `ANDROID-CloudTAK-ckadmin (ETL)`). Do NOT strip the existing suffix, do NOT collapse the duplicate away, and do NOT skip suffixing: the rule is a plain concatenation, so this yields `ckadmin (ETL) (Web)` and `ckadmin (ETL) (ETL)` — strings that match no row, which is the correct outcome for a uid shape upstream does not actually produce. Any cleverness here is a way for a candidate to land on a row it does not name
    - Document the DN_Shaped_Connection_Uid as KNOWN-UNHANDLED at the derivation site (Requirement 22.11): `MachineConnConfig` and `AdminConnConfig` return `ConnectionControl.uid(cert)` — the certificate subject reversed and comma-joined — and no uid of that shape appeared in the 48 live Client_Endpoints_API entries, which is why no candidate is generated for it. Recording it is the point: a future reader finding an unmatched DN-shaped uid should read it as accounted-for rather than as an oversight
    - Also record at the derivation site that this is a heuristic keyed on upstream string construction this project does not control, and that its failure mode is a CloudTAK Device's Last_Seen returning to null — the pre-fix "never seen" state — never a timestamp on a different Device (Requirement 22.9)
    - Nothing is persisted and no schema changes: no column, no migration, no derived key on a row (Requirement 22.13)
    - _Requirements: 22.1, 22.2, 22.3, 22.7, 22.9, 22.11, 22.13_
    - Files: `server/utils/connectionAlias.js`
  - [x] 30.2 Widen the poller's per-entry write to the Candidate_Client_Uids
    - In `server/services/SubscriptionPoller.js`, `recordLastSeen` takes the entry's Candidate_Client_Uids instead of a single `clientUid` and its `WHERE` clause becomes `WHERE client_uid = ANY($1::text[])`. Rename the parameter accordingly and update the JSDoc; the call site in `run()`'s loop passes `candidateClientUids(clientUid)`
    - **DO NOT DISTURB THE MONOTONIC_GUARD.** The clamp stays exactly where task 28.2 put it — in the `SET` list, governing `last_seen_at` alone — and the `connected` write stays OUTSIDE it, written unconditionally (Requirements 20.3, 22.4, 22.5). There is a large DO-NOT-MOVE comment block above this method explaining why: a Device connected right now is precisely the one whose `lastEventTime` does not advance, so a `connected` write riding on the guard's predicate would never fire for the Devices most likely to be connected. This task widens WHICH ROWS the statement may match and changes NOTHING about what it writes. If the clamp ends up back in the `WHERE` clause, task 28.2 has been silently undone
    - This is the single most important behaviour in the poller. Keep that comment block in place and extend it, in place, with the one-line reason the `WHERE` now takes an array
    - `rowCount` SEMANTICS CHANGE: the statement can now match MORE THAN ONE row, because a base may have both a `<base> (Web)` and a `<base> (ETL)` row and both legitimately receive the same Last_Seen and the same Connection_Status (Requirement 22.8 — the ambiguity is accepted, not resolved). Check every caller that assumed 0-or-1: `run()` does `counts.updated += result?.rowCount || 0`, which stays arithmetically correct but changes meaning to "Device_Table rows matched" rather than "reported uids matched". Correct its JSDoc description rather than leaving the old wording standing, and leave `observed`/`connected`/`disconnected` per-uid as they are
    - _Requirements: 22.4, 22.5, 22.8, 20.3_
    - Files: `server/services/SubscriptionPoller.js`
  - [x] 30.3 Feed the unreported sweep the union of every entry's candidates
    - In `server/services/SubscriptionPoller.js`, `clearUnreportedConnections` is currently called with `[...reportedByUid.keys()]`. It MUST instead receive `unionCandidateClientUids([...reportedByUid.keys()])` (Requirement 22.6)
    - **This is the load-bearing interaction and the reason the change is not local.** A CloudTAK row that 30.2 has just marked connected is, by construction, ABSENT from the raw reported uids — that absence is the whole defect. A sweep still keyed on those raw keys would set that row straight back to `connected = false` inside the same poll, and the fix would be invisible on the UI while every unit test of 30.2 passed. Do not treat this as a tidy-up
    - Keep Requirement 20.6's scoping discipline exactly as it is: `WHERE client_uid <> ALL($1::text[])`, parameterised by the excluded set, NEVER issued unrestricted by `client_uid`. The empty-reported-set reading is also unchanged — `<> ALL('{}')` is true of every row, which is the correct reading of a successful poll that reported nothing, not an unscoped write
    - Deduplicate the union (30.1's helper does this) so the parameter array is stable for a given payload and does not carry one copy per duplicate entry — TAK Server reports a client more than once, and a native-only payload must still produce the same array it produces today
    - Keep the failure log's field honest: the catch currently logs `reported: reportedByUid.size`, which is the reported-uid count, not the candidate count. Leave it meaning what it says or add the union size under its own distinct field name; do not quietly repurpose the existing one
    - _Requirements: 22.6, 20.6_
    - Files: `server/services/SubscriptionPoller.js`
  - [x] 30.4 Correct the false identifier-space claim in place
    - In `server/services/SubscriptionPoller.js`'s class header, the join is described as `ClientEndpoint.uid == tak_devices.client_uid` where "the two live in the same identifier space (verified live, e.g. `ANDROID-842f08e120efdbe3`)". That claim is FALSE: the cited verification sampled a native ATAK device, the one case where the two identifiers coincide by accident. Replace it with the true statement — the two spaces coincide for native clients and DIVERGE for CloudTAK, which is why the join takes the Connection_Alias's Candidate_Client_Uids (Requirement 22.10)
    - Correct it IN PLACE. Do not leave the false sentence standing with a second comment beside it — the same convention tasks 25.2 and 28.5 followed
    - Record the real provenance in the corrected passage, because it is what the alias is keyed on: the certificate `clientUid` gets its ` (ETL)` suffix from upstream `@tak-ps/node-tak` v12.24.0 (`lib/api/credentials.ts:82`, `CredentialCommands.generate()`) and its ` (Web)` suffix from the TAK-NZ fork ONLY (`api/stateless/lib/authentik-provider.ts:623`, a file absent upstream), while the connection uid is `ANDROID-CloudTAK-${email}` from upstream CloudTAK (`api/common/connection-config.ts:170`). Nothing in the reported uid records which of the two certificate paths was taken — which is exactly why both suffixes are generated
    - Point the reader at `server/utils/connectionAlias.js` for the derivation rather than restating the rules here, so there is one place they can drift from
    - _Requirements: 22.10_
    - Files: `server/services/SubscriptionPoller.js`
  - [x]* 30.5 Write unit tests for the derivation, the two statements, and the sweep regression
    - Assert the three live examples: `ANDROID-63040a40563b5fab` → exactly one candidate, that uid alone; `ANDROID-CloudTAK-chris@chriselsen.net` → exactly three, including `chris@chriselsen.net (Web)`; `ANDROID-CloudTAK-ckadmin` → exactly three, including `ckadmin (ETL)` (22.2, 22.3, 22.12)
    - Assert a MIXED-CASE prefix (e.g. `android-cloudtak-`, `ANDROID-cloudTAK-`) is recognised AND that the returned base preserves the original casing of the remainder — a test that only checks the candidate count would pass an implementation that lowercased the base and matched no row (22.2)
    - Assert the empty base (`ANDROID-CloudTAK-` exactly) returns three candidates and does not throw, and that a base already ending in ` (Web)`/` (ETL)` is neither stripped nor deduplicated nor single-suffixed (22.1, 22.2)
    - Assert the EXACT SQL and the EXACT parameter array handed to a mocked pool for both statements: `= ANY($1::text[])` with the ordered candidate array for the per-entry write, and `<> ALL($1::text[])` with the deduplicated union for the sweep. Assert no `LIKE`, no `%`, and no wildcard appears in either statement (22.4, 22.5, 22.6, 22.7)
    - Assert a native-only payload produces statements BEHAVIOURALLY IDENTICAL to before — one-element arrays holding the reported uids, and a sweep union equal to the raw reported set — so the native match is provably unchanged (22.2, 22.9)
    - **Regression test the load-bearing interaction:** a payload reporting `ANDROID-CloudTAK-chris@chriselsen.net` against a table holding `chris@chriselsen.net (Web)` must leave that row connected at the END of the poll. Assert the sweep's exclusion array CONTAINS `chris@chriselsen.net (Web)`, so an implementation that marks the row connected and then sweeps it back inside the same poll fails (22.6)
    - Assert the Monotonic_Guard is still in the `SET` list and NOT in the `WHERE` clause — a reported `lastEventTime` equal to the stored value still has its `connected` written, and `last_seen_at` does not move — so this change cannot silently undo task 28.2 (20.3)
    - Assert both a `<base> (Web)` and a `<base> (ETL)` row receive the same Last_Seen and the same Connection_Status from one reported entry (22.8)
    - Where the existing Property 17 test pins the sweep parameter to the RAW reported keys, update it to design.md's amended reading (the union of every entry's candidates). For a native-only payload the two readings are identical, which is why the property is amended rather than renumbered — do not renumber it and do not add a new property for it
    - _Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7, 22.8, 22.12, 20.3_
    - Files: `server/utils/connectionAlias.test.js`, `server/services/__tests__/SubscriptionPoller.test.js` (extend), `server/services/__tests__/SubscriptionPoller.connectionStatus.property.test.js` (extend)
  - [x]* 30.6 Write property test: the Connection_Alias is total, additive, exact, and reaches the unreported sweep
    - **Property 18: For all reported `ClientEndpoint.uid` values the derivation returns a value rather than raising and is a pure function of its input alone; the reported uid is a member of the returned Candidate_Client_Uids for EVERY input; a uid without the CloudTAK_Connection_Prefix (compared case-insensitively) yields EXACTLY ONE candidate, that uid alone, so no native Device's match is altered; a prefixed uid yields EXACTLY THREE — the reported uid, `<base> (Web)`, `<base> (ETL)`; every candidate is a complete `client_uid` used for equality matching, never a pattern and never standing in a proper-prefix or substring relationship to a row key in place of equality; and for all Client_Endpoints_API payloads, the reported set handed to the Criterion 20.6 unreported sweep contains every candidate of every reported entry, so no row an entry just marked connected can be swept back within the same poll**
    - Tag exactly: `// Feature: device-management, Property 18: The Connection_Alias is total, additive, exact, and reaches the unreported sweep`
    - fast-check, `numRuns >= 100`. Own file, `server/utils/connectionAlias.property.test.js` — beside `clientType.property.test.js`, which is where this feature's server property files for a pure util live (the one-property-one-file naming is unchanged)
    - Generators MUST include the three live examples, an empty base, the prefix in arbitrary MIXED case, a base already ending in ` (Web)`/` (ETL)`, a uid that is EXACTLY the prefix, the empty string, and `fc.anything()` for the totality arm so `null`, numbers, objects and arrays are covered. Arbitrary unprefixed strings must be drawn often enough that the exactly-one arm is genuinely exercised
    - Re-derive every expectation from the GENERATED input — the prefix test, the base slice, the two suffixed strings — never by calling back into the code under test. A test that computes its expectation with the function it is checking asserts only that the function is deterministic
    - Include the SWEEP-UNION arm: generate payloads mixing native and prefixed uids, run the poller against a mocked pool, and assert the sweep's exclusion array contains every candidate of every reported entry. This is the arm that catches the invisible-fix failure, so it must not be dropped for being the awkward one to set up
    - **Validates: Requirements 22.1, 22.2, 22.3, 22.6, 22.7, 22.9, 22.12**
    - Files: `server/utils/connectionAlias.property.test.js`
  - [x] 30.7 Checkpoint - verify the full build, then verify on the live system
    - Run `npm test` and confirm all server (jest) tests pass; run the client vitest suite and confirm it passes
    - Run `npm run lint` and confirm the problem count does NOT exceed the baseline of 107 problems (95 errors, 12 warnings)
    - Confirm all 18 properties are present and passing, Property 18 included
    - There is NO migration in this section and nothing to apply or roll back — the alias is computed at poll time and no derived key is persisted (Requirement 22.13). Stated explicitly so nobody goes looking for one
    - Then verify against the live system: restart the sync worker and confirm `chris@chriselsen.net (Web)` and `ckadmin (ETL)` acquire a non-null `last_seen_at`, expected to be roughly `2026-08-24 06:40` for both. `connected` is expected to stay FALSE for both and that is not a failure of this section: TAK Server currently reports zero connected clients (`clientEndPoints?showCurrentlyConnectedClients=true` returns an empty list and all 48 entries read `Disconnected`), and whether a CloudTAK browser session is a tracked client endpoint at all is UNVERIFIED
    - Confirm a native Device's `last_seen_at` is unchanged by the deploy — the alias is additive, so any movement there means a native match was altered and the implementation is wrong
    - Ensure all tests pass, ask the user if questions arise
    - _Requirements: 9.1, 9.6, 9.7, 22.13_

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "3.2", "4.1", "4.2", "5.2"] },
    { "id": 2, "tasks": ["3.3", "4.3", "7.1", "7.2", "7.3"] },
    { "id": 3, "tasks": ["3.4", "7.4", "8.1", "11.1"] },
    { "id": 4, "tasks": ["8.2", "9.1", "11.2", "12.1"] },
    { "id": 5, "tasks": ["8.3", "9.2", "12.2", "13.1", "15.1"] },
    { "id": 6, "tasks": ["13.2", "15.2", "15.3", "15.4"] },
    { "id": 7, "tasks": ["15.5", "16.1", "16.2", "16.3", "16.4", "16.5", "16.6", "16.7"] },
    { "id": 8, "tasks": ["18.1"] },
    { "id": 9, "tasks": ["18.2"] },
    { "id": 10, "tasks": ["19.1", "19.2", "24.1"] },
    { "id": 11, "tasks": ["24.2", "24.3"] },
    { "id": 12, "tasks": ["19.3", "19.4", "20.1", "22.1", "24.4"] },
    { "id": 13, "tasks": ["19.5", "19.6", "19.7", "20.2", "21.1", "22.2", "22.3", "24.5"] },
    { "id": 14, "tasks": ["20.3", "20.4", "21.2", "22.4", "22.5", "23.1"] },
    { "id": 15, "tasks": ["21.3", "22.6", "23.2"] },
    { "id": 16, "tasks": ["23.3", "23.4"] },
    { "id": 17, "tasks": ["25.1"] },
    { "id": 18, "tasks": ["25.2"] },
    { "id": 19, "tasks": ["25.3", "25.4"] },
    { "id": 20, "tasks": ["26.1", "26.2", "28.1", "29.2"] },
    { "id": 21, "tasks": ["26.3", "27.1", "28.2", "28.3"] },
    { "id": 22, "tasks": ["28.4", "29.1"] },
    { "id": 23, "tasks": ["28.5"] },
    { "id": 24, "tasks": ["29.3"] },
    { "id": 25, "tasks": ["26.4", "26.5", "28.8"] },
    { "id": 26, "tasks": ["27.2", "28.7"] },
    { "id": 27, "tasks": ["28.6"] },
    { "id": 28, "tasks": ["29.4", "29.5"] },
    { "id": 29, "tasks": ["30.1"] },
    { "id": 30, "tasks": ["30.2"] },
    { "id": 31, "tasks": ["30.3"] },
    { "id": 32, "tasks": ["30.4"] },
    { "id": 33, "tasks": ["30.5", "30.6"] }
  ]
}
```

Waves 29-33 are task 30's CloudTAK Connection_Alias. 30.1 creates `server/utils/connectionAlias.js` and must land first because the other three tasks call it. 30.2 (the per-entry `= ANY` widening), 30.3 (the sweep union) and 30.4 (the in-place header correction) all edit `server/services/SubscriptionPoller.js`, so each takes its own wave — the same-file rule that split 25.1 from 25.2 and 28.4/28.5 from 29.3. Their order is not arbitrary either: 30.3 is only meaningful once 30.2 has something to sweep back, and 30.4's corrected header describes the join 30.2 and 30.3 leave behind. The two test tasks share wave 33 — 30.5 extends the poller's unit and Property 17 files while 30.6 adds its own property file beside `clientType.property.test.js`, so they touch different files.

Waves 20-28 are the four presentation capabilities (tasks 26-29). Their wave boundaries are driven almost entirely by the same-file rule, plus two real dependencies:

- **`server/models/SiteConfig.js` + `.env.example`** are written by both 26.1 (`display_timezone`, `DISPLAY_TIMEZONE`) and 29.1 (`device_expiry_warning_days`, `DEVICE_MGMT_EXPIRY_WARNING_DAYS`), so those two never share a wave (20 and 22).
- **`client/src/components/DeviceListRow.jsx`** is written by 28.4 (the Connected_Label), 28.5 (the stale-comment correction) and 29.3 (the expiry markers), so all three are in separate waves (22, 23, 24) — the same reason 25.1 and 25.2 were split.
- **`client/src/pages/Dashboard.test.jsx` and `client/src/components/UserDevicesModal.test.jsx`** are extended by 27.2, 28.6 and 29.4, so those three are in separate waves (26, 27, 28).
- 28.1 (the `connected` migration) precedes 28.2 (the poller write) because the column has to exist first; 26.2 (the zoned formatters) precedes 26.3 (the startup install) because there is nothing to install into until `setDisplayTimezone` exists.

Waves 17-19 are task 25's stale-row deletion. 25.1 (the deletion step) and 25.2 (the comment corrections in `DeviceSync.js` and `syncWorker.js`) occupy separate waves because both edit `server/services/DeviceSync.js`; the two test tasks follow in wave 19, where 25.3 extends `DeviceSync.test.js` and 25.4 adds its own property-test file, so they touch different files and can run in parallel.

Wave 11 exists solely to put the revoke rails ahead of the branch that arms the `DELETE`: 24.1 (the `DEVICE_MGMT_REVOKE_ENABLED` flag module) lands with 19.1/19.2, 24.2 (the route gate) and 24.3 (the handler dry-run, single-`client_uid` abort, cap check and audit record) occupy their own wave, and 19.3/19.4 — the device-scoped resolution and enqueue — only follow in wave 12. Every 24.x task that gates the `DELETE` therefore precedes 19.3.
