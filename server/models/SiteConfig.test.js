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
});
