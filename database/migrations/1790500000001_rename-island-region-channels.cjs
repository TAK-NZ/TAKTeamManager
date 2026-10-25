/**
 * Rename the "North Island" / "South Island" coordination channels to
 * "All of North Island" / "All of South Island".
 *
 * Incremental migration on top of the squashed baseline
 * (`1790200000000_baseline-schema.cjs`); NEVER hand-edit schema.sql.
 *
 * The two island channels were first added under their short names, so an
 * environment that has already run "Seed Standard Region Channels" holds rows
 * with the old names. A fresh environment holds none, and this migration is a
 * no-op there (the seed list in `server/config/regions.js` already uses the
 * new names).
 *
 * WHAT CHANGES, for coordination-tier rows only:
 *   - `region_channels.name` / `display_name`.
 *   - the stock `"<name> (Coordination - All Agencies)..."` description prefix
 *     (a description an operator has customised is left alone).
 *   - the channel's `group_membership_rules` row (`rule_name` and the
 *     `tak_Coordination - <name>` `target_group_pattern`).
 *
 * A row is skipped when a channel with the new name already exists in the
 * same tier, so the migration can never trip the (name, tier) unique index.
 *
 * AUTHENTIK GROUP NAMES. This migration touches the local database only. It
 * deliberately does NOT enqueue a rename: the group is renamed in place by
 * `AuthentikSyncService.reconcileRegionChannelGroupNames`, which compares each
 * region channel's real Authentik group name with the name the current code
 * expects on every periodic sync. A one-shot queued rename is not reliable
 * across a deploy, because old Sync_Worker tasks run alongside new ones.
 */
exports.shorthands = undefined;

const RENAMES = [
  ['North Island', 'All of North Island'],
  ['South Island', 'All of South Island']
];

const renameSql = (from, to) => `
  UPDATE public.group_membership_rules r
     SET rule_name = 'Region ${to} Read-Write Access',
         target_group_pattern = regexp_replace(r.target_group_pattern, ' ${from}$', ' ${to}')
    FROM public.region_channels rc
   WHERE r.source_type = 'region_channel'
     AND r.source_id = rc.id
     AND rc.tier = 'coordination'
     AND rc.name = '${from}'
     AND NOT EXISTS (
       SELECT 1 FROM public.region_channels x WHERE x.tier = 'coordination' AND x.name = '${to}'
     );

  UPDATE public.region_channels rc
     SET name = '${to}',
         display_name = '${to}',
         description = CASE
           WHEN rc.description LIKE '${from} (Coordination - All Agencies)%'
             THEN '${to}' || substr(rc.description, length('${from}') + 1)
           ELSE rc.description
         END
   WHERE rc.tier = 'coordination'
     AND rc.name = '${from}'
     AND NOT EXISTS (
       SELECT 1 FROM public.region_channels x WHERE x.tier = 'coordination' AND x.name = '${to}'
     );
`;

exports.up = (pgm) => {
  pgm.sql(RENAMES.map(([from, to]) => renameSql(from, to)).join('\n'));
};

exports.down = (pgm) => {
  pgm.sql(RENAMES.map(([from, to]) => renameSql(to, from)).join('\n'));
};
