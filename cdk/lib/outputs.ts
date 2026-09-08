import * as cdk from 'aws-cdk-lib';

export interface OutputParams {
  stack: cdk.Stack;
  stackName: string;
  serviceUrl: string;
  albDnsName: string;
  databaseEndpoint: string;
  oidcClientId: string;
  syncWorkerServiceName: string;
}

/**
 * Registers the TAK Team Manager stack's CloudFormation outputs, exported as
 * `TAK-${stackName}-TAKTeamManager-<Key>` to match the ecosystem convention.
 */
export function registerOutputs(params: OutputParams): void {
  const { stack, stackName } = params;

  new cdk.CfnOutput(stack, 'ServiceUrlOutput', {
    value: params.serviceUrl,
    description: 'TAK Team Manager public URL',
    exportName: `${stackName}-ServiceUrl`
  });

  new cdk.CfnOutput(stack, 'AlbDnsNameOutput', {
    value: params.albDnsName,
    description: 'Application Load Balancer DNS name',
    exportName: `${stackName}-AlbDnsName`
  });

  new cdk.CfnOutput(stack, 'DatabaseEndpointOutput', {
    value: params.databaseEndpoint,
    description: 'Aurora PostgreSQL cluster endpoint',
    exportName: `${stackName}-DatabaseEndpoint`
  });

  new cdk.CfnOutput(stack, 'OidcClientIdOutput', {
    value: params.oidcClientId,
    description: 'Authentik OIDC client ID for TAK Team Manager',
    exportName: `${stackName}-OidcClientId`
  });

  new cdk.CfnOutput(stack, 'SyncWorkerServiceNameOutput', {
    value: params.syncWorkerServiceName,
    description: 'ECS service name of the TAK Team Manager sync worker',
    exportName: `${stackName}-SyncWorkerServiceName`
  });
}
