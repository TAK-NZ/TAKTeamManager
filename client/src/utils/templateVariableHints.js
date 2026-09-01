/**
 * Advisory Template_Variable_Hints for the Email Template Editor
 * (admin-settings-management, task 3.1). Pure, framework-free data plus a small
 * accessor, following the convention of `callsignSuffixPreview.js` and
 * `directoryScopeMessage.js` so the map is directly unit- and property-testable
 * without rendering a component.
 *
 * IMPORTANT: this map is ADVISORY ONLY and is NOT enforced anywhere. It exists
 * purely to hint to an operator which `{{variable}}` placeholders a given
 * template commonly uses. Nothing validates a template's body against it: an
 * unrecognised `{{placeholder}}` is left as literal text at send time by the
 * server's EmailService, and a template with no hint entry here still renders
 * and remains fully editable (Requirements 5.1, 5.2, 5.4).
 *
 * @type {Readonly<Record<string, string[]>>}
 */
export const TEMPLATE_VARIABLE_HINTS = {
  access_request_verification: ['first_name', 'verification_link', 'team_path', 'expiry_hours'],
  access_request_approved: ['first_name', 'team_path', 'callsign', 'username', 'password_reset_url'],
  access_request_denied: ['first_name', 'team_path', 'denial_reason'],
  admin_notification_digest: ['pending_count', 'request_list'],
  signup_pending_review: ['first_name', 'team_path'],
  signup_already_active: ['first_name', 'username'],
  team_transfer_completed: ['first_name', 'team_path', 'callsign', 'username'],
  cert_expiry_self_digest: ['first_name', 'device_list', 'revoke_hint_url'],
  cert_expiry_team_digest: ['first_name', 'team_sections', 'revoke_hint_url']
}

/**
 * The advisory variable-name list for a Template_Key. Returns a NEW empty array
 * (never `undefined`) for an unknown, missing, or non-string key, so a template
 * with no hint entry still renders and remains editable (Requirement 5.2).
 *
 * @param {string} key   the Template_Key to look up
 * @returns {string[]}   advisory variable names, or a fresh empty array
 */
export function getVariableHints(key) {
  if (typeof key !== 'string') {
    return []
  }
  if (!Object.prototype.hasOwnProperty.call(TEMPLATE_VARIABLE_HINTS, key)) {
    return []
  }
  return TEMPLATE_VARIABLE_HINTS[key]
}
