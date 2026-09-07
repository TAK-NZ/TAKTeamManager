'use strict';

/**
 * CloudFormation custom-resource handler that provisions (or updates) the
 * Authentik OAuth2 provider + application for TAK Team Manager, mirroring
 * CloudTAK's own OIDC-setup Lambda.
 *
 * On CREATE/UPDATE it:
 *   1. resolves the default authorization + invalidation flows,
 *   2. ensures the standard openid/email/profile scope mappings exist,
 *   3. creates/updates the OAuth2 provider (confidential client, the app's
 *      two redirect URIs — the primary and silent callbacks),
 *   4. creates/updates the "Team Manager" application (slug team-manager),
 *   5. uploads the bundled icon to Authentik media (idempotent) and assigns it
 *      to the application via `meta_icon`,
 *   6. assigns the application to the "Team Awareness Kit" group,
 *   7. returns the client id/secret and the resolved OIDC endpoints.
 *
 * On DELETE it leaves the Authentik resources in place (matching CloudTAK —
 * deleting an IdP application on a stack teardown is rarely what an operator
 * wants, and re-create is idempotent).
 */
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

exports.handler = async (event) => {
  console.log('TAK Team Manager OIDC Setup - RequestType:', event.RequestType);

  try {
    if (event.RequestType === 'Delete') {
      return { PhysicalResourceId: event.PhysicalResourceId || 'tak-team-manager-oidc-setup', Data: {} };
    }

    // Resolve the Authentik admin token from Secrets Manager.
    const secretsManager = new SecretsManagerClient();
    const secretData = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: process.env.AUTHENTIK_ADMIN_SECRET_ARN })
    );
    let adminToken;
    try {
      adminToken = JSON.parse(secretData.SecretString).token;
    } catch {
      adminToken = secretData.SecretString;
    }

    const authentikUrl = process.env.AUTHENTIK_URL;
    const api = axios.create({
      baseURL: authentikUrl,
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
    });

    const authorizationFlow = await getFlowByName(api, 'default-provider-authorization-implicit-consent');
    const invalidationFlow = await getFlowByName(api, 'default-provider-invalidation-flow');

    // Standard OIDC scopes. TAK Team Manager reads group membership via its
    // API token, not the OIDC claim, so no custom `groups` scope mapping is
    // needed (unlike CloudTAK).
    const scopeMappings = [];
    for (const scope of ['email', 'openid', 'profile']) {
      const mapping = await getOrCreateScopeMapping(api, scope);
      scopeMappings.push(mapping.pk);
    }

    const redirectUris = JSON.parse(process.env.REDIRECT_URIS).map((url) => ({
      url,
      matching_mode: 'strict'
    }));

    // Resolve an RSA signing keypair so id_tokens are signed (and the
    // provider's OIDC discovery advertises a JWKS). Without a signing_key the
    // provider still works for the plain authorization_code flow, but hybrid/
    // implicit id_tokens are unsigned; matching the working reference provider
    // means always assigning one. Falls back to null (unsigned) only if the
    // instance genuinely has no RSA keypair, rather than failing the deploy.
    const signingKey = await getSigningKey(api);

    const provider = await createOrUpdateProvider(api, {
      name: process.env.PROVIDER_NAME,
      authorization_flow: authorizationFlow.pk,
      invalidation_flow: invalidationFlow.pk,
      redirect_uris: redirectUris,
      client_type: 'confidential',
      // REQUIRED. Authentik defaults `grant_types` to an EMPTY array when it
      // is omitted from the create/update payload, and a provider with no
      // grant types rejects every authorize request with `invalid_request`
      // ("The request is otherwise malformed") and issues no code -- the
      // callback then sees no `code` and redirects to `?error=no_code`. These
      // three match the reference provider and cover the standard OIDC flows
      // this app (authorization_code) and any hybrid/implicit consumer use.
      grant_types: ['authorization_code', 'implicit', 'hybrid'],
      signing_key: signingKey,
      include_claims_in_id_token: true,
      access_code_validity: 'minutes=1',
      access_token_validity: 'minutes=5',
      refresh_token_validity: 'days=30',
      property_mappings: scopeMappings
    });

    const applicationSlug = process.env.APPLICATION_SLUG;
    const application = await createOrUpdateApplication(api, {
      name: process.env.APPLICATION_NAME,
      slug: applicationSlug,
      provider: provider.pk,
      meta_launch_url: process.env.LAUNCH_URL,
      meta_description: 'Manage TAK teams, users and channels.',
      open_in_new_tab: false
    });

    await assignApplicationIcon(api, application.slug);

    if (process.env.GROUP_NAME) {
      await assignGroupToApplication(api, application.slug, process.env.GROUP_NAME);
    }

    const oidcConfig = await getOidcConfiguration(authentikUrl, applicationSlug);

    console.log('TAK Team Manager OIDC setup completed successfully');
    return {
      PhysicalResourceId: provider.pk.toString(),
      Data: {
        clientId: provider.client_id,
        clientSecret: provider.client_secret,
        issuer: oidcConfig.issuer,
        authorizeUrl: oidcConfig.authorizeUrl,
        tokenUrl: oidcConfig.tokenUrl,
        userInfoUrl: oidcConfig.userInfoUrl,
        logoutUrl: oidcConfig.logoutUrl
      }
    };
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    throw error;
  }
};

