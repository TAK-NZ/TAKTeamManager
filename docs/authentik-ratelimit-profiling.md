# Authentik API load profiling — evidence for rate-limit ceilings

This is the raw evidence artifact behind the Authentik rate-limiting and
bulk-reconciliation design (see `.kiro/steering/authentik-scaling.md`). It
records what the Authentik management API tolerated under load, so the
configured read/write rate ceilings are grounded in measurement rather than
a guess. Re-run the profiler (`scripts/profile-authentik-ratelimit.js`) and
update this note if the Authentik version, task sizing, or database class
changes — the numbers below are specific to the environment described.

## Why this exists

Authentik publishes no documented rate limit for its `/api/v3/core/*`
management API (its hardening docs cover brute-force/login policies only).
So there was no published number to design against, and the only
responsible way to pick ceilings was to measure the real deployment's
behaviour under increasing load.

## Environment profiled

- Target: `https://account.test.tak.nz` (PDX / us-west-2), fronted by an
  Application Load Balancer (`tak-demo-auth`).
- Authentik version 2026.8.1.
- **Two configurations tested:**
  - **dev-test:** Authentik server task 1024 CPU / 2048 MB, `desiredCount: 1`,
    `db.serverless` Postgres.
  - **prod-shaped (the authoritative run):** server task 2048 CPU / 4096 MB,
    `desiredCount: 2`, `db.serverless` Postgres. This matches production ECS
    compute sizing (auth-infra `cdk.json` `prod` context) except the database
    (prod uses `db.r7g.large` ×2); the DB difference is the main caveat on
    these numbers.
- Method: `scripts/profile-authentik-ratelimit.js` — an open-loop stepped
  ramp holding a fixed offered request rate for a sustained window, plus a
  one-shot burst mode and a group-PATCH payload-size sweep. All load ran
  against disposable objects tagged `ttm-ratelimit-probe-*`, which were
  created, loaded against, and deleted; post-run inventory confirmed zero
  probe objects remained.
- Baseline (idle): server CPU ~12% avg on dev-test / ~3–10% avg on
  prod-shaped; ALB ~1.7 rps; `TargetResponseTime` ~0.37s avg, p99 ~1.5–2.3s;
  zero 5xx.

## Headline finding

**Zero HTTP 429 responses were observed in any test, at any rate, on either
configuration.** No `Retry-After` and no `X-RateLimit-*` headers were ever
returned. The API does not rate-limit; instead it **degrades under load** —
latency climbs until requests time out (30s client timeout) or the ALB
returns sporadic 503s as targets stop responding in time. The constraint is
backend capacity, not a request-rate governor.

Notably, on the prod-shaped run the server ECS CPU only reached ~20–37% when
reads had already collapsed to multi-second latency — so the read ceiling is
**not** raw app CPU but a downstream limit (database / per-task request
concurrency). On the weaker dev-test box the bottleneck was clearer app-CPU
saturation to 100%.

## Prod-shaped results (authoritative)

### Read ramp — `GET /core/users/` + `GET /core/groups/` (page_size=50), 30s/step

| offered rps | total | 2xx | 503 | timeouts | p50 ms | p99 ms |
|---|---|---|---|---|---|---|
| 5  | 150 | 150 | 0  | 0  | 168   | 1315  |
| 10 | 300 | 300 | 0  | 0  | 794   | 5737  |
| 20 | 600 | 514 | 11 | 75 | 18051 | 30006 |

Clean at 5 rps; degrading but still all-2xx at 10 rps; collapsing at 20 rps.
**Sustainable read rate ≈ 5–8 rps** for these heavy list endpoints.

### Write ramp — `PATCH /core/groups/{uuid}/ {users:[…]}`, 20s/step

| offered rps | total | 2xx | timeouts | p50 ms | p99 ms |
|---|---|---|---|---|---|
| 2  | 40  | 40  | 0   | 844   | 1677  |
| 5  | 100 | 100 | 0   | 1985  | 3838  |
| 10 | 200 | 98  | 102 | 30000 | 30008 |
| 15 | 300 | 0   | 300 | —     | —     |
| 20 | 400 | 0   | 400 | —     | —     |
| 30 | 600 | 0   | 600 | —     | —     |

Clean at 2 and 5 rps; collapse to timeouts from 10 rps up. **Sustainable
write rate ≈ 3–5 rps.**

### Payload-size sweep — one `PATCH /core/groups/{uuid}/ {users:[N]}`

| array size N | status | latency ms |
|---|---|---|
| 1     | 200 | 717 |
| 10    | 200 | 714 |
| 50    | 200 | 726 |
| 100   | 200 | 1075 |
| 500   | 200 | 713 |
| 1000  | 200 | 812 |
| 5000  | 200 | 669 |
| 10000 | 200 | 734 |
| 15000 | 200 | 807 |

**Array size has no meaningful effect on latency up to 15,000 elements.** A
15K-element membership PATCH completes in sub-second time, indistinguishable
from a single-element one. This is the decisive result for the reconciler:
**one group PATCH can set an entire team's membership in a single call, with
no need to chunk**, up to at least 15K members.

