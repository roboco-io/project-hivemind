import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../apps/control-plane/src/app.js';
import { CollabOrchestrator, type CollabWorkerLauncherPort } from '../apps/control-plane/src/collab-orchestrator.js';
import { createHivemindMcpServer } from '../apps/mcp-server/src/server.js';
import { AwsEcsFargateSpotDriver } from '../packages/adapters/src/aws-ecs-driver.js';
import { AgentCollabService, SqliteCollaborationRepository } from '../packages/core/src/agent-collab.js';

const OP_TOKEN = 'operator-collab-end-token-999999';
const WK_TOKEN = 'worker-collab-end-token-111111';
type WorkerStatus = Awaited<ReturnType<NonNullable<CollabWorkerLauncherPort['describeWorker']>>>;

/** Launcher whose worker states the test controls. `statuses` maps a subtask id to what ECS would report. */
function fakeLauncher(statuses: Map<string, WorkerStatus | Error>) {
  const stopped: string[] = [];
  const subtaskOf = (taskArn: string) => taskArn.split('/').pop()!;
  const launcher: CollabWorkerLauncherPort = {
    async launchCollabWorker(input) {
      return { taskArn: `arn:aws:ecs:${input.targetRegion}:123456789012:task/c/${input.subtaskId}`, region: input.targetRegion };
    },
    async describeWorker(taskArn) {
      const status = statuses.get(subtaskOf(taskArn));
      if (status instanceof Error) throw status;
      return status === undefined ? { lastStatus: 'RUNNING', stopCode: null, stoppedReason: null, exitCode: null } : status;
    },
    async stopWorker(taskArn) {
      if (subtaskOf(taskArn).endsWith('stop-fails')) throw new Error('AWS ECS StopTask failed with HTTP 500');
      stopped.push(subtaskOf(taskArn));
    },
  };
  return { launcher, stopped };
}

function makeOrchestrator(service: AgentCollabService, launcher?: CollabWorkerLauncherPort) {
  return new CollabOrchestrator({
    service,
    controlApiUrl: 'http://127.0.0.1:4310',
    workerToken: WK_TOKEN,
    redactSecrets: [WK_TOKEN],
    ...(launcher ? { workerLauncher: launcher } : {}),
  });
}

test('completeSession refuses completed while a subtask runs, cancels unfinished subtasks on failed/cancelled, and is idempotent', async () => {
  const service = new AgentCollabService(new SqliteCollaborationRepository(':memory:'));
  try {
    const session = await service.createSession({ title: 'End rules', goal: 'g', provider: 'codex' });
    const a = await service.createSubtask(session.id, { title: 'A', instructions: 'a' });
    const b = await service.createSubtask(session.id, { title: 'B', instructions: 'b', dependsOn: [a.id] });
    await service.claimSubtask(session.id, a.id, { agentId: 'agent-a' });

    await assert.rejects(() => service.completeSession(session.id, 'completed'), /1 running subtask/);
    await assert.rejects(() => service.completeSession(session.id, 'done' as never), /Invalid session end status/);
    assert.equal((await service.getSession(session.id)).status, 'active');

    const cancelled = await service.completeSession(session.id, 'cancelled');
    assert.equal(cancelled.status, 'cancelled');
    const after = await service.listSubtasks(session.id);
    assert.deepEqual(after.map((s) => s.status), ['cancelled', 'cancelled']);
    assert.equal(after.find((s) => s.id === b.id)!.failureReason, 'Session cancelled');

    // Same status again: no change. A different status: refused.
    assert.equal((await service.completeSession(session.id, 'cancelled')).status, 'cancelled');
    await assert.rejects(() => service.completeSession(session.id, 'completed'), /already ended as cancelled/);
    // A worker that reports late cannot revive a cancelled subtask.
    await assert.rejects(() => service.finishSubtask(session.id, a.id, { agentId: 'agent-a', status: 'completed', summary: 'late' }), /not actively owned/);

    // Completed is allowed once nothing runs; finished subtasks keep their result.
    const clean = await service.createSession({ title: 'Clean', goal: 'g', provider: 'codex' });
    const c = await service.createSubtask(clean.id, { title: 'C', instructions: 'c' });
    await service.claimSubtask(clean.id, c.id, { agentId: 'agent-c' });
    await service.finishSubtask(clean.id, c.id, { agentId: 'agent-c', status: 'completed', summary: 'ok' });
    assert.equal((await service.completeSession(clean.id, 'completed')).status, 'completed');
    assert.equal((await service.listSubtasks(clean.id))[0]!.status, 'completed');
  } finally {
    service.close();
  }
});

