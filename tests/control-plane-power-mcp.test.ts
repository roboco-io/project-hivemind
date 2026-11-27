import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ControlPlanePower, loadControlPlanePowerConfig, type ControlPlanePowerConfig, type PowerSystem } from '../apps/mcp-server/src/control-plane-power.js';
import { createHivemindMcpServer, loadMcpSettings } from '../apps/mcp-server/src/server.js';

const TOKEN = 'operator-power-token-0123456789';
const CONFIG: ControlPlanePowerConfig = { profile: 'ops', region: 'ap-northeast-2', cluster: 'hm-cluster', service: 'hm-cp' };

/** A fake AWS account and Control Plane. The API answers only while a task runs AND a tunnel is open. */
function world(initial: { desired?: number; tasksReadyAfterPolls?: number; realSleepMs?: number } = {}) {
  const w = {
    desired: initial.desired ?? 0,
    taskReadyIn: initial.tasksReadyAfterPolls ?? 1,
    tunnelOpen: false,
    tunnelsOpened: 0,
    tunnelsClosed: 0,
    apiAnswers: true,
    now: 1_000_000,
    awsCalls: [] as string[],
    awsFails: false,
    delivery: [] as { id?: string; status: string }[],
    untouched: [] as { taskId: string; reason: string }[],
    jobs: [] as { status: string }[],
    sessions: [] as { id: string; status: string; subtasks: { status: string }[] }[],
    reconciles: [] as string[],
    apiCalls: 0,
  };
  const taskRunning = () => w.desired === 1 && w.taskReadyIn <= 0;
  const system: PowerSystem = {
    async aws(args) {
      w.awsCalls.push(args.slice(0, 2).join(' ') + (args.includes('--desired-count') ? ` ${args[args.indexOf('--desired-count') + 1]}` : ''));
      if (w.awsFails) throw new Error('aws_cli_failed');
      if (args[1] === 'describe-services') return JSON.stringify({ services: [{ desiredCount: w.desired }] });
      if (args[1] === 'update-service') {
        w.desired = Number(args[args.indexOf('--desired-count') + 1]);
        if (w.desired === 0) w.taskReadyIn = initial.tasksReadyAfterPolls ?? 1;
        return '{}';
      }
      if (args[1] === 'list-tasks') {
        if (w.desired === 1) w.taskReadyIn -= 1;
        return JSON.stringify({ taskArns: taskRunning() ? ['arn:aws:ecs:ap-northeast-2:1:task/hm-cluster/abc123'] : [] });
      }
      if (args[1] === 'describe-tasks') return JSON.stringify({ tasks: [{ lastStatus: 'RUNNING', containers: [{ name: 'control-plane', lastStatus: 'RUNNING', runtimeId: 'abc123-999' }] }] });
      throw new Error(`unexpected aws ${args.join(' ')}`);
    },
    openTunnel(target, localPort) {
      assert.equal(target, 'ecs:hm-cluster_abc123_abc123-999');
      assert.equal(localPort, 4311);
      w.tunnelOpen = true;
      w.tunnelsOpened += 1;
      return { close: () => { if (w.tunnelOpen) w.tunnelsClosed += 1; w.tunnelOpen = false; } };
    },
    async sleep(ms) { w.now += ms; if (initial.realSleepMs) await new Promise((r) => setTimeout(r, initial.realSleepMs)); },
    now: () => w.now,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    w.apiCalls += 1;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!(taskRunning() && w.tunnelOpen && w.apiAnswers)) throw new TypeError('fetch failed');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${TOKEN}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const path = url.pathname;
    if (init?.method === 'POST' && path.endsWith('/reconcile')) { w.reconciles.push(path); return json(path === '/api/delivery/reconcile' ? { checked: w.untouched.length, failed: [], untouched: w.untouched } : {}); }
    if (path === '/api/delivery/tasks') return json({ storageBackend: 'aurora-dsql', tasks: w.delivery });
    if (path === '/api/model-factory/jobs') return json({ storageBackend: 'aurora-dsql', jobs: w.jobs });
    if (path === '/api/model-factory/ledger') return json({ globalBudgetCapMicros: 1, totalReservedMicros: 0, totalSettledMicros: 0, remainingBudgetMicros: 1 });
    if (path === '/api/collab/sessions') return json({ storageBackend: 'aurora-dsql', sessions: w.sessions.map(({ id, status }) => ({ id, status })) });
    const session = w.sessions.find((s) => path === `/api/collab/sessions/${s.id}`);
    if (session) return json({ subtasks: session.subtasks });
    return new Response('{}', { status: 404 });
  };
  const power = (config: ControlPlanePowerConfig | null = CONFIG) =>
    new ControlPlanePower({ apiUrl: 'http://127.0.0.1:4311/', operatorToken: TOKEN, ...(config ? { config, system } : {}), fetchImpl, pollMs: 1_000 });
  return { w, system, fetchImpl, power };
}
const SESSION = 'ses-00000000-0000-4000-8000-000000000001';
const LEGACY = 'dlv-00000000-0000-4000-8000-0000000000aa';

