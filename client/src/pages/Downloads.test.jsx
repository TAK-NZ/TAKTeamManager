import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import Downloads from './Downloads.jsx'
import Layout from '../components/Layout.jsx'
import { ThemeProvider } from '../contexts/ThemeContext.jsx'
import { configAPI, offlineMapsAPI } from '../services/api'

// takserver-enrollment task 10.5 -- client example tests for the
// Downloads_Page and its reachability (Requirements 10.11, 12.1, 12.6, 12.9).
// Extended by downloads-page-os-sections task 7.4 for the per-OS
// restructuring (Requirements 1, 2, 3, 4, 7) -- three OS_Sections
// (Android: 2 routes, iOS: 2 routes, Windows: 1 route) plus the
// data-driven CloudTAK_Row.
//
// `client/src/components/storeBadgeFidelity.test.jsx` (task 10.4, a
// DIFFERENT, already-completed spec) already covers the TAK_Gov_Badge's
// exact geometry/text-free label and the Downloads_Page's exact link SET.
// This file deliberately does not repeat any of that.
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`), so every subject
// below is mounted with `react-dom/client`'s `createRoot` plus React 18's
// own `act`, following the pattern `src/pages/Requests.test.jsx` already
// uses for mounting `Layout.jsx` directly.

vi.mock('../services/api', () => ({
  // Layout.jsx imports both. `authAPI.logout` is exercised only by a click
  // this file never performs; `requestsAPI.getPending` is called from
  // Layout's mount effect ONLY for an admin/team-admin/global-manager user
  // (see `getNavigation`'s role gates) -- the plain user below is none of
  // those, so this mock is never actually invoked, but a named import of a
  // missing export from a mocked ES module is a load-time failure, so both
  // are present regardless.
  authAPI: { logout: vi.fn() },
  requestsAPI: { getPending: vi.fn().mockResolvedValue({ data: { requests: [] } }) },
  // Layout.jsx's own version-display mount effect calls this too.
  versionAPI: { get: vi.fn().mockResolvedValue({ data: { version: '2026.9.0' } }) },
  // Downloads.jsx's mount effect calls this directly. Defaulted to
  // "feature off" (`cloudtak_url: null`) so every test that does not care
  // about the CloudTAK_Row does not need its own mock setup, and so the
  // mount effect's `.then()` never rejects/throws for a missing
  // implementation. Tests that DO care override with
  // `mockResolvedValueOnce`/`mockRejectedValueOnce` before mounting --
  // consumed once, so they never leak into a later test.
  configAPI: { getPublic: vi.fn().mockResolvedValue({ data: { cloudtak_url: null } }) },
  // Downloads.jsx's Offline Maps card probes this on mount. Defaulted to
  // "feature off" (a rejected list, i.e. the 404 the server gives when the
  // router isn't mounted) so tests that don't care about offline maps get a
  // hidden card and need no setup. Tests that DO care override with
  // `mockResolvedValueOnce` before mounting.
  offlineMapsAPI: {
    list: vi.fn().mockRejectedValue(new Error('feature off')),
    getUrl: vi.fn(),
  },
}))

// Downloads.jsx's Offline Maps download handler surfaces failures via toast.
vi.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: vi.fn(), error: vi.fn() },
}))

// Vitest compiles this JSX with esbuild's classic transform, and the
// component sources under test carry no `React` import of their own, so the
// classic transform needs one in scope.
globalThis.React = React

/**
 * A signed-in user with NO team membership and NO admin role of any kind --
 * none of `isAdmin`, `isTeamAdmin`, or `is_global_manager` are present at
 * all, rather than merely `false`, so this also guards against an
 * implementation that gates on the KEY being present instead of its value
 * being truthy.
 */
const PLAIN_USER = { userId: 99, first_name: 'Jamie', last_name: 'Doe' }

/**
 * Locates one of the three OsSection roots by its visible header label
 * ('Android', 'iOS', 'Windows'), scoped to the 3-column grid rather than
 * the whole page -- so a query cannot accidentally match the CloudTAK_Row
 * or the footnote legend, neither of which carries an `<h2>`.
 */
function getOsSection(container, osLabel) {
  const grid = container.querySelector('.card > div.grid')
  const sections = Array.from(grid?.children ?? [])
  return sections.find((section) => section.querySelector('h2')?.textContent.trim() === osLabel)
}

/**
 * Each OsSection's routes list is the section's second child; each route's
 * own cell is one child of that list, containing the label/marker div and
 * the badge anchor. Returned in render order, matching each OS array's
 * declared route order.
 */
function getRouteCells(section) {
  return Array.from(section.children[1]?.children ?? [])
}

function cellHref(cell) {
  return cell.querySelector('a')?.getAttribute('href')
}

function cellHasMarker(cell) {
  return cell.querySelector('.recommended-marker') !== null
}

/**
 * Await one extra microtask turn inside `act` so `configAPI.getPublic()`'s
 * `.then()`/`.catch()` resolves and its state update (and the resulting
 * re-render) lands before assertions run -- `root.render()` itself does not
 * await the mount effect's own fetch promise. Mirrors the two-`Promise
 * .resolve()` flush `EnrollmentView.test.jsx` already uses for its own
 * mount-effect fetches.
 */
async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Downloads reachability for a user with no team membership and no admin role (Criterion 12.9)', () => {
  let container
  let root
  let matchMediaStubbed = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    configAPI.getPublic.mockResolvedValue({ data: { cloudtak_url: null } })
    // Offline maps default OFF (probe rejects) for these blocks; the tests
    // here concern the client-download grid + CloudTAK row, not offline maps.
    // Re-set here because vi.clearAllMocks() wipes the factory implementation.
    offlineMapsAPI.list.mockRejectedValue(new Error('feature off'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    // jsdom implements no `window.matchMedia`; `ThemeProvider` reads it to
    // pick the initial theme when mounting the real `Layout`.
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      })
      matchMediaStubbed = true
    }
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    if (matchMediaStubbed) {
      delete window.matchMedia
      matchMediaStubbed = false
    }
    localStorage.removeItem('theme')
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (element) => {
    root = createRoot(container)
    await act(async () => {
      root.render(element)
    })
  }

  it("renders the 'Downloads' nav item pointing at /downloads for a plain, non-admin, team-less user", async () => {
    await mount(
      <MemoryRouter initialEntries={['/dashboard']}>
        <ThemeProvider>
          <Layout user={PLAIN_USER}>
            <div />
          </Layout>
        </ThemeProvider>
      </MemoryRouter>
    )

    // Layout renders the sidebar navigation twice (mobile + desktop), so at
    // least one -- not necessarily exactly one -- copy is expected.
    const downloadsLinks = Array.from(container.querySelectorAll('a')).filter(
      (a) => a.textContent.trim() === 'Downloads'
    )
    expect(downloadsLinks.length).toBeGreaterThan(0)
    for (const link of downloadsLinks) {
      expect(link.getAttribute('href')).toBe('/downloads')
    }

    // Confirms this user is genuinely the "plain" case the criterion
    // describes, not one that happens to qualify for a role-gated item too:
    // none of the admin-only nav items should be present.
    expect(container.textContent).not.toContain('Users')
    expect(container.textContent).not.toContain('Admin')
    expect(container.textContent).not.toContain('Global Channels')
  })

  it('mounts the /downloads route element (Downloads.jsx) directly and renders its content', async () => {
    // The Downloads_Page itself takes no user prop and performs no
    // authorization check of its own -- its reachability is a client
    // routing fact, not an authorization one (design.md, "The
    // Downloads_Page"). Mounting it standalone, with no user context at
    // all, is therefore a faithful check of what the `/downloads` route
    // renders for the plain user above.
    // Offline maps ON for this test: the probe resolves with a maps list, so
    // the Offline Maps card renders. (Default mock has it rejecting = hidden.)
    offlineMapsAPI.list.mockResolvedValueOnce({
      data: {
        maps: [
          { id: 'regional-otago', group: 'south-island', category: 'regional', label: 'Otago', apps: ['atak', 'takaware'], sizeBytes: 694591488, available: true },
        ],
      },
    })

    await mount(<Downloads />)
    await flushEffects()

    // H1 is now the broader "Downloads" (the page covers both client
    // downloads and offline maps since the offline-maps section was added),
    // not the old client-only "Download a TAK Client" heading.
    expect(container.textContent).toContain('Downloads')
    // The Offline Maps section renders when the probe returns a list.
    expect(container.textContent).toContain('Offline Maps')
    expect(container.textContent).toContain('Otago')
    // Anti-vacuity: the page actually rendered download links, not an empty
    // shell.
    expect(container.querySelectorAll('a').length).toBeGreaterThan(0)
  })

  it('hides the Offline Maps card entirely when the feature probe fails (feature off / not permitted)', async () => {
    // Default mock: offlineMapsAPI.list rejects. The card must not render —
    // no heading, no empty state, no spinner (fail-closed like the CloudTAK row).
    offlineMapsAPI.list.mockRejectedValueOnce(new Error('feature off'))

    await mount(<Downloads />)
    await flushEffects()

    // Client-download content still renders...
    expect(container.textContent).toContain('Downloads')
    // ...but the Offline Maps card is absent.
    expect(container.textContent).not.toContain('Offline Maps')
  })
})

describe("Recommended_Option_Marker's accessible name is queryable as text, not a title attribute (Criterion 12.6)", () => {
  let container
  let root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    configAPI.getPublic.mockResolvedValue({ data: { cloudtak_url: null } })
    // Offline maps default OFF (probe rejects) for these blocks; the tests
    // here concern the client-download grid + CloudTAK row, not offline maps.
    // Re-set here because vi.clearAllMocks() wipes the factory implementation.
    offlineMapsAPI.list.mockRejectedValue(new Error('feature off'))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Downloads />)
    })
    await flushEffects()
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('exposes "Recommended option" as real, queryable text content', () => {
    const markers = Array.from(container.querySelectorAll('span.sr-only')).filter(
      (node) => node.textContent === 'Recommended option'
    )

    // Anti-vacuity before asserting anything further.
    expect(markers.length).toBeGreaterThan(0)
    for (const marker of markers) {
      // Queryable as TEXT: `textContent` carries the accessible name, not an
      // attribute a DOM query has to know to look for by name.
      expect(marker.textContent.trim()).toBe('Recommended option')
    }
  })

  it('carries the accessible name via NO `title` attribute anywhere on the page', () => {
    // The source partial (`store_badges.ejs`) uses `title="Recommended
    // option"`; `StoreBadges.jsx`'s `RecommendedOptionMarker` deliberately
    // does not copy that attribute, because `title` is not disclosed on
    // keyboard focus and screen-reader support for it is inconsistent. This
    // asserts the divergence directly, rather than only asserting the
    // replacement exists.
    expect(container.querySelector('[title="Recommended option"]')).toBeNull()

    // Broader sweep: no element on the whole page carries a `title`
    // attribute at all, so a future regression could not reintroduce the
    // marker's name under a differently-worded `title` either.
    const anyTitleAttr = Array.from(container.querySelectorAll('*')).some((el) =>
      el.hasAttribute('title')
    )
    expect(anyTitleAttr).toBe(false)
  })
})

