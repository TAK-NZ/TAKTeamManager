# Requirements Document

## Introduction

The audit log query endpoint, CSV export endpoint, retention-window exclusion, and Global_Manager-only server-side access restriction were already specified and implemented as Requirement 31 ("Rich Filterable Audit Log Interface with CSV Export") of the production-hardening spec (`.kiro/specs/production-hardening/requirements.md`). Requirement 31 Criteria 1-4 remain the authoritative, unmodified specification of that backend and are not restated or duplicated here.

BUG-013 (`BUGS.md`) identifies that no client-side interface exists for that backend: a Global_Manager cannot search, filter, or export the audit log from the web app, only via a raw API call with a valid session cookie. This document specifies the client-side requirements needed to close BUG-013, based on the approved design in `design.md`: a Global_Manager-only page and navigation entry, a filter form, a paginated results table, a CSV export action, and the client-side error and edge-case handling the page must exhibit. Every requirement in this document concerns behavior of the Client (`client/src`) only; no server-side route, middleware, or database behavior is introduced or changed by this document.

## Glossary

- **Client**: The React single-page application in `client/src`, consistent with its definition in the production-hardening requirements document.
- **Global_Manager**: A user whose cached `is_global_manager` attribute is true, consistent with its definition in the production-hardening requirements document.
- **Audit_Log_Page**: The Client page component rendered at the `/audit-logs` route (`client/src/pages/AuditLogs.jsx`).
- **Navigation_Menu**: The Client's navigation component that renders the list of route links available to the authenticated user (`client/src/components/Layout.jsx`).
- **Audit_Log_API_Client**: The Client module that issues requests to the audit log query endpoint and builds the CSV export URL (the `auditLogsAPI` object in `client/src/services/api.js`).
- **Filter_Form**: The set of draft filter input fields (`userId`, `action`, `resourceType`, `teamId`, `startDate`, `endDate`) on the Audit_Log_Page that a Global_Manager edits before submitting them.
- **Applied_Filters**: The most recently submitted Filter_Form values, used both for the Audit_Log_Page's current results-table request and for the CSV export URL.
- **Team_Filter_Dropdown**: The selectable-options control on the Filter_Form listing teams available for the `teamId` filter field.
- **Results_Table**: The table of audit log rows rendered by the Audit_Log_Page for the current page of results.
- **Export_Action**: The control on the Audit_Log_Page that triggers a CSV download of the audit log rows matching the Applied_Filters.

## Requirements

### Requirement 1: Global_Manager-Only Navigation Entry and Route Access

**User Story:** As a Global_Manager, I want an "Audit Log" navigation entry and page that only a Global_Manager can reach, so that I can review the audit log through the app while a non-Global_Manager user never sees or reaches it.

#### Acceptance Criteria

1. WHERE the authenticated user's `is_global_manager` attribute is true, THE Navigation_Menu SHALL display an "Audit Log" entry linking to the `/audit-logs` route.
2. WHERE the authenticated user's `is_global_manager` attribute is false, THE Navigation_Menu SHALL render without an "Audit Log" entry.
3. THE Navigation_Menu SHALL apply the same `is_global_manager` condition to the "Audit Log" entry that it applies to the existing "Global Channels" entry.
4. WHEN a user whose `is_global_manager` attribute is true navigates to `/audit-logs`, THE Audit_Log_Page SHALL render the Filter_Form, the Results_Table, the pagination controls, and the Export_Action, and SHALL request the first page of results from the audit log query endpoint using an empty Applied_Filters set.
5. IF a user whose `is_global_manager` attribute is false navigates to `/audit-logs`, THEN THE Audit_Log_Page SHALL render a not-authorized message in place of the Filter_Form, the Results_Table, and the Export_Action, and SHALL NOT issue a request to the audit log query endpoint or the CSV export endpoint.

### Requirement 2: Results Table Display and Pagination

**User Story:** As a Global_Manager, I want the audit log results displayed in a paginated table, so that I can review rows in manageable pages without the page requesting a page number that does not exist.

#### Acceptance Criteria

1. WHEN the audit log query endpoint returns a successful response, THE Results_Table SHALL render, for each returned row, the `id`, `user_id`, `action`, `resource_type`, `resource_id`, `details`, and `created_at` fields.
2. THE Results_Table SHALL render rows in the order returned by the audit log query endpoint.
3. THE Audit_Log_Page SHALL render each row's `details` field as pretty-printed JSON text.
4. THE Audit_Log_Page SHALL display each row's `user_id` field as the literal actor identifier returned by the audit log query endpoint, without resolving it to a username or display name.
5. THE Audit_Log_Page SHALL compute the total page count as `Math.max(1, Math.ceil(pagination.total / pagination.pageSize))` using the `pagination.total` and `pagination.pageSize` values returned by the audit log query endpoint.
6. WHILE the current page equals 1, THE Audit_Log_Page SHALL disable the "Previous" pagination control.
7. WHILE the current page equals the computed total page count, THE Audit_Log_Page SHALL disable the "Next" pagination control.
8. WHEN a Global_Manager clicks an enabled "Previous" or "Next" pagination control, THE Audit_Log_Page SHALL request the corresponding page from the audit log query endpoint using the current Applied_Filters, and SHALL update the Results_Table with the returned rows.
9. WHEN a successful response to the audit log query endpoint contains zero rows for the current page and Applied_Filters, THE Audit_Log_Page SHALL render an empty-results message in place of the Results_Table.

