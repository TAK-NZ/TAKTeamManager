// account-lifecycle-management Requirement 4.1-4.3 (task 8.2): a shared,
// pure helper for the per-row `account_status` text badge shown on the
// Members/Team Admins tabs (`TeamDetail.jsx`) and the Team Devices tab
// (`TeamDeviceList.jsx`). Pulled out to `client/src/utils/` (no React
// import, per the structure convention) so both pages/components can share
// one label/colour mapping without one importing from the other --
// `TeamDeviceList.jsx` is itself imported BY `TeamDetail.jsx`, so a helper
// defined in `TeamDetail.jsx` and re-imported from there would be a
// circular import.
//
// Text-based (never colour alone, per the accessibility steering rule):
// the label itself already says "Suspended"/"Account not found in
// Authentik"; the colour is an additional cue layered on top, not the
// only signal. Returns `null` for `'active'` (and for any value not in
// this table, e.g. a row fetched before this feature existed) so the
// caller renders no badge at all, matching every OTHER status-badge
// convention on this page (Visibility/Join Requests/Join Limited) of
// only showing a badge when there's something to say.

const SUSPENDED_BADGE_CLASS = 'px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
const ORPHANED_BADGE_CLASS = 'px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'

/**
 * @param {'active'|'suspended'|'orphaned'|null|undefined} accountStatus
 * @returns {{label: string, className: string}|null}
 */
export function describeAccountStatusBadge(accountStatus) {
  if (accountStatus === 'suspended') {
    return { label: 'Suspended', className: SUSPENDED_BADGE_CLASS }
  }
  if (accountStatus === 'orphaned') {
    return { label: 'Account not found in Authentik', className: ORPHANED_BADGE_CLASS }
  }
  return null
}