describe('The app-store badges live on Downloads.jsx (positive control, Criteria 12.1, 10.11)', () => {
  // The move of the badges OFF the Enrollment_View is asserted from both
  // sides, per the task. `EnrollmentView.test.jsx`'s "renders no app-store
  // badge markup" test is the NEGATIVE side, already in place (task 9.9).
  // This is the POSITIVE side: confirming the badge markup that left the
  // Enrollment_View actually landed here, rather than having been deleted
  // outright.
  let container
  let root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    configAPI.getPublic.mockResolvedValue({ data: { cloudtak_url: null } })
    // Offline maps default OFF (probe rejects) for these blocks; the tests
    // here concern the client-download grid + CloudTAK row, not offline maps.
    // Re-set here because vi.clearAllMocks() wipes the factory implementation.
    offlineMapsAPI.list.mockRejectedValue(new Error('feature off'))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Downloads />)
    })
    await flushEffects()
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('renders the TAK_Gov_Badge (its signature 135x40 viewBox) on the Downloads_Page', () => {
    expect(container.innerHTML).toContain('0 0 135 40')
  })

  it('renders all four original Store_Badge link targets plus the new WinTAK route on the Downloads_Page', () => {
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    for (const href of [
      'https://tak.gov/products/atak-civ',
      'https://apps.apple.com/in/app/tak-aware/id6738631659',
      'https://play.google.com/store/apps/details?id=com.atakmap.app.civ',
      'https://apps.apple.com/us/app/itak/id1561656396',
      'https://tak.gov/products/wintak-civ',
    ]) {
      expect(hrefs).toContain(href)
    }
  })
})

