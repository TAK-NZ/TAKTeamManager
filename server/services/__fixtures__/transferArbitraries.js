/**
 * Shared `fast-check` generators for the team-member-transfer property
 * tests (spec `team-member-transfer`, task 2.1).
 *
 * Properties 1, 3, 7, 8, 14, 15, 16, 27, and 29 all need the same raw
 * material -- a Team hierarchy, the Channels hanging off it, where the
 * admins sit, how a `parent_team_id` can move between two moments, and
 * the Callsign_Suffix input space -- so it lives here once rather than
 * being rebuilt in six test files. Sharing one module is also what makes
 * Property 1's cross-path comparison and Property 3's shared-ancestor
 * case reachable at all: both need the SAME generated scenario driven
 * through two different code paths.
 *
 * Everything generated here is plain data. Nothing in this module calls
 * into the code under test, and every derived set (an Ancestor_Chain, the
 * destination Primary_Channels, the revocation set, Team_Admin status) is
 * computed by walking the generated parent-pointer data directly. That is
 * the property-test discipline `TeamVisibilityService.test.js`'s Property
 * 9 established: expectations come from the generated data, never from a
 * second call into the implementation, or the test is a tautology.
 *
 * Team rows carry exactly the column set `Team.getAncestorChain` returns
 * (`id`, `parent_team_id`, `name`, `callsign_prefix`, `color`,
 * `callsign_name_format`, `visibility`, `callsign_level_selection`, plus
 * `depth` on chain rows), so `hierarchy.ancestorChainOf(teamId)` can be
 * handed straight to a mocked `Team.getAncestorChain`.
 *
 * Usage sketch:
 *
 *   const {
 *     hierarchyArb, channelLayoutArb, adminPlacementArb,
 *     reparentingArb, callsignSuffixArb
 *   } = require('./__fixtures__/transferArbitraries');
 *
 *   const scenarioArb = hierarchyArb({ maxOrganisations: 2 }).chain((hierarchy) =>
 *     fc.record({
 *       hierarchy: fc.constant(hierarchy),
 *       channels: channelLayoutArb(hierarchy),
 *       admins: adminPlacementArb(hierarchy)
 *     })
 *   );
 */

const fc = require('fast-check');
const { MAX_TEAM_DEPTH } = require('../../config/constants');

/**
 * Id ranges are kept disjoint per table so a failing counterexample is
 * readable at a glance (`1004` is a Channel, `5001` is a
 * Deployment_Channel, `7` is a Team) and so a `channel_memberships` row
 * pointing at a Deployment_Channel can never collide numerically with a
 * `channels.id` -- the polymorphic-`channel_id` hazard the design calls
 * out. Property 3's revocation assertion depends on that separation.
 */
const TEAM_ID_BASE = 1;
const CHANNEL_ID_BASE = 1000;
const AUTHENTIK_GROUP_ID_OFFSET = 100000;
const DEPLOYMENT_CHANNEL_ID_BASE = 500000;

/**
 * The user ids the admin-placement arbitrary draws from. Deliberately a
 * small fixed set: three candidate actors over a hierarchy of up to
 * eighteen Teams already covers "admin of the source", "admin of the
 * destination", "admin of both", and "admin of neither" densely, and a
 * fixed set keeps counterexamples comparable across runs.
 */
const ADMIN_CANDIDATE_USER_IDS = [201, 202, 203];

/** The Transferred_User's id. Never a member of ADMIN_CANDIDATE_USER_IDS. */
const TRANSFERRED_USER_ID = 301;

// ---------------------------------------------------------------------------
// Team hierarchy
// ---------------------------------------------------------------------------

const callsignPrefixArb = fc.oneof(
  { arbitrary: fc.stringMatching(/^[A-Z0-9]{1,6}$/), weight: 6 },
  // A null and an empty prefix are both real (`teams.callsign_prefix` is
  // nullable and unconstrained) and both must be skipped by callsign
  // assembly, so Property 16 needs them reachable.
  { arbitrary: fc.constant(null), weight: 1 },
  { arbitrary: fc.constant(''), weight: 1 }
);

