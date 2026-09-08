const fs = require('fs');
const forge = require('node-forge');
const TakServerService = require('./TakServerService');
const { getSecretsProvider, AwsSecretsManagerProvider } = require('../config/secretsProvider');
const logger = require('../config/logger').createLogger('AdminCredentialLoader');

/**
 * Admin_Credential_Loader (device-management Requirement 2).
 *
 * Single source of the TAK Server admin mutual-TLS credential for BOTH the
 * existing `revoke_tak_certificates` Sync_Worker handler and the new
 * device-management jobs (Requirement 2.8), so a rotated credential is
 * picked up by both without a process restart.
 *
 * Responsibilities implemented here (task 3.2):
 *  - **Source selection** (Requirement 2.1): `TAK_ADMIN_CERT_SOURCE` selects
 *    `secrets-manager` or `file`; anything else (including unset) resolves to
 *    `file`, preserving the current behavior exactly.
 *  - **Load** (Requirements 2.2, 2.4, 2.5, 2.9):
 *      * `secrets-manager`: a Binary_Secret_Read of `TAK_ADMIN_CERT_SECRET_ARN`
 *        via the Secrets_Provider (`getSecretBinary` -> Buffer), then a
 *        PKCS#12 -> PEM conversion using P12_Passphrase, cached as
 *        `{ cert, key }` (+ `{ ca }` when a CA bundle is configured).
 *      * `file`: `TakServerService.buildMutualTlsAgentOptions(env)`, reused
 *        unchanged. File/environment credentials are NEVER consulted when the
 *        source is `secrets-manager` (Requirement 2.9).
 *  - **Cache + accessor**: `getAgentOptions()` returns the currently-cached
 *    `https.Agent` options.
 *  - **Refresh** (Requirements 2.7, 2.10): `refresh()` re-reads the configured
 *    source; on changed material it swaps the cache and rebuilds the shared
 *    `TakServerService`'s mutual-TLS agent; on any failure it retains the
 *    previously cached credential, logs, and returns without throwing so the
 *    scheduled job (and the Sync_Worker process) survives to retry.
 *
 * Why convert PKCS#12 to PEM instead of handing Node the raw bundle as `pfx`
 * (Requirements 2.5, 2.12): the reference TAK admin bundle uses legacy PKCS#12
 * algorithms (RC2/3DES) that OpenSSL 3 refuses to load unless the legacy
 * provider is explicitly enabled in the Node runtime. `node-forge` implements
 * those algorithms in JavaScript, so converting at load time keeps
 * legacy-algorithm bundles working on a stock Node runtime.
 *
 * Secret hygiene (Requirement 2.11): this module NEVER logs the credential
 * material (bundle bytes, certificate, private key) or the P12_Passphrase at
 * any level. Log lines carry only the selected source and coarse shape
 * information (which fields are present), never values.
 */

/** Credential_Source values (Requirement 2.1). */
const SOURCE_SECRETS_MANAGER = 'secrets-manager';
const SOURCE_FILE = 'file';

/**
 * P12_Passphrase default (Requirement 2.4): the well-known TAK value used
 * when `TAK_ADMIN_CERT_PASSPHRASE` is not configured. Treated as sensitive
 * and never logged, like any configured override.
 */
const DEFAULT_P12_PASSPHRASE = 'atakatak';

