import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { FolderIcon, FolderOpenIcon } from '@heroicons/react/24/outline'

import Dashboard from './Dashboard.jsx'
import GlobalChannels from './GlobalChannels.jsx'
import { contrastRatio, resolveColorToken } from '../utils/contrast.js'
import {
  usersAPI,
  channelsAPI,
  requestsAPI,
  configAPI,
  deviceManagementAPI,
  globalChannelsAPI
} from '../services/api'

// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 5.1, 5.5,
// 5.7, 6.4, 6.6
//
// The COMPUTED contrast test for the two Channel_Tree_Pages
// (date-tooltips-and-folder-contrast task 1.4).
//
// It renders BOTH pages (Criterion 7.6), reads the colour classes OFF the
// elements they produce (Criterion 7.2), resolves each token through
// `resolveColorToken` (Criterion 7.3), computes every pair with
// `contrastRatio` (Criterion 7.1) and asserts INEQUALITIES against the two
// WCAG thresholds (Criterion 7.4): 3:1 for the Folder_Icon and the
// Disclosure_Chevron as graphical objects, 4.5:1 for row text. Nothing here
// is compared against a hardcoded expected ratio, and no hand-written token
// list is fed in -- a token edited in the JSX changes what this test
// measures, which is the whole point of Criterion 7.2.
//
// ---------------------------------------------------------------------------
// WHAT THIS TEST PROVES, AND WHAT IT DOES NOT. Read this before trusting it.
// ---------------------------------------------------------------------------
// **jsdom applies no CSS.** No stylesheet is loaded, Tailwind never runs, and
// `getComputedStyle` would report a default `rgb(0, 0, 0)` for every element
// here. On top of that, `client/tailwind.config.js` sets `darkMode: 'class'`,
// so dark styling depends on an ancestor carrying `.dark` rather than on a
// media query -- there is no computed style to read, and no `:hover` state to
// trigger either.
//
// So this test reads CLASS NAMES, not painted colours. What that proves: the
// token PAIRS the JSX declares meet the thresholds, and -- because the pairs
// are read off the same rendered elements rather than from a list -- a token
// edited or deleted in the markup makes this test fail rather than pass
// unchanged. What it does NOT prove: that a browser paints those tokens. A
// conflicting rule elsewhere, a specificity accident, a class purged by the
// Tailwind content scan, or a missing `.dark` ancestor would all go
// undetected here, and closing that gap needs a real browser.
//
// That gap is accepted rather than traded away. Criterion 7.8 forbids the
// reverse trade -- verifying by screenshot instead of by number -- because
// that is exactly how the 1.46:1 defect this spec fixes shipped: the icon
// looked dim rather than looking like a conformance failure, and a number was
// needed before anyone could say which.
//
// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------
// There is no `@testing-library/react` in this project and none is added, so
// both pages are mounted with `react-dom/client`'s `createRoot` inside React
// 18's own `act` -- the pattern `TransferMemberDialog.test.jsx` established
// and `DeviceTypeIcon.test.jsx` documents. `globalThis.React = React` is
// required because vitest compiles this JSX with esbuild's classic transform
// while the page sources carry no `React` import of their own.

vi.mock('../services/api', () => ({
  usersAPI: { getMe: vi.fn() },
  channelsAPI: { getDescriptions: vi.fn() },
  requestsAPI: { getPending: vi.fn() },
  configAPI: { getColorMappings: vi.fn(), getPublic: vi.fn() },
  // `Dashboard.jsx` imports `teamsAPI` without calling it on this path; a
  // named import of a missing export from a mocked ES module is a load-time
  // failure, so it is present.
  teamsAPI: {},
  // Dashboard.jsx's pending-requests stat additionally calls
  // adminAPI.getOrgInterest for a Global_Manager user (bugfix:
  // pending-requests-badge). USER below carries no is_global_manager flag,
  // so that branch never fires here, but the export must still exist.
  adminAPI: { getOrgInterest: vi.fn() },
  deviceManagementAPI: { probeEnabled: vi.fn() },
  globalChannelsAPI: {
    getBchChannels: vi.fn(),
    getRegionChannels: vi.fn()
  }
}))

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}))

globalThis.React = React

// ===========================================================================
// Reading colours off rendered elements
// ===========================================================================

