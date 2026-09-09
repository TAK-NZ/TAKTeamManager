# Callsign Mismatch Detection — Design Note (Phases 0–2 + 2.5)

Status: IMPLEMENTED (Phases 0-2 + 2.5). This note covers detection, in-app
notification, and a single first-detection email. Full time-based escalation
(manager-chain walk, eventual cert revocation) is explicitly OUT of scope and
deferred to a later "Phase 3".

## Problem

A TAK client connects with a callsign the user has typed into their client. We
assign each user a callsign (`computeCallsignAttributes`) and want to detect
when the connected client's callsign has diverged from the assigned one, tell
the user, and — because in practice very few users ever open this app — email
them once so the nudge actually reaches them.

## What "correct" means

The assigned callsign is `computeCallsignAttributes(userId, teamId)`'s output,
assembled by `CallsignService.assembleCallsign` as:

```
<Organisation segment>[-<Team segment>]-<Name segment>
```

- Organisation + Team segments are TAM-determined (from the team
  Ancestor_Chain: `callsign_prefix`, `country_code`, `callsign_level_selection`,
  `callsign_team_hyphenated`). The user cannot change these.
- The Name segment is the user-editable `users.callsign_suffix`.

The stored assembled value lives in `user_cache.tak_callsign` (and Authentik
`takCallsign`). It is NOT stored on `users`.

### The rule the user must satisfy

The user may **append** anything to the end of their assigned callsign, but may
not alter the assigned callsign itself. So, given `assigned` (e.g.
`FENZ-STL-J.Doe`) and `observed` (the callsign the client connected with):

- `observed === assigned` → **OK**
- `observed` starts with `assigned` **followed by a non-alphanumeric boundary
  character** (space, `-`, `(`, `.`, etc.) → **OK** (an append, e.g.
  `FENZ-STL-J.Doe (Tablet)`, `FENZ-STL-J.Doe-Drone`)
- anything else → **MISMATCH** (prefix diverged, or truncated, or a longer
  name that merely shares a string prefix like `FENZ-STL-J.Doews`)

Comparison is exact: no trim, case-sensitive (the assembled value has
deterministic casing). Content of the appended part is NOT inspected —
no bad-word filtering (a separate concern for later, and higher false-positive
risk than the objective prefix rule).

### Skips (never flagged)

- **CloudTAK connections** — CloudTAK prevents callsign changes at the source,
  so it cannot produce a real mismatch. Identified by the certificate
  `client_uid` prefix `ANDROID-CloudTAK-` (`tak_devices.client_uid LIKE
  'ANDROID-CloudTAK-%'`). This is a self-contained column check; no
  Connection_Alias inspection needed.
- **Teamless users** — their assigned callsign is ABSENT (not `'None'`, not
  `''`), so there is nothing to compare against. Skip.
- **Devices with no resolvable `user_id`** or a user with no email — skip the
  email (fall back to the in-app badge only) and log; never error the poll.

## Phase 0 — Capture the observed callsign

`GET /Marti/api/clientEndPoints` already returns `callsign` per entry; the
`SubscriptionPoller` currently reads only `uid`/`lastStatus`/`lastEventTime`
and discards it.

Changes:

1. **Migration** (new incremental `.cjs` on top of the baseline; never edit
   `schema.sql`): add to `tak_devices`
   - `observed_callsign text` (nullable) — current-state, like `connected`.
   - `callsign_violation_notified_at timestamptz` (nullable) — the
     first-detection email latch (see Phase 2.5).
   - `callsign_violation_first_seen_at timestamptz` (nullable) — supports the
     one-poll debounce, and gives Phase 3 real data later.
   Do both new-column additions in the same migration.

