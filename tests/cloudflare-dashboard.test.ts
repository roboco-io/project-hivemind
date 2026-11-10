import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

// A small DOM surface runs the shipped browser script and its real event handlers.
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, (event: any) => unknown>();
  parent: Element | null = null;
  hidden = false;
  disabled = false;
  className = '';
  type = '';
  private text = '';
  private currentValue = '';
  constructor(readonly tagName: string, readonly id = '') {}
  set innerHTML(_value: string) { throw new Error('Untrusted HTML must not be inserted'); }
  set textContent(value: string) { this.text = String(value); this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set value(value: string) { this.currentValue = value; }
  get value(): string { return this.currentValue || (this.tagName === 'select' ? this.children[0]?.value || '' : ''); }
  get firstChild() { return this.children[0]!; }
  get lastChild() { return this.children.at(-1)!; }
  append(...elements: Element[]) { for (const element of elements) { element.parent = this; this.children.push(element); } }
  replaceChildren(...elements: Element[]) { this.children = []; this.text = ''; this.append(...elements); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(_name: string, _value: string) {}
  focus() {}
  reset() {}
  addEventListener(name: string, listener: (event: any) => unknown) { this.listeners.set(name, listener); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [
      ...(selector === 'button' ? child.tagName === 'button' : child.className.split(' ').includes(selector.slice(1))) ? [child] : [],
      ...child.querySelectorAll(selector)
    ]);
  }
  async dispatch(name: string, extra: Record<string, unknown> = {}) {
    await this.listeners.get(name)?.({ preventDefault() {}, ...extra });
  }
}

const repository = { id: 'cloudflare', name: 'fixture', baseCommit: 'a'.repeat(40), testProfile: 'default', testCommand: ['node', '--test'] };
const ready = { status: 'ready', message: null, checkedAt: '2026-11-10T00:00:00Z' };
const remote = { phase: 'RUNNING', jobId: 'job-1', inputSnapshotId: 'input-1', outputSnapshotId: null, containerStopped: false, authSynced: false, agent: null, checks: [], errorCode: null };
const cloudTask = { id: 'cf-task-1', title: 'remote task', instructions: 'change safely', provider: 'codex', runtime: 'cloudflare', status: 'running', remote, execution: null, actualCostMicros: null, estimatedCostMicros: null, budgetMicros: 0, repositoryId: repository.id, baseCommit: repository.baseCommit, testProfile: 'default', workerId: null, updatedAt: '2026-11-10T00:00:00Z', summary: null, diff: null, diffTruncated: false, worktreePath: null };

async function dashboard() {
  const [html, script] = await Promise.all([
    readFile(new URL('../apps/dashboard/public/index.html', import.meta.url).pathname.replace('/dist/', '/'), 'utf8'),
    readFile(new URL('../apps/dashboard/public/app.js', import.meta.url).pathname.replace('/dist/', '/'), 'utf8')
  ]);
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) elements.set(match[2]!, new Element(match[1]!, match[2]!));
  const get = (id: string) => { const element = elements.get(id); assert.ok(element, id); return element; };
  get('operator-token').value = 'operator-only';
  get('task-provider').append(Object.assign(new Element('option'), { value: 'mock' }));
  get('task-runtime').append(Object.assign(new Element('option'), { value: 'local' }), Object.assign(new Element('option'), { value: 'cloudflare' }));
  get('decision-form').append(get('approve-button'), get('reject-button'), get('cancel-button'));
  const calls: { path: string; body: any; authorization: string }[] = [];
  let capabilities: any = { providers: ['mock', 'codex', 'claude'], repository: { ...repository, id: 'local' }, cloudflare: { providers: ['codex', 'claude'], repository, connection: ready } };
  let snapshot: any = { tasks: [], events: [], workers: [], cloudflare: { tasks: [cloudTask], events: [], connection: ready } };
  let rejectPost = false;
  const context = createContext({
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), addEventListener() {}, hidden: false },
    AbortSignal, setInterval() {},
    fetch: async (path: string, options: any) => {
      calls.push({ path, body: options.body ? JSON.parse(options.body) : undefined, authorization: options.headers.Authorization });
      if (options.body && rejectPost) return { ok: false, json: async () => ({ message: 'Cloudflare 연결 오류' }) };
      return { ok: true, json: async () => path === '/api/state' ? snapshot : path === '/api/capabilities' ? capabilities : cloudTask };
    }
  });
  runInContext(script, context);
  const refresh = async () => { await runInContext('refresh()', context); };
  // The script starts its first asynchronous refresh itself.
  await new Promise(resolve => setImmediate(resolve));
  return { get, calls, refresh, run: (source: string) => runInContext(source, context), rejectPosts: () => { rejectPost = true; }, setCapabilities: (value: any) => { capabilities = value; }, setSnapshot: (value: any) => { snapshot = value; } };
}

