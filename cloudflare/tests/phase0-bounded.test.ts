import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBounded } from '../scripts/phase0/run-bounded.ts';

test('bounded process captures actual stdout and stderr without a shell', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write("fixture-out\\n"); process.stderr.write("fixture-err")'], { cwd: process.cwd(), env: {}, timeoutMs: 2000, maxBytes: 4096 });
  assert.equal(result.stdout, 'fixture-out\n');
  assert.equal(result.stderr, 'fixture-err');
  assert.equal(result.exitCode, 0);
});

test('deadline terminates a process before its natural completion', async () => {
  const result = await runBounded(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),1000)'], { cwd: process.cwd(), env: {}, timeoutMs: 100, maxBytes: 4096 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test('captured output cannot exceed its byte budget', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(8192))'], { cwd: process.cwd(), env: {}, timeoutMs: 2000, maxBytes: 128 });
  assert.equal(result.captureLimit, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 128);
});
