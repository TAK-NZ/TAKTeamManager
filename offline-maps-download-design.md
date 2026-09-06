# Offline Map Downloads on `/downloads` — Design Proposal

Status: **implemented** (server + client), enabled in the local test environment against the
real bucket. The remaining production step is the CDK task-role grant + env injection in
§3.10 — no further app code is required.
Scope: extend the existing `/downloads` page (previously TAK-client links only) to also
offer offline `.mbtiles` map files for ATAK and TAK Aware, served via short-lived S3
presigned GET URLs from a dedicated, non-public bucket.

This document records how the feature is built and how the revised `/downloads` page is laid
out. It is the source of truth for the CDK follow-up (§3.10).

---

## 1. What we're adding, in one paragraph

Authenticated users get a second area on `/downloads` listing downloadable offline maps.
The server never proxies the files — it generates a presigned S3 `GetObject` URL on
demand and hands it to the browser, which downloads directly from S3. The bucket
(`*-map-downloads`, all public access blocked, `us-west-2`) is read-only to this app and
resolved from an environment variable. The whole feature sits behind a server-only
`OFFLINE_MAPS_ENABLED` flag, off by default, matching the existing feature-flag
convention.

---

## 2. Key facts that shaped the design (from the current codebase)

- **`/downloads` today is almost entirely static.** `client/src/pages/Downloads.jsx`
  renders hardcoded client-download links in a 3-column OS grid (Android / iOS / Windows)
  plus one conditional CloudTAK row. The only server data it fetches is `cloudtak_url`
  from `GET /api/config/public`. There is **no** download-catalog API and **no** DB model
  for downloads today.
- **AWS SDK v3 is already a dependency.** `@aws-sdk/client-secrets-manager` is pinned
  exactly (`3.1109.0`) and used in `server/config/secretsProvider.js`, which already reads
  `AWS_REGION` from env and supports an injectable client for tests. **But there is no S3
  client and no presigner anywhere** — `@aws-sdk/client-s3` and
  `@aws-sdk/s3-request-presigner` would be **new dependencies**, and per convention
  (security-critical deps pinned exactly, enforced in CI) we pin them exactly, matching the
  existing `@aws-sdk/*` line already in the lockfile.
- **The public-config endpoint is Presentation_Config only.** `GET /api/config/public`
  (`server/models/SiteConfig.js`) may expose only values that affect rendering and carry no
  security meaning. `SiteConfig.test.js` mechanically asserts capability flags stay out of
  it. So `OFFLINE_MAPS_ENABLED` must **not** be surfaced there.
- **Feature-flag convention:** a named helper in `server/config/*.js` returning
  `env.X === 'true'` (true only for the exact string, default off), read server-side, and
  the router mounted conditionally in `server/index.js` — exactly how device-management is
  mounted.
- **Authorization is deny-by-default and per-route.** Every authenticated route+method
  needs an entry in `server/config/permissions.registry.js`, mounted with
  `authenticateToken, authorize`. A route is either in the permission registry
  (authenticated) or in `publicRoutes.js` (no token) — never both.
- **Every env var read must be documented in `.env.example` with a safe default.**

---

## 3. Implementation

### 3.1 Trust boundary: why presigned URLs, authenticated

The bucket blocks all public access, so the browser cannot fetch a file with a bare URL.
Two options exist: (a) proxy the bytes through the server, or (b) presign a short-lived
`GetObject` URL and let the browser hit S3 directly. The source material explicitly asks
for **(b)** — and it's the right call: these files are 100 MB to ~2.3 GB, so proxying
would tie up a Node process/socket for the entire multi-minute transfer per download,
which does not scale and competes with the request loop that also drives the sync worker's
sibling processes.

The endpoint that mints presigned URLs is **authenticated** (in the permission registry,
not `publicRoutes.js`). A presigned URL is a bearer capability to read a specific object
for its lifetime; issuing one is exactly the kind of action that should require a logged-in
user. The presign expiry is kept short (default 5 minutes) — long enough to start a
download, short enough that a leaked URL is stale quickly. Once S3 has started streaming a
response, the expiry no longer applies to that in-flight transfer, so a big file that takes
20 minutes to download still completes on a 5-minute presign.

