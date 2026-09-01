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
  // region-channel-tiers: Global_Manager-only, Organisation-only. data:
  // { responseChannelAccess?, supportChannelAccess? } -- deliberately a
  // SEPARATE endpoint from `update()` above (server/routes/teams.js's
  // `team:channel_access:manage` permission has no Team_Admin fallback,
  // unlike `team:update`).
  updateChannelAccess: (id, data) => api.put(`/teams/${id}/channel-access`, data),
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
  // `firstName`/`lastName`/`callsignSuffix` are optional corrections
  // reviewed on the "Add Existing User" tab -- this is the step that
  // turns a user who exists only in Authentik into a TAK Team Manager
  // -managed user, so a correction made here PERSISTS to the user's
  // account (not just this one team add). Omitted (or unchanged)
  // preserves the server's pre-existing behavior exactly.
  addToTeam: (userId, teamId, corrections = {}) =>
    api.post('/users/add-to-team', { userId, teamId, ...corrections }),
  removeFromTeam: (userId, teamId) => api.delete(`/users/remove-from-team/${userId}`, { data: { teamId } }),
  resendWelcome: (userId, teamId) => api.post(`/users/${userId}/resend-welcome`, { teamId }),
  // data: { targetTeamId, justification?, callsignSuffix? }. Resolves 200 with
  // { status: 'completed', ... } when the caller administers both sides, or 202
  // with { status: 'pending_approval', ... } when the move needs the other
  // team's approval; 400/403/404/409 reject with { error } in the body.
  transfer: (userId, data) => api.post(`/users/${userId}/transfer`, data),
  // account-lifecycle-management Requirement 1: suspend/unsuspend an
  // account (human member or Team_Owned_Device). Resolves 200 with
  // { userId, accountStatus }; 400 with { error } naming the account's
  // current status when the transition isn't valid from it (e.g.
  // suspending an already-suspended or orphaned account); 404 when
  // `userId` names no account.
  suspendAccount: (userId) => api.post(`/users/${userId}/suspend`),
  unsuspendAccount: (userId) => api.post(`/users/${userId}/unsuspend`),
};

export const channelsAPI = {
  getByTeam: (teamId) => api.get(`/channels/team/${teamId}`),
  getDescriptions: () => api.get('/channels/descriptions'),
  create: (data) => api.post('/channels', data),
  // Bugfix (Create Custom Channel dialog had no way to set a
  // description at creation time -- only via the later "Edit channel"
  // action): `description` is optional (a caller that omits it, or
  // passes an empty string, gets the server's own generated default).
  createCustom: (teamId, customSuffix, memberPermissions, description) => 
    api.post('/channels/custom', { teamId, customSuffix, memberPermissions, description }),
  addMember: (channelId, data) => api.post(`/channels/${channelId}/members`, data),
  removeMember: (channelId, userId) => api.delete(`/channels/${channelId}/members/${userId}`),
  getMembers: (channelId) => api.get(`/channels/${channelId}/members`),
  // Bugfix (Channels tab has no edit action, and no way to add/edit a
  // custom channel's Authentik/LDAP description): updates a CUSTOM
  // channel's description (server-side rejects a primary/team channel
  // with a 404 -- that one has no standalone edit path of its own).
  update: (channelId, data) => api.put(`/channels/${channelId}`, data),
  // Bugfix (Channels tab had no delete-channel action): deletes a
  // CUSTOM channel (server-side rejects a primary/team channel with a
  // 404 -- that one has no standalone delete path of its own).
  delete: (channelId) => api.delete(`/channels/${channelId}`),
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
  // region-channel-tiers: seeds the standard 35-channel Response/Support
  // set (16 regions x 2 tiers + Chatham Islands x 2 tiers + National
  // support-only) -- see server/services/GlobalChannelService.
  // seedRegionChannels's own doc comment.
  seedRegionChannels: () => api.post('/global-channels/seed-regions'),
  // region-channel-tiers (bugfix): backs the "hide Seed button once
  // complete" UI check.
  getRegionSeedStatus: () => api.get('/global-channels/region/seed-status'),
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
  getOrgInterest: (params) => api.get('/admin/org-interest', { params }),
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
  // Bugfix (BUG-014): the Admin page's Colour Mappings / Role Descriptions
  // tabs must read/write the DATABASE-backed system_config rows through
  // these two endpoints, not the legacy env-var-backed
  // GET /api/config/color-mappings (configAPI.getColorMappings), which has
  // no PUT counterpart at all -- that mismatch is why edits used to appear
  // to save (local state updated) but silently revert on reload.
  // Response/request shape for both: { colorMappings: {...}, roleDescriptions: {...} }.
  getTakMappings: () => api.get('/settings/tak-mappings'),
  // updates: { [config_key]: newValue, ... } -- keyed by the raw
  // tak_color_*/tak_role_* config_key, not the display label.
  updateTakMappings: (updates) => api.put('/settings/tak-mappings', { updates }),
};

