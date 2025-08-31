# TAK Team Manager Architecture Redesign Plan

## Current Architecture Issues

### Scalability Problems
- Synchronous Authentik operations block web requests
- Complex inheritance logic scattered across route handlers
- No support for concurrent operations or multiple container instances
- Bulk operations (adding 1000s of users to new groups) would timeout/fail
- No detection or correction of out-of-band Authentik changes

### Complexity Issues
- Team membership inheritance logic is complex and will grow more complex
- Adding two new categories of global groups will increase complexity exponentially
- No centralized business logic for group membership calculations
- Error handling and rollback scenarios are not properly managed

## Proposed Architecture

### 1. Event-Driven Architecture with Message Queue

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web API       │    │  Sync Workers   │    │ Reconciliation  │
│   (Multiple)    │    │  (Multiple)     │    │   Service       │
│ - Immediate DB  │    │ - Process Queue │    │ - Detect Drift  │
│ - Queue Events  │    │ - Authentik Ops │    │ - Auto-correct  │
│ - User Feedback │    │ - Retry Logic   │    │ - Alert Issues  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │  PostgreSQL DB  │
                    │ (sync_operations │
                    │   job queue)    │
                    │ - Event Store   │
                    │ - Job Queue     │
                    │ - Retry Logic   │
                    └─────────────────┘
```

**Benefits:**
- Horizontal scaling by adding worker containers
- Non-blocking user operations
- Reliable operation processing with retry logic
- Audit trail of all operations

### 2. Service Layer Architecture

#### Core Services

```javascript
// Business Logic Services
TeamMembershipService     // Handle team assignment logic
GroupMembershipCalculator // Calculate required groups for users
BulkOperationService     // Handle large-scale operations
ReconciliationService    // Detect and correct drift
AuthentikSyncService     // Manage Authentik API operations

// Infrastructure Services
EventPublisher          // Publish events to queue
OperationTracker       // Track operation status
ConfigurationService   // Manage group rules
RequestApprovalService  // Handle request/approval workflow
NotificationService     // Manage admin notifications
EmailService           // Handle email verification and templates
EscalationService      // Daily escalation processing
TemplateService        // Manage configurable email templates
```

#### Service Responsibilities

**TeamMembershipService**
- Calculate team inheritance hierarchy
- Determine all affected teams when user added/removed
- Coordinate with GroupMembershipCalculator
- Publish events for async processing

**GroupMembershipCalculator**
- Apply team-based group rules
- Apply global mandatory group rules
- Apply role-based group rules
- Return complete group membership list

**BulkOperationService**
- Process operations in configurable batches
- Implement backpressure control
- Provide progress tracking
- Handle partial failures gracefully

### 3. Enhanced Data Model

#### New Tables for Operation Tracking

```sql
-- Track all pending/completed operations
CREATE TABLE sync_operations (
    id SERIAL PRIMARY KEY,
    operation_type VARCHAR(50) NOT NULL, -- 'add_user_to_group', 'remove_user_from_group', 'create_group'
    target_user_id INTEGER,
    target_group_id VARCHAR(255),
    payload JSONB, -- Additional operation data
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 100, -- Allow retries for 48+ hours
    next_retry_at TIMESTAMP, -- Exponential backoff scheduling
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
    source_id INTEGER, -- team_id, channel_id, etc. (NULL for global rules)
    target_group_pattern VARCHAR(255) NOT NULL, -- Group name or pattern
    permission_type VARCHAR(20), -- 'read', 'write', 'read_write'
    conditions JSONB, -- Additional conditions for rule application
    is_active BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 100, -- Rule application order
    created_at TIMESTAMP DEFAULT NOW()
);

-- BCH Channels (Broadcast/ETL channels)
CREATE TABLE bch_channels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    service_account_id VARCHAR(255), -- Authentik service account ID
    service_account_username VARCHAR(255), -- etl-{channel_name}
    service_account_password TEXT, -- Encrypted, only accessible to global admins
    read_group_id VARCHAR(255), -- Authentik group ID for read access
    write_group_id VARCHAR(255), -- Authentik group ID for write access
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
    group_id VARCHAR(255), -- Authentik group ID
    is_active BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Track reconciliation results
