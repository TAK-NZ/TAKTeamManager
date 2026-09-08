import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { ContextEnvironmentConfig } from '../stack-config';
import { DATABASE_CONSTANTS } from '../utils/constants';

/**
 * The Sync_Worker's own health server listens here (see
 * `server/workers/syncWorker.js`'s `SYNC_WORKER_HEALTH_PORT`, default 3001).
 * The container health check probes it; it is NOT behind the ALB (the worker
 * serves no user traffic), so no target group and no HTTP port mapping.
 */
const SYNC_WORKER_HEALTH_PORT = 3001;

export interface SyncWorkerServiceProps {
  envConfig: ContextEnvironmentConfig;
  removalPolicy: cdk.RemovalPolicy;

  cluster: ecs.ICluster;
  ecsSecurityGroup: ec2.ISecurityGroup;
  kmsKey: kms.IKey;

  /** This app's public base URL — carried for parity with the app container's
   *  env even though the worker serves no HTTP; some shared config reads it. */
  appUrl: string;

  // --- Database ---
  dbHostname: string;
  dbMasterSecret: secretsmanager.ISecret;

  // --- App-generated secrets (shared config validation reads them) ---
  jwtSecret: secretsmanager.ISecret;
  credentialEncryptionKey: secretsmanager.ISecret;

  // --- Authentik (imported + OIDC-setup) ---
  // The worker runs the SAME startup config validation as the app
  // (server/config/configValidator.js's REQUIRED_VARS covers both the App and
  // the Sync_Worker), so it needs the full OIDC config present even though it
  // performs no interactive OAuth itself — omitting AUTHENTIK_CLIENT_ID made
  // the worker fail fast at startup ("AUTHENTIK_CLIENT_ID is missing or
  // empty"). Mirror the app's Authentik env exactly.
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

  // --- Optional: offline maps ---
  offlineMapsEnabled: boolean;
  mapDownloadsBucket?: s3.IBucket;

  // --- Part-2 config file ---
  envConfigBucket: s3.IBucket;
  useS3ConfigFile: boolean;

  // --- Container image (shared with the app service) ---
  dockerImageAsset?: ecrAssets.DockerImageAsset;
  ecrRepository?: ecr.IRepository;
  imageTag?: string;
}

/**
 * A SEPARATE ECS Fargate service that runs the Sync_Worker process
 * (`node server/workers/syncWorker.js`), parallel to the app's web service.
 *
 * WHY A SEPARATE SERVICE (not a sidecar in the app task): matches the
 * ecosystem's own split (auth-infra runs its Authentik worker as its own
 * service alongside the server), lets the worker's lifecycle/scaling be
 * independent of the web tier, and keeps a worker crash from cycling the web
 * task (and vice versa).
 *
 * SHAPE vs. AppService — same task-def spine (image, roles, env, secrets, the
 * Part-2 EnvironmentFile, the shared `ecs` security group, PRIVATE_WITH_EGRESS
 * subnets, circuit breaker), but:
 *  - a DISTINCT family/service/log-group (`…-TAKTeamManager-SyncWorker`) so
 *    nothing collides with the app service,
 *  - the container `command` overrides the image CMD to run the worker
 *    (`node server/workers/syncWorker.js`). The image ENTRYPOINT still runs
 *    `docker-entrypoint.sh` (DB migrate+seed) first, then execs this command;
 *    that is idempotent and advisory-locked, so both the app and the worker
 *    running it on start is safe (2a),
 *  - HALF the app's CPU/memory (the worker is lighter than the web tier),
 *  - `desiredCount` mirrors the app (1 in dev-test, 2 in prod) for resiliency;
 *    at 2, the worker's PERIODIC jobs are single-runner-guarded in-process via
 *    a Postgres advisory lock (server/utils/jobLock.js) while the
 *    `sync_operations` queue drain runs in every worker (FOR UPDATE SKIP
 *    LOCKED),
 *  - NO ALB/target group and NO HTTP port mapping — the worker serves no user
 *    traffic; liveness is its own DB-heartbeat health server on
 *    SYNC_WORKER_HEALTH_PORT, probed by a container-level ECS health check.
 */
export class SyncWorkerService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: SyncWorkerServiceProps) {
    super(scope, id);

    const { envConfig } = props;
    const family = `TAK-${envConfig.stackName}-TAKTeamManager-SyncWorker`;
    const region = cdk.Stack.of(this).region;