const teamFieldsArb = fc.record({
  name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,9}$/),
  callsign_prefix: callsignPrefixArb,
  color: fc.stringMatching(/^#[0-9A-F]{6}$/),
  visibility: fc.constantFrom('public', 'private')
});

/**
 * `null` (meaning "every level", the application-level default
 * `computeCallsignAttributes` applies) plus every non-empty subset of
 * `[1..MAX_TEAM_DEPTH]`.
 */
const callsignLevelSelectionArb = fc.oneof(
  { arbitrary: fc.constant(null), weight: 1 },
  {
    arbitrary: fc.uniqueArray(fc.integer({ min: 1, max: MAX_TEAM_DEPTH }), {
      minLength: 1,
      maxLength: MAX_TEAM_DEPTH
    }),
    weight: 3
  }
);

function ancestorIdsIn(teamId, parentMap) {
  if (!parentMap.has(teamId)) {
    return [];
  }
  const chain = [];
  let current = teamId;
  while (current !== null && current !== undefined) {
    chain.push(current);
    current = parentMap.get(current);
  }
  return chain.reverse(); // root-first, matching getAncestorChain's contract
}

function depthIn(teamId, parentMap) {
  return Math.max(0, ancestorIdsIn(teamId, parentMap).length - 1);
}

/**
 * Wraps generated hierarchy data in the read-only walking helpers every
 * property test needs. Kept in one place so a reparented hierarchy
 * (`reparent` below) exposes exactly the same API as the original.
 *
 * @typedef {Object} Hierarchy
 * @property {number[]} teamIds every Team id, ascending
 * @property {number[]} organisationIds the ids whose `parent_team_id` is null
 * @property {Map<number, number|null>} parentMap the parent-pointer data
 * @property {Map<number, Object>} teams id -> `teams`-shaped row
 * @property {Object[]} teamRows every row, ascending by id
 * @property {(teamId: number) => number[]} ancestorIdsOf root-first ids
 * @property {(teamId: number) => Object[]} ancestorChainOf `getAncestorChain`-shaped rows
 * @property {(teamId: number) => number[]} descendantIdsOf strict descendants
 * @property {(teamId: number) => number|undefined} rootOf the Organisation id
 * @property {(teamId: number) => number} depthOf 0 for an Organisation
 * @property {(teamId: number) => number} subtreeHeightOf 0 for a leaf
 * @property {(a: number, b: number) => boolean} sameOrganisation
 */
function makeHierarchy({ teamIds, parentMap, teams }) {
  const organisationIds = teamIds.filter((id) => parentMap.get(id) === null);

  const ancestorIdsOf = (teamId) => ancestorIdsIn(teamId, parentMap);
  const rootOf = (teamId) => ancestorIdsOf(teamId)[0];
  const depthOf = (teamId) => depthIn(teamId, parentMap);

  const ancestorChainOf = (teamId) =>
    ancestorIdsOf(teamId).map((id, index) => ({ ...teams.get(id), depth: index }));

  const descendantIdsOf = (teamId) =>
    teamIds.filter((id) => id !== teamId && ancestorIdsOf(id).includes(teamId));

  const subtreeHeightOf = (teamId) =>
    descendantIdsOf(teamId).reduce(
      (height, id) => Math.max(height, depthOf(id) - depthOf(teamId)),
      0
    );

  return {
    teamIds,
    organisationIds,
    parentMap,
    teams,
    teamRows: teamIds.map((id) => teams.get(id)),
    ancestorIdsOf,
    ancestorChainOf,
    descendantIdsOf,
    rootOf,
    depthOf,
    subtreeHeightOf,
    sameOrganisation: (a, b) => rootOf(a) === rootOf(b)
  };
}