test('reconcile fails only subtasks whose worker stopped or vanished, and never overwrites a reported result', async () => {
  const service = new AgentCollabService(new SqliteCollaborationRepository(':memory:'));
  const statuses = new Map<string, WorkerStatus | Error>();
  const { launcher } = fakeLauncher(statuses);
  const orchestrator = makeOrchestrator(service, launcher);
  try {
    const session = await service.createSession({ title: 'Reconcile', goal: 'g', provider: 'codex', maxParallelWorkers: 8, allowedRegions: ['ap-northeast-2'] });
    const titles = ['alive', 'stopped', 'vanished', 'lookup-error', 'manual'];
    const ids: Record<string, string> = {};
    for (const title of titles.slice(0, 4)) ids[title] = (await service.createSubtask(session.id, { title, instructions: title })).id;
    await orchestrator.fanOutReadySubtasks(session.id);
    // A subtask claimed by hand has no worker task recorded.
    ids.manual = (await service.createSubtask(session.id, { title: 'manual', instructions: 'manual' })).id;
    await service.claimSubtask(session.id, ids.manual!, { agentId: 'human' });

    statuses.set(ids.stopped!, { lastStatus: 'STOPPED', stopCode: 'SpotInterruption', stoppedReason: 'Your Spot Task was interrupted.', exitCode: 137 });
    statuses.set(ids.vanished!, null);
    statuses.set(ids['lookup-error']!, new Error('AWS ECS DescribeTasks failed with HTTP 503'));

    const result = await orchestrator.reconcileRunningSubtasks(session.id);
    assert.equal(result.checked, 5);
    assert.deepEqual(result.failed.map((f) => f.title).sort(), ['stopped', 'vanished']);
    assert.match(result.failed.find((f) => f.title === 'stopped')!.reason, /SpotInterruption; exit 137; Your Spot Task was interrupted\./);
    assert.match(result.failed.find((f) => f.title === 'vanished')!.reason, /no longer known to ECS/);
    const untouched = Object.fromEntries(result.untouched.map((u) => [u.subtaskId, u.reason]));
    assert.equal(untouched[ids.alive!], 'worker task is RUNNING');
    assert.match(untouched[ids['lookup-error']!]!, /status lookup failed: AWS ECS DescribeTasks failed with HTTP 503/);
    assert.equal(untouched[ids.manual!], 'no worker task recorded');

    const byTitle = Object.fromEntries((await service.listSubtasks(session.id)).map((s) => [s.title, s.status]));
    assert.deepEqual(byTitle, { alive: 'running', stopped: 'failed', vanished: 'failed', 'lookup-error': 'running', manual: 'running' });
    const blockers = (await service.listMessages(session.id)).filter((m) => m.kind === 'blocker');
    assert.equal(blockers.length, 2);

    // Second run: already failed subtasks are not touched or announced again.
    const again = await orchestrator.reconcileRunningSubtasks(session.id);
    assert.equal(again.checked, 3);
    assert.deepEqual(again.failed, []);
    assert.equal((await service.listMessages(session.id)).filter((m) => m.kind === 'blocker').length, 2);

    // failOrphanedSubtask is a no-op once the worker has reported.
    const alive = (await service.listSubtasks(session.id)).find((s) => s.title === 'alive')!;
    await service.finishSubtask(session.id, alive.id, { agentId: alive.assignedAgentId!, status: 'completed', summary: 'done' });
    assert.equal((await service.failOrphanedSubtask(session.id, alive.id, 'late reconcile')).status, 'completed');

    // Without a status lookup nothing is failed.
    const blind = await makeOrchestrator(service).reconcileRunningSubtasks(session.id);
    assert.deepEqual(blind.failed, []);
  } finally {
    service.close();
  }
});

test('endSession stops the workers of running subtasks before cancelling and reports stop errors without keeping the session open', async () => {
  const service = new AgentCollabService(new SqliteCollaborationRepository(':memory:'));
  const { launcher, stopped } = fakeLauncher(new Map());
  const orchestrator = makeOrchestrator(service, launcher);
  try {
    const session = await service.createSession({ title: 'Cancel', goal: 'g', provider: 'codex', maxParallelWorkers: 4, allowedRegions: ['ap-northeast-2'] });
    const a = await service.createSubtask(session.id, { title: 'A', instructions: 'a' });
    const b = await service.createSubtask(session.id, { title: 'B', instructions: 'b' });
    await orchestrator.fanOutReadySubtasks(session.id);
    // Completed never stops a worker and is refused while workers run.
    await assert.rejects(() => orchestrator.endSession(session.id, 'completed'), /2 running subtask/);
    assert.deepEqual(stopped, []);

    const ended = await orchestrator.endSession(session.id, 'cancelled');
    assert.equal(ended.session.status, 'cancelled');
    assert.deepEqual(stopped.sort(), [a.id, b.id].sort());
    assert.deepEqual(ended.stopErrors, []);
    assert.deepEqual((await service.listSubtasks(session.id)).map((s) => s.status), ['cancelled', 'cancelled']);
    // Ending again stops nothing.
    await orchestrator.endSession(session.id, 'cancelled');
    assert.equal(stopped.length, 2);
  } finally {
    service.close();
  }
});

