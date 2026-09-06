---
inclusion: always
---

# Feature flags

Every CAPABILITY flag is read through a named helper, is true ONLY for the exact string `'true'`, and defaults to off. `'TRUE'`, `'1'`, `' true '` are all false. Never loosen to truthiness.

The ONE deliberate exception is `AUTHENTIK_SYNC_ENABLED` below: it is an operational kill-switch, not a capability gate, so it is opt-OUT (on by default, disabled only for the exact string `'false'`). A capability that ships OFF-by-default must never be modelled this way — the exception exists solely because the periodic sync must run by default and the flag's only job is to let an operator stop it.

- **`DEVICE_MGMT_ENABLED`** — `isDeviceMgmtEnabled()` in `server/config/deviceMgmt.js`. Server-only, never in `GET /api/config/public`. Gates device reads; feature-off answers 404.
- **`DEVICE_MGMT_REVOKE_ENABLED`** — `isDeviceMgmtRevokeEnabled()` in `server/config/deviceMgmt.js`. Server-only. Arms certificate revocation. INDEPENDENT of `DEVICE_MGMT_ENABLED`, never derived from or defaulted to it. Disarmed answers 403 with `capability` naming the flag, and a queued revoke completes as a logged dry-run rather than failing.
- **`CLOUDTAK_ENABLED`** — `isCloudTakEnabled()` in `server/config/cloudtak.js`. Server-only. Gates CloudTAK agency-group enqueue sites. Guard at every ENQUEUE site, never inside a worker handler, so a flag flip cannot silently discard queued work.
- **`DEVICE_MGMT_EXPIRY_WARNING_DAYS`** — read in `server/models/SiteConfig.js`. IS client-exposed, deliberately: it only affects how a date is drawn. Default 30.
- **`AUTHENTIK_SYNC_ENABLED`** — read in `AuthentikSyncService.startPeriodicSync()` (`server/services/authentikSync.js`). Server-only. Operational kill-switch for the periodic Authentik user sync AND its Reconciliation_Sweep. OPT-OUT (the documented exception above): the sync runs by default; it is disabled ONLY when the value is exactly `'false'`, which skips both the initial run and the recurring interval. Use it to halt the sweep during a bulk import or an Authentik maintenance window, where a partial fetch could otherwise mis-orphan real users (the sweep also has a fetch-completeness guard for this — see `authentik-scaling.md`). Not a capability gate; introduces no 404/403.

## Rules

- Capability gates stay server-only. Only Presentation_Config — values that affect rendering alone, like `display_timezone` and `device_expiry_warning_days` — may be added to `GET /api/config/public`.
- The two device flags are covered by a regex guard in `server/models/SiteConfig.test.js` that scans the whole serialized public-config response. Do not weaken it.
