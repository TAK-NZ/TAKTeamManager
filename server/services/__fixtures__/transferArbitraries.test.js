/**
 * Self-validation for the shared transfer generators (spec
 * `team-member-transfer`, task 2.1).
 *
 * These are NOT any of the spec's numbered Properties 1-29 -- they assert
 * the generators themselves, not the code under test. They exist because
 * nine property tests are about to depend on this module, and a generator
 * that silently produces a degenerate hierarchy (a cycle, a Team past
 * `MAX_TEAM_DEPTH`, a Sub_Team carrying a `callsign_level_selection`, a
 * Deployment_Channel id colliding with a `channels.id`) would weaken all
 * nine of them without failing any.
 */

const fc = require('fast-check');
const { test } = require('@fast-check/jest');
const { MAX_TEAM_DEPTH } = require('../../config/constants');
const {
  hierarchyArb,
  channelLayoutArb,
  adminPlacementArb,
  reparentingArb,
  callsignSuffixArb,
  callsignSuffixCasePairArb,
  isAbsentCallsignSuffix,
  ADMIN_CANDIDATE_USER_IDS,
  ABSENT_CALLSIGN_SUFFIX_VALUES
} = require('./transferArbitraries');

describe('hierarchyArb', () => {
  test.prop([hierarchyArb({ minOrganisations: 1, maxOrganisations: 3 })], { numRuns: 100 })(
    'produces acyclic, single-rooted trees whose every Team sits at a depth within MAX_TEAM_DEPTH',
    (hierarchy) => {
      expect(hierarchy.teamIds.length).toBeGreaterThan(0);
      expect(new Set(hierarchy.teamIds).size).toBe(hierarchy.teamIds.length);
      expect(hierarchy.organisationIds.length).toBeGreaterThan(0);

      for (const teamId of hierarchy.teamIds) {
        const ancestorIds = hierarchy.ancestorIdsOf(teamId);
        // A cycle would make the walk repeat an id (or not terminate).
        expect(new Set(ancestorIds).size).toBe(ancestorIds.length);
        expect(ancestorIds[ancestorIds.length - 1]).toBe(teamId);
        expect(hierarchy.parentMap.get(ancestorIds[0])).toBeNull();
        expect(hierarchy.depthOf(teamId)).toBe(ancestorIds.length - 1);
        expect(hierarchy.depthOf(teamId)).toBeLessThanOrEqual(MAX_TEAM_DEPTH);
        expect(hierarchy.rootOf(teamId)).toBe(ancestorIds[0]);
      }
    }
  );

  test.prop([hierarchyArb({ maxTeamsPerOrganisation: 6 })], { numRuns: 100 })(
    'emits getAncestorChain-shaped rows, root-first with ascending depth, and holds callsign_level_selection on the Organisation only',
    (hierarchy) => {
      for (const teamId of hierarchy.teamIds) {
        const chain = hierarchy.ancestorChainOf(teamId);
        expect(chain.map((row) => row.depth)).toEqual(chain.map((_, index) => index));

        chain.forEach((row) => {
          expect(Object.keys(row).sort()).toEqual([
            'callsign_level_selection',
            'callsign_name_format',
            'callsign_prefix',
            'color',
            'depth',
            'id',
            'name',
            'parent_team_id',
            'visibility'
          ]);
          expect(['public', 'private']).toContain(row.visibility);
          if (row.depth === 0) {
            expect(row.parent_team_id).toBeNull();
          } else {
            // Requirement/`Team.create`: only an Organisation holds one.
            expect(row.callsign_level_selection).toBeNull();
          }
        });
      }

      for (const organisationId of hierarchy.organisationIds) {
        const selection = hierarchy.teams.get(organisationId).callsign_level_selection;
        if (selection !== null) {
          expect(selection.length).toBeGreaterThan(0);
          selection.forEach((level) => {
            expect(level).toBeGreaterThanOrEqual(1);
            expect(level).toBeLessThanOrEqual(MAX_TEAM_DEPTH);
          });
        }
      }
    }
  );

  it('can generate more than one Organisation, so the cross-Organisation case is reachable', () => {
    const samples = fc.sample(hierarchyArb({ maxOrganisations: 3 }), 100);
    const multiOrganisation = samples.filter((hierarchy) => hierarchy.organisationIds.length > 1);
    expect(multiOrganisation.length).toBeGreaterThan(0);
    // Ids stay globally unique across the whole forest.
    samples.forEach((hierarchy) => {
      expect(new Set(hierarchy.teamIds).size).toBe(hierarchy.teamIds.length);
    });

    // `sameOrganisation` is the Requirement 1.7 / 11.6 predicate: true
    // within one tree, false across two.
    const hierarchy = multiOrganisation[0];
    const [firstOrganisationId, secondOrganisationId] = hierarchy.organisationIds;
    expect(hierarchy.sameOrganisation(firstOrganisationId, firstOrganisationId)).toBe(true);
    expect(hierarchy.sameOrganisation(firstOrganisationId, secondOrganisationId)).toBe(false);
    hierarchy.teamIds.forEach((teamId) => {
      expect(hierarchy.sameOrganisation(teamId, hierarchy.rootOf(teamId))).toBe(true);
    });
  });

  it('treats a Team id absent from the hierarchy as having no Ancestor_Chain at all', () => {
    // The dangling `target_team_id` of Requirement 11.3 -- a chain lookup
    // for it must come back empty rather than inventing a single-team chain.
    const [hierarchy] = fc.sample(hierarchyArb(), 1);
    const unknownTeamId = Math.max(...hierarchy.teamIds) + 1000;

    expect(hierarchy.ancestorIdsOf(unknownTeamId)).toEqual([]);
    expect(hierarchy.ancestorChainOf(unknownTeamId)).toEqual([]);
    expect(hierarchy.rootOf(unknownTeamId)).toBeUndefined();
    expect(hierarchy.depthOf(unknownTeamId)).toBe(0);
  });

  it('reaches every depth from an Organisation down to MAX_TEAM_DEPTH', () => {
    const depths = new Set();
    for (const hierarchy of fc.sample(hierarchyArb(), 500)) {
      hierarchy.teamIds.forEach((teamId) => depths.add(hierarchy.depthOf(teamId)));
    }
    for (let depth = 0; depth <= MAX_TEAM_DEPTH; depth += 1) {
      expect(depths.has(depth)).toBe(true);
    }
  });
});

