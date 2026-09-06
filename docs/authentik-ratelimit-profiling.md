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
