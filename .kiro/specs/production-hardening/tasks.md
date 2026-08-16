# Implementation Plan: Production Hardening

## Overview

This plan converts `design.md`'s 26 component sections into incremental, dependency-ordered coding tasks. Work is sequenced in nine phases so that foundational infrastructure (migration tooling, Config_Validator, structured logger, Permission_Registry, Public_Route_Registry) lands before the features that depend on it, and so that every new database table or column is its own trackable task ahead of the service/route code that uses it.

Scope note: per `requirements.md`'s Introduction, this plan intentionally excludes AWS CDK/Terraform stacks, Secrets Manager wiring, VPC/networking, and ECS orchestration. Phase 8 (Requirement 19) is limited to the `Dockerfile` and `.dockerignore`; the ECS task definition / IaC snippet called for in Requirement 19 Criteria 5-6 is out of scope for this repo and is tracked separately.

Tasks marked with `*` are optional test sub-tasks and are not implemented as part of automated task execution unless explicitly requested.

## Tasks

### Phase 0: Foundational Infrastructure

- [x] 1. Adopt versioned migration tooling
  - [x] 1.1 Add `node-pg-migrate` as a dependency and configure it to read/write `database/migrations/`
    - _Requirements: 16.2_
  - [x] 1.2 Update `database/init.js` to run `node-pg-migrate up` instead of executing `schema.sql` directly
    - _Requirements: 16.2_
  - [x] 1.3 Generate a baseline migration capturing the current `schema.sql` state, and regenerate `database/schema.sql` as a `pg_dump --schema-only` snapshot (no longer hand-edited)
    - _Requirements: 16.2_

- [x] 2. Implement Config_Validator
  - [x] 2.1 Create `server/config/configValidator.js` exporting `validateConfig()`; check presence/non-empty (after trim) of the Requirement 15.1 variable list
    - _Requirements: 15.1, 15.2_
  - [x] 2.2 Add URL well-formedness checks for `AUTHENTIK_URL`/`APP_URL`/`FRONTEND_URL`, and `JWT_SECRET` length (>=32) / `JWT_EXPIRES_IN` duration (5min-30days) checks; log the specific invalid variable and exit non-zero on failure
    - _Requirements: 15.3, 15.4, 3.5, 3.6_
  - [x] 2.3* Write property test for URL well-formedness predicate (`isWellFormedUrl`)
    - **Property 8: URL well-formedness predicate**
    - **Validates: Requirements 15.3, 15.4**
  - [x] 2.4* Write property test for JWT expiry duration bounds (`isValidJwtExpiry`)
    - **Property 9: JWT expiry duration bounds**
    - **Validates: Requirements 3.6**
  - [x] 2.5 Call `validateConfig()` as the first statement in `server/index.js` and `server/workers/syncWorker.js`, before `app.listen()`/poll loop start
    - _Requirements: 15.2_

- [x] 3. Structured logging and request correlation
  - [x] 3.1 Create `server/config/logger.js`: a `pino` instance with JSON output, `LOG_LEVEL`-driven level (default `info`), and a `redact` list covering email/name/password/token-shaped fields
    - _Requirements: 13.1, 13.6_
  - [x] 3.2 Create `server/middleware/requestContext.js` using `AsyncLocalStorage` to stash a correlation ID (from `x-correlation-id` header or a fresh UUID) for the request lifetime, plus a `getLogger()` helper that returns a correlation-scoped child logger
    - _Requirements: 13.2, 13.3_
  - [x] 3.3* Write unit test asserting configured fields are redacted at `info` level and unredacted only at `debug`
    - _Requirements: 13.6_

- [x] 4. Permission_Registry skeleton
  - [x] 4.1 Create `server/config/permissions.registry.js` exporting `routes` (empty/seed map) and `roleDefaults` (`global_manager: ['*']`, `authenticated_user: [...]`)
    - _Requirements: 24.1, 24.2_
  - [x] 4.2 Implement the pure `resolveAccess(routeKey, userPermissions, registry)` function: no entry → deny; entry present → permit only if every required identifier is held
    - _Requirements: 24.3, 24.4_
  - [x] 4.3* Write property test for deny-by-default resolution
    - **Property 12: Permission Registry denies by default**
    - **Validates: Requirements 24.3, 24.4**

- [x] 5. Public_Route_Registry skeleton
  - [x] 5.1 Create `server/config/publicRoutes.js` with an initial array covering `GET /api/config/public`, `POST /api/requests/team-access`, `GET /api/requests/verify/:token`, `GET /health`
    - _Requirements: 33.1_
  - [x] 5.2 Create `server/middleware/publicRouteBootstrap.js` that matches incoming requests against the registry and calls `next()` directly on a match (not yet mounted globally)
    - _Requirements: 33.2_

- [x] 6. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 1: Auth & Authorization Hardening (Requirements 1-4, 24)

- [x] 7. Remove dead/duplicated auth code and hardcoded endpoints
  - [x] 7.1 Delete `server/routes/auth-backup.js`; port its `prompt=none` silent-auth flow into `server/routes/auth.js` as `GET /api/auth/silent` / `GET /api/auth/silent-callback`, reusing the existing 10000ms timeout, `code` validation, and error-redirect pattern
    - _Requirements: 1.1, 1.2, 1.3_
  - [x] 7.2 Remove every literal IP address/hardcoded hostname from server and client source files; source all environment-specific hosts from `APP_URL`/`FRONTEND_URL`/equivalent
    - _Requirements: 1.4, 1.5_
  - [x] 7.3* Write unit test for the ported silent-auth flow (timeout value, `code` validation, error-redirect behavior)
    - _Requirements: 1.3_

- [x] 8. Migration: `token_revocations` table
  - [x] 8.1 Write migration creating `token_revocations(jti PK, expires_at)`
    - _Requirements: 3.3_

- [x] 9. Cookie-based JWT delivery, revocation, and logout
  - [x] 9.1 In `server/routes/auth.js`, stop appending `?token=` to redirects; set `res.cookie('tak_session', jwt, { httpOnly, secure, sameSite: 'lax', maxAge })` on `GET /api/auth/callback` and `GET /api/auth/silent-callback`; add a `jti` claim via `crypto.randomUUID()` at sign time
    - _Requirements: 3.1, 3.2_
  - [x] 9.2 Update `server/middleware/auth.js` (`authenticateToken`) to read `req.cookies.tak_session` (via `cookie-parser`) and reject with 401 if the token's `jti` is present in `token_revocations`
    - _Requirements: 3.2, 3.3_
  - [x] 9.3 Implement `POST /api/auth/logout`: always clear the cookie and return success; insert a `token_revocations` row when a valid `jti` was present
    - _Requirements: 3.3, 3.4_
  - [x] 9.4* Write integration tests for `authenticateToken`: valid token, missing token, expired token, invalid signature, valid token referencing a user absent from cache
    - _Requirements: 12.4_

