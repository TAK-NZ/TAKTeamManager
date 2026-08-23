# Implementation Plan: Admin Settings Management

## Overview

This plan surfaces two backend-complete capabilities (Email Template Editor and Settings Export/Import) in the Global_Manager `/admin` page. It is almost entirely Client work plus one optional server list endpoint. Tasks build incrementally: the optional endpoint and API wrappers first, then the dependency-free pure helpers (with their property/unit tests), then the `Admin.jsx` UI that wires them in, then final verification. The design uses a specific language stack already (JavaScript/React client, Node/Express server), so no language-selection step is required.

## Tasks

- [x] 1. Add the optional template-list endpoint (single source of truth for template keys)
  - [x] 1.1 Add `GET /api/communications/templates` to `server/routes/communications.js`
    - Mount alongside the existing routes with the same `authenticateToken` + `authorize` chain (Global_Manager-only)
    - Run `SELECT template_key, subject_template, body_template, description, updated_at FROM email_templates ORDER BY template_key` and respond `{ templates: [...] }`; 500 on query error
    - Introduce no new table, column, or migration
    - _Requirements: 2.1, 2.2, 2.3_
  - [x]* 1.2 Write server test for the list endpoint
    - Follow the existing supertest + `jest.mock('../config/database')` pattern in `server/routes/communications.test.js`
    - Assert the 200 `{ templates: [...] }` shape for a Global_Manager and a 500 on a query error
    - _Requirements: 2.2, 2.3_

- [x] 2. Add the client API wrappers
  - [x] 2.1 Add `communicationsAPI` and `settingsAPI` to `client/src/services/api.js`
    - `communicationsAPI`: `listTemplates`, `getTemplate(key)`, `updateTemplate(key, body)`, `sendTestEmail(body)`
    - `settingsAPI`: `exportSettings()` (with `responseType: 'blob'`), `importSettings(payload)`
    - Use the shared `api` axios instance via wrapper objects, matching the existing `configAPI`/`adminAPI`/`syncAPI` style; do NOT use raw axios or localStorage tokens
    - _Requirements: 2.4, 3.1, 4.2, 6.2, 7.2, 8.5_
  - [x]* 2.2 Extend `client/src/services/api.test.js` for the new wrappers
    - Assert each method builds the expected method/URL and that `exportSettings` sets `responseType: 'blob'`, matching how the existing suite validates wrappers
    - _Requirements: 2.4, 3.1, 4.2, 6.2, 7.2, 8.5_

- [x] 3. Implement the Template_Variable_Hints helper
  - [x] 3.1 Create `client/src/utils/templateVariableHints.js`
    - Export the static `TEMPLATE_VARIABLE_HINTS` map (the seven Template_Keys -> advisory variable lists from the design) and `getVariableHints(key)` returning `[]` for an unknown key
    - Document in the module that the map is advisory only and not enforced
    - _Requirements: 5.1, 5.2, 5.4_
  - [x]* 3.2 Write property test for the variable-hints helper
    - **Property 5: Variable hints never break editing**
    - **Validates: Requirements 5.1, 5.2**

- [x] 4. Implement the template-update payload/validation helper
  - [x] 4.1 Create `client/src/utils/templateUpdatePayload.js`
    - `buildTemplateUpdatePayload(original, draft)` returns `{ subjectTemplate?, bodyTemplate? }` containing only changed fields, never an empty object when something changed
    - `validateTemplateDraft(draft)` returns validation problems mirroring the server bounds (both-empty; subject empty-after-trim or > 1000; body empty-after-trim or > 10000)
    - _Requirements: 4.2, 4.3, 4.4, 4.5_
  - [x]* 4.2 Write property tests for the payload/validation helper
    - **Property 3: Update payload contains exactly the changed fields** (Validates: Requirements 4.2)
    - **Property 4: Draft validation enforces the server's bounds** (Validates: Requirements 4.3, 4.4, 4.5)

