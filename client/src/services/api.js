import axios from 'axios';
import { isPublicOnlyPath } from '../utils/publicPaths';

// --- Backend base URL configuration (Requirements 2.1, 2.2, 2.3, 2.7, 2.8) ---
//
// The backend base URL is derived from a single configurable source,
// `VITE_API_BASE_URL`, defaulting to the same-origin relative path ('')
// when unset. It is validated once at module load so a misconfigured value
// can never silently be used to construct login/API URLs.
//
// Validation approach: `new URL(value, window.location.origin)` succeeds
// for almost any non-empty string (it happily resolves "not a url" into
// "http://origin/not a url"), so using it alone would make the "invalid"
// branch unreachable and the check meaningless. Instead:
//   - '' (unset) is always valid -> same-origin relative path.
//   - A value starting with http:// or https:// must be a fully valid
//     absolute URL per the native URL parser.
//   - A value containing a "scheme://" prefix that is NOT http(s) (e.g.
//     "javascript://", "ftp://") is rejected outright.
//   - A value containing whitespace/control characters is rejected, since
//     that can never be a legitimate absolute URL or relative path base.
//   - Anything else is treated as a relative path base and must still
//     parse via `new URL(value, window.location.origin)`.
const rawBase = import.meta.env.VITE_API_BASE_URL ?? '';

export function isValidBaseUrl(value) {
  if (value === '') {
    return true;
  }
  if (/\s/.test(value)) {
    return false;
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      // eslint-disable-next-line no-new
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    // A non-http(s) scheme (javascript:, ftp:, data:, etc.) is never a valid
    // backend base URL.
    return false;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(value, window.location.origin);
    return true;
  } catch {
    return false;
  }
}

let validatedBase = '';
try {
  if (!isValidBaseUrl(rawBase)) {
    throw new Error(
      `VITE_API_BASE_URL is not a syntactically valid absolute URL or relative path: "${rawBase}"`
    );
  }
  validatedBase = rawBase;
} catch (err) {
  // Requirement 2.7: log a descriptive error and do NOT attempt to construct
  // login/API URLs from the invalid value. Fall back to a safe same-origin
  // default so the app doesn't completely break.
  // eslint-disable-next-line no-console
  console.error('[api] Invalid backend base URL configuration:', err.message);
  validatedBase = '';
}
// Requirement 2.8: when the value is valid, no error is logged and
// `validatedBase` is used as-is below.

function joinBaseAndPath(base, path) {
  if (!base) {
    return path;
  }
  return `${base.replace(/\/+$/, '')}${path}`;
}

