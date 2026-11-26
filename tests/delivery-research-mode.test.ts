import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import {
  buildWorkerCliCommand,
  buildWorkerPrompt,
  runWorkerPreflight,
} from '../apps/worker/src/aws-worker-policy.js';
import { runAwsWorkerOnce } from '../apps/worker/src/aws-worker-runtime.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { buildDraftPrBody } from '../packages/adapters/src/draft-pr-publisher.js';
import { createPinnedGitBundle } from '../packages/adapters/src/git-bundle.js';
import { resolveGithubTokenForRepo } from '../packages/adapters/src/github-token-resolver.js';
import { computeAcceptanceTestDigest, DeliveryStore } from '../packages/core/src/delivery.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function makeMemoryS3(): { port: S3ObjectPort; store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  const port: S3ObjectPort = {
    async putObject(key, body) {
      const buf = Buffer.from(body);
      store.set(key, buf);
      return { key, sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.byteLength };
    },
    async getObject(key, expectedSha256) {
      const buf = store.get(key);
      if (!buf) throw new Error(`Missing S3 key: ${key}`);
      if (expectedSha256) {
        const actual = createHash('sha256').update(buf).digest('hex');
        if (actual !== expectedSha256) throw new Error('S3 SHA-256 mismatch');
      }
      return new Uint8Array(buf);
    },
  };
  return { port, store };
}

test('A1: resolveGithubTokenForRepo resolves per-repository tokens and rejects missing repos explicitly', () => {
  const secret = JSON.stringify({
    tokensByRepo: {
      'roboco-io/project-hivemind': 'github_pat_hivemind_1234567890',
      'roboco-io/silicon-model-factory': 'github_pat_smf_0987654321',
    },
  });

  assert.equal(resolveGithubTokenForRepo(secret, 'roboco-io/project-hivemind'), 'github_pat_hivemind_1234567890');
  assert.equal(resolveGithubTokenForRepo(secret, 'ROBOCO-IO/Silicon-Model-Factory'), 'github_pat_smf_0987654321');

  assert.throws(
    () => resolveGithubTokenForRepo(secret, 'roboco-io/unknown-repo'),
    /No GitHub token configured for repository roboco-io\/unknown-repo/,
  );
  assert.throws(
    () => resolveGithubTokenForRepo('', 'roboco-io/silicon-model-factory'),
    /secret is empty/,
  );
});

