'use strict';
/**
 * Whether a person has activated their account, for the user list.
 *
 * "Activated" means they have signed in to Authentik at least once (`user_cache.last_login`, mirrored by sync). Until
 * then, the account is "invited" while the activation window that Team Manager opened with the link is still open
 * (`users.activation_expires_at`), and "expired" once it has passed (ActivationExpiryJob then suspends the account).
 * With no sign-in and no recorded window (an account from before the window was recorded, or one Team Manager never
 * made a link for) nothing is known, so the status is null and the account is never presented as unactivated.
 *
 * @param {{last_login?: Date|string|null, activation_expires_at?: Date|string|null}} row
 * @param {Date} [now]
 * @returns {'active'|'invited'|'expired'|null}
 */
function deriveActivationStatus(row, now = new Date()) {
  if (row && row.last_login) {
    return 'active';
  }
  const expiresAt = row && row.activation_expires_at ? new Date(row.activation_expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    return null;
  }
  return expiresAt.getTime() > now.getTime() ? 'invited' : 'expired';
}
module.exports = { deriveActivationStatus };
