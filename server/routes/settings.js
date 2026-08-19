const express = require('express');
const archiver = require('archiver');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { getLogger } = require('../middleware/requestContext');
const SiteConfig = require('../models/SiteConfig');
const pool = require('../config/database');
const { isWellFormedUrl } = require('../config/configValidator');
const exportableSettingsKeys = require('../config/exportableSettingsKeys');
const sanitizeHtml = require('sanitize-html');
const { SANITIZE_HTML_OPTIONS } = require('../config/htmlSafeSubset');
const router = express.Router();

/**
 * server/routes/settings.js
 *
 * In-App Settings Configuration Surface (Requirement 32, task 54).
 * Every route in this file is Global_Manager-only, enforced centrally by
 * `authorize.js` via the Permission_Registry's `settings:*` entries
 * (resolved through `roleDefaults.global_manager: ['*']`), matching the
 * pattern already used by every other Global_Manager-only route file
 * (`vendorChannels.js`, `deploymentChannels.js`, `auditLogs.js`) -- no
 * inline `is_global_manager` check is duplicated here.
 *
 * This task (54.2) implements ONLY the branding (`site_config`-backed)
 * and TAK color/role mapping (`system_config`-backed) GET/PUT surface.
 * The file is deliberately structured so task 54.3 can extend it with
 * the TAK Server credential endpoints (`GET/PUT /api/settings/tak-server`)
 * without restructuring anything here; task 54.5 added
 * `GET /api/settings/export` and task 54.6 (below) adds
 * `POST /api/settings/import` to this same router.
 *
 * --- Branding (site_config) ---
 *
 * `site_config`'s baseline schema/seed data has no pre-existing org-name
 * or logo `config_key` (only `request_access_title`/`_subtitle`/
 * `_footer` -- see `server/models/SiteConfig.js` and
 * `database/migrations/1786596755665_baseline-schema.cjs`). Migration
 * `1786800000000_seed-branding-site-config.cjs` (part of this task)
 * therefore establishes two new `site_config` rows, following the
 * existing lowercase/underscore-separated `config_key` convention:
 *   - `organization_display_name` -- the org name shown in the App's UI.
 *   - `organization_logo_path` -- a plain reference (path/URL) to the
 *     org's logo asset. Per this task's scope, the branding PUT below
 *     accepts this as a plain string field only (a logo reference), NOT
 *     a file upload; the atomic `.tmp-${uuid}` + `fs.rename()` upload
 *     mechanism that actually writes a logo file to this path is task
 *     54.4's scope.
 * `GET`/`PUT /api/settings/branding` reuse `SiteConfig.getByKey`/
 * `SiteConfig.update` directly (no new model needed) -- `SiteConfig.update`
 * already sanitizes any string `config_value` through the documented safe
 * HTML subset (Requirements 5.4-5.6) before persisting.
 *
 * --- TAK color/role mappings (system_config) ---
 *
 * Task 54.1's migration
 * (`1786790000000_seed-tak-color-role-system-config.cjs`) seeded
 * `system_config` with one `tak_color_<name>`/`tak_role_<name>` row per
 * `TAK_COLOR_*`/`TAK_ROLE_*` environment variable previously hardcoded in
 * `server/routes/config.js`'s `GET /color-mappings` handler, using the
 * naming scheme `TAK_COLOR_<NAME>` -> `tak_color_<name>` (lower-cased),
 * e.g. `TAK_COLOR_DARK_BLUE` -> `tak_color_dark_blue`.
 * `GET /api/settings/tak-mappings` reads every `tak_color_*`/`tak_role_*`
 * row back out and reshapes it into the same
 * `{colorMappings: {...}, roleDescriptions: {...}}` structure already
 * returned by the (soon-to-be-superseded) `GET /api/config/color-mappings`
 * route, keyed by the same human-readable labels (`'Yellow'`,
 * `'Team Member'`, etc.) that route already uses, so any client consuming
 * this new endpoint sees an identical response shape.
 *
 * `PUT /api/settings/tak-mappings` intentionally accepts an `updates`
 * object keyed by the raw `config_key` (e.g. `{"tak_color_yellow": "..."}`)
 * rather than by the display label used in the GET response: the
 * `config_key` is the single unambiguous, allow-listable identifier for
 * "one or more system_config rows" (this task's own wording), whereas the
 * display label is a presentation convenience with a few irregular cases
 * (`RTO`, `K9`, `HQ`) that would otherwise need a label -> key reverse
 * mapping on every write. Only keys already present in
 * `TAK_MAPPING_CONFIG_KEYS` (i.e. exactly the set task 54.1 seeded) may be
 * updated; any other key in the `updates` object is rejected without
 * applying any part of the request.
 */

// Requirement 32.1's key set, mirroring task 54.1's migration exactly:
// every `tak_color_*`/`tak_role_*` `system_config.config_key` seeded from
// the `TAK_COLOR_*`/`TAK_ROLE_*` environment variables previously read
// directly by `server/routes/config.js`'s `GET /color-mappings` handler.
const COLOR_KEY_LABELS = {
  tak_color_yellow: 'Yellow',
  tak_color_cyan: 'Cyan',
  tak_color_green: 'Green',
  tak_color_red: 'Red',
  tak_color_purple: 'Purple',
  tak_color_orange: 'Orange',
  tak_color_blue: 'Blue',
  tak_color_magenta: 'Magenta',
  tak_color_white: 'White',
  tak_color_maroon: 'Maroon',
  tak_color_dark_blue: 'Dark Blue',
  tak_color_teal: 'Teal',
  tak_color_dark_green: 'Dark Green',
  tak_color_brown: 'Brown'
};

const ROLE_KEY_LABELS = {
  tak_role_team_member: 'Team Member',
  tak_role_team_lead: 'Team Lead',
  tak_role_sniper: 'Sniper',
  tak_role_medic: 'Medic',
  tak_role_forward_observer: 'Forward Observer',
  tak_role_rto: 'RTO',
  tak_role_k9: 'K9',
  tak_role_hq: 'HQ'
};

