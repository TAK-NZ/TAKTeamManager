# Design Document: Certificate Expiry Notifications

## Overview

This feature adds one new table, one new service, one new scheduled job, two new email templates, a `revoke_tak_certificates` payload extension, and three UI changes. It deliberately reuses, rather than reimplements, four pieces of existing infrastructure:

- **The daily-digest-at-local-time scheduling shape** — `EscalationService.startDailySchedule()`'s `setInterval`-every-minute-comparing-against-a-configured-hour/minute pattern, and its `DIGEST_HOUR`/`DIGEST_MINUTE`/`DIGEST_TIMEZONE` environment variables, reused verbatim (Requirement 5.1).
- **Certificate expiry data** — `tak_devices.expires_at`/`last_seen_at`/`issued_at`/`cert_id`, already kept current by `DeviceSync` on its own independent poll interval. This feature issues no TAK Server API call of its own.
- **The Revoke_Operation** — `revoke_tak_certificates`, extended with one new discriminator shape rather than a new operation type, mirroring how `account-lifecycle-management` reused the SAME operation for suspension/orphaning without inventing a parallel revoke mechanism.
- **Ancestor-chain admin resolution** — `Team.getAncestorChain`/`Team.getManagedTeamIds`, the same primitives `/devices`' `canManage` scoping and `Team.isAdmin` are built on.

## Schema

One migration, `database/migrations/<timestamp>_cert-expiry-notifications.cjs`:

```sql
CREATE TABLE public.cert_expiry_notifications (
    id integer NOT NULL,
    client_uid character varying(255) NOT NULL,
    cert_id integer NOT NULL,
    threshold_days integer NOT NULL,
    notified_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.cert_expiry_notifications_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.cert_expiry_notifications_id_seq OWNED BY public.cert_expiry_notifications.id;
ALTER TABLE ONLY public.cert_expiry_notifications ALTER COLUMN id SET DEFAULT nextval('public.cert_expiry_notifications_id_seq'::regclass);

ALTER TABLE ONLY public.cert_expiry_notifications
    ADD CONSTRAINT cert_expiry_notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cert_expiry_notifications
    ADD CONSTRAINT cert_expiry_notifications_client_uid_cert_id_threshold_key
    UNIQUE (client_uid, cert_id, threshold_days);

CREATE INDEX idx_cert_expiry_notifications_client_uid
    ON public.cert_expiry_notifications USING btree (client_uid);

COMMENT ON TABLE public.cert_expiry_notifications IS 'cert-expiry-notifications Requirement 1: tracks which Cert_Expiry_Tier has already been resolved (emailed or deliberately skipped as stale-backlog) for a given certificate, keyed on (client_uid, cert_id, threshold_days) so a renewed certificate (new cert_id) starts every tier fresh.';
```

No foreign key to `tak_devices` on `client_uid`: `DeviceSync` deletes a `tak_devices` row when its `client_uid` drops out of the Live_Device_Set (its own documented reconciliation step), and a `cert_expiry_notifications` row must survive that deletion untouched — it is bookkeeping about a past send, not a live reference (Requirement 1.3). No `ON DELETE` action to worry about because there is no FK at all, deliberately.

## New service: `server/services/CertExpiryNotificationService.js`

Pure query/eligibility logic plus the email-sending orchestration, structured as static methods so it is mockable the same way `AccountLifecycleService`/`TakCertificateRevocationService` already are. No transaction is used anywhere in this service: every write here is either an idempotent `INSERT ... ON CONFLICT DO NOTHING` (the notification-tracking row) or independent of any other write in the same run, so there is nothing that needs atomicity across rows the way `AccountLifecycleService`'s local-write-plus-enqueue does.

