/**
 * Cross-stack CloudFormation import helpers.
 *
 * Every dependency is consumed via `Fn.importValue` against a deterministic
 * export name `TAK-${stackName}-<Layer>-<Key>`, exactly matching the
 * convention base-infra / auth-infra / tak-infra / CloudTAK use. Dependency
 * stack names are DERIVED from the one shared `stackName` component (e.g.
 * "Dev"/"Prod") — there is no separate per-dependency stack-name context key.
 */

/** BaseInfra export suffixes (see base-infra/lib/outputs.ts). */
export const BASE_EXPORT_NAMES = {
  VPC_ID: 'VpcId',
  VPC_CIDR_IPV4: 'VpcCidrIpv4',
  VPC_CIDR_IPV6: 'VpcCidrIpv6',
  SUBNET_PUBLIC_A: 'SubnetPublicA',
  SUBNET_PUBLIC_B: 'SubnetPublicB',
  SUBNET_PRIVATE_A: 'SubnetPrivateA',
  SUBNET_PRIVATE_B: 'SubnetPrivateB',
  ECS_CLUSTER: 'EcsClusterArn',
  ECR_ARTIFACTS_REPO: 'EcrArtifactsRepoArn',
  KMS_KEY: 'KmsKeyArn',
  S3_ENV_CONFIG: 'EnvConfigBucket',
  S3_ELB_LOGS: 'ElbLogsBucket',
  S3_MAP_DOWNLOADS: 'MapDownloadsBucket',
  HOSTED_ZONE_ID: 'HostedZoneId',
  HOSTED_ZONE_NAME: 'HostedZoneName',
  CERTIFICATE_ARN: 'CertificateArn'
} as const;

/** AuthInfra export suffixes (see auth-infra/lib/outputs.ts). */
export const AUTH_EXPORT_NAMES = {
  AUTHENTIK_URL: 'AuthentikUrl',
  /** Least-privilege Authentik service-account token minted for this app. */
  AUTHENTIK_TEAM_MANAGER_TOKEN_ARN: 'AuthentikTeamManagerTokenArn',
  /** Authentik superuser/admin token — used by the OIDC-setup Lambda to
   *  create the provider/application, and by device enrollment at runtime. */
  AUTHENTIK_ADMIN_TOKEN_ARN: 'AuthentikAdminTokenArn'
} as const;

/** TakInfra export suffixes (see tak-infra/lib/tak-infra-stack.ts). */
export const TAK_EXPORT_NAMES = {
  /** Marti/certadmin mTLS API host on :8443 -> TAK_SERVER_URL. */
  TAK_SERVER_URL: 'TakServerUrl',
  /** Public client-dialable enrollment host on :8446 -> TAK_SERVER_ENROLLMENT_URL. */
  TAK_CERT_ENROLLMENT: 'TakCertEnrollment',
  /** Admin P12 credential secret ARN -> TAK_ADMIN_CERT_SECRET_ARN. */
  TAK_ADMIN_CERT_SECRET_ARN: 'TakAdminCertSecretArn'
} as const;

export function createBaseImportValue(stackNameComponent: string, exportName: string): string {
  return `TAK-${stackNameComponent}-BaseInfra-${exportName}`;
}

export function createAuthImportValue(stackNameComponent: string, exportName: string): string {
  return `TAK-${stackNameComponent}-AuthInfra-${exportName}`;
}

export function createTakImportValue(stackNameComponent: string, exportName: string): string {
  return `TAK-${stackNameComponent}-TakInfra-${exportName}`;
}
