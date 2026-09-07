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
 *   5. uploads the application icon,
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

    const provider = await createOrUpdateProvider(api, {
      name: process.env.PROVIDER_NAME,
      authorization_flow: authorizationFlow.pk,
      invalidation_flow: invalidationFlow.pk,
      redirect_uris: redirectUris,
      client_type: 'confidential',
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

    await uploadApplicationIcon(api, application.slug);

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

async function uploadApplicationIcon(api, appSlug) {
  try {
    const current = await api.get(`/api/v3/core/applications/${appSlug}/`);
    if (current.data.meta_icon) {
      console.log('Application already has an icon; leaving it in place');
      return;
    }
    const iconPath = path.join(__dirname, 'ManageMyTeam.png');
    if (!fs.existsSync(iconPath)) {
      console.warn('Icon file not found at', iconPath);
      return;
    }
    const form = new FormData();
    form.append('file', fs.createReadStream(iconPath), 'ManageMyTeam.png');
    const uploadResponse = await axios.post(`${api.defaults.baseURL}/api/v3/admin/file/`, form, {
      headers: { Authorization: api.defaults.headers.Authorization, ...form.getHeaders() }
    });
    await api.patch(`/api/v3/core/applications/${appSlug}/`, { meta_icon: uploadResponse.data.url });
    console.log('Icon uploaded successfully');
  } catch (error) {
    console.warn('Failed to upload icon:', error.message);
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
