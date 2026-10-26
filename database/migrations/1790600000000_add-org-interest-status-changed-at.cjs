/**
 * Add `org_interest_requests.status_changed_at`.
 *
 * The table only carried `created_at`, so there was no way to tell WHEN a
 * request was dismissed. The retention purge for dismissed requests
 * (`RetentionCleanupJob`, `ORG_INTEREST_DISMISSED_RETENTION_DAYS`) is
 * measured from the moment of dismissal, not from submission: keyed on
 * `created_at`, a request dismissed today but submitted a week ago would be
 * deleted immediately.
 *
 * The column is nullable with no default. `OrgInterestService.updateStatus`
 * sets it on every status change, so a `pending` row has NULL. Existing
 * `dismissed` rows are backfilled from `created_at` (the best available
 * approximation), which means the first purge after deploy removes any that
 * are already older than the retention window. The purge also falls back to
 * `COALESCE(status_changed_at, created_at)`, so a dismissal written by an
 * older application instance during a rolling deploy (no timestamp) is still
 * purged rather than kept forever.
 *
 * Incremental migration on top of the squashed baseline
 * (`1790200000000_baseline-schema.cjs`); NEVER hand-edit schema.sql.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.org_interest_requests
      ADD COLUMN status_changed_at timestamp without time zone;

    UPDATE public.org_interest_requests
       SET status_changed_at = created_at
     WHERE status <> 'pending'
       AND status_changed_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.org_interest_requests
      DROP COLUMN IF EXISTS status_changed_at;
  `);
};
