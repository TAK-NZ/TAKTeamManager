# Requirements Document

## Introduction

This feature reworks the existing single-step public access request flow into a two-step email-first sign-up flow. The new flow introduces sign-up codes for direct team links, org-level email domain restrictions to control who can join teams within an organisation, and an "org interest request" fallback for users whose email domain doesn't match any available team.

## Glossary

- **Sign_Up_Flow**: The two-step public registration process where a user first verifies their email, then selects a team to join.
- **Sign_Up_Code**: An 8-character uppercase alphanumeric code (character set: ABCDEFGHJKMNPQRSTUVWXYZ23456789) associated with exactly one team, used to direct users to a specific team during sign-up. Sign-up codes have NO expiration and remain active indefinitely until explicitly revoked or regenerated.
- **Org**: A root-level team (a row in the `teams` table with `parent_team_id IS NULL`) representing an organisation.
- **Org_Allowed_Domains**: A list of email domains configured per org that restrict which users can sign up for teams within that org.
- **Excluded_Domains**: A global list of consumer/freemail domains (e.g. gmail.com, yahoo.com) that blocks org interest requests ONLY. It does NOT prevent regular team sign-up.
- **Org_Interest_Request**: A fallback request submitted by a verified user when no teams are available, expressing interest in having their organisation onboarded.
- **Visible_Branch_Rule**: The existing rule that governs INTERNAL visibility for logged-in users within the app. It excludes teams with a private ancestor from lists shown to logged-in users. This rule does NOT apply to the external sign-up flow — for external sign-up, team filtering is based solely on: `can_join` flag, sign-up code matching, and org-level domain restrictions. A team's private/public visibility setting does NOT affect its appearance in the external sign-up flow.
- **Verification_Token**: A cryptographic token sent via email to prove ownership of an email address during sign-up. Tokens expire after 24 hours. A token is consumed only when a POST request creates a record (team access request or org interest request). GET requests using the token for read-only operations do not consume it.
- **Team_Admin**: A user with administrative privileges for a specific team.
- **Org_Admin**: A user with administrative privileges for an organisation (root team).
- **Global_Admin**: A user with system-wide administrative privileges.

## Requirements

### Requirement 1: Email Verification Step

**User Story:** As a prospective user, I want to verify my email address as the first step of sign-up, so that only legitimate email owners can proceed to request team access.

#### Acceptance Criteria

1. WHEN a user visits the sign-up page, THE Sign_Up_Flow SHALL display only an email address field and an optional sign-up code field.
2. WHEN a user submits a valid email address, THE Sign_Up_Flow SHALL send a verification email using the existing branded email template pattern.
3. WHEN a user submits the email form, THE Sign_Up_Flow SHALL validate the submission with CAPTCHA protection before processing.
4. WHEN a sign-up code is provided via the URL query parameter `code`, THE Sign_Up_Flow SHALL pre-fill the sign-up code field with the provided value.
5. IF a user submits an invalid email address format, THEN THE Sign_Up_Flow SHALL reject the submission and display a validation error.
6. WHEN a user enters a sign-up code at Step 1, THE Sign_Up_Flow SHALL validate the code format client-side (exactly 8 characters from the valid character set, with optional dash separating the two groups of 4). Invalid format SHALL be rejected with a field-level validation error before form submission. This does not leak information since the code FORMAT is public knowledge (printed on QR posters). Whether a specific code EXISTS is never revealed until after email verification.
7. WHEN a user submits an email at Step 1, THE Sign_Up_Flow SHALL ALWAYS display the same response message ("Check your email to continue") regardless of the email's state in the system.

#### Email State Handling

The system determines backend behaviour based on the email's current state. In ALL cases, the website displays the same message: "Check your email to continue."

8. **New email** (no account, no pending request): THE system SHALL generate a new verification token, store the pending verification state, and send a verification email with the token link.
9. **Pending verification, token still valid** (Step 1 completed, Step 2 not completed, token not expired): THE system SHALL re-send the verification email with the SAME still-valid token. No new token is issued.
10. **Pending verification, token expired** (Step 1 completed, Step 2 not completed, token expired): THE system SHALL invalidate the old token, issue a new token, and send a new verification email with the new token link.
11. **Pending approval** (Step 2 submitted, token consumed, request awaiting admin decision): THE system SHALL send a "your request is still being reviewed" informational email. No verification link is included.
12. **Active account** (already approved/created): THE system SHALL send a "you already have an account" email with a password reset link. No verification link is included.