- [x] 10. Client de-hardcoding
  - [x] 10.1 Update `client/src/services/api.js` to build the backend base URL from `import.meta.env.VITE_API_BASE_URL` (default same-origin relative path), validated at module load with `new URL()` in a `try/catch`; drop `localStorage`/`Authorization`-header logic in favor of `withCredentials: true`
    - _Requirements: 2.1, 2.2, 2.3, 2.7, 2.8_
  - [x] 10.2 Update `client/vite.config.js` dev-server proxy target to read `VITE_DEV_PROXY_TARGET` via `loadEnv`, defaulting to `http://localhost:3000`
    - _Requirements: 2.4_
  - [x] 10.3 Update the silent-login popup's `postMessage` origin check to compare against the configured base URL's origin, and add a 5-second timeout that closes the popup and falls back to interactive login
    - _Requirements: 2.5, 2.6_
  - [x] 10.4* Write unit tests for base-URL validation success/failure paths (Criteria 2.7/2.8)
    - _Requirements: 2.7, 2.8_

- [x] 11. Authorization_Middleware implementation
  - [x] 11.1 Create `server/middleware/authorize.js`: look up `` `${method} ${req.route.path}` `` in the Permission_Registry after `authenticateToken` runs
    - _Requirements: 24.3, 24.4_
  - [x] 11.2 Implement per-permission resolver functions for row-scoped checks (e.g. `team:update` passing when `Team.isAdmin(teamId, userId)` or global manager), covering sub-team creation (parent-admin OR global manager) and top-level team creation (global-manager-only)
    - _Requirements: 4.1, 4.5_
  - [x] 11.3 Make resolver exceptions fail closed: catch any thrown error, log `{actorId, resourceId, errorCategory: 'authorization_check_exception'}` (distinct from `'db_connectivity'`), and treat as denied
    - _Requirements: 4.3, 4.6_
  - [x] 11.4* Write unit tests for fail-closed behavior when a resolver throws
    - _Requirements: 4.3, 4.6_

- [x] 12. Populate Permission_Registry entries and remove scattered inline checks
  - [x] 12.1 Enumerate every route+method mounted in `server/index.js` into `permissions.registry.js`, including the Global_Manager-only entries for `/api/global-channels/bch`, `/api/global-channels/region`, the BCH credential route, and the channel-deletion route
    - _Requirements: 24.1, 24.5, 4.4_
  - [x] 12.2 Remove the `TODO` placeholder and other scattered inline `is_global_manager`/`Team.isAdmin` checks from `server/routes/teams.js`, `users.js`, and `globalChannels.js`, relying on `authorize.js` instead
    - _Requirements: 4.2_
  - [x] 12.3 Mount `authorize.js` in `server/index.js` immediately after `authenticateToken`
    - _Requirements: 24.3_
  - [x] 12.4* Write a Jest completeness test walking `app._router.stack` and asserting every mounted `{method, path}` has a registry entry
    - _Requirements: 24.6, 24.7_

- [x] 13. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 2: Input Validation, Secrets, Rate Limiting, Process Resilience (Requirements 5-8)

- [x] 14. Dynamic SQL identifier allow-list
  - [x] 14.1 In `GlobalChannelService.deleteGlobalChannel`, replace `` `DELETE FROM ${table}` `` interpolation with a lookup against a frozen `{ bch: 'bch_channels', region: 'region_channels' }` allow-list; reject with an error before querying if the value isn't present
    - _Requirements: 5.1, 5.2, 5.3_
  - [x] 14.2* Write unit test asserting a non-allow-listed table identifier is rejected without executing a query
    - _Requirements: 5.3_

- [x] 15. HTML sanitization
  - [x] 15.1 Create `server/config/htmlSafeSubset.js` (allowed tags/attributes) and run `SiteConfig.update`'s `config_value` through `sanitize-html` with that allow-list before persisting
    - _Requirements: 5.4, 5.5, 5.6_
  - [x] 15.2 Add client-side DOMPurify sanitization (defense in depth) around the `dangerouslySetInnerHTML` usage for `request_access_footer`
    - _Requirements: 5.6_
  - [x] 15.3* Write property test for HTML sanitization
    - **Property 10: HTML sanitization excludes the disallowed subset**
    - **Validates: Requirements 5.4, 5.5, 5.6**

- [x] 16. Consistent field sanitization
  - [x] 16.1 Create `server/middleware/validators.js` exporting `textField(maxLen = 1000)` = `body(field).trim().escape().isLength({max: maxLen})`
    - _Requirements: 5.7_
  - [x] 16.2 Apply the shared validator chain to `POST /api/requests/team-access` and other user-supplied/publicly-submitted fields
    - _Requirements: 5.7, 5.8_
  - [x] 16.3* Write unit test for max-length/escape rejection returning the invalid field name(s)
    - _Requirements: 5.8_

- [x] 17. Credential encryption for BCH service accounts
  - [x] 17.1 Create `server/services/CredentialEncryptionService.js` (AES-256-GCM via `crypto.createCipheriv`), keyed from `CREDENTIAL_ENCRYPTION_KEY`
    - _Requirements: 6.1_
  - [x] 17.2 Wire `encrypt()` into `GlobalChannelService.createBchChannel` before insert, and `decrypt()` into `GET /api/global-channels/bch/:channelId/credentials` only at response-build time, logging the access as an auditable event
    - _Requirements: 6.1, 6.2_
  - [x] 17.3* Write unit tests for encrypt/decrypt round trip and the generic-error decrypt-failure path (no ciphertext/internal error leaked)
    - _Requirements: 6.3_

- [x] 18. Secrets manager gate for production
  - [x] 18.1 Create `server/config/secretsProvider.js` with `EnvSecretsProvider` and `AwsSecretsManagerProvider` (via `@aws-sdk/client-secrets-manager`) implementations of a common interface
    - _Requirements: 6.4_
  - [x] 18.2 In `Config_Validator`, when `NODE_ENV=production`, resolve `AUTHENTIK_ADMIN_TOKEN`, `JWT_SECRET`, `DB_PASSWORD`, and AWS credentials through the configured provider; exit non-zero if unreachable or a secret is missing
    - _Requirements: 6.4_
  - [x] 18.3* Write unit test for provider-unreachable startup failure
    - _Requirements: 6.4_

- [x] 19. AWS SDK v3 migration and dependency cleanup
  - [x] 19.1 Replace `EmailService.js`'s `aws-sdk`/`@aws-sdk/client-ses` (`AWS.SES`) usage with a generic SMTP transport (`nodemailer`, configured via `EMAIL_HOST`/`EMAIL_PORT`/`EMAIL_USERNAME`/`EMAIL_PASSWORD`/`EMAIL_USE_TLS`/`EMAIL_USE_SSL`/`EMAIL_TIMEOUT`/`EMAIL_FROM`), not tied to AWS SES specifically
    - _Requirements: 6.5_
  - [x] 19.2 Remove `aws-sdk`/`@aws-sdk/client-ses` from `package.json`; add `nodemailer`
    - _Requirements: 6.5_

