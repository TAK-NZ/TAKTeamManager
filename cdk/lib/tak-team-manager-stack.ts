import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Fn } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

import { ContextEnvironmentConfig } from './stack-config';
import {
  createBaseImportValue,
  createAuthImportValue,
  createTakImportValue,
  BASE_EXPORT_NAMES,
  AUTH_EXPORT_NAMES,
  TAK_EXPORT_NAMES
} from './cloudformation-imports';
import { SecurityGroups } from './constructs/security-groups';
import { AppSecrets } from './constructs/secrets';
import { Database } from './constructs/database';
import { LoadBalancer } from './constructs/load-balancer';
import { Route53 } from './constructs/route53';
import { OidcSetup } from './constructs/oidc-setup';
import { AppService } from './constructs/app-service';
import { registerOutputs } from './outputs';

export interface TakTeamManagerStackProps extends cdk.StackProps {
  environment: 'prod' | 'dev-test';
  envConfig: ContextEnvironmentConfig;
}

export class TakTeamManagerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TakTeamManagerStackProps) {
    super(scope, id, props);

    const { envConfig } = props;
    const stackNameComponent = envConfig.stackName;

    const removalPolicy = envConfig.general.removalPolicy === 'RETAIN'
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    // ------------------------------------------------------------------
    // Cross-stack imports (base-infra)
    // ------------------------------------------------------------------
    const availabilityZones = this.availabilityZones.slice(0, 2);
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.VPC_ID)),
      availabilityZones,
      publicSubnetIds: [
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PUBLIC_A)),
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PUBLIC_B))
      ],
      privateSubnetIds: [
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PRIVATE_A)),
        Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.SUBNET_PRIVATE_B))
      ],
      vpcCidrBlock: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.VPC_CIDR_IPV4))
    });

    const kmsKey = kms.Key.fromKeyArn(
      this,
      'KmsKey',
      Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.KMS_KEY))
    );

    // The ECS cluster ARN is exported; derive the cluster name by convention
    // (the base stack name), matching CloudTAK.
    const ecsClusterArn = Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.ECS_CLUSTER));
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'EcsCluster', {
      clusterArn: ecsClusterArn,
      clusterName: Fn.select(1, Fn.split('/', ecsClusterArn)),
      vpc,
      securityGroups: []
    });

    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.HOSTED_ZONE_ID)),
      zoneName: Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.HOSTED_ZONE_NAME))
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'Certificate',
      Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.CERTIFICATE_ARN))
    );

    const elbLogsBucket = s3.Bucket.fromBucketName(
      this,
      'ElbLogsBucket',
      Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.S3_ELB_LOGS))
    );

    const envConfigBucket = s3.Bucket.fromBucketName(
      this,
      'EnvConfigBucket',
      Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.S3_ENV_CONFIG))
    );

    const mapDownloadsBucket = envConfig.app.offlineMapsEnabled
      ? s3.Bucket.fromBucketName(
          this,
          'MapDownloadsBucket',
          Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.S3_MAP_DOWNLOADS))
        )
      : undefined;

    // ------------------------------------------------------------------
    // Cross-stack imports (auth-infra)
    // ------------------------------------------------------------------
    const authentikUrl = Fn.importValue(createAuthImportValue(stackNameComponent, AUTH_EXPORT_NAMES.AUTHENTIK_URL));
    const authentikTeamManagerTokenArn = Fn.importValue(
      createAuthImportValue(stackNameComponent, AUTH_EXPORT_NAMES.AUTHENTIK_TEAM_MANAGER_TOKEN_ARN)
    );
    const authentikAdminTokenArn = Fn.importValue(
      createAuthImportValue(stackNameComponent, AUTH_EXPORT_NAMES.AUTHENTIK_ADMIN_TOKEN_ARN)
    );

    const authentikTeamManagerTokenSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'AuthentikTeamManagerToken',
      authentikTeamManagerTokenArn
    );
    const authentikAdminTokenSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'AuthentikAdminToken',
      authentikAdminTokenArn
    );

    // ------------------------------------------------------------------
    // Cross-stack imports (tak-infra) — only when device management is on
    // ------------------------------------------------------------------
    let takServerUrl: string | undefined;
    let takCertEnrollmentUrl: string | undefined;
    let takAdminCertSecret: secretsmanager.ISecret | undefined;
    if (envConfig.app.deviceManagementEnabled) {
      takServerUrl = Fn.importValue(createTakImportValue(stackNameComponent, TAK_EXPORT_NAMES.TAK_SERVER_URL));
      takCertEnrollmentUrl = Fn.importValue(createTakImportValue(stackNameComponent, TAK_EXPORT_NAMES.TAK_CERT_ENROLLMENT));
      takAdminCertSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        'TakAdminCert',
        Fn.importValue(createTakImportValue(stackNameComponent, TAK_EXPORT_NAMES.TAK_ADMIN_CERT_SECRET_ARN))
      );
    }

    // Resolved public URL for this app (one SPA, one origin).
    const appUrl = `https://${envConfig.hostname}.${envConfig.r53ZoneName}`;

    // Whether to attach the Part-2 S3 EnvironmentFile (tak-team-manager-config.env).
    // Mirrors auth-infra's `useS3AuthentikConfigFile` / tak-infra's
    // `useS3TAKServerConfigFile`. Off unless the exact string 'true'.
    const useS3ConfigFile = this.node.tryGetContext('useS3TAKTeamManagerConfigFile') === true
      || this.node.tryGetContext('useS3TAKTeamManagerConfigFile') === 'true';

    // ------------------------------------------------------------------
    // Own resources
    // ------------------------------------------------------------------
    const securityGroups = new SecurityGroups(this, 'SecurityGroups', { vpc, envConfig });

    const appSecrets = new AppSecrets(this, 'AppSecrets', { envConfig, kmsKey, removalPolicy });

    const database = new Database(this, 'Database', {
      envConfig,
      vpc,
      securityGroup: securityGroups.database,
      kmsKey,
      removalPolicy
    });

    const loadBalancer = new LoadBalancer(this, 'LoadBalancer', {
      envConfig,
      vpc,
      albSecurityGroup: securityGroups.alb,
      certificate,
      logsBucket: elbLogsBucket
    });

    new Route53(this, 'Route53', {
      hostedZone,
      hostname: envConfig.hostname,
      loadBalancer: loadBalancer.alb
    });

    // Authentik OIDC provider + "Team Manager" application (custom resource).
    const oidc = new OidcSetup(this, 'OidcSetup', {
      envConfig,
      authentikUrl,
      authentikAdminSecretArn: authentikAdminTokenArn,
      appUrl,
      kmsKey
    });

    // Container image: locally built from the repo-root Dockerfile by default,
    // or pulled from the base-infra artifacts ECR repo in CI (usePreBuiltImages).
    const usePreBuiltImages = this.node.tryGetContext('usePreBuiltImages') === true
      || this.node.tryGetContext('usePreBuiltImages') === 'true';

    let dockerImageAsset: ecrAssets.DockerImageAsset | undefined;
    let ecrRepository: ecr.IRepository | undefined;
    if (usePreBuiltImages) {
      const ecrRepoArn = Fn.importValue(createBaseImportValue(stackNameComponent, BASE_EXPORT_NAMES.ECR_ARTIFACTS_REPO));
      ecrRepository = ecr.Repository.fromRepositoryAttributes(this, 'ArtifactsRepo', {
        repositoryArn: ecrRepoArn,
        repositoryName: Fn.select(1, Fn.split('/', ecrRepoArn))
      });
    } else {
      // Repo root is three levels up from cdk/lib (cdk/lib -> cdk -> repo root).
      dockerImageAsset = new ecrAssets.DockerImageAsset(this, 'AppImage', {
        directory: path.join(__dirname, '../..'),
        file: 'Dockerfile',
        exclude: ['cdk', 'node_modules', 'client/node_modules', '.git', 'cdk.out']
      });
    }

    const appService = new AppService(this, 'AppService', {
      envConfig,
      removalPolicy,
      vpc,
      cluster,
      ecsSecurityGroup: securityGroups.ecs,
      kmsKey,
      targetGroup: loadBalancer.targetGroup,
      appUrl,
      dbHostname: database.hostname,
      dbMasterSecret: database.masterSecret,
      jwtSecret: appSecrets.jwtSecret,
      credentialEncryptionKey: appSecrets.credentialEncryptionKey,
      authentikUrl,
      authentikTeamManagerTokenSecret,
      oidcClientId: oidc.clientId,
      oidcClientSecret: oidc.clientSecret,
      oidcTokenUrl: oidc.tokenUrl,
      oidcUserInfoUrl: oidc.userInfoUrl,
      oidcLogoutUrl: oidc.logoutUrl,
      deviceManagementEnabled: envConfig.app.deviceManagementEnabled,
      authentikAdminTokenSecret: envConfig.app.deviceManagementEnabled ? authentikAdminTokenSecret : undefined,
      takServerUrl,
      takCertEnrollmentUrl,
      takAdminCertSecret,
      offlineMapsEnabled: envConfig.app.offlineMapsEnabled,
      mapDownloadsBucket,
      envConfigBucket,
      useS3ConfigFile,
      dockerImageAsset,
      ecrRepository,
      imageTag: this.node.tryGetContext('imageTag')
    });

    // Container insights on the (imported) cluster is a base-infra concern; we
    // only reference `appService` here to make the dependency explicit.
    void appService;

    registerOutputs({
      stack: this,
      stackName: id,
      serviceUrl: appUrl,
      albDnsName: loadBalancer.alb.loadBalancerDnsName,
      databaseEndpoint: database.hostname,
      oidcClientId: oidc.clientId
    });
  }
}
