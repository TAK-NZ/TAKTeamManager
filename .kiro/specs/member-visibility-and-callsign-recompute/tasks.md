# Implementation Plan: Member Visibility and Callsign Recompute

## Overview

Two defects that share no file, sequenced so each ships on its own and the reporting user's visible fix arrives as early as possible.

**Group A — Defect 1, the Callsign_Suffix recompute (tasks 1–5).** Entirely Client-side. The design establishes that `POST /api/users/callsign-suffix-preview` and `UserProvisioningService.resolveCallsignSuffixForNewUser` are already correct, so this half needs no migration, no schema change, no route change, and no authorization change. The pure state-machine module and its property tests land first (task 1), so the component rewiring in task 3 is verified against logic that already passes. Task 4 is a **test-only** task that pins the server's existing behaviour. After task 5 this half is complete and shippable with none of Group B existing.

**Group B — Defect 2, Organisation scoping (tasks 6–12).** The pure predicate and scope construction land first (task 6), then the DB-reading resolver (task 7), then `GET /api/users/available` — the route the user actually reported (task 9), then `/search` and `/users` (task 10), then the Client's empty-list explanation (task 11). Requirement 9's fail-closed branch is isolated in task 8 and is **not** a prerequisite for anything around it.

**Group C — `users.origin_org_id` provenance (task 13).** Last, as its own group, because it needs a migration and because the design makes provenance **additive** to Email_Domain matching. Domain scoping is fully functional without it. No task in Groups A or B may depend on the column: `CandidateFacts.originOrgId` is nullable by design, so tasks 9 and 10 pass `null` and omit the `origin_org_id` term from their SQL, and task 13.6 adds the projection and the SQL disjunct once the column exists. Nothing earlier changes behaviour when it arrives.

Language: JavaScript — CommonJS on the server, JSX/ESM on the Client — matching the existing codebase and the design's code blocks.

Conventions every task below inherits:

- Server tests are Jest; Client tests are Vitest.
- Server property tests use `@fast-check/jest`'s `test.prop([...], { numRuns: 100 })`. Client property tests use raw `fc.assert(fc.property(...), { numRuns: 100 })` inside a normal `it`, matching `client/src/utils/callsignLevels.test.js`. **No new dependency is added on either side** — `@fast-check/jest` 2.2.0 and `fast-check` 4.9.0 are already devDependencies, and `@fast-check/vitest` is deliberately not introduced.
- Every property test carries the tag comment `// Feature: member-visibility-and-callsign-recompute, Property N: <property statement>` immediately above it.
- Exactly one property-based test implements each of Properties 1–19. No property is split across tests; no test covers two.
- Property tests compute the expected value by walking the generated data directly, never by calling back into the code under test (`server/services/TeamVisibilityService.test.js` Property 9 is the model).
- `UserProvisioningService.resolveCallsignSuffixForNewUser`'s precedence rule (`trimmedRequested || computeDefault(...)`) is **not modified by any task**. It is correct: a Team_Admin who types a suffix must receive it. Defect 1 is fixed by the Client stopping sending a value it invented.
- `server/config/permissions.registry.js`, `server/middleware/authorize.js`'s `rowScopedResolvers` map, and the exception lists in `server/config/permissions.registry.test.js` are **unchanged by every task**. No new route and no new permission identifier is introduced.
- `*.integration.test.js` files are excluded from `npm test` by `testPathIgnorePatterns` and need a live Postgres. Run them explicitly against the local container `tak_migration_test_501` on `localhost:15433` using the `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` defaulting convention already at the top of `server/routes/requests.approval.integration.test.js`, e.g. `npx jest server/routes/users.directoryScope.integration.test.js --testPathIgnorePatterns=/node_modules/ /client/`.
- After every task the repository must be left green: `npm test -- --coverage` (60 percent statement gate), `npm run lint`, `npm run lint:pinned-deps`, and the Client Vitest suite.

## Tasks

