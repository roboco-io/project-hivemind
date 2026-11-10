import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationScope, loadCloudflareConfig } from '../apps/control-plane/src/cloudflare-config.js';

const secret = 'test-only-control-token-sentinel';
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'hivemind-cloud-config-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const env: NodeJS.ProcessEnv = { HIVEMIND_CLOUDFLARE_URL: 'https://remote.example.invalid', HIVEMIND_CLOUDFLARE_CONTROL_TOKEN: secret, HIVEMIND_CLOUDFLARE_REPO_PATH: repo, HIVEMIND_CLOUDFLARE_WORKTREE_ROOT: join(root, 'worktrees'), HIVEMIND_CLOUDFLARE_CHECKS: JSON.stringify([{ id: 'unit', argv: ['node', '--test'], timeoutMs: 10000 }]) };
  return { root, repo, env, git };
}
const invalid = (env: NodeJS.ProcessEnv) => assert.throws(() => loadCloudflareConfig(env), { message: 'Invalid Cloudflare dashboard configuration.' });

test('absent remote settings retain mock/local configuration; a remote-only repository pins HEAD and checks', t => {
  assert.equal(loadCloudflareConfig({ HIVEMIND_REPO_PATH: '/not-used' }), undefined);
  const f = fixture(t); const config = loadCloudflareConfig(f.env)!;
  assert.equal(config.baseUrl, 'https://remote.example.invalid/');
  assert.equal(config.policy.id, 'cloudflare'); assert.equal(config.policy.baseCommit, f.git(['rev-parse', 'HEAD']));
  assert.deepEqual(config.policy.testCommand, ['node', '--test']);
  assert.deepEqual(config.credentialIds, { codex: 'codex-remote', claude: 'claude-remote' });
  assert.equal(config.timeoutMs, 600000); assert.equal(config.controlToken, secret);
  assert.ok(!JSON.stringify(config.policy).includes(f.root));
});

test('partial settings, unsafe URLs, arbitrary Git subdirectories and malformed checks fail with one scrubbed error', t => {
  const f = fixture(t); mkdirSync(join(f.repo, 'sub'));
  invalid({ HIVEMIND_CLOUDFLARE_URL: secret });
  for (const url of ['http://remote.example.invalid', 'https://user:secret@remote.example.invalid', 'https://remote.example.invalid/path', 'https://remote.example.invalid/?token=' + secret]) invalid({ ...f.env, HIVEMIND_CLOUDFLARE_URL: url });
  invalid({ ...f.env, HIVEMIND_CLOUDFLARE_REPO_PATH: join(f.repo, 'sub') });
  invalid({ ...f.env, HIVEMIND_CLOUDFLARE_REPO_PATH: join(f.root, secret) });
  invalid({ ...f.env, HIVEMIND_CLOUDFLARE_WORKTREE_ROOT: 'relative-path' });
  for (const checks of ['not-json-' + secret, '[]', JSON.stringify([{ id: 'one', argv: ['node'], timeoutMs: 1 }]), JSON.stringify([{ id: 'one', argv: ['node'], timeoutMs: 1000, unexpected: secret }]), JSON.stringify([{ id: 'one', argv: ['node'], timeoutMs: 1000 }, { id: 'one', argv: ['node'], timeoutMs: 1000 }])]) invalid({ ...f.env, HIVEMIND_CLOUDFLARE_CHECKS: checks });
  invalid({ ...f.env, HIVEMIND_CLOUDFLARE_TIMEOUT_MS: '1000.1' });
  invalid({ ...f.env, HIVEMIND_CLOUDFLARE_CODEX_CREDENTIAL: 'unsafe/credential' });
});

