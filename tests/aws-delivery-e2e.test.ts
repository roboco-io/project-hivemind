import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeliveryOrchestrator } from '../apps/control-plane/src/delivery-orchestrator.js';
import { runAwsVerifierOnce } from '../apps/worker/src/aws-verifier-runtime.js';
import { runAwsWorkerOnce } from '../apps/worker/src/aws-worker-runtime.js';
import type { LaunchEcsWorkloadInput } from '../packages/adapters/src/aws-ecs-driver.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { captureAcceptanceTestSpec, createPinnedGitBundle } from '../packages/adapters/src/git-bundle.js';
import { createGitHubDraftPrPort } from '../packages/adapters/src/github-draft-pr.js';
import { createGitPushCommitMaterializer } from '../packages/adapters/src/github-git-push.js';
import { DeliveryStore } from '../packages/core/src/delivery.js';

function gitExec(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_AUTHOR_NAME: 'HIVEMIND E2E',
      GIT_AUTHOR_EMAIL: 'e2e@hivemind.local',
      GIT_COMMITTER_NAME: 'HIVEMIND E2E',
      GIT_COMMITTER_EMAIL: 'e2e@hivemind.local',
    },
  }).trim();
}

function makeMemoryS3(): { s3: S3ObjectPort; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const s3: S3ObjectPort = {
    async putObject(key, body) {
      const copy = new Uint8Array(body);
      objects.set(key, copy);
      return { sha256: createHash('sha256').update(copy).digest('hex') };
    },
    async getObject(key, expectedSha256) {
      const found = objects.get(key);
      if (!found) throw new Error(`Missing S3 key ${key}`);
      if (expectedSha256) {
        const actual = createHash('sha256').update(found).digest('hex');
        if (actual !== expectedSha256.toLowerCase()) throw new Error(`S3 SHA-256 mismatch for ${key}`);
      }
      return new Uint8Array(found);
    },
  };
  return { s3, objects };
}