- [x] 1. Callsign_Suffix state machine (pure Client module)
  - [x] 1.1 Create `client/src/utils/callsignSuffixPreview.js` with the three-state constants and the request-body builders
    - Create the module following the pure-function convention of `client/src/utils/callsignLevels.js` and `channelTree.js`: no React import, no API import
    - Export `SUFFIX_ORIGIN` (`NONE`/`AUTO`/`TYPED`), `CONFLICT_FALLBACK_MESSAGE`, `USER_DEFINED_HELP_TEXT`, and the `NewUserFormState` typedef from the design
    - Export `initialNewUserFormState()` — the state a freshly opened Add_Member_Dialog holds: empty `email`/`firstName`/`lastName`/`suffix`, `origin` of `NONE`, `required` false, `error` null, `inFlight` 0, `latestSeq` null, `pendingRequest` null
    - Export `shouldSendCallsignSuffix(state, { force })` returning true **only** for a non-empty `TYPED` origin on a non-forced request. This one function is the whole fix for Defect 1
    - Export `buildSuffixPreviewBody(state, { teamId, force })`, returning `null` when either name's trimmed value is empty, and otherwise a body carrying the **current** `firstName`/`lastName`/`teamId` and including `callsignSuffix` only per `shouldSendCallsignSuffix`
    - Export `buildCreateAndAddSuffixArgument(state)` returning the trimmed value or `undefined`, delegating to the same `shouldSendCallsignSuffix` so the two bodies cannot drift
    - Export `isRecomputeDisabled(state)`, `selectSuffixBusy(state)` (`state.inFlight > 0`), and `shouldApplyPreviewResponse(state, seq)` (`seq === state.latestSeq`, false once `latestSeq` is null)
    - _Requirements: 2.3, 2.6, 2.7, 3.1, 3.2, 3.3, 3.7, 5.3, 6.3, 6.6, 7.1, 7.5, 7.6_

  - [x] 1.2 Implement `applyPreviewResponse` in `client/src/utils/callsignSuffixPreview.js`
    - Successor to `decideCallsignSuffixPreview`, whose two-valued `manuallyEdited` argument becomes the three-valued origin
    - Branches in the design's order: a missing or non-object response returns the state unchanged; `required === true` sets `{ required: true, error: null }` and leaves `suffix` and `origin` untouched; a non-null `conflict` sets the error to `conflict.message` or the fallback and writes `conflict.value` **only** where it is a non-empty string differing from the current value; otherwise sets `{ required: false, error: null }` and writes `response.suffix` when `force` is true or the origin is not `TYPED`
    - Origin becomes `AUTO` exactly when the function writes a value into the field, **plus** the `force`-and-already-equal case, so a Recompute over a typed value that matches the Computed_Suffix still resumes tracking later name edits
    - _Requirements: 1.7, 2.4, 2.5, 3.4, 4.1, 4.2, 4.3, 4.4, 6.4, 7.3_

  - [x] 1.3 Implement `newUserFormReducer` in `client/src/utils/callsignSuffixPreview.js`
    - Actions exactly as the design's table: `reset` (initial state with `nextSeq` **preserved**, `latestSeq` null, `inFlight` 0), `fieldChanged`, `suffixEdited` (origin `TYPED` for a non-empty trimmed value, `NONE` for an empty one, error cleared), `previewRequested` (`trigger` of `names`/`suffix`/`recompute`, `force` when `recompute`, clears the error when forced, builds the body and — only when non-null — assigns `seq`, bumps `nextSeq`, sets `latestSeq`/`latestForce`, increments `inFlight`, sets a fresh `pendingRequest` object), `previewSettled` (decrement `inFlight` clamped at 0, clear `pendingRequest` only on the matching seq, apply the payload only per `shouldApplyPreviewResponse`), `previewFailed` (decrement `inFlight`, change nothing else), `submitRejected`
    - `nextSeq` is never reset, so a stale response from a previous dialog session can never carry a seq matching a fresh request
    - `latestForce` lives in state, not on the settle action
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.8, 3.5, 3.6, 3.7, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x] 1.4 Write reducer-sequence and example tests
    - Create `client/src/utils/callsignSuffixPreview.test.js`
    - Reducer sequences for Requirements 15.3–15.8: an auto-fill then a First Name edit then a names blur yields a field value derived from the new First Name; a typed value is sent as `callsignSuffix` and survives its response; the Recompute_Control's request omits `callsignSuffix` and its response replaces the value; a `required` response disables the control and leaves a typed value alone; an out-of-order response is discarded; a failure changes nothing and leaves submission permitted
    - Examples for Requirements 2.8, 3.7, 6.2, 7.1, 7.7, plus the `applyPreviewResponse` cases inherited from the `decideCallsignSuffixPreview` block being removed from `client/src/pages/TeamDetail.test.jsx` in task 3.5
    - _Requirements: 15.3, 15.4, 15.5, 15.6, 15.7, 15.8_

  - [x] 1.5 Write property test for the recompute reflecting the current names
    - In `client/src/utils/callsignSuffixPreview.test.js`, over two name pairs with distinct Computed_Suffix values and any Callsign_Name_Format other than `user_defined`
    - **Property 1: A recompute reflects the current names**
    - **Validates: Requirements 1.6, 1.7, 3.1, 15.1**
    - **This is one of the two assertions whose absence let these defects ship three times.** It is the property that fails on today's code. Write it before task 3 so the rewiring is verified against a passing assertion
    - _Requirements: 15.1_

  - [x] 1.6 Write property test for the two request bodies agreeing and never echoing
    - In `client/src/utils/callsignSuffixPreview.test.js`, over the full cube of field value, origin, and `force`
    - **Property 2: No auto-filled value is ever echoed, and both bodies agree**
    - **Validates: Requirements 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 5.3**

  - [x] 1.7 Write property test for recompute idempotence
    - In `client/src/utils/callsignSuffixPreview.test.js`
    - **Property 3: A recompute is idempotent**
    - **Validates: Requirements 1.6, 2.5**

  - [x] 1.8 Write property test for a typed suffix surviving
    - In `client/src/utils/callsignSuffixPreview.test.js`, over arbitrary sequences of name edits, blurs, and arriving responses including `required` of `true`
    - **Property 4: A typed suffix is preserved until it is deliberately discarded**
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.5, 6.4**

  - [x] 1.9 Write property test for when a preview is issued
    - In `client/src/utils/callsignSuffixPreview.test.js`, over every trigger and over keystroke actions
    - **Property 11: A preview is issued exactly when both names are present**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5**

  - [x] 1.10 Write property test for the Recompute_Control's disabled condition
    - In `client/src/utils/callsignSuffixPreview.test.js`, including the no-response-yet state
    - **Property 12: The Recompute_Control is disabled exactly on its three conditions**
    - **Validates: Requirements 2.6, 2.7, 6.3, 6.6**

  - [x] 1.11 Write property test for out-of-order and post-reset responses
    - In `client/src/utils/callsignSuffixPreview.test.js`, over arbitrary arrival permutations with a reset injected at any point
    - **Property 13: Only the most recently issued preview's response is applied**
    - **Validates: Requirements 7.5, 7.6**

  - [x] 1.12 Write property test for a failed preview being a no-op
    - In `client/src/utils/callsignSuffixPreview.test.js`
    - **Property 14: A failed preview is a no-op**
    - **Validates: Requirements 7.3, 7.4**

  - [x] 1.13 Write property test for conflict handling
    - In `client/src/utils/callsignSuffixPreview.test.js`
    - **Property 16: A conflict writes only a value that differs**
    - **Validates: Requirements 3.4, 4.3, 5.5**

