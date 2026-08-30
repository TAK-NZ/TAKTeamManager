/**
 * Users-page-action-parity: pure helpers for the "Create New User" form,
 * shared between `TeamDetail.jsx`'s Add Member Dialog and `Users.jsx`'s
 * Create User dialog. No React import, no API import -- following the
 * convention of `callsignSuffixPreview.js`/`channelTree.js` so the
 * validation logic is directly unit-testable independent of rendering.
 */

/**
 * Pure email-format validator for a "Create New User" form's Email
 * Address input. An empty value is treated as invalid here because the
 * field is required.
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isValidNewUserEmail(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  // Pragmatic single-@ check with non-empty local part and a dotted domain.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
}

/**
 * Pure helper extracting an inline Callsign Suffix error message from a
 * rejected `usersAPI.createAndAdd` call, or `null` when the failure is not
 * a shaped 400 (the server returns `{ error: <message> }` with status 400
 * for both the `user_defined`-suffix-required and the per-team collision
 * cases; every other failure keeps the caller's existing generic-toast
 * behavior).
 *
 * @param {{response?: {status?: number, data?: {error?: string}}}} error
 * @returns {string|null}
 */
export function extractCallsignSuffixServerError(error) {
  const status = error?.response?.status
  const serverError = error?.response?.data?.error
  if (status === 400 && typeof serverError === 'string') {
    return serverError
  }
  return null
}