2. **The NEW `CallsignPoller`** (not the history `SubscriptionPoller`) writes
   `observed_callsign` from `SubscriptionInfo.callsign`, joining each live entry
   to its `tak_devices` row on `client_uid`. When one `client_uid` appears in
   multiple live entries, the winning callsign is the most recent by the entry's
   own recency signal (`lastReportMilliseconds`) — current-state semantics, NOT
   monotonic. Blank-`clientUid` and CloudTAK entries are ignored, so nothing is
   written for them.

Ownership: the `CallsignPoller` owns `observed_callsign`,
`callsign_violation_notified_at`, and `callsign_violation_first_seen_at`. The
history `SubscriptionPoller` still owns `last_seen_at`/`connected`. `DeviceSync`'s
upsert must never list any of these columns.

## Phase 1 — Classify (pure function)

`server/utils/callsignMatch.js` (no framework import, property-testable):

```
classifyObservedCallsign(observed, assigned) -> 'ok' | 'appended' | 'mismatch'
```

- `null`/empty `assigned` (teamless) → caller skips before calling.
- Implements the boundary-character rule above.

Property tests (fast-check-style): appending any string after `assigned` +
boundary char stays valid; altering any character inside the `assigned` portion
is a mismatch; `assigned` with no append is `ok`.

The comparison SOURCE is `user_cache.tak_callsign` (the already-assembled,
already-trusted value the rest of the UI reads), compared against
`tak_devices.observed_callsign` in ONE batched SQL join — no per-row
`computeCallsignAttributes` call (no N+1). Always compare against the CURRENT
`user_cache.tak_callsign`, never a stored snapshot, so a re-parented user or a
prefix edit re-evaluates correctly.

## Phase 2 — In-app notification (derived, no state)

Surfaced on the existing "you must act" surfaces (state carried in text + count,
never colour alone):

1. Nav **Tasks** badge + mobile notification bell (`Layout.jsx`) — a new derived
   count folded into `outstandingTaskCount`'s existing `Promise.allSettled`
   aggregation, so a failure of this source can't blank the renewal/request
   counts.
2. A section on **`/tasks`** (`Requests.jsx`): "This device is connecting with a
   callsign that doesn't match your assigned callsign `FENZ-STL-J.Doe` — please
   correct it," per offending device.
3. Optionally the Dashboard amber banner.

Refresh cadence is the existing client 60s `setInterval` + tab-refocus. So the
user sees the nudge within ~1 min of the data being present and it clears within
~1 min of a fix.

Scope for the BADGE: currently-connected (or seen-recently) mismatched devices,
so a user isn't nagged about a device they've stowed.

## Phase 2.5 — Single first-detection email (edge-triggered)

The rule: email ONCE on the `good → bad` transition. Never a second email while
it stays bad (even for a month). If the user fixes it and later re-breaks it,
email again (the fix re-arms the latch).

State: the `callsign_violation_notified_at` column. Per poll, per eligible
device (non-CloudTAK, resolvable assigned callsign):

- observed **OK/appended** → clear latch: `notified_at = NULL`,
  `first_seen_at = NULL`. (This is the re-arm.)
- observed **mismatch**:
  - if `first_seen_at IS NULL` → set `first_seen_at = now()`; send NO email yet
    (debounce — see below).
  - else if `notified_at IS NULL` (mismatch seen on a previous poll too) → this
    is the first CONFIRMED breakage: send one email, then set
    `notified_at = now()`.
  - else (`notified_at` already set) → do nothing (the "no second email" case).

**Debounce (one poll):** the first email requires the mismatch to persist across
two consecutive polls, killing transient flap/scratch-callsign false positives.
Since the email is the primary channel for most users, a false email is costlier
than one poll interval of delay.

