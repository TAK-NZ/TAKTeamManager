# Implementation Plan: Date Tooltips and Folder Contrast

## Overview

Two independent concerns, ordered so the smaller and more self-contained one ships first. Neither is a prerequisite of the other and either can be reverted without touching the other — that is the whole reason they are kept as separate task sections rather than interleaved.

**Sections 1-2 are Concern B** (Requirements 5-7): the channel-tree contrast failure. Section 1 builds `client/src/utils/contrast.js` and writes the computed contrast test, which **must be observed RED** against today's markup — Criterion 7.7 makes that ordering part of the deliverable, so the test and the fix are deliberately in separate sections rather than landed together. Section 2 then applies the eleven class strings across `Dashboard.jsx` and `GlobalChannels.jsx` and turns it green.

**Sections 3-7 are Concern A** (Requirements 1-4): hover context on every rendered date. It builds bottom-up because every layer is consumed by the next: the pure classifier (`relativeTime.js`), then the two additive exports on `dateFormat.js`, then the one shared `FormattedDate.jsx`, then the ten Date_Render_Positions adopt it, then the drift guard that keeps them adopted. **Concern A reaches app-wide by design** — every date in the application gains a focusable disclosure, including on pages unrelated to either concern, and a full 50-row audit-log page gains 50 tab stops. Flag it in review (requirements.md Requirement 2's scope note, design.md Decision 5).

Section 8 is the final verification.

Test-only sub-tasks are marked `*` and may be skipped for a faster MVP. **Two test tasks are deliberately NOT marked optional** because a criterion makes the test itself the deliverable rather than a check on one: task 1.4 (Criterion 7.7's red-first contrast test) and task 7.1 (Criterion 2.12's drift guard). Skipping either removes a required behaviour, not a safety net.

The design uses specific languages (React/JavaScript on the client), so no language selection is required. **There is NO migration, no schema change, no wire-format change and no public-config key anywhere in this spec** — every timestamp still travels as ISO-8601 UTC and the zone is still applied only at render. Stated explicitly so nobody goes looking for a `database/migrations/` entry.

**Nothing in this spec touches the server.** The server suite must come out at exactly its baseline; any movement there means something went wrong.

## Tasks

- [x] 1. Build the contrast arithmetic and the failing contrast test
  - Concern B, first half. The single most important thing about this section is the ORDER: task 1.4's test must be RED against the current markup before task 2 lands. A test written alongside the fix cannot demonstrate that it measures the fix (Criterion 7.7).
  - Every ratio in requirements.md and design.md was computed from `client/tailwind.config.js`'s declared palette plus stock Tailwind 3.4.19's `blue`. This section makes that computation a test rather than a footnote.
  - [x] 1.1 Create `client/src/utils/contrast.js` with the WCAG arithmetic and the config-derived Color_Token_Table
    - Export `hexToRgb(hex)`, `relativeLuminance(hex)` (WCAG 2.1 sRGB linearisation) and `contrastRatio(hexA, hexB)` returning `(L_lighter + 0.05) / (L_darker + 0.05)`
    - Build `COLOR_TOKEN_TABLE` ONCE at import time from `resolveConfig(tailwindConfig).theme.colors`, flattened to `family-shade` keys (`gray-800`, `blue-400`)
    - **The import specifier MUST carry the extension: `import resolveConfig from 'tailwindcss/resolveConfig.js'`.** The extensionless form fails Node's ESM resolver with `ERR_MODULE_NOT_FOUND` because the `tailwindcss` package publishes no `exports` map. This reads exactly like a typo, so put the reason in a comment at the import site or someone will "clean it up" and break the module at resolution time rather than at runtime
    - **Use `resolveConfig`, NOT `tailwindConfig.theme.extend.colors` directly, and NOT hardcoded hex.** The config declares `primary` and `gray` only; `blue` is stock Tailwind, so reading `theme.extend.colors` cannot resolve `blue-400` or `blue-600` at all. A hand-written stock table is what Criterion 7.3 forbids and would pass today, because the declared `gray` scale is currently byte-identical to stock Tailwind's — that coincidence is precisely why the indirection is required rather than optional
    - Flatten only the object-valued families. `theme.colors` also holds flat non-hex values (`transparent`, `currentColor`, `inherit`) and the 3-digit `black`/`white`; skip the non-hex entries rather than admitting them to the table, and accept 3-digit hex in `hexToRgb`. A `transparent` reaching `relativeLuminance` would produce a number rather than an error, which is the worst outcome — a silently wrong ratio
    - Export `resolveColorToken(className)`: strip any `dark:` / `hover:` / `dark:hover:` variant prefix, match `^(bg|text|border)-([a-z]+)-(\d{2,3})$`, and look the pair up. A class that is not a colour utility (`rounded-lg`, `p-3`, `h-5`, `transition-transform`) resolves to nothing and is skipped by the caller; a class that LOOKS like a colour utility and has no table entry MUST THROW, so a token renamed to one the table does not know about is reported rather than silently unmeasured (Criterion 7.3, last sentence)
    - This module lives in `src/utils` on purpose rather than being inlined in the test file: a luminance formula transcribed inside a test is a formula nothing tests, and Property 2 needs something to point at. No component imports it, so Vite tree-shakes it out of the bundle
    - _Requirements: 7.1, 7.3_
    - Files: `client/src/utils/contrast.js`
  - [x] 1.2 Write property test for the contrast arithmetic
    - **Property 2: The Contrast_Ratio computation is symmetric, bounded, and monotone**
    - Tag exactly: `// Feature: date-tooltips-and-folder-contrast, Property 2: The Contrast_Ratio computation is symmetric, bounded, and monotone`
    - fast-check 4.9.0 (already a client devDependency), `numRuns >= 100`. Assert `contrastRatio(a, b) === contrastRatio(b, a)`, `>= 1`, `<= 21`, exactly 1 for identical colours, monotonicity for a triple whose middle luminance lies between the other two, and black-to-white equal to 21 within floating-point tolerance
    - Re-derive nothing from the module: generate raw sRGB triples and compare against the formula written independently in the test, never by calling back into `contrastRatio`
    - **Validates: Requirements 7.1, 7.4**
    - _Requirements: 7.1, 7.4_
    - Files: `client/src/utils/contrast.property.test.js`
  - [x] 1.3 Write table-driven unit tests for `resolveColorToken` and the table's provenance
    - Enumerate the whole finite input space in one table: the three utility prefixes (`bg`/`text`/`border`) crossed with the four variant combinations (none, `dark:`, `hover:`, `dark:hover:`), the tokens these two pages actually use, the non-colour classes that must be skipped, and a colour-SHAPED unknown (`bg-gray-1000`, `text-blurple-400`) that must THROW rather than skip
    - Assert the table's provenance rather than its contents alone: `COLOR_TOKEN_TABLE['gray-800']` comes from the project's declared scale and `COLOR_TOKEN_TABLE['blue-400']` comes from stock Tailwind, and BOTH resolve. A test that only checks `gray` would pass an implementation reading `theme.extend.colors` directly, which cannot see `blue` at all
    - **No property test for `resolveColorToken`, deliberately** (design.md, "The token resolver gets no property"). Its input space is small and finite and every case has a single correct answer, so a table a reader can see whole beats a generator rediscovering the same dozen cases a hundred times. Record that decision in a comment in this file so the absence reads as a choice
    - _Requirements: 7.3_
    - Files: `client/src/utils/contrast.test.js`
  - [x] 1.4 Write the computed contrast test and OBSERVE IT RED against the current markup
    - **NOT optional.** Criterion 7.7 makes the red state the deliverable of this task, and a test written after the fix cannot produce it.
    - Render BOTH Channel_Tree_Pages — `Dashboard.jsx` and `GlobalChannels.jsx` (Criterion 7.6) — with the API mocks each needs, driving each to a state that produces a Folder_Row in both the collapsed and the expanded glyph, and for `Dashboard` an Expandable_Channel_Row as well. The Expandable_Channel_Row only renders when a channel's `display_name` matches a folder path, so build the fixture so that branch is actually reached
    - There is NO `@testing-library/react` in this project. Mount with `react-dom/client`'s `createRoot` inside React 18's `act`, the pattern `TransferMemberDialog.test.jsx` established and `DeviceTypeIcon.test.jsx` documents. Add `globalThis.React = React` in the test file — vitest compiles `.jsx` with esbuild's classic transform and the page sources have no `React` import of their own. This has bitten this repo before
    - Read the class lists OFF the produced elements, resolve them through `resolveColorToken`, compute each pair with `contrastRatio`, and assert INEQUALITIES: `>= 3` for a Folder_Icon or Disclosure_Chevron pair, `>= 4.5` for a row-text pair (Criteria 7.2, 7.4). Do NOT feed the test a hand-written token list — a test given its own copy of the tokens passes unchanged after someone edits the JSX, which is the one failure Criterion 7.2 exists to prevent
    - Cover everything Criterion 7.5 enumerates: Folder_Icon and Disclosure_Chevron against the resting AND hover backgrounds in BOTH dark and light mode, the row heading and description against the unified background, and the resting-to-hover background step. Assert the hover step RELATIONALLY — the dark `gray-800`→`gray-700` step (1.42:1) must exceed the light `gray-100`→`gray-200` step (1.13:1) this application already ships and users already read as a hover — rather than against an invented threshold (Criterion 6.4)
    - **TRAP — the hover class is not always on the row.** The Folder_Row carries its own `hover:bg-gray-200 dark:hover:bg-gray-500`, but the Expandable_Channel_Row has NO row-level hover: its TOGGLE BUTTON carries `hover:bg-gray-200 dark:hover:bg-gray-600`, which is the background the chevron inside that button is measured against (5.13:1 after the fix). Read that pair off the button, not off the row
    - **TRAP — `GlobalChannels.jsx`'s Folder_Row has no description text.** It renders a heading `<span className="font-medium text-gray-900 dark:text-gray-100">` and nothing else; the description `<p className="text-sm text-gray-500 dark:text-gray-400">` exists only on `Dashboard.jsx`'s Expandable_Channel_Row. A test that looks for a description on every folder row will trip its own anti-vacuity guard on `GlobalChannels`. Assert per-page what that page actually renders
    - **TRAP — the chevron is a different component on each page.** `Dashboard.jsx` uses a local `ChevronRightSmall`, `GlobalChannels.jsx` uses heroicons' `ChevronRightIcon`. Both render an `<svg>` carrying the class string, so locate the element by its class token, not by component name
    - Add an anti-vacuity guard, mirroring `martiEndpointContract.test.js`: assert the test actually FOUND a folder row, a chevron and a heading on each page before asserting anything about ratios. A test that silently found no rows passes every inequality below while measuring nothing
    - State the limits in the test header rather than leaving them implied by its passing: **jsdom applies no CSS**, and `darkMode: 'class'` means dark styling depends on an ancestor `.dark` rather than a media query, so there is no computed style to read and no `:hover` to trigger. This test proves the token PAIRS the JSX declares meet the thresholds; it does not prove a browser paints them. Criterion 7.8 forbids the reverse trade — trusting a screenshot instead — which is how this defect shipped
    - Run `cd client && npx vitest --run src/pages/channelTreeContrast.test.jsx` and CONFIRM IT FAILS, specifically on the 1.46:1 Folder_Icon pair (`text-blue-600` on `dark:bg-gray-600`). Report the failing ratio before moving on
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 5.1, 5.5, 5.7, 6.4, 6.6_
    - Files: `client/src/pages/channelTreeContrast.test.jsx`
  - [x] 1.5 Checkpoint - the red state is the deliverable
    - Confirm `channelTreeContrast.test.jsx` FAILS on the pre-change markup, and that the reported failure is the Folder_Icon contrast pair rather than a mocking or mounting error — a test failing for the wrong reason satisfies Criterion 7.7 only by accident
    - Run `cd client && npx vitest --run` and confirm every OTHER client test still passes; the baseline is 32 files / 460 tests
    - Ensure all tests pass except the deliberately-red one, ask the user if questions arise

- [x] 2. Apply the Channel_Tree_Row colour changes on both pages
  - Concern B, second half. This section changes COLOUR VALUES ONLY (Criterion 5.8). No component is extracted, no markup is restructured, no behaviour changes — eleven class strings across two files.
  - **The Folder_Row is deliberately NOT extracted into a shared component** (design.md Decision 10), even though that is this codebase's usual answer to duplication. Criterion 5.8 confines this work to colour values, and lifting a row out of two pages means reviewing the click and expansion handlers each page passes it on a change whose entire content is class strings. Criterion 7.6 already supplies the mechanical guard extraction would have bought. If a third channel tree ever appears, revisit it.
  - [x] 2.1 Change the Folder_Row background, icon and chevron in `Dashboard.jsx`
    - Row (~line 322): `bg-gray-100 dark:bg-gray-600 ... hover:bg-gray-200 dark:hover:bg-gray-500` becomes `bg-gray-100 dark:bg-gray-800 ... hover:bg-gray-200 dark:hover:bg-gray-700` (Criteria 5.3, 6.3)
    - BOTH glyphs (~lines 327 and 330, `FolderOpenIcon` and `FolderIcon`): `h-5 w-5 text-blue-600 mr-2` becomes `h-5 w-5 text-blue-600 dark:text-blue-400 mr-2`. **This is load-bearing, not headroom**: `text-blue-600` on `gray-800` is 2.84:1, still BELOW the 3:1 minimum, so the background change alone does not achieve Criterion 5.1. With `dark:text-blue-400` it is 5.77:1 resting and 4.05:1 on the `gray-700` hover (Criteria 5.4, 6.3)
    - The hover MUST change with the resting state, not be left alone: `dark:text-blue-400` on the old `gray-500` hover is **1.90:1**, which would make the hover the worst-contrast state in the row — worse than the 1.46:1 resting failure this spec exists to fix (Criterion 6.2)
    - Chevron (~line 334): `h-4 w-4 text-gray-500` becomes `h-4 w-4 text-gray-500 dark:text-gray-300` — 9.96:1 resting, 7.00:1 on the `gray-700` hover (Criterion 5.7). Leave `transition-transform` and the `rotate-90` interpolation exactly as they are
    - Leave the icon's `h-5 w-5 mr-2`, the glyph swap, and the chevron's rotation untouched: the expanded/collapsed state stays carried by the glyph and the rotation, and colour is NOT introduced as a state signal (Criteria 5.6, 5.8)
    - Do NOT touch the plain (non-folder, non-expandable) channel leaf rows at ~line 352, which keep `bg-gray-50 dark:bg-gray-700`. Their `dark:text-gray-400` description measures 4.06:1, which is a real adjacent failure and is deliberately OUT of scope — leaf rows are not Channel_Tree_Rows under the glossary and Requirement 6 does not reach them (design.md's "One adjacent failure is measured and deliberately not fixed")
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.2, 6.3_
    - Files: `client/src/pages/Dashboard.jsx`
  - [x] 2.2 Apply the identical Folder_Row changes in `GlobalChannels.jsx`
    - The same four edits, at ~line 206 (row), ~lines 211 and 214 (`FolderOpenIcon` / `FolderIcon`) and ~line 218 (`ChevronRightIcon`). The markup is duplicated verbatim between the two pages, so the class strings must come out byte-identical
    - **Both pages change together or neither does** (Criterion 5.2): fixing one leaves a measured conformance failure live on the other and the two pages visibly divergent. Task 1.4's test measures both, so a half-applied change fails rather than passing
    - There is no Expandable_Channel_Row and no row description on this page — the folder row renders a heading `<span>` only. Nothing from task 2.3 applies here
    - Do NOT touch the `RadioIcon`/`GlobeAltIcon` section headers (~lines 366, 405), which also use `text-blue-600`/`text-green-600`: they sit on the page background, not on a Channel_Tree_Row, and are outside Requirement 5
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 5.8, 6.3_
    - Files: `client/src/pages/GlobalChannels.jsx`
  - [x] 2.3 Unify the Expandable_Channel_Row background and darken its description in `Dashboard.jsx`
    - Row (~line 262): `bg-gray-50 dark:bg-gray-700` becomes `bg-gray-100 dark:bg-gray-800`, the same pair the Folder_Row now carries, so the two Channel_Tree_Rows cannot diverge (Criterion 6.1)
    - Toggle-button chevron (~line 268): add `dark:text-gray-300`. It is a Disclosure_Chevron in a Channel_Tree_Row, so Criterion 5.7 reaches it; today's `text-gray-500` is 2.13:1 on `gray-700`. After the change it is 9.96:1 resting and 5.13:1 against the button's own `dark:hover:bg-gray-600`
    - Description `<p>` (~line 272): `text-sm text-gray-500 dark:text-gray-400` becomes `text-sm text-gray-600 dark:text-gray-400`. **This is REQUIRED, not cosmetic, and it is a token the requirements do not mention** (design.md correction 2 and Decision 14). Criterion 6.1's unification moves this text from `bg-gray-50` (4.63:1, a pass) to `bg-gray-100` (**4.39:1, a fail** against the 4.5:1 Criterion 7.4 asserts). Without this change task 1.4's test goes RED in light mode after the fix lands. `text-gray-600` on `gray-100` measures 6.87:1, and the dark-mode 5.78:1 Criterion 6.6 cites is left exactly as it is
    - **TRAP — there are TWO identical `<p className="text-sm text-gray-500 dark:text-gray-400">` strings in this file.** The one at ~line 272 is the Expandable_Channel_Row and is in scope; the one at ~line 355 is the channel LEAF row, whose background is unchanged and which is out of scope. A find-and-replace hits both. Change the first only, and verify by the surrounding element rather than by the class string
    - Leave the row's `ml-6` indentation, its `justify-between` layout, its `flex-1` wrappers, its fixed light-palette permission badges (`bg-blue-100 text-blue-800`, `bg-purple-100 text-purple-800`) and the toggle button's own hover untouched (Criteria 6.5, 6.7). The indentation encodes tree depth; removing it in the name of unification would flatten the hierarchy the tree exists to show
    - The incidental win worth knowing about: darkening this row's background repairs its `dark:text-gray-400` description from 4.06:1 to 5.78:1 as a side effect
    - _Requirements: 6.1, 6.5, 6.6, 6.7, 5.7_
    - Files: `client/src/pages/Dashboard.jsx`
  - [x] 2.4 Checkpoint - Concern B is complete and measured
    - Run `cd client && npx vitest --run` and confirm `channelTreeContrast.test.jsx` is now GREEN, including its light-mode pairs — "we only changed dark mode" is a checked claim under Criterion 5.5, not an assumption
    - Confirm no OTHER client test broke: any existing assertion that pinned `dark:bg-gray-600` or `text-blue-600` on a channel-tree row must be updated to the new token rather than the code being changed back
    - Run `npm run lint` from the repo ROOT and confirm the problem count stays at or below **107 problems (95 errors, 12 warnings)**
    - Concern B can ship at this point independently of Concern A. There is no migration and nothing to apply or roll back
    - Ensure all tests pass, ask the user if questions arise

- [x] 3. Create the pure Relative_Time classifier
  - Concern A, layer one. This module is where the decidable logic lives, following the `client/src/utils/expiryWarning.js` convention of extracting it out of the component that renders it.
  - [x] 3.1 Create `client/src/utils/relativeTime.js` with the six-rung ladder
    - Export `NO_PHRASE = null` as the distinct "nothing to say about this value" result, and `relativeTime(value, now)` returning an English phrase or `NO_PHRASE`
    - **`now` is a REQUIRED parameter with NO default.** `classifyExpiry` in the sibling module defaults to `Date.now()` and copying that would have been the consistent choice; Criterion 1.1 forbids it, and the reason is worth recording at the call site: a defaulted clock read silently works for a caller who forgot to pass the disclosure-time clock, and "silently working while wrong by the age of the render" is exactly the failure Criterion 2.5 exists to prevent. With no default, an omitted `now` is `undefined`, `undefined` is unusable, and an unusable `now` already means `NO_PHRASE` — so totality makes the mistake visible as a missing tooltip rather than as a wrong phrase (design.md Decision 2)
    - Copy `expiryWarning.js`'s `toEpochMs` DISCIPLINE, not its code: accept exactly three shapes — a finite `number`, a `Date` whose time is not `NaN`, a non-blank `string` that `new Date(...)` parses — and reject everything else **BY TYPE, never by wrapping a coercion in try/catch**. The reason is recorded in that file and applies unchanged here: `new Date(Symbol())` throws on string conversion, `new Date(1n)` throws on number conversion, and an object with a hostile `valueOf` can throw anything. A classifier that runs once per table cell across ten surfaces must be structurally unable to throw
    - Hold the ladder as a module-private frozen array of `{ limitMs, unitMs, singular, plural }`, evaluated top to bottom against `|value - now|`, with the Nominal_Month (30 days) and Nominal_Year (365 days) constants beside it. Rungs and boundaries exactly as Criterion 1.3 and design.md's Data Models table give them
    - **Do NOT export the ladder.** Its boundaries are the thing Property 1 exists to check, and a test importing them would agree with a ladder someone edited to 31-day months. The property test hard-codes the six Criterion 1.3 boundaries instead — the same re-derivation rule `expiryWarning.property.test.js` records
    - Floor every magnitude. Because every rung from the second down has a lower bound of exactly one of its own units, a floored magnitude of 0 is unreachable and `0 minutes ago` cannot be emitted; the sub-minute rung renders `just now` with no direction and no magnitude (Criteria 1.4, 1.6). Singularise at exactly 1, pluralise at 2 or more, in every unit and both directions (Criterion 1.7)
    - Direction comes from the sign of `value - now` ALONE: strictly earlier renders `... ago`, strictly later renders `in ...`, equal falls in the directionless first rung (Criterion 1.2)
    - Assemble every phrase from English string literals in this file. **Do NOT use `Intl.RelativeTimeFormat`** (Criterion 1.10): a locale-dependent phrase would vary with the browser while the date beside it does not, and it would not produce this ladder anyway — its unit selection and pluralisation are locale-driven and its `numeric: 'auto'` mode emits `yesterday`/`last month`, a second vocabulary Criterion 4.4 explicitly declined
    - Record the 365/30 = 12.17 artifact in a comment: the month rung's top magnitude is **12**, not 11, so `12 months ago` is reachable immediately below the year boundary. It looks like an off-by-one to anyone who has not read Criterion 1.5
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10_
    - Files: `client/src/utils/relativeTime.js`
  - [x] 3.2 Write property test for the Relative_Time classification
    - **Property 1: The Relative_Time classification is total, boundary-exact, correctly signed, and correctly singularised**
    - Tag exactly: `// Feature: date-tooltips-and-folder-contrast, Property 1: The Relative_Time classification is total, boundary-exact, correctly signed, and correctly singularised`
    - fast-check, `numRuns >= 100`. The totality arm MUST include `null`, `undefined`, `NaN`, `Infinity`, symbols, bigints, objects with a hostile `valueOf`, unparseable strings, blank strings, finite numbers, `Date` objects and ISO strings, crossed with unusable `now` values — the classifier returns a non-empty phrase or `NO_PHRASE` and never throws
    - **Boundary concentration is mandatory** (Criterion 1.12): draw distances from `fc.oneof` over each of the six Criterion 1.3 boundaries offset by −1, 0 and +1 ms, in both directions, PLUS a broad uniform arm spanning decades. A uniform offset over decades lands on a boundary with vanishing probability, and the boundaries are precisely where an implementation that wrote `<` for `<=` is wrong — a uniform-only generator would report that bug as a clean pass
    - **Independent re-derivation is mandatory**: compute expected phrases from the generated distance and the six HARD-CODED boundaries. Never import the module's ladder and never call back into `relativeTime` — a test that computes its expectation with the function it is checking asserts only determinism
    - Assert the sign rule and the singular/plural pivot in every unit and both directions
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 1.8, 1.9, 1.11, 1.12**
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 1.8, 1.9, 1.11, 1.12_
    - Files: `client/src/utils/relativeTime.property.test.js`
  - [x] 3.3 Write unit tests for the classifier's named cases
    - `just now` at distance 0 and at 59 999 ms; the singular/plural pivot in all five magnitude-bearing units; `12 months ago` reachable immediately below the year boundary (the 365/30 artifact of Criterion 1.5)
    - `NO_PHRASE` is a DISTINCT value, not `''` — assert identity, so a caller can tell "nothing to say" from "the phrase happened to be empty" and Criterion 2.7's suppression is driven by a value rather than a string test (Criterion 1.9)
    - `relativeTime(value)` with `now` omitted returns `NO_PHRASE` rather than reading the clock (Criterion 1.1)
    - A one-line structural assertion that the module source contains no `Intl.RelativeTimeFormat` reference (Criterion 1.10)
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.7, 1.9, 1.10_
    - Files: `client/src/utils/relativeTime.test.js`
  - [x] 3.4 Checkpoint - the classifier stands alone
    - Run `cd client && npx vitest --run src/utils/relativeTime` and confirm both new files pass
    - Nothing imports this module yet, so the rest of the suite must be untouched. Run the full client suite and confirm it
    - Ensure all tests pass, ask the user if questions arise

- [x] 4. Add the Midnight_Anchor and the renderability predicate to `dateFormat.js`
  - Concern A, layer two. Both additions are ADDITIVE: the two Date_Format_Helpers keep their signatures, their `fallback` argument and their behaviour untouched (Criterion 2.13).
  - [x] 4.1 Add `zonedDayNumber` and `hasRenderableDate` to `client/src/utils/dateFormat.js`
    - `zonedDayNumber(value)` returns the calendar day `value` falls on in the Resolved_Display_Timezone as whole days since 1970-01-01, or `null` when there is no such day
    - **It goes IN this module, not beside it.** The zoned reading it needs — the memoised `Intl.DateTimeFormat` and `readWallClock(date)` — is already here and is module-PRIVATE. Exporting those so a sibling module could reach them would widen this module's surface to avoid adding one function to it (design.md Decision 1)
    - Read `readWallClock(date)`'s zoned `{year, month, day}` and map the calendar triple to an ordinal with `Date.UTC(y, m - 1, d) / 86_400_000`. **Construct NO zoned midnight instant.** The alternative — a real 00:00-in-zone instant — means either offset arithmetic against a DST table or an iterative search for the instant whose zoned components read `00:00`, both wrong in a way that shows up twice a year in one hemisphere. A calendar-to-integer map has no zone and no DST in it at all: the zone is applied once, when the triple is read, by machinery that is already memoised and already tested
    - **TRAP — `Date.UTC` maps years 0-99 to 1900-1999.** A year in that range MUST be built through `setUTCFullYear` instead. Certificates and audit rows never reach it; totality does, and Property 3 will find it
    - If the zoned components do not read back as plain integers — where a BCE instant and an era-bearing formatter would land — return `null`. `null` becomes No_Phrase and therefore no tooltip; guessing would be worse than saying nothing
    - `hasRenderableDate(value)` returns whether the Date_Format_Helpers would render this value rather than a fallback. It is exported so a caller can make a LAYOUT decision without importing a renderer — `DeviceListRow`'s connected branch needs exactly that (design.md Decision 7), and it is why the task-7.1 drift guard is written against the two helpers by name rather than against the module
    - Do NOT read, wrap, modify or re-signature `formatDate`/`formatDateTime`, `setDisplayTimezone`, `getDisplayTimezone` or `DEFAULT_DISPLAY_TIMEZONE` (Criterion 2.13)
    - _Requirements: 4.1, 4.2, 4.3, 4.6, 2.13_
    - Files: `client/src/utils/dateFormat.js`
  - [x] 4.2 Write property test for the Midnight_Anchor
    - **Property 3: The Midnight_Anchor is a whole number of days, taken in the display timezone and independent of time of day**
    - Tag exactly: `// Feature: date-tooltips-and-folder-contrast, Property 3: The Midnight_Anchor is a whole number of days, taken in the display timezone and independent of time of day`
    - fast-check, `numRuns >= 100`. Cross a wide instant range with a fixed awkward zone set — `Pacific/Auckland`, `Pacific/Chatham` (+12:45), `Asia/Kolkata` (+05:30), `America/Los_Angeles`, `UTC` — installed via `setDisplayTimezone`
    - Assert: an integer or `null`; the SAME integer for any two instants sharing a calendar day in the installed zone regardless of time of day; integers differing by exactly 1 for adjacent calendar days; and agreement with an INDEPENDENTLY constructed `Intl.DateTimeFormat` for that zone rather than with the browser's local calendar day. Concentrate generation on instants within an hour of midnight in the installed zone — that is exactly where the zoned and local readings disagree about the DAY, the shape of the defect device-management Requirement 18 fixed
    - Model comparison only: never reimplement the ordinal arithmetic in the test and never call back into `zonedDayNumber`
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.6**
    - _Requirements: 4.1, 4.2, 4.3, 4.6_
    - Files: `client/src/utils/dateFormat.zonedDay.property.test.js`
  - [x] 4.3 Extend the existing `dateFormat` unit tests
    - `zonedDayNumber` for an in-zone time of day just after 00:00 and just before 24:00 on the same day — both must yield the same integer
    - A value whose LOCAL and Resolved_Display_Timezone calendar days differ must follow the display zone, so Criterion 4.6 cannot regress to a local anchor undetected (Criterion 4.8)
    - A year in the 0-99 range does not land in 1900-1999
    - `hasRenderableDate` against the same value set the helpers are already tested with, and the existing helper assertions must remain untouched and passing (Criterion 2.13)
    - _Requirements: 4.1, 4.2, 4.6, 4.8, 2.13_
    - Files: `client/src/utils/dateFormat.test.js` (extend)
  - [x] 4.4 Checkpoint - the anchor and the predicate are in place
    - Run `cd client && npx vitest --run src/utils/dateFormat` and confirm the extended and new files pass
    - Confirm NO existing `formatDate`/`formatDateTime` assertion changed anywhere in the suite — this task added exports and nothing else. Run the full client suite
    - Ensure all tests pass, ask the user if questions arise

- [x] 5. Build the one shared `FormattedDate` component
  - Concern A, layer three. This is the ONE place the Date_Tooltip is implemented (Criterion 2.1). The application acquires a third tooltip, not a second tooltip LOOK.
  - [x] 5.1 Create `client/src/components/FormattedDate.jsx`
    - Export `DATE_PRECISION` (`{ DATE: 'date', DATE_TIME: 'datetime' }`, frozen), `TOOLTIP_SIDES` (`{ RIGHT: 'right', LEFT: 'left' }`, frozen), `TOOLTIP_SEPARATOR = ', '`, the pure `buildTooltipText(phrase, zone)`, and the default component taking `{ value, fallback = '', precision, side = TOOLTIP_SIDES.RIGHT, className = '' }`
    - Three outcomes, and the distinction between the second and third IS Criterion 2.7: (1) `hasRenderableDate(value)` false → render `fallback` as text with NO host, NO `tabIndex`, NO `aria-describedby`, NO tooltip; (2) renderable but the phrase is `NO_PHRASE` → render the formatted string with no host and no tooltip; (3) renderable with a phrase → the disclosure
    - The string comes from `formatDate`/`formatDateTime` at RENDER time, because a `yyyy-mm-dd HH:MM` rendering of a fixed instant is the same string forever. The phrase comes from `relativeTime` inside the handler that OPENS the tooltip, because it CAN go stale. Every entry transition — `pointerenter` and `focus` alike — recomputes it, so the clock is read at disclosure and only at disclosure (Criterion 2.5)
    - **NO timer, NO interval, NO subscription, anywhere** (Criterion 2.6). A tooltip held open for ten minutes does go stale for those ten minutes; that is what Criterion 2.5's "recompute on each subsequent disclosure" accepts, and the alternative is the ticking timer Criterion 2.6 forbids. It also means unmount-while-disclosed needs no cleanup, because there is nothing to clean up
    - State machine: two booleans and a string — `hovered`, `focused`, and the text whichever handler opened it computed. `disclosed` is `hovered || focused`, so moving the pointer away from a FOCUSED date does not dismiss a tooltip the keyboard is still asking for
    - **TRAP — mount the tooltip ONLY while disclosed. Do NOT keep it mounted and toggle opacity.** That is exactly what the two existing tooltips do and is the obvious thing to copy, and it breaks two things (design.md Decision 4). `Dashboard.test.jsx` and `UserDevicesModal.test.jsx` assert device-cell text with `toBe` through an `accessibleTextOf` helper that strips ONLY `[aria-hidden="true"]` subtrees — and this tooltip must NOT be `aria-hidden`, because Criterion 3.2 requires it announced. An always-mounted tooltip therefore breaks those exact-text assertions AND lets a screen reader reach a phrase computed at render time. Mounting on disclosure makes the resting DOM identical to today's character for character, which is the strongest reading of Criterion 2.3, and makes a stale phrase structurally impossible. The 200 ms fade-in is a real loss and is accepted; keep the `transition-opacity duration-200` classes anyway so the SHOWN state is indistinguishable from the other two tooltips
    - **The focusable node is the DATE TEXT, not the outer wrapper.** A focusable `<span>` takes its accessible name from its contents, so a wrapper enclosing both the date and the tooltip would name itself with both and then describe itself with one of them again — the double announcement `DeviceTypeIcon` and `DeviceListRow` each avoid by a different trick. Keeping the tooltip a SIBLING of the described element means the name is the date and the description is the context, once each
    - **NO `role` on either node** (Criterion 3.10): a focusable span with no role announces as text carrying a description, which is what it is, and `role="tooltip"` adds nothing `aria-describedby` has not already established. Take the id from React 18's `useId()` so two dates in one row cannot collide. Drop the `group` class — nothing consumes it any more and leaving it would imply a CSS-driven disclosure this component does not have
    - Match the existing visual treatment byte for byte (Criterion 3.6): `absolute left-full top-1/2 transform -translate-y-1/2 ml-2 px-3 py-2 bg-gray-900 text-white text-xs rounded-lg transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10`, with the `right-full`/`mr-2` mirror for the left side, and the caret as `absolute right-full top-1/2 transform -translate-y-1/2 border-4 border-transparent border-r-gray-900` (mirrored to `left-full`/`border-l-` on the other side), `aria-hidden`. Cite `DeviceTypeIcon.jsx`'s Tooltip_Clipping_Defect comment rather than repeating it — that comment is why Criterion 3.4 exists
    - **Retain `pointer-events-none`**, and not only for visual parity: folder rows are `cursor-pointer` with an `onClick` and six of the ten positions sit in table rows, so a tooltip accepting pointer events would swallow a click on the row underneath, and with `pointerleave`-driven state it would also flicker (pointer enters tooltip → leaves host → tooltip unmounts → pointer returns to host). The cost is a WCAG 2.1 SC 1.4.13 "hoverable" shortfall that this codebase already ships on both existing tooltips; Criterion 3.6 requires matching them, and fixing it properly means changing all three together. Recorded so it is not discovered as news
    - Add `onKeyDown` so **Escape dismisses** the tooltip. This is an ADDITION BEYOND THE REQUIREMENTS, flagged for review (design.md Decision 9): one handler, no pixels, and it brings the disclosure closer to SC 1.4.13's dismissable clause than the tooltips it copies
    - `buildTooltipText`: the phrase, then `TOOLTIP_SEPARATOR`, then the zone (Criteria 2.8, 2.10). WHERE `getDisplayTimezone()` returns the empty string — its documented outcome when not even `UTC` constructs — render the **phrase ALONE**, with no separator and no empty second fact. A tooltip reading `3 minutes ago, ` would be a rendering defect standing in for a missing one. Take the zone from `getDisplayTimezone()`, never the configured value (Criterion 2.9), and put NO ISO instant in the tooltip (Criterion 2.11). A comma is the separator because a middot is announced inconsistently and prose would read as a third fact (design.md Decision 8)
    - **`precision` is REQUIRED with no default**, and an absent or unrecognised value is treated as `DATE_TIME` deliberately: that is the strictly more informative rendering, so a caller who meant date-only gets a stray ` HH:MM` on screen and finds out, where the opposite default would silently drop a time nobody noticed was gone. One component with an explicit discriminator, not two components — two would double the place the disclosure, the ARIA wiring and the placement live (design.md Decision 6)
    - `DATE_PRECISION.DATE` anchors BOTH ends through `zonedDayNumber` and feeds the classifier the two day numbers scaled to milliseconds; `DATE_TIME` uses the value's own instant and an unanchored `now` (Criteria 4.1, 4.2, 4.5). Criterion 4.4 then falls out with nothing written for it: same day means distance zero, distance zero is the first rung, the first rung is `just now`
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.9, 3.10, 4.1, 4.2, 4.4, 4.5_
    - Files: `client/src/components/FormattedDate.jsx`
  - [x] 5.2 Write unit tests for the disclosure, the ARIA wiring and the placement
    - Mount with `createRoot` + `act`; add `globalThis.React = React`; dispatch events natively — `jsdom` 29.1.1 provides `PointerEvent`, so `pointerover`/`pointerout` with `bubbles: true` drive React's `onPointerEnter`/`onPointerLeave`, and `focus()`/`blur()` drive `onFocus`/`onBlur` through focusin/focusout
    - Disclosure on `pointerover` and on `focus()`; dismissal on `pointerout`, `blur()` and Escape; and a pointer LEAVING a focused date does NOT dismiss it
    - The tooltip is absent from the DOM until disclosed and `aria-describedby` is absent with it (Criterion 3.7); while disclosed the attribute resolves to a PRESENT element (Criterion 3.2)
    - Both sides' placement classes asserted by NAME, so the Tooltip_Clipping_Defect cannot return quietly: `left-full`/`ml-2` and `right-full`/`mr-2`, with `top-1/2 -translate-y-1/2`, and no `top-full`/`bottom-full` anywhere (Criteria 3.4, 3.5, 3.11). `pointer-events-none` present
    - No `role` on the date node; no `title` standing in for the description (Criteria 3.3, 3.10)
    - The two facts in order with the explicit separator, and the phrase ALONE when the resolved zone is `''` (Criteria 2.8, 2.10); no ISO instant in the tooltip text (Criterion 2.11)
    - **Recomputation across two disclosures separated by an advanced fake clock** — this is the assertion Criterion 2.5 turns on, and the one an always-mounted CSS-driven tooltip would fail
    - An unrecognised `precision` falls back to `datetime` (design.md's rationale for the required prop)
    - _Requirements: 2.5, 2.8, 2.10, 2.11, 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.10, 3.11_
    - Files: `client/src/components/FormattedDate.test.jsx`
  - [x] 5.3 Write property test for the rendered string and the suppressed disclosure
    - **Property 4: A Formatted_Date renders exactly the string the helper renders, and discloses nothing when there is nothing to say**
    - Tag exactly: `// Feature: date-tooltips-and-folder-contrast, Property 4: A Formatted_Date renders exactly the string the helper renders, and discloses nothing when there is nothing to say`
    - fast-check, `numRuns >= 100`. Cross arbitrary values with the five fallback strings Criterion 2.4 enumerates plus the empty string, and both precisions. Assert the text rendered OUTSIDE the tooltip equals the corresponding `formatDate`/`formatDateTime` return value character for character, and that a value yielding no phrase produces no disclosure host, no `tabIndex`, no `aria-describedby` and no tooltip element
    - The model here IS the Date_Format_Helpers, which is legitimate precisely because Criterion 2.3 DEFINES this component's correctness as agreement with them. That is the one place in this spec where calling the real dependency is the right model rather than a circular one
    - **Validates: Requirements 2.3, 2.4, 2.7**
    - _Requirements: 2.3, 2.4, 2.7_
    - Files: `client/src/components/FormattedDate.property.test.jsx`
  - [x] 5.4 Checkpoint - the component works before anything adopts it
    - Run `cd client && npx vitest --run src/components/FormattedDate` and confirm both files pass
    - Nothing imports the component yet, so the rest of the suite must be untouched. Run the full client suite and confirm 32 files / 460 tests still pass alongside the new ones
    - Ensure all tests pass, ask the user if questions arise

- [x] 6. Adopt `FormattedDate` at all ten Date_Render_Positions
  - Eleven call sites behind ten positions, in six files. **Every one of these tasks must leave the rendered date text unchanged character for character** (Criterion 2.3) — what changes is that a disclosure appears around it.
  - `side` follows Criterion 3.5 mechanically: a position in the trailing half of a horizontally scrolling table opens LEFTWARD from `right-full`; everything else opens rightward. The default is rightward because the failure modes are not symmetric — a tooltip past a scroll container's right edge is clipped but reachable by scrolling, while one past the left edge is clipped AND unreachable, which is the defect `DeviceListRow.jsx` already records.
  - Six of the ten positions are table cells inside `overflow-x-auto` wrappers; the other four are `<p>` elements inside cards (Requests' two "Submitted" values and Admin's two). **requirements.md Criterion 3.4 says eight table cells and names only Admin's as non-table — that count is wrong** (design.md correction 1). It changes nothing about the placement design, because Criterion 3.8 already requires one tooltip behaviour regardless of surrounding element; it changes only which files a reviewer expects to find the `<p>`-hosted tooltips in.
  - [x] 6.1 Adopt in `DeviceListRow.jsx` (four call sites, three positions)
    - Issued (`formatDate`, fallback `'Unknown'`, `precision=date`, `side=right`) and Expires (same, beside the expiry markers)
    - Last Seen is ONE position reached from TWO branches (Criterion 2.4): the connected branch beside the Connected_Label, and the not-connected branch with fallback `'never seen'`. Both `formatDateTime`, `precision=datetime`, `side=left` — this is a trailing column
    - The cell composes a label and a value, so `FormattedDate` renders an inline `<span>` INSIDE the existing `<td>` and never owns a cell
    - Replace the `const knownLastSeen = formatDateTime(device.lastSeenAt, '')` predicate with `hasRenderableDate(device.lastSeenAt)`. The connected branch needs to know whether there is a timestamp BEFORE it decides whether to render the `ml-2` wrapper and the deliberate in-string leading space beside the Connected_Label — a decision this component cannot delegate, since `FormattedDate` does not own the cell. Two alternatives were rejected: keeping `formatDateTime(..., '')` purely as a predicate, which leaves a helper import alive in a module the drift guard is meant to clear; and giving `FormattedDate` extra props to own the wrapper and the space, which risks the trailing-whitespace change that would break the existing exact-text assertions (design.md Decision 7)
    - Retain the Imminent_Expiry and Expired_Certificate_State text markers on the Expires cell unchanged (Criterion 4.7). The overlap with a `in 12 days` phrase is ACCEPTED: the markers are visible without a hover and are what carry the state to a screen reader, and suppressing the tooltip on one cell would make it the one place in the application where hovering a date does nothing
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.5, 4.5, 4.7_
    - Files: `client/src/components/DeviceListRow.jsx`
  - [x] 6.2 Adopt in `AuditLogs.jsx` (Created At)
    - `formatDateTime(row.created_at, row.created_at)` → `FormattedDate` with `precision=datetime`, `side=left` (last cell), and `fallback={row.created_at}` — the RAW value, exactly as passed today
    - Render that fallback exactly as passed. If the API ever sends a non-renderable child there it fails exactly as it fails today; this spec neither introduces nor repairs that
    - This page paginates at 50 rows, so it gains **50 tab stops**. That price is argued and accepted in design.md Decision 5 — do not try to avoid it here with a `title` (Criterion 3.3 forbids it and it is never disclosed on focus) or by exposing only some rows
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.5_
    - Files: `client/src/pages/AuditLogs.jsx`
  - [x] 6.3 Adopt in `Users.jsx` (Last login), keeping its ternary
    - `{user.last_login ? formatDate(user.last_login) : 'Never'}` becomes `{user.last_login ? <FormattedDate value={user.last_login} fallback='' precision={DATE_PRECISION.DATE} side={TOOLTIP_SIDES.LEFT} /> : 'Never'}`
    - **KEEP the ternary. Do NOT fold `'Never'` into `fallback`** (design.md Decision 13). Folding it reads better and CHANGES WHAT THE PAGE RENDERS: measured against the current code, a `last_login` that is present but unparseable renders the **empty string** today, because the ternary takes the truthy branch and the helper's own default fallback is `''`. `fallback="Never"` would render `Never` for that value instead. That is arguably the better product decision, which is exactly why it does not belong in a spec whose Criterion 2.3 promises the same string character for character. If anyone wants it, it is a one-line change with its own justification rather than a side effect of this one
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.5_
    - Files: `client/src/pages/Users.jsx`
  - [x] 6.4 Adopt in `Requests.jsx` (both "Submitted" values)
    - Both are `formatDate(request.created_at)` inside `<p>` elements in cards — the team_change card and the new_account card. `precision=date`, `fallback=''` (the helper's own default), `side=right`
    - These are two of the FOUR non-table positions, not two of two. They get the same Sideways_Tooltip_Placement as every other position, so the application has ONE tooltip behaviour rather than one per surrounding element type (Criterion 3.8)
    - _Requirements: 2.1, 2.2, 2.3, 3.8_
    - Files: `client/src/pages/Requests.jsx`
  - [x] 6.5 Adopt in `Admin.jsx` (last sync and template last updated)
    - Both `formatDateTime` inside `<p className="text-xs ...">`: `precision=datetime`, `fallback=''`, `side=right`
    - The template one renders as `Last updated: {formatDateTime(templateUpdatedAt)}` — the literal label stays outside the component, so only the value acquires the disclosure and the rendered string is unchanged
    - Same Sideways_Tooltip_Placement as the table positions (Criterion 3.8)
    - _Requirements: 2.1, 2.2, 2.3, 3.8_
    - Files: `client/src/pages/Admin.jsx`
  - [x] 6.6 Adopt in `OrgInterestRequests.jsx`, keeping its ternary, AND repair its partial mock
    - `{req.created_at ? formatDateTime(req.created_at) : '-'}` becomes the same shape as task 6.3: the ternary stays, the component receives `fallback=''`, `precision=datetime`, `side=left` (second-to-last cell). Same reasoning as 6.3 — a present-but-unparseable `created_at` renders the empty string today and must keep doing so
    - **TRAP — this adoption BREAKS `OrgInterestRequests.test.jsx` unless the mock is fixed in the same task.** That file is the ONLY client test that partially mocks the date module: `vi.mock('../utils/dateFormat', () => ({ formatDateTime: vi.fn(() => '2024-01-01 12:00') }))`, supplying `formatDateTime` alone. Once this component renders through `FormattedDate`, that factory leaves `getDisplayTimezone`, `zonedDayNumber` and `hasRenderableDate` UNDEFINED and the render THROWS. Either extend the factory with all the exports `FormattedDate` reaches, or — preferred — drop the mock in favour of the real module and install a fixed zone with `setDisplayTimezone`, which is what every other client test does. Verified: no other client test file mocks this module
    - The mock repair is in THIS task rather than in the optional test task 6.7 on purpose: skipping it leaves the suite red, so it is not a test refinement but part of the adoption
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.5_
    - Files: `client/src/components/OrgInterestRequests.jsx`, `client/src/components/OrgInterestRequests.test.jsx`
  - [x] 6.7 Write adoption tests across the six surfaces
    - One per Date_Render_Position surface: assert the rendered date TEXT is unchanged (reuse each file's existing exact-text assertion where there is one) and that a disclosure host now exists with the expected `side` classes
    - `Dashboard.test.jsx` and `UserDevicesModal.test.jsx` compare device-cell text with `toBe` through `accessibleTextOf`, which strips only `[aria-hidden="true"]` subtrees. Those assertions must pass UNCHANGED — that is the measured evidence behind design.md Decision 4, and if they need loosening then the tooltip is mounted when it should not be
    - Assert the two ternary-guarded sites still render `'Never'` and `'-'` for an absent value, and the empty string for a present-but-unparseable one, so Decision 13 is pinned rather than described
    - Assert the four non-table positions carry the same placement classes as the table ones (Criterion 3.8)
    - _Requirements: 2.3, 2.4, 3.5, 3.8, 3.11_
    - Files: `client/src/pages/Dashboard.test.jsx` (extend), `client/src/components/UserDevicesModal.test.jsx` (extend), `client/src/pages/AuditLogs.test.jsx` (extend), `client/src/pages/Requests.test.jsx` (extend), `client/src/components/OrgInterestRequests.test.jsx` (extend)
  - [x] 6.8 Checkpoint - every date renders through the one component
    - Run `cd client && npx vitest --run` and confirm the whole suite passes, `OrgInterestRequests.test.jsx` included
    - Confirm by inspection that no non-test module other than `FormattedDate.jsx` still renders a `formatDate`/`formatDateTime` return value into the document. Task 7.1 makes this mechanical; confirm it by hand first so the guard is written against a state that is already true
    - Run `npm run lint` from the repo root and confirm the count stays at or below 107 problems
    - Ensure all tests pass, ask the user if questions arise

- [x] 7. Add the drift guard that keeps the adoption in place
  - [x] 7.1 Write `client/src/utils/dateFormatConsumers.test.js`
    - **NOT optional.** Criterion 2.12 makes the guard itself the deliverable — the mechanical equivalent of device-management Criterion 16.6's one-shared-row-component rule — so skipping it removes a required behaviour rather than a check on one.
    - Walk `client/src` with `fs`, skipping `*.test.js` / `*.test.jsx` / `*.property.test.js*`: Criterion 2.12 scopes the rule to NON-TEST modules, and tests legitimately import the helpers to compute expected strings (`Dashboard.test.jsx`, `UserDevicesModal.test.jsx` and `Requests.test.jsx` all do)
    - For every remaining file, extract import declarations whose specifier resolves to `utils/dateFormat`. A file naming `formatDate` or `formatDateTime` among its specifiers must appear in an allow-list whose ONLY entry is `src/components/FormattedDate.jsx`
    - **TRAP — guard the two HELPERS BY NAME, not the module path.** Verified: seven non-test modules import `utils/dateFormat` today, but only six import the two helpers — `App.jsx` imports it solely for `setDisplayTimezone`. A guard written against the module path flags `App.jsx` as a violation forever, and after this change `DeviceListRow.jsx` legitimately imports `hasRenderableDate` too. Neither renders a helper's return value into the document and neither is a violation. This is exactly how the glossary defines Date_Format_Helpers, and it is the reason task 4.1 exported `hasRenderableDate` as a separate predicate
    - **Also catch a NAMESPACE import** (`import * as dateFormat from '../utils/dateFormat'`), which would reach the helpers by another route and slip a named-specifier check
    - Fail with the offending paths and the two acceptable resolutions spelled out: route the date through `FormattedDate`, or amend the allow-list deliberately
    - Add an anti-vacuity check: the scan must FIND the allow-listed file importing the helpers. A broken walker would otherwise pass while proving nothing — the same guard `martiEndpointContract.test.js` carries
    - Record the before/after count in a comment: six non-test modules imported the helpers before this spec, one does after
    - _Requirements: 2.12_
    - Files: `client/src/utils/dateFormatConsumers.test.js`
  - [x] 7.2 Checkpoint - the guard passes and bites
    - Run the guard and confirm it passes. Then confirm it BITES: temporarily add a `formatDate` import to any other non-test module, observe the failure names that file, and revert. A guard that cannot fail is not a guard
    - Run the full client suite and the root lint
    - Ensure all tests pass, ask the user if questions arise

- [x] 8. Final verification
  - Run `cd client && npx vitest --run` and confirm the whole client suite passes. The baseline this spec started from is **32 files / 460 tests**; every file below is an ADDITION to it, not a replacement, so the counts must have grown and nothing may have gone from passing to failing
  - Confirm **all four properties are present and passing**, each in its own file, each at `numRuns >= 100`, each carrying its `// Feature: date-tooltips-and-folder-contrast, Property N: <name>` tag and its `**Validates: Requirements ...**` line:
    - Property 1 — `client/src/utils/relativeTime.property.test.js`
    - Property 2 — `client/src/utils/contrast.property.test.js`
    - Property 3 — `client/src/utils/dateFormat.zonedDay.property.test.js`
    - Property 4 — `client/src/components/FormattedDate.property.test.jsx`
  - Confirm the two deliberate PBT omissions are still deliberate and still recorded in comments: `resolveColorToken` (finite input space, table-driven example test instead) and everything in Concern B's class edits (declarative styling, no correctness properties in the design)
  - Run `npm test` from the repo root and confirm the server suite is unchanged at **112 suites / 2167 tests**. Nothing in this spec touches the server, so ANY movement there means something went wrong
  - Run `npm run lint` from the repo ROOT and confirm at or below **107 problems (95 errors, 12 warnings)**. Be plain about how weak this gate is here: the root script lints `server scripts database/*.js eslint.config.js` and **does not lint `client/`**, and there is no `lint` script in `client/`, so essentially all of this spec's code is unlinted by it. The number should come out unchanged at 107 and that fact says nothing about the quality of the client changes. The client vitest suite is the real gate
  - **There is NO migration, no schema change, no wire-format change and no public-config key in this spec.** Nothing to apply, nothing to roll back, nothing to look for in `database/migrations/`. Stated explicitly so nobody goes hunting
  - Four things to raise in review, all of them recorded in design.md rather than discovered here: **Concern A reaches app-wide** (ten positions gain a focusable disclosure, a full audit-log page gains 50 tab stops); **task 2.3's light-mode description token is a colour the requirements do not mention**, added because Criterion 6.1's unification otherwise pushes that text to 4.39:1 against the 4.5:1 Criterion 7.4 asserts; **Criterion 3.4's count of table-cell positions is wrong** (six, not eight, with four `<p>`-hosted rather than two); and **Escape-to-dismiss is an addition beyond the requirements**, alongside the SC 1.4.13 hoverable shortfall `pointer-events-none` does not fix
  - Ensure all tests pass, ask the user if questions arise

## Notes

- Tasks marked `*` are optional and can be skipped for a faster MVP. Tasks 1.4 and 7.1 are tests that are NOT marked optional, because Criteria 7.7 and 2.12 make each test the deliverable rather than a check on one.
- Concern B (sections 1-2) and Concern A (sections 3-7) are independent. Either can ship, or be reverted, without the other.
- Every leaf task references the granular criteria it implements, so a reviewer can read a criterion and find the task that satisfies it.
- Client tests mount with `react-dom/client`'s `createRoot` inside React 18's `act` and dispatch events natively. There is no `@testing-library/react` in this project and none is added. Any test file mounting a `.jsx` component needs `globalThis.React = React`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1", "2.2"] },
    { "id": 3, "tasks": ["2.3"] },
    { "id": 4, "tasks": ["3.1", "4.1"] },
    { "id": 5, "tasks": ["3.2", "3.3", "4.2", "4.3", "5.1"] },
    { "id": 6, "tasks": ["5.2", "5.3", "6.1", "6.2", "6.3", "6.4", "6.5", "6.6"] },
    { "id": 7, "tasks": ["6.7", "7.1"] }
  ]
}
```

Waves 0-3 are Concern B. 1.1 lands alone because everything else in the section imports `contrast.js`. Wave 1 puts the two optional test files beside 1.4, which touches a third file — and 1.4 must be observed RED before wave 2 runs, which is the one ordering Criterion 7.7 makes part of the deliverable rather than a convenience. Waves 2 and 3 are split by the same-file rule: 2.1 and 2.3 both edit `client/src/pages/Dashboard.jsx`, so they cannot share a wave, while 2.2 edits `GlobalChannels.jsx` and rides with 2.1.

Waves 4-7 are Concern A, and the boundaries are real dependencies rather than the same-file rule. 3.1 (`relativeTime.js`) and 4.1 (`dateFormat.js`) are independent of each other and share wave 4; 5.1 (`FormattedDate.jsx`) imports both, so it cannot start before wave 5. The six adoption tasks all import `FormattedDate` and each edits a different file, so they fill wave 6 together — 6.6 also edits `OrgInterestRequests.test.jsx`, which is why 6.7 (extending that same file among others) is pushed to wave 7. 7.1's guard asserts a state only the completed adoption produces, so it is in the last wave by dependency, not by file.

Checkpoint tasks (1.5, 2.4, 3.4, 4.4, 5.4, 6.8, 7.2) and the top-level final verification (8) are not in the graph: they gate a section rather than producing code, and each runs after every leaf task in its own section.
