import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import { CollabOrchestrator } from '../apps/control-plane/src/collab-orchestrator.js';
import { ComputeOrchestrator } from '../apps/control-plane/src/compute-orchestrator.js';
import { generateDsqlAuthToken } from '../packages/adapters/src/aws-dsql.js';
import type { Ec2SpotTrainerPort } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { SpotMarketSnapshot } from '../packages/contracts/src/multi-region.js';
import { AgentCollabService, SqliteCollaborationRepository } from '../packages/core/src/agent-collab.js';
import { ComputeStore } from '../packages/core/src/compute.js';

test('Aurora DSQL SigV4 presigned IAM auth token matches AWS format and validates hostname', () => {
  const token = generateDsqlAuthToken({
    endpoint: 'abc123def456.dsql.ap-northeast-2.on.aws',
    region: 'ap-northeast-2',
    action: 'DbConnectAdmin',
    expiresInSeconds: 900,
    nowMs: Date.parse('2026-11-26T12:00:00.000Z'),
    credentials: {
      accessKeyId: 'AKIAEXAMPLE123456',
      secretAccessKey: 'secret-key-example',
      sessionToken: 'session-token-example',
    },
  });

  assert.ok(token.startsWith('abc123def456.dsql.ap-northeast-2.on.aws/?'));
  assert.equal(token.includes('https://'), false);
  const parsed = new URL(`https://${token}`);
  assert.equal(parsed.searchParams.get('Action'), 'DbConnectAdmin');
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(parsed.searchParams.get('X-Amz-Security-Token'), 'session-token-example');
  assert.match(parsed.searchParams.get('X-Amz-Signature') ?? '', /^[a-f0-9]{64}$/);

  assert.throws(
    () =>
      generateDsqlAuthToken({
        endpoint: 'evil.example.com',
        region: 'ap-northeast-2',
        credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      }),
    /Invalid Aurora DSQL endpoint hostname/,
  );
});

