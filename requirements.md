# TAK Team Manager Requirements

## Channel Display Requirements

**CRITICAL: Authentik is the source of truth for channel display in Dashboard**

- The Dashboard "My Channels" section MUST show ALL channels from user's Authentik groups that start with `tak_`
- Database channels are only used for team management, NOT for Dashboard display
- User should see all their Authentik TAK channels (BCH, Regions, Teams, etc.) in the Dashboard
- The folder tree should handle parent channels (like "Teams / FENZ") as expandable channels with permissions, not just folders
- Parent channels should show as channels with their permissions AND be expandable to show sub-channels

## Current Issue

- Dashboard is currently only showing database channels (2 channels) instead of Authentik groups (12+ channels)
- Need to fix the `/api/users/me` endpoint to properly return Authentik groups
- Dashboard should parse `tak_` groups from Authentik to display all user channels