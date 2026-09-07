import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ContextEnvironmentConfig } from '../stack-config';
import { createBaseImportValue, BASE_EXPORT_NAMES } from '../cloudformation-imports';
import { APP_CONSTANTS, DATABASE_CONSTANTS } from '../utils/constants';

export interface SecurityGroupsProps {
  vpc: ec2.IVpc;
  envConfig: ContextEnvironmentConfig;
  /** Optional VPC IPv4 CIDR override; imported from BaseInfra when omitted. */
  vpcCidrIpv4?: string;
}

/**
 * Security groups for the single-service TAK Team Manager deployment:
 *   - `alb`      public ALB (80/443 in from anywhere, egress only to ECS)
 *   - `ecs`      Fargate tasks (in from ALB on the container port; egress to
 *                DB, DNS, HTTP(S) for AWS APIs / Authentik / SES / TAK Server)
 *   - `database` Aurora Postgres (in from ECS on 5432)
 *
 * A far simpler shape than CloudTAK's multi-tier (stateless/stateful/hub +
 * media) — this app is one web service plus its database.
 */
export class SecurityGroups extends Construct {
  public readonly alb: ec2.SecurityGroup;
  public readonly ecs: ec2.SecurityGroup;
  public readonly database: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: SecurityGroupsProps) {
    super(scope, id);

    const { vpc, envConfig } = props;
    const port = APP_CONSTANTS.CONTAINER_PORT;

    const vpcCidrIpv4 = props.vpcCidrIpv4
      || cdk.Fn.importValue(createBaseImportValue(envConfig.stackName, BASE_EXPORT_NAMES.VPC_CIDR_IPV4));

    // --- ALB ---
    this.alb = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc,
      description: `TAK-${envConfig.stackName}-TAKTeamManager ALB Security Group`,
      allowAllOutbound: false
    });
    this.alb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP');
    this.alb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    this.alb.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP IPv6');
    this.alb.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS IPv6');

    // --- ECS tasks ---
    this.ecs = new ec2.SecurityGroup(this, 'ECSSecurityGroup', {
      vpc,
      description: `TAK-${envConfig.stackName}-TAKTeamManager ECS Security Group`,
      allowAllOutbound: false
    });
    this.ecs.addIngressRule(this.alb, ec2.Port.tcp(port), 'ALB to ECS');

    // ALB egress: only to the container port (health checks + traffic).
    this.alb.addEgressRule(this.ecs, ec2.Port.tcp(port), 'ALB to ECS tasks');

    // --- Database ---
    this.database = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: `TAK-${envConfig.stackName}-TAKTeamManager Database Security Group`,
      allowAllOutbound: false
    });
    this.database.addIngressRule(this.ecs, ec2.Port.tcp(DATABASE_CONSTANTS.PORT), 'ECS to Database');

    // --- ECS task egress ---
    this.ecs.addEgressRule(this.database, ec2.Port.tcp(DATABASE_CONSTANTS.PORT), 'ECS to Database');
    this.ecs.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS outbound');
    this.ecs.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS outbound IPv6');
    this.ecs.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP outbound');
    this.ecs.addEgressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP outbound IPv6');
    this.ecs.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'DNS');
    this.ecs.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(53), 'DNS TCP');
    // VPC endpoints (Secrets Manager, ECR, S3, CloudWatch Logs) live in-VPC on 443.
    this.ecs.addEgressRule(ec2.Peer.ipv4(vpcCidrIpv4), ec2.Port.tcp(443), 'VPC Endpoints');
    // SMTP (outbound email). 587 STARTTLS + 465 implicit TLS.
    this.ecs.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(587), 'SMTP STARTTLS');
    this.ecs.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(465), 'SMTP implicit TLS');
    // TAK Server integration (Marti certadmin API :8443, enrollment :8446),
    // in-VPC to the tak-infra NLB. Harmless when device management is off.
    this.ecs.addEgressRule(ec2.Peer.ipv4(vpcCidrIpv4), ec2.Port.tcp(8443), 'TAK Server API');
    this.ecs.addEgressRule(ec2.Peer.ipv4(vpcCidrIpv4), ec2.Port.tcp(8446), 'TAK Server enrollment');
  }
}
