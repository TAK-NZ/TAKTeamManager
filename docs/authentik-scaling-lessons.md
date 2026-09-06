# Authentik scaling — lessons learned

Operational lessons from scaling TAK Team Manager against Authentik at
FENZ-class size (~15,000 users, ~640 teams). This is the narrative companion
to two other artifacts, and defers to them for detail rather than repeating it:

- `.kiro/steering/authentik-scaling.md` — the durable design rules (rate
  limiter, priority queue, group-authoritative reconcile, rate ceilings).
- `docs/authentik-ratelimit-profiling.md` — the measured evidence behind the
  read/write ceilings, including the 2026-09 prod-DB re-profile that raised the
  write ceiling from 3 to 4.

The rest of this file is the "what we learned the hard way" layer: the failure
modes, the incident, and the safeguards that came out of it.

## Authentik does not rate-limit — it degrades

The single most important fact. The `/api/v3/core/*` management API returns no
`429`, no `Retry-After`, no `X-RateLimit-*`. Push it too hard and latency
climbs until requests hit the 30s client timeout (and the ALB emits sporadic
503s), rather than being cleanly rejected. Everything below follows from this:

- The rate limiter is a **static, shared token bucket** (server + worker +
  every replica draw from the same budget), because a per-process limiter
  would multiply the real ceiling by the process count and blow it.
- The adaptive-backoff signal is **client timeouts and 503s**, never `429`.
- "Are we over the ceiling?" is read from **p99 latency trending up while CPU
  is still moderate** — the bottleneck is the database / per-task concurrency,
  not app CPU. Do not wait for CPU saturation to back off.

## Per-user fan-out is infeasible; reconcile whole groups

At a sustained-safe 3–4 writes/sec, touching every user individually at 15K
scale is simply not viable (hours of writes). The design consequence, validated
by the payload-size sweep (a single group-membership PATCH of 15,000 members
completes in sub-second time, indistinguishable from a 1-member PATCH):

- Group membership is reconciled by **one full-diff PATCH per group** that sets
  the whole membership set, never a per-user add/remove fan-out, and never
  chunked.
- This makes each reconcile op **idempotent and self-healing**: a missed event
  is corrected by the next reconcile.

## Reading a list is now local, not live-Authentik

`GET /api/users` (and `GET /api/devices`) source their rows from the LOCAL
database (`users` + `user_cache`), not a live per-request Authentik fetch. Why:

- It removes a live Authentik read on every page load and every search
  keystroke — exactly the load the rate-limiting work exists to shed.
- It makes the page independent of Authentik availability.
- It lets pagination, search, directory-scope narrowing, and the large-directory
  filters (team + alphabet) all run in SQL, so `pagination.total` is an EXACT
  local count.

The one trade-off: a user created DIRECTLY in Authentik (out of band) appears
only after the next sync. This app is the normal creation path (it writes the
local row synchronously), so the gap only affects out-of-band creates.

Authentik's `last_login` had no local column and so was lost when `/users` went
local — it now rides the periodic sync into `user_cache.last_login`
(migration `1790000000000`), a mutable mirror refreshed every sync.

## The false-orphan incident (2026-09) and its fix

### What happened

During a concurrent bulk import + an Authentik DB upgrade, the periodic sync's
**Reconciliation_Sweep** false-orphaned ~1,100 real, still-existing users in a
runaway loop (416 → 1,107 over a few minutes). Each false orphan also set
`is_active = false`, cleared the cached callsign/colour to `'None'/'None'`, and
enqueued a certificate-revoke.

### Root cause

`authentikSync.js`'s user-fetch paginates `GET /core/users/`. The sweep then
marks any local user ABSENT from that fetched set as `orphaned`. The fetch loop
terminated "cleanly" (`pagination.next` went falsy) while the accumulated set
was **incomplete** — an unhealthy/mid-upgrade Authentik returned a short page or
a prematurely-absent `next`. An incomplete set that *looks* complete, fed to a
sweep that trusts it, orphans everyone it didn't happen to see. As the import
kept adding users the missed set grew, so the false-orphan count grew every
cycle. (An earlier variant of this same class — a pagination race from the
default alphabetical ordering during a concurrent import — had already been
partially addressed with `ordering=pk`; that fix does not catch a short/errored
page from an unhealthy DB.)

### The fix: a completeness guard

The sweep now runs only when the fetch is **provably complete**. Authentik
reports the true total on every page as `pagination.count`; the sync compares
`allUsers.length` against it and **skips the sweep entirely** when they
disagree (logging an error and recording the skip on `sync_status`, visible to
an operator). The cache/batch sync still runs on a partial fetch — that write is
additive and self-correcting (it only writes rows it saw, never removes) — only
the destructive, effectively one-way sweep is withheld. When Authentik reports
no count at all (older shapes / test doubles), the guard falls back to running,
since there is no signal to prove incompleteness.

The pre-existing guard that refused an *empty* fetched-id list was necessary but
insufficient: it did not catch a partial-but-non-empty fetch. The completeness
guard closes that gap.

### The kill-switch

`AUTHENTIK_SYNC_ENABLED` is an operational stop for the periodic sync AND its
sweep. It is an **opt-OUT** (the sync runs by default; it is disabled ONLY when
the value is exactly `'false'`) — deliberately unlike this app's usual
`'true'`-only feature flags, because the sync must stay on by default. Use it to
halt the sweep during a bulk import or an Authentik maintenance window. With the
completeness guard in place the sweep is now safe under a partial fetch, but the
kill-switch remains the immediate, no-deploy way to stop it if something looks
wrong.

### Recovery is possible because orphaning is a local flag

Orphaning never deletes the federated Authentik identity (that is a
non-negotiable — deleting an Authentik user is unrecoverable). Recovery of the
false orphans was therefore: verify against Authentik that the identities still
exist, reset `account_status='active'` / `is_active=true`, restore
`user_cache.is_active`, and cancel the still-pending `revoke_tak_certificates`
sync operations before the worker could execute them (marked
`failure_category='validation'` with an incident note). The cleared
callsign/colour self-heal on the next complete sync.

## A bulk import leaves a long reconcile tail

Importing ~15K users enqueues tens of thousands of `reconcile_owned_group` +
`assign_user_to_global_channels` operations. Draining them at a safe Authentik
pace (3–4 writes/sec, shared across processes) is inherently an **hours-long
background job** — this is expected, not a bug. Consequences to remember:

- The periodic sync will be **slow to first-complete** while it competes with a
  large backlog for the shared token budget (it is queued alongside, not
  starved by a mis-set read limit — check the backlog before blaming the read
  ceiling).
- Do **not** try to "fix" the slowness by cranking rate limits: under a heavy
  backlog the instance is already near saturation, so raising limits pushes it
  past the collapse point. Let the backlog drain.
- Re-running a bulk import is safe/idempotent (identity resolution), so a
  partial import (e.g. failures during an Authentik outage) can be resumed by
  re-running over the same CSV; genuinely-conflicting rows (e.g. a duplicate
  callsign-suffix within a team) are real data conflicts, not retry candidates.
