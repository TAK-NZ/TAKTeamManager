/**
 * ManagedIdentifierService (takserver-enrollment Requirement 1, Criteria
 * 1.7-1.9, 2.9; design.md "Minting a unique Managed_Identifier (the
 * Claim_Row)").
 *
 * `server/utils/managedIdentifier.js` generates a Managed_Identifier
 * candidate; generation is pure and can never observe a collision. This
 * module owns the part that IS impure: resolving the Organisation_Prefix a
 * candidate is built from, and retrying generation against the ONE
 * authority for uniqueness -- the `users_username_key` UNIQUE constraint on
 * `users.username`, hit by the CALLER's own single-statement
 * `INSERT ... RETURNING id`.
 *
 * This module does NOT own that INSERT. `claim(candidate)` is supplied by
 * the caller and is expected to be exactly that one statement; this module
 * owns only the retry loop and the error discrimination around it. There is
 * deliberately no pre-insert existence probe anywhere on this path -- a
 * `SELECT` before the `INSERT` races, and the window it would leave open is
 * exactly one Authentik round trip wide, the longest window in the whole
 * device/user-creation operation (Criterion 1.7).
 */

const Team = require('../models/Team');
const { generateManagedIdentifier } = require('../utils/managedIdentifier');
const { isValidCallsignPrefix } = require('../utils/callsignValidation');
const logger = require('../config/logger').createLogger('ManagedIdentifierService');

/** Bounded maximum number of generate-and-claim attempts (Criterion 1.8). */
const MAX_IDENTIFIER_ATTEMPTS = 5;

/**
 * The name of the ONE constraint that licenses a retry. Matched by EXACT
 * EQUALITY against `err.constraint`, never by `.includes()`
 * (`SignupCodeService.generateCode`'s `err.constraint.includes('code')`
 * pattern is safe on a table with one relevantly-named constraint and is
 * NOT safe here: `users` also carries `users_email_key`, and a substring
 * test on `'username'` would additionally match a future
 * `users_username_lower_key`). A `23505` on any other constraint --
 * `users_email_key` above all -- must propagate on its first occurrence
 * rather than being retried and eventually misreported as identifier
 * exhaustion (Criterion 1.8).
 */
const USERNAME_UNIQUE_CONSTRAINT = 'users_username_key';

/**
 * Thrown by `mintUniqueIdentifier` when `MAX_IDENTIFIER_ATTEMPTS`
 * consecutive candidates all violate `USERNAME_UNIQUE_CONSTRAINT`
 * (Criterion 1.9). At 31^7 = 27,512,614,111 bodies per Organisation per
 * Identifier_Type_Marker, five consecutive collisions is not bad luck --
 * it indicates a defect in the generator's random source (most plausibly a
 * fixed seed) -- so this is terminal: no other identifier form is
 * substituted, and the caller is expected to fail the whole creation.
 */
class ManagedIdentifierExhaustionError extends Error {
  constructor(organisationId, typeMarker, attempts, candidates = []) {
    super(
      `Exhausted ${attempts} Managed_Identifier mint attempt(s) for organisation ` +
      `${organisationId} (type marker ${typeMarker}). No identifier could be claimed.`
    );
    this.name = 'ManagedIdentifierExhaustionError';
    this.organisationId = organisationId;
    this.typeMarker = typeMarker;
    this.attempts = attempts;
    this.candidates = candidates;
  }
}

/**
 * Thrown by `resolveOrganisationPrefix` when the Organisation identified by
 * `organisationId` has no Organisation_Prefix that is safe to mint a
 * Managed_Identifier from -- null, empty/whitespace-only, or failing
 * `isValidCallsignPrefix` (Criterion 2.9). `claim` is never invoked when
 * this is thrown: no placeholder prefix, no team name, no team id is ever
 * substituted for a missing Organisation_Prefix.
 */
class OrganisationPrefixMissingError extends Error {
  constructor(organisationId) {
    super(
      `Organisation ${organisationId} has no Organisation_Prefix. A Managed_Identifier ` +
      'cannot be minted for it, and none was.'
    );
    this.name = 'OrganisationPrefixMissingError';
    this.organisationId = organisationId;
  }
}