test('A2 & A3 & A4: DeliveryStore validates executionPolicy, pins it in approvalFingerprint, and tracks waitReason + preflight', async () => {
  const app = buildApp({ operatorToken: 'op-token', workerToken: 'wk-token' });
  try {
    const basePayload = {
      title: 'Stage 1 model factory research brief',
      instructions: 'Research open weights and write reports/stage1.md',
      provider: 'claude' as const,
      maxIterations: 2,
      budgetMicros: 5_000_000,
      acceptance: {
        baseCommit: 'a'.repeat(40),
        files: [{ path: 'ops/stage1/check.mjs', sha256: 'b'.repeat(64) }],
        testCommand: ['node', 'ops/stage1/check.mjs', '--final'],
      },
      delivery: {
        mode: 'draft_pr' as const,
        repository: 'roboco-io/silicon-model-factory',
        baseBranch: 'main',
        branchPrefix: 'hivemind/stage1/',
        autoMerge: false as const,
      },
      executionPolicy: {
        allowedWebHosts: ['huggingface.co', 'arxiv.org', 'github.com'],
        allowSubagents: true,
        maxIterationDurationMs: 5_400_000, // 90 minutes
        preserveWorkspaceOnRetry: true,
        verificationKind: 'document_format' as const,
      },
    };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/delivery/tasks',
      headers: { authorization: 'Bearer op-token' },
      payload: basePayload,
    });
    assert.equal(createRes.statusCode, 201);
    const created = createRes.json();
    assert.equal(created.waitReason, 'awaiting_operator_approval');
    assert.deepEqual(created.executionPolicy.allowedWebHosts, ['arxiv.org', 'github.com', 'huggingface.co']);
    assert.equal(created.executionPolicy.allowSubagents, true);
    assert.equal(created.executionPolicy.maxIterationDurationMs, 5_400_000);
    assert.equal(created.executionPolicy.preserveWorkspaceOnRetry, true);
    assert.equal(created.executionPolicy.verificationKind, 'document_format');

    // Invalid hostname rejected explicitly (never silently dropped).
    const badHostRes = await app.inject({
      method: 'POST',
      url: '/api/delivery/tasks',
      headers: { authorization: 'Bearer op-token' },
      payload: {
        ...basePayload,
        executionPolicy: { allowedWebHosts: ['https://evil.example/path'] },
      },
    });
    assert.equal(badHostRes.statusCode, 400);

    // Approve -> waitReason becomes queued_for_worker_dispatch.
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/approve`,
      headers: { authorization: 'Bearer op-token' },
      payload: { approvalFingerprint: created.approvalFingerprint, reason: 'Approve research task' },
    });
    assert.equal(approveRes.statusCode, 200);
    assert.equal(approveRes.json().waitReason, 'queued_for_worker_dispatch');

    // Start iteration -> worker-spec exposes executionPolicy.
    const startRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/start`,
      headers: { authorization: 'Bearer wk-token' },
      payload: { workerId: 'worker-research-1', runId: 'run-r1' },
    });
    assert.equal(startRes.statusCode, 200);
    assert.equal(startRes.json().waitReason, null);

    const specRes = await app.inject({
      method: 'GET',
      url: `/api/delivery/tasks/${created.id}/worker-spec?runId=run-r1`,
      headers: { authorization: 'Bearer wk-token' },
    });
    assert.equal(specRes.statusCode, 200);
    assert.equal(specRes.json().executionPolicy.allowSubagents, true);
    assert.deepEqual(specRes.json().executionPolicy.allowedWebHosts, ['arxiv.org', 'github.com', 'huggingface.co']);

    // Failed preflight immediately transitions task to failed with explicit reason (Lesson #3).
    const preflightRes = await app.inject({
      method: 'POST',
      url: `/api/delivery/tasks/${created.id}/preflight`,
      headers: { authorization: 'Bearer wk-token' },
      payload: {
        runId: 'run-r1',
        ok: false,
        cliVersion: null,
        authReady: true,
        gitReady: true,
        allowedWebHosts: ['arxiv.org', 'github.com', 'huggingface.co'],
        allowSubagents: true,
        reason: 'claude CLI unavailable (ENOENT)',
      },
    });
    assert.equal(preflightRes.statusCode, 200);
    const failedTask = preflightRes.json();
    assert.equal(failedTask.status, 'failed');
    assert.equal(failedTask.waitReason, 'preflight_failed');
    assert.match(failedTask.failureReason, /claude CLI unavailable/);
  } finally {
    await app.close();
  }
});