describe('channelLayoutArb', () => {
  const layoutArb = hierarchyArb({ maxOrganisations: 2 }).chain((hierarchy) =>
    fc.tuple(fc.constant(hierarchy), channelLayoutArb(hierarchy))
  );

  test.prop([layoutArb], { numRuns: 100 })(
    'owns every Channel by a generated Team, holds at most one Primary_Channel per Team, and keeps Deployment_Channel ids out of `channels`',
    ([hierarchy, layout]) => {
      const channelIds = layout.channels.map((channel) => channel.id);
      expect(new Set(channelIds).size).toBe(channelIds.length);

      for (const channel of layout.channels) {
        expect(hierarchy.teamIds).toContain(channel.team_id);
        if (channel.authentik_group_id !== null) {
          // Derived from the id, so a Sync_Operation traces back to one Channel.
          expect(
            layout.channels.filter((c) => c.authentik_group_id === channel.authentik_group_id)
          ).toHaveLength(1);
        }
      }

      for (const teamId of hierarchy.teamIds) {
        expect(layout.channelsOfTeam(teamId).filter((c) => c.is_primary).length).toBeLessThanOrEqual(1);
      }

      for (const deploymentChannelId of layout.deploymentChannelIds) {
        expect(channelIds).not.toContain(deploymentChannelId);
      }
    }
  );

  test.prop([layoutArb], { numRuns: 100 })(
    'partitions the Channel set into the destination-chain and outside-chain halves the transfer requirements assert on',
    ([hierarchy, layout]) => {
      for (const teamId of hierarchy.teamIds) {
        const chainIds = hierarchy.ancestorIdsOf(teamId);
        const inside = layout.channelsForChain(chainIds);
        const outside = layout.channelsOutsideChain(chainIds);

        expect(inside.length + outside.length).toBe(layout.channels.length);
        expect(inside.filter((c) => outside.includes(c))).toHaveLength(0);

        // Requirement 6.4/6.8 takes Primary_Channels only; Requirement 7.1
        // revokes every team-owned Channel outside the chain. That
        // asymmetry is the point of generating non-primary Channels.
        const primaries = layout.primaryChannelsForChain(chainIds);
        expect(primaries.every((c) => c.is_primary && chainIds.includes(c.team_id))).toBe(true);
        expect(primaries.length).toBeLessThanOrEqual(inside.length);
      }
    }
  );

  it('reaches a Team with no Primary_Channel, a null group id, and a non-primary Channel', () => {
    const samples = fc.sample(
      hierarchyArb().chain((hierarchy) =>
        fc.tuple(fc.constant(hierarchy), channelLayoutArb(hierarchy))
      ),
      300
    );
    const allChannels = samples.flatMap(([, layout]) => layout.channels);

    expect(
      samples.some(([hierarchy, layout]) =>
        hierarchy.teamIds.some((teamId) => layout.primaryChannelOfTeam(teamId) === null)
      )
    ).toBe(true);
    expect(allChannels.some((c) => c.is_primary && c.authentik_group_id === null)).toBe(true);
    expect(allChannels.some((c) => c.is_primary && c.authentik_group_id !== null)).toBe(true);
    expect(allChannels.some((c) => !c.is_primary && c.authentik_group_id !== null)).toBe(true);
    expect(allChannels.some((c) => !c.is_primary && c.authentik_group_id === null)).toBe(true);
  });
});

