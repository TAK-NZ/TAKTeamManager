/**
 * Property 1 of the `team-member-transfer` spec (task 10.9): both transfer
 * paths produce identical state.
 *
 * =====================================================================
 * WHY THIS IS ITS OWN FILE
 * =====================================================================
 *
 * Every other `TeamTransferService` property observes ONE run of a
 * transfer, so `TeamTransferService.test.js`'s harness builds ONE
 * in-memory store and binds the module mocks to it. This property
 * observes TWO runs of the same generated scenario against IDENTICALLY
 * SEEDED starting states and diffs the results, so it needs two
 * independent stores. Sharing that file's single-store harness would mean
 * either reseeding it between runs (losing the first run's end state
 * before it can be compared) or teaching it a second store (changing a
 * harness eleven other properties depend on). Hence a separate file with
 * its own two-store harness.
 *
 * It is deliberately NOT an `*.integration.test.js` file: it runs under
 * `npm test` and mocks `pool`, like the rest of this service's suite.
 *
 * =====================================================================
 * WHAT MAKES THIS NOT A TAUTOLOGY
 * =====================================================================
 *
 * "Call one function twice with the same arguments, observe the same
 * result" would prove nothing. The two runs here are driven with the
 * parameter sets their REAL callers construct, which differ in four ways
 * (all four verified explicitly by `expectPathsWereDrivenDifferently`
 * below, so the difference cannot silently evaporate):
 *
 *   | parameter              | immediate (`server/routes/users.js`)      | approval (`RequestApprovalService`)       |
 *   |------------------------|-------------------------------------------|-------------------------------------------|
 *   | `callsignSuffix`       | the submitted body value -- link (a)      | `callsignSuffixOverride`, absent here     |
 *   | `requestCallsignSuffix`| always null (no Transfer_Request exists)  | `access_requests.callsign_suffix`, link (b) |
 *   | `expectedSourceTeamId` | not passed                                | `request.current_team_id`                 |
 *   | `transferRequestId` / `initiatedBy` | not passed                   | `request.id` / `request.initiated_by`     |
 *
 * So the approval run exercises Requirement 11.1's staleness comparison
 * and resolves its Callsign_Suffix through a different link of
 * Requirement 9.7's chain than the immediate run does, and still has to
 * land on the same state.
 *
 * =====================================================================
 * WHAT IS AND IS NOT ALLOWED TO DIFFER
 * =====================================================================
 *
 * The genuinely path-dependent outputs are exactly `transferRequestId`,
 * `initiatedBy`, `viaRequest`, and the audit `details` keys derived from
 * them (Requirement 14.3 -- an immediate transfer has no request id to
 * record). Those are asserted per-path against their expected values
 * rather than diffed. EVERYTHING else -- `team_memberships`,
 * `channel_memberships`, `users`, `user_cache`, the enqueued
 * Sync_Operations, the Authentik attribute push, the notification email,
 * and the rest of the audit row -- is diffed. Making that distinction
 * explicit is the point: a blind diff of two whole stores would either
 * fail on the request id or be weakened to ignore whole tables.
 *
 * The actor is held FIXED across the two runs. `actorId` reaches the
 * Sync_Operations' `published_by` and the audit row's `user_id`, so
 * varying it would produce a difference that says nothing about the path.
 * `initiatedBy` is what carries "a different person asked for this" on
 * the approval run, and it is one of the four path-dependent values.
 *
 * The callsign derivation runs FOR REAL (`jest.requireActual`), the way
 * Properties 16 and 17 established. With the harness's default null
 * callsign, `applyPostCommitEffects` skips its `user_cache` mirror,
 * Authentik push, and notification wholesale -- and a diff of two skipped
 * effects is vacuously equal. Running the derivation is what gives this
 * property a non-empty `user_cache` on both sides to compare.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
  isAdmin: jest.fn()
}));
jest.mock('./TeamMembershipService', () => ({
  addUserToTeam: jest.fn()
}));
jest.mock('./EventPublisher', () => ({
  publishOperation: jest.fn()
}));
jest.mock('./userAttributes', () => ({
  generateCallsign: jest.fn(),
  updateUserAttributes: jest.fn()
}));

const mockSendEmail = jest.fn();
jest.mock('./EmailService', () => jest.fn().mockImplementation(() => ({
  sendEmail: mockSendEmail
})));

const mockLoggerInstance = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
jest.mock('../config/logger', () => ({
  createLogger: jest.fn(() => mockLoggerInstance)
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const pool = require('../config/database');
const Team = require('../models/Team');
const TeamMembershipService = require('./TeamMembershipService');
const EventPublisher = require('./EventPublisher');
const UserAttributesService = require('./userAttributes');
const { TeamTransferService } = require('./TeamTransferService');

const {
  hierarchyArb,
  channelLayoutArb,
  callsignSuffixArb,
  TRANSFERRED_USER_ID,
  ADMIN_CANDIDATE_USER_IDS
} = require('./__fixtures__/transferArbitraries');

/**
 * The real `userAttributes` module, reached past this file's own
 * `jest.mock('./userAttributes')`. `computeCallsignAttributes` still reads
 * the Callsign_Suffix through the mocked `pool` and the Ancestor_Chain
 * through the mocked `Team.getAncestorChain`, so it runs its actual
 * derivation against the GENERATED hierarchy.
 */