```js
const TIERS = [
  { thresholdDays: () => parseTierDays('CERT_EXPIRY_TIER1_DAYS', 30), round: 1 },
  { thresholdDays: () => parseTierDays('CERT_EXPIRY_TIER2_DAYS', 15), round: 2 },
  { thresholdDays: () => parseTierDays('CERT_EXPIRY_TIER3_DAYS', 8),  round: 3 },
  { thresholdDays: () => parseTierDays('CERT_EXPIRY_TIER4_DAYS', 1),  round: 4 },
];

class CertExpiryNotificationService {
  // Requirement 2: one pass over every live, non-null-expires_at tak_devices
  // row whose owning account is active (not suspended/orphaned), returning
  // per-device eligibility grouped by owner kind.
  static async findEligibleCandidates(now = new Date()) { ... }

  // Requirement 3: groups Self-Owned_Device candidates by owner user id,
  // sends one digest per user, marks resolved tiers on success.
  static async sendSelfOwnedDigests(candidates) { ... }

  // Requirement 4: resolves each Team-Owned_Device candidate's recipient
  // set via the Escalation_Round rule, groups by recipient, sends one
  // digest per recipient (spanning every team they administer), marks
  // resolved tiers on success.
  static async sendTeamOwnedDigests(candidates) { ... }

  static async run(now = new Date()) { ... } // orchestrates the two above; called by the job
}
```

### `findEligibleCandidates(now)` — Requirement 2

One query against `tak_devices` joined to `users` (to read `is_team_device`/`account_status`) and `cert_expiry_notifications` (to exclude already-resolved tiers), mirroring the exact join shape `DeviceEnrollmentService.listTeamDevices`/`listAllDevices` already use for `tak_devices`↔`users`:

```sql
SELECT d.client_uid, d.cert_id, d.expires_at, d.last_seen_at, d.issued_at,
       u.id AS user_id, u.is_team_device, u.email, u.username,
       tm.team_id AS direct_team_id
FROM tak_devices d
JOIN users u ON u.id = d.user_id
LEFT JOIN team_memberships tm ON tm.user_id = u.id AND tm.inherited_from_team_id IS NULL
WHERE d.revoked = false
  AND d.expires_at IS NOT NULL
  AND u.account_status = 'active'
```

For each row, in JS (not SQL, since the per-tier `NOT EXISTS` against four possible `threshold_days` values is clearer as a loop over the four configured tiers than as SQL, and the tier day-counts are read from `.env` at call time, not baked into the query):

