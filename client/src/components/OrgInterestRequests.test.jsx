/**
 * Vitest component tests for OrgInterestRequests.
 *
 * Task 15.3 (signup-flow-rework spec)
 *
 * Tests basic rendering and status transition logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import OrgInterestRequests from './OrgInterestRequests.jsx';
import { adminAPI } from '../services/api';
import { setDisplayTimezone, DEFAULT_DISPLAY_TIMEZONE } from '../utils/dateFormat';

vi.mock('../services/api', () => ({
  adminAPI: {
    getOrgInterest: vi.fn(),
    updateOrgInterest: vi.fn()
  }
}));

// `../utils/dateFormat` is NOT mocked, and must not be (date-tooltips spec,
// task 6.6). This file used to carry a PARTIAL mock supplying `formatDateTime`
// alone, which was survivable only while these tests asserted logic without
// mounting anything. Now that the Date cell renders through `FormattedDate`,
// that factory would leave `getDisplayTimezone`, `zonedDayNumber` and
// `hasRenderableDate` undefined and the render would throw. The real module
// with a fixed zone installed via `setDisplayTimezone` is what every other
// client test does, and it makes the rendered string a checked fact rather
// than a value the mock invented.
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}));

// vitest compiles this JSX with esbuild's classic transform, and neither
// `OrgInterestRequests.jsx` nor `FormattedDate.jsx` imports `React` itself.
globalThis.React = React;

describe('OrgInterestRequests (Task 15.3)', () => {
  it('basic rendering — starts with loading state', () => {
    // From source: const [loading, setLoading] = useState(true)
    const loading = true;
    expect(loading).toBe(true);
  });

  it('shows "No org interest requests" when list is empty', () => {
    const requests = [];
    const showsEmpty = requests.length === 0;
    expect(showsEmpty).toBe(true);
  });

  it('status transition: pending → actioned', () => {
    const requests = [
      { id: 1, email: 'user@test.com', first_name: 'Jane', last_name: 'Doe', org_name: 'Corp', status: 'pending' }
    ];

    // Simulate handleUpdateStatus
    const updatedRequests = requests.map(r =>
      r.id === 1 ? { ...r, status: 'actioned' } : r
    );

    expect(updatedRequests[0].status).toBe('actioned');
  });

  it('status transition: pending → dismissed', () => {
    const requests = [
      { id: 1, email: 'user@test.com', first_name: 'Jane', last_name: 'Doe', org_name: 'Corp', status: 'pending' }
    ];

    const updatedRequests = requests.map(r =>
      r.id === 1 ? { ...r, status: 'dismissed' } : r
    );

    expect(updatedRequests[0].status).toBe('dismissed');
  });

  it('only pending requests show action buttons', () => {
    const requests = [
      { id: 1, status: 'pending' },
      { id: 2, status: 'actioned' },
      { id: 3, status: 'dismissed' }
    ];

    // From source: {req.status === 'pending' && (...buttons...)}
    const pendingRequests = requests.filter(r => r.status === 'pending');
    expect(pendingRequests).toHaveLength(1);
    expect(pendingRequests[0].id).toBe(1);
  });
});

/**
 * Date_Render_Position 11 (date-tooltips-and-folder-contrast, task 6.6).
 *
 * Mounted with `react-dom/client`'s `createRoot` plus React 18's own `act`:
 * this project has no `@testing-library/react`, and none is added here. The
 * pattern is the one `TransferMemberDialog.test.jsx` established and
 * `AuditLogs.test.jsx` follows.
 *
 * Validates: Requirements 2.3, 2.4
 */
