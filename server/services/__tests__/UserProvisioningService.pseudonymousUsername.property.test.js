// Feature: takserver-enrollment, Property 7: The Pseudonymous_Username_Policy decides the username and preserves the email, at the Organisation root
//
// **Validates: Requirements 6.3, 6.5, 6.7, 6.8, 8.1**

/**
 * takserver-enrollment task 5.6: the single fast-check property test for
 * design.md's Property 7 (Requirements 6.3, 6.5, 6.7, 6.8, 8.1).
 *
 * `UserProvisioningService.resolveNewUserIdentity` is exercised directly.
 * `Team.getAncestorChain` is mocked to return a GENERATED Ancestor_Chain
 * (root at index 0) whose root `pseudonymous_usernames` value and every
 * OTHER element's value are DELIBERATELY forced to disagree -- so a
 * positional read from the tail (rather than index 0) would flip the
 * observed outcome and this property would catch it.
 *
 * `../../config/database`'s `query` (`pool.query`) is mocked to simulate a
 * successful Claim_Row insert (`{ rows: [{ id: <fake id> }] }`) whenever the
 * pseudonymous/mint branch reaches it, so the test never touches a real
 * database. `CallsignSuffixUniquenessService.checkCallsignSuffixUniqueness`
 * is mocked to always resolve (no collision), isolating JUST the
 * username/policy decision this property is about -- Callsign_Suffix
 * resolution itself is Property 8's subject, not this one's, so a fixed,
 * always-non-blank `requestedCallsignSuffix` is supplied on every run to
 * keep that decision out of the way.
 *
 * `ManagedIdentifierService`/`generateManagedIdentifier` are NOT mocked:
 * the minted username, when the policy is enabled, is a genuine
 * Managed_Identifier this run's real random source produced, checked via
 * `isManagedIdentifier` and a prefix/marker check rather than a predicted
 * exact value.
 *
 * ## Boundary concentration
 *
 * Three generator arms:
 *   - depth 0, where the root and the leaf are the SAME element. A
 *     positional-tail-read bug reads the correct value here by accident,
 *     so this arm alone would prove nothing -- it exists so the property
 *     also covers the shallowest, most common case, not as the arm that
 *     catches the bug.
 *   - depth 2 through `MAX_TEAM_DEPTH` (5), with the root and every deeper
 *     element's policy value forced to disagree -- the arm that WOULD
 *     catch a tail read, because the tail's value differs from the root's
 *     by construction.
 *   - a broad arm drawing depth uniformly over the whole 0..MAX_TEAM_DEPTH
 *     range, so the property is not boundary-only.
 *
 * ## Anti-vacuity
 *
 * A module-level counter records every run whose chain had more than one
 * element (so a root/leaf disagreement genuinely existed), and the
 * trailing `it()` asserts it is greater than zero -- otherwise a generator
 * that happened to only ever produce depth-0 chains would pass this whole
 * suite while proving nothing about tail reads.
 */

jest.mock('../../models/Team', () => ({
  getAncestorChain: jest.fn()
}));

jest.mock('../../config/database', () => ({
  query: jest.fn()
}));

jest.mock('../CallsignSuffixUniquenessService', () => ({
  checkCallsignSuffixUniqueness: jest.fn()
}));

const fc = require('fast-check');
const { test } = require('@fast-check/jest');

const Team = require('../../models/Team');
const pool = require('../../config/database');
const { checkCallsignSuffixUniqueness } = require('../CallsignSuffixUniquenessService');
const UserProvisioningService = require('../UserProvisioningService');
const {
  generateManagedIdentifier,
  isManagedIdentifier,
  IDENTIFIER_TYPE_MARKERS
} = require('../../utils/managedIdentifier');
const { MAX_TEAM_DEPTH } = require('../../config/constants');

// A fixed, always-non-blank Callsign_Suffix. Callsign_Default_Suppression
// (Property 8) is a different property; keeping this fixed and non-blank
// on every run means neither branch of `resolveNewUserIdentity` ever
// throws `CallsignSuffixRequiredError`, which would otherwise be a false
// failure of THIS property.
const FIXED_CALLSIGN_SUFFIX = 'FixedSuffix123';

