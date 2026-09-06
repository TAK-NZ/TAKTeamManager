'use strict';

/**
 * Operational profiler: measures how much request load the CONFIGURED
 * Authentik deployment (`AUTHENTIK_URL`, fronted by whatever proxy/ALB is
 * in front of it) tolerates before it degrades or returns 429/503.
 *
 * Why this exists: TAK Team Manager has no documented Authentik
 * management-API rate limit to design against (Authentik's published
 * hardening docs only cover brute-force/login policies, not the
 * `/api/v3/core/*` management surface). The bulk-reconciliation +
 * rate-limiting design needs EVIDENCE-BACKED read/write ceilings rather
 * than a guessed number, so this script drives the real endpoints that
 * design will use and records, per sustained rate step:
 *   - counts of 2xx / 4xx / 429 / 503 / other / network-error
 *   - any `Retry-After` and `X-RateLimit-*` response headers seen
 *   - p50 / p95 / p99 / max request latency
 *
 * SAFETY -- read this before running:
 *   - READ-ONLY BY DEFAULT. With no mode flag it only issues GETs against
 *     list endpoints and `/api/v3/root/config/`. It creates NOTHING.
 *   - Write profiling (`--mode=write` / `--mode=mixed`) is OPT-IN and
 *     operates EXCLUSIVELY on disposable objects whose username/name
 *     carries the DISPOSABLE_PREFIX marker below. It creates them, loads
 *     against them, and DELETES them in a `finally` block.
 *   - `--cleanup-only` deletes every lingering DISPOSABLE_PREFIX object
 *     from a previous interrupted run and exits, issuing no load.
 *   - Every created object is tracked in-memory AND is rediscoverable by
 *     its prefix, so an interrupted run can always be cleaned up by
 *     re-running with `--cleanup-only`.
 *   - This must be pointed at a NON-PRODUCTION Authentik. It generates
 *     sustained write load and is not safe against a shared prod IdP.
 *
 * Usage:
 *   node scripts/profile-authentik-ratelimit.js                      # read-only ramp
 *   node scripts/profile-authentik-ratelimit.js --mode=write         # write ramp (disposable objects)
 *   node scripts/profile-authentik-ratelimit.js --mode=mixed         # read+write ramp
 *   node scripts/profile-authentik-ratelimit.js --rates=5,10,20,30   # override ramp steps (rps)
 *   node scripts/profile-authentik-ratelimit.js --window=60          # seconds per step (default 30)
 *   node scripts/profile-authentik-ratelimit.js --burst=200          # one-shot burst test of N reqs, then exit
 *   node scripts/profile-authentik-ratelimit.js --payload-sweep      # group PATCH users[] size sweep
 *   node scripts/profile-authentik-ratelimit.js --cleanup-only       # delete leftover disposable objects and exit
 *   node scripts/profile-authentik-ratelimit.js --json=out.json      # also write raw results as JSON
 *
 * Output: a human-readable table to stdout, and (with --json) a machine
 * readable results file for the committed profiling note.
 *
 * Modeled on the other operational scripts here: `require('dotenv')`
 * env loading, `process.stdout`/`process.stderr` output (no `console.*`,
 * per the repo's no-console lint rule for shipped code -- this script is
 * operational tooling, but follows the same convention for consistency).
 */

require('dotenv').config();

const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUTHENTIK_URL = process.env.AUTHENTIK_URL;
const AUTHENTIK_API_TOKEN = process.env.AUTHENTIK_API_TOKEN;

// Every object this script creates carries this marker in its username /
// name so it is (a) obviously disposable to a human looking at Authentik
// and (b) rediscoverable for cleanup after an interrupted run. The random
// run id lets concurrent/!repeated runs avoid colliding on identifiers.
const DISPOSABLE_PREFIX = 'ttm-ratelimit-probe';
const RUN_ID = Math.random().toString(36).slice(2, 8);

