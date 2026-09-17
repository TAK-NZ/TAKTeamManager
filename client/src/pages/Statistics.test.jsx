import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import Statistics from './Statistics.jsx'
import { statisticsAPI } from '../services/api'

// This project has no `@testing-library/react`; mount with `react-dom/client`'s
// `createRoot` plus React 18's own `act` under jsdom, the pattern
// AuditLogs.test.jsx / TransferMemberDialog.test.jsx established.
//
// Two mocks: the network boundary (`../services/api`) and `recharts`.
// recharts' ResponsiveContainer measures its parent's size, which is 0 in
// jsdom, so the real charts render nothing useful and add heavy SVG/d3 work to
// every test. We stub the recharts surface the page imports with trivial
// stand-ins that just render their children / a marker, so the tests assert
// the PAGE's behaviour (auth guard, window-switch refetch, which series data
// reaches the chart), not recharts' own rendering.

vi.mock('../services/api', () => ({
  statisticsAPI: { get: vi.fn() }
}))

vi.mock('recharts', () => {
  // These are only CALLED at render time (well after `globalThis.React` is set
  // below), so referencing the global React here is safe and avoids a
  // `require`/import in the hoisted mock factory. A passthrough renders its
  // children; Line renders a marker carrying its series key so a test can
  // assert which series the page wired into each chart.
  const Passthrough = ({ children }) => globalThis.React.createElement('div', null, children)
  const Line = ({ dataKey, name }) =>
    globalThis.React.createElement('div', { 'data-series-key': dataKey, 'data-series-name': name })
  return {
    ResponsiveContainer: Passthrough,
    LineChart: Passthrough,
    Line,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null
  }
})

globalThis.React = React

const GLOBAL_MANAGER = { id: 1, is_global_manager: true }

const SERIES = [
  { day: '2026-03-10', dau_users: 5, dau_team_devices: 2, total_users: 100, total_teams: 12, total_team_devices: 7, total_channels: 42 },
  { day: '2026-03-11', dau_users: 6, dau_team_devices: 3, total_users: 101, total_teams: 12, total_team_devices: 7, total_channels: 43 }
]

describe('Statistics page', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    statisticsAPI.get.mockResolvedValue({ data: { window: 30, series: SERIES } })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => { root.unmount() })
      root = null
    }
    container.remove()
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => { root.render(<Statistics user={user} />) })
    await act(async () => { await Promise.resolve() })
  }

  it('is open to a plain (non-admin) authenticated user: fetches and renders, no Access-Denied', async () => {
    // The page is reachable by every authenticated user (aggregate counts
    // only); there is no client-side role gate and the server grants
    // statistics:read to all authenticated users.
    await mount({ id: 2, is_global_manager: false, isAdmin: false, isTeamAdmin: false })

    expect(container.textContent).not.toContain('Access Denied')
    expect(statisticsAPI.get).toHaveBeenCalledTimes(1)
    expect(statisticsAPI.get).toHaveBeenCalledWith(30)
    // Charts render for a plain user just as they do for an admin.
    expect(container.querySelectorAll('[data-series-key]').length).toBeGreaterThan(0)
  })

  it('fetches the default 30-day window on mount', async () => {
    await mount(GLOBAL_MANAGER)

    expect(statisticsAPI.get).toHaveBeenCalledTimes(1)
    expect(statisticsAPI.get).toHaveBeenCalledWith(30)
  })

  it('renders three dual-axis charts wired to all six series', async () => {
    await mount(GLOBAL_MANAGER)

    const seriesKeys = Array.from(container.querySelectorAll('[data-series-key]')).map(
      (el) => el.getAttribute('data-series-key')
    )
    // DAU (team devices + users) + Totals A (team devices + users) + Totals B
    // (teams + channels): all six series appear across the three charts.
    expect(seriesKeys).toEqual(
      expect.arrayContaining([
        'dau_users', 'dau_team_devices',
        'total_users', 'total_teams', 'total_team_devices', 'total_channels'
      ])
    )

    // Three dual-axis charts, each a <figure> whose aria-label states the
    // left/right axis assignment for screen readers (the accessible signal
    // that survives; the on-chart axis labels carry it visually).
    const figureLabels = Array.from(container.querySelectorAll('figure')).map(
      (el) => el.getAttribute('aria-label')
    )
    expect(figureLabels).toHaveLength(3)
    expect(figureLabels).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Team devices (left axis), Users (right axis)'),
        expect.stringContaining('Teams (left axis), Channels (right axis)')
      ])
    )
  })

  it('re-fetches with the chosen window when a window button is clicked', async () => {
    await mount(GLOBAL_MANAGER)
    expect(statisticsAPI.get).toHaveBeenLastCalledWith(30)

    const button365 = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === '365 days'
    )
    await act(async () => {
      button365.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => { await Promise.resolve() })

    expect(statisticsAPI.get).toHaveBeenLastCalledWith(365)
    // The active window button carries state in aria-pressed (not colour alone).
    expect(button365.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows an empty-state message when the series is empty', async () => {
    statisticsAPI.get.mockResolvedValue({ data: { window: 30, series: [] } })
    await mount(GLOBAL_MANAGER)

    expect(container.textContent).toContain('No statistics available')
  })

  it('surfaces a fetch error without crashing', async () => {
    statisticsAPI.get.mockRejectedValue(new Error('boom'))
    await mount(GLOBAL_MANAGER)

    expect(container.textContent).toContain('Failed to load statistics')
  })
})

