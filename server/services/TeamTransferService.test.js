/**
 * Unit and property-based tests for `TeamTransferService` (spec
 * `team-member-transfer`).
 *
 * =====================================================================
 * FILE STRUCTURE -- read this before appending
 * =====================================================================
 *
 * This file is built to be appended to. Tasks 6.4-6.10 and 7.2-7.6 each
 * own exactly one `describe` block at the bottom, in property order, and
 * all of them share the single harness defined in the middle section.
 * The layout is:
 *
 *   1. Module mocks (below). Every dependency `TeamTransferService`
 *      reaches for is mocked: `pool`, `Team`, `TeamMembershipService`,
 *      `EventPublisher`, `UserAttributesService`, `EmailService`, and the
 *      structured logger. Nothing in this file touches a real database.
 *   2. The in-memory store and `createTransferHarness` -- the shared
 *      harness. One call wires every mock above against one generated
 *      scenario and hands back the `client` to pass to `executeTransfer`.
 *   3. Shared arbitraries (`transferScenarioArb`), composed from
 *      `__fixtures__/transferArbitraries.js` (task 2.1).
 *   4. One `describe` per property, each tagged with the
 *      `// Feature: team-member-transfer, Property N: ...` comment
 *      immediately above it.
 *
 * ---------------------------------------------------------------------
 * The harness
 * ---------------------------------------------------------------------
 *
 * `createTransferHarness(scenario, options)` builds a small in-memory
 * model of the five tables a transfer touches (`users`,
 * `team_memberships`, `channel_memberships`, `user_cache`, `audit_logs`)
 * plus the `sync_operations` queue, seeds the Transferred_User's
 * pre-transfer state from the generated scenario, and returns:
 *
 *   { store, client, poolQuery, snapshot, restore, userId, actorId,
 *     sourceTeamId, destinationTeamId }
 *
 * `client.query` and `pool.query` are `jest.fn()`s that dispatch on the
 * SQL text and mutate `store`, so an assertion can be written against a
 * real end-state rather than against a sequence of recorded calls.
 * `snapshot()` / `restore(snapshot)` exist so a test that needs ROLLBACK
 * semantics (task 6.9) can express them.
 *
 * `TeamMembershipService.addUserToTeam` is mocked with a faithful model
 * of its documented contract (delete the user's `team_memberships` rows,
 * insert the direct row plus one `inherited` row per strict ancestor,
 * insert a `channel_memberships` row per Primary_Channel of the
 * destination Ancestor_Chain, enqueue one `add_user_to_group` per such
 * Channel holding an `authentik_group_id`, then
 * `assign_user_to_global_channels`). That service is explicitly not
 * modified by this spec and is already covered by its own suite, so
 * modelling it -- rather than running it -- keeps these tests about
 * `TeamTransferService` while still producing an observable end-state.
 *
 * Because the model is a mock of a DEPENDENCY, not of the code under
 * test, expectations stay honest: every expected value below is computed
 * by walking the generated hierarchy's own parent-pointer data
 * (`hierarchy.ancestorIdsOf`, `channels.primaryChannelsForChain`, ...),
 * never by calling back into `TeamTransferService`. That is the
 * discipline `TeamVisibilityService.test.js`'s Property 9 established.
 */

jest.mock('../config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../models/Team', () => ({
  getAncestorChain: jest.fn(),
  getDisplayName: jest.fn(),
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
  isAbsentCallsignSuffix,
  TRANSFERRED_USER_ID,
  ADMIN_CANDIDATE_USER_IDS
} = require('./__fixtures__/transferArbitraries');

// ---------------------------------------------------------------------------
// The shared harness
// ---------------------------------------------------------------------------

const ascending = (a, b) => a - b;

/**
 * A faithful model of `TeamMembershipService.addUserToTeam`'s documented
 * effects, applied to the in-memory store.
 *
 * Deliberately expressed against the generated hierarchy's parent
 * pointers and the generated Channel layout rather than as SQL: the real
 * method's recursive CTEs resolve exactly the Ancestor_Chain and exactly
 * the `is_primary = true` Channels of that chain, which is what these
 * two fixture helpers already compute.
 *
 * Sync_Operations go through the mocked `EventPublisher.publishOperation`
 * (threaded with `client`, as the real method does) so that every
 * enqueue in this file -- additive and subtractive -- is recorded in one
 * place.
 */
async function applyAddUserToTeam(store, scenario, client, { userId, teamId, role, actorId }) {
  const { hierarchy, channels } = scenario;
  const chainIds = hierarchy.ancestorIdsOf(teamId);

  // `DELETE FROM team_memberships WHERE user_id = $1` -- every row, direct
  // and inherited alike.
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
 * Wires every mocked dependency against one generated scenario and seeds
 * the Transferred_User's pre-transfer state.
 *
 * The seeded starting state is the state a previous `addUserToTeam` would
 * have left behind, plus the Deployment_Channel rows the generated layout
 * carries: a Direct_Membership on the Source_Team with `priorRole`, an
 * `inherited` row per strict ancestor of the Source_Team, and a
 * `channel_memberships` row for every Channel owned by a Team in the
 * Source_Team's Ancestor_Chain.
 *
 * @param {object} scenario a `transferScenarioArb` value
 * @param {object} [options]
 * @param {number} [options.userId] the Transferred_User
 * @param {number} [options.actorId] the acting user
 * @returns {object} the harness
 */
function createTransferHarness(scenario, options = {}) {
  const { hierarchy, channels, sourceTeamId, destinationTeamId, priorRole } = scenario;
  const {
    userId = TRANSFERRED_USER_ID,
    actorId = ADMIN_CANDIDATE_USER_IDS[0]
  } = options;

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
      // Requirement 7.1's out-of-scope rows: `channel_memberships.channel_id`
      // is polymorphic, so these name no `channels` row at all.
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
    throw new Error(`Unexpected ${label} SQL in the transfer harness:\n${sql}`);
  };

  /**
   * The transaction client `executeTransfer` is handed. Dispatches on the
   * SQL text of each statement the service issues directly (steps 1, 3,
   * and 5); step 4's writes arrive through the mocked
   * `TeamMembershipService.addUserToTeam` instead.
   */
  const client = {
    query: jest.fn(async (sql, params = []) => {
      const text = String(sql);

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

          // No `channels` row to join against: the `USING channels c`
          // join cannot reach this row.
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
   * The shared pool, used only by `applyPostCommitEffects` (tasks
   * 7.2-7.6). `Team.getAncestorChain` is mocked separately, so nothing
   * else reaches this.
   */
  const poolQuery = async (sql, params = []) => {
    const text = String(sql);

    if (/SELECT authentik_user_id, email, first_name, username, is_team_device/.test(text)) {
      const user = findUser(params[0]);

      return {
        rows: user
          ? [{
            authentik_user_id: user.authentik_user_id,
            email: user.email,
            first_name: user.first_name,
            username: user.username,
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
  };

  Team.getAncestorChain.mockImplementation(async (teamId) => hierarchy.ancestorChainOf(teamId));
  // Canonical Display_Name, mirroring the real Team.getDisplayName: root
  // Org prefix (chain[0]) + team name for a Sub_Team, bare name for a root.
  // The transfer-completed email's team_path now resolves via this.
  Team.getDisplayName.mockImplementation(async (teamId) => {
    const chain = hierarchy.ancestorChainOf(teamId);
    if (!chain || chain.length === 0) return null;
    const org = chain[0];
    const team = chain[chain.length - 1];
    if (chain.length === 1 || !team.parent_team_id) return team.name;
    return `${org.callsign_prefix || org.name} - ${team.name}`;
  });
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
        // transaction, so a rollback leaves nothing behind.
        onTransaction: publishedClient === client
      });

      return { id: store.syncOperations.length };
    }
  );

  pool.query.mockImplementation(poolQuery);

  // Deliberately inert defaults: a null callsign is the documented
  // "skip steps 2-4" path of `applyPostCommitEffects`, so a test that
  // cares about the computed identity attributes (tasks 7.2-7.4) must
  // opt in by overriding these.
  UserAttributesService.generateCallsign.mockResolvedValue(null);
  UserAttributesService.updateUserAttributes.mockResolvedValue(true);

  const snapshot = () => JSON.parse(JSON.stringify(store));
  const restore = (taken) => {
    for (const key of Object.keys(store)) {
      store[key] = JSON.parse(JSON.stringify(taken[key]));
    }
  };

  return {
    store,
    client,
    poolQuery,
    snapshot,
    restore,
    userId,
    actorId,
    sourceTeamId,
    destinationTeamId,
    membershipRowsOf: (id) => store.teamMemberships.filter((row) => row.user_id === id),
    channelMembershipRowsOf: (id) => store.channelMemberships.filter((row) => row.user_id === id)
  };
}

// ---------------------------------------------------------------------------
// Shared arbitraries
// ---------------------------------------------------------------------------

/**
 * Every ordered pair of distinct Teams within one Organisation. Includes
 * the Organisation-root-as-source pairs, which is Requirement 6.7's
 * Organisation-to-Sub_Team move, and the Sub_Team-to-Organisation
 * direction as well.
 */
function transferPairArb(hierarchy) {
  const pairs = [];

  for (const sourceTeamId of hierarchy.teamIds) {
    for (const destinationTeamId of hierarchy.teamIds) {
      if (sourceTeamId !== destinationTeamId
        && hierarchy.sameOrganisation(sourceTeamId, destinationTeamId)) {
        pairs.push({ sourceTeamId, destinationTeamId });
      }
    }
  }

  return fc.constantFrom(...pairs);
}

/**
 * One complete transfer scenario: a hierarchy, its Channel layout, the
 * Source_Team/Destination_Team pair, the role held on the Direct_
 * Membership before the move, and the Transferred_User's stored
 * Callsign_Suffix.
 *
 * `minTeamsPerOrganisation` is 2 so a distinct pair always exists.
 * `maxOrganisations` defaults to 1: a scenario spanning two Organisations
 * would be rejected by `executeTransfer` before reaching any membership
 * write, which is Property 7's subject, not this file's.
 *
 * @param {object} [options] forwarded to `hierarchyArb`
 */
function transferScenarioArb(options = {}) {
  return hierarchyArb({
    minTeamsPerOrganisation: 2,
    maxTeamsPerOrganisation: 6,
    ...options
  }).chain((hierarchy) =>
    fc.record({
      hierarchy: fc.constant(hierarchy),
      channels: channelLayoutArb(hierarchy),
      pair: transferPairArb(hierarchy),
      priorRole: fc.constantFrom('member', 'admin'),
      storedCallsignSuffix: callsignSuffixArb()
    }).map(({ pair, ...rest }) => ({ ...rest, ...pair }))
  );
}

// ---------------------------------------------------------------------------
// Property 2 (task 6.4)
// ---------------------------------------------------------------------------

/**
 * Requirements 6.2, 6.3, 6.7, and 10.1 are all statements about the
 * `team_memberships` rows a completed Team_Transfer leaves behind, so one
 * property covers all four: the end-state is a function of the
 * Destination_Team's Ancestor_Chain alone.
 *
 * Nothing about the Source_Team, the prior role, the depth of either
 * side, or the direction of the move appears in the expected value --
 * which is the point. Requirement 6.7's Organisation-to-Sub_Team move is
 * one of the generated pairs rather than a special case, and Requirement
 * 10.1's demotion is asserted as `role === 'member'` over a `priorRole`
 * drawn from both values a Direct_Membership can hold.
 *
 * The expected inherited set is computed by walking the generated
 * parent-pointer data (`hierarchy.ancestorIdsOf`), never by asking the
 * service what it did.
 */
// Feature: team-member-transfer, Property 2: Membership end-state is exactly the destination shape
describe('Property 2: Membership end-state is exactly the destination shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([transferScenarioArb()], { numRuns: 100 })(
    'leaves exactly one Direct_Membership naming the Destination_Team with role member, plus one inherited row per strict ancestor of it and nothing else',
    async (scenario) => {
      const harness = createTransferHarness(scenario);
      const { hierarchy, destinationTeamId } = scenario;

      await TeamTransferService.executeTransfer(harness.client, {
        userId: harness.userId,
        destinationTeamId,
        actorId: harness.actorId,
        actorIsGlobalManager: false
      });

      const rows = harness.membershipRowsOf(harness.userId);

      // Requirement 6.2 -- exactly one Direct_Membership, naming the
      // Destination_Team.
      const directRows = rows.filter((row) => row.inherited_from_team_id === null);
      expect(directRows).toHaveLength(1);
      expect(directRows[0].team_id).toBe(destinationTeamId);

      // Requirement 10.1 -- and holding `member`, whatever `priorRole` was.
      expect(directRows[0].role).toBe('member');

      // Requirement 6.3 -- one `inherited` row per Team of the
      // Destination_Team's Ancestor_Chain other than the Destination_Team
      // itself, each pointing back at the Destination_Team.
      const expectedInheritedTeamIds = hierarchy
        .ancestorIdsOf(destinationTeamId)
        .filter((teamId) => teamId !== destinationTeamId)
        .sort(ascending);

      const inheritedRows = rows.filter((row) => row.role === 'inherited');
      const actualInheritedTeamIds = inheritedRows
        .map((row) => row.team_id)
        .sort(ascending);

      expect(actualInheritedTeamIds).toEqual(expectedInheritedTeamIds);
      expect(
        inheritedRows.every((row) => row.inherited_from_team_id === destinationTeamId)
      ).toBe(true);

      // No fourth kind of row: the direct row plus the inherited rows are
      // the whole end-state, so nothing survives from the Source_Team's
      // own chain except where that chain overlaps the destination's.
      expect(rows).toHaveLength(1 + expectedInheritedTeamIds.length);
    }
  );
});
// ---------------------------------------------------------------------------
// Property 3 (task 6.5)
// ---------------------------------------------------------------------------

/**
 * Requirements 6.4, 7.1, and 7.4 are three views of one `channel_memberships`
 * end-state, so one property covers all three. The two halves of that
 * end-state are deliberately asymmetric, and the asymmetry is the whole
 * reason `channelLayoutArb` generates non-primary Channels:
 *
 *   - the ADDITIVE half (Requirement 6.4) is Primary_Channel-scoped. Step 4
 *     inserts a row for each Primary_Channel of the Destination_Team's
 *     Ancestor_Chain and for nothing else, so a non-primary Channel of a
 *     destination-chain Team is never granted by the transfer itself.
 *   - the REVOCATION half (Requirement 7.1) is not scoped to Primary_Channels
 *     at all. Step 5's predicate is "owned by a Team absent from the
 *     destination chain", so EVERY team-owned Channel outside that chain
 *     goes, primary or not.
 *
 * Requirement 7.4 is what makes those two halves observable together: a Team
 * in both Ancestor_Chains (in a single-Organisation scenario the Organisation
 * root always is one) keeps its rows, including the non-primary ones the
 * harness seeded, because its `team_id` is inside step 5's retained array.
 * The expected set is therefore the union of the additive set and the
 * retained set, not the additive set alone -- the design's summary sentence
 * reads as strict equality with the destination chain's Primary_Channels,
 * which holds only when no shared ancestor owns a non-primary Channel. Both
 * terms are computed by walking the generated layout directly
 * (`primaryChannelsForChain` / `channelsForChain`), never by asking the
 * service what it did.
 *
 * The third clause is the polymorphic-`channel_id` hazard: the harness seeds
 * Deployment_Channel rows whose `channel_id` names no `channels` row, and
 * step 5's `USING channels c` join cannot reach them. Had step 5 copied
 * `removeUserFromTeam`'s blanket `DELETE ... WHERE user_id = $1`, this
 * assertion is the one that would fail.
 *
 * This is the `channel_memberships` half of the Requirement 17.3 assertion.
 * Its `remove_user_from_group` half is Property 4's (task 6.6), kept separate
 * so no test covers two properties.
 */
// Feature: team-member-transfer, Property 3: Channel end-state equals the destination chain's channels
describe('Property 3: Channel end-state equals the destination chain\'s channels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([transferScenarioArb()], { numRuns: 100 })(
    'retains exactly the team-owned Channels of the destination Ancestor_Chain, revokes every team-owned Channel outside it, and leaves rows naming no channels row untouched',
    async (scenario) => {
      const harness = createTransferHarness(scenario);
      const { hierarchy, channels, sourceTeamId, destinationTeamId } = scenario;

      await TeamTransferService.executeTransfer(harness.client, {
        userId: harness.userId,
        destinationTeamId,
        actorId: harness.actorId,
        actorIsGlobalManager: false
      });

      const destinationChainIds = hierarchy.ancestorIdsOf(destinationTeamId);
      const sourceChainIds = hierarchy.ancestorIdsOf(sourceTeamId);

      // Requirement 6.4 -- what the transfer GRANTS: one row per
      // Primary_Channel of the destination Ancestor_Chain.
      const grantedChannelIds = channels
        .primaryChannelsForChain(destinationChainIds)
        .map((channel) => channel.id);

      // Requirement 7.4 -- what the transfer RETAINS: the seeded rows (every
      // Channel of the Source_Team's chain, primary and non-primary alike)
      // whose owning Team also appears in the destination chain.
      const retainedChannelIds = channels
        .channelsForChain(sourceChainIds)
        .filter((channel) => destinationChainIds.includes(channel.team_id))
        .map((channel) => channel.id);

      const expectedChannelIds = [
        ...new Set([...grantedChannelIds, ...retainedChannelIds])
      ].sort(ascending);

      const heldChannelIds = harness
        .channelMembershipRowsOf(harness.userId)
        .map((row) => row.channel_id);

      // A `channel_memberships` row is one per (channel_id, user_id) pair, so
      // neither the insert of step 4 nor the seeding may have doubled up.
      expect(heldChannelIds).toHaveLength(new Set(heldChannelIds).size);

      const teamOwnedChannelIds = new Set(channels.channels.map((channel) => channel.id));
      const heldTeamOwnedChannelIds = heldChannelIds
        .filter((channelId) => teamOwnedChannelIds.has(channelId))
        .sort(ascending);

      expect(heldTeamOwnedChannelIds).toEqual(expectedChannelIds);

      // Requirement 7.1 stated directly rather than as a consequence of the
      // equality above: nothing owned by a Team absent from the destination
      // chain survives, whether or not it is that Team's Primary_Channel and
      // whether or not it holds an `authentik_group_id`.
      const outsideChannelIds = channels
        .channelsOutsideChain(destinationChainIds)
        .map((channel) => channel.id);

      expect(
        heldTeamOwnedChannelIds.filter((channelId) => outsideChannelIds.includes(channelId))
      ).toEqual([]);

      // The polymorphic rows: present before, present after, untouched.
      const heldDeploymentChannelIds = heldChannelIds
        .filter((channelId) => channels.deploymentChannelIds.includes(channelId))
        .sort(ascending);

      expect(heldDeploymentChannelIds).toEqual([...channels.deploymentChannelIds].sort(ascending));
    }
  );
});

// ---------------------------------------------------------------------------
// Property 4 (task 6.6)
// ---------------------------------------------------------------------------

/**
 * Requirement 7.2 is the Authentik half of the revocation Property 3 covers
 * locally: for each Channel whose `channel_memberships` row step 5 removed
 * AND which holds a non-null `authentik_group_id`, exactly one
 * `remove_user_from_group` Sync_Operation.
 *
 * "Exactly one each" is the load-bearing phrase, so the assertion is on the
 * MULTISET of enqueued removals, not on a set or a count. Three distinct
 * mistakes are individually observable that way:
 *
 *   - enqueueing per held `channel_memberships` row rather than per deleted
 *     one (too many),
 *   - enqueueing once per revoked Team rather than once per revoked Channel
 *     (too few, whenever a Team owns several Channels), and
 *   - enqueueing per revoked Channel regardless of `authentik_group_id`
 *     (too many, and each carrying a null group).
 *
 * The last of those is why the null case is asserted twice over: once as the
 * arithmetic (`revoked` minus `revoked without a group` equals the number of
 * removals) and once directly (no enqueued payload carries a null or absent
 * `target_group_id`). `channelLayoutArb` gives every Channel an independent
 * `authentik_group_id`/null draw, so both a group-holding and a groupless
 * Channel under the same revoked Team are reachable.
 *
 * The expected set is derived from the generated layout alone: the Channels
 * the harness seeded (every Channel of the Source_Team's Ancestor_Chain,
 * primary and non-primary alike) whose owning Team is absent from the
 * destination Ancestor_Chain. Step 4 runs first and inserts only
 * destination-chain rows, whose `team_id` values are inside step 5's retained
 * array, so it cannot contribute a revocation -- and Requirement 7.4's
 * shared-ancestor Channels are excluded by that same array, which is what
 * keeps a group-holding Channel of the Organisation root out of the expected
 * multiset even though the user held it before the move.
 *
 * `authentik_group_id` is derived from the Channel id by the fixture, so each
 * enqueued `target_group_id` traces back to exactly one Channel and a
 * per-Channel duplicate is visible as a repeated value rather than only as an
 * off-by-one in the total.
 *
 * Deliberately NOT asserted here: that these enqueues sit on the transfer's
 * own transaction. That is Requirement 7.3, which Property 5 (task 6.9) owns
 * along with the rest of rollback totality; the harness records it as
 * `onTransaction` for that test's use.
 */
// Feature: team-member-transfer, Property 4: Revoked channels with an Authentik group produce exactly one removal operation each
describe('Property 4: Revoked channels with an Authentik group produce exactly one removal operation each', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([transferScenarioArb()], { numRuns: 100 })(
    'enqueues one remove_user_from_group per revoked Channel holding an authentik_group_id, and none for a revoked Channel whose authentik_group_id is null',
    async (scenario) => {
      const harness = createTransferHarness(scenario);
      const { hierarchy, channels, sourceTeamId, destinationTeamId } = scenario;

      const outcome = await TeamTransferService.executeTransfer(harness.client, {
        userId: harness.userId,
        destinationTeamId,
        actorId: harness.actorId,
        actorIsGlobalManager: false
      });

      const destinationChainIds = hierarchy.ancestorIdsOf(destinationTeamId);
      const sourceChainIds = hierarchy.ancestorIdsOf(sourceTeamId);

      // Requirement 7.1's set, intersected with what the user actually held:
      // a Channel owned by a Team outside the destination chain that the
      // harness never seeded has no row to delete and so cannot be revoked.
      const revokedChannels = channels
        .channelsOutsideChain(destinationChainIds)
        .filter((channel) => sourceChannelIsHeld(channel, sourceChainIds));

      const revokedWithGroup = revokedChannels.filter((channel) => channel.authentik_group_id);
      const revokedWithoutGroup = revokedChannels.filter((channel) => !channel.authentik_group_id);

      const expectedGroupIds = revokedWithGroup
        .map((channel) => channel.authentik_group_id)
        .sort(ascending);

      const removalOperations = harness.store.syncOperations.filter(
        (operation) => operation.operationType === 'remove_user_from_group'
      );

      const actualGroupIds = removalOperations
        .map((operation) => operation.payload.target_group_id)
        .sort(ascending);

      // The multiset equality: one per group-holding revoked Channel, no
      // more and no fewer, each naming its own Channel's group.
      expect(actualGroupIds).toEqual(expectedGroupIds);

      // "Exactly one EACH" stated separately from the multiset equality, so
      // a duplicate cannot hide behind a coincidentally equal total.
      expect(new Set(actualGroupIds).size).toBe(actualGroupIds.length);

      // Requirement 7.2's "non-null `authentik_group_id`" qualifier, as
      // arithmetic over the revoked set: the groupless revoked Channels are
      // exactly the ones that contributed nothing.
      expect(removalOperations).toHaveLength(
        revokedChannels.length - revokedWithoutGroup.length
      );

      // And stated directly: nothing was enqueued with no group to remove
      // from. Without this, a removal carrying `target_group_id: null` would
      // still satisfy a count-only assertion whenever some other revoked
      // Channel was groupless.
      expect(
        removalOperations.filter((operation) => !operation.payload.target_group_id)
      ).toEqual([]);

      // Every removal is for the Transferred_User and attributed to the
      // acting user -- a Sync_Operation naming the wrong user would revoke
      // someone else's Authentik access.
      expect(
        removalOperations.every(
          (operation) => operation.payload.target_user_id === harness.userId
            && operation.publishedBy === harness.actorId
        )
      ).toBe(true);

      // The outcome is what a caller reports and audits, so it carries the
      // same multiset rather than a summary of it.
      expect([...outcome.revokedAuthentikGroupIds].sort(ascending)).toEqual(expectedGroupIds);
    }
  );
});

