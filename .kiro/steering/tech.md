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
- Lint: `npm run lint` (root).
- Pinned-dependency check: `npm run lint:pinned-deps`.
- Migrations: `npm run migrate:up`, `npm run migrate:create`. `node database/init.js` runs the chain.
- Dev: `npm run dev` (concurrent server + client).

## Two things that surprise people

- **`npm run lint` does not lint `client/`.** Its scope is `server scripts database/*.js eslint.config.js`, and `client/` has no lint script. The Vitest suite is the only gate on client code.
- **There are two independent test runners and two dependency trees.** Root Jest for `server/`, `client/`'s Vitest for `client/`. A client dependency must be added to `client/package.json`.
- **`TAK_SERVER_ENROLLMENT_URL` and `TAK_SERVER_URL` are deliberately different hosts, not aliases.** `TAK_SERVER_URL` is the Marti certadmin API's mutual-TLS endpoint (`TakServerService.js`), often internal/admin-only. `TAK_SERVER_ENROLLMENT_URL` is the public, client-dialable host `DeviceEnrollmentService` builds enrollment URIs/QR payloads from. They can legitimately point at different hostnames and/or ports — never collapse them to one var.

## Conventions

- Security-critical deps (`jsonwebtoken`, `helmet`, `express-rate-limit`, `node-forge`) are pinned to exact versions and enforced in CI. New client deps are pinned exactly too.
- Every environment variable the code reads must be documented in `.env.example` with a safe default.
- Add new schema as a `node-pg-migrate` `.cjs` migration. Never hand-edit `schema.sql` as a source of truth. This app has never been deployed anywhere outside its own dev/test environment, so migration history is periodically re-squashed into a single baseline file rather than accumulating an ever-growing incremental chain — currently zero incremental migrations sit on top of the baseline; the next schema change should be its own new incremental migration alongside it.