## Derived rate ceilings (recommended `.env` defaults)

Chosen conservatively, below the observed collapse point, because these
numbers come from a `db.serverless` database (prod uses a larger fixed
instance, so prod likely tolerates more — but we must not design against an
unmeasured optimistic assumption), and because background reconciliation
should never run at the edge of capacity:

- `AUTHENTIK_RATE_LIMIT_WRITE_PER_SEC` = **3** (sustained background writes),
  with a small `AUTHENTIK_RATE_LIMIT_WRITE_PRIORITY_PER_SEC` = **2** reserved
  for urgent mutations (delete/suspend/revoke), total staying at/under the
  ~5 rps clean write ceiling.
- `AUTHENTIK_RATE_LIMIT_READ_PER_SEC` = **5** (below the ~5–8 rps read
  ceiling).

These are deliberately low, which is itself a finding: **it reinforces that
bulk/batched operations are essential, not optional** — per-user fan-outs at
thousands of users are simply infeasible at 3–5 writes/sec, whereas the
group-authoritative single-PATCH reconcile fits comfortably.

## Implications carried into the design

1. **The throttle's feedback signal cannot be 429 alone.** Since this
   deployment never emits 429, the adaptive-backoff layer must treat
   **client timeouts and 503s** as the "back off now" signal, and the static
   configured ceiling is the primary defence, not a fallback.
2. **Ceilings are low and must be shared across processes.** At 3–5 writes/s
   total, a per-process limiter (server + worker + replicas) would blow the
   budget several times over — the shared/central limiter decision is
   validated.
3. **Whole-group single-PATCH reconcile is validated** end to end (payload
   sweep), so the group-authoritative bulk reconcile needs no chunking for
   realistic team sizes.

## Caveats

- Database class differs from prod (`db.serverless` here vs `db.r7g.large`
  ×2 in prod); prod may tolerate higher rates. Re-profile a true prod-shaped
  DB before raising ceilings.
- The environment is shared: during one run an unrelated ~21K-requests/minute
  spike (not generated by this profiling) briefly drove CPU to 100%. Treat
  single-run numbers as indicative and re-run if results look anomalous.
- The open-loop profiler measures the server's response to an *offered* rate;
  reported timeouts mean the server did not answer within 30s, which is the
  operative failure mode for a real caller too.

## Follow-up: true prod-class database (2026-09, write ceiling raised 3 → 4)

The caveat above ("Re-profile a true prod-shaped DB before raising ceilings")
was acted on: the test Authentik's database was upgraded to the production
class, and the write ceiling was re-measured against it under real sustained
load (a live 15K-user bulk import plus the worker draining its reconcile
backlog), with ALB `TargetResponseTime` p50/p99, ECS CPU, and 5xx read from
CloudWatch at each step. This was a step-up experiment on the RUNNING system,
not the offered-rate profiler, so the numbers are "behaviour under real load"
rather than "response to a synthetic ramp" — complementary evidence.

| write/sec | ALB p99 | ECS CPU avg / max | 5xx |
|---|---|---|---|
| 3 (prior ceiling) | ~1.6s | ~28% / 44% | 0 |
| 4 (**new ceiling**) | ~3.5–3.9s | ~46% / 65% | 0 |
| 5 | ~3.7–4.5s | ~53% / 72% | occasional (isolated) |

**Decision: `AUTHENTIK_RATE_LIMIT_WRITE_PER_SEC` raised from 3 to 4.** write=4
is the sweet spot on the prod-class DB — a real throughput gain over 3, CPU
under half on average with headroom, zero 5xx, and a p99 (~3.5s) that is fine
for background sync writes no user waits on. write=5 was rejected: it produced
little additional throughput (the worker's per-op pattern makes it not purely
write-bound) while pushing CPU toward 70%+ and starting to emit isolated 5xx.
Crucially, the prod-class DB did **not** exhibit the catastrophic latency
collapse the older `db.serverless` box showed at write=5 (~19s p99) — it
degrades gracefully instead, which is what made 4 safely reachable.

`AUTHENTIK_RATE_LIMIT_READ_PER_SEC` was left at **5**: under the same load the
instance was already near saturation (CPU ~55–80%, p99 ~3.7–4.8s, sporadic
5xx), so there was no read headroom to claim at that moment — a heavy backlog
of writes dominates the instance, and raising reads on top would push it
further into the red rather than help. Re-baseline reads against an IDLE
prod-class instance before raising that ceiling.

### The latency-collapse signature (how to read a step-up)

Across both the old and new DBs the failure mode is the same and worth naming:
**Authentik never returns 429; it degrades.** The tell that a ceiling has been
exceeded is p99 climbing toward multiple seconds (and eventually the 30s
timeout) *while ECS CPU is still only moderate* — i.e. the bottleneck is
downstream (DB / per-task concurrency), not app CPU. Back off the moment p99
trends up sharply or any sustained 5xx appear, not when CPU saturates.
