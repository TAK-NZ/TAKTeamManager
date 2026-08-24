jest.mock('../config/database', () => ({
  query: jest.fn()
}));

const pool = require('../config/database');
const SiteConfig = require('./SiteConfig');

describe('SiteConfig.update HTML sanitization', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  function mockUpdateReturns(row) {
    pool.query.mockResolvedValue({ rows: [row] });
  }

  test('strips <script> tags before persisting', async () => {
    mockUpdateReturns({ config_key: 'request_access_footer', config_value: 'placeholder' });

    await SiteConfig.update(
      'request_access_footer',
      '<p>Hello</p><script>alert(1)</script>',
      1
    );

    const [, params] = pool.query.mock.calls[0];
    const persistedValue = params[0];
    expect(persistedValue).not.toMatch(/<script/i);
    expect(persistedValue).toContain('<p>Hello</p>');
  });

  test('strips event-handler attributes (e.g. onclick, onerror)', async () => {
    mockUpdateReturns({ config_key: 'request_access_footer', config_value: 'placeholder' });

    await SiteConfig.update(
      'request_access_footer',
      '<p onclick="alert(1)">Click me</p><img src="x.png" onerror="alert(2)">',
      1
    );

    const [, params] = pool.query.mock.calls[0];
    const persistedValue = params[0];
    expect(persistedValue).not.toMatch(/onclick/i);
    expect(persistedValue).not.toMatch(/onerror/i);
    // <img> is not in the allowed tag list, so it should be stripped entirely.
    expect(persistedValue).not.toMatch(/<img/i);
  });

  test('strips javascript: scheme URLs in href', async () => {
    mockUpdateReturns({ config_key: 'request_access_footer', config_value: 'placeholder' });

    await SiteConfig.update(
      'request_access_footer',
      '<a href="javascript:alert(1)">link</a>',
      1
    );

    const [, params] = pool.query.mock.calls[0];
    const persistedValue = params[0];
    expect(persistedValue).not.toMatch(/javascript:/i);
  });

  test('removes disallowed tags such as <iframe>, <object>, and <embed>', async () => {
    mockUpdateReturns({ config_key: 'request_access_footer', config_value: 'placeholder' });

    await SiteConfig.update(
      'request_access_footer',
      '<iframe src="https://evil.example"></iframe><object data="x"></object><embed src="x">',
      1
    );

    const [, params] = pool.query.mock.calls[0];
    const persistedValue = params[0];
    expect(persistedValue).not.toMatch(/<iframe/i);
    expect(persistedValue).not.toMatch(/<object/i);
    expect(persistedValue).not.toMatch(/<embed/i);
  });

  test('preserves allowed tags and http(s)/relative hrefs', async () => {
    mockUpdateReturns({ config_key: 'request_access_footer', config_value: 'placeholder' });

    const input = '<p>Contact us <a href="https://tak.nz">here</a> or <a href="/support">here</a>.</p>' +
      '<ul><li><strong>Bold</strong></li><li><em>Italic</em></li></ul><br>';

    await SiteConfig.update('request_access_footer', input, 1);

    const [, params] = pool.query.mock.calls[0];
    const persistedValue = params[0];
    expect(persistedValue).toContain('href="https://tak.nz"');
    expect(persistedValue).toContain('href="/support"');
    expect(persistedValue).toContain('<strong>Bold</strong>');
    expect(persistedValue).toContain('<em>Italic</em>');
  });

  test('passes non-string values through without calling sanitizeHtml', async () => {
    mockUpdateReturns({ config_key: 'some_flag', config_value: null });

    await SiteConfig.update('some_flag', null, 1);

    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toBeNull();
  });
});

