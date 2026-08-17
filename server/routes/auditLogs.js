const express = require('express');
const { query, validationResult } = require('express-validator');
const { stringify } = require('csv-stringify');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const { paginationParams } = require('../middleware/pagination');
const pool = require('../config/database');
const router = express.Router();

/**
 * server/routes/auditLogs.js
 *
 * `GET /api/audit-logs` (Requirement 31 Criterion 1, task 53.1):
 * Global_Manager-only endpoint querying the `audit_logs` table
 * (`id, user_id, action, resource_type, resource_id, details,
 * created_at` -- see `database/schema.sql`), filtered by actor
 * (`userId` -> `user_id`), `action`, `resourceType` (-> `resource_type`),
 * an associated team (`teamId`, matched against `resource_id` only for
 * rows whose `resource_type` indicates a team-scoped resource -- see
 * `TEAM_SCOPED_RESOURCE_TYPES` below), and a `created_at` date range
 * (`startDate`/`endDate`), combined with the shared `page`/`pageSize`
 * pagination middleware (`server/middleware/pagination.js`, Requirement
 * 11.4).
 *
 * Authorization is enforced centrally by `authorize.js` via the
 * Permission_Registry's `audit_log:read` entry (resolved through
 * `roleDefaults.global_manager: ['*']`), matching the pattern already
 * used by every other Global_Manager-only route file (`vendorChannels.js`,
 * `deploymentChannels.js`) -- no inline `is_global_manager` check is
 * duplicated here (Requirement 31 Criterion 4: not exposed to a team
 * admin who is not also a Global_Manager).
 *
 * `buildAuditLogFilters` is exported alongside the router, and is reused
 * unchanged by `GET /api/audit-logs/export.csv` below (Requirement 31
 * Criterion 2, task 53.2) per design.md Section 26 ("applies the same
 * filter-building function"), without duplicating the WHERE-clause
 * construction.
 *
 * `GET /api/audit-logs/export.csv` (Requirement 31 Criterion 2, task
 * 53.2) applies the identical filters (no pagination -- an export streams
 * every matching row) and streams the result through `csv-stringify`
 * directly into the HTTP response. `pg-query-stream` is not a dependency
 * of this repository, so rather than adding a new dependency for a single
 * route, the export route fetches `EXPORT_CHUNK_SIZE`-row pages via a
 * manual `LIMIT`/`OFFSET` loop and writes each page into the open
 * `csv-stringify` stream before fetching the next page, so the full
 * result set is never materialized in memory at once (design.md Section
 * 26).
 */

/**
 * `resource_type` values that identify a team-scoped resource, i.e. one
 * whose `resource_id` refers to a `teams.id` row. Requirement 31
 * Criterion 1's "an associated team (via `resource_id` where
 * `resource_type` indicates a team-scoped resource)" is deliberately NOT
 * "every `resource_type` value" -- e.g. `vendor_channel_grant` rows
 * (written by `VendorChannelService`) have a `resource_id` that refers to
 * a `vendor_channel_grants.id`, not a team, so a `teamId` filter must not
 * match those rows even if their `resource_id` happens to collide
 * numerically with a team id.
 *
 * `'team'` covers the direct team resource itself (e.g. a future
 * team-lifecycle audit event); `'channel'` covers a team-scoped
 * `channels` row (distinct from the non-team-scoped
 * `vendor_channel`/`vendor_channel_grant`/`deployment_channel`/
 * `bch_channel`/`region_channel` resource types), since a channel's
 * `resource_id` can be resolved back to the owning team via
 * `channels.team_id` -- callers filtering by `teamId` are asking "what
 * happened to/within this team", which includes actions on that team's
 * channels.
 */
const TEAM_SCOPED_RESOURCE_TYPES = ['team', 'channel'];