test('start raises the dormant service, waits for the task, opens the tunnel, and a second start changes nothing', async () => {
  const { w, power } = world({ tasksReadyAfterPolls: 3 });
  const p = power();
  assert.equal(await p.state(), 'stopped');
  const started = await p.start();
  assert.deepEqual({ state: started.state, started: started.started, idle: started.idleStopAfterMinutes }, { state: 'running', started: true, idle: 15 });
  assert.equal(w.desired, 1);
  assert.equal(w.tunnelsOpened, 1);
  assert.ok(p.ownsControlPlane);
  assert.equal(await p.state(), 'running');

  const again = await p.start();
  assert.deepEqual({ started: again.started, already: again.alreadyRunning }, { started: false, already: true });
  assert.equal(w.tunnelsOpened, 1, 'no second tunnel');
  assert.equal(w.awsCalls.filter((c) => c.startsWith('ecs update-service')).length, 1);
});

test('a start that outlasts the call returns "starting", and the next call returns the result of the same start', async () => {
  const { w, power } = world({ tasksReadyAfterPolls: 40, realSleepMs: 5 });
  const p = power();
  const first = await p.start(20);
  assert.equal(first.state, 'starting');
  assert.equal(first.started, false);
  const second = await p.start(600_000);
  assert.equal(second.state, 'running');
  assert.equal(second.started, true);
  assert.equal(w.awsCalls.filter((c) => c === 'ecs update-service 1').length, 1, 'the second call joined the first start');
});

test('a start that cannot finish lowers the service it raised, and leaves a service it did not raise alone', async () => {
  const stuck = world({ tasksReadyAfterPolls: 100_000 });
  const failed = await stuck.power().start(10_000_000);
  assert.equal(failed.started, false);
  assert.equal(failed.state, 'stopped');
  assert.equal(stuck.w.desired, 0, 'no billed task is left behind');
  assert.match(failed.reason!, /다시 0으로 내렸습니다/);

  // API never answers through the tunnel: the tunnel is closed and the raised service is lowered.
  const mute = world();
  mute.w.apiAnswers = false;
  const noApi = await mute.power().start(10_000_000);
  assert.equal(noApi.started, false);
  assert.equal(mute.w.desired, 0);
  assert.equal(mute.w.tunnelOpen, false);
  assert.equal(mute.w.tunnelsClosed, 1);

  // Someone else already raised the service; a failed start must not lower it.
  const other = world({ desired: 1 });
  other.w.apiAnswers = false;
  const p = other.power();
  const result = await p.start(10_000_000);
  assert.equal(result.started, false);
  assert.equal(other.w.desired, 1);
  assert.equal(other.w.tunnelOpen, false);
  assert.ok(!other.w.awsCalls.includes('ecs update-service 0'));
});

test('stop refuses while work is in progress, settles lost workers first, and force overrides', async () => {
  const { w, power } = world();
  const p = power();
  await p.start();
  // A record with no recorded worker cannot be settled automatically; the refusal names it.
  w.delivery = [{ id: LEGACY, status: 'running' }, { status: 'cancelled' }];
  w.untouched = [{ taskId: LEGACY, reason: 'no ECS task recorded; cancel the task if its worker is gone' }];
  w.jobs = [{ status: 'training_running' }, { status: 'evaluating' }];
  w.sessions = [{ id: SESSION, status: 'active', subtasks: [{ status: 'running' }, { status: 'running' }, { status: 'completed' }] }];

  const refused = await p.stop();
  assert.equal(refused.stopped, false);
  assert.deepEqual(refused.inProgress, { deliveryTasks: 1, modelFactoryJobs: 1, collabSubtasks: 2, blockingIds: [LEGACY], unverifiable: [{ id: LEGACY, reason: 'no ECS task recorded; cancel the task if its worker is gone' }] });
  assert.equal(w.desired, 1);
  assert.ok(w.tunnelOpen, 'the tunnel stays open when the stop is refused');
  // Lost workers are settled by the Control Plane before the count.
  assert.deepEqual(w.reconciles, ['/api/delivery/reconcile', `/api/collab/sessions/${SESSION}/reconcile`]);

  // An "active" session with no running subtask, and non-running records, do not block.
  w.delivery = [{ status: 'approved' }];
  w.untouched = [];
  w.jobs = [{ status: 'awaiting_release_approval' }];
  w.sessions[0]!.subtasks = [{ status: 'pending' }];
  const stopped = await p.stop();
  assert.deepEqual(stopped, { stopped: true });
  assert.equal(w.desired, 0);
  assert.equal(w.tunnelOpen, false);
  assert.ok(!p.ownsControlPlane);
  assert.deepEqual(await p.stop(), { stopped: true, alreadyStopped: true });

  await p.start();
  w.delivery = [{ status: 'running' }];
  assert.deepEqual(await p.stop(true), { stopped: true });
  assert.equal(w.desired, 0);
});

