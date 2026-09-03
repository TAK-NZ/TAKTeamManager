// Install-time entry point: runs all pending migrations and seeds baseline
// data, then exits. This is intentionally scoped to SCHEMA + SEED ONLY; it
// does NOT warm the user_cache table.
//
// DEPLOY NOTE: after this script completes, the deploy should also run
// `npm run sync:users` (i.e. `node database/init.js && npm run sync:users`)
// to perform one full Authentik user sync BEFORE the app starts serving
// logins. Warming user_cache up front means first-boot users (or users
// added to Authentik since the last periodic sync) don't hit
// `?error=user_not_synced` while waiting for the initial/next periodic sync.
// Schema-init and cache-sync are kept as separate composable steps so a
// deploy (e.g. CDK) can chain them explicitly rather than coupling them here.
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
    process.stdout.write('Initializing database...\n');

    await runMigrations();

    process.stdout.write('Database migrations applied successfully\n');
    
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
    
    // Insert default email templates.
    //
    // NOTE: the access_request_verification and access_request_approved
    // body_template values below carry the STYLED HTML content that a former
    // migration (1786910000000_update-email-templates-styling.cjs) used to
    // apply via UPDATE. In the squashed world, migrations run BEFORE these
    // INSERTs (init.js calls runMigrations() first, then seeds), so an UPDATE
    // in the baseline migration would run before these rows exist and no-op.
    // To preserve the final styled content, that styling has been folded
    // directly into these INSERT bodies (dollar-quoted so the embedded HTML
    // quotes/apostrophes need no escaping). See the baseline migration header.
    await pool.query(`
      INSERT INTO email_templates (template_key, subject_template, body_template, description) VALUES 
      ('access_request_verification', 'Verify your TAK Team Manager access request', 
      $tpl$Hi {{first_name}},

Please verify your email to complete your account request.

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td align="center"><a href="{{verification_link}}" class="btn-primary" style="text-decoration: none; color: #FFF; background-color: #348eda; border: solid #348eda; border-width: 10px 20px; font-weight: bold; display: inline-block; border-radius: 4px;">Verify my email</a></td></tr></table>

<span style="font-size: 12px; color: #999;">If the button above doesn't work, copy and paste this link into your browser:</span>
{{verification_link}}

This link will expire in {{expiry_hours}} hours.

If you did not make this request, you can safely ignore this email.$tpl$,
      'Email verification for new access requests'),
      
      ('access_request_approved', 'Your TAK Team Manager access request has been approved',
      $tpl$Hi {{first_name}},

Your request for an account has been approved.

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 16px 0;"><tr><td style="background-color: #f0f7ff; border-radius: 8px; border-left: 4px solid #348eda; padding: 16px 20px;"><b>Team:</b> {{team_path}}<br><b>Username:</b> <a href="#" style="color: #212124; text-decoration: none; cursor: default; pointer-events: none;">{{username}}</a><br><b>TAK Callsign:</b> <code>{{callsign}}</code></td></tr></table>

Get started: <a href="{{password_reset_url}}">Set a password</a>, or sign in with an Apple or Google account linked to your username above.

Login at: {{login_url}}

If you have questions, contact your team administrator.$tpl$,
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
    
    process.stdout.write('Default data inserted\n');
    process.exit(0);
  } catch (error) {
    process.stderr.write(`Database initialization failed: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeDatabase();
}

module.exports = initializeDatabase;