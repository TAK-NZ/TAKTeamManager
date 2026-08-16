const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const Channel = require('../models/Channel');
const Team = require('../models/Team');
const User = require('../models/User');
const ChannelRequestService = require('../services/ChannelRequestService');
const pool = require('../config/database');
const router = express.Router();

/**
 * Channel Creation Approval Workflow routes (Requirement 23, task 45.4).
 *
 * Exposes the `ChannelRequestService` methods implemented by tasks
 * 45.1-45.3 (`requestChannel`, `approveChannelRequest`,
 * `denyChannelRequest`) as HTTP endpoints, mirroring the conventions
 * already established by `server/routes/channels.js` (custom-channel
 * creation) and `server/routes/requests.js` (the existing
 * Access_Request approve/deny/pending-list pattern).
 *
 * Authorization for every route below is enforced centrally by
 * `authorize.js` via Permission_Registry entries
 * (`server/config/permissions.registry.js`), not by inline checks here,
 * matching the codebase-wide convention established by task 12 (see
 * `teams.js`/`channels.js`/`requests.js` for the same pattern):
 *   - `POST /` (submit a request): Global_Manager OR admin (per
 *     `Team.isAdmin`) of the target team (`req.body.teamId`) --
 *     `ChannelRequestService.requestChannel` itself further branches
 *     internally on Global_Manager status to decide immediate-vs-pending
 *     creation (Req 23.2/23.3), but a caller who is neither a
 *     Global_Manager nor an admin of the target team must still be
 *     denied outright before reaching the handler.
 *   - `GET /pending` (list pending requests): any authenticated user may
 *     reach the handler (mirrors `GET /api/requests/pending`'s existing
 *     shape exactly); the handler itself scopes the result set to the
 *     caller's administered team(s), or to every pending request for a
 *     Global_Manager.
 *   - `POST /:requestId/approve` / `POST /:requestId/deny`: Global_Manager
 *     OR admin (per `Team.isAdmin`) of the parent team of the target
 *     Channel_Request's `team_id` (Req 23.4).
 */

// Submit a channel request (Req 23.2/23.3).
router.post('/', authenticateToken, authorize, [
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

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Validate member permissions format, mirroring
    // POST /api/channels/custom's existing validation exactly, since a
    // Global_Manager's request is passed straight through to
    // Channel.createCustomChannel with the same shape.
    for (const memberPerm of memberPermissions) {
      if (!memberPerm.userId || !['read', 'write', 'read_write'].includes(memberPerm.permission)) {
        return res.status(400).json({ error: 'Invalid member permission format' });
      }
    }

    // req.user.userId is the local users.id (see server/middleware/auth.js),
    // which is what ChannelRequestService.requestChannel records as
    // requested_by on a pending channel_requests row, and what it uses to
    // resolve Global_Manager status for the immediate-creation branch.
    const result = await ChannelRequestService.requestChannel(teamId, customSuffix, memberPermissions, req.user.userId);

    // Global_Manager path returns a `channels` row (immediate creation,
    // Req 23.3); the non-Global_Manager path returns a pending
    // `channel_requests` row (Req 23.2) -- distinguishable by the
    // presence of a `status` field ('pending') that a `channels` row
    // never has. Respond with a distinct status code and body key for
    // each case so callers can tell which happened.
    if (result.status === 'pending') {
      return res.status(202).json({ channelRequest: result });
    }
    return res.status(201).json({ channel: result });
  } catch (error) {
    if (error instanceof Channel.ChannelLimitError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to submit channel request');
    res.status(500).json({ error: 'Failed to submit channel request' });
  }
});

// List pending channel requests, scoped to what the caller is allowed to
// see: a Global_Manager sees every pending request; a team admin sees
// only pending requests for team(s) they administer. Mirrors
// GET /api/requests/pending's existing shape exactly.
router.get('/pending', authenticateToken, authorize, async (req, res) => {
  try {
    let result;

    if (req.user.is_global_manager) {
      result = await pool.query(`
        SELECT cr.*, t.name as team_name
        FROM channel_requests cr
        LEFT JOIN teams t ON cr.team_id = t.id
        WHERE cr.status = 'pending'
        ORDER BY cr.created_at ASC
      `);
    } else {
      // req.user.userId is the local users.id -- team_memberships.user_id
      // is a foreign key to that column, NOT the Authentik id
      // (req.user.id); see server/middleware/auth.js and authorize.js's
      // repeated comments on this exact distinction.
      const userTeams = await User.getTeamMemberships(req.user.userId);
      const adminTeamIds = userTeams.filter((t) => t.role === 'admin').map((t) => t.id);

      if (adminTeamIds.length === 0) {
        return res.json({ channelRequests: [] });
      }

      const placeholders = adminTeamIds.map((_, i) => `$${i + 1}`).join(',');
      result = await pool.query(`
        SELECT cr.*, t.name as team_name
        FROM channel_requests cr
        LEFT JOIN teams t ON cr.team_id = t.id
        WHERE cr.team_id IN (${placeholders}) AND cr.status = 'pending'
        ORDER BY cr.created_at ASC
      `, adminTeamIds);
    }

    res.json({ channelRequests: result.rows });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch pending channel requests');
    res.status(500).json({ error: 'Failed to fetch pending channel requests' });
  }
});

// Approve a pending channel request (Req 23.4-23.6).
router.post('/:requestId/approve', authenticateToken, authorize, async (req, res) => {
  try {
    const { requestId } = req.params;

    // req.user.userId is the local users.id, recorded as processed_by on
    // the approved channel_requests row.
    const channel = await ChannelRequestService.approveChannelRequest(requestId, req.user.userId);
    res.json({ channel });
  } catch (error) {
    if (error instanceof ChannelRequestService.ChannelRequestAlreadyProcessedError) {
      return res.status(400).json({ error: error.message });
    }
    if (error instanceof Channel.ChannelLimitError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to approve channel request');
    res.status(500).json({ error: 'Failed to approve channel request' });
  }
});

// Deny a pending channel request (Req 23.7-23.8).
router.post('/:requestId/deny', authenticateToken, authorize, [
  body('denialReason').trim().isLength({ min: 1 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { requestId } = req.params;
    const { denialReason } = req.body;

    const channelRequest = await ChannelRequestService.denyChannelRequest(requestId, req.user.userId, denialReason);
    res.json({ channelRequest });
  } catch (error) {
    if (error instanceof ChannelRequestService.ChannelRequestAlreadyProcessedError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to deny channel request');
    res.status(500).json({ error: 'Failed to deny channel request' });
  }
});

module.exports = router;
