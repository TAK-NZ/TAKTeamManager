# TAK Team Manager Requirements

## Team Management System

### Hierarchical Team Structure
- Teams can have parent-child relationships forming a hierarchy
- Sub-teams inherit properties from parent teams (color, visibility constraints)
- Team membership inheritance: users in child teams automatically become inherited members of all parent teams
- Maximum team hierarchy depth: unlimited
- Each team automatically gets a primary channel created in Authentik

### User Management
- Users can be created directly in Authentik through the interface
- Users can be added to teams as direct members or admins
- Users inherit membership in all parent teams when added to a child team
- Users are automatically assigned to team channels in Authentik when added to teams
- TAK callsigns, colors, and roles are automatically generated and synced to Authentik

### Channel Management
- Each team gets a primary channel automatically created in Authentik
- Teams can create up to 3 total channels (1 primary + 2 custom)
- Channel names follow pattern: "Teams / [Root Team] / [Sub Team]" for hierarchy
- Users are automatically added to appropriate channels based on team membership
- Channel permissions: read, write, or read_write

### Team Membership Inheritance
- When a user is added to a child team, they automatically become inherited members of all parent teams
- Inherited members are added to parent team primary channels in Authentik
- Inherited memberships are properly tracked and displayed in the UI
- Inherited team names are clickable links that navigate to the source team
- Dashboard automatically refreshes to show new channel access when users are added to teams

### Dashboard Channel Display
- Dashboard "My Channels" shows ALL channels from user's Authentik groups starting with `tak_`
- Channels are organized in a hierarchical folder structure
- Parent channels appear as expandable channels with permissions, not just folders
- Real-time updates when user team assignments change
- Proper permission badges (Read, Write, Read/Write) for each channel

### Access Control
- Global admins can manage all teams and users
- Team admins can manage their specific teams
- Public teams allow join requests from unauthenticated users
- Private teams require admin approval for membership

### Integration
- Full integration with Authentik OAuth2 for authentication
- Automatic user attribute synchronization (callsign, color, role)
- Authentik groups used as source of truth for channel access
- Real-time synchronization between database and Authentik