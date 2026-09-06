const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireTeamAdmin } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const { paginationParams } = require('../middleware/pagination');
const Team = require('../models/Team');
const User = require('../models/User');
const pool = require('../config/database');
const { isValidCallsignPrefix, isValidCallsignSuffix } = require('../utils/callsignValidation');
const { isValidCountryCode } = require('../utils/isoCountry');
const { TAK_ROLE_VALUES } = require('./settings');
const { checkCallsignSuffixUniqueness, CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
const TeamVisibilityService = require('../services/TeamVisibilityService');
const EventPublisher = require('../services/EventPublisher');
// Authentik scaling (Phase 3): when the reconciler is enabled, an
// Organisation tier-flag flip enqueues one region reconcile per active
// region channel of that tier (O(groups)) instead of
// resync_org_channel_tier_access fanning out one
// assign_user_to_global_channels per user (O(users)).
const { isBulkGroupReconcileEnabled } = require('../config/bulkGroupReconcile');
const { enqueueRegionTierReconciles } = require('../services/OwnedGroupReconcileEnqueuer');

const router = express.Router();

// Get joinable teams (public endpoint)
//
// Performance-hardening: previously unbounded -- an unauthenticated
// endpoint returning every public, joinable team with no LIMIT at all is
// a soft scaling/DoS surface as the joinable-team count grows. Applies
// the same shared `paginationParams` middleware every other list endpoint
// uses (default pageSize 50, max 200), and reports `total`/`page`/
// `pageSize` alongside the page of results so a client can page through
// the full set.
router.get('/joinable', paginationParams, async (req, res) => {
  try {
    const { page, pageSize, offset } = req.pagination;
    const [teams, total] = await Promise.all([
      Team.getJoinableTeams(pageSize, offset),
      Team.getJoinableTeamsCount()
    ]);
    res.json({ teams, pagination: { page, pageSize, total } });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch joinable teams');
    res.status(500).json({ error: 'Failed to fetch joinable teams' });
  }
});

// Get user's teams
//
// Requirement 11.4: the admin "all teams" branch (`Team.getAllTeams()`) is
// the potentially-large, unbounded list this task scopes pagination to;
// the regular-user branch (`Team.getUserTeams()`) is inherently bounded by
// how many teams one user belongs to, so it is left unpaginated and simply
// doesn't consume `req.pagination`. `paginationParams` still runs
// unconditionally ahead of the handler -- it's a cheap query-param
// validation step regardless of which branch ends up using it.
//
// Requirement 6.6 (task 14.3): an optional `?scope=organisation` query
// parameter is layered on top of the above, ADDITIVELY -- when present,
// it takes over the response entirely (every Visible_Branch Team within
// the caller's own Organisation, via `TeamVisibilityService.
// filterVisibleBranches`), regardless of `req.user.isAdmin`, and returns
// before either of the two existing branches runs. When ABSENT, the
// existing admin-paginated-all-teams vs. regular-user-own-teams-only
// behavior is completely unchanged.
router.get('/my-teams', authenticateToken, authorize, paginationParams, async (req, res) => {
  try {
    // Bugfix (re-parent authorization gap, client-side follow-up): every
    // branch below now also carries `can_manage` per row -- whether THIS
    // caller may act as an admin of THAT team, mirroring `GET /api/users`'
    // own `can_manage` field exactly (same `Team.getManagedTeamIds`
    // Set-membership pattern, same "Global_Manager manages everything, no
    // query needed" short-circuit). The Client's "Parent Team" dropdown
    // (`TeamFormDialog.jsx`) filters candidates to `can_manage` rows for a
    // non-Global_Manager, so the dropdown can no longer offer a
    // destination the caller has no admin rights on -- the actual
    // enforcement is server-side (`team:update`'s row-scoped resolver in
    // authorize.js), and this field only keeps the dropdown from
    // presenting an option that would 403 on submit.
    const managedTeamIds = req.user && req.user.is_global_manager
      ? null
      : await Team.getManagedTeamIds(req.user && req.user.userId);
    const withCanManage = (rows) => rows.map((team) => ({
      ...team,
      can_manage: managedTeamIds === null ? true : managedTeamIds.has(team.id)
    }));

    if (req.query.scope === 'organisation') {
      const orgTeams = await resolveOwnOrganisationTeams(req.user);
      const visibleTeams = await TeamVisibilityService.filterVisibleBranches(orgTeams, req.user);
      return res.json({ teams: withCanManage(visibleTeams) });
    }

    let teams;
    let pagination;
    if (req.user.isAdmin) {
      // Global admins see all teams, paginated.
      const { page, pageSize, offset } = req.pagination;
      const [pagedTeams, total] = await Promise.all([
        Team.getAllTeams(pageSize, offset),
        Team.getTeamCount()
      ]);
      teams = pagedTeams;
      pagination = { page, pageSize, total };
    } else {
      // Regular users see all teams within their organisation, filtered
      // by visibility (private teams hidden unless they're a member/admin).
      const orgTeams = await resolveOwnOrganisationTeams(req.user, true);
      teams = await TeamVisibilityService.filterVisibleBranches(orgTeams, req.user);
    }
    teams = withCanManage(teams);
    res.json(pagination ? { teams, pagination } : { teams });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch teams');
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// Requirement 6.6 (task 14.3): resolves the caller's OWN Organisation's
// full Team hierarchy (every Team belonging to the same Organisation as
// any of the caller's own team memberships, direct or inherited), for
// `?scope=organisation` to filter through `TeamVisibilityService.
// filterVisibleBranches`.
//
// Deliberately queries `team_memberships` directly (both direct AND
// inherited rows, i.e. no `inherited_from_team_id IS NULL` filter),
// rather than reusing `Team.getUserTeams` (which filters to direct
// membership only) -- Requirement 6.6's "any of the caller's own team
// memberships" is explicitly direct-or-inherited, matching the
// Org_Member glossary definition.
//
// A caller's own memberships are all necessarily within a single
// Organisation in practice (Requirement 6.2's Organisation-scoping), so
// resolving the Organisation of the FIRST membership found is a
// reasonable simplification -- this does not need to reconcile multiple
// memberships that happen to resolve to different Organisations.
//
// A Global_Manager may hold no team membership of their own at all
// (Requirement 6.4's visibility bypass does not require any membership),
// so "their own Organisation" is ill-defined for them. This deliberately
// takes the SIMPLER of the two possible interpretations documented in
// this task: `scope=organisation` means "MY organisation", so a caller
// with no resolvable Organisation of their own (Global_Manager or
// otherwise) gets an empty list here, rather than falling back to every
// Team across every Organisation.
async function resolveOwnOrganisationTeams(user, includeDetails = false) {
  const membershipResult = await pool.query(
    'SELECT team_id FROM team_memberships WHERE user_id = $1 LIMIT 1',
    [user.userId]
  );
  const membershipTeamId = membershipResult.rows[0]?.team_id;
  if (!membershipTeamId) {
    return [];
  }
  const ancestorChain = await Team.getAncestorChain(membershipTeamId);
  if (!ancestorChain || ancestorChain.length === 0) {
    return [];
  }
  const organisationId = ancestorChain[0].id;
  return Team.getOrganisationTeams(organisationId, includeDetails ? user.userId : null);
}

// Create team
router.post('/', authenticateToken, authorize, [
  body('name').trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('callsignPrefix').optional().trim().custom(value => isValidCallsignPrefix(value))
    .withMessage('callsignPrefix may only contain letters and digits, optionally split into segments with a single hyphen (e.g. AUS-FIRE)'),
  // Foreign_Partner Organisation country prefix: an optional ISO 3166-1
  // alpha-3 country code. Basic request-shape validation only (a known
  // alpha-3 code, or empty/absent) -- the Organisation-only rule and the
  // write-once immutability rule are enforced by `Team.create`/`Team.update`
  // and mapped to their specific 400 messages in this route's catch block,
  // mirroring how callsignLevelSelection/pseudonymousUsernames are handled.
  body('countryCode').optional({ nullable: true }).trim().custom(value => isValidCountryCode(value))
    .withMessage('countryCode must be a valid ISO 3166-1 alpha-3 country code (e.g. AUS, FJI)'),
  body('color').optional().trim(),
  body('visibility').optional().isIn(['public', 'private']),
  body('canJoin').optional().isBoolean(),
  // .optional({ nullable: true }) (not plain .optional()) since the client
  // always sends parentTeamId: null for a top-level team -- plain
  // .optional() only skips validation when the field is ABSENT, not when
  // it's present-but-null, so .isInt() was running against null and
  // failing every top-level team creation with a 400. Same fix already
  // applied elsewhere for this exact bug class (see deploymentChannels.js)
  // and the PUT /:teamId route just below, which already handles this
  // correctly via a custom validator.
  body('parentTeamId').optional({ nullable: true }).isInt(),
  body('callsignNameFormat').optional().isIn(['full_name', 'first_initial_last', 'first_last_initial', 'first_initial_dot_last', 'user_defined']),
  // Requirement 5.1/5.2 (task 8.2): basic request-shape validation only
  // (an array of integers) -- the actual 1..MAX_TEAM_DEPTH range check and
  // the Sub_Team-rejection rule (Requirement 5.6) are enforced by
  // `Team.create` itself (task 8.1) and mapped to their specific 400
  // messages in this route's catch block below, not duplicated here.
  body('callsignLevelSelection').optional().isArray()
    .custom(value => value === undefined || (Array.isArray(value) && value.every(v => Number.isInteger(v))))
    .withMessage('callsignLevelSelection must be an array of integers'),
  // takserver-enrollment Requirement 6.1/6.2 (task 5.4): basic
  // request-shape validation only -- the Organisation-only/typed
  // Sub_Team-rejection rule is enforced by `Team.create` itself (task
  // 5.4) and mapped to its specific 400 message in this route's catch
  // block below, mirroring callsignLevelSelection's own pattern exactly.
  body('pseudonymousUsernames').optional().isBoolean(),
  // Callsign Team-segment separator toggle: basic request-shape
  // validation only -- the Organisation-only rejection rule is enforced
  // by `Team.create` itself and mapped to its specific 400 message in
  // this route's catch block below, mirroring pseudonymousUsernames'
  // own pattern exactly.
  body('callsignTeamHyphenated').optional().isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    let { name, description, callsignPrefix, color, visibility, canJoin, parentTeamId, callsignNameFormat, callsignLevelSelection, pseudonymousUsernames, countryCode, callsignTeamHyphenated } = req.body;

    // Authorization (root team requires Global_Manager, sub-team requires
    // Global_Manager or parent-team admin) is enforced centrally by
    // authorize.js via the 'POST /api/teams': ['team:create:root_or_sub']
    // Permission_Registry entry.

    // takserver-enrollment Requirement 2.1/2.4: an Organisation (no
    // parentTeamId) requires a non-empty callsign_prefix -- a Managed_
    // Identifier can never be minted for one without it. Rejected here,
    // in the handler, rather than added as a plain express-validator
    // .notEmpty() rule, because "required" is conditional on
    // parentTeamId being absent, which isValidCallsignPrefix's existing
    // .optional() chain has no visibility into. A Sub_Team's prefix
    // stays optional exactly as it is today (Criterion 2.3). A
    // whitespace-only value is treated as empty -- [A-Za-z0-9]* matches
    // the empty string, so the character-class check alone would accept
    // '   '.
    if (!parentTeamId) {
      const trimmedCallsignPrefix = typeof callsignPrefix === 'string' ? callsignPrefix.trim() : callsignPrefix;
      if (!trimmedCallsignPrefix) {
        return res.status(400).json({ error: 'callsignPrefix is required for an Organisation' });
      }
    }

    // Requirement 3.2 (task 6.1): the actual inherited color/
    // callsign_name_format VALUES are now resolved by `Team.create` itself
    // (from the Sub_Team's Organisation, not necessarily its immediate
    // parent), so this route no longer sets `color` from `parentTeam.color`
    // here -- doing so would be redundant with, and could conflict with,
    // `Team.create`'s own inheritance logic. This lookup is kept only for
    // its existing "Parent team not found" 400 validation.
    if (parentTeamId) {
      getLogger().debug({ parentTeamId, actorId: req.user.userId }, 'Creating sub-team for parent');
      const parentTeam = await Team.findById(parentTeamId);
      if (!parentTeam) {
        return res.status(400).json({ error: 'Parent team not found' });
      }
    }

    getLogger().debug({
      name,
      description,
      callsign_prefix: callsignPrefix,
      color,
      visibility: visibility || 'private',
      can_join: canJoin || false,
      parent_team_id: parentTeamId
    }, 'Creating team with data');
    
    const team = await Team.create({
      name,
      description,
      callsign_prefix: callsignPrefix,
      color,
      visibility: visibility || 'private',
      can_join: canJoin || false,
      parent_team_id: parentTeamId,
      created_by: null, // Skip created_by for now since user ID is string
      callsign_name_format: !parentTeamId ? callsignNameFormat : null,
      callsign_level_selection: callsignLevelSelection,
      pseudonymous_usernames: pseudonymousUsernames,
      // Foreign_Partner country prefix: Organisation-only, mirroring
      // callsign_name_format's own `!parentTeamId ? ... : null` wiring.
      // Team.create additionally validates/normalises it and rejects a
      // country_code on a Sub_Team, but nulling it here keeps this route
      // consistent with how it already treats Organisation-only fields.
      country_code: !parentTeamId ? countryCode : null,
      // Callsign Team-segment separator toggle: Organisation-only,
      // mirroring country_code's own `!parentTeamId ? ... : null` wiring.
      callsign_team_hyphenated: !parentTeamId ? callsignTeamHyphenated : null
    });

    // Skip adding creator as admin for now since user ID is string

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.create', 'team', team.id, JSON.stringify({ name: team.name, parentTeamId: team.parent_team_id })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(201).json({ team });
  } catch (error) {
    // Requirement 2.3 (task 5.2): Team.create throws this BEFORE any
    // INSERT is attempted when the requested Sub_Team would sit deeper
    // than MAX_TEAM_DEPTH, so no team is created in this branch.
    if (error instanceof Team.TeamDepthExceededError) {
      return res.status(400).json({ error: error.message });
    }
    // Requirement 5.2 (task 8.2): Team.create throws this BEFORE any
    // INSERT is attempted when a supplied callsignLevelSelection value is
    // out of the 1..MAX_TEAM_DEPTH range.
    if (error instanceof Team.CallsignLevelSelectionRangeError) {
      return res.status(400).json({ error: error.message });
    }
    // Requirement 5.6 (task 8.2): Team.create throws this BEFORE any
    // INSERT is attempted when callsignLevelSelection is supplied on a
    // Sub_Team creation request (parentTeamId present).
    if (error instanceof Team.CallsignLevelSelectionSubTeamError) {
      return res.status(400).json({ error: error.message });
    }
    // takserver-enrollment Requirement 6.2 (task 5.4): Team.create
    // throws this BEFORE any INSERT is attempted when
    // pseudonymousUsernames is supplied on a Sub_Team creation request.
    if (error instanceof Team.PseudonymousUsernamePolicySubTeamError) {
      return res.status(400).json({ error: error.message });
    }
    // Bugfix (callsign-handling): Team.create now throws this (rather
    // than silently falling back to creating the team with NO prefix at
    // all) when the requested callsignPrefix collides with
    // idx_teams_callsign_prefix's UNIQUE constraint -- mirroring
    // PUT /:teamId's identical handling of the same error from
    // Team.update.
    if (error instanceof Team.CallsignPrefixConflictError) {
      return res.status(400).json({ error: error.message });
    }
    // Org-wide-team-name-uniqueness: Team.create throws this BEFORE any
    // INSERT when the new Sub_Team's name is already used by another team
    // in the same Organisation (across the whole subtree, not just the
    // same immediate parent). A client-correctable 400, mirroring
    // PUT /:teamId's identical handling.
    if (error instanceof Team.TeamNameConflictError) {
      return res.status(400).json({ error: error.message });
    }
    // Foreign_Partner country prefix: Team.create throws these BEFORE any
    // INSERT -- an unknown ISO alpha-3 code (CountryCodeInvalidError) or a
    // country_code supplied on a Sub_Team (CountryCodeSubTeamError). Both
    // are client-correctable 400s, mirroring the callsign guards above.
    if (
      error instanceof Team.CountryCodeInvalidError ||
      error instanceof Team.CountryCodeSubTeamError
    ) {
      return res.status(400).json({ error: error.message });
    }
    // Callsign Team-segment separator toggle: Team.create throws this
    // BEFORE any INSERT when callsignTeamHyphenated is supplied on a
    // Sub_Team creation request, mirroring pseudonymousUsernames'/
    // countryCode's own Sub_Team-rejection handling above.
    if (error instanceof Team.ChannelTierAccessSubTeamError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Team creation error');
    res.status(500).json({ error: 'Failed to create team', details: error.message });
  }
});

// Update team
router.put('/:teamId', authenticateToken, authorize, [
  body('name').optional().trim().isLength({ min: 1, max: 255 }),
  body('description').optional().trim(),
  body('callsignPrefix').optional().trim().custom(value => isValidCallsignPrefix(value))
    .withMessage('callsignPrefix may only contain letters and digits, optionally split into segments with a single hyphen (e.g. AUS-FIRE)'),
  // Foreign_Partner country prefix: same request-shape validation as the
  // POST route. Whether a supplied value is actually accepted (only as a
  // no-op resubmission on an existing Organisation -- it is write-once) is
  // enforced by `Team.update` and mapped to its 400 in this route's catch
  // block, mirroring callsignPrefix's own immutability handling.
  body('countryCode').optional({ nullable: true }).trim().custom(value => isValidCountryCode(value))
    .withMessage('countryCode must be a valid ISO 3166-1 alpha-3 country code (e.g. AUS, FJI)'),
  body('color').optional().trim(),
  body('visibility').optional().isIn(['public', 'private']),
  body('canJoin').optional().isBoolean(),
  body('parentTeamId').optional().custom(value => value === null || Number.isInteger(Number(value))),
  body('callsignNameFormat').optional().isIn(['full_name', 'first_initial_last', 'first_last_initial', 'first_initial_dot_last', 'user_defined']),
  // Requirement 5.1/5.2 (task 8.2): basic request-shape validation only
  // (an array of integers) -- the actual 1..MAX_TEAM_DEPTH range check and
  // the Sub_Team-rejection rule (Requirement 5.6) are enforced by
  // `Team.update` itself (task 8.1) and mapped to their specific 400
  // messages in this route's catch block below, not duplicated here.
  body('callsignLevelSelection').optional().isArray()
    .custom(value => value === undefined || (Array.isArray(value) && value.every(v => Number.isInteger(v))))
    .withMessage('callsignLevelSelection must be an array of integers'),
  // takserver-enrollment Requirement 7.2/7.4 (task 5.4): basic
  // request-shape validation only -- whether a changed value is
  // actually accepted (never, on an existing Organisation) is enforced
  // by `Team.update` itself and mapped to its specific 400 message in
  // this route's catch block below.
  body('pseudonymousUsernames').optional().isBoolean(),
  // Callsign Team-segment separator toggle: basic request-shape
  // validation only -- the Organisation-only rejection rule is enforced
  // by `Team.update` itself and mapped to its specific 400 message in
  // this route's catch block below. Unlike pseudonymousUsernames, a
  // changed value on an existing Organisation is simply APPLIED, no
  // immutability guard.
  body('callsignTeamHyphenated').optional().isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    // Authorization (global admin or team admin) is enforced centrally by
    // authorize.js via the 'PUT /api/teams/:teamId': ['team:update']
    // Permission_Registry entry.

    const team = await Team.findById(req.params.teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const { name, description, callsignPrefix, color, visibility, canJoin, parentTeamId, callsignNameFormat, callsignLevelSelection, pseudonymousUsernames, countryCode, callsignTeamHyphenated } = req.body;

    // takserver-enrollment Requirement 2.2/2.4: an Organisation's
    // callsign_prefix must remain non-empty across an edit -- checked
    // against `team.parent_team_id` (the CURRENT, pre-update row, same
    // lookup `Team.update` itself relies on for its own Sub_Team-only
    // rules), so this only applies when `:teamId` is an Organisation
    // today. `callsignPrefix === undefined` means "not supplied on this
    // request" and is accepted (Team.update's COALESCE preserves the
    // existing value); an explicit empty or whitespace-only value is
    // what Criterion 2.2 rejects, since it would clear a still-mandatory
    // field. A Sub_Team's prefix stays optional exactly as it is today
    // (Criterion 2.3) -- no check runs for one.
    if (team.parent_team_id === null && callsignPrefix !== undefined) {
      const trimmedCallsignPrefix = typeof callsignPrefix === 'string' ? callsignPrefix.trim() : callsignPrefix;
      if (!trimmedCallsignPrefix) {
        return res.status(400).json({ error: 'callsignPrefix is required for an Organisation and cannot be cleared' });
      }
    }

    // Requirement 3.3 (task 6.1): `color`/`callsignNameFormat` are passed
    // straight through to `Team.update`, which silently ignores them
    // (preserving the team's existing stored values, never rejecting the
    // request) when `teamId` is a Sub_Team. An Organisation's own
    // `color`/`callsignNameFormat` remain freely updatable here.
    //
    // Bugfix (callsign-handling): `callsign_prefix` is now also passed
    // through. `Team.update` itself enforces the asymmetric rule: freely
    // editable on a Sub_Team (there was previously NO supported way to
    // correct a Sub_Team's prefix after creation at all), but a typed
    // rejection (`OrganisationCallsignPrefixImmutableError`) for any
    // actual CHANGE on an existing Organisation -- a no-op resubmission
    // of the Organisation's current value is still accepted. The guard
    // above (Criterion 2.2, "cannot be cleared") runs BEFORE Team.update
    // either way, so an Organisation's prefix can never be blanked
    // regardless of which layer would otherwise catch it.
    const updatedTeam = await Team.update(req.params.teamId, {
      name,
      description,
      color,
      visibility,
      can_join: canJoin,
      parent_team_id: parentTeamId,
      callsign_name_format: callsignNameFormat,
      callsign_level_selection: callsignLevelSelection,
      pseudonymous_usernames: pseudonymousUsernames,
      callsign_prefix: callsignPrefix,
      // Foreign_Partner country prefix: passed straight through. Team.update
      // enforces write-once on an existing Organisation (a no-op resubmission
      // of the current value is accepted; any change throws
      // OrganisationCountryCodeImmutableError) and rejects a country_code on
      // a Sub_Team -- mirroring callsign_prefix's own immutability handling.
      country_code: countryCode,
      // Callsign Team-segment separator toggle: passed straight through.
      // Team.update rejects it on a Sub_Team, but freely APPLIES a
      // changed value on an existing Organisation -- no immutability
      // guard, unlike callsign_prefix/country_code above.
      callsign_team_hyphenated: callsignTeamHyphenated
    });

    // When canJoin is explicitly set to false, revoke any existing
    // sign-up code for this team so the code is no longer usable.
    if (canJoin === false) {
      await pool.query('DELETE FROM signup_codes WHERE team_id = $1', [req.params.teamId]);
    }

    // Update user attributes if callsign settings changed. Requirement
    // 5.12 (task 11.6): a Callsign_Level_Selection change must also
    // trigger this regeneration, consistent with the existing
    // callsignNameFormat-change trigger. `updateTeamUserAttributes` ->
    // `generateCallsign` -> `computeCallsignAttributes` only ever READS
    // the user's stored `callsign_suffix` (never recomputes/writes it,
    // per task 11.1), so this regeneration cannot alter it.
    //
    // Bugfix (callsign-handling): a `callsignPrefix` change is now also a
    // trigger -- a Sub_Team's own prefix segment feeds directly into
    // every one of its members' assembled callsign, so correcting a
    // Sub_Team's prefix (previously impossible; see the note at the
    // Team.update call above) must refresh the cached callsign the
    // Dashboard/Orgs & Teams views read, exactly as a Callsign_Level_Selection
    // or Callsign_Name_Format change already does. A no-op resubmission
    // on an Organisation still reaches here (Team.update accepts it), but
    // `updateTeamUserAttributes` is idempotent -- re-running it against
    // an unchanged prefix regenerates the same values, so no extra guard
    // is needed to distinguish "changed" from "resubmitted unchanged"
    // here the way `Team.update` itself must.
    // Callsign Team-segment separator toggle: a callsignTeamHyphenated
    // change must also trigger regeneration -- it changes how every
    // member's assembled callsign is joined, exactly as a
    // Callsign_Level_Selection or Callsign_Name_Format change already
    // does.
    const UserAttributesService = require('../services/userAttributes');
    if (
      callsignNameFormat !== undefined ||
      callsignLevelSelection !== undefined ||
      callsignPrefix !== undefined ||
      callsignTeamHyphenated !== undefined
    ) {
      await UserAttributesService.updateTeamUserAttributes(req.params.teamId);
    }

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.update', 'team', parseInt(req.params.teamId, 10), JSON.stringify({ name: updatedTeam.name })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ team: updatedTeam });
  } catch (error) {
    // Requirement 5.2 (task 8.2): Team.update throws this BEFORE any
    // UPDATE is attempted when a supplied callsignLevelSelection value is
    // out of the 1..MAX_TEAM_DEPTH range.
    if (error instanceof Team.CallsignLevelSelectionRangeError) {
      return res.status(400).json({ error: error.message });
    }
    // Requirement 5.6 (task 8.2): Team.update throws this BEFORE any
    // UPDATE is attempted when callsignLevelSelection is supplied on a
    // Sub_Team update request.
    if (error instanceof Team.CallsignLevelSelectionSubTeamError) {
      return res.status(400).json({ error: error.message });
    }
    // takserver-enrollment Requirement 6.2 (task 5.4): Team.update
    // throws this BEFORE any UPDATE is attempted when
    // pseudonymousUsernames is supplied on a Sub_Team update request.
    if (error instanceof Team.PseudonymousUsernamePolicySubTeamError) {
      return res.status(400).json({ error: error.message });
    }
    // takserver-enrollment Requirement 7.2/7.3 (task 5.4): Team.update
    // throws this BEFORE any UPDATE is attempted when a request
    // attempts to CHANGE (not resubmit) an existing Organisation's
    // pseudonymousUsernames value. The error's own message states the
    // concrete consequence being prevented.
    if (error instanceof Team.PseudonymousUsernamePolicyImmutableError) {
      return res.status(400).json({ error: error.message });
    }
    // Bugfix (callsign-handling): Team.update throws this BEFORE any
    // UPDATE is attempted when a request attempts to CHANGE (not
    // resubmit) an EXISTING Organisation's callsignPrefix -- a Sub_Team's
    // prefix is unrestricted and never reaches this branch.
    if (error instanceof Team.OrganisationCallsignPrefixImmutableError) {
      return res.status(400).json({ error: error.message });
    }
    // Bugfix (callsign-handling): Team.update throws this when a
    // callsignPrefix edit collides with idx_teams_callsign_prefix's
    // UNIQUE constraint (another team already holds that prefix).
    if (error instanceof Team.CallsignPrefixConflictError) {
      return res.status(400).json({ error: error.message });
    }
    // Org-wide-team-name-uniqueness: Team.update throws this BEFORE any
    // UPDATE when a rename OR a re-parent would make this team's name
    // collide with another team in the same Organisation (across the
    // whole subtree). A client-correctable 400.
    if (error instanceof Team.TeamNameConflictError) {
      return res.status(400).json({ error: error.message });
    }
    // Foreign_Partner country prefix: Team.update throws these BEFORE any
    // UPDATE -- an attempt to CHANGE an existing Organisation's country_code
    // (OrganisationCountryCodeImmutableError, write-once), an unknown ISO
    // code (CountryCodeInvalidError), or a country_code supplied on a
    // Sub_Team (CountryCodeSubTeamError). All client-correctable 400s,
    // mirroring the callsignPrefix immutability/conflict handling above.
    if (
      error instanceof Team.OrganisationCountryCodeImmutableError ||
      error instanceof Team.CountryCodeInvalidError ||
      error instanceof Team.CountryCodeSubTeamError
    ) {
      return res.status(400).json({ error: error.message });
    }
    // Callsign Team-segment separator toggle: Team.update throws this
    // BEFORE any UPDATE is attempted when callsignTeamHyphenated is
    // supplied on a Sub_Team update request, mirroring
    // pseudonymousUsernames'/countryCode's own Sub_Team-rejection
    // handling above.
    if (error instanceof Team.ChannelTierAccessSubTeamError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to update team');
    res.status(500).json({ error: 'Failed to update team' });
  }
});

// Update an Organisation's Response/Support channel-tier access flags.
// Global_Manager-only (Requirement: 'team:channel_access:manage' is
// deliberately NOT 'team:update' -- see the Permission_Registry entry's
// comment), no Team_Admin fallback: a Team_Admin of this very Organisation
// cannot reach this route even for their own Organisation.
router.put('/:teamId/channel-access', authenticateToken, authorize, [
  body('responseChannelAccess').optional().isBoolean(),
  body('supportChannelAccess').optional().isBoolean()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    // Authorization (global manager only) is enforced centrally by
    // authorize.js via the
    // 'PUT /api/teams/:teamId/channel-access': ['team:channel_access:manage']
    // Permission_Registry entry.

    const team = await Team.findById(req.params.teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // response_channel_access/support_channel_access are Organisation-only
    // (Team.update rejects a Sub_Team supplying either with a typed
    // ChannelTierAccessSubTeamError, mapped to 400 below as defense in
    // depth), but checking here too lets this route return a clearer,
    // request-shape-specific message before ever calling Team.update.
    if (team.parent_team_id !== null) {
      return res.status(400).json({
        error: 'Response/Support channel access can only be set on an Organisation, not a Sub_Team'
      });
    }

    const { responseChannelAccess, supportChannelAccess } = req.body;

    if (responseChannelAccess === undefined && supportChannelAccess === undefined) {
      return res.status(400).json({
        error: 'At least one of responseChannelAccess or supportChannelAccess must be supplied'
      });
    }

    // Diff against the CURRENTLY stored values before updating, so the
    // reconciliation Sync_Operation below is only enqueued for a flag that
    // actually changed -- a no-op resubmission (e.g. re-saving a form with
    // an unchanged flag) must not re-trigger a full Organisation-wide
    // group-membership reconciliation.
    const responseChanged =
      responseChannelAccess !== undefined &&
      Boolean(responseChannelAccess) !== Boolean(team.response_channel_access);
    const supportChanged =
      supportChannelAccess !== undefined &&
      Boolean(supportChannelAccess) !== Boolean(team.support_channel_access);

    const updatedTeam = await Team.update(req.params.teamId, {
      response_channel_access: responseChannelAccess,
      support_channel_access: supportChannelAccess
    });

    // Enqueue one reconciliation Sync_Operation per tier that actually
    // changed, resolving every user under this Organisation's tree and
    // adding/removing their Response/Support group membership to match
    // the new flag state (see syncWorker's resync_org_channel_tier_access
    // handler). Enqueued OUTSIDE any transaction (Team.update itself does
    // not run in one), matching the fire-and-forget enqueue pattern
    // Team.create/Team.update already use for create_cloudtak_group/
    // update_cloudtak_group -- a transient enqueue failure must not fail
    // the flag update itself, since the flag is the source of truth and a
    // missed reconciliation is self-healed by the next explicit sync.
    const reconcileEnabled = isBulkGroupReconcileEnabled();
    for (const tier of ['response', 'support']) {
      const changed = tier === 'response' ? responseChanged : supportChanged;
      if (!changed) continue;
      try {
        if (reconcileEnabled) {
          // Group-authoritative: one region reconcile per active region
          // channel of this tier. Each recomputes its full membership
          // (gated on every org's tier flag), so this org's flip is
          // reflected without a per-user fan-out. Non-transactional (this
          // route runs no transaction), matching the old enqueue.
          await enqueueRegionTierReconciles(tier, req.user.userId);
        } else {
          await EventPublisher.publishOperation(
            'resync_org_channel_tier_access',
            { organisation_id: parseInt(req.params.teamId, 10), tier },
            req.user.userId
          );
        }
      } catch (enqueueError) {
        getLogger().error(
          { err: enqueueError, teamId: req.params.teamId, tier },
          'Error enqueuing channel-access reconciliation'
        );
      }
    }

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [
          req.user.userId,
          'team.channel_access.update',
          'team',
          parseInt(req.params.teamId, 10),
          JSON.stringify({
            response_channel_access: updatedTeam.response_channel_access,
            support_channel_access: updatedTeam.support_channel_access
          })
        ]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ team: updatedTeam });
  } catch (error) {
    // Team.update throws this BEFORE any UPDATE is attempted when either
    // flag is supplied on a Sub_Team update request. Should not normally
    // be reachable here given the explicit check above, but kept as
    // defense in depth against the two checks ever drifting.
    if (error instanceof Team.ChannelTierAccessSubTeamError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to update channel access');
    res.status(500).json({ error: 'Failed to update channel access' });
  }
});

// Get team details
router.get('/:teamId', authenticateToken, authorize, async (req, res) => {
  try {
    getLogger().debug({ teamId: req.params.teamId }, 'Fetching team details');
    
    const team = await Team.findById(req.params.teamId);
    if (!team) {
      getLogger().debug({ teamId: req.params.teamId }, 'Team not found');
      return res.status(404).json({ error: 'Team not found' });
    }

    getLogger().debug({ team }, 'Team found');
    
    let members = [];
    let channels = [];
    try {
      members = await Team.getMembers(req.params.teamId);
      getLogger().debug({ count: members?.length || 0 }, 'Members fetched');
    } catch (memberError) {
      getLogger().error({ err: memberError }, 'Error fetching members, continuing with empty array');
      members = [];
    }

    try {
      const channelResult = await pool.query('SELECT * FROM channels WHERE team_id = $1', [req.params.teamId]);
      channels = channelResult.rows;
      getLogger().debug({ count: channels?.length || 0 }, 'Channels fetched');
    } catch (channelError) {
      getLogger().error({ err: channelError }, 'Error fetching channels, continuing with empty array');
      channels = [];
    }

    // Client UX: a Team_Detail_Page header summary ("Join limited by
    // Email Domain: Yes/No", with the domain list on hover for "Yes")
    // needs to know this Organisation's `org_allowed_domains` without
    // its own separate round trip. Organisation-only (no
    // `parent_team_id`) -- a Sub_Team never carries its own domain
    // restriction, matching `OrgDomainManager`'s existing Organisation-
    // only gating -- so `team.allowed_domains` is `null` for a Sub_Team
    // and an array (possibly empty) for an Organisation. This is
    // ADDITIVE to the `team` object; it changes no existing field and
    // introduces no new top-level response key.
    if (!team.parent_team_id) {
      try {
        const domainResult = await pool.query(
          'SELECT domain FROM org_allowed_domains WHERE org_id = $1 ORDER BY domain',
          [team.id]
        );
        team.allowed_domains = domainResult.rows.map((row) => row.domain);
      } catch (domainError) {
        getLogger().error({ err: domainError }, 'Error fetching org allowed domains, continuing with null');
        team.allowed_domains = null;
      }
    } else {
      team.allowed_domains = null;
    }

    // Bugfix: `Team.getMembers` deliberately returns every
    // team_memberships row including a Team_Owned_Device's (that query
    // is a documented pure alias reused as `Team.getFullMemberList` by
    // `CallsignSuffixUniquenessService`, which NEEDS device rows
    // included to catch a device/human callsign_suffix collision -- see
    // that method's own doc comment). This Member_List-facing response
    // is a different consumer with a different requirement: a device has
    // no username and is not a Member/Admin a human admin can manage
    // through this list (edit/resend-welcome/transfer/remove), so it is
    // filtered out HERE, at the response boundary, rather than inside
    // `Team.getMembers` itself where it would also strip rows the
    // uniqueness check depends on.
    const humanMembers = (members || []).filter((member) => !member.is_team_device);

    res.json({ team, members: humanMembers, channels: channels || [] });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch team details');
    res.status(500).json({ error: 'Failed to fetch team', details: error.message });
  }
});

// Add member to team
router.post('/:teamId/members', authenticateToken, authorize, requireTeamAdmin, [
  body('userId').isInt(),
  body('role').optional().isIn(['admin', 'member'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId, role = 'member' } = req.body;
    const membership = await Team.addMember(req.params.teamId, userId, role);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.member_add', 'team', parseInt(req.params.teamId, 10), JSON.stringify({ addedUserId: userId, role })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.status(201).json({ membership });
  } catch (error) {
    // Data-corruption bugfix: a caller attempting to promote a user whose
    // only relationship to this team is an inherited membership row gets
    // a 400 naming the real reason, not a generic 500 -- this is a
    // client-correctable rejection (the caller should transfer the
    // user's Direct_Membership first), not a server error.
    if (error instanceof Team.InheritedMembershipPromotionError) {
      return res.status(400).json({ error: error.message });
    }
    getLogger().error({ err: error }, 'Failed to add member');
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// Edit a Member_List member's name, TAK_Role, and/or callsign_suffix
// (Requirements 11.4, 11.16, 13.2, 13.3, 13.4, 13.5, 13.6, 13.9, task 28.1).
//
// All body fields are optional -- only the fields actually present are
// written. `email` is intentionally NOT an accepted field: if present in
// the body it is silently ignored (Requirement 13.3's defense-in-depth;
// the Client never sends it, but this route independently never applies
// it even if sent directly).
//
// Authorization ('team:members:edit') is enforced centrally by
// authorize.js via the Permission_Registry entry added alongside this
// route (task 28.2 implements the resolver itself; until then this
// route simply references the permission identifier).
router.patch('/:teamId/members/:userId', authenticateToken, authorize, [
  body('firstName').optional().trim().isLength({ min: 1, max: 150 }),
  body('lastName').optional().trim().isLength({ min: 1, max: 150 }),
  body('takRole').optional().isIn(TAK_ROLE_VALUES)
    .withMessage('Invalid takRole value'),
  body('callsignSuffix').optional().trim().custom(value => isValidCallsignSuffix(value))
    .withMessage('callsignSuffix may only contain letters, digits, "-", and "."')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId, userId } = req.params;
    const { firstName, lastName, takRole, callsignSuffix } = req.body;

    // Requirement 11.16: validate callsign_suffix uniqueness BEFORE any
    // write, so a conflicting value never reaches the database. Excludes
    // the user being edited (`userId`) from the comparison set, so a
    // user's own unchanged callsign_suffix never spuriously conflicts
    // with itself.
    if (callsignSuffix !== undefined) {
      try {
        await checkCallsignSuffixUniqueness(teamId, callsignSuffix, parseInt(userId, 10));
      } catch (conflictError) {
        if (conflictError instanceof CallsignSuffixConflictError) {
          return res.status(400).json({ error: conflictError.message });
        }
        throw conflictError;
      }
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updateFields = {};
    if (firstName !== undefined) {
      updateFields.first_name = firstName;
    }
    if (lastName !== undefined) {
      updateFields.last_name = lastName;
    }
    if (callsignSuffix !== undefined) {
      updateFields.callsign_suffix = callsignSuffix;
    }
    if (takRole !== undefined) {
      updateFields.tak_role = takRole;
    }

    const updatedUser = await User.update(userId, updateFields);

    // Requirement 11.4 dual-write: callsign_suffix mirrors to user_cache,
    // keyed by authentik_id (not the local users.id).
    if (callsignSuffix !== undefined) {
      await pool.query(
        'UPDATE user_cache SET callsign_suffix = $1 WHERE authentik_id = $2',
        [callsignSuffix, targetUser.authentik_user_id]
      );

      // Bugfix (callsign-handling): a callsign_suffix edit must also
      // recompute and persist the ASSEMBLED tak_callsign (Organisation
      // prefix + Team segment + this Name segment). The raw
      // callsign_suffix column above is correct immediately -- which is
      // why re-opening the edit form shows the right value -- but
      // without this the DISPLAYED callsign (user_cache.tak_callsign,
      // and the value pushed to Authentik's takCallsign attribute)
      // stays stale until some UNRELATED trigger (a Team-level
      // callsignPrefix/callsignNameFormat/callsignLevelSelection
      // change, or the next periodic Authentik sync) happens to
      // regenerate it.
      //
      // Deliberately does NOT apply `attributes.role` from
      // generateCallsign's result: that value is hardcoded to
      // 'Team Member', and a callsign_suffix
      // edit must never clobber this user's separately-managed
      // tak_role -- only `callsign`/`color` are read from the result.
      //
      // Bugfix (callsign-handling, second pass): this route is reachable
      // from ANY team page a user's row appears on -- including an
      // ancestor Team's page, where the user shows up via an INHERITED
      // membership row, not a direct one. Regenerating from
      // `req.params.teamId` verbatim (the URL's team, e.g. the
      // Organisation) resolves the WRONG Ancestor_Chain -- one with no
      // Sub_Team segment at all -- and silently drops that segment from
      // the recomputed callsign (e.g. "FENZ-K.Kokako" instead of the
      // correct "FENZ-STL-K.Kokako"). The callsign must always be
      // generated from the user's own DIRECT team
      // (`inherited_from_team_id IS NULL`), never the team named in the
      // URL, mirroring `updateTeamUserAttributes`'s own established
      // "the user's actual direct team, exactly once" rule.
      const directTeamResult = await pool.query(
        'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
        [userId]
      );
      const directTeamId = directTeamResult.rows[0]?.team_id ?? teamId;

      const UserAttributesService = require('../services/userAttributes');
      const generatedAttributes = await UserAttributesService.generateCallsign(userId, directTeamId);
      if (generatedAttributes) {
        await UserAttributesService.updateUserAttributes(targetUser.authentik_user_id, {
          callsign: generatedAttributes.callsign,
          color: generatedAttributes.color
        });
        await pool.query(
          'UPDATE user_cache SET tak_callsign = $1, tak_color = $2 WHERE authentik_id = $3',
          [generatedAttributes.callsign, generatedAttributes.color, targetUser.authentik_user_id]
        );
      }
    }

    // Requirement 13.6: takRole writes dual-write to user_cache and push
    // to Authentik via the fetch-merge-PATCH updateUserAttributes (task
    // 11.4), so this write cannot clobber, and cannot be clobbered by, a
    // concurrent callsign regeneration.
    if (takRole !== undefined) {
      await pool.query(
        'UPDATE user_cache SET tak_role = $1 WHERE authentik_id = $2',
        [takRole, targetUser.authentik_user_id]
      );

      const UserAttributesService = require('../services/userAttributes');
      await UserAttributesService.updateUserAttributes(targetUser.authentik_user_id, { role: takRole });
    }

    // Push first_name/last_name to Authentik custom attributes (same
    // one-way-sync pattern as takRole above: local edit pushes to Authentik,
    // periodic sync reads back from Authentik).
    if (firstName !== undefined || lastName !== undefined) {
      const UserAttributesService = require('../services/userAttributes');
      const nameAttrs = {};
      if (firstName !== undefined) nameAttrs.firstName = firstName;
      if (lastName !== undefined) nameAttrs.lastName = lastName;
      await UserAttributesService.updateUserAttributes(targetUser.authentik_user_id, nameAttrs);
      // Also mirror to user_cache
      if (firstName !== undefined) {
        await pool.query('UPDATE user_cache SET first_name = $1 WHERE authentik_id = $2', [firstName, targetUser.authentik_user_id]);
      }
      if (lastName !== undefined) {
        await pool.query('UPDATE user_cache SET last_name = $1 WHERE authentik_id = $2', [lastName, targetUser.authentik_user_id]);
      }
    }

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.member_edit', 'team', parseInt(teamId, 10), JSON.stringify({ editedUserId: parseInt(userId, 10) })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ member: updatedUser });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update team member');
    res.status(500).json({ error: 'Failed to update team member' });
  }
});

// Get team hierarchy
router.get('/:teamId/hierarchy', authenticateToken, authorize, async (req, res) => {
  try {
    const hierarchy = await Team.getTeamHierarchy(req.params.teamId);
    res.json({ hierarchy });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch team hierarchy');
    res.status(500).json({ error: 'Failed to fetch hierarchy' });
  }
});

// Get callsign level options (Requirement 5.8-5.11, task 8.3): the flat
// { team_depth, callsign_prefix } rows Team.getSubTeamsForCallsignLevel
// returns for :teamId's whole hierarchy, used by the Client to label each
// Callsign_Level_Selection toggle. Authorization ('team:read') is enforced
// centrally by authorize.js, matching the sibling GET /:teamId,
// /:teamId/hierarchy, and /:teamId/sub-teams routes above.
router.get('/:teamId/callsign-level-options', authenticateToken, authorize, async (req, res) => {
  try {
    const options = await Team.getSubTeamsForCallsignLevel(req.params.teamId);
    res.json({ options });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch callsign level options');
    res.status(500).json({ error: 'Failed to fetch callsign level options' });
  }
});

// Get sub-teams
//
// Requirement 6.5 (task 14.2): this route's OWN access to `:teamId` is
// already gated by the `'team:read'` row-scoped Visible_Branch check
// (enforced centrally via `authorize`, task 14.1) -- by the time this
// handler runs, the caller is already confirmed able to see `:teamId`
// itself. What's filtered here is the CHILDREN in the returned list:
// some of `:teamId`'s direct sub-teams may themselves be private (or
// have a private ancestor of their own), and those must be excluded
// from the returned list rather than causing the whole request to 404.
router.get('/:teamId/sub-teams', authenticateToken, authorize, async (req, res) => {
  try {
    const subTeams = await Team.getSubTeams(req.params.teamId);
    const visibleSubTeams = await TeamVisibilityService.filterVisibleBranches(subTeams || [], req.user);
    res.json({ subTeams: visibleSubTeams });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch sub-teams');
    res.status(500).json({ error: 'Failed to fetch sub-teams' });
  }
});

// Delete team (global admin only)
router.delete('/:teamId', authenticateToken, authorize, async (req, res) => {
  try {
    // Authorization (global admin only) is enforced centrally by
    // authorize.js via the 'DELETE /api/teams/:teamId': ['team:delete:global']
    // Permission_Registry entry.

    const team = await Team.findById(req.params.teamId);
    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    // Cascade-delete feature (Global_Manager only -- already enforced by
    // the 'team:delete:global' Permission_Registry entry / authorize.js
    // resolver, which has NO Team_Admin fallback): a team WITH sub-teams
    // may now be deleted, cascading into every descendant -- but ONLY
    // when the whole subtree is empty of human members and Team_Owned_
    // Devices. This gate exists because deleting a team detaches (never
    // deletes) the users/devices in it: a human is left a valid but
    // teamless account, and a Team_Owned_Device is left an orphaned
    // device row plus a dangling TAK Server certificate record. Forcing
    // the operator to empty the subtree first keeps a cascade delete
    // from silently producing those remnants. The check is authoritative
    // here on the server; the Client's confirmation dialog only mirrors
    // it for a better message.
    //
    // A single team with no sub-teams still deletes exactly as before
    // (subTreeCount 0), via the same gated path -- there is no separate
    // code path for it.
    const { memberCount, deviceCount, subTeamCount } = await Team.getSubtreeMemberDeviceCounts(req.params.teamId);
    if (memberCount > 0 || deviceCount > 0) {
      // Build a human-readable, count-naming refusal. Both counts span
      // the WHOLE subtree (this team plus every descendant), so the
      // message says "this team or its sub-teams" only when sub-teams
      // actually exist.
      const scope = subTeamCount > 0 ? 'this team or its sub-teams' : 'this team';
      const parts = [];
      if (memberCount > 0) {
        parts.push(`${memberCount} member${memberCount === 1 ? '' : 's'}`);
      }
      if (deviceCount > 0) {
        parts.push(`${deviceCount} team device${deviceCount === 1 ? '' : 's'}`);
      }
      return res.status(409).json({
        error: `Cannot delete: ${scope} still ${(memberCount + deviceCount) === 1 ? 'has' : 'have'} ${parts.join(' and ')}. Remove all members and team devices first.`,
        memberCount,
        deviceCount,
        subTeamCount
      });
    }

    // req.user.userId is the local users.id (see server/middleware/auth.js),
    // which is what the delete records as `created_by` on any
    // remove_team_channel_group Sync_Operations it enqueues.
    // `deleteWithSubtree` deletes the team AND every descendant
    // deepest-first, running the SAME per-team channel/CloudTAK cleanup
    // for each rather than relying on the raw parent_team_id FK cascade
    // (which would orphan descendant Authentik/CloudTAK groups). For a
    // team with no sub-teams it deletes exactly that one team.
    await Team.deleteWithSubtree(req.params.teamId, req.user.userId);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'team.delete', 'team', parseInt(req.params.teamId, 10), null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ message: 'Team deleted successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to delete team');
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

module.exports = router;