/** The four states every pair is measured in (Criterion 7.5). */
const LAYERS = ['lightRest', 'lightHover', 'darkRest', 'darkHover']

const LAYER_NAMES = {
  lightRest: 'light mode, resting',
  lightHover: 'light mode, hover',
  darkRest: 'dark mode, resting',
  darkHover: 'dark mode, hover'
}

const GRAPHICAL_OBJECT_MINIMUM = 3
const TEXT_CONTRAST_MINIMUM = 4.5

/**
 * An element's class list.
 *
 * `getAttribute('class')` rather than `.className`, because half the elements
 * measured here are `<svg>` and an SVGElement's `className` is an
 * `SVGAnimatedString`, not a string.
 */
const classesOf = (element) =>
  (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

/** Which of the four layers a class name applies to. */
function layerOf(className) {
  const variants = className.split(':').slice(0, -1)
  const mode = variants.includes('dark') ? 'dark' : 'light'
  const state = variants.includes('hover') ? 'Hover' : 'Rest'
  return `${mode}${state}`
}

/** `bg`, `text` or `border` -- which property a colour class sets. */
const groupOf = (className) => {
  const bare = className.split(':').at(-1)
  return bare.slice(0, bare.indexOf('-'))
}

/**
 * The colour tokens ONE element declares, indexed by property and layer.
 *
 * Every class is put through `resolveColorToken`, so a class that names no
 * colour is skipped and a colour-SHAPED class the Color_Token_Table cannot
 * resolve THROWS out of here rather than being silently left unmeasured
 * (Criterion 7.3, last sentence).
 */
function declaredColors(element) {
  const declared = { bg: {}, text: {}, border: {} }

  for (const className of classesOf(element)) {
    const hex = resolveColorToken(className)
    if (hex === null) continue
    declared[groupOf(className)][layerOf(className)] = hex
  }

  return declared
}

/**
 * Whether an element paints a RESTING background of its own.
 *
 * Resting specifically, and the distinction is load-bearing: the
 * Expandable_Channel_Row's toggle button declares `hover:bg-gray-200
 * dark:hover:bg-gray-600` and no resting background at all, so a
 * "declares any background" test would identify the BUTTON as the row and
 * then find no heading and no description inside it. The row is the box that
 * paints when nothing is hovered.
 */
const paintsRestingBackground = (element) => {
  const { bg } = declaredColors(element)
  return bg.lightRest !== undefined || bg.darkRest !== undefined
}

/**
 * Fills in the layers a declaration leaves implicit.
 *
 * `dark:` falls back to the mode-independent declaration, and `hover:` falls
 * back to the resting one. Dark-hover falls back to dark-RESTING before it
 * falls back to light-hover, because Tailwind 3 orders the `dark` variant
 * after `hover`, so an undarkened `hover:bg-*` is overridden by a `dark:bg-*`
 * in dark mode.
 */
function cascade(pick) {
  const lightRest = pick('lightRest')
  const lightHover = pick('lightHover') ?? lightRest
  const darkRest = pick('darkRest') ?? lightRest
  const darkHover = pick('darkHover') ?? darkRest ?? lightHover
  return { lightRest, lightHover, darkRest, darkHover }
}

/** An element and every ancestor of it up to and including `root`. */
function chainFrom(element, root) {
  const chain = []
  for (let node = element; node; node = node.parentElement) {
    chain.push(node)
    if (node === root) break
  }
  return chain
}

/**
 * The four foreground colours an element renders its own content in.
 *
 * Deliberately reads the element's OWN classes and does not walk ancestors:
 * an icon declaring `text-blue-600` and no dark variant paints blue in dark
 * mode too, because its own colour wins over anything it would otherwise
 * inherit. Walking the chain per layer would wrongly hand it some ancestor's
 * `dark:text-gray-400`.
 *
 * Throws when the element declares no text colour, which means the locator
 * that found it is wrong -- exactly the sort of silent mismeasurement the
 * anti-vacuity guards below exist to catch.
 */
function foregroundOf(element, description) {
  const text = declaredColors(element).text
  if (text.lightRest === undefined && text.darkRest === undefined) {
    throw new Error(
      `foregroundOf: ${description} declares no text colour ` +
        `(classes: ${classesOf(element).join(' ') || '<none>'})`
    )
  }
  return cascade((layer) => text[layer])
}

/**
 * The four background colours an element is painted against.
 *
 * This one DOES walk the ancestor chain, per layer, because that is precisely
 * how the Expandable_Channel_Row's toggle button works: the button declares
 * `hover:bg-gray-200 dark:hover:bg-gray-600` and no resting background at
 * all, so its resting background is the row's underneath it. Nearest
 * declaration per layer wins.
 */
function backgroundOf(element, root, description) {
  const declaredPerElement = chainFrom(element, root).map(declaredColors)

  const resolved = cascade((layer) => {
    for (const declared of declaredPerElement) {
      if (declared.bg[layer] !== undefined) return declared.bg[layer]
    }
    return undefined
  })

  if (resolved.lightRest === undefined) {
    throw new Error(`backgroundOf: no background colour declared above ${description}`)
  }
  return resolved
}

/** Contrast in all four layers, keeping the hexes for the failure message. */
function measurePair(foreground, background) {
  const measured = {}
  for (const layer of LAYERS) {
    measured[layer] = {
      ratio: contrastRatio(foreground[layer], background[layer]),
      fg: foreground[layer],
      bg: background[layer]
    }
  }
  return measured
}

/** The resting-to-hover background step, per mode (Criterion 6.4). */
const measureStep = (background) => ({
  light: contrastRatio(background.lightRest, background.lightHover),
  dark: contrastRatio(background.darkRest, background.darkHover)
})

// ===========================================================================
// Locating the rows
// ===========================================================================
//
// The Disclosure_Chevron is located by CLASS TOKEN, never by component name.
// It has to be: it is a local `ChevronRightSmall` on `Dashboard.jsx` and
// heroicons' `ChevronRightIcon` on `GlobalChannels.jsx`. Both render an
// `<svg>` carrying the class string, so the class is the only thing the two
// have in common.
//
// The Folder_Icon is different: both pages render the SAME heroicons
// `FolderIcon`/`FolderOpenIcon` component, and -- since the colour bugfix
// this test file's own history documents (both a Folder_Row and a
// Expandable_Channel_Row/plain-channel row now share one background AND the
// folder icon now matches the row's own heading colour rather than a
// distinct blue) -- colour no longer tells a Folder_Icon apart from the new
// per-channel `RadioIcon`. So this locator matches the rendered `<path
// d="...">` SHAPE instead, extracted directly from the real
// `FolderIcon`/`FolderOpenIcon` components below via `renderToStaticMarkup`
// (mirroring this project's `PlatformLogos.test.jsx`/`storeBadgeFidelity.test.jsx`
// direct-dependency-fidelity convention) -- so this locator can never drift
// from whatever glyph heroicons actually ships, and a future colour change
// cannot silently make it stop finding rows again.

/** The real `d` attribute heroicons' FolderIcon/FolderOpenIcon render, read from the components themselves. */
function pathDataOf(IconComponent) {
  const markup = renderToStaticMarkup(React.createElement(IconComponent))
  const match = markup.match(/<path[^>]*\sd="([^"]+)"/)
  if (match === null) {
    throw new Error(`pathDataOf: rendered markup for ${IconComponent.displayName ?? IconComponent} carries no <path d="...">`)
  }
  return match[1]
}