async function getFlowByName(api, slug) {
  const byName = await api.get('/api/v3/flows/instances/', { params: { slug } });
  if (byName.data.results && byName.data.results.length > 0) {
    return byName.data.results[0];
  }
  const all = await api.get('/api/v3/flows/instances/');
  const flow = all.data.results.find((f) => f.slug === slug);
  if (flow) return flow;
  throw new Error(`Flow not found: ${slug}`);
}

// Resolve an RSA signing keypair (a `crypto-certificates` keypair that has a
// private key) to sign the provider's id_tokens. Prefers Authentik's built-in
// "authentik Self-signed Certificate", falling back to the first keypair that
// carries a private key. Returns its pk, or null when the instance has no
// usable keypair (the provider is still created, just without id_token
// signing) so a missing key never fails the whole deploy.
async function getSigningKey(api) {
  try {
    const res = await api.get('/api/v3/crypto/certificatekeypairs/', {
      params: { has_key: true }
    });
    const results = (res.data && res.data.results) || [];
    if (results.length === 0) return null;
    const preferred = results.find((k) => /self-signed/i.test(k.name || ''));
    return (preferred || results[0]).pk;
  } catch (error) {
    console.warn('Could not resolve a signing key; provider will be created without one:', error.message);
    return null;
  }
}

async function createOrUpdateProvider(api, providerData) {
  const existing = await api.get('/api/v3/providers/oauth2/', { params: { name: providerData.name } });
  let provider;
  if (existing.data.results && existing.data.results.length > 0) {
    const found = existing.data.results[0];
    provider = (await api.patch(`/api/v3/providers/oauth2/${found.pk}/`, providerData)).data;
  } else {
    provider = (await api.post('/api/v3/providers/oauth2/', providerData)).data;
  }
  if (!provider.client_id || !provider.client_secret) {
    provider = (await api.get(`/api/v3/providers/oauth2/${provider.pk}/`)).data;
  }
  return provider;
}

async function createOrUpdateApplication(api, applicationData) {
  try {
    await api.get(`/api/v3/core/applications/${applicationData.slug}/`);
    return (await api.patch(`/api/v3/core/applications/${applicationData.slug}/`, applicationData)).data;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return (await api.post('/api/v3/core/applications/', applicationData)).data;
    }
    throw error;
  }
}

async function assignGroupToApplication(api, appSlug, groupName) {
  try {
    await api.patch(`/api/v3/core/applications/${appSlug}/`, { group: groupName });
  } catch (error) {
    console.warn('Failed to assign group:', error.message);
  }
}

// Upload the bundled PNG into Authentik's media storage under a STABLE name,
// then point the application's `meta_icon` at that same media path.
//
// Both steps and their exact shapes were verified live against Authentik
// 2026.8.1:
//   - Upload: POST multipart to /api/v3/admin/file/ with `file` + `name`.
//     This endpoint is NOT idempotent — re-uploading an existing name returns
//     `400 {"name":["A file with this name already exists."]}`, which we treat
//     as success (the file we need is already there). It also returns an EMPTY
//     body on success (>= 2025.12), so there is NO URL to read back.
//   - Assign: `meta_icon` on the application is a plain writable STRING in the
//     API schema (PatchedApplicationRequest.meta_icon: string), so a JSON
//     `PATCH { meta_icon: '<media name>' }` is the correct call. The earlier
//     bug set `meta_icon` to the (empty) upload response `.url`, which PATCHed
//     `undefined` and left the icon blank. Setting it to the media NAME we
//     uploaded under is what makes `meta_icon_url` resolve to
//     /files/media/public/<name>. `meta_icon_url` itself is read-only.
const APPLICATION_ICON_MEDIA_NAME = 'application-icons/ManageMyTeam.png';

