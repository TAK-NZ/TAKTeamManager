import { useState, useEffect, useCallback } from 'react'
import { ChartBarIcon } from '@heroicons/react/24/outline'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { statisticsAPI } from '../services/api'
import { startVisibilityPausedRefresh } from '../utils/visibilityPausedRefresh'

/**
 * Global_Manager-only Statistics page: time-series charts of daily active
 * users/team-devices (distinct connections to the TAK Server) and the daily
 * snapshot of the four /admin totals, over a selectable window.
 *
 * Mirrors AuditLogs.jsx's shape: the `isGlobalManager` guard is computed
 * FIRST and every fetch effect is gated on it, with an Access-Denied early
 * return before the fetch effect, so a non-Global_Manager never triggers a
 * request (the API is the real gate; this is client-side belt-and-braces).
 *
 * @param {{ user: { is_global_manager?: boolean } }} props
 */

// The selectable window sizes (days) the server allows. Kept in sync with the
// route's ALLOWED_WINDOWS; an out-of-list value 400s server-side.
const WINDOW_OPTIONS = [8, 30, 90, 365]

// Series metadata: the key on each data row, the human label (also the
// accessible name, since recharts renders SVG and colour alone must never
// carry meaning), and a distinct stroke colour. Each chart pairs a LEFT-axis
// series with a RIGHT-axis series so two magnitudes that differ by an order
// of magnitude (e.g. a handful of team devices vs hundreds of users) each get
// a readable scale, instead of the smaller one being flattened against a
// shared axis. Series -> side is kept CONSISTENT across charts (team devices
// always left, users always right) so a viewer does not re-learn the axes per
// chart.
const DAU_LEFT = { key: 'dau_team_devices', label: 'Team devices', color: '#059669' }
const DAU_RIGHT = { key: 'dau_users', label: 'Users', color: '#2563eb' }

const TOTAL_DEVICES_LEFT = { key: 'total_team_devices', label: 'Team devices', color: '#059669' }
const TOTAL_USERS_RIGHT = { key: 'total_users', label: 'Users', color: '#2563eb' }

const TOTAL_TEAMS_LEFT = { key: 'total_teams', label: 'Teams', color: '#7c3aed' }
const TOTAL_CHANNELS_RIGHT = { key: 'total_channels', label: 'Channels', color: '#d97706' }

/**
 * A dual-Y-axis line chart: one series on the LEFT axis, one on the RIGHT,
 * each on its own independent scale. This is used deliberately for two series
 * whose magnitudes differ a lot, so neither is flattened.
 *
 * Reading a dual-axis chart is easy to get wrong (two lines "crossing" means
 * nothing when they are on different scales), so each axis is LABELLED with
 * its series name and colour-matched to its line -- but the meaning never
 * rests on colour: the legend names both series, each axis carries its
 * series name as text, and the tooltip shows both real values. `yAxisId`
 * binds each line to its own axis. `connectNulls={false}` so a day with no
 * snapshot renders as a gap, not a misleading straight line (a missing point
 * is not zero).
 */