const FOLDER_ICON_PATH_DATA = new Set([pathDataOf(FolderIcon), pathDataOf(FolderOpenIcon)])

const isFolderIconShape = (svg) => {
  const d = svg.querySelector('path')?.getAttribute('d')
  return d !== undefined && d !== null && FOLDER_ICON_PATH_DATA.has(d)
}

const GRAY_TEXT = /^(?:[a-z]+:)*text-gray-\d{2,3}$/

const hasToken = (element, pattern) =>
  classesOf(element).some((className) => pattern.test(className))

const svgsIn = (element) => Array.from(element.querySelectorAll('svg'))

/**
 * A Disclosure_Chevron among a set of `<svg>`s.
 *
 * Gray text alone used to be enough to tell the chevron apart from the
 * (blue) Folder_Icon, but since the colour bugfix the Folder_Icon and the
 * new per-channel/section RadioIcon are ALSO gray-token `<svg>`s -- so gray
 * text alone would match whichever gray icon happens to appear first in DOM
 * order, not necessarily the chevron. `transition-transform` is the
 * chevron's own rotation-affordance class (`rotate-90` when expanded) and
 * nothing else in either row renders it, so it is what actually
 * distinguishes the chevron now.
 */
const findChevron = (svgs) =>
  svgs.find((svg) => hasToken(svg, GRAY_TEXT) && classesOf(svg).includes('transition-transform'))

