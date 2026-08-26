---
inclusion: always
---

# Feature flags

Every flag is read through a named helper, is true ONLY for the exact string `'true'`, and defaults to off. `'TRUE'`, `'1'`, `' true '` are all false. Never loosen to truthiness.

- **`DEVICE_MGMT_ENABLED`** — `isDeviceMgmtEnabled()` in `server/config/deviceMgmt.js`. Server-only, never in `GET /api/config/public`. Gates device reads; feature-off answers 404.
- **`DEVICE_MGMT_REVOKE_ENABLED`** — `isDeviceMgmtRevokeEnabled()` in `server/config/deviceMgmt.js`. Server-only. Arms certificate revocation. INDEPENDENT of `DEVICE_MGMT_ENABLED`, never derived from or defaulted to it. Disarmed answers 403 with `capability` naming the flag, and a queued revoke completes as a logged dry-run rather than failing.
- **`CLOUDTAK_ENABLED`** — `isCloudTakEnabled()` in `server/config/cloudtak.js`. Server-only. Gates CloudTAK agency-group enqueue sites. Guard at every ENQUEUE site, never inside a worker handler, so a flag flip cannot silently discard queued work.
- **`DEVICE_MGMT_EXPIRY_WARNING_DAYS`** — read in `server/models/SiteConfig.js`. IS client-exposed, deliberately: it only affects how a date is drawn. Default 30.

## Rules

- Capability gates stay server-only. Only Presentation_Config — values that affect rendering alone, like `display_timezone` and `device_expiry_warning_days` — may be added to `GET /api/config/public`.
- The two device flags are covered by a regex guard in `server/models/SiteConfig.test.js` that scans the whole serialized public-config response. Do not weaken it.
