const { parse } = require('csv-parse');
const pool = require('../config/database');
const Team = require('../models/Team');
const UserProvisioningService = require('./UserProvisioningService');
const authentikService = require('./authentik');
const logger = require('../config/logger').createLogger('BulkImportService');

/**
 * BulkImportService (Requirement 29, `design.md` Section 24: CSV Bulk
 * Import for Users and Teams).
 *
 * This task (51.1) implements only `importUsers`. `importTeams` (task
 * 51.2), the CSV template files (task 51.3), and the route layer (task
 * 51.4) are deliberately out of scope here.
 *
 * Thrown internally by `importUserRow` for any row-local validation or
 * authorization failure. Always caught by `importUsers`'s per-row loop
 * and recorded as `{row, success: false, error}` -- it never escapes
 * `importUsers` itself (Requirement 29.4: a rejected row must not affect
 * the processing of any other row in the batch).
 */
class BulkImportRowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BulkImportRowError';
  }
}

/**
 * Thrown by `importTeams` (task 51.2) to reject an ENTIRE import batch
 * upfront, before any row is read from the CSV, when the importing user
 * is not a Global_Manager. Unlike `BulkImportRowError` (a per-row
 * failure that never stops the batch), this is a whole-batch failure --
 * team import is Global_Manager-only, per Requirement 29.5 and
 * `design.md` Section 24, since creating arbitrary new teams is not
 * scoped to any single team an admin might administer the way user
 * import is.
 */
class BulkImportAuthorizationError extends Error {
  constructor(message = 'Team import is restricted to Global_Manager') {
    super(message);
    this.name = 'BulkImportAuthorizationError';
  }
}

function getRequiredField(row, field) {
  const value = row[field];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new BulkImportRowError(`Missing required field: ${field}`);
  }
  return String(value).trim();
}

function parseRowTeamId(row) {
  const raw = row.teamId;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new BulkImportRowError('Missing required field: teamId');
  }
  const teamId = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    throw new BulkImportRowError(`Invalid teamId: ${raw}`);
  }
  return teamId;
}

class BulkImportService {
  /**
   * Requirement 29.2-29.4, 29.6 (task 51.1): streams a user-import CSV
   * (`csv-parse`, one row at a time -- memory-safe for large files, per
   * `design.md`) and, for every row: authorizes it (`Team.isAdmin(row
   * .teamId, importingUser) OR importingUser.is_global_manager`),
   * applies the same creation/inheritance/channel-assignment logic
   * already used by `POST /api/users/create-and-add` via
   * `UserProvisioningService.createAndAddUser`, and wraps that row's
   * local database writes in their OWN transaction on their OWN
   * acquired client -- so a failure processing one row (missing field,
   * Authentik creation failure, DB constraint violation, insufficient
   * authorization) rolls back only that row's partial writes and never
   * aborts or rolls back any other row's already-committed work.
   *
   * Rows are processed sequentially, in CSV order, so error attribution
   * (`row: n`) is unambiguous and deterministic; nothing about this
   * requirement calls for concurrent row processing.
   *
   * @param {Buffer|string} csvBuffer - the raw CSV file contents.
   * @param {{userId?: number, is_global_manager?: boolean}} importingUser
   * @returns {Promise<{successCount: number, failureCount: number, results: Array<{row: number, success: boolean, userId?: number, error?: string}>}>}
   */
  static async importUsers(csvBuffer, importingUser) {
    const results = [];
    let successCount = 0;
    let failureCount = 0;
    let rowNumber = 0;

    const parser = parse(csvBuffer, { columns: true, trim: true, skip_empty_lines: true });

    for await (const row of parser) {
      rowNumber++;
      try {
        const outcome = await BulkImportService.importUserRow(row, importingUser);
        results.push({ row: rowNumber, success: true, userId: outcome.localUserId });
        successCount++;
      } catch (error) {
        logger.error(
          { err: error, row: rowNumber },
          'CSV user import row failed; continuing with remaining rows'
        );
        results.push({ row: rowNumber, success: false, error: error.message });
        failureCount++;
      }
    }

    return { successCount, failureCount, results };
  }

