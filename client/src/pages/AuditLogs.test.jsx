import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import AuditLogs from './AuditLogs.jsx'
import { teamsAPI, auditLogsAPI } from '../services/api'
import { TOOLTIP_SEPARATOR } from '../components/FormattedDate.jsx'
import {
  setDisplayTimezone,
  DEFAULT_DISPLAY_TIMEZONE
} from '../utils/dateFormat'

// Validates: Requirements 18.2, 18.3, 18.4
//
// Requirement 18.4 is the app-wide claim: the Display_Timezone applies to
// every user-visible date the application renders through the
// Date_Format_Helpers, and is NOT scoped to device-management surfaces. That
// claim is only worth anything if it is tested on a surface that has nothing
// to do with device management, so this file mounts the audit log -- a
// Global_Manager page whose "Created At" column renders `row.created_at`
// through `formatDateTime` -- and asserts the rendered cell moves with the
// installed zone.
//
// The instant used is the one the requirement measured: TAK Server reported
// `2026-03-12T00:58:04.508Z` and a UTC-7 browser rendered `2026-03-11 17:58`,
// a calendar day away from the operator's own zone. The same pair of
// renderings is asserted here on an unrelated page, which is exactly the
// point of 18.4.
//
// This project has no `@testing-library/react` (absent from
// `client/package.json` and from `client/node_modules`) and no dependency is
// added here, so the page is mounted with `react-dom/client`'s `createRoot`
// plus React 18's own `act` under the `jsdom` environment already configured
// in `vite.config.js` -- the pattern established by
// `src/components/TransferMemberDialog.test.jsx` and `src/pages/Requests.test.jsx`.
//
// `../services/api` is the only mock: the network boundary. The page, its
// table, and the shared formatter are all real.

vi.mock('../services/api', () => ({
  auditLogsAPI: { getAuditLogs: vi.fn(), buildExportUrl: vi.fn(() => '/api/audit-logs/export') },
  teamsAPI: { getMyTeams: vi.fn() }
}))

// See the note in RevokeDeviceDialog.test.jsx: vitest compiles this JSX with
// esbuild's classic transform, so the component source (which has no `React`
// import of its own) needs one in scope.
globalThis.React = React

const GLOBAL_MANAGER = { id: 1, is_global_manager: true }

/** The instant Requirement 18.2 measured, as an audit-log row. */
const REPORTED_INSTANT = '2026-03-12T00:58:04.508Z'

const AUDIT_ROW = {
  id: 4242,
  username: 'ada',
  email: 'ada@example.com',
  user_id: 7,
  action: 'user.login',
  resource_type: 'user',
  resource_name: 'ada@example.com',
  details: null,
  created_at: REPORTED_INSTANT
}

