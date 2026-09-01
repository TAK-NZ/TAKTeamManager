# Requirements Document

## Introduction

TAK Team Manager already computes, per device, whether a TAK Server certificate is imminently expiring or already expired (`client/src/utils/expiryWarning.js`'s `classifyExpiry`, fed from `tak_devices.expires_at`, which `DeviceSync` keeps current from TAK Server's own certadmin API). That classification is purely visual today — it highlights a row on `/devices`, a team's Team Devices tab, the Dashboard's "My Devices" card, and `UserDevicesModal`, but nothing ever tells anyone *unless they happen to be looking at one of those pages*. A device whose owner has not opened the app in weeks gets no warning before its certificate lapses and TAK Server starts refusing it.

This feature closes that gap with a scheduled email pipeline — modelled directly on the existing `EscalationService`'s daily-digest-at-a-configured-local-time mechanism — plus two renewal entry points in the UI: a page-level prompt on the Dashboard's "My Devices" card for a self-owned device, and a new "Certificates Needing Renewal" list on the renamed `/tasks` page (formerly `/requests`) for devices a Team_Admin or Global_Manager administers.

It also fixes a related, pre-existing gap this feature's design surfaced: renewing a device's or a self-owned account's TAK Server certificate today leaves the *previous* certificate live on TAK Server indefinitely — `DeviceSync` silently starts tracking only the newest one, but the old one is never revoked. This feature adds a Superseding_Revoke step to both enrollment-mint paths so a renewal actually retires the certificate it replaces.

This is a `requirements-first` feature spec, following the convention established by `account-lifecycle-management` and the other nine completed specs indexed in `.kiro/specs/README.md`.

## Glossary

