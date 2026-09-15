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

  it('shows Access Denied and never calls the API for a non-Global_Manager', async () => {
    await mount({ id: 2, is_global_manager: false })

    expect(container.textContent).toContain('Access Denied')
    expect(statisticsAPI.get).not.toHaveBeenCalled()
  })

  it('fetches the default 30-day window on mount for a Global_Manager', async () => {
    await mount(GLOBAL_MANAGER)

    expect(statisticsAPI.get).toHaveBeenCalledTimes(1)
    expect(statisticsAPI.get).toHaveBeenCalledWith(30)
  })

  it('renders both charts wired to the DAU and totals series', async () => {
    await mount(GLOBAL_MANAGER)

    const seriesKeys = Array.from(container.querySelectorAll('[data-series-key]')).map(
      (el) => el.getAttribute('data-series-key')
    )
    // DAU chart (2 series) + totals chart (4 series).
    expect(seriesKeys).toEqual(
      expect.arrayContaining([
        'dau_users', 'dau_team_devices',
        'total_users', 'total_teams', 'total_team_devices', 'total_channels'
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
