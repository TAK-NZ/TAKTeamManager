const fs = require('fs');
const https = require('https');
const axios = require('axios');
const logger = require('../config/logger').createLogger('TakServerService');

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
 * (`TAK_CA_PATH`).
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
 *  - `DELETE /Marti/api/certadmin/cert/revoke/{comma,separated,ids}` --
 *    plain 200 OK with no body on success (NOT wrapped in `ApiResponse`).
 *  - `ApiResponse<T>` shape: `{ version, type, data: T, messages, nodeId }`
 *    -- the actual payload is under `data`, so every GET response here is
 *    unwrapped via `response.data.data`.
 *  - `TakCert` shape (Jackson camelCase): `{ id, creatorDn, subjectDn,
 *    userDn, certificate, hash, clientUid, issuanceDate, expirationDate,
 *    effectiveDate, revocationDate, token, serialNumber }`.
 *    `revocationDate` is serialized as JSON `null` (not omitted) for a
 *    non-revoked certificate, and a date string once revoked -- there is
 *    no `@JsonInclude(NON_NULL)` on `TakCert` itself, only on
 *    `ApiResponse`, so a `null` `revocationDate` is always present as a
 *    field on every list entry.
 */
class TakServerService {
  /**
   * @param {NodeJS.ProcessEnv} [env] defaults to `process.env`;
   *   overridable for testing without touching real environment state.
   */
  constructor(env = process.env) {
    this.baseURL = env.TAK_SERVER_URL;

    const httpsAgent = new https.Agent(buildMutualTlsAgentOptions(env));

    this.client = axios.create({
      baseURL: this.baseURL,
      httpsAgent
    });
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
    const response = await this.client.get('/Marti/api/certadmin/cert');
    return response.data.data;
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
   * Requirement 26.4/26.5: revokes the given certificate ids via the Marti
   * `certadmin` revoke API, then re-queries the certificate list and
   * reports success only if every targeted id is confirmed revoked
   * (non-null `revocationDate`) in that re-queried result.
   *
   * `DELETE /Marti/api/certadmin/cert/revoke/{comma-separated ids}`
   * returns a plain 200 with no body on success -- there is nothing
   * meaningful to unwrap from that response, so the verification step
   * (re-querying via `listCertificates()`) is what actually determines
   * the reported outcome, per Criterion 26.4's "mark the revocation
   * operation successful only if every targeted certificate id is
   * confirmed present in a revoked state in that re-queried result".
   *
   * A targeted id that is missing entirely from the re-queried list (e.g.
   * an id that never existed) is treated the same as an unverified id --
   * it cannot be confirmed revoked, so it is not reported as successful.
   *
   * @param {Array<number>} certIds
   * @returns {Promise<{success: true} | {success: false, unverified: Array<number>}>}
   */
  async revokeCertificates(certIds) {
    const idsParam = certIds.join(',');
    await this.client.delete(`/Marti/api/certadmin/cert/revoke/${idsParam}`);

    const certificates = await this.listCertificates();
    const certsById = new Map(certificates.map((cert) => [cert.id, cert]));

    const unverified = certIds.filter((id) => {
      const cert = certsById.get(id);
      return !cert || cert.revocationDate === null || cert.revocationDate === undefined;
    });

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

  return options;
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
