import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../apps/control-plane/src/app.js';
import { createHivemindMcpServer } from '../apps/mcp-server/src/server.js';
import type { CreateComputeJob } from '../packages/contracts/src/compute.js';
import type { CreateDeliveryTask } from '../packages/contracts/src/delivery.js';
import type { IssuedProjectToken, ProjectPublicView } from '../packages/contracts/src/projects.js';
import { computeAcceptanceTestDigest } from '../packages/core/src/delivery.js';

const OP = 'op-host-token-12345678901234567890';
const WK = 'wk-host-token-12345678901234567890';

const opHeaders = { authorization: `Bearer ${OP}` };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function computePayload(overrides: Partial<CreateComputeJob> = {}): CreateComputeJob {
  return {
    title: 'Spot training run',
    workloadId: 'wk-01',
    repository: 'org-a/repo-a',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 'g5.xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 600_000,
      maxHourlyPriceUsd: 0.4,
      maxTotalCostMicros: 150_000,
      s3ArtifactPrefix: 'projects/proj-a/wk-01/run-1',
    },
    releasePolicy: {
      mode: 's3_artifact_only',
      visibility: 'private',
      releaseCheckCommand: ['node', 'check.mjs'],
    },
    ...overrides,
  };
}

function deliveryPayload(repository: string, overrides: Partial<CreateDeliveryTask> = {}): CreateDeliveryTask {
  const baseCommit = 'b'.repeat(40);
  const files = [{ path: 'tests/a.test.ts', sha256: 'c'.repeat(64) }];
  const testCommand = ['npm', 'test'];
  return {
    title: 'Implement feature',
    instructions: 'Make tests pass.',
    provider: 'codex',
    maxIterations: 2,
    budgetMicros: 100_000,
    acceptance: { baseCommit, files, testCommand, digest: computeAcceptanceTestDigest({ baseCommit, files, testCommand }) },
    delivery: { mode: 'draft_pr', repository, baseBranch: 'main', branchPrefix: 'agent/', autoMerge: false },
    bundle: { baseCommit, bundleSha256: 'd'.repeat(64), sizeBytes: 512, fileCount: 1, s3Key: 'bundles/test.bundle' },
    spot: { maxSpotRetries: 1, checkpointFlushTimeoutMs: 60_000 },
    ...overrides,
  };
}