// The full allow-list of config_keys this endpoint may read/write, used
// both to build the SQL `IN (...)` filter for the GET and to validate
// every key in a PUT's `updates` object before applying any of them.
const TAK_MAPPING_CONFIG_KEYS = [...Object.keys(COLOR_KEY_LABELS), ...Object.keys(ROLE_KEY_LABELS)];

// The full allow-list of TAK_Role display values (e.g. 'Team Member',
// 'Team Lead', ...), used to validate a Member_List/CSV-import `TAK_Role`
// edit against the set of roles this endpoint's ROLE_KEY_LABELS defines.
const TAK_ROLE_VALUES = Object.values(ROLE_KEY_LABELS);

// Branding config_keys backed by site_config, seeded by this task's
// migration (1786800000000_seed-branding-site-config.cjs).
const BRANDING_CONFIG_KEYS = {
  organizationDisplayName: 'organization_display_name',
  organizationLogoPath: 'organization_logo_path'
};

/**
 * Reads the current branding fields from `site_config`, defaulting a
 * missing row's value to an empty string (rather than throwing) so a
 * fresh database that hasn't yet run the seed migration still returns a
 * well-formed response.
 *
 * @returns {Promise<{organizationDisplayName: string, organizationLogoPath: string}>}
 */
async function getBrandingFields() {
  const [displayNameRow, logoPathRow] = await Promise.all([
    SiteConfig.getByKey(BRANDING_CONFIG_KEYS.organizationDisplayName),
    SiteConfig.getByKey(BRANDING_CONFIG_KEYS.organizationLogoPath)
  ]);

  return {
    organizationDisplayName: (displayNameRow && displayNameRow.config_value) || '',
    organizationLogoPath: (logoPathRow && logoPathRow.config_value) || ''
  };
}

// GET /api/settings/branding (Requirement 32.2, Global_Manager-only).
router.get('/branding', authenticateToken, authorize, async (req, res) => {
  try {
    const branding = await getBrandingFields();
    res.json({ branding });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch branding settings');
    res.status(500).json({ error: 'Failed to fetch branding settings' });
  }
});

