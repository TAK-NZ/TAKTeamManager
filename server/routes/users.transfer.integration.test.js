/**
 * Real-Postgres integration tests for `POST /api/users/:userId/transfer`
 * (spec `team-member-transfer`).
 *
 * =====================================================================
 * WHAT THIS FILE IS FOR
 * =====================================================================
 *
 * design.md's testing-strategy table assigns this file Properties 7, 9,
 * 10, 11, 12, 13, 26, and 28 plus the Requirement 17.2 and 17.5
 * assertions. Task 9.2 lands the harness below together with the FIRST of
 * those properties (Property 9); tasks 9.3-9.10 and 10.8 append their own
 * properties to it and are expected to reuse the harness rather than grow
 * a second one.
 *
 * The branch this route takes (immediate execution versus a pending
 * Transfer_Request) is decided by `Team.isAdmin` recursive-CTE walks over
 * real `teams`/`team_memberships` rows, and the thing being asserted is
 * which rows exist afterwards. Mocking `pool` would therefore mock away
 * the entire subject, which is why this is an integration test against a
 * live database rather than a unit test.
 *
 * =====================================================================
 * HOW TO RUN IT
 * =====================================================================
 *
 *   npx jest server/routes/users.transfer.integration.test.js \
 *     --testPathIgnorePatterns=/node_modules/ /client/
 *
 * `*.integration.test.js` is excluded from `npm test` by
 * `testPathIgnorePatterns` in `package.json`, so this file never runs in
 * the default suite and never affects its coverage gate. It needs a live,
 * already-migrated Postgres.
 *
 * Connection convention, copied from
 * `server/routes/requests.approval.integration.test.js`:
 * `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` are taken from the
 * environment when already set, otherwise defaulted to the local test
 * container (localhost:15433, database `tak_team_manager`, user
 * `postgres`). They are assigned BEFORE `../config/database` is first
 * required anywhere in this file's module graph, and restored in
 * `afterAll`.
 *
 * =====================================================================
 * WHAT IS MOCKED, AND WHY
 * =====================================================================
 *
 * - `../middleware/auth`: `authenticateToken` is replaced by an injector
 *   that assigns the module-scoped `mockUser`, per the convention in
 *   `requests.approval.integration.test.js` and
 *   `teams.integration.test.js`. Real JWT/cookie handling is not the
 *   subject.
 * - `../middleware/authorize` is deliberately NOT mocked. The real
 *   Permission_Registry entry and the real `user:team:transfer`
 *   row-scoped resolver run against the real seeded rows, so a scenario
 *   whose actor should get a 403 gets one from the production code path.
 * - `../services/EmailService`: `applyPostCommitEffects` sends the
 *   `team_transfer_completed` notification through a real nodemailer
 *   transport as one of its last steps. There is no reachable SMTP server
 *   here, and outbound email is unrelated to the row states asserted
 *   below.
 * - `../services/userAttributes`: `updateUserAttributes` issues an
 *   outbound Authentik HTTP request. `generateCallsign` is stubbed with a
 *   deterministic value so the post-commit path stays offline and fast;
 *   its derivation is Property 16's subject, in
 *   `TeamTransferService.test.js`, not this file's.
 *
 * Everything else -- `TeamTransferService`, `TeamMembershipService`,
 * `Team`, `EventPublisher`, the route handler -- is the real
 * implementation writing to the real database.
 *
 * =====================================================================
 * THE HARNESS (reused by tasks 9.3-9.10 and 10.8)
 * =====================================================================
 *
 * `teamPlanArb` generates a Team_Transfer SHAPE, not database ids: an
 * Organisation root, a shared spine of some depth, then a source branch
 * and a destination branch forking off the end of that spine. Either
 * branch may have length zero (the Organisation-to-Sub_Team and
 * Sub_Team-to-ancestor moves), never both. Every generated hierarchy
 * stays within `MAX_TEAM_DEPTH`. The plan exposes `parentOf`,
 * `ancestorKeysOf`, `sourceKey`, and `destKey` so a test can compute its
 * expectations by walking the generated parent pointers directly -- the
 * discipline `TeamVisibilityService.test.js`'s Property 9 established.
 *
 * The shared `server/services/__fixtures__/transferArbitraries.js`
 * HIERARCHY generators are deliberately NOT used here: they mint their own
 * fixed ids (Teams 1..N, users 201-203) for tests that mock
 * `Team.getAncestorChain`, whereas every id in this file comes back from a
 * real `RETURNING id` on a serial column. The walking helpers are the same
 * idea, keyed on plan labels instead. Its `callsignSuffixCasePairArb` IS
 * reused (by Property 18) -- that generator mints no ids at all, it
 * produces two strings, so there is nothing for it to conflict with.
 *
 * `seedWorld(scenario, tracker)` turns a generated scenario into real
 * rows -- teams, one Primary_Channel per team, the Transferred_User, the
 * Initiating_Admin, and their memberships (direct row plus the derived
 * `inherited` rows and the derived `channel_memberships` rows, both
 * walked off the plan exactly as `addUserToTeam` would have written them).
 * It returns a `world` holding the real ids and the same walking helpers
 * re-keyed to those ids.
 *
 * `cleanupWorld(tracker)` deletes in FK-safe order, and the order is
 * load-bearing: `audit_logs`, `sync_operations`, and `access_requests` all
 * hold non-cascading foreign keys into `users`, so they MUST go first.
 * (`requests.approval.integration.test.js` deletes `users` without
 * clearing `audit_logs` and hits an FK violation on teardown; this file
 * does not repeat that.) `users` then cascades `team_memberships` and
 * `channel_memberships`, and `teams` cascades `channels`.
 *
 * Because a property test runs its body ~100 times, seeding is per-run
 * and cleanup runs in a `finally`. Every id is ALSO accumulated in a
 * suite-level tracker that `afterAll` sweeps again, so a run that dies
 * between two inserts still leaves nothing behind.
 */

const ORIGINAL_ENV = {
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD
};

process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '15433';
process.env.DB_NAME = process.env.DB_NAME || 'tak_team_manager';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres123';

// Assigned by `actAs()` before each request; read by the mocked
// `authenticateToken` below. `userId` is the LOCAL `users.id`, matching
// what `server/middleware/auth.js` puts on `req.user` in production.
let mockUser = null;

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req, res, next) => {
    req.user = mockUser;
    next();
  },
  requireTeamAdmin: (req, res, next) => next()
}));

jest.mock('../services/EmailService', () => {
  return jest.fn().mockImplementation(() => ({
    sendEmail: jest.fn().mockResolvedValue(true),
    sendApprovalEmail: jest.fn().mockResolvedValue(true),
    sendDenialEmail: jest.fn().mockResolvedValue(true),
    sendVerificationEmail: jest.fn().mockResolvedValue(true)
  }));
});

jest.mock('../services/userAttributes', () => ({
  generateCallsign: jest.fn().mockResolvedValue({
    callsign: 'TEST-Transfer',
    color: '#3B82F6',
    role: 'Team Member'
  }),
  updateUserAttributes: jest.fn().mockResolvedValue(true)
}));

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../config/database');
const usersRouter = require('./users');
const { MAX_TEAM_DEPTH } = require('../config/constants');
// Only the Callsign_Suffix pair generator is taken from the shared fixture
// module (see the note on generators above): it produces two strings that
// are equal case-insensitively, which is exactly Property 18's raw
// material, and mints no ids that could clash with this file's real ones.
const { callsignSuffixCasePairArb } = require('../services/__fixtures__/transferArbitraries');

// ---------------------------------------------------------------------------
// App harness
// ---------------------------------------------------------------------------

/**
 * Mounts the real users router at its production path, so
 * `authorize.js`'s `getRouteKey` produces the real registry key
 * `POST /api/users/:userId/transfer`.
 *
 * @returns {import('express').Express}
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  return app;
}

/**
 * Installs the authenticated identity the next request runs as.
 *
 * @param {{id: number, is_global_manager: boolean, email: string,
 *   first_name: string|null, last_name: string|null}} userRow a real
 *   `users` row as returned by `seedUser`.
 */
function actAs(userRow) {
  mockUser = {
    id: userRow.authentik_user_id,
    userId: userRow.id,
    is_global_manager: !!userRow.is_global_manager,
    email: userRow.email,
    first_name: userRow.first_name,
    last_name: userRow.last_name
  };
}

// ---------------------------------------------------------------------------
// Generated shape: the Team plan
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TeamPlan
 * @property {string[]} teamKeys every Team label, root-first
 * @property {Map<string, string|null>} parentOf generated parent pointers
 * @property {string} sourceKey the Source_Team's label
 * @property {string} destKey the Destination_Team's label
 * @property {(key: string) => string[]} ancestorKeysOf root-first labels
 */

/**
 * Builds the plan for a generated shape. Pure: no database, no randomness.
 *
 * @param {{sharedDepth: number, sourceBranch: number, destBranch: number}} shape
 * @returns {TeamPlan}
 */
function buildTeamPlan({ sharedDepth, sourceBranch, destBranch }) {
  const parentOf = new Map();
  const teamKeys = [];

  const push = (key, parentKey) => {
    parentOf.set(key, parentKey);
    teamKeys.push(key);
  };

  push('org', null);

  let spine = 'org';
  for (let level = 1; level <= sharedDepth; level += 1) {
    const key = `shared${level}`;
    push(key, spine);
    spine = key;
  }

  // Both branches fork off the deepest SHARED Team, so every label on the
  // spine is a common ancestor of both sides -- which is what makes a
  // non-Global_Manager Dual_Admin reachable at all: a user holds at most
  // one Direct_Membership (`idx_team_memberships_one_direct_per_user`), so
  // administering both sides means holding it on a common ancestor.
  const fork = spine;

  let sourceKey = fork;
  for (let level = 1; level <= sourceBranch; level += 1) {
    const key = `source${level}`;
    push(key, sourceKey);
    sourceKey = key;
  }

  let destKey = fork;
  for (let level = 1; level <= destBranch; level += 1) {
    const key = `dest${level}`;
    push(key, destKey);
    destKey = key;
  }

  const ancestorKeysOf = (key) => {
    const chain = [];
    let current = key;
    while (current !== null && current !== undefined) {
      chain.push(current);
      current = parentOf.get(current);
    }
    return chain.reverse(); // root-first, matching getAncestorChain
  };

  return { teamKeys, parentOf, sourceKey, destKey, ancestorKeysOf };
}

/**
 * Generates the hierarchy shape a transfer happens in.
 *
 * A branch length of zero is allowed on ONE side, covering the
 * Organisation-to-Sub_Team move of Requirement 6.7 and its inverse; both
 * being zero would make Source_Team and Destination_Team the same Team,
 * which Requirement 1.5 rejects for a different reason, so it is mapped
 * away rather than filtered (filtering would bias shrinking).
 *
 * @returns {fc.Arbitrary<TeamPlan>}
 */
const teamPlanArb = fc
  .integer({ min: 0, max: 2 })
  .chain((sharedDepth) => {
    const maxBranch = MAX_TEAM_DEPTH - sharedDepth;
    return fc.record({
      sharedDepth: fc.constant(sharedDepth),
      sourceBranch: fc.integer({ min: 0, max: maxBranch }),
      destBranch: fc.integer({ min: 0, max: maxBranch })
    });
  })
  .map((shape) =>
    buildTeamPlan(
      shape.sourceBranch === 0 && shape.destBranch === 0
        ? { ...shape, destBranch: 1 }
        : shape
    )
  );

/**
 * The reference Team_Admin computation (the glossary's Team_Admin, which
 * `Team.isAdmin` implements): a DIRECT `role = 'admin'` row on the Team
 * itself or on any Team in its Ancestor_Chain. Walked off the generated
 * plan, never by calling into `Team.isAdmin`.
 *
 * @param {TeamPlan} plan
 * @param {{teamKey: string, role: string}|null} placement the actor's
 *   single Direct_Membership, or null when they hold none.
 * @param {string} teamKey the side being tested.
 * @returns {boolean}
 */
