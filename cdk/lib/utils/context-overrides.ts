import { App } from 'aws-cdk-lib';
import { ContextEnvironmentConfig } from '../stack-config';

/**
 * Reads a boolean CLI/context override, treating ONLY the exact string
 * `'true'` (or a real boolean `true`) as true — matching the strict
 * boolean-env convention used across the TAK-NZ stacks.
 */
function contextBoolean(app: App, key: string, fallback: boolean): boolean {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null) return fallback;
  return raw === true || raw === 'true';
}

function contextNumber(app: App, key: string, fallback: number): number {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}

function contextString(app: App, key: string, fallback: string): string {
  const raw = app.node.tryGetContext(key);
  return raw !== undefined && raw !== null && raw !== '' ? String(raw) : fallback;
}

/**
 * Applies flat `--context key=value` CLI overrides on top of the cdk.json
 * environment block, so any single value can be overridden without editing
 * cdk.json. The flat keys are deliberately distinct from the nested JSON
 * structure (e.g. `--context taskCpu=1024` overrides `ecs.taskCpu`).
 *
 * Mirrors auth-infra / CloudTAK's `applyContextOverrides`.
 */
export function applyContextOverrides(
  app: App,
  baseConfig: ContextEnvironmentConfig
): ContextEnvironmentConfig {
  return {
    ...baseConfig,
    stackName: contextString(app, 'stackName', baseConfig.stackName),
    r53ZoneName: contextString(app, 'r53ZoneName', baseConfig.r53ZoneName),
    hostname: contextString(app, 'hostname', baseConfig.hostname),
    database: {
      ...baseConfig.database,
      instanceClass: contextString(app, 'instanceClass', baseConfig.database.instanceClass),
      instanceCount: contextNumber(app, 'instanceCount', baseConfig.database.instanceCount),
      engineVersion: contextString(app, 'engineVersion', baseConfig.database.engineVersion),
      enablePerformanceInsights: contextBoolean(app, 'enablePerformanceInsights', baseConfig.database.enablePerformanceInsights),
      monitoringInterval: contextNumber(app, 'monitoringInterval', baseConfig.database.monitoringInterval),
      backupRetentionDays: contextNumber(app, 'backupRetentionDays', baseConfig.database.backupRetentionDays),
      deleteProtection: contextBoolean(app, 'deleteProtection', baseConfig.database.deleteProtection)
    },
    ecs: {
      ...baseConfig.ecs,
      taskCpu: contextNumber(app, 'taskCpu', baseConfig.ecs.taskCpu),
      taskMemory: contextNumber(app, 'taskMemory', baseConfig.ecs.taskMemory),
      desiredCount: contextNumber(app, 'desiredCount', baseConfig.ecs.desiredCount),
      enableEcsExec: contextBoolean(app, 'enableEcsExec', baseConfig.ecs.enableEcsExec)
    },
    app: {
      ...baseConfig.app,
      deviceManagementEnabled: contextBoolean(app, 'deviceManagementEnabled', baseConfig.app.deviceManagementEnabled),
      offlineMapsEnabled: contextBoolean(app, 'offlineMapsEnabled', baseConfig.app.offlineMapsEnabled)
    },
    general: {
      ...baseConfig.general,
      removalPolicy: contextString(app, 'removalPolicy', baseConfig.general.removalPolicy),
      enableDetailedLogging: contextBoolean(app, 'enableDetailedLogging', baseConfig.general.enableDetailedLogging),
      enableContainerInsights: contextBoolean(app, 'enableContainerInsights', baseConfig.general.enableContainerInsights)
    }
  };
}
