# Requirements Document

## Introduction

This document covers two defects reported by a Team_Admin of `FENZ - Southland District`, both in the Team Detail page's Add Member Dialog. Three previous attempts addressed adjacent code without changing what the reporting user sees, so every requirement below is written against observable behaviour — what the field displays, what the request body contains, which users appear in a list — and not against the presence of a particular function or state variable.

### Defect 1: the Callsign Suffix is computed once and never recomputed

Reported as: "Create New User still does not calculate the Callsign Suffix properly. When I edit either first name or last name that calculation should happen over and over again — including the collision check."

The cause is confirmed and is a Client-side one. `runCallsignSuffixPreview` in `client/src/pages/TeamDetail.jsx` builds its request body as:

```js
const callsignSuffix = form.callsignSuffix || ''
... ...(callsignSuffix ? { callsignSuffix } : {})
```

Once the field holds a value the Client itself auto-filled, every later preview sends that value back as `callsignSuffix`. On the server, `UserProvisioningService.resolveCallsignSuffixForNewUser` prefers a supplied value over computing one:

```js
effectiveValue = trimmedRequested || CallsignService.computeDefaultCallsignSuffix(firstName, lastName, callsignNameFormat)
```

so the server correctly echoes back what the Client sent. The net effect is that the suffix is computed exactly once — while the field is still empty — and never again. Editing First Name from `Chris` to `Bob` sends the stale `C.Elsen` and receives `C.Elsen` back.

The uniqueness check does run, but against that stale value. That is worse than not running at all: it reports a collision for a suffix that is not the one the submit path would assign, and stays silent about a collision on the one it would.

The component already holds the state needed to fix this. `newUserCallsignEdited` is set to `true` by the input's `onChange` and is not set when a preview auto-fills the field, so the Client already distinguishes "the admin typed this" from "we computed this". That flag currently feeds only the `manuallyEdited` guard inside `decideCallsignSuffixPreview`, which decides whether to overwrite the field. Nothing consults it when deciding what to **send**. That is the gap this spec closes.

The reporting user asked for both a recompute on leaving a name field and a manual recompute control next to the field. Both are specified; they are not alternatives.

### Defect 2: the available-users list shows users from other organisations

Reported as: "Team -> Add Member -> Add Member to Team still shows me a list of users outside my org, even though I'm only a team admin. That's leaking PII and a seriously unacceptable situation."

`GET /api/users/available` selects `user_cache` rows LEFT JOINed to `users` and `team_memberships` and filters on `WHERE tm.user_id IS NULL` — no Direct_Membership. It therefore returns every active Authentik-synced user who holds no team, across every Organisation in the deployment, including `user_cache` rows that have no corresponding local `users` row at all. There is no organisation filter of any kind. Commit `52fef60` narrowed **who** may call the three user-directory listing routes to a Team_Admin via the `user:read:team_admin` resolver, and its own code comment records that it deliberately did not narrow **what** the response contains. This spec is that second half.

The obstacle is that a teamless user has no Organisation anywhere in the data. With no team there is no Ancestor_Chain and therefore no Organisation, and neither `users` nor `user_cache` carries an org or provenance column — confirmed against the baseline schema and every migration in `database/migrations`.

Email domain is the one Organisation signal that exists today, and this spec uses it. `org_allowed_domains` (`id`, `org_id`, `domain`) holds one row per allowed domain keyed on the Organisation, created by migration `1786850000001_create-org-allowed-domains.cjs` with a unique constraint on `(org_id, domain)` and an index on `org_id`, and is read today by `GET /api/orgs/:orgId/domains`. A separate global `excluded_email_domains` JSON array in `system_config`, seeded by migration `1786890000000`, lists consumer and freemail domains.

The reporting user has confirmed FENZ has no domain whitelist configured. Domain-based scoping therefore returns an empty list for FENZ until domains are added. This document specifies the fail-closed direction — no users rather than all users — because the user called the current disclosure unacceptable, and specifies that the Client must say **why** the list is empty. An unexplained empty list is indistinguishable from a broken feature, and this user has already been bitten by exactly that ambiguity.

Organisation provenance recorded on `users` at creation time is specified as the durable mechanism (Requirement 13). It cannot retroactively classify the existing teamless users, whose origin is genuinely unknowable, so the two mechanisms are complementary: domain scoping is what works for existing rows, provenance is what works for rows created from now on. No backfill and no reclassification of existing rows is specified.

## Pending Confirmation

One point is not yet confirmed by the reporting user and is written here as the fail-closed recommendation rather than silently assumed:

> **Open:** does the user accept the "Add Existing User" list being empty for FENZ until FENZ's allowed email domains are configured?

Requirement 9 states the fail-closed behaviour. If the user rejects it, Requirement 9 is the only requirement that changes; Requirements 8, 10, 11, 12 and 13 hold either way. Do not begin design on Requirement 9 before that answer arrives.

## Scope

In scope: recompute triggers and precedence for the Add Member Dialog's Callsign_Suffix field, the contents of the Suffix_Preview request body, the manual Recompute_Control, in-flight and failure behaviour of the preview, Organisation scoping of `GET /api/users/available`, the same scoping applied to `GET /api/users/search` and `GET /api/users`, the Client's explanation of an empty scoped list, an additive Organisation-provenance column on `users` populated for newly created users, and automated tests including the property-based tests named in Requirement 15.