const apiOrigin = (() => {
  try {
    return new URL(validatedBase || window.location.origin, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
})();

const api = axios.create({
  baseURL: joinBaseAndPath(validatedBase, '/api'),
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Whether a 401 response, observed while the browser is at `pathname`,
// should force-navigate to /login. Exported as a standalone pure function
// (rather than inlined in the interceptor below) so its exclusion logic
// can be unit tested directly without needing to simulate a full axios
// error/response cycle.
//
// Exclusions, to avoid an endless redirect loop: never force-navigate
// away from a page that's intentionally usable by an anonymous visitor
// (/request-access -- see utils/publicPaths.js), and never force-navigate
// when already on /login itself (a 401 there is expected/normal, not a
// session that just expired mid-use).
export function shouldRedirectToLogin(status, pathname) {
  return status === 401 && pathname !== '/login' && !isPublicOnlyPath(pathname);
}

// Handle auth errors. Auth state now lives in an httpOnly cookie the client
// can never read/write directly, so there is no localStorage token to clear
// here; on a 401 we simply redirect to the login page (subject to the
// exclusions in shouldRedirectToLogin above).
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (shouldRedirectToLogin(error.response?.status, window.location.pathname)) {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authAPI = {
  login: () => {
    window.open(joinBaseAndPath(validatedBase, '/api/auth/login'), '_self');
  },
  silentLogin: () => {
    return new Promise((resolve, reject) => {
      // Open small popup window for silent auth check
      const popup = window.open(
        joinBaseAndPath(validatedBase, '/api/auth/silent'),
        'silent-auth',
        'width=1,height=1,left=-1000,top=-1000'
      )

      // Requirement 2.6: if the popup doesn't deliver a postMessage response
      // within 5 seconds, close it, stop listening for a (now-stale) message,
      // and fall back to the standard interactive login flow ourselves so
      // callers don't each need to re-implement that fallback on rejection.
      const timeout = setTimeout(() => {
        popup?.close()
        window.removeEventListener('message', handler)
        reject(new Error('Silent login timeout'))
        authAPI.login()
      }, 5000)

      function handler(event) {
        // Requirement 2.5: discard any message whose origin doesn't match
        // the configured backend base URL's origin, without trusting
        // event.data in any way, before doing anything else.
        if (event.origin !== apiOrigin) return

        clearTimeout(timeout)
        popup?.close()
        window.removeEventListener('message', handler)

        if (event.data.success) {
          window.location.href = event.data.redirectUrl
          resolve()
        } else {
          // The popup responded, but there was no valid session. This is
          // distinct from the timeout case (Requirement 2.6 only mandates
          // the interactive-login fallback when no response arrives at
          // all), so this path stays a plain rejection for the caller to
          // handle (e.g. by showing the login page).
          reject(new Error('No valid session'))
        }
      }

      window.addEventListener('message', handler)
    })
  },
  logout: () => api.post('/auth/logout'),
  getProfile: () => api.get('/auth/me'),
};

export const teamsAPI = {
  // params: { page?, pageSize? } -- optional pagination query params for
  // the admin "all teams" branch of GET /teams/my-teams (see
  // server/routes/teams.js); omitted entirely for existing callers that
  // don't need pagination (Teams.jsx, TeamDetail.jsx), matching the
  // regular-user branch which ignores pagination anyway.
  getMyTeams: (params = {}) => api.get('/teams/my-teams', { params }),
  getJoinable: () => api.get('/teams/joinable'),
  create: (data) => api.post('/teams', data),
  update: (id, data) => api.put(`/teams/${id}`, data),
  getById: (id) => api.get(`/teams/${id}`),
  addMember: (teamId, data) => api.post(`/teams/${teamId}/members`, data),
  getHierarchy: (id) => api.get(`/teams/${id}/hierarchy`),
  getSubTeams: (id) => api.get(`/teams/${id}/sub-teams`),
  delete: (id) => api.delete(`/teams/${id}`),
  getCallsignLevelOptions: (id) => api.get(`/teams/${id}/callsign-level-options`),
  updateMember: (teamId, userId, data) => api.patch(`/teams/${teamId}/members/${userId}`, data),
};

export const bulkImportAPI = {
  importTeams: (formData) => api.post('/bulk-import/teams', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
};

export const usersAPI = {
  getAll: () => api.get('/users'),
  getMe: () => api.get('/users/me'),
  create: (data) => api.post('/users', data),
  search: (query) => api.get(`/users/search?q=${query}`),
  getAvailable: (search) => api.get(`/users/available${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  // `callsignSuffix` is optional: omitted (or empty) lets the server compute
  // the Organisation's default, and is rejected with 400 when the
  // Organisation's `callsign_name_format` is `user_defined`. Trailing so
  // existing 5-argument call sites keep working unchanged.
  createAndAdd: (email, firstName, lastName, teamId, role, callsignSuffix) =>
    api.post('/users/create-and-add', { email, firstName, lastName, teamId, role, callsignSuffix }),
  // Advisory pre-submit check for the Callsign_Suffix a new team member would
  // be given. data: { teamId, firstName, lastName, callsignSuffix? }. Resolves
  // 200 with { suffix: string|null, required: boolean, conflict: { value,
  // message }|null } -- `suffix` is the value the server would store,
  // `required` is true only when the Organisation's format is `user_defined`
  // and no suffix was supplied, and `conflict` is non-null when the resolved
  // value collides case-insensitively with an existing member of that team.
  previewCallsignSuffix: (data) => api.post('/users/callsign-suffix-preview', data),
  addToTeam: (userId, teamId) => api.post('/users/add-to-team', { userId, teamId }),
  removeFromTeam: (userId, teamId) => api.delete(`/users/remove-from-team/${userId}`, { data: { teamId } }),
  resendWelcome: (userId, teamId) => api.post(`/users/${userId}/resend-welcome`, { teamId }),
  // data: { targetTeamId, justification?, callsignSuffix? }. Resolves 200 with
  // { status: 'completed', ... } when the caller administers both sides, or 202
  // with { status: 'pending_approval', ... } when the move needs the other
  // team's approval; 400/403/404/409 reject with { error } in the body.
  transfer: (userId, data) => api.post(`/users/${userId}/transfer`, data),
};

export const channelsAPI = {
  getByTeam: (teamId) => api.get(`/channels/team/${teamId}`),
  getDescriptions: () => api.get('/channels/descriptions'),
  create: (data) => api.post('/channels', data),
  createCustom: (teamId, customSuffix, memberPermissions) => 
    api.post('/channels/custom', { teamId, customSuffix, memberPermissions }),
  addMember: (channelId, data) => api.post(`/channels/${channelId}/members`, data),
  removeMember: (channelId, userId) => api.delete(`/channels/${channelId}/members/${userId}`),
  getMembers: (channelId) => api.get(`/channels/${channelId}/members`),
};

export const requestsAPI = {
  submitTeamAccess: (data) => api.post('/requests/team-access', data),
  getPending: () => api.get('/requests/pending'),
  approveRequest: (requestId, data) => api.post(`/requests/${requestId}/approve`, data),
  denyRequest: (requestId, data) => api.post(`/requests/${requestId}/deny`, data),
  verifyEmail: (token) => api.get(`/requests/verify/${token}`),
};

export const configAPI = {
  getPublic: () => api.get('/config/public'),
  getAll: () => api.get('/config/all'),
  getColorMappings: () => api.get('/config/color-mappings'),
  update: (key, data) => api.put(`/config/${key}`, data),
};

export const syncAPI = {
  getStatus: () => api.get('/sync/status'),
  triggerUserSync: () => api.post('/sync/users'),
};

export const globalChannelsAPI = {
  getBchChannels: () => api.get('/global-channels/bch'),
  getRegionChannels: () => api.get('/global-channels/region'),
  createBchChannel: (data) => api.post('/global-channels/bch', data),
  createRegionChannel: (data) => api.post('/global-channels/region', data),
  updateBchChannel: (channelId, data) => api.put(`/global-channels/bch/${channelId}`, data),
  updateRegionChannel: (channelId, data) => api.put(`/global-channels/region/${channelId}`, data),
  getBchCredentials: (channelId) => api.get(`/global-channels/bch/${channelId}/credentials`),
  assignAllUsers: () => api.post('/global-channels/assign-all-users'),
  deleteChannel: (channelType, channelId) => api.delete(`/global-channels/${channelType}/${channelId}`),
  syncExistingChannels: () => api.post('/global-channels/sync-existing'),
};

// Removes any filter key whose value is '', null, or undefined, so an
// unset filter field is never sent to the server at all. This matters
// because axios's `params` serialization does NOT omit empty strings --
// `{ userId: '' }` is sent as the literal querystring `userId=` (present,
// just empty), not left off entirely. The server's `express-validator`
// `.optional()` chains (see server/routes/auditLogs.js) only skip
// validation when a field is fully ABSENT from the querystring; an
// empty-but-present value still runs through `.isInt()`/`.isISO8601()`
// and fails, producing a 400. Both `getAuditLogs` and `buildExportUrl`
// below must filter through this before handing filters to axios/
// URLSearchParams, so this one fix cannot be bypassed by a future caller
// that forgets to filter itself.
function stripEmptyParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== '' && v != null)
  );
}

export const auditLogsAPI = {
  // filters: { userId?, action?, resourceType?, teamId?, startDate?, endDate? }
  // pageParams: { page, pageSize }
  getAuditLogs: (filters = {}, pageParams = {}) =>
    api.get('/audit-logs', { params: stripEmptyParams({ ...filters, ...pageParams }) }),

  // Builds the absolute export URL (including the same base-URL handling
  // used by authAPI.login()) rather than making an axios call, since the
  // caller navigates the browser directly to this URL for the file
  // download (see design.md "CSV Export Flow").
  buildExportUrl: (filters = {}) => {
    const params = new URLSearchParams(stripEmptyParams(filters));
    const query = params.toString();
    return joinBaseAndPath(validatedBase, `/api/audit-logs/export.csv${query ? `?${query}` : ''}`);
  },
};

// --- Sign-up flow APIs (signup-flow-rework spec) ---

export const signupAPI = {
  initiate: (email, code, recaptchaToken) => api.post('/requests/initiate', { email, code, 'g-recaptcha-response': recaptchaToken }),
  getAvailableTeams: (token) => api.get(`/requests/available-teams?token=${token}`),
  submitTeamAccess: (data) => api.post('/requests/team-access', data),
  submitOrgInterest: (data) => api.post('/org-interest', data),
};

export const signupCodesAPI = {
  generate: (teamId) => api.post('/signup-codes/generate', { teamId }),
  get: (teamId) => api.get(`/signup-codes/${teamId}`),
  revoke: (teamId) => api.delete(`/signup-codes/${teamId}`),
  getQr: (teamId) => api.get(`/signup-codes/${teamId}/qr`, { responseType: 'blob' }),
  getPdf: (teamId) => api.get(`/signup-codes/${teamId}/pdf`, { responseType: 'blob' }),
};

export const orgDomainsAPI = {
  get: (orgId) => api.get(`/orgs/${orgId}/domains`),
  update: (orgId, domains) => api.put(`/orgs/${orgId}/domains`, { domains }),
};

export const adminAPI = {
  getExcludedDomains: () => api.get('/admin/excluded-domains'),
  updateExcludedDomains: (domains) => api.put('/admin/excluded-domains', { domains }),
  getOrgInterest: () => api.get('/admin/org-interest'),
  updateOrgInterest: (id, status) => api.patch(`/admin/org-interest/${id}`, { status }),
};

// --- Admin settings management (admin-settings-management spec) ---

export const communicationsAPI = {
  listTemplates: () => api.get('/communications/templates'),
  getTemplate: (key) => api.get(`/communications/templates/${key}`),
  // body: { subjectTemplate?, bodyTemplate? } -- caller includes only changed fields
  updateTemplate: (key, body) => api.put(`/communications/templates/${key}`, body),
  // body: { targetEmail, templateKey?, variables? }
  sendTestEmail: (body) => api.post('/communications/test-email', body),
};

export const settingsAPI = {
  // Blob response so the Admin page can hand the archive to the browser as a download.
  exportSettings: () => api.get('/settings/export', { responseType: 'blob' }),
  // payload: { systemConfig, siteConfig, emailTemplates? }
  importSettings: (payload) => api.post('/settings/import', payload),
};

export default api;