// --- Device management (device-management spec) ---
//
// The server mounts /api/device-management only WHILE DEVICE_MGMT_ENABLED is
// true, and each handler re-checks the flag and answers 404 when it's off. The
// flag is deliberately never exposed through /api/config/public (Requirement
// 1.4), so the client can't ask "is this feature on?" up front -- and there is
// no dedicated /enabled endpoint either. `probeEnabled()` below therefore uses
// the self-view itself as the reachability probe: a 200 means the feature is
// live (and hands back the device list, so a caller that renders immediately
// needs no second request), while a 404 means the feature is off.
//
// Anything else (network failure, 5xx, 401/403) is a REAL error and is
// rethrown rather than folded into `enabled: false`, so a caller can tell
// "feature intentionally off" (hide the surface silently) apart from
// "something broke" (surface an error) -- collapsing both into a falsy result
// would silently hide the device UI whenever the backend hiccups.
export const deviceManagementAPI = {
  // Resolves 200 with { devices: [...] }; each device carries
  // { clientUid, issuedAt, expiresAt, lastSeenAt } where a null `lastSeenAt`
  // means "never seen" (Requirements 5.1, 5.2, 5.3).
  getMyDevices: () => api.get('/device-management/me/devices'),

  // Admin view of a Managed_User's devices (Requirements 6.3, 6.4, 6.5).
  // Rejects with 403 when `userId` is not a Managed_User of the caller.
  getUserDevices: (userId) =>
    api.get(`/device-management/users/${encodeURIComponent(userId)}/devices`),

  // Self-service revocation (Requirement 7.4). `confirmation` must be the
  // exact string 'REVOKE'; the server re-validates it and rejects with 400
  // without enqueueing anything otherwise (Requirement 7.3). Resolves 202
  // with { enqueued: true } once the Revoke_Operation is queued.
  //
  // `clientUid` is TAK-supplied free-form text, so it's percent-encoded
  // rather than interpolated raw into the path.
  revokeMyDevice: (clientUid, confirmation) =>
    api.post(
      `/device-management/me/devices/${encodeURIComponent(clientUid)}/revoke`,
      { confirmation }
    ),

  // Admin revocation of a Managed_User's device (Requirement 8.4). Same
  // confirmation contract as revokeMyDevice; rejects with 403 when the target
  // isn't a Managed_User of the caller or the device isn't theirs.
  revokeUserDevice: (userId, clientUid, confirmation) =>
    api.post(
      `/device-management/users/${encodeURIComponent(userId)}/devices/${encodeURIComponent(clientUid)}/revoke`,
      { confirmation }
    ),

  // Reachability probe used to decide whether to render the device surfaces.
  // Resolves { enabled: true, devices } when the feature is live, or
  // { enabled: false, devices: [] } when the server reports 404 (flag off).
  // Rethrows every other failure.
  probeEnabled: async () => {
    try {
      const response = await deviceManagementAPI.getMyDevices();
      return { enabled: true, devices: response.data?.devices ?? [] };
    } catch (error) {
      if (error.response?.status === 404) {
        return { enabled: false, devices: [] };
      }
      throw error;
    }
  },
};

