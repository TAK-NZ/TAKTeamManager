/**
 * BroadcastEmailService (Requirement 30, task 52.1)
 *
 * `send(filter, actingUser, templateKey, variables)` sends a broadcast
 * email, via the existing `EmailService.sendEmail` SES delivery path, to
 * the set of users matched by `filter`.
 *
 * `filter` shape (per design.md Section 25): `{teamIds?: number[],
 * role?: string, channelIds?: number[], allUsers?: boolean}`.
 *   - `allUsers: true` selects every active `users` row, ignoring every
 *     other filter field.
 *   - `teamIds` selects every active user with a DIRECT (non-inherited)
 *     `team_memberships` row whose `team_id` is in the list. `role`, when
 *     also present, further narrows that same set to members holding
 *     that team role (e.g. `{teamIds: [1,2], role: 'admin'}` = admins of
 *     team 1 or 2). `role` given WITHOUT `teamIds` narrows across every
 *     team instead.
 *   - `channelIds` selects every active user with a `channel_memberships`
 *     row for one of the listed channels. Per Requirement 30.1's "team
 *     membership, team role, or channel membership" phrasing, this is an
 *     ADDITIONAL/alternative selection criterion: when combined with
 *     `teamIds`/`role`, the final recipient set is the UNION of both
 *     matches (deduplicated by user id), not their intersection.
 *
 * `templateKey`/`variables` are passed straight through to
 * `EmailService.sendEmail(to, templateKey, variables)` once per resolved
 * recipient -- this service does not implement its own email delivery or
 * template rendering, it only resolves recipients and enforces
 * authorization scoping before delegating to the existing service.
 *
 * Authorization scoping (Req 30.2, 30.3):
 *   - A Global_Manager (`actingUser.is_global_manager`) may send to any
 *     filtered set, including `allUsers: true`. The scoping check below is
 *     skipped entirely for a Global_Manager.
 *   - A non-Global_Manager (a "team admin") may only reach users whose
 *     direct team is one they administer (`role = 'admin'` in
 *     `team_memberships`, mirroring `Team.isAdmin`). This is enforced by
 *     resolving the FULL recipient list first, then resolving the acting
 *     user's administered-team-id set, then verifying every recipient's
 *     team id is a member of that set. A recipient with no team
 *     (`teamId` null -- e.g. matched via `allUsers` or a channel whose
 *     `channels.team_id` is null) is always treated as out-of-scope for a
 *     non-Global_Manager, which is what correctly rejects a team admin's
 *     attempt to use `allUsers: true` without special-casing that filter.
 *   - If the administered-team-id resolution query itself throws, that is
 *     treated as "cannot verify authorization" and the WHOLE request is
 *     rejected (fail-closed), matching the Requirement 4.3/4.6 pattern
 *     already used by `server/middleware/authorize.js`'s row-scoped
 *     resolvers.
 *   - Any out-of-scope recipient rejects the ENTIRE request before any
 *     email is sent -- there is no partial send.
 */
const pool = require('../config/database');
const EmailService = require('./EmailService');
const logger = require('../config/logger').createLogger('BroadcastEmailService');

/**
 * Thrown when a broadcast email request cannot be authorized -- either
 * because a recipient falls outside the acting team admin's administered
 * teams (Req 30.3, first sentence), or because the administered-team
 * resolution query itself failed and authorization could not be verified
 * (Req 30.3, second sentence -- fail closed).
 */
class BroadcastAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BroadcastAuthorizationError';
  }
}

/**
 * Resolves the set of team ids `userId` administers, i.e. every team for
 * which they hold a DIRECT (`inherited_from_team_id IS NULL`) membership
 * row with `role = 'admin'` -- the same condition `Team.isAdmin(teamId,
 * userId)` checks, just resolved for every team at once instead of one
 * team at a time.
 *
 * Intentionally left to propagate any error from `pool.query` (e.g. a DB
 * connectivity failure) rather than catching it here, so `send()`'s
 * caller-side try/catch is the single place that decides "resolution
 * failed" means "fail closed and reject" (Req 30.3).
 *
 * @param {number} userId
 * @returns {Promise<Set<number>>}
 */
async function getAdministeredTeamIds(userId) {
  const result = await pool.query(
    `SELECT team_id FROM team_memberships
     WHERE user_id = $1 AND role = 'admin' AND inherited_from_team_id IS NULL`,
    [userId]
  );
  return new Set(result.rows.map((row) => row.team_id));
}

/**
 * Resolves `filter` into the deduplicated list of matching active users,
 * each annotated with the direct team id (`teamId`, possibly `null`) used
 * for the authorization-scoping check in `send()`.
 *
 * @param {object} filter
 * @param {number[]} [filter.teamIds]
 * @param {string} [filter.role]
 * @param {number[]} [filter.channelIds]
 * @param {boolean} [filter.allUsers]
 * @returns {Promise<Array<{id: number, email: string, teamId: number|null}>>}
 */