/**
 * Whether `createTransferHarness` seeded a `channel_memberships` row for this
 * Channel: the seeded set is every Channel of the Source_Team's
 * Ancestor_Chain. Kept as a named helper so the expected-value computation
 * above reads as the intersection it is.
 *
 * @param {object} channel a generated `channels`-shaped row
 * @param {number[]} sourceChainIds the Source_Team's Ancestor_Chain ids
 * @returns {boolean}
 */
function sourceChannelIsHeld(channel, sourceChainIds) {
  return sourceChainIds.includes(channel.team_id);
}

// ---------------------------------------------------------------------------
// Property 27 (task 6.7)
// ---------------------------------------------------------------------------

/**
 * Requirement 6.8 is the additive counterpart of Requirement 7.2, so this is
 * the deliberate counterpart of Property 4 (task 6.6) and is written to the
 * same shape: a multiset equality over the enqueued `target_group_id` values,
 * with the "exactly one each" and the "non-null `authentik_group_id`" clauses
 * each asserted a second time on their own so neither can hide inside a
 * coincidentally-correct total.
 *
 * The asymmetry with Property 4 is the reason both exist:
 *
 *   - THIS side is Primary_Channel-scoped. Step 4's delegate selects
 *     `c.is_primary = true` across the destination Ancestor_Chain, so a
 *     non-primary Channel of a destination-chain Team -- group-holding or not
 *     -- contributes no `add_user_to_group`, even when the Transferred_User
 *     ends up holding a `channel_memberships` row for it because a shared
 *     ancestor retained it (Requirement 7.4).
 *   - Property 4's side is not scoped to Primary_Channels at all: every
 *     team-owned Channel outside the destination chain is revoked.
 *
 * That is why the expected multiset here comes from
 * `channels.primaryChannelsForChain(destinationChainIds)` while Property 4's
 * comes from `channels.channelsOutsideChain(...)`, and why the third
 * assertion below -- no addition names a non-primary Channel's group -- is
 * the one that would fail if the delegation ever dropped its `is_primary`
 * filter.
 *
 * The expected value is computed by walking the generated hierarchy and
 * Channel layout directly, never by asking the service or its delegate what
 * they did. Unlike Property 4's expected set, no intersection with what the
 * user already held is needed: Requirement 6.8 is unconditional over the
 * destination chain, and `addUserToTeam` enqueues per selected Channel
 * regardless of whether the local `channel_memberships` insert hit its
 * `ON CONFLICT DO NOTHING` -- so a Channel of a shared ancestor the user
 * already held still contributes its one addition.
 *
 * Deliberately NOT asserted here, matching Property 4: that these enqueues
 * sit on the transfer's own transaction (Requirement 7.3 / 6.8's "same
 * transaction" clause, which Property 5 owns), and the
 * `assign_user_to_global_channels` enqueue, which is `addUserToTeam`'s own
 * long-standing behaviour and no part of Requirement 6.8.
 *
 * This is the Requirement 17.9 assertion.
 */
// Feature: team-member-transfer, Property 27: Destination-chain Primary_Channels with an Authentik group produce exactly one addition operation each
describe('Property 27: Destination-chain Primary_Channels with an Authentik group produce exactly one addition operation each', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([transferScenarioArb()], { numRuns: 100 })(
    'enqueues one add_user_to_group per destination-chain Primary_Channel holding an authentik_group_id, and none for a groupless or non-primary Channel',
    async (scenario) => {
      const harness = createTransferHarness(scenario);
      const { hierarchy, channels, destinationTeamId } = scenario;

      await TeamTransferService.executeTransfer(harness.client, {
        userId: harness.userId,
        destinationTeamId,
        actorId: harness.actorId,
        actorIsGlobalManager: false
      });

      const destinationChainIds = hierarchy.ancestorIdsOf(destinationTeamId);

      // Requirement 6.8's set, straight from the generated layout: the
      // Primary_Channels of the Teams in the Destination_Team's
      // Ancestor_Chain. A Team with no Primary_Channel at all contributes
      // nothing, and the Destination_Team itself is in the chain.
      const destinationPrimaryChannels = channels.primaryChannelsForChain(destinationChainIds);

      const primaryWithGroup = destinationPrimaryChannels
        .filter((channel) => channel.authentik_group_id);
      const primaryWithoutGroup = destinationPrimaryChannels
        .filter((channel) => !channel.authentik_group_id);

      const expectedGroupIds = primaryWithGroup
        .map((channel) => channel.authentik_group_id)
        .sort(ascending);

      const additionOperations = harness.store.syncOperations.filter(
        (operation) => operation.operationType === 'add_user_to_group'
      );

      const actualGroupIds = additionOperations
        .map((operation) => operation.payload.target_group_id)
        .sort(ascending);

      // The multiset equality: one per group-holding destination-chain
      // Primary_Channel, no more and no fewer, each naming its own Channel's
      // group.
      expect(actualGroupIds).toEqual(expectedGroupIds);

      // "Exactly one EACH" stated separately, so a Channel enqueued twice
      // cannot pass by cancelling out a Channel enqueued not at all.
      expect(new Set(actualGroupIds).size).toBe(actualGroupIds.length);

      // Requirement 6.8's "non-null `authentik_group_id`" qualifier as
      // arithmetic over the destination-chain Primary_Channels, and then
      // directly: nothing was enqueued with no group to add to. The local
      // `channel_memberships` row is created for a groupless Primary_Channel
      // either way (Requirement 6.4, Property 3's subject), so the count and
      // the payload check together are what separate the two halves.
      expect(additionOperations).toHaveLength(
        destinationPrimaryChannels.length - primaryWithoutGroup.length
      );
      expect(
        additionOperations.filter((operation) => !operation.payload.target_group_id)
      ).toEqual([]);

      // The Primary_Channel scoping, stated as the exclusion it is: no
      // addition names the group of a Channel that is not a destination-chain
      // Primary_Channel -- neither a non-primary Channel of a destination-chain
      // Team (which the user may well still hold a row for, per Requirement
      // 7.4) nor any Channel of a Team outside the chain.
      const expectedGroupIdSet = new Set(expectedGroupIds);
      const otherGroupIds = channels.channels
        .filter((channel) => channel.authentik_group_id)
        .filter((channel) => !expectedGroupIdSet.has(channel.authentik_group_id))
        .map((channel) => channel.authentik_group_id);

      expect(
        actualGroupIds.filter((groupId) => otherGroupIds.includes(groupId))
      ).toEqual([]);

      // Every addition is for the Transferred_User and attributed to the
      // acting user -- an operation naming the wrong user would grant someone
      // else Authentik access to the Destination_Team's channels.
      expect(
        additionOperations.every(
          (operation) => operation.payload.target_user_id === harness.userId
            && operation.publishedBy === harness.actorId
        )
      ).toBe(true);
    }
  );
});
// ---------------------------------------------------------------------------
// Property 29 (task 6.8)
// ---------------------------------------------------------------------------

/**
 * Requirement 9.7's absence test, applied to the values this test reads back
 * out of the harness's `users` row.
 *
 * `isAbsentCallsignSuffix` comes from the fixture module so the test and the
 * service cannot drift apart about what "absent" means; the trim is the other
 * half of the same rule, and it is what makes a whitespace-only stored value
 * and a `null` one indistinguishable to the comparison below.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function normaliseCallsignSuffix(value) {
  return isAbsentCallsignSuffix(value) ? null : String(value).trim();
}

/**
 * One Callsign_Suffix link, drawn from the fixture's whole input space
 * (mixed case, non-ASCII, `''`, whitespace-only, `null`) but rebalanced to an
 * even present/absent split.
 *
 * `callsignSuffixArb()` weights present values 3:1, which would put all three
 * links absent -- the case that exercises the "no value anywhere" end of the
 * chain -- at roughly 1.6% of draws, so a 100-run property would miss it
 * about a fifth of the time. Splitting the same arbitrary on the fixture's own
 * absence predicate leaves the value space untouched while making all eight
 * presence patterns roughly equally likely.
 */
const callsignSuffixLinkArb = fc.oneof(
  {
    arbitrary: callsignSuffixArb().filter((value) => !isAbsentCallsignSuffix(value)),
    weight: 1
  },
  { arbitrary: callsignSuffixArb().filter(isAbsentCallsignSuffix), weight: 1 }
);

/**
 * A transfer scenario plus the two Callsign_Suffix links that arrive as
 * parameters. Link (c) is the scenario's own `storedCallsignSuffix`, which
 * `createTransferHarness` seeds onto the `users` row -- overridden here with
 * `callsignSuffixLinkArb` so all three links share one distribution and vary
 * independently.
 */
function callsignSuffixResolutionArb() {
  return fc
    .record({
      scenario: transferScenarioArb(),
      storedCallsignSuffix: callsignSuffixLinkArb,
      suppliedCallsignSuffix: callsignSuffixLinkArb,
      requestCallsignSuffix: callsignSuffixLinkArb
    })
    .map(({ scenario, storedCallsignSuffix, ...links }) => ({
      scenario: { ...scenario, storedCallsignSuffix },
      ...links
    }));
}

/**
 * Requirements 9.7 and 9.8 are one property, not two, and that is the whole
 * point of stating it this way: 9.7 fixes which of the three links wins, 9.8
 * says the uniqueness check runs against that same winner. Asserting only the
 * first would leave the design's central claim -- that 9.8 falls out of the
 * write ordering rather than needing enforcement -- untested, since a service
 * that resolved the chain correctly and then wrote nothing would still report
 * a correct `callsignSuffixEffective` while `addUserToTeam` compared the stale
 * stored value.
 *
 * So both halves are asserted against the same expected value:
 *
 *   - `callsignSuffixEffective` -- what the callsign is built from.
 *   - the `users.callsign_suffix` state at the MOMENT `addUserToTeam` is
 *     called. That is the observable for Requirement 9.8: the real
 *     `checkCallsignSuffixUniqueness` re-reads the candidate from `client`
 *     inside step 4, so whatever the row holds when step 4 begins is exactly
 *     what it compares. Capturing it there rather than at the end of the
 *     transfer is what makes the ordering claim (step 3's write precedes step
 *     4) observable at all -- a service that wrote the resolved suffix AFTER
 *     the delegation would pass an end-state assertion and fail this one.
 *
 * The three links are `params.callsignSuffix` (a), `params.requestCallsignSuffix`
 * (b), and the stored `users.callsign_suffix` (c), each drawn independently
 * over absent (`null`, `''`, whitespace-only) and present values. The expected
 * winner is computed by scanning that generated triple in order, never by
 * asking the service what it resolved.
 *
 * `callsignSuffixApplied` is the third clause, and it is a statement about
 * PROVENANCE rather than value: it is non-null exactly when the winner came
 * from (a) or (b), because that is what makes `applyPostCommitEffects` mirror
 * the suffix into `user_cache` (Requirement 9.5). A resolution that fell
 * through to (c) contributed no new information, so no `UPDATE users` is
 * issued and the row is left exactly as it was found -- including when it
 * holds a whitespace-only value that resolves to no suffix at all. Both of
 * those are asserted directly, since "wrote nothing" and "wrote the value it
 * already had" are indistinguishable in the end state but not in the SQL.
 */
// Feature: team-member-transfer, Property 29: The Callsign_Suffix used and the Callsign_Suffix checked are both the first available link
describe('Property 29: The Callsign_Suffix used and the Callsign_Suffix checked are both the first available link', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([callsignSuffixResolutionArb()], { numRuns: 100 })(
    'resolves the effective suffix to the first non-absent of the supplied, request, and stored links, hands that same value to the uniqueness check, and reports it as applied only when it came from a supplied link',
    async ({ scenario, suppliedCallsignSuffix, requestCallsignSuffix }) => {
      const harness = createTransferHarness(scenario);
      const { destinationTeamId } = scenario;

      const userRow = harness.store.users.find((row) => row.id === harness.userId);
      const seededStoredSuffix = userRow.callsign_suffix;

      // The Requirement 9.8 observable: the `users` row state at the instant
      // step 4 begins. The harness's faithful `addUserToTeam` model is left
      // in place and delegated to, so the end-state assertions of the other
      // properties are unaffected by this interception.
      const modelledAddUserToTeam = TeamMembershipService.addUserToTeam.getMockImplementation();
      let suffixSeenByUniquenessCheck;

      TeamMembershipService.addUserToTeam.mockImplementation(async (...args) => {
        suffixSeenByUniquenessCheck = harness.store.users
          .find((row) => row.id === harness.userId).callsign_suffix;

        return modelledAddUserToTeam(...args);
      });

      const outcome = await TeamTransferService.executeTransfer(harness.client, {
        userId: harness.userId,
        destinationTeamId,
        actorId: harness.actorId,
        actorIsGlobalManager: false,
        callsignSuffix: suppliedCallsignSuffix,
        requestCallsignSuffix
      });

      // The expected value, by walking the generated triple in Requirement
      // 9.7's stated order: (a) the value supplied on the executing call,
      // (b) the associated Transfer_Request's stored value, (c) the
      // Transferred_User's existing value.
      const links = [suppliedCallsignSuffix, requestCallsignSuffix, seededStoredSuffix];
      const firstAvailableIndex = links.findIndex((value) => !isAbsentCallsignSuffix(value));
      const expectedSuffix = firstAvailableIndex === -1
        ? null
        : normaliseCallsignSuffix(links[firstAvailableIndex]);

      // Requirement 9.7 -- the value the transfer USES.
      expect(outcome.callsignSuffixEffective).toBe(expectedSuffix);

      // Requirement 9.8 -- the value the uniqueness check SEES, which must be
      // the same one. Compared through the absence rule because a resolution
      // that found nothing anywhere leaves whatever absent-shaped value the
      // row already held (`null`, `''`, or whitespace) in place rather than
      // normalising it.
      expect(normaliseCallsignSuffix(suffixSeenByUniquenessCheck)).toBe(expectedSuffix);

      if (expectedSuffix !== null) {
        // And when there IS a suffix, the row holds it exactly -- untrimmed
        // or case-folded storage would make the check compare something the
        // callsign is not built from.
        expect(suffixSeenByUniquenessCheck).toBe(expectedSuffix);
      }

      // Provenance: non-null exactly for links (a) and (b).
      const expectedApplied = firstAvailableIndex === 0 || firstAvailableIndex === 1
        ? expectedSuffix
        : null;

      expect(outcome.callsignSuffixApplied).toBe(expectedApplied);

      // The write itself, rather than its end state: exactly one
      // `UPDATE users SET callsign_suffix` when the winner came from (a) or
      // (b), and none at all when it came from (c) or from nowhere.
      const suffixWrites = harness.client.query.mock.calls.filter(
        ([sql]) => /UPDATE users SET callsign_suffix/.test(String(sql))
      );

      if (expectedApplied === null) {
        expect(suffixWrites).toHaveLength(0);
        // Untouched, whitespace and all.
        expect(userRow.callsign_suffix).toBe(seededStoredSuffix);
      } else {
        expect(suffixWrites).toHaveLength(1);
        expect(suffixWrites[0][1]).toEqual([expectedApplied, harness.userId]);
        expect(userRow.callsign_suffix).toBe(expectedApplied);
      }
    }
  );
});
// ---------------------------------------------------------------------------
// Property 5 (task 6.9)
// ---------------------------------------------------------------------------

