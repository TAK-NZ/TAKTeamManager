const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { paginationParams } = require('../middleware/pagination');
const User = require('../models/User');
const Team = require('../models/Team');
const authentikService = require('../services/authentik');
const { isIgnoredAuthentikUsername } = require('../config/authentikSyncIgnore');
const UserAttributesService = require('../services/userAttributes');
const TeamMembershipService = require('../services/TeamMembershipService');
const UserProvisioningService = require('../services/UserProvisioningService');
const ManagedIdentifierService = require('../services/ManagedIdentifierService');
const DirectoryScopeService = require('../services/DirectoryScopeService');
const { buildEmailDomainLikePatterns, partitionCandidates } = require('../utils/directoryScope');
const { CallsignSuffixConflictError, checkCallsignSuffixUniqueness } = require('../services/CallsignSuffixUniquenessService');
const { isValidCallsignSuffix } = require('../utils/callsignValidation');
const {
  TeamTransferService,
  NoCurrentTeamError,
  AlreadyInDestinationTeamError,
  SelfTransferError,
  CrossOrganisationTransferError
} = require('../services/TeamTransferService');
const EventPublisher = require('../services/EventPublisher');
const EmailService = require('../services/EmailService');
const { fetchWithTimeout } = require('../utils/fetchWithTimeout');
// AccountLifecycleService exports the class itself as the default export
// (module.exports = AccountLifecycleService), with its error classes
// attached as properties on it -- the same shape VendorChannelService and
// DeviceEnrollmentService already use -- rather than TeamTransferService's
// plain-object-of-named-exports shape, so this is a single require, not a
// destructure.
const AccountLifecycleService = require('../services/AccountLifecycleService');
const {
  AccountAlreadySuspendedError,
  AccountOrphanedError,
  AccountNotSuspendedError,
  TargetUserNotFoundError
} = AccountLifecycleService;
const { isCloudTakEnabled } = require('../config/cloudtak');
const { isDeviceMgmtRevokeEnabled } = require('../config/deviceMgmt');
const pool = require('../config/database');
const { getLogger } = require('../middleware/requestContext');
const router = express.Router();

// List all users
//
// Requirement 11.3: team-name resolution for the full returned user list
// runs as a single batched query, independent of the number of users
// returned, instead of one recursive-CTE query per user (the previous
// implementation's N+1 pattern via `Promise.all(authentikUsers.map(...))`).
//
// The `WITH RECURSIVE team_root` CTE below computes, for every team in the
// (small, bounded) `teams` table, its root ancestor's `callsign_prefix`/
// `name` exactly once per request -- not once per returned user -- by
// walking every team's `parent_team_id` chain up to its root row
// (`parent_team_id IS NULL`) in a single pass. The outer query then LEFT
// JOINs `users` -> `team_memberships` (direct membership only, i.e.
// `inherited_from_team_id IS NULL`, matching the prior per-user query's
// filter exactly, now expressed as part of the JOIN condition rather than
// the WHERE clause so a user with no direct team membership still produces
// a row instead of being dropped) -> `teams` -> that precomputed root-team
// result, filtered to `WHERE u.authentik_user_id = ANY($1)` for the full
// batch of Authentik user ids at once. Cost is therefore bounded by the
// size of the `teams` table, not by the number of users returned.
//
// Requirement 11.4: the shared `paginationParams` middleware validates
// `page`/`pageSize` (rejecting out-of-range values with 400 before any
// Authentik/DB call runs) and attaches `req.pagination`. The resolved
// `page`/`pageSize` are passed straight through to
// `authentikService.getUsers()`, which maps them onto Authentik's own
// `page`/`page_size` query parameters (see that method's doc comment for
// why this option was chosen over in-memory slicing of a full fetch) --
// so only the requested page of users is fetched from Authentik at all,
// and the batched team-name query's `ANY($1)` id array is scoped to that
// same page.
//
// Requirement 27.9 (task 49.5): excludes every Team_Owned_Device
// (`users.is_team_device = true`) from the response. The primary user
// list here is sourced from AUTHENTIK (`authentikService.getUsers`), not
// the local `users` table.
//
// device-management follow-up: `DeviceEnrollmentService.createDevice` now
// creates a device's Authentik user with `type: 'service_account'`
// (`server/services/authentik.js`'s `createUser`), so a NEWLY created
// device is already excluded upstream by `getUsers({page, pageSize})`'s
// `?type=internal` filter -- it never reaches `authentikUsers` at all.
// This local filter is kept anyway, and remains load-bearing, because a
// Team_Owned_Device created BEFORE this change is still `type: 'internal'`
// in Authentik (confirmed live against account.test.tak.nz: an existing
// device's Authentik user was not retroactively changed) and has no
// scheduled backfill migration -- so a device is indistinguishable from a
// human user on the Authentik side for any row created under the old
// behavior. `is_team_device` is a LOCAL-only flag (added to `users`/
// `user_cache` by task 49.1's migration), so exclusion must happen here,
// after the Authentik fetch, by cross-referencing the local `users`
// table. The SAME single batched query already used for team-name
// resolution above is extended to additionally select `u.is_team_device`,
// keyed by `authentik_user_id`, avoiding a third database round trip
// (Requirement 11.3's "1-2 queries" allowance).
//
// `pagination.total` is INTENTIONALLY left as Authentik's own `count`
// (from its `type=internal` pagination envelope) rather than adjusted
// downward by the number of excluded devices. Getting an exactly-accurate
// adjusted total would require either (a) an additional, page-independent
// `COUNT(*) FROM users WHERE is_team_device = true` query run on every
// request regardless of page contents (a real, if small, cost for a field
// that's advisory at best), or (b) filtering Authentik's OWN result set
// by a criterion Authentik has no concept of for a pre-existing,
// still-`internal`-typed device row. Per this task's explicit allowance
// for a documented compromise, `pagination.total` may therefore
// over-count by the number of still-`internal`-typed Team_Owned_Devices
// that exist; the returned `users` array itself is always correctly
// filtered, which is the requirement's primary concern (Requirement
// 27.9's "excludes every Team_Owned_Device from any user-facing ...
// count").

// Bugfix: the Admin page's "Total Users" stat previously read `GET /api/users`'
// own `pagination.total`, which is Authentik's raw `type=internal` count --
// this is EXACTLY the over-count `GET /` itself documents above and
// deliberately tolerates for its own paginated-list purposes (an ignored-
// prefix account like `etl-earthquakes` is materialized in Authentik but
// never gets a local `users` row at all -- see `authentikSync.js`'s
// `syncSingleUser`/`isIgnoredAuthentikUsername` skip -- and a still-`internal`
// -typed Team_Owned_Device row is filtered from the LIST but not from that
// total). A dedicated, unpaginated route gives the Admin stat an EXACT count
// instead: a single local `COUNT(*)` naturally excludes both, since neither
// an ignored-prefix account nor (after this WHERE) a Team_Owned_Device row is
// counted. Local-only (never calls Authentik), so this is cheap enough to run
// on every Admin page load without the page-independent-COUNT cost `GET /`'s
// own doc comment raises as its reason NOT to do this for the list route.
//
// Also excludes `account_status = 'orphaned'` -- a row the Reconciliation_Sweep
// (`authentikSync.js`) has determined no longer has a matching Authentik
// identity (deleted, or otherwise gone). An orphaned row stays in `users`
// (never deleted -- this app never deletes a federated identity's local
// record), but `/users` itself was never a real user going forward, and this
// stat should agree with what `/users` actually lists.
//
// Also excludes any row whose username matches
// AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES (e.g. `akadmin`/`ckadmin`),
// applying the SAME `isIgnoredAuthentikUsername` predicate `GET /` already
// applies to the list it renders. This is a SEPARATE reason a row can be
// present locally and still not a real user: unlike the two SQL exclusions
// above, a local row for one of these usernames can predate the prefix
// being added to the ignore list -- the ignore list only ever prevents a
// FUTURE materialization/sync, it never retroactively cleans up a row
// created before it was configured. Applied in JS (matching `GET /`'s own
// in-memory filtering) rather than a SQL predicate, since the prefix list
// is env-configured and there is no portable "starts with any of these"
// SQL operator worth building for a table this size.
router.get('/count', authenticateToken, authorize, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT username FROM users WHERE is_team_device = false AND account_status <> 'orphaned'"
    );
    const count = result.rows.filter((row) => !isIgnoredAuthentikUsername(row.username)).length;
    res.json({ count });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to get user count');
    res.status(500).json({ error: 'Failed to get user count' });
  }
});