test('dashboard defaults to local mock, merges remote tasks, and preserves runtime/provider while polling', async () => {
  const ui = await dashboard();
  assert.equal(ui.get('task-runtime').value, 'local');
  assert.equal(ui.get('task-provider').value, 'mock');
  assert.match(ui.get('task-list').textContent, /remote task/);
  ui.get('task-runtime').value = 'cloudflare';
  await ui.get('task-runtime').dispatch('change');
  assert.deepEqual(ui.get('task-provider').children.map(option => option.value), ['codex', 'claude']);
  ui.get('task-provider').value = 'claude';
  await ui.get('task-provider').dispatch('change');
  await ui.refresh();
  assert.equal(ui.get('task-runtime').value, 'cloudflare');
  assert.equal(ui.get('task-provider').value, 'claude');
  assert.equal(ui.get('create-route').textContent, 'claude / cloudflare');
  ui.get('task-runtime').value = 'local'; await ui.get('task-runtime').dispatch('change');
  assert.equal(ui.get('task-provider').value, 'mock');
  ui.get('task-runtime').value = 'cloudflare'; await ui.get('task-runtime').dispatch('change');
  assert.equal(ui.get('task-provider').value, 'claude');
});

test('the optional cloud contract keeps existing local mock creation intact', async () => {
  const ui = await dashboard();
  ui.setCapabilities({ providers: ['mock'], repository: null });
  ui.setSnapshot({ tasks: [], workers: [], events: [] }); await ui.refresh();
  assert.equal(ui.get('create-submit').disabled, false);
  ui.get('task-title').value = 'local'; ui.get('task-instructions').value = 'mock'; ui.get('task-budget').value = '0.01';
  await ui.get('create-form').dispatch('submit');
  const created = ui.calls.find(call => call.path === '/api/tasks');
  assert.ok(created); assert.equal(created.body.provider, 'mock'); assert.equal(created.body.runtime, 'local');
});

test('remote creation and human actions use only the local operator remote endpoints', async () => {
  const ui = await dashboard();
  ui.get('task-runtime').value = 'cloudflare';
  await ui.get('task-runtime').dispatch('change');
  ui.get('task-title').value = 'goal'; ui.get('task-instructions').value = 'conditions'; ui.get('task-budget').value = '0';
  await ui.get('create-form').dispatch('submit');
  const created = ui.calls.find(call => call.path === '/api/cloudflare/tasks');
  assert.ok(created); assert.equal(created.authorization, 'Bearer operator-only');
  assert.equal(created.body.runtime, 'cloudflare'); assert.equal(created.body.repositoryId, 'cloudflare');
  assert.equal(created.body.baseCommit, repository.baseCommit);
  for (const decision of ['approve', 'cancel']) {
    ui.get('decision-reason').value = 'reviewed';
    await ui.get('decision-form').dispatch('submit', { submitter: { value: decision } });
    assert.ok(ui.calls.some(call => call.path === '/api/cloudflare/tasks/cf-task-1/' + (decision === 'cancel' ? 'cancel' : 'decision')));
  }
  assert.ok(ui.calls.every(call => call.path.startsWith('/api/')));
  assert.ok(!ui.calls.some(call => call.path === '/api/tasks'));
});