/** The nearest ancestor (or the element itself) that paints the row. */
function nearestRowBox(element, root) {
  return chainFrom(element, root).find(paintsRestingBackground) ?? null
}

/** The row's heading: the `font-medium` element carrying a gray text token. */
const headingIn = (row) =>
  Array.from(row.querySelectorAll('*')).find(
    (element) => classesOf(element).includes('font-medium') && hasToken(element, GRAY_TEXT)
  ) ?? null

/** The row's description, where it has one -- a `<p>` with a gray text token. */
const descriptionIn = (row) =>
  Array.from(row.querySelectorAll('p')).find((element) => hasToken(element, GRAY_TEXT)) ?? null

/**
 * Every Folder_Row in a container, measured.
 *
 * A Folder_Row is found from its Folder_Icon: an `<svg>` whose path data
 * matches the real heroicons FolderIcon/FolderOpenIcon shape, and whose
 * nearest background box also contains a Disclosure_Chevron (see
 * `findChevron` above). That pair of conditions is what separates a real
 * Folder_Row from `GlobalChannels.jsx`'s `RadioIcon` section header (a
 * different shape entirely) and from a plain channel row's own `RadioIcon`
 * (same shape as the section header, no chevron beside it) -- both outside
 * Requirement 5.
 */
function findFolderRows(container, page, glyph) {
  const rows = new Map()

  for (const icon of svgsIn(container)) {
    if (!isFolderIconShape(icon)) continue

    const row = nearestRowBox(icon, container)
    if (row === null) continue

    const chevron = findChevron(svgsIn(row))
    if (chevron === undefined) continue
    if (rows.has(row)) continue

    const heading = headingIn(row)
    const background = backgroundOf(row, container, 'a Folder_Row')

    rows.set(row, {
      page,
      glyph,
      kind: 'Folder_Row',
      label: heading?.textContent?.trim() ?? '<unnamed>',
      element: row,
      chevronRotated: classesOf(chevron).includes('rotate-90'),
      background,
      step: measureStep(background),
      icon: measurePair(
        foregroundOf(icon, 'a Folder_Icon'),
        backgroundOf(icon, container, 'a Folder_Icon')
      ),
      chevron: measurePair(
        foregroundOf(chevron, 'a Folder_Row Disclosure_Chevron'),
        backgroundOf(chevron, container, 'a Folder_Row Disclosure_Chevron')
      ),
      heading:
        heading === null
          ? null
          : measurePair(
              foregroundOf(heading, 'a Folder_Row heading'),
              backgroundOf(heading, container, 'a Folder_Row heading')
            ),
      // TRAP: neither page's Folder_Row renders description text --
      // `GlobalChannels.jsx` renders a heading `<span>` and nothing else, and
      // `Dashboard.jsx`'s Folder_Row does the same. The description `<p>`
      // belongs to the Expandable_Channel_Row. Recorded as `null` here and
      // asserted per page below rather than measured on every row.
      description: (() => {
        const found = descriptionIn(row)
        return found === null
          ? null
          : measurePair(
              foregroundOf(found, 'a Folder_Row description'),
              backgroundOf(found, container, 'a Folder_Row description')
            )
      })()
    })
  }

  return Array.from(rows.values())
}

/**
 * Every Expandable_Channel_Row in a container, measured.
 *
 * Found from its TOGGLE BUTTON -- a `<button>` containing a Disclosure_Chevron
 * (see `findChevron` above). That button is where the hover background lives: the row itself
 * carries no `hover:` class at all, and `hover:bg-gray-200
 * dark:hover:bg-gray-600` sits on the button, so the chevron inside it is
 * measured against the button's hover and the row's resting background. That
 * is why the background resolution above walks the ancestor chain per layer
 * rather than reading one element.
 */
