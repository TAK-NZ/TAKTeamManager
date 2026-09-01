# TAK Team Manager Architecture

## System Overview

TAK Team Manager manages TAK teams, users, channels and (optionally) TAK Server devices, using Authentik as the identity provider. It is a Node/Express + PostgreSQL server with a React SPA client, deployed as two long-running processes plus the database.

Production hostname: **`team.tak.nz`**. The app is a single-origin SPA + API — Team Management, Downloads, and Enrollment are all React Router paths in the same bundle, not separate services, and the OAuth2 `redirect_uri`/CORS origin/session cookie are each wired to exactly one hostname. This sits alongside TAK-NZ's other `*.tak.nz` subdomains (`account` — Authentik SSO, `map` — CloudTAK, `docs`). CDK-based deployment of this hostname is a follow-up, not yet built.

## Deployable Processes

Two Node processes run from the same Docker image, distinguished only by their startup command:

### Web API (`node server/index.js`, `npm start`)

The Express app: security middleware (helmet, with a CSP allow-listing reCAPTCHA v3's Google origins), CORS scoped to `FRONTEND_URL`, cookie parsing, a global rate limiter, static mounts for the built client (`client/dist`), `/uploads` (branding assets), `/templates` (CSV bulk-import templates), every `/api/*` router, `GET /health` (a 2-second-timeout `SELECT 1`, 503 on failure), and a SPA catch-all. `validateConfig()` runs before any middleware mounts, inside an async IIFE — a bad config or unreachable secrets manager fails fast rather than serving broken requests. `/api/device-management` is conditionally mounted only when `DEVICE_MGMT_ENABLED` is on; the routes don't exist at all otherwise (404, not 403).

The web process is not purely request/response — it also runs two of its own in-process timers, started after `app.listen`:
- `authentikSync.startPeriodicSync()` — an interval-based user sync from Authentik (floor-clamped to 1 minute).
- `EscalationService.startDailySchedule()` — an hourly `processEscalations()` pass for pending access-request escalation, plus a minute-resolution poll that fires `sendDailyDigests()` once a day at a configured hour/minute/timezone (default 9:00 Pacific/Auckland).

### Sync Worker (`node server/workers/syncWorker.js`)

The Authentik/TAK-Server integration engine, run as a separate `sync-worker` service (`docker-compose.yml`, `restart: unless-stopped`). It has its own dedicated `pg.Pool` and its own lightweight HTTP health endpoint (default port 3001, backed by a `sync_worker_heartbeat` row with a 90-second staleness threshold).

Alongside its main poll loop, the constructor builds four additional schedulers:
- `ExpiryScheduler` — a 15-minute-capped interval that sweeps `VendorChannelService.expireGrants()` and `DeploymentChannelService.deactivateExpired()`.
- `RetentionCleanupJob` — 24-hour default interval; deletes terminal `sync_operations`/`audit_logs` rows past their retention window (the only non-append operation ever run against `audit_logs`).
- `AdminCredentialRefreshJob`, `SubscriptionPoller`, `DeviceSync` — constructed unconditionally, but only started when `DEVICE_MGMT_ENABLED` is on.

There is no separate cron process or Lambda anywhere in this system — every scheduled job is an in-process timer inside one of these two processes.

### Docker / Deployment

`docker-compose.yml` defines three services: `postgres` (15), `app` (runs `npm run dev`, concurrent server+client dev servers on 3000/5173), and `sync-worker` (runs the worker directly). The production `Dockerfile` is a two-stage build — a builder stage installs root+client dependencies and runs `vite build`; the final stage installs production-only root dependencies, copies `server/`, `database/`, and the built `client/dist`, runs as the pre-existing non-root `node` user, and defines a `HEALTHCHECK` against `GET /health`. The Dockerfile produces one image with one `CMD` (the web process); the sync worker is the same image with its command overridden in `docker-compose.yml` — there's no separate Dockerfile stage for it.

Production target is AWS ECS Fargate with an Application Load Balancer, RDS PostgreSQL, and Secrets Manager for credentials.

**When the CDK stack for the ALB is built:** set `TRUSTED_PROXY_HOPS=1`. The app trusts zero reverse-proxy hops by default (`TRUSTED_PROXY_HOPS=0`), correct for local/dev/test where nothing sits in front of it. Once deployed behind the ALB, `TRUSTED_PROXY_HOPS=1` must be set — otherwise `req.ip` resolves to the ALB's own address for every request, collapsing every `req.ip`-keyed rate limiter onto one shared bucket, and helmet's HSTS/HTTPS detection misreads every request as plain HTTP. This must be paired with an ECS security group rule restricting inbound traffic on the container port to the ALB's security group only — the hop count alone doesn't stop a request that reaches the task directly from forging its own `X-Forwarded-For`. If a CDN (e.g. CloudFront) is ever added in front of the ALB, this becomes `2`, not `1`.

## Database Schema

Schema history is squashed into one baseline migration (`1786596755665_baseline-schema.cjs`), with incremental `node-pg-migrate` `.cjs` migrations added alongside it since. Never hand-edit `schema.sql` as a source of truth.

### Core tables

- **`teams`** — every hierarchy node at every depth (an Organisation is a Team with `parent_team_id IS NULL`). Columns include `callsign_prefix` (unique, nullable — accepts one or more `-`-separated alphanumeric segments, e.g. `AUS-FIRE` for a foreign-partner prefix), `color`, `visibility` (`'private'` default), `can_join`, `parent_team_id` (self-FK, `ON DELETE CASCADE`), `callsign_name_format`, `callsign_level_selection` (int array, Organisation-only), and three nullable tri-state Organisation-only flags: `pseudonymous_usernames`, `response_channel_access`, `support_channel_access`.
- **`users`** — local user records linked to Authentik (`authentik_user_id`, unique). Includes `email` (nullable — see invariant below), `is_global_manager`, `is_active`, `is_vendor`, `is_team_device`, `device_label`, `callsign_suffix`, `tak_role`, `origin_org_id` (write-once via `COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)`, never reclassified on re-provisioning).
- **`team_memberships`** — user-team relationships with inheritance tracking (`role`, `inherited_from_team_id`). A partial unique index enforces at most one direct (non-inherited) row per user.
- **`channels`** — per-team custom/primary channels. `authentik_group_id`/`authentik_read_group_id`/`authentik_write_group_id` are VARCHAR (Authentik's own UUID primary keys), not integers.
- **Global channel tables, still separate per family** (not unified into one table): `bch_channels` (with a `category` column, `'BCH'`/`'UTL'`; unique on `(name, category)`), `region_channels` (with a `tier` column, `'response'`/`'support'`; unique on `(name, tier)`), `vendor_channels` (a partial unique index enforces at most one active row), `vendor_channel_grants`, `deployment_channels`.
- **`sync_operations`** — the Authentik/TAK-Server write queue: `operation_type`, `target_user_id`, `target_group_id`, `payload` (jsonb), `status`, `retry_count`, `max_retries` (default 48), `next_retry_at`, `failure_category`, `correlation_id`. `sync_status` and `sync_worker_heartbeat` are separate, smaller bookkeeping tables.
- **`audit_logs`** — append-only (`user_id`, `action`, `resource_type`, `resource_id`, `details` jsonb, `created_at`). The only non-`INSERT` statement against it anywhere is `RetentionCleanupJob`'s retention-window `DELETE`.
- **`tak_devices`** — one TAK Server client certificate per row, keyed by `client_uid` (not a surrogate id). Columns: `user_id` (FK, `ON DELETE SET NULL`), `cert_id`, `issued_at`/`expires_at`, `last_seen_at`, `last_polled_at`, `revoked`, `connected`. Single-writer discipline per column is structural: `SubscriptionPoller` owns `last_seen_at`/`connected`; the revoke handler owns `revoked`; `DeviceSync`'s upsert must never touch either.
- **Signup/request-related**: `access_requests` (`new_account`/`role_change`/`name_change`/`team_change`, with `approval_team_id`/`initiated_by` for transfers), `signup_codes`, `org_allowed_domains`, `org_interest_requests`, `channel_requests`.
- **`user_cache`** — a denormalized read model synced from Authentik: `tak_role`, `tak_color`, `tak_callsign`, `groups`, `is_admin`, `is_team_device`, `device_label`, `callsign_suffix`, `email` (nullable, same invariant as `users.email`).
- **`system_config`** and **`site_config`** — two separate key/value config tables: `system_config` for TAK color/role seeds and excluded email domains; `site_config` for branding and Request-Access page text.
- **`email_templates`**, `mou_documents`/`mou_signatures`, `bulk_operations`, `admin_notification_preferences`, `token_revocations` (JWT `jti` blacklist), `email_rate_tracking`, `channel_memberships`.

**Nullable-email invariant:** `users.email`/`user_cache.email` are nullable, paired with a CHECK constraint on both tables (`email IS NOT NULL OR is_team_device = true`) — the only human-facing row type allowed a NULL email is a Team_Owned_Device.

## Authorization Architecture

`server/config/permissions.registry.js` maps `"${METHOD} ${fullPath}"` to a required permission identifier (or identifiers), plus `roleDefaults` (`global_manager: ['*']`, `authenticated_user: [...]`). `server/middleware/authorize.js` is mounted **per route** (`authenticateToken, authorize`), never globally — `req.route` is undefined at router-mount time, so a global mount would silently authorize everything.

Deny-by-default: an unmapped route is denied (403), never permitted — adding a route without a registry entry ships it unreachable, not unguarded. `resolveAccess` first checks the static role-default set; if that alone doesn't satisfy every required identifier but a registry entry exists, row-scoped resolver functions extend it — e.g. `team:update` walks `Team.isAdmin` (itself walking the Ancestor_Chain, so an admin of any ancestor also qualifies). Every resolver invocation runs inside a central try/catch — a throw is logged and treated as denied, never permitted (fail-closed).

`team:read` is the sole entry mapped to a 404 rather than a 403 on denial — a 403 would confirm the hidden team exists at all. Resolvers must pass `req.user.userId` (the local `users.id`) to `Team.isAdmin`, never `req.user.id` (the Authentik id) — a historically real bug source.

## Synchronization Architecture

### Sync Worker

Every Authentik group-membership write is enqueued as a `sync_operations` row rather than called synchronously from a request handler — a synchronous write would bypass retry, backoff, and ordering.

**Batching and concurrency.** `processNextOperation` fetches a configurable batch (`SYNC_WORKER_BATCH_SIZE`, clamped 10-500, default 50) via `SELECT ... FOR UPDATE SKIP LOCKED`, marking the whole batch `processing` in one update. The batch is partitioned into "lanes" keyed by `target_user_id:target_group_id` (falling back to the operation's own id) so operations touching the same entity stay strictly sequential and in original fetch order, while distinct lanes run concurrently through a bounded pool (`SYNC_WORKER_CONCURRENCY`, clamped 1-100, default 10).

**Retry and backoff.** `computeBackoffDelay(retryCount)` is `min(2^retryCount * 60000, 3_600_000)` — capped at one hour; it does not itself enforce `max_retries` (a separate check does). `classifyFailure` maps an HTTP status or caught error to `retryable`/`permanent`: 5xx and network/timeout errors are retryable, 4xx is permanent. A payload-validation failure is always permanent (`failure_category='validation'`) and bypasses the retry counter entirely — retrying a malformed payload would only hide the real defect.

**Operation types** (`server/workers/operationSchemas.js`, dispatched from a switch in `syncWorker.js`): `add_user_to_group`, `remove_user_from_group`, `create_group`, `bulk_add_user_to_team`, `create_bch_channel_groups`, `create_region_channel_group`, `update_bch_channel_group`, `update_region_channel_group`, `delete_global_channel`, `assign_user_to_global_channels`, `deactivate_global_channel`, `sync_existing_global_channels`, `resync_org_channel_tier_access`, `cleanup_orphaned_authentik_user`, `remove_team_channel_group`, `create_vendor_channel_group`, `create_deployment_channel_group`, `remove_all_members_from_group`, `revoke_tak_certificates` (accepts either a device-scoped `client_uid` or a user-scoped `tak_usernames` array, never both or neither), `create_cloudtak_group`/`update_cloudtak_group`/`delete_cloudtak_group`. Every operation type has a corresponding schema entry; a completeness test fails if one is added without the other, so an unregistered type fails validation at dequeue rather than silently mis-processing.

### Conflict Resolution

- **TAK Team Manager's database wins** for every `tak_`-prefixed Authentik group.
- Users with a `TakTeamManager: false` Authentik attribute are excluded from sync.
- Authentik-side drift is corrected to match the database, not the other way around.

## TAK Server Device Management (optional)

Gated end-to-end by `DEVICE_MGMT_ENABLED` (server-only, never exposed via `GET /api/config/public`; feature-off answers 404 on device reads) and, independently, `DEVICE_MGMT_REVOKE_ENABLED` (arms certificate revocation; disarmed answers 403 naming the capability, and a queued revoke completes as a logged dry-run rather than failing).

- **`DeviceEnrollmentService`** creates/updates/deletes Team_Owned_Devices and generates ATAK/iTAK enrollment QR codes and manual-entry credentials, for both self-enrollment and team-owned-device enrollment.
- **`DeviceManagementService`** is the read/authorization layer over `tak_devices` for the admin device-management surface — Managed_User scoping, distinct from enrollment itself.
- **`TakServerService`** is the mutual-TLS Marti certadmin API client (`TAK_SERVER_URL`) — lists/revokes certificates, fetches client endpoints and subscriptions. Never sets `rejectUnauthorized: false` or overrides `checkServerIdentity`; TLS identity narrows only via `TAK_SERVER_TLS_SERVERNAME`.
- **`TakCertificateRevocationService`** is the request-side trigger that enqueues `revoke_tak_certificates` sync operations, capped at a 250-certificate blast radius per operation.
- **`SubscriptionPoller`** and **`DeviceSync`** are scheduled jobs living in the sync worker. `DeviceSync` reconciles `tak_devices` against TAK Server's live certificate list (create/update only — never touches `last_seen_at`/`connected`/`revoked`). `SubscriptionPoller` separately polls connection status and last-seen time.

Device lifecycle: enrollment (a certificate is issued; `DeviceSync` creates the `tak_devices` row) → periodic polling (`SubscriptionPoller` updates `connected`/`last_seen_at`) → revocation (an enqueued sync operation is processed by the worker's `revokeTakCertificates` handler).

`TAK_SERVER_ENROLLMENT_URL` and `TAK_SERVER_URL` are deliberately different hosts, not aliases: `TAK_SERVER_URL` is the mutual-TLS certadmin endpoint (often internal/admin-only); `TAK_SERVER_ENROLLMENT_URL` is the public, client-dialable host enrollment URIs/QR payloads are built from. They can legitimately point at different hostnames and/or ports.

## CloudTAK Integration (optional)

Gated by `CLOUDTAK_ENABLED` (server-only). Keeps one Authentik "Agency" group per Team in sync — named `<prefix><teams.id>` via `CLOUDTAK_AGENCY_GROUP_PREFIX` (default `CloudTAKAgency`, must match CloudTAK's own `OIDC_AGENCY_ADMIN_GROUP_PREFIX` configuration, since the two applications share no config source) — created/updated/deleted via `create_cloudtak_group`/`update_cloudtak_group`/`delete_cloudtak_group` sync operations enqueued from team creation, team updates, and admin-membership changes. Membership is reconciled to the Team's *direct* admin set only, deliberately excluding inherited admins, via a pure diff function so CloudTAK's view of a Team's admins never diverges from the app's own.

## Audit Logging

`audit_logs` is append-only. `GET /api/audit-logs` and its CSV export are both Global_Manager-only, sharing one permission identifier (`audit_log:read`) and the same filter-building function, so the exported CSV can never diverge from what the UI displayed. Filters include actor (by email, not user id — a deliberate divergence from an earlier spec), action, resource type, an associated team (only for team/channel-scoped resource types), and a date range.

## Broadcast Email

`BroadcastEmailService` sends a templated email to a filtered recipient set (by team, role, channel, or all users), scoped so a non-Global_Manager caller can only reach users on teams they directly administer. Any out-of-scope recipient rejects the entire request before any message sends; a failed authorization-resolution query fails closed rather than defaulting to an unscoped send.

## Access Requests and Sign-Up

The public join flow (`SignupFlowService`, unauthenticated) is a two-step, email-first process: request → email verification link → team selection/submission. `POST /api/requests/initiate` returns a fixed 200 body for every outcome, including internal errors, to avoid becoming an email-enumeration oracle. Eligibility (sign-up code validity, allowed-domain match) is re-checked server-side on submit — a client-supplied team id from a public-facing list is never trusted directly. A sign-up code never bypasses an Organisation's domain restriction; the two predicates are ANDed, not ORed.

`RequestApprovalService` is the admin-side counterpart: creating, verifying, approving, and denying `access_requests` rows, plus escalation timing for requests left pending too long.

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
| `users.js` | Create/list/search users, add-to-team, transfer, directory-scoped listing |
| `channels.js` | Per-team custom channels |
| `channelRequests.js` | Sub-team channel request/approve/deny |
| `globalChannels.js`, `vendorChannels.js`, `deploymentChannels.js` | The three global-channel families' admin CRUD |
| `requests.js` | Access-request approve/deny/pending |
| `signup.js`, `signupCodes.js` | Public join flow |
| `orgDomains.js` | Allowed-domain management |
| `config.js` | Public presentation config |
| `sync.js`, `operations.js` | Sync-queue introspection |
| `auditLogs.js` | Global_Manager-only audit log read/export |
| `settings.js` | Branding, exportable settings |
| `mou.js` | Agreement documents/signatures |
| `communications.js` | Broadcast email |
| `devices.js`, `enrollment.js` | Self/team device enrollment |
| `deviceManagement.js` | Conditionally-mounted admin device revoke/list |
| `bulkImport.js` | CSV import |

## Client Architecture

React 18 + React Router v6, Vite, Tailwind CSS. No Redux — state is local `useState`/hooks plus one context (theme). Vitest + fast-check for tests (see `.kiro/steering/testing-conventions.md`).

Pages under `client/src/pages/`:

| Page | Purpose |
|---|---|
| `Dashboard.jsx` | TAK profile, own devices, own channel tree |
| `Teams.jsx` / `TeamDetail.jsx` | Hierarchy CRUD, members/admins/devices/channels/sub-teams tabs |
| `Users.jsx` | Org-wide user directory (admin-only) |
| `Requests.jsx` | Pending access-request review (team-admin+) |
| `RequestAccess.jsx` | Public join flow |
| `GlobalChannels.jsx` | BCH/region/vendor/deployment channel admin (global-admin-only) |
| `Admin.jsx` | Site settings/config (global-admin-only) |
| `AuditLogs.jsx` | Audit log viewer/export (global-admin-only) |
| `EnrollmentView.jsx` | Device enrollment QR/manual flow |
| `Downloads.jsx` | Client app download links |
| `Login.jsx` | Kicks off the Authentik SSO redirect |

`App.jsx` gates the whole router on a session check (`GET /api/auth/me`) before rendering, with a public-only early exit for `/request-access`.

## Mobile Responsiveness

Every dense table (Teams, Team Detail's tabs, Team Devices) renders as a stacked card list below the `sm:` breakpoint and the original table at `sm:` and above, so a phone never scrolls a table sideways. Action-icon groups get a `card` variant on mobile that wraps each icon in a real ~36-40px tap target. Header toolbars go icon-only below `sm:` and restore full text+icon labels at `sm:` and up. See `.kiro/steering/client-conventions.md` for the full set of conventions this follows.

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

- `.kiro/steering/` — living conventions (stack/commands, code placement, product glossary, server/client conventions, feature flags, testing).
- `.kiro/specs/` — ten completed feature specs, cited heavily in code comments by requirement number. History, not current documentation — a later spec overrules an earlier one where they conflict.
- `docs/END-USER-DOCS.md` — how a team member or team admin actually uses the product.
