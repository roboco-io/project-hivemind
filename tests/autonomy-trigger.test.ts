import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import { AutonomyDispatcher, type PreparedSnapshot } from '../apps/control-plane/src/autonomy-dispatcher.js';
import { createGitSnapshotPreparer } from '../apps/control-plane/src/autonomy-snapshot.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { AutonomyTriggerStore } from '../packages/core/src/autonomy-trigger.js';
import { DeliveryStore, computeAcceptanceTestDigest } from '../packages/core/src/delivery.js';

const REPO = 'roboco-io/silicon-model-factory';
const BASE = 'a'.repeat(40);
const CONFIG = {
  repository: REPO,
  baseBranch: 'main',
  branchPrefix: 'hivemind/autonomy/',
  title: 'Advance the SMF autonomy loop',
  instructions: 'Read ops/autonomy/state.json and advance exactly one stage.',
  provider: 'codex',
  intervalMinutes: 30,
  maxIterations: 2,
  maxIterationDurationMs: 3_600_000,
  budgetMicros: 0,
  protectedPaths: ['tools/', 'infra/', 'ledger/policy.json', '.claude/', 'AGENTS.md', 'releases/*/criteria.json'],
  testCommand: ['npm', 'test'],
};

function snapshot(commit = BASE): PreparedSnapshot {
  const files = [{ path: 'AGENTS.md', sha256: 'd'.repeat(64) }];
  return {
    baseCommit: commit,
    bundle: { baseCommit: commit, bundleSha256: 'f'.repeat(64), sizeBytes: 10, fileCount: 3, s3Key: `bundles/autonomy/smf/${commit}.bundle` },
    acceptance: { baseCommit: commit, files, testCommand: CONFIG.testCommand, digest: computeAcceptanceTestDigest({ baseCommit: commit, files, testCommand: CONFIG.testCommand }) },
  };
}

function harness() {
  let clock = Date.parse('2026-11-28T00:00:00Z');
  const now = () => clock;
  const triggers = new AutonomyTriggerStore(':memory:', { now });
  const delivery = new DeliveryStore(':memory:', now, [REPO]);
  const dispatched: string[] = [];
  const uploads: string[] = [];
  let failDispatch = false;
  const dispatcher = new AutonomyDispatcher({
    triggers,
    delivery,
    prepare: async () => snapshot(),
    dispatchWorker: async (taskId) => {
      if (failDispatch) throw new Error('ECS RunTask failed');
      dispatched.push(taskId);
    },
    uploadAcceptance: async (task) => {
      uploads.push(task.id);
    },
    primaryRegion: 'ap-northeast-2',
    now,
    log: () => {},
  });
  return { triggers, delivery, dispatcher, dispatched, uploads, advance: (ms: number) => { clock += ms; }, failDispatch: (v: boolean) => { failDispatch = v; } };
}

test('a trigger is created disabled, validated, and only sends work once enabled', async () => {
  const h = harness();
  await assert.rejects(h.triggers.configure('Bad Id', CONFIG), /Trigger id/);
  await assert.rejects(h.triggers.configure('smf', { ...CONFIG, intervalMinutes: 1 }), /intervalMinutes/);
  await assert.rejects(h.triggers.configure('smf', { ...CONFIG, protectedPaths: [] }), /protectedPaths/);
  await assert.rejects(h.triggers.configure('smf', { ...CONFIG, branchPrefix: 'main/' }), /protected or base branch/);
  const created = await h.triggers.configure('smf', CONFIG);
  assert.equal(created.enabled, false);
  assert.deepEqual(await h.dispatcher.tick(), { dispatched: [], skipped: [] });
  await h.triggers.setEnabled('smf', true, 'operator turns it on');
  const first = await h.dispatcher.tick();
  assert.equal(first.dispatched.length, 1);
  const task = await h.delivery.get(first.dispatched[0]!);
  assert.equal(task.status, 'queued', 'approved by the trigger');
  assert.equal(task.delivery.autoMerge, true);
  assert.deepEqual(task.delivery.protectedPaths, CONFIG.protectedPaths);
  assert.equal(task.executionPolicy?.hivemindAgentAccess, true);
  assert.deepEqual(task.routing?.allowedRegions, ['ap-northeast-2']);
  assert.deepEqual(h.dispatched, [task.id]);
  assert.deepEqual(h.uploads, [task.id], 'the acceptance spec is uploaded before the worker starts');
  assert.equal((await h.triggers.get('smf')).lastTaskId, task.id);
});

