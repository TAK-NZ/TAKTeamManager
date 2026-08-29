# Certificate Expiry Notifications — Porting `check-expiring-certs.sh`

Source of truth for implementing a proper certificate-expiry check inside TAKTeamManager,
replacing the standalone bash script `docker-container/scripts/takserver/check-expiring-certs.sh`
that previously lived in the `tak-infra` repo (removed from that repo once this doc was written —
see git history there if the original file is needed for reference).

This is **not yet implemented**. It's a reference doc to build from later, not a spec — promote it
to a proper `.kiro/specs/` entry when the work is actually scheduled.

---

## What the original script did

A manual, run-it-yourself diagnostic (no cron, no scheduler — an admin had to execute it and read
the terminal output). It:

1. Queried TAK Server's Marti `certadmin` API for every non-revoked certificate expiring within the
   next month.
2. Queried the Marti `clientEndPoints` API for recent client connection activity.
3. Cross-referenced the two: for each expiring cert, checked whether that user had connected in the
   last 30 days, and printed either `✓ User active` or `⚠ User inactive`.

It was read-only — no renewal, rotation, or revocation. It never notified anyone; every user who saw
its output had to be physically watching the terminal (or reading a log file) at the time it ran.
Full analysis of this gap is in `tak-infra`'s `docs/CERT_ROTATION.md`, "Part 6: User and Device
Certificate Rotation" — the doc explicitly describes this as an unfinished component: "the logic is
already there, it just needs CloudWatch metric emission added and to be moved into confmaker's cron
schedule," listed as "Phase E" of that repo's cert-rotation implementation plan.

### Original script, in full

```bash
#!/bin/bash

# TAK Server Certificate Expiration Checker
# 
# This script identifies certificates expiring within the next month and checks
# if their associated users have been active in the last 30 days. It queries
# the TAK Server API to retrieve certificate data and client endpoint activity,
# then cross-references them to help administrators identify which expiring
# certificates belong to active vs inactive users.

set -euo pipefail

CERT_PATH="/opt/tak/certs/files/admin.pem"
KEY_PATH="/opt/tak/certs/files/admin.key"
KEY_PASS="atakatak"
BASE_URL="https://localhost:8443/Marti/api"

# Calculate dates
ONE_MONTH_FROM_NOW=$(date -d "+1 month" -u +"%Y-%m-%dT%H:%M:%S.000Z")
THIRTY_DAYS_AGO=$(date -d "-30 days" -u +"%Y-%m-%dT%H:%M:%S.000Z")

echo "Checking for certificates expiring before: $ONE_MONTH_FROM_NOW"
echo "Checking for user activity since: $THIRTY_DAYS_AGO"
echo

# Fetch certificates
CERTS=$(curl -s -k --cert "$CERT_PATH" --key "$KEY_PATH" --pass "$KEY_PASS" "$BASE_URL/certadmin/cert")
if [[ -z "$CERTS" ]]; then
    echo "Error: No response from cert API"
    exit 1
fi

# Fetch client endpoints
ENDPOINTS=$(curl -s -k --cert "$CERT_PATH" --key "$KEY_PATH" --pass "$KEY_PASS" "$BASE_URL/clientEndPoints")
if [[ -z "$ENDPOINTS" ]]; then
    echo "Error: No response from endpoints API"
    exit 1
fi

# Find expiring certificates
EXPIRING_CERTS=$(echo "$CERTS" | jq --arg cutoff "$ONE_MONTH_FROM_NOW" '
    .data[] | 
    select(.revocationDate == null and .expirationDate < $cutoff) |
    {userDn, clientUid, expirationDate, hash}
')

if [[ -z "$EXPIRING_CERTS" ]]; then
    echo "No certificates expiring in the next month"
    exit 0
fi

echo "Found certificates expiring in the next month:"
echo

# Process each expiring certificate
echo "$EXPIRING_CERTS" | jq -c '.' | while read -r cert; do
    USER_DN=$(echo "$cert" | jq -r '.userDn')
    CLIENT_UID=$(echo "$cert" | jq -r '.clientUid')
    EXPIRATION=$(echo "$cert" | jq -r '.expirationDate')
    HASH=$(echo "$cert" | jq -r '.hash')
    
    echo "Certificate: $USER_DN ($CLIENT_UID)"
    echo "  Expires: $EXPIRATION"
    echo "  Hash: $HASH"
    
    # Check if user has been active in last 30 days
    RECENT_ACTIVITY=$(echo "$ENDPOINTS" | jq --arg username "$USER_DN" --arg cutoff "$THIRTY_DAYS_AGO" '
        .[] | select(.username == $username and .lastEventTime > $cutoff)
    ')
    
    if [[ -n "$RECENT_ACTIVITY" ]]; then
        LAST_SEEN=$(echo "$RECENT_ACTIVITY" | jq -r '.lastEventTime')
        CALLSIGN=$(echo "$RECENT_ACTIVITY" | jq -r '.callsign')
        echo "  ✓ User active - Last seen: $LAST_SEEN (Callsign: $CALLSIGN)"
    else
        echo "  ⚠ User inactive - No activity in last 30 days"
    fi
    echo
done
```