/**
 * Builds the `WHERE` clause fragments and parameter list for the filters
 * accepted by `GET /api/audit-logs` (and, per design.md Section 26,
 * `GET /api/audit-logs/export.csv`).
 *
 * All filters are optional; any combination (including none) is valid.
 * Every filter that is present is combined with `AND`.
 *
 * The `teamId` filter is intentionally NOT a plain
 * `resource_id = $n` match: per Requirement 31 Criterion 1's "via
 * `resource_id` where `resource_type` indicates a team-scoped resource",
 * a `teamId` filter only matches rows whose `resource_type` is one of
 * `TEAM_SCOPED_RESOURCE_TYPES` (see above) -- an audit_logs row for an
 * unrelated resource type whose `resource_id` happens to equal the
 * requested `teamId` numerically must NOT match.
 *
 * `channel`-typed rows additionally require resolving `resource_id`
 * (a `channels.id`) to that channel's owning `channels.team_id` via a
 * `NOT EXISTS`-free correlated subquery-free join condition; this is
 * expressed as an `IN` against a subquery selecting channel ids owned by
 * the target team, rather than a join, so the caller can keep composing
 * this fragment into a single flat `WHERE` clause alongside the other
 * filters.
 *
 * @param {object} filters
 * @param {string|number} [filters.userId]
 * @param {string} [filters.action]
 * @param {string} [filters.resourceType]
 * @param {string|number} [filters.teamId]
 * @param {string} [filters.startDate] - ISO 8601 date/datetime, inclusive lower bound on `created_at`.
 * @param {string} [filters.endDate] - ISO 8601 date/datetime, inclusive upper bound on `created_at`.
 * @returns {{whereClause: string, params: any[]}} `whereClause` is either
 *   `''` (no filters) or a string starting with `WHERE `; `params` is the
 *   positionally-ordered parameter array matching `$1`, `$2`, ... placeholders
 *   embedded in `whereClause`.
 */
