# Implementation Plan: TAK Server Enrollment

## Overview

This plan is built bottom-up, because almost everything in the feature depends on the identifier foundation. Sections 1-2 create the pure alphabet, the pure generator, the Claim_Row mint and the two migrations, none of which have a consumer yet. Sections 3-4 land the two policy preconditions — email nullability with its sync consequences, and a mandatory Organisation_Prefix. Section 5 is the Pseudonymous_Username choke point and reaches all four user-creation paths. Section 6 re-phases device creation onto the Claim_Row. Section 7 builds the enrollment core, section 8 the routes and the permission registry, sections 9-11 the client. Section 12 verifies the whole thing, including a live end-to-end check against the test Authentik.

**Three different kinds of work are mixed together here, and it is worth naming them.** Some tasks CORRECT a shipped implementation (`production-hardening` Requirement 27's `device-<uuid>` username, its synthetic `.invalid` email, its non-functional iTAK payload, its `NotATeamOwnedDeviceError` capability guard). Some ADD a second Enrollment_Principal through the same minting core. Some ADD policy features the pseudonymity story needs. A task that reads like a tidy-up is usually the first kind, and the design's Corrections section is the authority for what it supersedes.

**The blast radius on the existing suite, measured.** 62 assertions across 8 files reference things this spec changes — found by grepping `DEVICE_EMAIL_DOMAIN`, `devices.tak.nz.invalid`, `itakEnrollmentPayload` and `resolveCallsignSuffixForNewUser`:

| File | What it pins that changes |
|---|---|
| `server/services/DeviceEnrollmentService.test.js` | the `device-<uuid>` username, the synthetic email, the `{host, username, token}` payload, and the two-phase ordering the Claim_Row replaces |
| `server/routes/devices.test.js` | the route's response shape, including `itakEnrollmentPayload` |
| `server/services/UserProvisioningService.test.js` | `resolveCallsignSuffixForNewUser`, which is being **removed** |
| `server/routes/users.post.test.js` | the `POST /api/users` Phase-0 resolution |
| `server/routes/users.create-and-add.test.js` | `const username = email` and the Phase-0 resolution |
| `server/routes/users.callsignPreview.test.js` | the read-only preview's resolver call |
| `server/services/BulkImportService.test.js` | `row.username \|\| email.split('@')[0]` and the Phase-0 resolution |

Every one of those updates belongs to the task that changes the behaviour, named in that task's `Files:` line. None of it is deferred to a cleanup task: **a task that leaves the suite red is not done.** And the distinction the design draws applies throughout — **do not weaken an assertion to make it pass.** If an exact-value assertion has to be loosened to a `expect.any(String)` or a regex, that is evidence the behaviour changed in a way the spec did not intend, and the implementation is what needs revisiting.

**Properties.** Fourteen, one per file, `numRuns >= 100`, each tagged on its first line exactly `// Feature: takserver-enrollment, Property N: <name>`, with the names and runners the design's Testing Strategy table gives. Twelve run under Jest with `@fast-check/jest`; Properties 10 and 11 run under Vitest with `fast-check`; Property 12 is the one property whose subject spans both runners, so it is implemented as two files carrying the same tag. Both libraries are already present in their respective trees.

No dependency is added to either tree. `qrcode` is already a root dependency at `^1.5.4`, `fast-check` is already a `client/package.json` devDependency, and `@fast-check/jest` is already a root devDependency (Criterion 11.3). `.env.example` is unchanged: this feature adds no environment variable and reads only the already-configured `TAK_SERVER_URL` (Criterion 15.10).

Test-only sub-tasks are marked `*` and may be skipped for a faster MVP; core implementation sub-tasks are not. Where an existing test's assertion has to change because the behaviour changed, that update is NOT optional and is not marked `*`. The design uses a specific implementation language (JavaScript/Node for the server, React/JavaScript for the client), so no language selection is required.

## Tasks

- [x] 1. The Identifier_Alphabet, the pure generator, and the Claim_Row mint
  - Nothing in this section has a consumer yet, which is deliberate: it is the foundation everything else depends on, and it is the part a property test can reach without a database.
  - [x] 1.1 Extract the Identifier_Alphabet to a neutral third module and correct SignupCodeService's comment in place
    - Create `server/utils/identifierAlphabet.js` exporting `AMBIGUITY_FREE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'`, `AMBIGUITY_FREE_ALPHABET_LENGTH = 31` and `EXCLUDED_AMBIGUOUS_CHARACTERS = 'O0I1L'`, with NO imports at all
    - The module is named for the PROPERTY the alphabet has, not for either consumer, and that is the whole placement decision (design decision 1). Putting the constant in `managedIdentifier.js` is legal but files the sign-up code's alphabet under a concept sign-up codes have nothing to do with, so a developer changing sign-up codes would not find it. Putting it in `SignupCodeService.js` is not legal at all: that module requires `../config/database`, `pdfkit` and `qrcode`, and Criterion 1.5 requires the generator to load with no database and no framework in its require graph
    - Export `EXCLUDED_AMBIGUOUS_CHARACTERS` even though nothing in production reads it. Property 1's negative clause asserts against it, and a test that re-types the five exclusions is a test that agrees with itself about a typo
    - In `server/services/SignupCodeService.js`, replace the local `const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'` (line 7) with an import of `AMBIGUITY_FREE_ALPHABET` from the new module, keeping the local name `CHARSET` if that reads better at its three use sites (lines 32 and 66)
    - **Correct the wrong comment in place.** `generateRandomCode`'s doc block (line ~22) says "modulo over the charset length (30 chars)". The literal beside it is 31 characters. Correct the count and do NOT add a second comment beside the wrong one — the same in-place convention `device-management` tasks 25.2 and 28.5 established
    - **LEAVE THE BIASED DRAW ALONE.** Line 32 is `CHARSET[bytes[i] % CHARSET.length]`, and 256 = 8 × 31 + 8, so `A`-`H` are drawn 9/256 of the time and the other 23 characters 8/256 — a real modulo bias over-representing eight characters by about an eighth. Do NOT fix it here (design decision 2). Fixing it changes the distribution of every future sign-up code, which is a behaviour change in a different feature with its own requirements and its own tests, in service of a spec that does not ask for it; and a 31^8 space biased by an eighth is still not guessable, so it is not a security defect for that feature. Record the bias in a comment at the draw site, state that rejection sampling is a named follow-up, and state that the Managed_Identifier deliberately does NOT use this construction. What is NOT acceptable is extracting the alphabet and leaving a reader to assume the draw came with it
    - `server/services/SignupCodeService.test.js:21` has its OWN copy of the literal. Leave it: task 1.7's structural guard counts non-test modules only, and a test asserting against an independently written alphabet is the correct shape for that test
    - _Requirements: 1.2, 1.4_
    - Files: `server/utils/identifierAlphabet.js`, `server/services/SignupCodeService.js`
  - [x] 1.2 Create the pure Managed_Identifier generator
    - Create `server/utils/managedIdentifier.js` exporting `IDENTIFIER_BODY_LENGTH = 7`, `IDENTIFIER_SEPARATOR = '-'`, `IDENTIFIER_TYPE_MARKERS = Object.freeze({ DEVICE: 'D', USER: 'U' })`, `generateIdentifierBody(randomInt = crypto.randomInt)`, `generateManagedIdentifier(organisationPrefix, typeMarker, randomInt = crypto.randomInt)` and `isManagedIdentifier(value)`
    - Import `crypto` and `./identifierAlphabet` and NOTHING else — no framework, no database, so a property test can load the module bare (Criterion 1.5)
    - **The draw is `crypto.randomInt(31)`, called exactly seven times, its result used as a direct index into the alphabet.** No modulo, no `randomBytes`, no `Math.random` (Criterion 1.10). `crypto.randomInt` is the right primitive precisely because it already IS a rejection sampler: Node draws enough bytes for the range, rejects a draw landing in the incomplete final block, and redraws — which is the correction the `% 31` construction is missing, implemented once by the platform instead of once per caller. The alternative that looks equivalent and is not is `randomBytes(7)` followed by `% 31`, whose bias is invisible in any output a human will ever read
    - `randomInt` is INJECTED as a parameter with a default, not reached through the module's own `crypto` import. That is what makes Property 2 possible: a test can drive the generator over a chosen index sequence and assert the index-to-character mapping directly, and a modulo implementation cannot satisfy "seven calls, each with the single argument 31, results used as indices in order"
    - One generator serving both Identifier_Type_Markers, taking the marker as a parameter. Do NOT add a second generator for the other marker: the two forms differ by one character in a fixed position, and two implementations would be two places for the alphabet, the length and the separator to drift (Criterion 1.4)
    - **Total on the random source, deliberately NOT total on its configuration arguments.** A prefix that is absent, empty, or carries a character outside `[A-Za-z0-9]` is a caller defect, so throw a `TypeError` naming the offending value; same for a marker that is not one of `IDENTIFIER_TYPE_MARKERS`' values. Criterion 2.9 requires that to fail rather than be papered over with a placeholder
    - Validate the prefix with `isValidCallsignPrefix` from `server/utils/callsignValidation.js` — do NOT write a second regex (Criterion 2.5). That pattern's exclusion of `-` is load-bearing twice over: `-` is the Callsign segment separator AND the Managed_Identifier separator, so a prefix containing one would make the boundary between prefix and Identifier_Type_Marker ambiguous
    - **Do NOT add a runtime cross-type collision check.** The marker occupies the fixed index `prefix.length + 1`, so a `D` identifier and a `U` identifier for one prefix differ at that index for every possible pair of bodies. A check that can never fire is a check nobody maintains (Criterion 1.6). The claim is asserted once, as a clause of Property 1, where it costs nothing
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.10, 2.5, 2.9_
    - Files: `server/utils/managedIdentifier.js`
  - [x] 1.3 Write property test: Managed_Identifier generation is total, shape-exact, alphabet-exact, and type-partitioned
    - **Property 1: Managed_Identifier generation is total, shape-exact, alphabet-exact, and type-partitioned**
    - Tag exactly: `// Feature: takserver-enrollment, Property 1: Managed_Identifier generation is total, shape-exact, alphabet-exact, and type-partitioned`
    - `@fast-check/jest`, `numRuns >= 100`. Generators MUST include a one-character prefix, an all-digit prefix, an all-letter prefix and a 255-character prefix, crossed with both Identifier_Type_Markers
    - Assert the exact composition (prefix, then `-`, then the marker, then exactly seven further characters), that every body character is a member of the alphabet, that none is a member of `EXCLUDED_AMBIGUOUS_CHARACTERS`, and that for one prefix the `D` identifier never equals the `U` identifier
    - **This property carries the design's ONE named exception to independent re-derivation.** Alphabet membership is asserted against `AMBIGUITY_FREE_ALPHABET` — the subject's own table — because the alternative is a test that re-types 31 characters and therefore agrees with itself about a typo. The EXCLUSION clause is what carries the real assertion, and it is asserted against the separately declared `EXCLUDED_AMBIGUOUS_CHARACTERS`. Do not extend this exception to any other property
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.6, 1.11**
    - _Requirements: 1.1, 1.2, 1.3, 1.6, 1.11_
    - Files: `server/utils/managedIdentifier.property.test.js`
  - [x] 1.4 Write property test: the identifier body is drawn once per character from a uniform bound, never by modulo reduction
    - **Property 2: The identifier body is drawn once per character from a uniform bound, never by modulo reduction**
    - Tag exactly: `// Feature: takserver-enrollment, Property 2: The identifier body is drawn once per character from a uniform bound, never by modulo reduction`
    - `@fast-check/jest`, `numRuns >= 100`. Generate sequences of seven indices in the closed interval 0..30, inject a fake `randomInt` returning them in order, and assert the produced body equals the alphabet characters at those indices, in that order
    - Assert the fake was called exactly seven times, EACH TIME with the single argument `31` and no second argument. That clause is what rules out a modulo implementation: such an implementation never requests an index above 30 and its index-to-character mapping is not injective over the whole range
    - Cover indices `0` and `30` explicitly — the two ends of the range a `% 31` over a byte gets wrong in opposite directions
    - Do NOT attempt a chi-squared or frequency test of `crypto.randomInt`. That would measure Node rather than this code and would be flaky; the checkable thing is the draw discipline, which is what this property asserts (see the Notes on deliberate PBT omissions)
    - **Validates: Requirements 1.10**
    - _Requirements: 1.10_
    - Files: `server/utils/managedIdentifier.draw.property.test.js`
  - [x] 1.5 Create the ManagedIdentifierService and its Claim_Row mint
    - Create `server/services/ManagedIdentifierService.js` exporting `MAX_IDENTIFIER_ATTEMPTS = 5`, `USERNAME_UNIQUE_CONSTRAINT = 'users_username_key'`, the error classes `ManagedIdentifierExhaustionError` and `OrganisationPrefixMissingError` (each setting `this.name` to its own class name, matching how `DeviceEnrollmentService`'s named errors do it), `resolveOrganisationPrefix(organisationId)` and `mintUniqueIdentifier({ organisationPrefix, organisationId, typeMarker, claim })`
    - `claim(candidate)` is the CALLER's own single `INSERT ... RETURNING id`. The service owns the loop and the error discrimination; it does not own the statement. The loop: generate a candidate, `await claim(candidate)`, return `{ username, claim }` on success, continue on a qualifying rejection, propagate anything else, throw `ManagedIdentifierExhaustionError` after five
    - **The constraint is the authority (Criterion 1.7).** The retry trigger is a rejection from the caller's INSERT, never the result of a `SELECT`. There must be NO pre-insert existence probe anywhere on this path — a probe races, and the window between it and the insert is exactly one Authentik round trip wide, the longest window in the whole operation
    - **TRAP — match the constraint by EQUALITY, not `includes()`.** The catch condition is `err.code === '23505' && err.constraint === USERNAME_UNIQUE_CONSTRAINT`. `SignupCodeService.generateCode` uses `err.constraint.includes('code')`, which is safe on a table whose only unique constraint mentions the word, and unsafe here: `users` carries BOTH `users_username_key` and `users_email_key`. A substring test on `'username'` would also match a future `users_username_lower_key`. Worse, a broader test would retry identifier generation five times in response to a duplicate EMAIL and then report exhaustion, so the operator learns that identifier generation is broken when the real problem is that the address is taken. A `23505` on `users_email_key` must propagate on its first occurrence
    - **Exhaustion is terminal (Criterion 1.9).** Five consecutive collisions against 27,512,614,111 bodies per Organisation per marker is not bad luck, it is a fixed-seed or non-random source. Throw, log via the Structured_Logger with the Organisation id, the type marker, the attempt count AND the candidate identifiers tried, and substitute no other identifier form. The candidates ARE logged deliberately: a username is not secret, and the log is worthless without the evidence that distinguishes the same candidate five times (a fixed seed) from five different ones (a saturated space)
    - `resolveOrganisationPrefix` reads and validates the prefix BEFORE the first attempt and throws `OrganisationPrefixMissingError` naming the Organisation when it is null, empty or invalid. `claim` must then be invoked ZERO times: no placeholder prefix, no team name, no team id is substituted (Criterion 2.9)
    - Use `console.*` nowhere — it is an ESLint error in server code. `createLogger(...)` from `server/config/logger.js` only
    - _Requirements: 1.7, 1.8, 1.9, 2.9_
    - Files: `server/services/ManagedIdentifierService.js`
  - [x] 1.6 Write property test: the mint retries only on the username constraint, at most five times, and never substitutes an identifier
    - **Property 3: The mint retries only on the username constraint, at most five times, and never substitutes an identifier**
    - Tag exactly: `// Feature: takserver-enrollment, Property 3: The mint retries only on the username constraint, at most five times, and never substitutes an identifier`
    - `@fast-check/jest`, `numRuns >= 100`. Generate rejection sequences over the CROSS PRODUCT of PostgreSQL error codes (`23505`, `23514`, `23503`, `42P01`) and constraint names (`users_username_key`, `users_email_key`, `undefined`, arbitrary strings including ones CONTAINING `username` such as `users_username_lower_key`), crossed with valid and invalid Organisation prefixes
    - Assert: at most five claim invocations; a further attempt if and only if the rejection carried code `23505` AND constraint exactly `users_username_key`; any other rejection propagated unchanged on first occurrence with no further attempt; `ManagedIdentifierExhaustionError` when and only when five consecutive qualifying rejections occurred; an identifier returned only when a claim succeeded; and zero claim invocations with no identifier emitted when the prefix is missing or invalid
    - **Boundary concentration is required.** Concentrate the consecutive-failure count on exactly four and exactly five, over a range of zero through eight. A uniform failure count would almost never land on the bound the criterion pins, and the property would pass an off-by-one loop
    - **Anti-vacuity assertions are required.** Assert that at least one run reached the fifth attempt, and that at least one run propagated a non-qualifying error. Without those the property can pass while testing nothing
    - The expectation is re-derived from the generated rejection sequence in the test, never by calling back into the service
    - **Validates: Requirements 1.7, 1.8, 1.9, 2.9**
    - _Requirements: 1.7, 1.8, 1.9, 2.9_
    - Files: `server/services/__tests__/ManagedIdentifierService.property.test.js`
  - [x] 1.7 Write the structural guard for the single alphabet definition and the generator's bare require graph
    - Create `server/utils/__tests__/identifierAlphabetSingleDefinition.test.js`, named for what it guards, following `dateFormatConsumers.test.js` / `martiEndpointContract.test.js` / `operationSchemas.test.js`
    - Assert the alphabet literal `ABCDEFGHJKMNPQRSTUVWXYZ23456789` appears in exactly ONE non-test module under `server/` — `server/utils/identifierAlphabet.js` (Criterion 1.4). Scan non-test files only: `server/services/SignupCodeService.test.js` has its own independent copy and that is correct for a test
    - Assert `server/utils/managedIdentifier.js` loads with no database and no framework in its require graph, by resolving its requires transitively and asserting the set contains nothing from `server/config/` and no `express`/`pg`/`axios`/`pdfkit`/`qrcode` (Criterion 1.5)
    - Assert no second Organisation_Prefix regex exists beside `server/utils/callsignValidation.js` (Criterion 2.5)
    - _Requirements: 1.4, 1.5, 2.5_
    - Files: `server/utils/__tests__/identifierAlphabetSingleDefinition.test.js`
  - [x] 1.8 Checkpoint - Ensure all tests pass
    - Run `npm test` and confirm the server suite passes; nothing in this section has a consumer, so no existing assertion should change
    - Run `npm run lint` and confirm the problem count does NOT rise above the baseline of 107 problems (95 errors, 12 warnings)
    - Ensure all tests pass, ask the user if questions arise.

- [x] 2. The two migrations
  - Both are additive and neither backfills anything: the live database holds zero Organisations and zero Team_Owned_Devices (Criteria 2.8, 5.11). There is no third migration — the mandatory Organisation_Prefix is enforced in the application, deliberately (design decision 12), so do not go looking for one and do not add one.
  - **TRAP — no backtick may appear inside any `pgm.sql(\`…\`)` template literal.** It breaks the migration loader with a ParseError. Column comments in both migrations use plain quotes and no backticks, and they must also avoid an apostrophe inside a single-quoted SQL string (write "Authentiks", not "Authentik's", as the design's own comment text does).
  - [x] 2.1 Add the email-nullability migration with the Device_Email_Null_Invariant on BOTH tables
    - Add a `node-pg-migrate` incremental `.cjs` migration in `database/migrations/`, following the `pgm.sql(...)` conventions of `1787518155760_tak-devices.cjs` and `1787555044446_tak-devices-connected.cjs`, with a `down()` that reverses both changes
    - `up()`: `ALTER TABLE public.users ALTER COLUMN email DROP NOT NULL;` and `ALTER TABLE public.user_cache ALTER COLUMN email DROP NOT NULL;`
    - Then add both CHECK constraints: `users_email_required_unless_device` on `public.users` and `user_cache_email_required_unless_device` on `public.user_cache`, each `CHECK (email IS NOT NULL OR is_team_device = true)`
    - **BOTH tables, not just `users`.** `user_cache.email` is `character varying(255) NOT NULL` today and the Authentik_Sync writes it for every user, so changing only `users.email` leaves the sync failing on exactly the rows this feature creates (Criterion 5.3). `user_cache.is_team_device` was checked rather than assumed — it is present in the baseline as `boolean DEFAULT false NOT NULL` — so the constraint is expressible identically on both tables and no asymmetry has to be designed around
    - The nullability and the invariant land TOGETHER, deliberately. Nullability alone would let a defect create a HUMAN with no email, and a human with no email has no account-recovery path and no directory-scope membership (Criterion 5.4)
    - `users_email_key` needs NO change: PostgreSQL treats multiple NULLs as non-conflicting under a unique index, so any number of emailless devices coexist (Criterion 5.7). `user_cache.email` has no unique index at all, so nothing else follows there
    - Add `COMMENT ON COLUMN public.users.email` stating that the column is nullable ONLY for a Team_Owned_Device, naming `users_email_required_unless_device` as what licenses the null, and naming `normaliseAuthentikEmail` as the single point where Authentiks empty-string email becomes NULL
    - **No `UPDATE` and no `SET NOT NULL` anywhere in the migration**, and no `invalid` string anywhere in it: there is nothing to backfill and no `devices.tak.nz.invalid` address to migrate, because none exists (Criterion 5.11)
    - _Requirements: 5.3, 5.4, 5.7, 5.11_
    - Files: `database/migrations/<timestamp>_email-nullable-device-invariant.cjs`
  - [x] 2.2 Add the Pseudonymous_Username_Policy column
    - Add a second `node-pg-migrate` incremental `.cjs` migration doing `ALTER TABLE public.teams ADD COLUMN pseudonymous_usernames boolean;`, with a `down()` that drops the column
    - **Nullable with NO default — not `NOT NULL DEFAULT false`.** The tri-state is load-bearing here in a way it was not for `device-management`'s `connected` column, and the inconsistency is deliberate (design decision 11). `NULL` means "this row is a Sub_Team and the question does not apply to it", which is a different fact from `false`, "this is an Organisation and the answer is no". Collapsing them would make a Sub_Team indistinguishable from an Organisation that declined the policy, and the resolver reads the policy from `getAncestorChain(teamId)[0]`, so it must be able to tell that a value found on a non-root row is meaningless rather than authoritative. `callsign_level_selection` is the existing precedent Criterion 6.2 points at, and it has exactly this shape
    - The application supplies `false` at Organisation creation, so the policy is off unless chosen (Criterion 6.1). That is task 5.4's job, not this migration's
    - Add `COMMENT ON COLUMN public.teams.pseudonymous_usernames` stating: Organisation-level only, exactly as `callsign_level_selection` is; NULL on a Sub_Team; false or true on an Organisation; fixed at Organisation creation, because switching it would require every members username to change and would invalidate every certificate Common Name in the Organisation. Plain quotes, no backticks, no apostrophes inside the SQL string
    - _Requirements: 6.1, 6.2_
    - Files: `database/migrations/<timestamp>_teams-pseudonymous-usernames.cjs`
  - [x] 2.3 Write migration tests
    - Assert both `DROP NOT NULL` statements and both CHECK constraints are present after applying, and that the constraint expressions are `email IS NOT NULL OR is_team_device = true` on both tables (5.3, 5.4)
    - Assert the migration text contains no `UPDATE`, no `SET NOT NULL` and no `invalid` (5.11, 2.8)
    - Assert `teams.pseudonymous_usernames` exists as a nullable boolean with NO column default (6.1) — a test that only checks the type would pass a `NOT NULL DEFAULT false` column and silently lose the tri-state
    - Assert no backtick appears inside any `pgm.sql` template literal in either new migration file, and that both `down()` functions reverse everything `up()` did
    - _Requirements: 2.8, 5.3, 5.4, 5.11, 6.1_
    - Files: `database/migrations/__tests__/takserver-enrollment-schema.test.js`
  - [x] 2.4 Checkpoint - apply and roll back both migrations
    - Apply: `docker compose exec -T app npm run migrate:up`. The migration test database is on port 15433
    - Roll back: `docker compose exec -T app npm run migrate:down` for each migration, and confirm the columns and constraints are restored to their baseline state, then apply again
    - A migration that applies and cannot roll back is not done. Confirm both directions before moving on
    - Run `npm test` and confirm the server suite passes; confirm `npm run lint` has not risen above 107 problems
    - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Email nullability's consumers: the normaliser and the three sync changes
  - **This section reaches outside the feature's own surface and should be flagged in review.** `authentikSync.js` changes on three lines and one comment, and the first of those changes is not cosmetic: left alone, the `if (user.email)` guard on the `users` upsert means a Team_Owned_Device — which by Criterion 5.1 has no Authentik email at all — **never syncs into TAK Team Manager at all**.
  - [x] 3.1 Create the Empty_String_Email normaliser
    - Create `server/utils/authentikEmail.js` exporting `normaliseAuthentikEmail(value) -> string | null`
    - Total, pure, never throws, never returns `''`. Returns `null` for `null`, `undefined`, a non-string, `''` and any whitespace-only string; otherwise the trimmed string
    - Trimming to null is a deliberate SUPERSET of Criterion 5.5's literal requirement. Authentik was verified to store an absent email as `""`, and a whitespace-only value carries exactly as much information, so admitting it would be admitting a value no predicate treats as absent
    - Place it in `server/utils/` with no framework import, beside `callsignValidation.js` and `connectionAlias.js`, so Property 9 can call it directly
    - _Requirements: 5.5_
    - Files: `server/utils/authentikEmail.js`
  - [x] 3.2 Write property test: Authentik email normalisation is total and never yields an empty string
    - **Property 9: Authentik email normalisation is total and never yields an empty string**
    - Tag exactly: `// Feature: takserver-enrollment, Property 9: Authentik email normalisation is total and never yields an empty string`
    - `@fast-check/jest`, `numRuns >= 100`. Draw from the shared TOTALITY generator: `''`, whitespace-only strings of arbitrary length and composition (spaces, tabs, newlines, non-breaking space, other Unicode whitespace), `null`, `undefined`, `NaN`, `Infinity`, `-Infinity`, `0`, `-0`, numbers, booleans, `Symbol()`, `BigInt`, arrays, `Object.create(null)`, objects whose `valueOf` and `toString` throw, and arbitrary non-empty strings
    - Assert: the return is either `null` or a non-empty string with no leading or trailing whitespace; it is NEVER `''`; it never throws; and it is a pure function of its argument alone (same argument, same result on repeated calls, no global read)
    - **Validates: Requirements 5.5**
    - _Requirements: 5.5_
    - Files: `server/utils/authentikEmail.property.test.js`
  - [x] 3.3 Make the three authentikSync changes and correct the false premise in place
    - **Change 1 — normalise once, bind twice.** In `syncSingleUser`, compute `const email = normaliseAuthentikEmail(user.email)` ONCE and bind that single value to `email` in BOTH the `users` upsert and the `user_cache` upsert. One site rather than two, because two sites is how `users.email` ends up `NULL` while `user_cache.email` is `''` for the same principal, and every query that treats absence as `IS NULL` would then disagree about which table to believe (Criterion 5.5)
    - **Change 2 — remove the `if (user.email)` guard on the `users` upsert (line ~211).** Its premise is false once migration 2.1 lands. Add `RETURNING is_team_device` to that upsert. Catch a constraint violation by EXACT code and constraint name — `err.code === '23514' && err.constraint === 'users_email_required_unless_device'` — log it at `warn` with its OWN distinguishable message and the Authentik user id, and skip that principal's `users` AND `user_cache` writes. Rethrow anything else into the existing per-user catch
    - The narrow catch matters: `syncSingleUser` already wraps its whole body in a blanket catch that logs every failure as the single message `'Failed to sync user'`, and a condition this design intends to be NORMAL — an Authentik service-account principal with no email and no local row — must not share a log line with conditions that are not. Let the CHECK constraint decide "may this row exist" rather than adding a second predicate that has to agree with it
    - **Change 3 — the push guard becomes `if (localUserId)` (line ~259).** It is `if (user.email)` today, guarding the push of local-authoritative attributes back to Authentik, and its own comment says the skip exists for "service accounts that don't have a local `users` row". With emails nullable, "has an email" and "has a local row" are different questions, and the push needs the second one: there is nothing local to push for a principal with no local row, and a Team_Owned_Device with a local row and no email has a `tak_role` worth pushing like any other
    - **Change 4 — `is_team_device` joins the `user_cache` INSERT column list and NOT its `ON CONFLICT DO UPDATE SET` list.** Its current column list is `(authentik_id, username, email, first_name, last_name, is_active, tak_role, tak_color, tak_callsign, groups, is_admin)`, so the column defaults to `false` and an emailless device would violate the cache's new CHECK. Source the value from Change 2's `RETURNING is_team_device` — the local `users` row is the authority for it, since Authentik carries no such field. Deliberately absent from the update list, so the cache adopts the flag on first insert and never overwrites it afterwards, matching how that upsert already treats `first_name`/`tak_role` as bootstrap-then-local
    - **Correct the false comment in place (lines 205-206).** It states the guard exists because "`users.email` is a UNIQUE NOT NULL column, and service-account users with no email would violate that constraint." This feature falsifies the NOT NULL half. Replace the text with the true statement: the column is now nullable, the service-account case the guard was reaching for is real, and the CHECK constraint now decides it. Correct it IN PLACE — do not leave the false sentence standing with a second comment beside it (the `device-management` 25.2 / 28.5 convention)
    - **LEAVE the `ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2` overwrite exactly as it is** (Criterion 7.5). It copies the Authentik username into the local column, and Authentik is where the username is fixed, so it is not a username-change path in the sense Criterion 7.1 means. Inverting that direction to make the local column authoritative would invert the sync for no gain
    - _Requirements: 5.2, 5.5, 5.6, 7.5_
    - Files: `server/services/authentikSync.js`
  - [x] 3.4 Write unit tests for the three sync changes
    - Assert an Authentik user whose `email` is `''` results in `null` bound to BOTH upserts, and that the same single value reached both — not `''` in one and `null` in the other (5.2, 5.5)
    - Assert a Team_Owned_Device with no Authentik email DOES reach the `users` upsert now, which is the whole point of removing the guard, and that `is_team_device` from `RETURNING` flows into the `user_cache` INSERT (5.6)
    - Assert `is_team_device` appears in the `user_cache` INSERT column list and NOT in its `ON CONFLICT DO UPDATE SET` list — a test that only checks the insert would pass an implementation that overwrites the flag on every sync
    - Assert the emailless-with-no-local-row case logs its OWN `warn` message (not `'Failed to sync user'`), carries the Authentik user id, and skips BOTH writes; and that a different error code or a different constraint name rethrows into the blanket catch instead
    - Assert the push runs for a principal with a local row and no email, and is skipped for one with no local row — the condition change, tested by the two cases that distinguish `if (user.email)` from `if (localUserId)`
    - Assert the `username` overwrite in the `ON CONFLICT` clause is unchanged (7.5)
    - _Requirements: 5.2, 5.5, 5.6, 7.5_
    - Files: `server/services/authentikSync.test.js` (extend)
  - [x] 3.5 Checkpoint - Ensure all tests pass
    - Run `npm test`; run `npm run lint` and confirm the count has not risen above 107
    - Ensure all tests pass, ask the user if questions arise.

- [x] 4. An Organisation_Prefix is mandatory
  - There is no migration in this section. Enforcement is in the application's create and edit paths, deliberately (Criterion 2.8, design decision 12): a `NOT NULL` column constraint would fail the migration on any database holding a pre-existing unprefixed Organisation and the deployment would not start, where application-layer enforcement makes such an Organisation block its own next edit instead — a visible, fixable state.
  - [x] 4.1 Require a non-empty Organisation_Prefix on the server, in create and edit
    - In `server/routes/teams.js`, require a non-empty `callsign_prefix` WHEN `parent_team_id IS NULL` on create, and reject an edit that would clear it on an existing Organisation. Reject with a validation error NAMING the missing field (Criteria 2.1, 2.2, 2.4)
    - Leave a Sub_Team's `callsign_prefix` optional exactly as it is today (Criterion 2.3). A Sub_Team's prefix participates in Callsign generation but never in a Managed_Identifier — a Managed_Identifier is always Organisation-scoped
    - Validate with the existing `isValidCallsignPrefix` from `server/utils/callsignValidation.js`; introduce no second pattern (Criterion 2.5)
    - Treat a whitespace-only prefix as empty. `[A-Za-z0-9]*` matches the empty string, so a validator that only runs the pattern accepts `''` and `'   '` — the emptiness check is a separate assertion, not a consequence of the pattern
    - Rely on the existing `idx_teams_callsign_prefix` UNIQUE partial index for uniqueness and add nothing (Criterion 2.6). That index is what makes deriving identifiers from the prefix safe: two Organisations cannot share one, so a Managed_Identifier's prefix segment names exactly one Organisation
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_
    - Files: `server/routes/teams.js`
  - [x] 4.2 Make the prefix a required field in the Organisation form
    - In `client/src/components/TeamFormDialog.jsx`, mark the prefix field required WHEN the dialog is creating or editing an Organisation (no parent team), with the requirement stated as text rather than discovered on submit
    - Leave the field optional for a Sub_Team, and leave the existing validation message wiring alone — the server remains the authority (Criterion 2.4), and this is the interface telling the truth about it rather than a second enforcement point
    - _Requirements: 2.1, 2.2, 2.3_
    - Files: `client/src/components/TeamFormDialog.jsx`
  - [x] 4.3 Write edge-case tests for the prefix requirement
    - Assert Organisation creation is rejected with an ABSENT prefix, an EMPTY prefix and a WHITESPACE-ONLY prefix, and that each error names the field (2.1)
    - Assert an edit that clears an existing Organisation's prefix is rejected, and that an edit leaving it unchanged succeeds (2.2)
    - Assert a Sub_Team can still be created and edited with no prefix at all (2.3)
    - Assert a prefix containing `-` is rejected by the existing validator, and state in the test's own comment why that exclusion is load-bearing: `-` is both the Callsign segment separator and the Managed_Identifier separator (2.5)
    - Assert the client dialog marks the field required for an Organisation and not for a Sub_Team
    - _Requirements: 2.1, 2.2, 2.3, 2.5_
    - Files: `server/routes/teams.test.js` (extend), `client/src/components/TeamFormDialog.test.jsx` (extend)
  - [x] 4.4 Checkpoint - Ensure all tests pass
    - Run `npm test`; run `cd client && npx vitest --run`; run `npm run lint` and confirm the count has not risen above 107
    - Ensure all tests pass, ask the user if questions arise.

- [x] 5. The Pseudonymous_Username choke point, and all four creation paths
  - **Criterion 9.3's premise is FALSE as written**, and this section is sequenced around that. The criterion says `resolveCallsignSuffixForNewUser` is "the single place the default is computed". `CallsignService.computeDefaultCallsignSuffix` has THREE callers, verified: `UserProvisioningService.js:283`, `RequestApprovalService.js:533`, and `server/routes/requests.js:111` (a read-only `effective_callsign_suffix` preview). Consolidate the approval path FIRST (5.2), then suppress; and allow-list the read-only preview explicitly rather than exempting it silently. Without that ordering, a member self-signing-up into a Pseudonymous_Organisation receives a name-derived callsign — broadcast to every other TAK user — on the commonest path, and the requirement would read as satisfied.
  - A path that misses the policy is not a partial feature, it is a permanent defect: Requirement 7 makes the username unchangeable, so a user created through a missed path has their name in the certificate forever.
  - [x] 5.1 Replace resolveCallsignSuffixForNewUser with resolveNewUserIdentity
    - In `server/services/UserProvisioningService.js`, add `static async resolveNewUserIdentity(client, { firstName, lastName, email, teamId, requestedUsername, requestedCallsignSuffix })` returning `{ username, callsignSuffix, pseudonymous, organisationId, organisationPrefix }`
    - **REMOVE `resolveCallsignSuffixForNewUser`** — do not keep it as a delegate. Two doors into one room is how the approval path acquired its own copy of the default computation in the first place (design decision 10)
    - **ONE function, not two.** The username decision and the Callsign-default decision are the same decision read from the same row: both are properties of `Team.getAncestorChain(teamId)[0]`, both are keyed on the same policy flag, and both must be settled before the Authentik call. Two resolvers would mean two ancestor-chain reads that can disagree about which Organisation is in force, and — the reason that decides it — two things a new creation path can remember one of and forget the other
    - Resolution order: (1) resolve the Organisation as `getAncestorChain(teamId)[0]`. The chain is ROOT-FIRST, so index 0 is the Organisation and the tail is the deepest Team — never a positional read from the tail (Criterion 6.7). This is the single read of `pseudonymous_usernames`, `callsign_name_format` and `callsign_prefix`
    - (2) **Policy enabled:** `username` is a freshly minted Pseudonymous_Username via `ManagedIdentifierService.mintUniqueIdentifier` with `typeMarker: 'U'` and the Organisation's prefix, and `requestedUsername` is IGNORED (design decision 8 — ignored, not rejected, matching how `Team.create` already silently overrides a supplied `color` on a Sub_Team). Callsign_Default_Suppression applies: `CallsignService.computeDefaultCallsignSuffix` is not called AT ALL, and a blank `requestedCallsignSuffix` throws the existing `CallsignSuffixRequiredError` (Criteria 9.1, 9.2)
    - (3) **Policy disabled:** `username` is `requestedUsername` verbatim, so each path keeps its current derivation exactly — the caller-supplied body value, `email`, or `row.username || email.split('@')[0]` (Criterion 6.8) — and the Callsign resolution runs exactly as today, including the `user_defined` branch and the default computation
    - (4) Either way the uniqueness check on the effective Callsign_Suffix runs unchanged via `checkCallsignSuffixUniqueness` (Criterion 9.4), and the supplied email is returned UNTOUCHED. A Pseudonymous_Organisation's members still carry a real, deliverable address (Criteria 6.5, 8.1) — only a Team_Owned_Device has none, and the Device_Email_Null_Invariant rejects an emailless human row outright
    - `CallsignSuffixRequiredError` keeps its identity and its message, so the four routes' existing 400 mappings are unchanged
    - **Update `server/services/UserProvisioningService.test.js` in the SAME task.** It pins `resolveCallsignSuffixForNewUser` by name across roughly nine assertions, and that symbol is gone. Rewrite those against `resolveNewUserIdentity`, preserving what each assertion was actually checking. Do NOT weaken an exact-value assertion to make it pass: if an exact callsign or username value has to become a regex, the behaviour changed in a way the spec did not intend
    - _Requirements: 6.3, 6.5, 6.7, 6.8, 9.1, 9.2, 9.3, 9.4, 8.1_
    - Files: `server/services/UserProvisioningService.js`, `server/services/UserProvisioningService.test.js`
  - [x] 5.2 Consolidate the approval path onto the shared resolver
    - In `server/services/RequestApprovalService.js`, turn `resolveAndCheckCallsignSuffixForApproval` (line ~520) into a THIN ADAPTER over `UserProvisioningService.resolveNewUserIdentity`: it adapts the request row into the resolver's parameters and returns `{ username, callsignSuffix }`. Its own `computeDefaultCallsignSuffix` call (line ~533) and its own ancestor-chain read are REMOVED
    - In the `new_account` branch of `processApprovedRequest` (line ~737), take `username` from the adapter instead of `const username = email`
    - **This consolidation lands BEFORE the suppression is relied on anywhere.** It is the path a self-signing-up member arrives through, so leaving its private copy in place would leave Requirement 9 defeated on the commonest path while every other path looked correct
    - Update `server/services/RequestApprovalService.test.js` in the same task for the assertions that pinned the private computation or `const username = email`
    - _Requirements: 6.6, 9.1, 9.2, 9.3_
    - Files: `server/services/RequestApprovalService.js`, `server/services/RequestApprovalService.test.js`
  - [x] 5.3 Route the remaining three creation paths through the resolver
    - `POST /api/users` (`server/routes/users.js:306`): replace the Phase-0 `resolveCallsignSuffixForNewUser` call (~line 332) with `resolveNewUserIdentity`, passing `requestedUsername: req.body.username`, and hand the RESOLVED username to the Authentik create call
    - `POST /api/users/create-and-add` (`server/routes/users.js:759`): same, passing `requestedUsername: email` — the existing `const username = email` derivation (line ~771) becomes the value passed IN rather than the value used
    - `BulkImportService.importUserRow` (line ~839): same, passing `requestedUsername: row.username || email.split('@')[0]`, once per imported row
    - **Phase 0 is the choke point, not `createAndAddUser`.** Every path already resolves policy-derived identity fields BEFORE the Authentik user is created, and each site documents why in the same words: a `CallsignSuffixRequiredError` is a request-validation failure, so returning early avoids orphaning an Authentik account for it. By the time `createAndAddUser` runs, the Authentik user exists with whatever username it was handed, so a check there would be too late
    - **Leave the read-only preview at `server/routes/requests.js:111` calling `computeDefaultCallsignSuffix` directly.** It renders `effective_callsign_suffix` for an admin's review screen, writes nothing, and must show what the default WOULD be. Suppressing it would blank a field rather than protect anything. It is named in task 5.8's allow-list so the exemption is a decision on the record rather than a gap
    - **Update the four pinned test files in the SAME task**, since each asserts the derivation this task changes: `users.post.test.js`, `users.create-and-add.test.js`, `users.callsignPreview.test.js`, `BulkImportService.test.js`. Again: do not weaken an exact-value assertion. The preview test in particular should still assert an exact name-derived value, because the preview's behaviour is deliberately unchanged
    - _Requirements: 6.3, 6.6, 6.8_
    - Files: `server/routes/users.js`, `server/services/BulkImportService.js`, `server/routes/users.post.test.js`, `server/routes/users.create-and-add.test.js`, `server/routes/users.callsignPreview.test.js`, `server/services/BulkImportService.test.js`
  - [x] 5.4 Accept the policy at Organisation creation only, and reject a change with the concrete consequence
    - In `server/routes/teams.js` and `server/models/Team.js`, accept `pseudonymous_usernames` on `POST /api/teams` only WHEN `parent_team_id IS NULL`, defaulting to `false` for an Organisation and storing `null` for a Sub_Team. A value supplied for a Sub_Team is a TYPED REJECTION, exactly as `callsign_level_selection` already behaves (Criterion 6.2)
    - On `PUT /api/teams/:teamId`, accept the field ONLY when the submitted value equals the stored one (a no-op) and otherwise reject (Criterion 7.2). The rejection message states the concrete consequence, not a policy (Criterion 7.3):
      > Pseudonymous usernames cannot be enabled or disabled on an existing Organisation. Doing so would require every existing member's username to change, and each change invalidates that member's certificate Common Name, every certificate issued under it, and every device record referencing it — forcing every device in this Organisation to re-enroll. Change a member's Callsign Suffix, first name or last name instead; none of those appear in a certificate.
    - Put the SAME sentence at the enforcement site as a code comment. A rejection message and a code comment that disagree are two chances to get the reason wrong
    - Provide no route, no interface and no administrative action that changes an existing user's USERNAME, and reject an attempt with an error stating that a username is fixed at creation (Criterion 7.1). There is no user-edit route in `server/routes/users.js` today — the verbs are `GET /`, `GET /me`, `POST /`, `GET /search`, `GET /available`, `POST /callsign-suffix-preview`, `POST /create-and-add`, `POST /add-to-team`, `DELETE /remove-from-team/:userId`, `POST /:userId/transfer`, `POST /:userId/resend-welcome` — so what this criterion needs is a GUARD that keeps it absent, which is task 5.8's third assertion, plus the rejection above
    - _Requirements: 6.1, 6.2, 7.1, 7.2, 7.3, 7.4_
    - Files: `server/routes/teams.js`, `server/models/Team.js`
  - [x] 5.5 Surface the policy and its exact scope in the interface
    - In `client/src/components/TeamFormDialog.jsx`, add the Pseudonymous_Username_Policy control, shown only for an Organisation, and DISABLED when editing an existing Organisation with a statement of why (a policy change is a fleet-wide re-enrollment event, not a setting change)
    - The control's copy MUST state the Pseudonymity_Scope explicitly: the pseudonymity is against TAK Server and other TAK users, and NOT against TAK Team Manager operators, who can always re-identify a member from the record TAK Team Manager holds (Criterion 8.2). It MUST NOT describe the policy as anonymity and MUST NOT claim TAK Team Manager holds no personally identifying information (Criterion 8.3)
    - The same statement MUST name the CloudTAK limitation: a member who connects via CloudTAK/WebTAK is not pseudonymised at all, because that path builds the certificate Common Name and the CoT uid from the email address rather than from the Authentik username (Criteria 8.4, 16.4). The operator needs it at the moment the decision is made, not afterwards
    - In `client/src/pages/TeamDetail.jsx`, for a create-user form whose target Organisation has the policy enabled: mark the Callsign Suffix REQUIRED with an explanation rendered as text rather than a validation error discovered on submit (Criterion 9.7), and HIDE the username field with a short statement that the username is generated — so the value the server ignores is never one a human typed (design decision 8)
    - Carry every state a user must perceive in TEXT, never colour alone
    - _Requirements: 8.2, 8.3, 8.4, 9.7, 16.4_
    - Files: `client/src/components/TeamFormDialog.jsx`, `client/src/pages/TeamDetail.jsx`
  - [x] 5.6 Write property test: the policy decides the username and preserves the email, at the Organisation root
    - **Property 7: The Pseudonymous_Username_Policy decides the username and preserves the email, at the Organisation root**
    - Tag exactly: `// Feature: takserver-enrollment, Property 7: The Pseudonymous_Username_Policy decides the username and preserves the email, at the Organisation root`
    - `@fast-check/jest`, `numRuns >= 100`. Generate arbitrary first name, last name, email — INCLUDING an email whose local part is itself Managed-Identifier-shaped, an email containing no `@`, and an email whose local part equals the caller-supplied username — and arbitrary `requestedUsername`, crossed with Ancestor_Chains of depth 0 through `MAX_TEAM_DEPTH` (5) whose policy values at the root and at every other depth DELIBERATELY DISAGREE
    - Assert the policy is resolved from the chain's ROOT element and from no other element; WHERE the root's policy is enabled the resolved username matches the `U`-marker Pseudonymous_Username shape with the root's prefix, contains no `@`, and shares no substring of three or more characters with the email's local part or either name; WHERE disabled the resolved username equals `requestedUsername` BYTE FOR BYTE; and under both states the resolved email equals the supplied email unchanged
    - **Boundary concentration:** concentrate chains on depth 0 (where root and leaf coincide, so a positional tail read PASSES and proves nothing) and on depth 2 or more with disagreeing values (where it does not). A generator that never produced a disagreeing chain would pass a tail read
    - **Anti-vacuity:** assert that at least one generated chain had a root value disagreeing with its leaf
    - **Validates: Requirements 6.3, 6.5, 6.7, 6.8, 8.1**
    - _Requirements: 6.3, 6.5, 6.7, 6.8, 8.1_
    - Files: `server/services/__tests__/UserProvisioningService.pseudonymousUsername.property.test.js`
  - [x] 5.7 Write property test: Callsign_Default_Suppression computes no default and demands an explicit value
    - **Property 8: Callsign_Default_Suppression computes no default and demands an explicit value**
    - Tag exactly: `// Feature: takserver-enrollment, Property 8: Callsign_Default_Suppression computes no default and demands an explicit value`
    - `@fast-check/jest`, `numRuns >= 100`. Draw the requested Callsign_Suffix from a generator CONCENTRATED on blank forms — `undefined`, `null`, `''`, single and repeated spaces, tabs, newlines, other Unicode whitespace — alongside arbitrary non-blank strings
    - WHERE the policy is enabled: assert `CallsignService.computeDefaultCallsignSuffix` is NOT INVOKED for any input (spy on it — an assertion on the returned value alone would pass an implementation that computes the default and then discards it, which would still put the name through the function and would still be wrong the moment someone reads the value back); assert `CallsignSuffixRequiredError` for every blank requested value; assert the trimmed requested value is returned, uniqueness-checked as today, for every non-blank one
    - WHERE the policy is disabled: assert the resolved suffix equals what today's resolution returns for the same input
    - **Validates: Requirements 9.1, 9.2, 9.4**
    - _Requirements: 9.1, 9.2, 9.4_
    - Files: `server/services/__tests__/UserProvisioningService.callsignSuppression.property.test.js`
  - [x] 5.8 Write the structural guard for the choke point
    - Create `server/services/__tests__/newUserIdentityChokePoint.test.js`, named for what it guards
    - Assertion 1 — statically scan non-test `server/routes/**` and `server/services/**` for every site that creates an Authentik user (`authentikService.createUser(`, and any `fetch`/`POST` whose URL contains `/api/v3/core/users/` with `method: 'POST'`) and assert the SET of containing modules EQUALS the four-entry allow-list: `routes/users.js` (both creation routes, via `resolveNewUserIdentity`), `services/RequestApprovalService.js` (the `new_account` path, via its adapter), `services/BulkImportService.js` (one row per import, via the resolver), `services/DeviceEnrollmentService.js` (mints a `D` identifier through `mintUniqueIdentifier`; not a human-creation path and deliberately not using the human resolver) (Criterion 6.9)
    - Assertion 2 — assert the SET of `computeDefaultCallsignSuffix` callers equals the TWO-entry allow-list: `UserProvisioningService.js` (the resolver) and `routes/requests.js` (the read-only preview). Re-introducing a third computation site fails the suite by design (Criterion 9.3)
    - Assertion 3 — assert the SET of non-test modules containing a statement that writes `users.username` equals the four-entry allow-list `{ authentikSync.js, UserProvisioningService.js, routes/users.js, DeviceEnrollmentService.js }` (Criteria 7.1, 7.5). `authentikSync.js` is in the list DELIBERATELY: its `ON CONFLICT … DO UPDATE SET username = $2` copies the Authentik username into the local column, and Authentik is where the username is fixed. `routes/users.js:1034` is in the list for the same reason — the add-to-team propagation upsert's values come from Authentik
    - **Set EQUALITY, not a subset check.** A new creation path fails the suite by design, and so does the REMOVAL of one, which is the point. State that in the test's own comment, because the instinct on hitting the failure will be to add the new module to the list rather than to route it through the resolver
    - _Requirements: 6.9, 7.1, 7.5, 9.3_
    - Files: `server/services/__tests__/newUserIdentityChokePoint.test.js`
  - [x] 5.9 Write edge-case and client tests for the policy's storage, immutability and copy
    - Assert the four combinations of `parent_team_id` present/absent × policy value supplied/absent: a typed rejection on a Sub_Team, `null` stored on a Sub_Team, `false` stored by default on an Organisation, `true` stored when chosen (6.1, 6.2)
    - Assert a policy CHANGE on an existing Organisation is rejected with a message naming re-enrollment and the certificate Common Name, and that submitting the SAME value is accepted as a no-op (7.2, 7.3)
    - Assert an attempt to change an existing user's username is rejected with a message stating a username is fixed at creation (7.1)
    - Client: assert the policy control's copy contains the Pseudonymity_Scope, names WebTAK/CloudTAK, and contains NEITHER the substring "anonym" NOR a claim that TAK Team Manager holds no personal data (8.2, 8.3, 8.4, 16.4)
    - Client: assert the create-user form for a pseudonymous target marks the Callsign Suffix required, renders the explanation as text, and does not render a username input (9.7)
    - **Client tests have no `@testing-library/react`.** Use `createRoot` + `act`, dispatch native events, and set `globalThis.React = React` in any file that mounts `.jsx` — the pattern every existing client test file follows
    - _Requirements: 6.1, 6.2, 7.1, 7.2, 7.3, 8.2, 8.3, 8.4, 9.7, 16.4_
    - Files: `server/routes/teams.test.js` (extend), `client/src/components/TeamFormDialog.test.jsx` (extend), `client/src/pages/TeamDetail.test.jsx` (extend)
  - [x] 5.10 Checkpoint - Ensure all tests pass
    - Run `npm test`. Several existing assertions were legitimately rewritten in 5.1-5.3; confirm none of them was WEAKENED to pass, and that the suite count did not fall
    - Run `cd client && npx vitest --run`; run `npm run lint` and confirm the count has not risen above 107
    - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Re-phase device creation onto the Claim_Row and the Managed_Identifier
  - [x] 6.1 Rewrite createDevice: Claim_Row phasing, Managed_Identifier, no email
    - In `server/services/DeviceEnrollmentService.js`, **REMOVE the `DEVICE_EMAIL_DOMAIN` constant** and every use of it (Correction 2, Criterion 5.1). Its whole purpose was minting a synthetic `.invalid` address, and an email on a device account has no function: the account cannot log in, cannot read mail, and has no human owner
    - Replace the `device-` + `crypto.randomUUID()` username with a Managed_Identifier carrying the `D` marker, minted through `ManagedIdentifierService.mintUniqueIdentifier` against the device's Organisation prefix (Criteria 1.3, 14.8). Resolve the Organisation as `Team.getAncestorChain(teamId)[0]`
    - **Re-phase to four phases, with the Claim_Row in front.** The existing shape is authorize → Phase 1 `authentikService.createUser` (no open transaction) → Phase 2 one client, one `BEGIN`, the `users` INSERT plus `TeamMembershipService.addUserToTeam`, `COMMIT`. The new shape:
      - **Phase 0 — Claim.** `mintUniqueIdentifier` runs with `claim(candidate)` being a SINGLE-statement `INSERT INTO users (...) VALUES (...) RETURNING id`, carrying the candidate username, `authentik_user_id = NULL`, `is_active = false`, `is_team_device = true`, `email = NULL`, `device_label = <label>`. NO transaction is opened: the statement is its own unit of work, so a rejected candidate costs one local round trip and nothing external
      - **Phase 1 — Authentik.** `authentikService.createUser` with the CLAIMED username, reached at most once per creation, with a username already known to be locally unique. `device_label` maps to Authentik's `name` field, in place of the first and last name a human carries (Criterion 14.3)
      - **Phase 2 — Adopt and attach.** One client, one `BEGIN`: `UPDATE users SET authentik_user_id = $1, is_active = true WHERE id = $claimId`, then `TeamMembershipService.addUserToTeam(...)` on that same client, `COMMIT` — so the device gets one `team_memberships` row with `inherited_from_team_id IS NULL` and the same channel access a human member of that Team receives (Criteria 14.1, 14.2)
      - **Compensation.** On a Phase-1 or Phase-2 failure: `DELETE FROM users WHERE id = $claimId AND authentik_user_id IS NULL`
    - **TRAP — the compensating DELETE must carry `AND authentik_user_id IS NULL`.** That predicate is the ENTIRE safety of the statement: it can only remove a row that never acquired a federated counterpart, so the product rule "never delete a federated identity to achieve a local outcome" is not engaged at all. Without it this is a delete that can reach a real user. Where Phase 1 succeeded and Phase 2 failed, the pre-existing compensating-Authentik-delete discipline (`server/routes/users.js` plus the cleanup handler in `server/workers/syncWorker.js`) applies unchanged and the Claim_Row delete runs BESIDE it — the same predicate is what stops the two compensations both removing the same row
    - Why a claim rather than generate-then-create-then-insert (design decision 4): a `users_username_key` violation on the local write would otherwise arrive with a federated account already minted under the colliding name, and the retry would have to orphan or delete it, five times over, against that non-negotiable. A dedicated reservation table was rejected because it introduces a SECOND authority for username uniqueness where Criterion 1.7 names exactly one; a pre-insert `SELECT` probe was rejected because it races
    - The Claim_Row window is one HTTP round trip and is visible to nothing: `GET /api/users` sources from Authentik and joins on `authentik_user_id`, `search`/`available` filter `is_active = true`, every team surface joins `team_memberships`, and the Authentik_Sync keys on `authentik_user_id`. Record that in a comment at the claim site
    - The accepted cost, stated rather than hidden: a process death between the claim and its compensation leaves a Claim_Row behind, consuming one identifier out of 27.5 billion (irrelevant) and, for a human, holding `users_email_key` for that address (a real wart). A periodic sweep is a NAMED FOLLOW-UP, not part of this task. Do not weaken the Device_Email_Null_Invariant to `... OR authentik_user_id IS NULL` to avoid it: that would make the constraint stop rejecting the exact row it exists to reject, in the exact circumstance where a defect is most likely (design decision 5)
    - Write `no callsign_level_selection` on the device's Team and change nothing about the inheritance of `color` and `callsign_name_format` from the Organisation. A device's Callsign is generated by exactly the same rules as a human's (Criterion 14.9)
    - **Update `server/services/DeviceEnrollmentService.test.js` in the SAME task.** It pins the `device-<uuid>` username, the synthetic email and the existing two-phase ordering, across roughly eight assertions. Rewrite each against the new behaviour
    - **TRAP — assert the absent email on the SERIALIZED form as well as the object.** `{ email: undefined }` and an absent key are indistinguishable in the object and identical after `JSON.stringify`: verified, `JSON.stringify({username:'x',email:undefined,is_active:true})` yields `{"username":"x","is_active":true}`. `authentikService.createUser` relies on exactly that coincidence. So the assertion replacing the synthetic-email one must check BOTH that the create body has no `email` OWN PROPERTY (`Object.prototype.hasOwnProperty`, or `'email' in body`) AND that its `JSON.stringify` output contains no `"email"`. An object-only assertion proves nothing (Criterion 5.1)
    - _Requirements: 1.3, 5.1, 5.2, 14.1, 14.2, 14.3, 14.4, 14.8, 14.9_
    - Files: `server/services/DeviceEnrollmentService.js`, `server/services/DeviceEnrollmentService.test.js`
  - [x] 6.2 Write example tests for the Claim_Row phasing and the emailless device
    - Assert the Claim_Row is inserted BEFORE the Authentik call and adopted AFTER it, by asserting the ORDER of the mocked calls — an assertion that each happened would pass the old phasing
    - Assert the Claim_Row's column values: candidate username, `authentik_user_id` null, `is_active` false, `is_team_device` true, `email` null, `device_label` set
    - Assert the compensating DELETE is issued on a Phase-1 failure AND on a Phase-2 failure, and that its statement text contains `authentik_user_id IS NULL`. A test that only asserts a DELETE was issued would pass the unscoped version, which is the dangerous one
    - Assert `users.email` and `user_cache.email` receive `null` rather than `''` for a device (5.2)
    - Assert a device with a NULL email renders its Device_Display_Name with no `@` anywhere and no throw, and that no code path substitutes a placeholder address (5.10)
    - Assert `DEVICE_EMAIL_DOMAIN` is no longer exported from the module, and that the string `devices.tak.nz.invalid` appears nowhere in non-test server code (5.11)
    - Assert five consecutive `23505`/`users_username_key` rejections from the claim surface as `ManagedIdentifierExhaustionError` and that NO Authentik call was made (1.9)
    - Assert a `23505` on `users_email_key` propagates on its first occurrence with exactly one claim attempt (1.8)
    - _Requirements: 1.8, 1.9, 5.1, 5.2, 5.10, 5.11_
    - Files: `server/services/DeviceEnrollmentService.claimRow.test.js`
  - [x] 6.3 Checkpoint - Ensure all tests pass
    - Run `npm test`; confirm the DeviceEnrollmentService assertions were rewritten rather than deleted or loosened
    - Run `npm run lint` and confirm the count has not risen above 107
    - Ensure all tests pass, ask the user if questions arise.

- [x] 7. The enrollment core: one private builder, the corrected iTAK payload, QR data URLs
  - [x] 7.1 Add the constants, the pure builders, and the private #buildEnrollment core
    - In `server/services/DeviceEnrollmentService.js`, add `CERTIFICATE_LIFETIME_DAYS = 365` and `ENROLLMENT_PORT = 8089` beside the existing `ENROLLMENT_TOKEN_EXPIRATION_MINUTES = 30`, which is UNCHANGED (Criterion 3.10 — `production-hardening` Criterion 27.7 states an upper bound, not a default, and this stays a hard constant)
    - Add `static buildItakRegistrationPayload(host, username, tokenKey, registrationId = crypto.randomUUID())` returning EXACTLY these four top-level keys: `passphrase: 'false'`, `type: 'registration'`, `serverCredentials: { connectionString }` where the connection string is the host followed by `:8089:ssl`, and `userCredentials: { username, password: tokenKey, registrationId }`
    - `passphrase` is the STRING `'false'`, never the boolean. The Lambda emits the string, iTAK is known to accept the string, and a JSON boolean is a different value that has not been verified against iTAK (Criterion 4.2)
    - The token goes in `userCredentials.password`. There is NO `token` key at any level — the shipped `{ host, username, token }` object is part of why the payload does not work (Criteria 4.3, Correction 3)
    - `8089` is a CODE CONSTANT, never an environment variable and never a site-config value (Criterion 4.4). A configurable port would add a way to render a broken QR code without adding a way to render a working one that `8089` does not already cover
    - `registrationId` is INJECTED with a `crypto.randomUUID()` default, so Property 6 can hold it fixed while varying everything else and production still gets a fresh uuid per payload (Criterion 4.5)
    - Add `static buildAtakEnrollmentUri(host, username, tokenKey)` preserving the shipped construction EXACTLY — `tak://com.atakmap.app/enroll?host=...&username=...&token=...` with `encodeURIComponent` on all three values. It already matches the Lambda and this document changes nothing about it (Criterion 4.7)
    - Add `static async renderQrDataUrl(text)` using `QRCode.toDataURL`, one implementation serving both principals (Criteria 11.1, 11.4). NOT `toBuffer`: `SignupCodeService.generateQrPng` uses `toBuffer` because its consumers are a `res.send` and a `pdfkit` `doc.image`, whereas this consumer is an `<img src>` in a React component fed from a JSON body, and a Buffer cannot travel in JSON without being base64-encoded on the way out — so `toBuffer` would mean the server encodes to PNG, the transport encodes to base64, and nobody decodes the difference (design decision 16)
    - Add the PRIVATE `static async #buildEnrollment(principal, { actingUserId, principalKind })` returning `{ principalId, principalKind, username, host, expiresAt, reEnrollmentDate, atakEnrollmentUri, itakRegistrationPayload, atakQrDataUrl, itakQrDataUrl, takAttributes: { callsign, color, role }, liveCertificateCount }`
    - `#buildEnrollment` performs NO authorization and NO subject resolution and takes an ALREADY-RESOLVED row (Criteria 3.1, 3.2). It has no `is_team_device` guard of any kind — that is what satisfies Criterion 3.2's requirement that the minting core accept `is_team_device = false`
    - `host` is `new URL(process.env.TAK_SERVER_URL).hostname`, resolved ONCE and used by both the ATAK URI and the `connectionString`, so the two QR codes on one Enrollment_View can never name different servers (Criterion 4.6). Throw `TakServerNotConfiguredError` BEFORE any Authentik call and before any token is minted: minting first and failing to build a URI afterwards would leave a live 30-minute credential in Authentik that nothing will ever use and nothing will ever clean up
    - `reEnrollmentDate` is `new Date(now + CERTIFICATE_LIFETIME_DAYS * 86400000).toISOString()` — exactly 365 × 24 hours, NOT a calendar year (Criterion 10.3). Server-side because for a single-page application "at render time" means "at the moment the payload was built": the token expiry beside it is server-issued, and a clock-skewed browser computing one of the two locally would render two values that disagree about when the generation happened (design decision 13)
    - **`#buildEnrollment` must not read `tak_devices.expires_at` — structurally, not by discipline.** Its ONLY `tak_devices` access is the scalar `SELECT count(*) FROM tak_devices WHERE user_id = $1 AND revoked = false` for the Multiple_Certificate_Warning, which projects NO timestamp. At generation time the new certificate does not exist, so the stored value is either absent (first enrollment) or belongs to the certificate being REPLACED, and rendering the outgoing certificate's expiry as the next re-enrollment date is worse than an arithmetic estimate because it looks authoritative and is wrong
    - `takAttributes` come from LOCAL values only (Criterion 10.5): `role` from `users.tak_role`; `callsign` from `UserAttributesService.generateCallsign(userId, teamId)`, the same derivation every other surface uses; `color` from the Organisation's `teams.color` via the Ancestor_Chain. NEVER read Authentik's `attributes.takRole` / `takCallsign` / `takColor` — `authentikSync.js` makes `users.tak_role` local-authoritative and pushes it TO Authentik, so Authentik holds the downstream copy and reading it back would render the stale side of the sync. For a principal with no team membership, `generateCallsign` yields nothing and the value is the explicit string `None`, following the Lambda's own `extractAttribute` default (Criterion 15.3)
    - Mint the token with `authentikService.createAppPasswordToken` and `expiresInMinutes: ENROLLMENT_TOKEN_EXPIRATION_MINUTES` (Criteria 3.10, 15.4)
    - Pass NO enrollment artifact to a log call at any level. The existing log line `{ deviceUserId, teamId, actingUserId, expiresAt }` is the model and is preserved for both paths (Criterion 11.5)
    - _Requirements: 3.1, 3.2, 3.10, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 10.3, 10.5, 11.1, 11.4, 13.2, 15.3, 15.4_
    - Files: `server/services/DeviceEnrollmentService.js`
  - [x] 7.2 Add the two public entry points over the core, and re-point NotATeamOwnedDeviceError
    - Add `static async generateSelfEnrollment(actingUser)` whose ONLY argument is `actingUser`. Resolve the subject from `actingUser.userId` and NOTHING else, assert the resolved row's `is_team_device === false`, then call `#buildEnrollment` with `principalKind: 'human'`
    - **NEVER build a single `generateEnrollment(subjectId = actingUser.userId, actingUser)`.** It satisfies every criterion's letter and is wrong (design decision 6): it puts a DEFAULTED, OVERRIDABLE subject on the one function in this feature that mints a live credential. The self-only rule would then rest on every present and future caller remembering not to pass the first argument, and a single added `req.body.userId ?? undefined` — the kind of edit that looks like a convenience — converts self-only into self-or-anyone with no test failing. Two public entry points, neither taking a subject, over a private core. Convergence belongs BELOW the authorization decision, never above it
    - With no id to supply there is no id to tamper with, which is how Criterion 3.4 is satisfied — NOT by an equality check against a caller-supplied user id
    - The mirror-image guard on the self path: a session resolving to an `is_team_device = true` row is either a defect or an attack, and is refused rather than served with a 403 (Criterion 14.5). A device has no session and no human owner, so there is no self-service case for it
    - Keep `generateEnrollmentQrCode(deviceUserId, actingUser)`'s SIGNATURE unchanged and keep its existing order of operations, which is already right for the device path: resolve the row, resolve the Direct_Membership team, repeat `assertAuthorized` against the RESOLVED team, then build. Route it through `#buildEnrollment` with `principalKind: 'device'` so the payload construction is shared (Criterion 3.1)
    - **TRAP — `NotATeamOwnedDeviceError` STAYS, with a different and narrower meaning.** Correction 4 removes it as a CAPABILITY limit and Criterion 3.2 requires the core to accept a human row; both are satisfied by `#buildEnrollment` having no such guard. The guard survives on `generateEnrollmentQrCode`, where it is now the PARAMETERISED ROUTE's SCOPING rule: this route addresses a subject by id, and the only subject kind a caller may address by id is a Team_Owned_Device. If it accepted a human target its authorization rule would have to become "is the caller an admin of that human's team", which directly contradicts Criterion 3.3's "deny every request whose target is any other account". The next reader's instinct on seeing Correction 4 will be to DELETE it, so **replace its code comment**: state which reading it is, cite Criterion 3.3 as the reason, and stop citing `production-hardening` Requirement 27 as it does today
    - **Defence in depth (Criterion 3.11):** both public entry points perform their own check INSIDE the service, reached whether the caller came through the route or called the service directly. The route layer gates reachability only, exactly as `routes/devices.js` already documents for `device:manage`
    - Handle the Authentik mid-enrollment failures as the design's Error Handling section specifies: token creation failure creates nothing and needs no compensation and writes NO audit row; a token created whose key fetch then fails is compensated by `DELETE /core/tokens/{identifier}/` at the site that knows about it — licensed because a token is a credential this application minted seconds ago, not an identity — and on a failed delete the token identifier (never its key, which was never obtained) is logged at `error` and left to expire inside the 30-minute cap
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.11, 14.5, 15.1, 15.2_
    - Files: `server/services/DeviceEnrollmentService.js`
  - [x] 7.3 Add the five redaction paths, and say in the code that they are a net
    - In `server/config/logger.js`, add `key`, `atakEnrollmentUri`, `atakQrDataUrl`, `itakQrDataUrl` and `itakRegistrationPayload` to `REDACT_PATHS`
    - **State at the site that this is a NET, not the control** (design decision 15). Two verified properties make redaction unusable as a guarantee: `logger.js` omits the `redact` option ENTIRELY when `LOG_LEVEL=debug`, so a debug deployment prints whatever it is handed; and pino redacts by PATH, not by value, so a token embedded inside `atakEnrollmentUri` matches no path even at `info`. The control is that no enrollment artifact is passed to a log call at any level, and Property 13 asserts that by scanning captured logger arguments. Without this comment a reviewer could reasonably conclude the problem is handled
    - Note the small blast radius: adding `key` affects every log line in the application that happens to carry a field named `key`. That is the intended trade — cheap, and it catches an accidental `logger.info({ qrCode })` on a normal deployment
    - _Requirements: 11.5_
    - Files: `server/config/logger.js`
  - [x] 7.4 Write property test: the Re_Enrollment_Date is exactly 365 days of generation time, and no certificate row is read to compute it
    - **Property 5: The Re_Enrollment_Date is exactly 365 days of generation time, and no certificate row is read to compute it**
    - Tag exactly: `// Feature: takserver-enrollment, Property 5: The Re_Enrollment_Date is exactly 365 days of generation time, and no certificate row is read to compute it`
    - `@fast-check/jest`, `numRuns >= 100`. Generate instants INCLUDING ones either side of a southern- and a northern-hemisphere daylight-saving transition, inside a leap year, inside the day before a leap day, and pre-epoch and far-future
    - Assert the returned Re_Enrollment_Date equals that instant plus exactly `31,536,000,000` ms. **Re-derive that number in the test as `365 * 24 * 60 * 60 * 1000` written out — do NOT import `CERTIFICATE_LIFETIME_DAYS`.** A test that imports the constant asserts only that multiplication works
    - Structural arm: assert the builder issued NO query projecting `tak_devices.expires_at` or `tak_devices.issued_at`, whatever those columns contain for the principal. Seed the mocked row with a wildly wrong stored expiry so an implementation reading it produces a visibly different value
    - **Validates: Requirements 10.3**
    - _Requirements: 10.3_
    - Files: `server/services/__tests__/DeviceEnrollmentService.reEnrollmentDate.property.test.js`
  - [x] 7.5 Write property test: the enrollment payloads are structurally exact and agree on the host, for every principal
    - **Property 6: The enrollment payloads are structurally exact and agree on the host, for every principal**
    - Tag exactly: `// Feature: takserver-enrollment, Property 6: The enrollment payloads are structurally exact and agree on the host, for every principal`
    - `@fast-check/jest`, `numRuns >= 100`. Generate triples of TAK Server URL, username and token key INCLUDING hosts and usernames carrying colons, quotes, backslashes, non-ASCII characters, the empty string, and strings longer than 1000 characters, crossed with both Enrollment_Principals
    - Assert: the top-level key set equals EXACTLY `{passphrase, type, serverCredentials, userCredentials}`; `serverCredentials`' key set equals exactly `{connectionString}`; `userCredentials`' key set equals exactly `{username, password, registrationId}` — so no `token` key at any level and no extra key can pass; `passphrase` is the string `"false"` and not a boolean; `connectionString` equals the host then `:8089:ssl`; `password` equals the token key; `JSON.parse(JSON.stringify(payload))` deep-equals the payload; the host inside `connectionString` equals the host inside the ATAK URI's `host` parameter; two invocations with identical inputs differ in `registrationId` and in NOTHING else, each matching the uuid shape; and the payload is identical whichever public entry point produced it
    - **Re-derive the expected payload by LITERAL CONSTRUCTION in the test, never by calling the builder.** Independent re-derivation is the point: a test that builds its expectation with the function under test asserts only determinism
    - **Anti-vacuity:** assert at least one generated host contained a colon. A colon in the host is exactly what would break a naive `split(':')` reading of the `connectionString`, so a generator that never produced one would leave the interesting case untested
    - **Validates: Requirements 3.1, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 15.7**
    - _Requirements: 3.1, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 15.7_
    - Files: `server/services/__tests__/DeviceEnrollmentService.itakPayload.property.test.js`
  - [x] 7.6 Write example tests for the enrollment core's exact calls and values
    - Assert `QRCode.toDataURL` is called (not `toBuffer`) and that both `atakQrDataUrl` and `itakQrDataUrl` are prefixed `data:image/png;base64,` (11.1, 11.2)
    - Assert the ATAK URI's exact construction, including `encodeURIComponent` on all three values (4.7)
    - Assert `expiresInMinutes: 30` on BOTH enrollment paths (3.10)
    - Assert `TakServerNotConfiguredError` is raised BEFORE any `createAppPasswordToken` call when `TAK_SERVER_URL` is unset or unparseable — assert the token minting mock was never invoked, not merely that an error was thrown
    - Assert the token-created-but-key-fetch-failed path issues the compensating token DELETE, and that a failed delete logs the token IDENTIFIER and never the key
    - Assert `takAttributes` are read from local columns and that no Authentik `attributes.takRole` / `takCallsign` / `takColor` read occurs anywhere on this path (10.5)
    - Assert a principal with no team membership yields `None` for each unset TAK_Attribute rather than an empty value (15.3)
    - Assert `generateSelfEnrollment` refuses an `is_team_device = true` row (14.5), and that `generateEnrollmentQrCode` still throws `NotATeamOwnedDeviceError` for a human row — with the test's own comment naming this as the route's SCOPING rule per Criterion 3.3, so a later reader does not delete the test alongside the guard
    - Assert `#buildEnrollment` accepts an `is_team_device = false` row when reached from the self path, which is the positive half of Criterion 3.2
    - _Requirements: 3.2, 3.10, 4.7, 10.5, 11.1, 11.2, 14.5, 15.3_
    - Files: `server/services/DeviceEnrollmentService.enrollment.test.js`
  - [x] 7.7 Checkpoint - Ensure all tests pass
    - Run `npm test`; run `npm run lint` and confirm the count has not risen above 107
    - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Routes, the permission registry, and the row-scoped resolver
  - **Authorization is deny-by-default.** `resolveAccess` denies an unmapped route, and `permissions.registry.completeness.test.js` FAILS THE BUILD for one. Both new routes need registry entries or the suite goes red for a reason that looks unrelated to the code that caused it.
  - [x] 8.1 Add the self-enrollment route
    - Create `server/routes/enrollment.js`, mounted at `/api/enrollment` in `server/index.js` beside the existing mounts
    - `POST /me` with `authenticateToken, authorize` and **no route parameters, no body schema and no query schema**. The handler sets `Cache-Control: no-store, no-cache, must-revalidate` and `Pragma: no-cache`, calls `DeviceEnrollmentService.generateSelfEnrollment(req.user)`, writes the Enrollment_Audit_Record, and responds `{ enrollment }`
    - `no-store` is the load-bearing directive: it forbids a shared or private cache from writing the body to disk at all, where `no-cache` alone only requires revalidation. The Lambda sets the same headers at `index.js:148` (Criterion 11.5)
    - The audit row matches what `routes/devices.js` already writes under `production-hardening` Criterion 27.8: `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details)` with `action: 'enrollment_self_qr_generated'`, `resource_type: 'user'`, `resource_id: enrollment.principalId`, and `details` carrying `{ principalId, generatedAt, expiresAt }` — **and no token key and no QR data URL** (Criteria 3.9, 11.5). Write it after a successful call and before responding, exactly as the device route does
    - Reuse `routes/devices.js`'s `ERROR_STATUS_BY_NAME` / `handleServiceError` pattern VERBATIM, extended with `OrganisationPrefixMissingError` → 400 and `ManagedIdentifierExhaustionError` → 500. Exhaustion is the one 500 deliberately: every other entry describes something the caller did or something the deployment has not configured, where exhaustion describes a defect in the generator's random source, so it must be loud and its message must tell the caller nothing, because the caller cannot act on it. The detail goes to the log
    - _Requirements: 3.4, 3.9, 11.5, 15.1, 15.2_
    - Files: `server/routes/enrollment.js`, `server/index.js`
  - [x] 8.2 Add listTeamDevices to the service
    - Add `static async listTeamDevices(teamId, actingUser)` to `server/services/DeviceEnrollmentService.js`, returning `{ devices: [{ deviceUserId, username, deviceLabel, teamId, createdAt, liveCertificateCount }] }`
    - **No email field at all** — a device has none and a placeholder is forbidden (Criterion 5.10). This surface is what keeps a device reachable by its Device_Display_Name and its Managed_Identifier despite being absent from every email-keyed search (Criteria 5.8, 5.9)
    - Resolve `liveCertificateCount` from the SAME derived-table join shape task 8.6 adds to `GET /api/users`, so the device surface and the user list resolve it identically. One statement for the whole list, independent of its length (Criterion 13.6)
    - Repeat the authorization check inside the service — Global_Manager or `Team.isAdmin` — rather than trusting the route layer (Criterion 3.11)
    - This surface exists because `production-hardening` Criterion 27.9 excludes every Team_Owned_Device from user lists and member counts, Criterion 14.6 requires that exclusion to SURVIVE, and the consequence is that a Team's devices are currently invisible to the admin who owns them (Criterion 14.7). Do NOT close the gap by reintroducing devices into the human member list
    - _Requirements: 3.11, 5.9, 5.10, 13.6, 14.6, 14.7_
    - Files: `server/services/DeviceEnrollmentService.js`
  - [x] 8.3 Update routes/devices.js: no-store, the corrected response, and the team listing
    - Add the `Cache-Control: no-store, no-cache, must-revalidate` and `Pragma: no-cache` headers to `POST /:deviceUserId/qr-code` (Criterion 11.5). Its response shape becomes `#buildEnrollment`'s object under the existing `qrCode` key, so `EnrollmentView.jsx` renders one shape from both routes
    - Add `GET /team/:teamId` calling `listTeamDevices`, with the usual `express-validator` param validation and `handleServiceError` mapping
    - Leave `POST /` and the existing Requirement 27.8 audit logging on the qr-code route unchanged in surface
    - **Update `server/routes/devices.test.js` in the SAME task.** It pins the old `itakEnrollmentPayload: { host, username, token }` response across roughly twelve assertions. Replace them with assertions on the corrected payload — the exact key set, not a loose shape check — and add the `no-store` header assertion. Do not weaken an exact-value assertion to make it pass
    - _Requirements: 4.1, 4.3, 11.5, 14.7_
    - Files: `server/routes/devices.js`, `server/routes/devices.test.js`
  - [x] 8.4 Add both permission-registry entries and exactly one roleDefaults grant
    - In `server/config/permissions.registry.js` add `'POST /api/enrollment/me': ['enrollment:self']` and `'GET /api/devices/team/:teamId': ['device:read:team_admin']`. Leave `'POST /api/devices'` and `'POST /api/devices/:deviceUserId/qr-code'` on `device:manage`, unchanged
    - **`enrollment:self` goes in `roleDefaults.authenticated_user` as a static grant.** It is a NEW identifier rather than a reuse of `device:manage` (Criterion 3.5): `device:manage` means "may create and enroll team-owned devices", and reusing it would make the two capabilities inseparable, so an operator could not grant a member the ability to enroll their own phone without also granting them the ability to create device accounts on their team. The static grant is safe for the same reason the registry already records for `device_mgmt:read:own`: the route's subject is `req.user.userId` and no request input can widen it, so there is no row for a resolver to scope and nothing a static grant could give away
    - **`device:read:team_admin` must be kept OUT of `roleDefaults`.** Its subject comes from a URL parameter, and a statically-held identifier satisfies `resolveAccess` outright so `authorize.js` never consults the resolver — which would let ANY authenticated user enumerate ANY team's devices. This is the `user:team:transfer` and `device_mgmt:*:managed` treatment, and the registry already records the reasoning for both; cite it rather than restating it
    - Add a comment at each entry naming the identifier's subject source, since that is the fact that decides whether it may be static
    - _Requirements: 3.5, 3.7_
    - Files: `server/config/permissions.registry.js`
  - [x] 8.5 Add the row-scoped resolver for the team device listing
    - In `server/middleware/authorize.js`, add `rowScopedResolvers['device:read:team_admin'] = async (req) => req.user?.is_global_manager === true || await Team.isAdmin(req.params.teamId, req.user?.userId)`
    - **TRAP — `Team.isAdmin` takes `req.user.userId` (the local `users.id`), NEVER `req.user.id` (the Authentik id).** The file's own header comment already states that every resolver must pass `req.user.userId`; passing the other one produces a resolver that fails closed for everybody and looks like an over-tight gate rather than a bug
    - `Team.isAdmin` resolves Team_Admin through the Ancestor_Chain, so an Organisation admin qualifies for a Sub_Team beneath it, and an INHERITED admin row never confers Team_Admin (Criterion 3.6)
    - The existing fail-closed try/catch around resolver invocation covers this one; do not add a second
    - _Requirements: 3.6, 3.7, 3.8_
    - Files: `server/middleware/authorize.js`
  - [x] 8.6 Join the live certificate count into the query GET /api/users already runs
    - In `server/routes/users.js`, add ONE derived table to the existing recursive `team_root` statement at line ~129:
      `LEFT JOIN (SELECT user_id, COUNT(*)::int AS live_certificate_count FROM tak_devices WHERE user_id IS NOT NULL AND revoked = false GROUP BY user_id) certs ON certs.user_id = u.id`
    - Project it as `COALESCE(certs.live_certificate_count, 0) AS live_certificate_count` and carry it onto the wire shape beside the `local_user_id` field `device-management` task 15.4 added for exactly this reason — its comment records that the field exists so the Users view can address local per-user resources "without a second round trip per row". Zero new queries, zero new round trips, and the statement count stays independent of the page size (Criterion 13.6)
    - **Row presence is liveness.** `device-management` Requirement 17 deletes every `tak_devices` row whose `client_uid` carries no Live_Certificate on each fully-successful sync, so a row's existence is what "live certificate" means (Criterion 13.2). The `revoked = false` predicate is a belt-and-braces exclusion of the transient state between a confirmed revocation and the next sync, which `device-management` Criterion 17.7 records as lasting up to one sync interval
    - **Do NOT flag-gate the join with `isDeviceMgmtEnabled()`**, and that is the point rather than an omission (design decision 17). While device-management is off nothing populates `tak_devices`, so every count is zero and no warning renders — inert without a check. A flag check would be a second mechanism producing the same inertness, and a warning that failed to appear would then have two places to hide
    - _Requirements: 13.2, 13.6_
    - Files: `server/routes/users.js`
  - [x] 8.7 Write property test: self-enrollment resolves its subject from the session alone
    - **Property 4: Self-enrollment resolves its subject from the session alone**
    - Tag exactly: `// Feature: takserver-enrollment, Property 4: Self-enrollment resolves its subject from the session alone`
    - `@fast-check/jest`, `numRuns >= 100`. Generate request objects with arbitrary additional keys in `body`, `query` and `params` — including `userId`, `deviceUserId`, `user_id`, `sub`, `id`, `principalId`, `__proto__`, `constructor`, keys whose values are numeric strings equal to another principal's id, and keys whose values are objects with a hostile `valueOf` — crossed with arbitrary `req.user`
    - Assert the resolved subject EQUALS `req.user.userId` and nothing else; that the path reads no identifier from `body`, `query` or `params` (assert on the mocked row lookup's arguments, so a read that happens and is then ignored still fails); and that a resolved row with `is_team_device` true is REFUSED rather than built
    - The `__proto__` and `constructor` keys are in the generator because a subject resolution that reaches into a request object by key name is a prototype-pollution surface
    - **Validates: Requirements 3.3, 3.4, 14.5**
    - _Requirements: 3.3, 3.4, 14.5_
    - Files: `server/routes/__tests__/enrollment.selfSubject.property.test.js`
  - [x] 8.8 Write property test (query arm): certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries
    - **Property 12: Certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries**
    - Tag exactly: `// Feature: takserver-enrollment, Property 12: Certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries`
    - `@fast-check/jest`, `numRuns >= 100`. This is the QUERY arm; task 11.4 is the render arm. **Property 12 is the one property implemented as two files, because its subject spans two runners** — both files carry the identical tag, and neither is a duplicate of the other
    - Generate `tak_devices` content over a SMALL `user_id` alphabet against a MUCH LARGER row count, so several rows per principal, zero rows per principal, rows with a null `user_id` and rows with `revoked = true` are all COMMON cases rather than edge cases, crossed with lists of principal ids including the EMPTY list
    - Assert each principal's resolved count equals the independently computed number of rows whose `user_id` is that principal and whose `revoked` is false; never includes another principal's row or a null-`user_id` row; and that the number of database statements issued for the whole list is INDEPENDENT of the list's length
    - **Re-derive each count by filtering the generated rows in JavaScript, never by running the SQL.** Boundary concentration: concentrate per-principal row counts on exactly 0, 1 and 2, since the warning's threshold sits between the last two. Anti-vacuity: assert at least one generated principal had two or more rows and at least one had exactly one
    - **Validates: Requirements 13.1, 13.2, 13.4, 13.5, 13.6**
    - _Requirements: 13.1, 13.2, 13.4, 13.5, 13.6_
    - Files: `server/routes/__tests__/users.certificateCount.property.test.js`
  - [x] 8.9 Write property test: no enrollment artifact reaches a log, a query parameter, a persisted field, or a cache
    - **Property 13: No enrollment artifact reaches a log, a query parameter, a persisted field, or a cache**
    - Tag exactly: `// Feature: takserver-enrollment, Property 13: No enrollment artifact reaches a log, a query parameter, a persisted field, or a cache`
    - `@fast-check/jest`, `numRuns >= 100`. Generate triples of host, username and token key such that the KEY IS A SUBSTRING OF NO OTHER GENERATED VALUE — otherwise a hit is unattributable and the property is unfalsifiable
    - Capture every argument passed to the Structured_Logger, every element of every parameter array passed to the pool, and every value stored in an `audit_logs` `details` document, and assert none contains a string containing the token key, the ATAK URI, the serialized iTAK payload, or either QR data URL. Assert the response carries a `Cache-Control` header containing `no-store`
    - Run this over BOTH enrollment routes. Do NOT satisfy it by trusting `REDACT_PATHS`: the redact option is omitted entirely at `LOG_LEVEL=debug`, and pino redacts by path rather than by value, so a token inside a URI string matches nothing. The assertion is a substring scan of what was actually handed over
    - **Validates: Requirements 11.5**
    - _Requirements: 11.5_
    - Files: `server/routes/__tests__/enrollment.secretMaterial.property.test.js`
  - [x] 8.10 Write property test: Team_Owned_Device enrollment is permitted exactly for a Team_Admin of the device's Ancestor_Chain or a Global_Manager
    - **Property 14: Team_Owned_Device enrollment is permitted exactly for a Team_Admin of the device's Ancestor_Chain or a Global_Manager**
    - Tag exactly: `// Feature: takserver-enrollment, Property 14: Team_Owned_Device enrollment is permitted exactly for a Team_Admin of the device's Ancestor_Chain or a Global_Manager`
    - `@fast-check/jest`, `numRuns >= 100`. Generate team hierarchies of depth 0 through `MAX_TEAM_DEPTH` (5), arbitrary placement of the device's Direct_Membership within them, and arbitrary sets of DIRECT (`inherited_from_team_id IS NULL`) `role='admin'` rows at arbitrary depths for arbitrary users
    - Assert an enrollment is built if and only if the acting user is a Global_Manager, or holds a direct admin row on the device's own Team or on any ANCESTOR of it; and denied for every other acting user, INCLUDING one holding only an INHERITED admin row and one administering a sibling branch. Both of those are the cases a naive `role = 'admin'` check gets wrong
    - Assert the SAME decision whether reached through the route or by calling the service directly, which is the defence-in-depth clause of Criterion 3.11
    - **Validates: Requirements 3.6, 3.8, 3.11, 14.5**
    - _Requirements: 3.6, 3.8, 3.11, 14.5_
    - Files: `server/services/__tests__/DeviceEnrollmentService.authorization.property.test.js`
  - [x] 8.11 Write registry, route and configuration smoke tests
    - Assert `POST /api/enrollment/me` maps to `enrollment:self` and NOT to `device:manage`, and that `enrollment:self` IS in `roleDefaults.authenticated_user` (3.5)
    - Assert `device:read:team_admin` is in the registry, is NOT in `roleDefaults` (any role), and HAS a resolver (3.7). Assert all three in the same test, so a later refactor cannot satisfy one and quietly break another
    - Assert `permissions.registry.completeness.test.js` passes unchanged
    - Assert the `audit_logs` INSERT's column set on the self path names the acting user, the target principal and the generation time, and matches what `routes/devices.js` already writes (3.9)
    - Assert `client/package.json` names no QR package (11.3), and that this feature reads only `TAK_SERVER_URL` from the environment with `.env.example` UNCHANGED (15.10)
    - Assert no code path rewrites a `client_uid` or a certificate Common_Name for display (16.3), and that the enrollment path reads no `attributes.takRole` / `takCallsign` / `takColor` (10.5)
    - Assert `GET /api/devices/team/:teamId` returns no `email` field for any device (5.10)
    - _Requirements: 3.5, 3.7, 3.9, 5.10, 10.5, 11.3, 15.10, 16.3_
    - Files: `server/config/__tests__/enrollmentPermissions.test.js`, `server/routes/enrollment.test.js`
  - [x] 8.12 Checkpoint - Ensure all tests pass
    - Run `npm test`. Confirm `permissions.registry.completeness.test.js` passes — if it fails, a route is missing a registry entry, not a route file
    - Run `npm run lint` and confirm the count has not risen above 107
    - Ensure all tests pass, ask the user if questions arise.

- [x] 9. The client Enrollment_View, the countdown, and platform detection
  - **Client tests have no `@testing-library/react`.** Every file here uses `createRoot` + `act`, dispatches native events, and sets `globalThis.React = React` when it mounts a `.jsx` module. `npm run lint` does NOT lint `client/`, so the Vitest suite is the only gate on every file this section adds.
  - [x] 9.1 Create the pure countdown formatter
    - Create `client/src/utils/tokenCountdown.js` exporting `COUNTDOWN_EXPIRED = 'EXPIRED'` and `formatCountdown(msRemaining) -> 'MM : SS' | 'EXPIRED'`
    - Total, never throws. `<= 0`, `null`, `undefined`, `NaN`, `Infinity`, `-Infinity` and non-numbers all yield `EXPIRED`
    - **Minutes are NOT wrapped at 60 and NOT truncated at 99.** A 30-minute token never exceeds two digits, and silently wrapping a larger value would render a SMALLER number than the truth — the one failure direction that misleads rather than merely looks wrong
    - No React import, so Property 10 reaches it directly. Place it in `client/src/utils/` beside `dateFormat.js`, `channelTree.js` and `expiryWarning.js`, following the placement rule and the `expiryWarning.js` precedent
    - _Requirements: 10.2_
    - Files: `client/src/utils/tokenCountdown.js`
  - [x] 9.2 Create the pure platform detector
    - Create `client/src/utils/platformDetection.js` exporting `isAndroidClient(nav) -> boolean`
    - Prefer `nav.userAgentData.platform` (the client-hints equivalent of `sec-ch-ua-platform`), falling back to `/android/i` on `nav.userAgent`. Return `false` for `null`, `undefined`, a non-object, an absent or non-string `userAgent`, and a `userAgentData` whose `platform` getter THROWS
    - **`nav` is a PARAMETER, not a reach for the global `navigator`**, so Property 11 can hand it hostile shapes. Pure, total, never throws, reads no global
    - Detection is client-side because the Lambda's server-side `sec-ch-ua-platform` header check cannot work here (Criterion 10.6): a single-page application renders from data fetched by an API call, and that call's headers describe the browser that asked for JSON, not a page request whose headers describe the device the view is displayed on
    - _Requirements: 10.6_
    - Files: `client/src/utils/platformDetection.js`
  - [x] 9.3 Create the countdown component
    - Create `client/src/components/EnrollmentCountdown.jsx` holding a `setInterval(…, 1000)` created in a `useEffect`, cleared on unmount AND on reaching the terminal state, rendering `formatCountdown`'s output and then the terminal `EXPIRED` — matching the Lambda's `generateCountdownScript`, including its replacement of the deep-link text with an expired message (Criterion 10.2)
    - **It must NOT re-fetch on expiry** (design decision 14). An expired token is not refreshed automatically. Minting a token is minting a credential, and a page that re-minted on a one-second timer would mint an unbounded number of live 30-minute credentials for an idle open tab, each one an Authentik object and each one valid. Regeneration is an explicit user action — a "Generate a new code" button that becomes available at `EXPIRED` — so the number of live tokens a session can produce is bounded by the number of times a human clicked
    - **It must NOT tick a date.** This component renders a DURATION, shares no module with `FormattedDate`, and drives no date rendering. `FormattedDate` forbids any timer, interval or subscription inside it because a ticking timer is a second refresh mechanism per date; the Re_Enrollment_Date beside this countdown is a STATIC value rendered once
    - Carry the `EXPIRED` state in TEXT, never colour alone
    - _Requirements: 10.2_
    - Files: `client/src/components/EnrollmentCountdown.jsx`
  - [x] 9.4 Add the API calls
    - In `client/src/services/api.js`, add an `enrollmentAPI` group with `generateSelf()` → `POST /api/enrollment/me`, and add the team device listing call → `GET /api/devices/team/:teamId` beside the existing device calls
    - Both calls are added here in one task deliberately, because this file is edited once: the same-file rule otherwise forces the device listing into its own wave for no benefit
    - **The response is secret material.** Keep it in component state for the life of the view: no `localStorage`, no `sessionStorage`, and no URL that carries it, so a token cannot outlive the tab or reach a browser-history entry (Criterion 11.5)
    - _Requirements: 11.2, 11.5, 14.7_
    - Files: `client/src/services/api.js`
  - [x] 9.5 Create the Enrollment_View
    - Create `client/src/pages/EnrollmentView.jsx` — ONE component serving BOTH Enrollment_Principals from one API shape (Criterion 10.10), so the self view and the device view cannot diverge on the countdown, the Re_Enrollment_Date or the payload rendering
    - Render both QR_Data_Urls as `<img src>` values computed by nobody on the client, the principal's username, the TAK Server host, the Enrollment_Token as TEXT beside the codes so a device that cannot scan can be enrolled by manual entry, the `<EnrollmentCountdown>`, the Re_Enrollment_Date, the TAK_Attributes, and the `<MultipleCertificateWarning>` (Criteria 10.1, 10.8)
    - Render the Re_Enrollment_Date through `<FormattedDate precision="date">`. **`client/src/components/FormattedDate.jsx` is the ONLY non-test module permitted to import `formatDate`/`formatDateTime`**, enforced as a set EQUALITY against a one-entry allow-list by `client/src/utils/dateFormatConsumers.test.js` — so import `FormattedDate`, never the helpers, and Criterion 10.9 needs no new mechanism
    - Label the Re_Enrollment_Date as the date the certificate ABOUT TO BE ISSUED will need replacing, and never as a read of an existing certificate (Criterion 10.4)
    - **Android_Only_Suppression removes the deep link from the DOM ENTIRELY**, not hidden with CSS: a `tak://` link that resolves nowhere is a link that does nothing when a keyboard user reaches it. Both QR_Data_Urls keep rendering while suppression is in force — they are scanned by a SECOND device and are useful on any platform, and only the deep link, which acts on the CURRENT device, is platform-bound (Criteria 10.6, 10.7)
    - Render `None` for any unset TAK_Attribute rather than an empty field, following the Lambda's own `extractAttribute` default. The view must work for a signed-in user holding NO team membership at all, which is the one behavioural gap between the two systems and a hard precondition for switching the Lambda off (Criteria 15.2, 15.3)
    - **No app-store badges on this view** — they move to the Downloads_Page (Criteria 10.11, 12.1)
    - No background refresh on this view at all, so there is no interval to pause. A failed generation leaves the previous payload rendered if there was one, does not clear the view and does not hide the surface, following the client rule that a failed refresh must never clear a rendered list; a network failure or a 500 shows an error beside a retry
    - Do NOT carry over the Lambda's two-request loading pattern (`views/loader.ejs`, then `?load=true`) or its branding switch: the first exists because a Lambda behind an ALB must answer before its Authentik calls complete, and the second duplicates site branding this application already has (Criteria 15.8, 15.9)
    - _Requirements: 10.1, 10.4, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 15.2, 15.3, 15.8, 15.9_
    - Files: `client/src/pages/EnrollmentView.jsx`
  - [x] 9.6 Add the Enrollment nav item and route
    - In `client/src/components/Layout.jsx`, add `{ name: 'Enrollment', href: '/enrollment', icon: <a Heroicon already imported or added from the existing @heroicons/react> }` inside `baseNavigation`, BEFORE any role gate, so every signed-in user sees it regardless of team membership (Criterion 15.2)
    - In `client/src/App.jsx`, add `<Route path="/enrollment" element={<EnrollmentView />} />` inside the `user`-present branch behind the existing `loading` gate, beside the routes at lines ~148-172
    - The client route carries no permission identifier: reachability of a client route is a routing fact, and the authorization decision happens on the API call
    - No new icon dependency — use `@heroicons/react`, already present
    - _Requirements: 15.2, 15.11_
    - Files: `client/src/components/Layout.jsx`, `client/src/App.jsx`
  - [x] 9.7 Write property test: the Token_Countdown formatter is total and boundary-exact at zero
    - **Property 10: The Token_Countdown formatter is total and boundary-exact at zero**
    - Tag exactly: `// Feature: takserver-enrollment, Property 10: The Token_Countdown formatter is total and boundary-exact at zero`
    - Vitest with `fast-check` (already a `client/package.json` devDependency), `numRuns >= 100`
    - Assert the return is either the exact terminal string `EXPIRED` or a string matching an ANCHORED `MM : SS` regex with both components zero-padded to at least two digits and the seconds component in 00..59; `EXPIRED` if and only if the input is not a finite number greater than zero; never throws; and never renders a minutes value SMALLER than the true remaining minutes
    - **Boundary concentration is required:** concentrate on exactly `0`, `-1`, `+1`, `999`, `1000`, `59999`, `60000`, values just under and just over the 30-minute lifetime, and values exceeding 99 minutes. Those are where a `<` that should be `<=` and a `Math.floor` that should be a `Math.ceil` live, and a uniform generator would essentially never land on them
    - Draw also from the shared totality generator (`null`, `undefined`, `NaN`, `±Infinity`, non-numbers)
    - **Validates: Requirements 10.2**
    - _Requirements: 10.2_
    - Files: `client/src/utils/tokenCountdown.property.test.js`
  - [x] 9.8 Write property test: Android detection is total over hostile navigator shapes
    - **Property 11: Android detection is total over hostile navigator shapes**
    - Tag exactly: `// Feature: takserver-enrollment, Property 11: Android detection is total over hostile navigator shapes`
    - Vitest with `fast-check`, `numRuns >= 100`. Generate `null`, `undefined`, a primitive, an object with no `userAgent`, a non-string `userAgent`, an object with no `userAgentData`, a `userAgentData` whose `platform` GETTER THROWS, a `userAgentData.platform` of arbitrary case, and arbitrary `userAgent` strings including ones naming Android in mixed case and ones naming it inside an unrelated token
    - Assert a boolean is always returned; it never throws; and it is a pure function of its argument alone, returning the same value for the same argument on repeated calls and reading no global — assert the last clause by deleting/stubbing `globalThis.navigator` for the duration
    - **Validates: Requirements 10.6**
    - _Requirements: 10.6_
    - Files: `client/src/utils/platformDetection.property.test.js`
  - [x] 9.9 Write client example tests for the view and the countdown
    - Assert the view renders both QR images, the username, the host and the token text (10.1, 10.8)
    - With FAKE TIMERS: assert the countdown ticks, reaches `EXPIRED`, CLEARS its interval, replaces the deep-link text with the expired message, and **issues NO fetch on expiry** — the last one is the assertion that stops the credential-minting loop design decision 14 rejects (10.2)
    - Assert the "Generate a new code" action appears only at `EXPIRED` and issues exactly one request per click
    - Assert the view renders `None` three times for a principal with all three TAK_Attributes unset (15.3)
    - With detection forced false: assert the deep link is ABSENT FROM THE DOM (not merely hidden) and that both QR images remain (10.6, 10.7)
    - Assert no badge markup appears on the view (10.11)
    - Assert the Re_Enrollment_Date's label states it is the date the certificate about to be issued will need replacing, and does not present it as a read of an existing certificate (10.4)
    - Assert dates render through `FormattedDate` and that `dateFormatConsumers.test.js` still passes with its one-entry allow-list unchanged (10.9)
    - Assert a failed generation leaves a previously rendered payload intact and shows a retry (client error rule)
    - _Requirements: 10.1, 10.2, 10.4, 10.6, 10.7, 10.8, 10.9, 10.11, 15.3_
    - Files: `client/src/pages/EnrollmentView.test.jsx`, `client/src/components/EnrollmentCountdown.test.jsx`
  - [x] 9.10 Checkpoint - Ensure all tests pass
    - Run `cd client && npx vitest --run` and confirm the client suite passes; run `npm test` for the server
    - Remember `npm run lint` does not reach `client/`, so the Vitest suite is the only gate on every file this section added
    - Ensure all tests pass, ask the user if questions arise.

- [x] 10. The Downloads_Page and the Store_Badges
  - The badges are COPIED from the Lambda's `views/partials/store_badges.ejs`, not redrawn and not regenerated (Criterion 12.3). That partial declares itself the source of truth for the TAK_Gov_Badge and the reasons it records are load-bearing rather than stylistic.
  - [x] 10.1 Copy the three badge SVGs into a components module
    - Create `client/src/components/StoreBadges.jsx` exporting `GooglePlayBadge`, `AppleAppStoreBadge`, `TakGovBadge` and `RecommendedOptionMarker`
    - Each badge is an inline `<svg>` COPIED from `store_badges.ejs` with ONLY the mechanical conversions JSX forces: `stroke-width` → `strokeWidth`, `stroke-linecap` → `strokeLinecap`, `xml:space` → `xmlSpace`, `enable-background` → `enableBackground`, and the Google badge's `<metadata>` block dropped because JSX cannot express `xmlns:rdf`-namespaced attributes and the block is Dublin Core boilerplate that renders nothing. **No path data is redrawn, regenerated or optimised**
    - **Keep the TAK_Gov_Badge at exactly 135 × 40 with `viewBox="0 0 135 40"`.** The page CSS forces a 40px height, so a different aspect ratio renders a different WIDTH and breaks grid alignment. Note in the code that the Google Play badge is 180 × 53.333 and the Apple badge 135 × 40 — different intrinsic sizes with compatible ratios, which is why height-forcing works and why the TAK.gov badge had to match the RATIO rather than the pixels
    - **The TAK_Gov_Badge label is OUTLINED VECTOR PATHS, not `<text>`**, so it renders identically whatever fonts the client has. Preserve the consequence as a code comment: changing the badge's wording means RE-OUTLINING the glyphs, not editing a string (Criterion 12.4)
    - The Apple badge SVG is used TWICE — for TAK Aware and for iTAK — so it is one component rendered in two positions, not two copies
    - `RecommendedOptionMarker` renders the Tabler star with `aria-hidden` on the glyph and the accessible name as a visually-hidden `<span className="sr-only">Recommended option</span>` beside it (Criterion 12.6). **Do NOT copy the partial's `title="Recommended option"` attribute**: the client conventions forbid `title` as the description mechanism because it is not disclosed on keyboard focus and screen-reader support for it is inconsistent. Real text in the accessibility tree is strictly stronger and satisfies the "state carried in TEXT" rule at the same time. This is a deliberate divergence from a criterion that says to copy, and it is worth flagging in review (design decision 18)
    - _Requirements: 12.2, 12.3, 12.4, 12.6_
    - Files: `client/src/components/StoreBadges.jsx`
  - [x] 10.2 Create the Downloads_Page
    - Create `client/src/pages/Downloads.jsx` rendering the 2 × 2 grid — recommended routes on the first row, alternatives on the second
    - Preserve the FOUR link targets from `store_badges.ejs` unchanged: `https://tak.gov/products/atak-civ`, `https://apps.apple.com/in/app/tak-aware/id6738631659`, `https://play.google.com/store/apps/details?id=com.atakmap.app.civ`, `https://apps.apple.com/us/app/itak/id1561656396` (Criterion 12.7)
    - Every external link carries `rel="noopener"`, as the partial does (Criterion 12.8)
    - The Recommended_Option_Marker appears on ATAK-via-TAK.gov and on TAK Aware, and on NEITHER of the other two routes (Criterion 12.5)
    - The page fetches nothing, so it adds NO entry to the permission registry — its reachability is a client routing fact, not an authorization one
    - _Requirements: 12.2, 12.5, 12.7, 12.8_
    - Files: `client/src/pages/Downloads.jsx`
  - [x] 10.3 Add the Downloads nav item and route
    - In `client/src/components/Layout.jsx`, add `{ name: 'Downloads', href: '/downloads', icon: ArrowDownTrayIcon }` inside `baseNavigation`, BEFORE any role gate, so every signed-in user sees it regardless of team membership (Criterion 12.9) — which is the point, since a user who has not been placed in a Team yet is exactly the user installing a client for the first time
    - In `client/src/App.jsx`, add `<Route path="/downloads" element={<Downloads />} />`
    - This edits the same two files as task 9.6, which is why it is a separate task in a later wave rather than folded into it
    - _Requirements: 12.1, 12.9_
    - Files: `client/src/components/Layout.jsx`, `client/src/App.jsx`
  - [x] 10.4 Write the structural guard for badge fidelity
    - Create `client/src/components/storeBadgeFidelity.test.jsx`, named for what it guards
    - Assert the TAK_Gov_Badge's `width`, `height` and `viewBox` are EXACTLY `135`, `40` and `0 0 135 40` (12.3)
    - Assert it contains NO `<text>` element (12.4) — so a later "tidy" that replaces the outlined paths with real text fails a test rather than breaking on a client with different fonts
    - Assert the page's anchor `href` SET equals the four URLs exactly, and that every anchor carries `rel="noopener"` (12.7, 12.8)
    - Assert exactly TWO Recommended_Option_Markers render, on the two named routes (12.5)
    - _Requirements: 12.3, 12.4, 12.5, 12.7, 12.8_
    - Files: `client/src/components/storeBadgeFidelity.test.jsx`
  - [x] 10.5 Write client example tests for the Downloads_Page and its reachability
    - Assert the Downloads nav item and the `/downloads` route render for a user with NO team membership and no admin role (12.9)
    - Assert the Recommended_Option_Marker's accessible name is queryable AS TEXT — not as a `title` attribute (12.6)
    - Assert the Enrollment_View renders no badge markup, so the move is asserted from both sides (12.1, 10.11)
    - `createRoot` + `act`, native event dispatch, `globalThis.React = React`
    - _Requirements: 10.11, 12.1, 12.6, 12.9_
    - Files: `client/src/pages/Downloads.test.jsx`
  - [x] 10.6 Checkpoint - Ensure all tests pass
    - Run `cd client && npx vitest --run`; run `npm test`
    - Ensure all tests pass, ask the user if questions arise.

- [x] 11. The Multiple_Certificate_Warning and the team device surface
  - **Task 11.1 must be implemented BEFORE task 9.5, even though it is numbered after it.** The Enrollment_View renders `<MultipleCertificateWarning>`, so the component has to exist first. The Task Dependency Graph orders 11.1 into an earlier wave than 9.5, following the precedent `device-management` set when task 24's revoke rails had to precede task 19.3.
  - [x] 11.1 Create the Multiple_Certificate_Warning component
    - Create `client/src/components/MultipleCertificateWarning.jsx`, rendering only when the count is STRICTLY GREATER THAN ONE (Criteria 13.1, 13.5). At exactly one or zero it renders nothing and leaves the surrounding rendering unchanged
    - **Carry the state in TEXT a screen reader announces, and include the COUNT as a number in that text** (Criteria 13.3, 13.4) — so "more than one" is a number rather than an adjective. Never an icon alone and never colour alone, following the `device-management` "Revoked" and "Expires soon" precedents (its Criteria 16.5 and 21.3)
    - **It is INFORMATION, not an error** (Criterion 13.7): it does not block enrollment, does not render as a validation failure, and does not gate a button. Several live certificates is a NORMAL state — `device-management` measured 60 on one `clientUid` — and the warning exists so the state is visible, not so it can be prevented
    - _Requirements: 13.1, 13.3, 13.4, 13.5, 13.7_
    - Files: `client/src/components/MultipleCertificateWarning.jsx`
  - [x] 11.2 Create the team device list component
    - Create `client/src/components/TeamDeviceList.jsx` rendering a Team's Team_Owned_Devices from `GET /api/devices/team/:teamId`: Device_Display_Name, Managed_Identifier, created date through `<FormattedDate>`, the `<MultipleCertificateWarning>`, and an action that opens the device's Enrollment_View
    - **No email column and no placeholder address** — a device has no email and Criterion 5.10 forbids substituting one. Where an email would be shown, show the Device_Display_Name or the Managed_Identifier instead
    - This is the surface that closes Criterion 5.9: a device is absent from every email-keyed search and every domain-scoped directory because a NULL email makes those predicates evaluate to NULL, so it must stay reachable HERE by its Device_Display_Name and its Managed_Identifier
    - Add no table with `overflow-x-auto` and no tooltip that opens vertically. Tooltips in this codebase open SIDEWAYS only (`left-full`/`ml-2` or `right-full`/`mr-2` plus `top-1/2 -translate-y-1/2`), because a box with one overflow axis `auto` clips on both. This feature inherits the rule even though it adds no such table
    - _Requirements: 5.9, 5.10, 14.7_
    - Files: `client/src/components/TeamDeviceList.jsx`
  - [x] 11.3 Add the Devices section to TeamDetail
    - In `client/src/pages/TeamDetail.jsx`, render `<TeamDeviceList>` as its own Devices section BENEATH the member list, not inside it
    - **The exclusion of Criterion 14.6 stays intact.** `production-hardening` Criterion 27.9 excludes every Team_Owned_Device from user-facing human-user counts and user lists, and this section must not reintroduce a device into those counts or that list as a side effect of making devices visible. A separate surface is the whole point (Criterion 14.7)
    - This edits the same file as task 5.5, which is why it is a separate task in a later wave
    - _Requirements: 14.6, 14.7_
    - Files: `client/src/pages/TeamDetail.jsx`
  - [x] 11.4 Write property test (render arm): certificate counts drive the warning at the right threshold
    - **Property 12: Certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries**
    - Tag exactly: `// Feature: takserver-enrollment, Property 12: Certificate counts are per-principal, non-revoked, and resolved in a fixed number of queries`
    - Vitest with `fast-check`, `numRuns >= 100`. This is the RENDER arm of Property 12; task 8.8 is the query arm. The two files carry the IDENTICAL tag deliberately: it is one property whose subject spans two runners, not two properties
    - Assert the Multiple_Certificate_Warning renders if and only if the count is strictly greater than one, and that the count itself is present in the rendered TEXT
    - **Boundary concentration:** concentrate the generated count on exactly 0, 1 and 2 — the threshold sits between the last two, and a uniform generator over a wide range would pass a `>=` where the criterion needs `>`
    - Anti-vacuity: assert at least one generated count was exactly 1 and at least one was 2 or more
    - **Validates: Requirements 13.1, 13.4, 13.5**
    - _Requirements: 13.1, 13.4, 13.5_
    - Files: `client/src/components/MultipleCertificateWarning.property.test.jsx`
  - [x] 11.5 Write client example tests for the warning and the device surface
    - Assert the warning renders at counts 2 and 5 and NOT at 0 or 1, with the count present as text in the accessibility tree (13.1, 13.3, 13.4, 13.5)
    - Assert the warning is not rendered as an error and does not disable the enrollment action (13.7)
    - Assert the team device surface lists devices with their Device_Display_Name and Managed_Identifier, renders NO email field and no `@` anywhere, and does not throw for a device with a null email (5.9, 5.10)
    - Assert the TeamDetail human member list and member count are UNCHANGED by the new section — no device appears in either (14.6)
    - Assert `GET /api/users`' `live_certificate_count` field reaches the Users view and drives the warning there too, at counts 0, 1 and 2 (13.6)
    - _Requirements: 5.9, 5.10, 13.1, 13.3, 13.4, 13.5, 13.6, 13.7, 14.6_
    - Files: `client/src/components/MultipleCertificateWarning.test.jsx`, `client/src/components/TeamDeviceList.test.jsx`, `client/src/pages/TeamDetail.test.jsx` (extend), `client/src/pages/Users.test.jsx` (extend)
  - [x] 11.6 Checkpoint - Ensure all tests pass
    - Run `cd client && npx vitest --run`; run `npm test`
    - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Final verification
  - [x] 12.1 Verify the full build, the migrations, and all fourteen properties
    - **Server:** `npm test`. Baseline is **112 suites / 2167 tests**. Counts may only GROW; nothing may go from passing to failing. 62 assertions across 8 files were deliberately updated by tasks 5.1-5.3, 6.1 and 8.3, so a CHANGED count is expected — a FAILURE is not. Spot-check that none of those updates weakened an exact-value assertion into a loose one
    - **Client:** `cd client && npx vitest --run`. Baseline is **32 files / 460 tests**
    - **Lint:** root `npm run lint` at or below **107 problems (95 errors, 12 warnings)**. State plainly that it does **not** lint `client/` — its scope is `server scripts database/*.js eslint.config.js` — so the Vitest suite is the only gate on every client file this feature added
    - **Pinned deps:** `npm run lint:pinned-deps` must pass. **No dependency was added to either tree**: `qrcode`, `fast-check` and `@fast-check/jest` are all already present (Criterion 11.3). Confirm `client/package.json` and `package.json` are unchanged
    - **Migrations:** confirm both apply AND roll back cleanly. The migration test database is on port 15433: `docker compose exec -T app npm run migrate:up` and `docker compose exec -T app npm run migrate:down`. Confirm no backtick appears inside any `pgm.sql` template literal in either file
    - **Properties:** confirm all **14** are present and passing — twelve under Jest with `@fast-check/jest`, Properties 10 and 11 under Vitest with `fast-check`, and Property 12 as two files carrying the same tag. Confirm every property file's first line carries its tag in the exact form `// Feature: takserver-enrollment, Property N: <name>` and that each runs at `numRuns >= 100`
    - **`.env.example` is UNCHANGED.** This feature adds no environment variable and reads only the already-configured `TAK_SERVER_URL` (Criterion 15.10). If a variable turned out to be necessary after all, it must be documented there with a safe default and NOT added to `REQUIRED_VARS` — but the design says none is needed, so an edit here is a signal to re-read the design rather than to document a new variable
    - Confirm `BUGS.md` BUG-009 can be closed: the client user interface `production-hardening` Requirement 27's backend never had now exists (Criterion 15.11)
    - _Requirements: 11.3, 15.10, 15.11_
  - [x] 12.2 Verify end to end against the live test Authentik, then clean up
    - The test Authentik is available, so verify the whole chain rather than inferring it from unit tests
    - Create a Team_Owned_Device end to end on a Team whose Organisation carries a prefix
    - Confirm the device's Authentik user has **no email** — check Authentik's own record, not the local row, since the local row being NULL does not prove the create body omitted the key
    - Confirm its username matches `<PREFIX>-D` followed by exactly seven characters, all drawn from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, and that the prefix segment is the Organisation's `callsign_prefix`
    - Generate its QR codes and confirm the iTAK payload's **exact key set** — `passphrase`, `type`, `serverCredentials`, `userCredentials`, with `serverCredentials` carrying only `connectionString` and `userCredentials` carrying only `username`, `password`, `registrationId` — and that `passphrase` is the string `"false"`, and that there is no `token` key at any level
    - Confirm the `connectionString` is the configured host followed by exactly `:8089:ssl`
    - Confirm the Authentik_Sync picks the device up: run a sync and confirm the local `users` row is refreshed rather than skipped, and that `user_cache` carries `is_team_device = true` with a NULL email. That is the change whose absence would be silent — without it the device works but never syncs
    - **Clean up what the check creates:** delete the `tak_devices` rows, the local `users` and `user_cache` rows, and the Authentik user and any enrollment token minted for it. Do NOT leave a test device on the shared instance
    - _Requirements: 1.1, 1.2, 4.1, 4.2, 4.3, 5.1, 5.2, 5.6_

## Notes

- Tasks marked with `*` are optional (test-only: unit, property, structural, integration and smoke tests) and can be skipped for a faster MVP; core implementation sub-tasks are not marked and must be implemented. **Updates to EXISTING assertions that the behaviour change invalidates are NOT optional** and are named in the implementing task's `Files:` line — a task that leaves the suite red is not done.
- **Never weaken an assertion to make it pass.** If an exact-value assertion has to be loosened to a matcher or a regex, that is evidence the behaviour changed in a way the spec did not intend, and the implementation is what needs revisiting. That distinction is the design's, and it applies to all 62 affected assertions.
- Each task references specific granular requirements for traceability. Requirement numbers are NOT globally unique across `.kiro/specs/` — all ten completed specs define a "Requirement 5" — so any citation added to code must name the spec: `// takserver-enrollment Requirement 5.3`.
- **This spec CORRECTS `production-hardening` Requirement 27; it does not start fresh.** Four corrections, each superseding something shipped: the `device-<uuid>` username becomes a Managed_Identifier (Correction 1, task 6.1); the synthetic `.invalid` email becomes NO email, superseding Criterion 27.2 and removing `DEVICE_EMAIL_DOMAIN` (Correction 2, tasks 2.1/3.x/6.1); the `{ host, username, token }` iTAK object becomes the payload iTAK actually parses, superseding Criterion 27.6 (Correction 3, task 7.1); and `NotATeamOwnedDeviceError` stops being a capability limit, superseding Criterion 27.5 (Correction 4, task 7.2). Per `.kiro/specs/` convention a later spec overrules an earlier one, so where the two documents conflict, this one wins.
- **`NotATeamOwnedDeviceError` is NOT deleted.** It survives on `generateEnrollmentQrCode` with a different and narrower meaning: the parameterised route's SCOPING rule (the only subject kind you may address by id is a device), not a statement about what tokens may be minted for. The two readings produce the same `throw` and completely different designs. The next reader's instinct on encountering Correction 4 will be to delete it, which is why task 7.2 requires the code comment to state which reading it is and to cite Criterion 3.3 instead of Requirement 27.
- **Three named follow-ups, deliberately out of scope**, recorded so each reads as a decision rather than an omission:
  - a periodic sweep of abandoned Claim_Rows (`users WHERE authentik_user_id IS NULL AND is_active = false AND created_at < now() - interval '1 hour'`), alongside the existing `RetentionCleanupJob`;
  - rejection sampling for `SignupCodeService.generateRandomCode`'s biased modulo draw — left alone here because fixing it changes the distribution of every future sign-up code, which is a different feature's behaviour (design decision 2);
  - automatic pseudonymous callsign generation in the WebTAK idiom (`Shadow3`, `Ghost5`), explicitly out of scope per Criterion 9.6, which is what makes the manual step Criterion 9.2 requires a deliberate decision rather than an unfinished one.
- **Four deliberate PBT omissions**, recorded so they read as decisions:
  - **Criterion 5.4's CHECK constraint** gets no property — it would be a test of PostgreSQL. Covered by integration tests over the four `(email present/null) × (is_team_device true/false)` combinations.
  - **Criterion 5.7's multiple-NULL behaviour** gets no property, for the same reason. Covered by an integration test placing two emailless devices under `users_email_key`.
  - **Criterion 1.10's statistical uniformity** gets no property. A chi-squared test of `crypto.randomInt` would measure Node and would be flaky. Property 2 asserts the checkable thing instead — the draw discipline: seven calls, each with the single argument 31, results used as indices in order.
  - **Criterion 16.5** gets no property because `device-management`'s Property 18 already quantifies over arbitrary Connection_Alias bases, including email-shaped and pseudonym-shaped ones. A second test asserting the same thing would be two tests that fail together.
- **The four PBT disciplines the design sets, carried into every property task above:**
  - **Independent re-derivation.** No property imports the subject's own table, constant list or helper to compute its expectation. Property 6 re-derives the expected payload by literal construction; Property 12 re-derives each count by filtering the generated rows in JavaScript; Property 5 writes `365 * 24 * 60 * 60 * 1000` out rather than importing `CERTIFICATE_LIFETIME_DAYS`. **The ONE named exception is Property 1's alphabet-membership clause**, which asserts against `AMBIGUITY_FREE_ALPHABET` — the subject's own table — because the alternative is a test that re-types 31 characters and agrees with itself about a typo. Its exclusion clause carries the real assertion and is asserted against the separately declared `EXCLUDED_AMBIGUOUS_CHARACTERS`. Do not extend the exception anywhere else.
  - **Boundary concentration.** Property 3 concentrates on exactly four and exactly five consecutive failures; Property 10 on `0`, `±1`, `999`/`1000`, `59999`/`60000`; Property 12 on per-principal counts of exactly 0, 1 and 2; Property 7 on depth 0 (where root and leaf coincide, so a tail read passes) and depth 2+ with disagreeing values.
  - **Anti-vacuity.** Each property asserts its generator actually produced the case it exists to test: Property 3 that a run reached the fifth attempt and a run propagated a non-qualifying error; Property 12 that a principal had 2+ rows and another exactly 1; Property 7 that a chain's root disagreed with its leaf; Property 6 that a generated host contained a colon.
  - **Totality generators.** Properties 9, 10 and 11 draw from a shared totality generator: `null`, `undefined`, `NaN`, `Infinity`, `-Infinity`, `0`, `-0`, empty and whitespace strings, numbers, booleans, `Symbol()`, `BigInt`, arrays, `Object.create(null)`, and objects whose `valueOf` and `toString` throw. Property 4's request generator additionally includes `__proto__` and `constructor`, since a subject resolution that reaches into a request object by key name is a prototype-pollution surface.
- **Traps that cost a defect if missed**, each stated at its own task rather than only here:
  - `{ email: undefined }` and an absent key are indistinguishable in the object and identical after `JSON.stringify` — verified. So the "a device's Authentik create body carries no email" assertion must check the SERIALIZED form as well as the object (task 6.1).
  - `computeDefaultCallsignSuffix` has THREE callers, not one; Criterion 9.3's "single place" premise is false. Consolidate the approval path first, then suppress, and allow-list the preview explicitly (tasks 5.2, 5.3, 5.8).
  - The Claim_Row's compensating DELETE must carry `AND authentik_user_id IS NULL` (task 6.1).
  - The mint's retry must match the constraint by EQUALITY, not `includes()` (task 1.5).
  - `authentikSync.js` needs three changes plus a comment correction, and the first one is why a Team_Owned_Device would otherwise never sync at all (task 3.3).
  - Never build a single `generateEnrollment(subjectId = actingUser.userId, …)` (task 7.2).
  - `device:read:team_admin` must stay OUT of `roleDefaults` (task 8.4).
  - `Team.isAdmin` takes `req.user.userId`, never `req.user.id` (task 8.5).
  - No backtick inside any `pgm.sql` template literal (tasks 2.1, 2.2).
  - Client tests have no `@testing-library/react` (tasks 5.9, 9.9, 10.5, 11.5).
- **Four things reach outside this feature's own surface and belong on the review list:**
  1. `server/services/authentikSync.js` — three line changes and one comment correction, on the shared sync path for every user.
  2. `resolveCallsignSuffixForNewUser` is REMOVED and all four creation paths move to `resolveNewUserIdentity`, taking `RequestApprovalService`'s private copy of the default computation with it. That is a change to the shared provisioning path of every user this application creates.
  3. `server/config/logger.js` gains five redaction paths, affecting every log line carrying a field named `key`. Review it as a small blast-radius change with a small benefit, NOT as the thing that protects the token.
  4. `server/services/SignupCodeService.js` loses its local alphabet literal and has a wrong comment corrected; its biased modulo draw is deliberately left alone. A reviewer should confirm that leaving it is the intended reading rather than an oversight.
- Requirement 16 is out of scope for implementation and in scope for the design: no display-layer suppression, rewriting or filtering of a CloudTAK certificate's Common_Name or `clientUid` is added anywhere (Criterion 16.3, design decision 19). The email is in TAK Server's certificate inventory and in the CoT uid regardless of what this application renders, so a display-layer change would manufacture a false impression of pseudonymity. The limitation is surfaced to the operator at the moment the policy is chosen (task 5.5) and asserted absent by a structural check (task 8.11).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.2", "3.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "2.3", "3.2", "4.2", "5.4"] },
    { "id": 2, "tasks": ["1.3", "1.4", "1.5", "3.3", "4.3"] },
    { "id": 3, "tasks": ["1.6", "1.7", "3.4", "5.1"] },
    { "id": 4, "tasks": ["5.2", "5.5", "6.1"] },
    { "id": 5, "tasks": ["5.3", "5.6", "5.7", "6.2", "7.1"] },
    { "id": 6, "tasks": ["5.8", "5.9", "7.2", "7.3"] },
    { "id": 7, "tasks": ["7.4", "7.5", "7.6", "8.1", "8.2"] },
    { "id": 8, "tasks": ["8.3", "8.4", "8.5", "8.6", "9.1", "9.2"] },
    { "id": 9, "tasks": ["8.7", "8.8", "8.9", "8.10", "8.11", "9.3", "9.4", "11.1"] },
    { "id": 10, "tasks": ["9.5", "9.7", "9.8"] },
    { "id": 11, "tasks": ["9.6", "9.9", "10.1", "11.2"] },
    { "id": 12, "tasks": ["10.2", "11.3"] },
    { "id": 13, "tasks": ["10.3", "10.4", "11.4", "11.5"] },
    { "id": 14, "tasks": ["10.5"] }
  ]
}
```

Checkpoint tasks (1.8, 2.4, 3.5, 4.4, 5.10, 6.3, 7.7, 8.12, 9.10, 10.6, 11.6) and the two final-verification tasks (12.1, 12.2) are not in the graph: they gate a section rather than write code, and they run after every wave their section's tasks occupy.

The wave boundaries are driven by two things — the real bottom-up dependency the ordering constraint sets out, and the same-file rule.

**Same-file splits.** `server/services/DeviceEnrollmentService.js` is written by FOUR tasks and therefore occupies four waves: 6.1 (the Claim_Row re-phasing, wave 4), 7.1 (the builders and the private core, wave 5), 7.2 (the two public entry points, wave 6) and 8.2 (`listTeamDevices`, wave 7). Their order is not arbitrary either: the core cannot be built before the constructor it shares a class with is correct, the entry points need the core, and the listing needs the shape the entry points settled. `server/routes/teams.js` is written by 4.1 (prefix required) and 5.4 (the policy column), so those never share a wave. `server/routes/users.js` is written by 5.3 (the resolver wiring) and 8.6 (the certificate-count join) — waves 5 and 8. `client/src/components/TeamFormDialog.jsx` is written by 4.2 and 5.5; `client/src/pages/TeamDetail.jsx` by 5.5 and 11.3; `client/src/components/Layout.jsx` and `client/src/App.jsx` by 9.6 and 10.3; `client/src/pages/TeamDetail.test.jsx` by 5.9 and 11.5. Every one of those pairs is in separate waves.

**Two orderings that are not obvious from the numbering.**

- **11.1 lands in wave 9, BEFORE 9.5 in wave 10.** The Enrollment_View renders `<MultipleCertificateWarning>`, so the component must exist first. The numbering follows the ordering constraint's grouping (the warning belongs with the team device surface) rather than the build order, exactly as `device-management` kept task 24's revoke rails numbered after task 19 while ordering them before it.
- **5.2 lands in wave 4, BEFORE 5.3 in wave 5.** The approval path's private copy of the default computation is consolidated before any creation path relies on the suppression. Reversing them would leave a member self-signing-up into a Pseudonymous_Organisation with a name-derived callsign — the exact defect Requirement 9 prevents — on the commonest path, while every other path looked correct.

**The bottom-up spine.** Wave 0 is the alphabet, both migrations, the email normaliser and the prefix enforcement — five independent files with no consumers. 1.2 (wave 1) needs 1.1's alphabet; 1.5 (wave 2) needs 1.2's generator; 5.1 (wave 3) needs 1.5's mint; 6.1 (wave 4) needs it too. 3.3 (wave 2) needs both 3.1's normaliser and 2.1's migration, since removing the `if (user.email)` guard is only safe once the columns are nullable and the CHECK constraints exist. On the client, 9.3 needs 9.1's formatter, 9.5 needs 9.2/9.3/9.4/11.1, 10.2 needs 10.1's badges, 10.3 needs 10.2's page, 10.5 needs 10.3's nav item, and 11.2 needs 11.1's warning.

**Test tasks trail their subjects.** Each property and example task sits in a wave after the code it asserts: 1.3/1.4 after 1.2, 1.6 after 1.5, 3.2 after 3.1, 5.6/5.7 after 5.1, 5.8 after 5.3 (the guard's allow-list is only correct once all four paths are wired), 7.4/7.5/7.6 after 7.2, 8.7-8.11 after 8.1-8.6, 9.7/9.8 after 9.1/9.2, 9.9 after 9.5, 10.4 after 10.2, and 11.4/11.5 after 11.2/11.3.