describe('SiteConfig.getPublicConfig', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('exposes recaptcha_site_key from RECAPTCHA_SITE_KEY when set', async () => {
    process.env.RECAPTCHA_SITE_KEY = '6Ltest-site-key';

    const config = await SiteConfig.getPublicConfig();

    expect(config.recaptcha_site_key).toBe('6Ltest-site-key');
  });

  test('exposes recaptcha_site_key as null when RECAPTCHA_SITE_KEY is unset', async () => {
    delete process.env.RECAPTCHA_SITE_KEY;

    const config = await SiteConfig.getPublicConfig();

    expect(config.recaptcha_site_key).toBeNull();
  });

  test('never exposes RECAPTCHA_SECRET under any key', async () => {
    process.env.RECAPTCHA_SITE_KEY = '6Ltest-site-key';
    process.env.RECAPTCHA_SECRET = '6Ltest-secret-key-should-never-appear';

    const config = await SiteConfig.getPublicConfig();

    expect(JSON.stringify(config)).not.toContain('6Ltest-secret-key-should-never-appear');
  });

  test('exposes recaptcha_disabled: true when RECAPTCHA_DISABLED=true and NODE_ENV is not production', async () => {
    process.env.NODE_ENV = 'test';
    process.env.RECAPTCHA_DISABLED = 'true';

    const config = await SiteConfig.getPublicConfig();

    expect(config.recaptcha_disabled).toBe(true);
  });

  test('exposes recaptcha_disabled: false when RECAPTCHA_DISABLED is unset', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.RECAPTCHA_DISABLED;

    const config = await SiteConfig.getPublicConfig();

    expect(config.recaptcha_disabled).toBe(false);
  });

  test('exposes recaptcha_disabled: false when NODE_ENV=production, even if RECAPTCHA_DISABLED=true', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RECAPTCHA_DISABLED = 'true';

    const config = await SiteConfig.getPublicConfig();

    expect(config.recaptcha_disabled).toBe(false);
  });

  // Requirements 2.4, 2.5, 5.7 (task 8.4): the Client's Add-Sub-team/
  // Parent-dropdown disable logic and the Callsign_Level_Selection
  // toggle count both read `maxTeamDepth` from this response rather than
  // hardcoding 5, so it must be sourced from the same MAX_TEAM_DEPTH
  // constant `Team.create` enforces server-side.
  test('exposes maxTeamDepth sourced from the MAX_TEAM_DEPTH constant', async () => {
    const { MAX_TEAM_DEPTH } = require('../config/constants');

    const config = await SiteConfig.getPublicConfig();

    expect(config.maxTeamDepth).toBe(MAX_TEAM_DEPTH);
    expect(config.maxTeamDepth).toBe(5);
  });

  // Requirements 13.4, 13.5 (task 33.2): the Client's Member_List inline
  // edit form needs the 8 predefined TAK_Role values from somewhere it
  // can reach without a Global_Manager-only endpoint (unlike
  // GET /api/config/color-mappings, this endpoint is unauthenticated),
  // sourced from the same ROLE_KEY_LABELS allow-list `PATCH
  // /api/teams/:teamId/members/:userId` validates against.
  test('exposes takRoleValues sourced from settings.js\'s TAK_ROLE_VALUES', async () => {
    const { TAK_ROLE_VALUES } = require('../routes/settings');

    const config = await SiteConfig.getPublicConfig();

    expect(config.takRoleValues).toEqual(TAK_ROLE_VALUES);
    expect(config.takRoleValues).toEqual([
      'Team Member', 'Team Lead', 'Sniper', 'Medic', 'Forward Observer', 'RTO', 'K9', 'HQ'
    ]);
  });

  // Requirement 1.3 (cloudtak-agency-groups): CLOUDTAK_ENABLED is a
  // server-side-only flag and must NEVER be surfaced through the
  // Public_Config_Endpoint. Assert the returned object carries no
  // cloudtak-related key and does not leak the CLOUDTAK_ENABLED value,
  // regardless of whether the flag is set.
  test('never includes a cloudtak/CLOUDTAK key, even when CLOUDTAK_ENABLED=true', async () => {
    process.env.CLOUDTAK_ENABLED = 'true';

    const config = await SiteConfig.getPublicConfig();

    const cloudtakKeys = Object.keys(config).filter(key => /cloudtak/i.test(key));
    expect(cloudtakKeys).toEqual([]);
    expect(JSON.stringify(config)).not.toMatch(/cloudtak/i);
  });

  // Requirements 1.4, 9.5 (device-management task 1.3): DEVICE_MGMT_ENABLED
  // is a server-side-only flag and must NEVER be surfaced through the
  // Public_Config_Endpoint -- in any case, including when the environment
  // variable is unset. Mirrors the CLOUDTAK_ENABLED exclusion test above.
  const DEVICE_MGMT_KEY_PATTERN = /device[_-]?mgmt|device[_-]?management/i;

  test('never includes a DEVICE_MGMT_ENABLED/device-mgmt key when DEVICE_MGMT_ENABLED=true', async () => {
    process.env.DEVICE_MGMT_ENABLED = 'true';

    const config = await SiteConfig.getPublicConfig();

    const deviceMgmtKeys = Object.keys(config).filter(key => DEVICE_MGMT_KEY_PATTERN.test(key));
    expect(deviceMgmtKeys).toEqual([]);
    expect(JSON.stringify(config)).not.toMatch(DEVICE_MGMT_KEY_PATTERN);
  });

  test('never includes a DEVICE_MGMT_ENABLED/device-mgmt key when DEVICE_MGMT_ENABLED is unset', async () => {
    delete process.env.DEVICE_MGMT_ENABLED;

    const config = await SiteConfig.getPublicConfig();

    const deviceMgmtKeys = Object.keys(config).filter(key => DEVICE_MGMT_KEY_PATTERN.test(key));
    expect(deviceMgmtKeys).toEqual([]);
    expect(JSON.stringify(config)).not.toMatch(DEVICE_MGMT_KEY_PATTERN);
  });

  // Requirement 12.9 (device-management task 24.4): `DEVICE_MGMT_REVOKE_ENABLED`
  // and `DEVICE_MGMT_REVOKE_MAX_CERTS` are server-side-only like
  // `DEVICE_MGMT_ENABLED`, and must not reach the Public_Config_Endpoint
  // either. Whether revocation is armed, and how large a blast radius the
  // server will accept, are operational facts about the destructive path that
  // an unauthenticated caller has no business reading -- and a client that
  // could read the arming flag would be tempted to branch on it instead of on
  // the server's own 403.
  const REVOKE_KEY_PATTERN = /revoke|max[_-]?certs/i;

  test.each([
    ['set', 'true', '1234'],
    ['unset', undefined, undefined]
  ])(
    'never surfaces DEVICE_MGMT_REVOKE_ENABLED or DEVICE_MGMT_REVOKE_MAX_CERTS when %s',
    async (_label, revokeEnabled, maxCerts) => {
      if (revokeEnabled === undefined) {
        delete process.env.DEVICE_MGMT_REVOKE_ENABLED;
        delete process.env.DEVICE_MGMT_REVOKE_MAX_CERTS;
      } else {
        process.env.DEVICE_MGMT_REVOKE_ENABLED = revokeEnabled;
        process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = maxCerts;
      }

      const config = await SiteConfig.getPublicConfig();
      const serialized = JSON.stringify(config);

      expect(Object.keys(config).filter(key => REVOKE_KEY_PATTERN.test(key))).toEqual([]);
      expect(Object.keys(config).filter(key => DEVICE_MGMT_KEY_PATTERN.test(key))).toEqual([]);
      expect(serialized).not.toMatch(REVOKE_KEY_PATTERN);
      expect(serialized).not.toMatch(DEVICE_MGMT_KEY_PATTERN);
      // Neither the flag's value nor the distinctive cap value leaks under some
      // other, innocuously-named key.
      if (maxCerts !== undefined) {
        expect(serialized).not.toContain(maxCerts);
      }
    }
  );

  // ══════════════════════════════════════════════════════════════════════
  // Presentation_Config keys (device-management tasks 26.4 and 29.4;
  // Requirements 18.5, 18.6, 21.1, 21.7).
  //
  // The load-bearing test in this section is the FIRST one: it asserts the
  // two presentation keys are PRESENT in the same breath as asserting the
  // two capability-arming flags are ABSENT. The two halves are deliberately
  // in one test rather than in two neighbouring ones, because the thing
  // being protected is the BOUNDARY between the categories, and a boundary
  // cannot be asserted from one side.
  //
  // Note also that the `DEVICE_MGMT_KEY_PATTERN` / `REVOKE_KEY_PATTERN`
  // guards above cannot do this job on their own: `device_expiry_warning_days`
  // matches NEITHER pattern (it is `device_` + `expiry`, not `device_mgmt`),
  // so no pattern-based negative assertion anywhere in this file would fail
  // if a refactor deleted the key -- and none would fail if a refactor added
  // `device_expiry_warning_days` while ALSO adding the arming flags under
  // innocuous names. The explicit positive-and-negative pairing below is what
  // catches both directions.
  // ══════════════════════════════════════════════════════════════════════

  test(
    'exposes display_timezone and device_expiry_warning_days while STILL omitting ' +
      'DEVICE_MGMT_ENABLED and DEVICE_MGMT_REVOKE_ENABLED',
    async () => {
      // Every device-management variable set at once, so the capability flags
      // have a value that COULD leak if the presentation keys were added
      // carelessly (e.g. by exposing the whole device-management env block).
      process.env.DISPLAY_TIMEZONE = 'Pacific/Chatham';
      process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS = '45';
      process.env.DEVICE_MGMT_ENABLED = 'true';
      process.env.DEVICE_MGMT_REVOKE_ENABLED = 'true';
      process.env.DEVICE_MGMT_REVOKE_MAX_CERTS = '1234';

      const config = await SiteConfig.getPublicConfig();
      const serialized = JSON.stringify(config);

      // --- Presentation: present, because the client cannot render without it.
      expect(config.display_timezone).toBe('Pacific/Chatham');
      expect(config.device_expiry_warning_days).toBe(45);

      // --- Capability arming state: absent, in the same assertion block.
      expect(Object.keys(config)).not.toContain('DEVICE_MGMT_ENABLED');
      expect(Object.keys(config)).not.toContain('DEVICE_MGMT_REVOKE_ENABLED');
      expect(Object.keys(config)).not.toContain('device_mgmt_enabled');
      expect(Object.keys(config)).not.toContain('device_mgmt_revoke_enabled');
      expect(config.device_mgmt_enabled).toBeUndefined();
      expect(config.device_mgmt_revoke_enabled).toBeUndefined();
      expect(Object.keys(config).filter(key => DEVICE_MGMT_KEY_PATTERN.test(key))).toEqual([]);
      expect(Object.keys(config).filter(key => REVOKE_KEY_PATTERN.test(key))).toEqual([]);
      expect(serialized).not.toMatch(DEVICE_MGMT_KEY_PATTERN);
      expect(serialized).not.toMatch(REVOKE_KEY_PATTERN);
      // The distinctive cap value does not reach the client under any name.
      expect(serialized).not.toContain('1234');

      // The presentation keys are the ONLY device-management-adjacent values
      // on this response: enumerate them, so adding a third one is a
      // deliberate act that updates this list rather than a silent widening.
      const deviceAdjacentKeys = Object.keys(config).filter(key => /device|timezone/i.test(key));
      expect(deviceAdjacentKeys.sort()).toEqual(['device_expiry_warning_days', 'display_timezone']);
    }
  );

  // Requirements 18.1, 18.5: the resolved Display_Timezone, so a client that
  // receives the key and one that falls back to its own literal default
  // (Requirement 18.7) agree on the unset case.
  test('exposes display_timezone from DISPLAY_TIMEZONE when set', async () => {
    process.env.DISPLAY_TIMEZONE = 'Asia/Kolkata';

    const config = await SiteConfig.getPublicConfig();

    expect(config.display_timezone).toBe('Asia/Kolkata');
  });

  test.each([
    ['unset', undefined],
    ['empty', '']
  ])('defaults display_timezone to Pacific/Auckland when %s', async (_label, value) => {
    if (value === undefined) {
      delete process.env.DISPLAY_TIMEZONE;
    } else {
      process.env.DISPLAY_TIMEZONE = value;
    }

    const config = await SiteConfig.getPublicConfig();

    // The same literal the Date_Format_Helpers fall back to client-side, so a
    // client that never received this key behaves identically (18.7).
    expect(config.display_timezone).toBe('Pacific/Auckland');
  });

  // Requirements 21.1, 21.7: unset, empty, non-numeric, zero and negative all
  // resolve to 30; a usable positive integer is passed through; a decimal is
  // truncated by `parseInt`.
  test.each([
    ['unset', undefined, 30],
    ['empty', '', 30],
    ['zero', '0', 30],
    ['negative', '-5', 30],
    ['non-numeric', 'abc', 30],
    ['a positive integer', '45', 45],
    ['a decimal', '30.9', 30]
  ])(
    'resolves device_expiry_warning_days to %s -> %s',
    async (_label, value, expected) => {
      if (value === undefined) {
        delete process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS;
      } else {
        process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS = value;
      }

      const config = await SiteConfig.getPublicConfig();

      expect(config.device_expiry_warning_days).toBe(expected);
      // Always a positive integer, so the client's `resolveWarningDays`
      // guard is never the thing that saves the rendering (21.7).
      expect(Number.isInteger(config.device_expiry_warning_days)).toBe(true);
      expect(config.device_expiry_warning_days).toBeGreaterThan(0);
    }
  );

  // Requirement 21.1 deliberately diverges from `getRevokeMaxCerts()` on a
  // NEGATIVE value, and that divergence is asserted here rather than
  // "corrected": a blast-radius cap must stay usable, so `Math.max(1, ...)`
  // clamping to 1 is right for it; a threshold whose DOCUMENTED default is 30
  // must not silently become 1, because 1 would mean a user sees no warning
  // until the day before expiry. A future reader who spots the two
  // resolutions disagreeing should find this test before "unifying" them.
  test('resolves a negative threshold to 30, where getRevokeMaxCerts clamps a negative to 1', async () => {
    const { getRevokeMaxCerts } = require('../config/deviceMgmt');
    process.env.DEVICE_MGMT_EXPIRY_WARNING_DAYS = '-5';

    const config = await SiteConfig.getPublicConfig();

    expect(config.device_expiry_warning_days).toBe(30);
    expect(getRevokeMaxCerts({ DEVICE_MGMT_REVOKE_MAX_CERTS: '-5' })).toBe(1);
  });
});
