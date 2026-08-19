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
const CallsignService = require('../services/CallsignService');
const { CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
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
  textField(500)('reason').isLength({ min: 10 }),
  // Requirement 11.9/11.10: `callsignSuffix` is an optional free-text field
  // (same as firstName/lastName/reason) submitted by an unauthenticated
  // caller, so it runs through the same `textField` chain. It is truly
  // OPTIONAL at the express-validator level -- for a Team whose
  // Organisation's `callsign_name_format` is `user_defined` it is
  // conditionally REQUIRED, but that depends on an async DB lookup
  // (Team.getAncestorChain) that can't be expressed as a synchronous
  // validator rule, so that check is done by hand in the handler below,
  // after the joinability check. `varchar(255)` matches
  // `access_requests.callsign_suffix`'s column width.
  textField(255)('callsignSuffix').optional()
], emailWindowLimiter, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, firstName, lastName, teamId, reason, callsignSuffix } = req.body;
  
  try {
    // Verify team exists and is joinable.
    //
    // Requirement 7.4: this must reject a Team excluded by
    // `Team.getJoinableTeams`'s own definition of "joinable" (Requirement
    // 7.1/7.2 -- `can_join`/`public` on its own row AND no `private`
    // ancestor anywhere in its Ancestor_Chain). A plain `Team.findById`
    // lookup only sees the team's own row and would incorrectly accept a
    // Team that is `can_join`/`public` on its own row but has a `private`
    // ancestor several levels up.
    //
    // Reusing `getJoinableTeams()` directly (rather than duplicating its
    // "has a private ancestor" query here) guarantees this check can never
    // drift from that method's own definition of joinable. Fetching the
    // whole joinable-teams list just to check one id is a deliberate
    // tradeoff: this is a public-facing, low-traffic form submission, not
    // a hot path, so the extra cost is negligible next to the risk of two
    // divergent definitions of "joinable".
    const joinableTeams = await Team.getJoinableTeams();
    const team = joinableTeams.find(t => t.id === Number(teamId));
    if (!team) {
      return res.status(400).json({ error: 'Team is not available for joining' });
    }

    // Requirement 11.9/11.10: `callsignSuffix` is only REQUIRED when the
    // target Team's Organisation's `callsign_name_format` is
    // `user_defined` -- looked up now (rather than before the joinability
    // check above) since there's no need to resolve this for a Team
    // that's about to be rejected as non-joinable anyway.
    // `Team.getAncestorChain` returns its rows root-first, so index 0 is
    // always the Organisation regardless of the target Team's own depth.
    const ancestorChain = await Team.getAncestorChain(teamId);
    const organisation = ancestorChain[0];
    if (organisation?.callsign_name_format === 'user_defined' && !callsignSuffix) {
      return res.status(400).json({ error: 'callsignSuffix is required for this team' });
    }

    const requestData = {
      request_type: 'new_account',
      requester_email: email,
      requester_first_name: firstName,
      requester_last_name: lastName,
      target_team_id: teamId,
      justification: reason,
      callsign_suffix: callsignSuffix || null
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
    // Global Admin sees ALL pending requests across all orgs/teams
    if (req.user.is_global_manager) {
      const result = await pool.query(`
        SELECT ar.*, t.name as team_name
        FROM access_requests ar
        LEFT JOIN teams t ON ar.target_team_id = t.id
        WHERE ar.status = 'pending' 
          AND ar.email_verified = true
        ORDER BY ar.created_at ASC
      `);

      // Resolve full hierarchy path AND callsign_name_format for each
      // distinct target team in a single pass (both need the ancestor chain).
      const distinctTargetTeamIds = [...new Set(
        result.rows
          .map((row) => row.target_team_id)
          .filter((id) => id !== null && id !== undefined)
      )];

      const teamPathByTeamId = new Map();
      const callsignNameFormatByTargetTeamId = new Map();
      await Promise.all(distinctTargetTeamIds.map(async (targetTeamId) => {
        const ancestorChain = await Team.getAncestorChain(targetTeamId);
        const organisation = ancestorChain[0];
        callsignNameFormatByTargetTeamId.set(targetTeamId, organisation?.callsign_name_format);
        const path = ancestorChain.map((t, i) => {
          if (i === ancestorChain.length - 1) return t.name;
          return t.callsign_prefix || t.name;
        }).join(' > ');
        teamPathByTeamId.set(targetTeamId, path);
      }));

      const requests = result.rows.map((row) => {
        const base = {
          ...row,
          team_path: teamPathByTeamId.get(row.target_team_id) || row.team_name || ''
        };

        if (row.callsign_suffix) {
          return { ...base, effective_callsign_suffix: row.callsign_suffix };
        }

        const firstName = row.requested_first_name || row.requester_first_name;
        const lastName = row.requested_last_name || row.requester_last_name;
        const callsignNameFormat = callsignNameFormatByTargetTeamId.get(row.target_team_id);

        return {
          ...base,
          effective_callsign_suffix: CallsignService.computeDefaultCallsignSuffix(firstName, lastName, callsignNameFormat) || ''
        };
      });

      return res.json({ requests });
    }

    // req.user.userId is the local users.id -- team_memberships.user_id
    // is a foreign key to that column, NOT the Authentik id (req.user.id).
    const userTeams = await User.getTeamMemberships(req.user.userId);
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

    // Resolve full hierarchy path AND callsign_name_format for each
    // distinct target team in a single pass (both need the ancestor chain).
    const distinctTargetTeamIds = [...new Set(
      result.rows
        .map((row) => row.target_team_id)
        .filter((id) => id !== null && id !== undefined)
    )];

    const teamPathByTeamId = new Map();
    const callsignNameFormatByTargetTeamId = new Map();
    await Promise.all(distinctTargetTeamIds.map(async (targetTeamId) => {
      const ancestorChain = await Team.getAncestorChain(targetTeamId);
      const organisation = ancestorChain[0];
      callsignNameFormatByTargetTeamId.set(targetTeamId, organisation?.callsign_name_format);
      const path = ancestorChain.map((t, i) => {
        if (i === ancestorChain.length - 1) return t.name;
        return t.callsign_prefix || t.name;
      }).join(' > ');
      teamPathByTeamId.set(targetTeamId, path);
    }));

    const requests = result.rows.map((row) => {
      const base = {
        ...row,
        team_path: teamPathByTeamId.get(row.target_team_id) || row.team_name || ''
      };

      if (row.callsign_suffix) {
        return { ...base, effective_callsign_suffix: row.callsign_suffix };
      }

      const firstName = row.requested_first_name || row.requester_first_name;
      const lastName = row.requested_last_name || row.requester_last_name;
      const callsignNameFormat = callsignNameFormatByTargetTeamId.get(row.target_team_id);

      return {
        ...base,
        effective_callsign_suffix: CallsignService.computeDefaultCallsignSuffix(firstName, lastName, callsignNameFormat)
      };
    });

    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Approve request
//
// Requirement 11.12 (task 24.3): `callsignSuffix` is an optional reviewer
// override, mirroring `additionalDetails`'s existing plain
// `.optional().trim()` chain (both are optional free-text fields on this
// same route) rather than the `textField` factory, for consistency with
// this route's own existing convention.
router.post('/:requestId/approve', authenticateToken, authorize, [
  body('additionalDetails').optional().trim(),
  body('callsignSuffix').optional().trim(),
  body('firstName').optional().trim().isLength({ min: 1, max: 150 }),
  body('lastName').optional().trim().isLength({ min: 1, max: 150 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { requestId } = req.params;
    const { additionalDetails, callsignSuffix, firstName, lastName } = req.body;

    // If admin edited the name, store it on the request so approveRequest
    // uses the admin-corrected values (it reads requested_first_name/
    // requested_last_name from the access_request row).
    if (firstName || lastName) {
      const updates = [];
      const params = [];
      if (firstName) {
        params.push(firstName);
        updates.push(`requested_first_name = $${params.length}`);
      }
      if (lastName) {
        params.push(lastName);
        updates.push(`requested_last_name = $${params.length}`);
      }
      params.push(requestId);
      await pool.query(
        `UPDATE access_requests SET ${updates.join(', ')} WHERE id = $${params.length}`,
        params
      );
    }
    
    // req.user.userId is the local users.id -- access_requests.processed_by
    // is a foreign key to that column, NOT the Authentik id (req.user.id).
    await requestService.approveRequest(requestId, req.user.userId, additionalDetails, callsignSuffix);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'request.approve', 'access_request', parseInt(requestId, 10), null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ message: 'Request approved successfully' });
  } catch (error) {
    // Requirement 11.16/11.17 (task 24.3): a `CallsignSuffixConflictError`
    // means nothing was committed -- surface the conflicting value to the
    // reviewer with a 400 so the Client can prompt for a different value,
    // rather than the generic 500 used for every other approval failure.
    if (error instanceof CallsignSuffixConflictError) {
      return res.status(400).json({ error: error.message });
    }
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
    
    // req.user.userId is the local users.id -- see comment on the approve
    // route above.
    await requestService.denyRequest(requestId, req.user.userId, denialReason);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'request.deny', 'access_request', parseInt(requestId, 10), JSON.stringify({ reason: denialReason })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ message: 'Request denied successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Denial failed');
    res.status(500).json({ error: 'Failed to deny request' });
  }
});

module.exports = router;