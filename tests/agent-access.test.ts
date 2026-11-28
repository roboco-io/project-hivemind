import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Fastify from 'fastify';
import { registerAgentCredentialTools } from '../apps/mcp-server/src/agent-access.js';
import { registerAgentCredentialRoutes, type AgentCredentialAuditRecord } from '../apps/control-plane/src/agent-access-api.js';
import {
  AgentCredentialsUnavailableError,
  createAwsAgentCredentialIssuer,
  type AgentCredentialIssuerPort,
} from '../packages/adapters/src/aws-agent-access.js';
import {
  parseEnabledPurposes,
  planAgentCredentials,
  type AgentCredentialCatalogConfig,
} from '../packages/core/src/agent-credential-purposes.js';

const KMS = 'arn:aws:kms:ap-northeast-2:123456789012:key/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const CATALOG: AgentCredentialCatalogConfig = {
  enabledPurposes: ['spot-placement-read', 'model-inputs-upload', 'model-artifacts-read'],
  artifactsBucket: 'hivemind-runtime-123456789012-ap-northeast-2-artifacts',
  artifactsKmsKeyArn: KMS,
  allowedRegions: ['ap-northeast-2', 'us-east-2'],
};
const OP = 'o'.repeat(32);
const PARENT_KEY = 'ASIAPARENTPARENT0001';
const CHILD_KEY = 'ASIACHILDCHILDCHI002';

test('each purpose fills a fixed policy template scoped to its target', () => {
  const spot = planAgentCredentials(CATALOG, { purpose: 'spot-placement-read' });
  assert.equal(spot.target.modelId, null);
  assert.deepEqual(JSON.parse(spot.policy).Statement[0].Condition, { StringEquals: { 'aws:RequestedRegion': ['ap-northeast-2', 'us-east-2'] } });
  assert.equal(spot.durationSeconds, 900);
  assert.equal(spot.description, 'hivemind-agent spot-placement-read');

  const upload = planAgentCredentials(CATALOG, { purpose: 'model-inputs-upload', modelId: 'verilog-embed-base', durationSeconds: 300 });
  const doc = JSON.parse(upload.policy);
  assert.equal(doc.Statement[0].Resource, `arn:aws:s3:::${CATALOG.artifactsBucket}/models/verilog-embed-base/inputs/*`);
  assert.deepEqual(doc.Statement[1].Condition, { StringLike: { 's3:prefix': 'models/verilog-embed-base/inputs/*' } });
  assert.equal(doc.Statement[2].Resource, KMS);
  assert.equal(upload.durationSeconds, 300);
  assert.match(upload.policyHash, /^[a-f0-9]{64}$/);

  const read = JSON.parse(planAgentCredentials(CATALOG, { purpose: 'model-artifacts-read', modelId: 'm1' }).policy);
  assert.equal(read.Statement[0].Resource, `arn:aws:s3:::${CATALOG.artifactsBucket}/models/m1/runs/*`);
  assert.deepEqual(read.Statement[0].Action, 's3:GetObject');
  for (const p of ['spot-placement-read', 'model-inputs-upload', 'model-artifacts-read']) {
    const plan = planAgentCredentials(CATALOG, { purpose: p, ...(p === 'spot-placement-read' ? {} : { modelId: 'a'.repeat(120) }) });
    assert.ok(plan.policy.length <= 2048, `${p} policy is ${plan.policy.length} chars`);
  }
});