const realUserAttributesService = jest.requireActual('./userAttributes');

/**
 * The user who executes BOTH runs -- the Initiating_Admin on the immediate
 * path, the approving admin on the approval path. Held fixed on purpose;
 * see the file header.
 */
const ACTOR_USER_ID = ADMIN_CANDIDATE_USER_IDS[0];

/**
 * The Initiating_Admin recorded in `access_requests.initiated_by`, which
 * only the approval run has. Deliberately NOT `ACTOR_USER_ID`: on the
 * approval path the person who asked and the person who approved are
 * different people, and `initiatedBy` is one of the four values allowed to
 * differ between the paths.
 */
const INITIATING_ADMIN_USER_ID = ADMIN_CANDIDATE_USER_IDS[1];

/** The `access_requests.id` the approval run's Transfer_Request carries. */
const TRANSFER_REQUEST_ID = 7701;

/**
 * The audit `details` keys Requirement 14.3 makes path-dependent. Stripped
 * before the audit rows are diffed, then asserted per-path on their own.
 */
const PATH_DEPENDENT_DETAIL_KEYS = ['viaRequest', 'requestId', 'initiatedBy'];

// ---------------------------------------------------------------------------
// The two-store harness
// ---------------------------------------------------------------------------

const ascending = (a, b) => a - b;

/**
 * A comparator over the named columns, total for the mixed
 * number/string/null values these rows hold, so a canonical ordering
 * exists for the diff.
 *
 * @param {...string} keys
 * @returns {(a: object, b: object) => number}
 */
function byColumns(...keys) {
  return (a, b) => {
    for (const key of keys) {
      const left = a[key];
      const right = b[key];

      if (left === right) {
        continue;
      }
      if (left === null || left === undefined) {
        return -1;
      }
      if (right === null || right === undefined) {
        return 1;
      }

      return left < right ? -1 : 1;
    }

    return 0;
  };
}

/**
 * A model of `TeamMembershipService.addUserToTeam`'s documented effects,
 * applied to one store. Same model the single-store suite uses: delete the
 * user's `team_memberships` rows, insert the direct row plus one
 * `inherited` row per strict ancestor, insert a `channel_memberships` row
 * per Primary_Channel of the destination Ancestor_Chain, enqueue one
 * `add_user_to_group` per such Channel holding an `authentik_group_id`,
 * then `assign_user_to_global_channels`.
 *
 * That service is explicitly not modified by this spec and has its own
 * suite, so modelling it keeps this property about `TeamTransferService`
 * while still producing an observable end-state. Because it is a model of
 * a DEPENDENCY rather than of the code under test, and because BOTH runs
 * get the identical model, it cannot manufacture the equality this
 * property asserts: the two runs reach it through different parameter
 * sets, and any divergence `executeTransfer` introduced before or after it
 * still shows up in the diff.
 */
async function applyAddUserToTeam(store, scenario, client, { userId, teamId, role, actorId }) {
  const { hierarchy, channels } = scenario;
  const chainIds = hierarchy.ancestorIdsOf(teamId);

  store.teamMemberships = store.teamMemberships.filter((row) => row.user_id !== userId);

  store.teamMemberships.push({
    user_id: userId,
    team_id: teamId,
    role,
    inherited_from_team_id: null
  });

  for (const ancestorId of chainIds) {
    if (ancestorId === teamId) {
      continue;
    }
    store.teamMemberships.push({
      user_id: userId,
      team_id: ancestorId,
      role: 'inherited',
      inherited_from_team_id: teamId
    });
  }

  for (const channel of channels.primaryChannelsForChain(chainIds)) {
    const alreadyHeld = store.channelMemberships.some(
      (row) => row.user_id === userId && row.channel_id === channel.id
    );

    if (!alreadyHeld) {
      // ON CONFLICT DO NOTHING
      store.channelMemberships.push({
        channel_id: channel.id,
        user_id: userId,
        permission: 'read_write'
      });
    }

    if (channel.authentik_group_id) {
      await EventPublisher.publishOperation('add_user_to_group', {
        target_user_id: userId,
        target_group_id: channel.authentik_group_id
      }, actorId, client);
    }
  }

  await EventPublisher.publishOperation('assign_user_to_global_channels', {
    target_user_id: userId
  }, actorId, client);

  return { success: true };
}