class ManagedIdentifierService {
  /**
   * Resolves and validates the Organisation_Prefix (`teams.callsign_prefix`)
   * of the Organisation identified by `organisationId`. The caller is
   * responsible for having already resolved `organisationId` as the
   * Organisation itself -- typically `Team.getAncestorChain(teamId)[0].id`
   * -- never a positional read of an Ancestor_Chain's tail.
   *
   * Runs, and must complete, BEFORE the first `mintUniqueIdentifier`
   * attempt: a null, empty, whitespace-only, or otherwise invalid prefix
   * throws `OrganisationPrefixMissingError` here, before `claim` is ever
   * invoked (Criterion 2.9).
   *
   * @param {number|string} organisationId
   * @returns {Promise<string>} the validated, non-empty Organisation_Prefix
   * @throws {OrganisationPrefixMissingError}
   */
  static async resolveOrganisationPrefix(organisationId) {
    const organisation = await Team.findById(organisationId);
    const prefix = organisation?.callsign_prefix;

    if (
      typeof prefix !== 'string' ||
      prefix.trim().length === 0 ||
      !isValidCallsignPrefix(prefix)
    ) {
      throw new OrganisationPrefixMissingError(organisationId);
    }

    return prefix;
  }

  /**
   * Generates a Managed_Identifier candidate and claims it via the
   * caller-supplied `claim`, retrying on a qualifying collision, up to
   * `MAX_IDENTIFIER_ATTEMPTS` times in total.
   *
   * `claim(candidate)` MUST be the caller's own single
   * `INSERT ... RETURNING id` (or equivalent single statement). This
   * method owns the loop and the error discrimination; it does not own the
   * statement, and it performs no existence check of its own before
   * calling `claim`.
   *
   * Loop, exactly:
   * ```
   * for attempt in 1..MAX_IDENTIFIER_ATTEMPTS:
   *   candidate = generateManagedIdentifier(prefix, marker)
   *   try { return { username: candidate, claim: await claim(candidate) } }
   *   catch (err) {
   *     if (err.code === '23505' && err.constraint === USERNAME_UNIQUE_CONSTRAINT) continue
   *     throw err
   *   }
   * throw new ManagedIdentifierExhaustionError(...)
   * ```
   *
   * @param {object} params
   * @param {string} params.organisationPrefix validated Organisation_Prefix
   * @param {number|string} params.organisationId used only for logging on
   *   exhaustion, never re-validated here
   * @param {string} params.typeMarker one of `IDENTIFIER_TYPE_MARKERS`'s values
   * @param {(candidate: string) => Promise<*>} params.claim the caller's
   *   own single INSERT, keyed on `candidate` as the username
   * @returns {Promise<{ username: string, claim: * }>}
   * @throws {ManagedIdentifierExhaustionError} after `MAX_IDENTIFIER_ATTEMPTS`
   *   consecutive `USERNAME_UNIQUE_CONSTRAINT` violations
   */
  static async mintUniqueIdentifier({ organisationPrefix, organisationId, typeMarker, claim }) {
    const triedCandidates = [];

    for (let attempt = 1; attempt <= MAX_IDENTIFIER_ATTEMPTS; attempt += 1) {
      const candidate = generateManagedIdentifier(organisationPrefix, typeMarker);
      triedCandidates.push(candidate);

      try {
        const claimResult = await claim(candidate);
        return { username: candidate, claim: claimResult };
      } catch (err) {
        if (err.code === '23505' && err.constraint === USERNAME_UNIQUE_CONSTRAINT) {
          continue;
        }
        throw err;
      }
    }

    // Criterion 1.9: log the Organisation id, the type marker, the attempt
    // count AND the candidate identifiers tried. The candidates are logged
    // deliberately -- a username is not secret, and the log is worthless
    // without the evidence that distinguishes the same candidate drawn five
    // times (a fixed seed) from five different ones (a saturated space).
    logger.error(
      {
        organisationId,
        typeMarker,
        attempts: MAX_IDENTIFIER_ATTEMPTS,
        candidates: triedCandidates
      },
      'Managed_Identifier mint exhausted: all attempts collided on the username constraint'
    );

    throw new ManagedIdentifierExhaustionError(
      organisationId,
      typeMarker,
      MAX_IDENTIFIER_ATTEMPTS,
      triedCandidates
    );
  }
}

module.exports = ManagedIdentifierService;
module.exports.MAX_IDENTIFIER_ATTEMPTS = MAX_IDENTIFIER_ATTEMPTS;
module.exports.USERNAME_UNIQUE_CONSTRAINT = USERNAME_UNIQUE_CONSTRAINT;
module.exports.ManagedIdentifierExhaustionError = ManagedIdentifierExhaustionError;
module.exports.OrganisationPrefixMissingError = OrganisationPrefixMissingError;
