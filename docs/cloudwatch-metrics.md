# CloudWatch metrics & alarms for TAK Team Manager

Guidance for the CDK deployment of this service: which metrics to surface and
which alarms to create. Written for the agent implementing the CDK stack.

This is grounded in real failure modes this service exhibited at FENZ scale
(~15K users) — see `docs/authentik-scaling-lessons.md` and
`docs/authentik-ratelimit-profiling.md`. Three lessons drive every choice
below, so keep them in mind rather than reaching for the usual CPU/memory
defaults:

1. **Authentik does not rate-limit — it degrades.** No 429, no `Retry-After`.
   Over the ceiling shows up as climbing latency and eventual timeouts/503s,
   NOT as an error code. So the "we're pushing too hard" signal is **p99
   latency + timeout count**, never a 429 metric.
2. **The bottleneck is downstream of app CPU.** On the prod-class DB, Authentik
   latency collapsed while its ECS CPU was still only moderate (~55–70%). CPU
   alarms alone would have missed it — alarm on latency and on the DB.
3. **A bulk import leaves an hours-long reconcile tail, and a bad sweep can
   silently mass-orphan real users.** Both were invisible until observed by
   hand. The queue-age and orphaning metrics below exist specifically so they
   are never invisible again.

There are two categories of work here, with different owners:

- **App-emitted custom metrics** — the application/worker must emit these
  (they have no AWS equivalent). Not yet implemented; see "Emission plan".
- **AWS-native metrics** — already published by ECS/ALB/RDS; the CDK stack just
  needs to add alarms.

---

## A. App-emitted custom metrics (namespace `TAKTeamManager`)

Emit via **CloudWatch EMF** (embedded metric format): the app writes a
structured log line and CloudWatch extracts the metric from it. This adds no
extra AWS API calls and no rate-limit cost, and works uniformly in the app
container and the Sync_Worker. Do NOT use `PutMetricData` on a hot path.

Recommended source: a lightweight periodic emitter in the Sync_Worker's poll
loop (e.g. once per 60s) that reuses the exact queries behind
`GET /api/admin/sync-status` (`server/routes/orgDomains.js`), plus a wrapper at
the single `authentikRequest.run(...)` chokepoint for the per-call latency /
wait / failure counters.

### Sync backlog (how far behind the background processes are)

| Metric | Type / unit | Dimensions | Why |
|---|---|---|---|
| `SyncQueueDepth` | Gauge, Count | `OperationType` | `sync_operations` pending total. Per-type so a stuck `reconcile_owned_group` pile is distinguishable from `revoke_tak_certificates`. |
| `SyncQueueOldestAgeSeconds` | Gauge, Seconds | — | Age of the oldest pending row. **The most important backlog metric** — depth alone doesn't show whether it's draining; a monotonically climbing age does. |
| `SyncQueueFailedCount` | Gauge, Count | — | Rows in `failed` / permanent-validation state. |

### Worker liveness

| Metric | Type / unit | Why |
|---|---|---|
| `SyncWorkerHeartbeatAgeSeconds` | Gauge, Seconds | `NOW() - sync_worker_heartbeat.last_heartbeat_at`. The "queue isn't draining because the worker is dead" signal. Staleness threshold is 90s (`HEARTBEAT_STALE_THRESHOLD_MS` in `server/workers/syncWorker.js`). The worker also exposes `/health` on `SYNC_WORKER_HEALTH_PORT` — wire that as the ECS container health check in addition to emitting this metric for alarming/trend. |

### Sync outcome (the false-orphan early warning)

| Metric | Type / unit | Dimensions | Why |
|---|---|---|---|
| `SyncRunOutcome` | Count | `Outcome` = `success` / `sweep_skipped_incomplete` / `error` | A non-zero `sweep_skipped_incomplete` means the completeness guard fired (Authentik returned a partial user fetch). Benign once by design; **a sustained stream means Authentik is chronically unhealthy** — exactly the condition behind the false-orphan incident. |
| `OrphanedAccountsTransitioned` | Count | — | Rows the sweep moved to `orphaned` per run. A spike is the thing that was invisible last time. A legitimate sweep rarely orphans many at once; a bad one orphans hundreds. |