test('0600 secrets files read CONTROL_TOKEN only and reject insecure modes, symlinks, duplicates or missing token', t => {
  const f = fixture(t); const file = join(f.root, 'secrets.json');
  const env = { ...f.env, HIVEMIND_CLOUDFLARE_CONTROL_TOKEN: undefined, HIVEMIND_CLOUDFLARE_SECRETS_FILE: file };
  writeFileSync(file, JSON.stringify({ CONTROL_TOKEN: secret, INTERNAL_TOKEN: 'never-forward', PROVIDER_CREDENTIAL: 'never-read' }), { mode: 0o600 });
  const config = loadCloudflareConfig(env)!; assert.equal(config.controlToken, secret); assert.ok(!JSON.stringify(config).includes('never-forward'));
  chmodSync(file, 0o644); invalid(env); chmodSync(file, 0o600);
  const link = join(f.root, 'linked'); symlinkSync(file, link); invalid({ ...env, HIVEMIND_CLOUDFLARE_SECRETS_FILE: link });
  writeFileSync(file, 'CONTROL_TOKEN="' + secret + '"\nOTHER_TOKEN=never-forward\n'); assert.equal(loadCloudflareConfig(env)!.controlToken, secret);
  writeFileSync(file, 'CONTROL_TOKEN=one\nCONTROL_TOKEN=two\n'); invalid(env);
  writeFileSync(file, JSON.stringify({ INTERNAL_TOKEN: secret })); invalid(env);
  invalid({ ...env, HIVEMIND_CLOUDFLARE_CONTROL_TOKEN: secret });
});

test('repository inspection gives Git only the environment allowlist and disables external Git configuration', t => {
  const f = fixture(t); const bin = join(f.root, 'bin'); mkdirSync(bin);
  const capture = join(f.root, 'git-environment.jsonl');
  const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), '#!' + process.execPath + '\n' +
    'const fs = require("node:fs"), cp = require("node:child_process");\n' +
    'fs.appendFileSync(' + JSON.stringify(capture) + ', JSON.stringify(process.env) + "\\n");\n' +
    'process.stdout.write(cp.execFileSync(' + JSON.stringify(actualGit) + ', process.argv.slice(2), {env:process.env}));\n', { mode: 0o700 });
  const secrets = ['HIVEMIND_CLOUDFLARE_CONTROL_TOKEN', 'HIVEMIND_OPERATOR_TOKEN', 'HIVEMIND_WORKER_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const previous = new Map(['PATH', ...secrets].map(key => [key, process.env[key]]));
  try {
    process.env.PATH = bin + ':' + process.env.PATH;
    for (const key of secrets) process.env[key] = 'must-not-reach-git';
    assert.ok(loadCloudflareConfig(f.env));
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const environments = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line) as NodeJS.ProcessEnv);
  assert.equal(environments.length, 3);
  for (const env of environments) {
    for (const key of secrets) assert.equal(env[key], undefined, key);
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null'); assert.equal(env.GIT_CONFIG_SYSTEM, '/dev/null'); assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.ok(!JSON.stringify(env).includes('must-not-reach-git'));
  }
});

test('private configuration scope excludes rotated control tokens and binds every execution setting', t => {
  const f = fixture(t); const config = loadCloudflareConfig(f.env)!;
  const scope = configurationScope(config);
  assert.match(scope, /^[a-f0-9]{64}$/);
  assert.equal(configurationScope({ ...config, controlToken: 'rotated-private-token' }), scope);
  for (const changed of [
    { ...config, baseUrl: 'https://other.example.invalid/' },
    { ...config, checks: [...config.checks, { id: 'second', argv: ['node', 'other-test'], timeoutMs: 1000 }] },
    { ...config, credentialIds: { ...config.credentialIds, codex: 'another-stream' } },
    { ...config, repositoryPath: join(f.root, 'another-repo') },
    { ...config, worktreeRoot: join(f.root, 'another-worktrees') },
    { ...config, policy: { ...config.policy, baseCommit: 'b'.repeat(40) } },
    { ...config, timeoutMs: 1000 }
  ]) assert.notEqual(configurationScope(changed), scope);
});

test('a required check cannot persist the configured control token in its command', t => {
  const f = fixture(t);
  invalid({ ...f.env, HIVEMIND_CLOUDFLARE_CHECKS: JSON.stringify([{ id: 'unit', argv: ['node', '--token=' + secret], timeoutMs: 1000 }]) });
});