- **Cert_Expiry_Tier**: one of four configured `(threshold_days, escalation_round)` pairs, evaluated daily against a device's live certificate: `(30, 1)`, `(15, 2)`, `(8, 3)`, `(1, 4)`, in that day-descending order. All four `threshold_days` values are independently configurable via `.env`; the escalation-round mapping (which recipients each tier reaches, see Requirement 4) is fixed at 1-2-3-4 and is not itself configurable.
- **Cert_Expiry_Activity_Window**: a single configured day count (`CERT_EXPIRY_ACTIVITY_WINDOW_DAYS`, default 90) gating whether a due tier actually sends an email. A device is eligible for an email at any tier only if its `last_seen_at` (or, absent that, `issued_at` — see Requirement 2) falls within `Cert_Expiry_Activity_Window` days *before the certificate's own `expires_at`* — i.e. the same fixed 90-day activity requirement applies at every tier, not a per-tier window. This exists to never email about a test certificate that was minted and then abandoned within days.
- **Days_Left**: `CEIL((expires_at - now) / 1 day)`, evaluated once per scheduled run against the run's own `now`.
- **Cert_Expiry_Notification_Record**: one row in the new `cert_expiry_notifications` table, keyed on `(client_uid, cert_id, threshold_days)`, recording that a given Cert_Expiry_Tier has been resolved (either emailed or deliberately skipped as stale — see Requirement 3's catch-up rule) for a given certificate. A certificate is identified by `(client_uid, cert_id)`, not `client_uid` alone, so a renewed certificate — a new `cert_id` on the same `client_uid` — starts every tier fresh with no manual reset.
- **Self-Owned_Device**: a `tak_devices` row whose `user_id` resolves to a `users` row with `is_team_device = false` — a human's own enrolled certificate (ATAK, iTAK, CloudTAK, or a second personal device).
- **Team-Owned_Device**: a `tak_devices` row whose `user_id` resolves to a `users` row with `is_team_device = true`, as defined in the `device-management`/`takserver-enrollment` specs.
- **Escalation_Round**: which admins a Cert_Expiry_Tier's notification reaches for a Team-Owned_Device, resolved via `Team.getAncestorChain` on the device's Direct_Membership team. `Team.getAncestorChain` is root-first — its `depth 0` is always the Organisation, and its LAST row (the chain's highest `depth`) is the device's own Direct_Membership team itself, at that team's own Team_Depth (call it `D`). Round 1 reaches only that team's own direct (non-inherited) admins — the chain's row at `depth D` (the device's own team, NOT `depth 0`); round 2 adds `depth D-1`'s direct admins (one level up, toward the Organisation); round 3 adds `depth D-2`'s; round 4 reaches every direct admin in the full ancestor chain regardless of its depth (down to and including `depth 0`, the Organisation), unconditionally. Additive across rounds — an admin reached at round 1 keeps being reached at rounds 2-4 for the same device. (Corrected during this spec's own design review: an earlier draft of this definition read `depth 0` as round 1, which is backwards — `depth 0` is the Organisation, the FURTHEST point from the device, which is what round 4 is for.)
- **Renew action**: the existing, unmodified device enrollment/re-enrollment capability — `DeviceEnrollmentService.generateSelfEnrollment` for a Self-Owned_Device, `generateEnrollmentQrCode` for a Team-Owned_Device — surfaced from two new UI entry points this feature adds (Requirements 6, 7). This feature introduces no new minting mechanism.
- **Superseded_Certificate**: the certificate a Renew action's freshly minted certificate replaces — the `client_uid`'s previously live (non-revoked) certificate, if one existed at mint time.
- **Superseding_Revoke**: the new step, added to both enrollment-mint paths, that enqueues a Revoke_Operation (as defined in `account-lifecycle-management`'s glossary) targeting exactly the Superseded_Certificate's `cert_id` once the new certificate has been successfully minted.
- **Digest**: one email per recipient per scheduled run, listing every device/tier due for that recipient in that run — never one email per device.

## Requirements

### Requirement 1: Notification Tracking Schema

**User Story:** As an operator, I want the system to remember which expiry warnings have already been sent for a given certificate, so that a daily job never re-sends the same warning and a renewed certificate is tracked as a clean slate.

#### Acceptance Criteria

1. THE App SHALL provide a new table, `cert_expiry_notifications`, with columns `client_uid` (references the device this row concerns), `cert_id` (the specific certificate this row concerns), `threshold_days` (which Cert_Expiry_Tier this row concerns), `notified_at` (when this row was written), and a UNIQUE constraint on `(client_uid, cert_id, threshold_days)`.
2. THE App SHALL treat a Cert_Expiry_Tier as already resolved for a certificate if and only if a `cert_expiry_notifications` row exists matching that certificate's current `(client_uid, cert_id)` and that tier's `threshold_days` — never keyed on `client_uid` alone, so that a renewed certificate (a new `cert_id`) is eligible for every tier again with no migration or manual reset.
3. THE App SHALL NOT delete a `cert_expiry_notifications` row as part of this feature's own normal operation. (A row referencing a `client_uid` whose `tak_devices` row is later deleted by `DeviceSync`'s existing stale-row cleanup becomes orphaned bookkeeping with no further effect — acceptable, since it blocks nothing and matches this codebase's general "retain history" bias.)

### Requirement 2: Eligibility

**User Story:** As an operator, I want a warning to fire only for a certificate that is genuinely in use and only once per tier, so that abandoned test certificates and already-notified thresholds never generate noise.

#### Acceptance Criteria

1. WHEN evaluating a live (non-revoked), non-null-`expires_at` `tak_devices` row against a Cert_Expiry_Tier, THE App SHALL consider that tier DUE if `Days_Left <= threshold_days` for that tier, evaluated against the scheduled run's own `now`.
2. THE App SHALL consider a DUE tier ELIGIBLE for that certificate only if it is not already resolved per Requirement 1.2, AND the device's `last_seen_at` (or, when `last_seen_at` is null, `issued_at`) is no earlier than `expires_at` minus `CERT_EXPIRY_ACTIVITY_WINDOW_DAYS`. A device with both `last_seen_at` and `issued_at` null SHALL be treated as failing the activity check (ineligible) rather than as satisfying it.
3. WHEN more than one tier is simultaneously DUE and unresolved for the same certificate in the same scheduled run (e.g., after a job outage spanning several tiers' thresholds), THE App SHALL email for the single most urgent (smallest `threshold_days`) eligible tier only, and SHALL write a `cert_expiry_notifications` row for every other DUE-and-eligible-or-not tier for that certificate in that run without emailing for them — so a resumed job never stacks multiple backlog emails for one device, and every tier this rule skips is still marked resolved per Requirement 1.2 and never reconsidered.
4. WHEN a DUE tier fails the activity check in Requirement 2.2, THE App SHALL NOT write a `cert_expiry_notifications` row for it and SHALL re-evaluate it on every subsequent scheduled run (an inactive device that becomes active again before its certificate expires must still receive its warning once it does).
5. THE App SHALL exclude a `tak_devices` row from every tier's evaluation when its resolved `users.account_status` is `'suspended'` or `'orphaned'` (as defined in `account-lifecycle-management`) — an account that cannot currently authenticate has no one who can act on a renewal warning.
6. THIS Requirement governs email eligibility ONLY. THE App SHALL NOT apply the Cert_Expiry_Activity_Window, or any tier/round concept from this feature, to what `classifyExpiry`-driven UI highlighting shows on `/devices`, a Team Devices tab, or "My Devices" — those continue to use only the pre-existing `DEVICE_MGMT_EXPIRY_WARNING_DAYS` threshold, unchanged by this feature.

### Requirement 3: Self-Owned_Device Notification Delivery

**User Story:** As a user with my own enrolled device, I want an email when its certificate is about to lapse, so that I can renew it before losing access.

#### Acceptance Criteria

1. WHEN a Self-Owned_Device's certificate has an ELIGIBLE Cert_Expiry_Tier (Requirement 2), THE App SHALL include that device on the digest email sent to the device's `user_id`'s own `users.email`.
2. WHEN a single user owns more than one Self-Owned_Device each with an eligible tier in the same run, THE App SHALL send that user exactly one digest email listing every such device, never one email per device.
3. THE digest email SHALL state, for each listed device, a human-readable device identifier and its certificate's expiry date, and SHALL advise the recipient that if they no longer need the device, they should revoke its certificate rather than let it lapse unrenewed — naming the existing self-service revoke action.
4. THE App SHALL mark each included device's resolved tier(s) per Requirement 1.2/2.3 only after the digest email send call returns successfully; a failed send SHALL leave every tier for that run's candidates unresolved so the next scheduled run retries them.

### Requirement 4: Team-Owned_Device Notification Delivery and Escalation

**User Story:** As a Team_Admin, I want to be notified when a device certificate for a team I administer is about to lapse, without being copied on every certificate in a large organisation unless it is genuinely escalated to my level.

#### Acceptance Criteria

1. WHEN a Team-Owned_Device's certificate has an ELIGIBLE Cert_Expiry_Tier, THE App SHALL resolve that tier's Escalation_Round recipient set via `Team.getAncestorChain` on the device's Direct_Membership team, per the Escalation_Round definition in the Glossary, and SHALL include that device on the digest email sent to each resolved recipient's `users.email`.
2. WHEN a single admin's resolved recipient set includes more than one Team-Owned_Device with an eligible tier across one or more teams they administer in the same run, THE App SHALL send that admin exactly one digest email listing every such device, grouped by team, never one email per device.
3. THE digest email SHALL state, for each listed device, its Device_Display_Name, its owning team, and its certificate's expiry date, and SHALL advise that if the device is no longer needed, its certificate should be revoked rather than renewed.
4. THE App SHALL exclude an admin who is themselves suspended or orphaned (Requirement 2.5's account_status check, applied to the RECIPIENT here rather than the device owner) from a digest send.

### Requirement 5: Daily Digest Scheduling

**User Story:** As an operator, I want this feature's emails to go out once a day at a predictable local time, consistent with the existing admin-notification digest, so recipients aren't emailed at arbitrary hours.

#### Acceptance Criteria

1. THE App SHALL evaluate every Cert_Expiry_Tier and send every resulting digest once per day, at the local time defined by the EXISTING `DIGEST_HOUR`/`DIGEST_MINUTE`/`DIGEST_TIMEZONE` environment variables `EscalationService` already reads (default 9:00 `Pacific/Auckland`) — this feature introduces no separate schedule or timezone configuration.
2. THE App SHALL run this feature's scheduled job only while a new, independent flag, `CERT_EXPIRY_NOTIFICATIONS_ENABLED`, is exactly the string `'true'`, following the exact boolean-env convention `server/config/deviceMgmt.js`'s `isDeviceMgmtEnabled`/`isDeviceMgmtRevokeEnabled` already establish (unset, empty, or any other value including `'TRUE'`/`'1'` yields disabled). Default: disabled.
3. THE App SHALL run this feature's scheduled job only while `DEVICE_MGMT_ENABLED` is also `'true'` — this feature reads `tak_devices`, which only carries meaningful data while device management is enabled — and SHALL treat `CERT_EXPIRY_NOTIFICATIONS_ENABLED='true'` with `DEVICE_MGMT_ENABLED` unset/false as inert (no job started, no query issued, no email sent), never an error.
4. WHEN either flag in Criteria 2/3 is not enabled, THE App SHALL start no timer, open no additional database connection beyond what is already open, and send no email for this feature.

### Requirement 6: Renew Prompt for a Self-Owned Device

**User Story:** As a user viewing my own devices, I want a clear way to renew a certificate that is expiring soon, without having to know that "Add Device" is the same action.

#### Acceptance Criteria

1. WHEN the Dashboard's "My Devices" card contains at least one device whose live certificate `classifyExpiry`s as imminent or expired (the existing, pre-existing classification — no new threshold), THE App SHALL render a page-level prompt within that card advising that a certificate needs renewal, with a call-to-action that navigates to the existing self-enrollment flow (`/enrollment`).
2. THE App SHALL NOT render a per-device-row "Renew" button distinct from the existing enrollment link — Requirement 6.1's page-level prompt is the entire self-owned renewal surface, per the product decision that a self-service enrollment mint is not scoped to one existing certificate row and a per-row button would misrepresent that.
3. WHEN no device in the card has an imminent or expired certificate, THE App SHALL render the card exactly as it does today, with no prompt.

### Requirement 7: `/tasks` Page (renamed from `/requests`) and Team-Owned Renewal List

**User Story:** As any signed-in user, I want one place that shows me what currently needs my attention, with admin-only content clearly separated from what applies to everyone.

#### Acceptance Criteria

1. THE App SHALL rename the route currently at `/requests` to `/tasks`, updating the nav item's label and link in `client/src/components/Layout.jsx`, and SHALL keep `/requests` reachable as a redirect to `/tasks` rather than a broken link.
2. THE App SHALL make `/tasks` reachable by any authenticated user, regardless of admin status — a change from today's `isAdmin || isTeamAdmin`-gated nav visibility.
3. `/tasks` SHALL render up to four sections, each rendered only when it has content or content-eligibility for the current viewer, in this order: (a) the current viewer's own devices needing renewal (imminent/expired, per the existing `classifyExpiry` threshold — same rule as Requirement 6.1), visible to every user; (b) Team-Owned_Devices needing renewal across every team the current viewer administers (via `Team.getManagedTeamIds`, mirroring `/devices`' own admin-scoping), visible only to a Team_Admin or Global_Manager; (c) the existing pending access-request list, unchanged, visible only to a Team_Admin or Global_Manager; (d) the existing Org_Interest_Requests panel, unchanged, visible only to a Global_Manager.
4. EACH device listed in sections (a)/(b) SHALL carry a "Renew" action that opens the SAME enrollment/QR-generation flow the existing `/devices`, Team Devices tab, and Dashboard "Add Device" link already use for that device — no new minting code path.
5. THE nav badge count on the `/tasks` (formerly Requests) item SHALL continue to reflect only pending access/org-interest requests, unchanged by this feature — the new renewal sections do not contribute to that count.
6. WHEN a device listed in section (a) or (b) is successfully renewed, THE App SHALL remove it from that section's list without requiring a full page reload, mirroring the existing post-action refetch convention on this page.
7. THE App SHALL gate the nav badge-count fetch (`requestsAPI.getPending()` and the org-interest count) in `client/src/components/Layout.jsx` on `user?.isAdmin || user?.isTeamAdmin`, independent of `/tasks`' own visibility from Criterion 7.2. (Verified during implementation: `GET /api/requests/pending` is NOT admin-scoped server-side — `request:read` sits in `roleDefaults.authenticated_user`, and the route itself filters to a visible subset, empty for a non-admin, rather than rejecting the call — so this criterion is NOT a 403-avoidance fix. It exists purely so a plain member's `Layout` mount does not repeatedly poll (every 60s, and on every tab-visibility change) an endpoint that will always resolve to a count of zero for them.)

### Requirement 8: Superseded Certificate Revocation on Renewal

**User Story:** As an operator, I want renewing a device's certificate to retire the certificate it replaces, so that a renewal actually reduces the number of live credentials for that device rather than silently adding to them.

#### Acceptance Criteria

1. WHEN `DeviceEnrollmentService.generateSelfEnrollment` or `generateEnrollmentQrCode` successfully mints a new certificate for a principal (identified by `users.id`, since neither mint call knows a `client_uid` at mint time — TAK Server only assigns one once the physical device actually uses the minted token) that already held EXACTLY ONE live (non-revoked) `tak_devices` row on that SAME `user_id`, THE App SHALL enqueue a Revoke_Operation targeting exactly that Superseded_Certificate's `cert_id` — never every certificate on that `user_id`, and never the newly minted one.
2. WHEN the principal held MORE THAN ONE live `tak_devices` row at mint time (a Self-Owned_Device principal may legitimately hold several — ATAK, iTAK, CloudTAK, a second personal device — per the Self-Owned_Device Glossary entry), THE App SHALL enqueue NO Superseding_Revoke at all, since which of several devices a self-service mint is meant to replace is genuinely ambiguous and guessing wrong would revoke a certificate still in active use. This is a deliberate, silent no-op (logged at most informationally, never as an error) — not a defect to fix by picking one.
3. THE App SHALL extend the `revoke_tak_certificates` Sync_Operation payload schema with a third, mutually-exclusive discriminator shape, `{ cert_ids: [...] }`, resolved by the Sync_Worker directly against the supplied certificate id set rather than by `client_uid` or `tak_usernames` matching — the existing two shapes are unchanged.
4. THE Superseding_Revoke enqueue SHALL be subject to the EXISTING `DEVICE_MGMT_REVOKE_ENABLED` arming flag and Revoke_Blast_Radius_Cap exactly as every other Revoke_Operation caller already is (a disarmed revoke completes as a logged dry-run, per existing `device-management` behaviour) — this feature introduces no new gating logic.
5. WHEN no live certificate already existed for that `user_id` at mint time (a first enrollment, or the sole live certificate having already been revoked by some other means), THE App SHALL enqueue no Superseding_Revoke — this is the ordinary case for a first-time enrollment and SHALL NOT be logged as an error or anomaly.
6. THE App SHALL determine "already held a live certificate" by reading `tak_devices` rows for that `user_id` (the rows `DeviceSync` already keeps current) rather than issuing a fresh TAK Server API call, since a device with no live certificate simply has no `tak_devices` row (per `DeviceSync`'s own documented "no group, no upsert" behaviour) or has `revoked = true` on file.

### Requirement 9: Configuration

**User Story:** As an operator, I want every new threshold this feature introduces to be configurable via `.env`, with the documented defaults from the feature's design, so I can tune it for my deployment without a code change.

#### Acceptance Criteria

1. THE App SHALL read four independently configurable day-count environment variables for the four Cert_Expiry_Tier thresholds — `CERT_EXPIRY_TIER1_DAYS` (default 30), `CERT_EXPIRY_TIER2_DAYS` (default 15), `CERT_EXPIRY_TIER3_DAYS` (default 8), `CERT_EXPIRY_TIER4_DAYS` (default 1) — each falling back to its documented default when unset, empty, non-numeric, zero, or negative.
2. THE App SHALL read one environment variable, `CERT_EXPIRY_ACTIVITY_WINDOW_DAYS` (default 90), for the single Cert_Expiry_Activity_Window applied uniformly across all four tiers, with the same fallback discipline as Criterion 1.
3. THE App SHALL document `CERT_EXPIRY_NOTIFICATIONS_ENABLED`, the four tier-day variables, and `CERT_EXPIRY_ACTIVITY_WINDOW_DAYS` in `.env.example`, following the existing full-prose-comment-block style already used for `DEVICE_MGMT_ENABLED`/`DEVICE_MGMT_REVOKE_ENABLED`/`DEVICE_MGMT_EXPIRY_WARNING_DAYS`, each explicitly stating its default and that it is read server-side only.
4. THE App SHALL NOT expose any variable from this Requirement through `GET /api/config/public` — every one of them is a capability/scheduling input, not a presentation value (contrast `DEVICE_MGMT_EXPIRY_WARNING_DAYS`, which the feature-flags steering document explicitly carves out as client-exposed for that reason).

## Out of Scope

- **Auto-revoking a certificate for being unused**, independent of its expiry date. The Cert_Expiry_Activity_Window (Requirement 2) only gates whether an *expiring* certificate's owner gets emailed; it never causes a revoke on its own. A dormant-but-not-yet-expiring certificate is untouched by this feature. A future, separate "revoke a certificate that hasn't been used in N days regardless of expiry" sweep was raised during this feature's design and deliberately deferred.
- **Per-row "Renew" for a Self-Owned_Device.** Self-enrollment mints a credential for the identity as a whole, not for one existing certificate row; Requirement 6 is a page-level prompt by deliberate product decision, not a missing feature.
- **Notification preferences / opt-out.** Every eligible recipient is emailed; this feature does not add a per-user or per-team notification-preference setting (the pre-existing `admin_notification_preferences` table, used by `EscalationService`, is not read or extended by this feature).
- **SMS, push, or any non-email channel.**