function referenceIsTeamAdmin(plan, placement, teamKey) {
  if (!placement || placement.role !== 'admin') {
    return false;
  }
  return plan.ancestorKeysOf(teamKey).includes(placement.teamKey);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Accumulates every id a run created, so cleanup needs no queries to
 * discover what to delete.
 *
 * @returns {{teamIds: number[], userIds: number[], mergeInto: (other: object) => void}}
 */
function createTracker() {
  const tracker = {
    teamIds: [],
    userIds: [],
    mergeInto(other) {
      other.teamIds.push(...tracker.teamIds);
      other.userIds.push(...tracker.userIds);
    }
  };
  return tracker;
}

async function seedTeam(tracker, name, parentTeamId) {
  const result = await pool.query(
    // `callsign_prefix` is left NULL throughout: `idx_teams_callsign_prefix`
    // is UNIQUE over non-null values, and no property in this file depends
    // on a prefix (callsign derivation is Property 16's subject).
    `INSERT INTO teams (name, parent_team_id, visibility)
     VALUES ($1, $2, 'public')
     RETURNING id, name, parent_team_id`,
    [name, parentTeamId]
  );
  tracker.teamIds.push(result.rows[0].id);
  return result.rows[0];
}

async function seedPrimaryChannel(teamId, token, authentikGroupId) {
  // Cascaded away with its Team, so it needs no tracker entry.
  const result = await pool.query(
    `INSERT INTO channels (name, display_name, team_id, is_primary, channel_type, authentik_group_id)
     VALUES ($1, $2, $3, true, 'primary', $4)
     RETURNING id, team_id, authentik_group_id`,
    [`transfer-${token}-primary`, `Transfer ${token} Primary`, teamId, authentikGroupId]
  );
  return result.rows[0];
}

async function seedUser(tracker, { isGlobalManager = false } = {}) {
  const token = crypto.randomUUID();
  const result = await pool.query(
    // `authentik_user_id` is deliberately NULL: `applyPostCommitEffects`'s
    // `user_cache` upsert is scoped to `authentik_user_id IS NOT NULL`, so
    // a NULL keeps the shared `user_cache` table untouched by these runs
    // and out of the teardown's way. `callsign_suffix` is NULL so
    // `checkCallsignSuffixUniqueness` no-ops -- suffix collisions are
    // Property 18's subject.
    `INSERT INTO users (username, email, first_name, last_name, is_global_manager)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, authentik_user_id, username, email, first_name, last_name, is_global_manager`,
    [
      `transfer-${token}`,
      `transfer-${token}@example.invalid`,
      'Transfer',
      'Tester',
      isGlobalManager
    ]
  );
  tracker.userIds.push(result.rows[0].id);
  return result.rows[0];
}

/**
 * Writes the membership rows a user in `teamKey` really holds: the single
 * Direct_Membership, one `inherited` row per strict ancestor, and one
 * `channel_memberships` row per ancestor-chain Primary_Channel -- exactly
 * the shape `TeamMembershipService.addUserToTeam` produces, derived here
 * by walking the generated plan rather than by calling that service (so a
 * bug in it cannot make the seeded starting state agree with it).
 *
 * @param {object} world
 * @param {number} userId
 * @param {string} teamKey
 * @param {'member'|'admin'} role
 */
async function seedMembership(world, userId, teamKey, role) {
  const chainKeys = world.plan.ancestorKeysOf(teamKey);

  await pool.query(
    'INSERT INTO team_memberships (user_id, team_id, role) VALUES ($1, $2, $3)',
    [userId, world.teamIdOf(teamKey), role]
  );

  for (const ancestorKey of chainKeys) {
    if (ancestorKey === teamKey) {
      continue;
    }
    await pool.query(
      `INSERT INTO team_memberships (user_id, team_id, role, inherited_from_team_id)
       VALUES ($1, $2, 'inherited', $3)
       ON CONFLICT (user_id, team_id) DO NOTHING`,
      [userId, world.teamIdOf(ancestorKey), world.teamIdOf(teamKey)]
    );
  }

  for (const ancestorKey of chainKeys) {
    await pool.query(
      `INSERT INTO channel_memberships (channel_id, user_id, permission)
       VALUES ($1, $2, 'read_write')
       ON CONFLICT DO NOTHING`,
      [world.channelIdOf(ancestorKey), userId]
    );
  }
}

/**
 * Turns a generated scenario into real database rows.
 *
 * @param {object} scenario as produced by `scenarioArb`
 * @param {object} tracker
 * @returns {Promise<object>} the world: real ids plus plan-keyed helpers
 */
async function seedWorld(scenario, tracker) {
  const { plan } = scenario;
  const token = crypto.randomUUID().slice(0, 8);

  const teamIdByKey = new Map();
  const channelIdByKey = new Map();

  for (const key of plan.teamKeys) {
    const parentKey = plan.parentOf.get(key);
    const team = await seedTeam(
      tracker,
      `Transfer ${token} ${key}`,
      parentKey === null ? null : teamIdByKey.get(parentKey)
    );
    teamIdByKey.set(key, team.id);

    const index = plan.teamKeys.indexOf(key);
    const channel = await seedPrimaryChannel(
      team.id,
      `${token}-${key}`,
      // A null `authentik_group_id` is real (Authentik group creation can
      // lag Team creation) and is what separates the local
      // `channel_memberships` writes from the Sync_Operation enqueues.
      scenario.channelHasGroup[index] ? `grp-${token}-${key}` : null
    );
    channelIdByKey.set(key, channel.id);
  }

  const world = {
    plan,
    token,
    teamIdOf: (key) => teamIdByKey.get(key),
    channelIdOf: (key) => channelIdByKey.get(key),
    sourceTeamId: teamIdByKey.get(plan.sourceKey),
    destinationTeamId: teamIdByKey.get(plan.destKey)
  };

  world.transferredUser = await seedUser(tracker);
  world.actor = await seedUser(tracker, {
    isGlobalManager: scenario.actor.isGlobalManager
  });

  await seedMembership(
    world,
    world.transferredUser.id,
    plan.sourceKey,
    scenario.transferredUserRole
  );

  if (scenario.actor.placement) {
    await seedMembership(
      world,
      world.actor.id,
      scenario.actor.placement.teamKey,
      scenario.actor.placement.role
    );
  }

  return world;
}

/**
 * Deletes everything a run created, in FK-safe order.
 *
 * `audit_logs`, `sync_operations`, and `access_requests` hold
 * NON-cascading foreign keys into `users`, so they must be cleared BEFORE
 * the `users` rows they reference -- deleting `users` first raises
 * `23503`. `users` then cascades `team_memberships` and
 * `channel_memberships`; `teams` cascades `channels` and its own
 * descendants.
 *
 * Idempotent, so the suite-level sweep in `afterAll` can re-run it over
 * ids a per-run cleanup already removed.
 *
 * @param {{teamIds: number[], userIds: number[]}} tracker
 */
async function cleanupWorld(tracker) {
  const { userIds, teamIds } = tracker;

  if (userIds.length > 0) {
    await pool.query(
      `DELETE FROM audit_logs
        WHERE user_id = ANY($1)
           OR (resource_type = 'user' AND resource_id = ANY($1))`,
      [userIds]
    );
    await pool.query(
      'DELETE FROM sync_operations WHERE target_user_id = ANY($1) OR created_by = ANY($1)',
      [userIds]
    );
    await pool.query(
      `DELETE FROM access_requests
        WHERE existing_user_id = ANY($1)
           OR initiated_by = ANY($1)
           OR assigned_to_admin = ANY($1)
           OR processed_by = ANY($1)`,
      [userIds]
    );
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }

  if (teamIds.length > 0) {
    await pool.query('DELETE FROM teams WHERE id = ANY($1)', [teamIds]);
  }
}

// ---------------------------------------------------------------------------
// Observation helpers
// ---------------------------------------------------------------------------

/**
 * Every membership row belonging to the given users, ordered so two
 * snapshots are directly comparable with `toEqual`.
 *
 * @param {number[]} userIds
 * @returns {Promise<{memberships: object[], channelMemberships: object[]}>}
 */
async function snapshotMembershipState(userIds) {
  const memberships = await pool.query(
    `SELECT user_id, team_id, role, inherited_from_team_id
       FROM team_memberships
      WHERE user_id = ANY($1)
      ORDER BY user_id, team_id, role`,
    [userIds]
  );
  const channelMemberships = await pool.query(
    `SELECT user_id, channel_id, permission
       FROM channel_memberships
      WHERE user_id = ANY($1)
      ORDER BY user_id, channel_id`,
    [userIds]
  );

  return { memberships: memberships.rows, channelMemberships: channelMemberships.rows };
}

/**
 * The Transferred_User's Direct_Membership, or null.
 *
 * @param {number} userId
 * @returns {Promise<{team_id: number, role: string}|null>}
 */
async function directMembershipOf(userId) {
  const result = await pool.query(
    `SELECT team_id, role
       FROM team_memberships
      WHERE user_id = $1 AND inherited_from_team_id IS NULL`,
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Every `team_change` Access_Request naming the given user, newest first.
 *
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
async function teamChangeRequestsFor(userId) {
  const result = await pool.query(
    `SELECT *
       FROM access_requests
      WHERE request_type = 'team_change' AND existing_user_id = $1
      ORDER BY id DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Issues the transfer request under test.
 *
 * @param {import('express').Express} app
 * @param {object} world
 * @param {object} [body] merged over `{ targetTeamId: <destination> }`
 * @returns {Promise<import('supertest').Response>}
 */
function postTransfer(app, world, body = {}) {
  actAs(world.actor);
  return request(app)
    .post(`/api/users/${world.transferredUser.id}/transfer`)
    .send({ targetTeamId: world.destinationTeamId, ...body });
}

// ---------------------------------------------------------------------------
// Scenario arbitrary
// ---------------------------------------------------------------------------

/**
 * Generates a whole transfer scenario: the hierarchy shape, the
 * Initiating_Admin's Global_Manager status and single Direct_Membership,
 * the Transferred_User's prior role, and which Teams' Primary_Channels
 * hold an Authentik group.
 *
 * The actor is always AUTHORIZED, which is what Property 9's own statement
 * scopes it to ("held by an authorized Initiating_Admin"). Whether the
 * resolver grants or denies is Property 8's subject
 * (`server/middleware/authorize.test.js`), so generating a denied actor
 * here would put two properties in one test. Authorization is guaranteed
 * structurally rather than by filtering:
 *
 * - a Global_Manager is authorized wherever (if anywhere) their own
 *   membership sits, so their placement is drawn from the whole plan and
 *   includes `null` and `role = 'member'`;
 * - a non-Global_Manager is authorized only through a direct `admin` row
 *   somewhere in one of the two Ancestor_Chains, so their placement is
 *   drawn from exactly that union -- which yields source-only, dest-only,
 *   and (on a shared ancestor) both, the three non-Global_Manager corners
 *   of Requirement 2.4/2.5.
 *
 * The Global_Manager leg is weighted down because it short-circuits the
 * whole branch decision; an even split would spend half the runs never
 * exercising the `Team.isAdmin` legs at all.
 */
const scenarioArb = teamPlanArb.chain((plan) => {
  const sourceChainKeys = plan.ancestorKeysOf(plan.sourceKey);
  const destChainKeys = plan.ancestorKeysOf(plan.destKey);
  const eitherChainKeys = [...new Set([...sourceChainKeys, ...destChainKeys])];

  const globalManagerActorArb = fc.record({
    isGlobalManager: fc.constant(true),
    placement: fc.option(
      fc.record({
        teamKey: fc.constantFrom(...plan.teamKeys),
        role: fc.constantFrom('admin', 'member')
      }),
      { nil: null }
    )
  });

  const teamAdminActorArb = fc.record({
    isGlobalManager: fc.constant(false),
    placement: fc.record({
      teamKey: fc.constantFrom(...eitherChainKeys),
      role: fc.constant('admin')
    })
  });

  return fc.record({
    plan: fc.constant(plan),
    actor: fc.oneof(
      { arbitrary: teamAdminActorArb, weight: 4 },
      { arbitrary: globalManagerActorArb, weight: 1 }
    ),
    // Requirements 10.2/10.3's two cases; `inherited` is never a
    // Direct_Membership role.
    transferredUserRole: fc.constantFrom('member', 'admin'),
    channelHasGroup: fc.array(fc.boolean(), {
      minLength: plan.teamKeys.length,
      maxLength: plan.teamKeys.length
    }),
    justification: fc.oneof(
      { arbitrary: fc.constant(null), weight: 1 },
      { arbitrary: fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,40}$/), weight: 2 }
    )
  });
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('POST /api/users/:userId/transfer against a real Postgres database', () => {
  const suiteTracker = createTracker();
  let app;

  beforeAll(async () => {
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      throw new Error(
        'Real Postgres test database is not reachable at ' +
          `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} ` +
          `(user "${process.env.DB_USER}"). This integration test requires a real, ` +
          'running, already-migrated Postgres instance -- it deliberately does not mock ' +
          '"../config/database", because the branch this route takes is decided by ' +
          'recursive-CTE walks over real teams/team_memberships rows. ' +
          `Underlying error: ${error.message}`,
        { cause: error }
      );
    }

    app = buildApp();
  });

  afterAll(async () => {
    // Safety net for a run that failed between two inserts, before its own
    // `finally` could clean up. Same FK-safe order.
    await cleanupWorld(suiteTracker);

    await pool.end();

    process.env.DB_HOST = ORIGINAL_ENV.DB_HOST;
    process.env.DB_PORT = ORIGINAL_ENV.DB_PORT;
    process.env.DB_NAME = ORIGINAL_ENV.DB_NAME;
    process.env.DB_USER = ORIGINAL_ENV.DB_USER;
    process.env.DB_PASSWORD = ORIGINAL_ENV.DB_PASSWORD;
  });

  // Feature: team-member-transfer, Property 9: Admin status on both sides selects the branch
  //
  // Validates: Requirements 2.4, 2.5
  // Also the Requirement 17.2 assertion: a Dual_Admin transfer inserts no
  // `access_requests` row, and a single-side transfer inserts one with
  // `request_type` of `team_change` and a populated `approval_team_id`.
  test.prop([scenarioArb], { numRuns: 100 })(
    'executes immediately with no access_requests row when the Initiating_Admin is a Global_Manager or a Team_Admin of both sides, and otherwise creates exactly one Transfer_Request while leaving every team_memberships and channel_memberships row unchanged',
    async (scenario) => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(scenario, tracker);

        // Reference computation: Requirement 2.4's Dual_Admin predicate,
        // walked straight off the generated plan and the generated
        // placement. Never `Team.isAdmin`, which is the code under test
        // here (via the route's step 8).
        const adminsSource = referenceIsTeamAdmin(
          scenario.plan,
          scenario.actor.placement,
          scenario.plan.sourceKey
        );
        const adminsDestination = referenceIsTeamAdmin(
          scenario.plan,
          scenario.actor.placement,
          scenario.plan.destKey
        );
        const expectedDualAdmin =
          scenario.actor.isGlobalManager || (adminsSource && adminsDestination);

        const observedUserIds = [world.transferredUser.id, world.actor.id];
        const before = await snapshotMembershipState(observedUserIds);

        const res = await postTransfer(app, world, {
          justification: scenario.justification ?? undefined
        });

        const requests = await teamChangeRequestsFor(world.transferredUser.id);

        if (expectedDualAdmin) {
          // Requirement 2.4: immediate execution, status 200, `completed`,
          // and NO Access_Request row at all.
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('completed');
          expect(res.body.demotedFromAdmin).toBe(scenario.transferredUserRole === 'admin');
          expect(requests).toHaveLength(0);

          // "Executes immediately" is observable as the moved
          // Direct_Membership. Its full end-state shape (inherited rows,
          // channel rows, Sync_Operations) is Properties 2, 3, 4, and 27.
          const direct = await directMembershipOf(world.transferredUser.id);
          expect(direct).not.toBeNull();
          expect(direct.team_id).toBe(world.destinationTeamId);
        } else {
          // Requirement 2.5: exactly one Transfer_Request, status 202,
          // `pending_approval`, a populated `requestId`, and not one
          // membership row touched.
          expect(res.status).toBe(202);
          expect(res.body.status).toBe('pending_approval');
          expect(Number.isInteger(res.body.requestId)).toBe(true);
          expect(res.body.demotedFromAdmin).toBe(scenario.transferredUserRole === 'admin');

          expect(requests).toHaveLength(1);
          expect(requests[0].id).toBe(res.body.requestId);
          expect(requests[0].request_type).toBe('team_change');
          expect(requests[0].status).toBe('pending');
          // Requirement 17.2's second half: the Approval_Team is recorded,
          // never left null. WHICH side it names is Property 11.
          expect(requests[0].approval_team_id).not.toBeNull();

          const after = await snapshotMembershipState(observedUserIds);
          expect(after).toEqual(before);
        }
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    600000
  );

  // -------------------------------------------------------------------
  // Property 10 (task 9.3)
  // -------------------------------------------------------------------

  /**
   * Property 10 is about the row the route WRITES, so it only has a
   * subject on the 202 branch -- the Dual_Admin branch of Requirement 2.4
   * inserts no `access_requests` row at all. The scenario arbitrary is
   * therefore narrowed to a non-Global_Manager who administers exactly one
   * side, structurally rather than by filtering:
   *
   * Both branches of `teamPlanArb` fork off the deepest SHARED Team, so a
   * direct `admin` row anywhere on the spine administers both sides. The
   * placements that administer exactly one side are exactly the labels in
   * one Ancestor_Chain and not the other -- the symmetric difference of
   * the two chains, which is non-empty because `teamPlanArb` never makes
   * both branch lengths zero.
   */
  const pendingBranchScenarioArb = teamPlanArb.chain((plan) => {
    const sourceChainKeys = plan.ancestorKeysOf(plan.sourceKey);
    const destChainKeys = plan.ancestorKeysOf(plan.destKey);
    const exclusiveKeys = [
      ...sourceChainKeys.filter((key) => !destChainKeys.includes(key)),
      ...destChainKeys.filter((key) => !sourceChainKeys.includes(key))
    ];

    // A submitted value, an empty string, and an omitted key are the three
    // reachable shapes of "the submitted `justification`/`callsignSuffix`
    // value or `NULL` when that value is absent" (Requirements 3.1, 3.8).
    // Generated values carry no leading or trailing whitespace, because
    // the route's validators `.trim()` the body in place: a generator that
    // produced ' x ' would be asserting the trim, which belongs to
    // Property 26's bounds rather than here.
    const optionalTextArb = (pattern) =>
      fc.oneof(
        { arbitrary: fc.constant(null), weight: 1 },
        { arbitrary: fc.constant(''), weight: 1 },
        { arbitrary: fc.stringMatching(pattern), weight: 3 }
      );

    return fc.record({
      plan: fc.constant(plan),
      actor: fc.record({
        isGlobalManager: fc.constant(false),
        placement: fc.record({
          teamKey: fc.constantFrom(...exclusiveKeys),
          role: fc.constant('admin')
        })
      }),
      transferredUserRole: fc.constantFrom('member', 'admin'),
      channelHasGroup: fc.array(fc.boolean(), {
        minLength: plan.teamKeys.length,
        maxLength: plan.teamKeys.length
      }),
      justification: optionalTextArb(/^[A-Za-z][A-Za-z ]{0,38}[A-Za-z]$/),
      // Mixed case and digits are generated; case-insensitive COLLISION
      // handling is Property 18's subject, and this branch never reaches
      // the uniqueness check because it executes no transfer.
      callsignSuffix: optionalTextArb(/^[A-Za-z0-9][A-Za-z0-9-]{0,10}[A-Za-z0-9]$/),
      // `seedUser` gives every user the same hardcoded 'Transfer Tester'
      // name, which would make Requirement 3.4 unfalsifiable: an
      // implementation that copied the Transferred_User's name into
      // `requester_first_name` would still match. These two disjoint
      // prefixes make the two identities distinguishable in every run.
      identity: fc.record({
        actorFirstName: fc.stringMatching(/^[A-Za-z]{1,8}$/).map((s) => `Initiator${s}`),
        actorLastName: fc.stringMatching(/^[A-Za-z]{1,8}$/).map((s) => `Acting${s}`),
        movedFirstName: fc.stringMatching(/^[A-Za-z]{1,8}$/).map((s) => `Moved${s}`),
        movedLastName: fc.stringMatching(/^[A-Za-z]{1,8}$/).map((s) => `Member${s}`)
      })
    });
  });

  /**
   * Overwrites a seeded user's name, returning the row as the database now
   * holds it. Used to give the Initiating_Admin and the Transferred_User
   * distinguishable identities (see `identity` above).
   *
   * @param {number} userId
   * @param {string} firstName
   * @param {string} lastName
   * @returns {Promise<{email: string, first_name: string, last_name: string}>}
   */
  async function renameSeededUser(userId, firstName, lastName) {
    const result = await pool.query(
      `UPDATE users SET first_name = $2, last_name = $3
        WHERE id = $1
        RETURNING id, email, first_name, last_name`,
      [userId, firstName, lastName]
    );
    return result.rows[0];
  }

  // Feature: team-member-transfer, Property 10: Transfer_Request columns round-trip the submitted values
  //
  // Validates: Requirements 3.1, 3.4, 3.5, 3.8
  test.prop([pendingBranchScenarioArb], { numRuns: 100 })(
    'records the transfer it was asked for in every column of the created access_requests row: the Transferred_User, both Teams, team_change, pending, the submitted justification and callsignSuffix or NULL, the Initiating_Admin as initiated_by and as the requester identity, and email_verified true',
    async (scenario) => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(scenario, tracker);

        // Requirement 3.4 names the INITIATING ADMIN's own values, so the
        // expectation is read back from the `users` rows as written here,
        // never from the response body or the created request row.
        const initiator = await renameSeededUser(
          world.actor.id,
          scenario.identity.actorFirstName,
          scenario.identity.actorLastName
        );
        const movedUser = await renameSeededUser(
          world.transferredUser.id,
          scenario.identity.movedFirstName,
          scenario.identity.movedLastName
        );

        // `req.user` deliberately keeps `seedUser`'s original name values
        // (`actAs` copies them off `world.actor`, which is not re-read
        // here), so an implementation sourcing `requester_first_name` from
        // the session instead of the `users` row fails the assertions
        // below rather than passing by coincidence.
        const res = await postTransfer(app, world, {
          justification: scenario.justification ?? undefined,
          callsignSuffix: scenario.callsignSuffix ?? undefined
        });

        expect(res.status).toBe(202);
        expect(res.body.status).toBe('pending_approval');

        const requests = await teamChangeRequestsFor(world.transferredUser.id);
        expect(requests).toHaveLength(1);

        const row = requests[0];
        expect(row.id).toBe(res.body.requestId);

        // Requirement 3.1: the five identifying columns plus the
        // justification. Both Team ids come from the seeded rows'
        // `RETURNING id`, and the Source_Team is the one the generated
        // plan placed the Direct_Membership in -- neither is read back
        // from the route.
        expect(row.request_type).toBe('team_change');
        expect(row.existing_user_id).toBe(world.transferredUser.id);
        expect(row.current_team_id).toBe(world.sourceTeamId);
        expect(row.target_team_id).toBe(world.destinationTeamId);
        expect(row.status).toBe('pending');

        // An omitted key and an empty string are both "absent" and both
        // land as SQL NULL; anything else round-trips byte for byte.
        const expectedJustification = scenario.justification || null;
        expect(row.justification).toBe(expectedJustification);

        // Requirement 3.8: the same absent/present rule for the submitted
        // Callsign_Suffix, carried on the row for the approval path to
        // consume later as link (b) of Requirement 9.7's precedence chain.
        const expectedCallsignSuffix = scenario.callsignSuffix || null;
        expect(row.callsign_suffix).toBe(expectedCallsignSuffix);

        // Requirement 3.3's `initiated_by` half: the Initiating_Admin's
        // local `users.id`. (WHICH side `approval_team_id` names is
        // Property 11, and `assigned_to_admin` is Property 12.)
        expect(row.initiated_by).toBe(world.actor.id);

        // Requirement 3.4: the requester identity is the Initiating_Admin's
        // own, which is what makes the approval and denial emails
        // `RequestApprovalService` already sends reach the person who asked
        // for the transfer with no change to either email path.
        expect(row.requester_email).toBe(initiator.email);
        expect(row.requester_first_name).toBe(initiator.first_name);
        expect(row.requester_last_name).toBe(initiator.last_name);

        // ... and specifically NOT the Transferred_User's, the plausible
        // wrong reading of "requester" for a row somebody else's account is
        // the subject of.
        expect(row.requester_email).not.toBe(movedUser.email);
        expect(row.requester_first_name).not.toBe(movedUser.first_name);
        expect(row.requester_last_name).not.toBe(movedUser.last_name);

        // Requirement 3.5: verified by construction from the authenticated
        // session. The row must carry `true` or
        // `GET /api/requests/pending`, which filters on this column, would
        // never show the Approval_Team the request.
        expect(row.email_verified).toBe(true);
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    600000
  );

  // -------------------------------------------------------------------
  // Property 11 (task 9.4)
  // -------------------------------------------------------------------

  /**
   * Like Property 10, this property only has a subject on the 202 branch --
   * there is no `approval_team_id` to inspect when the Dual_Admin branch
   * executes the transfer immediately -- so it reuses
   * `pendingBranchScenarioArb`, whose actor is a non-Global_Manager holding
   * a direct `admin` row on a label in exactly one of the two
   * Ancestor_Chains. That is precisely the input space Requirement 3.3
   * speaks about, and it covers both directions of the biconditional:
   * placements exclusive to the destination chain and placements exclusive
   * to the source chain are both generated, at every shared-spine depth
   * `teamPlanArb` produces.
   *
   * The `identity` and `callsignSuffix` legs of that arbitrary do no work
   * here; they cost one extra UPDATE-free run each and keep a single
   * generator serving both properties, which is the trade the harness note
   * at the top of the file asks for.
   */

  // Feature: team-member-transfer, Property 11: The Approval_Team is always the side the initiator does not administer
  //
  // Validates: Requirements 3.3
  test.prop([pendingBranchScenarioArb], { numRuns: 100 })(
    'records as approval_team_id the side the Initiating_Admin does not administer -- the Source_Team when they administer the Destination_Team, the Destination_Team when they administer the Source_Team -- and returns that same Team as approvalTeamId/approvalTeamName',
    async (scenario) => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(scenario, tracker);

        // Reference computation: which side the initiator administers,
        // walked off the generated plan and the generated placement. Never
        // `Team.isAdmin`, which is what the route consults to make the same
        // decision.
        const adminsSource = referenceIsTeamAdmin(
          scenario.plan,
          scenario.actor.placement,
          scenario.plan.sourceKey
        );
        const adminsDestination = referenceIsTeamAdmin(
          scenario.plan,
          scenario.actor.placement,
          scenario.plan.destKey
        );

        // `pendingBranchScenarioArb`'s structural guarantee, asserted rather
        // than assumed: exactly one side is administered. Requirement 3.3 is
        // only defined over that case, and a generator change that silently
        // admitted a Dual_Admin or an unauthorized actor would otherwise
        // make the biconditional below vacuous instead of failing here.
        expect(adminsSource).toBe(!adminsDestination);

        // Requirement 3.3, evaluated on the generated data: the OTHER side.
        const expectedApprovalTeamId = adminsDestination
          ? world.sourceTeamId
          : world.destinationTeamId;
        // Read off the seeded `teams` row for the id the plan predicts, not
        // off the response, so `approvalTeamName` is checked against the
        // Team the property says it should name rather than against
        // whichever Team the route happened to pick.
        const expectedApprovalTeamName = (
          await pool.query('SELECT name FROM teams WHERE id = $1', [expectedApprovalTeamId])
        ).rows[0].name;

        const res = await postTransfer(app, world, {
          justification: scenario.justification ?? undefined,
          callsignSuffix: scenario.callsignSuffix ?? undefined
        });

        expect(res.status).toBe(202);
        expect(res.body.status).toBe('pending_approval');

        const requests = await teamChangeRequestsFor(world.transferredUser.id);
        expect(requests).toHaveLength(1);
        const row = requests[0];

        expect(row.approval_team_id).toBe(expectedApprovalTeamId);

        // The same statement as a biconditional in each direction, which is
        // what rules out the two implementations that would satisfy a
        // one-directional assertion by accident: always recording the
        // Source_Team, and always recording the Destination_Team.
        expect(row.approval_team_id === world.sourceTeamId).toBe(adminsDestination);
        expect(row.approval_team_id === world.destinationTeamId).toBe(adminsSource);

        // The Approval_Team the Client is told about is the Approval_Team
        // that will actually gate the request under Requirements 4.2 and
        // 5.2, which both read the persisted column.
        expect(res.body.approvalTeamId).toBe(row.approval_team_id);
        expect(res.body.approvalTeamName).toBe(expectedApprovalTeamName);
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    600000
  );

  // -------------------------------------------------------------------
  // Property 12 (task 9.5)
  // -------------------------------------------------------------------

  /**
   * Requirement 3.6's eligibility rule is deliberately NARROWER than the
   * glossary's Team_Admin: the assigned admin must hold a DIRECT
   * (`inherited_from_team_id IS NULL`) `team_memberships` row with `role`
   * of `admin` for the Approval_Team ITSELF. A direct `admin` row on an
   * ANCESTOR of the Approval_Team makes its holder a Team_Admin of the
   * Approval_Team (that is what gates approval under Requirement 5.2) and
   * still does NOT make them eligible here. The two readings only diverge
   * when such an ancestor admin exists, so this arbitrary seeds them
   * deliberately rather than hoping one turns up.
   *
   * Like Properties 10 and 11 this only has a subject on the 202 branch --
   * the Dual_Admin branch writes no `access_requests` row -- so it builds
   * on `pendingBranchScenarioArb`, whose actor is a non-Global_Manager
   * administering exactly one side. The Approval_Team is therefore
   * derivable from the plan alone (Requirement 3.3: the other side), which
   * is what lets the extra principals below be placed relative to it
   * before anything is seeded.
   *
   * `extraPrincipals` are additional users, each with one Direct_Membership:
   *
   * - `admin_on_approval`   eligible, and the only eligible kind;
   * - `member_on_approval`  a direct row on the right Team with the wrong
   *                         role;
   * - `admin_on_ancestor`   a Team_Admin of the Approval_Team who is not
   *                         eligible (generated only when the
   *                         Approval_Team has a strict ancestor);
   * - `admin_on_descendant` places an `inherited` row on the Approval_Team
   *                         for that user, the reachable shape of "not an
   *                         inherited row" (generated only when the
   *                         Approval_Team has a descendant).
   *
   * An array length of zero is generated, and no kind is guaranteed, so
   * both directions of Requirement 3.6 are reached: a populated
   * `assigned_to_admin` and the `NULL` for an Approval_Team with no direct
   * admin row of its own.
   *
   * No principal is given `role = 'admin'` together with a non-null
   * `inherited_from_team_id`. That row is insertable -- there is no CHECK
   * on `team_memberships.role` -- but nothing writes it: the glossary
   * reserves `inherited` for inherited rows, and `SELECT DISTINCT role`
   * returns only `admin`, `inherited`, and `member`. Generating it would
   * assert on unreachable input.
   */
  const assignedAdminScenarioArb = pendingBranchScenarioArb.chain((base) => {
    const { plan } = base;

    // Requirement 3.3's rule, walked off the generated plan: the
    // Approval_Team is the side the initiator does not administer.
    const approvalKey = referenceIsTeamAdmin(plan, base.actor.placement, plan.destKey)
      ? plan.sourceKey
      : plan.destKey;

    const ancestorKeys = plan.ancestorKeysOf(approvalKey).filter((key) => key !== approvalKey);
    const descendantKeys = plan.teamKeys.filter(
      (key) => key !== approvalKey && plan.ancestorKeysOf(key).includes(approvalKey)
    );

    const kindArb = fc.oneof(
      { arbitrary: fc.constant('admin_on_approval'), weight: 3 },
      { arbitrary: fc.constant('member_on_approval'), weight: 2 },
      ...(ancestorKeys.length > 0
        ? [{ arbitrary: fc.constant('admin_on_ancestor'), weight: 3 }]
        : []),
      ...(descendantKeys.length > 0
        ? [{ arbitrary: fc.constant('admin_on_descendant'), weight: 1 }]
        : [])
    );

    return fc.record({
      base: fc.constant(base),
      approvalKey: fc.constant(approvalKey),
      extraPrincipals: fc.array(
        fc.record({ kind: kindArb, offset: fc.nat({ max: 8 }) }),
        { minLength: 0, maxLength: 3 }
      )
    });
  });

  /**
   * Seeds one generated extra principal and reports the Direct_Membership
   * it was given, so the caller can decide eligibility by walking that
   * record rather than by querying the database the route queries.
   *
   * @param {object} world as returned by `seedWorld`
   * @param {object} tracker
   * @param {string} approvalKey the Approval_Team's plan label
   * @param {{kind: string, offset: number}} spec
   * @returns {Promise<{userId: number, directTeamKey: string, directRole: string}>}
   */
  async function seedExtraPrincipal(world, tracker, approvalKey, spec) {
    const { plan } = world;
    const ancestorKeys = plan.ancestorKeysOf(approvalKey).filter((key) => key !== approvalKey);
    const descendantKeys = plan.teamKeys.filter(
      (key) => key !== approvalKey && plan.ancestorKeysOf(key).includes(approvalKey)
    );

    let directTeamKey = approvalKey;
    let directRole = 'admin';

    if (spec.kind === 'member_on_approval') {
      directRole = 'member';
    } else if (spec.kind === 'admin_on_ancestor') {
      directTeamKey = ancestorKeys[spec.offset % ancestorKeys.length];
    } else if (spec.kind === 'admin_on_descendant') {
      directTeamKey = descendantKeys[spec.offset % descendantKeys.length];
    }

    const user = await seedUser(tracker);
    await seedMembership(world, user.id, directTeamKey, directRole);

    return { userId: user.id, directTeamKey, directRole };
  }

  // Feature: team-member-transfer, Property 12: assigned_to_admin names an eligible Approval_Team admin, or nothing
  //
  // Validates: Requirements 3.6
  test.prop([assignedAdminScenarioArb], { numRuns: 100 })(
    'sets assigned_to_admin to a user holding a direct admin row for the Approval_Team itself, and to NULL exactly when the Approval_Team has no such row -- never to an admin of one of its ancestors and never to a holder of a non-admin or inherited row',
    async (scenario) => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(scenario.base, tracker);

        // Every principal that ends up with a Direct_Membership on one of
        // the freshly created Teams, paired with that membership. The
        // Teams are created by this run, so no row outside this list can
        // reference them -- which is what makes the reference set below
        // complete without querying `team_memberships`.
        const principals = [
          {
            userId: world.transferredUser.id,
            directTeamKey: scenario.base.plan.sourceKey,
            directRole: scenario.base.transferredUserRole
          },
          {
            userId: world.actor.id,
            directTeamKey: scenario.base.actor.placement.teamKey,
            directRole: scenario.base.actor.placement.role
          }
        ];

        for (const spec of scenario.extraPrincipals) {
          principals.push(await seedExtraPrincipal(world, tracker, scenario.approvalKey, spec));
        }

        // Requirement 3.6, evaluated on the generated placements: a direct
        // `admin` row for the Approval_Team itself. The Transferred_User is
        // in scope here and not a special case -- when the Approval_Team is
        // the Source_Team and their prior role is `admin`, they are the
        // Approval_Team's own direct admin.
        const eligibleIds = principals
          .filter(
            (principal) =>
              principal.directTeamKey === scenario.approvalKey && principal.directRole === 'admin'
          )
          .map((principal) => principal.userId);
        const ineligibleIds = principals
          .filter((principal) => !eligibleIds.includes(principal.userId))
          .map((principal) => principal.userId);

        const res = await postTransfer(app, world, {
          justification: scenario.base.justification ?? undefined,
          callsignSuffix: scenario.base.callsignSuffix ?? undefined
        });

        expect(res.status).toBe(202);
        expect(res.body.status).toBe('pending_approval');

        const requests = await teamChangeRequestsFor(world.transferredUser.id);
        expect(requests).toHaveLength(1);
        const row = requests[0];

        // The reference frame this property is computed in. WHICH side the
        // Approval_Team is is Property 11's subject; asserted here so a
        // divergence surfaces as a frame mismatch rather than as an
        // inexplicable `assigned_to_admin` failure.
        expect(row.approval_team_id).toBe(world.teamIdOf(scenario.approvalKey));

        if (eligibleIds.length === 0) {
          // Requirement 3.6's second half. NULL is the specified outcome,
          // not an error: the row is still created, still visible to the
          // Approval_Team under Requirement 4.2, and still approvable under
          // Requirement 5.2, all of which read `approval_team_id` rather
          // than this column.
          expect(row.assigned_to_admin).toBeNull();
        } else {
          // Requirement 3.6 says "one user" holding such a row, so any
          // member of the eligible set satisfies it; which one is chosen is
          // not specified and is deliberately not asserted.
          expect(eligibleIds).toContain(row.assigned_to_admin);
        }

        // The same statement from the other side, and the reason the
        // distractor kinds are generated at all: an ancestor admin, a
        // direct `member`, and a holder of an `inherited` row on the
        // Approval_Team are each rejected, so an implementation reading
        // Requirement 3.6 as the glossary's Team_Admin, or dropping the
        // role or the directness predicate, fails here.
        expect(ineligibleIds).not.toContain(row.assigned_to_admin);
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    600000
  );

  // -------------------------------------------------------------------
  // Property 13 (task 9.6)
  // -------------------------------------------------------------------

  /**
   * Requirement 3.7 is the one rule in this file that must hold on BOTH
   * branches of Requirement 2.4/2.5: "regardless of whether the
   * Initiating_Admin is a Dual_Admin". The route's step 7 sits ABOVE the
   * Dual_Admin branch of step 8 precisely so the 409 is reachable for
   * every kind of authorized actor, and that placement is what this
   * property pins down -- an implementation that checked for a pending row
   * only on the request-creating path would pass Properties 10-12 and fail
   * here on the `global_manager` and `dual_admin` legs.
   *
   * The pending row is created by a REAL first attempt rather than by a
   * direct INSERT, so the row the later attempts collide with is exactly
   * the row the route writes. That first attempt therefore has to take the
   * 202 branch, which is what `pendingBranchScenarioArb` (a
   * non-Global_Manager administering exactly one side) already guarantees.
   *
   * The later attempts' actor kinds are generated, one fresh user each,
   * placed structurally so each kind is authorized and is genuinely of
   * that kind:
   *
   * - `global_manager`     authorized by the resolver's first leg, with no
   *                        membership at all -- the corner where step 8
   *                        would skip both `Team.isAdmin` calls and go
   *                        straight to immediate execution;
   * - `dual_admin`         a direct `admin` row on a label in BOTH
   *                        Ancestor_Chains. Both of `teamPlanArb`'s
   *                        branches fork off the deepest shared Team, so
   *                        the intersection of the two chains is the spine
   *                        and is never empty (it always holds `org`);
   * - `single_side_admin`  a direct `admin` row on a label in exactly one
   *                        chain -- the symmetric difference, non-empty
   *                        because `teamPlanArb` never makes both branch
   *                        lengths zero.
   *
   * One to two later attempts are generated, which is the "any sequence of
   * transfer attempts" half of the property: the pending row keeps
   * blocking, it is not consumed by the first rejection.
   *
   * The unique partial index `idx_access_requests_one_pending_team_change_per_user`
   * is the database backstop for the same rule and the route maps a `23505`
   * on it to the identical 409, so the two mechanisms are indistinguishable
   * from here. This property observes the guarantee, not which mechanism
   * produced it; the index is what closes the pre-flight `SELECT`'s race
   * window under genuine concurrency, which is task 10.10's subject.
   */
  const laterAttemptScenarioArb = pendingBranchScenarioArb.chain((base) => {
    const { plan } = base;
    const sourceChainKeys = plan.ancestorKeysOf(plan.sourceKey);
    const destChainKeys = plan.ancestorKeysOf(plan.destKey);
    const sharedKeys = sourceChainKeys.filter((key) => destChainKeys.includes(key));
    const exclusiveKeys = [
      ...sourceChainKeys.filter((key) => !destChainKeys.includes(key)),
      ...destChainKeys.filter((key) => !sourceChainKeys.includes(key))
    ];

    const laterActorArb = fc.oneof(
      fc.record({
        kind: fc.constant('global_manager'),
        isGlobalManager: fc.constant(true),
        placement: fc.constant(null),
        justification: fc.option(fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}$/), { nil: null })
      }),
      fc.record({
        kind: fc.constant('dual_admin'),
        isGlobalManager: fc.constant(false),
        placement: fc.record({
          teamKey: fc.constantFrom(...sharedKeys),
          role: fc.constant('admin')
        }),
        justification: fc.option(fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}$/), { nil: null })
      }),
      fc.record({
        kind: fc.constant('single_side_admin'),
        isGlobalManager: fc.constant(false),
        placement: fc.record({
          teamKey: fc.constantFrom(...exclusiveKeys),
          role: fc.constant('admin')
        }),
        justification: fc.option(fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}$/), { nil: null })
      })
    );

    return fc.record({
      base: fc.constant(base),
      laterAttempts: fc.array(laterActorArb, { minLength: 1, maxLength: 2 })
    });
  });

  // Feature: team-member-transfer, Property 13: At most one pending Transfer_Request exists per user
  //
  // Validates: Requirements 3.7
  test.prop([laterAttemptScenarioArb], { numRuns: 100 })(
    'rejects every transfer attempt made while a pending Transfer_Request exists for the user with status 409 -- whether the later attempt comes from a Global_Manager, a Team_Admin of both sides, or a Team_Admin of one side -- inserting no second row, leaving the pending row byte-for-byte as it was, and changing no membership',
    async (scenario) => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(scenario.base, tracker);

        // The pending row under test, created by the route itself on the
        // 202 branch (Requirement 2.5). Asserted rather than assumed: if
        // this attempt executed immediately there would be no pending row
        // for the later attempts to collide with, and every 409 below would
        // be vacuous.
        const firstRes = await postTransfer(app, world, {
          justification: scenario.base.justification ?? undefined,
          callsignSuffix: scenario.base.callsignSuffix ?? undefined
        });
        expect(firstRes.status).toBe(202);
        expect(firstRes.body.status).toBe('pending_approval');

        const createdRequests = await teamChangeRequestsFor(world.transferredUser.id);
        expect(createdRequests).toHaveLength(1);
        const pendingRowBefore = createdRequests[0];
        expect(pendingRowBefore.status).toBe('pending');

        // Every later actor is seeded BEFORE the first snapshot, so their own
        // membership rows are inside the compared state and a later attempt
        // that touched them (rather than the Transferred_User) would still be
        // caught.
        const laterActors = [];
        for (const attempt of scenario.laterAttempts) {
          const userRow = await seedUser(tracker, {
            isGlobalManager: attempt.isGlobalManager
          });
          if (attempt.placement) {
            await seedMembership(world, userRow.id, attempt.placement.teamKey, attempt.placement.role);
          }
          laterActors.push({ attempt, userRow });
        }

        const observedUserIds = [
          world.transferredUser.id,
          world.actor.id,
          ...laterActors.map((later) => later.userRow.id)
        ];
        const before = await snapshotMembershipState(observedUserIds);

        for (const { attempt, userRow } of laterActors) {
          // Reference computation: the actor kind, walked off the generated
          // plan and the generated placement rather than off `Team.isAdmin`,
          // which is what the route's step 8 would consult if step 7 let it
          // through. This is the frame the property is stated in -- a
          // generator change that turned the `dual_admin` leg into a
          // single-side admin would make the branch-independence claim
          // untested, so it fails here instead.
          const adminsSource = referenceIsTeamAdmin(
            scenario.base.plan,
            attempt.placement,
            scenario.base.plan.sourceKey
          );
          const adminsDestination = referenceIsTeamAdmin(
            scenario.base.plan,
            attempt.placement,
            scenario.base.plan.destKey
          );

          if (attempt.kind === 'global_manager') {
            expect(userRow.is_global_manager).toBe(true);
          } else if (attempt.kind === 'dual_admin') {
            // The branch that WOULD have executed immediately (Requirement
            // 2.4) had step 7 not fired first.
            expect(userRow.is_global_manager).toBe(false);
            expect(adminsSource && adminsDestination).toBe(true);
          } else {
            expect(userRow.is_global_manager).toBe(false);
            expect(adminsSource).toBe(!adminsDestination);
          }

          const res = await postTransfer(
            app,
            { ...world, actor: userRow },
            { justification: attempt.justification ?? undefined }
          );

          // Requirement 3.7: 409, on every actor kind alike. A 403 here
          // would mean the actor was not authorized and the attempt never
          // reached step 7; a 200 or 202 would mean the rule was bypassed.
          expect(res.status).toBe(409);
          expect(res.body.error).toMatch(/pending/i);

          // No additional row of ANY status: `teamChangeRequestsFor` filters
          // only on `request_type` and `existing_user_id`, so a second row --
          // including one written with a `superseded`-style status -- would
          // show up in this count.
          const requestsAfter = await teamChangeRequestsFor(world.transferredUser.id);
          expect(requestsAfter).toHaveLength(1);

          // "Left exactly as it was", column for column: the pending row is
          // blocking rather than superseded, so `status`, `processed_by`,
          // `processed_at`, `denial_reason` and everything else must be
          // untouched. There is no disposition a rejected attempt may write.
          expect(requestsAfter[0]).toEqual(pendingRowBefore);
          expect(requestsAfter[0].status).toBe('pending');

          // No Team_Transfer performed: the whole membership and channel
          // state of every principal involved is unchanged, and the
          // Transferred_User's Direct_Membership still names the Source_Team.
          const after = await snapshotMembershipState(observedUserIds);
          expect(after).toEqual(before);

          const direct = await directMembershipOf(world.transferredUser.id);
          expect(direct).not.toBeNull();
          expect(direct.team_id).toBe(world.sourceTeamId);
        }
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    600000
  );

  // -------------------------------------------------------------------
  // Property 18 (task 9.7)
  // -------------------------------------------------------------------

  /**
   * Requirement 9.1's collision check lives inside
   * `TeamMembershipService.addUserToTeam`
   * (`checkCallsignSuffixUniqueness`), which only runs when a transfer is
   * actually EXECUTED. So unlike Properties 10-13 this property has a
   * subject on the IMMEDIATE branch only -- the 202 branch writes an
   * `access_requests` row and never touches the check -- and the actor is
   * therefore constrained to the two kinds Requirement 2.4 admits:
   *
   * - a Global_Manager, with no membership at all;
   * - a Dual_Admin: a direct `admin` row on a label in BOTH
   *   Ancestor_Chains. Both of `teamPlanArb`'s branches fork off the
   *   deepest shared Team, so the intersection of the two chains is the
   *   spine and always holds at least `org`.
   *
   * The suffix holder is a fresh user given a real, committed
   * `users.callsign_suffix` and one Direct_Membership. WHERE that
   * membership sits is generated, because the check is scoped to the
   * Destination_Team's Member_List and `Team.getFullMemberList(destination)`
   * is every `team_memberships` row ON the Destination_Team -- direct rows
   * on the Destination_Team itself plus the `inherited` rows written for
   * users whose Direct_Membership sits in a DESCENDANT of it. A holder on
   * an ANCESTOR of the Destination_Team is not in that list (inherited
   * rows propagate upward, not down), so an identical suffix there must
   * NOT block the transfer. Generating both sides is what makes the
   * biconditional below more than a one-directional check: without the
   * out-of-list placements, an implementation comparing against every user
   * in the database would pass.
   *
   * `submittedShape` picks what the transfer supplies as `callsignSuffix`:
   * the generated case variant of the holder's value (a collision exactly
   * when the holder is in the list -- which only a case-INSENSITIVE
   * comparison detects, since `callsignSuffixCasePairArb` flips an
   * arbitrary subset of the characters), or that variant with a marker
   * appended, which cannot collide under any casing because it is the
   * holder's lowercased value plus three more characters. Nothing is
   * assumed from the shape, though: the expectation below is recomputed
   * from the two generated strings.
   */
  const suffixCollisionScenarioArb = teamPlanArb.chain((plan) => {
    const sourceChainKeys = plan.ancestorKeysOf(plan.sourceKey);
    const destChainKeys = plan.ancestorKeysOf(plan.destKey);
    const sharedKeys = sourceChainKeys.filter((key) => destChainKeys.includes(key));

    // The Destination_Team's Member_List, in plan labels: a user's
    // Direct_Membership puts them on that Team and on every STRICT
    // ANCESTOR of it, so the users appearing on the Destination_Team are
    // exactly those whose Direct_Membership sits on it or below it.
    const inListKeys = plan.teamKeys.filter(
      (key) => key === plan.destKey || plan.ancestorKeysOf(key).includes(plan.destKey)
    );
    const outOfListKeys = plan.teamKeys.filter((key) => !inListKeys.includes(key));

    return fc.record({
      plan: fc.constant(plan),
      actor: fc.oneof(
        {
          arbitrary: fc.record({
            isGlobalManager: fc.constant(false),
            placement: fc.record({
              teamKey: fc.constantFrom(...sharedKeys),
              role: fc.constant('admin')
            })
          }),
          weight: 3
        },
        {
          arbitrary: fc.record({
            isGlobalManager: fc.constant(true),
            placement: fc.constant(null)
          }),
          weight: 1
        }
      ),
      transferredUserRole: fc.constantFrom('member', 'admin'),
      channelHasGroup: fc.array(fc.boolean(), {
        minLength: plan.teamKeys.length,
        maxLength: plan.teamKeys.length
      }),
      holder: fc.record({
        teamKey: fc.oneof(
          { arbitrary: fc.constantFrom(...inListKeys), weight: 3 },
          ...(outOfListKeys.length > 0
            ? [{ arbitrary: fc.constantFrom(...outOfListKeys), weight: 2 }]
            : [])
        ),
        // The Member_List is members AND admins alike, so both are
        // generated; the holder is never the acting user.
        role: fc.constantFrom('member', 'admin'),
        suffixPair: callsignSuffixCasePairArb()
      }),
      submittedShape: fc.oneof(
        { arbitrary: fc.constant('case_variant'), weight: 3 },
        { arbitrary: fc.constant('distinct'), weight: 1 }
      )
    });
  });

  /**
   * Seeds a user holding a committed `users.callsign_suffix` and one
   * Direct_Membership, and reports where that membership sits so the
   * caller can decide Member_List membership by walking the plan rather
   * than by querying the roster the code under test queries.
   *
   * @param {object} world as returned by `seedWorld`
   * @param {object} tracker
   * @param {string} teamKey the holder's Direct_Membership label
   * @param {'member'|'admin'} role
   * @param {string} suffix the `callsign_suffix` value to store
   * @returns {Promise<{id: number, callsign_suffix: string}>}
   */
  async function seedSuffixHolder(world, tracker, teamKey, role, suffix) {
    const user = await seedUser(tracker);
    const updated = await pool.query(
      'UPDATE users SET callsign_suffix = $2 WHERE id = $1 RETURNING id, callsign_suffix',
      [user.id, suffix]
    );
    await seedMembership(world, user.id, teamKey, role);
    return updated.rows[0];
  }

  /**
   * The Transferred_User's stored Callsign_Suffix, used to confirm that a
   * rejected transfer left `executeTransfer`'s step-3 `UPDATE users`
   * rolled back along with everything else (Requirement 9.2). `seedUser`
   * leaves this column NULL, so the holder is the only user in a run
   * carrying a suffix at all.
   *
   * @param {number} userId
   * @returns {Promise<string|null>}
   */
  async function storedCallsignSuffixOf(userId) {
    const result = await pool.query('SELECT callsign_suffix FROM users WHERE id = $1', [userId]);
    return result.rows[0].callsign_suffix;
  }

  // Feature: team-member-transfer, Property 18: Callsign_Suffix collisions are detected case-insensitively
  //
  // Validates: Requirements 9.1
  // Also the Requirement 17.5 assertion: a Callsign_Suffix collision in the
  // Destination_Team produces status 400 and leaves the Transferred_User's
  // Direct_Membership naming the Source_Team.
  test.prop([suffixCollisionScenarioArb], { numRuns: 100 })(
    'rejects a transfer with status 400 naming the submitted value exactly when it matches, ignoring case, the Callsign_Suffix of a member of the Destination_Team Member_List -- leaving the Direct_Membership on the Source_Team and every membership, channel and suffix value untouched -- and otherwise completes the transfer with status 200',
    async (scenario) => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(scenario, tracker);

        const [holderSuffix, caseVariant] = scenario.holder.suffixPair;

        // `caseVariant` differs from `holderSuffix` only in case, so
        // appending a marker yields a value whose lowercase form is the
        // holder's lowercase form plus three characters -- distinct under
        // every casing, and the "no collision" leg of the biconditional.
        const submittedSuffix =
          scenario.submittedShape === 'case_variant' ? caseVariant : `${caseVariant}zz9`;

        const holder = await seedSuffixHolder(
          world,
          tracker,
          scenario.holder.teamKey,
          scenario.holder.role,
          holderSuffix
        );
        // The value the roster really holds, read back from the row rather
        // than taken from the generator, so a `varchar(255)` truncation or
        // an encoding surprise on a non-ASCII suffix cannot silently make
        // the reference computation disagree with the database.
        expect(holder.callsign_suffix).toBe(holderSuffix);

        // Reference computation, both halves walked off the generated data:
        // whether the holder appears on the Destination_Team at all, and
        // whether the submitted value matches theirs case-insensitively.
        // Never `Team.getFullMemberList` or
        // `checkCallsignSuffixUniqueness`, which are the code under test.
        const holderInDestinationMemberList =
          scenario.holder.teamKey === scenario.plan.destKey
          || scenario.plan.ancestorKeysOf(scenario.holder.teamKey).includes(scenario.plan.destKey);
        const matchesIgnoringCase =
          submittedSuffix.toLowerCase() === holderSuffix.toLowerCase();
        const expectedCollision = holderInDestinationMemberList && matchesIgnoringCase;

        // The frame the property is stated in: Requirement 9.1's check is
        // only reached by an EXECUTED transfer, so the actor must be on
        // Requirement 2.4's immediate branch. A generator change that let a
        // single-side admin through would turn every assertion below into a
        // statement about the 202 path, so it fails here instead.
        const adminsSource = referenceIsTeamAdmin(
          scenario.plan,
          scenario.actor.placement,
          scenario.plan.sourceKey
        );
        const adminsDestination = referenceIsTeamAdmin(
          scenario.plan,
          scenario.actor.placement,
          scenario.plan.destKey
        );
        expect(scenario.actor.isGlobalManager || (adminsSource && adminsDestination)).toBe(true);

        const observedUserIds = [world.transferredUser.id, world.actor.id, holder.id];
        const before = await snapshotMembershipState(observedUserIds);

        const res = await postTransfer(app, world, { callsignSuffix: submittedSuffix });

        const requests = await teamChangeRequestsFor(world.transferredUser.id);
        // Either way this is the immediate branch, which writes no
        // `access_requests` row: Requirement 9.2's "any associated
        // Transfer_Request SHALL hold `status` of `pending`" has no subject
        // on this path, and its 202-branch counterpart is Property 21's.
        expect(requests).toHaveLength(0);

        const direct = await directMembershipOf(world.transferredUser.id);
        expect(direct).not.toBeNull();

        if (expectedCollision) {
          // Requirement 9.1: 400, with the conflicting value in the message
          // so the Client can offer a replacement (Requirement 9.6) instead
          // of the operator reading server logs.
          expect(res.status).toBe(400);
          expect(res.body.error).toContain(submittedSuffix);

          // Requirement 17.5 / Requirement 9.2: the Direct_Membership still
          // names the Source_Team...
          expect(direct.team_id).toBe(world.sourceTeamId);
          expect(direct.role).toBe(scenario.transferredUserRole);

          // ...and nothing moved at all: the whole membership and channel
          // state of the Transferred_User, the actor, and the holder is
          // byte-for-byte what it was.
          const after = await snapshotMembershipState(observedUserIds);
          expect(after).toEqual(before);

          // The conflicting value was never stored either: `executeTransfer`
          // writes the resolved suffix (step 3) BEFORE the check inside
          // `addUserToTeam` (step 4) runs, so the rejection has to take that
          // write down with it. Rollback totality across every step is
          // Property 5's subject; this is the one write this property's own
          // rejection path creates.
          expect(await storedCallsignSuffixOf(world.transferredUser.id)).toBeNull();
        } else {
          // No collision: the same submitted value, either differing beyond
          // case or held only by a user outside the Destination_Team's
          // Member_List, must not block anything. The transfer lands.
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('completed');
          expect(direct.team_id).toBe(world.destinationTeamId);
        }

        // The holder is untouched on both paths -- a transfer resolves a
        // collision by refusing to proceed, never by renaming somebody
        // else's suffix out of the way.
        expect(await storedCallsignSuffixOf(holder.id)).toBe(holderSuffix);
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    600000
  );

  // -------------------------------------------------------------------
  // Property 26 (task 9.8)
  // -------------------------------------------------------------------

  /**
   * Requirement 1.1's two optional string fields are bounded by the
   * route's validators
   * (`body('justification').optional().trim().isLength({ max: 500 })` and
   * `body('callsignSuffix').optional().trim().isLength({ max: 255 })`),
   * and the property below is stated as a biconditional over the TRIMMED
   * length of each: `.trim()` is a SANITISER that rewrites the body value
   * in place before `isLength` sees it, so the length the route measures
   * is never the raw submitted one. A body whose raw length exceeds the
   * bound but whose trimmed length does not must therefore be ACCEPTED --
   * which is what the two `padded-*` shapes below exist to pin down.
   *
   * Every character in the pool is a single UTF-16 code unit and none of
   * them is whitespace, for the two reasons Property 23 in
   * `requests.approval.integration.test.js` documents:
   *
   *  - validator.js's `isLength` discounts surrogate pairs before
   *    comparing, so for an astral character JavaScript's `.length` and
   *    the validator's count diverge and the boundary this test aims at
   *    would not be the boundary the route enforces. A BMP-only pool keeps
   *    the two counts identical.
   *  - a whitespace-free pool makes the buckets exact: a generated
   *    500-character body trims to exactly 500, so "at the bound" cannot
   *    silently become "one under".
   *
   * Non-ASCII members are included because `justification` is `TEXT`
   * holding operator-authored prose and `callsign_suffix` is a
   * `varchar(255)` holding a human-chosen name segment.
   */
  const P26_BODY_CHARS = [...'abcXYZ019-_.', 'é', 'ü', 'ō', 'テ', '—'];

  const p26BodyOfLength = (length) =>
    fc
      .array(fc.constantFrom(...P26_BODY_CHARS), { minLength: length, maxLength: length })
      .map((chars) => chars.join(''));

  // ASCII whitespace only: `String.prototype.trim` and validator.js's
  // `trim` (a `/^\s+/` + `/\s+$/` strip) agree on every one of these, so
  // the padding can never make the trimmed length computed here differ
  // from the one the route's sanitiser produces.
  const p26WhitespaceRunArb = fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { minLength: 1, maxLength: 8 })
    .map((chars) => chars.join(''));

  /**
   * One field's submitted shape, spanning both sides of its bound:
   *
   *  - trimmed length 0: the key omitted entirely, present as JSON `null`,
   *    the empty string, and whitespace-only. All four are accepted (both
   *    fields are `.optional()` with no minimum) and all four store NULL,
   *    since the route writes `req.body.<field> || null`.
   *  - trimmed length 1..max: a mid-range value, `max - 1`, and `max`
   *    itself -- the inclusive upper bound, which must be accepted.
   *  - trimmed length max + 1 and a run further past it: rejected.
   *  - a padded body trimming to exactly `max` and a padded one trimming
   *    to `max + 1`: the pair that separates a bound applied to the
   *    trimmed value from one applied to the raw submission. Both carry a
   *    raw length over the bound; only the second may be rejected.
   *
   * @param {number} maxLength the bound Requirement 1.1 states for the field
   * @returns {fc.Arbitrary<{label: string, sendField: boolean, value: string|null}>}
   */
  const p26FieldArb = (maxLength) =>
    fc.oneof(
      fc.constant({ label: 'absent', sendField: false, value: null }),
      fc.constant({ label: 'json-null', sendField: true, value: null }),
      fc.constant({ label: 'empty-string', sendField: true, value: '' }),
      p26WhitespaceRunArb.map((value) => ({ label: 'whitespace-only', sendField: true, value })),
      fc
        .integer({ min: 1, max: 40 })
        .chain((length) => p26BodyOfLength(length))
        .map((value) => ({ label: 'mid-range', sendField: true, value })),
      p26BodyOfLength(maxLength - 1).map((value) => ({
        label: 'one-under-max',
        sendField: true,
        value
      })),
      p26BodyOfLength(maxLength).map((value) => ({ label: 'at-max', sendField: true, value })),
      p26BodyOfLength(maxLength + 1).map((value) => ({
        label: 'one-over-max',
        sendField: true,
        value
      })),
      fc
        .integer({ min: maxLength + 2, max: maxLength + 60 })
        .chain((length) => p26BodyOfLength(length))
        .map((value) => ({ label: 'far-over-max', sendField: true, value })),
      fc
        .tuple(p26WhitespaceRunArb, p26BodyOfLength(maxLength), p26WhitespaceRunArb)
        .map(([left, body, right]) => ({
          label: 'padded-trims-to-max',
          sendField: true,
          value: `${left}${body}${right}`
        })),
      fc
        .tuple(p26WhitespaceRunArb, p26BodyOfLength(maxLength + 1), p26WhitespaceRunArb)
        .map(([left, body, right]) => ({
          label: 'padded-trims-to-over-max',
          sendField: true,
          value: `${left}${body}${right}`
        }))
    );

  /**
   * The two fields are generated INDEPENDENTLY, so all four corners of
   * "justification over the bound" x "callsignSuffix over the bound" are
   * reachable -- an implementation that bounded only one of them, or that
   * reported the wrong field, is caught by the flagged-field assertion
   * below rather than by the status alone.
   *
   * The actor spans all three authorized kinds, because the rejection has
   * to hold on BOTH branches of Requirement 2.4/2.5 and the two branches
   * fail differently if the validators are skipped: a single-side admin
   * would merely write an over-long `access_requests` row, whereas a
   * Global_Manager or Dual_Admin would EXECUTE the transfer. Generating
   * the immediate branch is what gives the "no membership change" half of
   * this property a subject at all.
   *
   * Authorization is guaranteed structurally, as in Property 9: a direct
   * `admin` row on a label in both Ancestor_Chains is a Dual_Admin (both
   * of `teamPlanArb`'s branches fork off the deepest shared Team, so the
   * intersection always holds at least `org`), one in exactly one chain --
   * the symmetric difference, non-empty because `teamPlanArb` never makes
   * both branch lengths zero -- is a single-side admin, and a
   * Global_Manager is authorized with no membership at all.
   */
  const p26ScenarioArb = teamPlanArb.chain((plan) => {
    const sourceChainKeys = plan.ancestorKeysOf(plan.sourceKey);
    const destChainKeys = plan.ancestorKeysOf(plan.destKey);
    const sharedKeys = sourceChainKeys.filter((key) => destChainKeys.includes(key));
    const exclusiveKeys = [
      ...sourceChainKeys.filter((key) => !destChainKeys.includes(key)),
      ...destChainKeys.filter((key) => !sourceChainKeys.includes(key))
    ];

    return fc.record({
      plan: fc.constant(plan),
      actor: fc.oneof(
        {
          arbitrary: fc.record({
            isGlobalManager: fc.constant(false),
            placement: fc.record({
              teamKey: fc.constantFrom(...exclusiveKeys),
              role: fc.constant('admin')
            })
          }),
          weight: 2
        },
        {
          arbitrary: fc.record({
            isGlobalManager: fc.constant(false),
            placement: fc.record({
              teamKey: fc.constantFrom(...sharedKeys),
              role: fc.constant('admin')
            })
          }),
          weight: 2
        },
        {
          arbitrary: fc.record({
            isGlobalManager: fc.constant(true),
            placement: fc.constant(null)
          }),
          weight: 1
        }
      ),
      transferredUserRole: fc.constantFrom('member', 'admin'),
      channelHasGroup: fc.array(fc.boolean(), {
        minLength: plan.teamKeys.length,
        maxLength: plan.teamKeys.length
      }),
      justification: p26FieldArb(500),
      callsignSuffix: p26FieldArb(255)
    });
  });

  /**
   * The trimmed value the route's `.trim()` sanitiser will hand to
   * `isLength`, derived from the generated shape alone. A JSON `null` and
   * an omitted key both sanitise to the empty string (express-validator's
   * `toString` maps `null` to `''`), so both are folded here.
   *
   * @param {{sendField: boolean, value: string|null}} field
   * @returns {string}
   */
  function p26TrimmedValue(field) {
    return field.value === null ? '' : String(field.value).trim();
  }

  // Feature: team-member-transfer, Property 26: Field length limits are enforced at the stated bounds
  //
  // Validates: Requirements 1.1
  test.prop([p26ScenarioArb], { numRuns: 100 })(
    'rejects a transfer with status 400 naming exactly the offending fields, inserting no access_requests row and changing no membership, if and only if the trimmed justification exceeds 500 characters or the trimmed callsignSuffix exceeds 255 characters -- and otherwise accepts the request, storing the trimmed value',
    async (scenario) => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(scenario, tracker);

        // Reference computation: Requirement 1.1's two bounds, applied to
        // the trimmed form of the generated values. The route is never
        // consulted about what it considers too long, and neither is
        // `validationResult`.
        const justificationTrimmed = p26TrimmedValue(scenario.justification);
        const callsignSuffixTrimmed = p26TrimmedValue(scenario.callsignSuffix);

        const overLongFields = [];
        if (justificationTrimmed.length > 500) {
          overLongFields.push('justification');
        }
        if (callsignSuffixTrimmed.length > 255) {
          overLongFields.push('callsignSuffix');
        }
        const expectedRejected = overLongFields.length > 0;

        // Which branch an ACCEPTED request takes, walked off the generated
        // plan and placement exactly as in Property 9 -- never
        // `Team.isAdmin`, which is the code the route consults. Used only
        // to know whether acceptance looks like 200 or 202; the rejection
        // half of the biconditional is branch-independent.
        const adminsSource = referenceIsTeamAdmin(
          scenario.plan,
          scenario.actor.placement,
          scenario.plan.sourceKey
        );
        const adminsDestination = referenceIsTeamAdmin(
          scenario.plan,
          scenario.actor.placement,
          scenario.plan.destKey
        );
        const expectedImmediate =
          scenario.actor.isGlobalManager || (adminsSource && adminsDestination);

        // The frame the property is stated in: an UNAUTHORIZED actor would
        // be answered 403 by the resolver before the validators ran, making
        // every assertion below a statement about authorization instead of
        // about field lengths. A generator change that allowed one fails
        // here rather than silently hollowing the test out.
        expect(
          scenario.actor.isGlobalManager || adminsSource || adminsDestination
        ).toBe(true);

        const observedUserIds = [world.transferredUser.id, world.actor.id];
        const before = await snapshotMembershipState(observedUserIds);

        // `sendField: false` omits the key entirely, which is the "optional"
        // half of Requirement 1.1 -- distinct from sending `null`, since the
        // two reach the validator by different routes (`.optional()` skips
        // only `undefined`) even though both sanitise to ''.
        const body = {};
        if (scenario.justification.sendField) {
          body.justification = scenario.justification.value;
        }
        if (scenario.callsignSuffix.sendField) {
          body.callsignSuffix = scenario.callsignSuffix.value;
        }

        const res = await postTransfer(app, world, body);

        const requests = await teamChangeRequestsFor(world.transferredUser.id);
        const direct = await directMembershipOf(world.transferredUser.id);
        expect(direct).not.toBeNull();

        if (expectedRejected) {
          expect(res.status).toBe(400);

          // Step 3 of the handler answers a validation failure with
          // `{ errors: [...] }`, so an over-long field is distinguishable
          // from the single-`error` 400s of Requirements 1.2, 1.4, 1.5, 1.7
          // and 9.1.
          expect(Array.isArray(res.body.errors)).toBe(true);

          // EXACTLY the offending fields: a bound applied to the raw rather
          // than the trimmed value would flag a `padded-trims-to-max`
          // field that belongs on the accepted side, and this equality
          // catches that as surely as the status does.
          const flaggedPaths = [...new Set(res.body.errors.map((entry) => entry.path))].sort();
          expect(flaggedPaths).toEqual([...overLongFields].sort());

          // Requirement 1.1's rejection is total: no Transfer_Request on the
          // 202 branch...
          expect(requests).toHaveLength(0);

          // ...and no Team_Transfer on the immediate branch. Without the
          // Global_Manager and Dual_Admin legs of the actor generator this
          // assertion would be vacuous, because the 202 branch changes no
          // membership either way.
          expect(await snapshotMembershipState(observedUserIds)).toEqual(before);
          expect(direct.team_id).toBe(world.sourceTeamId);
          expect(direct.role).toBe(scenario.transferredUserRole);

          // Nor was the over-long body written anywhere else: validation
          // precedes `executeTransfer`'s step-3 `UPDATE users`, so a
          // rejected request leaves the column NULL as `seedUser` wrote it.
          expect(await storedCallsignSuffixOf(world.transferredUser.id)).toBeNull();
        } else if (expectedImmediate) {
          // The other half of the biconditional on Requirement 2.4's
          // branch: a value at or under the bound is not what gets
          // rejected, and a raw length over the bound that trims to within
          // it is accepted.
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('completed');
          expect(requests).toHaveLength(0);
          expect(direct.team_id).toBe(world.destinationTeamId);

          // The TRIMMED value is what was stored, confirming the bound was
          // measured on the same string the route persists. An absent,
          // null, empty or whitespace-only submission resolves to no
          // supplied suffix at all, leaving the column NULL.
          expect(await storedCallsignSuffixOf(world.transferredUser.id)).toBe(
            callsignSuffixTrimmed === '' ? null : callsignSuffixTrimmed
          );
        } else {
          // Requirement 2.5's branch: accepted, and the row carries the
          // trimmed values. WHICH columns a Transfer_Request round-trips is
          // Property 10's subject; the two length-bearing ones are asserted
          // here because they are what the bound was measured on.
          expect(res.status).toBe(202);
          expect(res.body.status).toBe('pending_approval');
          expect(requests).toHaveLength(1);
          expect(requests[0].justification).toBe(
            justificationTrimmed === '' ? null : justificationTrimmed
          );
          expect(requests[0].callsign_suffix).toBe(
            callsignSuffixTrimmed === '' ? null : callsignSuffixTrimmed
          );
          expect(direct.team_id).toBe(world.sourceTeamId);
        }
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    600000
  );

  // -------------------------------------------------------------------
  // Property 28 (task 9.9)
  // -------------------------------------------------------------------

  /**
   * Requirement 1.8 rejects a transfer whose `:userId` names the
   * requesting user themselves, and it admits NO exemption -- a
   * Global_Manager is rejected exactly like a Team_Admin. So unlike every
   * other property in this file, the acting identity here IS the
   * Transferred_User: `postTransfer` is handed a world whose `actor` is
   * `world.transferredUser`, which makes
   * `Number(req.params.userId) === req.user.userId` true.
   *
   * A user holds at most one Direct_Membership
   * (`idx_team_memberships_one_direct_per_user`), and the Source_Team is by
   * definition wherever that row sits, so the self's placement is not a
   * free variable: it is the Source_Team, with the generated
   * `transferredUserRole`. That fixes which actor kinds are reachable for a
   * given plan, and the generator derives them from the plan rather than
   * filtering:
   *
   * - `global_manager`      authorized by the resolver's first leg
   *                         whatever their own role is, so both `member`
   *                         and `admin` are generated. This is the leg
   *                         Requirement 1.8's note is really about -- the
   *                         one place a Global_Manager gets no override.
   * - `dual_admin`          a direct `admin` row on the Source_Team makes
   *                         the self an admin of the Destination_Team too
   *                         exactly when the Source_Team is an ANCESTOR of
   *                         it, which `teamPlanArb` produces whenever the
   *                         source branch has length zero. Generated only
   *                         for those plans, so the kind is genuinely of
   *                         that kind.
   * - `single_side_admin`   the same direct `admin` row on a Source_Team
   *                         that is not an ancestor of the Destination_Team
   *                         administers the source side only.
   *
   * A self with a direct `member` row and no Global_Manager flag is
   * deliberately NOT generated: the resolver denies them on both legs and
   * they are answered 403 before the handler runs, so they would be a
   * statement about Requirement 2.3 rather than about Requirement 1.8.
   *
   * `bodyShape` is the second half of the property, and the reason it
   * exists is the handler's ORDER: the self-transfer gate is step 2, above
   * body validation (step 3), the Destination_Team existence check (step
   * 4) and the already-in-destination check (step 5). Every shape below
   * would be answered 400 by one of those LATER steps -- an absent,
   * non-integer, zero, negative or null `targetTeamId` and an over-long
   * `justification` by the `{ errors: [...] }` shape of step 3, an unknown
   * team id by step 4, the Source_Team's own id by step 5 -- and all of
   * them must still produce the SELF-transfer 400 instead. That is what
   * makes the assertion on the response SHAPE (a single `error` string
   * naming the self-transfer, and no `errors` array) load-bearing rather
   * than decorative: a handler that validated the body first would answer
   * these with the same status code and a different body.
   *
   * Authorization is body-independent for all three kinds -- the
   * Global_Manager leg and the source leg of the `user:team:transfer`
   * resolver are both decided without `req.body.targetTeamId`, and
   * `Team.isAdmin` swallows a malformed id into `false` rather than
   * throwing -- so no shape here can turn the expected 400 into a 403.
   */
  const P28_UNKNOWN_TEAM_ID = 2000000000;

  const P28_BODY_SHAPES = [
    'valid_destination',
    'target_absent',
    'target_not_an_integer',
    'target_zero',
    'target_negative',
    'target_json_null',
    'target_unknown_team',
    'target_source_team',
    'justification_over_bound'
  ];

  const selfTransferScenarioArb = teamPlanArb.chain((plan) => {
    // The self's single Direct_Membership sits on the Source_Team, so they
    // administer the Destination_Team as well precisely when the
    // Source_Team is in the Destination_Team's Ancestor_Chain.
    const sourceAdminAlsoAdminsDestination = plan
      .ancestorKeysOf(plan.destKey)
      .includes(plan.sourceKey);

    const selfKindArb = fc.oneof(
      { arbitrary: fc.constant('global_manager'), weight: 2 },
      {
        arbitrary: fc.constant(
          sourceAdminAlsoAdminsDestination ? 'dual_admin' : 'single_side_admin'
        ),
        weight: 3
      }
    );

    return selfKindArb.chain((selfKind) =>
      fc.record({
        plan: fc.constant(plan),
        selfKind: fc.constant(selfKind),
        // `seedWorld` always seeds a second user; on this property they are
        // a BYSTANDER who initiates nothing, kept in the observed id set so
        // a handler that touched the wrong principal is still caught.
        actor: fc.constant({ isGlobalManager: false, placement: null }),
        // The self's own Direct_Membership role. Both of Requirements
        // 10.2/10.3's cases are generated for a Global_Manager; the two
        // admin kinds are what they are by holding `admin`.
        transferredUserRole:
          selfKind === 'global_manager' ? fc.constantFrom('member', 'admin') : fc.constant('admin'),
        channelHasGroup: fc.array(fc.boolean(), {
          minLength: plan.teamKeys.length,
          maxLength: plan.teamKeys.length
        }),
        bodyShape: fc.constantFrom(...P28_BODY_SHAPES),
        // Submitted on some runs so the assertion that
        // `users.callsign_suffix` is still NULL afterwards has a subject:
        // `executeTransfer`'s step-3 `UPDATE users` is the first write a
        // transfer makes, and Requirement 1.8 forbids reaching it.
        callsignSuffix: fc.option(fc.stringMatching(/^[A-Za-z0-9]{1,12}$/), { nil: null })
      })
    );
  });

  /**
   * Flips a seeded user's Global_Manager flag, returning the row as the
   * database now holds it so `actAs` sees the same value the resolver
   * will.
   *
   * @param {number} userId
   * @returns {Promise<object>} the updated `users` row
   */
  async function promoteToGlobalManager(userId) {
    const result = await pool.query(
      `UPDATE users SET is_global_manager = true
        WHERE id = $1
        RETURNING id, authentik_user_id, username, email, first_name, last_name, is_global_manager`,
      [userId]
    );
    return result.rows[0];
  }

  /**
   * The request body for a generated shape. `undefined` omits the key
   * entirely once `postTransfer` merges this over its
   * `{ targetTeamId: <destination> }` default, because `JSON.stringify`
   * drops `undefined` values.
   *
   * @param {object} world
   * @param {string} shape one of `P28_BODY_SHAPES`
   * @returns {object}
   */
  function p28TargetBody(world, shape) {
    switch (shape) {
      case 'target_absent':
        return { targetTeamId: undefined };
      case 'target_not_an_integer':
        return { targetTeamId: 'not-a-team' };
      case 'target_zero':
        return { targetTeamId: 0 };
      case 'target_negative':
        return { targetTeamId: -7 };
      case 'target_json_null':
        return { targetTeamId: null };
      case 'target_unknown_team':
        return { targetTeamId: P28_UNKNOWN_TEAM_ID };
      case 'target_source_team':
        return { targetTeamId: world.sourceTeamId };
      case 'justification_over_bound':
        return { targetTeamId: world.destinationTeamId, justification: 'x'.repeat(501) };
      default:
        return { targetTeamId: world.destinationTeamId };
    }
  }

  /**
   * Every `access_requests` row referencing any of the given users through
   * any of its user-bearing columns, whatever its `request_type`.
   * Requirement 1.8 forbids inserting an `access_requests` row at all, so
   * this is deliberately wider than `teamChangeRequestsFor`: a row written
   * with some other `request_type` would be just as much a violation and
   * would slip past a `team_change`-scoped query.
   *
   * @param {number[]} userIds
   * @returns {Promise<object[]>}
   */
  async function accessRequestsTouching(userIds) {
    const result = await pool.query(
      `SELECT id, request_type, status, existing_user_id, initiated_by, assigned_to_admin
         FROM access_requests
        WHERE existing_user_id = ANY($1)
           OR initiated_by = ANY($1)
           OR assigned_to_admin = ANY($1)
           OR processed_by = ANY($1)
        ORDER BY id`,
      [userIds]
    );
    return result.rows;
  }

  // Feature: team-member-transfer, Property 28: A user's own membership can never be transferred
  //
  // Validates: Requirements 1.8
  test.prop([selfTransferScenarioArb], { numRuns: 100 })(
    'rejects a transfer whose :userId names the requesting user with status 400 and the self-transfer message -- for a Global_Manager, a Team_Admin of both sides, and a Team_Admin of one side alike -- inserting no access_requests row of any type, performing no Team_Transfer, and answering with the self-transfer error rather than a validation-errors body even when the submitted targetTeamId is absent, malformed, unknown, or the Source_Team itself',
    async (scenario) => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(scenario, tracker);

        // The self acts on their own membership: same `users` row on
        // `req.params.userId` and on `req.user.userId`.
        const self =
          scenario.selfKind === 'global_manager'
            ? await promoteToGlobalManager(world.transferredUser.id)
            : world.transferredUser;
        expect(self.id).toBe(world.transferredUser.id);
        expect(self.is_global_manager).toBe(scenario.selfKind === 'global_manager');

        // Reference computation: the self's admin standing on each side,
        // walked off the generated plan and their single generated
        // Direct_Membership. Never `Team.isAdmin`, which is what the
        // resolver and the route's step 8 consult.
        const selfPlacement = {
          teamKey: scenario.plan.sourceKey,
          role: scenario.transferredUserRole
        };
        const adminsSource = referenceIsTeamAdmin(
          scenario.plan,
          selfPlacement,
          scenario.plan.sourceKey
        );
        const adminsDestination = referenceIsTeamAdmin(
          scenario.plan,
          selfPlacement,
          scenario.plan.destKey
        );

        // The frame the property is stated in. An UNAUTHORIZED self would
        // be answered 403 by the resolver before step 2 ran, which would
        // make every assertion below a statement about Requirement 2.3
        // instead of Requirement 1.8 -- so a generator change that admitted
        // one fails here rather than hollowing the test out. The per-kind
        // assertions pin down that each generated kind really is of that
        // kind: without them a `dual_admin` leg that silently degraded into
        // a single-side admin would leave Requirement 1.8's
        // no-Global_Manager-exemption claim untested on the branch that
        // would otherwise have executed immediately.
        expect(scenario.selfKind === 'global_manager' || adminsSource).toBe(true);

        if (scenario.selfKind === 'global_manager') {
          expect(self.is_global_manager).toBe(true);
        } else if (scenario.selfKind === 'dual_admin') {
          // Requirement 2.4's branch: this attempt would have executed
          // immediately had step 2 not fired first.
          expect(adminsSource && adminsDestination).toBe(true);
        } else {
          // Requirement 2.5's branch: this attempt would have created a
          // Transfer_Request had step 2 not fired first.
          expect(adminsSource).toBe(true);
          expect(adminsDestination).toBe(false);
        }

        const observedUserIds = [world.transferredUser.id, world.actor.id];
        const before = await snapshotMembershipState(observedUserIds);
        // Nothing in this file's seeding writes an `access_requests` row, so
        // the starting set is empty; asserted rather than assumed, because
        // "inserted no row" below is a comparison against it.
        expect(await accessRequestsTouching(observedUserIds)).toHaveLength(0);

        const body = p28TargetBody(world, scenario.bodyShape);
        if (scenario.callsignSuffix !== null) {
          body.callsignSuffix = scenario.callsignSuffix;
        }

        const res = await postTransfer(app, { ...world, actor: self }, body);

        // Requirement 1.8: 400, on every actor kind and every body shape.
        expect(res.status).toBe(400);

        // ...and specifically the SELF-transfer 400, not one of the later
        // steps' 400s. This is where the handler's ordering is observable:
        // the shapes that would fail validation (absent, non-integer, zero,
        // negative and null `targetTeamId`, and the over-long
        // `justification`) would be answered `{ errors: [...] }` by step 3,
        // and the unknown-team and Source_Team shapes carry their own
        // distinct messages from steps 4 and 5.
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error).toMatch(/own membership/i);
        expect(res.body.errors).toBeUndefined();

        // Requirement 1.8's "SHALL insert no `access_requests` row",
        // regardless of which branch the attempt would otherwise have
        // taken -- including the single-side-admin kind, whose whole
        // purpose in life is to create one.
        expect(await accessRequestsTouching(observedUserIds)).toHaveLength(0);

        // Requirement 1.8's "SHALL perform no Team_Transfer": not one
        // membership or channel row of the self or the bystander moved...
        expect(await snapshotMembershipState(observedUserIds)).toEqual(before);

        // ...the Direct_Membership still names the Source_Team with its
        // original role, so no demotion happened either (Requirement 10.1
        // is what makes a self-transfer's demotion the hazard Requirement
        // 1.8's note describes)...
        const direct = await directMembershipOf(world.transferredUser.id);
        expect(direct).not.toBeNull();
        expect(direct.team_id).toBe(world.sourceTeamId);
        expect(direct.role).toBe(scenario.transferredUserRole);

        // ...and no submitted Callsign_Suffix was persisted: step 3 of
        // `executeTransfer` is the first write a transfer makes, and this
        // attempt never reached it.
        expect(await storedCallsignSuffixOf(world.transferredUser.id)).toBeNull();
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    600000
  );

  // -------------------------------------------------------------------
  // Property 7 (task 10.8)
  // -------------------------------------------------------------------

  /**
   * The one property in this file that spans two ROUTES, because it spans
   * two MOMENTS. Requirement 1.7 checks the Organisation boundary when a
   * transfer is requested; Requirement 11.6 re-checks it when a pending
   * Transfer_Request is approved, against the Organisations current THEN
   * and against the APPROVING user's Global_Manager status. Between those
   * two moments `PUT /api/teams/:teamId` can move either Team into another
   * Organisation, which is what makes the second check more than a repeat
   * of the first. Splitting the two halves into two tests would split one
   * biconditional into two half-assertions that could both pass while the
   * property failed (design.md says exactly this, which is why Property 7
   * lives here rather than in `requests.approval.integration.test.js`), so
   * one run walks the whole sequence: create -> reparent -> attempt again
   * -> approve.
   *
   * Two Transferred_Users are seeded from the same generated hierarchy
   * because the two moments need different subjects: `pendingUser` carries
   * the Transfer_Request created BEFORE the reparenting and is the subject
   * of the approval moment, while `world.transferredUser` is the subject of
   * a fresh initiation attempt made AFTER it. One user could not serve
   * both -- a Global_Manager's initiation attempt succeeds immediately and
   * would move the very user whose pending request the approval moment
   * then needs.
   *
   * The reparenting is applied as a direct `UPDATE teams SET
   * parent_team_id`, which is the write `PUT /api/teams/:teamId` performs
   * and is what the shared `reparentingArb` in
   * `server/services/__fixtures__/transferArbitraries.js` models. That
   * generator is not reused here for the reason the harness note at the top
   * of this file gives: it mints its own fixed Team ids, whereas every id
   * here comes back from a real `RETURNING id`. Its shape is reproduced
   * plan-keyed instead, over three generated destinations for the moved
   * Team:
   *
   * - `null`                promotes it to an Organisation of its own;
   * - `P7_OTHER_ORG_KEY`    moves it under a second, freshly seeded
   *                         Organisation root;
   * - `'org'`               moves it under the hierarchy's own root, which
   *                         changes the shape WITHOUT changing either
   *                         side's Organisation.
   *
   * The third destination is what gives the biconditional its negative
   * direction at the approval moment: a reparented-but-still-agreeing
   * hierarchy must approve normally, so an implementation that rejected on
   * "the hierarchy changed" rather than on "the Organisations differ" fails
   * here. The moved Team is drawn from the symmetric difference of the two
   * Ancestor_Chains -- non-empty because `teamPlanArb` never makes both
   * branch lengths zero -- so moving it separates exactly one side. Nothing
   * is assumed from the generated destination, though: divergence is
   * recomputed below by walking the modified parent pointers, and
   * cross-checked against the `teams` rows as the database really holds
   * them.
   *
   * The two acting identities are generated independently
   * (`initiatorIsGlobalManager` x `approverIsGlobalManager`, all four
   * corners), and each is placed so that its authorization survives any
   * reparenting -- otherwise a run would be answered 403 by the resolver
   * and would say nothing about the Organisation boundary:
   *
   * - the later INITIATOR is either a Global_Manager with no membership, or
   *   holds a direct `admin` row on the Source_Team ITSELF, which
   *   `Team.isAdmin` satisfies through the chain's first element whatever
   *   the hierarchy above it looks like (Requirement 2.2's source leg);
   * - the APPROVER is either a Global_Manager, or holds a direct `admin`
   *   row on the Approval_Team ITSELF, which is what
   *   `resolveRequestActionPermission` gates `request:approve` on
   *   (Requirement 5.2).
   *
   * The Initiating_Admin of the pending request is always a
   * non-Global_Manager, structurally: `pendingBranchScenarioArb` produces
   * an admin of exactly one side, and it has to, because a Global_Manager
   * initiator is a Dual_Admin and would leave no pending request to
   * approve. That is precisely the asymmetry the property's statement
   * names -- the exemption at the approval moment is decided by the
   * APPROVING user alone, and every successful approval below happens
   * despite an initiator who had no exemption at all.
   *
   * No `callsignSuffix` is submitted on either moment. A supplied suffix
   * would drag `checkCallsignSuffixUniqueness` into the outcome, which is
   * Properties 18 and 19's subject; the Organisation boundary is checked in
   * step 2 of `executeTransfer`, before the suffix is resolved at all.
   */
  // Required here rather than beside `usersRouter` at the top of the file
  // so this property's needs are visible where they are used. Both routers
  // share this module registry, so the `../middleware/auth` mock -- and
  // therefore `actAs` -- drives the approve route exactly as it drives the
  // transfer route.
  const requestsRouter = require('./requests');

  /**
   * A second app mounting the real requests router at its production path,
   * so `authorize.js`'s `getRouteKey` produces the real registry key
   * `POST /api/requests/:requestId/approve` and the real
   * `request:approve` resolver runs. Kept separate from `buildApp` rather
   * than added to it: every other property in this file asserts against an
   * app that mounts the users router alone, and widening that would change
   * their subject.
   *
   * @returns {import('express').Express}
   */
  function buildApprovalApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/requests', requestsRouter);
    return app;
  }

  const approvalApp = buildApprovalApp();

  // The label of the second Organisation root, seeded only when the
  // generated reparenting actually moves a Team under it.
  const P7_OTHER_ORG_KEY = 'otherOrg';

  const p7ScenarioArb = pendingBranchScenarioArb.chain((base) => {
    const { plan } = base;
    const sourceChainKeys = plan.ancestorKeysOf(plan.sourceKey);
    const destChainKeys = plan.ancestorKeysOf(plan.destKey);
    // The labels whose reparenting separates exactly one of the two sides:
    // a Team on both chains is a common ancestor, and moving it takes both
    // sides with it (leaving the Organisations in agreement).
    const exclusiveKeys = [
      ...sourceChainKeys.filter((key) => !destChainKeys.includes(key)),
      ...destChainKeys.filter((key) => !sourceChainKeys.includes(key))
    ];

    return fc.record({
      base: fc.constant(base),
      reparenting: fc.record({
        teamKey: fc.constantFrom(...exclusiveKeys),
        newParentKey: fc.oneof(
          { arbitrary: fc.constant(null), weight: 2 },
          { arbitrary: fc.constant(P7_OTHER_ORG_KEY), weight: 2 },
          { arbitrary: fc.constant('org'), weight: 1 }
        )
      }),
      initiatorIsGlobalManager: fc.boolean(),
      approverIsGlobalManager: fc.boolean()
    });
  });

  /**
   * The generated parent pointers as they stand AFTER the reparenting,
   * including the second Organisation root.
   *
   * @param {TeamPlan} plan
   * @param {{teamKey: string, newParentKey: string|null}} reparenting
   * @returns {Map<string, string|null>}
   */
  function p7ParentMapAfter(plan, reparenting) {
    const parentOf = new Map(plan.parentOf);
    parentOf.set(P7_OTHER_ORG_KEY, null);
    parentOf.set(reparenting.teamKey, reparenting.newParentKey);
    return parentOf;
  }

  /**
   * Root-first labels for a Team under the given parent pointers -- the
   * glossary's Ancestor_Chain, walked off generated data rather than by
   * calling `Team.getAncestorChain`.
   *
   * @param {Map<string, string|null>} parentOf
   * @param {string} key
   * @returns {string[]}
   */
  function p7AncestorKeysOf(parentOf, key) {
    const chain = [];
    let current = key;
    while (current !== null && current !== undefined) {
      chain.push(current);
      current = parentOf.get(current);
    }
    return chain.reverse();
  }

  /**
   * The Organisation of a Team as the database really holds it, walked one
   * `parent_team_id` at a time. A plain data read, deliberately not the
   * recursive CTE `Team.getAncestorChain` runs -- it exists to confirm the
   * seeded-then-reparented rows match the generated plan the expectations
   * are computed from, so a seeding drift surfaces here instead of as an
   * inexplicable status-code failure.
   *
   * @param {number} teamId
   * @returns {Promise<number>}
   */
  async function p7RealOrganisationOf(teamId) {
    let current = teamId;

    // Bounded by MAX_TEAM_DEPTH + 2 (the extra Organisation root plus the
    // Team itself), so a cycle -- which nothing here can create -- would
    // fail the assertion rather than hang.
    for (let step = 0; step <= MAX_TEAM_DEPTH + 2; step += 1) {
      const result = await pool.query('SELECT parent_team_id FROM teams WHERE id = $1', [current]);
      const parentTeamId = result.rows[0] ? result.rows[0].parent_team_id : null;
      if (parentTeamId === null) {
        return current;
      }
      current = parentTeamId;
    }

    throw new Error(`Team ${teamId} has no Organisation within MAX_TEAM_DEPTH`);
  }

  // Feature: team-member-transfer, Property 7: Cross-Organisation transfers are rejected at both initiation and execution unless the executing actor is a Global_Manager
  //
  // Validates: Requirements 1.7, 11.6
  test.prop([p7ScenarioArb], { numRuns: 100 })(
    'evaluates the Organisation boundary against the Organisations current at each moment and the Global_Manager status of whoever is acting at that moment: a transfer requested across Organisations is rejected with status 400 unless the Initiating_Admin is a Global_Manager, and a Transfer_Request created while the Organisations agreed is rejected on approval with status 409 naming both Organisations, left pending and with no membership change, once a reparenting has diverged them -- unless the approving user is a Global_Manager, whose exemption alone decides it',
    async (scenario) => {
      const tracker = createTracker();

      try {
        const { base, reparenting } = scenario;
        const { plan } = base;
        const world = await seedWorld(base, tracker);

        // The approval moment's subject: a second user in the Source_Team,
        // so the initiation moment can act on `world.transferredUser`
        // without disturbing the pending request created below.
        const pendingUser = await seedUser(tracker);
        await seedMembership(world, pendingUser.id, plan.sourceKey, base.transferredUserRole);

        // Reference computation: which side the Initiating_Admin
        // administers, walked off the generated plan and placement.
        // Requirement 3.3's rule then names the Approval_Team, which is
        // what `request:approve` is gated on at the approval moment.
        const initiatingAdminAdminsSource = referenceIsTeamAdmin(
          plan,
          base.actor.placement,
          plan.sourceKey
        );
        const initiatingAdminAdminsDestination = referenceIsTeamAdmin(
          plan,
          base.actor.placement,
          plan.destKey
        );
        // The frame `pendingBranchScenarioArb` guarantees, asserted rather
        // than assumed: exactly one side, so the first attempt below really
        // does create a Transfer_Request instead of executing a transfer.
        expect(initiatingAdminAdminsSource).toBe(!initiatingAdminAdminsDestination);
        const approvalKey = initiatingAdminAdminsDestination ? plan.sourceKey : plan.destKey;

        // --- Moment 1: creation, while both Teams share one Organisation.
        // Requirement 1.7's negative direction -- the boundary check does
        // not fire when the Organisations agree -- and the row the approval
        // moment acts on.
        const createRes = await postTransfer(
          app,
          { ...world, transferredUser: pendingUser },
          { justification: base.justification ?? undefined }
        );
        expect(createRes.status).toBe(202);
        expect(createRes.body.status).toBe('pending_approval');

        const createdRequests = await teamChangeRequestsFor(pendingUser.id);
        expect(createdRequests).toHaveLength(1);
        const pendingRowBefore = createdRequests[0];
        expect(pendingRowBefore.status).toBe('pending');
        expect(pendingRowBefore.id).toBe(createRes.body.requestId);
        // The reference frame the approver's authorization is arranged
        // around; WHICH side this names is Property 11's subject.
        expect(pendingRowBefore.approval_team_id).toBe(world.teamIdOf(approvalKey));

        // The two later actors, seeded BEFORE the reparenting (so their
        // placements were made against the intact hierarchy) and before the
        // first snapshot, so their own rows are inside the compared state.
        const laterInitiator = await seedUser(tracker, {
          isGlobalManager: scenario.initiatorIsGlobalManager
        });
        if (!scenario.initiatorIsGlobalManager) {
          await seedMembership(world, laterInitiator.id, plan.sourceKey, 'admin');
        }

        const approver = await seedUser(tracker, {
          isGlobalManager: scenario.approverIsGlobalManager
        });
        if (!scenario.approverIsGlobalManager) {
          await seedMembership(world, approver.id, approvalKey, 'admin');
        }

        // --- The reparenting: the write `PUT /api/teams/:teamId` performs
        // while a Transfer_Request sits pending (Requirement 11.6's note).
        let otherOrgTeamId = null;
        if (reparenting.newParentKey === P7_OTHER_ORG_KEY) {
          const otherOrg = await seedTeam(tracker, `Transfer ${world.token} otherOrg`, null);
          otherOrgTeamId = otherOrg.id;
        }

        const teamIdOfKey = (key) =>
          (key === P7_OTHER_ORG_KEY ? otherOrgTeamId : world.teamIdOf(key));

        const movedTeamId = world.teamIdOf(reparenting.teamKey);
        const newParentTeamId =
          reparenting.newParentKey === null ? null : teamIdOfKey(reparenting.newParentKey);

        await pool.query('UPDATE teams SET parent_team_id = $2 WHERE id = $1', [
          movedTeamId,
          newParentTeamId
        ]);

        // Reference computation: the two Organisations as they stand now,
        // walked off the modified generated parent pointers.
        const parentAfter = p7ParentMapAfter(plan, reparenting);
        const sourceOrgKey = p7AncestorKeysOf(parentAfter, plan.sourceKey)[0];
        const destOrgKey = p7AncestorKeysOf(parentAfter, plan.destKey)[0];
        const organisationsDiverged = sourceOrgKey !== destOrgKey;
        const expectedSourceOrgId = teamIdOfKey(sourceOrgKey);
        const expectedDestOrgId = teamIdOfKey(destOrgKey);

        // The same two Organisations read back off the `teams` rows, which
        // is what makes the walk above a statement about the database
        // rather than about the generator.
        expect(await p7RealOrganisationOf(world.sourceTeamId)).toBe(expectedSourceOrgId);
        expect(await p7RealOrganisationOf(world.destinationTeamId)).toBe(expectedDestOrgId);

        const observedUserIds = [
          world.transferredUser.id,
          pendingUser.id,
          world.actor.id,
          laterInitiator.id,
          approver.id
        ];
        const beforeInitiation = await snapshotMembershipState(observedUserIds);

        // --- Moment 2: a fresh initiation attempt, now that the
        // Organisations may have diverged (Requirement 1.7).
        const initiationRes = await postTransfer(app, { ...world, actor: laterInitiator }, {});

        if (organisationsDiverged && !scenario.initiatorIsGlobalManager) {
          // Requirement 1.7: 400 on THIS path -- a caller mistake at
          // request time -- with the message the requirement specifies.
          // The very same `CrossOrganisationTransferError` is answered 409
          // at the approval moment below, which is the asymmetry design.md
          // calls out; a route that mapped it to one status on both paths
          // fails one of the two halves of this test.
          expect(initiationRes.status).toBe(400);
          expect(initiationRes.body.error).toMatch(/within one organisation/i);

          // Nothing was requested and nothing moved.
          expect(await teamChangeRequestsFor(world.transferredUser.id)).toHaveLength(0);
          expect(await snapshotMembershipState(observedUserIds)).toEqual(beforeInitiation);

          const direct = await directMembershipOf(world.transferredUser.id);
          expect(direct).not.toBeNull();
          expect(direct.team_id).toBe(world.sourceTeamId);
          expect(direct.role).toBe(base.transferredUserRole);
        } else {
          // The boundary check did not fire: either the Organisations still
          // agree, or the Initiating_Admin is a Global_Manager and is
          // exempt. Which of Requirement 2.4/2.5's branches then runs is
          // Property 9's subject and is computed here off the CURRENT
          // hierarchy only to know what "accepted" looks like -- the later
          // initiator's single direct `admin` row sits on the Source_Team,
          // so they administer the destination exactly when the Source_Team
          // is still one of its ancestors.
          const laterInitiatorAdminsDestination = p7AncestorKeysOf(
            parentAfter,
            plan.destKey
          ).includes(plan.sourceKey);
          const expectedImmediate =
            scenario.initiatorIsGlobalManager || laterInitiatorAdminsDestination;

          expect(initiationRes.status).toBe(expectedImmediate ? 200 : 202);

          const direct = await directMembershipOf(world.transferredUser.id);
          expect(direct).not.toBeNull();

          if (expectedImmediate) {
            // The Global_Manager exemption, positively: a cross-Organisation
            // transfer they requested is carried out rather than refused.
            expect(initiationRes.body.status).toBe('completed');
            expect(direct.team_id).toBe(world.destinationTeamId);
          } else {
            expect(initiationRes.body.status).toBe('pending_approval');
            expect(direct.team_id).toBe(world.sourceTeamId);
          }
        }

        // The pending request is untouched by whatever moment 2 did -- it
        // is a different user's row, and the approval moment below must act
        // on it exactly as it was created.
        const requestsBeforeApproval = await teamChangeRequestsFor(pendingUser.id);
        expect(requestsBeforeApproval).toHaveLength(1);
        expect(requestsBeforeApproval[0]).toEqual(pendingRowBefore);

        const beforeApproval = await snapshotMembershipState(observedUserIds);

        // --- Moment 3: approval of the request created before the
        // reparenting (Requirement 11.6).
        actAs(approver);
        const approveRes = await request(approvalApp)
          .post(`/api/requests/${pendingRowBefore.id}/approve`)
          .send({});

        const requestsAfterApproval = await teamChangeRequestsFor(pendingUser.id);
        expect(requestsAfterApproval).toHaveLength(1);
        const rowAfter = requestsAfterApproval[0];
        const pendingUserDirect = await directMembershipOf(pendingUser.id);
        expect(pendingUserDirect).not.toBeNull();

        if (organisationsDiverged && !scenario.approverIsGlobalManager) {
          // Requirement 11.6: 409 rather than 400 -- the submitted approval
          // was fine, the hierarchy changed underneath it -- naming both
          // diverged Organisations so the reviewer can see which two.
          expect(approveRes.status).toBe(409);
          expect(approveRes.body.error).toMatch(/different organisations/i);
          expect(approveRes.body.error).toContain(
            `(${expectedSourceOrgId} and ${expectedDestOrgId})`
          );

          // The whole approval transaction rolled back: the row is still
          // `pending`, column for column, including the `status`,
          // `processed_by` and `processed_at` the status UPDATE writes
          // BEFORE `executeTransfer` runs inside that same transaction.
          expect(rowAfter).toEqual(pendingRowBefore);
          expect(rowAfter.status).toBe('pending');
          expect(rowAfter.processed_by).toBeNull();
          expect(rowAfter.processed_at).toBeNull();

          // ...and no membership change, for anyone.
          expect(await snapshotMembershipState(observedUserIds)).toEqual(beforeApproval);
          expect(pendingUserDirect.team_id).toBe(world.sourceTeamId);
          expect(pendingUserDirect.role).toBe(base.transferredUserRole);
        } else {
          // Either the Organisations still agree, or the APPROVING user is
          // a Global_Manager. The Initiating_Admin never is (a
          // Global_Manager initiator would have executed the transfer
          // immediately and left no request to approve), so every success
          // here is the approver's exemption alone.
          expect(approveRes.status).toBe(200);
          expect(rowAfter.status).toBe('approved');
          expect(rowAfter.processed_by).toBe(approver.id);
          expect(pendingUserDirect.team_id).toBe(world.destinationTeamId);
        }
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    600000
  );

  // -------------------------------------------------------------------
  // Route examples (task 9.10)
  // -------------------------------------------------------------------

  /**
   * Four single-input conditions that have no useful input space to
   * generalise over, so they are stated as EXAMPLES rather than as
   * properties: each is a fixed shape of the request, not a family of them.
   *
   * - Requirement 1.3, an unknown `:userId`, and Requirement 1.2's
   *   contrast, an unknown `targetTeamId`. These two are the file's only
   *   statement of the 404-versus-400 distinction the route's steps 1 and 4
   *   draw: the addressed RESOURCE being unknown is a 404, a bad BODY FIELD
   *   is a 400. Property 28 generates an unknown `targetTeamId` but asserts
   *   the self-transfer 400 over the top of it, so Requirement 1.2's own
   *   status was otherwise unasserted anywhere in the server suite.
   * - Requirement 1.4, no Direct_Membership. Unreachable from
   *   `scenarioArb`, which seeds one for every Transferred_User because
   *   every property in this file needs a Source_Team to move out of.
   * - Requirement 1.5, already in the destination. Deliberately excluded
   *   from `teamPlanArb`, which maps a both-branches-zero shape away rather
   *   than generating a transfer to the Team the user is already in.
   * - Requirement 3.5, `email_verified` true with no verification email.
   *   The `true` half rides along on Property 10's column round-trip; the
   *   negative half -- that no verification email is sent -- is a statement
   *   about a call that does NOT happen, which no generator makes more
   *   convincing.
   *
   * All four are seeded through the same harness as the properties above,
   * on one fixed hierarchy: an Organisation, one shared Sub_Team, then a
   * one-Team source branch and a one-Team destination branch.
   */

  // Comfortably past any serial value these suites reach, and asserted
  // absent below rather than assumed.
  const P910_UNKNOWN_ID = 2000000000;

  // The `../services/EmailService` mock at the top of this file returns a
  // FRESH object of `jest.fn()`s from each construction, so there is no
  // single shared spy to assert against. `mock.results` holds every one of
  // those objects (a constructor that returns an object overrides `this`,
  // so the returned value IS the instance callers used), which makes the
  // total call count across all of them the observable quantity. Required
  // here rather than beside `usersRouter` at the top so the assertion it
  // serves is visible next to it.
  const EmailServiceMock = require('../services/EmailService');

  /**
   * How many times `sendVerificationEmail` has been called on ANY
   * `EmailService` instance built since this module was loaded.
   *
   * Read as a before/after delta rather than as an absolute, so the
   * assertion stays a statement about the request under test even though
   * Jest is not configured to clear mocks between tests
   * (no `clearMocks`/`resetMocks` in `package.json`'s Jest block).
   *
   * @returns {number}
   */
  function verificationEmailCallCount() {
    return EmailServiceMock.mock.results.reduce((total, result) => {
      const sendVerificationEmail = result.value && result.value.sendVerificationEmail;
      return total + (sendVerificationEmail?.mock ? sendVerificationEmail.mock.calls.length : 0);
    }, 0);
  }

  /**
   * A fixed scenario in the shape `seedWorld` consumes, standing in for a
   * generated one.
   *
   * @param {{isGlobalManager?: boolean, placementKey?: string|null,
   *   transferredUserRole?: 'member'|'admin'}} [options]
   *   `placementKey` is the plan label the actor holds a direct `admin` row
   *   on, or null for no membership at all.
   * @returns {object}
   */
  function exampleScenario(options = {}) {
    const { isGlobalManager = false, placementKey = null, transferredUserRole = 'member' } = options;
    const plan = buildTeamPlan({ sharedDepth: 1, sourceBranch: 1, destBranch: 1 });

    return {
      plan,
      actor: {
        isGlobalManager,
        placement: placementKey === null ? null : { teamKey: placementKey, role: 'admin' }
      },
      transferredUserRole,
      channelHasGroup: plan.teamKeys.map(() => true)
    };
  }

  // Requirement 1.3
  it(
    'answers 404 when :userId names no users row, for a numeric id and for a non-numeric one alike',
    async () => {
      const tracker = createTracker();

      try {
        // A Global_Manager actor: the `user:team:transfer` resolver
        // short-circuits on that leg before it looks for a Source_Team, so
        // the request reaches step 1 and is answered on the merits.
        // Requirement 2.2's source leg cannot grant here -- there is no
        // user to read a Direct_Membership from -- so any other actor would
        // make this a statement about the resolver's 403 instead.
        const world = await seedWorld(exampleScenario({ isGlobalManager: true }), tracker);

        const existing = await pool.query('SELECT id FROM users WHERE id = $1', [P910_UNKNOWN_ID]);
        expect(existing.rows).toHaveLength(0);

        const observedUserIds = [world.transferredUser.id, world.actor.id];
        const before = await snapshotMembershipState(observedUserIds);

        const res = await postTransfer(app, { ...world, transferredUser: { id: P910_UNKNOWN_ID } });

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('User not found');

        // A non-numeric `:userId` names no row either, and is answered with
        // the same 404 rather than reaching Postgres as an invalid integer
        // literal (which would surface as a 500).
        actAs(world.actor);
        const nonNumeric = await request(app)
          .post('/api/users/not-a-user/transfer')
          .send({ targetTeamId: world.destinationTeamId });

        expect(nonNumeric.status).toBe(404);
        expect(nonNumeric.body.error).toBe('User not found');

        expect(await accessRequestsTouching(observedUserIds)).toHaveLength(0);
        expect(await snapshotMembershipState(observedUserIds)).toEqual(before);
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    120000
  );

  // Requirement 1.2 -- the contrast to Requirement 1.3 above: an unknown
  // addressed resource is 404, an unknown body field is 400.
  it(
    'answers 400, not 404, when targetTeamId names no teams row, and leaves every row unchanged',
    async () => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(exampleScenario({ isGlobalManager: true }), tracker);

        const existing = await pool.query('SELECT id FROM teams WHERE id = $1', [P910_UNKNOWN_ID]);
        expect(existing.rows).toHaveLength(0);

        const observedUserIds = [world.transferredUser.id, world.actor.id];
        const before = await snapshotMembershipState(observedUserIds);

        const res = await postTransfer(app, world, { targetTeamId: P910_UNKNOWN_ID });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/target team not found/i);
        // Step 4's own 400, not step 3's validation shape: the id is a
        // perfectly well-formed positive integer, it just names nothing.
        expect(res.body.errors).toBeUndefined();

        // Requirement 1.2's second half, in full: no `team_memberships`,
        // `channel_memberships`, `users` or `access_requests` row moved.
        expect(await accessRequestsTouching(observedUserIds)).toHaveLength(0);
        expect(await snapshotMembershipState(observedUserIds)).toEqual(before);
        expect(await storedCallsignSuffixOf(world.transferredUser.id)).toBeNull();

        const direct = await directMembershipOf(world.transferredUser.id);
        expect(direct).not.toBeNull();
        expect(direct.team_id).toBe(world.sourceTeamId);
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    120000
  );

  // Requirement 1.4
  it(
    'answers 400 with a no-current-team message when the user holds no Direct_Membership',
    async () => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(exampleScenario({ isGlobalManager: true }), tracker);

        // `seedWorld` gives every Transferred_User a Direct_Membership,
        // because every property above needs a Source_Team; this condition
        // is the absence of one, so it is removed here. The `inherited`
        // rows and the `channel_memberships` rows go with it -- a user with
        // no Direct_Membership holds neither.
        await pool.query('DELETE FROM team_memberships WHERE user_id = $1', [
          world.transferredUser.id
        ]);
        await pool.query('DELETE FROM channel_memberships WHERE user_id = $1', [
          world.transferredUser.id
        ]);
        expect(await directMembershipOf(world.transferredUser.id)).toBeNull();

        // A Global_Manager again, for a sharper reason than above: the
        // resolver's source leg reads the Direct_Membership that no longer
        // exists, so only the Global_Manager leg (or an admin of the
        // DESTINATION team) can authorize this request at all -- which is
        // the consequence the route's own doc comment names.
        const res = await postTransfer(app, world);

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no current team/i);
        expect(res.body.errors).toBeUndefined();

        expect(await accessRequestsTouching([world.transferredUser.id, world.actor.id])).toHaveLength(0);
        expect(await directMembershipOf(world.transferredUser.id)).toBeNull();
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    120000
  );

  // Requirement 1.5
  it(
    'answers 400 with an already-a-member message when the Direct_Membership already names the destination',
    async () => {
      const tracker = createTracker();

      try {
        const world = await seedWorld(
          exampleScenario({ isGlobalManager: true, transferredUserRole: 'admin' }),
          tracker
        );

        const observedUserIds = [world.transferredUser.id, world.actor.id];
        const before = await snapshotMembershipState(observedUserIds);

        // The destination submitted IS the Team the user's
        // Direct_Membership names, which is exactly Requirement 1.5's
        // condition.
        const res = await postTransfer(app, world, { targetTeamId: world.sourceTeamId });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/already a member of that team/i);
        expect(res.body.errors).toBeUndefined();

        expect(await accessRequestsTouching(observedUserIds)).toHaveLength(0);
        expect(await snapshotMembershipState(observedUserIds)).toEqual(before);

        // No demotion either: an `admin` Transferred_User is generated here
        // so that Requirement 10.1's `role = 'member'` write, which a
        // transfer would have made, is observably absent.
        const direct = await directMembershipOf(world.transferredUser.id);
        expect(direct).not.toBeNull();
        expect(direct.team_id).toBe(world.sourceTeamId);
        expect(direct.role).toBe('admin');
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    120000
  );

  // Requirement 3.5
  it(
    'creates a Transfer_Request with email_verified true and sends no verification email',
    async () => {
      const tracker = createTracker();

      try {
        // A direct `admin` row on the source branch's own Team administers
        // the source side only ('source1' is absent from the destination's
        // Ancestor_Chain), which is Requirement 2.5's branch -- the only
        // one that creates a Transfer_Request.
        const world = await seedWorld(exampleScenario({ placementKey: 'source1' }), tracker);

        // The sentinel that keeps the assertion below from being vacuous:
        // `EmailService` really is constructed in this module graph
        // (`TeamTransferService` builds one at module scope), so a zero
        // total means "not called" rather than "never instrumented".
        expect(EmailServiceMock.mock.results.length).toBeGreaterThan(0);
        const verificationEmailsBefore = verificationEmailCallCount();

        const res = await postTransfer(app, world, { justification: 'Relocating to the new station' });

        expect(res.status).toBe(202);
        expect(res.body.status).toBe('pending_approval');

        const requests = await teamChangeRequestsFor(world.transferredUser.id);
        expect(requests).toHaveLength(1);

        // Requirement 3.5: the Initiating_Admin's identity is already
        // established by the authenticated session, so the row is created
        // pre-verified -- which is also what makes it visible to
        // `GET /api/requests/pending`, whose query filters on this column.
        expect(requests[0].email_verified).toBe(true);
        expect(requests[0].email_verification_token).toBeNull();

        // ...and no verification email was sent to anyone as part of it.
        expect(verificationEmailCallCount()).toBe(verificationEmailsBefore);
      } finally {
        tracker.mergeInto(suiteTracker);
        await cleanupWorld(tracker);
      }
    },
    120000
  );
});