### 3.2 New files

```
server/config/offlineMaps.js         flag + config helpers (bucket, region, expiry, catalog)
server/services/OfflineMapService.js S3 client, presign, catalog assembly (business logic)
server/routes/offlineMaps.js         validate + authorize + delegate (thin)
server/routes/offlineMaps.test.js
server/services/OfflineMapService.test.js
server/config/offlineMaps.test.js
client/src/pages/Downloads.jsx        (modified — see layout section)
```

No new DB migration. The catalog of files is **static, code-defined** (see 3.4) — the
bucket has a fixed, known key layout that changes ~annually via an out-of-band batch job,
so a `site_config`/migration-backed catalog would be overkill and would drift from the
generator. If we later want operator-editable display names, that is a follow-up, not v1.

### 3.3 `server/config/offlineMaps.js`

Mirrors `cloudtak.js` exactly:

```js
function isOfflineMapsEnabled(env = process.env) {
  return env.OFFLINE_MAPS_ENABLED === 'true';
}

// Bucket name. Prefer resolving dynamically from the base-infra CloudFormation
// export (TAK-<Stack>-BaseInfra-MapDownloadsBucket) at deploy time and injecting
// the resolved name here; this app only reads the literal value.
function getOfflineMapsBucket(env = process.env) {
  return env.OFFLINE_MAPS_S3_BUCKET || null;
}

// Region: reuse AWS_REGION if the bucket is co-located, else an explicit override.
function getOfflineMapsRegion(env = process.env) {
  return env.OFFLINE_MAPS_S3_REGION || env.AWS_REGION || 'us-west-2';
}

// Presign lifetime in seconds; positive-integer discipline like getRevokeMaxCerts().
function getOfflineMapsUrlTtlSeconds(env = process.env) {
  const parsed = parseInt(env.OFFLINE_MAPS_URL_TTL_SECONDS, 10);
  return parsed > 0 ? parsed : 300;
}
```

If the flag is on but `OFFLINE_MAPS_S3_BUCKET` is unset, the service treats the feature as
misconfigured and the endpoint answers 503 (not 500) — a clear "enabled but not wired up"
signal distinct from a runtime S3 error.

### 3.4 The catalog (static, code-defined)

The 16 region keys + display names are authoritative from the generator's `REGIONS` dict.
We transcribe them once, with the two whole-island supersets (`north-island`,
`south-island`) deliberately excluded.

**The catalog is an explicitly ordered array — array order IS display order** (confirmed
below). No client-side re-sorting; the server returns the list already in this order and the
client renders it top-to-bottom. Each entry carries a `group` key so the UI can insert the
section headings (`North Island`, `South Island`, and the standalone entries) without
re-deriving grouping from labels. Shape:

