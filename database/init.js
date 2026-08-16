const { runner } = require('node-pg-migrate');
const pool = require('../server/config/database');
const migrateConfig = require('./migrate-config');

// Runs all pending migrations (database/migrations/*) up to the latest,
// using the same connection config already defined in migrate-config.js
// (which itself reads the DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD
// environment variables), instead of executing schema.sql directly.
//
// node-pg-migrate resolves `dir` relative to process.cwd(), matching the
// `database/migrations` value already used by the `migrate*` npm scripts
// (which are run from the repository root).
async function runMigrations() {
  const { db } = migrateConfig;

  await runner({
    databaseUrl: {
      user: db.user,
      host: db.host,
      database: db.database,
      password: db.password,
      port: db.port,
      ssl: db.ssl
    },
    dir: db['migrations-dir'],
    migrationsTable: db['migrations-table'] || 'pgmigrations',
    direction: 'up',
    verbose: false
  });
}

async function initializeDatabase() {
  try {
    console.log('Initializing database...');

    await runMigrations();

    console.log('Database migrations applied successfully');
    
    // Create default holding pen team
    await pool.query(`
      INSERT INTO teams (name, description) 
      VALUES ('Holding Pen', 'Default team for users without specific team assignment')
      ON CONFLICT DO NOTHING
    `);
    
    // Insert initial sync status
    await pool.query(`
      INSERT INTO sync_status (sync_type, status) 
      VALUES ('user_sync', 'pending') 
      ON CONFLICT DO NOTHING
    `);
    
    // Insert default system configuration
    await pool.query(`
      INSERT INTO system_config (config_key, config_value, description) VALUES 
      ('escalation_hours', '24', 'Hours before request escalates to next level'),
      ('weekend_escalation', 'false', 'Whether to escalate requests on weekends'),
      ('holiday_escalation', 'false', 'Whether to escalate requests on holidays'),
      ('email_verification_hours', '24', 'Hours before email verification expires')
      ON CONFLICT (config_key) DO NOTHING
    `);
    
    // Insert default email templates
    await pool.query(`
      INSERT INTO email_templates (template_key, subject_template, body_template, description) VALUES 
      ('access_request_verification', 'Verify your TAK Team Manager access request', 
      'Please click the following link to verify your email and complete your access request: {{verification_link}}\n\nThis link will expire in {{expiry_hours}} hours.\n\nIf you did not make this request, please ignore this email.',
      'Email verification for new access requests'),
      
      ('access_request_approved', 'Your TAK Team Manager access request has been approved',
      'Your request to {{request_description}} has been approved by {{admin_name}}.\n\n{{additional_details}}\n\nYou can now log in to TAK Team Manager.',
      'Notification when access request is approved'),
      
      ('access_request_denied', 'Your TAK Team Manager access request has been denied',
      'Your request to {{request_description}} has been denied by {{admin_name}}.\n\nReason: {{denial_reason}}\n\nIf you have questions, please contact your team administrator.',
      'Notification when access request is denied'),
      
      ('admin_notification_digest', 'TAK Team Manager - Pending Requests Digest',
      'You have {{pending_count}} pending access requests requiring your attention:\n\n{{request_list}}\n\nPlease log in to TAK Team Manager to review these requests.',
      'Daily digest of pending requests for admins')
      ON CONFLICT (template_key) DO NOTHING
    `);
    
    // Insert default group membership rules
    await pool.query(`
      INSERT INTO group_membership_rules (rule_name, rule_type, source_type, target_group_pattern, permission_type, priority) VALUES
      ('Team Channel Access', 'team_hierarchy', 'team', 'tak_{{team_name}}', 'read_write', 100),
      ('Parent Team Inheritance', 'team_hierarchy', 'team', 'tak_{{parent_team_name}}', 'read_write', 200)
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