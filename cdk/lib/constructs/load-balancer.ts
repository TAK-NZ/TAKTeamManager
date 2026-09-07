import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ContextEnvironmentConfig } from '../stack-config';
import { APP_CONSTANTS } from '../utils/constants';

export interface LoadBalancerProps {
  envConfig: ContextEnvironmentConfig;
  vpc: ec2.IVpc;
  albSecurityGroup: ec2.SecurityGroup;
  certificate: acm.ICertificate;
  logsBucket: s3.IBucket;
}

/**
 * Public dual-stack Application Load Balancer for TAK Team Manager: an HTTPS
 * listener (imported ACM cert) whose default action forwards to the ECS target
 * group, plus an HTTP listener that permanently redirects to HTTPS. Access and
 * connection logs go to the imported BaseInfra ELB-logs bucket. Mirrors
 * CloudTAK's load-balancer construct, targeting this app's container port with
 * a `/health` (DB-connectivity) health check.
 */
export class LoadBalancer extends Construct {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpsListener: elbv2.ApplicationListener;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(scope: Construct, id: string, props: LoadBalancerProps) {
    super(scope, id);

    const { envConfig, vpc, albSecurityGroup, certificate, logsBucket } = props;

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      loadBalancerName: `tak-${envConfig.stackName.toLowerCase()}-teammgr`,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      ipAddressType: elbv2.IpAddressType.DUAL_STACK
    });

    this.alb.setAttribute('access_logs.s3.enabled', 'true');
    this.alb.setAttribute('access_logs.s3.bucket', logsBucket.bucketName);
    this.alb.setAttribute('access_logs.s3.prefix', `TAK-${envConfig.stackName}-TAKTeamManager`);
    this.alb.setAttribute('connection_logs.s3.enabled', 'true');
    this.alb.setAttribute('connection_logs.s3.bucket', logsBucket.bucketName);
    this.alb.setAttribute('connection_logs.s3.prefix', `TAK-${envConfig.stackName}-TAKTeamManager`);

    this.httpsListener = this.alb.addListener('HTTPSListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate]
    });

    this.alb.addListener('HTTPListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true
      })
    });

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc,
      port: APP_CONSTANTS.CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: APP_CONSTANTS.HEALTH_CHECK_PATH,
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5
      }
    });

    this.httpsListener.addTargetGroups('DefaultAction', {
      targetGroups: [this.targetGroup]
    });
  }
}
