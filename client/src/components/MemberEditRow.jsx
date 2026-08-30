/**
 * Users-page-action-parity: the Member_List inline edit row, extracted
 * from `TeamDetail.jsx` so `Users.jsx` can render the identical Edit
 * affordance (First Name, Last Name, TAK Role, Callsign Suffix) for a
 * row that came from `GET /api/users` rather than `GET /api/teams/:teamId`
 * -- the same component, the same fields, the same
 * `PATCH /api/teams/:teamId/members/:userId` contract underneath, so the
 * two surfaces cannot drift on what "Edit" means.
 *
 * `TeamDetail.jsx` continues to import from here (and re-exports the pure
 * helpers below for its own existing test file's import path), rather
 * than keeping a second copy -- Requirement noted in
 * `client-conventions`/`structure` steering: "extract a shared component
 * when BEHAVIOUR is duplicated."
 */

/**
 * Mirrors `server/utils/callsignValidation.js`'s `isValidCallsignSuffix`
 * character class (letters, digits, `-`, `.`) as an HTML `pattern`,
 * matching the same convention already used by `RequestAccess.jsx`'s
 * "Preferred Callsign Suffix" input.
 */
export const CALLSIGN_SUFFIX_PATTERN = '[A-Za-z0-9.-]*'
export const CALLSIGN_SUFFIX_REGEX = /^[A-Za-z0-9.-]*$/

// The 8 predefined TAK_Role values, used as a fallback default for the
// Member_List edit form's `<select>` before `GET /api/config/public`'s
// `takRoleValues` field has loaded, so the select is never empty on
// first render.
export const DEFAULT_TAK_ROLE_VALUES = ['Team Member', 'Team Lead', 'Sniper', 'Medic', 'Forward Observer', 'RTO', 'K9', 'HQ']

/**
 * The initial per-row edit-form values seeded from a Member_List row when
 * its "Edit" pencil icon is clicked. Extracted as a standalone pure
 * function (rather than inlined in the click handler) so the pre-fill
 * rule can be unit tested without rendering the component.
 *
 * Deliberately excludes `email` -- there is no input control for it
 * anywhere in this form.
 *
 * @param {{first_name?: string, last_name?: string, tak_role?: string, callsign_suffix?: string}|null|undefined} member
 * @returns {{firstName: string, lastName: string, takRole: string, callsignSuffix: string}}
 */
export function getInitialMemberEditForm(member) {
  return {
    firstName: member?.first_name || '',
    lastName: member?.last_name || '',
    takRole: member?.tak_role || 'Team Member',
    callsignSuffix: member?.callsign_suffix || ''
  }
}

/**
 * Pure validation helper for the Member_List edit form's `callsign_suffix`
 * input, mirroring `server/utils/callsignValidation.js`'s
 * `isValidCallsignSuffix` -- an empty value is valid (the field is
 * optional).
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isValidMemberCallsignSuffix(value) {
  if (!value) {
    return true
  }
  return CALLSIGN_SUFFIX_REGEX.test(value)
}

/**
 * The Member_List inline edit row: First Name, Last Name, TAK Role
 * (select), Callsign Suffix, plus Save/Cancel. Rendered as a single wide
 * table row in place of the member/admin's normal row.
 *
 * Email is intentionally NOT rendered as an input anywhere in this form.
 *
 * @param {object} props
 * @param {number} props.colSpan how many columns the surrounding table's
 *   normal row has, so this row's single cell spans the same width.
 * @param {{firstName: string, lastName: string, takRole: string, callsignSuffix: string}} props.form
 * @param {(form: object) => void} props.setForm
 * @param {string[]} props.takRoleValues
 * @param {boolean} props.saving
 * @param {string|null} props.error
 * @param {() => void} props.onSave
 * @param {() => void} props.onCancel
 */
export default function MemberEditRow({ colSpan, form, setForm, takRoleValues, saving, error, onSave, onCancel }) {
  return (
    <tr className="bg-gray-50 dark:bg-gray-800">
      <td colSpan={colSpan} className="px-6 py-4">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">First Name</label>
            <input
              type="text"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              className="input"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Last Name</label>
            <input
              type="text"
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              className="input"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">TAK Role</label>
            <select
              value={form.takRole}
              onChange={(e) => setForm({ ...form, takRole: e.target.value })}
              className="input"
            >
              {takRoleValues.map((role) => (
                <option key={role} value={role}>{role}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Callsign Suffix</label>
            <input
              type="text"
              value={form.callsignSuffix}
              onChange={(e) => setForm({ ...form, callsignSuffix: e.target.value })}
              className="input"
              pattern={CALLSIGN_SUFFIX_PATTERN}
              title="Only letters, digits, - and . are allowed"
              placeholder="J.Bloggs"
            />
          </div>
          <div className="flex items-end space-x-2 pb-0.5">
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="btn-primary px-4 py-2 text-sm"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="btn-secondary px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-red-600 dark:text-red-400 text-sm mt-2">{error}</p>
        )}
      </td>
    </tr>
  )
}
