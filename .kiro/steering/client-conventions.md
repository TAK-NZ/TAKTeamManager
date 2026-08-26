---
inclusion: fileMatch
fileMatchPattern: 'client/src/**/*.{jsx,js}'
---

# Client conventions

## Dates — one component, no exceptions

- Render every user-visible date through `client/src/components/FormattedDate.jsx`. It is the ONLY non-test client module permitted to import `formatDate`/`formatDateTime` from `client/src/utils/dateFormat.js`.
- `client/src/utils/dateFormatConsumers.test.js` enforces this mechanically as a set EQUALITY against a one-entry allow-list (`ALLOWED_HELPER_CONSUMERS`). It catches named, renamed, multi-line, namespace, dynamic `import()` and `require()` forms; comments and test files are exempt. A new direct consumer fails the suite by design — either route through `FormattedDate` or amend the allow-list deliberately.
- `hasRenderableDate`, `zonedDayNumber`, `setDisplayTimezone`, `getDisplayTimezone` and `DEFAULT_DISPLAY_TIMEZONE` are legitimately importable anywhere. The rule restricts the two RENDERERS, not the module. `DeviceListRow` imports `hasRenderableDate` as a layout predicate.
- Wrap the helpers, never modify them. Their signatures and character-for-character output are depended on by eleven render positions.
- Derive every zone-dependent value from `getDisplayTimezone()` — the RESOLVED zone. Never the browser's local zone, never the configured value. A UTC−7 browser otherwise renders a calendar day away from the operator's zone.
- For date-only precision, compute the relative phrase from the Midnight_Anchor via `zonedDayNumber` on BOTH ends. Two cells showing the same calendar day must carry the same phrase.
- `relativeTime(value, now)` in `client/src/utils/relativeTime.js` is pure and total. `now` is REQUIRED with no default — a defaulted clock read silently works while being wrong by the age of the render. Unusable input returns `NO_PHRASE` (`null`), never a throw and never `''`. One odd timestamp must not blank a 50-row table.
- Read the clock inside the disclosure handler. No timer, interval, subscription or `useEffect` in `FormattedDate` — a render-time phrase goes stale, and a ticking timer is a second refresh mechanism per date.

## Tooltips

- Disclose on pointer hover AND keyboard focus, from a focusable host. Hover-only context is invisible to a keyboard user.
- Never use `title` as the description mechanism — it is not disclosed on focus and screen-reader support is inconsistent. Put no `role` on the host or the popover; a role makes a date announce as a control.
- Point `aria-describedby` only at a MOUNTED element. Attribute and tooltip appear and disappear together; a dangling reference is worse than none.
- **Place tooltips SIDEWAYS ONLY**: `left-full`/`ml-2` or `right-full`/`mr-2`, plus `top-1/2 transform -translate-y-1/2`. Never `top-full` or `bottom-full`. This is the Tooltip_Clipping_Defect: both device tables carry `overflow-x-auto` (`client/src/components/UserDevicesModal.jsx`, `client/src/pages/Dashboard.jsx`), and a box with one overflow axis `auto` and the other `visible` clips on BOTH axes. Do not "tidy" this into a vertically-opening tooltip.
- Open leftward from trailing columns, rightward elsewhere; default rightward. Use `TOOLTIP_SIDES` from `FormattedDate.jsx`. Right-edge clipping is recoverable by scrolling — left-edge clipping is not.
- Keep `pointer-events-none` on the tooltip body. Folder rows are `cursor-pointer` with an `onClick`; an event-accepting tooltip swallows the click and flickers under pointerleave-driven state.
- Choose the mechanism by content: STATIC text uses the CSS `relative group` + `group-hover:opacity-100` pattern; content computed AT DISCLOSURE is state-driven and mounted only while disclosed. Visual treatment is byte-identical either way.
- Choose ARIA by content: text RESTATED from elsewhere is `aria-hidden` to avoid double announcement; content that exists nowhere else gets `aria-describedby`.

## Accessibility

- Carry state in TEXT, never colour or font weight alone — neither reaches assistive technology. Decorative dots and glyphs are `aria-hidden`.
- Graphical objects (icons, chevrons, affordances) need >= 3:1 contrast; body text >= 4.5:1. Both in light and dark, resting and hover.
- COMPUTE contrast, never assert a remembered number and never verify by screenshot alone. Use `contrastRatio` from `client/src/utils/contrast.js`. A dim icon looks like a preference until someone produces a number — that is how a 1.46:1 failure shipped.
- Resolve colour tokens through `COLOR_TOKEN_TABLE` / `resolveColorToken` in `client/src/utils/contrast.js`, built from `resolveConfig(tailwindConfig)`. Never hardcode hex and never assume stock Tailwind: the declared `gray` scale is byte-identical to stock today, so a hardcoded table would pass while measuring nothing, and `blue-*` is not declared at all. The `tailwindcss/resolveConfig.js` import needs its extension — extensionless fails at module resolution.
- Read measured tokens OFF rendered elements, not a hand-written list. A colour-shaped class the table cannot resolve must throw, not be skipped — an unmeasured pair is a pair that passes.
- Separate tooltip facts with explicit separator text (`TOOLTIP_SEPARATOR`), not layout. A reader announcing the tooltip as one string must not run two facts together.
- Every button inside a `<form onSubmit=...>` needs explicit `type="button"`.

## Shared components

- `client/src/components/DeviceListRow.jsx` is the single definition of a device-list row AND its header (`DeviceListRow`, `DeviceListHeader`, `DEVICE_LIST_COLUMNS`), shared by the Dashboard card and `UserDevicesModal`. Two copies that match today diverge on the next change to one surface.
- Extract a shared component when BEHAVIOUR is duplicated. For a colour-values-only change across duplicated markup, a mechanical test covering both copies is the lighter answer — the channel tree in `client/src/pages/Dashboard.jsx` and `client/src/pages/GlobalChannels.jsx` is deliberately NOT extracted (see `client/src/pages/channelTreeContrast.test.jsx`), but the two must be changed together and identically.
- A failed background refresh must never clear a rendered list, re-raise the spinner, or hide a card. Only an explicit "feature off" response hides it. Auto-refresh pauses while the tab is hidden; never auto-refresh inside a short-lived dialog.
