# Implementation Plan: Sign-Up Flow Rework

## Overview

This plan implements the two-step email-verified sign-up flow with sign-up codes, org-level domain restrictions, and an org interest request fallback. Tasks are ordered by dependency: schema migrations first (tables must exist), then services (depend on schema), then routes (depend on services + permissions), then client components (depend on routes). Property-based tests use `fast-check` via Vitest and target pure logic layers.

Tasks marked with `*` are optional test sub-tasks and are not implemented as part of automated task execution unless explicitly requested.

## Tasks

### Phase 1: Schema Migrations

- [x] 1. Database schema migrations
  - [x] 1.1 Write migration creating the `signup_codes` table (id SERIAL PK, team_id INTEGER UNIQUE NOT NULL REFERENCES teams ON DELETE CASCADE, code VARCHAR(8) UNIQUE NOT NULL, created_by INTEGER NOT NULL REFERENCES users, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) with index on `code`
    - Use `node-pg-migrate` in `database/migrations/`
    - Follow existing naming convention: `{timestamp}_create-signup-codes.cjs`
    - _Requirements: 7.1_
  - [x] 1.2 Write migration creating the `org_allowed_domains` table (id SERIAL PK, org_id INTEGER NOT NULL REFERENCES teams ON DELETE CASCADE, domain VARCHAR(255) NOT NULL, UNIQUE(org_id, domain)) with index on `org_id`
    - _Requirements: 7.2_
  - [x] 1.3 Write migration creating the `org_interest_requests` table (id SERIAL PK, email VARCHAR(255) NOT NULL, first_name VARCHAR(255), last_name VARCHAR(255), org_name VARCHAR(255) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) with index on (email, status)
    - _Requirements: 7.3_
  - [x] 1.4 Write migration adding nullable `signup_code_used` VARCHAR(8) column to the `access_requests` table
    - _Requirements: 7.4_
  - [x] 1.5 Write migration seeding `excluded_email_domains` key in `system_config` table as an empty JSON array
    - _Requirements: 7.5_

### Phase 2: Sign-Up Code Service

- [x] 2. Implement SignupCodeService
  - [x] 2.1 Create `server/services/SignupCodeService.js` with static methods `generateRandomCode()`, `formatCode(raw)`, `isValidCodeFormat(input)` using the 30-character set `ABCDEFGHJKMNPQRSTUVWXYZ23456789` and `crypto.randomBytes`
    - _Requirements: 3.1, 3.2_
  - [x] 2.2 Add instance methods `generateCode(teamId, createdBy)`, `revokeCode(teamId)`, `getCode(teamId)`, `resolveCode(rawCode)` with database operations (transaction for generate, retry on unique violation, enforce can_join check)
    - _Requirements: 3.2, 3.3, 3.5, 3.6, 3.7_
  - [x] 2.3 Add `generateQrPng(code)` using the `qrcode` npm package and `generatePdf(code, teamName)` using `pdfkit`
    - Install `qrcode` and `pdfkit` packages
    - _Requirements: 3.9, 3.10_
  - [ ]* 2.4 Write property tests for SignupCodeService pure functions
    - **Property 1: Code generation produces valid format** — For any invocation, output is exactly 8 chars from the valid charset
    - **Property 2: Code format validation round-trip** — For any generated code, formatCode then strip dash reproduces original
    - **Validates: Requirements 3.1, 3.11**
  - [ ]* 2.5 Write unit tests for SignupCodeService database methods
    - Test generate replaces existing code (one code per team), revoke deletes, resolveCode lookup, can_join enforcement
    - _Requirements: 3.3, 3.5, 3.6, 3.7_

- [x] 3. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 3: Sign-Up Flow Service and Org Interest Service

- [x] 4. Implement SignupFlowService
  - [x] 4.1 Create `server/services/SignupFlowService.js` with `determineEmailState(email)` implementing the priority chain: active → pending_approval → pending_verification_valid → pending_verification_expired → new
    - _Requirements: 1.8, 1.9, 1.10, 1.11, 1.12_
  - [x] 4.2 Implement `initiateSignup(email, code)` that determines state, performs the correct action per state (generate token, resend token, send info email, send account email), and always returns `{message: "Check your email to continue"}`
    - Use existing `EmailService` patterns for sending branded emails
    - _Requirements: 1.2, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 10.1, 10.2, 10.3_
  - [x] 4.3 Implement `getAvailableTeams(token, code)` with the team filtering query combining can_join + code visibility + org domain restrictions using the LATERAL JOIN CTE from the design
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_
  - [x] 4.4 Implement `submitTeamAccess({token, firstName, lastName, teamId})` that validates the token, verifies the team is eligible, creates the access_request record (with signup_code_used if applicable), and consumes the token
    - _Requirements: 1.14, 2.10, 8.3_
  - [ ]* 4.5 Write property tests for SignupFlowService
    - **Property 3: Uniform API response** — For any email state, initiateSignup returns identical response shape
    - **Property 5: Team filtering — can_join invariant** — All returned teams have can_join = true
    - **Property 6: Team filtering — code visibility** — Code-protected teams only appear with matching code
    - **Property 7: Team filtering — domain restrictions** — Teams in restricted orgs excluded for non-matching domains
    - **Property 8: Domain restrictions apply even with sign-up code** — Code does not bypass domain restrictions
    - **Validates: Requirements 1.7, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 10.1, 10.2, 10.3**
  - [ ]* 4.6 Write unit tests for SignupFlowService
    - Test each email state path, token expiry handling, token consumption on POST only (Property 4)
    - _Requirements: 1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 1.14_