test('unavailable cloud remains selected and cannot silently register a local task', async () => {
  const ui = await dashboard();
  ui.get('task-runtime').value = 'cloudflare'; await ui.get('task-runtime').dispatch('change');
  ui.setCapabilities({ providers: ['mock'], repository: null });
  ui.setSnapshot({ tasks: [], workers: [], events: [] });
  await ui.refresh();
  assert.equal(ui.get('task-runtime').value, 'cloudflare');
  assert.equal(ui.get('create-submit').disabled, true);
  ui.get('task-title').value = 'goal'; ui.get('task-instructions').value = 'conditions'; ui.get('task-budget').value = '0';
  await ui.get('create-form').dispatch('submit');
  assert.ok(!ui.calls.some(call => call.body));
  assert.match(ui.get('error-banner').textContent, /Cloudflare/);
});

test('remote HTTP failure stays on the chosen runtime and never retries through the local queue', async () => {
  const ui = await dashboard();
  ui.get('task-runtime').value = 'cloudflare'; await ui.get('task-runtime').dispatch('change');
  ui.get('task-title').value = 'goal'; ui.get('task-instructions').value = 'conditions'; ui.get('task-budget').value = '0';
  ui.rejectPosts(); await ui.get('create-form').dispatch('submit');
  assert.equal(ui.get('task-runtime').value, 'cloudflare');
  assert.match(ui.get('error-banner').textContent, /Cloudflare/);
  assert.deepEqual(ui.calls.filter(call => call.body).map(call => call.path), ['/api/cloudflare/tasks']);
});

test('remote evidence distinguishes cancellation pending, missing checks, failure and review without local execution', async () => {
  const ui = await dashboard();
  const process = { status: 'passed', exitCode: 0, durationMs: 1234, stdout: '<img src=x onerror=alert(1)>', stderr: '', truncated: false };
  const evidence = { ...remote, phase: 'CANCELLING', agent: process, checks: [{ id: 'unit', name: 'Unit', command: ['node', '--test'], status: 'SUCCEEDED', process, credentialsAbsent: true, sourceUnchanged: true }, { id: 'missing', name: 'Missing', command: ['node', 'check'], status: 'PENDING', process: null, credentialsAbsent: null, sourceUnchanged: null }] };
  const show = async (task: any) => { ui.setSnapshot({ tasks: [], workers: [], events: [], cloudflare: { tasks: [task], events: [], connection: ready } }); await ui.refresh(); ui.run("selectTask('cf-task-1')"); };
  await show({ ...cloudTask, remote: evidence, diffTruncated: true, diff: 'actual patch' });
  assert.equal(ui.get('execution-section').hidden, true);
  assert.equal(ui.get('remote-execution-section').hidden, false);
  assert.match(ui.get('selected-status').textContent, /확인 중/);
  assert.equal(ui.get('remote-phase').textContent, '중단 확인 중');
  assert.equal(ui.get('remote-phase').dataset.phase, 'CANCELLING');
  assert.match(ui.get('remote-agent-stdout').textContent, /<img/);
  assert.match(ui.get('remote-checks').textContent, /node.*--test/);
  assert.match(ui.get('remote-checks').textContent, /1.23초/);
  assert.match(ui.get('remote-checks').textContent, /아직 보고되지 않음/);
  assert.match(ui.get('remote-checks').textContent, /검증 완료/);
  assert.match(ui.get('remote-checks').textContent, /대기 중/);
  assert.ok(!ui.get('remote-checks').textContent.includes('SUCCEEDED'));
  assert.equal(ui.get('diff-truncated').hidden, false);
  await show({ ...cloudTask, status: 'failed', remote: { ...remote, phase: 'FAILED', errorCode: 'CHECK_FAILED' } });
  assert.equal(ui.get('decision-panel').hidden, true);
  assert.equal(ui.get('remote-phase').textContent, '실패');
  await show({ ...cloudTask, status: 'awaiting_review', remote: { ...remote, phase: 'SUCCEEDED', containerStopped: true, authSynced: true } });
  assert.equal(ui.get('approve-button').hidden, false); assert.equal(ui.get('approve-button').textContent, '결과 수락');
  assert.equal(ui.get('remote-phase').textContent, '검증 완료');
  await show({ ...cloudTask, status: 'cancelled', remote: { ...remote, phase: 'CANCELLED', containerStopped: true } });
  assert.equal(ui.get('selected-status').textContent, '중단'); assert.equal(ui.get('decision-panel').hidden, true);
});
