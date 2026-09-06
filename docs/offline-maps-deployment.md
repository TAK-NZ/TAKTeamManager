# Offline map downloads — deployment / CDK handoff

The offline-maps feature (offering `.mbtiles` map files for download on `/downloads`) is
**implemented in the app**. This document covers the ONE piece it cannot self-provision:
the AWS access and environment the app needs at runtime. It is the handoff for whoever owns
the CDK, and sits alongside `docs/cloudwatch-metrics.md` as a peer deployment note.

## How it works (one paragraph)

The server exposes two authenticated routes — `GET /api/offline-maps` (catalog + live sizes)
and `GET /api/offline-maps/:id/url` (a short-lived presigned S3 GetObject URL). The browser
downloads directly from S3 via the presigned URL; the app never proxies the bytes. The whole
feature is gated by `OFFLINE_MAPS_ENABLED` (off by default) and the router is only mounted
when it is `'true'`. File sizes are read live from S3, so a not-yet-uploaded file is shown as
unavailable rather than a dead link — the marine and vector files self-populate once their
S3 objects exist, with no code change. Credentials come from the AWS SDK default chain (the
ECS task role in production); the app reads no AWS keys from the environment.

The bucket is created in base-infra and is **not publicly accessible** (all public access
blocked). Exported as `TAK-<StackName>-BaseInfra-MapDownloadsBucket`. Region `us-west-2`.

## Required task-role policy (least privilege, read-only)

The app's ECS task role needs read-only access to the one map-downloads bucket. Presigning
is a local crypto operation, but the signature it produces is only honoured by S3 if the
*signing* credentials actually hold `s3:GetObject`; and the catalog listing needs
`s3:ListBucket` to read object sizes.

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

## CDK wiring (recommended shape)

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
   region-scoped in its signature. Make sure `OFFLINE_MAPS_S3_REGION` matches the bucket's
   actual region or presigns fail with a region-mismatch error.
5. **No bucket policy / CORS change needed for the download itself:** the browser fetches the
   presigned URL as a top-level navigation (`window.location.href`), not an XHR/fetch, so S3
   CORS does not apply. Keep all public access blocked; presigned URLs work regardless.
6. **The bucket stays private.** Do not make it public and do not add a public-read policy —
   presigned URLs are the entire access mechanism.

## Environment variables

All are documented in `.env.example`. Server-only; `OFFLINE_MAPS_ENABLED` is a capability
flag and is deliberately never surfaced through `GET /api/config/public` (the client
discovers the feature by probing the list route, 200 vs 404).

| Variable | Default | Notes |
|---|---|---|
| `OFFLINE_MAPS_ENABLED` | `false` | Master switch; `true` mounts the routes. |
| `OFFLINE_MAPS_S3_BUCKET` | (unset) | No safe default; unset ⇒ the routes answer 503. |
| `OFFLINE_MAPS_S3_REGION` | `us-west-2` | Falls back to `AWS_REGION`, then `us-west-2`. |
| `OFFLINE_MAPS_URL_TTL_SECONDS` | `300` | Bounds only the time to START a download. |

## Verified in local test

Enabled in the local (uncommitted) `.env` against the real bucket
`tak-demo-baseinfra-us-west-2-453572736517-map-downloads`, using the dev box's own instance
credentials via the SDK default chain (no keys in `.env`). Confirmed end-to-end: all 16
regional `.mbtiles` list with correct live sizes; marine + the two vector files correctly
report unavailable (their S3 objects do not exist yet); a presigned URL returns HTTP 206
with `Content-Disposition: attachment` and streams real SQLite bytes; and a traversal-style
bad id is rejected before any S3 call. The only thing the CDK adds beyond this is the
task-role grant + env injection above — no code changes.
