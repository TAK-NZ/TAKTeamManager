// Configuration for node-pg-migrate.
//
// Reuses the same DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD environment
// variables already used by server/config/database.js and
// server/workers/syncWorker.js, instead of requiring a separate
// DATABASE_URL, so no additional environment variables need to be
// documented in .env.example.
//
// Usage (see package.json "migrate*" scripts):
//   npx node-pg-migrate up   --config-file database/migrate-config.js
//   npx node-pg-migrate down --config-file database/migrate-config.js

require('dotenv').config();

module.exports = {
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'tak_team_manager',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,

    // node-pg-migrate options (read from this same "db" config section)
    'migrations-dir': 'database/migrations',
    'migrations-table': 'pgmigrations',
    'migration-file-language': 'cjs'
  }
};