// PUT /api/settings/branding (Requirement 32.2, Global_Manager-only).
// Accepts organizationDisplayName and/or organizationLogoPath; at least
// one must be present. organizationLogoPath is a plain string reference
// (path/URL) only -- actual logo file upload is task 54.4's scope. Neither
// field is run through express-validator's `.escape()` (unlike
// `server/middleware/validators.js`'s `textField` helper): both values are
// stored via `SiteConfig.update`, which already sanitizes any string
// `config_value` through the documented safe HTML subset before
// persisting (Requirements 5.4-5.6), and `organizationLogoPath` in
// particular is a filesystem/URL path where HTML-entity-escaping
// characters like `/` would corrupt the value.
router.put('/branding', authenticateToken, authorize, [
  body('organizationDisplayName').optional().trim().isLength({ max: 255 }),
  body('organizationLogoPath').optional().trim().isLength({ max: 500 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { organizationDisplayName, organizationLogoPath } = req.body;

  if (organizationDisplayName === undefined && organizationLogoPath === undefined) {
    return res.status(400).json({ error: 'At least one of organizationDisplayName or organizationLogoPath is required' });
  }

  try {
    if (organizationDisplayName !== undefined) {
      await SiteConfig.update(BRANDING_CONFIG_KEYS.organizationDisplayName, organizationDisplayName, req.user.userId);
    }
    if (organizationLogoPath !== undefined) {
      await SiteConfig.update(BRANDING_CONFIG_KEYS.organizationLogoPath, organizationLogoPath, req.user.userId);
    }

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'settings.update_branding', 'settings', null, null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    const branding = await getBrandingFields();
    res.json({ branding });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update branding settings');
    res.status(500).json({ error: 'Failed to update branding settings' });
  }
});

// GET /api/settings/tak-mappings (Requirement 32.1, Global_Manager-only).
// Mirrors GET /api/config/color-mappings's {colorMappings, roleDescriptions}
// response shape exactly, but reads from system_config (task 54.1's seeded
// rows) instead of process.env.
router.get('/tak-mappings', authenticateToken, authorize, async (req, res) => {
  try {
    const placeholders = TAK_MAPPING_CONFIG_KEYS.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN (${placeholders})`,
      TAK_MAPPING_CONFIG_KEYS
    );

    const valuesByKey = {};
    result.rows.forEach((row) => {
      valuesByKey[row.config_key] = row.config_value;
    });

    const colorMappings = {};
    Object.entries(COLOR_KEY_LABELS).forEach(([configKey, label]) => {
      colorMappings[label] = valuesByKey[configKey] || '';
    });

    const roleDescriptions = {};
    Object.entries(ROLE_KEY_LABELS).forEach(([configKey, label]) => {
      roleDescriptions[label] = valuesByKey[configKey] || '';
    });

    res.json({ colorMappings, roleDescriptions });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch TAK color/role mappings');
    res.status(500).json({ error: 'Failed to fetch TAK color/role mappings' });
  }
});

// PUT /api/settings/tak-mappings (Requirement 32.1, Global_Manager-only).
// Updates one or more tak_color_*/tak_role_* system_config rows, keyed by
// config_key. Every key in `updates` must be in the TAK_MAPPING_CONFIG_KEYS
// allow-list; if any key is not, the entire request is rejected before
// any row is updated.
router.put('/tak-mappings', authenticateToken, authorize, [
  body('updates').isObject().withMessage('updates must be an object keyed by config_key')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { updates } = req.body;
  const keys = Object.keys(updates);

  if (keys.length === 0) {
    return res.status(400).json({ error: 'updates must contain at least one config_key' });
  }

  const invalidKeys = keys.filter((key) => !TAK_MAPPING_CONFIG_KEYS.includes(key));
  if (invalidKeys.length > 0) {
    return res.status(400).json({ error: `Unknown config_key(s): ${invalidKeys.join(', ')}` });
  }

  for (const key of keys) {
    const value = updates[key];
    if (typeof value !== 'string' || value.length > 255) {
      return res.status(400).json({ error: `Value for ${key} must be a string of at most 255 characters` });
    }
  }

  try {
    await Promise.all(
      keys.map((key) =>
        pool.query(
          'UPDATE system_config SET config_value = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE config_key = $3',
          [updates[key], req.user.userId, key]
        )
      )
    );

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'settings.update_mappings', 'settings', null, JSON.stringify({ keysUpdated: keys.length })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    // Re-fetch to confirm the persisted state, e.g. in case a key was
    // valid per the allow-list but not actually present as a row yet
    // (should not normally happen once task 54.1's migration has run).
    const placeholders = TAK_MAPPING_CONFIG_KEYS.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `SELECT config_key, config_value FROM system_config WHERE config_key IN (${placeholders})`,
      TAK_MAPPING_CONFIG_KEYS
    );

    const valuesByKey = {};
    result.rows.forEach((row) => {
      valuesByKey[row.config_key] = row.config_value;
    });

    const colorMappings = {};
    Object.entries(COLOR_KEY_LABELS).forEach(([configKey, label]) => {
      colorMappings[label] = valuesByKey[configKey] || '';
    });

    const roleDescriptions = {};
    Object.entries(ROLE_KEY_LABELS).forEach(([configKey, label]) => {
      roleDescriptions[label] = valuesByKey[configKey] || '';
    });

    res.json({ colorMappings, roleDescriptions });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update TAK color/role mappings');
    res.status(500).json({ error: 'Failed to update TAK color/role mappings' });
  }
});

/**
 * --- TAK Server integration credential settings (Requirement 32.3, task 54.3) ---
 *
 * `GET/PUT /api/settings/tak-server`, distinct from this file's branding
 * and TAK color/role mapping surface above (task 54.2). Unlike task
 * 54.1's `TAK_COLOR_*`/`TAK_ROLE_*` migration (which seeds `system_config`
 * rows with the current env value as a one-time default via a dedicated
 * `node-pg-migrate` migration), this task does NOT ship a seed migration
 * for the TAK Server fields. `TAK_API_P12_PASSPHRASE` (and, conceptually,
 * the key material referenced by `TAK_API_KEY_PATH`) is secret-shaped,
 * and unconditionally copying a live passphrase out of `.env` into a
 * plaintext `system_config` row at migration-run time -- before any
 * operator has opted into managing it from this settings surface -- is a
 * materially different risk profile than seeding a color name or a role
 * description (which task 54.1 does do). Instead, `GET
 * /api/settings/tak-server` below reads each field from `system_config`
 * and falls back to the live environment variable only when no
 * `system_config` row yet exists for that key, mirroring
 * `EmailService.getConfigValue`'s existing read-with-fallback pattern.
 * Once an operator edits a field via `PUT /api/settings/tak-server`, the
 * resulting `system_config` row takes over for that key going forward
 * (the env var is no longer consulted for that specific key).
 *
 * `config_key` naming (mirrors task 54.1's `tak_color_<name>`/
 * `tak_role_<name>` lowercase convention):
 *
 *   TAK_SERVER_URL          -> tak_server_url
 *   TAK_API_P12_PATH        -> tak_server_p12_path
 *   TAK_API_P12_PASSPHRASE  -> tak_server_p12_passphrase
 *   TAK_API_CERT_PATH       -> tak_server_cert_path
 *   TAK_API_KEY_PATH        -> tak_server_key_path
 *   TAK_CA_PATH             -> tak_server_ca_path
 *
 * `GET /api/settings/tak-server` (Requirement 32.3) never returns the
 * resolved `tak_server_p12_passphrase` value -- only a `passphraseSet`
 * boolean -- since a passphrase is secret material regardless of whether
 * it currently lives in an environment variable or a `system_config` row.
 * Every other field returned (the URL and the cert/key/CA *paths*) is a
 * filesystem path or a URL, not secret content, so those are returned
 * as-is; this repo does not persist actual key/cert file bytes in
 * `system_config`, only path references to files on disk (writing the
 * uploaded file content itself, atomically, is task 54.4's scope).
 *
 * `PUT /api/settings/tak-server` (Requirement 32.3) accepts plain string
 * field updates only (`takServerUrl`, `p12Path`, `p12Passphrase`,
 * `certPath`, `keyPath`, `caPath`), persisted as `system_config` rows.
 * Actual multipart file upload for a cert/key/logo file's *content*, with
 * the atomic `${path}.tmp-${uuid}` + `fs.rename()` write pattern
 * (Requirement 32.4), is task 54.4's scope and is deliberately NOT
 * implemented here -- this task only updates the path/URL/passphrase
 * string fields themselves. Sending an empty string for `takServerUrl`
 * clears/disables the TAK Server integration (consistent with
 * Requirement 26.1's "this integration is optional") rather than being
 * rejected as a malformed URL.
 */

const TAK_SERVER_CONFIG_KEYS = {
  url: 'tak_server_url',
  p12Path: 'tak_server_p12_path',
  p12Passphrase: 'tak_server_p12_passphrase',
  certPath: 'tak_server_cert_path',
  keyPath: 'tak_server_key_path',
  caPath: 'tak_server_ca_path'
};

// Maps each config_key above to the environment variable it falls back to
// when no system_config row exists yet for that key (see comment above).
const TAK_SERVER_ENV_FALLBACKS = {
  [TAK_SERVER_CONFIG_KEYS.url]: 'TAK_SERVER_URL',
  [TAK_SERVER_CONFIG_KEYS.p12Path]: 'TAK_API_P12_PATH',
  [TAK_SERVER_CONFIG_KEYS.p12Passphrase]: 'TAK_API_P12_PASSPHRASE',
  [TAK_SERVER_CONFIG_KEYS.certPath]: 'TAK_API_CERT_PATH',
  [TAK_SERVER_CONFIG_KEYS.keyPath]: 'TAK_API_KEY_PATH',
  [TAK_SERVER_CONFIG_KEYS.caPath]: 'TAK_CA_PATH'
};

/**
 * Reads a single TAK Server config_key's effective value: the
 * `system_config` row's value if one exists, otherwise the corresponding
 * live environment variable, otherwise `null`.
 *
 * @param {string} configKey
 * @returns {Promise<string|null>}
 */
async function getEffectiveTakServerConfigValue(configKey) {
  const result = await pool.query(
    'SELECT config_value FROM system_config WHERE config_key = $1',
    [configKey]
  );
  if (result.rows.length > 0) {
    return result.rows[0].config_value;
  }
  const envVarName = TAK_SERVER_ENV_FALLBACKS[configKey];
  const envValue = envVarName ? process.env[envVarName] : undefined;
  return typeof envValue === 'string' && envValue.length > 0 ? envValue : null;
}

/**
 * Upserts a single TAK Server config_key's value into `system_config`.
 *
 * @param {string} configKey
 * @param {string} value
 * @param {number|undefined} updatedBy
 * @returns {Promise<void>}
 */
async function setTakServerConfigValue(configKey, value, updatedBy) {
  await pool.query(
    `INSERT INTO system_config (config_key, config_value, updated_by, updated_at)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (config_key)
     DO UPDATE SET config_value = EXCLUDED.config_value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [configKey, value, updatedBy === undefined ? null : updatedBy]
  );
}

// GET /api/settings/tak-server (Requirement 32.3, Global_Manager-only).
router.get('/tak-server', authenticateToken, authorize, async (req, res) => {
  try {
    const [url, p12Path, p12Passphrase, certPath, keyPath, caPath] = await Promise.all([
      getEffectiveTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.url),
      getEffectiveTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.p12Path),
      getEffectiveTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.p12Passphrase),
      getEffectiveTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.certPath),
      getEffectiveTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.keyPath),
      getEffectiveTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.caPath)
    ]);

    const hasP12Pair = Boolean(p12Path) && Boolean(p12Passphrase);
    const hasCertKeyPair = Boolean(certPath) && Boolean(keyPath);
    // P12 takes precedence when both pairs happen to be configured,
    // mirroring TakServerService.buildMutualTlsAgentOptions's precedence.
    const credentialMode = hasP12Pair ? 'p12' : (hasCertKeyPair ? 'cert_key' : 'none');

    // Requirement 32.3: never return the passphrase value itself -- only
    // paths/URLs and a boolean flag indicating whether the secret is set.
    res.json({
      takServerUrl: url,
      credentialMode,
      p12: {
        path: p12Path,
        passphraseSet: Boolean(p12Passphrase)
      },
      certKey: {
        certPath,
        keyPath
      },
      caPath
    });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to fetch TAK Server settings');
    res.status(500).json({ error: 'Failed to fetch TAK Server settings' });
  }
});