/**
 * Builds ONE independent store for one path's run and binds every module
 * mock to it.
 *
 * Called once per path with the SAME scenario, which is what makes the two
 * starting states identical: everything seeded below is a function of the
 * generated scenario alone. `startingState` is captured by the caller
 * before the run and asserted equal across the two runs, so "identically
 * seeded" is verified rather than assumed.
 *
 * The seeded state is what a previous `addUserToTeam` would have left: a
 * Direct_Membership on the Source_Team holding `priorRole`, an `inherited`
 * row per strict ancestor of it, a `channel_memberships` row for every
 * Channel owned by a Team in the Source_Team's Ancestor_Chain, and the
 * generated Deployment_Channel rows (whose `channel_id` names no
 * `channels` row at all).
 *
 * @param {object} scenario a `pathEquivalenceScenarioArb` value
 * @returns {object} the harness for this path
 */
function createPathHarness(scenario) {
  const { hierarchy, channels, sourceTeamId, destinationTeamId, priorRole } = scenario;
  const userId = TRANSFERRED_USER_ID;
  const actorId = ACTOR_USER_ID;

  const sourceChainIds = hierarchy.ancestorIdsOf(sourceTeamId);

  const store = {
    users: [
      {
        id: userId,
        username: `user-${userId}`,
        email: `user-${userId}@example.test`,
        first_name: 'Casey',
        last_name: 'Elsen',
        is_active: true,
        is_team_device: false,
        authentik_user_id: 9000 + userId,
        callsign_suffix: scenario.storedCallsignSuffix ?? null
      }
    ],
    teamMemberships: [
      {
        user_id: userId,
        team_id: sourceTeamId,
        role: priorRole,
        inherited_from_team_id: null
      },
      ...sourceChainIds
        .filter((id) => id !== sourceTeamId)
        .map((id) => ({
          user_id: userId,
          team_id: id,
          role: 'inherited',
          inherited_from_team_id: sourceTeamId
        }))
    ],
    channelMemberships: [
      ...channels.channelsForChain(sourceChainIds).map((channel) => ({
        channel_id: channel.id,
        user_id: userId,
        permission: 'read_write'
      })),
      ...channels.deploymentChannelIds.map((channelId) => ({
        channel_id: channelId,
        user_id: userId,
        permission: 'read_write'
      }))
    ],
    userCache: [],
    auditLogs: [],
    syncOperations: []
  };

  const findUser = (id) => store.users.find((row) => row.id === id) || null;
  const findChannel = (id) => channels.channels.find((channel) => channel.id === id) || null;

  const unexpected = (label, sql) => {
    throw new Error(`Unexpected ${label} SQL in the path-equivalence harness:\n${sql}`);
  };

  /**
   * The transaction client. Both real callers own the transaction
   * lifecycle themselves, so BEGIN/COMMIT are dispatched here (and
   * recorded) rather than ignored: `applyPostCommitEffects` must run
   * strictly after COMMIT on both paths, and this file drives both paths
   * the way their callers do.
   */
  const client = {
    query: jest.fn(async (sql, params = []) => {
      const text = String(sql);

      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) {
        store.transactionStatements = store.transactionStatements || [];
        store.transactionStatements.push(text.trim().toUpperCase());

        return { rows: [], rowCount: 0 };
      }

      // Step 1 -- the locked Direct_Membership read.
      if (/FROM team_memberships/.test(text) && /FOR UPDATE/.test(text)) {
        const rows = store.teamMemberships
          .filter((row) => row.user_id === params[0] && row.inherited_from_team_id === null)
          .map((row) => ({ team_id: row.team_id, role: row.role }));

        return { rows, rowCount: rows.length };
      }

      // Step 3 -- the conditional Callsign_Suffix write.
      if (/UPDATE users SET callsign_suffix/.test(text)) {
        const user = findUser(params[1]);

        if (user) {
          user.callsign_suffix = params[0];
        }

        return { rows: [], rowCount: user ? 1 : 0 };
      }

      // Step 3 -- chain link (c), read on the client.
      if (/SELECT callsign_suffix\s+FROM users/.test(text)) {
        const user = findUser(params[0]);

        return {
          rows: user ? [{ callsign_suffix: user.callsign_suffix }] : [],
          rowCount: user ? 1 : 0
        };
      }

      // Step 5 -- the revocation delete.
      if (/DELETE FROM channel_memberships/.test(text)) {
        const [targetUserId, retainedTeamIds] = params;
        const revoked = [];

        store.channelMemberships = store.channelMemberships.filter((row) => {
          if (row.user_id !== targetUserId) {
            return true;
          }

          const channel = findChannel(row.channel_id);

          // No `channels` row to join against: the `USING channels c` join
          // cannot reach this row.
          if (!channel) {
            return true;
          }

          if (retainedTeamIds.includes(channel.team_id)) {
            return true;
          }

          revoked.push({
            channel_id: channel.id,
            authentik_group_id: channel.authentik_group_id
          });

          return false;
        });

        return { rows: revoked, rowCount: revoked.length };
      }

      return unexpected('client', text);
    })
  };

  /**
   * The shared pool: `applyPostCommitEffects`'s statements, plus the
   * `SELECT callsign_suffix FROM users` the REAL `computeCallsignAttributes`
   * issues off the pool.
   */
  pool.query.mockImplementation(async (sql, params = []) => {
    const text = String(sql);

    if (/SELECT callsign_suffix\s+FROM users/.test(text)) {
      const user = findUser(params[0]);

      return {
        rows: user ? [{ callsign_suffix: user.callsign_suffix }] : [],
        rowCount: user ? 1 : 0
      };
    }

    if (/SELECT authentik_user_id, email, first_name, is_team_device/.test(text)) {
      const user = findUser(params[0]);

      return {
        rows: user
          ? [{
            authentik_user_id: user.authentik_user_id,
            email: user.email,
            first_name: user.first_name,
            is_team_device: user.is_team_device
          }]
          : [],
        rowCount: user ? 1 : 0
      };
    }

    if (/INSERT INTO user_cache/.test(text)) {
      const [cacheUserId, takCallsign, takColor, takRole, callsignSuffix] = params;
      const user = findUser(cacheUserId);

      if (!user || user.authentik_user_id == null) {
        return { rows: [], rowCount: 0 };
      }

      // `user_cache.authentik_id` is a varchar and `users.authentik_user_id`
      // an integer, so the key is the string form -- the `::text` cast the
      // statement carries.
      const authentikId = String(user.authentik_user_id);
      const mirrorsSuffix = params.length > 4;
      let row = store.userCache.find((cached) => cached.authentik_id === authentikId);

      if (!row) {
        row = {
          authentik_id: authentikId,
          username: user.username,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          is_active: user.is_active ?? true,
          callsign_suffix: null
        };
        store.userCache.push(row);
      }

      row.tak_callsign = takCallsign;
      row.tak_color = takColor;
      row.tak_role = takRole;

      if (mirrorsSuffix) {
        row.callsign_suffix = callsignSuffix;
      }

      return { rows: [], rowCount: 1 };
    }

    if (/INSERT INTO audit_logs/.test(text)) {
      store.auditLogs.push({
        user_id: params[0],
        action: 'user.team_transfer',
        resource_type: 'user',
        resource_id: params[1],
        details: JSON.parse(params[2])
      });

      return { rows: [], rowCount: 1 };
    }

    return unexpected('pool', text);
  });

  Team.getAncestorChain.mockImplementation(async (teamId) => hierarchy.ancestorChainOf(teamId));
  Team.isAdmin.mockImplementation(async () => false);

  TeamMembershipService.addUserToTeam.mockImplementation(
    async (addUserId, addTeamId, addRole, addActorId, addClient) =>
      applyAddUserToTeam(store, scenario, addClient, {
        userId: addUserId,
        teamId: addTeamId,
        role: addRole,
        actorId: addActorId
      })
  );

  EventPublisher.publishOperation.mockImplementation(
    async (operationType, payload, publishedBy, publishedClient) => {
      store.syncOperations.push({
        operationType,
        payload,
        publishedBy,
        // Requirements 6.8 / 7.3: enqueued on the transfer's own
        // transaction, so a rollback leaves nothing behind. Recorded
        // because "identical Sync_Operations" includes being on the
        // transaction on both paths, not just carrying the same payloads.
        onTransaction: publishedClient === client
      });

      return { id: store.syncOperations.length };
    }
  );

  // The real derivation, over the generated hierarchy. Called as a method
  // so its `this.computeCallsignAttributes` delegation resolves.
  UserAttributesService.generateCallsign.mockImplementation((generateUserId, teamId) =>
    realUserAttributesService.generateCallsign(generateUserId, teamId));
  UserAttributesService.updateUserAttributes.mockResolvedValue(true);

  return {
    store,
    client,
    userId,
    actorId,
    sourceTeamId,
    destinationTeamId,
    snapshot: () => JSON.parse(JSON.stringify(store))
  };
}

