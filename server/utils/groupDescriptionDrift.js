/**
 * Pure helper: which local channel rows have an Authentik group whose
 * `attributes.description` differs from the row's `description`.
 *
 * The local row is authoritative (the Sync_Worker writes it verbatim to the
 * group), so a differing group needs the normal in-place update operation.
 *
 * A row is selected only when ALL of these hold:
 *   - it has a group id;
 *   - that group is present in the fetched map (a group missing from the map
 *     is never touched: it may have been deleted in Authentik, and a short or
 *     failed fetch must never be read as "update everything");
 *   - the group's description (missing treated as empty) differs from the
 *     row's description (null treated as empty).
 *
 * Kept free of framework and database imports so it can be tested directly.
 *
 * @param {Array<{id:number, group_id:string|number|null, description:string|null}>} rows
 * @param {Record<string,{name?:string, description?:string|null}>} groupsByPk
 * @returns {Array<{row: object, currentDescription: string}>}
 */
function selectGroupDescriptionDrift(rows, groupsByPk) {
  const drifted = [];
  for (const row of rows) {
    if (row.group_id === null || row.group_id === undefined || row.group_id === '') continue;
    if (!Object.prototype.hasOwnProperty.call(groupsByPk, row.group_id)) continue;
    const currentDescription = groupsByPk[row.group_id].description || '';
    if (currentDescription === (row.description || '')) continue;
    drifted.push({ row, currentDescription });
  }
  return drifted;
}

module.exports = { selectGroupDescriptionDrift };
