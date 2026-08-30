import { PencilIcon, EnvelopeIcon, ArrowRightCircleIcon, DevicePhoneMobileIcon, TrashIcon } from '@heroicons/react/24/outline'

/**
 * Users-page-action-parity: the Edit/Resend welcome/Transfer/View
 * devices/Delete action-icon group, extracted from `TeamDetail.jsx` so
 * `Users.jsx` renders the IDENTICAL row actions for a user that came from
 * `GET /api/users` rather than a team's own Member_List -- same icons,
 * same colours, same tooltips, same click contract underneath.
 *
 * `TeamDetail.jsx` continues to import from here rather than keeping a
 * second copy of this markup, per the "extract a shared component when
 * BEHAVIOUR is duplicated" convention.
 *
 * Bugfix (misleading label): the last action's icon/tooltip previously
 * read "Remove from team" ("Remove from all teams..." for an inherited
 * row), which undersells what the confirmation dialog it opens actually
 * does and what the server does on confirm -- `DELETE /api/users/
 * remove-from-team/:userId` removes the user from EVERY team, clears
 * their TAK attributes, deletes their Authentik account entirely, and
 * deletes their local `users`/`user_cache` rows. This is a genuine,
 * deliberate exception to this app's usual "never delete a federated
 * identity" rule -- Global_Manager-only server-side (no resolver for
 * `user:team:remove` in `authorize.js`) precisely because of that
 * severity -- so the row action is now labelled "Delete user" to match
 * the confirmation dialog's own "Permanently Delete User" title rather
 * than reading as a milder, reversible action. The former
 * inherited-vs-direct wording split is dropped along with it: the
 * action is identical either way (a full account delete), so the two
 * different button colours/tooltips it used to carry were never a real
 * behavioural difference.
 *
 * @param {object} props
 * @param {{id: number}} props.member the row this action group belongs
 *   to. `member.id` is the LOCAL `users.id` every action below is keyed
 *   on.
 * @param {'member'|'admin'} props.roleLabel names the row in the Edit
 *   button's title ("Edit member"/"Edit admin") and is the role argument
 *   `onRemove` is called with.
 * @param {boolean} props.devicesEnabled gates the View Devices action,
 *   exactly like the header "Add Team Device" button and every other
 *   device-management affordance -- all exist only while
 *   `DEVICE_MGMT_ENABLED` is on.
 * @param {boolean} [props.hasTeam] Users-page-action-parity: whether
 *   EVERY action in this group (Edit, Resend, Transfer, View Devices,
 *   Delete) should be enabled for this row -- despite the name, this is
 *   NOT only "does this row have a team id"; it is "does this row have
 *   a team id AND may the caller act on it". `TeamDetail.jsx` never
 *   passes it (defaults `true`): the WHOLE `MemberActions` render there
 *   is already gated on the page-level `canManageTeam`, so by the time
 *   this component renders at all, both conditions already hold.
 *   `Users.jsx` computes it PER ROW as `Boolean(team_id) && can_manage`
 *   -- `team_id` because Edit needs one for its `PATCH /api/teams/
 *   :teamId/members/:userId` URL, Transfer's dialog has no meaningful
 *   Source_Team to display or exclude without one, and Delete's
 *   `teamId` body field is a required integer server-side; `can_manage`
 *   (from `GET /api/users`, mirroring `Team.isAdmin`'s ancestor-inclusive
 *   admin check) because `/users` must not be a wider-reaching escape
 *   hatch than `/teams`' own Member_List, where a Team_Admin can only
 *   act on a member of a team they administer or one of its descendants
 *   -- NOT every user their Organisation-wide DIRECTORY VISIBILITY
 *   happens to show them.
 *
 *   Resend and View Devices ALSO gate on this, even though neither
 *   technically NEEDS a `teamId` value the way Edit/Transfer/Delete do:
 *   the SERVER already scopes both independently (`user:resend_welcome
 *   :team_admin` walks the target's actual current teams via
 *   `Team.isAdmin`; View Devices' `isManagedUser` requires a shared
 *   admin-row/target-row team), so a non-Global_Manager caller who is
 *   not one of the row's team's admins would get a 403 from either
 *   endpoint today regardless of this prop. Disabling the button here
 *   is the client REFLECTING that existing server rule up front, not a
 *   new restriction of its own -- and it happens to be exactly `hasTeam`
 *   already, since a row this caller cannot manage-edit is a row this
 *   caller cannot resend-to/view-devices-for either, by the same
 *   Team_Admin relationship.
 * @param {string} [props.disabledReason] the tooltip/aria-label text
 *   shown on each disabled action when `hasTeam` is false, so the two
 *   distinct reasons above (no team assignment vs. not administered by
 *   this caller) read as the honest, different facts they are rather
 *   than one generic message. Defaults to the original "no team
 *   assignment" wording so every existing call site is unaffected.
 * @param {(member: object) => void} props.onEdit
 * @param {(member: object) => void} props.onResendWelcome
 * @param {(member: object) => void} props.onTransfer
 * @param {(member: object) => void} props.onViewDevices
 * @param {(userId: number, roleLabel: string) => void} props.onRemove
 * @param {'table'|'card'} [props.variant] bugfix (mobile tap targets too
 *   small): `'table'` (the default, matching every existing call site's
 *   prior behaviour unchanged) renders bare `h-4 w-4` icons in a
 *   `space-x-3` row -- a ~16px hit target, fine for a mouse-driven
 *   desktop table row. `'card'` -- used only by `TeamDetail.jsx`'s
 *   mobile card blocks (`Users.jsx` has no card/table split at all, so
 *   it never passes this) -- wraps each icon in a `p-2 rounded-lg`
 *   button box sized to match the header toolbar's own icon-only
 *   buttons (`Add Member`/`Add Team Device`, `h-5 w-5` icon), giving a
 *   real ~36px tap target. Grey background for every action except the
 *   destructive one (Delete/Remove), which gets a red-tinted box instead
 *   of red TEXT -- colour must still carry the "this one's different"
 *   signal once every action becomes an identically-shaped box, or that
 *   distinction disappears entirely.
 */