  /**
   * Requirement 29.5 (task 51.2): streams a team-import CSV (same
   * `csv-parse`, one-row-at-a-time pattern as `importUsers`) and, for
   * every row, resolves an optional `parentTeamName`/`parentTeamId`
   * column to an existing team id before calling `Team.create`.
   *
   * Unlike `importUsers`, whose per-row authorization lets a team admin
   * import users into team(s) they administer, team import is
   * Global_Manager-only for the ENTIRE batch: creating an arbitrary new
   * team (possibly a new root team) isn't scoped to any single team an
   * admin might administer, mirroring Requirement 4.5's root-team-create
   * restriction. That check runs once, up front, before the CSV is even
   * parsed -- an unauthorized caller's request is rejected outright
   * rather than recorded as N per-row failures.
   *
   * @param {Buffer|string} csvBuffer - the raw CSV file contents.
   * @param {{userId?: number, is_global_manager?: boolean}} importingUser
   * @returns {Promise<{successCount: number, failureCount: number, results: Array<{row: number, success: boolean, teamId?: number, error?: string}>}>}
   * @throws {BulkImportAuthorizationError} if `importingUser` is not a
   *   Global_Manager.
   */
  static async importTeams(csvBuffer, importingUser) {
    if (!importingUser?.is_global_manager) {
      throw new BulkImportAuthorizationError();
    }

    const results = [];
    let successCount = 0;
    let failureCount = 0;
    let rowNumber = 0;

    const parser = parse(csvBuffer, { columns: true, trim: true, skip_empty_lines: true });

    for await (const row of parser) {
      rowNumber++;
      try {
        const outcome = await BulkImportService.importTeamRow(row, importingUser);
        results.push({ row: rowNumber, success: true, teamId: outcome.teamId });
        successCount++;
      } catch (error) {
        logger.error(
          { err: error, row: rowNumber },
          'CSV team import row failed; continuing with remaining rows'
        );
        results.push({ row: rowNumber, success: false, error: error.message });
        failureCount++;
      }
    }

    return { successCount, failureCount, results };
  }

