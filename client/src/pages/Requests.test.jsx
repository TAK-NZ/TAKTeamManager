import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Requests, {
  getInitialCallsignSuffixMap,
  extractCallsignSuffixConflictError,
  formatPersonName,
  filterDevicesNeedingRenewal
} from './Requests.jsx';
import Layout from '../components/Layout.jsx';
import { ThemeProvider } from '../contexts/ThemeContext.jsx';
import FormattedDate, {
  DATE_PRECISION,
  TOOLTIP_SIDES
} from '../components/FormattedDate.jsx';
import { requestsAPI, deviceManagementAPI, devicesAPI, configAPI, versionAPI } from '../services/api';
import { formatDate } from '../utils/dateFormat';
import toast from 'react-hot-toast';

// Validates: Requirements 11.11, 11.12, 11.17, 16.1, 16.2, 16.3, 16.4,
// 16.5, 16.6
//
// Requests.jsx renders an editable "Callsign Suffix" field per pending
// request, pre-filled from GET /api/requests/pending's `effective_callsign_suffix`
// field (Req 11.11/11.12), and surfaces a POST .../approve 400 collision
// inline instead of only a generic toast (Req 11.17). Those rules are pure
// functions of a response body, so the first half of this file asserts the
// exported helpers directly.
//
// The Requirement 16 criteria are about what a `team_change` card renders
// and what the approve/deny controls do, which no helper can demonstrate.
// This project has no `@testing-library/react` (absent from
// client/package.json and from client/node_modules) and no dependency is
// added here, so the second half mounts the real component with
// `react-dom/client`'s `createRoot` plus React 18.3's own `act` under the
// `jsdom` environment already configured in vite.config.js -- the approach
// established by src/components/TransferMemberDialog.test.jsx. Requirement
// 16.5's badge clause spans two components (the list in Requests.jsx, the
// count in Layout.jsx), so that one test mounts Requests *inside* Layout
// and drives both from a single mocked server state.
//
// `../services/api` and `react-hot-toast` are the only mocks: the network
// boundary and the toast sink.

vi.mock('../services/api', () => ({
  requestsAPI: {
    getPending: vi.fn(),
    approveRequest: vi.fn(),
    denyRequest: vi.fn()
  },
  // cert-expiry-notifications Requirement 7.3: the two new renewal-section
  // data sources this page now also fetches.
  // getMyDevices feeds the renewal section + Layout's badge; probeEnabled is
  // the DEVICE_MGMT_ENABLED reachability probe Layout now runs to gate the
  // Enrollment/Devices nav items (via useDeviceManagementEnabled). A
  // resolvable default is required or Layout's mount effect rejects unhandled;
  // feature-off is irrelevant to this page's assertions.
  deviceManagementAPI: { getMyDevices: vi.fn(), probeEnabled: vi.fn().mockResolvedValue({ enabled: false }) },
  devicesAPI: {
    getAll: vi.fn(),
    generateQrCode: vi.fn(),
    previewQrCode: vi.fn()
  },
  // Layout.jsx imports authAPI and versionAPI, OrgInterestRequests.jsx
  // imports adminAPI. None is exercised here, but a named import of a
  // missing export from a mocked ES module is a load-time failure, so
  // all are present.
  authAPI: { logout: vi.fn() },
  adminAPI: {},
  versionAPI: { get: vi.fn().mockResolvedValue({ data: { version: '2026.9.0' } }) },
  // The Renew action's modal mounts the real EnrollmentView.jsx, which
  // reads configAPI.getPublic() on mount (unrelated to this feature) --
  // present here so that render path doesn't throw.
  configAPI: { getPublic: vi.fn().mockResolvedValue({ data: {} }) }
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() }
}));

// Vitest resolves this project's Vite config but does not apply
// `@vitejs/plugin-react` to the modules it loads, so JSX here and in the
// components under test is compiled by esbuild's classic transform to
// `React.createElement` rather than the automatic `react/jsx-runtime`
// import. The component sources (correctly, for the app build) have no
// `React` import of their own, so the classic transform needs one in
// scope; publishing the real React onto `globalThis` supplies it for every
// file. Harmless if the automatic runtime is ever active here -- nothing
// reads this global then.
globalThis.React = React;

describe('getInitialCallsignSuffixMap', () => {
  it('pre-fills from effective_callsign_suffix when present (Req 11.12: request submitted its own value)', () => {
    const requests = [
      { id: 1, effective_callsign_suffix: 'Smith-J' },
      { id: 2, effective_callsign_suffix: 'JDoe' }
    ];

    expect(getInitialCallsignSuffixMap(requests)).toEqual({ 1: 'Smith-J', 2: 'JDoe' });
  });

  it('pre-fills from the server-computed default when effective_callsign_suffix is present but computed (Req 11.11: non-user_defined format)', () => {
    // The server computes this the same way regardless of source (task
    // 24.2) -- from the Client's perspective there is only ever a single
    // `effective_callsign_suffix` field to pre-fill from, whether it came
    // from the request's own submission or the server-computed default.
    const requests = [{ id: 3, effective_callsign_suffix: 'JohnDoe' }];

    expect(getInitialCallsignSuffixMap(requests)).toEqual({ 3: 'JohnDoe' });
  });

  it('falls back to an empty string when effective_callsign_suffix is absent/null', () => {
    const requests = [{ id: 4, effective_callsign_suffix: null }, { id: 5 }];

    expect(getInitialCallsignSuffixMap(requests)).toEqual({ 4: '', 5: '' });
  });

  it('handles an empty requests list', () => {
    expect(getInitialCallsignSuffixMap([])).toEqual({});
  });
});