test('project CRUD, templates, scoped token lifecycle, secret hygiene, and pause enforcement', async (t) => {
  const app = buildApp({ operatorToken: OP, workerToken: WK });
  t.after(() => app.close());

  const tplRes = await app.inject({ method: 'GET', url: '/api/projects/templates', headers: opHeaders });
  assert.equal(tplRes.statusCode, 200);
  assert.ok(tplRes.json().templates['model-factory']);
  assert.ok(tplRes.json().templates['sw-delivery']);

  const list0 = await app.inject({ method: 'GET', url: '/api/projects', headers: opHeaders });
  assert.equal(list0.statusCode, 200);
  assert.deepEqual(list0.json().projects, []);

  // Invalid project ID is rejected.
  const badId = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: { id: 'BAD_ID!', name: 'Invalid' },
  });
  assert.equal(badId.statusCode, 400);

  // Create a hosted project from model-factory template.
  const createdRes = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: {
      id: 'silicon-mf',
      name: 'Silicon Model Factory',
      template: 'model-factory',
      delivery: { repositories: ['roboco-io/silicon-model-factory'] },
      budget: { computeBudgetCapMicros: 5_000_000, maxSingleJobCostMicros: 1_000_000 },
    },
  });
  assert.equal(createdRes.statusCode, 201);
  const created = createdRes.json() as ProjectPublicView;
  assert.equal(created.id, 'silicon-mf');
  assert.equal(created.status, 'active');
  assert.deepEqual(created.compute.s3ArtifactPrefixes, ['projects/silicon-mf/', 'models/']);

  // Duplicate ID fails with 409.
  const dup = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: { id: 'silicon-mf', name: 'Duplicate' },
  });
  assert.equal(dup.statusCode, 409);

  // Issue a project-scoped agent token: raw token returned once with Cache-Control: no-store.
  const issueRes = await app.inject({
    method: 'POST',
    url: '/api/projects/silicon-mf/tokens',
    headers: opHeaders,
    payload: { label: 'ci-agent' },
  });
  assert.equal(issueRes.statusCode, 201);
  assert.equal(issueRes.headers['cache-control'], 'no-store');
  const issued = issueRes.json() as IssuedProjectToken;
  assert.match(issued.token, /^hmproj_/);
  assert.equal(issued.metadata.label, 'ci-agent');

  // Raw token and hash never leak through list, detail, or /me endpoints.
  for (const url of ['/api/projects', '/api/projects/silicon-mf']) {
    const res = await app.inject({ method: 'GET', url, headers: opHeaders });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.includes(issued.token), false, `${url} must not leak raw token`);
    assert.equal(res.body.includes('tokenHash'), false, `${url} must not expose tokenHash`);
  }

  // Project token authenticates against /api/projects/me and cannot access operator-only /api/projects.
  const meRes = await app.inject({ method: 'GET', url: '/api/projects/me', headers: bearer(issued.token) });
  assert.equal(meRes.statusCode, 200);
  assert.equal(meRes.json().project.id, 'silicon-mf');
  assert.equal(meRes.body.includes(issued.token), false);
  const adminDenied = await app.inject({ method: 'GET', url: '/api/projects', headers: bearer(issued.token) });
  assert.equal(adminDenied.statusCode, 401);

  // Pausing the project immediately blocks token authentication; resuming restores it.
  const paused = await app.inject({
    method: 'PATCH',
    url: '/api/projects/silicon-mf',
    headers: opHeaders,
    payload: { status: 'paused' },
  });
  assert.equal(paused.statusCode, 200);
  assert.equal(paused.json().status, 'paused');
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/me', headers: bearer(issued.token) })).statusCode, 401);

  await app.inject({ method: 'PATCH', url: '/api/projects/silicon-mf', headers: opHeaders, payload: { status: 'active' } });
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/me', headers: bearer(issued.token) })).statusCode, 200);

  // Revoking the token immediately invalidates it.
  const revoked = await app.inject({
    method: 'DELETE',
    url: `/api/projects/silicon-mf/tokens/${issued.metadata.tokenId}`,
    headers: opHeaders,
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/projects/me', headers: bearer(issued.token) })).statusCode, 401);
});

