# Requirements Document

## Introduction

This document specifies two related admin-facing UI features that surface **existing, backend-complete** capability in the Global_Manager `/admin` page (`client/src/pages/Admin.jsx`):

- **Feature A - Email Template Editor**: lets a Global_Manager view and edit the app's seeded email templates, preview which `{{variable}}` placeholders each template accepts, and send a test copy of a template to their own address, all from `/admin`.
- **Feature B - Settings Export / Import**: lets a Global_Manager export all portable, allow-listed settings (and email templates) to a downloadable archive, and later import them back into the same or a fresh environment.

Both features are almost entirely **Client-side** work. The server routes they call already exist, are mounted, and are tested:

- `GET /api/communications/templates/:key`, `PUT /api/communications/templates/:key`, and `POST /api/communications/test-email` (in `server/routes/communications.js`, Global_Manager-only via `authorize`).
- `GET /api/settings/export` and `POST /api/settings/import` (in `server/routes/settings.js`, Global_Manager-only).

This document introduces **NO new server route, middleware, or database behavior** with a single, explicitly-scoped exception: an optional `GET /api/communications/templates` list endpoint (Requirement 2) that returns all seeded template rows so the Template_Editor has a single source of truth for the set of template keys. Every other requirement in this document concerns the behavior of the Client (`client/src`) only.

**Scope boundary (what this is NOT):** Feature B is **configuration portability and defense-in-depth for settings**, not disaster recovery for domain data. It does NOT export, import, or otherwise back up organizations, teams, members, channels, access requests, or audit logs. An operator who mistakes the Exported_Archive for a full database backup would lose all domain data on a fresh restore; this document therefore requires the UI to state that boundary. Additionally, secrets (specifically the TAK Server passphrase) are excluded from the Exported_Archive by design, so restoring into a fresh environment always requires re-entering them.

## Glossary

- **Client**: The React single-page application in `client/src`.
- **Global_Manager**: A user whose cached `is_global_manager` attribute is true. Real access control for every endpoint named here is enforced server-side by the existing `authorize` middleware; the Client gates visibility only.
- **Admin_Page**: The Client page component rendered at the `/admin` route (`client/src/pages/Admin.jsx`), gated on `user?.isAdmin`.
- **Communications_API_Client**: The Client module that issues requests to the communications template and test-email endpoints (a new `communicationsAPI` object in `client/src/services/api.js`).
- **Settings_API_Client**: The Client module that issues requests to the settings export and import endpoints (a new `settingsAPI` object in `client/src/services/api.js`).
- **Template_Editor**: The Admin_Page section that lists Email_Templates, loads a selected template, and edits and saves its subject and body.
- **Email_Template**: A row of the `email_templates` table, identified by its `template_key`, carrying `subject_template`, `body_template`, `description`, and `updated_at` fields.
- **Template_Key**: The unique string identifier of an Email_Template. The seven currently seeded keys are `access_request_verification`, `access_request_approved`, `access_request_denied`, `admin_notification_digest`, `signup_pending_review`, `signup_already_active`, and `team_transfer_completed`.
- **Template_Variable**: A `{{variable}}` placeholder (e.g. `{{first_name}}`, `{{verification_link}}`) substituted at send time by the server's EmailService.
- **Template_Variable_Hints**: A static, client-side map from a Template_Key to the list of Template_Variables that template is known to use. It is advisory only: the server does not enforce it, and an unknown or omitted variable is left as a literal placeholder at send time.
- **Test_Email_Action**: The Admin_Page control that sends a test copy of a template (via `POST /api/communications/test-email`) to a Global_Manager-supplied address.
- **Settings_Export**: The Admin_Page action that downloads the Exported_Archive from `GET /api/settings/export`.
- **Exported_Archive**: The ZIP file produced by `GET /api/settings/export`, containing `settings.json` (`{ exportedAt, systemConfig, siteConfig }`, allow-listed keys only) and `email_templates.json` (an array of all template rows).
- **Settings_Import**: The Admin_Page action that submits an Import_Payload to `POST /api/settings/import`.
- **Import_Payload**: The single merged JSON object `{ systemConfig, siteConfig, emailTemplates? }` that `POST /api/settings/import` accepts as its request body.
- **Import_Transform**: The client-side pure function that converts a selected import file into an Import_Payload: unzipping an Exported_Archive and merging its two JSON files, or passing through an already-merged raw JSON object.
- **Import_Problem**: A single human-readable string in the `problems` array returned by `POST /api/settings/import` when it rejects an Import_Payload with HTTP 400.
- **Excluded_Secret**: A secret-shaped setting that the export allow-list intentionally omits and the import validator intentionally rejects. The concrete instance is the TAK Server passphrase (`tak_server_p12_passphrase`).

