const fs = require('fs');
const path = require('path');
const pool = require('../server/config/database');

async function initializeDatabase() {
  try {
    console.log('Initializing database...');
    
    const schemaSQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schemaSQL);
    
    console.log('Database schema created successfully');
    
    // Create default holding pen team
    await pool.query(`
      INSERT INTO teams (name, description) 
      VALUES ('Holding Pen', 'Default team for users without specific team assignment')
      ON CONFLICT DO NOTHING
    `);
    
    console.log('Default data inserted');
    process.exit(0);
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeDatabase();
}

module.exports = initializeDatabase;