// PUT /api/settings/tak-server (Requirement 32.3, Global_Manager-only).
// Accepts plain string field updates only -- see header comment for why
// actual file upload content handling is out of scope here (task 54.4).
router.put('/tak-server', authenticateToken, authorize, [
  body('takServerUrl').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  body('p12Path').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  body('p12Passphrase').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  body('certPath').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  body('keyPath').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
  body('caPath').optional({ nullable: true }).isString().trim().isLength({ max: 1000 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { takServerUrl, p12Path, p12Passphrase, certPath, keyPath, caPath } = req.body;

  // Requirement 32.3: reuse configValidator.isWellFormedUrl to validate
  // takServerUrl, when supplied and non-empty, as a well-formed URL --
  // the same predicate the Config_Validator itself uses for
  // TAK_SERVER_URL at startup (Requirement 26.1). An empty string clears
  // the setting (the integration is optional, Requirement 26.1) rather
  // than being rejected.
  if (takServerUrl !== undefined && takServerUrl !== null && takServerUrl !== '' && !isWellFormedUrl(takServerUrl)) {
    return res.status(400).json({ error: 'takServerUrl must be a well-formed absolute http/https URL' });
  }

  try {
    const updatedBy = req.user && req.user.userId;
    const updates = [];

    if (takServerUrl !== undefined) {
      updates.push(setTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.url, takServerUrl, updatedBy));
    }
    if (p12Path !== undefined) {
      updates.push(setTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.p12Path, p12Path, updatedBy));
    }
    if (p12Passphrase !== undefined) {
      updates.push(setTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.p12Passphrase, p12Passphrase, updatedBy));
    }
    if (certPath !== undefined) {
      updates.push(setTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.certPath, certPath, updatedBy));
    }
    if (keyPath !== undefined) {
      updates.push(setTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.keyPath, keyPath, updatedBy));
    }
    if (caPath !== undefined) {
      updates.push(setTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.caPath, caPath, updatedBy));
    }

    await Promise.all(updates);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'settings.update_tak_server', 'settings', null, null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ success: true });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to update TAK Server settings');
    res.status(500).json({ error: 'Failed to update TAK Server settings' });
  }
});

