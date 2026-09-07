import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { ContextEnvironmentConfig } from '../stack-config';
import { DATABASE_CONSTANTS } from '../utils/constants';

export interface DatabaseProps {
  envConfig: ContextEnvironmentConfig;
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
  kmsKey: kms.IKey;
  removalPolicy: cdk.RemovalPolicy;
}

/**
 * Aurora PostgreSQL cluster for TAK Team Manager, matching the pattern used by
 * auth-infra / tak-infra / CloudTAK: Serverless v2 in dev-test, provisioned
 * instances in prod, storage encrypted with the imported BaseInfra KMS key,
 * a generated master credential in Secrets Manager, and a derived
 * connection-string secret.
 */
export class Database extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  /** Generated master credential ({ username, password, host, port, dbname }). */
  public readonly masterSecret: secretsmanager.ISecret;
  /** `postgresql://user:pass@host:5432/db?sslmode=require` secret. */
  public readonly connectionStringSecret: secretsmanager.Secret;
  public readonly hostname: string;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    const { envConfig, vpc, securityGroup, kmsKey, removalPolicy } = props;
    const dbConfig = envConfig.database;
    const prefix = `TAK-${envConfig.stackName}-TAKTeamManager`;

    // Aurora Postgres engine version (defaults to 17.4, else 16.6).
    const engineVersion = dbConfig.engineVersion === '16.6'
      ? rds.AuroraPostgresEngineVersion.VER_16_6
      : rds.AuroraPostgresEngineVersion.VER_17_4;
    const engine = rds.DatabaseClusterEngine.auroraPostgres({ version: engineVersion });

    // Master credential — generated, stored in Secrets Manager (KMS-encrypted).
    const masterSecret = new secretsmanager.Secret(this, 'MasterSecret', {
      secretName: `${prefix}/Database/Master-Credentials`,
      description: 'TAK Team Manager Aurora master credentials',
      encryptionKey: kmsKey,
      removalPolicy,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: DATABASE_CONSTANTS.USERNAME }),
        generateStringKey: 'password',
        passwordLength: DATABASE_CONSTANTS.PASSWORD_LENGTH,
        excludePunctuation: true,
        includeSpace: false
      }
    });
    this.masterSecret = masterSecret;

    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      vpc,
      description: `${prefix} DB subnet group`,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      removalPolicy
    });

    const parameterGroup = new rds.ParameterGroup(this, 'ParameterGroup', {
      engine,
      description: `${prefix} Aurora Postgres parameters`,
      parameters: {
        // Query telemetry, matching the other stacks' clusters.
        shared_preload_libraries: 'pg_stat_statements'
      }
    });

    const isServerless = dbConfig.instanceClass === 'db.serverless';
    const instanceCount = Math.max(1, dbConfig.instanceCount);

    let writer: rds.IClusterInstance;
    const readers: rds.IClusterInstance[] = [];

    if (isServerless) {
      writer = rds.ClusterInstance.serverlessV2('writer', {
        enablePerformanceInsights: dbConfig.enablePerformanceInsights
      });
      for (let i = 1; i < instanceCount; i++) {
        readers.push(rds.ClusterInstance.serverlessV2(`reader${i}`, {
          scaleWithWriter: true,
          enablePerformanceInsights: dbConfig.enablePerformanceInsights
        }));
      }
    } else {
      const instanceType = new ec2.InstanceType(dbConfig.instanceClass.replace(/^db\./, ''));
      writer = rds.ClusterInstance.provisioned('writer', {
        instanceType,
        enablePerformanceInsights: dbConfig.enablePerformanceInsights
      });
      for (let i = 1; i < instanceCount; i++) {
        readers.push(rds.ClusterInstance.provisioned(`reader${i}`, {
          instanceType,
          enablePerformanceInsights: dbConfig.enablePerformanceInsights
        }));
      }
    }

    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine,
      credentials: rds.Credentials.fromSecret(masterSecret),
      defaultDatabaseName: DATABASE_CONSTANTS.DEFAULT_DATABASE_NAME,
      writer,
      readers,
      serverlessV2MinCapacity: isServerless ? 0.5 : undefined,
      serverlessV2MaxCapacity: isServerless ? 4 : undefined,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      subnetGroup,
      securityGroups: [securityGroup],
      parameterGroup,
      port: DATABASE_CONSTANTS.PORT,
      storageEncrypted: true,
      storageEncryptionKey: kmsKey,
      networkType: rds.NetworkType.DUAL,
      backup: { retention: cdk.Duration.days(dbConfig.backupRetentionDays) },
      deletionProtection: dbConfig.deleteProtection,
      monitoringInterval: dbConfig.monitoringInterval > 0
        ? cdk.Duration.seconds(dbConfig.monitoringInterval)
        : undefined,
      removalPolicy
    });

    this.hostname = this.cluster.clusterEndpoint.hostname;

    // Derived connection-string secret (some tooling prefers a single URL).
    // Built from dynamic references to the master secret so the plaintext
    // password never appears in the template.
    this.connectionStringSecret = new secretsmanager.Secret(this, 'ConnectionStringSecret', {
      secretName: `${prefix}/Database/Connection-String`,
      description: 'TAK Team Manager Postgres connection string',
      encryptionKey: kmsKey,
      removalPolicy,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        cdk.Fn.sub(
          'postgresql://${username}:${password}@${host}:${port}/${dbname}?sslmode=require',
          {
            username: DATABASE_CONSTANTS.USERNAME,
            password: masterSecret.secretValueFromJson('password').unsafeUnwrap(),
            host: this.cluster.clusterEndpoint.hostname,
            port: String(DATABASE_CONSTANTS.PORT),
            dbname: DATABASE_CONSTANTS.DEFAULT_DATABASE_NAME
          }
        )
      )
    });
  }
}