test('requests outside the catalog are refused before any AWS call', () => {
  const refuse = (input: Record<string, unknown>, status: number, config = CATALOG) =>
    assert.throws(() => planAgentCredentials(config, input), (error: unknown) => (error as { statusCode?: number }).statusCode === status);
  refuse({ purpose: 'admin' }, 400);
  refuse({ purpose: 'model-inputs-upload' }, 400);
  refuse({ purpose: 'model-inputs-upload', modelId: '../other' }, 400);
  refuse({ purpose: 'model-inputs-upload', modelId: 'a/b' }, 400);
  refuse({ purpose: 'model-inputs-upload', modelId: 'm1*' }, 400);
  refuse({ purpose: 'spot-placement-read', modelId: 'm1' }, 400);
  refuse({ purpose: 'spot-placement-read', durationSeconds: 901 }, 400);
  refuse({ purpose: 'spot-placement-read', durationSeconds: 30 }, 400);
  refuse({ purpose: 'spot-placement-read', policy: '{}' } as Record<string, unknown>, 403, { ...CATALOG, enabledPurposes: [] });
  refuse({ purpose: 'model-artifacts-read', modelId: 'm1' }, 403, { ...CATALOG, enabledPurposes: ['spot-placement-read'] });
  assert.deepEqual(parseEnabledPurposes(' spot-placement-read , model-artifacts-read '), ['spot-placement-read', 'model-artifacts-read']);
  assert.deepEqual(parseEnabledPurposes(undefined), []);
  assert.throws(() => parseEnabledPurposes('spot-placement-read,iam-admin'), /Unknown agent credential purpose/);
});

function stsXml(root: string, accessKeyId: string, expiration: string, extra = ''): string {
  return (
    `<${root}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><${root}Result>` +
    `<Credentials><AccessKeyId>${accessKeyId}</AccessKeyId><SecretAccessKey>${'s'.repeat(40)}</SecretAccessKey>` +
    `<SessionToken>${'t'.repeat(64)}</SessionToken><Expiration>${expiration}</Expiration></Credentials>${extra}` +
    `</${root}Result><ResponseMetadata><RequestId>r-1</RequestId></ResponseMetadata></${root}Response>`
  );
}

function fakeSts(nowMs: number, gsc: (params: URLSearchParams) => Response) {
  const calls: { host: string; params: URLSearchParams; token: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const params = new URLSearchParams(String(init?.body));
    calls.push({ host: url.host, params, token: new Headers(init?.headers).get('x-amz-security-token') });
    if (params.get('Action') === 'AssumeRole') {
      const arn = 'arn:aws:sts::123456789012:assumed-role/hivemind-runtime-agent-credentials-parent-role/s';
      return new Response(
        stsXml('AssumeRole', PARENT_KEY, new Date(nowMs + 3_600_000).toISOString(), `<AssumedRoleUser><AssumedRoleId>AROAEXAMPLE:s</AssumedRoleId><Arn>${arn}</Arn></AssumedRoleUser>`),
        { status: 200 },
      );
    }
    return gsc(params);
  };
  return { fetchImpl, calls };
}

const PARENT_ARN = 'arn:aws:iam::123456789012:role/hivemind-runtime-agent-credentials-parent-role';
const SESSION_ARN = 'arn:aws:sts::123456789012:assumed-role/hivemind-runtime-agent-credentials-parent-role/s';