Out of scope: `user:team:remove` and `DELETE /api/users/remove-from-team/:userId`. Widening who may delete an account is explicitly excluded, and no requirement in this document changes that route or that identifier.

Out of scope: any change to `UserProvisioningService.resolveCallsignSuffixForNewUser`'s precedence rule. Preferring a supplied value over a computed one is correct for the submit path — a Team_Admin who types a suffix must get the suffix they typed. Defect 1 is a Client-side defect in what gets sent, and is fixed there.

Out of scope: any backfill, deletion, or reclassification of existing `users` or `user_cache` rows.

Out of scope: a Client surface for editing `org_allowed_domains`. `GET /api/orgs/:orgId/domains` and `PUT /api/orgs/:orgId/domains` already exist; Requirement 9 requires only that the Client point at domain configuration, not that it reimplement it.

## Glossary

Terms already defined by the `org-team-hierarchy`, `production-hardening`, and `team-member-transfer` specs are restated unchanged so this document is self-contained.

- **App**: The Express.js web API process defined in `server/index.js`.
- **Client**: The React single-page application in `client/src`.
- **Database**: The PostgreSQL instance accessed via the connection pool in `server/config/database.js`.
- **Authentik**: The external OAuth2/LDAP identity provider integrated with via its REST API v3.
- **Repository**: The Git repository rooted at the workspace, including its Jest and Vitest test suites.
- **Team**: A row in the `teams` table.
- **Organisation**: A Team whose `parent_team_id` is `NULL` (the root of a hierarchy).
- **Ancestor_Chain**: For a given Team, the ordered sequence of Teams from that Team's Organisation down to and including that Team itself, following `parent_team_id` links, as returned by `Team.getAncestorChain`.
- **Global_Manager**: A user whose cached `is_global_manager` attribute is true.
- **Direct_Membership**: A user's single `team_memberships` row with `inherited_from_team_id IS NULL`, constrained system-wide to at most one per user by the partial unique index `idx_team_memberships_one_direct_per_user`.
- **Team_Admin**: A user who holds a direct (`inherited_from_team_id IS NULL`) `team_memberships` row with `role = 'admin'` for a given Team, OR who holds such a row for any Team in that Team's Ancestor_Chain, as computed by `Team.isAdmin`. An inherited admin row never confers Team_Admin status.
- **Administered_Organisations**: For a given user, the set of Organisations that are the root of the Ancestor_Chain of at least one Team for which that user holds a direct `team_memberships` row with `role = 'admin'`. The set is empty for a user who administers no Team, and holds more than one Organisation for a user who administers Teams in more than one hierarchy.
- **Allowed_Domain**: A `domain` value held by an `org_allowed_domains` row, compared case-insensitively.
- **Excluded_Domains**: The JSON array of domain strings held by the `system_config` row whose `config_key` is `excluded_email_domains`.
- **Email_Domain**: For a given email address, the substring following the final `@` character, compared case-insensitively.
- **Scoped_Organisations**: For a given requesting user, the Administered_Organisations of that user; used as the visibility boundary by Requirements 8, 11 and 12.
- **Directory_Route**: Any of `GET /api/users`, `GET /api/users/search`, and `GET /api/users/available`.
- **Member_List**: The members and admins tables rendered on the Team Detail page's Members and Team Admins tabs (`client/src/pages/TeamDetail.jsx`).
- **Callsign_Suffix**: The per-user `users.callsign_suffix` value used as the Name segment of every generated callsign, unique case-insensitively within a Team's Member_List per `CallsignSuffixUniquenessService.checkCallsignSuffixUniqueness`.
- **Callsign_Name_Format**: An Organisation's `teams.callsign_name_format` value, one of `full_name`, `first_initial_last`, `first_last_initial`, `first_initial_dot_last`, or `user_defined`.
- **Computed_Suffix**: The value `CallsignService.computeDefaultCallsignSuffix` returns for a given first name, last name, and Callsign_Name_Format. It is `null` for a Callsign_Name_Format of `user_defined`.
- **Add_Member_Dialog**: The dialog opened from the Team Detail page's Add Member action, holding an "Add Existing User" tab and a "Create New User" tab.
- **Suffix_Field**: The Callsign Suffix text input on the Add_Member_Dialog's "Create New User" tab.
- **Suffix_Preview**: A `POST /api/users/callsign-suffix-preview` request and its response body `{ suffix, required, conflict }`.
- **Admin_Typed_Suffix**: A non-empty Suffix_Field value that the operating admin entered by typing or pasting into the Suffix_Field.
- **Auto_Filled_Suffix**: A non-empty Suffix_Field value that the Client wrote into the field from a Suffix_Preview response.
- **Recompute**: A Suffix_Preview issued with the intent of replacing the Suffix_Field's value with the Computed_Suffix for the currently entered names.
- **Recompute_Control**: The Client control adjacent to the Suffix_Field that the operating admin activates to force a Recompute.
- **Assigned_Suffix**: The `callsign_suffix` value that `POST /api/users/create-and-add` would store for the new user, given the request body the Client would submit at that moment.
- **Permission_Registry**: The route-to-permission-identifier map in `server/config/permissions.registry.js`.
- **Authorization_Middleware**: The middleware in `server/middleware/authorize.js` that consults the Permission_Registry on every authenticated request and denies any route with no registry entry.
- **Row_Scoped_Resolver**: An entry in `authorize.js`'s `rowScopedResolvers` map that grants a single permission identifier for a single request by inspecting request parameters, body, or Database rows.