## Requirements

### Requirement 1: Global_Manager-Only Surfacing of Both Features

**User Story:** As a Global_Manager, I want the Template_Editor and the Settings_Export / Settings_Import controls to be reachable only by a Global_Manager, so that a non-Global_Manager user never sees or reaches settings management.

#### Acceptance Criteria

1. WHERE the authenticated user's `is_global_manager` attribute is true, THE Admin_Page SHALL render the Template_Editor section and the Settings_Export / Settings_Import section.
2. WHERE the authenticated user's `is_global_manager` attribute is false, THE Admin_Page SHALL render without the Template_Editor section and without the Settings_Export / Settings_Import section.
3. THE Admin_Page SHALL gate the Template_Editor section and the Settings_Export / Settings_Import section on the same `is_global_manager` condition used to gate the existing Global_Manager-only Admin_Page surfaces.
4. WHERE the authenticated user's `is_global_manager` attribute is false, THE Client SHALL NOT issue a request to any communications template endpoint, the test-email endpoint, the settings export endpoint, or the settings import endpoint from the Admin_Page.

### Requirement 2: Discovering the Set of Template Keys

**User Story:** As a Global_Manager, I want the Template_Editor to present every editable Email_Template, so that I can find and edit any template without knowing its Template_Key in advance.

#### Acceptance Criteria

1. THE Client SHALL obtain the set of editable Template_Keys from a single source of truth rather than from a value duplicated across multiple Client modules.
2. WHERE the optional `GET /api/communications/templates` list endpoint is provided, THE endpoint SHALL return every row of the `email_templates` table with the fields `template_key`, `subject_template`, `body_template`, `description`, and `updated_at`.
3. WHERE the optional `GET /api/communications/templates` list endpoint is provided, THE endpoint SHALL apply the same Global_Manager-only `authorize` enforcement that `GET /api/communications/templates/:key` already applies, and SHALL introduce no new database table, column, or migration.
4. WHEN the Template_Editor loads its list of templates, THE Communications_API_Client SHALL request the template set from the `GET /api/communications/templates` list endpoint.
5. WHEN the request for the template set succeeds, THE Template_Editor SHALL render one selectable entry for each returned Email_Template, labeled with that template's `template_key`.
6. IF the request for the template set fails with a network error or a non-2xx HTTP status, THEN THE Template_Editor SHALL display an error message and SHALL NOT render a template list built from stale or partial data.

### Requirement 3: Loading a Template for Editing

**User Story:** As a Global_Manager, I want to open a template and see its current subject and body, so that I can review the live content before changing it.

#### Acceptance Criteria

1. WHEN a Global_Manager selects an Email_Template from the Template_Editor, THE Communications_API_Client SHALL request that template's current content from `GET /api/communications/templates/:key` using the selected Template_Key.
2. WHEN the request for a single template succeeds, THE Template_Editor SHALL populate an editable subject field with the returned `subject_template` and an editable body field with the returned `body_template`.
3. WHEN the request for a single template succeeds, THE Template_Editor SHALL display the returned `description` and `updated_at` values for the selected Email_Template.
4. IF a Global_Manager selects a Template_Key for which `GET /api/communications/templates/:key` returns HTTP 404, THEN THE Template_Editor SHALL display a not-found message and SHALL NOT populate the subject and body fields with content from another template.
5. IF the request for a single template fails with a network error or a non-2xx, non-404 HTTP status, THEN THE Template_Editor SHALL display an error message and SHALL leave the subject and body fields unchanged.

