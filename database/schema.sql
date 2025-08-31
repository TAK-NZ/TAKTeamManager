-- TAK Team Manager Database Schema

-- Users table (mirrors Authentik users)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    authentik_user_id INTEGER UNIQUE,
    username VARCHAR(150) UNIQUE NOT NULL,
    email VARCHAR(254) UNIQUE NOT NULL,
    first_name VARCHAR(150),
    last_name VARCHAR(150),
    is_global_manager BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Teams table (hierarchical structure)
CREATE TABLE teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    callsign_prefix VARCHAR(255),
    color VARCHAR(7) DEFAULT '#3B82F6',
    visibility VARCHAR(20) DEFAULT 'private',
    can_join BOOLEAN DEFAULT false,
    parent_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, parent_team_id)
);

-- Team memberships (users can only be member of one team)
CREATE TABLE team_memberships (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE, -- UNIQUE ensures single team membership
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Channels (map to Authentik LDAP groups)
CREATE TABLE channels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    authentik_group_id INTEGER,
    authentik_read_group_id INTEGER,
    authentik_write_group_id INTEGER,
    is_primary BOOLEAN DEFAULT false,
    channel_type VARCHAR(20) DEFAULT 'primary',
    custom_suffix VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, team_id)
);

-- Channel memberships
CREATE TABLE channel_memberships (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
    permission VARCHAR(20) DEFAULT 'read_write',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel_id)
);

