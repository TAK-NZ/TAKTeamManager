const fs = require('fs');
const https = require('https');
const axios = require('axios');
const logger = require('../config/logger').createLogger('TakServerService');
const { DEFAULT_FETCH_TIMEOUT_MS } = require('../utils/fetchWithTimeout');
const { CircuitBreaker } = require('../utils/circuitBreaker');

/**
 * TAK Server certificate lifecycle integration (Requirement 26,
 * `design.md` Section 21).
 *
 * `TakServerService` talks to TAK Server's Marti `certadmin` REST API over
 * mutual TLS, using whichever client credential pair the Config_Validator
 * already requires to be present WHERE `TAK_SERVER_URL` is configured
 * (Requirement 26.1/26.2, enforced separately in
 * `server/config/configValidator.js`, task 48.1): either a PKCS#12 bundle
 * (`TAK_API_P12_PATH`/`TAK_API_P12_PASSPHRASE`) or a cert/key pair
 * (`TAK_API_CERT_PATH`/`TAK_API_KEY_PATH`), plus an optional CA bundle
 * (`TAK_CA_PATH`) and an optional TLS `servername`
 * (`TAK_SERVER_TLS_SERVERNAME`, Requirement 10 -- see
 * `buildMutualTlsAgentOptions` below).
 *
 * Node's built-in `https.Agent` accepts `pfx`/`passphrase`/`cert`/`key`/`ca`
 * directly as constructor options (they are forwarded to
 * `tls.createSecureContext`/`tls.connect` under the hood) -- no additional
 * npm dependency is needed for mutual TLS beyond the `axios` dependency
 * already declared in `package.json`.
 *
 * Marti `certadmin` API shape (confirmed against the TAK Server source --
 * `CertManagerAdminApi.java`, `TakCert.java`, `ApiResponse.java`,
 * `BaseRestController.java`):
 *  - Base path: `{TAK_SERVER_URL}/Marti/api/certadmin/cert/...`
 *  - `GET /Marti/api/certadmin/cert` -- `ApiResponse<List<TakCert>>`,
 *    listing every certificate.
 *  - `GET /Marti/api/certadmin/cert/revoked` (OpenAPI `getRevoked`) --
 *    `ApiResponse<List<TakCert>>`, the authoritative set of revoked
 *    certificates; membership in it is the only revocation signal.
 *  - `DELETE /Marti/api/certadmin/cert/revoke/{comma,separated,ids}` --
 *    plain 200 OK with no body on success (NOT wrapped in `ApiResponse`).
 *  - `ApiResponse<T>` shape: `{ version, type, data: T, messages, nodeId }`
 *    -- the actual payload is under `data`, so every GET response here is
 *    unwrapped via `response.data.data`.
 *  - `TakCert` shape (Jackson camelCase): `{ id, creatorDn, subjectDn,
 *    userDn, certificate, hash, clientUid, issuanceDate, expirationDate,
 *    effectiveDate, revocationDate, token, serialNumber }`.
 *    `revocationDate` is always present as a field on every list entry
 *    (there is no `@JsonInclude(NON_NULL)` on `TakCert` itself, only on
 *    `ApiResponse`), but it is NOT a revocation signal and must never be
 *    used as one (device-management Requirement 12.5): observed live, all
 *    95 certificates in `/active` carried a non-null `revocationDate`,
 *    including the 5 that `/revoked` does not list. Revocation is decided
 *    by membership in `/revoked` alone.
 */
