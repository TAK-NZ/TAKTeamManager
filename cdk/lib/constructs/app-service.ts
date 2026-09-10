import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { ContextEnvironmentConfig } from '../stack-config';
import { APP_CONSTANTS, DATABASE_CONSTANTS, TAK_SERVER_CONSTANTS } from '../utils/constants';

export interface AppServiceProps {
  envConfig: ContextEnvironmentConfig;
  removalPolicy: cdk.RemovalPolicy;

  vpc: ec2.IVpc;
  cluster: ecs.ICluster;
  ecsSecurityGroup: ec2.ISecurityGroup;
  kmsKey: kms.IKey;
  targetGroup: elbv2.ApplicationTargetGroup;

  /** This app's public base URL (https://team.<zone>) — APP_URL / FRONTEND_URL. */
  appUrl: string;

  // --- Database ---
  dbHostname: string;
  dbMasterSecret: secretsmanager.ISecret;

  // --- App-generated secrets ---
  jwtSecret: secretsmanager.ISecret;
  credentialEncryptionKey: secretsmanager.ISecret;

  // --- Authentik (imported + OIDC-setup) ---
  authentikUrl: string;
  authentikTeamManagerTokenSecret: secretsmanager.ISecret;
  oidcClientId: string;
  oidcClientSecret: secretsmanager.ISecret;
  oidcTokenUrl: string;
  oidcUserInfoUrl: string;
  oidcLogoutUrl: string;

  // --- Optional: device management (tak-infra) ---
  deviceManagementEnabled: boolean;
  authentikAdminTokenSecret?: secretsmanager.ISecret;
  takServerUrl?: string;
  takCertEnrollmentUrl?: string;
  takAdminCertSecret?: secretsmanager.ISecret;

  // --- Optional: offline maps (base-infra map-downloads bucket) ---
  offlineMapsEnabled: boolean;
  mapDownloadsBucket?: s3.IBucket;

  // --- Part-2 config file (base-infra env-config bucket) ---
  envConfigBucket: s3.IBucket;
  /**
   * When true, attach the `tak-team-manager-config.env` S3 EnvironmentFile
   * (matching auth-infra's `useS3AuthentikConfigFile` / tak-infra's
   * `useS3TAKServerConfigFile`). The object must already exist in the
   * env-config bucket at deploy time, or ECS task starts will fail.
   */
  useS3ConfigFile: boolean;

  // --- Container image ---
  /** When set, use this locally-built Docker image asset. */
  dockerImageAsset?: ecrAssets.DockerImageAsset;
  /** When `dockerImageAsset` is unset, pull from this repo at `imageTag`. */
  ecrRepository?: ecr.IRepository;
  imageTag?: string;
}

/**
 * The ECS Fargate task definition + service for TAK Team Manager. One web
 * service (Express API + built SPA on the same origin) behind the shared ALB.
 *
 * Follows CloudTAK's cloudtak-api pattern: an execution role that can read the
 * injected secrets, a task role scoped to what the app calls at runtime, a
 * container fed a Part-1 `environment`/`secrets` map by CDK plus a Part-2 S3
 * `EnvironmentFile` for the ops-editable config.
 */
export class AppService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: AppServiceProps) {
    super(scope, id);

    const { envConfig } = props;
    const family = `TAK-${envConfig.stackName}-TAKTeamManager`;
    const region = cdk.Stack.of(this).region;