test('strict cross-project isolation across compute, delivery, collab, and scoped AWS credentials', async (t) => {
  const minted: Array<{ policy: string; description: string }> = [];
  const app = buildApp({
    operatorToken: OP,
    workerToken: WK,
    agentCredentials: {
      region: 'ap-northeast-2',
      catalog: {
        enabledPurposes: ['spot-placement-read', 'project-inputs-upload', 'project-artifacts-read', 'model-inputs-upload'],
        artifactsBucket: 'hivemind-artifacts-test',
        artifactsKmsKeyArn: 'arn:aws:kms:ap-northeast-2:123456789012:key/11111111-2222-3333-4444-555555555555',
        allowedRegions: ['us-east-2', 'ap-northeast-2'],
      },
      issuer: {
        async issue(plan) {
          minted.push({ policy: plan.policy, description: plan.description });
          return {
            accessKeyId: 'ASIAEXAMPLE123456789',
            secretAccessKey: 's'.repeat(40),
            sessionToken: 't'.repeat(80),
            expiration: '2026-11-28T01:00:00Z',
          };
        },
      },
    },
  });
  t.after(() => app.close());

  const createA = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: {
      id: 'proj-a',
      name: 'Project Alpha',
      template: 'generic',
      capabilities: ['delivery', 'compute', 'collab', 'scoped_credentials'],
      delivery: { repositories: ['org-a/repo-a'], allowAgentAccess: true },
      compute: {
        allowedRegions: ['us-east-2'],
        s3ArtifactPrefixes: ['projects/proj-a/'],
        credentialPurposes: ['spot-placement-read', 'project-inputs-upload', 'project-artifacts-read'],
      },
    },
  });
  assert.equal(createA.statusCode, 201);
  const createB = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: {
      id: 'proj-b',
      name: 'Project Beta',
      template: 'generic',
      capabilities: ['compute', 'collab', 'scoped_credentials'],
      delivery: { repositories: ['org-b/repo-b'], allowAgentAccess: false },
      compute: {
        allowedRegions: ['ap-northeast-2'],
        s3ArtifactPrefixes: ['projects/proj-b/'],
        credentialPurposes: ['spot-placement-read', 'project-inputs-upload'],
      },
    },
  });
  assert.equal(createB.statusCode, 201);

  const fullScopes = [
    'compute:read',
    'compute:write',
    'delivery:read',
    'delivery:write',
    'collab:read',
    'collab:write',
    'credentials:issue',
  ];
  const tokA = (
    await app.inject({ method: 'POST', url: '/api/projects/proj-a/tokens', headers: opHeaders, payload: { label: 'a', scopes: fullScopes } })
  ).json().token as string;
  const tokB = (
    await app.inject({ method: 'POST', url: '/api/projects/proj-b/tokens', headers: opHeaders, payload: { label: 'b', scopes: fullScopes } })
  ).json().token as string;

  // 1. Compute isolation
  const jobARes = await app.inject({ method: 'POST', url: '/api/compute/jobs', headers: bearer(tokA), payload: computePayload() });
  assert.equal(jobARes.statusCode, 201);
  const jobA = jobARes.json();
  assert.equal(jobA.projectId, 'proj-a');

  // Project B cannot view, probe, or spoof Project A's compute jobs.
  assert.equal((await app.inject({ method: 'GET', url: `/api/compute/jobs/${jobA.id}`, headers: bearer(tokB) })).statusCode, 404);
  const listB = await app.inject({ method: 'GET', url: '/api/compute/jobs', headers: bearer(tokB) });
  assert.equal(listB.statusCode, 200);
  assert.deepEqual(listB.json().jobs, []);

  const spoofProject = await app.inject({
    method: 'POST',
    url: '/api/compute/jobs',
    headers: bearer(tokB),
    payload: computePayload({ projectId: 'proj-a' }),
  });
  assert.equal(spoofProject.statusCode, 403);

  const wrongPrefix = await app.inject({
    method: 'POST',
    url: '/api/compute/jobs',
    headers: bearer(tokB),
    payload: computePayload({
      repository: 'org-b/repo-b',
      compute: { ...computePayload().compute, region: 'ap-northeast-2', s3ArtifactPrefix: 'projects/proj-a/stolen/run-1' },
    }),
  });
  assert.equal(wrongPrefix.statusCode, 403);

  const wrongRegion = await app.inject({
    method: 'POST',
    url: '/api/compute/jobs',
    headers: bearer(tokB),
    payload: computePayload({
      repository: 'org-b/repo-b',
      compute: { ...computePayload().compute, region: 'us-east-2', s3ArtifactPrefix: 'projects/proj-b/wk-1/run-1' },
    }),
  });
  assert.equal(wrongRegion.statusCode, 403);

  // 2. Delivery isolation
  const delARes = await app.inject({
    method: 'POST',
    url: '/api/delivery/tasks',
    headers: bearer(tokA),
    payload: deliveryPayload('org-a/repo-a'),
  });
  assert.equal(delARes.statusCode, 201);
  const delA = delARes.json();
  assert.equal(delA.projectId, 'proj-a');

  // Project A cannot target another repo; Project B lacks sw_delivery capability and cannot read Project A's task.
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/delivery/tasks', headers: bearer(tokA), payload: deliveryPayload('org-b/repo-b') }))
      .statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/delivery/tasks', headers: bearer(tokB), payload: deliveryPayload('org-b/repo-b') }))
      .statusCode,
    403,
  );
  assert.equal((await app.inject({ method: 'GET', url: `/api/delivery/tasks/${delA.id}`, headers: bearer(tokB) })).statusCode, 404);

  // 3. Collab isolation
  const colARes = await app.inject({
    method: 'POST',
    url: '/api/collab/sessions',
    headers: bearer(tokA),
    payload: { title: 'Alpha collab', goal: 'Compare approaches', provider: 'codex' },
  });
  assert.equal(colARes.statusCode, 201);
  const colA = colARes.json();
  assert.equal(colA.projectId, 'proj-a');
  assert.equal((await app.inject({ method: 'GET', url: `/api/collab/sessions/${colA.id}`, headers: bearer(tokB) })).statusCode, 404);
  const colListB = await app.inject({ method: 'GET', url: '/api/collab/sessions', headers: bearer(tokB) });
  assert.equal(colListB.statusCode, 200);
  assert.deepEqual(colListB.json().sessions, []);

  // 4. Scoped AWS credentials isolation
  const credOk = await app.inject({
    method: 'POST',
    url: '/api/agent-credentials',
    headers: bearer(tokB),
    payload: { purpose: 'project-inputs-upload', workloadId: 'wk-beta' },
  });
  assert.equal(credOk.statusCode, 200);
  assert.equal(credOk.json().target.projectId, 'proj-b');
  assert.equal(credOk.json().target.s3Prefix, 'projects/proj-b/wk-beta/inputs/');
  assert.match(minted.at(-1)!.policy, /projects\/proj-b\/wk-beta\/inputs\//);

  // Project B cannot request another project's prefix or a purpose outside its policy.
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agent-credentials',
        headers: bearer(tokB),
        payload: { purpose: 'project-inputs-upload', projectId: 'proj-a', workloadId: 'wk-alpha' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agent-credentials',
        headers: bearer(tokB),
        payload: { purpose: 'model-inputs-upload', modelId: 'smf-v1' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agent-credentials',
        headers: bearer(tokB),
        payload: { purpose: 'project-artifacts-read', workloadId: 'wk-beta' },
      })
    ).statusCode,
    403,
  );
});

