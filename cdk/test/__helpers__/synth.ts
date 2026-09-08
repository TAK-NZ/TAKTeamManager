import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { TakTeamManagerStack } from '../../lib/tak-team-manager-stack';
import { applyContextOverrides } from '../../lib/utils/context-overrides';
import { ContextEnvironmentConfig } from '../../lib/stack-config';

/**
 * Test helper: synthesize `TakTeamManagerStack` for a given environment, the
 * same way `bin/cdk.ts` does — read the env's config block from `cdk.json`'s
 * context, apply any flat `--context` overrides, and instantiate the stack
 * with an EXPLICIT `env` (account+region). The explicit env matters: the stack
 * slices `this.availabilityZones`, which yields CDK's dummy AZs only for an
 * environment-agnostic stack, so a real account/region is required for a clean
 * synth (mirroring how the stack is actually deployed).
 *
 * Returns the CloudFormation `Template` for assertions. Building the Template
 * IS the synth, so a stack that fails to synthesize throws here — which is the
 * synth-smoke guarantee the behavioral tests get for free.
 */
const CDK_JSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../cdk.json'), 'utf8')
);

export function synthTemplate(
  envType: 'dev-test' | 'prod',
  extraContext: Record<string, unknown> = {}
): { template: Template; stack: TakTeamManagerStack; envConfig: ContextEnvironmentConfig } {
  const baseConfig = CDK_JSON.context[envType] as ContextEnvironmentConfig;

  const app = new cdk.App({ context: { ...extraContext } });
  const envConfig = applyContextOverrides(app, baseConfig);

  const stack = new TakTeamManagerStack(app, `TAK-${envConfig.stackName}-TAKTeamManager`, {
    environment: envType,
    envConfig,
    env: { account: '123456789012', region: 'ap-southeast-2' }
  });

  return { template: Template.fromStack(stack), stack, envConfig };
}