test('no second task while one is open, and the next one after it closes and the interval passed', async () => {
  const h = harness();
  await h.triggers.configure('smf', CONFIG);
  await h.triggers.setEnabled('smf', true, 'on');
  const [firstId] = (await h.dispatcher.tick()).dispatched;
  assert.deepEqual(await h.dispatcher.tick(), { dispatched: [], skipped: [] }, 'not due yet');
  h.advance(31 * 60_000);
  assert.deepEqual((await h.dispatcher.tick()).skipped, ['smf'], 'due but the first task is open');
  assert.match(String((await h.triggers.get('smf')).lastSkipReason), new RegExp(`Task ${firstId} is still queued`));
  await h.delivery.cancel(firstId!, 'stage finished elsewhere');
  const second = await h.dispatcher.tick();
  assert.equal(second.dispatched.length, 1);
  assert.notEqual(second.dispatched[0], firstId);
  const types = (await h.triggers.events()).map((e) => e.type);
  assert.equal(types.filter((t) => t === 'autonomy_trigger.skipped').length, 1, 'a repeated skip reason is recorded once');
});

test('a worker that cannot start leaves no open task behind', async () => {
  const h = harness();
  await h.triggers.configure('smf', CONFIG);
  await h.triggers.setEnabled('smf', true, 'on');
  h.failDispatch(true);
  assert.deepEqual((await h.dispatcher.tick()).skipped, ['smf']);
  const [task] = await h.delivery.list();
  assert.equal(task?.status, 'cancelled');
  assert.match(String((await h.triggers.get('smf')).lastSkipReason), /ECS RunTask failed/);
  h.failDispatch(false);
  h.advance(31 * 60_000);
  assert.equal((await h.dispatcher.tick()).dispatched.length, 1);
});

test('a refused auto-merge turns the trigger off', async () => {
  const h = harness();
  await h.triggers.configure('smf', CONFIG);
  await h.triggers.setEnabled('smf', true, 'on');
  const [id] = (await h.dispatcher.tick()).dispatched;
  const task = await h.delivery.get(id!);
  assert.deepEqual(await h.dispatcher.stopForRefusedMerge(task, 'The change touches protected paths.'), ['smf']);
  const stopped = await h.triggers.get('smf');
  assert.equal(stopped.enabled, false);
  assert.match(String(stopped.disabledReason), /touches protected paths/);
});

test('the API lets the agent read triggers but only the operator configure, enable or tick them', async (t) => {
  const OP = 'operator-token-0000000000000000000001';
  const AG = 'agent-token-000000000000000000000003';
  const app = buildApp({ operatorToken: OP, workerToken: 'worker-token-00000000000000000000002', agentToken: AG, deliveryAutoMergeRepositories: [REPO] });
  t.after(() => app.close());
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  assert.equal((await call('PUT', '/api/autonomy/triggers/smf', AG, CONFIG)).statusCode, 401);
  assert.equal((await call('PUT', '/api/autonomy/triggers/smf', OP, CONFIG)).statusCode, 200);
  assert.equal((await call('POST', '/api/autonomy/triggers/smf/enable', AG, { reason: 'x' })).statusCode, 401);
  assert.equal((await call('POST', '/api/autonomy/triggers/smf/enable', OP, { reason: 'operator' })).json().enabled, true);
  const listed = await call('GET', '/api/autonomy/triggers', AG);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().triggers[0].id, 'smf');
  assert.equal((await call('POST', '/api/autonomy/tick', AG, {})).statusCode, 401);
  assert.equal((await call('POST', '/api/autonomy/triggers/smf/disable', OP, { reason: '' })).statusCode, 400);
});

