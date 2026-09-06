---
inclusion: auto
name: authentik-scaling
description: How TAK Team Manager scales its Authentik integration — bulk group-membership reconciliation (group-authoritative full-replace), the read/write/priority rate-limiting design, and the empirically-derived rate ceilings. Load when touching Authentik sync, group membership, the sync worker, rate limiting, bulk import, or anything that writes to Authentik at scale.
---

# Authentik scaling: bulk reconciliation + rate limiting

This is the design of record for making TAK Team Manager's Authentik
integration scale to thousands of users. It is grounded in load profiling of
a prod-shaped Authentik (see `docs/authentik-ratelimit-profiling.md` for the
raw evidence). Update BOTH this file and that note together if the approach
or the measured limits change.

## The one principle that drives everything

TAK Team Manager is authoritative for exactly three families of Authentik
groups, and for each it can compute the COMPLETE desired member set from its
own database:

- **`tak_Teams_*`** — team primary-channel groups (`channels.authentik_group_id`).
- **Global channels** — BCH read/write (`bch_channels.read_group_id`/
  `write_group_id`) and region (`region_channels.group_id`).
- **`CloudTAKAgency<id>`** — one per team; members are the team's
  Direct_Admin_Set. Keyed by NAME (`CloudTAKAgency<team_id>`), no stored pk.

Because TTM owns the WHOLE membership of these groups, the safe bulk
primitive is **`PATCH /core/groups/{uuid}/ {users:[<all desired pks>]}`** — a
full replace of the group's member list. Profiling confirmed a single such
PATCH carries up to 15,000 members in sub-second time (no chunking needed).

The safe axis for a bulk replace is the GROUP, never the USER. TTM does not
own a user's whole `groups` array (a user may be in SSO/app/role groups TTM
knows nothing about), so a `PATCH /core/users/{pk}/ {groups:[…]}` full
replace is only safe when the complete set is reconstructable:
- a BRAND-NEW user (no prior groups — no GET needed), or
- an existing user AFTER `GET /core/users/{pk}/`, unioning the non-owned
  groups back in.

Authentik's `PATCH` replaces the whole relation array — it does NOT append.
This is the same replace-the-whole-dict trap as attribute PATCH
(`UserAttributesService`). Every reconcile handler's doc comment must state
it.

## Two mechanisms, one reconciler

Both compute the full desired set fresh from the DB at execution time and
write the full truth (never a delta), so they converge and never flip-flop.

1. **Event-driven targeted reconcile (`reconcile_owned_group`)** — when a
   change touches a group TTM owns, enqueue one op keyed by the group; the
   worker issues ONE group PATCH. Replaces the old per-user
   `add_user_to_group`/`remove_user_from_group` fan-out for owned groups.
2. **Periodic anti-drift sweep** — a worker `setInterval` job, feature-
   flagged and paced, that walks all owned groups, computes desired-vs-current,
   and PATCHes only the groups that differ. Corrects any missed event.

Authority: the sweep is the source of truth; event-driven reconciles are a
latency optimisation. Never "optimise" an event path into writing deltas.

### Hard, tested invariant: fail closed on an empty/partial desired set

A desired-set query that returns zero rows because of a DB error or a partial
read must be distinguishable from a legitimately empty group. On any doubt,
SKIP the group — never PATCH `users:[]`. This is the same class of bug as the
`authentikSync.js` mass-orphaning incident: discriminate on the run's
OUTCOME, never the size of the derived set.