## Requirements

### Requirement 1: Recompute When a Name Field Loses Focus

**User Story:** As a Team_Admin creating a user, I want the Callsign Suffix to follow the names I typed, so that the suffix shown is the suffix the new user will get.

#### Acceptance Criteria

1. WHEN focus leaves the First Name input of the Add_Member_Dialog's "Create New User" tab AND both the First Name and Last Name inputs hold non-empty trimmed values, THE Client SHALL issue a Suffix_Preview.
2. WHEN focus leaves the Last Name input of the Add_Member_Dialog's "Create New User" tab AND both the First Name and Last Name inputs hold non-empty trimmed values, THE Client SHALL issue a Suffix_Preview.
3. WHEN focus leaves the Suffix_Field AND both the First Name and Last Name inputs hold non-empty trimmed values, THE Client SHALL issue a Suffix_Preview.
4. WHILE either the First Name or the Last Name input holds an empty trimmed value, THE Client SHALL issue no Suffix_Preview, because the App cannot compute a Computed_Suffix without both names.
5. THE Client SHALL issue no Suffix_Preview in response to a keystroke in the First Name, Last Name, or Suffix_Field inputs.
6. WHEN THE Client issues a Suffix_Preview, THE Client SHALL send the First Name and Last Name values currently held by those inputs, so that a Suffix_Preview issued after a name edit reflects the edited name.
7. WHEN THE Client issues a Suffix_Preview whose response holds a `suffix` value differing from the Suffix_Field's current value AND the Suffix_Field holds no Admin_Typed_Suffix, THE Client SHALL display the response's `suffix` value in the Suffix_Field.

**Note on Criterion 3:** a Suffix_Preview on leaving the Suffix_Field is retained because it re-runs the uniqueness check against a value the admin has just typed, which is the value Requirement 5 requires the check to run against.

### Requirement 2: Manual Recompute Control

**User Story:** As a Team_Admin, I want a control that recomputes the Callsign Suffix on demand, so that I can get back to the automatic value after typing my own, without reopening the dialog.

#### Acceptance Criteria

1. THE Client SHALL display a Recompute_Control adjacent to the Suffix_Field on the Add_Member_Dialog's "Create New User" tab.
2. THE Client SHALL give the Recompute_Control an accessible name stating that it recomputes the callsign suffix from the entered names.
3. WHEN the operating admin activates the Recompute_Control, THE Client SHALL issue a Suffix_Preview that omits the `callsignSuffix` property from its request body, regardless of the Suffix_Field's current value.
4. WHEN the Suffix_Preview issued per Criterion 3 returns a response whose `required` is `false` and whose `conflict` is `null`, THE Client SHALL display that response's `suffix` value in the Suffix_Field, replacing any Admin_Typed_Suffix the field held.
5. WHEN THE Client replaces an Admin_Typed_Suffix per Criterion 4, THE Client SHALL thereafter treat the Suffix_Field as holding an Auto_Filled_Suffix, so that a subsequent Suffix_Preview per Requirement 1 continues to track further name edits.
6. WHILE either the First Name or the Last Name input holds an empty trimmed value, THE Client SHALL disable the Recompute_Control.
7. WHILE a Suffix_Preview issued for the Add_Member_Dialog is awaiting a response, THE Client SHALL disable the Recompute_Control.
8. WHEN the operating admin activates the Recompute_Control, THE Client SHALL clear any inline Callsign_Suffix message previously displayed, before displaying any message derived from the resulting Suffix_Preview response.

**Note on Criterion 4:** the Recompute_Control is the single affordance that discards an Admin_Typed_Suffix. Requirement 3 forbids every other path from doing so. Requirement 6 Criterion 4 excludes the `user_defined` case, where there is nothing to replace the typed value with.

### Requirement 3: The Preview Request Never Echoes an Auto-Filled Suffix

**User Story:** As a Team_Admin, I want the recompute to actually recompute, so that changing a name changes the suffix instead of returning the previous one.

#### Acceptance Criteria

1. WHILE the Suffix_Field holds an Auto_Filled_Suffix, THE Client SHALL omit the `callsignSuffix` property from every Suffix_Preview request body it issues.
2. WHILE the Suffix_Field holds an empty trimmed value, THE Client SHALL omit the `callsignSuffix` property from every Suffix_Preview request body it issues.
3. WHILE the Suffix_Field holds an Admin_Typed_Suffix, THE Client SHALL include that value as the `callsignSuffix` property of every Suffix_Preview request body it issues, except for the Suffix_Preview issued by the Recompute_Control per Requirement 2 Criterion 3.
4. WHEN THE Client writes a value into the Suffix_Field from a Suffix_Preview response, THE Client SHALL record that value as an Auto_Filled_Suffix and not as an Admin_Typed_Suffix.
5. WHEN the operating admin edits the Suffix_Field, THE Client SHALL record the resulting value as an Admin_Typed_Suffix.
6. WHEN the operating admin edits the Suffix_Field to an empty trimmed value, THE Client SHALL record the Suffix_Field as holding neither an Admin_Typed_Suffix nor an Auto_Filled_Suffix, so that a subsequent Suffix_Preview fills the emptied field.
7. WHEN the Add_Member_Dialog is opened, THE Client SHALL record the Suffix_Field as holding neither an Admin_Typed_Suffix nor an Auto_Filled_Suffix, and SHALL display an empty Suffix_Field.

