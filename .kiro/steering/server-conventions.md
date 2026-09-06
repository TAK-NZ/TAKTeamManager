---
inclusion: fileMatch
fileMatchPattern: 'server/**/*.js'
---

# Server conventions

## Authorization

- Every authenticated route+method needs an entry in `server/config/permissions.registry.js`.
  - An unmapped route is DENIED 403 — deny-by-default in `resolveAccess`.
  - Adding a route without a registry entry ships it unreachable, not unguarded.
- Mount as `authenticateToken, authorize` PER ROUTE (see `server/routes/teams.js`).
  - Never `app.use(authorize)`: `req.route` is undefined at router-mount level, so a global mount matches nothing and silently authorizes everything.
- A route reachable without a token must be listed in `server/config/publicRoutes.js` and must NOT appear in the permission registry.
  - Both registries have completeness tests: `permissions.registry.completeness.test.js`, `publicRoutes.completeness.test.js`.
- Row-scoped checks (admin status, visibility, ownership) belong in `server/middleware/authorize.js`'s resolvers, not inline in handlers.
  - A duplicated inline check drifts, and one stale copy is a privilege escalation.
- Authorization fails CLOSED: a resolver that throws is denied and logged, never permitted.
- `team:read` denial responds 404, never 403 — a 403 confirms the hidden Team exists.
  - It is the only entry in `PERMISSION_DENIALS_MAPPED_TO_404`.
- Pass `req.user.userId` (local `users.id`) to `Team.isAdmin` — never `req.user.id`, which is the Authentik id.

## Secrets and logging

- The JWT is read only from the httpOnly `tak_session` cookie.
  - Never an `Authorization` header, URL parameter, or `localStorage`. The client has never stored a token.
- Log only through the pino logger (`server/config/logger.js`).
  - `console.*` is an ESLint error in server code (`no-console` in `eslint.config.js`).
- PII and secret-shaped fields are redacted at `info` and above. Unredacted values only at `LOG_LEVEL=debug`.
- Never log credential material: the TAK admin credential, the P12 passphrase, or service-account plaintext.
  - Service-account credentials are stored AES-256-GCM encrypted (`server/services/CredentialEncryptionService.js`) and decrypted only when building a response.
- Never set `rejectUnauthorized: false` or override `checkServerIdentity` on the TAK Server mutual-TLS agent (`server/services/TakServerService.js`), in any environment.
  - Narrow TLS identity via `TAK_SERVER_TLS_SERVERNAME` only — that changes WHICH name is verified, not whether.
- Never add a secret-shaped key to the settings export allow-list in `server/config/exportableSettingsKeys.js`.
  - `tak_server_p12_passphrase` must stay absent.
  - Export and import read the SAME module — never a second copy.

## Transactions and the sync queue

- Authentik group-membership writes are always enqueued as `sync_operations`, never called synchronously from a request handler.
  - A synchronous write bypasses retry, backoff and ordering.
- When enqueueing inside a transaction, pass the caller's open client to `EventPublisher.publishOperation`.
  - Otherwise a rolled-back change still queues the operation and applies it to Authentik anyway.
- A service whose atomicity matters takes a required transaction client and issues no BEGIN/COMMIT/ROLLBACK itself.
  - See `TeamTransferService.executeTransfer`, which throws a `TypeError` without one.
  - That makes atomicity a signature guarantee rather than a caller obligation.
- Perform no HTTP call, email send or audit write inside a transaction.
  - Run them after COMMIT, each individually caught and logged, with the response unchanged — see `TeamTransferService.applyPostCommitEffects`.
- A synchronous Authentik user creation followed by a failing local transaction must attempt a compensating delete and, on failure, enqueue cleanup.
  - See `server/routes/users.js` and the compensating handler in `server/workers/syncWorker.js`.
  - Orphaned Authentik accounts are invisible to the app.
- Every new `operation_type` in the worker switch needs a `server/workers/operationSchemas.js` entry; parity is enforced by `operationSchemas.test.js`.
  - An unregistered type fails validation at dequeue, not enqueue.
