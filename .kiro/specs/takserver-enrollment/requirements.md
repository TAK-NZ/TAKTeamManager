# Requirements Document

## Introduction

This feature folds the standalone `enrollment-lambda` (`/home/ubuntu/GitHub/TAK-NZ/auth-infra/src/enrollment-lambda`) into TAK Team Manager, so that the Lambda can be decommissioned once TAK Team Manager reaches production. The Lambda's `index.js` and `views/partials/store_badges.ejs` are the behavioural reference for everything this document requires of the Enrollment_View and the Downloads_Page; where this document and the Lambda differ, the difference is stated and the reason given.

The Lambda does one thing: it takes an authenticated user, mints a short-lived Authentik `app_password` token for that user, and renders two QR codes — an ATAK deep-link URI and an iTAK JSON registration payload — plus a live countdown to token expiry, a re-enrollment date, the user's TAK attributes, and the TAK app download badges. Folding it in means TAK Team Manager must serve the same page to a signed-in human for their OWN account (self-service), in addition to the team-owned-device case the backend already covers.

**A substantial backend already exists. This document CORRECTS it; it does not start fresh.** `production-hardening` Requirement 27 ("Team-Owned Device Enrollment with Admin-Generated QR Codes") shipped: the `users.is_team_device` / `users.device_label` columns (and the same pair on `user_cache`, both present in `1786596755665_baseline-schema.cjs`), `server/services/DeviceEnrollmentService.js` (`createDevice`, `generateEnrollmentQrCode`, `assertAuthorized`), `server/routes/devices.js` including its Requirement 27.8 audit logging, `authentikService.createAppPasswordToken`, and a `device:manage` permission identifier deliberately present in BOTH `roleDefaults.global_manager` and `roleDefaults.authenticated_user`. Team_Owned_Devices are already excluded from user lists and member counts (Requirement 27.9). `BUGS.md` BUG-009 records the remaining gap: no client user interface exists for any of it. Satisfying this document closes BUG-009.

### Corrections to `production-hardening` Requirement 27

Four corrections, each stating what it supersedes. These are confirmed decisions, not proposals. Per `.kiro/specs/` convention a later spec overrules an earlier one, so where this document and Requirement 27 conflict, this document wins.

1. **The identifier scheme.** `DeviceEnrollmentService.createDevice` currently mints its username as `device-` followed by `crypto.randomUUID()`. Requirement 27 does not name that form in a criterion — Criterion 27.2 cites `devices.tak.nz.invalid` only as an example subdomain — so this correction supersedes the shipped implementation rather than a criterion's text. Replaced by the Managed_Identifier of Requirement 1: `<PREFIX>-D<7>`, human-readable, derived from the Organisation's Organisation_Prefix.

2. **A Team_Owned_Device gets NO email address.** This SUPERSEDES **Criterion 27.2**, which currently *mandates* a synthetic address under a reserved `.invalid` subdomain, and with it the `DEVICE_EMAIL_DOMAIN` constant in `DeviceEnrollmentService.js`. Two reasons, in ascending order of weight. First, a synthetic address is guessable, and a guessable address on a real Authentik account can be used to *initiate* an Authentik password-reset flow whose mail then goes nowhere — a request the operator cannot see the outcome of. That concern becomes practical specifically BECAUSE the new identifier is human-readable and derivable from data visible in the user interface and embedded in TAK certificates, where the current 122-bit uuid was not guessable at all. Second, and decisively: an email address on a device account has no function whatsoever. The account cannot log in, cannot read mail, and has no human owner. It is pure attack surface, and the correct amount of pure attack surface is none. Requirement 5 specifies the schema, invariant and sync consequences this correction pulls in.

3. **The iTAK payload as shipped is functionally wrong** and would not work in iTAK. `generateEnrollmentQrCode` returns `itakEnrollmentPayload: { host, username, token }`, which is not a shape iTAK parses. This SUPERSEDES **Criterion 27.6**'s "the equivalent iTAK JSON registration payload using the same host, username, and token values" to the extent that criterion is read as licensing any JSON object carrying those three values. The correct shape is the Lambda's, and Requirement 4 requires it verbatim. Port **8089** is always correct for TAK Server client enrollment and is therefore required as a constant, not as a configurable.

4. **`generateEnrollmentQrCode` actively blocks the human-user case.** It throws `NotATeamOwnedDeviceError` when the target row's `is_team_device` is not `true`, so the one code path that mints an enrollment token refuses to serve a human. This SUPERSEDES **Criterion 27.5**'s scoping of that endpoint to "an existing Team_Owned_Device" and the `NotATeamOwnedDeviceError` guard that implements it. Requirement 3 widens the capability to two Enrollment_Principals under two different authorization rules, which is what makes the Lambda redundant.

### Verified facts this document is built on

These were established during planning, against the live test environment and the repository. They are stated here so that no requirement below has to re-derive them and no implementer has to guess.

