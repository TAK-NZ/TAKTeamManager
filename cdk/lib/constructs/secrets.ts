import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as path from 'path';
import { ContextEnvironmentConfig } from '../stack-config';

export interface AppSecretsProps {
  envConfig: ContextEnvironmentConfig;
  kmsKey: kms.IKey;
  removalPolicy: cdk.RemovalPolicy;
}

/**
 * Application secrets this stack synthesizes itself — no human ever chooses
 * the value — mirroring how auth-infra generates its own AuthentikSecretKey.
 * Both are encrypted with the imported BaseInfra KMS key and injected into the
 * container via `ecs.Secret.fromSecretsManager`.
 *
 *   - jwtSecret               signs the `tak_session` JWT (>= 32 chars). A
 *                             plain `generateSecretString` password suffices.
 *   - credentialEncryptionKey base64-encoded 32-byte AES-256-GCM key. The app
 *                             requires it to `Buffer.from(v,'base64')` to
 *                             EXACTLY 32 bytes, which `generateSecretString`
 *                             cannot guarantee, so a tiny generator Lambda
 *                             writes `randomBytes(32).toString('base64')`.
 */
export class AppSecrets extends Construct {
  public readonly jwtSecret: secretsmanager.Secret;
  public readonly credentialEncryptionKey: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: AppSecretsProps) {
    super(scope, id);

    const { envConfig, kmsKey, removalPolicy } = props;
    const prefix = `TAK-${envConfig.stackName}-TAKTeamManager`;

    // JWT signing secret — any 64 alphanumeric chars (>= the app's 32 min).
    this.jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: `${prefix}/JWT-Secret`,
      description: 'JWT signing secret for TAK Team Manager session cookies',
      encryptionKey: kmsKey,
      removalPolicy,
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
        includeSpace: false
      }
    });

    // Credential-encryption key: an empty secret CDK creates (encrypted with
    // the KMS key), then a generator Lambda fills with a real base64 32-byte
    // value on create. `generateSecretString` is deliberately NOT used — it
    // cannot emit valid base64-of-32-bytes, which the app strictly validates.
    this.credentialEncryptionKey = new secretsmanager.Secret(this, 'CredentialEncryptionKey', {
      secretName: `${prefix}/Credential-Encryption-Key`,
      description: 'AES-256-GCM key (base64 32 bytes) for encrypting BCH service-account passwords',
      encryptionKey: kmsKey,
      removalPolicy
    });

    const generatorFn = new nodejs.NodejsFunction(this, 'SecretGeneratorFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, '../../src/secret-generator/index.js'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(1),
      memorySize: 128,
      bundling: {
        minify: true,
        target: 'node24',
        externalModules: ['@aws-sdk/*']
      }
    });
    this.credentialEncryptionKey.grantWrite(generatorFn);

    const provider = new cr.Provider(this, 'SecretGeneratorProvider', {
      onEventHandler: generatorFn
    });

    // On create only: generate randomBytes(32).toString('base64') into the
    // secret. Never regenerates on update/delete, so the key is stable across
    // deploys (a changed key would make every stored ciphertext undecryptable).
    new cdk.CustomResource(this, 'CredentialEncryptionKeyValue', {
      serviceToken: provider.serviceToken,
      properties: {
        SecretArn: this.credentialEncryptionKey.secretArn
      }
    });
  }
}