Key mechanics worth pulling out explicitly, since they translate directly into the Node
implementation below:

- **Auth**: mutual TLS via the TAK Server admin cert/key pair (`admin.pem`/`admin.key`, passphrase
  `atakatak`), hitting TAK Server's own `https://localhost:8443/Marti/api/...` (i.e. run from inside
  the TAK Server container/task, not over the network).
- **Two API calls**: `GET /Marti/api/certadmin/cert` (all certs) and `GET /Marti/api/clientEndPoints`
  (per-client activity/last-seen).
- **Expiring-cert filter**: `revocationDate == null` (not already revoked) AND `expirationDate <
  <now + 1 month>`.
- **Activity cross-reference**: for each expiring cert's `userDn`, look for a `clientEndPoints` entry
  where `username == userDn` and `lastEventTime > <now - 30 days>`.
- **Output**: plain `echo` to stdout — this is the entire gap. No metric, no alarm, no email.

---

## Why this belongs in TAKTeamManager, not as a ported bash script

TAKTeamManager already has every building block this needs, built to a materially higher standard
than the bash version — reusing them is much less work than porting the script line-for-line, and
produces something that can actually **notify** someone (which the bash version never could).

### 1. Marti API access already exists — `TakServerService`

`server/services/TakServerService.js` already implements mutual-TLS access to the exact same Marti
`certadmin` endpoints the bash script hit, with meaningfully more rigor:

- `listCertificates()` — `GET /Marti/api/certadmin/cert` (same endpoint the bash script used for its
  first call). Returns the raw `TakCert[]` (camelCase: `id`, `creatorDn`, `subjectDn`, `userDn`,
  `hash`, `clientUid`, `issuanceDate`, `expirationDate`, `revocationDate`, ...).
- `listActiveCertificates()` / `listRevokedCertificates()` / `listLiveCertificates()` — a more
  correct version of the bash script's `revocationDate == null` filter. The class-level doc comment
  on `TakServerService` explicitly warns `revocationDate` is **not** a reliable revocation signal —
  verified live, certificates that are actually revoked still often carry a non-null
  `revocationDate` field. Membership in the `/revoked` view is the only real signal. **Use
  `listLiveCertificates()` for the expiring-cert scan, not `revocationDate == null` as the bash
  script did** — this fixes a latent correctness bug the original script had.
- `getClientEndpoints(params)` — `GET /Marti/api/clientEndPoints`, the same endpoint the bash script
  used for activity cross-referencing. Returns `ClientEndpoint[]` (`callsign`, `uid`, `username`,
  `team`, `role`, `lastEventTime`, `lastStatus`).
- Mutual TLS is handled via `buildMutualTlsAgentOptions`/`setAgentOptions`/`refreshAgent`, already
  wired to `AdminCredentialLoader`/`AdminCredentialRefreshJob` so a rotated admin credential is
  picked up without a restart — the bash script had no equivalent; it would silently start failing
  auth after any admin cert rotation until someone noticed.