const {
  NoCurrentTeamError,
  AlreadyInDestinationTeamError,
  StaleTransferRequestError,
  CrossOrganisationTransferError
} = require('./TeamTransferService');
const { CallsignSuffixConflictError } = require('./CallsignSuffixUniquenessService');

/**
 * Every ordered pair of Teams drawn from DIFFERENT Organisations, the
 * counterpart of the same-Organisation `transferPairArb` above.
 */
function crossOrganisationPairArb(hierarchy) {
  const pairs = [];

  for (const sourceTeamId of hierarchy.teamIds) {
    for (const destinationTeamId of hierarchy.teamIds) {
      if (!hierarchy.sameOrganisation(sourceTeamId, destinationTeamId)) {
        pairs.push({ sourceTeamId, destinationTeamId });
      }
    }
  }

  return fc.constantFrom(...pairs);
}

/**
 * A transfer scenario whose Source_Team and Destination_Team sit in
 * different Organisations, shaped identically to `transferScenarioArb`'s
 * output so `createTransferHarness` consumes either interchangeably.
 *
 * Two Organisations of at most four Teams each: the cross-Organisation gate
 * fires in step 2, before any write, so hierarchy size buys nothing here.
 */
function crossOrganisationScenarioArb() {
  return hierarchyArb({
    minOrganisations: 2,
    maxOrganisations: 2,
    minTeamsPerOrganisation: 1,
    maxTeamsPerOrganisation: 4
  }).chain((hierarchy) =>
    fc.record({
      hierarchy: fc.constant(hierarchy),
      channels: channelLayoutArb(hierarchy),
      pair: crossOrganisationPairArb(hierarchy),
      priorRole: fc.constantFrom('member', 'admin'),
      storedCallsignSuffix: callsignSuffixArb()
    }).map(({ pair, ...rest }) => ({ ...rest, ...pair }))
  );
}

/**
 * How many Channels a successful run of this scenario would revoke that
 * hold an Authentik group -- the size of Requirement 7.2's set, computed by
 * walking the generated layout: the Channels the harness seeded (every
 * Channel of the Source_Team's Ancestor_Chain) whose owning Team is absent
 * from the destination chain.
 *
 * @returns {number}
 */
function revocableGroupChannelCount({ hierarchy, channels, sourceTeamId, destinationTeamId }) {
  const destinationChainIds = hierarchy.ancestorIdsOf(destinationTeamId);
  const sourceChainIds = hierarchy.ancestorIdsOf(sourceTeamId);

  return channels
    .channelsOutsideChain(destinationChainIds)
    .filter((channel) => sourceChainIds.includes(channel.team_id) && channel.authentik_group_id)
    .length;
}

/**
 * A transfer scenario that necessarily reaches step 5's
 * `remove_user_from_group` enqueue at least once.
 *
 * The `callerRollback` mode is the only one that observes Requirement 7.3
 * over the FULL set of enqueues a transfer makes, and that observation is
 * vacuous on a scenario whose revoked Channels hold no Authentik group --
 * or whose Source_Team is an ancestor of the Destination_Team, where
 * nothing is revoked at all. Constraining the layout is what stops that
 * mode from passing by making no enqueue to check; the unconstrained
 * downward-move scenarios are covered by the other eleven modes.
 */
function revocableTransferScenarioArb() {
  return transferScenarioArb().filter((scenario) => revocableGroupChannelCount(scenario) > 0);
}

/**
 * The ways one `executeTransfer` call can fail to complete, split by what
 * the failure implies about the database.
 *
 * `rejection` modes are the typed pre-write refusals: each one must throw
 * before the transfer issues a single write, so their end-state assertion
 * needs no rollback at all.
 *
 * `injection` modes fail partway through the sequence -- one per step that
 * can fail, plus the two distinct ways step 4 can (`addUserToTeam`'s
 * uniqueness check refusing before its own writes, and a failure after
 * them) -- so their end-state assertion is the caller's ROLLBACK, modelled
 * below.
 *
 * The `callerRollback` mode is the case Requirement 6.6 describes rather
 * than a failure inside the transfer at all: `executeTransfer` returns
 * normally and the CALLER then fails -- on the approval path's
 * `access_requests` status update, or on the COMMIT itself -- and rolls
 * back. It is the only mode that runs the whole sequence, so it is the one
 * that observes every enqueue Requirement 7.3 covers rather than only the
 * ones made before an injected failure.
 *
 * `writesBefore` marks the modes where a write NECESSARILY precedes the
 * failure, which is what lets the test assert the rollback did real work
 * rather than restoring an already-pristine state.
 */
const FAILURE_MODES = [
  // Requirement 1.4, and the shape Requirement 11.2's dangling
  // `existing_user_id` takes here: a `users` row cannot be absent while a
  // `team_memberships` row references it, so a missing user reaches step 1
  // as a missing Direct_Membership.
  { name: 'noCurrentTeam', kind: 'rejection' },
  { name: 'alreadyInDestination', kind: 'rejection' },
  // Requirement 11.1.
  { name: 'staleRequest', kind: 'rejection' },
  // Requirement 11.6, the only mode needing a two-Organisation hierarchy.
  { name: 'crossOrganisation', kind: 'rejection', crossOrganisation: true },
  // Requirement 11.3: design.md routes a `target_team_id` naming no
  // `teams` row to the callers' generic error branch rather than a typed
  // error, so what is asserted here is only that it throws before writing.
  { name: 'danglingDestinationTeam', kind: 'rejection' },
  { name: 'lockedRead', kind: 'injection' },
  { name: 'suffixWrite', kind: 'injection', requiresSuppliedSuffix: true },
  // Requirement 9.2.
  { name: 'callsignSuffixConflict', kind: 'injection' },
  { name: 'addUserToTeam', kind: 'injection', writesBefore: true },
  { name: 'revocationDelete', kind: 'injection', writesBefore: true },
  { name: 'enqueue', kind: 'injection', writesBefore: true },
  // Requirements 6.6 and 7.3.
  { name: 'callerRollback', kind: 'callerRollback', writesBefore: true, revocable: true }
];

/**
 * The hierarchy a given failure mode needs: two Organisations for the
 * cross-Organisation gate, a guaranteed revocation for the mode that
 * observes every enqueue, and an ordinary single-Organisation scenario for
 * the rest.
 */
function scenarioArbFor(mode) {
  if (mode.crossOrganisation) {
    return crossOrganisationScenarioArb();
  }

  if (mode.revocable) {
    return revocableTransferScenarioArb();
  }

  return transferScenarioArb();
}

/**
 * One failed-transfer scenario: a failure mode, a hierarchy suited to it,
 * and the two offsets the parameterised modes consume.
 *
 * The mode is drawn FIRST and the hierarchy generated from it, because two
 * of the modes cannot be expressed over an arbitrary scenario: the
 * cross-Organisation gate needs two Organisations, and the caller-rollback
 * mode needs a scenario that actually revokes something.
 */
function failedTransferArb() {
  return fc.constantFrom(...FAILURE_MODES).chain((mode) =>
    fc.record({
      mode: fc.constant(mode),
      scenario: scenarioArbFor(mode),
      // Step 3 only issues its write when a suffix was actually supplied,
      // so the mode that injects at that write needs one.
      suppliedCallsignSuffix: mode.requiresSuppliedSuffix
        ? callsignSuffixArb({ includeAbsent: false })
        : callsignSuffixArb(),
      staleOffset: fc.nat(),
      enqueueOffset: fc.nat()
    })
  );
}

/**
 * The number of Sync_Operations a SUCCESSFUL run of this scenario would
 * enqueue, computed by walking the generated Channel layout: one
 * `add_user_to_group` per destination-chain Primary_Channel holding a
 * group, one `assign_user_to_global_channels`, and one
 * `remove_user_from_group` per held Channel outside the destination chain
 * holding a group.
 *
 * Used only to pick a reachable injection ordinal, so that the enqueue
 * mode can land on ANY enqueue -- including step 5's revocation ones,
 * which is where Requirement 7.3 actually bites -- rather than always on
 * the first.
 *
 * @returns {number} always at least 1
 */
function expectedEnqueueCount(scenario) {
  const { hierarchy, channels, destinationTeamId } = scenario;
  const destinationChainIds = hierarchy.ancestorIdsOf(destinationTeamId);

  const additions = channels
    .primaryChannelsForChain(destinationChainIds)
    .filter((channel) => channel.authentik_group_id).length;

  // The `assign_user_to_global_channels` enqueue `addUserToTeam` always
  // makes is the `+ 1`, which is what keeps this count non-zero for a
  // scenario whose Channels hold no Authentik groups at all.
  return additions + 1 + revocableGroupChannelCount(scenario);
}

/**
 * Arranges one failure mode against an already-built harness and returns
 * what the assertions need: the error to expect, and any `executeTransfer`
 * parameters the mode overrides.
 *
 * Each injection wraps the harness's own modelled implementation rather
 * than replacing it, so everything up to the injected step behaves exactly
 * as it does in the passing properties above and the partial state the
 * rollback has to undo is the real one.
 *
 * @returns {{expectedError: Function, injectedError: Error|null, params: object}}
 */
function installFailureMode({ mode, scenario, harness, staleOffset, enqueueOffset, suppliedCallsignSuffix }) {
  const { hierarchy, sourceTeamId, destinationTeamId } = scenario;

  const wrapClientQuery = (matches, error) => {
    const modelled = harness.client.query.getMockImplementation();

    harness.client.query.mockImplementation(async (sql, params) => {
      if (matches(String(sql))) {
        throw error;
      }

      return modelled(sql, params);
    });
  };

  switch (mode.name) {
    case 'noCurrentTeam': {
      // The Direct_Membership gone, the inherited rows left behind: there
      // is still state for a failed transfer to preserve.
      harness.store.teamMemberships = harness.store.teamMemberships.filter(
        (row) => row.inherited_from_team_id !== null
      );

      return { expectedError: NoCurrentTeamError, injectedError: null, params: {} };
    }

    case 'alreadyInDestination':
      return {
        expectedError: AlreadyInDestinationTeamError,
        injectedError: null,
        params: { destinationTeamId: sourceTeamId }
      };

    case 'staleRequest': {
      // Any Team other than the one the locked read finds: the approval
      // path's recorded `current_team_id` no longer matches.
      const otherTeamIds = hierarchy.teamIds.filter((teamId) => teamId !== sourceTeamId);

      return {
        expectedError: StaleTransferRequestError,
        injectedError: null,
        params: { expectedSourceTeamId: otherTeamIds[staleOffset % otherTeamIds.length] }
      };
    }

    case 'crossOrganisation':
      return { expectedError: CrossOrganisationTransferError, injectedError: null, params: {} };

    case 'danglingDestinationTeam': {
      const modelled = Team.getAncestorChain.getMockImplementation();

      Team.getAncestorChain.mockImplementation(async (teamId) =>
        (teamId === destinationTeamId ? [] : modelled(teamId)));

      return { expectedError: TypeError, injectedError: null, params: {} };
    }

    case 'lockedRead': {
      const injectedError = new Error('injected failure: the locked Direct_Membership read');

      wrapClientQuery(
        (sql) => /FROM team_memberships/.test(sql) && /FOR UPDATE/.test(sql),
        injectedError
      );

      return { expectedError: Error, injectedError, params: {} };
    }

    case 'suffixWrite': {
      const injectedError = new Error('injected failure: the Callsign_Suffix write');

      wrapClientQuery((sql) => /UPDATE users SET callsign_suffix/.test(sql), injectedError);

      return { expectedError: Error, injectedError, params: {} };
    }

    case 'callsignSuffixConflict': {
      // Faithful to the real delegate: `checkCallsignSuffixUniqueness`
      // runs at the top of `addUserToTeam`, so the conflict throws before
      // any write of step 4 -- but AFTER step 3's write, which is what
      // makes Requirement 9.2 a rollback claim rather than a no-op.
      const candidate = [suppliedCallsignSuffix, scenario.storedCallsignSuffix]
        .find((value) => !isAbsentCallsignSuffix(value));
      const injectedError = new CallsignSuffixConflictError(
        candidate === undefined ? 'C.Elsen' : String(candidate).trim()
      );

      TeamMembershipService.addUserToTeam.mockImplementation(async () => {
        throw injectedError;
      });

      return { expectedError: CallsignSuffixConflictError, injectedError, params: {} };
    }

    case 'addUserToTeam': {
      // The other half of step 4: the delegate's own writes land, then it
      // fails. Every `team_memberships` and `channel_memberships` row it
      // wrote is now partial state the rollback must undo.
      const injectedError = new Error('injected failure: after the delegated additive writes');
      const modelled = TeamMembershipService.addUserToTeam.getMockImplementation();

      TeamMembershipService.addUserToTeam.mockImplementation(async (...args) => {
        await modelled(...args);

        throw injectedError;
      });

      return { expectedError: Error, injectedError, params: {} };
    }

    case 'revocationDelete': {
      const injectedError = new Error('injected failure: the revocation delete');

      wrapClientQuery((sql) => /DELETE FROM channel_memberships/.test(sql), injectedError);

      return { expectedError: Error, injectedError, params: {} };
    }

    case 'enqueue': {
      const injectedError = new Error('injected failure: a Sync_Operation enqueue');
      const failAtCall = 1 + (enqueueOffset % expectedEnqueueCount(scenario));
      const modelled = EventPublisher.publishOperation.getMockImplementation();
      let seen = 0;

      EventPublisher.publishOperation.mockImplementation(async (...args) => {
        seen += 1;

        if (seen === failAtCall) {
          throw injectedError;
        }

        return modelled(...args);
      });

      return { expectedError: Error, injectedError, params: {} };
    }

    case 'callerRollback':
      // Nothing to arrange: the transfer runs to completion and the
      // caller's own next step is what fails, modelled by the rollback
      // in the assertions rather than by an injection here.
      return { expectedError: null, injectedError: null, params: {} };

    default:
      throw new Error(`Unhandled failure mode: ${mode.name}`);
  }
}

/**
 * Whether a statement handed to the transaction client writes.
 *
 * Anchored at the start of the statement rather than matching the verb
 * anywhere in it: step 1's locked read ends in `FOR UPDATE`, and a
 * substring match would count that -- the one read whose whole purpose is
 * to precede the writes -- as a write.
 *
 * @param {string} sql
 * @returns {boolean}
 */
function isWriteStatement(sql) {
  return /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);
}

/**
 * Requirements 6.5, 9.2, 11.1, 11.2, 11.3, 11.4, and 12.2 are seven
 * statements of one thing -- "that attempt changed nothing" -- so they are
 * one property rather than seven tests, with the failure mode generated
 * alongside the scenario. Ten such criteria collapsing into one property
 * is the consolidation design.md calls out by name.
 *
 * `executeTransfer` never issues BEGIN, COMMIT, or ROLLBACK: the CALLER
 * owns the transaction (Requirement 6.6). So "changes nothing" cannot be
 * asserted here as "the service undid its own writes" -- it has no undo to
 * perform. What is asserted instead is the pair of claims that together
 * make the caller's ROLLBACK sufficient:
 *
 *   (a) every typed rejection path throws BEFORE any write. Those are not
 *       rollback claims at all -- no write was issued, no enqueue was made,
 *       and the state is asserted equal to the starting state with no
 *       rollback applied. A rejection that wrote first and threw second
 *       would still leave a correct end state on the approval path (whose
 *       caller rolls back) while corrupting nothing visible, so asserting
 *       it directly is the only way to pin it.
 *
 *   (b) a failure at ANY step -- injected inside the sequence, or arriving
 *       from the caller once the sequence has finished -- leaves state that
 *       is entirely restorable, which requires that nothing escaped the
 *       transaction. Two things could escape: a write issued through the
 *       shared `pool` instead of `client`, and a Sync_Operation enqueued
 *       without the `client` argument (Requirement 7.3). The rollback below
 *       is modelled to let either one survive -- the snapshot is restored
 *       and then any off-transaction enqueue is re-applied -- so the final
 *       equality is a real assertion rather than a restatement of
 *       `restore`.
 *
 * The `access_requests` half of Requirements 11.1 through 11.4 and 12.2 --
 * the row keeping `status` of `pending` -- has its own observable here:
 * `executeTransfer` issues no statement naming `access_requests` at all, so
 * the caller's status update cannot have run before the throw. The
 * status-code halves of those criteria belong to the route and are asserted
 * in `requests.approval.integration.test.js`.
 *
 * Requirement 1.2's `targetTeamId` naming no `teams` row appears as the
 * `danglingDestinationTeam` mode; its 400 is the route's own, asserted in
 * `users.transfer.integration.test.js`.
 *
 * Every expected value is computed from the generated scenario: the
 * pre-transfer snapshot is taken from the harness before the call, and the
 * enqueue injection ordinal is derived by walking the generated Channel
 * layout, never by asking the service what it would have done.
 */
