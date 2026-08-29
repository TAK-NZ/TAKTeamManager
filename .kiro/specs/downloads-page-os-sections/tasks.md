# Implementation Plan: Downloads Page OS Sections

## Overview

Two independent halves, ordered server-first because the client's CloudTAK_Row has nothing to fetch until it exists.

**Sections 1-3 are the server-side CLOUDTAK_URL feature** (Requirement 5): a new pure resolver in `server/utils/`, one new line in `SiteConfig.js`'s `getPublicConfig()`, and the `.env.example` documentation. This ships and can be verified entirely independently of anything client-side — `GET /api/config/public` gains a `cloudtak_url` field regardless of whether any page reads it yet.

**Sections 4-6 are the shared Platform_Logo/Windows_Glyph work** (Requirement 6): the new `simple-icons` dependency, the new `PlatformLogos.jsx` wrapper module, and `DeviceTypeIcon.jsx`'s glyph swap. This must land before Section 7, because `Downloads.jsx`'s `OsSection` headers use the same `AndroidPlatformLogo`/`ApplePlatformLogo` components `DeviceTypeIcon.jsx` adopts (Requirement 6.2's "same" wording is not incidental — one wrapper, two call sites).

**Section 7 is the Downloads_Page restructuring** (Requirements 1-4, 7): the three per-OS route arrays, the new `OsSection` sub-component, the new WinTAK route and its accessible-name override, and the CloudTAK_Row's fetch/conditional-render. It depends on Sections 4-6 for the logos and is otherwise self-contained.

Section 8 is the final verification.

The design uses a specific language (React/JavaScript on the client, Node/JavaScript on the server), so no language-selection question is needed.

Test-only sub-tasks are marked `*` and may be skipped for a faster MVP. None of this spec's tests are "the test IS the deliverable" in the way `date-tooltips-and-folder-contrast`'s red-first contrast test or drift guard are — there is no structural guard and no red-first requirement here — so every test sub-task in this plan follows the ordinary optional-marking convention.

**`downloadsContrast.test.jsx` is deliberately NOT a task.** design.md's Testing Strategy section states explicitly that this would-be test is "not required by any acceptance criterion" here, because Requirement 6.1's >=3:1 floor is already met by reusing the `text-gray-500 dark:text-gray-400` token pair `channelTreeContrast.test.jsx` (from the `date-tooltips-and-folder-contrast` spec) already asserts passing. Adding it would be scope this spec's own design document declines.

**There is no migration, no schema change, and no wire-format change beyond one new optional string field (`cloudtak_url`) on an existing endpoint.** Nothing to look for in `database/migrations/`.

## Tasks

- [x] 1. Build and test the CLOUDTAK_URL resolver
  - The one genuine PBT candidate in this feature (design.md's Correctness Properties section): Criteria 5.1-5.3 are two halves of one total function, not three separate rules, so one property test covers all three.
  - [x] 1.1 Create `server/utils/cloudtakUrl.js`
    - Export `resolveCloudTakUrl(rawValue)`: pure, total, never throws, lives in `server/utils/` with no framework import (this project's convention that pure decision logic with interesting boundaries belongs where a property test can reach it directly — mirrors `clientType.js`'s own placement rationale).
    - Non-string input (including `undefined`) -> `null`. Trim to detect the whitespace-only case (Criterion 5.2) -> `null` for `''` or all-whitespace, but call `new URL(...)` on the **untrimmed** raw value — Criterion 5.1 requires the exact, unmodified string on success, and `new URL()` already trims ASCII whitespace itself before parsing.
    - A `new URL(rawValue)` construction failure -> `null` (wrapped in try/catch; this is the only fallible call and the only reason the function needs a try at all).
    - `parsed.protocol` must be exactly `'http:'` or `'https:'` (case-insensitivity falls out for free — `URL.protocol` is always lowercased by the parser) -> otherwise `null` (Criterion 5.3).
    - `parsed.hostname === ''` -> `null` (catches `https:///path`'s empty authority; Criterion 5.3's "non-empty host component").
    - On success, return `rawValue` itself (the identical reference), never a re-serialized or trimmed copy.
    - _Requirements: 5.1, 5.2, 5.3_
    - Files: `server/utils/cloudtakUrl.js`
  - [x] 1.2 Write property test for CLOUDTAK_URL resolution
    - **Property 1: CLOUDTAK_URL resolution is a total function partitioned exactly into "exact passthrough" and "null"**
    - Tag exactly: `// Feature: downloads-page-os-sections, Property 1: CLOUDTAK_URL resolution is a total function partitioned exactly into "exact passthrough" and "null"`
    - `@fast-check/jest`, `numRuns >= 200`, following `authentikEmail.property.test.js`'s structure.
    - **Boundary concentration**: `fc.oneof` mixing (a) whitespace-only strings of varying composition including `''`, (b) syntactically malformed strings, (c) non-http(s) absolute URLs (`ftp://`, `javascript:`, `mailto:`, `data:`, case variants of the scheme), (d) empty-host `http(s)` URLs (`https:///path`), (e) valid `http`/`https` URLs varied across scheme case, port, userinfo, path, query, fragment, IPv4/IPv6/hostname forms, and (f) a broad `fc.string()` arm.
    - **Totality inputs** also include non-string values (`null`, `undefined`, numbers, booleans, objects, arrays, symbols, bigints) even though the declared parameter type is a string — never throws for any of them.
    - **Independent re-derivation**: compute the expected result in the test file directly against Node's own `URL` constructor and `.protocol`/`.hostname`, never by importing `resolveCloudTakUrl`'s internals or calling it to check itself.
    - **Anti-vacuity**: assert the run actually produced at least one `null` result and at least one non-null passthrough result (mirroring `authentikEmail.property.test.js`'s `sawNullResult`/`sawNonNullResult` flags).
    - **Validates: Requirements 5.1, 5.2, 5.3**
    - _Requirements: 5.1, 5.2, 5.3_
    - Files: `server/utils/cloudtakUrl.property.test.js`
  - [x] 1.3 Write unit tests for CLOUDTAK_URL resolution's named cases
    - Concrete cases from design.md's Testing Strategy: unset (`undefined`) -> `null`; `''` -> `null`; `'   '` -> `null`; `'https://cloudtak.example.com'` -> unchanged; `'http://cloudtak.internal:8080/path?x=1'` -> unchanged; `'HTTPS://cloudtak.example.com'` -> unchanged (case-insensitive scheme); `'ftp://cloudtak.example.com'` -> `null`; `'javascript:alert(1)'` -> `null`; `'not a url'` -> `null`; `'https:///no-host'` -> `null`.
    - Assert the success cases return the exact, unmodified input string (identity or `toBe`, not merely equal content).
    - _Requirements: 5.1, 5.2, 5.3_
    - Files: `server/utils/cloudtakUrl.test.js`

- [x] 2. Wire CLOUDTAK_URL into the Public_Config_Endpoint and document it
  - [x] 2.1 Call `resolveCloudTakUrl` from `SiteConfig.js`'s `getPublicConfig()`
    - Add `const { resolveCloudTakUrl } = require('../utils/cloudtakUrl');` near the top, and one new line — `config.cloudtak_url = resolveCloudTakUrl(process.env.CLOUDTAK_URL);` — following the existing `tos_url`/`docs_url` one-line-assignment pattern in the same file.
    - Independent of `CLOUDTAK_ENABLED`: this line never reads `isCloudTakEnabled()` or `process.env.CLOUDTAK_ENABLED` (Criterion 5.4). Add a short comment noting this, matching the existing comments in this file that call out similar independence facts.
    - Do NOT touch `server/routes/config.js`'s `GET /public` handler or `server/config/publicRoutes.js` — `cloudtak_url` rides on the same unauthenticated response `tos_url`/`docs_url`/`display_timezone` already use, with no route change needed.
    - _Requirements: 5.1, 5.4_
    - Files: `server/models/SiteConfig.js`
  - [x] 2.2 Extend `server/models/SiteConfig.test.js` with `cloudtak_url` coverage
    - Add to the existing `describe('SiteConfig.getPublicConfig', ...)` block, following its `test.each`/`ORIGINAL_ENV` conventions already in the file.
    - Assert `cloudtak_url` equals `CLOUDTAK_URL` when set to a valid absolute `http://` or `https://` URL (Criterion 5.6's first half).
    - Assert `cloudtak_url` is `null` when `CLOUDTAK_URL` is unset (Criterion 5.6's second half).
    - Assert `cloudtak_url` is unaffected by `CLOUDTAK_ENABLED` being `'true'`, unset, or `'TRUE'` — a small fixed matrix, not iteration (Criterion 5.4).
    - **Do NOT touch, weaken, or remove the existing `DEVICE_MGMT_KEY_PATTERN`/`REVOKE_KEY_PATTERN` guard tests in this file** (Criterion 5.6, first sentence). `cloudtak_url` matches neither pattern, so no existing assertion needs to change.
    - _Requirements: 5.6_
    - Files: `server/models/SiteConfig.test.js`
  - [x] 2.3 Document `CLOUDTAK_URL` in `.env.example`
    - Add a new block, matching the existing `CLOUDTAK_ENABLED` block's structure and placed near it, stating: it is optional, defaults to unset/empty (safe default per this project's env-var convention), controls the CloudTAK link the Downloads page's CloudTAK_Row shows, and is explicitly INDEPENDENT of `CLOUDTAK_ENABLED` — the two are read by unrelated functions and neither is derived from the other.
    - _Requirements: 5.5_
    - Files: `.env.example`

- [x] 3. Checkpoint - server-side CLOUDTAK_URL feature is complete
  - Run `npm test` from the repo root and confirm `server/utils/cloudtakUrl.test.js`, `server/utils/cloudtakUrl.property.test.js`, and the extended `server/models/SiteConfig.test.js` all pass, and that no other server test broke.
  - Confirm `GET /api/config/public` (exercised via the `SiteConfig.test.js` suite) returns `cloudtak_url` on every response, independent of `CLOUDTAK_ENABLED`.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Add the `simple-icons` dependency and the shared `PlatformLogos` component
  - [x] 4.1 Add `simple-icons` to `client/package.json`
    - Add as a new dependency, exactly pinned (this project's convention for new client dependencies) rather than left on a semver range. Run `cd client && npm install` (or the project's equivalent) so `client/package-lock.json` (or lockfile) reflects it.
    - _Requirements: 6.1_
    - Files: `client/package.json`
  - [x] 4.2 Create `client/src/components/PlatformLogos.jsx`
    - Export `AndroidPlatformLogo` and `ApplePlatformLogo`, each a thin wrapper around `simple-icons`' `siAndroid`/`siApple` icon objects (`{ path, title }`).
    - External contract, exactly: `viewBox="0 0 24 24"`, `className` passthrough, `aria-hidden` defaulting to `"true"` (destructure `'aria-hidden': ariaHidden = 'true'`), `fill="currentColor"` (never each icon's own brand hex — Requirement 6.1/6.2's >=3:1 contrast floor fails for both brand colors as shipped; `currentColor` lets each call site pick the existing `text-gray-500 dark:text-gray-400` pair already measured passing elsewhere in this app).
    - A single private `simpleIcon(icon)` factory returning the wrapper component, applied once for each of the two exports, so the `<svg>` markup is written once.
    - Windows gets NO entry in this file: `ComputerDesktopIcon` is imported directly from `@heroicons/react/24/outline` at each of its two call sites (`Downloads.jsx`, `DeviceTypeIcon.jsx`) rather than re-exported here, since it needs no simple-icons wrapping.
    - This is a new file rather than an addition to `StoreBadges.jsx` (wrong direction of coupling — a Downloads-page badge file would become a dependency of the shared device-glyph component) or inline duplication in both consumers (Requirement 6.2 requires the "same" Platform_Logo in both places).
    - _Requirements: 6.1, 6.2, 6.8_
    - Files: `client/src/components/PlatformLogos.jsx`
  - [x] 4.3 Write unit tests for `PlatformLogos.jsx`
    - Mount with `createRoot` + `act` (`globalThis.React = React`), per this project's no-`@testing-library/react` convention.
    - For each of `AndroidPlatformLogo`/`ApplePlatformLogo`: renders an `<svg>` with `viewBox="0 0 24 24"`; a supplied `className` is forwarded onto that `<svg>`; `aria-hidden` defaults to `"true"` when not supplied; the rendered `<path>`'s `d` attribute equals `simple-icons`' own `siAndroid.path`/`siApple.path` export exactly (a direct-dependency-fidelity check, mirroring `storeBadgeFidelity.test.jsx`'s treatment of the existing store badges).
    - _Requirements: 6.1, 6.2_
    - Files: `client/src/components/PlatformLogos.test.jsx`

- [x] 5. Swap `DeviceTypeIcon.jsx`'s hand-drawn glyphs for the shared Platform_Logo/Windows_Glyph
  - [x] 5.1 Replace `AndroidGlyph`/`IosGlyph`/`WindowsGlyph` in `DeviceTypeIcon.jsx`
    - Import `ComputerDesktopIcon` alongside the existing `GlobeAltIcon`/`QuestionMarkCircleIcon` from `@heroicons/react/24/outline`, and import `AndroidPlatformLogo`/`ApplePlatformLogo` from `./PlatformLogos`.
    - Delete the three hand-drawn glyph functions (`AndroidGlyph`, `IosGlyph`, `WindowsGlyph`) entirely.
    - Update the `GLYPHS` lookup object: `[CLIENT_TYPES.ANDROID]: AndroidPlatformLogo`, `[CLIENT_TYPES.IOS]: ApplePlatformLogo`, `[CLIENT_TYPES.WINDOWS]: ComputerDesktopIcon`. `CLOUDTAK`/`UNKNOWN` entries stay exactly as they are (Criterion 6.3).
    - Update the file's header doc comment to the exact before/after text design.md gives under "`client/src/components/DeviceTypeIcon.jsx` (glyph replacement)": state that Android/iOS glyphs are sourced from the `simple-icons` npm dependency via `PlatformLogos.jsx`, matching the Platform_Logo used in the Downloads page's own headers, that Windows uses heroicons' `ComputerDesktopIcon` because `simple-icons` does not ship a Windows/Microsoft logo, and that CloudTAK/Unknown continue to use heroicons as before. Remove the old sentence stating the component introduces no new client dependency (Criterion 6.5).
    - Leave `CLIENT_TYPES`, `DEVICE_TYPE_LABELS`, `resolveClientType`, `labelForClientType`, and the default-exported component's `role="img"`/`aria-label`/tooltip markup completely untouched (Criteria 6.4, 6.7) — every glyph, old or new, is rendered the same way: `<Glyph className={...} />` inside the existing wrapping `<span role="img">`, so the substitution is invisible to the wrapper.
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.7_
    - Files: `client/src/components/DeviceTypeIcon.jsx`
  - [x] 5.2 Extend `DeviceTypeIcon.test.jsx` with a should-not-regress assertion
    - The existing `it.each(TYPES_AND_LABELS)` sweep already exercises all five Client_Types and needs no new cases for the swap itself (the "draws a visually distinct glyph for each of the five Client_Types" test passes as long as the five glyphs remain visually distinct, which they are by construction).
    - Add ONE new assertion: the `android` and `ios` glyphs' rendered `<svg>` no longer contain the hand-drawn `<circle>` elements the old `AndroidGlyph` used — a should-not-regress check that the swap actually happened, not just that some distinct glyph renders.
    - _Requirements: 6.2_
    - Files: `client/src/components/DeviceTypeIcon.test.jsx`

- [x] 6. Checkpoint - Device_Type_Icon glyph swap is complete
  - Run `cd client && npx vitest --run src/components/PlatformLogos src/components/DeviceTypeIcon` and confirm all pass.
  - Run `cd client && npx vitest --run` and confirm no other client test broke — in particular, nothing in `Dashboard.test.jsx` or `UserDevicesModal.test.jsx` asserted the old hand-drawn glyph's internal markup.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Restructure `Downloads.jsx` into Android/iOS/Windows_Sections plus the CloudTAK_Row
  - Four sub-tasks that all edit `Downloads.jsx` in sequence, plus the test extension. `StoreBadges.jsx` is NOT modified anywhere in this section — `TakGovBadge` is reused unmodified per Criterion 3.3.
  - [x] 7.1 Build the three per-OS route arrays and the `OsSection` sub-component
    - Replace the single flat `DOWNLOAD_ROUTES` array with three named arrays: `ANDROID_ROUTES` (the existing ATAK-via-TAK.gov and ATAK-via-Google-Play entries, `recommended: true`/`false` respectively, unchanged hrefs/badges — Criteria 1.1, 1.2, 1.3, 1.5), `IOS_ROUTES` (the existing TAK Aware and iTAK entries, unchanged hrefs/badges — Criteria 2.1, 2.2, 2.3, 2.5), and `WINDOWS_ROUTES` (the new single WinTAK entry — task 7.2 below). Each entry gains an optional `badgeAriaLabel` field, `undefined` for every existing route.
    - Add the `OsSection` sub-component in the same file (not extracted to its own file — it has a single caller): takes `{ PlatformLogo, osLabel, routes }`, renders the section header (`PlatformLogo` with `aria-hidden="true"`, Criterion 6.8, beside the visible `osLabel` text — Criteria 1.4, 2.4, 2.6, 3.5) and the routes list (label + `RecommendedOptionMarker` when `recommended`, then the badge anchor with `rel="noopener"`, `target="_blank"`, and `{...(badgeAriaLabel ? { 'aria-label': badgeAriaLabel } : {})}` applied to the `<a>` — Criteria 1.2, 1.3, 2.2, 2.3, 3.4, 7.1, 7.3).
    - Keep `BADGE_CLASSNAME` (`'h-10 w-auto'`) exactly as it is and apply it to every badge in every section, including WinTAK's (Criterion 7.3).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.8, 7.1, 7.3_
    - Files: `client/src/pages/Downloads.jsx`
  - [x] 7.2 Add the WinTAK Download_Route and its distinct accessible-name override
    - `WINDOWS_ROUTES` gets exactly one entry: `href: 'https://tak.gov/products/wintak-civ'`, `label: 'WinTAK'`, `Badge: TakGovBadge` (reused unmodified), `recommended: false`, `badgeAriaLabel: 'Get it from TAK.gov — WinTAK'` (Criteria 3.1, 3.2, 3.4).
    - **The distinguishing name MUST be carried by `aria-label` on the anchor itself, not by sibling visible text** (Criterion 3.7): an element's own `aria-label` short-circuits the accessible-name computation before it descends into content, so the WinTAK anchor's name becomes `"Get it from TAK.gov — WinTAK"` regardless of the inner `TakGovBadge` SVG's own `role="img"`/`aria-label="Get it from TAK.gov"`. This is already handled generically by `OsSection`'s `badgeAriaLabel` field from task 7.1 — this task is choosing the value for the one route that needs it.
    - Assemble the page body with all three `OsSection`s in a `grid grid-cols-1 sm:grid-cols-3 gap-8` inside the existing `.card`: `<OsSection PlatformLogo={AndroidPlatformLogo} osLabel="Android" routes={ANDROID_ROUTES} />`, `<OsSection PlatformLogo={ApplePlatformLogo} osLabel="iOS" routes={IOS_ROUTES} />`, `<OsSection PlatformLogo={ComputerDesktopIcon} osLabel="Windows" routes={WINDOWS_ROUTES} />` (Criteria 3.5, 6.1).
    - Keep the footnote legend (`RecommendedOptionGlyph` + "Recommended option" text) exactly as it is today, unconditional, below everything else on the page (Criterion 7.2).
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 6.1, 7.2_
    - Files: `client/src/pages/Downloads.jsx`
  - [x] 7.3 Add the CloudTAK_Row's fetch effect and conditional rendering
    - Add `const [cloudTakUrl, setCloudTakUrl] = useState(null)` and a mount-only `useEffect` calling `configAPI.getPublic()` (imported from `../services/api`), setting `cloudTakUrl` from `response.data?.cloudtak_url ?? null` on success, and doing nothing on `.catch()` — a rejected fetch is indistinguishable from a `null` `cloudtak_url` (Criterion 4.6's fail-closed spirit extended to the network-failure case). Guard against a late resolution after unmount with a `cancelled` flag, matching the pattern already used elsewhere in this codebase (`GlobalChannels.jsx`'s `channel_folder_separator` fetch).
    - Render the CloudTAK_Row as a **sibling `<div>` below the 3-column grid**, inside the same `.card`, NOT as a 4th grid item with `col-span-full` (design.md Decision 2 — a full-width block below the grid satisfies "spans all three, not nested inside any one" without coupling the row's markup to the grid's column count).
    - Render it only `{cloudTakUrl && (...)}`  — omitted entirely when `null` (Criterion 4.6).
    - Inside: the heroicons `GlobeAltIcon` (`aria-hidden="true"`, matching `DeviceTypeIcon.jsx`'s CloudTAK glyph — Criterion 4.3), an anchor to `cloudTakUrl` with `target="_blank"` and `rel="noopener"` (Criterion 4.2, 7.1), and visible (non-`sr-only`) text stating CloudTAK is browser-based and naming Android, iOS, and Windows explicitly alongside other browser-capable operating systems (Criterion 4.5). No `RecommendedOptionMarker` anywhere in this block (Criterion 4.4).
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1_
    - Files: `client/src/pages/Downloads.jsx`
  - [x] 7.4 Extend `Downloads.test.jsx` for the new per-section structure and the CloudTAK_Row
    - **Mock-hygiene fix required first**: this file's existing `vi.mock('../services/api', ...)` factory supplies only `authAPI`/`requestsAPI`. Add `configAPI: { getPublic: vi.fn() }` to the same factory — a named import of a missing export from a mocked ES module is a load-time failure the moment `Downloads.jsx` starts calling `configAPI.getPublic()`.
    - Three sections render, each containing exactly its own routes (Android: 2, iOS: 2, Windows: 1), with the Recommended_Option_Marker present/absent per Criteria 1.2, 1.3, 2.2, 2.3, 3.4.
    - The WinTAK anchor carries `aria-label="Get it from TAK.gov — WinTAK"` (read directly via `getAttribute('aria-label')`, since jsdom does not compute full accessible-name resolution); the ATAK-via-TAK.gov anchor carries NO `aria-label` of its own (its name comes from its child SVG) — assert both, so the two are shown distinguishable rather than merely present.
    - `configAPI.getPublic` resolving `{ data: { cloudtak_url: 'https://cloudtak.example.com' } }` renders exactly one CloudTAK_Row with that href and visible text naming Android, iOS, Windows, and other operating systems.
    - `configAPI.getPublic` resolving `{ data: { cloudtak_url: null } }` AND `configAPI.getPublic` rejecting both result in NO CloudTAK_Row in the DOM (Criterion 4.6 plus the fail-closed rejection case).
    - Every rendered external anchor — across all three sections and the CloudTAK_Row when present — carries `rel="noopener"` (Criterion 7.1).
    - The footnote legend appears exactly once, at the page level, regardless of `cloudtak_url` state (Criterion 7.2).
    - **Update the file's existing assertions to the new per-section DOM structure rather than leaving them failing against a flat grid that no longer exists**: the "renders every one of the four badge SVGs at the same visible size" test becomes "every one of the **five** badge SVGs" (the new WinTAK route adds one), and any query that assumed a single flat grid (e.g. finding a route's cell by iterating `.flex.flex-col` across the whole page) is re-scoped to search within the relevant `OsSection`. The "no via-sublabel", "ATAK not ATAK Civ", footnote-occurrence-count, and marker-tooltip-disclosure tests are updated to match the new markup while asserting the same underlying facts.
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.4, 3.6, 3.7, 4.1, 4.2, 4.4, 4.5, 4.6, 7.1, 7.2_
    - Files: `client/src/pages/Downloads.test.jsx`

- [x] 8. Final checkpoint - full spec verification
  - Run `cd client && npx vitest --run` and confirm the whole client suite passes, including the new/extended `PlatformLogos.test.jsx`, `DeviceTypeIcon.test.jsx`, and `Downloads.test.jsx`.
  - Run `npm test` from the repo root and confirm the whole server suite passes, including the new/extended `cloudtakUrl.test.js`, `cloudtakUrl.property.test.js`, and `SiteConfig.test.js`.
  - Run `npm run lint` from the repo root and confirm the problem count is unchanged from baseline — `client/` is not linted by this script (this project's own documented surprise), so the client vitest suite is the real gate on everything in Sections 4-7.
  - Confirm Property 1 is present, tagged exactly, at `numRuns >= 200`, in its own file (`server/utils/cloudtakUrl.property.test.js`).
  - Confirm `requirements.md`'s Windows_Glyph correction (heroicons' `ComputerDesktopIcon` rather than a simple-icons brand logo) is already reflected in both `requirements.md` and this `design.md` — per this task's own briefing, that correction was already applied before this planning phase, so no further documentation change is needed here.
  - One thing to raise in review, recorded in design.md rather than discovered here: **Requirement 6.1/6.2's literal "all three from simple-icons" wording is deliberately not satisfied for Windows** — `simple-icons` has no Windows/Microsoft icon (removed in v13.0.0 after Microsoft's own legal restriction), so Windows uses a neutral heroicons glyph instead, confirmed with the user and recorded in design.md's Design Decisions section.
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked `*` are optional and can be skipped for a faster MVP.
- `downloadsContrast.test.jsx` is intentionally not a task — design.md's own Testing Strategy section says it is not required by any acceptance criterion, since the >=3:1 contrast floor is already met by reusing an already-passing token pair.
- Sections 1-3 (server) and Sections 4-7 (client) can be developed and reviewed somewhat independently, but Section 7 depends on Section 4's `PlatformLogos.jsx` for its `OsSection` headers.
- Client tests mount with `react-dom/client`'s `createRoot` inside React 18's `act` and dispatch events natively — there is no `@testing-library/react` in this project and none is added.
- Server property tests use `@fast-check/jest`; client property tests (none in this spec) would use plain `fast-check`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.3", "4.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "4.2"] },
    { "id": 2, "tasks": ["2.2", "4.3", "5.1", "7.1"] },
    { "id": 3, "tasks": ["5.2", "7.2"] },
    { "id": 4, "tasks": ["7.3"] },
    { "id": 5, "tasks": ["7.4"] }
  ]
}
```

Wave 0 holds everything with no dependency on other new code: `cloudtakUrl.js` itself, the `.env.example` documentation (pure prose, no code dependency), and the `simple-icons` `package.json` addition. Wave 1 builds on those three: the property and unit tests for `cloudtakUrl.js`, `SiteConfig.js`'s one-line integration, and `PlatformLogos.jsx` (needs the installed dependency). Wave 2 fans out from there — `SiteConfig.test.js`'s extension, `PlatformLogos.test.jsx`, `DeviceTypeIcon.jsx`'s glyph swap, and `Downloads.jsx`'s route arrays/`OsSection` component all depend on exactly one wave-0/1 artifact each and touch four different files, so they run together. Waves 3-5 serialize the three `Downloads.jsx` edits (7.1, 7.2, 7.3) across separate waves per the same-file rule, with `DeviceTypeIcon.test.jsx`'s extension (5.2, depends on 5.1) riding alongside 7.2. `Downloads.test.jsx`'s extension (7.4) is last because it depends on all three `Downloads.jsx` edits being complete.

Checkpoint tasks (3, 6, 8) are not in the graph: they gate a section rather than producing code, and each runs after every leaf task in its own section.
