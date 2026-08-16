# Bug / Issue Tracker

Running log of issues found during manual testing, outside the formal `.kiro/specs/` workflow.
For anything requiring root-cause investigation before a fix is obvious, promote it to a proper
bugfix spec under `.kiro/specs/` instead of just fixing it inline here.

Status values: `open`, `fixed`, `needs-info`.

---

## BUG-001: Session cookie `secure: true` hardcoded, breaks login over plain HTTP
- **Where:** `server/routes/auth.js`, `getSessionCookieOptions()`
- **Expected:** Logging in via `/api/auth/sso` over `http://` (local/dev testing) results in an authenticated session.
- **Actual:** `tak_session` cookie set with hardcoded `secure: true`; browsers silently drop `Secure` cookies over plain HTTP, so the session never persists.
- **Severity:** blocker (dev/test only — not an issue once served over real HTTPS in production)
- **Status:** fixed — `secure` is now `process.env.NODE_ENV === 'production'`.

## BUG-002: `App.jsx` never checks for an existing session cookie on load
- **Where:** `client/src/App.jsx`
- **Expected:** After a successful OAuth callback (cookie set, redirected to `/dashboard`), the app shows the authenticated dashboard.
- **Actual:** Startup logic only checked a dead `?token=` URL param / `localStorage` token (leftover from a pre-cookie auth model). Since the server never produces either anymore, the app always fell through to the logged-out Login screen regardless of a valid session cookie.
- **Severity:** blocker
- **Status:** fixed — mount effect now calls `authAPI.getProfile()` unconditionally first, falling back to auto-login only on failure.

## BUG-003: Admin actions crash with `Cannot read properties of undefined (reading 'id')`
- **Where:** `server/routes/globalChannels.js` (`POST /api/global-channels/sync-existing` and ~7 other routes), `server/routes/users.js` (2 more)
- **Expected:** Any admin action (sync channels, create/update/delete BCH/region channels, etc.) resolves the acting user's local id and succeeds.
- **Actual:** These routes do `SELECT id FROM users WHERE authentik_user_id = req.user.id`, but the `users` table was only ever populated by explicit provisioning flows (create-and-add, access-request approval, bulk import, device enrollment) — never by the periodic Authentik sync. Any user who only ever logged in via SSO (never explicitly provisioned) has zero rows in `users`, so the lookup returns nothing and `.id` throws.
- **Severity:** blocker
- **Status:** fixed — `authentikSync.js`'s `syncSingleUser` now also upserts a `users` row (keyed on `authentik_user_id`) alongside the existing `user_cache` upsert.

## BUG-004: `users` upsert crashes on emailless Authentik service accounts
- **Where:** `server/services/authentikSync.js` (regression introduced by the BUG-003 fix)
- **Expected:** Sync completes cleanly for all Authentik users, including non-human service/API accounts (`etl-*`, `ak-outpost-*`, etc.).
- **Actual:** `users.email` is `UNIQUE NOT NULL`; service accounts have no email in Authentik, so the first one to sync claims the empty-string email and every subsequent emailless account fails with a duplicate-key error.
- **Severity:** minor (sync still completes overall; only affects non-human accounts, which don't need a `users` row anyway)
- **Status:** fixed — `users` upsert is now skipped when `user.email` is falsy; `user_cache` upsert is unaffected.

## BUG-005: `.env`/`FRONTEND_URL` pointed at the API port instead of the Vite dev server
- **Where:** `.env`
- **Expected:** OAuth callback redirect lands on the actual client app.
- **Actual:** `FRONTEND_URL=http://44.229.3.37:3000` (API port, no client build there in dev) caused `ENOENT: /app/client/dist/index.html` on every redirect.
- **Severity:** blocker (local dev only)
- **Status:** fixed — `FRONTEND_URL` now points at `:5173` (Vite dev server) in local dev; in production this and `APP_URL` should be the same single HTTPS origin (see NOTE-001).

---

## Follow-ups / not yet fixed

## NOTE-001: No `app.set('trust proxy', ...)` in `server/index.js`
- **Where:** `server/index.js`
- **Issue:** Behind a real load balancer/reverse proxy (the intended ECS Fargate production topology), `req.ip` will resolve to the LB's internal IP for every request, collapsing all `req.ip`-keyed rate limiters (`authLimiter`, `requestAccessLimiter`, etc.) onto a single shared bucket. Also affects `helmet`'s HSTS behavior, which relies on correctly detecting HTTPS via `X-Forwarded-Proto`.
- **Severity:** major, production-only
- **Status:** open — flagged to user, not yet fixed (deferred pending decision on when the LB layer is actually stood up).

## NOTE-002: Dead `localStorage`/`Authorization: Bearer` code remains in several client pages
- **Where:** `client/src/pages/Dashboard.jsx`, `client/src/pages/Admin.jsx`, `client/src/components/Layout.jsx`
- **Issue:** These still read `localStorage.getItem('token')` and send `Authorization: Bearer ...` headers, left over from the pre-cookie auth model. Currently harmless (the server's `authenticateToken` middleware only ever reads the `tak_session` cookie, and these calls use relative same-origin paths so the cookie is sent automatically regardless) but it's dead/misleading code.
- **Severity:** minor (cleanup only, no functional impact)
- **Status:** open

## NOTE-003: All production-hardening work (64 tasks) is uncommitted
- **Where:** whole repo
- **Issue:** `git status` shows ~40 modified files and ~90 untracked new files (new services, middleware, tests, migrations, etc.) — none of it committed. It only exists in this working directory. No durable record, nothing deployable/reviewable until committed.
- **Severity:** major (process risk, not a functional bug)
- **Status:** open
