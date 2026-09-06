---
inclusion: always
---

# TAK Team Manager

Manages TAK teams, users and channels via Authentik as the identity provider, with an optional TAK Server device-management integration. Express + Postgres server, React SPA client.

Production hostname: **`team.tak.nz`**. One SPA served from one origin — Team Management, Downloads and Enrollment are all React Router paths in the same bundle, not separable services, and the OAuth2 `redirect_uri`/CORS origin/`tak_session` cookie are each wired to exactly one hostname (`server/index.js`, `server/routes/auth.js`). This sits alongside TAK-NZ's other `*.tak.nz` subdomains — `account` (Authentik SSO), `map` (CloudTAK), `docs` (documentation) — each a single-word noun for what it does; `team` was chosen over the old standalone enrollment Lambda's `devices.tak.nz` because this app's scope is the broader team/user/channel back office, not just device enrollment. CDK-based deployment of this hostname is a follow-up, not yet done.

## Domain vocabulary

- **Team** — a row in `teams`. Every hierarchy node at every depth is a Team at the data-model level.
- **Organisation** — a Team with `parent_team_id IS NULL`. A UI label and a scoping root, never a separate table or id type.
- **Sub_Team** — a Team with a non-null `parent_team_id`. Inherits `color` and `callsign_name_format` from its Organisation, never carries `callsign_level_selection`.
- **Team_Depth** — number of `parent_team_id` links up to the Organisation. 0 at the Organisation. Capped by `MAX_TEAM_DEPTH` (5) in `server/config/constants.js`.
- **Ancestor_Chain** — root-first Organisation → … → Team, from `Team.getAncestorChain`. The shared primitive for admin inheritance, depth checks, field inheritance, callsign generation and visibility. Index 0 is always the Organisation.
- **Team_Admin** — a *direct* (`inherited_from_team_id IS NULL`) `role='admin'` membership row on the Team or any ancestor. An inherited row never confers Team_Admin.
- **Global_Manager** — cached `is_global_manager`; bypasses visibility and directory scoping. Note `req.user.isAdmin` and `req.user.is_global_manager` are ALIASES of the same cached `is_admin` column (`server/middleware/auth.js`). De-aliasing them requires re-auditing every Global_Manager gate.
- **Callsign** — Organisation + Team + Name segments joined with `-`; empty segments and their separator omitted. Team-segment prefixes concatenate with NO separator.
- **Callsign_Suffix** — per-user `users.callsign_suffix`, the Name segment. Defaulted at creation, thereafter changed only by explicit admin edit — never recomputed.
- **Direct_Membership** — at most one `team_memberships` row per user with `inherited_from_team_id IS NULL`, enforced by a partial unique index.
- **Device** — one TAK Server client certificate identified by `client_uid`, in `tak_devices`. Visibility is row presence, nothing else.
- **Sync_Operation** — a queued Authentik/TAK Server write in `sync_operations`, drained by `server/workers/syncWorker.js`.

## Non-negotiables

- Never delete a federated identity to achieve a local outcome. Deleting an Authentik user is unrecoverable.
- Authorization is deny-by-default. An unmapped route is denied, not permitted.
- Feature flags are inert by default and true only for the exact string `'true'`.
- State a user must perceive is carried by TEXT or by an icon that has an accessible name (e.g. an `sr-only` label or `aria-label`), never colour alone. Colour may reinforce a state but is never the sole signal, because it reaches neither assistive technology nor a colourblind user.
- A teamless user's `takCallsign`/`takColor` is ABSENT, never a placeholder. STORED representation: the `takCallsign`/`takColor` keys are DELETED from the Authentik `attributes` dict, and the `user_cache.tak_callsign`/`tak_color` columns are SQL `NULL`. It must NEVER be the literal string `'None'` or an empty string `''` — both are real, non-absent values a TAK client would ingest as an actual callsign/colour, and `takColor: 'None'` in particular is not a valid `TAK_Color` and breaks colour handling downstream. A teamed user always carries a real colour (its Organisation's `color`). Clearing is done exclusively via `UserAttributesService.clearTeamAttributes` (deletes the Authentik keys, NULLs the cache). The word "None" may still be shown as a purely client-side DISPLAY fallback for an absent value (e.g. `EnrollmentView.jsx`'s `orNone()`, the Dashboard's "My Organisation" cell) — that is a rendering label only and must never be written back as stored data.
