const Team = require('../models/Team');

/**
 * Requirement 11.14 (task 23.1): thrown by `checkCallsignSuffixUniqueness`
 * when a candidate `callsign_suffix` value collides, case-insensitively,
 * with another member's (or admin's) `callsign_suffix` within the same
 * Team's Member_List (`Team.getFullMemberList`, task 21.1). Task 22.1
 * (`UserProvisioningService.resolveCallsignSuffixForNewUser`) and tasks
 * 24.3/25.1 (approval and membership-change enforcement, both separate,
 * later tasks) each map this typed error to their own 400 response
 * naming the conflicting value -- this class is deliberately generic
 * (no route-shaped fields beyond the conflicting value itself) so every
 * call site can shape its own response around it.
 */
class CallsignSuffixConflictError extends Error {
  /**
   * @param {string} conflictingValue - the candidate `callsign_suffix`
   *   value that was found to collide with an existing Member_List entry.
   */
  constructor(conflictingValue) {
    super(`Callsign Suffix "${conflictingValue}" is already in use within this Team`);
    this.name = 'CallsignSuffixConflictError';
    this.conflictingValue = conflictingValue;
  }
}

/**
 * Requirement 11.14 (task 23.1): the single shared per-Team
 * `callsign_suffix` uniqueness check, used by every enforcement point
 * introduced across Phase 7 (task 22.1's creation-time resolution, task
 * 24.3's access-request approval, and task 25.1's membership-change
 * enforcement) -- see design.md's "Shared Member_List roster query"
 * section, which explicitly calls for exactly one check function reused
 * across all three.
 *
 * Compares `candidateValue` case-insensitively against every row in
 * `Team.getFullMemberList(teamId)`'s `callsign_suffix` column (every
 * direct and inherited member/admin of `teamId`), excluding
 * `excludeUserId`'s own row when supplied -- so a user keeping their own
 * unchanged `callsign_suffix` during an edit, or a membership-change
 * check re-testing a user who is already a member of `teamId` under
 * another role, never spuriously conflicts with themselves.
 *
 * An empty/`null`/`undefined` `candidateValue` never conflicts with
 * anything (there is nothing to compare), consistent with Requirement
 * 11.14's "An empty `callsign_suffix` value is exempt from this check."
 *
 * Resolves silently (no return value) when no conflict is found; throws
 * `CallsignSuffixConflictError` on a collision.
 *
 * @param {number|string} teamId - the Team whose Member_List the
 *   candidate value is checked against.
 * @param {string|null|undefined} candidateValue - the candidate
 *   `callsign_suffix` value being validated.
 * @param {number|string|null} [excludeUserId] - a user id to exclude
 *   from the comparison set (the user being edited, or the user whose
 *   own membership change is being validated).
 * @returns {Promise<void>}
 * @throws {CallsignSuffixConflictError} when `candidateValue`
 *   case-insensitively matches another member's `callsign_suffix`.
 */
async function checkCallsignSuffixUniqueness(teamId, candidateValue, excludeUserId = null) {
  if (!candidateValue) {
    return;
  }

  const members = await Team.getFullMemberList(teamId);
  const normalizedCandidate = candidateValue.toLowerCase();

  const conflict = members.some((member) => {
    if (excludeUserId != null && member.id === excludeUserId) {
      return false;
    }
    return (
      member.callsign_suffix != null &&
      member.callsign_suffix.toLowerCase() === normalizedCandidate
    );
  });

  if (conflict) {
    throw new CallsignSuffixConflictError(candidateValue);
  }
}

module.exports = { CallsignSuffixConflictError, checkCallsignSuffixUniqueness };