class TakServerService {
  /**
   * @param {NodeJS.ProcessEnv} [env] defaults to `process.env`;
   *   overridable for testing without touching real environment state.
   * @param {Object} [options]
   * @param {{getAgentOptions: function(): (import('https').AgentOptions | null)}} [options.credentialLoader]
   *   optional Admin_Credential_Loader that `refreshAgent()` pulls the current
   *   credential from (device-management Requirements 2.7, 2.8). Usually
   *   attached after construction via `setCredentialLoader`, because the Loader
   *   itself takes this service as a constructor argument.
   */
  constructor(env = process.env, { credentialLoader = null } = {}) {
    this.baseURL = env.TAK_SERVER_URL;

    /**
     * Retained so `refreshAgent()` can re-derive file/environment credentials
     * (a rotated file on disk) without the caller having to supply them again.
     *
     * @type {NodeJS.ProcessEnv}
     */
    this.env = env;

    this.credentialLoader = credentialLoader;

    /**
     * The mutual-TLS options the currently-installed `https.Agent` was built
     * from -- the credential in force for subsequent Marti calls.
     *
     * @type {import('https').AgentOptions}
     */
    this.agentOptions = buildMutualTlsAgentOptions(env);

    this.client = axios.create({
      baseURL: this.baseURL,
      // Resiliency-hardening: no default timeout was set here, so a
      // hung/unreachable TAK Server would leave a Marti certadmin call
      // waiting indefinitely. `refreshAgent()` below only rebuilds
      // `httpsAgent` in place, so this timeout survives every credential
      // rotation. Same 10000ms value used everywhere else for consistency.
      timeout: DEFAULT_FETCH_TIMEOUT_MS,
      httpsAgent: new https.Agent(this.agentOptions)
    });

    // Resiliency-hardening: every `this.client.*` call below is routed
    // through `this.circuitBreaker.execute(...)` at its call site, so a
    // run of failed Marti calls (unreachable/timed-out TAK Server) trips
    // the breaker and subsequent calls fail fast instead of each waiting
    // out the full axios `timeout` above. See
    // `server/utils/circuitBreaker.js`'s own doc comment for the state
    // machine. The client's methods are deliberately left unwrapped/
    // untouched (rather than monkey-patched via `wrapAxiosClientMethods`):
    // this repo's tests replace `service.client` outright with a plain
    // object (see e.g. `DeviceSync.test.js`'s `createViewBackedTakServerService`)
    // AFTER construction, which a constructor-time wrap would not see.
    this.circuitBreaker = new CircuitBreaker({
      name: 'tak-server',
      onStateChange: ({ from, to }) => {
        logger[to === 'open' ? 'error' : 'warn'](
          { from, to },
          `TAK Server circuit breaker transitioned ${from} -> ${to}`
        );
      }
    });
  }

  /**
   * Attaches (or replaces) the Admin_Credential_Loader that `refreshAgent()`
   * pulls from.
   *
   * Exists because the Loader is constructed with this service
   * (`new AdminCredentialLoader({ takServerService })`), so it cannot be handed
   * to the constructor without a construction-order cycle; the Loader --
   * or the Sync_Worker wiring it up -- registers itself here instead
   * (device-management Requirement 2.8).
   *
   * @param {{getAgentOptions: function(): (import('https').AgentOptions | null)}} credentialLoader
   * @returns {void}
   */
  setCredentialLoader(credentialLoader) {
    this.credentialLoader = credentialLoader;
  }