test('A2 & A3: buildWorkerCliCommand enforces allowedWebHosts and allowSubagents cleanly & preflight detects missing CLI', async () => {
  const claudeCmd = buildWorkerCliCommand({
    provider: 'claude',
    cliBin: 'claude',
    workspacePath: '/tmp/work',
    lastMessageFile: '/tmp/last.txt',
    model: 'claude-sonnet-4-6',
    executionPolicy: {
      allowedWebHosts: ['arxiv.org', 'huggingface.co'],
      allowSubagents: true,
      maxIterationDurationMs: 3_600_000,
      preserveWorkspaceOnRetry: true,
      verificationKind: 'document_format',
    },
  });
  const allowedToolsIdx = claudeCmd.cmd.indexOf('--allowedTools');
  assert.ok(allowedToolsIdx > 0);
  const tools = claudeCmd.cmd[allowedToolsIdx + 1]!;
  assert.ok(tools.includes('Agent'));
  assert.ok(tools.includes('WebFetch(domain:arxiv.org)'));
  assert.ok(tools.includes('WebFetch(domain:huggingface.co)'));

  const restrictedCmd = buildWorkerCliCommand({
    provider: 'claude',
    cliBin: 'claude',
    workspacePath: '/tmp/work',
    lastMessageFile: '/tmp/last.txt',
    executionPolicy: {
      allowedWebHosts: [],
      allowSubagents: false,
      maxIterationDurationMs: 600_000,
      preserveWorkspaceOnRetry: false,
      verificationKind: 'code',
    },
  });
  const restrictedTools = restrictedCmd.cmd[restrictedCmd.cmd.indexOf('--allowedTools') + 1]!;
  assert.equal(restrictedTools.includes('Agent'), false);
  assert.equal(restrictedTools.includes('WebFetch'), false);

  const failedPreflight = await runWorkerPreflight({
    runId: 'run-pf-1',
    provider: 'claude',
    cliBin: 'claude',
    workspacePath: '/tmp',
    authReady: true,
    execImpl: async (bin) =>
      bin === 'claude'
        ? { status: 'error', stdout: '', stderr: 'spawn claude ENOENT' }
        : { status: 'passed', stdout: 'git version 2.45.0', stderr: '' },
  });
  assert.equal(failedPreflight.ok, false);
  assert.match(failedPreflight.reason ?? '', /claude CLI unavailable/);

  const prompt = buildWorkerPrompt(
    {
      taskId: 'dlv-test',
      runId: 'run-1',
      iteration: 2,
      maxIterations: 3,
      provider: 'claude',
      title: 'Research',
      instructions: 'Write brief',
      baseCommit: 'a'.repeat(40),
      acceptancePaths: ['ops/stage1/check.mjs'],
      testCommand: ['node', 'ops/stage1/check.mjs'],
      priorVerificationSummary: null,
      executionPolicy: {
        allowedWebHosts: ['arxiv.org'],
        allowSubagents: true,
        maxIterationDurationMs: 3_600_000,
        preserveWorkspaceOnRetry: true,
        verificationKind: 'document_format',
      },
    },
    true,
  );
  assert.match(prompt, /arxiv\.org/);
  assert.match(prompt, /Subagents: ALLOWED/);
  assert.match(prompt, /Resumed Workspace State/);
});