**Note:** Criteria 1 and 2 are the fix for Defect 1. The `callsignSuffix` property being present with a previously auto-filled value is exactly what makes `resolveCallsignSuffixForNewUser` skip the computation and echo the stale value back.

### Requirement 4: Precedence Between a Typed Suffix and a Computed One

**User Story:** As a Team_Admin, I want a suffix I typed to survive later name edits, so that my deliberate choice is not silently overwritten.

#### Acceptance Criteria

1. WHILE the Suffix_Field holds an Admin_Typed_Suffix, THE Client SHALL leave the Suffix_Field's value unchanged when a Suffix_Preview issued per Requirement 1 returns.
2. WHILE the Suffix_Field holds an Auto_Filled_Suffix, THE Client SHALL replace the Suffix_Field's value with the `suffix` value of a returning Suffix_Preview response whose `required` is `false` and whose `conflict` is `null`.
3. WHEN a Suffix_Preview response holds a non-null `conflict`, THE Client SHALL display `conflict.message` as an inline message associated with the Suffix_Field, and SHALL display `conflict.value` in the Suffix_Field WHERE `conflict.value` is a non-empty string.
4. WHEN a Suffix_Preview response holds a `required` value of `true`, THE Client SHALL leave the Suffix_Field's value unchanged and SHALL mark the Suffix_Field as required.
5. THE Client SHALL replace an Admin_Typed_Suffix only in response to activation of the Recompute_Control per Requirement 2 Criterion 4, or to a conflict per Criterion 3, or to a reset of the Add_Member_Dialog per Requirement 3 Criterion 7.

**Note on Criterion 3:** displaying `conflict.value` in the Suffix_Field is not an exception to Criterion 5 in practice — when the conflict is on an Admin_Typed_Suffix, `conflict.value` equals the value the admin typed, so the write is a no-op. It matters when the conflict is on a Computed_Suffix, where the admin needs to see and edit the value that actually collided rather than read a warning over an empty field.

### Requirement 5: The Collision Check Runs Against the Value That Would Be Assigned

**User Story:** As a Team_Admin, I want a reported collision to be about the suffix this user will actually receive, so that a warning I act on is a warning that was real.

#### Acceptance Criteria

1. WHEN THE App handles a `POST /api/users/callsign-suffix-preview` request, THE App SHALL perform the case-insensitive uniqueness check against the same value it reports as `suffix`, or against `conflict.value` WHERE it reports a non-null `conflict`.
2. WHEN THE App handles a `POST /api/users/callsign-suffix-preview` request, THE App SHALL resolve the previewed value using `UserProvisioningService.resolveCallsignSuffixForNewUser`, the same function `POST /api/users/create-and-add` calls, so that a preview and a submit for one request body cannot disagree.
3. WHEN THE Client issues a Suffix_Preview, THE Client SHALL send a request body whose `firstName`, `lastName`, `teamId`, and presence-or-absence of `callsignSuffix` match the body it would send to `POST /api/users/create-and-add` at that moment, so that the previewed value equals the Assigned_Suffix.
4. WHERE the Suffix_Preview issued by the Recompute_Control omits `callsignSuffix` while the Suffix_Field holds an Admin_Typed_Suffix, THE Client SHALL treat Criterion 3 as satisfied by the Suffix_Field value the response writes per Requirement 2 Criterion 4, because that value becomes the body of a subsequent submit.
5. WHEN THE App reports a non-null `conflict` for a Suffix_Preview, THE App SHALL include in `conflict.value` the value that collided.
6. THE App SHALL perform no `INSERT`, `UPDATE`, or `DELETE` statement, no Authentik request, and no transaction while handling a `POST /api/users/callsign-suffix-preview` request.

### Requirement 6: User-Defined Callsign Name Format

**User Story:** As a Team_Admin of an Organisation that requires manually chosen suffixes, I want the dialog to tell me it needs one, so that I do not wait for a value that will never appear.

#### Acceptance Criteria

1. WHERE the target Team's Organisation holds a Callsign_Name_Format of `user_defined` AND a Suffix_Preview request body omits `callsignSuffix` or holds an empty trimmed `callsignSuffix`, THE App SHALL respond with status 200 and a body holding `suffix` of `null`, `required` of `true`, and `conflict` of `null`.
2. WHILE the most recent Suffix_Preview response for the open Add_Member_Dialog holds `required` of `true`, THE Client SHALL display a statement that this Organisation requires a manually chosen callsign suffix.
3. WHILE the most recent Suffix_Preview response for the open Add_Member_Dialog holds `required` of `true`, THE Client SHALL disable the Recompute_Control, because no Computed_Suffix exists for that Callsign_Name_Format.
4. WHILE the most recent Suffix_Preview response for the open Add_Member_Dialog holds `required` of `true`, THE Client SHALL leave any Admin_Typed_Suffix in the Suffix_Field unchanged.
5. WHERE the target Team's Organisation holds a Callsign_Name_Format of `user_defined` AND a Suffix_Preview request body holds a non-empty trimmed `callsignSuffix`, THE App SHALL perform the uniqueness check of Requirement 5 Criterion 1 against that value and SHALL respond with `required` of `false`.
6. WHILE no Suffix_Preview response has yet been received for the open Add_Member_Dialog, THE Client SHALL leave the Recompute_Control enabled WHERE both name inputs hold non-empty trimmed values, because the target Organisation's Callsign_Name_Format is not yet known to the Client.