// Feature: team-member-transfer, Property 5: A transfer that does not succeed changes nothing
describe('Property 5: A transfer that does not succeed changes nothing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([failedTransferArb()], { numRuns: 100 })(
    'leaves the complete pre-transfer state in place for every rejection path and, once the caller rolls back, for a failure injected at any step of the sequence or arriving after it',
    async ({ mode, scenario, suppliedCallsignSuffix, staleOffset, enqueueOffset }) => {
      // The module-level mocks are shared across every run of this one
      // test, so the call logs asserted below have to start empty.
      jest.clearAllMocks();

      const harness = createTransferHarness(scenario);
      const { sourceTeamId, destinationTeamId, priorRole } = scenario;

      const { expectedError, injectedError, params } = installFailureMode({
        mode,
        scenario,
        harness,
        staleOffset,
        enqueueOffset,
        suppliedCallsignSuffix
      });

      // The starting state, taken after the mode has arranged it.
      const startingState = harness.snapshot();
      const seededCallsignSuffix = harness.store.users
        .find((row) => row.id === harness.userId).callsign_suffix;

      let thrown = null;

      try {
        await TeamTransferService.executeTransfer(harness.client, {
          userId: harness.userId,
          destinationTeamId,
          actorId: harness.actorId,
          actorIsGlobalManager: false,
          callsignSuffix: suppliedCallsignSuffix,
          requestCallsignSuffix: null,
          ...params
        });
      } catch (error) {
        thrown = error;
      }

      if (mode.kind === 'callerRollback') {
        // This mode's premise is the opposite one: the transfer itself has
        // to SUCCEED, because the failure being modelled is the caller's.
        expect(thrown).toBeNull();
      } else {
        // The premise everywhere else: the generated mode makes the
        // transfer fail. A mode that silently succeeded would make every
        // assertion below vacuous.
        expect(thrown).toBeInstanceOf(expectedError);
      }

      if (injectedError !== null) {
        // And the failure that surfaced is the one that was injected, so
        // the transfer really did reach the intended step rather than
        // failing earlier for an unrelated reason.
        expect(thrown).toBe(injectedError);
      }

      const clientSql = harness.client.query.mock.calls.map(([sql]) => String(sql));

      // Requirement 6.6 -- the caller owns the transaction. Were the
      // service to open or close one itself, the caller could not roll the
      // `access_requests` status update back together with these writes,
      // and none of what follows would be recoverable.
      expect(clientSql.filter((sql) => /\b(BEGIN|COMMIT|ROLLBACK)\b/.test(sql))).toEqual([]);

      // Requirements 11.1-11.4 and 12.2 -- the row's `status` stays
      // `pending` because this service never touches `access_requests`.
      expect(clientSql.filter((sql) => /access_requests/.test(sql))).toEqual([]);

      // (b)'s first escape route: a write issued through the shared `pool`
      // would survive the caller's ROLLBACK. `executeTransfer` reads
      // `teams` through the mocked `Team` model and does everything else on
      // `client`, so the pool must be untouched.
      expect(pool.query).not.toHaveBeenCalled();

      if (mode.kind === 'rejection') {
        // (a) -- no rollback applied, because there is nothing to roll
        // back: no write statement, no delegation, no enqueue.
        expect(clientSql.filter(isWriteStatement)).toEqual([]);
        expect(TeamMembershipService.addUserToTeam).not.toHaveBeenCalled();
        expect(EventPublisher.publishOperation).not.toHaveBeenCalled();
        expect(harness.store).toEqual(startingState);
      } else {
        if (mode.revocable) {
          // The `callerRollback` mode's scenario is constrained to produce
          // one, so Requirement 7.3's check below is over a non-empty set:
          // step 5's own enqueues, the ones this service makes directly,
          // rather than only the delegate's.
          expect(
            harness.store.syncOperations.filter(
              (operation) => operation.operationType === 'remove_user_from_group'
            ).length
          ).toBeGreaterThan(0);
        }

        // Requirement 7.3 -- every enqueue sits on the transfer's own
        // transaction, stated directly.
        const escapedOperations = harness.store.syncOperations.filter(
          (operation) => !operation.onTransaction
        );

        expect(escapedOperations).toEqual([]);

        if (mode.writesBefore) {
          // The rollback has real work to do: for these modes a write
          // necessarily landed before the failure, so the state at this
          // instant is NOT the starting state. Without this, an injection
          // that never got past step 1 would make the equality below pass
          // for the wrong reason.
          expect(harness.store).not.toEqual(startingState);
        }

        // The caller's ROLLBACK, modelled: everything the transaction did
        // is discarded, and anything that escaped the transaction survives
        // it. `escapedOperations` is empty by the assertion above, which is
        // exactly why the equality that follows holds -- an enqueue made
        // without `client` would reappear here and fail it.
        harness.restore(startingState);
        harness.store.syncOperations.push(...escapedOperations);

        expect(harness.store).toEqual(startingState);
        expect(harness.store.syncOperations).toEqual([]);
      }

      // Requirements 6.5 and 9.2 in their own words rather than as a
      // consequence of the equality above: the Direct_Membership still
      // names the Source_Team, still holds the role it held, and the
      // Callsign_Suffix step 3 may have overwritten is back as it was.
      const directRows = harness.store.teamMemberships.filter(
        (row) => row.user_id === harness.userId && row.inherited_from_team_id === null
      );

      if (mode.name === 'noCurrentTeam') {
        expect(directRows).toEqual([]);
      } else {
        expect(directRows).toHaveLength(1);
        expect(directRows[0].team_id).toBe(sourceTeamId);
        expect(directRows[0].role).toBe(priorRole);
      }

      expect(
        harness.store.users.find((row) => row.id === harness.userId).callsign_suffix
      ).toBe(seededCallsignSuffix);
    }
  );
});

// ---------------------------------------------------------------------------
// Property 6 (task 6.10)
// ---------------------------------------------------------------------------

/**
 * The operation types a Team_Transfer is allowed to enqueue: the additive
 * ones `addUserToTeam` makes (Requirement 6.8, Property 27's subject) and the
 * subtractive one step 5 makes (Requirement 7.2, Property 4's subject).
 *
 * Requirement 1.6 is asserted as membership of this set rather than as the
 * absence of one named operation, because `sync_operations.operation_type` is
 * a free-form string: there is no enum to lean on, so the only assertion that
 * cannot be outflanked by a newly-invented type is an allow-list.
 * `revoke_tak_certificates` -- what `removeUserFromTeam` enqueues, and the
 * one existing operation that destroys part of an identity rather than a
 * group membership -- is excluded by construction.
 */
const IDENTITY_PRESERVING_OPERATION_TYPES = new Set([
  'add_user_to_group',
  'remove_user_from_group',
  'assign_user_to_global_channels'
]);

/**
 * Whether a statement removes rows from `users` or `user_cache`.
 *
 * Deliberately coarse: any `DELETE`, `TRUNCATE`, or `DROP` that so much as
 * names either table counts, even in a subquery. A false positive would have
 * to be a statement that deletes from some other table while mentioning
 * `users` -- which Requirement 1.6 gives no reason to write -- so erring this
 * way costs nothing and catches the shape `removeUserFromTeam`'s call site
 * uses (`DELETE FROM user_cache WHERE authentik_id = $1`,
 * `DELETE FROM users WHERE id = $1`).
 *
 * `\busers\b` does not match `cm.user_id`, so step 5's revocation delete --
 * the one statement a transfer issues that IS a `DELETE` -- is not caught.
 *
 * @param {string} sql
 * @returns {boolean}
 */
function destroysIdentityRow(sql) {
  const text = String(sql);

  if (!/\b(DELETE|TRUNCATE|DROP)\b/i.test(text)) {
    return false;
  }

  return /\busers\b/i.test(text) || /\buser_cache\b/i.test(text);
}

/**
 * The attributes `applyPostCommitEffects` computes, stubbed to a fixed,
 * definitely-non-null value.
 *
 * The harness deliberately defaults `generateCallsign` to `null`, which is
 * the documented "skip steps 2-4" path -- and skipping those steps is exactly
 * what would make this property's `user_cache` assertions vacuous, since step
 * 2 is the only thing a transfer does that touches that table at all. What
 * the callsign IS is Property 16's subject; that it is present is this one's
 * precondition.
 */
const POST_COMMIT_ATTRIBUTES = {
  callsign: 'FENZ-OTA-C.Elsen',
  color: 'Cyan',
  role: 'Team Member'
};

/** The Transfer_Request id the approval path carries. */
const IDENTITY_TRANSFER_REQUEST_ID = 4242;

/**
 * The transfer completing normally, expressed as a failure mode so it can be
 * drawn from the same dimension as the eleven that do not.
 *
 * `installFailureMode` is not consulted for it -- there is nothing to arrange
 * -- and `FAILURE_MODES`' own `callerRollback` entry is excluded from the
 * draw below because it models the same thing (a transfer that runs to
 * completion) while constraining the hierarchy to one that revokes something,
 * which this property has no need of.
 */
const IDENTITY_SUCCESS_MODE = { name: 'succeeds', kind: 'success' };

/**
 * One transfer ATTEMPT: the mode that decides whether it completes, a
 * hierarchy suited to that mode, the path it arrives on, and the offsets the
 * parameterised modes consume.
 *
 * Composed exactly like `failedTransferArb` above -- mode first, hierarchy
 * from it, because the cross-Organisation gate needs two Organisations -- and
 * reusing that property's `FAILURE_MODES`, `scenarioArbFor`, and
 * `installFailureMode` so the two properties cannot drift apart about what
 * the ways of failing are.
 *
 * Success is weighted equally against the whole set of failures rather than
 * being one entry among twelve: only a completed transfer reaches
 * `applyPostCommitEffects`, and that is the half of a transfer that touches
 * `user_cache` and Authentik at all.
 */
function identityAttemptArb() {
  return fc
    .oneof(
      { arbitrary: fc.constant(IDENTITY_SUCCESS_MODE), weight: 1 },
      {
        arbitrary: fc.constantFrom(
          ...FAILURE_MODES.filter((mode) => mode.kind !== 'callerRollback')
        ),
        weight: 1
      }
    )
    .chain((mode) =>
      fc.record({
        mode: fc.constant(mode),
        scenario: scenarioArbFor(mode),
        // Requirement 1.6's "on either path": the immediate path supplies
        // link (a) and records no Transfer_Request, the approval path
        // supplies link (b) and carries the recorded `current_team_id`.
        path: fc.constantFrom('immediate', 'approval'),
        suppliedCallsignSuffix: mode.requiresSuppliedSuffix
          ? callsignSuffixArb({ includeAbsent: false })
          : callsignSuffixArb(),
        staleOffset: fc.nat(),
        enqueueOffset: fc.nat()
      })
    );
}

/**
 * Requirement 1.6 is a NEGATIVE requirement, and it exists because the only
 * pre-existing way to clear a user's team assignment --
 * `DELETE /api/users/remove-from-team/:userId` -- does all four of the things
 * this property forbids: it `fetch`es a `DELETE` against Authentik's
 * `core/users/{id}/` endpoint, calls `clearUserAttributes`, and issues
 * `DELETE FROM user_cache` and `DELETE FROM users`. For a federated
 * OIDC/LDAP identity that is unrecoverable, and it is the whole reason this
 * feature exists. So the property is asserted against the four destruction
 * mechanisms an implementation actually has available, not against an
 * end-state that would also hold if the transfer had done nothing:
 *
 *   - SQL. Every statement issued on the transaction `client` AND on the
 *     shared `pool` is inspected, because `applyPostCommitEffects` runs
 *     after the caller's COMMIT and so writes through the pool, where no
 *     ROLLBACK could undo a delete.
 *   - The rows themselves. The `users` row survives with its
 *     `authentik_user_id` -- the federation link, and the single value whose
 *     loss makes the account unrecoverable -- and its identifying columns
 *     unchanged, and the seeded `user_cache` row survives with the columns
 *     the periodic Authentik synchronisation owns unchanged. `callsign_suffix`
 *     is excluded from that comparison: Requirement 9.5 has the transfer
 *     mirror it deliberately.
 *   - The Sync_Operation queue. A queued operation is an Authentik request
 *     that has not been made yet, so a `revoke_tak_certificates` (or any
 *     other identity-destroying type) sitting in `sync_operations` is a
 *     deletion in flight rather than an absent one.
 *   - Outbound HTTP. `global.fetch` is replaced for the duration, so a raw
 *     Authentik call of the kind the remove-from-team route makes is
 *     observable rather than merely unmocked.
 *
 * "Whether it succeeds or fails" is the generated `mode` dimension, drawn
 * from Property 5's own `FAILURE_MODES` plus a success: a half-completed
 * transfer is where a destructive statement would be easiest to overlook,
 * and the failure modes are what reach those partial states. "On either path"
 * is the generated `path` dimension. Note the asymmetry with Property 5,
 * which needs the caller's ROLLBACK modelled to say anything: this property
 * does not, because it asserts on the statements issued and on state as it
 * stands at the moment of failure. A `DELETE FROM users` inside the
 * transaction would be rolled back on the approval path and still be a
 * Requirement 1.6 violation, which is why the SQL log is the primary
 * observable here and the surviving rows the corollary.
 *
 * Every expected value is read out of the harness before the attempt or
 * computed from the generated scenario; nothing asks the service what it did.
 */
