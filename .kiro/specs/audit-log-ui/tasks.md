# Implementation Plan: Audit Log UI

## Overview

This plan converts `design.md`'s components (the `auditLogsAPI` module, the `AuditLogs.jsx` page, the `/audit-logs` route, and the "Audit Log" nav entry) into incremental, dependency-ordered coding tasks. No server-side code is touched anywhere in this plan; every task modifies only `client/src` and `client/package.json`.

Note on `fast-check`: `client/package.json` already lists `fast-check` (`4.9.0`) as a devDependency, added by the production-hardening spec's task 59.1. Task 1.1 below only confirms this rather than adding it fresh.

Tasks marked with `*` are optional test sub-tasks and are not implemented as part of automated task execution unless explicitly requested.

## Tasks

- [x] 1. Add `auditLogsAPI` to `client/src/services/api.js`
  - [x] 1.1 Confirm `fast-check` is present in `client/package.json` devDependencies (already added by the production-hardening spec); add it if for any reason it is missing
    - _Requirements: supports the Property 1/2 test tasks below_
  - [x] 1.2 Implement `auditLogsAPI.getAuditLogs(filters, pageParams)` and `auditLogsAPI.buildExportUrl(filters)` in `client/src/services/api.js`, reusing the existing `joinBaseAndPath`/`validatedBase` helpers for `buildExportUrl`
    - _Requirements: 3.5, 5.2, 5.3_
  - [ ]* 1.3 Write unit tests for `auditLogsAPI.getAuditLogs` (mocking the underlying `api` axios instance) and `auditLogsAPI.buildExportUrl` (pure function, no mocking needed)
    - _Requirements: 3.5, 5.2, 5.3_
  - [ ]* 1.4 Write property test for empty-filter omission
    - **Property 1: Empty filter fields are never sent as query parameters**
    - **Validates: Requirements 3.5**
  - [ ]* 1.5 Write property test for export URL / list filter equivalence
    - **Property 2: Export URL filters always match the currently-applied list filters**
    - **Validates: Requirements 5.2, 5.3**

- [x] 2. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Add "Audit Log" navigation entry
  - [x] 3.1 Add an "Audit Log" entry to `getNavigation(user)` in `client/src/components/Layout.jsx`, gated on `user.is_global_manager`, placed directly after the "Global Channels" entry inside the existing `if` block
    - _Requirements: 1.1, 1.2, 1.3_
  - [ ]* 3.2 Write property test for nav-entry gating
    - **Property 4: Nav entry and route access mirror the same gating condition**
    - **Validates: Requirements 1.1, 1.2, 1.3**
  - [ ]* 3.3 Write unit test asserting the "Audit Log" entry's position/condition matches the "Global Channels" entry exactly
    - _Requirements: 1.3_

- [x] 4. Scaffold the `AuditLogs` page, route, and access guard
  - [x] 4.1 Create `client/src/pages/AuditLogs.jsx` with the component skeleton, the internal state described in design.md (`auditLogs`, `pagination`, `loading`, `error`, `filters`, `appliedFilters`, `teams`), and a client-side not-authorized guard that renders instead of fetching when `user.is_global_manager` is falsy
    - _Requirements: 1.4, 1.5_
  - [x] 4.2 Add the `/audit-logs` route to `client/src/App.jsx`, importing `AuditLogs` and passing `user` the same way `GlobalChannels`/`Admin` already receive it
    - _Requirements: 1.4_
  - [ ]* 4.3 Write unit tests for the initial loading state and for the not-authorized guard issuing no request to the audit log query endpoint or CSV export endpoint
    - _Requirements: 1.4, 1.5_

- [x] 5. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Team filter dropdown
  - [x] 6.1 On mount, fetch `teamsAPI.getMyTeams()` with `pageSize: 200` and populate the Team_Filter_Dropdown with one option per returned team labeled by `name`; wire selecting an option to set `filters.teamId` to the selected team's `id`
    - _Requirements: 4.1, 4.2, 4.3_
  - [ ]* 6.2 Write unit tests for team dropdown population and for selecting a team setting `filters.teamId`
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 7. Filter form and Applied Filters submission flow
  - [x] 7.1 Render the Filter_Form fields (`userId`, `action`, `resourceType`, `teamId`, `startDate`, `endDate`), rendering `action`/`resourceType` as free-text inputs rather than fixed `<select>` options, with field edits updating only the draft `filters` state and issuing no request; implement "Apply Filters" (set `appliedFilters` from `filters`, reset page to 1, fetch) and "Clear Filters" (reset both `filters` and `appliedFilters` to empty, reset page to 1, fetch), submitting `startDate`/`endDate` unchanged with no cross-field validation error
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.7_
  - [ ]* 7.2 Write unit tests for: editing a field not triggering a fetch, "Apply Filters" building the expected `appliedFilters` and resetting the page, "Clear Filters" resetting both filter states, and a `startDate` later than `endDate` being submitted unchanged
    - _Requirements: 3.2, 3.3, 3.4, 3.7_

