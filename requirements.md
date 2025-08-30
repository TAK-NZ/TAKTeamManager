# TAK Team Manager - Requirements

## Project Overview
**Application Name:** TAK Team Manager
**Purpose:** Standalone web application for managing TAK (Team Awareness Kit) teams, users, and channels with Authentik integration
**Target Users:** Team administrators, end users requesting team access, IT administrators

## Core Features
### Must-Have (MVP)
- [ ] **Authentik OAuth2 Integration** - SSO login for existing users
- [ ] **Team Management** - Create/manage teams with hierarchical sub-teams
- [ ] **User Management** - Create users in Authentik, assign to teams
- [ ] **Channel Management** - Create/manage TAK channels (map to LDAP groups)
- [ ] **Access Requests** - Unauthenticated interface for team join requests
- [ ] **Approval System** - Team admins approve/deny user requests
- [ ] **User Dashboard** - View assigned teams and channels
- [ ] **Admin Dashboard** - Manage teams, users, approvals
- [ ] **Mobile Responsive** - Works on mobile devices

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
4. **As a global manager, I want to create new users in Authentik and assign team management roles**
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
- [ ] **User Onboarding:** New users can request team access without existing accounts
- [ ] **Team Management:** Admins can create hierarchical teams and manage membership
- [ ] **Channel Integration:** Channels properly map to Authentik LDAP groups
- [ ] **Mobile Usability:** All core functions work on mobile devices
- [ ] **Performance:** Page loads under 2 seconds, handles 100+ concurrent users

## Constraints & Assumptions
- **Integration Dependency:** Requires existing Authentik installation
- **Team Hierarchy:** Maximum 5 levels deep (technical limitation)
- **Performance:** Support up to 1000 users, 100 teams initially
- **Browser Support:** Modern browsers (Chrome, Firefox, Safari, Edge)
- **LDAP Mapping:** 3 LDAP groups per channel - tak_ChannelName (read/write), tak_ChannelName_READ (read-only), tak_ChannelName_WRITE (write-only)

## Security & Compliance
- [ ] **OAuth2 Authentication** via Authentik for existing users
- [ ] **Data Encryption** in transit (HTTPS) and at rest
- [ ] **Permission Isolation** - team managers only manage assigned teams, global managers have full access
- [ ] **Role-Based Access Control** - enforce single team membership and management permissions
- [ ] **Audit Logging** for user creation/modification
- [ ] **GDPR Compliance** for user data handling
- [ ] **Secure API Integration** with Authentik

---
*Created: [Date]*
*Last Updated: [Date]*