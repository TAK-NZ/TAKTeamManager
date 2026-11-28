// Text badge for an account that has not signed in yet (`activation_status` from GET /api/users). Nothing for an
// activated account or an unknown status (null: no window was recorded), so an ordinary row carries no badge.
// Always text, never colour alone.
const INVITED_BADGE_CLASS = 'px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
const EXPIRED_BADGE_CLASS = 'px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
/**
 * @param {'active'|'invited'|'expired'|null|undefined} activationStatus
 * @returns {{label: string, className: string, title: string}|null}
 */
export function describeActivationBadge(activationStatus) {
  if (activationStatus === 'invited') {
    return { label: 'Invited', className: INVITED_BADGE_CLASS, title: 'Has not signed in yet. The activation link is still valid.' }
  }
  if (activationStatus === 'expired') {
    return {
      label: 'Not activated',
      className: EXPIRED_BADGE_CLASS,
      title: 'Never signed in, and the activation window has passed. Resend the welcome email to open a new one.'
    }
  }
  return null
}