/**
 * The per-Organisation shape draw. A purely uniform parent choice almost
 * never produces a chain deep enough to reach `MAX_TEAM_DEPTH` (it would
 * need every draw in a run to pick the most recent team), which would
 * leave the depth limit -- the whole reason `callsign_level_selection`
 * exists -- effectively untested. Drawing an explicit shape makes the
 * deep-chain and the flat-under-the-Organisation extremes both common,
 * while `random` still supplies the arbitrary branching in between.
 */
const organisationShapeArb = fc.oneof(
  { arbitrary: fc.constant('chain'), weight: 1 },
  { arbitrary: fc.constant('flat'), weight: 1 },
  { arbitrary: fc.constant('random'), weight: 3 }
);

function parentIndexFor(shape, offsets, i) {
  if (shape === 'chain') {
    return i; // the most recently added team: one level deeper each time
  }
  if (shape === 'flat') {
    return 0; // the Organisation itself: every team at depth 1
  }
  return offsets[i];
}

function buildHierarchy(organisations, shapes, parentOffsets, fields, levelSelections) {
  const parentMap = new Map();
  const teams = new Map();
  const teamIds = [];

  organisations.forEach((ids, orgIndex) => {
    const rootId = ids[0];
    parentMap.set(rootId, null);

    ids.slice(1).forEach((id, i) => {
      // Every offset names an EARLIER team of the same Organisation, so
      // the result is always a single-rooted acyclic tree. Walking up out
      // of a parent already sitting at MAX_TEAM_DEPTH is what keeps the
      // generated hierarchy inside the depth limit `Team.create`
      // enforces, without discarding the draw (which would bias
      // shrinking towards shallow trees).
      let parentId = ids[parentIndexFor(shapes[orgIndex], parentOffsets[orgIndex], i)];
      while (depthIn(parentId, parentMap) >= MAX_TEAM_DEPTH) {
        parentId = parentMap.get(parentId);
      }
      parentMap.set(id, parentId);
    });

    ids.forEach((id) => {
      teamIds.push(id);
      const f = fields[teamIds.length - 1];
      teams.set(id, {
        id,
        parent_team_id: parentMap.get(id),
        name: f.name,
        callsign_prefix: f.callsign_prefix,
        color: f.color,
        // Not read at callsign-generation time (see
        // `computeCallsignAttributes`); present only so the row shape
        // matches `getAncestorChain`'s select list exactly.
        callsign_name_format: null,
        visibility: f.visibility,
        // Organisation-only, per `Team.create`'s
        // CallsignLevelSelectionSubTeamError: a Sub_Team never holds one.
        callsign_level_selection: id === rootId ? levelSelections[orgIndex] : null
      });
    });
  });

  return makeHierarchy({ teamIds, parentMap, teams });
}

/**
 * Generates one or more independent Team hierarchies: an Organisation
 * root plus Sub_Teams down to `MAX_TEAM_DEPTH`, each Team carrying a
 * `callsign_prefix`, a `visibility`, and (on the Organisation only) a
 * `callsign_level_selection`.
 *
 * Ids are globally unique across the whole forest, so a hierarchy
 * generated with `maxOrganisations > 1` directly exercises the
 * cross-Organisation rejection of Requirements 1.7 and 11.6 without any
 * extra setup.
 *
 * @param {Object} [options]
 * @param {number} [options.minOrganisations=1]
 * @param {number} [options.maxOrganisations=1]
 * @param {number} [options.minTeamsPerOrganisation=1]
 * @param {number} [options.maxTeamsPerOrganisation=8]
 * @returns {fc.Arbitrary<Hierarchy>}
 */
