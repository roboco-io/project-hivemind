import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Starts the deployed Seoul Control Plane, reads which storage backend each store reports over the operator
 * API, reads the one-time SQLite import log events, and stops the Control Plane again (desiredCount 0).
 * It registers nothing and never prints the operator token.
 */
const REGION = 'ap-northeast-2';
const profile = process.env.AWS_PROFILE ?? 'roboco';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const aws = (args: string[]): string =>
  execFileSync('aws', ['--profile', profile, '--region', REGION, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const awsJson = <T>(args: string[]): T => JSON.parse(aws([...args, '--output', 'json'])) as T;

async function main(): Promise<void> {
  const out = (JSON.parse(readFileSync(process.env.HIVEMIND_RUNTIME_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<string, Record<string, string>>)
    .HivemindAwsRuntimeStack!;
  const cluster = out.ClusterName!;
  const service = out.ControlPlaneServiceName!;
  const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '14351');
  const token = awsJson<{ SecretString?: string }>(['secretsmanager', 'get-secret-value', '--secret-id', out.OperatorTokenSecretArn!]).SecretString?.trim();
  if (!token) throw new Error('Operator token missing');
  const startedAtMs = Date.now();
  const summary: Record<string, unknown> = {};
  let tunnelPid: number | undefined;
  aws(['ecs', 'update-service', '--cluster', cluster, '--service', service, '--desired-count', '1', '--query', 'service.desiredCount', '--output', 'text']);
  try {
    let target: string | null = null;
    for (const deadline = Date.now() + 300_000; Date.now() < deadline && !target; ) {
      const taskArn = awsJson<{ taskArns?: string[] }>(['ecs', 'list-tasks', '--cluster', cluster, '--service-name', service, '--desired-status', 'RUNNING']).taskArns?.[0];
      if (taskArn) {
        const task = awsJson<{ tasks?: { lastStatus?: string; containers?: { name?: string; runtimeId?: string; managedAgents?: { name?: string; lastStatus?: string }[] }[] }[] }>(
          ['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn],
        ).tasks?.[0];
        const c = task?.containers?.find((x) => x.name === 'control-plane');
        if (task?.lastStatus === 'RUNNING' && c?.runtimeId && c.managedAgents?.some((a) => a.name === 'ExecuteCommandAgent' && a.lastStatus === 'RUNNING')) {
          target = `ecs:${cluster}_${taskArn.split('/').pop()}_${c.runtimeId}`;
        }
      }
      if (!target) await sleep(8_000);
    }
    if (!target) throw new Error('Timed out waiting for a RUNNING ControlPlaneService task');
    const child = spawn(
      'aws',
      ['--profile', profile, '--region', REGION, 'ssm', 'start-session', '--target', target, '--document-name', 'AWS-StartPortForwardingSession',
        '--parameters', JSON.stringify({ portNumber: ['4310'], localPortNumber: [String(localPort)] })],
      { stdio: 'ignore', detached: true },
    );
    tunnelPid = child.pid;
    const base = `http://127.0.0.1:${localPort}`;
    let healthy = false;
    for (const deadline = Date.now() + 90_000; Date.now() < deadline && !healthy; ) {
      try {
        healthy = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        // still starting
      }
      if (!healthy) await sleep(1500);
    }
    if (!healthy) throw new Error('Timed out waiting for SSM tunnel to ControlPlaneService');
    const get = async (path: string) => {
      const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const mf = await get('/api/model-factory/jobs');
    const delivery = await get('/api/delivery/tasks');
    const collab = await get('/api/collab/sessions');
    summary.modelFactory = { storageBackend: mf.storageBackend ?? null, jobs: (mf.jobs as unknown[]).length };
    summary.delivery = { storageBackend: delivery.storageBackend ?? null, tasks: (delivery.tasks as unknown[]).length };
    summary.collab = { storageBackend: collab.storageBackend ?? null, sessions: (collab.sessions as unknown[]).length };
    await sleep(8_000);
    const logs = awsJson<{ events?: { message?: string }[] }>([
      'logs', 'filter-log-events', '--log-group-name', `/hivemind/${process.env.HIVEMIND_AWS_PREFIX ?? 'hivemind-runtime'}`,
      '--start-time', String(startedAtMs), '--filter-pattern', '"dsql_enabled"',
    ]);
    summary.startupEvents = (logs.events ?? []).map((e) => (e.message ?? '').slice(0, 200));
  } finally {
    if (tunnelPid !== undefined) {
      try {
        process.kill(-tunnelPid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    aws(['ecs', 'update-service', '--cluster', cluster, '--service', service, '--desired-count', '0', '--query', 'service.desiredCount', '--output', 'text']);
  }
  summary.controlPlaneDesiredCount = Number(aws(['ecs', 'describe-services', '--cluster', cluster, '--services', service, '--query', 'services[0].desiredCount', '--output', 'text']));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