  /**
   * device-management Requirement 2.7: rebuilds this service's mutual-TLS
   * agent in place from the supplied options, so a rotated Admin_Credential is
   * used for every subsequent Marti `certadmin` call without a process
   * restart.
   *
   * Rebuilding in place (mutating `this.client.defaults.httpsAgent` rather
   * than creating a new axios client or a new service instance) is what makes
   * a rotation visible to every existing holder of this instance -- notably
   * the Sync_Worker's `revoke_tak_certificates` handler and the
   * device-management jobs, which deliberately share one `TakServerService`
   * (Requirement 2.8).
   *
   * The previous agent is intentionally NOT destroyed: `keepAlive` is not
   * enabled on these agents, so it holds no idle pooled sockets worth
   * reclaiming, while `agent.destroy()` would tear down sockets still serving
   * an in-flight request. The old agent is simply dereferenced and collected
   * once its outstanding requests finish; only calls made after this point use
   * the new credential.
   *
   * @param {import('https').AgentOptions} options mutual-TLS options, i.e.
   *   `{ cert, key }` (+ optional `{ ca }`) or `{ pfx, passphrase }`.
   * @returns {import('https').Agent} the newly installed agent.
   * @throws {TypeError} when `options` is not an options object -- installing
   *   an agent with no client certificate would silently turn every subsequent
   *   Marti call into an unauthenticated one, which is worse than failing the
   *   refresh and keeping the working credential in place.
   */
  setAgentOptions(options) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError(
        'TakServerService.setAgentOptions: expected mutual-TLS agent options object, ' +
          `received ${options === null ? 'null' : typeof options}`
      );
    }

    const httpsAgent = new https.Agent(options);

    this.agentOptions = options;
    this.client.defaults.httpsAgent = httpsAgent;

    // Requirement 2.11 (shared with the Loader): shape only, never values.
    logger.info(
      {
        hasCert: Boolean(options.cert),
        hasKey: Boolean(options.key),
        hasPfx: Boolean(options.pfx),
        hasCa: Boolean(options.ca)
      },
      'Rebuilt TAK Server mutual-TLS agent'
    );

    return httpsAgent;
  }

  /**
   * device-management Requirement 2.7: rebuilds the mutual-TLS agent from the
   * current credential material, without the caller having to hold it.
   *
   * Sources, in order:
   *  1. the attached Admin_Credential_Loader's cached credential
   *     (`getAgentOptions()`), i.e. whatever the last successful load/refresh
   *     produced -- this is the path `AdminCredentialLoader.refresh()` and
   *     `AdminCredentialRefreshJob` use;
   *  2. `buildMutualTlsAgentOptions(this.env)` when no Loader is attached (or
   *     it has not yet loaded), which re-reads the configured file/environment
   *     credential so a rotated file on disk is picked up too.
   *
   * @returns {import('https').Agent} the newly installed agent.
   */
  refreshAgent() {
    const loaded = this.credentialLoader ? this.credentialLoader.getAgentOptions() : null;
    const options = loaded || buildMutualTlsAgentOptions(this.env);
    return this.setAgentOptions(options);
  }

  /**
   * Requirement 26.3: lists every certificate known to TAK Server's Marti
   * `certadmin` API.
   *
   * `GET /Marti/api/certadmin/cert` returns `ApiResponse<List<TakCert>>`;
   * this unwraps the `data` field and returns the certificate array as-is
   * (camelCase `TakCert` fields, unmodified), rather than re-mapping field
   * names -- callers that need a specific field (e.g. `creatorDn`,
   * `revocationDate`) read it directly off the returned objects.
   *
   * @returns {Promise<Array<object>>} the raw `TakCert` list.
   */
  async listCertificates() {
    const response = await this.circuitBreaker.execute(() => this.client.get('/Marti/api/certadmin/cert'));
    return response.data.data;
  }

  /**
   * device-management Requirement 4.3: fetches the Active_Certificates --
   * TAK Server's non-revoked, non-superseded certificate view -- which is what
   * the Device_Sync derives Device rows from, so a replaced/superseded
   * certificate never becomes a Device (device-management Requirement 4.6).
   *
   * `GET /Marti/api/certadmin/cert/active` (OpenAPI `getActive` ->
   * `ApiResponseListTakCert`) is the same `ApiResponse<List<TakCert>>`
   * envelope `listCertificates()` reads, so the payload is unwrapped from
   * `data` and the camelCase `TakCert` objects are returned as-is.
   *
   * A failure is NEVER degraded to an empty result, and there is deliberately
   * no 404-as-empty branch here (device-management Requirements 14.1, 14.2):
   * this endpoint IS documented in `tak-server-openapispec.json`, so a 404
   * means the request was wrong -- a bug in the path we built -- not that the
   * server holds no certificates. The earlier tolerance was the exact defect
   * Requirement 14.5 names: a wrong URL read as "nothing to sync", the
   * Device_Table was left untouched, and only a warning was ever logged, so
   * "no certificates" and "we could not ask" were indistinguishable. Every
   * failure (404, auth, TLS, 5xx, network) now rejects alike and lets the
   * caller's never-throwing `run()` log it, report the run failed, and retry.
   *
   * A 200 whose body carries no `data` array still reads as `[]` -- a
   * legitimately empty view, which syncs nothing (see `unwrapArray`).
   *
   * @returns {Promise<Array<object>>} the active `TakCert` list.
   */
  async listActiveCertificates() {
    const response = await this.circuitBreaker.execute(() => this.client.get('/Marti/api/certadmin/cert/active'));
    return unwrapArray(response);
  }

  /**
   * device-management Requirements 4.3, 11.2, 12.4: fetches the
   * Revoked_Certificate_View -- the set of certificates TAK Server itself
   * lists as revoked.
   *
   * `GET /Marti/api/certadmin/cert/revoked` (OpenAPI `getRevoked` ->
   * `ApiResponseListTakCert`) carries the same `ApiResponse<List<TakCert>>`
   * envelope `listCertificates()` reads, so the payload is unwrapped from
   * `data` and the camelCase `TakCert` objects are returned as-is.
   *
   * This view is the ONLY revocation signal (device-management Requirement
   * 12.5). A certificate's `revocationDate` is not one: verified live, all 95
   * certificates in the Active_Certificate view carried a non-null
   * `revocationDate`, including the 5 that this view does NOT list (e.g. id
   * 3212, `revocationDate: 2026-01-17T01:15:22.160Z`). Membership here, and
   * only membership here, means "revoked".
   *
   * As with `listActiveCertificates()`, a failure is NEVER degraded to an empty
   * result: this endpoint is documented in `tak-server-openapispec.json`, so a
   * 404 means a wrong URL rather than an empty server, and swallowing it would
   * make "nothing is revoked" indistinguishable from "we could not ask"
   * (device-management Requirements 14.1, 14.2). Every failure rejects and lets
   * the caller -- a never-throwing `run()`, or `revokeCertificates()` below --
   * log it and retry.
   *
   * A 200 whose body carries no `data` array still reads as `[]`, which fails a
   * verification closed (every targeted id unverified) rather than open.
   *
   * @returns {Promise<Array<object>>} the revoked `TakCert` list.
   */
  async listRevokedCertificates() {
    const response = await this.circuitBreaker.execute(() => this.client.get('/Marti/api/certadmin/cert/revoked'));
    return unwrapArray(response);
  }

  /**
   * device-management Requirements 4.3, 4.6, 11.2, 11.4: computes the
   * Live_Certificates -- the certificates present in the Active_Certificate
   * view AND absent from the Revoked_Certificate_View -- as a set difference by
   * certificate id.
   *
   * The Active_Certificate view is NOT the live set and must never be used as
   * one (Requirement 11.2): verified live, `GET /Marti/api/certadmin/cert/active`
   * returned 95 certificates of which 90 also appeared in
   * `GET /Marti/api/certadmin/cert/revoked`, so treating `/active` as live
   * presented 90 revoked certificates as live Devices.
   *
   * `GET /Marti/api/certadmin/cert/replaced` is deliberately NOT fetched here
   * for superseding (Requirement 11.4): verified live, it returned the same 95
   * ids as `/active`, so it distinguishes nothing. Superseding is computed
   * locally by the caller (the Newest_Live_Certificate: greatest `issuanceDate`
   * per `clientUid`).
   *
   * Certificates are returned as-is, in `/active` order, with no field
   * re-mapping and no de-duplication by `clientUid` -- `clientUid` reuse is the
   * normal case (95 certificates carried 10 distinct `clientUid`s, one of them
   * holding 60), and grouping certificates into Devices is the caller's job
   * (Requirement 11.1). A certificate carrying no id matches nothing in the
   * revoked set and so stays live, which is the safe direction for a view whose
   * ids are the only thing revocation is keyed on.
   *
   * Both views are fetched concurrently, via `Promise.allSettled` rather than
   * `Promise.all`, so that WHEN either fetch fails the failure is attributed to
   * the view it came from in the log rather than surfacing as an anonymous
   * rejection (Requirement 14.5) -- and so a rejection from one view cannot
   * leave the other's rejection unhandled. Every failure then propagates
   * (Requirements 4.9, 14.1, 14.2): a failed `/revoked` fetch must NEVER read
   * as "nothing is revoked", because that would promote every revoked
   * certificate to live. Neither view tolerates a 404 any more (both are
   * documented -- `getActive` and `getRevoked`), so there is no longer any path
   * by which a failed fetch reaches the set difference below at all: the
   * subtraction only ever runs on two views that both answered 200.
   *
   * @returns {Promise<Array<object>>} the Live_Certificate `TakCert` list.
   * @throws {*} the first failing view's rejection, after both are logged.
   */
  async listLiveCertificates() {
    const [activeResult, revokedResult] = await Promise.allSettled([
      this.listActiveCertificates(),
      this.listRevokedCertificates()
    ]);

    const outcomes = [
      { view: 'active', endpoint: '/Marti/api/certadmin/cert/active', result: activeResult },
      { view: 'revoked', endpoint: '/Marti/api/certadmin/cert/revoked', result: revokedResult }
    ];
    const failures = outcomes.filter(({ result }) => result.status === 'rejected');

    if (failures.length > 0) {
      for (const { view, endpoint, result } of failures) {
        logger.error(
          { err: result.reason, view, endpoint },
          'listLiveCertificates: certificate view fetch failed; cannot compute live certificates'
        );
      }
      throw failures[0].result.reason;
    }

    const revokedIds = new Set(revokedResult.value.map((cert) => cert.id));

    return activeResult.value.filter((cert) => !revokedIds.has(cert.id));
  }

  /**
   * device-management Requirements 3.1, 13.1, 13.2, 13.7, 14.4: fetches the
   * Client_Endpoints_API -- TAK Server's own per-client last-seen HISTORY --
   * which is the single source the Subscription_Poller derives Last_Seen from.
   *
   * `GET /Marti/api/clientEndPoints` (OpenAPI `getClientEndpoints` ->
   * `ApiResponseListClientEndpoint`) carries the same `ApiResponse` envelope
   * the `certadmin` GETs above do, so the payload is unwrapped from `data` and
   * the camelCase `ClientEndpoint` objects -- `{ callsign, uid, username, team,
   * role, lastEventTime, lastStatus }` -- are returned as-is, with no field
   * re-mapping, consistent with `listCertificates()`. Matching an entry to a
   * Device row is the caller's job: `ClientEndpoint.uid` is the join key and it
   * lives in the same space as `tak_devices.client_uid` (verified live, e.g.
   * `ANDROID-842f08e120efdbe3`), which is what makes this view usable as the
   * Last_Seen source at all (Requirement 13.1).
   *
   * This REPLACES the removed `getConnectedSubscriptions()`, which targeted
   * `/Marti/clients`. That endpoint answers 404 on the live server and is
   * absent from `tak-server-openapispec.json` entirely, so it was deleted
   * rather than repointed -- a repointed method would let a caller keep the old
   * "connected right now" semantics by accident (Requirement 14.4). Unlike the
   * old snapshot view, this one has history: entries survive disconnection, so
   * Last_Seen no longer has to be reconstructed by repeated polling
   * (Requirement 13.3) and a device offline since before this feature was
   * installed still reports a real timestamp.
   *
   * Query parameters (`secAgo`, `showCurrentlyConnectedClients`,
   * `showMostRecentOnly`, `group`) are optional and forwarded as-is WHERE
   * supplied, EXCEPT `showCurrentlyConnectedClients`, which is stripped and
   * never sent (Requirement 13.7): verified live, 46 of the 48 entries were
   * `lastStatus: "Disconnected"` and only 2 `"Connected"`, and it is precisely
   * those disconnected entries that carry the last-seen timestamps this feature
   * exists to show -- narrowing to currently-connected clients would discard
   * almost the whole result. `lastStatus` is likewise not filtered on here
   * (Requirement 13.2). With no parameters at all the request carries no query
   * string, which is the default this feature uses.
   *
   * `GET /Marti/api/subscriptions/all` (`ApiResponseSetSubscriptionInfo`) is
   * NOT the Last_Seen source of record (Requirement 13.2): its
   * `SubscriptionInfo.clientUid` was empty in 14 of 16 live entries (12 of 14
   * on a later check -- the remaining 2 are the ETL/service connections,
   * identified by `dn` instead of `clientUid`), so it cannot supply the join
   * key for most rows and cannot replace this method's history. It IS used as
   * a SUPPLEMENTARY freshness signal, exclusively for entries where
   * `clientUid` is populated -- see `getAllSubscriptions()` below and
   * `SubscriptionPoller.mergeSubscriptionFreshness()`, which is where the
   * reasoning for adding it back in lives, since it is the caller's decision,
   * not this method's.
   *
   * A failure is NEVER degraded to an empty result, and there is deliberately
   * no 404-as-empty branch here (Requirements 14.1, 14.2, 14.4): this endpoint
   * is documented in `tak-server-openapispec.json`, so a 404 means the request
   * was wrong, not that no client has ever been seen. Swallowing it is the
   * exact defect the earlier graceful-404 handling produced -- a non-existent
   * endpoint silently read as "no clients observed", Last_Seen stayed null
   * indefinitely, and no error was ever surfaced (Requirement 14.5). Every
   * failure rejects and lets the poller's never-throwing `run()` log it, report
   * the run failed, leave every stored Last_Seen untouched, and retry.
   *
   * A 200 whose body carries no `data` array still reads as `[]` -- a
   * legitimately empty history, which updates nothing.
   *
   * @param {{secAgo?: number, showMostRecentOnly?: string|boolean, group?: Array<string>|string}} [params]
   *   optional documented query parameters.
   * @returns {Promise<Array<object>>} the `ClientEndpoint` list.
   */
  async getClientEndpoints(params) {
    const query = sanitizeClientEndpointParams(params);

    const response = query
      ? await this.circuitBreaker.execute(() => this.client.get('/Marti/api/clientEndPoints', { params: query }))
      : await this.circuitBreaker.execute(() => this.client.get('/Marti/api/clientEndPoints'));

    return unwrapArray(response);
  }

  /**
   * device-management Requirement 13 (freshness follow-up): fetches TAK
   * Server's LIVE subscription table -- `GET /Marti/api/subscriptions/all`
   * (OpenAPI `getAllSubscriptions` -> `ApiResponseSetSubscriptionInfo`), the
   * same view TAK Server's own admin UI (`/Marti/clients/index.html`) reads,
   * which is why it updates every few seconds for a connection that is
   * actively reporting while `getClientEndpoints()`'s `lastEventTime` can sit
   * unchanged for many minutes at a time for the identical connection.
   *
   * NOT a replacement for `getClientEndpoints()` (see the note on that
   * method): `SubscriptionInfo.clientUid` is empty for every connection TAK
   * Server cannot attribute to a client certificate -- verified live, 12 of 14
   * entries, all of them CloudTAK's own ETL/service ingest connections
   * (`etl-capnz-metservice`, `etl-adsbx`, etc.), identified by `dn` instead.
   * Those have no `tak_devices` row to update and are not Devices this
   * feature tracks at all. Only the entries WITH a populated `clientUid` --
   * real end-user Devices with a currently live session -- are usable here,
   * and the caller (`SubscriptionPoller.mergeSubscriptionFreshness()`) filters
   * on exactly that.
   *
   * `SubscriptionInfo` carries no `lastStatus` field, but its entries are
   * nonetheless a SECOND, INDEPENDENT Connection_Status signal, and since
   * the bugfix below a positive one: every entry in this view is, by
   * construction, a live subscription that exists right now, so simple
   * PRESENCE in this list is itself evidence of a live connection --
   * stronger evidence than `ClientEndpoint.lastStatus` in the case that
   * motivated this, where TAK Server's two connection-tracking views
   * disagreed for the same session (verified live: a CloudTAK session
   * reporting here every few seconds while `clientEndPoints`'s matching
   * entry sat at `lastStatus: "Disconnected"` for over 20 minutes). Bugfix:
   * an earlier version of this comment claimed there was "nothing here for
   * Connection_Status to read that `ClientEndpoint.lastStatus` does not
   * already provide more completely" -- that was true only for a Device
   * `lastStatus` had already correctly marked connected, and false for
   * exactly the disagreement case above, which is common enough in
   * practice (CloudTAK sessions especially) to matter. See
   * `SubscriptionPoller.mergeSubscriptionFreshness()`, which now OR's this
   * signal into `connected` alongside `ClientEndpoint.lastStatus` rather
   * than treating this view as silent on the question.
   *
   * Same envelope-unwrap and same no-degraded-empty-result discipline as
   * `getClientEndpoints()`: a 200 with no `data` array unwraps to `[]` (a
   * legitimately empty live-subscription table), and any other failure
   * rejects rather than being swallowed, so the caller's never-throwing
   * `run()` can log it and skip the freshening step for that poll without
   * losing the run.
   *
   * @returns {Promise<Array<object>>} the `SubscriptionInfo` list.
   */
  async getAllSubscriptions() {
    const response = await this.circuitBreaker.execute(() => this.client.get('/Marti/api/subscriptions/all'));

    return unwrapArray(response);
  }

  /**
   * Requirement 26.3: finds every certificate belonging to a given TAK
   * username, matching each certificate's `creatorDn` field (per the
   * task's explicit instruction and `design.md` Section 21's "matching
   * each certificate's creatorDn field to that user's TAK username"
   * wording) -- NOT `userDn`, which is what TAK Server's own
   * `?username=` query parameter filters by
   * (`takCertRepository.findAllByUserDn`) and is therefore deliberately
   * not used here.
   *
   * Always calls the unfiltered `listCertificates()` and filters
   * client-side, rather than relying on the server-side `?username=`
   * filter, since that filter matches the wrong field for this purpose.
   *
   * Matching strategy (`creatorDn` is an X.500 DN string, e.g.
   * `CN=alice,OU=...`): prefers an exact `CN=<username>` component match,
   * falling back to a plain case-sensitive substring match for DN shapes
   * that don't strictly follow the `CN=<username>` convention. A plain
   * substring match alone would over-match a username that happens to be
   * a substring of an unrelated DN component (e.g. `alice` inside
   * `alice2`'s DN), so the CN-anchored check is tried first; the substring
   * fallback is kept permissive by design, per the task's explicit
   * instruction to implement "a reasonably permissive substring/CN match".
   *
   * @param {string} takUsername
   * @returns {Promise<Array<object>>} the matching `TakCert` list.
   */
  async findCertificatesForUser(takUsername) {
    const certificates = await this.listCertificates();
    return certificates.filter((cert) => matchesCreatorDn(cert.creatorDn, takUsername));
  }

  /**
   * Requirement 26.4/26.5 and device-management Requirements 12.4-12.7:
   * revokes the given certificate ids via the Marti `certadmin` revoke API,
   * then re-queries the Revoked_Certificate_View and reports success only if
   * every targeted id is a MEMBER of that view.
   *
   * `DELETE /Marti/api/certadmin/cert/revoke/{comma-separated ids}`
   * returns a plain 200 with no body on success -- there is nothing
   * meaningful to unwrap from that response, so the verification step
   * (re-querying via `listRevokedCertificates()`) is what actually determines
   * the reported outcome, per Criterion 26.4's "mark the revocation
   * operation successful only if every targeted certificate id is
   * confirmed present in a revoked state in that re-queried result".
   *
   * Membership in `GET /Marti/api/certadmin/cert/revoked` is the whole test.
   * `revocationDate` is deliberately NOT read here, or anywhere else, for a
   * revocation decision (device-management Requirement 12.5): verified live,
   * all 95 certificates in the Active_Certificate view carried a non-null
   * `revocationDate`, including the 5 that `/revoked` does NOT list (e.g. id
   * 3212, `revocationDate: 2026-01-17T01:15:22.160Z`), so the previous
   * "`revocationDate` is non-null in a re-queried `listCertificates()`" check
   * reported success unconditionally.
   *
   * SHARED METHOD -- READ BEFORE CHANGING (device-management Requirement
   * 12.6): this is the single revoke path used by BOTH the device-management
   * revoke routes and the pre-existing main-spec Requirement 26 callers
   * (`TakCertificateRevocationService.revokeUserTakCertificates`,
   * `TeamMembershipService.removeUserFromTeam`'s no-teams-left branch and
   * `Team.delete`'s bulk enqueue, all via the Sync_Worker's
   * `revoke_tak_certificates` handler). Correcting the verification here
   * therefore also corrects the Requirement 26 revoke path, which had been
   * reporting every revocation as verified.
   *
   * A targeted id that is absent from the re-queried view -- because the
   * revocation did not take, or because the id never existed -- cannot be
   * confirmed revoked, so it is returned in `unverified` and the caller sees
   * `{ success: false }`. The return contract is unchanged, which is what
   * keeps the existing retryable-failure semantics (the operation stays
   * failed-and-retryable, and the Device_Table `revoked` flag is not flipped
   * -- device-management Requirements 7.6, 8.7, 12.7) intact.
   *
   * @param {Array<number>} certIds
   * @returns {Promise<{success: true} | {success: false, unverified: Array<number>}>}
   */
  async revokeCertificates(certIds) {
    const idsParam = certIds.join(',');
    await this.circuitBreaker.execute(() => this.client.delete(`/Marti/api/certadmin/cert/revoke/${idsParam}`));

    const revokedCertificates = await this.listRevokedCertificates();
    const revokedIds = new Set(revokedCertificates.map((cert) => cert.id));

    const unverified = certIds.filter((id) => !revokedIds.has(id));

    if (unverified.length > 0) {
      logger.warn(
        { certIds, unverified },
        'revokeCertificates: not every targeted certificate id was confirmed revoked on re-query'
      );
      return { success: false, unverified };
    }

    return { success: true };
  }
}