-- Access requests (unauthenticated users requesting team access)
CREATE TABLE access_requests (
    id SERIAL PRIMARY KEY,
    email VARCHAR(254) NOT NULL,
    first_name VARCHAR(150) NOT NULL,
    last_name VARCHAR(150) NOT NULL,
    team_name VARCHAR(255) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'approved', 'denied'
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TIMESTAMP,
    review_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User cache table for Authentik sync
CREATE TABLE user_cache (
    id SERIAL PRIMARY KEY,
    authentik_id VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    takRole VARCHAR(100),
    takColor VARCHAR(50),
    takCallsign VARCHAR(100),
    groups TEXT[], -- Array of group names
    is_admin BOOLEAN DEFAULT false,
    last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Sync status table
CREATE TABLE sync_status (
    id SERIAL PRIMARY KEY,
    sync_type VARCHAR(50) NOT NULL,
    last_sync TIMESTAMP,
    status VARCHAR(20) DEFAULT 'pending', -- pending, running, success, error
    error_message TEXT,
    records_synced INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Audit log for tracking changes
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id INTEGER,
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Site configuration for editable text content
CREATE TABLE site_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT NOT NULL,
    description TEXT,
    updated_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default values for request access page
INSERT INTO site_config (config_key, config_value, description) VALUES 
('request_access_title', 'Request Team Access', 'Title shown on the request access page'),
('request_access_subtitle', 'Fill out this form to request access to a TAK team', 'Subtitle shown on the request access page'),
('request_access_footer', 'Note: TAK.NZ is for New Zealand Based First Responders or those sponsored by New Zealand Public Safety Agencies. If you are not a New Zealand First Responder refer to TAK.GOV for more information on TAK.', 'Footer text shown at the bottom of the request access page');

-- Indexes for performance
CREATE INDEX idx_teams_parent ON teams(parent_team_id);
CREATE UNIQUE INDEX idx_teams_callsign_prefix ON teams(callsign_prefix) WHERE callsign_prefix IS NOT NULL;
CREATE INDEX idx_team_memberships_user ON team_memberships(user_id);
CREATE INDEX idx_team_memberships_team ON team_memberships(team_id);
CREATE INDEX idx_team_memberships_role ON team_memberships(role);
CREATE INDEX idx_channels_team ON channels(team_id);
CREATE INDEX idx_channel_memberships_user ON channel_memberships(user_id);
CREATE INDEX idx_channel_memberships_channel ON channel_memberships(channel_id);
CREATE INDEX idx_access_requests_status ON access_requests(status);
CREATE INDEX idx_user_cache_username ON user_cache(username);
CREATE INDEX idx_user_cache_authentik_id ON user_cache(authentik_id);
CREATE INDEX idx_user_cache_is_admin ON user_cache(is_admin);
CREATE INDEX idx_user_cache_last_synced ON user_cache(last_synced);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_site_config_key ON site_config(config_key);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Architecture Redesign Tables

-- Track all pending/completed operations
CREATE TABLE sync_operations (
    id SERIAL PRIMARY KEY,
    operation_type VARCHAR(50) NOT NULL, -- 'add_user_to_group', 'remove_user_from_group', 'create_group'
    target_user_id INTEGER,
    target_group_id VARCHAR(255),
    payload JSONB, -- Additional operation data
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 100,
    next_retry_at TIMESTAMP DEFAULT NOW(),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_by INTEGER REFERENCES users(id)
);

-- Define group membership rules
CREATE TABLE group_membership_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(100) NOT NULL,
    rule_type VARCHAR(50) NOT NULL, -- 'team_hierarchy', 'bch_channels', 'region_channels'
    source_type VARCHAR(50), -- 'team', 'bch_channel', 'region_channel', 'all_users'
    source_id INTEGER,
    target_group_pattern VARCHAR(255) NOT NULL,
    permission_type VARCHAR(20), -- 'read', 'write', 'read_write'
    conditions JSONB,
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 100,
    created_at TIMESTAMP DEFAULT NOW()
);

-- BCH Channels (Broadcast/ETL channels)
CREATE TABLE bch_channels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    service_account_id VARCHAR(255),
    service_account_username VARCHAR(255),
    service_account_password TEXT,
    read_group_id VARCHAR(255),
    write_group_id VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Region Channels
CREATE TABLE region_channels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    group_id VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Bulk operation tracking
CREATE TABLE bulk_operations (
    id SERIAL PRIMARY KEY,
    operation_name VARCHAR(100) NOT NULL,
    total_items INTEGER NOT NULL,
    processed_items INTEGER DEFAULT 0,
    failed_items INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending',
    progress_percentage DECIMAL(5,2) DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Enhanced access requests for request/approval system
DROP TABLE IF EXISTS access_requests;
CREATE TABLE access_requests (
    id SERIAL PRIMARY KEY,
    request_type VARCHAR(50) NOT NULL, -- 'new_account', 'team_change', 'role_change', 'name_change'
    requester_email VARCHAR(255) NOT NULL,
    requester_first_name VARCHAR(255),
    requester_last_name VARCHAR(255),
    existing_user_id INTEGER REFERENCES users(id),
    target_team_id INTEGER REFERENCES teams(id),
    current_team_id INTEGER REFERENCES teams(id),
    requested_role VARCHAR(50),
    requested_first_name VARCHAR(255),
    requested_last_name VARCHAR(255),
    justification TEXT,
    status VARCHAR(20) DEFAULT 'pending',
    email_verified BOOLEAN DEFAULT false,
    email_verification_token VARCHAR(255),
    email_verification_expires_at TIMESTAMP,
    assigned_to_admin INTEGER REFERENCES users(id),
    escalation_level INTEGER DEFAULT 0,
    escalates_at TIMESTAMP,
    processed_by INTEGER REFERENCES users(id),
    processed_at TIMESTAMP,
    denial_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Admin notification preferences
CREATE TABLE admin_notification_preferences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) UNIQUE,
    notification_method VARCHAR(20) DEFAULT 'daily_digest',
    digest_time TIME DEFAULT '09:00:00',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- System configuration
CREATE TABLE system_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) NOT NULL UNIQUE,
    config_value TEXT NOT NULL,
    description TEXT,
    updated_by INTEGER REFERENCES users(id),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Email templates
CREATE TABLE email_templates (
    id SERIAL PRIMARY KEY,
    template_key VARCHAR(100) NOT NULL UNIQUE,
    subject_template TEXT NOT NULL,
    body_template TEXT NOT NULL,
    description TEXT,
    updated_by INTEGER REFERENCES users(id),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- New indexes
CREATE INDEX idx_sync_operations_status ON sync_operations(status);
CREATE INDEX idx_sync_operations_next_retry ON sync_operations(next_retry_at) WHERE status = 'pending';
CREATE INDEX idx_access_requests_status_new ON access_requests(status);
CREATE INDEX idx_access_requests_escalates_at ON access_requests(escalates_at) WHERE status = 'pending';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_teams_updated_at BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_site_config_updated_at BEFORE UPDATE ON site_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_admin_notification_preferences_updated_at BEFORE UPDATE ON admin_notification_preferences FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_system_config_updated_at BEFORE UPDATE ON system_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_email_templates_updated_at BEFORE UPDATE ON email_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();