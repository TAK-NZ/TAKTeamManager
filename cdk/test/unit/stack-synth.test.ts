import { Match } from 'aws-cdk-lib/assertions';
import { synthTemplate } from '../__helpers__/synth';

/**
 * Synth-smoke + behavioral template assertions for TakTeamManagerStack.
 *
 * These are deliberately NOT a full-template snapshot and NOT one assertion
 * per resource. They cover (a) the thing that actually breaks in practice — a
 * stack that no longer synthesizes — for every env/image combination, and (b)
 * a handful of BEHAVIORAL properties where an assertion is meaningful rather
 * than a restatement of the construct code: the prod database's safety shape,
 * the two feature-flag-gated wiring decisions, and the stack's exported output
 * names (a cross-stack contract other stacks import by name).
 */

describe('TakTeamManagerStack synth smoke', () => {
  it('synthesizes for dev-test (local Docker image path)', () => {
    expect(() => synthTemplate('dev-test')).not.toThrow();
  });

  it('synthesizes for dev-test with prebuilt ECR images', () => {
    expect(() => synthTemplate('dev-test', { usePreBuiltImages: 'true', imageTag: 'v1.2.3' })).not.toThrow();
  });

  it('synthesizes for prod (local Docker image path)', () => {
    expect(() => synthTemplate('prod')).not.toThrow();
  });

  it('synthesizes for prod with prebuilt ECR images', () => {
    expect(() => synthTemplate('prod', { usePreBuiltImages: 'true', imageTag: 'v1.2.3' })).not.toThrow();
  });

  it('always synthesizes one Aurora cluster, TWO ECS services (app + sync worker), and one ALB', () => {
    const { template } = synthTemplate('dev-test');
    template.resourceCountIs('AWS::RDS::DBCluster', 1);
    // Two services now: the web app AND the separate sync-worker service.
    template.resourceCountIs('AWS::ECS::Service', 2);
    // ...but still exactly ONE ALB — the worker serves no user traffic.
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  });
});

describe('database safety shape (prod vs dev-test)', () => {
  it('prod runs 2 provisioned instances with deletion protection on', () => {
    const { template } = synthTemplate('prod');
    // instanceCount 2 -> writer + one reader.
    template.resourceCountIs('AWS::RDS::DBInstance', 2);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      DeletionProtection: true
    });
  });

  it('dev-test runs a single serverless instance with deletion protection off', () => {
    const { template } = synthTemplate('dev-test');
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      DeletionProtection: false,
      // Serverless v2 capacity is only set on the serverless path.
      ServerlessV2ScalingConfiguration: Match.objectLike({
        MinCapacity: 0.5,
        MaxCapacity: 4
      })
    });
  });
});

describe('feature-flag-gated wiring', () => {
  // Helper: read the APP container's ContainerDefinitions. There are now TWO
  // task definitions (the web app and the sync worker), so pick the app one by
  // its distinguishing trait — the container that publishes the app port 3000.
  // (The worker task def has no port mappings.)
  function appContainer(envType: 'dev-test' | 'prod', extraContext = {}) {
    const { template } = synthTemplate(envType, extraContext);
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const defs = Object.values(taskDefs);
    // App + sync worker.
    expect(defs.length).toBe(2);
    const allContainers = defs.flatMap(
      (d) => (d as { Properties: { ContainerDefinitions: Array<Record<string, unknown>> } }).Properties.ContainerDefinitions
    );
    // The app container is the one listening on the app port.
    return allContainers.find((c) =>
      Array.isArray((c as { PortMappings?: Array<{ ContainerPort?: number }> }).PortMappings) &&
      (c as { PortMappings: Array<{ ContainerPort?: number }> }).PortMappings.some((p) => p.ContainerPort === 3000)
    ) as { EnvironmentFiles?: unknown[]; Image?: unknown };
  }

  it('attaches the S3 EnvironmentFile only when useS3TAKTeamManagerConfigFile is true', () => {
    const withFlag = appContainer('dev-test', { useS3TAKTeamManagerConfigFile: 'true' });
    expect(Array.isArray(withFlag.EnvironmentFiles)).toBe(true);
    expect((withFlag.EnvironmentFiles as unknown[]).length).toBeGreaterThan(0);

    const withoutFlag = appContainer('dev-test');
    // Off by default -> no EnvironmentFiles key (or an empty one).
    expect(withoutFlag.EnvironmentFiles === undefined || (withoutFlag.EnvironmentFiles as unknown[]).length === 0).toBe(true);
  });

  it('the strict boolean holds: "TRUE" does NOT arm the S3 EnvironmentFile', () => {
    const container = appContainer('dev-test', { useS3TAKTeamManagerConfigFile: 'TRUE' });
    expect(container.EnvironmentFiles === undefined || (container.EnvironmentFiles as unknown[]).length === 0).toBe(true);
  });
});