/**
 * Builds the `https.Agent` constructor options implementing the Requirement
 * 26.1 mutual TLS credential gate's two accepted credential pairs, plus the
 * optional CA bundle:
 *  - `TAK_API_P12_PATH` + `TAK_API_P12_PASSPHRASE` -> `{ pfx, passphrase }`
 *  - `TAK_API_CERT_PATH` + `TAK_API_KEY_PATH` -> `{ cert, key }`
 *  - `TAK_CA_PATH` (optional, either case) -> additionally `{ ca }`
 *
 * Only reads a given file from disk when its corresponding environment
 * variable is actually set, so this remains a no-op (`{}`, plain outbound
 * TLS with no client certificate) when the TAK Server integration is
 * unconfigured -- consistent with Requirement 26.1's "this integration is
 * optional" and with `collectTakServerConfigIssues`'s existing behavior of
 * not requiring any TAK Server variable when `TAK_SERVER_URL` is unset.
 *
 * The P12 pair is checked first and, if both its variables are present,
 * takes precedence over the cert/key pair -- mirroring
 * `collectTakServerConfigIssues`'s "one of the two credential pairs" gate,
 * which permits either pair but does not require preferring one over the
 * other when both happen to be set; P12-first matches the order the two
 * pairs are listed throughout Requirement 26 and `design.md`.
 *
 * Additionally, WHERE `TAK_SERVER_TLS_SERVERNAME` holds a non-empty value,
 * `{ servername }` is set to it (Requirement 10.4). TAK Server presents a
 * server certificate carrying only its own internal name (`CN=takserver`
 * with a single `DNS:takserver` SAN), which is normally NOT the DNS name
 * operators dial -- typically a load balancer in front of it -- so Node's
 * default identity check against the host of `TAK_SERVER_URL` fails with
 * `ERR_TLS_CERT_ALTNAME_INVALID` on every request. Setting `servername`
 * points the identity check at the name the certificate actually carries;
 * it does NOT relax verification: the chain is still verified against
 * `{ ca }` (Requirement 10.2). Because it is applied here, at agent
 * construction, it covers every request the resulting agent carries --
 * including the pre-existing `revoke_tak_certificates` path that shares
 * this builder (Requirement 10.6).
 *
 * `rejectUnauthorized` is deliberately never set (in particular never
 * `false`), and no `checkServerIdentity` override is ever supplied, in any
 * environment including development and test: either one would stop the
 * Admin_Credential -- a TAK Server *administrative* client certificate --
 * from being presented only to a verified TAK Server (Requirement 10.3).
 *
 * WHERE `TAK_SERVER_TLS_SERVERNAME` is unset or empty, no `servername` key
 * is added and the returned options are exactly what they were before this
 * option existed, so a deployment whose TAK Server certificate already
 * matches the dialed name is unaffected (Requirement 10.5).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {https.AgentOptions}
 */