CREATE TABLE reconciliation_reports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    discrepancies_found INTEGER DEFAULT 0,
    corrections_queued INTEGER DEFAULT 0,
    report_data JSONB, -- Detailed findings
    created_at TIMESTAMP DEFAULT NOW()
);

-- Bulk operation tracking
CREATE TABLE bulk_operations (
    id SERIAL PRIMARY KEY,
    operation_name VARCHAR(100) NOT NULL,
    total_items INTEGER NOT NULL,
    processed_items INTEGER DEFAULT 0,
    failed_items INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    progress_percentage DECIMAL(5,2) DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Request/Approval System Tables
CREATE TABLE access_requests (
    id SERIAL PRIMARY KEY,
    request_type VARCHAR(50) NOT NULL, -- 'new_account', 'team_change', 'role_change', 'name_change'
    requester_email VARCHAR(255) NOT NULL,
    requester_first_name VARCHAR(255),
    requester_last_name VARCHAR(255),
    existing_user_id INTEGER REFERENCES users(id), -- NULL for new account requests
    target_team_id INTEGER REFERENCES teams(id),
    current_team_id INTEGER REFERENCES teams(id), -- For team change requests
    requested_role VARCHAR(50), -- For role change requests
    requested_first_name VARCHAR(255), -- For name change requests
    requested_last_name VARCHAR(255), -- For name change requests
    justification TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'denied', 'expired'
    email_verified BOOLEAN DEFAULT false,
    email_verification_token VARCHAR(255),
    email_verification_expires_at TIMESTAMP,
    assigned_to_admin INTEGER REFERENCES users(id), -- Current reviewing admin
    escalation_level INTEGER DEFAULT 0, -- 0=team admin, 1=parent admin, 2=global admin
    escalates_at TIMESTAMP, -- When to escalate to next level (excludes weekends/holidays)
    processed_by INTEGER REFERENCES users(id),
    processed_at TIMESTAMP,
    denial_reason TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Admin notification preferences
CREATE TABLE admin_notification_preferences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) UNIQUE,
    notification_method VARCHAR(20) DEFAULT 'daily_digest', -- 'in_app_email', 'daily_digest', 'disabled'
    digest_time TIME DEFAULT '09:00:00', -- When to send daily digest
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- System configuration for escalation timing
CREATE TABLE system_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) NOT NULL UNIQUE,
    config_value TEXT NOT NULL,
    description TEXT,
    updated_by INTEGER REFERENCES users(id),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Insert default escalation configuration
INSERT INTO system_config (config_key, config_value, description) VALUES 
('escalation_hours', '24', 'Hours before request escalates to next level'),
('escalation_time', '09:00:00', 'Daily time when escalation processing occurs'),
('exclude_weekends', 'true', 'Exclude weekends from escalation timer'),
('exclude_holidays', 'true', 'Exclude holidays from escalation timer'),
('email_verification_hours', '24', 'Hours before email verification links expire');

-- Email templates (admin-configurable, based on Authentik templates)
CREATE TABLE email_templates (
    id SERIAL PRIMARY KEY,
    template_name VARCHAR(100) NOT NULL UNIQUE, -- 'email_verification', 'request_notification', 'approval_notification', 'daily_digest'
    subject_template TEXT NOT NULL,
    html_template TEXT NOT NULL,
    text_template TEXT NOT NULL,
    is_active BOOLEAN DEFAULT true,
    is_system_template BOOLEAN DEFAULT false, -- System templates have restricted editing
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by INTEGER REFERENCES users(id)
);