test('two-tier budget ledger enforces per-project cap, single-job cap, and host global ceiling independently', async (t) => {
  const app = buildApp({
    operatorToken: OP,
    workerToken: WK,
    computeBudgetCapMicros: 500_000,
  });
  t.after(() => app.close());

  await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: {
      id: 'proj-a',
      name: 'Alpha',
      budget: { computeBudgetCapMicros: 400_000, maxSingleJobCostMicros: 300_000 },
      delivery: { repositories: ['org-a/repo-a'] },
      compute: { allowedRegions: ['us-east-2'], s3ArtifactPrefixes: ['projects/proj-a/'] },
    },
  });
  await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: {
      id: 'proj-b',
      name: 'Beta',
      budget: { computeBudgetCapMicros: 300_000, maxSingleJobCostMicros: 200_000 },
      delivery: { repositories: ['org-b/repo-b'] },
      compute: { allowedRegions: ['us-east-2'], s3ArtifactPrefixes: ['projects/proj-b/'] },
    },
  });

  // Single-job cap rejects a 250k job in proj-b (max 200k).
  const oversized = await app.inject({
    method: 'POST',
    url: '/api/compute/jobs',
    headers: opHeaders,
    payload: computePayload({
      projectId: 'proj-b',
      repository: 'org-b/repo-b',
      compute: { ...computePayload().compute, maxTotalCostMicros: 250_000, s3ArtifactPrefix: 'projects/proj-b/wk-01/oversized' },
    }),
  });
  assert.equal(oversized.statusCode, 403);

  // Two 180k jobs in proj-b: first approves (180k), second hits proj-b's 300k cap (360k > 300k -> 409).
  const b1Res = await app.inject({
    method: 'POST',
    url: '/api/compute/jobs',
    headers: opHeaders,
    payload: computePayload({
      projectId: 'proj-b',
      repository: 'org-b/repo-b',
      compute: { ...computePayload().compute, maxTotalCostMicros: 180_000, s3ArtifactPrefix: 'projects/proj-b/wk-01/run-1' },
    }),
  });
  assert.equal(b1Res.statusCode, 201);
  const b1 = b1Res.json();
  const b2Res = await app.inject({
    method: 'POST',
    url: '/api/compute/jobs',
    headers: opHeaders,
    payload: computePayload({
      projectId: 'proj-b',
      repository: 'org-b/repo-b',
      compute: { ...computePayload().compute, maxTotalCostMicros: 180_000, s3ArtifactPrefix: 'projects/proj-b/wk-01/run-2' },
    }),
  });
  assert.equal(b2Res.statusCode, 201);
  const b2 = b2Res.json();

  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/compute/jobs/${b1.id}/approve`,
        headers: opHeaders,
        payload: { approvalFingerprint: b1.approvalFingerprint, reason: 'ok' },
      })
    ).statusCode,
    200,
  );
  const b2Approve = await app.inject({
    method: 'POST',
    url: `/api/compute/jobs/${b2.id}/approve`,
    headers: opHeaders,
    payload: { approvalFingerprint: b2.approvalFingerprint, reason: 'ok' },
  });
  assert.equal(b2Approve.statusCode, 409);
  assert.match(b2Approve.json().error, /Project 'proj-b' budget cap exceeded/);

  // Meanwhile proj-a can approve a 250k job (total host = 430k <= 500k), then a 100k job hits host global ceiling (530k > 500k).
  const a1Res = await app.inject({
    method: 'POST',
    url: '/api/compute/jobs',
    headers: opHeaders,
    payload: computePayload({
      projectId: 'proj-a',
      compute: { ...computePayload().compute, maxTotalCostMicros: 250_000, s3ArtifactPrefix: 'projects/proj-a/wk-01/run-1' },
    }),
  });
  assert.equal(a1Res.statusCode, 201);
  const a1 = a1Res.json();
  const a2Res = await app.inject({
    method: 'POST',
    url: '/api/compute/jobs',
    headers: opHeaders,
    payload: computePayload({
      projectId: 'proj-a',
      compute: { ...computePayload().compute, maxTotalCostMicros: 100_000, s3ArtifactPrefix: 'projects/proj-a/wk-01/run-2' },
    }),
  });
  assert.equal(a2Res.statusCode, 201);
  const a2 = a2Res.json();

  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/compute/jobs/${a1.id}/approve`,
        headers: opHeaders,
        payload: { approvalFingerprint: a1.approvalFingerprint, reason: 'ok' },
      })
    ).statusCode,
    200,
  );
  const a2Approve = await app.inject({
    method: 'POST',
    url: `/api/compute/jobs/${a2.id}/approve`,
    headers: opHeaders,
    payload: { approvalFingerprint: a2.approvalFingerprint, reason: 'ok' },
  });
  assert.equal(a2Approve.statusCode, 409);
  assert.match(a2Approve.json().error, /Central cost cap exceeded/);

  // Global ledger breaks down byProject; per-project ledger reports remaining against proj-b cap.
  const globalLedger = (await app.inject({ method: 'GET', url: '/api/compute/ledger', headers: opHeaders })).json();
  assert.equal(globalLedger.totalReservedMicros, 430_000);
  assert.equal(globalLedger.remainingBudgetMicros, 70_000);
  assert.equal(globalLedger.byProject['proj-a'].totalReservedMicros, 250_000);
  assert.equal(globalLedger.byProject['proj-b'].totalReservedMicros, 180_000);

  const projBLedger = (await app.inject({ method: 'GET', url: '/api/projects/proj-b/ledger', headers: opHeaders })).json();
  assert.equal(projBLedger.globalBudgetCapMicros, 300_000);
  assert.equal(projBLedger.totalReservedMicros, 180_000);
  // Bounded by min(project remaining 120k, host global remaining 70k) = 70k.
  assert.equal(projBLedger.remainingBudgetMicros, 70_000);
});