test('stop without a reachable API does not guess: it needs force while the service is up', async () => {
  const { w, power } = world({ desired: 1 });
  const p = power(); // no tunnel from this server
  const refused = await p.stop();
  assert.equal(refused.stopped, false);
  assert.match(refused.reason!, /확인하지 못했습니다/);
  assert.equal(w.desired, 1);
  assert.deepEqual(await p.stop(true), { stopped: true });
  assert.equal(w.desired, 0);
});

test('idle stop: only after the idle period, only when this server started it, and never while work is in progress', async () => {
  const { w, power } = world();
  const p = power({ ...CONFIG, idleMinutes: 10 });
  assert.equal(await p.checkIdle(), 'not_owned');
  await p.start();
  assert.equal(await p.checkIdle(), 'active');
  w.now += 9 * 60_000;
  p.markActivity(); // an operator tool call
  w.now += 9 * 60_000;
  assert.equal(await p.checkIdle(), 'active', 'the tool call restarted the idle period');
  w.now += 2 * 60_000;
  w.delivery = [{ status: 'running' }];
  assert.equal(await p.checkIdle(), 'busy');
  assert.equal(w.desired, 1);
  w.delivery = [];
  assert.equal(await p.checkIdle(), 'active', 'after a busy result the next look is 5 minutes later');
  w.now += 5 * 60_000 + 1;
  assert.equal(await p.checkIdle(), 'stopped');
  assert.equal(w.desired, 0);
  assert.equal(w.tunnelOpen, false);

  // A Control Plane this server did not start is never stopped on idle.
  const other = world({ desired: 1 });
  other.w.taskReadyIn = 0;
  other.w.tunnelOpen = true; // someone else's tunnel on the same port
  const q = other.power();
  const joined = await q.start();
  assert.equal(joined.alreadyRunning, true);
  assert.ok(!q.ownsControlPlane);
  other.w.now += 24 * 3_600_000;
  assert.equal(await q.checkIdle(), 'not_owned');
  assert.equal(other.w.desired, 1);
});

test('shutdown lowers a Control Plane this server started, but not while work is in progress; the tunnel always closes', async () => {
  const idle = world();
  const p = idle.power();
  await p.start();
  assert.equal(await p.shutdown(), 'stopped');
  assert.equal(idle.w.desired, 0);
  assert.equal(idle.w.tunnelOpen, false);

  const busy = world();
  const q = busy.power();
  await q.start();
  busy.w.jobs = [{ status: 'training_running' }];
  assert.equal(await q.shutdown(), 'left_running');
  assert.equal(busy.w.desired, 1, 'a running training job keeps its Control Plane');
  assert.equal(busy.w.tunnelOpen, false);
});

test('without settings, or when the AWS CLI fails, the tools explain instead of acting', async () => {
  const none = world();
  const p = none.power(null);
  assert.equal(await p.state(), 'not_configured');
  const start = await p.start();
  assert.equal(start.started, false);
  assert.match(start.reason!, /npm run bootstrap/);
  assert.equal((await p.stop()).stopped, false);
  assert.deepEqual(none.w.awsCalls, []);

  const broken = world();
  broken.w.awsFails = true;
  const q = broken.power();
  assert.equal(await q.state(), 'unknown');
  const failed = await q.start();
  assert.equal(failed.started, false);
  assert.match(failed.reason!, /AWS CLI|로그인/);
});