describe('Downloads_Page OS_Section content and structure (downloads-page-os-sections Requirements 1, 2, 3)', () => {
  let container
  let root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    configAPI.getPublic.mockResolvedValue({ data: { cloudtak_url: null } })
    // Offline maps default OFF (probe rejects) for these blocks; the tests
    // here concern the client-download grid + CloudTAK row, not offline maps.
    // Re-set here because vi.clearAllMocks() wipes the factory implementation.
    offlineMapsAPI.list.mockRejectedValue(new Error('feature off'))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Downloads />)
    })
    await flushEffects()
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  it('renders exactly three OS_Sections: Android, iOS, Windows', () => {
    const grid = container.querySelector('.card > div.grid')
    expect(grid).not.toBeNull()
    const labels = Array.from(grid.children)
      .map((section) => section.querySelector('h2')?.textContent.trim())
      .filter(Boolean)
    expect(labels).toEqual(['Android', 'iOS', 'Windows'])
  })

  it('Android_Section contains exactly its two routes, with the Recommended_Option_Marker only on ATAK-via-TAK.gov (Criteria 1.1, 1.2, 1.3)', () => {
    const section = getOsSection(container, 'Android')
    expect(section).toBeTruthy()
    const cells = getRouteCells(section)
    expect(cells).toHaveLength(2)

    const takGovCell = cells.find((c) => cellHref(c) === 'https://tak.gov/products/atak-civ')
    const googlePlayCell = cells.find(
      (c) =>
        cellHref(c) === 'https://play.google.com/store/apps/details?id=com.atakmap.app.civ'
    )
    expect(takGovCell).toBeTruthy()
    expect(googlePlayCell).toBeTruthy()
    expect(cellHasMarker(takGovCell)).toBe(true)
    expect(cellHasMarker(googlePlayCell)).toBe(false)
  })

  it('iOS_Section contains exactly its two routes, with the Recommended_Option_Marker only on TAK Aware (Criteria 2.1, 2.2, 2.3)', () => {
    const section = getOsSection(container, 'iOS')
    expect(section).toBeTruthy()
    const cells = getRouteCells(section)
    expect(cells).toHaveLength(2)

    const takAwareCell = cells.find(
      (c) => cellHref(c) === 'https://apps.apple.com/in/app/tak-aware/id6738631659'
    )
    const iTakCell = cells.find(
      (c) => cellHref(c) === 'https://apps.apple.com/us/app/itak/id1561656396'
    )
    expect(takAwareCell).toBeTruthy()
    expect(iTakCell).toBeTruthy()
    expect(cellHasMarker(takAwareCell)).toBe(true)
    expect(cellHasMarker(iTakCell)).toBe(false)
  })

  it('Windows_Section contains exactly one route (WinTAK), with no Recommended_Option_Marker (Criteria 3.1, 3.4)', () => {
    const section = getOsSection(container, 'Windows')
    expect(section).toBeTruthy()
    const cells = getRouteCells(section)
    expect(cells).toHaveLength(1)
    expect(cellHref(cells[0])).toBe('https://tak.gov/products/wintak-civ')
    expect(cellHasMarker(cells[0])).toBe(false)
  })

  it("the WinTAK anchor carries a distinct aria-label from the ATAK-via-TAK.gov anchor (Criteria 3.6, 3.7)", () => {
    const winTakAnchor = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === 'https://tak.gov/products/wintak-civ'
    )
    const atakTakGovAnchor = Array.from(container.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === 'https://tak.gov/products/atak-civ'
    )

    expect(winTakAnchor).toBeTruthy()
    expect(atakTakGovAnchor).toBeTruthy()

    // The WinTAK anchor carries its own accessible-name override, read
    // directly via getAttribute (jsdom does not compute full
    // accessible-name resolution).
    expect(winTakAnchor.getAttribute('aria-label')).toBe('Get it from TAK.gov — WinTAK')

    // The ATAK-via-TAK.gov anchor carries NO aria-label of its own -- its
    // accessible name comes from its child SVG's own role="img"/aria-label,
    // which this anchor must not shadow. Asserted by absence, so the two
    // anchors are shown distinguishable rather than merely both present.
    expect(atakTakGovAnchor.getAttribute('aria-label')).toBeNull()
  })
})