**Connected-only by construction (SUPERSEDES the earlier not-gated-on-connected
note).** Because the source is `subscriptions/all` (live sessions only), both the
badge AND the email are inherently connected-only: a disconnected device is
absent from the feed. The debounce ("mismatch across two consecutive 1-min live
polls") therefore also means "still connected and still wrong," which is the
intended, less-noisy behaviour. A live entry with a blank `client_uid` or a
CloudTAK cert prefix is ignored before it reaches the latch logic.

**Ordering / transaction safety:** per server-conventions, NO email send inside a
DB transaction. The poller computes the set of devices needing an email, commits
its normal `observed_callsign`/state writes, then sends emails best-effort AFTER
commit (each individually try/caught, a failure logged and never throwing out of
`run()`). Stamp `notified_at` AFTER a successful send — a rare duplicate on a
mid-send crash is far better than silently never sending.

**Email plumbing:**
- New `email_templates` row seeded via `INSERT ... ON CONFLICT (template_key)
  DO NOTHING` in the same migration (matches every existing template). Key e.g.
  `callsign_mismatch_notice`; variables `{{first_name}}`, `{{assigned_callsign}}`,
  `{{observed_callsign}}`, `{{login_url}}`.
- Send via existing `EmailService.sendEmail(to, 'callsign_mismatch_notice',
  vars)`.
- Structure the template so a future manager recipient (Phase 3) is an added
  variable, not a rewrite.

## Out of scope (Phase 3, later)

Time-based escalation, manager-chain walk (would use `Team.getAncestorChain` /
`Team.isAdmin`, NOT the current `EscalationService` random-pick single-hop),
digest cadence, and eventual `revoke_tak_certificates` (reuse the existing
`client_uid`-scoped op and its four rails; disarmed = logged dry-run).

## Polling frequency — raise 5 min → 1 min (recommended, measure)

Set `DEVICE_MGMT_POLL_INTERVAL_SECONDS=60` (default is 300; 60 is already the
enforced floor, so this is an env-var change with no code change, fully
reversible).

Why do it here: this feature's entire notification chain — in-app nudge AND the
first-detection email — is gated on poll cadence. At the default 300s the app
can't even observe a wrong callsign for up to 5 minutes; at 60s that drops to 1.

Why it's a tradeoff, not a free win:
- `GET /Marti/api/clientEndPoints` returns HISTORY, not just currently-connected
  clients, so the response grows with the fleet and is now fetched + parsed 5×
  as often. This is the real cost axis — measure the response size on a
  representative server.
- TAK Server's tolerance for this rate is NOT profiled in this codebase (unlike
  Authentik, whose ceilings do NOT apply here — different API). Low-risk given
  the poll is two small circuit-breakered GETs coordinated by a job lock, but
  not no-risk. Posture: turn it up, then watch `clientEndPoints` response size
  and TAK Server load, and back off via the same env var if needed.

Coupling with the Phase 2.5 debounce (important): the first email requires a
mismatch to persist across TWO consecutive polls. That floor is therefore
`2 × interval` — ~10 minutes at 300s, ~2 minutes at 60s. So raising the poll
rate also tightens the debounce window. Mostly good (faster email), but it
slightly weakens the debounce's flap protection: a ~90s scratch callsign that
would have straddled a single 5-min boundary can now span two 1-min polls and
trigger an email. Still net-favourable, but tune the two settings TOGETHER, not
independently — if false-positive emails show up at 60s, the lever is a
longer debounce (require N>2 polls), not reverting the interval.

### Preferred target (pending live validation): split fast-live / slow-history

Rather than run the ONE heavy history poll 5× as often, the better shape is two
jobs on two intervals:

- Keep `GET /Marti/api/clientEndPoints` (HISTORY, big, fleet-sized) at 5 min. It
  owns `last_seen_at`/`connected` and only needs to be timely enough for those.
- Add a SEPARATE lighter job at 1 min hitting only `GET /Marti/api/subscriptions/all`
  (LIVE — currently-connected sessions only), doing only the callsign
  comparison + notification. The history poller is left untouched.

This is also arguably the MORE CORRECT source for this feature: a callsign
mismatch is a "what is this client connected as right NOW" question, not a
historical one.