    // --- Roles ---
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ]
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `TAK-${envConfig.stackName}-TAKTeamManager task role`
    });

    // The app may re-resolve its own secrets at runtime (SECRETS_PROVIDER),
    // and reads the DB/JWT/credential/authentik secrets — all under this
    // stack's own secret name prefix. Scope GetSecretValue to that prefix.
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:secretsmanager:${region}:${cdk.Aws.ACCOUNT_ID}:secret:TAK-${envConfig.stackName}-TAKTeamManager/*`
      ]
    }));
    props.kmsKey.grantDecrypt(taskRole);

    // --- Container image ---
    let containerImage: ecs.ContainerImage;
    if (props.dockerImageAsset) {
      containerImage = ecs.ContainerImage.fromDockerImageAsset(props.dockerImageAsset);
    } else if (props.ecrRepository) {
      containerImage = ecs.ContainerImage.fromEcrRepository(props.ecrRepository, props.imageTag || 'latest');
    } else {
      throw new Error('AppService requires either a dockerImageAsset or an ecrRepository');
    }

    // --- Log group ---
    // ALWAYS DESTROY, deliberately NOT the env-derived `props.removalPolicy`
    // (RETAIN under the prod profile). A log group is a reproducible resource,
    // recreated on every deploy; matching auth-infra, only stateful data
    // stores follow RETAIN-in-prod. A RETAIN here orphaned the log group on a
    // rolled-back CREATE (DELETE_SKIPPED), and its stable `logGroupName` then
    // collided on the next attempt — the demo pipeline deploys the prod
    // profile to a disposable stack, so this bit on every retry.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/ecs/${family}`,
      retention: envConfig.general.enableDetailedLogging
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // --- Task definition ---
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family,
      cpu: envConfig.ecs.taskCpu,
      memoryLimitMiB: envConfig.ecs.taskMemory,
      executionRole,
      taskRole
    });

    // Part-1 plain environment (imported/local, non-secret).
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      PORT: String(APP_CONSTANTS.CONTAINER_PORT),
      // Behind exactly one proxy (the ALB), no CDN in front.
      TRUSTED_PROXY_HOPS: '1',
      AWS_REGION: region,
      // One SPA on one origin.
      APP_URL: props.appUrl,
      FRONTEND_URL: props.appUrl,
      // Authentik / OIDC.
      AUTHENTIK_URL: props.authentikUrl,
      AUTHENTIK_CLIENT_ID: props.oidcClientId,
      AUTHENTIK_TOKEN_URL: props.oidcTokenUrl,
      AUTHENTIK_USERINFO_URL: props.oidcUserInfoUrl,
      AUTHENTIK_LOGOUT_URL: props.oidcLogoutUrl,
      // JWT lifetime (the secret itself is injected below).
      JWT_EXPIRES_IN: '7d',
      // Database (password injected as a secret below).
      DB_HOST: props.dbHostname,
      DB_PORT: String(DATABASE_CONSTANTS.PORT),
      DB_NAME: DATABASE_CONSTANTS.DEFAULT_DATABASE_NAME,
      DB_USER: DATABASE_CONSTANTS.USERNAME,
      // Aurora presents an Amazon RDS root CA that is NOT in Node's default
      // trust store, so the app (which keeps rejectUnauthorized:true in prod)
      // needs the RDS CA bundle to verify it — otherwise every DB connection
      // fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. The bundle is baked into
      // the image at this path by the Dockerfile; set DB_CA_PATH here in Part-1
      // (container `environment`, which takes precedence over the Part-2
      // EnvironmentFile) so a stray/empty DB_CA_PATH in the ops config file
      // cannot silently unset it and re-break DB connectivity.
      DB_CA_PATH: '/app/rds-global-bundle.pem',
      // Offline-maps presign region + TTL (bucket name added below if enabled).
      OFFLINE_MAPS_S3_REGION: region,
      OFFLINE_MAPS_URL_TTL_SECONDS: '300'
    };

    // Part-1 secrets (injected literally into process.env by ECS at start).
    const secrets: Record<string, ecs.Secret> = {
      DB_PASSWORD: ecs.Secret.fromSecretsManager(props.dbMasterSecret, 'password'),
      JWT_SECRET: ecs.Secret.fromSecretsManager(props.jwtSecret),
      CREDENTIAL_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(props.credentialEncryptionKey),
      AUTHENTIK_API_TOKEN: ecs.Secret.fromSecretsManager(props.authentikTeamManagerTokenSecret),
      AUTHENTIK_CLIENT_SECRET: ecs.Secret.fromSecretsManager(props.oidcClientSecret)
    };

    // Offline maps: only inject the bucket name + grant read when enabled.
    if (props.offlineMapsEnabled && props.mapDownloadsBucket) {
      environment.OFFLINE_MAPS_S3_BUCKET = props.mapDownloadsBucket.bucketName;
      props.mapDownloadsBucket.grantRead(taskRole);
    }

    // Device management (TAK Server): only wire when enabled.
    if (props.deviceManagementEnabled) {
      if (props.takServerUrl) {
        environment.TAK_SERVER_URL = props.takServerUrl;
        // TAK Server's certificate carries only CN=takserver / DNS:takserver,
        // never the dialed load-balancer host, so pin the TLS identity check to
        // that name (narrows which name is verified, not whether).
        environment.TAK_SERVER_TLS_SERVERNAME = TAK_SERVER_CONSTANTS.TLS_SERVERNAME;
      }
      if (props.takCertEnrollmentUrl) environment.TAK_SERVER_ENROLLMENT_URL = props.takCertEnrollmentUrl;
      if (props.takAdminCertSecret) {
        environment.TAK_ADMIN_CERT_SOURCE = 'secrets-manager';
        environment.TAK_ADMIN_CERT_SECRET_ARN = props.takAdminCertSecret.secretArn;
        // The app reads this secret itself via the AWS SDK (not an ECS secret,
        // since it is a binary P12 the app fetches at runtime).
        props.takAdminCertSecret.grantRead(taskRole);
      }
      if (props.authentikAdminTokenSecret) {
        secrets.AUTHENTIK_ENROLLMENT_ADMIN_TOKEN = ecs.Secret.fromSecretsManager(props.authentikAdminTokenSecret);
      }
    }

    // The execution role must be able to READ every injected secret + decrypt
    // them at container start.
    props.dbMasterSecret.grantRead(executionRole);
    props.jwtSecret.grantRead(executionRole);
    props.credentialEncryptionKey.grantRead(executionRole);
    props.authentikTeamManagerTokenSecret.grantRead(executionRole);
    props.oidcClientSecret.grantRead(executionRole);
    if (props.deviceManagementEnabled && props.authentikAdminTokenSecret) {
      props.authentikAdminTokenSecret.grantRead(executionRole);
    }
    props.kmsKey.grantDecrypt(executionRole);
    // Execution role reads the Part-2 S3 config file (EnvironmentFile) only
    // when it is actually attached.
    if (props.useS3ConfigFile) {
      props.envConfigBucket.grantRead(executionRole);
    }

    const container = this.taskDefinition.addContainer('AppContainer', {
      image: containerImage,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'app', logGroup }),
      environment,
      secrets,
      // Part-2: the ops-editable deployment config file in the shared base-infra
      // env-config bucket. Replacing this S3 object + restarting the task
      // applies changes with no CDK redeploy. Gated behind a context flag
      // (useS3TAKTeamManagerConfigFile) so a deploy does not fail when the
      // object has not been uploaded yet — matching the other TAK-NZ layers.
      environmentFiles: props.useS3ConfigFile
        ? [ecs.EnvironmentFile.fromBucket(props.envConfigBucket, 'tak-team-manager-config.env')]
        : undefined
    });

    container.addPortMappings({
      containerPort: APP_CONSTANTS.CONTAINER_PORT,
      protocol: ecs.Protocol.TCP
    });

    // --- Service ---
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: family,
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: envConfig.ecs.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.ecsSecurityGroup],
      enableExecuteCommand: envConfig.ecs.enableEcsExec,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // The container runs DB migrations + seed (docker-entrypoint.sh) before
      // it starts listening on the container port, so a fresh task is not
      // reachable for a while on first boot. Give the ALB target-group health
      // check a grace period so it does not deregister/kill the task mid-
      // migration and thrash the deploy. 5 min comfortably covers the baseline
      // migration on a fresh Aurora.
      healthCheckGracePeriod: cdk.Duration.minutes(5),
      circuitBreaker: { rollback: true }
    });

    this.service.attachToApplicationTargetGroup(props.targetGroup);
  }
}