- [x] 2. Checkpoint - pure callsign logic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Rewire the Add_Member_Dialog to the state machine
  - [x] 3.1 Replace the four `useState` hooks with one `useReducer` in `client/src/pages/TeamDetail.jsx`
    - Collapse `newUserForm`, `newUserCallsignRequired`, `newUserCallsignError`, and `newUserCallsignEdited` into `useReducer(newUserFormReducer, undefined, initialNewUserFormState)`; `email` moves into the reducer with the names and the suffix
    - Delete `runCallsignSuffixPreview`, `resetNewUserForm`, and `decideCallsignSuffixPreview` together with its export — `newUserCallsignEdited` is the two-valued flag this spec exists to replace, and leaving either in place leaves two answers to "may I overwrite this field"
    - Keep `addingMember` as its own `useState`: it is shared with the "Add Existing User" tab
    - Leave `isValidMemberCallsignSuffix`, `getInitialMemberEditForm`, `extractCallsignSuffixServerError`, `formatCallsignLevels`, and the Member_List edit row untouched
    - _Requirements: 3.1, 3.2, 3.7_

  - [x] 3.2 Add the single request-issuing effect in `client/src/pages/TeamDetail.jsx`
    - `React.useEffect` keyed on `newUserFormState.pendingRequest` identity, returning early when null, calling `usersAPI.previewCallsignSuffix(pending.body)` and dispatching `previewSettled` on resolve and `previewFailed` on reject after a `console.error`
    - **No cleanup function, no `cancelled` flag, and no `AbortController`.** Every settled request must dispatch so `inFlight` decrements; the reducer decides whether to apply. An abort would also produce a rejection indistinguishable from a genuine failure, which Requirement 7.3 treats differently from a superseded response
    - _Requirements: 7.1, 7.3, 7.5_

  - [x] 3.3 Add the Recompute_Control and the busy indication to the dialog JSX in `client/src/pages/TeamDetail.jsx`
    - Render the Recompute_Control adjacent to the Suffix_Field with **`type="button"`** — it sits inside `<form onSubmit={handleCreateNewUser}>`, where a button with no explicit type defaults to `submit`, so omitting it would create the user instead of recomputing the suffix
    - `onClick` dispatches `previewRequested` with `trigger: 'recompute'`; `disabled={isRecomputeDisabled(newUserFormState)}`; `aria-label` and `title` both stating that it recomputes the callsign suffix from the entered names; `ArrowPathIcon` added to the existing `@heroicons/react/24/outline` import
    - Render the busy indication as a `role="status" aria-live="polite"` element gated on `selectSuffixBusy(newUserFormState)`
    - The Suffix_Field and the submit control **must not** gain `disabled={selectSuffixBusy(...)}` — both stay operable while a preview is in flight
    - First Name and Last Name `onBlur` dispatch `trigger: 'names'`; the Suffix_Field's `onBlur` dispatches `trigger: 'suffix'`; no `onChange` dispatches a preview
    - Dispatch `{type:'reset'}` on dialog **open** in both the "Add Member" and "Add Admin" button handlers, in addition to the existing close-time and post-create resets, so a cancelled half-filled form does not reappear with a stale suffix
    - Render the `required` statement and the inline error from reducer fields
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.6, 2.7, 3.7, 6.2, 6.3, 7.1, 7.2_

  - [x] 3.4 Wire submission through the shared body builder in `client/src/pages/TeamDetail.jsx`
    - `handleCreateNewUser` keeps its client-side character-class check, then calls `usersAPI.createAndAdd(..., buildCreateAndAddSuffixArgument(newUserFormState))` — `undefined` is dropped by `JSON.stringify`, so no change to `client/src/services/api.js` is needed
    - Map a shaped 400 through the unchanged `extractCallsignSuffixServerError` into `{type:'submitRejected'}`, keeping the dialog open
    - Rewrite the submit button's existing `disabled` expression to read reducer fields and nothing else
    - Keep the success toast reporting the suffix the server actually assigned
    - _Requirements: 5.3, 7.2, 7.7_

  - [x] 3.5 Rewrite the affected assertions in `client/src/pages/TeamDetail.test.jsx`
    - Remove the `decideCallsignSuffixPreview` import and its `describe` block; its cases are re-expressed against `applyPreviewResponse` in task 1.4
    - Rewrite the source-contract assertions naming `onBlur={() => runCallsignSuffixPreview(newUserForm)}`, `required={newUserCallsignRequired}`, `{newUserCallsignError && (`, `newUserForm.callsignSuffix || undefined`, and `if (!isValidMemberCallsignSuffix(newUserForm.callsignSuffix)) {` against the new dispatch calls and reducer selectors, preserving each one's intent: the blur wiring exists, the change handler does not preview, the error is a `role="alert"`, the suffix reaches the API call, and the character-class check sets an inline error rather than a toast
    - Add source-contract assertions for the two traps and the new surface: the Recompute_Control carries **`type="button"`** and an `aria-label`; its `disabled` reads `isRecomputeDisabled`; neither the Suffix_Field's nor the submit button's `disabled` expression mentions `selectSuffixBusy`; the busy indicator is gated on `selectSuffixBusy`; both dialog-open handlers dispatch `{type:'reset'}`
    - Leave the `TransferMemberDialog`, depth, badge, and Member_List assertions untouched
    - _Requirements: 2.1, 2.2, 3.7, 7.1, 7.2_

- [x] 4. Pin the server preview route's existing correctness (tests only — no implementation)
  - [x] 4.1 Write property test for the checked value being the assigned value
    - Extend `server/routes/users.callsignPreview.test.js`, driving the preview handler and the create-and-add handler over the same generated body with `UserProvisioningService.createAndAddUser` spied, and comparing the reported `suffix` / `conflict.value` against the `callsign_suffix` argument the spy received — calling `resolveCallsignSuffixForNewUser` twice would assert nothing
    - **Property 5: The checked value is the assigned value**
    - **Validates: Requirements 5.1, 5.2, 5.5**

  - [x] 4.2 Write the read-only and `user_defined` regression examples
    - In `server/routes/users.callsignPreview.test.js`: one assertion that handling a preview issues no `INSERT`, `UPDATE`, `DELETE`, no `BEGIN`, and no Authentik request; re-run the two existing `user_defined` response-shape assertions unchanged as regression guards
    - **No production code changes in this task.** `resolveCallsignSuffixForNewUser`'s `trimmedRequested || computeDefault(...)` precedence is correct and explicitly out of scope — "fixing" it would remove a Team_Admin's ability to choose their own suffix
    - _Requirements: 5.1, 5.2, 5.5, 5.6, 6.1, 6.5_

- [x] 5. Checkpoint - Defect 1 complete and independently shippable
  - Ensure all tests pass, ask the user if questions arise.
  - Nothing in tasks 6 onward is required for this half to ship.