describe('Downloads_Page CloudTAK_Row (downloads-page-os-sections Requirement 4)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Offline maps default OFF: the mount effect also probes offlineMapsAPI.list;
    // an earlier block's vi.clearAllMocks() wiped the factory implementation, so
    // restore a rejecting default here (these tests concern the CloudTAK row).
    offlineMapsAPI.list.mockRejectedValue(new Error('feature off'))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mountDownloads = async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<Downloads />)
    })
    await flushEffects()
  }

  it('renders exactly one CloudTAK_Row with the resolved href and visible text naming Android, iOS, Windows, and other operating systems when cloudtak_url resolves non-null (Criterion 4.1-4.3, 4.5)', async () => {
    configAPI.getPublic.mockResolvedValueOnce({
      data: { cloudtak_url: 'https://cloudtak.example.com' },
    })

    await mountDownloads()

    const cloudTakAnchors = Array.from(container.querySelectorAll('a')).filter(
      (a) => a.getAttribute('href') === 'https://cloudtak.example.com'
    )
    expect(cloudTakAnchors).toHaveLength(1)

    // Exactly one CloudTAK_Row, not duplicated within any OS_Section: only
    // one "CloudTAK" heading-style label on the whole page.
    const cloudTakLabels = Array.from(container.querySelectorAll('span')).filter(
      (el) => el.textContent.trim() === 'CloudTAK'
    )
    expect(cloudTakLabels).toHaveLength(1)

    // rel="noopener" (Criterion 7.1) and no Recommended_Option_Marker
    // (Criterion 4.4) on the CloudTAK_Row's own anchor.
    expect(cloudTakAnchors[0].getAttribute('rel')).toBe('noopener')
    const row = cloudTakAnchors[0].closest('div')
    expect(row.querySelector('.recommended-marker')).toBeNull()

    // Visible (non-sr-only) text naming all three OS_Sections plus other
    // browser-capable operating systems.
    const rowText = row.parentElement.textContent
    expect(rowText).toContain('Android')
    expect(rowText).toContain('iOS')
    expect(rowText).toContain('Windows')
    expect(rowText.toLowerCase()).toMatch(/other operating system/)
  })

  it('renders NO CloudTAK_Row when cloudtak_url resolves null (Criterion 4.6)', async () => {
    configAPI.getPublic.mockResolvedValueOnce({ data: { cloudtak_url: null } })

    await mountDownloads()

    const cloudTakLabels = Array.from(container.querySelectorAll('span')).filter(
      (el) => el.textContent.trim() === 'CloudTAK'
    )
    expect(cloudTakLabels).toHaveLength(0)
    // Only the five OS_Section route anchors are present -- no sixth,
    // CloudTAK-only anchor.
    expect(container.querySelectorAll('a')).toHaveLength(5)
  })

  it('renders NO CloudTAK_Row when configAPI.getPublic rejects (fail-closed on network failure)', async () => {
    configAPI.getPublic.mockRejectedValueOnce(new Error('network down'))

    await mountDownloads()

    const cloudTakLabels = Array.from(container.querySelectorAll('span')).filter(
      (el) => el.textContent.trim() === 'CloudTAK'
    )
    expect(cloudTakLabels).toHaveLength(0)
    expect(container.querySelectorAll('a')).toHaveLength(5)
  })
})

