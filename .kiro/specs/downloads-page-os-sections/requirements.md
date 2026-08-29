# Requirements Document

## Introduction

The Downloads page (`client/src/pages/Downloads.jsx`) currently presents four TAK client download links in a 2x2 grid organized by app store (TAK.gov, Google Play, Apple App Store x2). This feature reorganizes the page around target operating system instead: an Android_Section, an iOS_Section, and a Windows_Section, each carrying that platform's native TAK client download options, plus one CloudTAK_Row spanning all three columns for the browser-based CloudTAK client that works on those three platforms and on any other OS with a browser (Linux, macOS, etc.).

The feature also introduces a new client-facing, runtime-configurable CloudTAK URL (distinct from the existing server-only `CLOUDTAK_ENABLED` integration flag), and replaces the store-badge-only visual language with recognizable per-OS platform logos on both the Downloads page and the Dashboard/admin device-list glyphs (`client/src/components/DeviceTypeIcon.jsx`), so the same visual language for Android/iOS/Windows/CloudTAK appears in both places.

## Glossary

- **Downloads_Page**: The React view at `client/src/pages/Downloads.jsx`, reachable via the ungated `/downloads` route.
- **OS_Section**: One of the three per-operating-system groupings on the Downloads_Page: the Android_Section, the iOS_Section, or the Windows_Section. Each OS_Section renders as its own column and carries a Platform_Logo (Android_Section, iOS_Section) or the Windows_Glyph (Windows_Section), an OS name label, and one or more Download_Routes for that platform.
- **Download_Route**: A single downloadable-client entry within an OS_Section: a label, a Badge, an external link target, and a Recommended flag. Equivalent in structure to the existing `DOWNLOAD_ROUTES` entries.
- **CloudTAK_Row**: A single section on the Downloads_Page, visually spanning the width of the three OS_Sections (not nested inside any one of them and not repeated per OS_Section), representing browser-based access to CloudTAK. Rendered at most once on the page.
- **CloudTAK_URL**: The configured destination the CloudTAK_Row links to, resolved server-side from the `CLOUDTAK_URL` environment variable and exposed to the Downloads_Page via the Public_Config_Endpoint's `cloudtak_url` field.
- **Public_Config_Endpoint**: The existing unauthenticated `GET /api/config/public` route, backed by `SiteConfig.getPublicConfig()`.
- **CLOUDTAK_ENABLED**: The existing server-only environment variable read by `isCloudTakEnabled()` (`server/config/cloudtak.js`), gating the unrelated Authentik agency-group sync integration. Never read, referenced, or derived from by any requirement in this document.
- **Platform_Logo**: A brand-recognizable glyph for Android or iOS (Apple), sourced from the `simple-icons` icon set, rendered in the Android_Section's and iOS_Section's headers and in `DeviceTypeIcon.jsx`'s Android and iOS glyphs.
- **Windows_Glyph**: A neutral, non-brand "computer" glyph for Windows, sourced from the heroicons `ComputerDesktopIcon` component rather than a Windows or Microsoft brand mark, because `simple-icons` does not offer a Windows or Microsoft logo (Microsoft required simple-icons to remove its Microsoft-brand icons in simple-icons v13.0.0, and Windows has not been reinstated since). Rendered in the Windows_Section's header and in `DeviceTypeIcon.jsx`'s Windows glyph.
- **Device_Type_Icon**: The existing shared component at `client/src/components/DeviceTypeIcon.jsx` that renders a glyph for a Device's `clientType`, consumed by both the Dashboard "My Devices" card and `UserDevicesModal.jsx`.
- **Recommended_Option_Marker**: The existing star glyph/tooltip component (`client/src/components/StoreBadges.jsx`) denoting a preferred Download_Route within an OS_Section.
- **TakGovBadge**: The existing hand-drawn "Get it from TAK.gov" badge component (`client/src/components/StoreBadges.jsx`), reused unmodified for the new WinTAK Download_Route.

