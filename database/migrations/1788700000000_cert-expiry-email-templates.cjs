/**
 * Cert_Expiry_Notification email templates migration
 * (cert-expiry-notifications Requirements 3.3, 4.3, task 7.1).
 *
 * Seeds the two `email_templates` rows this feature's digest senders
 * (`CertExpiryNotificationService.sendSelfOwnedDigests`/
 * `sendTeamOwnedDigests`) call by key:
 *
 *   - `cert_expiry_self_digest`: sent to a Self-Owned_Device's owner.
 *     Variables: `first_name`, `device_list` (a pre-formatted HTML block,
 *     one entry per due device, mirroring `EscalationService
 *     .sendAdminDigest`'s own `request_list` pre-formatted-block
 *     convention), `revoke_hint_url` (links to `/enrollment`, where the
 *     existing self-service renew/revoke actions live).
 *   - `cert_expiry_team_digest`: sent to a Team_Admin/Global_Manager
 *     reached by a Team-Owned_Device's Escalation_Round. Variables:
 *     `first_name`, `team_sections` (a pre-formatted HTML block, one
 *     section per team the recipient administers with a due device),
 *     `revoke_hint_url` (links to `/tasks`, this feature's renamed-from-
 *     `/requests` renewal list).
 *
 * Both advise the recipient that if the device is no longer needed, its
 * certificate should be revoked rather than left to lapse unrenewed
 * (Requirement 3.3/4.3's advisory text).
 *
 * Follows the exact seed-block convention `1786596755665_baseline-schema
 * .cjs`'s signup/team-transfer template INSERTs already establish: raw
 * SQL via `pgm.sql(...)`, `INSERT ... ON CONFLICT (template_key) DO
 * NOTHING` (so re-running the chain, or a later migration correcting the
 * wording in place, never clobbers an operator's own edited copy of the
 * row), and a dollar-quoted body (`$tpl$...$tpl$`) for the multi-line,
 * placeholder-carrying template text.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const up = (pgm) => {
  pgm.sql(`
    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'cert_expiry_self_digest',
      'Your device certificate is expiring soon',
      $tpl$Hi {{first_name}},

One or more of your enrolled device certificates will expire soon:

{{device_list}}

Renew now to avoid losing access when the certificate lapses: {{revoke_hint_url}}

If you no longer need a listed device, please revoke its certificate instead of letting it expire unrenewed.$tpl$,
      'cert-expiry-notifications Requirement 3.3: sent as a daily digest to a Self-Owned_Device''s owner listing every device with an eligible expiring-certificate tier'
    )
    ON CONFLICT (template_key) DO NOTHING;

    INSERT INTO email_templates (template_key, subject_template, body_template, description)
    VALUES (
      'cert_expiry_team_digest',
      'Team device certificates are expiring soon',
      $tpl$Hi {{first_name}},

One or more team device certificates you administer will expire soon:

{{team_sections}}

Renew each device from the Tasks page: {{revoke_hint_url}}

If a listed device is no longer needed, please revoke its certificate instead of renewing it.$tpl$,
      'cert-expiry-notifications Requirement 4.3: sent as a daily digest to each admin reached by a Team-Owned_Device''s Escalation_Round, listing every due device across every team that admin administers'
    )
    ON CONFLICT (template_key) DO NOTHING;
  `);
};

/**
 * Reverses exactly what `up()` did.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
const down = (pgm) => {
  pgm.sql(`
    DELETE FROM email_templates WHERE template_key IN ('cert_expiry_self_digest', 'cert_expiry_team_digest');
  `);
};

module.exports = {
  shorthands,
  up,
  down,
};