The mass-orphaning incident recurred (2026-09) and its fix is now built, and
generalises the same principle to the READ side: `authentikSync.js`'s
Reconciliation_Sweep marks a local user `orphaned` when it is absent from the
periodic user fetch. That fetch paginates `GET /core/users/`, and a mid-upgrade
/loaded Authentik can return a short page or a prematurely-absent
`pagination.next`, terminating the loop "cleanly" with an INCOMPLETE set that
looks complete — orphaning every user it didn't see (confirmed live: ~1,100
real users false-orphaned during a concurrent import). The **completeness
guard**: the sync compares the accumulated user count against the
`pagination.count` Authentik reports on every page and SKIPS the sweep entirely
when they disagree (logging + a `sync_status` note), while still running the
additive cache write. Same rule as above — the sweep's trust is gated on the
fetch being PROVABLY complete, not on the set being non-empty. See
`docs/authentik-scaling-lessons.md`. An operator can also hard-stop the sweep
with the `AUTHENTIK_SYNC_ENABLED=false` kill-switch (`feature-flags.md`).

## Scenario handling (all must work at scale)

- **Large new-user batch into one org (the 15K test):** `POST /core/users/`
  stays per-user (unavoidable — need the pk). Membership is ONE combined
  `PATCH /core/users/{pk}/ {groups:[…], attributes:{…}}` per new user (safe:
  new user, full set known, no GET), NOT an N-op fan-out. Then settle the
  affected owned groups with a few `reconcile_owned_group` PATCHes instead of
  letting 15K users each re-touch shared global-channel groups.
- **New org with many sub-teams:** group creation is `POST /core/groups/`-
  bound (no bulk create exists) — pace it, create-or-reuse by name for
  idempotency, ~2 groups per team (`tak_Teams_*` + `CloudTAKAgency<id>`).
  Membership follows cheaply once groups exist. A membership reconcile for a
  not-yet-created group is retryable, not a hard failure.
- **Day-to-day moves (user or whole team):** enqueue one
  `reconcile_owned_group` per AFFECTED owned group. Cost scales with the
  number of groups whose membership changed, not the number of members —
  moving a 500-person team costs the same as a 5-person team.

## Rate limiting & priority (four layers, outermost first)

1. **Token buckets, SHARED across processes.** Separate `read` and `write`
   buckets plus a reserved `write-priority` bucket. State lives in Postgres
   (atomic refill-and-consume, consistent with the worker's existing
   `FOR UPDATE SKIP LOCKED` coordination) so the AGGREGATE rate across the
   main server + every worker replica stays under the ceiling. A per-process
   bucket is WRONG — at these low ceilings it multiplies by process count.
   (Reads MAY use a cheaper process-local bucket if the Postgres round-trip
   per read proves too costly; writes must be central.)
2. **Priority-aware queue claim.** A `sync_operations.priority` column (new
   incremental migration on the baseline); claim ordered by
   `(priority ASC, created_at ASC)`. High-priority ops (`delete_*`, suspend,
   `revoke_tak_certificates`, `cleanup_orphaned_authentik_user`) pre-empt
   bulk background work; the reserved priority bucket guarantees an urgent
   mutation gets a token even while a bulk import has drained the background
   write budget.
3. **One consolidated Authentik client.** Today `authentik.js` (axios +
   circuit breaker + least-privilege token) and the worker's raw
   `fetchWithTimeout` are parallel implementations. Consolidate onto a single
   `authentikRequest({kind, priority}, fn)` chokepoint: acquire token →
   circuit breaker → HTTP. The limiter prevents overload; the breaker reacts
   to failure.
4. **Adaptive feedback that does NOT rely on 429.** Profiling showed this
   Authentik emits NO 429 and NO `Retry-After`/`X-RateLimit-*` headers — it
   degrades into latency/timeouts/503 instead. So the back-off signal MUST
   include client timeouts and 503s, not just 429. The static configured
   ceiling is the primary defence; adaptive back-off is the safety net.

### Empirically-derived defaults (see the profiling note)

Original measurement on a prod-SHAPED stack (2 vCPU ×2 tasks, `db.serverless`):
reads clean to ~5–8 rps, writes clean to ~3–5 rps, both collapsing into
timeouts above that, with zero 429s. A 2026-09 FOLLOW-UP re-measured against
the true prod-CLASS database under real sustained load (a live 15K import +
worker backlog drain) and raised the write ceiling: at write=4 the prod-class
DB held p99 ~3.5s, CPU <half, zero 5xx; write=5 degraded (CPU ~70%+, isolated
5xx, little extra throughput) but did NOT collapse the way the serverless box
did at 5. Current `.env` defaults:

- `AUTHENTIK_RATE_LIMIT_WRITE_PER_SEC=4` (raised from 3 on the prod-class DB;
  see `docs/authentik-ratelimit-profiling.md`'s follow-up section)
- `AUTHENTIK_RATE_LIMIT_WRITE_PRIORITY_PER_SEC=2`
- `AUTHENTIK_RATE_LIMIT_READ_PER_SEC=5` (NOT raised — under a heavy write
  backlog the instance was already near saturation, so there was no read
  headroom to claim; re-baseline reads against an IDLE prod-class instance
  before raising this)
- `AUTHENTIK_RATE_LIMIT_ENABLED=true`

These are still deliberately low, and that is the point: per-user fan-outs are
infeasible at ~4 writes/sec, which is exactly why the group-authoritative bulk
reconcile is mandatory rather than optional. A 15K bulk import leaves a
tens-of-thousands-op reconcile backlog that drains over HOURS at this pace —
expected, not a fault; do not raise ceilings to "speed it up" while the
instance is already loaded (that pushes it past the collapse point).

## Conventions this design must follow (from existing steering)

- Every flag is read via a named helper and true ONLY for the exact string
  `'true'`, defaulting off (`feature-flags.md`). Planned flags:
  `BULK_GROUP_RECONCILE_ENABLED`, `OWNED_GROUP_SWEEP_ENABLED`,
  `AUTHENTIK_RATE_LIMIT_ENABLED`.
- Every env var documented in `.env.example` with a safe default (`tech.md`).
- New schema is a `node-pg-migrate` `.cjs` incremental migration on top of
  the baseline — never hand-edit `schema.sql` (`tech.md`, `structure.md`).
- Every new `operation_type` needs a `server/workers/operationSchemas.js`
  entry (parity enforced by `operationSchemas.test.js`) and an idempotent,
  create-or-reuse worker handler (`server-conventions.md`).
- Group-membership writes stay enqueued as `sync_operations`, never
  synchronous from a request handler; enqueue on the caller's open
  transaction client (`server-conventions.md`).
- Pure diff/decision logic goes in `server/utils/` (no framework import) so
  property tests can reach it; DB-touching desired-set queries go in
  `server/services/` (`structure.md`).

## Rollout posture

Ship the reconciler dark behind its flag; run the sweep in dry-run (compute
and log diffs, PATCH nothing) to validate the desired-set queries against
real Authentik state before granting write authority — mirroring the
certificate-revoke dry-run rail. Only then flip enqueue sites from per-user
ops to `reconcile_owned_group`.

## Implementation status (as built)

- **Phase 1 (rate limiting + priority) — DONE.** Shared Postgres token
  buckets (`rate_limit_buckets`, lanes read/write/write_priority),
  `sync_operations.priority` with priority-aware claim ordering, and the
  single `authentikRequest.run({kind}, fn)` chokepoint that `authentik.js`,
  `syncWorker.js`, `authentikSync.js`, and `userAttributes.js` all route
  through. Flag `AUTHENTIK_RATE_LIMIT_ENABLED` (off by default → transparent
  pass-through). Config in `server/config/authentikRateLimit.js`; the
  op-type→priority map in `server/config/syncOperationPriority.js`.
- **Phase 2 (reconciler, dark + dry-run) — DONE.** `reconcile_owned_group`
  worker op + `server/services/OwnedGroupReconciler.js`. Desired-set queries
  per family (team_channel / bch_read / bch_write / region / cloudtak) that
  mirror the event-path definitions, the full-replace `replaceGroupMembers`
  PATCH primitive, fail-closed on a thrown desired-set query, and dry-run.
  Flags `BULK_GROUP_RECONCILE_ENABLED` (off by default → inert no-op) and
  `BULK_GROUP_RECONCILE_DRY_RUN` (inverted: dry-run ON unless exactly
  `'false'`) in `server/config/bulkGroupReconcile.js`. `AuthentikApiError`/
  `TakServerApiError` live in `server/workers/apiErrors.js` so the reconciler
  can throw the worker's classified error type without a circular import.
- **Phase 3 (flip enqueue sites + anti-drift sweep) — DONE.** The
  `server/services/OwnedGroupReconcileEnqueuer.js` helpers enqueue one
  `reconcile_owned_group` per affected group. Gated by
  `isBulkGroupReconcileEnabled()` AT THE CALL SITE (so the old per-user path
  is byte-identical when off), the following flipped:
  - **Team-channel sites** (bounded → strict win): `TeamMembershipService`
    `addUserToTeam`/`removeUserFromTeam`, `UserProvisioningService`
    `createAndAddUser`, and `TeamTransferService`'s revoke side — one
    `team_channel` reconcile per affected channel instead of per-user
    add/remove.
  - **Bulk org/global drivers** (O(users)→O(groups)): the channel-access
    route (`resync_org_channel_tier_access` → per-tier region reconciles)
    and `GlobalChannelService.assignAllUsersToGlobalChannels` (→ per-channel
    bch/region reconciles).
  - **Deliberately KEPT per-user** (do not "finish flipping" these): the
    single-user `assign_user_to_global_channels` on add (cheap; the sweep
    owns the group axis, and a full BCH-read reconcile on every add would
    re-PATCH thousands), and the teamless global-channel REMOVAL in
    `removeUserFromTeam` — a group reconcile cannot drop a teamless-but-
    active user from a BCH read group (desired set is "every active user"),
    so the targeted removal is the only thing that revokes their global
    access and must run regardless of the flag.
  - **Anti-drift sweep:** `server/services/OwnedGroupSweepJob.js`, started by
    the worker, gated on BOTH `OWNED_GROUP_SWEEP_ENABLED` and
    `BULK_GROUP_RECONCILE_ENABLED`, interval `OWNED_GROUP_SWEEP_INTERVAL_MINUTES`
    (default 60, floored at 1). Enqueues a reconcile for every owned group;
    the rate-limited worker drains them.
  - CloudTAK create/update/delete and team-channel group create/delete were
    left unchanged (already whole-group reconciles or create/delete, not
    per-user fan-out).

## Validation status (2026-09)

Validated live against the prod-class test Authentik. The migration
(`1789900000000`) was applied to a real database, the rate limiter was
validated under load, and a real 15K-user bulk import was run through the
reconciler with `BULK_GROUP_RECONCILE_ENABLED` on (dry-run). Findings folded
in above: the write ceiling was re-measured and raised to 4; the false-orphan
recurrence drove the completeness guard + `AUTHENTIK_SYNC_ENABLED` kill-switch;
`GET /api/users` and `GET /api/devices` were migrated off live-Authentik reads
to the local `users`/`user_cache` model (removing a per-request Authentik read
on every list/search).

Still outstanding: taking `BULK_GROUP_RECONCILE_DRY_RUN` to `false` (real group
PATCHes) and enabling the anti-drift sweep (`OWNED_GROUP_SWEEP_ENABLED`) in
sustained operation — both were kept in their safe posture (dry-run on, sweep
off) through the import and its recovery.

## Load testing against Authentik

Use `scripts/profile-authentik-ratelimit.js` (read-only by default; write/
mixed modes operate only on disposable `ttm-ratelimit-probe-*` objects and
clean up after). NEVER load-test against shared production Authentik. The
test environment is shared — coordinate before generating sustained load,
watch ECS/ALB CloudWatch during a run, and always verify cleanup
(`--cleanup-only`) afterward, because a saturated server can silently fail
the in-run cleanup.