VERIFIED against `docs/refs/tak-server-openapispec.json`: `subscriptions/all`
returns `ApiResponseSetSubscriptionInfo`, and `SubscriptionInfo` DOES carry both
`callsign` and `clientUid` (also `username`, `dn`). So the shape supports it.

THE UNRESOLVED RISK — attribution. Per `tak-server-integration.md` (verified
live), `SubscriptionInfo.clientUid` was EMPTY in 14 of 16 live entries; the
populated ones were the ETL/service connections. The schema allows a
`clientUid`; the live server frequently does not populate it for real clients.
That is exactly why the existing poller uses this endpoint only as a best-effort
freshness signal, never a source of record. So a live entry may report a wrong
`callsign` with a blank `clientUid` — telling you a callsign is wrong but not
WHOSE it is.

Possible rescue: join on `SubscriptionInfo.username` → `users` (or `dn`) when
`clientUid` is blank. This is a DIFFERENT join key than the poller uses today
and its reliability is UNVERIFIED. If attribution turns out unreliable, this
approach silently UNDER-detects (misses mismatches it can't attribute) — which
is arguably worse than the simple approach's honest 5-minute lag.

RESOLVED (attribution): real interactive clients (ATAK/iTAK/WinTAK) DO populate
`SubscriptionInfo.clientUid`; only API-only connections (e.g. CloudTAK ETLs) leave
it blank. Those blank-`clientUid` entries are exactly the ones this feature skips
anyway (CloudTAK is excluded via the `ANDROID-CloudTAK-` cert prefix), so the
`clientUid` sparsity that made this endpoint a poor last-seen source of record is
a NON-ISSUE for callsign attribution: the live feed can be joined to a
`tak_devices` row by `client_uid` directly, with NO `username`/`dn` fallback
needed. Blank-`clientUid` entries are simply ignored.

CHOSEN DESIGN (the split): a NEW `CallsignPoller` job runs every 1 minute against
`GET /Marti/api/subscriptions/all` (LIVE sessions only), joins each entry to a
`tak_devices` row on `client_uid` (ignoring blank-`clientUid` and CloudTAK
entries), compares its `callsign` against `user_cache.tak_callsign`, and drives
the notification + first-detection email. The existing `SubscriptionPoller`
(history, `clientEndPoints`) is UNCHANGED and keeps owning
`last_seen_at`/`connected` at its 5-minute cadence. New clamped-interval env var
`CALLSIGN_POLL_INTERVAL_SECONDS` (default 60, floored at 60), mirroring the
`DeviceSync`/`SubscriptionPoller` scheduler shape. `DEVICE_MGMT_POLL_INTERVAL_SECONDS`
stays 300.

CONSEQUENCE — the check is now CONNECTED-ONLY by construction. `subscriptions/all`
carries only currently-connected sessions, so a device that connected with a bad
callsign and then disconnected does NOT appear. This is fine (even desirable) for
the in-app badge, and it simplifies the debounce: "mismatch on two consecutive
1-minute live polls" means "still connected AND still wrong." It does change the
email from "observed wrong at any point" to "still connected and wrong across two
polls" — acceptable, since real clients hold a session, and it avoids emailing
about a device the user has already put away. This SUPERSEDES the earlier
"email is NOT gated on connected" note in Phase 2.5 below.

## Effort estimate

- Phase 0 (capture + migration): ~0.5–1 day
- Phase 1 (pure classifier + tests): ~0.5 day
- Phase 2 (badge/page/banner + client tests): ~1–2 days
- Phase 2.5 (email latch + debounce + template + poller pass): ~1–1.5 days

Total: roughly **3.5–5 days**.

## Open decisions to confirm before building

1. Boundary characters that count as a valid "append" delimiter (proposed: any
   non-alphanumeric — space, `-`, `.`, `(`).
2. Badge scope: currently-connected only, or seen-within-N. (Email is not
   connected-gated regardless.)
3. Whether the Dashboard banner is in or out for the first release.