describe('extractCallsignSuffixConflictError', () => {
  it('extracts the conflicting-value message from a shaped 400 response (Req 11.17)', () => {
    const error = {
      response: {
        status: 400,
        data: { error: 'Callsign Suffix "Smith-J" is already in use within this Team' }
      }
    };

    expect(extractCallsignSuffixConflictError(error)).toBe(
      'Callsign Suffix "Smith-J" is already in use within this Team'
    );
  });

  it('returns null for a non-400 failure (e.g. 500), deferring to the generic toast', () => {
    const error = { response: { status: 500, data: { error: 'Failed to approve request' } } };

    expect(extractCallsignSuffixConflictError(error)).toBeNull();
  });

  it('returns null for a 400 response with no string error body', () => {
    const error = { response: { status: 400, data: {} } };

    expect(extractCallsignSuffixConflictError(error)).toBeNull();
  });

  it('returns null when the error has no response at all (e.g. a network error)', () => {
    expect(extractCallsignSuffixConflictError(new Error('Network Error'))).toBeNull();
  });
});
describe('filterDevicesNeedingRenewal (cert-expiry-notifications Requirement 7.3(a))', () => {
  it('keeps only a device whose certificate is imminent or expired', () => {
    const dueSoon = { clientUid: 'a', expiresAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString() }
    const expired = { clientUid: 'b', expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() }
    const fine = { clientUid: 'c', expiresAt: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString() }

    expect(filterDevicesNeedingRenewal([dueSoon, expired, fine])).toEqual([dueSoon, expired])
  })

  it('returns an empty array for an empty or absent list', () => {
    expect(filterDevicesNeedingRenewal([])).toEqual([])
    expect(filterDevicesNeedingRenewal(undefined)).toEqual([])
    expect(filterDevicesNeedingRenewal(null)).toEqual([])
  })
})

describe('formatPersonName (Req 16.1)', () => {
  it('joins the first and last name of the Transferred_User / Initiating_Admin', () => {
    expect(formatPersonName('Ada', 'Lovelace')).toBe('Ada Lovelace')
  })

  it('drops a null half rather than rendering "null"', () => {
    expect(formatPersonName('Ada', null)).toBe('Ada')
    expect(formatPersonName(null, 'Lovelace')).toBe('Lovelace')
  })

  it('returns an empty string when both halves are absent', () => {
    expect(formatPersonName(null, undefined)).toBe('')
    expect(formatPersonName('', '')).toBe('')
  })
})

// The `team_change` row as GET /api/requests/pending returns it (see
// server/routes/requests.js's enrichPendingRequests): the Transferred_User
// comes from the `tu` join, the Initiating_Admin from `iu`, the Source_Team
// path from `st`. The `requester_*` columns are deliberately populated with
// the Initiating_Admin's values -- that is what they hold on a real
// Transfer_Request -- so the tests below can assert they are neither
// rendered nor submitted.
const TEAM_CHANGE_REQUEST = {
  id: 101,
  request_type: 'team_change',
  justification: 'Moving to the incident response team',
  created_at: '2025-03-04T09:30:00.000Z',
  transferred_user_first_name: 'Ada',
  transferred_user_last_name: 'Lovelace',
  transferred_user_email: 'ada@example.com',
  source_team_path: 'ORG > Alpha',
  team_path: 'ORG > Bravo',
  initiated_by_first_name: 'Grace',
  initiated_by_last_name: 'Hopper',
  requester_email: 'grace@example.com',
  requester_first_name: 'Grace',
  requester_last_name: 'Hopper',
  effective_callsign_suffix: 'Hopper-G'
}

const NEW_ACCOUNT_REQUEST = {
  id: 202,
  request_type: 'new_account',
  justification: 'New volunteer joining',
  created_at: '2025-03-05T09:30:00.000Z',
  requester_email: 'neo@example.com',
  requester_first_name: 'Neo',
  requester_last_name: 'Newman',
  team_path: 'ORG > Charlie',
  effective_callsign_suffix: 'Newman-N'
}

// A Team_Admin (not a Global_Manager): sees the Requests page and the
// pending-count badge, but not the Global_Manager-only OrgInterestRequests
// panel.
const TEAM_ADMIN = { userId: 7, isAdmin: true, isTeamAdmin: true, is_global_manager: false }