describe('adminPlacementArb', () => {
  const placementArb = hierarchyArb({ maxOrganisations: 2 }).chain((hierarchy) =>
    fc.tuple(fc.constant(hierarchy), adminPlacementArb(hierarchy))
  );

  test.prop([placementArb], { numRuns: 100 })(
    'gives each candidate at most one Direct_Membership, derives the inherited rows from it, and grants Team_Admin exactly down the admin row\'s subtree',
    ([hierarchy, placement]) => {
      for (const userId of ADMIN_CANDIDATE_USER_IDS) {
        const directRows = placement.membershipRows.filter(
          (row) => row.user_id === userId && row.inherited_from_team_id === null
        );
        expect(directRows.length).toBeLessThanOrEqual(1);

        const direct = placement.directMembershipOf(userId);
        if (direct === null) {
          expect(placement.membershipRows.filter((row) => row.user_id === userId)).toHaveLength(0);
          hierarchy.teamIds.forEach((teamId) => {
            expect(placement.isTeamAdmin(teamId, userId)).toBe(false);
          });
          continue;
        }

        expect(directRows[0]).toEqual({
          user_id: userId,
          team_id: direct.teamId,
          role: direct.role,
          inherited_from_team_id: null
        });

        const inheritedTeamIds = placement.membershipRows
          .filter((row) => row.user_id === userId && row.inherited_from_team_id !== null)
          .map((row) => row.team_id);
        expect(inheritedTeamIds.sort()).toEqual(
          hierarchy
            .ancestorIdsOf(direct.teamId)
            .filter((id) => id !== direct.teamId)
            .sort()
        );

        hierarchy.teamIds.forEach((teamId) => {
          const expected =
            direct.role === 'admin' && hierarchy.ancestorIdsOf(teamId).includes(direct.teamId);
          expect(placement.isTeamAdmin(teamId, userId)).toBe(expected);
        });
      }
    }
  );

  test.prop([placementArb], { numRuns: 100 })(
    'counts only a direct admin row on the Team itself as an eligible assigned_to_admin',
    ([hierarchy, placement]) => {
      for (const teamId of hierarchy.teamIds) {
        placement.directAdminsOf(teamId).forEach((userId) => {
          const direct = placement.directMembershipOf(userId);
          expect(direct.teamId).toBe(teamId);
          expect(direct.role).toBe('admin');
          expect(placement.teamAdminsOf(teamId)).toContain(userId);
        });
      }
    }
  );

  it('reaches an admin placed on an Organisation, on a deeper Sub_Team, and on neither side', () => {
    const samples = fc.sample(
      hierarchyArb({ minTeamsPerOrganisation: 3, maxTeamsPerOrganisation: 6 }).chain((hierarchy) =>
        fc.tuple(fc.constant(hierarchy), adminPlacementArb(hierarchy))
      ),
      300
    );

    const adminDepths = new Set();
    let sawNoAdminAnywhere = false;
    for (const [hierarchy, placement] of samples) {
      const admins = ADMIN_CANDIDATE_USER_IDS.map((id) => placement.directMembershipOf(id)).filter(
        (direct) => direct && direct.role === 'admin'
      );
      if (admins.length === 0) {
        sawNoAdminAnywhere = true;
      }
      admins.forEach((direct) => adminDepths.add(hierarchy.depthOf(direct.teamId)));
    }

    expect(adminDepths.has(0)).toBe(true);
    expect([...adminDepths].some((depth) => depth >= 2)).toBe(true);
    expect(sawNoAdminAnywhere).toBe(true);
  });
});

