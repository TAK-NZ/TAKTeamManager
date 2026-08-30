---
inclusion: always
---

# Where code goes

```
server/routes/         HTTP handlers: validate, authorize, delegate
server/services/       business rules
server/models/         database access
server/middleware/     auth, authorization
server/workers/        sync queue drain
server/config/         constants, feature-flag helpers, registries
server/utils/          pure logic, no framework imports
client/src/pages/      routed views
client/src/components/ shared UI
client/src/utils/      pure logic, no React import
client/src/services/   API client
database/migrations/   node-pg-migrate .cjs migrations
scripts/               operational and CI scripts
.kiro/specs/           completed specs (history)
```

## Placement rules

- Pure decision logic with interesting boundaries goes in `server/utils/` or `client/src/utils/` (no React import) so a property test can reach it directly — even when only tests consume it.
- Database access lives in models and services, never in routes.
- Route handlers validate, authorize and delegate. Business rules live in services.
- Tests are co-located: `X.test.js`, and `X.property.test.js` for property-based tests.
- Structural/static-analysis guards are named for what they guard. Four exist: `client/src/utils/dateFormatConsumers.test.js`, `server/services/__tests__/martiEndpointContract.test.js`, `server/workers/operationSchemas.test.js`, `client/src/pages/channelTreeContrast.test.jsx`. The last locates a row by a stable visual anchor (an icon's class tokens or path-data shape), not by incidental markup like a wrapping `<button>` — a real UX change (e.g. removing a small dedicated toggle button in favour of a click-anywhere row) can legitimately remove the anchor a guard relied on, and the guard's extraction logic needs updating alongside it, without weakening what it actually asserts.

## Completed specs are history, not documentation

- `.kiro/specs/` holds ten completed specs. Code comments cite them heavily by number (`Requirement 5.3`, `Criterion 2.13`).
- **Requirement numbers are NOT globally unique — all ten specs define a "Requirement 5."** A bare citation is ambiguous. When adding one, name the spec: `// device-management Requirement 5.3`.
- A later spec overrules an earlier one. Where they conflict, the newer wins.