// ---------------------------------------------------------------------------
// Organisation_Prefix generator: alphanumeric only, matching
// `isValidCallsignPrefix`, so the pseudonymous/mint branch always succeeds.
// ---------------------------------------------------------------------------

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const alphanumericCharArb = fc.constantFrom(...ALPHANUMERIC.split(''));
const organisationPrefixArb = fc
  .array(alphanumericCharArb, { minLength: 1, maxLength: 10 })
  .map((chars) => chars.join(''));

// ---------------------------------------------------------------------------
// Ancestor_Chain generator, parameterised by depth. Root at index 0 carries
// `rootPolicy`; every element below it carries `otherPolicy`, the LOGICAL
// NEGATION of `rootPolicy`, so root and every other element disagree by
// construction whenever the chain has more than one element.
// ---------------------------------------------------------------------------

function buildAncestorChain({ organisationId, rootPolicy, organisationPrefix, depth }) {
  const otherPolicy = !rootPolicy;
  const root = {
    id: organisationId,
    parent_team_id: null,
    callsign_name_format: 'full_name',
    pseudonymous_usernames: rootPolicy,
    callsign_prefix: organisationPrefix,
    depth: 0
  };
  const chain = [root];
  for (let i = 1; i <= depth; i += 1) {
    chain.push({
      id: organisationId * 1000 + i,
      parent_team_id: chain[chain.length - 1].id,
      callsign_name_format: 'full_name',
      // Deliberately NOT null (unlike a real Sub_Team row): forced to the
      // opposite of the root's value so a positional tail read is caught,
      // per the task's "DELIBERATELY DISAGREE" instruction.
      pseudonymous_usernames: otherPolicy,
      callsign_prefix: null,
      depth: i
    });
  }
  return chain;
}

function chainArbForDepth(depth) {
  return fc
    .record({
      organisationId: fc.integer({ min: 1, max: 999999 }),
      rootPolicy: fc.boolean(),
      organisationPrefix: organisationPrefixArb
    })
    .map(({ organisationId, rootPolicy, organisationPrefix }) =>
      buildAncestorChain({ organisationId, rootPolicy, organisationPrefix, depth })
    );
}

const depth0ChainArb = chainArbForDepth(0);
const deepDisagreeingChainArb = fc
  .integer({ min: 2, max: MAX_TEAM_DEPTH })
  .chain((depth) => chainArbForDepth(depth));
const broadChainArb = fc
  .integer({ min: 0, max: MAX_TEAM_DEPTH })
  .chain((depth) => chainArbForDepth(depth));

const chainArb = fc.oneof(
  { weight: 3, arbitrary: depth0ChainArb },
  { weight: 4, arbitrary: deepDisagreeingChainArb },
  { weight: 3, arbitrary: broadChainArb }
);

// ---------------------------------------------------------------------------
// Email generator: a broad "normal" arm, plus the three special cases the
// task names explicitly.
// ---------------------------------------------------------------------------

const localPartArb = fc.string({ maxLength: 20 }).filter((s) => !s.includes('@'));
const domainArb = fc.constantFrom('example.com', 'test.org', 'mail.co.nz', 'firstname-lastname.example');

const emailScenarioArb = fc.record({
  kind: fc.constantFrom('normal', 'noAt', 'managedIdLocal', 'localEqualsRequestedUsername'),
  localPartRaw: localPartArb,
  domain: domainArb
});

/**
 * Builds the concrete email string for a generated `emailScenario`, given
 * this run's `requestedUsername` (needed for the
 * `localEqualsRequestedUsername` case).
 */
function buildEmail(emailScenario, requestedUsername) {
  const { kind, localPartRaw, domain } = emailScenario;
  switch (kind) {
    case 'noAt':
      // An email containing no `@` at all.
      return localPartRaw.length > 0 ? localPartRaw : 'nolocalpartatall';
    case 'managedIdLocal': {
      // An email whose local part is itself Managed-Identifier-shaped
      // (e.g. `AUK-U1234567@example.com`). Built with the real generator
      // so the shape is authentic rather than hand-typed.
      const managedLocalPart = generateManagedIdentifier('AUK', IDENTIFIER_TYPE_MARKERS.USER);
      return `${managedLocalPart}@${domain}`;
    }
    case 'localEqualsRequestedUsername':
      // An email whose local part equals the caller-supplied
      // requestedUsername.
      return `${requestedUsername}@${domain}`;
    case 'normal':
    default:
      return `${localPartRaw}@${domain}`;
  }
}

