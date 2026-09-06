---
inclusion: fileMatch
fileMatchPattern: 'server/**/*.js'
---

# TAK Server / Marti API integration facts

Hard-won facts about TAK Server's Marti HTTP API, verified against a live server while building device management. The endpoint contract is `tak-server-openapispec.json` (committed at the repo root) — an endpoint absent from it is treated as non-existent and must not be called. These facts are easy to get wrong again because the API's naming is misleading; re-verify against a live server before changing anything in `TakServerService.js`, `DeviceSync.js`, or `SubscriptionPoller.js`.

- **`/Marti/clients` does not exist.** Returns 404, absent from the OpenAPI spec entirely. A 404 there previously meant "no clients observed" (graceful-404-as-empty), so a wrong URL was silently indistinguishable from an idle server — no error ever logged. Last_Seen is derived only from `GET /Marti/api/clientEndPoints`, never from this endpoint or from `cot_router`/TAK Server DB access.
- **`GET /Marti/api/certadmin/cert/active` is not "the live set."** It is a candidate set: on a live server it returned 95 certificates, of which 90 also appeared in `GET /Marti/api/certadmin/cert/revoked`. The live set is `/active` minus membership in `/revoked`.
- **`revocationDate` is not a reliable revocation signal.** Every certificate returned by `/active` carries a non-null `revocationDate`, including ones absent from `/revoked`. The only authoritative revocation signal is membership in `GET /Marti/api/certadmin/cert/revoked`. Verifying a revocation by checking `cert.revocationDate === null` passes unconditionally and is wrong — re-query the revoked-certificates view instead.
- **`clientUid` is heavily reused.** On a live server, 95 certificates collapsed to 10 distinct `clientUid`s (one uid held 60 certificates). A Device is a `clientUid` holding a SET of live certificates, not one certificate. Superseding must be computed locally (newest `issuanceDate` per `clientUid`) — `/certadmin/cert/replaced` cannot be used for this; it was byte-identical to `/active`.
- **Revocation is user-scoped, not device-scoped, at the queue level.** `revoke_tak_certificates` (`server/workers/operationSchemas.js`) matches every certificate whose `creatorDn` matches the given username via `TakServerService.matchesCreatorDn`. Revoking one Device therefore revokes every certificate that user holds across every device unless the payload explicitly resolves to a single `clientUid`'s certificate set first.
- **`GET /Marti/api/clientEndPoints` is the real last-seen source**, but its `uid` space only coincides with a certificate's `clientUid` for native ATAK/iTAK/WinTAK clients. It diverges for CloudTAK (`ANDROID-CloudTAK-<email>` on the certificate side vs `<email> (Web)` on the endpoint side) — this divergence is why `SubscriptionPoller`'s Connection_Alias matching exists; do not assume the two uid spaces are the same key.

## Certificate revocation safety rails

A real incident: 20 valid certificates were revoked in one batch on a shared live TAK Server while this feature was active. The application was confirmed NOT the cause (zero `revoke_tak_certificates` operations existed in `sync_operations` at the time; the batch's timing matched a recurring TAK-Server-side pattern that predates this app). But the investigation exposed that the *existing* revoke path would have reported false success regardless (verification checked the unreliable `revocationDate` field) and was over-scoped (a user-scoped payload revokes every certificate a user holds). That produced the rails now enforced in `syncWorker.js`'s revoke handler — do not weaken any of these:

- Two independent feature flags, `DEVICE_MGMT_ENABLED` and `DEVICE_MGMT_REVOKE_ENABLED` (see `feature-flags.md`) — never one three-state variable. A three-state value can be silently widened by a typo; two booleans that must BOTH be `'true'` cannot.
- While `DEVICE_MGMT_REVOKE_ENABLED` is false, a queued revoke logs its complete audit record, issues no `DELETE`, flips no `revoked` flag, and returns success as a **logged dry-run** rather than a failure — so it is not retried forever and the queue does not silently fill with revokes waiting to fire the moment the flag flips.
- A blast-radius cap, `DEVICE_MGMT_REVOKE_MAX_CERTS` (default 250, set above the largest real per-device certificate count ever measured: 60). Exceeding the cap aborts with no `DELETE` issued.
- **Truncating to the cap is forbidden, not merely discouraged.** A truncated revoke leaves some of a Device's certificates valid while the operation reports success and the UI marks the Device revoked — a device presented as disabled that still connects. Refusing the whole operation is a visible, fixable state; a partial revocation is an invisible, wrong one.
- A non-truncated audit record (`revoke_audit` before the `DELETE`, `revoke_audit_result` after) is logged for every revoke attempt, dry-run or real, user-scoped or device-scoped. This is the only artifact that can answer "did we actually revoke these?" after the fact — the incident above showed that without it, there is nothing to answer with.

## CloudTAK pseudonymity boundary

Verified by reading the TAK-NZ CloudTAK fork's source directly (`api/stateless/lib/authentik-provider.ts`, `api/common/connection-config.ts`): CloudTAK's certificate Common_Name, `clientUid`, and CoT uid are all constructed from the user's **email address**, never their Authentik username, regardless of this app's Pseudonymous_Username_Policy. A member of a pseudonymous Organisation who connects via CloudTAK/WebTAK therefore has their real email visible in TAK Server's certificate inventory and in the CoT stream.

The pseudonymity boundary is the Authentik username, and CloudTAK does not cross it. The fix belongs in the CloudTAK fork (replace email with the Authentik username in those three constructions), not in TAK Team Manager — do not add a display-layer suppression, rewrite, or workaround here to compensate for it. If this defect is ever reintroduced upstream, the correct response is fixing CloudTAK, not building around it.

## Authentik PATCH semantics

Authentik's `PATCH` on a user's `attributes` field replaces the **whole dict**, not a merge — there is no partial-attribute PATCH. `UserAttributesService.updateUserAttributes` fetches the current attributes, merges the supplied keys into them client-side, then PATCHes the merged object (see `updateUserAttributes`'s doc comment for the fetch-merge-PATCH shape). Any new caller that PATCHes `attributes` directly without this fetch-merge step will silently wipe every attribute it didn't explicitly supply — this exact bug once caused a callsign regeneration to overwrite a Team_Admin's real `tak_role` back to the hardcoded default, because `computeCallsignAttributes` always returns `role: 'Team Member'`.

## Why `node-forge`, not `pem`, for P12→PEM conversion

`node-forge` (pinned in `package.json`) converts the TAK Server admin P12 credential to PEM in pure JS. The CloudTAK reference implementation instead uses the `pem` package, which shells out to the system `openssl` binary — that adds a runtime dependency on an `openssl` executable being present in the container, and re-introduces the legacy-provider problem (some P12 bundles use legacy PKCS#12 algorithms like RC2/3DES that Node/OpenSSL 3 do not load by default) at the CLI level instead of the library level. `node-forge` avoids both: no native/binary dependency, and it works uniformly in the app container, the Sync_Worker, and Jest without requiring an `openssl` binary anywhere.