**Note on Criterion 3:** without this criterion, activating the Recompute_Control under `user_defined` would discard the admin's typed suffix per Requirement 2 Criterion 4 and replace it with nothing, leaving the only usable value destroyed.

### Requirement 7: Preview In Flight and Preview Failure

**User Story:** As a Team_Admin, I want a slow or failed suffix check to be visible and harmless, so that it neither hides a value from me nor blocks me from creating the user.

#### Acceptance Criteria

1. WHILE a Suffix_Preview issued for the Add_Member_Dialog is awaiting a response, THE Client SHALL display a busy indication on or adjacent to the Suffix_Field.
2. WHILE a Suffix_Preview issued for the Add_Member_Dialog is awaiting a response, THE Client SHALL keep the Suffix_Field editable and SHALL keep the dialog's submit control operable.
3. IF a Suffix_Preview request fails, THEN THE Client SHALL leave the Suffix_Field's value, its required marking, and any inline message unchanged, SHALL record the failure through the browser console, and SHALL display no blocking error.
4. IF a Suffix_Preview request fails, THEN THE Client SHALL permit submission of the Add_Member_Dialog, because `POST /api/users/create-and-add` re-resolves and re-checks the Callsign_Suffix authoritatively.
5. WHEN more than one Suffix_Preview has been issued for the open Add_Member_Dialog and responses arrive, THE Client SHALL apply only the response to the most recently issued Suffix_Preview and SHALL discard every earlier response.
6. WHEN the Add_Member_Dialog is closed, THE Client SHALL discard every outstanding Suffix_Preview response and SHALL apply none of them to a subsequently opened dialog.
7. WHEN `POST /api/users/create-and-add` responds with status 400 and a body holding an `error` string concerning the Callsign_Suffix, THE Client SHALL display that string as an inline message associated with the Suffix_Field and SHALL keep the Add_Member_Dialog open.

**Note on Criterion 5:** blur-triggered previews are ordered by user focus changes, not by response arrival. Without this criterion a slow preview for `Chris` can overwrite the field after a fast preview for `Bob` has already filled it, reproducing Defect 1's visible symptom by a different route.

### Requirement 8: Organisation Scoping of the Available Users List

**User Story:** As a Team_Admin, I want the Add Existing User list limited to my own organisation's people, so that I am not shown the names and email addresses of users I have no business seeing.

#### Acceptance Criteria

1. WHEN a user who is not a Global_Manager calls `GET /api/users/available`, THE App SHALL include a candidate user in the response only WHERE that candidate satisfies at least one of the following: the candidate's Email_Domain equals an Allowed_Domain of an Organisation in the caller's Scoped_Organisations; or the candidate holds a Direct_Membership whose Team's Ancestor_Chain has as its root an Organisation in the caller's Scoped_Organisations.
2. WHEN a user who is not a Global_Manager calls `GET /api/users/available`, THE App SHALL exclude every candidate user that satisfies no condition of Criterion 1.
3. THE App SHALL compare an Email_Domain to an Allowed_Domain case-insensitively, comparing the substring following the final `@` of the candidate's email address to the `org_allowed_domains.domain` value.
4. THE App SHALL exclude from the matching of Criterion 1 any Allowed_Domain whose value appears in Excluded_Domains, so that an Organisation listing a consumer or freemail domain does not thereby gain visibility of every unassigned user holding an address at that domain.
5. THE App SHALL determine the caller's Scoped_Organisations from `team_memberships` rows with `role` of `admin` and `inherited_from_team_id` of `NULL`, resolving each such Team's Organisation as the root of its Ancestor_Chain.
6. WHERE the caller's Scoped_Organisations holds more than one Organisation, THE App SHALL include a candidate user that satisfies Criterion 1 for any one of those Organisations.
7. WHEN a candidate user holds an empty or absent email address, THE App SHALL exclude that candidate from the response of a caller who is not a Global_Manager.
8. THE App SHALL retain the existing filters of `GET /api/users/available`, so that the response continues to hold only candidates with no Direct_Membership, with `user_cache.is_active` of `true`, and with non-empty email and first name.
9. WHEN `GET /api/users/available` is called with a `search` query parameter, THE App SHALL apply the scoping of Criterion 1 in addition to, and never instead of, the search filter.

**Note on Criterion 1:** the second condition is stated for completeness of the rule shared with Requirements 11 and 12. `GET /api/users/available` returns only users with no Direct_Membership, so in practice only the Email_Domain condition can be satisfied on that route, which is why an Organisation with no Allowed_Domain rows yields an empty list under Requirement 9.

### Requirement 9: Fail-Closed Behaviour for an Organisation With No Configured Domains

**User Story:** As a Team_Admin of an organisation with no domain whitelist, I want an empty list and an explanation, so that I understand a deliberate restriction rather than suspecting a broken page.