function findExpandableRows(container, page, glyph) {
  const rows = []

  for (const button of Array.from(container.querySelectorAll('button'))) {
    const chevron = findChevron(svgsIn(button))
    if (chevron === undefined) continue

    const row = nearestRowBox(button, container)
    if (row === null) continue

    const heading = headingIn(row)
    const description = descriptionIn(row)
    const background = backgroundOf(row, container, 'an Expandable_Channel_Row')

    rows.push({
      page,
      glyph,
      kind: 'Expandable_Channel_Row',
      label: heading?.textContent?.trim() ?? '<unnamed>',
      element: row,
      chevronRotated: classesOf(chevron).includes('rotate-90'),
      background,
      step: measureStep(background),
      icon: null,
      // The toggle button's own hover is the background this chevron sits on.
      chevron: measurePair(
        foregroundOf(chevron, 'an Expandable_Channel_Row Disclosure_Chevron'),
        backgroundOf(chevron, container, 'an Expandable_Channel_Row Disclosure_Chevron')
      ),
      heading:
        heading === null
          ? null
          : measurePair(
              foregroundOf(heading, 'an Expandable_Channel_Row heading'),
              backgroundOf(heading, container, 'an Expandable_Channel_Row heading')
            ),
      description:
        description === null
          ? null
          : measurePair(
              foregroundOf(description, 'an Expandable_Channel_Row description'),
              backgroundOf(description, container, 'an Expandable_Channel_Row description')
            )
    })
  }

  return rows
}

// ===========================================================================
// Assertion helpers
// ===========================================================================

/**
 * Every row's `part` clears `threshold` in `layer`.
 *
 * The message carries the two hexes and the computed ratio, so a failure says
 * WHICH pair failed and by how much rather than only that a number was too
 * small.
 */
function expectAtLeast(rows, part, layer, threshold) {
  expect(rows.length, `no rows to measure for ${part}`).toBeGreaterThan(0)

  for (const row of rows) {
    const measured = row[part]?.[layer]
    expect(
      measured,
      `${row.page} / ${row.kind} "${row.label}" (${row.glyph}): no ${part} was measured`
    ).toBeDefined()

    expect(
      measured.ratio,
      `${row.page} / ${row.kind} "${row.label}" (${row.glyph} glyph): ` +
        `${part} ${measured.fg} on ${measured.bg} in ${LAYER_NAMES[layer]} ` +
        `measures ${measured.ratio.toFixed(2)}:1, below the required ${threshold}:1`
    ).toBeGreaterThanOrEqual(threshold)
  }
}

// ===========================================================================
// Fixtures
// ===========================================================================

const FOLDER_SEPARATOR = ' - '

const USER = { id: 7, first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }

/**
 * `Dashboard.jsx` builds its channel list from the caller's `tak_*` groups and
 * the channel descriptions, so the tree has to be driven from those rather
 * than handed over directly.
 *
 * Three channels, chosen to reach BOTH Channel_Tree_Row types:
 *   - `Ops - Alpha` puts an `Ops` folder in the tree with no channel of its
 *     own name, which renders as a plain Folder_Row.
 *   - `Shared - Bravo` puts a `Shared` folder in the tree, and
 *   - `Shared` is a channel whose `display_name` MATCHES that folder path,
 *     which is the only condition under which `renderFolderTree` takes its
 *     `parentChannel` branch and renders an Expandable_Channel_Row. Without
 *     this third channel that branch is never reached and the row this test
 *     measures does not exist.
 */
const DASHBOARD_GROUPS = ['tak_ops_alpha', 'tak_shared_bravo', 'tak_shared']

const DASHBOARD_CHANNEL_DESCRIPTIONS = [
  { name: 'tak_ops_alpha', display_name: 'Ops - Alpha', description: 'Alpha channel' },
  { name: 'tak_shared_bravo', display_name: 'Shared - Bravo', description: 'Bravo channel' },
  { name: 'tak_shared', display_name: 'Shared', description: 'Shared parent channel' }
]

const BCH_CHANNELS = [
  { id: 1, name: 'Ops - Alpha', description: 'Alpha channel', created_by_name: 'Ada' }
]

const REGION_CHANNELS = [
  { id: 2, name: 'Region - North', description: 'North channel', created_by_name: 'Ada' }
]

/**
 * Mounts a page, measures it collapsed, expands every Folder_Row, and
 * measures it again.
 *
 * Both snapshots go into the returned `folderRows`, so every assertion below
 * covers the row in the collapsed AND the expanded glyph -- `FolderIcon` and
 * `FolderOpenIcon` carry identical colour classes today, and this is what
 * would notice if only one of them were changed.
 */