// Feature: team-member-transfer, Property 6: A transfer never destroys an identity
describe('Property 6: A transfer never destroys an identity', () => {
  let originalFetch;

  beforeEach(() => {
    jest.clearAllMocks();

    originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test.prop([identityAttemptArb()], { numRuns: 100 })(
    'issues no delete against users or user_cache, leaves both rows in place with the Authentik link intact, enqueues no identity-destroying Sync_Operation, and makes no Authentik user-deletion request -- on either path, whether the transfer completes or fails at any step',
    async ({ mode, scenario, path, suppliedCallsignSuffix, staleOffset, enqueueOffset }) => {
      // The module-level mocks -- `global.fetch` included -- are shared
      // across every run of this one test, so the call logs asserted below
      // have to start empty.
      jest.clearAllMocks();

      const harness = createTransferHarness(scenario);
      const { destinationTeamId, sourceTeamId } = scenario;

      // The identity as it stands before the attempt. `users` holds exactly
      // the Transferred_User, so a deletion is visible as an absent row
      // rather than only as a changed column.
      const identityBefore = { ...harness.store.users.find((row) => row.id === harness.userId) };

      // A `user_cache` row for the Transferred_User, seeded directly: the
      // harness starts that table empty, and an empty table cannot witness a
      // deletion. Shaped as `applyPostCommitEffects`'s own upsert would
      // leave it, from a transfer into the Source_Team that happened before
      // this one.
      const cacheRowBefore = {
        authentik_id: String(identityBefore.authentik_user_id),
        username: identityBefore.username,
        email: identityBefore.email,
        first_name: identityBefore.first_name,
        last_name: identityBefore.last_name,
        is_active: true,
        callsign_suffix: identityBefore.callsign_suffix,
        tak_callsign: 'FENZ-STL-C.Elsen',
        tak_color: 'Cyan',
        tak_role: 'Team Member'
      };

      harness.store.userCache.push({ ...cacheRowBefore });

      // Steps 2-4 of the post-commit half must actually run: see
      // POST_COMMIT_ATTRIBUTES.
      UserAttributesService.generateCallsign.mockResolvedValue(POST_COMMIT_ATTRIBUTES);

      const { expectedError, params } = mode.kind === 'success'
        ? { expectedError: null, params: {} }
        : installFailureMode({
          mode,
          scenario,
          harness,
          staleOffset,
          enqueueOffset,
          suppliedCallsignSuffix
        });

      // The two paths, as their parameters differ: `RequestApprovalService`
      // passes the Transfer_Request's recorded `current_team_id` and its
      // stored suffix, the route passes the submitted suffix and no
      // expectation. A mode's own overrides win -- `staleRequest` replaces
      // `expectedSourceTeamId`, `alreadyInDestination` the destination.
      const pathParams = path === 'approval'
        ? {
          expectedSourceTeamId: sourceTeamId,
          callsignSuffix: null,
          requestCallsignSuffix: suppliedCallsignSuffix,
          transferRequestId: IDENTITY_TRANSFER_REQUEST_ID,
          initiatedBy: ADMIN_CANDIDATE_USER_IDS[1]
        }
        : {
          expectedSourceTeamId: null,
          callsignSuffix: suppliedCallsignSuffix,
          requestCallsignSuffix: null,
          transferRequestId: null,
          initiatedBy: null
        };

      let outcome = null;
      let thrown = null;

      try {
        outcome = await TeamTransferService.executeTransfer(harness.client, {
          userId: harness.userId,
          destinationTeamId,
          actorId: harness.actorId,
          actorIsGlobalManager: false,
          ...pathParams,
          ...params
        });
      } catch (error) {
        thrown = error;
      }

      if (expectedError === null) {
        // The premise of the success half: a transfer that failed here would
        // make the post-commit assertions below vacuous.
        expect(thrown).toBeNull();

        // The caller's COMMIT, then the effects that follow it. This is the
        // half that touches `user_cache` and Authentik, so Requirement 1.6
        // is only fully observable with it included.
        await TeamTransferService.applyPostCommitEffects(outcome);
      } else {
        // The premise of the failure half: the generated mode really did
        // stop the transfer, at the step it was aimed at.
        expect(thrown).toBeInstanceOf(expectedError);
      }

      // -----------------------------------------------------------------
      // 1. No statement deletes an identity row -- on the transaction, where
      //    a ROLLBACK might have hidden it, or on the pool, where nothing
      //    would have.
      // -----------------------------------------------------------------
      const statements = [
        ...harness.client.query.mock.calls,
        ...pool.query.mock.calls
      ].map(([sql]) => String(sql));

      expect(statements.filter(destroysIdentityRow)).toEqual([]);

      // -----------------------------------------------------------------
      // 2. The `users` row is still there, and still the same identity: the
      //    Authentik link above all, since losing it is what makes a
      //    federated account unrecoverable.
      // -----------------------------------------------------------------
      const usersAfter = harness.store.users;
      const identityAfter = usersAfter.find((row) => row.id === harness.userId);

      expect(usersAfter).toHaveLength(1);
      expect(identityAfter).toBeDefined();
      expect(identityAfter.authentik_user_id).toBe(identityBefore.authentik_user_id);
      expect(identityAfter.username).toBe(identityBefore.username);
      expect(identityAfter.email).toBe(identityBefore.email);
      expect(identityAfter.is_active).toBe(identityBefore.is_active);

      // -----------------------------------------------------------------
      // 3. The `user_cache` row is still there, and the columns the periodic
      //    Authentik synchronisation owns are untouched. `tak_*` and
      //    `callsign_suffix` are excluded: mirroring those is the post-commit
      //    half's job (Requirements 8.2, 9.5).
      // -----------------------------------------------------------------
      const cacheRowsAfter = harness.store.userCache.filter(
        (row) => row.authentik_id === cacheRowBefore.authentik_id
      );

      expect(cacheRowsAfter).toHaveLength(1);
      expect(harness.store.userCache).toHaveLength(1);
      expect(cacheRowsAfter[0].username).toBe(cacheRowBefore.username);
      expect(cacheRowsAfter[0].email).toBe(cacheRowBefore.email);
      expect(cacheRowsAfter[0].last_name).toBe(cacheRowBefore.last_name);
      expect(cacheRowsAfter[0].is_active).toBe(cacheRowBefore.is_active);

      // -----------------------------------------------------------------
      // 4. Nothing identity-destroying is sitting in the queue. A
      //    Sync_Operation is an Authentik call not yet made, so this is the
      //    same claim as 5 displaced in time.
      // -----------------------------------------------------------------
      const operationTypes = harness.store.syncOperations.map(
        (operation) => operation.operationType
      );

      expect(
        operationTypes.filter((type) => !IDENTITY_PRESERVING_OPERATION_TYPES.has(type))
      ).toEqual([]);
      // Stated on its own as well: this is the type `removeUserFromTeam`
      // enqueues, and it destroys the user's TAK certificates rather than a
      // group membership.
      expect(operationTypes).not.toContain('revoke_tak_certificates');

      // -----------------------------------------------------------------
      // 5. No Authentik user-deletion request. The remove-from-team route
      //    issues one as a raw `fetch`, so that is the shape checked -- and
      //    then the stronger claim, since a transfer's every Authentik
      //    effect goes through the mocked attribute service or the queue.
      // -----------------------------------------------------------------
      const fetchCalls = global.fetch.mock.calls;

      expect(
        fetchCalls.filter(([, init]) => /^delete$/i.test(String(init?.method ?? '')))
      ).toEqual([]);
      expect(fetchCalls).toEqual([]);

      // No erasure through the attribute push either: `updateUserAttributes`
      // merges what it is given, so a call carrying a null callsign would
      // blank the user's Authentik attributes rather than move them.
      expect(
        UserAttributesService.updateUserAttributes.mock.calls
          .filter(([, attributes]) => !attributes?.callsign)
      ).toEqual([]);

      if (expectedError === null) {
        // Non-vacuity for the success half: the post-commit effects really
        // ran. Had they all been skipped, assertions 3 and 5 would hold for
        // the wrong reason -- the `user_cache` row would be intact because
        // nothing had gone near it.
        expect(cacheRowsAfter[0].tak_callsign).toBe(POST_COMMIT_ATTRIBUTES.callsign);
        expect(harness.store.auditLogs).toHaveLength(1);
        expect(harness.store.auditLogs[0].resource_id).toBe(harness.userId);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Property 16 (task 7.2)
// ---------------------------------------------------------------------------

const { MAX_TEAM_DEPTH } = require('../config/constants');

/**
 * The REAL `userAttributes` module, reached past this file's own
 * `jest.mock('./userAttributes')`.
 *
 * `jest.requireActual` unmocks only the module named, so the real
 * `computeCallsignAttributes` still reads through the mocked `pool` and the
 * mocked `Team.getAncestorChain` -- which is precisely what makes it usable
 * here: it runs its actual `depth >= 1` filter, its actual
 * Callsign_Level_Selection defaulting, and the actual
 * `CallsignService.assembleCallsign` join, against the GENERATED hierarchy.
 * The only pure module it pulls in (`CallsignService`) is real too.
 */
const realUserAttributesService = jest.requireActual('./userAttributes');

/**
 * A reference assembly of `CallsignService.assembleCallsign`'s rule
 * (Requirement 8 Criteria 2-5), written out here rather than imported: an
 * expected value that called the assembler would assert only that the
 * assembler is itself, which is the tautology this property has to avoid.
 *
 * Segments that are empty are dropped along with the `-` that would have
 * separated them, so a null/empty Organisation prefix, an empty Team
 * segment, and an absent Callsign_Suffix each collapse rather than leaving a
 * stray separator.
 *
 * @param {Array<string>} segments organisation, team, name -- in that order
 * @returns {string}
 */
function joinCallsignSegments(segments) {
  return segments.filter((segment) => segment !== '').join('-');
}

/**
 * The callsign a given destination Team's Ancestor_Chain predicts, computed
 * by walking the GENERATED hierarchy's own rows.
 *
 * This is a reference walk of Requirements 5.3, 5.4, 8.1, and 8.6 read as
 * one rule, deliberately expressed in terms of the generated data rather
 * than by calling `computeCallsignAttributes`:
 *
 *   - the Organisation segment is `chain[0].callsign_prefix` (depth 0),
 *   - the Team segment is the depth-ascending concatenation of the
 *     `callsign_prefix` values at depth >= 1 whose depth is inside the
 *     Organisation's Callsign_Level_Selection and whose prefix is non-empty,
 *     with `null` selection meaning every depth `1..MAX_TEAM_DEPTH`, and
 *   - the Name segment is the Transferred_User's stored Callsign_Suffix.
 *
 * The `depth >= 1` filter is what supplies Requirement 8.6 without a special
 * case: an Organisation-root destination has a one-row chain, so the Team
 * segment is empty and the result carries no Sub_Team segment at all. That
 * consequence is asserted separately below rather than being left to ride on
 * this function agreeing with the implementation.
 *
 * @param {object} hierarchy a `hierarchyArb` value
 * @param {number} teamId
 * @param {string|null} storedCallsignSuffix
 * @returns {string}
 */
function referenceCallsignFor(hierarchy, teamId, storedCallsignSuffix) {
  const chain = hierarchy.ancestorChainOf(teamId);
  const organisation = chain[0];

  const selectedDepths = organisation.callsign_level_selection == null
    ? Array.from({ length: MAX_TEAM_DEPTH }, (_, index) => index + 1)
    : organisation.callsign_level_selection;

  const teamSegment = chain
    .filter((team) => team.depth >= 1
      && selectedDepths.includes(team.depth)
      && !!team.callsign_prefix)
    .map((team) => team.callsign_prefix)
    .join('');

  return joinCallsignSegments([
    organisation.callsign_prefix || '',
    teamSegment,
    storedCallsignSuffix || ''
  ]);
}

/**
 * Every ordered pair of distinct same-Organisation Teams, as
 * `transferPairArb` gives, but with the Organisation-root-as-DESTINATION
 * pairs drawn as their own weighted branch.
 *
 * Requirement 8.6 is a statement about exactly those pairs. They are already
 * inside the uniform pair set, but in a six-Team hierarchy they are a small
 * minority of it, and a criterion that only a handful of 100 runs even reach
 * is not meaningfully covered. `minTeamsPerOrganisation` of 2 guarantees the
 * branch is non-empty.
 */
function callsignDerivationPairArb(hierarchy) {
  const pairs = [];

  for (const sourceTeamId of hierarchy.teamIds) {
    for (const destinationTeamId of hierarchy.teamIds) {
      if (sourceTeamId !== destinationTeamId
        && hierarchy.sameOrganisation(sourceTeamId, destinationTeamId)) {
        pairs.push({ sourceTeamId, destinationTeamId });
      }
    }
  }

  const organisationDestinationPairs = pairs.filter(
    (pair) => hierarchy.depthOf(pair.destinationTeamId) === 0
  );

  return fc.oneof(
    { arbitrary: fc.constantFrom(...pairs), weight: 2 },
    { arbitrary: fc.constantFrom(...organisationDestinationPairs), weight: 1 }
  );
}

/**
 * A transfer scenario shaped like `transferScenarioArb`'s output, but with
 * the destination distribution above.
 *
 * The hierarchy arbitrary already draws `callsign_prefix` from the whole
 * space (a `[A-Z0-9]{1,6}` value, `null`, and `''`) and the Organisation's
 * `callsign_level_selection` from `null` plus every non-empty subset of
 * `1..MAX_TEAM_DEPTH`, and its `chain`/`flat`/`random` shape draw is what
 * makes a chain deep enough for a selection to actually exclude a level
 * common rather than vanishingly rare. Both are what task 7.2 asks this
 * property to range over, so neither is re-specified here.
 */
function callsignDerivationScenarioArb() {
  return hierarchyArb({
    minTeamsPerOrganisation: 2,
    maxTeamsPerOrganisation: 6
  }).chain((hierarchy) =>
    fc.record({
      hierarchy: fc.constant(hierarchy),
      channels: channelLayoutArb(hierarchy),
      pair: callsignDerivationPairArb(hierarchy),
      priorRole: fc.constantFrom('member', 'admin'),
      storedCallsignSuffix: callsignSuffixArb()
    }).map(({ pair, ...rest }) => ({ ...rest, ...pair }))
  );
}

/**
 * Requirements 8.1 and 8.6 are one statement about where a transferred
 * member's callsign comes from, so one property covers both: the
 * Destination_Team's Ancestor_Chain and the user's stored Callsign_Suffix
 * determine it, and nothing else does.
 *
 * The harness defaults `generateCallsign` to `null` -- the documented
 * "skip steps 2-4" path -- which would make this property assert only that a
 * mock returns what it was told to. So this is the one block that lets the
 * REAL derivation run: `generateCallsign` delegates to
 * `jest.requireActual('./userAttributes')`, whose `computeCallsignAttributes`
 * resolves the chain through the mocked `Team.getAncestorChain` (the
 * generated rows), reads the Callsign_Suffix through the mocked `pool` (the
 * harness store, extended below with the one statement the harness does not
 * itself dispatch), and assembles through the real `CallsignService`. The
 * subject is therefore the actual derivation, and the expected value is a
 * reference walk of the generated hierarchy -- `referenceCallsignFor` --
 * which never calls into it.
 *
 * Option (b) from task 7.2 -- asserting only that `generateCallsign` receives
 * `(userId, destinationTeamId)` -- is kept as ONE of the clauses rather than
 * as the whole property. On its own it would pin the call site while leaving
 * Requirement 8.6's `depth >= 1` filter, the Callsign_Level_Selection
 * default, and the segment join entirely unexercised, since a mocked
 * `generateCallsign` produces whatever it was configured to produce
 * regardless of the hierarchy it was handed.
 *
 * "And nothing else" is the load-bearing half, and it is asserted three ways:
 *
 *   - the expected value mentions no Source_Team datum at all: not the source
 *     chain's prefixes, not the source Organisation's level selection, not
 *     `priorRole`, not the revoked Channels. A dependency on any of them
 *     shows up as an inequality.
 *   - when the source chain would predict a DIFFERENT callsign -- the common
 *     case, since the two chains diverge below their shared ancestor -- the
 *     actual value is asserted not to be that one. This is the clause a
 *     swapped `sourceTeamId`/`destinationTeamId` argument fails, and it fails
 *     it even if the call-argument clause below were removed.
 *   - the Team segment is asserted to contain the destination chain's
 *     selected prefixes in depth order and to be empty for an
 *     Organisation-root destination (Requirement 8.6), which is what
 *     distinguishes "derived from the destination chain" from "derived from
 *     the destination Team's own prefix" or from the full unfiltered walk.
 *
 * Not asserted here: that the computed value lands in `user_cache` and in
 * Authentik (Property 17, task 7.3), and which of the three Callsign_Suffix
 * links won (Property 29, task 6.8). This property supplies neither suffix
 * parameter, so the Name segment is the generated stored value and the
 * derivation is the only thing under test.
 */
// Feature: team-member-transfer, Property 16: The callsign derives from the destination chain and nothing else
describe('Property 16: The callsign derives from the destination chain and nothing else', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([callsignDerivationScenarioArb()], { numRuns: 100 })(
    'produces the callsign the Destination_Team Ancestor_Chain and the stored Callsign_Suffix predict, with no Sub_Team segment for an Organisation destination and no dependence on the Source_Team chain',
    async (scenario) => {
      // The module-level mocks are shared across every run of this one test,
      // and the call-count clause below is exact, so the log has to start
      // empty. `clearAllMocks` clears recorded calls only; the harness
      // re-installs every implementation immediately after.
      jest.clearAllMocks();

      const harness = createTransferHarness(scenario);
      const { hierarchy, sourceTeamId, destinationTeamId, storedCallsignSuffix } = scenario;

      // The real derivation reads `users.callsign_suffix` through the shared
      // `pool`, which the harness's dispatcher does not handle (nothing in
      // `TeamTransferService` itself issues that statement off the pool).
      // Wrapping rather than replacing keeps every other post-commit
      // statement -- the `users` read, the `user_cache` upsert, the audit
      // insert -- going to the harness store as before.
      pool.query.mockImplementation(async (sql, params = []) => {
        const text = String(sql);

        if (/SELECT callsign_suffix\s+FROM users/.test(text)) {
          const row = harness.store.users.find((user) => user.id === params[0]);

          return {
            rows: row ? [{ callsign_suffix: row.callsign_suffix }] : [],
            rowCount: row ? 1 : 0
          };
        }

        return harness.poolQuery(sql, params);
      });

      // The subject: the real `generateCallsign`, over the generated
      // hierarchy. Called as a method so its `this.computeCallsignAttributes`
      // delegation resolves.
      UserAttributesService.generateCallsign.mockImplementation((userId, teamId) =>
        realUserAttributesService.generateCallsign(userId, teamId));

      // No suffix parameter on either link, so Requirement 9.7 resolves to
      // link (c) and the Name segment is exactly the generated stored value.
      const outcome = await TeamTransferService.executeTransfer(harness.client, {
        userId: harness.userId,
        destinationTeamId,
        actorId: harness.actorId,
        actorIsGlobalManager: false
      });

      const { callsign } = await TeamTransferService.applyPostCommitEffects(outcome);

      // Non-vacuity: `computeCallsignAttributes` swallows its own errors and
      // returns `null`, which `applyPostCommitEffects` reports as a `null`
      // callsign. A missing pool dispatch above would therefore look like a
      // legitimately absent callsign rather than a broken test.
      expect(typeof callsign).toBe('string');

      const destinationChain = hierarchy.ancestorChainOf(destinationTeamId);

      // Requirement 8.1 -- the whole value, from the destination chain plus
      // the stored Callsign_Suffix.
      const expectedCallsign = referenceCallsignFor(
        hierarchy,
        destinationTeamId,
        storedCallsignSuffix
      );

      expect(callsign).toBe(expectedCallsign);

      // Requirement 8.1, stated as the call site: the chain resolved is the
      // DESTINATION's. `executeTransfer` resolves the source chain for its
      // own Organisation-boundary check, so "the destination one was used"
      // has to be asserted on the derivation call rather than on
      // `Team.getAncestorChain`'s call log.
      expect(UserAttributesService.generateCallsign).toHaveBeenCalledTimes(1);
      expect(UserAttributesService.generateCallsign).toHaveBeenCalledWith(
        harness.userId,
        destinationTeamId
      );

      // "Nothing else", as the strongest single observable: the Source_Team
      // chain predicts some callsign too, and whenever that differs the
      // actual value is not it.
      const sourceReferenceCallsign = referenceCallsignFor(
        hierarchy,
        sourceTeamId,
        storedCallsignSuffix
      );

      if (sourceReferenceCallsign !== expectedCallsign) {
        expect(callsign).not.toBe(sourceReferenceCallsign);
      }

      // The segment structure, so the equality above cannot hold for the
      // wrong reason. At most three segments, in order: Organisation, Team,
      // Name.
      const organisationSegment = destinationChain[0].callsign_prefix || '';
      const nameSegment = storedCallsignSuffix || '';

      const selectedDepths = destinationChain[0].callsign_level_selection == null
        ? Array.from({ length: MAX_TEAM_DEPTH }, (_, index) => index + 1)
        : destinationChain[0].callsign_level_selection;

      const expectedTeamSegmentPrefixes = destinationChain
        .filter((team) => team.depth >= 1
          && selectedDepths.includes(team.depth)
          && !!team.callsign_prefix)
        .map((team) => team.callsign_prefix);

      expect(callsign).toBe(joinCallsignSegments([
        organisationSegment,
        expectedTeamSegmentPrefixes.join(''),
        nameSegment
      ]));

      // Requirement 8.6 -- an Organisation destination has a one-row
      // Ancestor_Chain, so the `depth >= 1` filter leaves no Team segment at
      // all and the result is the Organisation prefix and the
      // Callsign_Suffix, nothing between them.
      if (hierarchy.depthOf(destinationTeamId) === 0) {
        expect(destinationChain).toHaveLength(1);
        expect(expectedTeamSegmentPrefixes).toEqual([]);
        expect(callsign).toBe(joinCallsignSegments([organisationSegment, nameSegment]));
        expect(callsign.split('-').filter((segment) => segment !== '').length)
          .toBeLessThanOrEqual(2);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Property 17 (task 7.3)
// ---------------------------------------------------------------------------

/**
 * The `user_cache` columns the periodic Authentik synchronisation owns.
 *
 * A transfer has no new information about any of them, so step 2's
 * `DO UPDATE` must leave every one alone on an existing cache row -- which
 * is only observable if the seeded row DISAGREES with the `users` row it
 * would be refreshed from. `staleCacheRowFor` below supplies that
 * disagreement.
 */
const SYNC_OWNED_CACHE_COLUMNS = ['username', 'email', 'first_name', 'last_name', 'is_active'];

/**
 * A pre-existing `user_cache` row for the Transferred_User -- the
 * `DO UPDATE` branch's precondition.
 *
 * Shaped as an earlier transfer (or an earlier synchronisation) would have
 * left it, and deliberately disagreeing with the `users` row on every
 * column of `SYNC_OWNED_CACHE_COLUMNS` and on all four columns step 2
 * writes. Any column the statement names is therefore observable as a
 * change away from these values, and any column it does not name is
 * observable as one of them surviving.
 *
 * @param {object} user the harness's `users` row for the Transferred_User
 * @returns {object} a `user_cache`-shaped row
 */
function staleCacheRowFor(user) {
  return {
    // `user_cache.authentik_id` is a varchar, so an existing row's key is a
    // STRING even though `users.authentik_user_id` is an integer. That
    // mismatch is the whole reason step 2 casts.
    authentik_id: String(user.authentik_user_id),
    username: 'stale.username',
    email: 'stale@example.test',
    first_name: 'Stale',
    last_name: 'Row',
    is_active: false,
    tak_callsign: 'STALE-CALLSIGN',
    tak_color: '#000000',
    tak_role: 'Stale Role',
    callsign_suffix: 'Stale.Suffix'
  };
}

/**
 * A model of Postgres's behaviour for step 2's
 * `INSERT ... SELECT ... ON CONFLICT (authentik_id) DO UPDATE`, faithful in
 * the two respects this property turns on.
 *
 * 1. **The `::text` cast.** `user_cache.authentik_id` is a varchar and
 *    `users.authentik_user_id` is an integer, so the value the SELECT
 *    produces only collides with an existing key when the statement casts.
 *    The key is therefore derived from the SQL TEXT -- `String(...)` when
 *    `u.authentik_user_id::text` is present, the raw integer otherwise --
 *    and matched with `===`. Drop the cast and an existing row is missed,
 *    which surfaces here as a SECOND cache row rather than as an updated
 *    one. (Real Postgres rejects the uncast comparison outright; either way
 *    the `DO UPDATE` does not land, which is the observable that matters.)
 * 2. **The `DO UPDATE SET` column list.** Only the columns the clause
 *    actually names are assigned, parsed out of the statement rather than
 *    assumed, so an implementation that started refreshing `username` or
 *    `email` from the `users` row would be visible as the seeded value
 *    being overwritten.
 *
 * The `WHERE u.id = $1 AND u.authentik_user_id IS NOT NULL` predicate is
 * modelled too: no matching `users` row, or a null Authentik id, inserts
 * nothing.
 *
 * @param {object} store the harness store
 * @param {string} text the statement as issued
 * @param {Array} params
 */
function applyUserCacheStatement(store, text, params) {
  const [cacheUserId, takCallsign, takColor, takRole, callsignSuffix] = params;
  const user = store.users.find((row) => row.id === cacheUserId);

  if (!user || user.authentik_user_id == null) {
    return;
  }

  const insertedKey = /u\.authentik_user_id::text/.test(text)
    ? String(user.authentik_user_id)
    : user.authentik_user_id;

  const insertColumns = (/INSERT INTO user_cache \(([^)]*)\)/.exec(text)?.[1] ?? '')
    .split(',')
    .map((column) => column.trim());

  const updateColumns = Array.from(
    (text.split(/DO UPDATE SET/)[1] ?? '').matchAll(/(\w+)\s*=/g),
    (match) => match[1]
  );

  const written = {
    tak_callsign: takCallsign,
    tak_color: takColor,
    tak_role: takRole,
    callsign_suffix: callsignSuffix
  };

  const existing = store.userCache.find((row) => row.authentik_id === insertedKey);

  if (existing) {
    for (const column of updateColumns) {
      existing[column] = written[column];
    }

    return;
  }

  store.userCache.push({
    authentik_id: insertedKey,
    username: user.username,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    is_active: user.is_active ?? true,
    tak_callsign: takCallsign,
    tak_color: takColor,
    tak_role: takRole,
    // Absent from the INSERT column list means the column takes its
    // database default on a freshly inserted row.
    callsign_suffix: insertColumns.includes('callsign_suffix') ? callsignSuffix : null
  });
}

/**
 * Replaces the harness's `pool.query` with one that adds the two
 * statements this property needs and delegates everything else back.
 *
 * `SELECT callsign_suffix FROM users` is the real `computeCallsignAttributes`
 * reaching for the stored Callsign_Suffix (the harness does not dispatch it
 * because nothing in `TeamTransferService` itself issues it off the pool),
 * and `INSERT INTO user_cache` goes to the stricter model above instead of
 * the harness's permissive one.
 *
 * @param {object} harness
 * @returns {Array<{text: string, params: Array}>} every `user_cache`
 *   statement issued, in order
 */
function installUserCacheModel(harness) {
  const cacheStatements = [];

  pool.query.mockImplementation(async (sql, params = []) => {
    const text = String(sql);

    if (/SELECT callsign_suffix\s+FROM users/.test(text)) {
      const row = harness.store.users.find((user) => user.id === params[0]);

      return {
        rows: row ? [{ callsign_suffix: row.callsign_suffix }] : [],
        rowCount: row ? 1 : 0
      };
    }

    if (/INSERT INTO user_cache/.test(text)) {
      cacheStatements.push({ text, params });
      applyUserCacheStatement(harness.store, text, params);

      return { rows: [], rowCount: 1 };
    }

    return harness.poolQuery(sql, params);
  });

  return cacheStatements;
}

/**
 * One round-trip attempt: a transfer scenario, which of Requirement 9.7's
 * links supplies the Callsign_Suffix, the value the two supplying links
 * carry, and whether a `user_cache` row already exists.
 *
 * `suffixSource` is the dimension Requirement 9.5's conditionality lives on:
 *
 *   - `immediate` -- link (a), `POST /api/users/:userId/transfer`'s
 *     `callsignSuffix` (Requirement 9.3),
 *   - `approval` -- link (b), the Transfer_Request's stored
 *     `access_requests.callsign_suffix` (Requirement 9.4),
 *   - `stored` -- link (c), the user's own `users.callsign_suffix`, which
 *     this transfer did not write and so has nothing to mirror.
 *
 * The supplied value is drawn PRESENT for the first two: an absent one
 * would fall through to link (c) and collapse the dimension. Which link
 * wins when several are present is Property 29's subject, not this one's.
 *
 * `hasPreExistingCacheRow` is the INSERT/`DO UPDATE` dimension. Both
 * branches are real -- a user provisioned before the cache table was
 * populated has no row, a user who has been synchronised once has one --
 * and they differ in exactly the way step 2's shape exists to handle.
 */
function userCacheRoundTripArb() {
  return fc.record({
    scenario: transferScenarioArb(),
    suffixSource: fc.constantFrom('immediate', 'approval', 'stored'),
    suppliedCallsignSuffix: callsignSuffixArb({ includeAbsent: false }),
    hasPreExistingCacheRow: fc.boolean()
  });
}

/**
 * Requirements 8.2 and 9.5 are one statement about `user_cache`: everything
 * a transfer computes about a member's TAK identity ends up on that member's
 * cache row, and nothing a transfer did not compute is touched. This is also
 * Requirement 17.4's assertion -- a completed transfer stores a callsign
 * DERIVED FROM THE DESTINATION CHAIN in the Transferred_User's `user_cache`
 * row -- which is why the callsign asserted here is a reference walk of the
 * generated hierarchy rather than a stub constant.
 *
 * The derivation itself runs for real, the way Property 16 established:
 * `generateCallsign` delegates to `jest.requireActual('./userAttributes')`,
 * so `computeCallsignAttributes` resolves the chain through the mocked
 * `Team.getAncestorChain` (the generated rows) and reads the Callsign_Suffix
 * through the mocked `pool` (the harness store, including whatever step 3 of
 * `executeTransfer` just wrote). A stubbed callsign would make the central
 * assertion "the mock's return value reached the cache", which is plumbing
 * rather than Requirement 17.4; running the real derivation makes it "the
 * value the destination Ancestor_Chain predicts reached the cache". The
 * harness's default `null` callsign would skip step 2 altogether, so opting
 * in is also this property's precondition, not a convenience.
 *
 * Four things are asserted, over both the INSERT and the `DO UPDATE` branch:
 *
 *   - **Requirement 8.2, the round trip.** `tak_callsign` is the callsign
 *     the destination chain and the effective Callsign_Suffix predict,
 *     `tak_color` is the destination Organisation's colour, `tak_role` is
 *     the role the derivation assigns. Each expected value is walked out of
 *     the generated data.
 *   - **The `::text` cast.** The statement casts, and the cache row is keyed
 *     by the STRING form of `users.authentik_user_id`. On the `DO UPDATE`
 *     branch the seeded row is updated in place and no second row appears --
 *     which is what an uncast integer comparison against a varchar key would
 *     produce (see `applyUserCacheStatement`).
 *   - **Requirement 9.5's conditionality.** `callsign_suffix` is mirrored
 *     exactly when THIS transfer applied one (links (a) and (b)), and left
 *     alone when the suffix resolved from the user's own stored value (link
 *     (c)) -- on the `DO UPDATE` branch the seeded suffix survives untouched
 *     in that case, which is the load-bearing half: a statement that always
 *     mirrored would overwrite it with a value the transfer never stored.
 *   - **Ownership of the rest.** `username`, `email`, `first_name`,
 *     `last_name`, and `is_active` belong to the periodic Authentik
 *     synchronisation. On the `DO UPDATE` branch every one keeps its seeded
 *     value, all five of which deliberately disagree with the `users` row
 *     the statement selects from.
 *
 * Not asserted here: what the Authentik PATCH receives and that it follows
 * the cache write (task 7.6), and which link wins when more than one is
 * present (Property 29).
 */
// Feature: team-member-transfer, Property 17: Computed identity attributes round-trip into user_cache
describe('Property 17: Computed identity attributes round-trip into user_cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([userCacheRoundTripArb()], { numRuns: 100 })(
    'writes the callsign the destination Ancestor_Chain predicts, the destination colour, and the TAK role onto the cache row keyed by the string form of the Authentik id -- inserting it or updating it in place -- mirroring the Callsign_Suffix exactly when the transfer applied one and leaving the synchronisation-owned columns alone',
    async ({ scenario, suffixSource, suppliedCallsignSuffix, hasPreExistingCacheRow }) => {
      // The module-level mocks are shared across every run of this one test,
      // and the statement-count clause below is exact, so the log has to
      // start empty. `clearAllMocks` clears recorded calls only; the harness
      // re-installs every implementation immediately after.
      jest.clearAllMocks();

      const harness = createTransferHarness(scenario);
      const { hierarchy, destinationTeamId, sourceTeamId, storedCallsignSuffix } = scenario;

      const identityBefore = { ...harness.store.users.find((row) => row.id === harness.userId) };
      const cacheRowBefore = hasPreExistingCacheRow ? staleCacheRowFor(identityBefore) : null;

      if (cacheRowBefore) {
        harness.store.userCache.push({ ...cacheRowBefore });
      }

      const cacheStatements = installUserCacheModel(harness);

      // The subject of Requirement 17.4: the real derivation, over the
      // generated hierarchy. Called as a method so its
      // `this.computeCallsignAttributes` delegation resolves.
      UserAttributesService.generateCallsign.mockImplementation((userId, teamId) =>
        realUserAttributesService.generateCallsign(userId, teamId));

      // The two supplying links, as their call sites pass them: the route
      // fills `callsignSuffix`, `RequestApprovalService` fills
      // `requestCallsignSuffix`, and link (c) fills neither.
      const suffixParams = {
        callsignSuffix: suffixSource === 'immediate' ? suppliedCallsignSuffix : null,
        requestCallsignSuffix: suffixSource === 'approval' ? suppliedCallsignSuffix : null
      };

      const outcome = await TeamTransferService.executeTransfer(harness.client, {
        userId: harness.userId,
        destinationTeamId,
        actorId: harness.actorId,
        actorIsGlobalManager: false,
        ...suffixParams
      });

      const { callsign } = await TeamTransferService.applyPostCommitEffects(outcome);

      // -----------------------------------------------------------------
      // The expected values, walked out of the generated data.
      //
      // A suffix arriving on link (a) or (b) is trimmed and stored on
      // `users` by step 3, so the derivation reads that value back; link (c)
      // leaves whatever the user already held, untrimmed.
      // -----------------------------------------------------------------
      const appliedSuffix = suffixSource === 'stored' ? null : suppliedCallsignSuffix.trim();
      const effectiveNameSegment = appliedSuffix ?? storedCallsignSuffix;

      const expectedCallsign = referenceCallsignFor(
        hierarchy,
        destinationTeamId,
        effectiveNameSegment
      );
      const expectedColor = hierarchy.ancestorChainOf(destinationTeamId)[0].color;
      const expectedRole = 'Team Member';

      // Non-vacuity: `computeCallsignAttributes` swallows its own errors and
      // returns `null`, and a `null` callsign is `applyPostCommitEffects`'s
      // documented "skip steps 2-4" path -- under which every assertion
      // below would hold against an untouched table. It must have run.
      expect(typeof callsign).toBe('string');
      expect(callsign).toBe(expectedCallsign);
      expect(outcome.callsignSuffixApplied).toBe(appliedSuffix);

      // -----------------------------------------------------------------
      // The `::text` cast. Modelled in `applyUserCacheStatement` from the
      // statement's own text, so this clause is the one that pins it: the
      // cache row is located and keyed by the STRING form of an integer
      // column.
      // -----------------------------------------------------------------
      expect(cacheStatements).toHaveLength(1);
      expect(cacheStatements[0].text).toMatch(/u\.authentik_user_id::text/);
      expect(cacheStatements[0].text).toMatch(/ON CONFLICT \(authentik_id\) DO UPDATE/);

      // Exactly one row either way: inserted on the branch with no prior
      // row, updated IN PLACE on the branch with one. A missed conflict --
      // which is what comparing an uncast integer against a varchar key
      // amounts to -- would leave two.
      expect(harness.store.userCache).toHaveLength(1);

      const cacheRowAfter = harness.store.userCache[0];

      expect(cacheRowAfter.authentik_id).toBe(String(identityBefore.authentik_user_id));
      expect(typeof cacheRowAfter.authentik_id).toBe('string');

      // -----------------------------------------------------------------
      // Requirement 8.2 -- the round trip itself.
      // -----------------------------------------------------------------
      expect(cacheRowAfter.tak_callsign).toBe(expectedCallsign);
      expect(cacheRowAfter.tak_color).toBe(expectedColor);
      expect(cacheRowAfter.tak_role).toBe(expectedRole);

      // "Derived from the DESTINATION chain" (Requirement 17.4), as the
      // strongest single observable: the Source_Team chain predicts a
      // callsign and a colour too, and whenever either differs the cached
      // value is not that one.
      const sourceReferenceCallsign = referenceCallsignFor(
        hierarchy,
        sourceTeamId,
        effectiveNameSegment
      );
      const sourceOrganisationColor = hierarchy.ancestorChainOf(sourceTeamId)[0].color;

      if (sourceReferenceCallsign !== expectedCallsign) {
        expect(cacheRowAfter.tak_callsign).not.toBe(sourceReferenceCallsign);
      }

      if (sourceOrganisationColor !== expectedColor) {
        expect(cacheRowAfter.tak_color).not.toBe(sourceOrganisationColor);
      }

      // -----------------------------------------------------------------
      // Requirement 9.5 -- mirrored exactly when this transfer applied a
      // Callsign_Suffix, left alone when it did not.
      // -----------------------------------------------------------------
      if (appliedSuffix !== null) {
        expect(cacheRowAfter.callsign_suffix).toBe(appliedSuffix);
        // And it really is the value the transfer stored on `users`, not a
        // coincidence of the seeded row.
        expect(harness.store.users[0].callsign_suffix).toBe(appliedSuffix);
      } else if (cacheRowBefore) {
        expect(cacheRowAfter.callsign_suffix).toBe(cacheRowBefore.callsign_suffix);
      } else {
        // A freshly inserted row takes the column's database default: the
        // statement omits `callsign_suffix` from its column list entirely
        // when there is nothing to mirror.
        expect(cacheRowAfter.callsign_suffix).toBeNull();
      }

      // -----------------------------------------------------------------
      // The columns the periodic Authentik synchronisation owns. On the
      // `DO UPDATE` branch every one keeps its seeded value -- all five of
      // which disagree with the `users` row the statement selects from, so
      // an implementation that refreshed them here would be visible.
      // -----------------------------------------------------------------
      if (cacheRowBefore) {
        for (const column of SYNC_OWNED_CACHE_COLUMNS) {
          expect(cacheRowAfter[column]).toBe(cacheRowBefore[column]);
          expect(cacheRowAfter[column]).not.toBe(identityBefore[column]);
        }
      } else {
        // On the INSERT branch there is no prior row to preserve, so the
        // same columns come from the `users` row the SELECT reads.
        for (const column of SYNC_OWNED_CACHE_COLUMNS) {
          expect(cacheRowAfter[column]).toBe(identityBefore[column]);
        }
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Property 19 (task 7.4)
// ---------------------------------------------------------------------------

/**
 * A supplied Callsign_Suffix as its two call sites can actually deliver it,
 * including untrimmed.
 *
 * Link (a) arrives through `express-validator`'s `.trim()`, so the route
 * cannot deliver padding -- but link (b) is
 * `access_requests.callsign_suffix`, a plain nullable column with no
 * trimming anywhere between the insert and the read, which the service's own
 * `nonEmpty` comment calls out as the reason absence is tested on the
 * trimmed form rather than assumed away. Padding is therefore drawn here so
 * "the value is applied" is asserted about the value a user would recognise
 * rather than about whatever whitespace came with it.
 */
function suppliedCallsignSuffixArb() {
  return fc
    .record({
      value: callsignSuffixArb({ includeAbsent: false }),
      leadingPad: fc.constantFrom('', ' ', '  '),
      trailingPad: fc.constantFrom('', ' ', ' \t')
    })
    .map(({ value, leadingPad, trailingPad }) => `${leadingPad}${value}${trailingPad}`);
}

/**
 * One supplied-suffix application: a transfer scenario whose Transferred_User
 * ALREADY holds a Callsign_Suffix, one of the three shapes a supplied suffix
 * arrives in, and a supplied value guaranteed distinct from the stored one.
 *
 * `entry` is the dimension Requirements 9.3 and 9.4 live on:
 *
 *   - `immediate` -- Requirement 9.3: `POST /api/users/:userId/transfer`'s
 *     `callsignSuffix` body field, passed as `params.callsignSuffix`.
 *   - `approvalOverride` -- Requirement 9.4's first form: the
 *     `POST /api/requests/:requestId/approve` body's `callsignSuffix`
 *     override, which `RequestApprovalService` passes on that same
 *     parameter. Identical in shape to `immediate` by construction, and
 *     deliberately enumerated anyway: the two requirements are separate
 *     clauses about separate endpoints, and a change that started ignoring
 *     the override on the approval path would be a change to this parameter.
 *   - `approvalRequest` -- Requirement 9.4's second form: the Transfer_Request's
 *     stored `access_requests.callsign_suffix`, which arrives on the
 *     STRUCTURALLY DIFFERENT `params.requestCallsignSuffix`.
 *
 * The stored suffix is drawn PRESENT and the supplied one is filtered to
 * differ from it after trimming. That is what makes every clause below
 * falsifiable: a service that ignored the parameter entirely and fell
 * through to the user's existing value would still produce a stored suffix,
 * a callsign with a name segment, and a mirrored cache column -- just the
 * wrong ones. Distinct values turn "applied" from a presence check into an
 * equality check.
 */
function suppliedSuffixApplicationArb() {
  return fc
    .record({
      scenario: transferScenarioArb(),
      storedCallsignSuffix: callsignSuffixArb({ includeAbsent: false }),
      entry: fc.constantFrom('immediate', 'approvalOverride', 'approvalRequest'),
      suppliedCallsignSuffix: suppliedCallsignSuffixArb()
    })
    .filter(({ storedCallsignSuffix, suppliedCallsignSuffix }) =>
      suppliedCallsignSuffix.trim() !== storedCallsignSuffix)
    .map(({ scenario, storedCallsignSuffix, ...rest }) => ({
      scenario: { ...scenario, storedCallsignSuffix },
      ...rest
    }));
}

/**
 * Requirements 9.3 and 9.4 are one statement about a supplied
 * Callsign_Suffix, differing only in which endpoint supplied it, so one
 * property covers both: whichever of the three ways a value arrives, it is
 * the value the transfer ends up using everywhere it could be used.
 *
 * "Applied" is asserted as all four of its observable consequences, over a
 * user who already holds a DIFFERENT suffix so each one is an equality
 * rather than a presence check:
 *
 *   - **On the transaction client.** Exactly one
 *     `UPDATE users SET callsign_suffix` is issued, on `client` and never on
 *     the shared `pool`, carrying the trimmed value and the Transferred_User's
 *     id. Both requirements say "on the same Database transaction as the
 *     membership writes", and a write issued off the pool would satisfy the
 *     end state while silently surviving the ROLLBACK of Requirement 9.2.
 *   - **On the outcome.** `callsignSuffixApplied` and
 *     `callsignSuffixEffective` both carry it -- the first is what makes
 *     `applyPostCommitEffects` mirror it (Requirement 9.5), the second is
 *     what the callsign is built from.
 *   - **In the callsign.** The derived callsign's Name segment IS the
 *     supplied value, and the callsign is not the one the user's previously
 *     stored suffix would have produced. The derivation runs for real, the
 *     way Property 16 established, so this is the actual assembled value
 *     rather than a mock's return.
 *   - **In `user_cache`.** Requirement 9.5's mirror, asserted against a
 *     pre-seeded cache row holding a different suffix, so the column is
 *     observably overwritten rather than coincidentally correct.
 *
 * The distinction from Property 29 (task 6.8) is deliberate and load-bearing.
 * Property 29 varies all three links over present and absent and asserts
 * WHICH ONE WINS the precedence chain, entirely inside `executeTransfer`:
 * it never runs `applyPostCommitEffects`, so it says nothing about a
 * resolved suffix reaching a callsign or a cache row. This property fixes
 * precedence out of the picture -- exactly one link is ever supplied -- and
 * follows the winner end to end, across the transaction boundary, through
 * the real derivation, into `user_cache`. Neither implies the other: a
 * service could resolve the chain perfectly and never mirror it, or mirror
 * faithfully while reading the wrong link.
 *
 * The distinction from Property 17 (task 7.3) is subject rather than
 * coverage: Property 17 is about the `user_cache` STATEMENT -- its `::text`
 * cast, its INSERT and `DO UPDATE` branches, and which columns it leaves to
 * the periodic Authentik synchronisation -- with the suffix as one input
 * among several. Here the suffix is the subject and the cache row is one of
 * four places it has to land.
 *
 * Not asserted here: the colour and TAK role (Property 17), what the
 * Authentik PATCH receives and that it follows the cache write (task 7.6),
 * and the case-insensitive collision that a supplied suffix can provoke
 * (Property 18, task 9.7).
 */
// Feature: team-member-transfer, Property 19: A supplied Callsign_Suffix is applied on both paths
describe('Property 19: A supplied Callsign_Suffix is applied on both paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([suppliedSuffixApplicationArb()], { numRuns: 100 })(
    'stores a suffix supplied on the immediate call, on the approve override, or on the Transfer_Request row to users.callsign_suffix on the transaction client, reports it as applied, uses it as the callsign name segment, and mirrors it into user_cache',
    async ({ scenario, entry, suppliedCallsignSuffix }) => {
      // The module-level `pool.query` mock is shared across every run of this
      // one test, and the "no suffix write off the pool" clause below reads
      // its call log, so the log has to start empty. `clearAllMocks` clears
      // recorded calls only; the harness re-installs every implementation
      // immediately after.
      jest.clearAllMocks();

      const harness = createTransferHarness(scenario);
      const { hierarchy, destinationTeamId, storedCallsignSuffix } = scenario;

      const identityBefore = { ...harness.store.users.find((row) => row.id === harness.userId) };

      // The `DO UPDATE` branch, seeded with a suffix of its own: Requirement
      // 9.5's mirror is only falsifiable against a cache column that already
      // holds something else.
      const cacheRowBefore = staleCacheRowFor(identityBefore);

      harness.store.userCache.push({ ...cacheRowBefore });

      const cacheStatements = installUserCacheModel(harness);

      // The real derivation, over the generated hierarchy, so the callsign
      // clause is about the assembled value rather than about a stub. Called
      // as a method so its `this.computeCallsignAttributes` delegation
      // resolves.
      UserAttributesService.generateCallsign.mockImplementation((userId, teamId) =>
        realUserAttributesService.generateCallsign(userId, teamId));

      // Exactly one link carries a value, so Requirement 9.7's precedence
      // never arbitrates -- whatever is applied was applied because THIS
      // entry supplied it.
      const suffixParams = {
        callsignSuffix: entry === 'approvalRequest' ? null : suppliedCallsignSuffix,
        requestCallsignSuffix: entry === 'approvalRequest' ? suppliedCallsignSuffix : null
      };

      // The approval entries carry the Transfer_Request identifiers their
      // caller threads through, so the two paths are modelled as their call
      // sites actually invoke them. Nothing below asserts against them --
      // the audit `details` they feed are Requirement 14's subject.
      const requestParams = entry === 'immediate'
        ? {}
        : { transferRequestId: 7301, initiatedBy: ADMIN_CANDIDATE_USER_IDS[1] };

      const outcome = await TeamTransferService.executeTransfer(harness.client, {
        userId: harness.userId,
        destinationTeamId,
        actorId: harness.actorId,
        actorIsGlobalManager: false,
        ...suffixParams,
        ...requestParams
      });

      const { callsign } = await TeamTransferService.applyPostCommitEffects(outcome);

      // The expected value: the supplied value itself, trimmed. Nothing here
      // consults the service.
      const expectedSuffix = suppliedCallsignSuffix.trim();

      // Non-vacuity of the two displacement clauses: the value being applied
      // is not the one the user already held, nor the one already sitting in
      // the cache row.
      expect(expectedSuffix).not.toBe(storedCallsignSuffix);
      expect(expectedSuffix).not.toBe(cacheRowBefore.callsign_suffix);

      // -----------------------------------------------------------------
      // Requirements 9.3 / 9.4 -- written to `users.callsign_suffix`, on the
      // transaction client.
      // -----------------------------------------------------------------
      const suffixWrites = harness.client.query.mock.calls.filter(
        ([sql]) => /UPDATE users SET callsign_suffix/.test(String(sql))
      );

      expect(suffixWrites).toHaveLength(1);
      expect(suffixWrites[0][1]).toEqual([expectedSuffix, harness.userId]);

      // And nowhere else: a suffix write issued off the shared pool would
      // outlive a ROLLBACK, which is the whole point of "on the same
      // Database transaction".
      const pooledSuffixWrites = pool.query.mock.calls.filter(
        ([sql]) => /UPDATE users SET callsign_suffix/.test(String(sql))
      );

      expect(pooledSuffixWrites).toHaveLength(0);

      expect(harness.store.users.find((row) => row.id === harness.userId).callsign_suffix)
        .toBe(expectedSuffix);

      // -----------------------------------------------------------------
      // Reported on the outcome: `callsignSuffixApplied` is what drives the
      // cache mirror, `callsignSuffixEffective` is what the callsign is
      // built from. A supplied value sets both.
      // -----------------------------------------------------------------
      expect(outcome.callsignSuffixApplied).toBe(expectedSuffix);
      expect(outcome.callsignSuffixEffective).toBe(expectedSuffix);

      // -----------------------------------------------------------------
      // Used as the Name segment of the derived callsign.
      // -----------------------------------------------------------------
      // Non-vacuity: `computeCallsignAttributes` swallows its own errors and
      // returns `null`, and a `null` callsign is `applyPostCommitEffects`'s
      // documented "skip steps 2-4" path, under which the cache clauses
      // below would hold against an untouched row.
      expect(typeof callsign).toBe('string');

      expect(callsign).toBe(referenceCallsignFor(hierarchy, destinationTeamId, expectedSuffix));

      // The Name segment specifically. No generated suffix contains the `-`
      // separator, so the final segment is exactly the suffix.
      expect(callsign.split('-').pop()).toBe(expectedSuffix);

      // And it is not the callsign the user's previously stored suffix would
      // have produced -- the clause a service that ignored the parameter
      // fails, whatever else it got right.
      expect(callsign).not.toBe(
        referenceCallsignFor(hierarchy, destinationTeamId, storedCallsignSuffix)
      );

      // -----------------------------------------------------------------
      // Requirement 9.5 -- mirrored into `user_cache`, overwriting the
      // suffix the seeded row held.
      // -----------------------------------------------------------------
      expect(cacheStatements).toHaveLength(1);
      expect(cacheStatements[0].params).toContain(expectedSuffix);

      expect(harness.store.userCache).toHaveLength(1);

      const cacheRowAfter = harness.store.userCache[0];

      expect(cacheRowAfter.authentik_id).toBe(String(identityBefore.authentik_user_id));
      expect(cacheRowAfter.callsign_suffix).toBe(expectedSuffix);
      expect(cacheRowAfter.tak_callsign).toBe(callsign);
    }
  );
});
// ---------------------------------------------------------------------------
// Property 20 (task 7.5)
// ---------------------------------------------------------------------------

/**
 * The two roles a Direct_Membership can actually hold.
 *
 * `inherited` is deliberately absent: it is the marker the derived rows
 * carry (`inherited_from_team_id` non-null), never a direct row's value --
 * the same reason `adminPlacementArb` draws from `['admin', 'member']` and
 * the harness seeds inherited rows rather than generating them.
 */
const DIRECT_MEMBERSHIP_ROLES = ['member', 'admin'];

/**
 * Role values outside the specified two, drawn at a lower weight.
 *
 * `team_memberships.role` is `character varying(20)` with a `'member'`
 * default and NO CHECK constraint (`database/schema.sql`), so the column
 * admits any short string, and `'owner'` is not hypothetical: both
 * `RequestApprovalService` and `EscalationService` still select on
 * `role IN ('admin', 'owner')`. The case variants pin down that
 * Requirement 10.3's "role other than `admin`" is exact string equality,
 * which is what the rest of the codebase's `role = 'admin'` SQL -- itself
 * case-sensitive -- already assumes. `null` is representable too (the
 * column is nullable), and a nullable read reaching a `=== 'admin'`
 * comparison is exactly the shape that silently returns `undefined`
 * instead of `false` when written carelessly.
 *
 * These are covered because Requirement 10.3 is TOTAL over the column --
 * it says "other than `admin`", not "equal to `member`" -- so a value the
 * app does not write today still has a specified answer, and the answer is
 * `false`.
 */
const UNSPECIFIED_DIRECT_MEMBERSHIP_ROLES = ['owner', 'Admin', 'ADMIN', '', null];

/**
 * One prior-role scenario: a transfer scenario whose seeded
 * Direct_Membership holds a drawn role, and the two dimensions the answer
 * must be independent of.
 *
 * `entry` distinguishes how the transfer was invoked:
 *
 *   - `immediate` -- `POST /api/users/:userId/transfer`'s Dual_Admin
 *     branch, which passes neither `expectedSourceTeamId` nor a
 *     Transfer_Request id.
 *   - `approval` -- `RequestApprovalService`'s `team_change` branch, which
 *     passes the recorded `current_team_id` as `expectedSourceTeamId` plus
 *     `transferRequestId` and `initiatedBy`.
 *
 * Requirements 10.2 and 10.3 say "WHEN a Team_Transfer is initiated"
 * without qualifying the path, so both are enumerated. `expectedSourceTeamId`
 * matters structurally rather than cosmetically: it is read from the SAME
 * locked row as the role in step 1, so a rearrangement of that step that
 * broke one would plausibly break the other.
 *
 * `actorIsGlobalManager` is drawn purely to be shown irrelevant -- the
 * exemption governs the Organisation boundary (Requirement 11.6), not what
 * the outcome reports about the role.
 */
function priorRoleScenarioArb() {
  return fc
    .record({
      scenario: transferScenarioArb(),
      priorRole: fc.oneof(
        { arbitrary: fc.constantFrom(...DIRECT_MEMBERSHIP_ROLES), weight: 3 },
        { arbitrary: fc.constantFrom(...UNSPECIFIED_DIRECT_MEMBERSHIP_ROLES), weight: 1 }
      ),
      entry: fc.constantFrom('immediate', 'approval'),
      actorIsGlobalManager: fc.boolean()
    })
    .map(({ scenario, priorRole, ...rest }) => ({
      scenario: { ...scenario, priorRole },
      ...rest
    }));
}

/**
 * Requirements 10.2 and 10.3 are the two halves of one biconditional, so
 * one property covers both: `demotedFromAdmin` is `true` exactly when the
 * Direct_Membership held `admin` immediately BEFORE the move, and `false`
 * for every other role the column can hold.
 *
 * The substance is the capture ORDERING, not the comparison. Step 1 reads
 * `role` off the Direct_Membership under `FOR UPDATE`; step 4's
 * `addUserToTeam` then DELETES that row and inserts a fresh one holding
 * `member` (Requirement 10.1). A `demotedFromAdmin` derived from the row
 * as it stands after step 4 would be `false` for every transfer that ever
 * happens -- always defensible-looking, always wrong for the admin case
 * the requirement exists to report. Three clauses pin that down:
 *
 *   - **The reported role is the seeded one.** `outcome.priorRole` equals
 *     the value the pre-transfer row held, drawn over both specified roles
 *     and four unspecified ones.
 *   - **And it is not the arrival role.** The end-state Direct_Membership
 *     holds `member`, and for every generated role other than `member`
 *     the outcome reports something DIFFERENT from it. This is the clause
 *     a post-step-4 read fails.
 *   - **The read precedes the delete.** The `member` draw is the one case
 *     where the two roles coincide and no end-state assertion can separate
 *     them, so the locked read's position relative to `addUserToTeam` is
 *     asserted directly. It is the only call-ordering assertion in this
 *     file, and it is here because the property is itself about ordering.
 *
 * `demotedFromAdmin` is also asserted to be PRESENT and boolean.
 * Requirements 10.2 and 10.3 both name a field set to `true`/`false`, and
 * a missing key or an `undefined` from a comparison against a null role
 * would serialise out of the route's JSON body entirely -- leaving the
 * Client's admin-demotion notice (Requirement 10.4) with nothing to branch
 * on while every value-equality check below still passed.
 *
 * Out of scope, deliberately:
 *
 *   - **The route and approval RESPONSE bodies.** Requirements 10.2/10.3
 *     say "in its response"; this property asserts the `TransferOutcome`
 *     field both call sites serialise verbatim. That the HTTP bodies carry
 *     it is asserted over the live database by Property 9
 *     (`users.transfer.integration.test.js`), on both the 200 and the 202
 *     branch. The 202 branch's value is computed by the route's own
 *     pre-flight read rather than by this service, so it could not be
 *     asserted here.
 *   - **The audit record of `priorRole`** (Requirement 10.5) -- Property 25,
 *     in `requests.approval.integration.test.js`. The `details` JSON is a
 *     separate artefact with its own key set; the outcome field it is built
 *     from is what this property owns.
 *   - **The demotion itself** (Requirement 10.1, the end-state `member`
 *     role) -- Property 2. It appears below only as the displacement clause's
 *     reference point, not as its own assertion.
 */
// Feature: team-member-transfer, Property 20: demotedFromAdmin reports the prior role
describe('Property 20: demotedFromAdmin reports the prior role', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.prop([priorRoleScenarioArb()], { numRuns: 100 })(
    'reports the role the Direct_Membership held before the move and sets demotedFromAdmin to exactly whether that role was admin, on both entry paths and whatever the destination row ends up holding',
    async ({ scenario, entry, actorIsGlobalManager }) => {
      // `addUserToTeam`'s invocation order is read below, and the
      // module-level mock is shared across every run of this one test, so
      // the log has to start empty. `clearAllMocks` clears recorded calls
      // only; the harness re-installs every implementation immediately
      // after.
      jest.clearAllMocks();

      const harness = createTransferHarness(scenario);
      const { destinationTeamId, priorRole } = scenario;

      const directRowBefore = harness
        .membershipRowsOf(harness.userId)
        .find((row) => row.inherited_from_team_id === null);

      // Non-vacuity of everything below: the pre-transfer row really does
      // hold the drawn role, so the outcome has something to misreport.
      expect(directRowBefore.role).toBe(priorRole);
      expect(directRowBefore.team_id).toBe(harness.sourceTeamId);

      // The approval path passes the Transfer_Request's recorded
      // `current_team_id` as `expectedSourceTeamId`, read from the same
      // locked row as the role, plus the request identifiers. The immediate
      // path passes none of them.
      const entryParams = entry === 'approval'
        ? {
          expectedSourceTeamId: harness.sourceTeamId,
          transferRequestId: 7501,
          initiatedBy: ADMIN_CANDIDATE_USER_IDS[1]
        }
        : {};

      const outcome = await TeamTransferService.executeTransfer(harness.client, {
        userId: harness.userId,
        destinationTeamId,
        actorId: harness.actorId,
        actorIsGlobalManager,
        ...entryParams
      });

      // -----------------------------------------------------------------
      // The reported role is the one held BEFORE the move.
      // -----------------------------------------------------------------
      expect(outcome.priorRole).toBe(priorRole);

      // -----------------------------------------------------------------
      // Requirements 10.2 / 10.3 -- the field is present, boolean, and set
      // to exactly whether that role was `admin`. The expected value comes
      // from the generated draw, not from the outcome's own `priorRole`.
      // -----------------------------------------------------------------
      expect(Object.prototype.hasOwnProperty.call(outcome, 'demotedFromAdmin')).toBe(true);
      expect(typeof outcome.demotedFromAdmin).toBe('boolean');
      expect(outcome.demotedFromAdmin).toBe(priorRole === 'admin');

      // -----------------------------------------------------------------
      // And it is not the role the user ARRIVES with. `addUserToTeam`
      // replaced the row the role was read from with one holding `member`,
      // so for every drawn role but `member` the outcome reports a value
      // that no longer exists anywhere in `team_memberships`.
      // -----------------------------------------------------------------
      const directRowAfter = harness
        .membershipRowsOf(harness.userId)
        .find((row) => row.inherited_from_team_id === null);

      expect(directRowAfter.team_id).toBe(destinationTeamId);
      expect(directRowAfter.role).toBe('member');

      if (priorRole !== 'member') {
        expect(outcome.priorRole).not.toBe(directRowAfter.role);
        expect(
          harness.membershipRowsOf(harness.userId).some((row) => row.role === priorRole)
        ).toBe(false);
      }

      // -----------------------------------------------------------------
      // The locked read precedes the delete. For the `member` draw the two
      // roles coincide, so this is the only clause that can distinguish a
      // captured role from a re-read one.
      // -----------------------------------------------------------------
      const lockedReadIndex = harness.client.query.mock.calls.findIndex(
        ([sql]) => /FROM team_memberships/.test(String(sql)) && /FOR UPDATE/.test(String(sql))
      );

      expect(lockedReadIndex).toBeGreaterThanOrEqual(0);
      expect(TeamMembershipService.addUserToTeam).toHaveBeenCalledTimes(1);
      expect(harness.client.query.mock.invocationCallOrder[lockedReadIndex])
        .toBeLessThan(TeamMembershipService.addUserToTeam.mock.invocationCallOrder[0]);
    }
  );
});

// ---------------------------------------------------------------------------
// Post-commit failure examples (task 7.6)
// ---------------------------------------------------------------------------

const { DEPLOYMENT_CHANNEL_ID_BASE } = require('./__fixtures__/transferArbitraries');

/**
 * Requirements 8.3, 8.4, 8.5, 13.4, 13.5, and 14.4 are examples rather than
 * a property, and deliberately so: each one names a SPECIFIC failure of a
 * SPECIFIC step and the same single observable outcome -- the committed
 * state stays put, nothing throws, and the step's own return field reports
 * what happened. Generating hierarchies would vary the one dimension these
 * criteria do not depend on while leaving the dimension they DO depend on --
 * which of the five steps failed, and how -- enumerated by hand anyway.
 * `applyPostCommitEffects`'s behaviour over generated hierarchies is already
 * Properties 16, 17, and 19's subject.
 *
 * One fixed hierarchy therefore serves all six examples, chosen so every
 * expected value is a readable literal:
 *
 *   Alpha (Organisation, ALFA)
 *   |- Bravo (BRVO)     <- Destination_Team
 *   `- Charlie (CHRL)   <- Source_Team
 *
 * With a stored Callsign_Suffix of `C.Elsen` and no level selection, the
 * destination chain predicts exactly `ALFA-BRVO-C.Elsen`, and the source
 * chain would predict `ALFA-CHRL-C.Elsen` -- so a value that came from the
 * wrong chain is visible as a literal mismatch rather than as an
 * abstraction.
 */
const POST_COMMIT_TEAM_ROWS = [
  {
    id: 1,
    parent_team_id: null,
    name: 'Alpha',
    callsign_prefix: 'ALFA',
    color: '#112233',
    callsign_name_format: null,
    visibility: 'public',
    // `null` means "every level", so both Sub_Teams contribute their prefix.
    callsign_level_selection: null
  },
  {
    id: 2,
    parent_team_id: 1,
    name: 'Bravo',
    callsign_prefix: 'BRVO',
    color: '#445566',
    callsign_name_format: null,
    visibility: 'public',
    callsign_level_selection: null
  },
  {
    id: 3,
    parent_team_id: 1,
    name: 'Charlie',
    callsign_prefix: 'CHRL',
    color: '#778899',
    callsign_name_format: null,
    visibility: 'public',
    callsign_level_selection: null
  }
];

/**
 * The Channel layout over that hierarchy: a Primary_Channel per Team, plus
 * one non-primary Channel on the Source_Team.
 *
 * Every Channel holds an `authentik_group_id`, so the transfer's committed
 * Sync_Operations are non-empty in both directions -- which is what makes
 * "the committed state stays put" a statement with something in it.
 */
const POST_COMMIT_CHANNEL_ROWS = [
  { id: 1001, team_id: 1, is_primary: true, authentik_group_id: 101001 },
  { id: 1002, team_id: 2, is_primary: true, authentik_group_id: 101002 },
  { id: 1003, team_id: 3, is_primary: true, authentik_group_id: 101003 },
  { id: 1004, team_id: 3, is_primary: false, authentik_group_id: 101004 }
];

/** The callsign the Destination_Team's Ancestor_Chain predicts. */
const POST_COMMIT_CALLSIGN = 'ALFA-BRVO-C.Elsen';

/** The Organisation's colour, and the role the derivation hardcodes. */
const POST_COMMIT_COLOR = '#112233';
const POST_COMMIT_ROLE = 'Team Member';

/**
 * `applyPostCommitEffects` builds `team_path` from the destination chain
 * with the last segment as the Team's full `name` and every earlier one as
 * `callsign_prefix || name`, joined with `' - '`.
 */
const POST_COMMIT_TEAM_PATH = 'ALFA - Bravo';

/**
 * The fixed scenario, shaped exactly like a `transferScenarioArb` value so
 * `createTransferHarness` takes it unchanged.
 *
 * The two walking helpers the harness uses (`ancestorIdsOf`,
 * `ancestorChainOf`) and the three the Channel layout exposes are
 * reimplemented over the literal rows above rather than drawn from
 * `hierarchyArb`: a generated hierarchy would put an unpredictable prefix
 * and level selection on every Team, which is the opposite of what an
 * example wants.
 */
function fixedPostCommitScenario() {
  const teams = new Map(POST_COMMIT_TEAM_ROWS.map((row) => [row.id, row]));

  const ancestorIdsOf = (teamId) => {
    const chain = [];
    let current = teamId;

    while (current != null && teams.has(current)) {
      chain.push(current);
      current = teams.get(current).parent_team_id;
    }

    return chain.reverse(); // root-first, matching getAncestorChain
  };

  const channelsForChain = (chainIds) =>
    POST_COMMIT_CHANNEL_ROWS.filter((channel) => chainIds.includes(channel.team_id));

  return {
    hierarchy: {
      teamIds: POST_COMMIT_TEAM_ROWS.map((row) => row.id),
      teams,
      ancestorIdsOf,
      ancestorChainOf: (teamId) =>
        ancestorIdsOf(teamId).map((id, depth) => ({ ...teams.get(id), depth })),
      depthOf: (teamId) => Math.max(0, ancestorIdsOf(teamId).length - 1)
    },
    channels: {
      channels: POST_COMMIT_CHANNEL_ROWS,
      channelsForChain,
      primaryChannelsForChain: (chainIds) =>
        channelsForChain(chainIds).filter((channel) => channel.is_primary),
      deploymentChannelIds: [DEPLOYMENT_CHANNEL_ID_BASE]
    },
    sourceTeamId: 3,
    destinationTeamId: 2,
    priorRole: 'admin',
    storedCallsignSuffix: 'C.Elsen'
  };
}

/**
 * Wraps the harness's transaction client so `BEGIN`/`COMMIT` are RECORDED
 * rather than rejected as unexpected SQL, delegating every other statement
 * to the harness's own dispatcher.
 *
 * Requirement 8.4 is an ordering statement -- no outbound HTTP request while
 * a transaction is open -- and an ordering statement needs the transaction
 * boundary to be observable. The harness deliberately does not dispatch
 * these (nothing in `TeamTransferService` issues them; both callers own the
 * lifecycle), so the boundary is put through the SAME `jest.fn()` the
 * service's own statements go through. That is what makes
 * `invocationCallOrder` comparable across the client, the pool,
 * `updateUserAttributes`, and `sendEmail`. `TeamTransferService.pathEquivalence.test.js`
 * dispatches them the same way, for the same reason.
 *
 * @param {object} harness
 * @returns {string[]} the transaction statements issued, in order
 */
function installTransactionLog(harness) {
  const statements = [];
  const dispatch = harness.client.query.getMockImplementation();

  harness.client.query.mockImplementation(async (sql, params = []) => {
    const text = String(sql);

    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) {
      statements.push(text.trim().toUpperCase());

      return { rows: [], rowCount: 0 };
    }

    return dispatch(sql, params);
  });

  return statements;
}

/**
 * `installUserCacheModel`'s pool -- which adds the real derivation's
 * `SELECT callsign_suffix FROM users` and the strict `user_cache` model --
 * with an optional `audit_logs` failure layered on top.
 *
 * Requirement 14.4's failure has to come from the statement itself rather
 * than from a broken store, so it is injected here and only for that one
 * statement: every other post-commit write still lands, which is what makes
 * "the audit row is the only thing missing" observable.
 *
 * @param {object} harness
 * @param {object} [options]
 * @param {boolean} [options.failAuditInsert=false]
 * @returns {Array<{text: string, params: Array}>} the `user_cache`
 *   statements issued, in order
 */
function installPostCommitPool(harness, options = {}) {
  const { failAuditInsert = false } = options;
  const cacheStatements = installUserCacheModel(harness);
  const dispatch = pool.query.getMockImplementation();

  pool.query.mockImplementation(async (sql, params = []) => {
    if (failAuditInsert && /INSERT INTO audit_logs/.test(String(sql))) {
      throw new Error('audit_logs insert failed');
    }

    return dispatch(sql, params);
  });

  return cacheStatements;
}

/**
 * Lets the REAL callsign derivation run, the way Properties 16 and 17
 * established. The harness defaults `generateCallsign` to `null`, which is
 * `applyPostCommitEffects`'s documented "skip steps 2-4" path -- under which
 * every example below would pass against a function that did nothing at all.
 */
function installRealCallsignDerivation() {
  UserAttributesService.generateCallsign.mockImplementation((userId, teamId) =>
    realUserAttributesService.generateCallsign(userId, teamId));
}

/**
 * Drives one transfer through a transaction the way both real callers do:
 * `BEGIN`, `executeTransfer`, `COMMIT`, and nothing else on the client.
 *
 * Returns the committed snapshot and the `COMMIT`'s invocation order, which
 * are the two things every example below is written against.
 *
 * @param {object} harness
 * @returns {Promise<{outcome: object, committed: object, transactionStatements: string[], commitOrder: number}>}
 */
async function runCommittedTransfer(harness) {
  const transactionStatements = installTransactionLog(harness);

  await harness.client.query('BEGIN');

  const outcome = await TeamTransferService.executeTransfer(harness.client, {
    userId: harness.userId,
    destinationTeamId: harness.destinationTeamId,
    actorId: harness.actorId,
    actorIsGlobalManager: false
  });

  await harness.client.query('COMMIT');

  const commitIndex = harness.client.query.mock.calls.findIndex(
    ([sql]) => String(sql).trim().toUpperCase() === 'COMMIT'
  );

  expect(transactionStatements).toEqual(['BEGIN', 'COMMIT']);
  expect(commitIndex).toBeGreaterThanOrEqual(0);

  return {
    outcome,
    transactionStatements,
    committed: harness.snapshot(),
    commitOrder: harness.client.query.mock.invocationCallOrder[commitIndex]
  };
}

/**
 * The transfer's committed end-state over the fixed scenario, asserted as
 * literals so the failure examples below have a known thing to be unchanged
 * from.
 *
 * @param {object} harness
 * @param {object} outcome
 */
function expectCommittedTransferEndState(harness, outcome) {
  expect(harness.membershipRowsOf(harness.userId)).toEqual([
    { user_id: 301, team_id: 2, role: 'member', inherited_from_team_id: null },
    { user_id: 301, team_id: 1, role: 'inherited', inherited_from_team_id: 2 }
  ]);

  // 1001 (the Organisation's Primary_Channel) is retained, 1002 (the
  // Destination_Team's) is granted, 1003 and 1004 (the Source_Team's) are
  // revoked, and the Deployment_Channel row is untouched.
  expect(
    harness.channelMembershipRowsOf(harness.userId).map((row) => row.channel_id).sort(ascending)
  ).toEqual([1001, 1002, DEPLOYMENT_CHANNEL_ID_BASE]);

  expect(outcome.revokedChannelIds.sort(ascending)).toEqual([1003, 1004]);
  expect(outcome.demotedFromAdmin).toBe(true);
}

/**
 * The three failure criteria of Requirements 8.5, 13.4, and 14.4 plus
 * Requirement 8.3's success case and Requirement 13.5's suppression, stated
 * as examples over one fixed hierarchy.
 *
 * The load-bearing example is the first one. Requirement 8.4 -- no external
 * HTTP request while a transaction is open -- is not a property of the
 * values `applyPostCommitEffects` computes but of WHEN it computes them, and
 * the only way that is observable is against a recorded transaction
 * boundary. So `BEGIN` and `COMMIT` are dispatched through the harness's
 * client (see `installTransactionLog`) and every outbound effect --
 * the Authentik push, the notification email, and the pool statements that
 * read and write committed rows -- is asserted to sit strictly after the
 * `COMMIT`, with nothing on the client after it.
 *
 * The remaining five examples share one shape, which is what Requirements
 * 8.5, 13.4, and 14.4 all specify: the failing step is logged, nothing is
 * rethrown, and the committed membership/channel/Sync_Operation state is
 * exactly what it was when the transaction closed. The differences between
 * them are what the returned `{callsign, emailSent, audited}` reports and
 * which of the later steps still ran:
 *
 *   - Requirement 8.5 has TWO failure forms, and both are covered.
 *     `updateUserAttributes` returns `false` rather than throwing on an
 *     Authentik error, so `false` is the ordinary case -- but it fetches and
 *     PATCHes over `fetch`, so a network-layer throw escaping it is real
 *     too, and the two would be handled by different code (a branch versus
 *     a catch). An implementation that only checked the return value would
 *     pass the first and abort the whole function on the second, losing the
 *     notification and the audit row with it.
 *   - Requirement 13.4: the email fails, `emailSent` is `false`, and the
 *     audit row is still written -- step 5 does not depend on step 4.
 *   - Requirement 14.4: the audit insert fails, `audited` is `false`, and
 *     the callsign and the email are unaffected, because step 5 runs last.
 *   - Requirement 13.5: a Team_Owned_Device gets no email AT ALL -- not a
 *     failed one, not a suppressed-and-logged-as-failed one. `sendEmail` is
 *     asserted uncalled, which is the only assertion that separates
 *     "skipped" from "attempted and swallowed", and the surrounding steps
 *     are asserted to have run so the skip cannot be a wholesale abort.
 *
 * Not asserted here: the CONTENT of the `user_cache` write (Property 17),
 * which link supplies the Callsign_Suffix (Properties 19 and 29), the audit
 * `details` key set (Property 25, over the live database), and the rendered
 * email body (Property 24, likewise). This block owns the failure paths and
 * the ordering.
 */
describe('applyPostCommitEffects failure examples (Requirements 8.3, 8.4, 8.5, 13.4, 13.5, 14.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // `clearAllMocks` clears recorded calls but NOT implementations, and the
    // harness does not own this mock, so a rejection installed by one
    // example would otherwise leak into the next.
    mockSendEmail.mockReset();
    mockSendEmail.mockResolvedValue(undefined);
  });

  it('sends the computed callsign, colour, and TAK role to Authentik, and issues no outbound effect until COMMIT is recorded', async () => {
    const harness = createTransferHarness(fixedPostCommitScenario());

    const cacheStatements = installPostCommitPool(harness);
    installRealCallsignDerivation();

    const { outcome, committed, commitOrder } = await runCommittedTransfer(harness);

    expectCommittedTransferEndState(harness, outcome);

    const effects = await TeamTransferService.applyPostCommitEffects(outcome);

    // -----------------------------------------------------------------
    // Requirement 8.3 -- the values that go to Authentik are the ones the
    // Destination_Team's Ancestor_Chain computes, keyed by the user's
    // Authentik id (not their local `users.id`).
    // -----------------------------------------------------------------
    expect(effects.callsign).toBe(POST_COMMIT_CALLSIGN);
    expect(effects.callsign).toBe(
      referenceCallsignFor(fixedPostCommitScenario().hierarchy, 2, 'C.Elsen')
    );

    expect(UserAttributesService.updateUserAttributes).toHaveBeenCalledTimes(1);
    expect(UserAttributesService.updateUserAttributes).toHaveBeenCalledWith(
      harness.store.users[0].authentik_user_id,
      { callsign: POST_COMMIT_CALLSIGN, color: POST_COMMIT_COLOR, role: POST_COMMIT_ROLE }
    );

    // The Source_Team chain predicts `ALFA-CHRL-C.Elsen`; the pushed value
    // is not that one.
    expect(UserAttributesService.updateUserAttributes).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callsign: 'ALFA-CHRL-C.Elsen' })
    );

    // The same values the cache write carried, so the two cannot diverge.
    expect(cacheStatements).toHaveLength(1);
    expect(cacheStatements[0].params.slice(1, 4))
      .toEqual([POST_COMMIT_CALLSIGN, POST_COMMIT_COLOR, POST_COMMIT_ROLE]);

    // -----------------------------------------------------------------
    // Requirement 8.4 -- every outbound effect strictly after the COMMIT.
    // -----------------------------------------------------------------
    const authentikOrder = UserAttributesService.updateUserAttributes.mock.invocationCallOrder[0];
    const emailOrder = mockSendEmail.mock.invocationCallOrder[0];
    const poolOrders = pool.query.mock.invocationCallOrder;

    expect(authentikOrder).toBeGreaterThan(commitOrder);
    expect(emailOrder).toBeGreaterThan(commitOrder);
    expect(Math.min(...poolOrders)).toBeGreaterThan(commitOrder);

    // And nothing at all on the transaction client after it: the
    // transaction is closed, not merely committed-and-still-in-use.
    expect(Math.max(...harness.client.query.mock.invocationCallOrder)).toBe(commitOrder);

    // The cache write precedes the push, which is what makes a failed push
    // self-correcting on the next periodic Authentik synchronisation.
    const cacheOrder = poolOrders[
      pool.query.mock.calls.findIndex(([sql]) => /INSERT INTO user_cache/.test(String(sql)))
    ];

    expect(cacheOrder).toBeGreaterThan(commitOrder);
    expect(cacheOrder).toBeLessThan(authentikOrder);

    // -----------------------------------------------------------------
    // The success baseline the five failure examples are measured against.
    // -----------------------------------------------------------------
    expect(effects).toEqual({ callsign: POST_COMMIT_CALLSIGN, emailSent: true, audited: true });
    expect(mockSendEmail).toHaveBeenCalledWith(
      harness.store.users[0].email,
      'team_transfer_completed',
      {
        first_name: 'Casey',
        team_path: POST_COMMIT_TEAM_PATH,
        username: harness.store.users[0].username,
        callsign: POST_COMMIT_CALLSIGN
      }
    );
    expect(harness.store.auditLogs).toHaveLength(1);

    // The committed state is not something post-commit effects touch.
    expect(harness.store.teamMemberships).toEqual(committed.teamMemberships);
    expect(harness.store.channelMemberships).toEqual(committed.channelMemberships);
    expect(harness.store.syncOperations).toEqual(committed.syncOperations);
  });

  it('leaves the committed transfer in place, logs, and does not throw when the Authentik push reports failure', async () => {
    const harness = createTransferHarness(fixedPostCommitScenario());

    installPostCommitPool(harness);
    installRealCallsignDerivation();

    const { outcome, committed } = await runCommittedTransfer(harness);

    // Requirement 8.5's ordinary form: `updateUserAttributes` swallows an
    // Authentik error itself and reports it as `false`.
    UserAttributesService.updateUserAttributes.mockResolvedValue(false);

    const effects = await TeamTransferService.applyPostCommitEffects(outcome);

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: harness.userId, callsign: POST_COMMIT_CALLSIGN }),
      expect.stringContaining('Authentik attribute push failed')
    );

    // The failed push costs nothing else: the cache row, the notification,
    // and the audit row all landed.
    expect(effects).toEqual({ callsign: POST_COMMIT_CALLSIGN, emailSent: true, audited: true });
    expect(harness.store.userCache).toHaveLength(1);
    expect(harness.store.userCache[0].tak_callsign).toBe(POST_COMMIT_CALLSIGN);
    expect(harness.store.auditLogs).toHaveLength(1);

    expect(harness.store.teamMemberships).toEqual(committed.teamMemberships);
    expect(harness.store.channelMemberships).toEqual(committed.channelMemberships);
    expect(harness.store.users).toEqual(committed.users);
    expect(harness.store.syncOperations).toEqual(committed.syncOperations);
  });

  it('leaves the committed transfer in place, logs, and does not throw when the Authentik push throws', async () => {
    const harness = createTransferHarness(fixedPostCommitScenario());

    installPostCommitPool(harness);
    installRealCallsignDerivation();

    const { outcome, committed } = await runCommittedTransfer(harness);

    // Requirement 8.5's other form. `updateUserAttributes` PATCHes over
    // `fetch`, so a network-layer throw escaping it is reachable -- and it
    // is handled by a different branch of step 3 than a `false` return.
    UserAttributesService.updateUserAttributes.mockRejectedValue(
      new Error('socket hang up')
    );

    const effects = await TeamTransferService.applyPostCommitEffects(outcome);

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), userId: harness.userId }),
      expect.stringContaining('Authentik attribute push threw')
    );

    // The steps AFTER the throwing one still ran, which is the clause an
    // uncaught rejection would fail.
    expect(effects).toEqual({ callsign: POST_COMMIT_CALLSIGN, emailSent: true, audited: true });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(harness.store.auditLogs).toHaveLength(1);

    expect(harness.store.teamMemberships).toEqual(committed.teamMemberships);
    expect(harness.store.channelMemberships).toEqual(committed.channelMemberships);
    expect(harness.store.users).toEqual(committed.users);
    expect(harness.store.syncOperations).toEqual(committed.syncOperations);
  });

  it('leaves the committed transfer in place, logs, and reports emailSent false when the notification fails (Requirement 13.4)', async () => {
    const harness = createTransferHarness(fixedPostCommitScenario());

    installPostCommitPool(harness);
    installRealCallsignDerivation();

    const { outcome, committed } = await runCommittedTransfer(harness);

    mockSendEmail.mockRejectedValue(new Error('SMTP connection refused'));

    const effects = await TeamTransferService.applyPostCommitEffects(outcome);

    // It was ATTEMPTED -- which is what separates this from Requirement
    // 13.5's suppression below.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), userId: harness.userId }),
      expect.stringContaining('transfer notification email failed')
    );

    expect(effects).toEqual({ callsign: POST_COMMIT_CALLSIGN, emailSent: false, audited: true });
    expect(harness.store.auditLogs).toHaveLength(1);

    expect(harness.store.teamMemberships).toEqual(committed.teamMemberships);
    expect(harness.store.channelMemberships).toEqual(committed.channelMemberships);
    expect(harness.store.users).toEqual(committed.users);
    expect(harness.store.syncOperations).toEqual(committed.syncOperations);
  });

  it('leaves the committed transfer in place, logs, and reports audited false when the audit_logs insert fails (Requirement 14.4)', async () => {
    const harness = createTransferHarness(fixedPostCommitScenario());

    installPostCommitPool(harness, { failAuditInsert: true });
    installRealCallsignDerivation();

    const { outcome, committed } = await runCommittedTransfer(harness);

    const effects = await TeamTransferService.applyPostCommitEffects(outcome);

    expect(mockLoggerInstance.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        userId: harness.userId,
        actorId: harness.actorId
      }),
      expect.stringContaining('audit log insert failed')
    );

    // The full shape is still returned, with `audited` false and everything
    // the earlier steps produced intact.
    expect(effects).toEqual({ callsign: POST_COMMIT_CALLSIGN, emailSent: true, audited: false });
    expect(harness.store.auditLogs).toEqual([]);
    expect(harness.store.userCache).toHaveLength(1);
    expect(UserAttributesService.updateUserAttributes).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);

    expect(harness.store.teamMemberships).toEqual(committed.teamMemberships);
    expect(harness.store.channelMemberships).toEqual(committed.channelMemberships);
    expect(harness.store.users).toEqual(committed.users);
    expect(harness.store.syncOperations).toEqual(committed.syncOperations);
  });

  it('sends no email at all for a team-owned device, while still mirroring, pushing, and auditing (Requirement 13.5)', async () => {
    const harness = createTransferHarness(fixedPostCommitScenario());

    // A Team_Owned_Device holds a synthetic, non-deliverable address.
    harness.store.users[0].is_team_device = true;

    installPostCommitPool(harness);
    installRealCallsignDerivation();

    const { outcome, committed } = await runCommittedTransfer(harness);

    const effects = await TeamTransferService.applyPostCommitEffects(outcome);

    // Not attempted, not failed, not swallowed: never called.
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(effects).toEqual({ callsign: POST_COMMIT_CALLSIGN, emailSent: false, audited: true });

    // And the skip is step 4's alone -- steps 2, 3, and 5 all ran, so
    // "no email" cannot be a wholesale abort of the function.
    expect(harness.store.userCache).toHaveLength(1);
    expect(harness.store.userCache[0].tak_callsign).toBe(POST_COMMIT_CALLSIGN);
    expect(UserAttributesService.updateUserAttributes).toHaveBeenCalledTimes(1);
    expect(harness.store.auditLogs).toHaveLength(1);

    expect(harness.store.teamMemberships).toEqual(committed.teamMemberships);
    expect(harness.store.channelMemberships).toEqual(committed.channelMemberships);
    expect(harness.store.syncOperations).toEqual(committed.syncOperations);
  });
});
