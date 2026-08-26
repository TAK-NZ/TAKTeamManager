import { InformationCircleIcon } from '@heroicons/react/24/outline'

/**
 * takserver-enrollment Requirement 13: the Multiple_Certificate_Warning.
 *
 * Shown WHERE one Enrollment_Principal holds more than one live TAK Server
 * certificate -- counted as non-revoked `tak_devices` rows for that
 * principal's `user_id` (takserver-enrollment Criterion 13.2). This
 * component owns only the THRESHOLD and the RENDERING; the count itself is
 * resolved server-side, in one batched query for a list of principals and
 * one scalar query for a single principal (takserver-enrollment Criterion
 * 13.6), so this component never fetches and never counts.
 *
 * ## The threshold is STRICT (Criteria 13.1, 13.5)
 *
 * At exactly one certificate or at zero, `buildMultipleCertificateWarningText`
 * returns `null` and this component renders nothing -- not an empty
 * element, nothing at all -- leaving the surrounding rendering exactly as it
 * is for the common case of a principal with one certificate or none
 * (Criterion 13.5). Several live certificates is the state worth flagging;
 * `device-management` measured 60 live certificates on one `clientUid`
 * through ordinary re-enrollment, so more than one is normal, not a defect
 * (Criterion 13.7).
 *
 * ## Text carries the count, never an icon or colour alone (Criteria 13.3, 13.4)
 *
 * This follows the convention `device-management` already established for
 * the "Revoked" badge (its Criterion 16.5) and the "Expires soon" / "Expired"
 * markers on `DeviceListRow.jsx` (its Criterion 21.3): a screen reader does
 * not perceive colour or an icon's shape, so the state -- and the exact
 * COUNT, as a number rather than an adjective like "several" -- is rendered
 * as real text in the accessibility tree. The `InformationCircleIcon` beside
 * it is `aria-hidden`: purely decorative, and removable without losing any
 * information the text does not already carry.
 *
 * ## Information, not an error (Criterion 13.7)
 *
 * Deliberately NOT `role="alert"` -- that role is reserved in this codebase
 * for validation failures and request errors (see `RevokeDeviceDialog.jsx`,
 * `TeamDetail.jsx`), and this is neither. It does not block enrollment, does
 * not render as a validation failure, and does not gate any button; a caller
 * rendering this beside an enrollment action must not read its presence as a
 * reason to disable that action. The styling is a neutral informational
 * amber-on-text treatment -- distinct from the red "Revoked" badge and the
 * bold-red expiry markers, which DO describe a problem -- so the visual
 * weight does not overstate what is, per Criterion 13.7, a normal state made
 * visible rather than a state to be prevented.
 */

/**
 * The Multiple_Certificate_Warning's text, or `null` when there is nothing
 * to say.
 *
 * Pure and total, and exported for direct unit testing, matching this
 * project's convention of testing extracted pure logic alongside rendering
 * (see `RevokeDeviceDialog.jsx`, `DeviceTypeIcon.jsx`).
 *
 * Renders for a count STRICTLY GREATER THAN ONE only (Criteria 13.1, 13.5).
 * Anything that is not a positive integer greater than one -- `0`, `1`,
 * a negative number, `NaN`, `Infinity`, `null`, `undefined`, or a
 * non-number -- is treated as "nothing to warn about" rather than as an
 * error: this component fails closed into silence, never into a broken
 * render, because a malformed count is not this principal's problem to
 * surface.
 *
 * @param {*} count The live (non-revoked) certificate count for one
 *   Enrollment_Principal, as returned by the enrollment API's
 *   `liveCertificateCount` field or the Users list's `live_certificate_count`
 *   field.
 * @returns {string|null} The warning text, with the count as a number in
 *   it, or `null` for a count of one, zero, or anything unusable.
 */
export function buildMultipleCertificateWarningText(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || !Number.isInteger(count)) {
    return null
  }
  if (count <= 1) {
    return null
  }
  return `This account has ${count} active TAK Server certificates.`
}

/**
 * The Multiple_Certificate_Warning.
 *
 * @param {object} props
 * @param {number|null|undefined|*} props.count the live certificate count
 *   for one Enrollment_Principal. Anything that is not an integer greater
 *   than one renders nothing (Criteria 13.1, 13.5).
 * @param {string} [props.className] extra classes for the wrapper, so a
 *   caller can position it without this component knowing its context.
 */
export default function MultipleCertificateWarning({ count, className = '' }) {
  const text = buildMultipleCertificateWarningText(count)

  if (text === null) {
    return null
  }

  return (
    <p
      className={[
        'flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <InformationCircleIcon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span>{text}</span>
    </p>
  )
}