function DualAxisChart({ title, description, data, left, right }) {
  return (
    <figure className="card" aria-label={`${title}: ${left.label} (left axis), ${right.label} (right axis)`}>
      <figcaption>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {description ? (
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{description}</p>
        ) : null}
        {/* The axis assignment stated in TEXT, so which series is on which
            scale never depends on reading colour off the chart. */}
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          Left axis: {left.label}. Right axis: {right.label}. Each has its own scale.
        </p>
      </figcaption>
      <div className="mt-4" style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#9ca3af" strokeOpacity={0.3} />
            <XAxis dataKey="day" tick={{ fontSize: 12 }} minTickGap={24} />
            <YAxis
              yAxisId="left"
              orientation="left"
              allowDecimals={false}
              tick={{ fontSize: 12 }}
              width={44}
              stroke={left.color}
              label={{ value: left.label, angle: -90, position: 'insideLeft', style: { fontSize: 12, fill: left.color } }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              allowDecimals={false}
              tick={{ fontSize: 12 }}
              width={44}
              stroke={right.color}
              label={{ value: right.label, angle: 90, position: 'insideRight', style: { fontSize: 12, fill: right.color } }}
            />
            <Tooltip />
            <Legend />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey={left.key}
              name={`${left.label} (left)`}
              stroke={left.color}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey={right.key}
              name={`${right.label} (right)`}
              stroke={right.color}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  )
}

export default function Statistics({ user }) {
  // Belt-and-braces auth guard, computed before any fetch state/effect (same
  // discipline as AuditLogs.jsx). The server enforces statistics:read.
  const isGlobalManager = Boolean(user?.is_global_manager)

  const [windowDays, setWindowDays] = useState(30)
  const [series, setSeries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // One fetcher for the current window, stable per (isGlobalManager, window).
  // `showLoading` is true for a foreground fetch (first load / window change),
  // which shows the spinner and surfaces a load error; false for a background
  // auto-refresh, which must NOT blank the charts, re-raise the spinner, or
  // replace the rendered series with an error -- the client convention that a
  // failed background refresh never clears rendered data. A background refresh
  // failure is only logged; the last good series stays on screen.
  const fetchStatistics = useCallback(async ({ showLoading } = { showLoading: true }) => {
    if (!isGlobalManager) {
      return
    }
    if (showLoading) {
      setLoading(true)
      setError(null)
    }
    try {
      const response = await statisticsAPI.get(windowDays)
      setSeries(response.data?.series || [])
      if (showLoading) {
        setError(null)
      }
    } catch (err) {
      console.error('Failed to fetch statistics:', err)
      if (showLoading) {
        setError(`Failed to load statistics: ${err.message}`)
      }
    } finally {
      if (showLoading) {
        setLoading(false)
      }
    }
  }, [isGlobalManager, windowDays])

  // First load and every window change: a foreground fetch (spinner + error).
  useEffect(() => {
    fetchStatistics({ showLoading: true })
  }, [fetchStatistics])

  // Keep the charts current on the shared visibility-paused 60s interval (the
  // same mechanism the Dashboard/Admin cards use). Separate from the
  // first-load effect above so mounting still performs exactly one fetch --
  // startVisibilityPausedRefresh only SCHEDULES subsequent refreshes. These
  // are BACKGROUND refreshes (no spinner, no chart-clearing on failure).
  // Re-subscribed when the fetcher identity changes (i.e. the window changes),
  // so the interval always refreshes the currently-selected window.
  useEffect(() => {
    if (!isGlobalManager) {
      return undefined
    }
    return startVisibilityPausedRefresh(() => {
      fetchStatistics({ showLoading: false })
    })
  }, [isGlobalManager, fetchStatistics])

  if (!isGlobalManager) {
    return (
      <div className="text-center py-12">
        <ChartBarIcon className="mx-auto h-12 w-12 text-gray-400" />
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">Access Denied</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          You need global admin privileges to access this page.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Statistics</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Daily active users and team devices connecting to the TAK Server, and totals over time.
          </p>
        </div>

        {/* Window selector. A button group rather than a <select>: it is a
            small fixed set and reads as the primary control on the page. The
            active button is carried in TEXT (aria-pressed) as well as styling,
            never colour alone. */}
        <div
          className="inline-flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden"
          role="group"
          aria-label="Time window"
        >
          {WINDOW_OPTIONS.map((days) => (
            <button
              key={days}
              type="button"
              aria-pressed={windowDays === days}
              onClick={() => setWindowDays(days)}
              className={`px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                windowDays === days
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {days} days
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="card">
          <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>
        </div>
      ) : loading ? (
        <div className="card">
          <p className="text-gray-500 dark:text-gray-400">Loading statistics...</p>
        </div>
      ) : series.length === 0 ? (
        <div className="card">
          <p className="text-gray-500 dark:text-gray-400">No statistics available for this window yet.</p>
        </div>
      ) : (
        <>
          <DualAxisChart
            title="Daily active (TAK Server connections)"
            description="Distinct users and team devices that connected to the TAK Server each day."
            data={series}
            left={DAU_LEFT}
            right={DAU_RIGHT}
          />
          <DualAxisChart
            title="Total users and team devices over time"
            description="Daily snapshot. Days before capture began may be approximate or absent."
            data={series}
            left={TOTAL_DEVICES_LEFT}
            right={TOTAL_USERS_RIGHT}
          />
          <DualAxisChart
            title="Total teams and channels over time"
            description="Daily snapshot. Days before capture began may be approximate or absent."
            data={series}
            left={TOTAL_TEAMS_LEFT}
            right={TOTAL_CHANNELS_RIGHT}
          />
        </>
      )}
    </div>
  )
}