// Auto-refresh on the shared visibility-paused 60s interval, matching the
// Dashboard/Admin cards. Fake timers so the interval and the "immediate
// refresh on becoming visible" transition are observable.
describe('Statistics auto-refresh (visibility-paused)', () => {
  let container
  let root
  let tabHidden

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    statisticsAPI.get.mockResolvedValue({ data: { window: 30, series: SERIES } })
    // Control document.hidden for the visibilitychange transitions.
    tabHidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => tabHidden })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => { root.unmount() })
      root = null
    }
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
  })

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => { root.render(<Statistics user={user} />) })
    await act(async () => { await Promise.resolve() })
  }

  const fireVisibilityChange = async (hidden) => {
    tabHidden = hidden
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
  }

  it('re-fetches on the 60s interval while the tab is visible', async () => {
    await mount(GLOBAL_MANAGER)
    expect(statisticsAPI.get).toHaveBeenCalledTimes(1) // first load

    await act(async () => {
      vi.advanceTimersByTime(60000)
      await Promise.resolve()
    })
    expect(statisticsAPI.get).toHaveBeenCalledTimes(2) // one interval tick
    // The auto-refresh keeps the currently-selected window.
    expect(statisticsAPI.get).toHaveBeenLastCalledWith(30)
  })

  it('pauses the interval while the tab is hidden and refreshes immediately when it becomes visible again', async () => {
    await mount(GLOBAL_MANAGER)
    expect(statisticsAPI.get).toHaveBeenCalledTimes(1)

    await fireVisibilityChange(true) // hidden -> interval cleared
    await act(async () => {
      vi.advanceTimersByTime(180000) // 3 intervals while hidden
      await Promise.resolve()
    })
    expect(statisticsAPI.get).toHaveBeenCalledTimes(1) // no fetch while hidden

    await fireVisibilityChange(false) // visible again -> immediate refresh
    expect(statisticsAPI.get).toHaveBeenCalledTimes(2)
  })

  it('a failed background refresh does NOT clear the charts or show an error (keeps last good data)', async () => {
    await mount(GLOBAL_MANAGER)
    // The charts rendered from the first (successful) load.
    expect(container.querySelectorAll('[data-series-key]').length).toBeGreaterThan(0)

    // Next (background) refresh fails.
    statisticsAPI.get.mockRejectedValue(new Error('transient'))
    await act(async () => {
      vi.advanceTimersByTime(60000)
      await Promise.resolve()
    })

    // Charts still present, no error surfaced -- a background failure never
    // blanks rendered data.
    expect(container.querySelectorAll('[data-series-key]').length).toBeGreaterThan(0)
    expect(container.textContent).not.toContain('Failed to load statistics')
  })

  it('clears the interval and the visibilitychange listener on unmount', async () => {
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    await mount(GLOBAL_MANAGER)

    await act(async () => { root.unmount() })
    root = null

    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    // No further fetches after unmount, on the interval or on a visibilitychange.
    const callsAtUnmount = statisticsAPI.get.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(120000)
      await Promise.resolve()
    })
    expect(statisticsAPI.get).toHaveBeenCalledTimes(callsAtUnmount)
  })
})