function hierarchyArb(options = {}) {
  const {
    minOrganisations = 1,
    maxOrganisations = 1,
    minTeamsPerOrganisation = 1,
    maxTeamsPerOrganisation = 8
  } = options;

  return fc
    .array(
      fc.integer({ min: minTeamsPerOrganisation, max: maxTeamsPerOrganisation }),
      { minLength: minOrganisations, maxLength: maxOrganisations }
    )
    .chain((teamCounts) => {
      let nextId = TEAM_ID_BASE;
      const organisations = teamCounts.map((teamCount) =>
        Array.from({ length: teamCount }, () => nextId++)
      );
      const totalTeams = nextId - TEAM_ID_BASE;

      const shapesArb = fc.tuple(...organisations.map(() => organisationShapeArb));
      const parentOffsetsArb = fc.tuple(
        ...organisations.map((ids) =>
          // Offset i names any of ids[0..i]: an earlier team, so no cycle
          // is representable and every tree has exactly one root.
          fc.tuple(...ids.slice(1).map((_, i) => fc.integer({ min: 0, max: i })))
        )
      );
      const fieldsArb = fc.array(teamFieldsArb, {
        minLength: totalTeams,
        maxLength: totalTeams
      });
      const levelSelectionsArb = fc.tuple(
        ...organisations.map(() => callsignLevelSelectionArb)
      );

      return fc
        .tuple(shapesArb, parentOffsetsArb, fieldsArb, levelSelectionsArb)
        .map(([shapes, parentOffsets, fields, levelSelections]) =>
          buildHierarchy(organisations, shapes, parentOffsets, fields, levelSelections)
        );
    });
}

// ---------------------------------------------------------------------------
// Channel layout
// ---------------------------------------------------------------------------

/**
 * Wraps generated Channel rows in the derived sets the transfer
 * properties assert against, each computed from the generated hierarchy's
 * own parent pointers.
 *
 * `primaryChannelsForChain` is Requirement 6.4/6.8's destination set;
 * `channelsOutsideChain` is Requirement 7.1's revocation set. They are
 * deliberately asymmetric -- the destination side takes Primary_Channels
 * only, the revocation side takes EVERY team-owned Channel -- which is
 * exactly the asymmetry non-primary Channels make observable, and why
 * this arbitrary generates them.
 *
 * @typedef {Object} ChannelLayout
 * @property {Object[]} channels every `channels`-shaped row
 * @property {Map<number, Object[]>} channelsByTeamId
 * @property {(teamId: number) => Object|null} primaryChannelOfTeam
 * @property {(teamId: number) => Object[]} channelsOfTeam
 * @property {(chainIds: number[]) => Object[]} primaryChannelsForChain
 * @property {(chainIds: number[]) => Object[]} channelsForChain
 * @property {(chainIds: number[]) => Object[]} channelsOutsideChain
 * @property {number[]} deploymentChannelIds ids absent from `channels`
 */
function makeChannelLayout(channels, deploymentChannelIds) {
  const channelsByTeamId = new Map();
  for (const channel of channels) {
    if (!channelsByTeamId.has(channel.team_id)) {
      channelsByTeamId.set(channel.team_id, []);
    }
    channelsByTeamId.get(channel.team_id).push(channel);
  }

  const channelsOfTeam = (teamId) => channelsByTeamId.get(teamId) || [];
  const primaryChannelOfTeam = (teamId) =>
    channelsOfTeam(teamId).find((channel) => channel.is_primary) || null;

  const channelsForChain = (chainIds) =>
    channels.filter((channel) => chainIds.includes(channel.team_id));

  return {
    channels,
    channelsByTeamId,
    channelsOfTeam,
    primaryChannelOfTeam,
    channelsForChain,
    primaryChannelsForChain: (chainIds) =>
      channelsForChain(chainIds).filter((channel) => channel.is_primary),
    channelsOutsideChain: (chainIds) =>
      channels.filter((channel) => !chainIds.includes(channel.team_id)),
    deploymentChannelIds
  };
}