async function mountAndMeasure(page, element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(element)
  })

  const collapsed = {
    folderRows: findFolderRows(container, page, 'collapsed'),
    expandableRows: findExpandableRows(container, page, 'collapsed')
  }

  for (const row of collapsed.folderRows) {
    await act(async () => {
      row.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  const expanded = {
    folderRows: findFolderRows(container, page, 'expanded'),
    expandableRows: findExpandableRows(container, page, 'expanded')
  }

  return {
    container,
    root,
    collapsed,
    expanded,
    folderRows: [...collapsed.folderRows, ...expanded.folderRows],
    expandableRows: [...collapsed.expandableRows, ...expanded.expandableRows]
  }
}

async function unmount(measured) {
  await act(async () => {
    measured.root.unmount()
  })
  measured.container.remove()
}

// ===========================================================================
// Dashboard.jsx
// ===========================================================================

describe('Channel_Tree_Row contrast: Dashboard.jsx (Reqs 5, 6, 7)', () => {
  let measured

  beforeAll(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(console, 'error').mockImplementation(() => {})

    usersAPI.getMe.mockResolvedValue({
      data: { user: { ...USER, groups: DASHBOARD_GROUPS }, teams: [] }
    })
    channelsAPI.getDescriptions.mockResolvedValue({
      data: { channels: DASHBOARD_CHANNEL_DESCRIPTIONS }
    })
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    configAPI.getColorMappings.mockResolvedValue({
      data: { colorMappings: {}, roleDescriptions: {} }
    })
    configAPI.getPublic.mockResolvedValue({
      data: { channel_folder_separator: FOLDER_SEPARATOR }
    })
    // The device card is irrelevant here and its rows carry colours of their
    // own, so the probe reports the feature off and the card never mounts.
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false, devices: [] })

    measured = await mountAndMeasure(
      'Dashboard.jsx',
      <MemoryRouter>
        <Dashboard user={USER} />
      </MemoryRouter>
    )
  })

  afterAll(async () => {
    await unmount(measured)
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  // -------------------------------------------------------------------------
  // Anti-vacuity, mirroring `martiEndpointContract.test.js`'s guard. A test
  // that silently found no rows passes every inequality below while measuring
  // nothing at all.
  // -------------------------------------------------------------------------
  describe('found what it claims to measure', () => {
    it('found a Folder_Row, in both the collapsed and the expanded glyph', () => {
      expect(measured.collapsed.folderRows.length).toBeGreaterThan(0)
      expect(measured.expanded.folderRows.length).toBeGreaterThan(0)

      // The two snapshots are genuinely different states, not the same one
      // measured twice: the Disclosure_Chevron's `rotate-90` is the row's
      // expanded affordance.
      expect(measured.collapsed.folderRows.every((row) => !row.chevronRotated)).toBe(true)
      expect(measured.expanded.folderRows.every((row) => row.chevronRotated)).toBe(true)
    })

    it('found an Expandable_Channel_Row', () => {
      // This is the branch that only exists when a channel's `display_name`
      // matches a folder path -- see DASHBOARD_GROUPS.
      expect(measured.collapsed.expandableRows.length).toBeGreaterThan(0)
    })

    it('found a Disclosure_Chevron and a heading on every row it measured', () => {
      const rows = [...measured.folderRows, ...measured.expandableRows]
      expect(rows.length).toBeGreaterThan(0)

      for (const row of rows) {
        expect(row.chevron, `${row.kind} "${row.label}" has no chevron`).not.toBeNull()
        expect(row.heading, `${row.kind} "${row.label}" has no heading`).not.toBeNull()
      }
    })

    it('resolved a real background for every row', () => {
      for (const row of [...measured.folderRows, ...measured.expandableRows]) {
        for (const layer of LAYERS) {
          expect(row.background[layer], `${row.kind} "${row.label}" ${layer}`).toMatch(/^#/)
        }
      }
    })
  })

  // -------------------------------------------------------------------------
  // Criteria 5.1, 5.5: the Folder_Icon as a graphical object.
  // -------------------------------------------------------------------------
  describe('Folder_Icon against the Folder_Row background (Criteria 5.1, 5.5)', () => {
    for (const layer of LAYERS) {
      it(`clears 3:1 in ${LAYER_NAMES[layer]}`, () => {
        expectAtLeast(measured.folderRows, 'icon', layer, GRAPHICAL_OBJECT_MINIMUM)
      })
    }
  })

  // -------------------------------------------------------------------------
  // Criterion 5.7: the Disclosure_Chevron, in both row types. On the
  // Expandable_Channel_Row the hover background comes from the toggle button
  // rather than the row.
  // -------------------------------------------------------------------------
  describe('Disclosure_Chevron in a Folder_Row (Criterion 5.7)', () => {
    for (const layer of LAYERS) {
      it(`clears 3:1 in ${LAYER_NAMES[layer]}`, () => {
        expectAtLeast(measured.folderRows, 'chevron', layer, GRAPHICAL_OBJECT_MINIMUM)
      })
    }
  })

  describe('Disclosure_Chevron in an Expandable_Channel_Row (Criterion 5.7)', () => {
    for (const layer of LAYERS) {
      it(`clears 3:1 in ${LAYER_NAMES[layer]}`, () => {
        expectAtLeast(measured.expandableRows, 'chevron', layer, GRAPHICAL_OBJECT_MINIMUM)
      })
    }
  })

  // -------------------------------------------------------------------------
  // Criterion 6.6: row text against the row background.
  // -------------------------------------------------------------------------
  describe('Folder_Row heading text (Criterion 6.6)', () => {
    for (const layer of LAYERS) {
      it(`clears 4.5:1 in ${LAYER_NAMES[layer]}`, () => {
        expectAtLeast(measured.folderRows, 'heading', layer, TEXT_CONTRAST_MINIMUM)
      })
    }
  })

  describe('Expandable_Channel_Row heading and description text (Criterion 6.6)', () => {
    for (const layer of LAYERS) {
      it(`heading clears 4.5:1 in ${LAYER_NAMES[layer]}`, () => {
        expectAtLeast(measured.expandableRows, 'heading', layer, TEXT_CONTRAST_MINIMUM)
      })
    }

    for (const layer of LAYERS) {
      it(`description clears 4.5:1 in ${LAYER_NAMES[layer]}`, () => {
        expectAtLeast(measured.expandableRows, 'description', layer, TEXT_CONTRAST_MINIMUM)
      })
    }
  })

  it('renders no description text in a Folder_Row, so none is asserted there', () => {
    // The other half of the trap the Expandable_Channel_Row assertions above
    // rely on: a test that looked for a description on EVERY row would trip
    // its own anti-vacuity guard. Pinned so the asymmetry reads as measured
    // rather than forgotten.
    for (const row of measured.folderRows) {
      expect(row.description, `Folder_Row "${row.label}" grew a description`).toBeNull()
    }
  })

  // -------------------------------------------------------------------------
  // Criterion 6.4: the hover step, asserted RELATIONALLY.
  // -------------------------------------------------------------------------
  describe('the resting-to-hover background step stays perceivable (Criterion 6.4)', () => {
    it('is at least as large in dark mode as the light-mode step this app already ships', () => {
      // No invented threshold. The light-mode step IS the `gray-100` ->
      // `gray-200` hover this application already ships and users already
      // read as a hover, so it is the only defensible yardstick for the dark
      // one -- and it is read off the same element rather than restated.
      for (const row of measured.folderRows) {
        expect(
          row.step.dark,
          `${row.kind} "${row.label}": dark hover step ` +
            `${row.background.darkRest} -> ${row.background.darkHover} measures ` +
            `${row.step.dark.toFixed(2)}:1, less than the light-mode step ` +
            `${row.background.lightRest} -> ${row.background.lightHover} at ` +
            `${row.step.light.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(row.step.light)
      }
    })
  })
})

// ===========================================================================
// GlobalChannels.jsx
// ===========================================================================
//
// Criterion 7.6: both pages, not whichever one the test happened to import.
// The Folder_Row markup is duplicated verbatim across the two, so a
// half-applied change has to fail rather than pass.

describe('Channel_Tree_Row contrast: GlobalChannels.jsx (Reqs 5, 6, 7)', () => {
  let measured

  beforeAll(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(console, 'error').mockImplementation(() => {})

    configAPI.getPublic.mockResolvedValue({
      data: { channel_folder_separator: FOLDER_SEPARATOR }
    })
    globalChannelsAPI.getBchChannels.mockResolvedValue({ data: { channels: BCH_CHANNELS } })
    globalChannelsAPI.getRegionChannels.mockResolvedValue({
      data: { channels: REGION_CHANNELS }
    })

    // Not a global manager: the per-channel edit/delete/credentials buttons
    // stay unrendered, so nothing but the channel tree carries colour tokens.
    measured = await mountAndMeasure(
      'GlobalChannels.jsx',
      <GlobalChannels user={{ ...USER, is_global_manager: false }} />
    )
  })

  afterAll(async () => {
    await unmount(measured)
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  describe('found what it claims to measure', () => {
    it('found a Folder_Row, in both the collapsed and the expanded glyph', () => {
      expect(measured.collapsed.folderRows.length).toBeGreaterThan(0)
      expect(measured.expanded.folderRows.length).toBeGreaterThan(0)

      expect(measured.collapsed.folderRows.every((row) => !row.chevronRotated)).toBe(true)
      expect(measured.expanded.folderRows.every((row) => row.chevronRotated)).toBe(true)
    })

    it('found a Disclosure_Chevron and a heading on every Folder_Row', () => {
      for (const row of measured.folderRows) {
        expect(row.chevron, `Folder_Row "${row.label}" has no chevron`).not.toBeNull()
        expect(row.heading, `Folder_Row "${row.label}" has no heading`).not.toBeNull()
      }
    })

    it('found the folder rows in BOTH channel sections', () => {
      // The page renders one tree per section, from two separate fetches. A
      // fixture that only reached one of them would measure half the page.
      const labels = measured.collapsed.folderRows.map((row) => row.label)
      expect(labels).toContain('Ops')
      expect(labels).toContain('Region')
    })

    it('did not mistake the section-header icons or a plain channel row\'s RadioIcon for a Folder_Icon', () => {
      // `RadioIcon` heads both sections AND now sits on every channel row
      // too (the channel-icon addition), and none of those are the folder
      // GLYPH SHAPE the locator matches on -- so despite three RadioIcon
      // sites in the fixture (two headers, one channel row: 'Ops - Alpha'),
      // it still finds only the two real folders.
      expect(measured.collapsed.folderRows).toHaveLength(2)
    })
  })

  describe('Folder_Icon against the Folder_Row background (Criteria 5.1, 5.5)', () => {
    for (const layer of LAYERS) {
      it(`clears 3:1 in ${LAYER_NAMES[layer]}`, () => {
        expectAtLeast(measured.folderRows, 'icon', layer, GRAPHICAL_OBJECT_MINIMUM)
      })
    }
  })

  describe('Disclosure_Chevron in a Folder_Row (Criterion 5.7)', () => {
    for (const layer of LAYERS) {
      it(`clears 3:1 in ${LAYER_NAMES[layer]}`, () => {
        expectAtLeast(measured.folderRows, 'chevron', layer, GRAPHICAL_OBJECT_MINIMUM)
      })
    }
  })

  describe('Folder_Row heading text (Criterion 6.6)', () => {
    for (const layer of LAYERS) {
      it(`clears 4.5:1 in ${LAYER_NAMES[layer]}`, () => {
        expectAtLeast(measured.folderRows, 'heading', layer, TEXT_CONTRAST_MINIMUM)
      })
    }
  })

  it('renders no description text and no Expandable_Channel_Row', () => {
    // TRAP, and the reason the row-text assertions here name only the
    // heading: this page's Folder_Row renders a heading `<span>` and nothing
    // else, and it has no Expandable_Channel_Row at all. Asserted per page
    // rather than assumed shared with `Dashboard.jsx`.
    for (const row of measured.folderRows) {
      expect(row.description, `Folder_Row "${row.label}" grew a description`).toBeNull()
    }
    expect(measured.expandableRows).toHaveLength(0)
  })

  describe('the resting-to-hover background step stays perceivable (Criterion 6.4)', () => {
    it('is at least as large in dark mode as the light-mode step this app already ships', () => {
      for (const row of measured.folderRows) {
        expect(
          row.step.dark,
          `${row.kind} "${row.label}": dark hover step ` +
            `${row.background.darkRest} -> ${row.background.darkHover} measures ` +
            `${row.step.dark.toFixed(2)}:1, less than the light-mode step ` +
            `${row.background.lightRest} -> ${row.background.lightHover} at ` +
            `${row.step.light.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(row.step.light)
      }
    })
  })
})