None of this needs to be written from scratch. A new expiry-check service/job just calls
`takServerService.listLiveCertificates()` and `takServerService.getClientEndpoints()` and works with
the results in JS instead of shelling out to `curl`/`jq`.

### 2. Real notification delivery already exists — `EmailService` / `BroadcastEmailService`

The bash script's biggest limitation — it only prints, it never notifies anyone — is trivially fixed
here, because TAKTeamManager already has a working outbound email pipeline:

- `server/services/EmailService.js` — generic SMTP delivery (works with AWS SES's SMTP interface,
  Authentik's relay, or any SMTP provider), template-driven (`sendEmail(to, templateKey, variables)`,
  reading `subject_template`/`body_template` from the `email_templates` table), with an HTML +
  plain-text branded output via `wrapInBrandedTemplate`.
- `server/services/BroadcastEmailService.js` — resolves a filtered recipient set (`teamIds`, `role`,
  `channelIds`, `allUsers`) and sends to all of them via `EmailService.sendEmail`, with authorization
  scoping already built in (Global_Manager vs. team-admin-scoped sends).

For this feature, the natural notification targets are:
  - **The affected user directly** — if their own TAK username/DN can be resolved to a local `users`
    row (matching how `TakCertificateRevocationService.revokeUserTakCertificates` resolves a
    `users.username` from a target user id) — "your cert expires in N days".
  - **Team admins / Global_Managers** — a summary digest, reusing `BroadcastEmailService`'s existing
    `role: 'admin'`/`allUsers` filters rather than building new recipient-resolution logic.

Either path is a `sendEmail(...)` call away, once the expiring-cert list is resolved — no new SMTP
plumbing needed.

### 3. A scheduled-job pattern already exists

TAKTeamManager already runs several independent periodic jobs alongside the Sync_Worker's main poll
loop, all following the same shape: a plain `setInterval`/`clearInterval` wrapper class, with
`start()` running one pass immediately then scheduling the recurring interval, env-var-configurable
interval (clamped to a sane floor), and errors caught/logged without ever crashing the worker
process. This is the pattern to follow, not a new cron entry:

- `server/services/RetentionCleanupJob.js` — closest structural match (runs daily by default,
  deletes/cleans up based on age thresholds).
- `server/services/ExpiryScheduler.js` — runs every 15 minutes, sweeps vendor-grant/deployment-channel
  expiry.
- `server/services/SubscriptionPoller.js` — the closest match, since it already reads
  `getClientEndpoints()` for exactly this device/last-seen purpose (device-management feature) — see
  `DEVICE_MGMT_POLL_INTERVAL_SECONDS`/`DEVICE_MGMT_SYNC_INTERVAL_SECONDS` in `.env.example`.
- `server/services/DeviceSync.js` — already upserts each device's certificate metadata
  (`issued`/`expires`) from the `certadmin` API on its own interval
  (`DEVICE_MGMT_SYNC_INTERVAL_SECONDS`), i.e. **this repo already tracks certificate expiry dates for
  device-management purposes** — worth checking whether the expiry-notification job can read from
  that already-synced data instead of re-fetching `listCertificates()`/`listLiveCertificates()`
  itself, to avoid two independent pollers hitting the same Marti endpoint.
- `server/services/AdminCredentialRefreshJob.js` — same shape again, for admin credential refresh.

All of the above are started/stopped from `server/workers/syncWorker.js`'s `start()`/`stop()`, per
the comments in that file (see `ExpiryScheduler`/`RetentionCleanupJob` construction there) — a new
`CertExpiryNotificationJob` would slot in the same way.

### 4. Feature-flag precedent already exists

The `DEVICE_MGMT_ENABLED` / `DEVICE_MGMT_REVOKE_ENABLED` pattern in `.env.example` and
`server/config/deviceMgmt.js` is the template to follow for gating this feature: a dedicated env var
(e.g. `CERT_EXPIRY_NOTIFICATIONS_ENABLED`), off by default, checked before the job is constructed/
started at all — not merely before it does anything — so a disabled feature has zero footprint
(no polling, no credential loaded, no notification sent), mirroring the device-management flag's
explicit "no admin credential is loaded, no polling or sync runs" guarantee.