### Rate-limiter saturation & Authentik health (the latency-collapse precursor)

| Metric | Type / unit | Dimensions | Why |
|---|---|---|---|
| `AuthentikRateLimitWaitMs` | p50/p99, Milliseconds | `Lane` = read/write/write_priority | How long callers wait for a token. Rising wait means the configured ceiling is the bottleneck (expected under a backlog). |
| `AuthentikRateLimitTimeouts` | Count | `Lane` | How often the 30s token acquire times out. |
| `AuthentikCallLatencyMs` | p50/p99, Milliseconds | `Kind` = read/write | **Since Authentik never 429s, p99 latency IS the "over the ceiling" signal.** |
| `AuthentikCallFailures` | Count | `Reason` = 5xx / timeout / circuit_open | Client-observed Authentik failures. |
| `AuthentikCircuitBreakerOpen` | Gauge 0/1 | — | Breaker tripping = a hard "Authentik is down" signal. |

---

## B. AWS-native metrics to alarm on (CDK adds the alarms)

Already published; the CDK stack just wires alarms.

### Authentik (the dependency this service hammers)
- **ALB `TargetResponseTime` (p99)** and **`HTTPCode_Target_5XX_Count`** — the
  real ceiling signal (degrade-not-429). Primary.
- **ECS `CPUUtilization`** — alarm high (~80%) but treat as secondary: latency
  collapsed at moderate CPU, so CPU is not sufficient on its own.
- **RDS (Authentik's DB) `CPUUtilization`, `DatabaseConnections`, read/write
  latency** — the actual bottleneck is here; these decide whether the write
  ceiling can ever be raised above 4.

### This service
- **ECS** task health / running count; **ALB** target 5xx and
  `TargetResponseTime`; health-check results for `/health`, `/health/ready`
  (main app) and the Sync_Worker container's own `/health`.
- **RDS (this app's DB)** `CPUUtilization`, `DatabaseConnections` — the sync,
  worker, and shared rate-limiter buckets all hit Postgres.

---

## C. Suggested first alarms (map directly to what bit us)

Start here; these are the highest-signal, lowest-noise set:

1. `SyncQueueOldestAgeSeconds` > ~2h — backlog not draining.
2. `SyncWorkerHeartbeatAgeSeconds` ≥ 90s — worker down.
3. `OrphanedAccountsTransitioned` per run > ~10 — mass-orphaning guard.
4. `SyncRunOutcome{Outcome=sweep_skipped_incomplete}` sustained (e.g. > N runs
   in a row) — Authentik chronically returning partial fetches.
5. Authentik ALB p99 > ~5s **or** any sustained target 5xx — the
   degrade-not-429 ceiling signal.
6. `AuthentikCircuitBreakerOpen` = 1 — Authentik unreachable.

Thresholds are starting points; tune against the profiled numbers in
`docs/authentik-ratelimit-profiling.md` and the deployment's real baseline.

---

## D. Emission plan (app-side work, not yet implemented)

The custom metrics in section A do not exist yet. When implementing them:

- Prefer **EMF** over `PutMetricData` (no extra API cost on the hot path).
- Single-source the two natural emission points:
  - **Periodic gauge emitter** in the Sync_Worker loop, reusing the
    `GET /api/admin/sync-status` queries (queue depth/age/failed, heartbeat
    age). This keeps the metric definitions and the /admin card reading the
    same numbers.
  - **Per-call counters** at the `authentikRequest.run(...)` chokepoint
    (`server/services/authentikRequest.js`) for latency, rate-limit wait,
    timeouts, failures, and breaker state — one place, every Authentik call.
  - **Sweep outcome + orphan count** emitted from `authentikSync.js`'s
    `syncUsers` at the point it already computes `sweepSkippedMessage` and
    calls `reconcileOrphanedAccounts`.
- Keep the metric namespace/dimension names stable once shipped — alarms and
  dashboards bind to them.
