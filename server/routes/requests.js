const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const { textField } = require('../middleware/validators');
const { requestAccessLimiter, emailWindowLimiter } = require('../middleware/rateLimiters');
const { verifyCaptcha } = require('../middleware/captcha');
const User = require('../models/User');
const Team = require('../models/Team');
const RequestApprovalService = require('../services/RequestApprovalService');
const pool = require('../config/database');
const router = express.Router();

const requestService = new RequestApprovalService();

// Public route - request team access (unauthenticated)
//
// Requirement 5.7/5.8: `firstName`, `lastName`, and `reason` are free-text
// fields submitted by an unauthenticated caller, so they run through the
// shared `textField` chain (trim + HTML-escape + max length) instead of a
// hand-rolled `body(field).trim()...` chain, per the consistent-sanitization
// baseline. `email` (`.isEmail().normalizeEmail()`) and `teamId` (`.isInt()`)
// are typed/structured fields, not free text, so they are left as-is.
//
// `firstName`/`lastName` map to `access_requests.requester_first_name`/
// `requester_last_name`, which are `VARCHAR(255)` columns (see
// `database/migrations/*_baseline-schema.cjs`), so `textField(255)` is used
// as the stricter, schema-matched limit rather than the 1000-character
// default. The pre-existing `min: 1` (non-empty) constraint is preserved by
// chaining `.isLength({ min: 1 })` after `textField`'s `.isLength({ max })`.
//
// `reason` keeps its existing `min: 10, max: 500` constraint: `textField(500)`
// supplies the `max`, and `.isLength({ min: 10 })` is chained afterward to
// preserve the stricter minimum `textField` doesn't itself express.
//
// Requirement 7.1/7.2/7.3/7.4: middleware ordering on this route, cheapest
// to most expensive:
//   1. `requestAccessLimiter` (20 requests/IP/15min) runs first, since it
//      is the cheapest check and needs no request body at all.
//   2. `verifyCaptcha` (Requirement 7.3/7.4) runs next, before the
//      express-validator chain: a reCAPTCHA verify call is a moderately
//      expensive external HTTP request, and rejecting an obviously-bot
//      submission here means it never even gets useful field-level
//      validation-error feedback, and never consumes an email-window
//      increment for a bot-submitted (possibly spoofed/irrelevant) email
//      address. A missing/invalid CAPTCHA token is rejected with 400
//      before any `access_requests` row is inserted or email sent, since
//      none of the handler's body has run yet.
//   3. The express-validator chain runs next, reporting field-level
//      validation errors for well-formed (CAPTCHA-passed) submissions.
//   4. `emailWindowLimiter` (5 requests/submitted-email/60min) is mounted
//      AFTER the express-validator chain but BEFORE the handler, so an
//      invalid/malformed `email` never reaches the `email_rate_tracking`
//      DB check -- `emailWindowLimiter` itself re-checks
//      `validationResult(req)` and, if the chain already found errors,
//      defers to the handler's own `validationResult` check below rather
//      than duplicating that 400 here.
router.post('/team-access', requestAccessLimiter, verifyCaptcha, [
  body('email').isEmail().normalizeEmail(),
  textField(255)('firstName').isLength({ min: 1 }),
  textField(255)('lastName').isLength({ min: 1 }),
  body('teamId').isInt(),
  textField(500)('reason').isLength({ min: 10 })
], emailWindowLimiter, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, firstName, lastName, teamId, reason } = req.body;
  
  try {
    // Verify team exists and is joinable
    const team = await Team.findById(teamId);
    if (!team || !team.can_join || team.visibility !== 'public') {
      return res.status(400).json({ error: 'Team is not available for joining' });
    }

    const requestData = {
      request_type: 'new_account',
      requester_email: email,
      requester_first_name: firstName,
      requester_last_name: lastName,
      target_team_id: teamId,
      justification: reason
    };
    
    const result = await requestService.createAccessRequest(requestData);
    res.json({ 
      message: 'Access request submitted. Please check your email to verify your request.',
      requestId: result.requestId
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to submit request');
    res.status(500).json({ error: 'Failed to submit request' });
  }
});

// Get pending requests for team admin
router.get('/pending', authenticateToken, authorize, async (req, res) => {
  try {
    const userTeams = await User.getTeamMemberships(req.user.id);
    const adminTeams = userTeams.filter(t => t.role === 'admin');
    
    if (adminTeams.length === 0) {
      return res.json({ requests: [] });
    }

    const teamIds = adminTeams.map(t => t.id);
    const placeholders = teamIds.map((_, i) => `$${i + 1}`).join(',');
    
    const result = await pool.query(`
      SELECT ar.*, t.name as team_name
      FROM access_requests ar
      LEFT JOIN teams t ON ar.target_team_id = t.id
      WHERE ar.target_team_id IN (${placeholders}) 
        AND ar.status = 'pending' 
        AND ar.email_verified = true
      ORDER BY ar.created_at ASC
    `, teamIds);

    res.json({ requests: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Approve request
router.post('/:requestId/approve', authenticateToken, authorize, [
  body('additionalDetails').optional().trim()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { requestId } = req.params;
    const { additionalDetails } = req.body;
    
    await requestService.approveRequest(requestId, req.user.id, additionalDetails);
    res.json({ message: 'Request approved successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Approval failed');
    res.status(500).json({ error: 'Failed to approve request' });
  }
});

// Deny request
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
    
    await requestService.denyRequest(requestId, req.user.id, denialReason);
    res.json({ message: 'Request denied successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Denial failed');
    res.status(500).json({ error: 'Failed to deny request' });
  }
});

// Verify email token
//
// Requirement 7.1: this route receives only a `token` path param, not a
// submitted email address, so the per-email `emailWindowLimiter` (which
// needs `req.body.email`) does not apply here -- only the per-IP
// `requestAccessLimiter` is mounted, consistent with Requirement 7.2's
// framing of the per-email limit in terms of "a given email address"
// associated with the request, which this route does not carry.
router.get('/verify/:token', requestAccessLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const request = await requestService.verifyEmail(token);
    
    res.json({ 
      message: 'Email verified successfully. Your request has been forwarded to the team administrator.',
      requestId: request.id
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Verification failed');
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;