/**
 * --- Atomic cert/key/logo file upload (Requirement 32.4, task 54.4) ---
 *
 * `PUT /api/settings/branding` and `PUT /api/settings/tak-server` above
 * only accept a plain string path/URL *reference* for
 * `organizationLogoPath`/`p12Path`/`certPath`/`keyPath`/`caPath` -- neither
 * one writes actual file bytes to disk. The three routes below fill that
 * gap: they accept a `multipart/form-data` file upload (via `multer`,
 * using `multer.memoryStorage()` so the full file is buffered in memory
 * before this handler ever touches the filesystem -- these files are
 * small, bounded by the `fileSize` limits below, so this is not a memory-
 * safety concern the way a large CSV/export stream would be), write it
 * atomically to disk via `atomicFileWrite`, and then update the
 * corresponding `site_config`/`system_config` row to point at the new
 * file's path, reusing `SiteConfig.update`/`setTakServerConfigValue`
 * exactly as the plain-string PUT routes above already do.
 *
 * `atomicFileWrite(destinationPath, fileBuffer)` implements Requirement
 * 32.4 exactly: it writes `fileBuffer` to a sibling temp file
 * (`${destinationPath}.tmp-${crypto.randomUUID()}`, in the SAME directory
 * as `destinationPath` -- not `os.tmpdir()` -- since `fs.rename()` is only
 * atomic when the source and destination are on the same filesystem/
 * directory; a cross-directory rename can silently degrade to a
 * copy-then-delete on some platforms/filesystems), then calls
 * `fs.promises.rename()` to move it into place. Because `rename(2)` atomically
 * replaces any existing file at `destinationPath` in a single filesystem
 * operation, a concurrent reader opening `destinationPath` at any point
 * either sees the fully-old file or the fully-new file, never a partially
 * written one (Requirement 32.4's exact acceptance criterion). The
 * destination directory is created first (`fs.promises.mkdir(..., {
 * recursive: true })`) so a fresh deployment's uploads/certs directory
 * doesn't need to be provisioned out of band.
 *
 * Upload destination directories:
 *   - Logo uploads write into `UPLOADS_DIR` (`server/uploads/branding` by
 *     default, overridable via the `UPLOADS_DIR` env var), and the
 *     resulting `organization_logo_path` `site_config` value is set to a
 *     web-servable `/uploads/branding/<filename>` URL path. `server/
 *     index.js` mounts `express.static` for `UPLOADS_DIR` at `/uploads` so
 *     that path is directly usable as an `<img src>` by the Client (see
 *     that file's own comment for why this needs its own static mount
 *     distinct from the `client/dist` one already there).
 *   - TAK Server cert/key uploads write into `CERTS_DIR`
 *     (`server/certs/tak-server` by default, overridable via the
 *     `CERTS_DIR` env var) and update `tak_server_cert_path`/
 *     `tak_server_key_path` with the resulting filesystem path (NOT a web
 *     URL -- these files are read directly off disk by
 *     `TakServerService`/`fs.readFileSync`, never served over HTTP, so
 *     they deliberately live outside any `express.static` mount).
 *
 * Every uploaded filename is generated server-side
 * (`${crypto.randomUUID()}${extension}`), never taken from the client's
 * original filename, so a malicious/crafted `originalname` (path
 * traversal, control characters, etc.) can never influence the on-disk
 * path -- only the file's own content-derived extension (validated against
 * the MIME allow-list for the logo, or the raw uploaded bytes for cert/
 * key) is used.
 */

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../uploads/branding');
const CERTS_DIR = process.env.CERTS_DIR || path.join(__dirname, '../certs/tak-server');

const LOGO_MAX_BYTES = 5 * 1024 * 1024; // 5MB, per this task's own guidance.
const CERT_KEY_MAX_BYTES = 20 * 1024 * 1024; // 20MB -- generous headroom for a p12 bundle or a CA chain, still far below any memory concern.

const LOGO_MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

/**
 * Atomically writes `fileBuffer` to `destinationPath`: writes to a sibling
 * `${destinationPath}.tmp-${uuid}` file first, then `fs.promises.rename()`s
 * it into place (Requirement 32.4). The temp file is always created in the
 * same directory as `destinationPath` so the rename is a same-filesystem,
 * atomic operation rather than a cross-directory move.
 *
 * @param {string} destinationPath - Absolute path the file should end up at.
 * @param {Buffer} fileBuffer - The full file content to write.
 * @returns {Promise<void>}
 */