- [x] 5. Implement OrgInterestService
  - [x] 5.1 Create `server/services/OrgInterestService.js` with `submitRequest({token, firstName, lastName, orgName})`, `listRequests(filters)`, `updateStatus(requestId, newStatus)`, and `isExcludedDomain(email)`
    - Enforce at most one pending request per email
    - Read excluded domains from `system_config` table
    - Consume verification token on submit
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 5.7, 5.8, 6.3, 6.4_
  - [ ]* 5.2 Write property tests for OrgInterestService
    - **Property 9: Excluded domains block only org interest requests** — Excluded domain emails rejected for org interest but not team signup
    - **Property 11: At most one pending org interest per email** — Duplicate pending submissions rejected
    - **Validates: Requirements 5.5, 5.7, 6.3**
  - [ ]* 5.3 Write unit tests for OrgInterestService
    - Test excluded domain check, duplicate rejection, status transitions
    - _Requirements: 5.5, 5.7, 5.8_

- [x] 6. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 4: Permission Registry and Route Handlers

- [x] 7. Register permissions and implement sign-up code routes
  - [x] 7.1 Add permission entries to the permission registry for all new endpoints: `signup_code:manage`, `signup_code:read`, `org:domains:read`, `org:domains:manage`, `admin:excluded_domains:manage`, `admin:org_interest:read`, `admin:org_interest:manage`
    - Add row-scoped resolvers in `authorize.js` per design (Team_Admin/Org_Admin/Global_Admin for signup_code, Org_Admin/Global_Admin for org:domains, Global_Admin only for admin:*)
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 8.9, 8.10, 8.11, 8.12, 8.14_
  - [x] 7.2 Create `server/routes/signupCodes.js` with authenticated routes: POST `/api/signup-codes/generate`, GET `/api/signup-codes/:teamId`, DELETE `/api/signup-codes/:teamId`, GET `/api/signup-codes/:teamId/qr`, GET `/api/signup-codes/:teamId/pdf`
    - Wire to SignupCodeService methods
    - Include express-validator chains for teamId param
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 8.8_
  - [ ]* 7.3 Write unit tests for signupCodes routes
    - Test permission enforcement, validation, error responses
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 8.8_

- [x] 8. Implement public sign-up routes
  - [x] 8.1 Create `server/routes/signup.js` with public routes: POST `/api/requests/initiate`, GET `/api/requests/available-teams`, POST `/api/requests/team-access`, POST `/api/org-interest`
    - Apply `requestAccessLimiter` + `verifyCaptcha` middleware to initiate endpoint
    - Include express-validator chains for all inputs
    - Wire to SignupFlowService and OrgInterestService
    - _Requirements: 1.3, 8.1, 8.2, 8.3, 8.13_
  - [ ]* 8.2 Write unit tests for signup routes
    - Test validation, rate limiting passthrough, CAPTCHA enforcement, error responses
    - _Requirements: 1.3, 1.5, 8.1, 8.2, 8.3, 8.13_

- [x] 9. Implement org domains and admin routes
  - [x] 9.1 Create `server/routes/orgDomains.js` with authenticated routes: GET `/api/orgs/:orgId/domains`, PUT `/api/orgs/:orgId/domains`, GET `/api/admin/excluded-domains`, PUT `/api/admin/excluded-domains`, GET `/api/admin/org-interest`, PATCH `/api/admin/org-interest/:id`
    - Validate orgId references a root team (parent_team_id IS NULL)
    - Wire domain operations directly to `org_allowed_domains` table
    - Wire excluded domains to `system_config` table
    - Wire org interest to OrgInterestService
    - _Requirements: 4.4, 4.5, 6.1, 6.2, 8.9, 8.10, 8.11, 8.12, 8.14_
  - [ ]* 9.2 Write unit tests for orgDomains routes
    - Test permission enforcement, root-team validation, domain format validation
    - _Requirements: 4.4, 4.5, 6.1, 6.2_

- [x] 10. Wire can_join=false trigger to delete sign-up codes
  - [x] 10.1 In the existing `Team.update` flow (or `PUT /api/teams/:teamId` handler in `server/routes/teams.js`), when `can_join` is set to `false`, delete the team's active sign-up code from `signup_codes` table
    - _Requirements: 3.3, 3.4_
  - [ ]* 10.2 Write unit test confirming can_join=false deletes the associated sign-up code
    - _Requirements: 3.3, 3.4_

- [x] 11. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 5: Client Components