---

## Proposed implementation shape

Not a full spec — sketch only, to be fleshed out into a real `.kiro/specs/` entry when this is
scheduled:

1. **New service**: `server/services/CertExpiryNotificationService.js`
   - `findExpiringLiveCertificates({ withinDays = 30 })` — calls
     `takServerService.listLiveCertificates()` (NOT `revocationDate == null`, per the correction
     above), filters `expirationDate < now + withinDays`.
   - `crossReferenceActivity(expiringCerts, { activeWithinDays = 30 })` — calls
     `takServerService.getClientEndpoints()`, joins on `username === userDn` /`lastEventTime`, same
     logic as the bash script's `jq` cross-reference, just in JS.
   - Consider resolving `userDn`/`clientUid` back to a local `users` row (mirroring
     `TakCertificateRevocationService`'s user-resolution pattern) so a direct per-user email is
     possible, not just an admin digest.

2. **New job**: `server/services/CertExpiryNotificationJob.js`, same `start()`/`stop()`
   `setInterval` shape as `RetentionCleanupJob`. Suggested default: once daily (matching
   `CERT_ROTATION.md`'s "confmaker (daily cron)" framing), configurable via
   `CERT_EXPIRY_CHECK_INTERVAL_SECONDS`.
   - For each active (recently-seen) user with an expiring cert: send an email via `EmailService`
     (new `email_templates` row, e.g. `cert_expiry_warning`).
   - For inactive users: per `CERT_ROTATION.md`'s original design note ("For inactive users: revoke
     the cert (no point notifying)") — decide whether to also enqueue a
     `revoke_tak_certificates` Sync_Operation via the existing
     `TakCertificateRevocationService`/queue mechanism, or just include them in an admin summary
     digest instead. This is a product decision, not a technical one — flag it before building.
   - Send an admin summary digest via `BroadcastEmailService` (`role: 'admin'` or `allUsers`,
     depending on desired scope) listing every expiring cert found this run.

3. **Config additions** to `.env.example` (following the existing `DEVICE_MGMT_*` documentation
   style — full prose comment block per variable, defaults stated, server-only-vs-exposed called
   out explicitly):
   - `CERT_EXPIRY_NOTIFICATIONS_ENABLED` (default `false`)
   - `CERT_EXPIRY_WARNING_DAYS` (default `30`, matching the bash script's "next month" window)
   - `CERT_EXPIRY_ACTIVITY_WINDOW_DAYS` (default `30`, matching the bash script's "last 30 days"
     activity window)
   - `CERT_EXPIRY_CHECK_INTERVAL_SECONDS` (default once daily = `86400`)

4. **Tests**: unit tests for the service's filter/cross-reference logic (mirroring the existing
   `*.test.js` pattern alongside every other service in `server/services/`), plus an integration
   test if `TakServerService` is mocked the same way `TeamMembershipService.integration.test.js` or
   similar already do.

---

## Open questions to resolve before building

- **Revoke-on-inactive**: does inactive-user auto-revocation belong in this job, or should this job
  stay notification-only and defer revocation to a human via the existing manual revoke action
  (`TakCertificateRevocationService`)? The original `CERT_ROTATION.md` design assumed automatic
  revocation for inactive users ("no point notifying") — worth confirming that's still the desired
  behavior before wiring it into an automated job, since it's a destructive action.
- **Overlap with `DeviceSync`**: `DeviceSync.js` already polls certificate expiry data for
  device-management. Confirm whether this feature should read from that already-synced data (avoiding
  a second independent Marti poller) or intentionally stays decoupled from the device-management
  feature flag (`DEVICE_MGMT_ENABLED`) so it can run even when device management itself is disabled.
- **Per-user email deliverability**: this depends on `userDn`/`clientUid` being resolvable back to a
  local `users` row with a real email address. Confirm that mapping is reliable enough for direct
  per-user notification, or whether an admin-only digest is the safer initial scope.