- [x] 5. Implement the settings Import_Transform helper
  - [x] 5.1 Add the pinned client-side unzip dependency
    - Add the chosen unzip library (recommended `fflate`) to `client/package.json` `dependencies` with an exact pinned version (no `^`/`~`), keeping `npm run lint:pinned-deps` passing
    - _Requirements: 8.2_
  - [x] 5.2 Create `client/src/utils/settingsImportTransform.js`
    - `mergeExportedJson(settingsJson, emailTemplatesJson)` -> `{ systemConfig, siteConfig, emailTemplates }`
    - `isImportPayloadShape(value)` -> boolean (object with array `systemConfig`, array `siteConfig`, and array `emailTemplates` when present)
    - `unzipExportedArchive(arrayBuffer)` -> reads `settings.json` and `email_templates.json` from the archive and calls `mergeExportedJson`; the only function touching the unzip dependency
    - _Requirements: 8.2, 8.3, 8.4_
  - [x]* 5.3 Write property tests for the merge/shape functions
    - **Property 1: Export-to-import round-trip preserves rows** (Validates: Requirements 8.2, 8.4)
    - **Property 2: Import-payload shape recognition is exact** (Validates: Requirements 8.3, 8.6)
  - [x]* 5.4 Write unit tests for unzip and raw-json paths
    - Cover `unzipExportedArchive` with one representative in-test archive and the raw-`.json` pass-through path
    - _Requirements: 8.2, 8.3, 8.6_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Build the Email Template Editor UI in `Admin.jsx`
  - [x] 7.1 Add the Template_Editor section (list, load, hints display)
    - Add a Global_Manager-gated Templates section: template selector populated via `communicationsAPI.listTemplates`; on selection load via `communicationsAPI.getTemplate` into editable subject/body fields; show `description`/`updated_at`; render advisory `getVariableHints` list labeled as advisory
    - Handle list-fetch, load, and 404 error branches
    - _Requirements: 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 5.1, 5.2, 5.3_
  - [x] 7.2 Add edit/save and the immediate-effect notice
    - Wire draft edit state; on save use `validateTemplateDraft` then `buildTemplateUpdatePayload` and `communicationsAPI.updateTemplate`; update displayed fields and confirm on success; retain edits on failure; render the "takes effect immediately" advisory notice
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_
  - [x] 7.3 Add the Test_Email_Action
    - Target-address input with client-side email validation; call `communicationsAPI.sendTestEmail` with the selected `templateKey`; success confirmation naming the address; error branch
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x]* 7.4 Write structural/render tests for the Template_Editor section
    - Assert the immediate-effect notice and advisory-hints labeling are present, consistent with the repo's `readFileSync` or `@testing-library/react` test convention
    - _Requirements: 4.8, 5.3_

- [x] 8. Build the Settings Export / Import UI in `Admin.jsx`
  - [x] 8.1 Add the Settings_Export control and notices
    - Global_Manager-gated Export button calling `settingsAPI.exportSettings` and delivering the blob as a downloaded file; error branch; render the secrets-excluded / not-a-DB-backup notice and the DB-only durability notice
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 10.1, 10.2_
  - [x] 8.2 Add the Settings_Import control and rejection feedback
    - File input + Import button; run the Import_Transform (unzip+merge for `.zip`, pass-through for raw `.json`, `isImportPayloadShape` guard); submit via `settingsAPI.importSettings`; on success show imported counts; on 400 render each Import_Problem and state nothing changed; other transport errors show a generic message; unreadable/misshapen file blocks the request
    - Render the "secret must be re-entered on a fresh environment" notice adjacent to the Import control
    - _Requirements: 8.1, 8.5, 8.6, 9.1, 9.2, 9.3, 9.4, 9.5_
  - [x]* 8.3 Write structural/render tests for the Export/Import section
    - Assert the two adjacent notices are present and that a mocked 400 response renders a `problems` list with a no-change indication
    - _Requirements: 7.5, 9.2, 9.3, 9.5_

- [x] 9. Wire Global_Manager gating and finalize section placement
  - [x] 9.1 Gate both new sections and confirm no calls fire for non-Global_Managers
    - Ensure the Templates and Export/Import sections render only under the same `is_global_manager` condition used by existing Global_Manager-only Admin surfaces, and that none of the four endpoint calls are issued when that condition is false
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 10. Final checkpoint - verification
  - Run `npm test` (server Jest suite, including the optional list-endpoint test if built)
  - Run the client tests with `npx vitest --run`
  - Run `npm run lint` and confirm it stays at the baseline of `157 problems (145 errors, 12 warnings)` (no increase)
  - Run `npm run lint:pinned-deps` and confirm it passes with the newly pinned client dependency
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (test-only) and can be skipped for a faster MVP, though the property tests are the primary safety net for the pure helpers.
- Each task references specific requirements for traceability.
- Property tests validate the universal correctness properties from the design; unit/structural tests cover examples, edge cases, and UI structure.
- The only server change is the optional `GET /api/communications/templates` endpoint (task 1); everything else is Client-side. No new server route/middleware/DB behavior is introduced otherwise.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.2", "4.2", "5.2"] },
    { "id": 2, "tasks": ["5.3", "5.4", "7.1", "8.1"] },
    { "id": 3, "tasks": ["7.2", "7.3", "8.2"] },
    { "id": 4, "tasks": ["7.4", "8.3", "9.1"] }
  ]
}
```
