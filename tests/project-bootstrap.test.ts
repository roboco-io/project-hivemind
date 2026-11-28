import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import {
  formatProjectBootstrapReport,
  runProjectBootstrap,
  type ProjectBootstrapManifest,
  type ProjectBootstrapSystem,
} from '../scripts/lib/project-bootstrap.js';

const OP = 'op-bootstrap-token-1234567890123456';
const WK = 'wk-bootstrap-token-1234567890123456';

function createRealFsSystem(fetchImpl: typeof fetch): ProjectBootstrapSystem {
  return {
    fetchImpl,
    fileExists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf8');
    },
    writeSecretFile: (p, content) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content, { encoding: 'utf8', mode: 0o600 });
      chmodSync(p, 0o600);
    },
  };
}

function makeManifest(overrides: Partial<ProjectBootstrapManifest> = {}): ProjectBootstrapManifest {
  return {
    id: 'silicon-mf',
    name: 'Silicon Model Factory',
    template: 'model-factory',
    repositories: ['roboco-io/silicon-model-factory'],
    autoMerge: true,
    budgetUsd: 25,
    maxJobUsd: 5,
    regions: ['us-east-2', 'us-east-1'],
    hfAutoPublishPrefixes: ['roboco-io/'],
    ...overrides,
  };
}

test('project:bootstrap --dry-run makes zero network or filesystem writes and outputs manual checklist', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-proj-dry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let fetchCalls = 0;
  const writes: string[] = [];

  const res = await runProjectBootstrap(
    {
      manifest: makeManifest(),
      apiUrl: 'http://127.0.0.1:4310',
      operatorToken: OP,
      tokenOutputFile: join(dir, 'secrets', 'silicon-mf.json'),
      issueToken: true,
      rotateToken: false,
      withTrigger: true,
      targetDir: join(dir, 'repo'),
      hivemindRoot: '/opt/hivemind',
      force: false,
      dryRun: true,
    },
    {
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error('dry-run must not call fetch');
      }) as typeof fetch,
      fileExists: () => false,
      readFile: () => {
        throw new Error('not called');
      },
      writeFile: (p) => writes.push(p),
      writeSecretFile: (p) => writes.push(p),
    },
  );

  assert.equal(fetchCalls, 0);
  assert.deepEqual(writes, []);
  assert.ok(res.results.some((r) => r.status === 'planned' && r.step.includes('Control Plane')));
  assert.ok(res.results.some((r) => r.status === 'planned' && r.step.includes('토큰')));
  assert.ok(res.results.some((r) => r.status === 'planned' && r.step.includes('트리거')));
  assert.ok(res.results.some((r) => r.status === 'planned' && r.step.includes('스캐폴딩')));
  assert.ok(res.manualChecklist.some((c) => c.includes('roboco-io/silicon-model-factory')));
  assert.ok(res.manualChecklist.some((c) => c.includes('Hugging Face')));
  assert.ok(res.manualChecklist.some((c) => c.includes('silicon-mf-loop')));
});