test('Embedded Control Plane orchestrator strips AWS/Control-Plane secrets, uses ephemeral local token, and fans out parallel Fargate Spot DAG subtasks', async () => {
  const capturedEnv: NodeJS.ProcessEnv[] = [];
  const launchedWorkers: { sessionId: string; subtaskId: string; agentId: string; targetRegion: string }[] = [];

  process.env.AWS_SECRET_ACCESS_KEY = 'must-never-leak-to-embedded-agent';
  process.env.HIVEMIND_OPERATOR_TOKEN = 'op-super-secret-value';

  const app = buildApp({
    operatorToken: 'op-collab-token',
    workerToken: 'wk-collab-token',
    collabOrchestratorFactory: (service) =>
      new CollabOrchestrator({
        service,
        controlApiUrl: 'http://127.0.0.1:4310',
        workerToken: 'wk-collab-token',
        redactSecrets: ['op-collab-token', 'wk-collab-token'],
        workerLauncher: {
          async launchCollabWorker(input) {
            launchedWorkers.push({
              sessionId: input.sessionId,
              subtaskId: input.subtaskId,
              agentId: input.agentId,
              targetRegion: input.targetRegion,
            });
            return { taskArn: `arn:aws:ecs:${input.targetRegion}:123456789012:task/spot-${input.subtaskId}`, region: input.targetRegion };
          },
        },
        embeddedRunner: {
          async run(input) {
            capturedEnv.push({ ...input.env });
            return {
              status: 'passed',
              summary: 'Decomposed goal into 2 parallel research subtasks and 1 synthesis subtask.',
            };
          },
        },
      }),
  });

  try {
    // 1. Create collaboration session
    const sesRes = await app.inject({
      method: 'POST',
      url: '/api/collab/sessions',
      headers: { authorization: 'Bearer op-collab-token' },
      payload: {
        title: 'Parallel Verilog dataset & eval pipeline',
        goal: 'Build dataset and run parallel benchmark analysis',
        provider: 'claude',
        maxParallelWorkers: 2,
        allowedRegions: ['us-east-2', 'ap-northeast-2'],
      },
    });
    assert.equal(sesRes.statusCode, 201);
    const session = sesRes.json();

    // 2. Run embedded Control Plane agent with ephemeral local auth token (Option B)
    const runRes = await app.inject({
      method: 'POST',
      url: `/api/collab/sessions/${session.id}/run-orchestrator`,
      headers: { authorization: 'Bearer op-collab-token' },
      payload: {
        provider: 'claude',
        prompt: 'Plan the parallel subtasks',
        localAuthSecret: JSON.stringify({ claude: { apiKey: 'sk-ant-ephemeral-local-test-token' } }),
      },
    });
    assert.equal(runRes.statusCode, 200);
    assert.equal(runRes.json().latestOrchestratorRun.status, 'completed');
    assert.equal(capturedEnv.length, 1);
    // Strict process-level secret isolation verified!
    assert.equal(capturedEnv[0]!.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(capturedEnv[0]!.HIVEMIND_OPERATOR_TOKEN, undefined);
    assert.equal(capturedEnv[0]!.HIVEMIND_COLLAB_SESSION_ID, session.id);

    // 3. Create DAG: subA & subB (parallel) -> subC (depends on both subA and subB)
    const subA = (
      await app.inject({
        method: 'POST',
        url: `/api/collab/sessions/${session.id}/subtasks`,
        headers: { authorization: 'Bearer wk-collab-token' },
        payload: { title: 'Subtask A', instructions: 'Gather Verilog repos' },
      })
    ).json();
    const subB = (
      await app.inject({
        method: 'POST',
        url: `/api/collab/sessions/${session.id}/subtasks`,
        headers: { authorization: 'Bearer wk-collab-token' },
        payload: { title: 'Subtask B', instructions: 'Prepare eval harness' },
      })
    ).json();
    const subC = (
      await app.inject({
        method: 'POST',
        url: `/api/collab/sessions/${session.id}/subtasks`,
        headers: { authorization: 'Bearer wk-collab-token' },
        payload: { title: 'Subtask C (Synthesis)', instructions: 'Merge A & B', dependsOn: [subA.id, subB.id] },
      })
    ).json();

    // 4. Fan out ready subtasks -> dispatches ONLY subA and subB onto parallel Fargate Spot workers (subC waits for DAG!)
    const fanOut1 = (
      await app.inject({
        method: 'POST',
        url: `/api/collab/sessions/${session.id}/fan-out`,
        headers: { authorization: 'Bearer wk-collab-token' },
        payload: {},
      })
    ).json();
    assert.equal(fanOut1.dispatched.length, 2);
    assert.equal(launchedWorkers.length, 2);
    assert.equal(launchedWorkers.some((w) => w.subtaskId === subC.id), false);

    // 5. Agents communicate via shared board & append shared S3 work logs
    const agentA = fanOut1.dispatched[0].assignedAgentId;
    const agentB = fanOut1.dispatched[1].assignedAgentId;

    const msgRes = await app.inject({
      method: 'POST',
      url: `/api/collab/sessions/${session.id}/messages`,
      headers: { authorization: 'Bearer wk-collab-token' },
      payload: {
        sender: agentA,
        recipient: agentB,
        kind: 'handoff',
        body: 'Uploaded cleaned Verilog corpus to S3',
        artifactRefs: ['s3://hivemind-artifacts/collab/corpus.jsonl'],
      },
    });
    assert.equal(msgRes.statusCode, 201);

    await app.inject({
      method: 'POST',
      url: `/api/collab/sessions/${session.id}/work-logs`,
      headers: { authorization: 'Bearer wk-collab-token' },
      payload: {
        subtaskId: subA.id,
        agentId: agentA,
        kind: 'artifact',
        summary: 'Corpus ready (10k snippets)',
        s3Uri: 's3://hivemind-artifacts/collab/corpus.jsonl',
        sha256: 'a'.repeat(64),
      },
    });

    // Cursor-based message read for agentB
    const inbox = (
      await app.inject({
        method: 'GET',
        url: `/api/collab/sessions/${session.id}/messages?recipient=${encodeURIComponent(agentB)}`,
        headers: { authorization: 'Bearer wk-collab-token' },
      })
    ).json();
    assert.ok(inbox.messages.some((m: { body: string }) => m.body.includes('Uploaded cleaned Verilog corpus')));

    // Finish A & B -> now DAG unlocks subC for fan-out!
    await app.inject({
      method: 'POST',
      url: `/api/collab/sessions/${session.id}/subtasks/${subA.id}/finish`,
      headers: { authorization: 'Bearer wk-collab-token' },
      payload: { agentId: agentA, status: 'completed', summary: 'A done' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/collab/sessions/${session.id}/subtasks/${subB.id}/finish`,
      headers: { authorization: 'Bearer wk-collab-token' },
      payload: { agentId: agentB, status: 'completed', summary: 'B done' },
    });

    const fanOut2 = (
      await app.inject({
        method: 'POST',
        url: `/api/collab/sessions/${session.id}/fan-out`,
        headers: { authorization: 'Bearer wk-collab-token' },
        payload: {},
      })
    ).json();
    assert.equal(fanOut2.dispatched.length, 1);
    assert.equal(fanOut2.dispatched[0].id, subC.id);

    const snapshot = (
      await app.inject({
        method: 'GET',
        url: `/api/collab/sessions/${session.id}`,
        headers: { authorization: 'Bearer op-collab-token' },
      })
    ).json();
    assert.equal(snapshot.storageBackend, 'sqlite');
    assert.equal(snapshot.workLogs.length, 1);
    assert.ok(snapshot.messages.length >= 4);
  } finally {
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.HIVEMIND_OPERATOR_TOKEN;
    await app.close();
  }
});

test('5-Region GPU Spot Auto-Router ranks by Spot Placement Score and fails over on InsufficientInstanceCapacity', async () => {
  const store = new ComputeStore(':memory:');
  const attemptedRegions: string[] = [];
  const fakeEc2: Ec2SpotTrainerPort = {
    async launchSpotInstance(input) {
      attemptedRegions.push(input.region);
      // Simulate capacity exhaustion in the top-ranked region (us-east-2) -> must automatically fail over to next best region (us-west-2)!
      if (input.region === 'us-east-2') {
        throw new Error('AWS EC2 RunInstances failed (InsufficientInstanceCapacity): no capacity in us-east-2');
      }
      return {
        region: input.region,
        availabilityZone: `${input.region}a`,
        instanceId: 'i-09999999999999999',
        instanceType: input.instanceType,
        amiId: input.amiId,
        state: 'pending',
      };
    },
    async describeInstance() {
      throw new Error('unused');
    },
    async terminateInstance() {
      throw new Error('unused');
    },
    async sweepExpiredSpotInstances() {
      throw new Error('unused');
    },
  };
  const fakeS3: S3ObjectPort = {
    async putObject() {
      return { sha256: 'a'.repeat(64) };
    },
    async getObject() {
      return new Uint8Array();
    },
  };

  // Spot feed showing us-east-2 score 9 ($1.10), us-west-2 score 8 ($1.15), us-east-1 score 5 ($1.30), ap-northeast-1 score 4 ($1.40), ap-northeast-2 score 3 ($1.50).
  const nowIso = '2026-11-26T12:00:00.000Z';
  const nowMs = Date.parse(nowIso);
  const snapshot: SpotMarketSnapshot = {
    generated: '2026-11-26T11:30:00.000Z',
    generatedAtMs: Date.parse('2026-11-26T11:30:00.000Z'),
    regions: ['us-east-1', 'us-east-2', 'us-west-2', 'ap-northeast-1', 'ap-northeast-2'],
    types: ['g6e.12xlarge'],
    typeMeta: {
      'g6e.12xlarge': { family: 'g6e', arch: 'x86', spec: '48vCPU 4xL40S', gpu: '4x L40S', members: ['g6e.12xlarge'] },
    },
    noPool: {},
    azMeta: {},
    scores: {
      'g6e.12xlarge': {
        'us-east-1': [[nowIso, 5]],
        'us-east-2': [[nowIso, 9]],
        'us-west-2': [[nowIso, 8]],
        'ap-northeast-1': [[nowIso, 4]],
        'ap-northeast-2': [[nowIso, 3]],
      },
    },
    prices: {
      'g6e.12xlarge': {
        'us-east-1': [[nowIso, 1.3]],
        'us-east-2': [[nowIso, 1.1]],
        'us-west-2': [[nowIso, 1.15]],
        'ap-northeast-1': [[nowIso, 1.4]],
        'ap-northeast-2': [[nowIso, 1.5]],
      },
    },
    azScores: {},
    azPrice: {},
  };

  const orchestrator = new ComputeOrchestrator({
    store,
    ec2: fakeEc2,
    s3: fakeS3,
    now: () => nowMs,
    spotFeed: { async getSnapshot() { return snapshot; } },
  });

  try {
    const job = await store.create({
      title: '5-region auto GPU Spot failover test',
      workloadId: 'verilog-embed-v1',
      repository: 'roboco-io/silicon-model-factory',
      baseCommit: 'a'.repeat(40),
      compute: {
        region: 'ap-northeast-2',
        candidateRegions: ['us-east-1', 'us-east-2', 'us-west-2', 'ap-northeast-1', 'ap-northeast-2'],
        regionOverrides: {
          'us-east-2': { amiId: 'ami-02222222222222222' },
          'us-west-2': { amiId: 'ami-03333333333333333' },
        },
        instanceType: 'g6e.12xlarge',
        workloadClass: 'g6e.12xlarge',
        amiId: 'ami-01111111111111111',
        maxLifetimeMs: 3_600_000,
        maxHourlyPriceUsd: 2.0,
        maxTotalCostMicros: 2_000_000,
        s3ArtifactPrefix: 'models/verilog-embed-v1/runs/auto-1',
      },
      releasePolicy: {
        mode: 's3_artifact_only',
        visibility: 'private',
        releaseCheckCommand: ['node', 'tools/release-check.mjs'],
      },
    });

    const launched = await orchestrator.approveAndLaunch(job.id, job.approvalFingerprint, 'Launch 5-region auto GPU');
    assert.equal(launched.status, 'running');
    // Tried highest-score us-east-2 first, failed over automatically to second-best us-west-2 with its region-specific AMI!
    assert.deepEqual(attemptedRegions, ['us-east-2', 'us-west-2']);
    assert.equal(launched.instance?.region, 'us-west-2');
    assert.equal(launched.instance?.amiId, 'ami-03333333333333333');
  } finally {
    await store.close();
  }
});

test('AgentCollabService enforces exclusive subtask claim and rejects claiming while DAG dependency is incomplete', async () => {
  const service = new AgentCollabService(new SqliteCollaborationRepository(':memory:'));
  try {
    const ses = await service.createSession({ title: 'DAG race test', goal: 'Test', provider: 'codex' });
    const s1 = await service.createSubtask(ses.id, { title: 'Step 1', instructions: 'Do step 1' });
    const s2 = await service.createSubtask(ses.id, { title: 'Step 2', instructions: 'Do step 2', dependsOn: [s1.id] });

    await assert.rejects(() => service.claimSubtask(ses.id, s2.id, { agentId: 'a2' }), /not ready/);
    const claimed = await service.claimSubtask(ses.id, s1.id, { agentId: 'a1' });
    assert.equal(claimed.assignedAgentId, 'a1');
    await assert.rejects(() => service.claimSubtask(ses.id, s1.id, { agentId: 'a2' }), /already claimed/);
  } finally {
    service.close();
  }
});
