// Client-side routes that must be fully usable by a completely anonymous
// visitor -- no session cookie, no authenticated API call of any kind.
// Shared between App.jsx (to skip the mount-time auth check on these
// paths) and services/api.js (to skip the global 401->/login redirect on
// these paths), so the two stay in sync and neither can drift from the
// other and reintroduce the redirect loop this list was added to fix.
export const PUBLIC_ONLY_PATHS = ['/request-access', '/verify-request']

export function isPublicOnlyPath(pathname) {
  return PUBLIC_ONLY_PATHS.includes(pathname)
}
