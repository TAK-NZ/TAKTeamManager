/**
 * Callsign-mismatch detection (design: docs/ARCHITECTURE.md ("Callsign Mismatch Detection" section)).
 *
 * Adds the three columns the feature needs to `tak_devices`, and seeds the
 * one email template the first-detection notice sends. Incremental migration
 * on top of the squashed baseline (`1790200000000_baseline-schema.cjs`);
 * NEVER hand-edit schema.sql.
 *
 * The three columns are all OWNED by the new `CallsignPoller`
 * (server/services/CallsignPoller.js), the fast 1-minute job that reads
 * TAK Server's live subscription table. This mirrors the single-writer
 * discipline already documented on `tak_devices`: the history
 * `SubscriptionPoller` owns `last_seen_at`/`connected`, the revoke handler
 * owns `revoked`, and `DeviceSync`'s upsert lists none of them. The
 * `CallsignPoller` likewise owns these three and `DeviceSync` must never
 * list them:
 *
 *   - observed_callsign               the callsign the client is CURRENTLY
 *                                     connected under, from
 *                                     `SubscriptionInfo.callsign`. Current
 *                                     state (like `connected`), NOT monotonic:
 *                                     overwritten every poll, nulled when the
 *                                     device is no longer reported connected.
 *   - callsign_violation_first_seen_at the first poll at which a mismatch was
 *                                     observed for the CURRENT breakage
 *                                     episode. Drives the one-poll debounce
 *                                     (the first email requires the mismatch
 *                                     to persist across two consecutive polls).
 *                                     Cleared to NULL when the callsign is
 *                                     corrected (re-arms the next episode).
 *   - callsign_violation_notified_at   the timestamp the single first-detection
 *                                     email was sent for the CURRENT episode.
 *                                     NULL = not yet notified this episode.
 *                                     Set once per episode; cleared on
 *                                     correction so a later re-breakage emails
 *                                     again. This is the edge-trigger latch.
 *
 * All three are nullable with no default: an existing row (and a freshly
 * upserted `DeviceSync` row) starts with NULL for each, which reads correctly
 * as "never observed a live callsign / no violation in flight".
 */

const shorthands = undefined;

const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.tak_devices
      ADD COLUMN IF NOT EXISTS observed_callsign text,
      ADD COLUMN IF NOT EXISTS callsign_violation_first_seen_at timestamp with time zone,
      ADD COLUMN IF NOT EXISTS callsign_violation_notified_at timestamp with time zone;

    COMMENT ON COLUMN public.tak_devices.observed_callsign IS
      'Callsign-mismatch detection: the callsign the client is CURRENTLY connected under, from SubscriptionInfo.callsign (GET /Marti/api/subscriptions/all). Current-state like connected (NOT monotonic): overwritten each CallsignPoller run, NULL when the device is not reported in the live subscription table. Written by the CallsignPoller only; DeviceSync must never list it.';

    COMMENT ON COLUMN public.tak_devices.callsign_violation_first_seen_at IS
      'Callsign-mismatch detection: first poll at which the CURRENT mismatch episode was observed. Drives the one-poll debounce (first email requires two consecutive mismatching polls). NULL when no mismatch is in flight; cleared to NULL when the callsign is corrected. Written by the CallsignPoller only.';

    COMMENT ON COLUMN public.tak_devices.callsign_violation_notified_at IS
      'Callsign-mismatch detection: timestamp the single first-detection email was sent for the CURRENT mismatch episode. NULL = not yet notified this episode; set once then left; cleared to NULL on correction so a later re-breakage emails again (edge-triggered latch). Written by the CallsignPoller only.';
  `);

  // Seed the first-detection email template. Same INSERT ... ON CONFLICT
  // (template_key) DO NOTHING shape every other template uses (see the
  // baseline's seed section), with {{variable}} substitution handled by
  // EmailService.replaceVariables. Plain-text body; EmailService wraps it in
  // the branded HTML template on send.
  pgm.sql(`
    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'callsign_mismatch_notice',
      'Please correct your TAK callsign',
      $tpl$Hi {{first_name}},

One of your devices is currently connected to the TAK server with a callsign that does not match the callsign assigned to you.

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 16px 0;"><tr><td style="background-color: #f0f7ff; border-radius: 8px; border-left: 4px solid #348eda; padding: 16px 20px;"><b>Assigned callsign:</b> <code>{{assigned_callsign}}</code><br><b>Connected callsign:</b> <code>{{observed_callsign}}</code></td></tr></table>

You may add to the end of your assigned callsign (for example "{{assigned_callsign}} (Tablet)"), but the assigned part must stay unchanged. Please correct the callsign in your TAK client.

You can review your devices at any time here: {{login_url}}$tpl$,
      'Callsign-mismatch detection: sent once when a device is first observed connected with a callsign that does not preserve the user''s assigned callsign. Not repeated while the mismatch persists; sent again only after the callsign is corrected and later re-broken.'
    )
    ON CONFLICT (template_key) DO NOTHING;
  `);
};

const down = (pgm) => {
  pgm.sql(`
    DELETE FROM email_templates WHERE template_key = 'callsign_mismatch_notice';

    ALTER TABLE public.tak_devices
      DROP COLUMN IF EXISTS callsign_violation_notified_at,
      DROP COLUMN IF EXISTS callsign_violation_first_seen_at,
      DROP COLUMN IF EXISTS observed_callsign;
  `);
};

module.exports = {
  shorthands,
  up,
  down
};
