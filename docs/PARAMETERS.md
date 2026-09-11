# ⚙️ Configuration Guide

## **Configuration System Overview**

TAK Team Manager is configured in two complementary layers. Both land in the **same** running ECS task - the container cannot tell where a value came from; the distinction is about **where the value is authored**.

1. **AWS CDK context** - Infrastructure settings resolved by CDK at deploy time and wired into the task definition (or its `secrets`). Stored in [`cdk/cdk.json`](../cdk/cdk.json) under the `context` section, version-controlled, overridable with `--context`. Changing one means changing CDK code/context and redeploying.
2. **The deployment config file** - Operations-editable runtime settings uploaded to the shared BaseInfra S3 config bucket and loaded via `ecs.EnvironmentFile.fromBucket`. Editable by replacing the S3 object and restarting the task - no CDK redeploy.

For local development there is no CDK stack or S3 file: copy [`.env.example`](../.env.example) to `.env` and fill in values directly. `.env.example` is the authoritative, fully-commented reference for every variable the application reads.

---

## **📋 Environment Configurations (CDK context)**

Each environment is a block under `context` in [`cdk/cdk.json`](../cdk/cdk.json).

### **Development Environment (`dev-test`)**
```json
{
  "dev-test": {
    "stackName": "Dev",
    "r53ZoneName": "dev.tak.nz",
    "hostname": "team",
    "database": {
      "instanceClass": "db.serverless",
      "instanceCount": 1,
      "engineVersion": "17.4",
      "backupRetentionDays": 7,
      "deleteProtection": false
    },
    "ecs": {
      "taskCpu": 512,
      "taskMemory": 1024,
      "desiredCount": 1,
      "enableEcsExec": true
    },
    "app": {
      "deviceManagementEnabled": true,
      "offlineMapsEnabled": true
    },
    "general": {
      "removalPolicy": "DESTROY",
      "enableContainerInsights": false
    }
  }
}
```

### **Production Environment (`prod`)**
```json
{
  "prod": {
    "stackName": "Prod",
    "r53ZoneName": "tak.nz",
    "hostname": "team",
    "database": {
      "instanceClass": "db.t4g.large",
      "instanceCount": 2,
      "engineVersion": "17.4",
      "backupRetentionDays": 30,
      "deleteProtection": true
    },
    "ecs": {
      "taskCpu": 1024,
      "taskMemory": 2048,
      "desiredCount": 2,
      "enableEcsExec": false
    },
    "app": {
      "deviceManagementEnabled": true,
      "offlineMapsEnabled": true
    },
    "general": {
      "removalPolicy": "RETAIN",
      "enableContainerInsights": true
    }
  }
}
```

### **CDK Context Reference**

| Key | Description |
|-----|-------------|
| `stackName` | Environment label used to derive the stack name (`TAK-<stackName>-TAKTeamManager`) and cross-stack import names |
| `r53ZoneName` | Route 53 hosted zone the `team.<zone>` record is created in |
| `hostname` | Subdomain label (default `team`) |
| `database.*` | Aurora instance class, count, engine version, storage, backup retention, deletion protection, Performance Insights |
| `ecs.taskCpu` / `ecs.taskMemory` | Fargate task sizing |
| `ecs.desiredCount` | Number of web tasks |
| `ecs.enableEcsExec` | Whether ECS Exec is enabled (debugging) |
| `app.deviceManagementEnabled` | Wires the TAK Server (tak-infra) imports; defaults `true` |
| `app.offlineMapsEnabled` | Wires the base-infra map-downloads bucket; defaults `true` |
| `general.removalPolicy` | `DESTROY` (dev) or `RETAIN` (prod) for stateful resources |
| `general.enableContainerInsights` | ECS Container Insights |

The `tak-defaults` block holds project-wide values (`project`, `component`, default `region` `ap-southeast-2`). Any single value can be overridden on the CLI, e.g. `--context taskCpu=1024 --context desiredCount=3`.

---

## **🔐 Runtime Configuration: the Two Env-Var Groups**

The application reads its runtime configuration from environment variables, authored in one of two places. The headings below mirror the structure of [`.env.example`](../.env.example), which carries the full per-variable commentary.

### **Part 1 - CDK-managed** (task-definition `environment`/`secrets`)

Everything imported from another stack, or managed by this stack itself.

