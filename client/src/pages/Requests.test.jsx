import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import Requests, {
  getInitialCallsignSuffixMap,
  extractCallsignSuffixConflictError,
  formatPersonName
} from './Requests.jsx';
import Layout from '../components/Layout.jsx';
import { ThemeProvider } from '../contexts/ThemeContext.jsx';
import { requestsAPI } from '../services/api';
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
  // Layout.jsx imports authAPI, OrgInterestRequests.jsx imports adminAPI.
  // Neither is exercised here, but a named import of a missing export from
  // a mocked ES module is a load-time failure, so both are present.
  authAPI: { logout: vi.fn() },
  adminAPI: {}
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

  const mountPage = (user = TEAM_ADMIN) => mount(<Requests user={user} />)

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
  // appears once per copy; both carry the same count.
  const badgeCounts = () => Array.from(container.querySelectorAll('span'))
    .filter((s) => typeof s.className === 'string' && s.className.includes('bg-red-600'))
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
})