> **This requirement's direction is pending the user's confirmation recorded in the Pending Confirmation section above.**

#### Acceptance Criteria

1. WHERE no Organisation in the caller's Scoped_Organisations holds any Allowed_Domain remaining after the exclusion of Requirement 8 Criterion 4, THE App SHALL respond to `GET /api/users/available` with status 200 and an empty `users` array.
2. WHERE the caller's Scoped_Organisations is empty AND the caller is not a Global_Manager, THE App SHALL respond to `GET /api/users/available` with status 200 and an empty `users` array.
3. WHEN THE App responds to `GET /api/users/available` for a caller who is not a Global_Manager, THE App SHALL include in the response body a `scope` object holding a boolean `domainsConfigured` and an array `organisations` of the caller's Scoped_Organisations, each entry holding that Organisation's `id` and `name`.
4. THE App SHALL set `scope.domainsConfigured` to `false` WHERE Criterion 1 or Criterion 2 applies, and to `true` otherwise.
5. WHILE the Add_Member_Dialog's "Add Existing User" tab displays an empty available-users list AND the most recent response held `scope.domainsConfigured` of `false`, THE Client SHALL display a statement naming each Organisation in `scope.organisations` and stating that no allowed email domains are configured for it, and SHALL state that a Global_Manager can configure allowed email domains for the Organisation.
6. WHILE the Add_Member_Dialog's "Add Existing User" tab displays an empty available-users list AND the most recent response held `scope.domainsConfigured` of `true`, THE Client SHALL display a statement that no unassigned users in the Organisation match, and SHALL retain its existing distinct statement for the case where a `search` term produced no match.
7. THE Client SHALL display the existing statement "No available users (all users are already in teams)" only WHERE the most recent response held `scope.domainsConfigured` of `true` or held no `scope` object, so that a domain-scoping restriction is never reported as an absence of unassigned users.
8. WHEN a Global_Manager calls `GET /api/users/available`, THE App SHALL include no `scope` object in the response body, and THE Client SHALL display its existing statements unchanged.

**Note on Criterion 5:** the reporting user administers `FENZ - Southland District` within FENZ, which has no configured domains today. Under this requirement that admin sees an empty list naming FENZ and pointing at domain configuration, rather than an unexplained empty list or the misleading existing "all users are already in teams" text.

### Requirement 10: Global Manager Visibility Is Unchanged

**User Story:** As a Global_Manager, I want the unscoped directory I have today, so that I can still administer users across every organisation.

#### Acceptance Criteria

1. WHEN a Global_Manager calls any Directory_Route, THE App SHALL apply no Organisation scoping to the response.
2. WHEN a Global_Manager calls `GET /api/users/available`, THE App SHALL include every candidate user that the route's existing filters admit, including candidates whose Email_Domain matches no Allowed_Domain of any Organisation.
3. WHEN a Global_Manager calls any Directory_Route, THE App SHALL return a response body of the same shape as before this specification's changes, except for the `scope` object that Requirement 9 Criterion 8 excludes for a Global_Manager.
4. THE App SHALL determine Global_Manager status from the requesting user's cached `is_global_manager` attribute, as the existing `user:read:team_admin` Row_Scoped_Resolver does.

### Requirement 11: The Same Scoping on the Other Directory Routes

**User Story:** As a security-conscious operator, I want every route that lists users to apply the same limit, so that closing one disclosure does not simply move it to the next route.

#### Acceptance Criteria

1. WHEN a user who is not a Global_Manager calls `GET /api/users/search`, THE App SHALL include a user in the response only WHERE that user satisfies at least one condition of Requirement 8 Criterion 1.
2. WHEN a user who is not a Global_Manager calls `GET /api/users`, THE App SHALL include a user in the response only WHERE that user satisfies at least one condition of Requirement 8 Criterion 1.
3. THE App SHALL apply the scoping of Criteria 1 and 2 using the same server-side component that Requirement 8 uses, so that the three Directory_Routes cannot diverge.
4. WHERE `GET /api/users` returns a `pagination.total` value, THE App SHALL continue to derive that value from the Authentik user count, and the returned `users` array SHALL be correctly scoped even where `pagination.total` over-counts by the number of users the scoping excluded.
5. THE App SHALL retain the existing exclusion of every user whose local `users` row holds `is_team_device` of `true` from `GET /api/users`.
6. THE Permission_Registry SHALL continue to map each of the three Directory_Routes to `user:read:team_admin`, because this specification narrows the contents of each response and not who may call it.
7. THE App SHALL introduce no new permission identifier for the three Directory_Routes, and WHERE any new route is introduced by the design of this specification, THE Permission_Registry SHALL hold an entry for that route AND THE Authorization_Middleware SHALL hold a Row_Scoped_Resolver for its identifier or `permissions.registry.js` SHALL hold that identifier in a `roleDefaults` entry.
8. THE App SHALL leave `DELETE /api/users/remove-from-team/:userId` and the `user:team:remove` identifier unchanged.

**Note on Criterion 4:** this mirrors the compromise already documented in `server/routes/users.js` for the `is_team_device` filter, where the returned array is filtered after the Authentik page is fetched and the total is not adjusted.

