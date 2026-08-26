# Spec index

These ten folders are **completed change records, not current-state documentation**. Code cites them
by number in ~3,400 comments across ~260 files under `server/` and `client/src/`. Requirement numbers
are NOT globally unique — all ten specs define a "Requirement 5" — so a citation must name its spec
(`// device-management Requirement 5.3`). Where two specs conflict, the later one wins. The durable
rules extracted from these specs live in `.kiro/steering/`.

All ten are `specType: feature`. All use the `requirements-first` workflow except `audit-log-ui`,
which is `design-first`.

## Index

| Spec | Capability | Requirements | Tasks | Status |
| --- | --- | --- | --- | --- |
| `production-hardening` | Identity & access | 33 | 271 done, 0 open | complete |
| `signup-flow-rework` | Identity & access | 10 | 44 done, 18 open | complete (16 optional test tasks not done) |
| `org-team-hierarchy` | Org & team model | 14 (nos. 10, 12 unused) | 138 done, 0 open | complete |
| `member-visibility-and-callsign-recompute` | Org & team model | 15 | 66 done, 0 open | complete |
| `team-member-transfer` | Org & team model | 17 | 72 done, 0 open | complete |
| `cloudtak-agency-groups` | Channels | 10 | 41 done, 0 open | complete |
| `device-management` | Devices | 22 | 145 done, 0 open | complete |
| `admin-settings-management` | Admin & operations | 10 | 30 done, 0 open | complete |
| `audit-log-ui` | Admin & operations | 6 | 26 done, 15 open | complete (14 optional test tasks not done) |
| `date-tooltips-and-folder-contrast` | UI quality | 7 | 39 done, 0 open | complete |

The open checkboxes in `signup-flow-rework` and `audit-log-ui` are **not abandoned work**. Every open
leaf in both is marked `*` (optional), and the few open parents — signup-flow-rework 15 and 19,
audit-log-ui 15 — have no remaining non-optional children. Both specs shipped.

## Known stale spec text

Two places where a spec's own text no longer describes the code. Do not trust them.

- **`audit-log-ui` — the audit-log filter field.** Its requirements name a `userId` filter input
  (Criterion 3.1, and the Filter_Form definition). The shipped code filters on `userEmail`
  (`server/routes/auditLogs.js`), following a later `production-hardening` change. The spec text was
  not updated.
- **`date-tooltips-and-folder-contrast` — Criterion 3.4's table-cell count.** It says eight of the ten
  Date_Render_Positions are table cells. Measured, it is six table cells and four `<p>`-hosted. The
  correction is recorded in that spec's own `design.md` as correction 1; it changes no placement
  behaviour, only where a reviewer should expect to find each tooltip.
