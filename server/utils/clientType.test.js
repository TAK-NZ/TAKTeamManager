const { CLIENT_TYPES, classifyClientType } = require('./clientType');

/**
 * device-management task 22.6: the concrete, readable per-rule example tests
 * for `classifyClientType` (Requirements 15.3, 15.4, 15.5).
 *
 * Division of labour with the sibling file: `./clientType.property.test.js`
 * (task 22.5, Correctness Property 11) quantifies totality, determinism,
 * case-invariance, precedence and rule agreement over generated inputs. This
 * file is the counterpart a reader reaches for to answer "what does
 * `ckadmin (ETL)` classify as, and why" without decoding a generator: one
 * named case per rule, pinned to a Client_Uid actually observed on the live
 * server, plus the boundaries where each rule stops applying.
 *
 * Nothing is mocked, because there is nothing to mock -- Criterion 15.1 makes
 * this a pure function of Client_Uid alone.
 */

// Real Client_Uids observed on the live TAK Server, one per rule. These are
// the examples named in the requirement text, so a change that breaks any of
// them breaks a documented case rather than a synthetic one.
const LIVE = Object.freeze({
  CLOUDTAK_ETL: 'ckadmin (ETL)',
  CLOUDTAK_WEB: 'chris@chriselsen.net (Web)',
  CLOUDTAK_ANDROID_PREFIXED: 'ANDROID-CloudTAK-chris@chriselsen.net',
  ANDROID: 'ANDROID-63040a40563b5fab',
  IOS: 'CE17C84D-9700-4080-BA5A-44AF51809453',
  WINDOWS: 'S-1-5-21-2281966494-490247268-205662872-1002',
  UNCLASSIFIABLE: 'some-random-client-name'
});