#### Verification Token Lifecycle

13. Verification tokens SHALL expire after 24 hours.
14. A verification token is consumed (invalidated) ONLY on POST requests that create a record (team access request or org interest request). GET requests using the token for read-only operations (e.g., fetching available teams) do NOT consume it.
15. Sign-up codes (separate from verification tokens) SHALL have NO expiration and remain active indefinitely.

#### Information Security

16. THE system SHALL comply with the information security requirements defined in Requirement 10.

### Requirement 2: Team Selection Step

**User Story:** As a verified user, I want to see a filtered list of available teams after verifying my email, so that I can select a team to join.

#### Acceptance Criteria

1. WHEN a user clicks the verification link, THE Sign_Up_Flow SHALL display a second form with first name, last name, and a filtered list of joinable teams.
2. THE Sign_Up_Flow SHALL include only teams with `can_join = true` in the team selection list.
3. Teams with an active sign-up code in the `signup_codes` table SHALL be excluded from the general team selection list unless the user's verification session has a matching code.
4. WHILE a sign-up code is associated with the verification session, THE Sign_Up_Flow SHALL display the team matching that code (provided it passes domain restrictions) plus any teams with no active code that satisfy other filters.
5. THE Sign_Up_Flow SHALL exclude teams belonging to orgs whose allowed domain list does not include the verified email's domain.
6. A sign-up code does NOT bypass org-level email domain restrictions. If the coded team's org has an allowed domain list and the user's email domain is not in it, the team SHALL NOT appear even with a valid code.
7. THE Sign_Up_Flow SHALL include teams belonging to orgs with no domain restrictions regardless of the user's email domain.
8. WHEN the filtered team list is empty, THE Sign_Up_Flow SHALL display the message "No teams are currently available for sign-up with this email address" and offer the org interest request form.
9. WHEN a sign-up code was provided but the user's email domain does not match the code's team's org domain restriction, THE Sign_Up_Flow SHALL display "The team associated with this code requires an email address from that organisation".
10. WHEN a user submits the team selection form with first name, last name, and a selected team, THE Sign_Up_Flow SHALL create an access request record linked to the verification token.
11. WHEN a user clicks an expired or invalid verification link, THE Sign_Up_Flow SHALL display "This link has expired. Please start the sign-up process again." with a link back to Step 1.

### Requirement 3: Sign-Up Code Management

**User Story:** As a team admin, I want to generate and manage a sign-up code for my team, so that I can share a direct link for prospective users to join.

#### Acceptance Criteria

1. THE Sign_Up_Code SHALL be 8 characters from the set ABCDEFGHJKMNPQRSTUVWXYZ23456789, formatted as two groups of 4 separated by a dash for display (e.g. "4KP7-NXRM").
2. THE Sign_Up_Code SHALL be globally unique across all teams.
3. A sign-up code can only be generated for a team with `can_join = true`.
4. WHEN an admin sets `can_join` to `false` on a team with an active sign-up code, THE UI SHALL display a confirmation prompt: "This team has an active sign-up code. Disabling join requests will permanently delete the code and invalidate all distributed links and QR codes. Continue?" If confirmed, THE system SHALL delete the code.
5. WHEN a Team_Admin, Org_Admin, or Global_Admin generates a code, THE system SHALL create at most one active code per team, replacing any previously active code.
6. WHEN a Team_Admin, Org_Admin, or Global_Admin revokes a code, THE system SHALL delete the team's active code.
7. WHEN a Team_Admin, Org_Admin, or Global_Admin regenerates a code, THE system SHALL replace the existing code with a new randomly generated code.
8. THE Sign_Up_Code SHALL remain active indefinitely until explicitly revoked or regenerated.
9. WHEN a code is displayed in the management UI, THE system SHALL show the formatted code, a "Copy URL" button, a "Download QR Code (PNG)" button, and a "Download PDF" button.
10. THE Sign_Up_Code PDF download SHALL include the TAK.NZ logo, the QR code image, the full sign-up URL, and brief sign-up instructions.
11. THE sign-up URL format SHALL be `{FRONTEND_URL}/request-access?code={CODE_WITHOUT_DASH}`.
12. WHEN an admin generates a sign-up code for a team, THE UI SHALL display a confirmation message: "Generating a code will hide this team from the general sign-up list. Users will need this code to find your team during sign-up."

