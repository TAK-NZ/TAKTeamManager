'use strict';

/**
 * Coalesce duplicate PENDING `reconcile_owned_group` sync_operations.
 *
 * Why: a `reconcile_owned_group` op recomputes a group's COMPLETE desired
 * member set from the DB at drain time and writes it with one full-replace
 * PATCH — so it is idempotent, and any number of identical PENDING ops for the
 * same group collapse to one without losing anything. But the event-driven
 * enqueue sites enqueue one reconcile per affected group PER membership change,
 * so a shared group (e.g. a global/primary channel every user touches) gets
 * re-enqueued once per user during a bulk import. A 15K import produced ~40,000
 * pending reconciles for only ~665 distinct groups (channel_id 3 alone: ~10,000
 * identical pending ops), which then drains over ~18h at the Authentik write
 * ceiling — ~39,000 of those PATCHes are redundant re-reconciles of the same
 * group.
 *
 * The guard: a PARTIAL UNIQUE INDEX on `(operation_type, payload)` restricted
 * to `status = 'pending'` reconcile rows. Combined with the enqueue path's
 * `INSERT ... ON CONFLICT DO NOTHING` (see EventPublisher.publishReconcileOwnedGroup),
 * a second identical enqueue while one is already pending becomes a no-op —
 * race-safe, enforced by the DB rather than a check-then-insert.
 *
 * Scope is deliberately NARROW — only `operation_type = 'reconcile_owned_group'`:
 *   - Only reconcile ops are coalescible (they write the full truth). Other op
 *     types (add_user_to_group, revoke_tak_certificates, …) are NOT idempotent
 *     in this way and must never be deduped — a second one is a second real
 *     action, not a redundant recompute.
 *   - `payload` is `jsonb`, which Postgres canonicalises (key order/whitespace-
 *     independent), so `{group_kind,channel_id}` compares equal regardless of
 *     how it was serialised. The dedup key is `(operation_type, payload)`, NOT
 *     `target_group_id` — reconcile rows carry a null `target_group_id`; the
 *     group identity lives entirely in `payload`.
 *
 * Scope is restricted to `status = 'pending'` — NOT `processing`: a reconcile
 * that has already been CLAIMED (`processing`) snapshotted its desired set when
 * it started, so a membership change landing afterwards legitimately needs a
 * fresh pending op; coalescing against a processing op would drop that change.
 * "One PENDING op suffices" is the exact and only coalescing invariant.
 *
 * This migration also COLLAPSES the existing pending backlog: it deletes all
 * but the oldest (`MIN(id)`) pending reconcile row per distinct
 * `(operation_type, payload)`, so the current ~40K backlog drops to one op per
 * distinct group in the same transaction the index is created — otherwise the
 * unique index creation would fail on the existing duplicates. Only
 * `status = 'pending'` rows are touched; `processing`/`completed`/`failed`
 * history is left entirely intact.
 *
 * down() drops the index. It does NOT (and cannot) restore the collapsed
 * duplicate rows — nor should it: they were redundant. Reverting the code that
 * relies on the index simply returns enqueue to inserting a row every time.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const up = (pgm) => {
  pgm.sql(`
    -- Collapse the existing pending duplicates FIRST, or the unique index
    -- below cannot be created. Keep the oldest row (MIN(id)) per distinct
    -- (operation_type, payload); delete the rest. PENDING reconcile rows only.
    DELETE FROM sync_operations s
    USING (
      SELECT MIN(id) AS keep_id, payload
      FROM sync_operations
      WHERE operation_type = 'reconcile_owned_group' AND status = 'pending'
      GROUP BY payload
    ) keep
    WHERE s.operation_type = 'reconcile_owned_group'
      AND s.status = 'pending'
      AND s.payload = keep.payload
      AND s.id <> keep.keep_id;

    CREATE UNIQUE INDEX idx_sync_operations_pending_reconcile_dedup
      ON sync_operations (operation_type, payload)
      WHERE status = 'pending' AND operation_type = 'reconcile_owned_group';

    COMMENT ON INDEX idx_sync_operations_pending_reconcile_dedup IS 'Coalesces duplicate PENDING reconcile_owned_group ops: at most one pending reconcile per distinct (operation_type, payload=group identity). Enqueue uses ON CONFLICT DO NOTHING against this index (EventPublisher.publishReconcileOwnedGroup). Reconcile ops write the full desired set at drain time, so one pending op suffices for any number of coalesced changes. Deliberately NOT applied to other op types (not idempotent) and NOT to processing rows (a claimed op already snapshotted its set).';
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_sync_operations_pending_reconcile_dedup;
  `);
};

module.exports = { shorthands, up, down };