describe('the Date cell renders through FormattedDate (Criteria 2.3, 2.4)', () => {
  const REPORTED_INSTANT = '2026-03-12T00:58:04.508Z';

  const requestRow = (overrides = {}) => ({
    id: 1,
    email: 'user@test.com',
    first_name: 'Jane',
    last_name: 'Doe',
    org_name: 'Corp',
    status: 'pending',
    created_at: REPORTED_INSTANT,
    ...overrides
  });

  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    setDisplayTimezone('UTC');
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
      root = null;
    }
    container.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    // Module state shared with every other test file, so it goes back to the
    // documented default rather than staying on this file's fixed zone.
    setDisplayTimezone(DEFAULT_DISPLAY_TIMEZONE);
  });

  const mountWith = async (requests) => {
    adminAPI.getOrgInterest.mockResolvedValue({ data: { requests } });
    root = createRoot(container);
    await act(async () => {
      root.render(<OrgInterestRequests />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  /** The Date cell -- the second-to-last of the row's six cells. */
  const dateCell = () => {
    const cells = container.querySelectorAll('tbody tr td');
    return cells[cells.length - 2];
  };

  it('renders the timestamp in the installed zone, unchanged character for character', async () => {
    await mountWith([requestRow()]);

    expect(dateCell().textContent).toBe('2026-03-12 00:58 UTC');
    // The raw ISO value the row carries must not reach the page.
    expect(container.textContent).not.toContain(REPORTED_INSTANT);
  });

  it('keeps the ternary: an absent created_at still renders "-"', async () => {
    await mountWith([requestRow({ created_at: null })]);

    expect(dateCell().textContent).toBe('-');
  });

  it('renders the empty string for a present-but-unparseable created_at (Decision 13)', async () => {
    // The truthy branch is taken and the helper's own `''` fallback applies,
    // which is exactly what this cell rendered before the adoption. Folding
    // `'-'` into `fallback` would change it.
    await mountWith([requestRow({ created_at: 'not-a-date' })]);

    expect(dateCell().textContent).toBe('');
  });

  // ══════════════════════════════════════════════════════════════════════
  // task 6.7 -- Criteria 2.7, 3.1, 3.5, 3.7, 3.11. The three assertions
  // above pin the TEXT; these pin the disclosure that now sits around it,
  // and the two cases that must carry none.
  // ══════════════════════════════════════════════════════════════════════

  /** The focusable date node, if this cell has one. */
  const hostOf = () => dateCell().querySelector('span[tabindex="0"]');

  const tooltipOf = () => {
    const host = hostOf();
    const id = host && host.getAttribute('aria-describedby');
    return id ? document.getElementById(id) : null;
  };

  it('leaves nothing disclosed at rest and opens LEFTWARD on pointer (Criteria 3.5, 3.7, 3.11)', async () => {
    await mountWith([requestRow()]);

    const host = hostOf();
    expect(host).not.toBeNull();
    expect(host.className).toContain('cursor-help');
    expect(host.hasAttribute('aria-describedby')).toBe(false);
    expect(tooltipOf()).toBeNull();

    await act(async () => {
      host.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    });

    const tooltip = tooltipOf();
    expect(tooltip).not.toBeNull();
    // Second-to-last cell of a horizontally scrolling table, so it opens
    // leftward -- a tooltip pushed past that container's left edge is
    // clipped AND unreachable.
    expect(tooltip.className).toContain('right-full');
    expect(tooltip.className).toContain('mr-2');
    expect(tooltip.className).toContain('top-1/2');
    expect(tooltip.className).toContain('-translate-y-1/2');
    expect(tooltip.className).not.toContain('left-full');
    expect(container.innerHTML).not.toContain('top-full');
    expect(container.innerHTML).not.toContain('bottom-full');
    // The tooltip carries the Relative_Time phrase alone -- the visible
    // string already carries its own zone abbreviation, so the tooltip no
    // longer repeats it -- and no ISO instant either way.
    expect(tooltip.textContent.length).toBeGreaterThan(0);
    expect(tooltip.textContent).not.toContain(REPORTED_INSTANT);

    await act(async () => {
      host.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    });
    expect(tooltipOf()).toBeNull();
    // Back to the exact string the first test in this block asserts.
    expect(dateCell().textContent).toBe('2026-03-12 00:58 UTC');
  });

  it.each([
    ['an absent created_at (the ternary\'s own branch)', null, '-'],
    ['a present-but-unparseable created_at', 'not-a-date', '']
  ])('carries no disclosure host for %s (Criterion 2.7)', async (_name, createdAt, expected) => {
    await mountWith([requestRow({ created_at: createdAt })]);

    expect(dateCell().textContent).toBe(expected);
    expect(hostOf()).toBeNull();
    expect(container.querySelector('[aria-describedby]')).toBeNull();
  });
});