// --- TAK Server enrollment (takserver-enrollment spec) ---
//
// Two capabilities, two routes, one shared response shape (`#buildEnrollment`
// on the server): a signed-in user's own enrollment, and a Team_Owned_Device's.
// The response is secret material -- it carries a live Authentik app_password
// token in the ATAK URI, the iTAK payload and both QR data URLs. Callers MUST
// keep it in component state for the life of the view only: never localStorage,
// never sessionStorage, and never a URL, so a token cannot outlive the tab or
// land in browser history (Criterion 11.5).

export const enrollmentAPI = {
  // Self-service enrollment for the caller's own account. No route params and
  // no body: the subject is always resolved server-side from the session
  // (Requirement 3.4), so there is nothing here for a caller to tamper with.
  generateSelf: () => api.post('/enrollment/me'),
  // Client UX correction: resolves the "Enrollment Data" section's fields
  // (host, username, Callsign/Color/Role, live certificate count) WITHOUT
  // minting an Enrollment_Token, so the Enrollment_View can call this
  // automatically on mount without minting a live credential just because
  // the page loaded. Minting only happens from generateSelf(), and only in
  // response to an explicit "Generate Enrollment Data" click.
  previewSelf: () => api.get('/enrollment/me/preview'),
};

export const devicesAPI = {
  // Org-wide Team_Owned_Device listing backing the `/devices` page,
  // mirroring `usersAPI.getAll()`'s own shape: `{ devices, pagination }`.
  // `params` is `{ page?, pageSize?, search? }`; `stripEmptyParams` drops
  // an absent/empty value rather than sending it as a literal empty
  // string, matching `auditLogsAPI.getAuditLogs`'s own convention.
  getAll: (params = {}) => api.get('/devices', { params: stripEmptyParams(params) }),

  // Creates a brand-new Team_Owned_Device for `teamId` (Requirement 27
  // Criteria 2, 4). `label` and `callsignSuffix` are both optional --
  // `callsignSuffix` is checked server-side against the SAME per-team
  // uniqueness rule a human member's callsign suffix is checked against
  // (`checkCallsignSuffixUniqueness`), so a caller should be ready to
  // handle a 400 naming a colliding value.
  create: (teamId, label, callsignSuffix) => api.post('/devices', { teamId, label, callsignSuffix }),

  // A Team's Team_Owned_Devices, for that Team's admin (Criterion 14.7). Each
  // device carries no email field at all -- a device has none (Criterion 5.10).
  getTeamDevices: (teamId) => api.get(`/devices/team/${teamId}`),

  // Mints a fresh Enrollment_Token and QR codes for an existing
  // Team_Owned_Device. Response carries the same secret-material shape as
  // `enrollmentAPI.generateSelf()`, under the `qrCode` key (Criteria 4.1,
  // 4.3, 11.5) -- callers must keep it in component state only, per the note
  // above `enrollmentAPI`.
  generateQrCode: (deviceUserId) => api.post(`/devices/${deviceUserId}/qr-code`),
  // The preview counterpart of generateQrCode: resolves the same
  // "Enrollment Data" fields for a Team_Owned_Device without minting a
  // token, matching enrollmentAPI.previewSelf()'s no-mint contract.
  previewQrCode: (deviceUserId) => api.get(`/devices/${deviceUserId}/preview`),

  // Bugfix ("unable to edit ... a team device"): updates an existing
  // device's label/callsign suffix. `updates` is `{deviceLabel?,
  // callsignSuffix?}`; either key may be omitted to leave that column
  // untouched. A colliding callsignSuffix comes back as a 400 naming
  // the conflicting value, same shape as `create` above.
  update: (deviceUserId, updates) => api.patch(`/devices/${deviceUserId}`, updates),

  // Bugfix ("unable to ... delete a team device"): permanently removes
  // an existing device (team membership, Authentik user, and local
  // account).
  delete: (deviceUserId) => api.delete(`/devices/${deviceUserId}`),
};

export default api;