function buildMutualTlsAgentOptions(env) {
  const options = {};

  const p12Path = env.TAK_API_P12_PATH;
  const p12Passphrase = env.TAK_API_P12_PASSPHRASE;
  const certPath = env.TAK_API_CERT_PATH;
  const keyPath = env.TAK_API_KEY_PATH;
  const caPath = env.TAK_CA_PATH;
  const tlsServerName = env.TAK_SERVER_TLS_SERVERNAME;

  if (isNonEmpty(p12Path) && isNonEmpty(p12Passphrase)) {
    options.pfx = fs.readFileSync(p12Path);
    options.passphrase = p12Passphrase;
  } else if (isNonEmpty(certPath) && isNonEmpty(keyPath)) {
    options.cert = fs.readFileSync(certPath);
    options.key = fs.readFileSync(keyPath);
  }

  if (isNonEmpty(caPath)) {
    options.ca = fs.readFileSync(caPath);
  }

  // Requirement 10.4: verify TAK Server's identity against the Expected_Server_Name
  // its certificate actually carries. Requirement 10.5: absent/empty leaves the
  // options untouched -- no `servername` key at all, not `servername: undefined`.
  if (isNonEmpty(tlsServerName)) {
    options.servername = tlsServerName;
  }

  return options;
}

/*
 * device-management Requirements 14.1, 14.2: there is deliberately NO 404
 * tolerance helper in this file. Every Marti view this service reads --
 * `getActive` (`/Marti/api/certadmin/cert/active`), `getRevoked`
 * (`/Marti/api/certadmin/cert/revoked`), `getAll_1`
 * (`/Marti/api/certadmin/cert`) and `getClientEndpoints`
 * (`/Marti/api/clientEndPoints`) -- is documented in
 * `tak-server-openapispec.json`, so none of them may treat a request failure as
 * an empty result. The former `isNotFound()` predicate was removed with the
 * `listActiveCertificates()` branch that was its only caller; reintroducing it
 * for a documented endpoint would restore the Requirement 14.5 defect.
 */