### Requirement 4: Org-Level Email Domain Restrictions

**User Story:** As an org admin, I want to restrict team sign-ups to users with specific email domains, so that only authorised personnel from my organisation can join our teams.

#### Acceptance Criteria

1. THE Org_Allowed_Domains list SHALL apply to all teams within that org, including sub-teams at any depth.
2. WHEN an org has no configured allowed domains, THE system SHALL allow any email domain to sign up for teams within that org.
3. WHEN a user's email domain does not match any entry in an org's allowed domain list, THE Sign_Up_Flow SHALL exclude all teams within that org from the team selection list.
4. WHEN an Org_Admin or Global_Admin updates the allowed domains for an org, THE system SHALL persist the changes to the `org_allowed_domains` table.
5. THE system SHALL prevent sub-teams from overriding their parent org's domain restrictions.

### Requirement 5: Org Interest Request Fallback

**User Story:** As a user with no available teams, I want to express interest in having my organisation onboarded, so that a global admin can consider adding my organisation.

#### Acceptance Criteria

1. WHEN no teams are available for a verified user's email, THE Sign_Up_Flow SHALL offer an org interest request form with first name, last name, and organisation name fields.
2. THE org interest request form SHALL display the verified email address as a pre-filled, read-only field.
3. WHEN a user submits an org interest request, THE system SHALL create a record in the `org_interest_requests` table with status 'pending'.
4. WHEN an org interest request is submitted, THE system SHALL notify global admins via email or the admin panel.
5. WHEN a user's email domain is in the Excluded_Domains list, THE Sign_Up_Flow SHALL prevent submission of the org interest request form and display "Please use an organisational email address to request a new organisation".
6. WHEN a Global_Admin views the admin panel, THE system SHALL display a list of org interest requests with their status.
7. THE system SHALL allow at most one pending org interest request per email address. If a user with the same email submits again while a pending request exists, the system SHALL inform them that a request is already pending.

#### Org Interest Request Lifecycle

8. Org interest requests are informational leads for global admins. Status transitions are limited to: pending → actioned (manually marked by a global admin after out-of-band follow-up) or pending → dismissed. No automated actions (such as auto-creating an org) are triggered by status changes. Full org onboarding remains a manual process outside this feature's scope.

### Requirement 6: Excluded Domains Management

**User Story:** As a global admin, I want to maintain a list of consumer/freemail domains that are blocked from submitting org interest requests, so that only organisational email addresses are used for new org onboarding.

#### Acceptance Criteria

1. WHEN a Global_Admin accesses excluded domains management, THE system SHALL display the current list of excluded email domains.
2. WHEN a Global_Admin updates the excluded domains list, THE system SHALL persist the changes to the `system_config` table as a JSON array.
3. THE Excluded_Domains list SHALL ONLY apply to the org interest request form. It does NOT prevent regular team sign-up. Users with excluded-domain emails can still sign up for any team that passes the standard filters (can_join + domain match + code match).
4. THE system SHALL store the excluded domains in a `system_config` entry with the key `excluded_email_domains`.

### Requirement 7: Schema Changes

**User Story:** As a developer, I want the database schema extended to support sign-up codes, org domain restrictions, and org interest requests, so that the new sign-up flow has proper data persistence.

#### Acceptance Criteria

1. THE system SHALL provide a `signup_codes` table with columns: id (primary key), team_id (unique, references teams), code (VARCHAR(8), unique, NOT NULL), created_by (references users), and created_at (timestamp).
2. THE system SHALL provide an `org_allowed_domains` table with columns: id (primary key), org_id (references teams), domain (VARCHAR(255), NOT NULL), with a unique constraint on (org_id, domain).
3. THE system SHALL provide an `org_interest_requests` table with columns: id (primary key), email (VARCHAR(255), NOT NULL), first_name (VARCHAR(255)), last_name (VARCHAR(255)), org_name (VARCHAR(255), NOT NULL), status (VARCHAR(20), DEFAULT 'pending'), and created_at (timestamp).
4. THE system SHALL add a nullable `signup_code_used` column (VARCHAR(8)) to the `access_requests` table to track which code was used during sign-up.
5. THE system SHALL store excluded email domains as a JSON array in the existing `system_config` table under the key `excluded_email_domains`.

### Requirement 8: API Endpoints

**User Story:** As a developer, I want well-defined API endpoints for the new sign-up flow, so that the frontend can interact with the backend for all sign-up operations.

