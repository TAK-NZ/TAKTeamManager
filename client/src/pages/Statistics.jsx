import { useState, useEffect } from 'react'
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
// carry meaning), and a distinct stroke colour. Split into the two charts.
const DAU_SERIES = [
  { key: 'dau_users', label: 'Users', color: '#2563eb' },
  { key: 'dau_team_devices', label: 'Team devices', color: '#059669' },
]

const TOTAL_SERIES = [
  { key: 'total_users', label: 'Users', color: '#2563eb' },
  { key: 'total_teams', label: 'Teams', color: '#7c3aed' },
  { key: 'total_team_devices', label: 'Team devices', color: '#059669' },
  { key: 'total_channels', label: 'Channels', color: '#d97706' },
]

/**
 * One labelled line chart. `connectNulls={false}` so a day with no snapshot
 * (null total) renders as a gap rather than a misleading straight line -- a
 * missing data point is not zero. A legend names every series in text, and
 * the wrapping figure carries an accessible name, so the chart's meaning
 * never rests on colour alone.
 */
function SeriesChart({ title, description, data, series }) {
  return (
    <figure className="card" aria-label={title}>
      <figcaption>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        {description ? (
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{description}</p>
        ) : null}
      </figcaption>
      <div className="mt-4" style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#9ca3af" strokeOpacity={0.3} />
            <XAxis dataKey="day" tick={{ fontSize: 12 }} minTickGap={24} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
            <Tooltip />
            <Legend />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
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

  useEffect(() => {
    if (!isGlobalManager) {
      return
    }

    let isMounted = true
    setLoading(true)
    setError(null)

    statisticsAPI.get(windowDays)
      .then((response) => {
        if (isMounted) {
          setSeries(response.data?.series || [])
        }
      })
      .catch((err) => {
        console.error('Failed to fetch statistics:', err)
        if (isMounted) {
          setError(`Failed to load statistics: ${err.message}`)
        }
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false)
        }
      })

    return () => {
      isMounted = false
    }
  }, [isGlobalManager, windowDays])

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
          <SeriesChart
            title="Daily active (TAK Server connections)"
            description="Distinct users and team devices that connected to the TAK Server each day."
            data={series}
            series={DAU_SERIES}
          />
          <SeriesChart
            title="Totals over time"
            description="Daily snapshot of total users, teams, team devices, and channels. Days before capture began may be approximate or absent."
            data={series}
            series={TOTAL_SERIES}
          />
        </>
      )}
    </div>
  )
}