describe('stack outputs (cross-stack contract)', () => {
  it('exports the TAK-<Env>-TAKTeamManager-* names other stacks import by name', () => {
    const { template } = synthTemplate('prod');
    const outputs = template.findOutputs('*');
    const exportNames = Object.values(outputs)
      .map((o) => (o as { Export?: { Name?: string } }).Export?.Name)
      .filter(Boolean);

    for (const suffix of ['ServiceUrl', 'AlbDnsName', 'DatabaseEndpoint', 'OidcClientId', 'SyncWorkerServiceName']) {
      expect(exportNames).toContain(`TAK-Prod-TAKTeamManager-${suffix}`);
    }
  });
});

describe('sync worker service (separate ECS service, no ALB)', () => {
  // Find the sync-worker task def: the container whose command runs the worker.
  function workerContainer(envType: 'dev-test' | 'prod', extraContext = {}) {
    const { template } = synthTemplate(envType, extraContext);
    const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
    const withContainers = Object.values(taskDefs).map(
      (d) => (d as { Properties: { Cpu?: string; Memory?: string; ContainerDefinitions: Array<Record<string, unknown>> } }).Properties
    );
    const workerDef = withContainers.find((p) =>
      p.ContainerDefinitions.some((c) => {
        const cmd = (c as { Command?: string[] }).Command;
        return Array.isArray(cmd) && cmd.join(' ').includes('server/workers/syncWorker.js');
      })
    );
    return workerDef;
  }

  it('runs node server/workers/syncWorker.js as its command', () => {
    const def = workerContainer('dev-test');
    expect(def).toBeDefined();
    const container = def!.ContainerDefinitions.find((c) =>
      Array.isArray((c as { Command?: string[] }).Command)
    ) as { Command: string[] };
    expect(container.Command).toEqual(['node', 'server/workers/syncWorker.js']);
  });

  it('is sized at HALF the app task cpu/memory (dev-test 512/1024 -> 256/512)', () => {
    const def = workerContainer('dev-test');
    // Fargate task-level Cpu/Memory are strings in the template.
    expect(def!.Cpu).toBe('256');
    expect(def!.Memory).toBe('512');
  });

  it('is sized at HALF the app task cpu/memory (prod 1024/2048 -> 512/1024)', () => {
    const def = workerContainer('prod');
    expect(def!.Cpu).toBe('512');
    expect(def!.Memory).toBe('1024');
  });

  it('has NO port mappings and a health check on the worker health port (not the ALB)', () => {
    const def = workerContainer('dev-test');
    const container = def!.ContainerDefinitions.find((c) =>
      Array.isArray((c as { Command?: string[] }).Command)
    ) as { PortMappings?: unknown[]; HealthCheck?: { Command?: string[] } };
    // No published ports — the worker serves no ALB/task traffic.
    expect(container.PortMappings === undefined || container.PortMappings.length === 0).toBe(true);
    // Container health check probes the worker's own heartbeat health server.
    expect(container.HealthCheck).toBeDefined();
    expect(container.HealthCheck!.Command!.join(' ')).toContain('localhost:3001');
  });

  it('the worker service is NOT attached to any target group (only the app service is)', () => {
    const { template } = synthTemplate('dev-test');
    const services = template.findResources('AWS::ECS::Service');
    const withTargetGroup = Object.values(services).filter(
      (s) => Array.isArray((s as { Properties: { LoadBalancers?: unknown[] } }).Properties.LoadBalancers) &&
        (s as { Properties: { LoadBalancers: unknown[] } }).Properties.LoadBalancers.length > 0
    );
    // Exactly one service (the app) attaches to a target group; the worker does not.
    expect(withTargetGroup.length).toBe(1);
  });

  it('worker desiredCount mirrors the app: 1 in dev-test, 2 in prod', () => {
    const devServices = Object.values(synthTemplate('dev-test').template.findResources('AWS::ECS::Service'))
      .map((s) => (s as { Properties: { DesiredCount?: number } }).Properties.DesiredCount);
    // Both services at 1 in dev-test.
    expect(devServices.every((c) => c === 1)).toBe(true);

    const prodServices = Object.values(synthTemplate('prod').template.findResources('AWS::ECS::Service'))
      .map((s) => (s as { Properties: { DesiredCount?: number } }).Properties.DesiredCount);
    // Both services at 2 in prod.
    expect(prodServices.every((c) => c === 2)).toBe(true);
  });
});