  /**
   * Processes a single team-import CSV row: resolves this row's optional
   * parent team on this row's own acquired client, wrapped in its own
   * transaction (mirroring `importUserRow`'s per-row client-acquisition
   * pattern -- Requirement 29.2/29.6: resolving, or failing to resolve,
   * one row's parent never affects any other row), then calls
   * `Team.create`. `Team.create` performs its own INSERT (and the
   * resulting Authentik team-channel creation) directly against the
   * shared pool -- it does not accept an externally-managed client -- so
   * it is invoked after this row's own parent-resolution transaction has
   * already committed or rolled back; a later row's failure can never
   * roll back an earlier row's already-committed `Team.create` call,
   * since each runs as its own, already-committed statement.
   *
   * @param {Record<string, string>} row - a parsed CSV row, keyed by
   *   header name (`name`, and one of the optional `parentTeamName`/
   *   `parentTeamId`).
   * @param {{userId?: number, is_global_manager?: boolean}} importingUser
   * @returns {Promise<{teamId: number}>}
   * @throws {BulkImportRowError} on a missing `name`, an invalid
   *   `parentTeamId`, or a `parentTeamName` that does not match any
   *   existing team.
   */
  static async importTeamRow(row, importingUser) {
    const name = getRequiredField(row, 'name');

    const client = await pool.connect();
    let parentTeamId;
    try {
      await client.query('BEGIN');
      parentTeamId = await BulkImportService.resolveParentTeamId(row, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // Requirement 29.5: `Team.create` is called with the resolved parent
    // team id (or `null` for a root team). `visibility`/`can_join`/`color`
    // are given the same defaults `POST /api/teams` applies (rather than
    // left `undefined`), since `Team.create`'s INSERT sends every column
    // positionally -- an `undefined` value there would store SQL `NULL`
    // and silently override the table's own column defaults.
    const team = await Team.create({
      name,
      description: null,
      callsign_prefix: null,
      color: '#3B82F6',
      visibility: 'private',
      can_join: false,
      parent_team_id: parentTeamId,
      created_by: importingUser?.userId ?? null
    });

    return { teamId: team.id };
  }

  /**
   * Resolves this row's `parentTeamId` column, if given and non-empty,
   * to a validated positive integer (used directly, no lookup); else,
   * if `parentTeamName` is given and non-empty, looks up an existing
   * team by that exact name; else returns `null` (a root/top-level
   * team). `parentTeamId` takes precedence when both columns are
   * present on the same row.
   *
   * @param {Record<string, string>} row
   * @param {import('pg').PoolClient} client - this row's own acquired
   *   client, so the lookup participates in this row's own transaction.
   * @returns {Promise<number|null>}
   * @throws {BulkImportRowError} if `parentTeamId` is present but not a
   *   positive integer, or if `parentTeamName` does not match any
   *   existing team.
   */
  static async resolveParentTeamId(row, client) {
    const rawParentTeamId = row.parentTeamId !== undefined && row.parentTeamId !== null
      ? String(row.parentTeamId).trim()
      : '';
    if (rawParentTeamId !== '') {
      const parentTeamId = Number.parseInt(rawParentTeamId, 10);
      if (!Number.isInteger(parentTeamId) || parentTeamId <= 0) {
        throw new BulkImportRowError(`Invalid parentTeamId: ${row.parentTeamId}`);
      }
      return parentTeamId;
    }

    const rawParentTeamName = row.parentTeamName !== undefined && row.parentTeamName !== null
      ? String(row.parentTeamName).trim()
      : '';
    if (rawParentTeamName !== '') {
      const result = await client.query('SELECT id FROM teams WHERE name = $1', [rawParentTeamName]);
      const parentTeam = result.rows[0];
      if (!parentTeam) {
        throw new BulkImportRowError(`Parent team not found: ${rawParentTeamName}`);
      }
      return parentTeam.id;
    }

    return null;
  }

  /**
   * Processes a single CSV row: authorization first, then Authentik
   * user creation (no open DB transaction), then every local write for
   * this row inside its own `BEGIN`/`COMMIT`-or-`ROLLBACK` transaction
   * on one acquired client, delegating to the same
   * `UserProvisioningService.createAndAddUser` used by
   * `POST /api/users/create-and-add`.
   *
   * @param {Record<string, string>} row - a parsed CSV row, keyed by
   *   header name (`email`, `firstName`, `lastName`, `teamId`, and an
   *   optional `username`).
   * @param {{userId?: number, is_global_manager?: boolean}} importingUser
   * @returns {Promise<{localUserId: number, queuedGroups: number}>}
   * @throws {BulkImportRowError} on missing/invalid fields or
   *   insufficient per-row authorization.
   */
  static async importUserRow(row, importingUser) {
    const teamId = parseRowTeamId(row);

    // Requirement 29.3-29.4: per-row authorization, checked before any
    // Authentik API call or database write for this row. A team admin
    // may only import into team(s) they administer; a Global_Manager
    // may import into any team.
    const isGlobalManager = Boolean(importingUser?.is_global_manager);
    if (!isGlobalManager) {
      const isAdmin = await Team.isAdmin(teamId, importingUser?.userId);
      if (!isAdmin) {
        throw new BulkImportRowError(`Unauthorized: importing user does not administer team ${teamId}`);
      }
    }

    const email = getRequiredField(row, 'email');
    const firstName = getRequiredField(row, 'firstName');
    const lastName = getRequiredField(row, 'lastName');
    const username = (row.username && String(row.username).trim()) || email.split('@')[0];

    // --- Phase 1: Authentik user creation (no open DB transaction, per
    // the same "an external HTTP call must never be issued from inside
    // an open DB transaction" phasing established by
    // `UserProvisioningService.createAndAddUser`'s callers). ---
    const authentikUser = await authentikService.createUser({
      username,
      name: `${firstName} ${lastName}`,
      email
    });

    // --- Phase 2: one transaction, on one acquired client, scoped to
    // THIS row only (Requirement 29.2: one row's failure rolls back
    // only that row's partial writes, never any other row's). ---
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await UserProvisioningService.createAndAddUser(client, {
        authentikUserId: authentikUser.pk,
        username,
        email,
        firstName,
        lastName,
        teamId,
        createdBy: importingUser?.userId ?? null
      });

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(
        { err: error, authentikUserId: authentikUser.pk, teamId },
        'Failed to provision CSV-imported user locally after Authentik user creation; row rolled back'
      );
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = BulkImportService;
module.exports.BulkImportRowError = BulkImportRowError;
module.exports.BulkImportAuthorizationError = BulkImportAuthorizationError;
