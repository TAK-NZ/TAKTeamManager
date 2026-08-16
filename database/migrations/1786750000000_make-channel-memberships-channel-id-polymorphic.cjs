/**
 * Drops the hard foreign key from `channel_memberships.channel_id` to
 * `channels(id)`, making `channel_id` a polymorphic reference -- for the
 * DeploymentChannelService self-service subscribe/unsubscribe methods
 * (Requirement 22 Criteria 6-7, task 42.2).
 *
 * ## Why this is needed
 *
 * `channel_memberships.channel_id` was declared in the baseline migration
 * as `INTEGER REFERENCES channels(id) ON DELETE CASCADE` (confirmed via
 * `\d channel_memberships` against a freshly migrated database: the
 * constraint's actual, Postgres-default-assigned name is
 * `channel_memberships_channel_id_fkey`). That FK hard-codes the
 * assumption that every `channel_memberships` row represents a
 * team-scoped `channels` row.
 *
 * `deployment_channels` (added by
 * `1786730000000_create-deployment-channels.cjs`) is a structurally
 * separate table with its own independent `id` sequence. A user
 * "subscribing" to a Deployment_Channel (Requirement 22 Criterion 6)
 * needs a `channel_memberships` row whose `channel_id` points at a
 * `deployment_channels.id` -- which the existing FK would either reject
 * outright (if no `channels` row happens to share that id) or, worse,
 * silently accept and misattribute to an unrelated `channels` row that
 * happens to share the same numeric id.
 *
 * ## Precedent: `vendor_channel_grants.channel_id`
 *
 * This is exactly the "polymorphic reference, no single hard FK"
 * situation already accepted elsewhere in this schema. See
 * `1786720000000_create-vendor-channel-grants.cjs`'s file-level comment
 * ("## `channel_id` FK target reasoning"): `vendor_channel_grants
 * .channel_id` is a plain `INTEGER` column with no FK, because it must
 * reference rows across several different, structurally-independent
 * channel-like tables (`bch_channels`, `region_channels`,
 * `deployment_channels`, `vendor_channels`), and no single `REFERENCES`
 * clause can correctly constrain a column that may point into any one of
 * several tables depending on context. That same reasoning now also
 * applies to `channel_memberships.channel_id`, which -- prior to this
 * migration -- only had to reference `channels` (the team-scoped case),
 * but now also needs to reference `deployment_channels` (and, by the
 * same argument, could reasonably need to reference `bch_channels`,
 * `region_channels`, or `vendor_channels` in the future, should
 * self-service or per-user membership tracking ever be added for those
 * types). Referential integrity for whichever table a given `channel_id`
 * actually belongs to is enforced at the application layer
 * (`DeploymentChannelService.subscribe`/`unsubscribe`,
 * `Channel.addMember`, task 42.2), exactly as it already is for
 * `vendor_channel_grants.channel_id`.
 *
 * `up()` drops only the FK constraint. The column itself is left
 * untouched (still `INTEGER`, still nullable-per-original-definition,
 * still indexed by the existing `idx_channel_memberships_channel`
 * index) -- this migration changes what values are *permitted* in the
 * column, not its type or presence.
 *
 * ## The `UNIQUE(user_id, channel_id)` constraint is intentionally KEPT
 *
 * `channel_memberships`'s existing `channel_memberships_user_id_channel_
 * id_key` UNIQUE constraint on `(user_id, channel_id)` is deliberately
 * left in place by this migration, for two reasons:
 *
 *   1. `Channel.addMember` (used by the existing team-scoped
 *      `Channel.createCustomChannel` / `insertCustomChannelAndMembers`
 *      path, and by every other existing caller) performs
 *      `INSERT ... ON CONFLICT (user_id, channel_id) DO UPDATE SET
 *      permission = $3` -- an upsert that requires this exact unique
 *      constraint to exist as an arbiter. Dropping it would break that
 *      existing, already-shipped behavior for team-scoped channels,
 *      which is out of scope for this task.
 *
 *   2. Doing so does trade away a real guarantee: with `channel_id` now
 *      polymorphic, a `channels.id` value and a `deployment_channels.id`
 *      value CAN collide on the same integer (e.g. `channels` row 5 and
 *      `deployment_channels` row 5) for the same `user_id`, and the
 *      UNIQUE constraint has no way to know these are different
 *      "channels" in different tables -- it would incorrectly treat a
 *      user's team-channel-5 membership and their deployment-channel-5
 *      subscription as "the same" membership row, either rejecting a
 *      legitimate second subscription as a duplicate, or (via
 *      `addMember`'s `ON CONFLICT ... DO UPDATE`) silently overwriting
 *      one membership's `permission` value when the other is written.
 *
 * This is the same cross-table-id-collision risk already inherent to any
 * polymorphic-no-FK design, and it is the exact reason
 * `vendor_channel_grants` (also polymorphic on `channel_id`) has NO
 * unique constraint on `(user_id, channel_id)` at all -- see that
 * table's migration, which defines no such constraint precisely to avoid
 * this false-collision problem.
 *
 * `channel_memberships` cannot follow that same "just drop it" answer
 * without breaking `Channel.addMember`'s upsert semantics for the
 * team-scoped case (reason 1 above), and rewriting `Channel.addMember`
 * is out of scope for this task. This migration therefore makes a
 * deliberate, documented tradeoff: the UNIQUE constraint is LEFT IN
 * PLACE, and the cross-table-id-collision risk it now carries for
 * non-team channel types (Deployment_Channel today; potentially others
 * later) is accepted as a known limitation, to be resolved at the
 * application layer if/when it becomes a practical problem -- following
 * the same "resolved at the application layer" philosophy already
 * established for polymorphic references in this codebase (see the
 * `vendor_channel_grants.channel_id` precedent above). In practice, the
 * `DeploymentChannelService.subscribe`/`unsubscribe` methods (task 42.2)
 * insert/delete `channel_memberships` rows directly rather than through
 * `Channel.addMember`'s upsert, so a collision would surface as an
 * unexpected-duplicate-key error on `subscribe` rather than a silent
 * permission overwrite -- an acceptable, visible failure mode for now.
 *
 * `down()` restores the original FK
 * (`channel_memberships_channel_id_fkey`, `REFERENCES channels(id) ON
 * DELETE CASCADE`), matching the baseline migration's original
 * definition exactly, for reversibility.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

const FK_CONSTRAINT_NAME = 'channel_memberships_channel_id_fkey';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.dropConstraint('channel_memberships', FK_CONSTRAINT_NAME);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.addConstraint('channel_memberships', FK_CONSTRAINT_NAME, {
    foreignKeys: {
      columns: 'channel_id',
      references: 'channels(id)',
      onDelete: 'CASCADE',
    },
  });
};

module.exports = {
  shorthands,
  up,
  down,
};
