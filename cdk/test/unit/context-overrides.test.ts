import * as cdk from 'aws-cdk-lib';
import { applyContextOverrides } from '../../lib/utils/context-overrides';
import { ContextEnvironmentConfig } from '../../lib/stack-config';

/**
 * Unit tests for `applyContextOverrides` — the one piece of real decision
 * logic in the CDK layer, and the one worth guarding: the strict-boolean rule
 * that a flag is true ONLY for the exact string `'true'` (or a real boolean
 * `true`). A careless refactor to `Boolean(raw)` or `raw !== 'false'` would
 * silently widen a feature flag — exactly the failure the app-wide
 * strict-boolean convention exists to prevent — so these pin the boundary.
 *
 * `applyContextOverrides` reads flat `--context key=value` overrides off the
 * App's context, so each case builds a real `cdk.App({ context })` and a base
 * config, then asserts the merged result.
 */

/** A minimal but complete base config to override against. */
function baseConfig(): ContextEnvironmentConfig {
  return {
    stackName: 'Dev',
    r53ZoneName: 'dev.tak.nz',
    hostname: 'team',
    database: {
      instanceClass: 'db.serverless',
      instanceCount: 1,
      engineVersion: '17.4',
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      enablePerformanceInsights: false,
      monitoringInterval: 0,
      backupRetentionDays: 7,
      deleteProtection: false
    },
    ecs: {
      taskCpu: 512,
      taskMemory: 1024,
      desiredCount: 1,
      enableEcsExec: true
    },
    app: {
      deviceManagementEnabled: false,
      offlineMapsEnabled: false
    },
    general: {
      removalPolicy: 'DESTROY',
      enableDetailedLogging: true,
      enableContainerInsights: false
    }
  } as ContextEnvironmentConfig;
}

function withContext(context: Record<string, unknown>): cdk.App {
  return new cdk.App({ context });
}

describe('applyContextOverrides', () => {
  describe('strict boolean semantics (feature-flag convention)', () => {
    it('treats the exact string "true" as true', () => {
      const result = applyContextOverrides(withContext({ deviceManagementEnabled: 'true' }), baseConfig());
      expect(result.app.deviceManagementEnabled).toBe(true);
    });

    it('treats a real boolean true as true', () => {
      const result = applyContextOverrides(withContext({ deviceManagementEnabled: true }), baseConfig());
      expect(result.app.deviceManagementEnabled).toBe(true);
    });

    // The whole point: none of these near-misses may read as true.
    it.each([
      ['TRUE'],
      ['True'],
      ['1'],
      [' true '],
      ['yes'],
      ['false']
    ])('does NOT treat %p as true', (raw) => {
      const result = applyContextOverrides(withContext({ deviceManagementEnabled: raw }), baseConfig());
      expect(result.app.deviceManagementEnabled).toBe(false);
    });

    it('falls back to the base value when the key is absent', () => {
      const on = baseConfig();
      on.app.offlineMapsEnabled = true;
      const result = applyContextOverrides(withContext({}), on);
      expect(result.app.offlineMapsEnabled).toBe(true);
    });

    it('can override a base true DOWN to false only with the exact string "false" semantics (any non-"true" value)', () => {
      const on = baseConfig();
      on.app.deviceManagementEnabled = true;
      // Absent -> keeps base true.
      expect(applyContextOverrides(withContext({}), on).app.deviceManagementEnabled).toBe(true);
      // Present but not exactly 'true'/true -> false.
      expect(applyContextOverrides(withContext({ deviceManagementEnabled: 'false' }), on).app.deviceManagementEnabled).toBe(false);
    });
  });

  describe('string overrides', () => {
    it('overrides stackName / r53ZoneName / hostname when provided', () => {
      const result = applyContextOverrides(
        withContext({ stackName: 'Demo', r53ZoneName: 'test.tak.nz', hostname: 'team' }),
        baseConfig()
      );
      expect(result.stackName).toBe('Demo');
      expect(result.r53ZoneName).toBe('test.tak.nz');
      expect(result.hostname).toBe('team');
    });

    it('keeps the base string when the override is an empty string', () => {
      const result = applyContextOverrides(withContext({ stackName: '' }), baseConfig());
      expect(result.stackName).toBe('Dev');
    });
  });

  describe('number overrides', () => {
    it('coerces a numeric-string override to a number', () => {
      const result = applyContextOverrides(withContext({ taskCpu: '1024' }), baseConfig());
      expect(result.ecs.taskCpu).toBe(1024);
    });

    it('keeps the base number when the override is not a usable number', () => {
      const result = applyContextOverrides(withContext({ taskCpu: 'not-a-number' }), baseConfig());
      expect(result.ecs.taskCpu).toBe(512);
    });
  });

  it('returns a config that still carries every base field the overrides did not touch', () => {
    const result = applyContextOverrides(withContext({ stackName: 'Demo' }), baseConfig());
    // Untouched nested values survive the merge.
    expect(result.database.engineVersion).toBe('17.4');
    expect(result.ecs.taskMemory).toBe(1024);
    expect(result.general.removalPolicy).toBe('DESTROY');
  });
});
