'use strict';

const { isCloudTakEnabled } = require('../server/config/cloudtak');
const EventPublisher = require('../server/services/EventPublisher');
const pool = require('../server/config/database');

/**
 * Idempotent backfill for existing Teams (Requirement 8).
 *
 * Enqueues one `create_cloudtak_group` Sync_Operation per existing Team so
 * that Teams created before the integration was enabled are also mirrored
 * into CloudTAK. This backfill is safe to re-run: each enqueued
 * `create_cloudtak_group` is itself idempotent -- the Sync_Worker performs
 * Create_Or_Reuse (never failing on an existing group), sets the
 * Agency_Attributes authoritatively, and reconciles members to the Team's
 * current Direct_Admin_Set -- so a second run converges to the same end
 * state rather than erroring or drifting (Requirement 8.3).
 *
 * Modeled on scripts/create-team-channels.js (uses `process.stdout`/
 * `process.stderr` for output, matching the lint-clean scripts convention).
 */
async function createCloudTakGroupsForAllTeams() {
  try {
    // Requirement 8.5 / 1.5: when the integration is disabled, make no
    // change to Authentik, enqueue nothing, and report that it is disabled.
    if (!isCloudTakEnabled()) {
      process.stdout.write('CloudTAK integration is disabled (CLOUDTAK_ENABLED !== "true"); nothing will be enqueued.\n');
      process.exit(0);
    }

    process.stdout.write('Enqueuing CloudTAK group creation for all existing teams...\n');

    const result = await pool.query('SELECT id FROM teams ORDER BY id');
    const teams = result.rows;

    process.stdout.write(`Found ${teams.length} teams\n`);

    // Default pool; no request transaction. Each publish is independent.
    await Promise.all(
      teams.map((team) => EventPublisher.publishOperation('create_cloudtak_group', { team_id: team.id }, null))
    );

    process.stdout.write(`Finished enqueuing CloudTAK group creation for ${teams.length} teams\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`Error enqueuing CloudTAK group creation: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  }
}

createCloudTakGroupsForAllTeams();
