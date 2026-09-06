---
inclusion: always
---

# Stack and commands

## Stack

Server: Node/Express, Postgres (`pg`, node-pg-migrate), Authentik OIDC, pino logging, Jest.
Client: React 18, Vite, Tailwind, React Router, Vitest + fast-check, jsdom.

## Commands

- Server tests: `npm test` (root; Jest, `--forceExit`). Integration tests are excluded by `testPathIgnorePatterns` and must be run explicitly.
- Coverage: `npm test -- --coverage`. Floor is 60% global statements.
- Client tests: `cd client && npm test` (Vitest, already non-watching). Single file: `cd client && npx vitest run src/path/file.test.jsx`.
- Lint: `npm run lint` (root). Client lint: `cd client && npm run lint`.
- Pinned-dependency check: `npm run lint:pinned-deps`.
- Migrations: `npm run migrate:up`, `npm run migrate:create`. `node database/init.js` runs the chain.
- Dev: `npm run dev` (concurrent server + client).

## Two things that surprise people

- **`npm run lint` (root) does not lint `client/`.** Its scope is `server scripts database eslint.config.js` (`database/migrations/**` excluded via `eslint.config.js`'s own `ignores`). `client/` has its OWN separate lint (`cd client && npm run lint`, its own `client/eslint.config.js`) — deliberately narrow, checking only `eslint-plugin-react-hooks`'s `rules-of-hooks`/`exhaustive-deps` against `**/*.jsx`, not general JS style. It exists specifically to catch a hooks-order violation statically (a hook called after a conditional early `return`) — the class of bug that crashed `TeamDetail.jsx` on every page load and was invisible to the Vitest suite. The Vitest suite is still the primary gate on client code; this lint is a narrow, deliberately-scoped addition, not a general style pass.
- **There are two independent test runners and two dependency trees.** Root Jest for `server/`, `client/`'s Vitest for `client/`. A client dependency must be added to `client/package.json`.
- **`TAK_SERVER_ENROLLMENT_URL` and `TAK_SERVER_URL` are deliberately different hosts, not aliases.** `TAK_SERVER_URL` is the Marti certadmin API's mutual-TLS endpoint (`TakServerService.js`), often internal/admin-only. `TAK_SERVER_ENROLLMENT_URL` is the public, client-dialable host `DeviceEnrollmentService` builds enrollment URIs/QR payloads from. They can legitimately point at different hostnames and/or ports — never collapse them to one var.

## Health/readiness endpoints

- `GET /health` (DB check, 2s timeout), `GET /health/ready` (DB + Authentik reachability, 3s), `GET /health/live` (no dependency checks) — `server/routes/health.js`.
- The Sync_Worker exposes its OWN separate `/health` on `SYNC_WORKER_HEALTH_PORT`, backed by a `sync_worker_heartbeat` DB row with a 90s staleness threshold — it is a distinct process from the main server and is not covered by the routes above.

## Conventions

- Security-critical deps (`jsonwebtoken`, `helmet`, `express-rate-limit`, `node-forge`) are pinned to exact versions and enforced in CI. New client deps are pinned exactly too.
  - `node-forge` specifically converts the TAK Server admin P12 credential to PEM in pure JS, deliberately avoiding a runtime dependency on an `openssl` binary. See `tak-server-integration.md` for why.
- Every environment variable the code reads must be documented in `.env.example` with a safe default.
- Add new schema as a `node-pg-migrate` `.cjs` migration. Never hand-edit `schema.sql` as a source of truth. This app has never been deployed anywhere outside its own dev/test environment, so migration history is periodically re-squashed into a single baseline file rather than accumulating an ever-growing incremental chain — but incremental migrations DO accumulate between squashes (there are currently several sitting on top of the baseline, the latest being `1790000000000_add-user-cache-last-login`); the next schema change should be its own new incremental migration alongside them, and a future squash folds the accumulated set back into the baseline.