class AdminCredentialLoader {
  /**
   * @param {Object} [options]
   * @param {import('./TakServerService')} [options.takServerService] the single
   *   shared `TakServerService` instance whose agent is rebuilt on a credential
   *   change (Requirements 2.7, 2.8). Used by `refresh()`; unused by `load()`.
   * @param {NodeJS.ProcessEnv} [options.env] defaults to `process.env`;
   *   overridable for testing without touching real environment state.
   * @param {{getSecretBinary: function(string): Promise<Buffer>}} [options.secretsProvider]
   *   defaults to the provider `getSecretsProvider(env)` selects
   *   (Requirement 2.2).
   */
  constructor({ takServerService, env = process.env, secretsProvider } = {}) {
    this.takServerService = takServerService;
    this.env = env;
    // Provider selection for the BINARY P12 read. When the Credential_Source is
    // `secrets-manager`, use the AWS Secrets Manager provider DIRECTLY,
    // independent of the global `SECRETS_PROVIDER` switch. This mirrors how
    // CloudTAK reads its admin P12 (a bespoke, env-presence-triggered
    // GetSecretValue -> SecretBinary fetch), and — critically — decouples this
    // binary read from `getSecretsProvider(env)`. Routing it through the global
    // switch forced a choice between two broken states: without
    // SECRETS_PROVIDER=aws-secrets-manager the P12 read fell through to the env
    // provider and failed ("binary secret ... missing in process.env"); WITH it
    // set, `validateProductionSecrets` then tried to resolve
    // AUTHENTIK_API_TOKEN/JWT_SECRET/DB_PASSWORD/EMAIL_PASSWORD by NAME through
    // Secrets Manager (they are ECS-injected env vars, not SM secrets) and
    // crashed startup. Selecting the AWS provider here, only for the P12,
    // avoids both. An explicitly injected `secretsProvider` (tests) still wins.
    if (secretsProvider) {
      this.secretsProvider = secretsProvider;
    } else if (this.selectSource(env) === SOURCE_SECRETS_MANAGER) {
      this.secretsProvider = new AwsSecretsManagerProvider({ region: env.AWS_REGION });
    } else {
      this.secretsProvider = getSecretsProvider(env);
    }

    /**
     * The cached Admin_Credential as `https.Agent` mutual-TLS options, or
     * `null` until the first successful `load()`.
     *
     * @type {import('https').AgentOptions | null}
     */
    this.agentOptions = null;
  }

  /**
   * Requirement 2.1: resolves Credential_Source from the environment.
   *
   * Only the exact string `secrets-manager` selects Secrets Manager; every
   * other value -- including `file`, an unset variable, and any typo -- falls
   * back to `file`, so the default preserves the current file/environment
   * behavior rather than failing closed on an unrecognized value.
   *
   * @param {NodeJS.ProcessEnv} [env] defaults to the instance's env.
   * @returns {'secrets-manager' | 'file'}
   */
  selectSource(env = this.env) {
    const source = (env || {}).TAK_ADMIN_CERT_SOURCE;
    return source === SOURCE_SECRETS_MANAGER ? SOURCE_SECRETS_MANAGER : SOURCE_FILE;
  }

  /**
   * Loads the Admin_Credential from the configured Credential_Source and
   * caches it as `https.Agent` mutual-TLS options (Requirements 2.2, 2.4,
   * 2.5, 2.9).
   *
   * Errors are allowed to propagate: an initial load failure is a
   * configuration problem the caller should surface. Retaining a previously
   * cached credential on failure is `refresh()`'s job (Requirement 2.10).
   *
   * @returns {Promise<void>}
   */
  async load() {
    this.agentOptions = await this.readAgentOptions();
  }

  /**
   * Re-reads the Admin_Credential from the configured Credential_Source and,
   * WHEN the material changed, swaps the cache and rebuilds the shared
   * `TakServerService`'s mutual-TLS agent so subsequent Marti `certadmin`
   * calls use the rotated credential without a process restart
   * (Requirement 2.7).
   *
   * Never throws (Requirement 2.10). This is called from a scheduled job, so
   * an unhandled rejection here would take down the Sync_Worker process; a
   * failed read (Secrets Manager outage, an unreadable file, a bundle that
   * will not open) instead leaves the previously cached credential in place --
   * which is still the working credential until it actually expires -- logs
   * the failure via the Structured_Logger, and lets the next scheduled refresh
   * retry.
   *
   * The cache is only swapped once the agent rebuild has succeeded: if
   * installing the new agent fails, the previous credential is restored so the
   * cache never advertises material the shared service is not actually using.
   *
   * Requirement 2.11: no log line here carries credential material, the
   * passphrase, or any comparison of their values -- only the source, whether
   * a change was detected, and which fields are present.
   *
   * @returns {Promise<boolean>} `true` when a changed credential was cached
   *   and the shared agent rebuilt, `false` when the material was unchanged or
   *   the refresh failed.
   */
  async refresh() {
    const source = this.selectSource(this.env);

    let next;
    try {
      next = await this.readAgentOptions();
    } catch (error) {
      logger.error(
        { err: error, source, hasCachedCredential: this.agentOptions !== null },
        'TAK admin credential refresh failed; retaining the previously cached credential and retrying on the next scheduled refresh'
      );
      return false;
    }

    if (this.agentOptions !== null && agentOptionsEqual(this.agentOptions, next)) {
      logger.debug({ source }, 'TAK admin credential refresh found no change; keeping the cached credential');
      return false;
    }

    const previous = this.agentOptions;
    this.agentOptions = next;

    try {
      this.applyToTakServerService();
    } catch (error) {
      this.agentOptions = previous;
      logger.error(
        { err: error, source },
        'TAK admin credential refresh could not rebuild the shared TAK Server agent; retaining the previously cached credential'
      );
      return false;
    }

    logger.info(
      { source, rotated: previous !== null },
      'Swapped the cached TAK admin credential and rebuilt the shared TAK Server agent'
    );

    return true;
  }