### Requirement 4: Editing and Saving a Template

**User Story:** As a Global_Manager, I want to edit a template's subject and body and save my changes, so that outbound emails reflect the wording I choose.

#### Acceptance Criteria

1. WHEN a Global_Manager edits the subject field or the body field of a loaded Email_Template, THE Template_Editor SHALL update only its draft edit state and SHALL NOT issue a request to any template endpoint.
2. WHEN a Global_Manager saves an edited Email_Template, THE Communications_API_Client SHALL send the changed subject and body to `PUT /api/communications/templates/:key` using the selected Template_Key, including the subject field only when its value changed and the body field only when its value changed.
3. IF a Global_Manager attempts to save with both the subject field and the body field empty, THEN THE Template_Editor SHALL block the save, SHALL display a validation message, and SHALL NOT issue a request to `PUT /api/communications/templates/:key`.
4. WHERE a Global_Manager supplies a subject value, THE Template_Editor SHALL block the save and display a validation message WHEN the subject value is empty after trimming or exceeds 1000 characters.
5. WHERE a Global_Manager supplies a body value, THE Template_Editor SHALL block the save and display a validation message WHEN the body value is empty after trimming or exceeds 10000 characters.
6. WHEN a save to `PUT /api/communications/templates/:key` succeeds, THE Template_Editor SHALL update the displayed subject, body, and `updated_at` fields from the endpoint's returned template and SHALL display a success confirmation.
7. IF a save to `PUT /api/communications/templates/:key` fails with a network error or a non-2xx HTTP status, THEN THE Template_Editor SHALL display an error message and SHALL retain the Global_Manager's unsaved edits in the subject and body fields.
8. THE Template_Editor SHALL display an advisory notice stating that a saved Email_Template takes effect immediately for subsequently sent emails, because the server's EmailService reads template content from the database at send time.

### Requirement 5: Template Variable Hints

**User Story:** As a Global_Manager, I want to see which `{{variable}}` placeholders a template supports, so that I do not introduce a placeholder the send-time substitution will not fill.

#### Acceptance Criteria

1. WHEN a Global_Manager loads an Email_Template whose Template_Key has an entry in Template_Variable_Hints, THE Template_Editor SHALL display the list of Template_Variables associated with that Template_Key.
2. WHERE a loaded Email_Template's Template_Key has no entry in Template_Variable_Hints, THE Template_Editor SHALL render the loaded template without displaying a variable hint list and SHALL NOT block editing or saving.
3. THE Template_Editor SHALL label the displayed Template_Variable_Hints as advisory, indicating that the hints are not enforced and that an unrecognized placeholder is left as literal text at send time.
4. THE Template_Variable_Hints SHALL be defined as a static Client-side map keyed by Template_Key and SHALL NOT be fetched from a server endpoint.

### Requirement 6: Sending a Test Email

**User Story:** As a Global_Manager, I want to send a test copy of a template to my own address, so that I can confirm email delivery and see how a template renders before relying on it.

#### Acceptance Criteria

1. THE Admin_Page SHALL provide a Test_Email_Action with an input field for the target email address.
2. WHEN a Global_Manager triggers the Test_Email_Action, THE Communications_API_Client SHALL send the entered target address to `POST /api/communications/test-email`, including the currently selected Template_Key when a template is selected.
3. IF a Global_Manager triggers the Test_Email_Action with an empty or syntactically invalid target email address, THEN THE Admin_Page SHALL block the request, SHALL display a validation message, and SHALL NOT issue a request to `POST /api/communications/test-email`.
4. WHEN a request to `POST /api/communications/test-email` succeeds, THE Admin_Page SHALL display a success confirmation naming the target address.
5. IF a request to `POST /api/communications/test-email` fails with a network error or a non-2xx HTTP status, THEN THE Admin_Page SHALL display an error message.

### Requirement 7: Exporting Settings