function buildAuditLogFilters(filters = {}) {
  const { userId, action, resourceType, teamId, startDate, endDate } = filters;

  const conditions = [];
  const params = [];

  // Every fragment below is qualified with `audit_logs.` -- valid whether
  // or not the caller's query joins another table (a bare table-name
  // prefix works fine even with no join/alias present, e.g. in the
  // export.csv route and the COUNT(*) query below), and REQUIRED now that
  // `GET /api/audit-logs` LEFT JOINs `users` to resolve a display name
  // for `user_id` (Requirement 31 Criterion 1 update) -- `users` has its
  // own `id`/`created_at` columns, so an unqualified `user_id`/
  // `created_at` reference became ambiguous the moment that join was
  // added. `channels.id` inside the teamId subquery below is unambiguous
  // (only `channels` is referenced there) and stays unqualified.
  if (userId !== undefined && userId !== null && userId !== '') {
    params.push(userId);
    conditions.push(`audit_logs.user_id = $${params.length}`);
  }

  if (action) {
    params.push(action);
    conditions.push(`audit_logs.action = $${params.length}`);
  }

  if (resourceType) {
    params.push(resourceType);
    conditions.push(`audit_logs.resource_type = $${params.length}`);
  }

  if (teamId !== undefined && teamId !== null && teamId !== '') {
    // resource_type must indicate a team-scoped resource (Req 31.1).
    // 'team' rows match resource_id directly against the team id;
    // 'channel' rows match resource_id against any channel id owned by
    // that team.
    params.push(teamId);
    const teamIdParamIndex = params.length;
    params.push(teamId);
    const channelTeamIdParamIndex = params.length;

    conditions.push(
      `(
        (audit_logs.resource_type = 'team' AND audit_logs.resource_id = $${teamIdParamIndex})
        OR (audit_logs.resource_type = 'channel' AND audit_logs.resource_id IN (
          SELECT id FROM channels WHERE team_id = $${channelTeamIdParamIndex}
        ))
      )`
    );
  }

  if (startDate) {
    params.push(startDate);
    conditions.push(`audit_logs.created_at >= $${params.length}`);
  }

  if (endDate) {
    params.push(endDate);
    conditions.push(`audit_logs.created_at <= $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return { whereClause, params };
}

// Requirement 31 Criterion 1: Global_Manager-only, filtered, paginated
// audit_logs query.
router.get('/', authenticateToken, authorize, paginationParams, [
  query('userId').optional().isInt(),
  query('action').optional().trim().isLength({ min: 1, max: 100 }),
  query('resourceType').optional().trim().isLength({ min: 1, max: 50 }),
  query('teamId').optional().isInt(),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId, action, resourceType, teamId, startDate, endDate } = req.query;
    const { pageSize, offset } = req.pagination;

    const { whereClause, params } = buildAuditLogFilters({
      userId,
      action,
      resourceType,
      teamId,
      startDate,
      endDate
    });

    const dataParams = [...params, pageSize, offset];
    const limitParamIndex = params.length + 1;
    const offsetParamIndex = params.length + 2;

    // LEFT JOIN users to resolve the acting user's username/email for
    // display -- a bare numeric user_id is meaningless to an admin
    // reviewing the log (Authentik/local ids are internal implementation
    // details, never something a human should have to look up manually).
    // LEFT (not INNER) so a row whose actor was later deleted still
    // appears, with username/email as null. `audit_logs.id` must be
    // qualified since `users.id` also exists and would otherwise be
    // ambiguous; every other selected column is unique to `audit_logs` and
    // stays unqualified to match buildAuditLogFilters' unqualified WHERE
    // fragments.
    const [rowsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT audit_logs.id, audit_logs.user_id, audit_logs.action, audit_logs.resource_type,
                audit_logs.resource_id, audit_logs.details, audit_logs.created_at,
                users.username, users.email
         FROM audit_logs
         LEFT JOIN users ON users.id = audit_logs.user_id
         ${whereClause}
         ORDER BY audit_logs.created_at DESC
         LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
        dataParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM audit_logs ${whereClause}`,
        params
      )
    ]);

    res.json({
      auditLogs: rowsResult.rows,
      pagination: {
        page: req.pagination.page,
        pageSize,
        total: parseInt(countResult.rows[0].total, 10)
      }
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch audit logs');
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

/**
 * Number of `audit_logs` rows fetched per chunk by the CSV export route
 * below (Requirement 31 Criterion 2, task 53.2).
 *
 * `pg` (the driver used throughout this codebase via `server/config/database.js`)
 * does not itself expose a server-side cursor/streaming query API -- that
 * capability only exists via the separate `pg-query-stream` package, which
 * is NOT currently a dependency of this repository (confirmed by checking
 * `package.json`). Rather than adding a new dependency for a single route,
 * this route implements a manual `LIMIT`/`OFFSET` chunked fetch-and-stream
 * loop: it repeatedly fetches `EXPORT_CHUNK_SIZE` rows at a time (ordered
 * by `created_at DESC` to match `GET /api/audit-logs`'s ordering, with a
 * stable `id DESC` tiebreaker so that a chunk boundary can never land
 * between two rows sharing an identical `created_at` timestamp and thereby
 * skip or duplicate a row), writes each fetched row into the open
 * `csv-stringify` stream as soon as it's fetched, and only then fetches
 * the next chunk -- so the full result set is never held in memory at
 * once, only one `EXPORT_CHUNK_SIZE`-row page at a time (design.md
 * Section 26's "no full result materialized in memory").
 */
const EXPORT_CHUNK_SIZE = 500;

// Requirement 31 Criterion 2: Global_Manager-only CSV export endpoint
// applying the same filters as `GET /api/audit-logs` (Criterion 1), with
// no pagination -- every matching row is streamed, not one page.
router.get('/export.csv', authenticateToken, authorize, [
  query('userId').optional().isInt(),
  query('action').optional().trim().isLength({ min: 1, max: 100 }),
  query('resourceType').optional().trim().isLength({ min: 1, max: 50 }),
  query('teamId').optional().isInt(),
  query('startDate').optional().isISO8601(),
  query('endDate').optional().isISO8601()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { userId, action, resourceType, teamId, startDate, endDate } = req.query;
  const { whereClause, params } = buildAuditLogFilters({
    userId,
    action,
    resourceType,
    teamId,
    startDate,
    endDate
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-logs-export.csv"');

  const csvStream = stringify({
    header: true,
    columns: ['id', 'user_id', 'action', 'resource_type', 'resource_id', 'details', 'created_at']
  });

  // Surface any downstream write/formatting error via the response and
  // the structured logger, matching the JSON route's error-handling
  // shape as closely as a streamed response allows (headers -- including
  // the Content-Type/Content-Disposition set above -- are already sent
  // by the time a mid-stream error can occur, so the response is simply
  // ended rather than replaced with a JSON error body).
  csvStream.on('error', (error) => {
    getLogger().error({ err: error }, 'Failed to stream audit log CSV export');
    res.end();
  });

  csvStream.pipe(res);

  try {
    let offset = 0;
    let rowsFetched = EXPORT_CHUNK_SIZE;

    while (rowsFetched === EXPORT_CHUNK_SIZE) {
      const chunkParams = [...params, EXPORT_CHUNK_SIZE, offset];
      const limitParamIndex = params.length + 1;
      const offsetParamIndex = params.length + 2;

      const { rows } = await pool.query(
        `SELECT id, user_id, action, resource_type, resource_id, details, created_at
         FROM audit_logs
         ${whereClause}
         ORDER BY created_at DESC, id DESC
         LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
        chunkParams
      );

      for (const row of rows) {
        csvStream.write({
          ...row,
          details: row.details === null || row.details === undefined ? '' : JSON.stringify(row.details)
        });
      }

      rowsFetched = rows.length;
      offset += EXPORT_CHUNK_SIZE;
    }

    csvStream.end();
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch audit logs for CSV export');
    csvStream.end();
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export audit logs' });
    } else {
      res.end();
    }
  }
});

module.exports = router;
module.exports.buildAuditLogFilters = buildAuditLogFilters;
module.exports.TEAM_SCOPED_RESOURCE_TYPES = TEAM_SCOPED_RESOURCE_TYPES;