test('the settings file is read strictly, and a broken one disables the tools without breaking the server', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-power-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => { const file = join(dir, name); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  assert.deepEqual(loadControlPlanePowerConfig(write('ok.json', { ...CONFIG, idleMinutes: 30 })), { ...CONFIG, idleMinutes: 30 });
  assert.deepEqual(loadControlPlanePowerConfig(write('min.json', { region: 'us-east-1', cluster: 'c', service: 's' })), { region: 'us-east-1', cluster: 'c', service: 's' });
  for (const bad of [{ ...CONFIG, cluster: 'a b; rm -rf' }, { ...CONFIG, profile: '--endpoint-url=http://x' }, { ...CONFIG, idleMinutes: 0 }, { region: 'r' }, [], 'not json']) {
    assert.equal(loadControlPlanePowerConfig(write('bad.json', bad)), undefined, JSON.stringify(bad));
  }
  assert.equal(loadControlPlanePowerConfig(join(dir, 'missing.json')), undefined);
  symlinkSync(join(dir, 'ok.json'), join(dir, 'link.json'));
  assert.equal(loadControlPlanePowerConfig(join(dir, 'link.json')), undefined, 'a symbolic link is not followed');

  const base = { HIVEMIND_OPERATOR_TOKEN: TOKEN, HIVEMIND_API_URL: 'http://127.0.0.1:4311' };
  assert.deepEqual(loadMcpSettings({ ...base, HIVEMIND_CONTROL_PLANE_CONFIG_FILE: join(dir, 'ok.json') }).controlPlanePower, { ...CONFIG, idleMinutes: 30 });
  assert.equal(loadMcpSettings({ ...base, HIVEMIND_CONTROL_PLANE_CONFIG_FILE: join(dir, 'bad.json') }).controlPlanePower, undefined);
  assert.equal(loadMcpSettings(base).controlPlanePower, undefined, 'no HOME and no file: nothing is looked up');
  // Default location under HOME.
  const home = mkdtempSync(join(tmpdir(), 'hm-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(loadMcpSettings({ ...base, HOME: home }).controlPlanePower, undefined);
});

test('MCP tools: status explains the dormant state, start and stop work end to end, and operator calls count as activity', async (t) => {
  const { w, system, fetchImpl } = world();
  const server = createHivemindMcpServer({ apiUrl: 'http://127.0.0.1:4311', operatorToken: TOKEN, controlPlanePower: CONFIG, powerSystem: system, fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'power-test', version: '0.1.0' });
  await client.connect(clientTransport);
  let closed = false;
  t.after(async () => { if (!closed) { await client.close(); await server.close(); } });
  type Result = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, any> };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;

  const tools = (await client.listTools()).tools;
  const start = tools.find((tool) => tool.name === 'hivemind_control_plane_start')!;
  const stop = tools.find((tool) => tool.name === 'hivemind_control_plane_stop')!;
  assert.match(start.description!, /과금/);
  assert.equal(start.annotations?.readOnlyHint, false);
  assert.equal(stop.annotations?.destructiveHint, true);

  const dormant = await call('hivemind_status');
  assert.ok(!dormant.isError, 'a dormant Control Plane is not an error');
  assert.equal(dormant.structuredContent!.connected, false);
  assert.equal(dormant.structuredContent!.controlPlane.state, 'stopped');
  assert.match(dormant.structuredContent!.controlPlane.hint, /hivemind_control_plane_start/);
  assert.equal(w.desired, 0, 'asking for status never starts anything');
  // No other tool starts it either.
  await call('hivemind_delivery_list');
  assert.equal(w.desired, 0);

  const started = (await call('hivemind_control_plane_start')).structuredContent!;
  assert.equal(started.started, true);
  assert.equal(w.desired, 1);
  const status = (await call('hivemind_status')).structuredContent!;
  assert.equal(status.connected, true);

  w.delivery = [{ status: 'running' }];
  const refused = (await call('hivemind_control_plane_stop')).structuredContent!;
  assert.equal(refused.stopped, false);
  assert.equal(refused.inProgress.deliveryTasks, 1);
  assert.equal((await call('hivemind_control_plane_stop', { force: 'yes' })).isError, true, 'force must be a boolean');
  w.delivery = [];
  assert.equal((await call('hivemind_control_plane_stop')).structuredContent!.stopped, true);
  assert.equal(w.desired, 0);

  // Closing the server lowers a Control Plane it started.
  await call('hivemind_control_plane_start');
  assert.equal(w.desired, 1);
  await client.close();
  await server.close();
  closed = true;
  assert.equal(w.desired, 0);
  assert.equal(w.tunnelOpen, false);
  for (const text of [JSON.stringify(dormant), JSON.stringify(started), JSON.stringify(refused)]) assert.ok(!text.includes(TOKEN));
});
