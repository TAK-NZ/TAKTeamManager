import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import Downloads from './Downloads.jsx'
import Layout from '../components/Layout.jsx'
import { ThemeProvider } from '../contexts/ThemeContext.jsx'

// takserver-enrollment task 10.5 -- client example tests for the
// Downloads_Page and its reachability (Requirements 10.11, 12.1, 12.6, 12.9).
//
// `client/src/components/storeBadgeFidelity.test.jsx` (task 10.4) already
// covers the TAK_Gov_Badge's exact geometry/text-free label and the
// Downloads_Page's exact link SET and Recommended_Option_Marker COUNT and
// placement. This file deliberately does not repeat any of that. It covers
// three things that file does not:
//
//   1. that the 'Downloads' nav item and the `/downloads` route are reachable
//      by a signed-in user carrying NEITHER a team membership NOR an admin
//      role of any kind (Criterion 12.9) -- `Layout.jsx`'s `getNavigation`
//      places 'Downloads' in `baseNavigation`, before any role gate, so this
//      is checked directly against a plain user object rather than inferred;
//   2. that the Recommended_Option_Marker's accessible name is queryable AS
//      REAL TEXT in the accessibility tree, and specifically that no `title`
//      attribute carries it anywhere on the page (Criterion 12.6) -- `title`
//      is not disclosed on keyboard focus and screen-reader support for it
//      is inconsistent, which is why the client conventions forbid it as a
//      description mechanism;
//   3. the "both sides" half of the app-store badges' move off the
//      Enrollment_View (Criteria 12.1, 10.11): `EnrollmentView.test.jsx`
//      (task 9.9) already asserts the NEGATIVE side -- that the
//      Enrollment_View itself renders no badge markup. This file asserts
//      the POSITIVE control instead of duplicating that assertion: that
//      `Downloads.jsx` is in fact where the badge markup NOW lives, so the
//      move is a verified relocation rather than a deletion on one side that
//      merely looks like a move.
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

describe('Downloads reachability for a user with no team membership and no admin role (Criterion 12.9)', () => {
  let container
  let root
  let matchMediaStubbed = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
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
    await mount(<Downloads />)

    expect(container.textContent).toContain('Download a TAK Client')
    // Anti-vacuity: the page actually rendered download links, not an empty
    // shell.
    expect(container.querySelectorAll('a').length).toBeGreaterThan(0)
  })
})

describe("Recommended_Option_Marker's accessible name is queryable as text, not a title attribute (Criterion 12.6)", () => {
  let container
  let root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Downloads />)
    })
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
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<Downloads />)
    })
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

  it('renders all four Store_Badge link targets on the Downloads_Page', () => {
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    for (const href of [
      'https://tak.gov/products/atak-civ',
      'https://apps.apple.com/in/app/tak-aware/id6738631659',
      'https://play.google.com/store/apps/details?id=com.atakmap.app.civ',
      'https://apps.apple.com/us/app/itak/id1561656396',
    ]) {
      expect(hrefs).toContain(href)
    }
  })
})