- [x] 8. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Results table and list-fetch wiring
  - [x] 9.1 Wire a fetch effect that calls `auditLogsAPI.getAuditLogs(appliedFilters, { page, pageSize })` whenever `appliedFilters` or `pagination.page` changes (including the initial mount, using an empty `appliedFilters`), and render the Results_Table: `id`, `user_id` (displayed as the literal identifier, not resolved to a username), `action`, `resource_type`, `resource_id`, `details` (pretty-printed JSON), and `created_at`, in the order returned by the endpoint; render an empty-results message in place of the table when a successful response contains zero rows
    - _Requirements: 1.4, 2.1, 2.2, 2.3, 2.4, 2.9_
  - [ ]* 9.2 Write unit tests for populated table rendering (all six fields, including pretty-printed `details` and literal `user_id`), row ordering, and the empty-results message
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.9_

- [x] 10. Pagination controls
  - [x] 10.1 Compute the total page count as `Math.max(1, Math.ceil(pagination.total / pagination.pageSize))`; disable "Previous" when the current page is 1 and "Next" when the current page equals the computed total; wire enabled clicks to request the corresponding page using the current `appliedFilters` and update the Results_Table
    - _Requirements: 2.5, 2.6, 2.7, 2.8_
  - [ ]* 10.2 Write property test for pagination bounds
    - **Property 3: Pagination controls never request an out-of-range page**
    - **Validates: Requirements 2.5, 2.6, 2.7**
  - [ ]* 10.3 Write unit tests for "Previous"/"Next" enable/disable at page-count boundaries and for a page change re-fetching with the current `appliedFilters`
    - _Requirements: 2.6, 2.7, 2.8_

- [x] 11. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [x] 12. CSV export action
  - [x] 12.1 Render the Export_Action while `user.is_global_manager` is true; wire its click handler to build the export URL via `auditLogsAPI.buildExportUrl(appliedFilters)` and open it with `window.open(url, '_blank')` so the `/audit-logs` tab itself never navigates away
    - _Requirements: 5.1, 5.2, 5.4, 5.5_
  - [ ]* 12.2 Write unit test asserting the Export_Action opens `buildExportUrl(appliedFilters)` in a new tab and that no client-side navigation or state change occurs on the `/audit-logs` tab
    - _Requirements: 5.2, 5.4_

- [x] 13. List-fetch error handling
  - [x] 13.1 Catch `getAuditLogs` rejections: set an `error` message, stop the loading indicator, and retain any previously rendered rows instead of clearing them; keep the Filter_Form and pagination controls interactive while `error` is set; clear `error` on the next successful request triggered by re-applying filters or changing the page
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [ ]* 13.2 Write unit tests for: a rejected `getAuditLogs` call setting the error message and stopping the spinner, previously rendered rows remaining visible alongside the error, controls remaining interactive, and re-applying filters clearing the error on success
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 14. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Integration test
  - [ ]* 15.1 Write an integration test mounting `AuditLogs.jsx` with a mocked `auditLogsAPI`, exercising the full fetch -> render -> paginate -> re-fetch loop end to end without a real backend
    - _Requirements: 1.4, 2.8, 3.3_

- [x] 16. Final checkpoint - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks (unit, property-based, integration) and are skipped by default during automated task execution; core implementation tasks are never marked optional.
- Every property test task references the property number and requirement clause(s) it validates, per `design.md`'s Correctness Properties section (Properties 1-4).
- `client/src/pages/AuditLogs.jsx` is built up incrementally across tasks 4.1, 6.1, 7.1, 9.1, 10.1, 12.1, and 13.1; each depends on the file state left by the previous one, which is why the dependency graph below sequences them into separate waves.
- No server-side files (`server/routes/auditLogs.js`, `server/config/permissions.registry.js`, etc.) are modified by this plan; the backend was already implemented and tested by the production-hardening spec's task 53.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "3.1", "4.1"] },
    { "id": 1, "tasks": ["1.3", "3.2", "4.2", "4.3", "6.1"] },
    { "id": 2, "tasks": ["1.4", "3.3", "6.2", "7.1"] },
    { "id": 3, "tasks": ["1.5", "7.2"] },
    { "id": 4, "tasks": ["9.1"] },
    { "id": 5, "tasks": ["9.2"] },
    { "id": 6, "tasks": ["10.1"] },
    { "id": 7, "tasks": ["10.2"] },
    { "id": 8, "tasks": ["10.3"] },
    { "id": 9, "tasks": ["12.1"] },
    { "id": 10, "tasks": ["12.2"] },
    { "id": 11, "tasks": ["13.1"] },
    { "id": 12, "tasks": ["13.2"] },
    { "id": 13, "tasks": ["15.1"] }
  ]
}
```

### Reading the graph

- Wave 0 covers everything with no dependencies: confirming `fast-check`, adding `auditLogsAPI` to `api.js`, adding the Layout.jsx nav entry, and creating the `AuditLogs.jsx` skeleton — four distinct files, fully parallel.
- Waves 1-3 fan out the independent test/route work that only depends on wave 0 (`api.js` tests and property tests, `Layout.jsx` tests, the `App.jsx` route, the page's initial guard tests, and the start of the team-filter/filter-form work on `AuditLogs.jsx`).
- From wave 4 onward, almost every task is alone in its wave because `AuditLogs.jsx` (implementation) and its corresponding test file are each edited by a long, logically-ordered chain of tasks (team filter -> filter form -> results table -> pagination -> export -> error handling), and per the wave-construction rule, tasks writing to the same file cannot share a wave. This mirrors how the page is genuinely built up one behavior at a time in a single component file.
- Wave 13 (the integration test) runs last since it exercises the fully assembled page.