  /**
   * Notifies the shared `TakServerService` that the cached credential changed,
   * so it rebuilds its `https.Agent` in place and every existing holder of
   * that instance -- the Sync_Worker's `revoke_tak_certificates` handler and
   * the device-management jobs alike -- uses the rotated credential
   * (Requirements 2.7, 2.8).
   *
   * `refreshAgent()` is preferred because it pulls from this Loader's cache
   * (the service is wired up with `setCredentialLoader(this)`), keeping the
   * two in lockstep; `setAgentOptions` is the fallback for a service that has
   * no Loader attached. A service without either method (or no service at all,
   * as in unit tests of `load()`) is a no-op rather than an error: the cache is
   * still authoritative and the next `refreshAgent()` call would pick it up.
   *
   * Errors propagate to `refresh()`, which restores the previous cache entry.
   *
   * @returns {boolean} whether a shared agent was actually rebuilt.
   */
  applyToTakServerService() {
    const service = this.takServerService;
    if (!service) {
      return false;
    }

    if (typeof service.refreshAgent === 'function') {
      service.refreshAgent();
      return true;
    }

    if (typeof service.setAgentOptions === 'function') {
      service.setAgentOptions(this.agentOptions);
      return true;
    }

    return false;
  }

  /**
   * Reads (but does not cache) the Admin_Credential from the configured
   * source. Kept separate from `load()` so a later `refresh()` can obtain new
   * material and decide whether to swap the cache without ever clobbering it
   * on failure.
   *
   * @returns {Promise<import('https').AgentOptions>}
   */
  async readAgentOptions() {
    const source = this.selectSource(this.env);

    const agentOptions = source === SOURCE_SECRETS_MANAGER
      ? await this.readFromSecretsManager()
      : TakServerService.buildMutualTlsAgentOptions(this.env);

    // Requirement 2.11: shape only, never values.
    logger.info(
      {
        source,
        hasCert: Boolean(agentOptions.cert),
        hasKey: Boolean(agentOptions.key),
        hasPfx: Boolean(agentOptions.pfx),
        hasCa: Boolean(agentOptions.ca)
      },
      'Loaded TAK admin credential'
    );

    return agentOptions;
  }

  /**
   * Requirements 2.2, 2.4, 2.5, 2.12: reads the PKCS#12 Admin_Credential from
   * Admin_Cert_Secret_Arn as raw bytes via the Secrets_Provider's
   * Binary_Secret_Read, converts it to PEM, and returns mutual-TLS options.
   *
   * No file or environment credential is read on this path (Requirement 2.9);
   * the only environment values consulted are the secret id, the passphrase
   * override, and the optional CA bundle path (trust material, not a
   * credential -- it authenticates the server to us, not us to the server).
   *
   * @returns {Promise<import('https').AgentOptions>}
   */
  async readFromSecretsManager() {
    const secretId = this.env.TAK_ADMIN_CERT_SECRET_ARN;
    if (typeof secretId !== 'string' || secretId.trim().length === 0) {
      throw new Error(
        'AdminCredentialLoader: TAK_ADMIN_CERT_SOURCE is "secrets-manager" but ' +
          'TAK_ADMIN_CERT_SECRET_ARN is not set'
      );
    }

    const bundle = await this.secretsProvider.getSecretBinary(secretId.trim());
    if (!Buffer.isBuffer(bundle) || bundle.length === 0) {
      throw new Error(
        `AdminCredentialLoader: binary secret "${secretId.trim()}" did not yield any PKCS#12 bytes`
      );
    }

    const { cert, key } = convertP12ToPem(bundle, this.resolvePassphrase());

    const agentOptions = { cert, key };

    const ca = readCaBundle(this.env);
    if (ca !== undefined) {
      agentOptions.ca = ca;
    }

    return agentOptions;
  }

