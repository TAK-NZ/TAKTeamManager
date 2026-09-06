import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { TakGovBadge } from './StoreBadges.jsx'
import Downloads from '../pages/Downloads.jsx'
import { configAPI } from '../services/api'

// Downloads.jsx's mount effect calls configAPI.getPublic() directly to
// resolve the data-driven CloudTAK_Row (downloads-page-os-sections
// Requirement 4). Mocked here the same way `Downloads.test.jsx` already
// does, defaulted to "feature off" (`cloudtak_url: null`) -- this guard's
// own EXPECTED_HREFS below is deliberately scoped to the fixed,
// takserver-enrollment-era link set (Criterion 12.7) and was never meant
// to include the separately-gated CloudTAK_Row. Without this mock the
// effect fires a REAL, unmocked network request in jsdom; nothing here
// should depend on whether something happens to be listening on
// `localhost:3000` in the environment the suite runs in.
// Downloads.jsx also probes offlineMapsAPI.list() on mount for its Offline
// Maps card. This guard measures only the FIXED client-download link/marker
// set (Criterion 12.7), so the Offline Maps card must not render — a rejecting
// probe (the 404 the server gives when the feature is off) keeps it hidden,
// leaving the anchor set and marker count exactly what this guard expects. The
// download handler surfaces failures via react-hot-toast, mocked so a missing
// export isn't a load-time failure.
vi.mock('../services/api', () => ({
  configAPI: { getPublic: vi.fn().mockResolvedValue({ data: { cloudtak_url: null } }) },
  offlineMapsAPI: {
    list: vi.fn().mockRejectedValue(new Error('feature off')),
    getUrl: vi.fn(),
  },
}))

vi.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: vi.fn(), error: vi.fn() },
}))