// ══════════════════════════════════════════════════════════════════════════
// Criterion 15.3: the five rules, each with its own live example.
// ══════════════════════════════════════════════════════════════════════════
describe('classifyClientType classifies each rule\'s live example (Criterion 15.3)', () => {
  it('classifies an `(ETL)` Client_Uid as CloudTAK', () => {
    expect(classifyClientType(LIVE.CLOUDTAK_ETL)).toBe(CLIENT_TYPES.CLOUDTAK);
  });

  it('classifies a `(Web)` Client_Uid as CloudTAK', () => {
    expect(classifyClientType(LIVE.CLOUDTAK_WEB)).toBe(CLIENT_TYPES.CLOUDTAK);
  });

  it('classifies a bare `CloudTAK` marker anywhere in the Client_Uid as CloudTAK', () => {
    expect(classifyClientType('session-CloudTAK-42')).toBe(CLIENT_TYPES.CLOUDTAK);
  });

  it('classifies an `ANDROID-` prefixed Client_Uid as Android / ATAK', () => {
    expect(classifyClientType(LIVE.ANDROID)).toBe(CLIENT_TYPES.ANDROID);
  });

  it('classifies a UUID Client_Uid as iOS / iTAK', () => {
    expect(classifyClientType(LIVE.IOS)).toBe(CLIENT_TYPES.IOS);
  });

  it('classifies a Windows SID Client_Uid as Windows / WinTAK', () => {
    expect(classifyClientType(LIVE.WINDOWS)).toBe(CLIENT_TYPES.WINDOWS);
  });

  it('classifies a Client_Uid matching no rule as unknown (Criterion 15.5)', () => {
    expect(classifyClientType(LIVE.UNCLASSIFIABLE)).toBe(CLIENT_TYPES.UNKNOWN);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Criterion 15.4: CloudTAK is evaluated BEFORE Android, which is why the one
// live Client_Uid that satisfies both rules is a browser session and not an
// ATAK device.
// ══════════════════════════════════════════════════════════════════════════
describe('CloudTAK outranks Android (Criterion 15.4)', () => {
  it('classifies the live `ANDROID-CloudTAK-...` Client_Uid as CloudTAK, not Android', () => {
    expect(classifyClientType(LIVE.CLOUDTAK_ANDROID_PREFIXED)).toBe(CLIENT_TYPES.CLOUDTAK);
    expect(classifyClientType(LIVE.CLOUDTAK_ANDROID_PREFIXED)).not.toBe(CLIENT_TYPES.ANDROID);
  });

  it('classifies the same Client_Uid as Android once the CloudTAK marker is removed', () => {
    // The contrast is the point: the prefix alone means Android, so the
    // CloudTAK result above comes from the precedence order and not from the
    // Android rule failing to match.
    expect(classifyClientType('ANDROID-chris@chriselsen.net')).toBe(CLIENT_TYPES.ANDROID);
  });

  it('lets an `(ETL)` marker outrank the Android prefix too', () => {
    expect(classifyClientType('ANDROID-63040a40563b5fab (ETL)')).toBe(CLIENT_TYPES.CLOUDTAK);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Criterion 15.3: the rules match case-insensitively. (The property test
// quantifies this over generated re-casings; these are the two named cases.)
// ══════════════════════════════════════════════════════════════════════════
describe('classifyClientType matches case-insensitively', () => {
  it('classifies a lowercased `(etl)` marker as CloudTAK', () => {
    expect(classifyClientType('ckadmin (etl)')).toBe(CLIENT_TYPES.CLOUDTAK);
  });

  it('classifies a lowercased `android-` prefix as Android', () => {
    expect(classifyClientType('android-63040a40563b5fab')).toBe(CLIENT_TYPES.ANDROID);
  });

  it('classifies a lowercased UUID as iOS', () => {
    expect(classifyClientType(LIVE.IOS.toLowerCase())).toBe(CLIENT_TYPES.IOS);
  });

  it('classifies a lowercased SID as Windows', () => {
    expect(classifyClientType(LIVE.WINDOWS.toLowerCase())).toBe(CLIENT_TYPES.WINDOWS);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Criterion 15.5: Unknown is a first-class outcome. A Client_Uid that only
// RESEMBLES a rule is not nudged into that rule's category.
// ══════════════════════════════════════════════════════════════════════════
describe('classifyClientType leaves near-misses unknown (Criterion 15.5)', () => {
  it('does not read `ANDROID` without its hyphen as the Android prefix', () => {
    expect(classifyClientType('ANDROID63040a40563b5fab')).toBe(CLIENT_TYPES.UNKNOWN);
  });

  it('does not read `ANDROID-` in the middle of a Client_Uid as the prefix', () => {
    // The rule is anchored at the start: a suffix match would classify a
    // desktop client whose name merely mentions Android as an ATAK device.
    expect(classifyClientType('tak-ANDROID-63040a40563b5fab')).toBe(CLIENT_TYPES.UNKNOWN);
  });

  it('rejects a UUID with an extra hex digit', () => {
    expect(classifyClientType(`${LIVE.IOS}A`)).toBe(CLIENT_TYPES.UNKNOWN);
  });

  it('rejects a UUID with a group separator missing', () => {
    expect(classifyClientType(LIVE.IOS.replace(/-/g, ''))).toBe(CLIENT_TYPES.UNKNOWN);
  });

  it('rejects a UUID-shaped string holding a non-hex character', () => {
    expect(classifyClientType('ZE17C84D-9700-4080-BA5A-44AF51809453')).toBe(CLIENT_TYPES.UNKNOWN);
  });

  it('rejects a SID from a different authority than `S-1-5-21-`', () => {
    expect(classifyClientType('S-1-5-20-2281966494-490247268-205662872-1002')).toBe(CLIENT_TYPES.UNKNOWN);
  });

  it('rejects a SID with too few sub-authority groups', () => {
    expect(classifyClientType('S-1-5-21-2281966494-490247268-205662872')).toBe(CLIENT_TYPES.UNKNOWN);
  });

  it('rejects a SID with too many sub-authority groups', () => {
    expect(classifyClientType('S-1-5-21-2281966494-490247268-205662872-1002-7')).toBe(CLIENT_TYPES.UNKNOWN);
  });

  it('does not trim: a padded UUID is a different identifier, hence unknown', () => {
    // Documented behaviour, not an oversight -- the rules are stated over the
    // Client_Uid exactly as TAK Server issued it.
    expect(classifyClientType(` ${LIVE.IOS}`)).toBe(CLIENT_TYPES.UNKNOWN);
    expect(classifyClientType(`${LIVE.WINDOWS} `)).toBe(CLIENT_TYPES.UNKNOWN);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Total and never throwing: `mapDevice()` calls this on the way out of every
// device endpoint, so one odd Client_Uid must not fail a whole list response.
// ══════════════════════════════════════════════════════════════════════════
describe('classifyClientType is total over non-string and empty input', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['the empty string', ''],
    ['a number', 12345],
    ['a boolean', true],
    ['an object', { clientUid: 'ANDROID-1' }],
    ['an array', ['ANDROID-1']]
  ])('classifies %s as unknown without throwing', (_label, value) => {
    expect(() => classifyClientType(value)).not.toThrow();
    expect(classifyClientType(value)).toBe(CLIENT_TYPES.UNKNOWN);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// The value set itself: five frozen values, shared with the client's
// `DeviceTypeIcon` so a typo cannot become a sixth, unrenderable Client_Type.
// ══════════════════════════════════════════════════════════════════════════
describe('CLIENT_TYPES', () => {
  it('exposes exactly the five Client_Types named in Criterion 15.3', () => {
    expect(Object.values(CLIENT_TYPES).sort()).toEqual([
      'android',
      'cloudtak',
      'ios',
      'unknown',
      'windows'
    ]);
  });

  it('is frozen, so a caller cannot introduce a sixth value at runtime', () => {
    expect(Object.isFrozen(CLIENT_TYPES)).toBe(true);
  });
});
