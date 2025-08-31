# TAK Team Manager - Requirements

## Project Overview
**Application Name:** TAK Team Manager
**Purpose:** Standalone web application for managing TAK (Team Awareness Kit) teams, users, and channels with Authentik integration
**Target Users:** Team administrators, end users requesting team access, IT administrators

**Terminology Note:** In user-facing interfaces, refer to "Authentik" as "Account Management System" to maintain system abstraction.

**Development Mode:** Currently in development - update database schema directly instead of using migrations.

## Core Features
### Must-Have (MVP)
- [x] **Authentik OAuth2 Integration** - SSO login for existing users
- [x] **Team Management** - Create/manage teams with hierarchical sub-teams
- [ ] **User Management** - Create users in Account Management System, assign to teams
- [x] **Channel Management** - Create/manage TAK channels (map to LDAP groups)
- [x] **Access Requests** - Unauthenticated interface for team join requests
- [ ] **Approval System** - Team admins approve/deny user requests
- [x] **User Dashboard** - View assigned teams and channels
- [x] **Admin Dashboard** - Manage teams, users, approvals
- [x] **Mobile Responsive** - Works on mobile devices

### Nice-to-Have (Future)
- [ ] **Email Notifications** - Notify admins of pending requests
- [ ] **In-app Notifications** - Real-time notification system
- [ ] **Bulk Operations** - Import/export users, bulk assignments
- [ ] **Reporting & Analytics** - Team membership reports
- [ ] **Advanced Permissions** - Granular role-based access

## User Roles & Permissions
### User Role Hierarchy
- **Global Admin** - Members of configurable Authentik admin group, full system access, can create top-level teams
- **Team Manager** - Can manage specific teams they're assigned to manage, can create child teams only
- **Team Member** - Standard user, member of exactly one team

### Admin Group Configuration
- **Admin Group Name** - Configurable via `ADMIN_GROUP_NAME` environment variable (default: `TakTeamManager_Admin`)
- **Admin Detection** - Users in admin group see additional "Admin" tab and have elevated permissions
- **Hierarchical Permissions** - Global admins create top-level teams, team managers create sub-teams

### Team Membership Rules
- **Single Team Membership** - Each user can only be a member of one team at a time
- **Multiple Management** - A user can manage multiple teams (without being a member)
- **Role Separation** - Team managers don't need to be members of teams they manage
- **Admin Privileges** - Global admins have access to admin interface and can manage all teams

## User Stories
1. **As a new user, I want to request access to a team so that I can join TAK communications**
2. **As a team manager, I want to approve/deny user requests for teams I manage so that I control team membership**
3. **As a team manager, I want to create sub-teams and channels for teams I manage so that I can organize team structure**
4. **As a global manager, I want to create new users in Account Management System and assign team management roles**
5. **As a user, I want to see my assigned team and channels so that I know my current access**
6. **As a team manager, I want to move users to a holding pen so that I can remove access without deleting accounts**
7. **As a global admin, I want to assign team management permissions to users**
8. **As a team manager, I want to transfer users between teams I manage**
9. **As a global admin, I want to access the admin interface to manage the entire system**
10. **As a global admin, I want to create top-level teams that team managers cannot create**

## Technical Requirements
### Frontend
- **Framework:** React or Vue.js (responsive design)
- **Styling:** Tailwind CSS (to match Authentik's modern look)
- **Key Libraries:** OAuth2 client, notification system, form validation

### Backend
- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** PostgreSQL (for team/channel relationships)
- **Integration:** Authentik REST API v3 (users, groups, service accounts)
- **Key APIs:** `/api/v3/core/users/`, `/api/v3/core/groups/`, OAuth2 endpoints

### Authentication
- **OAuth2 Provider:** Authentik
- **Session Management:** JWT tokens
- **Unauthenticated Access:** Public request forms

### Deployment
- **Hosting:** Docker containers (to match Authentik deployment)
- **Domain:** Custom domain with SSL
- **Environment:** Development, staging, production

## Success Criteria
- [x] **User Onboarding:** New users can request team access without existing accounts
- [x] **Team Management:** Admins can create hierarchical teams and manage membership
- [x] **Channel Integration:** Channels properly map to Authentik LDAP groups
- [x] **Mobile Usability:** All core functions work on mobile devices
- [x] **Performance:** Page loads under 2 seconds, handles 100+ concurrent users

## Constraints & Assumptions
- **Integration Dependency:** Requires existing Authentik installation
- **Team Hierarchy:** Maximum 5 levels deep (technical limitation)
- **Performance:** Support up to 1000 users, 100 teams initially
- **Browser Support:** Modern browsers (Chrome, Firefox, Safari, Edge)
- **LDAP Mapping:** Authentik groups with tak_ prefix and CN attributes for TAK integration
- **TAK Attribute Names:** Always use takRole, takColor, takCallsign (camelCase, not snake_case)

## Security & Compliance
- [ ] **OAuth2 Authentication** via Authentik for existing users
- [ ] **Data Encryption** in transit (HTTPS) and at rest
- [ ] **Permission Isolation** - team managers only manage assigned teams, global managers have full access
- [ ] **Role-Based Access Control** - enforce single team membership and management permissions
- [ ] **Audit Logging** for user creation/modification
- [ ] **GDPR Compliance** for user data handling
- [ ] **Secure API Integration** with Authentik

## Implementation Status

### ✅ Completed Features
- **OAuth2 Authentication** - Full Authentik SSO integration with JWT tokens
- **Hierarchical Team Management** - Root teams and unlimited sub-team depth
- **Callsign System** - Configurable prefix-based callsign generation
- **Automatic Channel Creation** - Teams get channels with proper LDAP group mapping
- **Request Access Interface** - Public form with searchable team dropdown
- **Admin Interface** - Team creation, editing, deletion with proper permissions
- **Site Configuration** - Editable page content and color mappings
- **Mobile Responsive Design** - Works across all device sizes
- **Channel Display** - Teams show associated channels in detail view

### 🔄 In Progress
- **User Management** - Basic framework exists, needs Account Management System user creation
- **Approval System** - Request submission works, needs admin approval workflow

### 📋 Technical Implementation Details
- **Database Schema** - PostgreSQL with teams, channels, site_config, user_cache tables
- **Team Structure** - Parent-child relationships with callsign_prefix for display names
- **Channel Naming** - "Teams / {prefix} / {name}" format with automatic Authentik group creation
- **LDAP Integration** - Groups created with tak_ prefix and proper CN attributes
- **Color System** - Environment-based TAK color mappings for New Zealand agencies
- **Bulk Import** - 82 teams imported including full LandSAR hierarchy
- **TAK User Attributes** - Use correct attribute names: takRole, takColor, takCallsign (NOT tak_role, tak_color, tak_callsign)
- **User Removal** - When users are removed from teams, TAK attributes (takRole, takColor, takCallsign) must be cleared/removed

---
*Created: December 2024*
*Last Updated: January 2025*