- [x] 20. `.env.example` accuracy
  - [x] 20.1 Remove the unused `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` block (and the superseded AWS SES-specific `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`/`SES_FROM_EMAIL` block); document every variable actually read (`EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`, `EMAIL_USE_TLS`, `EMAIL_USE_SSL`, `EMAIL_TIMEOUT`, `EMAIL_FROM`, `CREDENTIAL_ENCRYPTION_KEY`, `SECRETS_PROVIDER`, etc.)
    - _Requirements: 6.6_

- [x] 21. Migration: `email_rate_tracking` table
  - [x] 21.1 Write migration creating `email_rate_tracking(email, window_start, count)`
    - _Requirements: 7.2_

- [x] 22. Endpoint-appropriate rate limiting and CAPTCHA
  - [x] 22.1 Add `authLimiter` (20/15min) on `/api/auth/*` and a separate `authCallbackFailureLimiter` (10 failed attempts/15min, incremented in the callback's `catch`) on `GET /api/auth/callback`
    - _Requirements: 7.1, 7.5, 7.6_
  - [x] 22.2 Add `requestAccessLimiter` (20/15min per IP, 5/60min per email via `email_rate_tracking`) on `POST /api/requests/team-access` and `GET /api/requests/verify/:token`
    - _Requirements: 7.1, 7.2_
  - [x] 22.3 Add a Google reCAPTCHA v3 verification middleware in front of `POST /api/requests/team-access`'s handler; reject with an error before any row insert or email send on missing/invalid token, action mismatch, or below-threshold score
    - _Requirements: 7.3, 7.4_
  - [x] 22.4* Write integration tests: HTTP 429 on exceeded IP/email limits, HTTP 400 on missing/invalid CAPTCHA, and no side effects (no row insert, no email) in either case
    - _Requirements: 7.2, 7.4_

- [x] 23. Process-level resilience
  - [x] 23.1 Register `process.on('unhandledRejection', ...)` and `process.on('uncaughtException', ...)` in `server/index.js`, logging via the structured logger; implement `gracefulShutdown()` (stop accepting connections, 30s grace period, close DB pool, exit) triggered by `uncaughtException`, `SIGTERM`, and `SIGINT`
    - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - [x] 23.2 Add `pool.on('error', ...)` to `server/config/database.js` and an explicit `max: parseInt(process.env.DB_POOL_MAX) || 20`
    - _Requirements: 8.5, 8.6_
  - [x] 23.3 Replace the fire-and-forget `authentikSync.syncUsers().catch(console.error)` (and any other unlogged fire-and-forget call) with `.catch(err => logger.error({err}, ...))`
    - _Requirements: 8.7_
  - [x] 23.4* Write integration test for graceful shutdown: in-flight requests completing within 30s, and forced closure when they don't
    - _Requirements: 8.4_

- [x] 24. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 3: Sync Worker Reliability & Throughput (Requirements 9-11)

- [x] 25. Migration: `sync_operations` columns and retry default
  - [x] 25.1 Write migration adding `correlation_id uuid` and `failure_category text` columns to `sync_operations`, and changing the `max_retries` column default from 100 to 48 (with a backfill statement for existing pending rows still at 100 that haven't exceeded it)
    - _Requirements: 9.2, 13.4_

- [x] 26. Bounded exponential backoff
  - [x] 26.1 Implement `computeBackoffDelay(retryCount)` = `Math.min(Math.pow(2, retryCount) * 60000, 3_600_000)` and use it in `handleOperationError`
    - _Requirements: 9.1_
  - [x] 26.2* Write property test for bounded backoff
    - **Property 1: Bounded retry backoff**
    - **Validates: Requirements 9.1, 9.2**
  - [x] 26.3 Enforce `max_retries = 48` as the effective cap in `handleOperationError`'s scheduling logic
    - _Requirements: 9.2_

- [x] 27. Payload validation before dispatch
  - [x] 27.1 Create `server/workers/operationSchemas.js` with a required-field/type map per `operation_type`
    - _Requirements: 9.3_
  - [x] 27.2 In `executeOperation`, validate the payload against its schema before dispatch; on failure call `markPermanentlyFailed(operation, {reason: 'payload_validation'})`, setting `failure_category='validation'` without incrementing `retry_count` or setting `next_retry_at`
    - _Requirements: 9.3, 9.4_
  - [x] 27.3* Write property test for payload validation gating retries
    - **Property 3: Payload validation failures never schedule a retry**
    - **Validates: Requirements 9.3, 9.4**

- [x] 28. Retryable vs. permanent failure classification
  - [x] 28.1 Implement `classifyFailure(statusOrError)`: 5xx or network/timeout → retryable; 4xx → permanent
    - _Requirements: 9.6_
  - [x] 28.2 Wire the classification into each Authentik-calling handler (`addUserToGroup`, `createBchChannelGroups`, etc.); retryable failures continue through `handleOperationError`, permanent failures call `markPermanentlyFailed({reason: 'authentik_client_error', failure_category: 'permanent'})`
    - _Requirements: 9.6_
  - [x] 28.3* Write property test for classification boundaries
    - **Property 2: Retryable vs. permanent failure classification**
    - **Validates: Requirements 9.6**

- [x] 29. Remove verbose payload logging
  - [x] 29.1 Delete raw-payload/attribute-value `console.log` calls in `executeOperation` and its handlers; emit a structured `debug`-level line with `{operationId, operationType, correlationId}` only (no payload body) at `info`
    - _Requirements: 9.5, 13.6_

- [x] 30. Concurrent batch processing
  - [x] 30.1 Replace the single-row `LIMIT 1` fetch with a configurable `LIMIT $1` (`SYNC_WORKER_BATCH_SIZE`, 10-500, default 50) using `FOR UPDATE SKIP LOCKED`
    - _Requirements: 10.1_
  - [x] 30.2 Implement `groupByEntityKey(operations)` (keyed by `target_user_id:target_group_id`, falling back to operation id) and route each batch through a `p-limit(SYNC_WORKER_CONCURRENCY)` (1-100, default 10) worker pool, keeping same-key operations on one lane
    - _Requirements: 10.2, 10.3, 10.5_
  - [x] 30.3* Write property test for same-entity ordering
    - **Property 4: Same-entity operations stay ordered within a batch**
    - **Validates: Requirements 10.5**
  - [x] 30.4* Write integration test starting two `SyncWorker` instances against one seeded queue, asserting each row's terminal-status transition fires exactly once
    - _Requirements: 10.4_

- [x] 31. Sync cost reduction
  - [x] 31.1 Hoist the Authentik group-list fetch in `AuthentikSyncService.syncUsers` to once per run (passed into `processBatch` as a parameter)
    - _Requirements: 11.1_
  - [x] 31.2 Replace `processBatch`'s serial `for` loop with bounded concurrency via `p-limit(AUTHENTIK_SYNC_CONCURRENCY)` (default 5, 1-20)
    - _Requirements: 11.2_
  - [x] 31.3 Replace `GET /api/users`'s per-user recursive-CTE team-name lookup with one batched join query (or pre-joined view), independent of returned row count
    - _Requirements: 11.3_
  - [x] 31.4 Implement a shared `paginationParams` middleware validating `page`/`pageSize` (default 50, max 200)
    - _Requirements: 11.4, 11.5_
  - [x] 31.5* Write property test for pagination validation
    - **Property 5: Pagination parameter validation**
    - **Validates: Requirements 11.4, 11.5**
  - [x] 31.6 Apply `paginationParams` to `GET /api/users` and `GET /api/teams/my-teams` (admin "all teams" case)
    - _Requirements: 11.4_
  - [x] 31.7 Add an early return in `syncUsers` so a failed initial group-list fetch aborts before any `user_cache` write, leaving status `'error'` for retry on the next scheduled interval
    - _Requirements: 11.6_
  - [x] 31.8* Write unit test asserting no partial `user_cache` writes occur when the group-list fetch throws
    - _Requirements: 11.6_

- [x] 32. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 4: Observability, Health Checks, Schema Integrity, Transactions (Requirements 13, 14, 16, 17)

- [x] 33. Complete structured logging rollout
  - [x] 33.1 Replace all remaining `console.log`/`console.error` calls in `server/` and `server/workers/syncWorker.js` with `logger.*` calls
    - _Requirements: 13.1, 13.8_
  - [x] 33.2 Persist the active correlation ID onto enqueued `sync_operations` rows (`EventPublisher.publishOperation`); include `operationId`, `operationType`, and `correlation_id` on every Sync_Worker log line for that operation
    - _Requirements: 13.4, 13.5_
  - [x] 33.3 Add a 401/403 logging branch in `authenticateToken`/`authorize.js` recording `{ip, route, reason}`
    - _Requirements: 13.7_
  - [x] 33.4 Add an ESLint `no-console` rule to the CI lint config
    - _Requirements: 13.8_
  - [x] 33.5* Write unit test for redaction behavior and end-to-end correlation-id propagation from request to enqueued Sync_Operation to Sync_Worker log line
    - _Requirements: 13.3, 13.4, 13.5, 13.6_

- [x] 34. Health and readiness endpoints
  - [x] 34.1 Create `server/routes/health.js` with `GET /health`: `SELECT 1` with a 2s timeout; 200 `{status:'healthy'}` or 503 `{status:'unhealthy', reason}`
    - _Requirements: 14.1, 14.2_
  - [x] 34.2 Add `GET /health/ready`: DB check and Authentik reachability check, each with a 3s timeout; 200 `{status:'ready'}` only if both succeed, else 503 `{status:'not_ready', reason}`
    - _Requirements: 14.3, 14.4_
  - [x] 34.3 Add `GET /health/live`: always 200 if the process can respond, no dependency checks
    - _Requirements: 14.5_
  - [x] 34.4 Add a `sync_worker_heartbeat` migration (single-row upsert table) and update it every poll cycle in the Sync_Worker; expose a lightweight `http.createServer` health endpoint on `SYNC_WORKER_HEALTH_PORT` returning 503 if the heartbeat is older than 90s
    - _Requirements: 14.6_
  - [x] 34.5* Write integration tests for all four health endpoints against a real test DB and a mocked-unreachable DB
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

- [x] 35. Schema and code drift remediation
  - [x] 35.1 Write migration renaming `user_cache.takRole/takColor/takCallsign` to `tak_role/tak_color/tak_callsign`
    - _Requirements: 16.1_
  - [x] 35.2 Delete the `try/catch` "fallback for old column names" blocks in `server/routes/users.js` and `server/services/userAttributes.js`
    - _Requirements: 16.1_
  - [x] 35.3 Write migration replacing `team_memberships`' unconditional `UNIQUE(user_id)` with a partial unique index (`user_id WHERE inherited_from_team_id IS NULL`) plus `UNIQUE(user_id, team_id)` for inherited rows
    - _Requirements: 16.4_
  - [x] 35.4 Write migration replacing the `DROP TABLE IF EXISTS access_requests`/`CREATE TABLE` sequence with non-destructive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements
    - _Requirements: 16.3_
  - [x] 35.5* Write a schema-consistency test running the migration chain against a throwaway database and cross-referencing every SQL identifier found in `server/` against `information_schema`
    - _Requirements: 16.5_
  - [x] 35.6 Enforce the 3-channel-per-team limit via a `SERIALIZABLE` transaction re-validating the count immediately before `INSERT` in `Channel.createCustomChannel`, used uniformly regardless of whether a race actually occurs
    - _Requirements: 16.6_
  - [x] 35.7* Write integration test with concurrent channel-creation attempts against a team already at its limit, asserting exactly one succeeds
    - _Requirements: 16.6_

- [x] 36. Transactional multi-step operations
  - [x] 36.1 Refactor `POST /api/users/create-and-add` into `UserProvisioningService.createAndAddUser(client, {...})`: Authentik user creation happens before `BEGIN`; all local writes (users upsert, team_memberships incl. inheritance, channel_memberships) run inside one transaction on one acquired client
    - _Requirements: 17.1_
  - [x] 36.2 Add compensating-action logic: on post-Authentik-creation DB failure, attempt a synchronous Authentik user delete; on that failure, enqueue a `cleanup_orphaned_authentik_user` Sync_Operation instead; log `{authentikUserId, failedStep, compensationOutcome}` in both cases
    - _Requirements: 17.2_
  - [x] 36.3 Rewrite `Team.delete` as a single transaction (`channel_memberships` → `channels` → `team_memberships` → `teams`); on commit, enqueue one `remove_team_channel_group` Sync_Operation per deleted channel
    - _Requirements: 17.3, 17.4_
  - [x] 36.4 Add an optional `client` parameter to `EventPublisher.publishOperation`; update `TeamMembershipService.addUserToTeam`/`removeUserFromTeam` to pass their open transactional client through so the `sync_operations` insert commits/rolls back atomically with the membership change
    - _Requirements: 17.5_
  - [x] 36.5* Write property test for team membership add/remove round trip
    - **Property 15: Team membership add/remove is a round trip**
    - **Validates: Requirements 12.2, 17.5**
  - [x] 36.6* Write integration tests for transaction rollback on partial failure in `create-and-add` and `Team.delete`, and for compensating-action logging
    - _Requirements: 17.1, 17.2, 17.3_

- [x] 37. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 5: Completing Existing Features (Requirements 18, 21, 22, 23)

- [x] 38. Access Request Approval workflow completion
  - [x] 38.1 Extract shared `UserProvisioningService.createAndAddUser` (from task 36.1) for reuse by the approval path
    - _Requirements: 18.1_
  - [x] 38.2 Implement `RequestApprovalService.processApprovedRequest`'s `team_change` branch via `TeamMembershipService.addUserToTeam`, using the transaction already open in `approveRequest`
    - _Requirements: 18.2_
  - [x] 38.3 Implement the `role_change` branch (`UPDATE team_memberships SET role = ... WHERE user_id = ... AND team_id = ... AND inherited_from_team_id IS NULL`)
    - _Requirements: 18.3_
  - [x] 38.4 Implement the `name_change` branch (Authentik name update, `user_cache`/`users` update, `UserAttributesService.generateCallsign` regeneration)
    - _Requirements: 18.4_
  - [x] 38.5 Validate `existing_user_id`/`target_team_id` references before flipping status to `approved`; ensure any later failure in a type-specific branch rolls back the status change too
    - _Requirements: 18.5, 18.6, 18.7_
  - [x] 38.6* Write unit tests for each request type (`new_account`, `team_change`, `role_change`, `name_change`) and a missing-reference case
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5_
  - [x] 38.7* Write integration tests for approve/deny success and already-processed-request rejection
    - _Requirements: 12.5_

- [x] 39. Migration: vendor channel tables
  - [x] 39.1 Write migration adding `users.is_vendor boolean default false`
    - _Requirements: 21.1_
  - [x] 39.2 Write migration creating `vendor_channels` (with a partial unique index enforcing at most one `is_active=true` row)
    - _Requirements: 21.10, 21.11_
  - [x] 39.3 Write migration creating `vendor_channel_grants`
    - _Requirements: 21.3_

- [x] 40. VendorChannelService and routes
  - [x] 40.1 Implement `createVendorChannel(createdBy)`: transactional insert + enqueue `create_vendor_channel_group`, rejecting if an active row already exists
    - _Requirements: 21.10, 21.11_
  - [x] 40.2 Implement `setVendorFlag(targetUserId, isVendor, actingUserId)`: require an active `vendor_channels` row before setting `true`; enqueue `add_user_to_group` for `VND` only
    - _Requirements: 21.1, 21.2, 21.12_
  - [x] 40.3 Implement `createGrant`/`revokeGrant`: validate `is_vendor` first, insert/update `vendor_channel_grants`, enqueue the matching group Sync_Operation, write an `audit_logs` row
    - _Requirements: 21.3, 21.4, 21.5, 21.8, 21.9_
  - [x] 40.4 Implement `expireGrants()`: update expired unrevoked grants with `revoked_by` set to a system sentinel, enqueue `remove_user_from_group` per row, write matching `audit_logs` rows
    - _Requirements: 21.6, 21.7_
  - [x] 40.5 Create `server/routes/vendorChannels.js` and add its Permission_Registry entries (Global_Manager-only)
    - _Requirements: 21.1, 21.4, 21.5_
  - [x] 40.6* Write unit tests: non-vendor-user grant rejection, no-active-channel flag-set rejection, singleton-creation rejection
    - _Requirements: 21.8, 21.11, 21.12_

- [x] 41. Migration: `deployment_channels` table
  - [x] 41.1 Write migration creating `deployment_channels` (`name`, `description`, `deployment_end_date` nullable, `authentik_group_id`, `is_active`, `requested_by`, `created_at`)
    - _Requirements: 22.1_

- [x] 42. DeploymentChannelService and routes
  - [x] 42.1 Implement `createDeploymentChannel`: validate `name` against the `Overseas - ` prefix or `[COUNTRY]-[FUNCTION]-[REGION]-[SUFFIX]` regex; require `deployment_end_date` for the domestic pattern; transactional insert + enqueue `create_deployment_channel_group`
    - _Requirements: 22.4, 22.5, 22.11, 22.13_
  - [x] 42.2 Implement `subscribe`/`unsubscribe` self-service methods available to any authenticated user; `subscribe` checks `is_active` first
    - _Requirements: 22.6, 22.7, 22.10, 22.12_
  - [x] 42.3 Implement `deactivateExpired()`: deactivate rows past `deployment_end_date`, delete their `channel_memberships`, enqueue `remove_all_members_from_group`; never applied when `deployment_end_date` is null
    - _Requirements: 22.2, 22.8, 22.9, 22.12_
  - [x] 42.4 Create `server/routes/deploymentChannels.js` with Permission_Registry entries (creation: Global_Manager; subscribe/unsubscribe: `roleDefaults.authenticated_user`)
    - _Requirements: 22.3, 22.6, 22.7_
  - [x] 42.5* Write unit tests: naming-format rejection, domestic-without-end-date rejection, inactive-channel subscribe rejection
    - _Requirements: 22.5, 22.10, 22.13_

- [x] 43. Shared ExpiryScheduler for vendor grants and deployment channels
  - [x] 43.1 Implement `server/services/ExpiryScheduler.js` running inside the Sync_Worker on a <=15-minute interval, invoking `VendorChannelService.expireGrants()` and `DeploymentChannelService.deactivateExpired()`
    - _Requirements: 21.6, 22.8_
  - [x] 43.2* Write property test for time-bounded expiry deactivation
    - **Property 11: Time-bounded access records deactivate exactly once past expiry**
    - **Validates: Requirements 21.6, 21.7, 22.8, 22.9**

- [x] 44. Migration: `channel_requests` table
  - [x] 44.1 Write migration creating `channel_requests` (`team_id`, `custom_suffix`, `member_permissions` jsonb, `requested_by`, `status`, `processed_by`, `processed_at`, `denial_reason`)
    - _Requirements: 23.1_

- [x] 45. Channel Creation Approval Workflow
  - [x] 45.1 Implement `ChannelRequestService.requestChannel`: Global_Manager path delegates immediately to `Channel.createCustomChannel`; non-Global_Manager path inserts a `pending` `channel_requests` row with no Authentik enqueue
    - _Requirements: 23.2, 23.3, 23.9_
  - [x] 45.2 Implement `approveChannelRequest`: single transaction re-checking `status==='pending'`, setting `approved`/`processed_by`/`processed_at`, calling `Channel.createCustomChannel`, rolling back entirely (leaving `pending`) on failure
    - _Requirements: 23.4, 23.5, 23.6, 23.8_
  - [x] 45.3 Implement `denyChannelRequest`: status update to `denied` with `denial_reason`
    - _Requirements: 23.7_
  - [x] 45.4 Create `server/routes/channelRequests.js` with authorization (Global_Manager or admin of the parent team) and Permission_Registry entries
    - _Requirements: 23.4_
  - [x] 45.5* Write unit tests: Global_Manager immediate creation, non-admin pending creation, already-processed-request rejection
    - _Requirements: 23.2, 23.3, 23.8_
  - [x] 45.6* Write integration test for approval-transaction rollback leaving the request `pending` and retryable
    - _Requirements: 23.6_

- [x] 46. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 6: New Feature Areas (Requirements 25-33)

- [x] 47. Retention Cleanup Job
  - [x] 47.1 Create `server/services/RetentionCleanupJob.js` running on its own scheduled interval (default 24h) inside the Sync_Worker process, executing the `sync_operations` and `audit_logs` DELETE statements from the design
    - _Requirements: 25.1, 25.3, 25.4, 25.5, 25.7_
  - [x] 47.2 Add `SYNC_OPERATIONS_RETENTION_DAYS` (default 90) and `AUDIT_LOGS_RETENTION_DAYS` (default 365) to Config_Validator, requiring the audit threshold to exceed the sync-operations threshold
    - _Requirements: 25.1, 25.4_
  - [x] 47.3 Wrap each scheduled run in a `try/catch` that logs via the structured logger without crashing the Sync_Worker, retrying on the next scheduled run
    - _Requirements: 25.6_
  - [x] 47.4* Write unit test asserting `pending`/`retrying` rows are excluded from deletion regardless of age
    - _Requirements: 25.2_

- [x] 48. TAK Server certificate lifecycle integration
  - [x] 48.1 Add TAK Server mTLS credential checks to Config_Validator, required only when `TAK_SERVER_URL` is set
    - _Requirements: 26.1, 26.2_
  - [x] 48.2 Write migration extending `sync_operations.operation_type` to support `revoke_tak_certificates`
    - _Requirements: 26.6_
  - [x] 48.3 Create `server/services/TakServerService.js`: `listCertificates()`, `findCertificatesForUser(takUsername)` (matches `creatorDn`), `revokeCertificates(certIds)` with a post-revoke re-query verifying every id is confirmed revoked before reporting success
    - _Requirements: 26.3, 26.4, 26.5_
  - [x] 48.4 Enqueue `revoke_tak_certificates` from: an explicit revoke action (Global_Manager or `Team.isAdmin`), `TeamMembershipService.removeUserFromTeam`'s existing no-teams-left branch, and team disable/delete (single bulk batch fetching the certificate catalog once)
    - _Requirements: 26.6, 26.7_
  - [x] 48.5 Implement the Sync_Worker handler for `revoke_tak_certificates`, classifying TAK Server unreachable/error responses as retryable via the existing classification mechanism
    - _Requirements: 26.8_
  - [x] 48.6* Write unit tests for the revoke-success-verified and revoke-partial-failure-unverified paths
    - _Requirements: 26.4, 26.5_

- [x] 49. Team-Owned Device Enrollment
  - [x] 49.1 Write migration adding `is_team_device boolean default false` and `device_label text` to `users`/`user_cache`
    - _Requirements: 27.1_
  - [x] 49.2 Implement `DeviceEnrollmentService.createDevice(teamId, label, actingUser)`: authorize via `Team.isAdmin OR is_global_manager`; create the Authentik user with a synthetic `devices.tak.nz.invalid` email via the non-verification-triggering create path; call `TeamMembershipService.addUserToTeam`
    - _Requirements: 27.2, 27.3, 27.4_
  - [x] 49.3 Implement `generateEnrollmentQrCode(deviceUserId, actingUser)`: repeat the authorization check; create an Authentik `app_password` token capped at 30 minutes; return the `tak://com.atakmap.app/enroll?...` URI and equivalent iTAK JSON payload
    - _Requirements: 27.3, 27.5, 27.6, 27.7_
  - [x] 49.4 Create `server/routes/devices.js` with Permission_Registry entries restricted to team admin or Global_Manager
    - _Requirements: 27.3_
  - [x] 49.5 Exclude `is_team_device = true` rows from `GET /api/users` and all dashboard/user-count queries; log every QR-code generation as an `audit_logs` event
    - _Requirements: 27.8, 27.9_
  - [x] 49.6* Write unit tests: unauthorized creation/QR-generation rejection, exclusion from user counts, audit log entries recorded
    - _Requirements: 27.3, 27.8, 27.9_

- [x] 50. MOU/Document Management
  - [x] 50.1 Write migration creating `mou_documents` and `mou_signatures`
    - _Requirements: 28.1, 28.2_
  - [x] 50.2 Implement `MouService.createDocument`/`updateDocument`/`setAsCurrentAgreement` (Global_Manager-only)
    - _Requirements: 28.3_
  - [x] 50.3 Implement `recordSignature` (team admin for team-scoped documents, Global_Manager for any) and `recordCountersignature` (Global_Manager-only, meaningful only when `requires_countersignature=true`)
    - _Requirements: 28.4, 28.5_
  - [x] 50.4 Implement `requireCurrentAgreement` middleware: block every request except the signature-submission endpoint and logout when a current agreement exists and the user lacks a signature for that exact version
    - _Requirements: 28.6, 28.7_
  - [x] 50.5 Create `server/routes/mou.js` with Permission_Registry entries
    - _Requirements: 28.3, 28.4, 28.5_
  - [x] 50.6* Write unit test for the countersignature-required document remaining incomplete until countersigned
    - _Requirements: 28.5_
  - [x] 50.7* Write integration test for the login-time gate (blocks unsigned users, allows signed users, re-triggers on version supersession)
    - _Requirements: 28.6, 28.7_

- [x] 51. CSV Bulk Import
  - [x] 51.1 Implement `BulkImportService.importUsers`: per-row authorization (`Team.isAdmin OR is_global_manager`), per-row transaction reusing `UserProvisioningService.createAndAddUser`, continuing on a row's failure
    - _Requirements: 29.2, 29.3, 29.4_
  - [x] 51.2 Implement `BulkImportService.importTeams` (Global_Manager-only), resolving `parentTeamName`/`parentTeamId` per row
    - _Requirements: 29.5_
  - [x] 51.3 Add `public/templates/user-import-template.csv` and `team-import-template.csv` documenting required/optional columns
    - _Requirements: 29.1_
  - [x] 51.4 Create `server/routes/bulkImport.js` with Permission_Registry entries
    - _Requirements: 29.3, 29.5_
  - [x] 51.5* Write property test for CSV row isolation
    - **Property 14: CSV batch row processing is isolated**
    - **Validates: Requirements 29.2, 29.6**
  - [x] 51.6* Write integration test asserting a per-row result summary (success/failure independent of batch composition or ordering)
    - _Requirements: 29.6_

- [x] 52. Broadcast Email and Template Management
  - [x] 52.1 Implement `BroadcastEmailService.send(filter, actingUser)`: fail-closed authorization scoping for team admins (resolve administered teams, reject on any out-of-scope recipient or on a resolution error)
    - _Requirements: 30.1, 30.2, 30.3_
  - [x] 52.2 Implement `GET`/`PUT /api/communications/templates/:key` (Global_Manager-only) against `email_templates`
    - _Requirements: 30.4_
  - [x] 52.3 Implement `POST /api/communications/test-email` (Global_Manager-only)
    - _Requirements: 30.5_
  - [x] 52.4 Create `server/routes/communications.js` with Permission_Registry entries
    - _Requirements: 30.1, 30.4, 30.5_
  - [x] 52.5* Write unit tests: team-admin-outside-scope rejection, authorization-check-throws fail-closed rejection
    - _Requirements: 30.3_

- [x] 53. Audit Log UI and CSV Export
  - [x] 53.1 Implement `GET /api/audit-logs` (Global_Manager-only): filter by actor, action, resource type, team, date range, plus shared pagination
    - _Requirements: 31.1_
  - [x] 53.2 Implement `GET /api/audit-logs/export.csv` streaming the same filtered rows via `csv-stringify`
    - _Requirements: 31.2, 31.3_
  - [x] 53.3 Create `server/routes/auditLogs.js` with Permission_Registry entries excluding team-admin-only users
    - _Requirements: 31.4_
  - [x] 53.4* Write integration test for filter correctness and absence of rows older than the retention window
    - _Requirements: 31.1, 31.3_

- [x] 54. In-App Settings Configuration Surface
  - [x] 54.1 Write migration/seed script migrating `TAK_COLOR_*`/`TAK_ROLE_*` env values into `system_config` rows as initial defaults
    - _Requirements: 32.1_
  - [x] 54.2 Implement branding settings endpoints (org display name, logo) backed by `site_config`/`system_config`
    - _Requirements: 32.2_
  - [x] 54.3 Implement TAK Server integration credential settings endpoints (cert/key upload, `TAK_SERVER_URL`)
    - _Requirements: 32.3_
  - [x] 54.4 Implement atomic file upload (`.tmp-${uuid}` write + `fs.rename()`) for cert/key/logo uploads
    - _Requirements: 32.4_
  - [x] 54.5 Create `server/config/exportableSettingsKeys.js` allow-list and `GET /api/settings/export` (zip via `archiver`, secrets excluded)
    - _Requirements: 32.5_
  - [x] 54.6 Implement `POST /api/settings/import` validating every top-level key against the same allow-list, rejecting the entire import on any disallowed key
    - _Requirements: 32.6_
  - [x] 54.7 Add Permission_Registry entries for all settings routes (Global_Manager-only)
    - _Requirements: 32.2, 32.3, 32.5, 32.6_
  - [x] 54.8* Write unit tests: atomic upload never exposes a partially written file, import rejects a non-allow-listed key without partial apply
    - _Requirements: 32.4, 32.6_

- [x] 55. Public_Route_Registry completion and wiring
  - [x] 55.1 Finalize `publicRoutes.js` entries for every public endpoint introduced across this spec (`GET /api/teams/joinable`, `GET /api/auth/*`, `GET /health/live`, `GET /health/ready`, etc.)
    - _Requirements: 33.1_
  - [x] 55.2 Mount `publicRouteBootstrap` globally in `server/index.js` ahead of `authenticateToken`
    - _Requirements: 33.2_
  - [x] 55.3* Write property test for public/permission registry mutual exclusion
    - **Property 13: Public and Permission registries never overlap**
    - **Validates: Requirements 33.3**
  - [x] 55.4* Write an automated test analogous to the Permission_Registry completeness test, asserting a route bypassing `authenticateToken` without a Public_Route_Registry entry fails
    - _Requirements: 33.4_

- [x] 56. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 7: Testing & CI (Requirements 12, 20)

- [x] 57. Root dependency lockfile and CI pipeline
  - [x] 57.1 Generate and commit a root `package-lock.json`
    - _Requirements: 20.1_
  - [x] 57.2 Create `.github/workflows/ci.yml` running `npm ci && npm audit --audit-level=high` for the root and `client/` trees on push/PR and a weekly cron; fail the build on any high/critical finding or on `npm audit` itself failing to complete
    - _Requirements: 20.2, 20.3, 20.4_
  - [x] 57.3 Add a `package.json` version-pin lint script failing CI if `jsonwebtoken`, `bcryptjs`, `helmet`, or `express-rate-limit` use a `^`/`~` range
    - _Requirements: 20.5, 20.6_
  - [x] 57.4 Remove the unused `bcryptjs` dependency from `package.json`
    - _Requirements: 20.7_
  - [x] 57.5* Write unit test for the version-pin lint script logic
    - _Requirements: 20.6_

- [x] 58. Coverage gate and remaining unit test debt
  - [x] 58.1 Configure the Jest coverage threshold (60%, exactly-60% passing) in `ci.yml`, failing the build on any test failure or coverage below threshold
    - _Requirements: 12.6_
  - [x] 58.2* Write unit tests for `UserAttributesService.generateCallsign`: two-part name, single-word name (splitting fallback), non-alphanumeric characters
    - _Requirements: 12.1_
  - [x] 58.3* Write property test for callsign generation
    - **Property 6: Callsign generation never produces an empty result for a non-empty name**
    - **Validates: Requirements 12.1**
  - [x] 58.4* Write unit tests for `TeamMembershipService.addUserToTeam`/`removeUserFromTeam`: no-parent add, >=1-parent add (inherited rows created), removal also removes inherited rows, duplicate-add attempt
    - _Requirements: 12.2_
  - [x] 58.5* Write unit tests for `GroupMembershipCalculator`: single team no parent, >=2-level hierarchy, no team assigned
    - _Requirements: 12.3_
  - [x] 58.6* Write integration tests for team creation (success/validation-failure), membership add/remove (success/not-found), and access-request approve/deny (success/already-processed), run against a dedicated, reset-before-each-run test database
    - _Requirements: 12.5_

- [x] 59. Channel-name/folder-tree round trip extraction and tests
  - [x] 59.1 Extract the folder-parsing logic embedded in `Dashboard.jsx`'s `buildFolderTree` into a shared pure function `client/src/utils/channelTree.js`, reused unchanged by `GlobalChannels.jsx`
    - _Requirements: 12.7_
  - [x] 59.2* Write property test for the channel folder-path round trip
    - **Property 7: Channel folder-path round trip**
    - **Validates: Requirements 12.7**
  - [x] 59.3* Write example tests for a 3-level team hierarchy round trip and a 4+-level team hierarchy round trip
    - _Requirements: 12.7_

- [x] 60. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 8: Deployment Readiness (Requirement 19 — Dockerfile/.dockerignore only)

> Requirement 19 Criteria 5-6 (ECS task definition template / Terraform-CDK snippet and per-service IAM/network documentation) are explicitly out of scope for this plan, per `requirements.md`'s Introduction scoping note; that work belongs to a separate, future infrastructure spec.

- [x] 61. Multi-stage Dockerfile
  - [x] 61.1 Rewrite the `Dockerfile` as a multi-stage build: a `builder` stage installing root + `client` deps and running `npm run build`, and a final stage produced via `npm ci --omit=dev` that excludes `vite`, `@vitejs/*`, and every `client/package.json` devDependency
    - _Requirements: 19.1_
  - [x] 61.2 Add a non-root user (UID 1000) and `USER` switch before the final `CMD`/`ENTRYPOINT`
    - _Requirements: 19.2_

- [x] 62. `.dockerignore`
  - [x] 62.1 Create `.dockerignore` excluding at minimum `.git`, `node_modules`, `client/node_modules`, `client/dist`
    - _Requirements: 19.3_

- [x] 63. Dockerfile `HEALTHCHECK`
  - [x] 63.1 Add a `HEALTHCHECK` instruction targeting `GET /health` with a 30-second interval, 5-second timeout, 30-second start period, and 3 retries
    - _Requirements: 19.4, 14.7_

- [x] 64. Final checkpoint - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks (unit, property-based, integration) and are skipped by default during automated task execution; core implementation tasks are never marked optional.
- Every property test task references the property number and requirement clause(s) it validates, per `design.md`'s Correctness Properties section (Properties 1-15).
- Every new table or column lands as its own migration task ahead of the service/route tasks that depend on it (e.g. task 8 before task 9, task 25 before tasks 26-31, task 39 before task 40).
- Requirement 19 Criteria 5 and 6 (deployment artifact, IAM/network documentation) and any AWS CDK/Terraform/ECS orchestration are intentionally excluded from this plan.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "3.2", "4.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "4.2", "5.2"] },
    { "id": 2, "tasks": ["1.3", "2.3", "2.4", "2.5", "3.3", "4.3"] },
    { "id": 3, "tasks": ["7.1", "7.2", "8.1", "10.1", "11.1", "12.1"] },
    { "id": 4, "tasks": ["9.1", "9.2", "10.2", "11.2", "12.2"] },
    { "id": 5, "tasks": ["9.3", "10.3", "11.3", "12.3"] },
    { "id": 6, "tasks": ["7.3", "9.4", "10.4", "11.4", "12.4"] },
    { "id": 7, "tasks": ["14.1", "15.1", "16.1", "17.1", "18.1", "19.1", "20.1", "21.1", "23.1", "23.2"] },
    { "id": 8, "tasks": ["14.2", "15.2", "16.2", "17.2", "18.2", "19.2", "22.1", "22.2", "22.3", "23.3"] },
    { "id": 9, "tasks": ["15.3", "16.3", "17.3", "18.3", "22.4", "23.4"] },
    { "id": 10, "tasks": ["25.1", "26.1", "27.1", "28.1", "29.1", "30.1", "31.1", "31.4"] },
    { "id": 11, "tasks": ["26.3", "27.2", "28.2", "30.2", "31.2", "31.3", "31.6", "31.7"] },
    { "id": 12, "tasks": ["26.2", "27.3", "28.3", "30.3", "31.5", "31.8"] },
    { "id": 13, "tasks": ["30.4"] },
    { "id": 14, "tasks": ["33.1", "33.4", "34.1", "35.1", "35.3", "35.4", "36.1"] },
    { "id": 15, "tasks": ["33.2", "33.3", "34.2", "34.3", "34.4", "35.2", "36.2", "36.4"] },
    { "id": 16, "tasks": ["35.6", "36.3", "33.5", "34.5"] },
    { "id": 17, "tasks": ["35.5", "35.7", "36.5", "36.6"] },
    { "id": 18, "tasks": ["38.1", "39.1", "39.2", "39.3", "41.1", "44.1"] },
    { "id": 19, "tasks": ["38.2", "38.3", "38.4", "40.1", "40.2", "42.1", "45.1"] },
    { "id": 20, "tasks": ["38.5", "40.3", "40.4", "42.2", "42.3", "43.1", "45.2", "45.3"] },
    { "id": 21, "tasks": ["38.6", "40.5", "42.4", "45.4"] },
    { "id": 22, "tasks": ["38.7", "40.6", "42.5", "43.2", "45.5", "45.6"] },
    { "id": 23, "tasks": ["47.1", "48.1", "48.2", "49.1", "50.1", "54.1", "55.1"] },
    { "id": 24, "tasks": ["47.2", "47.3", "48.3", "49.2", "50.2", "50.3", "51.1", "52.1", "53.1", "54.2", "54.3", "55.2"] },
    { "id": 25, "tasks": ["48.4", "48.5", "49.3", "50.4", "50.5", "51.2", "51.3", "52.2", "52.3", "53.2", "54.4", "54.5", "54.6"] },
    { "id": 26, "tasks": ["49.4", "49.5", "51.4", "52.4", "53.3", "54.7"] },
    { "id": 27, "tasks": ["47.4", "48.6", "49.6", "50.6", "50.7", "51.5", "51.6", "52.5", "53.4", "54.8", "55.3", "55.4"] },
    { "id": 28, "tasks": ["57.1", "57.2", "57.3", "57.4", "58.1", "59.1"] },
    { "id": 29, "tasks": ["57.5", "58.2", "58.3", "58.4", "58.5", "58.6", "59.2", "59.3"] },
    { "id": 30, "tasks": ["61.1", "62.1"] },
    { "id": 31, "tasks": ["61.2"] },
    { "id": 32, "tasks": ["63.1"] }
  ]
}
```

### Reading the graph

- Waves 0-2 (Phase 0) block nearly everything downstream: Config_Validator, the structured logger, and both registries are consumed by every later phase.
- Waves 3-6 (Phase 1) and waves 7-9 (Phase 2) touch largely disjoint files (`auth.js`/`authorize.js` vs. `GlobalChannelService`/rate limiters/process handlers) and could run concurrently once Phase 0 lands, but are sequenced here to keep the authorization edge stable before layering more middleware on top of it.
- Waves 10-13 (Phase 3, Sync Worker) depend only on Phase 0 (logger, migration tooling) and could in practice run in parallel with Phases 1-2; they are ordered after them here only to match the requested phase sequence.
- Waves 14-17 (Phase 4) depend on the `sync_operations` columns from wave 10 (task 25.1) and the Permission_Registry/logger from Phase 0.
- Waves 18-22 (Phase 5) and waves 23-27 (Phase 6) are largely independent feature verticals (vendor channels, deployment channels, channel approval, retention, TAK Server, devices, MOU, CSV import, broadcast email, audit log, settings, public routes) that each depend on Phase 0-1's registries and Phase 4's transaction/logging patterns, but rarely on each other — most of the tasks within waves 19-22 and 24-27 can be parallelized further across feature teams if desired.
- Waves 28-29 (Phase 7) depend on the full feature set existing (for coverage) but the CI/lockfile tasks (57.x) are independent of the remaining unit-test tasks (58.x-59.x) and could run in parallel.
- Waves 30-32 (Phase 8) are Dockerfile-only and independent of all application code; they could run at any point after Phase 0, but are sequenced last here for clarity. All three edits target the `Dockerfile` itself, so they are kept in separate waves to avoid conflicting concurrent edits to the same file.