-- Request audit trail
CREATE TABLE request_audit_log (
    id SERIAL PRIMARY KEY,
    request_id INTEGER REFERENCES access_requests(id),
    action VARCHAR(50) NOT NULL, -- 'created', 'escalated', 'approved', 'denied', 'expired'
    performed_by INTEGER REFERENCES users(id),
    previous_status VARCHAR(20),
    new_status VARCHAR(20),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### 4. Configuration-Driven Group Rules

```javascript
// config/groupMembershipRules.js
const GROUP_RULES = {
    // Team-based rules
    team_membership: {
        primary_channel: {
            pattern: "tak_Teams_{team_hierarchy}",
            permission: "read_write",
            description: "Primary team channel access"
        },
        parent_teams: {
            inherit: true,
            permission: "read_write",
            description: "Inherit parent team channel access"
        }
    },
    
    // BCH Channels (Broadcast/ETL channels)
    bch_channels: {
        prefix: "tak_BCH_",
        user_assignment: "read_only", // All users get READ access
        service_account_required: true,
        groups_per_channel: ["_READ", "_WRITE"],
        creation_restricted_to: "global_admin",
        description: "Emergency Traffic Lane channels"
    },
    
    // Region Channels (Cross-team regional coordination)
    region_channels: {
        prefix: "tak_Region_",
        user_assignment: "read_write", // All users get READ_WRITE access
        creation_restricted_to: "global_admin",
        description: "Regional coordination channels"
    }
};
```

### 5. Implementation Phases

#### Phase 1: Service Layer Extraction (Week 1-2)
- Extract business logic from route handlers into services
- Implement TeamMembershipService and GroupMembershipCalculator
- Add comprehensive unit tests
- Maintain current synchronous behavior

#### Phase 2: Async Infrastructure (Week 3-4)
- Add Redis message queue
- Implement basic event publishing
- Create sync worker containers
- Add operation tracking tables
- Implement retry logic

#### Phase 3: Reconciliation Service (Week 5-6)
- Build reconciliation service
- Implement drift detection algorithms
- Add automated correction capabilities
- Create monitoring and alerting

#### Phase 4: BCH Channel Management (Week 7-8)
- Implement BCH channel creation with ETL script functionality
- Create service account management
- Add bulk user assignment to new BCH channels
- Implement read/write group creation

#### Phase 5: Region Channel Management (Week 9-10)
- Implement Region channel creation
- Add bulk user assignment to new Region channels
- Create UI for global admins to manage BCH and Region channels

#### Phase 6: Request/Approval System (Week 11-12)
- Implement request submission and email verification
- Build approval workflow with escalation logic
- Create admin notification system (real-time + digest)
- Develop email template system based on Authentik templates

#### Phase 7: Bulk Operations & Optimization (Week 13-14)
- Optimize for 50,000+ user scale
- Implement efficient batch processing
- Add progress tracking for large operations
- Performance testing and optimization

### 6. Monitoring and Observability

#### Key Metrics
- Queue depth and processing rate
- Operation success/failure rates by type
- Authentik API response times and rate limits
- Drift detection frequency and correction rates
- User operation completion times

#### Alerting
- Failed operations exceeding threshold
- Queue backup beyond acceptable limits
- Authentik API errors or rate limiting
- Significant drift detected
- Bulk operation failures

### 7. Deployment Strategy

#### Container Architecture
```yaml
# docker-compose.yml additions
services:
  web-api:
    replicas: 2-3
    
  sync-worker:
    replicas: 2-4
    environment:
      - WORKER_TYPE=sync
      - POLL_INTERVAL=5 # seconds
      
  reconciliation-worker:
    replicas: 1
    environment:
      - WORKER_TYPE=reconciliation
      - POLL_INTERVAL=60 # seconds
      
  # No Redis needed - using PostgreSQL for job queue
```

#### Rolling Deployment
- Blue-green deployment for web API
- Worker containers can be updated independently
- Database migrations with backward compatibility
- Feature flags for gradual rollout

## Requirements Clarification (ANSWERED)

### Global Group Categories

#### 1. Broadcast Channels (BCH)
- **Prefix**: "BCH / ..."
- **Purpose**: Used for ETLs (Emergency Traffic Lanes)
- **Creation**: Only global admins can create
- **Implementation**: Replace CloudTAK ETL script with graphical UI workflow (https://github.com/TAK-NZ/CloudTAK/blob/main/scripts/etl/create-etl-user-and-channel.sh)
- **Service Account Naming**: Must use "etl-" prefix for service account usernames
- **Groups Created**: Two groups per channel (READ and WRITE)
- **User Assignment**: ALL users automatically added to READ group
- **Service Account**: Each channel gets a dedicated service account
- **Bulk Impact**: New BCH channel = add all existing users to READ group

#### 2. Region Channels
- **Prefix**: "Region / ..."
- **Purpose**: Regional coordination across team boundaries
- **Creation**: Manually created by global admins
- **User Assignment**: ALL users get read-write access
- **Bulk Impact**: New Region channel = add all existing users with read-write permission

### User Roles and Access Patterns

#### Regular User
- **Unit Assignment**: Member of one specific team (their "Unit")
- **Team Inheritance**: Automatic inherited access to all parent teams
- **Global Access**: 
  - Read-only access to ALL BCH channels
  - Read-write access to ALL Region channels
- **Team Access**: Read-write access to unit team primary channel and parent team primary channels
- **Custom Access**: Manual assignment to additional channels within unit/parent teams

#### Team Admin
- **Scope**: Can manage assigned team and ALL its sub-teams (admin inheritance)
- **Access**: Same as regular user plus admin capabilities

#### Global Admin
- **Scope**: Can manage everything
- **Special Capabilities**: Create BCH and Region channels

### Scale Requirements
- **Users**: Up to 50,000 regular users
- **Team Admins**: Up to 5,000
- **Global Admins**: Up to 50
- **Total**: ~55,000 users maximum

### Conflict Resolution Strategy
- **TAK Team Manager Database WINS** for:
  - All groups with "tak_" prefix
  - All users WITHOUT "TakTeamManager: false" attribute
- **Authentik State Corrected**: When conflicts detected, Authentik updated to match database
- **Ignored Users**: Users with "TakTeamManager: false" attribute are completely ignored

### Performance & Operational Requirements (ANSWERED)

#### Bulk Operation Performance
- **Acceptable Duration**: 30-60 minutes for adding all 50,000 users to new BCH/Region channel
- **Progress Feedback**: Real-time progress bar for global admins during bulk operations
- **User Impact**: Only global admins affected by long-running operations

#### Error Handling & Retry Logic
- **Automatic Retry**: Yes, retry failed operations automatically
- **Retry Duration**: Continue retrying for at least 48 hours before giving up
- **Exponential Backoff**: Implement to avoid overwhelming Authentik API

#### BCH Service Account Management
- **Naming Convention**: Service accounts must start with "etl-" prefix
- **Credential Access**: Display and store credentials, accessible only to global admins
- **Security**: Secure storage with encryption at rest

#### Infrastructure Decision
- **Job Queue**: Use existing PostgreSQL database instead of Redis
- **Rationale**: Simpler deployment, avoid AWS Redis management complexity
- **Implementation**: Use `sync_operations` table with proper indexing

## Request/Approval System Requirements (ANSWERED)

### Request Types & Workflow
1. **New Account Requests**: Users select target team, routed to team admins for approval
2. **Team Change Requests**: Users request team transfer, lose current team access upon approval (one Unit team only)
3. **Role/Name Change Requests**: Users request role changes (Team Member, Team Lead, Sniper, Medic, etc.) or name updates

### Approval & Escalation Workflow
- **Email Verification**: New users must verify email before account creation
- **Configurable Escalation**: Default 24-hour escalation, configurable timing
- **One Level Escalation**: Escalates one parent team level at a time, then to global admins
- **Weekend/Holiday Exclusion**: Escalation timer excludes weekends and holidays
- **Bulk Approvals**: Team admins can approve multiple requests at once

### Notification System
- **Methods Available**: In-app notifications and email (admin selectable)
- **Single Preference**: One notification setting for all request types
- **Daily Digest**: Configurable timing per admin

### Request Visibility & Audit
- **Requester Visibility**: Users see request status and reviewing team (not specific admin)
- **Full Audit Trail**: Complete history of approvals/denials with timestamps and admin IDs
- **Email Templates**: Local versions based on existing Authentik templates

### Remaining Open Questions

#### Request/Approval System (ANSWERED)
- ✅ **Team Selection**: Users specify target team in request
- ✅ **Team Change Transition**: Immediate access loss upon approval (one Unit team only)
- ✅ **Role Change Types**: Team Member, Team Lead, Sniper, Medic, etc.
- ✅ **Escalation Timing**: Configurable timeframes (default 24 hours)
- ✅ **Multi-level Escalation**: One parent level at a time
- ✅ **Weekend Handling**: Exclude weekends and holidays from escalation timer
- ✅ **Real-time Delivery**: In-app notifications and email
- ✅ **Notification Preferences**: Single setting for all request types
- ✅ **Request Visibility**: Status and reviewing team visible to requester
- ✅ **Audit Trail**: Full approval/denial history required
- ✅ **Bulk Approvals**: Multiple request approval supported

#### Technical Requirements (ANSWERED)
- ✅ **Email Verification Expiry**: 24 hours
- ✅ **Template Customization**: Yes, admin-configurable email templates
- ✅ **Escalation Timing**: Daily at fixed time (9:00 AM default) with digest emails sent immediately after

#### Infrastructure
11. **Downtime Tolerance**: How much downtime is acceptable for major migrations?
12. **Backup Strategy**: How should we handle rollback scenarios if bulk operations fail partway through?
13. **Multi-tenancy**: Will this system need to support multiple organizations/tenants in the future?
14. **External Systems**: Are there other systems that need to be notified of user/group changes?
15. **Audit Requirements**: What level of audit logging is required for compliance?

## Local Development Strategy (CURRENT PHASE)

### Development Environment
- **Database**: Keep existing data, add new tables alongside current schema
- **Email**: Use existing AWS SES configuration from .env
- **Docker**: Add worker containers to existing docker-compose.yml
- **Testing**: Use existing sample data, create end-to-end workflows

### Production Deployment Strategy
- **Fresh Deployment**: New AWS deployment with clean database
- **Bootstrap Data**: Create deployment-specific seed scripts (NZ initial data, California later)
- **Multi-tenant Ready**: Architecture supports multiple deployments with different initial data

### Implementation Approach
1. **Phase 1**: Service layer extraction (maintain existing functionality)
2. **Phase 2**: Add async infrastructure with worker containers
3. **Phase 3**: Implement request/approval system
4. **Phase 4**: Add BCH/Region channel management
5. **Phase 5**: Bulk operations and optimization

### Environment Analysis
✅ **AWS SES Configured**: SMTP settings ready for email notifications
✅ **Authentik Integration**: OAuth2 and admin token configured
✅ **Database Ready**: PostgreSQL container with existing data
✅ **Docker Setup**: Ready for worker container additions

## Next Steps

1. **Add new database tables** alongside existing schema
2. **Extract service layer** from existing route handlers
3. **Add worker containers** to docker-compose.yml
4. **Implement async job processing** with PostgreSQL queue
5. **Test end-to-end workflows** with existing sample data

## Critical Architecture Considerations for Scale

### 50,000+ User Scale Implications
- **BCH Channel Creation**: Adding new BCH channel requires adding 50,000 users to read group
- **Region Channel Creation**: Adding new Region channel requires adding 50,000 users with read-write access
- **New User Creation**: Each new user must be added to ALL existing BCH and Region channels
- **Batch Processing**: Operations must be processed in batches of 100-500 to avoid timeouts
- **Queue Management**: Multiple worker containers essential for reasonable processing times
- **Progress Tracking**: Long-running operations need user-visible progress indicators

### ETL Script Integration Requirements
- Implement CloudTAK ETL script functionality within TAK Team Manager
- Create service accounts programmatically in Authentik
- Manage ETL user credentials securely
- Coordinate group creation with service account setup

This architecture will provide a solid foundation for scaling to 50,000+ users while maintaining data consistency and providing excellent user experience through async processing and proper bulk operation handling.