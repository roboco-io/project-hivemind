import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import { buildWorkerCliCommand } from '../apps/worker/src/aws-worker-policy.js';
import { buildModelUsageReport, readCodexSessionUsage } from '../apps/worker/src/model-usage.js';
import { computeAcceptanceTestDigest } from '../packages/core/src/delivery.js';

const OP = 'operator-usage-test-token-0000000001';
const WK = 'worker-usage-test-token-00000000002';
const BASE = 'a'.repeat(40);

function payload() {
  const files = [{ path: 'tests/acceptance.test.ts', sha256: 'd'.repeat(64) }];
  const testCommand = ['npm', 'test'];
  return {
    title: 'usage', instructions: 'do it', provider: 'codex', maxIterations: 2, budgetMicros: 0,
    acceptance: { baseCommit: BASE, files, testCommand, digest: computeAcceptanceTestDigest({ baseCommit: BASE, files, testCommand }) },
    delivery: { mode: 'draft_pr', repository: 'roboco-io/project-hivemind', baseBranch: 'main', branchPrefix: 'hivemind/', autoMerge: false },
  };
}

function sessionLog(home: string, name: string, lines: unknown[], mtime: number): void {
  const dir = join(home, 'sessions', '2026', '11', '28');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  utimesSync(path, mtime, mtime);
}

const tokenCount = (input: number, cached: number, output: number, reasoning: number) => ({
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output } } },
});

test('the worker reads cumulative codex usage from the newest session log, reasoning already in output', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hm-usage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(await readCodexSessionUsage(home), null, 'no session log');
  sessionLog(home, 'old.jsonl', [tokenCount(1, 0, 1, 0)], 1_000);
  sessionLog(home, 'new.jsonl', [
    { type: 'session_meta', payload: {} },
    tokenCount(30_000, 20_000, 500, 100),
    'not json token_count',
    { type: 'event_msg', payload: { type: 'token_count', info: null } },
    tokenCount(52_000, 41_000, 900, 210),
    { type: 'event_msg', payload: { type: 'agent_message' } },
  ], 2_000);
  assert.deepEqual(await readCodexSessionUsage(home), { inputTokens: 52_000, cachedInputTokens: 41_000, cacheWriteInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 210 });

  // A timed-out run still reports what the log has.
  const timedOut = await buildModelUsageReport({ provider: 'codex', codexHome: home, runId: 'run-1', iteration: 2, status: 'timed_out', durationMs: 3_600_000.4 });
  assert.equal(timedOut.outcome, 'timed_out');
  assert.equal(timedOut.source, 'codex_session_log');
  assert.equal(timedOut.outputTokens, 900);
  assert.equal(timedOut.durationMs, 3_600_000);
  // claude reports no usage here: counts are null, the run is still recorded.
  const claude = await buildModelUsageReport({ provider: 'claude', codexHome: home, runId: 'run-2', iteration: 1, status: 'error', durationMs: 5 });
  assert.equal(claude.outcome, 'aborted');
  assert.equal(claude.source, 'unavailable');
  assert.equal(claude.inputTokens, null);
});

test('codex keeps its session log so usage can be read, in the per-run CODEX_HOME', () => {
  const { cmd } = buildWorkerCliCommand({ provider: 'codex', cliBin: 'codex', workspacePath: '/w', lastMessageFile: '/w/../last.txt' });
  assert.equal(cmd.includes('--ephemeral'), false);
  assert.ok(cmd.includes('exec'));
});

test('only the worker of the active run records usage, and the task shows it to the operator', async (t) => {
  const app = buildApp({ operatorToken: OP, workerToken: WK });
  t.after(() => app.close());
  const call = (method: 'GET' | 'POST', url: string, token: string, body?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body ? { payload: body } : {}) });
  const created = (await call('POST', '/api/delivery/tasks', OP, payload())).json();
  await call('POST', `/api/delivery/tasks/${created.id}/approve`, OP, { approvalFingerprint: created.approvalFingerprint, reason: 'ok' });
  assert.equal((await call('POST', `/api/delivery/tasks/${created.id}/start`, WK, { workerId: 'w-1', runId: 'run-1' })).statusCode, 200);

  const report = { runId: 'run-1', iteration: 1, outcome: 'failed', inputTokens: 52_000, cachedInputTokens: 41_000, cacheWriteInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 210, source: 'codex_session_log', durationMs: 180_000 };
  assert.equal((await call('POST', `/api/delivery/tasks/${created.id}/model-usage`, OP, report)).statusCode, 401);
  assert.equal((await call('POST', `/api/delivery/tasks/${created.id}/model-usage`, WK, { ...report, runId: 'run-other' })).statusCode, 409);
  assert.equal((await call('POST', `/api/delivery/tasks/${created.id}/model-usage`, WK, { ...report, outputTokens: -1 })).statusCode, 400);
  assert.equal((await call('POST', `/api/delivery/tasks/${created.id}/model-usage`, WK, { ...report, outcome: 'great' })).statusCode, 400);
  const ok = await call('POST', `/api/delivery/tasks/${created.id}/model-usage`, WK, report);
  assert.equal(ok.statusCode, 200, ok.body);

  const got = (await call('GET', `/api/delivery/tasks/${created.id}`, OP)).json();
  assert.equal(got.task.modelUsage.length, 1);
  const usage = got.task.modelUsage[0];
  assert.equal(usage.provider, 'codex');
  assert.equal(usage.outcome, 'failed');
  assert.equal(usage.outputTokens, 900);
  assert.equal(usage.reasoningOutputTokens, 210);
  assert.ok(usage.recordedAt);
  assert.ok(got.events.some((e: { type: string }) => e.type === 'delivery.model_usage_recorded'));
});