// Validates: Requirements 12.3, 12.4, 12.5, 12.7, 12.8
//
// takserver-enrollment task 10.4 -- the structural guard for badge fidelity,
// named for what it guards: the TAK_Gov_Badge's exact geometry, its
// text-free label, and the Downloads_Page's exact link set and Recommended
// Option placement.
//
// `store_badges.ejs` (the Lambda partial `StoreBadges.jsx` copies from,
// per Criterion 12.3) declares itself the source of truth for the
// TAK_Gov_Badge and records two reasons that are load-bearing rather than
// stylistic:
//   - 135 x 40 / `viewBox="0 0 135 40"` -- the Downloads_Page CSS forces
//     every badge's rendered height to 40px, so a badge with a different
//     aspect ratio renders a different WIDTH and breaks grid alignment
//     against its neighbours (Criterion 12.3).
//   - The label is OUTLINED VECTOR PATHS, not a `<text>` element, so it
//     renders identically regardless of what fonts the client has
//     installed (Criterion 12.4). A later "tidy" that swapped the outlined
//     paths for a `<text>` element would look correct on the developer's
//     own machine and render differently -- or not at all -- on a client
//     missing the assumed font, which is exactly the failure mode this
//     test exists to catch before it ships.
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`), so both subjects
// are mounted with `react-dom/client`'s `createRoot` plus React 18's own
// `act`, following the pattern established by
// `src/components/DeviceTypeIcon.test.jsx` / `RevokeDeviceDialog.test.jsx`.
// Neither subject fetches or takes props, so nothing is mocked.

// Vitest compiles this JSX with esbuild's classic transform, and the
// component sources under test carry no `React` import of their own, so
// the classic transform needs one in scope.
globalThis.React = React

/**
 * The four link targets `store_badges.ejs` names, unchanged (Criterion 12.7),
 * plus the WinTAK route the downloads-page-os-sections spec (task 7.2)
 * added as the Windows_Section's sole Download_Route. The original four are
 * still checked for exact fidelity here -- this list just grows by one
 * rather than the assertion below becoming a subset check.
 */
const EXPECTED_HREFS = [
  'https://tak.gov/products/atak-civ',
  'https://apps.apple.com/in/app/tak-aware/id6738631659',
  'https://play.google.com/store/apps/details?id=com.atakmap.app.civ',
  'https://apps.apple.com/us/app/itak/id1561656396',
  'https://tak.gov/products/wintak-civ'
]

describe('storeBadgeFidelity guard: extraction sanity', () => {
  // Anti-vacuity, before the rule: a mount that silently produced no `<svg>`
  // or no `<a>` elements would pass every assertion below while measuring
  // nothing, the failure mode `dateFormatConsumers.test.js` guards against
  // with its own "walked and found" checks.
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
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

  it('mounted the TAK_Gov_Badge and found an <svg> element to inspect', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<TakGovBadge />)
    })
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
  })

  it('mounted the Downloads_Page and found at least four <a> elements', async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<Downloads />)
    })
    const anchors = container.querySelectorAll('a')
    expect(anchors.length).toBeGreaterThanOrEqual(4)
  })
})

describe('storeBadgeFidelity guard: TAK_Gov_Badge geometry (Criterion 12.3)', () => {
  let container
  let root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<TakGovBadge />)
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

  it('is exactly 135 wide, 40 tall, with viewBox "0 0 135 40"', () => {
    const svg = container.querySelector('svg')

    expect(svg.getAttribute('width')).toBe('135')
    expect(svg.getAttribute('height')).toBe('40')
    expect(svg.getAttribute('viewBox')).toBe('0 0 135 40')
  })
})

describe('storeBadgeFidelity guard: TAK_Gov_Badge label is not <text> (Criterion 12.4)', () => {
  let container
  let root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<TakGovBadge />)
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

  it('contains no <text> element anywhere in the badge', () => {
    const svg = container.querySelector('svg')

    expect(
      svg.querySelector('text'),
      'A <text> element appeared inside TakGovBadge. Its label must remain ' +
        'outlined vector paths (Criterion 12.4): TAK.gov publishes no badge ' +
        'of its own, and the outlined form renders identically regardless ' +
        'of the client\'s installed fonts. Re-outline the glyphs as path ' +
        'data instead of introducing a <text> element.'
    ).toBeNull()
  })

  it('carries its label via <path> elements instead', () => {
    // Positive control alongside the negative one above: the badge must
    // still draw SOMETHING for its label, so a guard that only checked for
    // the absence of <text> could not be satisfied by an empty badge.
    const svg = container.querySelector('svg')
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0)
  })
})

describe('storeBadgeFidelity guard: Downloads_Page link set (Criteria 12.7, 12.8)', () => {
  let container
  let root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    configAPI.getPublic.mockResolvedValue({ data: { cloudtak_url: null } })
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

  it('renders an anchor href SET equal to the four store_badges.ejs targets plus WinTAK, exactly', () => {
    const anchors = Array.from(container.querySelectorAll('a'))
    const hrefs = anchors.map((anchor) => anchor.getAttribute('href'))

    // Set equality, not a subset check: a fifth link or a dropped one is
    // drift either direction should fail this test, and it is written
    // against a SET (via sort) rather than the array's order, since the
    // page's row layout is not part of what Criterion 12.7 pins.
    expect([...hrefs].sort()).toEqual([...EXPECTED_HREFS].sort())
  })

  it('carries rel="noopener" on every one of those anchors', () => {
    const anchors = Array.from(container.querySelectorAll('a')).filter((anchor) =>
      EXPECTED_HREFS.includes(anchor.getAttribute('href'))
    )

    expect(anchors).toHaveLength(EXPECTED_HREFS.length)
    for (const anchor of anchors) {
      expect(
        anchor.getAttribute('rel'),
        `Anchor to ${anchor.getAttribute('href')} is missing rel="noopener" (Criterion 12.8).`
      ).toBe('noopener')
    }
  })
})

describe('storeBadgeFidelity guard: exactly two Recommended_Option_Markers (Criterion 12.5)', () => {
  let container
  let root

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    configAPI.getPublic.mockResolvedValue({ data: { cloudtak_url: null } })
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

  /**
   * `RecommendedOptionMarker`'s accessible name is real text in a
   * visually-hidden `<span className="sr-only">Recommended option</span>`
   * (Criterion 12.6, `StoreBadges.jsx`) -- not a `title` attribute, which
   * the client conventions forbid as a description mechanism. Counting that
   * text is therefore both the marker count and the accessible-name check
   * in one query.
   */
  const findMarkers = () =>
    Array.from(container.querySelectorAll('span.sr-only')).filter(
      (node) => node.textContent === 'Recommended option'
    )

  it('renders exactly two markers, not zero, one, three, or four', () => {
    const markers = findMarkers()
    expect(markers).toHaveLength(2)
  })

  it('places the two markers on ATAK-via-TAK.gov and TAK Aware, and neither other route', () => {
    // Route the marker to the row it sits in by walking up to the shared
    // grid cell, then read that cell's anchor `href` -- the four link
    // targets are pinned exactly by the "link set" describe block above,
    // and unlike the visible label/sublabel text (both ATAK routes read
    // "ATAK" once the "via TAK.gov" / "via Google Play" sublabels were
    // removed per the Downloads defect fixes), the href uniquely
    // identifies which of the four routes a cell is. This still anchors
    // the assertion to CONTENT rather than position, and would catch the
    // marker migrating to the wrong cell even if the DOM order happened to
    // stay 1st/2nd.
    const hrefsWithMarker = findMarkers().map((marker) => {
      const cell = marker.closest('.flex.flex-col')
      return cell ? cell.querySelector('a')?.getAttribute('href') : null
    })

    expect(hrefsWithMarker).toHaveLength(2)
    expect(hrefsWithMarker).toContain('https://tak.gov/products/atak-civ')
    expect(hrefsWithMarker).toContain('https://apps.apple.com/in/app/tak-aware/id6738631659')

    // And explicitly NOT on the two alternative routes.
    const allCells = Array.from(container.querySelectorAll('.flex.flex-col'))
    const googlePlayCell = allCells.find((cell) =>
      cell.querySelector('a')?.getAttribute('href') ===
      'https://play.google.com/store/apps/details?id=com.atakmap.app.civ'
    )
    const itakCell = allCells.find((cell) =>
      cell.querySelector('a')?.getAttribute('href') === 'https://apps.apple.com/us/app/itak/id1561656396'
    )

    expect(googlePlayCell?.querySelector('span.sr-only')).toBeNull()
    expect(itakCell?.querySelector('span.sr-only')).toBeNull()
  })
})