**Note on Criterion 7:** the registry-completeness test enforces this. An identifier with neither a resolver nor a `roleDefaults` entry is unsatisfiable and produces a 403 on every request, which is exactly the failure mode a previous change in this area introduced.

### Requirement 12: Users Matching No Organisation

**User Story:** As a security-conscious operator, I want a user whose email domain matches no organisation to stay hidden from team admins, so that an unclaimed account is not disclosed to whoever asks first.

#### Acceptance Criteria

1. WHERE a user holds no Direct_Membership AND that user's Email_Domain equals no Allowed_Domain of any Organisation, THE App SHALL exclude that user from every Directory_Route response to a caller who is not a Global_Manager.
2. WHEN a Global_Manager calls a Directory_Route, THE App SHALL include a user described in Criterion 1 subject only to that route's existing filters.
3. WHERE a user's Email_Domain equals an Allowed_Domain of an Organisation absent from the caller's Scoped_Organisations, THE App SHALL exclude that user from the response.
4. WHERE a user's Email_Domain equals an Allowed_Domain of more than one Organisation, THE App SHALL include that user in the response of a caller whose Scoped_Organisations holds any one of those Organisations.
5. THE App SHALL delete no row and SHALL modify no row in the `users`, `user_cache`, or `org_allowed_domains` tables as a consequence of a Directory_Route call.

**Note on Criterion 4:** two Organisations can list the same Allowed_Domain; the unique constraint on `org_allowed_domains` is `(org_id, domain)`, not `domain` alone. An overlapping domain therefore makes a teamless user visible to the Team_Admins of both Organisations. That is a property of a shared-domain configuration rather than a defect, and the Organisation provenance of Requirement 13 is the mechanism that resolves it for users created from now on.

### Requirement 13: Organisation Provenance Recorded at User Creation

**User Story:** As an operator, I want each newly created user to record which organisation created them, so that visibility scoping stops depending on an organisation having claimed the right email domain.

#### Acceptance Criteria

1. THE Database SHALL hold a nullable `users.origin_org_id` column referencing `teams(id)`, added by an additive migration in `database/migrations` that leaves every existing `users` row's column values unchanged.
2. THE migration described in Criterion 1 SHALL set `origin_org_id` to `NULL` for every existing `users` row and SHALL perform no backfill, because the Organisation that originated an existing teamless user is not recorded anywhere in the Database.
3. WHEN THE App creates a `users` row through `POST /api/users/create-and-add`, THE App SHALL set `origin_org_id` to the Organisation at the root of the target Team's Ancestor_Chain.
4. WHEN THE App creates a `users` row through the approval of an `access_requests` row, THE App SHALL set `origin_org_id` to the Organisation at the root of that row's `target_team_id` Team's Ancestor_Chain.
5. WHEN THE App creates a `users` row through a bulk import, THE App SHALL set `origin_org_id` to the Organisation at the root of the Ancestor_Chain of the Team that import targets.
6. WHERE a `users` row holds a non-null `origin_org_id`, THE App SHALL treat that user as satisfying Requirement 8 Criterion 1 for a caller whose Scoped_Organisations holds the Organisation named by `origin_org_id`.
7. WHERE a `users` row holds a `NULL` `origin_org_id`, THE App SHALL fall back to the Email_Domain condition of Requirement 8 Criterion 1 for that user.
8. THE App SHALL treat a non-null `origin_org_id` as additive to the Email_Domain condition rather than as a replacement for it, so that a user visible under one condition is not hidden by the other.
9. THE App SHALL delete no row and SHALL reclassify no existing row as part of satisfying this requirement.

**Note:** provenance is the mechanism that works going forward and domain matching is the mechanism that works for rows that already exist. Neither alone is sufficient, which is why Criterion 8 makes them additive.

### Requirement 14: Observability of a Scoped Response

**User Story:** As an operator diagnosing a complaint about a missing user, I want the scoping decision recorded, so that I can tell a deliberate restriction from a defect without guessing.

#### Acceptance Criteria

1. WHEN THE App applies Organisation scoping to a Directory_Route response, THE App SHALL record through the structured logger the requesting user's `users.id`, the Scoped_Organisations identifiers applied, and the count of users excluded by the scoping.
2. THE App SHALL record no user email address and no user name in the log entry described in Criterion 1.
3. WHEN THE App responds to `GET /api/users/available` with an empty `users` array for a caller who is not a Global_Manager, THE App SHALL record through the structured logger whether `scope.domainsConfigured` was `false`.

### Requirement 15: Automated Test Coverage and Correctness Properties

**User Story:** As a maintainer, I want the assertions whose absence let both defects ship, so that neither can return silently after a fourth attempt.

#### Acceptance Criteria