test('project:bootstrap registers project, writes 0600 token, registers disabled trigger, scaffolds repo, and is idempotent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hm-proj-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const app = buildApp({ operatorToken: OP, workerToken: WK });
  t.after(() => app.close());

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: `${url.pathname}${url.search}`,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  };

  const tokenFile = join(dir, 'secrets', 'silicon-mf.json');
  const repoDir = join(dir, 'silicon-model-factory');
  const sys = createRealFsSystem(fetchImpl);

  const first = await runProjectBootstrap(
    {
      manifest: makeManifest(),
      apiUrl: 'http://127.0.0.1:4310',
      operatorToken: OP,
      tokenOutputFile: tokenFile,
      issueToken: true,
      rotateToken: false,
      withTrigger: true,
      targetDir: repoDir,
      hivemindRoot: '/opt/hivemind',
      force: false,
      dryRun: false,
    },
    sys,
  );

  assert.equal(first.project?.id, 'silicon-mf');
  assert.equal(first.project?.budget.computeBudgetCapMicros, 25_000_000);
  assert.equal(first.project?.budget.maxSingleJobCostMicros, 5_000_000);

  // Token file exists with 0600 permissions and works against /api/projects/me, while never appearing in the text report.
  const tokenJson = JSON.parse(readFileSync(tokenFile, 'utf8')) as { PROJECT_ID: string; AGENT_TOKEN: string; TOKEN_ID: string };
  assert.equal(tokenJson.PROJECT_ID, 'silicon-mf');
  assert.match(tokenJson.AGENT_TOKEN, /^hmproj_/);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  const reportText = formatProjectBootstrapReport(first.results, first.manualChecklist);
  assert.equal(reportText.includes(tokenJson.AGENT_TOKEN), false, 'bootstrap report must never print the raw token');

  const meRes = await app.inject({
    method: 'GET',
    url: '/api/projects/me',
    headers: { authorization: `Bearer ${tokenJson.AGENT_TOKEN}` },
  });
  assert.equal(meRes.statusCode, 200);
  assert.equal(meRes.json().project.id, 'silicon-mf');

  // Autonomy trigger was created in disabled state for safety.
  const trigRes = await app.inject({
    method: 'GET',
    url: '/api/autonomy/triggers?projectId=silicon-mf',
    headers: { authorization: `Bearer ${OP}` },
  });
  assert.equal(trigRes.statusCode, 200);
  const trigger = (trigRes.json().triggers as Array<{ id: string; enabled: boolean; projectId?: string }>).find(
    (t) => t.id === 'silicon-mf-loop',
  );
  assert.ok(trigger);
  assert.equal(trigger.enabled, false);
  assert.equal(trigger.projectId, 'silicon-mf');

  // Scaffolded repo files exist and point MCP to the project-agent profile & token file.
  const mcpJson = JSON.parse(readFileSync(join(repoDir, '.mcp.json'), 'utf8'));
  assert.equal(mcpJson.mcpServers.hivemind.env.HIVEMIND_MCP_PROFILE, 'project-agent');
  assert.equal(mcpJson.mcpServers.hivemind.env.HIVEMIND_AGENT_TOKEN_FILE, tokenFile);
  assert.match(readFileSync(join(repoDir, '.codex/config.toml'), 'utf8'), /HIVEMIND_MCP_PROFILE = "project-agent"/);
  const manifestJson = JSON.parse(readFileSync(join(repoDir, 'hivemind.project.json'), 'utf8'));
  assert.equal(manifestJson.id, 'silicon-mf');
  assert.equal(manifestJson.budgetUsd, 25);

  // Customize ops/autonomy/state.json and re-run without --force / --rotate-token: idempotent update preserves both.
  const statePath = join(repoDir, 'ops/autonomy/state.json');
  writeFileSync(statePath, JSON.stringify({ version: 1, projectId: 'silicon-mf', stage: 'training', cycle: 4 }), 'utf8');

  const second = await runProjectBootstrap(
    {
      manifest: makeManifest({ budgetUsd: 40 }),
      apiUrl: 'http://127.0.0.1:4310',
      operatorToken: OP,
      tokenOutputFile: tokenFile,
      issueToken: true,
      rotateToken: false,
      withTrigger: true,
      targetDir: repoDir,
      hivemindRoot: '/opt/hivemind',
      force: false,
      dryRun: false,
    },
    sys,
  );

  assert.equal(second.project?.budget.computeBudgetCapMicros, 40_000_000);
  assert.equal(JSON.parse(readFileSync(tokenFile, 'utf8')).AGENT_TOKEN, tokenJson.AGENT_TOKEN, 'existing token preserved');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).stage, 'training', 'existing autonomy state preserved');
  assert.ok(second.results.some((r) => r.step.includes('토큰') && r.status === 'skipped'));
});