### Requirement 3: Filter Form and Applied Filters

**User Story:** As a Global_Manager, I want to filter the audit log by actor, action, resource type, team, and date range, and have my edits apply only when I submit them, so that the results table does not refetch on every keystroke.

#### Acceptance Criteria

1. THE Filter_Form SHALL provide an input field for each of `userId`, `action`, `resourceType`, `teamId`, `startDate`, and `endDate`.
2. WHEN a Global_Manager edits a Filter_Form field, THE Audit_Log_Page SHALL update only the draft Filter_Form state and SHALL NOT issue a request to the audit log query endpoint.
3. WHEN a Global_Manager clicks "Apply Filters", THE Audit_Log_Page SHALL set Applied_Filters to the current Filter_Form values, SHALL reset the current page to 1, and SHALL request results from the audit log query endpoint using the updated Applied_Filters.
4. WHEN a Global_Manager clicks "Clear Filters", THE Audit_Log_Page SHALL reset both the Filter_Form and Applied_Filters to empty values, SHALL reset the current page to 1, and SHALL request results from the audit log query endpoint using the empty Applied_Filters.
5. FOR ALL Filter_Form field combinations in which zero or more fields hold an empty string, THE Audit_Log_API_Client SHALL include a query parameter for each field whose value is non-empty and SHALL omit a query parameter for each field whose value is the empty string, when building the request to the audit log query endpoint.
6. THE Filter_Form SHALL render the `action` and `resourceType` fields as free-text input fields rather than as a fixed set of selectable options.
7. IF a Global_Manager applies a `startDate` value later than the `endDate` value, THEN THE Audit_Log_Page SHALL submit both values to the audit log query endpoint unchanged and SHALL NOT display a validation error for that field combination.

### Requirement 4: Team Filter Options

**User Story:** As a Global_Manager, I want the team filter populated with the full list of teams, so that I can filter the audit log by any team without typing a team identifier from memory.

#### Acceptance Criteria

1. WHEN the Audit_Log_Page mounts, THE Audit_Log_Page SHALL request the full list of teams from the existing team-listing endpoint using a page size of 200.
2. WHEN the team-listing request succeeds, THE Team_Filter_Dropdown SHALL render one selectable option for each returned team, labeled with that team's `name`.
3. WHEN a Global_Manager selects a team from the Team_Filter_Dropdown, THE Filter_Form SHALL set the `teamId` field to the selected team's `id`.

### Requirement 5: CSV Export

**User Story:** As a Global_Manager, I want to export the currently filtered audit log rows as a CSV file, so that I can retain or share the results of an investigation outside the app.

#### Acceptance Criteria

1. WHILE the authenticated user's `is_global_manager` attribute is true, THE Audit_Log_Page SHALL render the Export_Action.
2. WHEN a Global_Manager clicks the Export_Action, THE Audit_Log_API_Client SHALL build the CSV export URL from the current Applied_Filters, excluding the `page` and `pageSize` parameters.
3. FOR ALL Applied_Filters values, THE query parameter map that the Audit_Log_API_Client produces for the CSV export URL SHALL equal the query parameter map most recently used for the audit log query endpoint request, minus the `page` and `pageSize` parameters.
4. WHEN a Global_Manager clicks the Export_Action, THE Audit_Log_Page SHALL open the CSV export URL in a new browser tab, such that the `/audit-logs` tab remains on the Audit_Log_Page.
5. IF the CSV export endpoint returns a non-2xx response to a request opened via the Export_Action, THEN THE Audit_Log_Page SHALL take no client-side action beyond the browser's default rendering of that response in the opened tab.

### Requirement 6: List Fetch Error Handling

**User Story:** As a Global_Manager, I want a failed audit log request to surface an error without discarding results I already loaded, so that a transient failure does not force me to lose my place.

#### Acceptance Criteria

1. IF a request to the audit log query endpoint fails with a network error or with a non-2xx, non-401 HTTP status, THEN THE Audit_Log_Page SHALL display an error message and SHALL stop the loading indicator.
2. IF a request to the audit log query endpoint fails after the Results_Table has already rendered rows from a prior successful request, THEN THE Audit_Log_Page SHALL continue displaying those previously rendered rows alongside the error message.
3. WHILE a request to the audit log query endpoint has failed and its error message is displayed, THE Filter_Form and the pagination controls SHALL remain interactive.
4. WHEN a Global_Manager re-applies filters or changes the page after a request to the audit log query endpoint has failed, THE Audit_Log_Page SHALL issue a new request to the audit log query endpoint, and SHALL clear the displayed error message upon that request's success.
