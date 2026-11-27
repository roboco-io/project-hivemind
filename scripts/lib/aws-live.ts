import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AwsEcsCredentials } from '../../packages/adapters/src/aws-ecs-driver.js';

/**
 * Shared helpers for the live AWS proof scripts: AWS CLI calls, the Control Plane service lifecycle, the SSM
 * port-forwarding tunnel, operator API calls, and the idle-state check every proof ends with.
 * Nothing here prints the operator token or any other secret.
 */
export const PRIMARY_REGION = 'ap-northeast-2';
export const FIVE_REGIONS = ['ap-northeast-2', 'us-east-2', 'us-east-1', 'us-west-2', 'ap-northeast-1'];
export const profile = process.env.AWS_PROFILE ?? 'roboco';
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function aws(region: string, args: string[]): string {
  return execFileSync('aws', ['--profile', profile, '--region', region, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function awsJson<T>(region: string, args: string[]): T {
  return JSON.parse(aws(region, [...args, '--output', 'json'])) as T;
}

export function loadProfileCredentials(): AwsEcsCredentials {
  const raw = awsJson<{ AccessKeyId: string; SecretAccessKey: string; SessionToken?: string }>(PRIMARY_REGION, [
    'configure', 'export-credentials', '--format', 'process',
  ]);
  return {
    accessKeyId: raw.AccessKeyId,
    secretAccessKey: raw.SecretAccessKey,
    ...(raw.SessionToken ? { sessionToken: raw.SessionToken } : {}),
  };
}

/** Outputs of the deployed Hub stack, read from the file `scripts/aws-deploy-hub.sh deploy` writes. */
export function loadRuntimeOutputs(): Record<string, string> {
  const path = process.env.HIVEMIND_RUNTIME_OUTPUTS ?? process.env.HIVEMIND_CDK_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json';
  const outputs = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>).HivemindAwsRuntimeStack;
  if (!outputs) throw new Error(`Missing HivemindAwsRuntimeStack outputs in ${path}`);
  return outputs;
}

/** Reads the operator token from Secrets Manager. The caller must never print it. */
export function loadOperatorToken(outputs: Record<string, string>): string {
  const token = awsJson<{ SecretString?: string }>(PRIMARY_REGION, [
    'secretsmanager', 'get-secret-value', '--secret-id', outputs.OperatorTokenSecretArn!,
  ]).SecretString?.trim();
  if (!token) throw new Error('Operator token missing');
  return token;
}

export async function apiJson<T>(url: string, token: string, body?: unknown, timeoutMs = 90_000): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${new URL(url).pathname}: ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as T;
}

/**
 * The deployed Control Plane service and one SSM tunnel to it.
 *
 * `start()` sets desiredCount 1, waits until the task accepts ECS Exec, and opens the tunnel.
 * `stop()` closes the tunnel, sets desiredCount 0, and waits until no task runs.
 * `closeTunnel()` / `openTunnel()` let a proof show that work continues without an operator connection.
 *
 * The tunnel runs in its own process group. `aws ssm start-session` starts session-manager-plugin as a
 * child; killing only the `aws` process would leave the plugin and its local port behind.
 */
export class ControlPlane {
  private tunnelPid: number | undefined;

  constructor(
    readonly cluster: string,
    readonly service: string,
    readonly localPort: number,
  ) {}

  static fromOutputs(outputs: Record<string, string>, localPort: number): ControlPlane {
    return new ControlPlane(outputs.ClusterName!, outputs.ControlPlaneServiceName!, localPort);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.localPort}`;
  }

  private setDesired(count: number): void {
    aws(PRIMARY_REGION, ['ecs', 'update-service', '--cluster', this.cluster, '--service', this.service, '--desired-count', String(count), '--query', 'service.desiredCount', '--output', 'text']);
  }

  desiredCount(): number {
    return Number(aws(PRIMARY_REGION, ['ecs', 'describe-services', '--cluster', this.cluster, '--services', this.service, '--query', 'services[0].desiredCount', '--output', 'text']));
  }

  runningTaskCount(): number {
    return Number(aws(PRIMARY_REGION, ['ecs', 'list-tasks', '--cluster', this.cluster, '--service-name', this.service, '--query', 'length(taskArns)', '--output', 'text']));
  }

  private async execTarget(): Promise<string> {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const taskArn = awsJson<{ taskArns?: string[] }>(PRIMARY_REGION, [
        'ecs', 'list-tasks', '--cluster', this.cluster, '--service-name', this.service, '--desired-status', 'RUNNING',
      ]).taskArns?.[0];
      if (taskArn) {
        const task = awsJson<{
          tasks?: { lastStatus?: string; containers?: { name?: string; runtimeId?: string; managedAgents?: { name?: string; lastStatus?: string }[] }[] }[];
        }>(PRIMARY_REGION, ['ecs', 'describe-tasks', '--cluster', this.cluster, '--tasks', taskArn]).tasks?.[0];
        const container = task?.containers?.find((c) => c.name === 'control-plane');
        const execReady = container?.managedAgents?.some((a) => a.name === 'ExecuteCommandAgent' && a.lastStatus === 'RUNNING');
        if (task?.lastStatus === 'RUNNING' && container?.runtimeId && execReady) {
          return `ecs:${this.cluster}_${taskArn.split('/').pop()}_${container.runtimeId}`;
        }
      }
      await sleep(8_000);
    }
    throw new Error('Timed out waiting for a RUNNING ControlPlaneService task');
  }

  async openTunnel(): Promise<void> {
    this.closeTunnel();
    const target = await this.execTarget();
    const child = spawn(
      'aws',
      [
        '--profile', profile, '--region', PRIMARY_REGION, 'ssm', 'start-session', '--target', target,
        '--document-name', 'AWS-StartPortForwardingSession',
        '--parameters', JSON.stringify({ portNumber: ['4310'], localPortNumber: [String(this.localPort)] }),
      ],
      { stdio: 'ignore', detached: true },
    );
    this.tunnelPid = child.pid;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok) return;
      } catch {
        // tunnel or server still starting
      }
      await sleep(1500);
    }
    this.closeTunnel();
    throw new Error('Timed out waiting for SSM tunnel to ControlPlaneService');
  }

  closeTunnel(): void {
    if (this.tunnelPid === undefined) return;
    try {
      process.kill(-this.tunnelPid, 'SIGTERM');
    } catch {
      // process group already gone
    }
    this.tunnelPid = undefined;
  }

  /** Desired count found by `start()`; `stop()` returns the service to it. */
  private initialDesired: number | undefined;

  /** The desired count the service had before `start()`; a proof checks that the service is back to it. */
  get initialDesiredCount(): number | undefined {
    return this.initialDesired;
  }

  async start(): Promise<void> {
    this.initialDesired = this.desiredCount();
    if (this.initialDesired < 1) this.setDesired(1);
    await this.openTunnel();
  }

  /**
   * Closes the tunnel and leaves the service as `start()` found it. The Control Plane normally runs all
   * day, so a proof that found it running does not stop it; one that raised it from 0 lowers it again.
   */
  async stop(): Promise<void> {
    this.closeTunnel();
    if (this.initialDesired === undefined || this.initialDesired >= 1) return;
    this.setDesired(0);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && this.runningTaskCount() > 0) await sleep(8_000);
    if (this.runningTaskCount() > 0) throw new Error('ControlPlaneService tasks did not stop');
  }
}

/** Managed EC2 instances that are not terminated, per region. Every proof must end with all zeros. */
export function countRunningManagedInstances(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const region of FIVE_REGIONS) {
    counts[region] = Number(
      aws(region, [
        'ec2', 'describe-instances',
        '--filters', 'Name=tag:hivemind:managed-by,Values=hivemind-model-factory', 'Name=instance-state-name,Values=pending,running,stopping,stopped',
        '--query', 'length(Reservations[].Instances[])', '--output', 'text',
      ]),
    );
  }
  return counts;
}

/** Polls until every region reports zero managed instances, or the attempts run out. */
export async function waitForNoManagedInstances(attempts = 12, intervalMs = 10_000): Promise<Record<string, number>> {
  let counts = countRunningManagedInstances();
  for (let i = 0; i < attempts && Object.values(counts).some((n) => n > 0); i += 1) {
    await sleep(intervalMs);
    counts = countRunningManagedInstances();
  }
  return counts;
}

/**
 * Opens one tunnel to an already running Control Plane, without changing its desiredCount.
 * Kept for the older proof scripts, which start and stop the service outside the script. The first two
 * parameters are ignored: profile and region come from this module.
 */
export function openSsmTunnel(
  _profile: string,
  _region: string,
  cluster: string,
  service: string,
  localPort: number,
): { ready: Promise<void>; close: () => void } {
  const controlPlane = new ControlPlane(cluster, service, localPort);
  return { ready: controlPlane.openTunnel(), close: () => controlPlane.closeTunnel() };
}
