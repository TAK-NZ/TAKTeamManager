import { ShieldExclamationIcon } from '@heroicons/react/24/outline'

/**
 * Bugfix (Team Admins tab action-set mismatch): the Team Admins tab used
 * to render the IDENTICAL `MemberActions` group (Edit/Resend welcome/
 * Transfer/View devices/Delete account) the Members tab uses -- but
 * every one of those five actions is about managing this person AS A
 * MEMBER, not as an admin. This tab is about managing their ADMIN
 * STATUS specifically, and the one action that actually means -- "remove
 * this person's admin rights, leave their account and team membership
 * completely untouched" -- didn't exist anywhere in the UI at all,
 * despite the server-side primitive for it already existing:
 * `Team.addMember(teamId, userId, 'member')` is an upsert
 * (`INSERT ... ON CONFLICT (user_id, team_id) DO UPDATE SET role =
 * 'member'`), the exact same call `teamsAPI.addMember` already makes to
 * PROMOTE a member to admin (see `TeamDetail.jsx`'s
 * `handleAddExistingUser`) -- this component's action is that same call
 * with `role: 'member'` instead, reusing the identical
 * `POST /api/teams/:teamId/members` route and its existing
 * `team:members:add` authorization (Global_Manager, or a `Team.isAdmin`
 * of `:teamId`) rather than introducing a new capability.
 *
 * An admin is still a member underneath (every `team_memberships` row
 * this action touches keeps its `user_id`/`team_id`, only `role`
 * changes), so Edit/Resend/Transfer/View devices/Delete all remain
 * reachable for that same person via the Members tab -- this component
 * deliberately does not duplicate them.
 *
 * Bugfix: Suspend/Unsuspend previously ALSO appeared here as a
 * deliberate, narrow exception to that rule (an admin account needing
 * to be locked shouldn't require a tab-switch first). That exception is
 * now reverted: suspension is an action on the underlying ACCOUNT, not
 * the admin permission this tab manages, so it belongs on the Members
 * tab (and on `/users`) exclusively, matching every other account-level
 * action this component still declines to duplicate. Suspend/unsuspend
 * an admin from the Members tab -- their admin status is untouched
 * either way.
 *
 * Mirrors `MemberActions.jsx`'s `variant`/icon-sizing/colour convention
 * exactly (`'table'` bare `h-4 w-4` icon in a `space-x-3` row; `'card'`
 * wraps it in a `p-2 rounded-lg` button box for a real ~36px mobile tap
 * target), so the Team Admins tab's card/table rows stay visually
 * consistent with the Members tab's own row shape even though the
 * action set underneath is now different. Red-tinted always (not grey):
 * this is the tab's one action and it is a meaningful state change
 * (loss of admin authority), unlike `MemberActions`' grey neutral
 * actions which are comparatively low-stakes edits.
 *
 * @param {object} props
 * @param {{id: number}} props.member the admin row this action belongs
 *   to. `member.id` is the LOCAL `users.id` `onRemoveAdmin` is called
 *   with.
 * @param {boolean} [props.hasTeam] mirrors `MemberActions`' own prop of
 *   the same name: whether the caller may act on this row at all
 *   (`Team.isAdmin` of the row's team). Defaults to `true`, matching
 *   every current call site (`TeamDetail.jsx` only ever renders this
 *   component from inside its own `canManageTeam` gate, so both
 *   conditions already hold by the time this renders).
 * @param {string} [props.disabledReason] tooltip/aria-label text on the
 *   disabled action when `hasTeam` is false.
 * @param {(member: object) => void} props.onRemoveAdmin
 * @param {'table'|'card'} [props.variant]
 */
export default function AdminActions({
  member,
  hasTeam = true,
  disabledReason = 'This user has no team assignment',
  onRemoveAdmin,
  variant = 'table'
}) {
  const isCard = variant === 'card'
  const iconSizeClass = isCard ? 'h-5 w-5' : 'h-4 w-4'
  const boxClass = isCard ? 'p-2 rounded-lg' : ''
  const dangerClass = isCard
    ? 'bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-950/40 dark:hover:bg-red-900/60 dark:text-red-400'
    : 'text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300'
  const dangerDisabledClass = isCard
    ? 'bg-red-50/50 text-red-300 dark:bg-red-950/20 dark:text-red-800 cursor-not-allowed'
    : 'text-gray-400 dark:text-gray-600 cursor-not-allowed'

  return (
    <div className="flex items-center justify-end space-x-3">
      <button
        onClick={() => hasTeam && onRemoveAdmin(member)}
        disabled={!hasTeam}
        className={`${boxClass} ${hasTeam ? dangerClass : dangerDisabledClass}`}
        title={hasTeam ? 'Remove as admin (keeps their team membership)' : disabledReason}
        aria-label={hasTeam ? 'Remove as admin (keeps their team membership)' : disabledReason}
      >
        <ShieldExclamationIcon className={iconSizeClass} aria-hidden="true" />
      </button>
    </div>
  )
}