test('AwsEcsFargateSpotDriver.describeTask maps ECS task state and returns null for an unknown task', async () => {
  const responses: Record<string, unknown>[] = [
    { tasks: [{ lastStatus: 'STOPPED', stopCode: 'EssentialContainerExited', stoppedReason: 'Essential container in task exited', containers: [{ exitCode: 1 }] }] },
    { tasks: [{ lastStatus: 'RUNNING', containers: [{}] }] },
    { tasks: [], failures: [{ reason: 'MISSING' }] },
  ];
  const bodies: Record<string, unknown>[] = [];
  const driver = new AwsEcsFargateSpotDriver({
    region: 'ap-northeast-2',
    allowedRegions: ['ap-northeast-2'],
    clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/c',
    workerTaskDefinition: 'worker:1',
    verifierTaskDefinition: 'verifier:1',
    subnets: ['subnet-a'],
    securityGroups: ['sg-a'],
    controlApiUrl: 'http://10.0.0.10:4310',
    allowVpcInternalHttp: true,
    artifactsBucket: 'bucket',
    credentials: () => ({ accessKeyId: 'AKIAEXAMPLE123456', secretAccessKey: 'secret' }),
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      assert.match((init?.headers as Record<string, string>)['x-amz-target']!, /DescribeTasks$/);
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    },
  });
  const arn = 'arn:aws:ecs:ap-northeast-2:123456789012:task/c/abc';
  assert.deepEqual(await driver.describeTask(arn), {
    lastStatus: 'STOPPED',
    stopCode: 'EssentialContainerExited',
    stoppedReason: 'Essential container in task exited',
    exitCode: 1,
  });
  assert.deepEqual(await driver.describeTask(arn), { lastStatus: 'RUNNING', stopCode: null, stoppedReason: null, exitCode: null });
  assert.equal(await driver.describeTask(arn), null);
  assert.deepEqual(bodies[0], { cluster: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/c', tasks: [arn] });
});

test('MCP hivemind_collab_reconcile and hivemind_collab_complete drive the same rules through the operator API', async (t) => {
  const statuses = new Map<string, WorkerStatus | Error>();
  const { launcher, stopped } = fakeLauncher(statuses);
  const app = buildApp({
    operatorToken: OP_TOKEN,
    workerToken: WK_TOKEN,
    collabOrchestratorFactory: (service) => makeOrchestrator(service, launcher),
  });
  t.after(async () => app.close());
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const res = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: url.pathname + url.search, headers, payload: typeof init?.body === 'string' ? init.body : undefined });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  };
  const server = createHivemindMcpServer({ apiUrl: 'http://127.0.0.1:4310', operatorToken: OP_TOKEN, fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-collab-end', version: '0.1.0' });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name: `hivemind_collab_${name}`, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };

  const sessionId = (await call('create', { title: 'MCP end', goal: 'g', provider: 'codex', maxParallelWorkers: 2, allowedRegions: ['ap-northeast-2'] })).structuredContent!.id as string;
  const a = (await call('add_subtask', { sessionId, title: 'A', instructions: 'a' })).structuredContent!.id as string;
  const b = (await call('add_subtask', { sessionId, title: 'B', instructions: 'b' })).structuredContent!.id as string;
  await call('fan_out', { sessionId });

  // completed is refused while workers run (the MCP layer reports a generic error).
  assert.equal((await call('complete', { sessionId, status: 'completed' })).isError, true);

  statuses.set(a, { lastStatus: 'STOPPED', stopCode: 'TaskFailedToStart', stoppedReason: null, exitCode: null });
  const reconciled = await call('reconcile', { sessionId });
  assert.equal(reconciled.isError, undefined, JSON.stringify(reconciled));
  assert.deepEqual(reconciled.structuredContent!.failed.map((f: { subtaskId: string }) => f.subtaskId), [a]);

  const ended = await call('complete', { sessionId, status: 'cancelled' });
  assert.equal(ended.isError, undefined, JSON.stringify(ended));
  assert.equal(ended.structuredContent!.status, 'cancelled');
  assert.deepEqual(ended.structuredContent!.stoppedWorkers, [b]);
  assert.deepEqual(stopped, [b], 'only the still-running worker is stopped');
  const snapshot = (await call('get', { sessionId })).structuredContent!;
  assert.deepEqual(snapshot.subtasks.map((s: { status: string }) => s.status).sort(), ['cancelled', 'failed']);
  assert.equal((await call('complete', { sessionId, status: 'bogus' })).isError, true);
});
