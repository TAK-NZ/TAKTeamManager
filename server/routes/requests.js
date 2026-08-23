const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const { textField } = require('../middleware/validators');
const { requestAccessLimiter, emailWindowLimiter } = require('../middleware/rateLimiters');
const { verifyCaptcha } = require('../middleware/captcha');
const Team = require('../models/Team');
const RequestApprovalService = require('../services/RequestApprovalService');
const CallsignService = require('../services/CallsignService');
const { CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
const {
  StaleTransferRequestError,
  CrossOrganisationTransferError
} = require('../services/TeamTransferService');
const pool = require('../config/database');
const router = express.Router();

const requestService = new RequestApprovalService();

// Shared SELECT + JOIN list for `GET /api/requests/pending`. Both the
// Global_Manager and non-Global_Manager branches return the same row shape
// and differ only in their WHERE clause, so the projection lives in one
// place -- duplicating the join-derived `team_change` fields into two
// queries is how the two branches drift.
//
// Requirement 4.3: a `team_change` row needs the Transferred_User's name and
// email (`tu`, joined on `existing_user_id`), the Initiating_Admin's name
// (`iu`, joined on `initiated_by`), and the Source_Team (`st`, joined on
// `current_team_id`). All three are LEFT JOINs: the columns are nullable and
// are always NULL for `new_account`/`role_change`/`name_change` rows, which
// must keep flowing through unchanged.
const PENDING_REQUESTS_SELECT = `
  SELECT ar.*,
         t.name as team_name,
         st.name as source_team_name,
         tu.first_name as transferred_user_first_name,
         tu.last_name as transferred_user_last_name,
         tu.email as transferred_user_email,
         iu.first_name as initiated_by_first_name,
         iu.last_name as initiated_by_last_name
  FROM access_requests ar
  LEFT JOIN teams t ON ar.target_team_id = t.id
  LEFT JOIN teams st ON ar.current_team_id = st.id
  LEFT JOIN users tu ON ar.existing_user_id = tu.id
  LEFT JOIN users iu ON ar.initiated_by = iu.id
`;

/**
 * Shared enrichment for `GET /api/requests/pending` rows.
 *
 * Extracted from the two near-identical blocks that previously sat in the
 * Global_Manager and non-Global_Manager branches. Both branches need the
 * same derived fields, so they now share one implementation.
 *
 * Resolves the hierarchy path for the union of the distinct destination
 * (`target_team_id`) and source (`current_team_id`) team ids in a single
 * pass, since `Team.getAncestorChain` supplies both the path segments and
 * the Organisation's `callsign_name_format`. The union is what Requirement
 * 4.3 needs: a `team_change` row carries a Source_Team as well as a
 * Destination_Team, and both are rendered as paths. `team_path` keeps its
 * existing name and meaning (the destination); `source_team_path` is new and
 * is `''` for every row without a `current_team_id`.
 *
 * `effective_callsign_suffix` is unchanged: it is keyed off the destination
 * team's Organisation and is only meaningful for `new_account` rows, since a
 * `team_change` row's `requested_*`/`requester_*` name columns hold the
 * Initiating_Admin's values rather than the Transferred_User's.
 *
 * @param {Array<object>} rows Raw `access_requests` rows from PENDING_REQUESTS_SELECT.
 * @returns {Promise<Array<object>>} The enriched rows, in input order.
 */
async function enrichPendingRequests(rows) {
  const distinctTeamIds = [...new Set(
    rows
      .flatMap((row) => [row.target_team_id, row.current_team_id])
      .filter((id) => id !== null && id !== undefined)
  )];

  const teamPathByTeamId = new Map();
  const callsignNameFormatByTeamId = new Map();
  await Promise.all(distinctTeamIds.map(async (teamId) => {
    const ancestorChain = await Team.getAncestorChain(teamId);
    const organisation = ancestorChain[0];
    callsignNameFormatByTeamId.set(teamId, organisation?.callsign_name_format);
    const path = ancestorChain.map((t, i) => {
      if (i === ancestorChain.length - 1) return t.name;
      return t.callsign_prefix || t.name;
    }).join(' > ');
    teamPathByTeamId.set(teamId, path);
  }));

  return rows.map((row) => {
    const base = {
      ...row,
      team_path: teamPathByTeamId.get(row.target_team_id) || row.team_name || '',
      source_team_path: teamPathByTeamId.get(row.current_team_id) || row.source_team_name || ''
    };

    if (row.callsign_suffix) {
      return { ...base, effective_callsign_suffix: row.callsign_suffix };
    }

    const firstName = row.requested_first_name || row.requester_first_name;
    const lastName = row.requested_last_name || row.requester_last_name;
    const callsignNameFormat = callsignNameFormatByTeamId.get(row.target_team_id);

    return {
      ...base,
      effective_callsign_suffix: CallsignService.computeDefaultCallsignSuffix(firstName, lastName, callsignNameFormat) || ''
    };
  });
}

/**
 * The Team whose Team_Admins may see one pending `access_requests` row.
 *
 * Requirement 4.2: the gating column varies by request type. A `team_change`
 * row records its Approval_Team explicitly on `approval_team_id` -- the side
 * of the transfer the Initiating_Admin is NOT an admin of -- so gating it on
 * `target_team_id` would show it to the initiating side and hide it from the
 * side that has to decide. Every other request type keeps its existing
 * gating on the Team the request is aimed at.
 *
 * Returns `null` when the row names no gating Team at all (a `team_change`
 * row with a NULL `approval_team_id`, or any row with a NULL
 * `target_team_id`), which the filter below treats as invisible: a row whose
 * approver cannot be identified fails closed rather than open.
 *
 * @param {object} row An `access_requests` row.
 * @returns {number|null} The gating team id, or `null` when there is none.
 */
function pendingRequestGatingTeamId(row) {
  const teamId = row.request_type === 'team_change'
    ? row.approval_team_id
    : row.target_team_id;
  return teamId === null || teamId === undefined ? null : teamId;
}

/**
 * Restricts candidate pending rows to those `userId` is a Team_Admin of, for
 * a caller who is not a Global_Manager.
 *
 * Requirement 4.4: admin status is decided by `Team.isAdmin`, which walks the
 * gating Team's Ancestor_Chain, so a Team_Admin of a Team *above* the gating
 * Team sees the row. That is what the previous implementation could not do:
 * it intersected the row's `target_team_id` with the caller's own direct
 * `role === 'admin'` membership rows, which sees only the exact Teams the
 * caller holds an admin row on.
 *
 * `Team.isAdmin` runs one recursive CTE per call, so results are memoised by
 * team id: the query count is bounded by the number of distinct gating Teams
 * among the candidate rows, not by the number of rows. The same batching
 * instinct as `enrichPendingRequests`'s pass over distinct team ids.
 *
 * @param {Array<object>} rows Candidate `access_requests` rows.
 * @param {number} userId The caller's local `users.id`.
 * @returns {Promise<Array<object>>} The visible subset, in input order.
 */
async function filterPendingRequestsVisibleTo(rows, userId) {
  const distinctGatingTeamIds = [...new Set(
    rows.map(pendingRequestGatingTeamId).filter((id) => id !== null)
  )];

  const isAdminByTeamId = new Map();
  await Promise.all(distinctGatingTeamIds.map(async (teamId) => {
    isAdminByTeamId.set(teamId, await Team.isAdmin(teamId, userId));
  }));

  return rows.filter((row) => isAdminByTeamId.get(pendingRequestGatingTeamId(row)) === true);
}

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
    // Both branches read the same candidate set -- every verified pending
    // row (Requirements 4.1, 4.2). The non-Global_Manager branch can no
    // longer narrow in SQL: the gating column varies per row (see
    // `pendingRequestGatingTeamId`) and admin status is an Ancestor_Chain
    // walk rather than an id intersection, so a single
    // `target_team_id IN (...)` predicate cannot express it. Pending volume
    // is small and `idx_access_requests_status_new` covers this predicate.
    const result = await pool.query(`
      ${PENDING_REQUESTS_SELECT}
      WHERE ar.status = 'pending'
        AND ar.email_verified = true
      ORDER BY ar.created_at ASC
    `);

    // A Global_Manager keeps the whole set (Requirement 4.1); everyone else
    // has it filtered here, before the response body is built, so a row the
    // caller may not see never reaches enrichment let alone the response.
    //
    // req.user.userId is the local users.id -- team_memberships.user_id is a
    // foreign key to that column, NOT the Authentik id (req.user.id).
    const visibleRows = req.user.is_global_manager
      ? result.rows
      : await filterPendingRequestsVisibleTo(result.rows, req.user.userId);

    const requests = await enrichPendingRequests(visibleRows);

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
    
    // Fetch requester email before approve (for audit log — row may be modified/consumed)
    const reqRow = await pool.query('SELECT requester_email FROM access_requests WHERE id = $1', [requestId]);
    const requesterEmail = reqRow.rows[0]?.requester_email || '';

    // req.user.userId is the local users.id -- access_requests.processed_by
    // is a foreign key to that column, NOT the Authentik id (req.user.id).
    //
    // Requirement 11.6: the Organisation boundary is re-evaluated at
    // execution time against the APPROVING user, so the approver's
    // Global_Manager status has to travel into the transaction. A
    // Team_Admin of the Approval_Team is not exempt.
    await requestService.approveRequest(
      requestId,
      req.user.userId,
      additionalDetails,
      callsignSuffix,
      !!req.user.is_global_manager
    );

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'request.approve', 'access_request', parseInt(requestId, 10), JSON.stringify({ requesterEmail })]
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
    // Requirement 11.1: the Transferred_User moved between the
    // Transfer_Request's creation and this approval, so the transaction
    // rolled back and the row is still `pending`. 409 rather than 400 --
    // the submitted payload was fine, the world changed underneath it.
    if (error instanceof StaleTransferRequestError) {
      return res.status(409).json({
        error: "The user's team changed since the request was created, so this transfer was not applied"
      });
    }
    // Requirement 11.6: a Team was reparented while the Transfer_Request
    // sat pending, so the two sides now belong to different Organisations
    // and the approving user is not a Global_Manager. Same 409 reasoning;
    // the immediate path in `server/routes/users.js` maps this same error
    // to 400 because there it is a caller mistake at request time.
    if (error instanceof CrossOrganisationTransferError) {
      return res.status(409).json({
        error: `The source and destination teams are now in different organisations (${error.sourceOrganisationId} and ${error.destinationOrganisationId}), so this transfer was not applied`
      });
    }
    getLogger().error({ err: error }, 'Approval failed');
    res.status(500).json({ error: 'Failed to approve request' });
  }
});

// Deny request
//
// Requirements 12.5 and 12.6: the reason must be present and at most 1000
// characters. The previous validator enforced the non-empty minimum only
// and accepted a reason of unbounded length, which `access_requests
// .denial_reason` (a `TEXT` column) would have stored in full.
router.post('/:requestId/deny', authenticateToken, authorize, [
  body('denialReason').trim().isLength({ min: 1, max: 1000 })
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
      const denyReqRow = await pool.query('SELECT requester_email FROM access_requests WHERE id = $1', [requestId]);
      const denyRequesterEmail = denyReqRow.rows[0]?.requester_email || '';
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'request.deny', 'access_request', parseInt(requestId, 10), JSON.stringify({ requesterEmail: denyRequesterEmail, reason: denialReason })]
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