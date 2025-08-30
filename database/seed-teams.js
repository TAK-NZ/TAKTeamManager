const pool = require('../server/config/database');

const teams = [
  { name: 'New Zealand Police', slug: 'NZP', color: 'Blue' },
  { name: 'Fire and Emergency New Zealand (FENZ)', slug: 'FENZ', color: 'Red' },
  { name: 'Hato Hone St John', slug: 'St John', color: 'Yellow' },
  { name: 'Wellington Free Ambulance', slug: 'WFA', color: 'White' },
  { name: 'National Emergency Management Agency (NEMA)', slug: 'NEMA', color: 'Purple' },
  { name: 'New Zealand Defence Force (NZDF)', slug: 'NZDF', color: 'Brown' },
  { name: 'New Zealand Red Cross', slug: 'NZRC', color: 'Maroon' },
  { name: 'Land Search and Rescue New Zealand (LandSAR)', slug: 'LandSAR', color: 'Orange' },
  { name: 'Coastguard New Zealand', slug: 'CGNZ', color: 'Teal' },
  { name: 'Department of Conservation (DOC)', slug: 'DOC', color: 'Green' },
  { name: 'Health New Zealand (Te Whatu Ora)', slug: 'HNZ', color: 'Cyan' },
  { name: 'New Zealand Customs Service', slug: 'NZCS', color: 'Blue' }
];

async function seedTeams() {
  try {
    console.log('Seeding teams...');
    
    for (const team of teams) {
      try {
        const result = await pool.query(
          'INSERT INTO teams (name, description, slug, color, visibility, can_join) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
          [team.name, team.name, team.slug, team.color, 'public', false]
        );
        console.log(`✓ Created team: ${team.name}`);
      } catch (error) {
        if (error.code === '23505') {
          console.log(`- Team already exists: ${team.name}`);
        } else {
          throw error;
        }
      }
    }
    
    console.log('Team seeding completed!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding teams:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  seedTeams();
}

module.exports = seedTeams;