test('the issuer assumes the parent role, scopes down on the regional endpoint and returns only the child', async () => {
  const now = Date.parse('2026-11-27T10:00:00Z');
  const { fetchImpl, calls } = fakeSts(now, (params) =>
    new Response(
      stsXml('GetScopedCredentials', CHILD_KEY, new Date(now + Number(params.get('DurationSeconds')) * 1000).toISOString(), `<SessionInfo><Arn>${SESSION_ARN}</Arn><ScopedSessionId>x</ScopedSessionId></SessionInfo><ScopedPoliciesCount>1</ScopedPoliciesCount>`),
      { status: 200 },
    ),
  );
  const issuer = createAwsAgentCredentialIssuer({
    region: 'ap-northeast-2',
    parentRoleArn: PARENT_ARN,
    baseCredentials: () => ({ accessKeyId: 'ASIABASEBASEBASE0003', secretAccessKey: 'b'.repeat(40), sessionToken: 'base-token' }),
    fetch: fetchImpl,
    now: () => now,
  });
  const plan = planAgentCredentials(CATALOG, { purpose: 'spot-placement-read', durationSeconds: 600 });
  const issued = await issuer.issue({ policy: plan.policy, durationSeconds: plan.durationSeconds, description: plan.description });
  assert.equal(issued.accessKeyId, CHILD_KEY);
  assert.equal(issued.expiration, new Date(now + 600_000).toISOString());
  assert.deepEqual(calls.map((c) => [c.host, c.params.get('Action')]), [
    ['sts.ap-northeast-2.amazonaws.com', 'AssumeRole'],
    ['sts.ap-northeast-2.amazonaws.com', 'GetScopedCredentials'],
  ]);
  assert.equal(calls[0]!.params.get('RoleArn'), PARENT_ARN);
  assert.equal(calls[0]!.token, 'base-token');
  assert.equal(calls[1]!.params.get('Policy'), plan.policy);
  assert.equal(calls[1]!.params.get('DurationSeconds'), '600');
  assert.equal(calls[1]!.params.get('ScopedSessionDescription'), 'hivemind-agent spot-placement-read');
  assert.equal(calls[1]!.token, 't'.repeat(64), 'GetScopedCredentials is signed with the parent session');

  // The parent session is reused while it has enough time left.
  await issuer.issue({ policy: plan.policy, durationSeconds: 60, description: plan.description });
  assert.equal(calls.filter((c) => c.params.get('Action') === 'AssumeRole').length, 1);
});

test('a failed or suspicious scope-down never hands out the parent session', async () => {
  const now = Date.parse('2026-11-27T10:00:00Z');
  const policy = planAgentCredentials(CATALOG, { purpose: 'spot-placement-read' });
  const cases: [string, (params: URLSearchParams) => Response][] = [
    ['STS error', () => new Response('<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>', { status: 403 })],
    ['parent key echoed', () => new Response(stsXml('GetScopedCredentials', PARENT_KEY, new Date(now + 600_000).toISOString()), { status: 200 })],
    ['longer than asked', () => new Response(stsXml('GetScopedCredentials', CHILD_KEY, new Date(now + 3_000_000).toISOString()), { status: 200 })],
    ['other principal', () => new Response(stsXml('GetScopedCredentials', CHILD_KEY, new Date(now + 600_000).toISOString(), '<SessionInfo><Arn>arn:aws:sts::123456789012:assumed-role/admin/x</Arn></SessionInfo>'), { status: 200 })],
  ];
  for (const [label, gsc] of cases) {
    const { fetchImpl } = fakeSts(now, gsc);
    const issuer = createAwsAgentCredentialIssuer({
      region: 'ap-northeast-2',
      parentRoleArn: PARENT_ARN,
      baseCredentials: () => ({ accessKeyId: 'ASIABASEBASEBASE0003', secretAccessKey: 'b'.repeat(40), sessionToken: 'base' }),
      fetch: fetchImpl,
      now: () => now,
    });
    await assert.rejects(
      issuer.issue({ policy: policy.policy, durationSeconds: 900, description: policy.description }),
      (error: unknown) => error instanceof AgentCredentialsUnavailableError && error.stage === 'scope_down' && !String(error.message).includes('ASIA'),
      label,
    );
  }
  assert.throws(() => createAwsAgentCredentialIssuer({ region: 'ap-northeast-2', parentRoleArn: 'arn:aws:iam::1:user/x', baseCredentials: () => ({ accessKeyId: 'a', secretAccessKey: 'b' }) }));
});

function apiWith(issuer: AgentCredentialIssuerPort) {
  const audits: AgentCredentialAuditRecord[] = [];
  const app = Fastify();
  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => reply.code(error.statusCode ?? 500).send({ error: error.message }));
  registerAgentCredentialRoutes(app, { operatorToken: OP, catalog: CATALOG, issuer, region: 'ap-northeast-2', audit: (r) => audits.push(r) });
  const post = (payload: unknown, token = OP) =>
    app.inject({ method: 'POST', url: '/api/agent-credentials', headers: { authorization: `Bearer ${token}` }, payload: payload as Record<string, unknown> });
  return { app, audits, post };
}

