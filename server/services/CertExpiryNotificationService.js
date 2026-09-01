const pool = require('../config/database');
const Team = require('../models/Team');
const EmailService = require('./EmailService');
const logger = require('../config/logger').createLogger('CertExpiryNotificationService');
const {
  getCertExpiryTierDays,
  getCertExpiryActivityWindowDays,
} = require('../config/certExpiryNotifications');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Constructed once at module load, mirroring `TeamTransferService`/
// `SignupFlowService`'s own top-level `new EmailService()` -- building the
// nodemailer transport on every digest run (or per-recipient within one)
// would be wasteful.
const emailService = new EmailService();

/**
 * The link every digest email's advisory (Requirements 3.3, 4.3) points
 * a recipient at to renew or revoke. `/enrollment` for a self-owned
 * digest (the existing self-enrollment flow); `/tasks` for a team-owned
 * digest (this feature's own renamed-from-`/requests` renewal list,
 * Requirement 7). Built from `FRONTEND_URL`, matching
 * `EscalationService.sendAdminDigest`'s own `team_manager_url` convention.
 *
 * @param {string} path - '/enrollment' or '/tasks'.
 * @returns {string}
 */
function buildHintUrl(path) {
  return `${process.env.FRONTEND_URL || ''}${path}`;
}

/**
 * The four Cert_Expiry_Tier rounds, day-descending (TIER1 first, per
 * requirements.md's Glossary). `round` is the Escalation_Round a
 * Team-Owned_Device candidate at this tier reaches (Requirement 4.1);
 * unused for a Self-Owned_Device candidate.
 *
 * Read fresh on every call to `findEligibleCandidates` (not cached at
 * module load), so a changed `.env` value takes effect on the very next
 * scheduled run without a process restart -- matching
 * `RetentionCleanupJob.deleteExpiredRows`'s own "read the threshold on
 * every run" convention.
 *
 * @returns {Array<{thresholdDays: number, round: number}>}
 */
function resolveTiersDayDescending() {
  const tierDays = getCertExpiryTierDays();
  return [
    { thresholdDays: tierDays.tier1, round: 1 },
    { thresholdDays: tierDays.tier2, round: 2 },
    { thresholdDays: tierDays.tier3, round: 3 },
    { thresholdDays: tierDays.tier4, round: 4 },
  ];
}

/**
 * cert-expiry-notifications Requirement 2: resolves the eligibility of
 * every live (non-revoked), non-null-`expires_at` `tak_devices` row whose
 * owning account is active, against the four configured Cert_Expiry_Tier
 * thresholds and the single Cert_Expiry_Activity_Window.
 *
 * Structured as static methods so it is mockable the same way
 * `AccountLifecycleService`/`TakCertificateRevocationService` already
 * are. No transaction is used anywhere in this service: every write here
 * is either an idempotent `INSERT ... ON CONFLICT DO NOTHING` or
 * independent of any other write in the same run.
 */