- Retry backoff is capped at one hour by `computeBackoffDelay` (`server/workers/backoff.js`); it does not enforce `max_retries`.
  - A payload-validation failure marks the operation permanently failed (`failure_category='validation'`) without touching `retry_count` or `next_retry_at` — retrying a malformed payload hides the real defect.
- Classify upstream failures with `server/workers/failureClassification.js`: 5xx/network retryable, 4xx permanent, persisted on the row as `failure_category`.
- Batch claiming uses `FOR UPDATE SKIP LOCKED`.
- Worker handlers must be idempotent — the retry queue guarantees reprocessing.
  - Create-or-reuse by name; treat an absent target as a satisfied delete.

## Queries

- Dynamic SQL identifiers come only from a frozen allow-list resolved at query-construction time.
  - See `CHANNEL_TABLE_ALLOWLIST` in `server/services/GlobalChannelService.js` and `CHANNEL_TABLES` in `VendorChannelService.js`.
  - Never interpolate a caller-supplied identifier.
- List endpoints use the shared `paginationParams` middleware (`server/middleware/pagination.js`).
  - Default 50, max 200, 400 before the query runs.
- Resolve per-row lookups for a list in ONE batched query. No N+1.
- Scope every destructive write by an explicit key set — `WHERE client_uid <> ALL($1::text[])` in `DeviceSync` and `SubscriptionPoller`, never an unrestricted DELETE.
  - An upstream outage that reads as "empty" must not wipe a table.
  - Discriminate on the run's OUTCOME, never the size of the derived set.
- Wrap SQL scope disjuncts in `COALESCE(..., false)` — `NULL` breaks `COUNT(*) FILTER`. See the directory-scope queries in `server/routes/users.js`.
  - Narrow inside the CTE BEFORE the `LIMIT`, or you get empty pages indistinguishable from a deliberate fail-closed result.