/**
 * Generates the Channel layout over an already-generated hierarchy: each
 * Team optionally holds a Primary_Channel whose `authentik_group_id` is
 * sometimes null, plus zero or more non-primary Channels, also with a
 * sometimes-null `authentik_group_id`.
 *
 * A Team with no Primary_Channel at all is reachable and real (Authentik
 * group creation can lag Team creation), and a null `authentik_group_id`
 * is what separates Requirement 6.8's and 7.2's "holds a group" clause
 * from the local `channel_memberships` writes, which happen either way.
 *
 * `authentik_group_id` is derived from the Channel id rather than drawn
 * independently, so it is unique per Channel and a Sync_Operation can be
 * traced back to the exact Channel that produced it.
 *
 * @param {Hierarchy} hierarchy
 * @param {Object} [options]
 * @param {number} [options.maxNonPrimaryChannelsPerTeam=2]
 * @param {number} [options.deploymentChannelCount=1] `channel_memberships`
 *   rows whose `channel_id` names no `channels` row (a Deployment_Channel);
 *   Requirement 7.1's revocation must leave these alone.
 * @returns {fc.Arbitrary<ChannelLayout>}
 */
function channelLayoutArb(hierarchy, options = {}) {
  const { maxNonPrimaryChannelsPerTeam = 2, deploymentChannelCount = 1 } = options;

  const perTeamArb = fc.tuple(
    ...hierarchy.teamIds.map(() =>
      fc.record({
        hasPrimary: fc.boolean(),
        primaryHasGroup: fc.boolean(),
        nonPrimaryHaveGroups: fc.array(fc.boolean(), {
          maxLength: maxNonPrimaryChannelsPerTeam
        })
      })
    )
  );

  return perTeamArb.map((perTeam) => {
    let nextChannelId = CHANNEL_ID_BASE;
    const channels = [];

    const push = (teamId, isPrimary, hasGroup, ordinal) => {
      const id = nextChannelId++;
      channels.push({
        id,
        name: isPrimary ? `team-${teamId}-primary` : `team-${teamId}-channel-${ordinal}`,
        display_name: isPrimary ? `Team ${teamId}` : `Team ${teamId} Channel ${ordinal}`,
        description: null,
        team_id: teamId,
        authentik_group_id: hasGroup ? id + AUTHENTIK_GROUP_ID_OFFSET : null,
        authentik_read_group_id: null,
        authentik_write_group_id: null,
        is_primary: isPrimary,
        channel_type: isPrimary ? 'primary' : 'team',
        custom_suffix: null
      });
    };

    hierarchy.teamIds.forEach((teamId, index) => {
      const spec = perTeam[index];
      if (spec.hasPrimary) {
        push(teamId, true, spec.primaryHasGroup, 0);
      }
      spec.nonPrimaryHaveGroups.forEach((hasGroup, ordinal) => {
        push(teamId, false, hasGroup, ordinal + 1);
      });
    });

    const deploymentChannelIds = Array.from(
      { length: deploymentChannelCount },
      (_, i) => DEPLOYMENT_CHANNEL_ID_BASE + i
    );

    return makeChannelLayout(channels, deploymentChannelIds);
  });
}

// ---------------------------------------------------------------------------
// Admin placement
// ---------------------------------------------------------------------------

/**
 * Wraps generated admin placements in the reference `Team.isAdmin`
 * computation, derived from the generated parent pointers.
 *
 * @typedef {Object} AdminPlacement
 * @property {number[]} userIds every candidate actor id
 * @property {Map<number, {teamId: number, role: string}|null>} directMemberships
 * @property {Object[]} membershipRows `team_memberships`-shaped rows
 * @property {(userId: number) => {teamId: number, role: string}|null} directMembershipOf
 * @property {(teamId: number, userId: number) => boolean} isTeamAdmin
 * @property {(teamId: number) => number[]} teamAdminsOf
 * @property {(teamId: number) => number[]} directAdminsOf
 */
