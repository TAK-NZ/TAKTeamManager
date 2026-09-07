#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TakTeamManagerStack } from '../lib/tak-team-manager-stack';
import { applyContextOverrides } from '../lib/utils/context-overrides';
import { DEFAULT_AWS_REGION } from '../lib/utils/constants';
import { generateStandardTags } from '../lib/utils/tag-helpers';

const app = new cdk.App();

// Environment selector (defaults to dev-test), matching the other TAK-NZ stacks.
const envName = app.node.tryGetContext('envType') || 'dev-test';

const envConfig = app.node.tryGetContext(envName);
const defaults = {
  project: app.node.tryGetContext('tak-project') || app.node.tryGetContext('tak-defaults')?.project,
  component: app.node.tryGetContext('tak-component') || app.node.tryGetContext('tak-defaults')?.component,
  region: app.node.tryGetContext('tak-region') || app.node.tryGetContext('tak-defaults')?.region
};

if (!envConfig) {
  throw new Error(`
❌ Environment configuration for '${envName}' not found in cdk.json

Usage:
  npx cdk deploy --context envType=dev-test
  npx cdk deploy --context envType=prod
`);
}

// Apply flat --context overrides on top of the cdk.json block.
const finalEnvConfig = applyContextOverrides(app, envConfig);

// Stack name follows the TAK-NZ convention: TAK-<Env>-<Component>.
const stackName = `TAK-${finalEnvConfig.stackName}-TAKTeamManager`;

new TakTeamManagerStack(app, stackName, {
  environment: envName as 'prod' | 'dev-test',
  envConfig: finalEnvConfig,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || defaults?.region || DEFAULT_AWS_REGION
  },
  tags: generateStandardTags(finalEnvConfig, envName as 'prod' | 'dev-test', defaults)
});