describe('Downloads_Page cross-cutting behavior preserved after restructuring (Requirement 7)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    // Offline maps default OFF: the mount effect probes offlineMapsAPI.list;
    // restore a rejecting default (an earlier block's clearAllMocks wiped it).
    offlineMapsAPI.list.mockRejectedValue(new Error('feature off'))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    container.remove()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mountDownloads = async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<Downloads />)
    })
    await flushEffects()
  }

  it('sets rel="noopener" on every external anchor, across all three sections and the CloudTAK_Row, when the CloudTAK_Row is present (Criterion 7.1)', async () => {
    configAPI.getPublic.mockResolvedValueOnce({
      data: { cloudtak_url: 'https://cloudtak.example.com' },
    })
    await mountDownloads()

    const anchors = Array.from(container.querySelectorAll('a'))
    expect(anchors.length).toBeGreaterThan(0)
    for (const anchor of anchors) {
      expect(anchor.getAttribute('rel')).toBe('noopener')
    }
  })

  it('sets rel="noopener" on every external anchor when the CloudTAK_Row is absent (Criterion 7.1)', async () => {
    configAPI.getPublic.mockResolvedValueOnce({ data: { cloudtak_url: null } })
    await mountDownloads()

    const anchors = Array.from(container.querySelectorAll('a'))
    expect(anchors.length).toBeGreaterThan(0)
    for (const anchor of anchors) {
      expect(anchor.getAttribute('rel')).toBe('noopener')
    }
  })

  it.each([
    ['with the CloudTAK_Row present', { cloudtak_url: 'https://cloudtak.example.com' }],
    ['with the CloudTAK_Row absent', { cloudtak_url: null }],
  ])(
    'renders the footnote legend exactly once, at the page level, %s (Criterion 7.2)',
    async (_label, data) => {
      configAPI.getPublic.mockResolvedValueOnce({ data })
      await mountDownloads()

      // Two per-badge sr-only "Recommended option" spans (Android + iOS),
      // plus the footnote's own always-visible occurrence -- exactly
      // three total, regardless of the CloudTAK_Row's presence, and the
      // footnote itself renders exactly once (not duplicated per
      // OS_Section).
      const allOccurrences = Array.from(container.querySelectorAll('*')).filter(
        (el) => el.textContent.trim() === 'Recommended option' && el.children.length === 0
      )
      expect(allOccurrences).toHaveLength(3)

      const footnoteGlyphs = container.querySelectorAll('p > svg[aria-hidden="true"]')
      expect(footnoteGlyphs).toHaveLength(1)
    }
  )

  it('renders every one of the five badge SVGs at the same visible size (Criterion 7.3)', async () => {
    configAPI.getPublic.mockResolvedValueOnce({ data: { cloudtak_url: null } })
    await mountDownloads()

    const badgeSvgs = Array.from(container.querySelectorAll('a svg'))
    expect(badgeSvgs).toHaveLength(5)

    // "Same visible size" is enforced through a shared className rather
    // than a computed layout measurement (jsdom performs no real layout),
    // so the guard is that every badge SVG carries the identical sizing
    // class list -- which is what makes the Google Play badge's larger
    // intrinsic viewBox (180 x 53.333, against 135 x 40 for the others)
    // render no bigger than its neighbours.
    const classLists = badgeSvgs.map((svg) => svg.getAttribute('class'))
    expect(new Set(classLists).size).toBe(1)
    expect(classLists[0]).toBeTruthy()
  })

  it('renders no "via <store>" sublabel text anywhere on the page', async () => {
    configAPI.getPublic.mockResolvedValueOnce({ data: { cloudtak_url: null } })
    await mountDownloads()

    expect(container.textContent).not.toContain('via TAK.gov')
    expect(container.textContent).not.toContain('via Apple App Store')
    expect(container.textContent).not.toContain('via Google Play')
  })

  it('labels the Google Play route "ATAK", never "ATAK Civ", within the Android_Section', async () => {
    configAPI.getPublic.mockResolvedValueOnce({ data: { cloudtak_url: null } })
    await mountDownloads()

    expect(container.textContent).not.toContain('ATAK Civ')

    const section = getOsSection(container, 'Android')
    const cells = getRouteCells(section)
    const googlePlayCell = cells.find(
      (c) =>
        cellHref(c) === 'https://play.google.com/store/apps/details?id=com.atakmap.app.civ'
    )
    expect(googlePlayCell).toBeTruthy()
    expect(
      googlePlayCell.querySelector('span.text-sm.font-medium')?.textContent.trim()
    ).toBe('ATAK')
  })

  it("discloses each Recommended_Option_Marker's tooltip on pointer hover and on keyboard focus", async () => {
    configAPI.getPublic.mockResolvedValueOnce({ data: { cloudtak_url: null } })
    await mountDownloads()

    const markerHosts = Array.from(container.querySelectorAll('span.recommended-marker'))
    expect(markerHosts).toHaveLength(2)

    for (const host of markerHosts) {
      expect(host.getAttribute('tabindex')).toBe('0')

      const tooltip = host.querySelector('span[aria-hidden="true"]')
      expect(tooltip).not.toBeNull()
      expect(tooltip.textContent.trim()).toBe('Recommended option')
      expect(tooltip.className).toContain('opacity-0')
      expect(tooltip.className).toContain('group-hover:opacity-100')
      expect(tooltip.className).toContain('group-focus-within:opacity-100')
    }
  })
})