| Group | Variables | Source |
|-------|-----------|--------|
| Authentik core | `AUTHENTIK_URL`, `AUTHENTIK_API_TOKEN`, `AUTHENTIK_ENROLLMENT_ADMIN_TOKEN` | Imported from auth-infra (least-privilege service account; enrollment uses the admin token) |
| Authentik OIDC | `AUTHENTIK_CLIENT_ID`, `AUTHENTIK_CLIENT_SECRET`, `AUTHENTIK_TOKEN_URL`, `AUTHENTIK_USERINFO_URL`, `AUTHENTIK_LOGOUT_URL` | This app's OIDC application (created at deploy time) |
| Database | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | This stack's own Aurora + the secret RDS generates |
| Generated secrets | `JWT_SECRET`, `JWT_EXPIRES_IN`, `CREDENTIAL_ENCRYPTION_KEY` | Synthesized by this stack; no human chooses the value |
| App hostnames | `APP_URL`, `FRONTEND_URL` | This stack's own ALB/Route 53 |
| TAK Server *(optional)* | `TAK_SERVER_URL`, `TAK_SERVER_ENROLLMENT_URL`, `TAK_SERVER_TLS_SERVERNAME`, `TAK_CA_PATH`, `TAK_ADMIN_CERT_SOURCE`, `TAK_ADMIN_CERT_SECRET_ARN` | Imported from tak-infra when device management is on |
| CloudTAK *(optional)* | `CLOUDTAK_URL` | CDK context shared with CloudTAK's stack |
| Secrets provider | `SECRETS_PROVIDER`, `AWS_REGION` | Deployment mode |
| Runtime | `PORT`, `NODE_ENV`, `TRUSTED_PROXY_HOPS` | Known to this stack at synth time |
| Client build (Vite) | `VITE_API_BASE_URL`, `VITE_DEV_PROXY_TARGET`, `VITE_START_OVER_URL` | Baked into the bundle at image-build time (Docker build args) |

> **`TAK_SERVER_URL` and `TAK_SERVER_ENROLLMENT_URL` are deliberately different hosts, not aliases.** `TAK_SERVER_URL` is the Marti certadmin API's mutual-TLS endpoint (often internal/admin-only). `TAK_SERVER_ENROLLMENT_URL` is the public, client-dialable host used to build enrollment URIs/QR payloads. They may legitimately point at different hostnames and/or ports.