## Requirements

### Requirement 1: Android_Section content

**User Story:** As a user visiting the Downloads page on or for an Android device, I want to see all Android TAK client download options grouped together, so that I can find the right installer without scanning unrelated platforms.

#### Acceptance Criteria

1. THE Downloads_Page SHALL render an Android_Section containing exactly two Download_Routes, in the order ATAK via TAK.gov followed by ATAK via Google Play.
2. THE Android_Section SHALL mark the ATAK-via-TAK.gov Download_Route with the Recommended_Option_Marker.
3. THE Android_Section SHALL NOT mark the ATAK-via-Google-Play Download_Route with the Recommended_Option_Marker.
4. THE Android_Section SHALL display, in its section header, the Android Platform_Logo alongside a visible text label reading "Android", with the Platform_Logo exposed to assistive technology as decorative rather than as a separately announced image.
5. THE Android_Section SHALL preserve the existing link targets, `TakGovBadge`, and `GooglePlayBadge` used by the ATAK-via-TAK.gov and ATAK-via-Google-Play Download_Routes unchanged from the current Downloads_Page.

### Requirement 2: iOS_Section content

**User Story:** As a user visiting the Downloads page on or for an iOS device, I want to see all iOS TAK client download options grouped together, so that I can find the right installer without scanning unrelated platforms.

#### Acceptance Criteria

1. THE Downloads_Page SHALL render an iOS_Section containing exactly two Download_Routes, each identified by its own visible text label reading "TAK Aware" or "iTAK", and no other Download_Route.
2. THE iOS_Section SHALL mark the TAK Aware Download_Route with the Recommended_Option_Marker.
3. THE iOS_Section SHALL NOT mark the iTAK Download_Route with the Recommended_Option_Marker.
4. THE iOS_Section SHALL display, at the top of the section, a section header containing both the iOS (Apple) Platform_Logo and a visible text label reading "iOS".
5. THE iOS_Section SHALL preserve, unchanged from the current Downloads_Page, the href destination and the `AppleAppStoreBadge` component used by each of the TAK Aware and iTAK Download_Routes.
6. THE iOS_Section SHALL render its Platform_Logo as decorative, with no accessible name of its own, given the adjacent "iOS" text label already conveys the platform identity as text.

### Requirement 3: Windows_Section content (new WinTAK route)

**User Story:** As a user visiting the Downloads page on or for a Windows machine, I want a Windows-native TAK client download option, so that I do not have to conclude Windows is unsupported.

#### Acceptance Criteria

1. THE Downloads_Page SHALL render a Windows_Section containing exactly one Download_Route: WinTAK.
2. THE WinTAK Download_Route SHALL link to `https://tak.gov/products/wintak-civ`.
3. THE WinTAK Download_Route SHALL render using the `TakGovBadge` component, unmodified, at the same uniform visible badge size applied to every Download_Route's badge within an OS_Section (Requirement 7.3), rather than at the badge's own intrinsic SVG dimensions.
4. THE Windows_Section SHALL NOT mark the WinTAK Download_Route with the Recommended_Option_Marker.
5. THE Windows_Section SHALL display the Windows_Glyph in its section header.
6. THE WinTAK Download_Route's link element SHALL expose an accessible name that contains the text "WinTAK" and that differs from the accessible name exposed by the ATAK-via-TAK.gov Download_Route's link element, so that a screen-reader user is not told "Get it from TAK.gov" for both links with no way to distinguish which is WinTAK and which is ATAK.
7. THE WinTAK Download_Route's distinct accessible name required by Criterion 6 SHALL be carried by the link element itself (for example via an attribute read by assistive technology, such as an accessible-name override on the anchor), rather than relying solely on visually adjacent label text rendered outside that link element, since content outside an anchor element is not included when assistive technology computes that anchor's accessible name.

### Requirement 4: CloudTAK_Row spanning all OS_Sections

