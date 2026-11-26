import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext, runInContext} from 'node:vm';

class Element {
  children: Element[] = []; className = ''; type = ''; disabled = false; private text = ''; listeners = new Map<string, () => unknown>();
  constructor(readonly tagName: string) {}
  set innerHTML(_v: string) { throw new Error('Untrusted HTML must not be inserted'); }
  set textContent(v: string) { this.text = String(v); this.children = []; }
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
  append(...e: Element[]) { this.children.push(...e); }
  replaceChildren(...e: Element[]) { this.children = []; this.text = ''; this.append(...e); }
  addEventListener(n: string, l: () => unknown) { this.listeners.set(n, l); }
  find(tag: string): Element[] { return this.children.flatMap(c => [...(c.tagName === tag ? [c] : []), ...c.find(tag)]); }
}
async function load() {
  const script = await readFile(new URL('../apps/dashboard/public/tool-audit.js', import.meta.url).pathname.replace('/dist/', '/'), 'utf8');
  const context: any = createContext({document: {createElement: (t: string) => new Element(t)}, encodeURIComponent, Number, String, Date, Array});
  runInContext(script, context);
  return context as {renderToolAudit(c: Element, p: unknown, more?: (cursor: string) => unknown): void; loadToolAudit(c: Element, id: string, f: (p: string) => Promise<unknown>, cursor?: string): Promise<void>};
}
const item = (n: number, extra: Record<string, unknown> = {}) => ({sequence: n, tool: 'Bash', inputDigest: 'a'.repeat(64), inputSummary: 'ls', inputTruncated: false, outcome: 'allowed', startedAt: 5, durationMs: 1, runId: 'r1', iteration: 1, receivedAt: 9, source: 'worker_report', ...extra});
const totals = {recorded: 2, denied: 1, errors: 0, droppedByWorker: 3, droppedByStore: 4};

test('server values render as text only and the panel says it is a worker report', async () => {
  const ui = await load(), box = new Element('div');
  ui.renderToolAudit(box, {items: [item(1, {inputSummary: '<img src=x onerror=alert(1)>', tool: '<b>x</b>', outcome: 'denied', durationMs: null, inputTruncated: true})], totals});
  assert.ok(box.textContent.includes('<img src=x onerror=alert(1)>') && box.textContent.includes('<b>x</b>'));
  assert.match(box.textContent, /독립 증명이 아닙니다/);
  assert.match(box.textContent, /거부/); assert.match(box.textContent, /소요 시간 미기록/); assert.match(box.textContent, /잘림/);
  assert.match(box.textContent, /워커가 버린 기록 3건/); assert.match(box.textContent, /저장소가 버린 기록 4건/);
});
test('unknown totals are not shown as zero and invalid payload shows an error', async () => {
  const ui = await load(), box = new Element('div');
  ui.renderToolAudit(box, {items: [], totals: {recorded: null}}); assert.match(box.textContent, /확인 필요/); assert.match(box.textContent, /기록이 없습니다/);
  ui.renderToolAudit(box, {nope: 1}); assert.match(box.textContent, /불러오지 못했습니다/);
});
test('more button requests the next cursor once', async () => {
  const ui = await load(), box = new Element('div'), seen: string[] = [];
  ui.renderToolAudit(box, {items: [item(1)], totals, nextCursor: 'c1.sig'}, c => { seen.push(c); });
  const button = box.find('button')[0]!; await button.listeners.get('click')!(); assert.deepEqual(seen, ['c1.sig']); assert.equal(button.disabled, true);
});
test('loadToolAudit builds a bounded path, follows cursors and fails closed', async () => {
  const ui = await load(), box = new Element('div'), paths: string[] = [];
  const fetchJson = async (p: string) => { paths.push(p); return {items: [item(paths.length)], totals, ...(paths.length === 1 ? {nextCursor: 'c1.sig'} : {})}; };
  await ui.loadToolAudit(box, 'autonomous-1', fetchJson);
  await box.find('button')[0]!.listeners.get('click')!();
  assert.deepEqual(paths, ['/api/cloudflare/autonomous-tasks/autonomous-1/tool-calls?limit=20', '/api/cloudflare/autonomous-tasks/autonomous-1/tool-calls?limit=20&cursor=c1.sig']);
  await ui.loadToolAudit(box, '../x', fetchJson); assert.equal(paths.length, 2); assert.match(box.textContent, /불러오지 못했습니다/);
  await ui.loadToolAudit(box, 'a', async () => { throw new Error('OPERATOR_CANARY'); }); assert.ok(!box.textContent.includes('OPERATOR_CANARY'));
});