describe('reparentingArb', () => {
  const reparentingScenarioArb = hierarchyArb({
    minOrganisations: 2,
    maxOrganisations: 2,
    minTeamsPerOrganisation: 2,
    maxTeamsPerOrganisation: 5
  }).chain((hierarchy) => fc.tuple(fc.constant(hierarchy), reparentingArb(hierarchy)));

  test.prop([reparentingScenarioArb], { numRuns: 100 })(
    'leaves the first moment untouched and produces a second moment that is still an acyclic, depth-bounded forest over the same Team ids',
    ([hierarchy, reparenting]) => {
      expect(reparenting.before).toBe(hierarchy);
      expect(reparenting.after.teamIds).toEqual(hierarchy.teamIds);

      for (const teamId of reparenting.after.teamIds) {
        const ancestorIds = reparenting.after.ancestorIdsOf(teamId);
        expect(new Set(ancestorIds).size).toBe(ancestorIds.length);
        expect(reparenting.after.depthOf(teamId)).toBeLessThanOrEqual(MAX_TEAM_DEPTH);
        expect(reparenting.after.parentMap.get(ancestorIds[0])).toBeNull();
      }

      if (reparenting.change === null) {
        expect(reparenting.after).toBe(hierarchy);
        expect(reparenting.isNoop).toBe(true);
        hierarchy.teamIds.forEach((teamId) => {
          expect(reparenting.movesOrganisationOf(teamId)).toBe(false);
        });
        return;
      }

      const { teamId, fromParentTeamId, toParentTeamId } = reparenting.change;
      expect(hierarchy.parentMap.get(teamId)).toBe(fromParentTeamId);
      expect(reparenting.after.parentMap.get(teamId)).toBe(toParentTeamId);
      // Only the moved Team's own pointer changes.
      hierarchy.teamIds
        .filter((id) => id !== teamId)
        .forEach((id) => {
          expect(reparenting.after.parentMap.get(id)).toBe(hierarchy.parentMap.get(id));
        });
      // The move is never into the moved Team's own subtree.
      expect(hierarchy.descendantIdsOf(teamId)).not.toContain(toParentTeamId);
    }
  );

  it('reaches a cross-Organisation move, a promotion to Organisation, and a no-op', () => {
    const samples = fc.sample(
      hierarchyArb({
        minOrganisations: 2,
        maxOrganisations: 2,
        minTeamsPerOrganisation: 2,
        maxTeamsPerOrganisation: 4
      }).chain((hierarchy) => fc.tuple(fc.constant(hierarchy), reparentingArb(hierarchy))),
      500
    );

    const changesOrganisation = samples.some(([hierarchy, reparenting]) =>
      hierarchy.teamIds.some((teamId) => reparenting.movesOrganisationOf(teamId))
    );
    const promotesToOrganisation = samples.some(
      ([, reparenting]) => reparenting.change && reparenting.change.toParentTeamId === null
    );
    const noop = samples.some(([, reparenting]) => reparenting.isNoop);

    expect(changesOrganisation).toBe(true);
    expect(promotesToOrganisation).toBe(true);
    expect(noop).toBe(true);
  });
});

describe('callsignSuffixArb', () => {
  test.prop([callsignSuffixArb()], { numRuns: 100 })(
    'generates either an absent value (null, empty, or whitespace-only) or a non-empty trimmable one',
    (suffix) => {
      if (isAbsentCallsignSuffix(suffix)) {
        expect(suffix === null || String(suffix).trim() === '').toBe(true);
      } else {
        expect(typeof suffix).toBe('string');
        expect(suffix.trim().length).toBeGreaterThan(0);
      }
    }
  );

  test.prop([callsignSuffixArb({ includeAbsent: false })], { numRuns: 100 })(
    'never generates an absent value when absence is excluded',
    (suffix) => {
      expect(isAbsentCallsignSuffix(suffix)).toBe(false);
    }
  );

  it('reaches every absence form, mixed case, and non-ASCII', () => {
    const samples = fc.sample(callsignSuffixArb(), 800);

    ABSENT_CALLSIGN_SUFFIX_VALUES.forEach((value) => {
      expect(samples).toContain(value);
    });
    expect(
      samples.some((s) => typeof s === 'string' && /[a-z]/.test(s) && /[A-Z]/.test(s))
    ).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(samples.some((s) => typeof s === 'string' && /[^\x00-\x7F]/.test(s))).toBe(true);
  });

  test.prop([callsignSuffixCasePairArb()], { numRuns: 100 })(
    'produces pairs that collide case-insensitively',
    ([value, variant]) => {
      expect(variant.toLowerCase()).toBe(value.toLowerCase());
      expect(variant.length).toBe(value.length);
    }
  );

  it('produces a case pair that a case-sensitive comparison would treat as distinct', () => {
    const pairs = fc.sample(callsignSuffixCasePairArb(), 300);
    expect(pairs.some(([value, variant]) => value !== variant)).toBe(true);
  });

  it.each([
    [null, true],
    [undefined, true],
    ['', true],
    ['   ', true],
    ['\t\n', true],
    ['C.Elsen', false],
    [' C.Elsen ', false]
  ])('isAbsentCallsignSuffix(%p) is %p', (value, expected) => {
    expect(isAbsentCallsignSuffix(value)).toBe(expected);
  });
});