```js
const OFFLINE_MAP_CATALOG = [
  // ---- North Island: north -> south ----
  { id: 'regional-northland',          group: 'north-island', category: 'regional',
    key: 'regional/northland-topo.mbtiles',          label: 'Northland',           apps: ['atak', 'takaware'] },
  { id: 'regional-auckland',           group: 'north-island', category: 'regional',
    key: 'regional/auckland-topo.mbtiles',           label: 'Auckland',            apps: ['atak', 'takaware'] },
  { id: 'regional-waikato',            group: 'north-island', category: 'regional',
    key: 'regional/waikato-topo.mbtiles',            label: 'Waikato',             apps: ['atak', 'takaware'] },
  { id: 'regional-bay-of-plenty',      group: 'north-island', category: 'regional',
    key: 'regional/bay-of-plenty-topo.mbtiles',      label: 'Bay of Plenty',       apps: ['atak', 'takaware'] },
  { id: 'regional-gisborne',           group: 'north-island', category: 'regional',
    key: 'regional/gisborne-topo.mbtiles',           label: 'Gisborne',            apps: ['atak', 'takaware'] },
  { id: 'regional-hawkes-bay',         group: 'north-island', category: 'regional',
    key: 'regional/hawkes-bay-topo.mbtiles',         label: "Hawke's Bay",         apps: ['atak', 'takaware'] },
  { id: 'regional-taranaki',           group: 'north-island', category: 'regional',
    key: 'regional/taranaki-topo.mbtiles',           label: 'Taranaki',            apps: ['atak', 'takaware'] },
  { id: 'regional-manawatu-whanganui', group: 'north-island', category: 'regional',
    key: 'regional/manawatu-whanganui-topo.mbtiles', label: 'Manawatū-Whanganui',  apps: ['atak', 'takaware'] },
  { id: 'regional-wellington',         group: 'north-island', category: 'regional',
    key: 'regional/wellington-topo.mbtiles',         label: 'Wellington',          apps: ['atak', 'takaware'] },

  // ---- South Island: north -> south ----
  { id: 'regional-nelson-tasman',      group: 'south-island', category: 'regional',
    key: 'regional/nelson-tasman-topo.mbtiles',      label: 'Nelson Tasman',       apps: ['atak', 'takaware'] },
  { id: 'regional-marlborough',        group: 'south-island', category: 'regional',
    key: 'regional/marlborough-topo.mbtiles',        label: 'Marlborough',         apps: ['atak', 'takaware'] },
  { id: 'regional-west-coast',         group: 'south-island', category: 'regional',
    key: 'regional/west-coast-topo.mbtiles',         label: 'West Coast',          apps: ['atak', 'takaware'] },
  { id: 'regional-canterbury',         group: 'south-island', category: 'regional',
    key: 'regional/canterbury-topo.mbtiles',         label: 'Canterbury',          apps: ['atak', 'takaware'] },
  { id: 'regional-otago',              group: 'south-island', category: 'regional',
    key: 'regional/otago-topo.mbtiles',              label: 'Otago',               apps: ['atak', 'takaware'] },
  { id: 'regional-southland',          group: 'south-island', category: 'regional',
    key: 'regional/southland-topo.mbtiles',          label: 'Southland',           apps: ['atak', 'takaware'] },

  // ---- standalone entries, in fixed order ----
  { id: 'regional-chatham-islands',    group: 'chatham-islands', category: 'regional',
    key: 'regional/chatham-islands-topo.mbtiles',    label: 'Chatham Islands',     apps: ['atak', 'takaware'] },
  { id: 'marine-charts',               group: 'marine', category: 'marine',
    key: 'marine/nz-marine-charts.mbtiles',          label: 'NZ Marine Charts',    apps: ['atak', 'takaware'] },
  { id: 'vector-omt-buildings',        group: 'vector', category: 'vector',
    key: 'vector/nz-omt-buildings.mbtiles',          label: 'NZ Basemap + 3D Buildings', apps: ['atak'] },
  { id: 'vector-omt',                  group: 'vector', category: 'vector',
    key: 'vector/nz-omt.mbtiles',                    label: 'NZ Basemap',          apps: ['atak'] },
];
```

**Confirmed display order** (array order above):

1. **North Island** (heading) — Northland, Auckland, Waikato, Bay of Plenty, Gisborne,
   Hawke's Bay, Taranaki, Manawatū-Whanganui, Wellington (north → south)
2. **South Island** (heading) — Nelson Tasman, Marlborough, West Coast, Canterbury, Otago,
   Southland (north → south)
3. **Chatham Islands**
4. **Marine** — NZ Marine Charts
5. **Vector** — NZ Basemap + 3D Buildings, then NZ Basemap (without buildings)

