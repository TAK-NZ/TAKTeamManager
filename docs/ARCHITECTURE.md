# TAK Team Manager Architecture

## System Overview

TAK Team Manager manages TAK teams, users, channels, account lifecycle, and (optionally) TAK Server devices and certificate-expiry notifications, using Authentik as the identity provider. It is a Node/Express + PostgreSQL server with a React SPA client, deployed as two long-running processes plus the database.

Production hostname: **`team.tak.nz`**. The app is a single-origin SPA + API — Team Management, Downloads, and Enrollment are all React Router paths in the same bundle, not separate services, and the OAuth2 `redirect_uri`/CORS origin/session cookie are each wired to exactly one hostname. This sits alongside TAK-NZ's other `*.tak.nz` subdomains (`account` — Authentik SSO, `map` — CloudTAK, `docs`). CDK-based deployment of this hostname is a follow-up, not yet built.

## Deployable Processes

Two Node processes run from the same Docker image, distinguished only by their startup command:

### Web API (`node server/index.js`, `npm start`)

The Express app: security middleware (helmet, with a CSP allow-listing reCAPTCHA v3's Google origins), CORS scoped to `FRONTEND_URL`, cookie parsing, a global rate limiter, static mounts for the built client (`client/dist`), `/uploads` (branding assets), `/templates` (CSV bulk-import templates), every `/api/*` router, `GET /health` (a 2-second-timeout `SELECT 1`, 503 on failure), and a SPA catch-all. `validateConfig()` runs before any middleware mounts, inside an async IIFE — a bad config or unreachable secrets manager fails fast rather than serving broken requests. `/api/device-management` is the only conditionally-mounted router, mounted only when `DEVICE_MGMT_ENABLED` is on; the routes don't exist at all otherwise (404, not 403).

The web process is not purely request/response — it also runs two of its own in-process timers, started after `app.listen`:
- `authentikSync.startPeriodicSync()` — an interval-based user sync from Authentik (floor-clamped to 1 minute).
- `EscalationService.startDailySchedule()` — an hourly `processEscalations()` pass for pending access-request escalation, plus a minute-resolution poll that fires `sendDailyDigests()` once a day at a configured hour/minute/timezone (default 9:00 Pacific/Auckland).

### Sync Worker (`node server/workers/syncWorker.js`)

The Authentik/TAK-Server integration engine, run as a separate `sync-worker` service (`docker-compose.yml`, `restart: unless-stopped`). It has its own dedicated `pg.Pool` and its own lightweight HTTP health endpoint (default port 3001, backed by a `sync_worker_heartbeat` row with a 90-second staleness threshold).

Alongside its main poll loop, the constructor builds these additional schedulers, all constructed unconditionally (opening no timer, reading no secret) so gating is entirely a matter of whether `start()` actually arms each one:

- **`RetentionCleanupJob`** — started unconditionally. 24-hour default interval; deletes terminal `sync_operations`/`audit_logs` rows past their retention window (the only non-append operation ever run against `audit_logs`).
- **`CertExpiryNotificationJob`** — `start()` is called unconditionally, but the job's own `start()` no-ops unless BOTH `CERT_EXPIRY_NOTIFICATIONS_ENABLED` and `DEVICE_MGMT_ENABLED` are exactly `'true'`. When armed, it reuses `EscalationService`'s hour/minute/timezone match mechanism (`DIGEST_HOUR`/`DIGEST_MINUTE`/`DIGEST_TIMEZONE`, same default 9:00 Pacific/Auckland) rather than a fixed interval, and runs the daily certificate-expiry digest (see "Certificate Expiry Notifications" below).
- **`AdminCredentialRefreshJob`**, **`SubscriptionPoller`**, **`DeviceSync`** — all three started only inside an `if (isDeviceMgmtEnabled())` block, all sharing the single `TakServerService` instance (via `AdminCredentialLoader`) so a refreshed Admin_Credential propagates to every one without a restart.

`stop()` stops every one of the above unconditionally (each `stop()` is idempotent, a no-op if the job was never started) — there is no separate cron process or Lambda anywhere in this system; every scheduled job is an in-process timer inside one of these two processes. On `SIGINT`/`SIGTERM`/`uncaughtException`, `stop()` first waits (bounded, 30s) for any in-flight `processNextOperation` call to settle before closing its own `pg.Pool` and health server, so a batch already claimed via `FOR UPDATE SKIP LOCKED` isn't abandoned mid-write; an `unhandledRejection` is logged and the process keeps running, while an `uncaughtException` triggers this same controlled shutdown before exiting.

### Docker / Deployment

`docker-compose.yml` defines three services: `postgres` (15), `app` (runs `npm run dev`, concurrent server+client dev servers on 3000/5173), and `sync-worker` (runs the worker directly). The production `Dockerfile` is a two-stage build — a builder stage installs root+client dependencies and runs `vite build`; the final stage installs production-only root dependencies, copies `server/`, `database/`, and the built `client/dist`, runs as the pre-existing non-root `node` user, and defines a `HEALTHCHECK` against `GET /health`. The Dockerfile produces one image with one `CMD` (the web process); the sync worker is the same image with its command overridden in `docker-compose.yml` — there's no separate Dockerfile stage for it.

Production target is AWS ECS Fargate with an Application Load Balancer, RDS PostgreSQL, and Secrets Manager for credentials.

**When the CDK stack for the ALB is built:** set `TRUSTED_PROXY_HOPS=1`. The app trusts zero reverse-proxy hops by default (`TRUSTED_PROXY_HOPS=0`), correct for local/dev/test where nothing sits in front of it. Once deployed behind the ALB, `TRUSTED_PROXY_HOPS=1` must be set — otherwise `req.ip` resolves to the ALB's own address for every request, collapsing every `req.ip`-keyed rate limiter onto one shared bucket, and helmet's HSTS/HTTPS detection misreads every request as plain HTTP. This must be paired with an ECS security group rule restricting inbound traffic on the container port to the ALB's security group only — the hop count alone doesn't stop a request that reaches the task directly from forging its own `X-Forwarded-For`. If a CDN (e.g. CloudFront) is ever added in front of the ALB, this becomes `2`, not `1`.

## Database Schema

Schema history is squashed into a single baseline migration (`database/migrations/`) -- this application has never been deployed anywhere outside its own dev/test environment, so there is no production database to migrate forward from, and the baseline is re-squashed periodically rather than accumulating an ever-growing incremental chain. Future schema changes ship as new incremental `node-pg-migrate` `.cjs` migrations alongside it. Never hand-edit `schema.sql` as a source of truth.

### Core tables

- **`teams`** — every hierarchy node at every depth (an Organisation is a Team with `parent_team_id IS NULL`). Columns include `callsign_prefix` (unique, nullable — accepts one or more `-`-separated alphanumeric segments, e.g. `AUS-FIRE` for a foreign-partner prefix), `color`, `visibility` (`'private'` default), `can_join`, `parent_team_id` (self-FK, `ON DELETE CASCADE`), `callsign_name_format`, `callsign_level_selection` (int array, Organisation-only), and four nullable tri-state Organisation-only flags: `pseudonymous_usernames` (immutable once set — changing it would invalidate every existing member's TAK certificate Common Name), `response_channel_access`, `support_channel_access` (both mutable after creation).
- **`users`** — local user records linked to Authentik (`authentik_user_id`, unique). Includes `email` (nullable — see invariant below), `is_global_manager`, `is_active`, `is_team_device`, `device_label`, `callsign_suffix`, `tak_role`, `origin_org_id` (write-once via `COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)`, never reclassified on re-provisioning), and **`account_status`** (`'active'`/`'suspended'`/`'orphaned'`, default `'active'`, partial index on the non-`'active'` case — see "Account Lifecycle" below). `is_vendor` was removed along with the Vendor Time-Limited Channel Access feature (see "Removed Features").
- **`team_memberships`** — user-team relationships with inheritance tracking (`role`, `inherited_from_team_id`). A partial unique index enforces at most one direct (non-inherited) row per user.
- **`channels`** — per-team custom/primary channels. `authentik_group_id`/`authentik_read_group_id`/`authentik_write_group_id` are VARCHAR (Authentik's own UUID primary keys), not integers.
- **Global channel tables** — only two remain: `bch_channels` (with a `category` column, `'BCH'`/`'UTL'`; unique on `(name, category)`) and `region_channels` (with a `tier` column, `'response'`/`'support'`; unique on `(name, tier)`). `vendor_channels`/`vendor_channel_grants` and `deployment_channels` were both dropped along with their features (see "Removed Features").
- **`sync_operations`** — the Authentik/TAK-Server write queue: `operation_type`, `target_user_id`, `target_group_id`, `payload` (jsonb), `status`, `retry_count`, `max_retries` (default 48), `next_retry_at`, `failure_category`, `correlation_id`. `sync_status` and `sync_worker_heartbeat` are separate, smaller bookkeeping tables.
- **`audit_logs`** — append-only (`user_id`, `action`, `resource_type`, `resource_id`, `details` jsonb, `created_at`). The only non-`INSERT` statement against it anywhere is `RetentionCleanupJob`'s retention-window `DELETE`.
- **`tak_devices`** — one TAK Server client certificate per row, keyed by `client_uid` (not a surrogate id). Columns: `user_id` (FK, `ON DELETE SET NULL`), `cert_id`, `issued_at`/`expires_at`, `last_seen_at`, `last_polled_at`, `revoked`, `connected`. Single-writer discipline per column is structural: `SubscriptionPoller` owns `last_seen_at`/`connected`; the revoke handler owns `revoked`; `DeviceSync`'s upsert must never touch either.
- **`cert_expiry_notifications`** — bookkeeping for the certificate-expiry digest job: `client_uid`, `cert_id`, `threshold_days`, `notified_at`, unique on `(client_uid, cert_id, threshold_days)`. Deliberately carries no foreign key to `tak_devices` — a row must survive `DeviceSync` deleting a stale `tak_devices` row untouched, since it records a past send, not a live reference. A certificate is identified by `(client_uid, cert_id)`, not `client_uid` alone, so a renewal (a new `cert_id`) starts every notification tier fresh with no manual reset.
- **Signup/request-related**: `access_requests` (`new_account`/`role_change`/`name_change`/`team_change`, with `approval_team_id`/`initiated_by` for transfers), `signup_codes`, `org_allowed_domains`, `org_interest_requests`.
- **`user_cache`** — a denormalized read model synced from Authentik: `tak_role`, `tak_color`, `tak_callsign`, `groups`, `is_admin`, `is_team_device`, `device_label`, `callsign_suffix`, `email` (nullable, same invariant as `users.email`).
- **`system_config`** and **`site_config`** — two separate key/value config tables: `system_config` for excluded email domains; `site_config` for branding and Request-Access page text. (The TAK colour/role mapping surface that used to live in `system_config` was removed — see "Removed Features".)
- **`email_templates`** (including the two `cert_expiry_self_digest`/`cert_expiry_team_digest` rows seeded by cert-expiry-notifications), `bulk_operations`, `admin_notification_preferences`, `token_revocations` (JWT `jti` blacklist), `email_rate_tracking`, `channel_memberships`.

**Nullable-email invariant:** `users.email`/`user_cache.email` are nullable, paired with a CHECK constraint on both tables (`email IS NOT NULL OR is_team_device = true`) — the only human-facing row type allowed a NULL email is a Team_Owned_Device.

### Removed Features

Four features shipped with a full backend but no client UI, and were removed outright (routes, services, permission-registry entries, schema) rather than a UI ever being built for them, since the product no longer needs them:

- **Vendor Time-Limited Channel Access** and the **Channel Creation Approval Workflow** — dropped `vendor_channels`, `vendor_channel_grants`, `channel_requests`, `users.is_vendor`.
- **MOU/Document Management** (including the login-time agreement gate) — dropped `mou_documents`, `mou_signatures`; the `requireCurrentAgreement` gate middleware was deleted along with the feature.
- **Deployment-Scoped Overseas/Domestic Channel Self-Service** — dropped `deployment_channels`; also removed the `ExpiryScheduler` that swept it (its only remaining purpose once vendor-channel expiry sweeping was already gone) and the `DEPLOYMENT_CHANNELS_ENABLED`/`EXPIRY_SCHEDULER_INTERVAL_SECONDS` env vars.
- **Broadcast Email composer** — the `POST /api/communications/send` route and `BroadcastEmailService` were removed (no client caller ever existed). The template-editor and test-email routes it shared a file with are unaffected and remain in active use by `Admin.jsx`'s Email Templates tab.
- **Database-backed TAK colour/role mapping** — the `GET`/`PUT /api/settings/tak-mappings` surface and its `Admin.jsx` tab were removed; these deployments source `TAK_COLOR_*`/`TAK_ROLE_*` from a deploy-time env file instead, so an in-app database override was a second, unsynced source of truth.

## Authorization Architecture

`server/config/permissions.registry.js` maps `"${METHOD} ${fullPath}"` to a required permission identifier (or identifiers), plus `roleDefaults` (`global_manager: ['*']`, `authenticated_user: [...]`). `server/middleware/authorize.js` is mounted **per route** (`authenticateToken, authorize`), never globally — `req.route` is undefined at router-mount time, so a global mount would silently authorize everything.

Deny-by-default: an unmapped route is denied (403), never permitted — adding a route without a registry entry ships it unreachable, not unguarded. `resolveAccess` first checks the static role-default set; if that alone doesn't satisfy every required identifier but a registry entry exists, row-scoped resolver functions extend it — e.g. `team:update` walks `Team.isAdmin` (itself walking the Ancestor_Chain, so an admin of any ancestor also qualifies). Every resolver invocation runs inside a central try/catch — a throw is logged and treated as denied, never permitted (fail-closed).

`team:read` is the sole entry mapped to a 404 rather than a 403 on denial — a 403 would confirm the hidden team exists at all. Resolvers must pass `req.user.userId` (the local `users.id`) to `Team.isAdmin`, never `req.user.id` (the Authentik id) — a historically real bug source. Note `req.user.isAdmin` and `req.user.is_global_manager` are ALIASES of the same cached `is_admin` column, not independent flags.

## Synchronization Architecture

### Sync Worker

Every Authentik group-membership write is enqueued as a `sync_operations` row rather than called synchronously from a request handler — a synchronous write would bypass retry, backoff, and ordering.

**Batching and concurrency.** `processNextOperation` fetches a configurable batch (`SYNC_WORKER_BATCH_SIZE`, clamped 10-500, default 50) via `SELECT ... FOR UPDATE SKIP LOCKED`, marking the whole batch `processing` in one update. The batch is partitioned into "lanes" keyed by `target_user_id:target_group_id` (falling back to the operation's own id) so operations touching the same entity stay strictly sequential and in original fetch order, while distinct lanes run concurrently through a bounded pool (`SYNC_WORKER_CONCURRENCY`, clamped 1-100, default 10).

**Retry and backoff.** `computeBackoffDelay(retryCount)` is `min(2^retryCount * 60000, 3_600_000)` — capped at one hour; it does not itself enforce `max_retries` (a separate check does). `classifyFailure` maps an HTTP status or caught error to `retryable`/`permanent`: 5xx and network/timeout errors are retryable, 4xx is permanent. A payload-validation failure is always permanent (`failure_category='validation'`) and bypasses the retry counter entirely — retrying a malformed payload would only hide the real defect.

**Call resilience.** Every raw `fetch()` call against Authentik (`server/utils/fetchWithTimeout.js`) and both `axios` clients against Authentik/TAK Server (`authentik.js`, `TakServerService.js`) carry a bounded timeout (10s default), so a hung upstream connection can't stall a request or a queued operation indefinitely. Both clients are additionally wrapped in a small dependency-free circuit breaker (`server/utils/circuitBreaker.js`, closed → open → half-open) — a run of consecutive failures trips it, and calls fail fast (a plain, retry-classified `Error`) until a single probe after a reset window succeeds.

**Operation types** (`server/workers/operationSchemas.js`, dispatched from a switch in `syncWorker.js`): `add_user_to_group`, `remove_user_from_group`, `create_group`, `bulk_add_user_to_team`, `create_bch_channel_groups`, `create_region_channel_group`, `update_bch_channel_group`, `update_region_channel_group`, `delete_global_channel`, `assign_user_to_global_channels`, `deactivate_global_channel`, `sync_existing_global_channels`, `resync_org_channel_tier_access`, `cleanup_orphaned_authentik_user`, `remove_team_channel_group`, `update_channel_group`, `revoke_tak_certificates` (accepts a device-scoped `client_uid`, a user-scoped `tak_usernames` array, or an exact `cert_ids` array — mutually exclusive, never more than one or none), `create_cloudtak_group`/`update_cloudtak_group`/`delete_cloudtak_group`. Every operation type has a corresponding schema entry; a completeness test fails if one is added without the other, so an unregistered type fails validation at dequeue rather than silently mis-processing.

### Conflict Resolution

- **TAK Team Manager's database wins** for every `tak_`-prefixed Authentik group.
- Users with a `TakTeamManager: false` Authentik attribute are excluded from sync.
- Authentik-side drift is corrected to match the database, not the other way around.

## Account Lifecycle Management

Every account is one of three `account_status` values, `is_active` always agreeing with it: `active` (`is_active = true`), `suspended`, or `orphaned` (both `is_active = false`).

- **Suspend** (`AccountLifecycleService.suspendAccount`) — an admin action (Team_Admin of the target's team, or Global_Manager), on the type-to-confirm dialog tier because its side effect is one-way: it revokes every live TAK certificate the account holds, transactionally sets `account_status='suspended'`, and — post-commit, best-effort — locks the Authentik identity (`is_active: false`). The identity itself is never deleted.
- **Unsuspend** — the plain Cancel/Confirm tier (fully reversible): restores `account_status='active'` and unlocks the Authentik identity. It does not restore any previously revoked certificate — the member/device must re-enroll.
- **Orphaning** is automatic, never admin-triggered: `authentikSync.js`'s Reconciliation_Sweep, run once per successful periodic sync, sets `account_status='orphaned'` on any local row whose Authentik identity no longer exists, revoking its certificates and clearing its cached TAK attributes along the way. An orphaned account can be neither suspended nor unsuspended (there is no Authentik identity left to lock or unlock), and its row-level actions disappear from the client accordingly.
- **Account_Reclaim**: when an admin approves a `new_account` access request whose email matches a previously orphaned account, the approval reclaims that existing row (preserving its audit history) instead of creating a new one — flagged to the approving admin as an informational notice on the request card. Team membership and admin rights are not automatically restored; the admin assigns them fresh as part of the same approval.

## Certificate Expiry Notifications (optional)

Gated by BOTH `CERT_EXPIRY_NOTIFICATIONS_ENABLED` and `DEVICE_MGMT_ENABLED` (server-only; the daily job no-ops entirely unless both are exactly `'true'`). A daily job (`CertExpiryNotificationService`/`CertExpiryNotificationJob`, scheduled on the same `DIGEST_HOUR`/`DIGEST_MINUTE`/`DIGEST_TIMEZONE` `EscalationService` already uses) evaluates every live `tak_devices` certificate against four independently configurable day-count thresholds (`CERT_EXPIRY_TIER1_DAYS`..`TIER4_DAYS`, defaults 30/15/8/1) and, once due and not already notified for that exact `(client_uid, cert_id, threshold_days)` triple, emails a digest:

- **Self-owned device** — one email to the device owner, listing every device of theirs due at once.
- **Team-owned device** — an Escalation_Round tied to the same four thresholds: the least-urgent tier (30 days) reaches only the device's own team's direct admins, each subsequent tier adds one level up the Ancestor_Chain, and the most-urgent tier (1 day) reaches the entire chain up to and including the Organisation, unconditionally. Rounds are additive — an admin reached at an earlier tier keeps being reached at later ones for the same device.

A device is only eligible if it was last seen (or issued, absent a last-seen value) within `CERT_EXPIRY_ACTIVITY_WINDOW_DAYS` (default 90) before its own expiry — this keeps a one-off test enrollment abandoned within days from ever generating a notification purely because its expiry date approaches. If a run was down long enough that more than one tier is simultaneously due for one certificate, only the single most urgent tier is emailed; every other backlogged tier is marked resolved with no email, never reconsidered. Both digest templates advise the recipient to revoke the certificate instead of renewing it, if the device is no longer needed.

On a successful renewal, `DeviceEnrollmentService` enqueues a Superseding_Revoke (`revoke_tak_certificates` with the `cert_ids` discriminator) for the exact certificate the renewal replaces — but only when the principal held exactly one prior live certificate; if more than one, which one this mint replaces is ambiguous and the enqueue is skipped rather than guessed.

## TAK Server Device Management (optional)

Gated end-to-end by `DEVICE_MGMT_ENABLED` (server-only, never exposed via `GET /api/config/public`; feature-off answers 404 on device reads) and, independently, `DEVICE_MGMT_REVOKE_ENABLED` (arms certificate revocation; disarmed answers 403 naming the capability, and a queued revoke completes as a logged dry-run rather than failing).

- **`DeviceEnrollmentService`** creates/updates/deletes Team_Owned_Devices and generates ATAK/iTAK enrollment QR codes and manual-entry credentials, for both self-enrollment and team-owned-device enrollment, and lists devices both per-team and org-wide (backing the `/devices` page).
- **`DeviceManagementService`** is the read/authorization layer over `tak_devices` for the admin device-management surface — Managed_User scoping, distinct from enrollment itself.
- **`TakServerService`** is the mutual-TLS Marti certadmin API client (`TAK_SERVER_URL`) — lists/revokes certificates, fetches client endpoints and subscriptions. Never sets `rejectUnauthorized: false` or overrides `checkServerIdentity`; TLS identity narrows only via `TAK_SERVER_TLS_SERVERNAME`.
- **`TakCertificateRevocationService`** is the request-side trigger that enqueues `revoke_tak_certificates` sync operations, capped at a 250-certificate blast radius per operation.
- **`SubscriptionPoller`** and **`DeviceSync`** are scheduled jobs living in the sync worker. `DeviceSync` reconciles `tak_devices` against TAK Server's live certificate list (create/update only — never touches `last_seen_at`/`connected`/`revoked`). `SubscriptionPoller` separately polls connection status and last-seen time.

Device lifecycle: enrollment (a certificate is issued; `DeviceSync` creates the `tak_devices` row) → periodic polling (`SubscriptionPoller` updates `connected`/`last_seen_at`) → revocation (an enqueued sync operation is processed by the worker's `revokeTakCertificates` handler) or renewal (a new certificate is minted and the prior one is superseded — see "Certificate Expiry Notifications" above).

`TAK_SERVER_ENROLLMENT_URL` and `TAK_SERVER_URL` are deliberately different hosts, not aliases: `TAK_SERVER_URL` is the mutual-TLS certadmin endpoint (often internal/admin-only); `TAK_SERVER_ENROLLMENT_URL` is the public, client-dialable host enrollment URIs/QR payloads are built from. They can legitimately point at different hostnames and/or ports.

## CloudTAK Integration (optional)

Gated by `CLOUDTAK_ENABLED` (server-only). Keeps one Authentik "Agency" group per Team in sync — named `<prefix><teams.id>` via `CLOUDTAK_AGENCY_GROUP_PREFIX` (default `CloudTAKAgency`, must match CloudTAK's own `OIDC_AGENCY_ADMIN_GROUP_PREFIX` configuration, since the two applications share no config source) — created/updated/deleted via `create_cloudtak_group`/`update_cloudtak_group`/`delete_cloudtak_group` sync operations enqueued from team creation, team updates, and admin-membership changes. Membership is reconciled to the Team's *direct* admin set only, deliberately excluding inherited admins, via a pure diff function so CloudTAK's view of a Team's admins never diverges from the app's own.

Independently, `CLOUDTAK_URL` (if set to a valid absolute URL) surfaces a browser-based CloudTAK link on the Downloads page — this is a purely presentational config value, read by a different function than `CLOUDTAK_ENABLED`, and setting one has no effect on the other.

## Audit Logging

`audit_logs` is append-only. `GET /api/audit-logs` and its CSV export are both Global_Manager-only, sharing one permission identifier (`audit_log:read`) and the same filter-building function, so the exported CSV can never diverge from what the UI displayed. Filters include actor (by email, not user id — a deliberate divergence from an earlier spec), action, resource type, an associated team (only for team/channel-scoped resource types), and a date range.

## Access Requests and Sign-Up

The public join flow (`SignupFlowService`, unauthenticated) is a two-step, email-first process: request → email verification link → team selection/submission (with a Terms-of-Service checkbox when `tos_url` is configured — there is no document-signing/MOU step). `POST /api/requests/initiate` returns a fixed 200 body for every outcome, including internal errors, to avoid becoming an email-enumeration oracle. Eligibility (sign-up code validity, allowed-domain match) is re-checked server-side on submit — a client-supplied team id from a public-facing list is never trusted directly. A sign-up code never bypasses an Organisation's domain restriction; the two predicates are ANDed, not ORed.

`RequestApprovalService` is the admin-side counterpart: creating, verifying, approving, and denying `access_requests` rows, plus escalation timing for requests left pending too long, plus Account_Reclaim when an approval's email matches a previously orphaned account (see "Account Lifecycle Management" above).

## Other Notable Features

- **Pseudonymous usernames** — an Organisation-level flag, fixed at Organisation creation, that mints a Managed_Identifier-style username for members instead of an email-derived one. Fixed forever once set, because changing it would invalidate every existing member's TAK certificate Common Name.
- **Foreign-partner callsign prefixes** — `callsign_prefix` accepts one or more `-`-separated alphanumeric segments (e.g. `AUS-FIRE`), not just a single token, letting a foreign-partner Organisation encode an internal `[COUNTRY]-[FUNCTION]` structure. No individual segment may have the exact shape of a Managed_Identifier's marker+body suffix, to keep that identifier format's right-anchored parse unambiguous.
- **Bulk import** — CSV-driven team/user import (`BulkImportService`), backed by downloadable templates served at `/templates`.

## API Route Surface

Route files under `server/routes/`:

| Route file | Covers |
|---|---|
| `auth.js` | OAuth2 login/callback/logout (public except `/me`) |
| `teams.js` | Team CRUD, hierarchy, members, channel-access flags |
| `users.js` | Create/list/search users, add-to-team, transfer, suspend/unsuspend, directory-scoped listing |
| `channels.js` | Per-team custom channels |
| `globalChannels.js` | BCH/region global-channel admin CRUD |
| `requests.js` | Public access-request submission, admin approve/deny/pending |
| `signup.js`, `signupCodes.js` | Public join flow |
| `orgDomains.js` | Allowed-domain / excluded-domain / org-interest management |
| `config.js` | Public presentation config, admin config listing/update |
| `sync.js`, `operations.js` | Sync-queue introspection and manual trigger |
| `auditLogs.js` | Global_Manager-only audit log read/export |
| `settings.js` | Branding, TAK Server config, exportable settings |
| `communications.js` | Email template editor and test-email send |
| `devices.js` | Team-Owned Device CRUD, org-wide/per-team device listing, QR/enrollment generation |
| `enrollment.js` | Self-service (signed-in user's own) enrollment |
| `deviceManagement.js` | Conditionally-mounted (`DEVICE_MGMT_ENABLED`) admin device listing/revoke — distinct from `devices.js` |
| `bulkImport.js` | CSV import (users, teams) |
| `health.js` | Liveness/readiness probes |

`mou.js`, `vendorChannels.js`, `deploymentChannels.js`, and `channelRequests.js` no longer exist — removed along with their features (see "Removed Features" above).

## Client Architecture

React 18 + React Router v6, Vite, Tailwind CSS. No Redux — state is local `useState`/hooks plus one context (theme). Vitest + fast-check for tests (see `.kiro/steering/testing-conventions.md`).

Pages under `client/src/pages/`:

| Page | Purpose |
|---|---|
| `Dashboard.jsx` | TAK profile, own devices (with a renew prompt when a certificate is imminent/expired), own channel tree |
| `Teams.jsx` / `TeamDetail.jsx` | Hierarchy CRUD, members/admins/devices/channels/sub-teams tabs |
| `Users.jsx` | Org-wide user directory, with suspend/unsuspend and other row actions gated to whoever administers that user's team |
| `Devices.jsx` | Org-wide Team-Owned Device directory, the device counterpart of `Users.jsx` — same directory scoping, row actions gated per-device to whoever administers that device's team |
| `Requests.jsx` (route `/tasks`, `/requests` redirects here) | Visible to every authenticated user: own devices needing renewal (everyone), team devices needing renewal and pending access requests (Team_Admin/Global_Manager), Org Interest Requests (Global_Manager only) |
| `RequestAccess.jsx` | Public join flow |
| `GlobalChannels.jsx` | BCH/region channel admin (Global_Manager-only) |
| `Admin.jsx` | Site settings/config (Global_Manager-only): Site Content, Email Templates, Bulk Import, Excluded Domains, Export/Import tabs |
| `AuditLogs.jsx` | Audit log viewer/export (Global_Manager-only) |
| `EnrollmentView.jsx` | Device enrollment QR/manual flow, reused embedded in dialogs elsewhere |
| `Downloads.jsx` | Client app download links, plus a CloudTAK link when `CLOUDTAK_URL` is configured |
| `Login.jsx` | Kicks off the Authentik SSO redirect |

`App.jsx` gates the whole router on a session check (`GET /api/auth/me`) before rendering, with a public-only early exit for `/request-access`.

## Mobile Responsiveness

Every dense table (Teams, Team Detail's tabs, Team Devices, Users, Devices) renders as a stacked card list below the `sm:` breakpoint and the original table at `sm:` and above, so a phone never scrolls a table sideways. Action-icon groups get a `card` variant on mobile that wraps each icon in a real ~36-40px tap target. Header toolbars go icon-only below `sm:` and restore full text+icon labels at `sm:` and up. See `.kiro/steering/client-conventions.md` for the full set of conventions this follows.

## Performance Characteristics

- **Scale**: designed for up to 50,000 regular users, 5,000 team admins, 50 global admins.
- **Bulk operations**: a 50,000-user global-channel assignment operation targets a 30-60 minute completion window, driven by the sync worker's batch size and concurrency settings above.
- **List endpoints** use a shared pagination middleware (default 50, max 200, rejected above that before the query runs) and resolve per-row lookups in one batched query — no N+1 queries.

## Testing

- Server: root `npm test` (Jest). Integration tests are excluded from the default run and must be invoked explicitly.
- Client: `cd client && npm test` (Vitest).
- Coverage floor: 60% global statements (server).
- See `.kiro/steering/testing-conventions.md` for React-mounting conventions (no `@testing-library/react`) and property-test rules (fast-check/`@fast-check/jest`).

## Where to Look Next

- `.kiro/steering/` — living conventions (stack/commands, code placement, product glossary, server/client conventions, feature flags, testing, TAK Server/Marti integration facts).
- `docs/END-USER-DOCS.md` — how a team member or team admin actually uses the product.

Note: `.kiro/specs/` (ten completed feature specs) was removed once implemented; some older code comments still cite requirement/criterion numbers from those retired specs (e.g. `// device-management Requirement 5.3`) as historical provenance — the spec itself no longer exists, so treat the surrounding comment text as the source of truth.