    // --- Roles (same shape as AppService: exec reads secrets, task calls
    // Authentik/TAK/DB at runtime) ---
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
      ]
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `TAK-${envConfig.stackName}-TAKTeamManager sync worker task role`
    });

    // The worker re-resolves its own secrets at runtime under this stack's
    // secret-name prefix, exactly like the app.
    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:${cdk.Aws.PARTITION}:secretsmanager:${region}:${cdk.Aws.ACCOUNT_ID}:secret:TAK-${envConfig.stackName}-TAKTeamManager/*`
      ]
    }));
    props.kmsKey.grantDecrypt(taskRole);

    // --- Container image (reuse the app's asset/repo — no rebuild) ---
    let containerImage: ecs.ContainerImage;
    if (props.dockerImageAsset) {
      containerImage = ecs.ContainerImage.fromDockerImageAsset(props.dockerImageAsset);
    } else if (props.ecrRepository) {
      containerImage = ecs.ContainerImage.fromEcrRepository(props.ecrRepository, props.imageTag || 'latest');
    } else {
      throw new Error('SyncWorkerService requires either a dockerImageAsset or an ecrRepository');
    }

    // --- Log group (distinct name from the app's) ---
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/ecs/${family}`,
      retention: envConfig.general.enableDetailedLogging
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.TWO_WEEKS,
      removalPolicy: props.removalPolicy
    });

    // --- Task definition: HALF the app's cpu/memory (worker is lighter). Uses
    // Math.max to stay at valid Fargate floors even if the app were ever sized
    // down; today dev-test 512/1024 -> 256/512, prod 1024/2048 -> 512/1024. ---
    const workerCpu = Math.max(256, Math.floor(envConfig.ecs.taskCpu / 2));
    const workerMemory = Math.max(512, Math.floor(envConfig.ecs.taskMemory / 2));

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family,
      cpu: workerCpu,
      memoryLimitMiB: workerMemory,
      executionRole,
      taskRole
    });

    // Part-1 plain environment. Mirrors the app's non-secret env (DB,
    // Authentik, region) so the worker's shared config validation and its
    // Authentik/DB calls behave identically. Adds SYNC_WORKER_HEALTH_PORT for
    // the worker's own heartbeat health server; omits the app's HTTP `PORT`
    // (the worker serves no web traffic on it, only the health port).
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      AWS_REGION: region,
      APP_URL: props.appUrl,
      FRONTEND_URL: props.appUrl,
      SYNC_WORKER_HEALTH_PORT: String(SYNC_WORKER_HEALTH_PORT),
      // Full Authentik/OIDC config — required by the shared startup validator
      // (REQUIRED_VARS) even though the worker performs no interactive OAuth.
      AUTHENTIK_URL: props.authentikUrl,
      AUTHENTIK_CLIENT_ID: props.oidcClientId,
      AUTHENTIK_TOKEN_URL: props.oidcTokenUrl,
      AUTHENTIK_USERINFO_URL: props.oidcUserInfoUrl,
      AUTHENTIK_LOGOUT_URL: props.oidcLogoutUrl,
      JWT_EXPIRES_IN: '7d',
      DB_HOST: props.dbHostname,
      DB_PORT: String(DATABASE_CONSTANTS.PORT),
      DB_NAME: DATABASE_CONSTANTS.DEFAULT_DATABASE_NAME,
      DB_USER: DATABASE_CONSTANTS.USERNAME,
      // Same RDS CA bundle rationale as the app (baked into the image; set in
      // Part-1 so a stray Part-2 value cannot unset it).
      DB_CA_PATH: '/app/rds-global-bundle.pem',
      OFFLINE_MAPS_S3_REGION: region,
      OFFLINE_MAPS_URL_TTL_SECONDS: '300'
    };

    const secrets: Record<string, ecs.Secret> = {
      DB_PASSWORD: ecs.Secret.fromSecretsManager(props.dbMasterSecret, 'password'),
      JWT_SECRET: ecs.Secret.fromSecretsManager(props.jwtSecret),
      CREDENTIAL_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(props.credentialEncryptionKey),
      AUTHENTIK_API_TOKEN: ecs.Secret.fromSecretsManager(props.authentikTeamManagerTokenSecret),
      AUTHENTIK_CLIENT_SECRET: ecs.Secret.fromSecretsManager(props.oidcClientSecret)
    };

    if (props.offlineMapsEnabled && props.mapDownloadsBucket) {
      environment.OFFLINE_MAPS_S3_BUCKET = props.mapDownloadsBucket.bucketName;
      props.mapDownloadsBucket.grantRead(taskRole);
    }

    // Device management: the worker is the process that actually drains
    // revoke_tak_certificates and runs the device-mgmt jobs, so it needs the
    // TAK Server config + admin credential exactly like the app.
    if (props.deviceManagementEnabled) {
      if (props.takServerUrl) environment.TAK_SERVER_URL = props.takServerUrl;
      if (props.takCertEnrollmentUrl) environment.TAK_SERVER_ENROLLMENT_URL = props.takCertEnrollmentUrl;
      if (props.takAdminCertSecret) {
        environment.TAK_ADMIN_CERT_SOURCE = 'secrets-manager';
        environment.TAK_ADMIN_CERT_SECRET_ARN = props.takAdminCertSecret.secretArn;
        // The worker reads this binary P12 itself via the AWS SDK at runtime
        // (not an ECS env secret). Grant read; the loader uses the AWS SDK
        // directly for the P12 regardless of SECRETS_PROVIDER.
        props.takAdminCertSecret.grantRead(taskRole);
      }
      if (props.authentikAdminTokenSecret) {
        secrets.AUTHENTIK_ENROLLMENT_ADMIN_TOKEN = ecs.Secret.fromSecretsManager(props.authentikAdminTokenSecret);
      }
    }

    // Execution role reads every injected secret + decrypts at start.
    props.dbMasterSecret.grantRead(executionRole);
    props.jwtSecret.grantRead(executionRole);
    props.credentialEncryptionKey.grantRead(executionRole);
    props.authentikTeamManagerTokenSecret.grantRead(executionRole);
    props.oidcClientSecret.grantRead(executionRole);
    if (props.deviceManagementEnabled && props.authentikAdminTokenSecret) {
      props.authentikAdminTokenSecret.grantRead(executionRole);
    }
    props.kmsKey.grantDecrypt(executionRole);
    if (props.useS3ConfigFile) {
      props.envConfigBucket.grantRead(executionRole);
    }

    this.taskDefinition.addContainer('SyncWorkerContainer', {
      image: containerImage,
      // Override the image CMD to run the worker instead of the web server.
      // The image ENTRYPOINT (docker-entrypoint.sh) still runs first and execs
      // this as "$@": DB migrate+seed (idempotent, advisory-locked) then the
      // worker process.
      command: ['node', 'server/workers/syncWorker.js'],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'sync-worker', logGroup }),
      environment,
      secrets,
      environmentFiles: props.useS3ConfigFile
        ? [ecs.EnvironmentFile.fromBucket(props.envConfigBucket, 'tak-team-manager-config.env')]
        : undefined,
      // Container-level health check against the worker's OWN heartbeat health
      // server (SYNC_WORKER_HEALTH_PORT). No ALB target-group check exists for
      // the worker, so this is what lets ECS restart a wedged worker whose poll
      // loop has stopped writing its heartbeat. Uses BusyBox wget (no curl in
      // the image); the health server returns 503 (non-2xx -> wget exits
      // non-zero -> unhealthy) until the poll loop has written a fresh
      // heartbeat, so startPeriod is generous: the entrypoint runs migrations
      // before the worker binds, then the first poll cycle writes the first
      // heartbeat.
      healthCheck: {
        command: [
          'CMD-SHELL',
          `wget -q -O /dev/null http://localhost:${SYNC_WORKER_HEALTH_PORT}/ || exit 1`
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(180)
      }
    });

    // No port mappings: the worker exposes only its health port to itself
    // (localhost), never to the ALB or another task, so nothing needs
    // publishing at the task-networking level.

    // --- Service (no ALB/target group) ---
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: family,
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      // Mirror the app's count for resiliency: 1 in dev-test, 2 in prod. At 2,
      // the periodic jobs are advisory-lock single-runner-guarded and the queue
      // drain is parallel (FOR UPDATE SKIP LOCKED) — see the class doc.
      desiredCount: envConfig.ecs.desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.ecsSecurityGroup],
      enableExecuteCommand: envConfig.ecs.enableEcsExec,
      // Allow the running worker(s) to keep draining during a deploy while the
      // new task starts; a brief overlap is safe (SKIP LOCKED + advisory locks).
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true }
    });
  }
}