async function assignApplicationIcon(api, appSlug) {
  try {
    // Step 1: ensure the file is in media storage under the stable name.
    const iconPath = path.join(__dirname, 'ManageMyTeam.png');
    if (!fs.existsSync(iconPath)) {
      console.warn('Icon file not found at', iconPath, '- skipping icon assignment');
      return;
    }
    const form = new FormData();
    form.append('file', fs.createReadStream(iconPath), 'ManageMyTeam.png');
    form.append('name', APPLICATION_ICON_MEDIA_NAME);
    try {
      await axios.post(`${api.defaults.baseURL}/api/v3/admin/file/`, form, {
        headers: { Authorization: api.defaults.headers.Authorization, ...form.getHeaders() }
      });
      console.log(`Icon uploaded to media storage as: ${APPLICATION_ICON_MEDIA_NAME}`);
    } catch (uploadError) {
      const status = uploadError.response && uploadError.response.status;
      const detail = JSON.stringify((uploadError.response && uploadError.response.data) || '');
      if (status === 400 && detail.includes('already exists')) {
        console.log(`Icon ${APPLICATION_ICON_MEDIA_NAME} already present in media storage; reusing it`);
      } else {
        throw uploadError;
      }
    }

    // Step 2: point the application at that media path (idempotent). `meta_icon`
    // is a plain string field — a JSON PATCH is the verified-correct call.
    const current = await api.get(`/api/v3/core/applications/${appSlug}/`);
    if (current.data.meta_icon === APPLICATION_ICON_MEDIA_NAME) {
      console.log('Application already points at the expected icon; nothing to do');
      return;
    }
    await api.patch(`/api/v3/core/applications/${appSlug}/`, { meta_icon: APPLICATION_ICON_MEDIA_NAME });
    console.log(`Icon assigned to application ${appSlug}: ${APPLICATION_ICON_MEDIA_NAME}`);
  } catch (error) {
    // Non-fatal: a missing/failed icon must not fail the whole OIDC provisioning.
    console.warn('Failed to assign application icon:', error.response ? JSON.stringify(error.response.data) : error.message);
  }
}

async function getOrCreateScopeMapping(api, scopeName) {
  const existing = await api.get('/api/v3/propertymappings/provider/scope/', { params: { scope_name: scopeName } });
  if (existing.data.results && existing.data.results.length > 0) {
    return existing.data.results[0];
  }
  return (await api.post('/api/v3/propertymappings/provider/scope/', {
    name: `authentik default OAuth Mapping: OpenID '${scopeName}'`,
    scope_name: scopeName,
    expression: 'return {}',
    description: `Standard OpenID Connect scope: ${scopeName}`
  })).data;
}

async function getOidcConfiguration(authentikUrl, applicationSlug) {
  try {
    const url = `${authentikUrl}/application/o/${applicationSlug}/.well-known/openid-configuration`;
    const response = await axios.create().get(url);
    return {
      issuer: response.data.issuer,
      authorizeUrl: response.data.authorization_endpoint,
      tokenUrl: response.data.token_endpoint,
      userInfoUrl: response.data.userinfo_endpoint,
      logoutUrl: response.data.end_session_endpoint
        || `${authentikUrl}/application/o/${applicationSlug}/end-session/`
    };
  } catch (error) {
    console.warn('Failed to fetch OIDC config, using defaults:', error.message);
    return {
      issuer: `${authentikUrl}/application/o/${applicationSlug}/`,
      authorizeUrl: `${authentikUrl}/application/o/authorize/`,
      tokenUrl: `${authentikUrl}/application/o/token/`,
      userInfoUrl: `${authentikUrl}/application/o/userinfo/`,
      logoutUrl: `${authentikUrl}/application/o/${applicationSlug}/end-session/`
    };
  }
}
