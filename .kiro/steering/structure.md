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
```

## Placement rules

- Pure decision logic with interesting boundaries goes in `server/utils/` or `client/src/utils/` (no React import) so a property test can reach it directly — even when only tests consume it.
- Database access lives in models and services, never in routes.
- Route handlers validate, authorize and delegate. Business rules live in services.
- Tests are co-located: `X.test.js`, and `X.property.test.js` for property-based tests.
- Structural/static-analysis guards are named for what they guard. Four exist: `client/src/utils/dateFormatConsumers.test.js`, `server/services/__tests__/martiEndpointContract.test.js`, `server/workers/operationSchemas.test.js`, `client/src/pages/channelTreeContrast.test.jsx`. The last locates a row by a stable visual anchor (an icon's class tokens or path-data shape), not by incidental markup like a wrapping `<button>` — a real UX change (e.g. removing a small dedicated toggle button in favour of a click-anywhere row) can legitimately remove the anchor a guard relied on, and the guard's extraction logic needs updating alongside it, without weakening what it actually asserts.

## Retired specs: `.kiro/specs/` no longer exists

- The ten completed feature specs that used to live in `.kiro/specs/` were removed once they had been fully implemented and their durable, still-true content had been folded into `.kiro/steering/` (this file, `tech.md`, `product.md`, `server-conventions.md`, `client-conventions.md`, `feature-flags.md`, `tak-server-integration.md`).
- **Old code comments still cite requirement/criterion numbers from those specs** (e.g. `// device-management Requirement 5.3`, `// Criterion 2.13`) — those citations are now historical provenance only. The spec they name no longer exists to consult; treat the comment's surrounding explanation as the source of truth, not the citation itself. Do not add new spec-numbered citations — describe the rule in prose instead, or point at the relevant steering file.
