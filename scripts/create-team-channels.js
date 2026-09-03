const pool = require('../server/config/database');
const Team = require('../server/models/Team');

async function createChannelsForAllTeams() {
  try {
    process.stdout.write('Creating channels for all existing teams...\n');

    // Get all teams
    const result = await pool.query('SELECT id, name FROM teams ORDER BY id');
    const teams = result.rows;

    process.stdout.write(`Found ${teams.length} teams\n`);

    for (const team of teams) {
      process.stdout.write(`Creating channel for team: ${team.name}\n`);
      const channel = await Team.createTeamChannel(team.id);
      if (channel) {
        process.stdout.write(`✓ Created channel: ${channel.display_name}\n`);
      } else {
        process.stdout.write(`✗ Failed to create channel for: ${team.name}\n`);
      }
    }

    process.stdout.write('Finished creating team channels\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`Error creating team channels: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  }
}

createChannelsForAllTeams();