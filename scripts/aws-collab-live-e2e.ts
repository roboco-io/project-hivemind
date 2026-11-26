import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHivemindMcpServer } from '../apps/mcp-server/src/server.js';
import type { CollabSessionSnapshot } from '../packages/contracts/src/agent-collab.js';

/**
 * Live AWS proof for Issue #16 task 2: an operator drives a parallel agent cluster through the MCP `collab`
 * profile against the deployed Seoul Control Plane (reached over an SSM port-forwarding tunnel).
 *
 *   1. (Optional) `hivemind_collab_run_orchestrator` runs the embedded Claude/Codex orchestrator inside the
 *      Control Plane. This step needs the operator's local model auth file. It runs ONLY when
 *      HIVEMIND_COLLAB_LOCAL_AUTH_FILE is set; the script never looks for credentials on its own.
 *      Without the file the script adds two subtasks itself and reports the orchestrator step as skipped.
 *   2. `hivemind_collab_fan_out` starts one ECS FARGATE_SPOT worker per ready subtask (2 in parallel).
 *   3. Each worker runs a real model with the Secrets Manager model auth, posts to the Aurora DSQL message
 *      board through the Control Plane HTTP API, and finishes its subtask.
 *
 * The script starts ControlPlaneService (desiredCount 1) and ALWAYS returns it to desiredCount 0. It stops any
 * worker task of this run that is still running at the end. It never prints the operator token or the auth file.
 */