router.get('/', authenticateToken, authorize, paginationParams, async (req, res) => {
  try {
    const { page, pageSize } = req.pagination;
    const { results: authentikUsers, count: totalUsers } = await authentikService.getUsers({ page, pageSize });

    const authentikUserIds = authentikUsers.map((user) => user.pk);

    // Map of authentik_user_id -> team_name, built from the single batched
    // query below. Defaults to an empty map (all users get team_name: null)
    // when there are no users to look up, avoiding an unnecessary query.
    const teamNameByAuthentikUserId = new Map();
    // Requirement 27.9: authentik_user_id -> is_team_device, built from the
    // SAME batched query below, used to exclude Team_Owned_Device rows
    // from the response after the map is built.
    const isTeamDeviceByAuthentikUserId = new Map();
    // device-management task 15.4: authentik_user_id -> LOCAL `users.id`,
    // built from the SAME batched query below. The user list is sourced from
    // Authentik, so every row's `pk` is an AUTHENTIK id -- but local
    // per-user resources (here: `GET /api/device-management/users/:userId/
    // devices`, whose `:userId` is validated as an integer and matched
    // against `tak_devices.user_id`, a FK to `users(id)`) are keyed on the
    // LOCAL id. Projecting it here lets the Users view address those
    // resources without a second round trip per row, and its absence (a
    // user with no local `users` row yet) is exactly the signal that no
    // local per-user resource can exist for that row.
    const localUserIdByAuthentikUserId = new Map();
    // Users-page-action-parity: authentik_user_id -> the user's DIRECT
    // Membership team id (the same `tm.team_id`/`t.id` this query already
    // joins to build `team_name`, just also projected as a raw id). The
    // Users view's row actions (Edit via `PATCH /api/teams/:teamId/
    // members/:userId`, and the Transfer dialog's source-team exclusion/
    // display) need the ACTUAL team id, not only its rendered display
    // string -- `team_name` alone cannot drive either. `null` for a user
    // with no direct team membership, exactly like `team_name`.
    const teamIdByAuthentikUserId = new Map();
    // Users-page-action-parity: authentik_user_id -> the LOCAL editable
    // fields the Member_List edit form (`MemberEditRow`) needs to pre-fill
    // itself -- `first_name`/`last_name`/`tak_role`/`callsign_suffix` --
    // sourced from the `users` row this query already joins via
    // `tm.user_id = u.id`, rather than from Authentik's own payload
    // (Authentik's `name`/`attributes` are a periodic-sync MIRROR of these
    // same local columns per `authentikSync.js`, and `PATCH /api/teams/
    // :teamId/members/:userId` writes to `users` directly -- so `users` is
    // the authoritative, freshest copy). `null` for a user with no local
    // `users` row, exactly like `local_user_id`.
    const memberEditFieldsByAuthentikUserId = new Map();
    // account-lifecycle-management: authentik_user_id -> the local
    // `users.account_status`/`username` pair, sourced from the SAME
    // batched query below rather than a second lookup. `account_status`
    // drives the Suspend/Unsuspend action's icon/label/mode on this page
    // (mirroring `TeamDetail.jsx`'s Member_List, which already carries
    // it via `Team.getMembers`'s `SELECT u.*`), and `username` is the
    // value `SuspendAccountDialog`'s type-to-confirm input requires for
    // `mode="suspend"` -- present for BOTH a human row and a
    // Team_Owned_Device row, unlike `email`, which the
    // Device_Email_Null_Invariant allows to be null for a device. `null`
    // for a user with no local `users` row, exactly like `local_user_id`.
    const accountLifecycleFieldsByAuthentikUserId = new Map();
    // takserver-enrollment Requirement 13.2/13.6: authentik_user_id ->
    // live certificate count, built from the SAME batched query below via
    // an additional `certs` derived-table LEFT JOIN keyed on `u.id`. A
    // `tak_devices` row's mere existence (with `revoked = false`) IS what
    // "live certificate" means -- `device-management` Requirement 17
    // deletes every row whose underlying certificate is no longer live on
    // each fully-successful sync, so counting rows needs no further
    // filtering. Projecting it here, exactly like `local_user_id` above,
    // lets the Users view render the Multiple_Certificate_Warning without
    // a second round trip per row; it is NOT flag-gated by
    // `isDeviceMgmtEnabled()` because while device-management is off
    // nothing populates `tak_devices`, so every count is already zero.
    const liveCertificateCountByAuthentikUserId = new Map();
    // Requirement 11.2/11.3: authentik_user_id -> the local scoping facts,
    // built from the SAME batched query below. Each entry carries the
    // candidate's Direct_Membership Organisation id (the root of its
    // Ancestor_Chain, projected from the existing `team_root` CTE) so the
    // scoping predicate can run without an extra round trip, along with the
    // candidate's `origin_org_id` provenance (Requirement 13.6).
    const factsByAuthentikUserId = new Map();

    if (authentikUserIds.length > 0) {
      const teamNameResult = await pool.query(`
        WITH RECURSIVE team_root AS (
          SELECT id AS team_id, id AS root_id, name AS root_name,
                 callsign_prefix AS root_callsign_prefix, parent_team_id
          FROM teams
          UNION ALL
          SELECT tr.team_id, p.id AS root_id, p.name AS root_name,
                 p.callsign_prefix AS root_callsign_prefix, p.parent_team_id
          FROM team_root tr
          JOIN teams p ON p.id = tr.parent_team_id
          WHERE tr.parent_team_id IS NOT NULL
        )
        SELECT u.authentik_user_id AS authentik_user_id,
               u.id AS local_user_id,
               u.is_team_device AS is_team_device,
               u.origin_org_id AS origin_org_id,
               u.first_name AS local_first_name,
               u.last_name AS local_last_name,
               u.tak_role AS local_tak_role,
               u.callsign_suffix AS local_callsign_suffix,
               u.username AS local_username,
               u.account_status AS local_account_status,
               root.root_id AS direct_membership_org_id,
               t.id AS team_id,
               CASE
                 WHEN t.parent_team_id IS NOT NULL THEN
                   COALESCE(root.root_callsign_prefix, root.root_name, '') || ' - ' || t.name
                 ELSE t.name
               END AS team_name,
               COALESCE(certs.live_certificate_count, 0) AS live_certificate_count
        FROM users u
        LEFT JOIN team_memberships tm ON u.id = tm.user_id AND tm.inherited_from_team_id IS NULL
        LEFT JOIN teams t ON tm.team_id = t.id
        LEFT JOIN team_root root ON root.team_id = t.id AND root.parent_team_id IS NULL
        LEFT JOIN (
          SELECT user_id, COUNT(*)::int AS live_certificate_count
          FROM tak_devices
          WHERE user_id IS NOT NULL AND revoked = false
          GROUP BY user_id
        ) certs ON certs.user_id = u.id
        WHERE u.authentik_user_id = ANY($1)
      `, [authentikUserIds]);

      for (const row of teamNameResult.rows) {
        teamNameByAuthentikUserId.set(row.authentik_user_id, row.team_name);
        isTeamDeviceByAuthentikUserId.set(row.authentik_user_id, row.is_team_device === true);
        localUserIdByAuthentikUserId.set(row.authentik_user_id, row.local_user_id ?? null);
        liveCertificateCountByAuthentikUserId.set(row.authentik_user_id, row.live_certificate_count ?? 0);
        teamIdByAuthentikUserId.set(row.authentik_user_id, row.team_id ?? null);
        memberEditFieldsByAuthentikUserId.set(row.authentik_user_id, {
          first_name: row.local_first_name ?? null,
          last_name: row.local_last_name ?? null,
          tak_role: row.local_tak_role ?? null,
          callsign_suffix: row.local_callsign_suffix ?? null,
        });
        accountLifecycleFieldsByAuthentikUserId.set(row.authentik_user_id, {
          account_status: row.local_account_status ?? null,
          username: row.local_username ?? null,
        });
        // The `users` row exists locally, so its email/first_name are known,
        // but scoping only needs the org facts here; the email a candidate is
        // matched on comes from the Authentik payload in `toFacts` below,
        // which is the only email a candidate WITHOUT a local row has.
        factsByAuthentikUserId.set(row.authentik_user_id, {
          originOrgId: row.origin_org_id ?? null,
          directMembershipOrgId: row.direct_membership_org_id ?? null,
        });
      }
    }

    // No further async DB calls needed per user; attach each user's
    // team_name synchronously from the lookup map built above (defaulting
    // to null for a user with no direct team membership, matching the
    // previous per-user fallback behavior), and drop any user whose local
    // `users` row has `is_team_device = true` (Requirement 27.9). A user
    // absent from the map (no corresponding local `users` row at all)
    // defaults to `false` via the `=== true` comparison above and is
    // therefore never excluded on that basis alone.
    // Bugfix: reuses the SAME `AUTHENTIK_SYNC_IGNORED_USERNAME_PREFIXES`
    // predicate `authentikSync.js` already applies to decide which
    // Authentik accounts get materialized locally (ETL/service accounts,
    // and now also admin accounts like `akadmin`/`ckadmin` an operator
    // configures) -- this is the SAME class of "administrative/service
    // account that should never appear as a manageable TAK Team Manager
    // user" the sync-skip already exists for, and this route was the one
    // remaining place such an account was still visible: it fetches
    // directly from Authentik's `/core/users/?type=internal` and does
    // not consult the local `users` table's rows for exclusion (only for
    // the `is_team_device` cross-reference below, which is a different
    // condition). Filtering here, in-memory over the current page (like
    // the `is_team_device` filter immediately below it), is therefore the
    // only way to keep this account out of the Users view -- there is no
    // Authentik-side query parameter for "exclude these usernames".
    const usersWithTeams = authentikUsers
      .filter((user) => !isIgnoredAuthentikUsername(user.username))
      .filter((user) => !isTeamDeviceByAuthentikUserId.get(user.pk))
      .map((user) => ({
        ...user,
        team_name: teamNameByAuthentikUserId.get(user.pk) ?? null,
        // device-management task 15.4: additive, and null for a user with no
        // local `users` row. `pk` (Authentik) is left untouched, so every
        // existing consumer of this response is unaffected.
        local_user_id: localUserIdByAuthentikUserId.get(user.pk) ?? null,
        // takserver-enrollment Requirement 13.2/13.6: additive, and 0 for a
        // user absent from the batched query result (no local `users` row)
        // or with zero live `tak_devices` rows -- never null/undefined, so
        // the Multiple_Certificate_Warning can compare against a number
        // unconditionally.
        live_certificate_count: liveCertificateCountByAuthentikUserId.get(user.pk) ?? 0,
        // Users-page-action-parity: additive, and null for a user with no
        // direct team membership -- same fallback shape as `team_name`,
        // which this is the raw id counterpart of.
        team_id: teamIdByAuthentikUserId.get(user.pk) ?? null,
        // Users-page-action-parity: additive, and null (each field) for a
        // user with no local `users` row. These are the LOCAL columns the
        // Member_List edit form pre-fills from -- deliberately spread
        // AFTER `...user` so they win over anything same-named Authentik
        // happened to return (Authentik's own payload carries no
        // `tak_role`/`callsign_suffix` at all and no `first_name`/
        // `last_name` split, only `name`, so there is no real collision
        // today; this ordering is a documented safeguard against that
        // changing silently).
        ...(memberEditFieldsByAuthentikUserId.get(user.pk) ?? {
          first_name: null,
          last_name: null,
          tak_role: null,
          callsign_suffix: null,
        }),
        // account-lifecycle-management: additive, defaulting to null for
        // a user with no local `users` row -- same fallback shape as
        // every other local-column field above. Spread AFTER `...user`
        // for the same documented reason as memberEditFieldsByAuthentikUserId's
        // own spread: Authentik's own payload carries no `account_status`
        // at all and its `username` is the SAME value (this app's sync
        // writes Authentik's username FROM the local column, never the
        // reverse), so there is no real collision today, but the ordering
        // guards against that changing silently.
        ...(accountLifecycleFieldsByAuthentikUserId.get(user.pk) ?? {
          account_status: null,
          username: null,
        })
      }));

    // Users-page-action-parity: `can_manage` -- whether THIS caller may
    // act on THIS row's own team (Edit/Transfer/Delete), independent of
    // the `DirectoryScopeService` VISIBILITY scoping resolved just below.
    // Visibility (who appears in the list) and management authority (which
    // visible rows carry action buttons) are deliberately separate
    // questions: `/users` must not be a wider-reaching escape hatch than
    // `/teams`' own Member_List, where a Team_Admin can only edit/transfer/
    // remove a member of a team they administer (`Team.isAdmin`) or one of
    // its descendants.
    //
    // A Global_Manager can manage every row -- resolved from the SAME
    // cached `is_global_manager` attribute `DirectoryScopeService
    // .resolveScope` and the `user:read:team_admin` authorize.js resolver
    // both already key off, so all three cannot disagree about who one is
    // -- with no query issued. A non-Global_Manager gets ONE query (`Team
    // .getManagedTeamIds`, resolved once per request, not once per row) and
    // `can_manage` becomes a Set-membership test against each row's own
    // `team_id`. A row with no direct team membership (`team_id: null`) is
    // never manageable this way -- `Set.prototype.has(null)` is false --
    // matching `MemberActions`' own `hasTeam` gating on the client.
    const managedTeamIds = req.user && req.user.is_global_manager
      ? null
      : await Team.getManagedTeamIds(req.user && req.user.userId);

    const usersWithManagement = usersWithTeams.map((user) => ({
      ...user,
      can_manage: managedTeamIds === null ? true : managedTeamIds.has(user.team_id)
    }));

    // Requirement 10: a Global_Manager's response is not scoped at all.
    // `resolveScope` returns the frozen UNSCOPED sentinel for that caller, in
    // which case the EXISTING behaviour is preserved verbatim -- no scoping
    // predicate and no scope log line.
    const scope = await DirectoryScopeService.resolveScope(req.user);

    if (scope === DirectoryScopeService.UNSCOPED) {
      res.json({
        users: usersWithManagement,
        pagination: { page, pageSize, total: totalUsers }
      });
      return;
    }

    // Scoped (non-Global_Manager) caller. No SQL narrowing is possible here --
    // the page is Authentik's -- so the predicate runs in JS over the page.
    // The Team_Owned_Device exclusion has ALREADY happened above (Requirement
    // 11.5), so `partitionCandidates` runs over `usersWithManagement` and its
    // `excludedCount` counts users excluded BY THE SCOPING, not by the device
    // filter (Requirement 14.1).
    //
    // A candidate with NO local `users` row is absent from
    // `factsByAuthentikUserId`; it takes its email from the Authentik payload
    // and carries `null` for both org fields, so domain matching is the only
    // condition that can admit it (Requirement 13.7).
    const toFacts = (user) => {
      const local = factsByAuthentikUserId.get(user.pk);
      return {
        email: user.email,
        originOrgId: local ? local.originOrgId : null,
        directMembershipOrgId: local ? local.directMembershipOrgId : null,
      };
    };
    const { visible, excludedCount } = partitionCandidates(scope, usersWithManagement, toFacts);

    DirectoryScopeService.logScopedResponse('GET /api/users', {
      userId: req.user.userId,
      scope,
      excludedCount,
      returnedCount: visible.length,
    });

    // The response keeps its existing shape (Requirement 10.3: the `scope`
    // object is `/available` only). `pagination.total` continues to derive from
    // Authentik's own `count` and is NOT adjusted downward -- the same
    // documented compromise the `is_team_device` filter already carries
    // (Requirement 11.4).
    res.json({
      users: visible,
      pagination: { page, pageSize, total: totalUsers }
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch users');
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get current user profile
router.get('/me', authenticateToken, authorize, async (req, res) => {
  try {
    // Get user's direct team membership only (exclude inherited)
    const teamResult = await pool.query(`
      SELECT t.id, t.name, t.parent_team_id, t.visibility, rt.name AS organisation_name,
             rt.country_code AS organisation_country_code,
             CASE 
               WHEN t.parent_team_id IS NOT NULL THEN 
                 COALESCE(rt.callsign_prefix, rt.name, '') || ' - ' || t.name
               ELSE t.name
             END as display_name
      FROM users u
      JOIN team_memberships tm ON u.id = tm.user_id
      JOIN teams t ON tm.team_id = t.id
      LEFT JOIN teams rt ON rt.id = (
        WITH RECURSIVE root_team AS (
          SELECT id, name, callsign_prefix, parent_team_id FROM teams WHERE id = t.id
          UNION ALL
          SELECT p.id, p.name, p.callsign_prefix, p.parent_team_id 
          FROM teams p JOIN root_team r ON p.id = r.parent_team_id
        )
        SELECT id FROM root_team WHERE parent_team_id IS NULL
      )
      WHERE u.authentik_user_id = $1 AND tm.inherited_from_team_id IS NULL
    `, [req.user.id]);
    
    const teams = teamResult.rows;
    // channel_memberships.user_id is a foreign key to the local users.id,
    // NOT the Authentik id -- req.user.userId, not req.user.id.
    const channels = await User.getChannelMemberships(req.user.userId);
    
    // req.user is already populated from user_cache by
    // resolveUserFromRequest/authenticateToken (server/middleware/auth.js),
    // including groups/takCallsign/takColor/takRole -- and user_cache is
    // kept current by the periodic Authentik sync (authentikSync.js,
    // every SYNC_INTERVAL_MINUTES, default 10). This route previously
    // ALSO made a live call to Authentik's /users/:id/ endpoint, then one
    // more live call PER group membership to resolve group names, on
    // every single call to this route -- entirely redundant with data
    // already sitting in req.user, and the actual cause of the Dashboard
    // (which calls this route on every load) feeling slow: every load
    // paid for 1+N sequential/parallel external HTTP round trips to
    // Authentik just to re-fetch data that was already available locally,
    // at most ~10 minutes staler. Removed entirely -- req.user is used
    // as-is, no live Authentik call.
    res.json({
      user: req.user,
      teams,
      channels
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch user profile');
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Create new user in Authentik and local DB
router.post('/', authenticateToken, authorize, [
  body('username').trim().isLength({ min: 1, max: 150 }),
  body('email').isEmail().normalizeEmail(),
  body('firstName').trim().isLength({ min: 1, max: 150 }),
  body('lastName').trim().isLength({ min: 1, max: 150 }),
  body('password').isLength({ min: 8 }),
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { username, email, firstName, lastName, password, teamId, callsignSuffix } = req.body;

    // Authorization (team admin of teamId, or global manager) is enforced
    // centrally by authorize.js via the 'POST /api/users': ['user:create:team_admin']
    // Permission_Registry entry.

    // takserver-enrollment Requirements 6.3, 6.6, 6.8 (task 5.3): resolve
    // the username AND the callsign_suffix default together, BEFORE
    // creating anything in Authentik, via the single Phase-0 choke point.
    // Under a policy-disabled Organisation this is unchanged from the
    // Phase-0 behaviour it replaces: `resolveNewUserIdentity` returns
    // `requestedUsername` (the caller-supplied `username`) verbatim and
    // runs the same callsign_suffix resolution
    // `resolveCallsignSuffixForNewUser` used to. Under a
    // Pseudonymous_Organisation, the caller-supplied `username` is
    // IGNORED (design decision 8) and a freshly minted
    // Pseudonymous_Username is returned instead, along with a `claimId`
    // naming the Claim_Row already inserted under it.
    //
    // A CallsignSuffixRequiredError/CallsignSuffixConflictError/
    // OrganisationPrefixMissingError is a request-validation failure and
    // is returned as a 400 without ever creating an Authentik user for
    // it -- the same reasoning that already placed the Phase-0 resolution
    // ahead of every Authentik call on this route.
    // ManagedIdentifierExhaustionError is the one 500: it names a defect
    // in the generator's random source, not something the caller can fix.
    let identity;
    try {
      identity = await UserProvisioningService.resolveNewUserIdentity(null, {
        firstName,
        lastName,
        email,
        teamId,
        requestedUsername: username,
        requestedCallsignSuffix: callsignSuffix
      });
    } catch (resolutionError) {
      if (
        resolutionError instanceof UserProvisioningService.CallsignSuffixRequiredError ||
        resolutionError instanceof CallsignSuffixConflictError ||
        resolutionError instanceof ManagedIdentifierService.OrganisationPrefixMissingError
      ) {
        return res.status(400).json({ error: resolutionError.message });
      }
      if (resolutionError instanceof ManagedIdentifierService.ManagedIdentifierExhaustionError) {
        getLogger().error({ err: resolutionError }, 'Managed_Identifier mint exhausted while creating user');
        return res.status(500).json({ error: 'Failed to create user' });
      }
      throw resolutionError;
    }

    const { username: resolvedUsername, callsignSuffix: resolvedCallsignSuffix, claimId } = identity;

    // Create user in Authentik with the RESOLVED username -- the minted
    // Pseudonymous_Username under a pseudonymous Organisation, or the
    // caller-supplied `username` verbatim otherwise.
    const authentikUser = await authentikService.createUser({
      username: resolvedUsername,
      name: `${firstName} ${lastName}`,
      email
    });

    // Set password
    await authentikService.setUserPassword(authentikUser.pk, password);

    let localUser;
    if (claimId != null) {
      // takserver-enrollment Requirement 6.4 (task 5.3): this route uses
      // `User.create`, a DIFFERENT model than
      // `UserProvisioningService.createAndAddUser` (which already
      // supports `claimId` adoption per task 5.2). `User.create` does a
      // plain INSERT, which would insert a SECOND row for the same
      // Authentik user and leave the Claim_Row `resolveNewUserIdentity`
      // already inserted behind forever -- invisible to every existing
      // surface (it has `authentik_user_id IS NULL`, `is_active =
      // false`) and permanently holding `users_email_key` for this
      // email. So this route adopts the exact Claim_Row by primary key
      // instead of calling `User.create`, mirroring the
      // `UPDATE ... WHERE id = $claimId` `createAndAddUser` already
      // performs for the same reason.
      const adoptResult = await pool.query(
        'UPDATE users SET authentik_user_id = $1, username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, callsign_suffix = $6 WHERE id = $7 RETURNING *',
        [authentikUser.pk, resolvedUsername, email, firstName, lastName, resolvedCallsignSuffix, claimId]
      );
      localUser = adoptResult.rows[0];
    } else {
      // Create local user record
      localUser = await User.create({
        authentik_user_id: authentikUser.pk,
        username: resolvedUsername,
        email,
        first_name: firstName,
        last_name: lastName,
        callsign_suffix: resolvedCallsignSuffix
      });
    }

    // Add to team
    await Team.addMember(teamId, localUser.id, 'member');

    res.status(201).json({ 
      user: localUser,
      message: 'User created successfully'
    });
  } catch (error) {
    getLogger().error({ err: error }, 'User creation failed');
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Search users
router.get('/search', authenticateToken, authorize, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query too short' });
    }

    // Requirement 10: a Global_Manager's response is not scoped at all.
    // `resolveScope` returns the frozen UNSCOPED sentinel for that caller, in
    // which case the EXISTING unscoped query and behaviour are preserved
    // verbatim -- no scope predicate, no scope object (Requirement 10.3).
    const scope = await DirectoryScopeService.resolveScope(req.user);

    if (scope === DirectoryScopeService.UNSCOPED) {
      const result = await pool.query(`
        SELECT id, username, email, first_name, last_name 
        FROM users 
        WHERE (username ILIKE $1 OR email ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
        AND is_active = true
        LIMIT 20
      `, [`%${q}%`]);

      res.json({ users: result.rows });
      return;
    }

    // Scoped (non-Global_Manager) caller. Same pre-narrow-then-predicate
    // structure as `/available`: a `candidates` CTE carries the existing ILIKE
    // clauses and `is_active = true` PLUS the `in_scope` expression, and the
    // scope predicate sits INSIDE `candidates`, before the `LIMIT 20`, so
    // out-of-scope rows cannot consume the page (Requirement 8.8).
    //
    // Unlike `/available`, the Direct_Membership condition IS reachable here:
    // `TEAM_ROOT_CTE` resolves each candidate's Organisation via its direct
    // membership's Team, projected as `direct_membership_org_id` from
    // `root.root_id`. The join carries `AND root.parent_team_id IS NULL` so the
    // one selected `team_root` row is the root of the Ancestor_Chain, matching
    // the idiom `GET /api/users`' existing batched query uses.
    //
    // Every scope sub-expression is individually wrapped in COALESCE(..., false)
    // because `NULL = ANY(...)` and `x LIKE ANY(...)` over a null are NULL,
    // which a WHERE treats as not-true but which would silently under-count the
    // window-function excluded_count.
    //
    // Parameter numbering matches the design: $1 is the ILIKE search pattern,
    // $2 is scope.organisationIds (referenced by BOTH the `origin_org_id`
    // disjunct `u.origin_org_id = ANY($2::int[])` and the direct_membership
    // disjunct `root.root_id = ANY($2::int[])`), $3 is
    // buildEmailDomainLikePatterns(scope). All come from the resolved scope and
    // nowhere else.
    //
    // The `u.origin_org_id` disjunct is added here (Requirement 13.6),
    // additively to the Direct_Membership and Email_Domain conditions
    // (Requirement 13.8); `origin_org_id` is projected for the predicate only
    // and never returned in the response body.
    const params = [`%${q}%`, scope.organisationIds, buildEmailDomainLikePatterns(scope)];

    const query = `
      WITH RECURSIVE team_root AS (
        ${DirectoryScopeService.TEAM_ROOT_CTE}
      ),
      candidates AS (
        SELECT u.id, u.username, u.email, u.first_name, u.last_name,
               u.origin_org_id, root.root_id AS direct_membership_org_id,
               (COALESCE(u.origin_org_id = ANY($2::int[]), false)
                OR COALESCE(root.root_id = ANY($2::int[]), false)
                OR COALESCE(lower(u.email) LIKE ANY($3::text[]), false)) AS in_scope
        FROM users u
        LEFT JOIN team_memberships tm ON u.id = tm.user_id AND tm.inherited_from_team_id IS NULL
        LEFT JOIN teams t ON tm.team_id = t.id
        LEFT JOIN team_root root ON root.team_id = t.id AND root.parent_team_id IS NULL
        WHERE (u.username ILIKE $1 OR u.email ILIKE $1 OR u.first_name ILIKE $1 OR u.last_name ILIKE $1)
          AND u.is_active = true
      ),
      counted AS (
        SELECT c.*, COUNT(*) FILTER (WHERE NOT c.in_scope) OVER () AS excluded_count
        FROM candidates c
      )
      SELECT id, username, email, first_name, last_name,
             origin_org_id, direct_membership_org_id, excluded_count
      FROM counted
      WHERE in_scope
      ORDER BY first_name, last_name
      LIMIT 20
    `;

    const result = await pool.query(query, params);

    // The window-function excluded_count is present on every returned row when
    // any row is returned; there is no defined `/search` behaviour for an empty
    // scoped result beyond returning `{ users: [] }`, so the excluded count is
    // read from the first row when present and is 0 otherwise.
    const excludedCount = result.rows.length > 0 ? result.rows[0].excluded_count : 0;

    // Belt-and-braces predicate pass (Requirement 11.3). The SAME `scope`
    // object is the sole input to both the SQL parameters and this predicate,
    // so the response is always a subset of what the predicate permits.
    // `directMembershipOrgId` maps to `root.root_id`; `originOrgId` maps to
    // `u.origin_org_id` (Requirement 13.6); the email comes from the row.
    const toFacts = (row) => ({
      email: row.email,
      originOrgId: row.origin_org_id ?? null,
      directMembershipOrgId: row.direct_membership_org_id,
    });
    const { visible } = partitionCandidates(scope, result.rows, toFacts);

    // Strip the internal `excluded_count`, `direct_membership_org_id`, and
    // `origin_org_id` projections -- they are scoping/provenance details, not
    // part of the `{ users }` response contract (Requirements 10.3, 13.6).
    const users = visible.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
    }));

    DirectoryScopeService.logScopedResponse('GET /api/users/search', {
      userId: req.user.userId,
      scope,
      excludedCount,
      returnedCount: users.length,
    });

    res.json({ users });
  } catch (error) {
    getLogger().error({ err: error }, 'User search failed');
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get available users (not in any team)
router.get('/available', authenticateToken, authorize, async (req, res) => {
  try {
    const { search } = req.query;

    // Requirement 10: a Global_Manager's response is not scoped at all.
    // `resolveScope` returns the frozen UNSCOPED sentinel for that caller, in
    // which case the EXISTING unscoped query and behaviour are preserved
    // verbatim -- no scope predicate, no scope object.
    const scope = await DirectoryScopeService.resolveScope(req.user);

    if (scope === DirectoryScopeService.UNSCOPED) {
      // Bugfix (Add Existing User onboarding): `u.callsign_suffix` is
      // projected alongside the existing name/email fields so the Client
      // can pre-fill the Callsign Suffix field for review/correction
      // before adding this user to a team -- this is the first time a
      // pre-Authentik-only-user is being brought under TAK Team Manager
      // management, so their existing local `users` row (if any) may
      // carry no suffix, or one computed before their name was corrected.
      // `u` may be NULL (no local `users` row yet), in which case this is
      // NULL too -- exactly the "nothing to prefill" case the Client
      // already treats as "compute a default".
      let query = `
        SELECT uc.authentik_id as id, uc.email, uc.first_name, uc.last_name, u.callsign_suffix
        FROM user_cache uc
        LEFT JOIN users u ON uc.authentik_id::text = u.authentik_user_id::text
        LEFT JOIN team_memberships tm ON u.id = tm.user_id AND tm.inherited_from_team_id IS NULL
        WHERE tm.user_id IS NULL AND uc.is_active = true 
          AND uc.email IS NOT NULL AND uc.email != ''
          AND uc.first_name IS NOT NULL AND uc.first_name != ''
      `;
      const params = [];

      if (search) {
        query += ` AND (uc.first_name ILIKE $1 OR uc.last_name ILIKE $1 OR uc.email ILIKE $1)`;
        params.push(`%${search}%`);
      }

      query += ` ORDER BY uc.first_name, uc.last_name LIMIT 50`;

      const result = await pool.query(query, params);
      res.json({ users: result.rows });
      return;
    }

    // Scoped (non-Global_Manager) caller. The scope predicate lives inside the
    // `candidates` CTE, BEFORE the LIMIT: filtering after `LIMIT 50` would let
    // 50 out-of-scope rows consume the whole page and return an empty list
    // while dozens of in-scope users existed (Requirement 8.8). Every scope
    // sub-expression is individually wrapped in COALESCE(..., false) because
    // `NULL = ANY(...)` and `NOT NULL` are NULL, which a WHERE treats as
    // not-true but which would silently under-count the window-function
    // excluded_count.
    //
    // $1 is scope.organisationIds and $2 is buildEmailDomainLikePatterns(scope);
    // both come from the resolved scope and nowhere else. The `search` clause,
    // when present, is appended inside `candidates` IN ADDITION to the scope
    // predicate (Requirement 8.9), never instead of it.
    //
    // `in_scope` is the `u.origin_org_id` disjunct (Requirement 13.6) OR'd
    // with the email-domain LIKE term; `directMembershipOrgId` is always null
    // on this route by construction (`tm.user_id IS NULL`).
    const params = [scope.organisationIds, buildEmailDomainLikePatterns(scope)];
    let searchClause = '';

    if (search) {
      params.push(`%${search}%`);
      searchClause = ` AND (uc.first_name ILIKE $${params.length} OR uc.last_name ILIKE $${params.length} OR uc.email ILIKE $${params.length})`;
    }

    // The `candidates` CTE text is built once and reused verbatim by both the
    // main query and the empty-result count query below, so the two can never
    // drift apart: the count run on the empty path is over EXACTLY the same
    // candidate set, with the same $1/$2 (and optional search) parameters.
    //
    // `$1` (`scope.organisationIds`) now carries the `origin_org_id` disjunct
    // (Requirement 13.6): a `user_cache` row whose local `users` counterpart
    // holds an `origin_org_id` naming an Organisation in the caller's scope is
    // admitted additively to the Email_Domain match (Requirement 13.8). Because
    // `$1` is now referenced by a real use site, the always-true type-inference
    // guard that previously existed here (which only kept `$1` referenced to
    // avoid SQLSTATE 42P18) is removed; the disjunct's `$1::int[]` cast makes
    // the parameter's type unambiguous. `origin_org_id` is projected only for
    // the predicate and is never returned in the response body.
    // Bugfix (Add Existing User onboarding): `u.callsign_suffix` is
    // projected here too, for the same pre-fill reason as the unscoped
    // branch above.
    const candidatesCte = `
      WITH candidates AS (
        SELECT uc.authentik_id AS id, uc.email, uc.first_name, uc.last_name,
               u.origin_org_id, u.callsign_suffix,
               (COALESCE(u.origin_org_id = ANY($1::int[]), false)
                OR COALESCE(lower(uc.email) LIKE ANY($2::text[]), false)) AS in_scope
        FROM user_cache uc
        LEFT JOIN users u ON uc.authentik_id::text = u.authentik_user_id::text
        LEFT JOIN team_memberships tm ON u.id = tm.user_id AND tm.inherited_from_team_id IS NULL
        WHERE tm.user_id IS NULL AND uc.is_active = true
          AND uc.email IS NOT NULL AND uc.email != ''
          AND uc.first_name IS NOT NULL AND uc.first_name != ''${searchClause}
      )`;

    const query = `${candidatesCte}, counted AS (
        SELECT c.*, COUNT(*) FILTER (WHERE NOT c.in_scope) OVER () AS excluded_count
        FROM candidates c
      )
      SELECT id, email, first_name, last_name, callsign_suffix, origin_org_id, excluded_count
      FROM counted
      WHERE in_scope
      ORDER BY first_name, last_name
      LIMIT 50
    `;

    const result = await pool.query(query, params);

    // When the scoped result is empty there is no row from which to read
    // `excluded_count`, so the eventual log line (task 9.3) would have no
    // genuine count. On EXACTLY that path -- and nowhere else -- run one
    // additional `SELECT COUNT(*) FROM candidates` reusing the same CTE and the
    // same parameters, to recover a real excluded/candidate count for the empty
    // response (Requirements 14.1, 14.3). This count is held for task 9.3's
    // `logScopedResponse` call to consume.
    let excludedCount;
    if (result.rows.length === 0) {
      const countResult = await pool.query(
        `${candidatesCte} SELECT COUNT(*)::int AS excluded_count FROM candidates`,
        params
      );
      excludedCount = countResult.rows[0].excluded_count;
    } else {
      excludedCount = result.rows[0].excluded_count;
    }

    // Belt-and-braces predicate pass (Requirement 11.3). The SAME `scope`
    // object is the sole input to both the SQL parameters ($1/$2 above) and
    // this predicate, so the response is always a subset of what the predicate
    // permits: the only reachable divergence is the SQL being NARROWER than the
    // predicate, which hides a visible user rather than disclosing a hidden
    // one. Running `isCandidateVisible` over every row about to be returned
    // guarantees no out-of-scope row can ever leave this handler even if the
    // SQL and the predicate later drift.
    //
    // `origin_org_id` is projected by the query (Requirement 13.6) and passed
    // as `originOrgId` here; `directMembershipOrgId` is always null on this
    // route by construction (`tm.user_id IS NULL`).
    const toFacts = (row) => ({
      email: row.email,
      originOrgId: row.origin_org_id ?? null,
      directMembershipOrgId: null,
    });
    const { visible } = partitionCandidates(scope, result.rows, toFacts);

    // Strip the internal `excluded_count` projection from every returned row --
    // it is a window-function detail, not part of the response contract, and
    // `origin_org_id` is likewise never projected into the body.
    const users = visible.map((row) => ({
      id: row.id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      callsign_suffix: row.callsign_suffix,
    }));

    DirectoryScopeService.logScopedResponse('GET /api/users/available', {
      userId: req.user.userId,
      scope,
      excludedCount,
      returnedCount: users.length,
    });

    res.json({ users, scope: DirectoryScopeService.buildScopeResponse(scope) });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch available users');
    res.status(500).json({ error: 'Failed to fetch available users' });
  }
});

// Read-only callsign_suffix preview for the create-and-add flow.
//
// Reports what `POST /api/users/create-and-add` WOULD assign as the new
// user's `callsign_suffix` for the given name/team, whether the
// Organisation requires the caller to supply one, and whether the
// candidate value collides with an existing Member_List entry -- so the
// Client can show the computed value and surface a collision before the
// user submits (the affordance `GET /api/requests/pending`'s
// `effective_callsign_suffix` already gives the approve flow).
//
// takserver-enrollment Requirement 6.6, 9.1, 9.2 (task 5.3): THIS route
// is NOT the "read-only preview" task 5.8's allow-list exempts --
// that exemption names only the `effective_callsign_suffix` preview at
// `server/routes/requests.js:111`, which calls
// `CallsignService.computeDefaultCallsignSuffix` directly. This route
// instead delegated to the now-removed `resolveCallsignSuffixForNewUser`,
// and has to be rewired.
//
// It is deliberately NOT rewired to call
// `UserProvisioningService.resolveNewUserIdentity` unconditionally,
// though: under a Pseudonymous_Organisation that function mints a
// Managed_Identifier and INSERTS a Claim_Row as a side effect (Criterion
// 1.7/1.8 -- the mint's uniqueness guarantee comes from a real
// `INSERT ... RETURNING id`, not a probe) -- a WRITE this strictly
// read-only preview must never perform, and one this route has no
// `email` to supply for besides (the preview body carries only
// `firstName`/`lastName`/`teamId`/`callsignSuffix`, never `email`, so a
// human Claim_Row's `email` column would be NULL and would violate the
// Device_Email_Null_Invariant on the very first keystroke-blur).
//
// So this route resolves the Organisation's Pseudonymous_Username_Policy
// itself (the SAME `Team.getAncestorChain(teamId)[0]` read
// `resolveNewUserIdentity` performs, so the branch decision cannot
// disagree with the resolver's own), and:
//   - WHERE the policy is enabled, applies Callsign_Default_Suppression
//     directly -- no default is computed, a blank value reports
//     `required: true` (mirroring `CallsignSuffixRequiredError`), and a
//     non-blank value is uniqueness-checked via the SAME shared
//     `checkCallsignSuffixUniqueness` the resolver itself calls, with NO
//     mint attempt and NO write of any kind.
//   - WHERE the policy is disabled, delegates to
//     `resolveNewUserIdentity` exactly as the submit path does --
//     unchanged from this route's previous behaviour, and still
//     strictly read-only, since the resolver's policy-disabled branch
//     never mints or writes anything.
//
// Strictly read-only either way: no INSERT/UPDATE/DELETE, no Authentik
// call, no transaction.
//
// Declared alongside `/search` and `/available` (i.e. ahead of any
// parameterised sibling) so no `/:userId`-style pattern can capture it.
router.post('/callsign-suffix-preview', authenticateToken, authorize, [
  body('teamId').isInt(),
  body('firstName').optional().trim().isLength({ max: 150 }),
  body('lastName').optional().trim().isLength({ max: 150 }),
  body('callsignSuffix').optional().trim().isLength({ max: 150 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { teamId, firstName, lastName, callsignSuffix } = req.body;

  try {
    const ancestorChain = await Team.getAncestorChain(teamId);
    const organisation = ancestorChain[0];
    const pseudonymous = organisation?.pseudonymous_usernames === true;

    // Bugfix (AddTeamDeviceDialog live preview/collision-check, aligning
    // it with the Create New User tab's UX): a Team_Owned_Device has no
    // first/last name to derive a default suffix from at all -- there is
    // nothing for `resolveNewUserIdentity`'s name-derived branch to
    // compute regardless of the Organisation's `callsign_name_format`.
    // When BOTH names are omitted, this preview degrades to exactly the
    // same "no default, just check what was typed" behaviour the
    // pseudonymous branch below already implements: a blank suffix has
    // nothing to preview, and a non-blank one is checked directly against
    // the shared uniqueness rule, with no mint attempt and no write.
    const noNameSupplied = !firstName && !lastName;

    if (pseudonymous || noNameSupplied) {
      const trimmedRequested = callsignSuffix ? callsignSuffix.trim() : '';
      if (!trimmedRequested) {
        return res.json({ suffix: null, required: true, conflict: null });
      }

      try {
        await checkCallsignSuffixUniqueness(teamId, trimmedRequested);
        return res.json({ suffix: trimmedRequested, required: false, conflict: null });
      } catch (conflictError) {
        if (conflictError instanceof CallsignSuffixConflictError) {
          return res.json({
            suffix: conflictError.conflictingValue,
            required: false,
            conflict: { value: conflictError.conflictingValue, message: conflictError.message }
          });
        }
        throw conflictError;
      }
    }

    const identity = await UserProvisioningService.resolveNewUserIdentity(null, {
      firstName,
      lastName,
      email: undefined,
      teamId,
      requestedUsername: undefined,
      requestedCallsignSuffix: callsignSuffix
    });

    return res.json({ suffix: identity.callsignSuffix, required: false, conflict: null });
  } catch (error) {
    if (error instanceof UserProvisioningService.CallsignSuffixRequiredError) {
      // Organisation's callsign_name_format is 'user_defined' and no
      // value was supplied: there is nothing to preview, the Client must
      // prompt for one.
      return res.json({ suffix: null, required: true, conflict: null });
    }

    if (error instanceof CallsignSuffixConflictError) {
      // `conflictingValue` is carried by the error itself (see
      // server/services/CallsignSuffixUniquenessService.js) -- reported
      // as-is rather than re-derived.
      return res.json({
        suffix: error.conflictingValue,
        required: false,
        conflict: { value: error.conflictingValue, message: error.message }
      });
    }

    getLogger().error({ err: error }, 'Failed to preview callsign_suffix for new user');
    return res.status(500).json({ error: 'Failed to preview callsign suffix' });
  }
});

// Create new user in Authentik and add to team
//
// Requirement 17.1: the Authentik-side user-creation call happens strictly
// BEFORE any database transaction opens (an external HTTP call must never
// be issued from inside an open DB transaction). Once the Authentik user
// exists, exactly one client is acquired from the pool, `BEGIN` is issued,
// and every local write (the `users` upsert, `team_memberships` inserts
// including parent-team inheritance, and `channel_memberships` inserts) is
// performed through `UserProvisioningService.createAndAddUser` using that
// single client, followed by `COMMIT` -- or `ROLLBACK` if any local write
// fails -- with the client released in a `finally` block. This route
// handler is intentionally a thin wrapper: parse/validate the request,
// call Authentik, acquire/BEGIN, delegate to the service, commit/rollback,
// and respond.
router.post('/create-and-add', authenticateToken, authorize, [
  body('email').isEmail(),
  body('firstName').trim().isLength({ min: 1, max: 150 }),
  body('lastName').trim().isLength({ min: 1, max: 150 }),
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { email, firstName, lastName, teamId, callsignSuffix, role } = req.body;
  let newUser;

  // --- Phase 0: resolve the username AND the callsign_suffix default
  // together via the single Phase-0 choke point (takserver-enrollment
  // Requirements 6.3, 6.6, 6.8; task 5.3). `requestedUsername: email`
  // is passed IN, matching the existing `const username = email`
  // derivation this route used before this task -- that derivation
  // becomes the value passed to the resolver rather than the value used
  // directly, so a Pseudonymous_Organisation can override it with a
  // minted Pseudonymous_Username. Under a policy-disabled Organisation
  // the resolver returns `requestedUsername` verbatim (Criterion 6.8),
  // so `resolvedUsername` equals `email` exactly as before.
  //
  // This is a pure-read operation UNLESS the policy is enabled, in which
  // case it also inserts a Claim_Row (a single `INSERT ... RETURNING
  // id` against the shared `pool`, no transaction) -- still strictly
  // before Phase 1's Authentik user-creation call, so a
  // CallsignSuffixRequiredError/CallsignSuffixConflictError/
  // OrganisationPrefixMissingError here is a request-validation failure
  // returned before any Authentik user (or Claim_Row adoption) is
  // created. A ManagedIdentifierExhaustionError names a defect in the
  // generator's random source rather than something the caller can fix,
  // so it maps to 500 rather than 400. ---
  let resolvedUsername;
  let resolvedCallsignSuffix;
  let claimId;
  try {
    const identity = await UserProvisioningService.resolveNewUserIdentity(null, {
      firstName,
      lastName,
      email,
      teamId,
      requestedUsername: email,
      requestedCallsignSuffix: callsignSuffix
    });
    resolvedUsername = identity.username;
    resolvedCallsignSuffix = identity.callsignSuffix;
    claimId = identity.claimId;
  } catch (resolutionError) {
    if (
      resolutionError instanceof UserProvisioningService.CallsignSuffixRequiredError ||
      resolutionError instanceof CallsignSuffixConflictError ||
      resolutionError instanceof ManagedIdentifierService.OrganisationPrefixMissingError
    ) {
      return res.status(400).json({ error: resolutionError.message });
    }
    if (resolutionError instanceof ManagedIdentifierService.ManagedIdentifierExhaustionError) {
      getLogger().error({ err: resolutionError }, 'Managed_Identifier mint exhausted while creating user');
      return res.status(500).json({ error: 'Failed to create user' });
    }
    getLogger().error({ err: resolutionError }, 'Failed to resolve callsign_suffix for new user');
    return res.status(500).json({ error: 'Failed to create user' });
  }

  // --- Phase 1: Authentik user creation (no open DB transaction). ---
  try {
    const existingUserResponse = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
    });
    const existingUsers = await existingUserResponse.json();

    if (existingUsers.results && existingUsers.results.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const createUserResponse = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: resolvedUsername,
        email,
        name: `${firstName} ${lastName}`,
        first_name: firstName,
        last_name: lastName,
        is_active: true
      })
    });

    if (!createUserResponse.ok) {
      const errorData = await createUserResponse.json();
      return res.status(400).json({ error: 'Failed to create user in Authentik', details: errorData });
    }

    newUser = await createUserResponse.json();
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to create user in Authentik');
    return res.status(500).json({ error: 'Failed to create user' });
  }

  // --- Phase 2: single transaction for every local database write. ---
  const client = await pool.connect();
  let localUserId;
  try {
    await client.query('BEGIN');

    const result = await UserProvisioningService.createAndAddUser(client, {
      authentikUserId: newUser.pk,
      username: resolvedUsername,
      email,
      firstName,
      lastName,
      teamId,
      callsign_suffix: resolvedCallsignSuffix,
      createdBy: req.user?.userId ?? null,
      // takserver-enrollment Requirement 6.6 (task 5.3): when the
      // target Organisation is pseudonymous, `claimId` names the
      // Claim_Row `resolveNewUserIdentity` already inserted under
      // `resolvedUsername` above -- `createAndAddUser` adopts that
      // exact row instead of its generic upsert, which cannot match a
      // Claim_Row's NULL `authentik_user_id` under `ON CONFLICT`.
      // `undefined` (the default, per `createAndAddUser`'s own
      // `claimId = null`) for a policy-disabled Organisation, where no
      // Claim_Row exists.
      claimId
    });
    localUserId = result.localUserId;

    // If role is 'admin', promote the membership row that createAndAddUser
    // just created from 'member' to 'admin'.
    if (role === 'admin') {
      await client.query(
        'UPDATE team_memberships SET role = $3 WHERE team_id = $1 AND user_id = $2 AND inherited_from_team_id IS NULL',
        [teamId, localUserId, 'admin']
      );

      // Re-reconcile the CloudTAK Agency group's Direct_Admin_Set for this
      // Team. Enqueued on the same transactional client so it commits/rolls
      // back atomically with the promotion above (Requirement 9.2). Guarded
      // by the enablement flag so nothing enqueues when CloudTAK is off.
      if (isCloudTakEnabled()) {
        await EventPublisher.publishOperation(
          'update_cloudtak_group',
          { team_id: teamId },
          req.user?.userId ?? null,
          client
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    getLogger().error({ err: error, authentikUserId: newUser.pk }, 'Failed to provision user locally after Authentik user creation');

    // --- Requirement 17.2 compensating action ---
    // The Authentik user (newUser.pk) was already created in Phase 1,
    // but every local write attempted in Phase 2 has just been rolled
    // back, so that Authentik user is now orphaned (it exists in
    // Authentik with no corresponding local `users` row,
    // `team_memberships`, or `channel_memberships`). Attempt a
    // SYNCHRONOUS delete of that Authentik user first; only if that
    // delete attempt itself fails do we fall back to enqueueing a
    // `cleanup_orphaned_authentik_user` Sync_Operation for the
    // Sync_Worker to retry asynchronously. Either outcome -- and the
    // (rare) case where even the enqueue fails -- is logged via the
    // structured logger with the exact `{authentikUserId, failedStep,
    // compensationOutcome}` shape called for by the task.
    const failedStep = 'local_transaction';
    let compensationOutcome;
    try {
      const deleteResponse = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${newUser.pk}/`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
      });

      if (deleteResponse.ok || deleteResponse.status === 404) {
        compensationOutcome = 'deleted_synchronously';
      } else {
        // Not a re-throw of the outer catch's local-provisioning failure
        // -- this is a new, unrelated error describing the Authentik
        // delete's own HTTP response, so the outer `error` is not
        // attached as this error's `cause`.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(`Authentik delete responded with status ${deleteResponse.status}`);
      }
    } catch (deleteError) {
      getLogger().error(
        { err: deleteError, authentikUserId: newUser.pk },
        'Synchronous compensating Authentik user delete failed; falling back to a queued cleanup operation'
      );
      try {
        await EventPublisher.publishOperation(
          'cleanup_orphaned_authentik_user',
          { authentik_user_id: newUser.pk },
          req.user?.userId ?? null
        );
        compensationOutcome = 'cleanup_operation_queued';
      } catch (enqueueError) {
        getLogger().error(
          { err: enqueueError, authentikUserId: newUser.pk },
          'Failed to enqueue cleanup_orphaned_authentik_user compensating operation'
        );
        compensationOutcome = 'compensation_failed';
      }
    }

    getLogger().error(
      { authentikUserId: newUser.pk, failedStep, compensationOutcome },
      'Orphaned Authentik user compensating action outcome'
    );

    return res.status(500).json({ error: 'Failed to create user' });
  } finally {
    client.release();
  }

  // --- Phase 3: best-effort callsign/attribute sync (Authentik call, run
  // only after the local transaction has committed). ---
  const attributes = await UserAttributesService.generateCallsign(localUserId, teamId);
  const pushAttrs = { ...(attributes || {}), firstName, lastName };
  await UserAttributesService.updateUserAttributes(newUser.pk, pushAttrs);

  // Update user cache (Requirement 11.1: user_cache.callsign_suffix
  // mirrors users.callsign_suffix, dual-written alongside the existing
  // tak_callsign/tak_color/tak_role dual-write here).
  await pool.query(
    'INSERT INTO user_cache (authentik_id, username, email, first_name, last_name, is_active, tak_callsign, tak_color, tak_role, callsign_suffix) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9) ON CONFLICT (authentik_id) DO UPDATE SET username = $2, email = $3, first_name = $4, last_name = $5, is_active = true, tak_callsign = $6, tak_color = $7, tak_role = $8, callsign_suffix = $9',
    [newUser.pk, resolvedUsername, email, firstName, lastName, attributes?.callsign, attributes?.color, attributes?.role, resolvedCallsignSuffix]
  );

  // Send welcome/approval email to the new user. Bugfix (silent
  // welcome-email failures): the account has already been fully created
  // by this point (Authentik, users, user_cache), and per this app's own
  // rule a failed/bounced email is never grounds to unwind that -- so a
  // send failure here must NOT roll back the response's success status.
  // What it must NOT do either, though, is disappear into only the
  // server log the way it previously did: `welcomeEmailSent` rides along
  // on the same 201 response so the caller (an admin who may have
  // fat-fingered the address) gets a chance to notice and follow up,
  // rather than believing the invite went out when it didn't.
  let welcomeEmailSent = true;
  try {
    const emailService = new EmailService();
    // Build team display path. Canonical Display_Name via
    // Team.getDisplayName ("FENZ - Manapouri" = root Org prefix + team
    // name). This replaces an inline path build that read the ancestor
    // chain in the WRONG order (getAncestorChain is root-first, so the
    // old `ancestors[length-1]` was the leaf team, not the root org).
    let teamPath = '';
    try {
      teamPath = (await Team.getDisplayName(teamId)) || '';
    } catch {
      // fallback
      const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [teamId]);
      if (teamResult.rows.length > 0) teamPath = teamResult.rows[0].name;
    }
    await emailService.sendApprovalEmail(email, {
      teamPath,
      username: email,
      callsign: attributes?.callsign || 'Will be assigned',
      firstName
    });
  } catch (emailErr) {
    getLogger().error({ err: emailErr }, 'Failed to send welcome email to new user');
    welcomeEmailSent = false;
  }

  res.status(201).json({
    user: {
      id: newUser.pk,
      // The RESOLVED username -- the minted Pseudonymous_Username under
      // a pseudonymous Organisation, or `email` verbatim otherwise --
      // matching what was actually created in Authentik and locally.
      username: resolvedUsername,
      email,
      first_name: firstName,
      last_name: lastName,
      // The suffix actually assigned (supplied value, or the computed
      // default), so the Client can report it rather than guess.
      callsign_suffix: resolvedCallsignSuffix
    },
    // Bugfix (silent welcome-email failures): true unless the
    // sendApprovalEmail call above threw. Only covers a failure visible
    // synchronously at send time (e.g. an SMTP-level rejection) -- an
    // asynchronous bounce reported later by the mail provider is a
    // separate, unaddressed gap.
    welcomeEmailSent
  });
});

// Add existing user to team
//
// Bugfix (Add Existing User onboarding): this is the ONLY step that turns
// a user who exists in Authentik but has never been touched by TAK Team
// Manager into a Team Manager-managed user, so it is also where an admin
// reviews and corrects that user's First Name/Last Name/Callsign Suffix
// before they're added -- values previously computed or imported blind,
// with no review step. `firstName`/`lastName`/`callsignSuffix` are all
// OPTIONAL: when omitted, this route's pre-existing behavior is preserved
// exactly (existing name kept as-is; a blank callsign_suffix is
// auto-defaulted, a non-blank one is left untouched). When supplied, they
// are validated and PERSISTED to this user's account (users/user_cache/
// Authentik), exactly like the Member_List inline-edit route's existing
// dual-write pattern -- this is a real, permanent correction to the
// user's account, not a one-off override for this team add alone.
router.post('/add-to-team', authenticateToken, authorize, [
  body('userId').notEmpty(),
  body('teamId').isInt(),
  body('firstName').optional().trim().isLength({ min: 1, max: 150 }),
  body('lastName').optional().trim().isLength({ min: 1, max: 150 }),
  body('callsignSuffix').optional().trim().custom(value => isValidCallsignSuffix(value))
    .withMessage('callsignSuffix may only contain letters, digits, "-", and "."')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId, teamId, firstName, lastName, callsignSuffix } = req.body;
    
    // Get user from user_cache
    const userResult = await pool.query(
      'SELECT authentik_id, username, email, first_name, last_name FROM user_cache WHERE authentik_id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];

    // Requirement (Add Existing User onboarding): the corrected name, if
    // supplied, is what gets seeded into `users`/pushed to Authentik below
    // -- the admin's review of this field takes precedence over whatever
    // user_cache mirrored in from Authentik's single `name` field.
    const effectiveFirstName = firstName !== undefined ? firstName : user.first_name;
    const effectiveLastName = lastName !== undefined ? lastName : user.last_name;
    
    // Ensure user exists in users table. On CONFLICT, first_name/last_name
    // are written ONLY when the admin actually supplied a correction here
    // (COALESCE against the existing stored value otherwise) -- matching
    // the same one-way-sync direction used in
    // server/services/authentikSync.js's syncSingleUser: the local `users`
    // table is the authoritative source for a real first/last name split
    // (set by UserProvisioningService.createAndAddUser and by the
    // Member_List inline-edit route), while user_cache's copy is only ever
    // a best-effort value derived from Authentik's single `name` field. An
    // unconditional overwrite here would re-clobber an already-established
    // local split via this second propagation path -- unless the admin
    // explicitly supplied a new value just now, which SHOULD win.
    await pool.query(
      `INSERT INTO users (authentik_user_id, username, email, first_name, last_name, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (authentik_user_id) DO UPDATE SET
         username = $2, email = $3, is_active = true,
         first_name = COALESCE($6, users.first_name),
         last_name = COALESCE($7, users.last_name)`,
      [user.authentik_id, user.username, user.email, effectiveFirstName, effectiveLastName, firstName, lastName]
    );
    
    // Get the local user ID
    const localUserResult = await pool.query(
      'SELECT id FROM users WHERE authentik_user_id = $1',
      [user.authentik_id]
    );
    
    const localUserId = localUserResult.rows[0].id;

    // Requirement (Add Existing User onboarding): an explicit
    // callsignSuffix correction is checked for uniqueness BEFORE any
    // write, so a conflicting value never reaches the database -- same
    // check, same exclude-self semantics, as the Member_List edit route
    // (`PATCH /api/teams/:teamId/members/:userId`).
    if (callsignSuffix !== undefined) {
      try {
        await checkCallsignSuffixUniqueness(teamId, callsignSuffix, localUserId);
      } catch (conflictError) {
        if (conflictError instanceof CallsignSuffixConflictError) {
          return res.status(400).json({ error: conflictError.message });
        }
        throw conflictError;
      }
    }
    
    // Check if user is already in a team (exclude inherited memberships)
    const existingMembership = await pool.query(
      'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
      [localUserId]
    );
    
    if (existingMembership.rows.length > 0) {
      return res.status(400).json({ error: 'User is already a member of another team' });
    }
    
    // Mirror an explicit name correction to user_cache too (same pattern
    // as the Member_List edit route) -- the `users` row was already
    // updated by the upsert above.
    if (firstName !== undefined) {
      await pool.query('UPDATE user_cache SET first_name = $1 WHERE authentik_id = $2', [firstName, user.authentik_id]);
    }
    if (lastName !== undefined) {
      await pool.query('UPDATE user_cache SET last_name = $1 WHERE authentik_id = $2', [lastName, user.authentik_id]);
    }

    // An explicit callsignSuffix correction is written BEFORE
    // TeamMembershipService.addUserToTeam runs, never after: that method
    // performs its OWN internal uniqueness check against whatever is
    // CURRENTLY stored in `users.callsign_suffix` (Requirement 11.18) --
    // writing the correction only after calling it would let a stale,
    // previously-stored suffix (e.g. from before this user was ever
    // reviewed) wrongly pass or fail that internal check instead of the
    // value actually being submitted here. An explicit correction always
    // overwrites any existing stored value (unlike the auto-default
    // branch below, which only ever fills in a BLANK suffix).
    if (callsignSuffix !== undefined) {
      await pool.query('UPDATE users SET callsign_suffix = $1 WHERE id = $2', [callsignSuffix, localUserId]);
      await pool.query('UPDATE user_cache SET callsign_suffix = $1 WHERE authentik_id = $2', [callsignSuffix, user.authentik_id]);
    }
    
    // req.user.userId is already the local users.id (see
    // server/middleware/auth.js) -- no separate lookup by Authentik id is
    // needed here.
    const requestingUserId = req.user.userId;
    
    // Use new service layer for team assignment
    const result = await TeamMembershipService.addUserToTeam(localUserId, teamId, 'member', requestingUserId);

    if (callsignSuffix === undefined) {
      // Ensure the user has a callsign_suffix before generating the full callsign.
      // If the user already has one (from prior provisioning or Member_List edit),
      // this is a no-op. If they don't, compute and store a default.
      //
      // Bugfix: this used to call `UserProvisioningService.resolveCallsignSuffixForNewUser`,
      // a method removed in favor of `resolveNewUserIdentity` (see that
      // service's doc comment). Every call here therefore threw a
      // `TypeError`, caught and only logged below -- silently leaving
      // `callsign_suffix` blank on every existing-user add whose user had
      // no prior suffix, with no error ever surfaced to the caller. Fixed
      // by routing through `UserProvisioningService.resolveNewUserIdentity`
      // itself -- the ONE allowed caller of
      // `CallsignService.computeDefaultCallsignSuffix`
      // (`newUserIdentityChokePoint.test.js`'s Assertion 2 allow-list; a
      // second direct caller here would be exactly the choke-point drift
      // that guard exists to catch). `requestedUsername`/`email` are passed
      // `undefined` and its resolved `username` is discarded -- this
      // existing user's identity is never re-minted -- but its
      // policy-disabled branch's Callsign_Suffix computation (and its own
      // `checkCallsignSuffixUniqueness` call) is exactly what's needed
      // here. Under a Pseudonymous_Organisation with no explicit value
      // supplied here, Callsign_Default_Suppression applies and the
      // resolver throws `CallsignSuffixRequiredError` BEFORE attempting to
      // mint anything -- caught below as non-fatal, same as a suffix
      // conflict.
      const suffixCheck = await pool.query('SELECT callsign_suffix, first_name, last_name FROM users WHERE id = $1', [localUserId]);
      if (suffixCheck.rows.length > 0 && !suffixCheck.rows[0].callsign_suffix) {
        try {
          const identity = await UserProvisioningService.resolveNewUserIdentity(null, {
            firstName: suffixCheck.rows[0].first_name || user.first_name || '',
            lastName: suffixCheck.rows[0].last_name || user.last_name || '',
            email: undefined,
            teamId,
            requestedUsername: undefined,
            requestedCallsignSuffix: undefined
          });
          const resolvedSuffix = identity.callsignSuffix;
          if (resolvedSuffix) {
            await pool.query('UPDATE users SET callsign_suffix = $1 WHERE id = $2', [resolvedSuffix, localUserId]);
            // Also mirror to user_cache
            await pool.query('UPDATE user_cache SET callsign_suffix = $1 WHERE authentik_id = $2', [resolvedSuffix, user.authentik_id]);
          }
        } catch (suffixErr) {
          if (suffixErr instanceof CallsignSuffixConflictError) {
            // A computed default happened to collide with an existing
            // member's suffix in this team -- non-fatal, matching this
            // route's existing "log and proceed, callsign lacks a name
            // segment" behavior rather than blocking the membership add
            // over an auto-computed value the caller never typed.
            getLogger().warn(
              { teamId, localUserId, conflictingValue: suffixErr.conflictingValue },
              'Computed default callsign_suffix conflicts with an existing member; leaving callsign_suffix blank for existing user add'
            );
          } else if (suffixErr instanceof UserProvisioningService.CallsignSuffixRequiredError) {
            // Callsign_Default_Suppression applies (Pseudonymous_Organisation)
            // and no explicit value was supplied -- non-fatal, the
            // callsign lacks a name segment until an admin sets one via
            // the Member_List edit form.
            getLogger().warn(
              { teamId, localUserId },
              'Callsign_Default_Suppression applies for this Organisation; leaving callsign_suffix blank for existing user add'
            );
          } else {
            // Non-fatal: log and proceed — the callsign will just lack a name segment
            getLogger().error({ err: suffixErr }, 'Failed to compute default callsign_suffix for existing user');
          }
        }
      }
    }

    // Update user callsign and color
    const attributes = await UserAttributesService.generateCallsign(localUserId, teamId);
    // A corrected name is pushed to Authentik alongside the recomputed
    // callsign/color -- same combined-PATCH shape `create-and-add` and
    // the Member_List edit route already use, so a name correction and a
    // callsign recompute cannot race each other into two separate PATCHes.
    const pushAttrs = { ...(attributes || {}) };
    if (firstName !== undefined) pushAttrs.firstName = firstName;
    if (lastName !== undefined) pushAttrs.lastName = lastName;
    if (attributes || firstName !== undefined || lastName !== undefined) {
      await UserAttributesService.updateUserAttributes(user.authentik_id, pushAttrs);
    }
    if (attributes) {
      // Update user cache
      await pool.query(
        'UPDATE user_cache SET tak_callsign = $1, tak_color = $2, tak_role = $3 WHERE authentik_id = $4',
        [attributes.callsign, attributes.color, attributes.role, user.authentik_id]
      );
    }

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'user.add_to_team', 'team', teamId, JSON.stringify({ addedUserId: localUserId })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }
    
    res.json({ 
      message: 'User added to team successfully',
      operationsQueued: result.groupsQueued
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to add user to team');
    res.status(500).json({ error: 'Failed to add user to team' });
  }
});

// Remove user from team
router.delete('/remove-from-team/:userId', authenticateToken, authorize, [
  body('teamId').isInt()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { userId } = req.params;
    
    // Get user's Authentik ID
    const userResult = await pool.query(
      'SELECT authentik_user_id FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const authentikUserId = userResult.rows[0].authentik_user_id;
    
    // req.user.userId is already the local users.id -- see comment on the
    // add-to-team route above.
    const requestingUserId = req.user.userId;
    
    // Use new service layer for team removal. `removeUserFromTeam`
    // unconditionally deletes EVERY team_memberships row for this user
    // (no team_id filter), and this app enforces at most one direct team
    // per user, so this call always leaves the user with zero teams --
    // its "no teams left" branch always fires here, meaning a
    // `revoke_tak_certificates` operation is always enqueued for this
    // delete (never skipped because the user "still had another team").
    const result = await TeamMembershipService.removeUserFromTeam(userId, requestingUserId);

    // Bugfix (silent revoke-disarmed outcome): the certificate revoke
    // enqueued above is always processed ASYNCHRONOUSLY by the sync
    // worker, and -- independent of that -- completes as a no-op
    // Revoke_Dry_Run whenever DEVICE_MGMT_REVOKE_ENABLED is not the exact
    // string 'true' (per that flag's own arming contract). Neither of
    // those facts changes what THIS route does (the account is deleted
    // either way), but an admin who just permanently deleted a user has
    // no way to know their TAK Server certificates were never actually
    // revoked unless that outcome is recorded somewhere inspectable.
    // Recorded here, at enqueue time, rather than waiting on the worker,
    // since the flag's value is already fully known now and doesn't
    // change between enqueue and drain.
    const certificateRevocationDryRun = !isDeviceMgmtRevokeEnabled();

    // Clear TAK attributes in Authentik and deactivate the user
    await UserAttributesService.clearUserAttributes(authentikUserId);

    // Bugfix (silent Authentik-delete failure): a failed/unreachable
    // delete call previously only got logged, and local rows were
    // deleted anyway -- leaving a fully intact, loginable Authentik
    // account with no record that anything went wrong. Mirrors the
    // create-and-add route's own compensating-action pattern: a
    // non-2xx/non-404 response (404 means the account is already gone,
    // not a failure) falls back to enqueueing `cleanup_orphaned_authentik_user`
    // so the Sync_Worker retries the delete asynchronously, and the
    // outcome is recorded rather than silently assumed.
    let authentikAccountDeleted = true;
    try {
      const deleteResponse = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}`
        }
      });

      if (!deleteResponse.ok && deleteResponse.status !== 404) {
        throw new Error(`Authentik delete responded with status ${deleteResponse.status}`);
      }
    } catch (deleteErr) {
      getLogger().error({ err: deleteErr }, 'Failed to delete user from Authentik');
      authentikAccountDeleted = false;

      try {
        await EventPublisher.publishOperation(
          'cleanup_orphaned_authentik_user',
          { authentik_user_id: authentikUserId },
          req.user.userId
        );
      } catch (enqueueErr) {
        getLogger().error(
          { err: enqueueErr, authentikUserId },
          'Failed to enqueue cleanup_orphaned_authentik_user compensating operation'
        );
      }
    }

    // Delete user from local system entirely
    await pool.query('DELETE FROM user_cache WHERE authentik_id = $1', [String(authentikUserId)]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [
          req.user.userId,
          'user.remove_from_team',
          'user',
          parseInt(req.params.userId, 10),
          JSON.stringify({ authentikAccountDeleted, certificateRevocationDryRun })
        ]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }
    
    res.json({ 
      message: 'User removed from team successfully',
      operationsQueued: result.groupsQueued,
      authentikAccountDeleted,
      certificateRevocationDryRun
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to remove user from team');
    res.status(500).json({ error: 'Failed to remove user from team' });
  }
});


// ---------------------------------------------------------------------
// Team_Transfer -- POST /api/users/:userId/transfer
// (Requirements 1, 2, 3, 9.1, 10.2, 10.3 of team-member-transfer)
// ---------------------------------------------------------------------

/**
 * Requirement 3.7's message, shared by the pre-flight `SELECT` below and
 * by the `23505` mapping, so both mechanisms are indistinguishable to a
 * caller: whichever one fires, a pending Transfer_Request already exists
 * for that user and the caller must resolve it through approval or denial.
 */
const PENDING_TRANSFER_CONFLICT_MESSAGE =
  'A team transfer is already pending approval for this user';

/**
 * The partial unique index (`existing_user_id` WHERE `status = 'pending'
 * AND request_type = 'team_change'`) that backs Requirement 3.7 at the
 * database level. The pre-flight `SELECT` is racy against a concurrent
 * Transfer_Request creation on its own; this index closes that window for
 * the path that actually inserts a row.
 */
const PENDING_TRANSFER_UNIQUE_INDEX = 'idx_access_requests_one_pending_team_change_per_user';

/**
 * True for the unique-violation raised by
 * `idx_access_requests_one_pending_team_change_per_user`, which
 * Requirement 3.7 maps to the same 409 as the pre-flight check.
 *
 * `error.constraint` carries the index name for a unique-INDEX violation
 * (as opposed to a named unique CONSTRAINT); the message check is a
 * belt-and-braces fallback for a driver or Postgres version that omits
 * the field.
 *
 * @param {Error & {code?: string, constraint?: string}} error
 * @returns {boolean}
 */
function isPendingTransferConflict(error) {
  if (!error || error.code !== '23505') {
    return false;
  }

  return error.constraint === PENDING_TRANSFER_UNIQUE_INDEX
    || String(error.message || '').includes(PENDING_TRANSFER_UNIQUE_INDEX);
}

/**
 * The single place the transfer route turns a typed error into a status
 * code, per design.md's "typed error carries the data the response needs,
 * route shapes the response" convention and its status-code mapping table.
 *
 * Every one of these errors already carries a caller-appropriate message
 * (`CallsignSuffixConflictError`'s names the conflicting value, which is
 * Requirement 9.1), so the message is passed through rather than
 * rewritten here -- one source of truth per condition.
 *
 * `CrossOrganisationTransferError` maps to 400 on THIS path only
 * (Requirement 1.7, a caller mistake at request time); the approval path
 * maps the same error to 409, because there it means a Team was reparented
 * under a pending Transfer_Request (Requirement 11.6).
 *
 * `StaleTransferRequestError` is deliberately absent: it can only be
 * thrown when `expectedSourceTeamId` is supplied, which this path never
 * does (it has no Transfer_Request to be stale against).
 *
 * @param {Error} error
 * @returns {{status: number, error: string}|null} null when the error is
 *   not one this route has a specified status code for, so the caller
 *   falls through to logging it and returning 500.
 */
function transferErrorResponse(error) {
  if (
    error instanceof SelfTransferError            // Requirement 1.8
    || error instanceof NoCurrentTeamError        // Requirement 1.4
    || error instanceof AlreadyInDestinationTeamError // Requirement 1.5
    || error instanceof CrossOrganisationTransferError // Requirement 1.7
    || error instanceof CallsignSuffixConflictError    // Requirement 9.1
  ) {
    return { status: 400, error: error.message };
  }

  if (isPendingTransferConflict(error)) {              // Requirement 3.7
    return { status: 409, error: PENDING_TRANSFER_CONFLICT_MESSAGE };
  }

  return null;
}

/**
 * A Team's hierarchy path for an API response field, using the same
 * `callsign_prefix || name` segment mapping and `' > '` join already used
 * by `GET /api/requests/pending`'s `team_path`. (The transfer
 * NOTIFICATION email joins with `' - '` instead, matching the other
 * emails `RequestApprovalService` sends -- the two conventions are
 * deliberately kept, one for API fields and one for email copy.)
 *
 * @param {Array<{name: string, callsign_prefix: string|null}>} ancestorChain
 *   root-first, as returned by `Team.getAncestorChain`.
 * @returns {string}
 */
function formatTeamPathForResponse(ancestorChain) {
  return ancestorChain
    .map((team, index) => (index === ancestorChain.length - 1 ? team.name : team.callsign_prefix || team.name))
    .join(' > ');
}

/**
 * Requirement 1.1: move an existing user's Direct_Membership to another
 * Team without deleting the account -- the non-destructive counterpart to
 * `DELETE /api/users/remove-from-team/:userId`, which deletes the
 * Authentik user and the local `users`/`user_cache` rows outright and so
 * destroys a federated identity (Requirement 1.6).
 *
 * Authorization is the `user:team:transfer` row-scoped resolver
 * (Requirements 2.1-2.3): Global_Manager, or a Team_Admin of EITHER side.
 * It therefore runs before every check below, so a 403 precedes every 4xx
 * here. One consequence worth naming: a transfer requested for a user with
 * no Direct_Membership by an admin of the target team returns 400 (the
 * resolver grants on the target-team leg), while the same request from an
 * unrelated admin returns 403. That precedence is standard and intended.
 *
 * The handler's step order is fixed by design.md, chosen so that each
 * requirement's specified status code is actually reachable. Steps 1-7 run
 * outside any transaction and are pre-flight status shaping only;
 * `executeTransfer` re-asserts steps 5's and 6's preconditions under a
 * `FOR UPDATE` row lock, which is the authoritative, race-free check.
 * That duplication is intentional.
 */
router.post('/:userId/transfer', authenticateToken, authorize, [
  body('targetTeamId').isInt({ min: 1 }).toInt(),
  body('justification').optional().trim().isLength({ max: 500 }),
  body('callsignSuffix').optional().trim().isLength({ max: 255 })
], async (req, res) => {
  const transferredUserId = Number(req.params.userId);
  // req.user.userId is the LOCAL users.id (see server/middleware/auth.js),
  // never req.user.id (the Authentik id) -- every comparison and every
  // column written below is in local-id space.
  const actorId = req.user.userId;
  const actorIsGlobalManager = !!req.user.is_global_manager;

  try {
    // --- Step 1: the Transferred_User must exist (Requirement 1.3). ---
    // A non-numeric `:userId` names no `users` row either, and is answered
    // with the same 404 rather than being handed to Postgres as an invalid
    // integer literal.
    if (!Number.isInteger(transferredUserId) || transferredUserId < 1) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userResult = await pool.query(
      'SELECT id, first_name, last_name, email, is_team_device FROM users WHERE id = $1',
      [transferredUserId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // --- Step 2: no self-transfer (Requirement 1.8). ---
    // Placed here, immediately after the existence lookup, because it is a
    // pure integer comparison needing no query and because Requirement 1.8
    // admits NO Global_Manager exemption -- nothing later in this order
    // could change the verdict. A self-transfer would demote the acting
    // user (Requirement 10.1) and could strip the Source_Team of its last
    // Team_Admin, and the acting user cannot be a disinterested
    // Approval_Team for their own move.
    if (transferredUserId === actorId) {
      throw new SelfTransferError(actorId);
    }

    // --- Step 3: body validation (Requirement 1.1). ---
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const targetTeamId = req.body.targetTeamId;

    // --- Step 4: the Destination_Team must exist. ---
    // Requirement 1.2 specifies 400 here, NOT 404: an unknown
    // `targetTeamId` is a bad body field, whereas the 404 of step 1 is an
    // unknown addressed resource.
    const teamResult = await pool.query('SELECT id FROM teams WHERE id = $1', [targetTeamId]);

    if (teamResult.rows.length === 0) {
      return res.status(400).json({ error: 'Target team not found' });
    }

    // --- Step 5: the Direct_Membership preconditions (Requirements 1.4, 1.5). ---
    const membershipResult = await pool.query(
      'SELECT team_id, role FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
      [transferredUserId]
    );

    if (membershipResult.rows.length === 0) {
      throw new NoCurrentTeamError(transferredUserId);
    }

    const sourceTeamId = membershipResult.rows[0].team_id;
    // Requirements 10.2/10.3 speak of a transfer being INITIATED, not
    // completed, so `demotedFromAdmin` is reported on the 202 response as
    // well as the 200 one. On the 200 path it comes off the outcome, which
    // read the same role under the row lock.
    const demotedFromAdmin = membershipResult.rows[0].role === 'admin';

    if (sourceTeamId === targetTeamId) {
      throw new AlreadyInDestinationTeamError(transferredUserId, targetTeamId);
    }

    // --- Step 6: the Organisation boundary (Requirement 1.7). ---
    // `Team.getAncestorChain` is root-first, so index 0 is the
    // Organisation. Both chains are reused below -- the destination one for
    // the 200 response's `destinationTeamPath`, whichever one names the
    // Approval_Team for the 202 response's `approvalTeamName` -- so this
    // costs no query beyond the check itself.
    const [sourceChain, destinationChain] = await Promise.all([
      Team.getAncestorChain(sourceTeamId),
      Team.getAncestorChain(targetTeamId)
    ]);

    if (sourceChain[0].id !== destinationChain[0].id && !actorIsGlobalManager) {
      throw new CrossOrganisationTransferError(sourceChain[0].id, destinationChain[0].id);
    }

    // --- Step 7: one pending Transfer_Request per user (Requirement 3.7). ---
    // This step MUST stay ABOVE the Dual_Admin branch of step 8. Requirement
    // 3.7 applies "regardless of whether the Initiating_Admin is a
    // Dual_Admin", so moving this below that branch would let a Dual_Admin
    // silently execute a transfer while a Transfer_Request for the same user
    // sat pending, and would make Requirement 3.7's 409 reachable on only
    // one of the two paths. The pending row is left exactly as it is -- there
    // is no `superseded` disposition, because it carries a justification and
    // an outstanding Approval_Team decision.
    const pendingResult = await pool.query(
      `SELECT id
         FROM access_requests
        WHERE request_type = 'team_change'
          AND status = 'pending'
          AND existing_user_id = $1`,
      [transferredUserId]
    );

    if (pendingResult.rows.length > 0) {
      return res.status(409).json({ error: PENDING_TRANSFER_CONFLICT_MESSAGE });
    }

    // --- Step 8: Dual_Admin determination (Requirements 2.4, 2.5, 2.6). ---
    // `Team.isAdmin` is what makes Requirement 2.6 hold: a Team_Admin of any
    // Team in either side's Ancestor_Chain counts as an admin of that side.
    // Both legs are skipped for a Global_Manager, who is a Dual_Admin by
    // definition and for whom neither leg's answer is used.
    let initiatorAdminsSource = false;
    let initiatorAdminsDestination = false;

    if (!actorIsGlobalManager) {
      initiatorAdminsSource = await Team.isAdmin(sourceTeamId, actorId);
      initiatorAdminsDestination = await Team.isAdmin(targetTeamId, actorId);
    }

    const isDualAdmin = actorIsGlobalManager || (initiatorAdminsSource && initiatorAdminsDestination);

    // --- Step 9a: immediate execution (Requirement 2.4). ---
    if (isDualAdmin) {
      const client = await pool.connect();
      let outcome;

      try {
        await client.query('BEGIN');

        // `requestCallsignSuffix` is null by construction on this path:
        // there is no Transfer_Request, so link (b) of Requirement 9.7's
        // precedence chain is absent and the chain falls through from the
        // submitted value to the user's stored one.
        outcome = await TeamTransferService.executeTransfer(client, {
          userId: transferredUserId,
          destinationTeamId: targetTeamId,
          actorId,
          actorIsGlobalManager,
          callsignSuffix: req.body.callsignSuffix || null,
          requestCallsignSuffix: null
        });

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        // Rethrown for the handler's single error-mapping catch below, so
        // every typed transfer error is shaped in exactly one place.
        throw error;
      } finally {
        client.release();
      }

      // Requirements 8.4, 13.4, 14.4: callsign, `user_cache`, the Authentik
      // push, the notification, and the audit row all happen strictly after
      // COMMIT. `applyPostCommitEffects` never throws -- each of its steps
      // is independently failure-tolerant -- so a failure there leaves the
      // committed membership change in place and this response at 200.
      const effects = await TeamTransferService.applyPostCommitEffects(outcome);

      return res.json({
        status: 'completed',
        demotedFromAdmin: outcome.demotedFromAdmin,
        callsign: effects.callsign,
        destinationTeamPath: formatTeamPathForResponse(destinationChain),
        revokedChannelCount: outcome.revokedChannelIds.length
      });
    }

    // --- Step 9b: create a Transfer_Request (Requirements 2.5, 3). ---
    // Requirement 3.3: the Approval_Team is the side the initiator does NOT
    // administer. Reaching here means the initiator is not a Global_Manager
    // and administers exactly one side -- the resolver granted the request,
    // so at least one leg is true, and step 8 established they are not both.
    const approvalTeamId = initiatorAdminsDestination ? sourceTeamId : targetTeamId;
    const approvalChain = initiatorAdminsDestination ? sourceChain : destinationChain;
    const approvalTeamName = approvalChain[approvalChain.length - 1].name;

    // Requirement 3.4: `requester_*` are the INITIATING_ADMIN's own values,
    // not the Transferred_User's. That is what makes the existing approval
    // and denial emails sent by `RequestApprovalService` reach the person who
    // asked for the transfer with no change to either email path. The
    // Transferred_User's own notification is a separate email sent by
    // `applyPostCommitEffects`, and the two recipients never coincide --
    // Requirement 1.8 forbids a self-transfer.
    const initiatorResult = await pool.query(
      'SELECT email, first_name, last_name FROM users WHERE id = $1',
      [actorId]
    );
    const initiator = initiatorResult.rows[0] || {};

    // Requirement 3.6: one user holding a DIRECT `role = 'admin'` row for
    // the Approval_Team, or NULL when it has none. Selected on `role =
    // 'admin'` only -- the `role IN ('admin', 'owner')` predicate in
    // `RequestApprovalService` and `EscalationService` is dead defensive
    // code (nothing writes `'owner'`, no row holds it, no CHECK admits it)
    // and is deliberately not propagated here. Ordered by `user_id` rather
    // than `RANDOM()` so the choice is reproducible.
    const assignedAdminResult = await pool.query(
      `SELECT user_id
         FROM team_memberships
        WHERE team_id = $1
          AND role = 'admin'
          AND inherited_from_team_id IS NULL
        ORDER BY user_id ASC
        LIMIT 1`,
      [approvalTeamId]
    );

    // Requirement 3.5: `email_verified` is `true` and NO verification email
    // is sent -- the Initiating_Admin's identity is already established by
    // the authenticated session, and the row must be visible to
    // `GET /api/requests/pending`, which filters on `email_verified`.
    // `escalates_at` is deliberately left NULL: a Transfer_Request is
    // addressed to a specific Approval_Team rather than escalated up the
    // new-account chain.
    const insertResult = await pool.query(
      `INSERT INTO access_requests (
         request_type, requester_email, requester_first_name, requester_last_name,
         existing_user_id, current_team_id, target_team_id, approval_team_id,
         initiated_by, assigned_to_admin, justification, callsign_suffix,
         status, email_verified
       ) VALUES ('team_change', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', true)
       RETURNING id`,
      [
        initiator.email || req.user.email || null,
        initiator.first_name ?? req.user.first_name ?? null,
        initiator.last_name ?? req.user.last_name ?? null,
        transferredUserId,
        sourceTeamId,
        targetTeamId,
        approvalTeamId,
        actorId,
        assignedAdminResult.rows[0]?.user_id ?? null,
        req.body.justification || null,
        req.body.callsignSuffix || null
      ]
    );

    return res.status(202).json({
      status: 'pending_approval',
      requestId: insertResult.rows[0].id,
      demotedFromAdmin,
      approvalTeamId,
      approvalTeamName
    });
  } catch (error) {
    const mapped = transferErrorResponse(error);

    if (mapped) {
      return res.status(mapped.status).json({ error: mapped.error });
    }

    getLogger().error(
      { err: error, transferredUserId: req.params.userId, targetTeamId: req.body?.targetTeamId },
      'Failed to transfer user to another team'
    );

    return res.status(500).json({ error: 'Failed to transfer user' });
  }
});

/**
 * account-lifecycle-management Requirement 1 Criteria 1-5: suspend an
 * `account_status = 'active'` account (human or Team_Owned_Device).
 * Authorization is the `user:suspend` row-scoped resolver (Global_Manager,
 * or an admin of the target's Direct_Membership team) -- see that
 * resolver's doc comment in `server/middleware/authorize.js`.
 *
 * Thin route: all business logic (the row lock, the state-transition
 * validation, the Revoke_Operation enqueue, the audit write, and the
 * post-commit Authentik PATCH) lives in `AccountLifecycleService
 * .suspendAccount`. This handler's only job is mapping that call's named
 * errors to the response shape Requirement 1 specifies.
 */
router.post('/:userId/suspend', authenticateToken, authorize, async (req, res) => {
  const targetUserId = Number(req.params.userId);

  if (!Number.isInteger(targetUserId) || targetUserId < 1) {
    return res.status(404).json({ error: 'User not found' });
  }

  try {
    const result = await AccountLifecycleService.suspendAccount(targetUserId, req.user);
    return res.json(result);
  } catch (error) {
    if (error instanceof TargetUserNotFoundError) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (error instanceof AccountAlreadySuspendedError || error instanceof AccountOrphanedError) {
      return res.status(400).json({ error: error.message });
    }

    getLogger().error({ err: error, targetUserId }, 'Failed to suspend account');
    return res.status(500).json({ error: 'Failed to suspend account' });
  }
});

/**
 * account-lifecycle-management Requirement 1 Criteria 6-10: unsuspend an
 * `account_status = 'suspended'` account. Same authorization rule and
 * thin-route shape as the suspend route above; business logic lives in
 * `AccountLifecycleService.unsuspendAccount`.
 */
router.post('/:userId/unsuspend', authenticateToken, authorize, async (req, res) => {
  const targetUserId = Number(req.params.userId);

  if (!Number.isInteger(targetUserId) || targetUserId < 1) {
    return res.status(404).json({ error: 'User not found' });
  }

  try {
    const result = await AccountLifecycleService.unsuspendAccount(targetUserId, req.user);
    return res.json(result);
  } catch (error) {
    if (error instanceof TargetUserNotFoundError) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (error instanceof AccountOrphanedError || error instanceof AccountNotSuspendedError) {
      return res.status(400).json({ error: error.message });
    }

    getLogger().error({ err: error, targetUserId }, 'Failed to unsuspend account');
    return res.status(500).json({ error: 'Failed to unsuspend account' });
  }
});

/**
 * bulk-actions: the shared core of `POST /:userId/resend-welcome`, so the
 * single-item route and `POST /bulk-resend-welcome` below send the
 * IDENTICAL email with no duplicated logic. Throws on a missing user
 * (`userId` names no `users` row) -- both call sites map that to a 404
 * (single-item) or a per-row failure (bulk).
 *
 * @param {number|string} userId
 * @param {number|string|null} teamId
 * @param {number|null} actingUserId - for the audit_logs row.
 * @returns {Promise<{email: string}>}
 */
async function sendWelcomeEmailToUser(userId, teamId, actingUserId) {
  const userResult = await pool.query(
    'SELECT u.id, u.email, u.first_name, u.last_name, uc.tak_callsign FROM users u LEFT JOIN user_cache uc ON uc.authentik_id = u.authentik_user_id::text WHERE u.id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) {
    const notFound = new Error('User not found');
    notFound.name = 'ResendWelcomeUserNotFoundError';
    throw notFound;
  }
  const user = userResult.rows[0];

  // Canonical Display_Name via Team.getDisplayName ("FENZ - Manapouri").
  // Replaces an inline path build that read the ancestor chain in the
  // wrong order (see the matching fix in the create-and-add handler above).
  let teamPath = '';
  if (teamId) {
    try {
      teamPath = (await Team.getDisplayName(teamId)) || '';
    } catch {
      const teamResult = await pool.query('SELECT name FROM teams WHERE id = $1', [teamId]);
      if (teamResult.rows.length > 0) teamPath = teamResult.rows[0].name;
    }
  }

  const emailService = new EmailService();
  await emailService.sendApprovalEmail(user.email, {
    teamPath,
    username: user.email,
    callsign: user.tak_callsign || 'Will be assigned',
    firstName: user.first_name || ''
  });

  try {
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
      [actingUserId, 'user.resend_welcome', 'user', parseInt(userId, 10), JSON.stringify({ email: user.email })]
    );
  } catch (auditErr) {
    getLogger().error({ err: auditErr }, 'Failed to write audit log');
  }

  return { email: user.email };
}

// Resend welcome/approval email to user
router.post('/:userId/resend-welcome', authenticateToken, authorize, async (req, res) => {
  try {
    const { userId } = req.params;
    const { teamId } = req.body;
    await sendWelcomeEmailToUser(userId, teamId, req.user.userId);
    res.json({ message: 'Welcome email resent successfully' });
  } catch (error) {
    if (error.name === 'ResendWelcomeUserNotFoundError') {
      return res.status(404).json({ error: 'User not found' });
    }
    getLogger().error({ err: error }, 'Failed to resend welcome email');
    res.status(500).json({ error: 'Failed to resend welcome email' });
  }
});

// ---------------------------------------------------------------------
// Bulk member-action endpoints (Orgs & Teams multi-select).
//
// Every route below accepts `{ userIds: number[] }` (plus whatever extra
// fields the single-item counterpart needs) and returns
// `{ successCount, failureCount, results: [{userId, success, ...}] }`,
// mirroring `BulkImportService`'s own per-row result-array convention --
// never an all-or-nothing transaction, so one row's failure never affects
// any other row's outcome.
//
// None of these routes has a `:userId`/`:teamId` URL param for the
// Authorization_Middleware's row-scoped resolvers to key on (the subject
// is an ARRAY), so each route's Permission_Registry identifier is
// deliberately COARSE ("is this caller an admin of *something*, or a
// Global_Manager" -- the same shape `user:read:team_admin`'s resolver
// already uses for the same reason). The REAL per-row authorization is
// performed HERE, inside each loop, reusing the exact same primitive
// (`Team.isAdmin`) the corresponding single-item resolver in
// `authorize.js` uses -- an unauthorized row is recorded as that row's
// own failure, exactly like `BulkImportService.importUserRow`'s own
// per-row `Team.isAdmin` check, never a whole-batch 403. A client that
// already screened eligibility will see every row succeed in the normal
// case; this defensive re-check exists because a client-side screen is
// never trusted as the actual authorization boundary.
// ---------------------------------------------------------------------

function parseBulkUserIds(body) {
  if (!Array.isArray(body?.userIds) || body.userIds.length === 0) {
    return null;
  }
  const ids = body.userIds.map((id) => Number(id));
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) {
    return null;
  }
  return ids;
}

/**
 * Mirrors the `user:suspend` resolver's own check (`authorize.js`)
 * exactly: Global_Manager, or an admin of the target's Direct_Membership
 * team.
 */
async function isAuthorizedForSuspendAction(targetUserId, actorId, actorIsGlobalManager) {
  if (actorIsGlobalManager) {
    return true;
  }
  const membershipResult = await pool.query(
    'SELECT team_id FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
    [targetUserId]
  );
  const teamId = membershipResult.rows[0]?.team_id;
  if (teamId === undefined) {
    return false;
  }
  return Team.isAdmin(teamId, actorId);
}

router.post('/bulk-suspend', authenticateToken, authorize, async (req, res) => {
  const userIds = parseBulkUserIds(req.body);
  if (!userIds) {
    return res.status(400).json({ error: 'userIds must be a non-empty array of positive integers' });
  }

  const actorId = req.user.userId;
  const actorIsGlobalManager = !!req.user.is_global_manager;
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (const targetUserId of userIds) {
    try {
      const authorized = await isAuthorizedForSuspendAction(targetUserId, actorId, actorIsGlobalManager);
      if (!authorized) {
        results.push({ userId: targetUserId, success: false, error: 'You do not have permission to suspend this account' });
        failureCount++;
        continue;
      }
      const outcome = await AccountLifecycleService.suspendAccount(targetUserId, req.user);
      results.push({ userId: targetUserId, success: true, accountStatus: outcome.accountStatus });
      successCount++;
    } catch (error) {
      let message = 'Failed to suspend account';
      if (error instanceof TargetUserNotFoundError) {
        message = 'User not found';
      } else if (error instanceof AccountAlreadySuspendedError || error instanceof AccountOrphanedError) {
        message = error.message;
      } else {
        getLogger().error({ err: error, targetUserId }, 'Failed to bulk-suspend account');
      }
      results.push({ userId: targetUserId, success: false, error: message });
      failureCount++;
    }
  }

  res.json({ successCount, failureCount, results });
});

router.post('/bulk-unsuspend', authenticateToken, authorize, async (req, res) => {
  const userIds = parseBulkUserIds(req.body);
  if (!userIds) {
    return res.status(400).json({ error: 'userIds must be a non-empty array of positive integers' });
  }

  const actorId = req.user.userId;
  const actorIsGlobalManager = !!req.user.is_global_manager;
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (const targetUserId of userIds) {
    try {
      // 'user:suspend' covers both suspend AND unsuspend -- the same
      // authorization question asked twice, not two different
      // capabilities -- see that resolver's own doc comment.
      const authorized = await isAuthorizedForSuspendAction(targetUserId, actorId, actorIsGlobalManager);
      if (!authorized) {
        results.push({ userId: targetUserId, success: false, error: 'You do not have permission to unsuspend this account' });
        failureCount++;
        continue;
      }
      const outcome = await AccountLifecycleService.unsuspendAccount(targetUserId, req.user);
      results.push({ userId: targetUserId, success: true, accountStatus: outcome.accountStatus });
      successCount++;
    } catch (error) {
      let message = 'Failed to unsuspend account';
      if (error instanceof TargetUserNotFoundError) {
        message = 'User not found';
      } else if (error instanceof AccountOrphanedError || error instanceof AccountNotSuspendedError) {
        message = error.message;
      } else {
        getLogger().error({ err: error, targetUserId }, 'Failed to bulk-unsuspend account');
      }
      results.push({ userId: targetUserId, success: false, error: message });
      failureCount++;
    }
  }

  res.json({ successCount, failureCount, results });
});

router.post('/bulk-resend-welcome', authenticateToken, authorize, async (req, res) => {
  const userIds = parseBulkUserIds(req.body);
  if (!userIds) {
    return res.status(400).json({ error: 'userIds must be a non-empty array of positive integers' });
  }
  const { teamId } = req.body;
  const actorId = req.user.userId;
  const actorIsGlobalManager = !!req.user.is_global_manager;
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (const targetUserId of userIds) {
    try {
      // Mirrors the `user:resend_welcome:team_admin` resolver exactly:
      // Global_Manager, or an admin of at least one of the target's
      // current teams.
      let authorized = actorIsGlobalManager;
      if (!authorized) {
        const userTeams = await User.getTeamMemberships(targetUserId);
        for (const team of userTeams) {
          if (await Team.isAdmin(team.id, actorId)) {
            authorized = true;
            break;
          }
        }
      }
      if (!authorized) {
        results.push({ userId: targetUserId, success: false, error: 'You do not have permission to resend a welcome email to this account' });
        failureCount++;
        continue;
      }
      await sendWelcomeEmailToUser(targetUserId, teamId, actorId);
      results.push({ userId: targetUserId, success: true });
      successCount++;
    } catch (error) {
      const message = error.name === 'ResendWelcomeUserNotFoundError' ? 'User not found' : 'Failed to resend welcome email';
      if (error.name !== 'ResendWelcomeUserNotFoundError') {
        getLogger().error({ err: error, targetUserId }, 'Failed to bulk-resend welcome email');
      }
      results.push({ userId: targetUserId, success: false, error: message });
      failureCount++;
    }
  }

  res.json({ successCount, failureCount, results });
});

/**
 * Mirrors `POST /:userId/transfer`'s steps 1-9 (see that route's own doc
 * comment above) for exactly ONE user, but returns a `{status, error?,
 * body?}` result instead of writing to `res` directly, so
 * `POST /bulk-transfer` below can call it per row inside a try/catch
 * without one row's rejection aborting the batch. A thrown typed error
 * (`SelfTransferError`/`NoCurrentTeamError`/etc.) is mapped by the
 * caller via the existing, already-exported `transferErrorResponse`
 * helper -- the SAME mapping the single-item route's own catch block
 * uses -- so the two routes can never disagree about what a given typed
 * error means.
 *
 * The one addition beyond a straight mirror: an explicit per-row
 * authorization check at the top, reproducing the `user:team:transfer`
 * resolver's own rule (Global_Manager, or a Team_Admin of EITHER side)
 * -- the single-item route gets this for free from that resolver
 * running before its handler; this route's subject is an array, so
 * there is no single `:userId` for the resolver to key on.
 *
 * @param {number} transferredUserId
 * @param {{targetTeamId: number, justification?: string, callsignSuffix?: string}} body
 * @param {number} actorId
 * @param {boolean} actorIsGlobalManager
 * @returns {Promise<{status: number, error?: string, body?: object}>}
 */
async function transferOneUserForBulk(transferredUserId, { targetTeamId, justification, callsignSuffix }, actorId, actorIsGlobalManager) {
  const membershipResult = await pool.query(
    'SELECT team_id, role FROM team_memberships WHERE user_id = $1 AND inherited_from_team_id IS NULL',
    [transferredUserId]
  );
  const membership = membershipResult.rows[0] || null;

  let initiatorAdminsSource = false;
  let initiatorAdminsDestination = false;
  if (!actorIsGlobalManager) {
    initiatorAdminsSource = membership ? await Team.isAdmin(membership.team_id, actorId) : false;
    initiatorAdminsDestination = await Team.isAdmin(targetTeamId, actorId);
    if (!initiatorAdminsSource && !initiatorAdminsDestination) {
      return { status: 403, error: 'You do not have permission to transfer this user' };
    }
  }

  if (transferredUserId === actorId) {
    throw new SelfTransferError(actorId);
  }

  const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [transferredUserId]);
  if (userResult.rows.length === 0) {
    return { status: 404, error: 'User not found' };
  }

  const teamResult = await pool.query('SELECT id FROM teams WHERE id = $1', [targetTeamId]);
  if (teamResult.rows.length === 0) {
    return { status: 400, error: 'Target team not found' };
  }

  if (!membership) {
    throw new NoCurrentTeamError(transferredUserId);
  }
  const sourceTeamId = membership.team_id;
  const demotedFromAdmin = membership.role === 'admin';
  if (sourceTeamId === targetTeamId) {
    throw new AlreadyInDestinationTeamError(transferredUserId, targetTeamId);
  }

  const [sourceChain, destinationChain] = await Promise.all([
    Team.getAncestorChain(sourceTeamId),
    Team.getAncestorChain(targetTeamId)
  ]);

  if (sourceChain[0].id !== destinationChain[0].id && !actorIsGlobalManager) {
    throw new CrossOrganisationTransferError(sourceChain[0].id, destinationChain[0].id);
  }

  const pendingResult = await pool.query(
    `SELECT id
       FROM access_requests
      WHERE request_type = 'team_change'
        AND status = 'pending'
        AND existing_user_id = $1`,
    [transferredUserId]
  );
  if (pendingResult.rows.length > 0) {
    return { status: 409, error: PENDING_TRANSFER_CONFLICT_MESSAGE };
  }

  const isDualAdmin = actorIsGlobalManager || (initiatorAdminsSource && initiatorAdminsDestination);

  if (isDualAdmin) {
    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      outcome = await TeamTransferService.executeTransfer(client, {
        userId: transferredUserId,
        destinationTeamId: targetTeamId,
        actorId,
        actorIsGlobalManager,
        callsignSuffix: callsignSuffix || null,
        requestCallsignSuffix: null
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const effects = await TeamTransferService.applyPostCommitEffects(outcome);
    return {
      status: 200,
      body: {
        status: 'completed',
        demotedFromAdmin: outcome.demotedFromAdmin,
        callsign: effects.callsign,
        destinationTeamPath: formatTeamPathForResponse(destinationChain),
        revokedChannelCount: outcome.revokedChannelIds.length
      }
    };
  }

  const approvalTeamId = initiatorAdminsDestination ? sourceTeamId : targetTeamId;
  const approvalChain = initiatorAdminsDestination ? sourceChain : destinationChain;
  const approvalTeamName = approvalChain[approvalChain.length - 1].name;

  const initiatorResult = await pool.query('SELECT email, first_name, last_name FROM users WHERE id = $1', [actorId]);
  const initiator = initiatorResult.rows[0] || {};

  const assignedAdminResult = await pool.query(
    `SELECT user_id
       FROM team_memberships
      WHERE team_id = $1
        AND role = 'admin'
        AND inherited_from_team_id IS NULL
      ORDER BY user_id ASC
      LIMIT 1`,
    [approvalTeamId]
  );

  const insertResult = await pool.query(
    `INSERT INTO access_requests (
       request_type, requester_email, requester_first_name, requester_last_name,
       existing_user_id, current_team_id, target_team_id, approval_team_id,
       initiated_by, assigned_to_admin, justification, callsign_suffix,
       status, email_verified
     ) VALUES ('team_change', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', true)
     RETURNING id`,
    [
      initiator.email || null,
      initiator.first_name ?? null,
      initiator.last_name ?? null,
      transferredUserId,
      sourceTeamId,
      targetTeamId,
      approvalTeamId,
      actorId,
      assignedAdminResult.rows[0]?.user_id ?? null,
      justification || null,
      callsignSuffix || null
    ]
  );

  return {
    status: 202,
    body: {
      status: 'pending_approval',
      requestId: insertResult.rows[0].id,
      demotedFromAdmin,
      approvalTeamId,
      approvalTeamName
    }
  };
}

router.post('/bulk-transfer', authenticateToken, authorize, [
  body('userIds').isArray({ min: 1 }),
  body('userIds.*').isInt({ min: 1 }),
  body('targetTeamId').isInt({ min: 1 }).toInt(),
  body('justification').optional().trim().isLength({ max: 500 }),
  body('callsignSuffix').optional().trim().isLength({ max: 255 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const userIds = parseBulkUserIds(req.body);
  if (!userIds) {
    return res.status(400).json({ error: 'userIds must be a non-empty array of positive integers' });
  }

  const actorId = req.user.userId;
  const actorIsGlobalManager = !!req.user.is_global_manager;
  const { targetTeamId, justification, callsignSuffix } = req.body;
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (const transferredUserId of userIds) {
    try {
      const outcome = await transferOneUserForBulk(
        transferredUserId,
        { targetTeamId, justification, callsignSuffix },
        actorId,
        actorIsGlobalManager
      );
      if (outcome.status < 300) {
        results.push({ userId: transferredUserId, success: true, ...outcome.body });
        successCount++;
      } else {
        results.push({ userId: transferredUserId, success: false, error: outcome.error });
        failureCount++;
      }
    } catch (error) {
      const mapped = transferErrorResponse(error);
      const message = mapped ? mapped.error : 'Failed to transfer user';
      if (!mapped) {
        getLogger().error({ err: error, transferredUserId, targetTeamId }, 'Failed to bulk-transfer user');
      }
      results.push({ userId: transferredUserId, success: false, error: message });
      failureCount++;
    }
  }

  res.json({ successCount, failureCount, results });
});

/**
 * Global_Manager-only for the ENTIRE batch, matching
 * `DELETE /api/users/remove-from-team/:userId`'s own deliberately
 * resolver-less, wildcard-only authorization exactly (see that route's
 * `user:team:remove` Permission_Registry entry and its
 * `REVIEWED_GLOBAL_MANAGER_ONLY` documentation in
 * `permissions.registry.test.js`). Widening who may permanently delete
 * an account is a separate decision that has not been made; this bulk
 * route inherits that same restriction rather than loosening it as a
 * side effect of adding batching -- checked ONCE, up front, not
 * per-row, since there is no Team_Admin path to fall back to at all.
 */
router.post('/bulk-remove-from-team', authenticateToken, authorize, [
  body('userIds').isArray({ min: 1 }),
  body('userIds.*').isInt({ min: 1 }),
  body('teamId').isInt()
], async (req, res) => {
  if (!req.user.is_global_manager) {
    return res.status(403).json({ error: 'Only a Global_Manager may permanently delete a user' });
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const userIds = parseBulkUserIds(req.body);
  if (!userIds) {
    return res.status(400).json({ error: 'userIds must be a non-empty array of positive integers' });
  }
  // `teamId` is validated above (matching the single-item route's own
  // required field) but not read here: `removeUserFromTeam` deletes
  // EVERY team_memberships row for a user regardless of team, exactly
  // as the single-item route's own comment on that call explains.
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (const userId of userIds) {
    try {
      const userResult = await pool.query('SELECT authentik_user_id FROM users WHERE id = $1', [userId]);
      if (userResult.rows.length === 0) {
        results.push({ userId, success: false, error: 'User not found' });
        failureCount++;
        continue;
      }
      const authentikUserId = userResult.rows[0].authentik_user_id;

      await TeamMembershipService.removeUserFromTeam(userId, req.user.userId);

      const certificateRevocationDryRun = !isDeviceMgmtRevokeEnabled();

      await UserAttributesService.clearUserAttributes(authentikUserId);

      let authentikAccountDeleted = true;
      try {
        const deleteResponse = await fetchWithTimeout(`${process.env.AUTHENTIK_URL}/api/v3/core/users/${authentikUserId}/`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${process.env.AUTHENTIK_API_TOKEN}` }
        });
        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          throw new Error(`Authentik delete responded with status ${deleteResponse.status}`);
        }
      } catch (deleteErr) {
        getLogger().error({ err: deleteErr, userId }, 'Failed to delete user from Authentik during bulk remove');
        authentikAccountDeleted = false;
        try {
          await EventPublisher.publishOperation(
            'cleanup_orphaned_authentik_user',
            { authentik_user_id: authentikUserId },
            req.user.userId
          );
        } catch (enqueueErr) {
          getLogger().error(
            { err: enqueueErr, authentikUserId },
            'Failed to enqueue cleanup_orphaned_authentik_user compensating operation during bulk remove'
          );
        }
      }

      await pool.query('DELETE FROM user_cache WHERE authentik_id = $1', [String(authentikUserId)]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);

      try {
        await pool.query(
          'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
          [
            req.user.userId,
            'user.remove_from_team',
            'user',
            userId,
            JSON.stringify({ authentikAccountDeleted, certificateRevocationDryRun })
          ]
        );
      } catch (auditErr) {
        getLogger().error({ err: auditErr }, 'Failed to write audit log');
      }

      results.push({ userId, success: true, authentikAccountDeleted, certificateRevocationDryRun });
      successCount++;
    } catch (error) {
      getLogger().error({ err: error, userId }, 'Failed to bulk-remove user from team');
      results.push({ userId, success: false, error: error.message || 'Failed to remove user' });
      failureCount++;
    }
  }

  res.json({ successCount, failureCount, results });
});

module.exports = router;