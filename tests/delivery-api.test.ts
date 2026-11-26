import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import { DeliveryOrchestrator } from '../apps/control-plane/src/delivery-orchestrator.js';
import type { LaunchEcsWorkloadInput } from '../packages/adapters/src/aws-ecs-driver.js';
import { computeAcceptanceTestDigest } from '../packages/core/src/delivery.js';

const OP_TOKEN = 'operator-delivery-test-token-123456';
const WK_TOKEN = 'worker-delivery-test-token-654321';
const BASE_COMMIT = 'a'.repeat(40);
const TREE_HASH = 'b'.repeat(40);
const COMMIT_SHA = 'c'.repeat(40);
const FILE_SHA = 'd'.repeat(64);
const PATCH_SHA = 'e'.repeat(64);

function createPayload() {
  const files = [{ path: 'tests/acceptance.test.ts', sha256: FILE_SHA }];
  const testCommand = ['npm', 'run', 'check'];
  return {
    title: 'Milestone 1 dogfooding issue',
    instructions: 'Fix bug without touching acceptance tests.',
    provider: 'codex',
    maxIterations: 2,
    budgetMicros: 100_000,
    acceptance: {
      baseCommit: BASE_COMMIT,
      files,
      testCommand,
      digest: computeAcceptanceTestDigest({ baseCommit: BASE_COMMIT, files, testCommand }),
    },
    delivery: {
      mode: 'draft_pr',
      repository: 'roboco-io/project-hivemind',
      baseBranch: 'main',
      branchPrefix: 'hivemind/',
      autoMerge: false,
    },
  };
}

test('delivery HTTP API enforces role boundaries before body parsing and completes end-to-end Draft PR + no-diff human decision', async () => {
  const app = buildApp({ operatorToken: OP_TOKEN, workerToken: WK_TOKEN });
  try {
    // Worker cannot create, approve, publish Draft PR, or record human decision (401 before body parsing).
    const unauthMalformed = await app.inject({
      method: 'POST',
      url: '/api/delivery/tasks',
      headers: { authorization: `Bearer ${WK_TOKEN}`, 'content-type': 'application/json' },
      payload: '{invalid-json',
    });
    assert.equal(unauthMalformed.statusCode, 401);

    const createdRes = await app.inject({
      method: 'POST',
      url: '/api/delivery/tasks',
      headers: { authorization: `Bearer ${OP_TOKEN}` },
      payload: createPayload(),
    });
    assert.equal(createdRes.statusCode, 201);
    const created = createdRes.json();
    assert.equal(created.status, 'awaiting_approval');

    const workerApprove = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/approve`,
      headers: { authorization: `Bearer ${WK_TOKEN}` },
      payload: { approvalFingerprint: created.approvalFingerprint, reason: 'forged' },
    });
    assert.equal(workerApprove.statusCode, 401);

    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/approve`,
      headers: { authorization: `Bearer ${OP_TOKEN}` },
      payload: { approvalFingerprint: created.approvalFingerprint, reason: 'Operator approved' },
    });
    assert.equal(approveRes.statusCode, 200);
    assert.equal(approveRes.json().status, 'queued');

    // Operator cannot call worker-only start endpoint.
    const opStart = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/start`,
      headers: { authorization: `Bearer ${OP_TOKEN}` },
      payload: { workerId: 'w-1', runId: 'run-1' },
    });
    assert.equal(opStart.statusCode, 401);

    const startRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/start`,
      headers: { authorization: `Bearer ${WK_TOKEN}` },
      payload: { workerId: 'fargate-spot-1', runId: 'run-1' },
    });
    assert.equal(startRes.statusCode, 200);
    assert.equal(startRes.json().status, 'running');

    const verifyRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/verify`,
      headers: { authorization: `Bearer ${WK_TOKEN}` },
      payload: {
        runId: 'run-1',
        iteration: 1,
        baseCommit: BASE_COMMIT,
        acceptanceTestDigest: created.acceptance.digest,
        verifiedTreeHash: TREE_HASH,
        patchSha256: PATCH_SHA,
        checksPassed: true,
        acceptancePathsUnmodified: true,
        durationMs: 1200,
        exitCode: 0,
        summary: 'Passed',
        verifiedAt: '2026-11-25T12:00:00.000Z',
      },
    });
    assert.equal(verifyRes.statusCode, 200);
    assert.equal(verifyRes.json().status, 'verified');

    const publishRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/publish-draft-pr`,
      headers: { authorization: `Bearer ${OP_TOKEN}` },
      payload: {
        branchName: `hivemind/${created.id}-r1`,
        commitSha: COMMIT_SHA,
        prTreeHash: TREE_HASH,
        prNumber: 101,
        prUrl: 'https://github.com/roboco-io/project-hivemind/pull/101',
        verifiedTreeHash: TREE_HASH,
        acceptanceTestDigest: created.acceptance.digest,
        patchSha256: PATCH_SHA,
        publishedAt: '2026-11-25T12:01:00.000Z',
      },
    });
    assert.equal(publishRes.statusCode, 200);
    assert.equal(publishRes.json().status, 'draft_pr_published');

    const decideRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/human-decision`,
      headers: { authorization: `Bearer ${OP_TOKEN}` },
      payload: {
        decision: 'approve',
        openedDiff: false,
        durationMinutes: 1.5,
        reason: 'Verified acceptance + tree hash match without opening diff',
      },
    });
    assert.equal(decideRes.statusCode, 200);
    const decided = decideRes.json();
    assert.equal(decided.status, 'approved');
    assert.equal(decided.humanDecision.openedDiff, false);
    assert.equal(decided.humanDecision.durationMinutes, 1.5);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/delivery/tasks/${created.id}`,
      headers: { authorization: `Bearer ${OP_TOKEN}` },
    });
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.json().task.publication.prNumber, 101);
  } finally {
    await app.close();
  }
});