test('MCP project-agent profile exposes scoped tools and reads its own project manifest via hivemind_project_me', async (t) => {
  const app = buildApp({ operatorToken: OP, workerToken: WK });
  t.after(() => app.close());

  await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: opHeaders,
    payload: {
      id: 'research-lab',
      name: 'Research Lab',
      template: 'research-collab',
      delivery: { repositories: ['org/research-lab'] },
    },
  });
  const token = (
    await app.inject({ method: 'POST', url: '/api/projects/research-lab/tokens', headers: opHeaders, payload: { label: 'mcp' } })
  ).json().token as string;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: `${url.pathname}${url.search}`,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  };

  const server = createHivemindMcpServer({
    profile: 'project-agent',
    apiUrl: 'http://127.0.0.1:4310',
    operatorToken: token,
    fetchImpl,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '0.1.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes('hivemind_project_me'));
  assert.ok(tools.includes('hivemind_compute_create'));
  assert.ok(tools.includes('hivemind_compute_list'));
  assert.equal(tools.includes('hivemind_project_register'), false, 'project-agent must not have host admin tools');
  assert.equal(tools.includes('hivemind_compute_approve_release'), false, 'project-agent cannot self-approve releases');

  const me = await client.callTool({ name: 'hivemind_project_me', arguments: {} });
  assert.equal(me.isError, undefined);
  const structured = me.structuredContent as { project: { id: string; name: string } };
  assert.equal(structured.project.id, 'research-lab');
  assert.equal(structured.project.name, 'Research Lab');
});
