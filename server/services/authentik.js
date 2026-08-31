const axios = require('axios');
const logger = require('../config/logger').createLogger('AuthentikService');

class AuthentikService {
  constructor() {
    this.baseURL = process.env.AUTHENTIK_URL;
    // Renamed from AUTHENTIK_ADMIN_TOKEN: TAKTeamManager now authenticates
    // to Authentik with a dedicated, least-privilege service-account token
    // (see auth-infra's tak-teammanager-setup.yaml), not a superuser admin
    // token, so the old name was actively misleading.
    this.apiToken = process.env.AUTHENTIK_API_TOKEN;
    this.client = axios.create({
      baseURL: `${this.baseURL}/api/v3`,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Least-privilege-token follow-up (auth-infra's
    // TAKTEAMMANAGER-AUTHENTIK-LEAST-PRIVILEGE.md, "Option A"): Authentik's
    // `TokenViewSet.perform_create` hard-codes `user=self.request.user` for
    // any NON-SUPERUSER caller (`authentik/core/api/tokens.py`) -- it is an
    // unconditional `if not is_superuser` branch, not a permission check,
    // so no grant to the scoped role can make `POST /core/tokens/` create a
    // token for a user OTHER than the caller. `createAppPasswordToken`
    // below needs exactly that (an app-password token scoped to a device's
    // or a human's own, pre-existing Authentik user, not to this service
    // account), so it is the one deliberate, isolated exception that still
    // uses a superuser token -- reusing the ORIGINAL admin secret
    // (`AuthentikAdminTokenArn`), under its own env var so it is never
    // confused with the least-privilege `AUTHENTIK_API_TOKEN` above.
    //
    // This second client is built ONLY when the env var is set, so a
    // deployment that has not yet wired the new secret still constructs
    // (every other method keeps working); `createAppPasswordToken` itself
    // throws a clear, named error if it is missing when actually called,
    // rather than silently sending an unauthenticated request.
    this.enrollmentAdminToken = process.env.AUTHENTIK_ENROLLMENT_ADMIN_TOKEN;
    this.enrollmentClient = this.enrollmentAdminToken
      ? axios.create({
          baseURL: `${this.baseURL}/api/v3`,
          headers: {
            'Authorization': `Bearer ${this.enrollmentAdminToken}`,
            'Content-Type': 'application/json'
          }
        })
      : null;
  }

  // Create a user. Defaults to `type: 'internal'` (a human-representing
  // account) for every EXISTING caller (`routes/users.js`,
  // `RequestApprovalService.js`, `BulkImportService.js`), none of which
  // pass a `type` -- their behavior is unchanged.
  //
  // `DeviceEnrollmentService.createDevice` is the one caller that DOES
  // pass `type: 'service_account'` (device-management follow-up,
  // Team_Owned_Device / Authentik service-account type): a device has no
  // email, cannot interactively log in, and only ever authenticates via
  // the app-password token `createAppPasswordToken` mints for it below --
  // exactly the shape Authentik's `service_account` user type is for
  // (confirmed live against account.test.tak.nz: `POST /core/users/` with
  // `type: 'service_account'` succeeds, and `createAppPasswordToken`'s
  // `POST /core/tokens/` with `intent: 'app_password'` succeeds against
  // it identically to an `internal` user -- neither Authentik's
  // `TokenSerializer.validate` nor `TokenViewSet.perform_create` gates on
  // user type). This also means `getUsers()`'s `?type=internal` filter
  // below now excludes a NEWLY created device automatically, without
  // needing a local `is_team_device` cross-reference for it -- though
  // that local filter (`server/routes/users.js`) is deliberately KEPT
  // rather than removed, because it still correctly excludes any
  // Team_Owned_Device created before this change, which remains
  // `type: 'internal'` in Authentik until/unless a separate backfill
  // migrates it.
  async createUser(userData) {
    const response = await this.client.post('/core/users/', {
      username: userData.username,
      name: userData.name,
      email: userData.email,
      is_active: true,
      type: userData.type || 'internal'
    });
    return response.data;
  }

  // Set user password
  async setUserPassword(userId, password) {
    await this.client.post(`/core/users/${userId}/set_password/`, {
      password: password
    });
  }

  // Requirement 27 Criteria 5-7 (task 49.3): creates a short-lived
  // Authentik `app_password` token scoped to a specific user, for
  // rendering as an ATAK/iTAK enrollment QR code by
  // `DeviceEnrollmentService.generateEnrollmentQrCode`. Mirrors the
  // token-creation call already used by `enrollment-lambda`'s
  // `POST /api/v3/core/tokens/` request, per requirements.md's Req 27.5
  // wording.
  //
  // Authentik's `Token` model (confirmed against Authentik's published
  // OpenAPI schema, `IntentEnum`/`TokenRequest`) supports four `intent`
  // values -- `verification`, `api`, `recovery`, `app_password` -- and
  // accepts `expiring`/`expires` fields directly on creation (there is no
  // separate "app password" creation endpoint; `intent: 'app_password'`
  // on the same `/core/tokens/` resource is what distinguishes it). The
  // `identifier` must be unique and match `^[-a-zA-Z0-9_]+$`.
  //
  // Critically, the `Token`/`TokenRequest` schemas never expose the
  // plaintext key material on create, update, or list -- only a
  // dedicated `GET /core/tokens/{identifier}/view_key/` endpoint ("Return
  // token key and log access") returns it. So this method makes two
  // calls: create the token row, then immediately fetch its key.
  //
  // takserver-enrollment Requirement 3/15.1 Error Handling: if the FIRST
  // call (creating the token row) throws, nothing was created and
  // nothing needs compensating -- that rejection simply propagates.
  // If the SECOND call (fetching the key) throws AFTER the first
  // succeeded, a live `app_password` token now exists in Authentik that
  // this method will never return the key for and that no device will
  // ever receive. This module is the one that knows about both calls and
  // their shared `identifier`, so the compensation lives here: attempt a
  // `DELETE /core/tokens/{identifier}/` for that token, then rethrow the
  // ORIGINAL key-fetch error regardless of whether the delete succeeded.
  // This delete is licensed -- unlike the product's "never delete a
  // federated identity" rule, a token is a credential this application
  // minted seconds earlier, not an identity. On a FAILED delete, log the
  // token IDENTIFIER (never a key, since none was ever obtained) at
  // `error` and leave it to expire naturally within its
  // `expiresInMinutes` cap -- no further compensation attempt.
  //
  // Least-privilege-token follow-up: uses `this.enrollmentClient` (the
  // isolated superuser-token client, see the constructor) rather than
  // `this.client`. This is the ONE method in this file that does -- every
  // other method above and below keeps using the least-privilege
  // `AUTHENTIK_API_TOKEN` client. Throws a named, actionable error rather
  // than sending an unauthenticated request when
  // `AUTHENTIK_ENROLLMENT_ADMIN_TOKEN` was never configured.
  //
  // @param {number} userId - the Authentik user's `pk` the token is
  //   scoped to (Requirement 27.5: "scoped to that device's Authentik
  //   user").
  // @param {{identifier: string, expiresInMinutes: number}} options
  // @returns {Promise<{identifier: string, expires: string, key: string}>}
  async createAppPasswordToken(userId, { identifier, expiresInMinutes }) {
    if (!this.enrollmentClient) {
      throw new Error(
        'AUTHENTIK_ENROLLMENT_ADMIN_TOKEN is not configured; device enrollment cannot mint an ' +
        'app-password token for another user with the least-privilege AUTHENTIK_API_TOKEN alone ' +
        '(Authentik forces POST /core/tokens/ to be owned by the caller for any non-superuser token).'
      );
    }

    const expires = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

    const createResponse = await this.enrollmentClient.post('/core/tokens/', {
      identifier,
      intent: 'app_password',
      user: userId,
      expiring: true,
      expires
    });

    let keyResponse;
    try {
      keyResponse = await this.enrollmentClient.get(
        `/core/tokens/${encodeURIComponent(identifier)}/view_key/`
      );
    } catch (keyFetchError) {
      try {
        await this.enrollmentClient.delete(`/core/tokens/${encodeURIComponent(identifier)}/`);
      } catch (deleteError) {
        logger.error(
          { err: deleteError, identifier },
          'Enrollment token created but its key fetch failed, and the compensating delete also failed; ' +
          'it will expire naturally within its configured lifetime'
        );
      }
      throw keyFetchError;
    }

    return {
      identifier: createResponse.data.identifier,
      expires: createResponse.data.expires,
      key: keyResponse.data.key
    };
  }

  // Get all users (excluding service accounts)
  //
  // Requirement 11.4: `GET /api/users` applies the shared `paginationParams`
  // middleware and needs to scope its underlying Authentik fetch to just the
  // requested page, rather than fetching Authentik's entire user list on
  // every request regardless of the page actually being displayed.
  //
  // Option (b) from the task 31.6 write-up was chosen over in-memory
  // slicing of a full fetch: Authentik's `/core/users/` endpoint already
  // supports `page`/`page_size` query parameters (the same Authentik-side
  // pagination mechanism `authentikSync.js` already relies on for its
  // group-list fetch), so passing them through here reduces Authentik API
  // load in addition to bounding the response payload -- this is a clean,
  // low-risk change because `GET /api/users` is currently the only caller
  // of this method in the codebase.
  //
  // Called with no arguments (`page`/`pageSize` both undefined), this
  // method preserves its original full-fetch behavior exactly: a plain
  // array of every internal user, with no `page`/`page_size` query
  // parameter sent to Authentik at all. This keeps any future,
  // currently-nonexistent caller that depends on the pre-pagination
  // contract unaffected.
  //
  // Called with a `page` and/or `pageSize`, it maps them onto Authentik's
  // own `page`/`page_size` parameters and returns `{ results, count }`,
  // where `count` is Authentik's total-matching-record count (for the
  // `type=internal` filter) taken from its pagination envelope, so the
  // caller can report a `total` independent of the current page.
  async getUsers({ page, pageSize } = {}) {
    if (page === undefined && pageSize === undefined) {
      const response = await this.client.get('/core/users/?type=internal');
      return response.data.results;
    }

    const resolvedPage = page || 1;
    const resolvedPageSize = pageSize || 50;
    const response = await this.client.get(
      `/core/users/?type=internal&page=${resolvedPage}&page_size=${resolvedPageSize}`
    );
    return {
      results: response.data.results,
      count: response.data.pagination?.count ?? response.data.results.length
    };
  }

  // Get user by username
  async getUserByUsername(username) {
    const response = await this.client.get(`/core/users/?username=${username}`);
    return response.data.results[0] || null;
  }

  // Create LDAP group for channel
  async createGroup(groupData) {
    const response = await this.client.post('/core/groups/', {
      name: groupData.name,
      attributes: {
        description: groupData.description
      }
    });
    return response.data;
  }

  // Add user to group
  async addUserToGroup(groupId, userId) {
    await this.client.post(`/core/groups/${groupId}/add_user/`, {
      pk: userId
    });
  }

  // Remove user from group
  async removeUserFromGroup(groupId, userId) {
    await this.client.post(`/core/groups/${groupId}/remove_user/`, {
      pk: userId
    });
  }

  // Get group by name
  async getGroupByName(name) {
    const encodedName = encodeURIComponent(name);
    const response = await this.client.get(`/core/groups/?name=${encodedName}`);
    return response.data.results[0] || null;
  }
}

module.exports = new AuthentikService();