test('delivery HTTP API auto-dispatches worker on approve, serves worker-spec, and dispatches verifier on worker-completed', async () => {
  const s3Objects = new Map<string, Uint8Array>();
  const ecsLaunches: LaunchEcsWorkloadInput[] = [];
  const app = buildApp({
    operatorToken: OP_TOKEN,
    workerToken: WK_TOKEN,
    deliveryOrchestratorFactory: (store) =>
      new DeliveryOrchestrator({
        store,
        s3: {
          async putObject(key, body) {
            const copy = new Uint8Array(body);
            s3Objects.set(key, copy);
            return { sha256: createHash('sha256').update(copy).digest('hex') };
          },
          async getObject(key) {
            const found = s3Objects.get(key);
            if (!found) throw new Error(`Missing ${key}`);
            return found;
          },
        },
        ecs: {
          async launchWorkload(input) {
            ecsLaunches.push(input);
            return { taskArn: `arn:aws:ecs:ap-northeast-2:123456789012:task/c/${input.kind}-${ecsLaunches.length}` };
          },
          async stop() {},
        },
        github: {
          async publishDraftPr() {
            throw new Error('not called in this test');
          },
        },
      }),
  });
  try {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/delivery/tasks',
      headers: { authorization: `Bearer ${OP_TOKEN}` },
      payload: {
        ...createPayload(),
        bundle: {
          baseCommit: BASE_COMMIT,
          bundleSha256: 'f'.repeat(64),
          sizeBytes: 1024,
          fileCount: 10,
          s3Key: 'bundles/base.bundle',
        },
      },
    });
    assert.equal(createRes.statusCode, 201);
    const task = createRes.json();
    assert.ok(s3Objects.has(`acceptance/${task.id}.json`));

    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${task.id}/approve`,
      headers: { authorization: `Bearer ${OP_TOKEN}` },
      payload: { approvalFingerprint: task.approvalFingerprint, reason: 'Unattended AWS dispatch' },
    });
    assert.equal(approveRes.statusCode, 200);
    const running = approveRes.json();
    assert.equal(running.status, 'running');
    assert.equal(ecsLaunches.length, 1);
    assert.equal(ecsLaunches[0]!.kind, 'worker');

    // Operator cannot fetch worker-spec; worker with active runId can.
    const opSpec = await app.inject({
      method: 'GET',
      url: `/api/delivery/tasks/${task.id}/worker-spec?runId=${running.activeRunId}`,
      headers: { authorization: `Bearer ${OP_TOKEN}` },
    });
    assert.equal(opSpec.statusCode, 401);

    const wkSpec = await app.inject({
      method: 'GET',
      url: `/api/delivery/tasks/${task.id}/worker-spec?runId=${running.activeRunId}`,
      headers: { authorization: `Bearer ${WK_TOKEN}` },
    });
    assert.equal(wkSpec.statusCode, 200);
    assert.equal(wkSpec.json().provider, 'codex');
    assert.deepEqual(wkSpec.json().acceptancePaths, ['tests/acceptance.test.ts']);

    const doneRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${task.id}/worker-completed`,
      headers: { authorization: `Bearer ${WK_TOKEN}` },
      payload: {
        runId: running.activeRunId,
        patchS3Key: `patches/${task.id}/${running.activeRunId}.patch`,
        patchSha256: PATCH_SHA,
        summary: 'Completed edit',
      },
    });
    assert.equal(doneRes.statusCode, 200);
    assert.equal(ecsLaunches.length, 2);
    assert.equal(ecsLaunches[1]!.kind, 'verifier');
    assert.equal(ecsLaunches[1]!.patchS3Key, `patches/${task.id}/${running.activeRunId}.patch`);

    const afterDone = await app.inject({
      method: 'GET',
      url: `/api/delivery/tasks/${task.id}`,
      headers: { authorization: `Bearer ${OP_TOKEN}` },
    });
    assert.equal(afterDone.statusCode, 200);
    assert.equal(afterDone.json().task.latestWorkerSummary, 'Completed edit');
  } finally {
    await app.close();
  }
});