1. THE Repository SHALL contain a property-based test asserting that, for any two distinct pairs of first and last names, a Recompute issued while the Suffix_Field holds no Admin_Typed_Suffix produces a Suffix_Preview request body that omits `callsignSuffix` and carries the currently entered names, and that the resulting Suffix_Field value equals the Computed_Suffix for those names.
2. THE Repository SHALL contain a property-based test asserting that, for any Organisation and any set of `org_allowed_domains` rows and candidate users, no user excluded by Requirement 8 Criterion 1 appears in a `GET /api/users/available` response to a caller who is not a Global_Manager.
3. THE Repository SHALL contain a Vitest test asserting that editing First Name after the Suffix_Field has been auto-filled and then moving focus out of First Name results in a Suffix_Field value derived from the new First Name.
4. THE Repository SHALL contain a Vitest test asserting that a Suffix_Preview issued while the Suffix_Field holds an Admin_Typed_Suffix carries that value as `callsignSuffix` and leaves the Suffix_Field's value unchanged when the response returns.
5. THE Repository SHALL contain a Vitest test asserting that activating the Recompute_Control while the Suffix_Field holds an Admin_Typed_Suffix issues a Suffix_Preview omitting `callsignSuffix` and replaces the field's value with the response's `suffix`.
6. THE Repository SHALL contain a Vitest test asserting that a Suffix_Preview response holding `required` of `true` disables the Recompute_Control and leaves an Admin_Typed_Suffix unchanged.
7. THE Repository SHALL contain a Vitest test asserting that an out-of-order Suffix_Preview response is discarded and does not overwrite the Suffix_Field value written by the most recently issued Suffix_Preview.
8. THE Repository SHALL contain a Vitest test asserting that a failed Suffix_Preview leaves the Suffix_Field unchanged and leaves the Add_Member_Dialog's submit control operable.
9. THE Repository SHALL contain Jest tests asserting that `GET /api/users/available` returns an empty `users` array and `scope.domainsConfigured` of `false` for a Team_Admin whose Organisation holds no `org_allowed_domains` row, and returns the matching users and `scope.domainsConfigured` of `true` once such a row exists.
10. THE Repository SHALL contain Jest tests asserting that `GET /api/users/search` and `GET /api/users` exclude a user outside the caller's Scoped_Organisations and include that user for a Global_Manager.
11. THE Repository SHALL contain a Jest test asserting that an Allowed_Domain appearing in Excluded_Domains grants no visibility.
12. THE Repository SHALL contain a Vitest test asserting that an empty available-users list caused by `scope.domainsConfigured` of `false` displays the Organisation name and the domain-configuration statement, and not the "all users are already in teams" statement.
13. THE Repository SHALL contain a Jest test asserting that the `users.origin_org_id` migration leaves every pre-existing `users` row's other column values unchanged and sets `origin_org_id` to `NULL`.
14. THE Repository SHALL sustain the statement coverage threshold of 60 percent enforced by the existing CI configuration after the additions described in Criteria 1 through 13.
15. WHEN the full verification set is run after the changes of this specification, THE Repository SHALL report no fewer than 79 passing server suites and 1464 passing server tests, no fewer than 17 passing client files and 225 passing client tests, no fewer than 3 passing integration suites and 40 passing integration tests, and SHALL report no more than `157 problems (145 errors, 12 warnings)` from the lint step.

## Correctness Properties

These are the property-based assertions the design phase is expected to carry into `design.md`, stated here because the absence of the first two is what allowed both defects to ship.

**P1 — a recompute reflects the current names (Requirement 15.1, 1.6, 3.1)**
For any two name pairs `(f1, l1)` and `(f2, l2)` with distinct Computed_Suffix values, and any Callsign_Name_Format other than `user_defined`: entering `(f1, l1)`, allowing the Suffix_Field to auto-fill, then entering `(f2, l2)` and triggering a Recompute yields a Suffix_Field value equal to `computeDefaultCallsignSuffix(f2, l2, format)`. This is the assertion that fails on today's code.

**P2 — no auto-filled value is ever echoed (Requirement 3.1, 3.2)**
For any sequence of blur events with no intervening edit of the Suffix_Field, every Suffix_Preview request body omits `callsignSuffix`.

**P3 — recompute is idempotent (Requirement 1.6)**
For any name pair, two consecutive Recomputes with no intervening edit yield the same Suffix_Field value.

**P4 — a typed suffix is preserved (Requirement 4.1)**
For any non-empty Admin_Typed_Suffix and any subsequent sequence of name edits and name-field blurs, the Suffix_Field's value remains that Admin_Typed_Suffix until the Recompute_Control is activated or the dialog is reset.

**P5 — the checked value is the assigned value (Requirement 5.1, 5.3)**
For any request body, the value `POST /api/users/callsign-suffix-preview` reports as `suffix` or `conflict.value` equals the value `POST /api/users/create-and-add` would store as `callsign_suffix` for the same body.

**P6 — no cross-organisation disclosure (Requirement 15.2, 8.1, 8.2)**
For any set of Organisations, `org_allowed_domains` rows, and users, and any caller who is not a Global_Manager, every user in a Directory_Route response satisfies at least one condition of Requirement 8 Criterion 1 for an Organisation in that caller's Scoped_Organisations.

**P7 — fail closed on an unconfigured organisation (Requirement 9.1, 9.2)**
For any caller who is not a Global_Manager and whose Scoped_Organisations holds no Organisation with a usable Allowed_Domain, the `users` array of a `GET /api/users/available` response is empty.

**P8 — a Global_Manager's view is a superset (Requirement 10.1, 10.2)**
For any Database state and any Directory_Route, the set of users returned to a Global_Manager contains the set returned to any caller who is not a Global_Manager.

**P9 — scoping is read-only (Requirement 12.5)**
For any Directory_Route call, the `users`, `user_cache`, and `org_allowed_domains` tables hold the same rows before and after.
