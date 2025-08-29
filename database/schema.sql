-- TAK Team Manager Database Schema

-- Users table (mirrors Authentik users)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    authentik_user_id INTEGER UNIQUE,
    username VARCHAR(150) UNIQUE NOT NULL,
    email VARCHAR(254) UNIQUE NOT NULL,
    first_name VARCHAR(150),
    last_name VARCHAR(150),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Teams table (hierarchical structure)
CREATE TABLE teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    parent_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, parent_team_id)
);

-- Team memberships with roles
CREATE TABLE team_memberships (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    role VARCHAR(50) DEFAULT 'member', -- 'admin', 'member'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, team_id)
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
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, team_id)
);

-- Channel memberships
CREATE TABLE channel_memberships (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
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

-- Indexes for performance
CREATE INDEX idx_teams_parent ON teams(parent_team_id);
CREATE INDEX idx_team_memberships_user ON team_memberships(user_id);
CREATE INDEX idx_team_memberships_team ON team_memberships(team_id);
CREATE INDEX idx_channels_team ON channels(team_id);
CREATE INDEX idx_channel_memberships_user ON channel_memberships(user_id);
CREATE INDEX idx_channel_memberships_channel ON channel_memberships(channel_id);
CREATE INDEX idx_access_requests_status ON access_requests(status);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_teams_updated_at BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();