function makeAdminPlacement(hierarchy, userIds, placements) {
  const directMemberships = new Map();
  userIds.forEach((userId, index) => {
    directMemberships.set(userId, placements[index]);
  });

  const directMembershipOf = (userId) => directMemberships.get(userId) || null;

  // Requirement/glossary Team_Admin: a DIRECT row with `role = 'admin'`
  // on the Team itself or on any Team in its Ancestor_Chain. An
  // inherited row never grants it, which is why the inherited rows below
  // are derived rather than generated.
  const isTeamAdmin = (teamId, userId) => {
    const direct = directMembershipOf(userId);
    if (!direct || direct.role !== 'admin') {
      return false;
    }
    return hierarchy.ancestorIdsOf(teamId).includes(direct.teamId);
  };

  const membershipRows = [];
  for (const userId of userIds) {
    const direct = directMembershipOf(userId);
    if (!direct) {
      continue;
    }
    membershipRows.push({
      user_id: userId,
      team_id: direct.teamId,
      role: direct.role,
      inherited_from_team_id: null
    });
    // `addUserToTeam` writes one inherited row per strict ancestor.
    for (const ancestorId of hierarchy.ancestorIdsOf(direct.teamId)) {
      if (ancestorId !== direct.teamId) {
        membershipRows.push({
          user_id: userId,
          team_id: ancestorId,
          role: 'inherited',
          inherited_from_team_id: direct.teamId
        });
      }
    }
  }

  return {
    userIds,
    directMemberships,
    membershipRows,
    directMembershipOf,
    isTeamAdmin,
    teamAdminsOf: (teamId) => userIds.filter((userId) => isTeamAdmin(teamId, userId)),
    // Requirement 3.6's `assigned_to_admin` eligibility: a DIRECT
    // `role = 'admin'` row on the Approval_Team itself, not an inherited
    // one and not one on an ancestor.
    directAdminsOf: (teamId) =>
      userIds.filter((userId) => {
        const direct = directMembershipOf(userId);
        return !!direct && direct.role === 'admin' && direct.teamId === teamId;
      })
  };
}

/**
 * Places direct `team_memberships` rows for the candidate actors at any
 * depth of the generated hierarchy, including `role = 'admin'` rows on an
 * Organisation, on a leaf, and anywhere between.
 *
 * Each candidate gets at most ONE direct row, because
 * `idx_team_memberships_one_direct_per_user` constrains a user to a
 * single Direct_Membership system-wide. Inherited rows are derived from
 * that single placement rather than generated independently, for the same
 * reason: no reachable database state has an inherited row without the
 * direct row it descends from.
 *
 * @param {Hierarchy} hierarchy
 * @param {Object} [options]
 * @param {number[]} [options.userIds=ADMIN_CANDIDATE_USER_IDS]
 * @returns {fc.Arbitrary<AdminPlacement>}
 */
function adminPlacementArb(hierarchy, options = {}) {
  const { userIds = ADMIN_CANDIDATE_USER_IDS } = options;

  return fc
    .tuple(
      ...userIds.map(() =>
        fc.option(
          fc.record({
            teamId: fc.constantFrom(...hierarchy.teamIds),
            role: fc.constantFrom('admin', 'member')
          }),
          // `null` = the candidate holds no membership at all, which is
          // the "Team_Admin of neither side" case Requirement 2.3 denies.
          { nil: null }
        )
      )
    )
    .map((placements) => makeAdminPlacement(hierarchy, userIds, placements));
}

// ---------------------------------------------------------------------------
// Reparenting (the two moments of Property 7)
// ---------------------------------------------------------------------------

