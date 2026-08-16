const axios = require('axios');

class AuthentikService {
  constructor() {
    this.baseURL = process.env.AUTHENTIK_URL;
    this.adminToken = process.env.AUTHENTIK_ADMIN_TOKEN;
    this.client = axios.create({
      baseURL: `${this.baseURL}/api/v3`,
      headers: {
        'Authorization': `Bearer ${this.adminToken}`,
        'Content-Type': 'application/json'
      }
    });
  }

  // Create regular user (not service account)
  async createUser(userData) {
    const response = await this.client.post('/core/users/', {
      username: userData.username,
      name: userData.name,
      email: userData.email,
      is_active: true,
      type: 'internal'
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
  // @param {number} userId - the Authentik user's `pk` the token is
  //   scoped to (Requirement 27.5: "scoped to that device's Authentik
  //   user").
  // @param {{identifier: string, expiresInMinutes: number}} options
  // @returns {Promise<{identifier: string, expires: string, key: string}>}
  async createAppPasswordToken(userId, { identifier, expiresInMinutes }) {
    const expires = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();

    const createResponse = await this.client.post('/core/tokens/', {
      identifier,
      intent: 'app_password',
      user: userId,
      expiring: true,
      expires
    });

    const keyResponse = await this.client.get(
      `/core/tokens/${encodeURIComponent(identifier)}/view_key/`
    );

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
        CN: groupData.displayName,
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