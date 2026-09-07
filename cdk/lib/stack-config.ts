/**
 * Configuration interface for the TAK Team Manager stack.
 *
 * Mirrors the per-environment block in `cdk.json`'s `context` (the `dev-test`
 * and `prod` objects) one-to-one, so the stack consumes it directly with no
 * transformation — the same pattern base-infra / auth-infra / CloudTAK use.
 */
export interface ContextEnvironmentConfig {
  /** Env label used in stack/export names, e.g. "Dev" / "Prod". */
  stackName: string;
  /** Route53 hosted-zone name imported from base-infra, e.g. "dev.tak.nz". */
  r53ZoneName: string;
  /** Sub-domain label for this app's ALB record, e.g. "team" -> team.<zone>. */
  hostname: string;

  database: {
    /** "db.serverless" for Aurora Serverless v2, else a provisioned class. */
    instanceClass: string;
    /** Total cluster instances (1 writer + N-1 readers). */
    instanceCount: number;
    /** Aurora Postgres engine version, e.g. "17.4". */
    engineVersion: string;
    /** Reserved for future storage tuning (Aurora ignores these). */
    allocatedStorage?: number;
    maxAllocatedStorage?: number;
    enablePerformanceInsights: boolean;
    /** Enhanced-monitoring interval in seconds (0 disables). */
    monitoringInterval: number;
    backupRetentionDays: number;
    deleteProtection: boolean;
  };

  ecs: {
    taskCpu: number;
    taskMemory: number;
    desiredCount: number;
    enableEcsExec: boolean;
  };

  app: {
    /**
     * When true, the stack imports the TAK Server integration exports from
     * tak-infra and wires TAK_SERVER_URL / TAK_SERVER_ENROLLMENT_URL / the
     * admin cert. When false, none of those are imported and device
     * management stays off.
     */
    deviceManagementEnabled: boolean;
    /**
     * When true, the task role is granted read on the base-infra map-downloads
     * bucket and OFFLINE_MAPS_S3_BUCKET is injected. (The app's own
     * OFFLINE_MAPS_ENABLED flag still lives in the Part-2 S3 config file.)
     */
    offlineMapsEnabled: boolean;
  };

  general: {
    /** "DESTROY" or "RETAIN". */
    removalPolicy: string;
    enableDetailedLogging: boolean;
    enableContainerInsights: boolean;
  };
}