/**
 * Applies a `parent_team_id` change, returning a NEW Hierarchy with the
 * same API. `PUT /api/teams/:teamId` can do exactly this while a
 * Transfer_Request sits pending, which is what makes Requirement 11.6's
 * re-evaluation at approval time necessary.
 *
 * A Team promoted to an Organisation (`toParentTeamId` of `null`) keeps
 * its `callsign_level_selection` of `null`, and a former Organisation
 * demoted to a Sub_Team keeps its non-null one. Neither matters:
 * `computeCallsignAttributes` reads that column off `ancestorChain[0]`
 * only, so only the value on the NEW root is ever consulted.
 *
 * @param {Hierarchy} hierarchy
 * @param {{teamId: number, toParentTeamId: number|null}|null} change
 * @returns {Hierarchy} `hierarchy` itself when `change` is null
 */
function reparent(hierarchy, change) {
  if (!change) {
    return hierarchy;
  }

  const parentMap = new Map(hierarchy.parentMap);
  parentMap.set(change.teamId, change.toParentTeamId);

  const teams = new Map();
  for (const id of hierarchy.teamIds) {
    teams.set(id, { ...hierarchy.teams.get(id), parent_team_id: parentMap.get(id) });
  }

  return makeHierarchy({ teamIds: hierarchy.teamIds, parentMap, teams });
}

/**
 * @typedef {Object} Reparenting
 * @property {{teamId: number, fromParentTeamId: number|null, toParentTeamId: number|null}|null} change
 * @property {Hierarchy} before the first moment (the generated hierarchy)
 * @property {Hierarchy} after the second moment
 * @property {boolean} isNoop
 * @property {(teamId: number) => boolean} movesOrganisationOf whether that
 *   Team's Organisation differs between the two moments
 */
function makeReparenting(hierarchy, change) {
  const after = reparent(hierarchy, change);
  const isNoop =
    !change || change.fromParentTeamId === change.toParentTeamId;

  return {
    change,
    before: hierarchy,
    after,
    isNoop,
    movesOrganisationOf: (teamId) => hierarchy.rootOf(teamId) !== after.rootOf(teamId)
  };
}

/**
 * Generates a `parent_team_id` change to apply between two moments,
 * exposing both the before and the after hierarchy.
 *
 * Candidates cover moving a Team under any non-descendant (a cycle is
 * never representable), promoting it to an Organisation of its own
 * (`toParentTeamId` of `null`), moving it into a DIFFERENT Organisation
 * when one was generated, and leaving it exactly where it is. Every
 * candidate keeps the moved subtree within `MAX_TEAM_DEPTH`. `null` is
 * also generated, meaning no change at all, so a property spanning both
 * moments still covers the case where nothing moved.
 *
 * @param {Hierarchy} hierarchy
 * @returns {fc.Arbitrary<Reparenting>}
 */
function reparentingArb(hierarchy) {
  const candidates = [];

  for (const teamId of hierarchy.teamIds) {
    const forbidden = new Set([teamId, ...hierarchy.descendantIdsOf(teamId)]);
    const height = hierarchy.subtreeHeightOf(teamId);

    for (const toParentTeamId of [null, ...hierarchy.teamIds]) {
      if (toParentTeamId !== null && forbidden.has(toParentTeamId)) {
        continue;
      }
      const newDepth = toParentTeamId === null ? 0 : hierarchy.depthOf(toParentTeamId) + 1;
      if (newDepth + height > MAX_TEAM_DEPTH) {
        continue;
      }
      candidates.push({
        teamId,
        fromParentTeamId: hierarchy.parentMap.get(teamId),
        toParentTeamId
      });
    }
  }

  const changeArb = candidates.length > 0
    ? fc.oneof(
      { arbitrary: fc.constant(null), weight: 1 },
      { arbitrary: fc.constantFrom(...candidates), weight: 3 }
    )
    : fc.constant(null);

  return changeArb.map((change) => makeReparenting(hierarchy, change));
}

// ---------------------------------------------------------------------------
// Callsign_Suffix
// ---------------------------------------------------------------------------

/**
 * Requirement 9.7's precedence chain treats `null`, `''`, and a
 * whitespace-only value alike as ABSENT, so all three have to be
 * reachable for Property 29's presence/absence distinction to mean
 * anything.
 */