- [x] 12. Rework RequestAccess page for two-step flow
  - [x] 12.1 Rework `client/src/pages/RequestAccess.jsx` to implement the two-step state machine: EmailStep → SubmittedStep (on email submit), TeamSelectionStep (on verify link click), NoTeamsStep (when list empty), SubmitSuccess, OrgInterestSubmitted, ExpiredStep
    - Parse `?code=X` from URL and pre-fill code field
    - Client-side code format validation (8 chars from valid set, optional dash)
    - Step 1: email + optional code form with CAPTCHA
    - Step 2: first name, last name, team dropdown (fetched from `/api/requests/available-teams`)
    - Display appropriate messages for empty list, code mismatch, expired token
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 2.1, 2.8, 2.9, 2.10, 2.11, 9.1_
  - [ ]* 12.2 Write Vitest component tests for RequestAccess page
    - Test step transitions, code pre-fill, validation errors, empty team list → org interest form
    - _Requirements: 1.1, 1.4, 2.8, 2.11_

- [x] 13. Implement SignupCodeManager component
  - [x] 13.1 Create `client/src/components/SignupCodeManager.jsx` — panel for team detail page showing: current code (formatted), Copy URL button, Download QR button, Download PDF button, Generate/Regenerate button, Revoke button
    - Show confirmation dialogs for generate ("will hide team from general list") and revoke
    - Only render for users with appropriate team admin permissions
    - _Requirements: 3.9, 3.10, 3.12, 9.2_
  - [ ]* 13.2 Write Vitest component tests for SignupCodeManager
    - Test generate confirmation, revoke flow, button states
    - _Requirements: 3.9, 3.12_

- [x] 14. Implement OrgDomainManager component
  - [x] 14.1 Create `client/src/components/OrgDomainManager.jsx` — domain list editor for org admins showing current domains with add/remove, bulk save via PUT
    - Only render for users with org admin permissions
    - _Requirements: 4.4, 9.3_
  - [ ]* 14.2 Write Vitest component tests for OrgDomainManager
    - Test add/remove domain, save flow
    - _Requirements: 4.4_

- [ ] 15. Implement admin panels (ExcludedDomainsManager + OrgInterestRequests)
  - [x] 15.1 Create `client/src/components/ExcludedDomainsManager.jsx` — global admin panel to view/edit the excluded domains list
    - _Requirements: 6.1, 6.2, 9.4_
  - [x] 15.2 Create `client/src/components/OrgInterestRequests.jsx` — global admin panel showing org interest requests with status management (pending → actioned/dismissed)
    - _Requirements: 5.6, 5.8, 9.5_
  - [ ]* 15.3 Write Vitest component tests for admin panels
    - Test list rendering, status transitions
    - _Requirements: 5.6, 6.1_

- [x] 16. Wire can_join toggle confirmation in team edit UI
  - [x] 16.1 In the team edit dialog/form, when `can_join` is toggled to false and the team has an active sign-up code, show a confirmation dialog: "This team has an active sign-up code. Disabling join requests will permanently delete the code and invalidate all distributed links and QR codes. Continue?"
    - _Requirements: 3.4_
  - [ ]* 16.2 Write Vitest component test for can_join toggle confirmation
    - _Requirements: 3.4_

- [x] 17. Checkpoint - Ensure all tests pass, ask the user if questions arise.

### Phase 6: Integration and Wiring

- [x] 18. Install npm packages and register routes
  - [x] 18.1 Install `qrcode` and `pdfkit` npm packages
    - _Requirements: 3.9, 3.10_
  - [x] 18.2 Register new route files in the Express app entry point: `signupCodes.js`, `signup.js`, `orgDomains.js`
    - Ensure authenticated routes use the existing auth middleware
    - Ensure public signup routes are unauthenticated
    - _Requirements: 8.1 through 8.14_

- [ ] 19. Property test for one-code-per-team invariant
  - [ ]* 19.1 Write property test for SignupCodeService (Property 10)
    - **Property 10: At most one active code per team** — After any sequence of generate/regenerate, at most one row exists per team_id
    - **Validates: Requirements 3.5**

- [x] 20. Final checkpoint - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1–11)
- Unit tests validate specific examples and edge cases
- The `qrcode` and `pdfkit` packages are installed in Phase 6 but used in Phase 2 (task 2.3) — if running linearly, task 18.1 should be done before 2.3 or the install can be done as a prerequisite
- Sign-up codes have NO expiration — the `signup_codes` table has no `expires_at` column by design
- The excluded domains list blocks org interest requests ONLY, not regular team sign-up

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "18.1"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5"] },
    { "id": 3, "tasks": ["4.1", "5.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "5.2", "5.3"] },
    { "id": 5, "tasks": ["4.5", "4.6", "7.1"] },
    { "id": 6, "tasks": ["7.2", "8.1", "9.1", "10.1"] },
    { "id": 7, "tasks": ["7.3", "8.2", "9.2", "10.2", "18.2", "19.1"] },
    { "id": 8, "tasks": ["12.1", "13.1", "14.1", "15.1", "15.2", "16.1"] },
    { "id": 9, "tasks": ["12.2", "13.2", "14.2", "15.3", "16.2"] }
  ]
}
```
