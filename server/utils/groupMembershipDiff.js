/**
 * Normalise a list of pks to a Set of integers, or null if ANY entry is not a
 * non-negative integer pk (or the input is not an array).
 */
function normalisePkSet(pks) {
  if (!Array.isArray(pks)) return null;
  const out = new Set();
  for (const pk of pks) {
    if (typeof pk !== 'number' && typeof pk !== 'string') return null;
    if (typeof pk === 'string' && pk.trim() === '') return null;
    const n = Number(pk);
    if (!Number.isInteger(n) || n < 0) return null;
    out.add(n);
  }
  return out;
}

/**
 * Pure helper: is an Authentik group's CURRENT member set exactly the set we
 * are about to write?
 *
 * Used by the owned-group reconciler to skip a full-replace PATCH that would
 * change nothing. Authentik turns every group PATCH into an event plus queued
 * background tasks (event-trigger dispatch, SCIM dispatch), even when the
 * membership is identical, so an unchanged PATCH is not free: the hourly
 * anti-drift sweep used to PATCH every owned group and saturated the
 * Authentik database on an environment with many (mostly empty) groups.
 *
 * Deliberately conservative. It answers `true` ONLY when it can prove the two
 * sets are identical, and `false` for anything doubtful, so a `false` never
 * costs more than the PATCH that was issued before this check existed:
 *   - order and duplicates are irrelevant (compared as sets);
 *   - a primary key is compared by its integer value, so `10`, `'10'` and
 *     `' 10 '` are the same member;
 *   - any entry that is not a non-negative integer pk (null, undefined, NaN,
 *     an object, a non-numeric string) on EITHER side returns `false`, never
 *     "ignore it and compare the rest";
 *   - `currentPks` or `desiredPks` not being an array returns `false`.
 *
 * Kept free of framework and database imports so it can be tested directly.
 *
 * @param {Array<string|number>} currentPks  members Authentik reports now.
 * @param {Array<string|number>} desiredPks  the complete set about to be written.
 * @returns {boolean} true only when both sets are provably identical.
 */
function sameMemberSet(currentPks, desiredPks) {
  const current = normalisePkSet(currentPks);
  const desired = normalisePkSet(desiredPks);
  if (current === null || desired === null) return false;
  if (current.size !== desired.size) return false;
  for (const pk of desired) {
    if (!current.has(pk)) return false;
  }
  return true;
}

module.exports = { sameMemberSet };