async function resolveRecipients(filter = {}) {
  const { teamIds, role, channelIds, allUsers } = filter;

  if (allUsers) {
    const result = await pool.query(
      `SELECT u.id, u.email, tm.team_id AS "teamId"
       FROM users u
       LEFT JOIN team_memberships tm
         ON tm.user_id = u.id AND tm.inherited_from_team_id IS NULL
       WHERE u.is_active = true`
    );
    return result.rows;
  }

  const recipientsById = new Map();

  if (Array.isArray(teamIds) && teamIds.length > 0) {
    const params = [teamIds];
    let roleClause = '';
    if (role) {
      roleClause = ' AND tm.role = $2';
      params.push(role);
    }
    const result = await pool.query(
      `SELECT u.id, u.email, tm.team_id AS "teamId"
       FROM users u
       JOIN team_memberships tm
         ON tm.user_id = u.id AND tm.inherited_from_team_id IS NULL
       WHERE u.is_active = true AND tm.team_id = ANY($1::int[])${roleClause}`,
      params
    );
    for (const row of result.rows) {
      recipientsById.set(row.id, row);
    }
  } else if (role) {
    // `role` given without `teamIds`: narrows across every team.
    const result = await pool.query(
      `SELECT u.id, u.email, tm.team_id AS "teamId"
       FROM users u
       JOIN team_memberships tm
         ON tm.user_id = u.id AND tm.inherited_from_team_id IS NULL
       WHERE u.is_active = true AND tm.role = $1`,
      [role]
    );
    for (const row of result.rows) {
      recipientsById.set(row.id, row);
    }
  }

  if (Array.isArray(channelIds) && channelIds.length > 0) {
    const result = await pool.query(
      `SELECT DISTINCT u.id, u.email, c.team_id AS "teamId"
       FROM users u
       JOIN channel_memberships cm ON cm.user_id = u.id
       JOIN channels c ON c.id = cm.channel_id
       WHERE u.is_active = true AND cm.channel_id = ANY($1::int[])`,
      [channelIds]
    );
    for (const row of result.rows) {
      if (!recipientsById.has(row.id)) {
        recipientsById.set(row.id, row);
      }
    }
  }

  return Array.from(recipientsById.values());
}

class BroadcastEmailService {
  constructor() {
    this.emailService = new EmailService();
  }

  /**
   * Resolves `filter` into a recipient list, enforces fail-closed
   * authorization scoping for non-Global_Manager acting users, and -- only
   * on success -- sends the email once per recipient via
   * `EmailService.sendEmail`.
   *
   * @param {object} filter - see module doc comment above.
   * @param {object} actingUser - the requesting user, in the shape
   *   `server/middleware/auth.js` attaches to `req.user`
   *   (`{userId, is_global_manager, ...}`).
   * @param {string} templateKey - `email_templates.template_key` to send.
   * @param {object} [variables] - template variable substitutions, passed
   *   straight through to `EmailService.sendEmail`.
   * @returns {Promise<{sentCount: number, recipients: string[]}>}
   * @throws {BroadcastAuthorizationError} if a non-Global_Manager's filter
   *   would reach a user outside the teams they administer, or if the
   *   administered-team resolution query itself fails.
   */
  async send(filter, actingUser, templateKey, variables = {}) {
    const recipients = await resolveRecipients(filter);

    if (!(actingUser && actingUser.is_global_manager)) {
      let administeredTeamIds;
      try {
        administeredTeamIds = await getAdministeredTeamIds(actingUser && actingUser.userId);
      } catch (err) {
        logger.error(
          { err, actorId: actingUser && actingUser.userId },
          'Failed to resolve administered teams for broadcast email; rejecting fail-closed'
        );
        throw new BroadcastAuthorizationError(
          'Unable to verify authorization for this broadcast email request'
        );
      }

      const hasOutOfScopeRecipient = recipients.some(
        (recipient) => recipient.teamId == null || !administeredTeamIds.has(recipient.teamId)
      );

      if (hasOutOfScopeRecipient) {
        throw new BroadcastAuthorizationError(
          'Broadcast email filter includes users outside the team(s) you administer'
        );
      }
    }

    let sentCount = 0;
    for (const recipient of recipients) {
      await this.emailService.sendEmail(recipient.email, templateKey, variables);
      sentCount++;
    }

    return { sentCount, recipients: recipients.map((recipient) => recipient.email) };
  }
}

module.exports = BroadcastEmailService;
module.exports.BroadcastAuthorizationError = BroadcastAuthorizationError;