const ABSENT_CALLSIGN_SUFFIX_VALUES = [null, '', ' ', '   ', '\t', ' \t\n '];

/**
 * Real-world non-ASCII suffixes. `CallsignSuffixUniquenessService`
 * compares with `String.prototype.toLowerCase`, so a non-ASCII value is
 * the case where that comparison is least obviously correct.
 */
const NON_ASCII_CALLSIGN_SUFFIXES = [
  'Ōtautahi',
  'Müller',
  'Ñuñez',
  'Ελένη',
  'Шевченко',
  '日本語'
];

/**
 * The `first-initial.last-name` shape the Callsign_Generator actually
 * produces in this deployment (`C.Elsen`), plus plain mixed-case words
 * and non-ASCII values.
 */
const presentCallsignSuffixArb = fc.oneof(
  { arbitrary: fc.stringMatching(/^[A-Za-z]\.[A-Za-z]{1,8}$/), weight: 4 },
  { arbitrary: fc.stringMatching(/^[A-Za-z]{1,10}$/), weight: 3 },
  { arbitrary: fc.constantFrom(...NON_ASCII_CALLSIGN_SUFFIXES), weight: 2 }
);

const absentCallsignSuffixArb = fc.constantFrom(...ABSENT_CALLSIGN_SUFFIX_VALUES);

/**
 * Requirement 9.7's absence test, shared so a test and the code under
 * test cannot disagree about what "absent" means by accident.
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
function isAbsentCallsignSuffix(value) {
  return value == null || String(value).trim() === '';
}

/**
 * Generates a Callsign_Suffix drawn from the whole input space: mixed
 * case, non-ASCII, the empty string, whitespace-only, and `null`.
 *
 * @param {Object} [options]
 * @param {boolean} [options.includeAbsent=true] set false when a property
 *   needs a value that is definitely PRESENT (Property 19's supplied
 *   suffix, for instance).
 * @returns {fc.Arbitrary<string|null>}
 */
function callsignSuffixArb(options = {}) {
  const { includeAbsent = true } = options;
  if (!includeAbsent) {
    return presentCallsignSuffixArb;
  }
  return fc.oneof(
    { arbitrary: presentCallsignSuffixArb, weight: 3 },
    { arbitrary: absentCallsignSuffixArb, weight: 1 }
  );
}

/**
 * Generates `[value, caseVariant]` -- two Callsign_Suffix values that are
 * equal case-insensitively and (whenever the value contains a cased
 * letter) unequal case-sensitively. Requirement 9.1's collision check is
 * case-insensitive, so a property asserting it needs a pair that only a
 * case-insensitive comparison treats as a collision.
 *
 * @returns {fc.Arbitrary<[string, string]>}
 */
function callsignSuffixCasePairArb() {
  return presentCallsignSuffixArb.chain((value) =>
    fc
      .array(fc.boolean(), { minLength: value.length, maxLength: value.length })
      .map((flips) => [
        value,
        Array.from(value)
          .map((character, index) => {
            if (!flips[index]) {
              return character;
            }
            const upper = character.toUpperCase();
            return upper === character ? character.toLowerCase() : upper;
          })
          .join('')
      ])
  );
}

module.exports = {
  // Constants
  MAX_TEAM_DEPTH,
  ADMIN_CANDIDATE_USER_IDS,
  TRANSFERRED_USER_ID,
  DEPLOYMENT_CHANNEL_ID_BASE,
  ABSENT_CALLSIGN_SUFFIX_VALUES,
  NON_ASCII_CALLSIGN_SUFFIXES,

  // Arbitrary factories
  hierarchyArb,
  channelLayoutArb,
  adminPlacementArb,
  reparentingArb,
  callsignSuffixArb,
  callsignSuffixCasePairArb,

  // Helpers shared with the tests that consume the arbitraries
  reparent,
  isAbsentCallsignSuffix
};