/**
 * device-management Requirement 13.7: normalizes the optional
 * Client_Endpoints_API query parameters, dropping
 * `showCurrentlyConnectedClients` unconditionally so no caller can narrow the
 * result to currently-connected clients -- the disconnected entries are the ones
 * carrying the last-seen timestamps of interest (46 of 48 live entries).
 *
 * Returns `null` when nothing is left to send, so the request carries no query
 * string at all rather than an empty `params` object.
 *
 * @param {object|null|undefined} params
 * @returns {object|null}
 */
function sanitizeClientEndpointParams(params) {
  if (!params || typeof params !== 'object') {
    return null;
  }

  const query = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'showCurrentlyConnectedClients') {
      logger.warn(
        { param: key },
        'getClientEndpoints: ignoring showCurrentlyConnectedClients; disconnected entries carry the last-seen timestamps'
      );
      continue;
    }
    if (value !== undefined) {
      query[key] = value;
    }
  }

  return Object.keys(query).length > 0 ? query : null;
}

/**
 * Extracts the array payload from a Marti response, accepting either the
 * `ApiResponse` envelope (`{ data: { data: [...] } }`, as used throughout
 * `/Marti/api/...`) or a bare JSON array body (`{ data: [...] }`), and
 * reporting anything else -- an envelope with no `data`, a null body, an
 * unexpected object -- as empty.
 *
 * device-management Requirement 14.3 -- the one tolerated absence left in this
 * file, recorded here rather than at each call site: this tolerates a MISSING
 * PAYLOAD on a SUCCESSFUL (200) response, never a failed request. `ApiResponse`
 * is annotated `@JsonInclude(NON_NULL)` in TAK Server, so `getActive`,
 * `getRevoked`, `getAll_1` and `getClientEndpoints` all omit `data` entirely
 * when their view holds nothing, and every one of those cases is
 * indistinguishable from -- and means the same thing as -- an empty array:
 * nothing to sync, nothing revoked, nobody seen. That absence is safe because
 * the server answered, so it is a real observation of an empty view rather than
 * a failure to observe; a failure never reaches here, because the awaited GET
 * rejects first and propagates (Requirements 14.1, 14.2). It also fails
 * verification CLOSED where it matters: an empty `getRevoked` payload leaves
 * every targeted id unverified in `revokeCertificates()` rather than reporting
 * a revocation that did not happen.
 *
 * @param {{data?: unknown}} response
 * @returns {Array<object>}
 */
function unwrapArray(response) {
  const body = response?.data;

  if (Array.isArray(body)) {
    return body;
  }

  if (body && Array.isArray(body.data)) {
    return body.data;
  }

  return [];
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure predicate implementing the `creatorDn` matching strategy documented
 * on `findCertificatesForUser` above: an exact `CN=<username>` DN
 * component match, falling back to a plain case-sensitive substring match.
 *
 * @param {unknown} creatorDn
 * @param {unknown} takUsername
 * @returns {boolean}
 */
function matchesCreatorDn(creatorDn, takUsername) {
  if (typeof creatorDn !== 'string' || typeof takUsername !== 'string' || takUsername.length === 0) {
    return false;
  }

  const cnComponentPattern = new RegExp(`CN=${escapeRegExp(takUsername)}(,|$)`);
  if (cnComponentPattern.test(creatorDn)) {
    return true;
  }

  return creatorDn.includes(takUsername);
}

module.exports = TakServerService;
module.exports.buildMutualTlsAgentOptions = buildMutualTlsAgentOptions;
module.exports.matchesCreatorDn = matchesCreatorDn;