- Match an email domain on the substring after the FINAL `@`, case-insensitively, and escape `\`, `%`, `_` in every LIKE pattern.
  - Use `escapeLikePattern` / `buildEmailDomainLikePatterns` (`server/utils/directoryScope.js`).
  - `split_part(email,'@',2)` takes the first `@`; an unescaped `_` widens visibility.
- Single-writer ownership of a column is structural.
  - In `tak_devices`, `SubscriptionPoller` owns `last_seen_at`/`connected` and the revoke handler owns `revoked` — the `DeviceSync` upsert must never list those columns.

## Domain rules that are easy to get wrong

- Resolve an Organisation as `getAncestorChain(...)[0]` or `parent_team_id IS NULL`.
  - NEVER a positional read from the tail — the chain is root-first, so the tail is the deepest Team.
  - The transfer path in `server/routes/users.js` documents this explicitly at its two `Team.getAncestorChain` call sites.
- A Sub_Team inherits `color`/`callsign_name_format` from its ORGANISATION, not its immediate parent (`server/models/Team.js`).
  - A supplied value is silently overridden, never rejected.
- `callsign_level_selection` is Organisation-only; a Sub_Team value is a typed rejection, and a Sub_Team stores `null`.
  - The Organisation default is `1..MAX_TEAM_DEPTH` — depth 0 is never a member, because the Organisation's own prefix is always included.
- Compute target depth and reject BEFORE any INSERT, with the guard outside any try/catch that has a fallback path.
- Admin inheritance is computed at check time by `Team.isAdmin`, never materialised.
  - A persisted copy goes stale on re-parenting.
- `callsign_prefix` accepts one or more `-`-separated alphanumeric segments (e.g. `FENZ`, or `AUS-FIRE` for a foreign-partner prefix) — no leading/trailing/doubled `-`, and no individual segment may itself have the exact shape of a `Managed_Identifier`'s marker+body suffix (`[DU]` + 7 Identifier_Alphabet characters), which would make `managedIdentifier.js`'s right-anchored parse ambiguous.
  - `callsign_suffix` also allows `-` and `.`, with no segment restriction. Both patterns live in `server/utils/callsignValidation.js`.
- A private Team hides its WHOLE branch regardless of descendants' own visibility.
  - `TeamVisibilityService`'s order is fixed: Global_Manager bypass, then absolute cross-Organisation exclusion, then private-ancestor cascade with a membership escape.
  - Reordering lets a membership row defeat Organisation isolation.
- Directory scope never falls back to unscoped on error.
  - `DirectoryScopeService.UNSCOPED` is reachable only from `is_global_manager`.
  - A DB failure must be a 500, not "everyone".
- `origin_org_id` is write-once via `COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)` in `UserProvisioningService`.
  - A bare `EXCLUDED` reclassifies provenance on re-provisioning.
- `audit_logs` is append-only.
  - The only non-INSERT statement is the retention cleanup DELETE in `server/services/RetentionCleanupJob.js`.
  - Never add an edit or delete endpoint.
- Audit-log read and CSV export are Global_Manager-only and share one permission identifier.
  - `audit_log:read` covers `GET /api/audit-logs` and `GET /api/audit-logs/export.csv`.
  - Both must apply filters through the shared `buildAuditLogFilters` — divergence means the CSV no longer matches what the operator saw.
- A user's cached `tak_callsign`/`tak_color` (`user_cache`, and mirrored into Authentik's `takCallsign`/`takColor` attributes) must be cleared to `'None'`/`'None'` — via `UserAttributesService.clearTeamAttributes` — the moment they end up with ZERO `team_memberships` rows.
  - `Team.delete` is currently the only path that can do this (every other membership-removing path lands the user in some team), and it already calls `clearTeamAttributes` post-commit. A new path that can leave a user teamless (e.g. a future self-service "leave team") must call it too, or the Dashboard (reads the cache) silently diverges from the Enrollment page (reads live via `team_memberships`).
- A sign-up code must never bypass an Organisation's allowed-domain restriction.
  - In `SignupFlowService` the domain predicate is ANDed after the code predicate. Collapsing to OR opens every restricted Organisation.
- `channel_memberships.channel_id` is polymorphic — it can reference either `channels.id` or `deployment_channels.id` (the FK to `channels(id)` was deliberately dropped in `1786750000000_make-channel-memberships-channel-id-polymorphic.cjs`).
  - Never scope a `DELETE`/`UPDATE` against this table by `user_id` alone. Join through `channels` (or `deployment_channels`) explicitly so the statement only touches rows that are actually team-owned channels — an unscoped `DELETE FROM channel_memberships WHERE user_id = $1` silently destroys a user's Deployment_Channel subscriptions too.
  - Residual, unresolved hazard: a row pointing at a `deployment_channels.id` that numerically collides with a `channels.id` will join spuriously against either table. This is pre-existing in every query that joins the two and is not fixed by scoping the delete correctly.
- Each Team's `CloudTAKAgency<id>` Authentik group is reconciled by full diff (fetch current members, compute the Direct_Admin_Set, `add_user`/`remove_user` the difference), never a targeted single-user add/remove, unlike channel-group sync elsewhere.
  - This is deliberate: the group's Authentik `pk` isn't known synchronously at the enqueue site (the feature keys off the group NAME `CloudTAKAgency<id>`, not a stored pk), so a targeted add/remove would need an extra lookup anyway. Reconciling to the full current set instead makes every `update_cloudtak_group`/`create_cloudtak_group` operation idempotent and self-healing — a missed event is corrected by the next reconcile, at the cost of one extra `GET` per change.
- `POST /api/requests/initiate` (`server/routes/signup.js`) returns 200 with a fixed body for EVERY outcome including internal errors.
  - Any divergence is an email-enumeration oracle.
- Re-run eligibility server-side on submit; never trust a client-supplied `teamId` from a public-facing list.
  - `SignupFlowService` re-evaluates `can_join` + code + domain and throws `Selected team is not available`.

## Two known divergences — do not trust the spec here

- **`audit-log-ui` requirements say the audit log filters on `userId`. The shipped code filters on `userEmail`.**
  - See `buildAuditLogFilters` in `server/routes/auditLogs.js`; a display name is resolved via a `LEFT JOIN users`.
  - A later production-hardening change superseded the spec text. Use `userEmail`.
- **`org-team-hierarchy`'s design says Authentik is the source of truth for `tak_role` and the sync updates the local column from it. The code is the reverse.**
  - In `server/services/authentikSync.js`, `users.tak_role` is local-authoritative and pushed to Authentik.
  - The code's direction is the safer one; the design comment is a drift vector.
