const pool = require('../config/database');

/**
 * Pure, side-effect-free helpers for the CloudTAK agency-group integration
 * (spec: cloudtak-agency-groups). Centralising the group-name shape, the
 * Agency_Attributes shape, and the Direct_Admin_Set query means each has a
 * single implementation reused by the enqueue sites, the Sync_Worker
 * handlers, and the Backfill.
 */

/**
 * The Authentik group name for a Team, exactly `CloudTAKAgency<id>` with no
 * additional prefix (Requirement 2.2). `<id>` is the Team's numeric
 * `teams.id`.
 *
 * @param {number|string} teamId
 * @returns {string}
 */
function groupName(teamId) {
  return `CloudTAKAgency${teamId}`;
}

/**
 * The three Agency_Attributes carried by a CloudTAK_Group, mapped
 * authoritatively from the Team's current stored values (Requirements 3.1,
 * 3.2, 3.3). `agencyId` is always the Team's numeric id; `description` is
 * kept as-is, including `null`.
 *
 * @param {{ id: number, name: string, description: string|null }} team
 * @returns {{ agencyId: number, agencyName: string, description: string|null }}
 */
function agencyAttributes(team) {
  return {
    agencyId: team.id,
    agencyName: team.name,
    description: team.description
  };
}

/**
 * Resolves a Team's Direct_Admin_Set directly from `team_memberships`
 * (Requirements 4.1, 4.2): rows for that Team with `role = 'admin'` AND
 * `inherited_from_team_id IS NULL`. This deliberately does NOT use
 * `Team.isAdmin`, which resolves inherited admins up the Ancestor_Chain
 * (Requirement 4.3), so inherited admins are excluded (Requirement 4.4).
 *
 * An optional transactional `client` may be passed so this can run inside a
 * caller's open transaction; it defaults to the shared pool. Query errors
 * propagate to the caller/worker.
 *
 * @param {number} teamId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<Array<{ user_id: number, authentik_user_id: string }>>}
 */
async function getDirectAdmins(teamId, client = pool) {
  const query = `
    SELECT tm.user_id, u.authentik_user_id
    FROM team_memberships tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = $1
      AND tm.role = 'admin'
      AND tm.inherited_from_team_id IS NULL
  `;

  const result = await client.query(query, [teamId]);
  return result.rows;
}

/**
 * Pure membership-reconcile diff (Feature cloudtak-agency-groups, tasks
 * 4.1/4.4). Given the CloudTAK_Group's `current` member identifiers and
 * the `target` Direct_Admin_Set identifiers, returns the ids to add
 * (present in `target`, absent from `current`) and the ids to remove
 * (present in `current`, absent from `target`). Comparison is by strict
 * `Set` membership, so both inputs MUST use the same id space (Authentik
 * user pks / `users.authentik_user_id`).
 *
 * The result satisfies: applying `toAdd`/`toRemove` to `current` yields
 * exactly `target` (Property 6). `null`/`undefined` ids are dropped from
 * both sides so a member with no resolvable `authentik_user_id` is never
 * added or removed.
 *
 * @param {Array<number|string>} current
 * @param {Array<number|string>} target
 * @returns {{ toAdd: Array<number|string>, toRemove: Array<number|string> }}
 */
function computeMembershipDiff(current, target) {
  const currentSet = new Set((current || []).filter((id) => id !== null && id !== undefined));
  const targetSet = new Set((target || []).filter((id) => id !== null && id !== undefined));

  const toAdd = [...targetSet].filter((id) => !currentSet.has(id));
  const toRemove = [...currentSet].filter((id) => !targetSet.has(id));

  return { toAdd, toRemove };
}

module.exports = { groupName, agencyAttributes, getDirectAdmins, computeMembershipDiff };
