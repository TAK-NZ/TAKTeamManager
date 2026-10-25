/**
 * Rename the region-channel "Support" tier to "Coordination".
 *
 * Incremental migration on top of the squashed baseline
 * (`1790200000000_baseline-schema.cjs`); NEVER hand-edit schema.sql.
 *
 * WHAT CHANGES (application code changes in the same release):
 *   - `region_channels.tier`: 'support' -> 'coordination', and the
 *     `region_channels_tier_check` constraint now admits
 *     ('response', 'coordination').
 *   - `teams.support_channel_access` -> `teams.coordination_channel_access`
 *     (column rename; data and tri-state semantics are unchanged).
 *   - `region_channels.description` for the renamed rows:
 *     "(Support - All Agencies)" -> "(Coordination - All Agencies)".
 *   - `group_membership_rules.target_group_pattern` for region-channel rules:
 *     the `tak_Support` prefix -> `tak_Coordination`.
 *   - Non-terminal `sync_operations` payloads carrying `tier: 'support'`
 *     (create_region_channel_group, resync_org_channel_tier_access) are
 *     rewritten to `tier: 'coordination'`. Without this, a queued operation
 *     would reach the worker with a tier the new code no longer recognises
 *     and be failed permanently.
 *
 * AUTHENTIK GROUP RENAME. This migration only touches the local database. The
 * existing Authentik groups are still named `tak_Support - <region>`. To
 * rename them IN PLACE (same group pk, so memberships are preserved) the
 * migration enqueues one `update_region_channel_group` Sync_Operation per
 * coordination channel that already has a `group_id`; the Sync_Worker's
 * handler PATCHes the group name from the tier prefix in
 * `server/config/constants.js`.
 *
 * DEPLOY ORDER HAZARD. That handler computes the new name from the prefix in
 * the code the WORKER is running. If an old worker (still carrying the
 * 'Support' prefix) drains one of these operations before it is replaced, it
 * PATCHes the group to its existing name, marks the operation completed, and
 * the rename silently never happens. Make sure no old-code Sync_Worker is
 * running once this migration has committed, or re-run the rename afterwards
 * (e.g. by editing any region channel, which re-enqueues the same operation).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. region_channels.tier: widen-then-narrow so the UPDATE is legal.
    ALTER TABLE public.region_channels DROP CONSTRAINT IF EXISTS region_channels_tier_check;
    UPDATE public.region_channels SET tier = 'coordination' WHERE tier = 'support';
    ALTER TABLE public.region_channels
      ADD CONSTRAINT region_channels_tier_check
      CHECK (((tier)::text = ANY ((ARRAY['response'::character varying, 'coordination'::character varying])::text[])));
    COMMENT ON COLUMN public.region_channels.tier IS
      'Which channel tier this region channel belongs to: ''response'' (Emergency_Response, ES-only inner circle, gated by teams.response_channel_access) or ''coordination'' (all-agency outer circle, gated by teams.coordination_channel_access). No default -- every insert path supplies it explicitly. See docs.tak.nz Channel Structure.';

    -- 2. teams flag column rename.
    ALTER TABLE public.teams RENAME COLUMN support_channel_access TO coordination_channel_access;
    COMMENT ON COLUMN public.teams.coordination_channel_access IS
      'Organisation-level only, exactly as response_channel_access is (see that column''s comment for the tri-state rationale). NULL on a Sub_Team; false or true on an Organisation. Resolved via Team.getAncestorChain(teamId)[0]. Whether members of this Organisation (and its Sub_Teams) are synced into coordination-tier region channels. Defaults to true at Organisation creation (application-supplied) -- the outer/coordination tier is the all-agency default, opposite of response_channel_access. Mutable thereafter.';

    -- 3. Stored description qualifier.
    UPDATE public.region_channels
       SET description = replace(description, '(Support - All Agencies)', '(Coordination - All Agencies)')
     WHERE tier = 'coordination'
       AND description LIKE '%(Support - All Agencies)%';

    -- 4. Region-channel membership rules embed the Authentik group-name prefix.
    UPDATE public.group_membership_rules
       SET target_group_pattern = regexp_replace(target_group_pattern, '^tak_Support', 'tak_Coordination')
     WHERE source_type = 'region_channel'
       AND target_group_pattern LIKE 'tak\\_Support%';

    -- 5. In-flight queue payloads must carry the new tier value.
    UPDATE public.sync_operations
       SET payload = jsonb_set(payload, '{tier}', '"coordination"'::jsonb)
     WHERE payload ->> 'tier' = 'support'
       AND status IN ('pending', 'processing', 'failed');

    -- 6. Enqueue the in-place Authentik group rename for each existing channel.
    INSERT INTO public.sync_operations (operation_type, payload, created_by)
    SELECT 'update_region_channel_group',
           jsonb_build_object(
             'region_channel_id', rc.id,
             'channel_name', rc.name,
             'description', COALESCE(rc.description, '')
           ),
           rc.created_by
      FROM public.region_channels rc
     WHERE rc.tier = 'coordination'
       AND rc.group_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.region_channels DROP CONSTRAINT IF EXISTS region_channels_tier_check;
    UPDATE public.region_channels SET tier = 'support' WHERE tier = 'coordination';
    ALTER TABLE public.region_channels
      ADD CONSTRAINT region_channels_tier_check
      CHECK (((tier)::text = ANY ((ARRAY['response'::character varying, 'support'::character varying])::text[])));
    COMMENT ON COLUMN public.region_channels.tier IS
      'Which channel tier this region channel belongs to: ''response'' (Emergency_Response, ES-only inner circle, gated by teams.response_channel_access) or ''support'' (all-agency outer circle, gated by teams.support_channel_access). No default -- every insert path supplies it explicitly. See docs.tak.nz Channel Structure.';

    ALTER TABLE public.teams RENAME COLUMN coordination_channel_access TO support_channel_access;
    COMMENT ON COLUMN public.teams.support_channel_access IS
      'Organisation-level only, exactly as response_channel_access is (see that column''s comment for the tri-state rationale). NULL on a Sub_Team; false or true on an Organisation. Resolved via Team.getAncestorChain(teamId)[0]. Whether members of this Organisation (and its Sub_Teams) are synced into support-tier region channels. Defaults to true at Organisation creation (application-supplied) -- the outer/support tier is the all-agency default, opposite of response_channel_access. Mutable thereafter.';

    UPDATE public.region_channels
       SET description = replace(description, '(Coordination - All Agencies)', '(Support - All Agencies)')
     WHERE tier = 'support'
       AND description LIKE '%(Coordination - All Agencies)%';

    UPDATE public.group_membership_rules
       SET target_group_pattern = regexp_replace(target_group_pattern, '^tak_Coordination', 'tak_Support')
     WHERE source_type = 'region_channel'
       AND target_group_pattern LIKE 'tak\\_Coordination%';

    UPDATE public.sync_operations
       SET payload = jsonb_set(payload, '{tier}', '"support"'::jsonb)
     WHERE payload ->> 'tier' = 'coordination'
       AND status IN ('pending', 'processing', 'failed');
  `);
};
