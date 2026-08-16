import axios from 'axios';

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

// Handle auth errors. Auth state now lives in an httpOnly cookie the client
// can never read/write directly, so there is no localStorage token to clear
// here; on a 401 we simply redirect to the login page.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
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
  getMyTeams: () => api.get('/teams/my-teams'),
  getJoinable: () => api.get('/teams/joinable'),
  create: (data) => api.post('/teams', data),
  update: (id, data) => api.put(`/teams/${id}`, data),
  getById: (id) => api.get(`/teams/${id}`),
  addMember: (teamId, data) => api.post(`/teams/${teamId}/members`, data),
  getHierarchy: (id) => api.get(`/teams/${id}/hierarchy`),
  getSubTeams: (id) => api.get(`/teams/${id}/sub-teams`),
  delete: (id) => api.delete(`/teams/${id}`),
};

export const usersAPI = {
  getAll: () => api.get('/users'),
  create: (data) => api.post('/users', data),
  search: (query) => api.get(`/users/search?q=${query}`),
  getAvailable: (search) => api.get(`/users/available${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  createAndAdd: (email, firstName, lastName, teamId) => 
    api.post('/users/create-and-add', { email, firstName, lastName, teamId }),
  addToTeam: (userId, teamId) => api.post('/users/add-to-team', { userId, teamId }),
  removeFromTeam: (userId, teamId) => api.delete(`/users/remove-from-team/${userId}`, { data: { teamId } }),
  moveToHoldingPen: (userId) => api.post(`/users/${userId}/holding-pen`),
};

export const channelsAPI = {
  getByTeam: (teamId) => api.get(`/channels/team/${teamId}`),
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
  update: (key, data) => api.put(`/config/${key}`, data),
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

export default api;