> **`TRUSTED_PROXY_HOPS`** is a hop *count*, never `true`. Default `0` is correct for local/dev/test. Set to `1` once deployed behind the ALB with no CDN, `2` if a CDN sits in front. See the [Deployment Guide](DEPLOYMENT_GUIDE.md#behind-the-load-balancer-trusted_proxy_hops).

### **Part 2 - The Deployment Config File** (S3 `EnvironmentFile`)

Everything that is neither imported from another stack nor something CDK can generate itself. Loaded into the same task; edit by replacing the S3 object and restarting.

| Group | Variables |
|-------|-----------|
| reCAPTCHA v3 | `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET`, `RECAPTCHA_MIN_SCORE`, `RECAPTCHA_DISABLED` |
| Email / SMTP *(required for real use)* | `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`, `EMAIL_USE_TLS`, `EMAIL_USE_SSL`, `EMAIL_TIMEOUT`, `EMAIL_FROM` |
| Feature flags | `CLOUDTAK_ENABLED`, `CLOUDTAK_AGENCY_GROUP_PREFIX`, `DEVICE_MGMT_ENABLED`, `DEVICE_MGMT_REVOKE_ENABLED`, `CERT_EXPIRY_NOTIFICATIONS_ENABLED`, `FORCE_SSO_LOGIN` |
| Offline maps | `OFFLINE_MAPS_ENABLED`, `OFFLINE_MAPS_S3_BUCKET`, `OFFLINE_MAPS_S3_REGION`, `OFFLINE_MAPS_URL_TTL_SECONDS` |
| Database tuning | `DB_POOL_MAX`, `DB_CA_PATH` |
| Sync engine tuning | `AUTHENTIK_SYNC_ENABLED`, `SYNC_INTERVAL_MINUTES`, `SYNC_WORKER_BATCH_SIZE`, `SYNC_WORKER_CONCURRENCY`, `AUTHENTIK_SYNC_CONCURRENCY`, `SYNC_WORKER_HEALTH_PORT` |
| Authentik rate limiting | `AUTHENTIK_RATE_LIMIT_ENABLED`, `AUTHENTIK_RATE_LIMIT_READ_PER_SEC`, `AUTHENTIK_RATE_LIMIT_WRITE_PER_SEC`, `AUTHENTIK_RATE_LIMIT_WRITE_PRIORITY_PER_SEC` |
| Group reconciler | `BULK_GROUP_RECONCILE_ENABLED`, `BULK_GROUP_RECONCILE_DRY_RUN`, `OWNED_GROUP_SWEEP_ENABLED`, `OWNED_GROUP_SWEEP_INTERVAL_MINUTES`, `AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES`, `PINNED_MEMBERS_*` |
| Device management tuning | `TAK_ADMIN_CERT_REFRESH_INTERVAL_SECONDS`, `DEVICE_MGMT_POLL_INTERVAL_SECONDS`, `DEVICE_MGMT_SYNC_INTERVAL_SECONDS`, `CALLSIGN_POLL_INTERVAL_SECONDS`, `DEVICE_MGMT_REVOKE_MAX_CERTS`, `DEVICE_MGMT_EXPIRY_WARNING_DAYS`, `CALLSIGN_MISMATCH_STALE_DAYS` |
| Certificate expiry tiers | `CERT_EXPIRY_TIER1_DAYS`..`TIER4_DAYS`, `CERT_EXPIRY_ACTIVITY_WINDOW_DAYS` |
| Retention | `RETENTION_CLEANUP_INTERVAL_SECONDS`, `SYNC_OPERATIONS_RETENTION_DAYS`, `AUDIT_LOGS_RETENTION_DAYS` |
| TAK colour / role labels | `TAK_COLOR_*`, `TAK_ROLE_*` |
| Presentation & branding | `ADMIN_GROUP_NAME`, `CHANNEL_FOLDER_SEPARATOR`, `TOS_URL`, `DOCS_URL`, `ACCOUNT_LOGIN_URL`, `PASSWORD_RESET_URL`, `WINTAK_MANUAL_DESCRIPTION` |
| Date display | `DISPLAY_TIMEZONE`, `DISPLAY_LOCALE` |
| Daily digest schedule | `DIGEST_HOUR`, `DIGEST_MINUTE`, `DIGEST_TIMEZONE` |

---

## **🚩 Feature Flags**

Every capability flag is read through a named helper, defaults to **off**, and is true **only** for the exact string `'true'` - `'TRUE'`, `'1'`, `' true '` are all false.

The one deliberate exception is **`AUTHENTIK_SYNC_ENABLED`**: an operational kill-switch, opt-**out** (on by default, disabled only for the exact string `'false'`). Use it to halt the periodic Authentik sync and its reconciliation sweep during a bulk import or an Authentik maintenance window, where a partial fetch could otherwise false-orphan real users.

| Flag | Scope | Feature-off behavior |
|------|-------|----------------------|
| `DEVICE_MGMT_ENABLED` | Server-only | Device reads answer 404 |
| `DEVICE_MGMT_REVOKE_ENABLED` | Server-only | Revocation disarmed; 403, queued revoke logged as dry-run |
| `CERT_EXPIRY_NOTIFICATIONS_ENABLED` | Server-only | Requires device management too; daily job no-ops |
| `CLOUDTAK_ENABLED` | Server-only | Agency-group enqueue sites skipped |
| `OFFLINE_MAPS_ENABLED` | Server-only | Routes 404, download card hidden |
| `DEVICE_MGMT_EXPIRY_WARNING_DAYS` | Client-exposed | Presentation only (how a date is drawn) |

Only presentation values (`display_timezone`, `display_locale`, `device_expiry_warning_days`) are ever exposed via `GET /api/config/public`. Capability gates stay server-only.

---

## Quick Links

- **[Main README](../README.md)** - Complete project overview
- **[Deployment Guide](DEPLOYMENT_GUIDE.md)** - Detailed deployment instructions
- **[Quick Reference](QUICK_REFERENCE.md)** - Fast deployment commands and environment comparison
- **[Architecture Guide](ARCHITECTURE.md)** - Technical architecture details
- **[.env.example](../.env.example)** - The authoritative per-variable reference
