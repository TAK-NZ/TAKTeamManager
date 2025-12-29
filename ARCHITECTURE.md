# TAK Team Manager Architecture

## System Overview

TAK Team Manager is a web application that manages TAK teams, users, and channels through Authentik OAuth2 integration. The system provides hierarchical team management, global channel administration, and automated synchronization with Authentik groups.

## Architecture Components

### Core Services
- **Web API**: Express.js REST API with React frontend
- **Sync Worker**: Background service for Authentik synchronization
- **Database**: PostgreSQL with operation queue tables
- **Authentication**: Authentik OAuth2 integration

### Key Features
- Hierarchical team structure with inheritance
- Global channel management (BCH and Region channels)
- Automated callsign generation with configurable formats
- Bulk operations with progress tracking
- Robust error handling and retry logic

## Database Schema

### Core Tables
- `teams`: Hierarchical team structure with callsign configuration
- `users`: Local user records linked to Authentik users
- `team_memberships`: User-team relationships with inheritance tracking
- `bch_channels`: BCH channels with service account management
- `region_channels`: Region channels with read/write group tracking
- `sync_operations`: Asynchronous operation queue with retry logic

### Key Design Patterns
- **Asynchronous Operations**: All Authentik API calls queued through sync worker
- **Inheritance Tracking**: Team memberships track inherited vs direct assignments
- **Retry Logic**: Exponential backoff with 48-hour retry window
- **Name Splitting**: Automatic splitting of full names for callsign generation

## Synchronization Architecture

### Sync Worker
- **Purpose**: Dedicated service for all Authentik API interactions
- **Queue Processing**: PostgreSQL-based operation queue with row-level locking
- **Error Handling**: Comprehensive retry logic with exponential backoff
- **Connection Management**: Dedicated connection pool with health monitoring

### Operation Types
- `add_user_to_group` / `remove_user_from_group`
- `create_bch_channel_groups` / `create_region_channel_group`
- `update_bch_channel_group` / `update_region_channel_group`
- `delete_global_channel`
- `assign_user_to_global_channels`
- `sync_existing_global_channels`

### Conflict Resolution
- **TAK Team Manager Database WINS** for all `tak_` prefixed groups
- **Ignored Users**: Users with `TakTeamManager: false` attribute are excluded
- **Drift Correction**: Authentik state corrected to match database

## Global Channel Management

### BCH Channels (Broadcast Channels)
- **Purpose**: Emergency Traffic Lanes with ETL functionality
- **Naming**: `tak_BCH - ChannelName` (write) and `tak_BCH - ChannelName_READ` (read)
- **Service Accounts**: Dedicated service account per channel with `etl-` prefix
- **User Access**: All users get read access, service accounts get write access
- **Creation**: Global admins only via graphical UI

### Region Channels
- **Purpose**: Regional coordination across team boundaries
- **Naming**: `tak_Regions - ChannelName` (write) and `tak_Regions - ChannelName_READ` (read)
- **User Access**: 
  - Regular team users: Read-write access
  - Private team users: Read-only access
- **Creation**: Global admins only

### Channel Hierarchy Display
- **Frontend**: Hierarchical folder tree structure using configurable separator
- **Separator**: Configurable via `CHANNEL_FOLDER_SEPARATOR` environment variable
- **TAK Compatibility**: Uses `-` separator instead of `/` for TAK compatibility

## User Management

### User Roles
- **Regular User**: Member of one team with inherited parent team access
- **Team Admin**: Can manage assigned team and all sub-teams
- **Global Admin**: Full system access including global channel management

### Callsign Generation
- **Configurable Formats**: 
  - `first_last_initial`: "John D"
  - `first_initial_last`: "J Doe"
  - Default: "John Doe"
- **Name Splitting**: Automatic splitting of full names when last name is empty
- **Team Hierarchy**: Includes team prefixes based on `callsign_subteam_depth`
- **Format**: `TEAM-SUBTEAM-Name` with configurable depth

### Team Structure
- **Hierarchical**: Unlimited nesting with parent-child relationships
- **Inheritance**: Users inherit access to all parent teams
- **Visibility**: Teams can be public or private (affects region channel access)
- **Colors**: 25 predefined team colors including Dark Blue

## Access Control Patterns

### Team Access
- **Direct Membership**: User belongs to one specific team (their "Unit")
- **Inherited Access**: Automatic access to all parent teams
- **Channel Access**: Read-write to unit and parent team primary channels

### Global Channel Access
- **BCH Channels**: All users get read access
- **Region Channels**: 
  - Regular team users: Read-write access
  - Private team users: Read-only access
- **Removal Logic**: Users without teams are removed from all channels

### Navigation Access
- **Teams/Users Tabs**: Admin users only
- **Requests Tab**: Hidden from non-admin users
- **Dashboard**: All authenticated users

## Technical Implementation