- [x] 6. Directory scope predicate (pure server module)
  - [x] 6.1 Create `server/utils/directoryScope.js` with the predicate and scope construction
    - No `require` of `pool`, no logger, no `async` — this file is what makes Properties 6, 7 and 8 unit-level assertions
    - Export the `ScopedOrganisation`, `DirectoryScope` and `CandidateFacts` typedefs from the design; `CandidateFacts.originOrgId` is nullable and stays unused until task 13
    - Export `extractEmailDomain(email)` using `lastIndexOf('@')` — the substring after the **final** `@`, lowercased, `null` when absent — and `normaliseDomain(value)`
    - Export `buildDirectoryScope({ organisations, allowedDomains, excludedDomains })`, flattening every usable Allowed_Domain of every Organisation into one lowercased `Set` with Excluded_Domains subtracted case-insensitively, and setting `domainsConfigured` from the surviving set's size
    - Export `isCandidateVisible(scope, facts)` as a **disjunction** over the three conditions in the design's flowchart, in that order, so a non-null `originOrgId` outside scope falls through to the domain check rather than short-circuiting to hidden. The function must be **total**: a `null`, `''`, or `@`-less email, an `undefined` origin, and an empty `organisationIds` each yield `false` and never throw — a throwing predicate inside a `.filter()` would surface as a 500 and invite a catch that falls back to unfiltered
    - Export `partitionCandidates(scope, rows, toFacts)` returning `{ visible, excludedCount }`, so routes keep their own row shapes
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.7, 9.4, 11.3, 12.1, 12.3, 12.4, 13.6, 13.7, 13.8_

  - [x] 6.2 Implement the LIKE-pattern builder as the single producer in `server/utils/directoryScope.js`
    - Export `escapeLikePattern(value)` escaping `\`, `%` and `_`, and `buildEmailDomainLikePatterns(scope)` emitting one `%@domain` pattern per usable Allowed_Domain through that helper
    - **This must be the only producer of these patterns.** `org_allowed_domains.domain` is admin-supplied text; a domain containing `_` would match any single character in that position and one containing `%` would match arbitrarily, widening visibility. No route may build a pattern by string concatenation at the call site
    - Return `[]` for an empty scope — `x LIKE ANY('{}')` is `false`, which is the fail-closed value with no special case at the call site, so Postgres's default `\` escape character means no `ESCAPE` clause is needed
    - _Requirements: 8.3, 9.2_

  - [x] 6.3 Create the scoping arbitraries fixture module
    - Create `server/services/__fixtures__/directoryScopeArbitraries.js` exporting `domainArb` (lowercase, mixed-case variants of the same domain, domains containing `_` and `%`, and suffix-overlapping pairs such as `example.com` / `evil-example.com`), `emailArb(domains)` (a listed domain, an unlisted domain, multiple `@`, no `@`, `''`, `null`), `allowedDomainRowsArb(hierarchy, domains)` (including the same domain under two Organisations and Organisations with no rows), `excludedDomainsArb(domains)`, and `candidateArb(hierarchy, domains)` emitting `{email, originOrgId, directMembershipOrgId}` with the three fields varied **independently** so all eight presence combinations occur
    - Reuse `hierarchyArb` and `adminPlacementArb` from `server/services/__fixtures__/transferArbitraries.js` rather than duplicating them; use `hierarchyArb`'s `minOrganisations` option to reach the multi-Organisation caller and the shared-domain case
    - A separate module rather than growing `transferArbitraries.js`, which is the team-member-transfer fixture set consumed by six of its test files
    - Required by Properties 6, 7, 8, 10, 15, 17 and 19 — land it before those tests
    - _Requirements: 8.6, 12.4, 13.6, 13.7, 13.8_

  - [x] 6.4 Write property test for no cross-organisation disclosure
    - Create `server/utils/directoryScope.test.js`, computing the expected visible set by walking the generated hierarchy and domain rows directly
    - **Property 6: No cross-organisation disclosure**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.7, 11.1, 11.2, 12.1, 12.3, 12.4, 13.6, 13.7, 13.8, 15.2**
    - **This is the second of the two assertions whose absence let these defects ship.** The independent generation of `email`, `originOrgId` and `directMembershipOrgId` is what distinguishes the additive disjunction of Requirement 13.8 from a chain of `else if`s
    - _Requirements: 15.2_

  - [x] 6.5 Write property test for the Global_Manager superset
    - In `server/utils/directoryScope.test.js`, over any Database state and each of the three Directory_Routes
    - **Property 8: A Global_Manager's view is a superset**
    - **Validates: Requirements 9.8, 10.1, 10.2, 10.3, 12.2**

  - [x] 6.6 Write the edge-shape and escaping examples
    - In `server/utils/directoryScope.test.js`: `extractEmailDomain` over an address with no `@`, with multiple `@`, `null`, and `''`; `escapeLikePattern` over each of `\`, `%` and `_`; `buildEmailDomainLikePatterns` returning `[]` for an empty scope
    - _Requirements: 8.3, 8.7_

- [x] 7. `DirectoryScopeService` (the only DB reader in the scoping half)
  - [x] 7.1 Create `server/services/DirectoryScopeService.js` with `resolveScope`
    - Frozen `UNSCOPED` sentinel; `resolveScope(user)` returns it for a Global_Manager, read from the request user's cached `is_global_manager` attribute exactly as the existing `user:read:team_admin` resolver does, with no re-query, so the authorization layer and the scoping layer cannot disagree
    - Q1 — Scoped_Organisations via the design's recursive CTE with `role = 'admin' AND inherited_from_team_id IS NULL` and `UNION` (not `UNION ALL`), selecting the `parent_team_id IS NULL` row. **Never** read an Organisation positionally from the tail of `Team.getAncestorChain`: that function returns rows root-first, so `ancestors[ancestors.length - 1]` (as used at `server/routes/users.js` lines 626 and 1273) is the deepest row, not the root
    - Returning `[]` from Q1 short-circuits Q2 and Q3 entirely
    - Q2 — `SELECT domain FROM org_allowed_domains WHERE org_id = ANY($1::int[])`; Q3 — `SELECT config_value FROM system_config WHERE config_key = 'excluded_email_domains'`, parsed defensively so a missing row, malformed JSON, or a non-array all mean "no exclusions"
    - Hand the raw rows to `buildDirectoryScope`; construct no domain list, pattern, or org id list anywhere else
    - **Add no `catch` and no fallback to `UNSCOPED`.** A throw must propagate to the route's existing handler and produce a 500 — a database failure while resolving who the caller may see must never resolve to "everyone"
    - Also update the `user:read:team_admin` resolver's doc comment in `server/middleware/authorize.js` to point at `DirectoryScopeService`; its current claim that per-row narrowing is "still open" and "needs organisation provenance on `users`, which does not exist yet" becomes false and would invite the next reader to close the hole a second time somewhere else. **No resolver map change, no registry change, no behaviour change**
    - _Requirements: 8.4, 8.5, 8.6, 9.4, 10.1, 10.4_

  - [x] 7.2 Add the shared CTE, the response fragment, and the log line to `server/services/DirectoryScopeService.js`
    - `TEAM_ROOT_CTE` as exported SQL text mapping every `teams.id` to its Organisation's id, shared verbatim by `/search` and by `GET /api/users`' existing `team_root` CTE, so "the root of the Ancestor_Chain" has one definition on the server
    - `buildScopeResponse(scope)` returning `{ domainsConfigured, organisations }`, never called for `UNSCOPED`
    - `logScopedResponse(route, { userId, scope, excludedCount, returnedCount })` emitting through `getLogger()` from `server/middleware/requestContext`, reducing `organisations` to ids inside the function so a caller cannot pass names in by accident. **Ids and counts only** — no email, no first or last name, no domain list
    - _Requirements: 9.3, 9.8, 14.1, 14.2, 14.3_

  - [x] 7.3 Write property test for Scoped_Organisations resolution
    - Create `server/services/DirectoryScopeService.test.js`, using `hierarchyArb` and `adminPlacementArb` with rows at any depth, any role, and any `inherited_from_team_id`
    - **Property 15: Scoped_Organisations are the roots of the administered chains**
    - **Validates: Requirements 8.5, 8.6**

  - [x] 7.4 Write property test for the scope response object
    - In `server/services/DirectoryScopeService.test.js`
    - **Property 17: The scope object reports the domain configuration it was built from**
    - **Validates: Requirements 9.3, 9.4**

  - [x] 7.5 Write the resolver examples
    - In `server/services/DirectoryScopeService.test.js`: an empty Q1 issues exactly one query; a Global_Manager issues none at all and reads only the cached attribute; the log line's key set matches Requirement 14 and its serialised form contains no candidate email or name even when the response holds both; a rejecting pool propagates rather than yielding `UNSCOPED`
    - _Requirements: 9.2, 10.4, 14.1, 14.2, 14.3_

- [x] 8. Fail-closed behaviour for an Organisation with no configured domains
  - **Direction pending the reporting user's confirmation recorded in `requirements.md`.** Implemented as written: an empty list plus a `scope` object explaining why. Reversing it to fail-open changes only this one branch, Property 7's statement, and Requirement 15.9's first assertion — nothing else in this task list moves, and no task depends on this one
  - [x] 8.1 Return the empty scope rather than `UNSCOPED` in `server/services/DirectoryScopeService.js`
    - At the single point where `buildDirectoryScope` has produced a scope whose `domainsConfigured` is `false`, return that scope. Every empty-set consequence then follows from `x = ANY('{}')` and `x LIKE ANY('{}')` both being `false`
    - Ship **no** `FAIL_CLOSED` flag and no unreachable `else`. A fail-open reversal is a one-line edit at this named location (`return DirectoryScopeService.UNSCOPED`)
    - _Requirements: 9.1, 9.2_

  - [x] 8.2 Write property test for failing closed
    - In `server/utils/directoryScope.test.js`, over an empty Scoped_Organisations set and over a set whose every Allowed_Domain is subtracted by Excluded_Domains, with candidates carrying no matching provenance
    - **Property 7: Fail closed on an unconfigured organisation**
    - **Validates: Requirements 9.1, 9.2**

- [x] 9. Scope `GET /api/users/available` (the reported route)
  - [x] 9.1 Add the `candidates` CTE with the scope predicate ahead of the `LIMIT` in `server/routes/users.js`
    - Rewrite the query to the design's shape: a `candidates` CTE holding the existing filters (`tm.user_id IS NULL`, `uc.is_active = true`, non-empty email and first name, the `::text` cast on the `user_cache`→`users` join) **plus** the `in_scope` expression, then a `counted` CTE, then the outer `SELECT ... WHERE in_scope ORDER BY first_name, last_name LIMIT 50`
    - **The scope predicate must sit inside `candidates`, before the `LIMIT`.** Filtering after `LIMIT 50` would let 50 out-of-scope rows consume the whole page and return an empty list while dozens of in-scope users existed — a completeness bug that looks exactly like Requirement 9's deliberate empty list and would be misdiagnosed as it
    - Wrap **every** scope sub-expression individually in `COALESCE(..., false)`: `NULL = ANY(...)` is `NULL` and `NOT NULL` is `NULL`, which a `WHERE` treats as not-true but which silently under-counts in `COUNT(*) FILTER (WHERE NOT in_scope)`
    - `COUNT(*) FILTER (WHERE NOT c.in_scope) OVER ()` computed over the whole candidate set, before the `LIMIT`, so the excluded count is genuine
    - Parameters come from the resolved scope and nowhere else: `$1` is `scope.organisationIds`, `$2` is `buildEmailDomainLikePatterns(scope)`
    - Omit the `u.origin_org_id` disjunct for now — the column does not exist until task 13.1, and task 13.6 adds it. `directMembershipOrgId` is always `null` on this route by construction
    - Append the existing `search` clause unchanged when present, in addition to the scoping and never instead of it
    - _Requirements: 8.1, 8.2, 8.3, 8.8, 8.9, 9.1, 9.2_

  - [x] 9.2 Add the empty-result count query in `server/routes/users.js`
    - When the scoped result holds no row there is no row to read `excluded_count` from; on exactly that path run one additional `SELECT COUNT(*) FROM candidates` with the same parameters so the log line for an empty response still carries a real count
    - _Requirements: 14.1, 14.3_

  - [x] 9.3 Run the predicate over the returned rows and attach the `scope` object in `server/routes/users.js`
    - Call `DirectoryScopeService.resolveScope(req.user)` once per request and skip all scoping for `UNSCOPED`
    - Call `partitionCandidates(scope, rows, toFacts)` over the rows the SQL already admitted. This is not redundant: one scope object is the sole input to both the SQL parameters and the predicate, the predicate runs on every row about to be returned, so the response is always a subset of what the predicate permits and the only reachable divergence is SQL being *narrower* — which hides a visible user rather than disclosing a hidden one
    - Attach `scope: buildScopeResponse(scope)` for a non-Global_Manager caller and **no `scope` key at all** for a Global_Manager; do not project `origin_org_id` into the response
    - Call `logScopedResponse` with the route, actor id, scope, excluded count, and returned count
    - _Requirements: 9.3, 9.8, 10.1, 10.2, 10.3, 11.3, 14.1, 14.2, 14.3_

  - [x] 9.4 Write property test for scoping being read-only
    - Create `server/routes/users.directoryScope.test.js`, asserting over any query parameters and any caller that no statement issued while handling the request matches `INSERT`, `UPDATE` or `DELETE`; the row-snapshot half is added against a live database in task 10.3's file
    - **Property 9: Scoping is read-only**
    - **Validates: Requirements 12.5**

  - [x] 9.5 Write the `/available` response and integration examples
    - In `server/routes/users.directoryScope.test.js`: the `scope` object's shape for a non-Global_Manager and its total absence for a Global_Manager; the logged object's key set with no candidate email or name in the serialised line
    - Create `server/routes/users.directoryScope.integration.test.js` covering Requirement 15.9's two assertions (empty `users` with `scope.domainsConfigured` of `false` for a Team_Admin whose Organisation holds no `org_allowed_domains` row, then the matching users with `true` once a row exists), Requirement 15.11's excluded-domain assertion, the retained existing filters, the search composition, and Property 9's row-snapshot half over `users`, `user_cache` and `org_allowed_domains`
    - _Requirements: 8.8, 8.9, 9.3, 9.8, 12.5, 14.1, 14.2, 14.3, 15.9, 15.11_

- [x] 10. Scope `GET /api/users/search` and `GET /api/users`
  - [x] 10.1 Scope `/search` in `server/routes/users.js`
    - Same pre-narrow-then-predicate structure: `DirectoryScopeService.TEAM_ROOT_CTE` plus a `candidates` CTE carrying the existing `ILIKE` clauses and `is_active = true`, the `direct_membership_org_id` projection from `root.root_id`, and the `COALESCE`-wrapped `in_scope` expression ahead of the existing `LIMIT 20`
    - The Direct_Membership condition **is** reachable here, unlike on `/available`
    - Keep the two-character minimum, the returned column list, and the existing `{ users }` response shape — Requirement 9's `scope` object is specified for `/available` only
    - Take the excluded count from the same window-function column and log it
    - Omit the `origin_org_id` disjunct until task 13.6
    - _Requirements: 10.3, 11.1, 11.3, 14.1_

  - [x] 10.2 Scope `GET /api/users` in `server/routes/users.js`
    - No SQL narrowing is possible — the page comes from `authentikService.getUsers`. Add `root_id` to the existing batched `team_root` CTE's projection and `u.origin_org_id` in task 13.6; no extra round trip
    - Build one `Map` from `authentik_user_id` to the local facts, then `partitionCandidates` over the Authentik page. A candidate with **no local `users` row** takes its email from the Authentik payload and carries `null` for both org fields, so domain matching is the only condition that can admit it
    - Drop Team_Owned_Devices **first**, then apply the scoping predicate, so `excludedCount` counts users excluded by the scoping rather than by the device filter
    - Leave `pagination.total` deriving from Authentik's own `count` and do not adjust it downward — the same documented compromise the `is_team_device` filter already carries
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 14.1_

  - [x] 10.3 Write property test for the SQL pre-narrowing agreeing with the predicate
    - In `server/routes/users.directoryScope.integration.test.js`, parameterised over the three routes, against a live Postgres — mocking `pool` would mock away the entire subject, since the test compares `LIKE ANY` over escaped patterns, `= ANY` over an int array, three-valued logic, and a window count against a JavaScript predicate
    - **Property 10: The SQL pre-narrowing and the predicate admit the same candidates**
    - **Validates: Requirements 11.3**

  - [x] 10.4 Write the `/search` and `/users` examples
    - In `server/routes/users.directoryScope.test.js`: `pagination.total` untouched; the Team_Owned_Device exclusion retained; the facts map for a candidate with no local `users` row
    - In `server/routes/users.directoryScope.integration.test.js`: Requirement 15.10's assertions that both routes exclude a user outside the caller's Scoped_Organisations and include that user for a Global_Manager
    - Confirm `server/config/permissions.registry.test.js` and `server/middleware/authorize.test.js` still pass **unchanged** — no route, identifier, resolver, or exception-list entry is added
    - _Requirements: 11.4, 11.5, 11.6, 11.7, 11.8, 15.10_

- [x] 11. Client explanation of an empty scoped list
  - [x] 11.1 Create `client/src/utils/directoryScopeMessage.js`
    - One exported pure function `describeEmptyAvailableUsers({ scope, search })` returning `{ kind, message }` over the design's four mutually exclusive cases in order: a non-empty `search` keeps the existing distinct search statement; `scope` present with `domainsConfigured` of `false` names every `scope.organisations[].name`, states that no allowed email domains are configured for it, and states that a Global_Manager can configure them; `scope` present with `domainsConfigured` of `true` states that no unassigned users in those Organisations match; `scope` absent keeps the existing "No available users (all users are already in teams)."
    - The legacy statement is reserved for the unscoped case alone, which is what satisfies Requirements 9.6 and 9.7 simultaneously
    - _Requirements: 9.5, 9.6, 9.7, 9.8_

  - [x] 11.2 Wire the scope into the "Add Existing User" tab in `client/src/pages/TeamDetail.jsx`
    - Store `response.data.scope ?? null` alongside `availableUsers` in `fetchAvailableUsers`
    - Replace the existing inline empty-list ternary with a call to `describeEmptyAvailableUsers`
    - The "Add Admin" path populates `availableUsers` from current members rather than from the route, so it leaves the stored scope `null` and correctly falls to the unscoped statement
    - _Requirements: 9.5, 9.6, 9.7, 9.8_

  - [x] 11.3 Write property test for the empty-list explanation
    - Create `client/src/utils/directoryScopeMessage.test.js`, over a present-or-absent `scope`, both values of `domainsConfigured`, and a present-or-absent search term
    - **Property 18: The empty-list explanation is exhaustive and mutually exclusive**
    - **Validates: Requirements 9.5, 9.6, 9.7, 15.12**

  - [x] 11.4 Write the exact-wording tests
    - In `client/src/utils/directoryScopeMessage.test.js`, asserting the exact text of each of the four statements, that the `domainsConfigured` of `false` case displays the Organisation name and the domain-configuration statement, and that it does **not** display "all users are already in teams"
    - _Requirements: 15.12_

- [x] 12. Checkpoint - Defect 2 domain scoping complete and independently shippable
  - Ensure all tests pass, ask the user if questions arise.
  - Task 13 is the durable provenance layer; the scoping above is fully functional without it.

- [x] 13. Organisation provenance on `users` (durable layer, additive)
  - [x] 13.1 Create the `origin_org_id` migration
    - Create `database/migrations/1786940000000_add-users-origin-org-id.cjs` using the node-pg-migrate schema-builder API and the CommonJS shape of `1786920000000_add-access-requests-transfer-columns.cjs` (`shorthands`, `up`, `down`, `ifNotExists`)
    - `pgm.addColumn('users', { origin_org_id: { type: 'integer', notNull: false, references: 'teams(id)', onDelete: 'SET NULL', comment: ... } }, { ifNotExists: true })`
    - `ON DELETE SET NULL` specifically: `CASCADE` would delete user accounts when an Organisation is deleted, and `RESTRICT` would turn a provenance breadcrumb into a deletion veto. `SET NULL` degrades the row to the Email_Domain fallback that Requirement 13.7 already specifies
    - `pgm.createIndex('users', ['origin_org_id'], { name: 'idx_users_origin_org_id', where: 'origin_org_id IS NOT NULL', ifNotExists: true })` — partial, because every scoping query filters `= ANY(...)` which cannot match a `NULL` and almost every row's value is `NULL` today
    - **No `UPDATE`, no `DELETE`, no backfill, no data migration.** `down` drops the index then the column
    - _Requirements: 13.1, 13.2, 13.9_

  - [x] 13.2 Populate `origin_org_id` in `UserProvisioningService.createAndAddUser`
    - In `server/services/UserProvisioningService.js` add `resolveOrganisationIdForTeam(client, teamId)` using the design's recursive CTE with the order-independent `WHERE parent_team_id IS NULL` predicate, on the **caller's transaction client** — not `Team.getAncestorChain` (which reads the shared `pool`) and not the existing `parent_teams` CTE (which projects parent ids with no `ORDER BY`, so taking "the last row" relies on evaluation order Postgres does not guarantee)
    - Add `origin_org_id` to the `users` upsert with `ON CONFLICT ... DO UPDATE SET origin_org_id = COALESCE(users.origin_org_id, EXCLUDED.origin_org_id)` so provenance is write-once and a returning user being re-provisioned into another Organisation is never reclassified
    - All three creation paths already funnel through this one function with a `teamId`, so `POST /api/users/create-and-add`, access-request approval, and bulk import each need **no** change of their own and none needs to learn what an Organisation is
    - _Requirements: 13.3, 13.4, 13.5, 13.9_

  - [x] 13.3 Write property test for provenance resolution and write-once behaviour
    - Extend `server/services/UserProvisioningService.test.js`, over any hierarchy, any target Team depth, and any prior `origin_org_id`
    - **Property 19: Provenance is the target Team's Organisation and is written once**
    - **Validates: Requirements 13.3, 13.4, 13.5, 13.9**

  - [x] 13.4 Write the two other creation-path examples
    - In `server/services/RequestApprovalService.test.js`: the `case 'new_account'` approval path reaches `createAndAddUser` with the approved row's `target_team_id`
    - In `server/services/BulkImportService.test.js`: the per-row provisioning reaches it with the import's target team
    - _Requirements: 13.4, 13.5_

  - [x] 13.5 Write the migration integration test
    - Create `server/config/migrations.originOrgId.integration.test.js`: seed `users` rows, run the migration, assert **every other column value on every pre-existing row is unchanged** and `origin_org_id` is `NULL`; assert the FK sets the value to `NULL` when the referenced Organisation is deleted; run `up`/`down`/`up` and assert idempotence
    - _Requirements: 13.1, 13.2, 15.13_

  - [x] 13.6 Add the provenance disjunct to the three Directory_Routes
    - In `server/routes/users.js` add `u.origin_org_id` to `/available`'s and `/search`'s `candidates` projections and to `GET /api/users`' batched local query, and add the `COALESCE(u.origin_org_id = ANY($n::int[]), false)` disjunct to each `in_scope` expression
    - Pass the real value as `CandidateFacts.originOrgId` in each route's `toFacts` in place of the `null` the earlier tasks passed. `isCandidateVisible` needs no change — it has handled the field since task 6.1, which is why nothing above depended on this column
    - Keep `origin_org_id` out of every response body: it is a provenance detail with no Client consumer, and projecting it would widen what these routes disclose in the same breath as narrowing it
    - Extend Property 10's generated data in `server/routes/users.directoryScope.integration.test.js` to include non-null `origin_org_id` values, now that the column exists
    - _Requirements: 13.6, 13.7, 13.8, 11.3_

- [x] 14. Final verification
  - Run `npm test -- --coverage` and confirm no failures and that the 60 percent statement gate in the root `package.json`'s `jest.coverageThreshold` holds
  - Run the Client suite from `client/`: `npx vitest --run`
  - Run the integration suites explicitly against the local Postgres container `tak_migration_test_501` on `localhost:15433`: `npx jest server/routes/users.directoryScope.integration.test.js server/config/migrations.originOrgId.integration.test.js --testPathIgnorePatterns=/node_modules/ /client/`, plus the pre-existing integration suites unchanged
  - Run `npm run lint`, `npm run lint:pinned-deps`, and `npm audit --audit-level=high` in the root tree and in `client/`
  - Confirm the Requirement 15.15 baselines: no fewer than **79 passing server suites** and **1464 passing server tests**, no fewer than **17 passing client files** and **225 passing client tests**, no fewer than **3 passing integration suites** and **40 passing integration tests**, and no more than **`157 problems (145 errors, 12 warnings)`** from the lint step
  - Confirm no new dependency was added on either side, that `resolveCallsignSuffixForNewUser`'s precedence rule is unmodified, and that `server/config/permissions.registry.js` and `server/middleware/authorize.js`'s `rowScopedResolvers` map are unchanged
  - _Requirements: 15.14, 15.15_

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; every core implementation task is unmarked.
- **Group independence.** Tasks 1–5 (Defect 1) and tasks 6–12 (Defect 2) share no file and no state. Either can ship without the other. Task 13 depends on tasks 6–12 only through task 13.6's route edits; the migration and the provisioning change stand alone.
- **Task 8 is pending the user's confirmation** recorded in `requirements.md`'s Pending Confirmation section. Nothing depends on it. A fail-open reversal is a one-line edit at the named branch in `DirectoryScopeService.resolveScope`, plus Property 7's statement and Requirement 15.9's first assertion. No other task, route, response shape, log line, or test changes.
- **Nothing before task 13 depends on `users.origin_org_id`.** `CandidateFacts.originOrgId` is nullable from task 6.1, tasks 9 and 10 pass `null` and omit the SQL disjunct, and task 13.6 adds both. Domain-based scoping is complete and correct at task 12.
- **Authorization is untouched throughout.** No new route and no new permission identifier is introduced, so `server/config/permissions.registry.js`, `server/middleware/authorize.js`'s `rowScopedResolvers` map, and both exception lists in `server/config/permissions.registry.test.js` need no entry. `DELETE /api/users/remove-from-team/:userId` and the `user:team:remove` identifier are explicitly unchanged, as is the reviewed exception recording that identifier's wildcard-only status. The three Directory_Routes keep `user:read:team_admin`: this specification narrows response contents, not callers. The only edit in `authorize.js` is the doc-comment correction in task 7.1.
- **Task 4 is deliberately test-only.** Requirement 5 and Requirement 6's server criteria are already satisfied on this branch. Changing `resolveCallsignSuffixForNewUser`'s `trimmedRequested || computeDefault(...)` precedence would remove a Team_Admin's ability to choose their own suffix — that is out of scope and would be a regression, not a fix.
- Properties 1–19 are each implemented by exactly one test sub-task: P1→1.5, P2→1.6, P3→1.7, P4→1.8, P5→4.1, P6→6.4, P7→8.2, P8→6.5, P9→9.4, P10→10.3, P11→1.9, P12→1.10, P13→1.11, P14→1.12, P15→7.3, P16→1.13, P17→7.4, P18→11.3, P19→13.3.
- **Property 1 (task 1.5) and Property 6 (task 6.4) are the two assertions whose absence let both defects ship.** Property 1 fails on today's code; Property 6 is the direct unit-level statement of "no cross-organisation disclosure". Neither should be skipped as an optional sub-task.
- `server/services/__fixtures__/directoryScopeArbitraries.js` (task 6.3) must land before Properties 6, 7, 8, 10, 15, 17 and 19; it reuses `hierarchyArb` and `adminPlacementArb` from `transferArbitraries.js` rather than duplicating them.
- Requirements 11.6, 11.7 and 11.8 get no new test: the existing registry suites already assert every clause, and asserting them again in a second file would create two places to update when the registry changes. Requirement 5.6's negative facts are one example (task 4.2), not a property. Requirements 15.1–15.15 are meta-criteria satisfied by the tests above existing.
- Requirements 15.3–15.8 are tested as reducer sequences plus source-contract assertions rather than by mounting `TeamDetail.jsx` (2,338 lines behind `useParams`, `Link`, and eight API surfaces). Rendering demonstrably works in this repo — `client/src/components/TransferMemberDialog.test.jsx` mounts a real component with `createRoot` and `act` under `jsdom` — so the gap is the DOM-to-logic wiring, which is exactly what the source-contract assertions in task 3.5 trip on. If genuine DOM assertions are later wanted, extracting the Suffix_Field into `client/src/components/CallsignSuffixField.jsx` is a pure refactor, because the reducer already owns every decision.
- The three checkpoints (2, 5, 12) each precede a change that layers on the previous one: pure callsign logic before the component rewiring, Defect 1 complete before any scoping work, domain scoping complete before the provenance layer.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "6.1"] },
    { "id": 1, "tasks": ["1.2", "6.2"] },
    { "id": 2, "tasks": ["1.3", "6.3"] },
    { "id": 3, "tasks": ["1.4", "6.4"] },
    { "id": 4, "tasks": ["1.5", "6.5"] },
    { "id": 5, "tasks": ["1.6", "6.6", "7.1"] },
    { "id": 6, "tasks": ["1.7", "7.2"] },
    { "id": 7, "tasks": ["1.8", "7.3"] },
    { "id": 8, "tasks": ["1.9", "7.4"] },
    { "id": 9, "tasks": ["1.10", "7.5"] },
    { "id": 10, "tasks": ["1.11", "8.1"] },
    { "id": 11, "tasks": ["1.12", "8.2"] },
    { "id": 12, "tasks": ["1.13", "9.1"] },
    { "id": 13, "tasks": ["3.1", "9.2"] },
    { "id": 14, "tasks": ["3.2", "9.3"] },
    { "id": 15, "tasks": ["3.3", "9.4"] },
    { "id": 16, "tasks": ["3.4", "9.5"] },
    { "id": 17, "tasks": ["3.5", "10.1"] },
    { "id": 18, "tasks": ["4.1", "10.2"] },
    { "id": 19, "tasks": ["4.2", "10.3"] },
    { "id": 20, "tasks": ["10.4", "11.1"] },
    { "id": 21, "tasks": ["11.2", "13.1"] },
    { "id": 22, "tasks": ["11.3", "13.2"] },
    { "id": 23, "tasks": ["11.4", "13.3"] },
    { "id": 24, "tasks": ["13.4"] },
    { "id": 25, "tasks": ["13.5"] },
    { "id": 26, "tasks": ["13.6"] }
  ]
}
```