const PRIMARY_REGION = 'ap-northeast-2';
const FIVE_REGIONS = ['ap-northeast-2', 'us-east-2', 'us-east-1', 'us-west-2', 'ap-northeast-1'];
const profile = process.env.AWS_PROFILE ?? 'roboco';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function aws(region: string, args: string[]): string {
  return execFileSync('aws', ['--profile', profile, '--region', region, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function awsJson<T>(region: string, args: string[]): T {
  return JSON.parse(aws(region, [...args, '--output', 'json'])) as T;
}

async function waitForControlPlaneTask(cluster: string, service: string): Promise<{ taskId: string; runtimeId: string }> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const taskArn = awsJson<{ taskArns?: string[] }>(PRIMARY_REGION, [
      'ecs', 'list-tasks', '--cluster', cluster, '--service-name', service, '--desired-status', 'RUNNING',
    ]).taskArns?.[0];
    if (taskArn) {
      const task = awsJson<{
        tasks?: { lastStatus?: string; containers?: { name?: string; runtimeId?: string; managedAgents?: { name?: string; lastStatus?: string }[] }[] }[];
      }>(PRIMARY_REGION, ['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArn]).tasks?.[0];
      const container = task?.containers?.find((c) => c.name === 'control-plane');
      const agentRunning = container?.managedAgents?.some((a) => a.name === 'ExecuteCommandAgent' && a.lastStatus === 'RUNNING');
      if (task?.lastStatus === 'RUNNING' && container?.runtimeId && agentRunning) {
        return { taskId: taskArn.split('/').pop()!, runtimeId: container.runtimeId };
      }
    }
    await sleep(8_000);
  }
  throw new Error('Timed out waiting for a RUNNING ControlPlaneService task');
}

function openTunnel(cluster: string, taskId: string, runtimeId: string, localPort: number) {
  const child = spawn(
    'aws',
    [
      '--profile', profile, '--region', PRIMARY_REGION, 'ssm', 'start-session',
      '--target', `ecs:${cluster}_${taskId}_${runtimeId}`,
      '--document-name', 'AWS-StartPortForwardingSession',
      '--parameters', JSON.stringify({ portNumber: ['4310'], localPortNumber: [String(localPort)] }),
    ],
    { stdio: 'ignore' },
  );
  const ready = (async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${localPort}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        // tunnel or server still starting
      }
      await sleep(1500);
    }
    child.kill('SIGTERM');
    throw new Error('Timed out waiting for SSM tunnel to ControlPlaneService');
  })();
  return { ready, close: () => void (!child.killed && child.kill('SIGTERM')) };
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

async function main(): Promise<void> {
  const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '14327');
  const localAuthFile = process.env.HIVEMIND_COLLAB_LOCAL_AUTH_FILE?.trim() || undefined;
  const provider = process.env.HIVEMIND_COLLAB_PROVIDER === 'codex' ? 'codex' : 'claude';
  const runtimeOut = (
    JSON.parse(readFileSync(process.env.HIVEMIND_RUNTIME_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<
      string,
      Record<string, string>
    >
  ).HivemindAwsRuntimeStack!;
  const cluster = runtimeOut.ClusterName!;
  const service = runtimeOut.ControlPlaneServiceName!;
  const operatorToken = awsJson<{ SecretString?: string }>(PRIMARY_REGION, [
    'secretsmanager', 'get-secret-value', '--secret-id', runtimeOut.OperatorTokenSecretArn!,
  ]).SecretString?.trim();
  if (!operatorToken) throw new Error('Operator token missing');

  const startedAtMs = Date.now();
  aws(PRIMARY_REGION, ['ecs', 'update-service', '--cluster', cluster, '--service', service, '--desired-count', '1', '--query', 'service.desiredCount', '--output', 'text']);
  let tunnel: ReturnType<typeof openTunnel> | null = null;
  let summary: Record<string, unknown> = {};
  const workerTaskArns: string[] = [];

  try {
    const { taskId, runtimeId } = await waitForControlPlaneTask(cluster, service);
    tunnel = openTunnel(cluster, taskId, runtimeId, localPort);
    await tunnel.ready;

    // The operator side talks ONLY through the MCP collab profile.
    const server = createHivemindMcpServer({
      apiUrl: `http://127.0.0.1:${localPort}`,
      operatorToken,
      profile: 'collab',
      ...(localAuthFile ? { collabLocalAuthFile: localAuthFile } : {}),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'aws-collab-live-e2e', version: '0.1.0' });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<Record<string, unknown>> => {
      const result = (await client.callTool({ name: `hivemind_collab_${name}`, arguments: args }, undefined, { timeout: timeoutMs })) as ToolResult;
      if (result.isError || !result.structuredContent) throw new Error(`MCP tool hivemind_collab_${name} failed`);
      return result.structuredContent;
    };

    try {
      const listed = await call('list');
      if (listed.storageBackend !== 'aurora-dsql') throw new Error(`Expected storageBackend=aurora-dsql, got ${String(listed.storageBackend)}`);

      const session = await call('create', {
        title: `Issue #16 live collab e2e ${new Date(startedAtMs).toISOString()}`,
        goal:
          'Two agents work in parallel. Agent A states one fact about AWS Fargate Spot. Agent B states one fact about Amazon Aurora DSQL. ' +
          'Each agent posts its fact to the shared message board and finishes.',
        provider,
        maxParallelWorkers: 2,
        allowedRegions: [PRIMARY_REGION],
      });
      const sessionId = String(session.id);
      console.log(JSON.stringify({ phase: 'session_created', sessionId }));

      let orchestrator: Record<string, unknown>;
      if (localAuthFile) {
        const run = await call(
          'run_orchestrator',
          {
            sessionId,
            prompt:
              'Create exactly two independent subtasks (no dependencies) named "Agent A" and "Agent B" matching the session goal. ' +
              'Keep each instruction under 60 words. Do not start workers yourself.',
            timeoutMs: 300_000,
          },
          360_000,
        );
        orchestrator = { ran: run.started !== false, status: run.status ?? null, reason: run.reason ?? null };
      } else {
        orchestrator = { ran: false, reason: 'HIVEMIND_COLLAB_LOCAL_AUTH_FILE not set; embedded orchestrator step skipped' };
      }

      let snapshot = (await call('get', { sessionId })) as unknown as CollabSessionSnapshot;
      if (snapshot.subtasks.length === 0) {
        for (const [name, topic] of [['Agent A', 'AWS Fargate Spot'], ['Agent B', 'Amazon Aurora DSQL']] as const) {
          await call('add_subtask', {
            sessionId,
            title: name,
            instructions:
              `State one short, correct fact about ${topic} in a single sentence. ` +
              `First post that sentence to the shared message board with: ` +
              `curl -s -X POST "$HIVEMIND_CONTROL_API_URL/api/collab/sessions/$HIVEMIND_COLLAB_SESSION_ID/messages" ` +
              `-H "authorization: Bearer $HIVEMIND_WORKER_TOKEN" -H "content-type: application/json" ` +
              `-d '{"sender":"'"$HIVEMIND_COLLAB_AGENT_ID"'","kind":"chat","body":"<your sentence>"}' ` +
              `Then reply with the same sentence as your final answer. Do nothing else.`,
          });
        }
      }

      const fanOut = await call('fan_out', { sessionId }, 90_000);
      const dispatched = (fanOut.dispatched ?? []) as { id: string; ecsTaskArn: string | null; region: string | null }[];
      for (const d of dispatched) if (d.ecsTaskArn) workerTaskArns.push(d.ecsTaskArn);
      console.log(JSON.stringify({ phase: 'fan_out', dispatched: dispatched.length, skippedReason: fanOut.skippedReason ?? null }));
      if (dispatched.length < 2) throw new Error(`Expected 2 parallel workers, dispatched ${dispatched.length}`);

      const capacityProviders = workerTaskArns.length
        ? awsJson<{ tasks?: { capacityProviderName?: string }[] }>(PRIMARY_REGION, [
            'ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...workerTaskArns,
          ]).tasks?.map((t) => t.capacityProviderName ?? null) ?? []
        : [];

      const deadline = Date.now() + Number(process.env.HIVEMIND_COLLAB_E2E_TIMEOUT_MS ?? '900000');
      while (Date.now() < deadline) {
        await sleep(20_000);
        snapshot = (await call('get', { sessionId })) as unknown as CollabSessionSnapshot;
        const states = snapshot.subtasks.map((s) => s.status);
        console.log(JSON.stringify({ phase: 'poll', states, messages: snapshot.messages.length }));
        if (states.every((s) => s === 'completed' || s === 'failed' || s === 'cancelled')) break;
      }

      const agentIds = new Set(snapshot.subtasks.map((s) => s.assignedAgentId).filter((a): a is string => Boolean(a)));
      const agentMessages = snapshot.messages.filter((m) => agentIds.has(m.sender));
      summary = {
        sessionId,
        storageBackend: snapshot.storageBackend,
        orchestrator,
        subtasks: snapshot.subtasks.map((s) => ({
          title: s.title,
          status: s.status,
          region: s.region,
          agentId: s.assignedAgentId,
          failureReason: s.failureReason ? s.failureReason.slice(0, 300) : null,
        })),
        workerCapacityProviders: capacityProviders,
        messageCount: snapshot.messages.length,
        agentMessageCount: agentMessages.length,
        agentsThatPosted: [...new Set(agentMessages.map((m) => m.sender))].length,
        workLogCount: snapshot.workLogs.length,
        sampleAgentMessages: agentMessages.slice(0, 4).map((m) => ({ sender: m.sender, kind: m.kind, body: m.body.slice(0, 200) })),
      };
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  } finally {
    tunnel?.close();
    for (const arn of workerTaskArns) {
      try {
        aws(PRIMARY_REGION, ['ecs', 'stop-task', '--cluster', cluster, '--task', arn, '--reason', 'collab live e2e cleanup', '--query', 'task.lastStatus', '--output', 'text']);
      } catch {
        // already stopped
      }
    }
    aws(PRIMARY_REGION, ['ecs', 'update-service', '--cluster', cluster, '--service', service, '--desired-count', '0', '--query', 'service.desiredCount', '--output', 'text']);
  }

  const desiredCount = Number(
    aws(PRIMARY_REGION, ['ecs', 'describe-services', '--cluster', cluster, '--services', service, '--query', 'services[0].desiredCount', '--output', 'text']),
  );
  const runningInstances: Record<string, number> = {};
  for (const region of FIVE_REGIONS) {
    runningInstances[region] = Number(
      aws(region, [
        'ec2', 'describe-instances',
        '--filters', 'Name=tag:hivemind:managed-by,Values=hivemind-model-factory', 'Name=instance-state-name,Values=pending,running,stopping,stopped',
        '--query', 'length(Reservations[].Instances[])', '--output', 'text',
      ]),
    );
  }
  const subtasks = (summary.subtasks ?? []) as { status: string }[];
  const workersOk =
    summary.storageBackend === 'aurora-dsql' &&
    subtasks.length >= 2 &&
    subtasks.every((s) => s.status === 'completed') &&
    ((summary.workerCapacityProviders ?? []) as (string | null)[]).every((c) => c === 'FARGATE_SPOT') &&
    Number(summary.agentsThatPosted ?? 0) >= 2;
  const orchestratorRan = (summary.orchestrator as { ran?: boolean } | undefined)?.ran === true;
  console.log(
    JSON.stringify(
      {
        phase: 'summary',
        workersOk,
        orchestratorRan,
        fullyVerified: workersOk && orchestratorRan,
        ...summary,
        controlPlaneDesiredCount: desiredCount,
        runningManagedInstances: runningInstances,
      },
      null,
      2,
    ),
  );
  if (!workersOk || desiredCount !== 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