  /**
   * Requirement 2.4: resolves P12_Passphrase -- `TAK_ADMIN_CERT_PASSPHRASE`
   * when it is set to a non-empty value, otherwise the `atakatak` default.
   *
   * A blank/whitespace-only override is treated as unset rather than as a
   * genuine empty passphrase, matching how every other optional string env var
   * in this codebase is interpreted. The returned value is sensitive and is
   * never logged (Requirement 2.11).
   *
   * @returns {string}
   */
  resolvePassphrase() {
    const configured = this.env.TAK_ADMIN_CERT_PASSPHRASE;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured;
    }
    return DEFAULT_P12_PASSPHRASE;
  }

  /**
   * @returns {import('https').AgentOptions | null} the currently-cached
   *   Admin_Credential as `https.Agent` options, or `null` when `load()` has
   *   not yet completed successfully.
   */
  getAgentOptions() {
    return this.agentOptions;
  }
}

/**
 * Pure predicate: do two sets of `https.Agent` mutual-TLS options carry the
 * same material? Used by `refresh()` to decide whether a reload actually
 * rotated the credential (Requirement 2.7's "WHEN a refresh yields a changed
 * Admin_Credential"), so an unchanged bundle does not needlessly tear down and
 * rebuild the shared agent under in-flight requests.
 *
 * Compares the union of both objects' own keys so every credential field
 * matters -- `cert`/`key` on the secrets-manager path, `pfx`/`passphrase` on
 * the file path, and `ca` on either -- without this helper needing to know
 * which shape it was handed. A field this comparison cannot interpret is
 * treated as changed, which errs toward rebuilding rather than toward silently
 * continuing to use a stale credential.
 *
 * @param {import('https').AgentOptions} a
 * @param {import('https').AgentOptions} b
 * @returns {boolean}
 */
function agentOptionsEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!materialEquals(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Pure equality for a single agent-option value. Certificate/key material may
 * arrive as a Buffer (file reads, `getSecretBinary`) or a string (the PEM the
 * P12 conversion produces), and `ca` may be an array of either, so values are
 * normalized to bytes before comparison rather than compared by reference.
 *
 * Anything that is neither Buffer, string, nor array falls through to the
 * reference/primitive check at the top.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function materialEquals(a, b) {
  if (a === b) {
    return true;
  }

  const aMissing = a === undefined || a === null;
  const bMissing = b === undefined || b === null;
  if (aMissing || bMissing) {
    return aMissing && bMissing;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => materialEquals(item, b[index]));
  }

  const bufferA = toComparableBuffer(a);
  const bufferB = toComparableBuffer(b);
  if (bufferA === null || bufferB === null) {
    return false;
  }

  return bufferA.equals(bufferB);
}

/**
 * @param {unknown} value
 * @returns {Buffer | null} the value's bytes, or `null` when it is not
 *   byte-comparable material.
 */
function toComparableBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  return null;
}

/**
 * Reads the optional CA trust bundle referenced by `TAK_CA_PATH`, the same
 * variable the existing file path uses, so a self-signed TAK Server remains
 * verifiable under either Credential_Source (Requirement 2.5's
 * "with `{ ca }` when a CA bundle is configured").
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Buffer | undefined} the bundle bytes, or `undefined` when no CA
 *   bundle is configured.
 */
function readCaBundle(env) {
  const caPath = env.TAK_CA_PATH;
  if (typeof caPath !== 'string' || caPath.trim().length === 0) {
    return undefined;
  }
  return fs.readFileSync(caPath);
}

