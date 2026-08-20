const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken, requireTeamAdmin } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { paginationParams } = require('../middleware/pagination');
const User = require('../models/User');
const Team = require('../models/Team');
const authentikService = require('../services/authentik');
const UserAttributesService = require('../services/userAttributes');
const TeamMembershipService = require('../services/TeamMembershipService');
const UserProvisioningService = require('../services/UserProvisioningService');
const { CallsignSuffixConflictError } = require('../services/CallsignSuffixUniquenessService');
const EventPublisher = require('../services/EventPublisher');
const EmailService = require('../services/EmailService');
const pool = require('../config/database');
const { getLogger } = require('../middleware/requestContext');
const router = express.Router();

// List all users
//
// Requirement 11.3: team-name resolution for the full returned user list
// runs as a single batched query, independent of the number of users
// returned, instead of one recursive-CTE query per user (the previous
// implementation's N+1 pattern via `Promise.all(authentikUsers.map(...))`).
//
// The `WITH RECURSIVE team_root` CTE below computes, for every team in the
// (small, bounded) `teams` table, its root ancestor's `callsign_prefix`/
// `name` exactly once per request -- not once per returned user -- by
// walking every team's `parent_team_id` chain up to its root row
// (`parent_team_id IS NULL`) in a single pass. The outer query then LEFT
// JOINs `users` -> `team_memberships` (direct membership only, i.e.
// `inherited_from_team_id IS NULL`, matching the prior per-user query's
// filter exactly, now expressed as part of the JOIN condition rather than
// the WHERE clause so a user with no direct team membership still produces
// a row instead of being dropped) -> `teams` -> that precomputed root-team
// result, filtered to `WHERE u.authentik_user_id = ANY($1)` for the full
// batch of Authentik user ids at once. Cost is therefore bounded by the
// size of the `teams` table, not by the number of users returned.
//
// Requirement 11.4: the shared `paginationParams` middleware validates
// `page`/`pageSize` (rejecting out-of-range values with 400 before any
// Authentik/DB call runs) and attaches `req.pagination`. The resolved
// `page`/`pageSize` are passed straight through to
// `authentikService.getUsers()`, which maps them onto Authentik's own
// `page`/`page_size` query parameters (see that method's doc comment for
// why this option was chosen over in-memory slicing of a full fetch) --
// so only the requested page of users is fetched from Authentik at all,
// and the batched team-name query's `ANY($1)` id array is scoped to that
// same page.
//
// Requirement 27.9 (task 49.5): excludes every Team_Owned_Device
// (`users.is_team_device = true`) from the response. The primary user
// list here is sourced from AUTHENTIK (`authentikService.getUsers`), not
// the local `users` table -- and a Team_Owned_Device's Authentik user IS
// included in that Authentik-side result: `DeviceEnrollmentService
// .createDevice` creates it via the same `authentikService.createUser`
// path used for human users, which always sets `type: 'internal'`
// (`server/services/authentik.js`), and `getUsers({page, pageSize})`
// filters on `?type=internal` -- so a device is indistinguishable from a
// human user on the Authentik side. `is_team_device` is a LOCAL-only flag
// (added to `users`/`user_cache` by task 49.1's migration), so exclusion
// must happen here, after the Authentik fetch, by cross-referencing the
// local `users` table. The SAME single batched query already used for
// team-name resolution above is extended to additionally select
// `u.is_team_device`, keyed by `authentik_user_id`, avoiding a third
// database round trip (Requirement 11.3's "1-2 queries" allowance).
//
// `pagination.total` is INTENTIONALLY left as Authentik's own
// `count` (from its `type=internal` pagination envelope) rather than
// adjusted downward by the number of excluded devices. Getting an
// exactly-accurate adjusted total would require either (a) an additional,
// page-independent `COUNT(*) FROM users WHERE is_team_device = true`
// query run on every request regardless of page contents (a real, if
// small, cost for a field that's advisory at best), or (b) filtering
// Authentik's OWN result set by a criterion Authentik has no concept of.
// Since a Team_Owned_Device is created with `type: 'internal'` (confirmed
// above), there is no Authentik-side query parameter that could exclude
// it upstream. Per this task's explicit allowance for a documented
// compromise, `pagination.total` may therefore over-count by the number
// of Team_Owned_Devices that exist; the returned `users` array itself is
// always correctly filtered, which is the requirement's primary concern
// (Requirement 27.9's "excludes every Team_Owned_Device from any
// user-facing ... count").
router.get('/', authenticateToken, authorize, paginationParams, async (req, res) => {
  try {
    const { page, pageSize } = req.pagination;
    const { results: authentikUsers, count: totalUsers } = await authentikService.getUsers({ page, pageSize });

    const authentikUserIds = authentikUsers.map((user) => user.pk);

    // Map of authentik_user_id -> team_name, built from the single batched
    // query below. Defaults to an empty map (all users get team_name: null)
    // when there are no users to look up, avoiding an unnecessary query.
    const teamNameByAuthentikUserId = new Map();
    // Requirement 27.9: authentik_user_id -> is_team_device, built from the
    // SAME batched query below, used to exclude Team_Owned_Device rows
    // from the response after the map is built.
    const isTeamDeviceByAuthentikUserId = new Map();

    if (authentikUserIds.length > 0) {
      const teamNameResult = await pool.query(`
        WITH RECURSIVE team_root AS (
          SELECT id AS team_id, id AS root_id, name AS root_name,
                 callsign_prefix AS root_callsign_prefix, parent_team_id
          FROM teams
          UNION ALL
          SELECT tr.team_id, p.id AS root_id, p.name AS root_name,
                 p.callsign_prefix AS root_callsign_prefix, p.parent_team_id
          FROM team_root tr
          JOIN teams p ON p.id = tr.parent_team_id
          WHERE tr.parent_team_id IS NOT NULL
        )
        SELECT u.authentik_user_id AS authentik_user_id,
               u.is_team_device AS is_team_device,
               CASE
                 WHEN t.parent_team_id IS NOT NULL THEN
                   COALESCE(root.root_callsign_prefix, root.root_name, '') || ' - ' || t.name
                 ELSE t.name
               END AS team_name
        FROM users u
        LEFT JOIN team_memberships tm ON u.id = tm.user_id AND tm.inherited_from_team_id IS NULL
        LEFT JOIN teams t ON tm.team_id = t.id
        LEFT JOIN team_root root ON root.team_id = t.id AND root.parent_team_id IS NULL
        WHERE u.authentik_user_id = ANY($1)
      `, [authentikUserIds]);

      for (const row of teamNameResult.rows) {
        teamNameByAuthentikUserId.set(row.authentik_user_id, row.team_name);
        isTeamDeviceByAuthentikUserId.set(row.authentik_user_id, row.is_team_device === true);
      }
    }

    // No further async DB calls needed per user; attach each user's
    // team_name synchronously from the lookup map built above (defaulting
    // to null for a user with no direct team membership, matching the
    // previous per-user fallback behavior), and drop any user whose local
    // `users` row has `is_team_device = true` (Requirement 27.9). A user
    // absent from the map (no corresponding local `users` row at all)
    // defaults to `false` via the `=== true` comparison above and is
    // therefore never excluded on that basis alone.
    const usersWithTeams = authentikUsers
      .filter((user) => !isTeamDeviceByAuthentikUserId.get(user.pk))
      .map((user) => ({
        ...user,
        team_name: teamNameByAuthentikUserId.get(user.pk) ?? null
      }));

    res.json({
      users: usersWithTeams,
      pagination: { page, pageSize, total: totalUsers }
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch users');
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get current user profile
router.get('/me', authenticateToken, authorize, async (req, res) => {
  try {
    // Get user's direct team membership only (exclude inherited)
    const teamResult = await pool.query(`
      SELECT t.id, t.name, t.parent_team_id, t.visibility,
             CASE 
               WHEN t.parent_team_id IS NOT NULL THEN 
                 COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
               ELSE t.name
             END as display_name
      FROM users u
      JOIN team_memberships tm ON u.id = tm.user_id
      JOIN teams t ON tm.team_id = t.id
      LEFT JOIN teams rt ON rt.id = (
        WITH RECURSIVE root_team AS (
          SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = t.id
          UNION ALL
          SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id 
          FROM teams p JOIN root_team r ON p.id = r.parent_team_id
        )
        SELECT id FROM root_team WHERE parent_team_id IS NULL
      )
      WHERE u.authentik_user_id = $1 AND tm.inherited_from_team_id IS NULL
    `, [req.user.id]);
    
    const teams = teamResult.rows;
    // channel_memberships.user_id is a foreign key to the local users.id,
    // NOT the Authentik id -- req.user.userId, not req.user.id.
    const channels = await User.getChannelMemberships(req.user.userId);
    
    // req.user is already populated from user_cache by
    // resolveUserFromRequest/authenticateToken (server/middleware/auth.js),
    // including groups/takCallsign/takColor/takRole -- and user_cache is
    // kept current by the periodic Authentik sync (authentikSync.js,
    // every SYNC_INTERVAL_MINUTES, default 10). This route previously
    // ALSO made a live call to Authentik's /users/:id/ endpoint, then one
    // more live call PER group membership to resolve group names, on
    // every single call to this route -- entirely redundant with data
    // already sitting in req.user, and the actual cause of the Dashboard
    // (which calls this route on every load) feeling slow: every load
    // paid for 1+N sequential/parallel external HTTP round trips to
    // Authentik just to re-fetch data that was already available locally,
    // at most ~10 minutes staler. Removed entirely -- req.user is used
    // as-is, no live Authentik call.
    res.json({
      user: req.user,
      teams,
      channels
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch user profile');
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Create new user in Authentik and local DB
router.post('/', authenticateToken, authorize, [
  body('username').trim().isLength({ min: 1, max: 150 }),
  body('email').isEmail().normalizeEmail(),
  body('firstName').trim().isLength({ min: 1, max: 150 }),
  body('lastName').trim().isLength({ min: 1, max: 150 }),
  body('password').isLength({ min: 8 }),
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { username, email, firstName, lastName, password, teamId, callsignSuffix } = req.body;

    // Authorization (team admin of teamId, or global manager) is enforced
    // centrally by authorize.js via the 'POST /api/users': ['user:create:team_admin']
    // Permission_Registry entry.

    // Requirement 11.6, 11.7, 11.14, 11.15 (task 22.2): resolve/default/
    // uniqueness-check this new user's callsign_suffix BEFORE creating
    // anything in Authentik, so a CallsignSuffixRequiredError/
    // CallsignSuffixConflictError is returned as a 400 without ever
    // creating an Authentik user for what is fundamentally a
    // request-validation failure.
    let resolvedCallsignSuffix;
    try {
      resolvedCallsignSuffix = await UserProvisioningService.resolveCallsignSuffixForNewUser(null, {
        firstName,
        lastName,
        teamId,
        requestedCallsignSuffix: callsignSuffix
      });
    } catch (resolutionError) {
      if (
        resolutionError instanceof UserProvisioningService.CallsignSuffixRequiredError ||
        resolutionError instanceof CallsignSuffixConflictError
      ) {
        return res.status(400).json({ error: resolutionError.message });
      }
      throw resolutionError;
    }

    // Create user in Authentik
    const authentikUser = await authentikService.createUser({
      username,
      name: `${firstName} ${lastName}`,
      email
    });

    // Set password
    await authentikService.setUserPassword(authentikUser.pk, password);

    // Create local user record
    const localUser = await User.create({
      authentik_user_id: authentikUser.pk,
      username,
      email,
      first_name: firstName,
      last_name: lastName,
      callsign_suffix: resolvedCallsignSuffix
    });

    // Add to team
    await Team.addMember(teamId, localUser.id, 'member');

    res.status(201).json({ 
      user: localUser,
      message: 'User created successfully'
    });
  } catch (error) {
    getLogger().error({ err: error }, 'User creation failed');
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Move user to holding pen (remove from all teams)
router.post('/:userId/holding-pen', authenticateToken, authorize, async (req, res) => {
  try {
    const { userId } = req.params;

    // Authorization (admin of at least one of the target user's current
    // teams, or global manager) is enforced centrally by authorize.js via
    // the 'POST /api/users/:userId/holding-pen': ['user:holding_pen:team_admin']
    // Permission_Registry entry.

    // Remove from all teams and channels
    await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [userId]);

    res.json({ message: 'User moved to holding pen' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to move user' });
  }
});

// Search users
router.get('/search', authenticateToken, authorize, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query too short' });
    }

    const result = await pool.query(`
      SELECT id, username, email, first_name, last_name 
      FROM users 
      WHERE (username ILIKE $1 OR email ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
      AND is_active = true
      LIMIT 20
    `, [`%${q}%`]);

    res.json({ users: result.rows });
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get available users (not in any team)
router.get('/available', authenticateToken, authorize, async (req, res) => {
  try {
    const { search } = req.query;
    let query = `
      SELECT uc.authentik_id as id, uc.email, uc.first_name, uc.last_name
      FROM user_cache uc
      LEFT JOIN users u ON uc.authentik_id::text = u.authentik_user_id::text
      LEFT JOIN team_memberships tm ON u.id = tm.user_id AND tm.inherited_from_team_id IS NULL
      WHERE tm.user_id IS NULL AND uc.is_active = true 
        AND uc.email IS NOT NULL AND uc.email != ''
        AND uc.first_name IS NOT NULL AND uc.first_name != ''
    `;
    const params = [];
    
    if (search) {
      query += ` AND (uc.first_name ILIKE $1 OR uc.last_name ILIKE $1 OR uc.email ILIKE $1)`;
      params.push(`%${search}%`);
    }
    
    query += ` ORDER BY uc.first_name, uc.last_name LIMIT 50`;
    
    const result = await pool.query(query, params);
    res.json({ users: result.rows });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch available users');
    res.status(500).json({ error: 'Failed to fetch available users' });
  }
});

// Create new user in Authentik and add to team
//
// Requirement 17.1: the Authentik-side user-creation call happens strictly
// BEFORE any database transaction opens (an external HTTP call must never
// be issued from inside an open DB transaction). Once the Authentik user
// exists, exactly one client is acquired from the pool, `BEGIN` is issued,
// and every local write (the `users` upsert, `team_memberships` inserts
// including parent-team inheritance, and `channel_memberships` inserts) is
// performed through `UserProvisioningService.createAndAddUser` using that
// single client, followed by `COMMIT` -- or `ROLLBACK` if any local write
// fails -- with the client released in a `finally` block. This route
// handler is intentionally a thin wrapper: parse/validate the request,
// call Authentik, acquire/BEGIN, delegate to the service, commit/rollback,
// and respond.
router.post('/create-and-add', authenticateToken, authorize, [
  body('email').isEmail(),
  body('firstName').trim().isLength({ min: 1, max: 150 }),
  body('lastName').trim().isLength({ min: 1, max: 150 }),
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, firstName, lastName, teamId, callsignSuffix } = req.body;
  const username = email;
  let newUser;

  // --- Phase 0: resolve/default/uniqueness-check callsign_suffix
  // (Requirement 11.6, 11.7, 11.14, 11.15; task 22.2). This is a
  // pure-read operation (Team.getAncestorChain/getFullMemberList, via the
  // shared pool), so it runs BEFORE Phase 1's Authentik user-creation
  // call: a CallsignSuffixRequiredError/CallsignSuffixConflictError here
  // is a request-validation failure, not a mid-operation failure, so
  // returning early avoids ever creating an orphaned Authentik user for
  // it. ---
  let resolvedCallsignSuffix;
  try {
    resolvedCallsignSuffix = await UserProvisioningService.resolveCallsignSuffixForNewUser(null, {
      firstName,
      lastName,
      teamId,
      requestedCallsignSuffix: callsignSuffix
    });
  } catch (resolutionError) {
    if (
      resolutionError instanceof UserProvisioningService.CallsignSuffixRequiredError ||
      resolutionError instanceof CallsignSuffixConflictError
    ) {
      return res.status(400).json({ error: resolutionError.message });
    }
    getLogger().error({ err: resolutionError }, 'Failed to resolve callsign_suffix for new user');
    return res.status(500).json({ error: 'Failed to create user' });
  }

  // --- Phase 1: Authentik user creation (no open DB transaction). ---
  try {
    const existingUserResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
    });
    const existingUsers = await existingUserResponse.json();

    if (existingUsers.results && existingUsers.results.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const createUserResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username,
        email,
        name: `${firstName} ${lastName}`,
        first_name: firstName,
        last_name: lastName,
        is_active: true
      })
    });

    if (!createUserResponse.ok) {
      const errorData = await createUserResponse.json();
      return res.status(400).json({ error: 'Failed to create user in Authentik', details: errorData });
    }

    newUser = await createUserResponse.json();
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to create user in Authentik');
    return res.status(500).json({ error: 'Failed to create user' });
  }

  // --- Phase 2: single transaction for every local database write. ---
  const client = await pool.connect();
  let localUserId;
  try {
    await client.query('BEGIN');

    const result = await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: newUser.pk,
      username,
      email,
      firstName,
      lastName,
      teamId,
      callsign_suffix: resolvedCallsignSuffix,
      createdBy: req.user?.userId ?? null
    });
    localUserId = result.localUserId;

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    getLogger().error({ err: error, authentikUserId: newUser.pk }, 'Failed to provision user locally after Authentik user creation');

    // --- Requirement 17.2 compensating action ---
    // The Authentik user (newUser.pk) was already created in Phase 1,
    // but every local write attempted in Phase 2 has just been rolled
    // back, so that Authentik user is now orphaned (it exists in
    // Authentik with no corresponding local `users` row,
    // `team_memberships`, or `channel_memberships`). Attempt a
    // SYNCHRONOUS delete of that Authentik user first; only if that
    // delete attempt itself fails do we fall back to enqueueing a
    // `cleanup_orphaned_authentik_user` Sync_Operation for the
    // Sync_Worker to retry asynchronously. Either outcome -- and the
    // (rare) case where even the enqueue fails -- is logged via the
    // structured logger with the exact `{authentikUserId, failedStep,
    // compensationOutcome}` shape called for by the task.
    const failedStep = 'local_transaction';
    let compensationOutcome;
    try {
      const deleteResponse = await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${newUser.pk}/`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}` }
      });

      if (deleteResponse.ok || deleteResponse.status === 404) {
        compensationOutcome = 'deleted_synchronously';
      } else {
        throw new Error(`Authentik delete responded with status ${deleteResponse.status}`);
      }
    } catch (deleteError) {
      getLogger().error(
        { err: deleteError, authentikUserId: newUser.pk },
        'Synchronous compensating Authentik user delete failed; falling back to a queued cleanup operation'
      );
      try {
        await EventPublisher.publishOperation(
          'cleanup_orphaned_authentik_user',
          { authentik_user_id: newUser.pk },
          req.user?.userId ?? null
        );
        compensationOutcome = 'cleanup_operation_queued';
      } catch (enqueueError) {
        getLogger().error(
          { err: enqueueError, authentikUserId: newUser.pk },
          'Failed to enqueue cleanup_orphaned_authentik_user compensating operation'
        );
        compensationOutcome = 'compensation_failed';
      }
    }

    getLogger().error(
      { authentikUserId: newUser.pk, failedStep, compensationOutcome },
      'Orphaned Authentik user compensating action outcome'
    );

    return res.status(500).json({ error: 'Failed to create user' });
  } finally {
    client.release();
  }

  // --- Phase 3: best-effort callsign/attribute sync (Authentik call, run
  // only after the local transaction has committed). ---
  const attributes = await UserAttributesService.generateCallsign(localUserId, teamId);
  const pushAttrs = { ...(attributes || {}), firstName, lastName };
  await UserAttributesService.updateUserAttributes(newUser.pk, pushAttrs);

  // Update user cache (Requirement 11.1: user_cache.callsign_suffix
  // mirrors users.callsign_suffix, dual-written alongside the existing
  // tak_callsign/tak_color/tak_role dual-write here).
  await pool.query(
    'INSERT INTO user_cache (authentik_id, username, email, first_name, last_name, is_active, tak_callsign, tak_color, tak_role, callsign_suffix) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9) ON CONFLICT (authentik_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, tak_callsign = $6, tak_color = $7, tak_role = $8, callsign_suffix = $9',
    [newUser.pk, username, email, firstName, lastName, attributes?.callsign, attributes?.color, attributes?.role, resolvedCallsignSuffix]
  );

  res.status(201).json({
    user: {
      id: newUser.pk,
      username,
      email,
      first_name: firstName,
      last_name: lastName
    }
  });
});

// Add existing user to team
router.post('/add-to-team', authenticateToken, authorize, [
  body('userId').notEmpty(),
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId, teamId } = req.body;
    
    // Get user from user_cache
    const userResult = await pool.query(
      'SELECT authentik_id, username, email, first_name, last_name FROM user_cache WHERE authentik_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // Ensure user exists in users table. first_name/last_name are
    // deliberately omitted from the ON CONFLICT DO UPDATE SET clause here,
    // matching the same one-way-sync direction used in
    // server/services/authentikSync.js's syncSingleUser: the local `users`
    // table is the authoritative source for a real first/last name split
    // (set by UserProvisioningService.createAndAddUser and by the
    // Member_List inline-edit route), while user_cache's copy is only ever
    // a best-effort value derived from Authentik's single `name` field. An
    // unconditional overwrite here would re-clobber an already-established
    // local split via this second propagation path.
    await pool.query(
      'INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active) VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (authentik_user_id) DO UPDATE SET username = $2, email = $3, is_active = true',
      [user.authentik_id, user.username, user.email, user.first_name, user.last_name]
    );
    
    // Get the local user ID
    const localUserResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [user.authentik_id]
    );
    
    const localUserId = localUserResult.rows[0].id;
    
    // Check if user is already in a team (exclude inherited memberships)
    const existingMembership = await pool.query(
      'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
      [localUserId]
    );
    
    if (existingMembership.rows.length > 0) {
      return res.status(400).json({ error: 'User is already a member of another team' });
    }
    
    // req.user.userId is already the local users.id (see
    // server/middleware/auth.js) -- no separate lookup by Authentik id is
    // needed here.
    const requestingUserId = req.user.userId;
    
    // Use new service layer for team assignment
    const result = await TeamMembershipService.addUserToTeam(localUserId, teamId, 'member', requestingUserId);
    
    // Ensure the user has a callsign_suffix before generating the full callsign.
    // If the user already has one (from prior provisioning or Member_List edit),
    // this is a no-op. If they don't, compute and store a default using the same
    // logic as POST /create-and-add (resolveCallsignSuffixForNewUser).
    const suffixCheck = await pool.query('SELECT callsign_suffix, first_name, last_name FROM users WHERE id = $1', [localUserId]);
    if (suffixCheck.rows.length > 0 && !suffixCheck.rows[0].callsign_suffix) {
      try {
        const resolvedSuffix = await UserProvisioningService.resolveCallsignSuffixForNewUser(null, {
          firstName: suffixCheck.rows[0].first_name || user.first_name || '',
          lastName: suffixCheck.rows[0].last_name || user.last_name || '',
          teamId,
          requestedCallsignSuffix: null
        });
        await pool.query('UPDATE users SET callsign_suffix = $1 WHERE id = $2', [resolvedSuffix, localUserId]);
        // Also mirror to user_cache
        await pool.query('UPDATE user_cache SET callsign_suffix = $1 WHERE authentik_id = $2', [resolvedSuffix, user.authentik_id]);
      } catch (suffixErr) {
        // Non-fatal: log and proceed — the callsign will just lack a name segment
        getLogger().error({ err: suffixErr }, 'Failed to compute default callsign_suffix for existing user');
      }
    }

    // Update user callsign and color
    const attributes = await UserAttributesService.generateCallsign(localUserId, teamId);
    if (attributes) {
      await UserAttributesService.updateUserAttributes(user.authentik_id, attributes);
      
      // Update user cache
      await pool.query(
        'UPDATE user_cache SET tak_callsign = $1, tak_color = $2, tak_role = $3 WHERE authentik_id = $4',
        [attributes.callsign, attributes.color, attributes.role, user.authentik_id]
      );
    }

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'user.add_to_team', 'team', teamId, JSON.stringify({ addedUserId: localUserId })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }
    
    res.json({ 
      message: 'User added to team successfully',
      operationsQueued: result.groupsQueued
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to add user to team');
    res.status(500).json({ error: 'Failed to add user to team' });
  }
});

// Remove user from team
router.delete('/remove-from-team/:userId', authenticateToken, authorize, [
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId } = req.params;
    
    // Get user's Authentik ID
    const userResult = await pool.query(
      'SELECT authentik_user_id FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const authentikUserId = userResult.rows[0].authentik_user_id;
    
    // req.user.userId is already the local users.id -- see comment on the
    // add-to-team route above.
    const requestingUserId = req.user.userId;
    
    // Use new service layer for team removal
    const result = await TeamMembershipService.removeUserFromTeam(userId, requestingUserId);
    
    // Clear TAK attributes in Authentik and deactivate the user
    await UserAttributesService.clearUserAttributes(authentikUserId);

    // Delete user from Authentik entirely
    try {
      await fetch(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_ADMIN_TOKEN}`
        }
      });
    } catch (deleteErr) {
      getLogger().error({ err: deleteErr }, 'Failed to delete user from Authentik');
    }

    // Delete user from local system entirely
    await pool.query('DELETE FROM user_cache WHERE authentik_id = $1', [String(authentikUserId)]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'user.remove_from_team', 'user', parseInt(req.params.userId, 10), null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }
    
    res.json({ 
      message: 'User removed from team successfully',
      operationsQueued: result.groupsQueued
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to remove user from team');
    res.status(500).json({ error: 'Failed to remove user from team' });
  }
});


// Resend welcome/approval email to user
router.post('/:userId/resend-welcome', authenticateToken, authorize, async (req, res) => {
  try {
    const { userId } = req.params;
    const { teamId } = req.body;

    // Get user details
    const userResult = await pool.query(
      'SELECT u.id, u.email, u.first_name, u.last_name, uc.tak_callsign FROM users u LEFT JOIN user_cache uc ON uc.authentik_id = u.authentik_user_id WHERE u.id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // Build team path display name
    let teamPath = '';
    if (teamId) {
      try {
        const ancestors = await Team.getAncestorChain(teamId);
        if (ancestors.length > 0) {
          const root = ancestors[ancestors.length - 1];
          const team = ancestors[0];
          teamPath = ancestors.length > 1
            ? `${root.callsign_prefix || root.name} - ${team.name}`
            : (team.callsign_prefix || team.name);
        }
      } catch (e) {
        // fallback: just use team name directly
        const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [teamId]);
        if (teamResult.rows.length > 0) teamPath = teamResult.rows[0].name;
      }
    }

    const emailService = new EmailService();
    await emailService.sendApprovalEmail(user.email, {
      teamPath,
      username: user.email,
      callsign: user.tak_callsign || 'Will be assigned',
      firstName: user.first_name || ''
    });

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'user.resend_welcome', 'user', parseInt(userId, 10), JSON.stringify({ email: user.email })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ message: 'Welcome email resent successfully' });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to resend welcome email');
    res.status(500).json({ error: 'Failed to resend welcome email' });
  }
});

module.exports = router;