### Frontend (React + Vite)
- **UI Framework**: Tailwind CSS with consistent design patterns
- **State Management**: React hooks with API service layer
- **Responsive Design**: Mobile-friendly interface
- **Icons**: Consistent iconography across Teams and Global Channels pages

### Backend (Node.js + Express)
- **Authentication**: Authentik OAuth2 with JWT tokens
- **Database**: PostgreSQL with connection pooling
- **API Design**: RESTful endpoints with validation middleware
- **Error Handling**: Comprehensive error responses with logging

### Deployment
- **Containerization**: Docker Compose with multi-service setup
- **Services**: Web app, sync worker, PostgreSQL
- **Environment**: Configurable via `.env` file
- **Health Checks**: Database health monitoring

## Performance Characteristics

### Scale Requirements
- **Users**: Up to 50,000 regular users
- **Team Admins**: Up to 5,000
- **Global Admins**: Up to 50
- **Bulk Operations**: 30-60 minutes for 50,000 user operations

### Optimization Features
- **Batch Processing**: Efficient bulk user assignments
- **Progress Tracking**: Real-time progress for long-running operations
- **Connection Pooling**: Dedicated pools for web and worker services
- **Retry Logic**: Exponential backoff with 48-hour retry window

## Security Features

### Authentication & Authorization
- **OAuth2**: Authentik integration with group-based permissions
- **JWT Tokens**: Secure token-based authentication
- **Role-Based Access**: Team admin and global admin roles
- **Session Management**: Secure session handling

### Data Protection
- **Input Validation**: Comprehensive request validation
- **SQL Injection Prevention**: Parameterized queries
- **XSS Protection**: Input sanitization and output encoding
- **CSRF Protection**: Token-based CSRF prevention

## Monitoring & Observability

### Logging
- **Structured Logging**: JSON-formatted logs with correlation IDs
- **Error Tracking**: Comprehensive error logging with stack traces
- **Operation Tracking**: Full audit trail of sync operations
- **Performance Metrics**: API response times and database query performance

### Health Monitoring
- **Database Health**: Connection pool monitoring
- **Sync Worker Health**: Operation queue depth and processing rates
- **API Health**: Endpoint availability and response times
- **Authentik Integration**: API call success rates and error tracking

## Development Setup

### Docker Environment
```yaml
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: tak_team_manager
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"

  app:
    build: .
    ports:
      - "3000:3000"
      - "5173:5173"
    env_file:
      - .env
    environment:
      DB_HOST: postgres
    depends_on:
      postgres:
        condition: service_healthy

  sync-worker:
    build: .
    env_file:
      - .env
    environment:
      DB_HOST: postgres
    depends_on:
      postgres:
        condition: service_healthy
    command: node server/workers/syncWorker.js
    restart: unless-stopped
```

### Environment Configuration
- **Database**: PostgreSQL connection settings
- **Authentik**: URL and admin token configuration
- **Channel Settings**: Folder separator and naming conventions
- **JWT**: Secret key for token signing

## API Endpoints

### Authentication
- `GET /api/auth/login` - OAuth2 login redirect
- `GET /api/auth/callback` - OAuth2 callback
- `GET /api/users/me` - Current user profile

### Team Management
- `GET /api/teams/my-teams` - User's teams
- `POST /api/teams` - Create team
- `PUT /api/teams/:id` - Update team
- `DELETE /api/teams/:id` - Delete team

### User Management
- `GET /api/users` - List users (admin)
- `POST /api/users/create-and-add` - Create user and add to team
- `POST /api/users/add-to-team` - Add existing user to team
- `DELETE /api/users/remove-from-team/:userId` - Remove user from team

### Global Channels
- `GET /api/global-channels` - List global channels
- `POST /api/global-channels/bch` - Create BCH channel
- `POST /api/global-channels/region` - Create region channel
- `PUT /api/global-channels/bch/:id` - Update BCH channel
- `PUT /api/global-channels/region/:id` - Update region channel
- `DELETE /api/global-channels/:id` - Delete global channel
- `POST /api/global-channels/sync` - Sync existing channels

### Channel Descriptions
- `GET /api/channels/descriptions` - Get channel descriptions for user's groups

## Key Implementation Details

### Name Splitting Logic
When users have full names stored in the `first_name` field with empty `last_name`:
- Automatically splits full names for callsign generation
- Handles special characters and Unicode names
- Fallback to first name only if splitting fails

### Sync Worker Robustness
- Dedicated connection pool with error isolation
- JSON payload type checking for PostgreSQL driver compatibility
- Comprehensive retry logic with exponential backoff
- Graceful handling of database connection issues

### UI Consistency
- Teams page serves as design system reference
- Consistent icons, hover effects, and modal dialogs
- Hierarchical folder tree display for channels
- Mobile-responsive design patterns

### Global Channel Assignment
- Users must belong to at least one team for global channel access
- Private team users get read-only access to region channels
- Automatic removal from channels when user has no teams
- Bulk assignment operations with progress tracking