const CHILD = { accessKeyId: CHILD_KEY, secretAccessKey: 'c'.repeat(40), sessionToken: 'child-token-value', expiration: '2026-11-27T10:15:00Z' };

test('the API returns credentials to the caller only and audits purpose, target, hash and expiry', async (t) => {
  const { app, audits, post } = apiWith({ issue: async () => CHILD });
  t.after(() => app.close());
  assert.equal((await post({ purpose: 'spot-placement-read' }, 'wrong')).statusCode, 401);
  const res = await post({ purpose: 'model-artifacts-read', modelId: 'm1', durationSeconds: 120 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json();
  assert.deepEqual(body.credentials, CHILD);
  assert.deepEqual(body.target, { projectId: null, workloadId: 'm1', modelId: 'm1', s3Prefix: 'models/m1/runs/' });
  const issued = audits.find((a) => a.event === 'hivemind.agent_credentials.issued')!;
  assert.equal(issued.expiration, CHILD.expiration);
  assert.equal(issued.policyHash, body.policyHash);
  assert.equal(issued.description, 'hivemind-agent model-artifacts-read m1');
  assert.doesNotMatch(JSON.stringify(audits), /child-token-value|cccccccc|ASIACHILD/);

  const denied = await post({ purpose: 'iam-admin' });
  assert.equal(denied.statusCode, 400);
  assert.equal(audits.at(-1)!.event, 'hivemind.agent_credentials.denied');
  assert.equal((await post({ purpose: 'model-inputs-upload', modelId: '../x' })).statusCode, 400);
});

test('an STS failure answers 502 without any credential', async (t) => {
  const { app, audits, post } = apiWith({
    issue: async () => {
      throw new AgentCredentialsUnavailableError('scope_down');
    },
  });
  t.after(() => app.close());
  const res = await post({ purpose: 'spot-placement-read' });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { error: 'Scoped credentials unavailable' });
  assert.equal(audits.at(-1)!.event, 'hivemind.agent_credentials.failed');
  assert.equal(audits.at(-1)!.reason, 'STS scope_down failed');
});

test('the MCP tool writes a 0600 credentials file and keeps the secret out of the tool result', async (t) => {
  const { app, post } = apiWith({ issue: async () => CHILD });
  t.after(() => app.close());
  const fetchImpl: typeof fetch = async (_input, init) => {
    const res = await post(JSON.parse(String(init?.body)), new Headers(init?.headers).get('authorization')!.slice(7));
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  };
  const dir = join(mkdtempSync(join(tmpdir(), 'hm-agent-creds-')), 'creds');
  const server = new McpServer({ name: 't', version: '0' });
  registerAgentCredentialTools(server, { apiUrl: 'http://127.0.0.1:4310', operatorToken: OP, fetchImpl, credentialsDir: dir });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(a);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = (await client.callTool({ name: 'hivemind_agent_credentials', arguments: { purpose: 'model-inputs-upload', modelId: 'm1' } })) as {
    structuredContent: Record<string, unknown>;
    content: { text: string }[];
  };
  assert.equal(result.structuredContent.issued, true);
  assert.equal(result.structuredContent.profile, 'hivemind-model-inputs-upload-m1');
  assert.doesNotMatch(JSON.stringify(result), /child-token-value|cccccccc/);
  const file = String(result.structuredContent.credentialsFile);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const ini = readFileSync(file, 'utf8');
  assert.match(ini, /^\[hivemind-model-inputs-upload-m1\]\naws_access_key_id = ASIACHILDCHILDCHI002\n/);
  assert.match(ini, /aws_session_token = child-token-value\nregion = ap-northeast-2\n$/);

  const refused = (await client.callTool({ name: 'hivemind_agent_credentials', arguments: { purpose: 'model-artifacts-read' } })) as {
    structuredContent: Record<string, unknown>;
  };
  assert.deepEqual(refused.structuredContent, { issued: false, httpStatus: 400, error: 'workloadId (or modelId) must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$' });
});