// ---------------------------------------------------------------------------
// Driving each path the way its real caller does
// ---------------------------------------------------------------------------

/**
 * The parameters `server/routes/users.js`'s Dual_Admin branch passes.
 *
 * Link (a) carries the submitted `callsignSuffix`; link (b) is null "by
 * construction on this path: there is no Transfer_Request". No
 * `expectedSourceTeamId` (nothing recorded a baseline to be stale
 * against) and no `transferRequestId`/`initiatedBy`.
 *
 * `req.body.callsignSuffix || null` is reproduced exactly, including the
 * `|| null`: the route's `express-validator` `.trim()` has already
 * collapsed a whitespace-only submission to `''` by this point.
 */
function immediatePathParams(scenario, harness) {
  return {
    userId: harness.userId,
    destinationTeamId: harness.destinationTeamId,
    actorId: harness.actorId,
    actorIsGlobalManager: scenario.actorIsGlobalManager,
    callsignSuffix: scenario.suppliedCallsignSuffix || null,
    requestCallsignSuffix: null
  };
}

/**
 * The parameters `RequestApprovalService`'s `case 'team_change'` passes.
 *
 * The same scenario arrives through DIFFERENT parameters: the suffix on
 * link (b) (`access_requests.callsign_suffix`, stored when the
 * Transfer_Request was created) with link (a) absent because no
 * `callsignSuffix` was supplied on the approve body, plus the
 * Transfer_Request's recorded `current_team_id` as Requirement 11.1's
 * staleness baseline and its id and `initiated_by` for Requirement 14.3.
 *
 * `actorIsGlobalManager` is the APPROVING user's status (Requirement
 * 11.6), which is `ACTOR_USER_ID`'s -- the same person driving the
 * immediate run, so the same value.
 */
