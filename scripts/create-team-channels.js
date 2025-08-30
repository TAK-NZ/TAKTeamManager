const pool = require('../server/config/database');
const Team = require('../server/models/Team');

async function createChannelsForAllTeams() {
  try {
    console.log('Creating channels for all existing teams...');
    
    // Get all teams
    const result = await pool.query('SELECT id, name FROM teams ORDER BY id');
    const teams = result.rows;
    
    console.log(`Found ${teams.length} teams`);
    
    for (const team of teams) {
      console.log(`Creating channel for team: ${team.name}`);
      const channel = await Team.createTeamChannel(team.id);
      if (channel) {
        console.log(`✓ Created channel: ${channel.display_name}`);
      } else {
        console.log(`✗ Failed to create channel for: ${team.name}`);
      }
    }
    
    console.log('Finished creating team channels');
    process.exit(0);
  } catch (error) {
    console.error('Error creating team channels:', error);
    process.exit(1);
  }
}

createChannelsForAllTeams();