/**
 * Converts a PKCS#12 bundle to PEM certificate/private-key material
 * (Requirements 2.5, 2.12).
 *
 * Implemented with `node-forge`'s pure-JavaScript PKCS#12 reader
 * (`forge.pkcs12.pkcs12FromAsn1`) so bundles encrypted with legacy algorithms
 * (RC2/3DES) load without the OpenSSL legacy provider being enabled.
 *
 * The leaf certificate is identified as the one whose public key matches the
 * bundle's private key; any additional certificates in the bundle are the
 * issuing chain and are deliberately not returned (TAK Server already holds
 * the issuing CA, and overriding the agent's trust store is `TAK_CA_PATH`'s
 * job). When no certificate's public key matches -- e.g. a bundle carrying a
 * single certificate whose key type forge cannot compare -- the first
 * certificate is used.
 *
 * Errors are wrapped with a descriptive message. Neither the passphrase nor
 * any credential material is included in the message or logged
 * (Requirement 2.11); `node-forge`'s own errors (such as a MAC verification
 * failure on a wrong passphrase) do not embed the passphrase either.
 *
 * @param {Buffer} p12Buffer the raw PKCS#12 bytes.
 * @param {string} passphrase P12_Passphrase (sensitive; never logged).
 * @returns {{cert: string, key: string}} PEM material.
 */
function convertP12ToPem(p12Buffer, passphrase) {
  let p12;
  try {
    // `fromDer` consumes a binary (latin1) string of the DER bytes.
    const asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
  } catch (err) {
    throw new Error(
      `AdminCredentialLoader: failed to open the PKCS#12 admin credential bundle: ${err.message}`,
      { cause: err }
    );
  }

  const privateKey = extractPrivateKey(p12);
  if (!privateKey) {
    throw new Error(
      'AdminCredentialLoader: the PKCS#12 admin credential bundle contains no private key'
    );
  }

  const certificates = extractCertificates(p12);
  if (certificates.length === 0) {
    throw new Error(
      'AdminCredentialLoader: the PKCS#12 admin credential bundle contains no certificate'
    );
  }

  const leaf = certificates.find((cert) => matchesPrivateKey(cert, privateKey)) || certificates[0];

  return {
    cert: forge.pki.certificateToPem(leaf),
    key: forge.pki.privateKeyToPem(privateKey)
  };
}

/**
 * Pulls the private key out of a parsed PKCS#12, accepting either an
 * encrypted (`pkcs8ShroudedKeyBag`, the usual TAK case) or an unencrypted
 * (`keyBag`) key bag.
 *
 * @param {object} p12 a `pkcs12FromAsn1` result.
 * @returns {object | undefined} a forge private key, or `undefined`.
 */
function extractPrivateKey(p12) {
  const bagTypes = [forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag];

  for (const bagType of bagTypes) {
    const bags = p12.getBags({ bagType })[bagType] || [];
    const withKey = bags.find((bag) => bag && bag.key);
    if (withKey) {
      return withKey.key;
    }
  }

  return undefined;
}

/**
 * @param {object} p12 a `pkcs12FromAsn1` result.
 * @returns {Array<object>} every certificate in the bundle, in bag order.
 */
function extractCertificates(p12) {
  const bagType = forge.pki.oids.certBag;
  const bags = p12.getBags({ bagType })[bagType] || [];
  return bags.map((bag) => bag && bag.cert).filter(Boolean);
}

/**
 * Pure predicate: does `cert`'s public key belong to `privateKey`? Compares
 * the RSA modulus and public exponent, which is what distinguishes the leaf
 * certificate from the issuing chain inside a bundle.
 *
 * @param {object} cert a forge certificate.
 * @param {object} privateKey a forge private key.
 * @returns {boolean} false when either key lacks comparable RSA components.
 */
function matchesPrivateKey(cert, privateKey) {
  const publicKey = cert && cert.publicKey;
  if (!publicKey || !publicKey.n || !publicKey.e || !privateKey.n || !privateKey.e) {
    return false;
  }
  return publicKey.n.compareTo(privateKey.n) === 0 && publicKey.e.compareTo(privateKey.e) === 0;
}

module.exports = AdminCredentialLoader;
module.exports.convertP12ToPem = convertP12ToPem;
module.exports.agentOptionsEqual = agentOptionsEqual;
module.exports.SOURCE_SECRETS_MANAGER = SOURCE_SECRETS_MANAGER;
module.exports.SOURCE_FILE = SOURCE_FILE;
module.exports.DEFAULT_P12_PASSPHRASE = DEFAULT_P12_PASSPHRASE;
