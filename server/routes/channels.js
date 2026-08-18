const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const Channel = require('../models/Channel');
const Team = require('../models/Team');
const pool = require('../config/database');
const router = express.Router();

// Get channel descriptions for user's groups
//
// Previously made one live Authentik HTTP call PER unique base channel
// name (run in parallel via Promise.all, but still N live external round
// trips) to fetch each group's `attributes.description` -- called by
// Dashboard.jsx on every single Dashboard load, this was the actual
// remaining cause of Dashboard slowness after GET /api/users/me's own
// live-Authentik-call removal: that fix alone did not make the Dashboard
// fully local, because this second route still hit Authentik on the same
// page load.
//
// A later change removed the live Authentik call entirely but went too
// far: it also dropped the local database lookup, unconditionally
// returning the literal string 'TAK Channel' for every channel
// regardless of whether a real description exists locally. This
// regressed the Dashboard to show "TAK Channel" for every channel
// instead of its actual description. Fixed here by querying the three
// local tables that already store each channel type's real description
// (`channels`, `bch_channels`, `region_channels` -- populated by
// Team.createTeamChannel/GlobalChannelService/syncWorker.js's sync, no
// Authentik call needed at all) instead of either hitting Authentik live
// or hardcoding a placeholder.
//
// Group-name-to-local-row matching: `req.user.groups` (from
// `user_cache.groups`, populated by authentikSync.js's
// `groupMap[groupId] = group.name`) holds the raw Authentik GROUP NAME,
// e.g. "tak_Teams - FENZ - Southland District", "tak_BCH - Community -
// Amateur Radio APRS_READ", "tak_Regions - Auckland". After stripping
// the "tak_" prefix and any "_READ"/"_WRITE" suffix (both already done
// below for the base-channel-name grouping itself):
//   - a team channel's base name matches `channels.display_name` exactly
//     (e.g. "Teams - FENZ - Southland District")
//   - a BCH channel's base name has an additional "BCH - " prefix beyond
//     what `bch_channels.name` stores (e.g. base name "BCH - Community -
//     Amateur Radio APRS" -> bch_channels.name "Community - Amateur
//     Radio APRS") -- confirmed against syncWorker.js's
//     syncExistingGlobalChannels, which strips exactly `tak_BCH${separator}`
//     (not just "tak_") when populating bch_channels.name
//   - likewise a region channel's base name has an additional
//     "Regions - " prefix beyond `region_channels.name`
router.get('/descriptions', authenticateToken, authorize, async (req, res) => {
  try {
    const userGroups = req.user.groups || [];
    const takGroups = userGroups.filter(groupName => groupName.startsWith('tak_'));
    
    // Get unique base channel names (still including the "tak_" prefix at
    // this point, matching this route's pre-existing `name` field shape
    // that Dashboard.jsx's descriptionMap key lookup depends on).
    const baseChannels = new Set()
    takGroups.forEach(groupName => {
      let baseName
      if (groupName.endsWith('_READ')) {
        baseName = groupName.slice(0, -5)
      } else if (groupName.endsWith('_WRITE')) {
        baseName = groupName.slice(0, -6)
      } else {
        baseName = groupName
      }
      baseChannels.add(baseName)
    })

    const separator = process.env.CHANNEL_FOLDER_SEPARATOR || ' - ';

    // Fetch every locally-known description in 3 queries (not one query
    // per channel) and build lookup maps keyed the same way each table
    // actually stores its own `name` column.
    const [channelsResult, bchResult, regionResult] = await Promise.all([
      pool.query('SELECT display_name, description FROM channels WHERE description IS NOT NULL'),
      pool.query('SELECT name, description FROM bch_channels WHERE description IS NOT NULL'),
      pool.query('SELECT name, description FROM region_channels WHERE description IS NOT NULL')
    ]);

    const teamChannelDescByDisplayName = new Map(
      channelsResult.rows.map((row) => [row.display_name, row.description])
    );
    const bchDescByName = new Map(bchResult.rows.map((row) => [row.name, row.description]));
    const regionDescByName = new Map(regionResult.rows.map((row) => [row.name, row.description]));

    const bchPrefix = `BCH${separator}`;
    const regionPrefix = `Regions${separator}`;

    const channelDescriptions = Array.from(baseChannels).map((baseName) => {
      // Use group name for hierarchy (remove tak_ prefix)
      const displayName = baseName.replace('tak_', '');

      let description;
      if (displayName.startsWith(bchPrefix)) {
        description = bchDescByName.get(displayName.slice(bchPrefix.length));
      } else if (displayName.startsWith(regionPrefix)) {
        description = regionDescByName.get(displayName.slice(regionPrefix.length));
      } else {
        description = teamChannelDescByDisplayName.get(displayName);
      }

      return {
        name: baseName,
        display_name: displayName,
        description: description || 'TAK Channel'
      };
    });

    res.json({ channels: channelDescriptions });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch channel descriptions');
    res.status(500).json({ error: 'Failed to fetch channel descriptions' });
  }
});

// Create custom channel
router.post('/custom', authenticateToken, authorize, [
  body('teamId').isInt(),
  body('customSuffix').trim().isLength({ min: 1, max: 100 }),
  body('memberPermissions').isArray()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId, customSuffix, memberPermissions } = req.body;
    
    // Check if team exists and user has permission
    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    // Fast-path optimization only: this pre-check lets an obviously-over-the-limit
    // request fail before the more expensive Authentik group-creation calls run.
    // It is NOT the authoritative enforcement mechanism -- Channel.createCustomChannel
    // re-validates the count itself inside a SERIALIZABLE transaction immediately
    // before the INSERT (Requirement 16.6), which is what actually prevents a team
    // from ending up with more than 3 channels under concurrent requests. This
    // pre-check merely avoids unnecessary Authentik calls in the common,
    // non-concurrent case; it must never be relied on for correctness.
    const channelCount = await Channel.getChannelCount(teamId);
    if (channelCount >= 3) {
      return res.status(400).json({ error: 'Maximum of 3 channels allowed per team' });
    }
    
    // Validate member permissions format
    for (const memberPerm of memberPermissions) {
      if (!memberPerm.userId || !['read', 'write', 'read_write'].includes(memberPerm.permission)) {
        return res.status(400).json({ error: 'Invalid member permission format' });
      }
    }
    
    const channel = await Channel.createCustomChannel(teamId, customSuffix, memberPermissions);
    res.status(201).json({ channel });
  } catch (error) {
    if (error instanceof Channel.ChannelLimitError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to create custom channel');
    res.status(500).json({ error: 'Failed to create custom channel' });
  }
});

// Get channels for a team with member counts
router.get('/team/:teamId', authenticateToken, authorize, async (req, res) => {
  try {
    const { teamId } = req.params;
    
    const result = await pool.query(`
      SELECT c.*, COUNT(cm.user_id) as member_count
      FROM channels c
      LEFT JOIN channel_memberships cm ON c.id = cm.channel_id
      WHERE c.team_id = $1
      GROUP BY c.id
      ORDER BY c.is_primary DESC, c.name
    `, [teamId]);
    
    res.json({ channels: result.rows });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch channels');
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

module.exports = router;