describe('Requests page team_change card (mounted)', () => {
  let container
  let root
  let matchMediaStubbed = false

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    // jsdom implements no `window.matchMedia`, and ThemeProvider (mounted
    // by the badge tests, which need the real Layout) reads it to pick the
    // initial theme. A "light" stub is enough -- no test asserts on theme.
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
      matchMediaStubbed = true
    }
    requestsAPI.getPending.mockResolvedValue({
      data: { requests: [TEAM_CHANGE_REQUEST, NEW_ACCOUNT_REQUEST] }
    })
    requestsAPI.approveRequest.mockResolvedValue({ data: {} })
    requestsAPI.denyRequest.mockResolvedValue({ data: {} })
    // cert-expiry-notifications Requirement 7.3: default to "nothing due"
    // for both new renewal sections, so every pre-existing test in this
    // file (written before these sections existed) sees them render
    // nothing, matching its original assumptions.
    deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [] } })
    // Layout's nav gate calls the DEVICE_MGMT_ENABLED probe on mount; re-set
    // its default (clearAllMocks wiped it). Feature-off is fine here.
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })
    devicesAPI.getAll.mockResolvedValue({ data: { devices: [], pagination: { page: 1, pageSize: 200, total: 0 } } })
    // vi.clearAllMocks() above also clears the module-level default this
    // mock was given at definition time -- re-set it here, since Layout.jsx
    // (mounted by the badge tests) calls it on mount.
    versionAPI.get.mockResolvedValue({ data: { version: '2026.9.0' } })
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

  // cert-expiry-notifications Requirement 7.3(a)'s renewal section renders
  // a react-router-dom `<Link>`, so every mount (not just the
  // already-Router-wrapped mountPageInLayout below) needs a Router in
  // scope now, even for a test whose renewal section stays empty.
  const mountPage = (user = TEAM_ADMIN) => mount(
    <MemoryRouter initialEntries={['/tasks']}>
      <Requests user={user} />
    </MemoryRouter>
  )

  // Requirement 16.5's badge lives in Layout.jsx, which derives it from the
  // same requestsAPI.getPending() the page uses. Mounting the page inside
  // the layout is the only way to assert the list removal and the badge
  // update are the same event.
  const mountPageInLayout = (user = TEAM_ADMIN) => mount(
    <MemoryRouter initialEntries={['/requests']}>
      <ThemeProvider>
        <Layout user={user}>
          <Requests user={user} />
        </Layout>
      </ThemeProvider>
    </MemoryRouter>
  )

  const cards = () => Array.from(container.querySelectorAll('.card'))
  const cardFor = (needle) => cards().find((card) => card.textContent.includes(needle))
  const teamChangeCard = () => cardFor(TEAM_CHANGE_REQUEST.transferred_user_email)
  const newAccountCard = () => cardFor(NEW_ACCOUNT_REQUEST.requester_email)

  const buttonIn = (scope, label) => Array.from(scope.querySelectorAll('button'))
    .find((b) => b.textContent.trim() === label)

  const click = async (el) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  const setTextareaValue = async (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    await act(async () => {
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  // Layout renders the sidebar twice (mobile + desktop), so the badge
  // appears once per copy; both carry the same count. Scoped to the NAV-ITEM
  // "Tasks" links (whose visible text ends with "Tasks") so the mobile
  // notification BELL -- also a /tasks link with a bg-red-600 pill, but no
  // visible "Tasks" text, only an aria-label -- is not counted here. The bell
  // has its own dedicated coverage in Layout.test.jsx.
  const badgeCounts = () => Array.from(container.querySelectorAll('a'))
    .filter((a) => a.textContent.trim().endsWith('Tasks'))
    .map((a) => a.querySelector('span.bg-red-600'))
    .filter(Boolean)
    .map((s) => s.textContent)

  it('renders both hierarchy paths, both people, the justification and the timestamp (Req 16.1)', async () => {
    await mountPage()

    const card = teamChangeCard()
    expect(card).toBeDefined()
    expect(card.textContent).toContain('Ada Lovelace')
    expect(card.textContent).toContain('ada@example.com')
    expect(card.textContent).toContain('ORG > Alpha')
    expect(card.textContent).toContain('ORG > Bravo')
    expect(card.textContent).toContain('Grace Hopper')
    expect(card.textContent).toContain(TEAM_CHANGE_REQUEST.justification)
    expect(card.textContent).toContain(formatDate(TEAM_CHANGE_REQUEST.created_at))
    expect(card.textContent).toContain('Team Transfer')
  })

  it('names the Transferred_User rather than the Initiating_Admin as the subject (Req 16.1)', async () => {
    await mountPage()

    // `requester_email` on a Transfer_Request is the Initiating_Admin's, so
    // it must not appear as the card's email.
    expect(teamChangeCard().textContent).not.toContain('grace@example.com')
  })

  it('suppresses the First Name / Last Name / Callsign Suffix inputs for a team_change row', async () => {
    await mountPage()

    const card = teamChangeCard()
    expect(card.querySelector(`#first-name-${TEAM_CHANGE_REQUEST.id}`)).toBeNull()
    expect(card.querySelector(`#last-name-${TEAM_CHANGE_REQUEST.id}`)).toBeNull()
    expect(card.querySelector(`#callsign-suffix-${TEAM_CHANGE_REQUEST.id}`)).toBeNull()

    // The same three inputs are still rendered for a `new_account` row, so
    // the suppression is type-specific rather than a removal.
    const other = newAccountCard()
    expect(other.querySelector(`#first-name-${NEW_ACCOUNT_REQUEST.id}`)).not.toBeNull()
    expect(other.querySelector(`#last-name-${NEW_ACCOUNT_REQUEST.id}`)).not.toBeNull()
    expect(other.querySelector(`#callsign-suffix-${NEW_ACCOUNT_REQUEST.id}`)).not.toBeNull()
  })

  // account-lifecycle-management Requirement 5.2 (task 11.4): a
  // `new_account` card whose `reclaimableAccount` field is present shows
  // a distinct notice, without changing the card's own displayed type.
  describe('reclaimableAccount notice (account-lifecycle-management)', () => {
    it('shows a distinct notice on a new_account card whose reclaimableAccount is present', async () => {
      requestsAPI.getPending.mockResolvedValue({
        data: {
          requests: [
            TEAM_CHANGE_REQUEST,
            { ...NEW_ACCOUNT_REQUEST, reclaimableAccount: { userId: 777, previousTeamId: 42 } }
          ]
        }
      })

      await mountPage()

      const card = newAccountCard()
      expect(card.textContent).toMatch(/orphaned/i)
      expect(card.textContent).toMatch(/reclaim/i)
    })

    it('shows no notice on a new_account card whose reclaimableAccount is null', async () => {
      requestsAPI.getPending.mockResolvedValue({
        data: {
          requests: [{ ...NEW_ACCOUNT_REQUEST, reclaimableAccount: null }]
        }
      })

      await mountPage()

      const card = newAccountCard()
      expect(card.textContent).not.toMatch(/orphaned/i)
    })

    it('shows no notice on a new_account card whose response carries no reclaimableAccount field at all', async () => {
      await mountPage() // default fixture has no reclaimableAccount field

      const card = newAccountCard()
      expect(card.textContent).not.toMatch(/orphaned/i)
    })

    it('never renders the notice on a team_change card (the field is only ever meaningful for new_account)', async () => {
      requestsAPI.getPending.mockResolvedValue({
        data: {
          requests: [
            { ...TEAM_CHANGE_REQUEST, reclaimableAccount: { userId: 1, previousTeamId: null } },
            NEW_ACCOUNT_REQUEST
          ]
        }
      })

      await mountPage()

      expect(teamChangeCard().textContent).not.toMatch(/orphaned/i)
    })
  })

  it('renders an approve control and a deny control (Req 16.2)', async () => {
    await mountPage()

    const card = teamChangeCard()
    expect(buttonIn(card, 'Approve')).toBeDefined()
    expect(buttonIn(card, 'Deny')).toBeDefined()
  })

  it('states that approval removes the member admin rights in the Source_Team (Req 16.3)', async () => {
    await mountPage()

    const text = teamChangeCard().textContent
    expect(text).toMatch(/removes this member's admin rights/i)
    expect(text).toContain('ORG > Alpha')
  })

  it('omits the three new_account fields from the approve payload of a team_change row', async () => {
    await mountPage()
    await click(buttonIn(teamChangeCard(), 'Approve'))

    expect(requestsAPI.approveRequest).toHaveBeenCalledTimes(1)
    expect(requestsAPI.approveRequest.mock.calls[0]).toEqual([
      TEAM_CHANGE_REQUEST.id,
      { additionalDetails: '' }
    ])

    // The `new_account` row still submits all three, so the omission is
    // specific to `team_change` and not a regression of the existing path.
    await click(buttonIn(newAccountCard(), 'Approve'))
    expect(requestsAPI.approveRequest.mock.calls[1]).toEqual([
      NEW_ACCOUNT_REQUEST.id,
      {
        additionalDetails: '',
        callsignSuffix: 'Newman-N',
        firstName: 'Neo',
        lastName: 'Newman'
      }
    ])
  })

  it('requires a non-empty denial reason before submitting (Req 16.4)', async () => {
    await mountPage()
    await click(buttonIn(teamChangeCard(), 'Deny'))

    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()

    const confirmButton = () => buttonIn(container, 'Deny Request')
    expect(confirmButton().disabled).toBe(true)

    await click(confirmButton())
    expect(requestsAPI.denyRequest).not.toHaveBeenCalled()

    // Whitespace is not a reason.
    await setTextareaValue(textarea, '   ')
    expect(confirmButton().disabled).toBe(true)
    await click(confirmButton())
    expect(requestsAPI.denyRequest).not.toHaveBeenCalled()

    await setTextareaValue(textarea, 'Destination team is at capacity')
    expect(confirmButton().disabled).toBe(false)
    await click(confirmButton())

    expect(requestsAPI.denyRequest).toHaveBeenCalledTimes(1)
    expect(requestsAPI.denyRequest.mock.calls[0]).toEqual([
      TEAM_CHANGE_REQUEST.id,
      { denialReason: 'Destination team is at capacity' }
    ])
  })

  it('removes the approved row from the list and decrements the badge (Req 16.5)', async () => {
    // One mocked server state drives both components: the page's initial
    // fetch, the approve call that removes the row, and the badge's own
    // refetch all read the same array.
    let serverRequests = [TEAM_CHANGE_REQUEST, NEW_ACCOUNT_REQUEST]
    requestsAPI.getPending.mockImplementation(async () => ({ data: { requests: serverRequests } }))
    requestsAPI.approveRequest.mockImplementation(async (requestId) => {
      serverRequests = serverRequests.filter((r) => r.id !== requestId)
      return { data: {} }
    })

    await mountPageInLayout()

    expect(cards().filter((c) => c.textContent.includes('Pending'))).toHaveLength(2)
    expect(badgeCounts()).toEqual(['2', '2'])

    await click(buttonIn(teamChangeCard(), 'Approve'))

    // The list removal is optimistic -- it does not wait for a refetch.
    expect(teamChangeCard()).toBeUndefined()
    expect(newAccountCard()).toBeDefined()
    expect(toast.success).toHaveBeenCalledWith('Request approved successfully')

    // Layout.jsx refetches the count on an interval and on tab visibility;
    // driving the visibility path (rather than waiting 60s) shows the badge
    // now tracks the shortened pending set.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(badgeCounts()).toEqual(['1', '1'])
  })

  it('removes the denied row from the list and decrements the badge (Req 16.5)', async () => {
    let serverRequests = [TEAM_CHANGE_REQUEST, NEW_ACCOUNT_REQUEST]
    requestsAPI.getPending.mockImplementation(async () => ({ data: { requests: serverRequests } }))
    requestsAPI.denyRequest.mockImplementation(async (requestId) => {
      serverRequests = serverRequests.filter((r) => r.id !== requestId)
      return { data: {} }
    })

    await mountPageInLayout()
    expect(badgeCounts()).toEqual(['2', '2'])

    await click(buttonIn(teamChangeCard(), 'Deny'))
    await setTextareaValue(container.querySelector('textarea'), 'Not approved')
    await click(buttonIn(container, 'Deny Request'))

    expect(teamChangeCard()).toBeUndefined()
    expect(container.querySelector('textarea')).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('Request denied successfully')

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(badgeCounts()).toEqual(['1', '1'])
  })

  it.each([
    [400, 'Callsign Suffix "Hopper-G" is already in use within this Team'],
    [409, 'This user has moved teams since this request was created'],
    [409, 'The two teams are in different organisations'],
    [500, 'Failed to approve request']
  ])('retains the row and surfaces the server message when approve returns %i (Req 16.6)', async (status, message) => {
    requestsAPI.approveRequest.mockRejectedValue({ response: { status, data: { error: message } } })

    await mountPage()
    await click(buttonIn(teamChangeCard(), 'Approve'))

    expect(teamChangeCard()).toBeDefined()
    expect(toast.error).toHaveBeenCalledWith(message)
    expect(toast.success).not.toHaveBeenCalled()

    // A `team_change` card has no Callsign Suffix field, so a 400 must not
    // try to hang an inline error off one -- the toast is the whole report.
    expect(teamChangeCard().querySelector(`#callsign-suffix-${TEAM_CHANGE_REQUEST.id}`)).toBeNull()
  })

  it('falls back to a generic approve message when the body carries none (Req 16.6)', async () => {
    requestsAPI.approveRequest.mockRejectedValue(new Error('Network Error'))

    await mountPage()
    await click(buttonIn(teamChangeCard(), 'Approve'))

    expect(teamChangeCard()).toBeDefined()
    expect(toast.error).toHaveBeenCalledWith('Failed to approve request')
  })

  it('retains the row when deny fails (Req 16.6)', async () => {
    requestsAPI.denyRequest.mockRejectedValue({
      response: { status: 409, data: { error: 'Request is no longer pending' } }
    })

    await mountPage()
    await click(buttonIn(teamChangeCard(), 'Deny'))
    await setTextareaValue(container.querySelector('textarea'), 'Not approved')
    await click(buttonIn(container, 'Deny Request'))

    expect(teamChangeCard()).toBeDefined()
    // The deny path's toast is the pre-existing fixed message rather than
    // the response body's -- unchanged by this feature (design.md: "the
    // existing error toast"), so it is asserted as it stands.
    expect(toast.error).toHaveBeenCalledWith('Failed to deny request')
    expect(toast.success).not.toHaveBeenCalled()
  })

  // ════════════════════════════════════════════════════════════════════════
  // date-tooltips-and-folder-contrast task 6.7 -- Criteria 2.3, 3.1, 3.5,
  // 3.7, 3.8, 3.11.
  //
  // Both "Submitted" values are NON-TABLE Date_Render_Positions: `<p>`
  // elements inside cards, not cells inside an `overflow-x-auto` wrapper.
  // (requirements.md Criterion 3.4 counts eight table cells and names only
  // Admin's two as non-table; measured, it is six and four, and these are
  // two of the four -- design.md correction 1.) Criterion 3.8 is what this
  // block exists for: the surrounding element type must make NO difference
  // to the placement, so the application has one tooltip behaviour rather
  // than one per host.
  //
  // The text side of Criterion 2.3 is already asserted above, by the
  // `formatDate(TEAM_CHANGE_REQUEST.created_at)` assertion in the Req 16.1
  // test -- written before the adoption and reused unchanged.
  // ════════════════════════════════════════════════════════════════════════
  describe('both "Submitted" values disclose a Date_Tooltip (task 6.7)', () => {
    const hostIn = (card) => card.querySelector('span[tabindex="0"]')

    const tooltipFor = (host) => {
      const id = host && host.getAttribute('aria-describedby')
      return id ? document.getElementById(id) : null
    }

    const pointerOver = async (node) => {
      await act(async () => {
        node.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      })
    }

    it.each([
      ['team_change', () => teamChangeCard(), TEAM_CHANGE_REQUEST],
      ['new_account', () => newAccountCard(), NEW_ACCOUNT_REQUEST]
    ])('opens rightward from left-full/ml-2 on the %s card (Criteria 3.5, 3.8, 3.11)', async (
      _name,
      cardOf,
      request
    ) => {
      await mountPage()

      const card = cardOf()
      const host = hostIn(card)
      expect(host).not.toBeNull()
      // The label stays outside the component -- only the VALUE acquires the
      // disclosure, so the rendered string is unchanged.
      expect(host.textContent).toBe(formatDate(request.created_at))
      expect(host.hasAttribute('aria-describedby')).toBe(false)

      await pointerOver(host)
      const tooltip = tooltipFor(host)

      expect(tooltip).not.toBeNull()
      expect(tooltip.className).toContain('left-full')
      expect(tooltip.className).toContain('ml-2')
      expect(tooltip.className).toContain('top-1/2')
      expect(tooltip.className).toContain('-translate-y-1/2')
      expect(tooltip.className).not.toContain('right-full')
      expect(tooltip.className).not.toContain('mr-2')
      // Sideways, on a `<p>` host just as on a `<td>` one (Criterion 3.4).
      expect(card.innerHTML).not.toContain('top-full')
      expect(card.innerHTML).not.toContain('bottom-full')
      // The tooltip carries the Relative_Time phrase alone -- no resolved
      // zone appended.
      expect(tooltip.textContent.length).toBeGreaterThan(0)
    })

    it('carries the SAME placement classes as a table-cell position (Criterion 3.8)', async () => {
      await mountPage()
      const cardHost = hostIn(teamChangeCard())
      await pointerOver(cardHost)
      const cardTooltipClasses = tooltipFor(cardHost).className

      // The same shared component, the same `side`, hosted the way the six
      // TABLE positions are hosted: a `<td>` inside the `overflow-x-auto`
      // wrapper that produced the Tooltip_Clipping_Defect in the first
      // place. Compared byte for byte rather than by restating a class list,
      // because a restated list agrees with itself after someone changes the
      // component.
      const tableContainer = document.createElement('div')
      document.body.appendChild(tableContainer)
      const tableRoot = createRoot(tableContainer)
      await act(async () => {
        tableRoot.render(
          <div className="overflow-x-auto">
            <table>
              <tbody>
                <tr>
                  <td>
                    <FormattedDate
                      value={TEAM_CHANGE_REQUEST.created_at}
                      fallback=""
                      precision={DATE_PRECISION.DATE}
                      side={TOOLTIP_SIDES.RIGHT}
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      })
      const tableHost = tableContainer.querySelector('span[tabindex="0"]')
      await pointerOver(tableHost)

      expect(tooltipFor(tableHost).className).toBe(cardTooltipClasses)

      await act(async () => {
        tableRoot.unmount()
      })
      tableContainer.remove()
    })
  })
})

/**
 * cert-expiry-notifications Requirement 7.3/7.4/7.6 (task 14.5): the two
 * new renewal-list sections and their render conditions.
 */
describe('Requests page renewal sections (cert-expiry-notifications 7.3, 7.4, 7.6)', () => {
  let container
  let root
  let matchMediaStubbed = false

  const PLAIN_MEMBER = { userId: 42, isAdmin: false, isTeamAdmin: false, is_global_manager: false }
  const GLOBAL_MANAGER = { userId: 1, isAdmin: true, is_global_manager: true }

  // NOTE: the real self-view shape (DeviceManagementService.mapDevice) has NO
  // `username` field; these fixtures keep the (unused) `username` only so the
  // pre-existing tests around them read unchanged. The row identifies the
  // device by `clientUid` + `clientType` (its DeviceTypeIcon), never username.
  const SELF_DEVICE_DUE = {
    clientUid: 'ANDROID-self-due-1',
    clientType: 'android',
    username: 'jdoe-phone',
    expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() // already expired
  }
  const SELF_DEVICE_FINE = {
    clientUid: 'ANDROID-self-fine-1',
    clientType: 'android',
    username: 'jdoe-tablet',
    expiresAt: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000).toISOString() // 2 years out
  }

  const TEAM_DEVICE_DUE = {
    deviceUserId: 501,
    username: 'AUK-D0000AA',
    deviceLabel: null,
    teamName: 'Auckland',
    expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    canManage: true
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    container = document.createElement('div')
    document.body.appendChild(container)
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {}
      })
      matchMediaStubbed = true
    }
    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [] } })
    // Layout's nav gate calls the DEVICE_MGMT_ENABLED probe on mount; re-set
    // its default (clearAllMocks wiped it). Feature-off is fine here.
    deviceManagementAPI.probeEnabled.mockResolvedValue({ enabled: false })
    devicesAPI.getAll.mockResolvedValue({ data: { devices: [], pagination: { page: 1, pageSize: 200, total: 0 } } })
    // vi.clearAllMocks() above also clears the module-level default this
    // mock was given at definition time -- re-set it here, since the
    // Renew action's modal mounts the real EnrollmentView.jsx, which
    // reads configAPI.getPublic() on mount.
    configAPI.getPublic.mockResolvedValue({ data: {} })
    // Layout.jsx's own version-display mount effect calls this too.
    versionAPI.get.mockResolvedValue({ data: { version: '2026.9.0' } })
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

  const mount = async (user) => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/tasks']}>
          <Requests user={user} />
        </MemoryRouter>
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const cards = () => Array.from(container.querySelectorAll('.card'))
  const sectionCard = (heading) => cards().find((card) => card.querySelector('h2')?.textContent.includes(heading))

  describe('My certificates needing renewal (Requirement 7.3(a))', () => {
    it('renders nothing when the caller has no device needing renewal', async () => {
      deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [SELF_DEVICE_FINE] } })

      await mount(PLAIN_MEMBER)

      expect(sectionCard('My certificates needing renewal')).toBeUndefined()
    })

    it('renders the section for a plain member with a due device (visible to everyone)', async () => {
      deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [SELF_DEVICE_DUE, SELF_DEVICE_FINE] } })

      await mount(PLAIN_MEMBER)

      const card = sectionCard('My certificates needing renewal')
      expect(card).toBeDefined()
      // Bugfix: a self-owned device carries no `username` (the self-view's
      // mapDevice omits it), so the row identifies the device by its stable
      // `clientUid` -- the same way every other self-owned-device surface
      // does -- not by a `username` that was always blank here.
      expect(card.textContent).toContain(SELF_DEVICE_DUE.clientUid)
      expect(card.textContent).not.toContain(SELF_DEVICE_FINE.clientUid)
    })

    it('renders no section at all when device management is disabled (404)', async () => {
      deviceManagementAPI.getMyDevices.mockRejectedValue(
        Object.assign(new Error('Not Found'), { response: { status: 404 } })
      )

      await mount(PLAIN_MEMBER)

      expect(sectionCard('My certificates needing renewal')).toBeUndefined()
    })

    it('the Renew action links to /enrollment -- the same self-service flow, no new route (Requirement 6.2/7.4)', async () => {
      deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [SELF_DEVICE_DUE] } })

      await mount(PLAIN_MEMBER)

      const card = sectionCard('My certificates needing renewal')
      const renewLink = Array.from(card.querySelectorAll('a')).find((a) => a.textContent.trim() === 'Renew')
      expect(renewLink.getAttribute('href')).toBe('/enrollment')
    })
  })

  describe('Team devices needing renewal (Requirement 7.3(b))', () => {
    it('is never fetched/rendered for a plain, non-admin member', async () => {
      await mount(PLAIN_MEMBER)

      expect(devicesAPI.getAll).not.toHaveBeenCalled()
      expect(sectionCard('Team devices needing renewal')).toBeUndefined()
    })

    it('renders for a Team_Admin with a due team device', async () => {
      devicesAPI.getAll.mockResolvedValue({
        data: { devices: [TEAM_DEVICE_DUE], pagination: { page: 1, pageSize: 200, total: 1 } }
      })

      await mount(TEAM_ADMIN)

      expect(devicesAPI.getAll).toHaveBeenCalledWith(expect.objectContaining({ expiringOnly: true }))
      const card = sectionCard('Team devices needing renewal')
      expect(card).toBeDefined()
      expect(card.textContent).toContain(TEAM_DEVICE_DUE.username)
      expect(card.textContent).toContain(TEAM_DEVICE_DUE.teamName)
    })

    it('renders for a Global_Manager too', async () => {
      devicesAPI.getAll.mockResolvedValue({
        data: { devices: [TEAM_DEVICE_DUE], pagination: { page: 1, pageSize: 200, total: 1 } }
      })

      await mount(GLOBAL_MANAGER)

      expect(sectionCard('Team devices needing renewal')).toBeDefined()
    })

    it('renders no section when the fetch resolves an empty list', async () => {
      await mount(TEAM_ADMIN)

      expect(sectionCard('Team devices needing renewal')).toBeUndefined()
    })

    it('the Renew action opens the enrollment/QR-generation modal, calling devicesAPI.generateQrCode for that device', async () => {
      devicesAPI.getAll.mockResolvedValue({
        data: { devices: [TEAM_DEVICE_DUE], pagination: { page: 1, pageSize: 200, total: 1 } }
      })
      devicesAPI.previewQrCode.mockResolvedValue({ data: { preview: { host: 'tak.example.com' } } })
      devicesAPI.generateQrCode.mockResolvedValue({ data: { qrCode: {} } })

      await mount(TEAM_ADMIN)

      const card = sectionCard('Team devices needing renewal')
      const renewButton = Array.from(card.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Renew')
      await act(async () => {
        renewButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(container.querySelector('[aria-labelledby="renew-device-title"]')).not.toBeNull()
      expect(devicesAPI.previewQrCode).toHaveBeenCalledWith(TEAM_DEVICE_DUE.deviceUserId)
    })
  })

  describe('sections do not disturb the existing pending-request/OrgInterestRequests sections (Requirement 7.3 ordering)', () => {
    it('the existing "No pending requests" empty state still renders when both new sections are also empty', async () => {
      await mount(TEAM_ADMIN)

      expect(container.textContent).toContain('No pending requests')
    })

    it('a due self-device section renders ABOVE the existing pending-requests content in DOM order', async () => {
      deviceManagementAPI.getMyDevices.mockResolvedValue({ data: { devices: [SELF_DEVICE_DUE] } })

      await mount(TEAM_ADMIN)

      const allCards = cards()
      const selfSectionIndex = allCards.indexOf(sectionCard('My certificates needing renewal'))
      const emptyStateIndex = allCards.findIndex((c) => c.textContent.includes('No pending requests'))
      expect(selfSectionIndex).toBeGreaterThanOrEqual(0)
      expect(emptyStateIndex).toBeGreaterThan(selfSectionIndex)
    })
  })
})

/*
 * The /tasks page keeps its two device-renewal sections current on the shared
 * visibility-paused 60s interval (`startVisibilityPausedRefresh`, the same
 * mechanism the Dashboard/Admin cards use), mirroring Dashboard.test.jsx's
 * "My Devices" card auto-refresh block. It refreshes ONLY the device-renewal
 * fetches (deviceManagementAPI.getMyDevices for self devices,
 * devicesAPI.getAll for team devices) -- deliberately NOT the pending-requests
 * list, whose editable per-request callsign-suffix/name inputs a refetch would
 * clobber. This block asserts the tick/pause/resume/teardown lifecycle against
 * getMyDevices; the mount is the direct page (no Layout) so the only calls to
 * that mock are the ones this page makes.
 */
describe('Requests page device-renewal auto-refresh (visibility-paused 60s interval)', () => {
  const REFRESH_INTERVAL_MS = 60000
  let container
  let root
  let consoleErrorSpy
  let tabHidden

  const TEAM_ADMIN = { userId: 7, isAdmin: true, isTeamAdmin: true, is_global_manager: false }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // `document.hidden` is a getter on Document.prototype in jsdom with no
    // setter, so the tab's visibility is faked with an own property and
    // removed again in afterEach (the same approach as Dashboard.test.jsx).
    tabHidden = false
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => tabHidden
    })

    vi.useFakeTimers()

    container = document.createElement('div')
    document.body.appendChild(container)

    requestsAPI.getPending.mockResolvedValue({ data: { requests: [] } })
    // A fresh array of fresh objects per call so a refresh really does replace
    // the rendered list with different object identities.
    deviceManagementAPI.getMyDevices.mockImplementation(async () => ({
      data: { devices: [] }
    }))
    devicesAPI.getAll.mockResolvedValue({
      data: { devices: [], pagination: { page: 1, pageSize: 200, total: 0 } }
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount()
      })
      root = null
    }
    vi.useRealTimers()
    delete document.hidden
    container.remove()

    // Every tick drives React state updates from a timer callback, exactly
    // where an unwrapped-update warning would come from. console.error is
    // silenced (the page logs a failed fetch on purpose), so the warnings are
    // inspected here rather than being lost.
    const actWarnings = consoleErrorSpy.mock.calls.filter(
      ([first]) => typeof first === 'string' && first.includes('not wrapped in act')
    )
    vi.restoreAllMocks()
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    expect(actWarnings).toEqual([])
  })

  const mount = async () => {
    root = createRoot(container)
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/tasks']}>
          <Requests user={TEAM_ADMIN} />
        </MemoryRouter>
      )
    })
  }

  const tick = async (intervals = 1) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * intervals)
    })
  }

  const fireVisibilityChange = async (hidden) => {
    tabHidden = hidden
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  const selfFetchCount = () => deviceManagementAPI.getMyDevices.mock.calls.length
  const teamFetchCount = () => devicesAPI.getAll.mock.calls.length

  it('re-fetches both renewal sections on every interval tick while the tab is visible', async () => {
    await mount()

    // Mounting fetches once; the interval only schedules subsequent refreshes.
    expect(selfFetchCount()).toBe(1)
    expect(teamFetchCount()).toBe(1)

    await tick()
    expect(selfFetchCount()).toBe(2)
    expect(teamFetchCount()).toBe(2)

    await tick()
    expect(selfFetchCount()).toBe(3)

    // n ticks, n fetches -- including several in one advance. Both sections
    // tick on the SAME mechanism, so their counts stay in lockstep.
    await tick(3)
    expect(selfFetchCount()).toBe(6)
    expect(teamFetchCount()).toBe(6)
  })

  it('does NOT refetch the pending-requests list on a refresh tick (protects in-progress reviewer input)', async () => {
    await mount()
    expect(requestsAPI.getPending).toHaveBeenCalledTimes(1)

    await tick(3)

    // The device sections refreshed, but the editable pending-request list did
    // not -- a refetch would re-seed the per-request callsign-suffix/name maps
    // and wipe a reviewer's in-progress edits.
    expect(requestsAPI.getPending).toHaveBeenCalledTimes(1)
    expect(selfFetchCount()).toBe(4)
  })

  it('stops fetching while the tab is hidden, then fetches immediately when it becomes visible again', async () => {
    await mount()
    await tick()
    expect(selfFetchCount()).toBe(2)

    await fireVisibilityChange(true)
    const whileHidden = selfFetchCount()

    // The interval is CLEARED, not merely ignored: several intervals pass with
    // no fetch at all.
    await tick(5)
    expect(selfFetchCount()).toBe(whileHidden)

    // Becoming visible again refreshes IMMEDIATELY, without waiting out an
    // interval.
    await fireVisibilityChange(false)
    expect(selfFetchCount()).toBe(whileHidden + 1)

    // ...and the interval is restarted rather than left cleared.
    await tick()
    expect(selfFetchCount()).toBe(whileHidden + 2)
  })

  it('clears the interval and removes the visibilitychange listener on unmount', async () => {
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    await mount()
    await tick()
    const beforeUnmount = selfFetchCount()
    expect(beforeUnmount).toBe(2)

    await act(async () => {
      root.unmount()
    })
    root = null

    // No timer survives the component: several intervals pass with no fetch.
    await tick(5)
    expect(selfFetchCount()).toBe(beforeUnmount)

    // Nor does the listener: a visibilitychange after unmount would otherwise
    // call `refresh` on an unmounted tree.
    await fireVisibilityChange(false)
    expect(selfFetchCount()).toBe(beforeUnmount)
    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })
})