test('the agent token reads only the delivery tasks of a configured trigger, and changes none', async (t) => {
  const OP = 'operator-token-0000000000000000000001';
  const AG = 'agent-token-000000000000000000000003';
  const app = buildApp({ operatorToken: OP, workerToken: 'worker-token-00000000000000000000002', agentToken: AG, deliveryAutoMergeRepositories: [REPO] });
  t.after(() => app.close());
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  const body = (branchPrefix: string) => {
    const snap = snapshot();
    return {
      title: 'task', instructions: 'do it', provider: 'codex', maxIterations: 1, budgetMicros: 0,
      acceptance: snap.acceptance, bundle: snap.bundle,
      delivery: { mode: 'draft_pr', repository: REPO, baseBranch: 'main', branchPrefix, autoMerge: false },
      spot: { maxSpotRetries: 2, checkpointFlushTimeoutMs: 90_000 },
      routing: { primaryRegion: 'ap-northeast-2', allowedRegions: ['ap-northeast-2'], workloadClass: 'cpu-arm-worker' },
    };
  };
  const own = await call('POST', '/api/delivery/tasks', OP, body(CONFIG.branchPrefix));
  assert.equal(own.statusCode, 201, own.body);
  const other = await call('POST', '/api/delivery/tasks', OP, body('agent/other/'));
  assert.equal(other.statusCode, 201, other.body);
  const ownId = own.json().id as string;
  const otherId = other.json().id as string;

  // No trigger yet: the agent sees nothing.
  assert.deepEqual((await call('GET', '/api/delivery/tasks', AG)).json().tasks, []);
  assert.equal((await call('GET', `/api/delivery/tasks/${ownId}`, AG)).statusCode, 404);

  assert.equal((await call('PUT', '/api/autonomy/triggers/smf', OP, CONFIG)).statusCode, 200);
  const listed = (await call('GET', '/api/delivery/tasks', AG)).json() as { tasks: { id: string }[]; events: { taskId: string }[] };
  assert.deepEqual(listed.tasks.map((x) => x.id), [ownId]);
  assert.ok(listed.events.length > 0 && listed.events.every((e) => e.taskId === ownId));
  assert.equal((await call('GET', `/api/delivery/tasks/${ownId}`, AG)).statusCode, 200);
  // Another task answers like a missing one.
  assert.equal((await call('GET', `/api/delivery/tasks/${otherId}`, AG)).statusCode, 404);
  // The operator still sees every task.
  assert.equal((await call('GET', '/api/delivery/tasks', OP)).json().tasks.length, 2);
  // No write, approval or cancellation with the agent token.
  const fingerprint = own.json().approvalFingerprint as string;
  assert.equal((await call('POST', `/api/delivery/tasks/${ownId}/approve`, AG, { approvalFingerprint: fingerprint, reason: 'x' })).statusCode, 401);
  assert.equal((await call('POST', `/api/delivery/tasks/${ownId}/cancel`, AG, { reason: 'x' })).statusCode, 401);
  assert.equal((await call('POST', '/api/delivery/tasks', AG, body(CONFIG.branchPrefix))).statusCode, 401);
});

test('the snapshot preparer bundles the branch head and pins only files under protected paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hm-autonomy-src-'));
  try {
    const src = join(root, 'src');
    mkdirSync(join(src, 'tools'), { recursive: true });
    mkdirSync(join(src, 'releases', 'm1'), { recursive: true });
    writeFileSync(join(src, 'AGENTS.md'), 'rules\n');
    writeFileSync(join(src, 'tools', 'release-check.mjs'), 'check\n');
    writeFileSync(join(src, 'releases', 'm1', 'criteria.json'), '{}\n');
    writeFileSync(join(src, 'releases', 'm1', 'card.md'), 'card\n');
    writeFileSync(join(src, 'package.json'), '{"scripts":{"test":"true"}}\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: src, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).toString().trim();
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    const head = git('rev-parse', 'HEAD');
    const uploads: string[] = [];
    const s3: S3ObjectPort = { async putObject(key) { uploads.push(key); return { sha256: '' }; }, async getObject() { throw new Error('unused'); } };
    const prepare = createGitSnapshotPreparer({ s3, resolveToken: async () => 'ghs_secret_token_value', remoteUrl: () => src, workRoot: root });
    const triggers = new AutonomyTriggerStore();
    const trigger = await triggers.configure('smf', CONFIG);
    const snap = await prepare(trigger, AbortSignal.timeout(60_000));
    assert.equal(snap.baseCommit, head);
    assert.deepEqual(uploads, [`bundles/autonomy/smf/${head}.bundle`]);
    assert.equal(snap.bundle.s3Key, uploads[0]);
    assert.deepEqual(snap.acceptance.files.map((f) => f.path), ['AGENTS.md', 'releases/m1/criteria.json', 'tools/release-check.mjs']);
    assert.deepEqual(snap.acceptance.testCommand, ['npm', 'test']);
    const failing = createGitSnapshotPreparer({ s3, resolveToken: async () => 'ghs_secret_token_value', remoteUrl: () => join(root, 'missing'), workRoot: root });
    const encoded = Buffer.from('x-access-token:ghs_secret_token_value').toString('base64');
    await assert.rejects(failing(trigger, AbortSignal.timeout(60_000)), (e: Error) => /git clone failed/.test(e.message) && !e.message.includes('ghs_secret_token_value') && !e.message.includes(encoded));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