1. Compute `daysLeft = Math.ceil((expires_at - now) / 86400000)`.
2. For each tier (day-descending, i.e. TIER1 first): if `daysLeft > tier.thresholdDays`, skip (not yet due). Otherwise it is DUE.
3. Batch-check which of this candidate's DUE tiers already have a `cert_expiry_notifications` row (one `SELECT client_uid, threshold_days FROM cert_expiry_notifications WHERE (client_uid, cert_id) = ANY(...)`-shaped batched lookup across all candidates up front, not per-row, mirroring the "resolve per-row lookups for a list in ONE batched query" server convention). A DUE tier with an existing row is RESOLVED — skip it (Requirement 1.2).
4. Among the DUE-and-unresolved tiers for this candidate (there may be more than one after an outage — Requirement 2.3), compute the activity check ONCE (it doesn't vary per tier): `activityOk = (lastSeenAt ?? issuedAt) !== null && (lastSeenAt ?? issuedAt) >= (expiresAt - activityWindowDays * 86400000)`.
   - If `activityOk` is false: none of this candidate's DUE-and-unresolved tiers are written or emailed this run (Requirement 2.4) — they stay open for the next run.
   - If `activityOk` is true: the SINGLE most urgent (smallest `thresholdDays`) DUE-and-unresolved tier becomes this candidate's "email tier" for this run; every OTHER DUE-and-unresolved tier for this candidate is queued to be marked resolved with no email (Requirement 2.3).
5. Return `{ toEmail: [...], toMarkResolvedOnly: [...] }` — both keyed by `(clientUid, certId, thresholdDays)` plus enough device/owner context (`isTeamDevice`, `directTeamId`, owner email/username, `expiresAt`, a display name) for the two digest senders to consume directly, so neither sender re-queries `tak_devices`.

The `toMarkResolvedOnly` entries are written immediately (their own `INSERT ... ON CONFLICT (client_uid, cert_id, threshold_days) DO NOTHING`, no email, no recipient resolution needed) — they carry no send-success dependency, unlike `toEmail`, which is only marked resolved after Requirement 3.4/4's "only after the send call returns successfully" rule.

### `sendSelfOwnedDigests(candidates)` — Requirement 3

Filters `toEmail` to `!isTeamDevice`, groups by `userId`, and for each group:

1. Build the per-device line items (device display name — `deviceLabel || username` is not applicable here since a Self-Owned_Device has no `deviceLabel`; use the owner's own `username`/`email` plus a client-type hint if available — expiry date).
2. Call `EmailService.sendEmail(ownerEmail, 'cert_expiry_self_digest', { first_name, device_list, revoke_hint_url })`.
3. On success, `INSERT ... ON CONFLICT DO NOTHING` a `cert_expiry_notifications` row for every device/tier in that group (Requirement 3.4).
4. On failure (caught per-recipient, mirroring `EscalationService.sendAdminDigest`'s own per-admin try/catch — one recipient's SMTP failure must not abort the rest of the batch), log and leave that group's rows unwritten, so the next scheduled run retries the same tier for the same certificates.

### `sendTeamOwnedDigests(candidates)` — Requirement 4

Filters `toEmail` to `isTeamDevice`. Recipient resolution (Requirement 4.1) per candidate:

```js
async function resolveRecipients(directTeamId, round) {
  const chain = await Team.getAncestorChain(directTeamId); // root-first: depth 0 = Organisation, last row = directTeamId itself
  const deviceTeamDepth = chain[chain.length - 1].depth;    // D: the device's own team's Team_Depth
  // Round 1 -> depth D only (the device's own team); round 2 -> D and D-1;
  // round 3 -> D, D-1, D-2; round 4 -> every depth down to 0 (the whole
  // chain, unconditionally) -- climbing FROM the device's own team TOWARD
  // the Organisation as the round number increases, never the reverse.
  const depthFloor = round === 4 ? 0 : Math.max(0, deviceTeamDepth - (round - 1));
  const teamIds = chain.filter(t => t.depth >= depthFloor).map(t => t.id);
  return pool.query(
    `SELECT DISTINCT u.id, u.email FROM team_memberships tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ANY($1) AND tm.role = 'admin' AND tm.inherited_from_team_id IS NULL
       AND u.account_status = 'active'`,
    [teamIds]
  );
}
```

This is the exact `role = 'admin' AND inherited_from_team_id IS NULL` predicate `Team.isAdmin`/`getManagedTeamIds` already use, applied to a *set* of team ids (the round's depth-bounded suffix of the ancestor chain, counting back from the device's own team) rather than a single team — no new admin-resolution rule, just a different input set per round. `u.account_status = 'active'` on the recipient satisfies Requirement 4.4.

**Correction note:** an earlier draft of this function filtered on `t.depth <= round - 1` (i.e. treating `depth 0`, the Organisation, as round 1's target and widening downward). That is backwards relative to the stated requirement — "notify direct team admins on round 1, +1 level up on round 2" means round 1 is the device's OWN team (whatever depth that happens to be, not depth 0), and each subsequent round climbs ONE level closer to the Organisation, with round 4 reaching the Organisation unconditionally regardless of how deep the device's team actually sits. The corrected version above anchors the floor to the device's own team's depth (`D`) and subtracts, rather than anchoring to depth 0 and adding.

Then: build a `Map<adminUserId, { email, devicesByTeam: Map<teamName, [...]> }>` across every Team-Owned_Device candidate (an admin managing several teams gets one entry spanning all of them, per Requirement 4.2), call `EmailService.sendEmail(admin.email, 'cert_expiry_team_digest', { first_name, team_sections, revoke_hint_url })` once per admin, and on success mark every `(clientUid, certId, thresholdDays)` that contributed to that admin's email as resolved — but only once ALL recipients for a given device/tier have been attempted, since Requirement 3.4/4's "only after successful send" rule is per notification-row, and a device/tier reaching three admins at round 3 must not be marked resolved if the send to admin #2 failed while #1 and #3 succeeded. Concretely: track per-`(clientUid, certId, thresholdDays)` a success/failure list across every recipient it was queued to reach in this run, and only write its `cert_expiry_notifications` row once every attempt for it succeeded.

## New job: `server/services/CertExpiryNotificationJob.js`

Structurally identical to `RetentionCleanupJob` (plain `setInterval`/`clearInterval` wrapper, `start()`/`stop()`, each run's error caught and logged, never thrown) but scheduled like `EscalationService`'s digest half rather than on a fixed interval — reusing that exact "compare `now` in a configured timezone against a configured hour/minute, once a minute" mechanism rather than introducing a second implementation of it:

```js
class CertExpiryNotificationJob {
  constructor({ pool: dbPool = pool } = {}) {
    this.pool = dbPool;
    this.timer = null;
    this.lastRunDateKey = null; // 'YYYY-MM-DD' in the configured timezone; guards against firing twice in the same matching minute
  }

  start() {
    if (this.timer) return;
    if (!isCertExpiryNotificationsEnabled() || !isDeviceMgmtEnabled()) {
      logger.info('Cert expiry notification job not started (feature disabled or device management disabled)');
      return;
    }
    this.timer = setInterval(() => this.maybeRun(), 60 * 1000);
    logger.info('Cert expiry notification job scheduled');
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  maybeRun() {
    const digestHour = parseInt(process.env.DIGEST_HOUR, 10) || 9;
    const digestMinute = parseInt(process.env.DIGEST_MINUTE, 10) || 0;
    const digestTimezone = process.env.DIGEST_TIMEZONE || 'Pacific/Auckland';
    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: digestTimezone }));
    const dateKey = nowInTz.toISOString().slice(0, 10);
    if (nowInTz.getHours() === digestHour && nowInTz.getMinutes() === digestMinute && this.lastRunDateKey !== dateKey) {
      this.lastRunDateKey = dateKey;
      CertExpiryNotificationService.run().catch(err => logger.error({ err }, 'Cert expiry notification run failed'));
    }
  }
}
```

`lastRunDateKey` is new relative to `EscalationService`'s own copy of this pattern — it is added here because `CertExpiryNotificationService.run()`'s per-tier writes are idempotent-but-not-free (an accidental second run inside the same matching minute would needlessly re-batch-query and re-attempt every candidate's send, whereas `EscalationService.sendDailyDigests()` has run this way, unguarded, in production already; not touching that file). Not a design flaw to inherit — a documented, one-line hardening on the new copy of the pattern.

Started/stopped from `server/workers/syncWorker.js`'s `start()`/`stop()`, alongside `retentionCleanupJob`/`expiryScheduler`, gated per Requirement 5.2/5.3:

```js
// constructor:
this.certExpiryNotificationJob = new CertExpiryNotificationJob();

// start():
this.certExpiryNotificationJob.start(); // the job's own start() re-checks both flags internally, matching this file's existing pattern of gating INSIDE start() for isDeviceMgmtEnabled()-dependent jobs rather than wrapping the call site in an if.

// stop():
this.certExpiryNotificationJob.stop();
```

### New config helper: `server/config/certExpiryNotifications.js`

Mirroring `server/config/deviceMgmt.js` exactly:

```js
function isCertExpiryNotificationsEnabled(env = process.env) {
  return env.CERT_EXPIRY_NOTIFICATIONS_ENABLED === 'true';
}
function getCertExpiryTierDays(env = process.env) {
  return {
    tier1: parsePositiveInt(env.CERT_EXPIRY_TIER1_DAYS, 30),
    tier2: parsePositiveInt(env.CERT_EXPIRY_TIER2_DAYS, 15),
    tier3: parsePositiveInt(env.CERT_EXPIRY_TIER3_DAYS, 8),
    tier4: parsePositiveInt(env.CERT_EXPIRY_TIER4_DAYS, 1),
  };
}
function getCertExpiryActivityWindowDays(env = process.env) {
  return parsePositiveInt(env.CERT_EXPIRY_ACTIVITY_WINDOW_DAYS, 90);
}
```

`parsePositiveInt` is the same "`parseInt(...) || default`, with the result required `> 0`" discipline `SiteConfig.js`'s `device_expiry_warning_days` resolution already documents and uses — unset/empty/non-numeric/zero/negative all fall back to the default.

## Email Templates

Two new `email_templates` rows, seeded via an `INSERT ... ON CONFLICT (template_key) DO NOTHING` migration statement, following the exact convention `1786596755665_baseline-schema.cjs`'s seed block and `1788300000000_align-team-transfer-email-template.cjs` already use:

- **`cert_expiry_self_digest`** — variables `first_name`, `device_list` (pre-formatted HTML block, one line per device: display identifier + expiry date, mirroring `EscalationService.sendAdminDigest`'s own `request_list` pre-formatted-block convention rather than a templating loop the `EmailService` doesn't support), `revoke_hint_url` (link to `/enrollment` or `/dashboard`, wherever the self-service revoke action already lives). Body states plainly: your certificate for X expires on Y; renew now via Z; if you no longer need this device, revoke it instead of letting it lapse.
- **`cert_expiry_team_digest`** — variables `first_name`, `team_sections` (pre-formatted HTML, one block per team the recipient administers with due devices, each listing its devices), `revoke_hint_url` (link to `/tasks`). Same self-revoke advisory, phrased for an admin acting on someone else's device.

Both registered in `client/src/utils/templateVariableHints.js`'s `TEMPLATE_VARIABLE_HINTS` map (Admin Email Template Editor advisory hints), following the existing one-line-per-key convention:

```js
cert_expiry_self_digest: ['first_name', 'device_list', 'revoke_hint_url'],
cert_expiry_team_digest: ['first_name', 'team_sections', 'revoke_hint_url'],
```

## Superseded Certificate Revocation (Requirement 8)

### `revoke_tak_certificates` payload extension

`server/workers/operationSchemas.js`'s existing `exactlyOneOf` entry for this operation type gains a third discriminator:

```js
revoke_tak_certificates: {
  exactlyOneOf: {
    client_uid: 'string',
    tak_usernames: 'object',
    cert_ids: 'object', // NEW: array of TAK certificate ids (numbers)
  }
}
```

`SyncWorker.resolveRevokeTargets` (the existing resolve-then-gate function every shape already flows through) gains a third branch: when `revokePayloadShape(payload) === 'cert_ids'`, `targetCertIds` is exactly the supplied array (validated numeric, deduplicated, sorted — same `sortCertIds` helper the other two branches already call), with no `certificates` catalog lookup needed at all for resolution (unlike the other two shapes, which must MATCH against the fetched catalog to turn a `client_uid`/username into cert ids) — this shape already IS the cert id set. `clientUids` for the resulting audit record is resolved by looking up which of the fetched `certificates` carry one of the target ids, purely for logging context, mirroring what the `tak_usernames` branch already does.

This keeps the existing four-rail gate structure (dry-run check, blast-radius cap, audit record, then the actual `DELETE`) entirely unchanged — `cert_ids` is a third way to ARRIVE at a `targetCertIds` array, not a new code path around the rails that already operate on that array.

### The enqueue call site

Both `DeviceEnrollmentService.generateSelfEnrollment` and `generateEnrollmentQrCode` share one new private helper, `#enqueueSupersedingRevoke(userId, actingUserId)`, called AFTER the new enrollment has been successfully built (mirroring this codebase's "local/durable effect first, best-effort side effect after" ordering — though here the "local effect" is the mint itself, which already happened by the time this runs). Keyed on `user_id`, NOT `client_uid` — neither mint call has a `client_uid` in hand at mint time (TAK Server assigns one only once the physical device actually uses the minted token); `tak_devices.user_id` is the one identifier both callers already hold (the principal's own `users.id`):

```js
async #enqueueSupersedingRevoke(userId, actingUserId) {
  const { rows } = await pool.query(
    'SELECT cert_id FROM tak_devices WHERE user_id = $1 AND revoked = false',
    [userId]
  );
  // Requirement 8.5: no prior live certificate -- ordinary first enrollment.
  if (rows.length === 0) return;
  // Requirement 8.2: MORE than one live row is genuinely ambiguous -- a
  // Self-Owned_Device principal may legitimately hold several (ATAK,
  // iTAK, CloudTAK, a second personal device). Guessing which one this
  // mint replaces risks revoking a certificate still in active use, so
  // this is a deliberate no-op, not an error.
  if (rows.length > 1) {
    logger.info({ userId, liveCertificateCount: rows.length }, 'Skipping Superseding_Revoke: principal holds more than one live certificate');
    return;
  }
  const supersededCertId = rows[0].cert_id;
  await EventPublisher.publishOperation(
    'revoke_tak_certificates',
    { cert_ids: [supersededCertId] },
    actingUserId
  );
  logger.info({ userId, supersededCertId }, 'Enqueued Superseding_Revoke for renewed certificate');
}
```

Read BEFORE the mint's own `DeviceSync`-driven row update overwrites `tak_devices.cert_id` to the new certificate — in practice this is safe regardless of exact timing, since `DeviceSync` runs on its own independent poll interval (typically minutes) and will not have observed the brand-new certificate yet at the moment `generateSelfEnrollment`/`generateEnrollmentQrCode` returns; the row this SELECT reads is still describing the certificate(s) that existed BEFORE this mint. Called with a fire-and-forget `.catch(err => logger.error(...))` at the call site, exactly like every other enqueue-after-mint step in this codebase (never allowed to fail the enrollment response itself — the certificate is already minted and usable regardless of whether its predecessor gets cleaned up).

For `generateEnrollmentQrCode` (the Team-Owned_Device path), a Team_Owned_Device's `users.id` legitimately holds at most one live certificate in the overwhelming common case (one device, one credential), so the single-live-row branch is expected to be the one that fires there; the multi-row skip mostly protects the self-service path, where several devices per human is normal.

## UI Changes

### Requirement 6: Dashboard "My Devices" renew prompt

`client/src/pages/Dashboard.jsx`'s existing "My Devices" card, which already computes each device's `classifyExpiry` state via `DeviceListRow`/`DeviceListCard` (Requirement 6.1's "existing classification"): a new banner, rendered above the device list only when `devices.some(d => classifyExpiry(d.expiresAt, ...) !== EXPIRY_STATES.NONE)`, reusing the amber-informational-banner treatment `MultipleCertificateWarning.jsx` establishes (text-carried state, `InformationCircleIcon`, non-alert). Its call-to-action is the EXISTING `<Link to="/enrollment">` — no new route, no new component beyond the banner itself.

### Requirement 7: `/tasks` rename and renewal sections

- `client/src/App.jsx`: `<Route path="/requests" element={<Navigate to="/tasks" replace />} />` added alongside the existing route (which moves to `/tasks`), so an old link/bookmark still resolves.
- `client/src/components/Layout.jsx`: `getNavigation`'s `{ name: 'Requests', href: '/requests', ... }` entry becomes `{ name: 'Tasks', href: '/tasks', ... }`, and its gating condition (`user?.isAdmin || user?.isTeamAdmin`) is REMOVED per Requirement 7.2 — the item is now unconditionally in `baseNavigation`. The badge-count `useEffect` ALREADY gates on `!user?.isAdmin && !user?.is_global_manager` (an early return, present before this feature), so this task's own contribution (Requirement 7.7) is adding `isTeamAdmin` to that existing condition and confirming it stays independent of the nav item's now-unconditional visibility — NOT a 403-avoidance fix (`GET /api/requests/pending` is not admin-scoped server-side; it filters to an empty visible set for a non-admin rather than rejecting the call), but an efficiency one: without this, a plain member's `Layout` mount would poll that endpoint every 60 seconds and on every tab-visibility change for a count that can only ever resolve to zero for them.
- `client/src/pages/Requests.jsx` (kept at this filename; only its route/nav label change) gains two new sections, rendered ahead of the existing two:
  - **My certificates needing renewal**: fetches the current user's own devices (reusing whatever the Dashboard card already fetches — `deviceManagementAPI.probeEnabled()`'s `devices` array, or a dedicated call if that hook isn't easily reused outside Dashboard; implementation detail for tasks.md) and lists only those `classifyExpiry`-imminent/expired, each with a "Renew" link to `/enrollment`. Visible to everyone.
  - **Team devices needing renewal**: for a Team_Admin/Global_Manager, fetches every team the viewer manages (`teamsAPI`-equivalent to `Team.getManagedTeamIds`, exposed via a small new or existing endpoint — likely extending `GET /api/devices` with an `expiringOnly` filter reusing `DeviceEnrollmentService.listAllDevices`'s existing `canManage` scoping, rather than a new endpoint) and lists each due device with a "Renew" action opening the existing per-device Enroll dialog (the same `EnrollmentView` modal `Devices.jsx`/`TeamDeviceList.jsx` already open).
  - Both new sections' "Renew" action calls the existing `devicesAPI.generateQrCode(deviceUserId)` (team-owned) or navigates to `/enrollment` (self-owned) — no new server route for renewal itself.

## Testing Notes

- Unit: `CertExpiryNotificationService.findEligibleCandidates` — pure-ish eligibility logic given injected `now`, a mocked `pool.query` for the `tak_devices`/`cert_expiry_notifications` reads. Cover: exactly-on-threshold (`daysLeft === thresholdDays` is due), activity-window boundary (`lastSeenAt` exactly `expiresAt - windowDays` is eligible, one ms earlier is not), the multi-tier-backlog collapse-to-most-urgent rule (Requirement 2.3), suspended/orphaned exclusion, `last_seen_at` null falling back to `issued_at`, both null failing the activity check.
- Unit: `sendSelfOwnedDigests`/`sendTeamOwnedDigests` — mocked `EmailService.sendEmail`, assert one call per recipient (never per device), assert the resolved-row write happens only after a successful send and never after a rejected one, assert a multi-team admin's digest spans every team in one email.
- Unit: Escalation_Round resolution — for a 4-level-deep team, assert round 1 reaches only depth-0 admins, round 4 reaches every depth including a depth-3 admin nobody else reaches, and an admin reached at round 1 also appears in round 2/3/4's resolved sets for the same device (additive, not replacing).
- Unit: `CertExpiryNotificationJob` — mirrors `RetentionCleanupJob.test.js`'s shape; assert `start()` is a no-op when either flag is disabled, assert `maybeRun()` does not double-fire within the same matching minute (the `lastRunDateKey` guard).
- Unit: `resolveRevokeTargets`'s new `cert_ids` branch (`server/workers/syncWorker.test.js`) — assert it bypasses catalog matching, assert `sortCertIds` still applies, assert the existing two shapes' tests are unaffected.
- Unit: `#enqueueSupersedingRevoke` — assert no enqueue when no prior live row exists (Requirement 8.4), assert the enqueued payload is exactly `{ cert_ids: [supersededCertId] }`, never including the just-minted certificate's own id.
- Integration: a real-Postgres test seeding a `tak_devices` row at each tier boundary and confirming `cert_expiry_notifications` rows land correctly across two consecutive simulated runs (second run must not re-email a tier the first run already resolved), following the `account-lifecycle-status.integration.test.js`/throwaway-database convention if the shared dev database lacks the new migration.
- Client: `Dashboard.test.jsx` extension for the renew banner's presence/absence; `Requests.test.jsx` (or a renamed equivalent) extension for the two new sections' render conditions and the nav-badge-fetch-gating fix; a `Layout.test.jsx` assertion that a plain, non-admin user renders the Tasks nav item but the badge-count effect issues no `requestsAPI.getPending()` call for that user.
