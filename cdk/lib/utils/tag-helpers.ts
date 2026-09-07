import { ContextEnvironmentConfig } from '../stack-config';

export interface TagDefaults {
  project?: string;
  component?: string;
  region?: string;
}

/**
 * Standard resource tags applied at the stack level, matching the convention
 * used by base-infra / auth-infra / tak-infra / CloudTAK.
 *
 * @param envConfig  the resolved environment config (its `stackName` — e.g.
 *   "Dev"/"Prod" — is used as the Environment tag)
 * @param environment the envType selector ('prod' | 'dev-test')
 * @param defaults    project/component/region from the tak-defaults context
 */
export function generateStandardTags(
  envConfig: ContextEnvironmentConfig,
  environment: 'prod' | 'dev-test',
  defaults?: TagDefaults
): Record<string, string> {
  return {
    Project: defaults?.project || 'TAK.NZ',
    Environment: envConfig.stackName,
    Component: defaults?.component || 'TAKTeamManager',
    ManagedBy: 'CDK',
    'Environment Type': environment === 'prod' ? 'Prod' : 'Dev-Test'
  };
}