class CertExpiryNotificationService {
  /**
   * Requirement 2: one pass over every eligible `tak_devices` row,
   * returning per-device/per-tier eligibility split into `toEmail` (the
   * single most urgent DUE-and-unresolved tier per candidate, gated on
   * the activity check) and `toMarkResolvedOnly` (every OTHER
   * DUE-and-unresolved tier for a candidate whose most urgent tier was
   * selected for `toEmail` -- Requirement 2.3's multi-tier-backlog
   * collapse). `toMarkResolvedOnly` entries are persisted immediately as
   * part of this call (Requirement 2.3's "resolved with no email"); they
   * carry no send-success dependency, unlike `toEmail`.
   *
   * @param {Date} [now=new Date()] the reference instant for computing
   *   `Days_Left`; a parameter so the run's own `now` is fully testable.
   * @returns {Promise<{toEmail: Array<object>, toMarkResolvedOnly: Array<object>}>}
   */
  static async findEligibleCandidates(now = new Date()) {
    const tiers = resolveTiersDayDescending();
    const activityWindowDays = getCertExpiryActivityWindowDays();
    const activityWindowMs = activityWindowDays * MS_PER_DAY;

    // Requirement 2.5: exclude a device whose owning account is not
    // 'active' (covers both suspended and orphaned) from every tier's
    // evaluation -- an account that cannot currently authenticate has no
    // one who can act on a renewal warning.
    const { rows } = await pool.query(
      `SELECT d.client_uid, d.cert_id, d.expires_at, d.last_seen_at, d.issued_at,
              u.id AS user_id, u.is_team_device, u.email, u.username, u.first_name,
              tm.team_id AS direct_team_id
       FROM tak_devices d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN team_memberships tm ON tm.user_id = u.id AND tm.inherited_from_team_id IS NULL
       WHERE d.revoked = false
         AND d.expires_at IS NOT NULL
         AND u.account_status = 'active'`
    );

    if (rows.length === 0) {
      return { toEmail: [], toMarkResolvedOnly: [] };
    }

    // Batch-check which of every candidate's DUE tiers already have a
    // cert_expiry_notifications row, in ONE query across every candidate
    // -- no N+1, per this codebase's query convention. Keyed by
    // "client_uid|cert_id|threshold_days" for an O(1) lookup below.
    const clientUids = rows.map((row) => row.client_uid);
    const certIds = rows.map((row) => row.cert_id);
    const { rows: resolvedRows } = await pool.query(
      `SELECT client_uid, cert_id, threshold_days
       FROM cert_expiry_notifications
       WHERE (client_uid, cert_id) IN (
         SELECT * FROM UNNEST($1::varchar[], $2::int[])
       )`,
      [clientUids, certIds]
    );
    const alreadyResolved = new Set(
      resolvedRows.map((r) => `${r.client_uid}|${r.cert_id}|${r.threshold_days}`)
    );

    const nowMs = now.getTime();
    const toEmail = [];
    const toMarkResolvedOnly = [];

    for (const row of rows) {
      const expiresAtMs = new Date(row.expires_at).getTime();
      const daysLeft = Math.ceil((expiresAtMs - nowMs) / MS_PER_DAY);

      // Requirement 2.1: DUE tiers, day-descending (TIER1 first) so the
      // eventual "most urgent" pick below only has to take the FIRST
      // unresolved entry rather than re-sort.
      const dueTiers = tiers.filter((tier) => daysLeft <= tier.thresholdDays);
      if (dueTiers.length === 0) {
        continue;
      }

      // Requirement 1.2/2.2: a DUE tier already resolved for this exact
      // (client_uid, cert_id) is excluded outright -- never re-considered,
      // never re-emailed, and (per Requirement 2.4) never re-marked here.
      const dueUnresolvedTiers = dueTiers.filter(
        (tier) =>
          !alreadyResolved.has(`${row.client_uid}|${row.cert_id}|${tier.thresholdDays}`)
      );
      if (dueUnresolvedTiers.length === 0) {
        continue;
      }

      // Requirement 2.2: the activity check is computed ONCE per
      // candidate (it does not vary per tier) -- last_seen_at, falling
      // back to issued_at when null; both null fails the check outright
      // rather than satisfying it.
      const activityAnchor = row.last_seen_at ?? row.issued_at;
      const activityOk =
        activityAnchor != null &&
        new Date(activityAnchor).getTime() >= expiresAtMs - activityWindowMs;

      if (!activityOk) {
        // Requirement 2.4: none of this candidate's DUE-and-unresolved
        // tiers are written or emailed this run -- they stay open for
        // the next run, in case the device becomes active again before
        // its certificate expires.
        continue;
      }

      // Requirement 2.3: among the DUE-and-unresolved tiers, the single
      // most urgent (smallest threshold_days, i.e. the FIRST in the
      // day-descending list) becomes this candidate's email tier; every
      // other DUE-and-unresolved tier is queued to be marked resolved
      // with no email.
      const mostUrgent = dueUnresolvedTiers[dueUnresolvedTiers.length - 1];
      const backlogTiers = dueUnresolvedTiers.filter((tier) => tier !== mostUrgent);

      const candidateBase = {
        clientUid: row.client_uid,
        certId: row.cert_id,
        isTeamDevice: row.is_team_device,
        directTeamId: row.direct_team_id,
        email: row.email,
        username: row.username,
        firstName: row.first_name,
        expiresAt: row.expires_at,
      };

      toEmail.push({
        ...candidateBase,
        thresholdDays: mostUrgent.thresholdDays,
        round: mostUrgent.round,
      });

      for (const tier of backlogTiers) {
        toMarkResolvedOnly.push({
          ...candidateBase,
          thresholdDays: tier.thresholdDays,
          round: tier.round,
        });
      }
    }

    if (toMarkResolvedOnly.length > 0) {
      await CertExpiryNotificationService.#markResolved(toMarkResolvedOnly);
    }

    return { toEmail, toMarkResolvedOnly };
  }