**User Story:** As a Global_Manager, I want to export all portable settings to a file, so that I can retain a copy of the configuration or move it to another environment.

#### Acceptance Criteria

1. THE Admin_Page SHALL provide a Settings_Export control.
2. WHEN a Global_Manager triggers the Settings_Export control, THE Settings_API_Client SHALL request the Exported_Archive from `GET /api/settings/export`.
3. WHEN the Exported_Archive is received, THE Admin_Page SHALL deliver the archive to the Global_Manager as a downloaded file.
4. IF a request to `GET /api/settings/export` fails with a network error or a non-2xx HTTP status, THEN THE Admin_Page SHALL display an error message.
5. THE Admin_Page SHALL display a notice, adjacent to the Settings_Export control, stating that the Exported_Archive excludes the Excluded_Secret and that it is a settings export rather than a backup of domain data.

### Requirement 8: Importing Settings from an Exported Archive

**User Story:** As a Global_Manager, I want to import an Exported_Archive directly, so that an export and a later import round-trip without my having to unzip or edit files by hand.

#### Acceptance Criteria

1. THE Admin_Page SHALL provide a Settings_Import control that accepts a file selected by the Global_Manager.
2. WHEN a Global_Manager selects a `.zip` Exported_Archive for import, THE Import_Transform SHALL unzip the archive in the browser, read its `settings.json` and `email_templates.json` entries, and produce an Import_Payload whose `systemConfig` and `siteConfig` come from `settings.json` and whose `emailTemplates` comes from `email_templates.json`.
3. WHEN a Global_Manager selects a raw merged `.json` file whose parsed content already has the Import_Payload shape, THE Import_Transform SHALL produce that content as the Import_Payload without unzipping.
4. FOR ALL Exported_Archives produced by `GET /api/settings/export`, applying the Import_Transform to an Exported_Archive SHALL produce an Import_Payload whose `systemConfig`, `siteConfig`, and `emailTemplates` arrays contain exactly the rows of that archive's `settings.json` and `email_templates.json`.
5. WHEN the Import_Transform has produced an Import_Payload, THE Settings_API_Client SHALL submit that Import_Payload as the JSON request body of `POST /api/settings/import`.
6. IF the selected import file is neither a readable Exported_Archive nor a parseable JSON object with the Import_Payload shape, THEN THE Admin_Page SHALL display an error message and SHALL NOT issue a request to `POST /api/settings/import`.

### Requirement 9: Import Validation and Rejection Feedback

**User Story:** As a Global_Manager, I want a rejected import to tell me exactly what was wrong, so that I can correct the file rather than guess why nothing changed.

#### Acceptance Criteria

1. WHEN a request to `POST /api/settings/import` succeeds, THE Admin_Page SHALL display a success confirmation reporting the counts of imported `systemConfig`, `siteConfig`, and `emailTemplates` rows returned by the endpoint.
2. IF `POST /api/settings/import` responds with HTTP 400 and a `problems` array, THEN THE Admin_Page SHALL display each Import_Problem in the returned `problems` array.
3. WHEN `POST /api/settings/import` rejects an Import_Payload with HTTP 400, THE Admin_Page SHALL indicate that no settings were changed by the rejected import.
4. IF a request to `POST /api/settings/import` fails with a network error or a non-2xx HTTP status other than 400, THEN THE Admin_Page SHALL display an error message.
5. THE Admin_Page SHALL display a notice, adjacent to the Settings_Import control, stating that importing into a fresh environment does not restore the Excluded_Secret and that the Excluded_Secret must be re-entered separately.

### Requirement 10: Durability of UI-Edited Settings and Templates

**User Story:** As a Global_Manager, I want to understand that edits made through this UI live only in the database, so that I know they depend on the database being backed up.

#### Acceptance Criteria

1. THE Admin_Page SHALL display a notice indicating that Email_Templates and settings edited through this UI are persisted only in the application database and are not written to any configuration file.
2. THE Admin_Page SHALL indicate that recovering UI-edited Email_Templates and settings after a database loss depends on a separate database backup or on a previously produced Exported_Archive.
