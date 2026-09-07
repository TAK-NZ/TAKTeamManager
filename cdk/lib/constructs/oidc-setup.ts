import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as path from 'path';
import { ContextEnvironmentConfig } from '../stack-config';
import { OIDC_CONSTANTS } from '../utils/constants';

export interface OidcSetupProps {
  envConfig: ContextEnvironmentConfig;
  /** Authentik base URL (imported from auth-infra). */
  authentikUrl: string;
  /** Authentik admin token secret ARN (imported from auth-infra). */
  authentikAdminSecretArn: string;
  /** This app's public base URL, e.g. https://team.<zone>. */
  appUrl: string;
  kmsKey: kms.IKey;
}

/**
 * Provisions the Authentik OAuth2 provider + "Team Manager" application via a
 * custom-resource Lambda (mirroring CloudTAK's CloudTakOidcSetup). Exposes the
 * client id, the client secret (stored in its own Secrets Manager secret for
 * injection into the container), and the resolved OIDC endpoints.
 */
export class OidcSetup extends Construct {
  public readonly clientId: string;
  public readonly clientSecret: secretsmanager.ISecret;
  public readonly tokenUrl: string;
  public readonly userInfoUrl: string;
  public readonly logoutUrl: string;

  constructor(scope: Construct, id: string, props: OidcSetupProps) {
    super(scope, id);

    const { envConfig, authentikUrl, authentikAdminSecretArn, appUrl, kmsKey } = props;

    const setupFn = new nodejs.NodejsFunction(this, 'OidcSetupFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../src/oidc-setup/index.js'),
      // Pin the deps lock file to the Lambda's OWN lock, not cdk/'s root lock.
      // NodejsFunction otherwise walks up and picks cdk/package-lock.json,
      // which has no axios/form-data, so the in-bundle `npm ci` fails.
      depsLockFilePath: path.join(__dirname, '../../src/oidc-setup/package-lock.json'),
      projectRoot: path.join(__dirname, '../../src/oidc-setup'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node24',
        // AWS SDK v3 is provided by the Lambda runtime; keep it external.
        externalModules: ['@aws-sdk/*'],
        // Let esbuild install these from src/oidc-setup/package.json at synth
        // time (auth-infra's enroll-oidc-setup approach) rather than requiring
        // a pre-existing, committed node_modules dir.
        nodeModules: ['axios', 'form-data'],
        forceDockerBundling: false,
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          // The icon is read from disk at runtime, so it must be copied
          // alongside the bundled handler (same technique as CloudTAK).
          // inputDir is the projectRoot (src/oidc-setup), so the icon sits at
          // its top level.
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${inputDir}/ManageMyTeam.png ${outputDir}/ManageMyTeam.png`
          ]
        }
      },
      environment: {
        AUTHENTIK_URL: authentikUrl,
        AUTHENTIK_ADMIN_SECRET_ARN: authentikAdminSecretArn,
        PROVIDER_NAME: OIDC_CONSTANTS.PROVIDER_NAME,
        APPLICATION_NAME: OIDC_CONSTANTS.APPLICATION_NAME,
        APPLICATION_SLUG: OIDC_CONSTANTS.APPLICATION_SLUG,
        GROUP_NAME: OIDC_CONSTANTS.GROUP_NAME,
        LAUNCH_URL: appUrl,
        // The app runs the Authorization Code flow itself; register both the
        // primary and the silent (prompt=none) callback paths (server/routes/auth.js).
        REDIRECT_URIS: JSON.stringify([
          `${appUrl}/api/auth/callback`,
          `${appUrl}/api/auth/silent-callback`
        ])
      }
    });

    const adminSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'AuthentikAdminSecret',
      authentikAdminSecretArn
    );
    adminSecret.grantRead(setupFn);
    kmsKey.grantDecrypt(setupFn);

    const provider = new cr.Provider(this, 'OidcSetupProvider', {
      onEventHandler: setupFn
    });

    const oidcSetup = new cdk.CustomResource(this, 'OidcSetup', {
      serviceToken: provider.serviceToken,
      properties: {
        AuthentikUrl: authentikUrl,
        AppUrl: appUrl,
        // Force the custom resource to run on every deploy so redirect-URI /
        // launch-URL changes are re-applied.
        Timestamp: Date.now()
      }
    });

    this.clientId = oidcSetup.getAttString('clientId');
    this.tokenUrl = oidcSetup.getAttString('tokenUrl');
    this.userInfoUrl = oidcSetup.getAttString('userInfoUrl');
    this.logoutUrl = oidcSetup.getAttString('logoutUrl');

    this.clientSecret = new secretsmanager.Secret(this, 'ClientSecret', {
      secretName: `TAK-${envConfig.stackName}-TAKTeamManager/Authentik-OIDC-Client-Secret`,
      description: 'Authentik OIDC client secret for TAK Team Manager',
      encryptionKey: kmsKey,
      secretStringValue: cdk.SecretValue.resourceAttribute(oidcSetup.getAttString('clientSecret'))
    });
  }
}