const DEFAULT_RATES = [5, 10, 20, 30, 50, 75, 100];
const DEFAULT_WINDOW_SECONDS = 30;

function out(line) {
  process.stdout.write(`${line}\n`);
}
function err(line) {
  process.stderr.write(`${line}\n`);
}

function parseArgs(argv) {
  const args = {
    mode: 'read',
    rates: DEFAULT_RATES,
    windowSeconds: DEFAULT_WINDOW_SECONDS,
    burst: null,
    payloadSweep: false,
    cleanupOnly: false,
    json: null
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--mode=')) {
      args.mode = arg.slice('--mode='.length);
    } else if (arg.startsWith('--rates=')) {
      args.rates = arg.slice('--rates='.length).split(',').map((n) => parseInt(n, 10)).filter((n) => n > 0);
    } else if (arg.startsWith('--window=')) {
      args.windowSeconds = Math.max(1, parseInt(arg.slice('--window='.length), 10) || DEFAULT_WINDOW_SECONDS);
    } else if (arg.startsWith('--burst=')) {
      args.burst = Math.max(1, parseInt(arg.slice('--burst='.length), 10) || 0);
    } else if (arg === '--payload-sweep') {
      args.payloadSweep = true;
    } else if (arg === '--cleanup-only') {
      args.cleanupOnly = true;
    } else if (arg.startsWith('--json=')) {
      args.json = arg.slice('--json='.length);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Low-level request helper: raw http(s) so we get precise timing and full
// response headers (Retry-After / X-RateLimit-*) without an axios/fetch
// abstraction in the way.
// ---------------------------------------------------------------------------

function request(method, path, body) {
  return new Promise((resolve) => {
    const url = new URL(path, AUTHENTIK_URL);
    const lib = url.protocol === 'http:' ? http : https;
    const payload = body ? JSON.stringify(body) : null;
    const started = process.hrtime.bigint();

    const req = lib.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${AUTHENTIK_API_TOKEN}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        },
        timeout: 30000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
          resolve({
            status: res.statusCode,
            elapsedMs,
            retryAfter: res.headers['retry-after'] || null,
            rateLimitHeaders: Object.fromEntries(
              Object.entries(res.headers).filter(([k]) => k.toLowerCase().startsWith('x-ratelimit'))
            ),
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    req.on('error', (e) => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ status: 0, elapsedMs, networkError: e.code || e.message, retryAfter: null, rateLimitHeaders: {}, body: '' });
    });
    req.on('timeout', () => {
      req.destroy();
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ status: 0, elapsedMs, networkError: 'timeout', retryAfter: null, rateLimitHeaders: {}, body: '' });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Percentiles / aggregation
// ---------------------------------------------------------------------------

function percentile(sortedMs, p) {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

function summarize(results) {
  const latencies = results.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const tally = { total: results.length, s2xx: 0, s4xx: 0, s429: 0, s503: 0, sOther: 0, network: 0 };
  const retryAfters = new Set();
  const rlHeaders = new Set();
  for (const r of results) {
    if (r.networkError) tally.network += 1;
    else if (r.status === 429) tally.s429 += 1;
    else if (r.status === 503) tally.s503 += 1;
    else if (r.status >= 200 && r.status < 300) tally.s2xx += 1;
    else if (r.status >= 400 && r.status < 500) tally.s4xx += 1;
    else tally.sOther += 1;
    if (r.retryAfter) retryAfters.add(r.retryAfter);
    for (const k of Object.keys(r.rateLimitHeaders || {})) rlHeaders.add(`${k}=${r.rateLimitHeaders[k]}`);
  }
  return {
    ...tally,
    p50: Math.round(percentile(latencies, 50)),
    p95: Math.round(percentile(latencies, 95)),
    p99: Math.round(percentile(latencies, 99)),
    max: Math.round(latencies[latencies.length - 1] || 0),
    retryAfters: [...retryAfters],
    rateLimitHeaders: [...rlHeaders]
  };
}

// ---------------------------------------------------------------------------
// Disposable object management (write mode)
// ---------------------------------------------------------------------------

const created = { users: [], groups: [] };

async function createDisposableUser(i) {
  const username = `${DISPOSABLE_PREFIX}-${RUN_ID}-u${i}`;
  const res = await request('POST', '/api/v3/core/users/', {
    username,
    name: username,
    type: 'internal',
    is_active: true
  });
  if (res.status >= 200 && res.status < 300) {
    const pk = JSON.parse(res.body).pk;
    created.users.push(pk);
    return pk;
  }
  return null;
}

async function createDisposableGroup(i) {
  const name = `${DISPOSABLE_PREFIX}-${RUN_ID}-g${i}`;
  const res = await request('POST', '/api/v3/core/groups/', { name, attributes: { disposable: true } });
  if (res.status >= 200 && res.status < 300) {
    const pk = JSON.parse(res.body).pk;
    created.groups.push(pk);
    return pk;
  }
  return null;
}

async function deleteAllDisposable() {
  // Delete tracked objects first, then sweep by prefix to catch anything
  // an interrupted run left behind.
  let deleted = 0;
  for (const pk of created.groups) {
    const r = await request('DELETE', `/api/v3/core/groups/${encodeURIComponent(pk)}/`);
    if (r.status === 204 || r.status === 404) deleted += 1;
  }
  for (const pk of created.users) {
    const r = await request('DELETE', `/api/v3/core/users/${encodeURIComponent(pk)}/`);
    if (r.status === 204 || r.status === 404) deleted += 1;
  }
  return deleted;
}

async function sweepByPrefix() {
  // Rediscover leftover disposable objects across paginated list endpoints
  // and delete them. Used by --cleanup-only and as a final safety net.
  let deleted = 0;
  for (const kind of ['groups', 'users']) {
    let page = 1;
    let more = true;
    while (more) {
      const res = await request('GET', `/api/v3/core/${kind}/?page=${page}&page_size=200&search=${encodeURIComponent(DISPOSABLE_PREFIX)}`);
      if (res.status < 200 || res.status >= 300) break;
      const data = JSON.parse(res.body);
      for (const obj of data.results || []) {
        const label = obj.username || obj.name || '';
        if (label.startsWith(DISPOSABLE_PREFIX)) {
          const r = await request('DELETE', `/api/v3/core/${kind}/${encodeURIComponent(obj.pk)}/`);
          if (r.status === 204 || r.status === 404) deleted += 1;
        }
      }
      more = Boolean(data.pagination && data.pagination.next);
      page += 1;
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Load generation: hold a target rate for a fixed window using a
// fire-on-schedule model (open-loop), so a slow server produces a growing
// in-flight count rather than silently lowering the offered rate. That is
// what we want -- we are measuring the server's response to an OFFERED
// rate, not throttling ourselves to its capacity.
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStep(rate, windowSeconds, pickRequest) {
  const results = [];
  const inFlight = [];
  const intervalMs = 1000 / rate;
  const totalRequests = rate * windowSeconds;
  const startWall = Date.now();

  for (let i = 0; i < totalRequests; i += 1) {
    // Open-loop scheduling: each request is fired at its scheduled offset
    // relative to the step's start. If the server slows down, requests
    // still leave on schedule and in-flight count grows -- we are
    // measuring the server's response to an OFFERED rate, not throttling
    // ourselves down to its capacity.
    const scheduledOffset = i * intervalMs;
    const elapsed = Date.now() - startWall;
    const delay = scheduledOffset - elapsed;
    if (delay > 0) await sleep(delay);
    inFlight.push(pickRequest(i).then((r) => results.push(r)));
  }
  await Promise.all(inFlight);
  return results;
}

// ---------------------------------------------------------------------------
// Request pickers per mode
// ---------------------------------------------------------------------------

function makeReadPicker() {
  // Rotate across a few real read endpoints the design relies on.
  const paths = [
    '/api/v3/core/users/?page_size=50&ordering=pk',
    '/api/v3/core/groups/?page_size=50&ordering=num_pk',
    '/api/v3/root/config/'
  ];
  return (i) => request('GET', paths[i % paths.length]);
}

function makeWritePicker(groupPks, userPks) {
  // The dominant write in the bulk-reconciliation design is
  // PATCH /core/groups/{uuid}/ {users:[...]}. Rotate a member on/off a
  // pool of disposable groups so every call is a real membership write.
  return (i) => {
    const groupPk = groupPks[i % groupPks.length];
    const includeMember = i % 2 === 0;
    return request('PATCH', `/api/v3/core/groups/${encodeURIComponent(groupPk)}/`, {
      users: includeMember && userPks.length ? [userPks[i % userPks.length]] : []
    });
  };
}

function makeMixedPicker(readPicker, writePicker) {
  // ~70% read / 30% write, roughly matching a steady-state mix where
  // reconcile GETs outnumber PATCHes.
  return (i) => (i % 10 < 7 ? readPicker(i) : writePicker(i));
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportStep(rate, windowSeconds, s) {
  const cols = [
    String(rate).padStart(4),
    String(s.total).padStart(6),
    String(s.s2xx).padStart(6),
    String(s.s4xx).padStart(5),
    String(s.s429).padStart(5),
    String(s.s503).padStart(5),
    String(s.network).padStart(5),
    String(s.p50).padStart(6),
    String(s.p95).padStart(6),
    String(s.p99).padStart(6),
    String(s.max).padStart(6)
  ];
  out(cols.join(' | '));
  if (s.retryAfters.length) out(`       Retry-After seen: ${s.retryAfters.join(', ')}`);
  if (s.rateLimitHeaders.length) out(`       X-RateLimit headers: ${s.rateLimitHeaders.join(', ')}`);
}

function reportHeader() {
  out('');
  out(' rate | total |  2xx |  4xx | 429 | 503 | net | p50ms | p95ms | p99ms | maxms');
  out('------+-------+------+------+-----+-----+-----+-------+-------+-------+------');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (!AUTHENTIK_URL || !AUTHENTIK_API_TOKEN) {
    err('AUTHENTIK_URL and AUTHENTIK_API_TOKEN must be set (via .env).');
    process.exit(2);
  }

  const args = parseArgs(process.argv);
  const jsonResults = { url: AUTHENTIK_URL, runId: RUN_ID, mode: args.mode, startedAt: new Date().toISOString(), steps: [] };

  out(`Authentik rate-limit profiler`);
  out(`  target : ${AUTHENTIK_URL}`);
  out(`  mode   : ${args.mode}`);
  out(`  run id : ${RUN_ID}  (disposable marker: ${DISPOSABLE_PREFIX}-${RUN_ID}-*)`);

  if (args.cleanupOnly) {
    out('Cleanup-only: sweeping leftover disposable objects by prefix...');
    const n = await sweepByPrefix();
    out(`Deleted ${n} leftover disposable object(s).`);
    process.exit(0);
  }

  const wantWrite = args.mode === 'write' || args.mode === 'mixed' || args.payloadSweep;
  let groupPks = [];
  let userPks = [];

  try {
    if (wantWrite) {
      out('Provisioning disposable objects for write load...');
      // A small pool of groups + a few members is enough; the load comes
      // from repeatedly PATCHing them, not from their count.
      for (let i = 0; i < 10; i += 1) {
        const g = await createDisposableGroup(i);
        if (g) groupPks.push(g);
      }
      for (let i = 0; i < 20; i += 1) {
        const u = await createDisposableUser(i);
        if (u) userPks.push(u);
      }
      out(`  created ${groupPks.length} groups, ${userPks.length} users`);
      if (groupPks.length === 0 || userPks.length === 0) {
        err('Failed to provision disposable objects; aborting before load (cleaning up).');
        await deleteAllDisposable();
        process.exit(1);
      }
    }

    const readPicker = makeReadPicker();
    const writePicker = makeWritePicker(groupPks, userPks);
    const picker =
      args.mode === 'write' ? writePicker : args.mode === 'mixed' ? makeMixedPicker(readPicker, writePicker) : readPicker;

    // Burst test: fire N requests as fast as possible, then report.
    if (args.burst) {
      out(`\nBurst test: ${args.burst} requests as fast as possible...`);
      const bursts = [];
      for (let i = 0; i < args.burst; i += 1) bursts.push(picker(i));
      const s = summarize(await Promise.all(bursts));
      reportHeader();
      reportStep(`burst`, 0, s);
      jsonResults.steps.push({ step: 'burst', count: args.burst, ...s });
    } else if (args.payloadSweep) {
      // Payload-size sweep: PATCH a group's users[] with growing arrays to
      // find a body-size / latency cliff. Uses the disposable user pool,
      // repeating pks to reach large sizes (membership semantics don't
      // matter here -- we're measuring accepted body size + latency).
      out('\nPayload sweep: PATCH /core/groups/{pk}/ {users:[N]} ...');
      reportHeader();
      const sizes = [1, 10, 50, 100, 500, 1000, 5000, 10000, 15000];
      for (const size of sizes) {
        const arr = [];
        for (let i = 0; i < size; i += 1) arr.push(userPks[i % userPks.length]);
        const r = await request('PATCH', `/api/v3/core/groups/${encodeURIComponent(groupPks[0])}/`, { users: arr });
        out(`  size=${String(size).padStart(6)}  status=${r.status}  ${Math.round(r.elapsedMs)}ms  ${r.retryAfter ? 'Retry-After=' + r.retryAfter : ''}`);
        jsonResults.steps.push({ step: 'payload', size, status: r.status, ms: Math.round(r.elapsedMs) });
        // Reset membership back to empty so the next PATCH starts clean.
        await request('PATCH', `/api/v3/core/groups/${encodeURIComponent(groupPks[0])}/`, { users: [] });
      }
    } else {
      // Stepped ramp.
      out(`\nStepped ramp: ${args.rates.join(', ')} rps, ${args.windowSeconds}s per step`);
      reportHeader();
      for (const rate of args.rates) {
        const results = await runStep(rate, args.windowSeconds, picker);
        const s = summarize(results);
        reportStep(rate, args.windowSeconds, s);
        jsonResults.steps.push({ step: 'ramp', rate, windowSeconds: args.windowSeconds, ...s });
        // Abort the ramp early if the server is clearly in distress:
        // any 503s, sustained 429s, or a p99 collapse relative to baseline.
        if (s.s503 > 0 || s.s429 > s.total * 0.1) {
          out(`\nStopping ramp early: server showing distress at ${rate} rps (429=${s.s429}, 503=${s.s503}).`);
          break;
        }
        // Brief pause between steps to let the server recover.
        await sleep(3000);
      }
    }
  } finally {
    if (wantWrite) {
      out('\nCleaning up disposable objects...');
      const tracked = await deleteAllDisposable();
      const swept = await sweepByPrefix();
      out(`  deleted ${tracked} tracked + ${swept} swept disposable object(s).`);
    }
  }

  jsonResults.finishedAt = new Date().toISOString();
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(jsonResults, null, 2));
    out(`\nRaw results written to ${args.json}`);
  }
  out('\nDone.');
}

if (require.main === module) {
  main().catch((e) => {
    err(`Profiler failed: ${e && e.stack ? e.stack : e}`);
    // Best-effort cleanup on unexpected failure.
    sweepByPrefix()
      .catch(() => {})
      .finally(() => process.exit(1));
  });
}

module.exports = {
  parseArgs,
  percentile,
  summarize,
  makeMixedPicker,
  DISPOSABLE_PREFIX,
  request
};