**User Story:** As a user on any operating system, including one with no native TAK client, I want a single browser-based CloudTAK option that is presented once, so that I do not have to check three different OS columns for the same link or wonder why my OS has no section.

#### Acceptance Criteria

1. WHEN the CloudTAK_URL (the Public_Config_Endpoint's `cloudtak_url` field) is a non-null value, THE Downloads_Page SHALL render exactly one CloudTAK_Row, positioned so that it visually spans all three OS_Sections rather than appearing inside, or duplicated within, any single OS_Section.
2. THE CloudTAK_Row SHALL link to the CloudTAK_URL.
3. THE CloudTAK_Row SHALL display the heroicons `GlobeAltIcon` glyph, matching the glyph `DeviceTypeIcon.jsx` already uses to represent CloudTAK.
4. THE CloudTAK_Row SHALL NOT mark itself with the Recommended_Option_Marker.
5. THE CloudTAK_Row SHALL present accessible text that is visibly rendered on screen, not limited to a screen-reader-only label, stating that CloudTAK is a browser-based option that works on any operating system with a browser, and naming Android, iOS, and Windows explicitly alongside other browser-capable operating systems, so that a reader is told in text, not implied by position alone, why this one option is not limited to the three OS_Sections it spans.
6. IF the CloudTAK_URL (the Public_Config_Endpoint's `cloudtak_url` field) is `null`, THEN THE Downloads_Page SHALL omit the CloudTAK_Row entirely rather than rendering a link with no usable destination.

### Requirement 5: CLOUDTAK_URL configuration

**User Story:** As an operator deploying this application, I want to configure the CloudTAK link the Downloads page shows without rebuilding the client, so that each deployment can point at its own CloudTAK instance.

#### Acceptance Criteria

1. THE Public_Config_Endpoint SHALL include a `cloudtak_url` field in every response it returns, and, WHEN `CLOUDTAK_URL` is set to a value satisfying Criterion 3's validity rule, THE Public_Config_Endpoint SHALL set `cloudtak_url` to that environment variable's exact, unmodified string value.
2. IF `CLOUDTAK_URL` is unset, is an empty string, or consists only of whitespace characters, THEN THE Public_Config_Endpoint SHALL return `cloudtak_url` as `null`.
3. IF `CLOUDTAK_URL` is set to a non-whitespace value that does not parse as an absolute URL with scheme `http` or `https` (scheme match is case-insensitive) and a non-empty host component, THEN THE Public_Config_Endpoint SHALL return `cloudtak_url` as `null`.
4. THE Public_Config_Endpoint's exposure of `cloudtak_url` SHALL be independent of the value of `CLOUDTAK_ENABLED`: THE Public_Config_Endpoint SHALL return the same `cloudtak_url` value regardless of whether `CLOUDTAK_ENABLED` is `'true'`, unset, or any other value.
5. THE `.env.example` file SHALL document `CLOUDTAK_URL` with a safe default (an unset/empty value) and an explanatory comment stating that it is independent of `CLOUDTAK_ENABLED`.
6. THE `server/models/SiteConfig.test.js` regex guard covering device-management flag keys SHALL NOT be weakened or removed by this feature. THE same test file's Public_Config_Endpoint coverage SHALL assert both that `cloudtak_url` equals the configured value when `CLOUDTAK_URL` is set to a valid absolute `http://` or `https://` URL, and that `cloudtak_url` is `null` when `CLOUDTAK_URL` is unset.

### Requirement 6: Platform_Logo/Windows_Glyph sourcing and reuse across Downloads_Page and Device_Type_Icon

**User Story:** As a user, I want to recognize the Android, iOS, and Windows sections and device-list glyphs by their real platform logos, so that I can scan the page or table visually rather than reading every label.

`simple-icons` does not offer a Windows or Microsoft logo: Microsoft required simple-icons to remove all Microsoft-brand icons in simple-icons v13.0.0 (June 2024), and Windows has not been reinstated in any release since. Windows therefore uses the neutral, non-brand Windows_Glyph (heroicons' `ComputerDesktopIcon`) everywhere Android and iOS use a `simple-icons`-sourced Platform_Logo, rather than a Windows or Microsoft brand mark.

#### Acceptance Criteria

1. THE Android_Section and iOS_Section headers SHALL each display, adjacent to that section's existing OS name text label, the Platform_Logo for that platform sourced from the `simple-icons` package, added to `client/package.json` as a new, exactly-pinned dependency. THE Windows_Section header SHALL display, adjacent to its existing OS name text label, the Windows_Glyph sourced from the heroicons `ComputerDesktopIcon` component. THE Platform_Logo or Windows_Glyph in each of the three headers SHALL render with a contrast ratio of at least 3:1 against its background in both the light and dark themes.
2. THE Device_Type_Icon component SHALL render the same `simple-icons`-sourced Platform_Logo used in the matching OS_Section header for the `android` and `ios` Client_Types, and the same heroicons `ComputerDesktopIcon`-sourced Windows_Glyph used in the Windows_Section header for the `windows` Client_Type, in place of its current hand-drawn glyphs for those three types, continuing to accept the existing `className` prop for sizing and rendering with a contrast ratio of at least 3:1 against its background in both the light and dark themes.
3. THE Device_Type_Icon component SHALL continue rendering the heroicons `GlobeAltIcon` for the `cloudtak` Client_Type and the heroicons `QuestionMarkCircleIcon` for the `unknown` Client_Type, unchanged.
4. THE Device_Type_Icon component's exported `CLIENT_TYPES`, `DEVICE_TYPE_LABELS`, `resolveClientType`, and `labelForClientType` functions SHALL remain unchanged in behavior by this feature.
5. THE updated `DeviceTypeIcon.jsx` doc comment SHALL state that its Android and iOS glyphs are sourced from the `simple-icons` dependency and its Windows glyph from the heroicons `ComputerDesktopIcon` component, rather than committed inline SVG, and SHALL no longer state that the component introduces no new client dependency.
6. THE Dashboard "My Devices" card and `UserDevicesModal.jsx` SHALL both render the updated Device_Type_Icon glyphs, with no separate glyph definition introduced in either surface.
7. THE Device_Type_Icon component's existing accessibility contract -- the `role="img"` wrapper, the `aria-label` naming the platform, and the hover/keyboard-focus tooltip disclosure -- SHALL remain unchanged, for all five Client_Types, after the Platform_Logo/Windows_Glyph substitution described in Criterion 2.
8. THE Platform_Logo or Windows_Glyph within each OS_Section header SHALL be marked decorative to assistive technology (e.g. via `aria-hidden`), since that header's adjacent OS name text label already names the platform, so a screen reader does not announce the platform name twice.

### Requirement 7: Preserved cross-cutting behavior

**User Story:** As a user, I want the parts of the Downloads page that already work correctly to keep working the same way after the redesign, so that the restructuring does not silently regress existing accessibility and security properties.

#### Acceptance Criteria

1. THE Downloads_Page SHALL set `rel="noopener"` on every external Download_Route link across all three OS_Sections and on the CloudTAK_Row's link whenever the CloudTAK_Row is rendered.
2. THE Downloads_Page SHALL render the footnote legend restating the Recommended_Option_Marker's meaning exactly once, at the page level rather than duplicated within or repeated per OS_Section, as visible text present regardless of hover or focus state on any Recommended_Option_Marker.
3. THE Downloads_Page SHALL render every Download_Route's badge, within each OS_Section, at the same rendered height with each badge's width scaled to preserve that badge's own aspect ratio, matching the current `BADGE_CLASSNAME` (`'h-10 w-auto'`) treatment.
4. THE Downloads_Page SHALL remain reachable at its route without requiring the user to sign in, SHALL add no entry to `server/config/permissions.registry.js`, and SHALL depend for any server-provided data only on the already-unauthenticated `GET /api/config/public` endpoint.