#### Acceptance Criteria

1. WHEN a POST request is made to `/api/requests/initiate` with an email and optional code, THE system SHALL validate the input, determine the email's state (per Requirement 1 Email State Handling), and send the appropriate email.
2. WHEN a GET request is made to `/api/requests/available-teams` with a valid verification token, THE system SHALL return the filtered team list applying all domain, code, and can_join filters.
3. WHEN a POST request is made to `/api/requests/team-access` with a verification token, first name, last name, and team selection, THE system SHALL create the access request record and consume the token.
4. WHEN a POST request is made to `/api/signup-codes/generate` by an authenticated Team_Admin, Org_Admin, or Global_Admin, THE system SHALL generate and return a new sign-up code for the specified team.
5. WHEN a DELETE request is made to `/api/signup-codes/:teamId` by an authenticated Team_Admin, Org_Admin, or Global_Admin, THE system SHALL revoke the team's active code.
6. WHEN a GET request is made to `/api/signup-codes/:teamId` by an authenticated Team_Admin, Org_Admin, or Global_Admin, THE system SHALL return the team's current active code.
7. WHEN a GET request is made to `/api/signup-codes/:teamId/qr` by an authenticated Team_Admin, Org_Admin, or Global_Admin, THE system SHALL return a QR code PNG encoding the sign-up URL.
8. WHEN a GET request is made to `/api/signup-codes/:teamId/pdf` by an authenticated Team_Admin, Org_Admin, or Global_Admin, THE system SHALL return a branded PDF containing the TAK.NZ logo, QR code, URL, and sign-up instructions.
9. WHEN a GET request is made to `/api/orgs/:orgId/domains` by an authenticated Org_Admin or Global_Admin, THE system SHALL return the org's allowed domain list.
10. WHEN a PUT request is made to `/api/orgs/:orgId/domains` by an authenticated Org_Admin or Global_Admin, THE system SHALL update the org's allowed domain list.
11. WHEN a GET request is made to `/api/admin/excluded-domains` by an authenticated Global_Admin, THE system SHALL return the excluded domains list.
12. WHEN a PUT request is made to `/api/admin/excluded-domains` by an authenticated Global_Admin, THE system SHALL update the excluded domains list.
13. WHEN a POST request is made to `/api/org-interest` with a valid verification token and form data, THE system SHALL create an org interest request record and consume the token.
14. WHEN a GET request is made to `/api/admin/org-interest` by an authenticated Global_Admin, THE system SHALL return the list of org interest requests.

### Requirement 9: Client UI Changes

**User Story:** As a developer, I want the React frontend updated to support the new multi-step sign-up flow and admin management interfaces, so that users and admins can interact with the new features.

#### Acceptance Criteria

1. WHEN the sign-up page loads, THE Sign_Up_Flow client SHALL render a two-step form: Step 1 for email and optional code, Step 2 for name and team selection.
2. WHEN a Team_Admin or Org_Admin views the Team Detail page for their team, THE system SHALL display sign-up code management controls (generate, revoke, copy URL, download QR, download PDF).
3. WHEN an Org_Admin views the org's Team Detail page or Edit dialog, THE system SHALL display domain restriction management controls.
4. WHEN a Global_Admin views the Admin page, THE system SHALL display an excluded domains management section.
5. WHEN a Global_Admin views the Admin page or Requests page, THE system SHALL display an org interest requests section with the ability to view and manage requests.

### Requirement 10: Information Security

**User Story:** As a security-conscious system, I want to prevent information leakage during the sign-up flow, so that unauthenticated users cannot enumerate accounts or discover whether email addresses exist in the system.

#### Acceptance Criteria

1. WHEN a user submits an email at Step 1, THE Sign_Up_Flow SHALL ALWAYS display the same response message ("Check your email to continue") regardless of whether the email already has an account, has a pending request, or is new.
2. THE public-facing form SHALL never reveal whether an email address exists in the system through response timing, error messages, or HTTP status codes.
3. ALL email state handling (new, pending verification, pending approval, active account) SHALL produce identical HTTP response codes and response bodies to the client.
4. THE system SHALL use constant-time comparison or equivalent timing-safe approaches where applicable to prevent timing-based enumeration.
5. Sign-up code FORMAT validation (Fix 7 in Requirement 1) does not violate information security because the code format is public knowledge. Whether a specific code EXISTS in the system is never revealed until after email verification.