describe('AuditLogs renders its dates in the Display_Timezone (Requirement 18.4)', () => {
  let container
  let root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    teamsAPI.getMyTeams.mockResolvedValue({ data: { teams: [] } })
    auditLogsAPI.getAuditLogs.mockResolvedValue({
      data: {
        auditLogs: [AUDIT_ROW],
        pagination: { page: 1, pageSize: 50, total: 1 }
      }
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
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    // The zone is module state shared with every other test file's default.
    setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE)
  })

  const mountPage = async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(<AuditLogs user={GLOBAL_MANAGER} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
  }

  /** The rendered "Created At" cell -- the last cell of the single row. */
  const createdAtCell = () => {
    const cells = container.querySelectorAll('tbody tr td')
    return cells[cells.length - 1]?.textContent
  }

  it('renders the Created At column in the installed zone, not the browser zone', async () => {
    setDisplayTimezone('Pacific/Auckland')
    await mountPage()

    expect(createdAtCell()).toBe('2026-03-12 13:58')
    // The raw ISO string the row carries must not be what reaches the page.
    expect(container.textContent).not.toContain(REPORTED_INSTANT)
  })

  it('moves the same cell a calendar day when another zone is installed', async () => {
    setDisplayTimezone('America/Los_Angeles')
    await mountPage()

    // The exact rendering the defect produced -- correct here, because this
    // is now the configured zone rather than an accident of the browser's.
    expect(createdAtCell()).toBe('2026-03-11 17:58')
  })

  it('renders in Pacific/Auckland when no zone was ever installed', async () => {
    // Requirement 18.7 on a non-device surface: a client whose public-config
    // read never arrived still renders in the documented default.
    await mountPage()

    expect(createdAtCell()).toBe('2026-03-12 13:58')
  })

  it('keeps the yyyy-mm-dd HH:MM shape rather than a locale rendering', async () => {
    setDisplayTimezone('Asia/Kolkata')
    await mountPage()

    expect(createdAtCell()).toMatch(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d$/)
    expect(createdAtCell()).toBe('2026-03-12 06:28')
  })

  it('falls back to the raw value for an unparseable created_at', async () => {
    // Requirement 18.10 as this page uses it: `formatDateTime(row.created_at,
    // row.created_at)` passes the raw value as its own fallback, so a value
    // the formatter cannot read is still shown rather than blanked.
    auditLogsAPI.getAuditLogs.mockResolvedValue({
      data: {
        auditLogs: [{ ...AUDIT_ROW, created_at: 'not-a-timestamp' }],
        pagination: { page: 1, pageSize: 50, total: 1 }
      }
    })
    setDisplayTimezone('Pacific/Auckland')
    await mountPage()

    expect(createdAtCell()).toBe('not-a-timestamp')
  })

  // ══════════════════════════════════════════════════════════════════════
  // date-tooltips-and-folder-contrast task 6.7 -- Criteria 2.3, 2.4, 2.7,
  // 3.1, 3.5, 3.7, 3.11.
  //
  // Date_Render_Position 5 now renders through the ONE shared
  // `FormattedDate`, so this cell acquires a disclosure. What must NOT have
  // changed is the rendered TEXT, which is why the five exact-string
  // assertions above are reused as they stand rather than rewritten here:
  // they were written against the inline `formatDateTime(row.created_at,
  // row.created_at)` call this position used to make, and they still pass.
  // ══════════════════════════════════════════════════════════════════════
  describe('the Created At cell discloses a Date_Tooltip (task 6.7)', () => {
    /** The focusable date node inside the last cell of the single row. */
    const hostOf = () =>
      container.querySelector('tbody tr td:last-child span[tabindex="0"]')

    /**
     * The element `aria-describedby` names, looked up with `getElementById`
     * because React 18's `useId` produces ids (`:r1:`) that are not valid
     * CSS selectors.
     */
    const tooltipOf = () => {
      const host = hostOf()
      const id = host && host.getAttribute('aria-describedby')
      return id ? document.getElementById(id) : null
    }

    const pointerOver = async (node) => {
      await act(async () => {
        node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      })
    }

    const pointerOut = async (node) => {
      await act(async () => {
        node.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
      })
    }

    it('leaves the resting cell exactly as it was, with nothing disclosed', async () => {
      setDisplayTimezone('Pacific/Auckland')
      await mountPage()

      // The same exact string the timezone tests above assert -- restated
      // here because the claim of this block is that the disclosure costs
      // the cell's text nothing (Criterion 2.3).
      expect(createdAtCell()).toBe('2026-03-12 13:58')

      const host = hostOf()
      expect(host).not.toBeNull()
      expect(host.className).toContain('cursor-help')
      // Reachable by keyboard, not by hover alone (Criterion 3.1).
      expect(host.getAttribute('tabindex')).toBe('0')
      // Mounted only while disclosed, so at rest there is no element for
      // `aria-describedby` to point at -- and the attribute is absent with
      // it (Criterion 3.7).
      expect(host.hasAttribute('aria-describedby')).toBe(false)
      expect(tooltipOf()).toBeNull()
    })

    it('opens LEFTWARD from right-full/mr-2 for this trailing cell (Criteria 3.5, 3.11)', async () => {
      setDisplayTimezone('Pacific/Auckland')
      await mountPage()

      const host = hostOf()
      await pointerOver(host)
      const tooltip = tooltipOf()

      expect(tooltip).not.toBeNull()
      expect(tooltip.className).toContain('right-full')
      expect(tooltip.className).toContain('mr-2')
      expect(tooltip.className).toContain('top-1/2')
      expect(tooltip.className).toContain('-translate-y-1/2')
      expect(tooltip.className).not.toContain('left-full')
      expect(tooltip.className).not.toContain('ml-2')
      // The Tooltip_Clipping_Defect: this table sits in an
      // `overflow-x-auto` wrapper, and a box with one overflow axis `auto`
      // and the other `visible` clips on BOTH axes, so nothing here may
      // open upward or downward (Criterion 3.4).
      expect(container.innerHTML).not.toContain('top-full')
      expect(container.innerHTML).not.toContain('bottom-full')

      // Two facts, separated explicitly, with the RESOLVED zone as the
      // second (Criteria 2.8, 2.9, 2.10) -- and no ISO instant anywhere in
      // it (Criterion 2.11).
      expect(tooltip.textContent).toContain(TOOLTIP_SEPARATOR)
      expect(tooltip.textContent.endsWith('Pacific/Auckland')).toBe(true)
      expect(tooltip.textContent).not.toContain(REPORTED_INSTANT)

      await pointerOut(host)
      expect(tooltipOf()).toBeNull()
      // Dismissal puts the cell back to exactly the string it started as.
      expect(createdAtCell()).toBe('2026-03-12 13:58')
    })

    it('renders the raw-value fallback with NO disclosure host at all (Criteria 2.4, 2.7)', async () => {
      // A value the Date_Format_Helpers could not render is a value the
      // tooltip has nothing to say about, so there is no host, no tab stop
      // and no `aria-describedby` -- the cell is character for character
      // and element for element what it was before the adoption.
      auditLogsAPI.getAuditLogs.mockResolvedValue({
        data: {
          auditLogs: [{ ...AUDIT_ROW, created_at: 'not-a-timestamp' }],
          pagination: { page: 1, pageSize: 50, total: 1 }
        }
      })
      setDisplayTimezone('Pacific/Auckland')
      await mountPage()

      expect(createdAtCell()).toBe('not-a-timestamp')
      expect(hostOf()).toBeNull()
      expect(container.querySelector('[aria-describedby]')).toBeNull()
    })
  })
})