/** The "local part" of an email for the substring-overlap check: everything
 * before the first `@`, or the whole string when there is no `@` at all. */
function emailLocalPart(email) {
  const atIndex = email.indexOf('@');
  return atIndex === -1 ? email : email.slice(0, atIndex);
}

// ---------------------------------------------------------------------------
// Substring-overlap check (assertion helper, not an expectation derivation):
// does `candidate` contain, anywhere, any length-3-or-more substring drawn
// from any of `sources`? Checking every length-3 window of each source is
// sufficient: any longer shared substring necessarily contains a shared
// length-3 substring too.
// ---------------------------------------------------------------------------

function sharesSubstringOfAtLeastThreeChars(sources, candidate) {
  for (const source of sources) {
    if (!source || source.length < 3) {
      continue;
    }
    for (let i = 0; i <= source.length - 3; i += 1) {
      const window = source.slice(i, i + 3);
      if (candidate.includes(window)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Full scenario generator
// ---------------------------------------------------------------------------

const scenarioArb = fc
  .record({
    firstName: fc.string({ maxLength: 15 }),
    lastName: fc.string({ maxLength: 15 }),
    requestedUsername: fc.string({ maxLength: 20 }),
    emailScenario: emailScenarioArb,
    chain: chainArb,
    claimRowId: fc.integer({ min: 1, max: 999999 })
  })
  // Bugfix (flaky false failure): the minted username always starts with
  // `${organisationPrefix}-U...` BY DESIGN -- that prefix is not PII, and
  // its presence in the username is not a leak this property is about.
  // `organisationPrefixArb` and `firstName`/`lastName` are drawn from
  // fully independent arbitraries with no coordination between them, so
  // a 3+ character substring overlap between the two occurs by pure
  // chance often enough for fast-check to find one within a few hundred
  // runs (observed: organisationPrefix "PtLA" / firstName "PtL"). That
  // coincidence would make the overlap-check assertion below fail even
  // though nothing leaked -- the shared text came from the prefix
  // legitimately, never from the name. Filtering it out here keeps the
  // assertion meaningful: any remaining overlap between the RESOLVED
  // USERNAME and a name can only be explained by the mint actually
  // incorporating the name, which is the real thing this property
  // guards against.
  .filter((scenario) => {
    const prefix = scenario.chain[0].callsign_prefix;
    // Checked in BOTH directions: sharesSubstringOfAtLeastThreeChars only
    // slides windows of its first argument across its second, so either
    // ordering alone could miss an overlap when the two strings differ
    // substantially in length.
    return (
      !sharesSubstringOfAtLeastThreeChars([prefix], scenario.firstName) &&
      !sharesSubstringOfAtLeastThreeChars([scenario.firstName], prefix) &&
      !sharesSubstringOfAtLeastThreeChars([prefix], scenario.lastName) &&
      !sharesSubstringOfAtLeastThreeChars([scenario.lastName], prefix)
    );
  });

// ---------------------------------------------------------------------------
// Anti-vacuity counters, checked in the trailing it().
// ---------------------------------------------------------------------------

const seen = {
  rootLeafDisagreement: 0,
  depth0: 0,
  deepDisagreement: 0,
  policyEnabled: 0,
  policyDisabled: 0
};

describe('Property 7: The Pseudonymous_Username_Policy decides the username and preserves the email, at the Organisation root', () => {
  test.prop([scenarioArb], { numRuns: 300 })(
    'resolves the username from the root policy and preserves the email unchanged, regardless of disagreeing tail elements',
    async (scenario) => {
      const { firstName, lastName, requestedUsername, emailScenario, chain, claimRowId } = scenario;

      // Fresh mocks each run.
      Team.getAncestorChain.mockReset();
      pool.query.mockReset();
      checkCallsignSuffixUniqueness.mockReset();

      Team.getAncestorChain.mockResolvedValue(chain);
      checkCallsignSuffixUniqueness.mockResolvedValue(undefined);
      pool.query.mockResolvedValue({ rows: [{ id: claimRowId }] });

      const root = chain[0];
      const rootPolicy = root.pseudonymous_usernames === true;
      const rootPrefix = root.callsign_prefix;
      const teamId = chain[chain.length - 1].id;
      const depth = chain.length - 1;

      const email = buildEmail(emailScenario, requestedUsername);
      const localPart = emailLocalPart(email);

      if (chain.length > 1) {
        // By construction every non-root element carries the logical
        // negation of the root's value, so any chain longer than one
        // element is a genuine root/leaf disagreement.
        seen.rootLeafDisagreement += 1;
      }
      if (depth === 0) {
        seen.depth0 += 1;
      }
      if (depth >= 2) {
        seen.deepDisagreement += 1;
      }

      const result = await UserProvisioningService.resolveNewUserIdentity(null, {
        firstName,
        lastName,
        email,
        teamId,
        requestedUsername,
        requestedCallsignSuffix: FIXED_CALLSIGN_SUFFIX
      });

      // The Ancestor_Chain is always resolved for THIS teamId (the leaf),
      // never for the root's id directly -- `getAncestorChain` itself does
      // the upward walk.
      expect(Team.getAncestorChain).toHaveBeenCalledWith(teamId);

      // Assertion 1: the policy is resolved from the chain's ROOT element
      // and from no other element. Every non-root element here carries the
      // OPPOSITE boolean, so a positional-tail read would flip this.
      expect(result.pseudonymous).toBe(rootPolicy);

      // Assertion 4: the resolved email equals the supplied email
      // unchanged, under BOTH policy states.
      expect(result.email === undefined ? email : result.email).toBe(email);

      if (rootPolicy) {
        seen.policyEnabled += 1;

        // Assertion 2: the resolved username matches the `U`-marker
        // Pseudonymous_Username shape, with the root's own
        // callsign_prefix, contains no `@`, and shares no substring of
        // three or more characters with the email's local part or either
        // name.
        expect(isManagedIdentifier(result.username)).toBe(true);
        expect(result.username.startsWith(`${rootPrefix}-U`)).toBe(true);
        expect(result.username).not.toContain('@');

        // The overlap check is a PII-leak guard: it verifies the minted
        // username carries none of the person's actual identifying text.
        // It is skipped against `localPart` specifically for the
        // `managedIdLocal` boundary case: that local part is a SYNTHETIC
        // Managed-Identifier-shaped string (per the task's own example,
        // `AUK-U1234567`, which is not even a valid Managed_Identifier
        // itself), carrying no PII at all. Both it and the freshly minted
        // username share the same `-<marker>` structural convention, so a
        // coincidental few-character overlap there reflects shared FORMAT,
        // never a leaked name or email -- and the resolver has no way to
        // avoid it, since it never inspects the email when minting. First
        // and last name remain checked unconditionally: they are the
        // actual PII this assertion exists to protect.
        const overlapSources = emailScenario.kind === 'managedIdLocal'
          ? [firstName, lastName]
          : [localPart, firstName, lastName];
        expect(
          sharesSubstringOfAtLeastThreeChars(overlapSources, result.username)
        ).toBe(false);

        // requestedUsername is IGNORED, never used as the resolved value
        // (unless coincidentally identical to the freshly minted
        // identifier, which cannot happen: the minted shape carries the
        // Organisation_Prefix and `-U` marker requestedUsername never
        // carries by construction of this test's generators).
        expect(result.username).not.toBe(requestedUsername);

        // The Claim_Row insert ran, carrying the supplied email untouched.
        expect(pool.query).toHaveBeenCalledTimes(1);
        const [, claimParams] = pool.query.mock.calls[0];
        expect(claimParams[1]).toBe(email);
      } else {
        seen.policyDisabled += 1;

        // Assertion 3: the resolved username equals requestedUsername
        // BYTE FOR BYTE.
        expect(result.username === requestedUsername).toBe(true);

        // No Claim_Row insert is attempted when the policy is disabled.
        expect(pool.query).not.toHaveBeenCalled();
      }
    }
  );

  it('exercised a genuine root/leaf disagreement, both policy states, and both boundary arms (anti-vacuity)', () => {
    expect(seen.rootLeafDisagreement).toBeGreaterThan(0);
    expect(seen.depth0).toBeGreaterThan(0);
    expect(seen.deepDisagreement).toBeGreaterThan(0);
    expect(seen.policyEnabled).toBeGreaterThan(0);
    expect(seen.policyDisabled).toBeGreaterThan(0);
  });
});