- **Authentik accepts a user with no email.** Creating a user with the `email` key entirely ABSENT succeeds. Authentik stores the value as the **empty string `""`**, not as null, and two such users coexist with no uniqueness collision. The consequence Requirement 5 makes a requirement: the Authentik→TAK Team Manager sync must map `""` to `NULL`, or TAK Team Manager stores a meaningless empty string that satisfies its own NOT NULL constraint while carrying no information.
- **The schema blocks a null email on TWO tables.** `users.email` is `character varying(254) NOT NULL` and `user_cache.email` is `character varying(255) NOT NULL` (`1786596755665_baseline-schema.cjs`). Both must become nullable. `users.email` additionally carries the `users_email_key` UNIQUE constraint, which is a non-issue: PostgreSQL permits multiple NULLs in a unique index.
- **A NULL email fails closed, not loudly.** Verified: the search clauses (`email ILIKE $1`) and the directory-scope domain matching (`%@domain` LIKE patterns from `buildEmailDomainLikePatterns`) both evaluate to NULL for a NULL email, and a NULL predicate excludes the row rather than raising. A Team_Owned_Device is therefore absent from every domain-scoped directory. That is arguably the correct outcome — a device belongs to a Team, not to an email domain — but it is a behaviour to state, not to discover later.
- **Certificate lifetime is exactly 365 days.** Verified against six live certificates: every one satisfies `issued_at + 365 days = expires_at`. The Lambda's `REENROLL_DAYS: 365` is therefore the real lifetime, not an estimate.
- **A critical nuance about that 365 figure.** At QR-generation time the new certificate does NOT exist yet. `tak_devices.expires_at` is therefore either absent (first enrollment) or belongs to the certificate being REPLACED (re-enrollment). Requirement 10 requires the Enrollment_View to show `now + 365 days` and explicitly FORBIDS reading the stored `expires_at` there, because displaying the outgoing certificate's expiry is worse than displaying a correct arithmetic estimate. The stored value is correct on the device LIST, which `device-management` already renders.
- **`teams` has no organisation short-code column.** The only candidate is `callsign_prefix` (`character varying(255)`, nullable, UNIQUE via the partial index `idx_teams_callsign_prefix`). The live database currently holds **zero** Organisations and **zero** Team_Owned_Devices, so every schema change in this document needs NO backfill, and TAK Team Manager runs only on a local test instance, so schema changes are free.
- **`authentikSync.js` overwrites the local username from Authentik on every sync** (`ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3`, around line 213). This forces a design constraint rather than presenting a problem: a Pseudonymous_Username must BE the Authentik username, set at creation, never a TAK-Team-Manager-local alias. The same conclusion follows independently from the certificate Common_Name, which Authentik derives from the Authentik account.
- **`callsign_suffix` is defaulted from the person's name at creation**, in the "resolve/default/uniqueness-check" phase (`server/routes/users.js:774`, via `UserProvisioningService.resolveCallsignSuffixForNewUser` → `CallsignService.computeDefaultCallsignSuffix`). Per the product rules it is thereafter changed only by explicit admin edit and never recomputed. Requirement 9 suppresses only the DEFAULT, and changes nothing about that never-recomputed rule.
- **There are four user-creation paths**, and Requirement 6 must reach all four: `POST /api/users` (`server/routes/users.js:351`), `POST /api/users/create-and-add` (`server/routes/users.js:845`, which sets `const username = email`), the signup/request-approval flow (`RequestApprovalService.processApprovedRequest`'s `new_account` branch, which also sets `const username = email`), and bulk import (`BulkImportService`, which sets `username = row.username || email.split('@')[0]`).

This document specifies only this feature's behaviour. It does not restate the existing Authentik service, sync worker, permission registry, callsign, visibility or `device-management` behaviour it builds on, except where a requirement below constrains that behaviour.

## Glossary

- **Takserver_Enrollment**: The feature specified by this document: TAK Server client enrollment for a human user's own account and for a Team_Owned_Device, served from TAK Team Manager, replacing the Enrollment_Lambda.
- **Enrollment_Lambda**: The standalone AWS Lambda at `/home/ubuntu/GitHub/TAK-NZ/auth-infra/src/enrollment-lambda`, the behavioural reference for the Enrollment_View and the Downloads_Page, and the component this feature exists to make removable. Its `CONFIG` constants are `TOKEN_EXPIRATION_MINUTES: 30`, `REENROLL_DAYS: 365`, `FORM_SUBMIT_DELAY_MS: 500`.
- **Enrollment_Principal**: The subject an Enrollment_Token is minted for. Exactly two kinds exist: a Human_Principal and a Team_Owned_Device. One shared code path serves both, under two different authorization rules (Requirement 3).
- **Human_Principal**: A `users` row with `is_team_device = false`, enrolling that user's OWN account. Always the caller: there is no route shape by which one Human_Principal enrolls another.
- **Team_Owned_Device**: A `users` row with `is_team_device = true` — a device-only, non-human account for shared or apparatus equipment, which can never complete an OIDC login. Carries a Device_Display_Name instead of a first and last name, and carries NO email address (Requirement 5). Introduced by `production-hardening` Requirement 27; corrected by this document.
- **Managed_Identifier**: A username of the form `<PREFIX>-<TYPE><BODY>`, where `<PREFIX>` is the Organisation_Prefix of the Enrollment_Principal's Organisation, `<TYPE>` is the Identifier_Type_Marker, and `<BODY>` is seven characters drawn from the Identifier_Alphabet. Minted by one shared generator serving both Identifier_Type_Markers. Example: `AUK-D7K3QMX`.
- **Identifier_Type_Marker**: The single character immediately following the `-` in a Managed_Identifier: `D` for a Team_Owned_Device, `U` for a Human_Principal. Occupies a fixed position, so the two Identifier_Type_Markers partition the identifier space and cannot collide by construction.
- **Identifier_Alphabet**: The 31-character set the Managed_Identifier body is drawn from: `A`–`Z` and `0`–`9` (36 characters) MINUS the five ambiguous characters `O`, `0`, `I`, `1`, `L`. Written out in full, and authoritative over any prose description of it: `ABCDEFGHJKMNPQRSTUVWXYZ23456789` — the 23 letters `A`–`Z` without `I`, `L`, `O`, and the 8 digits `2`–`9`. Gives 31^7 = 27,512,614,111 bodies per Organisation per Identifier_Type_Marker.
- **Organisation_Prefix**: A Team's `callsign_prefix` column, WHERE that Team is an Organisation (`parent_team_id IS NULL`). `character varying(255)`, nullable in the schema today, UNIQUE via the partial index `idx_teams_callsign_prefix`, and validated as `[A-Za-z0-9]*` by `server/utils/callsignValidation.js`. Made mandatory for an Organisation by Requirement 2. It is the ONLY existing column that can serve as an organisation short code; `teams` has no other candidate.
- **Enrollment_Token**: An Authentik token with `intent: 'app_password'`, scoped to one Enrollment_Principal's Authentik user, expiring no later than Enrollment_Token_Lifetime from creation. Created via `authentikService.createAppPasswordToken`, whose 30-minute cap is already the shipped `ENROLLMENT_TOKEN_EXPIRATION_MINUTES` constant.
- **Enrollment_Token_Lifetime**: 30 minutes, matching the Enrollment_Lambda's `TOKEN_EXPIRATION_MINUTES` and the shipped `ENROLLMENT_TOKEN_EXPIRATION_MINUTES`. An upper bound, not a default (`production-hardening` Criterion 27.7).
- **ATAK_Enrollment_Uri**: `tak://com.atakmap.app/enroll?host=<host>&username=<username>&token=<token>`, the ATAK deep-link form. Already implemented correctly and unchanged by this document.
- **iTAK_Registration_Payload**: The JSON document iTAK parses from a registration QR code: `{"passphrase":"false","type":"registration","serverCredentials":{"connectionString":"<host>:8089:ssl"},"userCredentials":{"username":<username>,"password":<token>,"registrationId":<uuid>}}`. See Requirement 4. The shipped `{ host, username, token }` shape is NOT this and does not work.
- **Enrollment_Port**: The literal `8089`, TAK Server's client enrollment/streaming TLS port, as it appears in the iTAK_Registration_Payload's `connectionString`. Always correct for this deployment shape, and therefore a constant in the code rather than an environment variable (Criterion 4.4).
- **Certificate_Lifetime**: 365 days. Verified against six live certificates, each satisfying `issued_at + 365 days = expires_at`, which makes the Enrollment_Lambda's `REENROLL_DAYS: 365` the real lifetime rather than an estimate.
- **Re_Enrollment_Date**: The date the Enrollment_View presents as when the certificate about to be issued will need replacing, computed as `now + Certificate_Lifetime` at render time. It is NOT read from `tak_devices.expires_at`, which at that moment either does not exist or belongs to the certificate being replaced (Criterion 10.3).
- **Pseudonymous_Username**: A Managed_Identifier with Identifier_Type_Marker `U`, used as a Human_Principal's Authentik username in place of an email-derived one, so that the username — and therefore the certificate Common_Name — carries no personally identifying information.
- **Pseudonymous_Organisation**: An Organisation whose Pseudonymous_Username_Policy is enabled. Every user created under it receives a Pseudonymous_Username.
- **Pseudonymous_Username_Policy**: The Organisation-level setting that turns Pseudonymous_Username on. Organisation-only in exactly the sense `callsign_level_selection` is: settable on a Team with `parent_team_id IS NULL`, a typed rejection on a Sub_Team, and stored as `null` on a Sub_Team. Fixed at Organisation creation and not changeable afterwards (Requirement 7).
- **Certificate_Common_Name**: The `CN` of the TAK Server client certificate issued to an Enrollment_Principal, which Authentik derives from the Authentik account. This is why a Pseudonymous_Username must BE the Authentik username and can never be a TAK-Team-Manager-local alias, and why changing a username later invalidates certificates (Requirement 7).
- **Pseudonymity_Scope**: The precise extent of what a Pseudonymous_Username achieves: TAK Team Manager still stores the user's first name, last name and email, so a TAK Team Manager operator can always re-identify the user. The pseudonymity is against TAK Server and other TAK users only. See Requirement 8.
- **Callsign_Default_Suppression**: The behaviour required of a Pseudonymous_Organisation by Requirement 9: the name-derived `callsign_suffix` default is not computed, so an admin supplies the Callsign_Suffix explicitly at creation.
- **Enrollment_View**: The client page that renders one Enrollment_Principal's enrollment: the two QR_Data_Urls, the Token_Countdown, the Re_Enrollment_Date, the TAK_Attributes, and the ATAK_Deep_Link subject to Android_Only_Suppression. The direct replacement for the Enrollment_Lambda's `views/content.ejs`.
- **Token_Countdown**: The live `MM : SS` countdown to Enrollment_Token expiry, reaching a terminal `EXPIRED` state, as the Enrollment_Lambda's `generateCountdownScript` implements it.
- **TAK_Attributes**: The Callsign, Colour and Role displayed on the Enrollment_View. Sourced from TAK Team Manager's LOCAL columns (`users.tak_role`, and the Callsign and colour TAK Team Manager derives), NEVER read back from Authentik. `server/services/authentikSync.js` makes `users.tak_role` local-authoritative and pushes it TO Authentik, so Authentik holds the downstream copy and reading it back would display the stale side of that sync.
- **Android_Only_Suppression**: Hiding the ATAK_Deep_Link on a non-Android client, because the `tak://` scheme resolves only where ATAK is installed. The Enrollment_Lambda does this server-side from the `sec-ch-ua-platform` request header; a single-page application has no such request to inspect and must detect the platform client-side (Criterion 10.6).
- **QR_Data_Url**: A QR code rendered server-side to a base64 `data:` URL via the `qrcode` package, already a root dependency at `^1.5.4`. One implementation serves both Enrollment_Principals, and no client dependency is added (Requirement 11).
- **Downloads_Page**: A new navigation item carrying the TAK application download badges, moved OUT of the Enrollment_View. Sourced from the Enrollment_Lambda's `views/partials/store_badges.ejs`.
- **Store_Badge**: One of the three badge SVGs in `store_badges.ejs`: the Google Play badge, the Apple App Store badge, and the TAK_Gov_Badge.
- **TAK_Gov_Badge**: The direct-download badge for TAK.gov. `store_badges.ejs` declares itself the source of truth for it: TAK.gov publishes no badge, so this one was drawn in the same visual idiom, kept at 135×40 to match the official badges' aspect ratio (the page CSS forces `height: 40px`, so a different ratio renders a different width and breaks grid alignment), with its label as outlined vector paths rather than `<text>` so it renders without font dependencies.
- **Recommended_Option_Marker**: The star glyph and its `Recommended option` accessible name that `store_badges.ejs` places beside ATAK-via-TAK.gov and beside TAK Aware, marking the preferred install route per platform.
- **Multiple_Certificate_Warning**: The indicator shown WHERE one Enrollment_Principal holds more than one live TAK Server certificate, counted as `tak_devices` rows for that `user_id`. Carried in TEXT, never by icon or colour alone (Requirement 13).
- **Device_Display_Name**: A Team_Owned_Device's human-readable name, held in the existing `users.device_label` column and mapped to Authentik's `name` field. The Team_Owned_Device analogue of a first and last name.
- **Empty_String_Email**: The value Authentik stores for a user created with the `email` key absent: `""`, not null. Verified empirically. The Authentik_Sync must map it to `NULL` (Criterion 5.5).
- **Device_Email_Null_Invariant**: The database CHECK constraint `email IS NOT NULL OR is_team_device = true`, pairing email nullability with the only case that licenses it. Without the constraint, a defect could create a HUMAN with no email and therefore no account-recovery path.
- **Authentik_Sync**: `server/services/authentikSync.js`, which upserts `users` and `user_cache` from Authentik and overwrites the local `username` on every run.
- **Enrollment_Self_Permission**: The permission identifier gating self-service enrollment, distinct from `device:manage`. `device:manage` is the device-management identifier from `production-hardening` Requirement 27 and means "may create and enroll team-owned devices"; self-service enrollment of one's own account is a different capability and gets its own identifier (Criterion 3.5).
- **Enrollment_Audit_Record**: The `audit_logs` row written for every Enrollment_Token generation, naming the acting user, the target Enrollment_Principal, and the generation time. Already implemented for the Team_Owned_Device path in `server/routes/devices.js` per `production-hardening` Criterion 27.8; extended to the Human_Principal path by Criterion 3.9.
- **Date_Format_Helpers**: The shared `formatDate` / `formatDateTime` functions in `client/src/utils/dateFormat.js`, which render every user-visible date in the application in the configured `display_timezone`. The Enrollment_View's dates go through them like every other date (Criterion 10.9).
- **Structured_Logger**: The existing pino logger (`server/config/logger.js`, `createLogger(...)`), the only permitted server log output — `console.*` is an ESLint error in server code.
- **Connection_Alias**: `device-management`'s pure mapping from one reported `ClientEndpoint.uid` to the set of `client_uid` values it may identify. Referenced here only by Requirement 16, to record that it is unaffected by whether a CloudTAK account identifier is an email address or a pseudonym.
- **Certificate_Uid_Suffix**: One of the two suffixes a CloudTAK-issued certificate's `clientUid` carries — ` (ETL)` from upstream `@tak-ps/node-tak`, ` (Web)` from the TAK-NZ fork — as defined by `device-management`. Referenced here only by Criterion 16.5.
- **CloudTAK_Pseudonymity_Defeat**: The out-of-scope limitation of Requirement 16: for a user who connects via CloudTAK/WebTAK, the certificate Common_Name, the certificate `clientUid` and the CoT uid are all built from the user's EMAIL rather than from the Authentik username, so a Pseudonymous_Username does not pseudonymise that user. The fix is a change in the CloudTAK fork, not in TAK Team Manager.

## Requirements

### Requirement 1: The Managed Identifier

**User Story:** As an operator, I want every device and every pseudonymous user to be identified by a short, unambiguous, organisation-scoped identifier, so that the identifier can be read aloud, typed by hand, and recognised as belonging to a particular Organisation.

This supersedes the shipped `device-<uuid>` username in `DeviceEnrollmentService.createDevice` (Correction 1). A uuid is unambiguous but unusable: 36 characters, unreadable aloud, and carrying no indication of which Organisation owns the device.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL generate a Managed_Identifier as `<PREFIX>-<TYPE><BODY>`, where `<PREFIX>` is the Organisation_Prefix of the Enrollment_Principal's Organisation, `<TYPE>` is the Identifier_Type_Marker, and `<BODY>` is exactly seven characters drawn from the Identifier_Alphabet.
2. THE Takserver_Enrollment SHALL draw every Managed_Identifier body character from the Identifier_Alphabet — `A`–`Z` and `0`–`9` MINUS `O`, `0`, `I`, `1` and `L` — giving 31 characters and 31^7 = 27,512,614,111 distinct bodies per Organisation per Identifier_Type_Marker. The five excluded characters are excluded because a Managed_Identifier is read aloud and typed by hand: `O`/`0` and `I`/`1`/`L` are the pairs a person mistypes and a support call mistransmits, and the cost of excluding them is a negligible reduction in body space.
3. THE Takserver_Enrollment SHALL set the Identifier_Type_Marker to `D` WHERE the Managed_Identifier identifies a Team_Owned_Device, and to `U` WHERE it identifies a Human_Principal.
4. THE Takserver_Enrollment SHALL implement Managed_Identifier generation as ONE shared generator serving both Identifier_Type_Markers, taking the Identifier_Type_Marker as a parameter, and SHALL NOT provide a second generator for the other Identifier_Type_Marker. The two forms differ by one character in a fixed position; two implementations would be two places for the alphabet, the length and the separator to drift.
5. THE Takserver_Enrollment SHALL place the Managed_Identifier generator in `server/utils/`, importing no framework and touching no database, so that a property test can call it directly. This follows the repository's placement rule for pure decision logic with interesting boundaries.
6. THE Takserver_Enrollment SHALL treat the two Identifier_Type_Markers as non-colliding by construction, because the Identifier_Type_Marker occupies the fixed position immediately after the `-` separator, so a `D` identifier and a `U` identifier differ at that position for every possible body. THE Takserver_Enrollment SHALL NOT add a runtime cross-type collision check, which could never fire.
7. THE Takserver_Enrollment SHALL enforce Managed_Identifier uniqueness using the existing `users_username_key` UNIQUE constraint on `users.username` as the authority, and SHALL NOT enforce uniqueness by a pre-insert `SELECT` alone, which races.
8. IF an insert of a generated Managed_Identifier violates `users_username_key`, THEN THE Takserver_Enrollment SHALL generate a fresh body and retry, up to a bounded maximum of five attempts in total.
9. IF all five bounded attempts violate `users_username_key`, THEN THE Takserver_Enrollment SHALL fail the creation with an error and log the exhaustion via the Structured_Logger, and SHALL NOT fall back to any other identifier form. At 27.5 billion bodies per Organisation per type, five consecutive collisions indicates a defect in the generator — most plausibly a non-random or fixed-seed source — and a silent fallback would hide it.
10. THE Takserver_Enrollment SHALL generate every Managed_Identifier body from a cryptographically secure random source (`crypto.randomInt` or equivalent) with a uniform distribution over the Identifier_Alphabet, and SHALL NOT use `Math.random`, and SHALL NOT use a modulo reduction of a byte over a 31-character alphabet, which is not uniform.
11. THE Takserver_Enrollment SHALL cover the Managed_Identifier generator with a fast-check property test asserting, for every generated identifier: the exact shape `<PREFIX>-<TYPE><BODY>`, a body length of exactly seven, that every body character is a member of the Identifier_Alphabet, that no body character is one of the five excluded characters, and that a `D` identifier is never equal to a `U` identifier for the same Organisation_Prefix.

### Requirement 2: An Organisation Prefix Is Mandatory

**User Story:** As an operator, I want every Organisation to carry a prefix, so that a Managed_Identifier can be minted for any device or user in that Organisation without a special case for the Organisations that have none.

`teams.callsign_prefix` is nullable today, and it is the only candidate column: `teams` has no other short-code field. The Managed_Identifier cannot be minted without it, so the nullability has to go. The live database holds zero Organisations, so this needs no backfill and no data migration.

#### Acceptance Criteria

1. WHEN a Team with `parent_team_id IS NULL` is created, THE Takserver_Enrollment SHALL require a non-empty Organisation_Prefix, and IF none is supplied THEN THE Takserver_Enrollment SHALL reject the creation with a validation error naming the missing field.
2. WHEN a Team with `parent_team_id IS NULL` is edited, THE Takserver_Enrollment SHALL require the Organisation_Prefix to remain non-empty, and IF an edit would clear it THEN THE Takserver_Enrollment SHALL reject the edit with a validation error.
3. THE Takserver_Enrollment SHALL apply the Organisation_Prefix requirement to Organisations only, and SHALL leave a Sub_Team's `callsign_prefix` optional exactly as it is today, because a Sub_Team's prefix participates in Callsign generation but never in a Managed_Identifier — a Managed_Identifier is always Organisation-scoped.
4. THE Takserver_Enrollment SHALL enforce Criteria 2.1 and 2.2 on the server, in the create and edit paths, and not solely in the user interface.
5. THE Takserver_Enrollment SHALL validate an Organisation_Prefix with the existing `[A-Za-z0-9]*` pattern in `server/utils/callsignValidation.js` and SHALL NOT introduce a second pattern. That pattern's exclusion of `-` is load-bearing twice over: `-` is the Callsign segment separator, and it is also the Managed_Identifier's separator, so a prefix containing one would make the boundary between prefix and Identifier_Type_Marker ambiguous.
6. THE Takserver_Enrollment SHALL rely on the existing `idx_teams_callsign_prefix` UNIQUE partial index for Organisation_Prefix uniqueness, which is what makes deriving identifiers from it safe: two Organisations cannot share a prefix, so a Managed_Identifier's prefix segment names exactly one Organisation.
7. THE Takserver_Enrollment SHALL implement the nullability change as a `node-pg-migrate` `.cjs` migration in `database/migrations` alongside the existing incremental migrations, and SHALL NOT hand-edit `schema.sql`.
8. THE Takserver_Enrollment SHALL implement Criteria 2.1–2.7 with no data backfill, because the live database holds zero Organisations. WHERE the requirement is applied to a database that does hold Organisations without a prefix, THE Takserver_Enrollment SHALL enforce the requirement at the application layer per Criteria 2.1 and 2.2 rather than by a `NOT NULL` column constraint, so that an unprefixed pre-existing Organisation blocks its own next edit rather than blocking the migration.
9. IF a Managed_Identifier is requested for an Enrollment_Principal whose Organisation carries no Organisation_Prefix, THEN THE Takserver_Enrollment SHALL fail the request with an error naming the Organisation and the missing prefix, and SHALL NOT substitute a placeholder prefix, a team name, or a team id. A substituted prefix would mint an identifier that is not derivable from the Organisation and not unique across Organisations.

### Requirement 3: One Enrollment Capability, Two Principals, Two Authorization Rules

**User Story:** As a signed-in user, I want to enroll my own device from TAK Team Manager, and as a team admin I want to enroll a team-owned device, so that the standalone Enrollment_Lambda has nothing left to do.

This supersedes Criterion 27.5's scoping of enrollment to a Team_Owned_Device, and with it the `NotATeamOwnedDeviceError` guard in `generateEnrollmentQrCode` (Correction 4). Self-service enrollment of a human's own account is the Enrollment_Lambda's entire purpose; without it the Lambda cannot be switched off.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL generate an Enrollment_Token, an ATAK_Enrollment_Uri and an iTAK_Registration_Payload for either Enrollment_Principal through ONE shared server-side code path, and SHALL NOT duplicate the token-minting and payload-building logic per principal kind.
2. THE Takserver_Enrollment SHALL widen `generateEnrollmentQrCode` to accept an Enrollment_Principal whose `is_team_device` is `false`, and SHALL NOT throw `NotATeamOwnedDeviceError` for such a row. That guard is removed rather than relaxed: its whole effect is to block the case this feature exists to serve.
3. WHERE the Enrollment_Principal is a Human_Principal, THE Takserver_Enrollment SHALL authorize the request only WHEN the target account is the acting user's OWN account, and SHALL deny every request whose target is any other account.
4. THE Takserver_Enrollment SHALL implement Criterion 3.3 by giving the self-service route no caller-supplied subject — a route shape carrying no target user identifier, so that the subject is always resolved from the authenticated session — and SHALL NOT implement it as an equality check against a caller-supplied user id. With no id to supply, there is no id to tamper with, and the self-only rule cannot be defeated by a parameter.
5. THE Takserver_Enrollment SHALL gate the self-service route on the Enrollment_Self_Permission, a NEW permission identifier placed in `roleDefaults.authenticated_user`, and SHALL NOT reuse `device:manage`. `device:manage` is the device-management capability from `production-hardening` Requirement 27 and means "may create and enroll team-owned devices"; reusing it would make the two capabilities inseparable, so an operator could not grant self-service enrollment without also granting team-device management.
6. WHERE the Enrollment_Principal is a Team_Owned_Device, THE Takserver_Enrollment SHALL retain the existing Requirement 27 rule unchanged: the acting user must be an admin of the device's Team per `Team.isAdmin` — which resolves Team_Admin through the Ancestor_Chain, so an Organisation admin qualifies for a device on any Sub_Team beneath it — or a Global_Manager.
7. THE Takserver_Enrollment SHALL add an entry to `server/config/permissions.registry.js` for every new route this feature introduces, because authorization is deny-by-default and an unmapped route ships unreachable.
8. THE Takserver_Enrollment SHALL enforce Criteria 3.3 and 3.6 on the server, and not solely in the user interface.
9. WHEN an Enrollment_Token is generated for a Human_Principal, THE Takserver_Enrollment SHALL write an Enrollment_Audit_Record naming the acting user, the target Enrollment_Principal and the generation time, matching what `server/routes/devices.js` already writes for a Team_Owned_Device under `production-hardening` Criterion 27.8.
10. THE Takserver_Enrollment SHALL cap every Enrollment_Token at the Enrollment_Token_Lifetime of 30 minutes for both Enrollment_Principals, reusing the shipped `ENROLLMENT_TOKEN_EXPIRATION_MINUTES` constant, and SHALL NOT make that lifetime configurable — `production-hardening` Criterion 27.7 states an upper bound, not a default.
11. THE Takserver_Enrollment SHALL repeat the authorization check inside the shared service path rather than trusting a check performed by the route layer, preserving the defence-in-depth discipline `DeviceEnrollmentService.assertAuthorized` already applies at both of its call sites.

### Requirement 4: The Correct iTAK Registration Payload

**User Story:** As an iTAK user, I want the iTAK QR code to actually enroll my device, so that scanning it configures a working TAK Server connection.

This supersedes Criterion 27.6 to the extent it licenses the shipped `{ host, username, token }` object (Correction 3). That object is not a shape iTAK parses; scanning it does nothing useful.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL build the iTAK_Registration_Payload with exactly this structure: a top-level `passphrase` of the STRING `"false"`, a top-level `type` of `"registration"`, a `serverCredentials` object carrying a single `connectionString` of `<host>:8089:ssl`, and a `userCredentials` object carrying `username`, `password` set to the Enrollment_Token key, and `registrationId`.
2. THE Takserver_Enrollment SHALL set `passphrase` to the string `"false"` and SHALL NOT set it to the boolean `false`. The Enrollment_Lambda emits the string, iTAK is known to accept the string, and a JSON boolean is a different value that has not been verified against iTAK.
3. THE Takserver_Enrollment SHALL set `userCredentials.password` to the Enrollment_Token key, and SHALL NOT introduce a `token` key in its place — the shipped payload's `token` key is part of why the payload does not work.
4. THE Takserver_Enrollment SHALL use the Enrollment_Port `8089` as a code constant in the `connectionString`, and SHALL NOT read it from an environment variable or from site configuration. It is always correct for this deployment shape, and a configurable value would add a way to render a broken QR code without adding a way to render a working one that `8089` does not already cover.
5. THE Takserver_Enrollment SHALL set `userCredentials.registrationId` to a fresh uuid per generated payload, as the Enrollment_Lambda's `crypto.randomUUID()` does.
6. THE Takserver_Enrollment SHALL derive `<host>` in the `connectionString` from the same configured TAK Server host the ATAK_Enrollment_Uri uses, so the two QR codes on one Enrollment_View can never name different servers.
7. THE Takserver_Enrollment SHALL leave the ATAK_Enrollment_Uri form unchanged, because the shipped `tak://com.atakmap.app/enroll?host=...&username=...&token=...` construction already matches the Enrollment_Lambda.
8. THE Takserver_Enrollment SHALL cover the iTAK_Registration_Payload shape with a test asserting the exact key set and the exact `<host>:8089:ssl` `connectionString` form, so that a future edit cannot quietly reintroduce the `{ host, username, token }` shape.

### Requirement 5: A Team-Owned Device Has No Email Address

**User Story:** As an operator, I want a device account to carry no email address at all, so that there is no address for anyone to guess and no password-reset flow for anyone to initiate against a device.

This SUPERSEDES Criterion 27.2 and removes the `DEVICE_EMAIL_DOMAIN` constant (Correction 2). The reasoning is in the Introduction; the short form is that an email on a device account has no function, so it is pure attack surface, and the new human-readable Managed_Identifier makes that surface reachable in a way the old 122-bit uuid did not.

#### Acceptance Criteria

1. WHEN a Team_Owned_Device is created, THE Takserver_Enrollment SHALL create the corresponding Authentik user with the `email` key ABSENT from the request body, and SHALL NOT send a synthetic address, a reserved-domain address, or an empty string.
2. THE Takserver_Enrollment SHALL store `NULL` in `users.email` and in `user_cache.email` for every Team_Owned_Device.
3. THE Schema SHALL make `users.email` and `user_cache.email` nullable, via a `node-pg-migrate` `.cjs` migration. BOTH columns are `NOT NULL` today and both block this requirement; changing only `users.email` leaves the Authentik_Sync's `user_cache` upsert failing on exactly the rows this feature creates.
4. THE Schema SHALL add the Device_Email_Null_Invariant as a CHECK constraint — `email IS NOT NULL OR is_team_device = true` — to `users` and to `user_cache`. The nullability and the invariant are added together deliberately: nullability alone would let a defect create a HUMAN with no email, and a human with no email has no account-recovery path and no directory-scope membership.
5. WHEN the Authentik_Sync reads a user whose Authentik `email` is the Empty_String_Email, THE Authentik_Sync SHALL store `NULL` in `users.email` and `user_cache.email`, not `""`. Verified empirically: Authentik stores an absent email as `""`, and two such users coexist with no uniqueness collision. Without this mapping TAK Team Manager satisfies its own constraints while storing a value that carries no information and that no query treats as absent.
6. THE Authentik_Sync SHALL remove the current `if (user.email)` skip around the `users` upsert, whose comment states that the skip exists because "`users.email` is a UNIQUE NOT NULL column". Once Criterion 5.3 lands, that premise is false, and leaving the skip in place would silently exclude every emailless account from the local `users` table.
7. THE Takserver_Enrollment SHALL rely on PostgreSQL's treatment of multiple NULLs as non-conflicting under a unique index, so `users_email_key` needs no change and multiple emailless Team_Owned_Devices coexist.
8. THE Takserver_Enrollment SHALL accept that a Team_Owned_Device is absent from every user search that filters on email (`email ILIKE $1`) and from every domain-scoped directory (the `%@domain` LIKE patterns from `buildEmailDomainLikePatterns`), because a NULL email makes those predicates evaluate to NULL and a NULL predicate excludes the row rather than raising. This behaviour is verified and is stated here rather than left to be discovered; it is also arguably correct, since a Team_Owned_Device belongs to a Team, not to an email domain.
9. THE Takserver_Enrollment SHALL ensure a Team_Owned_Device remains reachable in the user interface by its Device_Display_Name and its Managed_Identifier despite Criterion 5.8, so that a device excluded from email-keyed search is not thereby unfindable.
10. THE Takserver_Enrollment SHALL NOT introduce any code path that treats a NULL email as an error or that substitutes a placeholder address for display. WHERE an email would be displayed for a Team_Owned_Device, THE Takserver_Enrollment SHALL display the Device_Display_Name or the Managed_Identifier instead.
11. THE Takserver_Enrollment SHALL implement Criteria 5.3 and 5.4 with no data backfill, because the live database holds zero Team_Owned_Devices, and SHALL NOT retain a migration path for `devices.tak.nz.invalid` addresses, because none exist.

### Requirement 6: Pseudonymous Usernames as a Per-Organisation Policy

**User Story:** As an Organisation whose members' email addresses contain their full names, I want our TAK usernames to carry no personally identifying information, so that our members' names do not appear in TAK Server usernames or in client certificates.

Every user-creation path in TAK Team Manager derives the username from the email: `POST /api/users/create-and-add` and `RequestApprovalService` both set `const username = email`, and `BulkImportService` uses `row.username || email.split('@')[0]`. For an Organisation whose addresses are `firstname.lastname@…`, that puts the member's full name into the Authentik username, and from there into the Certificate_Common_Name.

#### Acceptance Criteria

1. THE Schema SHALL add the Pseudonymous_Username_Policy as an Organisation-level column on `teams`, via a `node-pg-migrate` `.cjs` migration, defaulting to disabled.
2. THE Takserver_Enrollment SHALL treat the Pseudonymous_Username_Policy as Organisation-only in exactly the way `callsign_level_selection` already is: settable on a Team with `parent_team_id IS NULL`, a typed rejection WHEN supplied for a Sub_Team, and stored as `null` on a Sub_Team.
3. WHERE a user is created under a Pseudonymous_Organisation, THE Takserver_Enrollment SHALL set that user's Authentik username to a freshly minted Pseudonymous_Username — a Managed_Identifier with Identifier_Type_Marker `U` — instead of an email-derived username.
4. THE Takserver_Enrollment SHALL set the Pseudonymous_Username as the AUTHENTIK username at account-creation time, and SHALL NOT hold it as a TAK-Team-Manager-local alias over an email-derived Authentik username. Two independent reasons: the Authentik_Sync overwrites `users.username` from Authentik on every run (`ON CONFLICT … DO UPDATE SET username = $2`), so a local alias would be erased on the next sync; and the Certificate_Common_Name is derived from the Authentik account, so a local alias would leave the member's name in the certificate regardless.
5. THE Takserver_Enrollment SHALL continue to store a real, deliverable email address for every user created under a Pseudonymous_Organisation. Only a Team_Owned_Device has no email (Requirement 5). A human without an email has no account-recovery path, and the Device_Email_Null_Invariant of Criterion 5.4 rejects such a row outright.
6. THE Takserver_Enrollment SHALL enforce the Pseudonymous_Username_Policy at EVERY user-creation path: `POST /api/users`, `POST /api/users/create-and-add`, the signup/request-approval flow (`RequestApprovalService.processApprovedRequest`'s `new_account` branch), and bulk import (`BulkImportService`). A path that misses the policy creates a user whose name is in the certificate forever, because Requirement 7 makes the username unchangeable — so a partial implementation is not a partial feature, it is a permanent defect on every user who happens to arrive through the missed path.
7. THE Takserver_Enrollment SHALL apply the policy of the Organisation resolved as `Team.getAncestorChain(targetTeamId)[0]`, and SHALL NOT read the policy from the target Team itself or from a positional read of the chain's tail. The chain is root-first, so index 0 is the Organisation and the tail is the deepest Team.
8. WHERE a user is created under an Organisation whose Pseudonymous_Username_Policy is disabled, THE Takserver_Enrollment SHALL leave the existing email-derived username behaviour of that creation path exactly as it is today.
9. THE Takserver_Enrollment SHALL cover the policy's application at all four creation paths of Criterion 6.6 with tests, including one structural test that fails WHEN a new user-creation path is added without applying the policy, following the precedent of the repository's existing structural guards (`dateFormatConsumers.test.js`, `martiEndpointContract.test.js`, `operationSchemas.test.js`).

### Requirement 7: A Username Is Never Changed, and the Policy Is Create-Time Only

**User Story:** As an operator, I want a username and an Organisation's pseudonymity policy to be fixed once set, so that nobody can invalidate a fleet of certificates by editing a field.

The reason is the Certificate_Common_Name. It is derived from the Authentik account, so a username change makes every certificate issued under the old name mismatch the account it belongs to, invalidates every `tak_devices` row for that user, and forces re-enrollment on every device that user holds.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL provide no interface, route, or administrative action that changes an existing user's username, and IF a request attempts to change a username THEN THE Takserver_Enrollment SHALL reject the request with an error stating that a username is fixed at creation.
2. THE Takserver_Enrollment SHALL treat the Pseudonymous_Username_Policy as fixed at Organisation creation, and IF a request attempts to change the policy on an existing Organisation THEN THE Takserver_Enrollment SHALL reject the request with an error stating the reason: switching the policy is a fleet-wide re-enrollment event, not a setting change.
3. THE Takserver_Enrollment SHALL state, in the rejection message of Criterion 7.2 and at the enforcement site in the code, the concrete consequence being prevented: enabling the policy on an existing Organisation would require every existing user's username to change to a Pseudonymous_Username, and each such change would invalidate that user's Certificate_Common_Name, every certificate issued under it, and every `tak_devices` row referencing it, forcing every device in the Organisation to re-enroll.
4. THE Takserver_Enrollment SHALL enforce Criteria 7.1 and 7.2 on the server, and not solely in the user interface.
5. THE Takserver_Enrollment SHALL leave the Authentik_Sync's local-username overwrite (`ON CONFLICT … DO UPDATE SET username = $2`) unchanged. That statement is not a username-change path in the sense of Criterion 7.1: it copies the Authentik username into the local column, and Authentik is where the username is fixed. THE Takserver_Enrollment SHALL NOT attempt to make the local column authoritative in order to satisfy this requirement, which would invert the sync direction for no gain.
6. WHERE an Organisation's members need different display text without a username change, THE Takserver_Enrollment SHALL direct that change to the Callsign_Suffix, first name, and last name fields, which are editable and which do not appear in the Certificate_Common_Name.

### Requirement 8: The Precise Scope of Pseudonymity

**User Story:** As an Organisation adopting pseudonymous usernames, I want an accurate statement of what pseudonymity does and does not protect, so that nobody in the Organisation believes something about it that is not true.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL continue to store a Pseudonymous_Organisation member's first name, last name and email address in TAK Team Manager, because TAK Team Manager needs them to send mail, to render a human-readable directory, and to scope a directory by email domain.
2. THE Takserver_Enrollment SHALL state the Pseudonymity_Scope explicitly wherever the Pseudonymous_Username_Policy is presented to an operator: the pseudonymity is against TAK Server and other TAK users, and NOT against TAK Team Manager operators, who can always re-identify a member from the record TAK Team Manager holds.
3. THE Takserver_Enrollment SHALL NOT describe the Pseudonymous_Username_Policy as anonymity, and SHALL NOT describe it as preventing TAK Team Manager from holding personally identifying information.
4. THE Takserver_Enrollment SHALL name, in the same operator-facing statement, the limitation of Requirement 16: a member who connects via CloudTAK/WebTAK is not pseudonymised at all, because that path builds the certificate Common_Name and the CoT uid from the email address rather than from the Authentik username.

### Requirement 9: A Pseudonymous Organisation Supplies Callsigns Manually

**User Story:** As an admin of a Pseudonymous_Organisation, I want to set each new user's callsign myself, so that a name-derived callsign does not reintroduce the personally identifying information the pseudonymous username removed.

`UserProvisioningService.resolveCallsignSuffixForNewUser` defaults `callsign_suffix` from the person's first and last name via `CallsignService.computeDefaultCallsignSuffix`. For a Pseudonymous_Organisation that default puts the name straight back into the Callsign, which is broadcast to every other TAK user.

#### Acceptance Criteria

1. WHERE a user is created under a Pseudonymous_Organisation, THE Takserver_Enrollment SHALL apply Callsign_Default_Suppression: the name-derived `callsign_suffix` default SHALL NOT be computed.
2. WHERE Callsign_Default_Suppression applies and no Callsign_Suffix is supplied, THE Takserver_Enrollment SHALL reject the creation with the existing `CallsignSuffixRequiredError`, so an admin supplies the value explicitly rather than receiving a name-derived one.
3. THE Takserver_Enrollment SHALL apply Callsign_Default_Suppression in `resolveCallsignSuffixForNewUser`, the single place the default is computed, so that every creation path inherits the suppression from one edit.
4. THE Takserver_Enrollment SHALL leave the existing uniqueness check on a supplied Callsign_Suffix unchanged, so a manually supplied value is validated exactly as a manually supplied value is today.
5. THE Takserver_Enrollment SHALL leave the product rule that `callsign_suffix` is never recomputed after creation unchanged. This requirement suppresses only the CREATION-time default; it introduces no recomputation and no back-fill of existing rows.
6. THE Takserver_Enrollment SHALL NOT auto-generate a callsign in the WebTAK idiom (for example `Shadow3`, `Ghost5`) as part of this feature. Automatic pseudonymous callsign generation is OUT OF SCOPE for this spec and is recorded as a named follow-up, so that the manual step required by Criterion 9.2 reads as a deliberate decision rather than an unfinished one.
7. THE Takserver_Enrollment SHALL surface the requirement of Criterion 9.2 in the user-creation interface for a Pseudonymous_Organisation as a required field with an explanation, rather than as a validation error the admin discovers on submit.

### Requirement 10: The Enrollment View Carries the Whole Lambda Feature Set

**User Story:** As a user enrolling a device, I want the same information the Enrollment_Lambda gave me — how long the code is valid, when I will need to re-enroll, and what TAK attributes I will connect with — so that switching from the Lambda to TAK Team Manager loses nothing.

#### Acceptance Criteria

1. WHEN an Enrollment_View is rendered, THE Enrollment_View SHALL display the ATAK QR_Data_Url, the iTAK QR_Data_Url, the target Enrollment_Principal's username, and the TAK Server host.
2. WHILE an Enrollment_View is displayed, THE Enrollment_View SHALL display the Token_Countdown as a live `MM : SS` value updating every second, and WHEN the Enrollment_Token expiry passes THE Enrollment_View SHALL display a terminal `EXPIRED` state and stop counting, matching the Enrollment_Lambda's `generateCountdownScript` behaviour including its replacement of the deep-link text with an expired message.
3. THE Enrollment_View SHALL display the Re_Enrollment_Date computed as `now + Certificate_Lifetime` (365 days) at render time, and SHALL NOT read it from `tak_devices.expires_at`. At QR-generation time the new certificate does not exist yet, so the stored value is either absent or belongs to the certificate being REPLACED — displaying the outgoing certificate's expiry as the next re-enrollment date is worse than displaying the correct arithmetic value, because it looks authoritative and is wrong.
4. THE Enrollment_View SHALL present the Re_Enrollment_Date as the date the certificate about to be issued will need replacing, and SHALL NOT present it as a read of an existing certificate.
5. THE Enrollment_View SHALL display the TAK_Attributes — Callsign, Colour and Role — from TAK Team Manager's LOCAL values, and SHALL NOT read them back from Authentik. `server/services/authentikSync.js` makes `users.tak_role` local-authoritative and pushes it TO Authentik, so Authentik holds the downstream copy; reading Authentik back would display the stale side of that sync, which is precisely the divergence the server conventions warn about. This differs deliberately from the Enrollment_Lambda, which reads `attributes.takCallsign` / `takColor` / `takRole` from Authentik because it has no local store to read.
6. WHERE the client platform is not Android, THE Enrollment_View SHALL suppress the ATAK_Deep_Link, because the `tak://` scheme resolves only where ATAK is installed. THE Enrollment_View SHALL implement Android_Only_Suppression by client-side platform detection, and SHALL NOT implement it by the Enrollment_Lambda's server-side `sec-ch-ua-platform` header check — a single-page application renders from data fetched by an API call, so there is no page request whose headers describe the device the page is displayed on.
7. THE Enrollment_View SHALL continue to display both QR_Data_Urls WHILE Android_Only_Suppression is in force, because the QR codes are scanned by a second device and are useful on any platform; only the deep link, which acts on the CURRENT device, is suppressed.
8. THE Enrollment_View SHALL display the Enrollment_Token value as text alongside the QR codes, as the Enrollment_Lambda does, so that a device that cannot scan a code can be enrolled by manual entry.
9. THE Enrollment_View SHALL render every date it displays through the Date_Format_Helpers, so the Enrollment_View's dates appear in the configured `display_timezone` like every other date in the application, and SHALL NOT hard-code a time zone as the Enrollment_Lambda's `Pacific/Auckland` `dateOptions` does.
10. THE Enrollment_View SHALL serve both Enrollment_Principals from one component, so the self-service view and the team-device view cannot diverge on the countdown, the Re_Enrollment_Date, or the payload rendering.
11. THE Enrollment_View SHALL NOT display the app-store badges. They move to the Downloads_Page (Requirement 12).

### Requirement 11: QR Codes Are Rendered Server-Side

**User Story:** As a developer, I want the QR images produced in one place on the server, so that both principals get identical images and the client gains no new dependency.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL render each QR code server-side to a base64 `data:` URL using the `qrcode` package, already a root dependency at `^1.5.4`, exactly as the Enrollment_Lambda's `generateBase64QRCode` does.
2. THE Takserver_Enrollment SHALL return the two QR_Data_Urls in the enrollment API response, so the Enrollment_View renders them as image sources without computing anything.
3. THE Takserver_Enrollment SHALL NOT add a client-side QR-generation dependency to `client/package.json`. The client and the server are separate dependency trees, so a client-side renderer would be a second implementation of the same thing, in a second tree, that could disagree with the server's.
4. THE Takserver_Enrollment SHALL render both QR_Data_Urls through one shared function serving both Enrollment_Principals.
5. THE Takserver_Enrollment SHALL treat the enrollment API response as sensitive: it carries a live Enrollment_Token in the ATAK_Enrollment_Uri, in the iTAK_Registration_Payload, and encoded inside both QR_Data_Urls. THE Takserver_Enrollment SHALL NOT log the response body, the Enrollment_Token key, or either QR_Data_Url at any log level, and SHALL NOT cache the response.

### Requirement 12: The Downloads Page

**User Story:** As a user who has not installed a TAK client yet, I want a page telling me where to get one, so that the enrollment page can stay focused on enrolling.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL provide the Downloads_Page as its own navigation item, and SHALL remove the app-store section from the Enrollment_View.
2. THE Downloads_Page SHALL carry the three Store_Badges from the Enrollment_Lambda's `views/partials/store_badges.ejs`: the Google Play badge, the Apple App Store badge, and the TAK_Gov_Badge.
3. THE Takserver_Enrollment SHALL COPY the Store_Badge SVG markup from `store_badges.ejs` rather than redrawing or regenerating it. `store_badges.ejs` declares itself the source of truth for the TAK_Gov_Badge, and the reasons recorded there are load-bearing: TAK.gov publishes no badge, so this one was drawn in the same visual idiom; it is kept at 135×40 to match the official badges' aspect ratio, because the page CSS forces a 40px height and a different ratio renders a different width and breaks grid alignment; and its label is outlined vector paths rather than `<text>` so it renders identically regardless of the fonts the client has.
4. THE Takserver_Enrollment SHALL preserve the consequence of Criterion 12.3's outlined-paths note in the Downloads_Page code: changing the TAK_Gov_Badge's wording means re-outlining the glyphs, not editing a string.
5. THE Downloads_Page SHALL preserve the Recommended_Option_Marker on ATAK-via-TAK.gov and on TAK Aware, the two routes `store_badges.ejs` marks as preferred, and SHALL NOT mark ATAK-via-Google-Play or iTAK as recommended.
6. THE Downloads_Page SHALL carry the Recommended_Option_Marker's accessible name (`Recommended option`) on the marker itself, so the recommendation is announced rather than conveyed by the star glyph alone.
7. THE Downloads_Page SHALL preserve the four link targets from `store_badges.ejs` unchanged: `https://tak.gov/products/atak-civ`, `https://apps.apple.com/in/app/tak-aware/id6738631659`, `https://play.google.com/store/apps/details?id=com.atakmap.app.civ`, and `https://apps.apple.com/us/app/itak/id1561656396`.
8. THE Downloads_Page SHALL open every external link with `rel="noopener"`, as `store_badges.ejs` does.
9. THE Downloads_Page SHALL be reachable by any signed-in user regardless of team membership, because a user who has not been placed in a Team yet is exactly the user most likely to be installing a client for the first time.

### Requirement 13: A Principal Holding Several Certificates Is Flagged

**User Story:** As a user or an admin, I want to be told when one account holds more than one live TAK Server certificate, so that a duplicate or forgotten enrollment is visible rather than silent.

#### Acceptance Criteria

1. WHERE an Enrollment_Principal holds more than one live TAK Server certificate, THE Takserver_Enrollment SHALL display a Multiple_Certificate_Warning for that principal.
2. THE Takserver_Enrollment SHALL derive the certificate count by counting `tak_devices` rows for that principal's `user_id`, which `device-management` already populates and keeps current.
3. THE Takserver_Enrollment SHALL carry the Multiple_Certificate_Warning state in TEXT that a screen reader announces, and SHALL NOT convey it by an icon alone or by colour alone. This follows the product rule that state a user must perceive is carried by text, and the convention `device-management` Criteria 16.5 and 21.3 already established for the revoked and imminent-expiry states.
4. THE Takserver_Enrollment SHALL include the certificate count in the Multiple_Certificate_Warning text, so that "more than one" is a number rather than an adjective.
5. WHERE an Enrollment_Principal holds exactly one live certificate or none, THE Takserver_Enrollment SHALL display no Multiple_Certificate_Warning and SHALL leave that principal's rendering unchanged.
6. THE Takserver_Enrollment SHALL resolve the per-principal certificate counts for a list of principals in ONE batched query, per the repository's no-N+1 rule.
7. THE Takserver_Enrollment SHALL present the Multiple_Certificate_Warning as information, not as an error, and SHALL NOT block enrollment because of it. Several live certificates is a normal state — `device-management` verified `clientUid` reuse across re-enrollments as the common case — and the warning exists so the state is visible, not so it can be prevented.

### Requirement 14: Team-Owned Devices Are Hierarchy Citizens

**User Story:** As a team admin, I want a team-owned device to behave like a member of my team, so that its channel access, visibility and hierarchy position follow the same rules I already understand.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL treat a Team_Owned_Device as a member of exactly one Team through the same `team_memberships` mechanism a human member uses, including the Direct_Membership rule of at most one row with `inherited_from_team_id IS NULL`.
2. THE Takserver_Enrollment SHALL grant a Team_Owned_Device the same channel access a human member of that Team receives, via `TeamMembershipService.addUserToTeam`, as `DeviceEnrollmentService.createDevice` already does.
3. THE Takserver_Enrollment SHALL carry a Team_Owned_Device's Device_Display_Name in the existing `users.device_label` column and SHALL map it to Authentik's `name` field, in place of the first name and last name a human carries. No new column is needed: `device_label` exists on both `users` and `user_cache` in the baseline schema.
4. THE Takserver_Enrollment SHALL store no email address for a Team_Owned_Device, per Requirement 5.
5. THE Takserver_Enrollment SHALL restrict creating a Team_Owned_Device, and generating its Enrollment_Token, to a Team_Admin of that device's Team — resolved through the Ancestor_Chain by `Team.isAdmin`, so an Organisation admin qualifies for a device on any Sub_Team beneath it — or a Global_Manager, and SHALL NOT permit a Team_Owned_Device to enroll itself. A device has no session and no human owner, so there is no self-service case for it.
6. THE Takserver_Enrollment SHALL retain the existing exclusion of every Team_Owned_Device from user-facing human-user counts and user lists (`production-hardening` Criterion 27.9), and SHALL NOT reintroduce a Team_Owned_Device into those counts as a side effect of making devices visible in the hierarchy.
7. THE Takserver_Enrollment SHALL present Team_Owned_Devices in a surface distinct from the human member list, so that Criterion 14.6's exclusion does not make a Team's devices invisible to the admin who owns them.
8. THE Takserver_Enrollment SHALL give a Team_Owned_Device a Managed_Identifier with Identifier_Type_Marker `D` as its username, per Requirement 1, replacing the shipped `device-<uuid>`.
9. THE Takserver_Enrollment SHALL NOT store a `callsign_level_selection` value on a Team_Owned_Device's Team as a consequence of this feature, and SHALL NOT alter the inheritance of `color` and `callsign_name_format` from the Organisation. A device's Callsign is generated by exactly the same rules as a human's.

### Requirement 15: Lambda Decommissioning Prerequisites

**User Story:** As an operator, I want a recorded list of everything the Enrollment_Lambda does that TAK Team Manager must do first, so that switching the Lambda off loses no capability.

This requirement exists so that nothing is dropped silently at decommissioning time. Each criterion is a precondition for switching the Lambda off.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL serve a self-service Enrollment_View to a signed-in Human_Principal for that user's own account, which is the Enrollment_Lambda's entire function (Requirement 3).
2. THE Takserver_Enrollment SHALL serve the Enrollment_View to a signed-in user who holds NO team membership at all. This is the one behavioural gap between the two systems: the Enrollment_Lambda serves any authenticated user, because it authorizes on session validity alone, whereas TAK Team Manager's authorization is team-scoped throughout. A user who has signed up but has not yet been placed in a Team must still be able to enroll a device, or decommissioning the Lambda removes a capability that user has today.
3. WHERE a Human_Principal holds no team membership, THE Enrollment_View SHALL render every element of Requirement 10 that does not depend on a Team, and SHALL display an explicit statement for any TAK_Attribute that is unset rather than an empty field. The Enrollment_Lambda's own `extractAttribute` default of `'None'` is the precedent.
4. THE Takserver_Enrollment SHALL mint the Enrollment_Token via the same Authentik `intent: 'app_password'` token creation the Enrollment_Lambda uses, through `authentikService.createAppPasswordToken`, so the credential a device receives is identical in kind.
5. THE Takserver_Enrollment SHALL provide the Token_Countdown, the Re_Enrollment_Date, the TAK_Attributes display, and Android_Only_Suppression (Requirement 10), which together are the Enrollment_Lambda's `views/content.ejs` feature set.
6. THE Takserver_Enrollment SHALL provide the Downloads_Page (Requirement 12), which carries the Enrollment_Lambda's `store_badges.ejs` content.
7. THE Takserver_Enrollment SHALL provide the correct iTAK_Registration_Payload (Requirement 4), so that an iTAK user who enrolls through TAK Team Manager gets the working payload the Enrollment_Lambda already produced.
8. THE Takserver_Enrollment SHALL NOT carry over the Enrollment_Lambda's two-request loading pattern (`views/loader.ejs`, then `?load=true`), which exists because a Lambda behind an Application Load Balancer must answer before its Authentik calls complete. A single-page application fetches its data asynchronously by construction, so the loader page has no purpose here.
9. THE Takserver_Enrollment SHALL NOT carry over the Enrollment_Lambda's branding switch (`BRANDING`, `getBrandingStrings`), because TAK Team Manager has its own site branding and a second mechanism would be a second place for it to be configured.
10. THE Takserver_Enrollment SHALL introduce no new environment variable for the enrollment path: the TAK Server host comes from the already-configured `TAK_SERVER_URL`, the Enrollment_Port is a constant (Criterion 4.4), and the Enrollment_Token_Lifetime is a constant (Criterion 3.10). WHERE a new environment variable nevertheless becomes necessary, THE Takserver_Enrollment SHALL document it in `.env.example` with a safe default.
11. THE Takserver_Enrollment SHALL close `BUGS.md` BUG-009 by providing the client user interface that Requirement 27's backend has never had.

### Requirement 16: Out of Scope — Pseudonymity Is Defeated for CloudTAK Users

**User Story:** As an Organisation adopting pseudonymous usernames, I want the one case where pseudonymity does not work to be written down, so that we do not rely on a protection we do not have.

This limitation is outside TAK Team Manager's control and is recorded rather than fixed. Verified by reading the TAK-NZ CloudTAK fork:

- `api/stateless/lib/authentik-provider.ts:620` — `commonName: email`, so the certificate Common_Name **is** the email address.
- `api/stateless/lib/authentik-provider.ts:624` — `clientUid: ${email} (Web)`.
- `api/common/connection-config.ts:157,170` — `this.id = email`, so the CoT uid is `ANDROID-CloudTAK-<email>`.

A member of a Pseudonymous_Organisation who uses WebTAK therefore has their full-name email address in the certificate Common_Name, in TAK Server's certificate inventory, and in the CoT uid, whatever their Authentik username is.

#### Acceptance Criteria

1. THE Takserver_Enrollment SHALL record the CloudTAK_Pseudonymity_Defeat as an explicit out-of-scope limitation, citing `api/stateless/lib/authentik-provider.ts:620`, `api/stateless/lib/authentik-provider.ts:624`, and `api/common/connection-config.ts:157,170`, so that a later reader finds the exact code that defeats the pseudonymity rather than a general caveat.
2. THE Takserver_Enrollment SHALL state that the fix for the CloudTAK_Pseudonymity_Defeat is a change in the CloudTAK fork — replacing the email with the Authentik username in those three constructions — and NOT a change in TAK Team Manager, and SHALL NOT attempt to work around it from TAK Team Manager.
3. THE Takserver_Enrollment SHALL NOT suppress, rewrite, or filter a CloudTAK certificate's Common_Name or `clientUid` in order to appear to satisfy the Pseudonymous_Username_Policy. The email is in TAK Server's certificate inventory and in the CoT uid regardless of what TAK Team Manager displays, so a display-layer change would create a false impression of pseudonymity, which is worse than the recorded limitation.
4. THE Takserver_Enrollment SHALL surface the CloudTAK_Pseudonymity_Defeat to an operator enabling the Pseudonymous_Username_Policy, per Criterion 8.4, so the limitation is known at the moment the decision is made rather than discovered afterwards.
5. THE Takserver_Enrollment SHALL record that `device-management`'s Connection_Alias derivation is UNAFFECTED by whether a CloudTAK account identifier is an email address or a pseudonym: the derivation strips the `ANDROID-CloudTAK-` prefix and appends the ` (Web)` and ` (ETL)` Certificate_Uid_Suffixes to whatever base remains, by exact string equality, without interpreting that base. A Pseudonymous_Username therefore neither breaks nor fixes the Last_Seen match for a CloudTAK Device.
6. THE Takserver_Enrollment SHALL treat a change in the CloudTAK fork's identifier construction as a change with a `device-management` consequence, because `device-management` Criterion 22.9 already records that the Connection_Alias is a heuristic keyed on CloudTAK's current string construction and stops matching WHERE upstream changes it.