test('full AWS single-path E2E: S3 git bundle -> Spot SIGTERM flush & resume -> Ralph fail/fix -> independent verifier -> git push Draft PR -> no-diff human approval', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hivemind-aws-e2e-'));
  const signal = new AbortController().signal;
  const store = new DeliveryStore(':memory:');
  try {
    // 1. Create source repo + local bare remote acting as GitHub repository.
    const repoPath = join(root, 'source');
    const bareRemote = join(root, 'remote.git');
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    mkdirSync(join(repoPath, 'tests'), { recursive: true });
    mkdirSync(bareRemote, { recursive: true });
    gitExec(bareRemote, ['init', '--bare', '-b', 'main']);

    gitExec(repoPath, ['init', '-b', 'main']);
    writeFileSync(join(repoPath, 'src/calc.mjs'), 'export const multiply = (a, b) => a + b;\n', 'utf8');
    writeFileSync(
      join(repoPath, 'tests/acceptance.test.mjs'),
      [
        "import assert from 'node:assert/strict';",
        "import { multiply } from '../src/calc.mjs';",
        'assert.equal(multiply(6, 7), 42);',
      ].join('\n') + '\n',
      'utf8',
    );
    gitExec(repoPath, ['add', '--all']);
    gitExec(repoPath, ['commit', '-m', 'base pinned commit']);
    gitExec(repoPath, ['remote', 'add', 'origin', bareRemote]);
    gitExec(repoPath, ['push', '-q', 'origin', 'main']);
    const baseCommit = gitExec(repoPath, ['rev-parse', 'HEAD']);

    // 2. Upload pinned git bundle and immutable acceptance spec to S3.
    const { s3 } = makeMemoryS3();
    const localBundle = join(root, 'pinned.bundle');
    const manifest = await createPinnedGitBundle(repoPath, baseCommit, localBundle, signal);
    const bundleS3Key = `bundles/${baseCommit}.bundle`;
    await s3.putObject(bundleS3Key, readFileSync(localBundle), 'application/octet-stream');

    const acceptance = await captureAcceptanceTestSpec(
      repoPath,
      baseCommit,
      ['tests/acceptance.test.mjs'],
      [process.execPath, 'tests/acceptance.test.mjs'],
      signal,
    );

    const task = store.create({
      title: 'Fix multiply() via AWS Fargate Spot',
      instructions: 'Fix multiply(a, b) in src/calc.mjs without touching tests/acceptance.test.mjs.',
      provider: 'codex',
      maxIterations: 3,
      budgetMicros: 500_000,
      acceptance,
      delivery: {
        mode: 'draft_pr',
        repository: 'roboco-io/project-hivemind',
        baseBranch: 'main',
        branchPrefix: 'hivemind/',
        autoMerge: false,
      },
      bundle: { ...manifest, s3Key: bundleS3Key },
      spot: { maxSpotRetries: 2, checkpointFlushTimeoutMs: 30_000 },
    });
    const acceptanceS3Key = `acceptance/${task.id}.json`;
    await s3.putObject(acceptanceS3Key, Buffer.from(JSON.stringify(acceptance), 'utf8'), 'application/json');
    store.approve(task.id, task.approvalFingerprint, 'Approved for E2E AWS single-path test');

    // 3. Wire DeliveryOrchestrator with fake ECS dispatcher + REAL Git push materializer + fake GitHub Draft PR API.
    const ecsLaunches: LaunchEcsWorkloadInput[] = [];
    const materializer = createGitPushCommitMaterializer({
      bundlePath: localBundle,
      expectedBundleSha256: manifest.bundleSha256,
      workRoot: root,
      remoteUrl: bareRemote,
      push: true,
    });
    let createdPrPayload: Record<string, unknown> | null = null;
    const github = createGitHubDraftPrPort(
      {
        token: 'ghp_e2e_test_token',
        fetchImpl: async (_url, init) => {
          createdPrPayload = JSON.parse(String(init?.body ?? '{}'));
          return new Response(
            JSON.stringify({
              number: 88,
              html_url: 'https://github.com/roboco-io/project-hivemind/pull/88',
              draft: true,
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        },
      },
      materializer,
    );

    const orchestrator = new DeliveryOrchestrator({
      store,
      s3,
      ecs: {
        async launchWorkload(input) {
          ecsLaunches.push(input);
          return { taskArn: `arn:aws:ecs:ap-northeast-2:123456789012:task/hivemind/${input.kind}-${ecsLaunches.length}` };
        },
        async stop() {},
      },
      github,
      workRoot: root,
    });

    // 4. Attempt 0: Fargate Spot SIGTERM interrupts worker -> checkpoint flushed to S3 & auto-redispatched!
    const d0 = await orchestrator.dispatchWorker(task.id, signal);
    const spotController = new AbortController();
    let spotNotice: { taskId: string; runId: string; checkpointRef: string; reason: string } | null = null;
    const spotOutcome = await runAwsWorkerOnce({
      taskId: task.id,
      runId: d0.runId,
      iteration: 1,
      baseCommit,
      bundleS3Key,
      bundleSha256: manifest.bundleSha256,
      s3,
      spotSignal: spotController.signal,
      spotFlushTimeoutMs: 10_000,
      workRoot: root,
      control: {
        async reportSpotInterrupted(info) {
          spotNotice = info;
        },
      },
      executor: {
        async run(ctx) {
          writeFileSync(join(ctx.workspacePath, 'src/calc.mjs'), 'export const multiply = (a, b) => a * b; // wip\n');
          spotController.abort();
          throw new Error('Aborted by Spot SIGTERM');
        },
      },
    });
    assert.equal(spotOutcome.kind, 'spot_interrupted');
    assert.ok(spotNotice);
    const notice = spotNotice as { taskId: string; runId: string; checkpointRef: string; reason: string };
    const afterSpot = await orchestrator.handleSpotInterruption(
      task.id,
      d0.runId,
      notice.checkpointRef,
      notice.reason,
      signal,
    );
    assert.ok(afterSpot.redispatched);
    assert.equal(afterSpot.task.status, 'running');
    assert.equal(afterSpot.task.spotRetriesUsed, 1);
    assert.equal(ecsLaunches[1]!.checkpointS3Key, notice.checkpointRef);

    // 5. Iteration 1: Worker resumes from checkpoint, produces buggy fix -> Verifier fails -> Ralph loop auto-retries!
    const r1 = afterSpot.redispatched!;
    const w1 = await runAwsWorkerOnce({
      taskId: task.id,
      runId: r1.runId,
      iteration: 1,
      baseCommit,
      bundleS3Key,
      bundleSha256: manifest.bundleSha256,
      checkpointS3Key: notice.checkpointRef,
      s3,
      workRoot: root,
      control: { async reportSpotInterrupted() {} },
      executor: {
        async run(ctx) {
          assert.ok(ctx.priorCheckpoint && ctx.priorCheckpoint.byteLength > 0);
          writeFileSync(join(ctx.workspacePath, 'src/calc.mjs'), 'export const multiply = (a, b) => a - b;\n');
          return { summary: 'Attempt 1 fix' };
        },
      },
    });
    assert.equal(w1.kind, 'completed');
    await orchestrator.dispatchVerifier(task.id, r1.runId, w1.patchS3Key, signal);
    const att1 = await runAwsVerifierOnce(
      {
        taskId: task.id,
        runId: r1.runId,
        iteration: 1,
        bundleS3Key,
        bundleSha256: manifest.bundleSha256,
        acceptanceS3Key,
        expectedAcceptanceDigest: acceptance.digest,
        patchS3Key: w1.patchS3Key,
        expectedPatchSha256: w1.patchSha256,
        s3,
        workRoot: root,
        control: { async submitVerification() {} },
      },
      signal,
    );
    const v1 = await orchestrator.handleVerification(task.id, att1, w1.patchS3Key, signal);
    assert.ok(v1.retried);
    assert.equal(v1.task.status, 'running');
    assert.equal(v1.task.currentIteration, 2);

    // 6. Iteration 2: Worker fixes multiply -> Independent Verifier passes -> REAL git push to isolated branch + Draft PR!
    const r2 = v1.retried!;
    const w2 = await runAwsWorkerOnce({
      taskId: task.id,
      runId: r2.runId,
      iteration: 2,
      baseCommit,
      bundleS3Key,
      bundleSha256: manifest.bundleSha256,
      s3,
      workRoot: root,
      control: { async reportSpotInterrupted() {} },
      executor: {
        async run(ctx) {
          writeFileSync(join(ctx.workspacePath, 'src/calc.mjs'), 'export const multiply = (a, b) => a * b;\n');
          return { summary: 'Attempt 2 fix' };
        },
      },
    });
    assert.equal(w2.kind, 'completed');
    store.recordWorkerSummary(
      task.id,
      r2.runId,
      '1. src/calc.mjs: fixed multiply() to use a * b instead of a - b.\n2. Verified tests/acceptance.test.mjs passes.',
    );
    await orchestrator.dispatchVerifier(task.id, r2.runId, w2.patchS3Key, signal);
    const att2 = await runAwsVerifierOnce(
      {
        taskId: task.id,
        runId: r2.runId,
        iteration: 2,
        bundleS3Key,
        bundleSha256: manifest.bundleSha256,
        acceptanceS3Key,
        expectedAcceptanceDigest: acceptance.digest,
        patchS3Key: w2.patchS3Key,
        expectedPatchSha256: w2.patchSha256,
        s3,
        workRoot: root,
        control: { async submitVerification() {} },
      },
      signal,
    );
    const v2 = await orchestrator.handleVerification(task.id, att2, w2.patchS3Key, signal);
    assert.equal(v2.task.status, 'draft_pr_published');
    assert.ok(v2.publication);
    assert.equal(v2.publication!.prNumber, 88);
    assert.equal(v2.publication!.prTreeHash, att2.verifiedTreeHash);
    assert.equal(v2.publication!.changeSummary?.totalFiles, 1);
    assert.equal(v2.publication!.changeSummary?.files[0]?.path, 'src/calc.mjs');
    assert.equal(v2.publication!.changeSummary?.totalInsertions, 1);
    assert.equal(v2.publication!.changeSummary?.totalDeletions, 1);
    assert.match(v2.publication!.changeSummary?.workerSummary ?? '', /fixed multiply\(\)/);
    assert.equal((createdPrPayload as Record<string, unknown> | null)?.draft, true);
    assert.match(String((createdPrPayload as Record<string, unknown> | null)?.body ?? ''), /변경사항 상세 요약/);
    assert.match(String((createdPrPayload as Record<string, unknown> | null)?.body ?? ''), /src\/calc\.mjs/);

    // Confirm the isolated branch was pushed to bareRemote with exact verifiedTreeHash AND main was untouched!
    const remoteMain = gitExec(bareRemote, ['rev-parse', 'refs/heads/main']);
    assert.equal(remoteMain, baseCommit);
    const pushedBranch = v2.publication!.branchName;
    const remoteBranchTree = gitExec(bareRemote, ['rev-parse', `refs/heads/${pushedBranch}^{tree}`]);
    assert.equal(remoteBranchTree, att2.verifiedTreeHash);

    // 7. Milestone 1B: Human decides without opening diff and records durationMinutes.
    const approved = store.recordHumanDecision(task.id, {
      decision: 'approve',
      openedDiff: false,
      durationMinutes: 1.8,
      reason: 'Approved from immutable acceptance checks and verifiedTreeHash === prTreeHash proof',
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.humanDecision?.openedDiff, false);
    assert.equal(approved.humanDecision?.durationMinutes, 1.8);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