export default function MemberActions({
  member,
  roleLabel,
  devicesEnabled,
  hasTeam = true,
  disabledReason = 'This user has no team assignment',
  onEdit,
  onResendWelcome,
  onTransfer,
  onViewDevices,
  onRemove,
  variant = 'table'
}) {
  const noTeamTitle = disabledReason
  const isCard = variant === 'card'

  const iconSizeClass = isCard ? 'h-5 w-5' : 'h-4 w-4'
  const boxClass = isCard ? 'p-2 rounded-lg' : ''
  const neutralClass = isCard
    ? 'bg-gray-100 hover:bg-gray-200 text-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-300'
    : 'text-gray-600 hover:text-gray-500 dark:text-gray-400 dark:hover:text-gray-300'
  const neutralDisabledClass = isCard
    ? 'bg-gray-100 text-gray-400 dark:bg-gray-700 dark:text-gray-600 cursor-not-allowed'
    : 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
  const dangerClass = isCard
    ? 'bg-red-50 hover:bg-red-100 text-red-600 dark:bg-red-950/40 dark:hover:bg-red-900/60 dark:text-red-400'
    : 'text-red-600 hover:text-red-500 dark:text-red-400 dark:hover:text-red-300'
  const dangerDisabledClass = isCard
    ? 'bg-red-50/50 text-red-300 dark:bg-red-950/20 dark:text-red-800 cursor-not-allowed'
    : 'text-gray-400 dark:text-gray-600 cursor-not-allowed'

  return (
    <div className="flex items-center justify-end space-x-3">
      <button
        onClick={() => hasTeam && onEdit(member)}
        disabled={!hasTeam}
        className={`${boxClass} ${hasTeam ? neutralClass : neutralDisabledClass}`}
        title={hasTeam ? `Edit ${roleLabel}` : noTeamTitle}
        aria-label={hasTeam ? `Edit ${roleLabel}` : noTeamTitle}
      >
        <PencilIcon className={iconSizeClass} aria-hidden="true" />
      </button>
      <button
        onClick={() => hasTeam && onResendWelcome(member)}
        disabled={!hasTeam}
        className={`${boxClass} ${hasTeam ? neutralClass : neutralDisabledClass}`}
        title={hasTeam ? 'Resend welcome email' : noTeamTitle}
        aria-label={hasTeam ? 'Resend welcome email' : noTeamTitle}
      >
        <EnvelopeIcon className={iconSizeClass} aria-hidden="true" />
      </button>
      <button
        onClick={() => hasTeam && onTransfer(member)}
        disabled={!hasTeam}
        className={`${boxClass} ${hasTeam ? neutralClass : neutralDisabledClass}`}
        title={hasTeam ? 'Transfer member to another team' : noTeamTitle}
        aria-label={hasTeam ? 'Transfer member to another team' : noTeamTitle}
      >
        <ArrowRightCircleIcon className={iconSizeClass} aria-hidden="true" />
      </button>
      {/* Opens the shared UserDevicesModal for this member. `member.id` is
          the LOCAL `users.id`, which is what the device route is keyed
          on. Whether the caller may see this member's devices is the
          server's call (403 when the member is not a Managed_User of the
          caller), shown inside the modal -- `hasTeam` reflects that same
          rule client-side ahead of the request, per this component's own
          doc comment. */}
      {devicesEnabled && (
        <button
          onClick={() => hasTeam && onViewDevices(member)}
          disabled={!hasTeam}
          className={`${boxClass} ${hasTeam ? neutralClass : neutralDisabledClass}`}
          title={hasTeam ? 'View member devices' : noTeamTitle}
          aria-label={hasTeam ? 'View member devices' : noTeamTitle}
        >
          <DevicePhoneMobileIcon className={iconSizeClass} aria-hidden="true" />
        </button>
      )}
      {hasTeam ? (
        <button
          onClick={() => onRemove(member.id, roleLabel)}
          className={`${boxClass} ${dangerClass}`}
          title="Delete user (permanently removes their account)"
          aria-label="Delete user (permanently removes their account)"
        >
          <TrashIcon className={iconSizeClass} aria-hidden="true" />
        </button>
      ) : (
        <button
          disabled
          className={`${boxClass} ${dangerDisabledClass}`}
          title={noTeamTitle}
          aria-label={noTeamTitle}
        >
          <TrashIcon className={iconSizeClass} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