function approvalPathParams(scenario, harness) {
  const request = {
    id: TRANSFER_REQUEST_ID,
    existing_user_id: harness.userId,
    current_team_id: scenario.sourceTeamId,
    target_team_id: scenario.destinationTeamId,
    callsign_suffix: scenario.suppliedCallsignSuffix,
    initiated_by: INITIATING_ADMIN_USER_ID
  };

  return {
    userId: request.existing_user_id,
    destinationTeamId: request.target_team_id,
    actorId: harness.actorId,
    actorIsGlobalManager: scenario.actorIsGlobalManager,
    expectedSourceTeamId: request.current_team_id,
    callsignSuffix: null,
    requestCallsignSuffix: request.callsign_suffix || null,
    transferRequestId: request.id,
    initiatedBy: request.initiated_by
  };
}

/**
 * Runs one path end to end against its own store and returns everything
 * observable about it.
 *
 * `jest.clearAllMocks()` first, so the email and Authentik-push call logs
 * belong to this run alone; `createPathHarness` re-installs every
 * implementation immediately after (clearing removes recorded calls, not
 * implementations).
 *
 * @param {object} scenario
 * @param {'immediate'|'approval'} path
 */
async function runTransferPath(scenario, path) {
  jest.clearAllMocks();

  const harness = createPathHarness(scenario);
  const startingState = harness.snapshot();

  const params = path === 'immediate'
    ? immediatePathParams(scenario, harness)
    : approvalPathParams(scenario, harness);

  // Both callers own the transaction; `executeTransfer` issues no
  // BEGIN/COMMIT of its own.
  await harness.client.query('BEGIN');
  const outcome = await TeamTransferService.executeTransfer(harness.client, params);
  await harness.client.query('COMMIT');

  const effects = await TeamTransferService.applyPostCommitEffects(outcome);

  return {
    path,
    harness,
    startingState,
    params,
    outcome,
    effects,
    notifications: mockSendEmail.mock.calls.map(([recipient, template, variables]) => ({
      recipient,
      template,
      variables
    })),
    authentikPushes: UserAttributesService.updateUserAttributes.mock.calls.map(
      ([authentikUserId, attributes]) => ({ authentikUserId, attributes })
    )
  };
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/**
 * The four tables Property 1 compares, each in a canonical row order so
 * the comparison is over CONTENT rather than over insertion order (which
 * no requirement constrains).
 *
 * @param {object} store
 */
function canonicalTables(store) {
  return {
    users: [...store.users].sort(byColumns('id')),
    teamMemberships: [...store.teamMemberships]
      .sort(byColumns('user_id', 'team_id', 'role', 'inherited_from_team_id')),
    channelMemberships: [...store.channelMemberships]
      .sort(byColumns('user_id', 'channel_id')),
    userCache: [...store.userCache].sort(byColumns('authentik_id'))
  };
}

/**
 * The enqueued Sync_Operations, compared IN ISSUE ORDER. Both paths run
 * the same steps in the same order, so the sequence is itself an
 * observable: a reordering (revocations before the additive half, say)
 * would be a real difference in what the Authentik worker sees.
 *
 * @param {object} store
 */
function canonicalSyncOperations(store) {
  return store.syncOperations.map((operation) => ({
    operationType: operation.operationType,
    payload: operation.payload,
    publishedBy: operation.publishedBy,
    onTransaction: operation.onTransaction
  }));
}

/**
 * The audit rows with Requirement 14.3's path-dependent `details` keys
 * removed. Those three are asserted per-path by
 * `expectPathDependentOutputs`; everything else about the row -- actor,
 * resource, source and destination team, prior role, revoked channels,
 * applied suffix -- must match.
 *
 * @param {object} store
 */
function canonicalAuditLogs(store) {
  return store.auditLogs.map((row) => {
    const details = { ...row.details };

    for (const key of PATH_DEPENDENT_DETAIL_KEYS) {
      delete details[key];
    }

    return { ...row, details };
  });
}

/**
 * The `TransferOutcome` minus the three fields that ARE the path. Every
 * other field -- the teams, the prior role, the demotion flag, both
 * Callsign_Suffix fields, the revoked channels and groups -- is compared.
 *
 * @param {object} outcome
 */
function canonicalOutcome(outcome) {
  const comparable = { ...outcome };

  for (const key of ['transferRequestId', 'initiatedBy', 'viaRequest']) {
    delete comparable[key];
  }

  return {
    ...comparable,
    revokedChannelIds: [...comparable.revokedChannelIds].sort(ascending),
    revokedAuthentikGroupIds: [...comparable.revokedAuthentikGroupIds].sort()
  };
}

/**
 * Guards the property against the tautology it would otherwise be: the two
 * runs must actually have been driven with their own caller's parameters,
 * differing in all four documented ways.
 *
 * @param {object} scenario
 * @param {object} immediate a `runTransferPath` result
 * @param {object} approval a `runTransferPath` result
 */
function expectPathsWereDrivenDifferently(scenario, immediate, approval) {
  // Two genuinely independent stores, not one store observed twice.
  expect(immediate.harness.store).not.toBe(approval.harness.store);

  // Requirement 11.1's baseline: passed by the approval caller, absent on
  // the immediate one -- so the approval run really did run the staleness
  // comparison.
  expect(approval.params.expectedSourceTeamId).toBe(scenario.sourceTeamId);
  expect(immediate.params.expectedSourceTeamId).toBeUndefined();

  // Requirement 14.3's request context: approval only.
  expect(approval.params.transferRequestId).toBe(TRANSFER_REQUEST_ID);
  expect(approval.params.initiatedBy).toBe(INITIATING_ADMIN_USER_ID);
  expect(immediate.params.transferRequestId).toBeUndefined();
  expect(immediate.params.initiatedBy).toBeUndefined();

  // Requirement 9.7's chain: the same suffix reaches the two runs through
  // DIFFERENT links, so equality of the resulting `users.callsign_suffix`
  // and callsign is a statement about the resolution chain rather than
  // about two identical arguments.
  if (scenario.suppliedCallsignSuffix) {
    expect(immediate.params.callsignSuffix).toBe(scenario.suppliedCallsignSuffix);
    expect(immediate.params.requestCallsignSuffix).toBeNull();
    expect(approval.params.callsignSuffix).toBeNull();
    expect(approval.params.requestCallsignSuffix).toBe(scenario.suppliedCallsignSuffix);
  } else {
    // Neither supplying link carries anything, so both runs fall through
    // to link (c) -- the user's stored value.
    expect(immediate.params.callsignSuffix).toBeNull();
    expect(immediate.params.requestCallsignSuffix).toBeNull();
    expect(approval.params.callsignSuffix).toBeNull();
    expect(approval.params.requestCallsignSuffix).toBeNull();
  }

  // Both runs committed before their post-commit effects ran, which is how
  // their callers sequence it.
  expect(immediate.harness.store.transactionStatements).toEqual(['BEGIN', 'COMMIT']);
  expect(approval.harness.store.transactionStatements).toEqual(['BEGIN', 'COMMIT']);
}

/**
 * The other half of that guard: the values that ARE allowed to differ do
 * differ, and each carries what its requirement specifies. Without this,
 * an implementation that recorded no request context at all would satisfy
 * the diff perfectly.
 *
 * @param {object} immediate a `runTransferPath` result
 * @param {object} approval a `runTransferPath` result
 */
function expectPathDependentOutputs(immediate, approval) {
  expect(immediate.outcome.viaRequest).toBe(false);
  expect(immediate.outcome.transferRequestId).toBeNull();
  expect(immediate.outcome.initiatedBy).toBeNull();

  expect(approval.outcome.viaRequest).toBe(true);
  expect(approval.outcome.transferRequestId).toBe(TRANSFER_REQUEST_ID);
  expect(approval.outcome.initiatedBy).toBe(INITIATING_ADMIN_USER_ID);

  // Requirement 14.3: the request id and the Initiating_Admin appear in
  // `details` only for a transfer that went through a Transfer_Request, so
  // an immediate transfer's row carries neither key at all rather than
  // carrying them as nulls.
  const [immediateAudit] = immediate.harness.store.auditLogs;
  const [approvalAudit] = approval.harness.store.auditLogs;

  expect(immediateAudit.details.viaRequest).toBe(false);
  expect(immediateAudit.details).not.toHaveProperty('requestId');
  expect(immediateAudit.details).not.toHaveProperty('initiatedBy');

  expect(approvalAudit.details.viaRequest).toBe(true);
  expect(approvalAudit.details.requestId).toBe(TRANSFER_REQUEST_ID);
  expect(approvalAudit.details.initiatedBy).toBe(INITIATING_ADMIN_USER_ID);
}

// ---------------------------------------------------------------------------
// The scenario arbitrary
// ---------------------------------------------------------------------------

/**
 * Every ordered pair of distinct same-Organisation Teams, with the
 * Organisation-root-as-SOURCE pairs drawn as their own weighted branch.
 *
 * Requirement 6.7 is a statement about exactly those pairs -- an
 * Organisation-to-Sub_Team move goes through the same Transfer_Service
 * method as any other transfer, so it must land in the same state on both
 * paths too. They are already inside the uniform pair set, but in a
 * six-Team hierarchy they are a minority of it, and a criterion only a
 * handful of 100 runs reaches is not meaningfully covered.
 * `minTeamsPerOrganisation` of 2 guarantees the branch is non-empty.
 *
 * A cross-Organisation pair is deliberately not generated: both paths
 * reject one before any membership write, and which status each returns is
 * Property 7's subject, not this one's.
 */
function pathEquivalencePairArb(hierarchy) {
  const pairs = [];

  for (const sourceTeamId of hierarchy.teamIds) {
    for (const destinationTeamId of hierarchy.teamIds) {
      if (sourceTeamId !== destinationTeamId
        && hierarchy.sameOrganisation(sourceTeamId, destinationTeamId)) {
        pairs.push({ sourceTeamId, destinationTeamId });
      }
    }
  }

  const organisationSourcePairs = pairs.filter(
    (pair) => hierarchy.depthOf(pair.sourceTeamId) === 0
  );

  return fc.oneof(
    { arbitrary: fc.constantFrom(...pairs), weight: 2 },
    { arbitrary: fc.constantFrom(...organisationSourcePairs), weight: 1 }
  );
}

/**
 * One scenario, run through both paths: the hierarchy and its Channel
 * layout, the Source_Team/Destination_Team pair, the role held before the
 * move, the Transferred_User's stored Callsign_Suffix, the Callsign_Suffix
 * the transfer supplies (or none), and the acting user's Global_Manager
 * status.
 *
 * `suppliedCallsignSuffix` is `null` or a PRESENT value: an absent-looking
 * value (`''`, whitespace) resolves identically to `null` on both paths,
 * which Property 29 already covers link by link. What matters here is that
 * a present value arrives on link (a) in one run and link (b) in the
 * other.
 *
 * `actorIsGlobalManager` is drawn but inert inside a single Organisation
 * -- Requirement 11.6's exemption is only consulted when the two chains'
 * roots differ. It is generated so that a future implementation which
 * started branching on it would show up here as a difference between two
 * runs that pass it identically.
 */
function pathEquivalenceScenarioArb() {
  return hierarchyArb({
    minTeamsPerOrganisation: 2,
    maxTeamsPerOrganisation: 6
  }).chain((hierarchy) =>
    fc.record({
      hierarchy: fc.constant(hierarchy),
      channels: channelLayoutArb(hierarchy),
      pair: pathEquivalencePairArb(hierarchy),
      priorRole: fc.constantFrom('member', 'admin'),
      storedCallsignSuffix: callsignSuffixArb(),
      suppliedCallsignSuffix: fc.option(callsignSuffixArb({ includeAbsent: false }), {
        nil: null
      }),
      actorIsGlobalManager: fc.boolean()
    }).map(({ pair, ...rest }) => ({ ...rest, ...pair }))
  );
}

// ---------------------------------------------------------------------------
// Property 1 (task 10.9)
// ---------------------------------------------------------------------------

/**
 * Requirement 6.1 is the reason `TeamTransferService` exists as one
 * method: an approved transfer and an immediate transfer must produce
 * identical results, so the outcome does not depend on which path was
 * taken. Requirement 6.7 adds that an Organisation-to-Sub_Team move is not
 * a special case of that.
 *
 * The property is a genuine diff between two real runs rather than a
 * comparison against a hand-computed expectation, which is legitimate here
 * -- "the two paths agree" is the requirement, and there is no third
 * reference implementation to agree with. What keeps it honest is the pair
 * of guard functions: `expectPathsWereDrivenDifferently` pins that the two
 * runs really were driven with their own caller's parameter set (different
 * Callsign_Suffix link, staleness baseline present on one side only,
 * request context on one side only, two independent stores), and
 * `expectPathDependentOutputs` pins that the four values allowed to differ
 * really do differ and carry what Requirement 14.3 specifies. Between
 * them, neither "both runs got identical arguments" nor "neither run
 * recorded any request context" can pass.
 *
 * Non-vacuity is asserted three ways, because a diff of two states that
 * nothing happened to is trivially equal: both runs must have moved the
 * `team_memberships` away from the identical seeded state, both must have
 * produced a string callsign (a null one is `applyPostCommitEffects`'s
 * documented skip-everything path), and both must have written the audit
 * row and enqueued at least one Sync_Operation.
 */
// Feature: team-member-transfer, Property 1: Both transfer paths produce identical state
describe('Property 1: Both transfer paths produce identical state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([pathEquivalenceScenarioArb()], { numRuns: 100 })(
    'leaves identical team_memberships, channel_memberships, users, user_cache, and enqueued Sync_Operations whether the transfer ran through the immediate path or through the Transfer_Request approval path',
    async (scenario) => {
      const immediate = await runTransferPath(scenario, 'immediate');
      const approval = await runTransferPath(scenario, 'approval');

      // ---------------------------------------------------------------
      // The premise: identically seeded starting states. Both harnesses
      // derive their seed from the same scenario, so this is a check on
      // the harness rather than on the service -- but without it, an
      // equal END state would not mean the two paths agreed.
      // ---------------------------------------------------------------
      expect(canonicalTables(approval.startingState))
        .toEqual(canonicalTables(immediate.startingState));

      expectPathsWereDrivenDifferently(scenario, immediate, approval);

      // ---------------------------------------------------------------
      // Non-vacuity: something happened, on both sides.
      // ---------------------------------------------------------------
      expect(canonicalTables(immediate.harness.store).teamMemberships)
        .not.toEqual(canonicalTables(immediate.startingState).teamMemberships);
      expect(canonicalTables(approval.harness.store).teamMemberships)
        .not.toEqual(canonicalTables(approval.startingState).teamMemberships);

      // A null callsign is the documented "skip the `user_cache` mirror,
      // the Authentik push, and the notification" path, under which the
      // comparisons below would hold against three untouched effects.
      expect(typeof immediate.effects.callsign).toBe('string');
      expect(typeof approval.effects.callsign).toBe('string');

      expect(immediate.harness.store.auditLogs).toHaveLength(1);
      expect(approval.harness.store.auditLogs).toHaveLength(1);
      expect(immediate.harness.store.syncOperations.length).toBeGreaterThan(0);
      expect(approval.harness.store.syncOperations.length).toBeGreaterThan(0);

      // ---------------------------------------------------------------
      // Requirements 6.1 and 6.7 -- the diff itself.
      //
      // `team_memberships`, `channel_memberships`, `users`, and
      // `user_cache` in one comparison, so a failure names the table that
      // diverged.
      // ---------------------------------------------------------------
      expect(canonicalTables(approval.harness.store))
        .toEqual(canonicalTables(immediate.harness.store));

      // The enqueued Sync_Operations: same operations, same payloads, same
      // attribution, same order, all on the transfer's own transaction.
      expect(canonicalSyncOperations(approval.harness.store))
        .toEqual(canonicalSyncOperations(immediate.harness.store));
      expect(
        canonicalSyncOperations(immediate.harness.store)
          .every((operation) => operation.onTransaction)
      ).toBe(true);

      // The post-commit effects that leave the database: the Authentik
      // attribute push (Requirement 8.3) and the Transferred_User's
      // notification (Requirement 13.1). Neither is one of the five tables,
      // but both are part of "identical results" -- a member must not learn
      // a different callsign depending on how their move was authorised.
      expect(approval.authentikPushes).toEqual(immediate.authentikPushes);
      expect(approval.notifications).toEqual(immediate.notifications);
      expect(approval.effects).toEqual(immediate.effects);

      // The audit row, minus Requirement 14.3's path-dependent keys.
      expect(canonicalAuditLogs(approval.harness.store))
        .toEqual(canonicalAuditLogs(immediate.harness.store));

      // And the outcome each caller shapes its response from, minus the
      // three fields that ARE the path.
      expect(canonicalOutcome(approval.outcome))
        .toEqual(canonicalOutcome(immediate.outcome));

      expectPathDependentOutputs(immediate, approval);
    }
  );
});