test('A4: runAwsWorkerOnce restores partialPatch from prior checkpoint on Spot resume and preserves workspace on retry', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'hivemind-a4-resume-'));
  try {
    const repoDir = join(workRoot, 'origin-repo');
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: repoDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      }).trim();

    await rm(repoDir, { recursive: true, force: true });
    execFileSync('mkdir', ['-p', repoDir]);
    git(['init']);
    await writeFile(join(repoDir, 'README.md'), '# Research Repo\n', 'utf8');
    git(['add', 'README.md']);
    git(['commit', '-m', 'init']);
    const baseCommit = git(['rev-parse', 'HEAD']);

    const bundlePath = join(workRoot, 'repo.bundle');
    const bundleManifest = await createPinnedGitBundle(repoDir, baseCommit, bundlePath, AbortSignal.timeout(30_000));
    const { port: s3 } = makeMemoryS3();
    await s3.putObject('bundles/test.bundle', await readFile(bundlePath), 'application/octet-stream');

    // Run 1: interrupted by Spot SIGTERM after writing section 1.
    const spotController = new AbortController();
    const spotReports: string[] = [];
    const run1 = await runAwsWorkerOnce({
      taskId: 'dlv-spot-resume',
      runId: 'run-1',
      iteration: 1,
      baseCommit,
      bundleS3Key: 'bundles/test.bundle',
      bundleSha256: bundleManifest.bundleSha256,
      s3,
      spotSignal: spotController.signal,
      workRoot,
      control: {
        async reportSpotInterrupted(payload) {
          spotReports.push(payload.checkpointRef);
        },
      },
      executor: {
        async run(ctx) {
          assert.equal(ctx.restoredCheckpointPatch, false);
          await writeFile(join(ctx.workspacePath, 'section1.md'), '# Section 1 Complete\n', 'utf8');
          spotController.abort(new Error('SIGTERM'));
          throw new Error('aborted by spot');
        },
      },
    });
    assert.equal(run1.kind, 'spot_interrupted');
    assert.equal(spotReports.length, 1);

    // Run 2: resumes from checkpointS3Key -> section1.md is ALREADY restored in workspace before executor runs!
    const run2 = await runAwsWorkerOnce({
      taskId: 'dlv-spot-resume',
      runId: 'run-2',
      iteration: 1,
      baseCommit,
      bundleS3Key: 'bundles/test.bundle',
      bundleSha256: bundleManifest.bundleSha256,
      checkpointS3Key: run1.checkpointS3Key,
      preserveWorkspaceOnRetry: true,
      s3,
      workRoot,
      control: {
        async reportSpotInterrupted() {
          throw new Error('unexpected');
        },
      },
      executor: {
        async run(ctx) {
          assert.equal(ctx.restoredCheckpointPatch, true);
          const restored = await readFile(join(ctx.workspacePath, 'section1.md'), 'utf8');
          assert.equal(restored, '# Section 1 Complete\n');
          await writeFile(join(ctx.workspacePath, 'section2.md'), '# Section 2 Complete\n', 'utf8');
          return { summary: 'Resumed and completed section 2' };
        },
      },
    });

    assert.equal(run2.kind, 'completed');
    assert.ok(run2.checkpointS3Key?.startsWith('sessions/dlv-spot-resume/run-2.json'));
    const finalPatch = Buffer.from(await s3.getObject(run2.patchS3Key, run2.patchSha256)).toString('utf8');
    assert.match(finalPatch, /Section 1 Complete/);
    assert.match(finalPatch, /Section 2 Complete/);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});

test('A5: Draft PR body includes explicit factual-accuracy disclaimer for document_format verificationKind', async () => {
  const store = new DeliveryStore(':memory:');
  try {
    const acceptanceFiles = [{ path: 'ops/stage1/check.mjs', sha256: sha256('check') }];
    const acceptanceCommand = ['node', 'ops/stage1/check.mjs', '--final'];
    const task = await store.create({
      title: 'Model Factory Stage 1 Report',
      instructions: 'Produce verified markdown report',
      provider: 'claude',
      maxIterations: 2,
      budgetMicros: 1_000_000,
      acceptance: {
        baseCommit: 'c'.repeat(40),
        files: acceptanceFiles,
        testCommand: acceptanceCommand,
        digest: computeAcceptanceTestDigest({
          baseCommit: 'c'.repeat(40),
          files: acceptanceFiles,
          testCommand: acceptanceCommand,
        }),
      },
      delivery: {
        mode: 'draft_pr',
        repository: 'roboco-io/silicon-model-factory',
        baseBranch: 'main',
        branchPrefix: 'hivemind/stage1/',
        autoMerge: false,
      },
      executionPolicy: {
        verificationKind: 'document_format',
      },
    });

    const body = buildDraftPrBody(
      task,
      {
        runId: 'run-doc-1',
        iteration: 1,
        baseCommit: 'c'.repeat(40),
        acceptanceTestDigest: task.acceptance.digest,
        verifiedTreeHash: 'd'.repeat(40),
        patchSha256: 'e'.repeat(64),
        checksPassed: true,
        acceptancePathsUnmodified: true,
        exitCode: 0,
        durationMs: 1200,
        summary: 'Schema checks passed',
        verifiedAt: '2026-11-26T00:00:00.000Z',
      },
      'd'.repeat(40),
    );

    assert.match(body, /문서 산출물 검증 범위 고지/);
    assert.match(body, /사실 여부 미판정/);
  } finally {
    await store.close();
  }
});