async function atomicFileWrite(destinationPath, fileBuffer) {
  const directory = path.dirname(destinationPath);
  await fs.promises.mkdir(directory, { recursive: true });

  const tempPath = `${destinationPath}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.promises.writeFile(tempPath, fileBuffer);
    await fs.promises.rename(tempPath, destinationPath);
  } catch (error) {
    // Best-effort cleanup of the temp file on failure -- if this fails too
    // (e.g. the writeFile itself never created it), the original error is
    // still what gets thrown, not this cleanup error.
    await fs.promises.unlink(tempPath).catch(() => {});
    throw error;
  }
}

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (!Object.prototype.hasOwnProperty.call(LOGO_MIME_EXTENSIONS, file.mimetype)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    cb(null, true);
  }
});

const certKeyUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CERT_KEY_MAX_BYTES }
});

/**
 * Translates a `multer` upload failure (thrown/passed to `next` as a
 * `MulterError`, or a plain `Error` from `fileFilter`) into the same
 * `{error: string}` 400 response shape used by every other validation
 * failure in this file, rather than letting it fall through to the
 * generic error-handling middleware in `server/index.js` (which would
 * respond 500 for what is actually a client input error).
 *
 * @param {Function} uploadMiddleware - A configured `multer` middleware (e.g. `logoUpload.single('logo')`).
 * @returns {Function} An Express middleware wrapping `uploadMiddleware` with error translation.
 */
function handleUpload(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'Uploaded file exceeds the maximum allowed size' });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: 'Unsupported file type' });
        }
        return res.status(400).json({ error: err.message });
      }
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      next();
    });
  };
}

// POST /api/settings/branding/logo (Requirement 32.4, Global_Manager-only).
// Accepts a single `logo` multipart field, validates its MIME type against
// LOGO_MIME_EXTENSIONS, atomically writes it into UPLOADS_DIR under a
// server-generated filename, and updates organization_logo_path to the
// resulting /uploads/branding/<filename> URL path via SiteConfig.update
// (which itself is a plain string write -- no HTML sanitization concern
// here since the value is a filesystem-safe generated filename).
router.post('/branding/logo', authenticateToken, authorize, handleUpload(logoUpload.single('logo')), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'A logo file is required' });
  }

  const extension = LOGO_MIME_EXTENSIONS[req.file.mimetype];
  const filename = `${crypto.randomUUID()}${extension}`;
  const destinationPath = path.join(UPLOADS_DIR, filename);
  const publicPath = `/uploads/branding/${filename}`;

  try {
    await atomicFileWrite(destinationPath, req.file.buffer);
    await SiteConfig.update(BRANDING_CONFIG_KEYS.organizationLogoPath, publicPath, req.user.userId);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'settings.upload_logo', 'settings', null, null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    const branding = await getBrandingFields();
    res.json({ branding });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to upload organization logo');
    res.status(500).json({ error: 'Failed to upload organization logo' });
  }
});

// POST /api/settings/tak-server/cert (Requirement 32.4, Global_Manager-only).
// Accepts a single `cert` multipart field, atomically writes it into
// CERTS_DIR, and updates tak_server_cert_path to the resulting filesystem
// path via setTakServerConfigValue.
router.post('/tak-server/cert', authenticateToken, authorize, handleUpload(certKeyUpload.single('cert')), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'A certificate file is required' });
  }

  const filename = `${crypto.randomUUID()}-cert`;
  const destinationPath = path.join(CERTS_DIR, filename);

  try {
    await atomicFileWrite(destinationPath, req.file.buffer);
    await setTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.certPath, destinationPath, req.user.userId);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'settings.upload_cert', 'settings', null, null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ success: true, certPath: destinationPath });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to upload TAK Server certificate');
    res.status(500).json({ error: 'Failed to upload TAK Server certificate' });
  }
});

// POST /api/settings/tak-server/key (Requirement 32.4, Global_Manager-only).
// Accepts a single `key` multipart field, atomically writes it into
// CERTS_DIR, and updates tak_server_key_path to the resulting filesystem
// path via setTakServerConfigValue.
router.post('/tak-server/key', authenticateToken, authorize, handleUpload(certKeyUpload.single('key')), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'A key file is required' });
  }

  const filename = `${crypto.randomUUID()}-key`;
  const destinationPath = path.join(CERTS_DIR, filename);

  try {
    await atomicFileWrite(destinationPath, req.file.buffer);
    await setTakServerConfigValue(TAK_SERVER_CONFIG_KEYS.keyPath, destinationPath, req.user.userId);

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'settings.upload_key', 'settings', null, null]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({ success: true, keyPath: destinationPath });
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to upload TAK Server key');
    res.status(500).json({ error: 'Failed to upload TAK Server key' });
  }
});

/**
 * --- Configuration export (Requirement 32.5, task 54.5) ---
 *
 * `GET /api/settings/export` (Global_Manager-only) builds a zip archive
 * (via `archiver`) containing:
 *   - `settings.json`: every `system_config`/`site_config` row whose
 *     `config_key` appears in `exportableSettingsKeys.js`'s
 *     `systemConfigKeys`/`siteConfigKeys` arrays (queried with an
 *     `IN (...)` allow-list filter, so a row can only be included by
 *     being named in that shared module -- there is no "export
 *     everything" code path here).
 *   - `email_templates.json`: every row of the `email_templates` table,
 *     included wholesale (not key-filtered) per design.md's reasoning
 *     that template rows have no secret-shaped columns.
 *
 * Two separate JSON files (rather than one combined `export.json`) are
 * used inside the zip so the shape mirrors `exportableSettingsKeys.js`'s
 * own two-groups-plus-a-flag structure, and so a future
 * `POST /api/settings/import` (task 54.6) can validate/apply each file
 * independently (config_key allow-list check for `settings.json`,
 * shape check for `email_templates.json`) without first having to split
 * a combined document back apart.
 *
 * `tak_server_p12_passphrase` is never queried by this route (it is not
 * present in `exportableSettingsKeys.js`'s `systemConfigKeys`), so it is
 * structurally impossible for the exported zip to contain it -- see that
 * module's header comment for the full secrets-exclusion reasoning.
 *
 * The zip is streamed directly to the HTTP response as it is built
 * (`archive.pipe(res)`) rather than buffered fully in memory first, since
 * `archiver` supports pumping entries into a writable stream; this
 * settings dataset is small (a few dozen config rows plus template rows),
 * so streaming here is a memory-safety habit rather than a load-bearing
 * requirement, consistent with `GET /api/audit-logs/export.csv`'s existing
 * `csv-stringify` streaming pattern in `server/routes/auditLogs.js`.
 */
router.get('/export', authenticateToken, authorize, async (req, res) => {
  const allowedSystemConfigKeys = exportableSettingsKeys.systemConfigKeys;
  const allowedSiteConfigKeys = exportableSettingsKeys.siteConfigKeys;

  try {
    const systemConfigPlaceholders = allowedSystemConfigKeys.map((_, i) => `$${i + 1}`).join(',');
    const siteConfigPlaceholders = allowedSiteConfigKeys.map((_, i) => `$${i + 1}`).join(',');

    const [systemConfigResult, siteConfigResult, emailTemplatesResult] = await Promise.all([
      pool.query(
        `SELECT config_key, config_value, description FROM system_config WHERE config_key IN (${systemConfigPlaceholders})`,
        allowedSystemConfigKeys
      ),
      pool.query(
        `SELECT config_key, config_value, description FROM site_config WHERE config_key IN (${siteConfigPlaceholders})`,
        allowedSiteConfigKeys
      ),
      pool.query(
        'SELECT template_key, subject_template, body_template, description FROM email_templates ORDER BY template_key'
      )
    ]);

    const settingsPayload = {
      exportedAt: new Date().toISOString(),
      systemConfig: systemConfigResult.rows,
      siteConfig: siteConfigResult.rows
    };

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="settings-export.zip"');

    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (error) => {
      getLogger().error({ err: error }, 'Failed to build settings export archive');
      // Headers/body may already be partially sent once the archive
      // starts streaming; destroying the response is the only safe way
      // to signal failure to the client at that point.
      res.destroy(error);
    });

    archive.pipe(res);
    archive.append(JSON.stringify(settingsPayload, null, 2), { name: 'settings.json' });
    archive.append(JSON.stringify(emailTemplatesResult.rows, null, 2), { name: 'email_templates.json' });
    await archive.finalize();
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to export settings');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export settings' });
    } else {
      res.destroy(error);
    }
  }
});

/**
 * --- Configuration import (Requirement 32.6, task 54.6) ---
 *
 * `POST /api/settings/import` (Global_Manager-only) is the write-side
 * counterpart to `GET /api/settings/export` (task 54.5) above: it
 * restores `system_config`/`site_config` rows and (optionally)
 * `email_templates` rows from a previously exported archive, validating
 * every top-level `config_key` against the exact same
 * `exportableSettingsKeys.js` allow-list the export route reads from, and
 * rejecting the entire import -- applying nothing -- if any key falls
 * outside it (Requirement 32.6).
 *
 * --- Payload format: JSON body, not a re-uploaded zip ---
 *
 * `GET /api/settings/export` produces a zip containing `settings.json`
 * (`{exportedAt, systemConfig: [...], siteConfig: [...]}`) and
 * `email_templates.json` (an array of rows). This route accepts the
 * combined equivalent of those two files as a single JSON request body
 * (`{systemConfig: [...], siteConfig: [...], emailTemplates: [...]}`)
 * rather than a re-uploaded multipart zip file, for two reasons:
 *
 *   1. Dependency risk: this repo's only zip-reading library (`adm-zip`)
 *      is a `devDependency` (used exclusively by
 *      `server/routes/settings.test.js` to unzip the export route's
 *      output bytes for assertions), not a runtime `dependency`. Using a
 *      `devDependency` inside production request-handling code would mean
 *      the import route silently breaks in a `npm ci --omit=dev`
 *      production install (see task 61.1's Dockerfile plan, which does
 *      exactly that). `archiver` (a real runtime dependency, used by the
 *      export route above) only writes zip archives -- it has no
 *      unzip/read API -- so it cannot fill this role either. Adding a new
 *      pinned runtime dependency for this alone was judged unnecessary
 *      given option 2 below is simpler and already fully supported by
 *      existing infrastructure (`express.json({ limit: '10mb' })` in
 *      `server/index.js`).
 *   2. A JSON body round-trips losslessly with the export's own
 *      `settings.json`/`email_templates.json` shape: an operator (or a
 *      small script) can unzip an exported archive locally, merge
 *      `settings.json`'s `systemConfig`/`siteConfig` arrays and
 *      `email_templates.json`'s array into one object under
 *      `{systemConfig, siteConfig, emailTemplates}`, and POST that object
 *      directly -- no server-side unzip step, no temporary file handling,
 *      and no new attack surface from parsing untrusted archive bytes
 *      (zip parsers have a history of path-traversal/zip-bomb CVEs).
 *
 * If a future revision needs true zip-upload support, `adm-zip` (or an
 * equivalent) would need to be promoted from `devDependencies` to
 * `dependencies` with an exact pinned version first.
 *
 * --- Validation happens BEFORE any database write ---
 *
 * `validateImportPayload` below performs every check -- allow-list
 * membership for every `systemConfig`/`siteConfig` row's `config_key`,
 * and row-shape validation for every row of all three arrays -- and
 * returns a list of every problem found, without touching the database.
 * The route handler responds 400 with that full list (and applies
 * nothing) if the list is non-empty; only once validation has fully
 * passed does the handler open a transaction and start writing.
 * `tak_server_p12_passphrase` is excluded from
 * `exportableSettingsKeys.systemConfigKeys` (see that module's header
 * comment), so it is naturally rejected by the same allow-list check as
 * any other disallowed key -- there is no separate/special-cased check
 * for it in this route, confirming it cannot be imported via any path
 * through this handler.
 *
 * --- Atomic apply ---
 *
 * Once validation passes, every row is applied on a single
 * `pool.connect()`ed client inside one `BEGIN`/`COMMIT`-or-`ROLLBACK`
 * transaction (mirroring `GlobalChannelService`'s existing
 * `client.query('BEGIN')` .. `COMMIT`/`ROLLBACK` shape), so a mid-loop
 * database error (e.g. a constraint violation on some row after several
 * others have already been written) rolls back every row from this
 * import rather than leaving a partial apply. `system_config`/
 * `site_config` rows are upserted via the same
 * `INSERT ... ON CONFLICT (config_key) DO UPDATE` pattern already used by
 * `setTakServerConfigValue` above (every allow-listed key is expected to
 * already exist as a row per its seeding migration, but `ON CONFLICT`
 * makes this route tolerant of importing into a database where a row
 * happens to be missing, rather than silently skipping it).
 * `site_config` values are additionally run through the same
 * `sanitize-html` safe-subset used by `SiteConfig.update`
 * (Requirements 5.4-5.6), since this route writes `site_config` rows
 * directly via SQL rather than calling `SiteConfig.update` itself (that
 * model method has no transactional-client parameter to participate in
 * this route's single shared transaction). `email_templates` rows are
 * upserted by `template_key`. `updated_by` is set to `req.user.userId`
 * for every row touched, matching every other write route in this file.
 */

/**
 * Validates a single `system_config`/`site_config` import row's shape:
 * `config_key` must be a non-empty string, `config_value` must be a
 * string (the empty string is valid, since `site_config`/`system_config`'s
 * `config_value` column is `NOT NULL` but has no length floor).
 *
 * @param {*} row
 * @returns {boolean}
 */
function isValidConfigRowShape(row) {
  return Boolean(row)
    && typeof row === 'object'
    && typeof row.config_key === 'string'
    && row.config_key.length > 0
    && typeof row.config_value === 'string';
}

/**
 * Validates a single `email_templates` import row's shape: `template_key`,
 * `subject_template`, and `body_template` must each be a non-empty
 * string (matching `email_templates`'s own `NOT NULL` columns);
 * `description`, if present, must be a string or `null`.
 *
 * @param {*} row
 * @returns {boolean}
 */
function isValidEmailTemplateRowShape(row) {
  if (!row || typeof row !== 'object') {
    return false;
  }
  const hasRequiredStrings = typeof row.template_key === 'string' && row.template_key.length > 0
    && typeof row.subject_template === 'string' && row.subject_template.length > 0
    && typeof row.body_template === 'string' && row.body_template.length > 0;
  if (!hasRequiredStrings) {
    return false;
  }
  return row.description === undefined || row.description === null || typeof row.description === 'string';
}

/**
 * Validates an entire import payload against `exportableSettingsKeys.js`'s
 * allow-list (Requirement 32.6) and every row's shape, WITHOUT performing
 * any database access. Returns an array of human-readable problem strings;
 * an empty array means the payload is fully valid and safe to apply.
 *
 * @param {*} body - the parsed request body.
 * @returns {string[]} A list of validation problems, empty if none.
 */
function validateImportPayload(body) {
  const problems = [];

  if (!body || typeof body !== 'object') {
    return ['Request body must be a JSON object'];
  }

  const { systemConfig, siteConfig, emailTemplates } = body;

  if (!Array.isArray(systemConfig)) {
    problems.push('systemConfig must be an array');
  }
  if (!Array.isArray(siteConfig)) {
    problems.push('siteConfig must be an array');
  }
  if (emailTemplates !== undefined && !Array.isArray(emailTemplates)) {
    problems.push('emailTemplates must be an array when present');
  }

  // Stop here if the top-level shape is already wrong -- per-row checks
  // below assume each field is an array.
  if (problems.length > 0) {
    return problems;
  }

  systemConfig.forEach((row, index) => {
    if (!isValidConfigRowShape(row)) {
      problems.push(`systemConfig[${index}] must be an object with a non-empty string config_key and a string config_value`);
      return;
    }
    if (!exportableSettingsKeys.systemConfigKeys.includes(row.config_key)) {
      problems.push(`systemConfig[${index}] has a disallowed config_key: ${row.config_key}`);
    }
  });

  siteConfig.forEach((row, index) => {
    if (!isValidConfigRowShape(row)) {
      problems.push(`siteConfig[${index}] must be an object with a non-empty string config_key and a string config_value`);
      return;
    }
    if (!exportableSettingsKeys.siteConfigKeys.includes(row.config_key)) {
      problems.push(`siteConfig[${index}] has a disallowed config_key: ${row.config_key}`);
    }
  });

  if (Array.isArray(emailTemplates)) {
    emailTemplates.forEach((row, index) => {
      if (!isValidEmailTemplateRowShape(row)) {
        problems.push(`emailTemplates[${index}] must be an object with non-empty string template_key, subject_template, and body_template fields`);
      }
    });
  }

  return problems;
}

/**
 * Upserts a single `system_config`/`site_config` row on an
 * already-`BEGIN`-ed transactional client. `table` is always one of the
 * two hardcoded string literals passed by the call sites below (never
 * derived from request input), so this is not the kind of user-input-driven
 * SQL-identifier interpolation task 14.1 guarded against.
 *
 * `site_config` values are sanitized through the same safe-HTML subset
 * `SiteConfig.update` applies (Requirements 5.4-5.6); `system_config`
 * values are not (mirroring `setTakServerConfigValue`/the tak-mappings PUT
 * route above, neither of which sanitizes `system_config` values either).
 *
 * @param {import('pg').PoolClient} client
 * @param {'system_config'|'site_config'} table
 * @param {{config_key: string, config_value: string, description?: string|null}} row
 * @param {number|undefined} updatedBy
 * @returns {Promise<void>}
 */
async function upsertImportedConfigRow(client, table, row, updatedBy) {
  const value = table === 'site_config'
    ? sanitizeHtml(row.config_value, SANITIZE_HTML_OPTIONS)
    : row.config_value;

  await client.query(
    `INSERT INTO ${table} (config_key, config_value, description, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (config_key)
     DO UPDATE SET config_value = EXCLUDED.config_value, description = EXCLUDED.description, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [row.config_key, value, row.description === undefined ? null : row.description, updatedBy === undefined ? null : updatedBy]
  );
}

