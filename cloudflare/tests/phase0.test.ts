import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, requiredChecks, requiredChecksFor } from '../scripts/phase0/gate.ts';
import { collectLocal } from '../scripts/phase0/collect.ts';

test('Cloudflare feasibility is evaluated without an AWS identity prerequisite', () => {
  const cloudflareChecks = [
    'local-tools', 'cloudflare-identity', 'cloudflare-network',
    'codex-cloudflare', 'claude-cloudflare', 'codex-subagents',
    'claude-subagents', 'mcp-cloudflare', 'credential-isolation', 'sandbox-cloudflare',
  ].map(id => ({ id, status: 'PASS' as const }));
  assert.equal(evaluateGate(cloudflareChecks, 'cloudflare').status, 'PASS');
});

test('Cloudflare success does not satisfy the later AWS gate', () => {
  assert.equal(evaluateGate(requiredChecks.map(id => ({ id, status: 'PASS' })), 'aws').status, 'BLOCKED');
  assert.equal(evaluateGate(requiredChecksFor('aws').map(id => ({ id, status: 'PASS' })), 'aws').status, 'PASS');
});

test('Cloudflare preflight requires the explicitly selected company account and never calls AWS', async () => {
  const calls: string[] = [];
  const run = async (bin: string, args: string[]) => {
    calls.push(bin);
    return { ok: true, stdout: bin === 'wrangler' && args[0] === 'whoami'
      ? JSON.stringify({ loggedIn: true, accounts: [{ id: 'fixture-account', name: 'Company' }] })
      : '24.14.0' };
  };
  const selected = await collectLocal({ account: 'Company' }, run);
  assert.equal(selected.checks.find(c => c.id === 'cloudflare-identity')!.status, 'PASS');
  const missing = await collectLocal({}, run);
  assert.equal(missing.checks.find(c => c.id === 'cloudflare-identity')!.status, 'BLOCKED');
  const different = await collectLocal({ account: 'Other' }, run);
  assert.equal(different.checks.find(c => c.id === 'cloudflare-identity')!.status, 'BLOCKED');
  assert.equal(calls.includes('aws'), false);
  assert.equal(selected.gate.status, 'BLOCKED');
});

test('local prerequisites cannot pass the Cloudflare feasibility gate', () => {
  const result = evaluateGate([{ id: 'local-tools', status: 'PASS' }]);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('codex-cloudflare'));
});

test('all required real environment checks must pass', () => {
  assert.deepEqual(evaluateGate(requiredChecks.map(id => ({ id, status: 'PASS' }))), {
    status: 'PASS', blockers: [],
  });
});

test('a duplicate success cannot hide a failed check', () => {
  const result = evaluateGate([
    ...requiredChecks.map(id => ({ id, status: 'PASS' as const })),
    { id: 'credential-isolation', status: 'FAIL' },
  ]);
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.blockers, ['credential-isolation']);
});

test('not run is not evidence of passing', () => {
  const result = evaluateGate(requiredChecks.map(id => ({
    id, status: id === 'sandbox-cloudflare' ? 'NOT_RUN' : 'PASS',
  })));
  assert.equal(result.status, 'BLOCKED');
});

test('no AWS selection means no default or guessed account request', async () => {
  const calls: string[][] = [];
  const report = await collectLocal({ backend: 'aws' }, async (bin: string, args: string[]) => {
    calls.push([bin, ...args]);
    return { ok: true, stdout: '1.2.3', stderr: '' };
  });
  assert.equal(calls.some(call => call[0] === 'aws' && call[1] !== '--version'), false);
  assert.equal(report.checks.find(c => c.id === 'aws-identity')!.status, 'BLOCKED');
  assert.equal(report.gate.status, 'BLOCKED');
});

test('unsupported Node version blocks local readiness', async () => {
  const report = await collectLocal({}, async (bin: string) => ({
    ok: true, stdout: bin === 'node' ? 'v22.8.0' : '29.8.0',
  }));
  assert.equal(report.checks.find(c => c.id === 'local-tools')!.status, 'FAIL');
});

test('supported Node version and a live Docker engine pass local readiness only', async () => {
  const report = await collectLocal({}, async (bin: string) => ({
    ok: true, stdout: bin === 'node' ? 'v24.14.0' : '29.8.0',
  }));
  assert.equal(report.checks.find(c => c.id === 'local-tools')!.status, 'PASS');
  assert.equal(report.gate.status, 'BLOCKED');
});

test('AWS identity must contain a matching account ARN', async () => {
  const report = await collectLocal({ backend: 'aws', profile: 'chosen', region: 'ap-northeast-2' }, async (bin, args) => ({
    ok: true,
    stdout: bin === 'aws' && args[0] === 'sts'
      ? JSON.stringify({ Account: '123456789012', Arn: 'not-an-arn' })
      : '24.14.0',
  }));
  assert.equal(report.checks.find(c => c.id === 'aws-identity')!.status, 'FAIL');
});

test('selected AWS target is explicit and raw identity fields are not published', async () => {
  const calls: string[][] = [];
  const report = await collectLocal({ backend: 'aws', profile: 'chosen', region: 'ap-northeast-2' }, async (bin, args) => {
    calls.push([bin, ...args]);
    return { ok: true, stdout: bin === 'aws' && args[0] === 'sts'
      ? JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/example/private-session' })
      : '24.14.0' };
  });
  assert.deepEqual(calls.find(call => call[1] === 'sts'), [
    'aws', 'sts', 'get-caller-identity', '--profile', 'chosen', '--region',
    'ap-northeast-2', '--output', 'json', '--no-cli-pager',
  ]);
  assert.equal(report.checks.find(c => c.id === 'aws-identity')!.status, 'PASS');
  assert.equal(JSON.stringify(report).includes('123456789012'), false);
  assert.equal(JSON.stringify(report).includes('private-session'), false);
  assert.equal(report.gate.status, 'BLOCKED');
});

test('failed commands do not leak credentials through diagnostics', async () => {
  const secret = 'fixture-secret-do-not-publish';
  const report = await collectLocal({ backend: 'aws', profile: 'chosen', region: 'ap-northeast-2' }, async () => {
    throw new Error(secret);
  });
  assert.equal(report.checks.find(c => c.id === 'local-tools')!.status, 'FAIL');
  assert.equal(report.checks.find(c => c.id === 'aws-identity')!.status, 'BLOCKED');
  assert.equal(JSON.stringify(report).includes(secret), false);
});