`apps` still encodes the compatibility rule from the brief (raster works in both ATAK and
TAK Aware; vector is ATAK-only), shown as text per section/row. `group` drives the section
headings; the north→south region order is a fixed editorial ordering baked into the array
(the generator's `REGIONS` dict is not itself geographically ordered), so it lives as a
comment-documented constant, not a computed sort.

**File sizes**: not hardcoded. The brief's sizes are a snapshot and some files were still
building. The service reads each object's real `ContentLength` from S3 at list time
(`HeadObject`, or the `Size` from a single `ListObjectsV2` over the known prefixes) so the
UI shows the true current size and an object that hasn't been uploaded yet is simply omitted
or shown as unavailable rather than offered as a dead link.

### 3.5 `server/services/OfflineMapService.js`

Business logic, no framework imports. Constructor takes an injectable `S3Client` (test
seam, mirroring `secretsProvider.js`).

- `listAvailableMaps()` — for each catalog entry, resolve the object's existence + size
  from S3 (one `ListObjectsV2` per prefix is cheaper than N `HeadObject`s; the prefixes are
  `regional/`, `marine/`, `vector/`). Returns catalog metadata + `sizeBytes` +
  `available:boolean`. Never returns a URL.
- `getPresignedUrl(mapId)` — validates `mapId` against the catalog (rejects anything not in
  it — the client never supplies a raw S3 key, only a catalog id, so there is no path for
  key injection or traversal), then returns
  `getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: ttl })`. Sets
  `ResponseContentDisposition: attachment; filename="..."` so the browser downloads rather
  than navigates, and a sensible `ResponseContentType` (`application/octet-stream`).

The catalog-id indirection is the security core: the client asks for `regional-otago`, not
`regional/otago-topo.mbtiles`. The S3 key is only ever assembled server-side from a frozen
allow-list — the same "dynamic identifiers come only from a frozen allow-list" discipline
the codebase already applies to SQL table names.

### 3.6 `server/routes/offlineMaps.js`

Thin, mirrors `globalChannels.js`:

```
GET  /api/offline-maps            -> service.listAvailableMaps()          (catalog + sizes)
GET  /api/offline-maps/:id/url    -> service.getPresignedUrl(req.params.id)  (mint URL)
```

Both `authenticateToken, authorize`. `:id` validated with `express-validator` against a
simple pattern; the service re-validates against the catalog (defence in depth). A
non-catalog id is 404. Errors are logged via pino and answered 500 (or 503 for
"enabled-but-no-bucket"). Router mounted conditionally in `server/index.js`:

```js
if (isOfflineMapsEnabled()) {
  app.use('/api/offline-maps', require('./routes/offlineMaps'));
}
```

When the flag is off the router isn't mounted, so both routes 404 — consistent with how
`DEVICE_MGMT_ENABLED` gates its router. (An unmounted authenticated route still needs its
registry entries present; deny-by-default plus the completeness tests require the mapping to
exist regardless of runtime mounting.)

### 3.7 Permissions + public-routes

Add to `server/config/permissions.registry.js`:

```js
'GET /api/offline-maps':        ['offline_maps:read'],
'GET /api/offline-maps/:id/url':['offline_maps:read'],
```

A single new permission identifier `offline_maps:read`. **Not** added to `publicRoutes.js`.
**Decision (confirmed): `offline_maps:read` is granted to every authenticated user**,
matching that the client-download page is reachable by anyone logged in. No team/role
scoping — any logged-in user may list maps and mint a download URL.

### 3.8 Client — how the page learns the feature is on

The page must not read the capability flag (it isn't in public config, by rule). Instead it
uses the same **reachability probe** pattern device-management uses: on mount, call
`GET /api/offline-maps`. A `200` with a list renders the maps area; a `404`/`403` renders
nothing (feature off / not permitted). This keeps the client branching on the server's
answer, never on a leaked flag, and fails closed exactly like the existing `cloudtak_url`
fetch.

Clicking a specific map calls `GET /api/offline-maps/:id/url` and navigates the browser to
the returned URL (or sets `window.location.href` / an `<a download>`), triggering the direct
S3 download.

### 3.9 New dependencies + env vars

**Dependencies** (pinned exactly, versions aligned to the existing `@aws-sdk/*` line):
`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

**`.env.example`** additions (each with a safe default + one-line comment):

```
# --- Offline map downloads (server-only capability, off by default) ---
OFFLINE_MAPS_ENABLED=false
# Bucket holding the .mbtiles files (all public access blocked). Prefer injecting
# the base-infra CloudFormation export TAK-<Stack>-BaseInfra-MapDownloadsBucket.
OFFLINE_MAPS_S3_BUCKET=
# Region of that bucket; falls back to AWS_REGION, then us-west-2.
OFFLINE_MAPS_S3_REGION=us-west-2
# Presigned-URL lifetime in seconds (default 300). Only bounds the time to START a
# download; an in-flight transfer completes regardless.
OFFLINE_MAPS_URL_TTL_SECONDS=300
```

### 3.10 IAM / deploy note

The app's runtime role (ECS task role) needs read-only access to the one map-downloads
bucket. This is the ONE piece of infrastructure the feature cannot self-provision — flag it
to whoever owns the CDK. Presigning is a local crypto operation, but the signature it
produces is only honoured by S3 if the *signing* credentials actually hold `s3:GetObject`
on the object; and `listAvailableMaps` needs `s3:ListBucket` to read object sizes.

**Required task-role policy (least privilege, read-only, no write/delete):**

```jsonc
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OfflineMapsList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<map-downloads-bucket>",
      // Optional tightening: only the three prefixes the catalog reads.
      "Condition": { "StringLike": { "s3:prefix": ["regional/*", "marine/*", "vector/*"] } }
    },
    {
      "Sid": "OfflineMapsGet",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<map-downloads-bucket>/*"
    }
  ]
}
```

**CDK wiring (recommended shape):**

1. Resolve the bucket by name from the base-infra CloudFormation export
   `TAK-<Stack>-BaseInfra-MapDownloadsBucket`
   (`s3.Bucket.fromBucketName(...)` / `Fn.importValue(...)`).
2. Grant read to the task role — `bucket.grantRead(taskRole)` emits exactly the
   `s3:GetObject` + `s3:ListBucket` (+ `s3:GetObject*`/`GetBucket*`) statements above, scoped
   to that bucket ARN. Do NOT grant `grantReadWrite`/`grantPut`/`grantDelete`: this app only
   ever reads.
3. Inject the env into the task definition:
   - `OFFLINE_MAPS_ENABLED=true`
   - `OFFLINE_MAPS_S3_BUCKET` = the resolved bucket name (from the export, not hardcoded)
   - `OFFLINE_MAPS_S3_REGION=us-west-2` (or wherever the bucket lives; falls back to
     `AWS_REGION` then `us-west-2`)
   - `OFFLINE_MAPS_URL_TTL_SECONDS` — optional, defaults to 300
4. **Cross-region note:** the map-downloads bucket is in `us-west-2`, which may differ from
   the region the app's ECS service runs in. That is fine — the S3 client is constructed for
   `OFFLINE_MAPS_S3_REGION` specifically (not the app's own region), and a presigned URL is
   region-scoped in its signature. Just make sure `OFFLINE_MAPS_S3_REGION` matches the
   bucket's actual region or presigns will fail with a region-mismatch error.
5. **No bucket policy / CORS change needed for the download itself:** the browser fetches the
   presigned URL as a top-level navigation (`window.location.href`), not an XHR/fetch, so S3
   CORS does not apply. Keep all public access blocked; presigned URLs work regardless.
6. **The bucket stays private.** Do not make it public and do not add a public-read policy —
   presigned URLs are the entire access mechanism.

**Local test status (this environment):** the feature is enabled in the local (uncommitted)
`.env` against the real bucket `tak-demo-baseinfra-us-west-2-453572736517-map-downloads`.
The dev box's own instance credentials already carry the needed read access, so the SDK
default credential chain resolves without any keys in `.env`. Verified end-to-end: all 16
regional `.mbtiles` list with correct live sizes; marine + the two vector files correctly
report `available: false` (their S3 objects don't exist yet and will self-populate); a
service-generated presigned URL returns HTTP 206 with
`Content-Disposition: attachment; filename="…-topo.mbtiles"` and streams real SQLite bytes;
and a traversal-style bad id is rejected before any S3 call. The ONLY thing the CDK adds
beyond this is the task-role grant + env injection above — no code changes.

### 3.11 Testing

- `offlineMaps.test.js` (config): flag is true only for `'true'`; TTL parsing edge cases;
  region/bucket fallbacks — matching `cloudtak.test.js`/`deviceMgmt.test.js`.
- `OfflineMapService.test.js`: inject a mock `S3Client`; assert catalog-id → correct
  `{Bucket, Key}`, unknown id rejected, `listAvailableMaps` merges sizes and omits missing
  objects, presign passes the configured `expiresIn`. No real network.
- `offlineMaps.test.js` (route): 200 shape, 404 for unknown id, 503 for enabled-but-no-bucket,
  and (via the completeness tests) that both routes have registry entries and are absent from
  `publicRoutes.js`.
- Client: mounted-page test (per client testing convention — `createRoot` + `act`, no
  `@testing-library/react`) that the maps area renders when the probe returns a list and is
  omitted on 404.

---

## 4. Revised `/downloads` page layout

### 4.1 Goal

The page now serves two distinct jobs — **get the app** and **get offline maps for the
app** — with a natural order: you install a client first, then load maps into it. Keep the
existing OS-grid client area exactly as-is at the top (it works and is well-tested), and add
a clearly separated **Offline Maps** area below it, rendered only when the feature is on.

**Mobile-first is a first-class requirement, not an afterthought.** The end target for every
one of these files is a phone or tablet — the maps sideload into ATAK on Android or TAK Aware
on iOS. So the *primary* device that will use the download controls is a phone, and the page
must be genuinely good there, not merely not-broken. Concretely, that means: every download
control is a real ~36–40px tap target (not a bare text link); tabular map lists dual-render as
stacked cards below `sm:` instead of a horizontally scrolling table; sizes are shown so a user
can judge a download before committing on mobile data; and the desktop→phone QR (§4.7) exists
precisely so a user who *starts* on a PC still ends up operating the page on the phone it's
optimized for. All the specifics live in §4.4; this is the principle they serve.

### 4.2 Page structure (top to bottom)

```
H1  Downloads
    (subtitle updated: "Install a TAK client, then load offline maps into it.")

┌─ CARD 1: TAK Clients ────────────────────────────────────────────┐
│  (UNCHANGED existing 3-column OS grid: Android / iOS / Windows)   │
│  + CloudTAK row (unchanged)                                       │
│  + recommended-option footnote (unchanged)                        │
└──────────────────────────────────────────────────────────────────┘

┌─ CARD 2: Offline Maps  (only if the probe returns a list) ───────┐
│  Intro line: what these are + that they're large sideload files. │
│                                                                    │
│  App-compatibility legend (text, not colour):                     │
│    "ATAK: all maps.  TAK Aware: topographic + marine only         │
│     (vector basemaps are ATAK-only)."                             │
│                                                                    │
│  ── North Island ──               (topographic · ATAK + TAK Aware)│
│     • Northland                      114 MB   [Download]          │
│     • Auckland                       140 MB   [Download]          │
│     • Waikato … Wellington  (north → south)                       │
│                                                                    │
│  ── South Island ──               (topographic · ATAK + TAK Aware)│
│     • Nelson Tasman                  258 MB   [Download]          │
│     • Marlborough … Southland  (north → south)                    │
│                                                                    │
│  ── Chatham Islands ──            (topographic · ATAK + TAK Aware)│
│     • Chatham Islands                 9 MB    [Download]          │
│                                                                    │
│  ── Marine ──                          (charts · ATAK + TAK Aware)│
│     • NZ Marine Charts               ~700 MB  [Download]          │
│                                                                    │
│  ── Vector Basemaps ──                        (basemap · ATAK only)│
│     • NZ Basemap + 3D Buildings      2.3 GB   [Download]          │
│     • NZ Basemap                     2.1 GB   [Download]          │
│                                                                    │
│  Install help: two short, app-specific notes (ATAK path vs        │
│  TAK Aware Share-sheet), collapsible or linked to docs.           │
└──────────────────────────────────────────────────────────────────┘
```

### 4.3 Grouping and ordering rationale

Group and order **geographically** (confirmed): North Island regions (north → south), then
South Island regions (north → south), then Chatham Islands, then Marine, then the two Vector
basemaps. This is how a user reaches for a map — by where they are — and the north→south run
within each island lets someone scan straight to their region. The order is authoritative in
the catalog array (§3.4); the client does not re-sort.

The sections are **islands/standalone entries**, not app-compatibility buckets, because a
file's app support is a per-row/per-section property carried in **text** (never colour alone
— state a user must perceive is carried by text, a hard rule here). Each section header
restates its app compatibility in words: the three topographic groups (North Island, South
Island, Chatham Islands) and Marine are "ATAK + TAK Aware"; Vector Basemaps is "ATAK only".
Each entry is a compact row: display name, real size (read live from S3), a Download action.

### 4.4 Row / responsive behaviour

Follow the established mobile conventions already in this codebase:

- **Dual-render** each grouped list under its section heading: a `sm:hidden` stacked card
  list below the `sm:` breakpoint and a `hidden sm:block` table at `sm:`+, rather than a
  horizontally scrolling table on a phone (same pattern as `TeamDetail.jsx`'s tabs). Each
  card/row shows `Name · Size · [Download]`, value beside label. The island headings persist
  across both renderings so the geographic ordering reads the same on phone and desktop.
- The **Download control** is a real ~36–40px tap target (`btn-*` or `p-2 rounded-lg`), not a
  bare text link, so it's tappable on mobile.
- Size is shown as a formatted value using the existing locale-aware
  `client/src/utils/formatNumber.js` conventions (e.g. `2.3 GB`, thousands-grouped where
  relevant), so a user can judge the download before committing to it on mobile data.
- Nothing here needs a confirmation dialog — a download is non-destructive. (The
  two-tier confirm rules apply to destructive actions, not this.)

### 4.5 States

- **Feature off / not permitted:** Card 2 is not rendered at all — no empty state, no
  spinner, exactly how the CloudTAK row is omitted when its URL is null.
- **Enabled, object missing** (e.g. a file that hasn't been rebuilt/uploaded this run): that
  row is either omitted or shown disabled with "Currently unavailable" text — never offered
  as a live Download that 404s at S3.
- **Presign failure on click:** show an inline, non-blocking error near the row ("Couldn't
  prepare the download, try again"), leave the rest of the list intact — a failed action must
  never clear the rendered list.

### 4.6 Install guidance copy

Keep it short on the page and point deeper detail at ATAK-facing docs (the brief notes the
exact target folder varies by file type, which belongs in docs, not this UI):

- **ATAK (Android):** download the `.mbtiles` to the device, place it in
  `atak/imagery/mobile/`.
- **TAK Aware (iOS):** download the file, open the Files app, long-press the `.mbtiles`, tap
  Share, choose TAK Aware.

### 4.7 Desktop → phone handoff: one page-level QR code (confirmed)

**Decision: offer a single QR code for the page URL (`https://<hostname>/downloads`), NOT a
QR per file.** The maps have to land on the phone, but a user often browses this page on a
PC/Mac — a QR that jumps them to the same page on their phone is the natural bridge. From
there they download on the phone, where the presign-on-click flow and install notes are
right there.

**Why not per-file QR codes:**

- The download URLs are **short-lived presigned S3 links** (default 300s TTL) minted on
  demand per click. Encoding one in a QR gives a large, ugly payload that **expires within
  minutes** — scan it a moment later and it's dead.
- A per-file QR would point the phone's browser **straight at a multi-GB S3 object**, bypassing
  the page, its size labels, its app-compatibility text, and its install guidance. That's a
  worse experience than scanning to the page and tapping the file there.
- Per-file QR multiplies clutter: 20 codes on one screen, each solving nothing the page-level
  code doesn't.

**Why the page-level QR is clean:**

- `https://<hostname>/downloads` is **short, stable, and permanent**, so it encodes into a
  small, reliably scannable QR.
- It drops the user on the **same authenticated-gated page** on their phone; the download then
  happens correctly from the phone.

**What the QR must encode — the canonical hostname, not `window.location`:**

Per the product steering this is one SPA on one origin (`team.tak.nz` in production). The QR
must encode that **canonical public URL**, not `window.location.href` — a desktop viewing via
an internal host/port, a preview URL, or `localhost` would otherwise produce a QR that the
phone can't reach. So the base URL is a **resolved config value**:

- Server exposes a `public_base_url` (or reuse an existing configured origin) via the
  Presentation_Config channel `GET /api/config/public` — this is presentation-only (a URL to
  draw a QR from), carries no security meaning, and is exactly the kind of value that endpoint
  is for. The client builds `${public_base_url}/downloads`.
- Fallback: if unset, fall back to `window.location.origin + '/downloads'` so a dev/test
  environment still shows *a* working code (just not the production hostname).

**UI treatment:**

- A small **"Show QR code" affordance** near the Offline Maps heading (a button/disclosure),
  collapsed by default — the QR is only useful to the desktop viewer, so it shouldn't occupy
  space for the phone user who's already on their phone.
- Optionally hide it below `sm:` (`hidden sm:block`): a phone user scanning a QR *with the same
  phone* is pointless. Showing it only at `sm:`+ (desktop/tablet widths) targets exactly the
  desktop→phone case. This is a nice-to-have refinement, not required.
- The code carries a visible text label with the URL beside it (state/target in **text**, not
  the image alone) and the QR image is `aria-hidden` with the URL as the accessible content —
  the URL is the real information; the QR is a convenience rendering of it.

**Implementation note:** rendering a QR client-side needs a small library (e.g. a
`qrcode`-style generator). That's a **new client dependency** (`client/package.json`), pinned
exactly per convention. No server work beyond exposing `public_base_url` in public config.
Alternatively the QR SVG could be generated server-side, but client-side keeps it a pure
presentation concern with no new route.

---

## 5. Open questions for review

1. ~~Who gets `offline_maps:read`?~~ **Resolved: every authenticated user.**
2. **Bucket name resolution:** inject the resolved name via `OFFLINE_MAPS_S3_BUCKET` at
   deploy time (recommended, this app stays env-driven), vs. having the app resolve the
   CloudFormation export itself (adds a CFN describe call + IAM). I'd keep the app env-driven.
3. **Marine/vector exact sizes** are unconfirmed / still building in the brief — the
   read-live-size approach means we don't depend on the snapshot, but worth confirming the
   objects exist at the stated keys before enabling in an environment.
4. **Presign TTL default (300s):** acceptable? It only bounds start-of-download, not the
   transfer, so short is fine — confirm no proxy/CDN in front would buffer and defeat that.
5. **Do we want a "last updated" hint per file?** S3 `LastModified` is available for free
   from the same list call; could show "Updated <date>" via `FormattedDate`. Optional.

---

## 6. Summary of the answer

- **How to implement:** new server-only `OFFLINE_MAPS_ENABLED` flag + `offlineMaps.js`
  config; an `OfflineMapService` that holds an injectable S3 client, resolves a **static,
  code-defined catalog** to real S3 objects (sizes read live), and mints short-lived
  presigned `GetObject` URLs; a thin authenticated `offlineMaps.js` route
  (`GET /api/offline-maps`, `GET /api/offline-maps/:id/url`) in the permission registry and
  mounted conditionally; two new exactly-pinned AWS SDK deps; four documented env vars; an
  IAM read-only grant on the one bucket. No DB migration, no proxying, no public bucket.
- **How to lay out `/downloads`:** keep the existing client-download grid as Card 1
  unchanged; add a probe-gated Card 2 "Offline Maps" below it, ordered geographically
  (North Island north→south, South Island north→south, Chatham Islands, Marine, then the two
  Vector basemaps) with app-compatibility stated in text per section, real sizes shown,
  dual-rendered card/table lists, real tap targets, and short per-app install notes. Built
  **mobile-first**, since the phone is the primary device for these downloads.
- **Desktop → phone handoff:** one page-level QR code for `https://<hostname>/downloads`
  (encoding the canonical configured hostname, not `window.location`), collapsed by default;
  **no** per-file QR codes (presigned URLs expire and bypass the page).
- **Permission:** `offline_maps:read` granted to every authenticated user.

Nothing is implemented yet — this is for your review.
```