/**
 * Upserts a single `email_templates` row by `template_key` on an
 * already-`BEGIN`-ed transactional client.
 *
 * @param {import('pg').PoolClient} client
 * @param {{template_key: string, subject_template: string, body_template: string, description?: string|null}} row
 * @param {number|undefined} updatedBy
 * @returns {Promise<void>}
 */
async function upsertImportedEmailTemplateRow(client, row, updatedBy) {
  await client.query(
    `INSERT INTO email_templates (template_key, subject_template, body_template, description, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     ON CONFLICT (template_key)
     DO UPDATE SET subject_template = EXCLUDED.subject_template, body_template = EXCLUDED.body_template, description = EXCLUDED.description, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [row.template_key, row.subject_template, row.body_template, row.description === undefined ? null : row.description, updatedBy === undefined ? null : updatedBy]
  );
}

// POST /api/settings/import (Requirement 32.6, Global_Manager-only).
// See the header comment block above for the full design rationale
// (payload format choice, validate-before-write ordering, atomic apply).
router.post('/import', authenticateToken, authorize, async (req, res) => {
  const problems = validateImportPayload(req.body);

  if (problems.length > 0) {
    return res.status(400).json({ error: 'Import rejected: one or more settings are invalid or not allow-listed', problems });
  }

  const { systemConfig, siteConfig, emailTemplates } = req.body;
  const updatedBy = req.user && req.user.userId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of systemConfig) {
      await upsertImportedConfigRow(client, 'system_config', row, updatedBy);
    }
    for (const row of siteConfig) {
      await upsertImportedConfigRow(client, 'site_config', row, updatedBy);
    }
    if (Array.isArray(emailTemplates)) {
      for (const row of emailTemplates) {
        await upsertImportedEmailTemplateRow(client, row, updatedBy);
      }
    }

    await client.query('COMMIT');

    try {
      await pool.query(
        'INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
        [req.user.userId, 'settings.import', 'settings', null, JSON.stringify({ systemConfig: systemConfig.length, siteConfig: siteConfig.length, emailTemplates: Array.isArray(emailTemplates) ? emailTemplates.length : 0 })]
      );
    } catch (auditErr) {
      getLogger().error({ err: auditErr }, 'Failed to write audit log');
    }

    res.json({
      success: true,
      imported: {
        systemConfig: systemConfig.length,
        siteConfig: siteConfig.length,
        emailTemplates: Array.isArray(emailTemplates) ? emailTemplates.length : 0
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    getLogger().error({ err: error }, 'Failed to import settings');
    res.status(500).json({ error: 'Failed to import settings' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.COLOR_KEY_LABELS = COLOR_KEY_LABELS;
module.exports.ROLE_KEY_LABELS = ROLE_KEY_LABELS;
module.exports.TAK_ROLE_VALUES = TAK_ROLE_VALUES;
module.exports.TAK_MAPPING_CONFIG_KEYS = TAK_MAPPING_CONFIG_KEYS;
module.exports.BRANDING_CONFIG_KEYS = BRANDING_CONFIG_KEYS;
module.exports.TAK_SERVER_CONFIG_KEYS = TAK_SERVER_CONFIG_KEYS;
module.exports.getEffectiveTakServerConfigValue = getEffectiveTakServerConfigValue;
module.exports.setTakServerConfigValue = setTakServerConfigValue;
module.exports.atomicFileWrite = atomicFileWrite;
module.exports.UPLOADS_DIR = UPLOADS_DIR;
module.exports.CERTS_DIR = CERTS_DIR;
module.exports.validateImportPayload = validateImportPayload;