  /**
   * Writes one `cert_expiry_notifications` row per entry, `INSERT ...
   * ON CONFLICT (client_uid, cert_id, threshold_days) DO NOTHING`. Used
   * both for `toMarkResolvedOnly` entries (which carry no send-success
   * dependency) and, by the digest senders, for `toEmail` entries after a
   * successful send.
   *
   * @param {Array<{clientUid: string, certId: number, thresholdDays: number}>} entries
   * @returns {Promise<void>}
   */
  static async #markResolved(entries) {
    if (entries.length === 0) return;

    const clientUids = entries.map((e) => e.clientUid);
    const certIds = entries.map((e) => e.certId);
    const thresholdDaysList = entries.map((e) => e.thresholdDays);

    await pool.query(
      `INSERT INTO cert_expiry_notifications (client_uid, cert_id, threshold_days)
       SELECT * FROM UNNEST($1::varchar[], $2::int[], $3::int[])
       ON CONFLICT (client_uid, cert_id, threshold_days) DO NOTHING`,
      [clientUids, certIds, thresholdDaysList]
    );
  }

  /**
   * Requirement 3: groups `toEmail` Self-Owned_Device candidates by owner
   * user, sends one digest email per user (never per device), and marks
   * each group's tiers resolved only after that group's send succeeds.
   *
   * @param {Array<object>} candidates - the `toEmail` array from
   *   `findEligibleCandidates` (both team- and self-owned; this method
   *   filters to `!isTeamDevice` itself).
   * @returns {Promise<void>}
   */
  static async sendSelfOwnedDigests(candidates) {
    const selfOwned = candidates.filter((c) => !c.isTeamDevice);
    if (selfOwned.length === 0) return;

    const byUserEmail = new Map();
    for (const candidate of selfOwned) {
      if (!candidate.email) {
        // No email on file for this owner (should not happen for an
        // 'active' human account, but this service never assumes the
        // shape of upstream data) -- nothing reachable to send to, and
        // nothing is marked resolved, so it is simply retried (and
        // logged) on the next run.
        logger.warn(
          { clientUid: candidate.clientUid, userId: candidate.email },
          'Self-owned cert-expiry candidate has no owner email; skipping this run'
        );
        continue;
      }
      if (!byUserEmail.has(candidate.email)) {
        byUserEmail.set(candidate.email, []);
      }
      byUserEmail.get(candidate.email).push(candidate);
    }

    for (const [email, group] of byUserEmail) {
      try {
        const deviceList = group
          .map((c) => `<b>Device:</b> ${c.username}\n<b>Expires:</b> ${new Date(c.expiresAt).toISOString()}`)
          .join('\n\n');

        await emailService.sendEmail(email, 'cert_expiry_self_digest', {
          first_name: group[0].firstName || '',
          device_list: deviceList,
          revoke_hint_url: buildHintUrl('/enrollment'),
        });

        // Requirement 3.4: mark resolved only after the send call
        // returns successfully.
        await CertExpiryNotificationService.#markResolved(group);
      } catch (error) {
        // Requirement 3.4: a failed send leaves this group's tiers
        // unresolved so the next scheduled run retries them. Caught
        // per-recipient (mirroring `EscalationService.sendAdminDigest`'s
        // own per-admin try/catch) so one recipient's SMTP failure
        // cannot abort the rest of the batch.
        logger.error({ err: error, email }, 'Failed to send self-owned cert-expiry digest');
      }
    }
  }

  /**
   * Requirement 4: resolves each `toEmail` Team-Owned_Device candidate's
   * Escalation_Round recipient set via `Team.getAncestorChain`, groups by
   * recipient (an admin managing several teams gets one email spanning
   * all of them), sends one digest per admin, and marks each
   * `(clientUid, certId, thresholdDays)` resolved only once every
   * recipient it was queued to reach has been attempted successfully.
   *
   * @param {Array<object>} candidates - the `toEmail` array from
   *   `findEligibleCandidates`; filtered to `isTeamDevice` here.
   * @returns {Promise<void>}
   */
  static async sendTeamOwnedDigests(candidates) {
    const teamOwned = candidates.filter((c) => c.isTeamDevice);
    if (teamOwned.length === 0) return;

    // Resolve each candidate's recipient set once, caching by
    // `directTeamId:round` so a team with many due devices at the same
    // round does not re-walk the ancestor chain per device.
    const recipientCache = new Map();
    async function resolveRecipientsCached(directTeamId, round) {
      const cacheKey = `${directTeamId}:${round}`;
      if (recipientCache.has(cacheKey)) {
        return recipientCache.get(cacheKey);
      }
      const recipients = await CertExpiryNotificationService.#resolveEscalationRecipients(
        directTeamId,
        round
      );
      recipientCache.set(cacheKey, recipients);
      return recipients;
    }

    // Map<adminUserId, { email, teamDevicesById: Map<teamId, {teamName, devices: [...]}> }>
    const digestsByAdmin = new Map();
    // Map<"clientUid|certId|thresholdDays", { candidate, recipientUserIds: Set<number>, succeededUserIds: Set<number> }>
    const outcomeByCandidateKey = new Map();

    for (const candidate of teamOwned) {
      if (candidate.directTeamId == null) {
        // No Direct_Membership team on file for this device -- nothing to
        // resolve recipients against. Logged and left unresolved for the
        // next run rather than silently dropped.
        logger.warn(
          { clientUid: candidate.clientUid },
          'Team-owned cert-expiry candidate has no direct team membership; skipping this run'
        );
        continue;
      }

      const recipients = await resolveRecipientsCached(candidate.directTeamId, candidate.round);
      const candidateKey = `${candidate.clientUid}|${candidate.certId}|${candidate.thresholdDays}`;
      outcomeByCandidateKey.set(candidateKey, {
        candidate,
        recipientUserIds: new Set(recipients.map((r) => r.id)),
        succeededUserIds: new Set(),
      });

      for (const recipient of recipients) {
        if (!digestsByAdmin.has(recipient.id)) {
          digestsByAdmin.set(recipient.id, { email: recipient.email, teamDevicesById: new Map() });
        }
        const adminEntry = digestsByAdmin.get(recipient.id);
        if (!adminEntry.teamDevicesById.has(candidate.directTeamId)) {
          adminEntry.teamDevicesById.set(candidate.directTeamId, []);
        }
        adminEntry.teamDevicesById.get(candidate.directTeamId).push(candidate);
      }
    }

    for (const [adminUserId, { email, teamDevicesById }] of digestsByAdmin) {
      if (!email) {
        logger.warn({ adminUserId }, 'Team-owned cert-expiry recipient has no email; skipping this run');
        continue;
      }
      try {
        const teamSections = [...teamDevicesById.values()]
          .map((devices) =>
            devices
              .map(
                (c) =>
                  `<b>Device:</b> ${c.username}\n<b>Expires:</b> ${new Date(c.expiresAt).toISOString()}`
              )
              .join('\n')
          )
          .join('\n\n');

        await emailService.sendEmail(email, 'cert_expiry_team_digest', {
          first_name: '',
          team_sections: teamSections,
          revoke_hint_url: buildHintUrl('/tasks'),
        });

        // Record this admin's send as successful against every candidate
        // it was queued to reach.
        for (const devices of teamDevicesById.values()) {
          for (const candidate of devices) {
            const candidateKey = `${candidate.clientUid}|${candidate.certId}|${candidate.thresholdDays}`;
            outcomeByCandidateKey.get(candidateKey).succeededUserIds.add(adminUserId);
          }
        }
      } catch (error) {
        // Caught per-recipient, matching sendSelfOwnedDigests/
        // sendAdminDigest's own convention -- one admin's SMTP failure
        // must not abort the rest of the batch.
        logger.error({ err: error, adminUserId, email }, 'Failed to send team-owned cert-expiry digest');
      }
    }

    // Requirement 3.4/4's rule applied per notification-row: a device/tier
    // is marked resolved only once EVERY recipient it was queued to reach
    // in this run succeeded.
    const toMarkResolved = [];
    for (const { candidate, recipientUserIds, succeededUserIds } of outcomeByCandidateKey.values()) {
      const everyRecipientSucceeded =
        recipientUserIds.size > 0 &&
        [...recipientUserIds].every((id) => succeededUserIds.has(id));
      if (everyRecipientSucceeded) {
        toMarkResolved.push(candidate);
      }
    }
    await CertExpiryNotificationService.#markResolved(toMarkResolved);
  }

  /**
   * Requirement 4.1: resolves a Team-Owned_Device candidate's
   * Escalation_Round recipient set. `Team.getAncestorChain` is root-first
   * -- `depth 0` is the Organisation, and the chain's LAST row is
   * `directTeamId` itself at its own Team_Depth `D`. Round 1 reaches only
   * `depth D` (the device's own team); each subsequent round climbs ONE
   * level toward the Organisation; round 4 reaches every depth down to
   * and including 0, unconditionally.
   *
   * Applies the SAME `role = 'admin' AND inherited_from_team_id IS NULL`
   * predicate `Team.isAdmin`/`Team.getManagedTeamIds` already use, to a
   * *set* of team ids (the round's depth-bounded suffix of the chain)
   * rather than a single team -- no new admin-resolution rule.
   * Requirement 4.4: the recipient's own `account_status` must be
   * `'active'`.
   *
   * @param {number} directTeamId
   * @param {number} round - 1, 2, 3, or 4.
   * @returns {Promise<Array<{id: number, email: string}>>}
   */
  static async #resolveEscalationRecipients(directTeamId, round) {
    const chain = await Team.getAncestorChain(directTeamId);
    if (!Array.isArray(chain) || chain.length === 0) {
      return [];
    }

    const deviceTeamDepth = chain[chain.length - 1].depth;
    const depthFloor = round === 4 ? 0 : Math.max(0, deviceTeamDepth - (round - 1));
    const teamIds = chain.filter((t) => t.depth >= depthFloor).map((t) => t.id);

    const { rows } = await pool.query(
      `SELECT DISTINCT u.id, u.email
       FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = ANY($1::int[])
         AND tm.role = 'admin'
         AND tm.inherited_from_team_id IS NULL
         AND u.account_status = 'active'`,
      [teamIds]
    );

    return rows;
  }

  /**
   * Requirement 5.1: orchestrates `findEligibleCandidates` ->
   * `sendSelfOwnedDigests` -> `sendTeamOwnedDigests` for one scheduled
   * run. Called by `CertExpiryNotificationJob`.
   *
   * @param {Date} [now=new Date()]
   * @returns {Promise<void>}
   */
  static async run(now = new Date()) {
    const { toEmail } = await CertExpiryNotificationService.findEligibleCandidates(now);
    await CertExpiryNotificationService.sendSelfOwnedDigests(toEmail);
    await CertExpiryNotificationService.sendTeamOwnedDigests(toEmail);
  }
}

module.exports = CertExpiryNotificationService;
